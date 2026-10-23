import { describe, expect, it } from "vitest";
import { parseSimpleQuery, simpleQueryFromFilter } from "../src/filter-query";
import { matchFilter } from "../src/filter";
import type { Filter, RecordEntry } from "../src/model";

const record = (overrides: Partial<RecordEntry> = {}) =>
  ({
    request_url: "https://api.example.com/api/orders?q=red shoe",
    domain: "api.example.com",
    pathname: "/api/orders",
    method: "POST",
    resource_type: "Fetch",
    status_code: 200,
    page_url: "https://console.example.com/orders",
    initiator_url: "https://console.example.com/app.js",
    request_state: "complete",
    capture_status: {
      headers: { state: "complete" },
      body: { state: "complete" },
    },
    query_params: [],
    request_headers: [],
    request_body: { representation: "json", parsed: null },
    ...overrides,
  }) as RecordEntry;

describe("single filter search syntax", () => {
  it("uses semicolons for new queries while retaining legacy space separation", () => {
    const modern = parseSimpleQuery(
      "url:order detail; method:POST; -resource-type:Image,Script",
    );
    expect((modern.filter.include as any).rules[0].values).toEqual([
      "order detail",
    ]);
    expect(matchFilter(modern.filter, record(), true)).toBe("excluded");
    expect(
      (parseSimpleQuery("method:POST status-code:200").filter.include as any)
        .rules,
    ).toHaveLength(2);
    expect(
      (
        parseSimpleQuery('url:"orders;history"; method:POST').filter
          .include as any
      ).rules[0].values,
    ).toEqual(["orders;history"]);
    expect(
      (
        parseSimpleQuery(String.raw`url:/orders;history/; method:POST`).filter
          .include as any
      ).rules[0].values,
    ).toEqual(["orders;history"]);
  });

  it("supports regular expressions and keyed request data", () => {
    const result = parseSimpleQuery(
      String.raw`url:/\/api\/(orders|users)$/i; query.q:/red\s+shoe/i; header.X-Trace:/^web-/; body.customer.id:/^C\d+$/`,
    );
    const rules = (result.filter.include as any).rules;
    expect(rules[0]).toEqual({
      field: "request_url",
      operator: "regex",
      values: [String.raw`\/api\/(orders|users)$`],
      case_sensitive: false,
    });
    expect(rules[1]).toMatchObject({
      field: "query",
      key: "q",
      operator: "regex",
      case_sensitive: false,
    });
    expect(rules[2]).toMatchObject({
      field: "header",
      key: "X-Trace",
      case_sensitive: true,
    });
    expect(rules[3]).toMatchObject({ field: "body", key: "customer.id" });
    expect(() => parseSimpleQuery("url:/order/g")).toThrow(
      "正则只支持可选的 i 标志",
    );
    expect(() => parseSimpleQuery("url:/[/")).toThrow("正则表达式无效");
  });

  it("treats plain text and properties as AND and negative tokens as exclusions", () => {
    const result = parseSimpleQuery(
      "/api/ domain:example.com method:POST -resource-type:Image,Script status-code:200",
    );
    expect(matchFilter(result.filter, record(), true)).toBe("matched");
    expect(
      matchFilter(result.filter, record({ resource_type: "Script" }), true),
    ).toBe("excluded");
    expect(matchFilter(result.filter, record({ method: "GET" }), true)).toBe(
      "excluded",
    );
    expect(result.summary).toContain("排除类型为 Image、Script");
  });

  it("supports quoted values and reports malformed input", () => {
    const result = parseSimpleQuery('url:"red shoe" page:"customer center"');
    expect((result.filter.include as any).values).toEqual(["red shoe"]);
    expect((result.filter.scope as any).values).toEqual(["customer center"]);
    expect(() => parseSimpleQuery('url:"not closed')).toThrow("双引号没有闭合");
    expect(() => parseSimpleQuery("priority:high")).toThrow("不认识 priority:");
  });

  it("accepts full URLs and host ports as plain URL searches", () => {
    for (const query of [
      "https://api.example.com/api/orders",
      "api.example.com:443/api/orders",
    ]) {
      const result = parseSimpleQuery(query);
      expect((result.filter.include as any).field).toBe("request_url");
      expect((result.filter.include as any).values).toEqual([query]);
    }
  });

  it("supports a quoted plain phrase and a negative plain phrase", () => {
    const result = parseSimpleQuery('"red shoe" -"tracking pixel"');
    expect((result.filter.include as any).values).toEqual(["red shoe"]);
    expect((result.filter.exclude as any).values).toEqual(["tracking pixel"]);
    expect(matchFilter(result.filter, record(), true)).toBe("matched");
    expect(
      matchFilter(
        result.filter,
        record({ request_url: "https://example.com/tracking pixel" }),
        true,
      ),
    ).toBe("excluded");
  });

  it("puts positive page conditions in the page scope", () => {
    const result = parseSimpleQuery(
      "page:/console/ page-domain:example.com method:POST",
    );
    expect((result.filter.scope as any).rules).toEqual([
      {
        field: "page_url",
        operator: "regex",
        values: ["console"],
        case_sensitive: true,
      },
      {
        field: "page_host",
        operator: "domain",
        values: ["example.com"],
      },
    ]);
    expect((result.filter.include as any).field).toBe("method");
  });

  it("round-trips supported rules without changing their meaning", () => {
    const original = parseSimpleQuery(
      "domain:example.com method:POST,PUT -resource-type:Image,Font",
    ).filter;
    const state = simpleQueryFromFilter(original);
    expect(state.advanced).toBe(false);
    if (state.advanced) return;
    expect(state.query).toContain("; ");
    const roundTrip = parseSimpleQuery(state.query).filter;
    expect(matchFilter(roundTrip, record(), true)).toBe(
      matchFilter(original, record(), true),
    );
  });

  it("rewrites legacy scope, include and exclude rules without changing outcomes", () => {
    const legacy: Filter = {
      scope: {
        field: "page_host",
        operator: "domain",
        values: ["example.com"],
      },
      include: {
        op: "and",
        rules: [
          {
            field: "request_url",
            operator: "regex",
            values: [String.raw`/api/(?:orders|users)`],
          },
          { field: "method", operator: "in", values: ["POST", "PUT"] },
        ],
      },
      exclude: {
        op: "or",
        rules: [
          {
            field: "resource_type",
            operator: "in",
            values: ["Image", "Script"],
          },
          {
            field: "pathname",
            operator: "ends_with",
            values: ["/health"],
          },
        ],
      },
    };
    const converted = simpleQueryFromFilter(legacy);
    expect(converted.advanced).toBe(false);
    if (converted.advanced) return;
    expect(converted.query).toContain("; ");
    const rewritten = parseSimpleQuery(converted.query).filter;
    for (const candidate of [
      record(),
      record({ method: "GET" }),
      record({ resource_type: "Image" }),
      record({ pathname: "/health" }),
      record({ page_url: "https://outside.test/orders" }),
    ])
      expect(matchFilter(rewritten, candidate, true)).toBe(
        matchFilter(legacy, candidate, true),
      );
  });

  it("rewrites compatible advanced atoms as regular-expression query terms", () => {
    const original = {
      include: {
        op: "and" as const,
        rules: [
          {
            field: "request_url",
            operator: "starts_with",
            values: ["https://api.example.com/v1/"],
            case_sensitive: true,
          },
          {
            field: "header",
            key: "X-Client",
            operator: "equals",
            values: ["console"],
          },
        ],
      },
      exclude: {
        field: "pathname",
        operator: "regex",
        values: [String.raw`\.(?:png|css)$`],
      },
    };
    const state = simpleQueryFromFilter(original);
    expect(state.advanced).toBe(false);
    if (state.advanced) return;
    expect(state.query).toContain(
      String.raw`url:/^https:\/\/api\.example\.com\/v1\//`,
    );
    expect(state.query).toContain("header.X-Client:/^console$/i");
    expect(state.query).toContain(String.raw`-path:/\.(?:png|css)$/i`);
    expect(() => parseSimpleQuery(state.query)).not.toThrow();
  });

  it("round-trips nested OR and only rejects conditions the query cannot express", () => {
    const nested: Filter = {
      include: {
        op: "or",
        rules: [
          { field: "method", operator: "equals", values: ["GET"] },
          { field: "method", operator: "equals", values: ["POST"] },
        ],
      },
    };
    const converted = simpleQueryFromFilter(nested);
    expect(converted.advanced).toBe(false);
    if (!converted.advanced) {
      expect(converted.query).toContain(" OR ");
      const roundTrip = parseSimpleQuery(converted.query).filter;
      for (const method of ["GET", "POST", "DELETE"])
        expect(matchFilter(roundTrip, record({ method }), true)).toBe(
          matchFilter(nested, record({ method }), true),
        );
    }
    const existence: Filter = {
      include: { field: "header", key: "X-Trace", operator: "exists" },
    };
    const existenceQuery = simpleQueryFromFilter(existence);
    expect(existenceQuery.advanced).toBe(false);
    if (!existenceQuery.advanced) {
      expect(existenceQuery.query).toBe("header.X-Trace:?");
      const roundTrip = parseSimpleQuery(existenceQuery.query).filter;
      const present = record({
        request_headers: [{ name: "X-Trace", value: "" }],
      });
      const redacted = record({
        request_headers: [{ name: "X-Trace", value: "[REDACTED]" }],
      });
      for (const candidate of [present, redacted, record()])
        expect(matchFilter(roundTrip, candidate, true)).toBe(
          matchFilter(existence, candidate, true),
        );
    }
    const absence: Filter = {
      include: { field: "header", key: "X-Trace", operator: "not_exists" },
    };
    const absenceQuery = simpleQueryFromFilter(absence);
    expect(absenceQuery.advanced).toBe(false);
    if (!absenceQuery.advanced) {
      expect(absenceQuery.query).toBe("-header.X-Trace:?");
      const roundTrip = parseSimpleQuery(absenceQuery.query).filter;
      for (const candidate of [
        record(),
        record({
          request_headers: [{ name: "X-Trace", value: "[REDACTED]" }],
        }),
      ])
        expect(matchFilter(roundTrip, candidate, true)).toBe(
          matchFilter(absence, candidate, true),
        );
    }
    const wildcard: Filter = {
      include: {
        field: "pathname",
        operator: "wildcard",
        values: ["/api/*"],
      },
    };
    const wildcardQuery = simpleQueryFromFilter(wildcard);
    expect(wildcardQuery.advanced).toBe(false);
    if (!wildcardQuery.advanced) {
      const roundTrip = parseSimpleQuery(wildcardQuery.query).filter;
      for (const pathname of ["/api/orders", "prefix/api/orders"])
        expect(matchFilter(roundTrip, record({ pathname }), true)).toBe(
          matchFilter(wildcard, record({ pathname }), true),
        );
    }
  });
});
