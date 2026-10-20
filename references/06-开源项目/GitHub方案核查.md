# GitHub 核查：哪些能力能用于 JS 跨境透传排查

> 核查：2026-10-20。范围：仓库 README、元数据及下面列出的固定提交源码片段。未安装、运行、做性能/兼容评测或选定生产方案。本文只记录本项目的取舍依据与待验证实验。

## 1. 调研由什么问题驱动

| 项目缺口 | 搜索与核查 | 当前得到什么 |
|---|---|---|
| 请求和字段无法追到脚本 | 搜索 web privacy measurement，查 OpenWPM 与 Tracker Radar Collector | 可借鉴记录身份/发起链/采集器生命周期；两者输出能力不能混用 |
| 读取是否传播到发送载荷 | 搜索 javascript taint / instrumentation，查 Foxhound 与 Jalangi2 | 动态 taint 或插桩证据可补充，source/sink/语法覆盖必须实测 |
| 公共 SDK/封装打断静态路径 | 查 CodeQL JS 数据流库与摘要实现 | 研究输入/输出摘要，仍需为注入、队列与具体框架建模 |

发现时还看到隐私测量 fork、原型和 archived 项目；未因搜索命中或星数将其纳入优先实施。搜索词、主仓库归属与状态均通过 GitHub CLI 实际查询。

## 2. 五个候选的具体取舍

### A. OpenWPM：研究观察数据模型

源码：[schema.sql](https://github.com/openwpm/OpenWPM/blob/4f81c3a94b80b6db0e7393d0700e72f4abf3bc80/openwpm/storage/schema.sql)；配置说明：[Configuration.md](https://github.com/openwpm/OpenWPM/blob/4f81c3a94b80b6db0e7393d0700e72f4abf3bc80/docs/Configuration.md)。

| 已核对 | 对本项目的意义 |
|---|---|
| schema 的 task/crawl/site_visits 与 crawl_history | 案件/访问/操作、失败与工具版本分开存，不丢失执行失败 |
| http_requests 的 headers、post_body、frame、request_id、req_call_stack 等字段 | 设计接口/字段观察与来源线索，不只保存域名 |
| javascript 记录脚本/位置/调用等信息 | API 访问线索可以辅助反查，不等于完整字段传播 |

**取舍：** 优先借鉴表结构与证据身份。采集开关、权限、可用 body/调用栈和 Firefox 与目标业务兼容性仍需试点验证，schema 有字段不保证每次都有值。

### B. Tracker Radar Collector：采集器设计可用，默认请求结果不足

源码：[RequestCollector](https://github.com/duckduckgo/tracker-radar-collector/blob/d6fddc5be322bf2d1ca295b03973991a4fee15a7/collectors/RequestCollector.js)、[APICallCollector](https://github.com/duckduckgo/tracker-radar-collector/blob/d6fddc5be322bf2d1ca295b03973991a4fee15a7/collectors/APICallCollector.js)；[README](https://github.com/duckduckgo/tracker-radar-collector/blob/d6fddc5be322bf2d1ca295b03973991a4fee15a7/README.md)。

| 已核对 | 本项目必须调整/验证 |
|---|---|
| RequestCollector 处理请求、发起链、重定向、失败与响应元数据 | 可研究事件归并；保持场景/target/请求身份 |
| getData 输出不含请求头与请求体 | 不能直接据此排查 header/query/body 全量字段；需补捕获、结构化与脱敏 |
| APICallCollector 用脚本/上下文/绑定与断点收集调用线索；不完整时会报错 | 借鉴“采集失败显式化”，不要把 API 统计等同污点血缘 |
| README 有 only-3p/filterOutFirstParty 和额外等待配置 | 本项目必须保留本方业务 API，等待窗口按业务/队列定义；自带干预也要标注 |

**取舍：** 黑盒模块结构候选，非开箱即用的跨境透传审计器。不把接口名中“Request”当作完整载荷保证。

### C. Foxhound：动态传播专项候选

文档：[sources/sinks 清单](https://github.com/SAP/project-foxhound/blob/d66bda90812e9a4e50d2dc8ac36cb3068e73f977/taint/README.md)、[README](https://github.com/SAP/project-foxhound/blob/d66bda90812e9a4e50d2dc8ac36cb3068e73f977/README.md)。

已读清单列出 location、referrer、Cookie、input.value 等来源及若干资源、XHR/header、WebSocket、存储等 sink，部分 DOM 来源被注明禁用，README 给出 taint 报告事件。

**取舍：** 对“受控字符串能否到指定发送 sink”设计专项实验。清单是文档线索，实际构建行为仍需核查；尤其 fetch/Beacon、对象/二进制/加密、异步与目标浏览器差异不得默认覆盖。XSS 传播与隐私/匿名化判定也不是同一规则。

### D. Jalangi2：研究回调与源码定位，不直接选为现代站扫描主线

文档/源码：[README](https://github.com/Samsung/jalangi2/blob/bc879287b1678de6e3c423f5debe63207559525b/README.md)、[analysisCallbackTemplate](https://github.com/Samsung/jalangi2/blob/bc879287b1678de6e3c423f5debe63207559525b/src/js/runtime/analysisCallbackTemplate.js)。

模板描述函数调用、属性等回调，以及 sid/iid 与源码位置关系；回调可以观察也可改变执行。README 标明 ES5.1 支持，部分 ES6 未测试，依赖说明也需重新验证。

**取舍：** 借鉴“事件 → 指令/脚本 → 源码”的定位思路；当前仅列方法参考。现代语法、DOM/native 边界和插桩副作用未解决前，不作为默认运行方案。

### E. CodeQL：公共机制摘要的白盒候选

源码：[FlowSummary.qll](https://github.com/github/codeql/blob/887fc4b998f8ee724d8b081e32822d79b4820674/javascript/ql/lib/semmle/javascript/dataflow/FlowSummary.qll)；[README](https://github.com/github/codeql/blob/887fc4b998f8ee724d8b081e32822d79b4820674/README.md)。

源码提供函数输入/输出传播摘要，并区分保值与 taint 传播；支持数据扩展或更复杂的模型表达。

**取舍：** 研究 logger/SDK 参数到返回/载体的模型；请求匹配、共享状态、队列、动态配置与联合条件需要专门核验。默认安全查询不等于本项目隐私路径。查询库与 CLI/引擎许可分别检查。

## 3. 固定核查版本

| 仓库 | 提交 |
|---|---|
| openwpm/OpenWPM | `4f81c3a94b80b6db0e7393d0700e72f4abf3bc80` |
| duckduckgo/tracker-radar-collector | `d6fddc5be322bf2d1ca295b03973991a4fee15a7` |
| SAP/project-foxhound | `d66bda90812e9a4e50d2dc8ac36cb3068e73f977` |
| Samsung/jalangi2 | `bc879287b1678de6e3c423f5debe63207559525b` |
| github/codeql | `887fc4b998f8ee724d8b081e32822d79b4820674` |

读取范围：Tracker RequestCollector 全文件、APICallCollector 前 200 行；OpenWPM schema 前 230 行、配置前 180 行；Foxhound taint 文档前 200 行；Jalangi2 回调模板前 170 行；CodeQL FlowSummary 前 110 行及各 README。不将片段核查写成整个仓库审计。

## 4. 下一步需要验证的实验

| 编号 | 最小实验 | 成功/失败怎样改变选择 |
|---|---|---|
| GH-01 | 受控页面发出同域自定义头和 JSON body，含重定向、iframe/Worker 与 Beacon 变体 | 比较字段、身份与失败记录；不足的标清需扩展，不直接采用默认输出 |
| GH-02 | URL/input 合成字符串经复制、拼接、过滤进入指定网络 sink | Foxhound 验证实际来源/sink、过滤反例和已执行路径边界 |
| GH-03 | logger 跨文件封装与 SDK 注入，加入互斥配置和序列化过滤反例 | 评价 CodeQL 摘要/模型成本，确定哪些需要人工或其他能力 |
| GH-04 | 同一字段从观察定位到源码，再产生另一调用者场景 | 比较人工与 Agent 辅助的引用正确性、无效线索和耗时 |

这些实验均**未执行**；当前阶段仅定义规格，不创建扫描代码或安装候选。任务入口见[研究队列](../研究队列.md)与[workstreams](../../workstreams/README.md)。
