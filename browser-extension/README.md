# JS 请求采集浏览器插件

独立的 Chrome Manifest V3 工程。点击工具栏图标直接打开管理标签页，新任务按浏览器范围采集当前浏览器所有窗口中的 HTTP/HTTPS 网页，并在详情侧栏查看参数、请求头、正文、调用栈、质量状态和原始记录。完整功能与限制见[插件开发与安装](../docs/插件开发与安装.md)，需求见[插件规格](../docs/JS%20请求采集浏览器插件.md)。

## 构建与安装

需要 Node.js `20.19+` 或 `22.12+`。从 `js-security` 仓库根目录执行：

```bash
cd browser-extension
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”，选择 **`js-security/browser-extension/dist/`**。更新代码后重新构建，并在扩展管理页点击重新加载。

**此前从根目录 `dist/` 安装的用户：** 加载路径改变可能改变 Chrome 扩展 ID，旧 IndexedDB 不会自动迁移。需要保留旧任务时，可先导出，再将新 `browser-extension/dist/` 内容覆盖到原已加载的 `dist/` 路径并重新加载旧扩展；也可先用旧扩展导出，再从新目录独立安装。确认备份前保留旧扩展，不要卸载。详见[升级说明与交互改进](../docs/插件界面与交互改进.md)。

[.npmrc](.npmrc) 在插件目录内固定公开依赖源并保留锁文件下载地址，不修改全局 npm 配置。如果此前内部镜像返回 `rollup-*.tgz` 的 E404，在本目录重新执行 `npm ci && npm run build`；`vue-tsc` 缺失是安装中断的后续错误，不需全局安装或删除锁文件。

## 使用

1. 点击工具栏图标打开请求工作台，点击“新建采集任务”。
2. 选择字段值保存方式和需要落盘的可选字段，再在单行过滤框输入网址关键词，或使用 `domain:`、`method:`、`status-code:`、`resource-type:` 等属性后开始。可选字段默认全选；请求 ID、时间、URL、Method、类型和状态始终保存。空过滤条件采集全部请求；无需选择或管理标签页，当前浏览器所有窗口中的 HTTP/HTTPS 网页，以及之后新打开、导航到的网页都会自动接入。
3. 切回业务页面操作，再返回工作台点击任意请求。详情侧栏可切换概览、参数、请求头、请求体、调用栈和原始数据；调用栈页按 Chrome DevTools 的 `Request call stack` 与 `Request initiator chain` 分区展示，链中其他请求可继续打开。“在途”视图可查看长连接已取得的字段，完成后更新详情。
4. 暂停、恢复或停止任务；停止并写盘后，从右上角导出 JSONL 任务包、CSV 或分片目录。

关闭管理标签页不主动停止后台采集。浏览器级采集可以在没有网页时先启动等待，跳过浏览器内部页和扩展页；Filter 默认采用匹配留存，决定哪些请求落盘。旧任务恢复时按原指定范围处理，不自动扩大；这是历史任务兼容行为，新任务界面不提供指定标签页选项。请求头、Query 参数、请求体、页面来源、发起信息与关系链、调用栈可分别勾选，默认全选；未勾选字段在 Filter 完成判断后、写入 IndexedDB 与导出前移除，并标记为任务未选择保存。请求头、Cookie、认证信息、URL 参数和请求体不按字段名称脱敏。任务可选“完整保留”或“自动截断”：完整模式保存所有已勾选的可观测值；自动模式保持字段名完整，只将超过 64K 字符的字段值及超过正文上限的内容保存为带原始长度标记的首尾片段。原始观察与请求组分别保留。

过滤页只有一个搜索框，空框保存全部请求。多个条件用英文分号 `;` 分隔并同时满足，逗号 `,` 表示同一字段任选一个，前缀 `-` 表示排除，`/表达式/i` 表示忽略大小写的正则，`字段:?` 表示字段存在。例如 `domain:example.com; method:POST; -resource-type:Image,Script; url:/\/api\//i`。支持括号与 `OR`，以及 `query.参数名`、`header.请求头名`、`body.JSON路径`。旧版 Filter 会自动转写成同一搜索语句；应用只影响之后收到的请求。

### Filter 完整用法

`resource-type` 填写 Chrome DevTools Protocol 返回的资源类型，不是文件后缀、Content-Type 或业务分类。最常见的接口请求是 `XHR` 和 `Fetch`，`navigator.sendBeacon()` 通常是 `Ping`，CORS 预检是 `Preflight`。只保留常见接口可写：

```text
resource-type:XHR,Fetch,Ping
```

排除常见静态资源可写：

```text
-resource-type:Image,Media,Font,Stylesheet,Script
```

可填写的 Chrome 类型包括 `XHR`、`Fetch`、`Ping`、`Preflight`、`Document`、`Script`、`Stylesheet`、`Image`、`Media`、`Font`、`TextTrack`、`EventSource`、`WebSocket`、`Manifest`、`Prefetch`、`SignedExchange`、`CSPViolationReport`、`FedCM` 和 `Other`。不要填写 `API`、`JSON` 或 `Beacon`，Chrome 没有这些 resource type。浏览器新增的类型会原样记录，可先查看请求列表的“类型”列，再填写实际值。

| 写法 | 含义 | 示例 |
|---|---|---|
| 空框 | 保存全部可观测请求 | 留空 |
| 英文分号 `;` | AND，每个条件都要满足 | `domain:example.com; method:POST` |
| 英文逗号 `,` | 同一字段任选一个 | `method:GET,POST` |
| 前缀 `-` | 排除匹配项 | `-resource-type:Image,Font` |
| 大写 `OR` | 两个完整条件任选一个 | `(method:POST OR method:PUT)` |
| 圆括号 | 明确组合范围 | `domain:a.com; (method:GET OR method:POST)` |
| 双引号 | 值中包含空格或英文分号 | `url:"order detail"` |
| `/表达式/` | 区分大小写的 JavaScript 正则 | `url:/\/api\/v\d+/` |
| `/表达式/i` | 忽略大小写的 JavaScript 正则 | `url:/\/API\//i` |
| `字段:?` | 字段存在 | `header.Authorization:?` |
| `-字段:?` | 字段不存在 | `-query.debug:?` |

| 字段 | 匹配内容 | 示例 |
|---|---|---|
| 直接写文字 | 请求完整 URL 包含文字 | `orders` |
| `url` | 请求完整 URL 包含值 | `url:/api/orders` |
| `domain` | 请求域名等于该域名或属于其子域名 | `domain:example.com` |
| `path` | URL pathname 包含值，不含 Query | `path:/api/orders` |
| `method` | HTTP 方法完全匹配 | `method:GET,POST,PUT` |
| `status-code` | 终态 HTTP 状态码完全匹配 | `status-code:200,201,204` |
| `resource-type` | Chrome 资源类型完全匹配 | `resource-type:XHR,Fetch,Ping` |
| `extension` | URL 路径最后一段的扩展名，不带点 | `extension:js,css,png` |
| `page` | 发出请求的页面完整 URL 包含值 | `page:console.example.com/orders` |
| `page-domain` | 页面域名等于该域名或属于其子域名 | `page-domain:example.com` |
| `referer` | HTTP Referer 请求头包含值 | `referer:/console/` |
| `initiator` | 发起脚本 URL 包含值 | `initiator:app.js` |
| `query.参数名` | 指定 Query 参数任一值包含内容 | `query.orderId:12345` |
| `header.请求头名` | 指定请求头任一值包含内容 | `header.Authorization:Bearer` |
| `body.JSON路径` | JSON 点路径或表单字段值包含内容 | `body.customer.id:C1001` |

字段名和普通文字值默认不区分大小写，只有不带 `i` 的正则区分大小写。Header 名称不区分大小写；Query 参数名、JSON 路径和表单字段名区分大小写。`extension` 的值不带 `.`。`page` 表示哪个网页发出了请求，`url` 表示请求发往哪里；`referer` 是实际 HTTP 请求头，可能缺失。依赖 `status-code`、完整 Header 或 Body 的规则可能在请求进行中暂时无法判定，终态到达后自动更新。应用过滤条件只影响之后收到的请求，不会重新筛选已保存记录。插件内“使用说明”页还提供全部 Chrome 类型解释、可复制场景和排查步骤。

`Request call stack` 显示浏览器实际返回的同步帧和异步父段；`Request initiator chain` 显示请求之间的上游和下游关系。重定向和带 request ID 的关系精确关联；只有同一标签页、调试会话和 loader 内的发起 URL 候选唯一时才推定关系，候选歧义时不猜测。为了让排除静态资源后的链仍然连贯，插件会为被 Filter 排除的请求保留仅含原始 URL 和父关系的紧凑节点，不保存其请求头、正文或调用栈；这部分计入任务存储容量。历史记录不会因升级恢复此前已经脱敏或未保存的值、调用栈与发起链。

动态附加调试连接可能错过首次导航开头，相关缺口会登记；单页关闭或附加失败不应终止其他页面的采集。暂停期间不附加新页面，恢复时重新检查全部窗口的网页。浏览器级采集也只记录开始后的可观测活动，不回补历史浏览记录。

## 测试

从仓库根目录执行：

```bash
cd browser-extension
npm test
npm run test:browser
npm run test:extension
```

前两项包含核心、转存、真实 CDP 和页面交互测试；页面测试可替代扩展 API，不等于完整 MV3 现场验收。`test:extension` 真正加载扩展，需要浏览器策略允许安装自定义扩展。Linux 浏览器默认 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定已安装的浏览器。

目录中的 `src/`、`tests/`、依赖锁文件与构建配置均属于本插件；其他方案的实现不要放在此目录。运行时第三方许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
