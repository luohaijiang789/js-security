import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from site_js_analyzer.acquisition import FetchError, StaticFetcher
from site_js_analyzer.assets import Snapshot
from site_js_analyzer.cli import main
from site_js_analyzer.collection import ReferenceGraph, mapped_specifier, restore_snapshot
from site_js_analyzer.engine import default_engine_root


class CollectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root/'result'
        self.snapshot = Snapshot(self.out)
        self.routes, self.requests = {}, []

    def graph(self, **kwargs):
        return ReferenceGraph(self.snapshot, default_engine_root(), **kwargs)

    def add(self, location, text, kind='js', url=None, page='https://app.test/'):
        return self.snapshot.add(text.encode(), location=location, kind=kind, url=url, page_url=page, context_key='p')

    def serve(self, routes=None):
        routes = self.routes if routes is None else routes
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(handler):
                requests.append((handler.path, dict(handler.headers)))
                response = routes.get(handler.path, (404, {}, b''))
                if callable(response):
                    response = response(handler.path)
                status, headers, data = response
                handler.send_response(status)
                for key, value in headers.items():
                    handler.send_header(key, str(value))
                handler.end_headers()
                handler.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.addCleanup(close)
        return f'http://127.0.0.1:{server.server_port}', requests

    def seed_har(self, base, main_source=None):
        entries = []
        for name, text, mime in [('', '<script type="module" src="/main.js"></script>', 'text/html'),
                                 ('main.js', main_source or "import './level2.js'; export function start(){fetch('/api/one')}", 'application/javascript')]:
            entries.append(dict(pageref='p', request={'url':base+'/'+name}, response={'status':200,'content':{'mimeType':mime,'text':text}}))
        path = self.root/'seed.har'
        path.write_text(json.dumps({'log':{'pages':[{'id':'p','title':base+'/'}],'entries':entries}}))
        return path

    def cli(self, *args, output=None):
        output = output or self.out
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = main(['analyze', *map(str,args), '--out',str(output)])
        return code, json.loads((output/'analysis.json').read_text())

    def js(self, text):
        return (200, {'Content-Type':'application/javascript'}, text.encode())

    def test_reference_syntax_positions_and_no_api_probes(self):
        asset = self.add('main.js', "import './a.js';\nexport * from './b.js';\nimport('./c.js'); import(variable); fetch('/api/never');")
        graph = self.graph()
        graph.discover()
        self.assertEqual({e['target'] for e in graph.edges if e['target']}, {'./a.js','./b.js','./c.js'})
        self.assertTrue(any(e['confidence']=='unknown' for e in graph.edges))
        self.assertEqual(next(e for e in graph.edges if e['kind']=='module_export')['line'],2)
        self.assertTrue(all(e['parent_asset_id']==asset['id'] for e in graph.edges))

    def test_reference_offsets_include_bom_and_use_utf16_units(self):
        source="\ufeffconst smile='😀'; import './a.js';"
        self.add('main.js',source)
        graph=self.graph();graph.discover()
        edge=next(e for e in graph.edges if e['kind']=='module_import')
        expected=len(source[:source.index("'./a.js'")].encode('utf-16-le'))//2
        self.assertEqual(edge['start'],expected)
        self.assertEqual(edge['column'],expected)

    def test_inline_reference_column_uses_original_html_utf16_units(self):
        source='<p>😀</p><script type="module">import "./a.js";</script>'
        self.add('index.html',source,'html')
        graph=self.graph();graph.discover()
        edge=next(e for e in graph.edges if e['kind']=='module_import')
        expected=len(source[:source.index('"./a.js"')].encode('utf-16-le'))//2
        self.assertEqual(edge['line'],1)
        self.assertEqual(edge['column'],expected)

    def test_import_map_scope_prefix_block_and_escape(self):
        maps={'imports':{'pkg/':'https://cdn.test/global/','blocked':None},
              'scopes':{'https://cdn.test/feature/':{'pkg/':'https://cdn.test/scoped/'}}}
        self.assertEqual(mapped_specifier('pkg/a.js','https://cdn.test/feature/main.js','https://app.test/',maps)[0], 'https://cdn.test/scoped/a.js')
        self.assertEqual(mapped_specifier('blocked','https://cdn.test/main.js','https://app.test/',maps)[1], 'import_map_blocked')
        self.assertEqual(mapped_specifier('pkg/../escape.js','https://cdn.test/main.js','https://app.test/',maps)[1], 'import_map_escape')

    def test_inline_import_map_and_modulepreload(self):
        self.add('index.html', '<script type="importmap">{"imports":{"sdk":"https://cdn.test/sdk.js"}}</script>\n<script type="module">import "sdk";</script><link rel="modulepreload" href="/preload.js">','html',url='https://app.test/')
        self.add('sdk.js','void 0;',url='https://cdn.test/sdk.js')
        self.add('preload.js','void 0;',url='https://app.test/preload.js')
        self.snapshot.resolve_contexts()
        graph=self.graph();graph.run()
        inline=next(e for e in graph.edges if e.get('inline_index') is not None)
        self.assertEqual(inline['target_url'],'https://cdn.test/sdk.js')
        self.assertEqual(inline['line'],2)
        self.assertTrue(all(e['status']=='available' for e in graph.edges))
        self.assertEqual([a['js_depth'] for a in self.snapshot.assets],[0,1,1])

    def test_blocked_import_map_cannot_fall_back_to_same_named_local_file(self):
        self.add('index.html','<script type="importmap">{"imports":{"./blocked.js":null}}</script><script type="module" src="/main.js"></script>','html')
        self.add('main.js',"import './blocked.js';")
        self.add('blocked.js','void 0;')
        self.snapshot.resolve_contexts();graph=self.graph();graph.run()
        edge=next(e for e in graph.edges if e['target']=='./blocked.js')
        self.assertEqual(edge['status'],'unresolved')
        self.assertEqual(edge['child_asset_ids'],[])
        self.assertEqual(edge['resolution_reason'],'import_map_blocked')

    def test_webpack_public_path_and_vite_tables(self):
        self.add('runtime.js','function n(){}; n.p="/chunks/"; n.u=e=>({7:"feature"})[e]+".hash.js"; n.e(7);',url='https://cdn.test/runtime.js')
        self.snapshot.resolve_contexts()
        graph=self.graph();graph.discover();graph.refresh()
        chunk=next(e for e in graph.edges if e['kind']=='webpack_chunk')
        self.assertEqual(chunk['target_url'],'https://app.test/chunks/feature.hash.js')
        self.assertIsNotNone(chunk['line'])
        vite=graph.parse_js('const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./a.js","./b.js"])))=>i.map(i=>d[i]); __vitePreload(()=>import("./feature.js"),__vite__mapDeps([0,1]),import.meta.url);')
        self.assertEqual({e['target'] for e in vite['refs'] if e['kind']=='vite_dependency'}, {'./a.js','./b.js'})

    def test_literal_tables_are_candidates_not_download_instructions(self):
        graph=self.graph()
        data=graph.parse_js('const docs=["/not-a-runtime.js","/another.js"]; fetch("/api/never");')
        self.assertTrue(data['refs'])
        self.assertTrue(all(e['confidence']=='candidate' for e in data['refs']))

    def test_cycles_multiparent_and_imported_deep_assets(self):
        self.add('index.html','<script type="module" src="/main.js"></script>','html')
        self.add('main.js',"import './a.js'; import './c.js';")
        self.add('a.js',"import './b.js';")
        self.add('b.js',"import './a.js'; import './c.js';")
        self.add('c.js',"import './deep.js';")
        self.add('deep.js',"fetch('/api/deep');")
        graph=self.graph(max_depth=1);graph.run()
        depths={a['location']:a['js_depth'] for a in self.snapshot.assets}
        self.assertEqual(depths, {'index.html':0,'main.js':1,'a.js':2,'b.js':3,'c.js':2,'deep.js':3})
        self.assertEqual(sum(e['target_location']=='c.js' for e in graph.edges),2)
        self.assertTrue(all(e['status']=='available' for e in graph.edges))

    def test_late_short_path_recomputes_depth(self):
        page=self.add('index.html','<script type="module" src="/main.js"></script>','html')
        self.add('main.js',"import './a.js';")
        self.add('a.js',"import './b.js';")
        child=self.add('b.js',"import './deep.js';")
        self.add('deep.js','void 0;')
        graph=self.graph(max_depth=3);graph.discover();graph.refresh()
        self.assertEqual(child['js_depth'],3)
        graph.add_edge(page,dict(kind='script_src',target='/b.js',confidence='certain',line=2,column=0,start=None,end=None))
        graph.refresh()
        self.assertEqual(child['js_depth'],1)
        self.assertEqual(self.snapshot.assets[-1]['js_depth'],2)

    def test_unknown_parent_is_not_depth_one(self):
        self.add('orphan.js',"import './child.js';",url='https://cdn.test/orphan.js')
        self.snapshot.resolve_contexts()
        graph=self.graph();graph.run()
        self.assertIsNone(self.snapshot.assets[0]['js_depth'])
        self.assertEqual(graph.edges[0]['status'],'unknown_depth')

    def test_version_ambiguity_is_not_arbitrarily_resolved(self):
        self.add('index.html','<script type="module" src="/main.js"></script>','html',url='https://app.test/')
        self.add('v1',"fetch('/old')",url='https://app.test/main.js')
        self.add('v2',"fetch('/new')",url='https://app.test/main.js')
        self.snapshot.resolve_contexts();graph=self.graph();graph.run()
        self.assertEqual(graph.edges[0]['status'],'ambiguous_version')
        self.assertEqual(len(graph.edges[0]['child_asset_ids']),2)

    def test_opt_in_depth_limit_and_no_api_calls(self):
        self.routes.update({'/level2.js':self.js("import './level3.js'; export function b(){fetch('/api/two')}"),
                            '/level3.js':self.js("import './level4.js'; export function c(){fetch('/api/three')}"),
                            '/level4.js':self.js("import './level2.js'; export function d(){fetch('/api/four')}")})
        base,requests=self.serve();source=self.seed_har(base)
        code,report=self.cli('--har',source,'--fetch-js','--allow-origin',base)
        self.assertEqual(code,4)
        self.assertEqual([path for path,_ in requests],['/level2.js','/level3.js'])
        self.assertEqual(report['statistics']['request_candidates'],3)
        self.assertEqual(report['statistics']['supplemented_assets'],2)
        self.assertIn('depth_limit',[e['status'] for e in report['reference_edges']])
        self.assertTrue(all(not path.startswith('/api/') for path,_ in requests))

    def test_offline_reports_missing_without_get(self):
        base,requests=self.serve();source=self.seed_har(base)
        code,report=self.cli('--har',source)
        self.assertEqual(code,4)
        self.assertEqual(requests,[])
        self.assertIn('missing_offline',[e['status'] for e in report['reference_edges']])

    def test_cycles_fetch_each_file_once(self):
        self.routes.update({'/level2.js':self.js("import './level3.js'; import './level3.js';"),
                            '/level3.js':self.js("import './level2.js'; fetch('/api/hidden');")})
        base,requests=self.serve();source=self.seed_har(base)
        code,report=self.cli('--har',source,'--fetch-js','--allow-origin',base,'--max-js-depth','4')
        self.assertEqual(code,0)
        self.assertEqual([path for path,_ in requests],['/level2.js','/level3.js'])
        self.assertEqual(len([e for e in report['reference_edges'] if e['target']=='./level3.js']),2)

    def test_resume_reuses_verified_bodies_and_unlocks_deeper_reference(self):
        self.routes.update({'/level2.js':self.js("import './level3.js';"),'/level3.js':self.js("import './level4.js';"),'/level4.js':self.js("fetch('/api/deep');")})
        base,requests=self.serve();source=self.seed_har(base)
        code,_=self.cli('--har',source,'--fetch-js','--allow-origin',base)
        self.assertEqual(code,4)
        requests.clear()
        code,report=self.cli('--resume',self.out,'--fetch-js','--allow-origin',base,'--max-js-depth','4',output=self.root/'resumed')
        self.assertEqual(code,0)
        self.assertEqual([path for path,_ in requests],['/level4.js'])
        self.assertEqual(report['statistics']['total_assets'],5)

    def test_tampered_checkpoint_is_rejected_before_get(self):
        self.add('app.js','void 0;')
        graph=self.graph();graph.run()
        body=self.out/self.snapshot.assets[0]['body_file'];body.write_text('tampered')
        with self.assertRaisesRegex(ValueError,'hash'):
            restore_snapshot(Snapshot(self.root/'new'),self.out)

    def test_redirect_scope_and_no_credential_forwarding(self):
        second_routes={'/final.js':self.js('void 0;')}
        second,seen2=self.serve(second_routes)
        self.routes['/level2.js']=(302,{'Location':second+'/final.js'},b'')
        first,seen1=self.serve()
        session=self.root/'session.json';session.write_text(json.dumps({first:{'Cookie':'session=fixture-only','Authorization':'Bearer fixture-token'}}))
        fetcher=StaticFetcher([first],session_file=session)
        with self.assertRaises(FetchError) as caught:
            fetcher.get(first+'/level2.js',4096)
        self.assertEqual(caught.exception.kind,'outside_origin')
        self.assertEqual(seen2,[])
        fetcher=StaticFetcher([first,second],session_file=session)
        response=fetcher.get(first+'/level2.js',4096)
        self.assertEqual(response['url'],second+'/final.js')
        self.assertIn('Cookie',seen1[-1][1])
        self.assertNotIn('Cookie',seen2[-1][1])
        self.assertNotIn('Authorization',seen2[-1][1])
        self.assertNotIn('fixture-token',json.dumps(fetcher.events))

    def test_invalid_redirect_is_a_collection_gap_not_config_error(self):
        self.routes['/level2.js']=(302,{'Location':'file:///tmp/not-a-script'},b'')
        base,requests=self.serve();source=self.seed_har(base)
        code,report=self.cli('--har',source,'--fetch-js','--allow-origin',base)
        self.assertEqual(code,4)
        self.assertIn('unsupported_resource_url',[e['status'] for e in report['reference_edges']])
        self.assertEqual([path for path,_ in requests],['/level2.js'])

    def test_status_retry_and_complete_body_required(self):
        attempts=[]
        def transient(path):
            attempts.append(path)
            return (503,{},b'') if len(attempts)==1 else self.js('void 0;')
        self.routes['/retry.js']=transient
        self.routes['/truncated.js']=(200,{'Content-Type':'application/javascript','Content-Length':'100'},b'void 0;')
        self.routes['/denied.js']=(403,{},b'')
        base,requests=self.serve();fetcher=StaticFetcher([base],retries=1)
        self.assertEqual(fetcher.get(base+'/retry.js',4096)['data'],b'void 0;')
        self.assertEqual(len(attempts),2)
        with self.assertRaises(FetchError) as truncated:fetcher.get(base+'/truncated.js',4096)
        self.assertEqual(truncated.exception.kind,'response_incomplete')
        with self.assertRaises(FetchError) as denied:fetcher.get(base+'/denied.js',4096)
        self.assertEqual(denied.exception.kind,'http_status')
        self.assertEqual(sum(path=='/denied.js' for path,_ in requests),1)

    def test_byte_file_and_deadline_budgets(self):
        self.routes['/large.js']=self.js('x'*100)
        base,requests=self.serve();fetcher=StaticFetcher([base],max_files=1)
        with self.assertRaises(FetchError) as large:fetcher.get(base+'/large.js',8)
        self.assertEqual(large.exception.kind,'fetch_byte_budget')
        with self.assertRaises(FetchError) as files:fetcher.get(base+'/large.js',4096)
        self.assertEqual(files.exception.kind,'fetch_file_budget')
        fetcher=StaticFetcher([base],deadline=0)
        with self.assertRaises(FetchError) as deadline:fetcher.get(base+'/large.js',4096)
        self.assertEqual(deadline.exception.kind,'fetch_deadline')

    def test_fetch_requires_explicit_origins_and_transport_headers_are_rejected(self):
        with self.assertRaises(ValueError):StaticFetcher([])
        with self.assertRaises(ValueError):StaticFetcher(['https://app.test/some/path'])
        session=self.root/'session.json';session.write_text(json.dumps({'https://app.test':{'Host':'other.test'}}))
        with self.assertRaises(ValueError):StaticFetcher(['https://app.test'],session_file=session)

    def test_fetched_html_or_wrong_mime_never_becomes_script(self):
        self.routes['/level2.js']=(200,{'Content-Type':'application/javascript'},b'<html>login</html>')
        base,requests=self.serve();source=self.seed_har(base)
        code,report=self.cli('--har',source,'--fetch-js','--allow-origin',base)
        self.assertEqual(code,4)
        self.assertEqual(report['statistics']['supplemented_assets'],0)
        self.assertIn('html_instead_of_js',[g['kind'] for g in report['gaps']])
        self.routes['/wrong.js']=(200,{'Content-Type':'application/json'},b'{}')
        with self.assertRaises(FetchError) as caught:StaticFetcher([base]).get(base+'/wrong.js',4096)
        self.assertEqual(caught.exception.kind,'response_type')

    def test_checkpoint_preserves_original_missing_body_gap(self):
        self.add('app.js','void 0;')
        self.snapshot.gap('missing_body','Original HAR omitted another script.',incomplete=True)
        graph=self.graph();graph.run()
        restored=Snapshot(self.root/'restored')
        restore_snapshot(restored,self.out)
        self.assertIn('missing_body',[g['kind'] for g in restored.gaps])

    def test_redirect_alias_does_not_reclassify_imported_asset(self):
        self.routes['/alias.js']=(302,{'Location':'/existing.js'},b'')
        self.routes['/existing.js']=self.js('void 0;')
        base,requests=self.serve()
        self.add('index.html','<script type="module" src="/main.js"></script>','html',url=base+'/',page=base+'/')
        self.add('main.js',"import './alias.js';",url=base+'/main.js',page=base+'/')
        asset=self.add(base+'/existing.js','void 0;',url=base+'/existing.js',page=base+'/')
        self.snapshot.resolve_contexts()
        self.graph().run(StaticFetcher([base]))
        self.assertNotEqual(asset.get('acquisition'),'static-supplement')
        self.assertEqual(len(self.snapshot.assets),3)
        self.assertTrue(all(e['status']=='available' for e in self.snapshot.reference_edges))
