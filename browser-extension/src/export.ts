import { strToU8, zipSync } from "fflate";
import type { Scan, RecordEntry, Batch } from "./model";
import * as db from "./store";
import { matchFilter } from "./filter";
export const jsonl = (rows: unknown[]) =>
  rows.length ? rows.map((x) => JSON.stringify(x)).join("\n") + "\n" : "";
export function csvCell(value: unknown) {
  let s =
    typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function csv(rows: RecordEntry[]) {
  const keys = [
    "request_id",
    "timestamp",
    "page_url",
    "request_url",
    "method",
    "resource_type",
    "status_code",
    "request_state",
    "query_params",
    "request_headers",
    "request_body",
    "initiator_stack",
    "capture_status",
    "protection",
    "group_id",
  ] as const;
  return (
    "\ufeff" +
    keys.join(",") +
    "\r\n" +
    rows.map((r) => keys.map((k) => csvCell(r[k])).join(",")).join("\r\n")
  );
}
export async function packageFiles(
  scan: Scan,
  mode: "all" | "filter" | "selected" = "all",
  selected: string[] = [],
) {
  const files: Record<string, Uint8Array> = {};
  const chunks: {
    file: string;
    count: number;
    bytes: number;
    sha256: string;
  }[] = [];
  let after = "",
    buffer: RecordEntry[] = [],
    size = 0,
    total = 0,
    index = 1;
  const emit = async () => {
    if (!buffer.length) return;
    const file = `requests_${String(index++).padStart(4, "0")}.jsonl`,
      bytes = strToU8(jsonl(buffer));
    files[file] = bytes;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      bytes as Uint8Array<ArrayBuffer>,
    );
    chunks.push({
      file,
      count: buffer.length,
      bytes: bytes.length,
      sha256: [...new Uint8Array(hash)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(""),
    });
    buffer = [];
    size = 0;
  };
  while (true) {
    const rows = await db.page(scan.id, after, 200);
    if (!rows.length) break;
    after = rows.at(-1)!.request_id;
    for (const r of rows) {
      if (
        (mode === "filter" &&
          matchFilter(scan.config.filter, r, true) === "excluded") ||
        (mode === "selected" && !selected.includes(r.request_id))
      )
        continue;
      const bytes = strToU8(JSON.stringify(r)).length;
      if (size + bytes > scan.config.archive.bytes) await emit();
      buffer.push(r);
      size += bytes;
      total += bytes;
      // This release bounds ZIP memory explicitly; automatic shards remain available for larger scans.
      if (total > 64 * 1024 * 1024)
        throw Error(
          "任务包超过 64 MB 内存保护上限，请使用已归档 JSONL 分片；本次未生成部分成功包",
        );
    }
  }
  await emit();
  for (const store of ["groups", "errors"]) {
    const parts: string[] = [];
    let offset = 0;
    while (true) {
      const rows =
        store === "groups"
          ? await db.groupPage(scan.id, offset, 200)
          : await db.errorPage(scan.id, offset, 200);
      if (!rows.length) break;
      const part = jsonl(rows);
      total += strToU8(part).length;
      if (total > 64 * 1024 * 1024)
        throw Error("任务包超过 64 MB；请使用流式目录导出");
      parts.push(part);
      offset += rows.length;
    }
    files[
      store === "groups" ? "request_groups.jsonl" : "capture_errors.jsonl"
    ] = strToU8(parts.join(""));
  }
  const batches = await db.all<Batch>("batches", scan.id);
  files["scan_manifest.json"] = strToU8(
    JSON.stringify(
      {
        schema_version: "0.1.0",
        consistency: scan.state === "ended" ? "stopped_task" : "live_partial",

        scan,
        exported_at: new Date().toISOString(),
        export_scope: mode,
        selected_ids: mode === "selected" ? selected : undefined,
        shards: chunks,
        batches,
        lossy: scan.config.merge === "representative",
        protection_version:
          scan.config.value_storage === "complete"
            ? "retain-complete-v1"
            : "retain-truncate-v1",
        limitations: [
          "响应正文不采集",
          ...(scan.config.value_storage === "complete"
            ? []
            : [
                "字段名完整保存；单个字段值超过 64K 字符时只保留首尾片段",
                "请求正文超过任务字节上限时只保留首尾片段",
              ]),
          "ZIP 导出内存上限 64 MB",
          "WebSocket 帧增强未实现",
          "调用栈与 Worker 覆盖依赖 Chrome 可观测性",
        ],
      },
      null,
      2,
    ),
  );
  return zipSync(files, { level: 1 });
}
