import type { Filter, Rule } from "./model";

type Atom = Extract<Rule, { field: string }>;

const properties = {
  url: { field: "request_url", operator: "contains", label: "网址包含" },
  domain: { field: "domain", operator: "domain", label: "域名为" },
  method: { field: "method", operator: "in", label: "方法为" },
  "status-code": {
    field: "status_code",
    operator: "in",
    label: "状态码为",
  },
  "resource-type": {
    field: "resource_type",
    operator: "in",
    label: "类型为",
  },
  page: { field: "page_url", operator: "contains", label: "页面包含" },
  "page-domain": {
    field: "page_host",
    operator: "domain",
    label: "页面域名为",
  },
  path: { field: "pathname", operator: "contains", label: "路径包含" },
  initiator: {
    field: "initiator_url",
    operator: "contains",
    label: "发起脚本包含",
  },
} as const;

type Property = keyof typeof properties;

const aliases: Record<string, Property> = {
  url: "url",
  domain: "domain",
  method: "method",
  status: "status-code",
  "status-code": "status-code",
  type: "resource-type",
  "resource-type": "resource-type",
  page: "page",
  "page-domain": "page-domain",
  path: "path",
  initiator: "initiator",
};

const reverse = new Map(
  Object.entries(properties).map(([property, value]) => [
    `${value.field}:${value.operator}`,
    property as Property,
  ]),
);

export type SimpleQueryResult = {
  filter: Filter;
  summary: string[];
};

export type SimpleFilterState =
  { advanced: false; query: string } | { advanced: true; reason: string };

function tokens(input: string) {
  const result: string[] = [];
  let token = "",
    quote = false,
    escape = false;
  for (const character of input.trim()) {
    if (escape) {
      token += character;
      escape = false;
    } else if (character === "\\") escape = true;
    else if (character === '"') quote = !quote;
    else if (/\s/.test(character) && !quote) {
      if (token) result.push(token);
      token = "";
    } else token += character;
  }
  if (escape) token += "\\";
  if (quote) throw Error("双引号没有闭合");
  if (token) result.push(token);
  return result;
}

function grouped(op: "and" | "or", rules: Rule[]): Rule | undefined {
  if (!rules.length) return undefined;
  return rules.length === 1 ? rules[0] : { op, rules };
}

function readableValues(values: string[]) {
  return values
    .map((value) => (value.includes(" ") ? `“${value}”` : value))
    .join("、");
}

export function parseSimpleQuery(input: string): SimpleQueryResult {
  const include: Rule[] = [],
    exclude: Rule[] = [],
    summary: string[] = [];
  for (const raw of tokens(input)) {
    const negative = raw.startsWith("-");
    const token = negative ? raw.slice(1) : raw;
    if (!token) throw Error("排除符号 - 后面需要填写条件");
    const colon = token.indexOf(":");
    const looksLikeAddress =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(token) ||
      /^(?:localhost|[^/:\s]*\.[^/:\s]+|\[[^\]]+\]):\d+(?:$|[/?.#])/.test(
        token,
      );
    const requested =
      colon > 0 && !looksLikeAddress
        ? token.slice(0, colon).toLowerCase()
        : "url";
    const property = aliases[requested];
    if (!property)
      throw Error(
        `不认识 ${requested}:，可用 url、domain、method、status-code、resource-type、page`,
      );
    const value =
      colon > 0 && !looksLikeAddress ? token.slice(colon + 1) : token;
    const values = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!values.length) throw Error(`${requested}: 后面需要填写值`);
    const definition = properties[property];
    const rule: Atom = {
      field: definition.field,
      operator: definition.operator,
      values,
    };
    (negative ? exclude : include).push(rule);
    summary.push(
      `${negative ? "排除" : ""}${definition.label} ${readableValues(values)}`,
    );
  }
  return {
    filter: {
      ...(include.length ? { include: grouped("and", include) } : {}),
      ...(exclude.length ? { exclude: grouped("or", exclude) } : {}),
    },
    summary: summary.length ? summary : ["保留全部请求"],
  };
}

function quote(value: string) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /\s/.test(value) ? `"${escaped}"` : escaped;
}

function atomToken(rule: Rule, negative: boolean): string | null {
  if ("op" in rule || rule.case_sensitive || rule.key) return null;
  const property = reverse.get(`${rule.field}:${rule.operator}`);
  if (!property || !rule.values?.length || rule.values.some((v) => !v))
    return null;
  return `${negative ? "-" : ""}${property}:${rule.values.map(quote).join(",")}`;
}

function simpleRules(
  rule: Rule | undefined,
  group: "and" | "or",
  negative: boolean,
): string[] | null {
  if (!rule) return [];
  if (!("op" in rule)) {
    const token = atomToken(rule, negative);
    return token ? [token] : null;
  }
  if (rule.op !== group) return null;
  const result: string[] = [];
  for (const child of rule.rules) {
    const token = atomToken(child, negative);
    if (!token) return null;
    result.push(token);
  }
  return result;
}

export function simpleQueryFromFilter(filter: Filter): SimpleFilterState {
  const scope = simpleRules(filter.scope, "and", false),
    include = simpleRules(filter.include, "and", false),
    exclude = simpleRules(filter.exclude, "or", true);
  if (!scope || !include || !exclude)
    return {
      advanced: true,
      reason: "这条规则包含嵌套逻辑、特殊字段或区分大小写设置",
    };
  return {
    advanced: false,
    query: [...scope, ...include, ...exclude].join(" "),
  };
}

export function appendSimpleToken(query: string, token: string) {
  const current = tokens(query);
  if (!current.includes(token)) current.push(token);
  return current.join(" ");
}
