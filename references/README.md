# 工具与项目评估索引

核查日期：2026-10-22。这里保存可长期引用的选型依据；候选探索过程仍放在 [Temp](../Temp/README.md)。

本轮以官方仓库 README、许可证、固定提交和关键源码为依据，只完成桌面评估，**尚未安装运行或做准确率测试**。因此，“推荐验证”表示值得进入样例测试，不表示已经选型或验证有效。

## 1. 按三个方案阅读

| 方案 | 评估文档 | 当前最值得验证的组合 |
|---|---|---|
| [前端代码仓 JS 请求 API 采集](../docs/前端代码仓JS请求API采集.md) | [前端代码仓分析工具评估](前端代码仓分析工具评估.md) | jsluice 轻量基线 + CodeQL/Joern 跨文件能力对照 + 自有结果模型 |
| [JS 请求采集浏览器插件](<../docs/JS 请求采集浏览器插件.md>) | [浏览器请求采集工具评估](浏览器请求采集工具评估.md) | Chrome `debugger` + CDP Network + 自有原始事件模型；HAR 作为兼容导出 |
| [网站 JS 收集与静态分析](<../docs/网站 JS 收集与静态分析.md>) | [网站 JS 收集工具评估](网站JS收集工具评估.md) | Katana 与 Playwright 对照采集 + source map/webcrack 预处理 + jsluice 基线 |

## 2. 总体判断

现成项目分别解决了“发现脚本”“识别请求调用”“跨文件数据流”“记录浏览器流量”“转换 HAR”等局部问题，但没有发现同时满足以下要求的单一项目：

- 分别接受源码仓、部署 JS、浏览器实测三类输入；
- 还原请求 Host、URL、Method 和 Query/Header/Body 字段；
- 保留调用上下文、版本、完整性状态及未解析缺口；
- 将三类证据汇总到同一 Excel，且不把静态候选当成实际请求。

因此合理路线是复用成熟底层能力，自行维护资产边界、统一结果模型、缺口语义和 Excel 汇总。首轮不应先建设完整平台，应先用同一批样例比较候选组件输出。

## 3. 推荐等级

| 等级 | 含义 |
|---|---|
| A：优先原型 | 直接覆盖关键能力，值得进入首轮安装和样例测试 |
| B：组件或对照 | 能复用局部能力，或适合作为独立结果对照 |
| C：参考 | 产品、架构或历史线索有价值，不宜作为首版核心依赖 |
| 排除默认接入 | 与当前证据口径冲突、主动行为过强或许可证/能力不合适 |

## 4. 固定核查版本

下表固定本次阅读的仓库 HEAD。提交日期用于判断本次观察的新旧，不代表项目发布节奏或长期维护承诺。

| 项目 | 固定提交 | 提交日期 | 许可证/使用约束 |
|---|---|---|---|
| [BishopFox/jsluice](https://github.com/BishopFox/jsluice) | `0ddfab153e06` | 2024-01-10 | MIT |
| [GerbenJavado/LinkFinder](https://github.com/GerbenJavado/LinkFinder) | `1debac5dace4` | 2024-04-13 | MIT |
| [xnl-h4ck3r/xnLinkFinder](https://github.com/xnl-h4ck3r/xnLinkFinder) | `841ac8dddbc7` | 2026-03-08 | MIT |
| [semgrep/semgrep](https://github.com/semgrep/semgrep) | `087e93b3a1fd` | 2026-10-22 | LGPL-2.1；跨文件能力需另核产品许可 |
| [github/codeql](https://github.com/github/codeql) | `5be6d864800f` | 2026-10-21 | 查询库 MIT；CLI/引擎另行许可，闭源代码使用需核实 |
| [joernio/joern](https://github.com/joernio/joern) | `ea6ef8502fd8` | 2026-10-21 | Apache-2.0 |
| [j4k0xb/webcrack](https://github.com/j4k0xb/webcrack) | `c80eec5f0062` | 2026-07-26 | MIT |
| [mozilla/source-map](https://github.com/mozilla/source-map) | `8c668f3dd391` | 2026-10-12 | BSD 类许可证 |
| [projectdiscovery/katana](https://github.com/projectdiscovery/katana) | `14e9096361eb` | 2026-10-22 | MIT |
| [003random/getJS](https://github.com/003random/getJS) | `ca46d75bf2bd` | 2026-08-29 | MIT |
| [jaeles-project/gospider](https://github.com/jaeles-project/gospider) | `f6cc9a78d709` | 2024-03-22 | MIT |
| [hakluke/hakrawler](https://github.com/hakluke/hakrawler) | `52a16fe61bd1` | 2026-08-05 | GPL-3.0 |
| [xnl-h4ck3r/waymore](https://github.com/xnl-h4ck3r/waymore) | `4e02de512fd6` | 2026-06-11 | MIT |
| [requestly/interceptor](https://github.com/requestly/interceptor) | `6209537426f7` | 2026-09-29 | 主体 AGPL-3.0，`ee/` 另有许可证 |
| [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol) | `71ba93da82a9` | 2026-10-21 | Chromium BSD 类许可证 |
| [GoogleChrome/chrome-extensions-samples](https://github.com/GoogleChrome/chrome-extensions-samples) | `1bdfa5a73039` | 2026-10-20 | Apache-2.0 |
| [cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | `a2e85b8094bc` | 2026-02-09 | MIT |
| [cyrus-and/chrome-har-capturer](https://github.com/cyrus-and/chrome-har-capturer) | `4b69108c4b8b` | 2026-10-19 | MIT |
| [sitespeedio/chrome-har](https://github.com/sitespeedio/chrome-har) | `2944ead5fad1` | 2026-05-20 | MIT |
| [microsoft/playwright](https://github.com/microsoft/playwright) | `6e2c003f16e0` | 2026-10-21 | Apache-2.0 |
| [puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) | `ee2a8de23e56` | 2026-10-21 | Apache-2.0 |

许可证只按仓库文件记录，不构成法律意见。真正引入依赖前还需核对所用版本、传递依赖、分发方式和内部使用场景。

## 5. 下一轮验证顺序

1. 建立一组覆盖字面 URL、变量 URL、跨文件封装、Axios 实例、拦截器、未知 spread 和缺配置的固定样例。
2. 运行 jsluice、CodeQL、Joern 和 Semgrep CE，按统一结果模型比较请求召回、字段准确性、缺口保留和接入成本。
3. 用同一测试网站比较 Katana、getJS 和 Playwright 的脚本发现结果，单独核对登录态、懒加载、Worker、iframe 和三层引用。
4. 用 Chrome MV3 官方 debugger 示例扩展采集原型，核对 CDP 原始事件、HAR 转换和服务端接收记录。
5. 将三路真实样例导入 `analysis.json` 和 Excel，验证关联规则，而不是比较工具输出条数。

