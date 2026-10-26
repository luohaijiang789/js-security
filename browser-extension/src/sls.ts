import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  Batch,
  RecordEntry,
  Scan,
  SlsConfig,
  SlsCredentials,
} from "./model";

const encoder = new TextEncoder();
const LOG_CHUNK_BYTES = 512 * 1024;
const SEARCH_VALUE_CHARS = 8192;

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function cleanEndpoint(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, "");
}

export function slsBaseURL(config: SlsConfig) {
  const endpoint = cleanEndpoint(config.endpoint);
  if (/^https:\/\//i.test(endpoint)) return new URL(endpoint).origin;
  return `https://${config.project}.${endpoint}`;
}

export function slsResourcePath(config: SlsConfig) {
  return `/logstores/${encodeURIComponent(config.logstore)}`;
}

export function slsWriteURL(config: SlsConfig) {
  const direct = slsBaseURL(config) + slsResourcePath(config);
  return config.mode === "web_tracking"
    ? direct + "/track?APIVersion=0.6.0"
    : direct;
}

export function slsCredentialKey(config: SlsConfig) {
  return [slsBaseURL(config), config.project, config.logstore].join("|");
}

export function slsCredentialSummary(credentials: SlsCredentials) {
  const id = credentials.access_key_id;
  const visible = id.length >= 12 ? 4 : id.length >= 6 ? 2 : 1;
  const visibleStart = id.slice(0, visible);
  const visibleEnd = id.slice(-visible);
  const maskedId = `${visibleStart}••••${visibleEnd}`;
  return `AccessKey ID ${maskedId} · AccessKey Secret 已保存 · ${
    credentials.security_token
      ? "SecurityToken 已保存"
      : "SecurityToken 未保存（长期 AccessKey 可不需要）"
  }`;
}

function splitUtf8(value: string, limit = LOG_CHUNK_BYTES) {
  if (encoder.encode(value).length <= limit) return [value];
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1,
      high = Math.min(value.length, start + limit),
      best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const size = encoder.encode(value.slice(start, middle)).length;
      if (size <= limit) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (
      best < value.length &&
      value.charCodeAt(best - 1) >= 0xd800 &&
      value.charCodeAt(best - 1) <= 0xdbff
    )
      best--;
    chunks.push(value.slice(start, best));
    start = best;
  }
  return chunks;
}

function string(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function searchValue(value: unknown) {
  const result = string(value);
  return result.length <= SEARCH_VALUE_CHARS
    ? result
    : result.slice(0, SEARCH_VALUE_CHARS) +
        "…[SLS检索字段已截断，完整值见记录分片]";
}

function recordLogs(
  record: RecordEntry,
  batch: Batch,
  scan: Scan,
  chunkBytes: number,
) {
  const json = JSON.stringify(record);
  const chunks = splitUtf8(json, chunkBytes);
  const digest = bytesToHex(sha256(utf8ToBytes(json)));
  return chunks.map((chunk, index) => ({
    __time__: Math.floor((Date.parse(record.timestamp) || Date.now()) / 1000),
    scan_id: scan.id,
    scan_name: scan.name,
    transfer_batch_id: batch.id,
    request_id: record.request_id,
    request_timestamp: record.timestamp,
    method: record.method,
    request_url: searchValue(record.request_url),
    domain: searchValue(record.domain),
    pathname: searchValue(record.pathname),
    resource_type: record.resource_type,
    status_code: string(record.status_code),
    request_state: record.request_state,
    page_url: searchValue(record.page_url),
    initiator_url: searchValue(record.initiator_url),
    filter_result: string(record.filter_result),
    group_id: string(record.group_id),
    record_sha256: digest,
    record_chunk_index: String(index + 1),
    record_chunk_total: String(chunks.length),
    record_json_chunk: chunk,
  }));
}

function assemblePayload(
  logs: Array<Record<string, string | number>>,
  batch: Batch,
  scan: Scan,
  config: SlsConfig,
  part: number,
  parts: number,
) {
  return JSON.stringify({
    __logs__: logs.map((log) => ({
      ...log,
      transfer_part_index: String(part),
      transfer_part_total: String(parts),
    })),
    ...(config.topic ? { __topic__: config.topic } : {}),
    ...(config.source ? { __source__: config.source } : {}),
    __tags__: {
      producer: "js-security-browser-extension",
      scan_id: scan.id,
      transfer_batch_id: batch.id,
    },
  });
}

export function slsPayloads(
  rows: RecordEntry[],
  batch: Batch,
  scan: Scan,
  config: SlsConfig,
) {
  const chunkBytes = Math.min(
    LOG_CHUNK_BYTES,
    Math.floor(config.batch_bytes * 0.7),
  );
  const logs = rows.flatMap((record) =>
    recordLogs(record, batch, scan, chunkBytes),
  );
  const groups: Array<Array<Record<string, string | number>>> = [];
  let group: Array<Record<string, string | number>> = [];
  for (const log of logs) {
    const candidate = [...group, log];
    if (
      group.length &&
      encoder.encode(assemblePayload(candidate, batch, scan, config, 1, 1))
        .length > config.batch_bytes
    ) {
      groups.push(group);
      group = [log];
    } else group = candidate;
  }
  if (group.length) groups.push(group);
  const payloads = groups.map((items, index) =>
    assemblePayload(items, batch, scan, config, index + 1, groups.length),
  );
  if (
    payloads.some(
      (payload) => encoder.encode(payload).length > config.batch_bytes,
    )
  )
    throw Error("单条 SLS 日志超过批次字节上限，请提高每批上限或启用自动截断");
  return payloads;
}

export function signSlsRequest(
  body: string,
  path: string,
  credentials: SlsCredentials,
  date = new Date().toUTCString(),
): Record<string, string> {
  const bytes = utf8ToBytes(body);
  const contentMd5 = bytesToHex(md5(bytes)).toUpperCase();
  const canonicalHeaders: Record<string, string> = {
    "x-log-apiversion": "0.6.0",
    "x-log-bodyrawsize": String(bytes.length),
    "x-log-signaturemethod": "hmac-sha1",
    ...(credentials.security_token
      ? { "x-acs-security-token": credentials.security_token }
      : {}),
  };
  const canonical = Object.entries(canonicalHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const stringToSign =
    `POST\n${contentMd5}\napplication/json\n${date}\n` + canonical + path;
  const signature = base64(
    hmac(
      sha1,
      utf8ToBytes(credentials.access_key_secret),
      utf8ToBytes(stringToSign),
    ),
  );
  return {
    "Content-Type": "application/json",
    "Content-MD5": contentMd5,
    ...canonicalHeaders,
    "x-log-date": date,
    Authorization: `LOG ${credentials.access_key_id}:${signature}`,
  };
}

export async function writeSlsPayload(
  config: SlsConfig,
  payload: string,
  credentials?: SlsCredentials,
) {
  if (
    config.mode === "sts" &&
    (!credentials?.access_key_id || !credentials.access_key_secret)
  )
    throw Error("缺少 AccessKey ID 或 AccessKey Secret");
  const headers = credentials
    ? signSlsRequest(payload, slsResourcePath(config), credentials)
    : undefined;
  const response = await fetch(slsWriteURL(config), {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15000),
    ...(headers ? { headers } : {}),
    body: payload,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Error(
      `SLS 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ""}`,
    );
  }
  return response.headers?.get("x-log-requestid") ?? undefined;
}

export async function testSlsConnection(
  config: SlsConfig,
  credentials?: SlsCredentials,
  testedAt = new Date(),
) {
  const timestamp = testedAt.toISOString();
  const payload = JSON.stringify({
    __logs__: [
      {
        __time__: Math.floor(testedAt.getTime() / 1000),
        connection_test: "true",
        producer: "js-security-browser-extension",
        tested_at: timestamp,
        message: "js-security 浏览器插件 SLS 连接测试",
      },
    ],
    ...(config.topic ? { __topic__: config.topic } : {}),
    ...(config.source ? { __source__: config.source } : {}),
    __tags__: {
      producer: "js-security-browser-extension",
      connection_test: "true",
    },
  });
  return writeSlsPayload(config, payload, credentials);
}
