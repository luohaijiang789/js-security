<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import {
  appendSimpleToken,
  parseSimpleQuery,
  simpleQueryFromFilter,
} from "./filter-query";
import { validateFilter } from "./filter";

const filterText = defineModel<string>({ required: true });
const emit = defineEmits<{ validity: [valid: boolean] }>();
const query = ref(""),
  advanced = ref(false),
  advancedReason = ref(""),
  error = ref(""),
  lastOutput = ref("");

const examples = [
  { label: "接口网址", token: "url:/api/" },
  { label: "指定域名", token: "domain:api.example.com" },
  { label: "POST", token: "method:POST" },
  { label: "Fetch / XHR", token: "resource-type:Fetch,XHR" },
  {
    label: "排除静态资源",
    token: "-resource-type:Image,Stylesheet,Script,Font,Media",
  },
];

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
      if (state.advanced) advancedReason.value = state.reason;
      else query.value = state.query;
      error.value = "";
      emit("validity", true);
    } catch {
      advanced.value = true;
      advancedReason.value =
        "高级 JSON 当前无法解析，请在下方 JSON 编辑器中修正";
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

function add(token: string) {
  update(appendSimpleToken(query.value, token));
}

function reset() {
  advanced.value = false;
  advancedReason.value = "";
  update("");
}
</script>

<template>
  <div class="simple-filter">
    <template v-if="advanced">
      <div class="simple-filter-advanced">
        <Icon name="layers" :size="18" />
        <div>
          <strong>高级规则已启用</strong>
          <p>{{ advancedReason }}；当前内容不会被自动覆盖。</p>
        </div>
        <button class="button" type="button" @click="reset">
          清空并改用简单筛选
        </button>
      </div>
    </template>
    <template v-else>
      <label class="simple-filter-input">
        <Icon name="filter" :size="17" />
        <input
          v-model="query"
          aria-label="请求筛选"
          placeholder="过滤网址，或输入 domain: / method: / status-code:"
          spellcheck="false"
          @input="update()"
        />
        <button
          v-if="query"
          type="button"
          class="icon-button"
          aria-label="清空请求筛选"
          @click="update('')"
        >
          <Icon name="close" :size="14" />
        </button>
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="simple-filter-examples" aria-label="常用筛选">
        <span>试试：</span>
        <button type="button" @click="reset">全部请求</button>
        <button
          v-for="example in examples"
          :key="example.token"
          type="button"
          @click="add(example.token)"
        >
          {{ example.label }}
        </button>
      </div>
      <p class="simple-filter-help">
        直接输入文字会匹配网址；属性和值用 <code>:</code>，同一属性多个值用
        <code>,</code>。多个条件需同时满足，前面加 <code>-</code>
        表示排除。
      </p>
      <div class="simple-filter-summary" data-testid="filter-summary">
        <Icon name="check" :size="15" />
        <span>{{ summary.join(" · ") }}</span>
      </div>
    </template>
  </div>
</template>
