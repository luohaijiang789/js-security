<script setup lang="ts">
import type { Rule } from "./model";
const props = defineProps<{ rule: Rule }>();
const emit = defineEmits<{ change: [rule: Rule] }>();
const atom = (): Rule => ({
  field: "request_url",
  operator: "contains",
  values: [""],
});
function patch(value: object) {
  emit("change", { ...props.rule, ...value } as Rule);
}
function child(index: number, value?: Rule) {
  if (!("op" in props.rule)) return;
  const rules = [...props.rule.rules];
  if (value) rules[index] = value;
  else rules.splice(index, 1);
  patch({ rules });
}
function type(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "field") emit("change", atom());
  else emit("change", { op: value as "and" | "or" | "not", rules: [atom()] });
}
function text(event: Event) {
  patch({ values: (event.target as HTMLTextAreaElement).value.split("\n") });
}
</script>
<template>
  <div class="rule-editor">
    <div class="toolbar">
      <select :value="'op' in rule ? rule.op : 'field'" @change="type">
        <option value="field">字段条件</option>
        <option value="and">AND 全部满足</option>
        <option value="or">OR 任一满足</option>
        <option value="not">NOT 否定</option>
      </select>
      <template v-if="'field' in rule"
        ><select
          :value="rule.field"
          @change="
            (e) => patch({ field: (e.target as HTMLSelectElement).value })
          "
        >
          <option
            v-for="f in [
              'page_url',
              'page_host',
              'referer',
              'initiator_url',
              'request_url',
              'domain',
              'pathname',
              'extension',
              'method',
              'resource_type',
              'status_code',
              'query',
              'header',
              'body',
            ]"
            :key="f"
          >
            {{ f }}
          </option></select
        ><input
          v-if="['query', 'header', 'body'].includes(rule.field)"
          :value="rule.key"
          placeholder="名称 / JSON 点路径"
          @input="(e) => patch({ key: (e.target as HTMLInputElement).value })"
        /><select
          :value="rule.operator"
          @change="
            (e) => patch({ operator: (e.target as HTMLSelectElement).value })
          "
        >
          <option
            v-for="op in [
              'contains',
              'contains_any',
              'equals',
              'starts_with',
              'ends_with',
              'in',
              'regex',
              'wildcard',
              'domain',
              'exists',
              'not_exists',
              'not_contains',
              'not_equals',
              'not_in',
              'not_regex',
              'not_wildcard',
              'not_starts_with',
              'not_ends_with',
            ]"
            :key="op"
          >
            {{ op }}
          </option></select
        ><label
          ><input
            type="checkbox"
            :checked="rule.case_sensitive"
            @change="
              (e) =>
                patch({
                  case_sensitive: (e.target as HTMLInputElement).checked,
                })
            "
          />区分大小写</label
        ></template
      >
    </div>
    <template v-if="'op' in rule"
      ><div v-for="(r, i) in rule.rules" :key="i">
        <RuleEditor :rule="r" @change="(value) => child(i, value)" /><button
          v-if="rule.op !== 'not' && rule.rules.length > 1"
          @click="child(i)"
        >
          删除此条件
        </button>
      </div>
      <button
        v-if="rule.op !== 'not'"
        @click="patch({ rules: [...rule.rules, atom()] })"
      >
        添加条件 / 嵌套组
      </button></template
    ><textarea
      v-else-if="!['exists', 'not_exists'].includes(rule.operator)"
      :value="rule.values?.join('\n')"
      rows="3"
      placeholder="每行一个值，支持多行粘贴"
      @input="text"
    ></textarea>
  </div>
</template>
