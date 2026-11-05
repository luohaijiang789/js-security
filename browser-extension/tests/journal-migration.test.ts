import "fake-indexeddb/auto";
import { expect, it } from "vitest";
it("upgrades v3 without rewriting unconfirmed payloads and creates empty raw-journal stores", async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("js-security-delivery-outbox", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: "key" }).createIndex(
        "stream",
        "stream_id",
      );
      db.createObjectStore("payloads", { keyPath: "key" });
      db.createObjectStore("ledgers", { keyPath: "stream_id" }).createIndex(
        "scope_scan",
        ["scope", "scan_id"],
      );
      db.createObjectStore("capture_counters", { keyPath: "scan_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const original = {
    key: "old-v3",
    event: { id: "old", data: { body: "完整字😀" } },
    source: "unconfirmed body",
  };
  await new Promise<void>((resolve) => {
    const tx = old.transaction("payloads", "readwrite");
    tx.objectStore("payloads").put(original);
    tx.oncomplete = () => resolve();
  });
  old.close();
  const { evidenceDatabase } = await import("../src/storage/evidence-db");
  const db = await evidenceDatabase();
  expect(db.version).toBe(4);
  const { deliveryOutbox } = await import("../src/transport/outbox");
  expect(await deliveryOutbox.entry("old-v3")).toEqual(original);
  const { journalSnapshot } = await import("../src/storage/capture-journal");
  expect(await journalSnapshot("old")).toMatchObject({
    admitted: 0,
    pending: 0,
    handed_off: 0,
  });
});
