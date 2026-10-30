// Actual extension test; respect managed policy and fail visibly when unavailable.
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
try {
  const policy = JSON.parse(
    await readFile("/etc/chromium/policies/managed/extensions.json", "utf8"),
  );
  if (policy.ExtensionInstallBlocklist?.includes("*")) {
    console.error(
      "未验收：当前 Chromium 企业策略禁止自定义扩展。未修改策略。请在允许扩展的目标 Chrome 执行此检查。",
    );
    process.exit(2);
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const output = path.resolve("../../work/website-plugin-mv3");
await mkdir(output, { recursive: true });
const traffic = [];
const site = createServer((req, res) => {
  traffic.push(req.url);
  if (req.url === "/main.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end("function uncalled(){return fetch('/api/not-called?limit=1');}");
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>受控 JS 页面</title><script src="/main.js"></script>',
    );
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const context = await chromium.launchPersistentContext(
  await mkdtemp(path.join(output, "profile-")),
  {
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${path.resolve("dist")}`,
      `--load-extension=${path.resolve("dist")}`,
    ],
  },
);
let service;
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  const target = await context.newPage();
  await target.goto(`http://127.0.0.1:${site.address().port}/`);
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/index.html`);
  const free = createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  service = spawn(
    process.env.PYTHON ??
      path.resolve("../../work/website-js-extractor-venv/bin/python"),
    [
      "-m",
      "website_js_extractor",
      "serve",
      "--extension-id",
      id,
      "--port",
      String(port),
      "--data-dir",
      path.join(output, "jobs"),
    ],
    { cwd: path.resolve("../.."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let startup = "";
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Service startup timed out")),
      10000,
    );
    service.stdout.on("data", (data) => {
      startup += String(data);
      const match = startup.match(/Pairing key: ([\w-]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    service.on("exit", () => reject(Error("Service exited before pairing")));
  });
  await ui.getByRole("button", { name: "新建采集任务" }).click();
  await ui.waitForFunction(
    async () => {
      const r = await chrome.runtime.sendMessage({ type: "state" });
      return r.tasks?.some((t) => t.assets > 0);
    },
    { timeout: 15000 },
  );
  await ui.getByRole("button", { name: "暂停", exact: true }).click();
  await ui.getByRole("button", { name: "生成固定快照" }).click();
  await ui.getByLabel("服务地址").fill(`http://127.0.0.1:${port}`);
  await ui.getByLabel("配对密钥").fill(String(token));
  await ui.getByRole("button", { name: "分析此快照" }).click();
  await ui
    .getByRole("cell", {
      name: `http://127.0.0.1:${site.address().port}/api/not-called?limit=1`,
      exact: true,
    })
    .waitFor({ timeout: 60000 });
  assert.equal(
    traffic.some((url) => url.startsWith("/api/")),
    false,
  );
  await ui.screenshot({
    path: path.join(output, "workbench.png"),
    fullPage: true,
  });
  await writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        extension_id: id,
        browser: context.browser()?.version(),
        traffic,
      },
      null,
      2,
    ),
  );
  console.log("Real MV3 + local analysis passed.");
} finally {
  if (service) {
    service.kill("SIGINT");
    await Promise.race([
      new Promise((r) => service.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (service.exitCode === null) service.kill("SIGKILL");
  }
  await context.close();
  await new Promise((r) => site.close(r));
}
