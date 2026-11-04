# 模块规格与交付

模块是开发工作包，不等于单个文件。每个任务明确模块ID、限定用例、输入输出例子、修改路径、依赖、正反例、演示步骤、完成条件及遗留缺口。唯一状态见[计划](plan.md)，架构见[architecture](architecture.md)。

| ID/模块 | 语言与落点 | 输入→输出 | 实现内容/完成条件 |
| --- | --- | --- | --- |
| C01 分类协议 | TS/Python；remote-capture.ts、receiver.py | 分类事件/正文→可校验协议/ACK | 固定现有v2，扩展需版本例子；拒绝未知分类/冲突，不用HTTP成功代替持久确认 |
| E01 统一会话 | TS；recorder.ts、background.ts，后续session-broker.ts | 浏览器/任务→有代次事件 | 同一CDP所有者，独立租约/暂停/排空，单页失败隔离，真实MV3 |
| E02 分类采集 | TS；js-capture.ts、recorder.ts | CDP→API/JS/上下文/加载/任务 | 参数头体、正文与栈分来源，缺失可见；URL不当唯一版本身份 |
| E03 传输背压 | TS；remote-capture.ts、asset-index.ts | 有界内存→分块/事件/持久ACK | 失败重试幂等、ACK后释放、队列满与退出记缺口；跨接收端及同URL换版不能误复用 |
| E04 工作台 | Vue/TS；App.vue、JSCapturePanel.vue | 配置/状态/分页→采集与结果视图 | 一个服务器地址，分类进度、实测/静态/Agent与缺口分开；旧任务可用 |
| B01 接入与存储 | Python；receiver.py | 分块/事件→不可变事件、服务端哈希对象、回执 | SQLite/文件持久、合法范围、重复/冲突/断传、内容与观察不混同 |
| B02 输入归一化 | Python；stream.py、assets.py | 已持久事件/正文→上下文/资产/实测API/Gap | 会话/导航/版本隔离，重复加载仍有观察；文件预算、缺正文/基址明确 |
| B03 批次与调度 | Python；目标scheduler/ | 事件水位→manifest、run、进度 | 合并触发、幂等任务、取消/恢复、不可变输入，ACK不等待分析；当前未实现 |
| A01 静态提取 | Python+Node/Babel；collection.py、engine.py、worker.py、固定jshound | 固定资产→引用图、API候选、参数及证据 | 当前文件级结果保留；逐步补模块/发送绑定、实例隔离、字段覆盖/删除及序列化，不虚构位置 |
| A02 实测关联 | Python；stream.py | 实测与静态→API清单、关联状态 | 版本/上下文/Host/Method/路径保守关联；歧义不强匹配，次数独立 |
| G01 Agent运行时 | Python；目标agents/runtime.py、providers.py | 固定run/缺口/预算→工具轨迹、结构建议 | 可配置模型，超时/取消/失败降级，不阻塞接收，详见agent.md；当前未实现 |
| G02 证据工具/核验 | Python/Node；目标agents/tools.py、verify.py | 受限读取/分析→带证据的核验状态 | 固定资产/range、AST/绑定、字段与实例核验；不执行任意命令或业务JS，不提升无证据建议 |
| B04 查询与结果 | Python；目标query/，现有receiver查询 | 固定结果→分页API、正文证据、作业状态 | 分project/scan/run，过期结果不串任务；当前仅接收数据查询，分析查询未接通 |
| B05 导出 | Python；results.py，后续export/ | 相同事实底稿→JSON/CSV/Excel/证据包 | 不丢变体、候选/实测/Agent分层；Excel公式/长内容/分片处理；当前JSON/CSV已有，Excel待实现 |

## 依赖和最小交付

C01→E01/E02/E03+B01→B02→B03→A01/A02→G01/G02→B04/B05→E04结果联调。E04采集配置与进度可先做；Agent先使用冻结受控输入，不依赖生产采集数据外发。

最小产品必须演示同一任务两client不串线、同URL换版、断传/重复回执、未知基址和Agent无配置/失败回退。确定性分析未达到绑定能力时，Agent结果只能作为候选辅助，不以增加候选数量替代准确性。

## 输入身份与状态

对象至少区分Task、Context、Content、Observation、LoadEvidence、ObservedRequest、Snapshot/Manifest、AnalysisRun、RequestCandidate、Evidence、Gap、AgentRun/Proposal。当前v2事件名保持不变，目标对象不要直接当已支持wire字段。

内容哈希不替代观察身份；SendSite身份需要固定正文+parser range+绑定；调用变体需要调用/实例/条件。字段值动态、字段名未知、结构不完整分别表达。模型建议保存provider/model、prompt/tool版本、输入哈希、工具轨迹、核验结果；不覆盖原始证据。
