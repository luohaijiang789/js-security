"""Single bounded analysis worker. Every run exports only selected evidence at a fixed watermark."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == 'posix':
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
    process.wait()


class AnalysisJobs:
    def __init__(self, receiver, directory, *, debounce=2, deadline=180):
        self.receiver = receiver
        self.directory = Path(directory).resolve() / 'analysis'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.directory / 'jobs.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT, scan TEXT,
            watermark INTEGER, status TEXT, created TEXT, finished TEXT, error TEXT)''')
        with self.db:
            self.db.execute("UPDATE jobs SET status='interrupted',error='Server restarted before completion.' WHERE status='running'")
        self.condition = threading.Condition(threading.RLock())
        self.pending = {}
        self.debounce, self.deadline = debounce, deadline
        self.closed, self.process = False, None
        self.thread = threading.Thread(target=self._loop, daemon=True, name='analysis-jobs')
        # Rebuild deferred work from durable events, including a crash before notification.
        with receiver.lock:
            scans = list(receiver.db.execute('SELECT project,scan,MAX(seq) FROM events GROUP BY project,scan'))
        for project, scan, watermark in scans:
            done = self.db.execute("SELECT MAX(watermark) FROM jobs WHERE project=? AND scan=? AND status IN ('completed','completed_with_gaps','partial')", (project, scan)).fetchone()[0] or 0
            if watermark > done:
                self.notify(project, scan)
        self.thread.start()

    def notify(self, project, scan, immediate=False):
        with self.condition:
            if self.closed:
                return
            key = (project, scan)
            first = self.pending.get(key, (time.monotonic(), 0))[0]
            now = time.monotonic()
            self.pending[key] = (first, now if immediate else min(now + self.debounce, first + 10))
            self.condition.notify_all()

    def _loop(self):
        while True:
            with self.condition:
                if self.closed:
                    return
                if not self.pending:
                    self.condition.wait(1)
                    continue
                key = min(self.pending, key=lambda k: self.pending[k][1])
                wait = self.pending[key][1] - time.monotonic()
                if wait > 0:
                    self.condition.wait(min(wait, 1))
                    continue
                del self.pending[key]
            try:
                self._run(*key)
            except Exception:
                # Failure belongs to a job, never to the upload ACK path.
                continue

    def _run(self, project, scan):
        identity = uuid.uuid4().hex
        root = self.directory / identity
        incoming, output = root / 'input', root / 'result'
        with self.receiver.lock:
            watermark = self.receiver.db.execute('SELECT COALESCE(MAX(seq),0) FROM events WHERE project=? AND scan=?', (project, scan)).fetchone()[0]
        with self.condition:
            existing = self.db.execute("SELECT 1 FROM jobs WHERE project=? AND scan=? AND watermark=? AND status IN ('completed','completed_with_gaps','partial')", (project, scan, watermark)).fetchone()
            if existing or not watermark or self.closed:
                return
            with self.db:
                self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,NULL,NULL)', (identity, project, scan, watermark, 'running', timestamp()))
        try:
            incoming.mkdir(parents=True)
            seed_manifest = self.receiver.export_snapshot(incoming, project, scan, watermark)
            (root / 'manifest.json').write_text(json.dumps(dict(id=identity, **seed_manifest), ensure_ascii=True))
            command = [sys.executable, '-m', 'website_js_extractor.cli', 'ingest', '--data-dir', str(incoming),
                       '--project', project, '--scan', scan, '--out', str(output)]
            env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[2])}
            with (root / 'analysis.log').open('w') as log:
                with self.condition:
                    if self.closed:
                        raise RuntimeError('Server stopped before analysis.')
                    self.process = subprocess.Popen(command, stdout=log, stderr=log, env=env, start_new_session=os.name == 'posix')
                    process = self.process
                try:
                    process.wait(timeout=self.deadline)
                except subprocess.TimeoutExpired:
                    terminate(process)
                    raise RuntimeError('Analysis deadline exceeded; process tree terminated.')
                finally:
                    with self.condition:
                        self.process = None
            report_path = output / 'analysis.json'
            report = json.loads(report_path.read_text()) if report_path.is_file() else {}
            status = report.get('task', {}).get('status', 'failed')
            if status not in {'completed', 'completed_with_gaps', 'partial'} or process.returncode not in {0, 4}:
                status = 'failed'
            error = None if status != 'failed' else 'Analysis failed; see server-side analysis log and report gaps.'
        except Exception as exc:
            status, error = 'failed', str(exc)[:2000]
        finally:
            # The normalized report owns its evidence copies. Do not retain full database backups per run.
            (incoming / 'capture.sqlite3').unlink(missing_ok=True)
        with self.condition, self.db:
            self.db.execute('UPDATE jobs SET status=?,finished=?,error=? WHERE id=?', (status, timestamp(), error, identity))
            self.condition.notify_all()

    def page(self, project, scan):
        with self.condition:
            rows = list(self.db.execute('SELECT id,watermark,status,created,finished,error FROM jobs WHERE project=? AND scan=? ORDER BY created DESC LIMIT 20', (project, scan)))
            pending = (project, scan) in self.pending
        jobs = [dict(zip(['id', 'watermark', 'status', 'created', 'finished', 'error'], row)) for row in rows]
        for job in jobs:
            path = self.directory/job['id']/'result/progress.json'
            if path.is_file():
                try: job['phase'] = json.loads(path.read_text()).get('phase')
                except (ValueError, OSError): pass
        return dict(pending=pending, jobs=jobs)

    def result(self, project, identity):
        with self.condition:
            row = self.db.execute('SELECT status FROM jobs WHERE project=? AND id=?', (project, identity)).fetchone()
        if not row:
            raise ValueError('Unknown analysis job.')
        path = self.directory / identity / 'result' / 'analysis.json'
        if not path.is_file():
            return dict(status=row[0], result=None)
        return dict(status=row[0], result=json.loads(path.read_text()))

    def close(self):
        with self.condition:
            self.closed = True
            if self.process is not None:
                terminate(self.process)
            self.condition.notify_all()
        self.thread.join(timeout=10)
        if not self.thread.is_alive():
            self.db.close()
