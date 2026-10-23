import "fake-indexeddb/auto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Recorder } from "../src/recorder";
import { defaults, type Batch } from "../src/model";
import * as db from "../src/store";
import { sendBatch, transfer, downloadChanged } from "../src/transfer";
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
