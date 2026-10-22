import { afterEach, describe, expect, it, vi } from "vitest";
import { StackCapture, STACK_LIMITS } from "../src/stack";
const root = { tabId: 1 },
  child = { tabId: 1, sessionId: "worker" };
const frame = (name = "fetcher") => ({
  functionName: name,
  scriptId: "42",
  url: "https://fixture.test/app.js?token=private",
  lineNumber: 3,
  columnNumber: 7,
});
afterEach(() => vi.useRealTimers());
describe("bounded CDP stack capture", () => {
  it("enables synchronous and asynchronous depth without pausing business code", async () => {
    const send = vi.fn(async () => ({ debuggerId: "root-debugger" }));
    const capture = new StackCapture(send);
    await capture.configure(root);
    expect(send).toHaveBeenCalledWith(
      root,
      "Runtime.setMaxCallStackSizeToCapture",
      { size: 200 },
    );
    expect(send).toHaveBeenCalledWith(root, "Debugger.setAsyncCallStackDepth", {
      maxDepth: 32,
    });
    expect(send).toHaveBeenCalledWith(root, "Debugger.setSkipAllPauses", {
      skip: true,
    });
    const methods = send.mock.calls.map((args: any[]) => args[1]);
    expect(methods.indexOf("Debugger.setSkipAllPauses")).toBeLessThan(
      methods.indexOf("Debugger.enable"),
    );
    const output = await capture.capture(root, { callFrames: [frame()] });
    expect(output.quality.state).toBe("complete");
    expect(JSON.stringify(output.stack)).not.toContain("private");
  });
  it("resolves parent IDs in their same-tab debugger session and preserves Promise segments", async () => {
    const send = vi.fn(async (source: any, method: string) => {
      if (method === "Debugger.enable")
        return {
          debuggerId: source.sessionId ? "worker-debugger" : "root-debugger",
        };
      if (method === "Debugger.getStackTrace")
        return {
          stackTrace: {
            description: "Promise.then",
            callFrames: [frame("caller")],
          },
        };
      return {};
    });
    const capture = new StackCapture(send);
    await capture.configure(root);
    await capture.configure(child);
    const output = await capture.capture(root, {
      callFrames: [frame()],
      parentId: { id: "parent", debuggerId: "worker-debugger" },
    });
    expect(send).toHaveBeenCalledWith(child, "Debugger.getStackTrace", {
      stackTraceId: { id: "parent", debuggerId: "worker-debugger" },
    });
    expect((output.stack as any).parent.description).toBe("Promise.then");
    expect(output.quality.state).toBe("complete");
  });
  it("never routes an unknown debugger ID to another tab", async () => {
    const send = vi.fn(async () => ({ debuggerId: "other-debugger" }));
    const capture = new StackCapture(send);
    await capture.configure({ tabId: 2 });
    const output = await capture.capture(root, {
      callFrames: [frame()],
      parentId: { id: "opaque", debuggerId: "other-debugger" },
    });
    expect(output.quality.state).toBe("partial");
    expect(output.quality.reason).toContain("会话不可用");
    expect((output.stack as any).parentId.id).toBe("opaque");
    expect(
      send.mock.calls.some(
        (args: any[]) => args[1] === "Debugger.getStackTrace",
      ),
    ).toBe(false);
  });
  it("retains an unresolved reference and returns within its total time budget", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_source: any, method: string) =>
      method === "Debugger.getStackTrace" ? new Promise(() => {}) : {},
    );
    const capture = new StackCapture(send);
    await capture.configure(root);
    const pending = capture.capture(root, {
      callFrames: [frame()],
      parentId: { id: "gone" },
    });
    await vi.advanceTimersByTimeAsync(STACK_LIMITS.timeout + 1);
    const output = await pending;
    expect(output.quality.state).toBe("partial");
    expect(output.quality.reason).toContain("超时");
    expect((output.stack as any).parentId.id).toBe("gone");
  });
  it("detects parent reference cycles instead of blocking finalization", async () => {
    const send = vi.fn(async (_source: any, method: string) =>
      method === "Debugger.getStackTrace"
        ? { stackTrace: { callFrames: [frame()], parentId: { id: "cycle" } } }
        : {},
    );
    const capture = new StackCapture(send);
    await capture.configure(root);
    const output = await capture.capture(root, {
      callFrames: [frame()],
      parentId: { id: "cycle" },
    });
    expect(output.quality.reason).toContain("循环");
    expect(
      send.mock.calls.filter(
        (args: any[]) => args[1] === "Debugger.getStackTrace",
      ),
    ).toHaveLength(1);
  });
  it("limits concurrent lookups and preserves the available event stack", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_source: any, method: string) =>
      method === "Debugger.getStackTrace" ? new Promise(() => {}) : {},
    );
    const capture = new StackCapture(send);
    await capture.configure(root);
    const waiting = Array.from({ length: 4 }, () =>
      capture.capture(root, {
        callFrames: [frame()],
        parentId: { id: "wait" },
      }),
    );
    const output = await capture.capture(root, { callFrames: [frame()] });
    expect(output.quality.reason).toContain("并发上限");
    expect((output.stack as any).callFrames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STACK_LIMITS.timeout + 1);
    await Promise.all(waiting);
  });
  it("disables Debugger if skipping pauses cannot be established", async () => {
    const send = vi.fn(async (_source: any, method: string) => {
      if (method === "Debugger.setSkipAllPauses") throw Error("unsupported");
      return {};
    });
    const capture = new StackCapture(send);
    await capture.configure(root);
    expect(send).toHaveBeenCalledWith(root, "Debugger.disable", undefined);
    expect(
      send.mock.calls.some((args: any[]) => args[1] === "Debugger.enable"),
    ).toBe(false);
    expect(
      send.mock.calls.some(
        (args: any[]) => args[1] === "Debugger.setAsyncCallStackDepth",
      ),
    ).toBe(false);
    expect(
      (await capture.capture(root, { callFrames: [frame()] })).quality.reason,
    ).toContain("已关闭 Debugger");
  });
  it("retains root plus 32 async parents and accounts for defensive snapshot truncation", async () => {
    const capture = new StackCapture(async () => ({}));
    await capture.configure(root);
    let raw: any = { callFrames: [frame("oldest")] };
    for (let i = 0; i < 32; i++)
      raw = {
        callFrames: [frame(String(i))],
        parent: raw,
        description: "Promise.then",
      };
    const output = await capture.capture(root, raw);
    let cursor: any = output.stack,
      count = 0;
    while (cursor) {
      count++;
      cursor = cursor.parent;
    }
    expect(count).toBe(33);
    expect(output.quality.state).toBe("complete");
    const snapshot = capture.snapshot({
      callFrames: Array.from({ length: 401 }, () => frame()),
    });
    expect(snapshot?.callFrames).toHaveLength(400);
    expect(snapshot?.truncated_reason).toContain("总帧数上限");
  });
});
