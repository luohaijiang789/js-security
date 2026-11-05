"""Durable append-only browser evidence, uploads, receipts and delivery ledgers."""
import codecs
import hashlib
import json
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from website_js_extractor.domain.protocol import (CHUNK_BYTES, OBJECT_BYTES, EVENT_BYTES, HASH, UPLOAD, CATEGORIES, SCHEMA, Invalid, strict_json, sha)


from website_js_extractor.storage.delivery_window import WINDOW, MODE, advance, status, frozen_frontiers


class Receiver:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(directory / 'capture.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        # Old protocol-1 tables are left untouched; protocol-2 uses new names.
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS uploads(project TEXT, upload TEXT, offset INTEGER,
            total INTEGER, data BLOB, PRIMARY KEY(project,upload,offset));
          CREATE TABLE IF NOT EXISTS blobs(project TEXT, object_id TEXT, offset INTEGER,
            total INTEGER, data BLOB, PRIMARY KEY(project,object_id,offset));
          CREATE TABLE IF NOT EXISTS bodies(project TEXT, object_id TEXT, bytes INTEGER,
            kind TEXT, PRIMARY KEY(project,object_id));
          CREATE TABLE IF NOT EXISTS upload_receipts(project TEXT, upload TEXT, object_id TEXT,
            bytes INTEGER, url TEXT, kind TEXT, PRIMARY KEY(project,upload));
          CREATE TABLE IF NOT EXISTS object_urls(project TEXT, url TEXT, object_id TEXT,
            kind TEXT, updated TEXT, PRIMARY KEY(project,url));
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT, id TEXT, scan TEXT, payload TEXT, digest TEXT,
            UNIQUE(project,id));
          CREATE INDEX IF NOT EXISTS scan_events ON events(project,scan,seq);
          CREATE TABLE IF NOT EXISTS delivery_streams(project TEXT, stream TEXT, scan TEXT,
            sealed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,stream));
          CREATE TABLE IF NOT EXISTS delivery_windows(project TEXT, stream TEXT, contiguous INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,stream));
          CREATE TABLE IF NOT EXISTS deliveries(project TEXT, stream TEXT, sequence INTEGER,
            event_id TEXT, category TEXT, bytes INTEGER, object_id TEXT,
            PRIMARY KEY(project,stream,sequence), UNIQUE(project,event_id));
        ''')

    def close(self):
        self.db.close()

    def object_info(self, project, identity):
        with self.lock:
            row = self.db.execute('SELECT bytes FROM bodies WHERE project=? AND object_id=?', (project, identity)).fetchone()
            return dict(object_id=identity, bytes=row[0], committed=True) if row else dict(object_id=identity, committed=False)

    def lookup_url(self, project, url):
        with self.lock:
            row = self.db.execute('SELECT object_id,kind FROM object_urls WHERE project=? AND url=?', (project, url)).fetchone()
        return dict(url=url, object_id=row[0], kind=row[1], committed=True) if row else dict(url=url, committed=False)

    def chunk(self, project, upload, offset, total, data, expected_sha256=None):
        if expected_sha256 is not None and (not isinstance(expected_sha256, str) or not HASH.fullmatch(expected_sha256) or sha(data) != expected_sha256):
            raise Invalid('Chunk checksum mismatch.', 422)
        if not UPLOAD.fullmatch(upload):
            raise Invalid('Invalid upload ID.')
        if not 0 <= total <= OBJECT_BYTES or not 0 <= offset < total or offset % CHUNK_BYTES:
            raise Invalid('Invalid object size/offset.')
        if len(data) != min(CHUNK_BYTES, total - offset):
            raise Invalid('Chunk size mismatch.')
        with self.lock, self.db:
            committed = self.db.execute('SELECT object_id,bytes FROM upload_receipts WHERE project=? AND upload=?',
                                        (project, upload)).fetchone()
            if committed:
                piece = self.db.execute('SELECT data FROM blobs WHERE project=? AND object_id=? AND offset=?',
                                        (project, committed[0], offset)).fetchone()
                if committed[1] != total or not piece or piece[0] != data:
                    raise Invalid('Conflicting committed upload.', 409)
                return dict(upload=upload, offset=offset, durable=True)
            rows = self.db.execute('SELECT total,data FROM uploads WHERE project=? AND upload=? AND offset=?',
                                   (project, upload, offset)).fetchone()
            if rows:
                if rows != (total, data):
                    raise Invalid('Conflicting chunk.', 409)
            else:
                old = self.db.execute('SELECT total FROM uploads WHERE project=? AND upload=? LIMIT 1',
                                      (project, upload)).fetchone()
                if old and old[0] != total:
                    raise Invalid('Conflicting object length.', 409)
                self.db.execute('INSERT INTO uploads VALUES(?,?,?,?,?)', (project, upload, offset, total, data))
        return dict(upload=upload, offset=offset, durable=True)

    def commit(self, project, upload, total, url, kind, expected_sha256=None):
        if expected_sha256 is not None and (not isinstance(expected_sha256, str) or not HASH.fullmatch(expected_sha256)):
            raise Invalid('Invalid object checksum.')
        if not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= OBJECT_BYTES:
            raise Invalid('Invalid object length.')
        if url is not None and (not isinstance(url, str) or not 0 < len(url) <= 4096):
            raise Invalid('Invalid object URL.')
        if kind not in ('js', 'event'):
            raise Invalid('Invalid object kind.')
        if kind == 'event' and url is not None:
            raise Invalid('Event objects cannot claim a URL.')
        with self.lock, self.db:
            # A commit whose ACK was lost must stay idempotent even though the
            # upload rows were already moved into content-addressed storage.
            prior = self.db.execute(
                'SELECT object_id,bytes,url,kind FROM upload_receipts WHERE project=? AND upload=?',
                (project, upload)).fetchone()
            if prior:
                if prior[1] != total or prior[2] != url or prior[3] != kind or expected_sha256 is not None and prior[0] != expected_sha256:
                    raise Invalid('Upload was already committed with different metadata.', 409)
                return dict(object_id=prior[0], url=prior[2], bytes=prior[1], committed=True, durable=True)
            rows = list(self.db.execute('SELECT offset,total,data FROM uploads WHERE project=? AND upload=? ORDER BY offset',
                                        (project, upload)))
            digest, offset = hashlib.sha256(), 0
            for start, size, data in rows:
                if start != offset or size != total:
                    raise Invalid('Missing or inconsistent chunks.', 409)
                digest.update(data)
                offset += len(data)
            if offset != total:
                raise Invalid('Object length mismatch.', 409)
            # Reject invalid text rather than changing the bytes during analysis.
            decoder = codecs.getincrementaldecoder('utf-8')('strict')
            try:
                for _, _, data in rows:
                    decoder.decode(data)
                decoder.decode(b'', final=True)
            except UnicodeError as error:
                raise Invalid('Source must be UTF-8.') from error
            object_id = digest.hexdigest()
            if expected_sha256 is not None and object_id != expected_sha256:
                raise Invalid('Object checksum mismatch.', 422)
            for start, size, data in rows:
                self.db.execute('INSERT OR IGNORE INTO blobs VALUES(?,?,?,?,?)',
                                (project, object_id, start, size, data))
            self.db.execute('INSERT OR IGNORE INTO bodies VALUES(?,?,?,?)',
                            (project, object_id, total, kind))
            if url is not None:
                self.db.execute(
                    'INSERT INTO object_urls(project,url,object_id,kind,updated) VALUES(?,?,?,?,?) '
                    'ON CONFLICT(project,url) DO UPDATE SET object_id=excluded.object_id, '
                    'kind=excluded.kind, updated=excluded.updated',
                    (project, url, object_id, kind, datetime.now(timezone.utc).isoformat()))
            self.db.execute('INSERT INTO upload_receipts VALUES(?,?,?,?,?,?)',
                            (project, upload, object_id, total, url, kind))
            self.db.execute('DELETE FROM uploads WHERE project=? AND upload=?', (project, upload))
        return dict(object_id=object_id, url=url, bytes=total, committed=True, durable=True)

    def event(self, project, envelope):
        if not isinstance(envelope, dict) or envelope.get('schema') != SCHEMA:
            raise Invalid('Invalid event envelope/schema.')
        if 'event_object_id' in envelope:
            identity = envelope['event_object_id']
            if not isinstance(identity, str) or not HASH.fullmatch(identity) or not self.object_info(project, identity)['committed']:
                raise Invalid('Event object is not committed.', 409)
            payload = b''.join(self.source_chunks(project, identity)).decode('utf-8')
        else:
            payload = envelope.get('event_json')
        if not isinstance(payload, str):
            raise Invalid('Missing event JSON.')
        try:
            raw = payload.encode('utf-8')
        except UnicodeError as error:
            raise Invalid('Invalid event Unicode.') from error
        if len(raw) > EVENT_BYTES:
            raise Invalid('Event exceeds size budget.', 413)
        digest = sha(raw)
        if envelope.get('event_sha256', digest) != digest:
            raise Invalid('Event checksum mismatch.', 422)
        value = strict_json(payload)
        if not isinstance(value, dict) or not isinstance(value.get('data'), dict):
            raise Invalid('Invalid event data.')
        for field in ['id', 'scan_id', 'kind', 'time', 'session_id', 'epoch', 'status']:
            if not isinstance(value.get(field), str) or not value[field] or len(value[field]) > 512:
                raise Invalid('Missing/invalid event identity.')
        category = value.get('category')
        if not isinstance(category, str) or category not in CATEGORIES:
            raise Invalid('Missing/invalid event category.')
        if value['kind'] in {'TaskStarted', 'TaskCheckpoint'}:
            scan = value['data'].get('scan', {})
            if not isinstance(scan, dict): raise Invalid('Invalid task scan.')
            configuration = scan.get('config', {})
            if not isinstance(configuration, dict): raise Invalid('Invalid task configuration.')
            if 'analysis' in configuration:
                from website_js_extractor.domain.settings import AnalysisSettings
                AnalysisSettings.parse(configuration['analysis'])
        content = value.get('object_id')
        if content is not None:
            if not isinstance(content, str) or not HASH.fullmatch(content):
                raise Invalid('Invalid object ID.')
            obj = self.object_info(project, content)
            if not obj['committed']:
                raise Invalid('Event references an uncommitted object.', 409)
            if obj['bytes'] != value['data'].get('source_bytes'):
                raise Invalid('Event source length mismatch.')
        mode = envelope.get('delivery_mode')
        if mode not in (None, MODE): raise Invalid('Invalid delivery mode.')
        transport = value.get('transport')
        if mode and transport is None: raise Invalid('Window delivery requires a stream identity.')
        if transport is not None:
            if not isinstance(transport, dict) or set(transport) != {'stream_id', 'sequence'}:
                raise Invalid('Invalid delivery identity.')
            stream, sequence = transport['stream_id'], transport['sequence']
            if not isinstance(stream, str) or not UPLOAD.fullmatch(stream) or type(sequence) is not int or sequence < 1:
                raise Invalid('Invalid delivery sequence.')
        with self.lock, self.db:
            old = self.db.execute('SELECT digest FROM events WHERE project=? AND id=?', (project, value['id'])).fetchone()
            if old and old[0] != digest:
                raise Invalid('Event ID reused for different data.', 409)
            if transport is not None:
                stream_row = self.db.execute('SELECT scan,sealed FROM delivery_streams WHERE project=? AND stream=?',
                                             (project, stream)).fetchone()
                previous = self.db.execute('SELECT event_id FROM deliveries WHERE project=? AND stream=? AND sequence=?',
                                           (project, stream, sequence)).fetchone()
                if stream_row and stream_row[0] != value['scan_id']:
                    raise Invalid('Stream belongs to a different scan.', 409)
                if previous:
                    if previous[0] != value['id'] or not old:
                        raise Invalid('Conflicting delivery sequence.', 409)
                else:
                    if stream_row and stream_row[1]:
                        raise Invalid('Delivery stream is sealed.', 409)
                    last = self.db.execute('SELECT COALESCE(MAX(sequence),0) FROM deliveries WHERE project=? AND stream=?',
                                           (project, stream)).fetchone()[0]
                    window = self.db.execute('SELECT contiguous FROM delivery_windows WHERE project=? AND stream=?', (project, stream)).fetchone()
                    if mode == MODE:
                        prefix = window[0] if window else last
                        if not prefix < sequence <= prefix + WINDOW or old:
                            raise Invalid('Delivery is outside the bounded receive window.', 409)
                        if not window:
                            self.db.execute('INSERT INTO delivery_windows VALUES(?,?,?)', (project, stream, prefix))
                    elif window or sequence != last + 1 or old:
                        raise Invalid('Delivery sequence must be contiguous; window streams require window-1.', 409)
                    if not stream_row:
                        self.db.execute('INSERT INTO delivery_streams VALUES(?,?,?,0)', (project, stream, value['scan_id']))
                    self.db.execute('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)',
                                    (project, stream, sequence, value['id'], category, len(raw), content))
            if not old:
                self.db.execute('INSERT INTO events(project,id,scan,payload,digest) VALUES(?,?,?,?,?)',
                                (project, value['id'], value['scan_id'], payload, digest))
            if transport is not None and mode == MODE:
                # Enabling window mode on an idempotent replay also supports old serial outboxes.
                if not self.db.execute('SELECT 1 FROM delivery_windows WHERE project=? AND stream=?', (project, stream)).fetchone():
                    last = self.db.execute('SELECT MAX(sequence) FROM deliveries WHERE project=? AND stream=?', (project, stream)).fetchone()[0]
                    self.db.execute('INSERT INTO delivery_windows VALUES(?,?,?)', (project, stream, last))
                advance(self.db, project, stream)
                window_receipt = status(self.db, project, stream)
        receipt = dict(schema=SCHEMA, event_id=value['id'], event_sha256=digest, object_id=content, durable=True)
        if transport is not None:
            receipt['transport'] = dict(stream_id=stream, sequence=sequence, event_bytes=len(raw))
            if mode == MODE: receipt['transport'].update(window_receipt)
        return receipt

    def seal(self, project, stream, expected):
        if not isinstance(expected, dict) or not isinstance(expected.get('scan_id'), str):
            raise Invalid('Invalid delivery manifest.')
        if type(expected.get('count')) is not int or expected['count'] < 1 or type(expected.get('bytes')) is not int:
            raise Invalid('Invalid delivery totals.')
        if not isinstance(expected.get('categories'), dict) or any(
            key not in CATEGORIES or type(count) is not int or count < 1
            for key, count in expected['categories'].items()
        ):
            raise Invalid('Invalid category totals.')
        with self.lock, self.db:
            row = self.db.execute('SELECT scan FROM delivery_streams WHERE project=? AND stream=?',
                                  (project, stream)).fetchone()
            if not row or row[0] != expected['scan_id']:
                raise Invalid('Unknown stream/scan.', 409)
            count, first, last, size = self.db.execute(
                'SELECT COUNT(*),MIN(sequence),MAX(sequence),COALESCE(SUM(bytes),0) FROM deliveries WHERE project=? AND stream=?',
                (project, stream)).fetchone()
            categories = dict(self.db.execute('SELECT category,COUNT(*) FROM deliveries WHERE project=? AND stream=? GROUP BY category',
                                              (project, stream)))
            missing = self.db.execute("""SELECT COUNT(*) FROM deliveries d LEFT JOIN bodies b
                ON b.project=d.project AND b.object_id=d.object_id
                LEFT JOIN events e ON e.project=d.project AND e.id=d.event_id
                WHERE d.project=? AND d.stream=? AND (e.id IS NULL OR (d.object_id IS NOT NULL AND b.object_id IS NULL))""",
                (project, stream)).fetchone()[0]
            if first != 1 or last != count or count != expected['count'] or size != expected['bytes'] or categories != expected['categories'] or missing:
                raise Invalid('Delivery manifest does not match durable events/objects.', 409)
            self.db.execute('UPDATE delivery_streams SET sealed=1 WHERE project=? AND stream=?', (project, stream))
        return dict(schema=SCHEMA, stream_id=stream, scan_id=row[0], count=count,
                    categories=categories, bytes=size, sealed=True, durable=True)

    def page(self, project, scan, after=0, limit=50, summary=False):
        if not 0 <= after or not 1 <= limit <= 100:
            raise Invalid('Invalid page.')
        with self.lock:
            rows, size = [], 0
            for row in self.db.execute('SELECT seq,payload FROM events WHERE project=? AND scan=? AND seq>? ORDER BY seq LIMIT ?',
                                       (project, scan, after, limit)):
                if rows and size + len(row[1]) > 4 * 1024 * 1024:
                    break
                rows.append(row)
                size += len(row[1])
            count = self.db.execute('SELECT count(*) FROM events WHERE project=? AND scan=?', (project, scan)).fetchone()[0]
            next_cursor = rows[-1][0] if rows else after
            more = bool(self.db.execute('SELECT 1 FROM events WHERE project=? AND scan=? AND seq>? LIMIT 1',
                                        (project, scan, next_cursor)).fetchone())
        events = [strict_json(r[1]) for r in rows]
        if summary:
            for item in events:
                data = item['data']
                item['data'] = {key: data[key] for key in ['url', 'document_url', 'source_bytes', 'network_match',
                                                          'observed_tab_url', 'target_id'] if key in data}
                if item['kind'] == 'ObservedRequest':
                    record = data.get('record', {})
                    item['data']['record'] = {key: record[key] for key in ['request_url', 'method', 'status_code',
                                                                          'request_id'] if key in record}
                item['summary_only'] = True
        return dict(events=events, count=count, next=next_cursor, has_more=more)

    def export_snapshot(self, directory, project, scan, watermark):
        """Copy only immutable evidence referenced by one task at its fixed watermark.

        Reads hold the receiver lock for individual rows/chunks, never a full database backup.
        New rows cannot change an already committed event or object, so subsequent writes continue.
        """
        destination = Receiver(directory)
        references, count, total_bytes, after = set(), 0, 0, 0
        deferred = 0
        with self.lock:
            frontiers = frozen_frontiers(self.db, project, scan, watermark)
        try:
            while True:
                with self.lock:
                    row = self.db.execute('SELECT seq,id,payload,digest FROM events WHERE project=? AND scan=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1',
                                          (project, scan, after, watermark)).fetchone()
                if not row: break
                after = row[0]
                value = strict_json(row[2])
                transport = value.get('transport') or {}
                frontier = frontiers.get(transport.get('stream_id'))
                if frontier is not None and transport['sequence'] > frontier:
                    deferred += 1
                    continue
                if value.get('object_id'): references.add(value['object_id'])
                with destination.db:
                    destination.db.execute('INSERT INTO events(seq,project,id,scan,payload,digest) VALUES(?,?,?,?,?,?)',
                                           (row[0], project, row[1], scan, row[2], row[3]))
                count += 1
            for identity in sorted(references):
                with self.lock:
                    info = self.db.execute('SELECT bytes,kind FROM bodies WHERE project=? AND object_id=?', (project, identity)).fetchone()
                if not info: raise Invalid('Snapshot references a missing object.', 409)
                offset, hasher = 0, hashlib.sha256()
                with destination.db:
                    for data in self.source_chunks(project, identity):
                        destination.db.execute('INSERT INTO blobs VALUES(?,?,?,?,?)', (project, identity, offset, info[0], data))
                        offset += len(data)
                        hasher.update(data)
                    if offset != info[0] or hasher.hexdigest() != identity:
                        raise Invalid('Snapshot object integrity mismatch.', 409)
                    destination.db.execute('INSERT INTO bodies VALUES(?,?,?,?)', (project, identity, *info))
                total_bytes += offset
            manifest = dict(project=project, scan=scan, watermark=watermark, events=count, objects=len(references), bytes=total_bytes, delivery_frontiers=frontiers, deferred_events=deferred)
            (Path(directory)/'selection.json').write_text(json.dumps(manifest), encoding='utf-8')
            return manifest
        finally:
            destination.close()

    def source_chunks(self, project, identity):
        offset = 0
        while True:
            with self.lock:
                row = self.db.execute('SELECT data FROM blobs WHERE project=? AND object_id=? AND offset=?',
                                      (project, identity, offset)).fetchone()
            if not row:
                return
            offset += len(row[0])
            yield row[0]

