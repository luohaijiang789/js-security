#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {verifyExternalBaseline} from './external-baseline.js';
import {requestCsv,requestMarkdown} from './request-table.js';
try {
  const {values}=parseArgs({options:{manifest:{type:'string'},'source-root':{type:'string'},out:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('用法: node src/external-baseline-cli.js --manifest baselines/external/gdb.json --source-root /path/to/fixed-source [--out ../work/baselines/gdb.json]；预期不匹配退出 1，输入失败退出 2');
  else {
    if(!values.manifest||!values['source-root'])throw new Error('必须提供 --manifest 与 --source-root');
    const result=await verifyExternalBaseline(path.resolve(values.manifest),path.resolve(values['source-root']));
    if(values.out){const out=path.resolve(values.out);await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');await fs.writeFile(out+'.csv',requestCsv(result.rows));await fs.writeFile(out+'.md',requestMarkdown(result.rows,{repository:result.repository,commit:result.commit,mode:'source-static',gaps:['人工预期验证通过不等于提取完整；详见 JSON 中 validation、extractionComplete 和诊断。']}));}
    console.log(JSON.stringify({name:result.name,validationPassed:result.validationPassed,extractionComplete:result.extractionComplete,summary:result.validation.summary,completeness:result.validation.completeness,checks:result.validation.checks,unexpectedRows:result.validation.unexpectedRows,steps:result.stats.steps},null,2));if(!result.validationPassed)process.exitCode=1;
  }
} catch(error){console.error('外部基准失败: '+error.message);process.exitCode=2;}
