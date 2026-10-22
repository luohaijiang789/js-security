import * as db from "./store";
import type { Scan, Batch, RecordEntry } from "./model";
import { uid, now } from "./model";
import { jsonl } from "./export";
const locks = new Set<string>();
async function rowsFor(b: Batch) {
  const rows: RecordEntry[] = [];
  for (const id of b.records) {
    const r = await db.get<RecordEntry>("requests", id);
    if (!r) throw Error("批次引用的原始记录缺失");
    rows.push(r);
  }
  return rows;
}
function dataURL(s: string) {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return "data:application/x-ndjson;base64," + btoa(binary);
}
export async function sendBatch(batch: Batch, scan: Scan) {
  if (
    locks.has(batch.id) ||
    batch.state === "complete" ||
    batch.state === "downloading" ||
    batch.attempts >= 3 ||
    batch.next_retry > Date.now()
  )
    return;
  locks.add(batch.id);
  try {
    batch.attempts++;
    batch.state = "pending";
    await db.put("batches", batch);
    const rows = await rowsFor(batch);
    if (batch.channel === "file") {
      batch.filename = `EO_SCAN_${scan.started_at.slice(0, 10)}_${scan.id}/requests_${batch.id}.jsonl`;
      batch.download_id = await chrome.downloads.download({
        url: dataURL(jsonl(rows)),
        filename: batch.filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      batch.state = "downloading";
      await db.put("batches", batch);
      // onChanged can fire before download() resolves; reconcile immediately as well.
      const [item] = await chrome.downloads.search({ id: batch.download_id });
      if (item?.state === "complete") batch.state = "complete";
      else if (item?.state === "interrupted") throw Error("文件下载中断");
    } else {
      const url = batch.receiver_url ?? scan.config.service.url;
      const origin = new URL(url).origin;
      if (!(await chrome.permissions.contains({ origins: [origin + "/*"] })))
        throw Error("接收服务未授权或权限已撤销");
      const stored = await chrome.storage.session.get("service_tokens");
      const token = (
        stored.service_tokens as Record<string, string> | undefined
      )?.[origin];
      const payload = JSON.stringify({
        schema_version: "0.1.0",
        batch_id: batch.id,
        scan_id: scan.id,
        records: rows,
      });
      const compressed = batch.compressed ?? scan.config.service.compress;
      const body = compressed
        ? await new Response(
            new Blob([payload])
              .stream()
              .pipeThrough(new CompressionStream("gzip")),
          ).blob()
        : payload;
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": batch.id,
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body,
      });
      if (!response.ok) throw Error(`服务返回 HTTP ${response.status}`);
      const ack = await response.json();
      if (ack.batch_id !== batch.id || ack.persisted !== true)
        throw Error("缺少匹配 batch_id 和 persisted:true 的持久化确认");
      batch.state = "complete";
    }
    delete batch.error;
    await db.put("batches", batch);
  } catch (e) {
    batch.state = "failed";
    batch.error = String(e instanceof Error ? e.message : e);
    batch.next_retry = Date.now() + 1000 * 2 ** batch.attempts;
    await db.put("batches", batch);
  } finally {
    locks.delete(batch.id);
  }
}
export async function transfer(scan: Scan, force = false) {
  const lock = scan.id + ":plan";
  if (locks.has(lock)) return;
  locks.add(lock);
  try {
    const existing = await db.all<Batch>("batches", scan.id);
    for (const b of existing) {
      if (b.state === "downloading" && b.download_id !== undefined) {
        const [item] = await chrome.downloads.search({ id: b.download_id });
        if (item?.state === "complete") {
          b.state = "complete";
          await db.put("batches", b);
        } else if (!item || item.state === "interrupted") {
          b.state = "failed";
          b.error = "下载取消、中断或记录不可查";
          await db.put("batches", b);
        }
      }
    }
    for (const channel of ["file", "service"] as const) {
      const enabled =
        channel === "file"
          ? scan.config.archive.enabled
          : scan.config.service.enabled;
      if (!enabled) continue;
      const last =
        existing
          .filter((b) => b.channel === channel)
          .map((b) => Date.parse(b.created_at))
          .sort((a, b) => b - a)[0] ?? Date.parse(scan.started_at);
      let after = Math.max(
          0,
          ...existing
            .filter((b) => b.channel === channel)
            .map((b) => b.last_ordinal ?? 0),
        ),
        buffer: RecordEntry[] = [],
        bytes = 0;
      const maxCount =
        channel === "service"
          ? scan.config.service.batch_size
          : scan.config.archive.count;
      const maxBytes = scan.config.archive.bytes;
      const emit = async () => {
        if (!buffer.length) return;
        const batch: Batch = {
          id: uid(),
          scan_id: scan.id,
          channel,
          state: "pending",
          records: buffer.map((r) => r.request_id),
          attempts: 0,
          next_retry: 0,
          created_at: now(),
          last_ordinal: buffer.at(-1)?.ordinal,
          receiver_url:
            channel === "service" ? scan.config.service.url : undefined,
          compressed:
            channel === "service" ? !!scan.config.service.compress : undefined,
        };
        await db.put("batches", batch);
        existing.push(batch);
        buffer = [];
        bytes = 0;
      };
      while (true) {
        const rows = await db.archivePage(scan.id, after, 200);
        if (!rows.length) break;
        after = rows.at(-1)!.ordinal!;
        for (const r of rows) {
          const size = new TextEncoder().encode(JSON.stringify(r)).length;
          if (bytes + size > maxBytes) await emit();
          buffer.push(r);
          bytes += size;
          if (buffer.length >= maxCount || bytes >= maxBytes) await emit();
        }
      }
      if (
        force ||
        Date.now() - last >=
          (channel === "service"
            ? (scan.config.service.interval_ms ?? 5000)
            : scan.config.archive.interval_ms)
      )
        await emit();
    }
    // Bounded per tick: alarms continue the backlog. Failed items retain stable batch IDs.
    for (const b of existing
      .filter(
        (b) =>
          (b.state === "pending" || b.state === "failed") &&
          b.attempts < 3 &&
          b.next_retry <= Date.now(),
      )
      .slice(0, 4)) {
      if (
        (b.channel === "service" && !scan.config.service.enabled) ||
        (b.channel === "file" && !scan.config.archive.enabled)
      )
        continue;
      await sendBatch(b, scan);
    }
  } finally {
    locks.delete(lock);
  }
}
export async function downloadChanged(delta: chrome.downloads.DownloadDelta) {
  if (!delta.state && !delta.error) return;
  for (const b of await db.all<Batch>("batches"))
    if (b.download_id === delta.id) {
      b.state =
        delta.state?.current === "complete"
          ? "complete"
          : delta.state?.current === "interrupted" || delta.error
            ? "failed"
            : b.state;
      if (delta.error) b.error = delta.error.current;
      await db.put("batches", b);
    }
}
