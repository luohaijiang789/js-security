"""Import immutable local JS/HTML snapshots, without following network references."""
import base64
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlsplit

JS_EXTENSIONS = {".js", ".mjs"}
HTML_EXTENSIONS = {".html", ".htm"}


class DocumentBase(HTMLParser):
    def __init__(self):
        super().__init__()
        self.href = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'base' and self.href is None:
            href = dict(attrs).get('href')
            if href is not None:
                self.href = href


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(data).hexdigest()


def http_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        parsed.port  # Validate malformed port syntax without making a connection.
        if parsed.scheme in {"http", "https"} and parsed.hostname and not any(c.isspace() for c in value) and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return None


class Snapshot:
    def __init__(self, output, max_files=1000, max_asset_bytes=20*1024*1024, max_total_bytes=128*1024*1024):
        self.output = Path(output)
        self.assets = []
        self.contexts = []
        self.gaps = []
        self.max_files = max_files
        self.max_asset_bytes = max_asset_bytes
        self.max_total_bytes = max_total_bytes
        self.total_bytes = 0
        self._by_id = {}

    def gap(self, kind, message, *, asset_id=None, request_id=None, incomplete=False, source=None):
        record = dict(kind=kind, message=message, asset_id=asset_id, request_id=request_id,
                      incomplete=incomplete, source=source)
        record['id'] = 'gap-' + digest(record)[:20]
        if record not in self.gaps:
            self.gaps.append(record)

    def add(self, data, *, location, kind, page_url=None, url=None, context_key=None, observation=None, context_id=None):
        context_id = context_id or 'ctx-' + digest([context_key, page_url])[:20]
        content_hash = digest(data)
        asset_id = 'asset-' + digest([location, url, context_id, content_hash])[:20]
        if asset_id in self._by_id:
            self._by_id[asset_id]['observations'].append(observation)
            return self._by_id[asset_id]
        if len(self.assets) >= self.max_files or len(data) > self.max_asset_bytes or self.total_bytes+len(data) > self.max_total_bytes:
            self.gap('input_budget', 'Asset exceeds configured file/byte budget.', incomplete=True, source=location)
            return
        try:
            data.decode('utf-8-sig')
        except UnicodeDecodeError:
            self.gap('text_encoding', 'Only lossless UTF-8/UTF-8 BOM input is currently supported.', incomplete=True, source=location)
            return
        # A JavaScript-looking URL can return an authentication HTML page.
        head = data.lstrip(b'\xef\xbb\xbf \r\n\t').lower()
        if kind == 'js' and head.startswith((b'<!doctype html', b'<html', b'<head', b'<body')):
            self.gap('html_instead_of_js', 'Expected JavaScript but received HTML.', incomplete=True, source=location)
            return
        suffix = '.js' if kind == 'js' else '.html'
        relative = 'snapshot/' + content_hash + suffix
        target = self.output/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(data)
        asset = dict(id=asset_id, location=location, url=url, sha256=content_hash, kind=kind,
                     context_id=context_id, page_url=page_url, body_file=relative,
                     bytes=len(data), analysis_status='pending', observations=[observation])
        self.assets.append(asset)
        self._by_id[asset_id] = asset
        self.total_bytes += len(data)
        return asset

    def import_directory(self, source, page_url=None):
        source = Path(source)
        origins = {}
        manifest = source/'_origin.jsonl'
        if manifest.is_file() and not manifest.is_symlink():
            if manifest.stat().st_size > self.max_asset_bytes:
                self.gap('origin_manifest_invalid', 'Origin manifest exceeds the byte budget.', incomplete=True)
            else:
                for number, line in enumerate(manifest.read_text(encoding='utf-8-sig').splitlines()):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                        name = row['f']
                        if not isinstance(name, str) or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
                            raise ValueError('Unsafe manifest filename')
                        if name in origins and origins[name] != row:
                            origins[name] = {}
                            self.gap('origin_manifest_invalid', 'Conflicting metadata for one saved file.', incomplete=True, source=name)
                        else:
                            origins[name] = row
                    except (ValueError, KeyError, TypeError):
                        self.gap('origin_manifest_invalid', 'Invalid origin row.', incomplete=True, source=f'line:{number+1}')
        for path in sorted(source.rglob('*')):
            relative = path.relative_to(source).as_posix()
            if path.is_symlink():
                self.gap('symlink_skipped', 'Symbolic links are not imported.', incomplete=True, source=relative)
                continue
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix not in JS_EXTENSIONS | HTML_EXTENSIONS:
                if suffix == '.cjs':
                    self.gap('unsupported_asset', 'Pinned engine does not enumerate .cjs; file was not silently renamed.', incomplete=True, source=relative)
                continue
            if path.stat().st_size > self.max_asset_bytes:
                self.gap('input_budget', 'File exceeds per-asset byte budget.', incomplete=True, source=relative)
                continue
            origin = origins.get(relative, {})
            url = http_url(origin.get('u'))
            page = page_url or http_url(origin.get('d')) or (url if suffix in HTML_EXTENSIONS else None)
            self.add(path.read_bytes(), location=relative, url=url,
                     kind='js' if suffix in JS_EXTENSIONS else 'html', page_url=page,
                     context_key=page or 'directory', observation=relative)

    def import_har(self, source):
        source = Path(source)
        if source.stat().st_size > self.max_total_bytes:
            raise ValueError('HAR exceeds input byte budget.')
        document = json.loads(source.read_text(encoding='utf-8-sig'))
        if not isinstance(document, dict) or not isinstance(document.get('log'), dict):
            raise ValueError('HAR must contain a log object.')
        entries = document['log'].get('entries')
        if not isinstance(entries, list):
            raise ValueError('HAR log.entries must be an array.')
        pages = {}
        for page in document['log'].get('pages', []):
            if isinstance(page, dict) and http_url(page.get('title')):
                pages[page.get('id')] = page['title']
        document_urls = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            response = entry.get('response') or {}
            if not isinstance(response, dict):
                raise ValueError('HAR response must be an object.')
            content = response.get('content') or {}
            request = entry.get('request') or {}
            if not isinstance(content, dict) or not isinstance(request, dict):
                raise ValueError('HAR content/request must be objects.')
            resource_type = str(entry.get('_resourceType', '')).lower()
            script_url = Path(urlsplit(request.get('url', '')).path).suffix.lower() in JS_EXTENSIONS
            if 'html' in str(content.get('mimeType', '')).lower() and entry.get('pageref') and resource_type in {'', 'document'} and not script_url:
                if http_url(request.get('url')):
                    document_urls.setdefault(entry['pageref'], set()).add(request['url'])
        for page_ref, urls in document_urls.items():
            if len(urls) == 1:
                pages[page_ref] = next(iter(urls))
            else:
                pages[page_ref] = None
                self.gap('ambiguous_page', 'Multiple document URLs share a HAR pageref; execution page is not inferred.', incomplete=True, source=page_ref)
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                self.gap('invalid_har_entry', 'HAR entry is not an object.', incomplete=True, source=f'entry:{index}')
                continue
            request = entry.get('request') or {}
            response = entry.get('response') or {}
            content = response.get('content') or {}
            if not all(isinstance(item, dict) for item in (request, response, content)):
                raise ValueError(f'Invalid HAR object at entry {index}.')
            url = http_url(request.get('url'))
            mime = str(content.get('mimeType', '')).lower().split(';')[0]
            suffix = Path(urlsplit(url or '').path).suffix.lower()
            script = any(x in mime for x in ('javascript', 'ecmascript')) or entry.get('_resourceType') == 'script'
            # A .js URL with an HTML response is an import error, not a page.
            script = script or suffix in JS_EXTENSIONS
            html = mime in {'text/html', 'application/xhtml+xml'}
            if not script and not html:
                continue  # Actual API responses and traffic observations are not static JS.
            location = url or f'entry:{index}'
            if not url:
                self.gap('invalid_source_url', 'Asset URL is absent or unsupported.', incomplete=True, source=location)
                continue
            if not isinstance(response.get('status'), (int, float)) or not 200 <= response['status'] < 300:
                self.gap('http_status', f"Asset response status {response.get('status')!r}; no usable body assumed.", incomplete=True, source=location)
                continue
            text = content.get('text')
            if not isinstance(text, str):
                self.gap('missing_body', 'HAR did not include a textual response body.', incomplete=True, source=location)
                continue
            encoding = content.get('encoding')
            try:
                if encoding == 'base64':
                    data = base64.b64decode(text, validate=True)
                elif encoding in (None, ''):
                    data = text.encode('utf-8')
                else:
                    raise ValueError(f'Unsupported HAR encoding: {encoding!r}')
            except (ValueError, UnicodeError) as error:
                self.gap('body_encoding', str(error), incomplete=True, source=location)
                continue
            page = pages.get(entry.get('pageref'))
            if html and not script:
                page = url
            self.add(data, location=location, url=url, kind='js' if script else 'html',
                     page_url=page, context_key=entry.get('pageref') or page or 'unknown', observation=index)

    def groups(self):
        """Do not let mutually exclusive response versions contaminate one analysis."""
        contexts = {}
        for asset in self.assets:
            contexts.setdefault(asset['context_id'], []).append(asset)
        groups = []
        for context_id, assets in contexts.items():
            versions = {}
            for asset in assets:
                versions.setdefault(asset['url'] or asset['location'], set()).add(asset['sha256'])
            if any(len(hashes) > 1 for hashes in versions.values()):
                self.gap('version_association_unknown', 'Conflicting response versions: assets are analyzed separately; cross-file binding is incomplete.', incomplete=True, source=context_id)
                groups.extend([[asset] for asset in assets])
            else:
                groups.append(assets)
        return groups

    def resolve_contexts(self):
        """Keep document identity separate from the request base (HTML base href)."""
        self.contexts = []
        groups = {}
        for asset in self.assets:
            groups.setdefault(asset['context_id'], []).append(asset)
        for context_id, assets in groups.items():
            page = assets[0]['page_url']
            bases = set()
            for asset in assets:
                if asset['kind'] != 'html':
                    continue
                parser = DocumentBase()
                parser.feed((self.output/asset['body_file']).read_bytes().decode('utf-8-sig'))
                if parser.href is not None:
                    bases.add(http_url(urljoin(page, parser.href)) if page else http_url(parser.href))
            base = page
            evidence = 'input_page_mapping' if page else 'unknown'
            if len(bases) == 1:
                base = next(iter(bases))
                evidence = 'html_base' if base else 'unsupported_html_base'
            elif len(bases) > 1:
                base, evidence = None, 'ambiguous_html_base'
            if bases and base is None:
                self.gap('request_base_unknown', 'HTML request base is ambiguous or unsupported; relative Host is not inferred.', source=context_id)
            self.contexts.append(dict(id=context_id, type='page' if page else 'unknown', page_url=page,
                                      request_base_url=base, evidence=evidence, status='known' if base else 'unknown'))
            for asset in assets:
                asset['request_base_url'] = base
