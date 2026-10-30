"""Bounded static-resource GETs. Uses inherited proxies and default TLS trust."""
from datetime import datetime, timezone
import http.client
import json
import re
from pathlib import Path
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .assets import http_url


def origin(url):
    if not http_url(url):
        raise ValueError('Expected a valid HTTP/HTTPS origin or URL.')
    parsed = urlsplit(url)
    host = parsed.hostname.lower().encode('idna').decode()
    if ':' in host:
        host = '['+host+']'
    port = parsed.port
    if port and port != (443 if parsed.scheme == 'https' else 80):
        host += ':'+str(port)
    return parsed.scheme.lower()+'://'+host


def canonical_url(url):
    parsed = urlsplit(urldefrag(url)[0])
    return origin(url)+urlunsplit(('', '', parsed.path or '/', parsed.query, ''))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


class FetchError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


class StaticFetcher:
    def __init__(self, allowed_origins, *, max_files=100, timeout=10, deadline=60,
                 retries=1, session_file=None):
        self.allowed = set()
        for value in allowed_origins:
            parsed = urlsplit(value)
            if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
                raise ValueError('--allow-origin must contain an origin, not a URL path.')
            self.allowed.add(origin(value))
        if not self.allowed:
            raise ValueError('Explicit --allow-origin is required when enabling network supplementation.')
        self.timeout, self.end, self.retries = timeout, time.monotonic()+deadline, retries
        self.max_files, self.files, self.file_attempts, self.bytes = max_files, 0, 0, 0
        self.events, self.session = [], {}
        self.opener = build_opener(NoRedirect())
        if session_file:
            path = Path(session_file)
            if path.stat().st_size > 65536:
                raise ValueError('Session configuration exceeds 64 KiB.')
            data = json.loads(path.read_text())
            if not isinstance(data, dict):
                raise ValueError('Session configuration must map exact origins to headers.')
            for key, headers in data.items():
                if key != origin(key) or not isinstance(headers, dict):
                    raise ValueError('Session keys must be canonical exact origins.')
                for name, value in headers.items():
                    if not isinstance(name, str) or not isinstance(value, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or any(c in name+value for c in '\r\n'):
                        raise ValueError('Invalid session header.')
                    if name.lower() in {'host', 'proxy-authorization', 'proxy-connection', 'connection', 'content-length', 'transfer-encoding', 'upgrade'}:
                        raise ValueError('Transport headers are not accepted in a session configuration.')
                self.session[key] = headers

    def check_url(self, url):
        try:
            destination = origin(url)
        except ValueError as error:
            raise FetchError('unsupported_resource_url', 'Resource or redirect URL is not valid HTTP/HTTPS.') from error
        if destination not in self.allowed:
            raise FetchError('outside_origin', 'Resource or redirect origin is outside the explicit allowlist.')
        if time.monotonic() >= self.end:
            raise FetchError('fetch_deadline', 'Total collection deadline reached.')

    def get(self, url, max_bytes):
        self.check_url(url)
        if self.file_attempts >= self.max_files:
            raise FetchError('fetch_file_budget', 'Maximum number of supplemented files reached.')
        if max_bytes <= 0:
            raise FetchError('fetch_byte_budget', 'No remaining response-body budget.')
        self.file_attempts += 1
        current = canonical_url(url)
        chain = []
        for hop in range(6):
            self.check_url(current)
            headers = {'Accept': 'application/javascript, text/javascript, */*;q=0.1',
                       'User-Agent': 'site-js-analyzer/0.2'}
            # Always rebuild headers from this origin's explicit session; never forward old ones.
            headers.update(self.session.get(origin(current), {}))
            response = None
            for attempt in range(self.retries+1):
                self.check_url(current)
                event = dict(url=current, requested_url=url, method='GET', hop=hop,
                             attempt=attempt+1, started_at=datetime.now(timezone.utc).isoformat())
                self.events.append(event)
                try:
                    response = self.opener.open(Request(current, headers=headers),
                                                timeout=min(self.timeout, max(0.001, self.end-time.monotonic())))
                    event['status'] = response.status
                    break
                except HTTPError as error:
                    event['status'] = error.code
                    if error.code in {301, 302, 303, 307, 308}:
                        location = error.headers.get('Location')
                        error.close()
                        if not location:
                            raise FetchError('redirect_invalid', 'Redirect has no Location header.')
                        target = urljoin(current, location)
                        self.check_url(target)
                        chain.append(current)
                        current = canonical_url(target)
                        break
                    error.close()
                    if (error.code == 429 or 500 <= error.code < 600) and attempt < self.retries:
                        continue
                    raise FetchError('http_status', f'Static resource returned HTTP {error.code}.') from error
                except (URLError, OSError, http.client.HTTPException) as error:
                    event['error_type'] = type(error).__name__
                    if attempt < self.retries:
                        continue
                    raise FetchError('network_failed', 'Static resource could not be read; proxy/TLS/network settings were preserved.') from error
            if response is None:
                continue  # A checked redirect; retry count resets for its new destination.
            with response:
                mime = response.headers.get_content_type().lower()
                if mime not in {'application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript', 'application/x-javascript', 'text/plain', 'application/octet-stream'}:
                    raise FetchError('response_type', 'Expected a JavaScript response, not HTML/JSON or another MIME type.')
                chunks, size = [], 0
                while True:
                    self.check_url(current)
                    try:
                        raw = getattr(getattr(response.fp, 'raw', None), '_sock', None)
                        if raw:
                            raw.settimeout(min(self.timeout, max(0.001, self.end-time.monotonic())))
                        block = response.read1(min(65536, max_bytes-size+1))
                    except (OSError, socket.timeout, http.client.HTTPException) as error:
                        raise FetchError('response_incomplete', 'Response body did not finish; no truncated script was imported.') from error
                    if not block:
                        break
                    size += len(block)
                    self.bytes += len(block)
                    if size > max_bytes:
                        raise FetchError('fetch_byte_budget', 'Response exceeded the remaining per-file/total byte budget.')
                    chunks.append(block)
                data = b''.join(chunks)
                # read1 does not enforce Content-Length on early EOF in every Python version.
                length = response.headers.get('Content-Length')
                if length is not None:
                    try:
                        if int(length) != len(data):
                            raise FetchError('response_incomplete', 'Response length differs from Content-Length.')
                    except ValueError as error:
                        raise FetchError('response_incomplete', 'Invalid Content-Length.') from error
                if not any(token in mime for token in ('javascript', 'ecmascript')) and not urlsplit(current).path.endswith(('.js', '.mjs')):
                    raise FetchError('response_type', 'Extensionless modules require an explicit JavaScript MIME type.')
            self.files += 1
            return dict(data=data, url=current, aliases=chain+[url],
                        fetched_at=datetime.now(timezone.utc).isoformat(), mime=mime)
        raise FetchError('redirect_limit', 'Redirect chain exceeded five hops.')
