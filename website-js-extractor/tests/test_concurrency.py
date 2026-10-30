"""HTTP integration checks for concurrent quotas, shared responses, and recovery."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from website_js_extractor.acquisition import FetchError, StaticFetcher
from website_js_extractor.assets import Snapshot
from website_js_extractor.collection import ReferenceGraph, restore_snapshot
from website_js_extractor.engine import default_engine_root


class ConcurrencyTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.traffic = []
        self.routes = {}
        self.release = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.traffic.append(self.path)
                route = owner.routes.get(self.path, {})
                if route.get('header_wait'):
                    owner.release.wait(2)
                self.send_response(route.get('status', 200))
                self.send_header('Content-Type', 'application/javascript')
                if 'redirect' in route:
                    self.send_header('Location', route['redirect'])
                body = route.get('body', b'void 0;')
                if not route.get('unknown_length'):
                    self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if route.get('body_wait'):
                    self.wfile.flush()
                    owner.release.wait(2)
                if route.get('barrier'):
                    route['barrier'].wait(timeout=3)
                time.sleep(route.get('delay', 0))
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.base = f'http://127.0.0.1:{server.server_port}'
        def close():
            self.release.set()
            server.shutdown()
            server.server_close()
            thread.join(3)
        self.addCleanup(close)

    def fetcher(self, **kwargs):
        return StaticFetcher([self.base], **kwargs)

    def collect(self, fetcher, count=8):
        def get(i):
            try:
                return fetcher.get(self.base+f'/{i}.js', 1024)
            except FetchError as error:
                return error.kind
        with ThreadPoolExecutor(max_workers=count) as pool:
            return list(pool.map(get, range(count)))

    def assert_drained(self, fetcher):
        stats = fetcher.statistics()
        self.assertEqual(stats['reserved_bytes'], 0)
        self.assertEqual(stats['active_requests'], 0)
        if stats['body_byte_limit'] is not None:
            self.assertLessEqual(stats['peak_charged_and_reserved'], stats['body_byte_limit'])

    def test_file_quota_is_atomic_and_failed_url_is_cached(self):
        fetcher = self.fetcher(max_files=3)
        results = self.collect(fetcher)
        self.assertEqual(sum(isinstance(r, dict) for r in results), 3)
        self.assertEqual(len(self.traffic), 3)
        self.assertEqual(fetcher.file_attempts, 3)
        self.assert_drained(fetcher)
        self.routes['/bad.js'] = {'body': b'x'*30}
        fetcher = self.fetcher(max_files=2)
        for _ in range(2):
            with self.assertRaises(FetchError):
                fetcher.get(self.base+'/bad.js', 8)
        self.assertEqual(self.traffic.count('/bad.js'), 1)
        self.assertEqual(fetcher.file_attempts, 1)

    def test_parallel_byte_budget_never_overshoots(self):
        barrier = threading.Barrier(2)
        self.routes.update({f'/{i}.js': {'body': b'x'*64, 'barrier': barrier} for i in range(2)})
        fetcher = self.fetcher()
        fetcher.configure_budget(127)
        results = self.collect(fetcher, 2)
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        self.assertIn('fetch_byte_budget', results)
        self.assertEqual(fetcher.bytes, 127)
        self.assertEqual(fetcher.statistics()['peak_active_requests'], 2)
        self.assert_drained(fetcher)

    def test_unknown_length_refunds_read_reservations(self):
        self.routes.update({f'/{i}.js': {'unknown_length': True, 'body': b'x'*10} for i in range(6)})
        fetcher = self.fetcher()
        fetcher.configure_budget(100)
        self.assertTrue(all(isinstance(r, dict) for r in self.collect(fetcher, 6)))
        self.assertEqual(fetcher.bytes, 60)
        self.assert_drained(fetcher)
        fetcher = self.fetcher()
        fetcher.configure_budget(10)
        with self.assertRaises(FetchError) as caught:
            fetcher.get(self.base+'/0.js', 100)
        self.assertEqual(caught.exception.kind, 'fetch_byte_budget')
        self.assertEqual(fetcher.files, 0)
        self.assert_drained(fetcher)

    def test_redirect_aliases_share_final_response_but_contexts_do_not(self):
        self.routes.update({'/a.js': {'status': 302, 'redirect': '/final.js'},
                            '/b.js': {'status': 302, 'redirect': '/final.js'},
                            '/final.js': {'delay': .05}})
        fetcher = self.fetcher()
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda name: fetcher.get(self.base+'/'+name, 100, context_id='p'),
                                    ['a.js', 'b.js', 'final.js']))
        self.assertEqual(self.traffic.count('/final.js'), 1)
        self.assertTrue(all(r['url'] == self.base+'/final.js' for r in results))
        fetcher.get(self.base+'/final.js', 100, context_id='other')
        self.assertEqual(self.traffic.count('/final.js'), 2)
        self.assert_drained(fetcher)

    def test_redirect_cycle_does_not_deadlock(self):
        self.routes.update({'/0.js': {'status': 302, 'redirect': '/1.js'},
                            '/1.js': {'status': 302, 'redirect': '/0.js'}})
        fetcher = self.fetcher(deadline=2)
        self.assertEqual(self.collect(fetcher, 2), ['redirect_limit', 'redirect_limit'])
        self.assertCountEqual(self.traffic, ['/0.js', '/1.js'])
        self.assert_drained(fetcher)

    def test_cancel_interrupts_body_and_never_accepts_truncated_response(self):
        self.routes['/slow.js'] = {'body_wait': True, 'unknown_length': True}
        fetcher = self.fetcher(timeout=3)
        fetcher.configure_budget(1024)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(fetcher.get, self.base+'/slow.js', 1024)
            end = time.monotonic()+2
            while not fetcher.statistics()['reserved_bytes'] and time.monotonic() < end:
                time.sleep(.005)
            self.assertGreater(fetcher.statistics()['reserved_bytes'], 0)
            fetcher.cancel()
            with self.assertRaises(FetchError) as caught:
                future.result(timeout=1)
            self.assertEqual(caught.exception.kind, 'fetch_cancelled')
        self.assertEqual(fetcher.files, 0)
        self.assert_drained(fetcher)

    def test_header_wait_is_bounded_by_remaining_deadline(self):
        self.routes['/slow.js'] = {'header_wait': True}
        fetcher = self.fetcher(timeout=3, deadline=.15, retries=0)
        start = time.monotonic()
        with self.assertRaises(FetchError) as caught:
            fetcher.get(self.base+'/slow.js', 1024)
        self.assertEqual(caught.exception.kind, 'fetch_deadline')
        self.assertLess(time.monotonic()-start, 1)
        self.assert_drained(fetcher)

    def seed(self, output, count=8):
        snapshot = Snapshot(output)
        snapshot.add(''.join(f'<script src="/{i}.js"></script>' for i in range(count)).encode(),
                     location=self.base+'/', url=self.base+'/', page_url=self.base+'/', kind='html')
        return snapshot

    def test_graph_parallelism_semantics_and_partial_checkpoint_recovery(self):
        self.routes.update({f'/{i}.js': {'delay': .02, 'body': b"import './shared.js'; fetch('/api/never');"} for i in range(12)})
        serial = self.seed(self.root/'serial', 12)
        fetcher = self.fetcher()
        ReferenceGraph(serial, default_engine_root(), concurrency=1).run(fetcher)
        self.assertEqual(fetcher.statistics()['peak_active_requests'], 1)
        parallel = self.seed(self.root/'parallel', 12)
        fetcher = self.fetcher()
        ReferenceGraph(parallel, default_engine_root(), concurrency=4).run(fetcher)
        self.assertGreater(fetcher.statistics()['peak_active_requests'], 1)
        self.assertLessEqual(fetcher.statistics()['peak_active_requests'], 4)
        def semantics(snapshot):
            return sorted((e['target_url'], e['child_depth'], e['status']) for e in snapshot.reference_edges)
        self.assertEqual(semantics(serial), semantics(parallel))
        self.assertEqual(self.traffic.count('/shared.js'), 2)
        partial = self.seed(self.root/'partial', 12)
        ReferenceGraph(partial, default_engine_root(), concurrency=4).run(self.fetcher(max_files=3))
        checkpoint = self.root/'partial/collection.json'
        data = json.loads(checkpoint.read_text())
        self.assertEqual(data['fetch_statistics']['file_attempts'], 3)
        # Backward-compatible restore of the body/checkpoint layout.
        data['schema_version'] = '0.2'
        checkpoint.write_text(json.dumps(data))
        restored = Snapshot(self.root/'restored')
        restore_snapshot(restored, checkpoint.parent)
        completed = {a['url'] for a in restored.assets if a['kind'] == 'js'}
        self.traffic.clear()
        ReferenceGraph(restored, default_engine_root(), concurrency=4).run(self.fetcher())
        self.assertEqual(semantics(serial), semantics(restored))
        self.assertTrue(all(self.base+path not in completed for path in self.traffic))
        self.assertFalse(any(path.startswith('/api/') for path in self.traffic))
        self.assertEqual(len(self.traffic), 10)

    def test_wave_timeout_drains_workers_and_checkpoints_completed_bodies(self):
        self.routes['/1.js'] = {'body_wait': True}
        snapshot = self.seed(self.root/'timeout', 2)
        fetcher = self.fetcher(deadline=.25, timeout=2)
        ReferenceGraph(snapshot, default_engine_root(), concurrency=2, timeout=2).run(fetcher)
        self.assert_drained(fetcher)
        checkpoint = json.loads((snapshot.output/'collection.json').read_text())
        self.assertEqual(checkpoint['fetch_statistics']['active_requests'], 0)
        self.assertEqual({a['url'] for a in snapshot.assets if a['kind']=='js'}, {self.base+'/0.js'})
        completed = next(e for e in snapshot.reference_edges if e['target_url']==self.base+'/0.js')
        self.assertEqual(completed['status'], 'available')
        self.assertTrue(any(g['incomplete'] for g in snapshot.gaps))
        self.assertTrue(all(event.get('finished_at') for event in checkpoint['fetch_events']))

    def test_empty_remaining_budget_never_starts_http_or_spends_file_quota(self):
        fetcher = self.fetcher()
        fetcher.configure_budget(0)
        self.assertEqual(self.collect(fetcher), ['fetch_byte_budget']*8)
        self.assertEqual(self.traffic, [])
        self.assertEqual(fetcher.file_attempts, 0)
        self.assert_drained(fetcher)
