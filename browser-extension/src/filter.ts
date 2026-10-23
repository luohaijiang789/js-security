import type { Filter, RecordEntry, Rule } from "./model";
export type Verdict = true | false | "unknown";
const fields = [
  "page_url",
  "page_host",
  "referer",
  "initiator_url",
  "request_url",
  "domain",
  "pathname",
  "extension",
  "method",
  "resource_type",
  "status_code",
  "query",
  "header",
  "body",
];
const operators = [
  "contains",
  "contains_any",
  "equals",
  "starts_with",
  "ends_with",
  "in",
  "regex",
  "wildcard",
  "exists",
  "not_exists",
  "domain",
];
export function validateRule(rule: Rule, depth = 0): void {
  if (depth > 16) throw Error("规则嵌套最多 16 层");
  if (!rule || typeof rule !== "object") throw Error("规则必须为对象");
  if ("op" in rule) {
    if (
      !["and", "or", "not"].includes(rule.op) ||
      !Array.isArray(rule.rules) ||
      !rule.rules.length ||
      (rule.op === "not" && rule.rules.length !== 1)
    )
      throw Error("非法规则组（NOT 仅允许一项）");
    rule.rules.forEach((r) => validateRule(r, depth + 1));
    return;
  }
  if (
    !fields.includes(rule.field) ||
    (!operators.includes(rule.operator.replace(/^not_/, "")) &&
      rule.operator !== "not_exists")
  )
    throw Error("非法字段或匹配方式");
  if (
    !["exists", "not_exists"].includes(rule.operator) &&
    (!Array.isArray(rule.values) ||
      !rule.values.length ||
      rule.values.some((x) => typeof x !== "string"))
  )
    throw Error("规则需要字符串 values");
  if (rule.operator.replace(/^not_/, "") === "regex")
    for (const v of rule.values ?? [])
      new RegExp(v, rule.case_sensitive ? "" : "i");
  if (["query", "header", "body"].includes(rule.field) && !rule.key)
    throw Error("内容规则需要 key（名称或 JSON 点路径）");
}
export function validateFilter(f: Filter) {
  if (!f || typeof f !== "object" || Array.isArray(f))
    throw Error("Filter 必须为对象");
  for (const key of Object.keys(f)) {
    if (!["scope", "include", "exclude"].includes(key))
      throw Error(`未知 Filter 项 ${key}`);
    if (f[key as keyof Filter]) validateRule(f[key as keyof Filter]!);
  }
}

/**
 * Group-level NOT remains valid for imported and historical JSON, but the
 * visual editor intentionally does not expose it: inside an already-negative
 * section such as "exclude", it creates unreadable double negatives. Direct
 * `not_*` operators remain editable in the page and keep sections, where they
 * read as one condition. The exclusion section rejects them because its
 * heading would create another double negative.
 */
export function hasGroupNegation(rule?: Rule): boolean {
  if (!rule || !("op" in rule)) return false;
  return rule.op === "not" || rule.rules.some(hasGroupNegation);
}

export function hasAtomicNegation(rule?: Rule): boolean {
  if (!rule) return false;
  if ("op" in rule) return rule.rules.some(hasAtomicNegation);
  return rule.operator.startsWith("not_");
}

function usesOnlyFields(rule: Rule | undefined, allowed: Set<string>): boolean {
  if (!rule) return true;
  if ("op" in rule)
    return rule.rules.every((child) => usesOnlyFields(child, allowed));
  return allowed.has(rule.field);
}

export function canEditFilterVisually(filter: Filter): boolean {
  const pageFields = new Set(["page_url", "page_host", "referer"]),
    requestFields = new Set([
      "initiator_url",
      "request_url",
      "domain",
      "pathname",
      "extension",
      "method",
      "resource_type",
      "status_code",
      "query",
      "header",
      "body",
    ]);
  return (
    ![filter.scope, filter.include, filter.exclude].some(hasGroupNegation) &&
    !hasAtomicNegation(filter.exclude) &&
    usesOnlyFields(filter.scope, pageFields) &&
    usesOnlyFields(filter.include, requestFields) &&
    usesOnlyFields(filter.exclude, requestFields)
  );
}
function lookup(
  r: RecordEntry,
  rule: Extract<Rule, { field: string }>,
  final: boolean,
): { values: string[]; known: boolean } {
  const f = rule.field;
  let v: unknown;
  if (f === "query" || f === "header") {
    const pairs = f === "query" ? r.query_params : r.request_headers;
    const found = pairs.filter((p) =>
      f === "header"
        ? p.name.toLowerCase() === rule.key!.toLowerCase()
        : p.name === rule.key,
    );
    return {
      values: found.map((p) => p.value),
      known:
        f === "query" ||
        r.capture_status.headers.state === "complete" ||
        found.length > 0,
    };
  }
  if (f === "body") {
    v = r.request_body.parsed;
    if (r.request_body.representation === "form" && Array.isArray(v)) {
      const found = v.filter((p) => p.name === rule.key);
      return {
        values: found.map((p) => p.value),
        known: r.capture_status.body.state === "complete" || found.length > 0,
      };
    }
    for (const k of rule.key!.split(".")) {
      if (v === null || typeof v !== "object") {
        v = undefined;
        break;
      }
      v = Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
    }
    return {
      values:
        v === undefined ? [] : [typeof v === "string" ? v : JSON.stringify(v)],
      known: r.capture_status.body.state === "complete" || v !== undefined,
    };
  }
  if (f === "extension")
    v =
      r.pathname
        .split("/")
        .pop()
        ?.match(/\.([^.]+)$/)?.[1] ?? "";
  else if (f === "page_host") {
    try {
      v = r.page_url ? new URL(r.page_url).hostname : null;
    } catch {
      v = null;
    }
  } else v = r[f as keyof RecordEntry];
  return {
    values: v === null || v === undefined ? [] : [String(v)],
    known:
      (v !== null && v !== undefined) ||
      (f === "referer" && r.capture_status.headers.state === "complete") ||
      (f === "status_code" && final && r.request_state === "complete"),
  };
}
export function evaluate(
  rule: Rule,
  r: RecordEntry,
  final = false,
  hits?: Record<string, number>,
  path = "rule",
): Verdict {
  let result: Verdict;
  if ("op" in rule) {
    const a = rule.rules.map((x, i) =>
      evaluate(x, r, final, hits, `${path}.${i}`),
    );
    result =
      rule.op === "and"
        ? a.includes(false)
          ? false
          : a.includes("unknown")
            ? "unknown"
            : true
        : rule.op === "or"
          ? a.includes(true)
            ? true
            : a.includes("unknown")
              ? "unknown"
              : false
          : a[0] === "unknown"
            ? "unknown"
            : !a[0];
  } else {
    const { values, known } = lookup(r, rule, final);
    const op = rule.operator;
    if (op === "exists" || op === "not_exists") {
      result = values.length
        ? op === "exists"
        : known
          ? op === "not_exists"
          : "unknown";
    } else if (!known || values.some((v) => v.includes("[REDACTED]")))
      result = "unknown";
    else {
      const lower = (s: string) => (rule.case_sensitive ? s : s.toLowerCase());
      const base = op.replace(/^not_/, "");
      const match = values.some((v) =>
        (rule.values ?? []).some((w) => {
          const a = lower(v),
            b = lower(w);
          switch (base) {
            case "contains":
            case "contains_any":
              return a.includes(b);
            case "equals":
            case "in":
              return a === b;
            case "starts_with":
              return a.startsWith(b);
            case "ends_with":
              return a.endsWith(b);
            case "domain":
              return a === b || a.endsWith("." + b);
            case "regex":
              return new RegExp(w, rule.case_sensitive ? "" : "i").test(v);
            case "wildcard":
              return new RegExp(
                "^" +
                  w
                    .split("*")
                    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join(".*") +
                  "$",
                rule.case_sensitive ? "" : "i",
              ).test(v);
            default:
              return false;
          }
        }),
      );
      result = op.startsWith("not_") ? !match : match;
    }
  }
  if (hits && result === true) hits[path] = (hits[path] ?? 0) + 1;
  return result;
}
export function matchFilter(
  f: Filter,
  r: RecordEntry,
  final = false,
  hits?: Record<string, number>,
): "matched" | "excluded" | "unknown" {
  const s = f.scope ? evaluate(f.scope, r, final, hits, "scope") : true,
    i = f.include ? evaluate(f.include, r, final, hits, "include") : true,
    e = f.exclude ? evaluate(f.exclude, r, final, hits, "exclude") : false;
  return s === false || i === false || e === true
    ? "excluded"
    : s === "unknown" || i === "unknown" || e === "unknown"
      ? "unknown"
      : "matched";
}
export const presets: Record<string, Filter> = {
  全量: {},
  排除静态资源: {
    exclude: {
      field: "extension",
      operator: "in",
      values: [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "svg",
        "ico",
        "js",
        "css",
        "woff",
        "woff2",
      ],
    },
  },
  "XHR / Fetch / Beacon": {
    include: {
      field: "resource_type",
      operator: "in",
      values: ["XHR", "Fetch", "Ping"],
    },
  },
  阿里云页面: {
    scope: {
      field: "page_host",
      operator: "domain",
      values: ["alibabacloud.com"],
    },
  },
};
