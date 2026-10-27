import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';
import {fileURLToPath} from 'node:url';

test('await 动态模块后继续追踪参数和深层请求',async t=>{
  const root=await fixture(t,{'entry.js':`async function main(){const m=await import('./lazy.js');return m.load(7)}main()`, 'lazy.js':`import {send} from './client.js';export const load=id=>send(id);`, 'client.js':`export const send=id=>fetch('https://example.test/deep',{method:'POST',body:{account:{id}}})`});
  const r=await analyze(root,{entries:['entry.js']});
  assert.equal(r.endpoints.length,1);
  assert.equal(r.endpoints[0].body.account.id,7);
  assert.deepEqual(r.endpoints[0].usages[0].assetPath.map(e=>e.resolvedFile),['lazy.js','client.js']);
});
test('then 的解构回调收到模块导出而不是未知值',async t=>{
  const root=await fixture(t,{'entry.js':`import('./lazy.js').then(({load:run})=>run(9))`, 'lazy.js':`export function load(id){fetch('/then',{method:'POST',body:{id}})}`});
  const r=await analyze(root,{entries:['entry.js']});
  assert.equal(r.endpoints[0].body.id,9);
});
test('默认导出与转导出的动态模块保持绑定',async t=>{
  const root=await fixture(t,{'entry.js':`import('./barrel.js').then(m=>m.default(3))`, 'barrel.js':`export {default} from './impl.js'`, 'impl.js':`export default id=>fetch('/default/'+id)`});
  assert.equal((await analyze(root,{entries:['entry.js']})).endpoints[0].url,'/default/3');
});
test('静态计算的 import 路径能解析并回填引用证据',async t=>{
  const root=await fixture(t,{'entry.js':`const name='lazy';import('./'+name+'.js').then(m=>m.load())`, 'lazy.js':`export const load=()=>fetch('/computed')`});
  const r=await analyze(root,{entries:['entry.js']});
  assert.equal(r.endpoints[0].url,'/computed');
  assert.ok(r.assets.find(a=>a.file==='entry.js').imports.some(i=>i.resolvedFile==='lazy.js'));
});
test('动态导出断链时按显式配置单独保留资产级候选',async t=>{
  const root=await fixture(t,{'entry.js':`import('./lazy.js').then(m=>m[unknownName](7))`, 'lazy.js':`export const load=id=>fetch('https://example.test/local',{method:'POST',body:{id}})`, 'unused.js':`fetch('/unrelated')`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,0);
  assert.equal(r.assetCandidates.length,1);
  assert.equal(r.stats.unlinkedScan,'completed');
  assert.equal(r.assetCandidates[0].url,'https://example.test/local');
  assert.equal(r.assetCandidates[0].usages[0].linkState,'unlinked');
  assert.ok(r.assetCandidates.every(e=>e.resolution!=='resolved'));
  assert.deepEqual(r.assetCandidates[0].usages[0].referencedBy,['entry.js']);
  assert.ok(r.diagnostics.some(d=>d.code==='DYNAMIC_EXPORT_UNRESOLVED'));
});
test('已通过入口追踪的发送点不重复产生未知实参候选',async t=>{
  const root=await fixture(t,{'entry.js':`import('./lazy.js').then(m=>m.load(4))`, 'lazy.js':`export const load=id=>fetch('/dedup/'+id)`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true});
  assert.deepEqual(r.endpoints.map(e=>e.url),['/dedup/4']);
  assert.deepEqual(r.assetCandidates,[]);
});
test('远程或未知 import 不下载也不伪造模块',async t=>{
  const root=await fixture(t,{'entry.js':`import('https://example.test/remote.js').then(m=>m.load());import(runtimePath)`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,0);
  assert.ok(r.diagnostics.some(d=>d.code==='DYNAMIC_IMPORT_UNRESOLVED'));
});
test('被 exclude 的 JS 不通过 import 越过扫描边界',async t=>{
  const root=await fixture(t,{'entry.js':`import('./excluded.js').then(m=>m.load())`, 'excluded.js':`export const load=()=>fetch('/excluded')`});
  const r=await analyze(root,{entries:['entry.js'],exclude:['excluded.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,0);assert.equal(r.assetCandidates.length,0);
});
test('循环动态模块调用受递归和调用预算限制',async t=>{
  const root=await fixture(t,{'entry.js':`import('./loop.js').then(m=>m.run())`, 'loop.js':`export const run=()=>import('./loop.js').then(m=>m.run())`});
  const r=await analyze(root,{entries:['entry.js'],maxDepth:6});
  assert.ok(r.diagnostics.some(d=>['RECURSION','MAX_DEPTH'].includes(d.code)));
});
test('includeUnlinked 仅接受布尔值',async t=>{
  const root=await fixture(t,{'entry.js':`fetch('/ok')`});
  await assert.rejects(analyze(root,{includeUnlinked:'yes'}),/includeUnlinked/);
});
test('真实 esbuild 压缩分块仍能对齐 await/then 的参数与源文件',async()=>{
  const root=fileURLToPath(new URL('../examples/async-chunks/built/',import.meta.url));
  const r=await analyze(root,{entries:['*-entry.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,1);
  const e=r.endpoints[0];
  assert.equal(e.url,'https://api.example.test/v2/users/lookup');
  assert.equal(e.address.host,'api.example.test');
  assert.deepEqual(e.usages.map(u=>JSON.parse(u.body).account.id).sort(),[7,9]);
  assert.ok(e.usages.every(u=>u.assetPath.length===1 && u.assetPath[0].kind==='dynamic-import'));
  assert.deepEqual(r.assetCandidates,[]);
});
test('缺少的模块导出保留断点，不伪造成功调用',async t=>{
  const root=await fixture(t,{'entry.js':`import('./lazy.js').then(m=>m.notExported())`, 'lazy.js':`export const load=()=>fetch('/asset-only')`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,0);
  assert.equal(r.assetCandidates.length,1);
  assert.ok(r.diagnostics.some(d=>d.code==='MODULE_EXPORT_UNRESOLVED'));
});
test('压缩后的逗号表达式不能吞掉后面的 HTTP 发送点',async t=>{
  const root=await fixture(t,{'entry.js':`function send(){let type='cypher';runtimeCondition&&(type='gremlin'),fetch('/compressed',{method:'POST',body:{type}})}send()`});
  const r=await analyze(root);
  assert.equal(r.endpoints.length,1);
  assert.deepEqual([...new Set(r.endpoints[0].usages.map(u=>u.body.type))].sort(),['cypher','gremlin']);
});
test('独立回调发现不能将已改写的捕获变量初值当成唯一值',async t=>{
  const root=await fixture(t,{'entry.js':`function send(){let type='cypher';if(flag)type='gremlin';new Promise(resolve=>{fetch('/closure',{method:'POST',body:{type}})})}send()`});
  const r=await analyze(root);
  assert.ok(r.endpoints[0].usages.some(u=>u.body.type?.__unknown));
  assert.ok(r.diagnostics.some(d=>d.code==='CAPTURED_STATE_UNRESOLVED'));
});
test('资产级补漏发现新计算引用后继续走到更深的 JS',async t=>{
  const root=await fixture(t,{'entry.js':`import('./a.js').then(m=>m[unknownName]())`, 'a.js':`export function load(){const name='b';import('./'+name+'.js').then(m=>m[unknownName]())}`, 'b.js':`export function send(){fetch('https://example.test/deeper')}`});
  const r=await analyze(root,{entries:['entry.js'],includeUnlinked:true});
  assert.equal(r.endpoints.length,0);
  assert.ok(r.assetCandidates.some(e=>e.url==='https://example.test/deeper'));
  assert.deepEqual(r.assetCandidates[0].usages[0].referencedBy,['entry.js']);
});
test('导出初始化形成循环时不无限递归或猜 Host',async t=>{
  const root=await fixture(t,{'entry.js':`import('./a.js').then(m=>fetch(m.host))`, 'a.js':`export const host=(await import('./b.js')).host`, 'b.js':`export const host=(await import('./a.js')).host`});
  const r=await analyze(root,{entries:['entry.js']});
  assert.ok(r.diagnostics.some(d=>d.code==='MODULE_EXPORT_CYCLE'));
  assert.ok(r.endpoints.every(e=>e.address.host===null));
});
test('动态模块的已改写可变 Host 不使用声明初值',async t=>{
  const root=await fixture(t,{'entry.js':`import('./state.js').then(m=>fetch(m.host))`, 'state.js':`export let host='https://before.test';host=runtimeValue`});
  const r=await analyze(root,{entries:['entry.js']});
  assert.ok(!r.endpoints.some(e=>e.url==='https://before.test'));
  assert.ok(r.diagnostics.some(d=>d.code==='CAPTURED_STATE_UNRESOLVED'));
});
