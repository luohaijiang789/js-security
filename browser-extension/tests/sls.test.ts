import { compactBody, compactStack, slsProjection } from "../src/sls-fields";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config";
import {
  defaults,
  type Batch,
  type RecordEntry,
  type Scan,
} from "../src/model";
import {
  signSlsRequest,
  slsBaseURL,
  slsCredentialKey,
  slsCredentialSummary,
  slsPayloads,
  slsWriteURL,
  testSlsConnection,
} from "../src/sls";
import { workspaceFixture } from "./fixtures";

describe("Alibaba Cloud SLS target and signing", () => {
  const config = {
    ...defaults().sls!,
    enabled: true,
    endpoint: "cn-hangzhou.log.aliyuncs.com",
    project: "security-project",
    logstore: "browser_requests",
  };

  it("builds standard and custom endpoint URLs without persisting credentials", () => {
    expect(slsBaseURL(config)).toBe(
      "https://security-project.cn-hangzhou.log.aliyuncs.com",
    );
    expect(slsWriteURL(config)).toBe(
      "https://security-project.cn-hangzhou.log.aliyuncs.com/logstores/browser_requests",
    );
    expect(slsCredentialKey(config)).not.toContain("secret");
    expect(
      slsBaseURL({ ...config, endpoint: "https://logs.example.test/" }),
    ).toBe("https://logs.example.test");
    expect(slsWriteURL({ ...config, mode: "web_tracking" })).toContain(
      "/track?APIVersion=0.6.0",
    );
  });

  it("matches the documented LOG HMAC-SHA1 signature construction", () => {
    const body = '{"__logs__":[{"message":"中文"}]}';
    const date = "Sat, 24 Oct 2026 10:00:00 GMT";
    const credentials = {
      access_key_id: "STS.test-id",
      access_key_secret: "test-secret",
      security_token: "test-token",
    };
    const headers = signSlsRequest(
      body,
      "/logstores/browser_requests",
      credentials,
      date,
    );
    const bytes = Buffer.from(body);
    const md5 = createHash("md5").update(bytes).digest("hex").toUpperCase();
    const canonical =
      `POST\n${md5}\napplication/json\n${date}\n` +
      "x-acs-security-token:test-token\n" +
      "x-log-apiversion:0.6.0\n" +
      `x-log-bodyrawsize:${bytes.length}\n` +
      "x-log-signaturemethod:hmac-sha1\n" +
      "/logstores/browser_requests";
    const expected = createHmac("sha1", "test-secret")
      .update(canonical)
      .digest("base64");
    expect(headers["Content-MD5"]).toBe(md5);
    expect(headers["x-log-bodyrawsize"]).toBe(String(bytes.length));
    expect(headers.Authorization).toBe(`LOG STS.test-id:${expected}`);
    expect(headers["x-acs-security-token"]).toBe("test-token");
  });

  it("supports a long-lived AccessKey without an STS SecurityToken", () => {
    const headers = signSlsRequest(
      '{"__logs__":[]}',
      "/logstores/browser_requests",
      {
        access_key_id: "LTAI-test-id",
        access_key_secret: "test-secret",
      },
      "Mon, 26 Oct 2026 10:00:00 GMT",
    );
    expect(headers.Authorization).toMatch(/^LOG LTAI-test-id:/);
    expect(headers).not.toHaveProperty("x-acs-security-token");
    expect(
      slsCredentialSummary({
        access_key_id: "LTAI12345678",
        access_key_secret: "must-not-appear",
      }),
    ).toBe(
      "AccessKey ID LTAI••••5678 · AccessKey Secret 已保存 · SecurityToken 未保存（长期 AccessKey 可不需要）",
    );
  });

  it("writes a real diagnostic log and returns its SLS request id", async () => {
    let sent: any;
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      sent = { url, options, body: JSON.parse(String(options.body)) };
      return new Response("", {
        status: 200,
        headers: { "x-log-requestid": "connection-request-1" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const receipt = await testSlsConnection(
      config,
      {
        access_key_id: "STS.test-id",
        access_key_secret: "test-secret",
        security_token: "test-token",
      },
      new Date("2026-10-26T10:00:00.000Z"),
    );
    expect(receipt).toBe("connection-request-1");
    expect(sent.url).toBe(slsWriteURL(config));
    expect(sent.options.headers.Authorization).toMatch(/^LOG STS\.test-id:/);
    expect(sent.body.__logs__[0]).toMatchObject({
      connection_test: "true",
      tested_at: "2026-10-26T10:00:00.000Z",
    });
  });

  it("shows the SLS HTTP status and response detail when a connection test fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '{"errorCode":"Unauthorized","errorMessage":"bad key"}',
            {
              status: 403,
            },
          ),
      ),
    );
    await expect(
      testSlsConnection(config, {
        access_key_id: "bad-id",
        access_key_secret: "bad-secret",
      }),
    ).rejects.toThrow(/HTTP 403.*Unauthorized.*bad key/);
  });

  it("stores searchable columns and splits oversized full records losslessly", () => {
    const fixture = workspaceFixture();
    const record = {
      ...fixture.records[0],
      response_body: {
        representation: "text",
        parsed: null,
        raw: "汉".repeat(400000),
      },
    } satisfies RecordEntry;
    const batch = {
      id: "sls-batch",
      scan_id: fixture.scans[0].id,
      channel: "sls",
      state: "pending",
      records: [record.request_id],
      attempts: 0,
      next_retry: 0,
      created_at: record.timestamp,
    } satisfies Batch;
    const smallBatchConfig = { ...config, batch_bytes: 256 * 1024 };
    const payloads = slsPayloads(
      [record],
      batch,
      fixture.scans[0] as Scan,
      smallBatchConfig,
    ).map((payload) => JSON.parse(payload));
    const logs = payloads.flatMap((payload) => payload.__logs__);
    expect(payloads.length).toBeGreaterThan(1);
    expect(logs.length).toBeGreaterThan(1);
    expect(logs[0]).toMatchObject({
      schema_version: "sls-2-chunk",
      transfer_batch_id: batch.id,
      record_chunk_index: "1",
    });
    const restored = JSON.parse(
      logs.map((log: any) => log.compact_json_chunk).join(""),
    );
    expect(JSON.parse(restored.response_body).value).toBe(
      record.response_body.raw,
    );
    expect(restored.request_url).toBe(record.request_url);
    expect(logs[0]).not.toHaveProperty("request_url");
    expect(new Set(logs.map((log: any) => log.record_sha256)).size).toBe(1);
    expect(
      payloads.every(
        (payload) =>
          Buffer.byteLength(JSON.stringify(payload)) <=
          smallBatchConfig.batch_bytes,
      ),
    ).toBe(true);
  });

  it("rejects ambiguous endpoints and invalid batch limits", () => {
    expect(() =>
      validateConfig({
        ...defaults(),
        sls: { ...config, endpoint: "https://example.test/path" },
      }),
    ).toThrow("无路径");
    expect(() =>
      validateConfig({
        ...defaults(),
        sls: { ...config, batch_bytes: 4 * 1024 * 1024 },
      }),
    ).toThrow("3 MB");
  });
});

describe("SLS field projection", () => {
  it("stores one body representation and preserves unsafe JSON as raw", () => {
    expect(
      compactBody({
        representation: "json",
        parsed: { a: 1 },
        raw: '{ "a": 1 }',
      }),
    ).toEqual({
      representation: "json",
      value_kind: "parsed",
      value: { a: 1 },
    });
    for (const raw of [
      '{"a":1,"a":2}',
      '{"n":9007199254740993}',
      '{"n":-0}',
      '{"n":1e-400}',
      '{"n":0.1234567890123456789}',
      "broken",
    ])
      expect(
        compactBody({ representation: "json", parsed: {}, raw }),
      ).toMatchObject({ value_kind: "raw", value: raw });
    expect(
      compactBody({
        representation: "form",
        parsed: [
          { name: "a", value: "" },
          { name: "a", value: "2" },
        ],
        raw: "a=&a=2",
      }),
    ).toMatchObject({
      value_kind: "parsed",
      value: [
        { name: "a", value: "" },
        { name: "a", value: "2" },
      ],
    });
    expect(
      compactBody({ representation: "form", parsed: [], raw: "x=%FF" }),
    ).toMatchObject({ value_kind: "raw", value: "x=%FF" });
    expect(
      compactBody({
        representation: "base64",
        parsed: null,
        raw: "R0lG",
        encoding: "base64",
      }),
    ).toMatchObject({ value_kind: "raw", value: "R0lG", encoding: "base64" });
  });
  it("preserves all stack frames and async parent chains with a local script dictionary", () => {
    const url = "https://example.test/script.js";
    const stack = {
      callFrames: Array.from({ length: 30 }, (_, i) => ({
        url,
        functionName: `f${i}`,
        lineNumber: i,
        columnNumber: 5,
        scriptId: "7",
      })),
      parent: {
        description: "Promise.then",
        callFrames: [{ url, functionName: "caller" }],
      },
    };
    const compact = compactStack(stack);
    expect(compact.scripts).toEqual([url]);
    expect(compact.stack.callFrames).toHaveLength(30);
    expect(compact.stack.parent.callFrames[0]).toEqual({
      url_ref: 0,
      functionName: "caller",
    });
    expect(compact.stack.callFrames[29]).toMatchObject({
      lineNumber: 29,
      scriptId: "7",
    });
  });
  it("applies independent SLS selection without modifying local records", () => {
    const record = workspaceFixture().records[0];
    const original = JSON.stringify(record);
    const core = slsProjection(record, []);
    expect(core).toHaveProperty("request_url", record.request_url);
    expect(core).not.toHaveProperty("request_body");
    const recommended = slsProjection(record);
    expect(recommended).not.toHaveProperty("security_details");
    expect(recommended).not.toHaveProperty("timing");
    expect(recommended).not.toHaveProperty("group_key");
    expect(recommended).not.toHaveProperty("response_headers_raw");
    expect(recommended).not.toHaveProperty("session_id");
    expect(JSON.stringify(record)).toBe(original);
    expect(slsProjection(record, ["internal"])).toHaveProperty("session_id");
  });
  it("rejects invalid SLS selection even when disabled", () => {
    expect(() =>
      validateConfig({
        ...defaults(),
        sls: { ...defaults().sls!, upload_fields: ["unknown"] },
      }),
    ).toThrow("上传字段");
  });
});
