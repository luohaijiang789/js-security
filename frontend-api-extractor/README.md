# Frontend API Extractor

从前端 JS/TS 源码静态提取 HTTP 接口、参数和调用证据，支持自定义入口、语义层与追踪深度。版本 0.8.2。

源码模式独立分析本地目录，不要求先构建。构建增强首版另提供 GitHub 地址→npm/Docker 构建→source-map 关联分析→CSV/Markdown 表格，见[流程与边界](docs/repository-pipeline.md)。统一任务前端和交付模型适配仍待接入。

## 使用

需要 Node.js 22+，安装、测试和运行均在本目录执行。仓库构建模式另需 Git、可用的本地 Docker 和依赖下载网络；当前开箱验证项目为 GDB Console。

```bash
npm ci
npm test
npm run verify:baseline -- --out ../work/baselines/core.json
node src/cli.js /path/to/frontend --out reports/apis.json
node src/cli.js /path/to/frontend --format markdown --out reports/apis.md
npm run demo
npm run scan:repository -- https://github.com/aliyun/alibabacloud-gdb-console --work-dir ../work/repository-runs
# 可选：提供实际页面基址，以解析相对 URL；示例域名不是该项目的真实部署
npm run scan:repository -- https://github.com/aliyun/alibabacloud-gdb-console --deployment-url https://gdb.example.test/console/ --work-dir ../work/repository-runs
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

- [实施清单](../docs/前端API提取实施清单.md)：累计已实现能力、历史版本及后续逐项勾选，附范围与证据。
- [固定基准与差异工具](docs/baselines.md)：同版逐调用/字段差异与完整性检查。
- [后续迭代与验证方案](../docs/前端API提取迭代路线与验证.md)：阶段顺序、逐项验收、样本与 AI 边界。
- [真实构建请求表](docs/gdb-build-pilot.md)：引用阿里云 JS 的 GDB Console 固定版本，产物/源码位置、方法、Host 与参数。
- [测试说明](docs/testing.md)：180 项自动化测试；自写的轻量多框架样例包含 19 个预期接口。
- [外部源码试跑记录](docs/alibaba-real-world.md)：只记录外部仓库链接、固定提交、范围和结果。
- [阿里云站点与新样本分析](docs/aliyun-sites-analysis.md)：站点可达性、Nacos 压缩对照及 OSS SDK/hook 缺口。
- [迭代记录](docs/changelog.md)。

外部源码、依赖和生成报告不纳入 Git；不添加第三方测试仓库子模块。`examples/` 仅包含运行回归所需的少量自写源码，不含完整框架工程或依赖。
