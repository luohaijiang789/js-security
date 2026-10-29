# 使用指南（0.10）

所有命令从 frontend-api-extractor 目录执行，需要 Node 22+。源码扫描不执行目标仓库代码或安装其依赖。先安装工具自身依赖：

```bash
npm ci
node src/cli.js --help
```

## 大仓优先：共享索引发现，再定向精查

先在主仓库根目录初始化已有的固定 jshound 子模块：

```bash
git submodule update --init --depth 1 references/repos/jshound
```

回到 frontend-api-extractor 目录运行：

```bash
node src/cli.js /path/to/frontend --engine hybrid --config /path/to/source-config.json --out ../work/hybrid/report.json
```

--engine默认semantic，保留原有逐入口语义模式；hybrid先索引全输入，再自动选中请求候选/显式请求配置所在文件精查；jshound只输出外部库存。无需手工猜API目录，也无需执行目标JS或API。依赖缺失/版本哈希不匹配会失败，不悄悄回退。我们的clients协议与maxSteps/maxDepth用于语义阶段，外部引擎另有输入、内存和时限约束。

外部未核验结果保持partial，缺行列时保留null；原始记录与快照保存在 *.engines/，随报告保留以便回查。coverage finished只说明索引/选中任务结束，complete仍反映模型缺口。详情与同输入实测见[0.10报告](release-0.10.md)，开源代码依据见[核对记录](open-source-analysis.md)。现阶段此选项属于源码CLI，构建CLI和插件UI未新增引擎切换入口。

## 从源码一键生成请求表

```bash
node src/cli.js /path/to/frontend --config /path/to/scan.config.json --out ../work/source/report.json
```

默认同时生成 `report.json.delivery/analysis.json` 和 `report.json.delivery/api_assets.xlsx`。`--delivery-dir ../work/delivery` 可指定交付目录；`--no-delivery` 仅写原始报告。没有 --out 时 stdout 保持 JSON/Markdown，需显式 --delivery-dir 才写 Excel。

stderr 输出开始消息和最终 JSON 摘要，包含候选数、未解析发送位置数、步数、覆盖状态和交付目录。退出码：0=扫描结束且存在有地址片段的候选；1=启动/输入/执行错误；2=没有此类候选；3=至少一个分区超预算、未扫描或没有匹配入口。模型诊断不等于预算中断；读取 summary/coverage 和报告缺口。`--allow-empty`、`--allow-incomplete` 可分别接受相应状态，默认不启用。

## 先限定业务范围，再扩大扫描

```json
{
  "scanFiles": ["src/api/**", "src/services/**"],
  "aliases": {"@/*": ["src/*"]},
  "functionInventory": true,
  "maxSteps": 1000000,
  "partitionStrategy": "fair"
}
```

scanFiles 限定入口分区，依赖仍按 include/exclude 加载用于解析。它不等同于将 include 限成这几个文件；后者可能使依赖不可分析。include/exclude 原已支持，用于解析资产范围。scanFiles 与 entries 同时设置时取交集。

functionInventory 默认 true：entries 模式也补扫当前入口文件未追踪的函数定义，结果标为 function-inventory。只希望实际静态入口调用链时设置 `functionInventory:false` 并给 entries；未知外部回调中的候选仍标为未连通，不能当作已发生的请求。API 目录库存不等于页面生命周期验收。

默认全局预算仍为 100000，未实现自动保证任意整仓完成。maxStepsPerFile 是附加上限，fair 模式还受剩余预算均分限制。需先给某文件完整配额时可使用 `partitionStrategy:"sequential"`，此时上限为 min(maxStepsPerFile, 剩余全局预算)，可能使后续文件额度不足；所有未完成分区照实输出。不能把提高上限当作消除重复计算。

## 适配外部请求封装

```json
{
  "scanFiles": ["src/api/**"],
  "aliases": {"@/*": ["src/*"]},
  "clients": [
    {"module":"@company/http","export":"fetchData","kind":"axios","methodField":"type"}
  ],
  "maxSteps": 1000000
}
```

规则按模块和导出名匹配，支持命名导入别名、受限显式命名重导出与 namespace 导入；本地同名函数不套规则。methodField=type 只用于该明确封装，标准 Axios 不会将非标准 type 自动当 method。旧 name 配置仍可用。规则表示用户声明的调用处协议，不证明外部库已展开或最终传输行为；复杂 SDK/运行时改写仍可能未知。

已加 lodash/lodash-es 的明确 cloneDeep 导入子集，保留对象克隆独立性；同名本地函数走实际解析，未知克隆库不猜。

## 公开仓库复跑

测试目标：[RuoYi-Vue3 固定版本](https://github.com/yangzongzhuan/RuoYi-Vue3/tree/838965c5a18d2c61b73ec30c6e288057aaa08b63)。第三方 checkout 放到仓库根 work/，只需源码，无须构建或目标 node_modules：

```bash
git clone --depth 1 --no-checkout https://github.com/yangzongzhuan/RuoYi-Vue3.git ../work/ruoyi
git -C ../work/ruoyi fetch --depth 1 origin 838965c5a18d2c61b73ec30c6e288057aaa08b63
git -C ../work/ruoyi checkout --detach 838965c5a18d2c61b73ec30c6e288057aaa08b63
node src/cli.js ../work/ruoyi --config profiles/ruoyi-source.json --out ../work/ruoyi-result/report.json
npm run verify:targeted -- --manifest baselines/public/ruoyi.json --source-root ../work/ruoyi --out ../work/ruoyi-verified
```

指定配置的库存实测：19 个 API 文件分区，2745 步，127 条候选，0 个超预算分区。15 个冻结检查点包括 7 个 POST；这 15 个位置/方法/原始 URL 通过，不代表 127 条全部经人工验收。Host 依赖运行时环境，保留未知；未使用网站域名或开发 proxy 补造 Host。完整问题台账、原版对照和局限见[0.9.4报告](release-0.9.4.md)。

## 读表与归组

API总表增加业务调用点、候选API组、条件、仓库/Commit、发送机制、原始请求URL及Query/Body/Header已知字段名称摘要。源码列仍是实际发送点；业务调用点取调用链中发送文件之外最近的调用位置，缺失时回用发送点；它不是完整页面链证明。

调用ID按物理发送点和业务位置等稳定上下文计算，不含条件、参数值、entry 枚举或阶段。条件/阶段仍保留在独立记录中。同一调用点的相同原因缺口共享 ID，并用 recordIds 关联全部记录。新增 `migration.identityVersion=call-site-v2`，旧版调用ID需重新生成，不能跨版本直接比较。原始证据与条件候选仍保留，尚未解决所有记录膨胀或分片合并问题。
