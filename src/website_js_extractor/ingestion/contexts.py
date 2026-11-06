"""Bind captured scripts to raw context lifetimes instead of reusable numeric IDs."""
from collections import defaultdict
from website_js_extractor.domain.assets import digest


def scope(event, observation=None):
    if observation is None:
        data=event.get('data') or {}
        return (event.get('scan_id'),event.get('tab_id'),event.get('session_id') or 'root',event.get('epoch'),str(data.get('target_id') or '') or None)
    source=observation['source']
    return (event.get('scan_id'),source['tabId'],source.get('sessionId') or 'root',observation.get('js_epoch') or observation['connection'],str(observation.get('target_id') or '') or None)


def script_matches(data, params):
    for field in ['executionContextId','url','hash','startLine','startColumn','endLine','endColumn']:
        if field in data and field in params and data[field] != params[field]: return False
    return True


def project_contexts(events, raw):
    """Replay raw lifetimes, then place delayed source results at proven script slots.

    Raw callback sequence is authoritative. Receipt order of derived source/context
    events is not: a slow getScriptSource can finish after a navigation. Unmatched
    sources retain their bytes but receive a separate, unknown context generation.
    """
    active=defaultdict(dict)
    timeline=[]
    scripts=[]
    script_index=defaultdict(list)
    context_signatures=defaultdict(list)
    touched=set()
    issues=[]
    for event,observation in raw:
        method,p=observation['method'],observation['params']
        key=scope(event,observation)
        if method.startswith('Runtime.executionContext'):
            touched.add(key)
            projected={**event,'id':event['id']+':projection','kind':method,'epoch':key[3], 'category':'page_context',
                       'data':{**p,'target_id':key[4],'observed_tab_url':observation.get('observed_tab_url')}}
            if method=='Runtime.executionContextCreated':
                context=p.get('context')
                if not isinstance(context,dict) or type(context.get('id')) is not int:
                    issues.append(dict(type='raw_projection_invalid',message='Context identity has an unsupported shape.',source=event['id']))
                    continue
                identity=context['id'];signature=digest(context)
                previous=active[key].get(identity)
                if previous and previous['signature']==signature:
                    continue
                generation=event['id']
                active[key][identity]=dict(generation=generation,signature=signature,unique_id=context.get('uniqueId'))
                projected['data']['context_generation']=generation
                context_signatures[(key,identity,signature)].append(projected)
            elif method=='Runtime.executionContextDestroyed':
                identity=p.get('executionContextId')
                if type(identity) is not int:
                    issues.append(dict(type='raw_projection_invalid',message='Destroyed context identity has an unsupported shape.',source=event['id']))
                    continue
                previous=active[key].get(identity)
                unique=p.get('executionContextUniqueId')
                if previous and (not unique or not previous['unique_id'] or unique==previous['unique_id']):
                    active[key].pop(identity)
            else: active[key].clear()
            timeline.append(('context',projected))
        elif method=='Debugger.scriptParsed':
            identity=p.get('scriptId')
            if not isinstance(identity,str):
                issues.append(dict(type='raw_projection_invalid',message='Script identity has an unsupported shape.',source=event['id']));continue
            context_id=p.get('executionContextId')
            context=active[key].get(context_id) if type(context_id) is int else None
            generation=context['generation'] if context else 'unknown:'+event['id']
            observation_index=len(scripts)
            scripts.append((event,observation,key,identity,generation))
            script_index[(key,identity)].append(observation_index)
            timeline.append(('script',observation_index))
    outputs=defaultdict(list)
    covered=set()
    unknown=[]
    for event in events:
        data=event.get('data') or {};key=scope(event)
        if event.get('kind')=='Runtime.executionContextCreated' and isinstance(data.get('context'),dict):
            context=data['context']
            matches=context_signatures.get((key,context.get('id'),digest(context))) if type(context.get('id')) is int else None
            if matches: matches[0].setdefault('_replaces',[]).append(event.get('id'))
        elif event.get('kind')=='Debugger.scriptParsed':
            identity=data.get('scriptId') or data.get('script_id') or (data.get('cdp') if isinstance(data.get('cdp'),dict) else {}).get('scriptId')
            if not isinstance(identity,str): continue
            details={**(data.get('cdp') if isinstance(data.get('cdp'),dict) else {}),**data}
            matches=[index for index in script_index.get((key,identity),[])
                     if script_matches(details,scripts[index][1]['params'])]
            generations={scripts[index][4] for index in matches}
            # Repeated notifications in one lifetime are safe; reuse across lifetimes
            # without an additional distinguishing field must remain ambiguous.
            if len(generations)==1:
                index=matches[0]
                outputs[index].append({**event,'data':{**data,'context_generation':next(iter(generations))},'_replaces':[event.get('id')]})
                covered.update(matches)
            elif matches or key in touched:
                unknown.append({**event,'data':{**data,'context_generation':'unbound:'+str(event.get('id'))},'_replaces':[event.get('id')]})
                issues.append(dict(type='raw_context_binding_unknown',message='No unique raw context lifetime can be proven for this captured script.',source=event.get('id')))
    projections=[]
    for kind,value in timeline:
        if kind=='context': projections.append(value);continue
        if outputs[value]: projections.extend(outputs[value])
        if value in covered: continue
        event,observation,key,_,generation=scripts[value]
        projections.append({**event,'id':event['id']+':projection','kind':'Debugger.scriptParsed','epoch':key[3],
                            'category':'js_source','status':'source_unavailable',
                            'data':{**observation['params'],'target_id':key[4],'observed_tab_url':observation.get('observed_tab_url'),
                                    'context_generation':generation,'error':'No captured source is uniquely associated with this raw script notification.'}})
    projections.extend(unknown)
    # Replacements keep their server identities; originals remain immutable in the input store/JSONL.
    return projections,issues
