import { journalSnapshot } from "../storage/capture-journal";
import {
  type CaptureEvent,
  type RemoteSettings,
  type ObjectAck,
  type DeliveryAck,
  type DeliveryStatus,
  type StreamReceipt,
  validateRemote,
} from "../domain/evidence";
import { SCHEMA, CAPTURE_LIMITS, RECEIVER_CODE } from "./protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deliveryOutbox } from "./outbox";
type UploadState = { id: string; offset: number };
type Delivery = {
  key: string;
  stream_id: string;
  scope: string;
  original?: WeakRef<CaptureEvent>;
  event: CaptureEvent;
  source?: string;
  journal_id?: string;
  persisted?: boolean;
  hydrated?: boolean;
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
  capture_journal?: import("../domain/evidence").CaptureManifest;
  acknowledged_ahead?: number[];
};

async function fingerprint(bytes: Uint8Array) {
  const hasher = sha256.create();
  for (let offset = 0; offset < bytes.length; offset += 1048576) {
    hasher.update(bytes.subarray(offset, offset + 1048576));
    if (offset && offset % (4 * 1048576) === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return bytesToHex(hasher.digest());
}

export class RemoteCapture {
  private active = new Map<string, Promise<void>>();
  private waiters = new Map<
    string,
    { resolve: (ack: DeliveryAck) => void; reject: (error: unknown) => void }
  >();
  private scheduling?: Promise<void>;
  private reschedule = false;
  private negotiation?: Promise<void>;
  private negotiatedScope?: string;
  private parallel = false;
  private rawSupported = false;
  private commandsSupported = false;
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
        contiguous_sequence: 0,
        acknowledged_ahead: [],
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
    if (!row) return undefined;
    const volatile = [...this.pending.values()].filter(
      (entry) => entry.event.scan_id === scan && !entry.persisted,
    );
    return {
      ...structuredClone(row),
      admitted: row.admitted + volatile.length,
      pending: row.pending + volatile.length,
      pending_bytes:
        row.pending_bytes +
        volatile.reduce((sum, entry) => sum + entry.size, 0),
      volatile_pending: volatile.length,
    };
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
    const saved = await deliveryOutbox.descriptors(this.scope(), scan);
    if (!saved.ledgers.length) return;
    if (saved.ledgers.length !== 1)
      throw Error("任务存在多个传输流，需核对后恢复，不能猜测");
    const row = saved.ledgers[0] as Ledger;
    if (row.pending !== saved.entries.length)
      throw Error("待传元数据和正文数量不一致，不能视为恢复成功");
    row.contiguous_sequence ??= row.acknowledged;
    row.acknowledged_ahead ??= [];
    const prefix = row.contiguous_sequence;
    const ahead = row.acknowledged_ahead;
    const pendingSequences = saved.entries.map(
      (item) => item.event.transport?.sequence,
    );
    const remaining = [...ahead, ...pendingSequences];
    if (
      !Number.isSafeInteger(prefix) ||
      prefix < 0 ||
      prefix > row.admitted ||
      prefix + ahead.length !== row.acknowledged ||
      row.acknowledged + row.pending !== row.admitted ||
      new Set(remaining).size !== remaining.length ||
      remaining.some(
        (sequence) =>
          !Number.isSafeInteger(sequence) ||
          sequence <= prefix ||
          sequence > row.admitted,
      ) ||
      saved.entries.some(
        (item) =>
          item.scope !== row.scope ||
          item.event.scan_id !== scan ||
          item.event.transport?.stream_id !== row.stream_id,
      )
    )
      throw Error("待传序号、已确认缺口与连续水位不一致，禁止猜测恢复");
    this.ledgers.set(scan, row);
    for (const item of saved.entries.sort(
      (a, b) => a.event.transport.sequence - b.event.transport.sequence,
    ))
      this.pending.set(item.key, { ...item });
    if (row.closing && !row.sealed) this.unsealed.add(scan);
    if (row.pending || (row.closing && !row.sealed))
      this.failure = "已恢复持久待确认数据，请重试补传";
    this.requestsByScan.set(scan, row.categories.api_request ?? 0);
  }
  async drain() {
    for (;;) {
      const admission = this.admissionTail;
      await admission;
      if (this.scheduling) await this.scheduling;
      await Promise.all([...this.active.values()]);
      if (
        admission === this.admissionTail &&
        !this.scheduling &&
        !this.active.size
      )
        return;
    }
  }
  private async negotiate() {
    const scope = this.scope();
    if (scope !== this.negotiatedScope) {
      if (this.active.size)
        throw Error("接收地址变化时仍有在途数据，不能切换传输能力");
      this.negotiation = undefined;
      this.parallel = false;
      this.negotiatedScope = scope;
    }
    if (!this.negotiation) {
      const operation = (async () => {
        const health = await (await this.request("/health")).json();
        this.rawSupported =
          Array.isArray(health.capabilities) &&
          health.capabilities.includes("raw-cdp-journal-1");
        this.commandsSupported =
          Array.isArray(health.capabilities) &&
          health.capabilities.includes("raw-cdp-commands-1");
        this.parallel =
          Array.isArray(health.capabilities) &&
          health.capabilities.includes("delivery-window-1") &&
          health.delivery_window === 64;
      })();
      this.negotiation = operation;
      try {
        await operation;
      } catch (error) {
        this.negotiation = undefined;
        throw error;
      }
    } else await this.negotiation;
  }
  private rejectBlocked() {
    for (const [key, waiter] of this.waiters) {
      if (this.active.has(key)) continue;
      waiter.reject(Error(this.failure || "本事件已持久保留，请恢复重传"));
      this.waiters.delete(key);
    }
  }
  private schedule() {
    if (this.scheduling) {
      this.reschedule = true;
      return;
    }
    const operation = (async () => {
      if (this.failed) {
        this.rejectBlocked();
        return;
      }
      await this.negotiate();
      await this.admissionTail;
      if (this.failed) {
        this.rejectBlocked();
        return;
      }
      const capacity = this.parallel ? 4 : 1;
      while (this.active.size < capacity) {
        const all = [...this.pending.values()].sort(
          (a, b) => a.event.transport!.sequence - b.event.transport!.sequence,
        );
        const eligible = all.filter(
          (entry) =>
            !this.active.has(entry.key) &&
            entry.event.transport!.sequence <=
              (this.ledger(entry.event.scan_id).contiguous_sequence ?? 0) +
                (this.parallel ? 64 : 1),
        );
        // Start the earliest gap first; reserve one lane for small events when using window mode.
        const large = [...this.active.keys()].filter(
          (key) => (this.pending.get(key)?.size ?? 0) > 1048576,
        ).length;
        const available = eligible.filter(
          (entry) => !this.parallel || entry.size <= 1048576 || large < 3,
        );
        const earliest = all[0];
        const entry =
          available.find((item) => item === earliest) ??
          available.find((item) => item.size <= 1048576) ??
          available[0];
        if (!entry) break;
        const key = entry.key;
        const work = this.attempt(key, entry)
          .then(
            (ack) => {
              this.waiters.get(key)?.resolve(ack);
              this.waiters.delete(key);
            },
            (error) => {
              this.waiters.get(key)?.reject(error);
              this.waiters.delete(key);
            },
          )
          .finally(() => {
            this.active.delete(key);
            this.schedule();
          });
        this.active.set(key, work);
      }
      if (this.pending.size && !this.active.size) {
        this.failure = "待传序号与连续水位不一致，不能跨越缺口发送";
        this.rejectBlocked();
      }
    })().catch((error) => {
      this.failure = String(error);
      this.rejectBlocked();
    });
    this.scheduling = operation.finally(() => {
      this.scheduling = undefined;
      if (this.reschedule) {
        this.reschedule = false;
        this.schedule();
      }
    });
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
          `${settings!.url.replace(/\/$/, "")}${path === "/health" ? path : `/v1/projects/${encodeURIComponent(settings!.project)}${path}`}`,
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
  send(
    event: CaptureEvent,
    source?: string,
    journal_id?: string,
  ): Promise<DeliveryAck> {
    const copy = structuredClone(event);
    return new Promise((resolve, reject) => {
      const admission = this.admissionTail.then(async () => {
        if ([...this.pending.values()].some((entry) => !entry.persisted))
          throw Error("仍有未持久化的待传数据，先恢复写盘后再接纳新事件");
        const ledger = this.ledger(copy.scan_id);
        if (ledger.scope !== this.scope())
          throw Error("任务接收地址发生变化，不能误投待传数据");
        if (ledger.sealed || ledger.closing || this.unsealed.has(copy.scan_id))
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
          original: new WeakRef(event),
          journal_id,
          event: copy,
          source,
          size,
          sourceUpload: {
            id: crypto.randomUUID().replace(/-/g, ""),
            offset: 0,
          },
          eventUpload: { id: crypto.randomUUID().replace(/-/g, ""), offset: 0 },
        };
        // Reserve a stable identity in memory, but never include it in durable ledger totals yet.
        event.transport = structuredClone(copy.transport);
        this.pending.set(key, entry);
        try {
          await this.persistAdmission(entry);
          // The durable payload is authoritative; keep only the descriptor until this upload runs.
          entry.source = undefined;
          entry.payload = undefined;
          entry.event = { ...entry.event, data: {} };
          entry.hydrated = false;
          source = undefined;
        } catch (error) {
          this.failure = `待传持久化失败，内容仍在内存，释放磁盘空间后恢复：${String(error)}`;
          throw Error(this.failure);
        }
        this.waiters.set(key, { resolve, reject });
        this.schedule();
      });
      this.admissionTail = admission.catch(() => {});
      void admission.catch(reject);
    });
  }
  private async persistAdmission(entry: Delivery) {
    const ledger = this.ledger(entry.event.scan_id);
    if (entry.event.transport!.sequence !== ledger.admitted + 1)
      throw Error("未持久化条目的预留序号与已持久账目不一致");
    const admitted = {
      ...ledger,
      admitted: ledger.admitted + 1,
      pending: ledger.pending + 1,
      pending_bytes: ledger.pending_bytes + entry.size,
    };
    await deliveryOutbox.admit(
      { ...this.saved(entry), persisted: true },
      admitted,
    );
    Object.assign(ledger, admitted);
    entry.persisted = true;
  }
  private async attempt(key: string, entry: Delivery): Promise<DeliveryAck> {
    if (entry.ack) return entry.ack;
    try {
      if (entry.persisted && entry.hydrated === false) {
        const stored = await deliveryOutbox.entry(key);
        if (!stored) throw Error("持久待传正文缺失，不能确认或清理");
        entry = {
          ...stored,
          original: entry.original,
          persisted: true,
          hydrated: true,
        };
        this.pending.set(key, entry);
      }
      if (entry.scope !== this.scope())
        throw Error("接收地址不匹配，禁止跨服务器重传");
      if (!entry.persisted) {
        const admission = this.admissionTail.then(() =>
          this.persistAdmission(entry),
        );
        this.admissionTail = admission.catch(() => {});
        await admission;
      }
      if (entry.event.kind === "RawCdpEvent" && !this.rawSupported)
        throw Error("后端不支持原始日志，请更新后端后恢复补传");
      if (
        entry.event.kind.startsWith("RawCdpCommand") &&
        !this.commandsSupported
      )
        throw Error("后端不支持命令结果日志，请更新后端后恢复补传");
      const ack = await this.deliver(entry);
      const commit = this.admissionTail.then(async () => {
        const ledger = this.ledger(entry.event.scan_id);
        let prefix = ledger.contiguous_sequence ?? ledger.acknowledged;
        const ahead = new Set(ledger.acknowledged_ahead ?? []);
        ahead.add(entry.event.transport!.sequence);
        while (ahead.delete(prefix + 1)) prefix++;
        const confirmed = {
          ...ledger,
          contiguous_sequence: prefix,
          acknowledged_ahead: [...ahead].sort((a, b) => a - b),
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
      const original = entry.original?.deref();
      if (original) {
        original.object_id = entry.event.object_id;
        if (entry.event.object_id)
          original.data.source_bytes = entry.event.data.source_bytes;
      }
      entry.source = undefined;
      return ack;
    } catch (error) {
      this.failure = String(error);
      throw error;
    }
  }
  async retry() {
    if (this.retrying) return this.retrying;
    const operation = (async () => {
      await this.drain();
      this.failure = "";
      this.negotiation = undefined; // A resumed task may be talking to an upgraded receiver.
      this.schedule();
      await this.drain();
      if (this.failed) throw Error(this.failure);
      for (const scan of [...this.unsealed]) await this.sealRequest(scan);
    })();
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
    if (
      row.contiguous_sequence !== row.admitted ||
      row.acknowledged_ahead?.length
    )
      throw Error("已确认序号仍有缺口，不能封账");
    const journal = await journalSnapshot(scan);
    if (journal.pending || journal.handed_off !== journal.admitted)
      throw Error("原始日志尚未移交，不能封账");
    if (journal.admitted)
      row.capture_journal = {
        count: journal.admitted,
        bytes: journal.bytes,
        by_kind: journal.by_kind,
      };
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
            capture_journal: row.capture_journal,
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
      if (row.capture_journal) {
        const actual = receipt.capture_journal,
          expected = row.capture_journal;
        if (
          !actual ||
          actual.count !== expected.count ||
          actual.bytes !== expected.bytes ||
          Object.keys({ ...actual.by_kind, ...expected.by_kind }).some(
            (key) => actual.by_kind[key] !== expected.by_kind[key],
          )
        )
          throw Error("服务器原始日志账目不一致，不能封账");
      }
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
  /** Byte integrity is independently checked by sender and receiver before ACK cleanup. */
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
    const expected = await fingerprint(bytes);
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
            "X-Chunk-SHA256": bytesToHex(sha256(chunk)),
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
        body: JSON.stringify({
          bytes: bytes.length,
          url,
          kind,
          expected_sha256: expected,
        }),
      })
    ).json()) as ObjectAck;
    if (
      typeof ack.object_id !== "string" ||
      ack.object_id !== expected ||
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
    const expected = await fingerprint(bytes);
    let envelope: Record<string, unknown> = {
      schema: SCHEMA,
      event_json: payload,
      event_sha256: expected,
    };
    if (this.parallel) envelope.delivery_mode = "window-1";
    if (bytes.length > 1048576) {
      const object = await this.upload(
        payload,
        null,
        "event",
        128 * 1048576,
        entry.eventUpload,
      );
      envelope = {
        schema: SCHEMA,
        ...(this.parallel ? { delivery_mode: "window-1" } : {}),
        event_object_id: object.object_id,
        event_sha256: expected,
      };
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
      ack.event_sha256 !== expected ||
      (event.object_id !== undefined && ack.object_id !== event.object_id) ||
      ack.transport?.stream_id !== event.transport?.stream_id ||
      ack.transport?.sequence !== event.transport?.sequence ||
      ack.transport?.event_bytes !== bytes.length ||
      (this.parallel &&
        (ack.transport?.window !== 64 ||
          !Number.isSafeInteger(ack.transport.contiguous_sequence) ||
          ack.transport.contiguous_sequence! < 0))
    )
      throw Error("事件持久确认无效");
    return ack;
  }
  async eventInfo(scan: string, id: string) {
    return (
      await this.request(
        `/events?scan_id=${encodeURIComponent(scan)}&event_id=${encodeURIComponent(id)}`,
      )
    ).json() as Promise<{ event: CaptureEvent; event_sha256: string }>;
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
