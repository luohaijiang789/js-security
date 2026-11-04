# 模块职责与完成边界

| 模块 | 实际代码 | 输入→输出/完成条件 |
| --- | --- | --- |
| 统一采集 | browser-extension/src/recorder.ts、js-capture.ts、background.ts | 同一CDP会话→API/JS/上下文/加载证据；目标/代次隔离，缺失/预算记Gap |
| 临时持久待传 | delivery-outbox.ts、remote-capture.ts | 事件/正文→原子持久队列→分块/序号/ACK；崩溃恢复、丢确认幂等、ACK后原子清理 |
| 分类接收与账目 | src/website_js_extractor/receiver.py | 请求→校验、SHA-256对象、不可变事件、连续分类账；封账不符拒绝完成 |
| 自动分析编排 | jobs.py | 已持久水位→固定快照、作业状态、恢复排队、结果；不阻塞ACK，不执行站点JS |
| 输入/引用/静态核心 | stream.py、assets.py、collection.py、engine.py、worker.py | 固定输入→上下文、引用图、jshound文件级候选和Gap；真实绑定能力不得虚构 |
| 实测关联/导出 | stream.py、results.py | 实测+静态→API清单、JSON/CSV/原始证据；不合并真实次数/候选，歧义保守 |
| 工作台 | App.vue、JSCapturePanel.vue | 地址/当前账目/作业/API清单→一个插件里的控制与证据视图；历史任务继续可查 |
| Agent与精确增强 | 尚无运行实现；见agent.md、analysis-design.md | 固定证据工具/核验、实例/调用/字段；不得以模型解释替代事实 |

每个任务应附限定用例、输入输出、路径、依赖、正常与故障反例、演示和遗留项；完成状态只在plan.md维护。当前传输/作业自动化不代替真实MV3、长时压力或静态准确性验收。
