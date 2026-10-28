import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentUrl,deploymentAddress} from '../src/deployment-address.js';
import {requestRows,requestCsv,requestMarkdown} from '../src/request-table.js';
import {taskProfile,runRepository} from '../src/repository-task.js';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';

const base='https://console.example.test:8443/app/index.html?lang=zh#/graph';
const context=deploymentUrl(base);
const stage=url=>({url,address:{host:null,hostState:'unknown'}});

test('部署基址只接受无凭据 HTTP(S)，去掉 hash 路由并保留真实文档路径',()=>{
  assert.equal(context,'https://console.example.test:8443/app/index.html?lang=zh');
  assert.equal(taskProfile({deploymentUrl:base}).deploymentUrl,context);
  assert.equal(deploymentUrl(),null);
  for(const value of [7,'//example.test/','https://user:pass@example.test/','file:///tmp/a','https://{host}/','https://example.test/ bad','https:\\example.test'])assert.throws(()=>deploymentUrl(value));
});

test('根相对、目录相对、父路径、query 与 fragment 按 URL 标准解析',()=>{
  const cases=[['/api/items','/api/items'],['api/items','/app/api/items'],['../api/items','/api/items'],['?id=1','/app/index.html?id=1'],['#view','/app/index.html?lang=zh'],['','/app/index.html?lang=zh']];
  for(const [input,expected] of cases){
    const result=deploymentAddress(stage(input),context);
    assert.equal(result.host,'console.example.test:8443');assert.equal(result.hostBasis,'deployment-context');assert.equal(result.hostState,'context-candidate');
    assert.equal(result.resolvedUrl,'https://console.example.test:8443'+expected);assert.deepEqual(result.gaps,[]);
  }
});

test('无部署上下文相对路径仍未知，不借用仓库、CDN 或开发 proxy',()=>{
  for(const url of ['/api/items','api/items','//api.example.test/items'])assert.equal(deploymentAddress(stage(url)).resolvedUrl,null);
  assert.equal(deploymentAddress(stage('/api/items')).host,null);
});

test('绝对和协议相对跨域请求保留代码 Host，部署基址只补协议',()=>{
  const absolute=deploymentAddress({url:'https://api.example.test/items#part',address:{host:'api.example.test',hostState:'partial'}},context);
  assert.equal(absolute.host,'api.example.test');assert.equal(absolute.hostBasis,'static-code');assert.equal(absolute.hostState,'partial');assert.equal(absolute.resolvedUrl,'https://api.example.test/items');
  const relative=deploymentAddress(stage('//api.example.test:9443/items'),context);
  assert.equal(relative.host,'api.example.test:9443');assert.equal(relative.hostBasis,'static-code');assert.equal(relative.resolvedUrl,'https://api.example.test:9443/items');
});

test('动态地址、未知 baseURL、不支持协议不伪造部署 Host',()=>{
  for(const url of ['{host}/api','https://{host}/api','/api/{id}','{baseURL}/items','data:application/json,{}','javascript:alert(1)','https://user:pass@api.example.test/','https://[bad/','\\\\api.example.test/path']){
    const result=deploymentAddress(stage(url),context);assert.equal(result.host,null,url);assert.equal(result.resolvedUrl,null,url);assert.ok(result.gaps.length,url);
  }
  const result=deploymentAddress({url:'https://api.example.test/{id}',address:{host:'api.example.test',hostState:'resolved'}},context);
  assert.equal(result.host,'api.example.test');assert.equal(result.resolvedUrl,null);
});

test('代码 Host 与解析 URL 冲突保留原始证据并登记缺口',()=>{
  const result=deploymentAddress({url:'https://other.example.test/items',address:{host:'api.example.test'}},context);
  assert.equal(result.host,'api.example.test');assert.equal(result.resolvedUrl,null);assert.match(result.gaps[0],/冲突/);
});

test('分析结果贯通表格，保留原始 URL、参数、hook 阶段与上下文证据',async t=>{
  const root=await fixture(t,{'api.js':`import axios from 'axios';
fetch('/api/items?limit=2',{method:'POST',body:JSON.stringify({id:7})});
axios.get('items',{baseURL:'/gateway',params:{page:1}});
axios.get('https://api.example.test/items');
const client=axios.create();client.interceptors.request.use(config=>{config.url='/hook';return config;},null,{synchronous:true});client.get('/before');`});
  const report=await analyze(root,{modelRequestHooks:true});
  const before=JSON.stringify(report),rows=requestRows(report,{deploymentUrl:base});
  assert.equal(JSON.stringify(report),before,'导出不能改写原始静态证据');
  const fetch=rows.find(r=>r.url==='/api/items?limit=2');
  assert.equal(fetch.resolvedUrl,'https://console.example.test:8443/api/items?limit=2');assert.equal(fetch.body,'{"id":7}');
  assert.ok(fetch.parameterFields.some(f=>f.carrier==='query'&&f.path[0]==='limit'));assert.ok(!fetch.gaps.includes('Host 未解析'));
  const gateway=rows.find(r=>r.url==='/gateway/items');assert.equal(gateway.resolvedUrl,'https://console.example.test:8443/gateway/items');assert.equal(gateway.query.page,1);
  assert.equal(rows.find(r=>r.url==='https://api.example.test/items').hostBasis,'static-code');
  assert.ok(rows.some(r=>r.stage==='after-request-hooks'&&r.url==='/hook'&&r.hostState==='context-candidate'));
  assert.match(requestCsv(rows),/hostBasis/);assert.match(requestMarkdown(rows,{deploymentUrl:context}),/context-candidate/);
  assert.equal(requestRows(report).find(r=>r.url===fetch.url).host,null);
});

test('非法上下文在任何 clone/build 之前拒绝',async t=>{
  let called=false;
  await assert.rejects(runRepository('https://github.com/example/fixture',{profile:{deploymentUrl:'https://secret@example.test'},workDir:await fixture(t,{}),execute:async()=>{called=true;}}),/deploymentUrl/);
  assert.equal(called,false);
});
