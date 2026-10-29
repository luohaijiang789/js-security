# 网站 JS 离线分析器

按[黑盒二执行计划](../docs/site-analysis-plan.md)实施的独立工程，目标先打通 HAR/已保存 JS → 原始引擎记录 → 参数与候选预览，再增加递归补取、精确发送点和正式 Excel。

设计见[总方案](../docs/site-analysis-design.md)，输入/结果/退出状态见[协议 0.1](docs/protocol.md)。当前已实现 S1 离线原型：目录/HAR 导入、不可变正文快照、内部字段保留、文件来源、候选与 CSV 预览。尚未实现联网递归获取、精确发送点/调用链、正式 Excel 和浏览器界面。

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

## 结果与含义

- `analysis.json`：任务状态、资产、候选、分组预览及缺口。
- `engine-records.json` 与 `engine/`：未经过有损 JSONL 转换的原始内部记录、解析审计和日志。
- `snapshot/`：按哈希保存的原始正文；`engine-input/` 为可检查的分组分析副本，不修改输入。
- `candidates.csv`、`parameters.csv`、`assets.csv`、`gaps.csv`：可筛选预览，正文和长字段由 JSON/ID 回查。

一个候选是一条可能被原生引擎归并的记录，**不等于一个精确调用点**。因此调用次数、唯一发送位置与已确认接口数目前为 null；只提供候选数量和保守的具体地址分组预览。精确位置和正式统计分别由 S3/S4 完成。

Query、Body、Header 的原始 schema/表达式保留，类型或占位符不当真实值。route 等非请求记录只留底稿。GraphQL/RPC 未映射的操作单列适配缺口。页面多义、同 URL 多版本或引擎文件名冲突时保留隔离/关联限制，不能假装完整分析。

固定引擎还会遗漏 `fetch('orders')` 这类单段相对字面量。当前解析审计为可能漏项登记模型缺口（不把未核验同名函数当确认发送点），尚未修复上游该语义；`fetch('./orders')` 可恢复并按 HTML base 解析。此边界单独测试，不用简单样例通过冒充任意相对 URL 均支持。

退出码：0=已有资产处理结束（仍可能有模型/定位缺口）；2=输入/配置错误；3=依赖、版本或引擎失败；4=缺正文、解析失败、超时等部分结果。空目录不作为成功；解析坏 JS 也不当作“没有 API”。

## 验证

```bash
work/site-js-analyzer-venv/bin/python -m unittest discover -s site-js-analyzer/tests -v
work/site-js-analyzer-venv/bin/python site-js-analyzer/tests/check_baseline.py --public
```

基线脚本需要已准备的开源实验资产，生成方法见[开源实测](../references/blackbox2-experiment/README.md)。它会检查原始、压缩及公开 bundle 哈希，再检查目录/HAR/压缩三种输入的 13 个预期请求、4 个 Query 和 8 个 Body 叶字段；公开 Swagger UI 仅作兼容性运行，不计算召回。生成的 HAR/报告/验证记录只放 work。

受控样例、自动化测试和公开 bundle 均不代替目标网站、登录态、Worker 或完整 Chrome 扩展现场验收。第三方版本与许可见[说明](THIRD_PARTY_NOTICES.md)。
