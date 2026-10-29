# 外部源码试跑记录

> 历史记录：保留当时方案、能力与验证，不作为当前进度或能力承诺。当前见[需求](../../requirements.md)和[开发计划](../../roadmap.md)。

提取器 0.2.0，2026-10-23。下列链接固定到测试提交；仅保留链接与结果，不收录外部源码、子模块或扫描产物。

| 公开仓库与固定版本 | 所选入口 | 直接请求调用点命中 | 原始 URL 候选 |
| --- | --- | ---: | ---: |
| [alibaba/nacos](https://github.com/alibaba/nacos/tree/7f71d44f880535dcf0ba14829df4a98329fc4e06) 新控制台 | console-ui-next/src/api 的 13 个业务 API 文件 | 141/141 | 304 |
| 同上，旧控制台 | console-ui/src/reducers | 24/24 | 46 |
| [alibaba/Sentinel](https://github.com/alibaba/Sentinel/tree/a3f40ba8e900c8489bd520274739f17235a7721c) | dashboard 的 scripts/services | 配置后 52/52，默认 0/52 | 50 |
| [aliyun/alibabacloud-gdb-console](https://github.com/aliyun/alibabacloud-gdb-console/tree/49336dbcc958236e233a921f60353802cbd43130) | src/utils/WebRequest.js | 3/3 | 2 |

调用点是对所选 receiver 做独立 AST 枚举，再按终端源码文件、行、列核对。另人工选定 19 个 method/URL/位置检查点，全部匹配。这不是全仓完整召回率或运行时准确率；所有扫描 complete=false，保留了近似分析和候选上限诊断。

Sentinel 需声明注入客户端 `{"clients":[{"name":"$http","kind":"axios"}]}`，未修改上游或硬编码接口。Nacos 的动态 baseURL 会放大候选数，304 不是 304 个独立业务接口。GDB 源码较旧，不代表当前在线控制台。

另测 GDB 的 `src/components/**` 页面入口：maxDepth=12、maxSteps=500000，得到 0 个接口且预算耗尽。普通类实例工厂和复杂组件控制流仍有缺口；API 层命中不代表页面到请求的整条链路已经可用。

本次只读公开源码，没有运行目标构建、安装目标依赖或主动请求业务接口。本地下载与报告放在忽略目录；日后复测应使用上述固定提交，结果按具体入口范围解释。
