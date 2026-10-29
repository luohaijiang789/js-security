# 0.9.3：绑定函数与请求体状态

2026-10-29（UTC）。本轮补齐页面调用链中的一个基础断点：`method.bind(this, ...args)`。插件保持 0.7.1；真实页面生命周期全链仍未完成。

## 实现

- 已解析的普通函数/箭头函数/普通类方法支持 `bind` 和静态 `['bind']`，保留预填参数、原接收对象引用以及后续传参。
- 重复 bind 追加参数，最早绑定的 this 保持有效；后续 call/apply 不能替换它。箭头函数保持原词法 this。
- 接收对象和预填对象后续修改仍可见；条件路径克隆时与已有对象别名一并克隆，避免把分支前 Host 或字段值错误带入两条分支。
- 函数自身的 call/apply/bind 覆盖按限定属性模型处理；删除覆盖后恢复原生语义。新绑定函数不复制原函数的这些自有属性。动态/未支持的函数属性改写有诊断，不继续假定原生 bind。
- 预填参数受 maxCandidates 限制；原有调用深度/递归/步数限制继续适用。函数声明在当前环境内保持身份，避免写入的覆盖属性因重新解析丢失。
- 明确序列化的请求体以输入结构和序列化结果判断动态状态。已知 JSON.stringify 输出的大括号不再误判为未知占位符；动态输入或不支持的 replacer 仍 partial。普通字符串中的占位表达式规则保持原有限定。

实现见[分析器](../src/analyzer.js)、[抽象值与路径克隆](../src/values.js)。这属于静态调用候选；绑定后传给未知框架回调的函数仍为 function-inventory，不提升为已连通页面入口。继承类、new boundFunction、任意原型改写、异步生命周期、通用混淆/加密和完整闭包堆建模仍有限或未支持。

## 可复跑的小样例

[自写样例](../examples/bound-client/entry.js)分为入口和发送模块，只分析，不执行目标业务：

| 发送位置 | 入口调用 | Host | 方法 | URL | Body 字段 | Header 字段 |
| --- | --- | --- | --- | --- | --- | --- |
| send.js:2:10 | entry.js:4:1 | api.example.test | POST | https://api.example.test/orders | orderId、view | X-View |

输入绑定 `/orders`，实际调用传入 42 和 summary；输出保留 JSON 请求体、字段、模块引用和调用链，linkState=entry-trace，单行 resolved，无交付缺口。example.test 为自写保留示例域名。

在提取器目录执行：

```bash
node src/cli.js examples/bound-client --out ../work/bind-example.json
node src/delivery-cli.js --input ../work/bind-example.json --out ../work/bind-delivery
```

生成统一 analysis.json 与 api_assets.xlsx。跨文件绑定、重复绑定、call/apply、箭头 this、实例方法、动态接收对象、自有覆盖/删除、参数预算、递归和分支对象别名均有[测试](../test/bind.test.js)。其中 7 份自写情景另用原生 JavaScript 和假的 fetch 收集结果，与静态分析逐项核对；没有执行第三方 JS 或访问业务 API。

## 回归与范围

提取器全量 298 项测试通过。既有公开样本只复跑冻结输入，不重新下载仓库或运行正式构建：

| 冻结样本 | 结果 | 意外记录 | 步数 / 完整性 |
| --- | --- | --- | --- |
| 独立 Vite/weather 无 map | 4业务形态＋1资源位置检查通过，52行上下文候选 | 0 | 55580 / false |
| GDB 无 map | 3发送位置、4行候选 | 0 | 370985 / false |
| Nacos wrapper＋自写驱动 | 1发送位置、4行候选 | 0 | 1307 / false |

GDB 相对上一版增加 76 步，冻结位置/方法/URL/Host/必需字段和候选数量不变；未将其函数库存候选提升为真实页面链。weather 是重复回归，不再记为新的独立验收。本轮没有用新增基础模型宣称公开页面全链已连通。

下一步仍以真实页面入口/生命周期到发送点的受限关联为重点，复杂异步 hook、运行时配置、AI 实际模型质量和完整 MV3/真实站点验收继续单独登记。[累计清单](../../docs/前端API提取实施清单.md)保留未完成项。
