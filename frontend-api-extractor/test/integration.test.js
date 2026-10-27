import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';

const root = fileURLToPath(new URL('../examples/multi-framework/', import.meta.url));

test('多框架验收仓库：接口集合、调用证据和参数与人工预期一致', async () => {
  const config = JSON.parse(await fs.readFile(path.join(root, 'api-extractor.config.json'), 'utf8'));
  const expected = JSON.parse(await fs.readFile(path.join(root, 'expected.json'), 'utf8'));
  const report = await analyze(root, config);
  assert.deepEqual(report.endpoints.map(e => `${e.method} ${e.url}`).sort(), expected.sort());
  const user = report.endpoints.find(e => e.url === '/v1/users/7');
  assert.equal(user.resolution, 'resolved');
  assert.deepEqual(user.query, { active: true });
  assert.deepEqual(user.headers, {'X-App': 'fixture'});
  assert.ok(user.usages.some(u => ['page','hook','service','transport'].every(layer => u.callChain.some(edge => edge.layers.includes(layer)))));
  const dynamic = report.endpoints.find(e => e.url === '/v1/users/{id}');
  assert.equal(dynamic.resolution, 'partial');
  assert.ok(dynamic.usages.every(u => u.unresolved.length > 0));
  assert.deepEqual(report.endpoints.find(e => e.method === 'POST' && e.url === '/v1/angular').body, {name:'example'});
  assert.deepEqual(report.endpoints.find(e => e.url === '/v2/search').query, {locale:'zh',q:'example'});
  assert.deepEqual(report.endpoints.find(e => e.url === '/v2/uploads').body, {name:'example'});
  assert.ok(report.endpoints.find(e => e.url === '/v2/preview').usages.every(u=>u.conditions.length > 0));
  assert.ok(!report.endpoints.some(e=>e.url === '/v2/preview' && e.method === 'POST'));
  for (const ep of report.endpoints) for (const usage of ep.usages) for (const edge of usage.callChain) {
    const source = await fs.readFile(path.join(root, edge.file), 'utf8');
    assert.ok(edge.line > 0 && edge.line <= source.split('\n').length);
    assert.ok(edge.column > 0);
  }
  const vue = report.endpoints.find(e => e.url === '/v1/users/8').usages[0];
  assert.ok(vue.callChain.some(edge => edge.file.endsWith('VuePage.vue') && edge.line === 5));
  assert.ok(!report.diagnostics.some(d => ['SCRIPT_PARSE_ERROR','FRAMEWORK_PARSE_ERROR','MAX_DEPTH','BUDGET_EXCEEDED'].includes(d.code)));
});
