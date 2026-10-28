# 仓库地址 → 构建 JS → 请求表

0.8.1，2026-10-28。新增 npm/Docker 构建增强首版，源码扫描 CLI 继续独立运行。构建模式要求 Node 22+、Git 和可用的本地 Docker Unix socket；镜像内 Node 版本与分析器运行环境分别记录。

在提取器目录运行已验证的公开项目：

```bash
npm ci
npm run scan:repository -- https://github.com/aliyun/alibabacloud-gdb-console --work-dir ../work/repository-runs
```

该地址自动采用[固定构建配置](../profiles/gdb-console.json)：Commit 49336dbcc958236e233a921f60353802cbd43130、Node 16.20.2、原 npm build 脚本及 build 产物目录。它引用阿里云 UI JS 组件库，不代表已经支持云 SDK 的网络协议。

其他 GitHub HTTPS/npm 项目可使用 --profile build-profile.json，配置 dockerImage、buildScript、artifactDirs、buildEnv、analysis 等；--ref 必须是完整 Commit SHA。未指定版本且无内置配置时先固定远端 HEAD。当前只支持仓库根目录 npm package-lock v1/v2/v3 与已声明的 npm 构建脚本，默认 Node 22、dist，不声称任意框架或 monorepo 零配置构建。

## 实际流程

1. 拉取仓库、detached checkout 并核对 Commit，快照构建前 src 脚本哈希。
2. 按锁文件 npm ci；跳过安装生命周期脚本，保留完整性校验，不自动升级依赖。无法安装时记录失败，不切换为源码成功。
3. 在 Docker 中执行 npm run build。只挂载 checkout 和只读公共 CA，以当前非 root UID、无额外 capability、只读根文件系统运行，并限制 CPU/内存/PID/超时和日志量；沿用环境代理与证书。
4. 验证 Commit、锁文件和 tracked changes，清点本次 JS 及相邻 source map，保存 SHA-256。
5. 优先分析 source map 中与固定仓库 src 路径/内容哈希匹配的 sourcesContent，保留导入关系；映射发送点到构建 JS 的行列。不同内容冲突、未映射调用和省略的第三方代码都有缺口。
6. 输出逐调用、逐条件、逐阶段的请求表和证据底稿。task.json 区分各阶段成功/失败及整体分析是否完整。

source-map-assisted 是产物关联源码分析，不是已实现通用 Webpack runtime 解包。被构建删除、无映射的调用只能保留为源码候选；有 source map 映射也不证明运行过。没有可用 sourcesContent 时只尝试 artifact-static，并标明缺口，不静默改用 checkout 源码成功。当前不会解析 HTML 中的内联/外链脚本或自动下载远程 JS，不执行构建产物业务操作或主动访问提取出的 API。完整性只在声明的产物/应用 source 与模型范围内解释，不能外推为全仓或整站完备。

## 表格与证据

| 文件 | 内容 |
| --- | --- |
| requests.csv | Excel 可打开的 UTF-8/BOM 表格；产物/源码位置、方法、Host、URL、Query/Body/Header、字段路径、条件、状态和缺口 |
| requests.md | 同一批记录的人读表格与任务级缺口 |
| analysis.json | JS 哈希、source assets/引用、source map 关联、逐调用证据及诊断 |
| task.json、logs/ | 仓库/Commit、镜像 digest、原始/应用锁文件哈希、阶段、配置与构建日志 |

主表按调用处记录，有限 hook 后结果另列阶段，不混并参数。未知 Host 不取脚本 CDN 域名或开发 proxy；未提供运行/部署上下文时保留未知。可通过 --deployment-url 或 profile.deploymentUrl 提供页面基址，规则与验证见[部署上下文](deployment-context.md)。无显式字段、动态值和缺失信息分开表示。CSV 对外部字符串做公式保护；0.9 同时输出 delivery/analysis.json（Schema 2.0.0）及 delivery/api_assets.xlsx；旧根目录 analysis.json 仍是分析底稿，勿混淆。

GDB 的旧锁文件明确配置 registry.npmmirror.com→官方 npm 的 tarball 地址规范化；只改变下载位置，保留锁定名称、版本、integrity，保存两份锁文件哈希。legacyPeerDeps 也在配置中显式启用，不使用 --force，不升级 React。其他项目不自动套用这些兼容选项。

资源上限：单 JS 32 MiB/1000 文件、单 map 32 MiB/合计 128 MiB、应用 sourcesContent 64 MiB；求值深度/候选/分区预算继续由分析配置约束。0.9 新增 projectDir/buildArgs、固定版本 pnpm 与 Yarn Classic 冻结安装；profile 与真实运行见[0.9 验证](release-0.9.md)。外部 JS 收集为独立显式命令，构建流程不会自动继承浏览器登录或抓取任意 URL。纯混淆 bundle 的完整还原不在已验证范围。

## 验证

170 项自动化测试通过；0.8.1 新增 8 项部署上下文回归，0.8.0 新增 13 项任务/映射/表格测试，并补 3 项真实全量分析暴露的数组长度和实参候选超限回归。离线自写流程测试替代子进程，不能冒充真实构建；另确实从 GitHub 地址完成 GDB 的真实 Docker/npm 构建与分析，见[完整请求表及证据](gdb-build-pilot.md)。

首轮真实运行保留“构建成功、分析失败”记录；修复模型异常和 CRA 相对 sources 命名识别后，从仓库地址重新完整运行成功。同版产物经独立 AST 位置/URL/字段核对，并复核导出协议。分析完整性仍为 false，原因在表格和任务记录中保留。
