import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { fixture } from "./helpers.js";
test("普通类构造/字段/方法和工厂跨文件保留this参数", async (t) => {
  const root = await fixture(t, {
    "entry.js": `import {create} from './client.js';const a=create('https://a.test');const b=create('https://b.test');a.send(7);b.send(9);`,
    "client.js": `class Client{constructor(host){this.host=host}send(id){fetch(this.host+'/items',{method:'POST',body:{id}})}}export const create=host=>new Client(host);`,
  });
  const r = await analyze(root, { entries: ["entry.js"] });
  assert.deepEqual(
    r.endpoints.map((e) => [e.url, e.body.id]),
    [
      ["https://a.test/items", 7],
      ["https://b.test/items", 9],
    ],
  );
});
test("提取方法不伪造绑定this，继承类保持缺口", async (t) => {
  const root = await fixture(t, {
    "entry.js": `class A{host='https://a.test';send(){fetch(this.host)}}const a=new A();const run=a.send;run();class B extends A{};new B();`,
  });
  const r = await analyze(root);
  assert.ok(!r.endpoints.some((e) => e.url === "https://a.test"));
  assert.ok(r.diagnostics.some((d) => d.code === "THIS_BINDING_UNMODELED"));
  assert.ok(r.diagnostics.some((d) => d.code === "CLASS_MODEL_GAP"));
});
test("显式Angular服务/客户端映射连通工厂返回封装，保持改写Header", async (t) => {
  const root = await fixture(t, {
    "entry.js": `angular.module('web').factory('BaseHttp',['$http',function(http){return function(opt){opt.headers=opt.headers||{};if(!opt.headers['X-Requested-With'])opt.headers['X-Requested-With']='XMLHttpRequest';if(opt.url.indexOf('http')!==0)opt.url=Global.endpoint+opt.url;return http(opt)}}]);BaseHttp({url:'https://api.test/items',method:'POST',data:{id:7}});`,
  });
  const r = await analyze(root, {
    angularServices: ["BaseHttp"],
    clients: [{ name: "$http", kind: "axios" }],
  });
  const e = r.endpoints.find((e) => e.url === "https://api.test/items");
  assert.ok(e);
  assert.equal(e.body.id, 7);
  assert.equal(e.headers["X-Requested-With"], "XMLHttpRequest");
});
test("未显式声明DI不冒充自动推导，循环服务有诊断", async (t) => {
  const root = await fixture(t, {
    "entry.js": `angular.module('web').factory('A',['B',function(b){return b}]);angular.module('web').factory('B',['A',function(a){return a}]);A();`,
  });
  const r = await analyze(root, { angularServices: ["A", "B"] });
  assert.equal(r.endpoints.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === "ANGULAR_DI_UNRESOLVED"));
});
test("条件实例改写和未知外部副作用不能沿用旧Host，实例Body只包含自身字段", async (t) => {
  const root = await fixture(t, {
    "entry.js": `class C{host='https://old.test';change(){if(flag)this.host='https://new.test'}send(){fetch(this.host)}}const c=new C();c.change();c.send();class Payload{id=7}fetch('/payload',{body:new Payload()});`,
  });
  const r = await analyze(root);
  assert.ok(!r.endpoints.some((e) => e.url === "https://old.test"));
  const e = r.endpoints.find((e) => e.url === "/payload");
  assert.deepEqual(e.body, { id: 7 });
  assert.ok(
    !e.parameterFields.some(
      (f) => f.path[0] === "properties" || f.path[0] === "methods",
    ),
  );
});
