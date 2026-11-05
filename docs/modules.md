# 模块职责与完成边界

完整目录和依赖见[代码架构](code-architecture.md)，实施状态见[唯一计划](plan.md)。后端Python/SQLite，插件TypeScript/Vue/MV3，静态引擎固定jshound及Node/Babel。

| 模块 | 实际代码 | 输入→输出/完成条件 |
| --- | --- | --- |
| 统一采集 | browser-extension/src/background/、capture/ | 同一CDP会话→请求+响应+发起证据/栈组成的逻辑请求、JS观察、上下文；按种类计数，缺失/预算记Gap |
| 临时持久待传 | browser-extension/src/transport/、storage/evidence-db.ts | 事件/正文→元数据与正文分离的原子持久队列→分块/序号/摘要/ACK；重启逐项加载，ACK后原子清理 |
| 原始通知日志 | capture/journal.ts、storage/capture-journal.ts；domain/raw.py、ingestion/raw.py | 通知先持久→同事务移交→重放/原始摘要封账；后端关联请求响应栈，去重并保留缺口 |
| 领域契约 | src/website_js_extractor/domain/；browser-extension/src/domain/ | 协议、配置、资产身份；默认5层与预算独立，严格校验 |
| 分类接收与账目 | storage/capture_store.py、api/server.py | HTTP→独立摘要校验、不可变事件/对象、连续账目；仅持久后ACK，封账不符拒绝完成 |
| 自动分析编排 | application/jobs.py | 已持久水位→选中证据导出、阶段状态、恢复排队、结果；不在ACK路径收集/分析 |
| 输入适配 | ingestion/stream.py、ingestion/capture.py | 原始请求/JS观察→上下文隔离的统一快照，保留证据与缺口 |
| 递归收集 | collection/graph.py、fetcher.py、pipeline.py | 种子→默认D1至D5的引用/正文/缺口→analysis-manifest.json；允许来源、循环、多父、超层和重定向校验 |
| 静态核心与实测关联 | analysis/engine.py、worker.py、results.py | 冻结资产→jshound文件级API候选、API清单和导出；不合并真实次数/候选，不伪造精确调用位置 |
| 工作台 | browser-extension/src/ui/ | 地址、深度/CDN策略、账目/作业/API清单→控制与证据视图 |
| Agent与精确增强 | 尚无运行实现；见agent.md、analysis-design.md | 固定证据工具/核验、实例/调用/字段；不得以模型解释替代事实 |

每个工作包须有输入输出、依赖、正常和故障反例、演示与遗留项。当前自动化不能替代真实MV3、长期压力或静态准确性验收。原始通知日志与采集计数分开；未取得的命令结果仍不能重建；有界并发不能代替容量与长期压力验证。
