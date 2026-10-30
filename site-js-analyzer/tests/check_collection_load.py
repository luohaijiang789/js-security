"""Bounded local wide-graph / frozen public-body checks; no API probes.

This records application-body costs and process RSS high-water marks, not NIC
traffic or a production benchmark. Raw bodies/reports stay under ignored work/.
"""
from collections import Counter
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import resource
import threading
import time
import uuid

from site_js_analyzer.acquisition import StaticFetcher
from site_js_analyzer.assets import Snapshot
from site_js_analyzer.collection import ReferenceGraph, restore_snapshot
from site_js_analyzer.engine import default_engine_root

ROOT = Path(__file__).resolve().parents[2]


def main():
    public_manifest = json.loads((ROOT/'references/blackbox2-experiment/public-sample.json').read_text())
    public = (ROOT/'work/blackbox2-tools/public-swagger-ui/swagger-ui-bundle.js').read_bytes()
    assert hashlib.sha256(public).hexdigest() == public_manifest['sha256'], 'Frozen public input hash mismatch'
    output = ROOT/'work'/('site-collection-load-'+uuid.uuid4().hex[:10])
    output.mkdir()
    traffic, files = [], {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            traffic.append(self.path)
            body = files.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body or b'')))
            self.end_headers()
            time.sleep(.01)
            self.wfile.write(body or b'')
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    runs = []

    def seed(name, count):
        snapshot = Snapshot(output/name, max_total_bytes=64*1024*1024)
        snapshot.add(''.join(f'<script src="/{i}.js"></script>' for i in range(count)).encode(),
                     location=base+'/', url=base+'/', page_url=base+'/', kind='html')
        return snapshot

    def run(name, snapshot, concurrency, expected_requests, max_files=200):
        traffic.clear()
        fetcher = StaticFetcher([base], max_files=max_files, deadline=180)
        start = time.monotonic()
        ReferenceGraph(snapshot, default_engine_root(), concurrency=concurrency, timeout=180).run(fetcher)
        elapsed = time.monotonic()-start
        stats = fetcher.statistics()
        if isinstance(expected_requests, int):
            assert len(traffic) == len(set(traffic)) == expected_requests, (name, traffic)
        else:
            assert Counter(traffic) == Counter(expected_requests), (name, traffic)
        assert all(path in files for path in traffic), 'Unexpected resource/API probe'
        assert stats['file_attempts'] == len(traffic)
        assert stats['body_bytes_observed'] == sum(len(files[path]) for path in traffic)
        assert stats['body_bytes_charged'] == stats['body_bytes_observed']
        assert stats['peak_charged_and_reserved'] <= stats['body_byte_limit']
        assert stats['reserved_bytes'] == stats['active_requests'] == 0
        assert stats['peak_active_requests'] <= concurrency
        semantics = sorted(((e['parent_asset_id'], e['kind'], e['target'], e['target_url'], e['child_depth'], e['status'])
                            for e in snapshot.reference_edges), key=repr)
        runs.append(dict(name=name, concurrency=concurrency, seconds=round(elapsed, 3),
                         assets=len(snapshot.assets), edges=len(semantics), fetch_statistics=stats,
                         traffic=list(traffic), incomplete=any(g['incomplete'] for g in snapshot.gaps),
                         rss_high_water_kib=dict(python=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                                                 child_process=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)))
        return semantics

    try:
        count = 128
        files.update({f'/{i}.js': b"import './shared.js'; fetch('/api/never');" for i in range(count)})
        files['/shared.js'] = b"import './0.js';"
        expected = list(files)
        serial = run('wide-serial', seed('wide-serial', count), 1, expected)
        parallel = run('wide-parallel', seed('wide-parallel', count), 4, expected)
        assert serial == parallel
        assert runs[-1]['fetch_statistics']['peak_active_requests'] > 1
        partial = seed('wide-partial', count)
        run('wide-partial', partial, 4, 8, max_files=8)
        missing = sorted(set(expected)-set(runs[-1]['traffic']))
        restored = Snapshot(output/'wide-restored', max_total_bytes=64*1024*1024)
        restore_snapshot(restored, partial.output)
        assert run('wide-restored', restored, 4, missing) == serial
        # Identical frozen bundle bodies at multiple URLs exercise transport/asset
        # costs separately from AST hash-cache reuse. This is a derived fixture.
        count = 16
        files.clear()
        body = public+b"\nimport './shared.js';\n"
        files.update({f'/{i}.js': body for i in range(count)})
        files['/shared.js'] = b'void 0;'
        serial = run('large-serial', seed('large-serial', count), 1, list(files))
        assert run('large-parallel', seed('large-parallel', count), 4, list(files)) == serial
        assert runs[-1]['fetch_statistics']['peak_active_requests'] > 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
    summary = dict(time=datetime.now(timezone.utc).isoformat(), public_sha256=public_manifest['sha256'],
                   public_bytes=len(public), derived_body_sha256=hashlib.sha256(body).hexdigest(),
                   derived_body_bytes=len(body), runs=runs,
                   limitations='Local collection-only compatibility and budget check; repeated body with AST cache reuse; RSS is Linux process high-water KiB, not incremental allocation or full process-tree memory; no recall or production throughput claim.')
    (output/'verification.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(dict(output=str(output), results=[{k:v for k,v in r.items() if k!='traffic'} for r in runs]), indent=2))


if __name__ == '__main__':
    main()
