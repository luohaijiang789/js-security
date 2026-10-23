import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults, type RecordEntry } from "../src/model";
import { Recorder } from "../src/recorder";
import * as db from "../src/store";

const source = { tabId: 71 };
const request = (
  requestId: string,
  url: string,
  extra: Record<string, unknown> = {},
) => ({
  requestId,
  loaderId: "loader-a",
  frameId: "frame-a",
  documentURL: "https://console.test/",
  wallTime: 1792663200,
  type: "Fetch",
  request: { url, method: "GET", headers: {} },
  ...extra,
});

async function complete(recorder: Recorder, id: string) {
  await recorder.event(source, "Network.loadingFinished", { requestId: id });
}

describe("Chrome 风格 Request initiator chain", () => {
  let recorder: Recorder;
  beforeEach(async () => {
    recorder = new Recorder(async () => ({}));
    await recorder.create(
      "initiator fixture",
      [{ id: source.tabId, url: "https://console.test/" }],
      { ...defaults(), merge: "none", stop_wait_ms: 0 },
      "all",
    );
  });

  it("按同标签、会话和 loader 的唯一 initiator URL 建边，并动态读出祖先与后来子树", async () => {
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("a", "https://cdn.test/app.js"),
    );
    await complete(recorder, "a");
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("b", "https://api.test/orders", {
        initiator: { type: "script", url: "https://cdn.test/app.js" },
      }),
    );
    await complete(recorder, "b");
    await recorder.tail;
    await recorder.flush();
    let rows = await db.page(recorder.scan!.id, "", 20),
      current = rows.find((row) => row.cdp_request_id === "b")!;
    const before = await db.queryInitiatorGraph(current);
    expect(before.nodes.map((node) => node.request_url)).toEqual([
      "https://cdn.test/app.js",
      "https://api.test/orders",
    ]);
    expect(before.nodes[1]).toMatchObject({
      parent_id: before.nodes[0].request_id,
      current: true,
      depth: 1,
      resolution: "inferred",
      relation: "initiator-url",
    });

    for (const [id, url] of [
      ["c", "https://api.test/orders/1"],
      ["d", "https://api.test/orders/2"],
    ]) {
      await recorder.event(
        source,
        "Network.requestWillBeSent",
        request(id, url, {
          initiator: { type: "script", url: "https://api.test/orders" },
        }),
      );
      await complete(recorder, id);
    }
    await recorder.tail;
    await recorder.flush();
    rows = await db.page(recorder.scan!.id, "", 20);
    current = rows.find((row) => row.cdp_request_id === "b")!;
    const after = await db.queryInitiatorGraph(current);
    expect(after.nodes.map((node) => node.request_url)).toEqual([
      "https://cdn.test/app.js",
      "https://api.test/orders",
      "https://api.test/orders/1",
      "https://api.test/orders/2",
    ]);
    expect(after.nodes.slice(2).map((node) => node.parent_id)).toEqual([
      current.request_id,
      current.request_id,
    ]);
    expect(after.nodes.slice(2).map((node) => node.depth)).toEqual([2, 2]);
  });

  it("重定向优先于其他线索，preflight requestId 精确关联", async () => {
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("redirect", "https://api.test/old"),
    );
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("redirect", "https://api.test/new", {
        redirectResponse: { status: 302 },
        redirectHasExtraInfo: false,
        initiator: { type: "script", url: "https://unrelated.test/x.js" },
      }),
    );
    const redirectHops = recorder.channels.get(
      recorder.key(source, "redirect"),
    )!.hops;
    expect(redirectHops[1].record).toMatchObject({
      initiator_parent_id: redirectHops[0].record.request_id,
      initiator_parent_match: "redirect",
      initiator_relation: "redirect",
    });

    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("actual", "https://api.test/write"),
    );
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("preflight", "https://api.test/write", {
        initiator: { type: "preflight", requestId: "actual" },
      }),
    );
    const actual = recorder.channels.get(recorder.key(source, "actual"))!
      .hops[0].record;
    const preflight = recorder.channels.get(recorder.key(source, "preflight"))!
      .hops[0].record;
    expect(preflight).toMatchObject({
      initiator_parent_id: actual.request_id,
      initiator_parent_match: "exact",
      initiator_relation: "preflight",
    });
  });

  it("候选歧义或跨 loader 时不猜父请求，并保留可解释状态", async () => {
    for (const id of ["first", "second"])
      await recorder.event(
        source,
        "Network.requestWillBeSent",
        request(id, "https://cdn.test/shared.js"),
      );
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("ambiguous", "https://api.test/a", {
        initiator: { type: "script", url: "https://cdn.test/shared.js" },
      }),
    );
    expect(
      recorder.channels.get(recorder.key(source, "ambiguous"))!.hops[0].record,
    ).toMatchObject({
      initiator_parent_id: null,
      initiator_parent_match: "ambiguous",
    });
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("other-loader", "https://api.test/b", {
        loaderId: "loader-b",
        initiator: { type: "script", url: "https://cdn.test/shared.js" },
      }),
    );
    expect(
      recorder.channels.get(recorder.key(source, "other-loader"))!.hops[0]
        .record,
    ).toMatchObject({
      initiator_parent_id: null,
      initiator_parent_match: "missing",
    });
  });

  it("周期快照后可从在途子请求向上查询，也能从已完成父请求看到在途 child", async () => {
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("parent", "https://api.test/parent"),
    );
    await complete(recorder, "parent");
    await recorder.tail;
    await recorder.flush();
    const parent = (await db.page(recorder.scan!.id, "", 20))[0];
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("pending-child", "https://api.test/pending", {
        initiator: { type: "script", url: "https://api.test/parent" },
      }),
    );
    await recorder.flush();
    const pending = (await db.queryActive(recorder.scan!.id)).rows[0];
    expect((await db.queryInitiatorGraph(parent)).nodes).toEqual([
      expect.objectContaining({ request_id: parent.request_id, current: true }),
      expect.objectContaining({
        request_id: pending.request_id,
        parent_id: parent.request_id,
      }),
    ]);
    expect((await db.queryInitiatorGraph(pending)).nodes).toEqual([
      expect.objectContaining({ request_id: parent.request_id }),
      expect.objectContaining({
        request_id: pending.request_id,
        current: true,
      }),
    ]);
  });

  it("拒绝异常的跨任务边", async () => {
    const current = {
        scan_id: recorder.scan!.id,
        request_id: crypto.randomUUID(),
        request_url: "https://scan-a.test/current",
      } as RecordEntry,
      foreign = {
        scan_id: crypto.randomUUID(),
        request_id: crypto.randomUUID(),
        request_url: "https://scan-b.test/parent",
      } as RecordEntry;
    current.initiator_parent_id = foreign.request_id;
    current.initiator_parent_match = "exact";
    await db.put("requests", current);
    await db.put("requests", foreign);
    const graph = await db.queryInitiatorGraph(current);
    expect(graph.nodes.map((node) => node.request_id)).toEqual([
      current.request_id,
    ]);
    expect(graph.warning).toContain("父请求未被保留");
  });

  it("静态父请求被 Filter 排除后仍用保留原始URL的紧凑节点维持完整链", async () => {
    await recorder.update({
      ...recorder.scan!.config,
      retention: "matching",
      filter: {
        exclude: {
          field: "resource_type",
          operator: "equals",
          values: ["Script"],
        },
      },
    });
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("script", "https://cdn.test/app.js?token=secret", {
        type: "Script",
      }),
    );
    await complete(recorder, "script");
    await recorder.event(
      source,
      "Network.requestWillBeSent",
      request("api", "https://api.test/data", {
        initiator: {
          type: "script",
          url: "https://cdn.test/app.js?token=secret",
        },
      }),
    );
    await complete(recorder, "api");
    await recorder.tail;
    await recorder.flush();
    const rows = await db.page(recorder.scan!.id, "", 20);
    expect(rows.map((row) => row.cdp_request_id)).toEqual(["api"]);
    const graph = await db.queryInitiatorGraph(rows[0]);
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        request_id: "",
        request_url: "https://cdn.test/app.js?token=secret",
        current: false,
        depth: 0,
      }),
      expect.objectContaining({
        request_id: rows[0].request_id,
        current: true,
        depth: 1,
      }),
    ]);
    expect(
      JSON.stringify(await db.all("initiator_nodes", recorder.scan!.id)),
    ).toContain("token=secret");
  });

  it("没有紧凑节点的过渡记录仍按 initiator URL 补出不可点击父项", async () => {
    const current = {
      scan_id: recorder.scan!.id,
      request_id: crypto.randomUUID(),
      request_url: "https://api.test/current",
      initiator_url: "https://cdn.test/legacy.js",
      initiator_parent_id: crypto.randomUUID(),
      initiator_parent_match: "inferred",
      initiator_relation: "initiator-url",
    } as RecordEntry;
    await db.put("requests", current);
    const graph = await db.queryInitiatorGraph(current);
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        request_id: "",
        request_url: current.initiator_url,
        depth: 0,
      }),
      expect.objectContaining({
        request_id: current.request_id,
        current: true,
        depth: 1,
      }),
    ]);
    expect(graph.warning).toContain("Initiator URL");
  });

  it("旧记录明确说明没有链数据", async () => {
    const legacy = {
      scan_id: recorder.scan!.id,
      request_id: crypto.randomUUID(),
      request_url: "https://legacy.test/request",
    } as RecordEntry;
    await db.put("requests", legacy);
    const graph = await db.queryInitiatorGraph(legacy);
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        request_id: legacy.request_id,
        current: true,
        depth: 0,
      }),
    ]);
    expect(graph.warning).toContain("创建于请求发起链采集之前");
  });
});
