import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import glob from 'fast-glob';
import {analyze} from './analyzer.js';
import {requestRows} from './request-table.js';
import {compareRequests} from './request-diff.js';

export async function verifyBaseline(directory,manifestName='manifest.json') {
  if(path.basename(manifestName)!==manifestName)throw new Error('manifest 必须在基准根目录');
  const root=await fs.realpath(directory),manifest=JSON.parse(await fs.readFile(path.join(root,manifestName),'utf8'));
  if(manifest.schemaVersion!==1||manifest.kind!=='authored-regression'||!Array.isArray(manifest.files)||!manifest.files.length||typeof manifest.expectedComplete!=='boolean'||!manifest.config||typeof manifest.config!=='object'||Array.isArray(manifest.config))throw new Error('不支持的基准 manifest');
  for(const file of manifest.files){
    if(typeof file.path!=='string'||path.isAbsolute(file.path)||file.path.split(/[\\/]/).some(p=>p==='..'||p==='')||! /^[a-f0-9]{64}$/.test(file.sha256))throw new Error('基准文件路径/哈希无效');
    const full=await fs.realpath(path.join(root,file.path));if(!full.startsWith(root+path.sep))throw new Error('基准文件超出目录');
    if(createHash('sha256').update(await fs.readFile(full)).digest('hex')!==file.sha256)throw new Error('基准哈希不匹配: '+file.path);
  }
  const tracked=new Set(manifest.files.map(f=>f.path));
  if(!tracked.has('expected.json'))throw new Error('预期文件必须固定哈希');
  const scripts=await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}'],{cwd:root,followSymbolicLinks:false});
  if(scripts.some(file=>!tracked.has(file)))throw new Error('存在未登记的基准脚本');
  const expected=JSON.parse(await fs.readFile(path.join(root,'expected.json'),'utf8'));
  const report=await analyze(root,manifest.config),rows=requestRows(report);
  const diff=compareRequests(expected,{rows});
  const completeness={expected:manifest.expectedComplete,actual:report.stats.complete};
  return {manifest:manifest.name,completeness,diff,passed:diff.passed&&completeness.expected===completeness.actual,stats:report.stats,rows};
}
