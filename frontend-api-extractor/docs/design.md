# 前端代码仓接口提取设计

## 目标与约束

从不执行的前端源码提取 HTTP 接口，并回答接口在哪里定义、哪些入口使用、经过哪些封装、哪些字段尚不能确定。支持跨 JS/TS 文件继续追踪。优先保证证据和可解释性，不承诺运行时完备性。扫描目标仓库时不加载它的构建配置或执行插件代码。

## 层次模型

1. 入口：glob 选择页面、组件、hooks 或任意脚本；不指定时采用全仓清单模式。
2. 语义层：用户定义名称和 glob，例如 page → hook → service → transport。允许缺层、重复层、逆向调用；仅用于标注，不作为唯一追踪依据。
3. 调用深度：跨函数追踪的最大边数，与目录层级无关；达到上限记录诊断，不把结果当完整。
4. 依赖范围：项目根目录内文件、排除目录、扩展名、路径别名；首版不分析 node_modules 内实现。

## 架构

源码发现 → 框架脚本适配 → TS AST/符号索引 → 有界符号执行 → 请求适配 → 接口归并/调用点 → JSON/Markdown。

- 文件适配：JS/JSX/TS/TSX/MJS/CJS/MTS/CTS 直接解析；Vue 使用官方 SFC parser；Svelte 使用官方 compiler parser。脚本提取以空白填充非脚本部分，保持原始位置。
- 统一分析：TypeScript compiler API 解析 JS 和 TS、绑定符号，跨 import/export、重导出及路径别名查找声明。无需完整依赖安装或通过类型检查。
- 值模型：常量、对象、数组、函数、HTTP 客户端、附带条件的有限候选、带原因的未知值。函数参数按符号绑定，避免同名变量串值。模板字符串里的未知值保留占位符；内部抽象类型使用 Symbol，避免与业务字段冲突。
- 请求适配：fetch、axios（含别名和 create）、ofetch、Nuxt $fetch、ky、node-fetch/cross-fetch 和配置声明的客户端。通用自定义封装通过分析函数体追踪；Angular HttpClient 等带类型/实例语义的客户端通过显式规则声明。
- 调用分析：入口文件的所有调用作为候选，按实际参数向下传播；全仓模式还分析函数定义中的请求。回调函数体作为潜在可执行分支遍历。递归、深度上限、无法解析的外部依赖均产生诊断。
- 归并：method + 有效 URL 合并，保留每条独立调用链和源码证据。首版不自动合并不同参数名，以避免错误合并不同业务路径。

## 框架策略

React/Preact/Next/Remix、Vue/Nuxt、Svelte/SvelteKit、Angular、Solid、原生脚本共享分析内核。首版覆盖各自脚本中的静态请求；模板表达式调用、Angular DI 自动推导、Astro/MDX 内嵌脚本、运行时生成 SDK、打包产物 sourcemap 是后续适配项。框架兼容表示可解析相关源码，不代表能模拟框架生命周期或运行时。

## 配置（JSON，不执行仓库配置）

```json
{
  "entries": ["src/pages/**", "src/views/**"],
  "include": ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte}"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  "maxDepth": 8,
  "maxSteps": 100000,
  "maxStepsPerFile": null,
  "maxCandidates": 16,
  "aliases": { "@/*": ["src/*"] },
  "layers": [{ "name": "service", "match": ["src/api/**"] }],
  "clients": [{ "name": "http", "kind": "axios" }]
}
```

客户端配置是显式信任规则：name 为源码里的精确表达式，例如 http 或 this.http；kind 支持 axios/fetch/ofetch/ky。规则用于无法进入实现的客户端，能追踪实现的本地函数优先向下分析。tsconfig/jsconfig 的路径别名可读取，用户 aliases 优先覆盖。

0.5 起按入口与已知可达补漏资产分区分配剩余 maxSteps，局部中断不阻塞其他文件。maxStepsPerFile 为附加的单分区上限，默认 null；stats.partitions 与 Markdown 保留各分区的配额和中断状态。规则及未重试边界见[预算说明](budgets.md)。

## 输出契约

schemaVersion、mode、stats、endpoints、diagnostics。接口包含 method、url、resolution、query、body、headers、usages；usage 包含 entry、完整 callChain、文件/行/列/语义层、unresolved、conditions、自身 resolution。conditions 中每项记录 expression、outcome 与源码位置，同一 usage 内按 AND 解释，不同 usage 为不同潜在路径。未知 method 不默认成 GET；未提供 method 时才采用请求库的 GET 默认值。字符串中动态占位符与条件候选均记为 partial。JSON 为机器接口，Markdown 为人工阅读摘要。0.2 新增字段保持 schemaVersion=1 的对象结构。

## 有界路径与候选传播（0.2）

if 分支保留独立作用域和条件，提前 return 结束对应路径。返回值、三元与短路表达式产生有限候选，继续通过拼接、模板字符串、对象、实参及跨文件封装传播。请求落点展开候选，丢弃同一条件位置上相互冲突的路径。同一分支内 URL 和 method 不做无条件笛卡尔积；不同条件表达式之间尚未做全局逻辑求解。

maxCandidates 限制候选组合、控制流路径和静态循环/回调项数；超限明确记录 CANDIDATE_LIMIT，后续值合并未知或路径截断，不能宣称扫描完整。分支作用域复制保留局部对象别名，但不等于完整跨函数堆分析。所有路径覆盖同一接口时仍可能保守保留条件并标 partial。

## 可追溯性与边界

不做无证据的 OpenAPI 必填性/响应结构推断；不请求真实接口。动态 URL、分支、对象展开未知字段应显式标为 partial/unresolved。首版只做有界上下文敏感求值，不做全程序数据流固定点、运行时原型链或堆分析。跨闭包、可变赋值和复杂分支的精确性是后续专项，无法证明时应保留未知。扫描是潜在调用关系，不证明调用在运行时一定发生。

## 分期与验收

P0：CLI、设计文档、框架脚本适配、符号解析、封装追踪、请求识别、配置、JSON/Markdown、测试。

验收用例：跨文件 service → request → axios.create；入口实参传播；相同名称不同绑定不串值；Vue/Svelte 原始行号；React TSX；路径别名和转导出；动态 URL；循环/深度上限；不把普通对象 get 方法识别为 HTTP；解析错误可见。

V1 实现补充：基础静态 CommonJS require/exports/module.exports 已提前纳入；已处理局部与嵌套形参解构、返回函数的局部参数、配置覆盖顺序、基础 if/短路表达式及提前返回。用多框架合成仓库和回归测试验收，见 testing.md。

0.2 实现补充：有限条件候选、简单属性赋值、基础 URL/Request 构造、ofetch/ky/fetch 导入、静态数组 map/forEach/for-of 与无标签 break/continue；未知循环给出近似分析诊断。

P1：函数摘要缓存、增量索引、复杂 CommonJS 导出与别名变更、Angular DI、更多请求库、模板调用边、复杂闭包精度、跨条件约束求解与路径归并。

P2：monorepo 包解析、GraphQL 操作语义、OpenAPI 草稿、交互式调用链和 CI 差异报告。
