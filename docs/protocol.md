# 分类接收、持久待传与封账协议

当前wire schema为`capture-stream-2`，支持`delivery-ledger-1`、`content-integrity-1`、`recursive-analysis-1`、`delivery-window-1`、`raw-cdp-journal-1`、`raw-cdp-commands-1`能力，旧无transport事件仍可离线导入；新插件要求ACK包含传输序号，旧接收器不能冒充完成。旧/v0配对服务已删除。

## 地址与分类

服务器默认0.0.0.0:8379，插件填HTTP/HTTPS源地址，默认项目default、固定code黑盒联调匹配值；不按扩展ID配对。接口带内置Bearer code，当前不提供完整用户身份/多租户系统。

| category | 信息 |
| --- | --- |
| api_request | ObservedRequest和已选择的完整请求/响应字段 |
| js_source | Debugger源码观察及其服务端object_id |
| page_context | 页面/执行上下文与代次 |
| script_load | JS网络加载、重定向、initiator及可得异步栈 |
| raw_cdp | 原始CDP通知及四类命令发起/结果JSON、独立摘要、接收时间/配置/连接身份 |
| task | 任务开始、结束检查点、配置/统计/缺口 |

事件保留id/scan_id/kind/category/time/tab_id/session_id/epoch/data/object_id/status。数据的零值、false、空值、Unicode与数组不删减；任务字段选择和捕获缺失另外表达。

## 临时待传

数据库js-security-delivery-outbox当前版本4：entries保存未确认元数据，payloads保存对应完整事件/正文，ledgers保存传输计数，capture_counters保存按CDP事件种类的observed/dispatched/rejected计数，capture_journal和journal_ledgers保存未移交通知及账目。原子移交与崩溃重放见[原始日志](capture-journal.md)。v1未确认数据升级时事务迁移；恢复只读entries索引，逐项取payloads，不把全部正文装进内存。单纯采集计数不能重放原始CDP事件，启用原始日志后可重放已持久通知；持久化前崩溃仍可能丢失最后一小批计数，不能据此宣称全采集。事件快照、上传ID、接收地址作用域、连续序号与入队账目先提交，之后才联网；ACK后的条目删除与账目更新为同一严格事务。暂停/重启后先恢复补传，不将正文写入原requests/active档案。最多4096项/256MiB待确认数据，达到上限拒绝并记录Gap，不静默淘汰。

并发窗口协议见[有界并发与分析可见性](delivery-window.md)。新版插件协商delivery-window-1后最多4项并发（大项最多3），接收端允许连续前缀后64项乱序持久接收。累计确认与连续到齐分别展示；有缺口不封账，分析只读取固定水位的连续前缀。

每个事件附`transport={stream_id,sequence}`；每任务/服务器唯一流，序号从1连续增长。接收ACK包含schema、event_id、event_sha256、object_id、durable:true及transport的stream_id/sequence/event_bytes，客户端逐项校验。正文/事件SHA-256由浏览器先计算，服务端独立复算：块请求X-Chunk-SHA256，commit.expected_sha256，事件信封event_sha256。错误摘要返回422；客户端也拒绝格式合法但值不符的回执，保留待传。旧客户端可省略摘要，但不能据此声称端到端校验。

## HTTP路由

前缀`/v1/projects/default`：

| 方法/路由 | 语义 |
| --- | --- |
| GET /health（无前缀） | 存活、schema与能力 |
| PUT /uploads/{upload}/chunks/{offset} | 256KiB块，X-Object-Bytes声明总长；相同块幂等，冲突409 |
| POST /uploads/{upload}/commit | bytes/url/kind/expected_sha256；完整校验后返回object_id/bytes/committed/durable |
| POST /events | schema+event_json+event_sha256；大事件用event_object_id；身份/序号/对象引用原子持久 |
| GET /events?scan_id=…&after=…&limit=…&summary=1 | 持久事件分页，next/has_more；摘要不代替原始事件 |
| GET /events?scan_id=…&event_id=… | 当前任务下完整原始事件与摘要，跨任务404 |
| GET /objects/{object_id} | 完整UTF-8正文；?status查询存在/长度 |
| POST /streams/{stream}/seal | scan_id/count/categories/bytes与可选capture_journal；核对连续序号、分类、字节及事件/对象后封账 |
| GET /analyses?scan_id=… | 最近20个固定输入作业，pending和状态 |
| POST /analyses | scan_id；手动立即排队，返回202 |
| GET /analyses/{run}/result | status及固定analysis.json；完成、部分、失败分开 |

上传ID在崩溃后复用，完整提交回执也幂等。正文完整保存后可以释放本地source但保留待传事件；即使正文已保存、事件ACK丢失，重传也不重复增加真实次数。封账可幂等重试，已封账流拒绝新事件但允许旧事件同内容重放。

正文上限128MiB（插件JS读取64MiB）、块256KiB、事件上限128MiB，超过1MiB的事件正文走对象分块。禁止缺块/坏UTF-8/非有限JSON数/重复键冒充成功。接收持久ACK不代表分析完成。

## 分析与输出

默认静默2秒/最长10秒触发固定批次；任务结束立即排队。每run保留project/scan、水位种子manifest、资产analysis-manifest、引擎锁版本、原始输出和analysis.json。当前结果schema仍0.5，保留文件级候选，部分直接调用有AST核验位置；confirmed_api_groups/精确调用数未实现时保持null。

输出analysis.json、api_inventory.json/csv、observed_requests.json/csv、candidates/parameters/assets/references/gaps.csv及正文证据；Excel未实现。静态/实测匹配状态matched/static-only/observed-only只是保守关联，不证明同一次运行调用。

离线CLI继续支持HAR、JS/HTML目录、capture快照和可校验collection恢复。自动作业从TaskStarted/TaskCheckpoint.scan.config.analysis读取统一策略（缺省5层/补取开启），CLI ingest可用--max-js-depth、--offline、--allow-origin覆盖。后端仅递归获取JS资源，允许来源合并已观察来源与显式allowed_origins；未知CDN、登录资源、非字面量动态引用、超预算保留缺口。先生成analysis-manifest.json冻结正文/引用，再统一提取API；不访问分析所得业务API。Node/固定jshound缺失时作业失败可见，不伪装空成功。
