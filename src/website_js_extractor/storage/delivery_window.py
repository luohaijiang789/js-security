"""Bounded out-of-order receipts; durable ACK is distinct from contiguous visibility."""
WINDOW = 64
MODE = 'window-1'


def advance(db, project, stream):
    prefix = db.execute('SELECT contiguous FROM delivery_windows WHERE project=? AND stream=?', (project, stream)).fetchone()[0]
    for (sequence,) in db.execute('SELECT sequence FROM deliveries WHERE project=? AND stream=? AND sequence>? ORDER BY sequence LIMIT ?', (project, stream, prefix, WINDOW)):
        if sequence != prefix + 1:
            break
        prefix = sequence
    db.execute('UPDATE delivery_windows SET contiguous=? WHERE project=? AND stream=?', (prefix, project, stream))
    return prefix


def status(db, project, stream):
    row = db.execute('SELECT contiguous FROM delivery_windows WHERE project=? AND stream=?', (project, stream)).fetchone()
    if not row:
        return None
    prefix = row[0]
    ahead = {r[0] for r in db.execute('SELECT sequence FROM deliveries WHERE project=? AND stream=? AND sequence>? ORDER BY sequence LIMIT ?', (project, stream, prefix, WINDOW))}
    highest = max(ahead, default=prefix)
    return dict(window=WINDOW, contiguous_sequence=prefix, received_highest=highest,
                missing_sequences=[n for n in range(prefix + 1, highest + 1) if n not in ahead])


def frozen_frontiers(db, project, scan, watermark):
    """Reconstruct visibility at a receipt watermark, even after a later hole fills."""
    result = {}
    rows = db.execute('SELECT w.stream,w.contiguous FROM delivery_windows w JOIN delivery_streams s ON s.project=w.project AND s.stream=w.stream WHERE s.project=? AND s.scan=?', (project, scan)).fetchall()
    for stream, prefix in rows:
        later = db.execute('SELECT MIN(d.sequence) FROM deliveries d JOIN events e ON e.project=d.project AND e.id=d.event_id WHERE d.project=? AND d.stream=? AND e.seq>?', (project, stream, watermark)).fetchone()[0]
        result[stream] = min(prefix, later - 1) if later is not None else prefix
    return result
