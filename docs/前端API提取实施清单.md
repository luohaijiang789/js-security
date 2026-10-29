# 前端 API 提取实施清单

更新：2026-10-29（UTC）；当前提取器版本 0.9.3 / 插件 0.7.1。本文件累计记录此前已实现能力，并作为后续迭代的执行清单，每项完成后更新勾选、版本和证据。详细设计沿用[迭代路线与验证](前端API提取迭代路线与验证.md)，范围沿用[总方案](API资产收集总方案.md)。

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

## 已实现能力台账（累计至 0.9.3）

下面保留 0.1～0.8.3 并补充 0.9 的累计能力，按实际实现的子集勾选。B01～B07 保留为流程索引，详细能力以下表/条目为准；后续 P0～P5 中未完成的扩展继续保持未勾选。版本取首次交付或主要补强版本，不把历史测试数累计相加。

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
- [x] R13 整体配置/未知展开可能包含未见的 Query/Body/Header 时，载体根路径明确未知；显式覆盖与已知无字段分别保留（0.8.3）。[问题与验证](../frontend-api-extractor/docs/external-baselines.md)

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

- [x] V08 GDB/Nacos/OSS 固定源码切片与人工预期验证；上游 11 文件哈希复核、逐调用/条件/字段与未知项检查，validationPassed 与 extractionComplete 分开（0.8.3）。[结果与限制](../frontend-api-extractor/docs/external-baselines.md)

### 独立黑盒一的已有实现（不计作黑盒二已接入）

- [x] K01 独立 MV3 插件工程与请求工作台：浏览器范围任务、动态接入页面、暂停/恢复/停止、单框 Filter、列表与详情侧栏；已有工程实现与自动化测试。[插件入口](../browser-extension/README.md)、[任务/范围测试](../browser-extension/tests/browser-scope.test.ts)
- [x] K02 已实现请求/响应字段、同步/异步调用栈、发起关系链、质量/缺失状态、可选字段与截断、本地存储及 JSONL/CSV/目录导出；受控 CDP、核心和 UI 测试与实际扩展安装验收分开。[实现与验证边界](插件开发与安装.md)、[调用栈测试](../browser-extension/tests/call-stack-cdp.test.ts)
- [x] K03 内部接收服务和阿里云 SLS 转存实现，失败批次本地保留；已有协议与转存测试，不把它算作生产 SLS 现场验收。[转存测试](../browser-extension/tests/transfer.test.ts)、[SLS 测试](../browser-extension/tests/sls.test.ts)
- [ ] K04 目标企业 Chrome 的完整 MV3 现场验收；已有企业扩展安装策略阻断记录，不能因代码或替代 API 测试通过就勾选。[阻断与后续验收](插件开发与安装.md)

### 0.9.1补强（已完成限定范围）

- [x] J01 明确call/apply的this、箭头/普通函数/提取方法隔离，受限数组中间件操作与条件Object.assign，防错误Host或整体配置丢失。[测试](../frontend-api-extractor/test/wrapper-state.test.js)
- [x] J02 Webpack嵌套runtime/回调数组不污染外层ID，虚拟模块作用域/CJS别名/interop与原始行列恢复；不读取旧派生模块。[测试](../frontend-api-extractor/test/webpack.test.js)
- [x] J03 小型精确编译库契约，AST指纹与文件哈希双核对，参考版本/未证明安装版本分开，假同名方法与篡改反例。[测试](../frontend-api-extractor/test/compiled-clients.test.js)
- [x] J04 可选优先入口预算和自动契约消费者提示，仍分析其余文件；文件/全局硬上限及构建JS字节预算。[验证](../frontend-api-extractor/docs/budgets.md)
- [x] J05 JSON/Excel/插件显示函数库存、未连通入口与阶段；Excel压缩后XML逐字节不变，保留完整证据。[交付](../frontend-api-extractor/docs/release-0.9.1.md)
- [x] J06 固定GDB四JS无map的3发送点/4候选、Nacos三文件wrapper的1位置/4候选均通过，输入哈希/手工字段/位置/额外项可复跑；仅是开发回归。[基准](../frontend-api-extractor/baselines/targeted/README.md)

### 当前能力的共同边界

上面的“已实现”均指列明子集。React/Next/Angular 等支持脚本解析不代表生命周期、DI 或零配置构建；ESM 深入追踪与有限 Webpack/外部收集是不同模式；常量解码不代表通用解密；source map 关联不代表所有 vendor 已分析；静态请求候选、上下文 Host 与插件实测必须分开。0.9 已接黑盒二、统一交付、固定 SDK 和 OpenAI 兼容释义；公开无map、真实页面全链、AI语义质量及现场验收仍有未完成项，详见[验证](../frontend-api-extractor/docs/release-0.9.md)。

## P0 基准与差异报告：限定范围完成

P0-01～07 已完成各自限定范围；性能仅为自写 direct-fetch 分布，验证集仅为冻结的有限切片，不代表生产覆盖率。

- [x] P0-01 定义同版调用对照锚点：源码发送位置＋条件＋阶段＋调用链＋仓库/版本/上下文；不依赖随内容变化的表格 id，不作为永久资产 ID（0.8.2）。[规则与测试](../frontend-api-extractor/docs/baselines.md)
- [x] P0-02 自写跨文件微型基准：人工预期、脚本/预期哈希、配置、完整性断言，一条命令复跑（0.8.2）。[基准](../frontend-api-extractor/examples/request-baseline/README.md)
- [x] P0-03 新增/丢失/字段变化/变未知/歧义及分析状态差异报告；GDB 同版历史结果对照，不能只比数量（0.8.2）。[验证](../frontend-api-extractor/docs/baselines.md)
- [x] P0-04 固定 GDB/Nacos/OSS 有限外部切片 manifest、11 个源文件/人工预期哈希与逐调用/字段/条件核查；18 个发送位置/22 条候选预期匹配（0.8.3）。包含必须未知的缺口验收，不算全仓准确率或独立盲测。[基准与结果](../frontend-api-extractor/docs/external-baselines.md)
- [x] P0-05 冻结 Ant Design Pro 独立切片：8调用/16条件候选先标注后首测，16/16匹配；开发/回归/验证流转登记（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P0-06 统一 Schema 2.0.0、记录/字段/缺口/证据 ID、旧格式适配与未知版本拒绝（0.9）。[协议](../frontend-api-extractor/docs/delivery-protocol.md)
- [x] P0-07 100/1000/10000 自写文件冷/热性能基线，时间/进程峰值RSS/步数/源码哈希及超限反例（0.9）。[基线](../frontend-api-extractor/docs/validation-0.9.md)

## P1 参数改写、hook 与序列化：部分实现

- [x] P1-01 条件实例副作用保守降级、闭包中间件与多次调用隔离切片通过；不承诺一般堆状态（0.9）。[实例测试](../frontend-api-extractor/test/instances.test.js)、[封装测试](../frontend-api-extractor/test/wrappers.test.js)
- [x] P1-02 核对 Nacos username/accessToken/Content-Type 与body替换，自动保存未应用hook候选；异步/条件/runWhen 最终值仍未知（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P1-03 JSON、URLSearchParams、FormData 分载体验证重复键/删除/编码/未知值与快照；不冒充最终网络字段（0.9）。[表单测试](../frontend-api-extractor/test/forms.test.js)
- [x] P1-04 原样 OSS BaseHttp+自写驱动，显式DI下验证opt.url/headers改写；相对Host依赖Global.endpoint，SDK另验（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)

## P2 请求封装与业务链：语义子集完成，页面全链未通过

- [x] P2-01 jQuery ajax/get/post/getJSON 适配与同名反例；ajaxSetup/hooks未支持则保留缺口（0.9）。[测试](../frontend-api-extractor/test/wrappers.test.js)
- [x] P2-02 受限call/apply及静态reduce，多文件实参到发送点、未知this/参数反例通过（0.9）。[测试](../frontend-api-extractor/test/wrappers.test.js)
- [x] P2-03 普通类自身字段/方法/工厂与AngularJS显式DI分别支持，继承/隐式DI不冒充已恢复（0.9）。[测试](../frontend-api-extractor/test/instances.test.js)
- [ ] P2-04 Nacos真实wrapper+自写入口已恢复URL/方法/字段；GDB无map为函数库存候选，真实页面生命周期全链仍未连通。[0.9.1实测](../frontend-api-extractor/docs/release-0.9.1.md)

## P3 构建产物与 JS 引用：有限适配与独立无 map 样本通过

B05 只完成 source-map 辅助关联，不代表以下项完成。

- [x] P3-01 自写真实Webpack5生产压缩分块，固定版本/源码/产物哈希与人工预期（0.9）。[基准](../frontend-api-extractor/examples/webpack-chunks/README.md)
- [x] P3-02 有限Webpack5模块表/ID/导出/引用适配，原始fetch行列可核对，不执行runtime（0.9）。[测试](../frontend-api-extractor/test/webpack.test.js)
- [x] P3-03 有限publicPath/chunk静态表达式与引用图，缺失/未知/冲突明确缺口（0.9）。[资产测试](../frontend-api-extractor/test/script-assets.test.js)
- [x] P3-04 独立公开 Vite/weather 固定正式无map产物：首测前冻结预期、未调提取规则，2业务发送位置/4种URL和参数形态全部通过；另1资源位置Host未知，方法不纳入准确率评价。仅此限定范围，不代表任意混淆/运行时覆盖（0.9.2）。[验证](../frontend-api-extractor/docs/release-0.9.2.md)
- [x] P3-05 有限Webpack4正式分块；已有静态字符串/编码/间接调用子集保持独立，未实现通用解密（0.9）。[测试](../frontend-api-extractor/test/webpack.test.js)
- [x] P3-06 HTML内联/外链与显式资产收集，build最多1层、website最多3层，多父链/哈希/重定向/截断保留；构建流程不自动抓外网（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)

## P4 SDK 与地址：固定 STS/RAM 子集完成

- [x] P4-01 OSS STS/RAM 自动提取2初始化/12静态操作及输入字段/位置/endpoint；^1.12.3不提升HTTP（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P4-02 精确 aliyun-sdk1.12.3 STS/RAM 61个标量操作协议模型，载体/默认值明确；未知配置/版本拒绝（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P4-03 实际SDK离线build与自写驱动交叉核对61操作、编码/默认字段/Headers，attemptedNetwork=0；重复键由通用表单反例验收（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)

## AI 字段释义：接口完成，真实质量待验收

- [x] AI-01 显式开关、字段路径/文件名最小外发、无原始值，记录model/promptVersion，OpenAI兼容接口及预算（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] AI-02 独立annotations/支持引用/复核提示，禁止结构越界与改写静态状态；真实本地HTTP兼容协议已测（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [ ] AI-03 真实模型语义质量尚未验收：用户已选OpenAI兼容协议，仍需实际endpoint/model和环境密钥；独立人工标注、无依据推断与拒答统计待完成。[边界](../frontend-api-extractor/docs/release-0.9.md)

## P5 黑盒二与最终交付：实现完成，现场验收受阻

- [x] P5-01 页面/脚本资产包及导入协议，上下文/URL/哈希/多父链/获取状态；已加载JS父链未知保留null（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P5-02 插件JS探索、静态/实测双视图及本地受控Node服务，异步任务/令牌/Origin/结果回读；完整MV3现场另列（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [x] P5-03 统一analysis.json+三Sheet Excel，三路独立证据，实际插件包导入及长内容/公式保护（0.9）。[协议](../frontend-api-extractor/docs/delivery-protocol.md)
- [x] P5-04 真实Vue/Vite子目录GitHub→npm构建→表格；精确pnpm9.15.4/Yarn1.22.22独立固定样例均跑通，预算不完整照实保留（0.9）。 [验证](../frontend-api-extractor/docs/release-0.9.md)
- [ ] P5-05 受控多层站点、缺失/截断/多版本已通过；阿里云国际/帮助站再次CONNECT403，真实站点及完整MV3现场仍受阻。[证据](../frontend-api-extractor/docs/release-0.9.md)

## 0.9.2 构建可复现性补强

- [x] K05 构建前检查：固定 Commit、输入路径/大小约束、脚本/锁文件/工具冲突校验，`--inspect-only` 输出构建计划且不启动 Docker（0.9.2）。[验证](../frontend-api-extractor/docs/release-0.9.2.md)
- [x] K06 原锁缺平台包时显式固定 esbuild Linux 编译器补充；父包声明/SHA512/严格解包/只读工具/独立来源回执，原锁不变（0.9.2）。[测试](../frontend-api-extractor/test/native-dependency.test.js)
- [x] K07 独立无map冻结预期与通用构建验证器；严格URL路径/Query字段集合/已知字段依据，意外发送位置失败（0.9.2）。[基准](../frontend-api-extractor/baselines/validation/weather-no-map.json)

## 0.9.3 绑定函数与请求体状态

- [x] K08 静态bind的this/预填参数/重复绑定/call/apply/箭头词法this；分支绑定对象别名、自有方法覆盖/删除和预算限制，7份自写原生JS对照（0.9.3）。[验证](../frontend-api-extractor/docs/release-0.9.3.md)
- [x] K09 明确序列化JSON请求体不再因格式大括号误判动态；字段未知与不支持replacer仍partial（0.9.3）。[测试](../frontend-api-extractor/test/bind.test.js)

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
| 0.8.2 | P0-01、P0-02、P0-03 | 手工基准 3 个调用；GDB 4 行逐项对照；180 项自动化测试 | [基准与差异](../frontend-api-extractor/docs/baselines.md) |
| 0.8.3 | P0-04；未知配置的三个载体明确未知 | 外部 11 文件上游哈希、22 条预期；193 项自动化测试；既有构建产物回归 | P0-05～07、P1 扩展、P2～P5 与 AI 继续推进 |
| 0.9.0 / 插件0.7.0 | P0余项、P1子集、封装/类/表单、有限Webpack、固定SDK、OpenAI兼容接口、黑盒二与统一Excel | 验证数量与性能见本轮报告；真实Vue/pnpm/Yarn构建、SDK61操作 | [验证与未通过项](../frontend-api-extractor/docs/release-0.9.md)、[基准](../frontend-api-extractor/docs/validation-0.9.md) |
| 0.9.1 / 插件0.7.1 | J01～J06，真实压缩请求恢复、封装链、模块作用域/库契约及依据交付 | 提取器279、插件155项；旧外部22/22、Ant16/16、新定向4位置/8候选；原始XML不变 | [验证与剩余项](../frontend-api-extractor/docs/release-0.9.1.md) |
| 0.9.2 / 插件0.7.1 | K05～K07、P3-04限定验收；构建前检查、固定原生编译器补装 | 提取器286项全通过；独立Vite无map首测4/4业务形态；GDB 3位置/4候选、Nacos 1位置/4候选回归通过；真实重复构建/Excel与仅检查入口通过 | [验证与范围](../frontend-api-extractor/docs/release-0.9.2.md) |
| 0.9.3 / 插件0.7.1 | K08～K09，绑定函数及已知JSON序列化状态 | 提取器298项；7份自写原生行为对照；GDB/Nacos/weather冻结回归通过；跨文件Excel样例 | [验证与剩余项](../frontend-api-extractor/docs/release-0.9.3.md) |

历史说明（0.8.2 文档补全时）：按实现、测试、历次验证补录 S/E/R/Q/D/V 和独立黑盒一台账，补齐 0.1.0～0.8.2 历史；该次仅补文档，180 项为当时最近一次代码验证记录。后续迭代以表中各版本记录为准。
