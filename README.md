# 前端 API 与请求参数自动化提取

**通过一套白盒、两套黑盒收集前端 API 与请求参数，保留代码依据、实际观察和未知项，统一交付 `api_assets.xlsx`。**

项目起于阿里云美国独立站的前端 JS 数据跨境排查。第一阶段只做资产发现与提取，不做 Host 筛选、敏感性识别、风险分级或合规判断。

## 三个方案

| 方案 | 做法 | 本轮边界 |
|---|---|---|
| [前端代码仓JS请求API采集（白盒）](docs/前端代码仓JS请求API采集.md) | 固定 Commit 后按项目配置构建，联合源码、产物和 source map 提取请求与参数 | 依赖按锁文件安装；外部 JS/SDK 资产分析一层；不主动调用提取出的 API |
| [JS 请求采集浏览器插件（黑盒一）](docs/JS%20请求采集浏览器插件.md) | 自研 MV3 插件，CDP 记录真实请求及可取得调用栈 | 只覆盖实际触发且可观测场景；采集缺失明确记录 |
| [网站 JS 收集与静态分析（黑盒二）](docs/网站%20JS%20收集与静态分析.md) | 获取部署脚本，分析请求与字段候选 | 脚本引用最多三层；需适配打包代码与页面上下文 |

**黑盒一已按用户要求实现独立 MV3 插件；白盒和黑盒二继续 PoC 与集成。** [插件开发与安装](docs/插件开发与安装.md)列出功能、命令、参考版本和待验收范围。 jshound、Vespasian、Akto、OpenAPI DevTools 和流量转 OpenAPI 工具已经覆盖大部分通用能力；先验证现成输出，再只补调用栈、源码定位、缺口状态和统一 Excel。白盒与网站 JS 分析的复用范围用同版源码/产物对照确定。

三路可以独立运行。结果分别标记“仓库静态 / 网站 JS 静态 / 插件实测”，可关联而不抹平版本、调用和字段差异。工作簿包含 API 总表、参数明细、分析缺口，另保留 `analysis.json` 证据底稿。

## 文档与目录

从[文档导航](docs/README.md)开始；[总方案](docs/API资产收集总方案.md)说明整体关系，[交付约定](docs/结果模型与Excel交付.md)说明统一模型，[验证计划](docs/验证计划.md)列出下一步。[工具与项目评估](references/README.md)记录三个方案的候选组件、许可证和推荐验证组合。

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
├── src/                   # MV3 后台、Vue Popup / 管理页、过滤、存储与转存
└── tests/                 # 核心、转存、真实 CDP、页面及扩展现场测试
```

插件源码使用 Vue 3 + TypeScript，执行 `npm ci && npm run build` 后加载 `dist/`。`npm test` 验证核心、转存、真实 Chromium CDP 和界面；受控样例不当作用户真实资产结果。当前云环境企业策略禁止安装扩展，因此 MV3 现场加载、子目标覆盖和正式压力验收仍待目标 Chrome 执行；其余两路继续验证成熟工具。
