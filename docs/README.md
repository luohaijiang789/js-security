# 共享文档

根 `docs/` 只保存跨工程内容。白盒提取器和浏览器插件各自在自己的目录维护需求、架构、使用、计划和历史，避免同一状态维护两遍。

| 文档 | 职责 |
| --- | --- |
| [总览](overview.md) | 白盒、浏览器实测、网站 JS 静态分析三路关系与边界 |
| [API 发现与统计讨论结论](api-discovery-decisions.md) | 白盒业务/依赖分层、黑盒 JS 定位、共用边界与统计口径 |
| [网站 JS 分析](site-analysis.md) | 黑盒二的脚本收集、引用深度、上下文和静态候选 |
| [黑盒二详细设计](site-analysis-design.md) | 开源复用、HAR 导入、递归队列、定位和统计规则 |
| [黑盒二实施计划](site-analysis-plan.md) | 独立进度、必测矩阵与验收要求 |
| [统一交付](delivery.md) | 三类证据、记录粒度、字段状态和 Excel/JSON 语义 |
| [联合验证](validation.md) | 三路对照、现场验证和统一交付验收 |

工程文档：

- [网站 JS 离线分析器](../site-js-analyzer/README.md)：独立命令、协议、候选/参数预览与自动化验证。
- [前端代码仓提取器](../frontend-api-extractor/README.md)：仓库构建、嵌套 JS、URL/参数/Host/JS 文件。
- [浏览器请求采集插件](../browser-extension/README.md)：实际请求采集、安装、规格、UI 和现场验收。
- [工具与项目评估](../references/README.md)：外部方案、固定版本和采用依据。

旧版提取器设计、发布和验证通过 Git 历史追溯。外部源码、依赖、构建产物和完整报告只放 `work/`。
