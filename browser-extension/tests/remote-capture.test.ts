import "fake-indexeddb/auto";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  RemoteCapture,
  digest,
  type CaptureEvent,
} from "../src/remote-capture";
import { receiverFixture, receiverToken } from "./receiver-fixture";
let receiver: Awaited<ReturnType<typeof receiverFixture>>;
beforeAll(async () => {
  receiver = await receiverFixture();
});
afterAll(async () => {
  await receiver?.close();
});
const sample = (id: string, data: Record<string, any> = {}): CaptureEvent => ({
  id,
  scan_id: "transport-scan",
  kind: "Debugger.scriptParsed",
  time: "2026-11-02T12:00:00Z",
  session_id: "child",
  epoch: "connection",
  status: "captured",
  data,
});
const client = (fetcher?: typeof fetch) =>
  new RemoteCapture(
    () => receiver.settings,
    async () => receiverToken,
    fetcher,
  );
it("actual HTTP uploads chunks and exactly preserves all event fields, Unicode and same-content independent observations", async () => {
  const remote = client(),
    source =
      "\ufeff/*" + "字😀".repeat(500000) + '*/\nfetch("/api?empty=&x=0")';
  const hash = digest(new TextEncoder().encode(source));
  const first = sample("unicode-1", {
    source_bytes: new TextEncoder().encode(source).length,
    url: "https://site.test/字.js",
    null: null,
    zero: 0,
    empty: "",
    false: false,
    arrays: [1, { a: '\n\\"' }],
    stack: {
      parentId: { id: "async-stack" },
      callFrames: [{ lineNumber: 0, columnNumber: 0 }],
    },
  });
  first.hash = hash;
  await remote.send(first, source);
  await remote.send(
    { ...first, id: "unicode-2", session_id: "different-child" },
    source,
  );
  const events = (await remote.page(first.scan_id)).events;
  expect(events.slice(0, 2)).toEqual([
    first,
    { ...first, id: "unicode-2", session_id: "different-child" },
  ]);
  expect((await remote.source(hash)) === source).toBe(true);
});
it("a lost event ACK retries idempotently and never duplicates events", async () => {
  let dropped = false;
  const remote = client(async (input, init) => {
    const response = await fetch(input, init);
    if (
      String(input).endsWith("/events") &&
      init?.method === "POST" &&
      !dropped
    ) {
      dropped = true;
      await response.text();
      throw Error("simulated lost ACK");
    }
    return response;
  });
  const event = sample("lost-ack", { complete: "all fields" });
  await remote.send(event);
  expect(dropped).toBe(true);
  expect(
    (await remote.page(event.scan_id)).events.filter((e) => e.id === event.id),
  ).toEqual([event]);
  expect(remote.failed).toBe(false);
});
it("a forged ACK is not success; memory pending can be retried and ID conflicts are rejected", async () => {
  let forge = true;
  const remote = client(async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/events") && init?.method === "POST" && forge) {
      return Response.json({
        ...(await response.json()),
        event_sha256: "0".repeat(64),
      });
    }
    return response;
  });
  const event = sample("forged-ack", { value: 1 });
  await expect(remote.send(event)).rejects.toThrow("确认无效");
  expect(remote.failed).toBe(true);
  expect(remote.acknowledged).toBe(0);
  forge = false;
  await remote.retry();
  expect(remote.failed).toBe(false);
  expect(
    (await remote.page(event.scan_id)).events.filter((e) => e.id === event.id),
  ).toEqual([event]);
  await expect(client().send({ ...event, data: { value: 2 } })).rejects.toThrow(
    "409",
  );
});
it("server process restart preserves acknowledged content and event equality", async () => {
  const remote = client(),
    source = "exact after restart";
  const event = sample("restart", {
    source_bytes: new TextEncoder().encode(source).length,
  });
  event.hash = digest(new TextEncoder().encode(source));
  await remote.send(event, source);
  await receiver.stop();
  receiver.settings.url = await receiver.start();
  expect(
    (await remote.page(event.scan_id)).events.find((e) => e.id === event.id),
  ).toEqual(event);
  expect(await remote.source(event.hash)).toBe(source);
});
it("wrong token and wrong local content never become successful acknowledgements", async () => {
  const wrong = new RemoteCapture(
    () => receiver.settings,
    async () => "bad-token",
  );
  await expect(wrong.send(sample("bad-token"))).rejects.toThrow("401");
  expect(wrong.acknowledged).toBe(0);
  await expect(
    client().send(
      { ...sample("corrupt"), hash: "a".repeat(64) },
      "wrong source",
    ),
  ).rejects.toThrow("校验失败");
});

it("large request events are chunked without dropping or truncating any fields", async () => {
  const remote = client();
  const event = sample("large-request", {
    record: {
      body: {
        raw: "字".repeat(1048576),
        parsed: { n: 0, empty: "", flag: false },
      },
      headers: [{ name: "Cookie", value: "unchanged" }],
    },
  });
  event.kind = "ObservedRequest";
  await remote.send(event);
  const received = (await remote.page(event.scan_id)).events.find(
    (e) => e.id === event.id,
  );
  expect(received).toEqual(event);
});

it("failed delivery pauses the recorder, cannot be marked ended, and memory retry recovers the exact event", async () => {
  let offline = false;
  const remote = client(async (input, init) => {
    if (offline && init?.method === "POST" && String(input).endsWith("/events"))
      throw Error("offline");
    return fetch(input, init);
  });
  const recorder = new Recorder(
    async (_s, method) =>
      method === "Debugger.getScriptSource"
        ? { scriptSource: "// exact after retry" }
        : {},
    remote,
  );
  const scan = await recorder.create(
    "failure recovery",
    [{ id: 1, url: "https://fixture.test" }],
    {
      ...defaults(),
      collect_js: true,
      remote_capture: receiver.settings,
      stop_wait_ms: 0,
    },
  );
  await recorder.configure({ tabId: 1 });
  offline = true;
  await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", {
    scriptId: "failure-script",
    url: "https://fixture.test/failure.js",
    length: 20,
  });
  await recorder.js.drain();
  expect(scan.state).toBe("paused");
  expect(remote.failed).toBe(true);
  await expect(recorder.stop()).rejects.toThrow("未确认");
  expect(scan.state).toBe("paused");
  expect(
    (await indexedDB.databases()).some(
      (d) => d.name === "js-security-js-outbox",
    ),
  ).toBe(false);
  offline = false;
  await recorder.resume();
  await recorder.stop();
  expect(remote.failed).toBe(false);
  expect(scan.state).toBe("ended");
  const scripts = (await remote.page(scan.id)).events.filter(
    (e) => e.kind === "Debugger.scriptParsed",
  );
  expect(scripts).toHaveLength(1);
  expect(await remote.source(scripts[0].hash!)).toBe("// exact after retry");
});
