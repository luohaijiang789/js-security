import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { collectScripts, analyzeScriptPackage } from "../src/script-assets.js";
import { fixture } from "./helpers.js";
async function site(t) {
  const hits = [];
  const scripts = {
    "/page":
      '<base href="/console/"><script type="module" src="app.js"></script><script>fetch("/inline")</script><script type="application/ld+json">{"bad":"fetch"}</script>',
    "/console/app.js": `import {send} from './child.js';send(7);import('./deep.js');new Worker('/workers/task.js');fetch('/direct');`,
    "/console/child.js": `export function send(id){fetch('/api/items',{method:'POST',body:{id}})}`,
    "/console/deep.js": `import './level3.js';`,
    "/console/level3.js": `import './level4.js';fetch('/level3');`,
    "/console/level4.js": `fetch('/too-deep')`,
    "/workers/task.js": `import './worker-child.js';fetch('relative-api');`,
    "/workers/worker-child.js": `fetch('child-api');`,
    "/redirect": "redirect",
    "/bare":
      '<script type="module">import x from "unknown-package";fetch("/visible")</script>',
    "/map":
      '<script type="importmap">{"imports":{"helper":"/console/child.js"}}</script><script type="module">import {send} from "helper";send(3)</script>',
  };
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/page" });
      res.end();
      return;
    }
    if (!(req.url in scripts)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      ["/page", "/bare", "/map"].includes(req.url)
        ? "text/html"
        : "application/javascript",
    );
    res.end(scripts[req.url]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}
test("真实受控HTML/嵌套JS最多3层，保留父边和缺失，不调用代码中的API", async (t) => {
  const s = await site(t),
    root = await fixture(t, {}),
    m = await collectScripts(s.url + "/page", root);
  assert.ok(m.assets.some((a) => a.fetchDepth === 0));
  assert.ok(m.assets.some((a) => a.fetchDepth === 3));
  assert.ok(m.edges.some((e) => e.state === "depth-exceeded"));
  assert.ok(!s.hits.includes("/console/level4.js"));
  assert.ok(
    !s.hits.some(
      (p) => p.includes("api/") || p === "/direct" || p === "/inline",
    ),
  );
  assert.ok(m.assets.every((a) => a.sha256 && a.finalUrl));
  const r = await analyzeScriptPackage(root, m);
  const send = r.rows.find(
    (row) => row.url === "/api/items" && row.body.id === 7,
  );
  assert.ok(send);
  assert.equal(send.sourceKind, "website-js-static");
  assert.equal(send.host, "127.0.0.1:" + new URL(s.url).port);
  assert.ok(send.sourceFile.endsWith("/console/child.js"));
  assert.equal(send.hostState, "context-candidate");
  assert.equal(r.stats.complete, false);
});
test("Worker执行基址与文档基址分开，脚本URL不能被当作API Host", async (t) => {
  const s = await site(t),
    root = await fixture(t, {}),
    m = await collectScripts(s.url + "/page", root);
  const r = await analyzeScriptPackage(root, m);
  const worker = r.rows.find((row) => row.url === "relative-api");
  assert.equal(worker.resolvedUrl, s.url + "/workers/relative-api");
  assert.equal(worker.executionContext.kind, "worker");
});
test("构建模式只获取一层，重定向最终URL/原URL与哈希可回查", async (t) => {
  const s = await site(t),
    root = await fixture(t, {}),
    m = await collectScripts(s.url + "/redirect", root, { mode: "build" });
  assert.equal(m.page.originalUrl, s.url + "/redirect");
  assert.equal(m.page.finalUrl, s.url + "/page");
  assert.ok(m.assets.every((a) => a.fetchDepth <= 1));
  assert.ok(m.edges.some((e) => e.depth === 2 && e.state === "depth-exceeded"));
  await assert.rejects(
    collectScripts(s.url + "/page", root, { mode: "build", maxDepth: 2 }),
    /深度/,
  );
});
test("裸模块缺少importmap不乱猜URL，有显式importmap可以连通字段", async (t) => {
  const s = await site(t),
    root = await fixture(t, {}),
    m = await collectScripts(s.url + "/bare", root);
  assert.ok(m.edges.some((e) => e.state === "bare-module-unresolved"));
  assert.ok(!s.hits.some((p) => p.includes("unknown-package")));
  const other = await fixture(t, {}),
    mapped = await collectScripts(s.url + "/map", other),
    r = await analyzeScriptPackage(other, mapped);
  assert.ok(
    r.rows.some((row) => row.url === "/api/items" && row.body.id === 3),
  );
});
test("数量/字节预算与跨域范围失败明确记录，源包篡改/路径越界拒绝", async (t) => {
  const s = await site(t),
    root = await fixture(t, {}),
    m = await collectScripts(s.url + "/page", root, { maxAssets: 1 });
  assert.ok(m.edges.some((e) => e.state === "asset-budget"));
  const a = m.assets[0];
  await fs.appendFile(path.join(root, a.file), "extra");
  await assert.rejects(analyzeScriptPackage(root, m), /哈希/);
  const bad = { ...m, assets: [{ ...a, id: "../../outside" }] };
  await assert.rejects(analyzeScriptPackage(root, bad), /身份/);
  const tooSmall = await fixture(t, {});
  await assert.rejects(
    collectScripts(s.url + "/page", tooSmall, {
      maxFileBytes: 5,
      maxTotalBytes: 10,
    }),
    /字节/,
  );
});
test("不同执行上下文的全局符号隔离，CDN脚本不替代文档Host", async (t) => {
  const root = await fixture(t, {});
  const pages = {
    "https://page.test/console/index.html":
      '<script>function documentOnly(){fetch("/must-not-worker")}</script><script src="https://cdn.test/app.js"></script>',
    "https://cdn.test/app.js": `fetch('/api/items');new Worker('https://cdn.test/worker.js');`,
    "https://cdn.test/worker.js": `documentOnly();fetch('worker-api');`,
  };
  const m = await collectScripts("https://page.test/console/index.html", root, {
    allowedHosts: ["page.test", "cdn.test"],
    fetcher: async (url) => ({
      finalUrl: url,
      originalUrl: url,
      redirects: [],
      text: pages[url],
      bytes: Buffer.byteLength(pages[url]),
      contentType: url.endsWith(".html")
        ? "text/html"
        : "application/javascript",
    }),
  });
  const r = await analyzeScriptPackage(root, m);
  assert.equal(
    r.rows.find((row) => row.url === "/api/items").host,
    "page.test",
  );
  assert.equal(r.rows.find((row) => row.url === "worker-api").host, "cdn.test");
  assert.ok(
    !r.rows.some(
      (row) =>
        row.url === "/must-not-worker" &&
        row.executionContext.kind === "worker",
    ),
  );
  assert.ok(r.stats.steps <= 100000);
});
test("Webpack chunk URL只从已知ID和runtime映射恢复，不枚举ID", async (t) => {
  const root = await fixture(t, {}),
    hits = [];
  const responses = {
    "https://site.test/":
      '<script src="/main.js"></script><script src="/runtime.js"></script>',
    "https://site.test/main.js":
      "(self.webpackChunkdemo=self.webpackChunkdemo||[]).push([[0],{1:(m,e,r)=>{r.e(7).then(r.bind(r,7));}}]);",
    "https://site.test/runtime.js":
      'var r={};r.p="/chunks/";r.u=id=>id+"."+{7:"hash"}[id]+".js";self.webpackChunkdemo=self.webpackChunkdemo||[];',
    "https://site.test/chunks/7.hash.js":
      '(self.webpackChunkdemo=self.webpackChunkdemo||[]).push([[7],{7:()=>{fetch("/deep-api")}}]);',
  };
  const manifest = await collectScripts("https://site.test/", root, {
    fetcher: async (url) => {
      hits.push(url);
      return {
        finalUrl: url,
        originalUrl: url,
        redirects: [],
        contentType:
          url === "https://site.test/" ? "text/html" : "application/javascript",
        text: responses[url],
        bytes: Buffer.byteLength(responses[url]),
      };
    },
  });
  assert.ok(hits.includes("https://site.test/chunks/7.hash.js"));
  assert.ok(!hits.some((url) => url.includes("undefined")));
  assert.ok(
    manifest.edges.some(
      (e) =>
        e.reference.kind === "webpack-chunk" && e.reference.chunkId === "7",
    ),
  );
  const report = await analyzeScriptPackage(root, manifest);
  const row = report.rows.find((r) => r.url === "/deep-api");
  assert.ok(row);
  assert.equal(row.discoveryBasis, "website-webpack-module-static");
  assert.equal(row.host, "site.test");
  assert.ok(row.generatedFile.endsWith("/chunks/7.hash.js"));
});
