import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

from website_js_extractor.application.agent import AgentTools,AgentBudget,ChatProvider,run_agent
from website_js_extractor.domain.assets import digest


class FakeProvider:
    model='controlled-test'
    def __init__(self,actions): self.actions=iter(actions);self.calls=[]
    def complete(self,messages,remaining):
        self.calls.append(json.loads(json.dumps(messages)))
        return json.dumps(next(self.actions))


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.source="fetch('/api/items');";self.sha=hashlib.sha256(self.source.encode()).hexdigest()
        asset=dict(id='asset',sha256=self.sha,body_file='snapshot/source.js',bytes=len(self.source.encode()))
        (self.root/'snapshot').mkdir();(self.root/'snapshot/source.js').write_text(self.source)
        manifest=dict(schema='analysis-assets-1',stage='frozen',assets=[asset]);manifest['manifest_hash']=digest(manifest)
        self.site=dict(start=0,end=len(self.source),excerpt=self.source,source_sha256=self.sha,offset_unit='utf16')
        self.candidate=dict(id='candidate',asset_id='asset',method='GET',url='https://app.test/api/items',host='https://app.test',send_sites=[self.site])
        (self.root/'analysis-manifest.json').write_text(json.dumps(manifest))
        self.original=json.dumps(dict(candidates=[self.candidate],assets=[asset]))
        (self.root/'analysis.json').write_text(self.original)

    def proposal(self,**changes):
        proposal=dict(type='explanation',candidate_id='candidate',asset_id='asset',source_sha256=self.sha,start=0,end=len(self.source),claims=dict(method='GET'),explanation='Model narrative, not a fact mutation.')
        proposal.update(changes);return proposal

    def test_disabled_by_default_and_verified_tool_loop_never_modifies_facts(self):
        provider=FakeProvider([])
        with self.assertRaisesRegex(ValueError,'disabled'): run_agent(self.root,provider)
        self.assertEqual(provider.calls,[])
        provider=FakeProvider([dict(action='tool',name='list_candidates',arguments={}),
                               dict(action='tool',name='read_source',arguments=dict(asset_id='asset',start=0,end=len(self.source))),
                               dict(action='proposal',proposal=self.proposal()),dict(action='finish')])
        report=run_agent(self.root,provider,allow_source_send=True)
        self.assertEqual(report['status'],'completed');self.assertFalse(report['facts_modified'])
        self.assertEqual(report['proposals'][0]['verification']['status'],'accepted')
        self.assertEqual((self.root/'analysis.json').read_text(),self.original)
        self.assertEqual(report['source_bytes'],len(self.source.encode()))

    def test_fabricated_evidence_claims_and_unproven_wrapper_mapping_are_not_promoted(self):
        tools=AgentTools(self.root,AgentBudget())
        for changes in [dict(source_sha256='f'*64),dict(start=5),dict(claims=dict(method='POST')),dict(claims=dict(arbitrary='value')),dict(asset_id='../secrets')]:
            with self.subTest(changes=changes): self.assertEqual(tools.verify(self.proposal(**changes))['status'],'rejected')
        self.assertEqual(tools.verify(self.proposal(type='wrapper_mapping'))['status'],'partial')
        (self.root/'snapshot/source.js').write_text('x'*len(self.source))
        with self.assertRaisesRegex(ValueError,'hash mismatch'): tools.verify(self.proposal())

    def test_path_escape_unknown_tools_and_source_instructions_do_not_expand_permissions(self):
        tools=AgentTools(self.root,AgentBudget())
        with self.assertRaises(ValueError): tools.call('read_source',dict(asset_id='../../secret',start=0,end=1))
        provider=FakeProvider([dict(action='tool',name='shell',arguments=dict(cmd='touch forbidden')),
                               dict(action='tool',name='read_source',arguments=dict(asset_id='/etc/passwd')),
                               dict(action='finish')])
        report=run_agent(self.root,provider,allow_source_send=True)
        self.assertEqual(len([step for step in report['trace'] if 'error' in step]),2)
        self.assertEqual(report['source_bytes'],0)
        self.assertFalse((self.root/'forbidden').exists())

    def test_symlink_hash_and_manifest_tampering_are_rejected(self):
        tools=AgentTools(self.root,AgentBudget())
        path=self.root/'snapshot/source.js';path.unlink();path.symlink_to(self.root/'analysis.json')
        with self.assertRaisesRegex(ValueError,'Symlink'): tools.source('asset')
        manifest=json.loads((self.root/'analysis-manifest.json').read_text());manifest['stage']='changed'
        (self.root/'analysis-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'frozen'): AgentTools(self.root,AgentBudget())

    def test_step_source_deadline_cancel_and_provider_failures_end_with_explicit_status(self):
        provider=FakeProvider([dict(action='tool',name='list_candidates',arguments={})]*3)
        report=run_agent(self.root,provider,allow_source_send=True,budget=AgentBudget(steps=2))
        self.assertEqual(report['status'],'partial')
        tools=AgentTools(self.root,AgentBudget(source_bytes=1))
        with self.assertRaisesRegex(ValueError,'budget'): tools.read_source('asset',0,len(self.source))
        class Slow:
            def complete(self,*args): time.sleep(.3);return '{}'
        started=time.monotonic()
        report=run_agent(self.root,Slow(),allow_source_send=True,budget=AgentBudget(seconds=.05))
        self.assertEqual(report['status'],'partial');self.assertLess(time.monotonic()-started,.25)
        self.assertEqual(run_agent(self.root,provider,allow_source_send=True,cancelled=lambda:True)['status'],'cancelled')
        self.assertEqual(run_agent(self.root,FakeProvider([]),allow_source_send=True)['status'],'failed')

    def test_real_http_provider_uses_explicit_model_and_keeps_credentials_out_of_reports(self):
        seen=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                seen.append((self.path,self.headers.get('Authorization'),json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                encoded=json.dumps(dict(choices=[dict(message=dict(content='{"action":"finish"}'))])).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        provider=ChatProvider(f'http://127.0.0.1:{server.server_port}/v1','chosen-model','secret-test-key')
        report=run_agent(self.root,provider,allow_source_send=True)
        self.assertEqual(report['status'],'completed')
        self.assertEqual(seen[0][0],'/v1/chat/completions')
        self.assertEqual(seen[0][1],'Bearer secret-test-key')
        self.assertEqual(seen[0][2]['model'],'chosen-model')
        self.assertNotIn('secret-test-key',json.dumps(report))
