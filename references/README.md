# 工具与项目评估索引

核查日期：2026-10-22。这里保存可长期引用的选型依据；候选探索过程仍放在 [Temp](../Temp/README.md)。

本轮以官方仓库 README、许可证、固定提交和关键源码为依据，只完成桌面评估，**尚未在本项目试点上运行或做准确率测试**。已有成熟产品和完整实现不等于已满足本项目证据口径，仍需 PoC。

先读[成熟 API 资产收集工具总览](成熟资产收集工具总览.md)。它修正了早期“主要只能复用底层组件”的判断：Vespasian、jshound、Akto、OpenAPI DevTools、Burp 插件和流量转 OpenAPI 工具已经覆盖大部分采集与资产化流程。

实测反馈更新：用户安装 OpenAPI DevTools 后反馈遗漏大量请求；已从历史派生源码确认存在主动过滤线索，现降为规格生成参考，取消优先采集基线推荐。现场版本与漏项原因仍待核对，详见[漏采排查](OpenAPI%20DevTools漏采排查.md)。

## 1. 按三个方案阅读

| 方案 | 评估文档 | 当前最值得验证的组合 |
|---|---|---|
| [前端代码仓 JS 请求 API 采集](../docs/前端代码仓JS请求API采集.md) | [前端代码仓分析工具评估](前端代码仓分析工具评估.md) | 正式构建 + jshound 本地目录 + Vespasian 本地预览；CodeQL/Joern 只补源码语义 |
| [JS 请求采集浏览器插件](<../docs/JS 请求采集浏览器插件.md>) | [浏览器请求采集工具评估](浏览器请求采集工具评估.md) | 先试 OpenAPI DevTools/HAR/Burp + Vespasian/mitmproxy2swagger/Akto；确有调用栈和证据缺口再开发 |
| [网站 JS 收集与静态分析](<../docs/网站 JS 收集与静态分析.md>) | [网站 JS 收集工具评估](网站JS收集工具评估.md) | jshound 与 Vespasian 双基线；Katana/Playwright/jsluice 降为组件对照 |

## 2. 总体判断

成熟工具已经解决了以下常见工作：

- 浏览器/代理流量采集并归并成 API Inventory 或 OpenAPI；
- 从网站 bundle、懒加载 chunk 和 source map 恢复未触发请求候选；
- 从 Burp/HAR/mitmproxy 导入并合并多次观察；
- 在平台中持续跟踪 shadow、undocumented 和新增 API/参数。

尚未发现单一工具同时满足本项目的全部定制要求：

- 分别接受源码仓、部署 JS、浏览器实测三类输入；
- 还原请求 Host、URL、Method 和 Query/Header/Body 字段；
- 保留调用上下文、版本、完整性状态及未解析缺口；
- 将三类证据汇总到同一 Excel，且不把静态候选当成实际请求。

因此合理路线是直接采用成熟工具完成采集和主要提取，自行维护来源证据、调用栈、缺口语义及 Excel 映射。首轮不建设扫描器或插件，先比较完整工具输出；只有量化差距后才补代码。

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
| [praetorian-inc/vespasian](https://github.com/praetorian-inc/vespasian) | `daa3dafc68f0` | 2026-10-03 | Apache-2.0；部分命令默认主动 probe，采集模式需显式核对 |
| [AmbitSecurity/jshound](https://github.com/AmbitSecurity/jshound) | `f34f9c5dcfa0` | 2026-10-20 | MIT |
| [akto-api-security/akto](https://github.com/akto-api-security/akto) | `a7d8693ce867` | 2026-10-22 | MIT；企业连接器/部署能力另核 |
| [alufers/mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) | `f432acafa590` | 2026-06-24 | MIT |
| [Arkptz/mitm2openapi](https://github.com/Arkptz/mitm2openapi) | `afde32ac8035` | 2026-10-19 | MIT |
| [grokify/traffic2openapi](https://github.com/grokify/traffic2openapi) | `142e33cc28e` | 2026-10-15 | MIT |
| [jlozoya/api-network-recorder](https://github.com/jlozoya/api-network-recorder) | `2877b112c6e9` | 2026-10-08 | MIT |
| [PortSwigger/js-miner](https://github.com/PortSwigger/js-miner) | `420c5664e2b0` | 2023-07-20 | Apache-2.0 |
| [PortSwigger/js-link-finder](https://github.com/PortSwigger/js-link-finder) | `206371d0f938` | 2019-09-05 | MIT |
| [xnl-h4ck3r/GAP-Burp-Extension](https://github.com/xnl-h4ck3r/GAP-Burp-Extension) | `f223016fa347` | 2026-01-08 | 仓库未见明确 LICENSE 文件，引入代码前需确认 |
| [openclarity/apiclarity](https://github.com/openclarity/apiclarity) | `37aa37506260` | 2024-08-23 | Apache-2.0；仓库已归档 |
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

1. 选一个可重复构建的真实前端，生成 `dist`、source map 并启动本地预览。
2. 对 `dist` 跑 jshound，对预览跑 Vespasian 被动模式，先验证现成静态与动态覆盖。
3. 用 OpenAPI DevTools/Chrome HAR/Burp 记录同一操作，分别导入 Vespasian、mitmproxy2swagger、mitm2openapi 和 Akto。
4. 只对现成工具漏掉的源码位置、跨文件封装和拦截器运行 CodeQL/Joern 对照。
5. 将结果映射到 `analysis.json` 和 Excel，依据差距决定是否还需自研浏览器插件。

