import json
from pathlib import Path
import tempfile
import unittest
import uuid
from website_js_extractor.storage.capture_store import Receiver
from website_js_extractor.domain.protocol import Invalid, SCHEMA


class DeliveryLedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Receiver(Path(self.temp.name))
        self.addCleanup(self.store.close)
        self.stream = uuid.uuid4().hex

    def send(self, n, **changes):
        event = dict(id=f'event-{n}', scan_id='scan', kind='ObservedRequest', category='api_request',
                     time='2026-11-04T00:00:00Z', session_id='root', epoch='connection', status='captured',
                     data={'n': n}, transport=dict(stream_id=self.stream, sequence=n))
        event.update(changes)
        return self.store.event('default', dict(schema=SCHEMA, event_json=json.dumps(event)))

    def expected(self, *receipts):
        return dict(scan_id='scan', count=len(receipts), categories={'api_request': len(receipts)},
                    bytes=sum(item['transport']['event_bytes'] for item in receipts))

    def test_order_conflict_and_sealed_replay(self):
        with self.assertRaises(Invalid): self.send(2)
        one, two = self.send(1), self.send(2)
        with self.assertRaises(Invalid): self.send(2, id='other')
        expected = self.expected(one, two)
        self.assertEqual(self.store.seal('default', self.stream, expected)['count'], 2)
        self.assertEqual(self.store.seal('default', self.stream, expected)['count'], 2)
        self.assertEqual(self.send(2), two)  # Lost ACK can still be replayed after sealing.
        with self.assertRaises(Invalid): self.send(3)

    def test_wrong_totals_or_cross_scan_cannot_seal(self):
        one = self.send(1)
        expected = self.expected(one)
        for change in ({'count': 2}, {'bytes': 0}, {'categories': {'js_source': 1}}, {'scan_id': 'other'}):
            with self.assertRaises(Invalid): self.store.seal('default', self.stream, {**expected, **change})
        self.assertEqual(self.store.db.execute('SELECT sealed FROM delivery_streams').fetchone()[0], 0)

    def test_committed_chunk_replay_does_not_recreate_temporary_uploads(self):
        upload = uuid.uuid4().hex
        self.store.chunk('default', upload, 0, 3, b'abc')
        self.store.commit('default', upload, 3, 'https://x.test/a.js', 'js')
        self.store.chunk('default', upload, 0, 3, b'abc')
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM uploads').fetchone()[0], 0)
        with self.assertRaises(Invalid): self.store.chunk('default', upload, 0, 3, b'bad')

    def test_manifest_rejects_missing_durable_events(self):
        one = self.send(1)
        with self.store.db: self.store.db.execute('DELETE FROM events')
        with self.assertRaises(Invalid): self.store.seal('default', self.stream, self.expected(one))

    def test_checksums_reject_corrupted_chunks_objects_and_events_without_success(self):
        import hashlib
        upload = uuid.uuid4().hex
        right = hashlib.sha256(b'abc').hexdigest()
        with self.assertRaises(Invalid): self.store.chunk('default', upload, 0, 3, b'bad', right)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM uploads').fetchone()[0], 0)
        self.store.chunk('default', upload, 0, 3, b'abc', right)
        with self.assertRaises(Invalid): self.store.commit('default', upload, 3, None, 'js', 'f'*64)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM bodies').fetchone()[0], 0)
        ack = self.store.commit('default', upload, 3, None, 'js', right)
        self.assertEqual(ack['object_id'], right)
        value = dict(id='checksum-event',scan_id='scan',kind='ObservedRequest',category='api_request',
                     time='now',session_id='root',epoch='1',status='captured',data={})
        with self.assertRaises(Invalid):
            self.store.event('default', dict(schema=SCHEMA,event_json=json.dumps(value),event_sha256='f'*64))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
