# 0.8 验证报告

## 执行方式与结果

```bash
npm ci
npm test
npm run demo
```

本次 `npm test`：193 项通过，0 项失败。0.8.3 新增 13 项外部人工基准与未知载体回归，见[外部切片验证](external-baselines.md)。0.8.2 的 180 项保留。0.8.2 新增 10 项基准与差异回归，见[固定基准](baselines.md)。0.8.1 的 170 项保留。0.8.1 新增 8 项部署上下文与表格回归，另在离线仓库流程核对配置落盘，见[部署上下文验证](deployment-context.md)。0.8.0 的 162 项保留。0.7 的 146 项保留，新增 13 项仓库/产物/表格验证及 3 项真实应用异常回归。0.6 的 124 项保留，新增 22 项同步 hook 验证。0.5 的 99 项保留，新增 25 项对象副作用与改写证据测试。0.4 的 88 项保留，新增 11 项预算隔离测试。0.3 的 70 项保留，0.4 新增 17 项异步资产测试与 1 项 CLI 补漏测试。原 52 项保留，新增 18 项白盒复杂 JS 与证据回归。V1 的 33 项保留，并将原来只能输出未知值的 3 项分支用例升级为检查具体候选集合；新增 19 项迭代测试。

| 类别 | 数量 | 主要校验 |
| --- | ---: | --- |
| 基础分析 | 9 | 跨文件、ESM 转导出、别名、请求封装、动态参数、递归与预算 |
| 框架适配 | 3 | Vue Unicode/CRLF 行列号、Svelte module/instance、破损文件诊断 |
| CLI | 6 | 自动配置、JSON/Markdown 文件、退出码、帮助、目标源码不执行 |
| 多框架集成 | 1 | 预期接口集合、完整调用链、语义层、参数与源码位置 |
| 回归 | 15 | 展开覆盖顺序、默认配置合并、解构、CommonJS、短路、返回值、配置校验 |
| 异步资产 | 17 | 动态模块、真实压缩分块、断链补漏、循环与压缩表达式 |
| 同步请求 hook | 22 | 实例、顺序、eject/clear、阶段隔离、未知/预算、真实预期样例 |
| 部署上下文 | 8 | 相对/绝对地址、Host 来源/状态、动态与冲突、阶段隔离和配置前置校验 |
| 外部人工基准 | 13 | 人工模式/条件/字段、未知载体、哈希/隔离/路径、额外候选、hook/完整性、CLI 与冻结标注 |
| 基准与差异 | 10 | 手工预期/哈希、逐调用/字段差异、重复/歧义、上下文和完整性状态、CLI |
| 仓库构建关联 | 13 | 地址/锁文件/任务、source map、字段/位置表、失败与导出 |
| 对象副作用 | 28 | 别名/浅拷贝、删除与覆盖、调用快照、条件与未知副作用、证据上限 |
| 预算分区 | 11 | 入口与跨文件隔离、补漏预留、全局硬上限、局部上限、未扫描证据 |
| 白盒补强 | 18 | JS 识别与引用、分段地址、独立 Host、字段构造/覆盖、编码、hook 降级 |
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

## 本轮白盒复核

见 [问题分析与实施边界](whitebox-hardening.md)。固定版本 Nacos console-ui-next 的 namespace.ts 复跑得到 203 个可解析源码资产、5 个调用点/10 个动态前缀 URL 候选，10 个均标请求 hook 后状态未知。只复核该 API 层，不宣称页面链路或整个仓库已覆盖。外部源码与原始报告不进入 Git。

## 深层与压缩 JS 对照

[深层 JS 验证](async-assets.md)保留公开原文件链接、哈希、esbuild 参数、发送点/字段检查和国际站 CONNECT 403 失败。该对照不声称任意混淆、Webpack runtime 或线上站点已覆盖。

## 预算隔离与同样本复跑

[分区预算验证](budgets.md)记录同一 Nacos 13 文件的旧版/新版默认扫描，以及 OSS 的 SDK 缺口。Nacos 自动定位的发送点由 3 个增至 23 个，与四个 reducer 的独立 AST 位置一致；预算中断文件继续明确标记，不提升为全仓或运行时覆盖证明。

## 对象改写与快照

[对象副作用验证](object-effects.md)记录哈希固定的自写样例、独立配置快照参考和 Nacos/GDB 回归。hook 求值、DI 和 SDK HTTP 未因此完成。

## 有限同步 request hook

[同步 hook 验证](request-hooks.md)记录开启范围、JSON 字段阶段、真实 Axios 本地 adapter 对照与 Nacos 保留结果。与实际网络/服务端接收验收分开。

## 真实仓库到请求表

[仓库流程](repository-pipeline.md)与[GDB 构建请求表](gdb-build-pilot.md)分别记录流程范围和真实结果。离线任务测试与真实 Docker/npm 构建分开；后者实际生成 4 个 JS、关联 21 个应用 source 与 3 个发送位置。完整性仍 false，未掩盖 vendor、Host 或预算缺口。
