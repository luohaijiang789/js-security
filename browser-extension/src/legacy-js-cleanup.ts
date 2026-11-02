/** Legacy JS cache cleanup only. New capture never writes JS to IndexedDB. */
const read = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("js-security-js-outbox", 1);
    r.onupgradeneeded = () => r.transaction?.abort();
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
export async function removeJSScan(scan: string) {
  if (
    !(await indexedDB.databases()).some(
      (db) => db.name === "js-security-js-outbox",
    )
  )
    return;
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
        const event = c.value as { hash?: string; bytes?: number };
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
