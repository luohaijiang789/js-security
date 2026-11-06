# 黑盒 API 与 JS 采集分析后端

后端是本仓库主工程，浏览器只有一个生产插件。插件填写服务器地址，分类上传API实测、JS、上下文和加载证据；后端持久接收、核对传输账目、递归收集后统一分析，插件查看API清单、参数/JS证据及缺口。

## 快速运行

后端需要Python 3.10+；静态分析还需要Node.js 18+和固定jshound源码（开发/插件构建推荐Node 22.12+）：

```bash
git submodule update --init references/repos/jshound
python3 server.py
```

默认监听`0.0.0.0:8379`，数据在`data/capture/`。用`--host`、`--port`、`--data-dir`覆盖；`--no-analysis`只接收。Python接收器无额外依赖。`curl http://127.0.0.1:8379/health`检查运行状态。

```bash
cd browser-extension
npm ci
npm run build
```

在Chrome开发者模式加载`browser-extension/dist/`。新建任务开启“远端采集JS和请求”，填写`http://服务器IP:8379`；同机使用`http://127.0.0.1:8379`。code/default项目内置，无需手填令牌、扩展ID或项目。

用户正常登录和操作，所有窗口HTTP/HTTPS网页及新页/导航自动接入。插件“JS探索”页持续显示接收证据、传输账目和分析结果，也可立即分析、查看参数/JS证据和导出JSON。静态结果仍是文件级候选，不是已证明的精确调用点。

## 传输如何核对

1. 新远端任务先把原始CDP通知及四类证据读取命令的发起/结果写临时日志，再与分类账同事务搬入待传；原始通知与已取得的命令结果完整上传，Filter/字段选择仅影响整理视图，任务界面可关闭原始日志。旧任务保持原范围。分类事件与完整正文先原子写入临时IndexedDB待传队列，再上传；未写成功不发送，保留内存重试并暂停。
2. 正文分块，发送端计算块/完整正文/事件SHA-256，服务端独立校验并持久ACK，插件逐项核对回执；事件按任务传输流连续编号，重复提交幂等。
3. 仅在有效ACK后，以同一浏览器事务更新确认账目并删除临时正文。浏览器重启后点击恢复，先补传，再重新接入页面。
4. 停止时后端核对连续序号、分类数量、事件字节数和对象存在性，封账成功才结束任务；核对不一致不显示完成。
5. 新接收端自动协商4路并发（大项最多3），保留小事件通道；64项乱序窗口内逐条确认，连续前缀到齐后进入分析，有缺口仍不能封账。旧接收端串行回退。
6. 原始日志与整理记录关联，缺少整理记录时后端恢复请求/响应/栈及已保存的源JS/正文/父栈，明确标记未取得结果；已有整理记录不重复计数。日志移交/待传/ACK分开核对，数量、字节、通知分类不符不封账。
7. JS每个解析观察都读取正文，不再按项目+URL跳过。同URL换版不会漏读；服务端按完整内容去重、保留独立观察。

这保证“已接纳且成功持久化的待传数据可恢复补传，并能核对是否全部确认”，不等于Chrome一定提供了全部网站信息。暂停/未附加窗口、正文不可得、配额或队列超限、硬件损坏等明确列为缺口，不显示100%全站覆盖。默认待确认上限4096项/256MiB，JS单文件64MiB；超限暂停/记缺口，不静默截断。需要原值完整时选择完整保留，采集字段/Filter范围在任务配置可见。

## 后端流程与目录

接收与分析解耦；已持久事件合并触发选中任务/水位的证据导出，不再备份整库。以已捕获JS为种子D1，默认递归至D5，收集结算后写入不可变资产清单，再统一静态提取、实测关联；新增浏览器事件进入下一批。插件可配置深度、关闭补取、增加允许的CDN来源。后端不自动继承浏览器登录Cookie，缺失资源和预算耗尽保留缺口。当前按批次重算，不声称已实现依赖增量索引；模型未配置，不默认向AI发送采集数据。

```text
server.py / pyproject.toml        后端入口和独立Python包
src/website_js_extractor/
  domain/ storage/ api/           领域、证据持久存储、HTTP
  application/ ingestion/        作业编排、浏览器证据适配
  collection/ analysis/          递归收集、冻结输入、jshound分析
browser-extension/               唯一Chrome插件、临时待传队列和结果工作台
tests/                          后端单元、真实HTTP及自动分析验证
docs/                           架构、协议、使用边界与唯一计划
references/                     固定jshound及工具依据
data/                           运行数据（不提交Git）
```

legacy、旧独立JS插件、旧探索导入页、独占取源RPC与/v0配对服务已删除。白盒已移出当前产品，历史通过Git追溯。

验证：`PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py'`；插件目录执行`npm test`。真实MV3现场检查使用`npm run test:extension`，企业策略禁止时不绕过。

细节：[代码架构与目录](docs/code-architecture.md)、[架构](docs/architecture.md)、[传输协议](docs/protocol.md)、[并发窗口](docs/delivery-window.md)、[原始日志与重放](docs/capture-journal.md)、[模块](docs/modules.md)、[唯一计划](docs/plan.md)、[测试](docs/testing.md)、[第三方许可](THIRD_PARTY_NOTICES.md)。
