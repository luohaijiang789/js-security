# 小型异步分块样例

自写源码，不含第三方站点代码。src 有 5 个文件；built 为 esbuild 0.25.0 实际生成的 3 个压缩 ESM 文件，共 335 字节。两个入口分别使用 await import 和 then 解构，参数为 7/9，地址使用保留域名 api.example.test，不是线上业务接口。

在仓库根目录重新生成（本次工具仅安装在 work 缓存，测试本身不依赖 esbuild）：

```bash
npm exec --yes --package esbuild@0.25.0 -- esbuild frontend-api-extractor/examples/async-chunks/src/await-entry.js frontend-api-extractor/examples/async-chunks/src/then-entry.js --bundle --splitting --format=esm --platform=browser --target=es2020 --minify --outdir=frontend-api-extractor/examples/async-chunks/built
```

提取器测试同时检查深层目标 JS、引用位置、Host、URL、参数和两个独立调用上下文。预期为 POST https://api.example.test/v2/users/lookup；Body 的 account.id 分别为 7 和 9。这是 ESM 分块与压缩测试，不是国际站实测、Webpack runtime 或任意混淆验收。
