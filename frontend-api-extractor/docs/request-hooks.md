# 有限同步 Axios 请求 hook

0.7.0，2026-10-28（Asia/Shanghai）。增加显式启用的 request interceptor 模型，默认保持原来的检测/未知行为。

```json
{"modelRequestHooks": true}
```

## 支持范围

只分析静态可识别的 Axios 实例、实际连通的注册流程、明确 options.synchronous=true 的有限回调。支持配置对象及其别名的直线赋值、删除、受支持内建函数、JSON 序列化；保持后注册先执行的 request hook 顺序。确定 ID 的 eject 和 clear 可更新已观察到的注册，父实例的 hook 不继承给 create 出的子实例。已有不确定性不会因 clear 自动消失。

库存模式的独立入口分别维护默认 Axios 状态，不按文件名顺序拼接模块初始化；只有同一入口分析中已连接的控制流程才用于求值。

以下保留 unknown：默认异步链、async 回调、runWhen、拒绝处理器、条件注册/控制、条件或循环回调、未知调用、别名重绑定、捕获堆对象、未知 defaults 修改、未连接模块初始化及不支持的返回值。未支持的某一 hook 会使整条后续快照保持未知，不将已解析前缀冒充最终配置。response 注册不作为 request 回调立即求值；潜在响应函数中的请求发现仍属于原来的静态遍历范围。

模型仍不执行目标 JS。安全语法检查、抽象求值与诊断共同限制范围；同名本地 JSON/Object 不冒充内建函数。注册与求值共用现有 maxSteps/maxDepth/maxCandidates 和文件配额，预算中断保留已记录的调用处结果，后阶段保持 unknown。

## 输出分阶段

旧接口表、method/URL、参数与 objectChanges 保留调用处语义，按原始调用归组，不被 hook 后地址覆盖。开启模型后，关联调用可新增 usage.afterRequestHooks：

| 字段 | 语义 |
| --- | --- |
| state=modeled | 所关联同步 hook 在当前支持范围内已求值，不表示实际网络发送或完整运行时覆盖 |
| state=unknown | 存在未支持/未连接/中断，variants 为空，gaps 保留原因 |
| variants | hook 后方法、URL、address、Query/Body/Header、条件、字段与改写证据；各自仍有解析状态 |
| executionOrder | 实际建模的回调次序及注册代码位置 |
| serializationInputFields | JSON 编码前的输入字段证据，阶段为 serialization-input，不能当作编码后字段 |
| scope | 明确停在 request hooks 后、Axios transformRequest/adapter/transport 前 |

postHookState 可新增 modeled，接口组汇总保留最差状态；逐调用信息读取 usages。默认关闭时不生成 afterRequestHooks，旧 hook 状态仍 unknown。Markdown 单独显示“请求 hook 后候选”表。

已知 JSON 字符串按实际编码结果提取字段，例如 undefined 被省略的字段不计入编码后字段表；编码结果未知时只保留未知载荷结构，输入字段放 serializationInputFields。Header 此时采用有限普通对象模型，不声称 AxiosHeaders、大小写归并、自动 Content-Type、transformRequest、adapter、重定向或服务端接收已完整复现。

## 验证

[自写同步 hook 样例](../examples/sync-hooks/README.md)用 manifest 固定输入 SHA-256、独立预期和配置。三个注册中移除一个；其余按逆序执行，将调用处 https://before.test/original 改为 https://after.test/items，X-Order 最终为 first，Body 为 {"id":7,"tag":"added"} 的 JSON 字符串。

另用真实 Axios 1.7.9 执行该自写样例：本地 adapter 捕获配置，禁用 transformRequest，核对方法、Axios.getUri 地址、指定 Header 及 Body，均符合人工预期。Axios 自动默认 Header 不作为本模型已恢复字段。没有网络 transport，不执行第三方业务项目，也不声称已做服务端接收验收。Axios/esbuild/构建产物和报告均留在忽略目录，不增加项目依赖。

146 项自动化测试通过，新增 22 项覆盖顺序、实例/别名、eject/clear、非法返回、异步/条件/未知、shadowed 内建函数、预算、JSON 字段阶段、哈希和 Markdown。

固定 Nacos 四个 reducer 在默认及开启模式下均保留 23 个发送位置、22 条原始记录及字段路径，求值为 2400 步。其现有 request hook 未声明 synchronous:true，且含条件/外部序列化，因此仍 unknown，不把新增模型当作已经还原 Nacos 的最终载荷。源码版本与范围沿用[公开样本记录](aliyun-sites-analysis.md)。

下一步应从实际缺口中选择 runWhen/条件回调、已知序列化器或模块初始化关联逐项推进，继续保留独立预期和反例，不一次扩大到任意异步链。
