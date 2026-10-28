import fs from "node:fs";
export const sdkModel = JSON.parse(
  fs.readFileSync(
    new URL("../models/aliyun-sdk-1.12.3.json", import.meta.url),
    "utf8",
  ),
);
const unknown = (expression) => ({ __unknown: expression });
export function sdkHttpModel(candidate) {
  if (candidate.configurationState === "unknown") return null;
  if (
    candidate.candidateKind !== "sdk-operation" ||
    candidate.module !== sdkModel.module ||
    candidate.sdkVersion !== sdkModel.version
  )
    return null;
  const service = sdkModel.services[candidate.service],
    operation = service?.operations[candidate.operation];
  if (
    !operation ||
    (candidate.apiVersion && candidate.apiVersion !== service.apiVersion)
  )
    return null;
  const input = candidate.input;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => k !== "__unknown" && !operation.inputFields.includes(k),
    )
  )
    return null;
  if (
    !input.__unknown &&
    operation.required.some((key) => !Object.hasOwn(input, key))
  )
    return null;
  for (const [key, value] of Object.entries(input)) {
    if (
      key === "__unknown" ||
      (value && typeof value === "object" && value.__unknown)
    )
      continue;
    const type = operation.types[key];
    if (
      value === null ||
      (value && typeof value === "object") ||
      (type === "string" && typeof value !== "string") ||
      (["integer", "long"].includes(type) && !Number.isInteger(value)) ||
      (["float", "double"].includes(type) &&
        !(typeof value === "number" && Number.isFinite(value))) ||
      (type === "boolean" && typeof value !== "boolean")
    )
      return null;
  }
  let endpoint;
  try {
    endpoint = new URL(candidate.endpoint);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      return null;
  } catch {}
  const body = {
    ...operation.defaults,
    ...input,
    Format: "JSON",
    Version: service.apiVersion,
    AccessKeyId: unknown("SDK credentials"),
    SignatureVersion: "1.0",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: unknown("SDK nonce"),
    Timestamp: unknown("SDK clock"),
    Signature: unknown("SDK signature"),
  };
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": unknown("SDK runtime user agent"),
    "Content-Length": unknown("encoded body byte length"),
    Host: endpoint?.host ?? unknown("SDK endpoint"),
  };
  const url = endpoint
    ? endpoint.origin + operation.path
    : "{SDK.endpoint}" + operation.path;
  const fields = [];
  for (const [carrier, value] of [
    ["body", body],
    ["headers", headers],
  ])
    for (const [key, item] of Object.entries(value))
      fields.push({
        carrier,
        path: key === "__unknown" ? [] : [key],
        state: key === "__unknown" ? "unknown-spread" : "known-field",
        stage: "sdk-protocol-build",
        ...(item && typeof item === "object" ? { valueState: "unknown" } : {}),
      });
  return {
    method: operation.method,
    url,
    host: endpoint?.host ?? null,
    path: operation.path,
    query: null,
    body,
    headers,
    parameterFields: fields,
    model: {
      module: sdkModel.module,
      version: sdkModel.version,
      service: candidate.service,
      apiVersion: service.apiVersion,
      scope: sdkModel.scope,
    },
    encoding: "application/x-www-form-urlencoded",
    signatureState: "unknown",
  };
}

export function encodeSdkParameters(params) {
  const escape = (value) =>
    encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  return Object.keys(params)
    .sort()
    .map(
      (name) =>
        escape(name) +
        (params[name] === null || params[name] === undefined
          ? ""
          : "=" + escape(params[name])),
    )
    .join("&");
}
