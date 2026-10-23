import { describe, expect, it } from "vitest";
import { evaluate, matchFilter, validateFilter } from "../src/filter";
import { parseSimpleQuery, simpleQueryFromFilter } from "../src/filter-query";
import type { Filter, RecordEntry } from "../src/model";

const record = (method: string) =>
  ({
    method,
    capture_status: {
      headers: { state: "complete" },
      body: { state: "complete" },
    },
    request_headers: [],
    query_params: [],
    request_body: { representation: "unavailable", parsed: null },
  }) as unknown as RecordEntry;

function expectSameResults(filter: Filter, records: RecordEntry[]) {
  const converted = simpleQueryFromFilter(filter);
  expect(converted.advanced).toBe(false);
  if (converted.advanced) return;
  const roundTrip = parseSimpleQuery(converted.query).filter;
  for (const candidate of records)
    expect(matchFilter(roundTrip, candidate, true)).toBe(
      matchFilter(filter, candidate, true),
    );
}

describe("historical filter compatibility", () => {
  it("continues to validate and evaluate historical group-level NOT JSON", () => {
    const legacy: Filter = {
      include: {
        op: "not",
        rules: [{ field: "method", operator: "equals", values: ["GET"] }],
      },
    };
    expect(() => validateFilter(legacy)).not.toThrow();
    expect(evaluate(legacy.include!, record("POST"), true)).toBe(true);
    expect(evaluate(legacy.include!, record("GET"), true)).toBe(false);
  });

  it("converts root and nested NOT groups without changing their meaning", () => {
    const filters: Filter[] = [
      {
        include: {
          op: "not",
          rules: [{ field: "method", operator: "equals", values: ["GET"] }],
        },
      },
      {
        include: {
          op: "and",
          rules: [
            { field: "method", operator: "equals", values: ["POST"] },
            {
              op: "not",
              rules: [
                {
                  field: "request_url",
                  operator: "contains",
                  values: ["/health"],
                },
              ],
            },
          ],
        },
      },
    ];
    const records = [
      record("GET"),
      record("POST"),
      { ...record("POST"), request_url: "https://example.com/health" },
    ];
    for (const filter of filters) expectSameResults(filter, records);
  });

  it("converts negative operators in include and exclude groups", () => {
    const filter: Filter = {
      include: {
        op: "or",
        rules: [
          { field: "method", operator: "not_equals", values: ["GET"] },
          {
            field: "request_url",
            operator: "not_contains",
            values: ["/health"],
          },
        ],
      },
      exclude: {
        field: "method",
        operator: "not_equals",
        values: ["POST"],
      },
    };
    expectSameResults(filter, [
      record("GET"),
      record("POST"),
      { ...record("POST"), request_url: "https://example.com/health" },
    ]);
  });

  it("preserves historical scope, include, and exclude semantics", () => {
    const filter: Filter = {
      scope: {
        field: "page_host",
        operator: "domain",
        values: ["example.com"],
      },
      include: {
        field: "request_url",
        operator: "contains",
        values: ["/api/"],
      },
      exclude: {
        field: "request_url",
        operator: "contains",
        values: ["/health"],
      },
    };
    expectSameResults(filter, [
      {
        ...record("GET"),
        page_url: "https://console.example.com/home",
        request_url: "https://api.example.com/api/orders",
      },
      {
        ...record("GET"),
        page_url: "https://console.example.com/home",
        request_url: "https://api.example.com/api/health",
      },
      {
        ...record("GET"),
        page_url: "https://console.other.test/home",
        request_url: "https://api.example.com/api/orders",
      },
    ]);
  });
});
