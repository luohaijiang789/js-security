"""Bounded static-resource GETs. Uses inherited proxies and default TLS trust."""
from concurrent.futures import Future, TimeoutError as FutureTimeout
from contextlib import contextmanager
from datetime import datetime, timezone
import http.client
import json
import re
from pathlib import Path
import socket
import threading
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
        self.session = {}
        self._condition = threading.Condition(threading.RLock())
        self._stop = threading.Event()
        self._local = threading.local()
        self._events, self._resources, self._sockets = [], {}, set()
        self._byte_limit, self._reserved, self._peak_budget = None, 0, 0
        self._observed, self._active, self._peak_active = 0, 0, 0
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

    @property
    def events(self):
        with self._condition:
            return [dict(event) for event in self._events]

    def statistics(self):
        with self._condition:
            return dict(file_attempts=self.file_attempts, complete_response_bodies=self.files,
                        body_bytes_charged=self.bytes, body_bytes_observed=self._observed,
                        body_byte_limit=self._byte_limit, reserved_bytes=self._reserved,
                        peak_charged_and_reserved=self._peak_budget,
                        active_requests=self._active, peak_active_requests=self._peak_active,
                        cancelled=self._stop.is_set())

    def configure_budget(self, total_bytes, end=None):
        with self._condition:
            if self.file_attempts or self._resources:
                raise ValueError('Configure collection budget before starting requests.')
            if total_bytes < 0:
                raise ValueError('Body budget must be non-negative.')
            self._byte_limit = total_bytes
            if end is not None:
                self.end = min(self.end, end)

    def cancel(self):
        self._stop.set()
        with self._condition:
            sockets = list(self._sockets)
            self._condition.notify_all()
        # Shut down sockets rather than closing a buffered reader held by another thread.
        for connection in sockets:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def _check_stop(self):
        if self._stop.is_set():
            raise FetchError('fetch_cancelled', 'Collection stopped; no new request was started.')
        if time.monotonic() >= self.end:
            raise FetchError('fetch_deadline', 'Total collection deadline reached.')

    def check_url(self, url):
        self._check_stop()
        try:
            destination = origin(url)
        except ValueError as error:
            raise FetchError('unsupported_resource_url', 'Resource or redirect URL is not valid HTTP/HTTPS.') from error
        if destination not in self.allowed:
            raise FetchError('outside_origin', 'Resource or redirect origin is outside the explicit allowlist.')

    def _reserve_read(self, maximum):
        with self._condition:
            while True:
                self._check_stop()
                available = maximum if self._byte_limit is None else self._byte_limit-self.bytes-self._reserved
                if available > 0:
                    amount = min(maximum, available)
                    self._reserved += amount
                    self._peak_budget = max(self._peak_budget, self.bytes+self._reserved)
                    return amount
                if self._reserved == 0:
                    raise FetchError('fetch_byte_budget', 'Total response-body budget exhausted.')
                self._condition.wait(timeout=min(0.05, max(0.001, self.end-time.monotonic())))

    def _settle_read(self, reserved, observed, charged=None):
        with self._condition:
            self._reserved -= reserved
            self.bytes += observed if charged is None else charged
            self._observed += observed
            self._peak_budget = max(self._peak_budget, self.bytes+self._reserved)
            self._condition.notify_all()

    def _event(self, **values):
        with self._condition:
            event = dict(sequence=len(self._events), **values)
            self._events.append(event)
            return event

    def _update(self, event, **values):
        with self._condition:
            event.update(values)

    @contextmanager
    def _request_slot(self):
        with self._condition:
            self._active += 1
            self._peak_active = max(self._peak_active, self._active)
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1

    def _opener(self):
        if not hasattr(self._local, 'opener'):
            self._local.opener = build_opener(NoRedirect())
        return self._local.opener

    def _read_body(self, response, current, max_bytes, event):
        mime = response.headers.get_content_type().lower()
        if mime not in {'application/javascript', 'text/javascript', 'application/ecmascript',
                        'text/ecmascript', 'application/x-javascript', 'text/plain', 'application/octet-stream'}:
            raise FetchError('response_type', 'Expected a JavaScript response, not HTML/JSON or another MIME type.')
        length = response.headers.get('Content-Length')
        if length is not None:
            try:
                length = int(length)
                if length < 0:
                    raise ValueError()
            except ValueError as error:
                raise FetchError('response_incomplete', 'Invalid Content-Length.') from error
            if length > max_bytes:
                raise FetchError('fetch_byte_budget', 'Declared body length exceeds the per-file budget.')
        raw = getattr(getattr(response.fp, 'raw', None), '_sock', None)
        if raw:
            with self._condition:
                self._sockets.add(raw)
        chunks, size = [], 0
        try:
            while length is None or size < length:
                self._check_stop()
                remaining = max_bytes-size
                if remaining <= 0:
                    raise FetchError('fetch_byte_budget', 'Body reached its limit without proof of EOF.')
                reserved = self._reserve_read(min(65536, remaining, length-size if length is not None else remaining))
                try:
                    if raw:
                        raw.settimeout(min(self.timeout, max(0.001, self.end-time.monotonic())))
                    block = response.read1(reserved)
                except (OSError, ValueError, http.client.HTTPException) as error:
                    # A failed read can have consumed unobservable bytes: charge the reservation.
                    self._settle_read(reserved, 0, reserved)
                    self._check_stop()
                    raise FetchError('response_incomplete', 'Response body did not finish; no partial script was imported.') from error
                self._settle_read(reserved, len(block))
                self._check_stop()
                if not block:
                    break
                size += len(block)
                chunks.append(block)
                self._update(event, body_bytes_observed=size)
            if length is not None and size != length:
                raise FetchError('response_incomplete', 'Response length differs from Content-Length.')
            if not any(token in mime for token in ('javascript', 'ecmascript')) and not urlsplit(current).path.endswith(('.js', '.mjs')):
                raise FetchError('response_type', 'Extensionless modules require an explicit JavaScript MIME type.')
            with self._condition:
                self.files += 1
            return dict(data=b''.join(chunks), mime=mime,
                        fetched_at=datetime.now(timezone.utc).isoformat())
        finally:
            if raw:
                with self._condition:
                    self._sockets.discard(raw)

    def _request_resource(self, current, requested, hop, max_bytes):
        headers = {'Accept': 'application/javascript, text/javascript, */*;q=0.1',
                   'User-Agent': 'website-js-extractor/0.5'}
        headers.update(self.session.get(origin(current), {}))
        for attempt in range(self.retries+1):
            self.check_url(current)
            event = self._event(url=current, requested_url=requested, method='GET', hop=hop,
                                attempt=attempt+1, started_at=datetime.now(timezone.utc).isoformat())
            try:
                with self._request_slot():
                    response = self._opener().open(Request(current, headers=headers),
                                                  timeout=min(self.timeout, max(0.001, self.end-time.monotonic())))
                    self._update(event, status=response.status)
                    with response:
                        return self._read_body(response, current, max_bytes, event)
            except HTTPError as error:
                self._update(event, status=error.code)
                location = error.headers.get('Location')
                error.close()
                if error.code in {301, 302, 303, 307, 308}:
                    if not location:
                        raise FetchError('redirect_invalid', 'Redirect has no Location header.')
                    target = urljoin(current, location)
                    self.check_url(target)
                    return dict(redirect=canonical_url(target))
                if (error.code == 429 or 500 <= error.code < 600) and attempt < self.retries:
                    continue
                raise FetchError('http_status', f'Static resource returned HTTP {error.code}.') from error
            except (URLError, OSError, http.client.HTTPException) as error:
                self._update(event, error_type=type(error).__name__)
                self._check_stop()
                if attempt < self.retries:
                    continue
                raise FetchError('network_failed', 'Static resource could not be read; proxy/TLS/network settings were preserved.') from error
            except FetchError as error:
                self._update(event, error_type=error.kind)
                raise
            finally:
                self._update(event, finished_at=datetime.now(timezone.utc).isoformat())

    def _resource(self, current, requested, hop, max_bytes, context_id):
        key = (context_id, current)
        with self._condition:
            future = self._resources.get(key)
            owner = future is None
            if owner:
                self._check_stop()
                if hop == 0:
                    if self.file_attempts >= self.max_files:
                        raise FetchError('fetch_file_budget', 'Maximum number of distinct script attempts reached.')
                if self._byte_limit is not None and self.bytes >= self._byte_limit:
                    raise FetchError('fetch_byte_budget', 'Total response-body budget exhausted.')
                if hop == 0:
                    self.file_attempts += 1
                future = Future()
                self._resources[key] = future
        if owner:
            try:
                future.set_result(self._request_resource(current, requested, hop, max_bytes))
            except BaseException as error:
                future.set_exception(error)
                raise
        try:
            return future.result(timeout=max(0.001, self.end-time.monotonic()))
        except FutureTimeout as error:
            raise FetchError('fetch_deadline', 'Timed out awaiting a shared static resource.') from error

    def get(self, url, max_bytes, *, context_id=None):
        self.check_url(url)
        if max_bytes <= 0:
            raise FetchError('fetch_byte_budget', 'No remaining response-body budget.')
        current, chain = canonical_url(url), []
        for hop in range(6):
            self.check_url(current)
            resource = self._resource(current, url, hop, max_bytes, context_id)
            if 'redirect' in resource:
                chain.append(current)
                current = resource['redirect']
                continue
            if len(resource['data']) > max_bytes:
                raise FetchError('fetch_byte_budget', 'Cached resource exceeds this per-file budget.')
            return dict(resource, url=current, aliases=chain+[url])
        raise FetchError('redirect_limit', 'Redirect chain exceeded five hops.')
