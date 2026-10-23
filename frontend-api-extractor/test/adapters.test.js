import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { fixture } from './helpers.js';

test('Vue CRLF 和 Unicode 保留真实行列，模板和样式不会当脚本扫描', async t => {
  const source = `<template><div @click="fetch('/template-only')">你好😀</div></template>\r\n<script setup>\r\nconst label='中文😀'; fetch('/vue-location');\r\n</script>\r\n<style>/* fetch('/style-only') */</style>`;
  const root = await fixture(t, {'Page.vue':source});
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/vue-location']);
  const edge = r.endpoints[0].usages[0].callChain.at(-1);
  assert.equal(edge.line, 3);
  assert.equal(edge.column, source.split('\r\n')[2].indexOf('fetch') + 1);
});

test('Svelte module 和 instance 脚本均可分析', async t => {
  const root = await fixture(t, {'Page.svelte':`<script module>fetch('/module')</script>\n<script>fetch('/instance')</script>\n<p>hello</p>`});
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/instance','/module']);
  assert.equal(r.diagnostics.length, 0);
});

test('不支持的 Vue 外置脚本和破损 Svelte 产生诊断，其他文件继续提取', async t => {
  const root = await fixture(t, {'External.vue':`<script src="./script.js"></script>`, 'Broken.svelte':`<script>const = ;</script>`, 'valid.ts':`fetch('/valid')`});
  const r = await analyze(root);
  assert.deepEqual(r.endpoints.map(e => e.url), ['/valid']);
  assert.equal(r.diagnostics.filter(d => d.code === 'FRAMEWORK_PARSE_ERROR').length, 2);
});
