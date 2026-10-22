import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import * as db from "../src/store";
import { jsonl, packageFiles } from "../src/export";

type ProtocolEvent = { method: string; params: any; sessionId?: string };
// Playwright newPage() enables Runtime itself and hides the one-frame production bug.
// Use a fresh native Chromium process and raw CDP, without any page instrumentation.
class RawCDP {
  private id = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  listeners = new Set<(event: ProtocolEvent) => void>();
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Raw CDP timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(Error("Raw CDP connection closed"));
    }
    this.pending.clear();
    this.socket.close();
  }
}
let process: ChildProcess,
  directory: string,
  server: Server,
  origin: string,
  cdp: RawCDP;
let chromeVersion: string;
const expression = `(async function checkoutScenario() {
  function checkoutDispatch(depth) {
    if (depth) return checkoutDispatch(depth - 1);
    return fetch('/capture-sync');
  }
  function checkoutPromiseLeaf() { return checkoutDispatch(35); }
  function checkoutPromiseMiddle() { return Promise.resolve().then(checkoutPromiseLeaf); }
  function checkoutPromiseRoot() { return Promise.resolve().then(checkoutPromiseMiddle); }
  await checkoutDispatch(35);
  await Promise.resolve().then(checkoutPromiseRoot);
})()
//# sourceURL=https://fixture.test/assets/checkout-stack-fixture.js`;
const nodes = (stack: any): any[] =>
  stack ? [stack, ...nodes(stack.parent)] : [];
const signature = (stack: any) =>
  nodes(stack).map((node) => ({
    description: node.description ?? null,
    frames: node.callFrames.map((frame: any) => ({
      functionName: frame.functionName,
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
      scriptId: frame.scriptId,
    })),
  }));
const summary = (stack: any) =>
  nodes(stack).map((node) => ({
    frames: node.callFrames.length,
    description: node.description ?? null,
    functions: node.callFrames.map((f: any) => f.functionName),
    ...(node.parentId ? { parentId: node.parentId } : {}),
  }));

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/" ? "text/html" : "text/plain",
    );
    response.end(
      request.url === "/"
        ? "<!doctype html><title>Native CDP stack fixture</title>"
        : "ok",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  directory = await mkdtemp(join(tmpdir(), "recorder-stack-cdp-"));
  process = spawn(
    globalThis.process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number(
        (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!port) throw Error("Native Chromium remote debugging did not start");
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  chromeVersion = version.Browser;
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(Error("Raw Chromium CDP socket failed")),
      { once: true },
    );
  });
  cdp = new RawCDP(socket);
}, 15000);
afterAll(async () => {
  cdp?.close();
  if (process && process.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      process.once("exit", () => resolve()),
    );
    process.kill();
    await exited;
  }
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function target() {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method: string, params?: object) =>
    cdp.send(method, params, sessionId);
  await send("Page.enable");
  const loaded = new Promise<void>((resolve) => {
    const listener = (event: ProtocolEvent) => {
      if (
        event.sessionId === sessionId &&
        event.method === "Page.loadEventFired"
      ) {
        cdp.listeners.delete(listener);
        resolve();
      }
    };
    cdp.listeners.add(listener);
  });
  await send("Page.navigate", { url: origin });
  await loaded;
  return {
    sessionId,
    send,
    close: () => cdp.send("Target.closeTarget", { targetId }),
  };
}

it("native Chromium reproduces one-frame defaults and independently proves synchronous and Promise parent depth controls", async () => {
  const report: Record<string, unknown> = {};
  for (const profile of [
    "baseline",
    "runtime",
    "debugger",
    "configured",
  ] as const) {
    const page = await target();
    const captured: any[] = [];
    const listener = (event: ProtocolEvent) => {
      if (
        event.sessionId === page.sessionId &&
        event.method === "Network.requestWillBeSent" &&
        event.params.request.url.includes("/capture-sync")
      )
        captured.push(event.params.initiator.stack);
    };
    cdp.listeners.add(listener);
    try {
      await page.send("Network.enable");
      if (profile === "runtime" || profile === "configured") {
        await page.send("Runtime.enable");
        await page.send("Runtime.setMaxCallStackSizeToCapture", { size: 200 });
      }
      if (profile === "debugger" || profile === "configured") {
        await page.send("Debugger.enable");
        await page.send("Debugger.setSkipAllPauses", { skip: true });
        await page.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
      }
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
      });
      expect(result.exceptionDetails).toBeUndefined();
      expect(captured).toHaveLength(2);
      const [sync, promise] = captured;
      report[profile] = { sync: summary(sync), promise: summary(promise) };
      if (profile === "baseline" || profile === "debugger") {
        expect(sync.callFrames).toHaveLength(1);
        expect(promise.callFrames).toHaveLength(1);
      } else {
        for (const stack of captured)
          expect(
            stack.callFrames.filter(
              (frame: any) => frame.functionName === "checkoutDispatch",
            ),
          ).toHaveLength(36);
        expect(
          sync.callFrames.some(
            (frame: any) => frame.functionName === "checkoutScenario",
          ),
        ).toBe(true);
        expect(
          promise.callFrames.some(
            (frame: any) => frame.functionName === "checkoutPromiseLeaf",
          ),
        ).toBe(true);
      }
      if (profile === "baseline" || profile === "runtime")
        expect(promise.parent).toBeUndefined();
      else {
        expect(
          nodes(promise).filter((node) => node.description === "Promise.then"),
        ).toHaveLength(3);
        expect(
          nodes(promise).some((node) => node.description === "await"),
        ).toBe(true);
        const names = nodes(promise).flatMap((node) =>
          node.callFrames.map((frame: any) => frame.functionName),
        );
        expect(names).toEqual(
          expect.arrayContaining([
            "checkoutPromiseMiddle",
            "checkoutPromiseRoot",
            "checkoutScenario",
          ]),
        );
      }
    } finally {
      cdp.listeners.delete(listener);
      await page.close();
    }
  }
  await mkdir("work/browser", { recursive: true });
  await writeFile(
    "work/browser/call-stack-cdp-result.json",
    JSON.stringify(
      {
        chrome: chromeVersion,
        scope:
          "原生 Chromium raw CDP；无 Playwright 页面预配置；非真实 MV3 安装验收",
        fixture: "35 层 checkoutDispatch 递归；3 层 Promise.then 与 await",
        profiles: report,
      },
      null,
      2,
    ),
  );
}, 20000);

it("Recorder preserves every Chromium-observable sync and asynchronous frame in IndexedDB and JSONL/ZIP, without pausing debugger statements", async () => {
  const page = await target();
  const recorder = new Recorder(async (_source, method, params) => {
    if (method === "Target.setAutoAttach") return {}; // Child-target attachment is covered separately.
    return page.send(method, params);
  });
  await recorder.create(
    "Native CDP full-stack persistence",
    [{ id: 1, url: origin }],
    {
      ...defaults(),
      stop_wait_ms: 100,
      archive: { ...defaults().archive, enabled: false },
    },
  );
  const captured: any[] = [];
  const eventErrors: unknown[] = [];
  let tail = Promise.resolve();
  let pauses = 0;
  const listener = (event: ProtocolEvent) => {
    if (event.sessionId !== page.sessionId) return;
    if (event.method === "Debugger.paused") {
      pauses++;
      // Ensure a regression produces an assertion instead of hanging this browser.
      void page.send("Debugger.resume");
    }
    if (!event.method.startsWith("Network.")) return;
    if (
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.includes("/capture-sync")
    )
      captured.push({
        requestId: event.params.requestId,
        stack: event.params.initiator.stack,
      });
    tail = tail
      .then(() => recorder.event({ tabId: 1 }, event.method, event.params))
      .catch((error) => {
        eventErrors.push(error);
      });
  };
  cdp.listeners.add(listener);
  try {
    await recorder.configure({ tabId: 1 });
    const breakpoint = await page.send("Runtime.evaluate", {
      expression:
        "(function checkoutDebuggerStatement(){ debugger; return 'business-continued'; })()",
      returnByValue: true,
    });
    expect(breakpoint.result.value).toBe("business-continued");
    expect(pauses).toBe(0);
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
    });
    expect(result.exceptionDetails).toBeUndefined();
    await tail;
    await recorder.stop();
    expect(eventErrors).toEqual([]);
    const rows = (await db.page(recorder.scan!.id)).filter(
      (row) => row.pathname === "/capture-sync",
    );
    expect(rows).toHaveLength(2);
    expect(captured).toHaveLength(2);
    for (const row of rows) {
      const raw = captured.find(
        (entry) => entry.requestId === row.cdp_request_id,
      );
      expect(raw).toBeDefined();
      expect(signature(row.initiator_stack)).toEqual(signature(raw.stack));
      expect(
        (row.initiator_stack as any).callFrames.filter(
          (frame: any) => frame.functionName === "checkoutDispatch",
        ),
      ).toHaveLength(36);
      expect(row.capture_status.stack.state).toBe("complete");
    }
    const asyncRow = rows.find((row) =>
      nodes(row.initiator_stack).some(
        (node) => node.description === "Promise.then",
      ),
    );
    expect(asyncRow).toBeDefined();
    expect(
      nodes(asyncRow!.initiator_stack).filter(
        (node) => node.description === "Promise.then",
      ),
    ).toHaveLength(3);
    expect(
      nodes(asyncRow!.initiator_stack).some(
        (node) => node.description === "await",
      ),
    ).toBe(true);
    const exportedJSONL = jsonl(rows)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const files = unzipSync(await packageFiles(recorder.scan!));
    const exportedZIP = Object.entries(files)
      .filter(([name]) => /^requests_\d+\.jsonl$/.test(name))
      .flatMap(([, bytes]) =>
        strFromU8(bytes)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    for (const exported of [exportedJSONL, exportedZIP])
      for (const row of rows)
        expect(
          exported.find((entry) => entry.request_id === row.request_id)
            ?.initiator_stack,
        ).toEqual(row.initiator_stack);
    const reportPath = "work/browser/call-stack-cdp-result.json";
    const report = await readFile(reportPath, "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => ({ chrome: chromeVersion }));
    report.recorder = {
      storage: "真实 CDP + fake-indexeddb；非 MV3 安装验收",
      debuggerPauses: pauses,
      requests: rows.map((row) => ({
        frames: summary(row.initiator_stack),
        captureStatus: row.capture_status.stack,
      })),
      rawFramesPreservedExactly: true,
      jsonlFramesPreservedExactly: true,
      zipFramesPreservedExactly: true,
    };
    await mkdir("work/browser", { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  } finally {
    cdp.listeners.delete(listener);
    await page.close();
  }
}, 20000);

it("native Chromium accepts skip-all-pauses before Debugger.enable and preserves it across enable", async () => {
  const page = await target();
  let pauses = 0;
  const listener = (event: ProtocolEvent) => {
    if (
      event.sessionId === page.sessionId &&
      event.method === "Debugger.paused"
    ) {
      pauses++;
      void page.send("Debugger.resume");
    }
  };
  cdp.listeners.add(listener);
  try {
    // No Debugger.enable has occurred in this fresh, uninstrumented target/session.
    const prearm = await page.send("Debugger.setSkipAllPauses", { skip: true });
    expect(prearm).toEqual({});
    await page.send("Debugger.enable");
    const result = await page.send("Runtime.evaluate", {
      expression:
        "(function highFrequencyBusiness(){ for(let i=0; i<100; i++){ debugger; } return 'all-100-debugger-statements-continued'; })()",
      returnByValue: true,
    });
    expect(result.result.value).toBe("all-100-debugger-statements-continued");
    expect(result.exceptionDetails).toBeUndefined();
    expect(pauses).toBe(0);
    await mkdir("work/browser", { recursive: true });
    await writeFile(
      "work/browser/debugger-prearm-result.json",
      JSON.stringify(
        {
          chrome: chromeVersion,
          scope:
            "原生 Chromium raw CDP，新建目标/会话，无 Playwright 页面预配置",
          commands: [
            "Debugger.setSkipAllPauses(skip:true)",
            "Debugger.enable",
            "Runtime.evaluate(100 debugger statements)",
          ],
          prearmAccepted: true,
          debuggerPauses: pauses,
          businessResult: result.result.value,
        },
        null,
        2,
      ),
    );
  } finally {
    cdp.listeners.delete(listener);
    await page.close();
  }
}, 15000);
