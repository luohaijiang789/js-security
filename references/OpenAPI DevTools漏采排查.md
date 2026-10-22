# OpenAPI DevTools 漏采排查

核查日期：2026-10-22。用户安装商店版本后反馈会遗漏很多请求，当前尚未取得版本号和漏项样例，因此没有确定现场根因。

## 1. 已确认的代码线索

原作者仓库当前不可拉取，本次检查了两个可取得的历史派生仓。它们不能视为当前商店安装包的源码，但都表明此工具存在主动筛选，不能按完整流量采集器评估。

| 条件 | maksimu 历史分支 | Superflows-AI 派生版 |
|---|---|---|
| 资源类型 | `_resourceType` 存在时仅收 xhr/fetch | 放宽到 xhr/fetch/document |
| 服务端 IP | `serverIPAddress` 缺失直接丢弃 | 相同 |
| 响应格式 | HAR MIME 必须等于 `application/json` | MIME 以 `application/json` 开头或响应内容能解析为 JSON；另允许 urlencoded 请求 |
| HTTP 方法 | 仅 GET/POST/PUT/DELETE/PATCH | 相同 |
| URL 后缀 | 原始完整 URL 以 `graphql` 或 `.json` 结尾直接排除 | 相同 |
| 采集事件 | 录制期间监听 `onRequestFinished` | 相同 |

这些条件意味着：Beacon/Ping、像素请求、WebSocket、HEAD/OPTIONS、非 JSON 响应、无响应正文的 204、部分缓存/Service Worker 记录等可能被过滤。具体是否过滤取决于 HAR 实际字段和安装版规则；尤其不能仅凭缓存命中就断言必然缺少 serverIPAddress。

同一端点的重复请求和已参数化路径会归并，规格条数少于 Network 请求数不一定是漏采。应按 Host + Method + Path 比较，再核对参数化规则。

Chrome 官方还说明：DevTools 在页面加载后才打开时，HAR 可能缺少此前请求，应打开 DevTools 后重新加载。`onRequestFinished` 在请求完成后触发，因此持续流式连接不能按普通已完成请求处理。

## 2. 最小现场排查

1. 打开 DevTools，Network 选择 All、启用 Preserve log；插件开始录制后再刷新页面。
2. 临时清除插件 Host 筛选和路径参数化，复现一个明确遗漏的请求。
3. 检查该请求的 Method、Type、Status、响应 Content-Type、响应是否有效 JSON，以及是否仍 Pending。
4. 在导出的 HAR 中核对 `_resourceType`、`serverIPAddress`、`response.content.mimeType`；同时检查插件导出的规格中是否已归并到其他路径。
5. 记录 Chrome/扩展版本。若常规 fetch/XHR、JSON 响应、服务端 IP 存在、录制后触发且已完成仍遗漏，再查插件异常和解析/Schema 生成失败。

Network 的 Disable cache 可用于第二次诊断对照，不应改变第一次原始现场的证据。Preserve log 也不能证明插件自身跨导航一定保留数据。

## 3. 选型结论修正

OpenAPI DevTools 降为 **B：JSON API 规格生成参考，完整采集能力存疑**。现有用户反馈和源码线索足以取消“第一采集基线”的推荐；现场漏项比例和根因仍待版本与样例确认。

本项目的采集层应先保存范围内原始请求，再进行 API 识别和规格生成；响应不是 JSON、没有 serverIPAddress 或无法解析 Body，都不应使请求记录静默消失。过滤和不支持的原因应能回查。

## 4. 依据

- [maksimu 分支过滤函数（固定提交）](https://github.com/maksimu/openapi-devtools/blob/3232414b82035a3003687d01c048956a083d309e/src/utils/helpers.ts)
- [maksimu 分支监听与异常处理（固定提交）](https://github.com/maksimu/openapi-devtools/blob/3232414b82035a3003687d01c048956a083d309e/src/ui/Main.tsx)
- [Superflows-AI 派生版过滤函数（固定提交）](https://github.com/Superflows-AI/openapi-llm/blob/0e43d3cb209323c547c6915b9d18c3136722437e/src/utils/helpers.ts)
- [Chrome devtools.network 官方文档](https://developer.chrome.com/docs/extensions/reference/api/devtools/network)
