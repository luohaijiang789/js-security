import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
import uuid

from . import __version__
from .assets import Snapshot, digest, http_url
from .engine import LOCK, analyze, default_engine_root
from .results import build_candidates, write_report


def parser():
    root = argparse.ArgumentParser(description='Offline website JS candidate analysis; no API requests are sent.')
    root.add_argument('--version', action='version', version=__version__)
    commands = root.add_subparsers(dest='command', required=True)
    run = commands.add_parser('analyze')
    inputs = run.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--har', type=Path)
    inputs.add_argument('--directory', type=Path)
    run.add_argument('--out', type=Path, required=True)
    run.add_argument('--page-url', help='Explicit execution page URL for a local directory.')
    run.add_argument('--engine-root', type=Path, default=default_engine_root())
    run.add_argument('--timeout', type=float, default=120, help='Total engine deadline in seconds across all contexts.')
    run.add_argument('--max-files', type=int, default=1000)
    run.add_argument('--max-asset-mib', type=int, default=20)
    run.add_argument('--max-total-mib', type=int, default=128)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    source = args.har or args.directory
    output = args.out.resolve()
    if source.is_symlink() or not source.exists() or (args.har and not source.is_file()) or (args.directory and not source.is_dir()):
        print('Invalid input path or symbolic link.', file=sys.stderr)
        return 2
    if not math.isfinite(args.timeout) or args.timeout <= 0 or min(args.max_files, args.max_asset_mib, args.max_total_mib) <= 0:
        print('Budgets and timeout must be positive.', file=sys.stderr)
        return 2
    if args.page_url and (not args.directory or not http_url(args.page_url)):
        print('--page-url requires a directory and a valid HTTP/HTTPS page URL.', file=sys.stderr)
        return 2
    if args.directory and (output == source.resolve() or source.resolve() in output.parents):
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
    task = dict(id=str(uuid.uuid4()), schema_version='0.1', tool_version=__version__, engine=LOCK,
                input=str(source.resolve()), input_type='har' if args.har else 'directory',
                started_at=datetime.now(timezone.utc).isoformat(), phase='import', status='running',
                settings=dict(timeout=args.timeout, max_files=args.max_files, max_asset_mib=args.max_asset_mib, max_total_mib=args.max_total_mib))
    records, candidates, groups, other = [], [], [], []
    code = 0
    try:
        print('Importing local snapshot...', file=sys.stderr)
        if args.har:
            snapshot.import_har(source)
        else:
            snapshot.import_directory(source, args.page_url)
        snapshot.resolve_contexts()
        task['input_snapshot_sha256'] = digest([(a['id'], a['sha256']) for a in snapshot.assets])
        if not snapshot.assets:
            snapshot.gap('empty_input', 'No usable JS/HTML assets were imported.', incomplete=True)
        else:
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
    task['status'] = 'completed_with_gaps' if code == 0 and snapshot.gaps else 'completed' if code == 0 else 'partial' if code == 4 else 'failed'
    task['stopped_phase'] = task['phase']
    task['phase'] = 'finished'
    task['exit_code'] = code
    task['finished_at'] = datetime.now(timezone.utc).isoformat()
    task['stop_reasons'] = sorted({gap['kind'] for gap in snapshot.gaps if gap['incomplete']})
    report = dict(task=task, contexts=snapshot.contexts, assets=snapshot.assets, candidates=candidates, api_group_previews=groups,
                  engine_record_file='engine-records.json', other_engine_record_ids=other, gaps=snapshot.gaps,
                  statistics=dict(imported_assets=len(snapshot.assets), engine_records=len(records),
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
