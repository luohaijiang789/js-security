<script setup lang="ts">
import { computed } from "vue";
import { OPTIONAL_FIELDS, type OptionalField } from "./field-selection";

const props = defineProps<{
  modelValue: string[] | undefined;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const options: Array<{
  value: OptionalField;
  label: string;
  description: string;
}> = [
  {
    value: "request_headers",
    label: "请求头",
    description: "Cookie、Authorization、Content-Type 等",
  },
  {
    value: "query_params",
    label: "Query 参数",
    description: "保留重复参数、空值和原始顺序",
  },
  {
    value: "request_body",
    label: "请求体",
    description: "JSON、表单及浏览器提供的原始正文",
  },
  {
    value: "page_context",
    label: "页面来源",
    description: "发出请求的页面 URL 与页面采集状态",
  },
  {
    value: "initiator",
    label: "发起信息与关系链",
    description: "Initiator URL、类型及上下游请求关系",
  },
  {
    value: "initiator_stack",
    label: "Request call stack",
    description: "Chrome 可观测的同步帧和异步父链",
  },
];

const current = computed(
  () => new Set(props.modelValue ?? [...OPTIONAL_FIELDS]),
);
const all = computed(() =>
  OPTIONAL_FIELDS.every((field) => current.value.has(field)),
);

function toggle(field: OptionalField, checked: boolean) {
  const next = new Set(current.value);
  if (checked) next.add(field);
  else next.delete(field);
  emit(
    "update:modelValue",
    OPTIONAL_FIELDS.filter((item) => next.has(item)),
  );
}
</script>

<template>
  <fieldset class="field-selector" :disabled="disabled">
    <div class="field-selector-heading">
      <div>
        <legend>保存字段</legend>
        <p>默认全部保存。请求 ID、时间、URL、Method、类型和状态始终保留。</p>
      </div>
      <button
        type="button"
        class="text-button"
        @click="emit('update:modelValue', all ? [] : [...OPTIONAL_FIELDS])"
      >
        {{ all ? "取消全选" : "全选" }}
      </button>
    </div>
    <div class="field-selector-grid">
      <label v-for="option in options" :key="option.value">
        <input
          type="checkbox"
          :checked="current.has(option.value)"
          @change="
            toggle(option.value, ($event.target as HTMLInputElement).checked)
          "
        />
        <span
          ><strong>{{ option.label }}</strong
          ><small>{{ option.description }}</small></span
        >
      </label>
    </div>
  </fieldset>
</template>
