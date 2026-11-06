"""Recover persisted CDP results; never issue browser commands during replay."""
import base64
import copy
import hashlib
from collections import defaultdict
from urllib.parse import parse_qsl

from website_js_extractor.domain.assets import digest


def command_key(event, observation):
    source=observation['source']
    return (event.get('scan_id'),observation['connection'],source['tabId'],source.get('sessionId','root'),observation['command']['command_id'])


def recover_commands(events, raw):
    starts=defaultdict(list);results=defaultdict(list);issues=[];successes=[];scripts=[]
    for event,observation in raw:
        if event.get('kind')=='RawCdpCommandStarted': starts[command_key(event,observation)].append((event,observation))
        elif event.get('kind')=='RawCdpCommandResult': results[command_key(event,observation)].append((event,observation))
    existing={event.get('id'):event for event in events if event.get('kind')=='Debugger.scriptParsed'}
    order={event['id']:index for index,(event,_) in enumerate(raw)}
    for key in sorted(starts.keys() | results.keys(),key=lambda item:min(order[event['id']] for event,_ in starts[item]+results[item])):
        intents,completed=starts[key],results[key]
        if len(intents)!=1 or len(completed)!=1:
            kind='command_result_missing' if len(intents)==1 and not completed else 'command_identity_ambiguous'
            issues.append(dict(type=kind,message='Command has no unique persisted intent/result pair; no result is inferred.',source=[event['id'] for event,_ in intents+completed]))
            continue
        intent,start=intents[0];event,observation=completed[0]
        fields=['method','params','js_epoch','target_id']
        if (any(start.get(field)!=observation.get(field) for field in fields)
            or start['command']['binding']!=observation['command']['binding'] or start['sequence']>=observation['sequence']):
            issues.append(dict(type='command_identity_ambiguous',message='Command result does not match its persisted intent.',source=event['id']));continue
        command=observation['command']
        if 'error' in command:
            issues.append(dict(type='command_failed',message=command['error'][:2000],source=event['id']));continue
        if command.get('context_valid') is False:
            issues.append(dict(type='command_context_changed',message='Command completed after its capture session changed; exact result retained without assigning it to an old script/request.',source=event['id']));continue
        successes.append((event,observation))
        if observation['method']!='Debugger.getScriptSource': continue
        binding=command['binding'];params=observation['params'];parsed=binding.get('script');source=command['result'].get('scriptSource')
        if not isinstance(parsed,dict) or parsed.get('scriptId')!=params.get('scriptId') or not isinstance(source,str):
            issues.append(dict(type='command_source_binding_unknown',message='Source result has no matching captured script identity.',source=event['id']));continue
        try: encoded=source.encode('utf-8')
        except UnicodeError:
            issues.append(dict(type='command_source_not_utf8',message='Source bytes cannot be represented losslessly as UTF8.',source=event['id']));continue
        identity=hashlib.sha256(encoded).hexdigest();original_id=binding.get('source_event_id')
        previous=existing.get(original_id)
        if previous and previous.get('object_id'):
            if previous['object_id']!=identity:
                issues.append(dict(type='command_source_conflict',message='Derived source and command result differ; neither is silently replaced.',source=event['id']))
            continue
        scripts.append({**event,'id':original_id or event['id']+':script','kind':'Debugger.scriptParsed','category':'js_source',
                        'epoch':observation.get('js_epoch') or observation['connection'],'status':'captured','object_id':identity,
                        '_source_text':source,'_replaces':[original_id] if previous else [],
                        'data':{**parsed,'target_id':observation.get('target_id'),
                                'observed_tab_url':binding.get('observed_tab_url',observation.get('observed_tab_url')),
                                'source_bytes':len(encoded),'representation':'debugger-parsed-source',
                                'recovery':'raw-command','command_event_ids':[intent['id'],event['id']]}})
    return successes,scripts,issues


def enrich_requests(records, commands, parse_body):
    """Only exact durable request IDs are accepted, including their redirect hop."""
    issues=[];by_id={record['request_id']:record for record in records};stacks=defaultdict(dict)
    variants=defaultdict(set)
    for _,observation in commands:
        request_id=observation['command']['binding'].get('request_id')
        if isinstance(request_id,str) and observation['method'] in {'Network.getRequestPostData','Network.getResponseBody'}:
            variants[(request_id,observation['method'])].add(digest(observation['command']['result']))
    for event,observation in commands:
        method=observation['method'];command=observation['command'];binding=command['binding'];request_id=binding.get('request_id')
        if method=='Debugger.getScriptSource': continue
        if len(variants.get((request_id,method),()))>1:
            issues.append(dict(type='command_body_ambiguous',message='Repeated body reads disagree; no version is selected arbitrarily.',source=event['id']));continue
        record=by_id.get(request_id) if isinstance(request_id,str) else None
        if record is None:
            issues.append(dict(type='command_request_binding_unknown',message='Command has no matching request/hop in this frozen input.',source=event['id']));continue
        prefix=f"{observation['connection']}:{observation['source']['tabId']}:"
        if not request_id.startswith(prefix):
            issues.append(dict(type='command_request_binding_unknown',message='Command request is outside its connection/tab.',source=event['id']));continue
        result=command['result'];record.setdefault('command_event_ids',[]).append(event['id'])
        if method=='Debugger.getStackTrace':
            identity=observation['params'].get('stackTraceId')
            if isinstance(identity,dict) and isinstance(result.get('stackTrace'),dict):
                stacks[request_id][digest(identity)]=result['stackTrace']
            continue
        expected=f"{prefix}{observation['source'].get('sessionId','root')}:{observation['params'].get('requestId')}:"
        if not request_id.startswith(expected):
            issues.append(dict(type='command_request_binding_unknown',message='Body result belongs to a different CDP session/request.',source=event['id']));continue
        field='request_body' if method=='Network.getRequestPostData' else 'response_body'
        text=result.get('postData') if field=='request_body' else result.get('body')
        if not isinstance(text,str):
            issues.append(dict(type='command_body_invalid',message='Command did not return body text.',source=event['id']));continue
        representation='text';encoding='utf8';parsed=None;status='raw_text'
        if field=='response_body' and result.get('base64Encoded'):
            encoding='base64'
            try:
                decoded=base64.b64decode(text,validate=True)
                try: plain=decoded.decode('utf-8');parsed,status=parse_body(plain)
                except UnicodeError: representation='binary';status='binary'
            except (ValueError,UnicodeError):
                issues.append(dict(type='command_body_invalid',message='Malformed base64 response; exact command retained.',source=event['id']));continue
        else:
            parsed,status=parse_body(text)
            headers=record.get('request_headers' if field=='request_body' else 'response_headers') or []
            content_type=str(record.get('content_type' if field=='request_body' else 'response_content_type') or next((header.get('value','') for header in headers if str(header.get('name','')).lower()=='content-type'),'')).lower()
            if 'application/x-www-form-urlencoded' in content_type and status!='budget_exceeded':
                representation='form'
                try:
                    parsed=[dict(name=name,value=value) for name,value in parse_qsl(text,keep_blank_values=True,max_num_fields=100000)]
                    status='parsed'
                except ValueError: parsed=None;status='budget_exceeded'
            elif 'multipart/' in content_type:
                parsed=None;representation='multipart';status='raw_text'
        previous=record.get(field) or {}
        quality='body' if field=='request_body' else 'response_body'
        previous_quality=(record.get('capture_status') or {}).get(quality) or {}
        if previous.get('raw')==text and previous.get('encoding','utf8')==encoding and previous_quality.get('state')=='complete':
            # A recovered raw result must not downgrade a complete normalized form/JSON body.
            record[field]={**previous,'recovery':'raw-command'}
        else: record[field]=dict(raw=text,parsed=parsed,parse_status=status,encoding=encoding,representation=representation,recovery='raw-command')
        record.setdefault('capture_status',{})[quality]=dict(state='partial' if status=='budget_exceeded' else 'complete',reason='Persisted CDP command result; does not imply browser-wide completeness.')
    for request_id,parents in stacks.items():
        record=by_id[request_id];seen=set();budget=[33]
        def resolve(node):
            if not isinstance(node,dict) or budget[0]<=0: return None
            budget[0]-=1
            out={field:copy.deepcopy(node[field]) for field in ['callFrames','description','parentId'] if field in node}
            if isinstance(node.get('parent'),dict): out['parent']=node['parent']
            if isinstance(out.get('parent'),dict): out['parent']=resolve(out['parent'])
            elif isinstance(out.get('parentId'),dict):
                key=digest(out['parentId'])
                if key not in seen and key in parents:
                    seen.add(key);out['parent']=resolve(parents[key])
            return out
        record['initiator_stack']=resolve(record.get('initiator_stack'))
        record.setdefault('capture_status',{})['stack']=dict(state='partial',reason='Persisted parent results attached where identities match; browser history and unresolved parents remain unknown.')
    return issues
