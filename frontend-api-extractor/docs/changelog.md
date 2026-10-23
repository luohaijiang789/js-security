# 迭代记录

## 0.2.0

- 动态 if/三元/短路值保留有限候选，贯穿模板字符串、对象、实参和跨文件函数返回；输出 conditions 与每条 usage 的 resolution。
- 同一个 if 分支中的 URL/method 配对，分支对象复制保留局部别名关系；已返回的路径不继续执行。
- 新增 maxCandidates=16；候选组合、路径与静态遍历超限时明确诊断，不伪造完整结果。
- 新增 ofetch、Nuxt $fetch、ky/ky-universal、node-fetch/cross-fetch 请求适配，以及基础标准 URL/Request 构造解析。
- 支持静态实参展开、数组 map/forEach、静态数组 for-of、无标签 break/continue；其他循环采用带诊断的近似分析。
- 每个入口中已经追踪过的函数不再用未知实参重复发现；库存模式下独立 service 入口仍保留泛化路径。
- 内部类型改用 Symbol，避免业务 tag 数据冲突；循环对象可序列化为带原因的未知值。
- 测试由 33 项增加到 52 项，多框架验收预期接口由 12 个增加到 19 个。

输出对象保持 schemaVersion=1，并新增 usage.conditions、usage.resolution。旧版本中的未知动态分支可能改为多个 partial 接口；消费者应读取解析状态和条件，不能把接口数量增长当成业务新增接口。

## 0.1.0

初版 CLI、框架脚本适配、ESM/基础 CommonJS 追踪、自定义语义层、fetch/axios 请求识别、源码证据、JSON/Markdown 及多框架合成测试。
