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

export type RequestQuery = {
  after?: string;
  limit?: number;
  text?: string;
  resource?: string;
  group?: string;
  direction?: "newest" | "oldest";
};
type ViewCursor = {
  version: 1;
  index: "ordinal" | "scan";
  key: string | number;
  id: string;
};
function pageLimit(value: number | undefined) {
  return Number.isInteger(value) ? Math.min(500, Math.max(1, value!)) : 50;
}
function decodeCursor(
  value: string | undefined,
  ordered: boolean,
): ViewCursor | undefined {
  if (!value) return undefined;
  const index = ordered ? "ordinal" : "scan";
  if (value.startsWith("{")) {
    let parsed: ViewCursor;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw Error("分页游标无效，请返回第一页。");
    }
    if (
      parsed.version !== 1 ||
      parsed.index !== index ||
      typeof parsed.id !== "string" ||
      (ordered
        ? typeof parsed.key !== "number" || !Number.isFinite(parsed.key)
        : typeof parsed.key !== "string")
    )
      throw Error("请求排序发生变化或分页游标无效，请返回第一页。");
    return parsed;
  }
  const key = ordered ? Number(value) : value;
  if (ordered && !Number.isFinite(key))
    throw Error("请求排序发生变化，请返回第一页。");
  return { version: 1, index, key, id: "" };
}

export async function queryRequests(scan: string, options: RequestQuery = {}) {
  return transact(["requests"], "readonly", async (tx) => {
    const store = tx.objectStore("requests"),
      legacy = store.index("scan");
    // A previous development build may have stored records without ordinal values or the index itself.
    const ordinal = store.indexNames.contains("ordinal")
      ? store.index("ordinal")
      : undefined;
    const scanRange = IDBKeyRange.bound([scan], [scan, []]);
    const [total, orderedCount] = await Promise.all([
      request(legacy.count(scanRange)),
      ordinal ? request(ordinal.count(scanRange)) : Promise.resolve(-1),
    ]);
    const ordered = !!ordinal && total === orderedCount,
      index = ordered ? ordinal! : legacy;
    const reverse = options.direction !== "oldest",
      after = decodeCursor(options.after, ordered),
      limit = pageLimit(options.limit);
    const range = after
      ? reverse
        ? IDBKeyRange.bound([scan], [scan, after.key])
        : IDBKeyRange.bound([scan, after.key], [scan, []])
      : scanRange;
    const text = options.text?.trim().toLowerCase();
    const encode = (r: RecordEntry) =>
      JSON.stringify({
        version: 1,
        index: ordered ? "ordinal" : "scan",
        key: ordered ? r.ordinal! : r.request_id,
        id: r.request_id,
      } satisfies ViewCursor);
    return new Promise<{
      rows: RecordEntry[];
      hasMore: boolean;
      cursor: string;
      total: number;
    }>((resolve, reject) => {
      const rows: RecordEntry[] = [],
        cursor = index.openCursor(range, reverse ? "prev" : "next");
      const done = (hasMore: boolean) =>
        resolve({
          rows,
          hasMore,
          cursor: rows.length ? encode(rows.at(-1)!) : "",
          total,
        });
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          done(false);
          return;
        }
        const r = c.value as RecordEntry,
          key = ordered ? r.ordinal : r.request_id;
        if (
          after &&
          key === after.key &&
          (!after.id ||
            (reverse ? r.request_id >= after.id : r.request_id <= after.id))
        ) {
          c.continue();
          return;
        }
        const resource = options.resource;
        const matchResource =
          !resource ||
          resource === "all" ||
          (resource === "api"
            ? ["XHR", "Fetch", "Ping"].includes(r.resource_type)
            : resource === "other"
              ? !["XHR", "Fetch", "Ping", "Document"].includes(r.resource_type)
              : r.resource_type === resource);
        if (
          matchResource &&
          (!options.group || r.group_id === options.group) &&
          (!text || JSON.stringify(r).toLowerCase().includes(text))
        ) {
          if (rows.length === limit) {
            done(true);
            return;
          }
          rows.push(r);
        }
        c.continue();
      };
    });
  });
}

/** Read only the protected, persisted in-flight snapshots; never mix these into final-request exports. */
export async function queryActive(scan: string, options: RequestQuery = {}) {
  let after:
    { version: 1; index: "active"; scan: string; id: string } | undefined;
  if (options.after) {
    try {
      after = JSON.parse(options.after);
    } catch {
      throw Error("在途请求分页游标无效，请返回第一页。");
    }
    if (
      !after ||
      after.version !== 1 ||
      after.index !== "active" ||
      after.scan !== scan ||
      typeof after.id !== "string"
    )
      throw Error("在途请求分页游标无效或属于其他视图，请返回第一页。");
  }
  return transact(["active"], "readonly", async (tx) => {
    const index = tx.objectStore("active").index("scan"),
      range = IDBKeyRange.only(scan);
    const total = await request(index.count(range)),
      rows: RecordEntry[] = [];
    const limit = pageLimit(options.limit),
      reverse = options.direction !== "oldest",
      text = options.text?.trim().toLowerCase();
    return new Promise<{
      rows: RecordEntry[];
      cursor: string;
      hasMore: boolean;
      total: number;
    }>((resolve, reject) => {
      const query = index.openCursor(range, reverse ? "prev" : "next");
      const done = (hasMore: boolean) =>
        resolve({
          rows,
          hasMore,
          total,
          cursor: rows.length
            ? JSON.stringify({
                version: 1,
                index: "active",
                scan,
                id: rows.at(-1)!.request_id,
              })
            : "",
        });
      query.onerror = () => reject(query.error);
      query.onsuccess = () => {
        const c = query.result;
        if (!c) {
          done(false);
          return;
        }
        const r = c.value as RecordEntry;
        if (
          after &&
          (reverse ? r.request_id >= after.id : r.request_id <= after.id)
        ) {
          if (
            r.request_id !== after.id &&
            typeof c.continuePrimaryKey === "function"
          )
            c.continuePrimaryKey(scan, after.id);
          else c.continue();
          return;
        }
        const resource = options.resource;
        const matchResource =
          !resource ||
          resource === "all" ||
          (resource === "api"
            ? ["XHR", "Fetch", "Ping"].includes(r.resource_type)
            : resource === "other"
              ? !["XHR", "Fetch", "Ping", "Document"].includes(r.resource_type)
              : r.resource_type === resource);
        if (
          matchResource &&
          (!options.group || r.group_id === options.group) &&
          (!text || JSON.stringify(r).toLowerCase().includes(text))
        ) {
          if (rows.length === limit) {
            done(true);
            return;
          }
          rows.push(r);
        }
        c.continue();
      };
    });
  });
}

export async function queryGroups(
  scan: string,
  text = "",
  offset = 0,
  limit = 50,
) {
  const normalized = text.trim().toLowerCase(),
    start = Number.isInteger(offset) ? Math.max(0, offset) : 0,
    size = pageLimit(limit);
  return transact(
    ["groups"],
    "readonly",
    (tx) =>
      new Promise<{ rows: Group[]; hasMore: boolean }>((resolve, reject) => {
        const rows: Group[] = [];
        let matched = 0;
        const query = tx
          .objectStore("groups")
          .index("scan")
          .openCursor(IDBKeyRange.only(scan));
        query.onerror = () => reject(query.error);
        query.onsuccess = () => {
          const c = query.result;
          if (!c) {
            resolve({ rows, hasMore: false });
            return;
          }
          const group = c.value as Group;
          if (
            !normalized ||
            [
              group.id,
              group.normalized_url,
              ...(Array.isArray(group.changes) ? group.changes : []),
            ]
              .join(" ")
              .toLowerCase()
              .includes(normalized)
          ) {
            if (matched++ >= start) {
              if (rows.length >= size) {
                resolve({ rows, hasMore: true });
                return;
              }
              rows.push(group);
            }
          }
          c.continue();
        };
      }),
  );
}

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
