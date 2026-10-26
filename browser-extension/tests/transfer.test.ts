import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Recorder } from "../src/recorder";
import { defaults, type Batch } from "../src/model";
import * as db from "../src/store";
import {
  sendBatch,
  transfer,
  downloadChanged,
  retargetFailedSls,
} from "../src/transfer";
let recorder: Recorder;
beforeEach(async () => {
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    storage: { session: { get: vi.fn().mockResolvedValue({}) } },
    downloads: {
      download: vi.fn().mockResolvedValue(11),
      search: vi.fn().mockResolvedValue([{ state: "in_progress" }]),
    },
  });
  recorder = new Recorder(async () => ({}));
  await recorder.create(
    "transfer fixture",
    [{ id: 1, url: "https://fixture.test" }],
    {
      ...defaults(),
      service: {
        enabled: true,
        url: "https://receiver.test/ingest",
        batch_size: 200,
      },
      stop_wait_ms: 0,
    },
  );
  await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
    requestId: "1",
    request: {
      url: "https://api.test/?token=secret",
      method: "GET",
      headers: { Authorization: "secret" },
    },
    documentURL: "https://fixture.test",
  });
  await recorder.event({ tabId: 1 }, "Network.loadingFinished", {
    requestId: "1",
  });
  await recorder.tail;
  await recorder.flush();
});
afterEach(() => vi.unstubAllGlobals());
it("可选 gzip 压缩的接收方获得原始 JSON 批次及正确编码头", async () => {
  recorder.scan!.config.archive.enabled = false;
  recorder.scan!.config.service.compress = true;
  let decoded: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      expect(options.headers["Content-Encoding"]).toBe("gzip");
      const stream = (options.body as Blob)
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      decoded = JSON.parse(await new Response(stream).text());
      return {
        ok: true,
        json: async () => ({ batch_id: decoded.batch_id, persisted: true }),
      };
    }),
  );
  await transfer(recorder.scan!, true);
  expect(decoded.records).toHaveLength(1);
  expect((await db.all<Batch>("batches", recorder.scan!.id))[0].state).toBe(
    "complete",
  );
});
it("文件必须确认完成，服务必须确认持久化并包含采集到的原始值", async () => {
  const payloads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      payloads.push(options.body);
      return {
        ok: true,
        json: async () => ({
          persisted: true,
          batch_id: JSON.parse(options.body).batch_id,
        }),
      };
    }),
  );
  await transfer(recorder.scan!, true);
  const batches = await db.all<Batch>("batches", recorder.scan!.id);
  expect(batches.find((b) => b.channel === "service")?.state).toBe("complete");
  const file = batches.find((b) => b.channel === "file")!;
  expect(file.state).toBe("downloading");
  await downloadChanged({ id: 11, state: { current: "complete" } });
  expect((await db.get<Batch>("batches", file.id))?.state).toBe("complete");
  expect(payloads.join("")).toContain("secret");
  expect(payloads.join("")).toContain("Authorization");
  await transfer(recorder.scan!, true);
  expect(await db.all("batches", recorder.scan!.id)).toHaveLength(2);
});
it("错误确认不算成功，三次有界重试保留同 Batch ID", async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ persisted: false, batch_id: "wrong" }),
  });
  vi.stubGlobal("fetch", fetch);
  recorder.scan!.config.archive.enabled = false;
  await transfer(recorder.scan!, true);
  const [batch] = await db.all<Batch>("batches", recorder.scan!.id);
  for (let i = 0; i < 4; i++) {
    const current = (await db.get<Batch>("batches", batch.id))!;
    current.next_retry = 0;
    await sendBatch(current, recorder.scan!);
  }
  const stored = (await db.get<Batch>("batches", batch.id))!;
  expect(stored.state).toBe("failed");
  expect(stored.attempts).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    new Set(fetch.mock.calls.map((c: any) => c[1].headers["Idempotency-Key"]))
      .size,
  ).toBe(1);
  expect(await db.page(recorder.scan!.id)).toHaveLength(1);
});
it("取消下载保留本地待处理批次，不误标转存成功", async () => {
  recorder.scan!.config.service.enabled = false;
  await transfer(recorder.scan!, true);
  const [b] = await db.all<Batch>("batches", recorder.scan!.id);
  await downloadChanged({
    id: 11,
    state: { current: "interrupted" },
    error: { current: "USER_CANCELED" },
  });
  expect((await db.get<Batch>("batches", b.id))?.state).toBe("failed");
  expect(await db.page(recorder.scan!.id)).toHaveLength(1);
});
it("使用会话 STS 凭证签名批量写入 SLS，并保存请求回执", async () => {
  recorder.scan!.config.archive.enabled = false;
  recorder.scan!.config.service.enabled = false;
  recorder.scan!.config.sls = {
    ...defaults().sls!,
    enabled: true,
    endpoint: "cn-hangzhou.log.aliyuncs.com",
    project: "security-project",
    logstore: "browser_requests",
  };
  (chrome.storage.session.get as any).mockResolvedValue({
    sls_credentials: {
      "https://security-project.cn-hangzhou.log.aliyuncs.com|security-project|browser_requests":
        {
          access_key_id: "STS.id",
          access_key_secret: "secret",
          security_token: "token",
        },
    },
  });
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      sent = { url, options, payload: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "x-log-requestid": "sls-request-1" }),
        text: async () => "",
      };
    }),
  );
  await transfer(recorder.scan!, true);
  expect(sent.url).toBe(
    "https://security-project.cn-hangzhou.log.aliyuncs.com/logstores/browser_requests",
  );
  expect(sent.options.headers.Authorization).toMatch(/^LOG STS\.id:/);
  expect(sent.options.headers["x-acs-security-token"]).toBe("token");
  expect(sent.payload.__logs__[0].record_json_chunk).toContain("Authorization");
  const [batch] = await db.all<Batch>("batches", recorder.scan!.id);
  expect(batch.channel).toBe("sls");
  expect(batch.state).toBe("complete");
  expect(batch.receipt).toBe("sls-request-1");
});
it("长期 AccessKey 不需要 SecurityToken 也能签名写入 SLS", async () => {
  recorder.scan!.config.archive.enabled = false;
  recorder.scan!.config.service.enabled = false;
  recorder.scan!.config.sls = {
    ...defaults().sls!,
    enabled: true,
    endpoint: "cn-hangzhou.log.aliyuncs.com",
    project: "security-project",
    logstore: "browser_requests",
  };
  (chrome.storage.session.get as any).mockResolvedValue({
    sls_credentials: {
      "https://security-project.cn-hangzhou.log.aliyuncs.com|security-project|browser_requests":
        {
          access_key_id: "LTAI.test-id",
          access_key_secret: "secret",
        },
    },
  });
  let headers: Record<string, string> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      headers = options.headers;
      return new Response("", { status: 200 });
    }),
  );
  await transfer(recorder.scan!, true);
  expect(headers.Authorization).toMatch(/^LOG LTAI\.test-id:/);
  expect(headers).not.toHaveProperty("x-acs-security-token");
  const [batch] = await db.all<Batch>("batches", recorder.scan!.id);
  expect(batch.state).toBe("complete");
});
it("WebTracking 模式写入匿名 track 端点且不读取凭证", async () => {
  recorder.scan!.config.archive.enabled = false;
  recorder.scan!.config.service.enabled = false;
  recorder.scan!.config.sls = {
    ...defaults().sls!,
    enabled: true,
    mode: "web_tracking",
    endpoint: "cn-shanghai.log.aliyuncs.com",
    project: "security-project",
    logstore: "browser_requests",
  };
  const fetch = vi.fn(async (_url: string, _options: any) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetch);
  await transfer(recorder.scan!, true);
  expect(fetch.mock.calls[0][0]).toContain(
    "/logstores/browser_requests/track?APIVersion=0.6.0",
  );
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("headers");
  expect(chrome.storage.session.get).not.toHaveBeenCalled();
});

it("结束任务的失败 SLS 批次可改发新目标，完成批次和任务目标不变", async () => {
  const scan = recorder.scan!;
  scan.state = "ended";
  const oldTarget = {
    ...defaults().sls!,
    enabled: true,
    mode: "web_tracking" as const,
    endpoint: "cn-hangzhou.log.aliyuncs.com",
    project: "old-project",
    logstore: "old_logs",
  };
  scan.config.sls = oldTarget;
  const rows = await db.page(scan.id);
  const base: Batch = {
    id: "repair-failed",
    scan_id: scan.id,
    channel: "sls",
    state: "failed",
    attempts: 3,
    next_retry: Date.now() + 100000,
    created_at: new Date().toISOString(),
    records: rows.map((r) => r.request_id),
    sls: oldTarget,
  };
  await db.put("batches", base);
  await db.put("batches", {
    ...base,
    id: "repair-complete",
    state: "complete",
  });
  const fetch = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await retargetFailedSls(scan, {
    ...oldTarget,
    project: "new-project",
    logstore: "new_logs",
  });
  expect(fetch.mock.calls).toHaveLength(1);
  expect((fetch.mock.calls[0] as any)[0]).toContain(
    "new-project.cn-hangzhou.log.aliyuncs.com/logstores/new_logs",
  );
  expect((await db.get<Batch>("batches", base.id))?.state).toBe("complete");
  expect(
    (await db.get<Batch>("batches", "repair-complete"))?.sls?.project,
  ).toBe("old-project");
  expect(scan.config.sls.project).toBe("old-project");
});
