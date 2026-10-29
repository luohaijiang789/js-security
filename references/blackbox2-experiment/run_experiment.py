import functools
import http.server
import json
import os
import pty
import subprocess
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parents[2] / 'work/blackbox2-tools'
REPO = BASE.parent.parent
PYTHON = BASE / 'venv/bin/python'
RESULTS = BASE / 'results'
RESULTS.mkdir(exist_ok=True)
active = 'setup'
traffic = []

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        traffic.append({'tool':active,'method':'GET','path':self.path})
        super().do_GET()
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(BASE/'fixture')))
threading.Thread(target=server.serve_forever,daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/'
env = os.environ.copy()
env['PYTHONPATH'] = str(BASE/'repos/xnLinkFinder')
env['TLDEXTRACT_CACHE'] = str(BASE/'tld-cache')
# Redirect only xnLinkFinder's default config directory; its JS analysis is unchanged.
xn_entry = [PYTHON, '-c', "from pathlib import Path; import xnLinkFinder.xnLinkFinder as m; m.getXnLinkFinderPath=lambda: Path(" + repr(str(BASE/'xn-config')) + "); m.main()"]
runs = []

def run(name, args, cwd=None, limit=90):
    global active
    active=name
    start=time.monotonic()
    try:
        # xnLinkFinder ignores -i with non-terminal stdin, including empty stdin.
        # Give it a terminal for directory/URL inputs; leave tool code unchanged.
        master, slave = pty.openpty() if name.startswith('xnlinkfinder-') else (None,None)
        try:
            r=subprocess.run([str(a) for a in args],cwd=cwd or REPO,env=env,stdin=slave,capture_output=True,text=True,timeout=limit)
        finally:
            if master is not None:
                os.close(master)
                os.close(slave)
        code=r.returncode; out=r.stdout; err=r.stderr
    except subprocess.TimeoutExpired as e:
        code=124; out=e.stdout or b''; err=e.stderr or b''
        out=out.decode(errors='replace') if isinstance(out,bytes) else out
        err=err.decode(errors='replace') if isinstance(err,bytes) else err
    (RESULTS/f'{name}.stdout').write_text(out)
    (RESULTS/f'{name}.stderr').write_text(err)
    result={'name':name,'command':[str(a) for a in args],'cwd':str(cwd or REPO),'seconds':round(time.monotonic()-start,3),'exit_code':code}
    runs.append(result)
    print(json.dumps(result),flush=True)

try:
    run('jshound-offline',[BASE/'venv/bin/jshound',BASE/'fixture','-o',RESULTS/'jshound-offline'])
    run('jshound-online',[BASE/'venv/bin/jshound',url,'--allow-private','--max-chunks','30','--timeout','5','-o',RESULTS/'jshound-online'])
    run('jsluice-offline',[BASE/'bin/jsluice','urls','--include-source',*sorted((BASE/'fixture').glob('*.js'))])
    for p in sorted((BASE/'fixture').glob('*.js')):
        run('linkfinder-'+p.stem,[PYTHON,BASE/'repos/LinkFinder/linkfinder.py','-i',p,'-o','cli'])
    run('xnlinkfinder-offline',xn_entry+['-i',BASE/'fixture','--config',BASE/'repos/xnLinkFinder/config.yml','-o',RESULTS/'xn-offline-links.txt','-op',RESULTS/'xn-offline-params.txt','-ow','-nb','-nwlpl'])
    run('xnlinkfinder-online',xn_entry+['-i',url,'--config',BASE/'repos/xnLinkFinder/config.yml','-sf','127.0.0.1','-sp',url.rstrip('/'),'-d','4','-p','2','-t','3','-o',RESULTS/'xn-online-links.txt','-op',RESULTS/'xn-online-params.txt','-ow','-nb','-nwlpl'],limit=90)
    run('jsfinder-online',[PYTHON,BASE/'repos/JSFinder/JSFinder.py','-u',url,'-ou',RESULTS/'jsfinder-links.txt','-os',RESULTS/'jsfinder-domains.txt'])
    run('jsfinder-deep',[PYTHON,BASE/'repos/JSFinder/JSFinder.py','-u',url,'-d','-ou',RESULTS/'jsfinder-deep-links.txt','-os',RESULTS/'jsfinder-deep-domains.txt'])
    run('urlfinder-normal',[BASE/'bin/URLFinder','-u',url,'-m','1','-t','4','-time','3','-max','100','-o',RESULTS/'urlfinder-normal'])
    run('urlfinder-deep',[BASE/'bin/URLFinder','-u',url,'-m','2','-t','4','-time','3','-max','100','-o',RESULTS/'urlfinder-deep'])
    run('jshound-internal',[PYTHON,'-c',"import jshound,json; print(json.dumps(jshound.analyze("+repr(str(BASE/'fixture'))+")))"])
    (RESULTS/'jshound-internal.json').write_text((RESULTS/'jshound-internal.stdout').read_text())
    esbuild=BASE/'node-tools/node_modules/.bin/esbuild'
    if esbuild.exists():
        run('minify',[esbuild,*sorted((BASE/'fixture').glob('*.js')),'--minify','--format=esm','--outdir='+str(BASE/'fixture-min')])
        run('jshound-min',[BASE/'venv/bin/jshound',BASE/'fixture-min','-o',RESULTS/'jshound-min'])
        run('jsluice-min',[BASE/'bin/jsluice','urls',*sorted((BASE/'fixture-min').glob('*.js'))])
        run('linkfinder-min',[PYTHON,BASE/'repos/LinkFinder/linkfinder.py','-i',BASE/'fixture-min/*.js','-o','cli'])
finally:
    server.shutdown()
    (RESULTS/'runs.json').write_text(json.dumps(runs,indent=2))
    (RESULTS/'http-traffic.json').write_text(json.dumps(traffic,indent=2))
    print('Saved commands, outputs, timings and HTTP traffic.',flush=True)
