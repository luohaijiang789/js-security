"""HTTP adapters only. Durable storage and background jobs own their lifecycles."""
import argparse
import hmac
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from website_js_extractor.domain.protocol import SCHEMA, DEFAULT_CODE, CHUNK_BYTES, PROJECT, Invalid, strict_json
from website_js_extractor.storage.capture_store import Receiver


def make_server(directory, token=DEFAULT_CODE, project='default', host='127.0.0.1', port=0, origins=None, analyze=False):
    if len(token) < 16 or not PROJECT.fullmatch(project):
        raise ValueError('Use a token of at least 16 characters and a valid project ID.')
    store = Receiver(directory)
    if analyze:
        from website_js_extractor.application.jobs import AnalysisJobs
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
            self.send_header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Object-Bytes,X-Chunk-SHA256')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def handle_request(self):
            self.connection.settimeout(15)
            try:
                origin = self.headers.get('Origin')
                if self.command == 'GET' and self.path in {'/', '/health'}:
                    return self.reply(200, dict(status='ok', service='blackbox-receiver', project=project,
                                                schema=SCHEMA, capabilities=['delivery-ledger-1', 'content-integrity-1', 'recursive-analysis-1']))
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
                                                        value.get('url'), value.get('kind'), value.get('expected_sha256')))
                if upload and action.startswith('chunks/') and self.command == 'PUT':
                    return self.reply(200, store.chunk(project, upload, int(offset),
                                                       int(self.headers.get('X-Object-Bytes', '-1')),
                                                       self.body(CHUNK_BYTES), self.headers.get('X-Chunk-SHA256')))
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
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[3] / 'data' / 'capture')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8379)
    parser.add_argument('--no-analysis', action='store_true', help='Receive only; disable the automatic collection and analysis worker.')
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