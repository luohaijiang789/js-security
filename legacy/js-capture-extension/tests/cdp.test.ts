// Real CDP + real analysis core. Chrome extension permissions are not exercised.
import { it, expect } from "vitest";
import { chromium, type CDPSession } from "playwright";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Collector } from "../src/capture";
import type { Asset, Task } from "../src/model";
it("reads initial and late real CDP sources then analyzes their frozen bodies without probing API URLs", async () => {
  const traffic: string[] = [],
    sources: Asset[] = [],
    saved = new Map<string, Task>();
  const server = createServer((req, res) => {
    traffic.push(req.url ?? "");
    if (req.url === "/main.js" || req.url === "/late.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(
        req.url === "/main.js"
          ? "function first(){return fetch('./api/first');}"
          : "function second(){return fetch('./api/second');}",
      );
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><base href="/app/"><script src="/main.js"></script>',
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  let session: CDPSession | undefined;
  let collector: Collector | undefined;
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const api = {
      tabs: { query: async () => [{ id: 1, url: origin }] },
      debugger: {
        attach: async () => {
          session = await page.context().newCDPSession(page);
          for (const method of [
            "Runtime.executionContextCreated",
            "Runtime.executionContextDestroyed",
            "Runtime.executionContextsCleared",
            "Debugger.scriptParsed",
            "Page.frameNavigated",
            "Target.attachedToTarget",
            "Target.detachedFromTarget",
          ])
            session.on(method as any, (params: any) =>
              collector!.event({ tabId: 1 }, method, params),
            );
        },
        detach: async () => {
          await session?.detach();
        },
        sendCommand: async (s: any, method: string, params: any) => {
          if (s.sessionId)
            throw Error("Child CDP route not covered by this transport");
          return session!.send(method as any, params);
        },
      },
    };
    collector = new Collector(api as unknown as typeof chrome, {
      tasks: async () => [...saved.values()],
      saveTask: async (t) => {
        saved.set(t.id, structuredClone(t));
      },
      saveAsset: async (a, t) => {
        sources.push(structuredClone(a));
        saved.set(t.id, structuredClone(t));
      },
    });
    await collector.start();
    await page.addScriptTag({ url: origin + "/late.js" });
    await expect
      .poll(() => sources.some((a) => a.capture_url === origin + "/late.js"), {
        timeout: 5000,
      })
      .toBe(true);
    await collector.stop();
    expect(sources.some((a) => a.url === origin + "/main.js")).toBe(true);
    expect(sources.some((a) => a.url === origin + "/late.js")).toBe(true);
    expect(
      sources
        .filter((a) => a.url?.endsWith(".js"))
        .every((a) => a.context.request_base_url === origin + "/app/"),
    ).toBe(true);
    const output = path.resolve(
      "../../work/website-plugin-cdp",
      crypto.randomUUID(),
    );
    await mkdir(output, { recursive: true });
    const capture = {
      schema_version: "capture-0.1",
      snapshot_id: crypto.randomUUID(),
      task_id: collector.task!.id,
      assets: sources,
      gaps: collector.task!.gaps,
      frozen_at: new Date().toISOString(),
    };
    const input = path.join(output, "capture.json");
    await writeFile(input, JSON.stringify(capture));
    const python =
      process.env.PYTHON ??
      path.resolve("../../work/website-js-extractor-venv/bin/python");
    try {
      await promisify(execFile)(
        python,
        [
          "-m",
          "website_js_extractor",
          "analyze",
          "--capture",
          input,
          "--out",
          path.join(output, "result"),
        ],
        { cwd: path.resolve("../.."), timeout: 60000 },
      );
    } catch (e: any) {
      expect(e.code).toBe(4);
    }
    const report = JSON.parse(
      await readFile(path.join(output, "result/analysis.json"), "utf8"),
    );
    expect(report.candidates.map((c: any) => c.url).sort()).toEqual([
      origin + "/app/api/first",
      origin + "/app/api/second",
    ]);
    expect(report.fetch_events).toEqual([]);
    expect(traffic.some((url) => url.includes("/api/"))).toBe(false);
    await writeFile(
      path.join(output, "verification.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          traffic,
          assets: sources.length,
          candidates: report.candidates.length,
          gaps: collector.task!.gaps,
          scope:
            "Real browser CDP transport and real core; not Chrome MV3 permission acceptance",
        },
        null,
        2,
      ),
    );
  } finally {
    if (collector?.task?.phase === "collecting")
      await collector.stop().catch(() => {});
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 60000);
