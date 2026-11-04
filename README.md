# 浏览器采集与后端分析平台

本仓库负责黑盒链路：**一个Chrome插件收集API实测、JS和上下文，发送到配置的服务器；后端统一存储、关联、提取并接入Agent。** 白盒源码扫描与正式构建迁往独立Git仓库，实际状态见[白盒迁移](docs/whitebox-migration.md)。

项目用于前端API和请求参数排查，交付URL、Host、参数、JS依据和缺口，当前阶段不输出敏感性、风险分级或合规结论。

```mermaid
flowchart LR
 A[一个生产插件] -->|API / JS / 上下文 / 加载证据| B[配置的服务器IP:端口]
 B --> C[分类接收、对象与事件存储]
 C --> D[分析调度、静态提取与实测关联]
 D --> E[Agent工具调用与证据核验]
 E --> F[API资产、参数、JS证据、缺口与报告]
```

接收、持久确认和离线分析已有实现；自动调度、增量分析、Agent及统一结果回传仍待实现，不因目录整理而算完成。

## 工程与运行

| 位置 | 职责 | 当前状态 |
| --- | --- | --- |
| [browser-extension/](browser-extension/README.md) | 唯一生产插件；TypeScript/Vue、共享CDP连接 | 已有请求、JS、上下文采集及远端传输，真实MV3仍待现场 |
| [backend/](backend/README.md) | Python接收/存储/编排，Node/Babel/jshound分析 | 接收及离线ingest已有，持续作业、精确绑定、Agent未完成 |
| [docs/](docs/README.md) | 系统边界、设计与迁移 | 当前设计入口 |
| [references/](references/README.md) | 固定第三方源码、实验与采用依据 | 不混入产品业务代码 |
| [legacy/](legacy/README.md) | 旧独立JS插件 | 只作迁移/回归材料，不交付第二个插件 |

启动后端（Python 3.10+，无额外Python依赖）：

```bash
python3 backend/server.py
```

默认监听`0.0.0.0:8379`。插件开启远端采集，只填`http://服务器IP:8379`；同机测试用`http://127.0.0.1:8379`。当前内置code/default项目，无需手填令牌或扩展ID；固定code是协议匹配值，不是用户身份凭证。本次不部署未知服务器。

构建唯一插件（Node.js 20.19+或22.12+）：

```bash
cd browser-extension
npm ci
npm run build
```

Chrome加载`browser-extension/dist/`。远端模式JS/请求正文只走有界内存，持久ACK后释放；离线、队列满、退出未确认内容登记缺口，不承诺零丢失。旧任务、本地请求导出与SLS保留兼容。

## 设计与实施入口

- [总览](docs/overview.md)：仓库划分、分类信息和端到端分工。
- [后端架构](backend/docs/architecture.md)：语言、进程、数据和依赖。
- [模块交付](backend/docs/modules.md)：输入、输出、代码落点和完成条件。
- [Agent设计](backend/docs/agent.md)：工具、模型、证据核验与降级；尚未实现。
- [实际协议](backend/docs/protocol.md)：capture-stream-2及旧格式兼容。
- [唯一计划](backend/docs/plan.md)：现有代码与待完成工作。

第三方源码执行`git submodule update --init --recursive`获取。分析默认离线，不执行取得的JS、不主动调用提取API；实测、静态和模型建议分别保留证据。
