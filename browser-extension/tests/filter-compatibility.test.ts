import { describe, expect, it } from "vitest";
import {
  canEditFilterVisually,
  evaluate,
  hasAtomicNegation,
  hasGroupNegation,
  validateFilter,
} from "../src/filter";
import type { Filter, RecordEntry, Rule } from "../src/model";

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

describe("advanced filter visual compatibility", () => {
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

  it("marks root and nested group-level NOT as JSON-only without mutating it", () => {
    const cases: Rule[] = [
      {
        op: "not",
        rules: [{ field: "method", operator: "equals", values: ["GET"] }],
      },
      {
        op: "and",
        rules: [
          { field: "method", operator: "equals", values: ["POST"] },
          {
            op: "not",
            rules: [
              { field: "pathname", operator: "contains", values: ["/health"] },
            ],
          },
        ],
      },
    ];
    for (const rule of cases) {
      const filter = { exclude: rule } satisfies Filter;
      const before = JSON.stringify(filter);
      expect(hasGroupNegation(rule)).toBe(true);
      expect(canEditFilterVisually(filter)).toBe(false);
      expect(JSON.stringify(filter)).toBe(before);
    }
  });

  it("keeps direct negative operators editable only outside the exclusion section", () => {
    const keepRule: Rule = {
      op: "or",
      rules: [
        { field: "method", operator: "not_equals", values: ["GET"] },
        { field: "pathname", operator: "not_contains", values: ["/health"] },
      ],
    };
    const include: Filter = {
      include: keepRule,
    };
    const exclude: Filter = {
      include: {
        field: "method",
        operator: "equals",
        values: ["POST"],
      },
      exclude: keepRule,
    };
    expect(hasAtomicNegation(keepRule)).toBe(true);
    expect(canEditFilterVisually(include)).toBe(true);
    expect(canEditFilterVisually(exclude)).toBe(false);
    expect(hasGroupNegation(keepRule)).toBe(false);
  });

  it("keeps page and request fields in their own visual sections", () => {
    expect(
      canEditFilterVisually({
        scope: {
          field: "request_url",
          operator: "contains",
          values: ["/api/"],
        },
      }),
    ).toBe(false);
    expect(
      canEditFilterVisually({
        include: {
          field: "page_url",
          operator: "contains",
          values: ["/console/"],
        },
      }),
    ).toBe(false);
    expect(
      canEditFilterVisually({
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
      }),
    ).toBe(true);
  });
});
