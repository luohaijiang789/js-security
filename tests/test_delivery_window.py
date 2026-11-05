import json
from pathlib import Path
import tempfile
import unittest
import uuid

from website_js_extractor.domain.protocol import Invalid, SCHEMA
from website_js_extractor.ingestion.stream import EventReader
from website_js_extractor.storage.capture_store import Receiver


class DeliveryWindowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Receiver(self.root/'source')
        self.addCleanup(lambda: self.store.close())
        self.stream = uuid.uuid4().hex

    def send(self, n, *, mode='window-1', **changes):
        event = dict(id=f'e-{n}', scan_id='scan', kind='ObservedRequest', category='api_request',
                     time='2026-11-05T00:00:00Z', session_id='root', epoch='epoch', status='captured',
                     data={'record': {'n': n}}, transport=dict(stream_id=self.stream, sequence=n))
        event.update(changes)
        return self.store.event('default', dict(schema=SCHEMA, event_json=json.dumps(event), **({'delivery_mode':mode} if mode else {})))

    def test_later_receipt_is_durable_but_invisible_until_hole_fills_and_old_watermarks_stay_frozen(self):
        two = self.send(2)
        self.assertEqual(two['transport']['contiguous_sequence'], 0)
        self.assertEqual(two['transport']['missing_sequences'], [1])
        watermark = self.store.db.execute('SELECT MAX(seq) FROM events').fetchone()[0]
        self.assertEqual(self.store.export_snapshot(self.root/'before','default','scan',watermark)['events'], 0)
        self.send(1)
        replay = self.send(2)
        self.assertEqual(replay['transport']['contiguous_sequence'], 2)
        self.assertEqual(replay['transport']['missing_sequences'], [])
        old = self.store.export_snapshot(self.root/'old-watermark','default','scan',watermark)
        self.assertEqual(old['events'], 0)
        self.assertEqual(old['deferred_events'], 1)
        current = self.store.export_snapshot(self.root/'after','default','scan',2)
        self.assertEqual(current['events'], 2)
        reader = EventReader(self.root/'after')
        try: self.assertEqual([e['id'] for e in reader.events('scan')], ['e-1','e-2'])
        finally: reader.close()

    def test_window_bound_is_relative_to_contiguous_prefix_not_highest_arrival(self):
        self.send(64)
        with self.assertRaises(Invalid): self.send(65)
        for n in range(1,64): self.send(n)
        ack = self.send(65)
        self.assertEqual(ack['transport']['contiguous_sequence'], 65)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 65)

    def test_holes_cannot_seal_and_conflicts_cannot_replace_durable_evidence(self):
        two, three = self.send(2), self.send(3)
        expected = dict(scan_id='scan', count=2, categories={'api_request':2}, bytes=sum(r['transport']['event_bytes'] for r in [two,three]))
        with self.assertRaises(Invalid): self.store.seal('default',self.stream,expected)
        with self.assertRaises(Invalid): self.send(2,id='replacement')
        with self.assertRaises(Invalid): self.send(1,scan_id='other')
        one = self.send(1)
        expected.update(count=3, categories={'api_request':3}, bytes=expected['bytes']+one['transport']['event_bytes'])
        self.assertTrue(self.store.seal('default',self.stream,expected)['sealed'])
        self.assertEqual(self.send(2)['transport']['contiguous_sequence'],3)
        with self.assertRaises(Invalid): self.send(4)

    def test_server_restart_preserves_holes_and_old_serial_streams_can_upgrade(self):
        self.send(1,mode=None)
        self.send(3)
        self.store.close()
        self.store = Receiver(self.root/'source')
        with self.assertRaises(Invalid): self.send(4,mode=None)
        reader = EventReader(self.root/'source')
        try:
            self.assertEqual([e['id'] for e in reader.events('scan')], ['e-1'])
            self.assertEqual(reader.delivery_selection['deferred_events'],1)
        finally: reader.close()
        self.assertEqual(self.send(2)['transport']['contiguous_sequence'],3)
