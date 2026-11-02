# 使用说明：插件为主，命令行为调试入口

当前交付是可构建的 MV3 插件原型及本机 HTTP 分析原型。它收集浏览器已解析 JS，保存完整源码和观察，冻结快照，调用同一分析核心展示四项候选与缺口。尚未完成真实目标 Chrome MV3 验收或集成黑盒一；不保证静态未加载脚本的 D3 补抓、所有子目标基址、精确调用位置、正式统计或 Excel。

## 构建和加载

从仓库根目录准备分析核心：

```bash
git submodule update --init references/repos/jshound
python -m venv work/website-js-extractor-venv
work/website-js-extractor-venv/bin/python -m pip install -e ./website-js-extractor
cd website-js-extractor/extension
npm ci
npm run build
```

在允许自定义扩展的目标 Chrome 打开扩展管理页，启用开发者模式，加载已解压的 `website-js-extractor/extension/dist/`。点击插件图标打开管理页，复制其中的扩展 ID。本工程的扩展与黑盒一暂时独立加载；若某网页已由黑盒一或 DevTools 占用调试会话，采集会记连接缺口，不强行接管。

2026-10-30 的开发环境验证记录显示企业策略禁止自定义扩展，该次现场项未验收；这不是产品在所有机器上均受限的结论。请记录实际目标环境，不修改策略绕过限制。构建、替代 API 或普通网页 UI 检查不能代替 MV3 现场通过。

## 启动本机分析

回到仓库根目录，以实际扩展 ID 替换占位符：

```bash
work/website-js-extractor-venv/bin/python -m website_js_extractor serve --extension-id YOUR_EXTENSION_ID --port 8378 --data-dir work/website-plugin-jobs
```

请在 Chrome 所在机器启动服务；开发容器的 loopback 不会自动成为用户电脑的 loopback。当前只在 Linux 开发环境验证，Windows 发行与安装仍待单独验收。

服务只绑定 `127.0.0.1`，验证精确扩展 Origin、Host 和随机配对密钥；终端显示本次配对密钥。将服务地址和密钥填入插件管理页。密钥仅保留在页面内存，不随快照导出；关闭页面或服务重启后需要重新填写。不要把配对密钥写入源码、普通日志或任务包。启动时验证锁定 jshound 与 Node，服务不会访问任何脚本或 API URL。

原型服务使用 `/v0` 与 `capture-0.1`，不是设计中的正式 `/v1`。只接收一次性有界 JSON 快照，不代表分块上传、正式配对/升级协议已完成。单作业分析、最多保存 20 个作业（包括已完成作业）、单次上传 20 MiB；达到保存上限后，停止服务，归档原数据目录，并选择新的目录。服务重启将未结束任务标 interrupted；不会自动重跑或更换正文。服务意外崩溃的进程树恢复仍待正式任务管理验收。

## 操作

1. 新建采集任务，自动接入当前及新建/导航的 HTTP/HTTPS 网页。正常登录和操作页面，后台持续读取已解析源码；关闭管理页不会主动结束任务。
2. 查看脚本观察数、完整正文字节与采集缺口；“查看 / 刷新脚本”列出已保存来源、哈希与大小，点击可读完整源码。首轮只有 Debugger 已解析源码入口，尚未接入 DOM/Network 正文对照及未加载引用补抓。源码观察不证明对应 API 曾发送。
3. 暂停或停止后生成固定快照，可先导出 JSON 离线保存。暂停会分离调试连接；恢复会重新读取当前代码，可能保留同代码的新一代观察，不把它当新增接口。后台重启会将任务标 interrupted，已持久化正文保留；需新建任务继续采集。
4. 配对后分析快照，查看文件级 URL、参数、Host 与 JS 来源，点击候选在右侧看详情；缺口可展开，JSON 可导出。缺失引用与未知来源使结果为 partial，不能用候选数代替确认接口数。
5. 取消分析会回收作业与引擎进程；已有快照继续保留。导出的快照可离线重放：

```bash
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --capture snapshot.json --out work/capture-analysis
```

本轮捕获输入的结果始终记浏览器观测范围缺口（通常退出码 4）；请求基址为捕获时的静态上下文，不证明业务运行时配置相同。没有 HTML 父链时深度保持未知。顶层文档的 baseURL 取自 CDP DOM；无法确认的 iframe/Worker/匿名脚本基址保持未知，不用 CDN 域名补 Host。inline/sourceURL/blob 代码不伪装成外部 HTTP 脚本。

## 原型预算与恢复边界

实际插件、上传、作业与报告预算统一见[协议预算表](protocol.md#原型预算来源)，不在此重复默认值。超限不保存半截源码；额外缺口数量单列。原型尚无历史任务/快照自动清理与增量恢复，归档后再按用户意图清理，不自动删除旧数据腾空间。

上传 JSON 的字节预算与源码预算分别计；重复正文在不同上下文仍可保留不同观察。相同 snapshot_id 重传内容一致时返回同一作业；内容变化则拒绝，想重跑应生成新快照 ID。旧快照不因后续采集而修改。

## 命令行调试与重放

以下从仓库根目录执行；使用同一 Python 包和锁定核心，不是另一产品。默认离线；新输出必须为空，不覆盖输入，目录输入/恢复的输出也不能嵌入输入目录。当前无 `--config`、doctor、独立 import 等命令。

```bash
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --har session.har --out work/har-analysis
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --directory saved-js --page-url https://app.example.com/ --out work/directory-analysis
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --resume work/har-analysis --out work/restored-analysis
```

`--page-url` 仅对目录输入使用；不填时读取可用的 `_origin.jsonl`，无依据的页面/Host 保持未知。UTF-8/BOM 为无损支持范围。支持恢复 collection 0.2–0.5，旧 0.1 无 checkpoint 应用原输入重跑；恢复验证路径、正文哈希与身份，重新计算引用与临时失败。

显式补取实验必须提供精确 origin，可以指定多个资源来源；不按 API Host 筛掉结果，也不从 API 候选发出请求：

```bash
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --har session.har --fetch-js --allow-origin https://app.example.com --allow-origin https://cdn.example.com --max-js-depth 3 --out work/recursive-analysis
work/website-js-extractor-venv/bin/python -m website_js_extractor analyze --resume work/recursive-analysis --fetch-js --allow-origin https://app.example.com --allow-origin https://cdn.example.com --max-js-depth 4 --out work/deeper-analysis
```

| 参数组 | 当前默认/约束 |
| --- | --- |
| 输入 `--max-files` / `--max-asset-mib` / `--max-total-mib` | 1000 / 20 / 128；累计正文按资产计，HAR/checkpoint输入也受限制 |
| 分析 `--timeout` | 120秒，所有引擎分组共用；不是每个文件120秒 |
| 发现 `--discovery-timeout` | 60秒，涵盖本轮构图/补取；预算先到先停止 |
| 补取 `--max-js-depth` / `--max-fetch-files` | 3 / 100；文件配额计不同上下文/根脚本的获准尝试，含失败；重试/重定向不重复计 |
| `--fetch-timeout` / `--fetch-deadline` / `--fetch-retries` | 单次10秒 / 总60秒 / 1次，重试配置0–5，仅有限连接错误/429/5xx |
| `--fetch-concurrency` | 默认4，范围1–32；同上下文去重、不同上下文隔离 |
| `--seed-js` | 明确把已导入JS设为D1；不自动把所有加载文件当根种子 |
| `--session-file` | 本地JSON，规范精确origin映射显式请求头；仅与fetch-js使用，不复制HAR认证或跨域继承 |

网络额度为初始输入剩余字节，包含失败读取成本；不能当网卡流量。导入关联仍受输入预算，完整响应也可能在入库时因预算被拒绝。CLI 补取是新观察，不证明与旧 HAR 同版。Worker/动态script 的支持边界和 UTF-16 引用位置见[分析设计](analysis-design.md)，实际输出/退出码见[协议](protocol.md)。

## 验证入口

在 `website-js-extractor/extension/` 执行：

```bash
npm ci
npm run build
npm test
npm run test:cdp
npm run test:ui
npm run test:mv3
```

默认 npm test 是无需 Chrome 的逻辑/存储/消息检查；其余三个入口需要实际 Chromium，可用 CHROMIUM_PATH 指定位置。CDP检查读取真实协议源码并调用真实核心，UI检查替代扩展API和服务响应，MV3检查才加载真实扩展。验证分层、故障矩阵及发布规则只见[testing](testing.md)。现场脚本可通过 PYTHON 指定分析环境，Windows发行仍需另验。

Python检查从仓库根目录执行：

```bash
work/website-js-extractor-venv/bin/python -m unittest discover -s website-js-extractor/tests -v
work/website-js-extractor-venv/bin/python website-js-extractor/tests/check_baseline.py --public
work/website-js-extractor-venv/bin/python website-js-extractor/tests/check_collection.py
work/website-js-extractor-venv/bin/python website-js-extractor/tests/check_collection_load.py
work/website-js-extractor-venv/bin/python website-js-extractor/tests/check_workers.py --prepare
```

基线需要[开源实测](../../references/blackbox2-experiment/README.md)准备的固定资产；检查器验证原始/压缩/public哈希及预期字段。Worker首次 `--prepare` 显式下载固定 MDN Commit 并校验哈希，后续去掉该参数只用本地。公开正文/报告仅放 work；许可见[第三方说明](../THIRD_PARTY_NOTICES.md)。

当前可复核结果索引只在[计划](plan.md#3-已有证据索引)维护。后续共享会话和黑盒一接入只见[架构](architecture.md#5-黑盒一集成方案仅设计)，本轮不实施集成。
