import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
it("rejects foreign senders and historical-task controls without changing the active capture", async () => {
  const id = "a".repeat(32);
  let listener: any;
  const api = {
    runtime: {
      id,
      getURL: (path: string) => `chrome-extension://${id}/${path}`,
      onMessage: {
        addListener: (fn: any) => {
          listener = fn;
        },
      },
    },
    action: { onClicked: { addListener: vi.fn() } },
    tabs: {
      query: async () => [],
      create: vi.fn(),
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    debugger: {
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
      detach: vi.fn(async () => {}),
    },
  };
  vi.stubGlobal("chrome", api);
  await import("../src/background");
  const own = { id, url: api.runtime.getURL("index.html") };
  const send = (message: any) =>
    new Promise<any>((reply) => listener(message, own, reply));
  expect(
    listener(
      { type: "start" },
      { id: "foreign", url: "https://evil.test" },
      vi.fn(),
    ),
  ).toBe(false);
  const started = await send({ type: "start" });
  expect(started.ok).toBe(true);
  expect((await send({ type: "stop", id: "historical-task" })).ok).toBe(false);
  const state = await send({ type: "state" });
  expect(state.active_id).toBe(started.id);
  expect(state.tasks.find((t: any) => t.id === started.id).phase).toBe(
    "collecting",
  );
  expect((await send({ type: "stop", id: started.id })).ok).toBe(true);
  vi.unstubAllGlobals();
});
