import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { analyzeBuild } from "../src/build-assets.js";
import { requestRows } from "../src/request-table.js";
import { fixture } from "./helpers.js";
const root = fileURLToPath(
  new URL("../examples/webpack-chunks/", import.meta.url),
);
for (const version of [4, 5])
  test(`真实Webpack${version}压缩分块、动态模块与参数传播，产物位置可独立核查`, async (t) => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    for (const file of manifest.files)
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(path.join(root, file.path)))
          .digest("hex"),
        file.sha256,
      );
    const result = await analyzeBuild(
      root,
      ["webpack" + version],
      await fixture(t, {}),
    );
    assert.equal(result.mode, "webpack-module-static");
    assert.equal(result.webpack.modules.length, 3);
    const rows = requestRows(
      result.report,
      { mode: result.mode },
      result.locations,
    );
    for (const expected of manifest.manualExpected) {
      const row = rows.find(
        (r) =>
          r.url === expected.url && r.body === JSON.stringify(expected.body),
      );
      assert.ok(row, JSON.stringify(rows));
      assert.equal(row.host, expected.host);
      assert.equal(row.method, "POST");
      assert.ok(row.generatedFile);
      const text = await fs.readFile(
        path.join(root, row.generatedFile),
        "utf8",
      );
      const sf = ts.createSourceFile(
        row.generatedFile,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const offset = sf.getPositionOfLineAndCharacter(
        row.generatedLine - 1,
        row.generatedColumn - 1,
      );
      assert.equal(text.slice(offset, offset + 5), "fetch");
    }
    assert.ok(result.gaps.some((g) => g.includes("inventory")));
    assert.ok(rows.some((r) => r.body?.__unknown));
  });
test("缺少异步chunk保留缺失模块缺口，不声称没有深层请求", async (t) => {
  const directory = await fixture(t, {});
  await fs.mkdir(path.join(directory, "build"));
  await fs.copyFile(
    path.join(root, "webpack5/main.js"),
    path.join(directory, "build/main.js"),
  );
  const r = await analyzeBuild(directory, ["build"], await fixture(t, {}));
  assert.ok(r.gaps.some((g) => g.includes("Missing async webpack module")));
  assert.ok(r.report.diagnostics.some((d) => d.code.includes("IMPORT")));
});
test("Webpack signature但未知模块表保持缺口，普通对象函数表不解包", async (t) => {
  const a = await fixture(t, {
    "build/main.js": 'const x="webpackChunk";fetch("/native")',
  });
  const r = await analyzeBuild(a, ["build"], await fixture(t, {}));
  assert.equal(r.mode, "artifact-static");
  assert.ok(r.gaps.some((g) => g.includes("no supported module table")));
  const b = await fixture(t, {
    "build/main.js": 'const callbacks={12:()=>fetch("/native")};',
  });
  const s = await analyzeBuild(b, ["build"], await fixture(t, {}));
  assert.equal(s.mode, "artifact-static");
  assert.equal(s.webpack, null);
});
test('Webpack4 interop getter.a/调用与__esModule条件保真，同名普通a不改写',async t=>{const dir=await fixture(t,{'build/main.js':`(window.webpackJsonp=window.webpackJsonp||[]).push([[0],{1:function(m,e,r){var a=r.n(r(2));fetch('https://site.test/'+a.a,{body:{value:a()}});var plain={a:'normal'};fetch('/'+plain.a);},2:function(m){m.exports={default:'not-the-default',name:'cjs'};}}]);`});const r=await analyzeBuild(dir,['build'],await fixture(t,{}));const rows=requestRows(r.report);assert.ok(rows.some(row=>row.url==='/normal'));const row=rows.find(row=>row.url==='https://site.test/{expression}');assert.ok(row);assert.deepEqual(row.body,{value:{default:'not-the-default',name:'cjs'}});});
test('Webpack interop ESM返回default，重绑定getter不沿用旧导出',async t=>{const dir=await fixture(t,{'build/main.js':`(window.webpackJsonp=window.webpackJsonp||[]).push([[0],{1:function(m,e,r){var a=r.n(r(2));fetch(a.a);var b=r.n(r(2));b=other;fetch(b.a);},2:function(m){m.exports={__esModule:true,default:'https://esm.test/api'};}}]);`});const r=await analyzeBuild(dir,['build'],await fixture(t,{}));const rows=requestRows(r.report);assert.ok(rows.some(row=>row.url==='https://esm.test/api'));assert.ok(rows.some(row=>row.url!=='https://esm.test/api'));});
test('vendor内普通回调数组/同名push不污染模块ID或制造冲突',async t=>{const dir=await fixture(t,{'build/main.js':`(self.webpackJsonp=self.webpackJsonp||[]).push([[0],[function(m){m.exports='https://zero.test'},function(m,e,r){unrelated([function(){},function(){}]);const data=[];data.push([[0],[function(m){m.exports='wrong'}]]);fetch(r(0))}]]);`});const r=await analyzeBuild(dir,['build'],await fixture(t,{}));assert.equal(r.webpack.modules.length,2);assert.ok(!r.gaps.some(g=>g.includes('ID conflict')));assert.ok(r.report.endpoints.some(e=>e.url==='https://zero.test'));});
test('库内部嵌套webpack数组ID属于另一runtime，不覆盖外层；复用输出不读旧模块',async t=>{const directory=await fixture(t,{'build/main.js':`(self.webpackJsonp=self.webpackJsonp||[]).push([[0],[function(m){m.exports='https://outer.test'},function(m,e,r){(function(modules){modules[0].call(null)})([function(m){m.exports='https://inner.test'}]);fetch(r(0))}]]);`});const output=await fixture(t,{});const a=await analyzeBuild(directory,['build'],output);assert.equal(a.webpack.modules.length,2);assert.ok(!a.gaps.some(g=>g.includes('ID conflict')));assert.ok(a.report.endpoints.some(e=>e.url==='https://outer.test'));await fs.writeFile(path.join(output,'webpack-modules','module-6f6c64.js'),`fetch('https://stale.test')`);const b=await analyzeBuild(directory,['build'],output);assert.ok(!b.report.endpoints.some(e=>e.url==='https://stale.test'));assert.equal(b.report.stats.files,2);});
test('未知factory参数不把无符号全局重命名为module，缺口明确',async t=>{const root=await fixture(t,{'build/app.js':`(self.webpackJsonp=self.webpackJsonp||[]).push([[0],{1:function(m,e,r){r(2)},2:function({fetch},e,r){fetch('/not-global')}}]);`});const r=await analyzeBuild(root,['build'],await fixture(t,{}));assert.ok(r.gaps.some(g=>g.includes('Unsupported webpack factory parameters')));assert.ok(!r.report.endpoints.some(e=>e.url==='/not-global'));});
test('构建JS超限在读入解析前拒绝，保留明确失败',async t=>{const root=await fixture(t,{'build/oversize.js':''});await fs.truncate(path.join(root,'build/oversize.js'),33*1024*1024);await assert.rejects(analyzeBuild(root,['build'],await fixture(t,{})),/字节预算超限/);});
