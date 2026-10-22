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
// State reads remain independent from slow stop/attach operations. Only task mutations serialize.
let controlTail: Promise<void> = Promise.resolve();
const controlMessages = new Set([
  "start",
  "pause",
  "resume",
  "stop",
  "update",
  "delete",
]);
const deliberateDetaches = new Map<
  number,
  { scanId: string | undefined; expires: number }
>();
async function detachIntentionally(tabId: number) {
  const marker = { scanId: recorder.scan?.id, expires: Date.now() + 5000 };
  deliberateDetaches.set(tabId, marker);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    if (deliberateDetaches.get(tabId) === marker)
      deliberateDetaches.delete(tabId);
  }
}
function requireCurrent(id: unknown, states: Scan["state"][]) {
  const scan = recorder.scan;
  if (!scan || scan.id !== id) throw Error("任务已切换，请刷新后操作当前任务");
  if (!states.includes(scan.state))
    throw Error("当前任务状态不允许此操作，请刷新任务状态");
  return scan;
}
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
    for (const tab of scan.tabs) await detachIntentionally(tab.id);
  }
  recorder.scan = null;
  await chrome.alarms.create("maintenance", { periodInMinutes: 0.5 });
})().catch(() => {
  // A quota/transaction failure during recovery must not permanently reject every API call.
  // Recorder keeps the pending safe records in memory; a later flush can retry them.
  recorder.failure = "后台恢复未完成，已保存数据仍可查看；请释放空间后重试写盘";
  if (recorder.scan) {
    recorder.scan.state = "interrupted";
    gap(recorder.scan, "background_recovery_failed", recorder.failure);
  }
  void chrome.alarms
    .create("maintenance", { periodInMinutes: 0.5 })
    .catch(() => {});
});
chrome.action.onClicked.addListener((tab) => {
  const source =
    tab.id !== undefined && /^https?:/.test(tab.url ?? "")
      ? "?sourceTab=" + tab.id
      : "";
  void chrome.tabs.create({
    url: chrome.runtime.getURL("index.html") + source,
  });
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
  const scan = recorder.scan,
    tabId = source.tabId;
  const deliberate =
    tabId === undefined ? undefined : deliberateDetaches.get(tabId);
  if (tabId !== undefined) deliberateDetaches.delete(tabId);
  if (
    deliberate &&
    deliberate.expires >= Date.now() &&
    reason === "canceled_by_user"
  )
    return;
  // Do not let a delayed event from an old task interrupt a newly created task.
  if (!scan || scan.state === "ended" || !scan.tabs.some((t) => t.id === tabId))
    return;
  void ready
    .then(async () => {
      if (recorder.scan !== scan || scan.state === "ended") return;
      gap(scan, "debugger_detach", `标签页 ${tabId} 调试连接断开：${reason}`);
      scan.state = "interrupted";
      for (const c of recorder.channels.values())
        if (c.source.tabId === tabId)
          for (const h of c.hops)
            if (!h.done) {
              h.record.request_state = "incomplete";
              h.record.error = "调试连接断开";
              recorder.finish(h);
            }
      await recorder.tail;
      await recorder.flush();
    })
    .catch(() => {});
});
chrome.downloads.onChanged.addListener((d) => {
  void downloadChanged(d).catch(() => {});
});
async function tick(force = false) {
  await ready;
  // Local persistence has its own flushPromise lock. A slow remote batch must never
  // suppress the one-second request/active-snapshot writes needed by the live inspector.
  try {
    await recorder.flush();
  } catch {
    return; // Recorder already records the write failure and protects the task.
  }
  if (maintenance) return;
  maintenance = true;
  try {
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
async function attach(scan: Scan, reuseOwnedSession = false) {
  const failed: number[] = [];
  for (const t of scan.tabs) {
    try {
      let owned = false;
      if (reuseOwnedSession) {
        try {
          await chrome.debugger.sendCommand({ tabId: t.id }, "Network.enable");
          owned = true;
        } catch {}
      }
      if (!owned) await chrome.debugger.attach({ tabId: t.id }, "1.3");
      const targets = await chrome.debugger.getTargets();
      const target = targets.find((x) => x.tabId === t.id);
      if (target) recorder.targets.set(`${t.id}:root`, target.id);
      await recorder.configure({ tabId: t.id });
    } catch {
      failed.push(t.id);
      gap(
        scan,
        "attach_failed",
        `无法附加标签页 ${t.id}，可能已关闭、页面受限或已被调试`,
      );
      scan.state = "interrupted";
    }
  }
  await recorder.flush();
  return failed;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const execute = async () => {
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
        requireCurrent(message.id, ["recording"]);
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
          // Reuse our own still-attached sessions after a partial interruption.
          // Detaching here would generate an onDetach event that can interrupt the resumed task.
          const failed = await attach(s, true);
          if (failed.length)
            throw Error(
              `仍有 ${failed.length} 个标签页无法附加，请停止后重新选择页面`,
            );
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
          await detachIntentionally(t.id);
        if (recorder.scan) {
          const completed = structuredClone(recorder.scan);
          // Local stop/flush is complete. Remote acknowledgements and downloads have their own
          // state and must not hold the control queue (or the next task) open for their retries.
          void transfer(completed, true)
            .catch(async () => {
              await db.transact(
                ["scans", "errors"],
                "readwrite",
                (tx) =>
                  new Promise<void>((resolve, reject) => {
                    const request = tx.objectStore("scans").get(completed.id);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                      const latest = request.result as Scan | undefined;
                      if (latest) {
                        const error = gap(
                          latest,
                          "transfer_schedule",
                          "采集已结束，归档或转存调度失败；本地数据保留，等待重试",
                        );
                        tx.objectStore("errors").put(error);
                        tx.objectStore("scans").put(latest);
                      }
                      resolve();
                    };
                  }),
              );
            })
            .catch(() => {});
        }
        return true;
      }
      case "update":
        requireCurrent(message.id, ["recording", "paused", "interrupted"]);
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
      case "flush": {
        if (recorder.scan?.id === message.id) {
          await eventTail;
          await recorder.tail;
          await recorder.flush();
        }
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
  };
  const pending = controlMessages.has(message.type)
    ? controlTail.then(execute)
    : execute();
  if (controlMessages.has(message.type))
    controlTail = pending.then(
      () => {},
      () => {},
    );
  void pending.then(
    (result) => respond({ ok: true, result }),
    (error) =>
      respond({
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      }),
  );
  return true;
});
