import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import glob from 'fast-glob';
import {validateConfig,defaults} from './config.js';
import {scriptSource} from './adapters.js';
import {parameterFields} from './request-evidence.js';
import {requestRows} from './request-table.js';
import {analyze} from './analyzer.js';
const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pin=JSON.parse(await fs.readFile(new URL('../models/jshound.json',import.meta.url),'utf8'));
const upstream=fileURLToPath(new URL('../../references/repos/jshound/',import.meta.url));
const limits={files:1000,totalBytes:32*1024*1024,fileBytes:8*1024*1024,argvBytes:256*1024,outputBytes:32*1024*1024,timeoutMs:120000};
export async function verifyJshound({engineRoot=upstream}={}){
  for(const f of pin.files){let bytes;try{bytes=await fs.readFile(path.join(engineRoot,f.path));}catch{throw Error('缺少固定jshound引擎；在主仓库执行 git submodule update --init --depth 1 references/repos/jshound');}if(sha(bytes)!==f.sha256)throw Error('jshound文件哈希不匹配，拒绝执行: '+f.path);}
  return {name:'jshound',repository:pin.repository,commit:pin.commit,license:pin.license,files:pin.files,adapterSha256:sha(await fs.readFile(new URL('../tools/jshound-worker.cjs',import.meta.url))),runtime:process.version};
}
const scalarKeys=value=>{
  if(value==null)return null;
  if(Array.isArray(value))return value.map(scalarKeys);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scalarKeys(item)]));
  return {__unknown:'jshound字段候选；运行时值未验证'};
};
const partialShape=value=>{
  const result=scalarKeys(value);
  return result&&typeof result==='object'&&!Array.isArray(result)?{...result,__unknown:'第三方库存字段可能跨调用/分支合并，最终结构未验证'}:{__unknown:'jshound未恢复该载体结构'};
};
// Exported for offline projection tests. A route/string hit is never a sending-site row.
export function jshoundRows(records,files){
  const rows=[];
  for(const [index,r] of records.entries()){
    if((r._kind&&r._kind!=='endpoint')||!['fetch','xhr','axios','beacon'].includes(r.kind)||typeof r.template!=='string')continue;
    const asset=files[r._chunk];if(!asset)throw Error('jshound候选缺少合法文件索引');
    const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(r.method)?r.method:'{jshound.method}';
    let host=null;try{if(/^(?:https?:)?\/\//i.test(r.template)){const parsed=new URL(r.template.startsWith('//')?'https:'+r.template:r.template);if(!/[{}]/.test(parsed.host))host=parsed.host;}}catch{}
    const fields={query:partialShape(r.query_schema),body:partialShape(r.body_shape??r.body_schema??(r.body_keys?Object.fromEntries(r.body_keys.map(k=>[k,'?'])):null)),headers:partialShape(r.req_headers??r.headers)};
    const url=r.template,id=sha(JSON.stringify([asset.file,index,r])).slice(0,20);
    rows.push({id,sourceKind:'repository-static',discoveryBasis:'jshound-indexed',linkState:null,sourceFile:asset.file,sourceLine:null,sourceColumn:null,generatedFile:null,generatedLine:null,generatedColumn:null,method,host,hostState:host?'partial':'unknown',hostBasis:host?'external-engine-candidate':'unknown',url,requestUrl:url,sendMechanism:r.sink??r.kind,stage:'external-inventory',resolution:'partial',...fields,parameterFields:parameterFields(fields,url),conditions:[],callChain:[],gaps:['jshound启发式调用候选，未通过逐调用符号/入口核验','上游记录不含精确行列，未猜测位置','字段可能跨同文件调用合并；未知载体不当作空结构'],externalEvidence:{engine:'jshound',commit:pin.commit,index}});
  }
  return rows;
}
function engineExcludes(root,workDir,exclude){const relative=path.relative(root,path.resolve(workDir));if(!relative)throw Error('引擎workDir不能等于扫描根目录');return [...exclude,'**/*.engines/**',...(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?[glob.escapePath(relative)+'/**']:[])];}
export async function analyzeJshound(root,options={}, {workDir=path.resolve('work/indexed-scans'),respectEntries=true}={}){
  root=await fs.realpath(root);const config=validateConfig(root,options),engine=await verifyJshound(),started=Date.now();
  const taskDir=path.join(path.resolve(workDir),'index-'+randomUUID());await fs.mkdir(path.join(taskDir,'inputs'),{recursive:true});
  const diagnostics=[],assets=[],files=[];let bytes=0,argvBytes=0;
  const names=(await glob(config.include,{cwd:root,ignore:engineExcludes(root,workDir,config.exclude),followSymbolicLinks:false,onlyFiles:true})).sort();
  for(const file of names){
    const relativeOutput=path.relative(root,taskDir);if(relativeOutput&&!relativeOutput.startsWith('..')&&(file===relativeOutput||file.startsWith(relativeOutput+'/')))continue;
    const physical=await fs.realpath(path.join(root,file));if(!physical.startsWith(root+path.sep)){diagnostics.push({code:'INDEX_FILE_ESCAPE',file,message:'索引输入真实路径越界，未读取'});continue;}
    const stat=await fs.stat(physical),target=path.join(taskDir,'inputs',file.replace(/\.(vue|svelte)$/i,'.$1.js'));
    if(files.length>=limits.files||stat.size>limits.fileBytes||bytes+stat.size>limits.totalBytes||argvBytes+Buffer.byteLength(target)+1>limits.argvBytes){diagnostics.push({code:'INDEX_INPUT_LIMIT',file,message:'jshound输入文件数/字节/argv预算不足，该文件未索引'});continue;}
    try{const raw=await fs.readFile(physical);if(raw.length>limits.fileBytes||bytes+raw.length>limits.totalBytes)throw Error('实际读取字节超出预算');const normalized=scriptSource(file,raw.toString('utf8'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,normalized);assets.push({file,sha256:sha(raw),state:'indexed-input'});files.push({file,path:target});bytes+=raw.length;argvBytes+=Buffer.byteLength(target)+1;}catch(error){diagnostics.push({code:'INDEX_INPUT_ERROR',file,message:error.message});}
  }
  await fs.writeFile(path.join(taskDir,'inputs.json'),JSON.stringify({engine,limits,bytes,files:assets},null,2)+'\n');
  if(!files.length)throw Error('没有可用jshound索引输入；详见 '+taskDir);
  let result;try{result=await run(process.execPath,['--max-old-space-size=2048',fileURLToPath(new URL('../tools/jshound-worker.cjs',import.meta.url)),upstream,...files.map(f=>f.path)],{cwd:taskDir,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},timeout:limits.timeoutMs,maxBuffer:limits.outputBytes,killSignal:'SIGKILL'});}catch(error){await fs.writeFile(path.join(taskDir,'worker-error.log'),String(error.stderr??error.message));throw Error('jshound索引失败或超限；详见 '+taskDir+'/worker-error.log');}
  await fs.writeFile(path.join(taskDir,'raw.json'),result.stdout);await fs.writeFile(path.join(taskDir,'worker.log'),result.stderr);
  const configSeedFiles=new Set(),moduleSeedFiles=new Set(),physicalSources=new Map(files.map(f=>[f.path,f]));
  const workerErrors=result.stderr.split(/\r?\n/).filter(line=>{if(line.startsWith('ADAPTER_CONFIG_SEED ')||line.startsWith('ADAPTER_MODULE_SEED ')){try{const physical=JSON.parse(line.slice(20)).file,source=physicalSources.get(physical);if(source){(line.startsWith('ADAPTER_MODULE_SEED ')?moduleSeedFiles:configSeedFiles).add(source.file);return false;}}catch{}}return line.trim()&&!/^\s*\d+ method-less duplicate\(s\) suppressed: a call site already recovered their method$/.test(line);});
  if(workerErrors.length)diagnostics.push({code:'INDEX_WORKER_DIAGNOSTIC',message:'上游输出诊断；覆盖视为未完成，详见 '+taskDir+'/worker.log'});
  const records=JSON.parse(result.stdout);if(!Array.isArray(records))throw Error('jshound输出不是记录数组');
  let rows=jshoundRows(records,files),configurationSeeds=[...configSeedFiles],moduleSeeds=[...moduleSeedFiles];
  // scanFiles/entries constrain emitted inventory, while the shared index still sees dependencies.
  const {default:picomatch}=await import('picomatch');
  for(const patterns of [config.scanFiles,respectEntries?config.entries:[]])if(patterns.length){const match=picomatch(patterns);rows=rows.filter(r=>match(r.sourceFile));configurationSeeds=configurationSeeds.filter(file=>match(file));moduleSeeds=moduleSeeds.filter(file=>match(file));}
  const state=diagnostics.length?'incomplete':'finished';
  return {schemaVersion:1,mode:'source-static-indexed',assets,endpoints:[],assetCandidates:[],rows,diagnostics,externalEngine:{...engine,artifactPins:engine.files,taskDir,configurationSeeds,moduleSeeds,moduleSeedBasis:'existing aliyun-sdk protocol model import/require; selection hints only',configurationSeedBasis:'explicit URL+method/type config shapes; selection hints only, not request findings',rawSha256:sha(result.stdout),rawRecords:records.length,files:assets.length,bytes,limits,elapsedMs:Date.now()-started},stats:{stepUnit:'not-applicable-indexed-engine',files:assets.length,entries:assets.length,steps:null,complete:false,partitions:[],coverage:{state,total:names.length,finished:assets.length},outcome:rows.length?'requests-found':state==='finished'?'no-requests-found':'inconclusive'}};
}
const normalizeUrl=value=>typeof value==='string'?value.replace(/\{param:([^}]+)\}/g,'{$1}'):value;
export async function analyzeHybrid(root,config={},options={}){
  const indexed=await analyzeJshound(root,config,{...options,respectEntries:false}),candidates=[...new Set([...indexed.rows.map(r=>r.sourceFile),...indexed.externalEngine.configurationSeeds,...indexed.externalEngine.moduleSeeds])];
  if(!candidates.length)return {...indexed,mode:'source-static-hybrid',semanticAnalysis:{state:'not-started',reason:'no-indexed-sending-candidates'}};
  const semantic=await analyze(root,{...config,exclude:engineExcludes(path.resolve(root),options.workDir??path.resolve('work/indexed-scans'),config.exclude??defaults.exclude),...(!(config.entries?.length)?{scanFiles:candidates.map(file=>glob.escapePath(file))}:{})});
  const semanticRows=requestRows(semantic,{mode:'source-static'}),reconciliations=[],unverified=[],byIdentity=new Map();
  const fieldKey=f=>f.carrier+':'+(f.carrier==='headers'?f.path.join('.').toLowerCase():f.path.join('.'));
  const identity=(file,method,url)=>JSON.stringify([file,method,normalizeUrl(url)]);
  for(const row of semanticRows){
    const business=row.callChain?.slice(0,-1).findLast(p=>p.file!==row.sourceFile),site=JSON.stringify([row.sourceFile,row.sourceLine,row.sourceColumn,business?.file,business?.line,business?.column]);
    const keys=new Set([row.sourceFile,business?.file].filter(Boolean).flatMap(file=>[row.requestUrl,row.url].filter(Boolean).map(url=>identity(file,row.method,url))));
    const fields=new Set(row.parameterFields.filter(f=>f.state==='known-field').map(fieldKey));
    for(const key of keys){let bucket=byIdentity.get(key);if(!bucket){bucket={ids:[],sites:new Set(),commonFields:new Set(fields)};byIdentity.set(key,bucket);}bucket.ids.push(row.id);bucket.sites.add(site);for(const field of bucket.commonFields)if(!fields.has(field))bucket.commonFields.delete(field);}
  }
  for(const row of indexed.rows){
    const bucket=byIdentity.get(identity(row.sourceFile,row.method,row.url)),names=row.parameterFields.filter(f=>f.state==='known-field');
    const covered=bucket?.sites.size===1&&names.every(f=>bucket.commonFields.has(fieldKey(f)));
    reconciliations.push({candidateId:row.id,state:covered?'matched-one-static-site':'unverified-or-additional-fields',semanticRowIds:bucket?.ids??[],externalEvidence:row.externalEvidence});
    if(!covered)unverified.push(row);
  }
  const incomplete=indexed.stats.coverage.state!=='finished'||semantic.stats.coverage.state!=='finished';
  return {...semantic,mode:'source-static-hybrid',rows:[...semanticRows,...unverified],diagnostics:[...indexed.diagnostics,...semantic.diagnostics],externalEngine:{...indexed.externalEngine,indexedCoverage:indexed.stats.coverage,indexedCandidates:indexed.rows.length,unverifiedCandidates:unverified.length,reconciliations},semanticAnalysis:{state:semantic.stats.coverage.state,selectedFiles:candidates,stats:semantic.stats},stats:{...semantic.stats,stepUnit:'semantic-evaluator-only; external index cost reported separately',complete:false,coverage:{state:incomplete?'incomplete':'finished',total:semantic.stats.partitions.length,finished:semantic.stats.partitions.filter(p=>p.state==='finished').length},outcome:semanticRows.length||unverified.length?'requests-found':incomplete?'inconclusive':'no-requests-found'}};
}
