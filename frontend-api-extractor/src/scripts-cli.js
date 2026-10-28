#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { collectScripts, analyzeScriptPackage } from "./script-assets.js";
import { importObservedScripts } from "./observed-scripts.js";
import { writeDelivery } from "./delivery-cli.js";
try {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      out: { type: "string" },
      "import-package": { type: "string" },
      "browser-snapshot": { type: "string" },
      "allow-host": { type: "string", multiple: true },
      mode: { type: "string", default: "website" },
      depth: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "用法: node src/scripts-cli.js --url https://site/page --out work/task [--allow-host cdn.example] [--mode website|build --depth 3]；或 --import-package directory --out task",
    );
  else {
    if (
      !values.out ||
      (!values.url && !values["import-package"] && !values["browser-snapshot"])
    )
      throw new Error("需要 --out 和 --url 或 --import-package");
    const output = path.resolve(values.out),
      directory = values["import-package"]
        ? path.resolve(values["import-package"])
        : output;
    const manifest = values["browser-snapshot"]
      ? await importObservedScripts(
          JSON.parse(await fs.readFile(values["browser-snapshot"], "utf8")),
          output,
        )
      : values["import-package"]
        ? JSON.parse(
            await fs.readFile(
              path.join(directory, "assets-manifest.json"),
              "utf8",
            ),
          )
        : await collectScripts(values.url, output, {
            mode: values.mode,
            ...(values.depth !== undefined
              ? { maxDepth: Number(values.depth) }
              : {}),
            ...(values["allow-host"]
              ? {
                  allowedHosts: [
                    new URL(values.url).hostname,
                    ...values["allow-host"],
                  ],
                }
              : {}),
          });
    const report = await analyzeScriptPackage(directory, manifest);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "raw-analysis.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    const document = await writeDelivery(report, output, {
      mode: "website-js-static",
    });
    console.log(
      JSON.stringify({
        assets: manifest.assets.length,
        edges: manifest.edges.length,
        records: document.records.length,
        complete: document.scope.complete,
        out: output,
      }),
    );
  }
} catch (error) {
  console.error("JS探索失败: " + error.message);
  process.exitCode = 1;
}
