# 前端 API 与请求参数自动化提取

**通过一套白盒、两套黑盒收集前端 API 与请求参数，保留代码依据、实际观察和未知项，统一交付 `api_assets.xlsx`。**

## 项目背景

本项目起源于阿里云美国独立站的数据出境排查需求。美国第 14117 号行政令（EO 14117）及其配套数据安全规则，重点关注受关注国家或相关主体获取美国人的批量敏感个人数据和特定政府相关数据所带来的国家安全风险。为降低相关数据被不当访问或跨境传输的风险，阿里云在美国部署并运营独立站，使面向美国用户的业务和数据处理能够在相对独立的环境中运行。

独立部署并不意味着前端数据流向已经天然清晰。业务规模大、系统和代码仓数量多，历史埋点、监控 SDK、第三方依赖、公共请求封装及遗留逻辑可能仍会发起网络请求；部分请求还可能携带个人信息或其他业务数据，发送至独立站范围之外的服务，甚至流向其他国家或地区。仅靠人工逐仓检查，很难持续、完整地识别这些请求及其参数。

因此，本项目面向所有相关前端代码仓和线上页面，建立三种互补的排查入口：一是对白盒代码仓进行静态分析，发现代码中声明但未必在测试场景触发的请求；二是通过浏览器插件采集真实流量、参数和调用栈；三是从网站收集已部署的 JS，再进行静态分析，以覆盖缺少对应源码仓或线上版本不一致的场景。三种入口共用同一结果模型，相互补充并保留各自证据。

第一阶段聚焦资产与信息收集：尽可能收集全部前端 API、Host、请求方法、发送参数、代码位置、调用关系及未解析项，形成可追溯的 Excel API 资产表。此阶段不做 Host 筛选、敏感性识别、风险分级或合规结论；这些工作建立在资产清单和证据足够完整之后。

## 三个方案

| 方案 | 做法 | 本轮边界 |
|---|---|---|
| [前端代码仓 API 提取（白盒）](frontend-api-extractor/README.md) | 固定仓库并构建 JS，分析嵌套引用，提取 URL、参数、Host、JS 文件 | 旧实现已删除，当前先完成新架构、测试基线和实施计划 |
| [JS 请求采集浏览器插件（黑盒一）](browser-extension/docs/requirements.md) | 自研 MV3 插件，当前浏览器所有窗口中的 HTTP/HTTPS 网页自动接入，Filter 控制留存，CDP 记录真实请求及可取得调用栈 | 只覆盖实际触发且可观测场景；采集缺失明确记录 |
| [网站 JS 收集与静态分析（黑盒二）](website-js-extractor/README.md) | 独立 MV3 插件收集 JS 与上下文，本地服务静态分析 | 已有可构建插件/本机服务原型与 0.5 分析核心；真实 MV3、补抓和黑盒一集成仍待完成 |

当前先推进黑盒二的网站 JS 分析核心，再由白盒接入仓库构建资产。白盒尚无可运行实现，黑盒二已有插件/HTTP 原型，真实 MV3 现场受策略阻止；[命令行分析入口](website-js-extractor/docs/usage.md)已支持离线分析、引用图和受控并发补取/恢复，黑盒一已有独立 MV3 插件。各工程当前状态以其 README 和开发计划为准。

三路可以独立运行。结果分别标记“仓库静态 / 网站 JS 静态 / 插件实测”，可关联而不抹平版本、调用和字段差异。工作簿包含 API 总表、参数明细、分析缺口，另保留 `analysis.json` 证据底稿。

## 前端代码仓 API 提取

[frontend-api-extractor](frontend-api-extractor/README.md) 的主目标是输入仓库、固定版本、正式构建、分析产物与嵌套 JS，输出四项主信息及代码依据。旧代码和旧测试已删除，当前先评审[架构](frontend-api-extractor/docs/architecture.md)、冻结[测试输入](frontend-api-extractor/docs/testing.md)，再按[实施计划](frontend-api-extractor/docs/plan.md)逐项编码和验收。

## 文档与目录

从[文档导航](docs/README.md)开始；[总方案](docs/overview.md)说明整体关系，[交付约定](docs/delivery.md)说明统一模型，[验证计划](docs/validation.md)列出下一步。[工具与项目评估](references/README.md)记录三个方案的候选组件、许可证和推荐验证组合。

用户确认的参考范围见[六个参考项目](references/已确认参考项目.md)：EASYapi、maksimu/openapi-devtools、mitmproxy2swagger、Akto、BurpAPIFinder（有 bug，需要维护）和 jshound。

六个仓库已作为子模块放入 [references/repos](references/repos/README.md)。首次获取完整项目使用：

```bash
git clone --recurse-submodules https://github.com/luohaijiang789/js-security.git
```

已有本项目时运行 `git submodule update --init --recursive` 获取参考源码。

```text
js-security/
├── README.md / AGENTS.md   # 项目介绍与工作约定
├── docs/                  # 当前方案、交付规则、验证计划
├── references/            # 工具、插件、项目评估与固定核查依据
├── website-js-extractor/ # 黑盒二统一工程：分析核心、命令行、测试及插件/服务设计
├── frontend-api-extractor/ # 白盒提取器新架构与实施计划，后续接入分析核心
└── browser-extension/     # 独立浏览器插件工程（依赖、源码、构建、测试）
    ├── src/               # MV3 后台、管理标签页、详情侧栏与采集模块
    ├── tests/             # 核心、转存、真实 CDP、页面与现场测试
    └── dist/              # 构建输出，Chrome 加载此目录
```

插件工程独立放在 [browser-extension](browser-extension/README.md)，仓库根目录保留给三路方案及共享文档，不在根目录安装插件依赖。构建环境使用 Node.js `20.19+` 或 `22.12+`。从仓库根目录执行：

```bash
cd browser-extension
npm ci
npm run build
```

Chrome 开发者模式加载 **`browser-extension/dist/`**。点击浏览器工具栏插件图标直接打开管理标签页；点击请求行即可在右侧查看参数、请求头、正文、调用栈和原始数据。此前从根目录 `dist/` 安装的用户，请先阅读[旧任务保留与升级说明](browser-extension/docs/ui.md)，加载路径改变不会自动迁移扩展本地数据。

在 `browser-extension/` 内执行 `npm test` 验证核心、转存、真实 Chromium CDP 和界面；受控样例不当作用户真实资产结果。当前云环境企业策略禁止安装扩展，因此 MV3 现场加载、子目标覆盖和正式压力验收仍待目标 Chrome 执行；其余两路继续验证成熟工具。
