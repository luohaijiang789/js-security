import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {analyze} from './analyzer.js';
import {validateConfig} from './config.js';
import {requestRows} from './request-table.js';
import {githubRepository} from './repository-task.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const relativeFile=value=>typeof value==='string'&&value.length>0&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(p=>!p||p==='.'||p==='..');
const unknown=value=>Boolean(value&&typeof value==='object'&&Object.hasOwn(value,'__unknown'))||typeof value==='string'&&/\{[^}]+\}/.test(value);
const sorted=value=>[...new Set(value)].sort();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const conditionKey=values=>sorted(values.map(({file,line,column,expression,outcome})=>JSON.stringify([file,line,column,expression,outcome])));
export function matchesExpectation(actual,expected) {
  if(expected&&typeof expected==='object'&&!Array.isArray(expected)&&Object.keys(expected).length===1&&expected.$unknown===true)return unknown(actual);
  if(expected===null||typeof expected!=='object')return actual===expected;
  if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>matchesExpectation(actual[i],v));
  return Boolean(actual&&typeof actual==='object'&&!Array.isArray(actual)&&same(Object.keys(actual).sort(),Object.keys(expected).sort())&&Object.entries(expected).every(([key,value])=>matchesExpectation(actual[key],value)));
}

export function checkExternalExpectations(rows,expected,stats,usages=[]) {
  if(expected.schemaVersion!==1||!Array.isArray(expected.calls)||!expected.calls.length||typeof expected.expectedComplete!=='boolean')throw new Error('人工预期必须包含 calls 和 expectedComplete');
  const ids=new Set(),checks=[],claimed=new Set();
  for(const call of expected.calls){
    if(typeof call.id!=='string'||!call.id||ids.has(call.id)||!relativeFile(call.file)||!Number.isSafeInteger(call.line)||call.line<1||!Number.isSafeInteger(call.column)||call.column<1||!call.evidence||!call.pattern||typeof call.pattern!=='object'||Array.isArray(call.pattern))throw new Error('人工预期 ID、位置或依据无效');
    ids.add(call.id);
    for(const field of ['method','host','url','query','body','headers','resolution'])if(!Object.hasOwn(call.pattern,field))throw new Error('人工预期缺字段: '+field);
    if(!Array.isArray(call.conditions)||call.conditions.some(c=>!relativeFile(c.file)||!Number.isSafeInteger(c.line)||!Number.isSafeInteger(c.column)||typeof c.expression!=='string'||typeof c.outcome!=='boolean'))throw new Error('条件预期必须显式标注');
    if(!Array.isArray(call.knownFields)||call.knownFields.some(f=>!['query','body','headers'].includes(f.carrier)||!Array.isArray(f.path)||!f.path.length||f.path.some(v=>typeof v!=='string')))throw new Error('knownFields 必须显式标注');
    const candidates=rows.map((row,index)=>({row,index})).filter(({row})=>row.sourceFile===call.file&&row.sourceLine===call.line&&row.sourceColumn===call.column&&row.stage==='call-site');
    const matches=candidates.filter(({row})=>same(conditionKey(row.conditions),conditionKey(call.conditions))&&Object.entries(call.pattern).every(([key,value])=>matchesExpectation(row[key],value)));
    const issues=[];
    if(matches.length!==1)issues.push(`应唯一匹配，实际 ${matches.length} 行；位置候选 ${candidates.length} 行`);
    if(matches.length===1){
      const {row,index}=matches[0];if(claimed.has(index))issues.push('同一行被多个人工预期重复认领');claimed.add(index);
      const fields=sorted(row.parameterFields.filter(f=>f.state==='known-field').map(f=>JSON.stringify([f.carrier,f.path])));
      const wanted=sorted(call.knownFields.map(f=>JSON.stringify([f.carrier,f.path])));
      if(!same(fields,wanted))issues.push('已知字段路径不匹配');
      if(call.requiredGaps?.some(text=>!row.gaps.some(gap=>gap.includes(text))))issues.push('要求保留的缺口丢失');
      if(call.postHookState!==undefined){
        const linked=usages.filter(u=>{const sink=u.callChain.at(-1);return sink.file===call.file&&sink.line===call.line&&sink.column===call.column;});
        if(!linked.length||linked.some(u=>u.postHookState!==call.postHookState))issues.push('hook 后状态与人工限定不匹配');
      }
    }
    checks.push({id:call.id,file:call.file,line:call.line,column:call.column,evidence:call.evidence,passed:!issues.length,issues,candidateRows:candidates.map(c=>c.index)});
  }
  const unexpectedRows=rows.map((row,index)=>({index,file:row.sourceFile,line:row.sourceLine,column:row.sourceColumn,url:row.url})).filter(({index})=>!claimed.has(index));
  const completeness={expected:expected.expectedComplete,actual:stats.complete,matched:expected.expectedComplete===stats.complete};
  return {passed:checks.every(c=>c.passed)&&!unexpectedRows.length&&completeness.matched,checks,unexpectedRows,completeness,summary:{expected:checks.length,matched:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,unexpected:unexpectedRows.length}};
}

export async function verifyExternalBaseline(manifestFile,sourceRoot) {
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(manifest.schemaVersion!==1||manifest.kind!=='external-source-slice'||! /^[a-f0-9]{40}$/.test(manifest.commit)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>100||!relativeFile(manifest.expectedFile)||! /^[a-f0-9]{64}$/.test(manifest.expectedSha256)||!manifest.config||typeof manifest.config!=='object'||Array.isArray(manifest.config))throw new Error('外部切片 manifest 无效');
  const repository=githubRepository(manifest.repository),root=await fs.realpath(sourceRoot),expectedRoot=await fs.realpath(path.dirname(manifestFile));
  const expectedPath=await fs.realpath(path.join(expectedRoot,manifest.expectedFile));
  if(!expectedPath.startsWith(expectedRoot+path.sep))throw new Error('预期文件越过 manifest 目录');
  const expectedBytes=await fs.readFile(expectedPath);if(hash(expectedBytes)!==manifest.expectedSha256)throw new Error('人工预期哈希不匹配');
  const expected=JSON.parse(expectedBytes),seen=new Set(),inputs=[];let total=0;
  if(expected.schemaVersion!==1||!Array.isArray(expected.calls)||!expected.calls.length||typeof expected.expectedComplete!=='boolean')throw new Error('人工预期必须包含 calls 和 expectedComplete');
  for(const file of manifest.files){
    if(!relativeFile(file.path)||! /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(file.path)||seen.has(file.path)||! /^[a-f0-9]{64}$/.test(file.sha256))throw new Error('外部切片路径、重复文件或哈希无效');seen.add(file.path);
    const full=await fs.realpath(path.join(root,file.path));if(!full.startsWith(root+path.sep))throw new Error('切片源文件越过 source-root');
    const size=(await fs.stat(full)).size;total+=size;if(size>4*1024*1024||total>16*1024*1024)throw new Error('外部切片超过字节预算');
    const bytes=await fs.readFile(full);if(hash(bytes)!==file.sha256)throw new Error('切片文件哈希不匹配: '+file.path);inputs.push({file,bytes});
  }
  if(expected.calls.some(call=>!seen.has(call.file)))throw new Error('预期位置不在冻结文件集合中');
  const isolated=await fs.mkdtemp(path.join(os.tmpdir(),'api-external-baseline-'));
  try {
    // Only frozen files enter the analysis. Extra checkout files/config cannot change scope.
    for(const {file,bytes} of inputs){const target=path.join(isolated,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
    const config=validateConfig(isolated,{...manifest.config,include:manifest.files.map(f=>f.path),includeUnlinked:false,modelRequestHooks:false});
    const report=await analyze(isolated,config);
    const rows=requestRows(report,{repository,commit:manifest.commit,mode:'source-static'});
    const usages=[...report.endpoints,...report.assetCandidates].flatMap(e=>e.usages);
    const validation=checkExternalExpectations(rows,expected,report.stats,usages);
    const engineVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
    return {schemaVersion:1,engineVersion,kind:manifest.kind,name:manifest.name,repository,commit:manifest.commit,validationPassed:validation.passed,extractionComplete:report.stats.complete,validation,assets:manifest.files,config,stats:report.stats,diagnostics:report.diagnostics,manualFindings:expected.manualFindings??[],rows,report};
  } finally {await fs.rm(isolated,{recursive:true,force:true});}
}
