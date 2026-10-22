<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { defaults, type Scan, type Filter } from "./model";
import { presets } from "./filter";
const scan = ref<Scan | null>(null),
  tabs = ref<chrome.tabs.Tab[]>([]),
  ids = ref<number[]>([]),
  name = ref("业务请求采集"),
  config = ref(defaults()),
  template = ref("全量"),
  templates = ref<Record<string, Filter>>({ ...presets }),
  error = ref(""),
  busy = ref(false);
const labels: Record<string, string> = {
  recording: "采集中",
  paused: "暂停",
  draining: "处理中",
  ended: "已结束",
  interrupted: "已中断",
};
async function rpc(type: string, data: object = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r.ok) throw Error(r.error);
  return r.result;
}
async function refresh() {
  scan.value = (await rpc("state")).scan;
}
async function run(type: string) {
  busy.value = true;
  error.value = "";
  try {
    if (type === "start") {
      const c = JSON.parse(
        JSON.stringify({
          ...config.value,
          filter: templates.value[template.value] ?? {},
        }),
      );
      await rpc("start", { name: name.value, tabs: ids.value, config: c });
    } else await rpc(type, { id: scan.value?.id });
    await refresh();
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}
function open(section = "请求") {
  void chrome.tabs.create({
    url:
      chrome.runtime.getURL("index.html") +
      "?section=" +
      encodeURIComponent(section),
  });
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  try {
    await refresh();
    tabs.value = (await chrome.tabs.query({})).filter((t) =>
      /^https?:/.test(t.url ?? ""),
    );
    const saved = await chrome.storage.local.get([
      "last_config",
      "filter_templates",
    ]);
    if (saved.last_config)
      config.value = saved.last_config as ReturnType<typeof defaults>;
    if (config.value.merge === "representative")
      config.value.merge = "normalized";
    if (saved.filter_templates)
      templates.value = saved.filter_templates as Record<string, Filter>;
    timer = setInterval(() => {
      if (!busy.value) void refresh();
    }, 1000);
  } catch (e) {
    error.value = String(e);
  }
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="popup">
    <header>
      <b>JS 请求采集</b><span>{{ scan ? labels[scan.state] : "未开始" }}</span>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="scan && scan.state !== 'ended'"
      ><h3>{{ scan.name }}</h3>
      <p v-for="tab in scan.tabs" :key="tab.id" class="url">
        标签页 {{ tab.id }} · {{ tab.url }}
      </p>
      <div class="metrics">
        <div>
          已观测<b>{{ scan.stats.observed }}</b>
        </div>
        <div>
          Pending<b>{{ scan.stats.pending }}</b>
        </div>
        <div>
          已持久化<b>{{ scan.stats.persisted }}</b>
        </div>
        <div>
          排除 / 未知<b>{{ scan.stats.excluded }} / {{ scan.stats.unknown }}</b>
        </div>
      </div>
      <p>
        Filter v{{ scan.versions.length }} · {{ scan.config.retention
        }}<br />归并 {{ scan.config.merge }} · 文件归档
        {{ scan.config.archive.enabled ? "开启" : "关闭" }} · 服务
        {{ scan.config.service.enabled ? "开启" : "关闭" }}
      </p>
      <button
        v-if="scan.state === 'recording'"
        :disabled="busy"
        @click="run('pause')"
      >
        暂停</button
      ><button
        v-if="['paused', 'interrupted'].includes(scan.state)"
        :disabled="busy"
        @click="run('resume')"
      >
        恢复</button
      ><button :disabled="busy" @click="run('stop')">
        停止并写盘
      </button></template
    ><template v-else
      ><label>任务名称<input v-model="name" /></label>
      <p>选择授权标签页</p>
      <label v-for="tab in tabs" :key="tab.id" class="tab"
        ><input v-model="ids" type="checkbox" :value="tab.id" /><span
          >{{ tab.title }}<small>{{ tab.url }}</small></span
        ></label
      ><label
        >Filter 模板<select v-model="template">
          <option v-for="(_, key) in templates" :key="key">{{ key }}</option>
        </select></label
      ><label
        >归并<select v-model="config.merge">
          <option value="none">不去重</option>
          <option value="exact">精确归并</option>
          <option value="normalized">智能归并（显式动态字段）</option>
        </select></label
      ><label
        ><input
          v-model="config.archive.enabled"
          type="checkbox"
        />自动文件归档</label
      ><button
        class="primary"
        :disabled="busy || !ids.length"
        @click="run('start')"
      >
        开始采集
      </button></template
    >
    <footer>
      <button @click="open()">查看 / 导出</button
      ><button @click="open('任务')">完整设置</button
      ><button @click="open('历史任务')">历史任务</button>
    </footer>
    <small
      >关闭 Popup 后采集继续；仅记录所选标签页。<br />Cookie、Token
      默认脱敏，采集缺口单独保留。</small
    >
  </div>
</template>
<style>
body {
  margin: 0;
  background: #f4f7fa;
  color: #22384d;
  font:
    13px/1.6 system-ui,
    sans-serif;
}
.popup {
  width: 420px;
  padding: 22px;
}
header {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid #d9e2ea;
  padding-bottom: 12px;
}
header b {
  font-size: 19px;
}
header span {
  color: #167b67;
}
input,
select,
button {
  font: inherit;
  border: 1px solid #cfdbe5;
  border-radius: 5px;
  padding: 7px;
  background: white;
}
label {
  display: block;
  margin: 10px 0;
}
label > input:not([type="checkbox"]),
select {
  display: block;
  width: 100%;
  box-sizing: border-box;
}
button {
  cursor: pointer;
  margin-right: 6px;
}
.tab {
  display: flex;
  gap: 8px;
  align-items: start;
}
.tab small {
  display: block;
  overflow-wrap: anywhere;
  color: #7a8b9c;
  font-size: 11px;
}
.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.metrics div {
  background: white;
  padding: 10px;
}
.metrics b {
  display: block;
  font-size: 23px;
}
.primary {
  color: white;
  background: #168574;
  border-color: #168574;
}
.error {
  background: #fde7e4;
  padding: 10px;
  color: #982f25;
}
.url {
  overflow-wrap: anywhere;
  font-size: 11px;
}
footer {
  display: flex;
  margin: 20px 0 12px;
}
small {
  color: #7a8b9c;
}
button:disabled {
  opacity: 0.45;
}
</style>
