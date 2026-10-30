import {
  LIMITS,
  httpURL,
  sha,
  type Task,
  type Gap,
  type Asset,
  type CaptureContext,
} from "./model";
import * as store from "./store";
type Source = chrome.debugger.DebuggerSession;
const key = (s: Source) => `${s.tabId}:${s.sessionId ?? "root"}`;
export async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("操作超时")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
// The collector owns its sessions. Integration replaces this adapter with the
// recorder's common session/event layer; it must not attach a second owner.
export class Collector {
  task: Task | undefined;
  private owned = new Set<number>();
  private sources = new Map<string, Source>();
  private frames = new Map<string, { url: string; base: string | null }>();
  private contexts = new Map<string, any>();
  private generations = new Map<string, number>();
  private seen = new Set<string>();
  private contents = new Set<string>();
  private queue: Array<() => Promise<void>> = [];
  private reading = 0;
  private writes = Promise.resolve();
  private attaching = new Map<number, Promise<void>>();
  constructor(
    private api: typeof chrome,
    private persistence: Pick<
      typeof store,
      "saveTask" | "saveAsset" | "tasks"
    > = store,
  ) {}
  private send(s: Source, m: string, p?: Record<string, unknown>) {
    return bounded(this.api.debugger.sendCommand(s, m, p));
  }
  private persist(asset?: Asset) {
    const task = this.task;
    if (!task) return;
    const copy = structuredClone(task);
    this.writes = this.writes.then(() =>
      asset
        ? this.persistence.saveAsset(asset, copy)
        : this.persistence.saveTask(copy),
    );
    this.writes.catch(() => {
      if (this.task === task) {
        task.phase = "interrupted";
        void this.detach();
      }
    });
  }
  gap(kind: string, message: string, source?: string) {
    const t = this.task;
    if (!t) return;
    if (t.gaps.length < LIMITS.gaps)
      t.gaps.push({ kind, message, source: source?.slice(0, 4096) });
    else {
      t.omitted_gaps++;
      return;
    }
    this.persist();
  }
  async recover() {
    for (const t of await this.persistence.tasks()) {
      if (["collecting", "pausing", "stopping"].includes(t.phase)) {
        t.phase = "interrupted";
        t.gaps.push({
          kind: "background_restart",
          message: "后台重启，采集未自动恢复；可导出现有快照或新建任务",
        });
        await this.persistence.saveTask(t);
        for (const tabId of t.tabs)
          await this.api.debugger.detach({ tabId }).catch(() => {});
      }
    }
  }
  async start() {
    if (
      this.task &&
      ["collecting", "pausing", "stopping"].includes(this.task.phase)
    )
      throw Error("已有采集任务");
    this.owned.clear();
    this.sources.clear();
    this.frames.clear();
    this.contexts.clear();
    this.generations.clear();
    this.seen.clear();
    this.contents.clear();
    this.queue = [];
    this.writes = Promise.resolve();
    this.task = {
      id: crypto.randomUUID(),
      phase: "collecting",
      started_at: new Date().toISOString(),
      assets: 0,
      bytes: 0,
      gaps: [],
      omitted_gaps: 0,
      tabs: [],
    };
    this.persist();
    this.gap(
      "initial_coverage",
      "仅收集浏览器已解析的 JS；附加前已丢失、尚未加载和未补取引用不保证覆盖",
    );
    const tabs = await this.api.tabs.query({});
    await Promise.all(
      tabs
        .filter((t) => t.id !== undefined && httpURL(t.url))
        .map((t) => this.attach(t.id!, t.url!)),
    );
    await this.writes;
    return this.task.id;
  }
  async resume(id: string) {
    if (this.task?.id !== id || this.task.phase !== "paused")
      throw Error("只能恢复本次后台中的已暂停任务；重启后请新建任务");
    this.task.phase = "collecting";
    this.gap(
      "pause_interval",
      "暂停期间可能遗漏脚本和导航；恢复会重取当前可用源码",
    );
    const tabs = await this.api.tabs.query({});
    await Promise.all(
      tabs
        .filter((t) => t.id !== undefined && httpURL(t.url))
        .map((t) => this.attach(t.id!, t.url!)),
    );
    await this.writes;
  }
  async attach(tabId: number, url: string) {
    if (
      this.task?.phase !== "collecting" ||
      !httpURL(url) ||
      this.owned.has(tabId)
    )
      return;
    if (this.attaching.has(tabId)) return this.attaching.get(tabId);
    const task = this.task;
    const job = (async () => {
      if (this.sources.size + this.attaching.size >= LIMITS.targets) {
        this.gap("target_budget", "网页/目标数量达到上限", url);
        return;
      }
      try {
        await bounded(this.api.debugger.attach({ tabId }, "1.3"));
        this.owned.add(tabId);
        task.tabs = [...new Set([...task.tabs, tabId])];
        this.persist();
        if (this.task !== task || task.phase !== "collecting") {
          await this.api.debugger.detach({ tabId }).catch(() => {});
          this.owned.delete(tabId);
          return;
        }
        this.generations.set(
          key({ tabId }),
          (this.generations.get(key({ tabId })) ?? 0) + 1,
        );
        this.sources.set(key({ tabId }), { tabId });
        await this.configure({ tabId });
      } catch {
        this.gap(
          "attach_failed",
          "网页调试连接不可用；未接管其他插件或 DevTools 会话",
          url,
        );
      }
    })().finally(() => this.attaching.delete(tabId));
    this.attaching.set(tabId, job);
    await job;
  }
  private async configure(s: Source) {
    try {
      await this.send(s, "Runtime.enable");
      try {
        await this.send(s, "Page.enable");
        const tree: any = await this.send(s, "Page.getFrameTree");
        const visit = (n: any) => {
          this.frames.set(`${key(s)}:${n.frame.id}`, {
            url: n.frame.url,
            base: null,
          });
          for (const c of n.childFrames ?? []) visit(c);
        };
        visit(tree.frameTree);
        const dom: any = await this.send(s, "DOM.getDocument", { depth: 0 });
        const top = this.frames.get(`${key(s)}:${tree.frameTree.frame.id}`);
        if (top) top.base = httpURL(dom.root.baseURL) ? dom.root.baseURL : null;
      } catch {
        this.gap(
          "target_base_unknown",
          "该目标的页面基址未确认，保留未知",
          key(s),
        );
      }
      await this.send(s, "Debugger.setSkipAllPauses", { skip: true });
      await this.send(s, "Debugger.enable");
      await this.send(s, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() =>
        this.gap("child_targets_unavailable", "子目标自动接入不可用", key(s)),
      );
    } catch {
      this.gap(
        "target_configuration",
        "目标已附加，但源码读取能力未完整启用",
        key(s),
      );
    }
  }
  event(s: Source, method: string, p: any) {
    const t = this.task;
    if (!t || t.phase !== "collecting" || !this.owned.has(s.tabId!)) return;
    const sk = key(s);
    if (method === "Target.attachedToTarget") {
      const child = { tabId: s.tabId, sessionId: p.sessionId };
      if (this.sources.size >= LIMITS.targets) {
        this.gap("target_budget", "子目标数量达到上限", p.targetInfo?.url);
        void this.send(s, "Target.detachFromTarget", {
          sessionId: p.sessionId,
        }).catch(() => {});
        return;
      }
      this.sources.set(key(child), child);
      this.gap(
        "child_context_unknown",
        "子目标执行基址待进一步核验，不能用顶层页面或 CDN 地址推断 Host",
        p.targetInfo?.url,
      );
      void this.configure(child);
      return;
    }
    if (!this.sources.has(sk)) return;
    if (method === "Target.detachedFromTarget") {
      const child = key({ tabId: s.tabId, sessionId: p.sessionId });
      this.sources.delete(child);
      this.gap(
        "child_target_closed",
        "子目标已结束，未取得的源码可能缺失",
        child,
      );
      return;
    }
    if (
      method === "Runtime.executionContextCreated" &&
      this.contexts.size < LIMITS.pending
    )
      this.contexts.set(`${sk}:${p.context.id}`, p.context);
    if (method === "Runtime.executionContextDestroyed")
      this.contexts.delete(`${sk}:${p.executionContextId}`);
    if (method === "Runtime.executionContextsCleared") {
      for (const id of this.contexts.keys())
        if (id.startsWith(sk + ":")) this.contexts.delete(id);
      this.generations.set(sk, (this.generations.get(sk) ?? 0) + 1);
    }
    if (method === "Page.frameNavigated") {
      this.frames.set(`${sk}:${p.frame.id}`, { url: p.frame.url, base: null });
      this.gap(
        "navigation",
        "页面发生导航，初始文档前段和基址可能需要重新确认",
        p.frame.url,
      );
      if (!p.frame.parentId)
        void this.send(s, "DOM.getDocument", { depth: 0 })
          .then((dom: any) => {
            const frame = this.frames.get(`${sk}:${p.frame.id}`);
            if (frame && frame.url === p.frame.url)
              frame.base = httpURL(dom.root.baseURL) ? dom.root.baseURL : null;
          })
          .catch(() => {});
    }
    if (method !== "Debugger.scriptParsed") return;
    const observed = String(p.url ?? "");
    if (observed.length > 4096) {
      this.gap("source_url_budget", "源码 URL 过长，未读取该脚本");
      return;
    }
    if (
      observed &&
      !httpURL(observed) &&
      !observed.startsWith("blob:") &&
      !observed.startsWith("data:")
    )
      return;
    const id = `${sk}:${this.generations.get(sk) ?? 0}:${p.scriptId}`;
    if (this.seen.has(id)) return;
    if (this.seen.size >= LIMITS.pending) {
      this.gap("script_queue_budget", "本次会话源码观察数量达到上限");
      return;
    }
    this.seen.add(id);
    if (p.length > LIMITS.assetBytes) {
      this.gap("asset_budget", "脚本长度超过正文上限，未读取或截断", observed);
      return;
    }
    const execution = this.contexts.get(`${sk}:${p.executionContextId}`);
    const frame = this.frames.get(`${sk}:${execution?.auxData?.frameId}`);
    const top =
      execution?.auxData?.isDefault === true && frame && httpURL(frame.url);
    const context: CaptureContext = {
      type: top ? "page" : "unknown",
      page_url: top ? (frame?.url ?? null) : null,
      request_base_url: top ? (frame?.base ?? null) : null,
      evidence:
        top && frame?.base ? "cdp_document_base" : "capture_base_unknown",
    };
    const contextKey = `${id.slice(0, id.lastIndexOf(":"))}:${p.executionContextId ?? "unknown"}`;
    const inline = (frame && observed === frame.url) || p.hasSourceURL === true;
    const url = httpURL(observed) && !inline ? observed : null;
    this.queue.push(async () => {
      if (
        this.task !== t ||
        !["collecting", "pausing", "stopping"].includes(t.phase)
      )
        return;
      try {
        const result: any = await this.send(s, "Debugger.getScriptSource", {
          scriptId: p.scriptId,
        });
        if (typeof result.scriptSource !== "string")
          throw Error("missing source");
        const content = result.scriptSource;
        const bytes = new TextEncoder().encode(content).length;
        if (
          bytes > LIMITS.assetBytes ||
          t.bytes + bytes > LIMITS.totalBytes ||
          t.assets >= LIMITS.files
        ) {
          this.gap(
            "asset_budget",
            "完整正文超出文件或字节预算，未保存半截脚本",
            observed,
          );
          return;
        }
        const hash = await sha(content);
        if (
          this.task !== t ||
          !["collecting", "pausing", "stopping"].includes(t.phase)
        )
          return;
        const identity = `${contextKey}:${url ?? id}:${hash}`;
        if (this.contents.has(identity)) return;
        // Recheck after async hashing; parallel reads share one JS budget owner.
        if (t.bytes + bytes > LIMITS.totalBytes || t.assets >= LIMITS.files) {
          this.gap("asset_budget", "累计正文预算已耗尽", observed);
          return;
        }
        this.contents.add(identity);
        t.bytes += bytes;
        t.assets++;
        const asset: Asset = {
          id: crypto.randomUUID(),
          task_id: t.id,
          url,
          location: `capture/${p.scriptId}.js`,
          content,
          sha256: hash,
          bytes,
          context_key: contextKey,
          context,
          capture_url: observed,
          script_id: String(p.scriptId),
          captured_at: new Date().toISOString(),
        };
        this.persist(asset);
        if (!context.request_base_url)
          this.gap(
            "context_unknown",
            "执行基址未知；相对 API Host 不猜测",
            observed,
          );
      } catch {
        this.gap(
          "source_unavailable",
          "源码已被清理、目标关闭或读取超时",
          observed,
        );
      }
    });
    this.pump();
  }
  private pump() {
    while (this.reading < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.reading++;
      void job().finally(() => {
        this.reading--;
        this.pump();
      });
    }
  }
  detached(s: Source) {
    if (this.owned.delete(s.tabId!)) {
      this.gap(
        "debugger_detached",
        "调试连接中断，后续脚本可能缺失",
        String(s.tabId),
      );
      for (const k of this.sources.keys())
        if (k.startsWith(s.tabId + ":")) this.sources.delete(k);
    }
  }
  private async detach() {
    const owned = [...this.owned];
    this.owned.clear();
    this.sources.clear();
    await Promise.all(
      owned.map((tabId) =>
        bounded(this.api.debugger.detach({ tabId })).catch(() => {
          this.gap(
            "detach_failed",
            "未能确认释放调试连接；请关闭目标页面或重新加载插件后重试",
            String(tabId),
          );
        }),
      ),
    );
  }
  async stop(pause = false) {
    const t = this.task;
    if (!t || !["collecting", "paused"].includes(t.phase))
      throw Error("没有可停止的任务");
    t.phase = pause ? "pausing" : "stopping";
    this.persist();
    await Promise.allSettled([...this.attaching.values()]);
    const until = Date.now() + 7000;
    while ((this.reading || this.queue.length) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    if (this.reading || this.queue.length) {
      this.queue = [];
      this.gap("drain_timeout", "停止等待超时，未完成源码不进入快照");
    }
    t.phase = pause ? "paused" : "stopped";
    await this.detach();
    this.persist();
    await this.writes;
  }
}
