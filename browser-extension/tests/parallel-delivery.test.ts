import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { RemoteCapture } from "../src/transport/client";
import { deliveryOutbox } from "../src/transport/outbox";
import type { CaptureEvent } from "../src/domain/evidence";
import { receiverFixture } from "./receiver-fixture";
let receiver: Awaited<ReturnType<typeof receiverFixture>>;
beforeAll(async () => {
  receiver = await receiverFixture();
});
afterAll(async () => {
  await receiver.close();
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const event = (scan: string, n: number): CaptureEvent => ({
  id: `${scan}:${n}`,
  scan_id: scan,
  kind: "ObservedRequest",
  category: "api_request",
  time: new Date().toISOString(),
  session_id: "root",
  epoch: "epoch",
  status: "captured",
  data: { record: { n, value: "字", zero: 0 } },
});
const scope = () => `${new URL(receiver.settings.url).origin}\u0000default`;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected delivery progress did not occur");
}

it("ACKs a small request during an earlier stalled JS upload and seals after the gap fills", async () => {
  const scan = crypto.randomUUID(),
    entered = gate(),
    release = gate();
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).includes("/chunks/")) {
        entered.release();
        await release.promise;
      }
      return fetch(input, init);
    },
  );
  const large = remote.send(event(scan, 1), "x".repeat(1300000));
  try {
    await entered.promise;
    await remote.send(event(scan, 2));
    expect(remote.status(scan)).toMatchObject({
      admitted: 2,
      acknowledged: 1,
      pending: 1,
      contiguous_sequence: 0,
    });
    expect(
      (await deliveryOutbox.descriptors(scope(), scan)).entries.map(
        (row) => row.event.transport.sequence,
      ),
    ).toEqual([1]);
    expect(
      (await remote.page(scan)).events.map((row) => row.data.record.n),
    ).toEqual([2]);
    let sealed = false;
    const seal = remote.seal(scan).then((receipt) => {
      sealed = true;
      return receipt;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sealed).toBe(false);
    release.release();
    await large;
    expect(await seal).toMatchObject({ count: 2, sealed: true });
    expect(remote.status(scan)?.contiguous_sequence).toBe(2);
  } finally {
    release.release();
    await large;
  }
});

it("reserves a small-event lane while three large transfers are blocked", async () => {
  const scan = crypto.randomUUID(),
    release = gate();
  let blocked = 0;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).includes("/chunks/0")) {
        blocked++;
        await release.promise;
      }
      return fetch(input, init);
    },
  );
  const large = Array.from({ length: 4 }, (_, i) =>
    remote.send(event(scan, i + 1), "x".repeat(1300000)),
  );
  try {
    await until(() => blocked === 3);
    await remote.send(event(scan, 5));
    expect(blocked).toBe(3);
    expect(remote.status(scan)).toMatchObject({
      admitted: 5,
      acknowledged: 1,
      pending: 4,
      contiguous_sequence: 0,
    });
    release.release();
    await Promise.all(large);
    expect((await remote.seal(scan))?.count).toBe(5);
  } finally {
    release.release();
    await Promise.allSettled(large);
  }
});

it("restores ACKed later sequences and a failed earlier body without resending cleared payloads", async () => {
  const scan = crypto.randomUUID(),
    entered = gate(),
    release = gate();
  const first = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).includes("/chunks/")) {
        entered.release();
        await release.promise;
        throw Error("body connection lost");
      }
      return fetch(input, init);
    },
  );
  const original = event(scan, 1),
    later = event(scan, 2);
  const failed = first.send(original, "x".repeat(1300000)).then(
    () => {
      throw Error("Unexpected success");
    },
    (error) => error,
  );
  try {
    await entered.promise;
    await first.send(later);
    release.release();
    expect(String(await failed)).toContain("body connection lost");
    await first.drain();
    const stored = await deliveryOutbox.descriptors(scope(), scan);
    expect(stored.ledgers[0]).toMatchObject({
      acknowledged: 1,
      contiguous_sequence: 0,
      acknowledged_ahead: [2],
    });
    expect(stored.entries).toHaveLength(1);
    let posted = 0;
    const restarted = new RemoteCapture(
      () => receiver.settings,
      undefined,
      async (input, init) => {
        if (String(input).endsWith("/events")) posted++;
        return fetch(input, init);
      },
    );
    await restarted.restore(scan);
    await restarted.retry();
    expect(posted).toBe(1);
    expect(restarted.status(scan)).toMatchObject({
      pending: 0,
      acknowledged: 2,
      contiguous_sequence: 2,
    });
    const received = (await restarted.page(scan)).events.sort(
      (a, b) => a.transport!.sequence - b.transport!.sequence,
    );
    expect(received[0]).toMatchObject(original);
    expect(received[0].object_id).toMatch(/^[a-f0-9]{64}$/);
    expect(await restarted.source(received[0].object_id!)).toBe(
      "x".repeat(1300000),
    );
    expect(received[1]).toEqual(later);
    expect((await restarted.seal(scan))?.count).toBe(2);
  } finally {
    release.release();
    await failed;
  }
});

it("falls back to serial delivery for receivers without window support", async () => {
  const scan = crypto.randomUUID(),
    entered = gate(),
    release = gate();
  const modes: unknown[] = [];
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).endsWith("/health"))
        return Response.json({ capabilities: ["delivery-ledger-1"] });
      if (String(input).includes("/chunks/")) {
        entered.release();
        await release.promise;
      }
      if (String(input).endsWith("/events"))
        modes.push(JSON.parse(String(init?.body)).delivery_mode);
      return fetch(input, init);
    },
  );
  const large = remote.send(event(scan, 1), "x".repeat(1300000));
  await entered.promise;
  const small = remote.send(event(scan, 2));
  try {
    await until(() => remote.status(scan)?.admitted === 2);
    expect(modes).toEqual([]);
    release.release();
    await Promise.all([large, small]);
    expect(modes).toEqual([undefined, undefined]);
    expect((await remote.seal(scan))?.count).toBe(2);
  } finally {
    release.release();
    await Promise.allSettled([large, small]);
  }
});

it("stops at the receive window until its earliest gap fills", async () => {
  const scan = crypto.randomUUID(),
    entered = gate(),
    release = gate();
  let highest = 0;
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).includes("/chunks/")) {
        entered.release();
        await release.promise;
      }
      if (String(input).endsWith("/events"))
        highest = Math.max(
          highest,
          JSON.parse(JSON.parse(String(init?.body)).event_json).transport
            .sequence,
        );
      return fetch(input, init);
    },
  );
  const large = remote.send(event(scan, 1), "x".repeat(1300000));
  await entered.promise;
  const small = Array.from({ length: 70 }, (_, i) =>
    remote.send(event(scan, i + 2)),
  );
  try {
    await until(() => remote.status(scan)?.acknowledged === 63);
    expect(highest).toBe(64);
    expect(remote.status(scan)?.contiguous_sequence).toBe(0);
    release.release();
    await Promise.all([large, ...small]);
    expect(remote.status(scan)).toMatchObject({
      admitted: 71,
      acknowledged: 71,
      pending: 0,
      contiguous_sequence: 71,
    });
    expect((await remote.seal(scan))?.count).toBe(71);
  } finally {
    release.release();
    await Promise.allSettled([large, ...small]);
  }
});

it("keeps the production Recorder request and response path moving during a stalled JS upload", async () => {
  const { Recorder } = await import("../src/capture/recorder");
  const { defaults } = await import("../src/domain/model");
  const release = gate(),
    entered = gate();
  const remote = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async (input, init) => {
      if (String(input).includes("/chunks/")) {
        entered.release();
        await release.promise;
      }
      return fetch(input, init);
    },
  );
  const recorder = new Recorder(
    async (_source, method) =>
      method === "Debugger.getScriptSource"
        ? { scriptSource: "x".repeat(1300000) }
        : method === "Network.getResponseBody"
          ? { body: "ok", base64Encoded: false }
          : {},
    remote,
  );
  const scan = await recorder.create(
    "parallel production capture",
    [{ id: 1, url: "https://site.test/" }],
    {
      ...defaults(),
      collect_js: true,
      remote_capture: receiver.settings,
      archive: { ...defaults().archive, enabled: false },
    },
  );
  await recorder.configure({ tabId: 1 });
  try {
    await recorder.event({ tabId: 1 }, "Debugger.scriptParsed", {
      scriptId: "js",
      url: "https://site.test/large.js",
      executionContextId: 1,
    });
    await entered.promise;
    await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "api",
      loaderId: "loader",
      documentURL: "https://site.test/",
      type: "Fetch",
      timestamp: 1,
      wallTime: Date.now() / 1000,
      request: {
        url: "https://site.test/api/fast",
        method: "GET",
        headers: {},
      },
      initiator: {
        type: "script",
        stack: {
          callFrames: [
            {
              functionName: "load",
              scriptId: "js",
              url: "https://site.test/large.js",
              lineNumber: 1,
              columnNumber: 2,
            },
          ],
        },
      },
    });
    await recorder.event({ tabId: 1 }, "Network.responseReceived", {
      requestId: "api",
      type: "Fetch",
      timestamp: 2,
      response: {
        url: "https://site.test/api/fast",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    await recorder.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "api",
      timestamp: 3,
      encodedDataLength: 2,
    });
    await recorder.tail;
    const observed = (await remote.page(scan.id)).events.find(
      (row) => row.kind === "ObservedRequest",
    );
    expect(observed?.data.record.request_url).toBe(
      "https://site.test/api/fast",
    );
    expect(observed?.data.record.response_body.raw).toBe("ok");
    expect(remote.status(scan.id)?.pending).toBe(1);
    release.release();
    await recorder.js.drain();
    await recorder.stop();
    expect(remote.isSealed(scan.id)).toBe(true);
  } finally {
    release.release();
    await recorder.js.drain();
  }
});

it("refuses a corrupted restored prefix without deleting its unconfirmed evidence", async () => {
  const scan = crypto.randomUUID();
  const first = new RemoteCapture(
    () => receiver.settings,
    undefined,
    async () => {
      throw Error("offline");
    },
  );
  await expect(first.send(event(scan, 1))).rejects.toThrow();
  const stored = await deliveryOutbox.descriptors(scope(), scan);
  await deliveryOutbox.ledger({ ...stored.ledgers[0], contiguous_sequence: 1 });
  const restarted = new RemoteCapture(() => receiver.settings);
  await expect(restarted.restore(scan)).rejects.toThrow("连续水位");
  expect(
    (await deliveryOutbox.descriptors(scope(), scan)).entries,
  ).toHaveLength(1);
});

it("renegotiates capabilities when a later task switches receiver", async () => {
  const second = await receiverFixture();
  const entered = gate(),
    release = gate();
  let settings = receiver.settings;
  const remote = new RemoteCapture(
    () => settings,
    undefined,
    async (input, init) => {
      if (String(input) === receiver.settings.url + "/health")
        return Response.json({ capabilities: ["delivery-ledger-1"] });
      if (
        String(input).startsWith(second.settings.url) &&
        String(input).includes("/chunks/")
      ) {
        entered.release();
        await release.promise;
      }
      return fetch(input, init);
    },
  );
  let large: Promise<unknown> | undefined;
  try {
    const firstScan = crypto.randomUUID();
    await remote.send(event(firstScan, 1));
    await remote.seal(firstScan);
    settings = second.settings;
    const secondScan = crypto.randomUUID();
    large = remote.send(event(secondScan, 1), "x".repeat(1300000));
    await entered.promise;
    await remote.send(event(secondScan, 2));
    expect(remote.status(secondScan)).toMatchObject({
      acknowledged: 1,
      pending: 1,
      contiguous_sequence: 0,
    });
    release.release();
    await large;
    expect((await remote.seal(secondScan))?.count).toBe(2);
  } finally {
    release.release();
    await large;
    await second.close();
  }
});
