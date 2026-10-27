# 多框架静态分析验收仓库

此目录是手写的测试源码仓库，不需要运行或安装框架依赖。包含 React、Vue 3/Vue Options API、Svelte、Angular、Next.js、Solid、原生 JS、小程序式客户端和 CommonJS 的常见请求方式。0.2 增加 ofetch/ky、条件 URL/method 配对、静态 for-of 和 Request/URL。

`expected.json` 是人工维护的预期接口列表，测试严格比较接口方法与 URL，额外检测调用链、源码位置、参数、排除规则。`src/services/unused.ts`、普通 Map.get、本地同名 fetch 和 `dist/` 中的假接口用于验证误报。

在提取器根目录运行：

```bash
npm run demo
```

结果输出至 `reports/multi-framework.json`，预期 19 个接口。这是可重复的合成验收，不代表真实开源仓库的覆盖率。
