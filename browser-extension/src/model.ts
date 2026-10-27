import { DEFAULT_SLS_FIELDS } from "./sls-fields";
export type Quality = {
  state: "complete" | "partial" | "missing" | "unsupported" | "unparseable";
  reason?: string;
};
export type Pair = { name: string; value: string };
export type CapturedBody = {
  representation: string;
  parsed: unknown;
  raw?: string;
  encoding?: "utf8" | "base64";
};
export type ResponseMetadata = {
  status_text: string;
  mime_type: string;
  protocol: string;
  remote_ip_address: string;
  remote_port: number | null;
  from_disk_cache: boolean;
  from_service_worker: boolean;
  from_prefetch_cache: boolean;
  encoded_data_length: number | null;
  timing: unknown | null;
  security_details: unknown | null;
  resource_ip_address_space?: string;
  blocked_cookies?: unknown[];
};
export type Rule =
  | { op: "and" | "or" | "not"; rules: Rule[] }
  | {
      field: string;
      operator: string;
      values?: string[];
      key?: string;
      case_sensitive?: boolean;
    };
export type Filter = { scope?: Rule; include?: Rule; exclude?: Rule };
export type SlsConfig = {
  upload_fields?: string[];
  enabled: boolean;
  mode: "sts" | "web_tracking";
  endpoint: string;
  project: string;
  logstore: string;
  topic: string;
  source: string;
  batch_size: number;
  batch_bytes: number;
  interval_ms: number;
};
export type SlsCredentials = {
  access_key_id: string;
  access_key_secret: string;
  /** Required for STS temporary credentials; absent for a long-lived AccessKey. */
  security_token?: string;
};
export type Config = {
  filter: Filter;
  retention: "matching" | "all";
  /** Missing on legacy tasks means truncate. */
  value_storage?: "complete" | "truncate";
  /** Missing on legacy tasks means every optional field. */
  saved_fields?: string[];
  merge: "none" | "exact" | "normalized" | "representative";
  dynamic_query: string[];
  dynamic_json: string[];
  uuid_path: boolean;
  same_initiator: boolean;
  body_limit: number;
  queue_count: number;
  queue_bytes: number;
  stop_wait_ms: number;
  storage_limit: number;
  archive: {
    enabled: boolean;
    interval_ms: number;
    bytes: number;
    count: number;
  };
  service: {
    enabled: boolean;
    url: string;
    batch_size: number;
    interval_ms?: number;
    compress?: boolean;
  };
  /** Missing on tasks created before SLS transfer support. */
  sls?: SlsConfig;
  retention_days: number;
};
export const defaults = (): Config => ({
  filter: {},
  retention: "matching",
  value_storage: "truncate",
  saved_fields: [
    "request_headers",
    "query_params",
    "request_body",
    "response_headers",
    "response_body",
    "response_metadata",
    "page_context",
    "initiator",
    "initiator_stack",
  ],
  merge: "normalized",
  dynamic_query: [],
  dynamic_json: [],
  uuid_path: false,
  same_initiator: false,
  body_limit: 1024 * 1024,
  queue_count: 2000,
  queue_bytes: 16 * 1024 * 1024,
  stop_wait_ms: 5000,
  storage_limit: 500 * 1024 * 1024,
  archive: {
    enabled: true,
    interval_ms: 300000,
    bytes: 20 * 1024 * 1024,
    count: 10000,
  },
  service: {
    enabled: false,
    url: "",
    batch_size: 200,
    interval_ms: 5000,
    compress: false,
  },
  sls: {
    upload_fields: [...DEFAULT_SLS_FIELDS],
    enabled: false,
    mode: "sts",
    endpoint: "",
    project: "",
    logstore: "",
    topic: "js-security-request",
    source: "browser-extension",
    batch_size: 100,
    batch_bytes: 2 * 1024 * 1024,
    interval_ms: 10000,
  },
  retention_days: 7,
});
export type RecordEntry = {
  scan_id: string;
  request_id: string;
  cdp_request_id: string;
  session_id: string;
  target_id: string | null;
  redirect_hop: number;
  timestamp: string;
  tab_id: number;
  frame_id: string | null;
  /** CDP loader identity used to keep initiator inference inside one navigation. */
  loader_id?: string | null;
  page_url: string | null;
  referer: string | null;
  request_url: string;
  domain: string;
  pathname: string;
  method: string;
  resource_type: string;
  status_code: number | null;
  request_state: "pending" | "complete" | "failed" | "incomplete" | "redirect";
  error?: string;
  request_headers: Pair[];
  query_params: Pair[];
  request_body: CapturedBody;
  content_type: string;
  /** Missing on records created before response capture was introduced. */
  response_headers?: Pair[];
  response_headers_raw?: string | null;
  response_body?: CapturedBody;
  response_content_type?: string;
  response_metadata?: ResponseMetadata;
  initiator_url: string | null;
  initiator_stack: unknown;
  /** Protected subset of Network.Initiator. Missing on legacy records. */
  initiator?: {
    type: string;
    url: string | null;
    request_id?: string | null;
    line_number?: number;
    column_number?: number;
  };
  /** Recorder request id, rather than the shorter CDP request id. */
  initiator_parent_id?: string | null;
  initiator_parent_match?: InitiatorParentMatch;
  initiator_relation?: InitiatorRelation;
  capture_status: {
    headers: Quality;
    body: Quality;
    response_headers?: Quality;
    response_body?: Quality;
    response_metadata?: Quality;
    stack: Quality;
    page: Quality;
  };
  protection: { version: string; redacted: boolean; truncated: boolean };
  filter_version: number;
  filter_result?: "matched" | "excluded" | "unknown";
  ordinal?: number;
  group_id?: string;
  group_key?: string;
  normalized_url?: string;
};
export type InitiatorParentMatch =
  "redirect" | "exact" | "inferred" | "ambiguous" | "missing" | "none";
export type InitiatorRelation =
  "redirect" | "preflight" | "request-id" | "initiator-url" | "none";
export type InitiatorGraphNode = {
  request_id: string;
  request_url: string;
  parent_id: string | null;
  current: boolean;
  depth: number;
  resolution: InitiatorParentMatch;
  relation: InitiatorRelation;
};
export type InitiatorGraph = {
  nodes: InitiatorGraphNode[];
  warning: string;
  truncated: boolean;
};
export type InitiatorNode = {
  scan_id: string;
  request_id: string;
  request_url: string;
  parent_id: string | null;
  resolution: InitiatorParentMatch;
  relation: InitiatorRelation;
};
export type CaptureError = {
  id: string;
  scan_id: string;
  timestamp: string;
  type: string;
  reason: string;
  request_id?: string;
  count?: number;
  end?: string;
};
export type Scan = {
  id: string;
  name: string;
  state: "recording" | "paused" | "draining" | "ended" | "interrupted";
  started_at: string;
  ended_at?: string;
  heartbeat: string;
  /** Missing on legacy tasks: keep their explicitly selected scope. */
  tab_scope?: "all" | "selected";
  tabs: { id: number; url: string }[];
  versions: { version: number; effective_at: string; config: Config }[];
  config: Config;
  browser: string;
  plugin: string;
  stats: {
    observed: number;
    pending: number;
    matched: number;
    excluded: number;
    unknown: number;
    persisted: number;
    groups: number;
    bytes: number;
    lost: number;
  };
  gaps: CaptureError[];
  rule_hits: Record<string, number>;
  integrity: "observed_scope" | "gaps";
};
export type Group = {
  id: string;
  scan_id: string;
  key: string;
  representative_id: string;
  normalized_url: string;
  count: number;
  first: string;
  last: string;
  candidate: boolean;
  changes: string[];
};
export type Batch = {
  sls_schema?: "sls-2";
  id: string;
  scan_id: string;
  channel: "file" | "service" | "sls";
  state: "pending" | "downloading" | "complete" | "failed";
  records: string[];
  attempts: number;
  next_retry: number;
  created_at: string;
  download_id?: number;
  error?: string;
  filename?: string;
  last_ordinal?: number;
  receiver_url?: string;
  compressed?: boolean;
  sls?: SlsConfig;
  receipt?: string;
};
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export function gap(
  scan: Scan,
  type: string,
  reason: string,
  request_id?: string,
  count?: number,
): CaptureError {
  scan.integrity = "gaps";
  const last = scan.gaps.at(-1);
  if (
    !request_id &&
    last?.type === type &&
    last.reason === reason &&
    !last.request_id
  ) {
    last.count = (last.count ?? 1) + (count ?? 1);
    last.end = now();
    return last;
  }
  const g: CaptureError = {
    id: uid(),
    scan_id: scan.id,
    timestamp: now(),
    type,
    reason,
    request_id,
    count,
  };
  scan.gaps.push(g);
  return g;
}
