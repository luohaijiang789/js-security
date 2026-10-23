import type { Pair, RecordEntry } from "./model";

/** Kept for reading historical records created by sensitive-v1. */
export const REDACTED = "[REDACTED]";
export const MAX_STRING_CHARS = 64 * 1024;

function marker(original: number, unit: "字符" | "字节") {
  return `\n…[已截断，原始 ${original} ${unit}]…\n`;
}

export function truncateString(value: string, limit = MAX_STRING_CHARS) {
  if (value.length <= limit) return value;
  const note = marker(value.length, "字符");
  const available = Math.max(0, limit - note.length);
  const head = Math.ceil(available * 0.75);
  return (
    value.slice(0, head) + note + value.slice(value.length - (available - head))
  );
}

function truncateUtf8(value: string, limit: number) {
  const encoder = new TextEncoder();
  const prefix = (input: string, budget: number) => {
    let result = "";
    let used = 0;
    for (const character of input) {
      const size = encoder.encode(character).length;
      if (used + size > budget) break;
      result += character;
      used += size;
    }
    return result;
  };
  const originalBytes = encoder.encode(value).length;
  if (originalBytes <= limit) return value;
  const note = marker(originalBytes, "字节");
  const noteBytes = encoder.encode(note).length;
  if (limit <= noteBytes) return prefix(note, limit);
  const budget = limit - noteBytes;
  const headBudget = Math.ceil(budget * 0.75);
  const tailBudget = budget - headBudget;
  let head = "";
  let headBytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (headBytes + size > headBudget) break;
    head += character;
    headBytes += size;
  }
  let tail = "";
  let tailBytes = 0;
  for (const character of [...value].reverse()) {
    const size = encoder.encode(character).length;
    if (tailBytes + size > tailBudget) break;
    tail = character + tail;
    tailBytes += size;
  }
  return head + note + tail;
}

function limitDepth(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[DEPTH_LIMIT]";
  if (Array.isArray(value))
    return value.map((item) => limitDepth(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        limitDepth(item, depth + 1),
      ]),
    );
  return value;
}

export function protectValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return truncateString(value);
  if (Array.isArray(value))
    return value.map((item) => protectValue(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        protectValue(item, depth + 1),
      ]),
    );
  return value;
}

function truncateValue(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value);
  if (Array.isArray(value)) return value.map(truncateValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateValue(item)]),
    );
  return value;
}

export function protectPairs(pairs: Pair[]): Pair[] {
  return pairs.map((pair) => ({
    name: pair.name,
    value: truncateString(pair.value),
  }));
}

export function safeURL(value: string, truncate = true): string {
  if (!truncate || value.length <= MAX_STRING_CHARS) return value;
  try {
    const url = new URL(value);
    url.username = truncateString(url.username);
    url.password = truncateString(url.password);
    url.pathname = truncateString(url.pathname);
    url.hash = url.hash ? `#${truncateString(url.hash.slice(1))}` : "";
    const pairs = [...url.searchParams];
    url.search = "";
    for (const [name, item] of pairs)
      url.searchParams.append(name, truncateString(item));
    return url.href;
  } catch {
    return truncateString(value);
  }
}

export function parseBody(
  raw: string | undefined,
  contentType: string,
  hasBody: boolean,
  limit: number,
  protect = true,
  truncate = true,
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
  const bytes = new TextEncoder().encode(raw).length;
  if (truncate && bytes > limit) {
    const partial = truncateUtf8(raw, limit);
    return {
      body: { representation: "truncated", parsed: null, raw: partial },
      quality: {
        state: "partial",
        reason: `正文超过 ${limit} 字节上限，已保留首尾片段（原始 ${bytes} 字节）`,
      },
      truncated: true,
    };
  }
  try {
    if (contentType.includes("json")) {
      const decoded = JSON.parse(raw);
      const limited = truncate ? limitDepth(decoded) : decoded;
      const parsed = protect && truncate ? protectValue(limited) : limited;
      const depthTruncated =
        truncate && JSON.stringify(parsed).includes("[DEPTH_LIMIT]");
      return {
        body: { representation: "json", parsed },
        quality: depthTruncated
          ? { state: "partial", reason: "JSON 解析深度超过 32 层" }
          : { state: "complete" },
        truncated: depthTruncated,
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
          parsed: protect && truncate ? protectPairs(pairs) : pairs,
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
      quality: { state: "complete" },
      truncated: false,
    };
  } catch {
    return {
      body: { representation: "unparseable", parsed: null },
      quality: { state: "unparseable", reason: "正文解析失败，已保留原始文本" },
      truncated: false,
    };
  }
}

export function parseResponseBody(
  raw: string,
  base64Encoded: boolean,
  contentType: string,
  limit: number,
  truncate = true,
): {
  body: RecordEntry["request_body"];
  quality: RecordEntry["capture_status"]["body"];
  truncated: boolean;
} {
  if (!base64Encoded)
    return parseBody(raw, contentType, true, limit, false, truncate);
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const originalBytes = Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
  const characterLimit = Math.max(64, Math.ceil((limit * 4) / 3));
  if (truncate && raw.length > characterLimit)
    return {
      body: {
        representation: "base64",
        parsed: null,
        raw: truncateString(raw, characterLimit),
        encoding: "base64",
      },
      quality: {
        state: "partial",
        reason: `二进制响应超过 ${limit} 字节上限，Base64 已保留首尾片段（原始约 ${originalBytes} 字节）`,
      },
      truncated: true,
    };
  return {
    body: {
      representation: "base64",
      parsed: null,
      raw,
      encoding: "base64",
    },
    quality: {
      state: "complete",
      reason: `二进制响应以 Base64 保存（约 ${originalBytes} 字节）`,
    },
    truncated: false,
  };
}

export function protectRecord(
  record: RecordEntry,
  truncate = true,
): RecordEntry {
  const normalized = structuredClone(record);
  normalized.request_url = safeURL(record.request_url, truncate);
  normalized.page_url = record.page_url
    ? safeURL(record.page_url, truncate)
    : null;
  normalized.referer = record.referer
    ? safeURL(record.referer, truncate)
    : null;
  normalized.initiator_url = record.initiator_url
    ? safeURL(record.initiator_url, truncate)
    : null;
  if (normalized.initiator?.url)
    normalized.initiator.url = safeURL(normalized.initiator.url, truncate);
  normalized.initiator_stack = stackFrames(
    record.initiator_stack,
    0,
    new Set(),
    truncate,
  );
  const before = JSON.stringify(normalized);
  const markedTruncated = before.includes("[已截断，原始 ");
  const retained = (
    truncate ? truncateValue(normalized) : normalized
  ) as RecordEntry;
  if (truncate) {
    retained.request_url = normalized.request_url;
    retained.page_url = normalized.page_url;
    retained.referer = normalized.referer;
    retained.initiator_url = normalized.initiator_url;
    if (retained.initiator && normalized.initiator)
      retained.initiator.url = normalized.initiator.url;
    retained.initiator_stack = normalized.initiator_stack;
    retained.request_headers.forEach((pair, index) => {
      pair.name = normalized.request_headers[index].name;
    });
    retained.response_headers?.forEach((pair, index) => {
      pair.name = normalized.response_headers?.[index]?.name ?? pair.name;
    });
    retained.query_params.forEach((pair, index) => {
      pair.name = normalized.query_params[index].name;
    });
    if (
      retained.request_body.representation === "form" &&
      Array.isArray(retained.request_body.parsed) &&
      Array.isArray(normalized.request_body.parsed)
    )
      (retained.request_body.parsed as Pair[]).forEach((pair, index) => {
        pair.name = (normalized.request_body.parsed as Pair[])[index].name;
      });
  }
  const valueTruncated = before !== JSON.stringify(retained);
  retained.protection.version = truncate
    ? "retain-truncate-v1"
    : "retain-complete-v1";
  retained.protection.redacted = false;
  retained.protection.truncated =
    retained.protection.truncated || valueTruncated || markedTruncated;
  return retained;
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
  truncate = true,
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
      .filter((frame: any) => frame && typeof frame === "object")
      .map((frame: any) => ({
        scriptId: frame.scriptId,
        url: typeof frame.url === "string" ? safeURL(frame.url, truncate) : "",
        functionName:
          truncate && typeof frame.functionName === "string"
            ? truncateString(frame.functionName)
            : frame.functionName,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      })),
    ...(typeof stack.description === "string"
      ? {
          description: truncate
            ? truncateString(stack.description)
            : stack.description,
        }
      : {}),
    ...(typeof stack.truncated_reason === "string"
      ? { truncated_reason: stack.truncated_reason }
      : {}),
    parent: stackFrames(stack.parent, depth + 1, seen, truncate),
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
