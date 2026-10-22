import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import * as db from "../src/store";
it("真实 Chromium CDP：受控请求、重定向、脱敏、在途停止和标签页隔离", async () => {
  const received: { url: string; method: string }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    received.push({ url: req.url!, method: req.method! });
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/redirected" });
      res.end();
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => res.end("slow"), 2000);
      return;
    }
    res.setHeader("Content-Type", req.url === "/" ? "text/html" : "text/plain");
    if (req.method === "OPTIONS") res.statusCode = 204;
    res.end(
      req.url === "/" ? "<!doctype html><title>CDP fixture</title>" : "ok",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage(),
      other = await browser.newPage();
    await page.goto(origin);
    await other.goto(origin);
    const session = await page.context().newCDPSession(page);
    const recorder = new Recorder(async (_s, m, p) => {
      if (m === "Target.setAutoAttach") return {};
      return session.send(m as any, p as any);
    });
    await recorder.create(
      "CDP controlled integration",
      [{ id: 1, url: origin }],
      {
        ...defaults(),
        body_limit: 1024,
        stop_wait_ms: 100,
        dynamic_query: ["ts"],
        archive: { ...defaults().archive, enabled: false },
      },
    );
    await recorder.configure({ tabId: 1 });
    let tail = Promise.resolve();
    for (const method of [
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ] as const)
      session.on(method, (p) => {
        tail = tail.then(() => recorder.event({ tabId: 1 }, method, p));
      });
    await page.evaluate(async () => {
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
      await fetch("/same?ts=1");
      await fetch("/same?ts=2");
      navigator.sendBeacon("/beacon", "plain-sensitive-value");
      await new Promise<void>((res) => {
        const img = new Image();
        img.onload = () => res();
        img.onerror = () => res();
        img.src = "/pixel.png";
        document.body.append(img);
      });
      await fetch("/large", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(2000) }),
      });
    });
    await other.evaluate(() => fetch("/UNAUTHORIZED"));
    await tail;
    await recorder.tail;
    await recorder.pause();
    await page.evaluate(() => fetch("/PAUSED"));
    await tail;
    await recorder.resume();
    await page.evaluate(() => {
      void fetch("/slow");
    });
    await new Promise((r) => setTimeout(r, 50));
    await tail;
    await recorder.stop();
    const rows = await db.page(recorder.scan!.id, "", 500),
      paths = rows.map((r) => r.pathname);
    expect(paths).toEqual(
      expect.arrayContaining([
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
        "/large",
        "/slow",
      ]),
    );
    expect(paths).not.toContain("/UNAUTHORIZED");
    expect(paths).not.toContain("/PAUSED");
    expect(recorder.scan!.stats.pending).toBe(0);
    expect(recorder.scan!.stats.persisted).toBe(rows.length);
    expect(rows.find((r) => r.pathname === "/redirected")?.redirect_hop).toBe(
      1,
    );
    expect(rows.find((r) => r.pathname === "/slow")?.request_state).toBe(
      "incomplete",
    );
    expect(
      rows
        .find((r) => r.pathname === "/json")
        ?.query_params.filter((p) => p.name === "x")
        .map((p) => p.value),
    ).toEqual(["1", "2"]);
    for (const secret of [
      "secret-query",
      "secret-header",
      "secret-body",
      "secret-pass",
      "plain-sensitive-value",
    ])
      expect(JSON.stringify(rows)).not.toContain(secret);
    expect(
      rows.find((r) => r.pathname === "/large")?.capture_status.body.state,
    ).toBe("partial");
    expect(
      (await db.all<any>("groups", recorder.scan!.id)).some(
        (g) => g.count === 2 && g.normalized_url.includes("/same?"),
      ),
    ).toBe(true);
    await mkdir("work/browser", { recursive: true });
    await writeFile(
      "work/browser/cdp-result.json",
      JSON.stringify(
        {
          chrome: browser.version(),
          records: rows.length,
          paths,
          stats: recorder.scan!.stats,
          received,
          scope: "真实 CDP + fake-indexeddb；非 MV3 扩展安装验收",
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 20000);
