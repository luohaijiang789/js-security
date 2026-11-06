# 后端Agent设计

已实现后端手动运行首版：`application/agent.py`提供模型适配、受限工具循环、预算、取消、结构建议核验与独立报告，CLI为`website-js-extractor agent`。默认关闭；尚未配置或验收真实模型。Agent不打包进插件，确定性提取可独立运行。下面的跨函数wrapper/实例/字段加工工具仍是后续目标，当前不会把模型建议直接提升为API事实。

## 当前可运行入口

```bash
website-js-extractor agent --run-dir data/capture/analysis/RUN/result \
  --out work/agent-RUN.json --base-url http://127.0.0.1:8000/v1 \
  --model YOUR_MODEL --api-key-env BLACKBOX_MODEL_KEY --allow-source-send
```

run-dir必须含最终analysis.json、有效analysis-manifest.json和匹配哈希的snapshot；out必须新建且位于冻结输入外。接口采用OpenAI兼容Chat Completions JSON输出，凭证只从指定环境变量读取。未传allow-source-send时不调用模型。服务器接收/自动静态作业不会自动启动Agent，也不会因为安装了这段代码就外发真实数据。

当前工具为list_candidates、inspect_candidate、read_source和verify_proposal，源码读取按资产ID/UTF16范围限制，不接收任意路径；拒绝符号链接与正文哈希变化。结构化URL/方法/Host说明只有匹配既有候选与AST位置才accepted；自然语言始终为模型解释。wrapper_mapping即使位置匹配也仅partial，跨函数/实例关系未证明。结果保存输入manifest/report哈希、模型、步骤摘要、建议与核验原因，事实文件保持不变。

预算上限10轮、60秒、累计源码64KiB、消息上下文128KiB、每轮模型输出32KiB。超时/预算/无效工具/模型离线/取消有明确状态；模型调用采用有界等待，不阻塞接收ACK。受控provider和真实本地HTTP协议测试已实现，不代表真实模型效果已验收。

## 1. 要解决什么

| 任务 | 输入 | 输出 | 核验 |
| --- | --- | --- | --- |
| 自定义请求封装识别 | 未识别调用、相关JS片段、AST绑定和参数 | wrapper/参数映射建议 | 固定源码range、调用边、绑定与发送机制 |
| 请求加工理解 | client配置、hook、序列化与缺口 | 顺序/字段影响的结构建议 | AST读写、对象实例与可证明执行顺序 |
| 关联候选解释 | 实测、静态候选及版本/上下文 | 有依据的关联候选、需补充信息 | 版本/上下文/位置检查，路径相似不算确认 |
| 字段释义和报告 | 已核验结构、证据与未知 | 可读解释、问题清单 | 标记模型解释，不修改URL/字段事实 |

Agent可以规划并迭代调用受限工具，不仅生成一段摘要；首次交付先实现“未知wrapper→建议→确定性核验→候选/已核验结果”一条闭环，后续扩任务类型。不使用多Agent协作作为首版前提。

## 2. 运行时与模型

Python AgentRunner接收runId、输入manifest、任务类型和预算；ProviderAdapter负责模型调用，配置项为provider、base_url、model、凭证引用、超时和重试。凭证在后端配置，不进入事件、提示日志或导出。支持一个明确版本的provider后再扩，不声称兼容所有模型API。

模型未选定时，不向外发送真实源码/请求；用受控样本和假provider验证工作流。选用本地模型或外部模型须显式配置数据可发送范围；工具默认仅传当前任务所需片段，不默认传Cookie/认证头/业务正文。

## 3. 受限工具

| 工具 | 输入/输出 | 限制 |
| --- | --- | --- |
| list_assets / read_source | 固定资产ID、range→正文与哈希 | 只读当前manifest，字节预算，不访问任意磁盘路径 |
| search_symbols / inspect_ast | 标识符、模块ID→匹配位置和绑定 | 依赖已解析索引；未知不猜 |
| trace_request / inspect_writes | 发送点、实例、字段→追踪和缺口 | 使用确定性核心；不通过eval运行代码 |
| compare_observation | 实测/候选ID→版本、上下文与字段差异 | 不按同URL直接合并，值动态保持未知 |
| verify_proposal | 结构建议+证据ID→accepted/partial/rejected | AST/range/绑定/实例核验，失败保留原因 |
| emit_proposal | schema合法建议→追加的模型建议记录 | 不直接修改事实表或原始正文 |

禁止任意shell、网络访问、浏览器控制、业务API调用、代码执行及原始证据改写。站点JS、注释、响应体中的指令只是待分析文本，不能扩大工具权限。

## 4. 执行与状态

```mermaid
flowchart LR
 A[固定分析run与缺口] --> B[选择任务和上下文预算]
 B --> C[模型规划与受限工具循环]
 C --> D[结构化Proposal]
 D --> E[确定性核验器]
 E --> F[已核验推导 / 候选 / 拒绝与缺口]
 F --> G[结果与工具轨迹]
```

AgentRun状态queued/running/needs_evidence/completed/partial/failed/cancelled，与接收/静态run独立。Proposal至少保存输入哈希、模型/提示/工具版本、建议类型、证据范围、条件、核验状态和原因。模型置信分不能充当证据等级；accepted只针对具体被核验结论，不能声称所有运行时情况正确。

预算基线建议：每任务最多10轮工具循环、60秒墙钟、上下文/输出token上限和项目并发1；具体值在受控试验冻结。工具空结果、模型格式错误、限流、超时和取消有界结束，部分轨迹留档，不能无限重试。

## 5. 验收闭环

- 正例：受控wrapper提供精确片段与绑定，模型给参数映射，核验器检查后形成带证据推导。
- 反例：同名非网络函数、两client、同URL不同正文、注释中的恶意指令、编造位置、未知hook不得提升确定性。
- 无模型/模型离线时，接收ACK、确定性提取和已有结果查询照常工作。
- 相同输入/工具预算可复核每一步；模型输出不要求逐字确定性，但核验通过条件必须稳定。
- 第一轮接入前选择provider/模型和允许的数据范围，生产数据不会因“结合Agent”自动外发。
