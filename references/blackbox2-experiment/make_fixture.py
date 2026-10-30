import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'work/blackbox2-tools'
SITE = ROOT / 'fixture'
files = {
    'index.html': '''<!doctype html><html><head><script type="module" src="/main.js"></script></head><body>Static extraction fixture. No business actions.</body></html>''',
    'main.js': '''import './level2.js';
export function users() { return fetch('/api/users?limit=10'); }
export function orders(userId) { return fetch('/api/orders', {method:'POST', headers:{'X-Tenant':'fixture'}, body:JSON.stringify({userId, context:{source:'fixture'}})}); }
export function profile(name) { const xhr=new XMLHttpRequest(); xhr.open('PUT','/api/profile'); xhr.setRequestHeader('Content-Type','application/json'); xhr.send(JSON.stringify({name})); }
export function track(event) { return navigator.sendBeacon('/api/events', JSON.stringify({event})); }
export function catalog() { return axios.get('/api/catalog', {params:{page:1, sort:'new'}}); }
const httpFetch = fetch;
export function alias() { return httpFetch('/api/alias'); }
export function item(id) { return fetch('/api/items/'+id+'?view=full'); }
function send(url, data) { return fetch(url,{method:'POST',body:JSON.stringify(data)}); }
export function alpha() { return send('/api/alpha',{alphaId:1}); }
export function beta() { return send('/api/beta',{betaId:2}); }
const client=axios.create({baseURL:'https://api.fixture.invalid/v2'});
export function ticket(title) { return client.post('/tickets',{title}); }
export const documentation='/not-a-network-route';
export function request(value) { return value; }
request('/ordinary-function');
export const asset='/assets/logo.svg';
''',
    'level2.js': "import './level3.js';\nexport function nested2(){return fetch('/api/layer2',{method:'POST',body:JSON.stringify({level:2})});}\n",
    'level3.js': "import './level4.js';\nexport function nested3(){return fetch('/api/layer3');}\n",
    'level4.js': "import './level2.js';\nexport function nested4(){return fetch('/api/layer4');}\n",
}
truth = [
    {'id':'users','path':'/api/users','method':'GET','query':['limit'],'body':[], 'file':'main.js'},
    {'id':'orders','path':'/api/orders','method':'POST','query':[],'body':['userId','context.source'],'headers':['X-Tenant'], 'file':'main.js'},
    {'id':'profile','path':'/api/profile','method':'PUT','query':[],'body':['name'], 'file':'main.js'},
    {'id':'events','path':'/api/events','method':'POST','query':[],'body':['event'], 'file':'main.js'},
    {'id':'catalog','path':'/api/catalog','method':'GET','query':['page','sort'],'body':[], 'file':'main.js'},
    {'id':'alias','path':'/api/alias','method':'GET','query':[],'body':[], 'file':'main.js'},
    {'id':'item','path':'/api/items/','method':'GET','query':['view'],'body':[], 'file':'main.js','dynamic':True},
    {'id':'alpha','path':'/api/alpha','method':'POST','query':[],'body':['alphaId'], 'file':'main.js'},
    {'id':'beta','path':'/api/beta','method':'POST','query':[],'body':['betaId'], 'file':'main.js'},
    {'id':'ticket','path':'/v2/tickets','method':'POST','query':[],'body':['title'], 'file':'main.js'},
    {'id':'layer2','path':'/api/layer2','method':'POST','query':[],'body':['level'], 'file':'level2.js'},
    {'id':'layer3','path':'/api/layer3','method':'GET','query':[],'body':[], 'file':'level3.js'},
    {'id':'layer4','path':'/api/layer4','method':'GET','query':[],'body':[], 'file':'level4.js'},
]
SITE.mkdir(exist_ok=True)
hashes = {}
for name, content in files.items():
    (SITE / name).write_text(content)
    hashes[name] = hashlib.sha256(content.encode()).hexdigest()
(ROOT / 'truth.json').write_text(json.dumps({'requests':truth,'decoys':['/not-a-network-route','/ordinary-function','/assets/logo.svg'],'hashes':hashes},indent=2))
print(f'Frozen {len(files)} assets, {len(truth)} requests, 3 decoys.')
