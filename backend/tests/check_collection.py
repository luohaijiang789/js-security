"""Frozen public reference fixtures plus an inspectable local recursive-GET run."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from website_js_extractor.assets import Snapshot
from website_js_extractor.collection import ReferenceGraph
from website_js_extractor.engine import default_engine_root

ROOT = Path(__file__).resolve().parents[2]


def main():
    target = ROOT/'work'/('site-collection-check-'+uuid.uuid4().hex[:10])
    target.mkdir(parents=True)
    manifest=json.loads(Path(__file__).with_name('reference-manifest.json').read_text())
    public=[]
    for case in manifest['cases']:
        path=default_engine_root()/case['path']
        source=path.read_bytes()
        if hashlib.sha256(source).hexdigest()!=case['sha256']:
            raise SystemExit('Public reference fixture hash mismatch: '+case['path'])
        snap=Snapshot(target/('public-'+case['name']))
        asset=snap.add(source,location=case['path'],url='https://cdn.example.test/main.js',page_url='https://site.example.test/',kind='js')
        snap.resolve_contexts()
        graph=ReferenceGraph(snap,default_engine_root(),seeds=[asset['url']])
        graph.run()
        refs={e['target'] for e in graph.edges}
        assert set(case['expected_targets'])==refs,(case['name'],refs)
        if 'expected_urls' in case:
            assert set(case['expected_urls'])=={e['target_url'] for e in graph.edges}
        if case['name']=='vite':
            assert sum(e['confidence']=='certain' for e in graph.edges)==2
            assert sum(e['confidence']=='candidate' for e in graph.edges)==3
        public.append({'fixture':case['name'],'references':len(refs),'edges':graph.edges})
    traffic=[]
    files={'/b.js':b"import './c.js'; export function b(){fetch('/api/b');}",
           '/c.js':b"import './d.js'; export function c(){fetch('/api/c');}",
           '/d.js':b"import './b.js'; export function d(){fetch('/api/d');}"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            traffic.append(self.path)
            data=files.get(self.path)
            self.send_response(200 if data is not None else 404)
            self.send_header('Content-Type','application/javascript')
            self.end_headers()
            self.wfile.write(data or b'')
        def log_message(self,*args): pass

    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base=f'http://127.0.0.1:{server.server_port}'
    seed=target/'seed.har'
    seed.write_text(json.dumps({'log':{'pages':[{'id':'p','title':base+'/'}],'entries':[
        {'pageref':'p','request':{'url':base+'/'},'response':{'status':200,'content':{'mimeType':'text/html','text':'<script type="module" src="/main.js"></script>'}}},
        {'pageref':'p','request':{'url':base+'/main.js'},'response':{'status':200,'content':{'mimeType':'application/javascript','text':"import './b.js'; export function main(){fetch('/api/main')}"}}}
    ]}}))
    summary=[]
    try:
        configurations=[('offline',['--har',str(seed)]),
                        ('depth3',['--har',str(seed),'--fetch-js','--allow-origin',base]),
                        ('resume4',['--resume',str(target/'depth3'),'--fetch-js','--allow-origin',base,'--max-js-depth','4'])]
        for name,arguments in configurations:
            traffic.clear()
            command=[sys.executable,'-m','website_js_extractor','analyze',*arguments,'--out',str(target/name)]
            result=subprocess.run(command,capture_output=True,text=True,timeout=120)
            (target/(name+'.log')).write_text(result.stdout+result.stderr)
            report=json.loads((target/name/'analysis.json').read_text())
            expected_code=0 if name=='resume4' else 4
            assert result.returncode==expected_code,(name,result.stderr)
            expected_traffic=[] if name=='offline' else ['/b.js','/c.js'] if name=='depth3' else ['/d.js']
            assert traffic==expected_traffic,(name,traffic)
            assert report['statistics']['request_candidates']=={'offline':1,'depth3':3,'resume4':4}[name]
            assert not any(url.startswith('/api/') for url in traffic)
            summary.append(dict(name=name,command=command,exit_code=result.returncode,traffic=list(traffic),statistics=report['statistics']))
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)
    (target/'verification.json').write_text(json.dumps(dict(time=datetime.now(timezone.utc).isoformat(),public=public,runs=summary),indent=2))
    print(json.dumps(dict(output=str(target),public_fixtures=len(public),runs=summary),indent=2))


if __name__=='__main__':main()
