"""Recheck frozen upstream inputs without checking generated reports into Git."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT/'work/blackbox2-tools'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--public', action='store_true', help='Also analyze the pinned public Swagger UI bundle.')
    args = parser.parse_args()
    fixture = WORK/'fixture'
    expected = json.loads((ROOT/'references/blackbox2-experiment/fixture-manifest.json').read_text())
    for name, sha in expected['hashes'].items():
        if hashlib.sha256((fixture/name).read_bytes()).hexdigest() != sha:
            raise SystemExit(f'Frozen fixture mismatch: {name}')
    compressed = json.loads(Path(__file__).with_name('minified-manifest.json').read_text())
    for name, sha in compressed['sha256'].items():
        if hashlib.sha256((WORK/'fixture-min'/name).read_bytes()).hexdigest() != sha:
            raise SystemExit(f'Frozen minified fixture mismatch: {name}')
    target = ROOT/'work'/('site-analyzer-check-'+uuid.uuid4().hex[:10])
    target.mkdir()
    entries = []
    for name in expected['hashes']:
        html = name.endswith('.html')
        body = (fixture/name).read_bytes()
        # Frozen HTML declares /main.js. Keep this HAR consistent with that URL;
        # CDN execution/request bases are covered separately by integration tests.
        entries.append(dict(pageref='p1', _resourceType='document' if html else 'script',
                            request={'url': 'https://fixture.example.test/' if html else 'https://fixture.example.test/'+name},
                            response={'status': 200, 'content': {'mimeType': 'text/html' if html else 'application/javascript',
                                      'encoding': 'base64', 'text': base64.b64encode(body).decode()}}))
    har = target/'fixture.har'
    har.write_text(json.dumps({'log': {'version': '1.2', 'pages': [{'id': 'p1', 'title': 'https://fixture.example.test/'}], 'entries': entries}}))
    commands = [
        ('directory', ['--directory', str(fixture), '--page-url', 'https://fixture.example.test/']),
        ('har', ['--har', str(har)]),
        ('minified', ['--directory', str(WORK/'fixture-min'), '--page-url', 'https://fixture.example.test/']),
    ]
    if args.public:
        sample = json.loads((ROOT/'references/blackbox2-experiment/public-sample.json').read_text())
        public = WORK/'public-swagger-ui/swagger-ui-bundle.js'
        if hashlib.sha256(public.read_bytes()).hexdigest() != sample['sha256']:
            raise SystemExit('Public sample hash mismatch')
        commands.append(('public', ['--directory', str(public.parent)]))
    summary = []
    for name, input_args in commands:
        output = target/name
        command = [sys.executable, '-m', 'site_js_analyzer', 'analyze', *input_args, '--out', str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=150)
        (target/(name+'.log')).write_text(result.stdout+result.stderr)
        if result.returncode != 0:
            raise SystemExit(f'{name}: CLI exited {result.returncode}; see {target}')
        report = json.loads((output/'analysis.json').read_text())
        candidates = report['candidates']
        if name != 'public':
            for wanted in expected['requests']:
                matches = [r for r in candidates if r['method'] == wanted['method'] and
                           (urlsplit(r['url']).path.startswith(wanted['path']) if wanted.get('dynamic') else urlsplit(r['url']).path == wanted['path'])]
                assert matches, (name, wanted['id'])
            fields = {(r['id'], p['carrier'], p['path']) for r in candidates for p in r['parameters']}
            assert sum(carrier == 'Query' for _, carrier, _ in fields) == 4
            assert sum(carrier == 'Body' for _, carrier, _ in fields) == 8
            assert not any(urlsplit(r['url']).path in expected['decoys'] for r in candidates)
        assert report['statistics']['unique_send_sites'] is None
        summary.append({'input': name, 'command': command, 'statistics': report['statistics'], 'status': report['task']['status']})
    (target/'verification.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({'output': str(target), 'results': summary}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
