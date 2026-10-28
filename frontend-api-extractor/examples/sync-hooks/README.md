# 同步 request hook 样例

自写单文件样例，manifest 固定源码/预期/配置哈希；expected.json 是人工预期。覆盖 Axios 请求 hook 逆序执行、eject、地址/字段改写及 JSON 快照。

在提取器目录运行：

```bash
node src/cli.js examples/sync-hooks
node --test test/request-hooks.test.js
```

CLI 扫描不安装或执行 axios。独立参考使用固定 Axios 1.7.9 和本地 adapter，transformRequest 禁用，执行的只是本样例，adapter 不发送网络请求。对照 expected.json 的方法、地址、指定 Header 和 Body，不把 Axios 默认 Header 或后续传输行为算作已建模。
