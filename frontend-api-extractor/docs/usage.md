# 使用指南

本文只描述当前 **0.10.0** 的可运行入口。jshound 增强核心及自动递归构建分析仍在[计划](plan.md)中，不能按目标架构假定已经实现。

所有命令从 `frontend-api-extractor/` 执行。工具需 Node.js 22+；仓库构建另需 Git、可用的本地 Docker 和依赖下载网络。目标项目使用的 Node/包管理器由构建配置决定。

```bash
npm ci
node src/repository-cli.js --help
```

## 仓库 → 构建 JS → Excel

已有固定样本配置可直接运行：

```bash
node src/repository-cli.js https://github.com/aliyun/alibabacloud-gdb-console --work-dir ../work/repository-scans
```

该地址自动采用 [gdb-console.json](../profiles/gdb-console.json)，固定 Commit `49336dbcc958236e233a921f60353802cbd43130`，使用项目需要的构建环境。本次文档整理没有重跑该构建。

其他仓库先复制[配置模板](../profiles/repository.example.json)，调整环境、项目目录、包管理器、构建命令和产物目录。以下 `OWNER/REPO` 替换为真实仓库：

```bash
mkdir -p ../work/my-project
cp profiles/repository.example.json ../work/my-project/build-profile.json
node src/repository-cli.js https://github.com/OWNER/REPO --profile ../work/my-project/build-profile.json --inspect-only --work-dir ../work/my-project/runs
```

预检会拉取并固定仓库，检查脚本/锁文件并输出 `build-plan.json`，不执行 Docker 安装/构建。核对计划后，去掉 `--inspect-only` 运行正式任务；用 `--ref` 指定真实完整 40 位 Commit 可固定复跑。未指定版本且无内置版本时会固定远端 HEAD。

当前 npm 需要 package-lock；pnpm/Yarn Classic 需要对应锁文件及明确完整包管理器版本。`projectDir` 支持子项目，不能自动猜测所有 monorepo/多应用构建；私有依赖和环境缺失会失败。

终端返回 `taskDir`，结果在 `taskDir/delivery/api_assets.xlsx` 与 `taskDir/delivery/analysis.json`。原始分析在 `taskDir/analysis.json`；`task.json`、`logs/` 记录构建和分析状态。失败先查具体阶段，不反复提高分析预算重试安装问题。

## 怎样读四项结果

| 目标 | 当前结果位置 |
| --- | --- |
| URL | API 总表的 URL、原始请求 URL、Path；底稿的 url/requestUrl 等 |
| 接口参数 | API 总表字段摘要及参数明细的 carrier/path/state；Query/Body/Header 分开 |
| Host | Host 及地址状态；未知不意味着当前页面域名 |
| 对应 JS | 产物位置与源码位置分开；查底稿 generatedFile/sourceFile 和证据 |

当前 Excel 仍含方法、阶段、条件、业务位置、仓库/Commit、缺口等辅助列。四项精简主视图尚未实现。静态候选不等于实际发生请求；无精确行列的外部候选不能可靠按调用 ID 统计，见 [A06](challenges.md)。

仓库任务退出 0 表示流程完成，仍须看 `task.json` 的分析完整性和 gaps。构建/执行错误退出 1。源码 CLI 的 2/3 状态是另一入口的契约，不要套用到构建 CLI。

## 本地源码辅助扫描

源码模式不构建、不安装目标依赖、不执行目标业务代码：

```bash
node src/cli.js /path/to/frontend --config /path/to/scan.config.json --out ../work/source/report.json
```

生成 `report.json`、`report.json.delivery/api_assets.xlsx` 和统一底稿。配置见[示例](../api-extractor.config.example.json)。

默认 `semantic` 是旧逐入口分析，可能耗时和超预算；源码还可选择 `jshound` 或 `hybrid`：

```bash
git -C .. submodule update --init --depth 1 references/repos/jshound
node src/cli.js /path/to/frontend --engine jshound --out ../work/indexed/report.json
node src/cli.js /path/to/frontend --engine hybrid --out ../work/hybrid/report.json
```

jshound 输出未核验候选，原生缺精确行列。hybrid 有已复现的客户端漏选 A01，不能当作保证全仓覆盖的推荐模式；当前构建 CLI 不接受 `--engine`。引擎原始快照和记录在 `report.json.engines/`，保留便于回查。

源码 CLI：0=处理结束且存在带地址片段候选；1=错误；2=没有这类候选；3=coverage 未完成。`--allow-empty` / `--allow-incomplete` 可显式放行相应状态。coverage finished 不等于模型完整；同时查看 complete、diagnostics 和未解析字段。maxSteps 仅限语义求值，不是整个程序时间上限。

## 可选 AI 字段释义

通过环境变量提供密钥，endpoint 使用完整 OpenAI 兼容 chat/completions 地址：

```bash
node src/ai-cli.js --input /path/to/task/delivery/analysis.json --out ../work/ai-delivery --enabled --endpoint https://provider.example/v1/chat/completions --model MODEL --key-env FRONTEND_AI_API_KEY
```

替换示例 endpoint/model，并在运行环境设置 `FRONTEND_AI_API_KEY`；不将密钥写进配置或 Git。当前仅对已提取字段加释义，不会修复漏发现的接口，真实模型质量尚未验收。

网站收集与插件是辅助方案，见主仓库[网站 JS 方案](../../docs/site-analysis.md)。不要把独立收集命令当作已经自动接入上述仓库构建。已知阻断统一见[难点与已知问题](challenges.md)，复跑规则见[测试与验收](testing.md)。
