# 网站 JS 收集与静态分析工具评估

目标是从获准网站收集内联脚本、外链 JS、懒加载 chunk、Worker 和 SDK，保存页面/版本/引用关系，再对部署代码提取请求候选。页面发现、脚本获取、打包代码恢复和请求分析应分为独立步骤。

## 1. 采集与发现候选

| 候选 | 已核实能力 | 主要缺口 | 结论 |
|---|---|---|---|
| [Katana](https://github.com/projectdiscovery/katana) | 标准与 headless/hybrid 爬取；JS parsing/crawling；可启用 jsluice；可提取 XHR URL/Method；支持范围、Header/Cookie、JSONL 和限速 | 网站爬取深度不等于 JS 引用深度；会主动访问发现链接；XHR/端点输出不等于完整参数和调用证据 | **A：综合采集基线**，需关闭非必要主动行为并接自有父链模型 |
| [Playwright](https://github.com/microsoft/playwright) | 受控真实浏览器、BrowserContext、网络事件、trace、页面操作和登录态复用 | 自动化只能看到实际加载；未触发 chunk 仍需静态发现；需要自行做范围、脚本落盘和引用链 | **A：动态发现/登录态/验收基线** |
| [getJS](https://github.com/003random/getJS) | 从 URL、HTML/HTTP 响应抽取 JS source；补全相对地址；有 CLI 和 Go package | 不渲染页面，不发现运行时加载，不分析请求 | **A/B：简单、可嵌入的静态入口** |
| [hakrawler](https://github.com/hakluke/hakrawler) | 快速 URL 与 JavaScript 文件位置收集；可带 Header/代理 | 通用爬虫，未证明 chunk 父链、版本和请求参数；GPL-3.0 | **B：轻量采集对照** |
| [GoSpider](https://github.com/jaeles-project/gospider) | 页面爬取、JS link discovery、Cookie/Header/Burp 请求输入、JSON 输出 | 可验证并继续请求链接；历史来源可能混入；较久未见功能提交 | **B/C：采集对照** |
| [waymore](https://github.com/xnl-h4ck3r/waymore)、gau 等 | 从 Wayback、Common Crawl、URLScan 等历史来源取 URL/响应；waymore 可保存内联 JS/外链来源 | 历史内容不等于当前部署版本；结果量巨大；会引入版本污染 | **C：人工追查旧资产**，默认流程禁用 |

## 2. 部署代码恢复与请求提取

| 候选 | 作用 | 边界 | 结论 |
|---|---|---|---|
| [mozilla/source-map](https://github.com/mozilla/source-map) | 读取 source map、映射生成位置到原始位置、提取 sourcesContent | map 可能缺失、错版或不含源码；不能证明脚本执行 | **A：有同版 map 时的标准组件** |
| [webcrack](https://github.com/j4k0xb/webcrack) | 反混淆、unminify、transpile，并拆解 webpack/browserify bundle | 恢复是启发式处理；结果不等于原始源码；依赖 Node 22/24 和 isolated-vm | **A/B：难读 bundle 的可选预处理** |
| [jsluice](https://github.com/BishopFox/jsluice) | 对单个部署 JS 做结构化 URL/请求候选提取；可扩 matcher | 动态 URL、body、跨 chunk 调用和配置上下文仍需补 | **A：请求提取基线** |
| LinkFinder / xnLinkFinder | 从脚本、目录或 HAR 补 URL/潜在参数候选 | 文本/潜在参数不能当已确认请求结构 | **B：补召回与差异对照** |
| CodeQL / Joern | 对恢复后的多文件代码做跨文件分析候选 | 打包模块不一定符合源码模块语义；需要专门适配和评测 | **B：第二阶段对照** |

优先顺序应是：保留原始脚本 → 校验同版 source map → 必要时 webcrack 生成辅助视图 → 请求分析。任何转换结果都要回指原始脚本 URL、内容哈希和转换工具版本，不能覆盖原始证据。

## 3. Katana 的正确接入方式

Katana 是目前最接近“网站入口 → 页面/脚本发现”的现成项目。固定提交 `14e9096361eb` 的 README 明确支持：

- 标准和 headless 模式；
- `-jc` JavaScript endpoint parsing/crawling；
- `-jsl` 使用 jsluice，且提示内存开销；
- XHR extraction、scope、Header/Cookie、rate limit、JSONL 等。

它仍不能直接成为我们的三层收集器。Katana 的 crawler depth 约束页面/链接访问，不等同于“页面直接脚本为第 1 层、脚本引用到第 3 层”。我们必须在导入后自行建立 `parent_asset_id → child_script_url`，按最短父链算层，并对未知父链、重定向、失败和截断留账。

另外，Katana 的 endpoint crawling 会主动访问发现地址，与“只收集页面和脚本，不自动请求提取出的 API”的边界冲突。首轮应关闭或隔离会主动请求端点的选项，只使用页面/脚本发现和观测结果；任何主动模式必须另行明确。

## 4. Playwright 与 getJS 的分工

Playwright 适合登录态、SPA、懒加载、iframe/Worker 以及操作触发后的脚本观测，也能保存 storage state 和网络线索。它看到的是一次执行覆盖，不是所有可能脚本。

getJS 适合无需渲染的 HTML/script source 抽取，可作为小而清晰的静态入口或库。两者组合可以区分：

- HTML/响应中直接声明的脚本；
- 浏览器运行实际加载的脚本；
- 对已取得脚本静态解析出的后续引用。

三类来源分别记录，不把运行加载列表中的所有文件都当成页面第 1 层。

## 5. 推荐流水线

1. 用 getJS/HTML parser 取得页面直接脚本，用 Playwright 或 Katana headless 取得运行加载脚本和页面上下文。
2. 对每个脚本保存原始 URL、最终 URL、HTTP 元数据、内容哈希、页面、发现方式和父资产。
3. 静态解析 import、dynamic import、Worker、脚本注入和已知 chunk manifest；由自有深度控制器取到第 3 层。
4. 同版 source map 优先恢复位置；难读 bundle 可用 webcrack 生成辅助视图，原始文件始终保留。
5. 先用 jsluice/LinkFinder 建立请求候选基线，再决定是否把 CodeQL/Joern 的多文件能力适配到部署代码。
6. 与插件实测按脚本哈希、页面、调用位置和版本线索关联；仅 URL 相同不认定同版。

## 6. 首轮淘汰条件

- 工具无法输出父页面、脚本 URL 或内容，无法建立证据链。
- 将爬取深度冒充 JS 引用深度，或不能关闭主动请求发现端点的行为。
- 只输出去重 URL，不保留原始脚本、位置和解析失败。
- 自动混入历史归档、搜索引擎或第三方数据，却不标来源和时间。
- 转换/反混淆后覆盖原始文件，无法按哈希回查。
- 许可证与预期分发方式冲突，且没有可替换组件。

## 7. 关键核查依据

- [Katana README（固定提交）](https://github.com/projectdiscovery/katana/blob/14e9096361ebde42426367a0c98259d49dd64be6/README.md)
- [getJS README（固定提交）](https://github.com/003random/getJS/blob/ca46d75bf2bd7a24ac08eece192c6b114b189fdb/README.md)
- [Playwright README（固定提交）](https://github.com/microsoft/playwright/blob/6e2c003f16e01822c3ea45bc894c2542a6e98189/README.md)
- [webcrack README（固定提交）](https://github.com/j4k0xb/webcrack/blob/c80eec5f00622b86cea871d68349750ce950201f/README.md)
- [mozilla/source-map README（固定提交）](https://github.com/mozilla/source-map/blob/8c668f3dd3916e96d06131dec97c78a3e62bd0f3/README.md)


