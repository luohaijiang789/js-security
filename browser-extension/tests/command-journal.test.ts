import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Recorder } from "../src/capture/recorder";
import { CaptureJournal } from "../src/capture/journal";
import { RemoteCapture } from "../src/transport/client";
import { defaults } from "../src/domain/model";
import * as storage from "../src/storage/capture-journal";
import { deliveryOutbox } from "../src/transport/outbox";
import { receiverFixture } from "./receiver-fixture";
let receiver: Awaited<ReturnType<typeof receiverFixture>>;
beforeAll(async () => {
  receiver = await receiverFixture();
});
afterAll(async () => {
  await receiver.close();
});
const settings = () => receiver.settings;
const config = () => ({
  ...defaults(),
  raw_capture: true,
  remote_capture: receiver.settings,
  stop_wait_ms: 0,
});
const scope = () => `${new URL(receiver.settings.url).origin}\u0000default`;

it("persists source intent/result before returning and replays exact bytes after outage without reissuing CDP", async () => {
  let offline = false;
  const remote = new RemoteCapture(settings, undefined, (input, init) =>
    offline ? Promise.reject(Error("offline")) : fetch(input, init),
  );
  const send = vi.fn(async () => ({ scriptSource: "/*字😀*/fetch('/api');" }));
  const recorder = new Recorder(send, remote);
  const scan = await recorder.create(
    "commands",
    [{ id: 1, url: "https://app.test/" }],
    config(),
  );
  offline = true;
  const result = await recorder.command(
    { tabId: 1 },
    "Debugger.getScriptSource",
    { scriptId: "S1" },
    {
      script: {
        scriptId: "S1",
        executionContextId: 1,
        url: "https://app.test/a.js",
      },
    },
  );
  expect(result.scriptSource).toContain("字😀");
  await recorder.journal.flush();
  // Stop the old upload pump before simulating worker replacement.
  await expect(recorder.journal.drain(scan.id)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
  const restarted = new RemoteCapture(settings);
  await restarted.restore(scan.id);
  await restarted.retry();
  await new CaptureJournal(restarted).replay(scan.id);
  const commands = (await restarted.page(scan.id)).events.filter(
    (event) => event.category === "raw_cdp",
  );
  expect(commands.map((event) => event.kind).sort()).toEqual([
    "RawCdpCommandResult",
    "RawCdpCommandStarted",
  ]);
  const raw = commands.map((event) => JSON.parse(event.data.capture_json));
  expect(new Set(raw.map((row) => row.command.command_id)).size).toBe(1);
  expect(
    raw.find((row) => row.command.phase === "result").command.result,
  ).toEqual(result);
  expect((await restarted.seal(scan.id))?.capture_journal?.by_kind).toEqual({
    "Debugger.getScriptSource": 2,
  });
  expect((await deliveryOutbox.load(scope(), scan.id)).entries).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not issue a browser command before its intent is durable", async () => {
  const send = vi.fn(async () => ({ body: "proof" }));
  const recorder = new Recorder(send);
  const scan = await recorder.create("failed intent", [], config());
  const failure = vi
    .spyOn(storage, "appendJournal")
    .mockRejectedValueOnce(Error("disk full"));
  try {
    await expect(
      recorder.command({ tabId: 1 }, "Network.getResponseBody", {
        requestId: "r",
      }),
    ).rejects.toThrow("disk full");
  } finally {
    failure.mockRestore();
  }
  expect(send).not.toHaveBeenCalled();
  expect(scan.state).toBe("paused");
  await recorder.journal.replay(scan.id);
  await recorder.remote.drain();
  const events = (await recorder.remote.page(scan.id)).events;
  expect(
    events.filter((event) => event.kind === "RawCdpCommandStarted"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.kind === "RawCdpCommandResult"),
  ).toHaveLength(0);
});

it("retains a failed result write in memory and retries it without executing the command twice", async () => {
  const send = vi.fn(async () => ({ postData: '{"zero":0}' }));
  const recorder = new Recorder(send);
  const scan = await recorder.create("failed result", [], config());
  const append = storage.appendJournal;
  const failure = vi
    .spyOn(storage, "appendJournal")
    .mockImplementation(async (rows) => {
      if (rows.some((row) => row.event.kind === "RawCdpCommandResult"))
        throw Error("result disk full");
      return append(rows);
    });
  try {
    await expect(
      recorder.command({ tabId: 1 }, "Network.getRequestPostData", {
        requestId: "r",
      }),
    ).rejects.toThrow("result disk full");
  } finally {
    failure.mockRestore();
  }
  await recorder.journal.replay(scan.id);
  await recorder.remote.drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (await recorder.remote.page(scan.id)).events.filter(
      (event) => event.kind === "RawCdpCommandResult",
    ),
  ).toHaveLength(1);
});

it("records explicit CDP failure and waits for a late result before sealing", async () => {
  let release!: (value: object) => void;
  const send = vi.fn(async (_s, method) => {
    if (method === "Network.getRequestPostData")
      throw Error("browser evicted body");
    return new Promise<object>((resolve) => {
      release = resolve;
    });
  });
  const recorder = new Recorder(send);
  const scan = await recorder.create("late result", [], config());
  await expect(
    recorder.command({ tabId: 1 }, "Network.getRequestPostData", {
      requestId: "r",
    }),
  ).rejects.toThrow("browser evicted");
  const pending = recorder.command({ tabId: 1 }, "Network.getResponseBody", {
    requestId: "r",
  });
  for (let n = 0; n < 100 && !release; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(release).toBeTypeOf("function");
  let stopped = false;
  const stop = recorder.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stopped).toBe(false);
  release({ body: "late-proof", base64Encoded: false });
  await pending;
  await stop;
  const results = (await recorder.remote.page(scan.id)).events
    .filter((event) => event.kind === "RawCdpCommandResult")
    .map((event) => JSON.parse(event.data.capture_json).command);
  expect(
    results.some((command) => command.error?.includes("browser evicted")),
  ).toBe(true);
  expect(results.some((command) => command.result?.body === "late-proof")).toBe(
    true,
  );
  expect(recorder.remote.isSealed(scan.id)).toBe(true);
});

it("retains command results until the same receiver advertises command-log support", async () => {
  let upgraded = false;
  const remote = new RemoteCapture(settings, undefined, (input, init) =>
    String(input).endsWith("/health") && !upgraded
      ? Promise.resolve(
          Response.json({
            capabilities: ["delivery-ledger-1", "raw-cdp-journal-1"],
          }),
        )
      : fetch(input, init),
  );
  const send = vi.fn(async () => ({
    body: "upgrade-proof",
    base64Encoded: false,
  }));
  const recorder = new Recorder(send, remote);
  const scan = await recorder.create(
    "command capability upgrade",
    [],
    config(),
  );
  await recorder.command({ tabId: 1 }, "Network.getResponseBody", {
    requestId: "r",
  });
  await expect(recorder.journal.drain(scan.id)).rejects.toThrow("命令结果日志");
  expect((await storage.journalSnapshot(scan.id)).admitted).toBe(2);
  expect(remote.isSealed(scan.id)).toBe(false);
  upgraded = true;
  await remote.retry();
  await recorder.journal.replay(scan.id);
  expect((await remote.seal(scan.id))?.capture_journal?.by_kind).toEqual({
    "Network.getResponseBody": 2,
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains but invalidates source results that finish after the debugger session changes", async () => {
  let release!: (value: object) => void;
  const recorder = new Recorder(
    async () =>
      new Promise<object>((resolve) => {
        release = resolve;
      }),
  );
  const scan = await recorder.create("replaced source session", [], config());
  recorder.js.session({ tabId: 1 });
  const pending = recorder.command({ tabId: 1 }, "Debugger.getScriptSource", {
    scriptId: "reused",
  });
  for (let n = 0; n < 100 && !release; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  recorder.js.session({ tabId: 1 });
  release({ scriptSource: "new renderer bytes" });
  await pending;
  await recorder.journal.drain(scan.id);
  await recorder.remote.drain();
  const event = (await recorder.remote.page(scan.id)).events.find(
    (event) => event.kind === "RawCdpCommandResult",
  )!;
  const raw = JSON.parse(event.data.capture_json);
  expect(raw.command.context_valid).toBe(false);
  expect(raw.command.result.scriptSource).toBe("new renderer bytes");
});
