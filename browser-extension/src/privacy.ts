import type { Pair, RecordEntry } from "./model";
export const REDACTED = "[REDACTED]";
const sensitive =
  /(cookie|authorization|token|secret|password|passwd|credential|api[-_]?key|session|cna|account[-_]?id|tenant[-_]?id|^uid$)/i;
function limitDepth(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) return value.map((x) => limitDepth(x, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, limitDepth(v, depth + 1)]),
    );
  return value;
}
export function protectValue(v: unknown, depth = 0): unknown {
  if (depth > 32) return "[DEPTH_LIMIT]";
  if (Array.isArray(v)) return v.map((x) => protectValue(x, depth + 1));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        sensitive.test(k) ? REDACTED : protectValue(x, depth + 1),
      ]),
    );
  return v;
}
export function protectPairs(p: Pair[]): Pair[] {
  return p.map((x) => ({
    ...x,
    value: sensitive.test(x.name) ? REDACTED : x.value,
  }));
}
export function safeURL(s: string): string {
  try {
    const u = new URL(s);
    u.username = "";
    u.password = "";
    u.hash = "";
    const pairs = [...u.searchParams];
    u.search = "";
    for (const [k, v] of pairs)
      u.searchParams.append(k, sensitive.test(k) ? REDACTED : v);
    return u.href;
  } catch {
    return "[INVALID_URL]";
  }
}
export function parseBody(
  raw: string | undefined,
  contentType: string,
  hasBody: boolean,
  limit: number,
  protect = true,
): {
  body: RecordEntry["request_body"];
  quality: RecordEntry["capture_status"]["body"];
  truncated: boolean;
} {
  if (raw === undefined)
    return {
      body: { representation: "unavailable", parsed: null },
      quality: hasBody
        ? { state: "missing", reason: "CDP 未提供正文" }
        : { state: "complete", reason: "未报告正文" },
      truncated: false,
    };
  if (new TextEncoder().encode(raw).length > limit)
    return {
      body: { representation: "omitted", parsed: null },
      quality: { state: "partial", reason: "正文超过字节上限，未持久化原值" },
      truncated: true,
    };
  try {
    if (contentType.includes("json")) {
      const limited = limitDepth(JSON.parse(raw));
      const truncated = JSON.stringify(limited).includes("[DEPTH_LIMIT]");
      return {
        body: {
          representation: "json",
          parsed: protect ? protectValue(limited) : limited,
        },
        quality: truncated
          ? { state: "partial", reason: "JSON 解析深度超过 32 层" }
          : { state: "complete" },
        truncated,
      };
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const pairs = [...new URLSearchParams(raw)].map(([name, value]) => ({
        name,
        value,
      }));
      return {
        body: {
          representation: "form",
          parsed: protect ? protectPairs(pairs) : pairs,
        },
        quality: { state: "complete" },
        truncated: false,
      };
    }
    return {
      body: {
        representation: contentType.includes("multipart")
          ? "multipart"
          : "text",
        parsed: null,
      },
      quality: {
        state: "unsupported",
        reason: "不持久化未结构化文本、二进制或文件原值",
      },
      truncated: false,
    };
  } catch {
    return {
      body: { representation: "unparseable", parsed: null },
      quality: { state: "unparseable", reason: "正文解析失败，未持久化原值" },
      truncated: false,
    };
  }
}
export function protectRecord(record: RecordEntry): RecordEntry {
  const r = structuredClone(record);
  r.request_url = safeURL(r.request_url);
  r.page_url = r.page_url ? safeURL(r.page_url) : null;
  r.referer = r.referer ? safeURL(r.referer) : null;
  r.initiator_url = r.initiator_url ? safeURL(r.initiator_url) : null;
  r.initiator_stack = stackFrames(r.initiator_stack);
  if (r.initiator?.url) r.initiator.url = safeURL(r.initiator.url);
  r.request_headers = protectPairs(
    r.request_headers.map((p) => ({
      ...p,
      value: /^(referer|origin)$/i.test(p.name) ? safeURL(p.value) : p.value,
    })),
  );
  r.query_params = protectPairs(r.query_params);
  r.request_body.parsed =
    r.request_body.representation === "form"
      ? protectPairs((r.request_body.parsed ?? []) as Pair[])
      : protectValue(r.request_body.parsed);
  delete r.request_body.raw;
  r.protection.redacted = JSON.stringify(r) !== JSON.stringify(record);
  return r;
}
export type SavedStack = {
  callFrames: Array<{
    scriptId?: string;
    url: string;
    functionName?: string;
    lineNumber?: number;
    columnNumber?: number;
  }>;
  description?: string;
  parent: SavedStack | null;
  parentId: { id: string; debuggerId?: string } | null;
  truncated_reason?: string;
};
export function stackFrames(
  stack: any,
  depth = 0,
  seen = new Set<unknown>(),
): SavedStack | null {
  if (!stack || typeof stack !== "object") return null;
  if (depth > 32 || seen.has(stack))
    return {
      callFrames: [],
      parent: null,
      parentId:
        typeof stack.parentId?.id === "string" ? { ...stack.parentId } : null,
      truncated_reason:
        depth > 32
          ? "异步调用栈超过保存深度上限（33 段）"
          : "异步调用栈包含循环引用",
    };
  seen.add(stack);
  return {
    callFrames: (Array.isArray(stack.callFrames) ? stack.callFrames : [])
      .filter((f: any) => f && typeof f === "object")
      .map((f: any) => ({
        scriptId: f.scriptId,
        url: typeof f.url === "string" && f.url ? safeURL(f.url) : "",
        functionName: f.functionName,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      })),
    ...(typeof stack.description === "string"
      ? { description: stack.description }
      : {}),
    ...(typeof stack.truncated_reason === "string"
      ? { truncated_reason: stack.truncated_reason }
      : {}),
    parent: stackFrames(stack.parent, depth + 1, seen),
    parentId:
      typeof stack.parentId?.id === "string"
        ? {
            id: stack.parentId.id,
            ...(typeof stack.parentId.debuggerId === "string"
              ? { debuggerId: stack.parentId.debuggerId }
              : {}),
          }
        : null,
  };
}
