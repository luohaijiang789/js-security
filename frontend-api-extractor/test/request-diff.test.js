import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareRequests,diffMarkdown} from '../src/request-diff.js';
import {verifyBaseline} from '../src/baseline.js';
import {runLogged} from '../src/repository-task.js';
import {fixture} from './helpers.js';
const root=fileURLToPath(new URL('../examples/request-baseline/',import.meta.url));
const row=(changes={})=>({sourceFile:'api.js',sourceLine:1,sourceColumn:1,stage:'call-site',conditions:[],callChain:[],method:'POST',host:'api.example.test',url:'https://api.example.test/items',query:null,body:{id:7},headers:null,parameterFields:[],resolution:'resolved',gaps:[],...changes});

test('固定手工语义基准一条命令可复跑，字段、调用快照与完整性匹配',async()=>{
  const result=await verifyBaseline(root);assert.equal(result.passed,true);assert.equal(result.diff.summary.unchanged,3);assert.equal(result.completeness.actual,true);
});

test('新增、丢失与同一位置方法/Host/参数变化分别报告，不依赖行 ID',()=>{
  const a=row(),b=row({sourceLine:2}),c=row({sourceLine:3});
  const diff=compareRequests([a,b],[row({id:'new-id',method:'PUT',body:{id:8}}),c]);
  assert.equal(diff.passed,false);assert.equal(diff.summary.changed,1);assert.equal(diff.summary.added,1);assert.equal(diff.summary.removed,1);assert.deepEqual(diff.changed[0].fields.map(f=>f.field),['method','body']);
  assert.match(diffMarkdown(diff),/changed/);
});

test('未知字段路径与未知 Host 单独列出，不把空载体算动态值',()=>{
  const diff=compareRequests([row()],[row({host:null,body:{id:{__unknown:'runtime'}},headers:null})]);
  assert.deepEqual(diff.changed[0].becameUnknown,[['host'],['body','id']]);assert.equal(diff.summary.becameUnknown,2);
  const removed=compareRequests([row()],[row({body:null})]);assert.equal(removed.summary.changed,1);assert.equal(removed.summary.becameUnknown,0);assert.equal(compareRequests([row()],[row({body:{}})]).summary.becameUnknown,0);
});

test('对象键与字段清单顺序不影响语义，但重复记录不能被 Set 吞掉',()=>{
  const a=row({body:{a:1,b:2},parameterFields:[{path:['a']},{path:['b']}]});
  assert.equal(compareRequests([a],[row({body:{b:2,a:1},parameterFields:[{path:['b']},{path:['a']}]})]).passed,true);
  assert.equal(compareRequests([a,a],[a]).summary.removed,1);
});

test('不同条件、hook 阶段、调用链不得任意连接',()=>{
  for(const delta of [{conditions:[{expression:'flag',outcome:true}]},{stage:'after-request-hooks'},{callChain:[{file:'entry.js',line:3,column:1,symbol:'send'}]}]){
    const diff=compareRequests([row()],[row(delta)]);assert.equal(diff.summary.changed,0);assert.equal(diff.summary.added,1);assert.equal(diff.summary.removed,1);
  }
});

test('同锚点多个变体先消去完全相同项，剩余歧义保留而非强行配对',()=>{
  const diff=compareRequests([row({body:{id:1}}),row({body:{id:2}})],[row({body:{id:3}}),row({body:{id:4}})]);
  assert.equal(diff.summary.ambiguous,1);assert.equal(diff.summary.changed,0);assert.equal(diff.passed,false);
  const single=compareRequests([row(),row({body:{id:2}})],[row(),row({body:{id:3}})]);assert.equal(single.summary.unchanged,1);assert.equal(single.summary.changed,1);
});

test('不同仓库/版本/部署上下文不可被相同 URL 掩盖',()=>{
  const diff=compareRequests({commit:'a',deploymentUrl:null,rows:[row({commit:'a'})]},{commit:'b',deploymentUrl:'https://app.test/',rows:[row({commit:'b'})]});
  assert.equal(diff.passed,false);assert.ok(diff.contextConflicts.some(c=>c.field==='commit'));assert.ok(diff.contextConflicts.some(c=>c.field==='rows.commit'));
});

test('预算中断、诊断与任务缺口变化不能被相同请求表掩盖，成本变化另列',()=>{
  const before={rows:[row()],stats:{complete:true,steps:10,partitions:[{file:'api.js',state:'finished'}]}};
  const after={rows:[row()],stats:{complete:false,steps:20,partitions:[{file:'api.js',state:'budget-exceeded',reason:'global-budget'}]},diagnostics:[{code:'BUDGET_EXCEEDED'}]};
  const diff=compareRequests(before,after);assert.equal(diff.passed,false);assert.equal(diff.summary.unchanged,1);assert.deepEqual(diff.analysisChanges.map(c=>c.field),['complete','partitions','diagnostics']);assert.equal(diff.cost.actualSteps,20);
  assert.equal(compareRequests(before,{...before,stats:{...before.stats,steps:11}}).passed,true);
});

test('坏输入拒绝，篡改脚本/预期或漏登记脚本不会成功跑基准',async t=>{
  assert.throws(()=>compareRequests({},[]),/rows/);assert.throws(()=>compareRequests([{}],[]),/源码/);
  const copy=await fixture(t,{});await fs.cp(root,copy,{recursive:true});await fs.appendFile(path.join(copy,'entry.js'),'\nfetch("/new")');await assert.rejects(verifyBaseline(copy),/哈希/);
  await fs.cp(root,copy,{recursive:true});await fs.writeFile(path.join(copy,'extra.js'),'fetch("/extra")');await assert.rejects(verifyBaseline(copy),/未登记/);
});

test('比较 CLI 输出机器/人读报告并区分差异和输入失败',async t=>{
  const directory=await fixture(t,{'before.json':JSON.stringify([row()]),'after.json':JSON.stringify([row({host:null})]),'bad.json':'{}'});
  const cli=fileURLToPath(new URL('../src/compare-cli.js',import.meta.url));
  const args=['--expected',path.join(directory,'before.json'),'--actual',path.join(directory,'after.json'),'--out',path.join(directory,'out/diff.json')];
  const different=await runLogged(process.execPath,[cli,...args]);assert.equal(different.code,1);assert.equal(JSON.parse(different.output).summary.becameUnknown,1);assert.match(await fs.readFile(path.join(directory,'out/diff.json.md'),'utf8'),/变未知/);
  const bad=await runLogged(process.execPath,[cli,'--expected',path.join(directory,'bad.json'),'--actual',path.join(directory,'after.json')]);assert.equal(bad.code,2);
});
