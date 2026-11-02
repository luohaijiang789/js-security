<script setup lang="ts">
import { ref, watch } from "vue";
import { jsPage, jsSource, type JSEvent } from "./js-store";
const props = defineProps<{
  scanId: string;
  issue?: string;
  enabled?: boolean;
}>();
const rows = ref<JSEvent[]>([]),
  count = ref(0),
  after = ref(""),
  next = ref("");
const error = ref(""),
  preview = ref("");
let generation = 0;
async function refresh(reset = false) {
  const own = ++generation;
  if (reset) {
    after.value = "";
    preview.value = "";
    rows.value = [];
    count.value = 0;
  }
  if (!props.scanId) return;
  try {
    const page = await jsPage(props.scanId, after.value);
    if (own !== generation) return;
    rows.value = page.events;
    count.value = page.count;
    next.value = page.next;
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
async function source(row: JSEvent, save = false) {
  const scan = props.scanId;
  try {
    const text = row.hash ? await jsSource(row.hash) : undefined;
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
      创建任务时开启。与请求采集共用会话，独立保存 JS 正文和加载证据，不受请求
      Filter 筛除。
    </p>
    <p>
      远端尚未接通，数据保存在本地待传缓存。单文件 16 MiB，总正文 256
      MiB，元数据 32 MiB；超限暂停 JS 并在任务缺口中说明。
    </p>
    <p>
      Debugger 源码不是 HTTP 原始字节；加载栈不是 API 发送栈。Network
      与源码的精确关联仍为未知。
    </p>
    <p v-if="!scanId">请先创建或选择任务。</p>
    <template v-else>
      <p>已保存 {{ count }} 条证据（包含上下文和加载事件，不代表接口数量）</p>
      <button @click="refresh()">刷新</button>
      <button @click="refresh(true)">首页</button>
      <button
        :disabled="rows.length < 50"
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
              {{ row.data.url || row.data.document_url || "上下文事件"
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
      <p v-if="preview">预览最多显示 200000 字符；下载保留全文。</p>
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
