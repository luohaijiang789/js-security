import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

LOCK = json.loads(Path(__file__).with_name('engine-lock.json').read_text())


def default_engine_root():
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for parent in (start, *start.parents):
            candidate = parent/'references/repos/jshound'
            if (candidate/'jshound/__init__.py').is_file():
                return candidate
    return Path('references/repos/jshound')


def verify_engine(root):
    root = Path(root).resolve()
    if not (root/'jshound/__init__.py').is_file():
        raise RuntimeError('Pinned jshound checkout is missing; initialize references/repos/jshound.')
    if not shutil.which('node'):
        raise RuntimeError('Node.js is required by the pinned JS parser.')
    version = subprocess.run(['node', '--version'], capture_output=True, text=True)
    major = re.match(r'v(\d+)\.', version.stdout.strip())
    if version.returncode != 0 or not major or int(major[1]) < 18:
        raise RuntimeError('Node.js 18 or newer is required.')
    try:
        top = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], text=True).strip()
        sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
        clean = subprocess.run(['git', '-C', str(root), 'diff', '--quiet', 'HEAD', '--']).returncode == 0
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError('Cannot verify pinned engine source.') from error
    if Path(top).resolve() != root or sha != LOCK['commit'] or not clean:
        raise RuntimeError(f"Engine must be an unchanged checkout of {LOCK['commit']}.")
    return root


def stage_group(snapshot, assets, number):
    directory = snapshot.output/'engine-input'/f'group-{number}'
    directory.mkdir(parents=True)
    mapping, origins, names = {}, [], set()
    for asset in assets:
        if asset['url']:
            # Preserve relative module imports instead of renaming every JS to its hash.
            parsed = urlsplit(asset['url'])
            parts = PurePosixPath(parsed.path.lstrip('/')).parts
            if any(part in {'..', '.'} for part in parts):
                relative = Path(asset['id'] + ('.js' if asset['kind'] == 'js' else '.html'))
                snapshot.gap('module_identity_partial', 'URL path cannot be represented safely in the engine view.', asset_id=asset['id'], incomplete=True)
            else:
                relative = Path(parsed.scheme, parsed.netloc, *parts)
                expected = {'.js', '.mjs'} if asset['kind'] == 'js' else {'.html', '.htm'}
                if relative.suffix not in expected:
                    relative = Path(str(relative)+('.js' if asset['kind'] == 'js' else '.html'))
                if parsed.query:
                    relative = relative.with_name(asset['id']+'-'+relative.name)
                    snapshot.gap('module_identity_partial', 'Query-bearing asset needs URL-based module resolution; original URL is retained.', asset_id=asset['id'], incomplete=True)
        else:
            parts = PurePosixPath(asset['location']).parts
            if not parts or any(part in {'..', '.', ''} for part in parts) or PurePosixPath(asset['location']).is_absolute():
                raise ValueError('Unsafe local asset path.')
            relative = Path(*parts)
        basename = relative.name
        if basename in names:
            snapshot.gap('engine_basename_collision', 'Upstream maps some metadata by basename; source association may be incomplete.', incomplete=True, asset_id=asset['id'])
        names.add(basename)
        target = directory/relative
        if str(target.resolve()) in mapping:
            relative = relative.with_name(asset['id']+'-'+relative.name)
            target = directory/relative
            snapshot.gap('module_identity_partial', 'Engine file paths would collide; kept separate without guessing module equivalence.', asset_id=asset['id'], incomplete=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Copy original bytes. Never edit input or execute its contents.
        shutil.copyfile(snapshot.output/asset['body_file'], target)
        mapping[str(target.resolve())] = asset
        if asset['url'] and asset.get('request_base_url'):
            origins.append({'f': relative.as_posix(), 'u': asset['url'], 'd': asset['request_base_url']})
    (directory/'_origin.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in origins), encoding='utf-8')
    return directory, mapping


def source_asset(path, mapping):
    if not path:
        return None
    full = str(Path(path).resolve())
    if full in mapping:
        return mapping[full]
    # Inline script extraction changes the filename, not its owning HTML asset.
    name = Path(path).name
    candidates = [a for p, a in mapping.items() if a['kind'] == 'html' and name.startswith(Path(p).name+'.inline')]
    return candidates[0] if len(candidates) == 1 else None


def analyze(snapshot, engine_root, timeout):
    root = verify_engine(engine_root)
    results = []
    deadline = time.monotonic()+timeout
    engine_out = snapshot.output/'engine'
    engine_out.mkdir()
    for number, assets in enumerate(snapshot.groups()):
        if time.monotonic() >= deadline:
            snapshot.gap('engine_timeout', 'Total analysis deadline reached.', incomplete=True)
            break
        directory, mapping = stage_group(snapshot, assets, number)
        output = engine_out/f'group-{number}.json'
        command = [sys.executable, '-I', str(Path(__file__).with_name('worker.py')), str(root), str(directory), str(output)]
        with (engine_out/f'group-{number}.log').open('w') as log:
            process = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
            try:
                process.wait(timeout=max(0.001, deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                snapshot.gap('engine_timeout', 'Engine process group terminated at the total deadline.', incomplete=True, source=f'group-{number}')
                break
            except BaseException:
                if process.poll() is None:
                    if os.name == 'posix':
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    else:
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
                    process.wait()
                raise
        if process.returncode != 0 or not output.exists():
            snapshot.gap('engine_failed', 'Engine did not produce usable records; see engine log.', incomplete=True, source=f'group-{number}')
            for asset in assets:
                asset['analysis_status'] = 'failed'
            continue
        try:
            data = json.loads(output.read_text())
            if not isinstance(data['records'], list) or not isinstance(data['parse_audit'], list):
                raise ValueError('Invalid worker output')
        except (ValueError, KeyError) as error:
            raise RuntimeError('Invalid engine result.') from error
        for audit in data['parse_audit']:
            asset = source_asset(audit['file'], mapping)
            if asset:
                asset['analysis_status'] = 'read' if audit['status'] == 'parsed' else audit['status']
            if audit['status'] != 'parsed':
                snapshot.gap('parse_'+audit['status'], '; '.join(audit['errors']), asset_id=asset['id'] if asset else None, incomplete=True)
            for warning in audit.get('warnings', []):
                snapshot.gap('engine_model_gap', 'Potential single-segment fetch URL is not recovered by this pinned engine; binding is unverified: '+str(warning), asset_id=asset['id'] if asset else None)
        for asset in assets:
            if asset['analysis_status'] == 'pending':
                if asset['kind'] == 'html':
                    asset['analysis_status'] = 'context_read'
                else:
                    snapshot.gap('not_analyzed', 'Asset was imported but not reported as parsed by the engine.', asset_id=asset['id'], incomplete=True)
        for index, record in enumerate(data['records']):
            if not isinstance(record, dict):
                raise RuntimeError('Engine record must be an object.')
            asset = source_asset(record.get('_file'), mapping)
            results.append(dict(id=f'engine-{number}-{index}', group=number, asset_id=asset['id'] if asset else None, raw=record))
    return results
