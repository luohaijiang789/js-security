import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from website_js_extractor.cli import main
from website_js_extractor.domain.settings import AnalysisSettings
from website_js_extractor.ingestion import stream
from website_js_extractor.storage.capture_store import Receiver
from test_stream import context, script, scan_event, event, envelope, upload, SCAN


class RecursivePipelineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Receiver(self.root/'data'); self.addCleanup(self.store.close)
        self.traffic, self.routes = [], {}
        self.base = self.site(self.routes, self.traffic)

    def site(self, routes, traffic):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                traffic.append(self.path)
                value = routes.get(self.path)
                body = (value or '').encode()
                self.send_response(200 if value is not None else 404)
                self.send_header('Content-Type', 'application/javascript')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers(); self.wfile.write(body)
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def close(): server.shutdown(); server.server_close(); thread.join()
        self.addCleanup(close)
        return f'http://127.0.0.1:{server.server_port}'

    def seed(self, source, policy=None):
        started = scan_event(); started['data']['scan']['config'] = {'analysis': policy or {}}
        self.store.event('default', envelope(started))
        self.store.event('default', envelope(context('ctx', 1, self.base+'/', origin=self.base)))
        identity = upload(self.store, source.encode())
        observed = script('source', identity, self.base+'/main.js', page_url=self.base+'/')
        observed['data']['source_bytes'] = len(source.encode())
        self.store.event('default', envelope(observed))

    def run_ingest(self):
        output = self.root/'output'
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = main(['ingest','--data-dir',str(self.root/'data'),'--scan',SCAN,'--out',str(output)])
        return code, json.loads((output/'analysis.json').read_text()), output

    def test_default_five_layers_finish_before_unified_analysis_and_never_probe_apis(self):
        self.seed("import './l2.js'; fetch('/api/seed');")
        for depth in range(2, 6):
            self.routes[f'/l{depth}.js'] = f"import './l{depth+1}.js'; fetch('/api/layer{depth}');"
        self.routes['/l4.js'] += " import './l2.js';"  # cycle and multiple parents
        self.routes['/l6.js'] = "fetch('/api/must-not-fetch');"
        actual = stream.analyze
        def analyze(snapshot, engine, timeout):
            manifest = json.loads((snapshot.output/'analysis-manifest.json').read_text())
            self.assertEqual(manifest['stage'], 'frozen')
            self.assertEqual(sorted(a['depth'] for a in manifest['assets']), [1,2,3,4,5])
            return actual(snapshot, engine, timeout)
        with patch.object(stream, 'analyze', side_effect=analyze) as analyze_spy:
            code, report, output = self.run_ingest()
        self.assertEqual(code, 4)  # layer 6 is an explicit remaining gap
        self.assertEqual(analyze_spy.call_count, 1)
        self.assertEqual(self.traffic, ['/l2.js','/l3.js','/l4.js','/l5.js'])
        self.assertTrue(any('/api/layer5' in item['url'] for item in report['candidates']))
        self.assertEqual(report['task']['settings']['max_js_depth'], 5)
        self.assertEqual(report['collection_summary']['status'], 'partial')
        self.assertTrue(any(edge['status']=='depth_limit' for edge in report['reference_edges']))
        self.assertTrue((output/'analysis-manifest.json').is_file())
        self.assertEqual(report['observed_requests'], [])

    def test_task_depth_override_stops_at_second_layer(self):
        self.seed("import './l2.js';", {'max_js_depth': 2})
        self.routes['/l2.js'] = "import './l3.js'; fetch('/api/two');"
        self.routes['/l3.js'] = "fetch('/api/three');"
        _, report, _ = self.run_ingest()
        self.assertEqual(self.traffic, ['/l2.js'])
        self.assertEqual(len(report['assets']), 2)
        self.assertEqual(report['task']['settings']['max_js_depth'], 2)

    def test_explicit_cdn_dependency_is_downloaded_and_analyzed(self):
        traffic = []
        cdn = self.site({'/sdk.js': "export function report(){ fetch('/api/sdk'); }"}, traffic)
        self.seed(f"import '{cdn}/sdk.js';", {'allowed_origins': [cdn]})
        _, report, _ = self.run_ingest()
        self.assertEqual(traffic, ['/sdk.js'])
        self.assertEqual(len(report['assets']), 2)
        self.assertTrue(any('/api/sdk' in item['url'] for item in report['candidates']))
        self.assertTrue(any(item.get('acquisition')=='static-supplement' for item in report['assets']))

    def test_offline_policy_keeps_missing_dependencies_explicit(self):
        self.seed("import './l2.js'; fetch('/api/seed');", {'fetch_js': False})
        _, report, _ = self.run_ingest()
        self.assertEqual(self.traffic, [])
        self.assertTrue(any(edge['status']=='missing_offline' for edge in report['reference_edges']))
        self.assertEqual(report['collection_summary']['status'], 'partial')

    def test_policy_rejects_invalid_depths_and_origin_credentials(self):
        self.assertEqual(AnalysisSettings.parse().max_js_depth, 5)
        for value in [{'max_js_depth': True}, {'max_js_depth': 0}, {'max_js_depth': 33},
                      {'allowed_origins':['https://user:secret@cdn.test']}, {'allowed_origins':['https://cdn.test/path']},
                      {'fetch_timeout': float('nan')}, {'unknown': 1}]:
            with self.subTest(value=value), self.assertRaises(ValueError): AnalysisSettings.parse(value)
