import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from website_js_extractor.receiver import make_server, DEFAULT_CODE
from test_stream import context, script, upload, SOURCE, SCAN, envelope


class AutomaticAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = make_server(self.root, analyze=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.jobs.close()
        self.thread.join()
        self.server.store.close()

    def request(self, method, path, value=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        conn.request(method, '/v1/projects/default'+path, json.dumps(value) if value is not None else None,
                     {'Authorization': 'Bearer '+DEFAULT_CODE, 'Content-Type': 'application/json'})
        response = conn.getresponse()
        status, value = response.status, json.loads(response.read())
        conn.close()
        self.assertLess(status, 400, value)
        return value

    def test_actual_http_capture_automatically_analyzes_a_fixed_input_and_queries_results(self):
        identity = upload(self.server.store, SOURCE)
        self.request('POST', '/events', envelope(context('ctx', 1, 'https://app.example.test/home')))
        self.request('POST', '/events', envelope(script('script', identity, 'https://app.example.test/assets/app.js')))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            page = self.request('GET', '/analyses?scan_id='+SCAN)
            if page['jobs'] and page['jobs'][0]['status'] != 'running': break
            time.sleep(.1)
        self.assertTrue(page['jobs'], page)
        latest = page['jobs'][0]
        self.assertIn(latest['status'], {'completed', 'completed_with_gaps', 'partial'}, latest)
        report = self.request('GET', '/analyses/'+latest['id']+'/result')['result']
        self.assertEqual(report['task']['input_type'], 'capture-stream-2')
        self.assertGreater(len(report['api_inventory']), 0)
        self.assertTrue(any('/api/users' in row['path_template'] for row in report['api_inventory']))
        self.assertFalse((self.root/'analysis'/latest['id']/'input/capture.sqlite3').exists())
        self.assertTrue((self.root/'analysis'/latest['id']/'manifest.json').is_file())
