import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from website_js_extractor.assets import Snapshot,digest
from website_js_extractor.capture import validate_capture,import_capture,MAX_UPLOAD_BYTES
from website_js_extractor.collection import restore_snapshot
from website_js_extractor.engine import default_engine_root
from website_js_extractor.service import Jobs,make_server


def sample():
    content="import './missing.js'; fetch('./orders?limit=10');"
    return dict(schema_version='capture-0.1',snapshot_id='frozen-one',task_id='browser-task',gaps=[],assets=[dict(
        content=content,sha256=digest(content.encode()),url='https://cdn.test/main.js',context_key='tab-frame-epoch',
        context=dict(type='page',page_url='https://site.test/page/',request_base_url='https://site.test/base/',evidence='cdp_document_base'))])


class CaptureServiceTest(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.jobs=Jobs(self.root/'jobs',default_engine_root())
        self.server=make_server(0,self.jobs,'a'*32,'test-pairing-key')
        thread=threading.Thread(target=self.server.serve_forever,daemon=True);thread.start()
        def close():
            self.server.shutdown();self.server.server_close();self.jobs.close();thread.join(2)
        self.addCleanup(close)

    def request(self,method,path,body=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=20)
        values={'Origin':'chrome-extension://'+'a'*32,'Authorization':'Bearer test-pairing-key'}
        if body is not None:values['Content-Type']='application/json'
        values.update(headers or {})
        connection.request(method,path,None if body is None else json.dumps(body),values)
        response=connection.getresponse();data=response.read();result=(response.status,dict(response.getheaders()),json.loads(data) if data else None)
        connection.close();return result

    def test_pairing_origin_host_and_preflight(self):
        status,headers,cap=self.request('GET','/v0/capabilities')
        self.assertEqual(status,200);self.assertTrue(cap['offline_only'])
        for headers in [{'Authorization':'wrong'},{'Origin':'https://evil.test'},{'Origin':'null'},{'Host':'evil.test'}]:
            status,response,_=self.request('GET','/v0/capabilities',headers=headers)
            self.assertEqual(status,403)
            if headers.get('Origin') in {'https://evil.test','null'}:self.assertNotIn('Access-Control-Allow-Origin',response)
        self.assertEqual(self.request('OPTIONS','/v0/jobs',headers={'Authorization':''})[0],204)
        self.assertEqual(self.request('OPTIONS','/v0/jobs',headers={'Origin':'https://evil.test'})[0],403)

    def test_corrupt_body_and_upload_budgets_never_create_jobs(self):
        value=sample();value['assets'][0]['sha256']='0'*64
        self.assertEqual(self.request('POST','/v0/jobs',value)[0],400)
        self.assertEqual(self.request('POST','/v0/jobs',{},headers={'Content-Length':str(MAX_UPLOAD_BYTES+1)})[0],413)
        self.assertEqual(self.request('POST','/v0/jobs',{},headers={'Content-Type':'text/plain'})[0],400)
        self.assertEqual(self.jobs.records,{})

    def test_real_core_end_to_end_idempotent_snapshot_and_result(self):
        # No StaticFetcher may be constructed anywhere in this real core run.
        status,_,job=self.request('POST','/v0/jobs',sample());self.assertEqual(status,202)
        self.assertEqual(self.request('POST','/v0/jobs',sample())[2]['id'],job['id'])
        conflict=sample();conflict['gaps']=[dict(kind='different',message='changed input')]
        self.assertEqual(self.request('POST','/v0/jobs',conflict)[0],400)
        end=time.monotonic()+30
        while time.monotonic()<end:
            current=self.request('GET','/v0/jobs/'+job['id'])[2]
            if current['status'] not in {'queued','running'}:break
            time.sleep(.05)
        self.assertEqual(current['status'],'partial',current)
        status,_,report=self.request('GET','/v0/jobs/'+job['id']+'/result')
        self.assertEqual(status,200)
        self.assertEqual(report['candidates'][0]['url'],'https://site.test/base/orders?limit=10')
        self.assertIsNone(report['statistics']['confirmed_api_groups'])
        self.assertEqual(report['fetch_events'],[])
        self.assertFalse(report['task']['settings']['fetch_js'])
        self.assertTrue(any(g['kind']=='browser_capture_scope' for g in report['gaps']))
        restored=Snapshot(self.root/'restored');restore_snapshot(restored,self.jobs.directory/job['id']/'result');restored.resolve_contexts()
        self.assertEqual(restored.assets[0]['request_base_url'],'https://site.test/base/')
        self.assertEqual(self.request('GET','/v0/jobs/'+'f'*32)[0],404)
        self.assertEqual(self.request('GET','/v0/jobs/../../file')[0],404)

    def test_unknown_context_and_anonymous_sources_do_not_invent_host(self):
        value=sample();asset=value['assets'][0];asset.update(url=None,context=dict(type='unknown',page_url=None,request_base_url=None))
        path=self.root/'capture.json';path.write_text(json.dumps(value));snapshot=Snapshot(self.root/'snapshot');import_capture(snapshot,path);snapshot.resolve_contexts()
        self.assertIsNone(snapshot.assets[0]['url']);self.assertIsNone(snapshot.assets[0]['request_base_url'])
        asset['context']['request_base_url']='https://invented.test/'
        with self.assertRaisesRegex(ValueError,'Unknown contexts'):validate_capture(value)
        value=sample();value['assets'][0]['url']='file:///etc/passwd'
        with self.assertRaisesRegex(ValueError,'Unsupported script URL'):validate_capture(value)
        value=sample();value['assets'][0]['content']='x'*(2*1024*1024+1)
        with self.assertRaisesRegex(ValueError,'body budget'):validate_capture(value)

    def test_queued_cancel_and_restart_state_are_explicit(self):
        # Hold scheduling, so queued cancellation/restart cannot accidentally run code.
        with patch.object(self.jobs.pool,'submit'):
            job=self.jobs.submit(sample());self.jobs.cancel(job['id']);self.jobs.run(job['id'])
        self.assertEqual(self.jobs.get(job['id'])['status'],'cancelled')
        with self.assertRaisesRegex(ValueError,'not ready'):self.jobs.result(job['id'])
        self.jobs.update(job['id'],status='running')
        other=Jobs(self.jobs.directory,default_engine_root())
        try:
            self.assertEqual(other.get(job['id'])['status'],'interrupted')
            self.assertFalse(list(self.jobs.directory.glob('*/result/analysis.json')))
        finally:other.close()

    def test_conflicting_capture_bases_are_rejected(self):
        value=sample();second=json.loads(json.dumps(value['assets'][0]));second['context']['request_base_url']='https://different.test/'
        value['assets'].append(second)
        with self.assertRaisesRegex(ValueError,'Conflicting browser'):validate_capture(value)

    @unittest.skipUnless(__import__('os').name=='posix','POSIX process-group check')
    def test_analysis_interrupt_reaps_the_isolated_engine_process(self):
        import subprocess,sys
        from website_js_extractor.engine import analyze
        original_popen=subprocess.Popen
        real=[]
        class Interrupted:
            def __init__(self):
                self.inner=original_popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)
                real.append(self.inner);self.pid=self.inner.pid;self.first=True
            def poll(self):return self.inner.poll()
            def wait(self,**kwargs):
                if self.first:self.first=False;raise KeyboardInterrupt()
                return self.inner.wait(**kwargs)
        snapshot=Snapshot(self.root/'interrupt')
        snapshot.add(b"fetch('/never');",location='a.js',kind='js',page_url='https://site.test/')
        snapshot.resolve_contexts()
        try:
            with patch('website_js_extractor.engine.verify_engine',return_value=default_engine_root()),patch('website_js_extractor.engine.subprocess.Popen',side_effect=lambda *args,**kwargs:Interrupted()):
                with self.assertRaises(KeyboardInterrupt):analyze(snapshot,default_engine_root(),10)
            self.assertIsNotNone(real[0].poll())
        finally:
            for process in real:
                if process.poll() is None:process.kill();process.wait()
