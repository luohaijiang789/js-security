# 手工预期微型基准

自写样例，非第三方代码。语义预期：entry 第 4、6 行分别将 id=7、id=8 传给 transport 第 2 行的 fetch；old 已删除；POST https://api.example.test/items，无显式 Query/Header。entry 第 7 行为独立 GET /relative?limit=2，Header X-App=audit；无部署上下文，Host 未知，URL 自带 limit 字段。不得把两次发送合成一条或串用参数。

expected.json 人工描述这三个调用的关键字段、位置、调用链及缺口；manifest.json 固定脚本与预期哈希和配置。改动预期必须解释独立语义依据，不能用分析器自动覆盖。当前仅为回归基准，不是独立盲测集或全框架覆盖。
