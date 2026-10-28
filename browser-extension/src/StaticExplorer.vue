<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
import {
  parseStaticDocument,
  analyzerOrigin,
  sourceLabel,
  type StaticDocument,
  type StaticRecord,
} from "./static-analysis";
const props = defineProps<{ captureDisabled?: boolean }>();
const emit = defineEmits<{ capturing: [boolean] }>();
const pageUrl = ref(""),
  service = ref("http://127.0.0.1:8765"),
  token = ref(""),
  depth = ref(3),
  document = ref<StaticDocument | null>(null),
  search = ref(""),
  view = ref("静态候选"),
  error = ref(""),
  status = ref(""),
  busy = ref(false),
  detail = ref<StaticRecord | null>(null),
  jobId = ref("");
let controller: AbortController | undefined;
const names = computed(() => {
  const map = new Map<string, string[]>();
  for (const f of document.value?.parameters ?? []) {
    const text = f.carrier + "." + (f.path.join(".") || "未知结构");
    map.set(f.recordId, [...(map.get(f.recordId) ?? []), text]);
  }
  return map;
});
const matches = computed(() =>
  (document.value?.records ?? []).filter(
    (r) =>
      (view.value === "插件实测"
        ? r.sourceKind === "plugin-observed"
        : r.sourceKind !== "plugin-observed") &&
      [r.method, r.host, r.url, r.sourceFile, ...(names.value.get(r.id) ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const rows = computed(() => matches.value.slice(0, 100));
const raw = computed(
  () =>
    document.value?.evidence.find((e) => e.id === detail.value?.evidenceId)
      ?.raw,
);
async function upload(event: Event) {
  error.value = "";
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024)
      throw Error("导入文件超过16MiB，请使用分片或分析服务");
    document.value = parseStaticDocument(JSON.parse(await file.text()));
    detail.value = null;
    status.value = "已导入交付文件；当前页保留，不改写实测任务";
  } catch (e) {
    error.value = String(e);
  }
}
async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    signal: controller?.signal,
    headers: {
      "Content-Type": "application/json",
      "X-Analyzer-Token": token.value,
      ...options.headers,
    },
  });
  if (!response.ok)
    throw Error("分析服务返回 " + response.status + "，请检查服务范围和令牌");
  return response;
}
async function explore() {
  error.value = "";
  busy.value = true;
  controller = new AbortController();
  try {
    const base = analyzerOrigin(service.value),
      page = new URL(pageUrl.value);
    if (!["http:", "https:"].includes(page.protocol) || !token.value)
      throw Error("请填写网页地址和分析服务令牌");
    const origin = new URL(base);
    const granted = await chrome.permissions.request({
      origins: [origin.protocol + "//" + origin.hostname + "/*"],
    });
    if (!granted) throw Error("未获得分析服务访问权限");
    const job = await (
      await request(base + "/jobs", {
        method: "POST",
        body: JSON.stringify({ pageUrl: page.href, maxDepth: depth.value }),
      })
    ).json();
    jobId.value = job.id;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const state = await (await request(base + "/jobs/" + job.id)).json();
      status.value =
        state.state === "running" ? "正在收集和分析脚本…" : state.state;
      if (state.state === "failed") throw Error(state.error ?? "分析任务失败");
      if (state.state === "completed") {
        const response = await request(
          base + "/jobs/" + job.id + "/artifacts/analysis.json",
        );
        const text = await response.text();
        if (text.length > 16 * 1024 * 1024)
          throw Error("交付文件过大，请从本地任务目录查看");
        document.value = parseStaticDocument(JSON.parse(text));
        detail.value = null;
        status.value = "分析完成；请求仍为静态候选，请查看缺口";
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    throw Error("等待超时，任务仍可在分析服务目录查看");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function captureBrowser() {
  error.value = "";
  busy.value = true;
  emit("capturing", true);
  controller = new AbortController();
  try {
    if (props.captureDisabled) throw Error("请先停止实测采集");
    if (!token.value) throw Error("请填写分析服务令牌");
    const base = analyzerOrigin(service.value),
      url = new URL(base);
    if (
      !(await chrome.permissions.request({
        origins: [url.protocol + "//" + url.hostname + "/*"],
      }))
    )
      throw Error("未获得分析服务权限");
    status.value = "正在读取全部网页已经加载的JS…";
    const reply = await chrome.runtime.sendMessage({ type: "capture_scripts" });
    if (!reply.ok) throw Error(reply.error);
    const response = await request(base + "/packages", {
        method: "POST",
        body: JSON.stringify({ snapshot: reply.result }),
      }),
      job = await response.json();
    jobId.value = job.id;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const state = await (await request(base + "/jobs/" + job.id)).json();
      if (state.state === "failed") throw Error(state.error);
      if (state.state === "completed") {
        document.value = parseStaticDocument(
          await (
            await request(base + "/jobs/" + job.id + "/artifacts/analysis.json")
          ).json(),
        );
        status.value = "已分析浏览器脚本快照；父链/未加载代码等缺口保留";
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    throw Error("分析等待超时");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
    emit("capturing", false);
  }
}
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = window.document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson() {
  if (document.value)
    save(
      new Blob([JSON.stringify(document.value, null, 2)], {
        type: "application/json",
      }),
      "analysis.json",
    );
}
async function exportExcel() {
  try {
    const base = analyzerOrigin(service.value),
      response = await request(
        base + "/jobs/" + jobId.value + "/artifacts/api_assets.xlsx",
      );
    save(await response.blob(), "api_assets.xlsx");
  } catch (e) {
    error.value = String(e);
  }
}
onUnmounted(() => controller?.abort());
</script>
<template>
  <section class="panel js-explorer" aria-label="JS探索工作台">
    <h2>探索前端 JS</h2>
    <p>
      从网页及其引用脚本提取请求候选，也可导入仓库扫描结果。静态候选与浏览器实测分别查看。
    </p>
    <div class="explore-form">
      <label
        >网页地址<input
          v-model="pageUrl"
          placeholder="https://example.com/console" /></label
      ><label
        >获取深度<select v-model.number="depth">
          <option :value="1">1 层</option>
          <option :value="2">2 层</option>
          <option :value="3">3 层</option>
        </select></label
      ><label>本地分析服务<input v-model="service" /></label
      ><label
        >服务令牌<input
          v-model="token"
          type="password"
          autocomplete="off" /></label
      ><button class="button primary" :disabled="busy" @click="explore">
        {{ busy ? "分析中…" : "开始探索" }}
      </button>
    </div>
    <p class="subtle">
      需先启动受控分析服务并配置允许获取的站点/CDN；服务令牌仅留在当前页面。探索不会调用代码中发现的业务
      API。
    </p>
    <div class="inline">
      <button
        class="button"
        :disabled="busy || captureDisabled"
        @click="captureBrowser"
      >
        读取全部网页已加载 JS 并分析</button
      ><label class="button"
        >导入 analysis.json<input
          aria-label="导入JS分析结果"
          type="file"
          accept="application/json,.json"
          @change="upload" /></label
      ><button class="button" :disabled="!document" @click="exportJson">
        导出底稿</button
      ><button
        class="button"
        :disabled="!jobId || !document"
        @click="exportExcel"
      >
        下载 Excel
      </button>
    </div>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="error" role="alert" class="explorer-error">{{ error }}</p>
    <template v-if="document"
      ><p>
        {{ document.records.length }} 条记录 · {{ document.gaps.length }} 个缺口
        ·
        {{
          document.scope.complete
            ? "声明模型范围内完整"
            : "分析不完整，保留缺口"
        }}
      </p>
      <div class="inline">
        <select v-model="view" aria-label="JS证据视图">
          <option>静态候选</option>
          <option>插件实测</option></select
        ><input
          v-model="search"
          aria-label="搜索JS接口"
          placeholder="搜索Host、URL、字段或脚本"
        />
      </div>
      <div class="explorer-table">
        <table>
          <thead>
            <tr>
              <th>来源</th>
              <th>JS位置</th>
              <th>方法</th>
              <th>Host</th>
              <th>URL</th>
              <th>参数字段</th>
              <th>阶段</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.id"
              tabindex="0"
              @click="detail = r"
              @keydown.enter="detail = r"
            >
              <td>{{ sourceLabel(r.sourceKind) }}</td>
              <td>
                {{ r.generatedFile || r.sourceFile || "未定位" }}:{{
                  r.generatedLine || r.sourceLine || "?"
                }}:{{ r.generatedColumn || r.sourceColumn || "?" }}
              </td>
              <td>{{ r.method || "未知" }}</td>
              <td>{{ r.host || "未知" }}</td>
              <td>{{ r.resolvedUrl || r.url || "未知" }}</td>
              <td>{{ names.get(r.id)?.join("；") || "见载体状态" }}</td>
              <td>{{ r.stage }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="matches.length > 100">当前显示前100条；完整结果请导出查看。</p>
      <aside v-if="detail" class="explorer-detail" aria-label="JS请求证据">
        <button class="button" @click="detail = null">关闭证据</button>
        <h3>{{ detail.method }} {{ detail.url }}</h3>
        <h4>原始依据</h4>
        <pre>{{ JSON.stringify(raw, null, 2) }}</pre>
        <h4>关联缺口</h4>
        <ul>
          <li
            v-for="g in document.gaps.filter((g) => g.recordId === detail?.id)"
            :key="g.id"
          >
            {{ g.reason }}
          </li>
        </ul>
      </aside>
    </template>
    <p v-else>
      导入交付文件或开始探索后，这里显示 JS 位置、Host、URL、方法与参数字段。
    </p>
  </section>
</template>
<style scoped>
.js-explorer {
  padding: 24px;
}
.explore-form {
  display: grid;
  grid-template-columns: 2fr 0.6fr 1.5fr 1.2fr auto;
  gap: 12px;
  align-items: end;
  margin: 20px 0;
}
.explore-form label {
  display: grid;
  gap: 6px;
}
.explorer-error {
  color: #c53030;
}
.explorer-table {
  overflow: auto;
  margin-top: 16px;
}
.explorer-table table {
  min-width: 1000px;
}
.explorer-table td {
  max-width: 280px;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.explorer-detail {
  position: fixed;
  right: 20px;
  top: 90px;
  bottom: 20px;
  width: min(650px, 90vw);
  overflow: auto;
  background: white;
  box-shadow: 0 6px 40px #0003;
  z-index: 40;
  padding: 24px;
  border-radius: 12px;
}
.explorer-detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 1100px) {
  .explore-form {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
