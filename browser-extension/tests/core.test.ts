import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaults, type RecordEntry, type Rule } from "../src/model";
import { evaluate, matchFilter, validateFilter } from "../src/filter";
import { MAX_STRING_CHARS, parseBody, protectRecord } from "../src/privacy";
import { fingerprint } from "../src/group";
import { Recorder } from "../src/recorder";
import { csvCell, packageFiles } from "../src/export";
import * as db from "../src/store";
import { unzipSync, strFromU8 } from "fflate";
const record = (overrides: Partial<RecordEntry> = {}): RecordEntry => ({
  scan_id: "scan",
  request_id: "r",
  cdp_request_id: "r",
  session_id: "root",
  target_id: null,
  redirect_hop: 0,
  timestamp: "2026-10-22T10:00:00Z",
  tab_id: 1,
  frame_id: "f",
  page_url: "https://console.alibabacloud.com/a",
  referer: null,
  request_url: "https://api.example.test/log?tag=a&tag=b&ts=1",
  domain: "api.example.test",
  pathname: "/log",
  method: "POST",
  resource_type: "Fetch",
  status_code: null,
  request_state: "pending",
  request_headers: [],
  query_params: [
    { name: "tag", value: "a" },
    { name: "tag", value: "b" },
    { name: "ts", value: "1" },
  ],
  request_body: { representation: "json", parsed: { id: 1 } },
  content_type: "application/json",
  initiator_url: null,
  initiator_stack: null,
  capture_status: {
    headers: { state: "partial" },
    body: { state: "complete" },
    stack: { state: "missing" },
    page: { state: "complete" },
  },
  protection: { version: "sensitive-v1", redacted: false, truncated: false },
  filter_version: 1,
  ...overrides,
});
describe("Filter 三值逻辑与输入验证", () => {
  it("完整头确认无 Referer，与未知 Referer 分开", () => {
    const r = record();
    expect(
      evaluate({ field: "referer", operator: "not_exists" }, r, true),
    ).toBe("unknown");
    r.capture_status.headers.state = "complete";
    expect(
      evaluate({ field: "referer", operator: "not_exists" }, r, true),
    ).toBe(true);
  });
  it("已脱敏的值规则不被当作原始值判断", () => {
    expect(
      evaluate(
        {
          field: "query",
          key: "token",
          operator: "equals",
          values: ["original"],
        },
        record({ query_params: [{ name: "token", value: "[REDACTED]" }] }),
        true,
      ),
    ).toBe("unknown");
  });
  it("AND/OR/NOT 不过早排除未知状态码", () => {
    const r = record();
    expect(
      matchFilter(
        {
          include: {
            op: "or",
            rules: [
              { field: "status_code", operator: "equals", values: ["204"] },
              { field: "method", operator: "equals", values: ["GET"] },
            ],
          },
        },
        r,
      ),
    ).toBe("unknown");
    r.status_code = 204;
    expect(
      matchFilter(
        {
          include: {
            field: "status_code",
            operator: "equals",
            values: ["204"],
          },
        },
        r,
        true,
      ),
    ).toBe("matched");
  });
  it("已确定排除可覆盖未知分支", () =>
    expect(
      matchFilter(
        {
          include: {
            op: "and",
            rules: [
              { field: "status_code", operator: "equals", values: ["204"] },
              { field: "method", operator: "equals", values: ["HEAD"] },
            ],
          },
        },
        record(),
      ),
    ).toBe("excluded"));
  it("子域按边界匹配，拒绝恶意相似域", () => {
    const rule: Rule = {
      field: "page_host",
      operator: "domain",
      values: ["alibabacloud.com"],
    };
    expect(evaluate(rule, record())).toBe(true);
    expect(
      evaluate(
        rule,
        record({ page_url: "https://alibabacloud.com.evil.test" }),
      ),
    ).toBe(false);
  });
  it("后缀仅取 pathname", () =>
    expect(
      evaluate(
        { field: "extension", operator: "in", values: ["png"] },
        record({
          pathname: "/image.png",
          request_url: "https://a.test/image.png?next=.js",
        }),
      ),
    ).toBe(true));
  it("同名 query 多值与空值存在性", () => {
    expect(
      evaluate(
        { field: "query", key: "tag", operator: "in", values: ["b"] },
        record(),
      ),
    ).toBe(true);
    expect(
      evaluate(
        { field: "query", key: "missing", operator: "not_exists" },
        record(),
      ),
    ).toBe(true);
  });
  it("部分 Header 的缺失不同于不存在", () => {
    const rule: Rule = {
      field: "header",
      key: "referer",
      operator: "not_exists",
    };
    expect(evaluate(rule, record(), true)).toBe("unknown");
    const r = record();
    r.capture_status.headers.state = "complete";
    expect(evaluate(rule, r, true)).toBe(true);
  });
  it("非法正则、空组和未知字段明确报错", () => {
    expect(() =>
      validateFilter({
        include: { field: "domain", operator: "regex", values: ["["] },
      }),
    ).toThrow();
    expect(() =>
      validateFilter({ include: { op: "not", rules: [] } }),
    ).toThrow();
    expect(() =>
      validateFilter({
        include: { field: "bad", operator: "equals", values: ["x"] },
      }),
    ).toThrow();
  });
  it("wildcard 转义正则元字符", () => {
    expect(
      evaluate(
        { field: "pathname", operator: "wildcard", values: ["/a.*"] },
        record({ pathname: "/a.foo" }),
      ),
    ).toBe(true);
    expect(
      evaluate(
        { field: "pathname", operator: "wildcard", values: ["/a.*"] },
        record({ pathname: "/abfoo" }),
      ),
    ).toBe(false);
  });
  it("嵌套 NOT 和命中统计", () => {
    const hits = {};
    expect(
      matchFilter(
        {
          exclude: {
            op: "not",
            rules: [{ field: "method", operator: "in", values: ["POST"] }],
          },
        },
        record(),
        true,
        hits,
      ),
    ).toBe("matched");
    expect(hits).toHaveProperty("exclude.0", 1);
  });
});
describe("原值留存、截断、解析与归并", () => {
  it("深层 JSON 明确标记截断，避免宣称完整", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 40; i++) value = { child: value };
    const parsed = parseBody(
      JSON.stringify(value),
      "application/json",
      true,
      100000,
    );
    expect(parsed.quality.state).toBe("partial");
    expect(parsed.truncated).toBe(true);
  });
  it("完整保留 URL 用户信息、认证字段、正文结构和重复 query", () => {
    const r = record({
      request_url: "https://user:pass@api.test/p?token=secret&x=1&x=2",
      request_headers: [{ name: "Cookie", value: "session=secret" }],
      request_body: {
        representation: "json",
        parsed: { nested: [{ password: "secret" }], safe: "yes" },
      },
    });
    const saved = protectRecord(r);
    expect(saved.request_url).toContain("user:pass@");
    expect(saved.request_url).toContain("token=secret");
    expect(saved.request_headers[0].value).toBe("session=secret");
    expect(saved.request_body.parsed).toEqual({
      nested: [{ password: "secret" }],
      safe: "yes",
    });
    expect(saved.protection).toMatchObject({
      version: "retain-truncate-v1",
      redacted: false,
      truncated: false,
    });
    expect(new URL(saved.request_url).searchParams.getAll("x")).toEqual([
      "1",
      "2",
    ]);
  });
  it("仅截断超长字符串并保留首尾及原始长度", () => {
    const long = `HEAD-${"x".repeat(MAX_STRING_CHARS)}-TAIL`;
    const longName = `X-${"n".repeat(MAX_STRING_CHARS)}`;
    const saved = protectRecord(
      record({ request_headers: [{ name: longName, value: long }] }),
    );
    expect(saved.request_headers[0].name).toBe(longName);
    const value = saved.request_headers[0].value;
    expect(value.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect(value).toMatch(/^HEAD-/);
    expect(value).toMatch(/-TAIL$/);
    expect(value).toContain(`原始 ${long.length} 字符`);
    expect(saved.protection.truncated).toBe(true);
    const url = protectRecord(
      record({
        request_url: `https://api.test/p?${encodeURIComponent(longName)}=${encodeURIComponent(long)}`,
        query_params: [{ name: longName, value: long }],
      }),
    );
    expect(url.query_params[0].name).toBe(longName);
    expect(url.query_params[0].value).toContain("已截断");
    expect([...new URL(url.request_url).searchParams][0][0]).toBe(longName);
    expect([...new URL(url.request_url).searchParams][0][1]).toContain(
      "已截断",
    );
    expect(url.protection.truncated).toBe(true);
  });
  it("完整保留模式不截断字段值或正文，字段名始终不变", () => {
    const long = `HEAD-${"x".repeat(MAX_STRING_CHARS)}-TAIL`;
    const saved = protectRecord(
      record({ request_headers: [{ name: "Authorization", value: long }] }),
      false,
    );
    expect(saved.request_headers).toEqual([
      { name: "Authorization", value: long },
    ]);
    expect(saved.protection).toMatchObject({
      version: "retain-complete-v1",
      redacted: false,
      truncated: false,
    });
    const body = parseBody(
      JSON.stringify({ token: long }),
      "application/json",
      true,
      20,
      true,
      false,
    );
    expect(body.quality.state).toBe("complete");
    expect(body.body.parsed).toEqual({ token: long });
    expect(body.truncated).toBe(false);
  });
  it("正文超出 UTF-8 字节限额时保留片段，文本与解析失败原值继续保存", () => {
    const large = parseBody("中".repeat(10), "application/json", true, 20);
    expect(large.quality.state).toBe("partial");
    expect(large.body.representation).toBe("truncated");
    expect(large.body.raw).toContain("已截断");
    expect(new TextEncoder().encode(large.body.raw).length).toBeLessThanOrEqual(
      20,
    );
    expect(
      parseBody("{secret", "application/json", true, 100).quality,
    ).toMatchObject({
      state: "unparseable",
      reason: "正文解析失败，已保留原始文本",
    });
    expect(
      parseBody("plaintext-secret", "text/plain", true, 100).quality.state,
    ).toBe("complete");
  });
  it("无 body、未知 body 与空 JSON 分开", () => {
    expect(parseBody(undefined, "", false, 100).quality.state).toBe("complete");
    expect(parseBody(undefined, "", true, 100).quality.state).toBe("missing");
    expect(parseBody("{}", "application/json", true, 100).body.parsed).toEqual(
      {},
    );
  });
  it("不同业务 body、UID、CNA 不默认归并", async () => {
    const c = defaults();
    const a = await fingerprint(record(), c);
    expect(
      (
        await fingerprint(
          record({
            request_body: { representation: "json", parsed: { id: 2 } },
          }),
          c,
        )
      ).id,
    ).not.toBe(a.id);
    expect(
      (await fingerprint(record({ request_url: "https://a.test/p?uid=1" }), c))
        .id,
    ).not.toBe(
      (await fingerprint(record({ request_url: "https://a.test/p?uid=2" }), c))
        .id,
    );
  });
  it("仅显式动态参数归一化，重复参数保持顺序", async () => {
    const c = defaults();
    c.dynamic_query = ["ts"];
    const a = await fingerprint(record(), c);
    expect(
      (
        await fingerprint(
          record({
            request_url: "https://api.example.test/log?ts=2&tag=a&tag=b",
          }),
          c,
        )
      ).id,
    ).toBe(a.id);
    expect(
      (
        await fingerprint(
          record({
            request_url: "https://api.example.test/log?ts=2&tag=b&tag=a",
          }),
          c,
        )
      ).id,
    ).not.toBe(a.id);
  });
  it("JSON 对象字段顺序可忽略，数组不可", async () => {
    const c = defaults();
    const make = (parsed: unknown) =>
      record({ request_body: { representation: "json", parsed } });
    expect((await fingerprint(make({ a: 1, b: 2 }), c)).id).toBe(
      (await fingerprint(make({ b: 2, a: 1 }), c)).id,
    );
    expect((await fingerprint(make([1, 2]), c)).id).not.toBe(
      (await fingerprint(make([2, 1]), c)).id,
    );
  });
  it("历史脱敏值只能标候选分组，新采集完整值可精确分组", async () => {
    const c = defaults();
    const completeHeaders = { state: "complete" as const };
    const retained = record({
      request_headers: [{ name: "Authorization", value: "secret" }],
      capture_status: {
        ...record().capture_status,
        headers: completeHeaders,
      },
    });
    expect((await fingerprint(protectRecord(retained), c)).candidate).toBe(
      false,
    );
    expect(
      (
        await fingerprint(
          record({
            request_headers: [{ name: "Authorization", value: "[REDACTED]" }],
            capture_status: {
              ...record().capture_status,
              headers: completeHeaders,
            },
          }),
          c,
        )
      ).candidate,
    ).toBe(true);
  });
  it.each(["=1+1", "+cmd", "-1", "@SUM(1)", "\t=1"])(
    "CSV 公式注入防护 %j",
    (v) => expect(csvCell(v)).toBe("\"'" + v + '"'),
  );
});
describe("任务关联、持久化与导出", () => {
  const event = (id: string, extra: object = {}) => ({
    requestId: id,
    wallTime: 1792663200,
    frameId: "f",
    documentURL: "https://page.test/",
    type: "Fetch",
    request: { url: "https://a.test/p", method: "GET", headers: {} },
    ...extra,
  });
  let r: Recorder;
  beforeEach(async () => {
    r = new Recorder(async () => ({}));
    await r.create("fixture", [{ id: 1, url: "https://page.test" }], {
      ...defaults(),
      archive: {
        enabled: false,
        interval_ms: 300000,
        bytes: 20971520,
        count: 10000,
      },
      stop_wait_ms: 0,
    });
  });
  it("100 次相同请求保留全部原始记录和准确组计数", async () => {
    for (let i = 0; i < 100; i++) {
      await r.event(
        { tabId: 1 },
        "Network.requestWillBeSent",
        event("repeat-" + i),
      );
      await r.event({ tabId: 1 }, "Network.loadingFinished", {
        requestId: "repeat-" + i,
      });
    }
    await r.tail;
    expect(r.scan!.stats.persisted).toBe(0);
    await r.flush();
    expect(r.scan!.stats.persisted).toBe(100);
    expect(await db.page(r.scan!.id)).toHaveLength(100);
    expect((await db.all<any>("groups", r.scan!.id))[0].count).toBe(100);
  });
  it("暂停时跟随的重定向不会覆盖前一跳状态", async () => {
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("redirect-pause"),
    );
    await r.pause();
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("redirect-pause", {
        redirectResponse: { status: 302 },
        redirectHasExtraInfo: false,
      }),
    );
    await r.event({ tabId: 1 }, "Network.responseReceived", {
      requestId: "redirect-pause",
      response: { status: 200 },
      hasExtraInfo: false,
    });
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "redirect-pause",
    });
    await r.tail;
    await r.flush();
    const records = await db.page(r.scan!.id);
    expect(records).toHaveLength(1);
    expect(records[0].status_code).toBe(302);
    expect(records[0].request_state).toBe("redirect");
  });
  it("在途快照保留浏览器可观测原值", async () => {
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("pending", {
        request: {
          url: "https://a.test/p?token=secret",
          method: "POST",
          hasPostData: true,
          postData: '{"token":"secret"}',
          headers: {
            "Content-Type": "application/json",
            Authorization: "secret",
          },
        },
      }),
    );
    await r.flush();
    const active = JSON.stringify(await db.all("active", r.scan!.id));
    expect(active).toContain("secret");
    expect(active).toContain("Authorization");
  });
  it("未勾选的大字段在持久化前移除且不登记采集缺口", async () => {
    await r.update({
      ...r.scan!.config,
      saved_fields: ["query_params"],
    });
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("selected-fields", {
        initiator: { type: "script", url: "https://page.test/app.js" },
        request: {
          url: "https://a.test/p?q=kept",
          method: "POST",
          hasPostData: true,
          postData: '{"large":"removed"}',
          headers: {
            "Content-Type": "application/json",
            Authorization: "removed",
          },
        },
      }),
    );
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "selected-fields",
    });
    await r.tail;
    await r.flush();
    const saved = (await db.page(r.scan!.id)).find(
      (item) => item.cdp_request_id === "selected-fields",
    )!;
    expect(saved.query_params).toEqual([{ name: "q", value: "kept" }]);
    expect(saved.request_headers).toEqual([]);
    expect(saved.request_body.parsed).toBeNull();
    expect(saved.page_url).toBeNull();
    expect(saved.initiator).toBeUndefined();
    expect(saved.initiator_stack).toBeNull();
    expect(await db.all("initiator_nodes", r.scan!.id)).toEqual([]);
    expect(r.scan!.gaps).toEqual([]);
  });
  it("完整保留任务忽略字段值和正文截断上限", async () => {
    const config = {
      ...r.scan!.config,
      value_storage: "complete" as const,
      body_limit: 1024,
    };
    await r.update(config);
    const long = `HEAD-${"x".repeat(MAX_STRING_CHARS)}-TAIL`;
    const raw = JSON.stringify({ token: long });
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("complete-values", {
        request: {
          url: `https://a.test/p?token=${long}`,
          method: "POST",
          hasPostData: true,
          postData: raw,
          headers: {
            "Content-Type": "application/json",
            Authorization: long,
          },
        },
      }),
    );
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "complete-values",
    });
    await r.tail;
    await r.flush();
    const saved = (await db.page(r.scan!.id)).find(
      (item) => item.cdp_request_id === "complete-values",
    )!;
    expect(
      saved.request_headers.find((item) => item.name === "Authorization")
        ?.value,
    ).toBe(long);
    expect(saved.request_body.raw).toBe(raw);
    expect(saved.request_body.parsed).toEqual({ token: long });
    expect(saved.protection).toMatchObject({
      version: "retain-complete-v1",
      redacted: false,
      truncated: false,
    });
  });
  it("不同会话/重定向身份独立，终态后原始记录保留", async () => {
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("id"));
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("id", {
        redirectResponse: { status: 302 },
        redirectHasExtraInfo: false,
      }),
    );
    await r.event({ tabId: 1 }, "Network.loadingFinished", { requestId: "id" });
    await r.event(
      { tabId: 1, sessionId: "child" },
      "Network.requestWillBeSent",
      event("id"),
    );
    await r.event({ tabId: 1, sessionId: "child" }, "Network.loadingFinished", {
      requestId: "id",
    });
    await r.tail;
    await r.flush();
    const rows = await db.page(r.scan!.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((x) => x.request_id)).size).toBe(3);
    expect(rows.filter((x) => x.request_state === "redirect")).toHaveLength(1);
  });
  it("不采集未选标签页和暂停后的新请求，继续在途关联", async () => {
    await r.event({ tabId: 2 }, "Network.requestWillBeSent", event("other"));
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("before"));
    await r.pause();
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("paused"));
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "before",
    });
    await r.tail;
    await r.flush();
    expect(await db.page(r.scan!.id)).toHaveLength(1);
  });
  it("单条请求固定接收时规则版本", async () => {
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("old"));
    await r.update({
      ...defaults(),
      filter: {
        exclude: { field: "method", operator: "equals", values: ["GET"] },
      },
    });
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "old",
    });
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("new"));
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "new",
    });
    await r.tail;
    await r.flush();
    const rows = await db.page(r.scan!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].filter_version).toBe(1);
    expect(r.scan!.stats.excluded).toBe(1);
  });
  it("停止超时明确不完整，数据包含原始/分组/错误/清单", async () => {
    await r.event(
      { tabId: 1 },
      "Network.requestWillBeSent",
      event("unfinished"),
    );
    await r.stop();
    expect(r.scan!.state).toBe("ended");
    const files = unzipSync(await packageFiles(r.scan!));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "scan_manifest.json",
        "requests_0001.jsonl",
        "request_groups.jsonl",
        "capture_errors.jsonl",
      ]),
    );
    const entry = JSON.parse(strFromU8(files["requests_0001.jsonl"]).trim());
    expect(entry.request_state).toBe("incomplete");
    expect(
      JSON.parse(strFromU8(files["scan_manifest.json"])).shards[0].sha256,
    ).toHaveLength(64);
  });
  it("写盘失败暂停并保留待写记录，重试后落盘", async () => {
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("disk"));
    await r.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "disk",
    });
    await r.tail;
    const spy = vi.spyOn(db, "commit").mockRejectedValueOnce(Error("quota"));
    await expect(r.flush()).rejects.toThrow();
    expect(r.scan!.state).toBe("paused");
    expect(r.entries).toHaveLength(1);
    spy.mockRestore();
    await r.flush();
    expect(await db.page(r.scan!.id)).toHaveLength(1);
  });
  it("有界队列触发暂停与明确丢失计数", async () => {
    r.scan!.config.queue_count = 1;
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("first"));
    await r.event({ tabId: 1 }, "Network.requestWillBeSent", event("overflow"));
    expect(r.scan!.state).toBe("paused");
    expect(r.scan!.stats.lost).toBe(1);
    expect(r.scan!.gaps.some((g) => g.type === "backpressure")).toBe(true);
  });
});
