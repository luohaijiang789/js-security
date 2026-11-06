import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { RemoteCapture } from "../src/transport/client";
import { type CaptureEvent } from "../src/domain/evidence";
import { deliveryOutbox } from "../src/transport/outbox";
import { receiverFixture } from "./receiver-fixture";
let receiver: Awaited<ReturnType<typeof receiverFixture>>;
beforeAll(async () => {
  receiver = await receiverFixture();
});
afterAll(async () => {
  await receiver?.close();
});
const event = (scan: string, n: number): CaptureEvent => ({
  id: `${scan}:${n}`,
  scan_id: scan,
  kind: "ObservedRequest",
  category: "api_request",
  time: new Date().toISOString(),
  session_id: "root",
  epoch: "connection",
  status: "captured",
  data: { record: { n, zero: 0, empty: "", flag: false } },
});
const scope = () => `${new URL(receiver.settings.url).origin}\u0000default`;
it("retains every queued payload across an outage and a new client, then deletes only ACKed payloads", async () => {
  const scan = crypto.randomUUID();
  let offline = true;
  const first = new RemoteCapture(
    () => receiver.settings,
    undefined,
    (input, init) => {
      if (offline) return Promise.reject(Error("offline"));
      return fetch(input, init);
    },
  );
  const sent = Array.from({ length: 12 }, (_, i) => event(scan, i));
  const outcomes = await Promise.allSettled(sent.map((e) => first.send(e)));
  expect(outcomes.every((r) => r.status === "rejected")).toBe(true);
  expect(first.status(scan)).toMatchObject({
    admitted: 12,
    acknowledged: 0,
    pending: 12,
  });
  expect((await deliveryOutbox.load(scope(), scan)).entries).toHaveLength(12);
  // Simulate discarding every in-memory queue/reference, as on background restart.
  offline = false;
  const restarted = new RemoteCapture(() => receiver.settings);
  await restarted.restore(scan);
  await restarted.retry();
  expect(
    (await restarted.page(scan)).events.sort(
      (a, b) => a.transport!.sequence - b.transport!.sequence,
    ),
  ).toEqual(sent);
  expect(restarted.status(scan)).toMatchObject({
    admitted: 12,
    acknowledged: 12,
    pending: 0,
  });
  expect((await deliveryOutbox.load(scope(), scan)).entries).toEqual([]);
  const receipt = await restarted.seal(scan);
  expect(receipt).toMatchObject({
    count: 12,
    categories: { api_request: 12 },
    sealed: true,
    durable: true,
  });
  await expect(restarted.send(event(scan, 99))).rejects.toThrow("封账");
});
it("crash after server persistence but before event ACK cleans up by idempotent replay, not duplicate records", async () => {
  const scan = crypto.randomUUID();
  const broken = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/events") && init?.method === "POST") {
        await response.text();
        throw Error("lost all ACKs");
      }
      return response;
    },
  );
  const original = event(scan, 1);
  await expect(broken.send(original)).rejects.toThrow();
  expect((await deliveryOutbox.load(scope(), scan)).entries).toHaveLength(1);
  const restarted = new RemoteCapture(() => receiver.settings);
  await restarted.restore(scan);
  await restarted.retry();
  expect((await restarted.page(scan)).events).toEqual([original]);
  expect((await deliveryOutbox.load(scope(), scan)).entries).toEqual([]);
  expect((await restarted.seal(scan))?.count).toBe(1);
});
it("an interrupted chunk upload keeps its upload identity and exact JS body through restart", async () => {
  const scan = crypto.randomUUID(),
    body = "/*" + "字😀".repeat(200000) + "*/";
  const original: CaptureEvent = {
    ...event(scan, 1),
    kind: "Debugger.scriptParsed",
    category: "js_source",
    data: {
      url: "https://site.test/changing.js",
      object_url: "https://site.test/changing.js",
    },
  };
  const broken = new RemoteCapture(
    () => receiver.settings,
    undefined,
    (input, init) =>
      String(input).includes("/chunks/262144")
        ? Promise.reject(Error("chunk disconnected"))
        : fetch(input, init),
  );
  await expect(broken.send(original, body)).rejects.toThrow();
  const saved = (await deliveryOutbox.load(scope(), scan)).entries;
  expect(saved).toHaveLength(1);
  expect(saved[0].source).toBe(body);
  const restarted = new RemoteCapture(() => receiver.settings);
  await restarted.restore(scan);
  await restarted.retry();
  const [received] = (await restarted.page(scan)).events;
  expect(await restarted.source(received.object_id!)).toBe(body);
  expect((await deliveryOutbox.load(scope(), scan)).entries).toEqual([]);
  expect((await restarted.seal(scan))?.count).toBe(1);
});
it("a mutated caller cannot change the already admitted event and a forged seal is not completion", async () => {
  const scan = crypto.randomUUID();
  let forged = true;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/seal") && forged)
        return Response.json({ ...(await response.json()), count: 999 });
      return response;
    },
  );
  const original = event(scan, 1),
    delivery = remote.send(original);
  original.data.record.n = "caller-mutated";
  await delivery;
  expect((await remote.page(scan)).events[0].data.record.n).toBe(1);
  await expect(remote.seal(scan)).rejects.toThrow("不一致");
  expect(remote.isSealed(scan)).toBe(false);
  forged = false;
  await remote.retry();
  expect(remote.isSealed(scan)).toBe(true);
});
it("concurrent live admission and ACK transactions preserve every category total and sequence", async () => {
  const scan = crypto.randomUUID();
  const remote = new RemoteCapture(() => receiver.settings);
  const events = Array.from({ length: 40 }, (_, i) => event(scan, i));
  await Promise.all(events.map((item) => remote.send(item)));
  expect(remote.status(scan)).toMatchObject({
    admitted: 40,
    acknowledged: 40,
    pending: 0,
    categories: { api_request: 40 },
  });
  expect((await remote.seal(scan))?.count).toBe(40);
  const saved = await deliveryOutbox.load(scope(), scan);
  expect(saved.entries).toEqual([]);
  expect(saved.ledgers[0]).toMatchObject({
    admitted: 40,
    acknowledged: 40,
    pending: 0,
    sealed: true,
  });
});

it("disk admission failure keeps the payload and retries persistence before sending", async () => {
  const scan = crypto.randomUUID();
  const remote = new RemoteCapture(() => receiver.settings);
  const failure = vi
    .spyOn(deliveryOutbox, "admit")
    .mockRejectedValueOnce(Error("disk quota"));
  const original = event(scan, 1);
  await expect(remote.send(original)).rejects.toThrow("仍在内存");
  expect(remote.status(scan)).toMatchObject({
    admitted: 1,
    acknowledged: 0,
    pending: 1,
  });
  expect((await remote.page(scan)).events).toEqual([]);
  failure.mockRestore();
  await remote.retry();
  expect((await remote.page(scan)).events).toEqual([original]);
  expect((await deliveryOutbox.load(scope(), scan)).entries).toEqual([]);
  expect((await remote.seal(scan))?.count).toBe(1);
});
it("freezes concurrent admissions after a disk failure without persisting a phantom ledger item", async () => {
  const scan = crypto.randomUUID();
  const remote = new RemoteCapture(() => receiver.settings);
  const failure = vi
    .spyOn(deliveryOutbox, "admit")
    .mockRejectedValueOnce(Error("disk quota"));
  let outcomes;
  try {
    outcomes = await Promise.allSettled([
      remote.send(event(scan, 1)),
      remote.send(event(scan, 2)),
    ]);
  } finally {
    failure.mockRestore();
  }
  expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  expect(remote.status(scan)).toMatchObject({
    pending: 1,
    volatile_pending: 1,
  });
  expect((await deliveryOutbox.descriptors(scope(), scan)).ledgers).toEqual([]);
  await expect(
    new RemoteCapture(() => receiver.settings).restore(scan),
  ).resolves.toBeUndefined();
  await remote.retry();
  await remote.send(event(scan, 2));
  expect((await remote.seal(scan))?.count).toBe(2);
});

it("an older in-flight ACK cannot persist the reservation of a later failed admission", async () => {
  const scan = crypto.randomUUID();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/events")) {
        started();
        await held;
      }
      return response;
    },
  );
  const first = remote.send(event(scan, 1));
  await arrived;
  const failure = vi
    .spyOn(deliveryOutbox, "admit")
    .mockRejectedValueOnce(Error("temporary disk failure"));
  try {
    await expect(remote.send(event(scan, 2))).rejects.toThrow("仍在内存");
  } finally {
    failure.mockRestore();
    release();
  }
  await first;
  const saved = await deliveryOutbox.descriptors(scope(), scan);
  expect(saved.ledgers[0]).toMatchObject({
    admitted: 1,
    acknowledged: 1,
    pending: 0,
  });
  expect(saved.entries).toEqual([]);
  await expect(
    new RemoteCapture(() => receiver.settings).restore(scan),
  ).resolves.toBeUndefined();
  await remote.retry();
  expect((await remote.seal(scan))?.count).toBe(2);
});
it("a syntactically valid but incorrect event digest never clears a durable payload", async () => {
  const scan = crypto.randomUUID();
  let corrupt = true;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/events") && corrupt)
        return Response.json({
          ...(await response.json()),
          event_sha256: "f".repeat(64),
        });
      return response;
    },
  );
  const original = event(scan, 1);
  await expect(remote.send(original)).rejects.toThrow("确认无效");
  expect((await deliveryOutbox.load(scope(), scan)).entries).toHaveLength(1);
  corrupt = false;
  await remote.retry();
  expect((await deliveryOutbox.load(scope(), scan)).entries).toEqual([]);
  expect((await remote.page(scan)).events).toEqual([original]);
});
