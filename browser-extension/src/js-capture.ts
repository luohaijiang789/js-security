import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { uid, now, gap, type Scan } from "./model";
import { appendJS, JS_LIMITS, type JSEvent } from "./js-store";
import type { StackCapture } from "./stack";
type Source = chrome.debugger.DebuggerSession;
/** Consumes the recorder's session; never attaches or enables Debugger itself. */
export class JSCapture {
  private epochs = new Map<string, string>();
  private requests = new Map<string, number>();
  private halted = false;
  private serial = 0;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private admittedRequests = new Set<string>();
  drain() {
    return this.tail;
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
        this.admittedRequests.size >= 4096 &&
        !this.admittedRequests.has(requestKey)
      ) {
        this.halted = true;
        gap(
          scan,
          "js_backpressure",
          "JS在途加载超过4096，已暂停JS采集；请求采集继续",
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
    if (this.queued >= 64 || this.queuedBytes + bytes > 4 * 1048576) {
      this.halted = true;
      gap(
        scan,
        "js_backpressure",
        "JS待处理队列达到64事件/4MiB上限，已暂停JS采集；请求采集继续",
      );
      return;
    }
    this.queued++;
    this.queuedBytes += bytes;
    this.tail = this.tail
      .then(() => this.event(scan, s, method, p, epoch, targetId))
      .catch((error) => {
        this.halted = true;
        gap(scan, "js_capture_failure", String(error));
      })
      .finally(() => {
        this.queued--;
        this.queuedBytes -= bytes;
      });
  }
  constructor(
    private send: (s: Source, m: string, p?: object) => Promise<any>,
    private stacks: StackCapture,
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
    targetId?: string,
  ) {
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
      if (this.requests.size >= 4096 && !this.requests.has(requestKey)) {
        this.halted = true;
        gap(
          scan,
          "js_backpressure",
          "JS在途加载超过4096，已暂停JS采集；请求采集继续",
        );
        return;
      }
      this.requests.set(requestKey, hop!);
    }
    const data = script
      ? { ...p, stackTrace: this.stacks.snapshot(p.stackTrace) }
      : context
        ? p
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
    const event: JSEvent = {
      id: `${epoch}:${String(++this.serial).padStart(12, "0")}`,
      scan_id: scan.id,
      kind: method,
      time: now(),
      tab_id: s.tabId,
      session_id: s.sessionId ?? "root",
      epoch,
      data,
      status: "pending_remote",
    };
    event.data.observed_tab_url =
      scan.tabs.find((tab) => tab.id === s.tabId)?.url ?? null;
    event.data.target_id = targetId ?? null; // Not inferred from a URL; target/session evidence remains separate.
    let source: string | undefined;
    if (script) {
      event.data.representation = "debugger-parsed-source";
      event.data.network_match = "unknown"; // URL equality alone is not sufficient.
      if (this.epochs.get(session) !== epoch)
        event.status = "source_session_changed";
      else if (p.length > JS_LIMITS.file) event.status = "source_over_budget";
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
          if (bytes.length > JS_LIMITS.file) {
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
      await appendJS(event, source);
    } catch (error) {
      this.halted = true;
      gap(
        scan,
        "js_outbox_failure",
        `${String(error)}；JS采集已暂停，请求采集继续`,
      );
    }
  }
}
