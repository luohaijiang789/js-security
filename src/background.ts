import { Recorder } from "./recorder";
import * as db from "./store";
import {
  gap,
  now,
  type Scan,
  type Config,
  type RecordEntry,
  type Batch,
} from "./model";
import { validateConfig } from "./config";
import { transfer, downloadChanged } from "./transfer";
const recorder = new Recorder((s, m, p) =>
  chrome.debugger.sendCommand(s, m, p as Record<string, unknown> | undefined),
);
let eventTail = Promise.resolve(),
  queued = 0,
  queueBytes = 0,
  maintenance = false,
  lastTransfer = 0;
const ready = (async () => {
  const scans = await db.all<Scan>("scans");
  for (const scan of scans.filter((s) =>
    ["recording", "paused", "draining"].includes(s.state),
  )) {
    scan.state = "interrupted";
    const g = gap(
      scan,
      "background_restart",
      "扩展后台重启：上次持久化至重新启动之间可能丢失；须手动恢复",
    );
    g.timestamp = scan.heartbeat;
    g.end = now();
    const active = await db.all<RecordEntry>("active", scan.id);
    recorder.scan = scan;
    scan.stats.pending = active.length;
    for (const record of active) {
      record.request_state = "incomplete";
      record.error = "后台重启，终态未知";
      record.filter_result = "unknown";
      recorder.finish({ record });
    }
    await recorder.tail;
    await recorder.flush();
    scan.state = "interrupted";
    await db.put("scans", scan);
    for (const tab of scan.tabs)
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
  }
  recorder.scan = null;
  await chrome.alarms.create("maintenance", { periodInMinutes: 0.5 });
})();
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (
    ![
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.loadingFinished",
      "Network.loadingFailed",
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
    ].includes(method)
  )
    return;
  const config = recorder.scan?.config;
  const bytes = new TextEncoder().encode(JSON.stringify(params ?? {})).length;
  if (
    config &&
    (queued >= config.queue_count || queueBytes + bytes > config.queue_bytes)
  ) {
    recorder.protect("CDP 事件队列达到上限；丢失计数按事件计", 1);
    return;
  }
  queued++;
  queueBytes += bytes;
  eventTail = eventTail
    .then(() => ready)
    .then(() => recorder.event(source, method, params ?? {}))
    .catch(() => {
      if (recorder.scan) {
        gap(recorder.scan, "event_error", "CDP 事件处理失败，数据可能不完整");
        recorder.scan.state = "paused";
      }
    })
    .finally(() => {
      queued--;
      queueBytes -= bytes;
    });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  void ready.then(async () => {
    if (
      !recorder.scan ||
      recorder.scan.state === "ended" ||
      !recorder.scan.tabs.some((t) => t.id === source.tabId)
    )
      return;
    gap(
      recorder.scan,
      "debugger_detach",
      `标签页 ${source.tabId} 调试连接断开：${reason}`,
    );
    recorder.scan.state = "interrupted";
    for (const c of recorder.channels.values())
      if (c.source.tabId === source.tabId)
        for (const h of c.hops)
          if (!h.done) {
            h.record.request_state = "incomplete";
            h.record.error = "调试连接断开";
            recorder.finish(h);
          }
    await recorder.tail;
    await recorder.flush();
  });
});
chrome.downloads.onChanged.addListener((d) => {
  void downloadChanged(d).catch(() => {});
});
async function tick(force = false) {
  if (maintenance) return;
  maintenance = true;
  try {
    await ready;
    await recorder.flush();
    if (force || Date.now() - lastTransfer >= 15000) {
      lastTransfer = Date.now();
      for (const s of await db.all<Scan>("scans"))
        await transfer(s, force && s.id === recorder.scan?.id);
    }
  } catch {
    if (recorder.scan)
      gap(
        recorder.scan,
        "maintenance",
        "写盘或归档调度失败，保留本地待处理记录",
      );
  } finally {
    maintenance = false;
  }
}
setInterval(() => {
  void tick();
}, 1000);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "maintenance") void tick();
});
async function attach(scan: Scan) {
  for (const t of scan.tabs) {
    try {
      await chrome.debugger.attach({ tabId: t.id }, "1.3");
      const targets = await chrome.debugger.getTargets();
      const target = targets.find((x) => x.tabId === t.id);
      if (target) recorder.targets.set(`${t.id}:root`, target.id);
      await recorder.configure({ tabId: t.id });
    } catch {
      gap(
        scan,
        "attach_failed",
        `无法附加标签页 ${t.id}，可能已关闭、页面受限或已被调试`,
      );
      scan.state = "interrupted";
    }
  }
  await recorder.flush();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    await ready;
    switch (message.type) {
      case "state":
        return {
          scan: recorder.scan,
          queued,
          queueBytes,
          pending: recorder.pendingCount(),
          failure: recorder.failure,
        };
      case "start": {
        validateConfig(message.config);
        const ids = [...new Set<number>(message.tabs)];
        if (!ids.length) throw Error("至少选择一个授权标签页");
        const tabs = await Promise.all(
          ids.map(async (id) => {
            const t = await chrome.tabs.get(id);
            if (!t.url || !/^https?:/.test(t.url))
              throw Error("仅支持 HTTP/HTTPS 标签页");
            return { id, url: t.url };
          }),
        );
        if (
          message.config.service.enabled &&
          !(await chrome.permissions.contains({
            origins: [new URL(message.config.service.url).origin + "/*"],
          }))
        )
          throw Error("请先授权接收服务");
        const s = await recorder.create(message.name, tabs, message.config);
        await attach(s);
        await chrome.storage.local.set({ last_config: message.config });
        return s;
      }
      case "pause":
        await eventTail;
        await recorder.pause();
        return true;
      case "resume": {
        if (!recorder.scan || recorder.scan.id !== message.id) {
          if (recorder.scan && recorder.scan.state !== "ended")
            throw Error("请先停止当前任务");
          const s = await db.get<Scan>("scans", message.id);
          if (!s || s.state !== "interrupted") throw Error("任务不可恢复");
          recorder.scan = s;
        }
        const s = recorder.scan!;
        if (s.state === "interrupted") {
          for (const t of s.tabs)
            await chrome.debugger.detach({ tabId: t.id }).catch(() => {});
          await attach(s);
          if (s.gaps.at(-1)?.type === "attach_failed")
            throw Error("仍有标签页无法附加，请停止后重建任务");
        }
        await recorder.resume();
        return true;
      }
      case "stop": {
        await eventTail;
        if (!recorder.scan || recorder.scan.id !== message.id) {
          if (recorder.scan && recorder.scan.state !== "ended")
            throw Error("请先停止当前任务");
          const s = await db.get<Scan>("scans", message.id);
          if (!s || s.state !== "interrupted") throw Error("任务不可结束");
          recorder.scan = s;
        }
        await recorder.stop();
        for (const t of recorder.scan?.tabs ?? [])
          await chrome.debugger.detach({ tabId: t.id }).catch(() => {});
        if (recorder.scan) await transfer(recorder.scan, true);
        return true;
      }
      case "update":
        if (recorder.scan?.id !== message.id)
          throw Error("只能更新当前采集任务");
        validateConfig(message.config as Config);
        await recorder.update(message.config);
        await chrome.storage.local.set({ last_config: message.config });
        return true;
      case "retry":
        for (const b of await db.all<Batch>("batches", message.id)) {
          if (b.state === "failed") {
            b.attempts = 0;
            b.next_retry = 0;
            await db.put("batches", b);
          }
        }
        {
          const s = await db.get<Scan>("scans", message.id);
          if (s) await transfer(s, true);
        }
        return true;
      case "archive": {
        await recorder.tail;
        await recorder.flush();
        const s = await db.get<Scan>("scans", message.id);
        if (s) await transfer(s, true);
        return true;
      }
      case "delete":
        if (
          recorder.scan &&
          recorder.scan.id === message.id &&
          recorder.scan.state !== "ended"
        )
          throw Error("请先停止任务");
        await db.removeScan(message.id);
        if (recorder.scan?.id === message.id) recorder.scan = null;
        return true;
      default:
        throw Error("未知操作");
    }
  })().then(
    (result) => respond({ ok: true, result }),
    (error) =>
      respond({
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      }),
  );
  return true;
});
