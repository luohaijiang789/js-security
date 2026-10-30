<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Task, Snapshot, Asset } from "./model";
import { request, download } from "./client";
import { getSnapshot, assets as readAssets } from "./store";
const extensionId = chrome.runtime.id;
const tasks = ref<Task[]>([]),
  selected = ref(""),
  activeId = ref<string | null>(null),
  busy = ref(false),
  error = ref(""),
  snapshot = ref<Snapshot>(),
  base = ref("http://127.0.0.1:8378"),
  token = ref(""),
  job = ref<any>(),
  report = ref<any>(),
  detail = ref<any>(),
  query = ref(""),
  capturedAssets = ref<Asset[]>([]),
  assetDetail = ref<Asset>();
const current = computed(() =>
  tasks.value.find((t) => t.id === selected.value),
);
const active = computed(() =>
  tasks.value.some((t) =>
    ["collecting", "pausing", "stopping"].includes(t.phase),
  ),
);
const controlsCurrent = computed(() => selected.value === activeId.value);
const phaseLabel = (value: string) =>
  (
    ({
      collecting: "采集中",
      pausing: "正在暂停",
      paused: "已暂停",
      stopping: "正在停止",
      stopped: "已停止",
      interrupted: "已中断",
      queued: "排队中",
      running: "分析中",
      completed: "分析完成",
      partial: "部分结果",
      failed: "分析失败",
      cancelled: "已取消",
    }) as Record<string, string>
  )[value] ?? value;
const rows = computed(() =>
  (report.value?.candidates ?? []).filter((c: any) =>
    JSON.stringify([c.url, c.host, c.method])
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
let timer: ReturnType<typeof setInterval>;
let checking = false;
let viewEpoch = 0;
async function message(type: string, id?: string) {
  const result = await chrome.runtime.sendMessage({ type, id });
  if (!result?.ok) throw Error(result?.error ?? "后台未响应");
  return result;
}
async function state() {
  const value = await message("state");
  activeId.value = value.active_id;
  tasks.value = value.tasks.sort((a: Task, b: Task) =>
    b.started_at.localeCompare(a.started_at),
  );
  if (!selected.value) selected.value = tasks.value[0]?.id ?? "";
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    await state().catch(() => {});
  }
}
async function capture(type: string) {
  await action(async () => {
    const value = await message(type, selected.value);
    if (value.id) {
      viewEpoch++;
      capturedAssets.value = [];
      assetDetail.value = undefined;
      selected.value = value.id;
      snapshot.value = undefined;
      report.value = undefined;
      job.value = undefined;
    }
    if (type === "resume") {
      viewEpoch++;
      snapshot.value = undefined;
      report.value = undefined;
      job.value = undefined;
      detail.value = undefined;
    }
  });
}
async function showAssets() {
  await action(async () => {
    const id = selected.value,
      epoch = viewEpoch;
    const value = await readAssets(id);
    if (id === selected.value && epoch === viewEpoch)
      capturedAssets.value = value;
  });
}
async function freeze() {
  await action(async () => {
    const value = await message("freeze", selected.value);
    viewEpoch++;
    report.value = undefined;
    job.value = undefined;
    detail.value = undefined;
    snapshot.value = value.snapshot;
    await chrome.storage.local.set({
      lastSnapshot: snapshot.value!.snapshot_id,
    });
  });
}
async function analyze() {
  await action(async () => {
    if (!snapshot.value) throw Error("先暂停或停止采集，并生成快照");
    viewEpoch++;
    job.value = undefined;
    report.value = undefined;
    detail.value = undefined;
    const cap = await request(base.value, token.value, "/v0/capabilities");
    if (
      cap.protocol !== "capture-0.1" ||
      cap.result_schema !== "0.5" ||
      cap.offline_only !== true
    )
      throw Error("服务版本不兼容");
    job.value = await request(
      base.value,
      token.value,
      "/v0/jobs",
      snapshot.value,
    );
    await chrome.storage.local.set({
      lastJob: job.value.id,
      lastJobSnapshot: snapshot.value.snapshot_id,
      serviceURL: base.value,
    });
    report.value = undefined;
    detail.value = undefined;
  });
}
async function refreshJob() {
  if (checking || !job.value || !token.value) return;
  checking = true;
  const epoch = viewEpoch,
    id = job.value.id,
    endpoint = base.value,
    pair = token.value;
  try {
    const value = await request(endpoint, pair, `/v0/jobs/${id}`);
    if (epoch !== viewEpoch || job.value?.id !== id) return;
    job.value = value;
    if (["completed", "partial"].includes(value.status) && !report.value) {
      const result = await request(endpoint, pair, `/v0/jobs/${id}/result`);
      if (epoch === viewEpoch && job.value?.id === id) report.value = result;
    }
  } catch (e) {
    if (epoch === viewEpoch)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    checking = false;
  }
}
onMounted(async () => {
  await state().catch((e) => (error.value = String(e)));
  const saved = await chrome.storage.local.get([
    "lastSnapshot",
    "lastJob",
    "lastJobSnapshot",
    "serviceURL",
  ]);
  if (saved.serviceURL) base.value = saved.serviceURL;
  if (saved.lastSnapshot)
    snapshot.value = await getSnapshot(saved.lastSnapshot);
  if (snapshot.value) selected.value = snapshot.value.task_id;
  if (saved.lastJob && saved.lastJobSnapshot === snapshot.value?.snapshot_id)
    job.value = { id: saved.lastJob, status: "待连接查询" };
  timer = setInterval(() => {
    void state().catch(() => {});
    void refreshJob();
  }, 1200);
});
onUnmounted(() => clearInterval(timer));
function pick() {
  viewEpoch++;
  capturedAssets.value = [];
  assetDetail.value = undefined;
  snapshot.value = undefined;
  report.value = undefined;
  job.value = undefined;
  detail.value = undefined;
}
</script>
<template>
  <main>
    <header>
      <div>
        <p class="eyebrow">网站 JS · 静态分析</p>
        <h1>收集脚本，查看 API 线索</h1>
        <p>
          只分析取得的代码。结果为文件级候选，不代表接口已发送或全站已覆盖。
        </p>
      </div>
      <button :disabled="busy || active" @click="capture('start')">
        新建采集任务
      </button>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <section>
      <div class="row">
        <h2>脚本采集</h2>
        <select v-model="selected" @change="pick">
          <option v-for="t in tasks" :key="t.id" :value="t.id">
            {{ new Date(t.started_at).toLocaleString() }} ·
            {{ phaseLabel(t.phase) }}
          </option>
        </select>
      </div>
      <template v-if="current"
        ><div class="stats">
          <strong>{{ current.assets }} <small>个脚本观察</small></strong
          ><strong
            >{{ (current.bytes / 1024 / 1024).toFixed(2) }}
            <small>MiB 完整正文</small></strong
          ><strong>{{ phaseLabel(current.phase) }}</strong>
        </div>
        <div class="row">
          <button
            :disabled="
              busy || !controlsCurrent || current.phase !== 'collecting'
            "
            @click="capture('pause')"
          >
            暂停</button
          ><button
            :disabled="busy || !controlsCurrent || current.phase !== 'paused'"
            @click="capture('resume')"
          >
            恢复</button
          ><button
            :disabled="
              busy ||
              !controlsCurrent ||
              !['collecting', 'paused'].includes(current.phase)
            "
            @click="capture('stop')"
          >
            停止</button
          ><button
            :disabled="
              busy ||
              !['paused', 'stopped', 'interrupted'].includes(current.phase)
            "
            @click="freeze"
          >
            生成固定快照</button
          ><button
            :disabled="!snapshot"
            @click="download('js-snapshot.json', snapshot)"
          >
            导出快照
          </button>
        </div>
        <div class="row">
          <button :disabled="busy" @click="showAssets">查看 / 刷新脚本</button
          ><span class="muted"
            >下表是已保存的源码观察；继续采集后可刷新，分析使用固定快照。</span
          >
        </div>
        <div v-if="capturedAssets.length" class="results">
          <table>
            <thead>
              <tr>
                <th>脚本来源</th>
                <th>SHA256</th>
                <th>正文大小</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="a in capturedAssets"
                :key="a.id"
                tabindex="0"
                @click="assetDetail = a"
                @keydown.enter="assetDetail = a"
              >
                <td>{{ a.url ?? a.capture_url ?? a.location }}</td>
                <td :title="a.sha256">{{ a.sha256.slice(0, 16) }}…</td>
                <td>{{ (a.bytes / 1024).toFixed(1) }} KiB</td>
              </tr>
            </tbody>
          </table>
          <aside v-if="assetDetail">
            <button @click="assetDetail = undefined">关闭源码</button>
            <h3>{{ assetDetail.url ?? assetDetail.location }}</h3>
            <p>
              请求基址：{{ assetDetail.context.request_base_url ?? "未知" }}
            </p>
            <pre>{{ assetDetail.content }}</pre>
          </aside>
        </div>
        <details>
          <summary>
            采集缺口 {{ current.gaps.length }} 项<span
              v-if="current.omitted_gaps"
              >，另有 {{ current.omitted_gaps }} 项</span
            >
          </summary>
          <ul>
            <li v-for="(g, i) in current.gaps" :key="i">
              {{ g.message }} <span class="muted">{{ g.source }}</span>
            </li>
          </ul>
        </details></template
      >
      <p v-else>
        新建任务后会自动接入所有 HTTP/HTTPS
        网页。正常登录和操作页面，后台持续读取已解析脚本；关闭此页面不会停止采集。
      </p>
    </section>
    <section>
      <h2>本机分析</h2>
      <p>
        先暂停或停止并生成快照。服务不可用时仍可收集和导出；配对密钥仅保留在当前页面。
      </p>
      <div class="row">
        <label
          >服务地址<input
            v-model="base"
            placeholder="http://127.0.0.1:8378" /></label
        ><label
          >配对密钥<input
            v-model="token"
            type="password"
            autocomplete="off" /></label
        ><button :disabled="busy || !snapshot || !token" @click="analyze">
          分析此快照
        </button>
      </div>
      <p class="muted">扩展 ID：{{ extensionId }} · 服务启动时使用此 ID 配对</p>
      <p v-if="snapshot">
        固定快照：{{ snapshot.snapshot_id }} ·
        {{ snapshot.assets.length }} 个脚本
      </p>
      <div v-if="job" class="row">
        <span>分析状态：{{ phaseLabel(job.status) }}</span
        ><button :disabled="!token" @click="action(refreshJob)">查询结果</button
        ><button
          v-if="['queued', 'running'].includes(job.status)"
          @click="
            action(async () => {
              await request(base, token, `/v0/jobs/${job.id}/cancel`, {});
              await refreshJob();
            })
          "
        >
          取消分析</button
        ><span v-if="job.error" class="error">{{ job.error }}</span>
      </div>
    </section>
    <section v-if="report">
      <div class="row">
        <h2>API 候选 {{ report.candidates.length }} 条</h2>
        <input v-model="query" placeholder="搜索地址、Host 或方法" /><button
          @click="download('analysis.json', report)"
        >
          导出分析 JSON
        </button>
      </div>
      <p>
        影响完整性的缺口
        {{ report.gaps.filter((g: any) => g.incomplete).length }}
        项；精确调用数、确认接口数尚未计算。
      </p>
      <div class="results">
        <table>
          <thead>
            <tr>
              <th>方法</th>
              <th>URL</th>
              <th>Host</th>
              <th>对应 JS</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in rows"
              :key="c.id"
              tabindex="0"
              @click="detail = c"
              @keydown.enter="detail = c"
            >
              <td>{{ c.method ?? "未知" }}</td>
              <td>{{ c.url }}</td>
              <td>{{ c.host ?? "未知" }}</td>
              <td>
                {{
                  report.assets.find((a: any) => a.id === c.asset_id)?.url ??
                  report.assets.find((a: any) => a.id === c.asset_id)
                    ?.location ??
                  "未知"
                }}
              </td>
            </tr>
          </tbody>
        </table>
        <aside v-if="detail">
          <button @click="detail = undefined">关闭详情</button>
          <h3>{{ detail.url }}</h3>
          <p>文件级候选 · 精确发送位置未知</p>
          <h4>请求参数</h4>
          <pre>{{ JSON.stringify(detail.parameters, null, 2) }}</pre>
          <h4>原始候选</h4>
          <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
        </aside>
      </div>
      <details>
        <summary>分析缺口 {{ report.gaps.length }} 项</summary>
        <ul>
          <li v-for="g in report.gaps" :key="g.id">{{ g.message }}</li>
        </ul>
      </details>
    </section>
  </main>
</template>
