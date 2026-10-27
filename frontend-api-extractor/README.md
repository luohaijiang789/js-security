# Frontend API Extractor

从前端 JS/TS 源码静态提取 HTTP 接口、参数和调用证据，支持自定义入口、语义层与追踪深度。版本 0.2.0。

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

## 能力与边界

- JS/TS/JSX/TSX、Vue/Svelte 脚本解析；React、Next、Solid、Angular 等脚本共享分析内核。
- ESM/基础 CommonJS、跨文件封装、参数传播、有限条件候选、静态数组回调与 for-of。
- fetch/axios/ofetch/ky 等请求适配；Angular/AngularJS 注入客户端可显式配置。
- JSON/Markdown 输出源码位置、调用链、条件和未知原因；maxDepth/maxSteps/maxCandidates 控制预算。

静态候选不代表运行时一定发生的请求，诊断和 partial/unresolved 必须保留。普通类实例工厂、复杂堆副作用、模板事件、拦截器和全仓路径精度仍有限；完整范围见 [设计](docs/design.md)。

## 文档与测试

- [测试说明](docs/testing.md)：52 项自动化测试；自写的轻量多框架样例包含 19 个预期接口。
- [外部源码试跑记录](docs/alibaba-real-world.md)：只记录外部仓库链接、固定提交、范围和结果。
- [迭代记录](docs/changelog.md)。

外部源码、依赖和生成报告不纳入 Git；不添加第三方测试仓库子模块。`examples/` 仅包含运行回归所需的少量自写源码，不含完整框架工程或依赖。
