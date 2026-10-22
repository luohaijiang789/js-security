import {
  defaults,
  type Group,
  type RecordEntry,
  type Scan,
} from "../src/model";

/** Synthetic observations for UI checks, never user scan results. */
export function workspaceFixture(options: { pending?: boolean } = {}) {
  const config = defaults();
  config.archive.enabled = false;
  const records: RecordEntry[] = Array.from({ length: 100 }, (_, index) => {
    const ordinal = index + 1,
      order = ordinal >= 99;
    const pathname = order ? "/api/orders" : `/api/catalog/${ordinal}`;
    const timestamp = new Date(
      Date.UTC(2026, 9, 22, 11, 0, ordinal),
    ).toISOString();
    return {
      scan_id: "ui-latest",
      request_id: `ui-request-${String(ordinal).padStart(3, "0")}`,
      cdp_request_id: `fixture.${ordinal}`,
      session_id: "root",
      target_id: "fixture-target",
      redirect_hop: 0,
      timestamp,
      tab_id: 42,
      frame_id: "frame-main",
      page_url: "https://console.example.test/orders",
      referer: "https://console.example.test/orders",
      request_url: `https://api.example.test${pathname}${order ? "?tag=alpha&tag=beta&empty=&token=%5BREDACTED%5D" : ""}`,
      domain: "api.example.test",
      pathname,
      method: order ? "POST" : "GET",
      resource_type: [40, 80].includes(ordinal)
        ? "Document"
        : ordinal % 10 === 0 && !order
          ? "Image"
          : "Fetch",
      status_code: ordinal === 75 ? 503 : 200,
      request_state: "complete",
      request_headers: order
        ? [
            { name: "Content-Type", value: "application/json" },
            { name: "Authorization", value: "[REDACTED]" },
            { name: "X-Request-Source", value: "ui-fixture" },
          ]
        : [{ name: "Accept", value: "application/json" }],
      query_params: order
        ? [
            { name: "tag", value: "alpha" },
            { name: "tag", value: "beta" },
            { name: "empty", value: "" },
            { name: "token", value: "[REDACTED]" },
          ]
        : [],
      request_body: order
        ? {
            representation: "json",
            parsed: {
              order_id: "fixture-order",
              items: [{ sku: "BOOK-001", quantity: 2 }],
              nested: { token: "[REDACTED]" },
            },
          }
        : { representation: "unavailable", parsed: null },
      content_type: order ? "application/json" : "",
      initiator_url: order ? "https://static.example.test/orders.js" : null,
      initiator_stack: order
        ? {
            callFrames: [
              {
                functionName: "submitOrder",
                url: "https://static.example.test/orders.js",
                lineNumber: 41,
                columnNumber: 7,
              },
            ],
            parent: {
              callFrames: [
                {
                  functionName: "onCheckout",
                  url: "https://static.example.test/checkout.js",
                  lineNumber: 11,
                  columnNumber: 2,
                },
              ],
            },
          }
        : null,
      capture_status: {
        headers: { state: "complete", reason: "CDP ExtraInfo 可观测请求头" },
        body: { state: "complete", reason: order ? undefined : "未报告正文" },
        stack: order
          ? { state: "partial", reason: "仅 CDP 可见调用栈" }
          : { state: "missing", reason: "该请求未提供 JS 调用栈" },
        page: { state: "complete" },
      },
      protection: {
        version: "sensitive-v1",
        redacted: order,
        truncated: false,
      },
      filter_version: 1,
      filter_result: "matched",
      ordinal,
      group_id: order
        ? "group-orders"
        : `group-catalog-${String(ordinal).padStart(3, "0")}`,
      normalized_url: `https://api.example.test${pathname}`,
    };
  });
  const olderRecord: RecordEntry = {
    ...records[0],
    scan_id: "ui-older",
    request_id: "older-health",
    ordinal: 1,
    request_url: "https://legacy.example.test/api/health",
    domain: "legacy.example.test",
    pathname: "/api/health",
    group_id: "group-older",
  };
  const scan = (
    id: string,
    name: string,
    timestamp: string,
    count: number,
  ): Scan => ({
    id,
    name,
    state: "ended",
    started_at: timestamp,
    ended_at: timestamp,
    heartbeat: timestamp,
    tabs: [{ id: 42, url: "https://console.example.test/orders" }],
    config: structuredClone(config),
    versions: [
      { version: 1, effective_at: timestamp, config: structuredClone(config) },
    ],
    browser: "Synthetic UI fixture",
    plugin: "0.2.0",
    stats: {
      observed: count,
      pending: 0,
      matched: count,
      excluded: 0,
      unknown: 0,
      persisted: count,
      groups: count === 100 ? 99 : 1,
      bytes: 184300,
      lost: 0,
    },
    gaps: [],
    rule_hits: {},
    integrity: "gaps",
  });
  const scans = [
    scan(
      "ui-latest",
      "控制台下单流程 · 验证样例",
      "2026-10-22T11:00:00.000Z",
      100,
    ),
    scan("ui-older", "历史登录任务 · 验证样例", "2026-10-21T11:00:00.000Z", 1),
  ];
  const groups: Group[] = records
    .filter((r) => r.ordinal !== 99)
    .map((r) => ({
      id: r.group_id!,
      scan_id: r.scan_id,
      key: "fixture-group",
      representative_id: r.request_id,
      normalized_url: r.normalized_url!,
      count: r.group_id === "group-orders" ? 2 : 1,
      first: r.timestamp,
      last: r.timestamp,
      candidate: r.group_id === "group-orders",
      changes: r.group_id === "group-orders" ? ["query_params"] : [],
    }));
  const active: RecordEntry[] = [];
  if (options.pending) {
    const pending: RecordEntry = {
      ...structuredClone(records[99]),
      request_id: "ui-pending-events",
      cdp_request_id: "fixture.pending.events",
      timestamp: "2026-10-22T11:10:00.000Z",
      request_url:
        "https://api.example.test/api/events?cursor=fixture-cursor&token=%5BREDACTED%5D",
      pathname: "/api/events",
      method: "GET",
      request_state: "pending",
      request_headers: [
        { name: "Accept", value: "text/event-stream" },
        { name: "Authorization", value: "[REDACTED]" },
        { name: "X-Flow", value: "pending-fixture" },
      ],
      query_params: [
        { name: "cursor", value: "fixture-cursor" },
        { name: "token", value: "[REDACTED]" },
      ],
      request_body: { representation: "unavailable", parsed: null },
      content_type: "",
      filter_result: undefined,
      ordinal: undefined,
      group_id: undefined,
      normalized_url: undefined,
      capture_status: {
        headers: {
          state: "partial",
          reason: "等待后续 ExtraInfo，可查看已取得的请求头",
        },
        body: { state: "complete", reason: "未报告正文" },
        stack: { state: "partial", reason: "仅 CDP 可见调用栈" },
        page: { state: "complete" },
      },
    };
    active.push(pending);
    scans[0].state = "recording";
    scans[0].stats.observed = 101;
    scans[0].stats.pending = 1;
  }
  return { scans, records: [...records, olderRecord], groups, active };
}
