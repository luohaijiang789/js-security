import { it, expect } from "vitest";
import { chromium } from "playwright";
import { preview } from "vite";
import { readFile, mkdir } from "node:fs/promises";
it("真实 Chromium 页面：导航、模板预览、任务配置与空状态无运行错误", async () => {
  const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
  const address = server.httpServer.address() as any;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      const storage: any = {};
      (window as any).chrome = {
        runtime: {
          sendMessage: async (message: any) => {
            if (message.type === "start") (window as any).lastStart = message;
            return {
              ok: true,
              result: { scan: null, queued: 0, pending: 0, failure: "" },
            };
          },
        },
        tabs: {
          query: async () => [
            { id: 42, url: "https://fixture.test/", title: "受控标签页" },
          ],
        },
        storage: {
          local: {
            get: async () => storage,
            set: async (v: any) => Object.assign(storage, v),
          },
        },
      };
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("heading", { name: "请求", exact: true }).waitFor();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await page.getByText("受控标签页", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page
      .getByRole("button", { name: "预览本页结果", exact: true })
      .click();
    await page.getByText("本页已脱敏记录预览：", { exact: false }).waitFor();
    await page.getByText("高级 JSON 编辑器", { exact: true }).click();
    await page
      .locator("textarea[rows='22']")
      .fill('{"include":{"field":"domain","operator":"regex","values":["["]}}');
    await page
      .getByRole("button", { name: "预览本页结果", exact: true })
      .click();
    await page.locator(".alert").waitFor();
    await page
      .getByRole("button", { name: "预览本页结果", exact: true })
      .click();
    await page.locator("textarea[rows='22']").fill("{}");
    await page
      .getByRole("button", { name: "预览本页结果", exact: true })
      .click();
    await page.getByRole("button", { name: "请求", exact: true }).click();
    await mkdir("work/browser", { recursive: true });
    await page.screenshot({ path: "work/browser/ui.png", fullPage: true });
    await page.goto(`http://127.0.0.1:${address.port}/popup.html`);
    await page.locator(".tab input[type=checkbox]").check();
    await page.getByRole("button", { name: "开始采集", exact: true }).click();
    await page.waitForFunction(() =>
      (window as any).lastStart?.tabs?.includes(42),
    );
    expect(
      await page.evaluate(() => (window as any).lastStart.config.retention),
    ).toBe("matching");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.httpServer.close(() => r()));
  }
}, 20000);
