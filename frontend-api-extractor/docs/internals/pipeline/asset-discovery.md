# 深层 JS：收集、连接和补漏分别验证

0.4.0，2026-10-27。本轮先复现动态模块断链，再增加模型，并对公开 JS 的压缩前后做对照。外部源码、构建工具、完整扫描输出均只放忽略目录；不增加第三方子模块或依赖。

## 实际取样与失败记录

- 阿里云国际站 https://www.alibabacloud.com/：环境代理仍返回 CONNECT 403，未取得 HTML/JS。因此没有国际站脚本、深层引用或接口覆盖结论，也未使用其他途径绕过限制。
- 成功下载[公开阿里云 GDB Console WebRequest.js](https://github.com/aliyun/alibabacloud-gdb-console/blob/49336dbcc958236e233a921f60353802cbd43130/src/utils/WebRequest.js)，固定提交 49336dbcc958236e233a921f60353802cbd43130。原文件 2810 字节；用 esbuild 0.25.0 做 ESM bundle/minify，axios 标记 external，未运行目标业务代码。
- 自写样例的 5 个源文件，经同一工具实际生成 3 个压缩 ESM 分块、335 字节；作为小型回归材料提交，见 [async-chunks](../../../examples/async-chunks/README.md)。它不是对真实国际站的替代实测。

## 原 JS 与压缩 JS 的对照

| 输入 | 字节 | 直接发送点 | 方法与路径模板 | 保留的字段名 | Host |
| --- | ---: | ---: | --- | --- | --- |
| GDB 原 WebRequest.js | 2810 | 3 | POST /api/v1/connect；POST /api/v2/query | conn；type、dsl | 未知：缺少页面/运行时配置 |
| 本地生成 WebRequest.min.js | 817 | 3 | 同上 | 同上 | 未知，不使用下载 JS 的 GitHub 域名代替 |

原文件 SHA-256：8395aeca3956f7a416ac10197abc1376691a763a67e679087bccea23e3cfda13。
压缩文件 SHA-256：22e157c2be29f7e8ace874bbdb977000242ac04d18b588eadde410594fec6f7a。

首次压缩扫描虽也得到 2 个方法/路径模板，却只覆盖 2 个发送点：逗号表达式吞掉了一个请求。修复后恢复 3 个。这个例子说明仅比较接口总数会掩盖漏点，必须同时检查发送点和参数证据。

捕获的可变 type 在脱离原上下文时不能沿用唯一初值；现在记录 CAPTURED_STATE_UNRESOLVED。地址/字段名对齐不代表所有分支值、类工厂、hook 或网络载荷已证明一致。

## 本轮实现

1. 本地 ESM 动态 import：支持 await、then 的模块参数/解构、默认导出、转导出和可静态计算的路径。只解析扫描范围内文件，远程/缺失/排除模块不自动下载，不越过 include/exclude。
2. 输出 assetPath：保留一条可核对的模块引用路径；全部已知边仍在 assets.imports 中。它不是唯一父链或运行时执行证明，参数函数调用链仍单独保存。
3. 可选资产级补漏：includeUnlinked=true 或 CLI --include-unlinked，沿已知引用扫描可达资产。发现新计算引用后继续到稳定或耗尽共享预算。已通过入口定位的发送点不重复产生未知实参版本。
4. 补漏结果放 assetCandidates，不混入 endpoints；usage.linkState=unlinked，referencedBy 表示已知引用入口。字段可能不完整，不能当作某个页面已实际调用。发现补漏候选会有诊断，Markdown 也单独显示。
5. 处理压缩逗号表达式及未知短路分支赋值；独立发现回调时，存在写入但未绑定的捕获变量保留未知。

stats.unlinkedScan 区分未启用、完成、预算中断等状态，空候选列表不等于已做补漏。includeUnlinked 默认关闭以保留入口扫描的范围与成本；库存模式已扫描匹配文件，不另做补漏。两阶段共用 maxSteps/maxDepth/maxCandidates，不通过补漏掩盖原始中断、递归、缺模块或深度诊断。

## 测试与下一步

88 项自动化测试通过。其中自写压缩分块的两个入口都连接到子 JS，恢复 api.example.test、/v2/users/lookup、account.id，分别保留 7/9；源文件与构建文件均可对照。动态导出断链时有独立候选，未知路径、缺失导出、循环、排除文件与 CLI 输出都有检查。

仍未实现：Webpack JSONP/模块注册表和 runtime chunk URL 映射、Promise.all/任意异步调度、模块初始化副作用的完整顺序、通用加密/控制流平坦化、普通类工厂，以及浏览器页面/Worker 与脚本 URL 的完整上下文适配。压缩位置当前回指实际构建 JS，不声称已经恢复 source map 原始位置。

下一步先做 Webpack 本地分块对照及明确未知边，再接入获准的页面/CDN 收集。收集器需独立控制获取深度、文件数、总字节和时间；分析器控制调用深度和求值预算。白盒本地模块追踪不消耗外部获取层数，插件/网站收集继续遵守既定范围。对已取得的每个深层 JS，可先留请求候选，再补业务关系，而不是因调用链未连通就宣称没有接口。
