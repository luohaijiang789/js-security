# 网站 JS 收集与静态分析

黑盒二的独立插件与本地服务产品设计放在 [website-js-extractor](../website-js-extractor/README.md)，先交付可运行浏览器插件，后续直接集成到黑盒一；当前优先插件采集、分析与展示的最小闭环。

- [需求与操作](../website-js-extractor/docs/requirements.md)：独立插件与本地服务的用户流程。
- [测试与验收](../website-js-extractor/docs/testing.md)：冻结样本、效果指标与目标 Chrome 现场门槛。
- [设计](../website-js-extractor/docs/design.md)：脚本收集、三层获取边界、页面上下文和静态分析。
- [实施计划](../website-js-extractor/docs/plan.md)：设计冻结、基线验证、实现及验收。

本工程的[命令行与分析核心](../website-js-extractor/docs/usage.md)已实现 HAR/目录导入、引用图、受控补取和 Worker 上下文；源码、测试、依赖、[分析设计](../website-js-extractor/docs/analysis-design.md)及[唯一计划](../website-js-extractor/docs/plan.md)均在同一目录。插件/HTTP 服务与精确绑定仍按实际证据验收。

三路关系见[总览](overview.md)，共享输出见[交付约定](delivery.md)。
