# 固定基准与逐调用差异

0.8.2，2026-10-28。落实[实施清单](../../archive/planning/implementation-through-0.10.md) P0-01～03；P0 的外部人工标注、独立验证集、统一 ID 和性能基线尚未完成。

在提取器目录运行：

```bash
npm run verify:baseline -- --out ../work/baselines/core.json
npm run compare:requests -- --expected ../work/baselines/gdb-before.json --actual ../work/baselines/gdb-after.json --out ../work/baselines/gdb-diff.json
```

第一条开箱复跑仓库自带的[自写小型基准](../../../examples/request-baseline/README.md)，输入哈希不符、未登记脚本、预期或完整性不匹配即失败，不安装/构建/执行样例业务。--manifest 可指定其他 authored-regression manifest，脚本与 expected.json 都须登记哈希。预期人工编写，工具没有自动更新预期选项。

第二条比较已有请求表 JSON：接受行数组或带 rows 的对象；构建任务 analysis.json 可直接输入。示例 GDB 文件为本地验证报告，不随 Git 分发，外部报告需自行生成。输出 JSON 和同路径追加 .md 的人读报告。比较成功退出 0，有差异退出 1，输入失败退出 2。--out 不指定时只输出 JSON。

## 比较规则

| 内容 | 处理 |
| --- | --- |
| 配对 | 仓库/Commit/部署上下文、源码发送位置、条件、阶段和调用链组成限定锚点；URL/方法/参数不作为锚点，变化才能被发现 |
| 相同调用 | 比较来源/发现依据、方法、Host/依据/状态、URL、Query/Body/Header、字段路径/状态、解析状态、产物位置/版本匹配和缺口 |
| 顺序 | 对象键、条件、字段列表和缺口列表顺序不影响语义；数组载荷顺序仍保留 |
| 重复与歧义 | 保留多重集合；先消去完全相同项，剩余多个不相同候选标记 ambiguous，不任意连线 |
| 变未知 | 列出已知 Host/解析 URL 变 null、确定值变动态标记等路径；字段删除仍为结构变化，不冒充动态值 |
| 分析状态 | 输入包含相应证据时，核对 stats.complete、分区状态/原因、诊断代码/位置、任务/构建缺口；不能用相同表格掩盖预算中断 |
| 上下文/成本 | 顶层与行内仓库/Commit/部署变化提示上下文差异；记录前后求值步数，单纯步数变化不自动判语义失败 |

该锚点不是永久资产 ID：代码位置/调用链变化会显示新增和丢失，不能直接用来对齐任意两个 Commit。诊断比较不含自然语言消息；不比较耗时、RSS、对象完整改写历史或尚未输入的运行证据。只传行数组就无法验证报告级完整性。跨协议版本需要先声明映射，本版不提供通用迁移。

## 本轮验证

- 自写基准：3 个调用，跨文件两次 POST 快照 id=7/8；已删除 old 字段不能恢复，另一个相对 GET 保留 Header/URL Query 字段和未知 Host。脚本和人工预期有 SHA-256，完整性预期为 true。
- GDB：沿用[固定 Commit/构建产物](../../archive/validation/gdb-build-pilot.md)，逐一核对 4 个 JS 的哈希后重新分析。历史原始分析证据与本轮原始分析证据均用当前表格协议导出再比较；得到 4 行 unchanged，新增/丢失/变化/歧义/变未知均为 0，31672 步不变。完整性仍为 false，两处分区预算中断等旧缺口保留。
- GDB 是同版历史回归，不能证明跨 Schema 迁移或相对人工答案的全仓准确率。未重新安装/构建或访问业务 API。原始代码/报告留在 work/baselines/ 等忽略目录。
- 180 项自动化测试通过；新增 10 项覆盖手工预期、篡改/漏登记、逐字段差异、重复、多候选、上下文、条件/hook/调用链隔离、完整性/预算诊断与 CLI 退出码。
