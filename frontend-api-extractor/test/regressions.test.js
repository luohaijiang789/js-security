import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { fixture } from './helpers.js';

test('未知展开后显式指定的 fetch method 不能丢失', async t => {
  const root = await fixture(t, { 'a.js': `export function send(options){fetch('/save', {...options, method:'POST'})}` });
  const r = await analyze(root);
  assert.equal(r.endpoints[0].method, 'POST');
  assert.equal(r.endpoints[0].resolution, 'partial');
});

test('axios.create 的动态 baseURL 不能被丢弃', async t => {
  const root = await fixture(t, { 'a.js': `import axios from 'axios'; const http=axios.create({baseURL:config.baseURL}); http.get('/users')` });
  const r = await analyze(root);
  assert.equal(r.endpoints[0].url, '{config.baseURL}/users');
  assert.equal(r.endpoints[0].resolution, 'partial');
});

test('axios 继承默认 query/headers，并保留每个调用的参数', async t => {
  const root = await fixture(t, { 'a.js': `import axios from 'axios'; const http=axios.create({baseURL:'/api',params:{locale:'zh'},headers:{'X-App':'demo'}}); http.get('/users',{params:{page:1},headers:{'X-Trace':'one'}}); http.get('/users',{params:{page:2}});` });
  const r = await analyze(root);
  assert.equal(r.endpoints.length, 1);
  assert.deepEqual(r.endpoints[0].usages.map(u => u.query), [{locale:'zh', page:1}, {locale:'zh', page:2}]);
  assert.deepEqual(r.endpoints[0].usages[0].headers, {'X-App':'demo', 'X-Trace':'one'});
});

test('局部变量解构、嵌套形参解构、默认值与 null 实参', async t => {
  const root = await fixture(t, { 'a.js': `const {url}={url:'/destructured'}; fetch(url); function load({user:{id=9}}){fetch('/user/'+id)} load({user:{}}); function send(body='fallback'){fetch('/body',{method:'POST',body})} send(null);` });
  const r = await analyze(root);
  assert.ok(r.endpoints.some(e => e.url === '/destructured' && e.resolution === 'resolved'));
  assert.ok(r.endpoints.some(e => e.url === '/user/9'));
  assert.equal(r.endpoints.find(e => e.url === '/body').usages[0].body, null);
});

test('CommonJS require 跨文件对象导出和 axios 解构', async t => {
  const root = await fixture(t, {
    'page.cjs': `const {load} = require('./service.cjs'); load(18);`,
    'service.cjs': "const {get}=require('axios'); module.exports={load(id){return get(`/cjs/${id}`)}};",
  });
  const r = await analyze(root, {entries:['page.cjs']});
  assert.deepEqual(r.endpoints.map(e => e.url), ['/cjs/18']);
});

test('动态分支返回值不能取最后一个分支冒充确定值', async t => {
  const root = await fixture(t, { 'a.js': `function url(flag){if(flag){return '/a'}else{return '/b'}} fetch(url(runtimeFlag));` });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e=>e.url), ['/a','/b']);
  assert.ok(r.endpoints.every(e=>e.resolution === 'partial'));
  assert.ok(r.diagnostics.some(d => d.code === 'DYNAMIC_BRANCH'));
});

test('短路表达式中的请求和 fetch 别名仍可提取', async t => {
  const root = await fixture(t, { 'a.js': `const request=fetch; function load(flag){return flag && request('/conditional')} load(true); globalThis.fetch('/global');` });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/conditional', '/global']);
});

test('对象方法和箭头属性沿真实实参继续追踪', async t => {
  const root = await fixture(t, {
    'page.ts': `import api from './api'; api.load(5); api.save(6);`,
    'api.ts': "export default {load(id){return fetch(`/objects/${id}`)},save:id=>fetch(`/objects/${id}`,{method:'POST'})}",
  });
  const r = await analyze(root, {entries:['page.ts']});
  assert.deepEqual(r.endpoints.map(e => `${e.method} ${e.url}`).sort(), ['GET /objects/5','POST /objects/6']);
});

test('本地声明的 fetch 参数不能被当成全局 fetch', async t => {
  const root = await fixture(t, { 'a.ts': `function example(fetch: any){fetch('/fake')} const window={fetch(x){return x}}; window.fetch('/fake2')` });
  assert.equal((await analyze(root)).endpoints.length, 0);
});

test('配置校验应明确报告无效字段和无效扫描根目录', async t => {
  const root = await fixture(t, { 'a.ts': `fetch('/ok')` });
  for (const config of [null, [], {entries: 'src/**'}, {clients:[{name:'http',kind:'typo'}]}, {layers:[{name:'x'}]}, {aliases:{'@/*':'src/*'}}]) {
    await assert.rejects(analyze(root, config), /配置|entries|clients|layers|aliases/);
  }
  await assert.rejects(analyze(`${root}/missing`), /目录|ENOENT/);
});

test('动态提前返回不能把后续返回值冒充唯一结果', async t => {
  const root = await fixture(t, { 'a.js': `function url(flag){if(flag)return '/a'; return '/b'} fetch(url(flag));` });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e=>e.url), ['/a','/b']);
  assert.ok(r.endpoints.every(e=>e.resolution === 'partial'));
});

test('所有分支均返回后不再继续提取不可达请求', async t => {
  const root = await fixture(t, { 'a.js': `function url(flag){if(flag){return '/a'}else{return '/b'} fetch('/unreachable')} fetch(url(flag));` });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e=>e.url), ['/a','/b']);
});

test('循环 CommonJS require 可截断并报告', async t => {
  const root = await fixture(t, { 'a.cjs': `module.exports = require('./b.cjs');`, 'b.cjs': `module.exports = require('./a.cjs');`, 'entry.cjs': `const client=require('./a.cjs'); client();` });
  const r = await analyze(root, {entries:['entry.cjs']});
  assert.ok(r.diagnostics.some(d => d.code === 'MODULE_CYCLE'));
});

test('新增 aliases 不会破坏 tsconfig 中原有 baseUrl 的 paths', async t => {
  const root = await fixture(t, {
    'tsconfig.json': JSON.stringify({compilerOptions:{baseUrl:'src',paths:{'~/*':['*']}}}),
    'src/page.ts': `import {a} from '~/api'; import {b} from '@/api'; a(); b();`,
    'src/api.ts': `export function a(){fetch('/original-alias')} export function b(){fetch('/custom-alias')}`,
  });
  const r = await analyze(root, {entries:['src/page.ts'],aliases:{'@/*':['src/*']}});
  assert.deepEqual(r.endpoints.map(e => e.url), ['/custom-alias','/original-alias']);
});

test('不支持的函数型 URL 输出未知结果，序列化不崩溃', async t => {
  const root = await fixture(t, {'a.js':`fetch(()=>'/bad-url')`});
  const r = await analyze(root);
  assert.equal(r.endpoints[0].resolution, 'unresolved');
  assert.doesNotThrow(() => JSON.stringify(r));
});
