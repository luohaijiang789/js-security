import type {
  Scan,
  RecordEntry,
  Group,
  Batch,
  CaptureError,
  InitiatorGraph,
  InitiatorGraphNode,
  InitiatorParentMatch,
  InitiatorRelation,
  InitiatorNode,
} from "./model";
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
let dbPromise: Promise<IDBDatabase> | undefined;
export function database() {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("js-security-recorder", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of ["scans", "errors", "batches", "groups"]) {
        if (d.objectStoreNames.contains(name)) continue;
        const s = d.createObjectStore(name, { keyPath: "id" });
        if (name !== "scans") s.createIndex("scan", "scan_id");
      }
      const entries = d.objectStoreNames.contains("requests")
        ? r.transaction!.objectStore("requests")
        : d.createObjectStore("requests", { keyPath: "request_id" });
      if (!entries.indexNames.contains("scan"))
        entries.createIndex("scan", ["scan_id", "request_id"]);
      if (!entries.indexNames.contains("group"))
        entries.createIndex("group", "group_id");
      if (!entries.indexNames.contains("ordinal"))
        entries.createIndex("ordinal", ["scan_id", "ordinal"]);
      const active = d.objectStoreNames.contains("active")
        ? r.transaction!.objectStore("active")
        : d.createObjectStore("active", { keyPath: "request_id" });
      if (!active.indexNames.contains("scan"))
        active.createIndex("scan", "scan_id");
      if (!active.indexNames.contains("initiator_parent"))
        active.createIndex("initiator_parent", [
          "scan_id",
          "initiator_parent_id",
        ]);
      if (!d.objectStoreNames.contains("initiator_edges")) {
        const edges = d.createObjectStore("initiator_edges", {
          keyPath: "child_id",
        });
        edges.createIndex("scan", "scan_id");
        edges.createIndex("parent", ["scan_id", "parent_id"]);
      }
      if (!d.objectStoreNames.contains("initiator_nodes")) {
        const nodes = d.createObjectStore("initiator_nodes", {
          keyPath: "request_id",
        });
        nodes.createIndex("scan", "scan_id");
        nodes.createIndex("parent", ["scan_id", "parent_id"]);
      }
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
  initiatorNodes: InitiatorNode[] = [],
) {
  return transact(
    [
      "scans",
      "requests",
      "groups",
      "errors",
      "active",
      "initiator_edges",
      "initiator_nodes",
    ],
    "readwrite",
    async (tx) => {
      for (const r of entries) {
        tx.objectStore("requests").put(r);
      }
      for (const node of initiatorNodes) {
        tx.objectStore("initiator_nodes").put(node);
        if (node.parent_id)
          tx.objectStore("initiator_edges").put({
            scan_id: node.scan_id,
            child_id: node.request_id,
            parent_id: node.parent_id,
            resolution: node.resolution,
            relation: node.relation,
          } satisfies InitiatorEdge);
      }
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
    [
      "scans",
      "requests",
      "groups",
      "errors",
      "batches",
      "active",
      "initiator_edges",
      "initiator_nodes",
    ],
    "readwrite",
    async (tx) => {
      tx.objectStore("scans").delete(id);
      for (const name of [
        "requests",
        "groups",
        "errors",
        "batches",
        "active",
        "initiator_edges",
        "initiator_nodes",
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

type InitiatorEdge = {
  scan_id: string;
  child_id: string;
  parent_id: string;
  resolution?: InitiatorParentMatch;
  relation?: InitiatorRelation;
};

/** Indexed graph lookup: proportional to the visible chain, never to scan size. */
export async function queryInitiatorGraph(
  current: RecordEntry,
  maxNodes = 200,
): Promise<InitiatorGraph> {
  const limit = Number.isFinite(maxNodes)
    ? Math.min(500, Math.max(1, Math.floor(maxNodes)))
    : 200;
  return transact(
    ["requests", "active", "initiator_edges", "initiator_nodes"],
    "readonly",
    async (tx) => {
      const records = tx.objectStore("requests"),
        active = tx.objectStore("active"),
        edges = tx.objectStore("initiator_edges"),
        compactNodes = tx.objectStore("initiator_nodes"),
        parentIndex = edges.index("parent"),
        activeParentIndex = active.index("initiator_parent"),
        compactParentIndex = compactNodes.index("parent"),
        warnings: string[] = [],
        seen = new Set<string>([current.request_id]),
        available = new Set<string>([current.request_id]);
      let truncated = false;
      const readRecord = async (id: string) => {
        const full =
          (await request<RecordEntry | undefined>(records.get(id))) ??
          (await request<RecordEntry | undefined>(active.get(id)));
        if (full) {
          available.add(id);
          return full;
        }
        const compact = await request<InitiatorNode | undefined>(
          compactNodes.get(id),
        );
        return compact
          ? ({
              scan_id: compact.scan_id,
              request_id: compact.request_id,
              request_url: compact.request_url,
              initiator_parent_id: compact.parent_id,
              initiator_parent_match: compact.resolution,
              initiator_relation: compact.relation,
            } as RecordEntry)
          : undefined;
      };
      const readEdge = (id: string) =>
        request<InitiatorEdge | undefined>(edges.get(id));
      const incoming: Array<{ record: RecordEntry; edge?: InitiatorEdge }> = [
        {
          record: current,
          edge: current.initiator_parent_id
            ? {
                scan_id: current.scan_id,
                child_id: current.request_id,
                parent_id: current.initiator_parent_id,
                resolution: current.initiator_parent_match,
                relation: current.initiator_relation,
              }
            : undefined,
        },
      ];
      let virtualParent: { url: string; edge: InitiatorEdge } | undefined;
      let child = current;
      for (;;) {
        const edge =
          incoming[0].edge ??
          (child.initiator_parent_id
            ? {
                scan_id: child.scan_id,
                child_id: child.request_id,
                parent_id: child.initiator_parent_id,
                resolution: child.initiator_parent_match,
                relation: child.initiator_relation,
              }
            : await readEdge(child.request_id));
        if (!edge) break;
        if (edge.scan_id !== current.scan_id) {
          warnings.push("发起链索引属于其他任务，已停止展开。");
          break;
        }
        if (seen.has(edge.parent_id)) {
          warnings.push("发起链存在循环，已停止展开。");
          break;
        }
        const parent = await readRecord(edge.parent_id);
        if (
          !parent &&
          edge.relation === "initiator-url" &&
          child.initiator_url
        ) {
          virtualParent = {
            url: child.initiator_url,
            edge,
          };
          warnings.push("父请求未被保留，已按保存的 Initiator URL 补充一层。");
          break;
        }
        if (!parent || parent.scan_id !== current.scan_id) {
          warnings.push("部分父请求未被保留，发起链无法继续向上展开。");
          break;
        }
        seen.add(parent.request_id);
        incoming.unshift({
          record: parent,
          edge: await readEdge(parent.request_id),
        });
        child = parent;
        if (incoming.length >= limit) {
          truncated = true;
          break;
        }
      }
      const nodes: InitiatorGraphNode[] = virtualParent
        ? [
            {
              request_id: "",
              request_url: virtualParent.url,
              parent_id: null,
              current: false,
              depth: 0,
              resolution: virtualParent.edge.resolution ?? "inferred",
              relation: "initiator-url",
            },
          ]
        : [];
      nodes.push(
        ...incoming.map(({ record, edge }, index) => ({
          request_id: available.has(record.request_id) ? record.request_id : "",
          request_url: record.request_url,
          parent_id: index
            ? incoming[index - 1].record.request_id
            : virtualParent
              ? ""
              : null,
          current: record.request_id === current.request_id,
          depth: index + (virtualParent ? 1 : 0),
          resolution:
            edge?.resolution ?? record.initiator_parent_match ?? "none",
          relation: edge?.relation ?? record.initiator_relation ?? "none",
        })),
      );
      const appendChildren = async (parent: RecordEntry, depth: number) => {
        if (nodes.length >= limit) {
          truncated = true;
          return;
        }
        const childEdges = await request<InitiatorEdge[]>(
          parentIndex.getAll(
            IDBKeyRange.only([current.scan_id, parent.request_id]),
          ),
        );
        const activeChildren = await request<RecordEntry[]>(
          activeParentIndex.getAll(
            IDBKeyRange.only([current.scan_id, parent.request_id]),
          ),
        );
        const compactChildren = await request<InitiatorNode[]>(
          compactParentIndex.getAll(
            IDBKeyRange.only([current.scan_id, parent.request_id]),
          ),
        );
        const allChildren = [
          ...childEdges,
          ...activeChildren.map((record): InitiatorEdge => ({
            scan_id: record.scan_id,
            child_id: record.request_id,
            parent_id: parent.request_id,
            resolution: record.initiator_parent_match,
            relation: record.initiator_relation,
          })),
          ...compactChildren.map((node): InitiatorEdge => ({
            scan_id: node.scan_id,
            child_id: node.request_id,
            parent_id: node.parent_id!,
            resolution: node.resolution,
            relation: node.relation,
          })),
        ].sort((a, b) => a.child_id.localeCompare(b.child_id));
        const childIds = new Set<string>();
        for (const edge of allChildren) {
          if (edge.scan_id !== current.scan_id || childIds.has(edge.child_id))
            continue;
          childIds.add(edge.child_id);
          if (seen.has(edge.child_id)) continue;
          if (nodes.length >= limit) {
            truncated = true;
            return;
          }
          const record = await readRecord(edge.child_id);
          if (!record || record.scan_id !== current.scan_id) {
            warnings.push("部分子请求尚未落盘或未被保留。");
            continue;
          }
          seen.add(record.request_id);
          nodes.push({
            request_id: available.has(record.request_id)
              ? record.request_id
              : "",
            request_url: record.request_url,
            parent_id: parent.request_id,
            current: false,
            depth,
            resolution:
              edge.resolution ?? record.initiator_parent_match ?? "none",
            relation: edge.relation ?? record.initiator_relation ?? "none",
          });
          await appendChildren(record, depth + 1);
        }
      };
      if (!truncated) await appendChildren(current, nodes.length);
      if (
        !current.initiator_parent_match &&
        !current.initiator_parent_id &&
        !current.initiator
      )
        warnings.push(
          "此记录创建于请求发起链采集之前，无法恢复其上游发起关系。",
        );
      const unresolved = incoming[0].record;
      if (unresolved.initiator_parent_match === "ambiguous")
        warnings.push("存在多个同地址候选父请求，未猜测发起关系。");
      else if (unresolved.initiator_parent_match === "missing")
        warnings.push("发起请求未被观测或未被保留。");
      if (truncated) warnings.push(`发起链超过 ${limit} 个节点，已截断。`);
      return { nodes, warning: [...new Set(warnings)].join(" "), truncated };
    },
  );
}

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
