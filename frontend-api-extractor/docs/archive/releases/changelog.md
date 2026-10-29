# 迭代记录

> 历史记录：保留当时方案、能力与验证，不作为当前进度或能力承诺。当前见[需求](../../goal.md)和[开发计划](../../plan.md)。

## 0.10.0 / 插件0.7.1

- 直接接入固定jshound本地worker，按哈希校验执行代码；--engine jshound/hybrid与默认semantic并存，数据/路由/导航候选分开。
- 混合流程共享索引全输入，自动选请求候选和配置提示文件精查；未知字段/行列不补造，原始worker记录保留，解析失败额外检测。
- RuoYi同160文件、100000语义预算：50个中断分区降为0，15位置/11字段检查保留；语义20分区3298步。三轮端到端时间未显著改善，不能称23.6倍提速。
- 316项普通测试＋8项实际引擎集成；增加可复跑对照工具和函数热点统计。原semantic通用摘要与深度扩展仍待改进。[开源核对](../../internals/research/jshound.md)、[实测和范围](release-0.10.md)。

## 0.9.4 / 插件0.7.1

- 依据真实业务反馈修复条件函数整体失效实参：按对象原始身份跟踪受影响字段，保留未改写URL/方法/Body；有限cloneDeep与模块导出客户端/type支持。
- CLI lazy help、缺依赖提示、开始/结束摘要、空/不完整退出码；--out默认一并Excel。scanFiles、functionInventory和sequential预算策略明确范围。
- 业务调用位置、原始请求URL/Path、稳定call-site-v2调用ID、共享缺口、Excel补列；不宣称记录膨胀/分片已解决。
- 313项测试；公开RuoYi15检查点通过，整仓仍50个预算中断分区。B8/B9/B10、B13、B17/B21继续待办。[逐项台账](release-0.9.4.md)、[使用指南](../../internals/pipeline/source-scan.md)。

## 0.9.3 / 插件0.7.1

- 静态bind保留this/预填参数/重复绑定/箭头词法this；分支克隆保持绑定对象别名，函数自有call/apply/bind覆盖不再误当原生。
- 修复明确JSON.stringify请求体因大括号误标动态；未知输入与不支持replacer仍partial。
- 提取器298项测试；7份自写情景用原生JS＋假fetch对照；GDB/Nacos/weather冻结回归通过。真实页面全链仍未完成。[验证](release-0.9.3.md)。

## 0.9.2 / 插件0.7.1

- 新增 inspect-only 固定仓库构建计划，检查脚本、输入路径/大小、锁文件与工具冲突；不启动 Docker 或安装依赖。
- esbuild Linux 平台包可显式固定版本/SHA512补充，核对原锁父包声明与平台锁定项，严格有界解包并单列回执；不更改原锁或运行安装脚本。
- 独立公开 Vite 无 map 首测前冻结预期，未调提取规则：2业务发送位置/4种URL参数形态通过；资源预加载未知地址另列，52行条件/上下文候选不计为52个API。
- 提取器286项通过，GDB/Nacos定向回归和真实重复构建/Excel通过；插件保持0.7.1。[验证与限制](release-0.9.2.md)。

## 0.9.1 / 插件0.7.1

- 修复嵌套Webpack表污染/虚拟作用域、CJS别名、interop及原始位置关联；固定哈希库契约以参考版本恢复调用处候选，安装版本和transport仍未证明。
- 增加明确this、数组中间件、条件Object.assign与优先入口配额；构建JS总字节预算和不读取旧派生模块。
- GDB无map3发送点/4候选、Nacos真实wrapper1位置/4候选通过；冻结输入与复跑工具提交，外部代码/产物只留work。
- 表格/UI区分函数库存与入口链，Excel压缩且XML不变；提取器279、插件155项，完整MV3仍受策略阻断。[验证](release-0.9.1.md)。

## 0.9.0 / 插件0.7.0

- 新增统一Schema2.0/Excel、真实插件包导入、JS资产收集与快照导入、本地分析服务和插件JS探索。
- 新增jQuery、受限call/apply/reduce、普通类/显式AngularJS DI、表单与未应用hook字段候选。
- 有限Webpack4/5模块/分块适配、精确STS/RAM SDK模型及OpenAI兼容字段释义；未知版本/参数/副作用不提升为已确认请求。
- 真实Vue/Vite及固定pnpm/Yarn构建通过；SDK61操作离线对照、Ant Pro16候选验证通过。公开GDB无map与Nacos页面全链尚未通过，AI质量/真实站点/MV3现场待验收。[使用和限制](release-0.9.md)、[基准](../validation/validation-0.9.md)。

## 0.8.3

- 冻结 GDB/Nacos/OSS 的有限外部源码切片 manifest 与人工字段/条件预期；新增 verify:external CLI，隔离冻结文件后核对逐条结果，独立保留 validationPassed/extractionComplete。
- 修复未知配置把未解析 Query/Body/Header 显示为无字段的问题，保留载体未知；显式覆盖和已知缺省仍区分。
- 193 项测试通过；固定上游 11 文件哈希一致，18 个限定发送位置/22 条候选预期通过，但提取完整性均 false。清单 P0-04 勾选，独立盲测仍待推进，见[外部基准验证](../../internals/validation/external-baselines.md)。

## 0.8.2

- 增加持续维护的[实施清单](../planning/implementation-through-0.10.md)，限定完成项逐项勾选，整阶段未完成保持待办。
- 新增手工预期/哈希/config 微型基准及复跑命令；新增逐调用请求差异 CLI，报告新增/丢失/变化/变未知/歧义及报告级状态变化。
- 180 项测试通过；GDB 同版 4 行逐项一致，旧预算/缺口保留。这是历史回归，外部人工切片与独立验证集仍待建立，见[验证](../../internals/validation/baselines.md)。

## 0.8.1

- 仓库 CLI/profile 支持可选部署页面 URL，按浏览器 URL 规则解析静态相对地址。请求表保留原始 URL、解析 URL、部署基址、Host 依据和状态。
- 代码 Host 与上下文候选独立标记；动态地址、冲突、不支持协议保留缺口，不把部署假设提升为实际请求。解析 URL 不合并 Query 配置或证明最终序列化。
- 170 项测试通过；复用固定 Commit 的真实 GDB 构建产物重新分析，4 行/3 个发送位置保持一致，示例上下文下 4 行 Host 均为明确标记的候选，见[验证](../../internals/analysis/deployment-context.md)。未重新构建或访问业务 API。

## 0.8.0

- 新增 repository CLI：固定 GitHub Commit、npm/Docker 构建、锁文件/镜像/日志记录和产物清单；GDB Console 有开箱可复现的配置。
- source-map 关联应用源码和产物发送位置，按内容哈希/路径约束归属；保留 vendor、未映射/冲突和预算缺口。无 map 只做原生产物尝试，不切换源码成功。
- 新增逐调用 CSV/Markdown 请求表与完整 JSON；构建失败没有成功表格。修复真实应用暴露的数组 length 和实参候选超限异常。
- 162 项测试通过；真实 GDB 构建得到 4 个 JS、21 个应用 source、3 个发送位置/4 行候选，见[请求表](../validation/gdb-build-pilot.md)。部署 Host、vendor 完整性和 AI 仍有缺口。

## 0.7.0

- 可选 modelRequestHooks，默认关闭；有限显式同步 Axios request hook 按逆注册顺序求值，支持已知 eject/clear 与实例隔离。
- usage.afterRequestHooks 独立保存后阶段候选、执行次序和缺口，不覆盖调用处；JSON 输入字段与编码后字段分开。
- 异步/条件/未知控制、捕获堆、defaults 改写等保守未知；预算中断保留调用处记录，Markdown 分阶段展示。
- 146 项测试通过；新增 22 项，真实 Axios 1.7.9 本地 adapter 对照通过。Nacos 原始记录保留，其复杂 hook 仍未还原，见[验证](../../internals/analysis/request-hooks.md)。

## 0.6.0

- 分离引用选择和发送快照，修复属性读取、对象构造与传参丢失别名/副作用。
- 增加 delete、属性 +=、Object.assign 覆盖证据；未知键/外部调用/条件函数副作用降级，JSON 保存快照。
- usage.objectChanges 记录位置、条件、载体与前后值，单对象 128 条历史上限，截断有诊断。
- 124 项测试通过，含 25 项新增用例及带哈希/人工预期的微型样例；Nacos/GDB 关键结果保留。hook、DI 和 SDK 全链路仍待支持，见[验证](../../internals/analysis/object-effects.md)。

## 0.5.0

- 求值预算按入口/已知可达补漏资产分区，跨文件调用计入当前入口；局部中断后继续扫描其他分区。
- maxSteps 成为不超额的硬上限；新增可选 maxStepsPerFile，默认 null。JSON/Markdown 保留分区配额、实际步数、中断与未扫描状态。
- 同一 Nacos 13 文件默认库存扫描由 3 个发送位置增至 23 个；Host、hook 与页面链路缺口仍保留，OSS SDK 未恢复。
- 99 项自动化测试通过；分配规则和固定样本对照见 [budgets.md](../../internals/analysis/budgets.md)。

## 0.4.0

- 本地动态 ESM import/await/then 继续解析导出与参数，输出一条已知资产引用路径。
- includeUnlinked/--include-unlinked 可按已知引用独立保留资产级候选，默认关闭；未知模块不自动下载，结果不混入已连通主表。
- 修复压缩逗号表达式遗漏发送点、短路赋值丢状态；可变捕获状态未绑定时明确未知。
- 88 项测试；新增 335 字节自写真实 esbuild 压缩分块。公开阿里云原 JS 与压缩 JS 均覆盖 3 个发送点、2 个方法/路径模板；国际站抓取仍被环境阻断，未宣称在线验收。

## 0.3.0

- 增加已识别 JS 的哈希、解析状态与模块引用记录；缺失/动态引用不被当成已获取资产。
- address 拆分 Host/origin、相对 URL/baseURL、路径及独立 Host 状态；原有 resolution 不代表运行时完整地址。
- 白名单静态处理 join/concat、字面量 atob/URI 编解码、JSON、Object.assign，不执行目标 eval 或加密代码。
- 参数字段标明 constructed/call-site；未知覆盖不伪装结构完整，加密输入字段不冒充网络字段。
- 静态检测直接 Axios request interceptor 注册及常见别名关联，保留位置并把后续变更标为未知；不宣称已模拟 hook。
- 70 项测试通过；补做固定版本 Nacos namespace API 的跨文件 hook 关联核查。

## 0.2.0

- 动态 if/三元/短路值保留有限候选，贯穿模板字符串、对象、实参和跨文件函数返回；输出 conditions 与每条 usage 的 resolution。
- 同一个 if 分支中的 URL/method 配对，分支对象复制保留局部别名关系；已返回的路径不继续执行。
- 新增 maxCandidates=16；候选组合、路径与静态遍历超限时明确诊断，不伪造完整结果。
- 新增 ofetch、Nuxt $fetch、ky/ky-universal、node-fetch/cross-fetch 请求适配，以及基础标准 URL/Request 构造解析。
- 支持静态实参展开、数组 map/forEach、静态数组 for-of、无标签 break/continue；其他循环采用带诊断的近似分析。
- 每个入口中已经追踪过的函数不再用未知实参重复发现；库存模式下独立 service 入口仍保留泛化路径。
- 内部类型改用 Symbol，避免业务 tag 数据冲突；循环对象可序列化为带原因的未知值。
- 测试由 33 项增加到 52 项，多框架验收预期接口由 12 个增加到 19 个。

输出对象保持 schemaVersion=1，并新增 usage.conditions、usage.resolution。旧版本中的未知动态分支可能改为多个 partial 接口；消费者应读取解析状态和条件，不能把接口数量增长当成业务新增接口。

## 0.1.0

初版 CLI、框架脚本适配、ESM/基础 CommonJS 追踪、自定义语义层、fetch/axios 请求识别、源码证据、JSON/Markdown 及多框架合成测试。
