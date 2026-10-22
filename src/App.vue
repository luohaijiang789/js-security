<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import RuleEditor from "./RuleEditor.vue";
import {
  defaults,
  type Rule,
  type Scan,
  type RecordEntry,
  type Group,
  type Batch,
  type Filter,
} from "./model";
import { validateConfig } from "./config";
import { presets, validateFilter, matchFilter } from "./filter";
import * as db from "./store";
import { packageFiles, csv, jsonl } from "./export";
const tabs = ref<chrome.tabs.Tab[]>([]),
  selectedTabs = ref<number[]>([]),
  name = ref("业务请求采集");
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
  templateName = ref(""),
  templates = ref<Record<string, Filter>>({ ...presets }),
  template = ref("全量");
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
const visualFilter = computed<Filter | null>(() => {
  try {
    return JSON.parse(filterText.value);
  } catch {
    return null;
  }
});
function setRule(key: keyof Filter, rule?: Rule) {
  const f = { ...(visualFilter.value ?? {}) };
  if (rule) f[key] = rule;
  else delete f[key];
  filterText.value = JSON.stringify(f, null, 2);
}
let searchTimer: ReturnType<typeof setTimeout>;
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    after.value = "";
    cursors.value = [];
    void loadPage();
  }, 300);
});
const labels: Record<string, string> = {
  recording: "采集中",
  paused: "暂停",
  draining: "处理中",
  ended: "已结束",
  interrupted: "已中断",
};
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
  error.value = "";
  notice.value = "";
  try {
    await fn();
    await refresh();
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}
async function refreshTabs() {
  tabs.value = (await chrome.tabs.query({})).filter((t) =>
    /^https?:/.test(t.url ?? ""),
  );
}
async function viewGroup(g: Group) {
  detail.value =
    (await db.get<RecordEntry>("requests", g.representative_id)) ?? null;
  search.value = g.id;
  mode.value = "原始";
}
async function exportTemplates() {
  await saveBlob(
    new Blob([JSON.stringify(templates.value, null, 2)], {
      type: "application/json",
    }),
    "filter_templates.json",
  );
}
async function loadPage() {
  if (!scanId.value) {
    rows.value = [];
    return;
  }
  rows.value = await db.searchPage(
    scanId.value,
    search.value,
    after.value,
    100,
  );
  groups.value = await db.groupPage(scanId.value, groupOffset.value, 100);
  batches.value = await db.all<Batch>("batches", scanId.value);
}
async function refresh() {
  const state = await rpc("state");
  current.value = state.scan;
  failure.value = state.failure;
  queued.value = state.queued;
  pending.value = state.pending;
  history.value = (await db.all<Scan>("scans")).sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  if (!scanId.value && current.value) scanId.value = current.value.id;
  await loadPage();
}
async function choose(id: string) {
  scanId.value = id;
  after.value = "";
  cursors.value = [];
  groupOffset.value = 0;
  detail.value = null;
  selected.value = [];
  await loadPage();
  const s = scan.value;
  if (s) {
    configText.value = JSON.stringify(s.config, null, 2);
    filterText.value = JSON.stringify(s.config.filter, null, 2);
  }
}
async function start() {
  const c = JSON.parse(configText.value);
  c.filter = JSON.parse(filterText.value);
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
    tabs: selectedTabs.value,
    config: c,
  });
  await choose(s.id);
}
async function action(type: string) {
  await rpc(type, { id: scanId.value });
}
async function apply() {
  const c = JSON.parse(configText.value);
  c.filter = JSON.parse(filterText.value);
  validateConfig(c);
  await rpc("update", { id: scanId.value, config: c });
  notice.value = "新配置已生效；已接收请求继续使用原版本。";
}
async function saveTemplate() {
  const f = JSON.parse(filterText.value);
  validateFilter(f);
  if (!templateName.value.trim()) throw Error("请输入模板名");
  templates.value[templateName.value.trim()] = f;
  await chrome.storage.local.set({ filter_templates: templates.value });
  template.value = templateName.value.trim();
  notice.value = "模板已保存";
}
async function removeTemplate() {
  delete templates.value[template.value];
  await chrome.storage.local.set({ filter_templates: templates.value });
  template.value = Object.keys(templates.value)[0] ?? "";
}
function useTemplate() {
  filterText.value = JSON.stringify(
    templates.value[template.value] ?? {},
    null,
    2,
  );
}
async function importTemplates(event: Event) {
  const f = (event.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const t = JSON.parse(await f.text());
  if (!t || typeof t !== "object" || Array.isArray(t))
    throw Error("模板应为名称到 Filter 的对象");
  for (const [k, v] of Object.entries(t)) {
    validateFilter(v as Filter);
    templates.value[k] = v as Filter;
  }
  await chrome.storage.local.set({ filter_templates: templates.value });
}
async function preview() {
  const f = JSON.parse(filterText.value);
  validateFilter(f);
  const stats = { matched: 0, excluded: 0, unknown: 0 };
  rows.value.forEach((r) => stats[matchFilter(f, r, true)]++);
  notice.value = `本页已脱敏记录预览：命中 ${stats.matched}，排除 ${stats.excluded}，无法判定 ${stats.unknown}；原始值规则可能与实采不同。`;
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
async function downloadZip(scope: "all" | "filter" | "selected") {
  if (!scan.value) return;
  const bytes = await packageFiles(scan.value, scope, selected.value);
  await saveBlob(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    `EO_SCAN_${scan.value.id}.zip`,
  );
  notice.value = "已提交下载；请在浏览器下载列表确认文件完成。";
}
async function exportCSV() {
  if (!scan.value) return;
  const picker = (window as any).showSaveFilePicker;
  if (!picker) throw Error("当前 Chrome 不支持文件访问，请下载本页 CSV");
  const h = await picker({ suggestedName: "requests.csv" }),
    w = await h.createWritable();
  let cursor = "",
    first = true;
  try {
    while (true) {
      const batch = await db.page(scan.value.id, cursor, 500);
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
    await w.close();
    notice.value = "全部请求 CSV 已完成写入";
  } catch (e) {
    await w.abort();
    throw e;
  }
}
async function exportDirectory() {
  if (!scan.value) return;
  const picker = (window as any).showDirectoryPicker;
  if (!picker) throw Error("当前 Chrome 不支持目录访问，请使用 ZIP");
  const root = await picker({ mode: "readwrite" });
  const directory = await root.getDirectoryHandle(`EO_SCAN_${scan.value.id}`, {
    create: true,
  });
  let cursor = "",
    index = 1,
    w: any = null,
    bytes = 0,
    count = 0,
    total = 0;
  const shards: { file: string; count: number; bytes: number }[] = [];
  const max = scan.value.config.archive.bytes;
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
      const batch = await db.page(scan.value.id, cursor, 200);
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
          const group = await db.groupPage(scan.value.id, offset, 200);
          if (!group.length) break;
          await file.write(jsonl(group));
          offset += group.length;
        }
      } else {
        let offset = 0;
        while (true) {
          const errors = await db.errorPage(scan.value.id, offset, 200);
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
          scan: scan.value,
          shards,
          batches: batches.value,
          exported_at: new Date().toISOString(),
          lossy: scan.value.config.merge === "representative",
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
  if (mode.value === "聚合") {
    groupOffset.value += 100;
  } else {
    if (rows.value.length < 100) return;
    cursors.value.push(after.value);
    after.value = rows.value.at(-1)!.request_id;
  }
  await loadPage();
}
async function prev() {
  if (mode.value === "聚合")
    groupOffset.value = Math.max(0, groupOffset.value - 100);
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
    tabs.value = (await chrome.tabs.query({})).filter((t) =>
      /^https?:/.test(t.url ?? ""),
    );
    const saved = await chrome.storage.local.get("filter_templates");
    if (saved.filter_templates)
      templates.value = saved.filter_templates as Record<string, Filter>;
    await refresh();
  });
  timer = setInterval(() => {
    if (!busy.value) void refresh().catch((e) => (error.value = String(e)));
  }, 1000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="shell">
    <aside>
      <div class="brand">JS<span> 请求采集</span></div>
      <p class="muted">浏览器实测 · v0.1.0</p>
      <nav>
        <button
          v-for="item in [
            '请求',
            '任务',
            'Filter',
            '存储与转存',
            '历史任务',
            '使用说明',
          ]"
          :key="item"
          :class="{ active: section === item }"
          @click="section = item"
        >
          {{ item }}
        </button>
      </nav>
      <div class="side-note">
        仅采集明确选定的标签页。<br />关闭此页面，后台继续运行。
      </div>
    </aside>
    <main>
      <header>
        <div>
          <p class="eyebrow">JS SECURITY / REQUEST RECORDER</p>
          <h1>{{ section }}</h1>
        </div>
        <span class="status" :class="scan?.state">{{
          scan ? labels[scan.state] : "未开始"
        }}</span>
      </header>
      <div v-if="error || failure" class="alert">{{ error || failure }}</div>
      <div v-if="notice" class="notice">{{ notice }}</div>
      <div v-if="scan" class="toolbar">
        <strong>{{ scan.name }}</strong
        ><span class="muted"
          >{{ scan.started_at }} · 规则 v{{ scan.versions.length }}</span
        ><button
          v-if="current?.state === 'recording'"
          :disabled="busy"
          @click="run(() => action('pause'))"
        >
          暂停</button
        ><button
          v-if="['paused', 'interrupted'].includes(scan.state)"
          :disabled="busy"
          @click="run(() => action('resume'))"
        >
          恢复</button
        ><button
          v-if="scan && scan.state !== 'ended'"
          :disabled="busy"
          @click="run(() => action('stop'))"
        >
          停止并写盘
        </button>
      </div>
      <section v-if="scan" class="metrics">
        <div
          v-for="[label, value] in [
            ['已观测', scan.stats.observed],
            ['Pending', scan.stats.pending],
            ['命中', scan.stats.matched],
            ['排除', scan.stats.excluded],
            ['无法判定', scan.stats.unknown],
            ['已持久化', scan.stats.persisted],
            ['分组', scan.stats.groups],
            ['已知丢失事件', scan.stats.lost],
          ]"
          :key="String(label)"
        >
          <small>{{ label }}</small
          ><strong>{{ value }}</strong>
        </div>
      </section>
      <template v-if="section === '请求'">
        <div class="toolbar">
          <select v-model="scanId" @change="run(() => choose(scanId))">
            <option value="">选择任务</option>
            <option v-for="s in history" :key="s.id" :value="s.id">
              {{ s.name }} · {{ labels[s.state] }}
            </option></select
          ><select v-model="mode">
            <option>原始</option>
            <option>聚合</option></select
          ><input
            v-model="search"
            placeholder="搜索整个任务的 URL、字段、调用栈…"
          /><button @click="run(prev)">上一页</button
          ><button @click="run(next)">下一页</button>
        </div>
        <div class="card table-wrap">
          <table v-if="mode === '原始'">
            <thead>
              <tr>
                <th></th>
                <th>方法 / 状态</th>
                <th>请求 URL</th>
                <th>类型</th>
                <th>采集状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in shown" :key="r.request_id" @click="detail = r">
                <td @click.stop>
                  <input
                    v-model="selected"
                    type="checkbox"
                    :value="r.request_id"
                  />
                </td>
                <td>
                  <b>{{ r.method }}</b
                  ><br />{{ r.status_code ?? r.request_state }}
                </td>
                <td class="url">
                  {{ r.request_url
                  }}<small>{{ r.page_url ?? "页面未知" }}</small>
                </td>
                <td>{{ r.resource_type }}</td>
                <td>
                  {{ r.filter_result }}<br /><small
                    >头 {{ r.capture_status.headers.state }} · body
                    {{ r.capture_status.body.state }}</small
                  >
                </td>
              </tr>
            </tbody>
          </table>
          <table v-else>
            <thead>
              <tr>
                <th>归一化 URL</th>
                <th>次数</th>
                <th>关联</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in groups" :key="g.id">
                <td class="url">
                  {{ g.normalized_url }}<small>{{ g.id }}</small>
                </td>
                <td>{{ g.count }}</td>
                <td>
                  {{ g.candidate ? "候选分组" : "按配置归并" }}<br /><button
                    @click="run(() => viewGroup(g))"
                  >
                    查看代表记录
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!rows.length" class="empty">
            尚无已保存请求。选择任务和标签页后开始采集。
          </p>
        </div>
        <p class="muted">
          每页 100 条。搜索作用于全部已保存请求；聚合不替代原始请求。队列
          {{ queued }} 个事件 / {{ pending }} 条请求与待写记录。
        </p>
        <div class="toolbar">
          <button :disabled="busy || !scan" @click="run(exportDirectory)">
            导出任务目录（流式）</button
          ><button
            :disabled="busy || !scan"
            @click="run(() => downloadZip('all'))"
          >
            下载完整 ZIP</button
          ><button
            :disabled="busy || !scan"
            @click="run(() => downloadZip('filter'))"
          >
            当前 Filter 包</button
          ><button
            :disabled="busy || !selected.length"
            @click="run(() => downloadZip('selected'))"
          >
            指定请求包 {{ selected.length }}</button
          ><button :disabled="busy || !scan" @click="run(exportCSV)">
            全部请求 CSV
          </button>
        </div>
        <div v-if="detail" class="card">
          <div class="toolbar">
            <h2>请求详情</h2>
            <button @click="detail = null">关闭</button>
          </div>
          <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
        </div>
      </template>
      <template v-if="section === '任务'">
        <section class="card">
          <h2>新建任务</h2>
          <label>任务名称<input v-model="name" /></label>
          <h3>授权标签页</h3>
          <label v-for="t in tabs" :key="t.id" class="tab"
            ><input v-model="selectedTabs" type="checkbox" :value="t.id" />{{
              t.title
            }}<small>{{ t.url }}</small></label
          ><button @click="run(refreshTabs)">刷新标签页</button
          ><button
            class="primary"
            :disabled="busy || (!!current && current.state !== 'ended')"
            @click="run(start)"
          >
            开始采集
          </button>
        </section>
        <section class="card">
          <h2>任务策略</h2>
          <p class="muted">
            高级配置 JSON。动态参数默认不忽略；仅代表记录模式有损。Filter
            使用独立编辑器中的配置。
          </p>
          <textarea v-model="configText" rows="24" spellcheck="false"></textarea
          ><button
            :disabled="
              busy ||
              !current ||
              !['recording', 'paused'].includes(current.state)
            "
            @click="run(apply)"
          >
            保存为新版本
          </button>
        </section>
      </template>
      <template v-if="section === 'Filter'">
        <section class="card">
          <h2>Scope AND Include AND NOT Exclude</h2>
          <div class="toolbar">
            <select v-model="template" @change="useTemplate">
              <option v-for="(_, k) in templates" :key="k">
                {{ k }}
              </option></select
            ><button @click="useTemplate">应用模板到编辑器</button
            ><button @click="run(removeTemplate)">删除模板</button>
          </div>
          <div v-if="visualFilter" class="visual-filter">
            <div
              v-for="key in ['scope', 'include', 'exclude'] as const"
              :key="key"
            >
              <h3>
                {{ key.toUpperCase() }}
                <button
                  v-if="!visualFilter[key]"
                  @click="
                    setRule(key, {
                      field: 'request_url',
                      operator: 'contains',
                      values: [''],
                    })
                  "
                >
                  启用</button
                ><button v-else @click="setRule(key)">停用</button>
              </h3>
              <RuleEditor
                v-if="visualFilter[key]"
                :rule="visualFilter[key]!"
                @change="(r) => setRule(key, r)"
              />
            </div>
          </div>
          <details>
            <summary>高级 JSON 编辑器</summary>
            <textarea
              v-model="filterText"
              rows="22"
              spellcheck="false"
            ></textarea>
          </details>
          <div class="toolbar">
            <input
              v-model="templateName"
              placeholder="新模板 / 复制后的名称"
            /><button @click="run(saveTemplate)">保存 / 复制</button
            ><button @click="run(preview)">预览本页结果</button
            ><button :disabled="!current || busy" @click="run(apply)">
              应用到采集任务
            </button>
          </div>
          <p>
            导入模板 JSON
            <input
              type="file"
              accept=".json"
              @change="(e) => run(() => importTemplates(e))"
            /><button @click="run(exportTemplates)">导出模板</button>
          </p>
          <pre>{{ JSON.stringify(scan?.rule_hits ?? {}, null, 2) }}</pre>
        </section>
      </template>
      <template v-if="section === '存储与转存'">
        <section class="card">
          <h2>本地数据与待处理项</h2>
          <p>
            任务请求数据约
            {{ ((scan?.stats.bytes ?? 0) / 1048576).toFixed(2) }} MB；队列
            {{ queued }}。完整性：{{ scan?.integrity ?? "未开始" }}。
          </p>
          <p class="muted">
            IndexedDB 默认开启。文件归档默认 5 分钟 / 20
            MB。浏览器报告下载完成后才记为完成；服务须确认持久化。到期任务保留并提示人工审核，不自动删除证据。
          </p>
          <div v-for="c in counts" :key="c.channel" class="toolbar">
            <b>{{ c.channel === "file" ? "文件归档" : "服务转存" }}</b
            ><span
              >完成 {{ c.complete }} · 待处理 {{ c.pending + c.unplanned }} ·
              下载中 {{ c.downloading }} · 失败 {{ c.failed }} 条</span
            >
          </div>
          <button
            :disabled="busy || !scan"
            @click="run(() => action('archive'))"
          >
            立即归档 / 转存</button
          ><button
            :disabled="busy || !scan"
            @click="run(() => action('retry'))"
          >
            重试失败批次
          </button>
          <details>
            <summary>批次进度与错误</summary>
            <pre>{{ JSON.stringify(batches, null, 2) }}</pre>
          </details>
        </section>
        <section class="card">
          <h2>可选内部接收服务</h2>
          <p>
            先在任务策略填写 service.url，再授权该 HTTPS 服务。可选 Bearer Token
            仅存当前浏览器会话。
          </p>
          <input
            v-model="serviceToken"
            type="password"
            autocomplete="off"
            placeholder="可选 Bearer Token"
          /><button @click="run(authorize)">授权策略中的接收服务</button>
          <p class="muted">
            启用 service.enabled 后保存策略。服务返回 { batch_id, persisted:
            true }；按 Idempotency-Key 去重。最多自动尝试 3
            次，失败保留本地进度。
          </p>
        </section>
        <section class="card">
          <h2>中断与异常</h2>
          <pre>{{ JSON.stringify(scan?.gaps ?? [], null, 2) }}</pre>
        </section>
      </template>
      <template v-if="section === '历史任务'"
        ><section v-for="s in history" :key="s.id" class="card">
          <div class="toolbar">
            <h2>{{ s.name }}</h2>
            <span
              >{{ labels[s.state] }} · {{ s.stats.persisted }} 条 ·
              {{ s.integrity }} · {{ s.versions.length }} 个配置版本</span
            ><button
              @click="
                run(async () => {
                  await choose(s.id);
                  section = '请求';
                })
              "
            >
              查看与导出</button
            ><button
              @click="
                run(async () => {
                  await choose(s.id);
                  await deleteScan();
                })
              "
            >
              删除
            </button>
          </div>
          <small
            >{{ s.started_at }} → {{ s.ended_at ?? "尚未结束" }}
            <b
              v-if="
                Date.now() - Date.parse(s.started_at) >
                s.config.retention_days * 86400000
              "
              >已达到保留期限，请审核未转存证据后清理</b
            ></small
          >
        </section></template
      >
      <section v-if="section === '使用说明'" class="card prose">
        <h2>测试人员正常执行业务，插件记录可观测请求</h2>
        <ol>
          <li>进入“任务”，勾选明确授权的标签页，检查 Filter 和策略后开始。</li>
          <li>
            在所选页面触发测试场景。Chrome 将显示调试提示；其他 DevTools
            调试可能导致附加失败或断开。
          </li>
          <li>
            暂停不再接收新请求；停止等待在途事件，超时明确标记未完成，再写盘归档。
          </li>
          <li>
            查看原始记录、调用栈和缺失原因；大任务使用“导出任务目录”或 CSV
            流式写文件。
          </li>
        </ol>
        <p>
          默认保护 Cookie、认证和常见敏感字段；未结构化正文不存原值。URL
          路径、非敏感字段仍保留业务数据，请只在授权环境采集。当前不提供明文保留开关。
        </p>
        <p>
          调用栈、Worker / iframe 子目标和缓存等依赖 Chrome 可观测性。响应正文与
          WebSocket 帧不在此版采集范围。中断不会被当作全量成功。
        </p>
        <h3>Filter 示例</h3>
        <pre>
{"scope":{"field":"page_host","operator":"domain","values":["alibabacloud.com"]},"include":{"op":"or","rules":[{"field":"method","operator":"in","values":["POST","OPTIONS"]},{"field":"query","key":"tag","operator":"contains_any","values":["alpha","beta"]}]},"exclude":{"field":"extension","operator":"in","values":["png","css"]}}</pre>
        <p>
          支持嵌套
          and/or/not，equals、contains、contains_any、starts_with、ends_with、in、regex、wildcard、domain、exists
          / not_exists；否定值操作加 not_。多值填 values 数组。内容字段
          query/header/body 须填 key；body 使用 JSON 点路径。
        </p>
      </section>
    </main>
  </div>
</template>
