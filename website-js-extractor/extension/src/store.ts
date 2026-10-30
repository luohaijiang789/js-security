import type { Asset, Task, Snapshot } from "./model";
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("website-js-extractor", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("tasks", { keyPath: "id" });
      const a = r.result.createObjectStore("assets", { keyPath: "id" });
      a.createIndex("task", "task_id");
      r.result.createObjectStore("snapshots", { keyPath: "snapshot_id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
async function write(stores: string[], action: (t: IDBTransaction) => void) {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(stores, "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? Error("保存已中断"));
    action(t);
  });
}
async function read<T>(store: string, key?: string): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = key
      ? d.transaction(store).objectStore(store).get(key)
      : d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export const saveTask = (task: Task) =>
  write(["tasks"], (t) => t.objectStore("tasks").put(task));
export const saveAsset = (asset: Asset, task: Task) =>
  write(["tasks", "assets"], (t) => {
    t.objectStore("assets").put(asset);
    t.objectStore("tasks").put(task);
  });
export const tasks = () => read<Task[]>("tasks");
export const getTask = (id: string) => read<Task | undefined>("tasks", id);
export async function assets(id: string): Promise<Asset[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d
      .transaction("assets")
      .objectStore("assets")
      .index("task")
      .getAll(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function freeze(id: string): Promise<Snapshot> {
  const task = await getTask(id);
  if (!task || !["paused", "stopped", "interrupted"].includes(task.phase))
    throw Error("先暂停或停止采集，再生成固定快照");
  const snapshot: Snapshot = {
    schema_version: "capture-0.1",
    snapshot_id: crypto.randomUUID(),
    task_id: id,
    assets: await assets(id),
    gaps: [
      ...task.gaps,
      ...(task.omitted_gaps
        ? [
            {
              kind: "gap_limit",
              message: `另有 ${task.omitted_gaps} 项采集缺口未逐项保存`,
            },
          ]
        : []),
    ],
    frozen_at: new Date().toISOString(),
  };
  await write(["snapshots"], (t) => t.objectStore("snapshots").put(snapshot));
  return snapshot;
}
export const getSnapshot = (id: string) =>
  read<Snapshot | undefined>("snapshots", id);
