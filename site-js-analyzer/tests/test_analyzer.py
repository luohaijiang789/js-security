import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

from site_js_analyzer.assets import Snapshot
from site_js_analyzer.cli import main
from site_js_analyzer.engine import verify_engine, LOCK
from site_js_analyzer.results import build_candidates, safe_cell

ROOT = Path(__file__).resolve().parents[2]


def entry(url, text, *, mime='application/javascript', page='page1', status=200, encoding=None):
    content = {'mimeType': mime}
    if text is not None:
        content['text'] = text
    if encoding:
        content['encoding'] = encoding
    return {'request': {'url': url}, 'response': {'status': status, 'content': content}, 'pageref': page}


class AnalyzerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root/'result'

    def snapshot(self):
        return Snapshot(self.out)

    def har(self, entries, pages=None):
        source = self.root/'sample.har'
        source.write_text(json.dumps({'log': {'entries': entries, 'pages': pages or [{'id': 'page1', 'title': 'https://app.example.test/home'}]}}))
        return source

    def run_cli(self, *args):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = main(list(map(str, args)))
        report = json.loads((self.out/'analysis.json').read_text()) if (self.out/'analysis.json').exists() else None
        return code, report

    def test_har_base64_and_exclude_api_responses(self):
        source = self.har([
            entry('https://cdn.example.test/app.js', base64.b64encode(b"fetch('/api/x')").decode(), encoding='base64'),
            entry('https://app.example.test/api/x', '{"url":"/not-a-static-request"}', mime='application/json'),
        ])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(len(snap.assets), 1)
        self.assertEqual(snap.assets[0]['page_url'], 'https://app.example.test/home')
        self.assertEqual((self.out/snap.assets[0]['body_file']).read_bytes(), b"fetch('/api/x')")

    def test_missing_body_bad_base64_and_html_are_distinct(self):
        source = self.har([
            entry('https://cdn.test/a.js', None),
            entry('https://cdn.test/b.js', '???', encoding='base64'),
            entry('https://cdn.test/c.js', '<html>login</html>', mime='text/html'),
            entry('https://cdn.test/d.js', 'denied', status=403),
        ])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(len(snap.assets), 0)
        self.assertEqual({x['kind'] for x in snap.gaps}, {'missing_body', 'body_encoding', 'html_instead_of_js', 'http_status'})

    def test_versions_preserved_and_never_mixed(self):
        source = self.har([entry('https://cdn.test/app.js', "fetch('/old')"), entry('https://cdn.test/app.js', "fetch('/new')")])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(len(snap.assets), 2)
        self.assertNotEqual(snap.assets[0]['sha256'], snap.assets[1]['sha256'])
        self.assertTrue(all(len(group) == 1 for group in snap.groups()))
        self.assertIn('version_association_unknown', [g['kind'] for g in snap.gaps])

    def test_repeated_response_retains_observations_without_static_double_count(self):
        source = self.har([entry('https://cdn.test/app.js', 'void 0;')]*2)
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(len(snap.assets), 1)
        self.assertEqual(snap.assets[0]['observations'], [0, 1])

    def test_shared_body_keeps_two_page_contexts(self):
        source = self.har([entry('https://cdn.test/app.js', 'void 0;', page='p1'), entry('https://cdn.test/app.js', 'void 0;', page='p2')],
                          [{'id': 'p1', 'title': 'https://one.test/'}, {'id': 'p2', 'title': 'https://two.test/'}])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(len(snap.groups()), 2)
        self.assertEqual(snap.assets[0]['body_file'], snap.assets[1]['body_file'])

    def test_budgets_never_save_truncated_body(self):
        snap = Snapshot(self.out, max_asset_bytes=3)
        snap.add(b'long JS', location='app.js', kind='js')
        self.assertEqual(snap.assets, [])
        self.assertEqual(snap.gaps[0]['kind'], 'input_budget')
        self.assertFalse((self.out/'snapshot').exists())

    def test_symlink_not_followed(self):
        source = self.root/'input'
        source.mkdir()
        target = self.root/'outside.js'
        target.write_text("fetch('/outside')")
        (source/'link.js').symlink_to(target)
        snap = self.snapshot()
        snap.import_directory(source)
        self.assertFalse(snap.assets)
        self.assertEqual(snap.gaps[0]['kind'], 'symlink_skipped')

    def test_csv_formula_protection(self):
        for value in ['=1+1', ' +SUM(A1)', '-1+2', '@value', '\tformula']:
            self.assertTrue(safe_cell(value).startswith("'"))
        self.assertEqual(safe_cell('/api/path'), '/api/path')

    def test_unknown_wrapper_host_and_method_are_not_guessed(self):
        snap = self.snapshot()
        snap.add(b'', location='app.js', kind='js', page_url='https://page.test/')
        records = [{'id': 'e1', 'group': 0, 'asset_id': snap.assets[0]['id'], 'raw': {'sink': 'unknownClient.request', 'template': '/api/a', 'method': 'UNKNOWN'}}]
        candidates, groups, _ = build_candidates(snap, records)
        self.assertIsNone(candidates[0]['host'])
        self.assertIsNone(candidates[0]['method'])
        self.assertEqual(groups, [])

    def test_route_records_are_not_converted_to_get(self):
        snap = self.snapshot()
        candidates, groups, other = build_candidates(snap, [{'id': 'route1', 'group': 0, 'asset_id': None, 'raw': {'_kind': 'route', 'template': '/not-a-send'}}])
        self.assertFalse(candidates)
        self.assertFalse(groups)
        self.assertEqual(other, ['route1'])

    def test_empty_directory_is_partial_not_success(self):
        source = self.root/'empty'
        source.mkdir()
        code, report = self.run_cli('analyze', '--directory', source, '--out', self.out)
        self.assertEqual(code, 4)
        self.assertEqual(report['task']['status'], 'partial')

    def test_malformed_har_gets_failure_report(self):
        source = self.root/'bad.har'
        source.write_text('{"log":{"entries":[{"response":"bad"}]}}')
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 2)
        self.assertEqual(report['task']['status'], 'failed')

    def test_output_never_overwrites_previous_data(self):
        source = self.root/'empty'
        source.mkdir()
        self.out.mkdir()
        (self.out/'keep').write_text('previous result')
        code, _ = self.run_cli('analyze', '--directory', source, '--out', self.out)
        self.assertEqual(code, 2)
        self.assertEqual((self.out/'keep').read_text(), 'previous result')

    def test_wrong_engine_source_is_rejected(self):
        with self.assertRaises(RuntimeError):
            verify_engine(self.root)

    def test_changed_engine_commit_is_rejected(self):
        with patch.dict(LOCK, {'commit': '0'*40}), self.assertRaises(RuntimeError):
            verify_engine(ROOT/'references/repos/jshound')

    def test_origin_manifest_cannot_import_outside_files(self):
        source = self.root/'input'
        source.mkdir()
        (source/'app.js').write_text('void 0;')
        (source/'_origin.jsonl').write_text(json.dumps({'f': '../outside.js', 'u': 'https://cdn.test/outside.js'})+'\n'+json.dumps({'f': 'app.js', 'u': 'https://cdn.test/app.js', 'd': 'https://app.test/'})+'\n')
        snap = self.snapshot()
        snap.import_directory(source)
        self.assertEqual(len(snap.assets), 1)
        self.assertEqual(snap.assets[0]['page_url'], 'https://app.test/')
        self.assertEqual(snap.assets[0]['url'], 'https://cdn.test/app.js')
        self.assertIn('origin_manifest_invalid', [g['kind'] for g in snap.gaps])

    def test_ambiguous_har_document_does_not_guess_page(self):
        source = self.har([entry('https://one.test/', '<html></html>', mime='text/html'),
                           entry('https://two.test/', '<html></html>', mime='text/html'),
                           entry('https://cdn.test/app.js', 'void 0;')])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertIsNone(next(a for a in snap.assets if a['kind'] == 'js')['page_url'])
        self.assertIn('ambiguous_page', [g['kind'] for g in snap.gaps])

    def test_html_login_at_js_url_does_not_replace_page(self):
        source = self.har([entry('https://cdn.test/login.js', '<html>login</html>', mime='text/html'),
                           entry('https://cdn.test/app.js', 'void 0;')])
        snap = self.snapshot()
        snap.import_har(source)
        self.assertEqual(snap.assets[0]['page_url'], 'https://app.example.test/home')

    def test_real_engine_keeps_execution_pages_separate(self):
        source = self.har([entry('https://cdn.test/app.js', "fetch('/api/shared')", page='p1'),
                           entry('https://cdn.test/app.js', "fetch('/api/shared')", page='p2')],
                          [{'id': 'p1', 'title': 'https://one.test/'}, {'id': 'p2', 'title': 'https://two.test/'}])
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 0)
        self.assertEqual({c['host'] for c in report['candidates']}, {'https://one.test', 'https://two.test'})

    def test_html_base_is_not_confused_with_document_or_cdn(self):
        source = self.har([entry('https://app.example.test/home', '<html><head><base href="https://api.example.test/v2/"></head></html>', mime='text/html'),
                           entry('https://cdn.example.test/app.js', "fetch('./orders')")])
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['url'], 'https://api.example.test/v2/orders')
        self.assertEqual(report['contexts'][0]['page_url'], 'https://app.example.test/home')

    def test_bare_relative_fetch_model_gap_is_visible(self):
        source = self.har([entry('https://cdn.test/app.js', "fetch('orders')")])
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'], [])
        self.assertIn('engine_model_gap', [g['kind'] for g in report['gaps']])

    def test_unsupported_html_base_leaves_host_unknown(self):
        snap = self.snapshot()
        snap.add(b'<html><base href="data:text/html,hello"></html>', location='index.html', kind='html', page_url='https://page.test/')
        snap.add(b"fetch('/a')", location='app.js', kind='js', page_url='https://page.test/')
        snap.resolve_contexts()
        candidate, _, _ = build_candidates(snap, [{'id': 'e1', 'group': 0, 'asset_id': snap.assets[1]['id'], 'raw': {'sink': 'fetch', 'method': 'GET', 'template': '/a'}}])
        self.assertIsNone(candidate[0]['host'])

    def test_nonfinite_timeout_is_rejected(self):
        source = self.root/'input'
        source.mkdir()
        code, _ = self.run_cli('analyze', '--directory', source, '--out', self.out, '--timeout', 'nan')
        self.assertEqual(code, 2)

    def test_real_engine_query_and_nested_fields(self):
        source = self.har([entry('https://cdn.example.test/app.js', "export function neverCalled(userId){return fetch('/api/orders?mode=preview',{method:'POST',headers:{'X-Tenant':'demo'},body:JSON.stringify({userId,context:{source:'test'}})});}")])
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 0)
        self.assertEqual(len(report['candidates']), 1)
        candidate = report['candidates'][0]
        self.assertEqual(candidate['url'], 'https://app.example.test/api/orders?mode=preview')
        self.assertEqual(candidate['host'], 'https://app.example.test')
        fields = {(p['carrier'], p['path'].lower() if p['carrier'] == 'Header' else p['path']) for p in candidate['parameters']}
        self.assertTrue({('Query', 'mode'), ('Body', 'userId'), ('Body', 'context.source'), ('Header', 'x-tenant')} <= fields)
        self.assertIsNone(report['statistics']['unique_send_sites'])
        self.assertIsNone(candidate['send_site'])
        raw = json.loads((self.out/'engine-records.json').read_text())
        self.assertTrue(any('query_schema' in row['raw'] for row in raw))

    def test_real_engine_parse_failure_does_not_become_no_requests(self):
        source = self.root/'bad-js'
        source.mkdir()
        (source/'app.js').write_text('const = ;')
        code, report = self.run_cli('analyze', '--directory', source, '--out', self.out)
        self.assertEqual(code, 4)
        self.assertTrue(any(g['kind'] == 'parse_failed' for g in report['gaps']))

    def test_real_engine_har_cross_file_wrapper(self):
        source = self.har([
            entry('https://cdn.example.test/assets/helper.js', "export function send(url,data){return fetch(url,{method:'POST',body:JSON.stringify(data)});}"),
            entry('https://cdn.example.test/assets/main.js', "import {send} from './helper.js'; export function call(){return send('/api/cross',{customerId:1});}"),
        ])
        code, report = self.run_cli('analyze', '--har', source, '--out', self.out)
        self.assertEqual(code, 0)
        cross = [r for r in report['candidates'] if '/api/cross' in r['url']]
        self.assertEqual(len(cross), 1)
        self.assertIn(('Body', 'customerId'), {(p['carrier'], p['path']) for p in cross[0]['parameters']})

    def test_deadline_preserves_snapshot(self):
        source = self.root/'small'
        source.mkdir()
        (source/'app.js').write_text("fetch('/x')")
        code, report = self.run_cli('analyze', '--directory', source, '--out', self.out, '--timeout', '0.001')
        self.assertEqual(code, 4)
        self.assertEqual(len(report['assets']), 1)
        self.assertIn('engine_timeout', [g['kind'] for g in report['gaps']])


if __name__ == '__main__':
    unittest.main()
