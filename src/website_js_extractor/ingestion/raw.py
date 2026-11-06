"""Recover notification-only evidence without issuing commands against expired CDP IDs."""
import json
from collections import Counter, defaultdict
from urllib.parse import parse_qsl, urlsplit
from website_js_extractor.domain.raw import parse_raw
from website_js_extractor.domain.protocol import Invalid, strict_json


def mapping(value):
    return value if isinstance(value,dict) else {}


def pairs(headers):
    return [dict(name=str(name),value=str(value)) for name,value in headers.items()] if isinstance(headers,dict) else []


def merge_headers(base,extra):
    # Header names are case-insensitive; ExtraInfo wins conflicts, base-only fields remain visible.
    names={header['name'].lower() for header in extra}
    return [header for header in base if header['name'].lower() not in names] + extra


def parse_body(text):
    if not isinstance(text,str): return None,'unavailable'
    if len(text.encode('utf-8')) > 2*1024*1024: return None,'budget_exceeded'
    try: value=strict_json(text)
    except Invalid as error:
        return (None,'budget_exceeded') if isinstance(error.__cause__,RecursionError) else (text,'raw_text')
    stack=[(value,0)];nodes=0
    while stack:
        node,depth=stack.pop();nodes+=1
        if depth>64 or nodes>100000: return None,'budget_exceeded'
        if isinstance(node,dict): stack.extend((item,depth+1) for item in node.values())
        elif isinstance(node,list): stack.extend((item,depth+1) for item in node)
    return value,'parsed'


def recover_raw(events):
    raw, issues, projections = [], [], []
    for event in events:
        if event.get('kind') != 'RawCdpEvent': continue
        try:
            observation=parse_raw(event)
            try: json.dumps(observation,ensure_ascii=False).encode('utf-8')
            except RecursionError:
                issues.append(dict(type='raw_projection_budget',message='Raw notification nesting exceeds projection budget; exact raw evidence retained.',source=event.get('id')))
                continue
            except UnicodeError:
                issues.append(dict(type='raw_text_not_utf8',message='Notification contains non-UTF8 text; exact escaped raw evidence retained without inventing a normalized value.',source=event.get('id')))
                continue
            raw.append((event,observation))
        except (Invalid,UnicodeError,TypeError) as error:
            issues.append(dict(type='raw_observation_invalid',message=str(error),source=event.get('id')))
    # Receipt/ACK order is not the callback order. Connection changes are explicit boundaries.
    raw.sort(key=lambda item: (item[1]['connection'],item[1]['sequence']))
    derived = {e['data']['record']['request_id']:e['data']['record'] for e in events
               if e.get('kind')=='ObservedRequest' and isinstance(e.get('data',{}).get('record'),dict) and e['data']['record'].get('request_id')}
    from website_js_extractor.ingestion.contexts import project_contexts
    projections, context_issues = project_contexts(events,raw)
    issues.extend(context_issues)
    extras=defaultdict(list)
    starts=Counter()
    order={event['id']:index for index,(event,_) in enumerate(raw)}
    channels=defaultdict(list)
    for event,observation in raw:
        method,p=observation['method'],observation['params']
        source=observation['source']; tab,session=source['tabId'],source.get('sessionId','root')
        if not method.startswith('Network.') or not isinstance(p.get('requestId'),str): continue
        key=(observation['connection'],tab,session,p['requestId'])
        hops=channels[key]
        if method in {'Network.requestWillBeSentExtraInfo','Network.responseReceivedExtraInfo'}:
            extras[key].append((event,method,p))
            continue
        if method=='Network.requestWillBeSent':
            starts[key]+=1
            request=p.get('request')
            if not isinstance(request,dict): continue
            if hops and isinstance(p.get('redirectResponse'),dict):
                previous=hops[-1]; previous['request_state']='redirect'
                response=mapping(p['redirectResponse']); previous.update(status_code=response.get('status'),response_headers=pairs(response.get('headers')),response_metadata=response)
            if observation['capture_state']!='recording': continue
            url=request.get('url')
            try: parsed=urlsplit(url) if isinstance(url,str) else None
            except ValueError: parsed=None
            if not parsed or parsed.scheme not in {'http','https'} or not parsed.hostname: continue
            raw_body=request.get('postData')
            body,body_parse_status=parse_body(raw_body)
            if body_parse_status=='budget_exceeded':
                issues.append(dict(type='raw_body_parse_budget',message='Request body exceeds JSON projection budget; original text is retained.',source=event['id']))
            initiator=p.get('initiator') if isinstance(p.get('initiator'),dict) else {}
            stack=initiator.get('stack') if isinstance(initiator.get('stack'),dict) else None
            frames=stack.get('callFrames',[]) if stack else []
            frames=frames if isinstance(frames,list) else []
            record=dict(request_id=f'{key[0]}:{tab}:{session}:{key[3]}:{len(hops)}',cdp_request_id=key[3],tab_id=tab,session_id=session,
                        target_id=observation.get('target_id'),redirect_hop=len(hops),request_url=url,host=parsed.netloc,pathname=parsed.path or '/',method=str(request.get('method') or 'UNKNOWN').upper(),
                        timestamp=observation['observed_at'],page_url=p.get('documentURL'),resource_type=p.get('type'),
                        frame_id=p.get('frameId'),loader_id=p.get('loaderId'),request_state='incomplete',status_code=None,
                        request_headers=pairs(request.get('headers')),query_params=[dict(name=k,value=v) for k,v in parse_qsl(parsed.query,keep_blank_values=True)],
                        request_body=dict(raw=raw_body,parsed=body,parse_status=body_parse_status),response_headers=[],response_body=dict(representation='unavailable',parsed=None),
                        initiator=initiator,initiator_url=initiator.get('url') or next((f.get('url') for f in frames if isinstance(f,dict) and isinstance(f.get('url'),str) and f.get('url')),None),
                        initiator_stack=stack,raw_event_ids=[event['id']],recovery='raw-cdp',filter_result='unknown',filter_version=observation['config_version'],
                        capture_status=dict(headers=dict(state='partial',reason='Only persisted notification headers; browser may omit additional headers.'),response_headers=dict(state='partial',reason='Only persisted response notifications.'),body=dict(state='complete' if isinstance(raw_body,str) or not request.get('hasPostData') else 'missing'),
                            response_body=dict(state='missing',reason='Response bodies are command results, not CDP notifications.'),
                            stack=dict(state='partial' if stack else 'missing',reason='Only persisted notification frames; unresolved async parents remain unknown.')))
            hops.append(record)
            continue
        if not hops:
            issues.append(dict(type='raw_request_start_missing',message='Terminal/extra notification has no persisted request start; original event retained.',source=event['id']))
            continue
        record=hops[-1];record['raw_event_ids'].append(event['id'])
        if method=='Network.responseReceived':
            response=mapping(p.get('response'))
            record.update(status_code=response.get('status'),response_headers=pairs(response.get('headers')),response_metadata=response)
        elif method=='Network.loadingFinished': record['request_state']='complete'
        elif method=='Network.loadingFailed': record.update(request_state='failed',error=p.get('errorText'))
    for key,items in extras.items():
        hops=channels[key]
        for event,method,p in items:
            if not hops:
                issues.append(dict(type='raw_request_start_missing',message='ExtraInfo has no persisted request start; original event retained.',source=event['id']))
            elif starts[key]>1:
                issues.append(dict(type='raw_redirect_headers_ambiguous',message='ExtraInfo cannot be assigned to a unique redirect hop safely.',source=event['id']))
            else:
                record=hops[0]
                field='request_headers' if method=='Network.requestWillBeSentExtraInfo' else 'response_headers'
                record[field]=merge_headers(record[field],pairs(p.get('headers')))
                if method=='Network.responseReceivedExtraInfo' and isinstance(p.get('headersText'),str): record['response_headers_raw']=p['headersText']
                record['raw_event_ids'].append(event['id'])
        for record in hops: record['raw_event_ids'].sort(key=lambda identity:order[identity])
    recovered,linked=[],{}
    for hops in channels.values():
        for record in hops:
            if record['request_id'] in derived: linked[record['request_id']]=record['raw_event_ids']
            else:
                recovered.append(record)
                issues.append(dict(type='raw_recovered_request',message='Recovered request/response/initiator evidence from raw notifications; unavailable command results remain missing.',source=record['raw_event_ids'],request_id=record['request_id']))
    return recovered,linked,projections,issues,dict(events=sum(event.get("kind")=="RawCdpEvent" for event in events),projectable_events=len(raw),recovered_requests=len(recovered),linked_requests=len(linked))
