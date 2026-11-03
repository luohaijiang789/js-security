import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { AssetIndex, listAssets } from "../src/asset-index";

it("keeps only lightweight project+URL metadata and reuses the sent marker", async () => {
  const index = new AssetIndex();
  await index.load("asset-test-project");
  expect(index.get("asset-test-project", "https://a.test/x.js")).toBeUndefined();
  index.observe("asset-test-project", "js", "https://a.test/x.js", "a.test", {
    sent: false,
  });
  index.observe("asset-test-project", "js", "https://a.test/x.js", "a.test", {
    sent: true,
    object_id: "a".repeat(64),
    bytes: 10,
  });
  expect(index.get("asset-test-project", "https://a.test/x.js")).toMatchObject({
    count: 2,
    sent: true,
    bytes: 10,
    host: "a.test",
  });
  await index.flush();
  const rows = await listAssets("asset-test-project");
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]).sort()).toEqual([
    "bytes",
    "count",
    "first_seen",
    "host",
    "key",
    "kind",
    "last_seen",
    "object_id",
    "project",
    "sent",
    "url",
  ]);
  const reopened = new AssetIndex();
  await reopened.load("asset-test-project");
  expect(reopened.get("asset-test-project", "https://a.test/x.js")?.object_id).toBe(
    "a".repeat(64),
  );
});