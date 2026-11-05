/** Durable temporary evidence. Upgrade retains unconfirmed v1 payloads and counters. */
let opening: Promise<IDBDatabase> | undefined;
export function descriptor(value: any) {
  const {
    source: _source,
    payload: _payload,
    original: _original,
    ack: _ack,
    ...row
  } = value;
  return {
    ...row,
    persisted: true,
    hydrated: false,
    event: { ...value.event, data: {} },
  };
}
export async function evidenceDatabase() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("js-security-delivery-outbox", 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("capture_journal"))
        db.createObjectStore("capture_journal", { keyPath: "id" }).createIndex(
          "scan",
          "scan_id",
        );
      if (!db.objectStoreNames.contains("journal_ledgers"))
        db.createObjectStore("journal_ledgers", { keyPath: "scan_id" });
      if (!db.objectStoreNames.contains("capture_counters"))
        db.createObjectStore("capture_counters", { keyPath: "scan_id" });
      if (!db.objectStoreNames.contains("entries"))
        db.createObjectStore("entries", { keyPath: "key" }).createIndex(
          "stream",
          "stream_id",
        );
      if (!db.objectStoreNames.contains("ledgers"))
        db.createObjectStore("ledgers", { keyPath: "stream_id" }).createIndex(
          "scope_scan",
          ["scope", "scan_id"],
        );
      if (!db.objectStoreNames.contains("payloads")) {
        db.createObjectStore("payloads", { keyPath: "key" });
        const entries = request.transaction!.objectStore("entries"),
          payloads = request.transaction!.objectStore("payloads");
        const cursor = entries.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          payloads.put(current.value);
          current.update(descriptor(current.value));
          current.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      opening = undefined;
      reject(Error("待传数据库被旧窗口占用"));
    };
  }));
}
export async function evidenceWrite(
  action: (tx: IDBTransaction) => void,
  stores = ["entries", "payloads", "ledgers"],
) {
  const db = await evidenceDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite", {
      durability: "strict",
    });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error("待传事务已中止"));
    tx.onerror = () => reject(tx.error);
    try {
      action(tx);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
