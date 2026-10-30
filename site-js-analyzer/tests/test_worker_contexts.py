"""Worker contexts are inferred from reference evidence, never executed."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from site_js_analyzer.acquisition import StaticFetcher
from site_js_analyzer.assets import Snapshot
from site_js_analyzer.cli import main
from site_js_analyzer.collection import ReferenceGraph, restore_snapshot
from site_js_analyzer.engine import default_engine_root


class WorkerContextTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.traffic, self.routes = [], {}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.traffic.append(self.path)
                route = owner.routes.get(self.path)
                self.send_response(route.get('status', 200) if isinstance(route, dict) else 200 if route is not None else 404)
                if isinstance(route, dict) and route.get('redirect'):
                    self.send_header('Location', route['redirect'])
                self.send_header('Content-Type', 'application/javascript')
                body = route.get('body', b'') if isinstance(route, dict) else route or b''
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.base = f'http://127.0.0.1:{server.server_port}'
        def close():
            server.shutdown(); server.server_close(); thread.join(2)
        self.addCleanup(close)
        self.snapshot = Snapshot(self.root/'output')

    def add(self, path, source, kind='js'):
        return self.snapshot.add(source.encode(), location=self.base+path, url=self.base+path,
                                 page_url=self.base+'/page/index.html', context_key='p', kind=kind)

    def run_graph(self, online=False, **kwargs):
        fetcher = StaticFetcher([self.base]) if online else None
        graph = ReferenceGraph(self.snapshot, default_engine_root(), **kwargs)
        graph.run(fetcher)
        return graph

    def test_worker_and_module_url_use_distinct_bases(self):
        self.add('/page/index.html', '<base href="/base/"><script src="/cdn/main.js"></script>', 'html')
        self.add('/cdn/main.js', "new Worker('./classic.js'); new Worker(new URL('./module.js',import.meta.url),{type:'module'});")
        self.routes.update({'/base/classic.js': b"importScripts('./helpers/a.js'); fetch('./api/worker');",
                            '/base/helpers/a.js': b"importScripts('./b.js');",
                            '/base/b.js': b'void 0;',
                            '/cdn/module.js': b"import './helpers/m.js'; importScripts('./never.js');",
                            '/cdn/helpers/m.js': b"fetch('./api/module');"})
        graph = self.run_graph(True, max_depth=4)
        self.assertCountEqual(self.traffic, list(self.routes))
        workers = [c for c in self.snapshot.contexts if c['type'].endswith('worker')]
        self.assertEqual(len(workers), 2)
        by_mode = {c['worker_mode']: c for c in workers}
        self.assertEqual(by_mode['classic']['request_base_url'], self.base+'/base/classic.js')
        self.assertEqual(by_mode['module']['request_base_url'], self.base+'/cdn/module.js')
        helper = next(a for a in self.snapshot.assets if a['url']==self.base+'/base/helpers/a.js')
        self.assertEqual(helper['request_base_url'], self.base+'/base/classic.js')
        blocked = next(e for e in graph.edges if e['target']=='./never.js')
        self.assertEqual(blocked['status'], 'candidate')
        self.assertNotIn('/api/worker', self.traffic)
        restored = Snapshot(self.root/'restored')
        restore_snapshot(restored, self.snapshot.output)
        self.traffic.clear()
        ReferenceGraph(restored, default_engine_root(), max_depth=4).run(StaticFetcher([self.base]))
        self.assertEqual(self.traffic, [])
        self.assertEqual(self.snapshot.contexts, restored.contexts)

    def test_shadowed_dynamic_and_unsupported_worker_patterns_do_not_fetch(self):
        self.add('/page/index.html', '<script src="/main.js"></script>', 'html')
        self.add('/main.js', """
        function f(Worker){new Worker('./shadow.js');}
        function g(URL){new Worker(new URL('./fake.js',import.meta.url));}
        new Worker(path); new Worker('./dynamic-mode.js', options);
        new Worker('./spread.js', {...unknown,type:'module'});
        new Worker('blob:https://example.test/id');
        new Worker('data:application/javascript,void 0;');
        importScripts('./page.js'); navigator.serviceWorker.register('./sw.js');
        new Worker('./bad-options.js','name');
        """)
        graph = self.run_graph(True)
        self.assertEqual(self.traffic, [])
        self.assertTrue(all(e['status'] in {'available','candidate','unresolved'} for e in graph.edges))
        self.assertFalse(any(e['target']=='./sw.js' for e in graph.edges))

    def test_shared_worker_and_nested_workers_are_distinct_and_depth_bounded(self):
        self.add('/page/index.html', '<script src="/main.js"></script>', 'html')
        self.add('/main.js', "new SharedWorker('/recursive.js','shared'); new Worker('/recursive.js');")
        self.routes['/recursive.js'] = b"new Worker('/recursive.js');"
        graph = self.run_graph(True, max_depth=3)
        self.assertEqual(self.traffic.count('/recursive.js'), 4)
        self.assertEqual(len({a['context_id'] for a in self.snapshot.assets}), 5)
        self.assertEqual(sum(e['status']=='depth_limit' for e in graph.edges), 2)
        self.assertTrue(any(c['type']=='shared_worker' for c in self.snapshot.contexts))

    def test_imported_worker_body_is_associated_offline_without_picking_versions(self):
        self.add('/page/index.html', '<script src="/main.js"></script>', 'html')
        self.add('/main.js', "new Worker('/worker.js');")
        original = self.add('/worker.js', "fetch('./relative-api');")
        graph = self.run_graph()
        edge = next(e for e in graph.edges if e['kind']=='worker')
        clone = next(a for a in self.snapshot.assets if a.get('associated_asset_id')==original['id'])
        self.assertEqual(edge['status'], 'available')
        self.assertNotEqual(original['context_id'], clone['context_id'])
        self.assertEqual(clone['request_base_url'], self.base+'/worker.js')
        self.assertEqual(self.traffic, [])
        # Same URL with a second body cannot be selected or replaced via GET.
        self.snapshot = Snapshot(self.root/'ambiguous')
        self.add('/page/index.html', '<script src="/main.js"></script>', 'html')
        self.add('/main.js', "new Worker('/worker.js');")
        self.add('/worker.js', 'void 1;'); self.add('/worker.js', 'void 2;')
        graph = self.run_graph(True)
        self.assertEqual(self.traffic, [])
        self.assertEqual(next(e for e in graph.edges if e['kind']=='worker')['status'], 'ambiguous_version')

    def test_verified_dynamic_script_insertion_only(self):
        self.add('/page/index.html', '<base href="/base/"><script src="/cdn/main.js"></script>', 'html')
        self.add('/cdn/main.js', """
        const script=document.createElement('script');
        script.src='./actual.js';
        document.head.appendChild(script);
        const img=document.createElement('img'); img.src='./image.js'; document.body.appendChild(img);
        const escaped=document.createElement('script'); escape(escaped); escaped.src='./escape.js'; document.head.appendChild(escaped);
        const rewritten=document.createElement('script'); rewritten.src='./a.js'; rewritten.src='./b.js'; document.head.appendChild(rewritten);
        const compound=document.createElement('script'); compound.src+='./compound.js'; document.head.appendChild(compound);
        function f(document){const shadow=document.createElement('script');shadow.src='./shadow.js';document.head.appendChild(shadow);}
        """)
        self.routes['/base/actual.js'] = b"fetch('/api/never');"
        graph = self.run_graph(True)
        self.assertEqual(self.traffic, ['/base/actual.js'])
        self.assertEqual(sum(e['kind']=='script_assignment' and e['status']=='available' for e in graph.edges), 1)

    def test_cli_worker_candidates_keep_worker_request_base(self):
        source = self.root/'input'
        source.mkdir()
        (source/'index.html').write_text('<script src="/main.js"></script>')
        (source/'main.js').write_text("new Worker('/workers/entry.js');")
        self.routes['/workers/entry.js'] = b"importScripts('/cdn/helper.js');fetch('./entry-api');"
        self.routes['/cdn/helper.js'] = b"fetch('./helper-api');"
        output = self.root/'cli'
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = main(['analyze','--directory',str(source),'--page-url',self.base+'/page/',
                         '--fetch-js','--allow-origin',self.base,'--max-js-depth','3','--out',str(output)])
        self.assertEqual(code, 0)
        report = json.loads((output/'analysis.json').read_text())
        self.assertEqual({c['url'] for c in report['candidates']},
                         {self.base+'/workers/entry-api',self.base+'/workers/helper-api'})
        self.assertEqual(len({c['context_id'] for c in report['candidates']}), 1)
        self.assertCountEqual(self.traffic, ['/workers/entry.js','/cdn/helper.js'])

    def test_offline_worker_dependencies_reuse_input_and_metadata_is_validated(self):
        self.add('/page/index.html', '<script src="/main.js"></script>', 'html')
        self.add('/main.js', "new Worker('/worker.js');")
        self.add('/worker.js', "importScripts('/helper.js');")
        self.add('/helper.js', "importScripts('/worker.js');")
        graph = self.run_graph()
        self.assertEqual(sum(e['status']=='available' for e in graph.edges), 4)
        self.assertEqual(self.traffic, [])
        checkpoint = self.snapshot.output/'collection.json'
        data = json.loads(checkpoint.read_text())
        worker = next(a for a in data['assets'] if a.get('execution_context'))
        worker['execution_context']['request_base_url'] = 'file:///bad'
        checkpoint.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Worker execution base'):
            restore_snapshot(Snapshot(self.root/'invalid'), self.snapshot.output)

    def test_redirect_worker_uses_final_root_and_page_importmap_stays_in_page(self):
        self.add('/page/index.html', '<script type="importmap">{"imports":{"alias":"/page-only.js"}}</script><script src="/main.js"></script>', 'html')
        self.add('/main.js', "new Worker('/requested.js');new Worker('/module.js',{type:'module'});")
        self.routes.update({'/requested.js': {'status':302,'redirect':'/final/root.js'},
                            '/final/root.js': b"importScripts('./helper.js'); import './invalid-classic.js';",
                            '/final/helper.js': b"fetch('./api');",
                            '/module.js': b"import 'alias';"})
        graph = self.run_graph(True)
        self.assertCountEqual(self.traffic, list(self.routes))
        root = next(c for c in self.snapshot.contexts if c.get('worker_mode')=='classic')
        self.assertEqual(root['request_base_url'], self.base+'/final/root.js')
        self.assertEqual(next(e for e in graph.edges if e['target']=='alias')['status'], 'unresolved')
        self.assertEqual(next(e for e in graph.edges if e['target']=='./invalid-classic.js')['status'], 'candidate')
        restored = Snapshot(self.root/'redirect-restored')
        restore_snapshot(restored, self.snapshot.output)
        self.traffic.clear()
        ReferenceGraph(restored, default_engine_root()).run(StaticFetcher([self.base]))
        self.assertEqual(self.traffic, [])
        self.assertEqual(root, next(c for c in restored.contexts if c.get('worker_mode')=='classic'))
