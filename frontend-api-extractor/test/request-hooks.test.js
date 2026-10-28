import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';
import {markdown} from '../src/analyzer.js';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const pre=`import axios from 'axios';const api=axios.create({baseURL:'https://before.test'});`;
const options={modelRequestHooks:true};
const after=e=>e.usages[0].afterRequestHooks;

test('显式同步 hook 改写独立阶段的 Host、URL 和 Header',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{c.baseURL='https://after.test';c.url='/changed';c.headers.trace='yes';return c},null,{synchronous:true});api.post('/original',{id:7})`});
  const e=(await analyze(root,options)).endpoints[0],h=after(e);
  assert.equal(e.url,'https://before.test/original');assert.equal(e.body.id,7);
  assert.equal(e.postHookState,'modeled');assert.equal(h.state,'modeled');
  assert.equal(h.variants[0].url,'https://after.test/changed');
  assert.equal(h.variants[0].address.host,'after.test');assert.equal(h.variants[0].headers.trace,'yes');
  assert.ok(h.variants[0].objectChanges.some(c=>c.path[0]==='trace'&&c.stage==='after-request-hooks'));
});

test('两个 request hook 按后注册先执行，不按注册顺序覆盖',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{c.headers.order='first';return c},null,{synchronous:true});api.interceptors.request.use(c=>{c.headers.order='second';return c},null,{synchronous:true});api.get('/order')`});
  const h=after((await analyze(root,options)).endpoints[0]);
  assert.equal(h.state,'modeled');assert.equal(h.variants[0].headers.order,'first');assert.equal(h.executionOrder.length,2);
});

test('同步 hook 删除与 JSON 序列化保留输入字段和调用处快照',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{delete c.data.old;c.data.tag='added';c.data=JSON.stringify(c.data);return c},null,{synchronous:true});api.post('/json',{id:7,old:true})`});
  const e=(await analyze(root,options)).endpoints[0],h=after(e);
  assert.deepEqual(e.body,{id:7,old:true});assert.equal(h.variants[0].body,'{"id":7,"tag":"added"}');
  assert.ok(!h.variants[0].parameterFields.some(f=>f.path[0]==='old'));
});

test('不同实例不共享 hook，别名共享同一实例',async t=>{
  const root=await fixture(t,{'entry.js':pre+`const alias=api;alias.interceptors.request.use(c=>{c.headers.x=1;return c},null,{synchronous:true});const other=axios.create({});api.get('/a');other.get('/b')`});
  const r=await analyze(root,options);assert.equal(after(r.endpoints.find(e=>e.address.path==='/a')).variants[0].headers.x,1);
  assert.equal(r.endpoints.find(e=>e.url==='/b').postHookState,'not-observed');
});

test('确定的 eject ID 移除注册，不保留已删除改写',async t=>{
  const root=await fixture(t,{'entry.js':pre+`const id=api.interceptors.request.use(c=>{c.url='/wrong';return c},null,{synchronous:true});api.interceptors.request.eject(id);api.get('/right')`});
  const h=after((await analyze(root,options)).endpoints[0]);assert.equal(h.state,'modeled');assert.equal(h.executionOrder.length,0);
  assert.equal(h.variants[0].url,'https://before.test/right');
});

test('未知或条件 eject 不产生确定的最终变体',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>c,null,{synchronous:true});if(flag)api.interceptors.request.eject(runtimeId);api.get('/uncertain')`});
  const r=await analyze(root,options);assert.ok(r.endpoints[0].usages.every(u=>u.afterRequestHooks.state==='unknown'));
  assert.ok(r.endpoints[0].usages.every(u=>u.afterRequestHooks.variants.length===0));
});

test('没有 synchronous 声明、async 或 runWhen 都保持未知',async t=>{
  for(const registration of [`c=>c`,`async c=>c,null,{synchronous:true}`,`c=>c,null,{synchronous:true,runWhen:predicate}`]) {
    const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(${registration});api.get('/unsupported')`});
    const h=after((await analyze(root,options)).endpoints[0]);assert.equal(h.state,'unknown');assert.deepEqual(h.variants,[]);
  }
});

test('不支持的条件回调或外部调用不会发布部分前缀为最终结果',async t=>{
  for(const body of [`if(flag)c.url='/x';return c`,`c.url='/prefix';external(c);return c`]) {
    const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{${body}},null,{synchronous:true});api.get('/call-site')`});
    const e=(await analyze(root,options)).endpoints[0];assert.equal(e.address.path,'/call-site');assert.equal(after(e).state,'unknown');assert.deepEqual(after(e).variants,[]);
  }
});

test('请求发出之后才注册的顶层 hook 不反向影响先前请求',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.get('/before');api.interceptors.request.use(c=>{c.url='/changed';return c},null,{synchronous:true});api.get('/after')`});
  const r=await analyze(root,options);assert.equal(r.endpoints.find(e=>e.address.path==='/before').postHookState,'not-observed');
  assert.equal(after(r.endpoints.find(e=>e.address.path==='/after')).variants[0].address.path,'/changed');
});

test('跨文件未连接的模块初始化注册保持未知',async t=>{
  const root=await fixture(t,{'client.js':pre+`api.interceptors.request.use(c=>c,null,{synchronous:true});export default api;`,'entry.js':`import api from './client.js';api.get('/module')`});
  const e=(await analyze(root,{...options,entries:['entry.js']})).endpoints[0];assert.equal(after(e).state,'unknown');assert.ok(after(e).gaps.length);
});

test('默认关闭，兼容旧的 hook 未知状态；配置只接受布尔值',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>c,null,{synchronous:true});api.get('/default')`});
  const e=(await analyze(root)).endpoints[0];assert.equal(e.postHookState,'unknown');assert.equal(e.usages[0].afterRequestHooks,undefined);
  await assert.rejects(analyze(root,{modelRequestHooks:'yes'}),/modelRequestHooks/);
});

test('同一 hook 可 clear，子实例不继承父实例拦截器',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{c.url='/parent';return c},null,{synchronous:true});const child=api.create({});child.get('/child');api.interceptors.request.clear();api.get('/cleared')`});
  const r=await analyze(root,options);assert.equal(r.endpoints.find(e=>e.address.path==='/child').postHookState,'not-observed');
  assert.equal(after(r.endpoints.find(e=>e.address.path==='/cleared')).executionOrder.length,0);
});

test('默认 axios 单例支持模型，response hook 不当作请求 hook',async t=>{
  const root=await fixture(t,{'entry.js':`import axios from 'axios';axios.interceptors.request.use(c=>{c.url='/global';return c},null,{synchronous:true});axios.interceptors.response.use(r=>{axios.get('/response-only');return r});axios.get('/original')`});
  const h=after((await analyze(root,options)).endpoints[0]);assert.equal(h.state,'modeled');assert.equal(h.variants[0].url,'/global');
});

test('方括号访问与 manager 别名保留实例身份，条件注册仍未知',async t=>{
  const root=await fixture(t,{'entry.js':pre+`const manager=api['interceptors']['request'];if(flag)manager['use'](c=>c,null,{synchronous:true});api.get('/alias')`});
  const r=await analyze(root,options);assert.ok(r.endpoints[0].usages.every(u=>u.afterRequestHooks.state==='unknown'));
  const other=await fixture(t,{'entry.js':pre+`const value=api.interceptors.request['state'];fetch('/opaque',{method:'POST',body:value})`});
  assert.ok((await analyze(other,options)).endpoints[0].body.__unknown);
});

test('shadowed JSON/Object 不能冒充受支持的纯内建函数',async t=>{
  const root=await fixture(t,{'entry.js':pre+`const JSON={stringify:x=>x};api.interceptors.request.use(c=>{c.data=JSON.stringify(c.data);return c},null,{synchronous:true});api.post('/shadow',{id:1})`});
  const h=after((await analyze(root,options)).endpoints[0]);assert.equal(h.state,'unknown');assert.ok(h.gaps.some(g=>g.includes('shadowed')));
});

test('动态 method 值不能标为已解析地址变体，非法返回不能当配置',async t=>{
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{c.method=runtimeMethod;return c},null,{synchronous:true});api.get('/method')`});
  const h=after((await analyze(root,options)).endpoints[0]);assert.equal(h.state,'modeled');assert.equal(h.variants[0].resolution,'partial');
  const other=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>c.headers,null,{synchronous:true});api.get('/invalid')`});
  assert.equal(after((await analyze(other,options)).endpoints[0]).state,'unknown');
});

test('预算中断仍保留调用处记录，hook 后快照未知',async t=>{
  const writes=Array.from({length:80},(_,i)=>`c.headers.x=${i};`).join('');
  const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{${writes}return c},null,{synchronous:true});api.get('/budget')`});
  const r=await analyze(root,{...options,maxSteps:80});
  assert.equal(r.endpoints.length,1);assert.equal(after(r.endpoints[0]).state,'unknown');
  assert.equal(r.stats.partitions[0].state,'budget-exceeded');assert.ok(r.stats.steps<=80);
});

test('冻结的多 hook/eject 样例匹配独立预期和输入哈希',async()=>{
  const root=fileURLToPath(new URL('../examples/sync-hooks/',import.meta.url));
  const manifest=JSON.parse(await fs.readFile(root+'manifest.json','utf8'));
  for(const f of manifest.files)assert.equal(createHash('sha256').update(await fs.readFile(root+f.path)).digest('hex'),f.sha256);
  const expected=JSON.parse(await fs.readFile(root+'expected.json','utf8'));
  const r=await analyze(root,manifest.config),e=r.endpoints[0],h=after(e),v=h.variants[0];
  assert.equal(e.url,expected.callSiteUrl);assert.equal(h.state,'modeled');
  assert.equal(v.method,expected.method);assert.equal(v.url,expected.url);assert.equal(v.body,expected.body);
  assert.deepEqual(v.headers,expected.headers);assert.equal(h.executionOrder.length,expected.activeHookCount);
  assert.match(markdown(r),/after\.test/);
});

test('捕获对象与别名重绑定不能被错误建模为纯配置改写',async t=>{
  for(const body of [`c.headers=captured;c.headers.x=1;return c`,`c=captured;return c`]) {
    const root=await fixture(t,{'entry.js':pre+`const captured={url:'/hidden',method:'post',headers:{}};api.interceptors.request.use(c=>{${body}},null,{synchronous:true});api.get('/capture')`});
    assert.equal(after((await analyze(root,options)).endpoints[0]).state,'unknown');
  }
});

test('未知 defaults 写入或客户端 setup 不能保留伪确定 hook 后快照',async t=>{
  for(const setup of [`api.defaults.baseURL='https://changed.test';`,`externalSetup(api);`]) {
    const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>c,null,{synchronous:true});${setup}api.get('/setup')`});
    assert.equal(after((await analyze(root,options)).endpoints[0]).state,'unknown');
  }
});

test('JSON 忽略的字段不进入编码后字段表，未知编码只保留独立输入证据',async t=>{
  for(const [value,known] of [[`{id:7,omitted:undefined}`,true],[`{id:runtimeId}`,false]]) {
    const root=await fixture(t,{'entry.js':pre+`api.interceptors.request.use(c=>{c.data=JSON.stringify(c.data);return c},null,{synchronous:true});api.post('/encoded',${value})`});
    const v=after((await analyze(root,options)).endpoints[0]).variants[0];
    assert.ok(!v.parameterFields.some(f=>f.path[0]==='omitted'));
    if(!known){assert.ok(!v.parameterFields.some(f=>f.path[0]==='id'));assert.ok(v.serializationInputFields.some(f=>f.path[0]==='id'&&f.stage==='serialization-input'));}
  }
});

test('库存模式的独立入口不按文件顺序合并默认 Axios 的 hook 状态',async t=>{
  const root=await fixture(t,{'a.js':`import axios from 'axios';axios.interceptors.request.use(c=>{c.headers.a=1;return c},null,{synchronous:true});axios.get('/a')`,'b.js':`import axios from 'axios';axios.interceptors.request.use(c=>{c.headers.b=2;return c},null,{synchronous:true});axios.get('/b')`});
  const r=await analyze(root,options);
  assert.deepEqual(after(r.endpoints.find(e=>e.url==='/a')).variants[0].headers,{a:1});
  assert.deepEqual(after(r.endpoints.find(e=>e.url==='/b')).variants[0].headers,{b:2});
});
