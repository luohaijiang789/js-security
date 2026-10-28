# 0.9 基准登记与验证

结果解释与命令见[发布报告](release-0.9.md)。实现清单只勾选限定范围，不把 validationPassed 当 extractionComplete。

## 样本角色

| 样本 | 当前角色 | 冻结/使用规则 |
| --- | --- | --- |
| examples 自写小样例、Webpack4/5真实分块 | development/regression | 已用于设计规则，之后固定哈希/人工预期回归；不能充当独立盲测 |
| GDB/Nacos/OSS 外部11文件切片 | regression | 已参与模型/标注修订；22条条件预期本轮全部匹配。未知仍是必要预期 |
| Ant Design Pro api.ts 固定切片 | validation | 首测前依据源码人工标注实际method/字段/条件；从未据其分析输出调整规则或预期；16/16匹配 |
| GDB无map公开产物、Nacos页面/globalLib | development / failed acceptance | 已用于发现崩溃/模型不足，不再充当独立盲测；实际恢复未通过，登记失败 |
| Vue/Vite、pnpm/Yarn固定工程 | toolchain acceptance | 验证clone/锁文件/构建/映射/交付流程，不提供第三方请求准确率 |

验证切片固定 [manifest](../baselines/validation/ant-pro.json) 与[人工预期](../baselines/validation/ant-pro.expected.json)。commit=42f2cb1d303380909ea04c73b5e60679d09c321a；源SHA256=569a17c55a75e70c1665e40db087e8634e871480fd85c2f42198468d5d0c96fb；预期SHA256=24b0e5c40e47047182705eb332f0d6e659774f3675388a71b241d5e536cbffe2。原始代码只在work。

分母为该文件8个request调用、按 options||{} 两种配置路径展开的16条有限候选；显式 request→axios 客户端映射。代码实际POST优先于错误的PUT/DELETE注释；动态展开仍未知，完整性false。首测与最后版本都通过。本轮标注与实现同时提交，没有提前公开冻结或第三方盲测程序，不能宣称大规模独立准确率。

```bash
# 源文件按manifest固定提交下载/checkout到 source-root 后执行，不执行目标代码
node src/external-baseline-cli.js --manifest baselines/validation/ant-pro.json --source-root /path/to/ant-pro-slice --out ../work/ant-pro-validation.json
```

任何样本一旦用于调规则或参考引擎输出改标注，必须转 regression，保留变更原因、旧预期和哈希，并另选未参与开发的切片。未来版本复用同一验证集只能称固定验证回归，不能反复宣称新盲测。

## 性能基线

命令 `node src/benchmark-cli.js --out ../work/performance.json`。固定生成 direct-fetch-v1，自写100/1000/10000独立文件，已知POST/id字段；maxSteps=1000000、maxCandidates=8，三档均无诊断/完整true。另有预算中断、实参候选超限及后续文件存活的反例测试，不将本表简单分布推广到真实bundle。

环境：Node v24.19.0、Linux6.18.55、x64、3CPU；engine0.9.0，src/*.js规范排序后的名称+内容 SHA256=900e1e5c36f6c35d41360537a4c7a14daa4e67494a8a7f9be60f7d1e80613ce4。基准记录完整输入哈希/配置/环境，报告留work/performance-v09-release.json。

| 文件 | 模式 | analyze耗时ms | 进程峰值RSS KiB | 步数 | 请求 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100 | cold | 135.3 | 157844 | 900 | 100 |
| 100 | warm | 98.0 | 157700 | 900 | 100 |
| 1000 | cold | 547.8 | 201088 | 9000 | 1000 |
| 1000 | warm | 195.2 | 218632 | 9000 | 1000 |
| 10000 | cold | 2605.6 | 442644 | 90000 | 10000 |
| 10000 | warm | 1974.5 | 653528 | 90000 | 10000 |

cold是新进程第一次analyze，未清OS页缓存；warm是独立进程先预热同一输入再测一次。耗时不含进程启动/import；RSS是该进程生命周期峰值，warm包含预热分配，不能当作单轮增量。共享机器负载和GC影响结果，未设置CI性能提升阈值。源码变更需标记新hash，不能沿用本表证明同一版本性能。

## 自动化与现场

提取器255项、插件154项自动化测试；插件包含真实CDP与真实Chromium页面交互，部分扩展API替代，不等于完整MV3验收。提取器的离线仓库任务替代子进程测试与真实Docker构建分别报告；所有新测试默认离线，npm test 不需要下载目标仓库。

真实Node HTTP服务验收覆盖 /jobs 和 /packages → 异步分析 → analysis.json/Excel 下载，验证Origin/令牌/主机范围；脚本快照入口fetch次数=0。三个Sheet经独立ZIP/XML解析器核对，不只验证自己写出的字节头。

当前企业策略禁止加载自定义扩展，test:extension明确失败；阿里云国际/帮助站经代理CONNECT403。上述验收保持未通过，不隐藏、不以替代API测试代替。AI真实语义评估尚未运行，仅接口契约与失败保护通过。

## 0.9.1增量登记

最新修复与实际验收见[0.9.1报告](release-0.9.1.md)。GDB无map样本已用于调规则并转development-regression；新Nacoswrapper也是开发回归，均不当独立盲测。Ant Pro16条在本轮重复匹配，称固定验证回归。

重跑同一direct-fetch-v1性能分布，Node v24.19.0/Linux6.18.55/x64/3CPU；源码hash仍只覆盖src/*.js（排序名称+内容），不等于全依赖/模型目录哈希。当前为ebf54f2cac39668d18d131ee08a4fd9f4ecce11541ce81d8db66422903921d4d。峰值RSS是进程生命周期值；cold不清OS页缓存，warm包含预热分配。不在共享机器上据单次数字宣称提升。

| 文件 | 模式 | analyze ms | 峰值RSS KiB | 步数 | 请求 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100 | cold | 321.3 | 151984 | 900 | 100 |
| 100 | warm | 94.6 | 160368 | 900 | 100 |
| 1000 | cold | 1698.9 | 225880 | 9000 | 1000 |
| 1000 | warm | 522.9 | 218036 | 9000 | 1000 |
| 10000 | cold | 5850.7 | 355760 | 90000 | 10000 |
| 10000 | warm | 2986.1 | 462568 | 90000 | 10000 |

三档均完整且无诊断；这些简单分布不覆盖真实bundle复杂度。原始报告在work/v091-performance-release.json。构建增强另有单JS32MiB、总JS128MiB预算，超过明确失败，不将失败转为空接口成功。
