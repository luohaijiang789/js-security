import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid

from website_js_extractor.cli import main
from website_js_extractor.domain.protocol import CHUNK_BYTES, SCHEMA
from website_js_extractor.storage.capture_store import Receiver
from website_js_extractor.api.server import make_server

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT/'references/repos/jshound'
SCAN = 'scan-stream-1'
SOURCE = b'''fetch("/api/users?x=1", {method:"POST", headers:{"x-test":"1"}, body: JSON.stringify({name:"a"})});\naxios.post("/api/login", {user:"u", pass:"p"});\n'''


def envelope(value):
    payload = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    return dict(schema=SCHEMA, event_json=payload)


def upload(store, data, project='default'):
    upload_id = uuid.uuid4().hex
    for offset in range(0, len(data), CHUNK_BYTES):
        chunk = data[offset:offset+CHUNK_BYTES]
        store.chunk(project, upload_id, offset, len(data), chunk)
    ack = store.commit(project, upload_id, len(data), 'https://app.example.test/assets/app.js', 'js')
    return ack['object_id']


CATEGORY = {
    'TaskStarted': 'task', 'TaskCheckpoint': 'task', 'ObservedRequest': 'api_request',
    'Debugger.scriptParsed': 'js_source', 'Runtime.executionContextCreated': 'page_context',
    'Runtime.executionContextDestroyed': 'page_context',
    'Runtime.executionContextsCleared': 'page_context',
    'Network.requestWillBeSent': 'script_load', 'Network.responseReceived': 'script_load',
    'Network.loadingFinished': 'script_load', 'Network.loadingFailed': 'script_load',
}


def event(kind, data, identity, **changes):
    value = dict(id=identity, scan_id=SCAN, kind=kind, category=CATEGORY.get(kind, 'task'),
                 time='2026-11-03T10:00:00Z', tab_id=1,
                 session_id='root', epoch='connection-1', status='captured', data=data)
    value.update(changes)
    return value


def scan_event(identity='scan-1:task'):
    return event('TaskStarted', {'scan': dict(id=SCAN, name='stream test', state='ended',
                                             started_at='2026-11-03T09:59:00Z', heartbeat='2026-11-03T10:01:00Z',
                                             tabs=[], versions=[], config={}, browser='Chrome', plugin='0.1',
                                             stats=dict(observed=1, pending=0, matched=1, excluded=0, unknown=0,
                                                        persisted=1, groups=1, bytes=0, lost=0),
                                             gaps=[], rule_hits={}, integrity='observed_scope')}, identity)


def context(identity, context_id, page_url, origin='https://app.example.test', **aux):
    return event('Runtime.executionContextCreated',
                 {'context': dict(id=context_id, origin=origin, name='', auxData=dict(frameId='F1', isDefault=True, type='default', **aux)),
                  'observed_tab_url': page_url, 'target_id': 'T1'}, identity)


def script(identity, source_hash, url, context_id=1, page_url='https://app.example.test/home', **changes):
    return event('Debugger.scriptParsed',
                 {'url': url, 'scriptId': 'S1', 'executionContextId': context_id,
                  'representation': 'debugger-parsed-source', 'network_match': 'unknown',
                  'source_bytes': len(SOURCE), 'observed_tab_url': page_url, 'target_id': 'T1',
                  'cdp': {'scriptId': 'S1', 'url': url, 'executionContextId': context_id}},
                 identity, object_id=source_hash, **changes)


def load_events(url='https://app.example.test/assets/app.js'):
    request = event('Network.requestWillBeSent',
                    {'request_id': 'js-1', 'redirect_hop': 0, 'frame_id': 'F1', 'loader_id': 'L1',
                     'document_url': 'https://app.example.test/home', 'url': url, 'method': 'GET',
                     'status': None, 'redirect': None, 'initiator': {'type': 'parser', 'url': 'https://app.example.test/home',
                                                                     'lineNumber': 0, 'columnNumber': 0},
                     'error': None, 'timestamp': 1.0, 'observed_tab_url': 'https://app.example.test/home',
                     'target_id': 'T1', 'cdp': {'type': 'Script', 'request': {'url': url, 'method': 'GET'}}},
                    'scan-1:network-1')
    response = event('Network.responseReceived',
                     {'request_id': 'js-1', 'redirect_hop': 0, 'url': url, 'status': 200,
                      'observed_tab_url': 'https://app.example.test/home', 'target_id': 'T1',
                      'cdp': {'response': {'url': url, 'status': 200, 'mimeType': 'application/javascript'}}},
                    'scan-1:network-2')
    finished = event('Network.loadingFinished',
                     {'request_id': 'js-1', 'redirect_hop': 0, 'cdp': {'encodedDataLength': len(SOURCE)}},
                     'scan-1:network-3')
    return [request, response, finished]


def observed(identity='scan-1:observed-1', request_id='api-1',
             request_url='https://app.example.test/api/users?x=1', method='POST'):
    return event('ObservedRequest', {'record': dict(
        request_id=request_id, request_url=request_url, method=method,
        query_params=[{'name': 'x', 'value': '1'}] if request_id == 'api-1' else [],
        request_headers=[], status_code=201 if request_id == 'api-1' else 200,
        page_url='https://app.example.test/home', initiator_url='https://app.example.test/assets/app.js',
        request_body=dict(representation='parsed', parsed={'name': 'a'}) if request_id == 'api-1' else {},
        tab_id=1, timestamp='2026-11-03T10:00:01Z')}, identity)


class StreamIngestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)/'data'
        self.out = Path(self.temp.name)/'out'
        self.store = Receiver(self.data)

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass

    def put_events(self, events):
        for item in events:
            self.store.event('default', envelope(item))

    def store_events(self, events):
        self.put_events(events)
        self.store.close()

    def ingest(self):
        return main(['ingest', '--data-dir', str(self.data), '--out', str(self.out),
                     '--engine-root', str(ENGINE), '--timeout', '60'])

    def test_context_lifetimes_keep_native_scripts_separate_and_ignore_old_unique_destruction(self):
        from website_js_extractor.ingestion.stream import EventReader,Ingest
        identity=upload(self.store,SOURCE)
        for closing_kind in ['Runtime.executionContextDestroyed','Runtime.executionContextsCleared']:
            with self.subTest(closing_kind=closing_kind):
                old=context('old',1,'https://old.test/',origin='https://old.test')
                old['data']['context']['uniqueId']='old'
                new=context('new',1,'https://new.test/',origin='https://new.test')
                new['data']['context']['uniqueId']='new'
                closed=event(closing_kind,dict(executionContextId=1,executionContextUniqueId='old',target_id='T1'),'closed')
                late=event('Runtime.executionContextDestroyed',dict(executionContextId=1,executionContextUniqueId='old',target_id='T1'),'late-old')
                events=[old,script('before',identity,'https://cdn.test/app.js'),closed,
                        script('gap',identity,'https://cdn.test/app.js'),new,late,
                        script('after',identity,'https://cdn.test/app.js')]
                original=json.dumps(events,sort_keys=True)
                reader=EventReader(self.data)
                try:
                    snapshot=Ingest(reader,SCAN,events,max_files=10,max_asset_bytes=1024,max_total_bytes=10240).build_snapshot(self.out/closing_kind)
                finally: reader.close()
                self.assertEqual({a['request_base_url'] for a in snapshot.assets},{'https://old.test','https://new.test',None})
                self.assertEqual(len(snapshot.assets),3)
                self.assertEqual(json.dumps(events,sort_keys=True),original)

    def test_static_candidates_and_observed_requests_are_kept_separate(self):
        identity = upload(self.store, SOURCE)
        self.store_events([scan_event(), context('scan-1:ctx', 1, 'https://app.example.test/home'),
                           script('scan-1:script', identity, 'https://app.example.test/assets/app.js'),
                           *load_events(), observed(),
                           observed('scan-1:observed-2', 'api-2', 'https://app.example.test/api/health', 'GET')])
        code = self.ingest()
        self.assertIn(code, (0, 4))
        report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.assertEqual(report['task']['id'], SCAN)
        self.assertEqual(len(report['assets']), 1)
        self.assertEqual(report['assets'][0]['runtime_depth'], 1)
        self.assertEqual(report['runtime_loads'][0]['runtime_depth'], 1)
        self.assertEqual(len(report['observed_requests']), 2)
        candidates = {item['url_expression']: item for item in report['candidates']}
        self.assertIn('/api/users?x=1', candidates)
        self.assertEqual(candidates['/api/users?x=1']['method'], 'POST')
        self.assertEqual(candidates['/api/users?x=1']['host'], 'https://app.example.test')
        self.assertIn('/api/login', candidates)
        inventory = {item['path_template']: item for item in report['api_inventory']}
        users = inventory['/api/users']
        self.assertEqual(users['status'], 'matched')
        self.assertEqual(users['observed_count'], 1)
        self.assertEqual(users['static_candidate_count'], 1)
        self.assertIn('x', [item['name'] for item in users['parameters']['observed_query']])
        login = inventory['/api/login']
        self.assertEqual(login['status'], 'static-only')
        self.assertEqual(login['observed_count'], 0)
        health = inventory['/api/health']
        self.assertEqual(health['status'], 'observed-only')
        self.assertEqual(health['observed_count'], 1)
        self.assertEqual(health['static_candidate_count'], 0)
        self.assertTrue((self.out/'api_inventory.json').is_file())
        self.assertTrue((self.out/'api_inventory.csv').is_file())
        self.assertTrue((self.out/'observed_requests.json').is_file())

    def test_real_receiver_http_upload_then_ingest(self):
        code = 'stream-http-code'
        server = make_server(self.data, code, origins=('chrome-extension://' + 'a'*32,))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(method, path, body=None, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                connection.request(method, '/v1/projects/default' + path, body=body,
                                   headers={'Authorization': 'Bearer ' + code, **(headers or {})})
                response = connection.getresponse()
                data = response.read()
                status = response.status
                connection.close()
                return status, data

            upload_id = uuid.uuid4().hex
            for offset in range(0, len(SOURCE), CHUNK_BYTES):
                chunk = SOURCE[offset:offset+CHUNK_BYTES]
                status, data = request('PUT', f'/uploads/{upload_id}/chunks/{offset}', chunk,
                                       {'X-Object-Bytes': str(len(SOURCE))})
                self.assertEqual(status, 200, data)
            status, data = request('POST', f'/uploads/{upload_id}/commit', json.dumps(
                {'bytes': len(SOURCE), 'url': 'https://app.example.test/assets/app.js', 'kind': 'js'}))
            self.assertEqual(status, 200, data)
            identity = json.loads(data)['object_id']
            for item in [scan_event('http:task'), context('http:ctx', 1, 'https://app.example.test/home'),
                         script('http:script', identity, 'https://app.example.test/assets/app.js')]:
                status, data = request('POST', '/events', json.dumps(envelope(item)))
                self.assertEqual(status, 200, data)
            code = self.ingest()
            self.assertIn(code, (0, 4))
            report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
            self.assertEqual(len(report['assets']), 1)
            self.assertEqual(len(report['api_inventory']), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            server.store.close()

    def test_ingest_reads_wal_while_receiver_is_still_open(self):
        identity = upload(self.store, SOURCE)
        self.put_events([scan_event(), context('scan-1:ctx', 1, 'https://app.example.test/home'),
                         script('scan-1:script', identity, 'https://app.example.test/assets/app.js')])
        code = self.ingest()
        self.assertIn(code, (0, 4))
        report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.assertEqual(len(report['assets']), 1)

    def test_missing_content_is_a_gap_and_does_not_create_an_asset(self):
        identity = upload(self.store, SOURCE)
        self.store_events([scan_event(), context('scan-1:ctx', 1, 'https://app.example.test/home'),
                           script('scan-1:script', identity, 'https://app.example.test/assets/app.js')])
        # Simulate a lost/GC'd object after the durable event was accepted.
        connection = sqlite3.connect(self.data/'capture.sqlite3')
        connection.execute('DELETE FROM bodies WHERE project=? AND object_id=?', ('default', identity))
        connection.commit()
        connection.close()
        code = self.ingest()
        self.assertEqual(code, 4)
        report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.assertEqual(report['assets'], [])
        self.assertIn('stream_content_missing', {gap['kind'] for gap in report['gaps']})
        self.assertEqual(report['api_inventory'], [])

    def test_script_without_context_keeps_host_unknown(self):
        identity = upload(self.store, SOURCE)
        self.store_events([scan_event(), script('scan-1:script', identity, 'https://app.example.test/assets/app.js',
                                               context_id=99)])
        code = self.ingest()
        self.assertEqual(code, 4)
        report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.assertEqual(len(report['assets']), 1)
        self.assertEqual(report['assets'][0]['url'], 'https://app.example.test/assets/app.js')
        self.assertIn('stream_context_missing', {gap['kind'] for gap in report['gaps']})
        self.assertTrue(report['unresolved_evidence'])
        self.assertEqual(report['api_inventory'], [])

    def test_same_content_in_two_contexts_is_deduplicated_on_disk_not_in_evidence(self):
        identity = upload(self.store, SOURCE)
        self.store_events([scan_event(),
                           context('scan-1:ctx-a', 1, 'https://app.example.test/a'),
                           context('scan-1:ctx-b', 2, 'https://app.example.test/b'),
                           script('scan-1:script-a', identity, 'https://app.example.test/assets/app.js',
                                  context_id=1, page_url='https://app.example.test/a'),
                           script('scan-1:script-b', identity, 'https://app.example.test/assets/app.js',
                                  context_id=2, page_url='https://app.example.test/b',
                                  status='deduplicated')])
        code = self.ingest()
        self.assertIn(code, (0, 4))
        report = json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.assertEqual(len(report['assets']), 2)
        self.assertEqual({item['body_file'] for item in report['assets']}, {'snapshot/'+identity+'.js'})
        self.assertEqual(len(report['capture_contexts']), 2)
        self.assertEqual(len(list((self.out/'snapshot').glob('*.js'))), 1)
        # A later same-URL observation is still evidence, not a gap.
        self.assertEqual(report['statistics']['deduplicated_script_events'], 1)
        self.assertEqual(report['assets'][1]['observations'][0]['status'], 'deduplicated')


if __name__ == '__main__':
    unittest.main()
