import type { InitiatorGraph, Pair, Quality, RecordEntry } from "./model";

export const stateLabels: Record<string, string> = {
  recording: "采集中",
  paused: "已暂停",
  draining: "正在收尾",
  ended: "已结束",
  interrupted: "已中断",
};
export const qualityLabels: Record<Quality["state"], string> = {
  complete: "完整",
  partial: "部分",
  missing: "缺失",
  unsupported: "未支持",
  unparseable: "解析失败",
};

export function timeText(value?: string, short = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(short ? {} : { month: "2-digit", day: "2-digit" }),
  }).format(d);
}
export function bytesText(value = 0) {
  if (!Number.isFinite(value) || value < 0) return "未知";
  return value >= 1048576
    ? (value / 1048576).toFixed(1) + " MB"
    : value >= 1024
      ? (value / 1024).toFixed(1) + " KB"
      : value + " B";
}
type RequestState = { request_state?: string; status_code?: number | null };
const requestStateLabels: Record<string, string> = {
  pending: "进行中",
  failed: "失败",
  incomplete: "未完成",
  redirect: "重定向",
  complete: "完成",
  unknown: "未知",
};
export function statusText(r: RequestState) {
  const code =
    typeof r.status_code === "number" &&
    Number.isFinite(r.status_code) &&
    r.status_code >= 100
      ? String(r.status_code)
      : "";
  const label = requestStateLabels[r.request_state ?? "unknown"] ?? "未知";
  // Receiving response headers does not imply that the transfer completed.
  if (
    code &&
    ["failed", "incomplete", "pending"].includes(r.request_state ?? "")
  )
    return code + " · " + label;
  return code || label;
}
export function statusTone(r: RequestState) {
  if (r.request_state === "failed" || (r.status_code ?? 0) >= 400)
    return "danger";
  if (r.request_state === "incomplete" || r.request_state === "pending")
    return "warning";
  if ((r.status_code ?? 0) >= 300 || r.request_state === "redirect")
    return "muted";
  return (r.status_code ?? 0) >= 100 || r.request_state === "complete"
    ? "success"
    : "muted";
}
export type DisplayFrame = {
  scriptId: string;
  url: string;
  functionName: string;
  lineNumber: number | null;
  columnNumber: number | null;
  async: boolean;
};
export type StackSegment = {
  description: string;
  async: boolean;
  frames: DisplayFrame[];
  parentId: { id: string; debuggerId?: string } | null;
  warning: string;
};
export function stackSegments(stack: unknown): StackSegment[] {
  const result: StackSegment[] = [],
    seen = new Set<unknown>();
  let current: any = stack,
    depth = 0;
  while (current && typeof current === "object") {
    if (seen.has(current) || depth > 33) {
      result.push({
        description: "未展开的父栈",
        async: true,
        frames: [],
        parentId: null,
        warning: seen.has(current)
          ? "异步调用栈包含循环引用"
          : "异步调用栈超过展示深度上限",
      });
      break;
    }
    seen.add(current);
    const coordinate = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
    const parentId =
      typeof current.parentId?.id === "string" ? current.parentId : null;
    result.push({
      description:
        typeof current.description === "string"
          ? current.description
          : depth
            ? "异步父栈"
            : "当前调用栈",
      async: depth > 0,
      frames: (Array.isArray(current.callFrames) ? current.callFrames : [])
        .filter((f: any) => f && typeof f === "object")
        .map((f: any) => ({
          scriptId: typeof f.scriptId === "string" ? f.scriptId : "",
          url: typeof f.url === "string" ? f.url : "",
          functionName:
            typeof f.functionName === "string" ? f.functionName : "",
          lineNumber: coordinate(f.lineNumber),
          columnNumber: coordinate(f.columnNumber),
          async: depth > 0,
        })),
      parentId,
      warning:
        typeof current.truncated_reason === "string"
          ? current.truncated_reason
          : parentId && !current.parent
            ? "异步父栈标识已保存，但对应栈帧未取得"
            : "",
    });
    current = current.parent;
    depth++;
  }
  return result;
}
export function frames(stack: unknown): DisplayFrame[] {
  return stackSegments(stack).flatMap((segment) => segment.frames);
}
export function frameLocation(frame: DisplayFrame) {
  const position =
    frame.lineNumber === null
      ? "行号未知"
      : String(frame.lineNumber + 1) +
        (frame.columnNumber === null
          ? ":列号未知"
          : ":" + (frame.columnNumber + 1));
  return (frame.url || "未知脚本") + ":" + position;
}
export function shortFrameLocation(frame: DisplayFrame) {
  let file = frame.url;
  try {
    const url = new URL(frame.url);
    file =
      url.pathname.split("/").filter(Boolean).at(-1) || url.host || frame.url;
  } catch {
    file = frame.url.split(/[?#]/, 1)[0].split("/").at(-1) || frame.url;
  }
  return frameLocation({ ...frame, url: file });
}
export type InitiatorChainDisplay = {
  nodes: Array<{
    request_id: string;
    request_url: string;
    parent_id: string | null;
    current: boolean;
    depth: number;
    inferred: boolean;
    relation: string;
  }>;
  warning: string;
  truncated: boolean;
};
export function initiatorChainForDisplay(
  record: RecordEntry,
  graph?: InitiatorGraph | null,
): InitiatorChainDisplay {
  const nodes: InitiatorChainDisplay["nodes"] = (
    Array.isArray(graph?.nodes) ? graph.nodes : []
  )
    .filter((node: any) => node && typeof node.request_url === "string")
    .map((node: any) => ({
      request_id: typeof node.request_id === "string" ? node.request_id : "",
      request_url: node.request_url,
      parent_id: typeof node.parent_id === "string" ? node.parent_id : null,
      current: node.current === true || node.request_id === record.request_id,
      depth:
        typeof node.depth === "number" &&
        Number.isInteger(node.depth) &&
        node.depth >= 0
          ? node.depth
          : 0,
      inferred: node.resolution === "inferred",
      relation: typeof node.relation === "string" ? node.relation : "",
    }));
  if (!nodes.some((node) => node.current))
    nodes.push({
      request_id: record.request_id,
      request_url: record.request_url,
      parent_id: null,
      current: true,
      depth: 0,
      inferred: false,
      relation: "current",
    });
  return {
    nodes,
    warning:
      typeof graph?.warning === "string"
        ? graph.warning
        : nodes.length <= 1
          ? "没有可用的请求发起链。"
          : "",
    truncated: graph?.truncated === true,
  };
}
export function pretty(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "无法序列化此值；请检查原始记录结构。";
  }
}

type DisplayRecord = Omit<
  RecordEntry,
  | "request_state"
  | "response_headers"
  | "response_headers_raw"
  | "response_body"
  | "response_content_type"
  | "response_metadata"
  | "capture_status"
> & {
  request_state: RecordEntry["request_state"] | "unknown";
  response_headers: NonNullable<RecordEntry["response_headers"]>;
  response_headers_raw: string | null;
  response_body: NonNullable<RecordEntry["response_body"]>;
  response_content_type: string;
  response_metadata: NonNullable<RecordEntry["response_metadata"]>;
  capture_status: Required<RecordEntry["capture_status"]>;
};
function pairList(value: unknown): Pair[] {
  return Array.isArray(value)
    ? value
        .filter((v) => v && typeof v === "object")
        .map((v) => ({
          name: typeof v.name === "string" ? v.name : String(v.name ?? ""),
          value:
            typeof v.value === "string"
              ? v.value
              : v.value === undefined
                ? "未取得"
                : pretty(v.value),
        }))
    : [];
}
function quality(value: unknown): Quality {
  const q = value as Partial<Quality> | null;
  if (
    !q ||
    typeof q !== "object" ||
    !["complete", "partial", "missing", "unsupported", "unparseable"].includes(
      q.state ?? "",
    )
  )
    return {
      state: "missing",
      reason: "旧记录未保存此字段的采集状态，不能判断完整性。",
    };
  return {
    state: q.state as Quality["state"],
    reason: typeof q.reason === "string" ? q.reason : undefined,
  };
}
// Display fallbacks keep older/partial records inspectable. Raw JSON and export continue to use the stored record.
export function recordForDisplay(source: RecordEntry): DisplayRecord {
  const r = source as Partial<RecordEntry>,
    q = r.capture_status;
  return {
    ...source,
    scan_id: r.scan_id ?? "未知",
    request_id: r.request_id ?? "未知",
    cdp_request_id: r.cdp_request_id ?? "未知",
    session_id: r.session_id ?? "未知",
    target_id: r.target_id ?? null,
    redirect_hop: r.redirect_hop ?? 0,
    timestamp: r.timestamp ?? "",
    tab_id: r.tab_id ?? -1,
    frame_id: r.frame_id ?? null,
    page_url: r.page_url ?? null,
    referer: r.referer ?? null,
    request_url: r.request_url ?? "未保存请求 URL",
    domain: r.domain ?? "未知",
    pathname: r.pathname ?? "",
    method: r.method || "未知",
    resource_type: r.resource_type ?? "未知",
    status_code:
      typeof r.status_code === "number" && Number.isFinite(r.status_code)
        ? r.status_code
        : null,
    request_state: [
      "pending",
      "complete",
      "failed",
      "incomplete",
      "redirect",
    ].includes(r.request_state ?? "")
      ? r.request_state!
      : "unknown",
    request_headers: pairList(r.request_headers),
    query_params: Array.isArray(r.query_params)
      ? pairList(r.query_params)
      : (() => {
          try {
            return [...new URL(r.request_url ?? "").searchParams].map(
              ([name, value]) => ({ name, value }),
            );
          } catch {
            return [];
          }
        })(),
    request_body:
      r.request_body && typeof r.request_body === "object"
        ? {
            ...r.request_body,
            representation: r.request_body.representation ?? "未知",
            parsed: r.request_body.parsed ?? null,
          }
        : { representation: "未保存", parsed: null },
    content_type: r.content_type ?? "",
    response_headers: pairList(r.response_headers),
    response_headers_raw:
      typeof r.response_headers_raw === "string"
        ? r.response_headers_raw
        : null,
    response_body:
      r.response_body && typeof r.response_body === "object"
        ? {
            ...r.response_body,
            representation: r.response_body.representation ?? "未知",
            parsed: r.response_body.parsed ?? null,
          }
        : { representation: "未保存", parsed: null },
    response_content_type: r.response_content_type ?? "",
    response_metadata: r.response_metadata ?? {
      status_text: "",
      mime_type: "",
      protocol: "",
      remote_ip_address: "",
      remote_port: null,
      from_disk_cache: false,
      from_service_worker: false,
      from_prefetch_cache: false,
      encoded_data_length: null,
      timing: null,
      security_details: null,
    },
    initiator_url: r.initiator_url ?? null,
    initiator_stack: r.initiator_stack ?? null,
    capture_status: {
      headers: quality(q?.headers),
      body: quality(q?.body),
      response_headers: quality(q?.response_headers),
      response_body: quality(q?.response_body),
      response_metadata: quality(q?.response_metadata),
      stack: quality(q?.stack),
      page: quality(q?.page),
    },
    protection: r.protection ?? {
      version: "未知",
      redacted: false,
      truncated: false,
    },
    filter_version: r.filter_version ?? 0,
  };
}

export function bodyContentAvailable(
  body: RecordEntry["request_body"] | null | undefined,
) {
  if (!body || typeof body !== "object") return false;
  return (
    typeof body.raw === "string" ||
    (Object.hasOwn(body, "parsed") &&
      body.parsed !== undefined &&
      (body.parsed !== null || body.representation === "json"))
  );
}
export function unresolvedStackParent(stack: unknown) {
  return stackSegments(stack).some((segment) => !!segment.warning);
}
