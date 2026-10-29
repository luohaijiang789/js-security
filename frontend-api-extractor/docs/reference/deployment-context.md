# 相对请求的 Host 与部署上下文

0.8.1，2026-10-28。GitHub 地址、构建 publicPath、JS 的 CDN 域名和开发 proxy 都不能直接证明生产请求的 Host。默认保持未知；用户可提供页面基址，得到该上下文下的请求地址候选。

```bash
npm run scan:repository -- https://github.com/aliyun/alibabacloud-gdb-console --deployment-url https://gdb.example.test/console/index.html --work-dir ../work/repository-runs
```

也可在构建 profile 指定 deploymentUrl；CLI 值覆盖 profile。只接受无凭据 HTTP/HTTPS 绝对地址，不会访问该地址。页面 hash 路由不作为路径基址；有 HTML base 元素时，应提供实际 document.baseURI，本版不自动读取 HTML 或证明浏览器的 baseURI。构建配置内置 profile 不预设部署域名。

| 表格字段 | 含义 |
| --- | --- |
| url | 原始静态分析的有效 URL，保留客户端 baseURL 拼接结果 |
| resolvedUrl | 结合部署基址得到的完整静态地址，去掉不发送的 fragment；未合并独立 Query 配置或证明最终序列化 |
| host | 代码可确定的 Host，或给定部署上下文下的候选 Host（含端口） |
| hostBasis | static-code / deployment-context / unknown |
| hostState | 代码原有 resolved/partial，或 context-candidate/unknown |
| deploymentUrl | 用户提供并规范化的基址；写入 task.json、analysis.json 和请求表 |

根相对、目录相对、父目录、query-only、fragment-only 和空字符串按 URL 标准解析。绝对 URL 保留自己的 Host；协议相对 URL 仅从基址补协议。动态占位、未知 baseURL、含空白/反斜线、不支持协议、凭据或代码 Host 冲突不会自动补全；已有静态 Host 不因动态路径丢失。解析与输出按调用/条件/hook 阶段进行，不修改底层静态报告、调用处参数或原有不完整状态。context-candidate 不能算实测证据，也不能消除未知 hook 或运行时改写缺口。

## 同版 GDB 产物验证

沿用[真实构建记录](../archive/validation/gdb-build-pilot.md)的仓库链接、Commit 49336dbcc958236e233a921f60353802cbd43130 和 4 个 JS；先逐一核对原记录的产物 SHA-256，再用当前分析器重新分析并导出两份表。没有重跑安装/构建，也没有访问任何业务 API。

下面的 gdb.example.test **仅是自定义测试上下文，不是发现的部署域名**。

| 产物 JS 位置（main.a581a592.chunk.js） | 源码（src/utils/WebRequest.js） | 方法 | 原始 URL | 无上下文 Host | 示例上下文 Host | Body 字段 |
| --- | --- | --- | --- | --- | --- | --- |
| 1:115059 | 71:5 | POST | /api/v1/connect | 未知 | gdb.example.test | conn（值动态） |
| 1:114300 | 33:5 | POST | /api/v2/query | 未知 | gdb.example.test | type=gremlin、dsl（动态） |
| 1:114300 | 33:5 | POST | /api/v2/query | 未知 | gdb.example.test | type=cypher、dsl（动态） |
| 1:114759 | 55:7 | POST | /api/v2/query | 未知 | gdb.example.test | type、dsl（动态） |

断言结果：4 行、3 个发送位置；原始 URL、方法、Query/Body/Header、字段路径、源码及产物位置逐项不变。无上下文 4 行 Host 均未知；示例上下文 4 行均为 deployment-context/context-candidate，解析 URL 为 https://gdb.example.test 加原路径。source-map、第三方省略、预算中断等旧缺口仍保留，整体分析仍不完整。

完整 CSV/Markdown 和 verification.json 留在本地忽略目录 work/deployment-pilot/；主仓库只保留此小型验证记录。170 项自动化测试包含 8 项新增回归，覆盖 URL 规则、边界、跨域、冲突、真实分析至表格、hook 阶段隔离与失败前置；离线任务测试另核对配置和 JSON 落盘。
