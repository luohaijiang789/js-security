/** Durable local outbox. No event is acknowledged or evicted automatically. */
export type JSEvent = {
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
  bytes?: number;
};
export const JS_LIMITS = {
  file: 16 * 1048576,
  content: 256 * 1048576,
  metadata: 32 * 1048576,
};
const read = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("js-security-js-outbox", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("objects", { keyPath: "hash" });
      r.result.createObjectStore("object_meta", { keyPath: "hash" });
      r.result
        .createObjectStore("events", { keyPath: "id" })
        .createIndex("scan", ["scan_id", "id"]);
      r.result.createObjectStore("usage");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(
      ["objects", "object_meta", "events", "usage"],
      mode,
    );
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? Error("JS缓存事务中止"));
      tx.onerror = () => {}; // onabort owns rejection
    });
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  } finally {
    db.close();
  }
}
export async function appendJS(
  event: JSEvent,
  source?: string,
  limits = JS_LIMITS,
) {
  const bytes = new TextEncoder().encode(source ?? "").length;
  const metadata = new TextEncoder().encode(JSON.stringify(event)).length + 32;
  await transaction("readwrite", async (tx) => {
    const objects = tx.objectStore("objects"),
      events = tx.objectStore("events");
    const usage = tx.objectStore("usage");
    const objectMeta = tx.objectStore("object_meta");
    const totals = (await read(usage.get("total"))) ?? {
      content: 0,
      metadata: 0,
    };
    if (await read(events.get(event.id))) return;
    const object = event.hash
      ? await read(objectMeta.get(event.hash))
      : undefined;
    if (
      bytes > limits.file ||
      totals.content + (object ? 0 : bytes) > limits.content ||
      totals.metadata + metadata > limits.metadata
    )
      throw Error(
        "JS待传缓存达到预算；未确认内容未清理，请停止任务、导出并清理后新建任务",
      );
    if (event.hash) {
      if (!object && source === undefined) throw Error("JS正文引用不存在");
      objectMeta.put(
        object
          ? { ...object, refs: object.refs + 1 }
          : { hash: event.hash, bytes, refs: 1 },
      );
      if (!object) objects.put({ hash: event.hash, source });
    }
    events.put({ ...event, bytes: metadata });
    usage.put(
      {
        content: totals.content + (object ? 0 : bytes),
        metadata: totals.metadata + metadata,
      },
      "total",
    );
  });
}
export async function jsPage(
  scan: string,
  after = "",
  limit = 50,
): Promise<{ events: JSEvent[]; count: number; next: string }> {
  return transaction("readonly", async (tx) => {
    const index = tx.objectStore("events").index("scan");
    const range = IDBKeyRange.bound([scan, ""], [scan, "\uffff"]);
    const count = await read(index.count(range));
    const events: JSEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = index.openCursor(
        IDBKeyRange.bound([scan, after], [scan, "\uffff"], true),
      );
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const c = r.result;
        if (!c || events.length >= limit) return resolve();
        if (String(c.primaryKey) > after) events.push(c.value);
        c.continue();
      };
    });
    return { events, count, next: events.at(-1)?.id ?? "" };
  });
}
export async function jsSource(hash: string): Promise<string | undefined> {
  return transaction(
    "readonly",
    async (tx) => (await read(tx.objectStore("objects").get(hash)))?.source,
  );
}
export async function removeJSScan(scan: string) {
  await transaction("readwrite", async (tx) => {
    const events = tx.objectStore("events"),
      objects = tx.objectStore("objects"),
      usage = tx.objectStore("usage"),
      objectMeta = tx.objectStore("object_meta");
    const totals = (await read(usage.get("total"))) ?? {
      content: 0,
      metadata: 0,
    };
    await new Promise<void>((resolve, reject) => {
      const r = events
        .index("scan")
        .openCursor(IDBKeyRange.bound([scan, ""], [scan, "\uffff"]));
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const event = c.value as JSEvent;
        totals.metadata -= event.bytes ?? 0;
        if (event.hash) {
          const get = objectMeta.get(event.hash);
          get.onsuccess = () => {
            const obj = get.result;
            if (obj?.refs > 1) objectMeta.put({ ...obj, refs: obj.refs - 1 });
            else if (obj) {
              totals.content -= obj.bytes;
              objects.delete(event.hash!);
              objectMeta.delete(event.hash!);
            }
            c.delete();
            c.continue();
          };
        } else {
          c.delete();
          c.continue();
        }
      };
    });
    usage.put(totals, "total");
  });
}
