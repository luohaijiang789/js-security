import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, writeFile, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
try {
  const policy = JSON.parse(
    await readFile("/etc/chromium/policies/managed/extensions.json", "utf8"),
  );
  if (policy.ExtensionInstallBlocklist?.includes("*"))
    throw Error(
      "当前 Chromium 企业策略禁止加载自定义扩展；请在允许扩展的 Chrome 上运行 test:extension。未修改企业策略。",
    );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const received = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({
    url: req.url,
    method: req.method,
    body: Buffer.concat(chunks).toString(),
  });
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/redirected" });
    res.end();
    return;
  }
  if (req.url === "/slow") {
    setTimeout(() => {
      res.end("slow");
    }, 8000);
    return;
  }
  if (req.url === "/worker.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end("fetch('/worker-request');");
    return;
  }
  if (req.url === "/frame") {
    res.setHeader("Content-Type", "text/html");
    res.end("<script>fetch('/iframe-request')</script>");
    return;
  }
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>受控采集页面</title><h1>JS 请求采集受控样例</h1>",
    );
    return;
  }
  res.setHeader(
    "Content-Type",
    req.url?.includes("json") ? "application/json" : "text/plain",
  );
  if (req.method === "OPTIONS") res.statusCode = 204;
  res.end(req.url?.includes("json") ? "{}" : "ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir("work/browser", { recursive: true });
const context = await chromium.launchPersistentContext(
  await mkdtemp(path.resolve("work/browser/profile-")),
  {
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${path.resolve("dist")}`,
      `--load-extension=${path.resolve("dist")}`,
    ],
    acceptDownloads: true,
  },
);
const failures = [];
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const target = await context.newPage();
  await target.goto(origin);
  const unselected = await context.newPage();
  await unselected.goto(origin + "/?unselected");
  const ui = await context.newPage();
  ui.on("pageerror", (e) => failures.push(String(e)));
  await ui.goto(`chrome-extension://${id}/index.html`);
  await ui.getByRole("heading", { name: "请求工作台", exact: true }).waitFor();
  const rpc = (type, data = {}) =>
    ui.evaluate(
      async ({ type, data }) => {
        const r = await chrome.runtime.sendMessage({ type, ...data });
        if (!r.ok) throw Error(r.error);
        return r.result;
      },
      { type, data },
    );
  const tabId = await ui.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    target.url(),
  );
  const config = {
    filter: {},
    retention: "matching",
    merge: "normalized",
    dynamic_query: ["ts"],
    dynamic_json: [],
    uuid_path: false,
    same_initiator: false,
    body_limit: 1024,
    queue_count: 2000,
    queue_bytes: 16777216,
    stop_wait_ms: 250,
    storage_limit: 524288000,
    archive: {
      enabled: true,
      interval_ms: 300000,
      bytes: 20971520,
      count: 10000,
    },
    service: { enabled: false, url: "", batch_size: 200 },
    retention_days: 7,
  };
  const scan = await rpc("start", {
    name: "Chromium 受控集成验收",
    tabs: [tabId],
    config,
  });
  assert.equal(scan.state, "recording");
  await target.evaluate(async () => {
    await fetch("/json?x=1&x=2&token=secret-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-header",
      },
      body: JSON.stringify({
        item: "book",
        token: "secret-body",
        nested: { password: "secret-pass" },
      }),
    });
    await fetch("/head", { method: "HEAD" });
    await fetch("/options", { method: "OPTIONS" });
    await fetch("/graphql");
    await fetch("/assets.json");
    await fetch("/redirect");
    await Promise.all([fetch("/same?ts=1"), fetch("/same?ts=2")]);
    navigator.sendBeacon("/beacon", "plain-sensitive-value");
    const img = new Image();
    img.src = "/pixel.png";
    document.body.append(img);
    const frame = document.createElement("iframe");
    frame.src = "/frame";
    document.body.append(frame);
    new Worker("/worker.js");
    await fetch("/large", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2000) }),
    });
  });
  await unselected.evaluate(() => fetch("/UNAUTHORIZED"));
  await new Promise((r) => setTimeout(r, 1500));
  await rpc("pause", { id: scan.id });
  await target.evaluate(() => fetch("/PAUSED"));
  await rpc("resume", { id: scan.id });
  await target.evaluate(() => {
    void fetch("/slow");
  });
  await ui.getByRole("button", { name: "查看在途请求", exact: true }).click();
  await ui.getByRole("button", { name: "/slow", exact: true }).click();
  const pendingDetail = ui.getByTestId("request-detail");
  await pendingDetail
    .getByRole("tab", { name: "原始数据", exact: true })
    .click();
  assert.equal(
    JSON.parse(await pendingDetail.locator("pre").textContent()).request_state,
    "pending",
  );
  await rpc("stop", { id: scan.id });
  const data = await ui.evaluate(async (scanId) => {
    const d = await new Promise((resolve, reject) => {
      const r = indexedDB.open("js-security-recorder", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const read = (store) =>
      new Promise((resolve, reject) => {
        const r = d.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    return {
      scan: (await read("scans")).find((s) => s.id === scanId),
      records: await read("requests"),
      groups: await read("groups"),
      batches: await read("batches"),
      errors: await read("errors"),
    };
  }, scan.id);
  const paths = data.records.map((r) => new URL(r.request_url).pathname);
  for (const p of [
    "/json",
    "/head",
    "/options",
    "/graphql",
    "/assets.json",
    "/redirect",
    "/redirected",
    "/same",
    "/beacon",
    "/pixel.png",
    "/iframe-request",
    "/worker-request",
    "/large",
    "/slow",
  ])
    assert(paths.includes(p), `missing ${p}`);
  assert(!paths.includes("/UNAUTHORIZED"));
  assert(!paths.includes("/PAUSED"));
  assert.equal(data.scan.state, "ended");
  assert.equal(data.scan.stats.pending, 0);
  assert.equal(data.scan.stats.persisted, data.records.length);
  const post = data.records.find(
    (r) => new URL(r.request_url).pathname === "/json",
  );
  assert.deepEqual(
    post.query_params.filter((p) => p.name === "x").map((p) => p.value),
    ["1", "2"],
  );
  for (const value of [
    "secret-query",
    "secret-header",
    "secret-body",
    "secret-pass",
    "plain-sensitive-value",
  ])
    assert(!JSON.stringify(data).includes(value), `privacy leak ${value}`);
  assert.equal(
    data.records.find((r) => r.pathname === "/large").capture_status.body.state,
    "partial",
  );
  assert.equal(
    data.records.find((r) => r.pathname === "/slow").request_state,
    "incomplete",
  );
  assert(
    data.groups.some(
      (g) => g.count === 2 && g.normalized_url.includes("/same?"),
    ),
  );
  assert.equal(
    new Set(data.records.map((r) => r.request_id)).size,
    data.records.length,
  );
  assert(
    data.records.find((r) => r.pathname === "/redirected").redirect_hop === 1,
  );
  // Inspect real persisted observations through the same page a user operates.
  await ui.getByLabel("当前任务").selectOption(scan.id);
  await ui.getByRole("button", { name: "原始", exact: true }).click();
  await ui.getByRole("button", { name: "/json", exact: true }).click();
  const detail = ui.getByTestId("request-detail");
  await detail.waitFor();
  const heading = await detail
    .getByRole("heading", { name: "请求详情", exact: true })
    .boundingBox();
  assert(
    heading && heading.y >= 0 && heading.y < ui.viewportSize().height,
    "request detail must be visible immediately",
  );
  await detail.getByRole("tab", { name: /^参数/ }).click();
  assert.equal(await detail.locator(".key-value tbody tr").count(), 3);
  await detail.getByRole("tab", { name: "原始数据", exact: true }).click();
  assert.equal(
    JSON.parse(await detail.locator("pre").textContent()).request_id,
    post.request_id,
  );
  const downloading = ui.waitForEvent("download");
  await ui.getByRole("button", { name: "导出数据", exact: true }).click();
  await ui.getByRole("button", { name: /^完整任务 ZIP/ }).click();
  const download = await downloading;
  await download.saveAs("work/browser/task.zip");
  await ui.screenshot({ path: "work/browser/ui.png", fullPage: true });
  assert.deepEqual(failures, []);
  await writeFile(
    "work/browser/result.json",
    JSON.stringify(
      {
        chrome: context.browser()?.version(),
        records: data.records.length,
        groups: data.groups.length,
        paths,
        stats: data.scan.stats,
        errors: data.errors,
        batches: data.batches,
        received: received.length,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        chrome: context.browser()?.version(),
        records: data.records.length,
        groups: data.groups.length,
        paths,
        stats: data.scan.stats,
        uiErrors: failures,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await new Promise((r) => server.close(r));
}
