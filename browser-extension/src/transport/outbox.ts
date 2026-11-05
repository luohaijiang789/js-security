import {
  descriptor,
  evidenceDatabase,
  evidenceWrite,
} from "../storage/evidence-db";
function put(tx: IDBTransaction, entry: any) {
  tx.objectStore("entries").put(descriptor(entry));
  tx.objectStore("payloads").put(entry);
}
async function read(
  scope: string,
  scan: string,
  hydrate: boolean,
): Promise<{ ledgers: any[]; entries: any[] }> {
  const db = await evidenceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["ledgers", "entries", "payloads"], "readonly");
    const ledgers = tx
      .objectStore("ledgers")
      .index("scope_scan")
      .getAll([scope, scan]);
    const entries: any[] = [];
    ledgers.onsuccess = () => {
      for (const row of ledgers.result) {
        const request = tx
          .objectStore("entries")
          .index("stream")
          .getAll(row.stream_id);
        request.onsuccess = () => {
          for (const item of request.result) {
            if (!hydrate) {
              entries.push(item);
              continue;
            }
            const payload = tx.objectStore("payloads").get(item.key);
            payload.onsuccess = () => entries.push(payload.result ?? item);
          }
        };
      }
    };
    tx.oncomplete = () => resolve({ ledgers: ledgers.result, entries });
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export const deliveryOutbox = {
  async admit(entry: object, ledger: object) {
    await evidenceWrite((tx) => {
      put(tx, entry);
      tx.objectStore("ledgers").put(ledger);
    });
  },
  async update(entry: object) {
    await evidenceWrite((tx) => put(tx, entry));
  },
  async confirm(key: string, ledger: object) {
    await evidenceWrite((tx) => {
      tx.objectStore("entries").delete(key);
      tx.objectStore("payloads").delete(key);
      tx.objectStore("ledgers").put(ledger);
    });
  },
  async ledger(value: object) {
    await evidenceWrite((tx) => {
      tx.objectStore("ledgers").put(value);
    });
  },
  async load(scope: string, scan: string) {
    return read(scope, scan, true);
  },
  async descriptors(scope: string, scan: string) {
    return read(scope, scan, false);
  },
  async entry(key: string): Promise<any> {
    const db = await evidenceDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("payloads", "readonly"),
        r = tx.objectStore("payloads").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
};
