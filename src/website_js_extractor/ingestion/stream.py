"""Ingest capture-stream-2 browser evidence into the static analysis core.

The receiver only stores bytes and immutable event envelopes.  This module turns
those envelopes into execution contexts, content-addressed scripts, observed JS
loads, real requests and gaps, then reuses the existing reference graph, jshound
engine and candidate builder.  It never executes browser JavaScript and it does
not treat observed traffic as proof of a static call site.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from website_js_extractor import __version__
from website_js_extractor.domain.assets import Snapshot, digest, http_url
from website_js_extractor.collection.pipeline import collect_assets
from website_js_extractor.domain.settings import AnalysisSettings
from website_js_extractor.analysis.engine import LOCK, analyze, default_engine_root
from website_js_extractor.analysis.results import build_candidates, write_report

from website_js_extractor.domain.protocol import SCHEMA
TASK_KINDS = {'TaskStarted', 'TaskCheckpoint'}
CONTEXT_KINDS = {'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
                 'Runtime.executionContextsCleared'}
NETWORK_KINDS = {'Network.requestWillBeSent', 'Network.responseReceived',
                 'Network.loadingFinished', 'Network.loadingFailed'}


class StreamError(ValueError):
    pass


def _method(value):
    if isinstance(value, str):
        value = value.upper()
        if value in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'}:
            return value
    return None


def _url(value):
    return http_url(value) if isinstance(value, str) else None


def _request_parts(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
        return None
    return parsed.scheme + '://' + parsed.netloc.lower(), parsed.path or '/', parsed.query


def _origin(value):
    parts = _request_parts(value)
    return parts[0] if parts else None


def _flatten_keys(value):
    if isinstance(value, dict):
        names = set()
        for key, item in value.items():
            names.add(str(key))
            if isinstance(item, dict):
                names.update(name if '.' in name else str(key) + '.' + name for name in _flatten_keys(item))
        return names
    if isinstance(value, list):
        names = set()
        for item in value:
            names.update(_flatten_keys(item))
        return names
    return set()


class EventReader:
    """Read the receiver's SQLite store read-only."""

    def __init__(self, data_dir, project='default'):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir/'capture.sqlite3'
        if not self.path.is_file():
            raise StreamError(f'Capture database not found: {self.path}')
        self.project = project
        try:
            self.db = sqlite3.connect(f'file:{self.path.as_posix()}?mode=ro', uri=True)
        except sqlite3.Error as error:
            raise StreamError(f'Cannot open capture database: {error}') from error
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA query_only=ON')

    def close(self):
        self.db.close()

    def scans(self):
        rows = self.db.execute(
            'SELECT scan, COUNT(*) AS events, MAX(seq) AS last FROM events '
            'WHERE project=? GROUP BY scan ORDER BY last DESC', (self.project,)).fetchall()
        return [dict(row) for row in rows]

    def latest_scan(self):
        scans = self.scans()
        return scans[0]['scan'] if scans else None

    def events(self, scan):
        rows = self.db.execute(
            'SELECT seq, payload FROM events WHERE project=? AND scan=? ORDER BY seq',
            (self.project, scan)).fetchall()
        result = []
        for row in rows:
            try:
                value = json.loads(row['payload'])
            except (TypeError, ValueError) as error:
                raise StreamError(f'Invalid event JSON at sequence {row["seq"]}: {error}') from error
            if not isinstance(value, dict):
                raise StreamError(f'Event at sequence {row["seq"]} is not an object.')
            transport = value.get('transport')
            if transport is not None and (not isinstance(transport, dict) or not isinstance(transport.get('stream_id'), str) or type(transport.get('sequence')) is not int or transport['sequence'] < 1):
                raise StreamError(f'Invalid event transport at receipt sequence {row["seq"]}.')
            value.setdefault('id', f'seq:{row["seq"]}')
            result.append(value)
        # Physical receipt order may differ from the browser's logical stream order.
        table = self.db.execute("SELECT 1 FROM sqlite_master WHERE name='delivery_windows'").fetchone()
        if table and rows:
            from website_js_extractor.storage.delivery_window import frozen_frontiers
            frontiers = frozen_frontiers(self.db, self.project, scan, rows[-1]['seq'])
            result = [event for event in result if (event.get('transport') or {}).get('stream_id') not in frontiers
                      or event['transport']['sequence'] <= frontiers[event['transport']['stream_id']]]
        self.delivery_selection = dict(delivery_frontiers=frontiers if table and rows else {}, deferred_events=len(rows)-len(result))
        selection = self.data_dir/'selection.json'
        if selection.is_file(): self.delivery_selection = json.loads(selection.read_text())
        streams = defaultdict(list)
        for event in result:
            if event.get('transport'): streams[event['transport']['stream_id']].append(event)
        ordered = {key: iter(sorted(values, key=lambda event: event['transport']['sequence'])) for key, values in streams.items()}
        return [next(ordered[event['transport']['stream_id']]) if event.get('transport') else event for event in result]

    def content_size(self, identity):
        row = self.db.execute('SELECT bytes FROM bodies WHERE project=? AND object_id=?',
                              (self.project, identity)).fetchone()
        return int(row['bytes']) if row else None

    def chunks(self, identity):
        size = self.content_size(identity)
        if size is None:
            raise StreamError(f'Content object is not committed: {identity}')
        offset = 0
        for row in self.db.execute(
                'SELECT offset, total, data FROM blobs WHERE project=? AND object_id=? ORDER BY offset',
                (self.project, identity)):
            if int(row['offset']) != offset or int(row['total']) != size:
                raise StreamError(f'Content chunks are not contiguous: {identity}')
            data = bytes(row['data'])
            offset += len(data)
            yield data
        if offset != size:
            raise StreamError(f'Content length mismatch: {identity}')

    def copy_content(self, identity, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        hasher = hashlib.sha256()
        length = 0
        with target.open('wb') as handle:
            for data in self.chunks(identity):
                hasher.update(data)
                handle.write(data)
                length += len(data)
        if hasher.hexdigest() != identity:
            target.unlink(missing_ok=True)
            raise StreamError(f'Content hash mismatch: {identity}')
        return length


class Ingest:
    def __init__(self, reader, scan, events, *, max_files, max_asset_bytes, max_total_bytes):
        self.reader = reader
        self.scan = scan
        self.events = events
        self.max_files = max_files
        self.max_asset_bytes = max_asset_bytes
        self.max_total_bytes = max_total_bytes
        self.task = {}
        self.contexts = {}
        self.assets = {}
        self.loads = {}
        self.observed = []
        self.content = {}
        self.gaps = []
        self.stats = Counter(events=len(events))
        from website_js_extractor.ingestion.raw import recover_raw
        recovered, self.raw_links, projections, issues, self.raw_statistics = recover_raw(events)
        self.observed.extend(recovered)
        self.events = projections + events
        for issue in issues:
            self.gap(issue['type'],issue['message'],source=issue.get('source'),request_id=issue.get('request_id'))
        self._consume()

    # ---- evidence normalization -------------------------------------------------

    def gap(self, kind, message, *, asset_id=None, request_id=None, incomplete=True, source=None):
        record = dict(kind=kind, message=message, asset_id=asset_id, request_id=request_id,
                      incomplete=incomplete, source=source)
        record['id'] = 'gap-' + digest(record)[:20]
        if record not in self.gaps:
            self.gaps.append(record)

    def _data(self, event):
        value = event.get('data')
        return value if isinstance(value, dict) else {}

    def _context_key(self, event, context_id):
        data = self._data(event)
        return (str(event.get('scan_id') or self.scan), str(event.get('epoch') or ''),
                str(event.get('tab_id') if event.get('tab_id') is not None else ''),
                str(event.get('session_id') or 'root'), str(data.get('target_id') or ''),
                str(context_id))

    def _plugin_gaps(self, scan):
        for item in scan.get('gaps') or []:
            if not isinstance(item, dict):
                continue
            self.gap('plugin_' + str(item.get('type') or 'unknown'),
                     str(item.get('reason') or '')[:2000], request_id=item.get('request_id'),
                     source=item.get('id') or item.get('timestamp'))

    def _context(self, event, context):
        context_id = context.get('id')
        if not isinstance(context_id, (int, str)) or isinstance(context_id, bool):
            self.gap('stream_context_invalid', 'Execution context has no usable id.', source=event.get('id'))
            return
        aux = context.get('auxData') if isinstance(context.get('auxData'), dict) else {}
        origin = context.get('origin')
        base = _url(origin) if origin not in (None, '', 'null') else None
        observed_tab = _url(self._data(event).get('observed_tab_url'))
        name = str(context.get('name') or '')
        worker = aux.get('type') in {'worker', 'service_worker', 'shared_worker'} or name.lower().endswith('worker')
        frame = not worker and aux.get('isDefault') is False
        kind = 'worker' if worker else 'frame' if frame else 'page'
        page = None
        tab_origin = _origin(observed_tab)
        if kind == 'page' and observed_tab and base and tab_origin == base.rstrip('/'):
            page = observed_tab
        elif kind == 'page' and observed_tab and base and tab_origin != base.rstrip('/'):
            kind = 'frame'
            self.gap('stream_context_page_scope',
                     'Default context origin differs from the observed tab; iframe page ownership is not inferred.',
                     source=event.get('id'))
        key = self._context_key(event, context_id)
        record = dict(id='ctx-' + digest(list(key))[:20], key=key,
                      scan_id=str(event.get('scan_id') or self.scan), epoch=event.get('epoch'),
                      tab_id=event.get('tab_id'), session_id=event.get('session_id') or 'root',
                      target_id=self._data(event).get('target_id'),
                      execution_context_id=context_id, origin=origin, name=context.get('name'),
                      aux_data=aux, kind=kind, page_url=page, request_base_url=base,
                      evidence='browser_execution_context', status='known' if base else 'unknown')
        if not base:
            self.gap('stream_context_origin_unknown',
                     'Execution context has no HTTP(S) origin; relative URLs remain unresolved.',
                     source=record['id'])
        if kind == 'page' and not page:
            self.gap('stream_page_unknown',
                     'Default execution context has no verified page URL; page is not inferred from a request URL.',
                     source=record['id'])
        if kind != 'page' and base:
            self.gap('stream_context_base_scope',
                     'Non-default execution context uses its origin as a provisional request base; page ownership is not inferred.',
                     source=record['id'])
        self.contexts[key] = record

    def _implicit_context(self, event, context_id):
        key = self._context_key(event, context_id)
        record = dict(id='ctx-' + digest(list(key))[:20], key=key,
                      scan_id=str(event.get('scan_id') or self.scan), epoch=event.get('epoch'),
                      tab_id=event.get('tab_id'), session_id=event.get('session_id') or 'root',
                      target_id=self._data(event).get('target_id'),
                      execution_context_id=context_id, origin=None, name=None, aux_data={},
                      kind='unknown', page_url=None, request_base_url=None,
                      evidence='script_without_execution_context', status='unknown')
        self.contexts[key] = record
        self.gap('stream_context_missing',
                 'Script was parsed without a matching execution-context event; page and Host remain unknown.',
                 source=record['id'])
        return record

    @staticmethod
    def _asset_context(context):
        if context['kind'] == 'page' and http_url(context.get('page_url')):
            return {'capture_context': dict(type='page', page_url=context['page_url'],
                                            request_base_url=context['request_base_url'],
                                            evidence='browser_execution_context')}
        return {'runtime_context': dict(type=context['kind'], page_url=None,
                                        request_base_url=context['request_base_url'],
                                        evidence=context['evidence'])}

    def _script(self, event, data):
        context_id = data.get('executionContextId')
        key = self._context_key(event, context_id)
        context = self.contexts.get(key)
        if context is None:
            context = self._implicit_context(event, context_id)
        status = event.get('status') or 'captured'
        # The receiver assigns object_id; the browser never computes it.
        identity = event.get('object_id')
        if status == 'deduplicated':
            # A later observation of an already-sent project+URL. Keep the
            # observation; it references the same committed body.
            self.stats['deduplicated_script_events'] += 1
        elif status != 'captured':
            self.gap('stream_' + str(status), str(data.get('error') or status)[:2000],
                     source=event.get('id'))
            return
        if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{64}', identity):
            self.gap('stream_source_missing', 'Script event has no object_id.', source=event.get('id'))
            return
        size = self.reader.content_size(identity)
        if size is None:
            self.gap('stream_content_missing', 'Script content was not durably committed by the receiver.',
                     source=identity)
            return
        if size > self.max_asset_bytes:
            self.gap('stream_content_budget', 'Script exceeds the per-asset byte budget.', source=identity)
            return
        if identity not in self.content:
            if sum(self.content.values()) + size > self.max_total_bytes:
                self.gap('stream_content_budget', 'Script exceeds the total content byte budget.', source=identity)
                return
            self.content[identity] = size
        url = _url(data.get('url'))
        observation = dict(id=event.get('id'), time=event.get('time'), status=status,
                           tab_id=event.get('tab_id'), session_id=event.get('session_id'),
                           epoch=event.get('epoch'), target_id=data.get('target_id'),
                           script_id=data.get('scriptId'), execution_context_id=context_id,
                           url=url, raw_url=data.get('url'), source_bytes=size,
                           representation=data.get('representation'), network_match=data.get('network_match'),
                           observed_tab_url=data.get('observed_tab_url'),
                           stack=data.get('stackTrace') or data.get('loading_stack'),
                           source_map_url=data.get('sourceMapURL'), cdp=data.get('cdp'))
        script_key = (context['id'], identity, url or '')
        asset = self.assets.get(script_key)
        if asset is None:
            if len(self.assets) >= self.max_files:
                self.gap('stream_asset_budget', 'Script count exceeds the configured file budget.', source=identity)
                return
            asset = dict(id='asset-' + digest(list(script_key))[:20], location=url or f'stream/{identity}.js',
                         url=url, sha256=identity, kind='js', context_id=context['id'],
                         page_url=context['page_url'], body_file=f'snapshot/{identity}.js',
                         bytes=size, analysis_status='pending', observations=[], acquisition='browser-capture',
                         source='browser-capture', first_seen=event.get('time'), last_seen=event.get('time'),
                         runtime_depth=None, runtime_depth_basis=None)
            asset.update(self._asset_context(context))
            self.assets[script_key] = asset
        asset['observations'].append(observation)
        asset['last_seen'] = event.get('time') or asset.get('last_seen')

    def _load_key(self, event, data):
        return (str(event.get('scan_id') or self.scan), str(event.get('epoch') or ''),
                str(event.get('session_id') or 'root'), str(data.get('request_id') or ''),
                int(data.get('redirect_hop') or 0))

    def _latest_load(self, event, data):
        request_id = str(data.get('request_id') or '')
        prefix = (str(event.get('scan_id') or self.scan), str(event.get('epoch') or ''),
                  str(event.get('session_id') or 'root'), request_id)
        keys = [key for key in self.loads if key[:4] == prefix]
        return self.loads[max(keys, key=lambda key: key[4])] if keys else None

    def _network(self, event, data):
        kind = event.get('kind')
        if kind == 'Network.requestWillBeSent':
            key = self._load_key(event, data)
            load = self.loads.get(key)
            if load is None:
                load = dict(key=key, scan_id=str(event.get('scan_id') or self.scan),
                            epoch=event.get('epoch'), tab_id=event.get('tab_id'),
                            session_id=event.get('session_id') or 'root', target_id=data.get('target_id'),
                            request_id=str(data.get('request_id') or ''), redirect_hop=int(data.get('redirect_hop') or 0),
                            url=_url(data.get('url')), raw_url=data.get('url'),
                            method=_method(data.get('method')), frame_id=data.get('frame_id'),
                            loader_id=data.get('loader_id'), document_url=_url(data.get('document_url')),
                            initiator=data.get('initiator') if isinstance(data.get('initiator'), dict) else None,
                            redirect=data.get('redirect') if isinstance(data.get('redirect'), dict) else None,
                            status=None, mime=None, error=None, finished=False, events=[],
                            time=event.get('time'))
                self.loads[key] = load
            load['events'].append(event.get('id'))
            if not load['url']:
                self.gap('stream_load_url_unknown', 'Observed script load has no HTTP(S) URL.', source=event.get('id'))
            return
        load = self._latest_load(event, data)
        if load is None:
            self.gap('stream_load_without_request', 'Network lifecycle event has no matching script request.',
                     source=event.get('id'))
            return
        load['events'].append(event.get('id'))
        if kind == 'Network.responseReceived':
            load['status'] = data.get('status') if isinstance(data.get('status'), int) else load.get('status')
            response = data.get('cdp', {}).get('response') if isinstance(data.get('cdp'), dict) else None
            if isinstance(response, dict):
                load['mime'] = response.get('mimeType')
                if not load.get('url'):
                    load['url'] = _url(response.get('url'))
        elif kind == 'Network.loadingFinished':
            load['finished'] = True
            cdp = data.get('cdp') if isinstance(data.get('cdp'), dict) else {}
            load['encoded_data_length'] = cdp.get('encodedDataLength')
        else:
            load['finished'] = True
            load['error'] = str(data.get('error') or 'loadingFailed')[:1000]

    def _consume(self):
        for event in self.events:
            kind = event.get('kind')
            data = self._data(event)
            if kind in TASK_KINDS:
                self.stats['task_events'] += 1
                scan = data.get('scan')
                if isinstance(scan, dict):
                    self.task = scan
                    self._plugin_gaps(scan)
                continue
            if kind == 'ObservedRequest':
                self.stats['observed_events'] += 1
                record = data.get('record')
                if not isinstance(record, dict):
                    self.gap('stream_observed_invalid', 'ObservedRequest has no record object.', source=event.get('id'))
                else:
                    self.observed.append({**record, **({'raw_event_ids':self.raw_links[record['request_id']]} if record.get('request_id') in self.raw_links else {})})
                continue
            if kind == 'Debugger.scriptParsed':
                self.stats['script_events'] += 1
                self._script(event, data)
                continue
            if kind == 'Runtime.executionContextCreated':
                self.stats['context_events'] += 1
                context = data.get('context')
                if isinstance(context, dict):
                    self._context(event, context)
                else:
                    self.gap('stream_context_invalid', 'Context event has no context object.', source=event.get('id'))
                continue
            if kind in CONTEXT_KINDS:
                self.stats['context_events'] += 1
                continue
            if kind in NETWORK_KINDS:
                self.stats['network_events'] += 1
                self._network(event, data)
                continue
            if kind == 'RawCdpEvent': continue
            self.stats['ignored_events'] += 1
        self._runtime_depths()

    def _runtime_depths(self):
        """Observed load depth; kept separate from static import depth."""
        by_url = defaultdict(list)
        for asset in self.assets.values():
            if asset.get('url'):
                by_url[asset['url']].append(asset)
        depth, parent = {}, {}
        for key, load in self.loads.items():
            initiator = load.get('initiator') or {}
            if load.get('redirect') and key[4] > 0:
                previous = (key[0], key[1], key[2], key[3], key[4]-1)
                if previous in self.loads:
                    parent[key] = previous
                    load['depth_basis'] = 'redirect'
                    continue
            if initiator.get('type') == 'parser':
                depth[key] = 1
                load['depth_basis'] = 'parser'
                continue
            if initiator.get('requestId'):
                previous = [candidate for candidate in self.loads
                            if candidate[1] == key[1] and candidate[2] == key[2]
                            and candidate[3] == str(initiator['requestId']) and candidate[4] < key[4]]
                if previous:
                    parent[key] = max(previous, key=lambda candidate: candidate[4])
                    load['depth_basis'] = 'initiator_request_id'
                else:
                    load['depth_basis'] = 'initiator_request_missing'
                continue
            if initiator.get('url'):
                candidates = [candidate for candidate, other in self.loads.items()
                              if other.get('url') == initiator['url'] and candidate != key
                              and other.get('tab_id') == load.get('tab_id')
                              and other.get('session_id') == load.get('session_id')
                              and other.get('epoch') == load.get('epoch')]
                if len(candidates) == 1:
                    parent[key] = candidates[0]
                    load['depth_basis'] = 'initiator_url'
                else:
                    load['depth_basis'] = 'initiator_url_ambiguous' if candidates else 'initiator_url_missing'
                continue
            load['depth_basis'] = 'initiator_unknown'
        for _ in range(8):
            changed = False
            for key in self.loads:
                if depth.get(key) is not None:
                    continue
                previous = parent.get(key)
                if previous is not None and depth.get(previous) is not None:
                    depth[key] = depth[previous] + 1
                    changed = True
            if not changed:
                break
        unknown = 0
        for key, load in self.loads.items():
            value = depth.get(key)
            load['runtime_depth'] = value
            if value is None:
                unknown += 1
            if not load.get('url'):
                continue
            for asset in by_url.get(load['url'], []):
                if not any(item.get('tab_id') == load.get('tab_id') and item.get('epoch') == load.get('epoch')
                           for item in asset.get('observations', [])):
                    continue
                if value is not None and (asset.get('runtime_depth') is None or value < asset['runtime_depth']):
                    asset['runtime_depth'] = value
                    asset['runtime_depth_basis'] = load.get('depth_basis')
        if unknown:
            self.gap('stream_runtime_depth_unknown',
                     f'{unknown} observed script load(s) have no verifiable parent; runtime depth is not a static import depth.',
                     source=self.scan)

    # ---- snapshot ---------------------------------------------------------------

    def build_snapshot(self, output):
        snapshot = Snapshot(output, self.max_files, self.max_asset_bytes, self.max_total_bytes)
        snapshot.scan_id = self.scan
        snapshot.task = self.task
        snapshot.capture_contexts = list(self.contexts.values())
        snapshot.runtime_loads = sorted(self.loads.values(), key=lambda item: (
            str(item.get('time') or ''), item.get('request_id') or '', item.get('redirect_hop') or 0))
        snapshot.observed_requests = self.observed
        snapshot.stream_statistics = dict(self.stats)
        selection = getattr(self.reader, 'delivery_selection', {})
        if selection.get('deferred_events'):
            snapshot.gap('delivery_sequence_pending', 'Later durable receipts are awaiting an earlier sequence; excluded from this frozen input.', incomplete=True, source=selection)
        snapshot.gaps.extend(self.gaps)
        copied = {}
        for identity, size in self.content.items():
            target = output/'snapshot'/(identity + '.js')
            try:
                actual = self.reader.copy_content(identity, target)
            except (StreamError, OSError) as error:
                snapshot.gap('stream_content_read_failed', str(error)[:2000], incomplete=True, source=identity)
                continue
            if actual != size:
                target.unlink(missing_ok=True)
                snapshot.gap('stream_content_length_mismatch', 'Committed content length changed before analysis.',
                             incomplete=True, source=identity)
                continue
            head = target.read_bytes()[:512].lstrip(b'\xef\xbb\xbf \r\n\t').lower()
            if head.startswith((b'<!doctype html', b'<html', b'<head', b'<body')):
                target.unlink(missing_ok=True)
                snapshot.gap('html_instead_of_js', 'Captured script source is HTML, not JavaScript.',
                             incomplete=True, source=identity)
                continue
            copied[identity] = size
        for asset in self.assets.values():
            if asset['sha256'] not in copied:
                continue
            snapshot.assets.append(asset)
            snapshot._by_id[asset['id']] = asset
        snapshot.total_bytes = sum(copied.values())
        snapshot.resolve_contexts()
        return snapshot


def _candidate_regex(path):
    pattern = re.escape(path)
    pattern = re.sub(r'\\\{[^}]*\\\}', '[^/]+', pattern)
    return re.compile('^' + pattern + '/?$')


def _observed_parameters(record):
    query = []
    for item in record.get('query_params') or []:
        if isinstance(item, dict) and isinstance(item.get('name'), str):
            query.append(dict(name=item['name'], value=item.get('value')))
    if not query:
        try:
            query = [dict(name=name, value=value) for name, value in
                     parse_qsl(urlsplit(record.get('request_url') or '').query, keep_blank_values=True)]
        except ValueError:
            query = []
    body = record.get('request_body') if isinstance(record.get('request_body'), dict) else {}
    parsed = body.get('parsed')
    keys = sorted(_flatten_keys(parsed)) if isinstance(parsed, (dict, list)) else []
    return query, keys


def build_inventory(snapshot, candidates):
    """Associate static candidates and real requests conservatively, without merging counts."""
    assets = {asset['id']: asset for asset in snapshot.assets}
    static = defaultdict(list)
    unresolved = []
    for candidate in candidates:
        host, method, path = candidate.get('host'), _method(candidate.get('method')), candidate.get('path')
        if not host or not method or not path:
            unresolved.append(dict(candidate_id=candidate['id'], reason='static_host_method_or_path_unknown',
                                   url=candidate.get('url'), url_expression=candidate.get('url_expression'),
                                   asset_id=candidate.get('asset_id')))
            continue
        key = (host.lower(), method, path)
        static[key].append(candidate)
    observed = defaultdict(list)
    for record in snapshot.observed_requests:
        parts = _request_parts(record.get('request_url'))
        method = _method(record.get('method'))
        if not parts or not method:
            unresolved.append(dict(request_id=record.get('request_id'), reason='observed_url_or_method_unknown',
                                   url=record.get('request_url')))
            continue
        observed[(parts[0], method, parts[1])].append(record)
    static_regex = {key: _candidate_regex(key[2]) for key in static}
    assignments = {}
    for observed_key, records in observed.items():
        host, method, path = observed_key
        exact = (host, method, path)
        if exact in static:
            assignments[observed_key] = exact
            continue
        candidates = [key for key in static
                      if key[0] == host and key[1] == method and static_regex[key].match(path)]
        if len(candidates) == 1:
            assignments[observed_key] = candidates[0]
        elif len(candidates) > 1:
            # Do not guess between multiple static templates that match the same concrete path.
            unresolved.append(dict(kind='observed', request_ids=sorted(str(item.get('request_id') or '') for item in records),
                                   reason='ambiguous_static_match', observed_url=records[0].get('request_url'),
                                   candidate_ids=sorted(item['id'] for key in candidates for item in static[key])))
        else:
            assignments[observed_key] = None
    rows = []
    for key, members in static.items():
        host, method, path = key
        matches = [record for observed_key, records in observed.items()
                   if assignments.get(observed_key) == key for record in records]
        rows.append(_inventory_row(snapshot, assets, host, method, path, members, matches))
    for key, records in observed.items():
        if assignments.get(key) is not None:
            continue
        host, method, path = key
        rows.append(_inventory_row(snapshot, assets, host, method, path, [], records))
    rows.sort(key=lambda row: (row['host'], row['method'], row['path_template']))
    return rows, unresolved


def _inventory_row(snapshot, assets, host, method, path, members, records):
    candidate_ids = sorted({item['id'] for item in members})
    request_ids = sorted({str(item.get('request_id') or item.get('id') or '') for item in records})
    js_files = sorted({(assets.get(item['asset_id']) or {}).get('url')
                       or (assets.get(item['asset_id']) or {}).get('location')
                       for item in members if item.get('asset_id') in assets} - {None})
    if not js_files:
        js_files = sorted({str(item.get('initiator_url')) for item in records if item.get('initiator_url')})
    static_parameters = [field for item in members for field in item.get('parameters', [])]
    query, body_keys = [], []
    for record in records:
        item_query, item_body = _observed_parameters(record)
        query.extend(item_query)
        body_keys.extend(item_body)
    # Query values may differ per request; preserve names and observed examples rather than inventing one value.
    query_by_name = {}
    for item in query:
        query_by_name.setdefault(item['name'], []).append(item.get('value'))
    observed_query = [dict(name=name, values=values) for name, values in sorted(query_by_name.items())]
    sources = []
    if members:
        sources.append('static')
    if records:
        sources.append('observed')
    contexts = set()
    for item in members:
        asset = assets.get(item.get('asset_id'))
        if asset and asset.get('context_id'):
            contexts.add(asset['context_id'])
    return dict(id='api-' + digest([host, method, path])[:20], host=host, method=method,
                url_template=host + path, path_template=path, sources=sources,
                status='matched' if members and records else 'static-only' if members else 'observed-only',
                static_candidate_ids=candidate_ids, static_candidate_count=len(candidate_ids),
                observed_request_ids=request_ids, observed_count=len(set(request_ids)) or len(records),
                observed_request_count=len(records), raw_recovered_request_count=sum(record.get("recovery")=="raw-cdp" for record in records), observed_urls=sorted(
                    {str(item.get('request_url')) for item in records if item.get('request_url')}),
                page_urls=sorted({str(item.get('page_url')) for item in records if item.get('page_url')}),
                status_codes=sorted({item.get('status_code') for item in records
                                     if isinstance(item.get('status_code'), int)}),
                contexts=sorted(contexts), js_files=js_files,
                parameters=dict(static=static_parameters, observed_query=observed_query,
                                observed_body_keys=sorted(set(body_keys))),
                evidence=dict(static_candidate_ids=candidate_ids, observed_request_ids=request_ids, raw_event_ids=sorted({identity for record in records for identity in record.get("raw_event_ids",[])})))


def _write_inventory(output, report):
    inventory = report.get('api_inventory') or []
    observed = report.get('observed_requests') or []
    (output/'api_inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')
    (output/'observed_requests.json').write_text(json.dumps(observed, ensure_ascii=False, indent=2), encoding='utf-8')
    from website_js_extractor.analysis.results import write_csv
    write_csv(output/'api_inventory.csv',
              ['id', 'host', 'method', 'url_template', 'path_template', 'status', 'sources',
               'static_candidate_count', 'observed_count', 'observed_request_count', 'observed_urls',
               'page_urls', 'status_codes', 'js_files', 'contexts'], inventory)
    write_csv(output/'observed_requests.csv',
              ['request_id', 'request_url', 'method', 'status_code', 'page_url', 'initiator_url', 'tab_id', 'timestamp'],
              observed)


def _progress(output, phase, **values):
    path = output/'progress.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(phase=phase, **values)), encoding='utf-8')
    temporary.replace(path)


def ingest(args):
    data_dir = args.data_dir.resolve()
    output = args.out.resolve()
    if data_dir.is_symlink() or not data_dir.is_dir():
        print('Invalid capture data directory.', file=sys.stderr)
        return 2
    if output == data_dir or data_dir in output.parents:
        print('Output must be outside the capture data directory.', file=sys.stderr)
        return 2
    if any(not math.isfinite(value) or value <= 0 for value in (args.timeout, args.discovery_timeout)) \
            or min(args.max_files, args.max_asset_mib, args.max_total_mib) <= 0 or (args.max_js_depth is not None and not 1 <= args.max_js_depth <= 32):
        print('Budgets and timeout must be positive.', file=sys.stderr)
        return 2
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        print('Output must be absent or an empty directory; refusing to overwrite.', file=sys.stderr)
        return 2
    try:
        output.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f'Cannot create output: {error}', file=sys.stderr)
        return 2
    reader = None
    ingest_state = None
    snapshot = None
    code = 0
    records, candidates, groups, other = [], [], [], []
    inventory, unresolved = [], []
    statistics = {}
    collection_manifest = None
    task = dict(id=str(args.scan or ''), schema_version='0.5', tool_version=__version__, engine=LOCK,
                input=str(data_dir), input_type=SCHEMA, started_at=datetime.now(timezone.utc).isoformat(),
                phase='ingest', status='running', settings=dict(project=args.project, scan=args.scan,
                                                                 max_files=args.max_files,
                                                                 max_asset_mib=args.max_asset_mib,
                                                                 max_total_mib=args.max_total_mib,
                                                                 max_js_depth=args.max_js_depth))
    try:
        reader = EventReader(data_dir, args.project)
        scan = args.scan or reader.latest_scan()
        if not scan:
            raise StreamError('No capture events are stored for this project.')
        task['id'] = scan
        events = reader.events(scan)
        if any(event.get('kind')=='RawCdpEvent' for event in events):
            with (output/'raw-notifications.jsonl').open('w',encoding='utf-8') as raw_output:
                for event in events:
                    if event.get('kind')=='RawCdpEvent': raw_output.write(json.dumps(event,ensure_ascii=True,allow_nan=False)+'\n')
        print(f'Ingesting {len(events)} capture event(s) for scan {scan}...', file=sys.stderr)
        ingest_state = Ingest(reader, scan, events, max_files=args.max_files,
                              max_asset_bytes=args.max_asset_mib*1024*1024,
                              max_total_bytes=args.max_total_mib*1024*1024)
        snapshot = ingest_state.build_snapshot(output)
        task['input_snapshot_sha256'] = digest([(asset['id'], asset['sha256']) for asset in snapshot.assets])
        task['capture_scan'] = ingest_state.task
        configuration = dict((ingest_state.task.get('config') or {}).get('analysis') or {})
        if args.max_js_depth is not None: configuration['max_js_depth'] = args.max_js_depth
        if getattr(args, 'offline', False): configuration['fetch_js'] = False
        if getattr(args, 'allow_origin', None):
            configuration['allowed_origins'] = list(configuration.get('allowed_origins', [])) + args.allow_origin
        settings = AnalysisSettings.parse(configuration)
        task['settings'].update(settings.document())
        task['phase'] = 'collect'
        _progress(output, 'collecting', settings=settings.document())
        if not snapshot.assets:
            snapshot.gap('empty_input', 'No complete JS content was available from the capture store.', incomplete=True)
        else:
            print('Collecting recursive JS dependencies before unified analysis...', file=sys.stderr)
            collection_manifest = collect_assets(snapshot, args.engine_root, settings, timeout=args.discovery_timeout)
            task['collection_manifest_hash'] = collection_manifest['manifest_hash']
            _progress(output, 'frozen', assets=len(snapshot.assets), collection_status=collection_manifest['status'])
            task['phase'] = 'analyze'
            _progress(output, 'analyzing', assets=len(snapshot.assets))
            print(f'Analyzing {len(snapshot.assets)} captured assets with pinned jshound...', file=sys.stderr)
            records = analyze(snapshot, args.engine_root, args.timeout)
            candidates, groups, other = build_candidates(snapshot, records)
        inventory, unresolved = build_inventory(snapshot, candidates)
        task['phase'] = 'associate'
        statistics = dict(
            assets=len(snapshot.assets) if snapshot else 0,
            contexts=len(getattr(snapshot, 'capture_contexts', [])) if snapshot else 0,
            observed_requests=len(getattr(snapshot, 'observed_requests', [])) if snapshot else 0,
            runtime_loads=len(getattr(snapshot, 'runtime_loads', [])) if snapshot else 0,
            static_candidates=len(candidates),
            deduplicated_script_events=ingest_state.stats.get('deduplicated_script_events', 0),
            api_groups=len(inventory),
            matched_api_groups=sum(row['status'] == 'matched' for row in inventory),
            observed_only_groups=sum(row['status'] == 'observed-only' for row in inventory),
            static_only_groups=sum(row['status'] == 'static-only' for row in inventory),
            unresolved=len(unresolved),
            runtime_depths=dict(Counter(str(asset.get('runtime_depth')) for asset in (snapshot.assets if snapshot else []))),
            static_depths=dict(Counter(str(asset.get('js_depth')) for asset in (snapshot.assets if snapshot else []))),
            engine_records=len(records),
            gaps=len(snapshot.gaps) if snapshot else 0)
        if any(gap['kind'] == 'engine_failed' for gap in snapshot.gaps):
            code = 3
        elif any(gap['incomplete'] for gap in snapshot.gaps):
            code = 4
    except StreamError as error:
        print(f'Invalid capture input: {error}', file=sys.stderr)
        if snapshot:
            snapshot.gap('stream_input_error', str(error), incomplete=True)
        code = 2
    except (ValueError, OSError, TypeError) as error:
        print(f'Invalid capture input: {error}', file=sys.stderr)
        if snapshot:
            snapshot.gap('input_error', str(error), incomplete=True)
        code = 2
    except RuntimeError as error:
        print(f'Analysis engine error: {error}', file=sys.stderr)
        if snapshot:
            snapshot.gap('engine_error', str(error), incomplete=True)
        code = 3
    except KeyboardInterrupt:
        if snapshot:
            snapshot.gap('interrupted', 'Ingest/analysis interrupted.', incomplete=True)
        code = 4
    finally:
        if reader:
            reader.close()
    task['status'] = 'completed_with_gaps' if code == 0 and snapshot and snapshot.gaps else 'completed' if code == 0 else 'partial' if code == 4 else 'failed'
    task['stopped_phase'] = task.get('phase')
    task['phase'] = 'finished'
    task['exit_code'] = code
    task['finished_at'] = datetime.now(timezone.utc).isoformat()
    task['stop_reasons'] = sorted({gap['kind'] for gap in (snapshot.gaps if snapshot else []) if gap['incomplete']})
    report = dict(task=task, contexts=getattr(snapshot, 'contexts', []) if snapshot else [],
                  capture_contexts=getattr(snapshot, 'capture_contexts', []) if snapshot else [],
                  assets=getattr(snapshot, 'assets', []) if snapshot else [],
                  candidates=candidates, api_group_previews=groups,
                  reference_edges=getattr(snapshot, 'reference_edges', []) if snapshot else [],
                  fetch_events=getattr(snapshot, 'fetch_events', []), fetch_statistics=getattr(snapshot, 'fetch_statistics', None),
                  analysis_manifest='analysis-manifest.json' if collection_manifest else None,
                  collection_summary=collection_manifest,
                  input_delivery=getattr(reader, 'delivery_selection', {}),
                  raw_capture=getattr(ingest_state, 'raw_statistics', {}),
                  raw_evidence_file='raw-notifications.jsonl' if (output/'raw-notifications.jsonl').exists() else None,
                  collection_checkpoint='collection.json' if (output/'collection.json').exists() else None,
                  engine_record_file='engine-records.json', other_engine_record_ids=other,
                  gaps=getattr(snapshot, 'gaps', []) if snapshot else [],
                  observed_requests=getattr(snapshot, 'observed_requests', []) if snapshot else [],
                  api_inventory=inventory,
                  runtime_loads=getattr(snapshot, 'runtime_loads', []) if snapshot else [],
                  unresolved_evidence=unresolved,
                  statistics=statistics)
    try:
        write_report(output, report, records)
        _write_inventory(output, report)
        _progress(output, task['status'], assets=len(report['assets']), gaps=len(report['gaps']))
    except OSError as error:
        print(f'Cannot write report: {error}', file=sys.stderr)
        return 2
    print(json.dumps(dict(status=task['status'], exit_code=code, **report['statistics'], output=str(output)),
                     ensure_ascii=False))
    return code