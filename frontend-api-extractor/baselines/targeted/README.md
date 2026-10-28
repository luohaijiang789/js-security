# 真实封装与无 map 产物回归

[0.9.1完整结果与边界](../../docs/release-0.9.1.md)。只提交manifest、哈希、手工方法/字段/位置预期；不提交第三方源码或构建产物。

- [nacos-wrapper.json](nacos-wrapper.json)：固定Nacos三份源文件＋独立自写驱动，1发送点/4条件候选；验证真实wrapper，不代表页面生命周期。
- [gdb-no-map.json](gdb-no-map.json)：固定GDB正式构建的四份JS，仅复制JS隔离分析，不读取map/源码/依赖。人工枚举3个POST位置及Body字段，4条件候选。该样本已用于开发，不是独立盲测。

从提取器目录运行：

```bash
npm run verify:targeted -- --manifest baselines/targeted/nacos-wrapper.json --source-root /fixed/nacos --out ../work/nacos-verified
npm run verify:targeted -- --manifest baselines/targeted/gdb-no-map.json --source-root /fixed/gdb-build-checkout --out ../work/gdb-verified
```

哈希不同或输入越界直接失败，不能用任意新构建替换冻结输入。GDB可按[已有构建配置](../../profiles/gdb-console.json)获取并正式构建；若环境导致字节变化，应独立复核位置/字段并另建manifest，不自动更新预期。

验证工具输出通过与否、额外项、原始行、完整性和统一Excel/JSON。预期通过不等于complete=true；相对Host、库契约、未建模hook、函数库存和预算等缺口继续保留。没有执行自写驱动或目标业务代码。
