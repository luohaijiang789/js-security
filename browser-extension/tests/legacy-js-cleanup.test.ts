import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { removeJSScan } from "../src/legacy-js-cleanup";
it("new tasks create no JS database; explicit deletion cleans old observations and preserves other task references", async () => {
  await removeJSScan("missing");
  expect(
    (await indexedDB.databases()).some(
      (d) => d.name === "js-security-js-outbox",
    ),
  ).toBe(false);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("js-security-js-outbox", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("objects", { keyPath: "hash" });
      r.result.createObjectStore("object_meta", { keyPath: "hash" });
      r.result
        .createObjectStore("events", { keyPath: "id" })
        .createIndex("scan", ["scan_id", "id"]);
      r.result.createObjectStore("usage");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = db.transaction(
    ["objects", "object_meta", "events", "usage"],
    "readwrite",
  );
  tx.objectStore("objects").put({ hash: "legacy", source: "old body" });
  tx.objectStore("object_meta").put({ hash: "legacy", bytes: 8, refs: 2 });
  tx.objectStore("events").put({
    id: "a",
    scan_id: "a",
    hash: "legacy",
    bytes: 10,
  });
  tx.objectStore("events").put({
    id: "b",
    scan_id: "b",
    hash: "legacy",
    bytes: 10,
  });
  tx.objectStore("usage").put({ content: 8, metadata: 20 }, "total");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  async function objectCount() {
    const tx = db.transaction("objects");
    return new Promise<number>((resolve, reject) => {
      const r = tx.objectStore("objects").count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  await removeJSScan("a");
  expect(await objectCount()).toBe(1);
  await removeJSScan("b");
  expect(await objectCount()).toBe(0);
  db.close();
});
