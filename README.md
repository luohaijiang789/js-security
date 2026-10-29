# 前端 API 与请求参数自动化提取

**通过一套白盒、两套黑盒收集前端 API 与请求参数，保留代码依据、实际观察和未知项，统一交付 `api_assets.xlsx`。**

项目起于阿里云美国独立站的前端 JS 数据跨境排查。第一阶段只做资产发现与提取，不做 Host 筛选、敏感性识别、风险分级或合规判断。

## 三个方案

| 方案 | 做法 | 本轮边界 |
|---|---|---|
| [前端代码仓 API 提取（白盒）](frontend-api-extractor/README.md) | 固定仓库并构建 JS，分析嵌套引用，提取 URL、参数、Host、JS 文件 | 已有构建和 Excel；jshound 增强核心重构中，仍有漏扫与性能缺口 |
| [JS 请求采集浏览器插件（黑盒一）](browser-extension/docs/requirements.md) | 自研 MV3 插件，当前浏览器所有窗口中的 HTTP/HTTPS 网页自动接入，Filter 控制留存，CDP 记录真实请求及可取得调用栈 | 只覆盖实际触发且可观测场景；采集缺失明确记录 |
| [网站 JS 收集与静态分析（黑盒二）](docs/site-analysis.md) | 获取部署脚本，分析请求与字段候选 | 脚本引用最多三层；需适配打包代码与页面上下文 |

白盒以仓库构建后四项提取为主路径，源码扫描保留为辅助诊断；黑盒一已有独立 MV3 插件，黑盒二已有资产收集和本地分析入口，真实现场验收仍有限。各工程当前状态以其 README 和开发计划为准。

三路可以独立运行。结果分别标记“仓库静态 / 网站 JS 静态 / 插件实测”，可关联而不抹平版本、调用和字段差异。工作簿包含 API 总表、参数明细、分析缺口，另保留 `analysis.json` 证据底稿。

## 前端代码仓 API 提取

[frontend-api-extractor](frontend-api-extractor/README.md) 的主目标是输入仓库、固定版本、正式构建、分析产物与嵌套 JS，输出四项主信息及代码依据。当前以 jshound 增强核心替换旧分析方式的设计已确认，尚未完成实现。

```bash
cd frontend-api-extractor
npm ci
node src/repository-cli.js https://github.com/aliyun/alibabacloud-gdb-console --work-dir ../work/repository-scans
```

上述样本自动采用固定构建配置。其他仓库配置、预检和源码辅助命令见[使用指南](frontend-api-extractor/docs/usage.md)，当前缺陷和进度见[开发计划](frontend-api-extractor/docs/roadmap.md)。交付已有 JSON/Excel；外部测试源码、依赖和大报告只留 `work/`。

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
├── Temp/                  # 候选工具与研究讨论，非实测结论
├── references/            # 工具、插件、项目评估与固定核查依据
├── frontend-api-extractor/ # 仓库构建、JS 提取、文档、配置与验证
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
