# Website JS Extractor

黑盒二调整为**处理黑盒一采集数据的远端后端**。黑盒一 `browser-extension/` 是唯一生产插件入口，统一采集真实请求、JS正文、页面/执行上下文和加载调用证据，增量发送给后端；后端负责存储、去重、关联、跨文件静态分析、结果查询和导出。

不再走“先做完整独立黑盒二插件、再合并”的产品路线。现有 `extension/` 暂作迁移参考和回归材料，不继续作为独立插件交付；验收后再退役，不在本次讨论中直接删除。`src/website_js_extractor/` 保留同一分析核心与服务，CLI仅用于调试/重放，本机部署是远端服务的可选形态。

现已实现统一插件→v1增量接收→持久确认/查询的接收闭环，以及从接收数据旁路执行的离线`ingest`分析；JS和远端任务请求不在浏览器落盘。**接收端自动触发/持续增量分析尚未接通，真实MV3仍待现场验收**。旧/v0整包服务仅作原型兼容。状态只在[计划](docs/plan.md)维护。

## 文档入口

| 文档 | 唯一职责 |
| --- | --- |
| [需求](docs/requirements.md) | 统一插件与后端分工、用户流程、四项交付与边界 |
| [整体设计](docs/design.md) | 采集→快照→分析→查看/导出的产品链路 |
| [架构与集成方案](docs/architecture.md) | 当前代码/依赖；未来共享会话、生命周期、任务/数据/UI、权限与回退 |
| [分析设计](docs/analysis-design.md) | 引用、深度、上下文、预算恢复与后续绑定/字段算法 |
| [模块职责](docs/modules.md) | 组件输入输出与完成条件，不再复制算法/产品路线 |
| [当前协议](docs/protocol.md) | capture-0.1、result/checkpoint 0.5、/v0、实际预算与兼容 |
| [使用说明](docs/plugin.md) | 现有独立原型调试/重放及验证命令，不是另一个插件产品 |
| [测试规则](docs/testing.md) | 各层证据、受控/现场/集成矩阵与发布判定 |
| [唯一计划](docs/plan.md) | 已实现/自动验证/待现场/未实现、单一阶段与证据索引 |

## 工程边界

源码、Python依赖、测试和文档统一在本目录；生产插件在根 `browser-extension/`；本目录 `extension/` 仅暂存旧原型与测试参考，后端核心和现有本机服务在 `src/website_js_extractor/`。固定jshound在根 `references/repos/`，增强fork未接入；后续远端与可选本机部署复用同一核心，不新建第二工程；增量接收和离线`ingest`已实现，接收端自动持续分析仍未接通，见[目标设计](docs/architecture.md#6-持续采集与远端处理目标未实现)。

不主动调用提取API、不执行业务脚本、不自动提交表单，不默认把脚本发给AI/云端。外部正文和报告只放主仓 `work/`。三路关系见[总览](../docs/overview.md)，统计/导出语义见[共享交付](../docs/delivery.md)，许可见[第三方说明](THIRD_PARTY_NOTICES.md)。

## 启动增量接收 API

Python 3.10+，无需安装依赖。在仓库根目录运行：

```bash
python3 website-js-extractor/server.py
```

或者进入本目录运行`python3 server.py`。默认监听`0.0.0.0:8379`，数据保存在本目录`data/capture/`。插件勾选远端采集后，只填`http://服务器IP:8379`即可；无需扩展ID、项目、令牌环境变量或HTTPS反向代理。固定code和默认项目已内置前后端。

检查启动状态：

```bash
curl http://127.0.0.1:8379/health
```

返回`"status":"ok"`即已启动。需要换端口或目录时可用`--port 9000 --data-dir /你的目录`。公网连接须确保服务器8379端口可达。固定code是接收协议的匹配值，不是秘密凭证；不提供按扩展ID隔离。

服务端仍校验分块/完整SHA-256、幂等事件和持久ACK，协议见[协议](docs/protocol.md#统一插件增量接收协议-v1capture-stream-1)。接收端不自动执行站点JS或触发分析；分析由显式离线命令旁路执行。

## 分析已接收的数据

接收服务只保存不可变事件和正文。对已落盘数据执行离线`ingest`：

```bash
cd js-security
PYTHONPATH=website-js-extractor/src python3 -m website_js_extractor.cli ingest \
  --data-dir website-js-extractor/data/capture \
  --out work/ingest/scan-1 \
  --scan <可选scan-id>
```

省略`--scan`时取最近活动任务。命令读取`capture.sqlite3`，物化已完成校验的JS正文，归一化执行上下文、脚本、JS加载和实测请求，随后复用引用图、固定jshound和候选生成，输出：

- `analysis.json`：任务、上下文、脚本、静态候选、缺口和计数；
- `api_inventory.json` / `api_inventory.csv`：静态候选与实测请求按Host+Method+路径保守关联，状态为`matched`、`static-only`或`observed-only`；
- `observed_requests.json` / `observed_requests.csv`：实测请求原记录；
- `candidates.csv`、`parameters.csv`、`assets.csv`、`references.csv`、`gaps.csv`。

该命令不执行站点JS、不发起网络请求，也不把实测请求当成静态发送点。静态候选仍是文件级，精确位置和调用上下文尚未实现。测试：

```bash
PYTHONPATH=website-js-extractor/src python3 -m unittest discover -s website-js-extractor/tests -p test_receiver.py -v
PYTHONPATH=website-js-extractor/src python3 -m unittest discover -s website-js-extractor/tests -p test_stream.py -v
cd browser-extension
npm test
```
