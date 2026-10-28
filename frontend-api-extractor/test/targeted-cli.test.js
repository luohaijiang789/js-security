import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const run = promisify(execFile),
  cli = fileURLToPath(new URL("../tools/verify-targeted.mjs", import.meta.url));
test("定向CLI校验固定源码后只分析指定文件，交付可追溯且不执行目标", async (t) => {
  const code = `fetch('https://api.test/items',{method:'POST',body:{id:7}});require('node:fs').writeFileSync('MUST_NOT_RUN','x');`,
    root = await fixture(t, {
      "api.js": code,
      "extra.js": `fetch('https://extra.test')`,
    }),
    manifest = {
      schemaVersion: 1,
      kind: "targeted-source-wrapper",
      files: [
        {
          path: "api.js",
          sha256: createHash("sha256").update(code).digest("hex"),
        },
      ],
      config: { entries: ["api.js"] },
      expected: [
        {
          sourceFile: "api.js",
          sourceLine: 1,
          sourceColumn: 1,
          method: "POST",
          url: "https://api.test/items",
          host: "api.test",
          fields: { body: ["id"] },
        },
      ],
    };
  const file = path.join(root, "manifest.json"),
    out = path.join(root, "out");
  await fs.writeFile(file, JSON.stringify(manifest));
  const r = await run(
    process.execPath,
    [cli, "--manifest", file, "--source-root", root, "--out", out],
    { cwd: root },
  );
  assert.equal(JSON.parse(r.stdout).validationPassed, true);
  const d = JSON.parse(
    await fs.readFile(path.join(out, "analysis.json"), "utf8"),
  );
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].url, "https://api.test/items");
  await assert.rejects(fs.stat(path.join(root, "MUST_NOT_RUN")));
  assert.ok((await fs.stat(path.join(out, "api_assets.xlsx"))).size > 100);
});
test("定向CLI哈希/目录越界失败，不生成伪成功交付", async (t) => {
  const root = await fixture(t, { "api.js": 'fetch("/a")' }),
    file = path.join(root, "manifest.json");
  for (const spec of [
    { path: "api.js", sha256: "bad" },
    { path: "../api.js", sha256: "bad" },
  ]) {
    await fs.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        kind: "targeted-source-wrapper",
        files: [spec],
        expected: [{}],
      }),
    );
    await assert.rejects(
      run(process.execPath, [
        cli,
        "--manifest",
        file,
        "--source-root",
        root,
        "--out",
        path.join(root, "out"),
      ]),
      (e) => e.code === 2,
    );
    await assert.rejects(fs.stat(path.join(root, "out", "analysis.json")));
  }
});
