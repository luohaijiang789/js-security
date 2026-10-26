// Frozen v1 serialization for batches created before sls-2. Retries must
// preserve their original content, chunk boundaries and deduplication keys.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Batch, RecordEntry, Scan, SlsConfig } from "./model";
const encoder = new TextEncoder();
const LOG_CHUNK_BYTES = 512 * 1024;
const SEARCH_VALUE_CHARS = 8192;
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

export function legacySlsPayloads(
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
