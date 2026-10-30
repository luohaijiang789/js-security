# 网站 JS 分析器：离线与受控补取

按[黑盒二执行计划](../docs/site-analysis-plan.md)实施的独立工程，目标先打通 HAR/已保存 JS → 原始引擎记录 → 参数与候选预览，再增加递归补取、精确发送点和正式 Excel。

设计见[总方案](../docs/site-analysis-design.md)，输入/结果/退出状态见[协议 0.2](docs/protocol.md)。当前已完成离线链路与 S2 的引用发现、最短深度和受控串行补取：支持目录/HAR、引用关系 CSV、限定来源的 JS 下载与已保存正文恢复。API 精确位置/调用链、并发调度、Worker 完整上下文、正式 Excel 和浏览器界面尚未完成。

固定复用 jshound，不将插件工程或已删除白盒旧服务作为依赖；实现进度只在根 docs 的执行计划更新，不在此复制 Checklist。

## 安装与运行

Python 3.10+、Node.js 18+、Git。依赖固定的 jshound 子模块，实际解析使用其内置 Babel；本工程不新增第三方 Python 运行依赖。以下从仓库根目录执行，环境和结果放 work：

```bash
git submodule update --init references/repos/jshound
python -m venv work/site-js-analyzer-venv
work/site-js-analyzer-venv/bin/python -m pip install -e site-js-analyzer
work/site-js-analyzer-venv/bin/site-js-analyzer analyze --har session.har --out work/site-scan
```

已保存的 JS/HTML 目录：

```bash
work/site-js-analyzer-venv/bin/site-js-analyzer analyze --directory saved-js --page-url https://app.example.com/ --out work/site-scan-directory
```

`--page-url` 仅对目录输入可选，表示用户明确提供的执行页面；不填时读取可用的 `_origin.jsonl`，仍缺上下文就保留未知 Host。脚本 CDN 地址不充当页面基址。新输出目录必须为空，已有结果不会覆盖；输出不能嵌在输入目录中。

`--timeout` 是所有引擎分组共用的秒数上限（默认 120），到期终止引擎及子进程，保留导入快照。输入预算为 `--max-files`、`--max-asset-mib`、`--max-total-mib`。当前支持 UTF-8/UTF-8 BOM；其他文本编码保留缺口，不做有损替换。Linux/macOS 进程组实现尚未做 Windows 现场验证。

## 引用与递归补取

默认离线构图，不会自动联网。显式开启补取时必须提供精确 origin；允许多个静态资源 origin，不按 API Host 筛掉输出接口：

```bash
work/site-js-analyzer-venv/bin/site-js-analyzer analyze --har session.har --fetch-js --allow-origin https://app.example.com --allow-origin https://cdn.example.com --max-js-depth 3 --out work/site-recursive
```

HTML 深度为 0，直接脚本与内联模块导入为 1，后续每条确定引用加一；默认只补到 3。已在 HAR/目录中的更深 JS 仍分析。循环/多父保留边并复用正文，按最短已知父链计算；无父链不伪装成第一层。只有 JS 而缺少页面引用时，可用 `--seed-js` 明确指定已导入的 JS URL/相对路径作为第一层。

复用固定引擎的 import 与 chunk 映射。import map 支持精确项、前缀、scopes 和 null 阻断；推测文件名、动态路径及缺少 publicPath/模块基址的表只留候选。Webpack 旧式 builder 的原始位置可能不由上游暴露，字段保留 null，不猜行列。引用位置不等于 API 发送位置。

`--fetch-timeout` 默认 10 秒，`--fetch-deadline` 与 `--discovery-timeout` 默认各 60 秒；发现预算也覆盖本轮构图/补取过程，先到的预算会停止相应阶段。`--max-fetch-files` 默认 100（计尝试文件，含失败），`--fetch-retries` 默认 1（仅连接失败/429/5xx 等有限重试）。单个正文与累计下载字节同时受输入字节预算约束；超限或不完整响应不作为成功脚本。当前串行执行，尚未验证高并发/大站压力能力。

需要登录保护脚本时，`--session-file` 可指向本地 JSON：外层键为精确规范 origin，内层为显式请求头。配置不进入报告；不自动从 HAR 复制 Cookie/Authorization；每个重定向 origin 重新检查并使用其自己的配置。保留系统代理与 TLS 校验。配置说明和边界见[执行约定](docs/collection.md)。

恢复已保存正文，再继续到第四层：

```bash
work/site-js-analyzer-venv/bin/site-js-analyzer analyze --resume work/site-recursive --fetch-js --allow-origin https://app.example.com --allow-origin https://cdn.example.com --max-js-depth 4 --out work/site-resumed
```

恢复校验路径、正文哈希与资产身份，已有正文不会因恢复而重取；新预算和来源选项仍需明确提供。旧 0.1 报告没有 collection checkpoint，应使用原输入重新运行。补取是新的资源观察，不证明与原 HAR 同版；缺失/截断/歧义都保留，不能声称全站已覆盖。

## 结果与含义

- `analysis.json`：任务状态、资产、候选、引用边、最短深度、补取记录与缺口。
- `collection.json`、`discovery/`：可恢复的正文索引、引用图及原生发现证据；没有认证头值。
- `engine-records.json` 与 `engine/`：未经过有损 JSONL 转换的原始内部记录、解析审计和日志。
- `snapshot/`：按哈希保存的原始正文；`engine-input/` 为可检查的分组分析副本，不修改输入。
- `candidates.csv`、`parameters.csv`、`assets.csv`、`references.csv`、`gaps.csv`：可筛选预览，正文和长字段由 JSON/ID 回查。

一个候选是一条可能被原生引擎归并的记录，**不等于一个精确调用点**。因此调用次数、唯一发送位置与已确认接口数目前为 null；只提供候选数量和保守的具体地址分组预览。精确位置和正式统计分别由 S3/S4 完成。

Query、Body、Header 的原始 schema/表达式保留，类型或占位符不当真实值。route 等非请求记录只留底稿。GraphQL/RPC 未映射的操作单列适配缺口。页面多义、同 URL 多版本或引擎文件名冲突时保留隔离/关联限制，不能假装完整分析。

固定引擎还会遗漏 `fetch('orders')` 这类单段相对字面量。当前解析审计为可能漏项登记模型缺口（不把未核验同名函数当确认发送点），尚未修复上游该语义；`fetch('./orders')` 可恢复并按 HTML base 解析。此边界单独测试，不用简单样例通过冒充任意相对 URL 均支持。

退出码：0=已有资产处理结束（仍可能有模型/定位缺口）；2=输入/配置错误；3=依赖、版本或引擎失败；4=缺正文、未取得的确定引用、深度/范围截断、解析失败或超时等部分结果。空目录不作为成功；解析坏 JS 也不当作“没有 API”。

## 验证

```bash
work/site-js-analyzer-venv/bin/python -m unittest discover -s site-js-analyzer/tests -v
work/site-js-analyzer-venv/bin/python site-js-analyzer/tests/check_baseline.py --public
work/site-js-analyzer-venv/bin/python site-js-analyzer/tests/check_collection.py
```

基线脚本需要已准备的开源实验资产，生成方法见[开源实测](../references/blackbox2-experiment/README.md)。它会检查原始、压缩及公开 bundle 哈希，再检查目录/HAR/压缩三种输入的 13 个预期请求、4 个 Query 和 8 个 Body 叶字段；公开 Swagger UI 仅作兼容性运行，不计算召回。生成的 HAR/报告/验证记录只放 work。

递归回归另核查冻结的公开 Webpack/Vite 样例与本地 HTTP 链路，记录默认三层、恢复第四层及未调用业务 API 的访问日志。Vite 样例缺模块基址的 3 个表项仍为候选，2 个字面量 import 为确定引用，不能都算成已获取脚本。

受控样例、自动化测试和公开 bundle 均不代替目标网站、登录态、Worker 或完整 Chrome 扩展现场验收。第三方版本与许可见[说明](THIRD_PARTY_NOTICES.md)。
