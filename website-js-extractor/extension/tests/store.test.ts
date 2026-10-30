import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import {
  saveAsset,
  saveTask,
  freeze,
  getSnapshot,
  getTask,
} from "../src/store";
import { serviceURL } from "../src/client";
import type { Task, Asset } from "../src/model";
it("freezes persisted immutable bodies only after collection drains", async () => {
  const task: Task = {
    id: crypto.randomUUID(),
    phase: "collecting",
    started_at: new Date().toISOString(),
    assets: 1,
    bytes: 3,
    gaps: [],
    omitted_gaps: 0,
    tabs: [1],
  };
  const asset: Asset = {
    id: crypto.randomUUID(),
    task_id: task.id,
    url: "https://site.test/a.js",
    location: "a.js",
    content: "abc",
    sha256: "hash",
    bytes: 3,
    context_key: "ctx",
    context: {
      type: "page",
      page_url: "https://site.test/",
      request_base_url: "https://site.test/",
      evidence: "test",
    },
    capture_url: "https://site.test/a.js",
    script_id: "1",
    captured_at: "now",
  };
  await saveAsset(asset, task);
  await expect(freeze(task.id)).rejects.toThrow("先暂停");
  task.phase = "paused";
  await saveTask(task);
  const snapshot = await freeze(task.id);
  asset.content = "changed";
  await saveAsset(asset, task);
  expect((await getSnapshot(snapshot.snapshot_id))?.assets[0].content).toBe(
    "abc",
  );
  expect((await getTask(task.id))?.phase).toBe("paused");
});
it("rejects remote and credential-bearing analysis endpoints", () => {
  expect(serviceURL("http://127.0.0.1:8378/")).toBe("http://127.0.0.1:8378");
  for (const url of [
    "https://evil.test",
    "http://localhost:8378",
    "http://127.0.0.1:8378/path",
    "http://user:pass@127.0.0.1:8378",
  ])
    expect(() => serviceURL(url)).toThrow();
});
