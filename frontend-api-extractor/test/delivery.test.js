import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { toDelivery, stableId } from "../src/delivery.js";
import { deliveryWorkbook } from "../src/xlsx.js";
import { writeDelivery } from "../src/delivery-cli.js";
import { runLogged } from "../src/repository-task.js";
import { fixture } from "./helpers.js";
const workbookXml=async(t,bytes)=>{const root=await fixture(t,{}),file=path.join(root,'book.xlsx');await fs.writeFile(file,bytes);const r=await runLogged('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(''.join(z.read(n).decode('utf8') for n in z.namelist()))",file]);assert.equal(r.code,0,r.output);return r.output;};
const row = {
  sourceKind: "repository-static",
  repository: "https://github.com/example/repo",
  commit: "a".repeat(40),
  sourceFile: "api.js",
  sourceLine: 2,
  sourceColumn: 1,
  stage: "call-site",
  method: "POST",
  host: "api.test",
  url: "https://api.test/items?token=secret",
  query: null,
  body: { id: 7 },
  headers: null,
  conditions: [],
  callChain: [],
  gaps: ["hook unmodeled"],
  parameterFields: [
    {
      carrier: "body",
      path: ["id"],
      state: "known-field",
      stage: "constructed",
    },
  ],
};
test("稳定ID与Schema兼容：键顺序不影响ID，不同版本/阶段/来源不混并", () => {
  assert.equal(stableId("x", { a: 1, b: 2 }), stableId("x", { b: 2, a: 1 }));
  const a = toDelivery({ rows: [row] });
  const b = toDelivery({ rows: [{ ...row, body: { id: 8 } }] });
  assert.equal(a.records[0].callSiteId, b.records[0].callSiteId);
  assert.notEqual(a.records[0].id, b.records[0].id);
  assert.notEqual(
    a.records[0].id,
    toDelivery({ rows: [{ ...row, stage: "after-request-hooks" }] }).records[0]
      .id,
  );
  assert.throws(() => toDelivery({ schemaVersion: 3, rows: [] }), /Schema/);
});
test("字段/缺口/证据ID可关联，保留原始输入与资产级诊断", () => {
  const input = {
    rows: [row],
    stats: { complete: false },
    diagnostics: [
      { code: "MISSING_MODULE", file: "other.js", message: "missing" },
    ],
  };
  const d = toDelivery(input);
  assert.equal(d.records.length, 1);
  assert.equal(d.parameters[0].recordId, d.records[0].id);
  assert.equal(d.gaps.length, 2);
  assert.equal(d.gaps[1].recordId, null);
  assert.deepEqual(d.evidence[0].raw, row);
  assert.equal(d.scope.complete, false);
});
test("载体无字段/未知/部分结构分别保留，不用Host状态覆盖字段状态", () => {
  const d = toDelivery({
    rows: [
      {
        ...row,
        host: null,
        query: { __unknown: "params" },
        body: { id: 7, __unknown: "spread" },
        headers: null,
      },
    ],
  });
  assert.deepEqual(d.records[0].carrierStates, {
    query: "UNKNOWN",
    body: "PARTIAL",
    headers: "CONFIRMED_ABSENT",
  });
});
test("插件实测重定向/会话和采集状态独立，不能伪装为静态记录", () => {
  const observation = {
    scan_id: "task",
    request_id: "r1",
    session_id: "s1",
    request_url: "https://api.test/a",
    method: "GET",
    redirect_hop: 2,
    query_params: [
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
    ],
    request_headers: [],
    capture_status: { body: "missing" },
  };
  const d = toDelivery({ observations: [observation] });
  assert.equal(d.records[0].sourceKind, "plugin-observed");
  assert.equal(d.records[0].observation.redirectHop, 2);
  assert.equal(d.parameters.length, 2);
  assert.equal(d.parameters[1].entryIndex, 1);
  assert.throws(
    () => toDelivery({ rows: [{ ...row, sourceKind: "plugin-observed" }] }),
    /身份/,
  );
});
test("XLSX三个Sheet、inlineStr无公式，Query值省略，原始值仍在JSON证据", async t => {
  const d = toDelivery({ rows: [{ ...row, host: '=HYPERLINK("x")' }] });
  const w = deliveryWorkbook(d);
  assert.deepEqual(w.sheets, ["API总表", "参数明细", "分析缺口"]);
  assert.equal(w.bytes.readUInt32LE(0), 0x04034b50);
  const text = await workbookXml(t,w.bytes);
  assert.ok(text.includes("inlineStr"));
  for(const header of ["业务调用点","条件","候选API组","Query字段","Body字段","Header字段"])assert.ok(text.includes(header));
  assert.match(text, /r="X2"[^>]*>[\s\S]*?id[\s\S]*?<\/c>/);
  assert.ok(!text.includes("<f>"));
  assert.ok(!text.includes("token=secret"));
  assert.ok(JSON.stringify(d.evidence).includes("secret"));
});
test("Excel超长内容引用完整JSON证据，行数超限分表而非丢弃", async t => {
  const d = toDelivery({
    rows: [row, { ...row, sourceLine: 3 }, { ...row, sourceLine: 4 }],
  });
  d.gaps[0].reason = "x".repeat(40000);
  const w = deliveryWorkbook(d, { maxRows: 3 });
  assert.ok(w.sheets.includes("API总表-2"));
  assert.equal(w.longCells[0].value.length, 40000);
  assert.ok((await workbookXml(t,w.bytes)).includes(w.longCells[0].id));
});
test("生成工作簿可由独立ZIP/XML解析器打开，记录/参数行可追溯", async (t) => {
  const root = await fixture(t, {});
  await writeDelivery({ rows: [row] }, root);
  const r = await runLogged("python3", [
    "-c",
    `import zipfile,xml.etree.ElementTree as E,sys\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\nfor f in z.namelist(): E.fromstring(z.read(f))\nassert len([f for f in z.namelist() if 'worksheets/sheet' in f])==3\n`,
    path.join(root, "api_assets.xlsx"),
  ]);
  assert.equal(r.code, 0, r.output);
  const d = JSON.parse(
    await fs.readFile(path.join(root, "analysis.json"), "utf8"),
  );
  assert.equal(d.schemaVersion, "2.0.0");
});
test("重复记录/字段保留不同ID，URL地址与Method状态独立", () => {
  const r = {
    ...row,
    method: null,
    parameterFields: [
      {
        carrier: "query",
        path: ["tag"],
        state: "known-field",
        stage: "constructed",
      },
      {
        carrier: "query",
        path: ["tag"],
        state: "known-field",
        stage: "constructed",
      },
    ],
  };
  const d = toDelivery({ rows: [r, r] });
  assert.notEqual(d.records[0].id, d.records[1].id);
  assert.notEqual(d.parameters[0].id, d.parameters[1].id);
  assert.equal(d.records[0].addressState, "RESOLVED");
  assert.equal(d.records[0].methodState, "UNKNOWN");
});

test('工作簿保留阶段和未连通入口依据，不把函数库存伪装成实测',async t=>{const d=toDelivery({rows:[{...row,linkState:'function-inventory',stage:'call-site'}]});assert.equal(d.records[0].linkState,'function-inventory');const text=await workbookXml(t,deliveryWorkbook(d).bytes);assert.ok(text.includes('定位依据'));assert.ok(text.includes('函数候选（未连通入口）'));assert.ok(text.includes('call-site'));});
