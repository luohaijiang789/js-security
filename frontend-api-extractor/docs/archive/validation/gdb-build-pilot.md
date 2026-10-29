# GDB Console：真实仓库构建与请求表

> 历史记录：保留当时方案、能力与验证，不作为当前进度或能力承诺。当前见[需求](../../requirements.md)和[开发计划](../../roadmap.md)。

2026-10-28。输入 [aliyun/alibabacloud-gdb-console](https://github.com/aliyun/alibabacloud-gdb-console/tree/49336dbcc958236e233a921f60353802cbd43130)，固定 Commit 49336dbcc958236e233a921f60353802cbd43130。本文件仅保留来源、配置、证据摘要和小表格，不收录外部仓库、依赖或构建产物。

## 为什么符合样本要求

这是 React 17 前端。锁定依赖包含 @alicloud/console-components 1.5.10、console-components-intl 1.0.18、console-components-slide-panel 2.2.14。[ParameterInput 源码](https://github.com/aliyun/alibabacloud-gdb-console/blob/49336dbcc958236e233a921f60353802cbd43130/src/components/ParameterInput/index.js#L27)与 GraphZone 明确导入阿里云 JS 组件库。请求由 Axios 发送，不将 UI 依赖称为云 SDK 请求分析。

通过 repository-cli 的内置配置，实际完成 clone、固定版本、npm ci、原 react-scripts build、产物清点和 source-map 辅助分析。安装约 102 秒，正式构建约 116 秒；这是该次环境记录，不作跨机器性能保证。镜像 digest：node@sha256:503446c15c6236291222f8192513c2eb56a02a8949cbadf4fe78cce19815c734。

原锁文件 SHA-256：2c8f7b2ed048d219d0ffddb5b2d162771a1521d6666f4dd277b6680b745504b4。
显式转换镜像 tarball 后：438aa5dc45888e271b184b9de77d8e46dbd1321b8574bf74cae2527a243f0611。3708 个 resolved 字段被转换，版本与 integrity 保留；npm ci 安装 1970 个包，启用 legacy-peer-deps、ignore-scripts，未升级依赖。构建后的 tracked changes 仅 package-lock.json。

## 构建产物

| JS | 字节 |
| --- | ---: |
| build/static/js/main.a581a592.chunk.js | 118447 |
| build/static/js/2.c9c104d7.chunk.js | 2685992 |
| build/static/js/3.37e21d79.chunk.js | 3560 |
| build/static/js/runtime-main.b9d3bf81.js | 2371 |

main JS SHA-256：9f228266db9be87868704e9ab73fd19122a8b9cdca7cd9a7479e32adda4eeef7。4 个 JS 均有 source map，匹配到 21 个本仓库应用脚本。这里只分析与原仓库路径和内容哈希对应的应用源码，不将第三方 map 中泛称 src 的文件误认成应用代码。

## 最终请求表

以下产物位置均属于 build/static/js/main.a581a592.chunk.js，行/列从 1 开始。每行是静态调用/条件候选，不证明实际运行或网络载荷。Query 和 Header 在这些调用处均无显式字段。

| 产物 JS 行:列 | 对应源码位置 | 方法 | Host | URL | Body 参数 | 条件/缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| 1:115059 | [WebRequest.js:71:5](https://github.com/aliyun/alibabacloud-gdb-console/blob/49336dbcc958236e233a921f60353802cbd43130/src/utils/WebRequest.js#L71) | POST | 未知 | /api/v1/connect | conn：动态 connInfo 对象 | 嵌套结构未知 |
| 1:114300 | [WebRequest.js:33:5](https://github.com/aliyun/alibabacloud-gdb-console/blob/49336dbcc958236e233a921f60353802cbd43130/src/utils/WebRequest.js#L33) | POST | 未知 | /api/v2/query | type="gremlin"；dsl：动态值 | DSL 类型判断的 true 分支 |
| 1:114300 | 同一源码位置 | POST | 未知 | /api/v2/query | type="cypher"；dsl：动态值 | 同一判断的 false 分支 |
| 1:114759 | [WebRequest.js:55:7](https://github.com/aliyun/alibabacloud-gdb-console/blob/49336dbcc958236e233a921f60353802cbd43130/src/utils/WebRequest.js#L55) | POST | 未知 | /api/v2/query | type：未知捕获值；dsl：动态值 | Promise 回调上下文尚未完整恢复 |

这些是 3 个发送位置、2 个方法/路径模板、4 条条件记录，不能把 4 行称为 4 个独立业务接口。相对 URL 依赖部署上下文，package.json 的 localhost:3030 proxy 是开发设置，不拿来填生产 Host，也不使用 GitHub/阿里云 CDN 的域名。

## 独立核查与保留缺口

对本次编译 JS 独立做 AST 枚举，检查 post('/api/...') 的 3 个调用：产物行列、URL 和对象字段分别与映射结果一致；编译代码可见 post('/api/v1/connect',{conn:...}) 和两个 post('/api/v2/query',{type:...,dsl:...})。源内容哈希与固定 Commit 匹配。这个分母只针对已标注的 API 调用，不是全 vendor/全仓召回率。

任务 completed，analysisComplete=false。源码求值 31672 步；GraphVis、GraphZone 两个分区预算中断。1982 个第三方/非应用脚本/非脚本或缺内容 source 条目未纳入本轮应用分析，不能据此断言它们不发请求。纯 Webpack runtime 解析、远程 JS 抓取、所有类实例/回调关系及 AI 释义尚未完成。

CSV、Markdown、完整 analysis.json/task.json 和日志由命令自动写入忽略目录。首次分析异常的失败任务也保留；随后从地址完整重跑成功，并在同一批产物哈希不变的前提下复核最终导出。复现命令和模型边界见[仓库流水线](../../reference/repository-pipeline.md)。
