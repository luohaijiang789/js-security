# JS 请求采集浏览器插件

独立的 Chrome Manifest V3 工程。点击工具栏图标直接打开管理标签页，选择授权页面采集请求，并在详情侧栏查看参数、请求头、正文、调用栈、质量状态和原始记录。完整功能与限制见[插件开发与安装](../docs/插件开发与安装.md)，需求见[插件规格](../docs/JS%20请求采集浏览器插件.md)。

## 构建与安装

需要 Node.js `20.19+` 或 `22.12+`。从 `js-security` 仓库根目录执行：

```bash
cd browser-extension
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”，选择 **`js-security/browser-extension/dist/`**。更新代码后重新构建，并在扩展管理页点击重新加载。

**此前从根目录 `dist/` 安装的用户：** 加载路径改变可能改变 Chrome 扩展 ID，旧 IndexedDB 不会自动迁移。需要保留旧任务时，可先导出，再将新 `browser-extension/dist/` 内容覆盖到原已加载的 `dist/` 路径并重新加载旧扩展；也可先用旧扩展导出，再从新目录独立安装。确认备份前保留旧扩展，不要卸载。详见[升级说明与交互改进](../docs/插件界面与交互改进.md)。

[.npmrc](.npmrc) 在插件目录内固定公开依赖源并保留锁文件下载地址，不修改全局 npm 配置。如果此前内部镜像返回 `rollup-*.tgz` 的 E404，在本目录重新执行 `npm ci && npm run build`；`vue-tsc` 缺失是安装中断的后续错误，不需全局安装或删除锁文件。

## 使用

1. 点击工具栏图标打开请求工作台，点击“新建采集任务”。
2. 勾选授权测试标签页，检查 Filter、归并及归档策略，开始采集。
3. 切回业务页面操作，再返回工作台点击任意请求。详情侧栏可切换概览、参数、请求头、请求体、调用栈和原始数据；“在途”视图可查看长连接已取得的字段，完成后更新详情。
4. 暂停、恢复或停止任务；停止并写盘后，从右上角导出 JSONL 任务包、CSV 或分片目录。

关闭管理标签页不主动停止后台采集。敏感字段按策略保护，缺失与截断分别标记；原始观察与请求组分别保留。

## 测试

从仓库根目录执行：

```bash
cd browser-extension
npm test
npm run test:browser
npm run test:extension
```

前两项包含核心、转存、真实 CDP 和页面交互测试；页面测试可替代扩展 API，不等于完整 MV3 现场验收。`test:extension` 真正加载扩展，需要浏览器策略允许安装自定义扩展。Linux 浏览器默认 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定已安装的浏览器。

目录中的 `src/`、`tests/`、依赖锁文件与构建配置均属于本插件；其他方案的实现不要放在此目录。运行时第三方许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
