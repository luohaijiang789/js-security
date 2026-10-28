#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { toDelivery } from "./delivery.js";
import { annotateFields, compatibleProvider } from "./field-ai.js";
import { writeDelivery } from "./delivery-cli.js";
try {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      enabled: { type: "boolean" },
      endpoint: { type: "string" },
      model: { type: "string" },
      "key-env": { type: "string", default: "FRONTEND_AI_API_KEY" },
      "max-fields": { type: "string", default: "100" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "用法: node src/ai-cli.js --input analysis.json --out directory [--enabled --endpoint https://provider/v1/chat/completions --model model --key-env FRONTEND_AI_API_KEY]",
    );
  else {
    if (!values.input || !values.out) throw new Error("需要 --input 和 --out");
    const input = toDelivery(
      JSON.parse(await fs.readFile(values.input, "utf8")),
    );
    const provider = values.enabled
      ? compatibleProvider({
          endpoint: values.endpoint,
          apiKey: process.env[values["key-env"]],
        })
      : undefined;
    const result = await annotateFields(input, {
      enabled: values.enabled ?? false,
      model: values.model,
      provider,
      maxFields: Number(values["max-fields"]),
    });
    await writeDelivery(result, path.resolve(values.out));
    console.log(JSON.stringify(result.aiRun));
  }
} catch (error) {
  console.error("AI释义失败: " + error.message);
  process.exitCode = 1;
}
