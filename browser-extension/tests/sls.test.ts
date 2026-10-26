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
      method: record.method,
      request_url: record.request_url,
      transfer_batch_id: batch.id,
      record_chunk_index: "1",
      transfer_part_index: "1",
    });
    expect(logs.map((log: any) => log.record_json_chunk).join("")).toBe(
      JSON.stringify(record),
    );
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
