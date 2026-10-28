import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze,markdown} from '../src/analyzer.js';
import {fixture} from './helpers.js';

const expensive=Array.from({length:250},(_,i)=>`const item${i}=${i};`).join('\n');
const accounted=r=>{
  assert.equal(r.stats.steps,r.stats.partitions.reduce((sum,p)=>sum+p.steps,0));
  assert.ok(r.stats.partitions.every(p=>p.steps<=p.limit));
};

test('复杂文件预算中断后仍保留其他文件的 Host、URL 和参数',async t=>{
  const root=await fixture(t,{'a.js':`${expensive}fetch('/unvisited')`,'z.js':`fetch('https://api.example.test/users',{method:'POST',body:{id:7}})`});
  const r=await analyze(root,{maxSteps:120});
  assert.deepEqual(r.endpoints.map(e=>e.url),['https://api.example.test/users']);
  assert.equal(r.endpoints[0].address.host,'api.example.test');
  assert.equal(r.endpoints[0].body.id,7);
  assert.deepEqual(r.stats.partitions.map(p=>p.state),['budget-exceeded','finished']);
  assert.equal(r.stats.partitions[0].reason,'partition-budget');
  assert.ok(r.diagnostics.some(d=>d.code==='PARTITION_BUDGET_EXCEEDED'));
  assert.ok(!r.diagnostics.some(d=>d.code==='BUDGET_EXCEEDED'));
  assert.equal(r.stats.complete,false);assert.ok(r.stats.steps<=120);accounted(r);
});

test('跨文件调用消耗当前入口配额，不抢占后续入口',async t=>{
  const root=await fixture(t,{'entry-a.js':`import {run} from './lib.js';run()`,'lib.js':`export function run(){${expensive}}`,'entry-z.js':`fetch('/after-deep-call')`});
  const r=await analyze(root,{entries:['entry-*.js'],maxSteps:180});
  assert.deepEqual(r.endpoints.map(e=>e.url),['/after-deep-call']);
  assert.deepEqual(r.stats.partitions.map(p=>p.file),['entry-a.js','entry-z.js']);
  assert.equal(r.stats.partitions[0].steps,90);accounted(r);
});

test('极小全局预算不超额，后续未扫描文件可见',async t=>{
  const root=await fixture(t,{'a.js':`fetch('/a')`,'b.js':`fetch('/b')`,'c.js':`fetch('/c')`});
  const r=await analyze(root,{maxSteps:1});
  assert.equal(r.stats.steps,1);
  assert.deepEqual(r.stats.partitions.map(p=>p.state),['budget-exceeded','skipped','skipped']);
  assert.ok(r.stats.partitions.every(p=>p.reason==='global-budget'));
  assert.equal(r.diagnostics.filter(d=>d.code==='BUDGET_EXCEEDED').length,1);accounted(r);
});

test('入口预算中断后仍为已知可达 JS 预留补漏配额',async t=>{
  const root=await fixture(t,{'entry.js':`import('./lazy.js');${expensive}`,'lazy.js':`export const send=()=>fetch('/asset-survives')`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true,maxSteps:180});
  assert.equal(r.endpoints.length,0);
  assert.deepEqual(r.assetCandidates.map(e=>e.url),['/asset-survives']);
  assert.equal(r.assetCandidates[0].usages[0].linkState,'unlinked');
  assert.equal(r.stats.unlinkedScan,'incomplete');
  assert.deepEqual(r.stats.partitions.map(p=>p.phase),['entry','asset-local']);accounted(r);
});

test('复杂补漏资产不能阻塞后续可达资产',async t=>{
  const root=await fixture(t,{'entry.js':`import './a.js';import './z.js'`,'a.js':expensive,'z.js':`fetch('/later-asset')`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true,maxSteps:180});
  assert.deepEqual(r.assetCandidates.map(e=>e.url),['/later-asset']);
  assert.equal(r.stats.partitions.find(p=>p.file==='a.js').state,'budget-exceeded');
  assert.equal(r.stats.partitions.find(p=>p.file==='z.js').state,'finished');
  assert.equal(r.stats.unlinkedScan,'incomplete');accounted(r);
});

test('显式文件预算是附加上限，不改变全局硬上限',async t=>{
  const root=await fixture(t,{'entry.js':expensive});
  const r=await analyze(root,{maxSteps:500,maxStepsPerFile:10});
  assert.equal(r.stats.steps,10);assert.equal(r.stats.partitions[0].limit,10);
  assert.equal(r.stats.partitions[0].reason,'partition-budget');accounted(r);
});

test('预算足够时仍保留原接口集合，finished 不掩盖模型诊断',async t=>{
  const root=await fixture(t,{'a.js':`fetch('/a')`,'b.js':`fetch('/b');unknownCall()`});
  const r=await analyze(root);
  assert.deepEqual(r.endpoints.map(e=>e.url),['/a','/b']);
  assert.ok(r.stats.partitions.every(p=>p.state==='finished'));
  assert.equal(r.stats.complete,false);accounted(r);
});

test('文件预算只接受 null 或安全正整数',async t=>{
  const root=await fixture(t,{'entry.js':`fetch('/ok')`});
  for(const value of [0,-1,1.5,'10',true,Number.MAX_SAFE_INTEGER+1])await assert.rejects(analyze(root,{maxStepsPerFile:value}),/maxStepsPerFile/);
  assert.equal((await analyze(root,{maxStepsPerFile:null})).endpoints[0].url,'/ok');
});

test('Markdown 明确展示预算中断文件和未扫描文件',async t=>{
  const root=await fixture(t,{'a.js':expensive,'b.js':`fetch('/b')`});
  const r=await analyze(root,{maxSteps:1}),md=markdown(r);
  assert.match(md,/a\.js.*budget-exceeded/);assert.match(md,/b\.js.*skipped/);
  assert.match(md,/不能证明语义或运行时覆盖完整/);
});

test('入口未匹配时不创建虚构预算分区',async t=>{
  const root=await fixture(t,{'a.js':`fetch('/a')`});
  const r=await analyze(root,{entries:['absent.js'],includeUnlinked:true});
  assert.deepEqual(r.stats.partitions,[]);assert.equal(r.stats.steps,0);
  assert.equal(r.stats.unlinkedScan,'no-entries');
});

test('全局预算不足时已知补漏资产也标记未扫描',async t=>{
  const root=await fixture(t,{'entry.js':`import './lazy.js'`,'lazy.js':`fetch('/asset')`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true,maxSteps:1});
  assert.equal(r.stats.partitions.find(p=>p.file==='lazy.js').state,'skipped');
  assert.equal(r.stats.unlinkedScan,'incomplete');accounted(r);
});

test('实参条件组合超限后继续处理后续实参和独立请求，不崩溃或伪造位置',async t=>{const root=await fixture(t,{'api.js':`function send(a,b,c,d){fetch(a,{body:{b,c,d}})}send(a?'/a':'/b',b?1:2,c?3:4,d?5:6);fetch('https://survives.test/api',{method:'POST',body:{id:7}});`});const r=await analyze(root,{maxCandidates:2});assert.ok(r.endpoints.some(e=>e.url==='https://survives.test/api'));assert.ok(r.diagnostics.some(d=>d.code==='CANDIDATE_LIMIT'));assert.equal(r.stats.complete,false);});
