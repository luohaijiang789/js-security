import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { fixture } from "./helpers.js";
const scan = async (t, code) => analyze(await fixture(t, { "api.js": code }));
test("jquery ajax GET params、POST body 和 type 别名", async (t) => {
  const r = await scan(
    t,
    `import $ from 'jquery'; $.ajax({url:'https://api.test/a',type:'POST',data:{id:7},headers:{token:'x'}});$.ajax('/b',{data:{q:'x'}});`,
  );
  assert.equal(r.endpoints.length, 2);
  assert.deepEqual(r.endpoints.find((e) => e.url === "/b").query, { q: "x" });
  const a = r.endpoints.find((e) => e.method === "POST");
  assert.deepEqual(a.body, { id: 7 });
  assert.equal(a.headers.token, "x");
});
test("jquery shorthand、命名导入、别名及 success 回调不进入data", async (t) => {
  const r = await scan(
    t,
    `import {get as load,post} from 'jquery';import jQuery from 'jquery';const j=jQuery;j.getJSON('/j',{id:1});load('/x',()=>{});post('/p',{id:2});j('selector');`,
  );
  assert.equal(r.endpoints.length, 3);
  assert.equal(r.endpoints.find((e) => e.url === "/x").query, null);
  assert.deepEqual(r.endpoints.find((e) => e.url === "/p").body, { id: 2 });
});
test("普通ajax/get和局部$不误报，未声明全局$不猜测", async (t) => {
  const r = await scan(
    t,
    `const $={ajax(x){return x}};$.ajax({url:'/wrong'});const x={get(v){return v}};x.get('/wrong');`,
  );
  assert.equal(r.endpoints.length, 0);
});
test("jquery ajaxSetup与beforeSend缺口不能被当完整配置", async (t) => {
  const r = await scan(
    t,
    `import $ from 'jquery';$.ajaxSetup({headers:{token:'x'}});$.ajax('/a');$.ajax({url:'/b',beforeSend:cb});`,
  );
  assert.ok(r.diagnostics.some((d) => d.code === "REQUEST_ADAPTER_GAP"));
  assert.ok(r.endpoints.every((e) => e.resolution !== "resolved"));
});
test("call/apply 在多文件封装中传播真实实参", async (t) => {
  const root = await fixture(t, {
    "entry.js": `import {send} from './send.js';send.call(null,'/one',7);send.apply(undefined,['/two',9]);`,
    "send.js": `export function send(url,id){fetch('https://api.test'+url,{method:'POST',body:{id}})}`,
  });
  const r = await analyze(root, { entries: ["entry.js"] });
  assert.deepEqual(
    r.endpoints.map((e) => [e.url, e.body.id]),
    [
      ["https://api.test/one", 7],
      ["https://api.test/two", 9],
    ],
  );
});
test("静态reduce连接中间件和发送函数，保持参数顺序", async (t) => {
  const r = await scan(
    t,
    `const send=(url,id)=>fetch(url,{method:'POST',body:{id}});const wrap=next=>(url,id)=>next(url,id);const request=[wrap,wrap].reduce((next,m)=>m(next),send);request('https://api.test/a',8);`,
  );
  assert.ok(
    r.endpoints.some((e) => e.url === "https://api.test/a" && e.body.id === 8),
  );
});
test("reduce无初值、空数组初值与实际数值顺序", async (t) => {
  const r = await scan(
    t,
    `const a=[1,2,3].reduce((n,v)=>n+v);const b=[].reduce((n,v)=>n+v,4);fetch('/a',{body:{a,b}})`,
  );
  assert.deepEqual(r.endpoints[0].body, { a: 6, b: 4 });
});
test("动态apply和依赖this的call有诊断，不制造具体请求", async (t) => {
  const r = await scan(
    t,
    `function send(x){fetch(x)}send.apply(null,runtimeArgs);function other(){fetch(this.url)}other.call({url:'/unproven'});`,
  );
  assert.ok(r.diagnostics.some((d) => d.code === "DYNAMIC_APPLY_ARGUMENTS"));
  assert.ok(r.diagnostics.some((d) => d.code === "THIS_BINDING_UNMODELED"));
  assert.ok(!r.endpoints.some((e) => e.url === "/unproven"));
});
