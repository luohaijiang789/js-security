import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { readDeliveryInput } from "../src/plugin-import.js";
import { toDelivery } from "../src/delivery.js";
import { fixture } from "./helpers.js";
test("真实插件目录/JSONL协议导入保留实测身份、重复Query和质量缺口", async (t) => {
  const entry = {
    scan_id: "s",
    request_id: "r",
    request_url: "https://api.test/a?tag=a&tag=b",
    method: "POST",
    query_params: [
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
    ],
    request_headers: [],
    request_body: { representation: "json", parsed: { account: { id: 7 } } },
    capture_status: { stack: { state: "missing", reason: "no frame" } },
  };
  const bytes = Buffer.from(JSON.stringify(entry) + "\n");
  const manifest = {
    schema_version: "0.3.0",
    scan: { id: "s", gaps: [] },
    shards: [
      {
        file: "requests_0001.jsonl",
        count: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const root = await fixture(t, {
    "scan_manifest.json": JSON.stringify(manifest),
    "requests_0001.jsonl": bytes.toString(),
  });
  const input = await readDeliveryInput(root),
    d = toDelivery(input);
  assert.equal(d.records[0].sourceKind, "plugin-observed");
  assert.equal(d.records[0].observation.requestId, "r");
  assert.equal(d.parameters.filter((f) => f.carrier === "query").length, 2);
  assert.ok(d.parameters.some((f) => f.path.join(".") === "account.id"));
  assert.ok(d.gaps.some((g) => g.reason.includes("no frame")));
  assert.equal(d.records[0].carrierStates, null);
  assert.equal(
    (await readDeliveryInput(path.join(root, "requests_0001.jsonl")))
      .observations.length,
    1,
  );
  await fs.appendFile(path.join(root, "requests_0001.jsonl"), " ");
  await assert.rejects(readDeliveryInput(root), /哈希/);
});
test("插件包路径穿越/错误任务和缺失清单拒绝，不产生伪静态记录", async (t) => {
  const root = await fixture(t, {
    "scan_manifest.json": JSON.stringify({
      schema_version: "0.3.0",
      shards: [{ file: "../outside", count: 0 }],
    }),
  });
  await assert.rejects(readDeliveryInput(root), /路径/);
  await assert.rejects(readDeliveryInput(await fixture(t, {})), /任务包/);
});
