import type { Config } from "./model";
import { validateFilter } from "./filter";
export function validateConfig(c: Config) {
  validateFilter(c.filter);
  if (
    !["matching", "all"].includes(c.retention) ||
    !["none", "exact", "normalized", "representative"].includes(c.merge)
  )
    throw Error("非法留存或归并模式");
  for (const [k, min, max] of [
    ["body_limit", 1024, 10485760],
    ["queue_count", 10, 10000],
    ["queue_bytes", 1024, 67108864],
    ["stop_wait_ms", 0, 60000],
    ["storage_limit", 1048576, 10737418240],
    ["retention_days", 1, 3650],
  ] as const) {
    if (!Number.isInteger(c[k]) || c[k] < min || c[k] > max)
      throw Error(`配置 ${k} 超出范围 ${min}～${max}`);
  }
  for (const list of [c.dynamic_query, c.dynamic_json])
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string"))
      throw Error("动态参数必须为字符串数组");
  if (
    !c.archive ||
    typeof c.archive.enabled !== "boolean" ||
    !Number.isInteger(c.archive.interval_ms) ||
    c.archive.interval_ms < 30000 ||
    !Number.isInteger(c.archive.bytes) ||
    c.archive.bytes < 1024 ||
    c.archive.bytes > 20971520 ||
    !Number.isInteger(c.archive.count) ||
    c.archive.count < 1 ||
    c.archive.count > 10000
  )
    throw Error("归档配置无效：间隔 ≥30 秒，分片 ≤20 MB，数量 ≤10000");
  if (
    !c.service ||
    typeof c.service.enabled !== "boolean" ||
    !Number.isInteger(c.service.batch_size) ||
    c.service.batch_size < 1 ||
    c.service.batch_size > 1000
  )
    throw Error("转存配置无效");
  if (
    c.service.interval_ms !== undefined &&
    (!Number.isInteger(c.service.interval_ms) || c.service.interval_ms < 1000)
  )
    throw Error("服务转存间隔必须至少 1000 ms");
  if (
    c.service.compress !== undefined &&
    typeof c.service.compress !== "boolean"
  )
    throw Error("服务压缩须为布尔值");
  if (c.service.enabled) {
    const u = new URL(c.service.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    )
      throw Error("服务须为无凭据、无 query/fragment 的 HTTPS 地址");
  }
}
