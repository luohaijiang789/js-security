# 开源方案核对与采用记录

2026-10-29（北京时间）。本轮实际检索官方资料、读取实现，并执行固定 jshound 分析器。没有把项目宣传或搜索摘要当作准确率证据。

| 来源 | 实际核对 | 本轮采用 / 适用范围 |
| --- | --- | --- |
| [jshound](https://github.com/AmbitSecurity/jshound) | 固定 f34f9c5；读取 static_ast.js / analyze.py；离线执行真实 worker | 直接接入多文件索引和请求候选发现，再定向做语义分析 |
| [CodeQL JS 数据流文档](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/) | 官方局部/全局数据流与目标配置 | 采用限定分析目标的思路；未接入 CodeQL 引擎 |
| [TAJS Lazy Propagation](https://cs.au.dk/~amoeller/papers/lazy/) / [Demand-Driven Refinement](https://cs.au.dk/~amoeller/papers/tajsvr/) | 原作者论文摘要与工具介绍 | 作为惰性传播、按需精化参考；未声称实现论文算法 |
| [Jelly](https://github.com/cs-au-dk/jelly) / [solver.ts](https://github.com/cs-au-dk/jelly/blob/master/src/analysis/solver.ts) | README 与工作列表/增量传播/SCC处理源码 | 通用摘要/约束求解的后续参考；没有安装或运行 Jelly |
| [jsluice analyzer.go](https://github.com/BishopFox/jsluice/blob/main/analyzer.go) | tree-sitter 建树与 query/matcher 入口源码 | 局部AST匹配的补充对照；未运行，不评价其真实召回率 |

## jshound 中实际看到的做法

固定版本的 [indexExports](https://github.com/AmbitSecurity/jshound/blob/f34f9c5dcfa0f30816a66881ea9a8d8573c24f05/jshound/js/static_ast.js#L150) 建模块导出索引，[collectWrappers](https://github.com/AmbitSecurity/jshound/blob/f34f9c5dcfa0f30816a66881ea9a8d8573c24f05/jshound/js/static_ast.js#L3593) 保存绑定与模板描述，再用有界增量轮次组合包装链。其 [跨批次模块索引](https://github.com/AmbitSecurity/jshound/blob/f34f9c5dcfa0f30816a66881ea9a8d8573c24f05/jshound/analyze.py#L838) 将共享信息与逐批提取分开。

本轮复用它的固定 Node worker，不复制其分析实现进主仓库。自有代码负责输入范围、Vue/Svelte脚本适配、预算/错误、证据转换和语义核验。[引擎适配器](../../src/jshound.js)与[启动器](../../tools/jshound-worker.cjs)是集成层；许可证和作者版权仍保留在原子模块。[固定版本/哈希](../../models/jshound.json)覆盖执行脚本和自带Babel包，执行前校验；不额外安装其Python依赖。

## 核对后明确保留的限制

- 上游输出没有精确行列；候选不能自动冒充入口追踪。字段可能按同文件、同模板合并。
- 部分属性归因依赖名称启发式，已有源码注释记录过跨文件误借值；外部结果始终 partial，Host仅作候选。
- route/nav/path-literal 与发送调用分别处理；适配器过滤前者，不把路由转换成 GET API。
- 使用原始 worker JSON，保留 query_schema、嵌套字段和完整原始记录。已有 JSONL/OpenAPI 导出损失的历史记录见[前期评估](../../../references/网站浏览器挂载与动静态联合采集评估.md)。
- 上游 parse() 在某些错误后返回 null；自有启动器额外检查解析错误，不能以空数组冒充扫描成功。

因此采用“共享索引发现＋符号语义精查”的组合，不把其输出全部升级为确定接口。运行效果与可复现数据见[0.10报告](../archive/releases/release-0.10.md)。纯函数缓存、有副作用函数摘要及全仓调用图不是本轮新增能力；本轮通过定向展开减少重复计算。
