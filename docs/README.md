# 方案文档导航

文档采用总分结构：**总方案 → 三个具体方案 → 交付约定 → 验证计划**。三个具体方案是并列分支，各自说明输入、流程、开发内容和边界；统一交付规则集中维护。

## 1. 总方案

[API 资产收集总方案](API资产收集总方案.md)：项目目标、三路分工、获取范围及静态分析的能力共享边界。

## 2. 三个具体方案

| 方案 | 文档 | 负责说明 |
|---|---|---|
| 白盒 | [Frontend API Extractor](../frontend-api-extractor/README.md) | 仓库构建 JS → 嵌套引用分析 → URL、参数、Host、JS 文件 |
| 黑盒一 | [JS 请求采集浏览器插件](JS%20请求采集浏览器插件.md) | CDP 实际请求采集、过滤、存储、导出与验收规格 |
| 黑盒二 | [网站 JS 收集与静态分析](网站%20JS%20收集与静态分析.md) | 部署脚本收集、上下文恢复与静态请求提取 |

前端提取器文档统一在其 [docs/](../frontend-api-extractor/docs/README.md)：需求、架构、用法、开发计划和验证各自维护。已有构建、辅助源码扫描与 JSON/Excel 交付；jshound 增强核心尚未完成，当前缺口不隐去。

## 3. 交付约定

[结果模型与 Excel 交付](结果模型与Excel交付.md)：三类证据、记录粒度、字段状态、Excel 与证据底稿。

## 4. 验证计划

[前端提取器开发计划](../frontend-api-extractor/docs/roadmap.md)是其当前进度的唯一入口；[验证规则](../frontend-api-extractor/docs/testing.md)说明正确性和速度如何验收。早期方案、累计能力和历次实测保留在[归档](../frontend-api-extractor/docs/archive/README.md)。

[验证计划](验证计划.md)：材料准备、源码/产物对照、路线比较及三路验收。

验证计划所需的候选工具、插件、开源项目与许可证评估见 [references](../references/README.md)。

黑盒一的独立工程在 [browser-extension](../browser-extension/README.md)，见[插件开发与安装](插件开发与安装.md)及[界面、交互与升级改进](插件界面与交互改进.md)；完整插件现场验收仍待执行。工具评估统一见 [references](../references/README.md)，外部源码和大报告不进入主仓库。更新：2026-10-29。
