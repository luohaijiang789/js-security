# 验证与交付规则

当前能力与未实现项以[计划](plan.md)为准。目录重整只证明路径/入口可用，不等于远端部署、模型接入、精确提取或真实MV3通过。

## 执行入口

在仓库根目录：

```bash
PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p 'test_*.py'
cd browser-extension
npm test
```

npm test先构建，包含单元、真实本地HTTP、普通Chromium CDP及UI测试；替代Chrome扩展API的测试不能算实际MV3。实际插件现场需允许自定义扩展的目标Chrome，运行插件`npm run test:extension`并记录OS/Chrome/扩展版本及任务。企业策略禁止时标未验收，不绕过。

固定核心/样本验证入口保留backend/tests/check_baseline.py、check_collection.py、check_collection_load.py、check_workers.py及对应manifest；外部正文/完整报告在work/，缺少冻结输入时报告未执行，不另抓浮动网页冒充。

## 必测矩阵

| 范围 | 正例 | 反例/完成条件 |
| --- | --- | --- |
| 分类与协议 | 五类事件、Unicode/零值/false/空值、正文分块 | 未知类别、缺块、长度冲突、损坏/缺对象拒绝；持久ACK匹配身份 |
| 去重与版本 | 相同正文多观察、同事件重试、提交回执 | 同URL换版、跨后端/任务旧标记失效；URL索引不是内容身份 |
| 采集与会话 | 当前/新网页、导航、frame/Worker、API+JS同时采集 | JS队列满API继续，暂停/停止只释放自身租约，DevTools冲突不抢占 |
| 内存与断线 | 有界队列、ACK后释放、同会话重试 | 退出未确认登记缺口；不偷偷新增JS正文落盘 |
| 输入归一化 | 事件→上下文/资产/加载/实测 | 缺基址/父链、重定向、同scriptId跨目标、歧义不猜 |
| 批次作业 | 固定水位/manifest、自动触发、取消/恢复 | 新事件不改旧输入；ACK不等待分析；全量重跑不叫增量索引 |
| JS提取 | fetch/XHR/Axios/beacon、SDK、跨模块wrapper | 同名非网络函数、两client、两调用、未知hook、字段覆盖/删除不串线 |
| 实测关联 | 同版本有依据匹配、static-only/observed-only | 相同路径多候选不强匹配；实测次数与静态候选分开 |
| Agent | 受控wrapper→工具→建议→核验 | 编造位置、提示注入、未知副作用拒绝；无模型/模型超时不阻塞接收或静态流程 |
| 结果导出 | 同源JSON/CSV/未来Excel与证据 | 不丢变体/缺口，外部字符串按文本，长内容/分片可复核 |
| 仓库迁移 | 新目录构建/后端/HTTP、独立白盒清单/链接/bundle | 不改wire/包身份，不丢旧源码/用户库；GitHub未创建不称已发布 |

## 效果与性能

先固定受控样本、公开开发集和独立盲测集的版本/正文哈希/人工预期。基线统计发送点召回/精确率、四项字段恢复、调用/实例误归属、资产处理账目、缺口、耗时/峰值内存；不从工具输出反推预期。

按目标机冻结预算和数值门槛后再盲测，不为过关删除失败输入。严重实例/位置误归属、未处理资产冒充完整成功、缺块内容冒充完整正文是硬失败。不能声明任意网站全覆盖。

Agent另记录provider/model、prompt/tool/验证器版本、输入哈希、轮次/token/时间、格式失败与核验接受率；模型置信分不是事实准确率。
