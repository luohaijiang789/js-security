import type { Config } from "./model";
export type CaptureEvent = {
  id: string;
  scan_id: string;
  kind: string;
  category: string;
  time: string;
  tab_id?: number;
  session_id: string;
  epoch: string;
  data: Record<string, any>;
  /** Receiver-assigned body identifier; never computed in the browser. */
  object_id?: string;
  status: string;
};
export type RemoteSettings = { url: string; project: string };
export type ObjectAck = {
  object_id: string;
  url?: string | null;
  bytes: number;
  committed: true;
  durable: true;
};
export type DeliveryAck = {
  schema: string;
  event_id: string;
  event_sha256?: string;
  object_id?: string | null;
  durable: true;
};
export const SCHEMA = "capture-stream-2";
export const CAPTURE_LIMITS = { file: 64 * 1048576, chunk: 256 * 1024 };
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
  send(event: CaptureEvent, source?: string): Promise<DeliveryAck> {
    const operation = this.tail.then(async () => {
      if (this.pending) throw Error("有未确认数据，采集暂停；请先重试上传");
      try {
        return await this.deliver(event, source);
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
  /** Uploads raw UTF-8 text without any browser-side hash; the receiver assigns the ID. */
  async upload(
    text: string,
    url: string | null,
    kind: "js" | "event",
    limit: number,
  ): Promise<ObjectAck> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > limit) throw Error("传输对象超过大小预算");
    const uploadId = crypto.randomUUID().replace(/-/g, "");
    for (let offset = 0; offset < bytes.length; offset += CAPTURE_LIMITS.chunk) {
      const chunk = bytes.slice(offset, offset + CAPTURE_LIMITS.chunk);
      const ack = await (
        await this.request(`/uploads/${uploadId}/chunks/${offset}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Object-Bytes": String(bytes.length),
          },
          body: chunk,
        })
      ).json();
      if (ack.upload !== uploadId || ack.offset !== offset || ack.durable !== true)
        throw Error("分块确认无效");
    }
    const ack = (await (
      await this.request(`/uploads/${uploadId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes: bytes.length, url, kind }),
      })
    ).json()) as ObjectAck;
    if (
      typeof ack.object_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(ack.object_id) ||
      ack.bytes !== bytes.length ||
      (kind === "js" && ack.url !== url) ||
      ack.committed !== true ||
      ack.durable !== true
    )
      throw Error("正文持久确认无效");
    return ack;
  }
  private async deliver(
    event: CaptureEvent,
    source?: string,
  ): Promise<DeliveryAck> {
    if (source !== undefined) {
      const object = await this.upload(
        source,
        event.data.object_url ?? event.data.url ?? null,
        "js",
        CAPTURE_LIMITS.file,
      );
      event.object_id = object.object_id;
      event.data.source_bytes = object.bytes;
    }
    const payload = JSON.stringify(event),
      bytes = new TextEncoder().encode(payload);
    let envelope: Record<string, unknown> = {
      schema: SCHEMA,
      event_json: payload,
    };
    if (bytes.length > 1048576) {
      const object = await this.upload(payload, null, "event", 128 * 1048576);
      envelope = { schema: SCHEMA, event_object_id: object.object_id };
    }
    const ack = (await (
      await this.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
    ).json()) as DeliveryAck;
    if (
      ack.schema !== SCHEMA ||
      ack.event_id !== event.id ||
      ack.durable !== true ||
      (event.object_id !== undefined && ack.object_id !== event.object_id)
    )
      throw Error("事件持久确认无效");
    this.acknowledged++;
    if (event.kind === "ObservedRequest")
      this.requestsByScan.set(
        event.scan_id,
        this.requestCount(event.scan_id) + 1,
      );
    return ack;
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
  async source(objectId: string) {
    const bytes = new Uint8Array(
      await (await this.request(`/objects/${objectId}`)).arrayBuffer(),
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  }
}