# 静态分析与引用发现设计

本文只定义分析算法、依据和限制，不另设产品路线或 CLI 首版目标。产品流程见[整体设计](design.md)，实现状态只在[计划](plan.md)维护；插件的远端分析目标、现有本机服务和 CLI 复用同一核心。原引用采集约定已合并至本文。

## 1. 输入、身份与上下文

目标支持连续到达的正文与证据，以已提交事件水位固定分析批次；解析不等待采集停止。核心读取固定正文及显式上下文，不执行目标 JS，不模拟完整应用，不主动调用候选 API。插件捕获快照是主输入；HAR、目录和旧 checkpoint 用于调试或重放，不要求用户先手工导出 HAR 才能使用插件。

正文按 SHA256 保存，身份还包含来源/位置、执行上下文和内容版本。同名文件不覆盖；同 URL 不等于同版，同正文不等于同上下文。解析缓存可按正文哈希复用，基址和配置分析必须按上下文隔离。互斥版本无法关联时分别分析并记缺口，不任选一个。

| 场景 | 资源引用基址 | API 请求基址 |
| --- | --- | --- |
| 页面外部 ESM | 当前模块最终 URL；适用页面 import map | 页面/文档的已知请求基址，不使用 CDN 域名 |
| 页面内联模块 | 文档基址与 import map | 该文档基址 |
| classic Worker 的 importScripts | Worker 主脚本最终 URL | Worker 主脚本最终 URL |
| module Worker 的 import | 当前模块 URL，不继承页面 import map | Worker 主脚本最终 URL |
| 仅知道脚本 URL、上下文不明 | 有依据的模块引用可解析；未知父链不猜层数 | null，不能回退到脚本来源或顶层页面 |

DOM 序列化、Network 响应正文、Debugger 源码是不同表示；未来接入更多入口也不能按 URL 覆盖版本或重复制造确定发送点。`capture_context` 与静态推断 Worker 上下文的实际字段见[协议](protocol.md)。

## 2. 引用图与深度

复用固定 jshound 的 imports.specifiers、chunkmap.analyse 和同一 Babel AST 补充引用位置；固定 Commit/许可见[第三方说明](../THIRD_PARTY_NOTICES.md)，外部工具对照见[开源实测](../../references/blackbox2-experiment/README.md)。递归发现不是本项目独有能力，重点是证据、范围、深度、恢复与正确归属。

| 形式 | 确定依据 | 保守边界 |
| --- | --- | --- |
| import/export、字面量 dynamic import | AST说明符、模块URL、适用import map | 动态表达式/未映射裸包名不猜下载路径 |
| Webpack/Vite | 受支持的表、builder、publicPath/模块基址 | 位置未暴露为null；缺基址表项仅候选，HTTP 200不证明版本 |
| HTML script/modulepreload/内联模块 | 声明和文档基址 | 只得到已加载脚本，不能证明它是第一层 |
| script.src | 绑定和语句顺序核验 | 普通 `.src` 不证明是 script 或实际插入 |
| Worker/importScripts | 构造目标、类型、词法绑定及执行上下文 | blob/data、动态目标、错误模式不自动转 HTTP；不注册 Service Worker |
| source map（待实现） | 与原脚本明确关联 | 源码只作附加证据，不沿任意 sources URL 遍历或重复统计 |

HTML/内联内容为 D0，文档直接外链及内联模块的外部导入为 D1，继续引用为 D2/D3；默认只补到 D3，仍登记 D4。已导入深层正文照常分析。无父链的脚本深度为 null；调试入口可用 `--seed-js` 明确指定种子，不能自动把全部已加载脚本当 D1。获取层数、打包内部模块层数与函数追踪预算分别计算。

图保留循环和多父边，以最短已知父链计算深度。新出现短链时重新评估先前超深度的边；同 URL 多版本形成歧义，不任选正文。import map 的精确/前缀/scopes/null 阻断必须先于本地回退解析，冲突映射留缺口。

引用位置与 API 位置不同：行号从 1 开始，列和 JS start/end 从 0 开始，使用 UTF-16 code units，并保留 BOM 位移。内联引用保留局部偏移并还原 HTML 行列；上游 builder 不暴露位置时保持 null，不能由 URL 字符串匹配捏造发送点。

## 3. 获取、预算与恢复

产品中核心返回引用线索，插件决定并执行允许范围内的补抓，分析服务不代替插件访问站点。当前插件尚无该补抓闭环；CLI 的显式 `--fetch-js` 是已有实验能力，不能视作插件已经支持登录态补抓。

已有 CLI 逻辑可供插件后续适配：按最短层数有界分批、同上下文/URL 合并重复和在途请求，不同上下文不共用响应；逐跳检查精确 origin，认证仅来自该 origin 显式会话配置。不从 HAR 自动复制 Cookie/Authorization，不跨域继承认证；保持代理和 TLS 校验。

读取前预留共享字节额度，完成读取后归还未用部分，无法观测的失败读取保守计费。只接收完整且符合脚本类型的正文：403、错误 MIME、登录 HTML、截断及预算分别记缺口。未知长度恰好耗尽额度却无法证明 EOF 时不收录。计费是应用读取正文，非网卡流量；头部、错误响应正文和预缓冲不在该计数内。

HTTP 线程只获取，主线程提交完整资产和原子 checkpoint。截止或取消后停止派发并排空在途任务，保留完成正文；连接/头部读取受剩余 socket 超时约束，不承诺强制中断任意系统 DNS 阻塞。checkpoint 恢复先验证路径、正文 SHA 和资产身份，重新计算引用状态、允许重试上轮失败；不恢复半截 HTTP 字节，也不证明补取与原 HAR 同版。

实际上限及参数只有一个来源：[协议预算表](protocol.md#原型预算来源)和[命令行用法](plugin.md#命令行调试与重放)。不再另列未压测的推荐默认值。

## 4. Worker 与动态 script 的限定适配

Worker/SharedWorker 字面量构造或 `new URL(literal, import.meta.url)` 需未被本地绑定遮蔽，classic/module 类型可确定；每个静态创建位置建立独立推断上下文。根脚本重定向后使用最终 URL；嵌套 Worker 受获取深度/资产预算限制，不无限复制上下文。静态构造不证明真实创建次数、SharedWorker 的运行复用或浏览器 CORS/CSP 可执行性。

classic Worker 内只提升已核验全局 importScripts 的字面量，module Worker 中的 importScripts 留候选；classic Worker 中静态 module import/export 也不冒充可执行语法。无歧义导入正文可关联进 Worker 上下文，原观察保留，关联资产另计；多个历史版本不任选，也不用新 GET 消除旧版歧义。

动态 script 仅提升同一语句列表内连续的 `const s=document.createElement('script'); s.src='...'; document.head.appendChild(s);` 等已实现模式：const绑定唯一、无逃逸、单次 src 写入、全局 document 未遮蔽；也支持 body/documentElement 和 append。复合赋值、重复写入、其他 `.src`、Worker 中 DOM 调用或未知表达式均保留候选。此证据只证明静态引用，不证明实际执行了插入。

## 5. 请求分析基线与目标增强

目前调用固定引擎的 analyze_with_paths 并保留原始内部记录，不经有损 requests.jsonl 转换。上游可能归并位置，部分导出丢 Query、把非请求记录转换为 GET，所以“原生一条记录”只能映射为文件级候选。route/模型/字符串线索不当确认发送点；字段类型和表达式不当实际值。现有单段相对 `fetch('orders')` 等缺口必须保留，不能外推简单样例覆盖任意封装。

后续增强在可访问 fork 内进行，外围适配不能恢复上游已丢失的信息：

| 核心模块 | 算法目标 | 验证重点 |
| --- | --- | --- |
| A01 模块身份 | 词法绑定、ESM导入导出；打包模块号带runtime命名空间 | 同名文件/同模块号/跨版本隔离，输入顺序不改变确定结果 |
| A02 发送绑定 | 未遮蔽fetch、XHR open/send配对、beacon；Axios按模块/实现适配 | 普通client.get/request不误认；库调用与底层传输关联但不重复计数 |
| A03 调用摘要 | 仅追踪相关参数、返回、闭包和副作用；缓存含绑定、实例与上下文 | 同wrapper两次调用、两个client、跨文件、循环/递归不串线；预算耗尽降级 |
| A04 定向字段 | 对URL/Host/四载体反向依赖，在已证明控制流内有序合成 | 默认值、spread、覆盖/删除、append/set、序列化与hook按语言/库顺序处理 |

例如两 client 分别带不同 baseURL，同一 `send(client,body)` 的两个调用分别传 userId 和 orderId，不能把两字段做并集，也不能传播另一个实例的 Header。未知调用/异步副作用只在有依据时限定影响；影响范围不明就扩大相应载体缺口，不能仍断言完整。动态字段值不自动使字段名未知。

原始压缩 JS 是主要位置，source map 是附加位置。SDK 无业务调用者也可能自行发送，不能因此忽略；上层业务调用可关联时保留，无法证明不补造。WebSocket/EventSource、GraphQL/RPC 等未完整适配的机制单列缺口，不混成 REST。

## 6. 结果与统计语义

当前字段名和计数以[协议](protocol.md)为准。未来正式分组需冻结规则版本：有证据的 scheme/authority、Method、路径/模板及条件/参数变体；未知地址不强合并，不一律将数字路径变成占位符。

接口组数、调用上下文数、唯一发送位置数和每 JS 的关联数是不同指标，后者相加不等于接口总数。没有位置/绑定/上下文证据时继续候选并使用 null，不以 0 掩盖未计算。实测次数来自黑盒一，不加入静态计数。同 URL 的多路结果可以关联展示，但不是同版/同参数/真实发送的自动证明。

没有全站分母就不报全站覆盖率。冻结样本、准确率/召回的分子分母及故障矩阵见[测试规则](testing.md)，不把候选数量增加或公开 bundle 兼容性通过当作召回提升。

远端持续解析的缓存键、缺依赖状态和受影响重分析设计见[架构](architecture.md#6-持续采集与远端处理目标未实现)。JS加载栈是运行时加载证据，不替代模块/发送绑定；跨文件正文齐全也不能保证动态配置、闭包或未知副作用自动解析清楚。
