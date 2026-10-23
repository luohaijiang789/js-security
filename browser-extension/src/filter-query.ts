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
  page: {
    field: "page_url",
    operator: "contains",
    label: "页面包含",
    section: "scope",
  },
  "page-domain": {
    field: "page_host",
    operator: "domain",
    label: "页面域名为",
    section: "scope",
  },
  path: { field: "pathname", operator: "contains", label: "路径包含" },
  initiator: {
    field: "initiator_url",
    operator: "contains",
    label: "发起脚本包含",
  },
  referer: { field: "referer", operator: "contains", label: "来源包含" },
  extension: {
    field: "extension",
    operator: "in",
    label: "扩展名为",
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
  referer: "referer",
  extension: "extension",
};

const reverse = new Map(
  Object.entries(properties).map(([property, value]) => [
    `${value.field}:${value.operator}`,
    property as Property,
  ]),
);
const reverseField = new Map<string, Property>(
  Object.entries(properties).map(([property, value]) => [
    value.field,
    property as Property,
  ]),
);

export type SimpleQueryResult = {
  filter: Filter;
  summary: string[];
};

export type SimpleFilterState =
  { advanced: false; query: string } | { advanced: true; reason: string };

function scanTokens(input: string, semicolonSeparated: boolean) {
  const result: string[] = [];
  let token = "",
    quote = false,
    escape = false,
    regex = false;
  const source = input.trim();
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escape) {
      token += regex ? `\\${character}` : character;
      escape = false;
    } else if (character === "\\") escape = true;
    else if (
      character === "/" &&
      !quote &&
      (regex ||
        (/^(?:-)?(?:[a-z-]+(?:\.[^:;\s]+)?:)?$/i.test(token.trim()) &&
          source[index + 1] !== "/"))
    ) {
      regex = !regex;
      token += character;
    } else if (character === '"') quote = !quote;
    else if (
      !quote &&
      !regex &&
      (character === ";" || (!semicolonSeparated && /\s/.test(character)))
    ) {
      if (token) result.push(token);
      token = "";
    } else token += character;
  }
  if (escape) token += "\\";
  if (quote) throw Error("双引号没有闭合");
  if (token) result.push(token);
  return result;
}

function tokens(input: string) {
  const semicolonSeparated = scanTokens(input, true).length > 1;
  return scanTokens(input, semicolonSeparated)
    .map((token) => token.trim())
    .filter(Boolean);
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

function parseFlatQuery(input: string): SimpleQueryResult {
  const scope: Rule[] = [],
    include: Rule[] = [],
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
    const requestedRaw =
      colon > 0 && !looksLikeAddress ? token.slice(0, colon) : "url";
    const requested = requestedRaw.toLowerCase();
    const property = aliases[requested];
    const keyed = requestedRaw.match(/^(query|header|body)\.(.+)$/i);
    if (!property && !keyed)
      throw Error(
        `不认识 ${requested}:，可用 url、domain、method、status-code、resource-type、page、query.参数名、header.请求头、body.JSON路径`,
      );
    const value =
      colon > 0 && !looksLikeAddress ? token.slice(colon + 1) : token;
    const existence = value === "?";
    const regex = existence ? null : regexValue(value);
    const values = existence
      ? []
      : regex
        ? [regex.pattern]
        : value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    if (!existence && !values.length)
      throw Error(`${requested}: 后面需要填写值`);
    const definition = property
      ? properties[property]
      : {
          field: keyed![1].toLowerCase(),
          operator: "contains",
          label: `${keyed![1]} ${keyed![2]} 包含`,
          key: keyed![2],
        };
    const rule: Atom = {
      field: definition.field,
      operator: existence ? "exists" : regex ? "regex" : definition.operator,
      ...(!existence ? { values } : {}),
      ...(regex ? { case_sensitive: regex.caseSensitive } : {}),
      ...("key" in definition ? { key: definition.key } : {}),
    };
    (negative
      ? exclude
      : "section" in definition && definition.section === "scope"
        ? scope
        : include
    ).push(rule);
    summary.push(
      existence
        ? `${negative ? "排除" : ""}${definition.label.replace(/包含$/, "")}存在`
        : `${negative ? "排除" : ""}${definition.label}${regex ? "正则" : ""} ${regex ? value : readableValues(values)}`,
    );
  }
  return {
    filter: {
      ...(scope.length ? { scope: grouped("and", scope) } : {}),
      ...(include.length ? { include: grouped("and", include) } : {}),
      ...(exclude.length ? { exclude: grouped("or", exclude) } : {}),
    },
    summary: summary.length ? summary : ["保存全部请求"],
  };
}

type ExpressionToken =
  | { type: "atom"; value: string }
  | { type: "and" | "or" | "left" | "right" | "not" };

function expressionTokens(input: string): ExpressionToken[] {
  const result: ExpressionToken[] = [];
  let atom = "",
    quote = false,
    regex = false,
    escape = false;
  const pushAtom = () => {
    const value = atom.trim();
    if (value) result.push({ type: "atom", value });
    atom = "";
  };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (escape) {
      atom += regex ? `\\${character}` : character;
      escape = false;
      continue;
    }
    if (character === "\\") {
      escape = true;
      continue;
    }
    if (character === '"' && !regex) {
      quote = !quote;
      atom += character;
      continue;
    }
    if (
      character === "/" &&
      !quote &&
      (regex ||
        (/^(?:-)?(?:[a-z-]+(?:\.[^:;\s]+)?:)?$/i.test(atom.trim()) &&
          input[index + 1] !== "/"))
    ) {
      regex = !regex;
      atom += character;
      continue;
    }
    if (quote || regex) {
      atom += character;
      continue;
    }
    const rest = input.slice(index);
    const or = rest.match(/^\s+OR\s+/i);
    if (or) {
      pushAtom();
      result.push({ type: "or" });
      index += or[0].length - 1;
      continue;
    }
    if (character === ";") {
      pushAtom();
      result.push({ type: "and" });
    } else if (character === "(" || character === ")") {
      pushAtom();
      result.push({ type: character === "(" ? "left" : "right" });
    } else if (character === "-" && !atom.trim()) {
      const next = input.slice(index + 1).trimStart();
      if (next.startsWith("(")) result.push({ type: "not" });
      else atom += character;
    } else atom += character;
  }
  if (escape) atom += "\\";
  if (quote) throw Error("双引号没有闭合");
  pushAtom();
  return result;
}

function expressionRule(input: string): Rule {
  const stream = expressionTokens(input);
  let cursor = 0;
  const primary = (): Rule => {
    const token = stream[cursor++];
    if (!token) throw Error("组合规则缺少条件");
    if (token.type === "not") return { op: "not", rules: [primary()] };
    if (token.type === "left") {
      const rule = or();
      if (stream[cursor]?.type !== "right") throw Error("括号没有闭合");
      cursor++;
      return rule;
    }
    if (token.type !== "atom") throw Error("组合符号两侧都需要条件");
    const parsed = parseFlatQuery(token.value).filter;
    if (parsed.scope) return parsed.scope;
    if (parsed.include) return parsed.include;
    if (parsed.exclude) return { op: "not", rules: [parsed.exclude] };
    throw Error("组合规则缺少条件");
  };
  const and = (): Rule => {
    const rules = [primary()];
    while (stream[cursor]?.type === "and") {
      cursor++;
      rules.push(primary());
    }
    return grouped("and", rules)!;
  };
  const or = (): Rule => {
    const rules = [and()];
    while (stream[cursor]?.type === "or") {
      cursor++;
      rules.push(and());
    }
    return grouped("or", rules)!;
  };
  const rule = or();
  if (cursor !== stream.length) throw Error("组合规则格式不正确");
  return rule;
}

export function parseSimpleQuery(input: string): SimpleQueryResult {
  if (!input.trim()) return { filter: {}, summary: ["保存全部请求"] };
  const expression = expressionTokens(input);
  if (
    !expression.some((token) =>
      ["or", "left", "right", "not"].includes(token.type),
    )
  )
    return parseFlatQuery(input);
  return {
    filter: { include: expressionRule(input) },
    summary: ["按括号、OR 和分号组合过滤条件"],
  };
}

function regexValue(value: string) {
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/((?:\\.|[^/])*)\/([a-z]*)$/i);
  if (!match) return null;
  if (!/^(?:i)?$/.test(match[2]))
    throw Error("正则只支持可选的 i 标志，例如 /order/i");
  try {
    new RegExp(match[1], match[2]);
  } catch (error) {
    throw Error(
      `正则表达式无效：${error instanceof Error ? error.message : error}`,
    );
  }
  return { pattern: match[1], caseSensitive: !match[2].includes("i") };
}

function quote(value: string) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /[\s;]/.test(value) ? `"${escaped}"` : escaped;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeRegexSlash(pattern: string) {
  let output = "";
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "/") {
      output += pattern[index];
      continue;
    }
    let slashes = 0;
    for (
      let cursor = index - 1;
      cursor >= 0 && pattern[cursor] === "\\";
      cursor--
    )
      slashes++;
    output += slashes % 2 ? "/" : "\\/";
  }
  return output;
}

function alternatives(values: string[], map: (value: string) => string) {
  return values.length === 1
    ? map(values[0])
    : values.map((value) => `(?:${map(value)})`).join("|");
}

function regexForAtom(rule: Atom): string | null {
  const values = rule.values;
  if (!values?.length || values.some((value) => !value)) return null;
  const base = rule.operator.replace(/^not_/, "");
  switch (base) {
    case "regex":
      return alternatives(values, (value) => value);
    case "contains":
    case "contains_any":
      return alternatives(values, escapeRegex);
    case "equals":
    case "in":
      return alternatives(values, (value) => `^${escapeRegex(value)}$`);
    case "starts_with":
      return alternatives(values, (value) => `^${escapeRegex(value)}`);
    case "ends_with":
      return alternatives(values, (value) => `${escapeRegex(value)}$`);
    case "domain":
      return alternatives(values, (value) => `(?:^|\\.)${escapeRegex(value)}$`);
    case "wildcard":
      return alternatives(
        values,
        (value) => `^${value.split("*").map(escapeRegex).join(".*")}$`,
      );
    default:
      return null;
  }
}

function atomToken(
  rule: Rule,
  negative: boolean,
): { token: string; negative: boolean } | null {
  if ("op" in rule) return null;
  const existence = ["exists", "not_exists"].includes(rule.operator);
  const values = existence ? ["?"] : rule.values;
  if (!values?.length || values.some((value) => !value)) return null;
  const inverted =
    rule.operator.startsWith("not_") || rule.operator === "not_exists";
  const tokenNegative = negative !== inverted;
  const property = rule.key
    ? ["query", "header", "body"].includes(rule.field)
      ? `${rule.field}.${rule.key}`
      : null
    : reverseField.get(rule.field);
  if (!property) return null;
  if (existence)
    return {
      token: `${tokenNegative ? "-" : ""}${property}:?`,
      negative: tokenNegative,
    };
  const directProperty = reverse.get(`${rule.field}:${rule.operator}`);
  const canUseDirect =
    directProperty === property &&
    !rule.case_sensitive &&
    values.every((value) => !value.includes(",") && !value.startsWith("/"));
  if (canUseDirect)
    return {
      token: `${tokenNegative ? "-" : ""}${property}:${values.map(quote).join(",")}`,
      negative: tokenNegative,
    };
  const pattern = regexForAtom(rule);
  if (!pattern) return null;
  return {
    token: `${tokenNegative ? "-" : ""}${property}:/${escapeRegexSlash(pattern)}/${rule.case_sensitive ? "" : "i"}`,
    negative: tokenNegative,
  };
}

function ruleExpression(rule: Rule, negative = false): string | null {
  if (!("op" in rule)) return atomToken(rule, negative)?.token ?? null;
  if (rule.op === "not") return ruleExpression(rule.rules[0], !negative);
  const effective = negative ? (rule.op === "and" ? "or" : "and") : rule.op;
  const children = rule.rules.map((child) => ruleExpression(child, negative));
  if (children.some((child) => child === null)) return null;
  const expression = children.join(effective === "and" ? "; " : " OR ");
  return children.length > 1 && effective === "or"
    ? `(${expression})`
    : expression;
}

export function simpleQueryFromFilter(filter: Filter): SimpleFilterState {
  const expressions = [
    filter.scope ? ruleExpression(filter.scope) : "",
    filter.include ? ruleExpression(filter.include) : "",
    filter.exclude ? ruleExpression(filter.exclude, true) : "",
  ];
  if (expressions.some((expression) => expression === null))
    return {
      advanced: true,
      reason: "当前规则不能安全转换成单行筛选",
    };
  return {
    advanced: false,
    query: expressions.filter(Boolean).join("; "),
  };
}
