import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import { RemoteCapture, type CaptureEvent } from "../src/remote-capture";
import * as db from "../src/store";
class MemoryReceiver extends RemoteCapture {
  events: CaptureEvent[] = [];
  sources = new Map<string, string>();
  constructor() {
    super(() => undefined);
  }
  override requestCount(scan: string) {
    return this.events.filter(
      (e) => e.scan_id === scan && e.kind === "ObservedRequest",
    ).length;
  }
  override async send(event: CaptureEvent, source?: string) {
    this.events.push(JSON.parse(JSON.stringify(event)));
    if (event.hash && source !== undefined)
      this.sources.set(event.hash, source);
  }
}
const setup = async (enabled = true, source = "fetch('/orders?id=1')") => {
  const send = vi.fn(async (_s: any, method: string) =>
    method === "Debugger.getScriptSource" ? { scriptSource: source } : {},
  );
  const receiver = new MemoryReceiver();
  const recorder = new Recorder(send, receiver);
  const scan = await recorder.create(
    "JS test",
    [{ id: 1, url: "https://fixture.test" }],
    {
      ...defaults(),
      collect_js: enabled,
      remote_capture: enabled
        ? { url: "http://127.0.0.1:8379", project: "default" }
        : undefined,
      filter: {
        include: {
          field: "url",
          operator: "contains",
          values: ["never-match"],
        },
      },
    },
  );
  await recorder.configure({ tabId: 1 });
  return { recorder, scan, send, receiver };
};
const parsed = (id: string) => ({
  scriptId: id,
  url: "https://fixture.test/app.js",
  executionContextId: 1,
  length: 30,
  startLine: 0,
  startColumn: 0,
});
it("old/default tasks do not collect JS", async () => {
  const { recorder, send, receiver } = await setup(false);
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.js.drain();
  expect(receiver.events).toEqual([]);
  expect(send.mock.calls.some((c) => c[1] === "Debugger.getScriptSource")).toBe(
    false,
  );
});
it("multi-MiB identical bodies retain independent observations and do not create any local JS database", async () => {
  const source = "/*" + "字".repeat(1048576) + "*/";
  const { recorder, receiver } = await setup(true, source);
  await recorder.configure({ tabId: 1, sessionId: "worker" });
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.event(
    { tabId: 1, sessionId: "worker" },
    "Debugger.scriptParsed",
    parsed("1"),
  );
  await recorder.js.drain();
  expect(
    receiver.events.filter((e) => e.kind === "Debugger.scriptParsed"),
  ).toHaveLength(2);
  expect(receiver.sources.size).toBe(1);
  expect([...receiver.sources.values()].every(s=>s===source)).toBe(true);
  expect(
    new Set(
      receiver.events
        .filter((e) => e.kind === "Debugger.scriptParsed")
        .map((e) => e.epoch),
    ).size,
  ).toBe(2);
  expect(
    (await indexedDB.databases()).some(
      (d) => d.name === "js-security-js-outbox",
    ),
  ).toBe(false);
});
it("retains original loading CDP fields, context, redirect and resolved loading stack", async () => {
  const { recorder, receiver } = await setup();
  await recorder.event({ tabId: 1 }, "Runtime.executionContextCreated", {
    context: { id: 1, auxData: { frameId: "f" } },
  });
  const p = {
    requestId: "r",
    type: "Script",
    frameId: "f",
    loaderId: "navigation",
    documentURL: "https://fixture.test/",
    request: {
      url: "https://fixture.test/a.js",
      method: "GET",
      headers: { "x-original": "value" },
    },
    initiator: {
      type: "script",
      stack: {
        callFrames: [
          {
            functionName: "load",
            scriptId: "0",
            url: "https://fixture.test/",
            lineNumber: 0,
            columnNumber: 0,
          },
        ],
      },
    },
  };
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", p);
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
    ...p,
    redirectResponse: { url: p.request.url, status: 302 },
  });
  await recorder.event({ tabId: 1 }, "Network.loadingFailed", {
    requestId: "r",
    errorText: "cancelled",
  });
  await recorder.js.drain();
  const events = receiver.events.filter((e) => e.kind !== "TaskStarted");
  expect(events).toHaveLength(4);
  expect(events[1].data.cdp).toEqual(p);
  expect(events[1].data.loading_stack.stack.callFrames[0].functionName).toBe(
    "load",
  );
  expect(events[2].data.redirect_hop).toBe(1);
  expect(events[3].data.error).toBe("cancelled");
});
it("source failure and size budget produce explicit missing-source observations", async () => {
  const { recorder, send, receiver } = await setup();
  send.mockImplementation(async (_s, method) => {
    if (method === "Debugger.getScriptSource") throw Error("gone");
    return {};
  });
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", {
    ...parsed("2"),
    length: 65 * 1048576,
  });
  await recorder.js.drain();
  expect(
    receiver.events
      .filter((e) => e.kind === "Debugger.scriptParsed")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => e.status),
  ).toEqual(["source_unavailable", "source_over_budget"]);
  expect(
    receiver.events
      .filter((e) => e.kind === "Debugger.scriptParsed")
      .every((e) => !e.hash),
  ).toBe(true);
});
it("pause drains in-flight reads and a new connection never reuses queued script IDs", async () => {
  const { recorder, send, receiver } = await setup();
  const pending: Array<() => void> = [];
  send.mockImplementation((_s, method) => {
    if (method !== "Debugger.getScriptSource") return Promise.resolve({});
    return new Promise((resolve) => {
      pending.push(() => resolve({ scriptSource: "old source" }));
    });
  });
  for (let i = 0; i < 5; i++)
    void recorder.event(
      { tabId: 1 },
      "Debugger.scriptParsed",
      parsed(String(i)),
    );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pending).toHaveLength(4); // Four reads in flight, one admitted but queued.
  recorder.js.session({ tabId: 1 });
  const paused = recorder.pause();
  for (let i = 0; i < 10 && pending.length; i++) {
    pending.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await paused;
  expect(
    receiver.events
      .filter((e) => e.kind === "Debugger.scriptParsed")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => e.status),
  ).toEqual([
    "source_unavailable",
    "source_unavailable",
    "source_unavailable",
    "source_unavailable",
    "source_session_changed",
  ]);
  // The queued read never starts under the new epoch, so only four sources are fetched.
  expect(
    send.mock.calls.filter((c) => c[1] === "Debugger.getScriptSource"),
  ).toHaveLength(4);
});
it("reads independent scripts concurrently and keeps the whole burst", async () => {
  const { recorder, receiver, send } = await setup();
  let inFlight = 0,
    peak = 0;
  send.mockImplementation(async (_s: any, method: string) => {
    if (method !== "Debugger.getScriptSource") return {};
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return { scriptSource: "concurrent" };
  });
  for (let i = 0; i < 8; i++)
    void recorder.event(
      { tabId: 1 },
      "Debugger.scriptParsed",
      parsed(String(i)),
    );
  await recorder.js.drain();
  expect(peak).toBe(4);
  expect(
    receiver.events.filter((e) => e.kind === "Debugger.scriptParsed"),
  ).toHaveLength(8);
});
it("JS queue overflow drops events with a gap without pausing API capture", async () => {
  const { recorder, scan, receiver } = await setup();
  scan.config.queue_count = 10;
  for (let i = 0; i < 70; i++)
    void recorder.event(
      { tabId: 1 },
      "Debugger.scriptParsed",
      parsed(String(i)),
    );
  await recorder.js.drain();
  const gaps = scan.gaps.filter((g) => g.type === "js_backpressure");
  expect(gaps).toHaveLength(1); // Dropped events collapse into one counted gap.
  expect(gaps[0].count).toBeGreaterThan(1);
  expect(scan.state).toBe("recording");
  expect(
    receiver.events.filter((e) => e.kind === "Debugger.scriptParsed").length,
  ).toBeLessThanOrEqual(10);
});
it("remote request payloads and active snapshots never reach local request/initiator stores", async () => {
  const { recorder, scan, receiver } = await setup();
  scan.config.filter = {};
  scan.versions[0].config.filter = {};
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
    requestId: "api",
    type: "Fetch",
    request: {
      url: "https://fixture.test/api?x=1",
      method: "GET",
      headers: {},
    },
    timestamp: 1,
    wallTime: 1,
  });
  await recorder.flush();
  expect(await db.all("active", scan.id)).toEqual([]);
  await recorder.event({ tabId: 1 }, "Network.loadingFailed", {
    requestId: "api",
    errorText: "fixture",
  });
  await recorder.stop();
  expect(
    receiver.events.filter((e) => e.kind === "ObservedRequest"),
  ).toHaveLength(1);
  expect(await db.all("requests", scan.id)).toEqual([]);
  expect(await db.all("initiator_nodes", scan.id)).toEqual([]);
  expect(await db.all("groups", scan.id)).toEqual([]);
});
