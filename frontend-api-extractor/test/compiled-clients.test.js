import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { compiledClientFingerprint } from "../src/compiled-clients.js";
import { unpackWebpack } from "../src/webpack-modules.js";
import { analyze } from "../src/analyzer.js";
import { requestRows } from "../src/request-table.js";
import { fixture } from "./helpers.js";
test("编译模块指纹只归一局部绑定和require槽位，API属性/常量及依赖槽位关联变化不匹配", () => {
  const a = `var lib=require('./module-31.js');function make(x){return lib.create(x)}module.exports=make;`,
    b = `var renamed=require('./module-9999.js');function another(y){return renamed.create(y)}module.exports=another;`;
  assert.equal(compiledClientFingerprint(a), compiledClientFingerprint(b));
  assert.equal(
    compiledClientFingerprint(a),
    compiledClientFingerprint(a + "\nexport {};"),
  );
  assert.notEqual(
    compiledClientFingerprint(a + "var extra=require('./module-32.js')"),
    compiledClientFingerprint(a + "var extra=require('./module-31.js')"),
  );
  for (const changed of [
    b.replace(".create(", ".other("),
    b.replace("return renamed.create(y)", 'return "other"'),
    b + ';module.exports.url="/fake"',
  ])
    assert.notEqual(
      compiledClientFingerprint(a),
      compiledClientFingerprint(changed),
    );
  assert.notEqual(
    compiledClientFingerprint("const x=7;module.exports={x};"),
    compiledClientFingerprint("const y=7;module.exports={y};"),
  );
});
test("自写契约精确命中后互操作链恢复请求，行列仍指向原始压缩JS；篡改则拒绝", async (t) => {
  const root = await fixture(t, {
      "build/app.js": `(self.webpackJsonp=self.webpackJsonp||[]).push([[0],{1:function(m,e,r){var a=r(7),b=r.n(a);b.a.post('https://api.test/items',{id:7});},7:function(m){m.exports={post:function(v){return v}};}}]);`,
    }),
    assets = [{ file: "build/app.js" }];
  const probe = await unpackWebpack(root, assets, await fixture(t, {}), []),
    file = probe.moduleAssets.find((m) => m.moduleId === "7").file,
    code = await fs.readFile(path.join(probe.root, file), "utf8");
  const contract = {
    id: "authored-test-contract",
    kind: "axios",
    module: "axios",
    version: "0.0.0-test",
    signatureSha256: compiledClientFingerprint(code),
  };
  const result = await unpackWebpack(root, assets, await fixture(t, {}), [
    contract,
  ]);
  assert.equal(result.clientModels.length, 1);
  const report = await analyze(result.root, {
    compiledClients: result.clientModels,
  });
  const rows = requestRows(
    report,
    { mode: "webpack-module-static" },
    result.locations,
  );
  const row = rows.find((r) => r.url === "https://api.test/items");
  assert.ok(row);
  assert.equal(row.method, "POST");
  assert.deepEqual(row.body, { id: 7 });
  assert.equal(row.resolution, "partial");
  assert.equal(row.clientModel.id, "authored-test-contract");
  assert.ok(row.gaps.some((g) => g.includes("facade")));
  assert.equal(row.generatedFile, "build/app.js");
  const raw = await fs.readFile(path.join(root, row.generatedFile), "utf8");
  assert.equal(
    raw.slice(row.generatedColumn - 1, row.generatedColumn + 7),
    "b.a.post",
  );
  await fs.appendFile(
    path.join(result.root, file),
    "\n// different source bytes\n",
  );
  const changed = await analyze(result.root, {
    compiledClients: result.clientModels,
  });
  assert.ok(
    changed.diagnostics.some((d) => d.code === "COMPILED_CLIENT_HASH_MISMATCH"),
  );
  assert.ok(!changed.endpoints.some((e) => e.url === "https://api.test/items"));
});
test("没有固定契约时普通模块的post与axios字样不自动成为HTTP", async (t) => {
  const root = await fixture(t, {
    "build/app.js": `(self.webpackJsonp=self.webpackJsonp||[]).push([[0],{1:function(m,e,r){var client=r(7);client.post('/fake')},7:function(m){m.exports={Axios:'axios',CancelToken:'axios',isAxiosError:true,post:function(v){return v}};}}]);`,
  });
  const out = await unpackWebpack(
    root,
    [{ file: "build/app.js" }],
    await fixture(t, {}),
  );
  assert.equal(out.clientModels.length, 0);
  assert.equal((await analyze(out.root)).endpoints.length, 0);
});
test("解包模块拥有独立作用域，同名局部d不能被另一个模块函数覆盖", async (t) => {
  const root = await fixture(t, {
    "build/app.js": `(self.webpackJsonp=self.webpackJsonp||[]).push([[0],{1:function(m,e,r){var d=r.n(r(7));d.a.post('https://isolated.test/items',{id:7})},7:function(m){m.exports={post:function(v){return v}}},8:function(m){function d(e,t,n){return n}m.exports=d}}]);`,
  });
  const probe = await unpackWebpack(
    root,
    [{ file: "build/app.js" }],
    await fixture(t, {}),
    [],
  );
  const file = probe.moduleAssets.find((a) => a.moduleId === "7").file;
  const signatureSha256 = compiledClientFingerprint(
    await fs.readFile(path.join(probe.root, file), "utf8"),
  );
  const r = await unpackWebpack(
    root,
    [{ file: "build/app.js" }],
    await fixture(t, {}),
    [
      {
        id: "scope-test",
        module: "axios",
        kind: "axios",
        version: "test",
        signatureSha256,
      },
    ],
  );
  const report = await analyze(r.root, { compiledClients: r.clientModels });
  assert.ok(
    report.endpoints.some(
      (e) => e.url === "https://isolated.test/items" && e.body.id === 7,
    ),
  );
});
