import { evidenceDatabase, evidenceWrite } from "./evidence-db";
import type { CaptureEvent } from "../domain/evidence";
export const JOURNAL_LIMITS = {
  tracking_count: 16384,
  count: 16384,
  bytes: 64 * 1048576,
  memory_count: 4096,
  memory_bytes: 32 * 1048576,
};
import type { JournalStatus } from "../domain/evidence";
export type { JournalStatus } from "../domain/evidence";
export type JournalRow = {
  id: string;
  scan_id: string;
  scope: string;
  method: string;
  bytes: number;
  storage_bytes: number;
  event: CaptureEvent;
};
const globalKey = "__all_pending__";
export const emptyJournal = (scan: string, scope = ""): JournalStatus => ({
  scan_id: scan,
  scope,
  admitted: 0,
  handed_off: 0,
  pending: 0,
  pending_bytes: 0,
  bytes: 0,
  by_kind: {},
});

export async function appendJournal(rows: JournalRow[]) {
  if (!rows.length) return;
  let failure: unknown;
  try {
    await evidenceWrite(
      (tx) => {
        const journal = tx.objectStore("capture_journal"),
          ledgers = tx.objectStore("journal_ledgers");
        const scans = [globalKey, ...new Set(rows.map((row) => row.scan_id))];
        const meta = new Map<string, JournalStatus>();
        const existing = new Map<string, JournalRow>();
        let remaining = scans.length + rows.length;
        const ready = () => {
          if (--remaining) return;
          try {
            const global = meta.get(globalKey)!;
            for (const row of rows) {
              const previous = existing.get(row.id);
              if (previous) {
                if (
                  previous.event.data.capture_json !==
                    row.event.data.capture_json ||
                  previous.scan_id !== row.scan_id
                )
                  throw Error("原始日志身份冲突");
                continue;
              }
              const scan = meta.get(row.scan_id)!;
              if (scan.scope && scan.scope !== row.scope)
                throw Error("原始日志接收地址不匹配");
              if (
                global.pending >= JOURNAL_LIMITS.count ||
                global.pending_bytes + row.storage_bytes > JOURNAL_LIMITS.bytes
              )
                throw Error(
                  "原始日志达到16384项/64MiB上限，未接纳，必须保留缺口",
                );
              scan.scope = row.scope;
              scan.admitted++;
              scan.pending++;
              scan.pending_bytes += row.storage_bytes;
              scan.bytes += row.bytes;
              scan.by_kind[row.method] = (scan.by_kind[row.method] ?? 0) + 1;
              global.pending++;
              global.pending_bytes += row.storage_bytes;
              journal.add(row);
            }
            for (const value of meta.values()) ledgers.put(value);
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        for (const scan of scans) {
          const request = ledgers.get(scan);
          request.onsuccess = () => {
            meta.set(scan, request.result ?? emptyJournal(scan));
            ready();
          };
        }
        for (const row of rows) {
          const request = journal.get(row.id);
          request.onsuccess = () => {
            if (request.result) existing.set(row.id, request.result);
            ready();
          };
        }
      },
      ["capture_journal", "journal_ledgers"],
    );
  } catch (error) {
    throw failure ?? error;
  }
}

/** Called inside the SAME strict transaction that admits the transport payload. */
export function handoffJournal(tx: IDBTransaction, entry: any) {
  if (!entry.journal_id) return;
  const store = tx.objectStore("capture_journal"),
    ledgers = tx.objectStore("journal_ledgers");
  const request = store.get(entry.journal_id);
  request.onsuccess = () => {
    const row = request.result as JournalRow | undefined;
    if (!row) return; // Idempotent retry of an already committed local handoff.
    if (
      row.event.id !== entry.event.id ||
      row.scan_id !== entry.event.scan_id ||
      row.scope !== entry.scope ||
      row.event.data.capture_sha256 !== entry.event.data.capture_sha256
    ) {
      tx.abort();
      return;
    }
    for (const key of [row.scan_id, globalKey]) {
      const get = ledgers.get(key);
      get.onsuccess = () => {
        const meta = get.result as JournalStatus;
        if (
          !meta ||
          meta.pending < 1 ||
          meta.pending_bytes < row.storage_bytes
        ) {
          tx.abort();
          return;
        }
        meta.pending--;
        meta.pending_bytes -= row.storage_bytes;
        if (key !== globalKey) meta.handed_off++;
        ledgers.put(meta);
      };
    }
    store.delete(row.id);
  };
}
export async function journalSnapshot(scan: string): Promise<JournalStatus> {
  const db = await evidenceDatabase();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("journal_ledgers")
      .objectStore("journal_ledgers")
      .get(scan);
    request.onsuccess = () => resolve(request.result ?? emptyJournal(scan));
    request.onerror = () => reject(request.error);
  });
}
export async function journalRows(
  scan: string,
  limit = 4,
): Promise<JournalRow[]> {
  const db = await evidenceDatabase();
  return new Promise((resolve, reject) => {
    const rows: JournalRow[] = [];
    const request = db
      .transaction("capture_journal")
      .objectStore("capture_journal")
      .index("scan")
      .openCursor(IDBKeyRange.only(scan));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
