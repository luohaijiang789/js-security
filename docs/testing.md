# 验证与边界

根目录后端：

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py'
```

插件目录：`npm test`（先构建，再跑单元、真实HTTP、Chromium CDP和替代扩展API的UI）。真实MV3另执行`npm run test:extension`；企业策略不允许时标未验收，不绕过。

| 必测项 | 验证 |
| --- | --- |
| 完整传输 | Unicode/BOM、空值/false/零值、嵌套结构、大事件/JS分块，接收后逐字段和正文相等 |
| 持久恢复 | 多事件同时失败→丢弃内存客户端→重建客户端→全部补传；数据库正文只在有效ACK后清理 |
| 原子账目 | 并发入队/ACK不会覆盖计数；存储失败仍保留内存，恢复后先持久再发送 |
| 丢ACK | 块/完整提交/事件ACK丢失均幂等，重启不改变上传或事件身份 |
| 停止核对 | 连续序号、分类数、事件字节、对象存在性不符返回409；假封账回执不能完成 |
| 版本 | 同URL不同源内容必须重新读取；不同接收服务器/分类不混用索引；观察独立 |
| 自动分析 | 真实HTTP→固定水位快照→真实jshound→结果HTTP；后续事件不进入旧run，临时备份清理 |
| 浏览器范围 | 当前/新页、导航、frame/Worker、JS背压API继续、暂停/恢复/后台/退出 |
| 结果 | 实测/静态分开、候选与未知可见、API参数/JS/Gap回查，失败不伪装空成功 |

tests/test_delivery.py覆盖服务端分类账/封账，test_jobs.py覆盖真实HTTP自动提取，插件delivery-recovery.test.ts覆盖持久队列和重启补传。原资产/引用/Worker/静态核心测试继续保留；旧/v0服务及其专用测试已删除。

冻结样本的召回/精确率、调用实例正确性和性能门槛仍按analysis-design.md独立核验，不从本轮传输测试推断“任意网站100%提取”。实际服务器、目标Chrome版本、磁盘配额和长时压力需另存可复核证据。

## 当前验证结果

根目录后端全套90项通过；插件全套181项通过，另新增后端API/参数/JS证据/缺口结果界面用例单独通过。插件0.8.0构建及后端0.6.0 wheel构建通过。真实MV3脚本已执行，但当前Chromium企业策略禁止自定义扩展，因此该项仍未验收；没有修改策略。

本轮新增：test_recursive_pipeline.py以真实本地HTTP链验证默认5层、循环/超层、显式CDN、离线缺口及分析前冻结；test_snapshot_export.py验证导出期间新增接收不受整库锁阻塞且固定水位不变；test_delivery.py验证坏块/完整摘要/事件摘要拒绝。插件evidence-db.test.ts验证v1待传迁移、索引不带正文、ACK清理；capture-accounting.test.ts验证突发批量持久计数及实例重建恢复；delivery-recovery.test.ts覆盖错误摘要回执拒绝。

## 2026-11-05 本轮验证

后端完整回归97项通过；插件22个测试文件、187项通过（含真实HTTP、Chromium CDP和替代扩展API的UI），TypeScript/Vue构建通过。后端0.7.0 wheel构建与入口/必需资源检查通过，插件版本0.9.0；wire保持capture-stream-2。真实MV3 test:extension被当前Chromium企业策略阻止，未绕过；尚无目标环境长期压力/配额验收。
