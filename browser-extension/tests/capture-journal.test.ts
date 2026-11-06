import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CaptureJournal } from "../src/capture/journal";
import { RemoteCapture } from "../src/transport/client";
import { deliveryOutbox } from "../src/transport/outbox";
import * as storage from "../src/storage/capture-journal";
import { defaults, type Scan } from "../src/domain/model";
import { receiverFixture } from "./receiver-fixture";
let receiver: Awaited<ReturnType<typeof receiverFixture>>;
beforeAll(async () => {
  receiver = await receiverFixture();
});
afterAll(async () => {
  await receiver.close();
});
const scan = (): Scan => {
  const config = { ...defaults(), remote_capture: receiver.settings };
  return {
    id: crypto.randomUUID(),
    name: "journal test",
    state: "recording",
    started_at: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    browser: "test fixture",
    plugin: "0.11.0",
    stats: {
      observed: 0,
      pending: 0,
      matched: 0,
      excluded: 0,
      unknown: 0,
      persisted: 0,
      groups: 0,
      bytes: 0,
      lost: 0,
    },
    rule_hits: {},
    integrity: "observed_scope",
    gaps: [],
    config,
    versions: [{ version: 1, effective_at: new Date().toISOString(), config }],
    tabs: [{ id: 1, url: "https://app.test/" }],
  };
};
const params = () => ({
  requestId: "request",
  type: "Fetch",
  request: {
    url: "https://app.test/api",
    method: "POST",
    headers: {},
    postData: '{"id":0,"flag":false,"text":"字😀"}',
  },
});
const scope = () => `${new URL(receiver.settings.url).origin}\u0000default`;
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Journal progress timed out");
}
function row(s: Scan, connection = crypto.randomUUID()): storage.JournalRow {
  const capture_json = JSON.stringify({
    connection,
    sequence: 1,
    source: { tabId: 1 },
    method: "Network.requestWillBeSent",
    params: params(),
    observed_at: new Date().toISOString(),
    config_version: 1,
    capture_state: "recording",
    js_epoch: "js",
  });
  const bytes = new TextEncoder().encode(capture_json),
    observation = JSON.parse(capture_json),
    id = `raw:${connection}:1`;
  const event = {
    id,
    scan_id: s.id,
    kind: "RawCdpEvent",
    category: "raw_cdp",
    time: observation.observed_at,
    session_id: "root",
    tab_id: 1,
    epoch: connection,
    status: "captured",
    data: {
      capture_json,
      capture_bytes: bytes.length,
      capture_sha256: bytesToHex(sha256(bytes)),
    },
  };
  return {
    id,
    scan_id: s.id,
    scope: scope(),
    method: observation.method,
    bytes: bytes.length,
    storage_bytes: new TextEncoder().encode(JSON.stringify(event)).length,
    event,
  };
}

it("retains exact raw evidence if interrupted before handoff, then replays it once", async () => {
  const s = scan(),
    remote = new RemoteCapture(() => receiver.settings),
    journal = new CaptureJournal(remote);
  const fail = vi
    .spyOn(deliveryOutbox, "admit")
    .mockRejectedValueOnce(Error("crash before handoff"));
  const original = params();
  await journal.observe(
    s,
    "before-handoff",
    { tabId: 1 },
    "Network.requestWillBeSent",
    original,
    "js",
  );
  original.request.postData = "mutated";
  await until(() => remote.failed);
  await expect(journal.drain(s.id)).rejects.toThrow();
  fail.mockRestore();
  expect(await storage.journalSnapshot(s.id)).toMatchObject({
    admitted: 1,
    pending: 1,
    handed_off: 0,
  });
  const preserved = (await storage.journalRows(s.id))[0].event.data
    .capture_json;
  expect(preserved).toContain("字😀");
  expect(preserved).not.toContain("mutated");
  const restarted = new RemoteCapture(() => receiver.settings),
    replay = new CaptureJournal(restarted);
  await restarted.restore(s.id);
  await restarted.retry();
  await replay.replay(s.id);
  expect(
    (await restarted.page(s.id)).events.map((e) => e.data.capture_json),
  ).toEqual([preserved]);
  expect(await storage.journalSnapshot(s.id)).toMatchObject({
    admitted: 1,
    pending: 0,
    handed_off: 1,
  });
  expect((await restarted.seal(s.id))?.capture_journal?.count).toBe(1);
});

it("atomically hands off to the outbox and clears only after a validated ACK following restart", async () => {
  const s = scan(),
    offline = new RemoteCapture(
      () => receiver.settings,
      undefined,
      async () => {
        throw Error("offline");
      },
    ),
    journal = new CaptureJournal(offline);
  await journal.observe(
    s,
    "after-handoff",
    { tabId: 1 },
    "Network.requestWillBeSent",
    params(),
    "js",
  );
  await until(() => offline.failed);
  await expect(journal.drain(s.id)).rejects.toThrow();
  expect(await storage.journalRows(s.id)).toEqual([]);
  expect(await storage.journalSnapshot(s.id)).toMatchObject({
    admitted: 1,
    pending: 0,
    handed_off: 1,
  });
  expect((await deliveryOutbox.load(scope(), s.id)).entries).toHaveLength(1);
  const restored = new RemoteCapture(() => receiver.settings);
  await restored.restore(s.id);
  await restored.retry();
  await new CaptureJournal(restored).replay(s.id);
  expect((await deliveryOutbox.load(scope(), s.id)).entries).toEqual([]);
  expect((await restored.page(s.id)).count).toBe(1);
  expect((await restored.seal(s.id))?.capture_journal?.by_kind).toEqual({
    "Network.requestWillBeSent": 1,
  });
});

it("rolls back both sides of a mismatched handoff without deleting journal evidence", async () => {
  const s = scan(),
    original = row(s);
  await storage.appendJournal([original]);
  await expect(
    deliveryOutbox.admit(
      {
        key: "wrong-handoff",
        stream_id: "wrong-stream",
        scope: "other",
        journal_id: original.id,
        event: original.event,
      },
      { stream_id: "wrong-stream", scope: "other", scan_id: s.id },
    ),
  ).rejects.toThrow();
  expect((await storage.journalSnapshot(s.id)).pending).toBe(1);
  expect((await deliveryOutbox.load("other", s.id)).entries).toEqual([]);
  const restored = new RemoteCapture(() => receiver.settings);
  await new CaptureJournal(restored).replay(s.id);
  expect((await restored.seal(s.id))?.capture_journal?.count).toBe(1);
});

it("replays every durable raw row after concurrent handoff admission fails and the worker restarts", async () => {
  const s = scan(),
    rows = [row(s), row(s)];
  await storage.appendJournal(rows);
  const remote = new RemoteCapture(() => receiver.settings);
  const failure = vi
    .spyOn(deliveryOutbox, "admit")
    .mockRejectedValueOnce(Error("temporary disk failure"));
  try {
    const outcomes = await Promise.allSettled(
      rows.map((item) => remote.send(item.event, undefined, item.id)),
    );
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(
      true,
    );
  } finally {
    failure.mockRestore();
  }
  expect(await storage.journalSnapshot(s.id)).toMatchObject({
    admitted: 2,
    pending: 2,
    handed_off: 0,
  });
  const restarted = new RemoteCapture(() => receiver.settings);
  await restarted.restore(s.id);
  await new CaptureJournal(restarted).replay(s.id);
  expect(
    (await restarted.page(s.id)).events
      .map((item) => item.data.capture_json)
      .sort(),
  ).toEqual(rows.map((item) => item.event.data.capture_json).sort());
  expect((await restarted.seal(s.id))?.capture_journal?.count).toBe(2);
});

it("retains an admission-failed memory batch and persists it exactly once on retry", async () => {
  const s = scan(),
    remote = new RemoteCapture(() => receiver.settings),
    journal = new CaptureJournal(remote);
  const fail = vi
    .spyOn(storage, "appendJournal")
    .mockRejectedValueOnce(Error("disk full"));
  const pending = journal.observe(
    s,
    "disk-retry",
    { tabId: 1 },
    "Network.requestWillBeSent",
    params(),
    "js",
  );
  const rejected = expect(pending).rejects.toThrow("disk full");
  await expect(journal.flush()).rejects.toThrow("disk full");
  await rejected;
  fail.mockRestore();
  expect((await storage.journalSnapshot(s.id)).admitted).toBe(0);
  await journal.replay(s.id);
  expect((await storage.journalSnapshot(s.id)).admitted).toBe(1);
  expect((await remote.page(s.id)).count).toBe(1);
  await remote.seal(s.id);
});

it("frees persisted journal capacity before retrying a quota-rejected memory batch", async () => {
  const s = scan(),
    first = row(s);
  await storage.appendJournal([first]);
  const limit = storage.JOURNAL_LIMITS.bytes;
  storage.JOURNAL_LIMITS.bytes = first.storage_bytes + 100;
  const remote = new RemoteCapture(() => receiver.settings),
    journal = new CaptureJournal(remote);
  try {
    const pending = journal.observe(
      s,
      "quota-retry",
      { tabId: 1 },
      "Network.requestWillBeSent",
      params(),
      "js",
    );
    const rejected = expect(pending).rejects.toThrow("上限");
    await expect(journal.flush()).rejects.toThrow("上限");
    await rejected;
    expect((await storage.journalSnapshot(s.id)).pending).toBe(1);
    await journal.replay(s.id);
    expect(await storage.journalSnapshot(s.id)).toMatchObject({
      admitted: 2,
      pending: 0,
      handed_off: 2,
    });
    expect((await remote.seal(s.id))?.capture_journal?.count).toBe(2);
  } finally {
    storage.JOURNAL_LIMITS.bytes = limit;
  }
});

it("keeps raw pending payloads when a receiver lacks raw-journal capability", async () => {
  const s = scan(),
    remote = new RemoteCapture(
      () => receiver.settings,
      undefined,
      async (input, init) =>
        String(input).endsWith("/health")
          ? Response.json({ capabilities: ["delivery-ledger-1"] })
          : fetch(input, init),
    ),
    journal = new CaptureJournal(remote);
  await journal.observe(
    s,
    "old-receiver",
    { tabId: 1 },
    "Network.requestWillBeSent",
    params(),
    "js",
  );
  await until(() => remote.failed);
  await expect(journal.drain(s.id)).rejects.toThrow("原始日志");
  expect((await deliveryOutbox.load(scope(), s.id)).entries).toHaveLength(1);
  const updated = new RemoteCapture(() => receiver.settings);
  await updated.restore(s.id);
  await updated.retry();
  expect((await updated.seal(s.id))?.capture_journal?.count).toBe(1);
});

it("bounds the pending-write memory queue and keeps the accepted event intact", async () => {
  const s = scan(),
    remote = new RemoteCapture(() => receiver.settings),
    journal = new CaptureJournal(remote);
  const limit = storage.JOURNAL_LIMITS.memory_count;
  storage.JOURNAL_LIMITS.memory_count = 1;
  try {
    const first = journal.observe(
      s,
      "memory-limit",
      { tabId: 1 },
      "Network.requestWillBeSent",
      params(),
      "js",
    );
    const second = journal.observe(
      s,
      "memory-limit",
      { tabId: 1 },
      "Network.requestWillBeSent",
      params(),
      "js",
    );
    await expect(second).rejects.toThrow("缓冲已满");
    await first;
    await journal.drain(s.id);
    expect((await storage.journalSnapshot(s.id)).admitted).toBe(1);
    expect((await remote.seal(s.id))?.capture_journal?.count).toBe(1);
  } finally {
    storage.JOURNAL_LIMITS.memory_count = limit;
  }
});

it("does not accept a forged raw seal summary even when the transport totals match", async () => {
  const s = scan();
  let forged = true;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/seal") && forged)
        return Response.json({
          ...(await response.json()),
          capture_journal: { count: 999, bytes: 0, by_kind: {} },
        });
      return response;
    },
  );
  const journal = new CaptureJournal(remote);
  await journal.observe(
    s,
    "raw-seal",
    { tabId: 1 },
    "Network.requestWillBeSent",
    params(),
    "js",
  );
  await journal.drain(s.id);
  await expect(remote.seal(s.id)).rejects.toThrow("原始日志账目");
  expect(remote.isSealed(s.id)).toBe(false);
  forged = false;
  await remote.retry();
  expect(remote.isSealed(s.id)).toBe(true);
});

it("renegotiates raw capability after the same receiver is upgraded", async () => {
  const s = scan();
  let upgraded = false;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) =>
      String(input).endsWith("/health") && !upgraded
        ? Response.json({ capabilities: ["delivery-ledger-1"] })
        : fetch(input, init),
  );
  const journal = new CaptureJournal(remote);
  await journal.observe(
    s,
    "same-upgrade",
    { tabId: 1 },
    "Network.requestWillBeSent",
    params(),
    "js",
  );
  await until(() => remote.failed);
  await expect(journal.drain(s.id)).rejects.toThrow();
  upgraded = true;
  await remote.retry();
  await journal.replay(s.id);
  expect((await remote.seal(s.id))?.capture_journal?.count).toBe(1);
});

it("rejects a non-serializable notification without inventing a durable journal receipt", async () => {
  const s = scan(),
    journal = new CaptureJournal(new RemoteCapture(() => receiver.settings));
  await expect(
    journal.observe(
      s,
      "serialization",
      { tabId: 1 },
      "Network.requestWillBeSent",
      { ...params(), unsupported: 1n },
      "js",
    ),
  ).rejects.toThrow();
  expect((await storage.journalSnapshot(s.id)).admitted).toBe(0);
});

it("bounds in-flight tracking and clears session/tab indexes without deleting raw evidence", async () => {
  const s = scan(),
    remote = new RemoteCapture(() => receiver.settings),
    journal = new CaptureJournal(remote);
  const limit = storage.JOURNAL_LIMITS.tracking_count;
  storage.JOURNAL_LIMITS.tracking_count = 1;
  try {
    await journal.observe(
      s,
      "tracking",
      { tabId: 1, sessionId: "child" },
      "Network.requestWillBeSent",
      params(),
      "js",
    );
    await journal.observe(
      s,
      "tracking",
      { tabId: 2 },
      "Network.requestWillBeSent",
      { ...params(), requestId: "other" },
      "js",
    );
    expect(journal.tracks({ tabId: 1, sessionId: "child" }, "request")).toBe(
      true,
    );
    expect(journal.tracks({ tabId: 2 }, "other")).toBe(false);
    expect(
      s.gaps.some((item) => item.type === "raw_inflight_tracking_limit"),
    ).toBe(true);
    journal.forget({ tabId: 1, sessionId: "child" });
    expect(journal.tracks({ tabId: 1, sessionId: "child" }, "request")).toBe(
      false,
    );
    await journal.observe(
      s,
      "tracking",
      { tabId: 2 },
      "Network.requestWillBeSent",
      { ...params(), requestId: "third" },
      "js",
    );
    expect(journal.tracks({ tabId: 2 }, "third")).toBe(true);
    journal.forgetTab(2);
    expect(journal.tracks({ tabId: 2 }, "third")).toBe(false);
    await journal.drain(s.id);
    expect((await remote.seal(s.id))?.capture_journal?.count).toBe(3);
  } finally {
    storage.JOURNAL_LIMITS.tracking_count = limit;
  }
});
