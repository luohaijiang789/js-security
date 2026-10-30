import { describe, it, expect, vi } from "vitest";
import { Collector } from "../src/capture";
import { LIMITS, sha, type Asset, type Task } from "../src/model";
function rig(fail = false) {
  const assets: Asset[] = [],
    tasks = new Map<string, Task>(),
    calls: Array<[any, string, any]> = [];
  const persistence = {
    saveTask: async (t: Task) => {
      tasks.set(t.id, structuredClone(t));
    },
    saveAsset: async (a: Asset, t: Task) => {
      assets.push(structuredClone(a));
      tasks.set(t.id, structuredClone(t));
    },
    tasks: async () => [...tasks.values()],
  };
  let collector: Collector;
  const api = {
    tabs: {
      query: async () => [
        { id: 1, url: "https://site.test/page/" },
        { id: 2, url: "chrome://settings/" },
      ],
    },
    debugger: {
      attach: vi.fn(async () => {
        if (fail) throw Error("another debugger");
      }),
      detach: vi.fn(async (s: any) => {
        collector.detached(s);
      }),
      sendCommand: vi.fn(async (s: any, m: string, p: any) => {
        calls.push([s, m, p]);
        if (m === "Runtime.enable")
          collector.event(s, "Runtime.executionContextCreated", {
            context: { id: 10, auxData: { isDefault: true, frameId: "top" } },
          });
        if (m === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: "top", url: "https://site.test/page/" } },
          };
        if (m === "DOM.getDocument")
          return { root: { baseURL: "https://site.test/base/" } };
        if (m === "Debugger.enable")
          collector.event(s, "Debugger.scriptParsed", {
            scriptId: "script-1",
            url: "https://cdn.test/main.js",
            executionContextId: 10,
            length: 30,
          });
        if (m === "Debugger.getScriptSource")
          return { scriptSource: "fetch('./api/never');" };
        return {};
      }),
    },
  };
  collector = new Collector(api as unknown as typeof chrome, persistence);
  return { collector, api, assets, tasks, calls, persistence };
}
describe("persistent parsed-source collection", () => {
  it("collects eligible tabs, preserves page base and complete hashes without executing code", async () => {
    const r = rig();
    await r.collector.start();
    await r.collector.stop();
    expect(r.api.debugger.attach.mock.calls).toHaveLength(1);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0].context.request_base_url).toBe(
      "https://site.test/base/",
    );
    expect(r.assets[0].url).toBe("https://cdn.test/main.js");
    expect(r.assets[0].sha256).toBe(await sha(r.assets[0].content));
    expect(
      r.calls.some(
        ([, method]) =>
          method === "Runtime.evaluate" ||
          method === "Network.loadNetworkResource",
      ),
    ).toBe(false);
    expect(r.collector.task?.phase).toBe("stopped");
  });
  it("never detaches or issues commands when attach belongs to someone else", async () => {
    const r = rig(true);
    await r.collector.start();
    await r.collector.stop();
    expect(r.api.debugger.detach).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
    expect(r.collector.task?.gaps.some((g) => g.kind === "attach_failed")).toBe(
      true,
    );
  });
  it("pause/resume creates a new observation generation and records the missing interval", async () => {
    const r = rig();
    await r.collector.start();
    await r.collector.stop(true);
    await r.collector.resume(r.collector.task!.id);
    await r.collector.stop();
    expect(r.assets).toHaveLength(2);
    expect(r.assets[0].context_key).not.toBe(r.assets[1].context_key);
    expect(
      r.collector.task?.gaps.some((g) => g.kind === "pause_interval"),
    ).toBe(true);
  });
  it("retains dynamic source with unknown child context without inventing Host", async () => {
    const r = rig();
    await r.collector.start();
    r.collector.event({ tabId: 1 }, "Debugger.scriptParsed", {
      scriptId: "dynamic",
      url: "blob:https://site.test/id",
      executionContextId: 99,
    });
    r.collector.detached({ tabId: 1 });
    await r.collector.stop();
    const asset = r.assets.find((a) => a.script_id === "dynamic")!;
    expect(asset.url).toBeNull();
    expect(asset.context.type).toBe("unknown");
    expect(asset.context.request_base_url).toBeNull();
    expect(
      r.collector.task?.gaps.some((g) => g.kind === "debugger_detached"),
    ).toBe(true);
  });
  it("enforces body limits without importing partial source", async () => {
    const r = rig();
    await r.collector.start();
    r.collector.task!.bytes = LIMITS.totalBytes;
    r.collector.event({ tabId: 1 }, "Debugger.scriptParsed", {
      scriptId: "budget",
      url: "https://cdn.test/oversize.js",
      executionContextId: 10,
      length: 10,
    });
    await r.collector.stop();
    expect(r.collector.task?.gaps.some((g) => g.kind === "asset_budget")).toBe(
      true,
    );
    expect(r.assets.find((a) => a.script_id === "budget")).toBeUndefined();
  });
  it("records restart interruption and keeps saved records", async () => {
    const r = rig();
    await r.collector.start();
    await r.collector.stop();
    await r.persistence.saveTask({ ...r.collector.task!, phase: "collecting" });
    const second = new Collector(
      r.api as unknown as typeof chrome,
      r.persistence,
    );
    await second.recover();
    expect([...r.tasks.values()][0].phase).toBe("interrupted");
    expect(
      [...r.tasks.values()][0].gaps.some(
        (g) => g.kind === "background_restart",
      ),
    ).toBe(true);
  });
});
