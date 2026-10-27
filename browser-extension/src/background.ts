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
import { validateSlsConfig, validateConfig } from "./config";
import { transfer, downloadChanged, retargetFailedSls } from "./transfer";
import { safeURL } from "./privacy";
import { slsBaseURL } from "./sls";
async function deadline<T>(
  promise: Promise<T>,
  label: string,
  ms = 3000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(label + "超时")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const recorder = new Recorder((s, m, p) =>
  deadline(
    chrome.debugger.sendCommand(s, m, p as Record<string, unknown> | undefined),
    "CDP " + m,
  ),
);
const attachedTabs = new Map<number, string>(),
  unavailableTabs = new Map<number, string>(),
  manualDetachedTabs = new Set<number>(),
  closedTabs = new Set<number>(),
  failedTabURLs = new Map<number, string>(),
  attachAttempts = new Map<number, symbol>(),
  sessionGenerations = new Map<number, number>();
function webURL(tab: chrome.tabs.Tab) {
  const url = /^https?:/i.test(tab.url ?? "") ? tab.url : tab.pendingUrl;
  try {
    const u = new URL(url ?? "");
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
async function browserPages() {
  return (await chrome.tabs.query({})).flatMap((tab) => {
    const url = webURL(tab);
    return tab.id !== undefined && url ? [{ id: tab.id, url }] : [];
  });
}
function queueBrowserChange(scan: Scan, operation: () => Promise<void>) {
  const pending = controlTail.then(async () => {
    await ready;
    if (
      recorder.scan !== scan ||
      scan.tab_scope !== "all" ||
      scan.state !== "recording"
    )
      return;
    await operation();
  });
  controlTail = pending.catch(() => {});
  void pending.catch(() => {
    if (recorder.scan === scan && scan.state !== "ended")
      gap(
        scan,
        "browser_scope_sync",
        "浏览器页面范围同步失败，等待下一次导航或恢复时重试",
      );
  });
}

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
  "retarget_sls",
]);
const deliberateDetaches = new Map<
  number,
  { scanId: string | undefined; expires: number }
>();
async function detachIntentionally(tabId: number, scanId = recorder.scan?.id) {
  if (attachedTabs.has(tabId) && attachedTabs.get(tabId) !== scanId) return;
  const marker = { scanId, expires: Date.now() + 5000 };
  deliberateDetaches.set(tabId, marker);
  attachedTabs.delete(tabId);
  if (scanId && recorder.scan?.id === scanId)
    unavailableTabs.set(tabId, scanId);
  try {
    await deadline(chrome.debugger.detach({ tabId }), "分离网页");
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
async function requireTransferPermissions(config: Config) {
  if (
    config.service.enabled &&
    !(await chrome.permissions.contains({
      origins: [new URL(config.service.url).origin + "/*"],
    }))
  )
    throw Error("请先授权接收服务");
  if (config.sls?.enabled) {
    const origin = new URL(slsBaseURL(config.sls)).origin;
    if (!(await chrome.permissions.contains({ origins: [origin + "/*"] })))
      throw Error("请先授权阿里云 SLS Endpoint");
  }
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
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
function browserTabChanged(tab: chrome.tabs.Tab) {
  const scan = recorder.scan;
  if (!scan || scan.tab_scope !== "all" || scan.state !== "recording") return;
  queueBrowserChange(scan, async () => {
    await observeBrowserTab(scan, tab);
  });
}
chrome.tabs.onCreated.addListener(browserTabChanged);
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (
    change.url !== undefined ||
    change.status === "loading" ||
    change.status === "complete"
  )
    browserTabChanged({ ...tab, id: tabId });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const scan = recorder.scan;
  if (!scan || scan.state === "ended" || !scan.tabs.some((t) => t.id === tabId))
    return;
  unavailableTabs.set(tabId, scan.id);
  attachedTabs.delete(tabId);
  const cutoff = eventTail;
  queueTabLoss(scan, tabId, "标签页已关闭", true, cutoff);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (
    ![
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceived",
      "Network.responseReceivedExtraInfo",
      "Network.loadingFinished",
      "Network.loadingFailed",
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
    ].includes(method)
  )
    return;
  const current = recorder.scan;
  if (
    !current ||
    current.state === "ended" ||
    !current.tabs.some((t) => t.id === source.tabId)
  )
    return;
  if (
    source.tabId !== undefined &&
    unavailableTabs.get(source.tabId) === current?.id
  )
    return;
  const config = current?.config;
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
    .then(() =>
      recorder.scan === current
        ? recorder.event(source, method, params ?? {})
        : undefined,
    )
    .catch(() => {
      if (recorder.scan === current) {
        gap(current, "event_error", "CDP 事件处理失败，数据可能不完整");
        recorder.scan.state = "paused";
      }
    })
    .finally(() => {
      queued--;
      queueBytes -= bytes;
    });
});
function queueTabLoss(
  scan: Scan,
  tabId: number,
  reason: string,
  closed: boolean,
  cutoff: Promise<void>,
) {
  const generation = sessionGenerations.get(tabId);
  const pending = controlTail.then(async () => {
    await ready;
    await cutoff;
    if (sessionGenerations.get(tabId) !== generation) return;
    await handleTabLoss(scan, tabId, reason, closed, cutoff);
  });
  controlTail = pending.catch(() => {});
}
async function handleTabLoss(
  scan: Scan,
  tabId: number,
  reason: string,
  closed: boolean,
  cutoff: Promise<void>,
) {
  await cutoff;
  if (recorder.scan !== scan || scan.state === "ended") return;
  if (!closed || !closedTabs.has(tabId)) {
    gap(
      scan,
      closed ? "tab_closed" : "debugger_detach",
      `标签页 ${tabId}：${reason}`,
    );
    if (closed) closedTabs.add(tabId);
  }
  if (scan.tab_scope !== "all") scan.state = "interrupted";
  await recorder.interruptTab(tabId, reason);
}
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  attachedTabs.delete(tabId);
  const deliberate = deliberateDetaches.get(tabId);
  deliberateDetaches.delete(tabId);
  if (
    deliberate &&
    deliberate.expires >= Date.now() &&
    reason === "canceled_by_user"
  )
    return;
  const scan = recorder.scan;
  if (!scan || scan.state === "ended" || !scan.tabs.some((t) => t.id === tabId))
    return;
  unavailableTabs.set(tabId, scan.id);
  if (reason === "canceled_by_user") manualDetachedTabs.add(tabId);
  const cutoff = eventTail;
  queueTabLoss(
    scan,
    tabId,
    "调试连接断开：" + reason,
    reason === "target_closed",
    cutoff,
  );
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
    if (force || Date.now() - lastTransfer >= 1000) {
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
async function attach(
  scan: Scan,
  reuseOwnedSession = false,
  targets = scan.tabs,
) {
  const failed: number[] = [];
  for (const tab of targets) {
    if (
      recorder.scan !== scan ||
      scan.state === "ended" ||
      scan.state === "draining"
    )
      break;
    if (attachedTabs.get(tab.id) === scan.id) continue;
    // A queued loss can be behind this resume command. Close its old in-flight
    // records before admitting a new session; the generation guard then skips its stale job.
    if (unavailableTabs.get(tab.id) === scan.id) {
      await eventTail;
      await recorder.interruptTab(
        tab.id,
        "网页连接已中断，恢复前旧请求终态未知",
      );
    }
    const attempt = Symbol();
    attachAttempts.set(tab.id, attempt);
    recorder.includeTab(tab);
    unavailableTabs.delete(tab.id);
    closedTabs.delete(tab.id);
    const started = now();
    let timedOut = false;
    let acquired = false;
    try {
      let owned = false;
      if (reuseOwnedSession) {
        try {
          await deadline(
            chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable"),
            "探测网页会话",
          );
          owned = true;
        } catch {}
      }
      if (!owned) {
        const attaching = chrome.debugger.attach({ tabId: tab.id }, "1.3");
        void attaching
          .then(() => {
            if (
              (timedOut || scan.state === "ended") &&
              recorder.scan === scan &&
              attachAttempts.get(tab.id) === attempt &&
              !attachedTabs.has(tab.id)
            )
              void detachIntentionally(tab.id, scan.id);
          })
          .catch(() => {});
        try {
          await deadline(attaching, "附加网页");
        } catch (e) {
          timedOut = true;
          throw e;
        }
      }
      acquired = true;
      const targets = await deadline(
        chrome.debugger.getTargets(),
        "读取网页目标",
      );
      const target = targets.find((t) => t.tabId === tab.id);
      if (target) recorder.targets.set(`${tab.id}:root`, target.id);
      await recorder.configure({ tabId: tab.id });
      attachedTabs.set(tab.id, scan.id);
      sessionGenerations.set(tab.id, (sessionGenerations.get(tab.id) ?? 0) + 1);
      failedTabURLs.delete(tab.id);
      if (scan.tab_scope === "all") {
        const window = gap(
          scan,
          "target_attach_window",
          `标签页 ${tab.id} 首次附加前的导航和请求可能未被观测，不能视为完整覆盖`,
        );
        window.timestamp = started;
        window.end = now();
      }
    } catch {
      if (acquired) await detachIntentionally(tab.id);
      failed.push(tab.id);
      attachedTabs.delete(tab.id);
      unavailableTabs.set(tab.id, scan.id);
      await eventTail;
      await recorder.interruptTab(tab.id, "网页附加或配置失败，连接终态未知");
      failedTabURLs.set(tab.id, safeURL(tab.url));
      gap(
        scan,
        "attach_failed",
        `无法附加标签页 ${tab.id}，可能已关闭、页面受限、被其他调试器占用或连接超时`,
      );
      if (scan.tab_scope !== "all") scan.state = "interrupted";
    }
  }
  await recorder.flush();
  return failed;
}
async function observeBrowserTab(scan: Scan, tab: chrome.tabs.Tab) {
  if (
    recorder.scan !== scan ||
    scan.tab_scope !== "all" ||
    scan.state !== "recording" ||
    tab.id === undefined
  )
    return;
  const url = webURL(tab);
  if (!url) {
    if (attachedTabs.get(tab.id) === scan.id) {
      await detachIntentionally(tab.id);
      await recorder.interruptTab(tab.id, "页面离开 HTTP/HTTPS 范围");
      gap(scan, "page_out_of_scope", `标签页 ${tab.id} 已离开网页采集范围`);
    }
    return;
  }
  const previous = scan.tabs.find((t) => t.id === tab.id);
  if (previous) previous.url = safeURL(url);
  if (
    manualDetachedTabs.has(tab.id) ||
    failedTabURLs.get(tab.id) === safeURL(url)
  ) {
    await recorder.flush();
    return;
  }
  await attach(scan, true, [{ id: tab.id, url }]);
}
async function rescanBrowser(scan: Scan) {
  const pages = await browserPages();
  for (const page of pages) {
    if (
      recorder.scan !== scan ||
      scan.state === "ended" ||
      scan.state === "draining"
    )
      break;
    if (
      manualDetachedTabs.has(page.id) ||
      failedTabURLs.get(page.id) === safeURL(page.url)
    )
      continue;
    await attach(scan, true, [page]);
  }
  return pages;
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
        const scope = message.tab_scope === "selected" ? "selected" : "all";
        let tabs: { id: number; url: string }[];
        if (scope === "all") tabs = await browserPages();
        else {
          const ids = [...new Set<number>(message.tabs ?? [])];
          if (!ids.length) throw Error("至少选择一个授权标签页");
          tabs = await Promise.all(
            ids.map(async (id) => {
              const tab = await chrome.tabs.get(id);
              const url = webURL(tab);
              if (!url) throw Error("仅支持 HTTP/HTTPS 标签页");
              return { id, url };
            }),
          );
        }
        await requireTransferPermissions(message.config);
        const s = await recorder.create(
          message.name,
          tabs,
          message.config,
          scope,
        );
        attachedTabs.clear();
        unavailableTabs.clear();
        manualDetachedTabs.clear();
        closedTabs.clear();
        failedTabURLs.clear();
        await attach(s);
        if (scope === "all") await rescanBrowser(s);
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
        if (s.tab_scope === "all") {
          if (!["paused", "interrupted"].includes(s.state))
            throw Error("当前任务不可恢复");
          manualDetachedTabs.clear();
          failedTabURLs.clear();
          await rescanBrowser(s);
        } else if (s.state === "interrupted") {
          const failed = await attach(s, true);
          if (failed.length)
            throw Error(
              `仍有 ${failed.length} 个标签页无法附加，请停止后重新选择页面`,
            );
        }
        await recorder.resume();
        if (s.tab_scope === "all") await rescanBrowser(s);
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
        await requireTransferPermissions(message.config as Config);
        await recorder.update(message.config);
        await chrome.storage.local.set({ last_config: message.config });
        return true;
      case "retarget_sls": {
        const target = { ...message.sls, enabled: true };
        validateSlsConfig(target);
        const s = await db.get<Scan>("scans", message.id);
        if (!s) throw Error("任务不存在");
        await requireTransferPermissions({
          ...s.config,
          service: { ...s.config.service, enabled: false },
          sls: target,
        });
        await retargetFailedSls(s, target);
        return true;
      }
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
