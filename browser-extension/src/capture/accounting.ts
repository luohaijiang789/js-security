import { evidenceDatabase, evidenceWrite } from "../storage/evidence-db";
type Counts = { observed: number; dispatched: number; rejected: number };
type Row = { scan_id: string; by_kind: Record<string, Counts> };
export class CaptureAccounting {
  private pending = new Map<string, Row>();
  private tail: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private batch?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  };
  note(scan: string, kind: string, state: keyof Counts): Promise<void> {
    let row = this.pending.get(scan);
    if (!row) {
      row = { scan_id: scan, by_kind: {} };
      this.pending.set(scan, row);
    }
    const count = (row.by_kind[kind] ??= {
      observed: 0,
      dispatched: 0,
      rejected: 0,
    });
    count[state]++;
    if (!this.batch) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.batch = { promise, resolve, reject };
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, 5);
    }
    return this.batch.promise;
  }
  async flush() {
    clearTimeout(this.timer);
    const rows = [...this.pending.values()],
      batch = this.batch;
    this.pending.clear();
    this.batch = undefined;
    const operation = this.tail.then(async () => {
      if (!rows.length) return;
      try {
        await evidenceWrite(
          (tx) => {
            const store = tx.objectStore("capture_counters");
            for (const row of rows) {
              const get = store.get(row.scan_id);
              get.onsuccess = () => {
                const stored: Row = get.result ?? {
                  scan_id: row.scan_id,
                  by_kind: {},
                };
                for (const [kind, delta] of Object.entries(row.by_kind)) {
                  const current = (stored.by_kind[kind] ??= {
                    observed: 0,
                    dispatched: 0,
                    rejected: 0,
                  });
                  for (const key of [
                    "observed",
                    "dispatched",
                    "rejected",
                  ] as const)
                    current[key] += delta[key];
                }
                store.put(stored);
              };
            }
          },
          ["capture_counters"],
        );
        batch?.resolve();
      } catch (error) {
        for (const row of rows) {
          const pending = this.pending.get(row.scan_id) ?? {
            scan_id: row.scan_id,
            by_kind: {},
          };
          for (const [kind, delta] of Object.entries(row.by_kind)) {
            const current = (pending.by_kind[kind] ??= {
              observed: 0,
              dispatched: 0,
              rejected: 0,
            });
            for (const key of ["observed", "dispatched", "rejected"] as const)
              current[key] += delta[key];
          }
          this.pending.set(row.scan_id, pending);
        }
        batch?.reject(error);
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    await operation;
  }
  async snapshot(scan: string) {
    await this.flush();
    const db = await evidenceDatabase();
    return new Promise<Row>((resolve, reject) => {
      const request = db
        .transaction("capture_counters")
        .objectStore("capture_counters")
        .get(scan);
      request.onsuccess = () =>
        resolve(request.result ?? { scan_id: scan, by_kind: {} });
      request.onerror = () => reject(request.error);
    });
  }
}
export const captureAccounting = new CaptureAccounting();
