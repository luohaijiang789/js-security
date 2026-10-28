#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {compareRequests,diffMarkdown} from './request-diff.js';
try {
  const {values}=parseArgs({options:{expected:{type:'string'},actual:{type:'string'},out:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('用法: node src/compare-cli.js --expected before.json --actual after.json [--out diff.json]；有差异退出 1，输入错误退出 2');
  else {
    if(!values.expected||!values.actual)throw new Error('必须提供 --expected 和 --actual');
    const [expected,actual]=await Promise.all([values.expected,values.actual].map(file=>fs.readFile(path.resolve(file),'utf8').then(JSON.parse)));
    const result=compareRequests(expected,actual);
    if(values.out){const file=path.resolve(values.out);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(result,null,2)+'\n');await fs.writeFile(file+'.md',diffMarkdown(result));}
    console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
  }
} catch(error){console.error('请求比较失败: '+error.message);process.exitCode=2;}
