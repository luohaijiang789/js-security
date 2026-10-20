# 后续工程：按透传调查产物建设

所有模块服务[前端 JS 跨境透传项目目的](../AGENTS.md)，工作进度按[Checklist](../deliverables/项目Checklist.md)。当前未实现扫描器。

| 模块 | 负责产物 | 不在此重复维护 |
|---|---|---|
| [blackbox](blackbox/README.md) | 实际场景/脚本/接口/字段及验证状态 | 黑盒操作步骤见交付稿 |
| [whitebox](whitebox/README.md) | 机制、字段路径、反查解释与修改点 | 白盒操作步骤见交付稿 |
| [correlation](correlation/README.md) | 共同身份、关联依据、差异与任务契约 | 不用一个状态覆盖两侧证据 |
| [ai-agents](ai-agents/README.md) | 使用相同契约的任务辅助、复核与评估 | 不另造模型判定体系 |

先以人工/表格验证接口，再实现重复步骤。GH-01～GH-04 的证据与规格见[GitHub 核查](../references/06-开源项目/GitHub方案核查.md)。不提前创建空工程、选图数据库或承诺已覆盖全部 JS。

每个产物都带案件/版本、证据和明确状态；原始敏感证据进入批准的受限存储，目录只保存脱敏结果与引用。
