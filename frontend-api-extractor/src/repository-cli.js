#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {runRepository} from './repository-task.js';

try {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{profile:{type:'string'},'deployment-url':{type:'string'},ref:{type:'string'},'work-dir':{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('用法: node src/repository-cli.js <GitHub HTTPS URL> [--ref CommitSHA] [--profile build-profile.json] [--work-dir directory] [--deployment-url https://example.test/app/]');
  else {
    if(positionals.length!==1)throw new Error('请提供一个 GitHub 仓库地址');
    const profile=values.profile?JSON.parse(await fs.readFile(path.resolve(values.profile),'utf8')):{};
    if(values['deployment-url'])profile.deploymentUrl=values['deployment-url'];
    if(values.ref)profile.ref=values.ref;
    const result=await runRepository(positionals[0],{profile,...(values['work-dir']?{workDir:values['work-dir']}:{})});
    console.log(JSON.stringify({state:result.manifest.state,taskDir:result.taskDir,commit:result.manifest.commit,rows:result.rows.length,analysisComplete:result.manifest.analysis.complete,outputs:result.manifest.outputs},null,2));
  }
} catch(error){console.error('仓库构建分析失败: '+error.message+(error.taskDir?'；任务记录: '+error.taskDir+'/task.json':''));process.exitCode=1;}
