import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (cwd, args = []) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding:'utf8', timeout:15000 });

test('CLI 自动加载目标配置，stdout 是可解析 JSON', async t => {
  const root = await fixture(t, {
    'api-extractor.config.json': JSON.stringify({entries:['page.js']}),
    'page.js': `fetch('/cli')`,
    'unused.js': `fetch('/unused')`,
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /扫描开始/);
  assert.deepEqual(JSON.parse(result.stdout).endpoints.map(e => e.url), ['/cli']);
});

test('CLI 创建输出目录，Markdown 文件和 JSON 文件内容正确', async t => {
  const root = await fixture(t, {'page.js': `fetch('/cli', {method:'POST',body:'hello'})`});
  for (const format of ['json','markdown']) {
    const output = `reports/deep/apis.${format === 'json' ? 'json' : 'md'}`;
    const result = run(root, ['.', '--format', format, '--out', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const content = await fs.readFile(path.join(root, output), 'utf8');
    if (format === 'json') assert.equal(JSON.parse(content).endpoints[0].body, 'hello');
    else assert.match(content, /POST.*\/cli.*resolved/);
  }
});

test('CLI 错误配置、无效选项和不存在的目标明确失败', async t => {
  const root = await fixture(t, {'page.js': `fetch('/cli')`, 'invalid.json':'{broken'});
  for (const args of [ ['.', '--config','missing.json'], ['.', '--config','invalid.json'], ['.', '--format','xml'], ['missing'], ['.', '--unknown'] ]) {
    const result = run(root, args);
    assert.equal(result.status, 1, `args=${args} stderr=${result.stderr}`);
    assert.match(result.stderr, /提取失败:/);
    assert.equal(result.stdout, '');
  }
});

test('CLI --help 无需扫描目标', async t => {
  const root = await fixture(t, {});
  const result = run(root, ['does-not-exist','--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法:/);
});

test('分析源码不会执行目标仓库的顶层 JS', async t => {
  const root = await fixture(t, {'page.cjs': `require('node:fs').writeFileSync('executed.txt','bad'); fetch('/safe'); throw new Error('do not execute')`});
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).endpoints.map(e => e.url), ['/safe']);
  await assert.rejects(fs.access(path.join(root,'executed.txt')), {code:'ENOENT'});
});
test('CLI 显式资产级补漏输出独立 JSON 列表和 Markdown 说明',async t=>{
  const root=await fixture(t,{'api-extractor.config.json':JSON.stringify({entries:['entry.js']}),'entry.js':`import('./lazy.js').then(m=>m[unknownName]())`,'lazy.js':`export const send=()=>fetch('/unlinked')`});
  const json=run(root,['.','--include-unlinked']);
  assert.equal(json.status,0,json.stderr);
  const report=JSON.parse(json.stdout);
  assert.equal(report.endpoints.length,0);assert.equal(report.assetCandidates.length,1);
  const md=run(root,['.','--include-unlinked','--format','markdown']);
  assert.equal(md.status,0,md.stderr);
  assert.match(md.stdout,/资产级候选/);assert.match(md.stdout,/\/unlinked/);
});
