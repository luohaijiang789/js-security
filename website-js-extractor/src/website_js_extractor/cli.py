import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
import os
import signal
from pathlib import Path
import sys
import uuid

from . import __version__
from .assets import Snapshot, digest, http_url
from .acquisition import StaticFetcher
from .collection import ReferenceGraph, restore_snapshot
from .engine import LOCK, analyze, default_engine_root
from .results import build_candidates, write_report


def parser():
    root = argparse.ArgumentParser(description='Website JS candidates and reference graph; only explicitly enabled static-resource GETs.')
    root.add_argument('--version', action='version', version=__version__)
    commands = root.add_subparsers(dest='command', required=True)
    service = commands.add_parser('serve', help='Serve the paired browser prototype on 127.0.0.1 only.')
    service.add_argument('--port', type=int, default=8378)
    service.add_argument('--extension-id', required=True)
    service.add_argument('--data-dir', type=Path, required=True)
    service.add_argument('--engine-root', type=Path, default=default_engine_root())
    run = commands.add_parser('analyze')
    inputs = run.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--har', type=Path)
    inputs.add_argument('--capture', type=Path, help='Frozen capture-0.1 browser snapshot (offline).')
    inputs.add_argument('--directory', type=Path)
    inputs.add_argument('--resume', type=Path, help='Restore verified bodies from a previous output directory.')
    run.add_argument('--out', type=Path, required=True)
    run.add_argument('--page-url', help='Explicit execution page URL for a local directory.')
    run.add_argument('--engine-root', type=Path, default=default_engine_root())
    run.add_argument('--timeout', type=float, default=120, help='Total engine deadline in seconds across all contexts.')
    run.add_argument('--max-files', type=int, default=1000)
    run.add_argument('--max-asset-mib', type=int, default=20)
    run.add_argument('--max-total-mib', type=int, default=128)
    run.add_argument('--max-js-depth', type=int, default=3)
    run.add_argument('--seed-js', action='append', default=[], help='Explicit imported JS URL/location at depth 1.')
    run.add_argument('--discovery-timeout', type=float, default=60)
    run.add_argument('--fetch-js', action='store_true', help='Supplement certain JS references within the explicit origin allowlist.')
    run.add_argument('--allow-origin', action='append', default=[])
    run.add_argument('--fetch-timeout', type=float, default=10)
    run.add_argument('--fetch-deadline', type=float, default=60)
    run.add_argument('--fetch-retries', type=int, default=1)
    run.add_argument('--max-fetch-files', type=int, default=100)
    run.add_argument('--fetch-concurrency', type=int, default=4, help='Maximum concurrent static-resource requests (1-32).')
    run.add_argument('--session-file', type=Path, help='Local exact-origin header map; never copied into reports.')
    return root


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == 'serve':
        from .service import serve
        return serve(args)
    if os.environ.get('WEBSITE_JS_MANAGED_JOB') == '1':
        signal.signal(signal.SIGTERM, _interrupt)
    source = args.har or args.capture or args.directory or args.resume
    output = args.out.resolve()
    if source.is_symlink() or not source.exists() or ((args.har or args.capture) and not source.is_file()) or ((args.directory or args.resume) and not source.is_dir()):
        print('Invalid input path or symbolic link.', file=sys.stderr)
        return 2
    durations = [args.timeout, args.discovery_timeout, args.fetch_timeout, args.fetch_deadline]
    if any(not math.isfinite(v) or v <= 0 for v in durations) or min(args.max_files, args.max_asset_mib, args.max_total_mib, args.max_fetch_files) <= 0 or args.max_js_depth < 0 or not 0 <= args.fetch_retries <= 5 or not 1 <= args.fetch_concurrency <= 32:
        print('Budgets and timeout must be positive.', file=sys.stderr)
        return 2
    if args.page_url and (not args.directory or not http_url(args.page_url)):
        print('--page-url requires a directory and a valid HTTP/HTTPS page URL.', file=sys.stderr)
        return 2
    if (args.directory or args.resume) and (output == source.resolve() or source.resolve() in output.parents):
        print('Output must be outside the input directory.', file=sys.stderr)
        return 2
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        print('Output must be absent or an empty directory; refusing to overwrite.', file=sys.stderr)
        return 2
    try:
        output.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f'Cannot create output: {error}', file=sys.stderr)
        return 2
    snapshot = Snapshot(output, args.max_files, args.max_asset_mib*1024*1024, args.max_total_mib*1024*1024)
    task = dict(id=str(uuid.uuid4()), schema_version='0.5', tool_version=__version__, engine=LOCK,
                input=str(source.resolve()), input_type='capture' if args.capture else 'har' if args.har else 'resume' if args.resume else 'directory',
                started_at=datetime.now(timezone.utc).isoformat(), phase='import', status='running',
                settings=dict(timeout=args.timeout, max_files=args.max_files, max_asset_mib=args.max_asset_mib, max_total_mib=args.max_total_mib,
                              max_js_depth=args.max_js_depth, seed_js=args.seed_js, discovery_timeout=args.discovery_timeout,
                              fetch_js=args.fetch_js, allowed_origins=args.allow_origin, fetch_timeout=args.fetch_timeout,
                              fetch_deadline=args.fetch_deadline, max_fetch_files=args.max_fetch_files, fetch_retries=args.fetch_retries,
                              fetch_concurrency=args.fetch_concurrency))
    records, candidates, groups, other = [], [], [], []
    code = 0
    try:
        print('Importing local snapshot...', file=sys.stderr)
        if args.capture:
            from .capture import import_capture
            import_capture(snapshot, source)
        elif args.har:
            snapshot.import_har(source)
        elif args.resume:
            restore_snapshot(snapshot, source)
        else:
            snapshot.import_directory(source, args.page_url)
        snapshot.resolve_contexts()
        task['input_snapshot_sha256'] = digest([(a['id'], a['sha256']) for a in snapshot.assets])
        if not snapshot.assets:
            snapshot.gap('empty_input', 'No usable JS/HTML assets were imported.', incomplete=True)
        else:
            task['phase'] = 'collect'
            print('Discovering JS references'+(' and supplementing allowed scripts...' if args.fetch_js else ' offline...'), file=sys.stderr)
            fetcher = StaticFetcher(args.allow_origin, max_files=args.max_fetch_files, timeout=args.fetch_timeout,
                                    deadline=args.fetch_deadline, retries=args.fetch_retries, session_file=args.session_file) if args.fetch_js else None
            if args.session_file and not args.fetch_js:
                raise ValueError('--session-file is only used with --fetch-js.')
            ReferenceGraph(snapshot, args.engine_root, max_depth=args.max_js_depth,
                           timeout=args.discovery_timeout, seeds=args.seed_js, concurrency=args.fetch_concurrency).run(fetcher)
            task['collection_snapshot_sha256'] = digest([(a['id'], a['sha256']) for a in snapshot.assets])
            task['phase'] = 'analyze'
            print(f'Analyzing {len(snapshot.assets)} assets with pinned jshound...', file=sys.stderr)
            records = analyze(snapshot, args.engine_root, args.timeout)
            candidates, groups, other = build_candidates(snapshot, records)
        if any(gap['kind'] == 'engine_failed' for gap in snapshot.gaps):
            code = 3
        elif any(gap['incomplete'] for gap in snapshot.gaps):
            code = 4
    except (ValueError, OSError, TypeError) as error:
        snapshot.gap('input_error', str(error), incomplete=True)
        code = 2
    except RuntimeError as error:
        snapshot.gap('engine_error', str(error), incomplete=True)
        code = 3
    except KeyboardInterrupt:
        snapshot.gap('interrupted', 'Collection/analysis interrupted; saved bodies can be restored.', incomplete=True)
        code = 4
    task['status'] = 'completed_with_gaps' if code == 0 and snapshot.gaps else 'completed' if code == 0 else 'partial' if code == 4 else 'failed'
    task['stopped_phase'] = task['phase']
    task['phase'] = 'finished'
    task['exit_code'] = code
    task['finished_at'] = datetime.now(timezone.utc).isoformat()
    task['stop_reasons'] = sorted({gap['kind'] for gap in snapshot.gaps if gap['incomplete']})
    edges = getattr(snapshot, 'reference_edges', [])
    report = dict(task=task, contexts=snapshot.contexts, assets=snapshot.assets, candidates=candidates, api_group_previews=groups,
                  reference_edges=edges, fetch_events=getattr(snapshot, 'fetch_events', []),
                  fetch_statistics=getattr(snapshot, 'fetch_statistics', None),
                  collection_checkpoint='collection.json' if (output/'collection.json').exists() else None,
                  engine_record_file='engine-records.json', other_engine_record_ids=other, gaps=snapshot.gaps,
                  statistics=dict(imported_assets=sum(a.get('acquisition') not in {'static-supplement', 'worker-association'} for a in snapshot.assets),
                                  total_assets=len(snapshot.assets), associated_assets=sum(a.get('acquisition') == 'worker-association' for a in snapshot.assets), supplemented_assets=sum(a.get('acquisition') == 'static-supplement' for a in snapshot.assets),
                                  reference_edges=len(edges), reference_statuses=dict(Counter(e['status'] for e in edges)),
                                  asset_depths=dict(Counter(str(a.get('js_depth')) for a in snapshot.assets)), engine_records=len(records),
                                  candidate_records_by_depth=dict(Counter(str(c.get('js_depth')) for c in candidates)),
                                  request_candidates=len(candidates), concrete_candidate_groups=len(groups),
                                  confirmed_api_groups=None, call_context_count=None, unique_send_sites=None,
                                  gap_count=len(snapshot.gaps)))
    try:
        write_report(output, report, records)
    except OSError as error:
        print(f'Cannot write report: {error}', file=sys.stderr)
        return 2
    print(json.dumps(dict(status=task['status'], exit_code=code, **report['statistics'], output=str(output)), ensure_ascii=False))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
