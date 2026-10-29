# 交付协议 2.0.0

0.9 将源码、构建、网站脚本和插件实测适配到统一底稿；实现见 [delivery.js](../src/delivery.js)、[xlsx.js](../src/xlsx.js)，验收见 [delivery.test.js](../test/delivery.test.js)。这是交付协议版本，旧引擎 schemaVersion=1 不变。

| 顶层字段 | 内容 |
| --- | --- |
| schemaVersion / modelVersion | `2.0.0` / 引擎名称及版本 |
| scope | repository、commit、mode、complete；有任何缺口不得完整 |
| records | 逐调用、逐条件、逐阶段或逐次观察；身份、目标、方法、位置、独立载体状态、证据和缺口引用 |
| parameters | recordId、carrier、字段 path 数组、entryIndex、stage、conditions、state；重复字段保留多行 |
| gaps | 可关联请求或仅为资产/任务缺口，不要求存在已发现接口 |
| assets / evidence | 资产原始 ID/哈希/上下文与原始行依据；原始值只在 JSON 保存 |
| annotations / sourceReport | 独立 AI 释义与原始分析底稿；不覆盖静态或实测字段 |

三种 sourceKind 为 repository-static、website-js-static、plugin-observed。SDK 协议恢复使用 sdk-protocol-build 阶段；未应用 hook 字段为 unapplied-request-hook 候选。它们都不是已发送的请求。

## ID 与兼容

ID 使用规范化对象键顺序后的 SHA-256 前 24 位，分别以 record/field/gap/evidence/asset/call/group 为前缀。数组顺序保留。0.9.4 起 migration.identityVersion=call-site-v2：callSiteId 锚定来源、仓库/版本、发送位置、业务调用位置、部署/执行上下文和脚本哈希；不含阶段、条件、参数值和 entry 枚举。recordId 另包括阶段、条件、调用链、entry、方法、URL、三个载体的快照。缺 identityVersion 的旧底稿按旧身份规则解释，不与新 ID 直接合并；应从旧原始报告重生成或重新扫描。同样快照重复出现用 occurrence 区分，不吞掉重复记录。fieldId 包含所属 record、载体、path、阶段、状态和重复项索引；值或条件变化可能改变 ID。**不承诺跨引擎升级、跨版本、跨重排的永久身份**，同版语义变化继续使用独立 diff 工具。

apiGroupId 按 Method/Host/可知Path形成关联候选；Path未知时使用原始请求URL模板区分候选，associationState 固定 candidate-only；同 URL 不提升任何其他记录的完整性或版本关系。

当前读入精确 `2.0.0`；旧 `1`/`"1"` 或无版本 rows/endpoints/observations 通过显式适配，migration 记录旧版本和策略。未知版本拒绝，不猜来源、Commit 或字段。未来新增可选字段保留并需测试；不兼容的结构或无法判别的语义变化须升级主版本并提供迁移。身份算法单独用 migration.identityVersion 标识；本轮显式修正历史调用ID混入条件的行为，Schema仍精确2.0.0，禁止跨身份版本直接比对或归组。当前没有宣称支持所有 `2.x`。

已实现引用/来源/字段类型检查；它不是完整 JSON Schema 通用验证器。资产级诊断不强行猜测到某条请求。精确字节哈希用于追溯，不作为代码可信证明。

## Excel 与插件包

`api_assets.xlsx` 包含 API总表、参数明细、分析缺口，使用 inlineStr 文本，不创建公式。URL 保留路径与 Query 字段名，Query 原值省略；Header/Body 原值不进入工作簿，原始底稿仍可能含敏感值，需自行按共享范围保管。超长内容写 workbookEvidence，Excel 放引用；超过行数上限分表，超过总字节预算明确失败。

```bash
node src/delivery-cli.js --input /path/to/old-analysis.json --out ../work/delivery
node src/delivery-cli.js --input /path/to/unpacked-plugin-task --out ../work/observed-delivery
```

插件导入支持实际 scan_manifest.json/manifest.json 的 0.1.0/0.3.0 及 JSONL；校验分片路径、哈希、计数、任务身份，64 MiB 上限。ZIP 请先解包；不将归并包当完整原始观察。参数未采集与静态未知不同，captureStates、protection、redirectHop/session/request ID 独立保留。

## 0.9.1兼容补充

records新增可选linkState：entry-trace / function-inventory / unlinked；发现依据也进入discoveryBasis。缺字段的历史结果保持未知，不推断已连通入口。Excel新增定位依据/阶段；使用标准DEFLATE，无新增依赖，JSON内容与证据不变。匹配编译库契约的原始行证据含clientModel，其参考版本不等于已证明安装版本，记录保留partial。详见[验收](release-0.9.1.md)。

## 0.9.4 附加字段

scope.coverage/outcome与旧complete独立，区分分区扫描状态和模型缺口。records增加businessCallSite、sendMechanism、requestUrl；未知不补造。共享请求缺口有recordIds，单条关联仍填recordId，多条时recordId=null并保留完整recordIds，记录的gapIds反向引用不变。Excel源码仍表示发送点，业务调用点另列；主表Query/Body/Header字段仅汇总已知名称，需结合载体状态及参数明细阅读。

## 0.10 外部索引候选

仍使用repository-static来源；discoveryBasis=jshound-indexed、stage=external-inventory，linkState=null。外部字段保持部分/未知，未提供行列时为null，Excel定位依据明确“jshound启发式候选（未核验）”。hybrid的语义行保留原始linkState，未核验/补充字段行独立保存；不是浏览器实测。externalEngine记录固定引擎/适配器哈希、原始输出哈希和本地任务路径，原始rows关联不冒充Schema2交付recordId。
