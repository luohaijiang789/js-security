#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { readDeliveryInput } from "./plugin-import.js";
import { toDelivery } from "./delivery.js";
import { deliveryWorkbook } from "./xlsx.js";
export async function writeDelivery(input, directory, metadata = {}) {
  const document = toDelivery(input, metadata),
    workbook = deliveryWorkbook(document);
  document.workbookEvidence = workbook.longCells;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "analysis.json"),
    JSON.stringify(document, null, 2) + "\n",
  );
  await fs.writeFile(path.join(directory, "api_assets.xlsx"), workbook.bytes);
  return document;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  try {
    const { values } = parseArgs({
      options: {
        input: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      console.log(
        "用法: node src/delivery-cli.js --input report.json --out output-directory",
      );
    else {
      if (!values.input || !values.out)
        throw new Error("需要 --input 和 --out");
      const r = await writeDelivery(
        await readDeliveryInput(values.input),
        path.resolve(values.out),
      );
      console.log(
        JSON.stringify({
          schemaVersion: r.schemaVersion,
          records: r.records.length,
          fields: r.parameters.length,
          gaps: r.gaps.length,
          out: path.resolve(values.out),
        }),
      );
    }
  } catch (error) {
    console.error("交付失败: " + error.message);
    process.exitCode = 1;
  }
