export type Quality = {
  state: "complete" | "partial" | "missing" | "unsupported" | "unparseable";
  reason?: string;
};
export type Pair = { name: string; value: string };
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
export type Config = {
  filter: Filter;
  retention: "matching" | "all";
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
  retention_days: number;
};
export const defaults = (): Config => ({
  filter: {},
  retention: "matching",
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
  request_body: { representation: string; parsed: unknown; raw?: string };
  content_type: string;
  initiator_url: string | null;
  initiator_stack: unknown;
  capture_status: {
    headers: Quality;
    body: Quality;
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
  id: string;
  scan_id: string;
  channel: "file" | "service";
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
