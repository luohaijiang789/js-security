export type StaticRecord = {
  id: string;
  sourceKind: "repository-static" | "website-js-static" | "plugin-observed";
  method: string | null;
  host: string | null;
  url: string | null;
  resolvedUrl?: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  sourceColumn: number | null;
  generatedFile?: string | null;
  generatedLine?: number | null;
  generatedColumn?: number | null;
  evidenceId: string;
  gapIds: string[];
  stage: string;
  observation?: { requestId?: string } | null;
};
export type StaticDocument = {
  schemaVersion: "2.0.0";
  scope: { complete: boolean };
  records: StaticRecord[];
  parameters: {
    id: string;
    recordId: string;
    carrier: string;
    path: string[];
    stage: string;
    state: string;
  }[];
  gaps: { id: string; recordId: string | null; reason: string }[];
  evidence: { id: string; raw: unknown }[];
  annotations?: unknown[];
};
export function parseStaticDocument(input: unknown): StaticDocument {
  const value = input as StaticDocument;
  if (
    !value ||
    value.schemaVersion !== "2.0.0" ||
    !Array.isArray(value.records) ||
    value.records.length > 20000 ||
    !Array.isArray(value.parameters) ||
    value.parameters.length > 200000 ||
    !Array.isArray(value.gaps) ||
    !Array.isArray(value.evidence) ||
    !value.scope ||
    typeof value.scope.complete !== "boolean"
  )
    throw Error("请选择Schema 2.0.0的analysis.json交付文件");
  const ids = new Set<string>(),
    evidence = new Set(value.evidence.map((e) => e.id)),
    gapIds = new Set(value.gaps.map((g) => g.id));
  for (const r of value.records) {
    if (
      !r ||
      typeof r.id !== "string" ||
      ids.has(r.id) ||
      !["repository-static", "website-js-static", "plugin-observed"].includes(
        r.sourceKind,
      ) ||
      !evidence.has(r.evidenceId) ||
      !Array.isArray(r.gapIds) ||
      r.gapIds.some((id) => !gapIds.has(id)) ||
      (r.sourceKind === "plugin-observed" && !r.observation?.requestId)
    )
      throw Error("请求身份、来源或证据关联无效");
    ids.add(r.id);
  }
  if (
    value.parameters.some(
      (f) =>
        !ids.has(f.recordId) ||
        !Array.isArray(f.path) ||
        f.path.some((p) => typeof p !== "string"),
    )
  )
    throw Error("字段与请求关联无效");
  return value;
}
export function analyzerOrigin(input: string) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw Error("服务地址需为HTTPS或本地HTTP根地址");
  return url.origin;
}
export const sourceLabel = (kind: StaticRecord["sourceKind"]) =>
  ({
    "repository-static": "仓库静态",
    "website-js-static": "网站JS静态",
    "plugin-observed": "插件实测",
  })[kind];
