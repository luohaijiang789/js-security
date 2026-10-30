# 黑盒二结果与补取协议 0.2

0.2 在 S1 的候选底稿上增加引用图、深度、补取观察与恢复；不等同于已完成全量 API 统计。进度只在[执行计划](../../docs/site-analysis-plan.md)维护。

## 输入

CLI 接收已保存目录、含正文 HAR 或已验证的 0.2 collection checkpoint，输出新目录。默认不联网；只有显式 `--fetch-js` 加精确 origin 才补取确定脚本引用，不执行输入 JS，不从 API 候选生成探测请求。目录只读取普通 JS/HTML 文件，不跟随符号链接；URL/页面上下文缺失时保持未知。HAR 只接收成功的脚本/页面正文，支持明确 Base64；记录缺正文、无效编码、错误状态及未知执行上下文。HAR 中业务 API 请求次数不参与静态接口统计。

目录可读取 `_origin.jsonl` 的 f/u/d 映射，禁止以它读取输入根外文件。`.cjs` 暂未被固定引擎枚举，单列不支持；文本仅无损支持 UTF-8/BOM。查询串脚本、本地 URL 路径无法安全映射等情况分别保留正文，但模块身份关联记部分，不能声称跨模块链已完整恢复。

正文按 SHA256 保存，Asset ID 还包含来源 URL/输入位置/页面/版本身份。相同正文可共享存储，但原始地址、上下文和版本不合并。HTML 与 JS 的扩展名不能代替响应正文检查，200 登录 HTML 不作 JS。多页面和同 URL 多版本分组分析；互斥版本无法关联时分别分析并记跨文件关联受限，不能任取版本混析。

## 输出

| 对象 | 必需内容 |
| --- | --- |
| Task | schema_version、任务 ID、输入路径/哈希、工具版本/引擎 Commit、阶段、状态、停止原因 |
| Context | 页面/Worker 基址、证据来源、已知/未知状态 |
| Asset | ID、URL/输入相对路径、内容哈希、正文相对路径、类型、上下文、导入/分析状态 |
| AssetEdge | 父文件/哈希、引用类型与位置、目标表达式/解析基址、确定/结构化/候选、子资产 ID、最短深度及获取状态 |
| EngineRecord | 引擎内部原始 JSON，保留 Query/Body/Header、类型、配置、表达式及来源；不经有损 JSONL 转换 |
| RequestCandidate | ID、原始记录引用、静态来源、地址/方法/参数及状态、资产 ID、文件级证据、未知位置/调用上下文 |
| ApiGroupPreview | 可形成已知 Host/Method/路径键的候选分组，保留成员；未解析地址不强并，不能叫已确认接口数 |
| Gap | 类型、资产/候选引用、原因、影响、后续动作 |

文件：`analysis.json`、`engine-records.json`、`snapshot/`、`candidates.csv`、`parameters.csv`、`assets.csv`、`references.csv`、`gaps.csv`，以及 `collection.json` 与 `discovery/` 原始发现证据。JSON 是完整底稿，CSV 为预览，所有外部文本按文本转义。正文文件与 JSON 的关系用 ID/相对路径，不含执行指令。

## 字段与计数规则

- 读取原始 `template`、`query_schema`、`body_schema/body_shape/body_keys` 与 `req_headers`，同时保留完整原始记录。字段名、类型表达式和实际值分别表达；缺少结构不能当作空结构。
- 只把引擎请求类型映射成请求候选；route/字符串/模型/配置记录保留为底稿，不调用会将 route 改成 GET 的导出转换。GraphQL/RPC 未完整适配时明确记缺口。
- 相对请求只在页面/Worker 基址及发送语义有依据时还原，不能使用 JS CDN 域名填 Host。未知 Method 不默认 GET。
- 原生引擎已可能跨位置归并，因此一个输出候选代表一条原生引擎记录，不代表一个调用或唯一发送点。当前 `send_site` 和 `call_context` 仍未知，精确位置缺口必须可见。
- 预览按已知 scheme/authority + Method + 有证据的路径模板分组。候选预览、未解析数可提供；已确认接口数、精确调用数/发送点数使用 null，不能以 0 掩盖尚未计算。
- 所有结论只针对已导入/已分析资产；不报告全站覆盖率，不将一次运行成功等同于所有 API 已找到。

## 引擎与错误

固定 jshound Commit `f34f9c5dcfa0f30816a66881ea9a8d8573c24f05`，MIT。从独立子进程调用离线 `analyze_with_paths`，检查锁定路径版本，不修改子模块；原始 JS 不由 Node 执行。超时必须终止引擎进程组，保留已导入快照和失败原因，避免子进程继续运行。分析不是进程安全隔离沙箱。

退出码：0=已有资产处理完成（仍可有分析模型/定位缺口）；2=输入/配置错误；3=依赖/版本/引擎失败；4=输入不完整、未分析或超时的部分结果。空目录不返回 0。输出目录已有文件时拒绝覆盖；失败也写任务状态（能创建输出时）。入口应打印阶段和最终缺口数。

## 引用、深度与恢复

`AssetEdge.status` 分别表示 available（已关联正文，不等于解析成功）、candidate（推测，不自动补取）、unresolved、ambiguous_version、unknown_depth、missing_offline、depth_limit、范围/网络/响应/预算失败。资产的 analysis_status 独立记录解析情况，不能用边的 available 冒充分析成功。引用行列/偏移有依据才填写；旧式上游 builder 未暴露的位置为 null。

HTML 为 0，直接外链为 1，后续确定引用加一；已取得的深层资产照常分析。候选不建立确定层级；未知父链保持 null。短路径晚到时重新计算，循环/多父复用资产但不删除边。裸目录可保留 reference_url 的推导依据，与原始观察 URL 分开；import map 阻断不能回退到同名本地文件。

补取记录保留请求 URL、GET、状态、重试与时间，不保存 session 请求头值。重定向逐跳校验 origin，认证不跨域继承。只接受完整 JS 正文；错误 MIME/HTML/短响应不能当脚本成功。字节与文件预算包含失败尝试的成本，精确说明见[执行约定](collection.md)。当前串行，尚未完成并发与压力验收。

collection checkpoint 原子保存正文相对路径/哈希/身份、图和导入缺口。恢复验证路径不逃出来源目录、正文哈希与资产身份；重新计算本轮引用状态，保留原始输入缺口，不保留上轮暂时性网络失败为已解决事实。新补取与旧 HAR 的版本关联未知，不因 URL 相同升级置信度。

S3/S4 的精确位置和正式 Excel 尚未实现。不得默认联网或恢复已删除白盒后端。
