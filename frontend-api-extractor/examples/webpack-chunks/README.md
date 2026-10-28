# 自写正式 Webpack 分块基准

仅三份自写源码及小型压缩产物，无第三方应用代码或 source map。Webpack 4.47.0 / 5.99.9；production、runtimeChunk=single、concatenateModules=false、publicPath=/static/；具体输入/产物哈希与人工预期见 [manifest.json](manifest.json)。index → service → lookup 和动态 import(deep) → query 应分别保留 POST、完整 Host、URL、account.id=7 / id=9；模块库存分析也会保留未知实参候选，不将它们合并成运行时事实。

工具依赖安装到主仓库忽略目录，**不要安装进提取器依赖**：

```bash
# 从主仓库根目录执行；旧工具链可能需要 --openssl-legacy-provider
mkdir -p work/webpack-repro-tools
npm install --prefix work/webpack-repro-tools --ignore-scripts webpack4@npm:webpack@4.47.0 webpack5@npm:webpack@5.99.9
NODE_OPTIONS=--openssl-legacy-provider node frontend-api-extractor/tools/build-webpack-fixture.cjs "$PWD/work/webpack-repro-tools/node_modules" "$PWD/work/webpack-repro"
node --test frontend-api-extractor/test/webpack.test.js
```

工具链所用 Terser 等传递依赖会影响字节哈希；重新构建用于核对请求语义，不自动覆写已冻结产物或标注。正式测试同时核对冻结哈希与原始 fetch 行列位置。未知 runtime、缺 chunk、导出不支持和预算必须保留缺口。这不是通用反混淆或浏览器生命周期模拟器。
