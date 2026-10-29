"""Fetch pinned upstreams and isolate dependencies under work/blackbox2-tools."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORK = ROOT/'work/blackbox2-tools'

def command(args, cwd=ROOT, env=None):
    subprocess.run(list(map(str,args)),cwd=cwd,env=env,check=True)

def main():
    WORK.mkdir(parents=True,exist_ok=True)
    for item in json.loads((HERE/'tools.json').read_text()):
        name=item['name']
        if name=='jshound':
            command(['git','submodule','update','--init','references/repos/jshound'])
            path=ROOT/item['source']
        else:
            path=WORK/'repos'/name
            if not path.exists():
                path.mkdir(parents=True)
                command(['git','init',path])
                command(['git','remote','add','origin','https://github.com/'+item['repo']+'.git'],cwd=path)
                command(['git','fetch','--depth','1','origin',item['commit']],cwd=path)
                command(['git','checkout','--detach','FETCH_HEAD'],cwd=path)
        sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=path,text=True).strip()
        if sha!=item['commit']:
            raise SystemExit(f'{name}: existing checkout differs from pinned commit; left untouched.')

    python=WORK/'venv/bin/python'
    if not python.exists(): command([sys.executable,'-m','venv',WORK/'venv'])
    command([python,'-m','pip','install','-r',HERE/'requirements.lock'])
    command([python,'-m','pip','install','--no-deps','-e',ROOT/'references/repos/jshound'])
    # Avoid xnLinkFinder setup.py, which installs configuration in the user's home.
    command(['npm','install','--prefix',WORK/'node-tools','--no-audit','--no-fund','esbuild@0.28.2'])

    go=WORK/'go/bin/go'
    if not go.exists(): go=shutil.which('go')
    if go and subprocess.run([str(go),'version'],capture_output=True).returncode==0:
        env=os.environ.copy()
        env.update(GOPATH=str(WORK/'gopath'),GOCACHE=str(WORK/'gocache'),GOTOOLCHAIN='local')
        (WORK/'bin').mkdir(exist_ok=True)
        for name,target in [('jsluice','./cmd/jsluice'),('URLFinder','.')]:
            command([go,'build','-o',WORK/'bin'/name,target],cwd=WORK/'repos'/name,env=env)
    else:
        print('Python tools prepared. Install a Go compiler (1.24 used in this experiment), then rerun to build jsluice/URLFinder.')

if __name__=='__main__': main()
