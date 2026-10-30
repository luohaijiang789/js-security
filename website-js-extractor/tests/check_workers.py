"""Hash-frozen MDN Worker example, offline association, and controlled GET recovery."""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import uuid
from urllib.request import urlopen

from website_js_extractor.acquisition import StaticFetcher
from website_js_extractor.assets import Snapshot
from website_js_extractor.collection import ReferenceGraph, restore_snapshot
from website_js_extractor.engine import default_engine_root

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true', help='Download the pinned public fixture through inherited proxy/TLS settings.')
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name('worker-manifest.json').read_text())
    source = ROOT/'work/blackbox2-tools/public-workers'
    bodies = {}
    for case in manifest['files']:
        if args.prepare:
            url = 'https://raw.githubusercontent.com/mdn/dom-examples/'+manifest['commit']+'/'+case['path']
            with urlopen(url, timeout=20) as response:
                body = response.read(1024*1024+1)
            assert hashlib.sha256(body).hexdigest() == case['sha256'], 'Downloaded Worker fixture hash mismatch'
            source.mkdir(parents=True, exist_ok=True)
            (source/case['local']).write_bytes(body)
        body = (source/case['local']).read_bytes()
        assert hashlib.sha256(body).hexdigest() == case['sha256'], 'Frozen Worker fixture mismatch'
        assert len(body) == case['bytes']
        bodies[case['local']] = body
    output = ROOT/'work'/('site-worker-check-'+uuid.uuid4().hex[:10])
    traffic = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            traffic.append(self.path)
            assert self.path == '/demo/worker.js', 'Unexpected static-resource/API request'
            body = bodies['worker.js']
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}/demo/'
    runs = []
    def seed(name, include_worker=False):
        snapshot = Snapshot(output/name)
        snapshot.add(b'<script src="main.js"></script>', location=base, url=base, page_url=base, kind='html')
        snapshot.add(bodies['main.js'], location=base+'main.js', url=base+'main.js', page_url=base, kind='js')
        if include_worker:
            snapshot.add(bodies['worker.js'], location=base+'worker.js', url=base+'worker.js', page_url=base, kind='js')
        return snapshot
    def run(name, snapshot, online=False):
        traffic.clear()
        fetcher = StaticFetcher([base.split('/demo/')[0]]) if online else None
        graph = ReferenceGraph(snapshot, default_engine_root())
        graph.run(fetcher)
        edges = [e for e in graph.edges if e['kind']=='worker']
        assert len(edges)==1 and edges[0]['target']==manifest['expected_worker_target']
        runs.append(dict(name=name, traffic=list(traffic), assets=len(snapshot.assets), contexts=snapshot.contexts,
                         worker_edge=edges[0], fetch_statistics=getattr(snapshot,'fetch_statistics',None)))
        return edges[0]
    try:
        edge = run('offline-missing', seed('offline-missing'))
        assert edge['status']=='missing_offline' and not traffic
        edge = run('offline-associated', seed('offline-associated', True))
        assert edge['status']=='available' and not traffic
        online = seed('online')
        edge = run('online', online, True)
        assert edge['status']=='available' and traffic==['/demo/worker.js']
        worker = next(c for c in online.contexts if c['type']=='dedicated_worker')
        assert worker['request_base_url']==base+'worker.js'
        restored = Snapshot(output/'restored')
        restore_snapshot(restored, online.output)
        edge = run('restored', restored, True)
        assert edge['status']=='available' and not traffic
        assert online.contexts == restored.contexts
    finally:
        server.shutdown(); server.server_close(); thread.join(3)
    verification = dict(time=datetime.now(timezone.utc).isoformat(), fixture=manifest, runs=runs)
    (output/'verification.json').write_text(json.dumps(verification,indent=2))
    print(json.dumps(dict(output=str(output),runs=runs),indent=2))


if __name__ == '__main__':
    main()
