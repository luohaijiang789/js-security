import fs from "node:fs";
import { createHash } from "node:crypto";
import { parameterFields } from "./request-evidence.js";
import { requestRows } from "./request-table.js";
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const stableId = (kind, value) =>
  kind +
  "_" +
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
    .slice(0, 24);
const unknown = (v) =>
  v && typeof v === "object" && Object.hasOwn(v, "__unknown");
const shape = (v) =>
  v === null
    ? "CONFIRMED_ABSENT"
    : v === undefined || (unknown(v) && Object.keys(v).length === 1)
      ? "UNKNOWN"
      : unknown(v)
        ? "PARTIAL"
        : "COMPLETE_WITHIN_MODEL";
const engineVersion = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const sourceKinds = new Set([
  "repository-static",
  "website-js-static",
  "plugin-observed",
]);
function observedRows(entries) {
  return entries.map((r) => {
    if (
      typeof r.request_id !== "string" ||
      typeof r.scan_id !== "string" ||
      typeof r.request_url !== "string"
    )
      throw new Error("实测记录缺少 scan/request ID 或 URL");
    let url;
    try {
      url = new URL(r.request_url);
    } catch {
      throw new Error("实测URL无效");
    }
    const fieldPairs = (values, carrier) =>
      (values ?? []).map((p, index) => ({
        carrier,
        path: [p.name],
        entryIndex: index,
        state: "observed-field",
        stage: "observed",
      }));
    const fields = [
      ...fieldPairs(r.query_params, "query"),
      ...fieldPairs(r.request_headers, "headers"),
    ];
    if (r.request_body?.parsed && typeof r.request_body.parsed === "object")
      fields.push(
        ...parameterFields({ body: r.request_body.parsed }, null).map((f) => ({
          ...f,
          stage: "observed",
          state: f.state === "known-field" ? "observed-field" : f.state,
        })),
      );
    const captureGaps = Object.entries(r.capture_status ?? {})
      .filter(([, q]) => q?.state && q.state !== "complete")
      .map(
        ([carrier, q]) =>
          "采集 " + carrier + ": " + q.state + " " + (q.reason ?? ""),
      );
    return {
      sourceKind: "plugin-observed",
      discoveryBasis: "cdp-observation",
      sourceFile: null,
      sourceLine: null,
      sourceColumn: null,
      stage: "observed",
      method: r.method ?? null,
      host: url.host,
      url: r.request_url,
      resolvedUrl: r.request_url,
      query: r.query_params ?? { __unknown: "not captured" },
      headers: r.request_headers ?? { __unknown: "not captured" },
      body: r.request_body ?? { __unknown: "not captured" },
      parameterFields: fields,
      conditions: [],
      callChain: [],
      gaps: captureGaps,
      observation: {
        scanId: r.scan_id,
        requestId: r.request_id,
        sessionId: r.session_id ?? null,
        targetId: r.target_id ?? null,
        redirectHop: r.redirect_hop ?? 0,
        timestamp: r.timestamp ?? null,
        pageUrl: r.page_url ?? null,
        captureStatus: r.capture_status ?? {},
        protection: r.protection ?? null,
      },
      raw: r,
    };
  });
}
export function toDelivery(input, metadata = {}) {
  if (input.schemaVersion === "2.0.0") {
    if (
      !Array.isArray(input.records) ||
      !Array.isArray(input.parameters) ||
      !Array.isArray(input.gaps) ||
      !Array.isArray(input.evidence)
    )
      throw new Error("交付2.0结构无效");
    const ids = new Set(input.records.map((r) => r.id)),
      evidenceIds = new Set(input.evidence.map((e) => e.id)),
      gapIds = new Set(input.gaps.map((g) => g.id));
    if (ids.size !== input.records.length) throw new Error("重复的交付记录ID");
    for (const r of input.records)
      if (
        !sourceKinds.has(r.sourceKind) ||
        !evidenceIds.has(r.evidenceId) ||
        !Array.isArray(r.gapIds) ||
        r.gapIds.some((id) => !gapIds.has(id))
      )
        throw new Error("不支持的证据来源或证据关联无效");
    for (const f of input.parameters)
      if (
        !ids.has(f.recordId) ||
        typeof f.carrier !== "string" ||
        !Array.isArray(f.path) ||
        f.path.some((p) => typeof p !== "string")
      )
        throw new Error("交付字段关联/类型无效");
    return structuredClone(input);
  }
  if (
    input.schemaVersion !== undefined &&
    ![1, "1"].includes(input.schemaVersion)
  )
    throw new Error("不支持的旧Schema，不能静默迁移");
  const rows =
    input.rows ??
    (Array.isArray(input.observations)
      ? observedRows(input.observations)
      : input.endpoints
        ? requestRows(input, { ...input, ...metadata })
        : null);
  if (!Array.isArray(rows))
    throw new Error("交付输入必须有 rows、endpoints 或 observations");
  const records = [],
    parameters = [],
    gaps = [],
    evidence = [],
    assets = [],
    seenAssets = new Set(),
    assetIds = new Map(),
    recordOccurrences = new Map(), sharedRequestGaps=new Map();
  for (const a of input.assets ?? []) {
    const id = stableId("asset", [
      a.sha256 ?? null,
      a.file ?? a.url ?? null,
      input.repository ?? null,
      input.commit ?? null,
    ]);
    if (!seenAssets.has(id)) {
      assets.push({ ...a, id, sourceAssetId: a.id ?? null });
      seenAssets.add(id);
    }
    if (a.id) assetIds.set(a.id, id);
  }
  for (const row of rows) {
    for (const field of ["method", "url", "host"])
      if (
        row[field] !== undefined &&
        row[field] !== null &&
        typeof row[field] !== "string"
      )
        throw new Error("旧请求字段类型无效: " + field);
    const sourceKind =
      row.sourceKind ?? metadata.sourceKind ?? "repository-static";
    if (!sourceKinds.has(sourceKind)) throw new Error("不支持的证据来源");
    if (sourceKind === "plugin-observed" && !row.observation?.requestId)
      throw new Error("实测行必须带原始请求身份");
    const businessCallSite=row.businessCallSite??row.callChain?.slice(0,-1).findLast(p=>p.file!==row.sourceFile)??{file:row.sourceFile??null,line:row.sourceLine??null,column:row.sourceColumn??null};
    const anchor = [
      sourceKind,
      row.repository ?? input.repository ?? null,
      row.commit ?? input.commit ?? null,
      row.sourceFile,
      row.sourceLine,
      row.sourceColumn,
      [businessCallSite.file,businessCallSite.line,businessCallSite.column],
      row.deploymentUrl ?? null,
      row.observation ?? null,
      row.assetId ?? null,
      row.scriptSha256 ?? null,
      row.executionContext ?? null,
    ];
    const callSiteId = stableId("call", anchor),
      snapshot = [
        anchor, row.stage, row.conditions??[], row.callChain??[], row.entry??null,
        row.method,
        row.url,
        row.query,
        row.body,
        row.headers,
      ],
      key = stableId("record", snapshot),
      occurrence = recordOccurrences.get(key) ?? 0;
    recordOccurrences.set(key, occurrence + 1);
    const id = occurrence ? stableId("record", [snapshot, occurrence]) : key;
    const evidenceId = stableId("evidence", row);
    evidence.push({ id: evidenceId, sourceKind, raw: row });
    let pathname = null;
    try {
      const address=row.requestPath??row.resolvedUrl??row.url;
      if(typeof address==='string'&&address&&!/[{}]/.test(address))pathname=new URL(address,"https://context.invalid/").pathname;
    } catch {}
    const record = {
      id,
      callSiteId,
      businessCallSite,
      sendMechanism:row.sendMechanism??null,
      assetId: assetIds.get(row.assetId) ?? null,
      sourceKind,
      discoveryBasis: row.discoveryBasis ?? "unknown",
      linkState:row.linkState??null,
      apiGroupId: stableId("group", [row.method, row.host, pathname??row.requestUrl??row.url]),
      associationState: "candidate-only",
      method: row.method ?? null,
      host: row.host ?? null,
      url: row.url ?? null,
      requestUrl:row.requestUrl??row.url??null,
      resolvedUrl: row.resolvedUrl ?? null,
      path: pathname,
      hostBasis:
        row.hostBasis ??
        (sourceKind === "plugin-observed" ? "observed" : "unknown"),
      addressState:
        row.host && !/[{}]/.test(row.url ?? "")
          ? row.hostState === "context-candidate"
            ? "PARTIAL"
            : "RESOLVED"
          : row.host || (row.url && !/^\{[^}]+\}$/.test(row.url))
            ? "PARTIAL"
            : "UNKNOWN",
      methodState:
        row.method && !/[{}]/.test(row.method) ? "RESOLVED" : "UNKNOWN",
      carrierStates:
        sourceKind === "plugin-observed"
          ? null
          : {
              query: shape(row.query),
              body: shape(row.body),
              headers: shape(row.headers),
            },
      captureStates:
        sourceKind === "plugin-observed" ? row.observation.captureStatus : null,
      stage: row.stage ?? "call-site",
      resolution:
        row.resolution ??
        (sourceKind === "plugin-observed" ? "observed" : "unknown"),
      repository: row.repository ?? input.repository ?? null,
      commit: row.commit ?? input.commit ?? null,
      sourceFile: row.sourceFile ?? null,
      sourceLine: row.sourceLine ?? null,
      sourceColumn: row.sourceColumn ?? null,
      generatedFile: row.generatedFile ?? null,
      generatedLine: row.generatedLine ?? null,
      generatedColumn: row.generatedColumn ?? null,
      conditions: row.conditions ?? [],
      observation: row.observation ?? null,
      evidenceId,
      gapIds: [],
    };
    const fieldOccurrences = new Map();
    for (const f of [
      ...(row.parameterFields ?? []),
      ...(row.hookFieldCandidates ?? []).map((f) => ({
        ...f,
        state: f.path.length ? "candidate-field" : "unknown-replacement",
      })),
    ]) {
      const k = JSON.stringify([
          f.carrier,
          f.path,
          f.stage ?? row.stage,
          f.state,
        ]),
        n = fieldOccurrences.get(k) ?? 0;
      fieldOccurrences.set(k, n + 1);
      const fieldId = stableId("field", [
        id,
        f.carrier,
        f.path,
        f.stage ?? row.stage,
        f.entryIndex ?? n,
        f.state,
      ]);
      parameters.push({
        id: fieldId,
        recordId: id,
        evidenceId,
        carrier: f.carrier,
        path: f.path,
        entryIndex: f.entryIndex ?? null,
        stage: f.stage ?? row.stage,
        conditions: f.conditions ?? row.conditions ?? [],
        operation: f.operation ?? null,
        state: f.state,
        valueProtection: "omitted-in-workbook",
      });
    }
    for (const reason of row.gaps ?? []) {
      const gapId = stableId("gap", [callSiteId, reason]);
      let gap=sharedRequestGaps.get(gapId);
      if(!gap){gap={id:gapId,recordId:id,recordIds:[id],assetId:null,code:"REQUEST_UNRESOLVED",reason,impact:"此调用存在未解析项",location:[row.sourceFile,row.sourceLine,row.sourceColumn]};sharedRequestGaps.set(gapId,gap);gaps.push(gap);}
      else {if(!record.gapIds.includes(gapId))gap.recordIds.push(id);gap.recordId=gap.recordIds.length===1?id:null;}
      if(!record.gapIds.includes(gapId))record.gapIds.push(gapId);
    }
    records.push(record);
  }
  for (const d of input.diagnostics ?? []) {
    const id = stableId("gap", d);
    gaps.push({
      id,
      recordId: null,
      assetId: null,
      code: d.code ?? "ANALYSIS_GAP",
      reason: d.message ?? String(d),
      impact: "分析范围可能不完整",
      location: [d.file ?? null, d.line ?? null, d.column ?? null],
    });
  }
  for (const reason of [...(input.buildGaps ?? []), ...(input.gaps ?? [])])
    gaps.push({
      id: stableId("gap", ["task", reason]),
      recordId: null,
      assetId: null,
      code: "TASK_GAP",
      reason,
      impact: "任务范围存在缺口",
      location: null,
    });
  return {
    schemaVersion: "2.0.0",
    modelVersion:
      metadata.modelVersion ?? "frontend-api-extractor/" + engineVersion,
    migration: {
      from: input.schemaVersion ?? "rows-v1",
      policy: "additive-adapter; no inferred source/version",
      identityVersion:"call-site-v2",
    },
    scope: {
      repository: input.repository ?? metadata.repository ?? null,
      commit: input.commit ?? metadata.commit ?? null,
      mode: input.mode ?? metadata.mode ?? null,
      complete: input.stats?.complete === true && !gaps.length,
      coverage:input.stats?.coverage??null,
      outcome:input.stats?.outcome??null,
    },
    records,
    parameters,
    gaps,
    assets,
    evidence,
    annotations: [],
    sourceReport: input,
  };
}
