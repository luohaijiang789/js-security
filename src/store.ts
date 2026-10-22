import type { Scan, RecordEntry, Group, Batch, CaptureError } from "./model";
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
let dbPromise: Promise<IDBDatabase> | undefined;
export function database() {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("js-security-recorder", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of ["scans", "errors", "batches", "groups"]) {
        const s = d.createObjectStore(name, { keyPath: "id" });
        if (name !== "scans") s.createIndex("scan", "scan_id");
      }
      const entries = d.createObjectStore("requests", {
        keyPath: "request_id",
      });
      entries.createIndex("scan", ["scan_id", "request_id"]);
      entries.createIndex("group", "group_id");
      entries.createIndex("ordinal", ["scan_id", "ordinal"]);
      const active = d.createObjectStore("active", { keyPath: "request_id" });
      active.createIndex("scan", "scan_id");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const d = await database();
  const tx = d.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? Error("事务取消"));
  });
  try {
    const result = await fn(tx);
    await done;
    return result;
  } catch (e) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw e;
  }
}
export async function put(store: string, value: unknown) {
  return transact([store], "readwrite", (tx) =>
    request(tx.objectStore(store).put(value)),
  );
}
export async function get<T>(
  store: string,
  id: string,
): Promise<T | undefined> {
  return transact([store], "readonly", (tx) =>
    request(tx.objectStore(store).get(id)),
  );
}
export async function all<T>(store: string, scan_id?: string): Promise<T[]> {
  return transact([store], "readonly", (tx) =>
    request(
      scan_id
        ? tx.objectStore(store).index("scan").getAll(scan_id)
        : tx.objectStore(store).getAll(),
    ),
  );
}
export async function page(
  scan: string,
  after = "",
  limit = 100,
): Promise<RecordEntry[]> {
  return transact(["requests"], "readonly", (tx) =>
    request(
      tx
        .objectStore("requests")
        .index("scan")
        .getAll(
          IDBKeyRange.bound([scan, after], [scan, "\uffff"], !!after, false),
          Math.min(limit, 500),
        ),
    ),
  );
}
export async function groupPage(
  scan: string,
  offset = 0,
  limit = 100,
): Promise<Group[]> {
  return transact(
    ["groups"],
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const rows: Group[] = [];
        const r = tx
          .objectStore("groups")
          .index("scan")
          .openCursor(IDBKeyRange.only(scan));
        let skipped = false;
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor || rows.length >= limit) {
            resolve(rows);
            return;
          }
          if (offset && !skipped) {
            skipped = true;
            cursor.advance(offset);
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      }),
  );
}
export async function commit(
  scan: Scan,
  entries: RecordEntry[],
  groups: Map<string, Group>,
  active: RecordEntry[],
) {
  return transact(
    ["scans", "requests", "groups", "errors", "active"],
    "readwrite",
    async (tx) => {
      for (const r of entries) tx.objectStore("requests").put(r);
      for (const g of groups.values()) tx.objectStore("groups").put(g);
      const old = await request(
        tx.objectStore("active").index("scan").getAllKeys(scan.id),
      );
      old.forEach((k) => tx.objectStore("active").delete(k));
      active.forEach((r) => tx.objectStore("active").put(r));
      scan.gaps.forEach((g) => tx.objectStore("errors").put(g));
      tx.objectStore("scans").put(scan);
    },
  );
}
export async function removeScan(id: string) {
  await transact(
    ["scans", "requests", "groups", "errors", "batches", "active"],
    "readwrite",
    async (tx) => {
      tx.objectStore("scans").delete(id);
      for (const name of [
        "requests",
        "groups",
        "errors",
        "batches",
        "active",
      ]) {
        const index = tx.objectStore(name).index("scan");
        const range =
          name === "requests"
            ? IDBKeyRange.bound([id, ""], [id, "\uffff"])
            : IDBKeyRange.only(id);
        const keys = await request(index.getAllKeys(range));
        keys.forEach((k) => tx.objectStore(name).delete(k));
      }
    },
  );
}
export type { Scan, RecordEntry, Group, Batch, CaptureError };

export async function archivePage(
  scan: string,
  after = 0,
  limit = 200,
): Promise<RecordEntry[]> {
  return transact(["requests"], "readonly", (tx) =>
    request(
      tx
        .objectStore("requests")
        .index("ordinal")
        .getAll(
          IDBKeyRange.bound(
            [scan, after],
            [scan, Number.MAX_SAFE_INTEGER],
            true,
            false,
          ),
          limit,
        ),
    ),
  );
}

export async function searchPage(
  scan: string,
  query: string,
  after = "",
  limit = 100,
): Promise<RecordEntry[]> {
  return transact(
    ["requests"],
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const rows: RecordEntry[] = [];
        const r = tx
          .objectStore("requests")
          .index("scan")
          .openCursor(
            IDBKeyRange.bound([scan, after], [scan, "\uffff"], !!after, false),
          );
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c || rows.length >= limit) {
            resolve(rows);
            return;
          }
          if (
            JSON.stringify(c.value).toLowerCase().includes(query.toLowerCase())
          )
            rows.push(c.value);
          c.continue();
        };
      }),
  );
}

export async function errorPage(
  scan: string,
  offset = 0,
  limit = 200,
): Promise<CaptureError[]> {
  return transact(
    ["errors"],
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const rows: CaptureError[] = [];
        const r = tx
          .objectStore("errors")
          .index("scan")
          .openCursor(IDBKeyRange.only(scan));
        let skipped = false;
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor || rows.length >= limit) {
            resolve(rows);
            return;
          }
          if (offset && !skipped) {
            skipped = true;
            cursor.advance(offset);
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      }),
  );
}
