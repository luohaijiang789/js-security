import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {githubRepository,taskProfile,rewriteRegistry,runLogged,runRepository} from '../src/repository-task.js';
import {analyzeBuild} from '../src/build-assets.js';
import {requestRows,requestCsv,requestMarkdown,sinkId} from '../src/request-table.js';
import {fixture} from './helpers.js';

const code=`fetch('https://api.example.test/items',{method:'POST',body:{account:{id:7}}});`;
const commit='a'.repeat(40);
const buildFiles={
  'src/api.js':code,
  'dist/app.js':code+'\n//# sourceMappingURL=app.js.map\n',
  'dist/app.js.map':JSON.stringify({version:3,file:'app.js',sources:['webpack:///./src/api.js'],sourcesContent:[code],names:[],mappings:'AAAA'}),
};

test('GitHub 地址规范化、凭据与其他协议/端口/路径拒绝',()=>{
  assert.equal(githubRepository('https://github.com/owner/repo.git'),'https://github.com/owner/repo');
  for(const value of ['http://github.com/a/b','https://token@github.com/a/b','https://example.test/a/b','https://github.com:444/a/b','https://github.com/a/b/tree/main'])assert.throws(()=>githubRepository(value));
});

test('任务配置拒绝目录穿越、命令参数注入、非固定 SHA 与环境覆盖',()=>{
  assert.equal(taskProfile({ref:'A'.repeat(40)}).ref,commit);
  for(const value of [{artifactDirs:['../outside']},{buildScript:'build;whoami'},{ref:'main'},{timeoutMs:1},{registryRewrites:{x:1}},{buildEnv:{DOCKER_HOST:'evil'}},{buildEnv:{HOME:'/tmp'}}])assert.throws(()=>taskProfile(value));
});

test('旧镜像转换遵守锁定名称、版本和 integrity，默认不改变来源',()=>{
  const original={version:'1.2.3',integrity:'sha512-example',resolved:'https://registry.npmmirror.com/@scope/name/download/@scope/name-1.2.3.tgz?cache=1'};
  const locked=structuredClone(original);assert.equal(rewriteRegistry(locked,{}),0);assert.deepEqual(locked,original);
  assert.equal(rewriteRegistry(locked,{'registry.npmmirror.com':'registry.npmjs.org'}),1);
  assert.equal(locked.resolved,'https://registry.npmjs.org/@scope/name/-/name-1.2.3.tgz');assert.equal(locked.version,original.version);assert.equal(locked.integrity,original.integrity);
  assert.throws(()=>rewriteRegistry({...original,integrity:undefined},{'registry.npmmirror.com':'registry.npmjs.org'}),/integrity/);
});

test('真正的 source map 将源码发送位置连接到产物，字段保留',async t=>{
  const root=await fixture(t,buildFiles),output=await fixture(t,{});
  const result=await analyzeBuild(root,['dist'],output);
  assert.equal(result.mode,'source-map-assisted');assert.equal(result.report.endpoints.length,1);
  const rows=requestRows(result.report,{mode:result.mode,repository:'https://github.com/example/test',commit},result.locations);
  assert.equal(rows[0].generatedFile,'dist/app.js');assert.equal(rows[0].generatedLine,1);assert.equal(rows[0].sourceFile,'src/api.js');assert.equal(rows[0].sourceVersionMatch,true);
  assert.equal(rows[0].host,'api.example.test');assert.equal(rows[0].body.account.id,7);
});

test('源码中已删除的未映射调用不能伪装成构建产物接口',async t=>{
  const source=code+`\nfetch('/removed');`;
  const root=await fixture(t,{...buildFiles,'src/api.js':source,'dist/app.js.map':JSON.stringify({version:3,sources:['webpack:///src/api.js'],sourcesContent:[source],names:[],mappings:'AAAA'})});
  const result=await analyzeBuild(root,['dist'],await fixture(t,{}));
  const rows=requestRows(result.report,{mode:result.mode},result.locations);
  const removed=rows.find(r=>r.url==='/removed');assert.equal(removed.generatedFile,null);assert.ok(removed.gaps.some(g=>g.includes('未找到产物映射')));
  assert.ok(result.gaps.some(g=>g.includes('无产物映射')));
});

test('缺 map 时保留原生 JS 分析和明确缺口，不回退到源码成功',async t=>{
  const root=await fixture(t,{'src/hidden.js':`fetch('/source-only')`,'dist/app.js':code});
  const result=await analyzeBuild(root,['dist'],await fixture(t,{}));
  assert.equal(result.mode,'artifact-static');assert.ok(result.gaps.some(g=>g.includes('source map')));
  const rows=requestRows(result.report,{mode:result.mode},result.locations);assert.equal(rows.length,1);assert.equal(rows[0].generatedFile,'dist/app.js');
  assert.ok(!rows.some(r=>r.url==='/source-only'));
});

test('source map 同名不同内容及 vendor 省略均有独立缺口',async t=>{
  const vendor=`fetch('/vendor')`;
  const root=await fixture(t,{...buildFiles,'dist/other.js':'0;\n//# sourceMappingURL=other.js.map','dist/other.js.map':JSON.stringify({version:3,sources:['webpack:///src/api.js','webpack:///node_modules/vendor/src/api.js'],sourcesContent:[`fetch('/conflicting')`,vendor],names:[],mappings:'AAAA'})});
  const result=await analyzeBuild(root,['dist'],await fixture(t,{}));
  assert.ok(result.gaps.some(g=>g.includes('冲突')));assert.ok(result.excludedSources>0);
});

test('真实 CRA 的相对 source 名称通过内容哈希匹配，不误收第三方 src',async t=>{
  const root=await fixture(t,{...buildFiles,'dist/app.js.map':JSON.stringify({version:3,sources:['api.js','../../src/vendor.ts'],sourcesContent:[code,`fetch('https://vendor.example.test/hidden')`],names:[],mappings:'AAAA'})});
  const result=await analyzeBuild(root,['dist'],await fixture(t,{}));
  assert.equal(result.mappedSources.length,1);assert.equal(result.mappedSources[0].file,'src/api.js');
  assert.deepEqual(result.report.endpoints.map(e=>e.url),['https://api.example.test/items']);assert.equal(result.excludedSources,1);
});

test('产物目录软链接不能越过 checkout',async t=>{
  const root=await fixture(t,{}),outside=await fixture(t,{'app.js':code});await fs.symlink(outside,path.join(root,'dist'));
  await assert.rejects(analyzeBuild(root,['dist'],await fixture(t,{})),/软链接/);
});

test('表格按调用/阶段保留记录，CSV 保护公式并保留未知',()=>{
  const usage={entry:'src/api.js',callChain:[{file:'src/api.js',line:1,column:1}],unresolved:[],conditions:[],address:{host:null},query:null,body:{id:7},headers:null,resolution:'partial'};
  const report={endpoints:[{method:'POST',url:'=HYPERLINK("bad")',usages:[usage,{...usage,body:{id:8}}]}],assetCandidates:[]};
  const locations=new Map([[sinkId(usage.callChain[0]),[{file:'dist/app.js',line:1,column:8}]]]);
  const rows=requestRows(report,{mode:'source-map-assisted'},locations);assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
  const csv=requestCsv(rows);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('无显式字段'));assert.match(requestMarkdown(rows),/dist\/app\.js:1:8/);
  assert.match(requestMarkdown(rows,{gaps:['vendor omitted']}),/vendor omitted/);
});

test('子进程失败、超时和日志超限都可检测',async t=>{
  const root=await fixture(t,{}),log=path.join(root,'run.log');
  const failed=await runLogged(process.execPath,['-e',`console.log('saved');process.exit(3)`],{log});assert.equal(failed.code,3);assert.match(await fs.readFile(log,'utf8'),/saved/);
  const timeout=await runLogged(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:60});assert.equal(timeout.reason,'timeout');
  const large=await runLogged(process.execPath,['-e',`console.log('x'.repeat(2000))`],{maxBytes:50});assert.equal(large.reason,'log-budget');
});

function fakeCommands({failBuild=false}={}) {
  return async(command,args,options={})=>{
    if(command==='git'&&args[0]==='clone') {
      const checkout=args.at(-1);await fs.mkdir(path.join(checkout,'src'),{recursive:true});
      await fs.writeFile(path.join(checkout,'src/api.js'),code);
      await fs.writeFile(path.join(checkout,'package.json'),JSON.stringify({scripts:{build:'fixture-build'},dependencies:{'@alicloud/example':'1.0.0'}}));
      await fs.writeFile(path.join(checkout,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
    }
    if(command==='docker'&&args.includes('run')&&args.at(-1)==='build') {
      if(failBuild)return {code:7,output:'build failed'};
      const mount=args.find(x=>x.startsWith('type=bind,src=')&&x.endsWith(',dst=/app'));
      const checkout=mount.slice('type=bind,src='.length,-',dst=/app'.length);
      await fs.mkdir(path.join(checkout,'dist'),{recursive:true});
      for(const [name,text] of Object.entries(buildFiles))if(name.startsWith('dist/'))await fs.writeFile(path.join(checkout,name),text);
    }
    let output='';
    if(command==='git'&&args.includes('rev-parse'))output=commit;
    if(command==='docker'&&args.includes('inspect'))output='["node@sha256:test-fixture"]';
    if(options.log)await fs.writeFile(options.log,'self-authored mocked process: '+command+'\n');
    return {code:0,output};
  };
}

test('离线自写流程验证任务顺序、产物分析和最终 CSV/Markdown',async t=>{
  const root=await fixture(t,{});
  const result=await runRepository('https://github.com/example/fixture',{profile:{ref:commit,deploymentUrl:'https://console.example.test/app/#/graph'},workDir:root,execute:fakeCommands()});
  assert.equal(result.manifest.state,'completed');assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].sourceVersionMatch,true);assert.match(await fs.readFile(path.join(result.taskDir,'requests.csv'),'utf8'),/api\.example\.test/);
  const analysis=JSON.parse(await fs.readFile(path.join(result.taskDir,'analysis.json'),'utf8'));assert.equal(analysis.mode,'source-map-assisted');assert.equal(analysis.sourceAssets.length,1);
  assert.equal(result.manifest.profile.deploymentUrl,'https://console.example.test/app/');assert.equal(analysis.deploymentUrl,result.manifest.profile.deploymentUrl);assert.equal(result.rows[0].hostBasis,'static-code');
  assert.ok(result.manifest.stages.every(s=>s.state==='succeeded'));
});

test('构建失败保留任务和日志，不生成接口表或切换源码成功',async t=>{
  const root=await fixture(t,{});let failure;
  try{await runRepository('https://github.com/example/fixture',{profile:{ref:commit},workDir:root,execute:fakeCommands({failBuild:true})});}catch(error){failure=error;}
  assert.ok(failure);const manifest=JSON.parse(await fs.readFile(path.join(failure.taskDir,'task.json'),'utf8'));
  assert.equal(manifest.state,'failed');assert.equal(manifest.stages.find(s=>s.name==='build').exitCode,7);
  await assert.rejects(fs.access(path.join(failure.taskDir,'requests.csv')),{code:'ENOENT'});
});
