import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Config } from "./model";
export type CaptureEvent = {
  id: string;
  scan_id: string;
  kind: string;
  time: string;
  tab_id?: number;
  session_id: string;
  epoch: string;
  data: Record<string, any>;
  hash?: string;
  status: string;
};
export type RemoteSettings = { url: string; project: string };
export const CAPTURE_LIMITS = { file: 64 * 1048576, chunk: 256 * 1024 };
export const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export const RECEIVER_CODE = "blackbox-capture-v1";
export function validateRemote(s: RemoteSettings | undefined) {
  if (!s || !/^[A-Za-z0-9_-]{1,64}$/.test(s.project))
    throw Error("请填写远端地址和项目");
  const url = new URL(s.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw Error("请填写HTTP或HTTPS服务器源地址，例如http://服务器IP:8379");
}
export class RemoteCapture {
  private tail: Promise<unknown> = Promise.resolve();
  private pending?: { event: CaptureEvent; source?: string };
  acknowledged = 0;
  private requestsByScan = new Map<string, number>();
  requestCount(scan: string) {
    return this.requestsByScan.get(scan) ?? 0;
  }
  failure = "";
  get failed() {
    return !!this.pending;
  }
  constructor(
    private settings: () => RemoteSettings | undefined,
    private token: (s: RemoteSettings) => Promise<string> = async () =>
      RECEIVER_CODE,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const settings = this.settings();
    validateRemote(settings);
    const token = await this.token(settings!);
    if (!token) throw Error("未设置接收code");
    let error: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await this.fetcher(
          `${settings!.url.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(settings!.project)}${path}`,
          {
            ...init,
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
            headers: { ...init.headers, Authorization: `Bearer ${token}` },
          },
        );
        // Include reading in the timeout, not just response headers.
        const body = await response.arrayBuffer();
        if (response.ok)
          return new Response(body, {
            status: response.status,
            headers: response.headers,
          });
        const failure = Error(`接收服务返回HTTP ${response.status}`);
        if (response.status < 500 && ![408, 429].includes(response.status))
          throw Object.assign(failure, { permanent: true });
        error = failure;
      } catch (e) {
        if ((e as any)?.permanent) throw e;
        error = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw error;
  }
  send(event: CaptureEvent, source?: string): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.pending) throw Error("有未确认数据，采集暂停；请先重试上传");
      try {
        await this.deliver(event, source);
      } catch (e) {
        this.pending = { event, source };
        this.failure = String(e);
        throw e;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async retry() {
    await this.tail;
    if (!this.pending) return;
    const pending = this.pending;
    await this.deliver(pending.event, pending.source);
    this.pending = undefined;
    this.failure = "";
  }
  /** Confirmed/in-flight objects per task, receiver and project, keyed by content hash. */
  private objects = new Map<string, Promise<void>>();
  resetObjects() {
    this.objects.clear();
  }
  private objectKey(scan: string, hash: string) {
    const s = this.settings();
    return `${scan}|${s?.url.replace(/\/$/, "")}|${s?.project}|${hash}`;
  }
  private putObject(bytes: Uint8Array, hash: string, scan: string): Promise<void> {
    const key = this.objectKey(scan, hash);
    const existing = this.objects.get(key);
    if (existing) return existing;
    const task = this.uploadObject(bytes, hash).catch((error) => {
      this.objects.delete(key);
      throw error;
    });
    this.objects.set(key, task);
    return task;
  }
  /** Uploads only when the receiver does not already hold the hash. */
  private async uploadObject(bytes: Uint8Array, hash: string) {
    if (bytes.length > 128 * 1048576) throw Error("单个传输对象超过128MiB预算");
    const root = `/objects/${hash}`;
    const status = await (await this.request(root + "?status")).json();
    if (status.sha256 !== hash || typeof status.committed !== "boolean")
      throw Error("正文状态确认无效");
    if (!status.committed) {
      for (
        let offset = 0;
        offset < bytes.length;
        offset += CAPTURE_LIMITS.chunk
      ) {
        const chunk = bytes.slice(offset, offset + CAPTURE_LIMITS.chunk),
          chunkHash = digest(chunk);
        const ack = await (
          await this.request(`${root}/chunks/${offset}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Object-Bytes": String(bytes.length),
              "X-Chunk-SHA256": chunkHash,
            },
            body: chunk,
          })
        ).json();
        if (
          ack.sha256 !== hash ||
          ack.offset !== offset ||
          ack.chunk_sha256 !== chunkHash ||
          ack.durable !== true
        )
          throw Error("分块确认无效");
      }
      const ack = await (
        await this.request(root + "/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bytes: bytes.length }),
        })
      ).json();
      if (
        ack.sha256 !== hash ||
        ack.bytes !== bytes.length ||
        ack.committed !== true ||
        ack.durable !== true
      )
        throw Error("正文持久确认无效");
    } else if (status.bytes !== bytes.length) throw Error("远端正文长度冲突");
  }
  private async deliver(event: CaptureEvent, source?: string) {
    if (event.hash) {
      if (source === undefined) throw Error("缺少待发送正文");
      const bytes = new TextEncoder().encode(source);
      if (
        bytes.length > CAPTURE_LIMITS.file ||
        digest(bytes) !== event.hash ||
        new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(
          bytes,
        ) !== source
      )
        throw Error("JS正文大小/哈希/Unicode校验失败");
      await this.putObject(bytes, event.hash, event.scan_id);
    }
    const payload = JSON.stringify(event),
      bytes = new TextEncoder().encode(payload),
      hash = digest(bytes);
    let envelope: Record<string, unknown> = {
      schema: "capture-stream-1",
      event_json: payload,
      event_sha256: hash,
    };
    if (bytes.length > 1048576) {
      await this.putObject(bytes, hash, event.scan_id);
      envelope = {
        schema: "capture-stream-1",
        event_object_sha256: hash,
        event_sha256: hash,
      };
    }
    const ack = await (
      await this.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
    ).json();
    if (
      ack.schema !== "capture-stream-1" ||
      ack.event_id !== event.id ||
      ack.event_sha256 !== hash ||
      ack.content_sha256 !== (event.hash ?? null) ||
      ack.durable !== true
    )
      throw Error("事件持久确认无效");
    this.acknowledged++;
    if (event.kind === "ObservedRequest")
      this.requestsByScan.set(
        event.scan_id,
        this.requestCount(event.scan_id) + 1,
      );
  }
  async page(scan: string, after = 0, summary = false) {
    return (
      await this.request(
        `/events?scan_id=${encodeURIComponent(scan)}&after=${after}${summary ? "&summary=1" : ""}`,
      )
    ).json() as Promise<{
      events: CaptureEvent[];
      count: number;
      next: number;
      has_more?: boolean;
    }>;
  }
  async source(hash: string) {
    const bytes = new Uint8Array(
      await (await this.request(`/objects/${hash}`)).arrayBuffer(),
    );
    if (digest(bytes) !== hash) throw Error("回读正文哈希不一致");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  }
}
