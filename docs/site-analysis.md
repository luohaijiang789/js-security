# 网站 JS 收集与静态分析

黑盒二调整为[远端后端](../website-js-extractor/README.md)，接收增强后的黑盒一提供的真实接口、JS正文和加载证据，存储/去重/关联并持续静态分析。生产插件只有browser-extension，不再先建设独立黑盒二插件；当前仍处于方案更新，实际统一链路未迁移。

- [需求与操作](../website-js-extractor/docs/requirements.md)：统一插件与远端后端的用户流程。
- [测试与验收](../website-js-extractor/docs/testing.md)：冻结样本、效果指标与目标 Chrome 现场门槛。
- [设计](../website-js-extractor/docs/design.md)：脚本收集、三层获取边界、页面上下文和静态分析。
- [实施计划](../website-js-extractor/docs/plan.md)：设计冻结、基线验证、实现及验收。

本工程的[命令行与分析核心](../website-js-extractor/docs/plugin.md)已实现 HAR/目录导入、引用图、受控补取和 Worker 上下文；源码、测试、依赖、[分析设计](../website-js-extractor/docs/analysis-design.md)及[唯一计划](../website-js-extractor/docs/plan.md)均在同一目录。插件/HTTP 服务与精确绑定仍按实际证据验收。

三路关系见[总览](overview.md)，共享输出见[交付约定](delivery.md)。

目标调整为插件轻量持续采集、向授权远端增量上传正文及加载证据，远端去重存储与持续跨文件分析；当前原型仍是本机整包快照。设计与待实现边界见[架构](../website-js-extractor/docs/architecture.md#6-持续采集与远端处理目标未实现)。
