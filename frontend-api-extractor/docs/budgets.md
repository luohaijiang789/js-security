# 文件分区预算与中断证据

0.5.0，2026-10-27。解决复杂入口耗尽共享求值预算、后续文件完全未分析的问题。源码解析、模块识别与请求语义模型保持原有范围，不下载外部 JS、不执行业务代码。

## 分配规则

- `maxSteps` 仍是整个扫描的求值步数硬上限，默认 100000；现在计数不会超过上限。不代表 CPU 时间、内存或解析阶段的上限。
- 每个入口文件是一个分区，其跨文件调用消耗该入口的配额。库存模式每个匹配文件都是入口。文件内部顶层与潜在函数发现共用配额。
- 开始一个分区时，按“剩余总步数 ÷ 当前已知待扫描分区数”向下取整分配，至少 1 步且不超过剩余总预算。未用完的预算可分给后续分区。
- 开启 includeUnlinked 时，已知可达且不是入口的本地资产也计入待扫描分区，补漏与入口扫描共用总预算。新计算引用被发现后，加入后续分配；尚未发现的模块无法预留配额。
- 可配置 `maxStepsPerFile` 为额外的单分区上限；默认 null，不另加上限。它约束的是一次入口/资产分区分析，不是按物理 JS 文件累计的额度。
- 配额耗尽立即中断当前分区，保留此前已记录的请求，继续其他分区。没有自动重试、断点续扫或第二轮预算回填；剩余总预算可能尚未用完，早先分区仍保持不完整。
- 总预算不足以给所有已知分区至少一步时，后续分区明确标 skipped。获取深度、maxDepth、maxCandidates 不受此调度替代。

```json
{
  "maxSteps": 100000,
  "maxStepsPerFile": 10000,
  "includeUnlinked": true
}
```

配置中的所有步数、深度与候选数要求安全正整数；maxStepsPerFile 额外允许 null。

## 结果与诊断

JSON 新增 `stats.partitions`，每项有 file、phase、state、steps、limit；中断或跳过时还有 reason。usage.entry 可关联到分区 file，补漏 usage 的 linkState 仍为 unlinked。

| 字段/值 | 含义 |
| --- | --- |
| phase=entry / asset-local | 入口求值 / 独立资产补漏 |
| state=finished | 未被步数预算中断；不保证模型或运行时覆盖完整 |
| state=budget-exceeded | 已开始，因步数上限中断 |
| state=skipped | 全局预算不足，未开始 |
| reason=partition-budget | 当前分区配额用尽；PARTITION_BUDGET_EXCEEDED |
| reason=global-budget | 全局步数用尽；BUDGET_EXCEEDED |

所有分区 steps 之和等于 stats.steps，且不超过 maxSteps；skipped 分区 steps/limit 均为 0。Markdown 展示相同预算表。任何中断诊断都使 stats.complete=false；开启补漏时，入口或补漏分区的预算中断都使 unlinkedScan=incomplete。预算充足也不能消除 hook、SDK、候选截断等模型诊断。

## 固定样本对照

输入均为[上一轮下载的公开代码](aliyun-sites-analysis.md)，未修改业务文件。旧引擎来自主干 a469ee6（分析器 0.4.0）；两引擎均采用默认库存模式、maxSteps=100000、maxCandidates=16、maxDepth=8。

| 同一输入与范围 | 引擎 | 发送位置 | 输出记录 | 求值步数 | 预算中断 |
| --- | --- | ---: | ---: | ---: | --- |
| Nacos 13 个所选文件 | 0.4.0 | 3 | 3 | 100003 | 全局中断，后续文件未扫 |
| 同上 | 0.5.0 | 23 | 22 | 28646 | globalLib.js、ServiceList.js 两个分区中断；其余 11 分区 finished |
| OSS Browser 8 个所选文件 | 0.4.0，上一轮记录 | 0 | 0 | 100011 | 全局中断 |
| 同上 | 0.5.0 | 0 | 0 | 28512 | oss2.js 分区中断；其余 7 分区 finished |

Nacos 再用独立 AST 对四个 reducer 的 23 个发送位置逐个核查，均命中。21 个方法＋路径模板、22 条分支记录、已知字段集合和 hook 后未知状态，与旧版对这四个 reducer 的定向扫描结果一致。相对 URL 的 Host 继续未知，所有接口保留 partial。新增命中来自预算隔离，不代表 globalLib/页面链路、拦截器或整个仓库已解决。

OSS 仍无自动恢复的 HTTP 接口；STS/RAM SDK 模型没有因调度改变而获得支持。完成访问一个文件与提取成功是两个不同指标。

外部文件与报告只留忽略目录。本轮 99 项自动化测试通过，新增 11 项覆盖复杂入口、跨文件计费、补漏保留、全局硬上限、单分区上限、未知状态与 Markdown。既有多框架、动态模块、压缩 JS 和 hook 证据回归仍通过。
