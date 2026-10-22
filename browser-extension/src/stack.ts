import type { Quality } from "./model";
import { stackFrames } from "./privacy";

type Source = chrome.debugger.DebuggerSession;
type Send = (source: Source, method: string, params?: object) => Promise<any>;
export const STACK_LIMITS = {
  synchronous: 200,
  asynchronous: 32,
  nodes: 33,
  frames: 400,
  timeout: 1200,
  concurrency: 4,
};
const sourceKey = (source: Source) =>
  `${source.tabId}:${source.sessionId ?? "root"}`;
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("读取调用栈超时")),
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Session-scoped CDP stack collection. Raw protocol trees never leave this helper. */
export class StackCapture {
  private profiles = new Map<string, string[]>();
  private debuggers = new Map<string, Source>();
  private running = 0;
  constructor(private send: Send) {}
  reset() {
    this.profiles.clear();
    this.debuggers.clear();
  }
  forget(source: Source) {
    const key = sourceKey(source);
    this.profiles.delete(key);
    for (const [id, owner] of this.debuggers)
      if (sourceKey(owner) === key) this.debuggers.delete(id);
  }
  async configure(source: Source) {
    this.forget(source);
    const warnings: string[] = [];
    const command = async (method: string, params?: object) => {
      try {
        return await bounded(this.send(source, method, params), 750);
      } catch {
        warnings.push(`${method} 不支持、失败或超时`);
        return null;
      }
    };
    await command("Runtime.enable");
    await command("Runtime.setMaxCallStackSizeToCapture", {
      size: STACK_LIMITS.synchronous,
    });
    // Arm pause suppression before enabling Debugger so existing business debugger
    // statements cannot suspend the page in the configuration window.
    const skip = await command("Debugger.setSkipAllPauses", { skip: true });
    if (skip === null) {
      await command("Debugger.disable");
      this.forget(source);
      warnings.push("无法保证跳过断点，已关闭 Debugger，异步栈不可用");
    }
    if (skip !== null) {
      const result = await command("Debugger.enable");
      if (typeof result?.debuggerId === "string")
        this.debuggers.set(`${source.tabId}:${result.debuggerId}`, {
          ...source,
        });
      await command("Debugger.setPauseOnExceptions", { state: "none" });
      await command("Debugger.setAsyncCallStackDepth", {
        maxDepth: STACK_LIMITS.asynchronous,
      });
    }
    this.profiles.set(sourceKey(source), warnings);
    return warnings;
  }
  snapshot(raw: any) {
    let nodes = 0,
      frames = 0;
    const visit = (node: any): any => {
      if (!node) return null;
      if (nodes++ >= STACK_LIMITS.nodes)
        return {
          callFrames: [],
          truncated_reason: "调用栈快照达到父链层数上限",
        };
      const available = Math.max(0, STACK_LIMITS.frames - frames);
      const selected = Array.isArray(node.callFrames)
        ? node.callFrames.slice(0, available)
        : [];
      frames += selected.length;
      return {
        callFrames: selected,
        ...(Array.isArray(node.callFrames) &&
        selected.length < node.callFrames.length
          ? { truncated_reason: "调用栈快照达到总帧数上限" }
          : {}),
        description: node.description,
        parentId: node.parentId,
        parent: visit(node.parent),
      };
    };
    return stackFrames(visit(raw));
  }
  async capture(
    source: Source,
    raw: any,
  ): Promise<{ stack: unknown; quality: Quality }> {
    if (!raw)
      return {
        stack: null,
        quality: { state: "missing", reason: "该请求未提供 JS 调用栈" },
      };
    const warnings = [
      ...(this.profiles.get(sourceKey(source)) ?? [
        "该会话未完成调用栈深度配置",
      ]),
    ];
    if (this.running >= STACK_LIMITS.concurrency)
      return {
        stack: this.snapshot(raw),
        quality: {
          state: "partial",
          reason: "调用栈解析并发上限；保留事件已提供的栈，异步父链未补全",
        },
      };
    this.running++;
    let nodes = 0,
      frames = 0;
    const until = Date.now() + STACK_LIMITS.timeout;
    const seen = new Set<string>();
    const walk = async (node: any, owner: Source): Promise<any> => {
      if (!node || typeof node !== "object") return null;
      if (nodes++ >= STACK_LIMITS.nodes || Date.now() >= until) {
        warnings.push("调用栈达到父链层数或解析时间上限");
        return null;
      }
      const input = Array.isArray(node.callFrames) ? node.callFrames : [];
      const count = Math.max(0, STACK_LIMITS.frames - frames);
      const selected = input.slice(0, count);
      frames += selected.length;
      if (
        selected.length < input.length ||
        input.length >= STACK_LIMITS.synchronous
      )
        warnings.push("同步栈达到帧数上限，无法声明更深帧完整");
      const out: any = {
        callFrames: selected,
        ...(typeof node.description === "string"
          ? { description: node.description }
          : {}),
      };
      if (node.parentId && typeof node.parentId.id === "string")
        out.parentId = {
          id: node.parentId.id,
          ...(typeof node.parentId.debuggerId === "string"
            ? { debuggerId: node.parentId.debuggerId }
            : {}),
        };
      if (node.parent) out.parent = await walk(node.parent, owner);
      else if (out.parentId) {
        const id = out.parentId;
        const route = id.debuggerId
          ? this.debuggers.get(`${owner.tabId}:${id.debuggerId}`)
          : owner;
        const identity = `${owner.tabId}:${id.debuggerId ?? sourceKey(owner)}:${id.id}`;
        if (!route)
          warnings.push("异步父栈所属 debugger 会话不可用；保留 parentId");
        else if (seen.has(identity))
          warnings.push("异步父栈引用循环；保留 parentId");
        else if (nodes >= STACK_LIMITS.nodes || frames >= STACK_LIMITS.frames)
          warnings.push("异步父栈达到层数或帧数上限；保留 parentId");
        else {
          seen.add(identity);
          try {
            const result = await bounded(
              this.send(route, "Debugger.getStackTrace", { stackTraceId: id }),
              until - Date.now(),
            );
            if (result?.stackTrace)
              out.parent = await walk(result.stackTrace, route);
            else
              warnings.push("Debugger.getStackTrace 未返回父栈；保留 parentId");
          } catch {
            warnings.push(
              "异步父栈读取失败或超时（会话可能已失效）；保留 parentId",
            );
          }
        }
      }
      return out;
    };
    try {
      const stack = stackFrames(await walk(raw, source));
      return {
        stack,
        quality: {
          state: warnings.length ? "partial" : "complete",
          reason: warnings.length
            ? [...new Set(warnings)].join("；")
            : `CDP 已返回链已解析；同步最多 ${STACK_LIMITS.synchronous} 帧、异步最多 ${STACK_LIMITS.asynchronous} 层，不保证附加前或浏览器未返回的历史`,
        },
      };
    } catch {
      return {
        stack: this.snapshot(raw),
        quality: {
          state: "partial",
          reason: "调用栈解析失败，保留事件已提供的栈",
        },
      };
    } finally {
      this.running--;
    }
  }
}
