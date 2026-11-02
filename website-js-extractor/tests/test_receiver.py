import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from website_js_extractor.receiver import make_server, CHUNK_BYTES, Receiver

TOKEN = 'receiver-test-token-123456789'


def event(identity='event-1', **changes):
    return dict(id=identity, scan_id='scan-1', kind='Debugger.scriptParsed', time='2026-11-02T12:00:00Z',
                tab_id=7, session_id='worker-session', epoch='connection-1', status='captured',
                data={'url': 'https://site.test/中文.js', 'executionContextId': 9, 'zero': 0, 'false': False,
                      'empty': '', 'null': None, 'surrogate': '\ud800', 'array': [1, {'x': '字\n"\\'}],
                      'loading_stack': {'callFrames': [{'functionName': 'load', 'lineNumber': 0}],
                                        'parent': {'description': 'Promise.then', 'callFrames': []}}}, **changes)


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = make_server(Path(self.temp.name), TOKEN, origins=('chrome-extension://'+'a'*32,))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.server.store.close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        if isinstance(body, dict): body = json.dumps(body, ensure_ascii=True).encode()
        conn.request(method, '/v1/projects/default'+path, body=body, headers={'Authorization': 'Bearer '+TOKEN, **(headers or {})})
        response = conn.getresponse(); data = response.read(); status = response.status
        conn.close()
        return status, data

    def envelope(self, value):
        payload = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
        return dict(schema='capture-stream-1', event_json=payload, event_sha256=hashlib.sha256(payload.encode()).hexdigest())

    def upload(self, data):
        identity = hashlib.sha256(data).hexdigest()
        for offset in range(0, len(data), CHUNK_BYTES):
            chunk = data[offset:offset+CHUNK_BYTES]
            status, response = self.request('PUT', f'/objects/{identity}/chunks/{offset}', chunk,
                {'X-Object-Bytes': str(len(data)), 'X-Chunk-SHA256': hashlib.sha256(chunk).hexdigest()})
            self.assertEqual(status, 200, response)
        status, response = self.request('POST', f'/objects/{identity}/commit', dict(bytes=len(data)))
        self.assertEqual(status, 200, response)
        self.assertTrue(json.loads(response)['durable'])
        return identity

    def test_multimib_unicode_and_all_event_fields_survive_http_and_database_reopen(self):
        data = ('/*'+'字😀'.__mul__(350000)+'*/\nfetch("/api?x=0")').encode()
        identity = self.upload(data)
        value = event(hash=identity)
        value['data']['source_bytes'] = len(data)
        for _ in range(2):
            status, response = self.request('POST', '/events', self.envelope(value))
            self.assertEqual(status, 200, response)
            ack = json.loads(response)
            self.assertEqual(ack['event_sha256'], self.envelope(value)['event_sha256'])
            self.assertTrue(ack['durable'])
        status, response = self.request('GET', '/events?scan_id=scan-1')
        page = json.loads(response)
        self.assertEqual(page['count'], 1)
        self.assertEqual(page['events'], [value])
        self.assertEqual(self.request('GET', f'/objects/{identity}'), (200, data))
        reopened = Receiver(Path(self.temp.name))
        try:
            self.assertEqual(reopened.page('default', 'scan-1')['events'], [value])
            self.assertEqual(b''.join(reopened.source_chunks('default', identity)), data)
        finally: reopened.close()

    def test_chunk_hash_total_object_hash_and_missing_parts_are_rejected(self):
        identity = 'a'*64
        self.assertEqual(self.request('PUT', f'/objects/{identity}/chunks/0', b'bad', {'X-Object-Bytes': '3', 'X-Chunk-SHA256': '0'*64})[0], 400)
        self.assertEqual(self.request('POST', f'/objects/{identity}/commit', dict(bytes=3))[0], 409)
        self.assertEqual(self.request('PUT', f'/objects/{identity}/chunks/0', b'bad', {'X-Object-Bytes': '3', 'X-Chunk-SHA256': hashlib.sha256(b'bad').hexdigest()})[0], 200)
        self.assertEqual(self.request('POST', f'/objects/{identity}/commit', dict(bytes=3))[0], 409)
        self.assertFalse(json.loads(self.request('GET', f'/objects/{identity}?status')[1])['committed'])

    def test_event_conflict_corruption_missing_object_and_wrong_source_size(self):
        value = event()
        self.assertEqual(self.request('POST', '/events', self.envelope(value))[0], 200)
        value['data']['zero'] = 3
        self.assertEqual(self.request('POST', '/events', self.envelope(value))[0], 409)
        envelope = self.envelope(value); envelope['event_sha256'] = '0'*64
        self.assertEqual(self.request('POST', '/events', envelope)[0], 400)
        missing = event('missing', hash='a'*64)
        self.assertEqual(self.request('POST', '/events', self.envelope(missing))[0], 409)
        identity = self.upload(b'')
        self.assertEqual(self.request('POST', '/events', self.envelope(event('bad-size', hash=identity)))[0], 400)
        invalid_utf = b'\xff'
        identity = hashlib.sha256(invalid_utf).hexdigest()
        self.assertEqual(self.request('PUT', f'/objects/{identity}/chunks/0', invalid_utf, {'X-Object-Bytes': '1', 'X-Chunk-SHA256': identity})[0], 200)
        self.assertEqual(self.request('POST', f'/objects/{identity}/commit', dict(bytes=1))[0], 400)

    def test_authorization_origin_and_project_isolation(self):
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1', headers={'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1', headers={'Origin': 'https://evil.test'})[0], 403)
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1', headers={'Origin': 'chrome-extension://'+'a'*32})[0], 200)
        self.assertEqual(self.request('GET', '/../../another/events')[0], 404)

    def test_pagination_scan_isolation_and_duplicate_json_keys(self):
        for i in range(55): self.assertEqual(self.request('POST', '/events', self.envelope(event(str(i))))[0], 200)
        page = json.loads(self.request('GET', '/events?scan_id=scan-1')[1])
        self.assertEqual(len(page['events']), 50)
        following = json.loads(self.request('GET', f'/events?scan_id=scan-1&after={page["next"]}')[1])
        self.assertEqual(len(following['events']), 5)
        self.assertEqual(json.loads(self.request('GET', '/events?scan_id=other')[1])['events'], [])
        self.assertEqual(self.request('POST', '/events', b'{"schema":"x","schema":"y"}')[0], 400)
        self.assertEqual(self.request('GET', '/events?after=-1')[0], 400)
        payload = self.envelope(event('overflow'))['event_json'].replace('\"zero\":0', '\"zero\":1e400')
        self.assertEqual(self.request('POST', '/events', {'schema':'capture-stream-1','event_json':payload,'event_sha256':hashlib.sha256(payload.encode()).hexdigest()})[0], 400)

    def test_duplicate_chunks_retry_without_duplication(self):
        data = b'abcd'; identity = hashlib.sha256(data).hexdigest()
        headers = {'X-Object-Bytes': '4', 'X-Chunk-SHA256': identity}
        for _ in range(2): self.assertEqual(self.request('PUT', f'/objects/{identity}/chunks/0', data, headers)[0], 200)
        for _ in range(2): self.assertEqual(self.request('POST', f'/objects/{identity}/commit', {'bytes': 4})[0], 200)
        self.assertEqual(self.request('GET', f'/objects/{identity}'), (200, data))


if __name__ == '__main__': unittest.main()
