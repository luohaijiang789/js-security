# 白盒独立仓库

迁移已完成。白盒后续需求、设计、计划和实现统一在 [frontend-api-extractor](https://github.com/luohaijiang789/frontend-api-extractor) 维护；本仓只负责黑盒插件和分析后端，不维护第二份白盒内容。

| 项目 | 状态 |
| --- | --- |
| 正式仓库 | https://github.com/luohaijiang789/frontend-api-extractor |
| 发布分支/提交 | main / `3bfe6ca` |
| 原始来源 | js-security的frontend-api-extractor子目录，来源Commit `25f46fc` |
| 来源校验 | 新仓migration-source.json保存完整来源Commit及原文件SHA-256 |
| 独立历史 | `9006f0d`为独立根提交；原子目录历史继续保留在js-security |
| 当前能力 | 设计阶段，尚无可运行白盒CLI/服务；黑盒能力不算白盒已实现 |
| 历史备份 | migration/whitebox-export仅作迁移备份，后续不在该分支开发 |

获取白盒项目：

```bash
git clone https://github.com/luohaijiang789/frontend-api-extractor.git
```

浏览器插件、黑盒接收器及采集数据没有迁入白盒仓库。本地独立工作区为`/workspace/frontend-api-extractor`，已跟踪新仓origin/main。此前GitHub建仓权限阻塞已由用户创建仓库解决。
