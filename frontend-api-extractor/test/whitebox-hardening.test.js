import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';

test('跨文件字符串表、join/concat 可恢复分段 Host 与 URL', async t=>{
  const root=await fixture(t,{'config.js':`export const host=['https:', '', 'api.example.test:8443'].join('/');`, 'page.js':`import {host} from './config'; const route=['v1','users'].join('/'); fetch(host.concat('/',route));`});
  const r=await analyze(root,{entries:['page.js']});
  assert.equal(r.endpoints[0].url,'https://api.example.test:8443/v1/users');
  assert.equal(r.endpoints[0].address.host,'api.example.test:8443');
  assert.equal(r.endpoints[0].address.path,'/v1/users');
});
test('相对路径 Host 未知，不能从 JS 所在路径猜域名',async t=>{
  const root=await fixture(t,{'page.js':`fetch('/users')`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.address.host,null);
  assert.equal(e.address.hostState,'unknown');
  assert.equal(e.address.path,'/users');
});
test('动态 baseURL 不妨碍保留相对地址和已知参数字段',async t=>{
  const root=await fixture(t,{'page.js':`import axios from 'axios';const api=axios.create({baseURL:runtime.host});api.post('/users',{...extra,profile:{id:uid}})`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.address.hostState,'unknown');
  assert.equal(e.address.requestUrl,'/users');
  assert.ok(e.parameterFields.some(f=>f.carrier==='body' && f.path.join('.')==='profile.id'));
  assert.ok(e.parameterFields.some(f=>f.state==='unknown-spread'));
});
test('静态字面量编码可还原，本地同名解码器不能冒充标准函数',async t=>{
  const root=await fixture(t,{'page.js':`fetch(atob('aHR0cHM6Ly9hcGkuZXhhbXBsZS50ZXN0')+decodeURIComponent('%2Fusers'));`, 'local.js':`export {}; function atob(x){return '/local'} fetch(atob('ignored'));`});
  const r=await analyze(root);
  assert.deepEqual(r.endpoints.map(e=>e.url).sort(),['/local','https://api.example.test/users']);
});
test('Object.assign 分散字段与 JSON 序列化保留构造字段和阶段',async t=>{
  const root=await fixture(t,{'page.js':`const body={};Object.assign(body,{user:{id:uid}});body.trace=trace;fetch('/save',{method:'POST',body:JSON.stringify(body)});`});
  const e=(await analyze(root)).endpoints[0];
  assert.ok(e.parameterFields.some(f=>f.path.join('.')==='user.id'));
  assert.ok(e.parameterFields.some(f=>f.path.join('.')==='trace'));
  assert.ok(e.parameterFields.every(f=>f.stage==='constructed'));
  assert.equal(e.parameterStage,'call-site');
});
test('跨文件注册请求 hook 必须告知载荷和地址可能继续变化',async t=>{
  const root=await fixture(t,{'client.js':`import axios from 'axios';const client=axios.create({baseURL:'https://api.example.test'});client.interceptors.request.use(c=>{c.headers.secret=token;c.url='/rewritten';return c});export default client;`, 'page.js':`import api from './client';api.post('/original',{id:uid});`});
  const e=(await analyze(root,{entries:['page.js']})).endpoints[0];
  assert.equal(e.postHookState,'unknown');
  assert.equal(e.resolution,'partial');
  assert.equal(e.hooks[0].file,'client.js');
  assert.equal(e.address.hostState,'partial');
  assert.ok(e.usages[0].unresolved.some(s=>s.includes('hook')));
});
test('请求 hook 不污染另一客户端，response hook 不当作请求改写',async t=>{
  const root=await fixture(t,{'page.js':`import axios from 'axios';const a=axios.create({});const b=axios.create({});a.interceptors.request.use(c=>c);b.interceptors.response.use(r=>r);b.get('https://example.test/b')`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.hooks.length,0);
  assert.equal(e.resolution,'resolved');
});
test('未知加密不执行，不把明文构造字段当作最终载荷',async t=>{
  const root=await fixture(t,{'page.js':`const data=encrypt({userId:uid});fetch('/encrypted',{method:'POST',body:data});`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.resolution,'partial');
  assert.ok(e.parameterFields.some(f=>f.carrier==='body' && f.state==='unknown-value'));
  assert.ok(!e.parameterFields.some(f=>f.path.includes('userId')));
});
test('未知展开覆盖之前的嵌套对象时不伪造嵌套字段完整性',async t=>{
  const root=await fixture(t,{'page.js':`fetch('/save',{method:'POST',body:{profile:{id:uid},...extra}})`});
  const e=(await analyze(root)).endpoints[0];
  assert.ok(e.parameterFields.some(f=>f.path.join('.')==='profile' && f.state==='unknown-value'));
  assert.ok(!e.parameterFields.some(f=>f.path.join('.')==='profile.id'));
});
test('动态客户端默认值的候选仍保留 hook 关联',async t=>{
  const root=await fixture(t,{'page.js':`import axios from 'axios';const client=axios.create({baseURL:flag?'https://a.test':'https://b.test'});client.interceptors.request.use(c=>c);client.get('/users')`});
  const r=await analyze(root);
  assert.equal(r.endpoints.length,2);
  assert.ok(r.endpoints.every(e=>e.postHookState==='unknown'));
});
test('字面量 JSON 序列化可确定，但字段仍标明构造阶段',async t=>{
  const root=await fixture(t,{'page.js':`fetch('https://example.test/save',{method:'POST',body:JSON.stringify({id:7})})`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.body,'{"id":7}');
  assert.ok(e.parameterFields.some(f=>f.path.join('.')==='id' && f.stage==='constructed'));
});
test('输出实际识别的 JS、哈希、引用位置和未取得引用',async t=>{
  const root=await fixture(t,{'page.js':`import {host} from './cfg'; import(remoteName); import('https://example.test/sdk.js'); fetch(host+'/a');`, 'cfg.js':`export const host='https://example.test'`});
  const r=await analyze(root,{entries:['page.js']});
  const asset=r.assets.find(a=>a.file==='page.js');
  assert.match(asset.sha256,/^[a-f0-9]{64}$/);
  assert.equal(asset.parseStatus,'parsed');
  assert.ok(asset.imports.some(i=>i.resolvedFile==='cfg.js' && i.state==='internal'));
  assert.ok(asset.imports.some(i=>i.state==='dynamic'));
  assert.ok(asset.imports.some(i=>i.state==='external-not-fetched'));
});
test('破损 JS 留在资产清单中，不因没有接口而被漏记',async t=>{
  const root=await fixture(t,{'bad.js':'const = ;','bad.vue':'<script src="./unknown.js"></script>'});
  const r=await analyze(root);
  assert.ok(r.assets.some(a=>a.file==='bad.js' && a.parseStatus==='error'));
  assert.ok(r.assets.some(a=>a.file==='bad.vue' && a.parseStatus==='failed'));
});
test('协议相对 URL 可知 Host，但不猜页面协议',async t=>{
  const root=await fixture(t,{'page.js':`fetch('//api.example.test/users')`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.address.host,'api.example.test');
  assert.equal(e.address.origin,null);
});
test('URL 内的 Query 字段名不因配置对象缺失而丢失',async t=>{
  const root=await fixture(t,{'page.js':"fetch(`/users?userId=${uid}&page=1`)"});
  const e=(await analyze(root)).endpoints[0];
  assert.ok(e.parameterFields.some(f=>f.carrier==='query' && f.path[0]==='userId' && f.source==='url'));
});
test('JSON replacer/reviver 未建模时不能输出确定结果',async t=>{
  const root=await fixture(t,{'page.js':`fetch('https://example.test/a',{method:'POST',body:JSON.stringify({id:1},(k,v)=>undefined)});fetch(JSON.parse('"https://fake.test"',(k,v)=>'/changed'))`});
  const r=await analyze(root);
  assert.equal(r.endpoints.find(e=>e.url==='https://example.test/a').resolution,'partial');
  assert.ok(!r.endpoints.some(e=>e.url==='https://fake.test'));
});
test('本地同名 require 不冒充模块引用',async t=>{
  const root=await fixture(t,{'page.js':`export {};function require(x){return x};require('./not-a-module')`});
  assert.equal((await analyze(root)).assets[0].imports.length,0);
});
test('相同 URL 的多个客户端归并后仍保留最差 hook 状态',async t=>{
  const root=await fixture(t,{'page.js':`import axios from 'axios';const a=axios.create({}),b=axios.create({});b.interceptors.request.use(c=>c);a.get('https://example.test/a');b.get('https://example.test/a')`});
  const e=(await analyze(root)).endpoints[0];
  assert.equal(e.postHookState,'unknown');
  assert.equal(e.hooks.length,1);
  assert.equal(e.usages[0].postHookState,'not-observed');
  assert.equal(e.usages[0].address.hostState,'resolved');
});
