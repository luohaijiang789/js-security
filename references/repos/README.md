# 参考项目源码

以下六个仓库已作为 Git 子模块引入，目录中检出完整源码。主仓库记录每个子模块的固定 Commit，保留上游 Git 地址、许可证和独立提交历史；默认浅克隆以减少下载量。

引入日期：2026-10-22。对应[用户确认清单](../已确认参考项目.md)。

| 本地目录 | 上游仓库 | 本次固定 Commit | 备注 |
|---|---|---|---|
| [EASYapi](EASYapi/) | https://github.com/gsubigya/EASYapi | `ef5ff71a9916bfe1be4dae8faf870ed0aade001d` | 浏览器采集与 JS 线索 |
| [openapi-devtools](openapi-devtools/) | https://github.com/maksimu/openapi-devtools | `3232414b82035a3003687d01c048956a083d309e` | 用户指定的 maksimu 分支 |
| [mitmproxy2swagger](mitmproxy2swagger/) | https://github.com/alufers/mitmproxy2swagger | `f432acafa5907258f0f529ff582c75fefdca00d7` | 流量转 OpenAPI |
| [akto](akto/) | https://github.com/akto-api-security/akto | `ccd5f52da6b219daebdce6e2c3886e1218def26d` | API 资产平台；本次拉取版本晚于前期评估快照 |
| [BurpAPIFinder](BurpAPIFinder/) | https://github.com/shuanx/BurpAPIFinder | `1f298590fa03492aac65b9a1aecd8a3b89fbf6a8` | **有 bug，需要维护；当前未修改上游源码** |
| [jshound](jshound/) | https://github.com/AmbitSecurity/jshound | `f34f9c5dcfa0f30816a66881ea9a8d8573c24f05` | JS 请求与字段静态提取 |

## 首次克隆

```bash
git clone --recurse-submodules https://github.com/luohaijiang789/js-security.git
cd js-security
```

已有主仓库时，在项目根目录执行：

```bash
git submodule update --init --recursive
```

仅下载 GitHub 主仓库的源码 ZIP 不包含子模块源码，需要使用上述 Git 命令获取。

## 检查与更新

```bash
# 查看主仓库锁定的各子模块版本
git submodule status

# 拉取主仓库更新后，同步到主仓库记录的版本
git pull
git submodule update --init --recursive
```

子模块不会自动追随上游最新提交。决定更新某个项目时，先在对应子模块中获取、检查并切换到目标 Commit，再更新本表，最后在主仓库提交该目录的版本指针。

## 后续维护

BurpAPIFinder 的具体 bug 与复现条件后续登记。需要修改子模块时，先在子模块创建维护分支；修复提交须推送到有写入权限的仓库或维护 fork，主仓库再记录可被重新拉取的 Commit。维护 fork 确定后同步修改 `.gitmodules` 地址，避免主仓库引用只存在本地的提交。

当前仅引入参考源码，尚未统一安装依赖、构建或启用这些工具；各项目的使用限制仍见其仓库文件与对应评估。
