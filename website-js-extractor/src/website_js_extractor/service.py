"""Paired loopback HTTP prototype. Analysis is always offline in a child process."""
from concurrent.futures import ThreadPoolExecutor
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import uuid

from .assets import digest
from .capture import MAX_UPLOAD_BYTES, validate_capture
from .engine import verify_engine


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


class Jobs:
    def __init__(self, directory, engine_root):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.engine_root = Path(engine_root).resolve()
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='offline-analysis')
        self.records, self.cancels = {}, {}
        self.closed = False
        for path in self.directory.glob('*/job.json'):
            record = json.loads(path.read_text())
            if not re.fullmatch(r'[a-f0-9]{32}', record.get('id', '')) or path.parent.name != record['id']:
                raise ValueError('Invalid persisted job identity.')
            if record['status'] in {'queued', 'running'}:
                record.update(status='interrupted', error='Service restarted; submit a new snapshot identity to retry.')
                atomic_json(path, record)
            self.records[record['id']] = record

    def get(self, identity):
        with self.lock:
            if identity not in self.records:
                raise KeyError('Unknown analysis job.')
            return dict(self.records[identity])

    def submit(self, value):
        validate_capture(value)
        fingerprint = digest(value)
        with self.lock:
            if self.closed:
                raise ValueError('Service is closing.')
            for record in self.records.values():
                if record['snapshot_id'] == value['snapshot_id']:
                    if record['input_sha256'] != fingerprint:
                        raise ValueError('Snapshot identity conflict: immutable input has changed.')
                    return dict(record)
            if len(self.records) >= 20:
                raise ValueError('Prototype retains at most 20 jobs; archive the data directory before starting another service directory.')
            identity = uuid.uuid4().hex
            path = self.directory/identity
            path.mkdir()
            atomic_json(path/'input.json', value)
            record = dict(id=identity, snapshot_id=value['snapshot_id'], input_sha256=fingerprint,
                          status='queued', error=None, exit_code=None)
            atomic_json(path/'job.json', record)
            self.records[identity] = record
            self.cancels[identity] = threading.Event()
            self.pool.submit(self.run, identity)
            return dict(record)

    def update(self, identity, **values):
        with self.lock:
            self.records[identity].update(values)
            atomic_json(self.directory/identity/'job.json', self.records[identity])

    @staticmethod
    def terminate(process):
        if process.poll() is not None:
            return
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
        process.wait(timeout=10)

    def run(self, identity):
        cancel = self.cancels[identity]
        path = self.directory/identity
        process = None
        try:
            if cancel.is_set():
                self.update(identity, status='cancelled')
                return
            self.update(identity, status='running')
            command = [sys.executable, '-m', 'website_js_extractor', 'analyze', '--capture', str(path/'input.json'),
                       '--out', str(path/'result'), '--engine-root', str(self.engine_root),
                       '--timeout', '120', '--discovery-timeout', '40']
            # No --fetch-js, URLs, session headers or user-provided arguments.
            with (path/'analysis.log').open('w') as log:
                process = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=os.name == 'posix',
                                           env=dict(os.environ, WEBSITE_JS_MANAGED_JOB='1'))
                end = time.monotonic()+180
                while process.poll() is None:
                    if cancel.wait(.05) or time.monotonic() >= end:
                        self.terminate(process)
                        self.update(identity, status='cancelled' if cancel.is_set() else 'failed', error='Cancelled or total analysis deadline reached.')
                        return
                self.update(identity, exit_code=process.returncode,
                            status='completed' if process.returncode == 0 else 'partial' if process.returncode == 4 else 'failed',
                            error=None if process.returncode in {0, 4} else 'Analysis failed; inspect the local job log.')
        except Exception as error:
            if process is not None:
                self.terminate(process)
            self.update(identity, status='failed', error=type(error).__name__)

    def cancel(self, identity):
        with self.lock:
            record = self.get(identity)
            if identity in self.cancels and record['status'] in {'queued', 'running'}:
                self.cancels[identity].set()
            return record

    def result(self, identity):
        record = self.get(identity)
        if record['status'] not in {'completed', 'partial'}:
            raise ValueError('Analysis result is not ready.')
        path = self.directory/identity/'result/analysis.json'
        if path.stat().st_size > 64*1024*1024:
            raise ValueError('Result exceeds prototype HTTP budget; inspect the local result file.')
        return json.loads(path.read_text())

    def close(self):
        with self.lock:
            self.closed = True
            for event in self.cancels.values():
                event.set()
        self.pool.shutdown(wait=True)


def make_server(port, jobs, extension_id, token):
    if not re.fullmatch(r'[a-p]{32}', extension_id) or not 0 <= port <= 65535:
        raise ValueError('Expected a Chrome extension ID (32 letters a–p) and valid loopback port.')
    allowed = 'chrome-extension://'+extension_id

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass  # Never log pairing headers or uploaded code.

        def respond(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            if self.headers.get('Origin') == allowed:
                self.send_header('Access-Control-Allow-Origin', allowed)
            self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def trusted_origin(self):
            return self.headers.get('Origin') == allowed and self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_OPTIONS(self):
            if not self.trusted_origin():
                self.respond(403, {'error':'Origin or loopback host is not allowed.'})
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', allowed)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Max-Age', '60')
            self.end_headers()

        def dispatch(self):
            if not self.trusted_origin() or not hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'), ('Bearer '+token).encode('utf-8')):
                self.respond(403, {'error':'Extension origin or pairing key was rejected.'})
                return
            parts = self.path.strip('/').split('/')
            try:
                if self.command == 'GET' and self.path == '/v0/capabilities':
                    self.respond(200, dict(protocol='capture-0.1', result_schema='0.5', max_upload_bytes=MAX_UPLOAD_BYTES, offline_only=True))
                    return
                if self.command == 'POST' and self.path == '/v0/jobs':
                    if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                        raise ValueError('Expected bounded JSON with Content-Length.')
                    length = int(self.headers.get('Content-Length', '-1'))
                    if not 0 < length <= MAX_UPLOAD_BYTES:
                        self.respond(413, {'error':'Snapshot exceeds the upload budget.'})
                        return
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError('Incomplete upload.')
                    self.respond(202, jobs.submit(json.loads(body)))
                    return
                if len(parts) in {3, 4} and parts[:2] == ['v0','jobs'] and re.fullmatch(r'[a-f0-9]{32}', parts[2]):
                    identity = parts[2]
                    if self.command == 'GET' and len(parts) == 3:
                        self.respond(200, jobs.get(identity)); return
                    if self.command == 'GET' and parts[3:] == ['result']:
                        self.respond(200, jobs.result(identity)); return
                    if self.command == 'POST' and parts[3:] == ['cancel']:
                        self.respond(202, jobs.cancel(identity)); return
                self.respond(404, {'error':'Unknown prototype route.'})
            except KeyError:
                self.respond(404, {'error':'Unknown analysis job.'})
            except (ValueError, UnicodeError, RecursionError) as error:
                self.respond(400, {'error':str(error)})
            except (OSError, TypeError):
                self.respond(500, {'error':'Local job storage failed; input was not accepted as complete.'})

        do_GET = dispatch
        do_POST = dispatch

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server


def serve(args):
    jobs = None
    try:
        engine = verify_engine(args.engine_root)
        jobs = Jobs(args.data_dir, engine)
        token = secrets.token_urlsafe(32)
        server = make_server(args.port, jobs, args.extension_id, token)
        print(f'Local analysis: http://127.0.0.1:{server.server_port}\nPairing key: {token}', flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            jobs.close()
        return 0
    except (ValueError, OSError, RuntimeError) as error:
        if jobs:
            jobs.close()
        print(str(error), file=sys.stderr)
        return 2
