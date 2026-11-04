# 白盒已拆分

白盒的设计、工作规则和计划已导出为独立本地Git仓库，不再在本仓子目录维护第二份源码。

- 本地仓库：`/workspace/frontend-api-extractor`，独立`main`分支。
- 目标GitHub仓库：`luohaijiang789/frontend-api-extractor`，默认私有；创建请求返回`Forbidden`，远端创建/推送尚未完成。
- 可恢复导出分支：[migration/whitebox-export](https://github.com/luohaijiang789/js-security/tree/migration/whitebox-export)。它使用白盒独立根目录和独立提交，可复制到新仓；不是第二个生产模块。
- [迁移状态及恢复步骤](../docs/whitebox-migration.md)。原子目录历史仍在原仓Git提交中保留。

本文件只作迁移指引，白盒后续设计/实现以独立仓库为准。
