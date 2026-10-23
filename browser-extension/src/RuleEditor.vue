<script setup lang="ts">
import { computed } from "vue";
import type { Rule } from "./model";

type Section = "scope" | "include" | "exclude";
const props = defineProps<{ rule: Rule; section?: Section }>();
const emit = defineEmits<{ change: [rule: Rule] }>();

const fields = [
  ["page_url", "页面网址"],
  ["page_host", "页面域名"],
  ["referer", "来源页面"],
  ["initiator_url", "发起脚本网址"],
  ["request_url", "请求网址"],
  ["domain", "请求域名"],
  ["pathname", "请求路径"],
  ["extension", "文件扩展名"],
  ["method", "请求方法"],
  ["resource_type", "资源类型"],
  ["status_code", "响应状态码"],
  ["query", "查询参数"],
  ["header", "请求头"],
  ["body", "请求体"],
] as const;
const positiveOperators = [
  ["contains", "包含"],
  ["contains_any", "包含任意一个值"],
  ["equals", "等于"],
  ["starts_with", "开头是"],
  ["ends_with", "结尾是"],
  ["in", "是以下任意一个值"],
  ["regex", "符合正则表达式"],
  ["wildcard", "符合通配符"],
  ["domain", "属于该域名"],
  ["exists", "存在"],
] as const;
const negativeOperators = [
  ["not_exists", "不存在"],
  ["not_contains", "不包含"],
  ["not_equals", "不等于"],
  ["not_in", "不是以下任意值"],
  ["not_regex", "不符合正则表达式"],
  ["not_wildcard", "不符合通配符"],
  ["not_starts_with", "开头不是"],
  ["not_ends_with", "结尾不是"],
] as const;

const fieldOptions = computed(() => {
  const allowed =
    props.section === "scope"
      ? fields.filter(([value]) =>
          ["page_url", "page_host", "referer"].includes(value),
        )
      : fields.filter(
          ([value]) => !["page_url", "page_host", "referer"].includes(value),
        );
  if ("op" in props.rule) return allowed;
  const atomic = props.rule;
  if (!allowed.some(([value]) => value === atomic.field)) {
    const known = fields.find(([value]) => value === atomic.field);
    return [
      [atomic.field, `旧规则：${known?.[1] ?? atomic.field}`] as const,
      ...allowed,
    ];
  }
  return allowed;
});
const operatorOptions = computed(() => {
  const allowed =
    props.section === "exclude"
      ? [...positiveOperators]
      : [...positiveOperators, ...negativeOperators];
  if ("op" in props.rule) return allowed;
  const atomic = props.rule;
  if (!allowed.some(([value]) => value === atomic.operator))
    return [
      [atomic.operator, `旧规则：${atomic.operator}`] as const,
      ...allowed,
    ];
  return allowed;
});
const legacyField = computed(() => {
  if (!("field" in props.rule)) return false;
  const pageField = ["page_url", "page_host", "referer"].includes(
    props.rule.field,
  );
  return props.section === "scope" ? !pageField : pageField;
});
const legacyNegative = computed(
  () =>
    "field" in props.rule &&
    props.section === "exclude" &&
    props.rule.operator.startsWith("not_"),
);

const atom = (): Rule => ({
  field: props.section === "scope" ? "page_url" : "request_url",
  operator: "contains",
  values: [""],
});
function patch(value: object) {
  emit("change", { ...props.rule, ...value } as Rule);
}
function child(index: number, value?: Rule) {
  if (!("op" in props.rule) || props.rule.op === "not") return;
  const rules = [...props.rule.rules];
  if (value) rules[index] = value;
  else rules.splice(index, 1);
  patch({ rules });
}
function type(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "field") emit("change", atom());
  else emit("change", { op: value as "and" | "or", rules: [atom()] });
}
function text(event: Event) {
  patch({ values: (event.target as HTMLTextAreaElement).value.split("\n") });
}
</script>

<template>
  <div class="rule-editor">
    <div v-if="'op' in rule && rule.op === 'not'" class="legacy-rule-warning">
      <strong>这条旧规则使用了旧版反向条件</strong>
      <p>
        为避免双重否定，可视化编辑已停用。可以清除此区域重新设置，或在下方 JSON
        编辑器中维护旧规则。
      </p>
    </div>
    <template v-else>
      <div class="toolbar">
        <select
          :value="'op' in rule ? rule.op : 'field'"
          aria-label="条件组合方式"
          @change="type"
        >
          <option value="field">一个条件</option>
          <option value="and">以下条件全部满足</option>
          <option value="or">以下条件任一满足</option>
        </select>
        <template v-if="'field' in rule"
          ><select
            :value="rule.field"
            aria-label="检查哪个内容"
            @change="
              (e) => patch({ field: (e.target as HTMLSelectElement).value })
            "
          >
            <option
              v-for="([value, label], index) in fieldOptions"
              :key="value"
              :value="value"
              :disabled="index === 0 && legacyField"
            >
              {{ label }}
            </option></select
          ><input
            v-if="['query', 'header', 'body'].includes(rule.field)"
            :value="rule.key"
            placeholder="参数名、请求头名称或 JSON 路径"
            aria-label="内容名称"
            @input="(e) => patch({ key: (e.target as HTMLInputElement).value })"
          /><select
            :value="rule.operator"
            aria-label="怎样判断"
            @change="
              (e) => patch({ operator: (e.target as HTMLSelectElement).value })
            "
          >
            <option
              v-for="([value, label], index) in operatorOptions"
              :key="value"
              :value="value"
              :disabled="index === 0 && legacyNegative"
            >
              {{ label }}
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
          <RuleEditor
            :rule="r"
            :section="section"
            @change="(value) => child(i, value)"
          /><button v-if="rule.rules.length > 1" @click="child(i)">
            删除这个条件
          </button>
        </div>
        <button @click="patch({ rules: [...rule.rules, atom()] })">
          再加一个条件
        </button></template
      ><textarea
        v-else-if="!['exists', 'not_exists'].includes(rule.operator)"
        :value="rule.values?.join('\n')"
        rows="3"
        placeholder="填写要比较的内容；多个值时每行一个"
        aria-label="条件值"
        @input="text"
      ></textarea>
      <p v-if="legacyField || legacyNegative" class="field-note warning-text">
        这是旧版高级规则。为避免产生难以理解的结果，请清除此区域重新设置，或使用
        JSON 编辑器维护。
      </p>
    </template>
  </div>
</template>
