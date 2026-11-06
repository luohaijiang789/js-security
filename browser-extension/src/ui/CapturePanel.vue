<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { RemoteCapture } from "../transport/client";
import {
  type CaptureEvent,
  type RemoteSettings,
  type DeliveryStatus,
} from "../domain/evidence";
import { listAssets, assetScope, type AssetRow } from "../storage/assets";
const props = defineProps<{
  scanId: string;
  issue?: string;
  enabled?: boolean;
  remote?: RemoteSettings;
  delivery?: DeliveryStatus;
  journal?: import("../domain/evidence").JournalStatus;
}>();
const rows = ref<CaptureEvent[]>([]),
  assets = ref<AssetRow[]>([]),
  count = ref(0),
  after = ref(0),
  next = ref(0),
  hasMore = ref(false);
const error = ref(""),
  preview = ref("");
const client = new RemoteCapture(() => props.remote);
const jobs = ref<
  Array<{
    id: string;
    status: string;
    watermark: number;
    phase?: string;
    error?: string;
  }>
>([]);
const phaseNames: Record<string, string> = {
  collecting: "递归收集",
  frozen: "资产已冻结",
  analyzing: "统一分析",
};
const analysis = ref<any>(null),
  analysisError = ref("");
let resultIdentity = "",
  polling: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  polling = setInterval(() => {
    void refresh();
  }, 3000);
});
onUnmounted(() => {
  clearInterval(polling);
  generation++;
});
async function refreshAnalysis() {
  if (!props.remote || !props.scanId) return;
  const scan = props.scanId;
  try {
    const page = await (
      await client.request(`/analyses?scan_id=${encodeURIComponent(scan)}`)
    ).json();
    if (scan !== props.scanId) return;
    jobs.value = page.jobs ?? [];
    const latest = jobs.value.find((job) => job.status !== "running");
    if (latest && latest.id !== resultIdentity) {
      const result = await (
        await client.request(`/analyses/${latest.id}/result`)
      ).json();
      if (scan !== props.scanId) return;
      analysis.value = result.result;
      resultIdentity = latest.id;
    }
    analysisError.value = "";
  } catch (e) {
    if (scan === props.scanId) analysisError.value = String(e);
  }
}
async function analyzeNow() {
  try {
    await client.request("/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan_id: props.scanId }),
    });
    await refreshAnalysis();
  } catch (e) {
    analysisError.value = String(e);
  }
}
let generation = 0;
async function refresh(reset = false) {
  const own = ++generation;
  if (reset) {
    after.value = 0;
    preview.value = "";
    rows.value = [];
    count.value = 0;
    jobs.value = [];
    analysis.value = null;
    resultIdentity = "";
  }
  if (!props.scanId) return;
  try {
    assets.value = props.remote
      ? await listAssets(assetScope(props.remote))
      : [];
    if (own !== generation) return;
    error.value = "";
    if (!props.remote) {
      rows.value = [];
      count.value = 0;
      return;
    }
    const page = await client.page(props.scanId, after.value, true);
    if (own !== generation) return;
    rows.value = page.events;
    count.value = page.count;
    next.value = page.next;
    hasMore.value = !!page.has_more;
    void refreshAnalysis();
  } catch (e) {
    if (own === generation) error.value = String(e);
  }
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function details(row: CaptureEvent, save = false) {
  if (row.category !== "raw_cdp") {
    preview.value = JSON.stringify(row, null, 2);
    return;
  }
  const scan = props.scanId;
  try {
    const detail = await client.eventInfo(scan, row.id);
    if (scan !== props.scanId) return;
    const text = detail.event?.data.capture_json;
    if (typeof text !== "string")
      throw Error("后端未返回原始通知，请检查后端版本");
    if (save)
      download(text, `${row.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.raw.json`);
    else
      preview.value =
        text.slice(0, 200000) +
        (text.length > 200000
          ? "\n\n[仅预览前200000字符，完整内容请下载原始通知]"
          : "");
  } catch (e) {
    if (scan === props.scanId) error.value = String(e);
  }
}
async function source(row: CaptureEvent, save = false) {
  const scan = props.scanId;
  try {
    const text = row.object_id ? await client.source(row.object_id) : undefined;
    if (scan !== props.scanId) return;
    if (save && text !== undefined) download(text, `${row.object_id}.js`);
    else
      preview.value =
        text === undefined ? "没有可用源码" : text.slice(0, 200000);
  } catch (e) {
    error.value = String(e);
  }
}
watch(
  () => props.scanId,
  () => refresh(true),
  { immediate: true },
);
</script>
<template>
  <section aria-label="持续JS采集证据" class="panel" style="padding: 24px">
    <h2>持续 JS 采集</h2>
    <p v-if="scanId">
      任务配置：{{ enabled ? "已开启JS采集" : "未开启JS采集" }}
    </p>
    <p v-if="issue" role="alert">{{ issue }}</p>
    <p>
      创建任务时开启。与请求采集共用会话，直接上传 JS 正文和加载证据，不受请求
      Filter 筛除。
    </p>
    <p>
      未确认的JS、加载证据和请求临时持久化，远端持久确认后原子清理；浏览器重启后可恢复补传。此处从远端查询已确认数据。
    </p>
    <div v-if="delivery" aria-label="传输核对账目">
      <p>
        已接纳 {{ delivery.admitted }} · 持久确认 {{ delivery.acknowledged }} ·
        待补传 {{ delivery.pending }} · 未接纳 {{ delivery.rejected }}
      </p>
      <p v-if="delivery.contiguous_sequence !== undefined">
        连续到齐序号 {{ delivery.contiguous_sequence }} /
        {{ delivery.admitted }}；后到事件可以先确认，分析只读取连续到齐的前缀。
      </p>
      <p>
        {{
          delivery.sealed
            ? "后端已核对并封账"
            : "尚未封账，不能视为全部传输完成"
        }}；待传 {{ delivery.pending_bytes }} 字节。
      </p>
    </div>
    <p v-if="journal">
      原始日志：已持久 {{ journal.admitted }} · 已移交待传
      {{ journal.handed_off }} · 待移交
      {{ journal.pending }}。移交不代表后端已确认。
    </p>
    <p v-if="enabled && !remote">此旧任务没有远端配置，请新建远端任务。</p>
    <p>
      Debugger 源码不是 HTTP 原始字节；加载栈不是 API 发送栈。Network
      与源码的精确关联仍为未知。
    </p>
    <p v-if="!scanId">请先创建或选择任务。</p>
    <template v-else>
      <section aria-label="后端分析结果">
        <h3>后端分析结果</h3>
        <button :disabled="!remote" @click="analyzeNow">立即分析</button>
        <button
          :disabled="!analysis"
          @click="download(JSON.stringify(analysis, null, 2), 'analysis.json')"
        >
          导出分析JSON
        </button>
        <p v-if="jobs[0]">
          最新作业：{{ jobs[0].status }} ·
          {{ phaseNames[jobs[0].phase ?? ""] ?? jobs[0].phase ?? "排队" }} ·
          输入水位 {{ jobs[0].watermark }} ·
          {{ jobs[0].error || "" }}
        </p>
        <p v-else>等待后端生成固定批次；接收成功不等于分析完成。</p>
        <p v-if="analysisError" role="alert">
          分析查询失败：{{ analysisError }}
        </p>
        <p v-if="analysis">
          静态候选 {{ analysis.statistics?.static_candidates ?? 0 }} · 实测请求
          {{ analysis.observed_requests?.length ?? 0 }} · 缺口
          {{ analysis.gaps?.length ?? 0 }}
        </p>
        <p v-if="analysis?.collection_summary">
          资源收集：{{ analysis.collection_summary.status }} · 最大深度
          {{ analysis.collection_summary.max_depth }} · 未解决引用
          {{
            analysis.collection_summary.unresolved_reference_ids?.length ?? 0
          }}
        </p>
        <p v-if="analysis?.raw_capture?.events">
          原始日志 {{ analysis.raw_capture.events }} · 恢复请求
          {{ analysis.raw_capture.recovered_requests }} · 已关联整理记录
          {{ analysis.raw_capture.linked_requests }}；未取得正文仍显示缺口。
        </p>
        <p v-if="analysis?.api_inventory?.length > 200">
          显示前200组，完整结果请导出JSON。
        </p>
        <table
          v-if="analysis?.api_inventory?.length"
          style="width: 100%; table-layout: fixed"
        >
          <thead>
            <tr>
              <th>Host / 方法</th>
              <th>路径</th>
              <th>来源 / 实测次数</th>
              <th>证据与参数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in analysis.api_inventory.slice(0, 200)"
              :key="item.id"
            >
              <td style="overflow-wrap: anywhere">
                {{ item.host }}<br />{{ item.method }}
              </td>
              <td style="overflow-wrap: anywhere">{{ item.path_template }}</td>
              <td>{{ item.status }} · {{ item.observed_request_count }}</td>
              <td>
                <button @click="preview = JSON.stringify(item, null, 2)">
                  查看参数与JS证据
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="analysis?.gaps?.length"
          @click="preview = JSON.stringify(analysis.gaps, null, 2)"
        >
          查看分析缺口
        </button>
      </section>
      <h3>本地轻量索引（仅标记，不含正文）</h3>
      <p>
        仅用于分类展示，不作为跳过正文的依据；同URL的新脚本仍读取上传，由后端按实际内容去重。
        仅保留约 20000 条元数据，超出后按最近使用批量淘汰，不含正文。
      </p>
      <table style="width: 100%; table-layout: fixed">
        <thead>
          <tr>
            <th>类型</th>
            <th>URL</th>
            <th>Host</th>
            <th>次数</th>
            <th>正文</th>
            <th>已发送</th>
            <th>最近</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="asset in assets" :key="asset.key">
            <td>{{ asset.kind }}</td>
            <td style="overflow-wrap: anywhere">{{ asset.url }}</td>
            <td style="overflow-wrap: anywhere">{{ asset.host || "未知" }}</td>
            <td>{{ asset.count }}</td>
            <td>{{ asset.bytes === undefined ? "无" : asset.bytes + " B" }}</td>
            <td>{{ asset.sent ? "是" : "否" }}</td>
            <td>{{ asset.last_seen }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!assets.length">当前项目还没有本地索引记录。</p>
      <p>
        远端已确认 {{ count }} 条证据（包含上下文和加载事件，不代表接口数量）
      </p>
      <button @click="refresh()">刷新</button>
      <button @click="refresh(true)">首页</button>
      <button
        :disabled="!hasMore"
        @click="
          after = next;
          refresh();
        "
      >
        下一页
      </button>
      <button
        :disabled="!rows.length"
        @click="
          download(
            rows.map((r) => JSON.stringify(r)).join('\n'),
            'js-evidence-page.jsonl',
          )
        "
      >
        导出本页证据
      </button>
      <p v-if="error" role="alert">{{ error }}</p>
      <table style="width: 100%; table-layout: fixed">
        <thead>
          <tr>
            <th>类型 / 状态</th>
            <th>来源 / 正文标识</th>
            <th>查看</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td style="overflow-wrap: anywhere">
              {{ row.kind }}<br />{{ row.status }}
            </td>
            <td style="overflow-wrap: anywhere">
              {{
                row.data.url ||
                row.data.document_url ||
                row.data.record?.request_url ||
                "上下文事件"
              }}<br />{{ row.object_id || "无正文" }}
            </td>
            <td>
              <button @click="details(row)">详情</button
              ><button
                v-if="row.category === 'raw_cdp'"
                @click="details(row, true)"
              >
                下载原始通知</button
              ><button v-if="row.object_id" @click="source(row)">
                源码预览</button
              ><button v-if="row.object_id" @click="source(row, true)">
                下载源码
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="preview">预览最多显示 200000 字符；远端下载保留全文。</p>
      <pre
        style="
          max-height: 450px;
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        "
        >{{ preview }}</pre>
    </template>
  </section>
</template>
