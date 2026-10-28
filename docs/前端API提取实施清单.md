# 前端 API 提取实施清单

更新：2026-10-28（Asia/Shanghai）；当前版本 0.8.2。本文件累计记录此前已实现能力，并作为后续迭代的执行清单，每项完成后更新勾选、版本和证据。详细设计沿用[迭代路线与验证](前端API提取迭代路线与验证.md)，范围沿用[总方案](API资产收集总方案.md)。

目标：输入前端 GitHub 仓库地址 → 固定版本 → 自动安装/正式构建 → 清点 JS/引用 → 有界深入分析 → 导出逐调用请求表。表格包含 JS 与源码位置、Host、URL、方法、Query/Body/Header 字段、条件、依据和未解析项。AI 释义独立附加。

## 勾选规则

- [x] 表示该条限定范围已经实现并验证；不表示整阶段或所有框架完成。
- [ ] 包括未开始、进行中和受阻项，状态写在条目内；有缺口的整阶段不能勾选。
- 每条完成须有实现/测试或实测文档链接。人工语义预期与历史输出回归分开记录。
- 外部仓库、依赖、构建产物和原始报告留在忽略目录 work/；主仓库只收自写小样例与 MD 来源链接。

## 已交付基础流程

- [x] B01 源码扫描：JS/TS/JSX/TSX、Vue/Svelte 脚本与有限跨文件追踪；入口/深度/候选/预算可配置。[实现范围](../frontend-api-extractor/README.md)
- [x] B02 P1a 可确定对象赋值、别名、删除、合并及改写证据；未知副作用降级（0.6）。[验证](../frontend-api-extractor/docs/object-effects.md)
- [x] B03 P1b 有限、显式同步 Axios hook；执行顺序、实例隔离、eject/clear，后阶段单独输出（0.7）。[验证](../frontend-api-extractor/docs/request-hooks.md)
- [x] B04 GitHub HTTPS → 固定 Commit → 根目录 npm 锁文件 → Docker 正式构建；失败留日志，不切换源码成功（0.8）。[流程](../frontend-api-extractor/docs/repository-pipeline.md)
- [x] B05 构建 JS/source map 清单与哈希；匹配应用 sourcesContent，关联源码和产物位置；未映射/vendor/预算缺口保留（0.8）。[GDB 实测](../frontend-api-extractor/docs/gdb-build-pilot.md)
- [x] B06 逐调用/条件/阶段的 CSV、Markdown、JSON 请求表；真实 GDB 得到 3 个发送位置、4 行候选（0.8）。[请求表](../frontend-api-extractor/docs/gdb-build-pilot.md)
- [x] B07 可选部署页面基址补全静态相对地址；代码 Host 与上下文候选分开（0.8.1）。[验证](../frontend-api-extractor/docs/deployment-context.md)

## 已实现能力台账（累计至 0.8.2）

下面补齐 0.1～0.8.2 的累计能力，按实际实现的子集勾选。B01～B07 保留为流程索引，详细能力以下表/条目为准；后续 P0～P5 中未完成的扩展继续保持未勾选。版本取首次交付或主要补强版本，不把历史测试数累计相加。

### S：源码、配置和 JS 引用

- [x] S01 JS/JSX/TS/TSX/MJS/CJS/MTS/CTS 源码发现与 AST 解析；默认排除依赖、构建和声明文件，支持 include/exclude（0.1）。[配置实现](../frontend-api-extractor/src/config.js)、[设计范围](../frontend-api-extractor/docs/design.md)
- [x] S02 Vue 普通 script/script setup、Svelte module/instance 脚本提取，保留原文件 Unicode/CRLF 行列；破损文件有诊断，Vue 外置 script src 明确未支持（0.1）。[解析器适配与反例](../frontend-api-extractor/test/adapters.test.js)
- [x] S03 入口 glob / 默认库存模式、自定义名称和 glob 的语义层；层次用于证据标注，跨层追踪由真实函数/模块关系决定（0.1）。[配置示例](../frontend-api-extractor/api-extractor.config.example.json)、[多框架验收](../frontend-api-extractor/test/integration.test.js)
- [x] S04 读取 tsconfig/jsconfig 的 baseUrl/paths，允许 aliases 增量覆盖；按符号区分同名变量和形参（0.1）。[绑定与别名测试](../frontend-api-extractor/test/analyzer.test.js)、[回归](../frontend-api-extractor/test/regressions.test.js)
- [x] S05 本地 ESM 导入/导出/转导出，以及基础静态 CommonJS require/exports/module.exports；缺依赖、循环与本地同名 require 有边界处理（0.1～0.3）。[模块测试](../frontend-api-extractor/test/regressions.test.js)、[遮蔽反例](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] S06 本地动态 import 的 await/then、模块解构/默认导出/转导出与可静态计算路径；可继续深入子 JS 和传播参数，不自动下载远程模块（0.4）。[动态模块验证](../frontend-api-extractor/docs/async-assets.md)
- [x] S07 assets 保存识别脚本的内容哈希、解析状态、模块引用/引用位置与未取得引用；破损 JS 也留在清单（0.3）。[资产测试](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] S08 usage.assetPath 保留一条已知模块引用路径，全部已知边在 assets.imports；与函数调用链分开，不表示唯一父链或运行时执行（0.4）。[引用路径范围](../frontend-api-extractor/docs/async-assets.md)
- [x] S09 可选 includeUnlinked/--include-unlinked，沿已知引用做局部资产补漏；assetCandidates 与 endpoints 分开，保留未连通状态且共享预算（0.4）。[补漏与限制](../frontend-api-extractor/docs/async-assets.md)、[CLI 测试](../frontend-api-extractor/test/cli.test.js)

### E：跨函数追踪、表达式和有限还原

- [x] E01 跨文件函数封装、导入别名、对象方法/箭头属性、默认/解构参数、返回值和真实实参传播；保留入口到发送点的文件/行/列/符号/语义层（0.1）。[基础测试](../frontend-api-extractor/test/analyzer.test.js)、[封装回归](../frontend-api-extractor/test/regressions.test.js)
- [x] E02 动态 if/三元/短路保留有限条件候选，贯穿字符串、对象、实参和返回；同一分支的 method/URL 相关联，提前返回不继续生成不可达请求（0.2）。[条件与返回测试](../frontend-api-extractor/test/iteration2.test.js)
- [x] E03 静态实参展开、数组 map/forEach、静态数组 for-of、无标签 break/continue；其他循环采用有诊断的近似分析（0.2）。[数组和循环测试](../frontend-api-extractor/test/iteration2.test.js)
- [x] E04 字符串拼接/模板、静态字符串表、join/concat、字面量 atob、URI 编解码、String.fromCharCode、JSON parse/stringify 和 Object.assign 的受限处理（0.3）。不执行目标 eval、任意解码器或加密代码。[编码与分段地址测试](../frontend-api-extractor/test/whitebox-hardening.test.js)、[白名单实现](../frontend-api-extractor/src/request-evidence.js)
- [x] E05 处理压缩逗号表达式及受限短路赋值；捕获的可变状态未绑定时保留未知，不沿用伪确定初值（0.4）。[压缩/捕获状态反例](../frontend-api-extractor/test/async-assets.test.js)
- [x] E06 抽象类型采用 Symbol，避免业务 tag 冲突；循环对象安全序列化为未知；数组 length/大索引和实参候选溢出有明确降级（0.2、0.8）。[值模型反例](../frontend-api-extractor/test/iteration2.test.js)、[数组与候选回归](../frontend-api-extractor/test/object-effects.test.js)

### R：请求、Host 和参数

- [x] R01 全局 fetch 及导入的 node-fetch/cross-fetch 等 fetch 兼容入口；基础标准 URL/Request 构造与调用覆盖（0.1～0.2）。同名局部函数/构造器不作为标准入口。[请求适配实现](../frontend-api-extractor/src/request-clients.js)、[构造与遮蔽测试](../frontend-api-extractor/test/iteration2.test.js)
- [x] R02 Axios 函数/config、request、命名方法导入、别名、create 与客户端默认 baseURL/headers/query 的受限合并；每次调用参数独立（0.1）。[Axios 测试](../frontend-api-extractor/test/analyzer.test.js)、[合并顺序回归](../frontend-api-extractor/test/regressions.test.js)
- [x] R03 ofetch 命名导入/create/raw/query/body、未被局部绑定遮蔽的 Nuxt $fetch；ky/ky-universal 的 prefixUrl/searchParams/json/extend 和方法调用（0.2）。[请求库验收](../frontend-api-extractor/test/iteration2.test.js)、[适配实现](../frontend-api-extractor/src/request-clients.js)
- [x] R04 自定义 clients 精确表达式声明，支持 axios/fetch/ofetch/ky 语义，可适配已知注入的 $http 或 this.http（0.1）。这是显式配置，不是 Angular/AngularJS DI 自动推导。[配置规则](../frontend-api-extractor/docs/design.md)、[Sentinel 定向结果](../frontend-api-extractor/docs/alibaba-real-world.md)
- [x] R05 提取方法、有效 URL、Query/Body/Header 结构和每条 usage 的参数；URL 自带 Query 字段名也提取，字段路径与动态值分开记录（0.1～0.3）。[字段证据实现](../frontend-api-extractor/src/request-evidence.js)、[字段测试](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] R06 address 独立保存原始请求地址/baseURL、Host/origin/path、hostState 和阶段；协议相对 URL 不猜协议，相对 URL 不借用 GitHub/CDN Host（0.3）。[地址测试](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] R07 确定对象赋值、别名、浅展开、属性 +=、delete、Object.assign 和跨文件改写；发送时快照，后续变化不污染之前调用（0.6）。[对象改写验证](../frontend-api-extractor/docs/object-effects.md)
- [x] R08 objectChanges 保存改写/删除位置、条件、载体、路径及前后值；未知键、未知副作用、条件函数副作用和历史截断保留缺口，单对象历史上限 128（0.6）。[证据与限制](../frontend-api-extractor/docs/object-effects.md)
- [x] R09 JSON 的受限静态编码与输入快照，区分构造字段、序列化输入和编码后字段；未知加密/replacer/reviver 不伪装确定线上载荷（0.3、0.6～0.7）。[编码字段测试](../frontend-api-extractor/test/request-hooks.test.js)、[加密反例](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] R10 检测直接及已关联别名的 Axios request hook，保留注册位置和调用处未知后效，不污染其他实例或误用 response hook（0.3）。[关联与降级测试](../frontend-api-extractor/test/whitebox-hardening.test.js)
- [x] R11 modelRequestHooks 默认关闭；启用后支持有限显式 synchronous:true 回调、逆注册执行、确定 eject/clear、实例/入口隔离；afterRequestHooks 独立输出（0.7）。异步、runWhen、条件注册、捕获堆和未知 defaults 等仍未知，范围止于 transport 前。[实施与对照](../frontend-api-extractor/docs/request-hooks.md)
- [x] R12 可选 deploymentUrl/--deployment-url；按页面基址解析静态相对 URL，保留原始/解析 URL、Host 来源和候选状态，不修改原始分析证据（0.8.1）。[部署上下文验证](../frontend-api-extractor/docs/deployment-context.md)

### Q：预算、误报控制与可解释性

- [x] Q01 maxDepth/maxSteps/maxCandidates 约束追踪、求值和候选扩张，递归/未知循环/路径超限明确诊断（0.1～0.2）。[配置与预算测试](../frontend-api-extractor/test/analyzer.test.js)、[候选测试](../frontend-api-extractor/test/iteration2.test.js)
- [x] Q02 按入口/已知补漏资产分配预算，跨文件消耗当前入口；局部中断继续其他分区，maxSteps 为硬上限，maxStepsPerFile 为可选附加上限（0.5）。[预算验证](../frontend-api-extractor/docs/budgets.md)
- [x] Q03 JSON/Markdown 保存诊断、分区配额/步数/中断/未扫描、unlinkedScan 与 complete；finished 或空结果不掩盖未建模行为（0.4～0.5）。[预算反例](../frontend-api-extractor/test/budgets.test.js)
- [x] Q04 普通 get、局部 fetch/require、同名标准构造器和内建函数遮蔽有反例；源码扫描不执行目标顶层代码或安装目标依赖（0.1～0.3）。[遮蔽回归](../frontend-api-extractor/test/whitebox-hardening.test.js)、[不执行测试](../frontend-api-extractor/test/cli.test.js)

### D：仓库构建和结果交付

- [x] D01 独立源码 CLI 自动读取目标 JSON 配置，可指定配置、JSON/Markdown 与输出路径；无效配置、选项和目标明确失败（0.1）。[CLI 验证](../frontend-api-extractor/test/cli.test.js)
- [x] D02 GitHub HTTPS 根目录 npm 项目固定完整 Commit；Docker 中按锁文件 npm ci 与正式 build，保留各阶段状态/失败日志，不静默降为源码成功（0.8）。[流程范围](../frontend-api-extractor/docs/repository-pipeline.md)
- [x] D03 保存镜像 digest、原始/应用锁文件哈希、依赖版本、构建前源哈希和 tracked changes；兼容选项与下载地址重写显式配置，保留原 integrity（0.8）。[配置与任务测试](../frontend-api-extractor/test/repository-task.test.js)、[GDB 构建依据](../frontend-api-extractor/docs/gdb-build-pilot.md)
- [x] D04 构建 JS/map 清点、哈希和大小/数量上限；匹配固定源码路径与内容，映射源码发送位置到产物行列；缺 map 时仅尝试 artifact-static 并保留缺口（0.8）。[映射测试](../frontend-api-extractor/test/repository-task.test.js)
- [x] D05 source-map-assisted 限定于可匹配应用 source；同名冲突、vendor/非脚本省略、无产物映射、版本不匹配都有记录（0.8）。[关联范围](../frontend-api-extractor/docs/repository-pipeline.md)
- [x] D06 CSV/Markdown 按调用、条件、阶段保留产物/源码位置、Host、URL、方法、参数、字段路径和缺口；JSON 留完整证据，CSV 带 BOM/引用转义/公式保护（0.8～0.8.1）。[表格与输出测试](../frontend-api-extractor/test/repository-task.test.js)、[真实请求表](../frontend-api-extractor/docs/gdb-build-pilot.md)
- [x] D07 手工预期/哈希/config 固定基准与复跑 CLI；请求差异 CLI 区分新增/丢失/变化/变未知/歧义及可取得的完整性/诊断变化（0.8.2）。[基准与差异](../frontend-api-extractor/docs/baselines.md)

### V：已经做过的验证

- [x] V01 多框架自写静态验收材料：React、Vue、Svelte、Angular、Next、Solid、原生、uni-app 风格和 CommonJS；19 个固定预期接口及源码/参数/层次/调用链断言。只证明这些脚本样例，未跑全框架生命周期。[验证报告](../frontend-api-extractor/docs/testing.md)
- [x] V02 自写正式 esbuild 压缩 ESM 分块、GDB 原 JS/本地压缩 JS 同版对照；核查发送位置、方法/路径及 conn/type/dsl，修复过数量相同却漏点的情况（0.4）。[压缩与引用验证](../frontend-api-extractor/docs/async-assets.md)
- [x] V03 固定版本 Nacos 新/旧控制台、Sentinel 和 GDB 的限定 API 源码切片试跑；Sentinel 配置注入客户端与默认结果分开，不算全仓准确率。[固定链接与范围](../frontend-api-extractor/docs/alibaba-real-world.md)
- [x] V04 Nacos 同一 13 文件切片的预算/对象回归，23 个限定发送位置保留；预算中断、Host/hook 和页面链路缺口仍登记（0.5～0.6）。[预算复跑](../frontend-api-extractor/docs/budgets.md)、[对象回归](../frontend-api-extractor/docs/object-effects.md)
- [x] V05 自写对象改写基准与独立配置快照参考；真实 Axios 1.7.9 的本地 adapter 验证有限同步 hook 的执行顺序/字段。均不代表真实业务网络已发送（0.6～0.7）。[对象对照](../frontend-api-extractor/docs/object-effects.md)、[hook 对照](../frontend-api-extractor/docs/request-hooks.md)
- [x] V06 引用阿里云 UI JS 库的 GDB 固定 Commit 真实 Docker/npm 构建：4 个 JS、21 个应用 source、3 个发送位置/4 行候选；独立产物 AST 核查，完整性仍 false（0.8）。[真实构建记录](../frontend-api-extractor/docs/gdb-build-pilot.md)
- [x] V07 GDB 同版产物部署上下文对照、哈希复核与逐行历史回归；4 行原始 URL、方法、参数和位置不变，原有不完整状态保留（0.8.1～0.8.2）。[上下文对照](../frontend-api-extractor/docs/deployment-context.md)、[差异对照](../frontend-api-extractor/docs/baselines.md)

### 独立黑盒一的已有实现（不计作黑盒二已接入）

- [x] K01 独立 MV3 插件工程与请求工作台：浏览器范围任务、动态接入页面、暂停/恢复/停止、单框 Filter、列表与详情侧栏；已有工程实现与自动化测试。[插件入口](../browser-extension/README.md)、[任务/范围测试](../browser-extension/tests/browser-scope.test.ts)
- [x] K02 已实现请求/响应字段、同步/异步调用栈、发起关系链、质量/缺失状态、可选字段与截断、本地存储及 JSONL/CSV/目录导出；受控 CDP、核心和 UI 测试与实际扩展安装验收分开。[实现与验证边界](插件开发与安装.md)、[调用栈测试](../browser-extension/tests/call-stack-cdp.test.ts)
- [x] K03 内部接收服务和阿里云 SLS 转存实现，失败批次本地保留；已有协议与转存测试，不把它算作生产 SLS 现场验收。[转存测试](../browser-extension/tests/transfer.test.ts)、[SLS 测试](../browser-extension/tests/sls.test.ts)
- [ ] K04 目标企业 Chrome 的完整 MV3 现场验收；已有企业扩展安装策略阻断记录，不能因代码或替代 API 测试通过就勾选。[阻断与后续验收](插件开发与安装.md)

### 当前能力的共同边界

上面的“已实现”均指列明子集。React/Next/Angular 等支持脚本解析不代表生命周期、DI 或零配置构建；ESM 深入追踪不代表 Webpack runtime 或外部 JS 抓取；常量解码不代表通用解密；source map 关联不代表所有 vendor 已分析；静态请求候选、上下文 Host 与插件实测必须分开。完整前端任务界面、黑盒二接入、统一 Excel、SDK 协议还原和 AI 释义仍在后续待办中。

## P0 基准与差异报告：进行中

0.8.2 已完成 P0-01～03；P0-04 为下一优先项。P0 整阶段尚未完成。

- [x] P0-01 定义同版调用对照锚点：源码发送位置＋条件＋阶段＋调用链＋仓库/版本/上下文；不依赖随内容变化的表格 id，不作为永久资产 ID（0.8.2）。[规则与测试](../frontend-api-extractor/docs/baselines.md)
- [x] P0-02 自写跨文件微型基准：人工预期、脚本/预期哈希、配置、完整性断言，一条命令复跑（0.8.2）。[基准](../frontend-api-extractor/examples/request-baseline/README.md)
- [x] P0-03 新增/丢失/字段变化/变未知/歧义及分析状态差异报告；GDB 同版历史结果对照，不能只比数量（0.8.2）。[验证](../frontend-api-extractor/docs/baselines.md)
- [ ] P0-04 固定 GDB/Nacos/OSS 的有限外部切片 manifest 和人工逐调用/字段预期；保存独立标注依据。当前只有历史回归和局部人工核查，不能算全仓标注。
- [ ] P0-05 冻结未参与调规则的验证切片；登记开发集/回归集/验证集流转，建立有限分母。
- [ ] P0-06 明确统一记录/字段/缺口 ID、Schema 兼容与迁移规则；当前对照锚点只用于限定同版比较。
- [ ] P0-07 冻结冷/热性能基线：耗时、峰值 RSS、求值步数和超限行为。当前差异工具只记录步数。

## P1 参数改写、hook 与序列化：部分实现

- [ ] P1-01 补完有独立预期的条件副作用/闭包状态切片；不能沿用旧值或跨调用串值。可确定子集见 B02。
- [ ] P1-02 核对 Nacos 的 username/accessToken/Content-Type 和 body 变换；未支持的异步、条件及 runWhen 路径仍未知。同步子集见 B03。
- [ ] P1-03 JSON、表单、URLSearchParams、FormData 分载体验证，包含重复键、删除、编码与未知加密；输入字段不能冒充最终线上字段。
- [ ] P1-04 OSS BaseHttp 的 opt.url/headers 改写切片与明确预期；Global.endpoint、DI 与 SDK 协议分开验证。

## P2 请求封装与业务链：待推进

- [ ] P2-01 jQuery ajax 请求适配，正例与同名普通方法反例独立验收。
- [ ] P2-02 受限 call/apply、静态中间件 reduce；先连通一条多文件封装链再扩大。
- [ ] P2-03 普通类实例/工厂与 AngularJS 显式 DI 分开实施；配置命中不能冒充自动推导。
- [ ] P2-04 GDB 页面链、Nacos globalLib/ServiceList 定向验证；区分入口连通与资产局部候选。

## P3 构建产物与 JS 引用：待推进

B05 只完成 source-map 辅助关联，不代表以下项完成。

- [ ] P3-01 自写正式 Webpack 5 分块基准，固定构建版本/参数、源码及存活发送点预期。
- [ ] P3-02 识别受支持的 Webpack 5 模块表、ID/导出与引用；不执行目标 runtime。
- [ ] P3-03 publicPath/chunk 文件名与引用图；缺 chunk、未知 runtime 记录缺口，不输出“没有接口”。
- [ ] P3-04 同版无 source map 的压缩分块对照；随后独立公开项目验收。
- [ ] P3-05 再补 Webpack 4；字符串表/常量解码/间接调用按具体模式逐项验证。
- [ ] P3-06 HTML 内联/外链 JS 与外部获取协议：白盒额外获取深度最多 1，网站模式最多 3；引用父链、哈希、重定向、失败和深度截断均保留。

## P4 SDK 与地址：待推进

- [ ] P4-01 OSS Browser 的 STS/RAM：初始化位置、SDK 版本、endpoint、operation、输入字段作为独立候选。
- [ ] P4-02 对固定 SDK/协议模型恢复 method/path/Query/Header/body；不假定 POST 或根路径。
- [ ] P4-03 用自写驱动和离线 transport/本地接收器交叉核查编码、重复 Query、默认参数；不调用真实业务服务。

## AI 字段释义：待推进

- [ ] AI-01 显式开关、最小片段和必要脱敏；记录模型/提示词版本，不默认外发整仓。
- [ ] AI-02 独立输出字段释义、支持片段与复核提示；不生成无依据的 Host/接口/必填性，不更改静态状态。
- [ ] AI-03 人工独立标注集核查缩写、多义词、同名异义和压缩变量名；统计无依据推断与拒答。

## P5 黑盒二与最终交付：待推进

- [ ] P5-01 页面/脚本资产包与导入协议，包含执行上下文、原始/最终 URL、多父链和获取状态。
- [ ] P5-02 插件增加黑盒二入口与静态/实测双视图；选择可部署的受控分析进程，不假定 Node 引擎直接运行在扩展内。
- [ ] P5-03 按[交付约定](结果模型与Excel交付.md)适配统一 analysis.json 与 Excel，保留三类独立证据；当前 CSV 是阶段交付。
- [ ] P5-04 第二个框架/构建体系的完整 GitHub → 构建 → 表格流程；Yarn/pnpm/monorepo 分别配置和验收，不承诺零配置。
- [ ] P5-05 受控多层站点、缺失/截断/不同版本验证，再做获准真实站点与 Chrome 现场验收；当前阿里云线上采集仍有环境访问阻断历史。

## 每次迭代的完成检查

每轮在下面的日志写明本轮条目、证据和未完成项，再更新对应勾选。测试通过不能替代真实项目/站点/Chrome 验收。

1. 固定范围、输入与独立预期，先复现缺口。
2. 完成限定实现与邻近反例，保留未知和预算缺口。
3. 跑相关与全量回归、同版样本差异；解释所有新增/丢失/状态变化。
4. 更新此清单及证据文档，检查链接，提交并合入 main，核对远端和工作区。

| 版本 | 交付内容 | 验证 | 证据 / 遗留 |
| --- | --- | --- | --- |
| 0.1.0 | 源码 CLI、脚本解析、配置/层次、ESM/基础 CommonJS、封装追踪、fetch/Axios、证据输出 | 33 项自动化测试；多框架自写样例 | [历史记录](../frontend-api-extractor/docs/changelog.md) |
| 0.2.0 | 条件候选、静态数组/循环、ofetch/ky、URL/Request | 52 项自动化测试；自写材料 19 个预期接口 | [测试](../frontend-api-extractor/test/iteration2.test.js) |
| 0.3.0 | 资产哈希/引用、独立 Host 状态、字段阶段、静态编码、hook 检测降级 | 70 项自动化测试；限定 Nacos hook 关联核查 | [补强验证](../frontend-api-extractor/docs/whitebox-hardening.md) |
| 0.4.0 | 动态 ESM、引用路径、局部资产补漏、压缩表达式修复 | 88 项自动化测试；自写正式分块/GDB 压缩对照 | [深层 JS 验证](../frontend-api-extractor/docs/async-assets.md) |
| 0.5.0 | 预算分区、硬上限、可选文件配额与中断证据 | 99 项自动化测试；同版 Nacos 23 个限定发送点 | [预算验证](../frontend-api-extractor/docs/budgets.md) |
| 0.6.0 | 对象别名/改写/删除/合并、发送快照与历史证据 | 124 项自动化测试；哈希/手工预期及配置参考 | [对象验证](../frontend-api-extractor/docs/object-effects.md) |
| 0.7.0 | 有限显式同步 Axios hook、顺序/eject/clear/隔离及独立阶段 | 146 项自动化测试；真实 Axios 本地 adapter 对照 | [hook 验证](../frontend-api-extractor/docs/request-hooks.md) |
| 0.8.0 | GitHub/npm/Docker 构建、source map 关联、逐调用请求表 | 162 项自动化测试；真实 GDB 构建与产物核查 | [GDB 实测](../frontend-api-extractor/docs/gdb-build-pilot.md) |
| 0.8.1 | 部署上下文、原始/解析 URL 与 Host 依据/候选状态 | 170 项自动化测试；同版 GDB 4 行对照 | [上下文验证](../frontend-api-extractor/docs/deployment-context.md) |
| 0.8.2 | P0-01、P0-02、P0-03 | 手工基准 3 个调用；GDB 4 行逐项对照；180 项自动化测试 | P0-04～07、P1 扩展、P2～P5 与 AI 仍按上文推进 |

2026-10-28 文档补全：按实现、测试、历次验证补录 S/E/R/Q/D/V 和独立黑盒一台账，补齐 0.1.0～0.8.2 历史；本轮不新增运行能力、不重新宣称现场验收，180 项为最近一次代码版本验证记录。
