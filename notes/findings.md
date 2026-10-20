# 方案研究与设计取舍

## 已有基础
- 已有总体方案、阿里云场景方案、Baxia 样本静态核查，以及白盒/AI Agent 初稿。
- 当前没有业务仓或真实站点的授权测试证据；早期轻量扫描器已移除，曾有的概念验证不能作为完整能力的证明。
- 上一轮已核对 CodeQL、Semgrep、Playwright、source map 与 DOJ 官方资料。复用已知链接，只有新增关键判断按需补查。

## 本轮重点
- 从“工具组合”推进到明确对象、证据、覆盖分母、调查流程、整改决策与运行机制。
- 深入处理 SDK 自动注入、远程配置、同域透传、数据变换、部署差异及区域和主体未知。
- AI 输出必须可追溯；形式化分析、模型判断、运行事实和法律判断使用不同状态。

## 审阅发现的关键缺口
- 旧稿把风险与“实际发生证据”相乘，可能把尚未观测的高影响路径排成低风险。新稿分开影响程度、事实可信度与补证优先级。
- “证据等级”不能是单一线性分数：源码存在、部署一致性、触发条件、字段流、接收区域、主体与访问需要独立状态。
- 需要区分语法命中、分析器构造的路径、已验证条件与实际运行，避免把静态候选写成语义可达。
- 依赖列表不能覆盖远程脚本/运行时配置；源码目录不能直接代表部署分母；同一 fetch 也可能发生在 SSR 服务端而非浏览器。
- 第三方脚本加载本身就有网络元数据，脚本执行权限与实际采集需分开；同域透传、凭证自动附带、URL hash 主动读取等应专项讨论。
- 模型多轮阅读或多个模型一致不能证明覆盖完整；需要枚举账本、可验证产物、明确停止条件和版本失效规则。
- 需要补抽样误判、差分实验副作用、整改业务损伤、供应商黑盒、历史数据处置、组织责任与成本约束。

## 本轮官方资料核验（2026-10-16）
- OWASP Third Party JavaScript Management：第三方脚本的远程更新、同页权限、标签管理器和 iframe/SRI 控制均需要纳入；dataLayer 本身不是权限隔离。来源：https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Javascript_Management_Cheat_Sheet.html
- MDN CORS：部分请求无需预检即可发送，响应不可读不能证明数据未出站。Cookie/凭证还受 fetch 配置与浏览器策略约束。来源：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- MDN Referrer Policy：跨域 referrer 的实际内容受策略影响，不能默认完整 URL 被自动发送；SDK 主动读取再上报另算。来源：https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Referrer_policy
- SLSA Provenance：可以借鉴构建输出到源代码/输入的关联思想，但证明构建来源不等于证明脚本没有采集。来源：https://slsa.dev/spec/v1.2/provenance
- Next.js 官方文档：组件图含服务端与客户端边界，客户端组件也可能参与初始服务端预渲染，不能只靠扩展名或 use client 字面判断请求归属。来源：https://nextjs.org/docs/app/getting-started/server-and-client-components
- CodeQL 官方文档：全局数据流可能有不可发生的路径，且资源成本更高；分析结果需保留条件与模型边界。来源：https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/
- W3C Privacy Principles 可作为最小化与用途限定的设计参考，不直接当成法律义务。来源：https://www.w3.org/TR/privacy-principles/
- MDN Set-Cookie：HttpOnly 阻止脚本直接读取，不阻止符合 cookie 规则的 JS 发起请求自动携带该 Cookie。来源：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- 本轮重读 DOJ 当前 Data Security 页面，页面列出的规则、FAQ 与指南作为合规团队复核入口；主方案不固化具体阈值或把任何浏览器出站直接称为违法。来源：https://www.justice.gov/nsd/data-security

## 设计决策
- 主方案采用“六本清单 + 逐边证据 + 调查队列 + 整改与复验”的流程，图数据库与多 Agent 并发均不是起步前提。
- 角色分工可由同一 Agent 顺序完成；多模型一致不当作事实证明，分工必须降低可量化工作量。
- 覆盖率按有界范围、版本、角色和数据流类型分别报告，不计算未经校准的总安全分数。
- 变换记录保留字段血缘；安全漏洞分析中的 sanitizer 不能直接等同隐私上的匿名化。
- 将代码静态结果、部署匹配、运行观察、接收/处理地区、主体与权限、政策结论分别建账。
- 额外补充预期数据流与事实数据流对照、减少前端不必要数据暴露、合成/差分实验与采样局限、历史数据处置和长尾专项研究池。

## 交叉审阅结论
- 已按仅仓库、仅 URL、SDK 载荷不透明、未触达页面、跨仓缺资料、区域与身份未知、Agent 幻觉、业务损伤及预算耗尽等情况检查方法出口。
- 主方案明确哪些只是设计/假设，未写成已完成业务审计或工具实现。
- 已核对四份主入口/关联文档的本地 Markdown 链接和围栏，无缺失链接或未闭合围栏；主方案有 20 个一级内容章节。

## 2026-10-17 深化问题
- 读取某字段、字段影响输出、可恢复表示进入请求、原值发送、接收方可实际关联，分别是不同主张。
- 静态连通图不能忽略对象实例/字段、互斥环境条件、时间顺序、序列化和异步状态。
- 不透明 SDK 存在观测不足的不可辨识性，不能靠重复模型推理填补缺少的事实。
- 整改应选择覆盖相关路径且业务损伤可接受的控制点，并对未知路径保留限制；仅在已知图上截断不证明全局安全。

## 2026-10-17 补充资料
- CodeQL flow state 文档支持把传播状态与值关联，说明可用更细状态处理部分净化/对象情况；本方案借用状态建模思路，不声称隐私模型可直接由默认查询完成。https://codeql.github.com/docs/codeql-language-guides/using-flow-labels-for-precise-data-flow-analysis/
- MDN JSON.stringify：replacer、toJSON 与可枚举属性规则可改变真实序列化结果；对象入参含某字段不能直接证明该字段进入请求。https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify
- Foxhound 项目说明其在 JS 引擎与 DOM 中跟踪 taint，具体 source/sink 和传播范围需要查对应实现；不引用宣传准确率作为本项目证据。https://github.com/SAP/project-foxhound
- W3C Trace Context 明确 traceparent/tracestate 不应携带个人敏感信息，并提示关联风险和跨域路径兼容性。审计关联本身需限制传播边界。https://www.w3.org/TR/trace-context/

## 2026-10-17 深化取舍
- 字段路径逐项核对对象实例、属性载体、条件一致性、时间、序列化和发送归属；保留数据影响、原值传输、可关联性与接收使用的区别。
- 白盒分析按共享机制归组，但只有相关行为有一致性证据才复用代表动态测试；仍核对组内已知调用者差异。
- 对队列/身份/同意/配置变化建立事件顺序；错误回退和多拦截器顺序纳入整改与复验。
- 黑盒 SDK 分级调查，围绕能改变整改决定的证据投入；不要求完整反混淆后才修复已确认的冗余字段。
- 候选图不是全部实际路径的完整上界，已知未查、机制不支持和资产缺失分别交接。
- 历史观察不因政策/版本变化被删除，当前适用性按依赖重新判断。
- 用未登记资产、不成立路径、不透明载荷、异步状态、观察失效、整改旁路和预算耗尽挑战体系本身。
