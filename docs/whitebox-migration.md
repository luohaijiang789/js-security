# 白盒独立仓库迁移

## 实际状态

| 项目 | 状态 |
| --- | --- |
| 原始输入 | js-security的`frontend-api-extractor/`，来源Commit `25f46fc` |
| 独立本地Git | `/workspace/frontend-api-extractor`，main分支；设计阶段，无运行代码 |
| 迁移清单 | 新仓`migration-source.json`含来源完整Commit与原文件SHA-256 |
| 独立提交 | `9006f0d`，重新建立白盒独立历史；原历史在js-security保留 |
| 目标远端 | `luohaijiang789/frontend-api-extractor`，默认私有，尚未创建 |
| 阻塞原因 | `gh repo create`访问GitHub API返回Forbidden；现有连接器无建仓能力、无可用浏览器建仓入口 |
| 持久恢复入口 | js-security的独立根目录分支`migration/whitebox-export`；本地另有已验证Git bundle |

导出分支用来在新仓创建受阻时保存独立项目，不把它称为GitHub新仓。主仓保留迁移指针，不继续维护白盒实现或重复计划。本次未改写主仓历史。

## 创建远端后发布

有建仓权限的GitHub入口创建空私有仓库`frontend-api-extractor`（不自动初始化README），再从独立本地仓库执行：

```bash
cd /workspace/frontend-api-extractor
git push -u origin main
git ls-remote origin refs/heads/main
```

核对远端SHA与本地HEAD一致后，将本表远端状态改为完成；在此之前不得称新GitHub仓库已创建。

## 从导出分支恢复

另一台机器可获得完全独立目录：

```bash
git clone --single-branch --branch migration/whitebox-export https://github.com/luohaijiang789/js-security.git frontend-api-extractor
cd frontend-api-extractor
git branch -m main
git remote set-url origin https://github.com/luohaijiang789/frontend-api-extractor.git
```

确认新仓为空且可写后再`git push -u origin main`。分支包含白盒README、AGENTS、需求/架构/算法/验收/计划和迁移来源，不包含浏览器插件/黑盒接收器/采集数据。

本地bundle保存于主仓忽略目录`work/restructure/frontend-api-extractor.bundle`，可用`git clone <bundle路径> <新目录>`恢复；bundle不作为产品依赖提交。

## 主仓迁移验证

后端92项自动化通过；生产插件构建通过。插件全套首次运行178项通过、1项UI样例仍使用旧hash字段失败；改为当前v2的object_id后复跑UI全部10项通过。真实本地HTTP接收测试使用新backend路径通过。主仓和白盒相对链接检查均无失效项；真实MV3、实际远端部署与Agent不在本次通过声明内。
