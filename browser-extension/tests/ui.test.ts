import { afterAll, beforeAll, it, expect } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview } from "vite";
import { mkdir } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { workspaceFixture } from "./fixtures";
import { matchFilter } from "../src/filter";

// Real rendering and IndexedDB; privileged extension APIs are replaced. This
// suite is not evidence of MV3 installation or debugger/worker coverage.
let server: Awaited<ReturnType<typeof preview>>,
  browser: Browser,
  origin: string;
beforeAll(async () => {
  server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
  origin = `http://127.0.0.1:${(server.httpServer.address() as any).port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  await mkdir("work/redesign", { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((r) => server.httpServer.close(() => r()));
});

async function openWorkspace(options: { pending?: boolean } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as any,
      storage: Record<string, unknown> = {},
      session: Record<string, unknown> = {};
    w.slsRequests = [];
    w.localStorageMock = storage;
    w.sessionStorageMock = session;
    const nativeFetch = window.fetch.bind(window);
    w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(".log.aliyuncs.com/logstores/")) {
        w.slsRequests.push({ input: String(input), init });
        if (w.slsFail) return new Response("InvalidAccessKey", { status: 403 });
        return new Response("", {
          status: 200,
          headers: { "x-log-requestid": "ui-sls-test-request" },
        });
      }
      return nativeFetch(input, init);
    };
    w.downloads = [];
    w.messages = [];
    w.activeScan = JSON.parse(
      sessionStorage.getItem("fixtureActiveScan") ?? "null",
    );
    w.chrome = {
      runtime: {
        sendMessage: async (message: any) => {
          w.messages.push(message);
          if (message.type === "state")
            return {
              ok: true,
              result: {
                scan: w.activeScan,
                queued: 0,
                pending: 0,
                failure: "",
              },
            };
          if (message.type === "start") {
            const c = JSON.parse(JSON.stringify(message.config)),
              timestamp = new Date().toISOString();
            const scan = {
              id: "ui-new",
              name: message.name,
              state: "recording",
              started_at: timestamp,
              heartbeat: timestamp,
              tab_scope: message.tab_scope ?? "selected",
              tabs: (message.tab_scope === "all"
                ? w.noPages
                  ? []
                  : [42, 77]
                : message.tabs
              ).map((id: number) => ({
                id,
                url: "https://fixture.test/",
              })),
              config: c,
              versions: [{ version: 1, effective_at: timestamp, config: c }],
              browser: "UI test",
              plugin: "0.2.0",
              stats: {
                observed: 0,
                pending: 0,
                matched: 0,
                excluded: 0,
                unknown: 0,
                persisted: 0,
                groups: 0,
                bytes: 0,
                lost: 0,
              },
              gaps: [],
              rule_hits: {},
              integrity: "observed_scope",
            };
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const r = indexedDB.open("js-security-recorder");
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            const tx = db.transaction("scans", "readwrite");
            tx.objectStore("scans").put(scan);
            await new Promise<void>((resolve, reject) => {
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            w.activeScan = scan;
            return { ok: true, result: scan };
          }
          if (message.type === "stop" && w.activeScan)
            w.activeScan.state = "ended";
          if (message.type === "update" && w.activeScan) {
            const config = JSON.parse(JSON.stringify(message.config));
            w.activeScan = {
              ...w.activeScan,
              config,
              versions: [
                ...w.activeScan.versions,
                {
                  version: w.activeScan.versions.length + 1,
                  effective_at: new Date().toISOString(),
                  config,
                },
              ],
            };
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const r = indexedDB.open("js-security-recorder");
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            const tx = db.transaction("scans", "readwrite");
            tx.objectStore("scans").put(w.activeScan);
            await new Promise<void>((resolve, reject) => {
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          }
          return { ok: true, result: true };
        },
      },
      tabs: {
        query: async () => [
          { id: 42, url: "https://fixture.test/", title: "受控业务页面" },
          { id: 77, url: "https://unselected.test/", title: "另一个业务页面" },
        ],
      },
      permissions: {
        request: async () => true,
        contains: async () => true,
      },
      storage: {
        local: {
          get: async () => storage,
          set: async (value: object) => Object.assign(storage, value),
        },
        session: {
          get: async () => ({ ...session }),
          set: async (value: object) => Object.assign(session, value),
        },
      },
      downloads: {
        download: async (options: any) => {
          const bytes = [
            ...new Uint8Array(await (await fetch(options.url)).arrayBuffer()),
          ];
          w.downloads.push({ filename: options.filename, bytes });
          return w.downloads.length;
        },
      },
    };
  });
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "请求工作台", exact: true })
    .waitFor();
  await page.evaluate(async (fixture) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("js-security-recorder");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(
      ["scans", "requests", "groups", "active"],
      "readwrite",
    );
    fixture.scans.forEach((scan) => tx.objectStore("scans").put(scan));
    fixture.records.forEach((record) => tx.objectStore("requests").put(record));
    fixture.groups.forEach((group) => tx.objectStore("groups").put(group));
    fixture.active.forEach((record) => tx.objectStore("active").put(record));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (fixture.active.length)
      sessionStorage.setItem(
        "fixtureActiveScan",
        JSON.stringify(fixture.scans[0]),
      );
  }, workspaceFixture(options));
  await page.reload();
  await page.locator('[data-request-id="ui-request-100"]').waitFor();
  return { context, page, errors };
}
async function rowCount(page: Page, count: number) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".requests-table tbody tr").length === n,
    count,
  );
}
async function inViewport(page: Page) {
  const detail = page.getByTestId("request-detail");
  await detail.waitFor();
  const heading = detail.getByRole("heading", {
    name: "请求详情",
    exact: true,
  });
  await heading.waitFor();
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThan(1000);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  return detail;
}

it("100 条历史请求自动恢复；首末行点击即在视口查看所有信息，轮询保留详情", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    expect(await page.getByLabel("当前任务").inputValue()).toBe("ui-latest");
    await page.getByLabel("每页条数").selectOption("100");
    await rowCount(page, 100);
    await page
      .locator('[data-request-id="ui-request-100"] .request-path')
      .click();
    const detail = await inViewport(page);
    expect(
      await detail
        .getByText("https://console.example.test/orders", { exact: true })
        .count(),
    ).toBeGreaterThan(0);
    await detail.getByText("响应网络详情", { exact: true }).click();
    expect(await detail.textContent()).toContain("203.0.113.10:443");
    expect(await detail.textContent()).toContain("TLS 1.3");
    await detail.getByRole("tab", { name: /^参数/ }).click();
    expect(await detail.locator(".key-value tbody tr").count()).toBe(4);
    expect(
      (await detail.locator(".key-value tbody").textContent())?.replace(
        /\s/g,
        "",
      ),
    ).toContain("tagalphatagbetaempty（空字符串）token[REDACTED]");
    await detail.getByRole("tab", { name: /^请求头/ }).click();
    expect(
      (await detail.locator(".key-value tbody").textContent())?.replace(
        /\s/g,
        "",
      ),
    ).toContain("Authorization[REDACTED]");
    await detail.getByRole("tab", { name: "请求体", exact: true }).click();
    expect(await detail.locator("pre").textContent()).toContain("BOOK-001");
    await detail.getByRole("tab", { name: /^响应头/ }).click();
    expect(await detail.locator(".key-value tbody").textContent()).toContain(
      "X-Trace-Id",
    );
    await detail.getByRole("tab", { name: "响应体", exact: true }).click();
    expect(await detail.locator("pre").textContent()).toContain(
      '"order_id": "fixture-order"',
    );
    await page.screenshot({
      path: "work/redesign/response-detail.png",
      fullPage: false,
    });
    await detail.getByRole("tab", { name: "调用栈", exact: true }).click();
    await detail
      .getByRole("heading", { name: "Request call stack", exact: true })
      .waitFor();
    await detail
      .getByRole("heading", { name: "Request initiator chain", exact: true })
      .waitFor();
    const callStack = detail.locator(".initiator-call-stack");
    expect(await callStack.locator(".stack-frame").count()).toBe(2);
    expect(await callStack.textContent()).toContain("orders.js:42:8");
    expect(await callStack.textContent()).toContain("checkout.js:12:3");
    expect(await callStack.textContent()).toContain("submitOrder");
    expect(await callStack.textContent()).toContain("onCheckout");
    expect(await callStack.locator(".stack-boundary").textContent()).toContain(
      "Promise.then",
    );
    const initiatorText = await detail.textContent();
    expect(initiatorText).not.toMatch(
      /Script ID|Debugger|父栈 ID|fixture-script-|fixture-debugger-id|fixture-async-parent/,
    );
    const chain = detail.locator(".initiator-chain");
    expect(await chain.locator(".initiator-chain-node").count()).toBe(3);
    expect(await chain.locator(".initiator-chain-node.current").count()).toBe(
      1,
    );
    expect(
      await chain.locator(".initiator-chain-node.current").textContent(),
    ).toContain("/api/orders");
    await page.screenshot({
      path: "work/redesign/chrome-initiator.png",
      fullPage: false,
    });
    await detail.getByRole("tab", { name: "原始数据", exact: true }).click();
    const rawRequest = JSON.parse((await detail.locator("pre").textContent())!);
    expect(rawRequest.request_id).toBe("ui-request-100");
    expect(rawRequest.initiator_stack.callFrames[0].scriptId).toBe(
      "fixture-script-42",
    );
    expect(rawRequest.initiator_stack.parentId.debuggerId).toBe(
      "fixture-debugger-id",
    );
    await page.waitForTimeout(1700);
    expect(
      JSON.parse((await detail.locator("pre").textContent())!).request_id,
    ).toBe("ui-request-100");
    await page
      .locator('[data-request-id="ui-request-001"] .request-path')
      .click();
    await inViewport(page);
    await detail.getByRole("tab", { name: "请求体", exact: true }).click();
    await detail
      .getByRole("heading", { name: "未报告请求正文", exact: true })
      .waitFor();
    await detail.getByRole("tab", { name: "调用栈", exact: true }).click();
    await detail
      .getByRole("heading", { name: "浏览器未提供可展开的调用栈", exact: true })
      .waitFor();
    await page
      .locator('[data-request-id="ui-request-100"] .request-path')
      .click();
    await detail.getByRole("tab", { name: /^参数/ }).click();
    await page.screenshot({
      path: "work/redesign/requests-with-detail.png",
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    expect(await page.getByTestId("request-detail").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 25000);

it("分页、全任务搜索、资源过滤、聚合成员与历史任务切换可操作", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    await rowCount(page, 50);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.locator('[data-request-id="ui-request-001"]').waitFor();
    expect(
      await page.locator('[data-request-id="ui-request-100"]').count(),
    ).toBe(0);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.locator('[data-request-id="ui-request-100"]').waitFor();
    await page.getByLabel("搜索请求").fill("/api/catalog/37");
    await rowCount(page, 1);
    expect(await page.locator(".request-path").textContent()).toBe(
      "/api/catalog/37",
    );
    await page.getByLabel("搜索请求").fill("");
    await page.getByRole("button", { name: "文档", exact: true }).click();
    await rowCount(page, 2);
    expect(
      await page.locator("tbody .resource-label").allTextContents(),
    ).toEqual(["Document", "Document"]);
    await page.getByRole("button", { name: "全部请求", exact: true }).click();
    await page.getByRole("button", { name: "聚合", exact: true }).click();
    await page.getByLabel("搜索请求").fill("/api/orders");
    await rowCount(page, 1);
    await page.getByRole("button", { name: "查看请求组", exact: true }).click();
    await page
      .getByRole("heading", { name: "请求组详情", exact: true })
      .waitFor();
    await page.getByRole("button", { name: /查看全部成员/ }).click();
    await rowCount(page, 2);
    expect(await page.locator(".request-path").allTextContents()).toEqual([
      "/api/orders",
      "/api/orders",
    ]);
    await page.getByLabel("清除请求组筛选").click();
    await page.getByRole("button", { name: "历史任务", exact: true }).click();
    await page
      .getByRole("button", { name: "历史登录任务 · 验证样例", exact: true })
      .click();
    await page.locator('[data-request-id="older-health"]').waitFor();
    expect(await page.getByLabel("当前任务").inputValue()).toBe("ui-older");
    await page
      .locator('[data-request-id="older-health"] .request-path')
      .click();
    await inViewport(page);
    expect(
      await page
        .getByTestId("request-detail")
        .locator(".detail-url")
        .textContent(),
    ).toBe("https://legacy.example.test/api/health");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 25000);

it("单条 JSONL 与完整 ZIP 导出包含实际已保存记录", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    await page
      .locator('[data-request-id="ui-request-100"] .request-path')
      .click();
    await page
      .getByTestId("request-detail")
      .getByRole("button", { name: "导出此请求", exact: true })
      .click();
    await page.waitForFunction(() => (window as any).downloads.length === 1);
    const single = await page.evaluate(() => (window as any).downloads[0]);
    expect(JSON.parse(strFromU8(new Uint8Array(single.bytes))).request_id).toBe(
      "ui-request-100",
    );
    await page.getByRole("button", { name: "导出数据", exact: true }).click();
    await page.getByRole("button", { name: /^完整任务 ZIP/ }).click();
    await page.waitForFunction(() => (window as any).downloads.length === 2);
    const download = await page.evaluate(() => (window as any).downloads[1]);
    const files = unzipSync(new Uint8Array(download.bytes));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "scan_manifest.json",
        "request_groups.jsonl",
        "capture_errors.jsonl",
      ]),
    );
    const requests = Object.entries(files)
      .filter(([name]) => /^requests_.*\.jsonl$/.test(name))
      .flatMap(([, value]) =>
        strFromU8(value)
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    expect(requests).toHaveLength(100);
    expect(requests.some((r) => r.request_id === "ui-request-100")).toBe(true);
    expect(JSON.parse(strFromU8(files["scan_manifest.json"])).scan.id).toBe(
      "ui-latest",
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 25000);

it("默认全局采集无需选择页面，Filter正确传递且非法配置有明确反馈", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    await page.getByRole("button", { name: "过滤规则", exact: true }).click();
    const inactiveActions = page.getByLabel("过滤规则操作");
    await inactiveActions.getByText(/当前任务已经结束/).waitFor();
    expect(
      await inactiveActions
        .getByRole("button", { name: "应用到当前任务", exact: true })
        .isDisabled(),
    ).toBe(true);
    await page
      .getByRole("button", { name: "新建采集任务", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "新建采集任务",
      exact: true,
    });
    await dialog.waitFor();
    expect(
      await dialog
        .getByRole("button", { name: "开始采集", exact: true })
        .isDisabled(),
    ).toBe(false);
    expect(
      await dialog
        .getByRole("button", { name: "全部网页", exact: true })
        .count(),
    ).toBe(0);
    expect(
      await dialog
        .getByRole("button", { name: "指定标签页", exact: true })
        .count(),
    ).toBe(0);
    expect(await dialog.locator(".tab-option").count()).toBe(0);
    await dialog.getByText("浏览器全局采集", { exact: true }).waitFor();
    const filterInput = dialog.getByRole("textbox", {
      name: "请求筛选",
      exact: true,
    });
    await filterInput.fill('domain:"未闭合');
    await dialog.getByRole("alert").waitFor();
    expect(
      await dialog
        .getByRole("button", { name: "开始采集", exact: true })
        .isDisabled(),
    ).toBe(true);
    await filterInput.fill(
      "resource-type:XHR,Fetch,Ping; -url:/health(?:check)?/i",
    );
    await dialog.getByLabel("字段值保存").selectOption("complete");
    const fieldSelector = dialog.locator(".field-selector");
    expect(await fieldSelector.getByRole("checkbox").count()).toBe(9);
    for (const checkbox of await fieldSelector.getByRole("checkbox").all())
      expect(await checkbox.isChecked()).toBe(true);
    await fieldSelector.getByRole("checkbox", { name: /请求体/ }).uncheck();
    await dialog.getByLabel("自动保存到阿里云 SLS").check();
    await dialog
      .getByLabel("Endpoint", { exact: true })
      .fill("cn-hangzhou.log.aliyuncs.com");
    await dialog
      .getByLabel("Project", { exact: true })
      .fill("new-task-project");
    await dialog
      .getByLabel("Logstore", { exact: true })
      .fill("new_task_requests");
    await dialog
      .getByLabel("AccessKey ID", { exact: true })
      .fill("LTAI-new-task");
    await dialog
      .getByLabel("AccessKey Secret", { exact: true })
      .fill("new-task-secret");
    expect(
      await dialog
        .getByLabel("SecurityToken（仅 STS 临时凭证必填）")
        .getAttribute("placeholder"),
    ).toContain("长期 AccessKey 留空");
    const slsFields = dialog.locator(".sls-field-selector");
    expect(
      await slsFields
        .getByRole("checkbox", { name: /TLS 证书详情/ })
        .isChecked(),
    ).toBe(false);
    await slsFields.getByRole("checkbox", { name: /响应体/ }).uncheck();
    await slsFields.getByRole("checkbox", { name: /TLS 证书详情/ }).check();
    await dialog
      .getByRole("button", { name: "测试 SLS 连接", exact: true })
      .click();
    await dialog
      .locator(".draft-sls-test-result")
      .getByText(/连接成功/)
      .waitFor();
    expect(
      await dialog.getByLabel("AccessKey ID", { exact: true }).inputValue(),
    ).toBe("");
    expect(await dialog.locator(".credential-summary").textContent()).toContain(
      "AccessKey ID LTAI••••task",
    );
    expect(
      await dialog.locator(".draft-sls-test-result").textContent(),
    ).toContain("new-task-project/new_task_requests");
    expect(
      await page.evaluate(
        () => (window as any).localStorageMock.sls_profile.logstore,
      ),
    ).toBe("new_task_requests");
    await dialog
      .getByLabel("Logstore", { exact: true })
      .fill("new_task_requests_final");
    expect(await dialog.locator(".draft-sls-test-result").count()).toBe(0);
    expect(await dialog.locator(".credential-summary").count()).toBe(0);
    await dialog
      .getByLabel("AccessKey ID", { exact: true })
      .fill("LTAI-final-task");
    await dialog
      .getByLabel("AccessKey Secret", { exact: true })
      .fill("new-task-secret-final");
    expect(await dialog.getByTestId("filter-summary").textContent()).toContain(
      "类型为 XHR、Fetch、Ping",
    );
    await page.screenshot({
      path: "work/redesign/new-task-sls.png",
      fullPage: false,
    });
    await dialog.getByRole("button", { name: "开始采集", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const message = await page.evaluate(() =>
      (window as any).messages.find((m: any) => m.type === "start"),
    );
    expect(message.tab_scope).toBe("all");
    expect(message.tabs).toEqual([]);
    expect((message.config.filter.include as any).field).toBe("resource_type");
    expect((message.config.filter.exclude as any).operator).toBe("regex");
    expect(message.config.retention).toBe("matching");
    expect(message.config.value_storage).toBe("complete");
    expect(message.config.saved_fields).toHaveLength(8);
    expect(message.config.saved_fields).not.toContain("request_body");
    expect(message.config.sls.upload_fields).not.toContain("response_body");
    expect(message.config.sls.upload_fields).toContain("tls");
    expect(message.config.saved_fields).toContain("response_body");
    expect(message.config.sls).toMatchObject({
      enabled: true,
      mode: "sts",
      endpoint: "cn-hangzhou.log.aliyuncs.com",
      project: "new-task-project",
      logstore: "new_task_requests_final",
    });
    await page.getByRole("button", { name: "任务设置", exact: true }).click();
    await page.getByText("高级配置 JSON", { exact: true }).click();
    await page.getByLabel("任务高级配置").fill("null");
    expect(
      await page
        .getByRole("heading", { name: "采集与归并策略", exact: true })
        .isVisible(),
    ).toBe(true);
    await page.getByRole("button", { name: "保存策略", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toMatch(
      /配置.*对象|对象.*配置/,
    );
    await page.getByLabel("任务高级配置").fill(JSON.stringify(message.config));
    await page.getByRole("button", { name: "关闭错误提示" }).click();
    await page.getByRole("button", { name: "过滤规则", exact: true }).click();
    const filterPanel = page
      .locator(".panel")
      .filter({ has: page.getByRole("heading", { name: "请求过滤" }) });
    const queryInput = filterPanel.getByLabel("请求筛选", { exact: true });
    expect(await queryInput.count()).toBe(1);
    await filterPanel.getByText(/多个条件必须用/).waitFor();
    expect(await filterPanel.getByLabel("过滤语法说明").textContent()).toMatch(
      /;.*同时满足|同时满足.*;/,
    );
    for (const selector of [
      ".advanced-filter-settings",
      ".visual-filter",
      ".rule-section",
    ])
      expect(await filterPanel.locator(selector).count()).toBe(0);
    expect(await page.getByLabel("过滤规则 JSON").count()).toBe(0);
    expect(await page.getByLabel("模板名称").count()).toBe(0);
    expect(await page.getByRole("button", { name: "保存为模板" }).count()).toBe(
      0,
    );
    await queryInput.fill(
      String.raw`domain:example.com; method:POST,PUT; -resource-type:Image; url:/\/api\//i`,
    );
    const filterActions = page.getByLabel("过滤规则操作");
    await filterActions
      .getByText("修改尚未应用。应用后只影响之后收到的请求。", {
        exact: true,
      })
      .waitFor();
    const applyButton = filterActions.getByRole("button", {
      name: "应用到当前任务",
      exact: true,
    });
    expect(await applyButton.isDisabled()).toBe(false);
    await applyButton.click();
    await page
      .getByRole("status")
      .getByText(/已应用到当前任务/)
      .waitFor();
    const updateMessage = await page.evaluate(() =>
      (window as any).messages.findLast((m: any) => m.type === "update"),
    );
    expect(updateMessage.config.filter.include.rules).toHaveLength(3);
    expect(updateMessage.config.filter.exclude).toMatchObject({
      field: "resource_type",
      values: ["Image"],
    });
    expect(await applyButton.isDisabled()).toBe(true);
    await filterActions
      .getByRole("button", { name: "预览当前页", exact: true })
      .click();
    await page
      .getByRole("status")
      .getByText(/命中 \d+，排除 \d+，无法判定 \d+/)
      .waitFor();
    await page.screenshot({
      path: "work/redesign/filter-single-query.png",
      fullPage: false,
    });
    await queryInput.fill("url:/[/");
    await filterPanel.getByRole("alert").waitFor();
    expect(await filterPanel.getByRole("alert").textContent()).toContain(
      "正则表达式无效",
    );
    expect(
      await page
        .getByRole("button", { name: "预览当前页", exact: true })
        .isDisabled(),
    ).toBe(true);
    await queryInput.fill("");
    await filterPanel.getByText("保存全部请求", { exact: true }).waitFor();
    expect(
      await filterActions
        .getByRole("button", { name: "应用到当前任务", exact: true })
        .isDisabled(),
    ).toBe(false);
    await filterActions
      .getByRole("button", { name: "应用到当前任务", exact: true })
      .click();
    const clearMessage = await page.evaluate(() =>
      (window as any).messages.findLast((m: any) => m.type === "update"),
    );
    expect(clearMessage.config.filter).toEqual({});
    await page.getByRole("button", { name: "存储与转存", exact: true }).click();
    await page
      .getByRole("heading", { name: "自动保存到阿里云 SLS", exact: true })
      .waitFor();
    expect(await page.getByLabel("Endpoint").inputValue()).toBe(
      "cn-hangzhou.log.aliyuncs.com",
    );
    expect(await page.getByLabel("Project").inputValue()).toBe(
      "new-task-project",
    );
    expect(await page.getByLabel("Logstore").inputValue()).toBe(
      "new_task_requests_final",
    );
    expect(await page.locator(".credential-summary").textContent()).toContain(
      "AccessKey ID LTAI••••task",
    );
    await page.getByLabel("启用阿里云 SLS 自动保存").check();
    await page.getByLabel("Endpoint").fill("cn-hangzhou.log.aliyuncs.com");
    await page.getByLabel("Project").fill("security-project");
    await page.getByLabel("Logstore").fill("browser_requests");
    await page.getByLabel("AccessKey ID").fill("LTAI-ui-test");
    await page.getByLabel("AccessKey Secret").fill("ui-secret");
    expect(
      await page
        .getByLabel("SecurityToken（仅 STS 临时凭证必填）")
        .getAttribute("placeholder"),
    ).toContain("长期 AccessKey 留空");
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await page
      .locator(".sls-test-result")
      .getByText(/连接成功/)
      .waitFor();
    await page.screenshot({
      path: "work/redesign/sls-connection-test.png",
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => (window as any).slsRequests.at(-1).init.headers.Authorization,
      ),
    ).toMatch(/^LOG LTAI-ui-test:/);
    expect(
      await page.evaluate(
        () =>
          (window as any).slsRequests.at(-1).init.headers[
            "x-acs-security-token"
          ],
      ),
    ).toBeUndefined();
    const credentialsBeforeFailure = await page.evaluate(() =>
      JSON.stringify((window as any).sessionStorageMock),
    );
    await page.getByLabel("AccessKey ID").fill("bad-id");
    await page.getByLabel("AccessKey Secret").fill("bad-secret");
    await page.evaluate(() => {
      (window as any).slsFail = true;
    });
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await page.locator(".sls-test-result").getByText(/403/).waitFor();
    expect(
      await page.evaluate(() =>
        JSON.stringify((window as any).sessionStorageMock),
      ),
    ).toBe(credentialsBeforeFailure);
    await page.evaluate(() => {
      (window as any).slsFail = false;
    });
    await page.getByLabel("AccessKey ID").fill("");
    await page.getByLabel("AccessKey Secret").fill("");
    await page.getByRole("button", { name: "保存复用配置与会话凭证" }).click();
    await page.getByLabel("Project").fill("unsaved-project");
    await page.getByRole("button", { name: "过滤规则", exact: true }).click();
    await page.getByLabel("请求筛选", { exact: true }).fill("method:GET");
    await page
      .getByRole("button", { name: "应用到当前任务", exact: true })
      .click();
    expect(
      await page.evaluate(
        () =>
          (window as any).messages.findLast((m: any) => m.type === "update")
            .config.sls.project,
      ),
    ).toBe("new-task-project");
    await page.getByRole("button", { name: "存储与转存", exact: true }).click();
    await page.getByLabel("Project").fill("security-project");
    await page.getByLabel("接入方式").selectOption("web_tracking");
    await page.getByText(/公网匿名写入/).waitFor();
    await page.screenshot({
      path: "work/redesign/sls-transfer.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "保存复用配置与会话凭证" }).click();
    await page
      .getByRole("status")
      .getByText(/SLS 配置已保存/)
      .waitFor();
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await page
      .locator(".sls-test-result")
      .getByText(/连接成功/)
      .waitFor();
    expect(await page.locator(".sls-test-result").textContent()).toContain(
      "ui-sls-test-request",
    );
    await page.getByRole("button", { name: "保存全部转存策略" }).click();
    const slsUpdate = await page.evaluate(() =>
      (window as any).messages.findLast((m: any) => m.type === "update"),
    );
    expect(slsUpdate.config.sls).toMatchObject({
      enabled: true,
      mode: "web_tracking",
      project: "security-project",
      logstore: "browser_requests",
    });
    expect(
      await page.evaluate(
        () => (window as any).localStorageMock.sls_profile.logstore,
      ),
    ).toBe("browser_requests");
    expect(
      await page.evaluate(() =>
        JSON.stringify((window as any).localStorageMock.sls_profile),
      ),
    ).not.toMatch(/LTAI|secret|SecurityToken/i);
    await page.getByLabel("Project").fill("unsaved-project");
    await page.evaluate(() => {
      const w = window as any;
      w.activeScan = { ...w.activeScan, state: "ended" };
    });
    const newTaskButton = page
      .getByRole("button", { name: "新建采集任务", exact: true })
      .first();
    await newTaskButton.waitFor();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "新建采集任务",
      ) as HTMLButtonElement | undefined;
      return button && !button.disabled;
    });
    await newTaskButton.click();
    const reusedDialog = page.getByRole("dialog", {
      name: "新建采集任务",
      exact: true,
    });
    await reusedDialog.getByLabel("自动保存到阿里云 SLS").waitFor();
    expect(
      await reusedDialog.getByLabel("自动保存到阿里云 SLS").isChecked(),
    ).toBe(true);
    expect(
      await reusedDialog
        .locator(".new-task-sls-settings select")
        .first()
        .inputValue(),
    ).toBe("web_tracking");
    expect(
      await reusedDialog.getByPlaceholder("your-project").inputValue(),
    ).toBe("security-project");
    expect(
      await reusedDialog.getByPlaceholder("js-security-requests").inputValue(),
    ).toBe("browser_requests");
    await reusedDialog
      .getByRole("button", { name: "关闭新建任务", exact: true })
      .click();
    await page.getByRole("button", { name: "使用说明", exact: true }).click();
    await page
      .getByRole("heading", { name: "完整使用说明", exact: true })
      .waitFor();
    const guide = page.locator(".usage-manual");
    expect(await guide.textContent()).toContain("resource-type 后面到底填什么");
    for (const type of [
      "XHR",
      "Fetch",
      "Ping",
      "Preflight",
      "Document",
      "Script",
      "Stylesheet",
      "Image",
      "Media",
      "Font",
      "EventSource",
      "WebSocket",
      "Other",
    ])
      expect(
        await guide.getByText(type, { exact: true }).count(),
      ).toBeGreaterThan(0);
    expect(await guide.textContent()).toContain("不要填写 API、JSON 或 Beacon");
    expect(await guide.textContent()).toContain("英文分号");
    expect(await guide.textContent()).toContain("全部可用过滤字段");
    await page.screenshot({
      path: "work/redesign/usage-guide.png",
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 25000);

it("没有任何网页时仍可创建全局采集任务，不调用标签页查询", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    await page.evaluate(() => {
      const w = window as any;
      w.noPages = true;
      w.tabQueryCalls = 0;
      w.chrome.tabs.query = async () => {
        w.tabQueryCalls++;
        return [];
      };
    });
    await page
      .getByRole("button", { name: "新建采集任务", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "新建采集任务",
      exact: true,
    });
    await dialog.getByText("浏览器全局采集", { exact: true }).waitFor();
    expect(
      await dialog
        .getByRole("button", { name: "开始采集", exact: true })
        .isDisabled(),
    ).toBe(false);
    await dialog.getByRole("button", { name: "开始采集", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const message = await page.evaluate(() =>
      (window as any).messages.find((m: any) => m.type === "start"),
    );
    expect(message.tab_scope).toBe("all");
    expect(message.tabs).toEqual([]);
    expect(await page.evaluate(() => (window as any).activeScan.tabs)).toEqual(
      [],
    );
    expect(await page.evaluate(() => (window as any).tabQueryCalls)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20000);

it("CSV 写入期间锁定任务选择，导出内容不会混入其他历史任务", async () => {
  const { context, page, errors } = await openWorkspace();
  try {
    await page.evaluate(() => {
      const w = window as any;
      w.csvChunks = [];
      w.csvClosed = false;
      w.showSaveFilePicker = () =>
        new Promise((resolve) => {
          w.releasePicker = () =>
            resolve({
              createWritable: async () => ({
                write: async (text: string) => w.csvChunks.push(text),
                close: async () => {
                  w.csvClosed = true;
                },
                abort: async () => {
                  w.csvAborted = true;
                },
              }),
            });
        });
    });
    await page.getByRole("button", { name: "导出数据", exact: true }).click();
    await page
      .getByRole("button", { name: "全部请求 CSV", exact: true })
      .click();
    await page.waitForFunction(
      () => typeof (window as any).releasePicker === "function",
    );
    expect(await page.getByLabel("当前任务").isDisabled()).toBe(true);
    expect(await page.getByLabel("当前任务").inputValue()).toBe("ui-latest");
    await page.evaluate(() => (window as any).releasePicker());
    await page.waitForFunction(() => (window as any).csvClosed);
    const text = await page.evaluate(() => (window as any).csvChunks.join(""));
    expect(text).toContain("ui-request-100");
    expect(text).toContain("ui-request-001");
    expect(text).not.toContain("older-health");
    expect(text.trim().split("\r\n")).toHaveLength(101);
    expect(await page.evaluate(() => (window as any).csvAborted)).not.toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20000);

it("在途长连接完成前可查看已取得字段，完成后已打开详情自动更新", async () => {
  const { context, page, errors } = await openWorkspace({ pending: true });
  try {
    expect(await page.locator(".request-row").count()).toBe(50);
    await page
      .getByRole("button", { name: "查看在途请求", exact: true })
      .click();
    await page.locator('[data-request-id="ui-pending-events"]').waitFor();
    await rowCount(page, 1);
    await page
      .locator('[data-request-id="ui-pending-events"] .request-path')
      .click();
    const detail = await inViewport(page);
    expect(await detail.locator(".status-code").textContent()).toContain(
      "进行中",
    );
    expect(await detail.locator(".metadata").first().textContent()).toContain(
      "等待终态判断",
    );
    await detail.getByRole("tab", { name: /^参数/ }).click();
    expect(await detail.locator(".key-value tbody").textContent()).toContain(
      "fixture-cursor",
    );
    await detail.getByRole("tab", { name: /^请求头/ }).click();
    expect(
      (await detail.locator(".key-value tbody").textContent())?.replace(
        /\s/g,
        "",
      ),
    ).toContain("Authorization[REDACTED]");
    await page.screenshot({
      path: "work/redesign/pending-request-detail.png",
      fullPage: false,
    });
    await page
      .getByRole("checkbox", { name: "选择 /api/events", exact: true })
      .check();
    await page.getByRole("button", { name: "导出数据", exact: true }).click();
    await page.getByRole("button", { name: /^选中请求/ }).click();
    await page.waitForFunction(() => (window as any).downloads.length === 1);
    const selectedExport = await page.evaluate(
      () => (window as any).downloads[0],
    );
    const selectedRecord = JSON.parse(
      strFromU8(new Uint8Array(selectedExport.bytes)).trim(),
    );
    expect(selectedRecord.request_id).toBe("ui-pending-events");
    expect(selectedRecord.request_state).toBe("pending");
    await detail.getByRole("tab", { name: "概览", exact: true }).click();
    await page.evaluate(async () => {
      const w = window as any;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("js-security-recorder");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const pending = await new Promise<any>((resolve, reject) => {
        const r = db
          .transaction("active")
          .objectStore("active")
          .get("ui-pending-events");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const completed = {
        ...pending,
        ordinal: 101,
        request_state: "complete",
        filter_result: "matched",
        capture_status: {
          ...pending.capture_status,
          headers: { state: "complete", reason: "后续 ExtraInfo 已补齐" },
        },
      };
      const scan = JSON.parse(JSON.stringify(w.activeScan));
      scan.stats.pending = 0;
      scan.stats.persisted = 101;
      scan.stats.matched = 101;
      const tx = db.transaction(["active", "requests", "scans"], "readwrite");
      tx.objectStore("active").delete("ui-pending-events");
      tx.objectStore("requests").put(completed);
      tx.objectStore("scans").put(scan);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      w.activeScan = scan;
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="request-detail"] .status-code')
          ?.textContent?.trim() === "200",
    );
    expect(await detail.locator(".metadata").first().textContent()).toContain(
      "命中",
    );
    expect(
      await detail.locator(".metadata").first().textContent(),
    ).not.toContain("等待终态判断");
    await detail.getByRole("tab", { name: "原始数据", exact: true }).click();
    expect(
      JSON.parse((await detail.locator("pre").textContent())!).request_state,
    ).toBe("complete");
    expect(
      await page.locator('[data-request-id="ui-pending-events"]').count(),
    ).toBe(0);
    await page.getByRole("button", { name: "原始", exact: true }).click();
    await page.locator('[data-request-id="ui-pending-events"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20000);
