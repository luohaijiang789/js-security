import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from website_js_extractor.storage.capture_store import Receiver
from website_js_extractor.domain.protocol import SCHEMA
from test_stream import upload, SOURCE, script, context, envelope, SCAN


class SnapshotExportTest(unittest.TestCase):
    def test_export_is_task_and_watermark_scoped_and_does_not_hold_the_receive_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); store = Receiver(root/'source')
            try:
                identity = upload(store, SOURCE)
                store.event('default', envelope(context('ctx',1,'https://app.example.test/home')))
                store.event('default', envelope(script('script',identity,'https://app.example.test/main.js')))
                watermark = store.db.execute('SELECT MAX(seq) FROM events').fetchone()[0]
                extra = context('other',2,'https://other.test/'); extra['scan_id']='other-scan'
                store.event('default', envelope(extra))
                original = store.source_chunks
                def chunks(project, identity):
                    for data in original(project, identity):
                        done = threading.Event()
                        def write():
                            later = context('later',3,'https://app.example.test/later')
                            store.event('default', envelope(later)); done.set()
                        thread=threading.Thread(target=write);thread.start()
                        self.assertTrue(done.wait(2), 'Snapshot held the receive lock during body copy')
                        thread.join()
                        yield data
                store.source_chunks = chunks
                manifest = store.export_snapshot(root/'frozen','default',SCAN,watermark)
                frozen = Receiver(root/'frozen')
                try:
                    events = frozen.page('default',SCAN)['events']
                    self.assertEqual([item['id'] for item in events], ['ctx','script'])
                    self.assertEqual(frozen.page('default','other-scan')['events'], [])
                    self.assertEqual(manifest['objects'],1)
                    self.assertEqual(b''.join(frozen.source_chunks('default',identity)),SOURCE)
                finally: frozen.close()
            finally: store.close()
