# Web 机制：避免错判前端字段是否出站

## 本轮核验：观察事件能证明什么

2026-10-20 读取官方规范及 CDP schema；以下为文档事实与设计推论，尚未校准目标浏览器。

| 官方依据 | 可确认事实 | 对本项目的影响 |
|---|---|---|
| [W3C Beacon](https://www.w3.org/TR/beacon/) | `sendBeacon()` 返回 true 表示成功入队，不提供传输成功信息 | 单独记录调用/入队，不能写成接收端已收到 |
| [CDP 固定 schema](https://github.com/ChromeDevTools/devtools-protocol/blob/95b1af69d6a20161dc3558f8e38366b7fa7a27d1/json/browser_protocol.json)：`getRequestPostData` | 返回内容省略 multipart 请求中的文件 | 载荷缺文件时标记不完整；不能据此认定文件没发送 |
| 同上：`requestWillBeSent`、`requestWillBeSentExtraInfo` | 前者表示即将发送请求；ExtraInfo 并非每次都有，先后顺序无保证 | 分离网络事件、响应、接收端证据；按身份关联，不按到达顺序硬拼 |
| 同上：`loadingFailed` | 表示资源加载失败 | 推论：失败事件本身不能证明接收端未收到任何数据，需保留失败阶段与其他证据 |
| 同上：`Target.setAutoAttach` | 自动关联相关 target；文档说明可递归设置以附加全部可用 target | 为 page/iframe/Worker/SW 分别记录观察能力；启用一次不等于全覆盖 |

执行时固定浏览器与协议版本，复核支持情况；固定 schema 是研究依据，不代表任意部署均实现相同能力。[证据分层与反例](../../docs/01-方法体系/前端数据采集与跨境透传审计体系总方案.md)为统一判定入口。

## 其他机制入口

| 资料 | 本项目容易错在哪里 | 核查动作 |
|---|---|---|
| [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) | 只看到部分 target 或只存响应 | 核请求头/body、发起线索、身份、失败/重定向，固定版本 |
| [CDP ServiceWorker](https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/) | 页面结束就停止观察 | 登记脚本/状态与后台能力，不能默认页面级全覆盖 |
| [Playwright network](https://playwright.dev/docs/network)、[SW](https://playwright.dev/docs/service-workers) | 路由/拦截与 SW 行为有差异 | 用受控正例核当前工具行为 |
| [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) | 响应不可读被当未发送 | 区分预检、请求、响应和发送失败 |
| [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) | HttpOnly 被当所有 Cookie 不出站 | 看实际凭证规则与请求，不只查 document.cookie |
| [JSON.stringify](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify) | 入参对象含字段就认定发出 | 检查 toJSON、replacer 和最终属性 |
| [sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon) | 漏离开/后台路径 | 观察生命周期与备用发送 |
| [Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy) | 自动 referrer 与主动 URL 上报混淆 | 分别追策略、实际头和 SDK 读取/载荷 |

这些机制资料用于制定[黑盒场景](../../deliverables/黑盒怎么做.md)和[白盒路径检查](../../deliverables/白盒怎么做.md)，不能证明目标站已触发。版本/策略与 target 的实际覆盖需试点核验。资料整理：2026-10-20，未执行业务验证。
