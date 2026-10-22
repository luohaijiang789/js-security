import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi } from "vitest";
import * as db from "../src/store";
import type { Group, RecordEntry } from "../src/model";
import {
  bodyContentAvailable,
  frames,
  frameLocation,
  recordForDisplay,
  statusText,
  statusTone,
  unresolvedStackParent,
  timeText,
} from "../src/presentation";

function entry(
  scan: string,
  id: string,
  ordinal?: number,
  extra: Partial<RecordEntry> = {},
): RecordEntry {
  return {
    scan_id: scan,
    request_id: scan + ":" + id,
    cdp_request_id: id,
    session_id: "root",
    target_id: "target",
    redirect_hop: 0,
    timestamp: "2026-10-22T12:00:00.000Z",
    tab_id: 7,
    frame_id: "frame",
    page_url: "https://console.test/orders",
    referer: null,
    request_url: "https://api.test/v1/orders?tag=a&tag=b&empty=",
    domain: "api.test",
    pathname: "/v1/orders",
    method: "POST",
    resource_type: "Fetch",
    status_code: 200,
    request_state: "complete",
    request_headers: [{ name: "authorization", value: "[REDACTED]" }],
    query_params: [
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
      { name: "empty", value: "" },
    ],
    request_body: { representation: "json", parsed: { sku: "BOOK-42" } },
    content_type: "application/json",
    initiator_url: "https://console.test/app.js",
    initiator_stack: null,
    capture_status: {
      headers: { state: "complete" },
      body: { state: "complete" },
      stack: { state: "missing", reason: "not provided" },
      page: { state: "complete" },
    },
    protection: { version: "sensitive-v1", redacted: true, truncated: false },
    filter_version: 1,
    filter_result: "matched",
    ...(ordinal === undefined ? {} : { ordinal }),
    ...extra,
  };
}
const insert = (rows: RecordEntry[]) =>
  db.transact(["requests"], "readwrite", (tx) =>
    rows.forEach((r) => tx.objectStore("requests").put(r)),
  );
const scanId = () => crypto.randomUUID();

describe("请求查看分页与兼容历史数据", () => {
  it("重复 ordinal 的多个请求分页不丢失、不重复，双向稳定排序", async () => {
    const scan = scanId(),
      rows = [
        entry(scan, "a", 1),
        entry(scan, "b", 2),
        entry(scan, "c", 2),
        entry(scan, "d", 2),
        entry(scan, "e", 3),
      ];
    await insert(rows);
    for (const direction of ["newest", "oldest"] as const) {
      const ids: string[] = [];
      let after = "",
        more = true;
      while (more) {
        const page = await db.queryRequests(scan, {
          after,
          limit: 2,
          direction,
        });
        ids.push(...page.rows.map((r) => r.request_id));
        more = page.hasMore;
        after = page.cursor;
      }
      expect(ids).toEqual(
        (direction === "oldest" ? rows : [...rows].reverse()).map(
          (r) => r.request_id,
        ),
      );
      expect(new Set(ids).size).toBe(5);
    }
  });
  it("新旧记录混存时不会只显示具备 ordinal 的新记录", async () => {
    const scan = scanId(),
      rows = [entry(scan, "a"), entry(scan, "b", 2), entry(scan, "c")];
    await insert(rows);
    const first = await db.queryRequests(scan, { limit: 2 });
    const second = await db.queryRequests(scan, {
      limit: 2,
      after: first.cursor,
    });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(
      [...first.rows, ...second.rows].map((r) => r.request_id).sort(),
    ).toEqual(rows.map((r) => r.request_id).sort());
    expect(first.total).toBe(3);
  });
  it("请求搜索覆盖正文、头与调用栈，且资源和分组筛选共同生效", async () => {
    const scan = scanId();
    await insert([
      entry(scan, "a", 1, {
        group_id: "group-a",
        request_body: {
          representation: "json",
          parsed: { sku: "needle-body" },
        },
      }),
      entry(scan, "b", 2, {
        group_id: "group-b",
        resource_type: "Image",
        request_headers: [{ name: "x-fixture", value: "needle-header" }],
      }),
      entry(scan, "c", 3, {
        group_id: "group-a",
        resource_type: "Ping",
        initiator_stack: {
          callFrames: [
            {
              functionName: "needle-stack",
              url: "https://cdn.test/app.js",
              lineNumber: 0,
              columnNumber: 0,
            },
          ],
        },
      }),
    ]);
    expect(
      (await db.queryRequests(scan, { text: "NEEDLE-BODY" })).rows.map(
        (r) => r.cdp_request_id,
      ),
    ).toEqual(["a"]);
    expect(
      (
        await db.queryRequests(scan, {
          text: "needle-header",
          resource: "other",
        })
      ).rows.map((r) => r.cdp_request_id),
    ).toEqual(["b"]);
    expect(
      (
        await db.queryRequests(scan, {
          text: "needle-stack",
          resource: "api",
          group: "group-a",
        })
      ).rows.map((r) => r.cdp_request_id),
    ).toEqual(["c"]);
    expect(
      (await db.queryRequests(scan, { text: "needle-stack", group: "group-b" }))
        .rows,
    ).toHaveLength(0);
  });
  it("过滤后不足一页时不会出现空的下一页，查询限额始终有界", async () => {
    const scan = scanId();
    await insert(
      Array.from({ length: 7 }, (_, i) =>
        entry(scan, String(i), i + 1, {
          resource_type: i % 2 ? "Image" : "Fetch",
        }),
      ),
    );
    const first = await db.queryRequests(scan, { resource: "api", limit: 3 });
    expect(first.hasMore).toBe(true);
    expect(first.rows).toHaveLength(3);
    const next = await db.queryRequests(scan, {
      resource: "api",
      after: first.cursor,
      limit: 3,
    });
    expect(next.rows).toHaveLength(1);
    expect(next.hasMore).toBe(false);
    expect((await db.queryRequests(scan, { limit: -10 })).rows).toHaveLength(1);
  });
  it("无效分页游标明确报错，不把读取失败伪装成没有数据", async () => {
    const scan = scanId();
    await insert([entry(scan, "a", 1)]);
    await expect(db.queryRequests(scan, { after: "{bad" })).rejects.toThrow(
      "分页游标",
    );
    await expect(
      db.queryRequests(scan, { after: "request-id-from-another-sort" }),
    ).rejects.toThrow("请求排序发生变化");
  });
  it("组搜索的偏移以匹配结果计数，并兼容旧组缺少差异数组", async () => {
    const scan = scanId();
    const groups = Array.from({ length: 6 }, (_, i) => ({
      id: scan + ":" + i,
      scan_id: scan,
      key: "key",
      representative_id: scan + ":" + i,
      normalized_url: "https://api.test/" + (i % 2 ? "orders" : "users"),
      count: 1,
      first: "",
      last: "",
      candidate: true,
      ...(i === 3 ? {} : { changes: [] }),
    })) as Group[];
    await db.transact(["groups"], "readwrite", (tx) =>
      groups.forEach((g) => tx.objectStore("groups").put(g)),
    );
    const first = await db.queryGroups(scan, "ORDERS", 0, 2),
      second = await db.queryGroups(scan, "orders", 2, 2);
    expect(first.rows.map((g) => g.id)).toEqual([groups[1].id, groups[3].id]);
    expect(first.hasMore).toBe(true);
    expect(second.rows.map((g) => g.id)).toEqual([groups[5].id]);
    expect(second.hasMore).toBe(false);
  });
  it("缺少 ordinal 索引的旧开发库仍可读取", async () => {
    const original = indexedDB,
      factory = new IDBFactory();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open("js-security-recorder", 1);
      r.onupgradeneeded = () => {
        const store = r.result.createObjectStore("requests", {
          keyPath: "request_id",
        });
        store.createIndex("scan", ["scan_id", "request_id"]);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const row = entry("legacy", "old");
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction("requests", "readwrite");
      tx.objectStore("requests").put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();
    vi.stubGlobal("indexedDB", factory);
    vi.resetModules();
    try {
      const freshStore = await import("../src/store");
      const result = await freshStore.queryRequests("legacy");
      expect(result.rows.map((r) => r.request_id)).toEqual([row.request_id]);
    } finally {
      vi.stubGlobal("indexedDB", original);
    }
  });
});

describe("详情展示保留数据语义", () => {
  it("展示重复 Query 和空字符串，不改变原始保存对象", () => {
    const r = entry("display", "1", 1),
      before = structuredClone(r),
      displayed = recordForDisplay(r);
    expect(displayed.query_params).toEqual([
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
      { name: "empty", value: "" },
    ]);
    expect(displayed.request_headers[0].value).toBe("[REDACTED]");
    expect(r).toEqual(before);
  });
  it("旧记录缺少 Query 解析字段时从保存的 URL 恢复重复值", () => {
    const partial = {
      request_id: "old-query",
      request_url: "https://api.test/p?tag=a&tag=b&empty=",
    } as RecordEntry;
    expect(recordForDisplay(partial).query_params).toEqual([
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
      { name: "empty", value: "" },
    ]);
    expect(Object.hasOwn(partial, "query_params")).toBe(false);
  });
  it("旧记录缺失字段可查看，同时不得默认宣称采集完整", () => {
    const partial = {
      request_id: "old",
      method: "GET",
      request_url: "https://api.test/",
    } as RecordEntry;
    const displayed = recordForDisplay(partial);
    expect(displayed.request_headers).toEqual([]);
    expect(displayed.capture_status.headers.state).toBe("missing");
    expect(displayed.request_state).toBe("unknown");
    expect(displayed.protection.version).toBe("未知");
    expect(Object.hasOwn(partial, "capture_status")).toBe(false);
  });
  it("合法 JSON null 正文与没有取得正文区别展示", () => {
    expect(bodyContentAvailable({ representation: "json", parsed: null })).toBe(
      true,
    );
    expect(
      bodyContentAvailable({ representation: "json", parsed: false }),
    ).toBe(true);
    expect(bodyContentAvailable({ representation: "json", parsed: 0 })).toBe(
      true,
    );
    expect(
      bodyContentAvailable({ representation: "unavailable", parsed: null }),
    ).toBe(false);
    expect(
      bodyContentAvailable({ representation: "text", parsed: null, raw: "" }),
    ).toBe(true);
  });
  it("响应头含 200 不代表请求完成，失败和未完成状态仍可见", () => {
    expect(statusText({ status_code: 200, request_state: "failed" })).toBe(
      "200 · 失败",
    );
    expect(statusTone({ status_code: 200, request_state: "failed" })).toBe(
      "danger",
    );
    expect(statusText({ status_code: 200, request_state: "incomplete" })).toBe(
      "200 · 未完成",
    );
    expect(statusTone({ status_code: null, request_state: "unknown" })).toBe(
      "muted",
    );
  });
  it("展开异步父栈并以一基行列展示；缺失坐标不显示 NaN", () => {
    const stack = {
      callFrames: [
        {
          url: "https://cdn.test/app.js",
          functionName: "send",
          lineNumber: 0,
          columnNumber: 0,
        },
        { url: "https://cdn.test/app.js", functionName: "unknown" },
      ],
      parent: {
        callFrames: [
          { url: "https://cdn.test/task.js", lineNumber: 8, columnNumber: 3 },
        ],
        parentId: { id: "unresolved-parent" },
      },
    };
    const visible = frames(stack);
    expect(visible).toHaveLength(3);
    expect(visible[2].async).toBe(true);
    expect(frameLocation(visible[0])).toBe("https://cdn.test/app.js:1:1");
    expect(frameLocation(visible[1])).toContain("行号未知");
    expect(unresolvedStackParent(stack)).toBe(true);
    expect(frames({ callFrames: "invalid" })).toEqual([]);
  });
  it("显示时间统一使用上海时区", () =>
    expect(timeText("2026-10-22T12:00:00.000Z", true)).toBe("20:00:00"));
});

describe("在途请求受保护快照查看", () => {
  const activeEntry = (
    scan: string,
    id: string,
    extra: Partial<RecordEntry> = {},
  ) =>
    entry(scan, id, undefined, {
      request_state: "pending",
      status_code: null,
      filter_result: undefined,
      ...extra,
    });
  const insertActive = (rows: RecordEntry[]) =>
    db.transact(["active"], "readwrite", (tx) =>
      rows.forEach((r) => tx.objectStore("active").put(r)),
    );
  it("SSE 等长连接尚无终态也能分页查看，保持请求 ID，不混入已完成记录", async () => {
    const scan = scanId(),
      rows = ["a", "b", "c", "d", "e"].map((id) => activeEntry(scan, id));
    await insertActive(rows);
    await insert([entry(scan, "finished", 9)]);
    const first = await db.queryActive(scan, { limit: 2 }),
      second = await db.queryActive(scan, { after: first.cursor, limit: 2 }),
      last = await db.queryActive(scan, { after: second.cursor, limit: 2 });
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(last.hasMore).toBe(false);
    expect(
      [...first.rows, ...second.rows, ...last.rows].map((r) => r.request_id),
    ).toEqual([...rows].reverse().map((r) => r.request_id));
    expect(first.rows[0].request_state).toBe("pending");
    expect(first.rows[0].filter_result).toBeUndefined();
    expect(
      (await db.queryRequests(scan)).rows.map((r) => r.cdp_request_id),
    ).toEqual(["finished"]);
  });
  it("在途快照支持正文/调用栈全文搜索和资源联合筛选，空结果保留真实总数", async () => {
    const scan = scanId();
    await insertActive([
      activeEntry(scan, "sse", {
        request_url: "https://api.test/events",
        request_headers: [{ name: "accept", value: "text/event-stream" }],
        request_body: {
          representation: "json",
          parsed: { stream: "long-lived-feed" },
        },
      }),
      activeEntry(scan, "image", {
        resource_type: "Image",
        initiator_stack: {
          callFrames: [{ url: "https://cdn.test/long-lived-feed.js" }],
        },
      }),
    ]);
    const result = await db.queryActive(scan, {
      text: "LONG-LIVED-FEED",
      resource: "api",
    });
    expect(result.rows.map((r) => r.cdp_request_id)).toEqual(["sse"]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    const empty = await db.queryActive(scan, { text: "not-present" });
    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(2);
    expect(empty.hasMore).toBe(false);
  });
  it("在途分页支持正序，且拒绝其他视图或其他任务的游标", async () => {
    const scan = scanId();
    await insertActive([
      activeEntry(scan, "a"),
      activeEntry(scan, "b"),
      activeEntry(scan, "c"),
    ]);
    const first = await db.queryActive(scan, { limit: 1, direction: "oldest" }),
      next = await db.queryActive(scan, {
        limit: 1,
        direction: "oldest",
        after: first.cursor,
      });
    expect(first.rows[0].cdp_request_id).toBe("a");
    expect(next.rows[0].cdp_request_id).toBe("b");
    await expect(
      db.queryActive(scan + "other", { after: first.cursor }),
    ).rejects.toThrow("其他视图");
    await expect(
      db.queryActive(scan, {
        after: '{"version":1,"index":"ordinal","key":1,"id":"a"}',
      }),
    ).rejects.toThrow("其他视图");
  });
});
