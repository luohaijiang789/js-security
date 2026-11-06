import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from website_js_extractor.storage.capture_store import Receiver
from website_js_extractor.domain.protocol import SCHEMA, Invalid
from website_js_extractor.ingestion.raw import recover_raw
from website_js_extractor.cli import main


def raw_event(n, method, params, *, connection='connection', state='recording', session='root', target=None, **changes):
    observation=dict(connection=connection,sequence=n,source=dict(tabId=1,**({'sessionId':session} if session!='root' else {})),
                     method=method,params=params,observed_at=f'2026-11-05T01:00:{n:02}Z',config_version=1,capture_state=state,js_epoch='js-epoch',target_id=target,observed_tab_url='https://app.test/')
    text=json.dumps(observation,ensure_ascii=False);data=text.encode()
    event=dict(id=f'raw:{connection}:{n}',scan_id='scan',kind='RawCdpEvent',category='raw_cdp',time=observation['observed_at'],tab_id=1,
               session_id=session,epoch=connection,status='captured',data=dict(capture_json=text,capture_sha256=hashlib.sha256(data).hexdigest(),capture_bytes=len(data)),
               transport=dict(stream_id='raw-capture-stream',sequence=n))
    event.update(changes);return event


def request(url='https://app.test/api/items?x=0&empty='):
    return dict(requestId='req',type='Fetch',documentURL='https://app.test/',request=dict(url=url,method='POST',headers={'Content-Type':'application/json','Authorization':'original'},hasPostData=True,postData='{"id":0,"flag":false,"text":"字😀"}'),
                initiator=dict(type='script',stack=dict(callFrames=[dict(functionName='load',url='https://app.test/app.js',lineNumber=0,columnNumber=2)],parentId=dict(id='unknown-async'))))


class RawCaptureTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=Receiver(self.root/'data');self.addCleanup(self.store.close)

    def send(self,event):
        return self.store.event('default',dict(schema=SCHEMA,delivery_mode='window-1',event_json=json.dumps(event,ensure_ascii=False)))

    def test_raw_digest_identity_and_category_validation_are_atomic(self):
        event=raw_event(1,'Network.requestWillBeSent',request())
        for change in [dict(data={**event['data'],'capture_sha256':'f'*64}),dict(data={**event['data'],'capture_bytes':0}),dict(id='forged'),dict(category='task'),dict(transport=None)]:
            with self.subTest(change=change),self.assertRaises(Invalid): self.send({**event,**change})
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM events').fetchone()[0],0)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM raw_receipts').fetchone()[0],0)
        self.send(event);self.send(event)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM raw_receipts').fetchone()[0],1)

    def test_seal_requires_exact_raw_counts_bytes_and_methods(self):
        event=raw_event(1,'Network.requestWillBeSent',request());receipt=self.send(event)
        expected=dict(scan_id='scan',count=1,categories={'raw_cdp':1},bytes=receipt['transport']['event_bytes'])
        manifest=dict(count=1,bytes=event['data']['capture_bytes'],by_kind={'Network.requestWillBeSent':1})
        for raw in [None,{**manifest,'count':2},{**manifest,'bytes':0},{**manifest,'by_kind':{'Network.loadingFinished':1}}]:
            with self.subTest(raw=raw),self.assertRaises(Invalid): self.store.seal('default','raw-capture-stream',{**expected,**({'capture_journal':raw} if raw is not None else {})})
        final=self.store.seal('default','raw-capture-stream',{**expected,'capture_journal':manifest})
        self.assertEqual(final['capture_journal'],manifest)
        self.assertTrue(final['sealed'])

    def test_notification_only_recovery_preserves_request_response_stack_and_missing_body(self):
        events=[raw_event(1,'Network.requestWillBeSent',request()),raw_event(2,'Network.responseReceived',dict(requestId='req',response=dict(status=201,headers={'X-Result':'yes'},protocol='h2'))),raw_event(3,'Network.loadingFinished',dict(requestId='req'))]
        records,linked,_,issues,stats=recover_raw(list(reversed(events)))
        self.assertEqual(stats['recovered_requests'],1);self.assertFalse(linked)
        record=records[0]
        self.assertEqual(record['request_state'],'complete');self.assertEqual(record['status_code'],201)
        self.assertEqual(record['request_body']['parsed'],dict(id=0,flag=False,text='字😀'))
        self.assertEqual(record['initiator_stack']['parentId'],{'id':'unknown-async'})
        self.assertEqual(record['response_body']['representation'],'unavailable')
        self.assertEqual(record['raw_event_ids'],[e['id'] for e in events])
        self.assertIn('raw_recovered_request',[g['type'] for g in issues])

    def test_finalized_records_are_linked_without_double_counting(self):
        raw=raw_event(1,'Network.requestWillBeSent',request())
        finalized=dict(kind='ObservedRequest',data=dict(record=dict(request_id='connection:1:root:req:0',request_url='https://app.test/api/items')))
        records,linked,_,_,stats=recover_raw([raw,finalized])
        self.assertEqual(records,[]);self.assertEqual(linked['connection:1:root:req:0'],[raw['id']]);self.assertEqual(stats['linked_requests'],1)

    def test_redirect_and_session_boundaries_do_not_invent_late_header_assignment(self):
        redirect=request('https://app.test/next');redirect['redirectResponse']={'status':302,'headers':{'Location':'/next'}}
        events=[raw_event(1,'Network.requestWillBeSent',request()),raw_event(2,'Network.requestWillBeSent',redirect),raw_event(3,'Network.responseReceivedExtraInfo',dict(requestId='req',headers={'late':'ambiguous'})),raw_event(4,'Network.requestWillBeSent',request(),session='child'),raw_event(5,'Network.loadingFinished',dict(requestId='orphan'),session='other')]
        records,_,_,issues,_=recover_raw(events)
        self.assertEqual(len(records),3)
        self.assertEqual(records[0]['status_code'],302)
        self.assertNotIn({'name':'late','value':'ambiguous'},records[1]['response_headers'])
        self.assertIn('raw_redirect_headers_ambiguous',[g['type'] for g in issues])
        self.assertIn('raw_request_start_missing',[g['type'] for g in issues])
        # A paused redirect is not recovered as a new request, but still prevents
        # its ExtraInfo from being assigned to the previous recorded hop.
        records,_,_,issues,_=recover_raw([events[0],raw_event(2,'Network.requestWillBeSent',redirect,state='paused'),events[2]])
        self.assertEqual(len(records),1)
        self.assertNotIn({'name':'late','value':'ambiguous'},records[0]['response_headers'])
        self.assertIn('raw_redirect_headers_ambiguous',[g['type'] for g in issues])

    def test_extra_headers_survive_early_arrival_and_later_primary_response(self):
        for late in [False, True]:
            with self.subTest(late=late):
                methods=[('Network.requestWillBeSentExtraInfo',dict(requestId='req',headers={'Cookie':'proof','authorization':'wire'})),
                         ('Network.requestWillBeSent',request()),
                         ('Network.responseReceivedExtraInfo',dict(requestId='req',headers={'Set-Cookie':'proof','content-type':'wire'},headersText='HTTP/1.1 200 OK\r\nSet-Cookie: proof\r\n')),
                         ('Network.responseReceived',dict(requestId='req',response=dict(status=200,headers={'Content-Type':'cached','X-Base':'kept'})))]
                if late: methods=[methods[1],methods[0],methods[3],methods[2]]
                events=[raw_event(n,method,params) for n,(method,params) in enumerate(methods,1)]
                records,_,_,issues,_=recover_raw(events)
                record=records[0]
                self.assertEqual({h['name'].lower():h['value'] for h in record['request_headers']},
                                 {'content-type':'application/json','authorization':'wire','cookie':'proof'})
                self.assertEqual({h['name'].lower():h['value'] for h in record['response_headers']},
                                 {'content-type':'wire','x-base':'kept','set-cookie':'proof'})
                self.assertTrue(record['response_headers_raw'].endswith('Set-Cookie: proof\r\n'))
                self.assertEqual(record['raw_event_ids'],[e['id'] for e in events])
                self.assertNotIn('raw_request_start_missing',[g['type'] for g in issues])

    def test_context_reuse_binds_raw_scripts_to_lifetimes_and_keeps_unproven_host_unknown(self):
        from website_js_extractor.ingestion.stream import Ingest
        from website_js_extractor.analysis.engine import analyze,default_engine_root
        from website_js_extractor.analysis.results import build_candidates
        from test_stream import upload,script
        source=b"fetch('/api/current');"
        identity=upload(self.store,source)
        def ctx(n,host):
            result=raw_event(n,'Runtime.executionContextCreated',dict(context=dict(id=1,origin='https://'+host,name='',uniqueId=host,auxData=dict(isDefault=True,frameId='F'))),target='T1')
            observation=json.loads(result['data']['capture_json']);observation['observed_tab_url']='https://'+host+'/'
            text=json.dumps(observation,ensure_ascii=False);encoded=text.encode()
            result['data'].update(capture_json=text,capture_bytes=len(encoded),capture_sha256=hashlib.sha256(encoded).hexdigest())
            return result
        old=ctx(1,'old.test');clear=raw_event(3,'Runtime.executionContextsCleared',{},target='T1');new=ctx(4,'new.test')
        def parsed(n,script_id):
            return raw_event(n,'Debugger.scriptParsed',dict(scriptId=script_id,executionContextId=1,url='https://cdn.test/app.js'),target='T1')
        def captured(label):
            result=script(label,identity,'https://cdn.test/app.js',page_url='https://new.test/')
            result.update(scan_id='scan',epoch='js-epoch');result['data']['scriptId']=label;result['data']['cdp']['scriptId']=label
            return result
        for proven in [True,False,'ambiguous']:
            with self.subTest(proven=proven):
                events=[old,clear,new,captured('new-script')]
                if proven is True: events=[old,parsed(2,'old-script'),clear,new,parsed(5,'new-script'),captured('old-script'),captured('new-script')]
                elif proven=='ambiguous': events=[old,parsed(2,'new-script'),clear,new,parsed(5,'new-script'),captured('new-script')]
                # Content reads use the real durable receiver, while callback order is supplied explicitly.
                from website_js_extractor.ingestion.stream import EventReader
                reader=EventReader(self.root/'data')
                try:
                    snapshot=Ingest(reader,'scan',events,max_files=10,max_asset_bytes=1024,max_total_bytes=10240).build_snapshot(self.root/str(proven))
                    candidates,_,_=build_candidates(snapshot,analyze(snapshot,default_engine_root(),60))
                finally: reader.close()
                hosts={asset['request_base_url'] for asset in snapshot.assets}
                if proven is True:
                    self.assertEqual(hosts,{'https://old.test','https://new.test'})
                    self.assertEqual({c['url'] for c in candidates},{'https://old.test/api/current','https://new.test/api/current'})
                else:
                    self.assertEqual(hosts,{None})
                    self.assertFalse(any('old.test' in (c.get('url') or '') for c in candidates))

    def test_malformed_context_identities_remain_gaps_without_breaking_raw_recovery(self):
        events=[raw_event(1,'Runtime.executionContextCreated',dict(context=dict(id=[]))),
                raw_event(2,'Runtime.executionContextDestroyed',dict(executionContextId={})),
                raw_event(3,'Debugger.scriptParsed',dict(scriptId=[],executionContextId=[])),
                raw_event(4,'Debugger.scriptParsed',dict(scriptId='valid-script',executionContextId=[]))]
        _,_,projections,issues,_=recover_raw(events)
        self.assertEqual(len(projections),1)
        self.assertEqual(projections[0]['status'],'source_unavailable')
        self.assertEqual(sum(g['type']=='raw_projection_invalid' for g in issues),3)

    def test_pause_does_not_recover_new_requests_and_missing_sources_remain_explicit(self):
        events=[raw_event(1,'Network.requestWillBeSent',request(),state='paused'),raw_event(2,'Debugger.scriptParsed',dict(scriptId='lost',url='https://app.test/lost.js',executionContextId=1))]
        records,_,projections,_,_=recover_raw(events)
        self.assertEqual(records,[]);self.assertEqual(projections[0]['status'],'source_unavailable')
        self.assertNotIn('object_id',projections[0])

    def test_http_store_to_cli_recovery_exports_api_evidence_and_gap(self):
        for event in [raw_event(1,'Network.requestWillBeSent',request()),raw_event(2,'Network.loadingFailed',dict(requestId='req',errorText='connection closed'))]: self.send(event)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            code=main(['ingest','--data-dir',str(self.root/'data'),'--scan','scan','--offline','--out',str(self.root/'out')])
        report=json.loads((self.root/'out/analysis.json').read_text())
        self.assertEqual(code,4)
        self.assertEqual(report['raw_capture']['recovered_requests'],1)
        self.assertEqual(report['api_inventory'][0]['path_template'],'/api/items')
        self.assertEqual(report['observed_requests'][0]['recovery'],'raw-cdp')
        self.assertIn('raw_recovered_request',[g['kind'] for g in report['gaps']])

    def test_missing_raw_context_is_projected_without_false_missing_source_for_captured_js(self):
        from test_stream import upload, SOURCE, script
        identity=upload(self.store,SOURCE)
        ctx=raw_event(1,'Runtime.executionContextCreated',dict(context=dict(id=1,origin='https://app.test',name='',auxData=dict(isDefault=True,frameId='F',type='default'))),target='T1')
        parsed=raw_event(2,'Debugger.scriptParsed',dict(scriptId='S1',url='https://app.test/app.js',executionContextId=1),target='T1')
        derived=script('derived-script',identity,'https://app.test/app.js',page_url='https://app.test/')
        derived.update(scan_id='scan',epoch='js-epoch',transport=dict(stream_id='raw-capture-stream',sequence=3))
        for event in [ctx,parsed,derived]: self.send(event)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            main(['ingest','--data-dir',str(self.root/'data'),'--scan','scan','--offline','--out',str(self.root/'context-out')])
        report=json.loads((self.root/'context-out/analysis.json').read_text())
        self.assertEqual(len(report['assets']),1)
        self.assertEqual(len(report['capture_contexts']),1)
        self.assertNotIn('stream_source_unavailable',[gap['kind'] for gap in report['gaps']])
        self.assertNotIn('stream_context_missing',[gap['kind'] for gap in report['gaps']])

    def test_non_utf8_notification_remains_exact_escaped_evidence_without_breaking_analysis(self):
        event=raw_event(1,'Network.requestWillBeSent',request())
        observation=json.loads(event['data']['capture_json'])
        observation['params']['request']['postData']='unpaired:'+chr(0xd800)
        text=json.dumps(observation,ensure_ascii=True);data=text.encode()
        event['data']=dict(capture_json=text,capture_sha256=hashlib.sha256(data).hexdigest(),capture_bytes=len(data))
        self.send(event)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            code=main(['ingest','--data-dir',str(self.root/'data'),'--scan','scan','--offline','--out',str(self.root/'unicode-out')])
        report=json.loads((self.root/'unicode-out/analysis.json').read_text())
        self.assertEqual(code,4)
        self.assertIn('raw_text_not_utf8',[gap['kind'] for gap in report['gaps']])
        archived=json.loads((self.root/'unicode-out/raw-notifications.jsonl').read_text())
        self.assertEqual(archived['data']['capture_json'],text)

    def test_nonfinite_and_deep_request_bodies_do_not_break_recovery_or_invent_parameters(self):
        for body in ['NaN','{"x":NaN}','['*2000+'0'+']'*2000,'['*90+'0'+']'*90]:
            params=request();params['request']['postData']=body
            with self.subTest(body=body[:30]):
                recovered,_,_,issues,_=recover_raw([raw_event(1,'Network.requestWillBeSent',params)])
                self.assertEqual(recovered[0]['request_body']['raw'],body)
                json.dumps(recovered,allow_nan=False)
                if body.startswith('['):
                    self.assertEqual(recovered[0]['request_body']['parse_status'],'budget_exceeded')
                    self.assertIn('raw_body_parse_budget',[gap['type'] for gap in issues])
                else: self.assertEqual(recovered[0]['request_body']['parsed'],body)
