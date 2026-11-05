import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { Recorder } from "../src/capture/recorder";
import { defaults } from "../src/domain/model";
import * as db from "../src/storage/tasks";

it.each([false, true])(
  "fallback POST data is explicit about missing browser evidence (missing=%s)",
  async (missing) => {
    const send = vi.fn(async (_source: unknown, method: string) => {
      if (method === "Network.getRequestPostData") {
        if (missing) throw Error("Browser discarded POST data");
        return { postData: JSON.stringify({ text: "x".repeat(2000) }) };
      }
      return {};
    });
    const recorder = new Recorder(send);
    const scan = await recorder.create(
      "fallback POST",
      [{ id: 1, url: "https://fixture.test/" }],
      {
        ...defaults(),
        body_limit: 1024,
        archive: { ...defaults().archive, enabled: false },
      },
    );
    await recorder.event({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "post",
      type: "Fetch",
      request: {
        url: "https://fixture.test/api",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        hasPostData: true,
      },
    });
    await recorder.event({ tabId: 1 }, "Network.loadingFinished", {
      requestId: "post",
    });
    await recorder.tail;
    await recorder.flush();
    const record = (await db.page(scan.id))[0];
    expect(send).toHaveBeenCalledWith(
      { tabId: 1 },
      "Network.getRequestPostData",
      { requestId: "post" },
    );
    expect(record.capture_status.body.state).toBe(
      missing ? "missing" : "partial",
    );
    if (missing) {
      expect(record.capture_status.body.reason).toContain("不可用");
      expect(record.request_body.parsed).toBeNull();
    } else expect(record.protection.truncated).toBe(true);
  },
);
