<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { parseSimpleQuery, simpleQueryFromFilter } from "./filter-query";
import { validateFilter } from "./filter";

const filterText = defineModel<string>({ required: true });
const emit = defineEmits<{ validity: [valid: boolean] }>();
const query = ref(""),
  advanced = ref(false),
  advancedReason = ref(""),
  error = ref(""),
  lastOutput = ref("");

const summary = computed(() => {
  try {
    return parseSimpleQuery(query.value).summary;
  } catch {
    return [];
  }
});

watch(
  filterText,
  (text) => {
    if (text === lastOutput.value) {
      lastOutput.value = "";
      return;
    }
    try {
      const filter = JSON.parse(text);
      validateFilter(filter);
      const state = simpleQueryFromFilter(filter);
      advanced.value = state.advanced;
      if (state.advanced) {
        query.value = "";
        advancedReason.value = state.reason;
      } else query.value = state.query;
      error.value = "";
      emit("validity", true);
    } catch {
      advanced.value = true;
      query.value = "";
      advancedReason.value = "历史过滤规则数据无效，无法安全显示为搜索语句";
      emit("validity", false);
    }
  },
  { immediate: true },
);

function update(value = query.value) {
  query.value = value;
  try {
    const { filter } = parseSimpleQuery(value);
    const output = JSON.stringify(filter, null, 2);
    lastOutput.value = output;
    filterText.value = output;
    error.value = "";
    emit("validity", true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    emit("validity", false);
  }
}

function reset() {
  advanced.value = false;
  advancedReason.value = "";
  update("");
}
</script>

<template>
  <div class="simple-filter">
    <label class="simple-filter-input" :class="{ disabled: advanced }">
      <Icon name="search" :size="18" />
      <input
        v-model="query"
        aria-label="请求筛选"
        placeholder="输入网址关键词，或 domain:api.example.com; method:POST"
        spellcheck="false"
        :disabled="advanced"
        @input="update()"
      />
      <button
        v-if="query && !advanced"
        type="button"
        class="icon-button"
        aria-label="清空请求筛选"
        @click="update('')"
      >
        <Icon name="close" :size="14" />
      </button>
    </label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="advanced" class="simple-filter-advanced" role="alert">
      <Icon name="alert" :size="18" />
      <div>
        <strong>这条历史规则无法完整转成搜索语句</strong>
        <p>{{ advancedReason }}。为避免改变原意，当前规则没有被覆盖。</p>
      </div>
      <button class="button" type="button" @click="reset">
        清空规则并保存全部请求
      </button>
    </div>
    <div class="filter-syntax-help" aria-label="过滤语法说明">
      <p>
        <strong>空框保存全部请求。</strong
        >直接输入文字匹配请求网址。多个条件必须用英文分号
        <code>;</code> 隔开；分号表示“并且”，所有条件需要同时满足。
      </p>
      <div class="filter-syntax-grid">
        <span><code>domain:api.example.com</code> 按字段过滤</span>
        <span><code>method:GET,POST</code> 逗号表示任选一个</span>
        <span><code>-resource-type:Image</code> 排除 Chrome 的 Image 类型</span>
        <span><code>url:/\/api\/v\d+/i</code> 使用正则表达式</span>
        <span><code>"order detail"</code> 双引号包住带空格的内容</span>
        <span><code>(method:POST OR method:PUT)</code> 括号内任选条件</span>
        <span><code>header.Authorization:?</code> 问号表示字段存在</span>
        <span><code>-header.Authorization:?</code> 表示字段不存在</span>
      </div>
      <p class="filter-query-example">
        完整示例：<code
          >domain:example.com; method:POST,PUT; -resource-type:Image;
          url:/\/api\//i</code
        >
      </p>
      <p class="filter-fields">
        字段：<code>url</code>、<code>domain</code>、<code>path</code>、<code>method</code>、<code>status-code</code>、<code>resource-type</code>、<code>page</code>、<code>page-domain</code>、<code>referer</code>、<code>initiator</code>、<code>extension</code>、<code>query.参数名</code>、<code>header.请求头名</code>、<code
          >body.JSON路径</code
        >
      </p>
      <p class="filter-fields">
        参数与正文：<code>query.name:value</code>、<code>header.Name:value</code>、<code
          >body.json.path:value</code
        >
      </p>
      <p class="filter-fields">
        常用资源类型：<code>XHR</code>、<code>Fetch</code>、<code>Ping</code>（Beacon）、<code>Preflight</code>、<code>Document</code>、<code>Script</code>、<code>Stylesheet</code>、<code>Image</code>、<code>Media</code>、<code>Font</code>、<code>EventSource</code>、<code>WebSocket</code>、<code>Other</code>。全部类型和区别见左侧“使用说明”。
      </p>
    </div>
    <div
      v-if="!advanced"
      class="simple-filter-summary"
      data-testid="filter-summary"
    >
      <Icon name="check" :size="15" />
      <span>{{ summary.join(" · ") }}</span>
    </div>
  </div>
</template>
