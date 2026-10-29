# Frontend API Extractor

输入一个前端代码仓，按固定版本和构建配置生成 JS，深入分析 JS 及其嵌套引用，输出 **URL、接口参数、Host、对应 JS 文件**。

当前可运行版本：**0.10.0**。项目正在重构分析核心：以 jshound 增强版为主线，保留仓库构建、资产收集和表格交付。增强版尚未完成，当前构建流程仍使用旧分析器。[当前状态与开发计划](docs/roadmap.md)是进度的唯一入口。

## 输入和结果

输入：GitHub 仓库地址、Commit、项目子目录及必要的构建/环境配置。支持哪些锁文件和命令，见[使用指南](docs/usage.md)。

目标主表如下；此行为格式示例，当前 Excel 仍包含更多证据列：

| URL | 接口参数 | Host | 对应 JS 文件 |
| --- | --- | --- | --- |
| `/v1/users/{id}` | Query：`page`；Body：`name`；Header：`Authorization` | `api.example.test` | `dist/assets/users.js:18:7` |

参数以字段名、嵌套路径和载体为主，路径参数保留在 URL 模板，不猜测运行时值。方法、条件、源码位置、引用链和未解析原因作为辅助信息保留。未知 Host 明确标记未知；同一接口来自不同 JS 时保留各自位置。

## 工作流程

```mermaid
flowchart LR
    A[仓库与固定 Commit] --> B[锁定依赖与正式构建]
    B --> C[清点 JS 与 source map]
    C --> D[追踪引用与嵌套 chunk]
    D --> E[请求识别与配置、封装还原]
    E --> F[四项主表与证据、缺口]
```

这是目标流程。当前已有受控构建和 JSON/Excel 交付，但递归资产发现、部分 source map 补扫、封装识别、性能和调用位置仍有缺口，见[审计](docs/audit.md)。本地源码扫描保留为辅助诊断入口，不替代构建结果验收。

## 快速开始

需要 Node.js 22+、Git、可用的本地 Docker 和依赖下载网络。以下命令从主仓库根目录开始，使用已有固定构建配置的公开样本：

```bash
cd frontend-api-extractor
npm ci
node src/repository-cli.js https://github.com/aliyun/alibabacloud-gdb-console --work-dir ../work/repository-scans
```

根据终端输出的 `taskDir` 查看：

```text
taskDir/
├── task.json                 # Commit、构建阶段和分析状态
├── logs/                     # 安装、构建及失败日志
├── analysis.json             # 原始分析结果
└── delivery/
    ├── api_assets.xlsx       # 请求表、参数明细、缺口
    └── analysis.json         # 统一交付底稿
```

样本使用 GDB 专用配置，不能外推任意仓库都能构建成功。其他仓库、预检、源码辅助分析和 AI 释义统一见[使用指南](docs/usage.md)。构建失败保留失败状态；不执行提取出的 API。

## 项目结构

```text
frontend-api-extractor/
├── README.md        # 项目入口
├── docs/            # 需求、架构、使用、开发计划和验证
│   ├── reference/   # 现有机制与开源依据
│   └── archive/     # 历次发布、实测、早期方案和累计能力
├── src/             # 当前实现；新核心逐步替换
├── tools/           # 验证、对照和审计工具
├── profiles/        # 构建与扫描配置
├── models/          # 固定引擎与协议模型
├── test/            # 回归测试
├── baselines/       # 小型预期与哈希清单
└── examples/        # 自写小样例
```

第三方参考源码统一在主仓库 `references/repos/`；外部测试仓库、依赖、构建产物和完整报告留在忽略目录 `work/`。不复制完整第三方仓库，不新开第二套完整项目。

## 文档入口

| 文档 | 负责回答 |
| --- | --- |
| [需求](docs/requirements.md) | 四项结果、输入和验收范围是什么 |
| [架构](docs/architecture.md) | 如何处理嵌套 JS、封装、语言选择和核心替换 |
| [使用](docs/usage.md) | 当前版本实际能运行哪些命令 |
| [开发计划](docs/roadmap.md) | 已有什么、先修什么、哪些尚未完成 |
| [验证](docs/testing.md) | 如何同时验证正确性、覆盖和速度 |
| [开发约定](docs/development.md) | 目录、依赖、文档如何维护 |

全部导航见 [docs/README.md](docs/README.md)。历史能力与验证保留在[归档](docs/archive/README.md)，不再逐版堆到本页。实现语言按复用效果、提取正确性和性能选择，不限定为 JavaScript。
