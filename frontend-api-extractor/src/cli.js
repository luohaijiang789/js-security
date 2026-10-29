#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'delivery-dir':{type:'string'},'no-delivery':{type:'boolean'},'allow-empty':{type:'boolean'},'allow-incomplete':{type:'boolean'},config: { type: 'string' }, out: { type: 'string' }, format: { type: 'string', default: 'json' }, help: { type: 'boolean', short: 'h' }, 'include-unlinked':{type:'boolean'},
  } });
  if (values.help) console.log('用法: node src/cli.js <仓库目录> [--config config.json] [--out report.json] [--format json|markdown] [--include-unlinked] [--delivery-dir directory] [--no-delivery] [--allow-empty] [--allow-incomplete]');
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
    if(values['no-delivery']&&values['delivery-dir'])throw Error('--no-delivery不能与--delivery-dir同时使用');
    const {analyze,markdown}=await import('./analyzer.js');
    console.error('扫描开始: '+path.basename(root));
    const report = await analyze(root, config);
    const deliveryDir=values['no-delivery']?null:values['delivery-dir']?path.resolve(values['delivery-dir']):values.out?path.resolve(values.out)+'.delivery':null;
    if(deliveryDir){const {writeDelivery}=await import('./delivery-cli.js');await writeDelivery(report,deliveryDir,{mode:'source-static'});}

    const output = values.format === 'markdown' ? markdown(report) : JSON.stringify(report, null, 2) + '\n';
    if (values.out) { await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true }); await fs.writeFile(values.out, output); }
    else process.stdout.write(output);
    const endpoints=[...report.endpoints,...report.assetCandidates],incomplete=report.stats.coverage.state!=='finished';
    const known=endpoints.filter(e=>/[a-z0-9]/i.test(e.url.replace(/\{[^}]*\}/g,'')));
    console.error(JSON.stringify({state:incomplete?'incomplete':known.length?'finished':'empty',endpoints:endpoints.length,addressCandidates:known.length,unresolvedSendingSites:endpoints.length-known.length,rows:endpoints.reduce((n,e)=>n+e.usages.length,0),steps:report.stats.steps,coverage:report.stats.coverage,diagnostics:report.diagnostics.length,deliveryDir}));
    if(incomplete&&!values['allow-incomplete'])process.exitCode=3;
    else if(!known.length&&!values['allow-empty'])process.exitCode=2;
  }
} catch (e) { console.error(`提取失败: ${e.message}`);if(e.code==='ERR_MODULE_NOT_FOUND')console.error('请先在 frontend-api-extractor 目录执行 npm ci 安装依赖。'); process.exitCode = 1; }
