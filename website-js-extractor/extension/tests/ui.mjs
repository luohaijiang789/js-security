// Real Chromium UI with a substituted extension API; this is NOT MV3 acceptance.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("dist"),
  output = path.resolve("../../work/website-plugin-ui");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = path.resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!name.startsWith(root + path.sep) && name !== root) throw Error("path");
    const target =
      name === root || name === root + path.sep
        ? path.join(root, "index.html")
        : name;
    res.setHeader(
      "Content-Type",
      target.endsWith(".js")
        ? "text/javascript"
        : target.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(target));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  failures = [];
page.on("pageerror", (e) => failures.push(String(e)));
try {
  await page.addInitScript(() => {
    const task = {
      id: "ui-task",
      phase: "collecting",
      started_at: "2026-10-30T00:00:00Z",
      assets: 1,
      bytes: 32,
      gaps: [{ kind: "scope", message: "未加载脚本不保证覆盖" }],
      omitted_gaps: 0,
      tabs: [1],
    };
    const saved = {};
    globalThis.chrome = {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sendMessage: async (m) => {
          if (m.type === "state")
            return { ok: true, tasks: [task], active_id: task.id };
          if (m.type === "pause") {
            task.phase = "paused";
            return { ok: true };
          }
          if (m.type === "resume") {
            task.phase = "collecting";
            return { ok: true };
          }
          if (m.type === "stop") {
            task.phase = "stopped";
            return { ok: true };
          }
          if (m.type === "freeze")
            return {
              ok: true,
              snapshot: {
                schema_version: "capture-0.1",
                snapshot_id: "ui-snapshot",
                task_id: task.id,
                assets: [{ content: "fetch('/api');" }],
                gaps: [],
              },
            };
          if (m.type === "start") return { ok: true, id: task.id };
          return { ok: false, error: "unknown" };
        },
      },
      storage: {
        local: {
          get: async () => saved,
          set: async (value) => Object.assign(saved, value),
        },
      },
    };
    globalThis.__saved = saved;
  });
  await page.route("http://127.0.0.1:8378/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const value = path.endsWith("capabilities")
      ? { protocol: "capture-0.1", result_schema: "0.5", offline_only: true }
      : path.endsWith("result")
        ? {
            candidates: [
              {
                id: "candidate",
                method: "GET",
                url: "https://site.test/api",
                host: "https://site.test",
                asset_id: "asset",
                parameters: [
                  { carrier: "Query", path: "limit", expression: "10" },
                ],
              },
            ],
            assets: [{ id: "asset", url: "https://cdn.test/main.js" }],
            gaps: [{ id: "gap", message: "精确位置未知", incomplete: false }],
          }
        : { id: "f".repeat(32), status: "partial" };
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page
    .getByRole("heading", { name: "收集脚本，查看 API 线索" })
    .waitFor();
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const r = indexedDB.open("website-js-extractor", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("tasks", { keyPath: "id" });
        const a = r.result.createObjectStore("assets", { keyPath: "id" });
        a.createIndex("task", "task_id");
        r.result.createObjectStore("snapshots", { keyPath: "snapshot_id" });
      };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const t = db.transaction("assets", "readwrite");
        t.objectStore("assets").put({
          id: "observed-source",
          task_id: "ui-task",
          url: "https://cdn.test/main.js",
          capture_url: "https://cdn.test/main.js",
          location: "main.js",
          sha256: "a".repeat(64),
          bytes: 32,
          content: "function uncalled(){return fetch('/api');}",
          context_key: "frame",
          context: {
            type: "page",
            page_url: "https://site.test/",
            request_base_url: "https://site.test/",
            evidence: "test",
          },
        });
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
    });
  });
  await page.getByRole("button", { name: "查看 / 刷新脚本" }).click();
  await page
    .getByRole("cell", { name: "https://cdn.test/main.js", exact: true })
    .click();
  await page
    .locator("aside pre")
    .filter({ hasText: "function uncalled()" })
    .waitFor();
  await page.getByRole("button", { name: "关闭源码" }).click();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByRole("button", { name: "生成固定快照" }).click();
  await page.getByLabel("配对密钥").fill("test-only-key");
  await page.getByRole("button", { name: "分析此快照" }).click();
  await page
    .getByRole("cell", { name: "https://site.test/api", exact: true })
    .waitFor();
  await page
    .getByRole("cell", { name: "https://site.test/api", exact: true })
    .click();
  await page.getByRole("heading", { name: "请求参数" }).waitFor();
  assert.equal(await page.locator("aside").isVisible(), true);
  assert.equal(
    (await page.evaluate(() => JSON.stringify(globalThis.__saved))).includes(
      "test-only-key",
    ),
    false,
  );
  await page.screenshot({
    path: path.join(output, "workbench.png"),
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  await writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        browser: browser.version(),
        scope:
          "real Chromium UI with substituted chrome API and service responses, not MV3 acceptance",
      },
      null,
      2,
    ),
  );
  console.log("Workbench UI passed; MV3 permissions/CDP not covered.");
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
