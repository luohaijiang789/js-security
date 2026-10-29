# 对象字段改写与调用处证据

0.6.0，2026-10-28（Asia/Shanghai）。本轮实施 P1a 的有限对象副作用模型，并增加带 manifest/独立预期的微型样例。P0 全部基准、统一 ID 协议与 P1b hook 求值仍待完成。

## 改动与边界

此前属性读取、对象构造和函数传参中的候选展开会复制对象，可能丢失别名和调用方副作用。现在引用选择与发送快照分离：构造、浅展开、读取和传参保留普通对象引用；HTTP 发送时才展开候选并快照，后续修改不改变已经记录的请求。

- 确定目标/键的属性赋值、delete、Object.assign、跨文件直接调用可更新对象，并记录位置和前后值。
- 属性 += 支持数字加法与字符串拼接；其他复合赋值、自增/自减使目标未知并有诊断。
- 普通 if/三元/短路改写保留条件；函数条件副作用回到调用方尚未精确合并，对象保守失效。
- 未知计算键、歧义别名、未知覆盖和外部调用的传入对象保留缺口，不制造 {runtimeKey} 参数名。
- JSON 保存序列化时的输入与证据快照。不沿原型链读取宿主对象，不执行目标 getter/setter。

跨闭包标量回写、类/原型、任意异步副作用与精确堆合并仍不完整。未知调用可能实际只读，失效处理会增加未知量，不代表实际发生了改写。

## 输出

schemaVersion 仍为 1；新增 usage.objectChanges，包含 operation、carrier、path、expression、位置、conditions，以及可取得的 previous/value。配置根部写入使用 config 载体，Query/Body/Header 内部写入分别标注构造载体。最终字段是否存在以该 usage 的结构和 parameterFields 为准，delete 历史不能计入最终字段。

operation 为 set/delete/unknown-write/history-truncated。单对象历史及展开合并后的历史最多 128 条；截断有 OBJECT_CHANGE_LIMIT，结构值可继续求值，但历史不完整。嵌套对象各有历史，总列表可能超过 128 条。其他新增诊断包括 DYNAMIC_PROPERTY_MUTATION、UNKNOWN_CALL_EFFECTS、CONDITIONAL_CALL_EFFECTS。

这些是调用处对象改写依据，不是全程序时间线或 hook 后网络载荷证明。所有字面量字段的来源尚未统一追踪。接口组顶层是代表项，逐调用参数和证据读取 usages，不能跨调用合并字段。

## 验证

[自写样例](../../../examples/object-effects/README.md)包含 3 个源文件；manifest 固定 SHA-256 和配置，expected.json 独立指定预期，测试核对哈希。链路为 entry → prepare → transport → axios：POST https://api.example.test/v1/items，Header X-App=audit；obsolete/X-Old 删除，body.account.id 先 8 后 9。

另以 esbuild 0.25.0 编译自写样例，在 Node vm 中用本地 Axios 快照 stub 执行，两个配置快照匹配人工预期。无网络传输，只验证调用配置语义，不证明 HTTP 编码或 hook 行为；引擎仍不执行目标代码。

124 项自动化测试通过，新增 25 项覆盖别名、浅拷贝、快照、删除、求值顺序、条件、未知键/调用、序列化、原型链反例和证据上限。最后补充复合标量赋值右侧调用的反例后，25 项专项复跑通过。

外部样本沿用[前次版本与范围](../../archive/validation/aliyun-sites-analysis.md)，源码和报告只留忽略目录：Nacos 四个 reducer 保留 23 个发送位置、22 条记录，方法/URL/字段路径/hook 状态与 0.5 定向结果一致；GDB 原文件与本地压缩文件均保留 3 个发送位置、2 个模板及 conn/type/dsl。相对 URL 的 Host 与 hook 后字段仍未知。OSS 定向扫描仍只有 BaseHttp 的未解析发送位置，DI、Global.endpoint 和 SDK HTTP 未恢复。

下一步实现受限同步 Axios hook，核对实例关联、执行顺序、条件及删除/覆盖；不将本轮对象语义样例称为外部全仓或 hook 验收。
