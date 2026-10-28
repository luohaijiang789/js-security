# 0.9 使用、验证与未完成项

2026-10-28；提取器 0.9.0、插件 0.7.0。累计执行项见[实施清单](../../docs/前端API提取实施清单.md)。新增第三方运行依赖仅 HTML 解析器 parse5 与支持代理/限额的 HTTP 客户端 undici；Webpack 和 SDK 工具只在忽略目录。

## 可直接使用的流程

以下从 frontend-api-extractor 目录执行，Node 22+；GitHub 构建另需本地 Docker、Git、目标依赖网络。profile 固定提交、项目子目录、锁文件和构建参数；仍不承诺所有框架零配置。

```bash
# 本地源码 → 原始报告 + 统一交付 JSON/Excel
node src/cli.js /path/to/repository --out ../work/source.json --delivery-dir ../work/source-delivery
# Vue/Vite 子项目：GitHub → npm ci → 正式构建 → source map → 请求表
node src/repository-cli.js https://github.com/luohaijiang789/js-security --profile profiles/recorder-vue.json --work-dir ../work/vue-runs
# 固定 pnpm/Yarn Classic 的正式构建
node src/repository-cli.js https://github.com/luohaijiang789/js-security --profile profiles/pnpm-fixture.json --work-dir ../work/manager-runs
node src/repository-cli.js https://github.com/luohaijiang789/js-security --profile profiles/yarn-fixture.json --work-dir ../work/manager-runs
# 网站：只收集页面/JS，不调用提取出的 API
node src/scripts-cli.js --url https://site.example/page --allow-host cdn.example --depth 3 --out ../work/site
# 已收集资产包或插件读取的已加载脚本，无需重新下载
node src/scripts-cli.js --import-package ../work/site --out ../work/site-replay
node src/scripts-cli.js --browser-snapshot ../work/snapshot.json --out ../work/browser-replay
```

构建流程保留旧根目录 analysis.json/requests.csv/requests.md，**delivery/analysis.json 与 delivery/api_assets.xlsx** 是统一协议交付。源码的 --delivery-dir 和脚本命令也生成同一底稿/工作簿。

新增语义子集：jQuery ajax/get/post/getJSON；受限 call/apply、静态 reduce；普通类自身属性/方法/工厂与显式 angularServices；URLSearchParams/FormData 重复字段、修改/删除/编码/快照；无法执行的 hook 字段保存为未应用候选。继承/装饰器/复杂 this、未知中间件、异步/条件 hook 的最终载荷、文件字节、加密和运行时配置继续未知。

## 黑盒二入口与部署

插件新增 **JS探索**：导入交付文件；或页面 URL + 深度提交给本地分析进程；或读取所有已打开网页中已经解析的 JS，再送到本地进程。表格展示 JS 位置、方法、Host、URL、字段、阶段、证据和缺口，静态候选与插件实测分视图。不会因 URL 一样自动合并。

```bash
# 令牌预先通过运行环境 FRONTEND_ANALYZER_TOKEN 提供，至少16字符
node src/server-cli.js --origin chrome-extension://实际扩展ID --allow-host site.example --allow-host cdn.example --work-dir ../work/server-jobs
```

默认监听 127.0.0.1:8765，只接受指定 Origin 与 X-Analyzer-Token；插件连接时申请对应服务地址权限。服务每次一个任务，最多保留 20 个内存任务记录，重启后历史文件仍在但暂不提供恢复列表；生产部署、多人权限与后台守护不在首版范围。应在使用浏览器的机器上运行，远程环境的 localhost 不是用户机器。POST /jobs 收 URL；POST /packages 收脚本快照；GET /jobs/:id 查询，artifacts 只允许交付白名单。

匿名 URL 收集不会继承浏览器 Cookie。读取已解析脚本使用 CDP getScriptSource，不使用 Runtime.evaluate、不发新业务请求；原始引用父链和获取深度未知就保留 null，只关联能够从源文本证明的本地关系。未加载的动态脚本、iframe/worker、权限失败和其他版本不保证完整。实测采集中不能启动这项读取，以免冲突；本轮通过背景串行任务与 finally 清理连接，关闭面板也继续清理。完整 MV3 现场验收仍受企业策略阻断。

## 脚本与打包代码

HTML 内联第0层、直接外链第1层，静态 ESM/import/importScripts/Worker 与有限 Webpack chunk 继续引用。网站最多3层，build收集最多1层；该命令独立于仓库构建，不默默执行额外下载。记录原始/最终 URL、哈希、重定向、多父关系、上下文、失败/截断/限额。未知 JS URL 不猜测或枚举。文档与 worker 分开分析，不能从 CDN URL 推断请求 Host。

无可用应用 source map 时，识别有限 Webpack4/5 模块表、绑定的 require/module/exports、导出 getter、CommonJS interop 和静态异步模块；对应支持 publicPath/chunk 文件名表达式。**不执行 runtime，不证明业务入口或生命周期**。未知 runtime、模块冲突、未映射位置、缺 chunk 和预算保留缺口。

自写真实生产压缩分块，两个版本均恢复 users/lookup 的 account.id=7 和深层 v2/query 的 id=9，POST/Host/位置均核对，另保留未知实参库存候选。[输入、哈希和重建方式](../examples/webpack-chunks/README.md)。

## 真实样本结果

所有第三方代码、依赖、产物、完整日志在 work/，主仓库仅留固定链接、profile、人工预期与自写小样例。

| 样本/模式 | 本轮结果 | 不能据此断言的内容 |
| --- | --- | --- |
| [Ant Design Pro 验证切片](https://github.com/ant-design/ant-design-pro/blob/42f2cb1d303380909ea04c73b5e60679d09c321a/src/services/ant-design-pro/api.ts) | 8 个调用/16 条条件候选，16/16 匹配，无额外项；114步 | 未知 options 仍导致不完整；不是全仓准确率 |
| [插件固定旧版 Vue/Vite 子项目](https://github.com/luohaijiang789/js-security/tree/eee0d51e87fb129630e12e59a792b984f2f7385b/browser-extension) | 真实 GitHub/Node22/npm构建通过，3JS/25映射源码；400000步，全量仅1条未知候选 | 预算耗尽，不能声称请求恢复完整；这个被扫描版本尚无本轮JS探索 |
| [pnpm/Yarn 独立自写样例](https://github.com/luohaijiang789/js-security/tree/1529f4ad8174ac016b5174030724015a442145d7/manager-fixtures) | 两个真实 GitHub/Docker 冻结安装+esbuild正式构建均成功，分别2条请求，complete=true | 是工具链验收，不是第三方框架覆盖率；主分支不收完整测试工程 |
| [GDB 固定版本](https://github.com/aliyun/alibabacloud-gdb-console/tree/49336dbcc958236e233a921f60353802cbd43130) 无map四JS | 识别478个模块，259582步，0请求行，complete=false | **公开无map请求恢复验收未通过**，存在Babel类/库语义/分区限制；不是“没有接口” |
| 同版 GDB App.js+显式资产补漏 | 17行候选，29855步，含connect/query已知路径 | 已知结果来自unlinked-asset补漏，不是页面事件已连通 |
| [Nacos globalLib/ServiceList](https://github.com/alibaba/nacos/tree/d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce/console-ui/src) | globalLib入口4行/9933步；页面+补漏8行/25520步；均未知地址 | 不能把局部ajax候选当ServiceList生命周期调用或已恢复URL；全链验收未通过 |
| [OSS BaseHttp](https://github.com/aliyun/oss-browser/blob/922153a57efae80185be7fd645760b791ea7ff90/app/components/services/base-http.js) +自写驱动 | 原样源哈希匹配，显式DI；2请求/267步，已知绝对Host与相对URL，X-Requested-With恢复 | 相对Host仍依赖Global.endpoint；自写入口不是实际用户行为 |
| 同版 OSS STS/RAM | 2初始化+12静态操作，endpoint/输入位置分开；依赖^1.12.3 | 不满足精确版本，不自动提升为HTTP；动态 ram[method] 未展开 |

GDB 实参条件组合曾造成 previous-not-iterable 崩溃，现已修复：实参候选超限保留诊断并继续其他请求，新增专门反例。公开项目仍未通过的请求恢复不因修复崩溃就勾选。

Nacos 请求 hook 的 username/accessToken/Content-Type 和 body替换已可自动保留条件、位置及表达式，但 state=unapplied-candidate、postHookState=unknown；不会混入最终线上字段。参见 [hook候选测试](../test/hook-candidates.test.js)。

## 固定 SDK 离线对照

[协议元数据](../models/aliyun-sdk-1.12.3.json)只覆盖 aliyun-sdk **1.12.3** 的 STS/RAM 61 个标量操作，记录上游API定义版本与哈希；不支持任意OSS/其他SDK。精确版本、支持的配置/输入和操作才进入 sdk-protocol-build，签名、时间、nonce、凭据、运行时UA/Length始终未知。

自写驱动对实际安装的1.12.3调用 `.build()`，预先禁止handleRequest，核对 method/path/body键、默认值、Header键与编码；61通过，attemptedNetwork=0。主程序不依赖或执行该SDK。

```bash
node tools/verify-sdk-reference.cjs /absolute/path/to/aliyun-sdk ../work/sdk-reference-results.json
```

该版本模型是POST根路径/表单体，通过真实离线实现证明后才采用；不会把此规则推广到所有SDK。重复表单字段在通用表单测试验收，未伪称SDK POP对象支持重复同名Query。

## OpenAI 兼容字段释义

用户已选择兼容协议。默认关闭；显式 enabled、endpoint、model 才调用，密钥只从 FRONTEND_AI_API_KEY 读取。只发送字段路径、载体、阶段、文件名和支持引用；不发送原始值或整仓，释义独立 annotations，全部需复核，缺上下文允许拒答。模型不能改Host、必填性、静态状态或增造接口。

```bash
node src/ai-cli.js --input ../work/source-delivery/analysis.json --out ../work/annotated --enabled --endpoint https://provider.example/v1/chat/completions --model 实际模型名
```

真实本地HTTP兼容协议、默认零请求、越界/无依据输出拒绝与失败降级已测试。**尚无实际服务地址、模型名和环境密钥，未做远程LLM质量评估，也没有宣称释义准确率。**独立人工标注与无依据推断率的验收仍待完成。

## 尚未通过的验收

保留 P2-04 页面全链、P3-04 公开无map请求恢复、AI-03 真实语义评估、P5-05/K04 真实站点与完整MV3现场。2026-10-28再次探测国际站与帮助站，代理CONNECT403；不能据此判断站点自身拒绝。Chromium test:extension明确报告企业策略禁止加载自定义扩展，未修改策略。它们与已通过的代码测试、受控站点和真实CDP测试分别记录。
