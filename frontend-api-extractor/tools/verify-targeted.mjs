import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer.js";
import { analyzeBuild } from "../src/build-assets.js";
import { requestRows } from "../src/request-table.js";
import { writeDelivery } from "../src/delivery-cli.js";
const safe = (name) =>
  typeof name === "string" &&
  name &&
  !path.isAbsolute(name) &&
  !name.split(/[\\/]/).some((s) => s === ".." || !s);
const hash = (b) => createHash("sha256").update(b).digest("hex");
try {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "source-root": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.manifest || !values["source-root"] || !values.out)
    throw Error("需要 --manifest --source-root --out");
  const m = JSON.parse(await fs.readFile(values.manifest, "utf8"));
  if (
    m.schemaVersion !== 1 ||
    !["targeted-source-wrapper", "targeted-webpack-artifact", "targeted-build-artifact"].includes(
      m.kind,
    ) ||
    !Array.isArray(m.files) ||
    m.files.length > 100 ||
    !Array.isArray(m.expected) ||
    !m.expected.length
  )
    throw Error("不支持的定向基准");
  const input = await fs.realpath(values["source-root"]),
    root = await fs.mkdtemp(path.join(os.tmpdir(), "api-targeted-"));
  try {
    let bytes = 0;
    const copy = async (base, name, destination, sha) => {
      if (!safe(name) || !safe(destination)) throw Error("基准路径不安全");
      const file = await fs.realpath(path.join(base, name));
      if (!file.startsWith(base + path.sep)) throw Error("基准文件越界");
      const stat = await fs.stat(file);
      bytes += stat.size;
      if (stat.size > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
        throw Error("基准字节超限");
      const data = await fs.readFile(file);
      if (hash(data) !== sha) throw Error("基准文件哈希不匹配: " + name);
      const target = path.join(root, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    };
    for (const f of m.files) await copy(input, f.path, f.path, f.sha256);
    if (m.driver)
      await copy(
        await fs.realpath(fileURLToPath(new URL("../", import.meta.url))),
        m.driver.path,
        m.driver.target,
        m.driver.sha256,
      );
    const out = path.resolve(values.out);
    const built =
        m.kind !== "targeted-source-wrapper"
          ? await analyzeBuild(
              root,
              m.artifactDirs,
              path.join(out, "derived"),
              m.config,
            )
          : null,
      report =
        built?.report ??
        (await analyze(root, {
          ...m.config,
          include: m.files
            .map((f) => f.path)
            .concat(m.driver ? [m.driver.target] : []),
        })),
      rows = requestRows(
        report,
        {
          repository: m.repository,
          commit: m.commit,
          mode: built?.mode ?? "source-static",
        },
        built?.locations,
      );
    const urlShape=(e,row)=>{
      if(!Object.hasOwn(e,'urlPath')&&!Object.hasOwn(e,'queryFields'))return true;
      let url;try{url=new URL(row.url);}catch{return false;}
      if(Object.hasOwn(e,'urlPath')&&url.pathname!==e.urlPath)return false;
      if(e.queryFields){const actual=[...new Set(url.searchParams.keys())].sort(),expected=[...new Set(e.queryFields)].sort();if(JSON.stringify(actual)!==JSON.stringify(expected))return false;
        if(!expected.every(name=>row.parameterFields.some(f=>f.carrier==='query'&&f.path.join('.')===name&&f.state==='known-field')))return false;}
      return true;
    };
    const check = (e, row) => urlShape(e,row) &&
      [
        "sourceFile",
        "sourceLine",
        "sourceColumn",
        "generatedFile",
        "generatedLine",
        "generatedColumn",
        "method",
        "url",
        "host",
      ].every((key) => !Object.hasOwn(e, key) || e[key] === row[key]) &&
      Object.entries(e.fields ?? {}).every(([carrier, names]) =>
        names.every((name) =>
          row.parameterFields.some(
            (f) =>
              f.carrier === carrier &&
              f.path.join(".") === name &&
              f.state === "known-field",
          ),
        ),
      ) &&
      (!e.gapContains || row.gaps.some((g) => g.includes(e.gapContains)));
    const checks = m.expected.map((e, index) => ({
        index,
        role:e.role??'request',
        matches:rows.filter(row=>check(e,row)).length,
        passed: rows.some((row) => check(e, row)),
      })),
      unexpected = rows.filter((row) => !m.expected.some((e) => check(e, row)));
    const validationPassed =
      checks.every((c) => c.passed) && !unexpected.length;
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, "verification.json"),
      JSON.stringify(
        {
          repository: m.repository,
          commit: m.commit,
          kind: m.kind,
          datasetRole: m.datasetRole,
          validationPassed,
          checks,
          unexpected,
          rows,
          stats: report.stats,
          assets: built?.assets ?? report.assets,
          buildGaps: built?.gaps ?? [],
        },
        null,
        2,
      ) + "\n",
    );
    await writeDelivery(
      {
        ...report,
        rows,
        repository: m.repository,
        commit: m.commit,
        mode: built?.mode ?? "source-static",
        buildGaps: built?.gaps ?? [],
      },
      out,
    );
    console.log(
      JSON.stringify({
        validationPassed,
        expected: checks.length,
        matched: checks.filter((c) => c.passed).length,
        unexpected: unexpected.length,
        rows: rows.length,
        steps: report.stats.steps,
        complete: report.stats.complete,
        out,
      }),
    );
    if (!validationPassed) process.exitCode = 1;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
} catch (error) {
  console.error("定向验证失败: " + error.message);
  process.exitCode = 2;
}
