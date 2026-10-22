import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { defaults, type Scan } from "../src/model";

type Listener = (...args: any[]) => unknown;
let messageListener: Listener,
  detachListener: Listener,
  eventListener: Listener,
  actionListener: Listener;
let chromeMock: any,
  owned: Set<number>,
  failAttach: Set<number>,
  unsupportedChild: Set<number>;
let intervals: ReturnType<typeof setInterval>[] = [];
let intervalCallbacks: Listener[] = [];
const originalInterval = globalThis.setInterval;
const config = () => ({
  ...defaults(),
  stop_wait_ms: 0,
  archive: { ...defaults().archive, enabled: false },
});
async function rpc(type: string, data: object = {}) {
  return new Promise<{ ok: boolean; result?: any; error?: string }>((resolve) =>
    messageListener({ type, ...data }, { id: "test-extension" }, resolve),
  );
}
async function started(tabs = [1]) {
  const result = await rpc("start", {
    name: "controlled task",
    tabs,
    config: config(),
  });
  expect(result.ok).toBe(true);
  return result.result as Scan;
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("condition not reached");
}
async function loadBackground() {
  await import("../src/background");
  await rpc("state");
}

beforeEach(() => {
  vi.resetModules();
  owned = new Set();
  failAttach = new Set();
  unsupportedChild = new Set();
  intervals = [];
  intervalCallbacks = [];
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: any[]) => {
    intervalCallbacks.push(args[0]);
    const timer = (originalInterval as any)(...args);
    intervals.push(timer);
    return timer;
  }) as typeof setInterval);
  chromeMock = {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => "chrome-extension://test-extension/" + path,
      onMessage: {
        addListener: (listener: Listener) => {
          messageListener = listener;
        },
      },
    },
    action: {
      onClicked: {
        addListener: (listener: Listener) => {
          actionListener = listener;
        },
      },
    },
    debugger: {
      onDetach: {
        addListener: (listener: Listener) => {
          detachListener = listener;
        },
      },
      onEvent: {
        addListener: (listener: Listener) => {
          eventListener = listener;
        },
      },
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (failAttach.has(tabId)) throw Error("cannot attach");
        if (owned.has(tabId)) throw Error("already attached");
        owned.add(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (!owned.has(tabId)) throw Error("not attached");
        owned.delete(tabId);
        detachListener({ tabId }, "canceled_by_user");
      }),
      getTargets: vi.fn(async () =>
        [...owned].map((tabId) => ({ tabId, id: "target-" + tabId })),
      ),
      sendCommand: vi.fn(
        async ({ tabId }: { tabId: number }, method: string) => {
          if (!owned.has(tabId)) throw Error("not attached");
          if (method === "Target.setAutoAttach" && unsupportedChild.has(tabId))
            throw Error("unsupported");
          return {};
        },
      ),
    },
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        url: "https://fixture.test/" + id,
      })),
      create: vi.fn(async () => ({ id: 99 })),
    },
    alarms: {
      create: vi.fn(async () => {}),
      onAlarm: { addListener: vi.fn() },
    },
    storage: {
      local: { set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})) },
    },
    downloads: {
      onChanged: { addListener: vi.fn() },
      search: vi.fn(async () => []),
    },
    permissions: { contains: vi.fn(async () => true) },
  };
  vi.stubGlobal("chrome", chromeMock);
});
afterEach(() => {
  intervals.forEach(clearInterval);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background task identity and control ordering", () => {
  it("toolbar action opens the management tab and keeps the source tab identity", async () => {
    await loadBackground();
    actionListener({ id: 42, url: "https://fixture.test/page" });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test-extension/index.html?sourceTab=42",
    });
    actionListener({ id: 43, url: "chrome://extensions/" });
    expect(chromeMock.tabs.create).toHaveBeenLastCalledWith({
      url: "chrome-extension://test-extension/index.html",
    });
  });
  it("stale management page cannot pause another task", async () => {
    await loadBackground();
    const a = await started();
    expect((await rpc("stop", { id: a.id })).ok).toBe(true);
    const b = await started([2]);
    const stale = await rpc("pause", { id: a.id });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("任务已切换");
    expect((await rpc("state")).result.scan.state).toBe("recording");
    expect((await rpc("pause", { id: b.id })).ok).toBe(true);
    expect((await rpc("state")).result.scan.state).toBe("paused");
  });
  it("ended task cannot be revived by pause or config update", async () => {
    await loadBackground();
    const scan = await started();
    await rpc("stop", { id: scan.id });
    expect((await rpc("pause", { id: scan.id })).ok).toBe(false);
    expect((await rpc("update", { id: scan.id, config: config() })).ok).toBe(
      false,
    );
    const state = (await rpc("state")).result.scan;
    expect(state.state).toBe("ended");
    expect(state.versions).toHaveLength(1);
  });
  it("stop and pause serialize while state reads still report draining promptly", async () => {
    await loadBackground();
    const scan = await started();
    await rpc("update", {
      id: scan.id,
      config: { ...config(), stop_wait_ms: 100 },
    });
    eventListener({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "inflight",
      type: "Fetch",
      documentURL: "https://fixture.test/1",
      request: { url: "https://api.test/pending", method: "GET", headers: {} },
    });
    const stop = rpc("stop", { id: scan.id });
    await waitFor(
      async () => (await rpc("state")).result.scan.state === "draining",
    );
    const pause = rpc("pause", { id: scan.id });
    const result = await Promise.race([
      rpc("state"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Error("state was blocked by stop")), 100),
      ),
    ]);
    expect(result.result.scan.state).toBe("draining");
    expect((await stop).ok).toBe(true);
    expect((await pause).ok).toBe(false);
    expect((await rpc("state")).result.scan.state).toBe("ended");
  });
  it("resume reuses still-owned targets and reconnects only the detached target", async () => {
    await loadBackground();
    const scan = await started([1, 2]);
    owned.delete(1);
    detachListener({ tabId: 1 }, "target_closed");
    await waitFor(
      async () => (await rpc("state")).result.scan.state === "interrupted",
    );
    expect((await rpc("resume", { id: scan.id })).ok).toBe(true);
    expect(chromeMock.debugger.detach).not.toHaveBeenCalled();
    expect(
      chromeMock.debugger.attach.mock.calls.map((args: any[]) => args[0].tabId),
    ).toEqual([1, 2, 1]);
    const state = (await rpc("state")).result.scan;
    expect(state.state).toBe("recording");
    expect(
      state.gaps.filter((g: any) => g.type === "debugger_detach"),
    ).toHaveLength(1);
  });
  it("an attach failure cannot be hidden by a later child-target warning", async () => {
    await loadBackground();
    failAttach.add(1);
    unsupportedChild.add(2);
    const scan = await started([1, 2]);
    expect(scan.state).toBe("interrupted");
    expect(scan.gaps.at(-1)?.type).toBe("child_target");
    const resumed = await rpc("resume", { id: scan.id });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("1 个标签页无法附加");
    expect((await rpc("state")).result.scan.state).toBe("interrupted");
  });
  it("a failed command does not poison later queued task commands", async () => {
    await loadBackground();
    const scan = await started();
    expect((await rpc("pause", { id: "wrong-task" })).ok).toBe(false);
    expect((await rpc("pause", { id: scan.id })).ok).toBe(true);
    expect((await rpc("resume", { id: scan.id })).ok).toBe(true);
    expect((await rpc("stop", { id: scan.id })).ok).toBe(true);
  });
  it("restart keeps historical data and exposes interrupted task without a ready deadlock", async () => {
    const { Recorder } = await import("../src/recorder");
    const { get } = await import("../src/store");
    const previous = new Recorder(async () => ({}));
    const scan = await previous.create(
      "previous background",
      [{ id: 1, url: "https://fixture.test/1" }],
      config(),
    );
    await loadBackground();
    expect((await rpc("state")).result.scan).toBe(null);
    expect((await get<Scan>("scans", scan.id))?.state).toBe("interrupted");
    expect((await rpc("resume", { id: scan.id })).ok).toBe(true);
    expect((await rpc("state")).result.scan.id).toBe(scan.id);
  });
  it("recovery write failure keeps state readable and pending records can be flushed again", async () => {
    const { Recorder } = await import("../src/recorder");
    const store = await import("../src/store");
    const previous = new Recorder(async () => ({}));
    const scan = await previous.create(
      "recover quota failure",
      [{ id: 1, url: "https://fixture.test/1" }],
      config(),
    );
    await previous.event({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "pending-recovery",
      documentURL: "https://fixture.test/1",
      type: "Fetch",
      request: { url: "https://api.test/recover", method: "GET", headers: {} },
    });
    await previous.flush();
    vi.spyOn(store, "commit").mockRejectedValueOnce(
      Error("quota during recovery"),
    );
    await loadBackground();
    const failed = await rpc("state");
    expect(failed.ok).toBe(true);
    expect(failed.result.scan.id).toBe(scan.id);
    expect(failed.result.scan.state).toBe("interrupted");
    expect(failed.result.failure).toContain("后台恢复未完成");
    expect((await rpc("flush", { id: scan.id })).ok).toBe(true);
    const recovered = (await rpc("state")).result;
    expect(recovered.failure).toBe("");
    expect(recovered.scan.stats.persisted).toBe(1);
    expect(await store.page(scan.id)).toHaveLength(1);
  });
  it("slow transfer acknowledgement does not block completed local stop or the next task", async () => {
    await loadBackground();
    const scan = await started();
    const transfers = await import("../src/transfer");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi
      .spyOn(transfers, "transfer")
      .mockImplementation(() => waiting);
    try {
      const stopped = await Promise.race([
        rpc("stop", { id: scan.id }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Error("stop waited for transfer acknowledgement")),
            100,
          ),
        ),
      ]);
      expect(stopped.ok).toBe(true);
      expect(send).toHaveBeenCalled();
      expect((await rpc("state")).result.scan.state).toBe("ended");
      const next = await started([2]);
      expect(next.id).not.toBe(scan.id);
      expect(next.state).toBe("recording");
    } finally {
      release();
    }
  });
  it("one-second local writes and active snapshots continue while transfer is unresolved", async () => {
    await loadBackground();
    const scan = await started();
    const transfers = await import("../src/transfer");
    const store = await import("../src/store");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi
      .spyOn(transfers, "transfer")
      .mockImplementation(() => waiting);
    try {
      intervalCallbacks[0]();
      await waitFor(async () => send.mock.calls.length > 0);
      eventListener({ tabId: 1 }, "Network.requestWillBeSent", {
        requestId: "completed-during-transfer",
        documentURL: "https://fixture.test/1",
        type: "Fetch",
        request: {
          url: "https://api.test/completed",
          method: "GET",
          headers: {},
        },
      });
      eventListener({ tabId: 1 }, "Network.loadingFinished", {
        requestId: "completed-during-transfer",
      });
      eventListener({ tabId: 1 }, "Network.requestWillBeSent", {
        requestId: "active-during-transfer",
        documentURL: "https://fixture.test/1",
        type: "Fetch",
        request: {
          url: "https://api.test/still-pending",
          method: "GET",
          headers: {},
        },
      });
      // This is the real registered one-second timer, not an explicit flush RPC.
      await new Promise((resolve) => setTimeout(resolve, 1150));
      const state = (await rpc("state")).result;
      expect(state.scan.id).toBe(scan.id);
      expect(state.scan.stats.persisted).toBe(1);
      expect(await store.page(scan.id)).toHaveLength(1);
      expect(await store.all("active", scan.id)).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
});
