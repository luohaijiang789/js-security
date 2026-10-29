import json
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parents[2] / 'work/blackbox2-tools'
P = BASE / 'results'
truth = json.loads((BASE/'truth.json').read_text())

def lines(path):
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()]

def match(url, expected):
    # Path comparison only; host correctness is checked separately for the known client.
    path = urlsplit(url).path
    return path.startswith(expected['path']) if expected.get('dynamic') else path == expected['path']

def evaluate(records):
    matched=[]
    for expected in truth['requests']:
        if any(match(r.get('url',''),expected) and r.get('method')==expected['method'] for r in records):
            matched.append(expected['id'])
    return {'correct_method_and_path':len(matched),'denominator':len(truth['requests']),'matched':matched,
            'decoy_paths_in_output':[d for d in truth['decoys'] if any(urlsplit(r.get('url','')).path==d for r in records)],
            'raw_records':len(records)}

results={}
for name,directory in [('jshound-offline','jshound-offline'),('jshound-online','jshound-online'),('jshound-min','jshound-min')]:
    results[name]=evaluate(lines(P/directory/'requests.jsonl'))
for name in ['jsluice-offline','jsluice-min']:
    results[name]=evaluate(lines(P/(name+'.stdout')))

def leaf_paths(value,prefix=''):
    if not isinstance(value,dict): return []
    out=[]
    for key,v in value.items():
        path=f'{prefix}.{key}' if prefix else key
        out.extend(leaf_paths(v,path) if isinstance(v,dict) and v else [path])
    return out

raw=json.loads((P/'jshound-internal.json').read_text())
api=[r for r in raw if r.get('template') and not r.get('_kind')]
query_names={}
for r in api:
    q=r.get('query_schema') or []
    query_names[r['template']]=sorted(q.keys() if isinstance(q,dict) else [x['name'] for x in q])
results['jshound-query-internal']={'fields':query_names,'count':sum(map(len,query_names.values())),'expected_fields':4}
exported=lines(P/'jshound-offline/requests.jsonl')
results['jshound-query-jsonl']={'records_with_query_or_query_schema':sum(bool(r.get('query') or r.get('query_schema') or '?' in r.get('url','')) for r in exported)}
body_correct=[]
for expected in truth['requests']:
    for field in expected['body']:
        if any(match(r.get('url',''),expected) and field in leaf_paths(r.get('body',{})) for r in exported):
            body_correct.append(expected['id']+':'+field)
results['jshound-body-jsonl']={'correct':len(body_correct),'expected':sum(len(t['body']) for t in truth['requests']),'fields':body_correct}

traffic=json.loads((P/'http-traffic.json').read_text())
results['traffic']={}
for tool in sorted({x['tool'] for x in traffic}):
    rows=[r for r in traffic if r['tool']==tool]
    results['traffic'][tool]={'requests':len(rows),'paths':[r['path'] for r in rows],
        'api_gets':[r['path'] for r in rows if r['path'].startswith('/api/')],
        'js_bodies_requested':sorted({urlsplit(r['path']).path.replace('/./','/') for r in rows if urlsplit(r['path']).path.endswith('.js')})}

(P/'score.json').write_text(json.dumps(results,indent=2))
for name,value in results.items():
    if name!='traffic':print(name,json.dumps(value))
for name,value in results['traffic'].items():print(name,'HTTP:',value['requests'],'JS:',len(value['js_bodies_requested']),'API GETs:',len(value['api_gets']))
