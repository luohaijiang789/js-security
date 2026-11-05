import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { CaptureAccounting } from "../src/capture/accounting";

it("batches burst observations, dispatches and rejected events, preserving counters on restart", async () => {
  const first = new CaptureAccounting();
  const saved: Promise<void>[] = [];
  for (let i = 0; i < 1000; i++)
    saved.push(first.note("burst", "Network.requestWillBeSent", "observed"));
  for (let i = 0; i < 900; i++)
    saved.push(first.note("burst", "Network.requestWillBeSent", "dispatched"));
  for (let i = 0; i < 100; i++)
    saved.push(first.note("burst", "Network.requestWillBeSent", "rejected"));
  await first.flush();
  await Promise.all(saved);
  const restarted = new CaptureAccounting();
  expect(await restarted.snapshot("burst")).toEqual({
    scan_id: "burst",
    by_kind: {
      "Network.requestWillBeSent": {
        observed: 1000,
        dispatched: 900,
        rejected: 100,
      },
    },
  });
  const next = restarted.note("burst", "Network.requestWillBeSent", "observed");
  await restarted.flush();
  await next;
  expect(
    (await first.snapshot("burst")).by_kind["Network.requestWillBeSent"]
      .observed,
  ).toBe(1001);
  expect((await first.snapshot("other")).by_kind).toEqual({});
});

it("retains counters after a failed durable transaction and retries them exactly once", async () => {
  const { vi } = await import("vitest");
  const database = await import("../src/storage/evidence-db");
  const fail = vi
    .spyOn(database, "evidenceWrite")
    .mockRejectedValueOnce(Error("disk full"));
  const accounting = new CaptureAccounting();
  const pending = accounting.note(
    "disk-failure",
    "Debugger.scriptParsed",
    "observed",
  );
  const rejected = expect(pending).rejects.toThrow("disk full");
  await expect(accounting.flush()).rejects.toThrow("disk full");
  await rejected;
  fail.mockRestore();
  expect(
    (await accounting.snapshot("disk-failure")).by_kind["Debugger.scriptParsed"]
      .observed,
  ).toBe(1);
  expect(
    (await accounting.snapshot("disk-failure")).by_kind["Debugger.scriptParsed"]
      .observed,
  ).toBe(1);
});
