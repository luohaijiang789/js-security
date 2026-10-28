import fs from 'node:fs/promises';
import path from 'node:path';
import {deploymentUrl} from './deployment-address.js';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import glob from 'fast-glob';
import {analyzeBuild,sha256} from './build-assets.js';
import {requestRows,requestCsv,requestMarkdown} from './request-table.js';

export function githubRepository(input) {
  const url=new URL(input);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname))throw new Error('仅支持无凭据的 GitHub HTTPS 仓库地址');
  return 'https://github.com'+url.pathname.replace(/\/$/,'').replace(/\.git$/,'');
}

export function taskProfile(value={}) {
  const defaults={dockerImage:'node:22-bookworm-slim',buildScript:'build',artifactDirs:['dist'],legacyPeerDeps:false,registryRewrites:{},buildEnv:{},analysis:{},timeoutMs:600000,deploymentUrl:null};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('任务配置必须是对象');
  for(const key of Object.keys(value))if(!Object.hasOwn(defaults,key)&&key!=='ref')throw new Error('未知任务配置: '+key);
  const result={...defaults,...value};
  if(result.ref!==undefined&&!/^[a-f0-9]{40}$/i.test(result.ref))throw new Error('ref 必须是完整 Commit SHA');
  if(result.ref)result.ref=result.ref.toLowerCase();
  if(typeof result.dockerImage!=='string'||! /^[a-z0-9][a-z0-9./:@_-]+$/i.test(result.dockerImage))throw new Error('Docker 镜像名称无效');
  if(typeof result.buildScript!=='string'||!/^[a-z0-9_][\w.:-]*$/i.test(result.buildScript))throw new Error('buildScript 必须是 npm script 名称');
  if(!Array.isArray(result.artifactDirs)||!result.artifactDirs.length||result.artifactDirs.some(d=>typeof d!=='string'||!d||path.isAbsolute(d)||d.split(/[\\/]/).includes('..')||d==='.'))throw new Error('artifactDirs 必须是仓内相对目录');
  if(typeof result.legacyPeerDeps!=='boolean')throw new Error('legacyPeerDeps 必须是布尔值');
  if(!Number.isSafeInteger(result.timeoutMs)||result.timeoutMs<1000||result.timeoutMs>1800000)throw new Error('timeoutMs 范围为 1000..1800000');
  for(const key of ['registryRewrites','buildEnv','analysis'])if(!result[key]||typeof result[key]!=='object'||Array.isArray(result[key]))throw new Error(key+' 必须是对象');
  for(const [from,to] of Object.entries(result.registryRewrites))if(typeof to!=='string'||!/^[\w.-]+$/.test(from)||! /^[\w.-]+$/.test(to))throw new Error('registryRewrites 仅允许显式主机名映射');
  for(const [key,v] of Object.entries(result.buildEnv))if(!/^[A-Z_][A-Z0-9_]*$/.test(key)||['HOME','CODEX_HOME','PATH','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'].includes(key)||key.startsWith('DOCKER_')||typeof v!=='string')throw new Error('buildEnv 键/值无效');
  result.deploymentUrl=deploymentUrl(result.deploymentUrl);
  return result;
}

export function rewriteRegistry(lock,mapping) {
  let count=0;
  const visit=value=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.resolved==='string') {
      let url;try{url=new URL(value.resolved);}catch{}
      if(url&&Object.hasOwn(mapping,url.hostname)) {
        if(url.protocol!=='https:'||!value.integrity)throw new Error('registry 映射要求 HTTPS 和原始 integrity');
        if(url.hostname==='registry.npmmirror.com'&&mapping[url.hostname]==='registry.npmjs.org') {
          const pkg=url.pathname.split(/\/(?:download|-)\//)[0];
          if(!/^\/(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg)||!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(value.version))throw new Error('无法按锁定名称/版本规范化镜像 tarball URL');
          url.pathname=pkg+'/-/'+pkg.split('/').at(-1)+'-'+value.version+'.tgz';url.search='';url.hash='';
        }
        url.hostname=mapping[url.hostname];value.resolved=url.href;count++;
      }
    }
    for(const item of Object.values(value))visit(item);
  };
  visit(lock);return count;
}

export async function runLogged(command,args,{cwd,env={},log,timeoutMs=120000,maxBytes=8*1024*1024}={}) {
  let output='',bytes=0,reason;
  const handle=log?await fs.open(log,'w'):null;
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{reason='timeout';child.kill('SIGKILL');},timeoutMs);
    let writes=Promise.resolve();
    const consume=data=>{
      bytes+=data.length;
      if(bytes>maxBytes){reason='log-budget';child.kill('SIGKILL');return;}
      if(output.length<65536)output+=data.toString('utf8').slice(0,65536-output.length);
      if(handle)writes=writes.then(()=>handle.write(data));
    };
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    child.on('error',async error=>{clearTimeout(timer);await handle?.close();reject(error);});
    child.on('close',async(code,signal)=>{clearTimeout(timer);try{await writes;await handle?.close();resolve({code,signal,reason,output,bytes});}catch(error){reject(error);}});
  });
}

export async function runRepository(input,{profile={},workDir=path.resolve('work/repository-scans'),execute=runLogged}={}) {
  const repository=githubRepository(input);
  const preset=repository.toLowerCase()==='https://github.com/aliyun/alibabacloud-gdb-console'?JSON.parse(await fs.readFile(new URL('../profiles/gdb-console.json',import.meta.url),'utf8')):{};
  const config=taskProfile({...preset,...profile});
  const taskDir=path.join(path.resolve(workDir),'task-'+Date.now()+'-'+randomUUID().slice(0,8));
  await fs.mkdir(taskDir,{recursive:true});await fs.mkdir(path.join(taskDir,'logs'));
  const checkout=path.join(taskDir,'checkout');
  const manifest={schemaVersion:1,state:'running',repository,commit:null,startedAt:new Date().toISOString(),engineVersion:'0.8.1',stages:[],gaps:[],profile:{...config,buildEnv:Object.keys(config.buildEnv)}};
  const persist=()=>fs.writeFile(path.join(taskDir,'task.json'),JSON.stringify(manifest,null,2)+'\n');
  const stage=async(name,command,args,options={})=>{
    const entry={name,state:'running',startedAt:new Date().toISOString(),log:'logs/'+name+'.log'};manifest.stages.push(entry);await persist();
    const r=await execute(command,args,{cwd:taskDir,timeoutMs:config.timeoutMs,log:path.join(taskDir,entry.log),...options});
    Object.assign(entry,{state:r.code===0&&!r.reason?'succeeded':'failed',exitCode:r.code,reason:r.reason??r.signal??null,finishedAt:new Date().toISOString()});await persist();
    if(entry.state!=='succeeded')throw new Error(name+' 失败；详见 '+entry.log);
    return r.output.trim();
  };
  const dockerEnv={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])dockerEnv[key]=undefined;
  const dockerArgs=['--host=unix:///var/run/docker.sock'];
  const container=async(name,command)=>{
    const containerName='js-scan-'+randomUUID();
    const ca=process.env.CODEX_PROXY_CERT??'/etc/ssl/certs/ca-certificates.crt';await fs.access(ca);
    const args=[...dockerArgs,'run','--rm','--name',containerName,'--user',`${process.getuid()}:${process.getgid()}`,'--cap-drop=ALL','--security-opt','no-new-privileges','--memory','4g','--cpus','2','--pids-limit','512','--read-only','--tmpfs','/tmp:rw,exec,nosuid,size=1g',
      '--mount',`type=bind,src=${checkout},dst=/app`,'--mount',`type=bind,src=${ca},dst=/run/proxy-ca.pem,readonly`,'-w','/app','-e','NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem','-e','npm_config_cache=/tmp/npm-cache',...Object.keys(config.buildEnv).flatMap(key=>['-e',key]),config.dockerImage,...command];
    try{return await stage(name,'docker',args,{env:{...dockerEnv,...config.buildEnv}});}
    finally{await execute('docker',[...dockerArgs,'rm','-f',containerName],{env:dockerEnv,timeoutMs:10000}).catch(()=>{});}
  };
  try {
    await persist();
    if(!config.ref){const out=await stage('resolve','git',['ls-remote',repository+'.git','HEAD'],{env:{GIT_TERMINAL_PROMPT:'0'}});config.ref=out.split(/\s/)[0];if(!/^[a-f0-9]{40}$/.test(config.ref))throw new Error('无法固定默认分支 Commit');}
    await stage('clone','git',['clone','--no-checkout','--filter=blob:none','--',repository+'.git',checkout],{env:{GIT_TERMINAL_PROMPT:'0'}});
    await stage('checkout','git',['-C',checkout,'checkout','--detach',config.ref],{env:{GIT_TERMINAL_PROMPT:'0'}});
    const commit=await stage('verify','git',['-C',checkout,'rev-parse','HEAD']);if(commit!==config.ref)throw new Error('checkout Commit 不匹配');manifest.commit=commit;
    const pkg=JSON.parse(await fs.readFile(path.join(checkout,'package.json'),'utf8'));
    if(!pkg.scripts?.[config.buildScript])throw new Error('仓库未声明指定 npm 构建脚本');
    const originalHashes=new Map();let originalBytes=0;
    for(const name of await glob('src/**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}',{cwd:checkout,followSymbolicLinks:false})) {
      const file=path.join(checkout,name);if((await fs.lstat(file)).isSymbolicLink())continue;
      const bytes=await fs.readFile(file);originalBytes+=bytes.length;if(originalBytes>64*1024*1024)throw new Error('构建前源码快照超过 64 MiB');originalHashes.set(name,sha256(bytes));
    }
    const lockPath=path.join(checkout,'package-lock.json'),original=await fs.readFile(lockPath);
    const lock=JSON.parse(original);if(![1,2,3].includes(lock.lockfileVersion))throw new Error('仅支持 npm lockfile v1/v2/v3');
    const count=rewriteRegistry(lock,config.registryRewrites);
    if(count)await fs.writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');
    manifest.lock={originalSha256:sha256(original),appliedSha256:sha256(await fs.readFile(lockPath)),rewrittenUrls:count,versionsAndIntegrityPreserved:true};
    manifest.dependencies=Object.fromEntries(Object.entries({...pkg.dependencies,...pkg.devDependencies}).filter(([name])=>name.startsWith('@alicloud/')||name.startsWith('@alifd/')||name==='ali-oss').map(([name,declared])=>[name,{declared,locked:lock.packages?.['node_modules/'+name]?.version??lock.dependencies?.[name]?.version??null}]));
    await stage('docker-check','docker',[...dockerArgs,'info','--format','{{.ServerVersion}}'],{env:dockerEnv});
    await stage('image-pull','docker',[...dockerArgs,'pull',config.dockerImage],{env:dockerEnv});
    manifest.imageDigests=JSON.parse(await stage('image','docker',[...dockerArgs,'image','inspect','--format','{{json .RepoDigests}}',config.dockerImage],{env:dockerEnv}));
    manifest.nodeVersion=await container('runtime',['node','--version']);
    await container('install',['npm','ci','--ignore-scripts',...(config.legacyPeerDeps?['--legacy-peer-deps']:[]),'--no-audit','--no-fund','--strict-ssl=true']);
    if(sha256(await fs.readFile(lockPath))!==manifest.lock.appliedSha256)throw new Error('安装阶段更改了锁文件');
    await container('build',['npm','run',config.buildScript]);
    if(sha256(await fs.readFile(lockPath))!==manifest.lock.appliedSha256)throw new Error('构建阶段更改了锁文件');
    if(await stage('verify-built-head','git',['-C',checkout,'rev-parse','HEAD'])!==commit)throw new Error('构建改变了 checkout Commit');
    manifest.trackedChanges=await stage('tracked-changes','git',['-C',checkout,'diff','--name-only','HEAD']);
    const analysisStage={name:'analysis',state:'running',startedAt:new Date().toISOString()};manifest.stages.push(analysisStage);await persist();
    const built=await analyzeBuild(checkout,config.artifactDirs,taskDir,config.analysis,originalHashes);
    const changed=manifest.trackedChanges.split('\n').filter(name=>name&&!(count&&name==='package-lock.json'));
    if(changed.length)built.gaps.push('构建修改了已跟踪输入: '+changed.join(', '));
    const globalGaps=[...built.gaps,...built.report.stats.partitions.filter(p=>p.state!=='finished').map(p=>`${p.file}: ${p.state} (${p.reason??'unknown'})`)];
    if(built.report.diagnostics.length)globalGaps.push(`分析器有 ${built.report.diagnostics.length} 条诊断，详见 analysis.json`);
    const meta={mode:built.mode,repository,commit,deploymentUrl:config.deploymentUrl,gaps:globalGaps};const rows=requestRows(built.report,meta,built.locations);
    const bottom={...built.report,...meta,analysisMode:built.report.mode,sourceAssets:built.report.assets,assets:built.assets,mappedSources:built.mappedSources,buildGaps:built.gaps,rows};
    await fs.writeFile(path.join(taskDir,'analysis.json'),JSON.stringify(bottom,null,2)+'\n');
    await fs.writeFile(path.join(taskDir,'requests.csv'),requestCsv(rows));await fs.writeFile(path.join(taskDir,'requests.md'),requestMarkdown(rows,meta));
    Object.assign(analysisStage,{state:'succeeded',finishedAt:new Date().toISOString()});
    manifest.analysis={mode:built.mode,assets:built.assets,mappedSources:built.mappedSources.length,rows:rows.length,stats:built.report.stats,complete:built.report.stats.complete&&!built.gaps.length};manifest.gaps=globalGaps;
    manifest.state='completed';manifest.finishedAt=new Date().toISOString();manifest.outputs=['requests.csv','requests.md','analysis.json'];await persist();
    return {taskDir,manifest,rows};
  } catch(error) {
    manifest.state='failed';manifest.error=error.message;manifest.finishedAt=new Date().toISOString();
    for(const entry of manifest.stages)if(entry.state==='running'){
      entry.state='failed';entry.error=error.message;
      if(!entry.log){entry.log='logs/'+entry.name+'.log';await fs.writeFile(path.join(taskDir,entry.log),error.stack??String(error));}
    }
    await persist();error.taskDir=taskDir;throw error;
  }
}
