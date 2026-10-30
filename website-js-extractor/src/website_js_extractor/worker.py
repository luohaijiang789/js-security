"""Isolated engine process. No fetch APIs or target code execution are used."""
import json
from pathlib import Path
import subprocess
import sys

AUDIT = r'''
const fs=require('fs');
const parser=require(process.argv[1]).parser;
const files=JSON.parse(fs.readFileSync(0,'utf8'));
const results=[];
for (const file of files) {
  const source=fs.readFileSync(file,'utf8');
  let ast=null, last='';
  for (const options of [
    {sourceType:'unambiguous',plugins:['jsx','typescript'],errorRecovery:true},
    {sourceType:'unambiguous',plugins:[],errorRecovery:true},
    {sourceType:'script',plugins:[],errorRecovery:true}
  ]) {
    try { ast=parser.parse(source,options); break; } catch(e) { last=e.message; }
  }
  const warnings=[];
  // Fixed upstream skips single-segment fetch URLs. Report the model gap;
  // identifier spelling alone is not binding evidence for a confirmed API.
  if (ast) {
    const pending=[ast];
    while (pending.length) {
      const node=pending.pop();
      if (!node || typeof node!=='object') continue;
      if (node.type==='CallExpression' && node.callee?.type==='Identifier' && node.callee.name==='fetch') {
        const arg=node.arguments[0];
        if (arg?.type==='StringLiteral' && arg.value && !/[/:]/.test(arg.value))
          warnings.push({kind:'bare_relative_fetch',expression:arg.value,line:node.loc?.start.line});
      }
      for (const [key,value] of Object.entries(node)) {
        if (['loc','start','end','comments','tokens'].includes(key)) continue;
        if (Array.isArray(value)) pending.push(...value);
        else if (value && typeof value==='object') pending.push(value);
      }
    }
  }
  results.push({file,status:!ast?'failed':ast.errors.length?'partial':'parsed',
    errors:ast?ast.errors.map(e=>e.message):[last],warnings});
}
process.stdout.write(JSON.stringify(results));
'''


def main():
    engine_root, corpus, output = map(Path, sys.argv[1:])
    sys.path.insert(0, str(engine_root))
    import jshound
    records, paths = jshound.analyze_with_paths(str(corpus))
    audit = subprocess.run(['node', '-e', AUDIT, str(engine_root/'jshound/js/babel.js')],
                           input=json.dumps(paths), text=True, capture_output=True, check=True)
    result = dict(records=records, read_paths=paths, parse_audit=json.loads(audit.stdout))
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
