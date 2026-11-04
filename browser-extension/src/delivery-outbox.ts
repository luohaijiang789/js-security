/** Temporary payloads only: atomic admission and ACK cleanup, never an archive. */
const NAME = "js-security-delivery-outbox";
let opening: Promise<IDBDatabase> | undefined;
async function database() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: "key" }).createIndex(
        "stream",
        "stream_id",
      );
      db.createObjectStore("ledgers", { keyPath: "stream_id" }).createIndex(
        "scope_scan",
        ["scope", "scan_id"],
      );
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
async function write(action: (tx: IDBTransaction) => void) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["entries", "ledgers"], "readwrite", {
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
export const deliveryOutbox = {
  async admit(entry: object, ledger: object) {
    await write((tx) => {
      tx.objectStore("entries").put(entry);
      tx.objectStore("ledgers").put(ledger);
    });
  },
  async update(entry: object) {
    await write((tx) => {
      tx.objectStore("entries").put(entry);
    });
  },
  async confirm(key: string, ledger: object) {
    await write((tx) => {
      tx.objectStore("entries").delete(key);
      tx.objectStore("ledgers").put(ledger);
    });
  },
  async ledger(value: object) {
    await write((tx) => {
      tx.objectStore("ledgers").put(value);
    });
  },
  async load(
    scope: string,
    scan: string,
  ): Promise<{ ledgers: any[]; entries: any[] }> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["ledgers", "entries"], "readonly");
      const ledgers = tx
        .objectStore("ledgers")
        .index("scope_scan")
        .getAll([scope, scan]);
      const entries: any[] = [];
      ledgers.onsuccess = () => {
        for (const row of ledgers.result) {
          const read = tx
            .objectStore("entries")
            .index("stream")
            .getAll(row.stream_id);
          read.onsuccess = () => entries.push(...read.result);
        }
      };
      tx.oncomplete = () => resolve({ ledgers: ledgers.result, entries });
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  },
};
