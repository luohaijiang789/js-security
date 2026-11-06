import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from test_raw_capture import raw_event, request
from website_js_extractor.domain.protocol import Invalid, SCHEMA
from website_js_extractor.ingestion.raw import recover_raw
from website_js_extractor.storage.capture_store import Receiver
from website_js_extractor.cli import main


def command_event(n, method, params, *, phase='result', identity='command', binding=None, result=None, error=None, **changes):
    event=raw_event(n,method,params,**changes)
    observation=json.loads(event['data']['capture_json'])
    command=dict(phase=phase,command_id=identity,binding=binding or {})
    if phase=='result': command.update(error=error) if error is not None else command.update(result=result or {})
    observation['command']=command
    text=json.dumps(observation,ensure_ascii=True);encoded=text.encode()
    event.update(kind='RawCdpCommandStarted' if phase=='started' else 'RawCdpCommandResult',
                 data=dict(capture_json=text,capture_bytes=len(encoded),capture_sha256=hashlib.sha256(encoded).hexdigest()))
    return event


def pair(n,method,params,result=None,**kwargs):
    return [command_event(n,method,params,phase='started',**kwargs),command_event(n+1,method,params,result=result,**kwargs)]


class CommandCaptureTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=Receiver(self.root/'data');self.addCleanup(self.store.close)

    def put(self,event):
        return self.store.event('default',dict(schema=SCHEMA,delivery_mode='window-1',event_json=json.dumps(event)))

    def test_command_validation_and_idempotent_seal_require_all_command_bytes(self):
        events=pair(1,'Network.getResponseBody',dict(requestId='req'),dict(body='字😀',base64Encoded=False))
        for change in [dict(kind='RawCdpEvent'),dict(category='task')]:
            with self.subTest(change=change),self.assertRaises(Invalid): self.put({**events[0],**change})
        total=0
        for event in events:
            ack=self.put(event);self.put(event);total+=ack['transport']['event_bytes']
        manifest=dict(count=2,bytes=sum(e['data']['capture_bytes'] for e in events),by_kind={'Network.getResponseBody':2})
        expected=dict(scan_id='scan',count=2,bytes=total,categories=dict(raw_cdp=2))
        with self.assertRaises(Invalid): self.store.seal('default','raw-capture-stream',expected)
        self.assertTrue(self.store.seal('default','raw-capture-stream',{**expected,'capture_journal':manifest})['sealed'])

    def test_request_response_and_async_stack_recover_without_finalized_record(self):
        params=request();params['request'].pop('postData')
        binding=dict(request_id='connection:1:root:req:0')
        events=[raw_event(1,'Network.requestWillBeSent',params),
                *pair(2,'Network.getRequestPostData',dict(requestId='req'),dict(postData='{"id":0,"flag":false}'),binding=binding,identity='post'),
                *pair(4,'Network.getResponseBody',dict(requestId='req'),dict(body=base64.b64encode('{"text":"字😀"}'.encode()).decode(),base64Encoded=True),binding=binding,identity='response'),
                *pair(6,'Debugger.getStackTrace',dict(stackTraceId=dict(id='unknown-async')),dict(stackTrace=dict(callFrames=[dict(functionName='caller',url='https://app.test/caller.js',lineNumber=2,columnNumber=3)])),binding=binding,identity='parent')]
        records,_,_,issues,stats=recover_raw(events)
        record=records[0]
        self.assertEqual(record['request_body']['parsed'],dict(id=0,flag=False))
        self.assertEqual(record['response_body']['parsed'],dict(text='字😀'))
        self.assertEqual(record['response_body']['encoding'],'base64')
        self.assertEqual(record['initiator_stack']['parent']['callFrames'][0]['functionName'],'caller')
        self.assertEqual(len(record['command_event_ids']),3)
        self.assertEqual(stats['command_results'],3)
        self.assertNotIn('command_result_missing',[g['type'] for g in issues])

    def test_existing_finalized_record_is_enriched_once_without_mutating_original(self):
        record=dict(request_id='connection:1:root:req:0',request_url='https://app.test/api',response_body=dict(representation='unavailable'))
        event=dict(id='finalized',kind='ObservedRequest',data=dict(record=record))
        original=json.dumps(event,sort_keys=True)
        events=[raw_event(1,'Network.requestWillBeSent',request()),event,
                *pair(2,'Network.getResponseBody',dict(requestId='req'),dict(body='ok',base64Encoded=False),binding=dict(request_id=record['request_id']))]
        recovered,linked,projections,_,_=recover_raw(events)
        self.assertEqual(recovered,[]);self.assertIn(record['request_id'],linked)
        updated=next(p for p in projections if p['kind']=='ObservedRequest')
        self.assertEqual(updated['data']['record']['response_body']['raw'],'ok')
        self.assertEqual(json.dumps(event,sort_keys=True),original)

    def test_incomplete_mismatched_failed_and_wrong_scope_commands_do_not_invent_bodies(self):
        start=raw_event(1,'Network.requestWillBeSent',request())
        for variant in ['unfinished','mismatch','failure','wrong-session','wrong-hop']:
            with self.subTest(variant=variant):
                binding=dict(request_id='connection:1:root:req:0')
                if variant=='wrong-hop': binding['request_id']='connection:1:root:req:1'
                changes=dict(session='child') if variant=='wrong-session' else {}
                events=pair(2,'Network.getResponseBody',dict(requestId='req'),dict(body='should-not-attach'),binding=binding,**changes,
                            **(dict(error='browser detached') if variant=='failure' else {}))
                if variant=='unfinished': events.pop()
                if variant=='mismatch': events[1]=command_event(3,'Network.getResponseBody',dict(requestId='different'),result=dict(body='wrong'),binding=binding)
                records,_,_,issues,_=recover_raw([start,*events])
                self.assertEqual(records[0]['response_body']['representation'],'unavailable')
                self.assertTrue(any(g['type'].startswith('command_') for g in issues))

    def test_binary_and_malformed_base64_are_not_fabricated_as_text(self):
        for encoded,valid in [(base64.b64encode(b'\xff\x00').decode(),True),('%%%bad',False)]:
            events=[raw_event(1,'Network.requestWillBeSent',request()),*pair(2,'Network.getResponseBody',dict(requestId='req'),dict(body=encoded,base64Encoded=True),binding=dict(request_id='connection:1:root:req:0'))]
            records,_,_,issues,_=recover_raw(events)
            self.assertEqual(records[0]['response_body']['representation'],'binary' if valid else 'unavailable')
            if valid: self.assertIsNone(records[0]['response_body']['parsed'])
            else: self.assertIn('command_body_invalid',[g['type'] for g in issues])

    def test_disagreeing_body_reads_and_unmatched_results_remain_unknown(self):
        binding=dict(request_id='connection:1:root:req:0')
        events=[raw_event(1,'Network.requestWillBeSent',request()),
                *pair(2,'Network.getResponseBody',dict(requestId='req'),dict(body='first'),binding=binding,identity='first'),
                *pair(4,'Network.getResponseBody',dict(requestId='req'),dict(body='different'),binding=binding,identity='second')]
        records,_,_,issues,_=recover_raw(events)
        self.assertEqual(records[0]['response_body']['representation'],'unavailable')
        self.assertIn('command_body_ambiguous',[gap['type'] for gap in issues])
        records,_,_,issues,_=recover_raw([events[0],events[2]])
        self.assertEqual(records[0]['response_body']['representation'],'unavailable')
        self.assertIn('command_identity_ambiguous',[gap['type'] for gap in issues])

    def test_result_from_replaced_session_is_retained_without_becoming_body_evidence(self):
        events=pair(2,'Network.getResponseBody',dict(requestId='req'),dict(body='stale'),binding=dict(request_id='connection:1:root:req:0'))
        result=events[1];observation=json.loads(result['data']['capture_json']);observation['command']['context_valid']=False
        text=json.dumps(observation);encoded=text.encode()
        result['data'].update(capture_json=text,capture_bytes=len(encoded),capture_sha256=hashlib.sha256(encoded).hexdigest())
        records,_,_,issues,_=recover_raw([raw_event(1,'Network.requestWillBeSent',request()),*events])
        self.assertEqual(records[0]['response_body']['representation'],'unavailable')
        self.assertIn('command_context_changed',[gap['type'] for gap in issues])

    def test_form_body_recovery_preserves_duplicate_blank_fields_and_complete_normalization(self):
        params=request();params['request']['headers']['Content-Type']='application/x-www-form-urlencoded'
        params['request'].pop('postData');text='id=0&tag=one&tag=two&empty='
        events=[raw_event(1,'Network.requestWillBeSent',params),*pair(2,'Network.getRequestPostData',dict(requestId='req'),dict(postData=text),binding=dict(request_id='connection:1:root:req:0'))]
        records,_,_,_,_=recover_raw(events)
        expected=[dict(name='id',value='0'),dict(name='tag',value='one'),dict(name='tag',value='two'),dict(name='empty',value='')]
        self.assertEqual(records[0]['request_body']['representation'],'form')
        self.assertEqual(records[0]['request_body']['parsed'],expected)
        original=dict(request_id='connection:1:root:req:0',content_type='application/x-www-form-urlencoded',request_body=dict(raw=text,parsed=expected,representation='form'),capture_status=dict(body=dict(state='complete')))
        _,_,projections,_,_=recover_raw([*events,dict(id='derived',kind='ObservedRequest',data=dict(record=original))])
        updated=next(event for event in projections if event['kind']=='ObservedRequest')['data']['record']
        self.assertEqual(updated['request_body']['parsed'],expected)
        self.assertEqual(updated['request_body']['representation'],'form')

    def test_persisted_source_result_alone_recovers_real_js_and_static_api_after_crash(self):
        source="fetch('/api/from-command', {method:'POST',body:JSON.stringify({zero:0})});"
        parsed=dict(scriptId='S1',executionContextId=1,url='https://cdn.test/app.js')
        events=[raw_event(1,'Runtime.executionContextCreated',dict(context=dict(id=1,origin='https://app.test',auxData=dict(isDefault=True))),target='T'),
                raw_event(2,'Debugger.scriptParsed',parsed,target='T'),
                *pair(3,'Debugger.getScriptSource',dict(scriptId='S1'),dict(scriptSource=source),binding=dict(script=parsed,source_event_id='missing-derived',observed_tab_url='https://app.test/'),target='T')]
        for event in events: self.put(event)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            main(['ingest','--data-dir',str(self.root/'data'),'--scan','scan','--offline','--out',str(self.root/'out')])
        report=json.loads((self.root/'out/analysis.json').read_text())
        self.assertEqual(len(report['assets']),1)
        self.assertIn('https://app.test/api/from-command',[candidate['url'] for candidate in report['candidates']])
        self.assertEqual((self.root/'out/snapshot'/f'{hashlib.sha256(source.encode()).hexdigest()}.js').read_text(),source)
        self.assertNotIn('stream_source_unavailable',[gap['kind'] for gap in report['gaps']])
        self.assertEqual(len((self.root/'out/raw-notifications.jsonl').read_text().splitlines()),4)
