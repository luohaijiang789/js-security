#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, markdown } from './analyzer.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, out: { type: 'string' }, format: { type: 'string', default: 'json' }, help: { type: 'boolean', short: 'h' }, 'include-unlinked':{type:'boolean'},
  } });
  if (values.help) console.log('用法: node src/cli.js <仓库目录> [--config config.json] [--out report.json] [--format json|markdown] [--include-unlinked]');
  else {
    if (positionals.length > 1) throw new Error('仅支持一个仓库目录');
    if (!['json', 'markdown'].includes(values.format)) throw new Error('--format 必须是 json 或 markdown');
    const root = path.resolve(positionals[0] ?? '.');
    if (!(await fs.stat(root)).isDirectory()) throw new Error('目标必须是目录');
    const configPath = values.config ? path.resolve(values.config) : path.join(root, 'api-extractor.config.json');
    let config = {};
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT' || values.config) throw e; }
    if(values['include-unlinked']) {
      if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('配置必须是 JSON 对象');
      config.includeUnlinked=true;
    }
    const report = await analyze(root, config);
    const output = values.format === 'markdown' ? markdown(report) : JSON.stringify(report, null, 2) + '\n';
    if (values.out) { await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true }); await fs.writeFile(values.out, output); }
    else process.stdout.write(output);
  }
} catch (e) { console.error(`提取失败: ${e.message}`); process.exitCode = 1; }
