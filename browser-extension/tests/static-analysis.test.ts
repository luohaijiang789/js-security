import { it, expect } from "vitest";
import { parseStaticDocument, analyzerOrigin } from "../src/static-analysis";
const report = () => ({
  schemaVersion: "2.0.0",
  scope: { complete: false },
  records: [
    {
      id: "r",
      sourceKind: "website-js-static",
      method: "POST",
      host: "api.test",
      url: "/items",
      sourceFile: "https://cdn.test/a.js",
      sourceLine: 1,
      sourceColumn: 1,
      evidenceId: "e",
      gapIds: ["g"],
      stage: "call-site",
    },
  ],
  parameters: [
    {
      id: "f",
      recordId: "r",
      carrier: "body",
      path: ["id"],
      stage: "constructed",
      state: "known-field",
    },
  ],
  gaps: [{ id: "g", recordId: "r", reason: "unknown runtime" }],
  evidence: [{ id: "e", raw: { url: "/items" } }],
});
it("静态交付独立解析并关联记录/字段/缺口/证据", () => {
  const r = parseStaticDocument(report());
  expect(r.records[0].sourceKind).toBe("website-js-static");
  expect(r.parameters[0].recordId).toBe(r.records[0].id);
});
it("坏版本、伪实测、孤立字段、证据缺失拒绝导入", () => {
  expect(() =>
    parseStaticDocument({ ...report(), schemaVersion: 1 }),
  ).toThrow();
  const a = report();
  a.records[0].sourceKind = "plugin-observed";
  expect(() => parseStaticDocument(a)).toThrow();
  expect(() => parseStaticDocument({ ...report(), evidence: [] })).toThrow();
  const b = report();
  b.parameters[0].recordId = "other";
  expect(() => parseStaticDocument(b)).toThrow();
});
it("服务只接受HTTPS或本地HTTP根地址，不夹带凭据或路径", () => {
  expect(analyzerOrigin("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765");
  expect(() => analyzerOrigin("http://external.test/")).toThrow();
  expect(() => analyzerOrigin("https://secret@service.test/")).toThrow();
  expect(() => analyzerOrigin("https://service.test/path")).toThrow();
});
