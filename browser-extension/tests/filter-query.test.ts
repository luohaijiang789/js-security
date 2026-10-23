import { describe, expect, it } from "vitest";
import {
  appendSimpleToken,
  parseSimpleQuery,
  simpleQueryFromFilter,
} from "../src/filter-query";
import { matchFilter } from "../src/filter";
import type { RecordEntry } from "../src/model";

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

describe("Chrome-style simple filter query", () => {
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
    expect((result.filter.include as any).rules[0].values).toEqual([
      "red shoe",
    ]);
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

  it("round-trips supported rules without changing their meaning", () => {
    const original = parseSimpleQuery(
      "domain:example.com method:POST,PUT -resource-type:Image,Font",
    ).filter;
    const state = simpleQueryFromFilter(original);
    expect(state.advanced).toBe(false);
    if (state.advanced) return;
    const roundTrip = parseSimpleQuery(state.query).filter;
    expect(matchFilter(roundTrip, record(), true)).toBe(
      matchFilter(original, record(), true),
    );
  });

  it("locks unsupported nested or case-sensitive rules instead of overwriting them", () => {
    expect(
      simpleQueryFromFilter({
        include: {
          op: "or",
          rules: [
            { field: "method", operator: "equals", values: ["GET"] },
            { field: "method", operator: "equals", values: ["POST"] },
          ],
        },
      }).advanced,
    ).toBe(true);
    expect(
      simpleQueryFromFilter({
        include: {
          field: "request_url",
          operator: "contains",
          values: ["Admin"],
          case_sensitive: true,
        },
      }).advanced,
    ).toBe(true);
  });

  it("does not duplicate a chip already present", () => {
    expect(appendSimpleToken("method:POST", "method:POST")).toBe("method:POST");
  });
});
