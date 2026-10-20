# Baxia 公开 SDK 静态核查

> 核查时间：2026-10-15。只下载并阅读公开 CDN 的 JavaScript，**未执行脚本、未连接目标业务页面、未验证实际网络发送或服务端落地位置**。下述脚本来自公开地址的当前响应；不同站点、版本和灰度配置可能走不同分支。样本彼此关联的线索不等于它们在同一页面一定同时运行。

## 1. 样本与完整性

| 样本 | 公开来源 | 本地副本 | SHA-256 |
|---|---|---|---|
| Baxia 入口 | `https://g.alicdn.com/sd/baxia-entry/index.js` | [entry-index.js](samples/baxia/entry-index.js) | `79cbec5c53d89c594e6c0a2d5407385416e4c756700eefa663f5cca0f045a159` |
| Baxia 公共入口 | `https://g.alicdn.com/sd/baxia-entry/baxiaCommon.js` | [entry-common.js](samples/baxia/entry-common.js) | `a4fd6a524c81be97cbd67058c8394c92ffbcbcfc83fc0af9611ca7d82c191c83` |
| Baxia 2.5.37 | `https://g.alicdn.com/sd/baxia/2.5.37/baxiaCommon.js` | [baxia-common-2.5.37.js](samples/baxia/baxia-common-2.5.37.js) | `1b19182fd89af9530e7bc7722b73ce584104eb5bc5c8fa2c1e58332fad83e7af` |
| AWSC 入口 | `https://g.alicdn.com/AWSC/AWSC/awsc.js` | [awsc.js](samples/baxia/awsc.js) | `dd61322f1a7e890f3677a320f05b5a36e4f501ebcf037400eab5e2009f2e911e` |
| Fireye 1.234.24 | `https://g.alicdn.com/AWSC/fireyejs/1.234.24/fireyejs.js` | [fireye-1.234.24.js](samples/baxia/fireye-1.234.24.js) | `7b011c7d48ea0a7ddc87a430c6b087471cd9bd5d7901a30b262f511354ff30f0` |

每个请求返回 `HTTP 200` 和 `application/javascript`。响应头保存在同目录的 `.headers` 文件中。Fireye 文件约 551 KB，存在压缩/混淆；本次没有声称已完整还原其采集字段。

## 2. 已确认的静态行为

### A. 前端不只是“产生一个 token”，还可能改写业务请求

在 `baxia-common-2.5.37.js` 可见对 `window.fetch` 和 `XMLHttpRequest.prototype` 的包装。`isEffectUrl()` 根据接入方配置的 `checkApiPath` 决定哪些业务 URL 生效；命中后，`addNCParamToRequest()` 会根据配置生成 `bx-ua`，以及可选的 `bx-umidtoken`、`bx_et`、`x-pipu2`、`bx-asac`，写入请求头、查询串或请求体。脚本还可为同源请求设置 `bx-v` 版本头。

**含义**：透传路径可能是 `浏览器 → 本方业务 API → 本方服务端/风控服务`，不能只盯 SDK 自己直连的域名。关键取证点是命中的 `checkApiPath`、`appendTo`、`paramsType` 等初始化配置，以及服务端如何存储或再转发这些字段。静态代码仅说明能力存在，不证明某个站点已启用。

### B. 入口脚本包含直接上报路径，部分参数可能带完整页面地址

`entry-index.js` 与 `entry-common.js` 的错误上报函数会构造 `//gm.mmstat.com/fsp.1.1?` 图片请求，参数包括 `page`、`query`、`hash`、`referrer`、`title`、`ua` 和错误消息；此路径受采样率和错误/日志触发条件控制，**不是每次页面浏览都会发送**。如果业务把邮箱、订单号、认证码等放在 URL query/hash 或 referrer 中，这些值可能随错误上报进入请求。

入口还包含在特定淘宝系页面读取 `cookie2`、`sgcookie`、`unb`、`cna`、`bx_et` 和页面 `href`，向 `wcfg.json` 配置端点发起带参数 GET 的逻辑。代码对站点和缓存有条件判断；不能据此认定任何接入 Baxia 的美国站点都会发送这些字段。入口另有在特定条件下加载 `fireyejs.js` 的逻辑，以及一条把 `cna` 与完整页面地址放进 `fourier.taobao.com/rp` 请求的分支。

### C. 依赖和行为由站点及配置决定

`entry-index.js` 会按主机名选择不同的配置地址，如 `bdc.alibabachengdun.com/wcfg.json` 或淘宝/天猫的 `umdc` 端点；还会通过返回的配置加载额外脚本。入口引用 `AWSC`、`fireyejs`，但 `awsc.js` 内置的 Fireye 版本与入口所引用的版本并不相同。因此**必须记录目标页面真实加载的完整脚本树和版本**，不能从单个 CDN 样本推定实际生产链路。

## 3. 当前不能得出的结论

- 不能确认用户所说业务实际上加载了上述哪个脚本、启用了哪些模块或参数。
- 不能凭 CDN 域名、源码中的 URL 或服务端 IP 推定数据最终存储国家及法律上的接收主体。
- 不能从不透明的 `bx-ua`/Fireye token 直接断定其内含哪些原始字段；需要在受控环境检查生成前输入、官方数据说明及实际请求。
- 不能仅凭当前静态代码证明存在“美国用户数据透传回中国”，也不能排除服务端或远程权限形成的后续访问。

## 4. 针对实际站点的下一步取证

1. 固定目标页面、账号、时间、脚本 URL、响应哈希和业务版本；用合成身份信息完成登录、搜索等关键路径。
2. 抓浏览器网络请求与 initiator，重点标记 `bx-*`、`x-pipu2`、`x5sec`、`wcfg`、`mmstat`、`fourier`；比较加载前后和风控触发前后。
3. 在测试环境观察 Baxia 初始化配置及 token 生成前输入；区分脚本直传、自动附加到业务请求、服务端二次上报。
4. 追业务 API 里这些参数的接收、日志、转发和风控服务调用；核实服务提供方、处理区域、数据留存与中国侧访问权限。
5. 对照隐私告知和厂商数据处理说明，形成逐字段、逐路径的风险判断；不要把 token 当成无风险的普通字符串。

## 5. 与总体方案的关系

本核查把[前端打点跨境数据流审计方案](前端打点跨境数据流审计方案.md)中的 Baxia 入口、业务请求透传、SDK 直传和下游访问四类证据具体化。生产环境结论需要第 4 节的运行时和灰盒证据。
