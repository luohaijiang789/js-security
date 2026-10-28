import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { importObservedScripts } from "../src/observed-scripts.js";
import { analyzeScriptPackage } from "../src/script-assets.js";
import { fixture } from "./helpers.js";
const asset = (url, content, extra = {}) => ({
  url,
  content,
  sha256: createHash("sha256").update(content).digest("hex"),
  scriptId: "1",
  tabId: 1,
  startLine: 0,
  startColumn: 0,
  context: {
    kind: "document",
    pageUrl: "https://page.test/",
    baseUrl: "https://page.test/base/",
  },
  ...extra,
});
test("浏览器源快照不重新获取URL，父链/深度未知保留，内联行列偏移回指HTML", async (t) => {
  const root = await fixture(t, {}),
    snapshot = {
      schemaVersion: 1,
      kind: "debugger-script-snapshot",
      pages: [
        { url: "https://page.test/", baseUrl: "https://page.test/base/" },
      ],
      assets: [
        asset("https://page.test/", `fetch('/api/items',{body:{id:7}})`, {
          startLine: 10,
          startColumn: 4,
        }),
      ],
      gaps: [],
    };
  const manifest = await importObservedScripts(snapshot, root);
  assert.equal(manifest.assets[0].fetchDepth, null);
  assert.equal(manifest.edges[0].depth, null);
  const r = await analyzeScriptPackage(root, manifest);
  assert.equal(r.rows[0].sourceLine, 11);
  assert.equal(r.rows[0].sourceColumn, 5);
  assert.equal(r.rows[0].host, "page.test");
  assert.equal(r.stats.complete, false);
});
test("相同URL不同源版本分开保存，哈希篡改拒绝且未知上下文不猜Host", async (t) => {
  const root = await fixture(t, {}),
    a = asset("https://cdn.test/a.js", `fetch('/a')`, {
      context: {
        kind: "unknown",
        pageUrl: "https://page.test/",
        baseUrl: null,
      },
    }),
    b = asset("https://cdn.test/a.js", `fetch('/b')`, { context: a.context });
  const snapshot = {
    schemaVersion: 1,
    kind: "debugger-script-snapshot",
    pages: [],
    assets: [a, b],
    gaps: [],
  };
  const m = await importObservedScripts(snapshot, root);
  assert.equal(m.assets.length, 2);
  const r = await analyzeScriptPackage(root, m);
  assert.ok(r.rows.every((row) => row.host === null));
  await assert.rejects(
    importObservedScripts(
      { ...snapshot, assets: [{ ...a, sha256: "bad" }] },
      root,
    ),
    /哈希/,
  );
});

test("相同代码保留不同内联偏移，共享脚本保留所有浏览器身份", async (t) => {
  const root = await fixture(t, {}),
    a = asset("https://page.test/", `fetch('/a')`, { startLine: 2 }),
    b = { ...a, startLine: 4 },
    c = { ...a, tabId: 2, scriptId: "2" };
  const m = await importObservedScripts(
    {
      schemaVersion: 1,
      kind: "debugger-script-snapshot",
      pages: [],
      assets: [a, b, c],
    },
    root,
  );
  assert.equal(m.assets.length, 2);
  assert.equal(m.assets[0].browserEvidence.length, 2);
  const r = await analyzeScriptPackage(root, m);
  assert.equal(new Set(r.rows.map((row) => row.sourceLine)).size, 2);
});
