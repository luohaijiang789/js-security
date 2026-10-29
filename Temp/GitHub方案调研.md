# GitHub 调研：前端请求与参数提取

核查日期：2026-10-21。通过 GitHub 搜索、官方仓库 README 和下述源码片段核查；**没有安装、运行或评测任何候选工具**。目标是复用获取/解析能力，最终服务于[三入口与 Excel 总方案](../docs/overview.md)。

## 1. 找到了什么

| 项目 | 已核实能力 | 适合本项目的位置 | 不能据此承诺 |
|---|---|---|---|
| [jsluice](https://github.com/BishopFox/jsluice) | Tree-sitter 解析 URL 使用点；输出 URL、Method、Query/Body 参数容器、Header、来源片段；未知拼接用 EXPR；可自定义 matcher | M2/M3 的轻量基线与网站 JS 静态提取 | 字段容器存在不等于各请求机制均有完整 Body 提取；跨文件封装与拦截器未获验证 |
| [LinkFinder](https://github.com/GerbenJavado/LinkFinder) | 格式化 JS + 正则寻找 URL/路径；支持文件、URL、域名模式及 Burp 输入 | 低成本 URL 候选补召回、对照基线 | URL 文本不等于实际请求；不能据 README 的 parameters 字样认为可还原任意 Body |
| [Katana](https://github.com/projectdiscovery/katana) | 标准/无头爬取、JS crawling、可选 jsluice、XHR URL/Method 提取、JSONL 输出与访问范围控制 | 网站页面/脚本发现候选 | 默认爬取深度不是本项目 JS 引用深度；不能据此承诺参数和调用栈完整 |
| [getJS](https://github.com/003random/getJS) | 从页面/响应提取 JS 来源，补全相对资源 URL，CLI 和库接口 | 简单网页 JS 获取入口 | 不是参数分析器，也未证明完整运行时懒加载发现 |
| [GoSpider](https://github.com/jaeles-project/gospider) | 网站爬取、JS 链接发现、可选历史来源、Cookie/Header 输入和 JSON 输出 | 页面/脚本发现的对照方案 | 爬取/验证链接有主动访问行为；历史结果不证明当前部署存在 |
| [JSFScan.sh](https://github.com/KathanP19/JSFScan.sh) | 编排 JS 链接收集、下载、端点提取和报告等工具 | 借鉴“收集→落盘→提取”流程 | 不直接照搬安装与漏洞扫描流水线；未证明跨文件参数分析；API 元数据未识别许可证，复用前核对 |
| [OWASP Noir](https://github.com/owasp-noir/noir) | README 定位为源码中暴露端点的提取，支持框架规则、LLM fallback 与结构化导出 | 借鉴资产数据模型、规则/AI 扩展与样例组织 | 主要目标是应用暴露的入口；不能把服务端路由提取当作前端出站请求分析 |
| [Arjun](https://github.com/s0md3v/Arjun) | HTTP 参数发现，支持主动字典探测及部分被动提取 | 作为相关方案记录，本轮不接入主动模式 | 服务端接受某参数不代表前端发送过；不用于填充本项目已确认参数 |

上述是功能分工建议，不是准确率排名。首选试验组合是 **getJS 或 Katana 负责取得脚本，jsluice 提供结构提取基线，LinkFinder 对照 URL 召回**。白盒跨文件追踪是否复用这些组件需另测。

## 2. jsluice 源码里值得借鉴和必须补的地方

核查提交 `0ddfab153e060a9eeaded4d8669233f7c071e7e4`：

- [url-matchers.go](https://github.com/BishopFox/jsluice/blob/0ddfab153e060a9eeaded4d8669233f7c071e7e4/url-matchers.go)：URL 结果含类型与源片段，便于区分 fetch、位置跳转和字符串候选；可增加 matcher，适合请求机制适配。
- 同文件中 fetch matcher 检查直接函数名 `fetch` 及地址的 stringy 条件，读取 init 的方法/头；该分支未提取 body。对纯 EXPR URL，GetURLs 会跳过。**因此不能直接拿它的结果当完整请求清单：未知地址发送点需另保留，fetch Body 需补提取。**
- [url-match-xhr.go](https://github.com/BishopFox/jsluice/blob/0ddfab153e060a9eeaded4d8669233f7c071e7e4/url-match-xhr.go)：按 `.open` 与字面 Method 识别，再在同作用域找 header；注释明确提到顺序精度仍可改善。适合参考局部提取，不等于可靠跨文件实例分析。
- [objects.go](https://github.com/BishopFox/jsluice/blob/0ddfab153e060a9eeaded4d8669233f7c071e7e4/objects.go)：对象访问以字面 object/pair 为核心。不能因存在 GetKeys 就宣称 spread、动态键和变量实参已完整展开。

这解释了为什么需要“轻量分析 + 必要调用追踪”：现成工具能节省一部分规则开发，但本项目仍需处理未知项、请求封装、实例、字段改写和证据状态。

## 3. 网站收集工具的接入注意点

Katana README 的 `-jc` 是 JS 端点解析/爬取，`-jsl` 启用 jsluice；`-xhr` 描述为 XHR URL/Method 输出，不能推导完整载荷。其默认访问范围与本项目 API 结果保留范围不同，需要单独适配。[官方 README](https://github.com/projectdiscovery/katana/blob/ebaa3cad5376d24500a4a7749475ae7f30ea378a/README.md)

getJS 适合提取 script 来源，渲染后才产生的脚本需要浏览器或其他发现入口补充。GoSpider 和 JSFScan.sh 可借鉴资源发现流程，但其自动请求端点、历史来源、扫描功能不属于本轮默认行为。

**三层必须由我们的 JS 引用记录控制。** 不能简单把候选爬虫的 `--depth 3` 解释为已满足三层 JS 要求。

## 4. 固定核查版本与阅读范围

| 仓库 | HEAD 提交 | 本轮阅读范围 |
|---|---|---|
| BishopFox/jsluice | `0ddfab153e060a9eeaded4d8669233f7c071e7e4` | README.mkd、url-matchers.go、url-match-xhr.go、objects.go |
| GerbenJavado/LinkFinder | `1debac5dace4724fd6187c06f133578dae51c86f` | README、linkfinder.py 正则与 parser_file 片段 |
| projectdiscovery/katana | `ebaa3cad5376d24500a4a7749475ae7f30ea378a` | README 功能、JS/XHR、范围与输出相关段落 |
| 003random/getJS | `ca46d75bf2bd7a24ac08eece192c6b114b189fdb` | README 与仓库元数据 |
| jaeles-project/gospider | `f6cc9a78d709e088e55ce62e5e92ab063f1a184b` | README 与仓库元数据 |
| KathanP19/JSFScan.sh | `e8daba10ea48dfea8e572870876230a1c03872dc` | README 与仓库元数据 |
| owasp-noir/noir | `73b0ffaeef40dbe0ae6464f2c6cc998740f5153a` | README、目录中的 JS 框架样例路径；未审分析器实现 |
| s0md3v/Arjun | `d1fb995cb1e064d4e171d83f19f6af79b0a3c5ce` | README 与仓库元数据 |

目录/README 核查不等于全库审计；引用 HEAD 固定本次观察，后续试验记录实际运行版本。既有 CodeQL、Babel 等资料仍见[参考资料](参考资料.md)。

## 5. 下一轮只测能决定选型的题

- [ ] 同一 JS 给 LinkFinder、jsluice 与自研轻量原型，比较请求召回、误报与字段缺失。
- [ ] 测 fetch(urlVariable, body)、跨文件 report(data)、Axios 实例/拦截器、unknown spread，防止只测字面 URL。
- [ ] 同一测试网站分别提供 HTML 直链、懒加载、SDK 三层引用和未触发分支，核对脚本发现与 API 发现两类漏点。
- [ ] 检查候选工具是否丢弃未知 URL、空参数或解析失败；适配到统一缺口模型。
- [ ] 同版源码、网站 JS、插件记录合并成真实 Excel，检查新增请求、字段差异、错误归并与复核成本。

以上待执行，不把调研结果当作已实现能力。
