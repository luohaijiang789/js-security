import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  defaults,
  type Config,
  type RecordEntry,
  type Scan,
} from "../src/model";

type Listener = (...args: any[]) => unknown;
let onMessage: Listener,
  onCreated: Listener,
  onUpdated: Listener,
  onRemoved: Listener,
  onDetach: Listener,
  onEvent: Listener;
let tabs: Map<number, chrome.tabs.Tab>, owned: Set<number>, mock: any;
const config = (): Config => ({
  ...defaults(),
  stop_wait_ms: 0,
  archive: { ...defaults().archive, enabled: false },
});
const tab = (id: number, url: string, windowId = 1) =>
  ({ id, url, windowId }) as chrome.tabs.Tab;
async function rpc(type: string, data: object = {}) {
  return new Promise<{ ok: boolean; result?: any; error?: string }>((resolve) =>
    onMessage({ type, ...data }, { id: "scope-test-extension" }, resolve),
  );
}
async function state() {
  const response = await rpc("state");
  expect(response.ok).toBe(true);
  return response.result.scan as Scan;
}
async function start(c = config()) {
  const response = await rpc("start", {
    name: "browser scope fixture",
    config: c,
  });
  expect(response.ok, response.error).toBe(true);
  return response.result as Scan;
}
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Browser scope condition did not settle");
}
async function load() {
  await import("../src/background");
  await rpc("state");
}
function emitRequest(tabId: number, id: string, path: string) {
  onEvent({ tabId }, "Network.requestWillBeSent", {
    requestId: id,
    wallTime: 1792663200,
    frameId: "frame-" + tabId,
    documentURL: "https://fixture.test/page-" + tabId,
    type: "Fetch",
    request: {
      url: "https://api-" + tabId + ".test" + path,
      method: "GET",
      headers: { Accept: "application/json" },
    },
  });
  onEvent({ tabId }, "Network.responseReceived", {
    requestId: id,
    hasExtraInfo: false,
    response: { status: 200 },
  });
  onEvent({ tabId }, "Network.loadingFinished", { requestId: id });
}

beforeEach(() => {
  vi.resetModules();
  tabs = new Map();
  owned = new Set();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  // Drive public RPC/events explicitly; the periodic maintenance loop is not under test.
  vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as any);
  mock = {
    runtime: {
      id: "scope-test-extension",
      getURL: (path: string) =>
        "chrome-extension://scope-test-extension/" + path,
      onMessage: {
        addListener: (listener: Listener) => {
          onMessage = listener;
        },
      },
    },
    action: { onClicked: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => tabs.get(id)),
      create: vi.fn(async () => ({ id: 99 })),
      onCreated: {
        addListener: (listener: Listener) => {
          onCreated = listener;
        },
      },
      onUpdated: {
        addListener: (listener: Listener) => {
          onUpdated = listener;
        },
      },
      onRemoved: {
        addListener: (listener: Listener) => {
          onRemoved = listener;
        },
      },
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (owned.has(tabId)) throw Error("already attached");
        owned.add(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (!owned.delete(tabId)) throw Error("not attached");
        onDetach({ tabId }, "canceled_by_user");
      }),
      getTargets: vi.fn(async () =>
        [...owned].map((tabId) => ({ tabId, id: "target-" + tabId })),
      ),
      sendCommand: vi.fn(
        async ({ tabId }: { tabId: number }, _method: string) => {
          if (!owned.has(tabId)) throw Error("not attached");
          return {};
        },
      ),
      onDetach: {
        addListener: (listener: Listener) => {
          onDetach = listener;
        },
      },
      onEvent: {
        addListener: (listener: Listener) => {
          onEvent = listener;
        },
      },
    },
    alarms: {
      create: vi.fn(async () => {}),
      onAlarm: { addListener: vi.fn() },
    },
    downloads: {
      onChanged: { addListener: vi.fn() },
      search: vi.fn(async () => []),
    },
    storage: {
      local: { set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})) },
    },
    permissions: { contains: vi.fn(async () => true) },
  };
  vi.stubGlobal("chrome", mock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser-wide capture through public background RPC and Chrome events", () => {
  it("starts all-scope with no tabs or scope payload, even when there are no pages", async () => {
    await load();
    const scan = await start();
    expect(scan.tab_scope).toBe("all");
    expect(scan.state).toBe("recording");
    expect(scan.tabs).toEqual([]);
    expect(mock.tabs.query).toHaveBeenCalledWith({});
    expect(mock.tabs.get).not.toHaveBeenCalled();
    expect(mock.debugger.attach).not.toHaveBeenCalled();
  });
  it("queries every window and initially attaches only HTTP/HTTPS pages", async () => {
    tabs.set(1, tab(1, "https://first.test/", 1));
    tabs.set(2, tab(2, "http://second.test/", 2));
    tabs.set(3, tab(3, "chrome://extensions/", 2));
    tabs.set(
      4,
      tab(4, "chrome-extension://scope-test-extension/index.html", 1),
    );
    tabs.set(5, tab(5, "about:blank", 3));
    tabs.set(6, tab(6, "file:///tmp/input.html", 3));
    await load();
    const scan = await start();
    expect(scan.tabs.map((t) => t.id).sort()).toEqual([1, 2]);
    expect([...owned].sort()).toEqual([1, 2]);
    expect(
      mock.debugger.attach.mock.calls
        .map((args: any[]) => args[0].tabId)
        .sort(),
    ).toEqual([1, 2]);
    expect(
      mock.tabs.query.mock.calls.every(
        (args: any[]) => JSON.stringify(args[0]) === "{}",
      ),
    ).toBe(true);
    expect(mock.tabs.get).not.toHaveBeenCalled();
  });
  it("observes about:blank to HTTPS navigation and deduplicates repeated browser events", async () => {
    tabs.set(1, tab(1, "https://first.test/"));
    await load();
    await start();
    const blank = tab(3, "about:blank", 2);
    tabs.set(3, blank);
    onCreated(blank);
    onUpdated(3, { url: "about:blank", status: "loading" }, blank);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(owned.has(3)).toBe(false);
    const page = tab(3, "https://new-page.test/business", 2);
    tabs.set(3, page);
    onUpdated(3, { url: page.url, status: "loading" }, page);
    onUpdated(3, { status: "complete" }, page);
    onCreated(page);
    await until(
      async () => owned.has(3) && (await state()).tabs.some((t) => t.id === 3),
    );
    // A control operation is a barrier for the already queued browser changes.
    const scan = await state();
    expect((await rpc("pause", { id: scan.id })).ok).toBe(true);
    expect(
      mock.debugger.attach.mock.calls.filter(
        (args: any[]) => args[0].tabId === 3,
      ),
    ).toHaveLength(1);
    expect((await state()).tabs.filter((t) => t.id === 3)).toHaveLength(1);
  });
  it("closing one page records its gap while another page continues to capture", async () => {
    tabs.set(1, tab(1, "https://first.test/"));
    tabs.set(2, tab(2, "https://second.test/", 2));
    await load();
    const scan = await start();
    tabs.delete(1);
    owned.delete(1);
    onRemoved(1, { windowId: 1, isWindowClosing: false });
    await until(async () =>
      (await state()).gaps.some((g) => g.type === "tab_closed"),
    );
    emitRequest(1, "closed-event", "/must-not-save");
    emitRequest(2, "continuing", "/business");
    expect((await rpc("flush", { id: scan.id })).ok).toBe(true);
    const db = await import("../src/store");
    const records = await db.page(scan.id);
    expect(records.map((r) => r.cdp_request_id)).toEqual(["continuing"]);
    expect(records[0].tab_id).toBe(2);
    expect((await state()).state).toBe("recording");
    expect(owned.has(2)).toBe(true);
  });
  it("does not attach newly opened pages while paused and rescans them on resume", async () => {
    tabs.set(1, tab(1, "https://first.test/"));
    await load();
    const scan = await start();
    await rpc("pause", { id: scan.id });
    const page = tab(2, "https://opened-while-paused.test/", 2);
    tabs.set(2, page);
    onCreated(page);
    onUpdated(2, { url: page.url, status: "complete" }, page);
    expect((await state()).state).toBe("paused");
    expect(owned.has(2)).toBe(false);
    expect(
      mock.debugger.attach.mock.calls.filter(
        (args: any[]) => args[0].tabId === 2,
      ),
    ).toHaveLength(0);
    const resumed = await rpc("resume", { id: scan.id });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(owned.has(2)).toBe(true);
    expect((await state()).tabs.some((t) => t.id === 2)).toBe(true);
    expect((await state()).state).toBe("recording");
  });
  it("does not reattach pages after stopping the browser-wide task", async () => {
    tabs.set(1, tab(1, "https://first.test/"));
    await load();
    const scan = await start();
    expect((await rpc("stop", { id: scan.id })).ok).toBe(true);
    const calls = mock.debugger.attach.mock.calls.length;
    const page = tab(3, "https://after-stop.test/");
    tabs.set(3, page);
    onCreated(page);
    onUpdated(3, { url: page.url, status: "complete" }, page);
    expect((await state()).state).toBe("ended");
    expect(mock.debugger.attach).toHaveBeenCalledTimes(calls);
    expect(owned.size).toBe(0);
  });
  it("applies the same Filter across pages rather than retaining every observed request", async () => {
    tabs.set(1, tab(1, "https://first.test/"));
    tabs.set(2, tab(2, "https://second.test/", 2));
    await load();
    const c = config();
    c.filter = {
      exclude: {
        field: "pathname",
        operator: "starts_with",
        values: ["/telemetry"],
      },
    };
    const scan = await start(c);
    emitRequest(1, "first-business", "/orders");
    emitRequest(2, "excluded-telemetry", "/telemetry/ping");
    emitRequest(2, "second-business", "/profile");
    expect((await rpc("flush", { id: scan.id })).ok).toBe(true);
    const db = await import("../src/store");
    const records = (await db.page(scan.id)) as RecordEntry[];
    expect(records.map((r) => r.cdp_request_id).sort()).toEqual([
      "first-business",
      "second-business",
    ]);
    expect(new Set(records.map((r) => r.tab_id))).toEqual(new Set([1, 2]));
    const saved = await state();
    expect(saved.stats.observed).toBe(3);
    expect(saved.stats.matched).toBe(2);
    expect(saved.stats.excluded).toBe(1);
    expect(saved.stats.persisted).toBe(2);
  });
});
