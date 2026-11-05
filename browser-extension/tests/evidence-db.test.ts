import "fake-indexeddb/auto";
import { expect, it } from "vitest";

it("migrates unconfirmed v1 bodies without loading them in recovery descriptors", async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("js-security-delivery-outbox", 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("entries", { keyPath: "key" })
        .createIndex("stream", "stream_id");
      request.result
        .createObjectStore("ledgers", { keyPath: "stream_id" })
        .createIndex("scope_scan", ["scope", "scan_id"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const entry = {
    key: "v1-row",
    stream_id: "v1-stream",
    source: "完整正文".repeat(10000),
    event: { id: "v1", data: { record: { url: "/api" } } },
  };
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction(["entries", "ledgers"], "readwrite");
    tx.objectStore("entries").put(entry);
    tx.objectStore("ledgers").put({
      stream_id: "v1-stream",
      scope: "origin",
      scan_id: "scan",
      admitted: 1,
    });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  old.close();
  const { deliveryOutbox } = await import("../src/transport/outbox");
  const restored = await deliveryOutbox.descriptors("origin", "scan");
  expect(restored.ledgers[0].admitted).toBe(1);
  expect(restored.entries).toEqual([
    {
      key: "v1-row",
      stream_id: "v1-stream",
      persisted: true,
      hydrated: false,
      event: { id: "v1", data: {} },
    },
  ]);
  expect(await deliveryOutbox.entry(entry.key)).toEqual(entry);
  await deliveryOutbox.confirm(entry.key, restored.ledgers[0]);
  expect(await deliveryOutbox.entry(entry.key)).toBeUndefined();
  expect((await deliveryOutbox.descriptors("origin", "scan")).entries).toEqual(
    [],
  );
});
