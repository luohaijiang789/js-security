<script setup lang="ts">
import { computed } from "vue";
import { SLS_FIELDS, DEFAULT_SLS_FIELDS } from "./sls-fields";
const fields = defineModel<string[] | undefined>();
const selected = computed(() => new Set(fields.value ?? DEFAULT_SLS_FIELDS));
function toggle(key: string, checked: boolean) {
  const next = new Set(selected.value);
  if (checked) next.add(key);
  else next.delete(key);
  fields.value = SLS_FIELDS.map((f) => f[0]).filter((k) => next.has(k));
}
</script>
<template>
  <fieldset class="field-selector sls-field-selector">
    <div class="field-selector-heading">
      <div>
        <legend>SLS 上传字段</legend>
        <p>
          独立于本地保存。仅上传本地已采集的内容；请求
          ID、时间、URL、Method、状态与任务关联始终保留。
        </p>
      </div>
    </div>
    <div class="inline">
      <button
        type="button"
        class="button"
        @click="fields = [...DEFAULT_SLS_FIELDS]"
      >
        恢复推荐</button
      ><button
        type="button"
        class="button"
        @click="fields = SLS_FIELDS.map((f) => f[0])"
      >
        全选上传字段</button
      ><button type="button" class="button" @click="fields = []">
        仅基本信息
      </button>
    </div>
    <div class="field-selector-grid">
      <label v-for="[key, title, description] in SLS_FIELDS" :key="key"
        ><input
          type="checkbox"
          :checked="selected.has(key)"
          @change="toggle(key, ($event.target as HTMLInputElement).checked)"
        /><span
          ><strong>{{ title }}</strong
          ><small>{{ description }}</small></span
        ></label
      >
    </div>
    <p>
      正文只保存一份：JSON/表单优先解析值，文本/二进制保存原文或 Base64。重复
      JSON 键、高精度数字等不安全解析情况保留 raw。完整调用栈不裁剪帧。
    </p>
  </fieldset>
</template>
