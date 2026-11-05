import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  appendJournal,
  journalRows,
  journalSnapshot,
  JOURNAL_LIMITS,
  type JournalRow,
} from "../storage/capture-journal";
import { gap, now, type Scan } from "../domain/model";
import type { RemoteCapture } from "../transport/client";

/** Replay persists/uploads observations; it never reissues an expired browser command. */
export class CaptureJournal {
  private serial = 0;
  private requests = new Set<string>();
  private key(source: chrome.debugger.DebuggerSession, id: unknown) {
    return `${source.tabId}:${source.sessionId ?? "root"}:${String(id)}`;
  }
  tracks(source: chrome.debugger.DebuggerSession, id: unknown) {
    return this.requests.has(this.key(source, id));
  }
  forgetTab(tabId: number) {
    for (const key of this.requests)
      if (key.startsWith(`${tabId}:`)) this.requests.delete(key);
  }
  forget(source: chrome.debugger.DebuggerSession) {
    const prefix = this.key(source, "");
    for (const key of this.requests)
      if (key.startsWith(prefix)) this.requests.delete(key);
  }
  resetTracking() {
    this.requests.clear();
  }
  private pending: JournalRow[] = [];
  private memoryBytes = 0;
  private inWrite = 0;
  private tail: Promise<void> = Promise.resolve();
  private pumping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private batch?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  private again = new Set<string>();
  failure = "";
  constructor(
    private remote: RemoteCapture,
    private failed: (scan: string, error: unknown) => void = () => {},
  ) {}
  async observe(
    scan: Scan,
    connection: string,
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: any,
    js_epoch?: string,
    target_id?: string,
  ) {
    const observation = {
      connection,
      sequence: ++this.serial,
      source: structuredClone(source),
      method,
      params: structuredClone(params ?? {}),
      observed_at: now(),
      config_version: scan.versions.at(-1)?.version ?? 1,
      capture_state: scan.state,
      observed_tab_url:
        scan.tabs.find((tab) => tab.id === source.tabId)?.url ?? null,
      js_epoch: js_epoch ?? null,
      target_id: target_id ?? null,
    };
    const capture_json = JSON.stringify(observation),
      bytes = new TextEncoder().encode(capture_json);
    const id = `raw:${connection}:${observation.sequence}`;
    const event = {
      id,
      scan_id: scan.id,
      kind: "RawCdpEvent",
      category: "raw_cdp",
      time: observation.observed_at,
      tab_id: source.tabId,
      session_id: source.sessionId ?? "root",
      epoch: connection,
      status: "captured",
      data: {
        capture_json,
        capture_sha256: bytesToHex(sha256(bytes)),
        capture_bytes: bytes.length,
      },
    };
    const storage_bytes = new TextEncoder().encode(
      JSON.stringify(event),
    ).length;
    if (
      this.pending.length + this.inWrite >= JOURNAL_LIMITS.memory_count ||
      this.memoryBytes + storage_bytes > JOURNAL_LIMITS.memory_bytes
    )
      return Promise.reject(
        Error("原始日志写入缓冲已满，未接纳本次通知，必须保留缺口"),
      );
    const scope = `${new URL(scan.config.remote_capture!.url).origin}\u0000${scan.config.remote_capture!.project}`;
    if (method === "Network.requestWillBeSent") {
      const key = this.key(source, params?.requestId);
      if (
        !this.requests.has(key) &&
        this.requests.size >= JOURNAL_LIMITS.tracking_count
      )
        gap(
          scan,
          "raw_inflight_tracking_limit",
          "原始在途索引达到上限；通知仍上传，暂停后部分终态可能缺失",
          undefined,
          1,
        );
      else this.requests.add(key);
    }
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    )
      this.requests.delete(this.key(source, params?.requestId));
    this.pending.push({
      id,
      scan_id: scan.id,
      scope,
      method,
      bytes: bytes.length,
      storage_bytes,
      event,
    });
    this.memoryBytes += storage_bytes;
    if (!this.batch) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.batch = { promise, resolve, reject };
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, 5);
    }
    return this.batch.promise;
  }
  async flush() {
    clearTimeout(this.timer);
    const rows = this.pending.splice(0),
      batch = this.batch;
    this.batch = undefined;
    this.inWrite += rows.length;
    const operation = this.tail.then(async () => {
      if (!rows.length) return;
      try {
        await appendJournal(rows);
        this.memoryBytes -= rows.reduce(
          (sum, row) => sum + row.storage_bytes,
          0,
        );
        batch?.resolve();
        for (const scan of new Set(rows.map((row) => row.scan_id)))
          this.kick(scan);
      } catch (error) {
        this.pending.unshift(...rows);
        this.failure = String(error);
        batch?.reject(error);
        throw error;
      } finally {
        this.inWrite -= rows.length;
      }
    });
    this.tail = operation.catch(() => {});
    await operation;
  }
  private kick(scan: string) {
    if (this.pumping) {
      this.again.add(scan);
      return;
    }
    if (this.failure || this.remote.failed) return;
    const operation = (async () => {
      while (!this.failure && !this.remote.failed) {
        const rows = await journalRows(scan);
        if (!rows.length) break;
        const results = await Promise.allSettled(
          rows.map((row) => this.remote.send(row.event, undefined, row.id)),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
    })().catch((error) => {
      this.failure = String(error);
      this.failed(scan, error);
    });
    this.pumping = operation.finally(() => {
      this.pumping = undefined;
      const next = this.again.values().next().value;
      if (next) {
        this.again.delete(next);
        this.kick(next);
      }
    });
  }
  async replay(scan: string) {
    if (this.pumping) await this.pumping;
    this.failure = "";
    // Free persisted capacity before retrying a quota-rejected memory batch.
    if (this.remote.failed) throw Error(this.remote.failure);
    this.kick(scan);
    if (this.pumping) await this.pumping;
    if (this.failure) throw Error(this.failure);
    await this.flush();
    if (this.remote.failed) throw Error(this.remote.failure);
    this.kick(scan);
    if (this.pumping) await this.pumping;
    if (this.failure || this.remote.failed)
      throw Error(this.failure || this.remote.failure);
    const status = await journalSnapshot(scan);
    if (status.pending) throw Error("仍有原始日志未移交，不能标记完成");
  }
  async drain(scan: string) {
    await this.flush();
    if (this.pumping) await this.pumping;
    if (this.failure || this.remote.failed)
      throw Error(this.failure || this.remote.failure);
    this.kick(scan);
    if (this.pumping) await this.pumping;
    if (
      this.failure ||
      this.remote.failed ||
      (await journalSnapshot(scan)).pending
    )
      throw Error(this.failure || this.remote.failure || "原始日志仍待移交");
  }
  async snapshot(scan: string) {
    await this.flush();
    return journalSnapshot(scan);
  }
}
