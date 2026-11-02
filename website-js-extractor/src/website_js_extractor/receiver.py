"""Incremental receiver with a built-in matching code. No browser-local outbox.

SQLite FULL synchronous commits precede acknowledgements. Bodies remain chunked
on the server; an object becomes visible only after total length/hash validation.
"""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import sqlite3
import threading
from urllib.parse import urlsplit, parse_qs, unquote

SCHEMA = 'capture-stream-1'
DEFAULT_CODE = 'blackbox-capture-v1'
CHUNK_BYTES = 256 * 1024
OBJECT_BYTES = 128 * 1024 * 1024
EVENT_BYTES = 128 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}')
PROJECT = re.compile(r'[A-Za-z0-9_-]{1,64}')


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise Invalid('Duplicate JSON key.')
            result[key] = item
        return result
    def invalid_constant(value):
        raise Invalid('Non-finite JSON number.')
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise Invalid("Non-finite JSON number.")
        return number
    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Invalid('Invalid JSON.') from error


class Receiver:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(directory / 'capture.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS chunks(project TEXT, hash TEXT, offset INTEGER,
            total INTEGER, data BLOB, digest TEXT, PRIMARY KEY(project,hash,offset));
          CREATE TABLE IF NOT EXISTS objects(project TEXT, hash TEXT, bytes INTEGER,
            PRIMARY KEY(project,hash));
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT, id TEXT, scan TEXT, payload TEXT, digest TEXT,
            UNIQUE(project,id));
          CREATE INDEX IF NOT EXISTS scan_events ON events(project,scan,seq);
        ''')

    def close(self):
        self.db.close()

    def object_info(self, project, identity):
        with self.lock:
            row = self.db.execute('SELECT bytes FROM objects WHERE project=? AND hash=?', (project, identity)).fetchone()
            return dict(sha256=identity, bytes=row[0], committed=True) if row else dict(sha256=identity, committed=False)

    def chunk(self, project, identity, offset, total, data, digest):
        if not 0 < total <= OBJECT_BYTES or not 0 <= offset < total or offset % CHUNK_BYTES:
            raise Invalid('Invalid object size/offset.')
        if len(data) != min(CHUNK_BYTES, total-offset) or sha(data) != digest:
            raise Invalid('Chunk size/hash mismatch.')
        with self.lock, self.db:
            rows = self.db.execute('SELECT total,data,digest FROM chunks WHERE project=? AND hash=? AND offset=?', (project, identity, offset)).fetchone()
            if rows:
                if rows != (total, data, digest):
                    raise Invalid('Conflicting chunk.', 409)
            else:
                old = self.db.execute('SELECT total FROM chunks WHERE project=? AND hash=? LIMIT 1', (project, identity)).fetchone()
                if old and old[0] != total:
                    raise Invalid('Conflicting object length.', 409)
                self.db.execute('INSERT INTO chunks VALUES(?,?,?,?,?,?)', (project, identity, offset, total, data, digest))
        return dict(sha256=identity, offset=offset, chunk_sha256=digest, durable=True)

    def commit(self, project, identity, total):
        if not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= OBJECT_BYTES:
            raise Invalid('Invalid object length.')
        with self.lock, self.db:
            offset, digest = 0, hashlib.sha256()
            for start, size, data in self.db.execute('SELECT offset,total,data FROM chunks WHERE project=? AND hash=? ORDER BY offset', (project, identity)):
                if start != offset or size != total:
                    raise Invalid('Missing or inconsistent chunks.', 409)
                digest.update(data)
                offset += len(data)
            if offset != total or digest.hexdigest() != identity:
                raise Invalid('Object length/hash mismatch.', 409)
            # Reject invalid text rather than changing the bytes during analysis.
            import codecs
            decoder = codecs.getincrementaldecoder('utf-8')('strict')
            try:
                for (data,) in self.db.execute('SELECT data FROM chunks WHERE project=? AND hash=? ORDER BY offset', (project, identity)):
                    decoder.decode(data)
                decoder.decode(b'', final=True)
            except UnicodeError as error:
                raise Invalid('Source must be UTF-8.') from error
            self.db.execute('INSERT OR IGNORE INTO objects VALUES(?,?,?)', (project, identity, total))
        return dict(sha256=identity, bytes=total, committed=True, durable=True)

    def event(self, project, envelope):
        if not isinstance(envelope, dict) or envelope.get('schema') != SCHEMA:
            raise Invalid('Invalid event envelope/schema.')
        if 'event_object_sha256' in envelope:
            identity = envelope['event_object_sha256']
            if not isinstance(identity, str) or not HASH.fullmatch(identity) or not self.object_info(project, identity)['committed']:
                raise Invalid('Event object is not committed.', 409)
            payload = b''.join(self.source_chunks(project, identity)).decode('utf-8')
        else:
            payload = envelope.get('event_json')
        if not isinstance(payload, str):
            raise Invalid('Missing event JSON.')
        try:
            raw = payload.encode('utf-8')
        except UnicodeError as error:
            raise Invalid('Invalid event Unicode.') from error
        digest = sha(raw)
        if len(raw) > EVENT_BYTES or digest != envelope.get('event_sha256'):
            raise Invalid('Event size/hash mismatch.')
        value = strict_json(payload)
        if not isinstance(value, dict) or not isinstance(value.get('data'), dict):
            raise Invalid('Invalid event data.')
        for field in ['id', 'scan_id', 'kind', 'time', 'session_id', 'epoch', 'status']:
            if not isinstance(value.get(field), str) or not value[field] or len(value[field]) > 512:
                raise Invalid('Missing/invalid event identity.')
        content = value.get('hash')
        if content is not None and (not isinstance(content, str) or not HASH.fullmatch(content)):
            raise Invalid('Invalid content hash.')
        with self.lock, self.db:
            if content:
                obj = self.object_info(project, content)
                if not obj['committed']:
                    raise Invalid('Event references an uncommitted object.', 409)
                if obj['bytes'] != value['data'].get('source_bytes'):
                    raise Invalid('Event source length mismatch.')
            old = self.db.execute('SELECT digest FROM events WHERE project=? AND id=?', (project, value['id'])).fetchone()
            if old and old[0] != digest:
                raise Invalid('Event ID reused for different data.', 409)
            if not old:
                self.db.execute('INSERT INTO events(project,id,scan,payload,digest) VALUES(?,?,?,?,?)', (project,value['id'],value['scan_id'],payload,digest))
        return dict(schema=SCHEMA, event_id=value['id'], event_sha256=digest, content_sha256=content, durable=True)

    def page(self, project, scan, after=0, limit=50, summary=False):
        if not 0 <= after or not 1 <= limit <= 100:
            raise Invalid('Invalid page.')
        with self.lock:
            rows, size = [], 0
            for row in self.db.execute('SELECT seq,payload FROM events WHERE project=? AND scan=? AND seq>? ORDER BY seq LIMIT ?', (project,scan,after,limit)):
                if rows and size + len(row[1]) > 4*1024*1024: break
                rows.append(row); size += len(row[1])
            count = self.db.execute('SELECT count(*) FROM events WHERE project=? AND scan=?', (project,scan)).fetchone()[0]
            next_cursor = rows[-1][0] if rows else after
            more = bool(self.db.execute('SELECT 1 FROM events WHERE project=? AND scan=? AND seq>? LIMIT 1', (project,scan,next_cursor)).fetchone())
        events = [strict_json(r[1]) for r in rows]
        if summary:
            for item in events:
                data = item['data']
                item['data'] = {key: data[key] for key in ['url','document_url','source_bytes','network_match','observed_tab_url','target_id'] if key in data}
                if item['kind'] == 'ObservedRequest':
                    record = data.get('record', {})
                    item['data']['record'] = {key: record[key] for key in ['request_url','method','status_code','request_id'] if key in record}
                item['summary_only'] = True
        return dict(events=events, count=count, next=next_cursor, has_more=more)

    def source_chunks(self, project, identity):
        offset = 0
        while True:
            with self.lock:
                row = self.db.execute('SELECT data FROM chunks WHERE project=? AND hash=? AND offset=?', (project,identity,offset)).fetchone()
            if not row:
                return
            offset += len(row[0])
            yield row[0]


def make_server(directory, token=DEFAULT_CODE, project='default', host='127.0.0.1', port=0, origins=None):
    if len(token) < 16 or not PROJECT.fullmatch(project):
        raise ValueError('Use a token of at least 16 characters and a valid project ID.')
    store = Receiver(directory)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_):
            pass  # URLs/payloads/tokens must not leak to console logs.

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=True, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            origin = self.headers.get('Origin')
            if origins is None or origin in origins:
                self.send_header('Access-Control-Allow-Origin', '*' if origins is None else origin)
                self.send_header('Vary', 'Origin')
            self.end_headers()
            self.wfile.write(data)

        def body(self, maximum):
            if self.headers.get('Transfer-Encoding'):
                raise Invalid('Content-Length required.', 411)
            try:
                length = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                raise Invalid('Invalid length.')
            if not 0 <= length <= maximum:
                raise Invalid('Body exceeds request budget.', 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise Invalid('Incomplete request.')
            return data

        def do_OPTIONS(self):
            if origins is not None and self.headers.get('Origin') not in origins:
                self.reply(403, dict(error='Origin denied.'))
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*' if origins is None else self.headers['Origin'])
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Object-Bytes,X-Chunk-SHA256')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def handle_request(self):
            self.connection.settimeout(15)
            try:
                origin = self.headers.get('Origin')
                if self.command == 'GET' and self.path in {'/', '/health'}:
                    return self.reply(200, dict(status='ok', service='blackbox-receiver', project=project))
                if origins is not None and origin and origin not in origins:
                    raise Invalid('Origin denied.', 403)
                if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    raise Invalid('Invalid token.', 401)
                parsed = urlsplit(self.path)
                match = re.fullmatch(r'/v1/projects/([A-Za-z0-9_-]{1,64})/(events|objects(?:/([a-f0-9]{64})(?:/(commit|chunks/(\d+)))?)?)', parsed.path)
                if not match or match[1] != project:
                    raise Invalid('Unknown route/project.', 404)
                route, identity, action, offset = match.groups()[1:]
                if route == 'events' and self.command == 'POST':
                    return self.reply(200, store.event(project, strict_json(self.body(8 * 1024 * 1024))))
                if route == 'events' and self.command == 'GET':
                    query = parse_qs(parsed.query)
                    return self.reply(200, store.page(project, query.get('scan_id', [''])[0], int(query.get('after', ['0'])[0]), int(query.get('limit', ['50'])[0]), query.get('summary') == ['1']))
                if identity and self.command == 'PUT' and offset is not None:
                    return self.reply(200, store.chunk(project, identity, int(offset), int(self.headers.get('X-Object-Bytes','-1')), self.body(CHUNK_BYTES), self.headers.get('X-Chunk-SHA256','')))
                if identity and action == 'commit' and self.command == 'POST':
                    value = strict_json(self.body(1024))
                    if not isinstance(value, dict): raise Invalid('Invalid commit.')
                    return self.reply(200, store.commit(project, identity, value.get('bytes')))
                if identity and action is None and self.command == 'GET':
                    info = store.object_info(project, identity)
                    if parsed.query == 'status':
                        return self.reply(200, info)
                    if not info['committed']: raise Invalid('Unknown object.', 404)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                    self.send_header('Content-Length', str(info['bytes']))
                    self.send_header('Cache-Control', 'no-store')
                    if origins is None or origin in origins: self.send_header('Access-Control-Allow-Origin', '*' if origins is None else origin)
                    self.end_headers()
                    for data in store.source_chunks(project, identity): self.wfile.write(data)
                    return
                raise Invalid('Unsupported method/route.', 404)
            except (Invalid, ValueError, TypeError, KeyError, OverflowError) as error:
                self.close_connection = True
                self.reply(getattr(error, 'status', 400), dict(error=str(error)))
            except (OSError, sqlite3.Error):
                self.close_connection = True
                self.reply(503, dict(error='Storage or connection unavailable; no acknowledgement.'))

        do_GET = do_POST = do_PUT = handle_request

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.store = store
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description='Blackbox receiver: run without arguments; plugin only needs this server address.')
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[2] / 'data' / 'capture')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8379)
    args = parser.parse_args(argv)
    server = make_server(args.data_dir, host=args.host, port=args.port)
    print(json.dumps(dict(url=f'http://{args.host}:{server.server_port}', project='default')), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.store.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
