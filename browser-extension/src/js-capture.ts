import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { uid, now, gap, type Scan } from "./model";
import {
  RemoteCapture,
  CAPTURE_LIMITS,
  type CaptureEvent,
} from "./remote-capture";
import type { StackCapture } from "./stack";
type Source = chrome.debugger.DebuggerSession;
export const JS_LIMITS = { concurrency: 4, requests: 4096 };
/** Consumes the recorder's session; never attaches or enables Debugger itself. */
export class JSCapture {
  private epochs = new Map<string, string>();
  private requests = new Map<string, number>();
  private halted = false;
  private serial = 0;
  private tail: Promise<void> = Promise.resolve();
  private scripts: Array<() => Promise<void>> = [];
  private runningScripts = 0;
  private jobs = 0;
  private drained: Array<() => void> = [];
  private queued = 0;
  private queuedBytes = 0;
  private admittedRequests = new Set<string>();
  resetFailure() {
    this.requests.clear();
    this.admittedRequests.clear();
    this.halted = false;
  }
  drain() {
    if (!this.jobs) return Promise.resolve();
    return new Promise<void>((resolve) => this.drained.push(resolve));
  }
  private done() {
    if (--this.jobs === 0) for (const resolve of this.drained.splice(0)) resolve();
  }
  /** Script reads are independent; a small pool keeps attach-time replays from starving. */
  private pump() {
    while (
      this.runningScripts < JS_LIMITS.concurrency &&
      this.scripts.length
    ) {
      const run = this.scripts.shift()!;
      this.runningScripts++;
      void run().finally(() => {
        this.runningScripts--;
        this.pump();
      });
    }
  }
  enqueue(scan: Scan, s: Source, method: string, p: any, targetId?: string) {
    if (!scan.config.collect_js || scan.state !== "recording" || this.halted)
      return;
    const epoch = this.epochs.get(this.key(s));
    if (!epoch) return;
    const requestKey = `${this.key(s)}:${epoch}:${p.requestId}`;
    const request =
      method === "Network.requestWillBeSent" && p.type === "Script";
    if (
      method.startsWith("Network.") &&
      ![
        "Network.requestWillBeSent",
        "Network.responseReceived",
        "Network.loadingFinished",
        "Network.loadingFailed",
      ].includes(method)
    )
      return;
    if (
      !method.startsWith("Runtime.") &&
      method !== "Debugger.scriptParsed" &&
      !request &&
      !this.admittedRequests.has(requestKey)
    )
      return;
    if (request) {
      if (
        this.admittedRequests.size >= JS_LIMITS.requests &&
        !this.admittedRequests.has(requestKey)
      ) {
        gap(
          scan,
          "js_backpressure",
          "JS在途请求超过4096，丢弃新的JS请求事件；请求采集继续",
          undefined,
          1,
        );
        return;
      }
      this.admittedRequests.add(requestKey);
    }
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    )
      this.admittedRequests.delete(requestKey);
    const bytes = new TextEncoder().encode(JSON.stringify(p)).length;
    if (
      this.queued >= scan.config.queue_count ||
      this.queuedBytes + bytes > scan.config.queue_bytes
    ) {
      // Bounded loss instead of pausing the whole task: CDP attach replays every
      // existing scriptParsed at once, and pausing here also stops API capture.
      gap(
        scan,
        "js_backpressure",
        `JS待处理队列达到${scan.config.queue_count}事件/${scan.config.queue_bytes}字节上限，丢弃本次JS事件；请求采集继续`,
        undefined,
        1,
      );
      return;
    }
    const receivedAt = now();
    const tabURL = scan.tabs.find((tab) => tab.id === s.tabId)?.url ?? null;
    const payload = structuredClone(p);
    const id = `${epoch}:${String(++this.serial).padStart(12, "0")}`;
    this.queued++;
    this.queuedBytes += bytes;
    this.jobs++;
    const run = () =>
      this.event(
        scan,
        s,
        method,
        payload,
        epoch,
        targetId,
        receivedAt,
        tabURL,
        id,
      )
        .catch((error) => {
          this.halted = true;
          gap(scan, "js_capture_failure", String(error));
        })
        .finally(() => {
          this.queued--;
          this.queuedBytes -= bytes;
          this.done();
        });
    // Network/context events keep per-session order; source reads run concurrently.
    if (method === "Debugger.scriptParsed") {
      this.scripts.push(run);
      this.pump();
    } else this.tail = this.tail.then(run);
  }
  constructor(
    private send: (s: Source, m: string, p?: object) => Promise<any>,
    private stacks: StackCapture,
    private remote: RemoteCapture,
  ) {}
  private key(s: Source) {
    return `${s.tabId}:${s.sessionId ?? "root"}`;
  }
  session(s: Source) {
    this.epochs.set(this.key(s), uid());
  }
  forgetTab(tabId: number) {
    for (const key of this.epochs.keys()) {
      if (key.startsWith(`${tabId}:`)) this.epochs.delete(key);
    }
    for (const r of this.admittedRequests)
      if (r.startsWith(`${tabId}:`)) this.admittedRequests.delete(r);
    for (const r of this.requests.keys())
      if (r.startsWith(`${tabId}:`)) this.requests.delete(r);
  }
  forget(s: Source) {
    const key = this.key(s);
    this.epochs.delete(key);
    for (const r of this.admittedRequests)
      if (r.startsWith(key + ":")) this.admittedRequests.delete(r);
    for (const r of this.requests.keys())
      if (r.startsWith(key + ":")) this.requests.delete(r);
  }
  private async event(
    scan: Scan,
    s: Source,
    method: string,
    p: any,
    epoch: string,
    targetId: string | undefined,
    receivedAt: string,
    tabURL: string | null,
    id: string,
  ) {
    if (this.remote.failed) {
      gap(scan, "remote_unconfirmed", "远端存在未确认数据；此窗口JS未采集");
      return;
    }
    const session = this.key(s);
    if (!epoch) return; // No source is associated across a lost/replaced connection.
    const requestKey = `${session}:${epoch}:${p.requestId}`;
    const script = method === "Debugger.scriptParsed";
    const context =
      method === "Runtime.executionContextCreated" ||
      method === "Runtime.executionContextDestroyed" ||
      method === "Runtime.executionContextsCleared";
    const request =
      method === "Network.requestWillBeSent" && p.type === "Script";
    if (!script && !context && !request && !this.requests.has(requestKey))
      return;
    if (!script && !context && !method.startsWith("Network.")) return;
    const hop = request
      ? p.redirectResponse
        ? (this.requests.get(requestKey) ?? 0) + 1
        : 0
      : this.requests.get(requestKey);
    if (request) {
      if (
        this.requests.size >= JS_LIMITS.requests &&
        !this.requests.has(requestKey)
      ) {
        gap(
          scan,
          "js_backpressure",
          "JS在途请求超过4096，丢弃新的JS请求事件；请求采集继续",
          undefined,
          1,
        );
        return;
      }
      this.requests.set(requestKey, hop!);
    }
    const data = script
      ? { ...p, stackTrace: this.stacks.snapshot(p.stackTrace) }
      : context
        ? { ...p }
        : {
            request_id: p.requestId,
            redirect_hop: hop,
            frame_id: p.frameId ?? null,
            loader_id: p.loaderId ?? null,
            document_url: p.documentURL ?? null,
            url: p.request?.url ?? p.response?.url ?? null,
            method: p.request?.method,
            status: p.response?.status,
            redirect: p.redirectResponse
              ? {
                  url: p.redirectResponse.url,
                  status: p.redirectResponse.status,
                }
              : null,
            initiator: p.initiator
              ? {
                  type: p.initiator.type,
                  url: p.initiator.url,
                  lineNumber: p.initiator.lineNumber,
                  columnNumber: p.initiator.columnNumber,
                  requestId: p.initiator.requestId,
                }
              : null,
            error: p.errorText,
            timestamp: p.timestamp,
          };
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    )
      this.requests.delete(requestKey);
    const event: CaptureEvent = {
      id,
      scan_id: scan.id,
      kind: method,
      time: receivedAt ?? now(),
      tab_id: s.tabId,
      session_id: s.sessionId ?? "root",
      epoch,
      data,
      status: "captured",
    };
    event.data.observed_tab_url = tabURL ?? null;
    event.data.cdp = p;
    event.data.target_id = targetId ?? null; // Not inferred from a URL; target/session evidence remains separate.
    let source: string | undefined;
    if (script) {
      event.data.representation = "debugger-parsed-source";
      event.data.network_match = "unknown"; // URL equality alone is not sufficient.
      if (this.epochs.get(session) !== epoch)
        event.status = "source_session_changed";
      else if (p.length > CAPTURE_LIMITS.file)
        event.status = "source_over_budget";
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            this.send(s, "Debugger.getScriptSource", { scriptId: p.scriptId }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Error("读取JS超时")), 2000);
            }),
          ]);
          if (this.epochs.get(session) !== epoch)
            throw Error("源码会话代次已改变");
          source = result.scriptSource;
          if (typeof source !== "string") throw Error("没有文本源码");
          const bytes = new TextEncoder().encode(source);
          if (
            new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(
              bytes,
            ) !== source
          )
            throw Error("源码不能无损编码为UTF-8");
          if (bytes.length > CAPTURE_LIMITS.file) {
            source = undefined;
            event.status = "source_over_budget";
          } else {
            event.hash = bytesToHex(sha256(bytes));
            event.data.source_bytes = bytes.length;
          }
        } catch (error) {
          event.status = "source_unavailable";
          event.data.error = String(error);
          source = undefined;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    if (p.initiator?.stack) {
      const captured = await this.stacks.capture(s, p.initiator.stack);
      event.data.loading_stack = captured;
    }
    try {
      await this.remote.send(event, source);
    } catch (error) {
      this.halted = true;
      scan.state = "paused";
      gap(
        scan,
        "remote_upload_failure",
        `${String(error)}；未取得远端持久确认，任务已暂停，无本地正文副本`,
      );
    }
  }
}
