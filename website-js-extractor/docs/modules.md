# 模块规格与实现工作包

本文定义模块要做什么及怎样验收；代码语言、工程目录与执行链见[工程架构](architecture.md)。模块号用于拆开发任务，完成状态只在[实施计划](plan.md)打勾。每个模块的交付都包括实现、正反例、失败状态和使用/调试入口。

## 1. 模块清单

| ID / 模块 | 语言与目录 | 输入 → 输出 | 实现内容 | 模块完成条件 |
| --- | --- | --- | --- | --- |
| C01 协议与身份 | JSON Schema；contracts/ | 领域语义 → schema、生成类型、合法/非法例子 | 对象关系、身份、状态、路由、兼容与错误码 | TS/Python 同一批例子一致通过/拒绝；不存在两套手写协议 |
| E01 任务与目标 | TS；background/、capture/ | 开始/暂停/停止、Chrome 事件 → Task、Context、采集中断 | 所有窗口接入、新页面与导航、会话拥有权、代次与重连 | 单页失败隔离；关闭管理页不丢状态；冲突不抢占；真实 MV3 验证 |
| E02 正文采集 | TS；capture/ | Network/Debugger/DOM → AssetContent、AssetObservation、Gap | 当前脚本、持续事件、正文读取、表示类型、位置和内容哈希 | 三类正文入口可追溯；同 URL 变版、驱逐、缺正文与超限不混淆 |
| E03 引用与补抓 | TS；discovery/ | DOM 字面量或 A01 引用线索 → AssetEdge、获取任务、Gap | 范围、URL/重定向、深度、多父/循环、预算、幂等调度 | D0–D3 与已观察深层资产语义正确；只补抓已证明的静态资源 |
| E04 资产库与快照 | TS；storage/ | 正文、观察、上下文、事件截止点 → 不可变 manifest、离线包 | IndexedDB 分块、内容去重、原子快照、排空、配额、续传检查点 | 截止后事件进入新版本；缺块拒绝完整提交；重启保留已确认数据 |
| E05 服务适配与工作台 | TS/Vue；service-client/、ui/ | 本地任务/服务分页 → 控制、列表与右侧证据 | 配对、能力协商、断线重试、任务/资产/API/缺口、正文位置 | 不兼容不继续；列表分页；候选/未知可见；服务离线可导出包 |
| S01 HTTP 与配对 | Python；api/ | HTTP → 校验命令、分页结果、稳定错误 | loopback、配对令牌、Origin、schema、幂等、能力协商 | 普通网页不可提交任务；错误请求无任务副作用；凭证不导出 |
| S02 数据与包导入 | Python；storage/ | 块/manifest/离线包 → 已校验对象与持久关系 | SQLite、正文目录、哈希校验、原子提交、导入、迁移 | 断传/重复提交可恢复；路径越界、损坏包和版本不兼容被拒绝 |
| S03 分析作业与适配 | Python；tasks/、analyzer/ | snapshot + 分析配置 → run、原始结果、项目事实 | 排队、锁定核心、Node 进程、取消/超时、结果校验与缓存 | 不联网、不执行业务脚本；进程树可回收；重跑输入不变；失败不伪装空成功 |
| A01 资产与模块索引 | JS/Babel；jshound fork | 冻结资产/上下文 → 引用线索、ModuleGraph、BindingIndex | ES 模块、首批 Webpack/Vite 产物、chunk、import map、解析缺口 | 同名模块/文件隔离；缺模块可定位；索引不依赖批次顺序 |
| A02 发送点与绑定 | JS/Babel；jshound fork | AST/模块索引 → SendSite、候选、证据 | fetch/XHR/Axios/beacon、别名和遮蔽、库适配器、内部传输关联 | 同名普通函数不确认；库调用与实际传输有关联且不重复计数 |
| A03 调用摘要与变体 | JS/Babel；jshound fork | 发送点、绑定、调用/实例 → 有界摘要与 RequestVariant | 实参映射、返回/闭包、跨文件 wrapper、实例与条件隔离 | 两实例、同封装两调用不串线；五层及递归预算有明确结果/缺口 |
| A04 字段与改写 | JS/Babel；jshound fork | 变体、对象写入/阶段 → URL/Host/参数事实及 Gap | 定向值追踪、默认值、对象别名、覆盖/删除、hook、序列化 | 简单覆盖与未知影响正确；字段存在性和动态值分开；未知不冒充完整 |
| S04 结果与导出 | Python；export/ | 项目事实、证据引用 → JSON、Excel、证据包 | 三张 Sheet、记录/字段/缺口关联、长内容、分片、版本 | 与 UI 同源；确定字段可回查；不丢变体、不导出凭证、字符串按文本写入 |

模块可拆多个提交；不得以目录存在或接口返回空数组判定完成。S1/S2 原型只验收对应子能力，不能据此勾选整个模块。

## 2. C01：身份与事实模型

协议对象在 S0 建立最小 schema，S2 后冻结正式 v1。以下是不允许在编码时随意替换的语义：

| 对象 | 身份与关联规则 |
| --- | --- |
| Task | UUID；包含采集配置版本、范围、预算和状态，不等于服务进程 |
| Context | taskId + 采集代次 + 浏览器目标/执行上下文代次；导航后不能复用旧页面配置 |
| AssetContent | 精确保存表示的 SHA-256、字节数、编码/表示类型；同内容可去重，不能丢原始字节 |
| AssetObservation | 独立 ID；关联 content、来源 URL、Context、采集方式、时间、scriptId/requestId；同内容不同上下文保留多条 |
| AssetEdge | 父/子 observation 或未取得目标、引用位置/类型/基址、条件；深度由图计算，不只存首次发现层数 |
| Snapshot | UUID + manifestHash；固定 Context/Observation/Edge 版本和截止序号；引用发现轮次关联 parentSnapshotId |
| AnalysisRun | UUID；snapshotId + 配置哈希 + 核心/parser/模型版本；重试新建 run，不覆盖旧事实 |
| SendSite | 固定输入中资产表示、parser range、机制和绑定身份；跨运行比较另建关联，不靠 URL 去重 |
| RequestVariant | SendSite + 调用点链 + client/闭包实例抽象 + 条件；无法区分时标混合候选，不宣称一次具体发送 |
| Evidence / Gap | 独立 ID，引用资产/上下文/位置/字段或变体；缺脚本可以只有资产级缺口，不强行制造请求 |

Asset 是 content 与 observation 的关联视图；同 URL 不构成资产身份。位置至少有 parser range；行列从对应正文计算，source map 位置另存。证据片段是视图，完整正文才是定位依据。

字段至少包含 `expression`、`valueState`、`presence`、`certainty`、`evidenceIds`、`gapIds`、`conditions`、`stage`。presence 使用 required/optional/absent/unknown；certainty 使用 confirmed/partial/candidate/unknown；载体完整性使用 COMPLETE_WITHIN_MODEL/PARTIAL/UNKNOWN。动态值不自动使字段名未知；缺口指明可能影响哪些字段和完整性。

## 3. A01–A04：分析核心怎样实现

### A01 先恢复模块身份

先为每个正文解析 AST 与文件内词法绑定，再按已证明引用建立 ModuleGraph。ES import/export 通过所属模块和导出名解析；首批打包适配器针对冻结样本中的 Webpack runtime/chunk 与 Vite/Rollup ESM，不泛称支持所有版本。Webpack 模块号必须带 runtime 命名空间，不把不同页面的模块 `1` 当成同一模块。

相对引用用模块基址，API 相对地址用执行上下文；同名 basename 只能帮助发现候选，不足以确认跨文件绑定。无法解析 runtime 或动态模块名时保留缺边。source map 只辅助源位置，不复制成另一组线上发送点。

上游整目录索引是复用起点；需增加文件/模块/上下文身份验证。改变批次大小、worker 数或输入顺序不得改变确定结果。

### A02 从绑定确认发送行为

原生入口确认未被遮蔽的全局 fetch、XHR 实例及其 open/send 配对、navigator.sendBeacon。Axios 经模块来源或可验证实现/适配器绑定识别，压缩名字本身不是依据。依赖没有业务调用者仍分析其内部发送点。

普通 `client.get()`、不明 `request()`、`save(new URL(...))` 先归候选；只有调用链或受支持库模型证明网络行为才升级。库级 Axios 调用和底层 fetch/XHR 建关联，按请求变体去除重复视图，保留两处位置。

### A03 用摘要替代逐入口全程序展开

函数摘要记录参数占位、返回值、相关对象读写、调用到的发送点和未知副作用。调用点将实参替换进摘要；缓存键包含函数绑定、模块、参数抽象、实例、闭包配置和模型版本，不按函数名字共用。

对象/客户端用分配位置与有界调用上下文区分；同一工厂被不同调用者实例化时保留配置差异。上下文上限、分支上限、循环迭代上限在配置中显式记录；超过上限转成带影响范围的合并候选或未知，不能保留 confirmed 的完整结构。

递归调用按强连通分量迭代到不动点或预算上限。只追踪与 URL、参数和相关写入有关的依赖；资产获取 D3 不参与函数深度判断。

### A04 定向追踪与有序字段合成

值域至少区分常量、表达式/模板、有限条件候选、对象/数组结构与 unknown。对象属性以字段路径表示，保留别名与写入序号。对地址、载体和相关修改反向取依赖，再在已证明控制流内按顺序合成。

| 操作 | 结果规则 |
| --- | --- |
| `defaults` 与调用配置 | 按对应库版本模型的合成规则，不统一当浅层 Object.assign |
| `x.a = v` / `delete x.a` | 作用于已证明的对象身份；条件写入保留条件，删除影响 presence |
| `{...known, a: v}` | 按语言顺序展开与覆盖，不能并集所有键后丢顺序 |
| `{a: 1, ...unknown}` | a 的存在/值根据未知对象模型保守表达，不能继续断言值为 1；未知额外键影响结构完整性 |
| `URLSearchParams` / FormData | 保留 append/set/delete、重复键与顺序，不压成普通字典 |
| JSON.stringify | 记录输入结构与已知转换；未知 replacer/toJSON 影响对应字段 |
| Axios request hook | 依据已锁定版本的执行顺序与注册条件；同步不等于按注册正序执行 |
| 未知调用/异步修改 | 标可能写入的对象/字段；若影响范围不明则扩大相应载体缺口，不静默忽略 |

路径参数只报告有证据的动态段，不把所有字符串数字自动当业务参数。浏览器隐式 Cookie/自动 Header 不因源码未出现就宣称不存在；模型完整性限于可追踪显式结构。

### 最小正确性示例

```js
const a = axios.create({ baseURL: 'https://a.example', headers: { 'X-App': 'a' } });
const b = axios.create({ baseURL: 'https://b.example' });
function send(client, body) { return client.post('/save', body); }
send(a, { userId: id });
send(b, { orderId: order });
```

在 Axios 绑定已确认、无其他改写的受控样本里，必须形成两条变体：a 的 Host、Header 与 userId；b 的 Host 与 orderId。动态 id/order 不妨碍字段结构已知。不能生成两条都带 userId/orderId 的并集结果，不能把 a 的 Header 传播给 b。再加入未知 hook 的反例时，只将受影响部分降级并显示原因。

## 4. S01–S03：服务接口与执行约束

以下为待写入 C01 的 v1 路由基线，S0 用例冻结参数和响应；不是已经可调用的 API。

| 接口 | 用途与关键语义 |
| --- | --- |
| GET /v1/capabilities | 协议/核心版本、支持项与预算；不暴露任务数据 |
| POST /v1/pair | 本机一次性配对码换扩展凭证；过期、限次、绑定扩展 Origin |
| POST /v1/tasks | 以 clientTaskId 幂等创建任务，配置不可被重试悄悄改写 |
| PUT /v1/tasks/{t}/assets/{hash}/chunks/{n} | 分块提交；同块不同内容冲突；响应返回确认信息 |
| POST /v1/tasks/{t}/assets/{hash}/complete | 核对总长度、块清单与完整哈希后提交正文 |
| POST /v1/tasks/{t}/snapshots | 提交 manifest，引用正文不全时拒绝完整状态 |
| POST /v1/tasks/{t}/runs | snapshotId + phase(discover/analyze) + 配置创建 run；重试以幂等键区分 |
| GET /v1/tasks/{t}/runs/{r} | 作业阶段、计数、预算、失败/取消原因；不使用伪全站覆盖率 |
| POST /v1/tasks/{t}/runs/{r}/cancel | 取消指定 run，不停止其他收集或删除输入 |
| GET /v1/tasks/{t}/runs/{r}/{collection} | 按 cursor 读取 references/requests/evidence/gaps；每页绑定同一 run |
| POST /v1/imports | 校验并导入离线包，产生任务/快照映射；不执行或重新抓取资源 |
| POST /v1/tasks/{t}/exports | 指定 snapshot/run、格式和过滤视图生成导出作业；保留事实层 |
| GET /v1/tasks/{t}/exports/{e} | 导出作业状态、文件清单及鉴权下载入口 |

除能力查询和受限配对外，接口要求凭证；具体 CORS、预检及扩展权限必须在真实 MV3 验证。错误统一返回 code/message/retryable/objectIds；至少区分 schema不兼容、鉴权失败、块冲突、哈希不符、缺对象、预算耗尽与作业失败。重试不能把冲突当成功。

S03 输入包括已校验 manifest、只读正文目录、显式页面/模块上下文和配置。输出包含 core-version、输入哈希、处理资产清单、原始输出、事实记录及缺口；JSON 解析成功不等于分析完成。Python 验证位置范围、引用对象存在、字段状态和已处理资产账目后才提交 run 状态。

## 5. 怎么组织开发任务

每个实现任务须包含：模块 ID、限定用例、输入/输出例子、要修改的代码路径、依赖、正常/反例、演示步骤、完成标准和遗留缺口。任务大小以能独立提交并复核为准，不将“实现分析核心”作为单个开发任务。

例如 A03 的第一项任务是“单文件同一 wrapper 两次调用的实参隔离”，交付摘要替换与两条结果、字段不可互串的反例；下一项才扩到跨模块和客户端工厂。A04 的第一项是“单对象常量写入/覆盖/删除”，后续再加入别名、条件和 hook。

发现上游索引或归并破坏变体时，应在 fork 修正事实生成过程；外围适配器不能从丢失信息的结果恢复出虚假的精确证据。基线无法满足时，S2 必须给出修改范围和验证结果，再调整实现工作量，不能只增加候选数量过关。
