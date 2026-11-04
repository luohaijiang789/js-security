import { deliveryOutbox } from "./delivery-outbox";
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
  transport?: { stream_id: string; sequence: number };
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
  transport?: { stream_id: string; sequence: number; event_bytes: number };
};
export type DeliveryStatus = {
  stream_id: string;
  admitted: number;
  acknowledged: number;
  pending: number;
  rejected: number;
  pending_bytes: number;
  categories: Record<string, number>;
  bytes: number;
  sealed: boolean;
};
export type StreamReceipt = {
  schema: string;
  stream_id: string;
  scan_id: string;
  count: number;
  categories: Record<string, number>;
  bytes: number;
  sealed: true;
  durable: true;
};
type UploadState = { id: string; offset: number };
type Delivery = {
  key: string;
  stream_id: string;
  scope: string;
  original: CaptureEvent;
  event: CaptureEvent;
  source?: string;
  persisted?: boolean;
  payload?: string;
  size: number;
  sourceUpload: UploadState;
  eventUpload: UploadState;
  ack?: DeliveryAck;
};
type Ledger = DeliveryStatus & {
  scan_id: string;
  scope: string;
  closing?: boolean;
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
  private pending = new Map<string, Delivery>();
  private ledgers = new Map<string, Ledger>();
  private retrying?: Promise<void>;
  private admissionTail: Promise<unknown> = Promise.resolve();
  private unsealed = new Set<string>();
  acknowledged = 0;
  private requestsByScan = new Map<string, number>();
  failure = "";
  requestCount(scan: string) {
    return this.requestsByScan.get(scan) ?? 0;
  }
  get failed() {
    return !!this.failure;
  }
  private ledger(scan: string): Ledger {
    let row = this.ledgers.get(scan);
    if (!row) {
      row = {
        stream_id: crypto.randomUUID(),
        scan_id: scan,
        scope: this.scope(),
        admitted: 0,
        acknowledged: 0,
        pending: 0,
        rejected: 0,
        pending_bytes: 0,
        categories: {},
        bytes: 0,
        sealed: false,
      };
      this.ledgers.set(scan, row);
    }
    return row;
  }
  status(scan: string): DeliveryStatus | undefined {
    const row = this.ledgers.get(scan);
    return row ? structuredClone(row) : undefined;
  }
  isSealed(scan: string) {
    return this.ledgers.get(scan)?.sealed === true;
  }
  private scope() {
    const settings = this.settings();
    validateRemote(settings);
    return `${new URL(settings!.url).origin}\u0000${settings!.project}`;
  }
  private saved(entry: Delivery) {
    const { original: _original, ack: _ack, ...data } = entry;
    return data;
  }
  async restore(scan: string) {
    await this.drain();
    if (this.ledgers.has(scan) || !this.settings()) return;
    const saved = await deliveryOutbox.load(this.scope(), scan);
    if (!saved.ledgers.length) return;
    if (saved.ledgers.length !== 1)
      throw Error("任务存在多个传输流，需核对后恢复，不能猜测");
    const row = saved.ledgers[0] as Ledger;
    if (row.pending !== saved.entries.length)
      throw Error("待传元数据和正文数量不一致，不能视为恢复成功");
    this.ledgers.set(scan, row);
    for (const item of saved.entries.sort(
      (a, b) => a.event.transport.sequence - b.event.transport.sequence,
    ))
      this.pending.set(item.key, { ...item, original: item.event });
    if (row.closing && !row.sealed) this.unsealed.add(scan);
    if (row.pending || (row.closing && !row.sealed))
      this.failure = "已恢复持久待确认数据，请重试补传";
    this.requestsByScan.set(scan, row.categories.api_request ?? 0);
  }
  async drain() {
    await this.admissionTail;
    await this.tail;
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
    const copy = structuredClone(event);
    return new Promise((resolve, reject) => {
      const admission = this.admissionTail.then(async () => {
        const ledger = this.ledger(copy.scan_id);
        if (ledger.scope !== this.scope())
          throw Error("任务接收地址发生变化，不能误投待传数据");
        if (ledger.sealed || this.unsealed.has(copy.scan_id))
          throw Error("传输流正在核对或已封账，不接纳新事件");
        const size =
          new TextEncoder().encode(JSON.stringify(copy)).length +
          (source === undefined ? 0 : new TextEncoder().encode(source).length);
        const pendingBytes = [...this.ledgers.values()].reduce(
          (n, l) => n + l.pending_bytes,
          0,
        );
        if (this.pending.size >= 4096 || pendingBytes + size > 256 * 1048576) {
          ledger.rejected++;
          throw Error(
            "未确认队列超过4096项/256MiB；该事件未接纳，必须登记缺口",
          );
        }
        if (
          [...this.pending.values()].some((item) => item.event.id === copy.id)
        )
          throw Error("同一事件仍待确认，不能重复入队");
        copy.transport = {
          stream_id: ledger.stream_id,
          sequence: ledger.admitted + 1,
        };
        const key = `${ledger.stream_id}:${copy.transport.sequence}`;
        const entry: Delivery = {
          key,
          stream_id: ledger.stream_id,
          scope: ledger.scope,
          original: event,
          event: copy,
          source,
          size,
          sourceUpload: {
            id: crypto.randomUUID().replace(/-/g, ""),
            offset: 0,
          },
          eventUpload: { id: crypto.randomUUID().replace(/-/g, ""), offset: 0 },
        };
        const admitted = {
          ...ledger,
          admitted: ledger.admitted + 1,
          pending: ledger.pending + 1,
          pending_bytes: ledger.pending_bytes + size,
        };
        // Keep a recoverable in-memory reference even if disk quota/write fails.
        Object.assign(ledger, admitted);
        event.transport = structuredClone(copy.transport);
        this.pending.set(key, entry);
        try {
          await deliveryOutbox.admit(
            { ...this.saved(entry), persisted: true },
            admitted,
          );
          entry.persisted = true;
        } catch (error) {
          this.failure = `待传持久化失败，内容仍在内存，释放磁盘空间后恢复：${String(error)}`;
          throw Error(this.failure);
        }
        const operation = this.tail.then(async () => {
          if (this.failed) throw Error("本事件已持久保留，请恢复重传");
          return this.attempt(key, entry);
        });
        this.tail = operation.catch(() => {});
        void operation.then(resolve, reject);
      });
      this.admissionTail = admission.catch(() => {});
      void admission.catch(reject);
    });
  }
  private async attempt(key: string, entry: Delivery): Promise<DeliveryAck> {
    if (entry.ack) return entry.ack;
    try {
      if (entry.scope !== this.scope())
        throw Error("接收地址不匹配，禁止跨服务器重传");
      if (!entry.persisted) {
        await deliveryOutbox.admit(
          { ...this.saved(entry), persisted: true },
          this.ledger(entry.event.scan_id),
        );
        entry.persisted = true;
      }
      const ack = await this.deliver(entry);
      const commit = this.admissionTail.then(async () => {
        const ledger = this.ledger(entry.event.scan_id);
        const confirmed = {
          ...ledger,
          pending: ledger.pending - 1,
          pending_bytes: ledger.pending_bytes - entry.size,
          acknowledged: ledger.acknowledged + 1,
          bytes: ledger.bytes + new TextEncoder().encode(entry.payload!).length,
          categories: {
            ...ledger.categories,
            [entry.event.category]:
              (ledger.categories[entry.event.category] ?? 0) + 1,
          },
        };
        // ACK metadata and payload deletion must be one transaction, including after a crash.
        await deliveryOutbox.confirm(key, confirmed);
        Object.assign(ledger, confirmed);
      });
      this.admissionTail = commit.catch(() => {});
      await commit;
      entry.ack = ack;
      this.pending.delete(key);
      this.acknowledged++;
      if (entry.event.kind === "ObservedRequest")
        this.requestsByScan.set(
          entry.event.scan_id,
          this.requestCount(entry.event.scan_id) + 1,
        );
      // Preserve callers' object-reference contract without reading mutable caller data.
      entry.original.object_id = entry.event.object_id;
      if (entry.event.object_id)
        entry.original.data.source_bytes = entry.event.data.source_bytes;
      entry.source = undefined;
      return ack;
    } catch (error) {
      this.failure = String(error);
      throw error;
    }
  }
  async retry() {
    await this.admissionTail;
    if (this.retrying) return this.retrying;
    const operation = this.tail.then(async () => {
      this.failure = "";
      for (const [key, entry] of [...this.pending])
        await this.attempt(key, entry);
      for (const scan of [...this.unsealed]) await this.sealRequest(scan);
    });
    this.tail = operation.catch(() => {});
    this.retrying = operation;
    try {
      await operation;
    } finally {
      this.retrying = undefined;
    }
  }
  async seal(scan: string): Promise<StreamReceipt | undefined> {
    await this.drain();
    if (!this.ledgers.has(scan)) return; // Test adapters overriding send own their receipts.
    if (this.failed || this.status(scan)!.pending)
      throw Error("仍有未确认事件，不能封账");
    const row = this.ledger(scan);
    row.closing = true;
    await deliveryOutbox.ledger(row);
    this.unsealed.add(scan);
    return this.sealRequest(scan);
  }
  private async sealRequest(scan: string): Promise<StreamReceipt> {
    const row = this.ledger(scan);
    try {
      const receipt = (await (
        await this.request(`/streams/${row.stream_id}/seal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scan_id: scan,
            count: row.admitted,
            categories: row.categories,
            bytes: row.bytes,
          }),
        })
      ).json()) as StreamReceipt;
      const categories = Object.keys({
        ...row.categories,
        ...receipt.categories,
      });
      if (
        receipt.schema !== SCHEMA ||
        receipt.stream_id !== row.stream_id ||
        receipt.scan_id !== scan ||
        receipt.count !== row.admitted ||
        receipt.bytes !== row.bytes ||
        receipt.sealed !== true ||
        receipt.durable !== true ||
        !receipt.categories ||
        categories.some((k) => receipt.categories[k] !== row.categories[k])
      )
        throw Error("服务器分类账与客户端不一致，不能标记传输完成");
      await deliveryOutbox.ledger({ ...row, sealed: true, closing: false });
      row.sealed = true;
      row.closing = false;
      this.unsealed.delete(scan);
      this.failure = "";
      return receipt;
    } catch (error) {
      this.failure = String(error);
      throw error;
    }
  }
  /** Uploads raw UTF-8 text without any browser-side hash; the receiver assigns the ID. */
  async upload(
    text: string,
    url: string | null,
    kind: "js" | "event",
    limit: number,
    state: UploadState = {
      id: crypto.randomUUID().replace(/-/g, ""),
      offset: 0,
    },
  ): Promise<ObjectAck> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > limit) throw Error("传输对象超过大小预算");
    const uploadId = state.id;
    for (
      let offset = state.offset;
      offset < bytes.length;
      offset += CAPTURE_LIMITS.chunk
    ) {
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
      if (
        ack.upload !== uploadId ||
        ack.offset !== offset ||
        ack.durable !== true
      )
        throw Error("分块确认无效");
      state.offset = offset + chunk.length;
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
  private async deliver(entry: Delivery): Promise<DeliveryAck> {
    const event = entry.event;
    if (entry.source !== undefined) {
      const object = await this.upload(
        entry.source,
        event.data.object_url ?? event.data.url ?? null,
        "js",
        CAPTURE_LIMITS.file,
        entry.sourceUpload,
      );
      event.object_id = object.object_id;
      event.data.source_bytes = object.bytes;
      entry.source = undefined;
      await deliveryOutbox.update(this.saved(entry));
    }
    const payload = (entry.payload ??= JSON.stringify(event)),
      bytes = new TextEncoder().encode(payload);
    let envelope: Record<string, unknown> = {
      schema: SCHEMA,
      event_json: payload,
    };
    if (bytes.length > 1048576) {
      const object = await this.upload(
        payload,
        null,
        "event",
        128 * 1048576,
        entry.eventUpload,
      );
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
      !/^[a-f0-9]{64}$/.test(ack.event_sha256 ?? "") ||
      (event.object_id !== undefined && ack.object_id !== event.object_id) ||
      ack.transport?.stream_id !== event.transport?.stream_id ||
      ack.transport?.sequence !== event.transport?.sequence ||
      ack.transport?.event_bytes !== bytes.length
    )
      throw Error("事件持久确认无效");
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
