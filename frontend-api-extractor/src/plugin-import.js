import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export async function readDeliveryInput(input) {
  const stat = await fs.stat(input);
  if (!stat.isDirectory()) {
    if (stat.size > 64 * 1024 * 1024) throw new Error("输入超过64MiB");
    const text = await fs.readFile(input, "utf8");
    return input.endsWith(".jsonl")
      ? { observations: text.split(/\r?\n/).filter(Boolean).map(JSON.parse) }
      : JSON.parse(text);
  }
  const root = await fs.realpath(input);
  let manifest;
  for (const name of ["scan_manifest.json", "manifest.json"])
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  if (
    !manifest ||
    !["0.1.0", "0.3.0"].includes(manifest.schema_version) ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length > 1000
  )
    throw new Error("不支持的插件任务包");
  const observations = [];
  let total = 0;
  for (const shard of manifest.shards) {
    if (
      typeof shard.file !== "string" ||
      path.isAbsolute(shard.file) ||
      shard.file.split(/[\\/]/).some((p) => p === ".." || !p)
    )
      throw new Error("分片路径无效");
    const file = await fs.realpath(path.join(root, shard.file));
    if (!file.startsWith(root + path.sep))
      throw new Error("分片越过任务包目录");
    const size = (await fs.stat(file)).size;
    total += size;
    if (total > 64 * 1024 * 1024) throw new Error("插件包超过64MiB");
    const bytes = await fs.readFile(file);
    if (
      shard.sha256 &&
      createHash("sha256").update(bytes).digest("hex") !== shard.sha256
    )
      throw new Error("插件分片哈希不匹配");
    const rows = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    if (rows.length !== shard.count) throw new Error("插件分片数量不匹配");
    if (manifest.scan?.id && rows.some((r) => r.scan_id !== manifest.scan.id))
      throw new Error("分片任务ID不一致");
    observations.push(...rows);
  }
  return {
    observations,
    pluginManifest: manifest,
    diagnostics: (manifest.scan?.gaps ?? []).map((g) => ({
      code: "CAPTURE_GAP",
      message: g.reason,
    })),
    gaps: manifest.lossy ? ["插件包使用代表项归并，原始观察可能缺失"] : [],
  };
}
