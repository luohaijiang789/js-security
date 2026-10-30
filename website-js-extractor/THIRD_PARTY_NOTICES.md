# 第三方能力

本工程调用独立检出的 [jshound](https://github.com/AmbitSecurity/jshound)，固定版本见 `src/website_js_extractor/engine-lock.json`。其许可证为 MIT，原文保留在上游仓库的 LICENSE/NOTICE；本工程不内嵌改写其源码，不把增强补丁留作不可获取的子模块提交。

jshound 所用 Babel 及其他依赖许可由固定上游提供。首次运行需初始化对应子模块并按上游说明准备 Python/Node 运行环境；实验环境的固定依赖见 `references/blackbox2-experiment/requirements.lock`。将来分发独立制品时应一并携带实际打包依赖的许可证。

公开 Worker 兼容性样本取自 [MDN dom-examples](https://github.com/mdn/dom-examples)，CC0-1.0；固定 Commit、文件哈希与上游 LICENSE 地址见 `tests/worker-manifest.json`。仅清单与检查器进入本工程，原始正文下载到忽略的 work 目录，不执行样本。

插件界面使用 Vue 3.5.22（MIT），版本和传递依赖见 `extension/package-lock.json`；分发插件时保留 `extension/public/THIRD_PARTY_NOTICES.txt` 中的 Vue 许可原文。构建/测试工具仅为开发依赖，未把测试样本或上游 jshound 内嵌到插件。
