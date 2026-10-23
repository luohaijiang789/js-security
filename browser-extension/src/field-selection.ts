import type { Config, RecordEntry } from "./model";

export const OPTIONAL_FIELDS = [
  "request_headers",
  "query_params",
  "request_body",
  "response_headers",
  "response_body",
  "response_metadata",
  "page_context",
  "initiator",
  "initiator_stack",
] as const;

export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

export function savedFieldSet(config: Config) {
  return new Set<OptionalField>(
    (config.saved_fields ?? OPTIONAL_FIELDS) as OptionalField[],
  );
}

const omitted = (name: string) => ({
  state: "unsupported" as const,
  reason: `任务未选择保存${name}`,
});

export function selectRecordFields(record: RecordEntry, config: Config) {
  const selected = savedFieldSet(config);
  const result = structuredClone(record);
  if (!selected.has("request_headers")) {
    result.request_headers = [];
    result.referer = null;
    result.capture_status.headers = omitted("请求头");
  }
  if (!selected.has("query_params")) result.query_params = [];
  if (!selected.has("request_body")) {
    result.request_body = { representation: "unavailable", parsed: null };
    result.content_type = "";
    result.capture_status.body = omitted("请求体");
  }
  if (!selected.has("response_headers")) {
    result.response_headers = [];
    result.response_headers_raw = null;
    result.capture_status.response_headers = omitted("响应头");
  }
  if (!selected.has("response_body")) {
    result.response_body = { representation: "unavailable", parsed: null };
    result.response_content_type = "";
    result.capture_status.response_body = omitted("响应体");
  }
  if (!selected.has("response_metadata")) {
    delete result.response_metadata;
    result.capture_status.response_metadata = omitted("响应元数据");
  }
  if (!selected.has("page_context")) {
    result.page_url = null;
    result.capture_status.page = omitted("页面来源");
  }
  if (!selected.has("initiator")) {
    result.initiator_url = null;
    delete result.initiator;
    result.initiator_parent_id = null;
    result.initiator_parent_match = "none";
    result.initiator_relation = "none";
  }
  if (!selected.has("initiator_stack")) {
    result.initiator_stack = null;
    result.capture_status.stack = omitted("调用栈");
  }
  const retained = JSON.stringify(result);
  result.protection.truncated =
    retained.includes("[已截断，原始 ") || retained.includes("[DEPTH_LIMIT]");
  return result;
}
