import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAnalyzerServer } from "../src/analyzer-server.js";
import { fixture } from "./helpers.js";
test("本地服务Origin/令牌/主机范围隔离，异步任务实际产出统一JSON和XLSX", async (t) => {
  const root = await fixture(t, {}),
    origin = "chrome-extension://" + "a".repeat(32),
    token = "local-test-token-at-least-16";
  const server = createAnalyzerServer({
    origin,
    token,
    allowedHosts: ["site.test"],
    workDir: root,
    collectorOptions: {
      fetcher: async (url) => ({
        finalUrl: url,
        originalUrl: url,
        redirects: [],
        contentType: "text/html",
        text: '<script>fetch("/api/items",{method:"POST",body:{id:7}})</script>',
        bytes: 72,
      }),
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(url + "/jobs", { method: "POST" })).status, 403);
  assert.equal(
    (
      await fetch(url + "/jobs", {
        method: "POST",
        headers: { Origin: origin },
      })
    ).status,
    401,
  );
  const headers = {
    Origin: origin,
    "X-Analyzer-Token": token,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(url + "/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({ pageUrl: "https://other.test/" }),
      })
    ).status,
    403,
  );
  const response = await fetch(url + "/jobs", {
    method: "POST",
    headers,
    body: JSON.stringify({ pageUrl: "https://site.test/", maxDepth: 3 }),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(url + "/jobs/" + job.id, { headers })).json();
    if (state.state !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.state, "completed", JSON.stringify(state));
  const document = await (
    await fetch(url + "/jobs/" + job.id + "/artifacts/analysis.json", {
      headers,
    })
  ).json();
  assert.equal(document.records[0].sourceKind, "website-js-static");
  assert.equal(document.records[0].host, "site.test");
  assert.ok(
    (await fs.stat(path.join(root, job.id, "api_assets.xlsx"))).size > 100,
  );
  assert.equal(
    (
      await fetch(url + "/jobs/" + job.id + "/artifacts/../../other", {
        headers,
      })
    ).status,
    404,
  );
});
test("浏览器脚本快照经真实/packages服务入口生成表格，不重新GET站点", async (t) => {
  const { createHash } = await import("node:crypto");
  const root = await fixture(t, {}),
    origin = "chrome-extension://" + "b".repeat(32),
    token = "package-route-test-token";
  let fetches = 0;
  const server = createAnalyzerServer({
    origin,
    token,
    allowedHosts: ["site.test"],
    workDir: root,
    collectorOptions: {
      fetcher: async () => {
        fetches++;
        throw Error("unexpected fetch");
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port,
    headers = {
      Origin: origin,
      "X-Analyzer-Token": token,
      "Content-Type": "application/json",
    },
    content = `fetch('/from-loaded',{method:'POST',body:{accountId:7}})`;
  const snapshot = {
    schemaVersion: 1,
    kind: "debugger-script-snapshot",
    pages: [{ url: "https://site.test/", baseUrl: "https://site.test/" }],
    assets: [
      {
        url: "https://cdn.test/main.js",
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
        context: {
          kind: "document",
          pageUrl: "https://site.test/",
          baseUrl: "https://site.test/",
        },
      },
    ],
  };
  const accepted = await fetch(base + "/packages", {
    method: "POST",
    headers,
    body: JSON.stringify({ snapshot }),
  });
  assert.equal(accepted.status, 202);
  const { id } = await accepted.json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + "/jobs/" + id, { headers })).json();
    if (state.state !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.state, "completed", JSON.stringify(state));
  assert.equal(fetches, 0);
  const d = await (
    await fetch(base + "/jobs/" + id + "/artifacts/analysis.json", { headers })
  ).json();
  assert.equal(d.records[0].host, "site.test");
  assert.equal(d.records[0].sourceKind, "website-js-static");
  assert.equal(d.scope.complete, false);
  assert.ok(d.parameters.some((f) => f.path[0] === "accountId"));
});
