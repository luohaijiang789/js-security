import type { CapturedBody, RecordEntry } from "./model";
export const SLS_FIELDS = [
  ["request_headers", "请求头", "完整键值对，保留重复字段"],
  ["query_params", "Query 参数", "保留参数顺序、重复字段和空值"],
  ["request_body", "请求体", "解析结构或原文，只保存一份"],
  ["response_headers", "响应头", "仅保存键值对，不重复保存原始头文本"],
  ["response_body", "响应体", "JSON、文本或 Base64，只保存一份"],
  ["page_context", "页面来源", "页面 URL 和 Referer"],
  ["initiator", "发起信息与关系链", "发起脚本、类型及父请求关系"],
  ["initiator_stack", "完整调用栈", "完整同步帧与异步父链，脚本 URL 无损去重"],
  ["network", "基础网络信息", "MIME、协议、远端 IP 和传输大小"],
  ["performance", "性能与缓存细节", "Timing、端口及缓存信息，默认不上传"],
  ["tls", "TLS 证书详情", "完整证书与 SCT 信息，默认不上传"],
  ["capture_status", "采集状态", "区分未采集、空内容、缺失和截断"],
  ["group", "分组信息", "分组 ID 和归一化 URL，不上传内部 group_key"],
  ["internal", "内部调试标识", "CDP 会话、目标、导航标识，默认不上传"],
] as const;
export const DEFAULT_SLS_FIELDS = SLS_FIELDS.map((x) => x[0]).filter(
  (x) => !["performance", "tls", "internal"].includes(x),
);

// Validate JSON tokens before using a parsed representation: duplicate keys and
// high precision numbers must retain their original text instead of losing data.
function safeJson(raw: string): boolean {
  try {
    const tokens =
      raw.match(
        /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g,
      ) ?? [];
    let i = 0;
    function value(): void {
      const t = tokens[i++];
      if (t === "{") {
        const keys = new Set<string>();
        while (tokens[i] !== "}") {
          const key = JSON.parse(tokens[i++]);
          if (keys.has(key)) throw Error("duplicate");
          keys.add(key);
          i++;
          value();
          if (tokens[i] !== ",") break;
          i++;
        }
        i++;
      } else if (t === "[") {
        while (tokens[i] !== "]") {
          value();
          if (tokens[i] !== ",") break;
          i++;
        }
        i++;
      } else if (t && /^-?\d/.test(t)) {
        const significant = t
          .split(/[eE]/)[0]
          .replace(/[^0-9]/g, "")
          .replace(/^0+/, "");
        if (
          !Number.isFinite(Number(t)) ||
          significant.length > 15 ||
          Object.is(Number(t), -0) ||
          (Number(t) === 0 && /[1-9]/.test(t.split(/[eE]/)[0]))
        )
          throw Error("precision");
      }
    }
    JSON.parse(raw);
    value();
    return true;
  } catch {
    return false;
  }
}
export function compactBody(body: CapturedBody) {
  const base = {
    representation: body.representation,
    ...(body.encoding ? { encoding: body.encoding } : {}),
  };
  const structured =
    body.representation === "json" || body.representation === "form";
  let safe = structured;
  if (body.raw !== undefined && body.representation === "json")
    safe = safeJson(body.raw);
  if (body.raw !== undefined && body.representation === "form") {
    try {
      decodeURIComponent(body.raw.replace(/\+/g, " "));
    } catch {
      safe = false;
    }
  }
  if (safe) return { ...base, value_kind: "parsed", value: body.parsed };
  if (body.raw !== undefined)
    return { ...base, value_kind: "raw", value: body.raw };
  return { ...base, value_kind: "unavailable" };
}
export function compactStack(stack: unknown) {
  const scripts: string[] = [],
    indexes = new Map<string, number>();
  function visit(value: any): any {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "url" && typeof item === "string") {
        if (!indexes.has(item)) {
          indexes.set(item, scripts.length);
          scripts.push(item);
        }
        result.url_ref = indexes.get(item);
      } else result[key] = visit(item);
    }
    return result;
  }
  return { scripts, stack: visit(stack) };
}
export function slsProjection(
  record: RecordEntry,
  fields: readonly string[] = DEFAULT_SLS_FIELDS,
) {
  const selected = new Set(fields);
  const result: Record<string, unknown> = {
    schema_version: "sls-2",
    request_timestamp: record.timestamp,
    request_id: record.request_id,
    request_url: record.request_url,
    domain: record.domain,
    pathname: record.pathname,
    method: record.method,
    resource_type: record.resource_type,
    status_code: record.status_code,
    request_state: record.request_state,
    ...(record.error ? { error: record.error } : {}),
  };
  for (const key of [
    "request_headers",
    "query_params",
    "response_headers",
  ] as const)
    if (selected.has(key) && record[key] !== undefined)
      result[key] = record[key];
  for (const key of ["request_body", "response_body"] as const)
    if (selected.has(key) && record[key]) {
      result[key] = compactBody(record[key]!);
      result[
        key === "request_body" ? "content_type" : "response_content_type"
      ] =
        record[
          key === "request_body" ? "content_type" : "response_content_type"
        ];
    }
  if (selected.has("page_context")) {
    result.page_url = record.page_url;
    result.referer = record.referer;
  }
  if (selected.has("initiator")) {
    result.initiator_url = record.initiator_url;
    result.initiator = record.initiator;
    result.initiator_parent_id = record.initiator_parent_id;
    result.initiator_parent_match = record.initiator_parent_match;
    result.initiator_relation = record.initiator_relation;
  }
  if (selected.has("initiator_stack") && record.initiator_stack)
    result.initiator_stack = compactStack(record.initiator_stack);
  const metadata = record.response_metadata;
  if (metadata) {
    if (selected.has("network"))
      for (const key of [
        "mime_type",
        "protocol",
        "remote_ip_address",
        "encoded_data_length",
        "status_text",
      ] as const)
        result[key] = metadata[key];
    if (selected.has("performance"))
      for (const key of [
        "timing",
        "remote_port",
        "from_disk_cache",
        "from_service_worker",
        "from_prefetch_cache",
      ] as const)
        result[key] = metadata[key];
    if (selected.has("tls"))
      result.security_details = metadata.security_details;
  }
  if (selected.has("capture_status")) {
    const statuses: Record<string, unknown> = {};
    const mapping: Record<string, string> = {
      headers: "request_headers",
      body: "request_body",
      response_headers: "response_headers",
      response_body: "response_body",
      response_metadata: "network",
      stack: "initiator_stack",
      page: "page_context",
    };
    for (const [key, status] of Object.entries(record.capture_status)) {
      if (
        !selected.has(mapping[key]) &&
        !(
          key === "response_metadata" &&
          (selected.has("tls") || selected.has("performance"))
        )
      )
        continue;
      statuses[key] = status.state === "complete" ? "complete" : status;
    }
    result.capture_status = statuses;
    result.truncated = record.protection.truncated;
    result.filter_result = record.filter_result;
    result.filter_version = record.filter_version;
  }
  if (selected.has("group")) {
    result.group_id = record.group_id;
    result.normalized_url = record.normalized_url;
  }
  if (selected.has("internal"))
    for (const key of [
      "cdp_request_id",
      "session_id",
      "target_id",
      "loader_id",
      "tab_id",
      "frame_id",
      "redirect_hop",
      "ordinal",
    ] as const)
      result[key] = record[key];
  return result;
}
