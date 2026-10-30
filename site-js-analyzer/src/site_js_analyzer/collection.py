"""Evidence graph, shortest reference depths, and opt-in static JS supplementation."""
import json
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, CancelledError
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import posixpath
import subprocess
import time
from urllib.parse import urljoin, urlsplit

from .acquisition import FetchError, canonical_url
from .assets import digest, http_url
from .engine import verify_engine


class PageReferences(HTMLParser):
    def __init__(self, source=''):
        super().__init__(convert_charrefs=True)
        self.refs, self.inline, self.maps = [], [], []
        self.script = None
        self.source_lines = source.splitlines(keepends=True)

    def position(self):
        line, column = self.getpos()
        if line <= len(self.source_lines):
            column = len(self.source_lines[line-1][:column].encode('utf-16-le'))//2
        return line, column

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        line, column = self.position()
        if tag == 'script':
            kind = attrs.get('type', '').strip().lower()
            executable = kind in {'', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript'}
            if attrs.get('src') and executable:
                self.refs.append(dict(kind='script_src', target=attrs['src'], confidence='certain',
                                      line=line, column=column, start=None, end=None))
            self.script = dict(kind=kind, external=bool(attrs.get('src')), text='', line=None, column=None)
        elif tag == 'link' and ('modulepreload' in attrs.get('rel', '').lower().split() or
                               'preload' in attrs.get('rel', '').lower().split() and attrs.get('as') == 'script') and attrs.get('href'):
            self.refs.append(dict(kind='modulepreload', target=attrs['href'], confidence='certain',
                                  line=line, column=column, start=None, end=None))

    def handle_data(self, data):
        if self.script is not None:
            if self.script['line'] is None:
                self.script['line'], self.script['column'] = self.position()
            self.script['text'] += data

    def handle_endtag(self, tag):
        if tag != 'script' or self.script is None:
            return
        script, self.script = self.script, None
        if not script['external']:
            if script['kind'] == 'importmap':
                self.maps.append(json.loads(script['text']))
            elif script['kind'] in {'', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript'} and script['text'].strip():
                self.inline.append(script)


def mapped_specifier(specifier, module_url, document_base, maps):
    """Longest applicable scope, then top-level map; null mappings block requests."""
    url_like = specifier.startswith(('/', './', '../')) or bool(urlsplit(specifier).scheme)
    if not module_url and (maps.get('scopes') or url_like and not http_url(specifier)):
        return None, 'base_unknown'
    key = urljoin(module_url or document_base or '', specifier) if url_like else specifier

    def match(table):
        normalized = {}
        for name, target in table.items():
            if not isinstance(name, str):
                continue
            normalized[urljoin(document_base or '', name) if name.startswith(('/', './', '../')) else name] = target
        if key in normalized:
            return True, normalized[key], ''
        prefixes = sorted((name for name in normalized if name.endswith('/') and key.startswith(name)), key=len, reverse=True)
        if prefixes:
            name = prefixes[0]
            target = normalized[name]
            return True, target if isinstance(target, str) and target.endswith('/') else None, key[len(name):]
        return False, None, ''

    scopes = maps.get('scopes', {})
    applicable = sorted((urljoin(document_base or '', scope) for scope in scopes if isinstance(scope, str)), key=len, reverse=True)
    tables = []
    for scope in applicable:
        if module_url and module_url.startswith(scope):
            for raw, table in scopes.items():
                if urljoin(document_base or '', raw) == scope and isinstance(table, dict):
                    tables.append(table)
    tables.append(maps.get('imports', {}))
    for table in tables:
        if not isinstance(table, dict):
            continue
        found, target, rest = match(table)
        if found:
            if not isinstance(target, str) or not (target.startswith(('/', './', '../')) or http_url(target)):
                return None, 'import_map_blocked'
            prefix = urljoin(document_base or '', target)
            result = urljoin(prefix, rest) if rest else prefix
            if rest and not result.startswith(prefix):
                return None, 'import_map_escape'
            return result, None if http_url(result) else 'base_unknown'
    if url_like:
        target = urljoin(module_url or '', specifier)
        return target if http_url(target) else None, None if http_url(target) else 'base_unknown'
    return None, 'bare_specifier_unmapped'


class ReferenceGraph:
    def __init__(self, snapshot, engine_root, *, max_depth=3, timeout=60, seeds=(), concurrency=4):
        self.snapshot = snapshot
        self.engine_root = verify_engine(engine_root)
        self.max_depth = max_depth
        self.end = time.monotonic()+timeout
        self.seeds = set(seeds)
        if not 1 <= concurrency <= 32:
            raise ValueError('Collection concurrency must be between 1 and 32.')
        self.concurrency = concurrency
        self.edges, self.cache, self.scanned, self.maps = [], {}, set(), {}
        self.failures = {}
        self.import_gaps = list(snapshot.gaps)
        self.discovery_dir = snapshot.output/'discovery'
        self.discovery_dir.mkdir(parents=True)
        for seed in self.seeds:
            if not any(a['kind'] == 'js' and seed in {a.get('url'), a['location']} for a in snapshot.assets):
                raise ValueError('--seed-js must identify an imported JS asset.')

    def parse_js(self, source):
        sha = digest(source.encode())
        if sha in self.cache:
            return self.cache[sha]
        remaining = self.end-time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Reference discovery deadline reached.')
        try:
            result = subprocess.run(['node', str(Path(__file__).with_name('references.js')), str(self.engine_root)],
                                    input=source, capture_output=True, text=True, timeout=remaining)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError('Reference parser exceeded its total deadline.') from error
        if result.returncode:
            raise RuntimeError('Reference parser failed; no empty-success result was assumed.')
        data = json.loads(result.stdout)
        self.cache[sha] = data
        (self.discovery_dir/(sha+'.json')).write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return data

    def add_edge(self, parent, ref, inline=None):
        value = dict(parent_asset_id=parent['id'], context_id=parent['context_id'],
                     parent_sha256=parent['sha256'], **ref)
        if inline is not None:
            value['inline_index'] = inline[0]
            value['line'] = (inline[1] or 1)+(ref.get('line') or 1)-1
            if ref.get('line') == 1:
                value['column'] = (inline[2] or 0)+(ref.get('column') or 0)
            value['inline_offset'] = dict(start=ref.get('start'), end=ref.get('end'))
            value['start'] = value['end'] = None
        value.update(id='edge-'+digest(value)[:20], child_asset_ids=[], status='pending',
                     target_url=None, target_location=None, child_depth=None, resolution_base=None, resolution_basis=None)
        if not any(edge['id'] == value['id'] for edge in self.edges):
            self.edges.append(value)

    def discover(self):
        # Import maps must be available before resolving sibling module specifiers.
        todo = [a for a in self.snapshot.assets if a['id'] not in self.scanned]
        for asset in sorted(todo, key=lambda a: a['kind'] != 'html'):
            self.scanned.add(asset['id'])
            text = (self.snapshot.output/asset['body_file']).read_bytes().decode('utf-8')
            snippets = []
            if asset['kind'] == 'html':
                page = PageReferences(text)
                try:
                    page.feed(text)
                    page.close()
                    for value in page.maps:
                        if not isinstance(value, dict):
                            raise ValueError('Import map must be an object.')
                        mapping = self.maps.setdefault(asset['context_id'], {'imports': {}, 'scopes': {}})
                        for key in ('imports', 'scopes'):
                            entries = value.get(key, {})
                            if not isinstance(entries, dict):
                                raise ValueError('Invalid import map entries.')
                            for name, target in entries.items():
                                if name in mapping[key] and mapping[key][name] != target:
                                    self.snapshot.gap('import_map_conflict', 'Conflicting import maps were not guessed.', asset_id=asset['id'], incomplete=True)
                                    mapping[key][name] = None
                                    mapping['invalid'] = True
                                else:
                                    mapping[key][name] = target
                    for ref in page.refs:
                        self.add_edge(asset, ref)
                    snippets = [(item['text'], (index, item['line'], item['column'])) for index, item in enumerate(page.inline)]
                except (ValueError, TypeError) as error:
                    self.snapshot.gap('html_reference_parse', str(error), asset_id=asset['id'], incomplete=True)
            else:
                snippets = [(text, None)]
            for source, inline in snippets:
                data = self.parse_js(source)
                if not data.get('parsed') or data.get('errors'):
                    self.snapshot.gap('reference_parse_partial', data.get('error') or str(data.get('errors')), asset_id=asset['id'], incomplete=True)
                stats = data.get('chunk_stats', {})
                if data.get('chunk_error') or stats.get('buildersFailed') or stats.get('idsResolved', 0) < stats.get('idsSeen', 0):
                    self.snapshot.gap('chunk_discovery_partial', 'Some chunk builders/IDs could not be resolved; see discovery evidence.', asset_id=asset['id'], incomplete=True)
                for ref in data.get('refs', []):
                    self.add_edge(asset, ref, inline)

    def targets(self, edge, parent):
        specifier = edge['target']
        if not isinstance(specifier, str):
            return None, None, 'dynamic_target'
        try:
            parsed_specifier = urlsplit(specifier)
        except ValueError:
            return None, None, 'invalid_reference_url'
        base = parent.get('request_base_url')
        module = parent.get('url') or parent.get('reference_url')
        inline = 'inline_index' in edge
        module_kind = edge['kind'] in {'module_import', 'module_export', 'dynamic_import', 'vite_dependency'}
        edge['import_map_base'] = base
        edge['resolution_base'] = base if inline or not module_kind else module
        edge['resolution_basis'] = 'document_base' if inline or not module_kind else 'module_url'
        local = None
        if module_kind:
            mapping = self.maps.get(parent['context_id'], {})
            if mapping.get('invalid'):
                return None, None, 'import_map_ambiguous'
            if PurePosixPath(parsed_specifier.path).suffix.lower() in {'.json', '.css', '.png', '.svg', '.wasm'}:
                return None, None, 'non_js_module'
            try:
                target, reason = mapped_specifier(specifier, base if inline else module, base, mapping)
            except ValueError:
                return None, None, 'invalid_import_map'
            if specifier.startswith(('./', '../', '/')) and not parent['url'] and not mapping.get('imports') and not mapping.get('scopes') and reason in (None, 'base_unknown'):
                local = posixpath.normpath(posixpath.join('' if specifier.startswith('/') else posixpath.dirname(parent['location']), specifier.lstrip('/') if specifier.startswith('/') else specifier))
                edge['local_resolution_base'] = posixpath.dirname(parent['location'])
        elif edge['kind'] == 'webpack_chunk':
            public = edge.get('public_path')
            if public is None:
                return None, None, 'public_path_unknown'
            target = urljoin(urljoin(base or '', public), specifier)
            edge['resolution_base'] = urljoin(base or '', public)
            edge['resolution_basis'] = 'webpack_public_path'
            reason = None if http_url(target) else 'base_unknown'
        else:
            target = urljoin(base or '', specifier)
            reason = None if http_url(target) else 'base_unknown'
            if not parent['url']:
                local = posixpath.normpath(posixpath.join('' if specifier.startswith('/') else posixpath.dirname(parent['location']), specifier.lstrip('/') if specifier.startswith('/') else specifier))
        if local and (local == '..' or local.startswith('../') or PurePosixPath(local).is_absolute()):
            local = None
        if target and not http_url(target):
            target = None
        return canonical_url(target) if target else None, local, reason

    def refresh(self):
        by_id = {a['id']: a for a in self.snapshot.assets}
        for asset in self.snapshot.assets:
            asset['js_depth'] = 0 if asset['kind'] == 'html' else 1 if asset.get('url') in self.seeds or asset['location'] in self.seeds else None
        # Repeat when a page association supplies a previously unknown module URL.
        for _ in range(len(self.snapshot.assets)+1):
            if time.monotonic() >= self.end:
                raise TimeoutError('Reference graph deadline reached.')
            urls, locations = {}, {}
            for asset in self.snapshot.assets:
                if asset['kind'] != 'js':
                    continue
                aliases = [asset.get('url'), asset.get('reference_url'), *asset.get('url_aliases', [])]
                for value in aliases:
                    if http_url(value):
                        values = urls.setdefault((asset['context_id'], canonical_url(value)), [])
                        if asset not in values:
                            values.append(asset)
                if not asset['url']:
                    locations.setdefault((asset['context_id'], asset['location']), []).append(asset)
            changed = False
            for edge in self.edges:
                parent = by_id[edge['parent_asset_id']]
                target, local, reason = self.targets(edge, parent)
                edge.update(target_url=target, target_location=local, resolution_reason=reason)
                children = list(urls.get((edge['context_id'], target), [])) if target else []
                if local:
                    for asset in locations.get((edge['context_id'], local), []):
                        if asset not in children:
                            children.append(asset)
                edge['child_asset_ids'] = [child['id'] for child in children]
                certain = edge['confidence'] in {'certain', 'structured'}
                edge['status'] = 'candidate' if not certain else 'ambiguous_version' if len(children) > 1 else 'available' if children else 'unresolved' if not target else 'pending'
                if not certain or len(children) != 1:
                    continue
                child = children[0]
                if target and not child['url']:
                    known = set(child.get('reference_urls', [])) | {target}
                    child['reference_urls'] = sorted(known)
                    reference_url = next(iter(known)) if len(known) == 1 else None
                    if child.get('reference_url') != reference_url:
                        child['reference_url'] = reference_url
                        changed = True
                depth = parent['js_depth']
                if depth is not None and (child['js_depth'] is None or depth+1 < child['js_depth']):
                    child['js_depth'] = depth+1
                    changed = True
            if not changed:
                break
        for edge in self.edges:
            parent = by_id[edge['parent_asset_id']]
            edge['child_depth'] = parent['js_depth']+1 if parent['js_depth'] is not None else None

    def _accept_future(self, future, edge, fetcher):
        key = (edge['context_id'], edge['target_url'])
        try:
            response = dict(future.result())
            parent = next(a for a in self.snapshot.assets if a['id'] == edge['parent_asset_id'])
            previous = {a['id'] for a in self.snapshot.assets}
            asset = self.snapshot.add(response.pop('data'), location=response['url'], url=response['url'], kind='js',
                                      page_url=parent['page_url'], context_id=parent['context_id'],
                                      observation={'source': 'static-supplement', 'time': response['fetched_at']})
            if asset is None:
                raise FetchError('body_rejected', 'Fetched response failed snapshot validation; no partial script was imported.')
            asset['url_aliases'] = sorted(set(asset.get('url_aliases', [])) | set(response['aliases']))
            if asset['id'] not in previous:
                asset.update(acquisition='static-supplement', fetched_at=response['fetched_at'])
            # Keep the accepted edge truthful even if the wave deadline prevents
            # the next full graph refresh. Newly discovered references wait for resume.
            edge.update(status='available', child_asset_ids=[asset['id']])
            depth = edge.get('child_depth')
            if depth is not None and (asset.get('js_depth') is None or depth < asset['js_depth']):
                asset['js_depth'] = depth
            return True
        except (FetchError, CancelledError) as error:
            kind = error.kind if isinstance(error, FetchError) else 'fetch_cancelled'
            edge['status'], edge['error'] = kind, str(error) or 'Collection stopped before this request started.'
            self.failures[key] = (kind, edge['error'])
            return False
        finally:
            self.checkpoint(fetcher)

    def _wave(self, executor, fetcher, edges):
        futures = {executor.submit(fetcher.get, e['target_url'], self.snapshot.max_asset_bytes,
                                   context_id=e['context_id']): e for e in edges}
        processed, grew = set(), False
        try:
            remaining = min(self.end, fetcher.end)-time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Collection wave deadline reached.')
            for future in as_completed(futures, timeout=remaining):
                processed.add(future)
                grew |= self._accept_future(future, futures[future], fetcher)
        except BaseException:
            fetcher.cancel()
            for future in futures:
                future.cancel()
            # Drain every worker before exposing a stable checkpoint/report.
            wait(futures)
            for future, edge in futures.items():
                if future not in processed:
                    self._accept_future(future, edge, fetcher)
            raise
        return grew

    def run(self, fetcher=None):
        executor = None
        if fetcher:
            fetcher.configure_budget(max(0, self.snapshot.max_total_bytes-self.snapshot.total_bytes), self.end)
            executor = ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix='static-js')
        try:
            while True:
                self.snapshot.resolve_contexts()
                self.discover()
                self.refresh()
                self.checkpoint(fetcher)
                pending = [e for e in self.edges if e['status'] == 'pending']
                pending.sort(key=lambda e: (e['child_depth'] is None, e['child_depth'] or 0, e['id']))
                selected, keys = [], set()
                for edge in pending:
                    if edge['child_depth'] is None:
                        edge['status'] = 'unknown_depth'
                        continue
                    if edge['child_depth'] > self.max_depth:
                        edge['status'] = 'depth_limit'
                        continue
                    if fetcher is None:
                        edge['status'] = 'missing_offline'
                        continue
                    key = (edge['context_id'], edge['target_url'])
                    if key in self.failures:
                        edge['status'], edge['error'] = self.failures[key]
                        continue
                    if key in keys:
                        continue
                    if selected and edge['child_depth'] != selected[0]['child_depth']:
                        continue
                    if len(selected) < self.concurrency:
                        selected.append(edge)
                        keys.add(key)
                if not selected:
                    break
                self._wave(executor, fetcher, selected)
                # Even an all-failure wave can leave other URLs at this layer untried.
        except TimeoutError as error:
            kind = 'reference_deadline' if time.monotonic() >= self.end else 'fetch_deadline'
            self.snapshot.gap(kind, str(error), incomplete=True)
        finally:
            if executor:
                executor.shutdown(wait=True, cancel_futures=True)
            for edge in self.edges:
                status = edge['status']
                if status in {'available', 'candidate'}:
                    continue
                incomplete = status not in {'unresolved', 'unknown_depth'}
                self.snapshot.gap('reference_'+status, edge.get('error') or edge.get('resolution_reason') or 'Referenced script has not been obtained.',
                                  asset_id=edge['parent_asset_id'], source=edge['id'], incomplete=incomplete)
            self.snapshot.reference_edges = self.edges
            self.snapshot.fetch_events = fetcher.events if fetcher else []
            self.snapshot.fetch_statistics = fetcher.statistics() if fetcher else None
            self.checkpoint(fetcher)
        return self.edges

    def checkpoint(self, fetcher):
        value = dict(schema_version='0.3', assets=self.snapshot.assets, contexts=self.snapshot.contexts,
                     edges=self.edges, fetch_events=fetcher.events if fetcher else [], import_gaps=self.import_gaps,
                     fetch_statistics=fetcher.statistics() if fetcher else None)
        path = self.snapshot.output/'collection.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
        temporary.replace(path)


def restore_snapshot(snapshot, source):
    source = Path(source).resolve()
    checkpoint = source/'collection.json'
    if checkpoint.stat().st_size > snapshot.max_total_bytes:
        raise ValueError('Collection checkpoint exceeds input budget.')
    data = json.loads(checkpoint.read_text())
    if data.get('schema_version') not in {'0.2', '0.3'} or not isinstance(data.get('assets'), list):
        raise ValueError('Unsupported collection checkpoint.')
    for entry in data['assets']:
        relative = entry['body_file']
        if not isinstance(relative, str) or PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts:
            raise ValueError('Unsafe checkpoint body path.')
        body = source/relative
        if not body.resolve().is_relative_to(source) or body.is_symlink():
            raise ValueError('Checkpoint body escapes its source directory.')
        if body.stat().st_size > snapshot.max_asset_bytes:
            raise ValueError('Checkpoint body exceeds per-asset budget.')
        content = body.read_bytes()
        if digest(content) != entry['sha256'] or entry['kind'] not in {'js', 'html'}:
            raise ValueError('Checkpoint body hash/type mismatch.')
        asset = snapshot.add(content, location=entry['location'], url=entry['url'], page_url=entry['page_url'],
                             kind=entry['kind'], context_id=entry['context_id'], observation='restored')
        if asset:
            if asset['id'] != entry['id']:
                raise ValueError('Checkpoint asset identity mismatch.')
            for key in ('acquisition', 'fetched_at', 'url_aliases'):
                if key in entry:
                    asset[key] = entry[key]
    for gap in data.get('import_gaps', []):
        if not isinstance(gap, dict) or not isinstance(gap.get('kind'), str) or not isinstance(gap.get('incomplete'), bool):
            raise ValueError('Invalid checkpoint import gap.')
        if gap not in snapshot.gaps:
            snapshot.gaps.append(gap)
