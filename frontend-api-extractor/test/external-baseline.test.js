import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {analyze} from '../src/analyzer.js';
import {requestRows} from '../src/request-table.js';
import {checkExternalExpectations,verifyExternalBaseline,matchesExpectation} from '../src/external-baseline.js';
import {runLogged} from '../src/repository-task.js';
import {fixture} from './helpers.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const unknown={$unknown:true};
const row={sourceFile:'api.js',sourceLine:1,sourceColumn:1,stage:'call-site',method:'POST',host:'api.example.test',url:'https://api.example.test/items',query:null,body:{id:7},headers:null,resolution:'resolved',conditions:[],parameterFields:[{carrier:'body',path:['id'],state:'known-field'}],gaps:[]};
const expected=()=>({schemaVersion:1,expectedComplete:true,calls:[{id:'send',file:'api.js',line:1,column:1,evidence:'手工：第一行直接fetch，body.id=7，无Query/Header',pattern:{method:'POST',host:'api.example.test',url:'https://api.example.test/items',query:null,body:{id:7},headers:null,resolution:'resolved'},conditions:[],knownFields:[{carrier:'body',path:['id']}]}]});
const stats={complete:true};
async function sample(t){
  const source=await fixture(t,{'api.js':`fetch('https://api.example.test/items',{method:'POST',body:{id:7}});`});
  const directory=await fixture(t,{'expected.json':JSON.stringify(expected())});
  const manifest={schemaVersion:1,kind:'external-source-slice',name:'self-authored-offline-fixture',repository:'https://github.com/example/fixture',commit:'a'.repeat(40),expectedFile:'expected.json',expectedSha256:hash(await fs.readFile(path.join(directory,'expected.json'))),config:{entries:['api.js']},files:[{path:'api.js',sha256:hash(await fs.readFile(path.join(source,'api.js')))}]};
  const file=path.join(directory,'fixture.json');await fs.writeFile(file,JSON.stringify(manifest));return {source,directory,manifest,file};
}

test('人工预期比较已知结构与明确未知，不把任意值接受为unknown',()=>{
  assert.equal(matchesExpectation({id:7},{id:7}),true);assert.equal(matchesExpectation({id:7,extra:8},{id:7}),false);
  assert.equal(matchesExpectation({__unknown:'x'},unknown),true);assert.equal(matchesExpectation('{x}',unknown),true);assert.equal(matchesExpectation(null,unknown),false);assert.equal(matchesExpectation('POST',unknown),false);
});

test('逐调用人工字段验证：已知字段精确匹配，缺失/多出字段不得通过',()=>{
  assert.equal(checkExternalExpectations([row],expected(),stats).passed,true);
  for(const value of [{...row,body:{id:8}},{...row,body:{id:7,password:'extra'}},{...row,parameterFields:[]}])assert.equal(checkExternalExpectations([value],expected(),stats).passed,false);
});

test('不能漏掉额外发送点，也不能重复认领或任意匹配多个候选',()=>{
  const extra={...row,sourceLine:2};assert.equal(checkExternalExpectations([row,extra],expected(),stats).unexpectedRows.length,1);
  const duplicate=expected();duplicate.calls.push({...duplicate.calls[0],id:'again'});assert.equal(checkExternalExpectations([row],duplicate,stats).passed,false);
  assert.equal(checkExternalExpectations([row,row],expected(),stats).passed,false);
});

test('四个独立条件组合逐项验证，不能混并为一个发送候选',()=>{
  const e=expected();e.calls=[];const rows=[];
  for(const a of [true,false])for(const b of [true,false]){
    const conditions=[{file:'api.js',line:2,column:1,expression:'a',outcome:a},{file:'api.js',line:3,column:1,expression:'b',outcome:b}];
    rows.push({...row,conditions});e.calls.push({...expected().calls[0],id:`${a}-${b}`,conditions});
  }
  assert.equal(checkExternalExpectations(rows,e,stats).summary.matched,4);assert.equal(checkExternalExpectations(rows.slice(1),e,stats).passed,false);
});

test('已知不完整仍可通过限定预期，但错误complete和hook状态必须失败',()=>{
  const e=expected();e.expectedComplete=false;e.calls[0].postHookState='unknown';e.calls[0].requiredGaps=['hook'];
  const usage={callChain:[{file:'api.js',line:1,column:1}],postHookState:'unknown'};
  const r={...row,gaps:['request hook 未建模']};
  const result=checkExternalExpectations([r],e,{complete:false},[usage]);assert.equal(result.passed,true);assert.equal(result.completeness.actual,false);
  assert.equal(checkExternalExpectations([r],e,stats,[usage]).passed,false);assert.equal(checkExternalExpectations([r],e,{complete:false},[{...usage,postHookState:'modeled'}]).passed,false);
});

test('离线自写外部格式样例：核对哈希，只分析冻结文件，不读取额外源码/配置',async t=>{
  const s=await sample(t);await fs.writeFile(path.join(s.source,'other.js'),`fetch('https://extra.example.test/')`);await fs.writeFile(path.join(s.source,'api-extractor.config.json'),'{bad config');
  const result=await verifyExternalBaseline(s.file,s.source);assert.equal(result.validationPassed,true);assert.equal(result.extractionComplete,true);assert.equal(result.rows.length,1);assert.equal(result.config.include.length,1);assert.equal(result.rows[0].commit,s.manifest.commit);
});

test('篡改源码或人工预期哈希会在分析前失败',async t=>{
  const s=await sample(t);await fs.appendFile(path.join(s.source,'api.js'),'\nfetch("/extra")');await assert.rejects(verifyExternalBaseline(s.file,s.source),/切片文件哈希/);
  const other=await sample(t);await fs.appendFile(path.join(other.directory,'expected.json'),' ');await assert.rejects(verifyExternalBaseline(other.file,other.source),/人工预期哈希/);
});

test('拒绝目录穿越、重复文件、软链接越界与非固定Commit',async t=>{
  const s=await sample(t),save=async manifest=>{await fs.writeFile(s.file,JSON.stringify(manifest));};
  await save({...s.manifest,commit:'main'});await assert.rejects(verifyExternalBaseline(s.file,s.source),/manifest/);
  await save({...s.manifest,files:[{path:'../outside.js',sha256:'a'.repeat(64)}]});await assert.rejects(verifyExternalBaseline(s.file,s.source),/路径/);
  await save({...s.manifest,files:[s.manifest.files[0],s.manifest.files[0]]});await assert.rejects(verifyExternalBaseline(s.file,s.source),/重复/);
  await save(s.manifest);await fs.rm(path.join(s.source,'api.js'));const outside=await fixture(t,{'outside.js':'fetch("/bad")'});await fs.symlink(path.join(outside,'outside.js'),path.join(s.source,'api.js'));await assert.rejects(verifyExternalBaseline(s.file,s.source),/越过/);
});

test('外部CLI导出表格并区分预期失败与输入失败，帮助不需要源码',async t=>{
  const s=await sample(t),cli=fileURLToPath(new URL('../src/external-baseline-cli.js',import.meta.url)),out=path.join(s.directory,'out/result.json');
  const args=['--manifest',s.file,'--source-root',s.source,'--out',out];
  const pass=await runLogged(process.execPath,[cli,...args]);assert.equal(pass.code,0);assert.equal(JSON.parse(pass.output).validationPassed,true);assert.match(await fs.readFile(out+'.csv','utf8'),/api\.example\.test/);assert.match(await fs.readFile(out+'.md','utf8'),/^# 源码请求候选表/);
  const e=expected();e.calls[0].pattern.body.id=9;await fs.writeFile(path.join(s.directory,'expected.json'),JSON.stringify(e));s.manifest.expectedSha256=hash(await fs.readFile(path.join(s.directory,'expected.json')));await fs.writeFile(s.file,JSON.stringify(s.manifest));
  assert.equal((await runLogged(process.execPath,[cli,...args])).code,1);assert.equal((await runLogged(process.execPath,[cli])).code,2);assert.equal((await runLogged(process.execPath,[cli,'--help'])).code,0);
});

test('未知配置不能把Query/Body/Header误报成无字段，表格保留载体未知',async t=>{
  const root=await fixture(t,{'api.js':`import axios from 'axios';axios(runtimeConfig);fetch('/items',runtimeConfig);`});
  const report=await analyze(root),rows=requestRows(report);assert.equal(rows.length,2);
  for(const r of rows)for(const carrier of ['query','body','headers']){assert.ok(r[carrier].__unknown);assert.ok(r.parameterFields.some(f=>f.carrier===carrier&&f.state==='unknown-value'&&!f.path.length));}
});

test('未知展开后的显式载体覆盖仍可信，未知展开不清除缺口',async t=>{
  const root=await fixture(t,{'api.js':`fetch('/items',{...runtimeConfig,method:'POST',body:{id:7},headers:null});`});
  const r=requestRows(await analyze(root))[0];assert.equal(r.method,'POST');assert.deepEqual(r.body,{id:7});assert.equal(r.headers,null);assert.ok(r.query.__unknown);assert.equal(r.resolution,'partial');
});

test('已知请求缺省载体仍为无显式字段，不一律降成未知',async t=>{
  const root=await fixture(t,{'api.js':`fetch('/items')`});const r=requestRows(await analyze(root))[0];
  assert.equal(r.query,null);assert.equal(r.body,null);assert.equal(r.headers,null);
});


test('已提交外部标注的预期哈希、限定位置、条件和人工依据完整',async()=>{
  const directory=fileURLToPath(new URL('../baselines/external/',import.meta.url));
  for(const name of ['gdb','nacos','oss']){
    const manifest=JSON.parse(await fs.readFile(path.join(directory,name+'.json'),'utf8'));
    const bytes=await fs.readFile(path.join(directory,manifest.expectedFile));assert.equal(hash(bytes),manifest.expectedSha256);
    const e=JSON.parse(bytes);assert.equal(e.expectedComplete,false);
    for(const call of e.calls)assert.ok(manifest.files.some(f=>f.path===call.file));
    assert.doesNotThrow(()=>checkExternalExpectations([],e,{complete:false}));
    assert.equal(new Set(e.calls.map(c=>c.id)).size,e.calls.length);
  }
});
