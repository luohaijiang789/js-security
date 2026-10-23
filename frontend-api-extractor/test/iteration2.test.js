import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { fixture } from './helpers.js';

const signatures = r => r.endpoints.map(e => `${e.method} ${e.url}`).sort();

test('三元 URL 经模板字符串和跨文件参数传播为有限候选', async t => {
  const root = await fixture(t, {
    'page.ts': `import {load} from './service'; load(isAdmin ? 'admins' : 'users');`,
    'service.ts': 'export function load(resource){fetch(`/api/${resource}/list`)}',
  });
  const r = await analyze(root, {entries:['page.ts']});
  assert.deepEqual(signatures(r), ['GET /api/admins/list','GET /api/users/list']);
  assert.ok(r.endpoints.every(e => e.resolution === 'partial' && e.usages.every(u => u.conditions.length > 0)));
});

test('if 分支保持 method 和 URL 相关性，不生成不可能的组合', async t => {
  const root = await fixture(t, {'page.js':`let url,method; if(flag){url='/read';method='GET'}else{url='/write';method='POST'} fetch(url,{method})`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['GET /read','POST /write']);
});

test('函数动态提前返回和后续 return 均保留候选', async t => {
  const root = await fixture(t, {'page.js':`function url(flag){if(flag)return '/a';return '/b'} fetch(url(flag));`});
  assert.deepEqual(signatures(await analyze(root)), ['GET /a','GET /b']);
});

test('分支里的对象属性赋值互不污染，保留对象别名', async t => {
  const root = await fixture(t, {'page.js':`const cfg={url:'/initial'};const alias=cfg;if(flag){alias.url='/a'}else{cfg.url='/b'} fetch(cfg.url)`});
  assert.deepEqual(signatures(await analyze(root)), ['GET /a','GET /b']);
});

test('候选扩张受 maxCandidates 限制，超限诊断明确', async t => {
  const root = await fixture(t, {'page.js':`fetch((a?'/a':'/b')+(b?'/c':'/d')+(c?'/e':'/f'));`});
  const r = await analyze(root, {maxCandidates:2});
  assert.ok(r.diagnostics.some(d => d.code === 'CANDIDATE_LIMIT'));
  assert.equal(r.stats.complete, false);
  assert.ok(r.endpoints.length <= 2);
});

test('静态展开实参、数组 map 回调和 for-of 可继续分析', async t => {
  const root = await fixture(t, {'page.js':`const args=['/spread',{method:'POST'}]; fetch(...args); ['/one','/two'].map(url=>fetch(url)); for(const url of ['/three','/four']){fetch(url)}`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['GET /four','GET /one','GET /three','GET /two','POST /spread']);
});

test('静态循环 break 和 continue 生效，不泄漏循环后的绑定', async t => {
  const root = await fixture(t, {'page.js':`for(const url of ['/skip','/yes','/stop','/no']){if(url==='/skip')continue;if(url==='/stop')break;fetch(url)}`});
  assert.deepEqual(signatures(await analyze(root)), ['GET /yes']);
});

test('ofetch 命名导入、create、query 和 JSON body 可提取', async t => {
  const root = await fixture(t, {'page.ts':`import {ofetch as request} from 'ofetch';const api=request.create({baseURL:'/api',query:{locale:'zh'}});api('/users',{method:'POST',query:{page:2},body:{name:'test'}});`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['POST /api/users']);
  assert.deepEqual(r.endpoints[0].query, {locale:'zh',page:2});
  assert.deepEqual(r.endpoints[0].body, {name:'test'});
});

test('Nuxt 未绑定的 $fetch 可识别，本地同名函数保持局部语义', async t => {
  const root = await fixture(t, {'global.ts':`$fetch('/nuxt')`, 'local.ts':`export {};function $fetch(url){return url};$fetch('/fake')`});
  assert.deepEqual(signatures(await analyze(root)), ['GET /nuxt']);
});

test('ky prefixUrl、extend、searchParams 和 json 可提取', async t => {
  const root = await fixture(t, {'page.ts':`import ky from 'ky';const api=ky.create({prefixUrl:'/api/',headers:{'X-App':'test'}}).extend({headers:{'X-Trace':'yes'}});api.post('users',{searchParams:{page:2},json:{name:'test'}});`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['POST /api/users']);
  assert.deepEqual(r.endpoints[0].query, {page:2});
  assert.deepEqual(r.endpoints[0].body, {name:'test'});
  assert.deepEqual(r.endpoints[0].headers, {'X-App':'test','X-Trace':'yes'});
});

test('node-fetch/cross-fetch 的导入别名可识别', async t => {
  const root = await fixture(t, {'page.js':`import request from 'node-fetch';import {fetch as other} from 'cross-fetch';request('/node');other('/cross');`});
  assert.deepEqual(signatures(await analyze(root)), ['GET /cross','GET /node']);
});

test('fetch Request、URL、构造配置及调用时覆盖', async t => {
  const root = await fixture(t, {'page.js':`const url=new URL('/users','https://example.test/api/');const req=new Request(url,{method:'POST',headers:{'X-App':'test'},body:'original'});fetch(req);fetch(req,{method:'PUT',body:'updated'});`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['POST https://example.test/users','PUT https://example.test/users']);
  assert.equal(r.endpoints.find(e=>e.method==='PUT').body, 'updated');
});

test('自定义 Request/URL 构造器不会被当作标准对象', async t => {
  const root = await fixture(t, {'page.js':`class URL{};class Request{};fetch(new Request(new URL('/fake','https://example.test')))`});
  const r = await analyze(root);
  assert.ok(r.endpoints.every(e => e.resolution === 'unresolved'));
  assert.ok(!r.endpoints.some(e => e.url === 'https://example.test/fake'));
});

test('未知循环不能无限执行，扫描仍可继续并提供诊断', async t => {
  const root = await fixture(t, {'page.js':`while(runtimeCondition){fetch('/loop')} fetch('/after')`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['GET /after','GET /loop']);
  assert.ok(r.diagnostics.some(d => d.code === 'APPROXIMATE_LOOP'));
});

test('候选布尔值参与短路和三元条件时保留原分支条件', async t => {
  const root = await fixture(t, {'page.js':`const enabled=flag?true:false;enabled && fetch('/enabled');fetch(enabled?'/yes':'/no')`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r), ['GET /enabled','GET /no','GET /yes']);
  assert.ok(r.endpoints.every(e=>e.resolution === 'partial'));
  const enabled = r.endpoints.find(e=>e.url === '/enabled');
  assert.ok(enabled.usages.every(u=>u.conditions.some(c=>c.expression === 'flag' && c.outcome === true)));
});

test('业务数据的 tag 字段不会与内部函数/客户端描述冲突', async t => {
  const root = await fixture(t, {'page.js':`fetch('/tags',{method:'POST',body:{tag:'client',kind:'business'}})`});
  const r = await analyze(root);
  assert.deepEqual(r.endpoints[0].body,{tag:'client',kind:'business'});
  assert.equal(r.endpoints[0].resolution,'resolved');
});

test('循环对象可以被保守序列化，不导致整个扫描崩溃', async t => {
  const root = await fixture(t, {'page.js':`const data={};data.self=data;fetch('/cyclic',{method:'POST',body:data});fetch('/after')`});
  const r = await analyze(root);
  assert.deepEqual(signatures(r),['GET /after','POST /cyclic']);
  assert.equal(r.endpoints.find(e=>e.url === '/cyclic').resolution,'partial');
  assert.doesNotThrow(()=>JSON.stringify(r));
});

test('本地 globalThis 对象不能伪装成标准 URL 构造器', async t => {
  const root = await fixture(t, {'page.js':`const globalThis={};fetch(new globalThis.URL('/fake','https://example.test'))`});
  const r = await analyze(root);
  assert.ok(r.endpoints.every(e=>e.resolution === 'unresolved'));
});

test('库存模式中独立 service 入口仍保留泛化路径', async t => {
  const root = await fixture(t, {'a-page.ts':`import {load} from './service';load(7)`, 'service.ts':'export function load(id){fetch(`/users/${id}`)}'});
  const r = await analyze(root);
  assert.deepEqual(signatures(r),['GET /users/7','GET /users/{id}']);
});
