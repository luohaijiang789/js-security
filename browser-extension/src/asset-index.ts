import { now } from "./model";
import { database } from "./store";

/**
 * Lightweight, bounded index of what was captured per project and URL.
 * It never stores bodies or request payloads; those stay in the remote
 * receiver. The index is the local "已发送" marker used to skip JS re-uploads.
 */
export type AssetKind = "js" | "api" | "context";
export type AssetRow = {
  key: string;
  project: string;
  kind: AssetKind;
  host: string;
  url: string;
  first_seen: string;
  last_seen: string;
  count: number;
  sent: boolean;
  object_id?: string;
  bytes?: number;
};

export const ASSET_LIMIT = 20000;
const keyOf = (project: string, url: string) => `${project}\u0000${url}`;
export function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export class AssetIndex {
  private rows = new Map<string, AssetRow>();
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private loaded = "";
  private writing: Promise<void> = Promise.resolve();

  async load(project: string) {
    if (this.loaded === project) return;
    this.rows.clear();
    this.dirty.clear();
    this.removed.clear();
    this.loaded = project;
    const db = await database();
    const rows = await new Promise<AssetRow[]>((resolve, reject) => {
      const request = db
        .transaction("assets", "readonly")
        .objectStore("assets")
        .index("project")
        .getAll(project);
      request.onsuccess = () => resolve(request.result as AssetRow[]);
      request.onerror = () => reject(request.error);
    });
    for (const row of rows) this.rows.set(row.key, row);
  }

  get(project: string, url: string) {
    return this.rows.get(keyOf(project, url));
  }

  observe(
    project: string,
    kind: AssetKind,
    url: string,
    host: string,
    extra: { sent?: boolean; object_id?: string; bytes?: number } = {},
  ) {
    if (!project || !url) return;
    const key = keyOf(project, url);
    const time = now();
    let row = this.rows.get(key);
    if (row) {
      row.count++;
      row.last_seen = time;
      if (host) row.host = host;
      row.kind = kind;
    } else {
      row = {
        key,
        project,
        kind,
        host,
        url,
        first_seen: time,
        last_seen: time,
        count: 1,
        sent: false,
      };
      this.rows.set(key, row);
    }
    if (extra.sent !== undefined) row.sent = extra.sent;
    if (extra.object_id !== undefined) row.object_id = extra.object_id;
    if (extra.bytes !== undefined) row.bytes = extra.bytes;
    this.dirty.add(key);
    this.removed.delete(key);
    this.prune();
  }

  private prune() {
    // Sort rarely: prune in one batch once the bound is clearly exceeded.
    if (this.rows.size <= ASSET_LIMIT + 1000) return;
    const oldest = [...this.rows.values()]
      .sort((a, b) => a.last_seen.localeCompare(b.last_seen))
      .slice(0, this.rows.size - ASSET_LIMIT);
    for (const row of oldest) {
      this.rows.delete(row.key);
      this.dirty.delete(row.key);
      this.removed.add(row.key);
    }
  }

  flush() {
    this.writing = this.writing
      .catch(() => {})
      .then(() => this.write())
      .catch(() => {});
    return this.writing;
  }

  private async write() {
    if (!this.dirty.size && !this.removed.size) return;
    const rows = [...this.dirty]
      .map((key) => this.rows.get(key))
      .filter((row): row is AssetRow => !!row);
    const removed = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("assets", "readwrite");
        const store = tx.objectStore("assets");
        for (const row of rows) store.put(row);
        for (const key of removed) store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      // Keep unsaved rows for the next flush; the marker is rebuildable.
      for (const row of rows) this.dirty.add(row.key);
      for (const key of removed) this.removed.add(key);
      throw error;
    }
  }
}

export async function listAssets(project: string): Promise<AssetRow[]> {
  const db = await database();
  const rows = await new Promise<AssetRow[]>((resolve, reject) => {
    const request = db
      .transaction("assets", "readonly")
      .objectStore("assets")
      .index("project")
      .getAll(project);
    request.onsuccess = () => resolve(request.result as AssetRow[]);
    request.onerror = () => reject(request.error);
  });
  return rows.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}