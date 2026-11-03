import "fake-indexeddb/auto";
import { Recorder } from "../src/recorder";
import { defaults } from "../src/model";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  RemoteCapture,
  SCHEMA,
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
const sample = (
  id: string,
  data: Record<string, any> = {},
  category = "js_source",
): CaptureEvent => ({
  id,
  scan_id: "transport-scan",
  kind: "Debugger.scriptParsed",
  category,
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
it("actual HTTP uploads chunks and exactly preserves all event fields, Unicode and independent observations", async () => {
  const remote = client(),
    source =
      "﻿/*" + "字😀".repeat(500000) + '*/\nfetch("/api?empty=&x=0")';
  const first = sample("unicode-1", {
    source_bytes: new TextEncoder().encode(source).length,
    url: "https://site.test/字.js",
    object_url: "https://site.test/字.js",
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
  await remote.send(first, source);
  // The browser never hashes; the receiver returns the content-addressed ID.
  expect(first.object_id).toMatch(/^[a-f0-9]{64}$/);
  expect(first.data.source_bytes).toBe(new TextEncoder().encode(source).length);
  await remote.send(
    { ...first, id: "unicode-2", session_id: "different-child" },
    source,
  );
  const events = (await remote.page(first.scan_id)).events;
  expect(events.slice(0, 2)).toEqual([
    first,
    { ...first, id: "unicode-2", session_id: "different-child" },
  ]);
  expect((await remote.source(first.object_id!)) === source).toBe(true);
});
it("the receiver, not the browser, assigns content-addressed object IDs and URL mappings", async () => {
  const remote = client();
  const first = await remote.upload(
    "same body",
    "https://site.test/first.js",
    "js",
    64 * 1048576,
  );
  const second = await remote.upload(
    "same body",
    "https://site.test/copy.js",
    "js",
    64 * 1048576,
  );
  expect(first.object_id).toMatch(/^[a-f0-9]{64}$/);
  expect(second.object_id).toBe(first.object_id);
  expect(first.url).toBe("https://site.test/first.js");
  expect(second.url).toBe("https://site.test/copy.js");
  const status = await (
    await remote.request(`/objects/${first.object_id}?status`)
  ).json();
  expect(status).toEqual({
    object_id: first.object_id,
    bytes: 9,
    committed: true,
  });
});
it("a lost upload commit ACK retries idempotently without storing a second body", async () => {
  let dropped = false,
    commits = 0;
  const remote = client(async (input, init) => {
    const path = String(input);
    if (path.includes("/commit") && init?.method === "POST") commits++;
    const response = await fetch(input, init);
    if (path.includes("/commit") && init?.method === "POST" && !dropped) {
      dropped = true;
      await response.text();
      throw Error("simulated lost commit ACK");
    }
    return response;
  });
  const event = sample("lost-commit", {
    url: "https://site.test/lost.js",
    object_url: "https://site.test/lost.js",
  });
  await remote.send(event, "body for lost commit");
  expect(dropped).toBe(true);
  expect(commits).toBe(2); // The receiver replayed the commit receipt.
  expect(event.object_id).toMatch(/^[a-f0-9]{64}$/);
  expect(await remote.source(event.object_id!)).toBe("body for lost commit");
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
      return Response.json({ ...(await response.json()), durable: false });
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
    url: "https://site.test/restart.js",
    object_url: "https://site.test/restart.js",
  });
  await remote.send(event, source);
  expect(event.object_id).toMatch(/^[a-f0-9]{64}$/);
  await receiver.stop();
  receiver.settings.url = await receiver.start();
  expect(
    (await remote.page(event.scan_id)).events.find((e) => e.id === event.id),
  ).toEqual(event);
  expect(await remote.source(event.object_id!)).toBe(source);
});
it("a wrong token never becomes a successful acknowledgement", async () => {
  const wrong = new RemoteCapture(
    () => receiver.settings,
    async () => "bad-token",
  );
  await expect(wrong.send(sample("bad-token"))).rejects.toThrow("401");
  expect(wrong.acknowledged).toBe(0);
});

it("large request events are chunked without dropping or truncating any fields", async () => {
  const remote = client();
  const event = sample(
    "large-request",
    {
      record: {
        body: {
          raw: "字".repeat(1048576),
          parsed: { n: 0, empty: "", flag: false },
        },
        headers: [{ name: "Cookie", value: "unchanged" }],
      },
    },
    "api_request",
  );
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
  expect(await remote.source(scripts[0].object_id!)).toBe(
    "// exact after retry",
  );
});

it("default code works with no setup, any extension ID and an ordinary HTTP address", async () => {
  const origin = "chrome-extension://new-extension-without-pairing";
  const health = await fetch(receiver.settings.url + "/health");
  expect((await health.json()).status).toBe("ok");
  const preflight = await fetch(
    receiver.settings.url + "/v1/projects/default/events",
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    (input, init) =>
      fetch(input, { ...init, headers: { ...init?.headers, Origin: origin } }),
  );
  const event = sample("built-in-code-no-pairing", {
    complete: "default setup",
  });
  await remote.send(event);
  expect(
    (await remote.page(event.scan_id)).events.find((e) => e.id === event.id),
  ).toEqual(event);
});