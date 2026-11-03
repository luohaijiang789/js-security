<script setup lang="ts">
import { ref, watch } from "vue";
import {
  RemoteCapture,
  type CaptureEvent,
  type RemoteSettings,
} from "./remote-capture";
import { listAssets, type AssetRow } from "./asset-index";
const props = defineProps<{
  scanId: string;
  issue?: string;
  enabled?: boolean;
  remote?: RemoteSettings;
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
let generation = 0;
async function refresh(reset = false) {
  const own = ++generation;
  if (reset) {
    after.value = 0;
    preview.value = "";
    rows.value = [];
    count.value = 0;
  }
  if (!props.scanId) return;
  try {
    assets.value = props.remote
      ? await listAssets(props.remote.project)
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
async function source(row: CaptureEvent, save = false) {
  const scan = props.scanId;
  try {
    const text = row.object_id
      ? await client.source(row.object_id)
      : undefined;
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
      JS、加载证据和请求内容不写浏览器本地盘；此处从远端查询已持久确认的数据。断网时只保留有界内存，失败会暂停。
    </p>
    <p v-if="enabled && !remote">此旧任务没有远端配置，请新建远端任务。</p>
    <p>
      Debugger 源码不是 HTTP 原始字节；加载栈不是 API 发送栈。Network
      与源码的精确关联仍为未知。
    </p>
    <p v-if="!scanId">请先创建或选择任务。</p>
    <template v-else>
      <h3>本地轻量索引（仅标记，不含正文）</h3>
      <p>
        以「项目 + URL」为标记记录已采集对象；已确认发送的 JS 正文不再重复读取和上传。
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
              <button @click="preview = JSON.stringify(row, null, 2)">
                详情</button
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
