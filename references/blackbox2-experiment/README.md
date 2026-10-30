# 黑盒二开源项目收集与实测

本目录维护可复现实验、固定版本和当前复用判断；第三方源码、环境、正文与原始输出均位于 `work/blackbox2-tools/`，不进入主仓库。补充调研不改变[用户确认的六个参考项目](../已确认参考项目.md)。

## 当前判断

优先采用 **jshound 作为静态提取和 JS 引用发现基线**；jsluice 可作独立线索/语法分析对照，LinkFinder 作简单路径基线。暂不叠加所有工具输出，否则重复和非请求字符串会增加。自有代码先补字段无损导入、精确发送位置、父链/深度和分组统计。

本轮已收集 8 个项目，6 个实际运行。下列结论来自固定源码与本地实测，不使用 README 的“全部接口”宣传作为验收。

## 项目清单

完整 SHA、许可和状态见 [tools.json](tools.json)。

| 项目 | 固定提交 | 本轮状态 | 适合的用途 |
| --- | --- | --- | --- |
| [jshound](https://github.com/AmbitSecurity/jshound) | `f34f9c5dcfa0` | 已安装；离线/递归/压缩/公开 bundle 实测 | 核心基线；API 方法、地址、结构与封装 |
| [jsluice](https://github.com/BishopFox/jsluice) | `0ddfab153e06` | 编译成功；离线/压缩/公开 bundle 实测 | Tree-sitter 提取和独立线索对照 |
| [LinkFinder](https://github.com/GerbenJavado/LinkFinder) | `1debac5dace4` | 已运行；离线/压缩/公开 bundle 实测 | 轻量正则路径基线 |
| [xnLinkFinder](https://github.com/xnl-h4ck3r/xnLinkFinder) | `841ac8dddbc7` | 已运行；目录与在线递归实测 | 离线链接/潜在参数线索；在线行为需适配 |
| [JSFinder](https://github.com/Threezh1/JSFinder) | `d70ab9bc5221` | 已运行；普通与深度模式实测 | 简单页面脚本/URL 收集对照 |
| [URLFinder](https://github.com/pingc0y/URLFinder) | `da01795e3ff8` | 编译成功；普通与深入模式实测 | JS 递归收集与来源线索对照 |
| [Vespasian](https://github.com/praetorian-inc/vespasian) | `daa3dafc68f0` | 已收集并核查源码；构建阻塞 | HAR/代理输入与静态/实测关联参考 |
| [JShunter](https://github.com/cc1a2b/jshunter) | `9e130cfd3ed8` | 已收集并核查源码；构建阻塞 | chunk 图与端点线索候选 |

前六项中 JSFinder 未见根 LICENSE，暂不复制代码集成；其他许可见清单。Vespasian 需要 Go 1.27，JShunter 需要 Go 1.25；本地 Go 1.24 构建失败，自动工具链下载又被网络策略拒绝，未改低 go.mod 或声称运行成功。系统 `/usr/bin/go` 实为同名非 Go 编译器程序；本轮另在 work 下安装了 Go 1.24。

## 测试材料与口径

1. 自有受控站点：HTML → main.js → level2.js → level3.js → level4.js → level2.js，4 个 JS、13 个预期请求、3 个非 API 干扰项。涵盖 fetch/XHR/Beacon/Axios、别名、baseURL、动态路径、共享发送函数、嵌套 Body 与 Query。函数不执行，服务端记录扫描器的实际 GET。
2. 同样的 4 个 JS 用 esbuild 0.28.2 分别压缩，保留模块边界，不 bundle、不通过删功能降低难度。
3. 公开真实产物：Swagger UI 固定版本的 `dist/swagger-ui-bundle.js`，1,684,244 字节。来源 Commit 与 SHA256 见 [public-sample.json](public-sample.json)。只离线读取该 bundle，没有真实站点接口真值，不计算其召回率。

受控真值及正文哈希见 [fixture-manifest.json](fixture-manifest.json)，生成器见 [make_fixture.py](make_fixture.py)。结果中“方法 + 路径”不等于 Host、值、位置和全部场景均正确；动态路径按预期静态前缀匹配，完整原始记录留在 work。

该样例按标准全局 Axios 语义标注，但没有加载 Axios SDK 或运行浏览器业务流程，因此也不构成真实模块绑定、浏览器执行与 SDK 覆盖验收。

## 受控 API 提取结果

| 输入与工具 | 正确方法 + 路径的预期项 | 三个干扰项进入原始输出 | 解释 |
| --- | --- | --- | --- |
| jshound，原始目录 | 13/13 | 0 | 包括两个共享发送函数调用与带 baseURL 的 tickets |
| jshound，在线递归 | 13/13 | 0 | 取得 4 个 JS，包含从未执行业务函数中的请求 |
| jshound，压缩目录 | 13/13 | 0 | 这里只验证压缩/重命名，不代表复杂混淆 |
| jsluice，原始目录 | 7/13 | 3 | 原始 42 条混合发送调用/字符串等线索；不是 42 个 API |
| jsluice，压缩目录 | 7/13 | 2 | 原始 40 条；压缩器简化了普通同名函数，不据此判定引擎更准 |

jsluice 对其他路径也给出线索，但未为本样例的 Beacon/Axios/别名/自定义封装完整恢复 Method，且没有合成 client 的 baseURL。此表按明确已输出的方法计分，没有替工具补猜；也不能把未完整恢复解释为完全没发现线索。

LinkFinder、xnLinkFinder、JSFinder、URLFinder 的路径列表不直接参与该“方法 + 路径”评分，因为它们没有在此输出中提供相应结构。它们发现了多个业务路径，也包含干扰和无法合成 baseURL 的 `/tickets`，应作为候选导入。

**jshound 字段与定位缺口：**内部结果包含 4/4 个预期 Query 字段（limit、page、sort、view），常用 `requests.jsonl` 中这些 Query 信息为 0；JSONL 保留了 8/8 个预期 Body 叶字段，但值多为占位/类型，不能当实际值。原始输出可关联文件，尚不能当作已经提供原始发送点行列和完整调用链。离线裸目录没有页面来源映射时 Host 会保持缺失，必须由输入适配保留上下文。

## 在线递归与实际请求

以下为受控 HTTP 服务记录，URLFinder 未开启 `-s` 状态探测；其他工具采用复现脚本中的明确参数。

| 工具/模式 | 本地 HTTP 请求 | 真正请求正文的 JS 数 | 对 `/api/` 的额外 GET |
| --- | --- | --- | --- |
| jshound，默认 chunk 跟踪 | 5 | 4 | 0 |
| URLFinder `-m 2` | 4 | 3 | 0 |
| xnLinkFinder `-d 4` | 17 | 3 | 10 |
| JSFinder，普通 | 2 | 1 | 0 |
| JSFinder `-d` | 1 | 0 | 0 |
| URLFinder `-m 1` | 1 | 0 | 0 |

URLFinder 深入模式导出列出 4 个 JS，但本地流量只取到前三个，缺 level4 正文中的 API，证实“已发现”与“已获取”需要分开。JSFinder `-d` 在本样例未增加覆盖；这是含端口本地样例的观察，不外推所有站点都失败。

xnLinkFinder 在线模式访问了发现的业务路径及干扰路径，不能原样当成只取静态 JS 的默认收集器。它的 `parameters.txt` 是跨上下文潜在词表，不是每条 API 的完整请求参数。离线目录模式可作为线索来源。

运行还发现 xnLinkFinder 在非终端 stdin 下会优先读取 stdin、忽略 `-i`，可能空跑并返回 0。复现器给它终端 stdin，并将默认配置目录定向 work；未改其分析源码。URLFinder 源码默认有更新检查及关闭 TLS 验证的行为，本轮只对本地 HTTP 样例运行，不能不经适配直接作为正式外部获取器。

## 公开压缩产物观察

Swagger UI 单 bundle：jshound 输出 3 个带动态片段的 GET 候选，约 43 秒；jsluice 输出 38 条混合线索，约 3.5 秒；LinkFinder 输出 66 行，约 0.17 秒。三项并发、单次运行，仅记录兼容性和本次成本，不作稳定性能排名。

该产物大量依赖运行配置，无法由静态字符串恢复出完整业务接口。输出数量含文档链接、类型字符串或动态模板，不能用 66 > 38 > 3 比较 API 召回率。这说明受控样例 13/13 不足以证明实际网站已经可用。

## 复现与立即试用

在仓库根目录执行，准备脚本只将上游源码和依赖写入 work。构建 jsluice/URLFinder 需要真正的 Go 编译器，本轮使用 work 内的 Go 1.24。

```bash
python references/blackbox2-experiment/prepare.py
python references/blackbox2-experiment/make_fixture.py
python references/blackbox2-experiment/run_experiment.py
python references/blackbox2-experiment/score.py
python references/blackbox2-experiment/run_public.py
```

本次环境已经准备好前六项。可以立即使用现有能力分析保存的 JS：

```bash
work/blackbox2-tools/venv/bin/jshound work/blackbox2-tools/fixture -o work/try-static
work/blackbox2-tools/bin/jsluice urls --include-source work/blackbox2-tools/fixture/main.js
```

原始结果：`work/blackbox2-tools/results/` 下保留全部 stdout/stderr、`runs.json`（命令/用时/退出码）、`http-traffic.json`（受控站点访问记录）、`jshound-internal.json`、`score.json`、`public-runs.json`。构建和依赖日志在 logs；输入和公共 bundle 同样保留在 work。

## 下一步

直接围绕 jshound 基线做最小结果适配：保留内部 Query/嵌套结构，新增逐发送点位置与引用缺口；jsluice 作为独立对照。再补真实打包器、登录态、Worker、多版本和独立人工标注样本。这里的实验完成不代表[黑盒二计划](../../website-js-extractor/docs/plan.md)的完整实现项通过。
