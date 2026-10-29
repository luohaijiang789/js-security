# 专题参考

本目录保存现有 0.10 及更早实现的机制、配置与开源依据，不表示增强核心已完成。当前运行入口看[使用指南](../usage.md)，新架构看[架构](../architecture.md)，当前进度看[开发计划](../roadmap.md)。

| 文档 | 内容 |
| --- | --- |
| [jshound 与开源核对](jshound.md) | 上游原理、实际接入范围与限制 |
| [现有仓库构建](repository-pipeline.md) | 锁文件、容器、配置与产物关联细节 |
| [源码扫描](source-scanning.md) | 旧引擎配置、客户端、范围和预算 |
| [异步资产](async-assets.md) | 既有深层 JS 与局部补漏机制 |
| [预算](budgets.md) | 旧分区求值计数与中断 |
| [地址上下文](deployment-context.md) | 部署基址与 Host 来源 |
| [对象改写](object-effects.md) | 字段覆盖和未知副作用 |
| [请求 hook](request-hooks.md) | 已支持的同步拦截器子集 |
| [复杂 JS](whitebox-hardening.md) | 早期处理范围与缺口 |
| [交付协议](delivery-protocol.md) | 当前统一结果模型和兼容信息 |
| [固定基准](baselines.md) | 冻结输入、差异工具 |
| [人工预期](external-baselines.md) | 早期外部切片验证与字段状态 |
