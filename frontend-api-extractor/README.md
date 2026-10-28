# Frontend API Extractor

从前端 JS/TS 源码静态提取 HTTP 接口、参数和调用证据，支持自定义入口、语义层与追踪深度。版本 0.7.0。

这是主项目白盒的源码模式实现，不执行目标仓库业务代码、不要求先构建；构建产物联合分析属于独立的增强模式。整体关系见[前端代码仓采集方案](../docs/前端代码仓JS请求API采集.md)。当前为 CLI，统一任务前端与交付模型适配尚待接入。

## 使用

需要 Node.js 22+，安装、测试和运行均在本目录执行。

```bash
npm ci
npm test
node src/cli.js /path/to/frontend --out reports/apis.json
node src/cli.js /path/to/frontend --format markdown --out reports/apis.md
npm run demo
```

默认读取目标根目录的 `api-extractor.config.json`；可用 `--config` 指定其他配置，路径相对于当前工作目录。配置示例见 [api-extractor.config.example.json](api-extractor.config.example.json)。

## 白盒复杂 JS 核查

本轮先复核分段地址、隐藏配置和 hook，再补可确定的静态还原与证据降级。[分析与实施边界](docs/whitebox-hardening.md)记录具体问题、已实现项和未解决情况。

输出新增 JS assets 清单、address.host/hostState、参数字段路径与构造阶段，以及请求 hook 位置。原有 resolution 仍描述调用处候选；相对 URL 的 Host 可能未知，请单独读取 address.hostState。hook 后的最终网络值没有被静态证明。

## 深层和动态 JS

支持本地 ESM 的 await import/then、模块导出和实参传播，并在 usage.assetPath 中保留可核对的 JS 引用路径。断链时可显式补漏：

```bash
node src/cli.js /path/to/frontend --include-unlinked --out reports/apis.json
```

补漏只分析已知引用可达的本地匹配文件，独立输出 assetCandidates，不冒充已连通入口。它不下载远程 JS，也不是浏览器采集器。公开阿里云 JS、实际压缩分块对照和国际站网络阻断记录见[深层 JS 验证](docs/async-assets.md)。

## 能力与边界

- JS/TS/JSX/TSX、Vue/Svelte 脚本解析；React、Next、Solid、Angular 等脚本共享分析内核。
- ESM/基础 CommonJS、跨文件封装、参数传播、有限条件候选、静态数组回调与 for-of。
- fetch/axios/ofetch/ky 等请求适配；Angular/AngularJS 注入客户端可显式配置。
- JSON/Markdown 输出源码位置、调用链、条件和未知原因；maxDepth/maxSteps/maxCandidates 控制预算。
- 求值预算按入口与已知补漏资产分配，复杂分区中断后继续其他文件；stats.partitions 保留中断/未扫描状态，maxStepsPerFile 可额外限额，见[预算与实测](docs/budgets.md)。
- 确定对象的赋值、删除、别名及跨文件改写保留 objectChanges；未知副作用降级，见[对象改写验证](docs/object-effects.md)。
- modelRequestHooks=true 可显式建模有限、明确 synchronous:true 的 Axios 请求 hook，调用处与后阶段独立保留，见[范围与验证](docs/request-hooks.md)。默认关闭，异步/条件等未支持情况仍未知。

静态候选不代表运行时一定发生的请求，诊断和 partial/unresolved 必须保留。普通类实例工厂、复杂堆副作用、模板事件、拦截器和全仓路径精度仍有限；完整范围见 [设计](docs/design.md)。

## 文档与测试

- [后续迭代与验证方案](../docs/前端API提取迭代路线与验证.md)：阶段顺序、逐项验收、样本与 AI 边界。
- [测试说明](docs/testing.md)：146 项自动化测试；自写的轻量多框架样例包含 19 个预期接口。
- [外部源码试跑记录](docs/alibaba-real-world.md)：只记录外部仓库链接、固定提交、范围和结果。
- [阿里云站点与新样本分析](docs/aliyun-sites-analysis.md)：站点可达性、Nacos 压缩对照及 OSS SDK/hook 缺口。
- [迭代记录](docs/changelog.md)。

外部源码、依赖和生成报告不纳入 Git；不添加第三方测试仓库子模块。`examples/` 仅包含运行回归所需的少量自写源码，不含完整框架工程或依赖。
