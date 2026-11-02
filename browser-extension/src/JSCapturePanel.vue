<script setup lang="ts">
import { ref, watch } from "vue";
import {
  RemoteCapture,
  tokenKey,
  type CaptureEvent,
  type RemoteSettings,
} from "./remote-capture";
const props = defineProps<{
  scanId: string;
  issue?: string;
  enabled?: boolean;
  remote?: RemoteSettings;
}>();
const rows = ref<CaptureEvent[]>([]),
  count = ref(0),
  after = ref(0),
  next = ref(0),
  hasMore = ref(false);
const error = ref(""),
  preview = ref("");
const client = new RemoteCapture(() => props.remote);
const sessionToken = ref("");
async function saveToken() {
  if (!props.remote) return;
  await chrome.storage.session.set({
    [tokenKey(props.remote)]: sessionToken.value,
  });
  sessionToken.value = "";
  await refresh(true);
}
let generation = 0;
async function refresh(reset = false) {
  const own = ++generation;
  if (reset) {
    after.value = 0;
    preview.value = "";
    rows.value = [];
    count.value = 0;
  }
  if (!props.scanId || !props.remote) return;
  try {
    const page = await client.page(props.scanId, after.value, true);
    if (own !== generation) return;
    rows.value = page.events;
    count.value = page.count;
    next.value = page.next;
    hasMore.value = !!page.has_more;
    error.value = "";
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
    const text = row.hash ? await client.source(row.hash) : undefined;
    if (scan !== props.scanId) return;
    if (save && text !== undefined) download(text, `${row.hash}.js`);
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
    <template v-if="remote"
      ><label
        >更新远端会话令牌<input
          v-model="sessionToken"
          type="password"
          autocomplete="off" /></label
      ><button @click="saveToken">保存会话令牌并刷新</button></template
    >
    <p>
      Debugger 源码不是 HTTP 原始字节；加载栈不是 API 发送栈。Network
      与源码的精确关联仍为未知。
    </p>
    <p v-if="!scanId">请先创建或选择任务。</p>
    <template v-else>
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
            <th>来源 / 内容哈希</th>
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
              }}<br />{{ row.hash || "无正文" }}
            </td>
            <td>
              <button @click="preview = JSON.stringify(row, null, 2)">
                详情</button
              ><button v-if="row.hash" @click="source(row)">源码预览</button
              ><button v-if="row.hash" @click="source(row, true)">
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
