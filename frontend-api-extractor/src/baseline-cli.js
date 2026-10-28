#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {verifyBaseline} from './baseline.js';
try {
  const {values}=parseArgs({options:{manifest:{type:'string'},out:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('用法: node src/baseline-cli.js [--manifest examples/request-baseline/manifest.json] [--out result.json]');
  else {
    const file=values.manifest?path.resolve(values.manifest):fileURLToPath(new URL('../examples/request-baseline/manifest.json',import.meta.url));
    const result=await verifyBaseline(path.dirname(file),path.basename(file));
    if(values.out){const out=path.resolve(values.out);await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');}
    console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
  }
} catch(error){console.error('基准复跑失败: '+error.message);process.exitCode=2;}
