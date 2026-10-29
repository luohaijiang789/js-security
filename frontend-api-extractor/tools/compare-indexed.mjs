import fs from'node:fs/promises';import path from'node:path';import{parseArgs,promisify}from'node:util';import{execFile}from'node:child_process';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{requestRows}from'../src/request-table.js';
const run=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
try{
 const{values}=parseArgs({options:{'source-root':{type:'string'},config:{type:'string'},manifest:{type:'string'},out:{type:'string'},rounds:{type:'string',default:'1'},help:{type:'boolean'}}});
 if(values.help)console.log('用法: node tools/compare-indexed.mjs --source-root repo --config source-config.json --out workdir [--manifest frozen.json] [--rounds 1|3]');
 else{
  if(!values['source-root']||!values.config||!values.out||!['1','3'].includes(values.rounds))throw Error('需要source-root/config/out，rounds只支持1或3');
  const root=await fs.realpath(values['source-root']),config=path.resolve(values.config),out=path.resolve(values.out),manifest=values.manifest?JSON.parse(await fs.readFile(values.manifest)):null;
  if(manifest){if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!Array.isArray(manifest.expected))throw Error('基准格式无效');for(const f of manifest.files){if(path.isAbsolute(f.path)||f.path.split(/[\\/]/).includes('..'))throw Error('基准路径无效');const file=await fs.realpath(path.join(root,f.path));if(!file.startsWith(root+path.sep)||hash(await fs.readFile(file))!==f.sha256)throw Error('基准文件越界或哈希不匹配');}}
  await fs.mkdir(out,{recursive:true});const results=[];let corpusHash;
  for(let i=0;i<Number(values.rounds);i++)for(const engine of i%2?['hybrid','semantic']:['semantic','hybrid']){
   const reportFile=path.join(out,`${i}-${engine}`,'report.json'),start=Date.now();let stderr,code=0;
   try{({stderr}=await run(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),root,'--engine',engine,'--config',config,'--out',reportFile],{timeout:180000,maxBuffer:2*1024*1024}));}catch(error){if(![2,3].includes(error.code))throw Error(error.stderr??error.message);stderr=error.stderr;code=error.code;}
   const elapsedMs=Date.now()-start,summary=JSON.parse(stderr.trim().split('\n').at(-1)),report=JSON.parse(await fs.readFile(reportFile)),rows=report.rows??requestRows(report),checks=[];
   const currentHash=hash(JSON.stringify(report.assets.map(a=>[a.file,a.sha256]).sort((a,b)=>a[0].localeCompare(b[0]))));corpusHash??=currentHash;if(corpusHash!==currentHash)throw Error('两引擎输入资产集合/字节发生变化');
   for(const e of manifest?.expected??[]){const matching=rows.filter(r=>['sourceFile','sourceLine','sourceColumn','method','requestUrl','url','host'].every(k=>!Object.hasOwn(e,k)||r[k]===e[k]));checks.push({kind:'call',passed:matching.length>0});for(const[carrier,names]of Object.entries(e.fields??{}))for(const name of names)checks.push({kind:'field',passed:matching.some(r=>r.parameterFields.some(f=>f.carrier===carrier&&f.path.join('.')===name&&f.state==='known-field'))});}
   const entry={round:i,engine,elapsedMs,exitCode:code,summary,inputAssetsHash:currentHash,checks,validationPassed:manifest?checks.every(c=>c.passed):null,sourceReportBytes:(await fs.stat(reportFile)).size,deliveryBytes:(await fs.stat(reportFile+'.delivery/analysis.json')).size,xlsxBytes:(await fs.stat(reportFile+'.delivery/api_assets.xlsx')).size,indexed:report.externalEngine?{files:report.externalEngine.files,coverage:report.externalEngine.indexedCoverage,elapsedMs:report.externalEngine.elapsedMs,unverified:report.externalEngine.unverifiedCandidates,commit:report.externalEngine.commit}:null};results.push(entry);console.log(JSON.stringify({round:i,engine,elapsedMs,exitCode:code,validationPassed:entry.validationPassed,steps:summary.steps,rows:summary.rows}));
  }
  const passed=manifest?results.every(r=>r.validationPassed):null;await fs.writeFile(path.join(out,'comparison.json'),JSON.stringify({repository:manifest?.repository??null,commit:manifest?.commit??null,configSha256:hash(await fs.readFile(config)),inputAssetsHash:corpusHash,validationPassed:passed,results},null,2)+'\n');if(passed===false)process.exitCode=1;
 }
}catch(error){console.error('引擎对照失败: '+error.message);process.exitCode=1;}
