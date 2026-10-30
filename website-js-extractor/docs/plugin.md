# 插件原型：构建、加载与本机分析

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

本仓库当前开发环境的 Chromium 企业策略禁止自定义扩展，因此不能把本环境的构建、替代 API 测试或普通网页 UI 测试称为 MV3 现场通过。不得修改策略绕过此限制。

## 启动本机分析

回到仓库根目录，以实际扩展 ID 替换占位符：

```bash
work/website-js-extractor-venv/bin/python -m website_js_extractor serve --extension-id YOUR_EXTENSION_ID --port 8378 --data-dir work/website-plugin-jobs
```

请在 Chrome 所在机器启动服务；开发容器的 loopback 不会自动成为用户电脑的 loopback。当前只在 Linux 开发环境验证，Windows 发行与安装仍待单独验收。

服务只绑定 `127.0.0.1`，验证精确扩展 Origin、Host 和随机配对密钥；终端显示本次配对密钥。将服务地址和密钥填入插件管理页。密钥仅保留在页面内存，不随快照导出；关闭页面或服务重启后需要重新填写。不要把配对密钥写入源码、普通日志或任务包。启动时验证锁定 jshound 与 Node，服务不会访问任何脚本或 API URL。

原型服务使用 `/v0` 与 `capture-0.1`，不是设计中的正式 `/v1`。只接收一次性有界 JSON 快照，不代表分块上传、正式配对/升级协议已完成。单作业分析、队列上限 20 个保存任务、单次上传 20 MiB；达到保存上限后，停止服务，归档原数据目录，并选择新的目录。服务重启将未结束任务标 interrupted；不会自动重跑或更换正文。服务意外崩溃的进程树恢复仍待正式任务管理验收。

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

单任务最多保存 300 个完整源码观察、单正文 2 MiB、累计 12 MiB，最多 60 个已接入目标和 500 个源码观察排队标识，读取并发 2。超限不保存半截脚本；缺口上限 200，额外缺口数量单列。正文和快照保存在扩展 IndexedDB；存储失败会中断任务并显示错误，不自动删除旧数据腾空间。快照与浏览器侧历史任务的清理/增量恢复尚未实现，长期使用前需归档并关注扩展存储。

上传 JSON 的字节预算与源码预算分别计；重复正文在不同上下文仍可保留不同观察。相同 snapshot_id 重传内容一致时返回同一作业；内容变化则拒绝，想重跑应生成新快照 ID。旧快照不因后续采集而修改。

## 验证入口

在 `website-js-extractor/extension/` 执行：

```bash
npm run build
npm test
npm run test:cdp
npm run test:ui
npm run test:mv3
```

`test:cdp` 用真实 Chromium 的 CDP 读取初始/延迟加载源码并将冻结正文交给真实分析核心，核对 HTML base 与无 API 探测；它未加载 Chrome 扩展，不覆盖扩展权限和后台。`test:ui` 使用真实 Chromium 渲染管理页，但替代 chrome API 和服务响应；它只验证界面。`test:mv3` 才加载实际扩展、连接实际本机服务及真实核心，并核对无 API 探测；企业策略禁止扩展时以非零状态明确标未验收。现场脚本默认 Python 路径为本仓库 work 环境，可通过 PYTHON/CHROMIUM_PATH 指定已安装环境；Windows 发行仍需另验。

默认 npm test 只运行无需 Chrome 的逻辑/存储/消息检查；CDP、UI、MV3 三个入口需要实际 Chromium，可用 CHROMIUM_PATH 指定位置。

Python 原有检查与 `tests/test_capture_service.py` 验证新输入、Origin/密钥/Host、上传预算、哈希、幂等冲突、真实核心返回、取消/中断和旧快照恢复。日志和界面截图只在 `work/blackbox2-tools/logs/plugin-*`、`work/website-plugin-ui/`；完整 MV3 链路尚未现场通过。

后续集成黑盒一时复用目标/会话层、任务入口与 UI；将 Collector 的独占 attach/detach 适配成共享所有权，不能把两套 attach 直接同时运行。两类证据继续分开统计。
