// Diagnostic probes, not a claim that extraction quality passes. Never runs target JS.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {analyze} from '../src/analyzer.js';
import {analyzeHybrid,analyzeJshound} from '../src/jshound.js';
import {analyzeBuild} from '../src/build-assets.js';
import {requestRows} from '../src/request-table.js';
import {toDelivery} from '../src/delivery.js';

const {values}=parseArgs({options:{out:{type:'string'}}});
const workspace=fileURLToPath(new URL('../../',import.meta.url));
const output=path.resolve(values.out??path.join(workspace,'work/design-audit'));
await fs.mkdir(output,{recursive:true});
// Unique run directories prevent old virtual sources from contaminating this audit.
const run=await fs.mkdtemp(path.join(output,'run-'));
const results=[];
async function fixture(name,files){
  const root=path.join(run,name);
  await fs.mkdir(root,{recursive:true});
  for(const [file,content] of Object.entries(files)){
    const target=path.join(root,file);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,content);
  }
  return root;
}
async function probe(id,description,check){
  try{
    const {violated,...details}=await check();
    results.push({id,description,status:violated?'defect-reproduced':'not-reproduced',...details});
  }catch(error){results.push({id,description,status:'probe-error',error:error.message});}
}
const urls=report=>(report.rows??requestRows(report)).map(row=>row.url);
const engines={workDir:path.join(run,'engines')};

await probe('A01','hybrid must honor configured clients and explicit entries',async()=>{
  const cases=[];
  for(const scenario of ['inventory','explicit-entry','other-candidate']){
    const root=await fixture('configured-client-'+scenario,{'api.js':"transport('/hidden')",...(scenario==='other-candidate'?{'other.js':"fetch('/visible')"}:{})});
    const config={clients:[{name:'transport',kind:'fetch'}],...(scenario==='explicit-entry'?{entries:['api.js']}:{})};
    const semantic=await analyze(root,config),hybrid=await analyzeHybrid(root,config,engines);
    cases.push({scenario,semanticUrls:urls(semantic),hybridUrls:urls(hybrid),semanticAnalysis:hybrid.semanticAnalysis?.state,coverage:hybrid.stats.coverage});
  }
  return {violated:cases.some(result=>result.semanticUrls.includes('/hidden')&&!result.hybridUrls.includes('/hidden')),
    expected:'explicit entry reaches semantic analysis and preserves /hidden',
    actual:{cases}};
});
await probe('A02','normalized Vue input must not overwrite a different JS asset',async()=>{
  const root=await fixture('input-collision',{'Page.vue':"<script setup>fetch('/vue')</script>",'Page.vue.js':"fetch('/plain-js')"});
  const report=await analyzeJshound(root,{},engines);
  return {violated:!urls(report).includes('/vue')||report.rows.some(row=>row.sourceFile==='Page.vue'&&row.url==='/plain-js'),
    expected:'Page.vue -> /vue; Page.vue.js -> /plain-js',
    actual:{rows:report.rows.map(row=>({file:row.sourceFile,url:row.url})),coverage:report.stats.coverage}};
});
await probe('A03','SDK extraction must honor the selected scan roots',async()=>{
  const root=await fixture('sdk-scope',{
    'other.js':'const value=1;',
    'api.js':"const ALY=require('aliyun-sdk');const sts=new ALY.STS({endpoint:'https://sts.aliyuncs.com'});sts.assumeRole({RoleArn:arn,RoleSessionName:'demo'});",
    'package.json':'{"dependencies":{"aliyun-sdk":"1.12.3"}}',
  });
  const report=await analyze(root,{scanFiles:['other.js']});
  const rows=requestRows(report);
  return {violated:rows.some(row=>row.sourceFile==='api.js'),expected:'no requests from unselected, unreferenced api.js',
    actual:{rows:rows.map(row=>({file:row.sourceFile,url:row.url,stage:row.stage})),coverage:report.stats.coverage}};
});
await probe('A04','legal business field names must not collide with abstract metadata',async()=>{
  const root=await fixture('business-key',{'api.js':"fetch('/payload',{method:'POST',body:JSON.stringify({__unknown:'business-value',id:7})})"});
  const rows=requestRows(await analyze(root)),fields=rows.flatMap(row=>row.parameterFields);
  return {violated:!fields.some(field=>field.carrier==='body'&&field.state==='known-field'&&field.path[0]==='__unknown'),
    expected:'both __unknown and id are known body fields',actual:{fields}};
});
await probe('A05','partially mapped builds must still analyze unmapped JS assets',async()=>{
  const code="fetch('/mapped')";
  const root=await fixture('mixed-build',{
    'src/mapped.js':code,
    'dist/mapped.js':code+'\n//# sourceMappingURL=mapped.js.map',
    'dist/mapped.js.map':JSON.stringify({version:3,file:'mapped.js',sources:['../src/mapped.js'],sourcesContent:[code],names:[],mappings:'AAAA'}),
    'dist/unmapped.js':"fetch('/unmapped')",
  });
  const built=await analyzeBuild(root,['dist'],path.join(run,'build-analysis'));
  return {violated:!urls(built.report).includes('/unmapped'),expected:'both /mapped and /unmapped with independent asset coverage',
    actual:{mode:built.mode,assets:built.assets.map(asset=>asset.file),urls:urls(built.report),coverage:built.report.stats.coverage,semanticComplete:built.report.stats.complete,gaps:built.gaps}};
});
await probe('A06','different unlocated candidates must not imply one proven call site',async()=>{
  const root=await fixture('unlocated-candidates',{'api.js':"fetch('/one');fetch('/two');"});
  const delivery=toDelivery(await analyzeJshound(root,{},engines));
  const ids=new Set(delivery.records.map(record=>record.callSiteId));
  return {violated:delivery.records.length===2&&ids.size===1,
    expected:'unknown site identity, or distinct candidate-scoped IDs explicitly marked unlocated',
    actual:{rows:delivery.records.map(record=>({url:record.url,callSiteId:record.callSiteId})),uniqueCallSiteIds:ids.size}};
});

const report={schemaVersion:1,auditKind:'design-diagnostic-probes',engineVersion:'0.10.0',
  generatedAt:new Date().toISOString(),runDirectory:run,
  targetCodeExecuted:false,apiRequestsSent:false,
  summary:{probes:results.length,defectsReproduced:results.filter(result=>result.status==='defect-reproduced').length,probeErrors:results.filter(result=>result.status==='probe-error').length},results};
await fs.writeFile(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:path.join(run,'results.json'),...report.summary,statusMeaning:'exit 0 means audit completed, not that defects are fixed'},null,2));
if(report.summary.probeErrors)process.exitCode=1;
