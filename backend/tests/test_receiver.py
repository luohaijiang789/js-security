import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from website_js_extractor.receiver import make_server, CHUNK_BYTES, Receiver, SCHEMA

TOKEN = 'receiver-test-token-123456789'


def event(identity='event-1', **changes):
    value = dict(id=identity, scan_id='scan-1', kind='Debugger.scriptParsed', category='js_source',
                 time='2026-11-02T12:00:00Z', tab_id=7, session_id='worker-session', epoch='connection-1',
                 status='captured', data={'url': 'https://site.test/中文.js', 'executionContextId': 9, 'zero': 0,
                                          'false': False, 'empty': '', 'null': None, 'surrogate': '\ud800',
                                          'array': [1, {'x': '字\n"\\'}],
                                          'loading_stack': {'callFrames': [{'functionName': 'load', 'lineNumber': 0}],
                                                            'parent': {'description': 'Promise.then',
                                                                       'callFrames': []}}})
    value.update(changes)
    return value


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = make_server(Path(self.temp.name), TOKEN, origins=('chrome-extension://' + 'a' * 32,))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server.store.close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=True).encode()
        conn.request(method, '/v1/projects/default' + path, body=body,
                     headers={'Authorization': 'Bearer ' + TOKEN, **(headers or {})})
        response = conn.getresponse()
        data = response.read()
        status = response.status
        conn.close()
        return status, data

    def envelope(self, value):
        payload = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
        return dict(schema=SCHEMA, event_json=payload)

    def upload(self, data, url=None, kind='js', upload=None):
        """Uploads raw bytes; the receiver, not the client, computes the hash."""
        upload = upload or uuid.uuid4().hex
        for offset in range(0, len(data), CHUNK_BYTES):
            chunk = data[offset:offset + CHUNK_BYTES]
            status, response = self.request('PUT', f'/uploads/{upload}/chunks/{offset}', chunk,
                                            {'X-Object-Bytes': str(len(data))})
            self.assertEqual(status, 200, response)
        status, response = self.request('POST', f'/uploads/{upload}/commit',
                                        dict(bytes=len(data), url=url, kind=kind))
        self.assertEqual(status, 200, response)
        ack = json.loads(response)
        self.assertTrue(ack['durable'])
        self.assertEqual(ack['bytes'], len(data))
        self.assertEqual(ack['object_id'], hashlib.sha256(data).hexdigest())
        return ack['object_id']

    def test_multimib_unicode_and_all_event_fields_survive_http_and_database_reopen(self):
        data = ('/*' + '字😀' * 350000 + '*/\nfetch("/api?x=0")').encode()
        identity = self.upload(data, 'https://site.test/中文.js')
        value = event(object_id=identity)
        value['data']['source_bytes'] = len(data)
        for _ in range(2):
            status, response = self.request('POST', '/events', self.envelope(value))
            self.assertEqual(status, 200, response)
            ack = json.loads(response)
            self.assertEqual(ack['schema'], SCHEMA)
            self.assertEqual(ack['object_id'], identity)
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
            self.assertEqual(reopened.lookup_url('default', 'https://site.test/中文.js')['object_id'], identity)
        finally:
            reopened.close()

    def test_chunk_size_and_missing_parts_are_rejected_without_acknowledgement(self):
        upload = uuid.uuid4().hex
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=4, url=None, kind='js'))[0], 409)
        self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/0', b'bad',
                                      {'X-Object-Bytes': '4'})[0], 400)
        self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/1', b'abcd',
                                      {'X-Object-Bytes': '8'})[0], 400)
        self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/0', b'abcd',
                                      {'X-Object-Bytes': '4'})[0], 200)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=8, url=None, kind='js'))[0], 409)
        status, response = self.request('POST', f'/uploads/{upload}/commit',
                                        dict(bytes=4, url=None, kind='js'))
        self.assertEqual(status, 200, response)
        identity = hashlib.sha256(b'abcd').hexdigest()
        self.assertEqual(json.loads(response)['object_id'], identity)
        self.assertEqual(json.loads(self.request('GET', f'/objects/{identity}?status')[1])['committed'], True)
        # A lost commit ACK is idempotent: same upload ID returns the same object.
        status, replay = self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=4, url=None, kind='js'))
        self.assertEqual(status, 200, replay)
        self.assertEqual(json.loads(replay)['object_id'], identity)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=4, url='https://x.test/a.js', kind='js'))[0], 409)

    def test_event_conflict_corruption_missing_object_wrong_source_size_and_category(self):
        value = event()
        self.assertEqual(self.request('POST', '/events', self.envelope(value))[0], 200)
        value['data']['zero'] = 3
        self.assertEqual(self.request('POST', '/events', self.envelope(value))[0], 409)
        broken = self.envelope(value)
        broken['schema'] = 'capture-stream-1'
        self.assertEqual(self.request('POST', '/events', broken)[0], 400)
        missing = event('missing', object_id='a' * 64)
        self.assertEqual(self.request('POST', '/events', self.envelope(missing))[0], 409)
        identity = self.upload(b'')
        self.assertEqual(self.request('POST', '/events', self.envelope(event('bad-size', object_id=identity)))[0], 400)
        self.assertEqual(self.request('POST', '/events',
                                      self.envelope(event('no-category', category='')))[0], 400)
        self.assertEqual(self.request('POST', '/events',
                                      self.envelope(event('unknown-category', category='whatever')))[0], 400)

    def test_invalid_utf8_and_bad_commit_shapes_are_rejected(self):
        upload = uuid.uuid4().hex
        self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/0', b'\xff',
                                      {'X-Object-Bytes': '1'})[0], 200)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=1, url=None, kind='js'))[0], 400)
        upload = uuid.uuid4().hex
        self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/0', b'ok',
                                      {'X-Object-Bytes': '2'})[0], 200)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=2, url='https://x.test/a.js', kind='event'))[0], 400)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=2, url=None, kind='other'))[0], 400)
        self.assertEqual(self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=2, url='https://x.test/a.js', kind='js'))[0], 200)

    def test_event_object_envelope_uses_server_hash(self):
        value = event('large-event', data={'body': '字' * 5000})
        payload = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()
        identity = self.upload(payload, None, kind='event')
        status, response = self.request('POST', '/events',
                                        dict(schema=SCHEMA, event_object_id=identity))
        self.assertEqual(status, 200, response)
        self.assertEqual(json.loads(response)['event_id'], 'large-event')
        self.assertEqual(self.request('POST', '/events',
                                      dict(schema=SCHEMA, event_object_id='a' * 64))[0], 409)

    def test_url_mapping_tracks_latest_object_per_project_url(self):
        first = self.upload(b'one', 'https://site.test/app.js')
        second = self.upload(b'two', 'https://site.test/app.js')
        self.assertNotEqual(first, second)
        info = self.server.store.lookup_url('default', 'https://site.test/app.js')
        self.assertEqual(info['object_id'], second)
        self.assertTrue(info['committed'])
        self.assertFalse(self.server.store.lookup_url('default', 'https://site.test/missing.js')['committed'])

    def test_authorization_origin_and_project_isolation(self):
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1',
                                      headers={'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1',
                                      headers={'Origin': 'https://evil.test'})[0], 403)
        self.assertEqual(self.request('GET', '/events?scan_id=scan-1',
                                      headers={'Origin': 'chrome-extension://' + 'a' * 32})[0], 200)
        self.assertEqual(self.request('GET', '/../../another/events')[0], 404)

    def test_pagination_scan_isolation_and_duplicate_json_keys(self):
        for i in range(55):
            self.assertEqual(self.request('POST', '/events', self.envelope(event(str(i))))[0], 200)
        page = json.loads(self.request('GET', '/events?scan_id=scan-1')[1])
        self.assertEqual(len(page['events']), 50)
        following = json.loads(self.request('GET', f'/events?scan_id=scan-1&after={page["next"]}')[1])
        self.assertEqual(len(following['events']), 5)
        self.assertEqual(json.loads(self.request('GET', '/events?scan_id=other')[1])['events'], [])
        self.assertEqual(self.request('POST', '/events', b'{"schema":"x","schema":"y"}')[0], 400)
        self.assertEqual(self.request('GET', '/events?after=-1')[0], 400)
        payload = self.envelope(event('overflow'))['event_json'].replace('"zero":0', '"zero":1e400')
        self.assertEqual(self.request('POST', '/events',
                                      {'schema': SCHEMA, 'event_json': payload})[0], 400)

    def test_duplicate_chunks_and_commits_retry_without_duplication(self):
        data = b'abcd'
        upload = uuid.uuid4().hex
        for _ in range(2):
            self.assertEqual(self.request('PUT', f'/uploads/{upload}/chunks/0', data,
                                          {'X-Object-Bytes': '4'})[0], 200)
        status, response = self.request('POST', f'/uploads/{upload}/commit',
                                        dict(bytes=4, url='https://site.test/a.js', kind='js'))
        self.assertEqual(status, 200, response)
        identity = hashlib.sha256(data).hexdigest()
        # A retried commit after the rows were moved stays idempotent.
        status, replay = self.request('POST', f'/uploads/{upload}/commit',
                                      dict(bytes=4, url='https://site.test/a.js', kind='js'))
        self.assertEqual(status, 200, replay)
        self.assertEqual(json.loads(replay)['object_id'], identity)
        self.assertEqual(self.request('GET', f'/objects/{identity}'), (200, data))
        # Re-uploading the same content under a new upload ID is content-addressed.
        self.assertEqual(self.upload(data, 'https://site.test/a.js'), identity)


if __name__ == '__main__':
    unittest.main()