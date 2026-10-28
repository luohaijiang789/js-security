#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { createAnalyzerServer } from "./analyzer-server.js";
try {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      "token-env": { type: "string", default: "FRONTEND_ANALYZER_TOKEN" },
      "allow-host": { type: "string", multiple: true },
      port: { type: "string", default: "8765" },
      "work-dir": { type: "string", default: "work/server-jobs" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "用法: node src/server-cli.js --origin chrome-extension://扩展ID --allow-host site.example [--allow-host cdn.example] [--token-env FRONTEND_ANALYZER_TOKEN --port 8765 --work-dir work/server-jobs]",
    );
  else {
    const port = Number(values.port);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
      throw new Error("端口范围1024..65535");
    const server = createAnalyzerServer({
      origin: values.origin,
      token: process.env[values["token-env"]],
      allowedHosts: values["allow-host"],
      workDir: path.resolve(values["work-dir"]),
    });
    server.listen(port, "127.0.0.1", () =>
      console.log(
        JSON.stringify({
          service: "frontend-js-analyzer",
          address: "http://127.0.0.1:" + port,
          origin: values.origin,
          allowedHosts: values["allow-host"],
          token: "从指定环境变量读取，不输出",
        }),
      ),
    );
  }
} catch (error) {
  console.error("分析服务启动失败: " + error.message);
  process.exitCode = 1;
}
