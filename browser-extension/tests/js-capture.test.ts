import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import {
  appendJS,
  jsPage,
  jsSource,
  removeJSScan,
  type JSEvent,
} from "../src/js-store";
const setup = async (enabled = true, source = "fetch('/orders?id=1')") => {
  const send = vi.fn(async (_s: any, method: string) =>
    method === "Debugger.getScriptSource" ? { scriptSource: source } : {},
  );
  const recorder = new Recorder(send);
  const scan = await recorder.create(
    "JS test",
    [{ id: 1, url: "https://fixture.test" }],
    {
      ...defaults(),
      collect_js: enabled,
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
  return { recorder, scan, send };
};
const parsed = (id: string, url = "https://fixture.test/app.js") => ({
  scriptId: id,
  url,
  executionContextId: 1,
  length: 30,
  startLine: 0,
  startColumn: 0,
});
it("old/default tasks do not fetch or persist JS", async () => {
  const { recorder, scan, send } = await setup(false);
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.js.drain();
  expect((await jsPage(scan.id)).count).toBe(0);
  expect(send.mock.calls.some((c) => c[1] === "Debugger.getScriptSource")).toBe(
    false,
  );
});
it("deduplicates multi-MiB sources while retaining page/session observations independently of Filter", async () => {
  const source = "/*" + "字".repeat(1048576) + "*/";
  const { recorder, scan, send } = await setup(true, source);
  await recorder.configure({ tabId: 1, sessionId: "worker" });
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.event(
    { tabId: 1, sessionId: "worker" },
    "Debugger.scriptParsed",
    parsed("1"),
  );
  await recorder.js.drain();
  const page = await jsPage(scan.id);
  expect(page.count).toBe(2);
  expect(new Set(page.events.map((e) => e.hash)).size).toBe(1);
  expect(new Set(page.events.map((e) => e.epoch)).size).toBe(2);
  expect(await jsSource(page.events[0].hash!)).toBe(source);
  expect(page.events.every((e) => e.data.network_match === "unknown")).toBe(
    true,
  );
  expect(send.mock.calls.some((c) => c[1].includes("attach"))).toBe(false);
  await removeJSScan(scan.id);
  expect(await jsSource(page.events[0].hash!)).toBeUndefined();
});
it("retains redirect/loader/context/load stack evidence without inventing a source binding", async () => {
  const { recorder, scan } = await setup();
  await recorder.event({ tabId: 1 }, "Runtime.executionContextCreated", {
    context: {
      id: 1,
      origin: "https://fixture.test",
      auxData: { frameId: "frame" },
    },
  });
  const request = {
    requestId: "load",
    type: "Script",
    frameId: "frame",
    loaderId: "nav",
    timestamp: 1,
    request: { url: "https://fixture.test/a.js", method: "GET" },
    initiator: {
      type: "script",
      stack: {
        callFrames: [
          {
            functionName: "load",
            scriptId: "0",
            url: "https://fixture.test/",
            lineNumber: 1,
            columnNumber: 0,
          },
        ],
      },
    },
  };
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", request);
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
    ...request,
    redirectResponse: { url: request.request.url, status: 302 },
    request: { ...request.request, url: "https://fixture.test/b.js" },
  });
  await recorder.event({ tabId: 1 }, "Network.loadingFailed", {
    requestId: "load",
    errorText: "cancelled",
  });
  await recorder.js.drain();
  const page = await jsPage(scan.id);
  expect(page.count).toBe(4);
  const loads = page.events.filter(
    (e) => e.kind === "Network.requestWillBeSent",
  );
  expect(loads.map((e) => e.data.redirect_hop)).toEqual([0, 1]);
  expect(loads[0].data.loader_id).toBe("nav");
  expect(loads[0].data.loading_stack.stack.callFrames[0].functionName).toBe(
    "load",
  );
  expect(page.events.at(-1)?.data.error).toBe("cancelled");
});
it("read failure and oversized source are explicit gaps in observations, never truncated source", async () => {
  const { recorder, scan, send } = await setup();
  send.mockImplementation(async (_s, method) => {
    if (method === "Debugger.getScriptSource") throw Error("source gone");
    return {};
  });
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", {
    ...parsed("2"),
    length: 20 * 1048576,
  });
  await recorder.js.drain();
  const events = (await jsPage(scan.id)).events;
  expect(events.map((e) => e.status)).toEqual([
    "source_unavailable",
    "source_over_budget",
  ]);
  expect(events.every((e) => !e.hash)).toBe(true);
});
it("outbox append is atomic/idempotent; budget never evicts unacknowledged bodies; deleting one task preserves shared objects", async () => {
  const event: JSEvent = {
    id: crypto.randomUUID(),
    scan_id: "quota-a",
    kind: "source",
    time: "",
    session_id: "root",
    epoch: "epoch",
    data: {},
    hash: "unique-test-hash",
    status: "pending_remote",
  };
  await appendJS(event, "full source");
  await appendJS(event, "full source");
  await appendJS(
    { ...event, id: crypto.randomUUID(), scan_id: "quota-b" },
    "full source",
  );
  await expect(
    appendJS(
      { ...event, id: crypto.randomUUID(), hash: "too-big" },
      "unmodified",
      { file: 2, content: 1000, metadata: 1000 },
    ),
  ).rejects.toThrow("预算");
  expect((await jsPage("quota-a")).count).toBe(1);
  await removeJSScan("quota-a");
  expect(await jsSource(event.hash!)).toBe("full source");
  await removeJSScan("quota-b");
  expect(await jsSource(event.hash!)).toBeUndefined();
});
it("JS reads do not block recorder event processing; pause drains accepted reads and admits no new sources", async () => {
  const { recorder, scan, send } = await setup();
  let finish!: (v: any) => void;
  send.mockImplementation(async (_s, method) =>
    method === "Debugger.getScriptSource"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {},
  );
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await new Promise((r) => setTimeout(r, 0));
  const paused = recorder.pause();
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("2"));
  finish({ scriptSource: "complete source" });
  await paused;
  expect((await jsPage(scan.id)).count).toBe(1);
});
it("queue is bounded and records backpressure without pausing request collection", async () => {
  const { recorder, scan } = await setup();
  for (let i = 0; i < 70; i++)
    await recorder.event(
      { tabId: 1 },
      "Debugger.scriptParsed",
      parsed(String(i)),
    );
  await recorder.js.drain();
  expect(scan.state).toBe("recording");
  expect(scan.gaps.some((g) => g.type === "js_backpressure")).toBe(true);
  expect((await jsPage(scan.id)).count).toBeLessThanOrEqual(64);
});
it("a replaced session never reads a queued scriptId from the new connection", async () => {
  const { recorder, scan, send } = await setup();
  // Hold the first read so the second script remains queued while session changes.
  let finish!: (v: any) => void;
  send.mockImplementation(async (_s, method) =>
    method === "Debugger.getScriptSource"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {},
  );
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("1"));
  await new Promise((r) => setTimeout(r, 0));
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", parsed("2"));
  recorder.js.session({ tabId: 1 });
  finish({ scriptSource: "old source" });
  await recorder.js.drain();
  const events = (await jsPage(scan.id)).events;
  expect(events.map((e) => e.status)).toEqual([
    "source_unavailable",
    "source_session_changed",
  ]);
  expect(events.every((e) => !e.hash)).toBe(true);
  expect(
    send.mock.calls.filter((c) => c[1] === "Debugger.getScriptSource"),
  ).toHaveLength(1);
});
it("pages are bounded and exclusive, metadata/content quota failures leave the store unchanged", async () => {
  const base: JSEvent = {
    id: "",
    scan_id: "paging-test",
    kind: "context",
    time: "",
    session_id: "root",
    epoch: "epoch",
    data: {},
    status: "pending_remote",
  };
  for (let i = 0; i < 55; i++)
    await appendJS({ ...base, id: `paging-${String(i).padStart(3, "0")}` });
  const first = await jsPage(base.scan_id);
  const next = await jsPage(base.scan_id, first.next);
  expect(first.events).toHaveLength(50);
  expect(next.events).toHaveLength(5);
  expect(new Set([...first.events, ...next.events].map((e) => e.id)).size).toBe(
    55,
  );
  await expect(
    appendJS({ ...base, id: "metadata-full" }, undefined, {
      file: 1000,
      content: 1e9,
      metadata: 1,
    }),
  ).rejects.toThrow("预算");
  await expect(
    appendJS({ ...base, id: "body-full", hash: "body-full" }, "body", {
      file: 1000,
      content: 0,
      metadata: 1e9,
    }),
  ).rejects.toThrow("预算");
  expect((await jsPage(base.scan_id)).count).toBe(55);
  expect(await jsSource("body-full")).toBeUndefined();
  await removeJSScan(base.scan_id);
});
