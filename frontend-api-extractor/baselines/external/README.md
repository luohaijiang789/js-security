# 固定外部源码切片与人工标注

0.8.3，2026-10-28。本目录只保留自写 manifest、人工预期和来源链接，不收录第三方源码、依赖或构建产物。它们是已参与分析的回归切片，不是未见过的盲测集。

| 切片 | 固定源码 | 冻结文件/入口 | 人工预期 |
| --- | --- | --- | --- |
| GDB | [aliyun/alibabacloud-gdb-console @ 49336db](https://github.com/aliyun/alibabacloud-gdb-console/tree/49336dbcc958236e233a921f60353802cbd43130) | 1 文件/1 入口 | [3 个发送点、4 条候选](gdb.expected.json) |
| Nacos | [alibaba/nacos @ d45ce3b](https://github.com/alibaba/nacos/tree/d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce) | 7 文件/2 reducer 入口 | [14 个发送点、14 条候选](nacos.expected.json) |
| OSS Browser | [aliyun/oss-browser @ 922153a](https://github.com/aliyun/oss-browser/tree/922153a57efae80185be7fd645760b791ea7ff90) | 3 文件/3 入口 | [1 个未解析发送点、4 个条件组合](oss.expected.json) |

manifest 中 commit/path 定位原始文件，SHA-256 固定文件字节；expectedSha256 固定人工预期。source-root 可以是本地 checkout 或只包含上述文件的快照，但必须保留完整仓内相对路径。无需安装/构建外部仓库。只下载 manifest 所列文件即可，URL 为 https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{path}；文件应放在 work/ 等忽略目录。验证器只读本地输入，不自动下载。

在提取器目录运行（替换为本地固定源码根目录）：

```bash
npm run verify:external -- --manifest baselines/external/gdb.json --source-root ../work/external-sources/gdb --out ../work/external-results/gdb.json
npm run verify:external -- --manifest baselines/external/nacos.json --source-root ../work/external-sources/nacos --out ../work/external-results/nacos.json
npm run verify:external -- --manifest baselines/external/oss.json --source-root ../work/external-sources/oss --out ../work/external-results/oss.json
```

## 人工标注规则

逐行阅读固定源码，指定发送位置、方法、Host/URL、Query/Body/Header、字段路径、条件、解析状态与应保留的缺口。明确未知用 {"$unknown":true}，与 null（已知无显式字段）分开。对象结构及已知字段路径精确匹配，多出或漏掉字段均失败；不从参数名、注释或类型补造运行时对象。

- GDB：第 33 行按条件区分 type=gremlin/cypher；第 55 行 Promise 回调捕获可变 type 是已知模型缺口，当前要求未知。后者的源码语义仍有两种条件值，未知预期只约束降级行为，不能算字段值恢复成功。connect 的 conn 字段名已知、值未知。
- Nacos：核对 authority.js 全部 13 个 request 调用和 namespace.js 的 1 个调用。字面量 username/password/newPassword/role/resource/action 等字段按载体标注；getUsers 等传入整体 params、deleteRole 的 params:role、deletePermission 的 params:permission 都保持载体未知。request hook 中可能增加的 username/accessToken/编码结果不冒充调用处参数。
- OSS：第 24 行 $http(opt) 是显式配置客户端下的未解析发送候选；第 16、20 行两个独立条件按四种组合分别保留。整个 opt 未绑定，Query/Body/Header 均未知，不能解释为没有参数。$http 配置不是 AngularJS DI 自动推导。
- STS/RAM endpoint 与 SDK 操作只放 manualFindings，是人工发现、未自动恢复 HTTP 的缺口。它们不进入请求表，也不计入自动 HTTP 恢复成功。

每条预期有本地标注 ID、源位置和依据；条件精确配对，不使用接口总数替代逐项验证。ID 仅用于该基准，统一交付的资产/字段/缺口 ID 见[协议2.0](../../docs/delivery-protocol.md)，不能替换这里的人工标注身份。人工标注不从分析器输出自动更新；修改预期须解释源码语义或已登记模型限制，更新哈希并重新评审。

## 执行与边界

先检查预期/源码哈希、路径和文件预算，再把冻结文件复制到临时隔离目录分析；额外源码、tsconfig、目标 JSON 配置及依赖不会混入。强制只分析冻结文件、关闭资产补漏和 hook 求值，保留 manifest 中的入口/预算/显式客户端规则。单源文件 4 MiB、总源文件 16 MiB、最多 100 文件；每次运行记录实际配置、原始报告、诊断和逐条检查，临时目录最终删除。

输出包含 validationPassed（符合本切片预期）与 extractionComplete（当前分析器的完整性）两个独立状态。新增/丢失/重复/歧义候选、字段不符、缺口消失、hook 状态不符或完整性不符都会使验证失败。退出 0=预期通过、1=预期不匹配、2=输入/运行失败；--out 生成 JSON、同路径追加 .csv/.md 的请求表。

哈希证明输入与冻结快照一致，不证明用户整个 checkout 的 HEAD；验证器不会自行 checkout、更改或执行目标仓库。只在限定文件/入口/请求机制及模型预期内解释结果，不提供全仓准确率，也不代表线上部署或运行时流量。

本轮实际结果、发现与回归见[外部基准验证](../../docs/external-baselines.md)。
