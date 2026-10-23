import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, markdown } from '../src/analyzer.js';
import { fixture } from './helpers.js';

test('跨文件、别名、转导出、axios.create 和实参传播', async t => {
  const root = await fixture(t, {
    'src/page.tsx': `import {load} from '@/api'; export function Page(){ load(42); return <div/>; }`,
    'src/api/index.ts': `export {load} from './users';`,
    'src/api/users.ts': 'import { get } from "../request"; export const load = id => get(`/users/${id}`, {params:{active:true}});',
    'src/request.ts': `import axios from 'axios'; const client=axios.create({baseURL:'/api'}); export const get=(url, config)=>client({ ...config, url, method:'GET' });`,
  });
  const report = await analyze(root, { entries: ['src/page.tsx'], aliases: { '@/*': ['src/*'] }, layers: [{ name: 'service', match: ['src/api/**'] }] });
  assert.equal(report.endpoints.length, 1);
  const e = report.endpoints[0];
  assert.equal(e.url, '/api/users/42');
  assert.equal(e.method, 'GET');
  assert.deepEqual(e.query, { active: true });
  assert.equal(e.resolution, 'resolved');
  assert.ok(e.usages.some(u => u.callChain.some(c => c.layers.includes('service'))));
});

test('Vue 和 Svelte 保留位置，TSX 和 Angular 脚本可提取', async t => {
  const root = await fixture(t, {
    'Page.vue': `<template><div/></template>\n<script setup lang="ts">\nfetch('/vue');\n</script>`,
    'Page.svelte': `<script lang="ts">\nconst x: number = 1;\nfetch('/svelte');\n</script>\n<p>{x}</p>`,
    'Page.tsx': `export const Page = () => { fetch('/react'); return <div/>; };`,
    'service.ts': `class Service { load(){ return this.http.get('/angular'); } }`,
  });
  const r = await analyze(root, { clients: [{ name: 'this.http', kind: 'axios' }] });
  assert.deepEqual(r.endpoints.map(e => e.url).sort(), ['/angular', '/react', '/svelte', '/vue']);
  assert.equal(r.endpoints.find(e => e.url === '/vue').usages[0].callChain.at(-1).line, 3);
  assert.equal(r.endpoints.find(e => e.url === '/svelte').usages[0].callChain.at(-1).line, 3);
});

test('动态 URL、参数和未知配置展开保留不确定性', async t => {
  const root = await fixture(t, {
    'a.js': 'export function load(id, options) { fetch(`/users/${id}`, {method:"POST", ...options}); }',
  });
  const r = await analyze(root);
  assert.equal(r.endpoints[0].url, '/users/{id}');
  assert.equal(r.endpoints[0].resolution, 'partial');
  assert.notEqual(r.endpoints[0].method, 'GET');
  assert.ok(r.endpoints[0].usages[0].unresolved.length);
});

test('本地同名 fetch 和普通 get 不误报，导入别名有效', async t => {
  const root = await fixture(t, {
    'a.js': `function fetch(x){return x}; fetch('/fake'); const map=new Map(); map.get('/fake2');`,
    'b.js': `import http from 'axios'; http.post('/real', {name:'a'});`,
  });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/real']);
  assert.equal(r.endpoints[0].method, 'POST');
  assert.deepEqual(r.endpoints[0].body, { name: 'a' });
});

test('递归和深度受限，语法错误显式报告', async t => {
  const root = await fixture(t, {
    'a.ts': `function a(){ a(); } a(); function b(){fetch('/deep')} function c(){b()} c();`,
    'bad.ts': `const = ;`,
  });
  const r = await analyze(root, { maxDepth: 1 });
  assert.ok(r.diagnostics.some(d => d.code === 'MAX_DEPTH'));
  assert.ok(r.diagnostics.some(d => d.code === 'SCRIPT_PARSE_ERROR'));
  assert.equal(r.stats.complete, false);
  assert.match(markdown(r), /前端接口提取/);
});

test('从 tsconfig 读取 paths，分别绑定同名参数', async t => {
  const root = await fixture(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/page.ts': `import {a,b} from '@/api'; a('first'); b('second');`,
    'src/api.ts': 'export function a(id){fetch(`/a/${id}`)}; export function b(id){fetch(`/b/${id}`)}',
  });
  const r = await analyze(root, { entries: ['src/page.ts'] });
  assert.deepEqual(r.endpoints.map(e => e.url), ['/a/first', '/b/second']);
});

test('执行预算耗尽和入口空匹配有诊断', async t => {
  const root = await fixture(t, { 'a.js': `fetch('/a'); fetch('/b');` });
  assert.ok((await analyze(root, { maxSteps: 1 })).diagnostics.some(d => d.code === 'BUDGET_EXCEEDED'));
  assert.ok((await analyze(root, { entries: ['missing/**'] })).diagnostics.some(d => d.code === 'NO_ENTRIES'));
});

test('顺序赋值、默认参数、分支诊断和不可达语句', async t => {
  const root = await fixture(t, {
    'a.ts': `function load(id='default'){let url='/old'; url='/new'; fetch(url); return fetch('/last'); fetch('/unreachable')}; load(); function branch(flag){if(flag){fetch('/yes')}else{fetch('/no')}}`,
  });
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/last', '/new', '/no', '/yes']);
  assert.ok(r.diagnostics.some(d => d.code === 'DYNAMIC_BRANCH'));
});

test('axios 命名请求导入可用，非请求导入不误识别', async t => {
  const root = await fixture(t, {
    'a.js': `import {get as load, isAxiosError} from 'axios'; load('/named'); isAxiosError('/fake');`,
  });
  assert.deepEqual((await analyze(root)).endpoints.map(e => e.url), ['/named']);
});
