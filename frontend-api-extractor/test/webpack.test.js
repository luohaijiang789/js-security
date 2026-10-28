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
