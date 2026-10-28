import { it, expect } from "vitest";
import { captureLoadedScripts } from "../src/capture-scripts";
function api(fail = false) {
  const listeners = new Set<Function>(),
    calls: string[] = [];
  let attached = false;
  return {
    calls,
    debugger: {
      onEvent: {
        addListener: (f: Function) => listeners.add(f),
        removeListener: (f: Function) => listeners.delete(f),
      },
      attach: async () => {
        calls.push("attach");
        attached = true;
      },
      detach: async () => {
        calls.push("detach");
        attached = false;
      },
      sendCommand: async (target: any, method: string) => {
        calls.push(method);
        if (method === "Runtime.enable" && !attached)
          throw Error("not attached");
        if (method === "Runtime.enable") {
          for (const f of listeners)
            f(target, "Runtime.executionContextCreated", {
              context: {
                id: 1,
                auxData: { frameId: "frame", isDefault: true },
              },
            });
          return {};
        }
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: "frame", url: "https://page.test/" } },
          };
        if (method === "DOM.getDocument")
          return { root: { baseURL: "https://page.test/base/" } };
        if (method === "Debugger.enable") {
          for (const f of listeners)
            f(target, "Debugger.scriptParsed", {
              scriptId: "1",
              url: "https://cdn.test/main.js",
              executionContextId: 1,
              startLine: 0,
              startColumn: 0,
            });
          return {};
        }
        if (method === "Debugger.getScriptSource") {
          if (fail) throw Error("source missing");
          return { scriptSource: 'fetch("/api")' };
        }
        return {};
      },
    },
    tabs: {
      query: async () => [
        { id: 1, url: "https://page.test/" },
        { id: 2, url: "chrome://settings" },
      ],
    },
  } as any;
}
it("通过CDP读取已加载JS，不执行evaluate或发起业务网络，父链/深度保持未知", async () => {
  const mock = api(),
    r = await captureLoadedScripts(mock, { settleMs: 1 });
  expect(r.assets).toHaveLength(1);
  expect(r.assets[0].context.baseUrl).toBe("https://page.test/base/");
  expect(r.assets[0].fetchDepth).toBeNull();
  expect(r.assets[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(mock.calls).toContain("detach");
  expect(
    mock.calls.some(
      (m: string) => m.includes("evaluate") || m.includes("Network."),
    ),
  ).toBe(false);
});
it("读取失败和预算超限登记缺口并清理自有连接", async () => {
  const fail = api(true),
    r = await captureLoadedScripts(fail, { settleMs: 1 });
  expect(r.assets).toHaveLength(0);
  expect(r.gaps.length).toBeGreaterThan(0);
  expect(fail.calls).toContain("detach");
  const limited = await captureLoadedScripts(api(), {
    settleMs: 1,
    maxSourceBytes: 1,
  });
  expect(limited.gaps.some((g) => g.includes("预算"))).toBe(true);
});
