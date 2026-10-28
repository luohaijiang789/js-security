import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { fixture } from "./helpers.js";
const scan = async (t, code) => analyze(await fixture(t, { "api.js": code }));
test("URLSearchParams保留重复键顺序、编码与字段", async (t) => {
  const r = await scan(
    t,
    `const f=new URLSearchParams('tag=a&tag=b&q=hello+world');f.append('name','张 三');fetch('/x',{method:'POST',body:f})`,
  );
  const e = r.endpoints[0];
  assert.equal(e.body, "tag=a&tag=b&q=hello+world&name=%E5%BC%A0+%E4%B8%89");
  assert.equal(e.parameterFields.filter((f) => f.path[0] === "tag").length, 2);
});
test("表单set/delete与别名、发送快照和toString快照", async (t) => {
  const r = await scan(
    t,
    `const f=new URLSearchParams([['a','1'],['a','2'],['b','3']]);const alias=f;alias.set('a','4');alias.delete('b');const body=f.toString();f.append('a','5');fetch('/encoded',{body});fetch('/form',{body:f})`,
  );
  assert.equal(r.endpoints.find((e) => e.url === "/encoded").body, "a=4");
  assert.equal(r.endpoints.find((e) => e.url === "/form").body, "a=4&a=5");
});
test("FormData保留字段、重复项和未知文件值，不假造multipart边界", async (t) => {
  const r = await scan(
    t,
    `const f=new FormData();f.append('id','7');f.append('tag','a');f.append('tag','b');f.append('file',selectedFile,'x.txt');fetch('/upload',{method:'POST',body:f})`,
  );
  const e = r.endpoints[0];
  assert.equal(e.body.__multipart.length, 4);
  assert.ok(e.body.__multipart[3].value.__unknown);
  assert.equal(e.body.__multipart[3].filename, "x.txt");
  assert.ok(e.parameterFields.some((f) => f.path[0] === "file"));
});
test("动态表单键/DOM初始化保留未知结构，已知新增字段仍可读", async (t) => {
  const r = await scan(
    t,
    `const f=new FormData(formElement);f.append('id','7');f.append(runtimeKey,'value');fetch('/x',{body:f})`,
  );
  assert.ok(r.endpoints[0].body.__unknown);
  assert.ok(r.diagnostics.some((d) => d.code === "FORM_UNRESOLVED"));
  assert.ok(
    r.endpoints[0].parameterFields.some((f) => f.state === "unknown-spread"),
  );
});
test("局部同名构造器和普通append不误识别为表单", async (t) => {
  const r = await scan(
    t,
    `function URLSearchParams(x){return x}const f=new URLSearchParams({id:7});fetch('/x',{body:f})`,
  );
  assert.ok(r.endpoints[0].body.__unknown);
});
test("URLSearchParams对象输入/getAll/has可静态求值", async (t) => {
  const r = await scan(
    t,
    `const f=new URLSearchParams({a:1,b:'x'});f.append('a',2);fetch('/x',{body:{all:f.getAll('a'),has:f.has('b'),first:f.get('a')}})`,
  );
  assert.deepEqual(r.endpoints[0].body, {
    all: ["1", "2"],
    has: true,
    first: "1",
  });
});
