#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runLogged } from "./repository-task.js";
try {
  const { values } = parseArgs({
    options: {
      sizes: { type: "string", default: "100,1000,10000" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "用法: node src/benchmark-cli.js [--sizes 100,1000,10000] --out report.json",
    );
  else {
    const sizes = values.sizes.split(",").map(Number);
    if (
      !sizes.length ||
      sizes.length > 5 ||
      sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000)
    )
      throw new Error("sizes必须为1..10000，最多5组");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "api-perf-"));
    try {
      const samples = [];
      for (const count of sizes) {
        const dir = path.join(root, String(count));
        await fs.mkdir(dir);
        const inputHash = createHash("sha256");
        for (let i = 0; i < count; i++) {
          const name = `api-${String(i).padStart(5, "0")}.js`,
            code = `fetch('https://api.example.test/items/${i}',{method:'POST',body:{id:${i}}});\n`;
          inputHash.update(name + "\0" + code);
          await fs.writeFile(path.join(dir, name), code);
        }
        const sha256 = inputHash.digest("hex");
        for (const mode of ["cold", "warm"]) {
          const r = await runLogged(
            process.execPath,
            [
              "--max-old-space-size=3072",
              fileURLToPath(new URL("./benchmark-worker.js", import.meta.url)),
              dir,
              mode,
              "1000000",
            ],
            { timeoutMs: 180000, maxBytes: 1024 * 1024 },
          );
          if (r.code !== 0 || r.reason)
            throw new Error("性能子进程失败: " + (r.reason ?? r.output));
          const result = JSON.parse(r.output);
          if (
            result.endpoints !== count ||
            !result.complete ||
            result.steps > 1000000
          )
            throw new Error("性能基准结果/预算异常");
          samples.push({ inputSha256: sha256, count, ...result });
        }
      }
      const sourceHash = createHash("sha256");
      for (const name of (
        await fs.readdir(fileURLToPath(new URL(".", import.meta.url)))
      )
        .filter((n) => n.endsWith(".js"))
        .sort())
        sourceHash.update(
          name +
            "\0" +
            (await fs.readFile(fileURLToPath(new URL(name, import.meta.url)))),
        );
      const pkg = JSON.parse(
        await fs.readFile(
          fileURLToPath(new URL("../package.json", import.meta.url)),
        ),
      );
      const document = {
        schemaVersion: 1,
        engineVersion: pkg.version,
        engineSourceSha256: sourceHash.digest("hex"),
        generatorVersion: "direct-fetch-v1",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        cpuCount: os.cpus().length,
        notes: [
          "cold=新进程首次分析，不承诺操作系统页缓存已清空",
          "warm=同进程预热一次后再测；RSS是进程生命周期峰值，不是单轮增量",
          "时间仅包含analyze调用，独立进程Node启动/import不计入",
          "初始基线，不预设性能提升或CI阈值",
        ],
        samples,
      };
      if (values.out) {
        await fs.mkdir(path.dirname(path.resolve(values.out)), {
          recursive: true,
        });
        await fs.writeFile(
          values.out,
          JSON.stringify(document, null, 2) + "\n",
        );
      }
      console.log(JSON.stringify(document, null, 2));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error("性能基准失败: " + error.message);
  process.exitCode = 1;
}
