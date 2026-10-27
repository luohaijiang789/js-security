# 对象改写回归样例

3 个自写源码文件，不含第三方业务仓库或依赖。manifest.json 固定输入/预期的 SHA-256 和配置；expected.json 为人工预期。

在提取器目录运行 `node --test test/object-effects.test.js`。使用 CLI 时以 {"entries":["entry.js"]} 为配置，通过 --config 传入，不安装或运行 axios。

参考执行：用 esbuild 0.25.0 将 entry.js bundle 为 CJS，标记 axios external，产物放忽略目录 work/；在 Node vm 中执行该自写产物，require('axios') 返回仅保存 JSON 配置快照的函数，其余 require 拒绝。对照 expected.json 的两次 body、方法、URL 和 Header。没有网络 transport，不执行目标仓库。

预期 POST https://api.example.test/v1/items，X-App=audit，body.account.id 先 8 后 9。只验证调用配置，不是实际网络或 hook 验证。
