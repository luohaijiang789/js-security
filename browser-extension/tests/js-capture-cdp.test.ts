import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { Recorder } from "../src/capture/recorder";
import { defaults } from "../src/domain/model";
import { RemoteCapture } from "../src/transport/client";
import { type CaptureEvent } from "../src/domain/evidence";
import { receiverFixture, receiverToken } from "./receiver-fixture";
import * as db from "../src/storage/tasks";
it("real Chromium CDP collects duplicate multi-MiB external JS and network provenance through the request recorder session", async () => {
  const source = `/*${"a".repeat(3 * 1048576)}*/\nglobalThis.jsRuns = (globalThis.jsRuns || 0) + 1; fetch('/api?item=1&item=2&empty=',{method:'POST',headers:{'Content-Type':'application/json','X-Exact':'unchanged'},body:JSON.stringify({id:0,active:false,text:'字😀',empty:'',nested:{values:[0,null,false]}})});`;
  const server = createServer((req, res) => {
    if (req.url?.endsWith(".js")) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(source);
    } else if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><script src="/first.js"></script><script src="/copy.js"></script>',
      );
    } else res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const receiver = await receiverFixture();
  const remote = new RemoteCapture(
    () => receiver.settings,
    async () => receiverToken,
  );
  const expected: CaptureEvent[] = [];
  const deliver = remote.send.bind(remote);
  remote.send = async (event, source) => {
    const ack = await deliver(event, source);
    // Snapshot after delivery so the receiver-assigned object_id is included.
    expected.push(JSON.parse(JSON.stringify(event)));
    return ack;
  };
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const recorder = new Recorder(
      async (_s, method, params) =>
        method === "Target.setAutoAttach"
          ? {}
          : session.send(method as any, params as any),
      remote,
    );
    const scan = await recorder.create(
      "real JS CDP",
      [{ id: 1, url: origin }],
      {
        ...defaults(),
        collect_js: true,
        value_storage: "complete",
        archive: { ...defaults().archive, enabled: false },
        remote_capture: receiver.settings,
        stop_wait_ms: 100,
      },
    );
    let tail = Promise.resolve();
    for (const method of [
      "Debugger.scriptParsed",
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.responseReceivedExtraInfo",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ]) {
      session.on(method as any, (params: any) => {
        tail = tail.then(() => recorder.event({ tabId: 1 }, method, params));
      });
    }
    await recorder.configure({ tabId: 1 });
    await page.goto(origin);
    expect(await page.evaluate("globalThis.jsRuns")).toBe(2);
    await page.waitForLoadState("networkidle");
    await tail;
    await recorder.stop();
    const events: CaptureEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = await remote.page(scan.id, cursor);
      events.push(...page.events);
      if (!page.has_more) break;
      cursor = page.next;
    }
    // HTTP receipt and browser ACK completion can race; compare logical identities and all fields.
    const logical = (a: CaptureEvent, b: CaptureEvent) =>
      a.transport!.sequence - b.transport!.sequence;
    expect(events.sort(logical)).toEqual(expected.sort(logical));
    expect(events.map((event) => event.transport!.sequence)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    const scripts = events.filter(
      (e) =>
        e.kind === "Debugger.scriptParsed" &&
        /\/(first|copy)\.js$/.test(e.data.url),
    );
    expect(scripts).toHaveLength(2);
    expect(scripts[0].object_id).toBeTruthy();
    // Different URLs, identical bytes: the receiver's content addressing returns one ID.
    expect(scripts[0].object_id).toBe(scripts[1].object_id);
    expect((await remote.source(scripts[0].object_id!)) === source).toBe(true);
    const requests = events.filter(
      (e) => e.kind === "Network.requestWillBeSent",
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (e) =>
          e.data.loader_id &&
          e.data.frame_id &&
          e.data.document_url === origin + "/",
      ),
    ).toBe(true);
    const api = events.filter(
      (e) =>
        e.kind === "ObservedRequest" &&
        e.data.record.request_url.includes("/api?"),
    );
    expect(api).toHaveLength(2);
    for (const item of api) {
      expect(item.data.record.method).toBe("POST");
      expect(item.data.record.request_body.parsed).toEqual({
        id: 0,
        active: false,
        text: "字😀",
        empty: "",
        nested: { values: [0, null, false] },
      });
      expect(
        item.data.record.query_params
          .filter((p: any) => p.name === "item")
          .map((p: any) => p.value),
      ).toEqual(["1", "2"]);
    }
    expect(await db.all("requests", scan.id)).toEqual([]);
    expect(await db.all("active", scan.id)).toEqual([]);
    expect(
      (await indexedDB.databases()).some(
        (db) => db.name === "js-security-js-outbox",
      ),
    ).toBe(false);
    expect(scan.stats.persisted).toBeGreaterThan(0);
    expect(scan.gaps.filter((g) => g.type.startsWith("js_"))).toEqual([]);
  } finally {
    await browser.close();
    await receiver.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
