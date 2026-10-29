# 第三方能力

本工程调用独立检出的 [jshound](https://github.com/AmbitSecurity/jshound)，固定版本见 `src/site_js_analyzer/engine-lock.json`。其许可证为 MIT，原文保留在上游仓库的 LICENSE/NOTICE；本工程不内嵌改写其源码，不把增强补丁留作不可获取的子模块提交。

jshound 所用 Babel 及其他依赖许可由固定上游提供。首次运行需初始化对应子模块并按上游说明准备 Python/Node 运行环境；实验环境的固定依赖见 `references/blackbox2-experiment/requirements.lock`。将来分发独立制品时应一并携带实际打包依赖的许可证。
