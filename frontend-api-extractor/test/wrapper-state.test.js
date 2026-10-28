import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { fixture } from "./helpers.js";
test("多文件apply传递this及rest数组，经pop/reduce恢复URL与字段", async (t) => {
  const root = await fixture(t, {
    "entry.js": `import {request} from './request.js';request.call({host:'https://api.test'},'/items',7);`,
    "request.js": `export function request(...all){const middleware=[];middleware.push(config=>config);const args=all.slice();const id=args.pop();const url=args.shift();const body=[{url:this.host+url,data:{id}},middleware];return send.apply(this,body)}function send(config,middleware){return middleware.reduce((c,f)=>f(c),config)&&fetch(config.url,{method:'POST',body:config.data})}`,
  });
  const r = await analyze(root, { entries: ["entry.js"] });
  assert.ok(
    r.endpoints.some(
      (e) => e.url === "https://api.test/items" && e.body.id === 7,
    ),
  );
});
test("call this不同对象不串值，箭头保留词法this，null不猜全局", async (t) => {
  const root = await fixture(t, {
    "entry.js": `function send(id){fetch(this.host,{body:{id}})}send.call({host:'https://a.test'},1);send.apply({host:'https://b.test'},[2]);const arrow=()=>fetch(this.host);arrow.call({host:'https://wrong.test'});send.call(null,3);`,
  });
  const r = await analyze(root);
  assert.ok(
    r.endpoints.some((e) => e.url === "https://a.test" && e.body.id === 1),
  );
  assert.ok(
    r.endpoints.some((e) => e.url === "https://b.test" && e.body.id === 2),
  );
  assert.ok(!r.endpoints.some((e) => e.url === "https://wrong.test"));
});
test("数组别名变更保留快照，超限不继续沿用旧元素和长度", async (t) => {
  const root = await fixture(t, {
    "entry.js": `const a=['/first'];const b=a;fetch(a[0]);b.unshift('/second');fetch(a[0]);a.push('/overflow');fetch(a[0],{body:{n:a.length}});`,
  });
  const r = await analyze(root, { maxCandidates: 2 });
  assert.ok(r.endpoints.some((e) => e.url === "/first"));
  assert.ok(r.endpoints.some((e) => e.url === "/second"));
  assert.ok(r.diagnostics.some((d) => d.code === "ARRAY_OPERATION_UNMODELED"));
  assert.ok(r.endpoints.some((e) => e.resolution === "unresolved"));
});
test("条件数组变更不能沿用旧URL，未知slice索引不当零", async (t) => {
  const root = await fixture(t, {
    "entry.js": `const a=['https://old.test'];function change(){if(flag)a.push('x')}change();fetch(a[0]);const b=['/a','/b'].slice(runtimeIndex);fetch(b[0]);`,
  });
  const r = await analyze(root);
  assert.ok(!r.endpoints.some((e) => e.url === "https://old.test"));
  assert.ok(r.diagnostics.some((d) => d.code === "ARRAY_OPERATION_UNMODELED"));
});

test("新对象Object.assign的独立条件Header不抹掉确定URL、方法和Body", async (t) => {
  const root = await fixture(t, {
    "api.js": `import $ from 'jquery';const config={url:'https://api.test/items',type:'POST',data:{id:7}};$.ajax(Object.assign({},config,{headers:{token:runtimeToken||undefined}}));`,
  });
  const r = await analyze(root);
  assert.ok(
    r.endpoints.some(
      (e) =>
        e.url === "https://api.test/items" &&
        e.method === "POST" &&
        e.body.id === 7,
    ),
  );
  assert.ok(r.endpoints[0].usages.some((u) => u.conditions.length));
});

test("普通函数不继承调用者this，直接对象方法绑定且提取后丢失，箭头保留词法this", async (t) => {
  const root = await fixture(t, {
    "api.js": `function outer(){function inner(){fetch(this.host)}inner();[1].map(function(){fetch(this.host)});const arrow=()=>fetch(this.host);arrow();}outer.call({host:'https://outer.test'});const o={host:'https://method.test',send(){fetch(this.host)}};o.send();const extracted=o.send;extracted();`,
  });
  const r = await analyze(root);
  const direct = r.endpoints.find((e) => e.url === "https://method.test");
  assert.ok(direct);
  assert.ok(r.endpoints.some((e) => e.url === "https://outer.test"));
  const known = r.endpoints
    .filter((e) => e.url === "https://outer.test")
    .flatMap((e) => e.usages);
  assert.ok(known.every((u) => u.callChain.some((p) => p.symbol === "arrow")));
  assert.ok(r.endpoints.some((e) => e.resolution === "unresolved"));
});
test("显式调用与未调用函数/未知回调的库存分析分开保留依据", async (t) => {
  const root = await fixture(t, {
    "api.js": `function called(){fetch('/called')}called();function never(){fetch('/inventory')}external(()=>fetch('/callback'));`,
  });
  const r = await analyze(root);
  assert.equal(
    r.endpoints.find((e) => e.url === "/called").usages[0].linkState,
    "entry-trace",
  );
  assert.ok(
    r.endpoints
      .find((e) => e.url === "/inventory")
      .usages.every((u) => u.linkState === "function-inventory"),
  );
  assert.ok(
    r.endpoints
      .find((e) => e.url === "/callback")
      .usages.every((u) => u.linkState === "function-inventory"),
  );
});
test("CommonJS本地require绑定保留初始化，括号包裹导出可被跨函数再次解析", async (t) => {
  const root = await fixture(t, {
    "entry.js": `const client=require('./client.js');function send(id){client.post('https://api.test/alias',{id})}send(7);export {};`,
    "client.js": `(module.exports=require('axios'));export {};`,
  });
  const r = await analyze(root, { entries: ["entry.js"] });
  assert.ok(
    r.endpoints.some(
      (e) => e.url === "https://api.test/alias" && e.body.id === 7,
    ),
  );
});

test('数组自有push覆盖不走原生模型，未知方法不能沿用旧URL或Host',async t=>{const root=await fixture(t,{'api.js':`const a=['/old'];a.push=function(){this[0]='/rewritten'};a.push('/ignored');fetch(a[0]);const b=['https://must-not-survive.test'];b.push=runtimeHook;b.push();fetch(b[0]);const c={host:'https://also-not-survive.test',change:runtimeHook};c.change();fetch(c.host);`});const r=await analyze(root);assert.ok(r.endpoints.some(e=>e.url==='/rewritten'));assert.ok(!r.endpoints.some(e=>e.url.includes('survive.test')));assert.ok(r.diagnostics.some(d=>d.code==='UNKNOWN_CALL_EFFECTS'));});
test('数组自有map不会被内部清理/编码逻辑执行或导致崩溃',async t=>{const root=await fixture(t,{'api.js':`const a=[7];a.map=runtimeHook;fetch('/array',{body:a});a.map(()=>{});fetch('/after',{body:a})`});const r=await analyze(root);assert.deepEqual(r.endpoints.find(e=>e.url==='/array').body,[7]);assert.ok(r.endpoints.some(e=>e.url==='/after'&&e.resolution==='partial'));});
