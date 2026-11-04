"""Incremental receiver with a built-in code and recoverable client outbox.

The browser uploads raw bytes under a random upload ID and never computes a
hash. The server hashes on commit, keeps content-addressed bodies and records
the project + URL mapping used by the plugin's local "already sent" marker.
SQLite FULL synchronous commits precede every acknowledgement.
"""
import argparse
import codecs
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
import threading
from urllib.parse import urlsplit, parse_qs

SCHEMA = 'capture-stream-2'
DEFAULT_CODE = 'blackbox-capture-v1'
CHUNK_BYTES = 256 * 1024
OBJECT_BYTES = 128 * 1024 * 1024
EVENT_BYTES = 128 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}')
PROJECT = re.compile(r'[A-Za-z0-9_-]{1,64}')
UPLOAD = re.compile(r'[A-Za-z0-9_-]{8,64}')
CATEGORIES = {'js_source', 'script_load', 'api_request', 'page_context', 'task'}


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
            raise Invalid('Non-finite JSON number.')
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
        # Old protocol-1 tables are left untouched; protocol-2 uses new names.
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS uploads(project TEXT, upload TEXT, offset INTEGER,
            total INTEGER, data BLOB, PRIMARY KEY(project,upload,offset));
          CREATE TABLE IF NOT EXISTS blobs(project TEXT, object_id TEXT, offset INTEGER,
            total INTEGER, data BLOB, PRIMARY KEY(project,object_id,offset));
          CREATE TABLE IF NOT EXISTS bodies(project TEXT, object_id TEXT, bytes INTEGER,
            kind TEXT, PRIMARY KEY(project,object_id));
          CREATE TABLE IF NOT EXISTS upload_receipts(project TEXT, upload TEXT, object_id TEXT,
            bytes INTEGER, url TEXT, kind TEXT, PRIMARY KEY(project,upload));
          CREATE TABLE IF NOT EXISTS object_urls(project TEXT, url TEXT, object_id TEXT,
            kind TEXT, updated TEXT, PRIMARY KEY(project,url));
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT, id TEXT, scan TEXT, payload TEXT, digest TEXT,
            UNIQUE(project,id));
          CREATE INDEX IF NOT EXISTS scan_events ON events(project,scan,seq);
          CREATE TABLE IF NOT EXISTS delivery_streams(project TEXT, stream TEXT, scan TEXT,
            sealed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,stream));
          CREATE TABLE IF NOT EXISTS deliveries(project TEXT, stream TEXT, sequence INTEGER,
            event_id TEXT, category TEXT, bytes INTEGER, object_id TEXT,
            PRIMARY KEY(project,stream,sequence), UNIQUE(project,event_id));
        ''')

    def close(self):
        self.db.close()

    def object_info(self, project, identity):
        with self.lock:
            row = self.db.execute('SELECT bytes FROM bodies WHERE project=? AND object_id=?', (project, identity)).fetchone()
            return dict(object_id=identity, bytes=row[0], committed=True) if row else dict(object_id=identity, committed=False)

    def lookup_url(self, project, url):
        with self.lock:
            row = self.db.execute('SELECT object_id,kind FROM object_urls WHERE project=? AND url=?', (project, url)).fetchone()
        return dict(url=url, object_id=row[0], kind=row[1], committed=True) if row else dict(url=url, committed=False)

    def chunk(self, project, upload, offset, total, data):
        if not UPLOAD.fullmatch(upload):
            raise Invalid('Invalid upload ID.')
        if not 0 <= total <= OBJECT_BYTES or not 0 <= offset < total or offset % CHUNK_BYTES:
            raise Invalid('Invalid object size/offset.')
        if len(data) != min(CHUNK_BYTES, total - offset):
            raise Invalid('Chunk size mismatch.')
        with self.lock, self.db:
            committed = self.db.execute('SELECT object_id,bytes FROM upload_receipts WHERE project=? AND upload=?',
                                        (project, upload)).fetchone()
            if committed:
                piece = self.db.execute('SELECT data FROM blobs WHERE project=? AND object_id=? AND offset=?',
                                        (project, committed[0], offset)).fetchone()
                if committed[1] != total or not piece or piece[0] != data:
                    raise Invalid('Conflicting committed upload.', 409)
                return dict(upload=upload, offset=offset, durable=True)
            rows = self.db.execute('SELECT total,data FROM uploads WHERE project=? AND upload=? AND offset=?',
                                   (project, upload, offset)).fetchone()
            if rows:
                if rows != (total, data):
                    raise Invalid('Conflicting chunk.', 409)
            else:
                old = self.db.execute('SELECT total FROM uploads WHERE project=? AND upload=? LIMIT 1',
                                      (project, upload)).fetchone()
                if old and old[0] != total:
                    raise Invalid('Conflicting object length.', 409)
                self.db.execute('INSERT INTO uploads VALUES(?,?,?,?,?)', (project, upload, offset, total, data))
        return dict(upload=upload, offset=offset, durable=True)

    def commit(self, project, upload, total, url, kind):
        if not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= OBJECT_BYTES:
            raise Invalid('Invalid object length.')
        if url is not None and (not isinstance(url, str) or not 0 < len(url) <= 4096):
            raise Invalid('Invalid object URL.')
        if kind not in ('js', 'event'):
            raise Invalid('Invalid object kind.')
        if kind == 'event' and url is not None:
            raise Invalid('Event objects cannot claim a URL.')
        with self.lock, self.db:
            # A commit whose ACK was lost must stay idempotent even though the
            # upload rows were already moved into content-addressed storage.
            prior = self.db.execute(
                'SELECT object_id,bytes,url,kind FROM upload_receipts WHERE project=? AND upload=?',
                (project, upload)).fetchone()
            if prior:
                if prior[1] != total or prior[2] != url or prior[3] != kind:
                    raise Invalid('Upload was already committed with different metadata.', 409)
                return dict(object_id=prior[0], url=prior[2], bytes=prior[1], committed=True, durable=True)
            rows = list(self.db.execute('SELECT offset,total,data FROM uploads WHERE project=? AND upload=? ORDER BY offset',
                                        (project, upload)))
            digest, offset = hashlib.sha256(), 0
            for start, size, data in rows:
                if start != offset or size != total:
                    raise Invalid('Missing or inconsistent chunks.', 409)
                digest.update(data)
                offset += len(data)
            if offset != total:
                raise Invalid('Object length mismatch.', 409)
            # Reject invalid text rather than changing the bytes during analysis.
            decoder = codecs.getincrementaldecoder('utf-8')('strict')
            try:
                for _, _, data in rows:
                    decoder.decode(data)
                decoder.decode(b'', final=True)
            except UnicodeError as error:
                raise Invalid('Source must be UTF-8.') from error
            object_id = digest.hexdigest()
            for start, size, data in rows:
                self.db.execute('INSERT OR IGNORE INTO blobs VALUES(?,?,?,?,?)',
                                (project, object_id, start, size, data))
            self.db.execute('INSERT OR IGNORE INTO bodies VALUES(?,?,?,?)',
                            (project, object_id, total, kind))
            if url is not None:
                self.db.execute(
                    'INSERT INTO object_urls(project,url,object_id,kind,updated) VALUES(?,?,?,?,?) '
                    'ON CONFLICT(project,url) DO UPDATE SET object_id=excluded.object_id, '
                    'kind=excluded.kind, updated=excluded.updated',
                    (project, url, object_id, kind, datetime.now(timezone.utc).isoformat()))
            self.db.execute('INSERT INTO upload_receipts VALUES(?,?,?,?,?,?)',
                            (project, upload, object_id, total, url, kind))
            self.db.execute('DELETE FROM uploads WHERE project=? AND upload=?', (project, upload))
        return dict(object_id=object_id, url=url, bytes=total, committed=True, durable=True)

    def event(self, project, envelope):
        if not isinstance(envelope, dict) or envelope.get('schema') != SCHEMA:
            raise Invalid('Invalid event envelope/schema.')
        if 'event_object_id' in envelope:
            identity = envelope['event_object_id']
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
        if len(raw) > EVENT_BYTES:
            raise Invalid('Event exceeds size budget.', 413)
        digest = sha(raw)
        value = strict_json(payload)
        if not isinstance(value, dict) or not isinstance(value.get('data'), dict):
            raise Invalid('Invalid event data.')
        for field in ['id', 'scan_id', 'kind', 'time', 'session_id', 'epoch', 'status']:
            if not isinstance(value.get(field), str) or not value[field] or len(value[field]) > 512:
                raise Invalid('Missing/invalid event identity.')
        category = value.get('category')
        if not isinstance(category, str) or category not in CATEGORIES:
            raise Invalid('Missing/invalid event category.')
        content = value.get('object_id')
        if content is not None:
            if not isinstance(content, str) or not HASH.fullmatch(content):
                raise Invalid('Invalid object ID.')
            obj = self.object_info(project, content)
            if not obj['committed']:
                raise Invalid('Event references an uncommitted object.', 409)
            if obj['bytes'] != value['data'].get('source_bytes'):
                raise Invalid('Event source length mismatch.')
        transport = value.get('transport')
        if transport is not None:
            if not isinstance(transport, dict) or set(transport) != {'stream_id', 'sequence'}:
                raise Invalid('Invalid delivery identity.')
            stream, sequence = transport['stream_id'], transport['sequence']
            if not isinstance(stream, str) or not UPLOAD.fullmatch(stream) or type(sequence) is not int or sequence < 1:
                raise Invalid('Invalid delivery sequence.')
        with self.lock, self.db:
            old = self.db.execute('SELECT digest FROM events WHERE project=? AND id=?', (project, value['id'])).fetchone()
            if old and old[0] != digest:
                raise Invalid('Event ID reused for different data.', 409)
            if transport is not None:
                stream_row = self.db.execute('SELECT scan,sealed FROM delivery_streams WHERE project=? AND stream=?',
                                             (project, stream)).fetchone()
                previous = self.db.execute('SELECT event_id FROM deliveries WHERE project=? AND stream=? AND sequence=?',
                                           (project, stream, sequence)).fetchone()
                if stream_row and stream_row[0] != value['scan_id']:
                    raise Invalid('Stream belongs to a different scan.', 409)
                if previous:
                    if previous[0] != value['id'] or not old:
                        raise Invalid('Conflicting delivery sequence.', 409)
                else:
                    if stream_row and stream_row[1]:
                        raise Invalid('Delivery stream is sealed.', 409)
                    last = self.db.execute('SELECT COALESCE(MAX(sequence),0) FROM deliveries WHERE project=? AND stream=?',
                                           (project, stream)).fetchone()[0]
                    if sequence != last + 1 or old:
                        raise Invalid('Delivery sequence must be contiguous.', 409)
                    if not stream_row:
                        self.db.execute('INSERT INTO delivery_streams VALUES(?,?,?,0)', (project, stream, value['scan_id']))
                    self.db.execute('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)',
                                    (project, stream, sequence, value['id'], category, len(raw), content))
            if not old:
                self.db.execute('INSERT INTO events(project,id,scan,payload,digest) VALUES(?,?,?,?,?)',
                                (project, value['id'], value['scan_id'], payload, digest))
        receipt = dict(schema=SCHEMA, event_id=value['id'], event_sha256=digest, object_id=content, durable=True)
        if transport is not None:
            receipt['transport'] = dict(stream_id=stream, sequence=sequence, event_bytes=len(raw))
        return receipt

    def seal(self, project, stream, expected):
        if not isinstance(expected, dict) or not isinstance(expected.get('scan_id'), str):
            raise Invalid('Invalid delivery manifest.')
        if type(expected.get('count')) is not int or expected['count'] < 1 or type(expected.get('bytes')) is not int:
            raise Invalid('Invalid delivery totals.')
        if not isinstance(expected.get('categories'), dict) or any(
            key not in CATEGORIES or type(count) is not int or count < 1
            for key, count in expected['categories'].items()
        ):
            raise Invalid('Invalid category totals.')
        with self.lock, self.db:
            row = self.db.execute('SELECT scan FROM delivery_streams WHERE project=? AND stream=?',
                                  (project, stream)).fetchone()
            if not row or row[0] != expected['scan_id']:
                raise Invalid('Unknown stream/scan.', 409)
            count, first, last, size = self.db.execute(
                'SELECT COUNT(*),MIN(sequence),MAX(sequence),COALESCE(SUM(bytes),0) FROM deliveries WHERE project=? AND stream=?',
                (project, stream)).fetchone()
            categories = dict(self.db.execute('SELECT category,COUNT(*) FROM deliveries WHERE project=? AND stream=? GROUP BY category',
                                              (project, stream)))
            missing = self.db.execute("""SELECT COUNT(*) FROM deliveries d LEFT JOIN bodies b
                ON b.project=d.project AND b.object_id=d.object_id
                LEFT JOIN events e ON e.project=d.project AND e.id=d.event_id
                WHERE d.project=? AND d.stream=? AND (e.id IS NULL OR (d.object_id IS NOT NULL AND b.object_id IS NULL))""",
                (project, stream)).fetchone()[0]
            if first != 1 or last != count or count != expected['count'] or size != expected['bytes'] or categories != expected['categories'] or missing:
                raise Invalid('Delivery manifest does not match durable events/objects.', 409)
            self.db.execute('UPDATE delivery_streams SET sealed=1 WHERE project=? AND stream=?', (project, stream))
        return dict(schema=SCHEMA, stream_id=stream, scan_id=row[0], count=count,
                    categories=categories, bytes=size, sealed=True, durable=True)

    def page(self, project, scan, after=0, limit=50, summary=False):
        if not 0 <= after or not 1 <= limit <= 100:
            raise Invalid('Invalid page.')
        with self.lock:
            rows, size = [], 0
            for row in self.db.execute('SELECT seq,payload FROM events WHERE project=? AND scan=? AND seq>? ORDER BY seq LIMIT ?',
                                       (project, scan, after, limit)):
                if rows and size + len(row[1]) > 4 * 1024 * 1024:
                    break
                rows.append(row)
                size += len(row[1])
            count = self.db.execute('SELECT count(*) FROM events WHERE project=? AND scan=?', (project, scan)).fetchone()[0]
            next_cursor = rows[-1][0] if rows else after
            more = bool(self.db.execute('SELECT 1 FROM events WHERE project=? AND scan=? AND seq>? LIMIT 1',
                                        (project, scan, next_cursor)).fetchone())
        events = [strict_json(r[1]) for r in rows]
        if summary:
            for item in events:
                data = item['data']
                item['data'] = {key: data[key] for key in ['url', 'document_url', 'source_bytes', 'network_match',
                                                          'observed_tab_url', 'target_id'] if key in data}
                if item['kind'] == 'ObservedRequest':
                    record = data.get('record', {})
                    item['data']['record'] = {key: record[key] for key in ['request_url', 'method', 'status_code',
                                                                          'request_id'] if key in record}
                item['summary_only'] = True
        return dict(events=events, count=count, next=next_cursor, has_more=more)

    def source_chunks(self, project, identity):
        offset = 0
        while True:
            with self.lock:
                row = self.db.execute('SELECT data FROM blobs WHERE project=? AND object_id=? AND offset=?',
                                      (project, identity, offset)).fetchone()
            if not row:
                return
            offset += len(row[0])
            yield row[0]


def make_server(directory, token=DEFAULT_CODE, project='default', host='127.0.0.1', port=0, origins=None, analyze=False):
    if len(token) < 16 or not PROJECT.fullmatch(project):
        raise ValueError('Use a token of at least 16 characters and a valid project ID.')
    store = Receiver(directory)
    if analyze:
        from .jobs import AnalysisJobs
        jobs = AnalysisJobs(store, directory)
    else:
        jobs = None

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
            self.send_header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Object-Bytes')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def handle_request(self):
            self.connection.settimeout(15)
            try:
                origin = self.headers.get('Origin')
                if self.command == 'GET' and self.path in {'/', '/health'}:
                    return self.reply(200, dict(status='ok', service='blackbox-receiver', project=project,
                                                schema=SCHEMA, capabilities=['delivery-ledger-1']))
                if origins is not None and origin and origin not in origins:
                    raise Invalid('Origin denied.', 403)
                if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    raise Invalid('Invalid token.', 401)
                parsed = urlsplit(self.path)
                seal_route = re.fullmatch(r'/v1/projects/([A-Za-z0-9_-]{1,64})/streams/([A-Za-z0-9_-]{8,64})/seal', parsed.path)
                if seal_route and seal_route[1] == project and self.command == 'POST':
                    receipt = store.seal(project, seal_route[2], strict_json(self.body(16 * 1024)))
                    if jobs: jobs.notify(project, receipt['scan_id'], immediate=True)
                    return self.reply(200, receipt)
                analysis_route = re.fullmatch(r'/v1/projects/([A-Za-z0-9_-]{1,64})/analyses(?:/([a-f0-9]{32})/result)?', parsed.path)
                if analysis_route and analysis_route[1] == project:
                    if not jobs: raise Invalid('Analysis worker is disabled.', 503)
                    if self.command == 'GET':
                        if analysis_route[2]: return self.reply(200, jobs.result(project, analysis_route[2]))
                        return self.reply(200, jobs.page(project, parse_qs(parsed.query).get('scan_id', [''])[0]))
                    if self.command == 'POST' and not analysis_route[2]:
                        command = strict_json(self.body(4096))
                        scan = command.get('scan_id') if isinstance(command, dict) else None
                        if not isinstance(scan, str) or not 0 < len(scan) <= 512: raise Invalid('Invalid scan.')
                        jobs.notify(project, scan, immediate=True)
                        return self.reply(202, dict(queued=True, scan_id=scan))
                    raise Invalid('Unsupported analysis method.', 405)
                match = re.fullmatch(
                    r'/v1/projects/([A-Za-z0-9_-]{1,64})/(events|objects/([a-f0-9]{64})|uploads/([A-Za-z0-9_-]{8,64})/(commit|chunks/([0-9]+)))',
                    parsed.path)
                if not match or match[1] != project:
                    raise Invalid('Unknown route/project.', 404)
                _, route, identity, upload, action, offset = match.groups()
                if route == 'events' and self.command == 'POST':
                    receipt = store.event(project, strict_json(self.body(8 * 1024 * 1024)))
                    if jobs:
                        with store.lock:
                            scan = store.db.execute('SELECT scan FROM events WHERE project=? AND id=?', (project, receipt['event_id'])).fetchone()[0]
                        jobs.notify(project, scan)
                    return self.reply(200, receipt)
                if route == 'events' and self.command == 'GET':
                    query = parse_qs(parsed.query)
                    return self.reply(200, store.page(project, query.get('scan_id', [''])[0],
                                                      int(query.get('after', ['0'])[0]),
                                                      int(query.get('limit', ['50'])[0]),
                                                      query.get('summary') == ['1']))
                if upload and action == 'commit' and self.command == 'POST':
                    value = strict_json(self.body(16 * 1024))
                    if not isinstance(value, dict):
                        raise Invalid('Invalid commit.')
                    return self.reply(200, store.commit(project, upload, value.get('bytes'),
                                                        value.get('url'), value.get('kind')))
                if upload and action.startswith('chunks/') and self.command == 'PUT':
                    return self.reply(200, store.chunk(project, upload, int(offset),
                                                       int(self.headers.get('X-Object-Bytes', '-1')),
                                                       self.body(CHUNK_BYTES)))
                if identity and self.command == 'GET':
                    if parsed.query == 'status':
                        return self.reply(200, store.object_info(project, identity))
                    info = store.object_info(project, identity)
                    if not info['committed']:
                        raise Invalid('Unknown object.', 404)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                    self.send_header('Content-Length', str(info['bytes']))
                    self.send_header('Cache-Control', 'no-store')
                    if origins is None or origin in origins:
                        self.send_header('Access-Control-Allow-Origin', '*' if origins is None else origin)
                    self.end_headers()
                    for data in store.source_chunks(project, identity):
                        self.wfile.write(data)
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
    server.jobs = jobs
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description='Blackbox receiver: run without arguments; plugin only needs this server address.')
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[2] / 'data' / 'capture')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8379)
    parser.add_argument('--no-analysis', action='store_true', help='Receive only; disable the automatic offline analysis worker.')
    args = parser.parse_args(argv)
    server = make_server(args.data_dir, host=args.host, port=args.port, analyze=not args.no_analysis)
    print(json.dumps(dict(url=f'http://{args.host}:{server.server_port}', project='default')), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if server.jobs: server.jobs.close()
        server.store.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())