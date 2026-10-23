# 0.2 验证报告

## 执行方式与结果

```bash
npm ci
npm test
npm run demo
```

本次 `npm test`：52 项通过，0 项失败。V1 的 33 项保留，并将原来只能输出未知值的 3 项分支用例升级为检查具体候选集合；新增 19 项迭代测试。

| 类别 | 数量 | 主要校验 |
| --- | ---: | --- |
| 基础分析 | 9 | 跨文件、ESM 转导出、别名、请求封装、动态参数、递归与预算 |
| 框架适配 | 3 | Vue Unicode/CRLF 行列号、Svelte module/instance、破损文件诊断 |
| CLI | 5 | 自动配置、JSON/Markdown 文件、退出码、帮助、目标源码不执行 |
| 多框架集成 | 1 | 预期接口集合、完整调用链、语义层、参数与源码位置 |
| 回归 | 15 | 展开覆盖顺序、默认配置合并、解构、CommonJS、短路、返回值、配置校验 |
| 0.2 迭代 | 19 | 条件候选与相关性、数组/循环、ofetch/ky、Request/URL、循环对象与同名遮蔽 |

## 测试仓库

位置：`examples/multi-framework`。它是人工编写的可重复静态分析验收仓库，未克隆真实开源业务仓库，也未运行框架应用。

包含 React、Vue script setup、Vue Options API、Svelte、Angular、Next.js、Solid、原生 JS、uni-app 风格请求和 CommonJS；0.2 增加 ofetch/ky、动态 method/URL 配对、静态数组 for-of、标准 URL/Request。各框架外部依赖不安装，分析器只读取源码。`expected.json` 独立维护预期方法和 URL，测试直接比较整个集合。

结果：扫描 18 个源码文件，12 个入口文件，得到 19 个接口。预期 19 个全部命中，额外接口 0 个，漏提取 0 个。其中 13 个 resolved，6 个 partial。

partial 包含 1 个动态路径、2 个条件分支接口，以及 3 个分支之后的接口。后者覆盖两个分支路径，但当前仍保守记录每条路径的条件，不做全覆盖条件消除。

专项断言：

- React page → hook → service → transport 的证据链完整，实际参数 7 到达 `/v1/users/7`。
- Vue/Svelte 脚本来自真实框架 parser，调用位置对应原文件。
- Axios 默认 headers、query 及各调用独立参数保留。
- 未引用的 service、dist 文件、Map.get、本地同名 fetch 不产生 HTTP 接口误报。
- 目标代码中的文件写入和 throw 语句不会在扫描时执行。
- 未解析值、递归、循环 require、动态分支、深度/执行预算受限均有可检查结果或诊断。
- 同一个 if 内的 GET /v2/preview 与 POST /v2/publish 不生成相互交叉的错误组合。
- ofetch query/body、ky prefixUrl/searchParams/json 及标准 Request 构造被统一提取。
- 静态数组回调和 for-of 使用真实元素，支持无标签 break/continue，避免重复产生未知回调参数的假接口。
- maxCandidates 超限会报告；循环对象可保守序列化；业务 tag 字段不会被当成内部抽象类型。

示例报告：`reports/multi-framework.json`，由 `npm run demo` 生成。Markdown 含条件摘要：

```bash
node src/cli.js examples/multi-framework --format markdown --out reports/multi-framework.md
```

该报告保留 6 条诊断：1 条 DYNAMIC_BRANCH，以及 5 条 UNRESOLVED_CALL（4 个未模拟实现的外部框架 hook、1 个未知的局部 fetch 参数）。hook 回调中的接口仍可提取。因而 stats.complete=false；这不会被解读为丢失 19 个已知预期接口，也不会被清除来伪造全程序完备性。

## 验证边界

上述零漏提取、零额外接口仅针对这份固定预期测试仓库，不能外推成真实项目准确率。另已执行三个阿里/阿里云公开仓库的指定 API 层范围及 GDB 页面入口探测，见 [真实源码报告](alibaba-real-world.md)。尚未完成大型全仓的准确率、内存、耗时评估，也不具备模板事件调用和复杂运行时数据流的完整分析能力。
