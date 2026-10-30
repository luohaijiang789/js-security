"""Analyze one immutable public bundle offline; no API calls or coverage claim."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request

HERE=Path(__file__).resolve().parent
BASE=HERE.parents[1]/'work/blackbox2-tools'
sample=json.loads((HERE/'public-sample.json').read_text())
folder=BASE/'public-swagger-ui'
folder.mkdir(exist_ok=True)
asset=folder/'swagger-ui-bundle.js'
if not asset.exists():
    with urllib.request.urlopen(sample['url'],timeout=30) as response: asset.write_bytes(response.read())
if hashlib.sha256(asset.read_bytes()).hexdigest()!=sample['sha256']:
    raise SystemExit('Public sample hash mismatch.')

tasks={
    'jshound-public':[BASE/'venv/bin/jshound',folder,'-o',BASE/'results/jshound-public'],
    'jsluice-public':[BASE/'bin/jsluice','urls',asset],
    'linkfinder-public':[BASE/'venv/bin/python',BASE/'repos/LinkFinder/linkfinder.py','-i',asset,'-o','cli'],
}
def run(item):
    name,args=item;start=time.monotonic()
    with (BASE/'results'/f'{name}.stdout').open('w') as out, (BASE/'results'/f'{name}.stderr').open('w') as err:
        try:
            result=subprocess.run(list(map(str,args)),stdout=out,stderr=err,timeout=90)
            code=result.returncode
        except subprocess.TimeoutExpired: code=124
    return {'name':name,'command':list(map(str,args)),'seconds':round(time.monotonic()-start,3),'exit_code':code}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(run,tasks.items()))
(BASE/'results/public-runs.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
