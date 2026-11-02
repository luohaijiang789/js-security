# Website JS Extractor

黑盒二的目标是轻量浏览器插件持续收集网站 JS 和加载证据，增量发送给远端存储/去重/跨文件分析，持续产出 URL、参数、Host 和对应 JS。正文去重，页面、请求、父链与可得调用栈的观察独立保留；本机是同一服务的可选部署。CLI 只作调试/重放；后续直接集成到黑盒一，同一插件提供真实请求和 JS 静态分析，证据与统计分开。**本轮只整理文档，暂不实施集成。**

当前统一工程包含可构建 MV3 原型、同一 Python/Node 分析核心与本机 /v0 原型；只能对已取得正文提供文件级候选。完整状态、既有验证及下一批工作只在[实施计划](docs/plan.md)维护，不将 CDP/UI 自动化当作真实 MV3 现场验收。

## 文档入口

| 文档 | 唯一职责 |
| --- | --- |
| [需求](docs/requirements.md) | 插件目标、用户流程、四项交付与边界 |
| [整体设计](docs/design.md) | 采集→快照→分析→查看/导出的产品链路 |
| [架构与集成方案](docs/architecture.md) | 当前代码/依赖；未来共享会话、生命周期、任务/数据/UI、权限与回退 |
| [分析设计](docs/analysis-design.md) | 引用、深度、上下文、预算恢复与后续绑定/字段算法 |
| [模块职责](docs/modules.md) | 组件输入输出与完成条件，不再复制算法/产品路线 |
| [当前协议](docs/protocol.md) | capture-0.1、result/checkpoint 0.5、/v0、实际预算与兼容 |
| [使用说明](docs/plugin.md) | 插件构建/加载/配对/操作；CLI调试与全部验证命令 |
| [测试规则](docs/testing.md) | 各层证据、受控/现场/集成矩阵与发布判定 |
| [唯一计划](docs/plan.md) | 已实现/自动验证/待现场/未实现、单一阶段与证据索引 |

## 工程边界

源码、Python依赖、测试和文档统一在本目录；插件npm工程在 `extension/`，核心与本机服务在 `src/website_js_extractor/`。固定jshound在根 `references/repos/`，增强fork未接入；后续远端与可选本机部署复用同一核心，不新建第二工程；当前远端增量和持续处理尚未实现，见[目标设计](docs/architecture.md#6-持续采集与远端处理目标未实现)。

不主动调用提取API、不执行业务脚本、不自动提交表单，不默认把脚本发给AI/云端。外部正文和报告只放主仓 `work/`。三路关系见[总览](../docs/overview.md)，统计/导出语义见[共享交付](../docs/delivery.md)，许可见[第三方说明](THIRD_PARTY_NOTICES.md)。
