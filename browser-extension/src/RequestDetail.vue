<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { RecordEntry, Group, InitiatorGraph } from "./model";
import Icon from "./Icon.vue";
import {
  qualityLabels,
  bytesText,
  timeText,
  statusText,
  statusTone,
  stackSegments,
  pretty,
  recordForDisplay,
  frameLocation,
  shortFrameLocation,
  initiatorChainForDisplay,
  bodyContentAvailable,
} from "./presentation";
const props = defineProps<{
  record: RecordEntry | null;
  initiatorGraph?: InitiatorGraph | null;
  group?: Group | null;
  loading?: boolean;
  error?: string;
  busy?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  copy: [text: string];
  download: [record: RecordEntry];
  members: [group: Group];
  inspect: [requestId: string];
}>();
const record = computed(() =>
  props.record ? recordForDisplay(props.record) : null,
);
const tab = ref("概览");
const requestBodyAvailable = computed(() =>
  bodyContentAvailable(props.record?.request_body),
);
const responseBodyAvailable = computed(() =>
  bodyContentAvailable(props.record?.response_body),
);
const stack = computed(() => stackSegments(props.record?.initiator_stack));
const initiatorChain = computed(() =>
  props.record
    ? initiatorChainForDisplay(props.record, props.initiatorGraph)
    : null,
);
const stackNotice = computed(() => {
  const quality = record.value?.capture_status.stack;
  return quality?.state !== "complete" ? quality?.reason : "";
});
function capturedBodyText(body: RecordEntry["request_body"] | undefined) {
  return body?.parsed !== null && body?.parsed !== undefined
    ? pretty(body.parsed)
    : typeof body?.raw === "string"
      ? body.raw
      : "null";
}
const requestBodyText = computed(() => {
  const body = record.value?.request_body;
  return capturedBodyText(body);
});
const requestBodyBytes = computed(() =>
  bytesText(new TextEncoder().encode(requestBodyText.value).length),
);
const responseBodyText = computed(() =>
  capturedBodyText(record.value?.response_body),
);
const responseBodyBytes = computed(() =>
  bytesText(new TextEncoder().encode(responseBodyText.value).length),
);
const carrierLabels: Record<string, string> = {
  headers: "请求头",
  body: "请求体",
  response_headers: "响应头",
  response_body: "响应体",
  response_metadata: "响应元数据",
  stack: "调用栈",
  page: "页面归属",
};
const verdictLabels: Record<string, string> = {
  matched: "命中",
  excluded: "已排除（全量留存）",
  unknown: "无法判定，已保留",
};
const filterVerdict = computed(() =>
  record.value?.request_state === "pending"
    ? "等待终态判断"
    : verdictLabels[record.value?.filter_result ?? "unknown"],
);

watch([() => props.record?.request_id, () => props.group?.id], () => {
  tab.value = "概览";
});
const protectionText = computed(() =>
  !props.record?.protection
    ? "保护策略未知"
    : record.value?.protection.redacted
      ? "历史记录已脱敏"
      : record.value?.protection.truncated
        ? "超长内容已截断"
        : "原始值已保留",
);
const refererText = computed(() =>
  record.value?.referer !== null
    ? record.value?.referer || "（空字符串）"
    : record.value?.capture_status.headers.state === "complete"
      ? "可观测请求头中没有 Referer"
      : "未取得，见请求头采集状态",
);
function key(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", key));
onUnmounted(() => window.removeEventListener("keydown", key));
</script>
<template>
  <aside
    class="detail-panel"
    aria-label="请求详情"
    data-testid="request-detail"
  >
    <div class="detail-heading">
      <span class="eyebrow">{{
        group ? "REQUEST GROUP" : "REQUEST INSPECTOR"
      }}</span
      ><button
        class="icon-button"
        aria-label="关闭请求详情"
        @click="emit('close')"
      >
        <Icon name="close" />
      </button>
    </div>
    <div v-if="loading" class="detail-loading">
      <span class="spinner"></span>正在读取请求详情…
    </div>
    <div v-else-if="error && !record" class="empty-state compact">
      <Icon name="alert" :size="30" />
      <h3>详情读取失败</h3>
      <p>{{ error }}</p>
    </div>
    <template v-else-if="record">
      <div v-if="error" class="message-banner warning" role="alert">
        <Icon name="alert" :size="15" /><span>{{ error }}</span>
      </div>
      <div class="detail-summary">
        <div class="inline">
          <span class="method-badge" :class="record.method.toLowerCase()">{{
            record.method
          }}</span
          ><span class="status-code" :class="statusTone(record)"
            ><span class="tiny-dot"></span>{{ statusText(record) }}</span
          ><span class="muted">{{ record.resource_type }}</span>
        </div>
        <h2>{{ group ? "请求组详情" : "请求详情" }}</h2>
        <p class="detail-url">
          {{ group?.normalized_url ?? record.request_url }}
        </p>
        <div class="detail-actions">
          <button
            class="button small"
            @click="emit('copy', record.request_url)"
          >
            <Icon name="copy" :size="14" />复制 URL</button
          ><button
            class="button small"
            :disabled="busy"
            :title="
              busy ? '当前操作处理中，请稍后再导出' : '导出全部已保存的请求字段'
            "
            @click="props.record && emit('download', props.record)"
          >
            <Icon name="download" :size="14" />导出此请求
          </button>
        </div>
      </div>
      <div v-if="group" class="group-banner">
        <div>
          <strong>{{ group.count }} 次观察</strong
          ><span>{{
            group.candidate
              ? "候选分组，保护后的值不能证明原请求相同"
              : "按配置归并，原始观察分别保留"
          }}</span>
        </div>
        <button class="text-button" @click="emit('members', group)">
          查看全部成员 <Icon name="arrow" :size="14" />
        </button>
      </div>
      <div class="detail-tabs" role="tablist" aria-label="请求详情分类">
        <button
          v-for="t in [
            '概览',
            '参数',
            '请求头',
            '请求体',
            '响应头',
            '响应体',
            '调用栈',
            '原始数据',
          ]"
          :key="t"
          :class="{ active: tab === t }"
          role="tab"
          :aria-selected="tab === t"
          @click="tab = t"
        >
          {{ t
          }}<span v-if="t === '参数'">{{ record.query_params.length }}</span
          ><span v-if="t === '请求头'">{{ record.request_headers.length }}</span
          ><span v-if="t === '响应头'">{{
            record.response_headers.length
          }}</span>
        </button>
      </div>
      <div class="detail-content" role="tabpanel" :aria-label="tab">
        <template v-if="tab === '概览'">
          <div class="section-heading">
            <h3>请求信息</h3>
            <span class="pill">{{ protectionText }}</span>
          </div>
          <dl class="metadata">
            <dt>完整 URL</dt>
            <dd>{{ record.request_url }}</dd>
            <dt>请求方法</dt>
            <dd>{{ record.method }}</dd>
            <dt>所属页面</dt>
            <dd>{{ record.page_url ?? "未知：浏览器未提供页面上下文" }}</dd>
            <dt>实际 Referer</dt>
            <dd>{{ refererText }}</dd>
            <dt>发起脚本</dt>
            <dd>{{ record.initiator_url ?? "未提供发起脚本" }}</dd>
            <dt>观察时间</dt>
            <dd>
              {{ record.timestamp
              }}<small>{{ timeText(record.timestamp) }}</small>
            </dd>
            <dt>请求终态</dt>
            <dd>
              {{ record.request_state
              }}{{ record.error ? " · " + record.error : "" }}
            </dd>
            <dt>响应类型</dt>
            <dd>
              {{
                record.response_content_type ||
                record.response_metadata.mime_type ||
                "未取得"
              }}
            </dd>
            <dt>协议 / 远端</dt>
            <dd>
              {{ record.response_metadata.protocol || "未知协议" }} ·
              {{ record.response_metadata.remote_ip_address || "未知地址"
              }}{{
                record.response_metadata.remote_port !== null
                  ? ":" + record.response_metadata.remote_port
                  : ""
              }}
            </dd>
            <dt>响应来源 / 传输量</dt>
            <dd>
              {{
                record.response_metadata.from_service_worker
                  ? "Service Worker"
                  : record.response_metadata.from_disk_cache
                    ? "磁盘缓存"
                    : record.response_metadata.from_prefetch_cache
                      ? "预取缓存"
                      : "网络或内存缓存"
              }}
              ·
              {{
                record.response_metadata.encoded_data_length === null
                  ? "未知"
                  : bytesText(record.response_metadata.encoded_data_length)
              }}
            </dd>
            <dt>Filter 结果</dt>
            <dd>{{ filterVerdict }} · v{{ record.filter_version }}</dd>
          </dl>
          <div class="section-heading">
            <h3>采集质量</h3>
            <span class="muted">缺失与完整分别留账</span>
          </div>
          <div class="quality-list">
            <div
              v-for="[carrier, q] in Object.entries(record.capture_status)"
              :key="carrier"
            >
              <div class="inline">
                <span>{{ carrierLabels[carrier] ?? carrier }}</span
                ><span class="quality-badge" :class="q.state">{{
                  qualityLabels[q.state]
                }}</span>
              </div>
              <p>{{ q.reason ?? "已保存浏览器可观测字段" }}</p>
            </div>
          </div>
          <details class="technical-details">
            <summary>响应网络详情</summary>
            <dl class="metadata">
              <dt>状态文本</dt>
              <dd>{{ record.response_metadata.status_text || "未取得" }}</dd>
              <dt>MIME / 协议</dt>
              <dd>
                {{ record.response_metadata.mime_type || "未取得" }} /
                {{ record.response_metadata.protocol || "未取得" }}
              </dd>
              <dt>远端地址</dt>
              <dd>
                {{ record.response_metadata.remote_ip_address || "未取得"
                }}{{
                  record.response_metadata.remote_port !== null
                    ? ":" + record.response_metadata.remote_port
                    : ""
                }}
              </dd>
              <dt>IP 地址空间</dt>
              <dd>
                {{
                  record.response_metadata.resource_ip_address_space || "未取得"
                }}
              </dd>
              <dt>缓存 / Service Worker</dt>
              <dd>
                磁盘缓存
                {{ record.response_metadata.from_disk_cache ? "是" : "否" }} ·
                预取缓存
                {{
                  record.response_metadata.from_prefetch_cache ? "是" : "否"
                }}
                · Service Worker
                {{ record.response_metadata.from_service_worker ? "是" : "否" }}
              </dd>
              <dt>编码传输量</dt>
              <dd>
                {{
                  record.response_metadata.encoded_data_length === null
                    ? "未取得"
                    : bytesText(record.response_metadata.encoded_data_length)
                }}
              </dd>
              <dt>Cookie 阻止信息</dt>
              <dd>
                <pre class="mini-json">{{
                  pretty(record.response_metadata.blocked_cookies ?? [])
                }}</pre>
              </dd>
              <dt>Timing</dt>
              <dd>
                <pre class="mini-json">{{
                  pretty(record.response_metadata.timing)
                }}</pre>
              </dd>
              <dt>TLS 安全信息</dt>
              <dd>
                <pre class="mini-json">{{
                  pretty(record.response_metadata.security_details)
                }}</pre>
              </dd>
            </dl>
          </details>
          <details class="technical-details">
            <summary>请求身份与关联</summary>
            <dl class="metadata">
              <dt>任务 ID</dt>
              <dd>{{ record.scan_id }}</dd>
              <dt>请求 ID</dt>
              <dd>{{ record.request_id }}</dd>
              <dt>浏览器请求 ID</dt>
              <dd>{{ record.cdp_request_id }}</dd>
              <dt>标签页 / 框架</dt>
              <dd>
                {{ record.tab_id < 0 ? "未知" : record.tab_id }} /
                {{ record.frame_id ?? "未知" }}
              </dd>
              <dt>Target / Session</dt>
              <dd>
                {{ record.target_id ?? "未知" }} / {{ record.session_id }}
              </dd>
              <dt>重定向跳次</dt>
              <dd>{{ record.redirect_hop }}</dd>
              <dt>请求组 ID</dt>
              <dd>{{ record.group_id ?? "未归并" }}</dd>
            </dl>
          </details>
          <template v-if="group"
            ><h3>请求组差异</h3>
            <p class="muted">
              {{
                group.changes?.length
                  ? group.changes.join("、")
                  : "本组暂未记录差异字段"
              }}
            </p>
            <dl class="metadata">
              <dt>首次观察</dt>
              <dd>{{ group.first }}</dd>
              <dt>末次观察</dt>
              <dd>{{ group.last }}</dd>
            </dl></template
          >
        </template>
        <template v-else-if="tab === '参数'"
          ><div class="section-heading">
            <h3>Query 参数</h3>
            <span class="muted"
              >{{ record.query_params.length }} 个值 · 保留重复名称与顺序</span
            >
          </div>
          <p
            v-if="!Array.isArray(props.record?.query_params)"
            class="field-note"
          >
            旧记录未保存 Query 解析字段；以下结果尽可能从已保存的请求 URL
            恢复，原始记录保持不变。
          </p>
          <table v-if="record.query_params.length" class="key-value">
            <thead>
              <tr>
                <th>名称</th>
                <th>观察值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in record.query_params" :key="i">
                <td>{{ p.name || "（空名称）" }}</td>
                <td>{{ p.value === "" ? "（空字符串）" : p.value }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-state compact">
            <Icon name="filter" :size="28" />
            <h3>此 URL 没有 Query 参数</h3>
            <p>请求体中的业务参数可在“请求体”查看。</p>
          </div></template
        >
        <template v-else-if="tab === '请求头'"
          ><div class="section-heading">
            <h3>Request Headers</h3>
            <span
              class="quality-badge"
              :class="record.capture_status.headers.state"
              >{{ qualityLabels[record.capture_status.headers.state] }}</span
            >
          </div>
          <p class="field-note">
            {{
              record.capture_status.headers.reason ??
              "仅展示浏览器可观测的请求头。"
            }}
          </p>
          <table v-if="record.request_headers.length" class="key-value">
            <thead>
              <tr>
                <th>名称</th>
                <th>观察值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in record.request_headers" :key="i">
                <td>{{ p.name }}</td>
                <td :class="{ 'protected-value': p.value === '[REDACTED]' }">
                  {{ p.value }}
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-state compact">
            <h3>未取得请求头</h3>
            <p>{{ record.capture_status.headers.reason }}</p>
          </div></template
        >
        <template v-else-if="tab === '请求体'"
          ><div class="section-heading">
            <h3>Request Body</h3>
            <span
              class="quality-badge"
              :class="record.capture_status.body.state"
              >{{ qualityLabels[record.capture_status.body.state] }}</span
            >
          </div>
          <div class="info-strip">
            <span>{{ record.content_type || "未提供 Content-Type" }}</span
            ><span>{{ record.request_body.representation }}</span>
          </div>
          <div v-if="requestBodyAvailable" class="code-card">
            <div class="code-toolbar">
              <span>{{ requestBodyBytes }}</span
              ><button
                class="text-button"
                @click="emit('copy', requestBodyText)"
              >
                <Icon name="copy" :size="14" />复制内容
              </button>
            </div>
            <pre>{{ requestBodyText }}</pre>
          </div>
          <div v-else class="empty-state compact">
            <Icon name="file" :size="28" />
            <h3>
              {{
                record.capture_status.body.state === "complete"
                  ? "未报告请求正文"
                  : "请求体未保存为可解析内容"
              }}
            </h3>
            <p>
              {{
                record.capture_status.body.reason ?? "该请求没有可展示的正文。"
              }}
            </p>
          </div>
          <p v-if="record.protection.truncated" class="field-note warning-text">
            正文或解析深度达到上限，记录为部分采集。
          </p></template
        >
        <template v-else-if="tab === '响应头'"
          ><div class="section-heading">
            <h3>Response Headers</h3>
            <span
              class="quality-badge"
              :class="record.capture_status.response_headers.state"
              >{{
                qualityLabels[record.capture_status.response_headers.state]
              }}</span
            >
          </div>
          <p class="field-note">
            {{
              record.capture_status.response_headers.reason ??
              "展示浏览器可观测的响应头；原始头文本在 Chrome 提供时保存在原始数据中。"
            }}
          </p>
          <table v-if="record.response_headers.length" class="key-value">
            <thead>
              <tr>
                <th>名称</th>
                <th>观察值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in record.response_headers" :key="i">
                <td>{{ p.name }}</td>
                <td>{{ p.value === "" ? "（空字符串）" : p.value }}</td>
              </tr>
            </tbody>
          </table>
          <details
            v-if="record.response_headers_raw"
            class="technical-details response-headers-raw"
          >
            <summary>Chrome 原始响应头文本</summary>
            <pre>{{ record.response_headers_raw }}</pre>
          </details>
          <div v-else class="empty-state compact">
            <h3>未取得响应头</h3>
            <p>{{ record.capture_status.response_headers.reason }}</p>
          </div></template
        >
        <template v-else-if="tab === '响应体'"
          ><div class="section-heading">
            <h3>Response Body</h3>
            <span
              class="quality-badge"
              :class="record.capture_status.response_body.state"
              >{{
                qualityLabels[record.capture_status.response_body.state]
              }}</span
            >
          </div>
          <div class="info-strip">
            <span>{{
              record.response_content_type || "未提供 Content-Type"
            }}</span
            ><span>{{ record.response_body.representation }}</span
            ><span v-if="record.response_body.encoding === 'base64'"
              >Base64 编码</span
            >
          </div>
          <div v-if="responseBodyAvailable" class="code-card">
            <div class="code-toolbar">
              <span>{{ responseBodyBytes }}</span
              ><button
                class="text-button"
                @click="emit('copy', responseBodyText)"
              >
                <Icon name="copy" :size="14" />复制内容
              </button>
            </div>
            <pre>{{ responseBodyText }}</pre>
          </div>
          <div v-else class="empty-state compact">
            <Icon name="file" :size="28" />
            <h3>响应体没有可展示内容</h3>
            <p>
              {{
                record.capture_status.response_body.reason ??
                "该请求没有响应正文，或旧记录未保存响应体。"
              }}
            </p>
          </div></template
        >
        <template v-else-if="tab === '调用栈'">
          <div class="initiator-view">
            <details class="initiator-section" open>
              <summary class="initiator-section-summary">
                <h3>Request call stack</h3>
              </summary>
              <div
                v-if="stack.some((segment) => segment.frames.length)"
                class="stack-list initiator-call-stack"
              >
                <section
                  v-for="(segment, segmentIndex) in stack"
                  :key="segmentIndex"
                  class="stack-segment"
                >
                  <div
                    v-if="
                      segment.async ||
                      (segment.description &&
                        segment.description !== '当前调用栈')
                    "
                    class="stack-boundary"
                  >
                    {{ segment.description }}
                  </div>
                  <div
                    v-for="(frame, i) in segment.frames"
                    :key="i"
                    class="stack-frame initiator-frame"
                  >
                    <span
                      class="frame-function"
                      :title="frame.functionName || '(anonymous)'"
                      >{{ frame.functionName || "(anonymous)" }}</span
                    >
                    <button
                      class="text-button frame-location"
                      :title="frameLocation(frame)"
                      @click="emit('copy', frameLocation(frame))"
                    >
                      {{ shortFrameLocation(frame) }}
                    </button>
                  </div>
                  <p v-if="segment.warning" class="initiator-note field-note">
                    {{ segment.warning }}
                  </p>
                </section>
              </div>
              <div v-else class="empty-state compact">
                <h3>浏览器未提供可展开的调用栈</h3>
              </div>
              <details v-if="stackNotice" class="initiator-notice">
                <summary>部分调用信息不可用</summary>
                <p class="field-note">{{ stackNotice }}</p>
              </details>
            </details>
            <details class="initiator-section" open>
              <summary class="initiator-section-summary">
                <h3>Request initiator chain</h3>
              </summary>
              <ul class="initiator-chain" role="tree" aria-label="请求发起链">
                <li
                  v-for="(node, i) in initiatorChain?.nodes ?? []"
                  :key="node.request_id || `${node.request_url}:${i}`"
                  class="initiator-chain-node"
                  :class="{ current: node.current }"
                  :style="{ '--chain-depth': Math.min(node.depth, 8) }"
                  role="treeitem"
                  :aria-level="node.depth + 1"
                >
                  <span
                    class="chain-branch"
                    :class="{ nested: node.depth > 0 }"
                    aria-hidden="true"
                  ></span>
                  <span
                    v-if="node.current || !node.request_id"
                    class="chain-url"
                    :title="node.request_url"
                    :aria-current="node.current ? 'true' : undefined"
                    >{{ node.request_url }}</span
                  >
                  <button
                    v-else
                    class="text-button chain-url"
                    :title="node.request_url"
                    @click="node.request_id && emit('inspect', node.request_id)"
                  >
                    {{ node.request_url }}
                  </button>
                </li>
              </ul>
              <p
                v-if="initiatorChain?.warning || initiatorChain?.truncated"
                class="initiator-note field-note"
              >
                {{
                  initiatorChain.warning ||
                  "发起链过长，仅显示浏览器已保留的部分。"
                }}
              </p>
            </details>
          </div>
        </template>
        <template v-else
          ><div class="section-heading">
            <h3>完整请求记录</h3>
            <button
              class="text-button"
              @click="emit('copy', pretty(props.record))"
            >
              <Icon name="copy" :size="14" />复制 JSON
            </button>
          </div>
          <p class="field-note">
            这里包含所有已保存字段及采集状态；字段名完整保存，字段值按任务选择完整保留或自动截断。
          </p>
          <pre class="raw-record">{{ pretty(props.record) }}</pre>
        </template>
      </div>
    </template>
    <div v-else class="empty-state compact">
      <Icon name="file" :size="28" />
      <h3>尚未取得请求记录</h3>
      <p>请选择列表中的请求；若记录已被删除，请刷新任务。</p>
    </div>
  </aside>
</template>
