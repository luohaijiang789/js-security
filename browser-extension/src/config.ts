import type { Config, SlsConfig } from "./model";
import { validateFilter } from "./filter";
import { OPTIONAL_FIELDS } from "./field-selection";
export function validateSlsConfig(sls: SlsConfig | undefined) {
  if (!sls) return;
  if (
    typeof sls.enabled !== "boolean" ||
    !["sts", "web_tracking"].includes(sls.mode) ||
    !Number.isInteger(sls.batch_size) ||
    sls.batch_size < 1 ||
    sls.batch_size > 1000 ||
    !Number.isInteger(sls.batch_bytes) ||
    sls.batch_bytes < 256 * 1024 ||
    sls.batch_bytes > 3 * 1024 * 1024 ||
    !Number.isInteger(sls.interval_ms) ||
    sls.interval_ms < 1000
  )
    throw Error("SLS 配置无效：批次 1～1000 条、256 KB～3 MB，间隔至少 1 秒");
  if (!sls.enabled) return;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(sls.project))
    throw Error("SLS Project 名称无效");
  if (!/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(sls.logstore))
    throw Error("SLS Logstore 名称无效");
  const endpoint = sls.endpoint.trim().replace(/\/+$/, "");
  if (!endpoint) throw Error("请填写 SLS Endpoint");
  if (/^https:\/\//i.test(endpoint)) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw Error("SLS 自定义 Endpoint 必须是无路径、凭据和参数的 HTTPS 地址");
  } else if (endpoint.includes("/") || !/^[A-Za-z0-9.-]+$/.test(endpoint))
    throw Error("SLS Endpoint 应类似 cn-hangzhou.log.aliyuncs.com");
  else if (endpoint.toLowerCase().startsWith(sls.project + "."))
    throw Error("SLS Endpoint 不要重复包含 Project；Project 请单独填写");
  if (
    typeof sls.topic !== "string" ||
    typeof sls.source !== "string" ||
    sls.topic.length > 128 ||
    sls.source.length > 128
  )
    throw Error("SLS Topic 和 Source 必须是不超过 128 字符的字符串");
}
export function validateConfig(c: Config) {
  validateFilter(c.filter);
  if (
    !["matching", "all"].includes(c.retention) ||
    (c.value_storage !== undefined &&
      !["complete", "truncate"].includes(c.value_storage)) ||
    !["none", "exact", "normalized", "representative"].includes(c.merge)
  )
    throw Error("非法留存、字段值保存或归并模式");
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
    c.saved_fields !== undefined &&
    (!Array.isArray(c.saved_fields) ||
      new Set(c.saved_fields).size !== c.saved_fields.length ||
      c.saved_fields.some(
        (field) => !(OPTIONAL_FIELDS as readonly string[]).includes(field),
      ))
  )
    throw Error("保存字段配置无效");
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
  validateSlsConfig(c.sls);
}
