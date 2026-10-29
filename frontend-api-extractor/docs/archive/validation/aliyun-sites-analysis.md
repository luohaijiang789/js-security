# 阿里云站点访问与公开代码取样

> 历史记录：保留当时方案、能力与验证，不作为当前进度或能力承诺。当前见[需求](../../goal.md)和[开发计划](../../plan.md)。

2026-10-27；提取器 0.4.0。此次只读获取页面头和公开源码，不运行目标业务代码，不调用提取出的接口。外部源码、压缩产物、工具及完整报告均留在忽略目录 `work/aliyun-sites/`，不增加第三方依赖或子模块。

## 线上站点访问结果

| 地址 | 实际结果 |
| --- | --- |
| https://www.aliyun.com/ | 代理 CONNECT 403，未取得页面 |
| https://help.aliyun.com/ | 同上 |
| https://developer.aliyun.com/ | 同上 |
| https://www.alibabacloud.com/ | 同上 |

这四次失败来自当前环境的网络出口限制，不能判断站点自身是否拒绝访问。没有页面、线上分块、引用父链或线上接口覆盖率结论。下面是另外获取的官方组织公开代码，不声称它们就是上述站点当前部署的脚本。进一步线上采样需要环境网络策略开放目标站点及其页面实际引用的 CDN。

## 固定样本与扫描范围

| 项目 | 固定提交 | 下载范围 | 实际扫描 |
| --- | --- | --- | --- |
| [alibaba/nacos](https://github.com/alibaba/nacos/tree/d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce/console-ui/src) | d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce | 13 文件、58040 字节 | 4 个 reducer 入口；可解析所选本地依赖 |
| [aliyun/oss-browser](https://github.com/aliyun/oss-browser/tree/922153a57efae80185be7fd645760b791ea7ff90/app/components/services) | 922153a57efae80185be7fd645760b791ea7ff90 | 8 文件、76863 字节 | 定向扫描 base-http.js、sts.js、ram.js |

Nacos 下载：`constants.js`、`config.js`、`globalLib.js`、`utils/{request,nacosutil}.js`、`reducers/{base,namespace,configuration,authority}.js`、`pages/Login/{Login,index}.jsx`、`pages/ServiceManagement/ServiceList/{ServiceList,index}.js`。OSS 下载：`{auth,authinfo,base-http,oss2,ram,settings,sts,util}.js`。未取得的依赖不伪装已分析。

Nacos 定向配置：`entries=["reducers/*.js"]`、`maxSteps=200000`、`maxCandidates=4`，其他使用默认值。OSS 定向配置：`include/entries=["base-http.js","sts.js","ram.js"]`、`maxSteps=100000`、`maxCandidates=4`，显式声明 `clients=[{"name":"$http","kind":"axios"}]`。

## Nacos：调用点、字段与拦截器分别核查

| 输入 | 入口 | 发送点 | 方法＋路径模板 | 输出记录 | 求值步数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 所选源码，13 文件 | 4 | 23/23 | 21 | 22 | 2400 |
| 所选模块压缩后，7 文件 | 4 | 23 | 21 | 22 | 2366 |

独立 AST 枚举四个 reducer 中 `request.<method>(...)` 的 23 个位置，再按报告终端文件、行、列核对，全部命中。该统计仅覆盖这四个文件的指定 receiver；不覆盖全仓、页面生命周期或运行时流量。22 条输出含 announcement 的语言分支候选，不能解释成 22 个独立业务接口。

| 请求例子 | 自动提取的调用处字段 | 未解决内容 |
| --- | --- | --- |
| POST `v3/auth/user` | body.username、body.password | 实际字段值未知 |
| PUT `v3/auth/user` | body.username、body.newPassword | 同上 |
| POST `v3/auth/permission` | body.role、body.resource、body.action | 同上 |
| GET `v3/auth/user/search` | query.username | 同上 |
| GET `v3/console/server/announcement` | URL 中 query.language | 运行时语言及默认分支分别保留 |
| POST `v3/auth/user/login` | 仅知道请求体来自 user | 不能只凭变量名推断 username/password |

所有地址都是相对 URL，Host 均未知。不能把下载来源 GitHub 的 Host 当作请求 Host。

[utils/request.js](https://github.com/alibaba/nacos/blob/d45ce3b1d7d2765cf6f593b835fcc35de2ca1bce/console-ui/src/utils/request.js#L37) 的请求拦截器会按条件追加 query.username、headers.accessToken，并通过 qs.stringify 改写 POST/PUT 请求体，设置 Content-Type。分析器已定位 hook，但没有执行这些改写；全部 22 条输出保留 partial、postHookState=unknown。上述 hook 字段来自人工源码核查，不能算自动提取的最终网络字段。

压缩对照使用 esbuild 0.25.0，只 transform `constants.js`、四个 reducer、两个 utils，共 7 文件，产物 7317 字节。参数为 `--minify --format=esm --target=es2020 --legal-comments=none`，用 outbase/outdir 保留相对路径；不 bundle、不安装目标依赖、不代表官方正式构建。两组结果的方法＋路径集合、已知字段集合、23 个发送点及 hook 未知状态一致。构建文件的位置只对应压缩 JS。

复核哈希 SHA-256：

- reducers/authority.js：a35b04c816036adb09d30e2463ea586e6ed9dd893f09b4d947a8312c2bdb79aa
- reducers/base.js：b36e26ba5983afc1b0841781ccea25e0891574753273e25f68c84a4c0aba13e2
- utils/request.js：6e8e0566c5408b43a68c4c1287c044ad812d1e1b6c7823c0cca3ad6eaa8060a4

## OSS Browser：Host 藏在 SDK 初始化中

[sts.js](https://github.com/aliyun/oss-browser/blob/922153a57efae80185be7fd645760b791ea7ff90/app/components/services/sts.js) 明确构造 `new ALYD.STS({endpoint:'https://sts.aliyuncs.com',…})`，随后 `sts.assumeRole` 传入 Action、RoleArn、Policy、DurationSeconds、RoleSessionName。[ram.js](https://github.com/aliyun/oss-browser/blob/922153a57efae80185be7fd645760b791ea7ff90/app/components/services/ram.js) 的 SDK endpoint 是 https://ram.aliyuncs.com。这些是人工确认的 SDK 配置和操作参数；当前提取器未建模 aliyun-sdk，未自动恢复其 HTTP method、path、签名或序列化结果。

[oss2.js](https://github.com/aliyun/oss-browser/blob/922153a57efae80185be7fd645760b791ea7ff90/app/components/services/oss2.js#L1937) 又根据 AuthInfo、region、bucket、内外网 endpoint 表拼接对象 URL。找到域名模板不等于找到实际请求，SDK 内部规则和运行时配置仍需继续追踪。

定向扫描只得到 base-http.js 的一个发送位置，URL={opt}、method={config.method}，没有已知字段，resolution=unresolved；不是一个已恢复的业务接口。该封装还修改 opt.url、opt.headers，而当前对象属性赋值模型不完整，报告保留 UNRESOLVED_ASSIGNMENT。不能因为配置了 $http 就宣称 AngularJS DI 服务、SDK 和全链路已支持。

## 失败样本揭示的下一步

初次 Nacos 8 文件库存扫描和 OSS 8 文件库存扫描均在默认 100000 步预算附近中断、输出 0 个接口；与后续定向扫描范围不同，不作性能或召回率横向比较。它们证明“零输出＋预算中断”必须展示为失败/不完整。定向结果也都 complete=false，继续保留模型诊断。

实现优先级据此细化：

1. 按入口/资产分配预算，保证大封装中的分支不会耗尽其他模块的发现预算，并保留每个分区的中断状态。
2. 增加独立、带条件的 hook 字段候选层，记录赋值位置、载体迁移和覆盖关系；已构造字段与 hook 后字段仍分别保存。
3. 给 jQuery ajax/中间件及 AngularJS DI 服务补适配。Nacos globalLib.js 使用 jquery 和 apply/reduce 封装，页面到发送点尚未接通。
4. 增加 SDK 初始化→实例→操作的证据模型。先保留 endpoint、operation、参数候选，只有取得确定的 SDK 序列化规则后才输出 HTTP URL。
5. Webpack runtime 分块定位仍需单独的线上/正式构建样本；本轮独立 ESM 压缩结果不能证明 Webpack 模块注册表已支持。

本轮只增加分析记录，不修改提取器代码或测试数。既有 88 项自动化测试与本次外部样本对照分别计数。前次动态 JS 验证见 [async-assets.md](../../internals/pipeline/asset-discovery.md)，更早版本的公开仓库验证见 [alibaba-real-world.md](alibaba-real-world.md)。
