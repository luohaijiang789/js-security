import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import { jsPage, jsSource } from "../src/js-store";
it("real Chromium CDP collects duplicate multi-MiB external JS and network provenance through the request recorder session", async () => {
  const source = `/*${"a".repeat(3 * 1048576)}*/\nglobalThis.jsRuns = (globalThis.jsRuns || 0) + 1; fetch('/api?item=1');`;
  const server = createServer((req, res) => {
    if (req.url?.endsWith(".js")) {
      res.setHeader("Content-Type", "application/javascript");
      res.end(source);
    } else if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><script src="/first.js"></script><script src="/copy.js"></script>',
      );
    } else res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const recorder = new Recorder(async (_s, method, params) =>
      method === "Target.setAutoAttach"
        ? {}
        : session.send(method as any, params as any),
    );
    const scan = await recorder.create(
      "real JS CDP",
      [{ id: 1, url: origin }],
      { ...defaults(), collect_js: true, stop_wait_ms: 100 },
    );
    let tail = Promise.resolve();
    for (const method of [
      "Debugger.scriptParsed",
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.responseReceivedExtraInfo",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ]) {
      session.on(method as any, (params: any) => {
        tail = tail.then(() => recorder.event({ tabId: 1 }, method, params));
      });
    }
    await recorder.configure({ tabId: 1 });
    await page.goto(origin);
    expect(await page.evaluate("globalThis.jsRuns")).toBe(2);
    await page.waitForLoadState("networkidle");
    await tail;
    await recorder.stop();
    const events = (await jsPage(scan.id)).events;
    const scripts = events.filter(
      (e) =>
        e.kind === "Debugger.scriptParsed" &&
        /\/(first|copy)\.js$/.test(e.data.url),
    );
    expect(scripts).toHaveLength(2);
    expect(scripts[0].hash).toBeTruthy();
    expect(scripts[0].hash).toBe(scripts[1].hash);
    expect(await jsSource(scripts[0].hash!)).toBe(source);
    const requests = events.filter(
      (e) => e.kind === "Network.requestWillBeSent",
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (e) =>
          e.data.loader_id &&
          e.data.frame_id &&
          e.data.document_url === origin + "/",
      ),
    ).toBe(true);
    expect(scan.stats.persisted).toBeGreaterThan(0);
    expect(scan.gaps.filter((g) => g.type.startsWith("js_"))).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
