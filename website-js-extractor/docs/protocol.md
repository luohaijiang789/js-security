# 黑盒二结果与补取协议 0.5

0.5 增加浏览器 capture-0.1 输入及 capture_context，继续保留并发预算、Worker 上下文与动态 script 引用；不等同于已完成全量 API 统计。进度只在[执行计划](plan.md)维护。

## 输入

插件提交冻结的 capture-0.1 快照给 /v0，服务离线调用同一核心。CLI 调试/重放另接收 capture、已保存目录、含正文 HAR 或已验证的 0.2/0.3/0.4/0.5 collection checkpoint，输出新目录。默认不联网；只有显式 `--fetch-js` 加精确 origin 才补取确定脚本引用，不执行输入 JS，不从 API 候选生成探测请求。目录只读取普通 JS/HTML 文件，不跟随符号链接；URL/页面上下文缺失时保持未知。HAR 只接收成功的脚本/页面正文，支持明确 Base64；记录缺正文、无效编码、错误状态及未知执行上下文。HAR 中业务 API 请求次数不参与静态接口统计。

目录可读取 `_origin.jsonl` 的 f/u/d 映射，禁止以它读取输入根外文件。`.cjs` 暂未被固定引擎枚举，单列不支持；文本仅无损支持 UTF-8/BOM。查询串脚本、本地 URL 路径无法安全映射等情况分别保留正文，但模块身份关联记部分，不能声称跨模块链已完整恢复。

正文按 SHA256 保存，Asset ID 还包含来源 URL/输入位置/页面/版本身份。相同正文可共享存储，但原始地址、上下文和版本不合并。HTML 与 JS 的扩展名不能代替响应正文检查，200 登录 HTML 不作 JS。多页面和同 URL 多版本分组分析；互斥版本无法关联时分别分析并记跨文件关联受限，不能任取版本混析。

## 输出

| 对象 | 必需内容 |
| --- | --- |
| Task | schema_version、任务 ID、输入路径/哈希、工具版本/引擎 Commit、阶段、状态、停止原因 |
| Context | 页面/Worker 基址、证据来源、已知/未知状态 |
| Asset | ID、URL/输入相对路径、内容哈希、正文相对路径、类型、上下文、导入/分析状态 |
| AssetEdge | 父文件/哈希、引用类型与位置、目标表达式/解析基址、确定/结构化/候选、子资产 ID、最短深度及获取状态 |
| EngineRecord | 引擎内部原始 JSON，保留 Query/Body/Header、类型、配置、表达式及来源；不经有损 JSONL 转换 |
| RequestCandidate | ID、原始记录引用、静态来源、地址/方法/参数及状态、资产 ID、文件级证据、未知位置/调用上下文 |
| ApiGroupPreview | 可形成已知 Host/Method/路径键的候选分组，保留成员；未解析地址不强并，不能叫已确认接口数 |
| Gap | 类型、资产/候选引用、原因、影响、后续动作 |

文件：`analysis.json`、`engine-records.json`、`snapshot/`、`candidates.csv`、`parameters.csv`、`assets.csv`、`references.csv`、`gaps.csv`，以及 `collection.json` 与 `discovery/` 原始发现证据。JSON 是完整底稿，CSV 为预览，所有外部文本按文本转义。正文文件与 JSON 的关系用 ID/相对路径，不含执行指令。

## 字段与计数规则

- 读取原始 `template`、`query_schema`、`body_schema/body_shape/body_keys` 与 `req_headers`，同时保留完整原始记录。字段名、类型表达式和实际值分别表达；缺少结构不能当作空结构。
- 只把引擎请求类型映射成请求候选；route/字符串/模型/配置记录保留为底稿，不调用会将 route 改成 GET 的导出转换。GraphQL/RPC 未完整适配时明确记缺口。
- 相对请求只在页面/Worker 基址及发送语义有依据时还原，不能使用 JS CDN 域名填 Host。未知 Method 不默认 GET。
- 原生引擎已可能跨位置归并，因此一个输出候选代表一条原生引擎记录，不代表一个调用或唯一发送点。当前 `send_site` 和 `call_context` 仍未知，精确位置缺口必须可见。
- 预览按已知 scheme/authority + Method + 有证据的路径模板分组。候选预览、未解析数可提供；已确认接口数、精确调用数/发送点数使用 null，不能以 0 掩盖尚未计算。
- 所有结论只针对已导入/已分析资产；不报告全站覆盖率，不将一次运行成功等同于所有 API 已找到。

## 引擎与错误

固定 jshound Commit `f34f9c5dcfa0f30816a66881ea9a8d8573c24f05`，MIT。从独立子进程调用离线 `analyze_with_paths`，检查锁定路径版本，不修改子模块；原始 JS 不由 Node 执行。超时必须终止引擎进程组，保留已导入快照和失败原因，避免子进程继续运行。分析不是进程安全隔离沙箱。

退出码：0=已有资产处理完成（仍可有分析模型/定位缺口）；2=输入/配置错误；3=依赖/版本/引擎失败；4=输入不完整、未分析或超时的部分结果。空目录不返回 0。输出目录已有文件时拒绝覆盖；失败也写任务状态（能创建输出时）。入口应打印阶段和最终缺口数。

## 引用、深度与恢复

`AssetEdge.status` 分别表示 available（已关联正文，不等于解析成功）、candidate（推测，不自动补取）、unresolved、ambiguous_version、unknown_depth、missing_offline、depth_limit、范围/网络/响应/预算失败。资产的 analysis_status 独立记录解析情况，不能用边的 available 冒充分析成功。引用行列/偏移有依据才填写；旧式上游 builder 未暴露的位置为 null。

HTML 为 0，直接外链为 1，后续确定引用加一；已取得的深层资产照常分析。候选不建立确定层级；未知父链保持 null。短路径晚到时重新计算，循环/多父复用资产但不删除边。裸目录可保留 reference_url 的推导依据，与原始观察 URL 分开；import map 阻断不能回退到同名本地文件。

补取记录保留请求 URL、GET、状态、重试与时间，不保存 session 请求头值。重定向逐跳校验 origin，认证不跨域继承。只接受完整 JS 正文；错误 MIME/HTML/短响应不能当脚本成功。字节与文件预算包含失败尝试的成本，精确说明见[执行约定](analysis-design.md)。默认并发为 4（可设 1–32），同上下文/URL 合并请求与结果；不同上下文分开。停止调度后回收在途线程，保存已完成正文；连接/头部读取由剩余 socket 超时约束，不承诺中断任意系统 DNS 阻塞。

`analysis.json` 与 `collection.json` 的 `fetch_statistics` 为本轮采集计数，离线时为 null，恢复不累加上轮网络成本：

| 字段 | 含义 |
| --- | --- |
| file_attempts | 获准尝试的不同根脚本数；重试/重定向不重复计，拒绝派发不计 |
| complete_response_bodies | 传输层已完整取得且通过 MIME 检查的正文数；后续快照仍可能因 HTML/编码等拒收 |
| body_bytes_observed | 应用成功读取的正文总字节，含未入库的部分响应 |
| body_bytes_charged | 已读取字节加无法观测失败读取的保守预留计费 |
| body_byte_limit | 输入总字节预算扣除采集开始前已导入正文后的额度 |
| reserved_bytes / peak_charged_and_reserved | 在途读取预留 / 累计计费加预留的峰值，峰值不超过额度 |
| active_requests / peak_active_requests | 正在连接或读取正文的请求数 / 峰值；不含等待共享 Future 的线程 |
| cancelled | 是否触发采集取消；超时可能通过单请求错误返回，不必为 true |

线程只负责获取，主线程更新资产与 checkpoint。结果返回时在途请求和预留为 0；并发事件按起始顺序编号，不保证完成顺序或资产数组顺序。未知长度恰好耗尽额度且无法证明 EOF 时不收录；共享结果（含失败）仅在本轮、同上下文中复用，恢复后允许重试失败。字节计数不含 HTTP 头、错误响应正文或 socket 预缓冲，不代表网络流量。重定向、重试另由 `fetch_events` 回查。

collection checkpoint 原子保存正文相对路径/哈希/身份、图和导入缺口。恢复验证路径不逃出来源目录、正文哈希与资产身份；重新计算本轮引用状态，保留原始输入缺口，不保留上轮暂时性网络失败为已解决事实。新补取与旧 HAR 的版本关联未知，不因 URL 相同升级置信度。

精确位置、正式统计与 Excel 尚未实现。不得默认联网或恢复已删除白盒后端。


## Worker 上下文与 script 插入

`AssetEdge.context_id` 是父执行上下文，`target_context_id` 是子上下文；Worker 构造建立新上下文，普通引用沿用父上下文。Worker 的类型、classic/module、创建边、创建者上下文、原页面和最终主脚本 URL 保存在资产的 `execution_context`，恢复时验证类型/基址/身份和同上下文元数据一致。Context 的 `evidence=static_worker_constructor` 表示静态推断，不是运行观察；一个创建位置不代表一个运行实例，SharedWorker 也未做浏览器运行时合并。

Worker 的相对请求和 importScripts 用主脚本最终 URL；模块导入用当前模块 URL。不同创建位置分开分析，不继承页面 import map；未知构造/类型、遮蔽绑定及 Worker 模式不适用的语法保留候选。Worker URL 的 blob/data 不转为 HTTP 请求，不执行 Service Worker 注册，也不证明 CORS/CSP/同源条件已满足。

导入正文在原页面上下文中保留，可按明确引用复制到 Worker 推断上下文并记录 `associated_asset_id` 与 `acquisition=worker-association`；`associated_assets` 单列，不混入 `imported_assets` 或 `supplemented_assets`。同 URL 多版本不任选；保留原观察可能产生两套文件级候选，正式接口数仍为 null。推断关联也受输入资产数和累计正文字节预算，嵌套创建受获取深度约束。网络字节额度按采集开始时冻结的剩余预算计算，关联不扩大该额度；关联占用输入预算可能使后续完整响应在入库时被拒绝并记缺口。

动态 script 仅把经 Babel 绑定和连续语句核验的创建/src/插入模式标 `structured`，其他 src 赋值继续候选；原生 API 被运行时替换、任意别名/DOM 封装不在本轮证明范围。source map 尚未实现，Worker 测试通过不能代替 source map 或浏览器子目标现场验收。


## 浏览器原型输入与服务

`--capture` 接收 capture-0.1 的完整 JS 正文、SHA256、上下文和采集缺口；先验证大小、哈希及同 context_key 的基址一致性，再导入。未知上下文禁止附带猜测基址。Asset.capture_context 为浏览器静态观察，request_base_url 由此保留（包括 null），不能回退到页面或 CDN 地址猜 Host。0.5 checkpoint 保留此字段，旧 0.4 读取器必须拒绝新版本，避免丢失基址语义；本版本仍可恢复 0.2–0.4。

HTTP 原型 /v0/capabilities、/v0/jobs、/v0/jobs/{id}、result/cancel 路由仅接收 loopback + 精确扩展 Origin + 随机密钥。capabilities.protocol=capture-0.1、result_schema=0.5、offline_only=true。不是正式 /v1，也不替代持久任务、分块上传或完整配对协议。只接收有界正文，不接受待下载 URL 或命令。详见[插件说明](plugin.md)。

## capture-0.1 最小输入例子

以下是校验结构示例，不表示源码已执行；实际 content/sha256 必须匹配。完整前端类型见 [model.ts](../extension/src/model.ts)，接收端约束见 [capture.py](../src/website_js_extractor/capture.py)。

```json
{
  "schema_version": "capture-0.1",
  "snapshot_id": "example-snapshot",
  "task_id": "example-task",
  "frozen_at": "2026-11-02T00:00:00Z",
  "assets": [{
    "id": "example-observation", "task_id": "example-task",
    "url": "https://cdn.example.test/empty.js",
    "location": "capture/1.js", "content": "",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "bytes": 0, "context_key": "tab-session-document-generation",
    "context": {"type": "page", "page_url": "https://app.example.test/", "request_base_url": "https://app.example.test/", "evidence": "cdp_document_base"},
    "capture_url": "https://cdn.example.test/empty.js", "script_id": "1",
    "captured_at": "2026-11-02T00:00:00Z"
  }],
  "gaps": []
}
```

插件实际序列化的观察字段如上；接收器强制检查 schema/任务与快照标识、正文/哈希、上下文、数量/大小和缺口结构，不能把未校验字段称为完整事实证明。未知上下文用 type=unknown、page_url=null、request_base_url=null；匿名/blob/sourceURL 无可靠外部URL时 asset.url=null，原来源单独保留。相同 context_key 的规范化基址冲突必须拒绝。

## 当前 /v0 路由

所有路由要求精确扩展 Origin、对应 loopback Host 和 `Authorization: Bearer <本次密钥>`；OPTIONS仅校验Origin/Host并返回限定的预检许可，不返回任务。密钥生成/填写方式见[使用说明](plugin.md)。

| 方法/路径 | 成功结果 | 错误/状态语义 |
| --- | --- | --- |
| GET /v0/capabilities | 200，protocol、result_schema、max_upload_bytes、offline_only | 版本不匹配客户端拒绝继续 |
| POST /v0/jobs | 202，id、snapshot_id、input_sha256、status、error、exit_code | 有界application/json+Content-Length；同snapshot_id同内容返回原作业，改内容拒绝 |
| GET /v0/jobs/{id} | 200，作业状态 | queued/running/completed/partial/failed/cancelled/interrupted |
| GET /v0/jobs/{id}/result | 200，analysis.json | 只对completed/partial返回；未就绪400，未知作业404 |
| POST /v0/jobs/{id}/cancel | 202，作业记录 | 请求取消，不保证响应时已排空；后续查询终态，不删除输入 |

鉴权/Origin/Host失败403；输入、哈希、幂等冲突400；上传字节超限413；未知路由/作业404；本地存储失败500。当前错误是 `{ "error": "..." }`，尚无正式 code/retryable 协议。退出码0/4分别映射completed/partial；其他失败不冒充无API。部分运行还会有结果范围缺口，不能从completed推断全站成功。

## 原型预算来源

下表只描述当前代码，不是生产性能承诺；CLI实验的参数和默认值见[命令行用法](plugin.md#命令行调试与重放)。插件/服务/CLI额度不是同一计数器，不能混用。

| 层/来源 | 当前上限或行为 |
| --- | --- |
| [插件model](../extension/src/model.ts) | 单任务300个源码观察、单正文2 MiB、累计12 MiB、60个目标、500个会话源码排队标识、200条逐项缺口（额外数量保留） |
| [Collector](../extension/src/capture.ts) | 读取并发2；单命令默认5秒；停止读取等待7秒，超时记缺口，仍需分离/持久化，不等于全动作7秒内完成 |
| [捕获输入校验](../src/website_js_extractor/capture.py) | 1–300个完整源码、单正文2 MiB、累计12 MiB；最多201条输入缺口含汇总 |
| [本机服务](../src/website_js_extractor/service.py) | JSON上传20 MiB；最多保存20个作业，单作业执行；发现40秒、引擎120秒、作业总180秒；HTTP结果读取64 MiB |

Job原型不支持相同快照新建多个独立run；要重跑需新snapshot_id。这是原型限制，不是未来AnalysisRun身份规则。服务重启对queued/running标interrupted，不自动重跑；意外崩溃的孤立进程回收尚待正式恢复验收。历史任务/快照清理和分块续传未实现。


## v1 已实现范围与仍缺能力

`capture-stream-1` 的正文对象、分块、事件幂等、持久ACK、分页回读和查询已经实现在 `receiver.py`，由统一插件 `remote-capture.ts` 调用。以下能力仍未实现，不能由现有接收闭环推断为已完成：

- 领域事件 schema：当前 `kind` 仍沿用 CDP 方法名，`data.cdp` 原样保留；尚未冻结 `ScriptObservation`、`JSLoadRequest`、`ExecutionContext`、`LoadInitiator/Stack`、`Gap` 等稳定对象及逐字段校验。
- 接收后的持续静态分析：服务端只存储/回读，尚未把事件转换成资产图、调用核心、产出候选和缺口。
- 增量索引、依赖失效、分析批次/水位、跨文件关联，以及实测请求与静态候选的独立关联。
- 正式TLS、项目级认证/隔离、配额、保留与垃圾回收；固定code只是协议匹配值，不是秘密凭证。
- 真实远端部署、长时间运行和MV3现场验收。

旧 `/v0` 仍只处理loopback整份capture-0.1快照，不接收v1增量事件；不能把 `/v0`、SLS转存和v1接收混成同一协议。

## 统一插件增量接收协议 v1（capture-stream-1）

新链路是`browser-extension/src/remote-capture.ts`→`website_js_extractor.receiver`；不复用/v0/SLS。远端模式的新JS、加载证据、ObservedRequest均不落浏览器本地数据库，旧JS库只保留删除兼容；本地仅配置/计数/缺口，接收code固定内置，不写入任务配置。没有磁盘待传或崩溃恢复保证。

所有数据路由前缀`/v1/projects/{project}`，默认项目default和固定code `blackbox-capture-v1`已内置；客户端自动发送`Authorization: Bearer blackbox-capture-v1`。不需要用户提供令牌、环境变量或扩展ID。默认允许各Origin预检，不使用Cookie；固定code只是协议匹配值，不宣称为秘密认证。服务支持HTTP/HTTPS客户端源地址，`server.py`默认监听0.0.0.0:8379；GET / 或 /health无需code即可检查status。默认启动不提供配对步骤。请求和响应均no-store，禁止重定向转发。

| 方法/路径 | 输入与确认 |
| --- | --- |
| GET `/objects/{sha256}?status` | 查询该项目完整对象的committed/bytes；未提交不表示存在 |
| PUT `/objects/{sha256}/chunks/{offset}` | 原始UTF-8字节，X-Object-Bytes总长、X-Chunk-SHA256；返回对象/offset/块哈希与durable=true |
| POST `/objects/{sha256}/commit` | `{bytes}`；校验连续完整块、总长、完整SHA-256和UTF-8，事务提交后返回committed/durable=true |
| POST `/events` | `{schema,event_json,event_sha256}`；超过1 MiB的事件先分块保存JSON，改传`event_object_sha256`与同一event_sha256 |
| GET `/events?scan_id=...&after=...&limit=50` | 全字段回读；next为服务端序号，has_more决定继续分页；summary=1仅回轻量摘要，UI使用此模式 |
| GET `/objects/{sha256}` | 只返回已提交对象字节；客户端重新校验哈希，正文不从未提交块读取 |

事件字段：id、scan_id、kind、time、tab_id（可选）、session_id、epoch、data、hash（有正文时）、status。正文按UTF-8字节哈希去重；事件id独立，相同内容跨页面/会话仍保留观察。相同事件ID和完全相同event_json幂等；不同payload冲突409。服务不删减data中字段，event_sha256绑定提交的完整JSON；ACK必须匹配schema/id/event_sha256/content_sha256且durable=true。引用JS正文时先验证对象已提交且data.source_bytes一致。损坏/缺块/缺对象/正文非法UTF-8/非有限数/重复JSON键不返回成功。

kind包括Debugger.scriptParsed、执行上下文生命周期、Script网络加载事件、ObservedRequest、TaskStarted和TaskCheckpoint。data.cdp保留JS采集所取得的原始CDP事件，另存规范化requestId/hop/loaderId/frameId/documentURL、initiator及解析的loading_stack。JS是Debugger解析文本，不是HTTP原始字节；network_match=unknown，连接epoch不能代替导航loaderId。time和已知标签URL在入队时捕获，tab URL不能冒充iframe/Worker基址。ObservedRequest的data.record保留原请求结构与原字段选择/截断配置；传输不再缩减字段。TaskStarted保存任务/配置，停止检查点保存计数/缺口，不把检查点视为远端分析完成。

预算：JS源码64 MiB、通用传输对象/单事件JSON128 MiB，分块256 KiB；普通事件包最多8 MiB，大事件用对象引用。JS元数据队列64事件/4 MiB，单次读源2秒，网络请求（含读响应）5秒，网络错误/408/429/5xx最多3次，无效ACK不得算成功；失败保留首份未确认数据在内存并暂停，同会话恢复时可重试。后续未处理窗口/队列溢出登记缺口；关闭/崩溃后无法找回。字节预算不等于RSS，CDP整串返回、JSON编码和哈希会有临时副本。分页除条数外还有4 MiB目标预算，超大单条可单独返回，UI使用摘要避免回读大记录。

服务端SQLite使用WAL和synchronous=FULL，块/完整对象/事件各自事务提交后确认；部署目录需持久磁盘。完整ACK不等于高可用/备份/无限容量或全站采集无遗漏。本轮只验证接收/回读，不自动触发静态分析、引用补抓或API访问。
