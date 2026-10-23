<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import SimpleFilter from "./SimpleFilter.vue";
import Icon from "./Icon.vue";
import RequestDetail from "./RequestDetail.vue";
import {
  stateLabels as labels,
  timeText,
  bytesText,
  statusText,
  statusTone,
} from "./presentation";
import {
  defaults,
  type Scan,
  type RecordEntry,
  type Group,
  type Batch,
  type InitiatorGraph,
} from "./model";
import { validateConfig } from "./config";
import { validateFilter, matchFilter } from "./filter";
import * as db from "./store";
import { packageFiles, csv, jsonl } from "./export";
const name = ref("业务请求采集");
const current = ref<Scan | null>(null),
  history = ref<Scan[]>([]),
  scanId = ref(""),
  rows = ref<RecordEntry[]>([]),
  groups = ref<Group[]>([]),
  batches = ref<Batch[]>([]);
const detail = ref<RecordEntry | null>(null),
  selected = ref<string[]>([]),
  configText = ref(JSON.stringify(defaults(), null, 2));
const filterText = ref("{}"),
  filterValid = ref(true),
  filterFeedback = ref("");
const section = ref("请求"),
  mode = ref("原始"),
  search = ref(""),
  after = ref(""),
  cursors = ref<string[]>([]),
  groupOffset = ref(0),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  failure = ref(""),
  queued = ref(0),
  pending = ref(0),
  serviceToken = ref("");
const scan = computed(() =>
  current.value?.id === scanId.value
    ? current.value
    : history.value.find((s) => s.id === scanId.value),
);
const shown = computed(() => rows.value);
const resource = ref("all"),
  direction = ref<"newest" | "oldest">("newest"),
  pageSize = ref(50),
  hasMore = ref(false),
  pageCursor = ref(""),
  loadingRows = ref(false),
  live = ref(true),
  groupFilter = ref("");
const detailGroup = ref<Group | null>(null),
  initiatorGraph = ref<InitiatorGraph | null>(null),
  detailLoading = ref(false),
  detailError = ref(""),
  detailId = ref(""),
  newTaskOpen = ref(false),
  exportOpen = ref(false);
const batchStateLabels: Record<string, string> = {
  pending: "待处理",
  downloading: "下载中",
  complete: "已完成",
  failed: "失败",
};
const navItems = [
  { id: "请求", name: "请求工作台", icon: "activity" },
  { id: "任务", name: "任务设置", icon: "settings" },
  { id: "Filter", name: "过滤规则", icon: "filter" },
  { id: "存储与转存", name: "存储与转存", icon: "database" },
  { id: "历史任务", name: "历史任务", icon: "clock" },
  { id: "使用说明", name: "使用说明", icon: "help" },
];
const title = computed(
  () => navItems.find((x) => x.id === section.value)?.name ?? "请求工作台",
);
const activeTask = computed(
  () =>
    !!scan.value &&
    scan.value.id === current.value?.id &&
    ["recording", "paused", "interrupted", "draining"].includes(
      scan.value.state,
    ),
);
const filterDirty = computed(() => {
  try {
    return (
      JSON.stringify(JSON.parse(filterText.value)) !==
      JSON.stringify(scan.value?.config.filter ?? {})
    );
  } catch {
    return true;
  }
});
const filterActionText = computed(() => {
  if (!filterValid.value) return "规则有错误，修正后才能预览或应用。";
  if (filterFeedback.value) return filterFeedback.value;
  if (!scan.value) return "尚未选择任务；选择任务后可以应用过滤条件。";
  if (!activeTask.value) return "当前任务已经结束，不能再改变其采集结果。";
  return filterDirty.value
    ? "修改尚未应用。应用后只影响之后收到的请求。"
    : "当前任务正在使用这条规则。";
});
const filterActionWarning = computed(
  () => !filterValid.value || (!filterFeedback.value && !activeTask.value),
);
watch(filterText, () => {
  filterFeedback.value = "";
});
const canStart = computed(
  () => !current.value || current.value.state === "ended",
);
function safeForm(value: unknown, base: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  return Object.fromEntries(
    Object.entries(base).map(([key, fallback]) => {
      const next = (value as any)[key];
      if (Array.isArray(fallback))
        return [
          key,
          Array.isArray(next) && next.every((x) => typeof x === "string")
            ? next
            : fallback,
        ];
      if (fallback && typeof fallback === "object")
        return [key, safeForm(next, fallback)];
      return [key, typeof next === typeof fallback ? next : fallback];
    }),
  );
}
const configForm = computed<ReturnType<typeof defaults>>(() => {
  try {
    return safeForm(JSON.parse(configText.value), defaults());
  } catch {
    return defaults();
  }
});
const draftConfig = ref(defaults()),
  draftFilterText = ref("{}"),
  draftFilterValid = ref(true);
const selectedTabCount = computed(() => scan.value?.tabs.length ?? 0);
const valueStorageText = computed(() =>
  scan.value?.config.value_storage === "complete"
    ? "字段值完整保留"
    : "超长字段值自动截断",
);
const attention = computed(() => {
  const s = scan.value;
  if (!s || !["paused", "interrupted"].includes(s.state)) return "";
  const g = [...s.gaps]
    .reverse()
    .find((g) =>
      [
        "backpressure",
        "storage_failure",
        "debugger_detach",
        "attach_failed",
        "event_error",
        "processing",
        "background_restart",
        "pause",
      ].includes(g.type),
    );
  return (
    (labels[s.state] ?? s.state) +
    "：" +
    (g?.reason ?? "请检查网页和连接状态后恢复。")
  );
});
const resultCount = ref(0);
let searchTimer: ReturnType<typeof setTimeout>,
  loadSequence = 0,
  detailSequence = 0,
  refreshing = false,
  uiEpoch = 0;
watch([search, resource, direction, pageSize, mode, groupFilter], () => {
  loadSequence++;
  after.value = "";
  cursors.value = [];
  groupOffset.value = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void loadPage().catch(showError);
  }, 200);
});
function showError(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
}
function setConfig(path: string, value: unknown) {
  const c = JSON.parse(JSON.stringify(configForm.value));
  const keys = path.split(".");
  let at = c;
  for (const k of keys.slice(0, -1)) at = at[k];
  at[keys.at(-1)!] = value;
  configText.value = JSON.stringify(c, null, 2);
}
function setNumber(path: string, event: Event, multiplier = 1) {
  setConfig(
    path,
    Math.round(Number((event.target as HTMLInputElement).value) * multiplier),
  );
}
function setList(path: string, event: Event) {
  setConfig(
    path,
    (event.target as HTMLInputElement).value
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}
function closeDetail() {
  detailSequence++;
  detailId.value = "";
  detail.value = null;
  detailGroup.value = null;
  initiatorGraph.value = null;
  detailError.value = "";
  detailLoading.value = false;
}
async function loadInitiatorGraph(record: RecordEntry, seq: number) {
  try {
    const graph = await db.queryInitiatorGraph(record);
    if (seq === detailSequence && detailId.value === record.request_id)
      initiatorGraph.value = graph;
  } catch {
    if (seq === detailSequence && detailId.value === record.request_id)
      initiatorGraph.value = null;
  }
}
async function openDetail(record: RecordEntry, group: Group | null = null) {
  const seq = ++detailSequence;
  detailId.value = record.request_id;
  detail.value = record;
  initiatorGraph.value = null;
  detailGroup.value = group;
  detailError.value = "";
  detailLoading.value = false;
  try {
    const saved =
      (await db.get<RecordEntry>("requests", record.request_id)) ??
      (await db.get<RecordEntry>("active", record.request_id));
    if (seq !== detailSequence) return;
    if (saved) detail.value = saved;
    await loadInitiatorGraph(saved ?? record, seq);
  } catch (e) {
    if (seq === detailSequence)
      detailError.value = "已显示列表快照；完整记录暂时读取失败：" + String(e);
  }
}
async function inspectRequest(requestId: string) {
  const record =
    (await db.get<RecordEntry>("requests", requestId)) ??
    (await db.get<RecordEntry>("active", requestId));
  if (!record) throw Error("这条关联请求已被清理，无法打开详情。");
  await openDetail(record);
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = "已复制到剪贴板";
  } catch {
    error.value = "浏览器未允许剪贴板访问，请在原始数据中选择并复制内容。";
  }
}
async function downloadRecord(record: RecordEntry) {
  await saveBlob(
    new Blob([jsonl([record])], { type: "application/x-ndjson" }),
    "request_" + record.request_id.replace(/[^a-zA-Z0-9-]/g, "_") + ".jsonl",
  );
  notice.value = "已提交单条请求下载，包含全部已保存字段。";
}
function groupMembers(group: Group) {
  groupFilter.value = group.id;
  search.value = "";
  resource.value = "all";
  mode.value = "原始";
  closeDetail();
}
async function openNewTask() {
  name.value = "业务采集 " + timeText(new Date().toISOString());
  draftConfig.value = defaults();
  draftFilterText.value = "{}";
  newTaskOpen.value = true;
}
function navigate(value: string) {
  section.value = value;
  exportOpen.value = false;
}
const counts = computed(() =>
  ["file", "service"].map((channel) => ({
    channel,
    ...(Object.fromEntries(
      ["pending", "downloading", "complete", "failed"].map((state) => [
        state,
        batches.value
          .filter((b) => b.channel === channel && b.state === state)
          .reduce((n, b) => n + b.records.length, 0),
      ]),
    ) as Record<"pending" | "downloading" | "complete" | "failed", number>),
    unplanned: (
      channel === "file"
        ? scan.value?.config.archive.enabled
        : scan.value?.config.service.enabled
    )
      ? Math.max(
          0,
          (scan.value?.stats.persisted ?? 0) -
            batches.value
              .filter((b) => b.channel === channel)
              .reduce((n, b) => n + b.records.length, 0),
        )
      : 0,
  })),
);
async function rpc(type: string, data: object = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r.ok) throw Error(r.error);
  return r.result;
}
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  uiEpoch++;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    await refresh();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError")
      notice.value = "已取消操作，已保存的数据未改动。";
    else error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}
async function viewGroup(g: Group) {
  const seq = ++detailSequence;
  detailId.value = g.representative_id;
  detailGroup.value = g;
  detail.value = null;
  initiatorGraph.value = null;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const r = await db.get<RecordEntry>("requests", g.representative_id);
    if (seq !== detailSequence) return;
    if (!r) throw Error("代表请求不存在或已删除；请检查任务数据。");
    detail.value = r;
    await loadInitiatorGraph(r, seq);
  } catch (e) {
    if (seq === detailSequence) detailError.value = String(e);
  } finally {
    if (seq === detailSequence) detailLoading.value = false;
  }
}
async function loadPage() {
  const seq = ++loadSequence,
    id = scanId.value;
  if (!id) {
    rows.value = [];
    groups.value = [];
    batches.value = [];
    return;
  }
  loadingRows.value = !rows.value.length;
  try {
    const [requests, groupRows, batchRows] = await Promise.all([
      (mode.value === "在途" ? db.queryActive : db.queryRequests)(id, {
        after: after.value,
        limit: pageSize.value,
        text: search.value,
        resource: resource.value,
        group: groupFilter.value,
        direction: direction.value,
      }),
      mode.value === "聚合"
        ? db.queryGroups(id, search.value, groupOffset.value, pageSize.value)
        : Promise.resolve({ rows: [] as Group[], hasMore: false }),
      db.all<Batch>("batches", id),
    ]);
    if (seq !== loadSequence || id !== scanId.value) return;
    rows.value = requests.rows;
    resultCount.value = requests.total;
    groups.value = groupRows.rows;
    batches.value = batchRows;
    hasMore.value =
      mode.value === "聚合" ? groupRows.hasMore : requests.hasMore;
    pageCursor.value = requests.cursor;
    if (detailId.value && detail.value) {
      const row = requests.rows.find((r) => r.request_id === detailId.value);
      if (row) detail.value = row;
      else if (mode.value === "在途") {
        const selectedId = detailId.value,
          selection = detailSequence;
        const finished = await db.get<RecordEntry>("requests", selectedId);
        if (finished && seq === loadSequence && selection === detailSequence)
          detail.value = finished;
      }
      if (detail.value) void loadInitiatorGraph(detail.value, detailSequence);
    }
  } finally {
    if (seq === loadSequence) loadingRows.value = false;
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const epoch = uiEpoch;
  try {
    let state: any = null,
      connectionError = "";
    try {
      state = await rpc("state");
    } catch (e) {
      connectionError = "后台连接暂不可用；已保存的任务仍可查看。" + String(e);
    }
    const saved = (await db.all<Scan>("scans")).sort((a, b) =>
      b.started_at.localeCompare(a.started_at),
    );
    if (epoch !== uiEpoch) return;
    if (state) {
      current.value = state.scan;
      failure.value = state.failure;
      queued.value = state.queued;
      pending.value = state.pending;
    } else failure.value = connectionError;
    history.value = saved;
    if (
      !scanId.value ||
      (!history.value.some((s) => s.id === scanId.value) &&
        current.value?.id !== scanId.value)
    ) {
      const id = current.value?.id ?? history.value[0]?.id ?? "";
      if (id) {
        await choose(id);
        return;
      }
    }
    if (section.value === "请求" || section.value === "存储与转存")
      await loadPage();
  } finally {
    refreshing = false;
  }
}
async function choose(id: string) {
  loadSequence++;
  closeDetail();
  scanId.value = id;
  after.value = "";
  cursors.value = [];
  groupOffset.value = 0;
  selected.value = [];
  groupFilter.value = "";
  search.value = "";
  const s =
    current.value?.id === id
      ? current.value
      : history.value.find((s) => s.id === id);
  if (s) {
    configText.value = JSON.stringify(s.config, null, 2);
    filterText.value = JSON.stringify(s.config.filter, null, 2);
  }
  await chrome.storage.local.set({ ui_scan_id: id });
  await loadPage();
}
async function start() {
  const c = JSON.parse(JSON.stringify(draftConfig.value));
  c.filter = JSON.parse(draftFilterText.value);
  validateConfig(c);
  if (
    c.merge === "representative" &&
    !window.confirm(
      "仅代表记录是有损模式：无法恢复每次正文、调用栈和页面。继续？",
    )
  )
    return;
  const s = await rpc("start", {
    name: name.value,
    tab_scope: "all",
    tabs: [],
    config: c,
  });
  current.value = s;
  history.value = [s, ...history.value.filter((x) => x.id !== s.id)];
  await choose(s.id);
  newTaskOpen.value = false;
  section.value = "请求";
  if (s.state === "recording")
    notice.value =
      "浏览器全局采集已开始，新打开的网页自动接入；请求按 Filter 留存。";
  else
    error.value =
      "任务已创建，但采集连接中断。请在存储与转存中查看原因后恢复任务。";
}
async function action(type: string) {
  const id = scanId.value,
    name = scan.value?.name ?? "所选任务";
  await rpc(type, { id });
  const messages: Record<string, string> = {
    pause: "已暂停新请求，已接收请求继续关联。",
    resume: "已恢复采集，中断时段仍保留缺口标记。",
    stop: "采集已结束并完成写盘；文件归档和服务转存进度分别显示。",
    archive: "已处理归档与转存计划，请在批次进度确认各渠道状态。",
    retry: "已重试失败批次，请查看最新回执。",
  };
  notice.value = "「" + name + "」" + (messages[type] ?? "操作已完成。");
}
async function apply() {
  const c = JSON.parse(configText.value);
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw Error("任务策略必须是 JSON 对象，请修正高级配置。");
  c.filter = JSON.parse(filterText.value);
  validateConfig(c);
  await rpc("update", { id: scanId.value, config: c });
  if (current.value?.id === scanId.value)
    current.value = { ...current.value, config: c };
  history.value = history.value.map((item) =>
    item.id === scanId.value ? { ...item, config: c } : item,
  );
  filterFeedback.value =
    "已应用到当前任务，只影响之后收到的请求；已经保存的记录不会改变。";
  notice.value = filterFeedback.value;
}
async function preview() {
  const f = JSON.parse(filterText.value);
  validateFilter(f);
  const stats = { matched: 0, excluded: 0, unknown: 0 };
  rows.value.forEach((r) => stats[matchFilter(f, r, true)]++);
  filterFeedback.value = `当前列表预览：命中 ${stats.matched}，排除 ${stats.excluded}，无法判定 ${stats.unknown}。`;
  notice.value = `${filterFeedback.value} 原始值规则可能与实采不同。`;
}
async function authorize() {
  const c = JSON.parse(configText.value);
  const u = new URL(c.service.url);
  if (u.protocol !== "https:") throw Error("仅允许 HTTPS 服务");
  const ok = await chrome.permissions.request({ origins: [u.origin + "/*"] });
  if (!ok) throw Error("未授权");
  const t = await chrome.storage.session.get("service_tokens");
  await chrome.storage.session.set({
    service_tokens: {
      ...((t.service_tokens as object) ?? {}),
      [u.origin]: serviceToken.value,
    },
  });
  serviceToken.value = "";
  notice.value = "接收服务已授权；令牌仅存当前浏览器会话，不进入导出包。";
}
async function saveBlob(blob: Blob, filename: string) {
  const u = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: u, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch (e) {
    URL.revokeObjectURL(u);
    throw e;
  }
}
function exportContext() {
  if (!scan.value) throw Error("请先选择任务");
  return {
    source: JSON.parse(JSON.stringify(scan.value)) as Scan,
    selectedIds: [...selected.value],
    batchRows: JSON.parse(JSON.stringify(batches.value)) as Batch[],
  };
}
async function downloadZip(scope: "all" | "filter" | "selected") {
  const context = exportContext();
  if (current.value?.id === context.source.id) {
    await rpc("flush", { id: context.source.id });
    const latest = await db.get<Scan>("scans", context.source.id);
    if (latest) context.source = latest;
  }
  const bytes = await packageFiles(context.source, scope, context.selectedIds);
  await saveBlob(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    `EO_SCAN_${context.source.id}.zip`,
  );
  notice.value =
    "任务「" +
    context.source.name +
    "」已提交下载，请在浏览器下载列表确认完成。";
}
async function downloadSelected() {
  const context = exportContext();
  const records: RecordEntry[] = [];
  let bytes = 0;
  for (const id of context.selectedIds) {
    const record =
      (await db.get<RecordEntry>("requests", id)) ??
      (await db.get<RecordEntry>("active", id));
    if (!record || record.scan_id !== context.source.id)
      throw Error("部分选中记录已不在所选任务中，请刷新后重新选择。");
    bytes += new TextEncoder().encode(JSON.stringify(record)).length;
    if (bytes > 64 * 1048576) throw Error("选中记录超过 64 MB，请分批导出。");
    records.push(record);
  }
  if (!records.length) throw Error("请先选择请求。");
  await saveBlob(
    new Blob([jsonl(records)], { type: "application/x-ndjson" }),
    "selected_requests_" + context.source.id + ".jsonl",
  );
  notice.value =
    "已导出 " + records.length + " 条选中记录；在途快照保留 pending 状态。";
}
async function exportCSV() {
  const { source: sourceScan } = exportContext();
  const picker = (window as any).showSaveFilePicker;
  if (!picker) {
    let cursor = "",
      first = true,
      total = 0;
    const parts: string[] = [];
    while (true) {
      const batch = await db.page(sourceScan.id, cursor, 200);
      if (!batch.length) break;
      const text = csv(batch),
        part = first
          ? text + "\r\n"
          : text.substring(text.indexOf("\r\n") + 2) + "\r\n";
      total += new TextEncoder().encode(part).length;
      if (total > 64 * 1048576)
        throw Error("CSV 超过 64 MB；请使用支持文件选择器的 Chrome 流式导出。");
      parts.push(part);
      first = false;
      cursor = batch.at(-1)!.request_id;
    }
    await saveBlob(
      new Blob(parts.length ? parts : [csv([])], {
        type: "text/csv;charset=utf-8",
      }),
      "requests_" + sourceScan.id + ".csv",
    );
    notice.value = "已提交全部请求 CSV 下载，请确认浏览器下载完成。";
    return;
  }
  const h = await picker({ suggestedName: "requests.csv" }),
    w = await h.createWritable();
  let cursor = "",
    first = true;
  try {
    while (true) {
      const batch = await db.page(sourceScan.id, cursor, 500);
      if (!batch.length) break;
      const text = csv(batch);
      await w.write(
        first
          ? text + "\r\n"
          : text.substring(text.indexOf("\r\n") + 2) + "\r\n",
      );
      first = false;
      cursor = batch.at(-1)!.request_id;
    }
    if (first) await w.write(csv([]));
    await w.close();
    notice.value = "任务「" + sourceScan.name + "」的全部请求 CSV 已完成写入";
  } catch (e) {
    await w.abort();
    throw e;
  }
}
async function exportDirectory() {
  const { source: sourceScan, batchRows } = exportContext();
  const picker = (window as any).showDirectoryPicker;
  if (!picker) throw Error("当前 Chrome 不支持目录访问，请使用 ZIP");
  const root = await picker({ mode: "readwrite" });
  const directory = await root.getDirectoryHandle(`EO_SCAN_${sourceScan.id}`, {
    create: true,
  });
  let cursor = "",
    index = 1,
    w: any = null,
    bytes = 0,
    count = 0,
    total = 0;
  const shards: { file: string; count: number; bytes: number }[] = [];
  const max = sourceScan.config.archive.bytes;
  let filename = "";
  const open = async () => {
    filename = `requests_${String(index++).padStart(4, "0")}.jsonl`;
    w = await (
      await directory.getFileHandle(filename, { create: true })
    ).createWritable();
    bytes = 0;
    count = 0;
  };
  const close = async () => {
    if (w) {
      await w.close();
      shards.push({ file: filename, count, bytes });
      w = null;
    }
  };
  try {
    while (true) {
      const batch = await db.page(sourceScan.id, cursor, 200);
      if (!batch.length) break;
      cursor = batch.at(-1)!.request_id;
      for (const r of batch) {
        const text = jsonl([r]),
          size = new TextEncoder().encode(text).length;
        if (w && bytes + size > max) await close();
        if (!w) await open();
        await w.write(text);
        bytes += size;
        count++;
        total++;
      }
      notice.value = `正在写入：${total} 条`;
    }
    await close();
    for (const store of ["groups", "errors"]) {
      const file = await (
        await directory.getFileHandle(
          store === "groups" ? "request_groups.jsonl" : "capture_errors.jsonl",
          { create: true },
        )
      ).createWritable();
      if (store === "groups") {
        let offset = 0;
        while (true) {
          const group = await db.groupPage(sourceScan.id, offset, 200);
          if (!group.length) break;
          await file.write(jsonl(group));
          offset += group.length;
        }
      } else {
        let offset = 0;
        while (true) {
          const errors = await db.errorPage(sourceScan.id, offset, 200);
          if (!errors.length) break;
          await file.write(jsonl(errors));
          offset += errors.length;
        }
      }
      await file.close();
    }
    const manifest = await (
      await directory.getFileHandle("scan_manifest.json", { create: true })
    ).createWritable();
    await manifest.write(
      JSON.stringify(
        {
          schema_version: "0.1.0",
          scan: sourceScan,
          shards,
          batches: batchRows,
          exported_at: new Date().toISOString(),
          lossy: sourceScan.config.merge === "representative",
        },
        null,
        2,
      ),
    );
    await manifest.close();
    notice.value = `目录导出完成：${total} 条，${shards.length} 个请求分片`;
  } catch (e) {
    if (w) await w.abort();
    throw Error("目录导出未完成；无成功 manifest。" + String(e));
  }
}
async function next() {
  if (!hasMore.value) return;
  if (mode.value === "聚合") groupOffset.value += pageSize.value;
  else {
    cursors.value.push(after.value);
    after.value = pageCursor.value;
  }
  await loadPage();
}
async function prev() {
  if (mode.value === "聚合")
    groupOffset.value = Math.max(0, groupOffset.value - pageSize.value);
  else after.value = cursors.value.pop() ?? "";
  await loadPage();
}
async function deleteScan() {
  if (
    !scan.value ||
    !window.confirm(
      "永久删除任务、本地请求、分组和转存进度？未转存证据也会删除。",
    )
  )
    return;
  await rpc("delete", { id: scan.value.id });
  scanId.value = "";
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  await run(async () => {
    const saved = await chrome.storage.local.get(["last_config", "ui_scan_id"]);
    if (saved.last_config)
      configText.value = JSON.stringify(saved.last_config, null, 2);
    if (saved.ui_scan_id) scanId.value = String(saved.ui_scan_id);
    const requested = new URLSearchParams(location.search).get("section");
    if (requested && navItems.some((x) => x.id === requested))
      section.value = requested;
    await refresh();
    if (scanId.value) await choose(scanId.value);
  });
  timer = setInterval(() => {
    if (!busy.value && live.value) void refresh().catch(showError);
  }, 1500);
});
onUnmounted(() => {
  clearInterval(timer);
  clearTimeout(searchTimer);
  loadSequence++;
  detailSequence++;
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-lockup">
        <span class="brand-mark"><Icon name="activity" :size="24" /></span>
        <div><strong>JS 请求观察台</strong><span>REQUEST RECORDER</span></div>
      </div>
      <div class="workspace-label">工作空间 <span>LOCAL</span></div>
      <nav aria-label="主导航">
        <button
          v-for="item in navItems"
          :key="item.id"
          :aria-label="item.name"
          :title="item.name"
          :class="{ active: section === item.id }"
          @click="navigate(item.id)"
        >
          <Icon :name="item.icon" /><span>{{ item.name }}</span
          ><span v-if="item.id === '请求' && scan" class="nav-count">{{
            scan.stats.persisted
          }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="privacy-note">
          <Icon name="shield" :size="19" />
          <div>
            <strong>数据保存在本地</strong
            ><span>字段名完整 · 值按任务设置保存</span>
          </div>
        </div>
        <div class="version-line">
          <span class="tiny-dot"></span>Chrome 扩展<span>v0.3.4</span>
        </div>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumbs">
          工作空间 <Icon name="arrow" :size="12" /><strong>{{ title }}</strong>
        </div>
        <div class="topbar-actions">
          <span class="connection-indicator"
            ><span
              class="tiny-dot"
              :class="{ 'is-recording': current?.state === 'recording' }"
            ></span
            >{{
              current?.state === "recording" ? "后台正在采集" : "本地工作空间"
            }}</span
          ><span class="divider"></span
          ><button class="button" :disabled="busy" @click="run(refresh)">
            <Icon name="refresh" :size="15" />刷新</button
          ><button
            class="button primary"
            :disabled="busy || !canStart"
            @click="run(openNewTask)"
          >
            <Icon name="plus" :size="17" />新建采集任务
          </button>
        </div>
      </header>
      <main>
        <div class="page-heading">
          <div>
            <p class="eyebrow">
              {{
                section === "请求"
                  ? "CAPTURE · INSPECT · TRACE"
                  : "YOUR LOCAL WORKSPACE"
              }}
            </p>
            <h1>{{ title }}</h1>
            <p>
              {{
                section === "请求"
                  ? "每一次请求，都有可以回查的上下文。"
                  : section === "Filter"
                    ? "用可解释的规则限定留存范围，保留每次变更的版本。"
                    : section === "任务"
                      ? "管理采集范围、任务策略与采集状态。"
                      : section === "存储与转存"
                        ? "分别追踪本地保存、文件归档和接收服务的完成情况。"
                        : section === "历史任务"
                          ? "重新打开已保存的采集任务，继续查看与交付。"
                          : "从选择页面到查看证据，完成一次可回查的采集。"
              }}
            </p>
          </div>
          <div v-if="scan" class="task-controls">
            <button
              v-if="activeTask && scan.state === 'recording'"
              class="button"
              :disabled="busy"
              @click="run(() => action('pause'))"
            >
              <Icon name="pause" :size="15" />暂停采集</button
            ><button
              v-if="scan && ['paused', 'interrupted'].includes(scan.state)"
              class="button"
              :disabled="busy"
              @click="run(() => action('resume'))"
            >
              <Icon name="play" :size="15" />恢复采集</button
            ><button
              v-if="scan && scan.state !== 'ended'"
              class="button danger-outline"
              :disabled="busy"
              @click="run(() => action('stop'))"
            >
              <Icon name="stop" :size="14" />停止并写盘
            </button>
            <div class="export-control">
              <button
                class="button"
                :disabled="busy"
                :aria-expanded="exportOpen"
                @click="exportOpen = !exportOpen"
              >
                <Icon name="download" :size="16" />导出数据<Icon
                  name="arrow"
                  class="rotate-90"
                  :size="13"
                />
              </button>
              <div v-if="exportOpen" class="dropdown">
                <button
                  @click="
                    exportOpen = false;
                    run(() => downloadZip('all'));
                  "
                >
                  <Icon name="file" />完整任务 ZIP<small
                    >原始请求、分组、错误及清单</small
                  ></button
                ><button
                  @click="
                    exportOpen = false;
                    run(exportDirectory);
                  "
                >
                  <Icon name="folder" />任务目录<small
                    >分片写入，适合大任务</small
                  ></button
                ><button
                  @click="
                    exportOpen = false;
                    run(exportCSV);
                  "
                >
                  <Icon name="grid" />全部请求 CSV</button
                ><button
                  @click="
                    exportOpen = false;
                    run(() => downloadZip('filter'));
                  "
                >
                  <Icon name="filter" />当前规则结果包</button
                ><button
                  :disabled="!selected.length"
                  @click="
                    exportOpen = false;
                    run(downloadSelected);
                  "
                >
                  <Icon name="check" />选中请求（{{ selected.length }}）
                </button>
              </div>
            </div>
          </div>
        </div>
        <div v-if="error || failure" class="message-banner error" role="alert">
          <Icon name="alert" /><span>{{ error || failure }}</span
          ><button
            class="icon-button"
            aria-label="关闭错误提示"
            @click="
              error = '';
              failure = '';
            "
          >
            <Icon name="close" :size="15" />
          </button>
        </div>
        <div v-if="notice" class="message-banner notice" role="status">
          <Icon name="check" /><span>{{ notice }}</span
          ><button
            class="icon-button"
            aria-label="关闭操作提示"
            @click="notice = ''"
          >
            <Icon name="close" :size="15" />
          </button>
        </div>
        <div v-if="attention" class="message-banner warning">
          <Icon name="alert" /><span>{{ attention }}</span
          ><button class="text-button" @click="section = '存储与转存'">
            查看原因
          </button>
        </div>
        <section v-if="section === '请求'" class="requests-page">
          <div class="metric-grid">
            <div class="metric-card">
              <span class="metric-icon blue"><Icon name="activity" /></span>
              <div>
                <span>已观测请求</span
                ><strong>{{
                  (scan?.stats.observed ?? 0).toLocaleString()
                }}</strong
                ><button
                  class="text-button"
                  @click="
                    mode = '在途';
                    groupFilter = '';
                  "
                >
                  {{ scan?.stats.pending ?? 0 }} 条等待终态 · 查看
                </button>
              </div>
            </div>
            <div class="metric-card">
              <span class="metric-icon teal"><Icon name="database" /></span>
              <div>
                <span>已持久化</span
                ><strong>{{
                  (scan?.stats.persisted ?? 0).toLocaleString()
                }}</strong
                ><small>{{ bytesText(scan?.stats.bytes) }} · 本地保存</small>
              </div>
            </div>
            <div class="metric-card">
              <span class="metric-icon purple"><Icon name="layers" /></span>
              <div>
                <span>请求组</span
                ><strong>{{
                  (scan?.stats.groups ?? 0).toLocaleString()
                }}</strong
                ><small>原始观察独立保留</small>
              </div>
            </div>
            <div class="metric-card">
              <span class="metric-icon amber"><Icon name="filter" /></span>
              <div>
                <span>规则结果</span
                ><strong
                  >{{ (scan?.stats.matched ?? 0).toLocaleString()
                  }}<em>命中</em></strong
                ><small
                  >{{ scan?.stats.excluded ?? 0 }} 排除 ·
                  {{ scan?.stats.unknown ?? 0 }} 无法判定</small
                >
              </div>
            </div>
          </div>
          <div class="workbench" :class="{ 'has-detail': !!detailId }">
            <section class="request-list-panel" aria-label="请求列表">
              <div class="list-panel-heading">
                <div class="inline">
                  <h2>请求记录</h2>
                  <span class="subtle-count">{{
                    resultCount.toLocaleString()
                  }}</span>
                </div>
                <label class="live-toggle"
                  ><input v-model="live" type="checkbox" /><span
                    class="tiny-dot"
                    :class="{ 'is-recording': live }"
                  ></span
                  >自动刷新</label
                >
              </div>
              <div class="task-select-row">
                <Icon name="folder" :size="15" /><select
                  :value="scanId"
                  aria-label="当前任务"
                  :disabled="busy"
                  @change="
                    (e) =>
                      run(() => choose((e.target as HTMLSelectElement).value))
                  "
                >
                  <option v-if="!history.length" value="">暂无采集任务</option>
                  <option v-for="s in history" :key="s.id" :value="s.id">
                    {{ s.name }}
                  </option></select
                ><span class="task-status" :class="scan?.state"
                  ><span class="tiny-dot"></span
                  >{{ scan ? labels[scan.state] : "未开始" }}</span
                >
              </div>
              <div class="list-filters">
                <div class="search-box">
                  <Icon name="search" :size="17" /><input
                    v-model="search"
                    aria-label="搜索请求"
                    placeholder="搜索 URL、参数、脚本或请求 ID"
                  /><button
                    v-if="search"
                    class="icon-button"
                    aria-label="清空搜索"
                    @click="search = ''"
                  >
                    <Icon name="close" :size="13" />
                  </button>
                </div>
                <div class="segmented" aria-label="请求视图">
                  <button
                    :class="{ active: mode === '原始' }"
                    @click="mode = '原始'"
                  >
                    <Icon name="list" :size="14" />原始</button
                  ><button
                    :class="{ active: mode === '聚合' }"
                    @click="
                      mode = '聚合';
                      resource = 'all';
                    "
                  >
                    <Icon name="layers" :size="14" />聚合</button
                  ><button
                    :class="{ active: mode === '在途' }"
                    @click="
                      mode = '在途';
                      groupFilter = '';
                    "
                    aria-label="查看在途请求"
                  >
                    <Icon name="clock" :size="14" />在途
                    {{ scan?.stats.pending ?? 0 }}
                  </button>
                </div>
              </div>
              <div class="resource-tabs">
                <button
                  v-for="r in [
                    { id: 'all', label: '全部请求' },
                    { id: 'api', label: 'XHR / Fetch / Beacon' },
                    { id: 'Document', label: '文档' },
                    { id: 'other', label: '其他资源' },
                  ]"
                  :key="r.id"
                  :class="{ active: resource === r.id }"
                  :disabled="mode === '聚合' && r.id !== 'all'"
                  @click="resource = r.id"
                >
                  {{ r.label }}</button
                ><span v-if="selected.length" class="selection-count"
                  >已选 {{ selected.length }}</span
                >
              </div>
              <div v-if="mode === '在途'" class="group-filter-chip">
                <Icon name="clock" :size="14" />已取得字段的保护后快照 ·
                完成前也可查看，规则等待终态判断
              </div>
              <div v-if="groupFilter" class="group-filter-chip">
                <Icon
                  name="layers"
                  :size="14"
                />当前仅显示所选请求组的原始观察<button
                  class="icon-button"
                  aria-label="清除请求组筛选"
                  @click="groupFilter = ''"
                >
                  <Icon name="close" :size="13" />
                </button>
              </div>
              <div class="requests-scroll">
                <table
                  v-if="mode !== '聚合' && shown.length"
                  class="requests-table"
                >
                  <thead>
                    <tr>
                      <th class="checkbox-cell">
                        <span class="sr-only">选择</span>
                      </th>
                      <th>方法</th>
                      <th class="request-name-column">请求 / 来源</th>
                      <th>状态</th>
                      <th class="type-column">类型</th>
                      <th class="time-column">时间</th>
                      <th><span class="sr-only">查看</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="r in shown"
                      :key="r.request_id"
                      class="request-row"
                      :class="{ selected: detailId === r.request_id }"
                      tabindex="0"
                      :aria-selected="detailId === r.request_id"
                      :data-request-id="r.request_id"
                      @click="openDetail(r)"
                      @keydown.enter.prevent="openDetail(r)"
                    >
                      <td class="checkbox-cell" @click.stop>
                        <input
                          v-model="selected"
                          type="checkbox"
                          :value="r.request_id"
                          :aria-label="'选择 ' + r.pathname"
                        />
                      </td>
                      <td>
                        <span
                          class="method-badge"
                          :class="r.method.toLowerCase()"
                          >{{ r.method }}</span
                        >
                      </td>
                      <td class="request-name-column">
                        <button
                          class="request-path"
                          :title="r.request_url"
                          @click.stop="openDetail(r)"
                        >
                          {{ r.pathname || "/" }}</button
                        ><span class="request-host" :title="r.page_url ?? ''"
                          >{{ r.domain
                          }}<span v-if="r.redirect_hop">
                            · 跳次 {{ r.redirect_hop }}</span
                          ></span
                        >
                      </td>
                      <td>
                        <span class="status-code" :class="statusTone(r)"
                          ><span class="tiny-dot"></span
                          >{{ statusText(r) }}</span
                        >
                      </td>
                      <td class="type-column">
                        <span class="resource-label">{{
                          r.resource_type
                        }}</span>
                      </td>
                      <td class="time-column mono">
                        {{ timeText(r.timestamp, true) }}
                      </td>
                      <td>
                        <button
                          class="row-open icon-button"
                          :aria-label="'查看请求 ' + r.pathname"
                          @click.stop="openDetail(r)"
                        >
                          <Icon name="arrow" :size="15" />
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <table
                  v-else-if="mode === '聚合' && groups.length"
                  class="requests-table"
                >
                  <thead>
                    <tr>
                      <th>归一化接口</th>
                      <th>观察次数</th>
                      <th>分组状态</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="g in groups"
                      :key="g.id"
                      class="request-row"
                      :class="{ selected: detailGroup?.id === g.id }"
                      tabindex="0"
                      @click="viewGroup(g)"
                      @keydown.enter.prevent="viewGroup(g)"
                    >
                      <td>
                        <strong class="group-url">{{ g.normalized_url }}</strong
                        ><span class="request-host"
                          >{{ timeText(g.first) }} —
                          {{ timeText(g.last) }}</span
                        >
                      </td>
                      <td>
                        <span class="group-count">{{ g.count }}</span>
                      </td>
                      <td>
                        <span
                          class="pill"
                          :class="g.candidate ? 'amber' : 'teal'"
                          >{{ g.candidate ? "候选分组" : "按规则归并" }}</span
                        >
                      </td>
                      <td>
                        <button
                          class="row-open icon-button"
                          aria-label="查看请求组"
                          @click.stop="viewGroup(g)"
                        >
                          <Icon name="arrow" :size="15" />
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-else-if="loadingRows" class="empty-state">
                  <span class="spinner"></span>
                  <h3>正在读取本地请求…</h3>
                </div>
                <div v-else class="empty-state">
                  <span class="empty-illustration"
                    ><Icon :name="scan ? 'search' : 'activity'" :size="32"
                  /></span>
                  <h3>
                    {{
                      !scan
                        ? "从一次业务操作开始"
                        : search || groupFilter || resource !== "all"
                          ? "没有找到匹配的请求"
                          : mode === "在途"
                            ? "当前没有在途请求"
                            : "等待页面产生请求"
                    }}
                  </h3>
                  <p>
                    {{
                      !scan
                        ? "创建任务并选择测试标签页，请求、参数和发起脚本会保存在这里。"
                        : search || groupFilter || resource !== "all"
                          ? "尝试调整搜索词或清除筛选，已保存的数据不会被删除。"
                          : mode === "在途"
                            ? "请求完成后会出现在原始观察中；在途快照按批次更新。"
                            : scan.state === "ended"
                              ? "此任务没有已保存的请求。可检查过滤规则或新建任务重新采集。"
                              : "在浏览器中执行业务操作，匹配 Filter 的请求将自动显示。"
                    }}
                  </p>
                  <button
                    v-if="!scan"
                    class="button primary"
                    :disabled="busy || !canStart"
                    @click="run(openNewTask)"
                  >
                    <Icon name="plus" :size="16" />新建采集任务</button
                  ><button
                    v-else-if="search || groupFilter || resource !== 'all'"
                    class="button"
                    @click="
                      search = '';
                      groupFilter = '';
                      resource = 'all';
                    "
                  >
                    清除筛选
                  </button>
                </div>
              </div>
              <footer class="table-footer">
                <span
                  >{{
                    mode !== "聚合"
                      ? "本页 " +
                        rows.length +
                        (mode === "在途" ? " 条在途快照" : " 条原始观察")
                      : "本页 " + groups.length + " 个请求组"
                  }}<span class="footer-hint"> · 点击行查看详情</span></span
                >
                <div class="inline">
                  <select v-model.number="pageSize" aria-label="每页条数">
                    <option :value="50">50 / 页</option>
                    <option :value="100">100 / 页</option></select
                  ><button
                    class="icon-button"
                    aria-label="上一页"
                    :disabled="
                      busy || (mode !== '聚合' ? !cursors.length : !groupOffset)
                    "
                    @click="run(prev)"
                  >
                    <Icon name="back" :size="16" /></button
                  ><span class="page-number">{{
                    mode !== "聚合"
                      ? cursors.length + 1
                      : groupOffset / pageSize + 1
                  }}</span
                  ><button
                    class="icon-button"
                    aria-label="下一页"
                    :disabled="busy || !hasMore"
                    @click="run(next)"
                  >
                    <Icon name="arrow" :size="16" />
                  </button>
                </div>
              </footer>
            </section>
            <RequestDetail
              v-if="detailId"
              :record="detail"
              :initiator-graph="initiatorGraph"
              :group="detailGroup"
              :loading="detailLoading"
              :error="detailError"
              :busy="busy"
              @close="closeDetail"
              @copy="copyText"
              @download="(r) => run(() => downloadRecord(r))"
              @members="groupMembers"
              @inspect="(id) => run(() => inspectRequest(id))"
            />
          </div>
          <div class="workspace-footer">
            <span
              ><Icon name="shield" :size="13" />{{
                scan && scan.tab_scope !== "all"
                  ? "历史指定范围 · 已接入"
                  : "浏览器全局 · 已接入"
              }}
              {{ selectedTabCount }} 个标签页 · {{ valueStorageText }}</span
            ><span
              >队列 {{ queued }} 个事件 · {{ pending }} 条请求 / 待写记录<span
                v-if="scan?.stats.lost"
                class="warning-text"
              >
                · 已知丢失 {{ scan.stats.lost }} 个事件</span
              ></span
            >
          </div>
        </section>
        <section v-else-if="section === '任务'" class="settings-layout">
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>{{ scan ? "当前任务" : "开始新的采集任务" }}</h2>
                <p>
                  {{
                    scan ? scan.name : "默认采集全部网页，按 Filter 留存请求。"
                  }}
                </p>
              </div>
              <span v-if="scan" class="task-status" :class="scan.state">{{
                labels[scan.state]
              }}</span>
            </div>
            <template v-if="scan"
              ><div class="task-facts">
                <div>
                  <small>开始时间</small
                  ><strong>{{ timeText(scan.started_at) }}</strong>
                </div>
                <div>
                  <small>配置版本</small
                  ><strong>v{{ scan.versions.length }}</strong>
                </div>
                <div>
                  <small>采集范围</small
                  ><strong>{{
                    scan.tab_scope === "all"
                      ? "浏览器全局 · 自动接入新页"
                      : "历史指定范围"
                  }}</strong>
                </div>
              </div>
              <div v-for="t in scan.tabs" :key="t.id" class="authorized-page">
                <span class="site-icon"><Icon name="globe" :size="18" /></span>
                <div>
                  <strong>标签页 {{ t.id }}</strong
                  ><span>{{ t.url }}</span>
                </div>
                <span class="pill teal">已纳入</span>
              </div></template
            >
            <div v-else class="empty-state compact">
              <Icon name="globe" :size="32" />
              <p>开始一次浏览器级采集，通过 Filter 留存需要的请求。</p>
              <button class="button primary" @click="run(openNewTask)">
                创建任务
              </button>
            </div>
          </div>
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>采集与归并策略</h2>
                <p>保存后生成新版本，已接收的请求继续使用原版本。</p>
              </div>
              <button
                class="button primary"
                :disabled="busy || !activeTask || scan?.state === 'draining'"
                @click="run(apply)"
              >
                保存策略
              </button>
            </div>
            <div class="form-grid">
              <label
                >留存方式<select
                  :value="configForm.retention"
                  @change="
                    (e) =>
                      setConfig(
                        'retention',
                        (e.target as HTMLSelectElement).value,
                      )
                  "
                >
                  <option value="matching">匹配留存 · 命中与无法判定</option>
                  <option value="all">全量留存 · Filter 用于查看和导出</option>
                </select></label
              ><label
                >字段值保存<select
                  :value="configForm.value_storage"
                  @change="
                    (e) =>
                      setConfig(
                        'value_storage',
                        (e.target as HTMLSelectElement).value,
                      )
                  "
                >
                  <option value="complete">完整保留 · 不截断字段值</option>
                  <option value="truncate">自动截断 · 快速保存分析</option>
                </select></label
              ><label
                >归并模式<select
                  :value="configForm.merge"
                  @change="
                    (e) =>
                      setConfig('merge', (e.target as HTMLSelectElement).value)
                  "
                >
                  <option value="none">不归并</option>
                  <option value="exact">精确归并</option>
                  <option value="normalized">智能归并 · 显式动态字段</option>
                  <option value="representative">仅代表记录（有损）</option>
                </select></label
              ><label
                >动态 Query 字段<input
                  :value="configForm.dynamic_query.join(', ')"
                  placeholder="例如 ts, timestamp，不填则不忽略"
                  @change="(e) => setList('dynamic_query', e)" /></label
              ><label
                >动态 JSON 路径<input
                  :value="configForm.dynamic_json.join(', ')"
                  placeholder="例如 metadata.traceId"
                  @change="(e) => setList('dynamic_json', e)" /></label
              ><label
                >单条正文上限（MB）<input
                  type="number"
                  min="0.001"
                  step="0.25"
                  :disabled="configForm.value_storage === 'complete'"
                  :value="configForm.body_limit / 1048576"
                  @change="(e) => setNumber('body_limit', e, 1048576)"
                /><small
                  >仅“自动截断”模式使用；字段名在两种模式下都完整保存。</small
                ></label
              ><label
                >停止时等待在途请求（秒）<input
                  type="number"
                  min="0"
                  max="60"
                  :value="configForm.stop_wait_ms / 1000"
                  @change="(e) => setNumber('stop_wait_ms', e, 1000)"
              /></label>
            </div>
            <div class="toggle-row">
              <div>
                <strong>归一化 UUID 路径段</strong>
                <p>仅在显式开启时替换 UUID；业务资源 ID 默认保留。</p>
              </div>
              <input
                type="checkbox"
                :checked="configForm.uuid_path"
                @change="
                  (e) =>
                    setConfig(
                      'uuid_path',
                      (e.target as HTMLInputElement).checked,
                    )
                "
              />
            </div>
            <div class="toggle-row">
              <div>
                <strong>分组要求相同发起脚本</strong>
                <p>用于区分相同接口的不同脚本来源。</p>
              </div>
              <input
                type="checkbox"
                :checked="configForm.same_initiator"
                @change="
                  (e) =>
                    setConfig(
                      'same_initiator',
                      (e.target as HTMLInputElement).checked,
                    )
                "
              />
            </div>
            <p
              v-if="configForm.merge === 'representative'"
              class="message-banner warning"
            >
              <Icon
                name="alert"
              />代表模式有损，无法恢复每次原始观察；建议保留原始记录。
            </p>
            <details class="technical-details">
              <summary>高级配置 JSON</summary>
              <textarea
                v-model="configText"
                rows="22"
                spellcheck="false"
                aria-label="任务高级配置"
              ></textarea>
            </details>
          </div>
        </section>
        <section v-else-if="section === 'Filter'" class="settings-layout">
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>请求过滤</h2>
                <p>只用一个搜索框决定保存哪些请求；空框保存全部请求。</p>
              </div>
            </div>
            <SimpleFilter
              v-model="filterText"
              @validity="filterValid = $event"
            />
            <div class="filter-action-bar" aria-label="过滤规则操作">
              <p
                class="filter-action-status"
                :class="{ warning: filterActionWarning }"
                aria-live="polite"
              >
                <Icon
                  :name="
                    filterFeedback || (filterValid && activeTask)
                      ? 'check'
                      : 'alert'
                  "
                  :size="15"
                />{{ filterActionText }}
              </p>
              <div class="filter-action-controls">
                <button
                  class="button"
                  :disabled="busy || !filterValid"
                  @click="run(preview)"
                >
                  <Icon name="search" :size="15" />预览当前列表
                </button>
                <button
                  class="button primary"
                  :disabled="
                    !activeTask || busy || !filterValid || !filterDirty
                  "
                  @click="run(apply)"
                >
                  应用到当前任务
                </button>
              </div>
            </div>
          </div>
        </section>
        <section v-else-if="section === '存储与转存'" class="settings-layout">
          <div class="storage-summary">
            <div class="panel">
              <span class="metric-icon teal"
                ><Icon name="database" :size="21"
              /></span>
              <h2>本地持久化</h2>
              <strong class="storage-number">{{
                bytesText(scan?.stats.bytes)
              }}</strong>
              <p>
                {{ scan?.stats.persisted ?? 0 }} 条已保存请求 · 不包含索引开销
              </p>
              <div class="capacity-track">
                <span
                  :style="{
                    width:
                      Math.min(
                        100,
                        ((scan?.stats.bytes ?? 0) / configForm.storage_limit) *
                          100,
                      ) + '%',
                  }"
                ></span>
              </div>
              <small
                >请求数据上限 {{ bytesText(configForm.storage_limit) }} · 达到
                80% 告警</small
              >
            </div>
            <div v-for="c in counts" :key="c.channel" class="panel">
              <span
                class="metric-icon"
                :class="c.channel === 'file' ? 'blue' : 'purple'"
                ><Icon
                  :name="c.channel === 'file' ? 'folder' : 'external'"
                  :size="21"
              /></span>
              <h2>{{ c.channel === "file" ? "文件归档" : "内部服务转存" }}</h2>
              <strong class="storage-number"
                >{{ c.complete.toLocaleString() }}<em>条完成</em></strong
              >
              <p>
                {{ c.pending + c.unplanned }} 待处理 ·
                {{ c.downloading }} 下载中 ·
                <span :class="{ 'warning-text': c.failed }"
                  >{{ c.failed }} 失败</span
                >
              </p>
              <span class="pill">{{
                c.channel === "file"
                  ? configForm.archive.enabled
                    ? "自动归档已开启"
                    : "自动归档已关闭"
                  : configForm.service.enabled
                    ? "服务转存已开启"
                    : "服务转存未启用"
              }}</span>
            </div>
          </div>
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>归档与接收服务</h2>
                <p>文件完成与服务持久化回执分别确认；失败保留原始本地数据。</p>
              </div>
              <div class="inline">
                <button
                  class="button"
                  :disabled="busy || !scan"
                  @click="run(() => action('archive'))"
                >
                  立即归档 / 转存</button
                ><button
                  class="button"
                  :disabled="busy || !scan"
                  @click="run(() => action('retry'))"
                >
                  <Icon name="refresh" :size="14" />重试失败批次
                </button>
              </div>
            </div>
            <div class="toggle-row">
              <div>
                <strong>自动文件归档</strong>
                <p>按时间、大小、数量或停止动作触发，使用浏览器下载目录。</p>
              </div>
              <input
                type="checkbox"
                :checked="configForm.archive.enabled"
                @change="
                  (e) =>
                    setConfig(
                      'archive.enabled',
                      (e.target as HTMLInputElement).checked,
                    )
                "
              />
            </div>
            <div class="form-grid">
              <label
                >文件归档间隔（分钟）<input
                  type="number"
                  min="0.5"
                  step="0.5"
                  :value="configForm.archive.interval_ms / 60000"
                  @change="
                    (e) => setNumber('archive.interval_ms', e, 60000)
                  " /></label
              ><label
                >文件分片上限（MB）<input
                  type="number"
                  min="1"
                  max="20"
                  :value="configForm.archive.bytes / 1048576"
                  @change="(e) => setNumber('archive.bytes', e, 1048576)"
              /></label>
            </div>
            <div class="toggle-row">
              <div>
                <strong>内部 HTTPS 接收服务</strong>
                <p>仅发送到明确授权的接收地址，默认关闭。</p>
              </div>
              <input
                type="checkbox"
                :checked="configForm.service.enabled"
                @change="
                  (e) =>
                    setConfig(
                      'service.enabled',
                      (e.target as HTMLInputElement).checked,
                    )
                "
              />
            </div>
            <div class="form-grid">
              <label
                >接收服务 URL<input
                  :value="configForm.service.url"
                  placeholder="https://receiver.example/ingest"
                  @input="
                    (e) =>
                      setConfig(
                        'service.url',
                        (e.target as HTMLInputElement).value,
                      )
                  " /></label
              ><label
                >会话 Bearer Token（可选）<input
                  v-model="serviceToken"
                  type="password"
                  autocomplete="off"
                  placeholder="仅保存在当前浏览器会话"
              /></label>
            </div>
            <div class="panel-footer">
              <button class="button" @click="run(authorize)">
                <Icon name="shield" :size="15" />授权接收服务</button
              ><button
                class="button primary"
                :disabled="busy || !activeTask"
                @click="run(apply)"
              >
                保存转存策略
              </button>
            </div>
          </div>
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>批次进度</h2>
                <p>已提交下载不等于下载完成；HTTP 成功不等于服务已持久化。</p>
              </div>
              <span class="pill">{{ batches.length }} 个批次</span>
            </div>
            <table v-if="batches.length" class="data-table">
              <thead>
                <tr>
                  <th>渠道 / 批次</th>
                  <th>记录数</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in batches" :key="b.id">
                  <td>
                    {{ b.channel === "file" ? "文件归档" : "接收服务"
                    }}<small class="mono">{{ b.id }}</small>
                  </td>
                  <td>{{ b.records.length }}</td>
                  <td>
                    <span class="pill">{{ batchStateLabels[b.state] }}</span>
                  </td>
                  <td>{{ b.attempts }} / 3</td>
                  <td>{{ b.error ?? "—" }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="inline-empty">尚未生成转存批次。</div>
          </div>
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>采集异常与中断</h2>
                <p>完整记录随任务包导出；此处显示任务最近的异常摘要。</p>
              </div>
            </div>
            <table v-if="scan?.gaps.length" class="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in scan.gaps" :key="g.id">
                  <td class="nowrap">{{ timeText(g.timestamp) }}</td>
                  <td>{{ g.type }}</td>
                  <td>{{ g.reason }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="inline-empty">暂无异常摘要。</div>
          </div>
        </section>
        <section v-else-if="section === '历史任务'" class="panel history-panel">
          <div class="panel-heading">
            <div>
              <h2>已保存的任务</h2>
              <p>
                采集结束和转存完成分别记录，重新打开后仍可查看全部已保存字段。
              </p>
            </div>
            <span class="pill">{{ history.length }} 个任务</span>
          </div>
          <table v-if="history.length" class="data-table">
            <thead>
              <tr>
                <th>任务名称</th>
                <th>采集状态</th>
                <th>已保存 / 分组</th>
                <th>开始时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in history" :key="s.id">
                <td>
                  <button
                    class="history-name"
                    :disabled="busy"
                    @click="
                      run(async () => {
                        await choose(s.id);
                        section = '请求';
                      })
                    "
                  >
                    <Icon name="folder" :size="17" />{{ s.name }}</button
                  ><small
                    >{{ s.tabs.length }} 个已纳入页面 · 规则 v{{
                      s.versions.length
                    }}<span v-if="s.integrity === 'gaps'">
                      · 包含采集缺口</span
                    ></small
                  >
                </td>
                <td>
                  <span class="task-status" :class="s.state"
                    ><span class="tiny-dot"></span>{{ labels[s.state] }}</span
                  >
                </td>
                <td>
                  {{ s.stats.persisted.toLocaleString() }} /
                  {{ s.stats.groups.toLocaleString() }}
                </td>
                <td>{{ timeText(s.started_at) }}</td>
                <td>
                  <div class="inline">
                    <button
                      class="text-button"
                      :disabled="busy"
                      @click="
                        run(async () => {
                          await choose(s.id);
                          section = '请求';
                        })
                      "
                    >
                      打开任务</button
                    ><button
                      class="icon-button"
                      :aria-label="'删除任务 ' + s.name"
                      :disabled="
                        busy || (current?.id === s.id && s.state !== 'ended')
                      "
                      @click="
                        run(async () => {
                          await choose(s.id);
                          await deleteScan();
                        })
                      "
                    >
                      <Icon name="trash" :size="16" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-state">
            <Icon name="clock" :size="30" />
            <h3>还没有历史任务</h3>
            <p>新建采集任务后，数据会持续保存在此浏览器中。</p>
          </div>
        </section>
        <section v-else class="settings-layout guide">
          <div class="panel">
            <div class="panel-heading">
              <div>
                <h2>完成一次可回查的采集</h2>
                <p>测试人员操作业务页面，插件记录请求及可取得的上下文。</p>
              </div>
              <span class="metric-icon blue"
                ><Icon name="bolt" :size="20"
              /></span>
            </div>
            <div
              v-for="(step, i) in [
                {
                  title: '设置 Filter，开始任务',
                  text: '点击“新建采集任务”，默认纳入全部网页及新打开的网页，通过 Filter 限定要保留的请求，无需选择标签页。',
                },
                {
                  title: '正常执行业务操作',
                  text: '切换到测试页面触发场景。返回请求工作台，可看到保存数量与实时列表。',
                },
                {
                  title: '点击请求，检查采集信息',
                  text: '右侧详情可查看完整 URL、重复参数、请求头、正文、调用栈及缺失原因。切换“聚合”可回查同组原始观察。',
                },
                {
                  title: '停止并导出',
                  text: '停止时处理在途请求；之后从右上角导出 JSONL 任务包、CSV 或分片目录。',
                },
              ]"
              :key="i"
              class="guide-step"
            >
              <span>{{ i + 1 }}</span>
              <div>
                <h3>{{ step.title }}</h3>
                <p>{{ step.text }}</p>
              </div>
            </div>
          </div>
          <div class="panel">
            <h2>理解采集边界</h2>
            <div class="guide-notes">
              <p>
                <Icon name="shield" />两种模式都保留字段名，也不按 Cookie、Token
                等名称脱敏。“完整保留”保存所有值；“自动截断”只裁剪超长值并标记原始长度。
              </p>
              <p>
                <Icon name="code" />调用栈、Worker
                和子框架受浏览器可观测性影响，缺失会标记原因，不由模型补写。
              </p>
              <p>
                <Icon
                  name="activity"
                />暂停后不纳入新请求；关闭管理页后后台继续采集。调试断开和后台重启会登记缺口，恢复不代表中断时段已采集。
              </p>
              <p>
                <Icon name="file" />当前采集请求正文，响应正文和 WebSocket
                消息帧未纳入。大任务建议使用目录分片导出。
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
    <div
      v-if="newTaskOpen"
      class="modal-backdrop"
      @click.self="!busy && (newTaskOpen = false)"
    >
      <section
        class="task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <div class="modal-header">
          <div>
            <p class="eyebrow">NEW CAPTURE</p>
            <h2 id="new-task-title">新建采集任务</h2>
            <p>默认采集全部网页，按 Filter 留存真实请求。</p>
          </div>
          <button
            class="icon-button"
            aria-label="关闭新建任务"
            :disabled="busy"
            @click="newTaskOpen = false"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <label class="field-label"
            >任务名称<input
              v-model="name"
              placeholder="例如：控制台登录与订单流程"
          /></label>
          <div class="capture-scope">
            <Icon name="globe" :size="22" />
            <div>
              <strong>浏览器全局采集</strong
              ><small>当前与新开的网页自动接入，无需选择标签页</small>
            </div>
          </div>
          <p class="scope-summary">
            覆盖当前浏览器所有窗口的普通网页。阿里云等业务跳转到新页面后，会自动继续采集。可以先开始任务，再打开网站；用
            Filter 筛选需要保存的请求。
          </p>
          <div class="form-grid">
            <label
              >字段值保存<select v-model="draftConfig.value_storage">
                <option value="complete">完整保留 · 所有字段值原样保存</option>
                <option value="truncate">
                  自动截断 · 适合快速保存分析
                </option></select
              ><small
                >字段名始终完整；两种模式都不按敏感字段名脱敏。</small
              ></label
            ><label
              >归并模式<select v-model="draftConfig.merge">
                <option value="none">不归并</option>
                <option value="exact">精确归并</option>
                <option value="normalized">智能归并 · 保留原始观察</option>
                <option value="representative">仅代表记录（有损）</option>
              </select></label
            >
          </div>
          <div class="new-task-filter">
            <div class="section-heading">
              <div>
                <h3>只保留你关心的请求</h3>
                <p>直接输入网址关键词，也可以点下面的常用筛选。</p>
              </div>
            </div>
            <SimpleFilter
              v-model="draftFilterText"
              @validity="draftFilterValid = $event"
            />
          </div>
          <label class="archive-choice"
            ><input
              type="checkbox"
              v-model="draftConfig.archive.enabled"
            /><span
              ><strong>启用自动文件归档</strong
              ><small
                >默认按 5 分钟 / 20 MB 分片；也可以随时手动导出。</small
              ></span
            ></label
          >
          <p class="permission-note">
            <Icon name="shield" :size="15" /><span
              >跳过浏览器内部页面与扩展页面。Chrome
              会显示调试提示；保存符合上方筛选的请求，无法判定的请求会保留并标注。字段值按上方模式保存。</span
            >
          </p>
        </div>
        <footer class="modal-footer">
          <span>浏览器全局采集 · 按上方条件留存</span
          ><button class="button" :disabled="busy" @click="newTaskOpen = false">
            取消</button
          ><button
            class="button primary"
            :disabled="busy || !canStart || !draftFilterValid"
            @click="run(start)"
          >
            <Icon :name="busy ? 'refresh' : 'play'" :size="15" />{{
              busy ? "正在启动…" : "开始采集"
            }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>
