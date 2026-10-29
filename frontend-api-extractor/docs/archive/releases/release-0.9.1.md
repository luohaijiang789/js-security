# 0.9.1：真实压缩 JS 与封装链补强

> 历史记录：保留当时方案、能力与验证，不作为当前进度或能力承诺。当前见[需求](../../requirements.md)和[开发计划](../../roadmap.md)。

2026-10-28（UTC）；提取器0.9.1、插件0.7.1。本轮优先解决0.9中已登记的“识别JS但恢复不到请求”，不是扩大接口数量后宣称完成。[累计清单](../planning/implementation-through-0.10.md)保留历史与未完成项。

## 已修复的问题

| 断点 | 本轮处理与边界 |
| --- | --- |
| 第三方库嵌套Webpack表与普通回调数组被混入外层ID空间 | 只识别受支持注册表/引导调用，跳过外层factory内的独立runtime；GDB模块冲突119→0，识别478→596模块。独立顶层runtime重号仍保留冲突，不猜命名空间 |
| 解包后的局部符号相互污染、CJS别名被解析成SourceFile | 为虚拟模块加作用域边界，保留本地require初始化；括号包裹的导出可解析。原始脚本的全局作用域不被强制改写 |
| Webpack4 getter.a / __esModule兼容规则丢失 | 对受支持绑定恢复getter及a的关系，重绑定不沿用旧值；CJS对象有default字段不自动当ESM。改写后的调用继续映射回原始JS行列 |
| 封装层call/apply、数组中间件断链 | 支持明确this、rest与受限push/pop/shift/unshift/slice；保留别名/快照与预算。自有数组方法覆盖不走原生模型，未知方法会降级接收对象；普通函数、提取方法、箭头、未知回调的this分别处理，不能继承错误的调用者Host |
| 一个条件Header让整个Object.assign配置变未知 | 新对象目标按条件保留候选，已知URL/方法/Body独立保留；共享目标的复杂条件副作用仍保守未知 |
| vendor消耗预算、旧产物干扰复跑 | 已匹配库契约的消费者可优先分配预算；不跳过其余文件。只分析本轮模块清单，未知factory参数明确缺口；构建JS单文件32MiB、合计128MiB上限 |

实现与反例：[封装状态](../../../test/wrapper-state.test.js)、[编译库契约](../../../test/compiled-clients.test.js)、[Webpack](../../../test/webpack.test.js)、[预算](../../../test/budgets.test.js)。没有执行目标runtime或发送提取出的业务请求。

## GDB：无 source map 的实际结果

固定[公开源码版本](https://github.com/aliyun/alibabacloud-gdb-console/tree/49336dbcc958236e233a921f60353802cbd43130)，使用此前正式构建的四份JS。验证工具先核对[冻结产物哈希及人工位置/字段预期](../../../baselines/targeted/gdb-no-map.json)，仅复制四份JS到隔离目录；**不复制或读取源码、source map、目标依赖**进行本次分析。

| 原始JS发送位置 | 方法 | URL | Host | 调用处Body字段 |
| --- | --- | --- | --- | --- |
| build/static/js/main.a581a592.chunk.js:1:114300 | POST | /api/v2/query | 未知（相对URL） | type、dsl |
| build/static/js/main.a581a592.chunk.js:1:114759 | POST | /api/v2/query | 未知（相对URL） | type、dsl |
| build/static/js/main.a581a592.chunk.js:1:115059 | POST | /api/v1/connect | 未知（相对URL） | conn |

3个发送位置全部命中，生成4条条件候选（第一处type的cypher/gremlin分别保留），无额外位置；400000步预算内实际370909步。相对Host不从GitHub、CDN或开发proxy猜测。提供明确部署基址时按既有规则生成上下文Host候选；仍不证明真实部署或请求已发生。

全部为**函数库存候选**：恢复到发送位置不等于页面入口/生命周期已经连通。整个结果complete=false，保留12383条请求/资产/任务缺口；没有用4行结果掩盖vendor、Babel类、回调及其他未知。

### 库契约为何能使用、不能证明什么

新增小型[编译库契约目录](../../../models/compiled-clients.json)。当前仅有参考Axios0.21.4的一种Webpack facade：归一局部绑定和模块ID槽位后，完整AST指纹必须匹配，派生文件SHA256也须相符；同名post、Axios字样或相似URL都不构成命中。测试包括属性/常量/依赖槽位关联变化、源文件篡改、同名假方法与模块作用域冲突。

0.21.4是**参考契约版本**，不是从压缩文件证明出来的安装版本；detectedPackageVersion=null。依赖实现、默认配置的变体和最终transport未被指纹证明，每条使用该契约的请求都保留partial与对应缺口，证据保存clientModel。目录保留参考源/构建/锁文件与哈希，不收第三方实现代码。换minifier/语义形态未命中时仍未知，不采用模糊相似度自动提升。

此GDB样本已经用于开发和修复，登记为development-regression，**不是新增独立盲测**。P3-04的独立公开无map验收仍未完成。

## Nacos：真实封装恢复

固定[globalLib源码](https://github.com/alibaba/nacos/blob/d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce/console-ui/src/globalLib.js)。只读核对globalLib/config/constants三份上游文件，叠加一份[自写分析驱动](../../../examples/external-drivers/nacos-global.js)，不执行它。

手工给定列表请求配置后，成功经过apply/rest/pop与中间件，到globalLib.js:533:12的$.ajax；恢复GET及完整相对URL，Query字段为ignoreEmptyService、withInstances、pageNo、pageSize、serviceNameParam、groupNameParam，Header字段Authorization/AccessToken。1个手工预期位置、4条登录态条件候选全部通过，实际1307步。输入字段、运行时未知值与beforeSend可能继续改写的缺口分别保留。

这是**实际wrapper＋自写固定入口**验收，不是ServiceList真实生命周期连通。此前页面切片改为16候选/16调用深度后能定位GET/DELETE，但动态配置/副作用仍影响列表Query，不能将驱动中的确定值复制给页面结果。P2-04仍未完成。

## 复跑与交付

从提取器目录执行；source-root内必须具备相同哈希的输入。GDB产物来自固定锁文件/正式构建，重新构建若字节不同会明确拒绝，不强配同版位置。

```bash
npm run verify:targeted -- --manifest baselines/targeted/nacos-wrapper.json --source-root /path/to/frozen-nacos --out ../work/nacos-verified
npm run verify:targeted -- --manifest baselines/targeted/gdb-no-map.json --source-root /path/to/frozen-gdb-checkout --out ../work/gdb-verified
```

输出verification.json、analysis.json、api_assets.xlsx；工具校验输入、只分析冻结范围，断言方法/URL/Host/字段/原始位置与额外候选；失败退出1，坏输入退出2。第三方代码、完整报告与派生模块只留忽略目录work。

API总表与插件JS探索新增**定位依据**，区分调用链静态追踪、未连通入口的函数候选、资产补漏与实测；Excel同时保留阶段。Schema2.0.0仅新增可选linkState，旧结果无此字段显示“静态候选（范围见证据）”，不补造入口关系。

Excel使用Node内置DEFLATE，无新增依赖。对首次通过时同一份GDB底稿，独立zipfile解压后的所有XML逐字节相同，工作簿7106038→599632字节，约缩小91.6%；该底稿的10772条缺口未丢弃。长内容仍引用JSON，不通过删证据缩体积。

高级源码配置可增加 `entryPriority:["src/api/**","src/services/**"]`。每个优先入口以maxSteps×0.5/优先文件数作为优先份额，与普通均分配额取较大值；不用完则后续继续用，其余入口照常分析。maxStepsPerFile和全局硬上限仍优先。Webpack自动优先项来自已匹配契约的有限转发者/直接消费者，不把关键词优先级当请求识别。

## 验证与剩余问题

- 提取器279项测试；插件155项测试与正式构建；独立ZIP/XML读取校验。插件npm test/test:browser现在先构建，避免UI测试读取旧dist。定时落盘测试改等可观察状态，转存Promise始终不释放、不手动flush，避免固定1150ms等待掩盖CI调度差异。
- 原有GDB/Nacos/OSS人工切片22/22，Ant Pro固定切片16/16。后者现在是重复验证回归，不再称新盲测。已有GDB带map产物的WebRequest定向范围仍4行；Vue带map全量仍因400000步预算仅1条未知候选。未重跑依赖安装或正式构建。
- 真实CDP正文读取受浏览器缓存、1.5s读取超时和调度影响；并发验证中出现过missing，未改成partial掩盖。真实页面全链、其他库/runtime与运行时配置继续补样本；未知hook/加密不推断最终载荷。
- AI真实质量仍需实际OpenAI兼容endpoint/model/环境密钥及人工独立标注。真实站点访问与完整MV3安装验收维持待办；本轮test:extension再次报告企业策略禁止加载自定义扩展，未改策略。

下一步优先：另选未参与调规则的公开压缩项目验收；再补页面入口到发送点的有限链路，以及有代码/配置依据的Host恢复。运行时必需但不可见的值继续标未知。
