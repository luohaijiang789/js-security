# 0.9.2：独立无 map 验证与构建前检查

本轮改善 GitHub → 正式构建 → JS 请求表的可复现性，没有根据新样本调整请求提取规则。插件保持 0.7.1。

## 独立公开项目

[pekkiriscim/weather](https://github.com/pekkiriscim/weather/tree/a562276f077ff8c02f8931495d99888af3182fac)，MIT，固定 Commit `a562276f077ff8c02f8931495d99888af3182fac`，使用项目自带 `vite build`。这是补充验证用的普通 Vite 项目，不宣称引用阿里 JS；阿里项目 GDB/Nacos 继续作为开发回归。

首次分析前人工核对源码与产物 AST，冻结 3 个 fetch 位置、其中 2 个业务位置的 4 种地址/参数形态。预期与 8 个分析核心文件哈希见[原始冻结记录](../baselines/validation/weather-no-map.freeze.json)，文件 SHA256 为 `eb25586fc9bf6d6251ded9471201214430187224c4f3cda05caf544e693c2618`。核心规则与 main `96158b9e27bc8b1beab7ee93b7d597397af5723b` 相同；首次分析前只修改仓库构建编排和原生编译器补装。此项目此前未用于调整规则，首测后再次运行属于回归，不重复计为独立样本。

产物只有 `dist/assets/index-197ba97d.js`，12191 字节，SHA256 `994ef905136f81ae8ab6352d9d470da40ee6771b52316aa66336535f034a93fc`，无 source map。

| 产物位置 | 方法 | Host | URL 路径 | Query 字段名 |
| --- | --- | --- | --- | --- |
| index-197ba97d.js:52:5074 | GET | api.openweathermap.org | /data/2.5/weather | lat, lon, appid, units |
| index-197ba97d.js:52:5074 | GET | api.openweathermap.org | /data/2.5/weather | q, appid, units |
| index-197ba97d.js:52:7758 | GET | api.openweathermap.org | /data/2.5/forecast | lat, lon, appid, units |
| index-197ba97d.js:52:7758 | GET | api.openweathermap.org | /data/2.5/forecast | q, appid, units |

业务预期 4/4 通过。Vite 注入的 modulepreload fetch 位于 1:690，URL 依赖 DOM 的 link.href，Host 保留 null；方法为未知表达式，已在首次分析前排除该项的方法准确率评价。

首测输出 52 行：40 行业务条件/调用上下文候选、12 行资源预加载候选，不能称为 52 个 API。每种业务 URL/Query 形态匹配 10 个候选；没有意外发送位置。分析用 55580 步，`complete=false`；动态参数值、API 密钥、DOM、未支持语义仍未知。未运行目标业务 JS、未提供 API 密钥、未访问提取出的天气 API。这个小样本证明限定的压缩拼接地址和参数恢复，不证明任意框架、运行时 hook、混淆/加密都能完整恢复。

## 原锁文件跨平台缺口

首次真实运行在安装成功后构建失败：原锁文件仅列出 esbuild Windows 原生包，Linux 构建缺少 `@esbuild/linux-x64`。该失败保留为失败，没有切换为源码分析。

新增 profile 的 `nativeDependencies`，目前只接受 npm 项目的固定 esbuild Linux x64/arm64 包。父包必须在原锁中具有相同版本、integrity 和 optionalDependencies 平台声明；若平台包本来已锁定，其版本与 SRI 也必须一致。仅从官方 npm registry 使用 `npm pack --ignore-scripts` 获取精确版本，校验显式 SHA512，再以有界、拒绝链接/穿越/非预期文件的解析器解包。只执行编译器 `--version` 验证；不运行依赖安装脚本。容器中挂载自有只读安装工具，保持现有资源约束。

本例补充 `@esbuild/linux-x64@0.16.17`，SRI 见[固定配置](../profiles/weather-vite.json)，二进制 SHA256 `68c683c17b840f30e19904354415ab497ca7e925b0a5b4402d80d26a58259ff7`。原锁 SHA256 `0c9bc7644641a372ebdecf0da7117bc7de4eb0f523637192d865267ce268d1c1` 保持不变。新增包来自独立的显式 profile 固定，不冒充原锁已经包含它；task.json 单列补充回执和父包 integrity。

真实构建环境 Node v22.23.4、npm 10.9.9、镜像 digest `node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`。

## 复跑与检查

在提取器目录执行：

```bash
# 固定 checkout、检查脚本/锁文件、输出 build-plan.json，然后停止；不启动 Docker
node src/repository-cli.js https://github.com/pekkiriscim/weather --profile profiles/weather-vite.json --inspect-only --work-dir ../work/weather-inspect
# 真正执行锁定安装、受控编译器补装、官方 build、JS 分析和 Excel 导出
node src/repository-cli.js https://github.com/pekkiriscim/weather --profile profiles/weather-vite.json --work-dir ../work/weather-build
# 指向上述任务 checkout，验证冻结产物；只复制指定 JS，不读取源码、map 或依赖
npm run verify:targeted -- --manifest baselines/validation/weather-no-map.json --source-root /path/to/task/checkout --out ../work/weather-verify
```

`--inspect-only` 成功状态为 `inspected`，不生成请求行、分析完成率或 Excel。package.json/锁文件有大小与真实路径限制；build-plan 记录脚本名称、包管理器选择、镜像、产物目录和输入哈希，不读取 .env，不输出构建环境值。缺少平台包只产生提示，不自动获取浮动依赖。未指定 ref 时仍先固定远端 HEAD；目录/工具版本/环境需要按项目配置，未实现任意仓库零配置构建。

通用定向构建基准增加 `urlPath` 和 `queryFields` 精确集合匹配，并核对 known-field 证据；缺失、多出参数、Host/方法错误或意外发送位置均失败。业务形态与资源位置分别标记 role。旧 Webpack/源码基准继续兼容。原始第三方仓库、依赖、产物和报告仅在忽略的 work/，Git 只保留链接、配置、哈希/预期与自写测试。

## 验证与剩余项

自动化覆盖原生包完整性/元数据/头校验/穿越/链接/重复/非预期文件、构建前检查不启动 Docker、输入软链接越界、补装顺序/只读工具/锁文件不变、错误版本拒绝，以及地址/字段集合反例。提取器全量 286 项测试全部通过；插件未改动，沿用上一轮 155 项记录，不重新计数。原 GDB 无 map 基准 3 个发送位置/4 行候选、Nacos 封装基准 1 个位置/4 行候选均通过，意外记录为 0。

真实重复完整构建成功，52 行、55580 步、complete=false，与首测一致；`--inspect-only` 对同一 GitHub 固定版本成功且未调用 Docker。原锁文件哈希不变，产物哈希与冻结值一致。任务与首测/重复报告仅存于 work/，正式交付含 delivery/api_assets.xlsx。

真实页面生命周期全链、运行时参数和通用混淆解密仍未完成；真实模型质量、阿里站点及完整 MV3 现场验收继续保持未勾选，不以本轮验证替代。
