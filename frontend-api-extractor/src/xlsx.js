// Minimal OOXML writer: stored ZIP entries and inline strings, never formulas.
import { createHash } from "node:crypto";
const xml = (v) =>
  String(v ?? "未知")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  },
  u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  let offset = 0;
  const local = [],
    central = [];
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name),
      d = Buffer.from(text),
      crc = crc32(d);
    const a = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(d.length),
      u32(d.length),
      u16(n.length),
      u16(0),
      n,
      d,
    ]);
    local.push(a);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(d.length),
        u32(d.length),
        u16(n.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        n,
      ]),
    );
    offset += a.length;
  }
  const c = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    c,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(c.length),
    u32(offset),
    u16(0),
  ]);
}
const column = (n) => {
  let result = "";
  for (n++; n; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
};
const protectUrl = (value) =>
  typeof value === "string"
    ? value.replace(/([?&][^=&#]+)=([^&#]*)/g, "$1=[值省略]")
    : value;
export function deliveryWorkbook(document, { maxRows = 1048576 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 2 || maxRows > 1048576)
    throw new Error("工作表行数上限无效");
  const sections = [
    [
      "API总表",
      [
        "记录ID",
        "调用ID",
        "来源",
        "方法",
        "Host",
        "URL（Query值省略）",
        "Path",
        "地址状态",
        "载体状态",
        "源码",
        "产物JS",
        "证据ID",
        "缺口ID",
      ],
      document.records.map((r) => [
        r.id,
        r.callSiteId,
        r.sourceKind,
        r.method,
        r.host,
        protectUrl(r.resolvedUrl ?? r.url),
        r.path,
        r.addressState,
        r.carrierStates ?? r.captureStates,
        [r.sourceFile, r.sourceLine, r.sourceColumn].join(":"),
        [r.generatedFile, r.generatedLine, r.generatedColumn].join(":"),
        r.evidenceId,
        r.gapIds,
      ]),
    ],
    [
      "参数明细",
      [
        "字段ID",
        "记录ID",
        "载体",
        "字段路径",
        "重复项序号",
        "阶段",
        "状态",
        "证据ID",
      ],
      document.parameters.map((f) => [
        f.id,
        f.recordId,
        f.carrier,
        f.path,
        f.entryIndex,
        f.stage,
        f.state,
        f.evidenceId,
      ]),
    ],
    [
      "分析缺口",
      ["缺口ID", "记录ID", "资产ID", "类型", "原因", "影响", "位置"],
      document.gaps.map((g) => [
        g.id,
        g.recordId,
        g.assetId,
        g.code,
        g.reason,
        g.impact,
        g.location,
      ]),
    ],
  ];
  const files = {},
    sheets = [],
    longCells = [];
  let totalBytes = 0;
  for (const [base, header, rows] of sections) {
    const count = Math.max(1, Math.ceil(rows.length / (maxRows - 1)));
    for (let part = 0; part < count; part++) {
      const name = base + (count > 1 ? "-" + (part + 1) : ""),
        data = [
          header,
          ...rows.slice(part * (maxRows - 1), (part + 1) * (maxRows - 1)),
        ];
      const body = data
        .map(
          (row, index) =>
            '<row r="' +
            (index + 1) +
            '">' +
            row
              .map((value, c) => {
                let text =
                  value === null || value === undefined
                    ? "未知"
                    : typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value);
                if (text.length > 32767) {
                  const id =
                    "cell_" +
                    createHash("sha256")
                      .update(text)
                      .digest("hex")
                      .slice(0, 24);
                  longCells.push({
                    id,
                    sheet: name,
                    row: index + 1,
                    column: c + 1,
                    value: text,
                  });
                  text = "长内容见 analysis.json workbookEvidence: " + id;
                }
                return (
                  '<c r="' +
                  column(c) +
                  (index + 1) +
                  '" t="inlineStr"><is><t xml:space="preserve">' +
                  xml(text) +
                  "</t></is></c>"
                );
              })
              .join("") +
            "</row>",
        )
        .join("");
      const number = sheets.length + 1;
      files["xl/worksheets/sheet" + number + ".xml"] =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        body +
        '</sheetData><autoFilter ref="A1:' +
        column(header.length - 1) +
        data.length +
        '"/></worksheet>';
      totalBytes += Buffer.byteLength(body);
      if (totalBytes > 128 * 1024 * 1024)
        throw new Error("工作簿超过128MiB预算");
      sheets.push({ name, number });
    }
  }
  files["[Content_Types].xml"] =
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (s) =>
          '<Override PartName="/xl/worksheets/sheet' +
          s.number +
          '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      )
      .join("") +
    "</Types>";
  files["_rels/.rels"] =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files["xl/workbook.xml"] =
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (s) =>
          '<sheet name="' +
          xml(s.name) +
          '" sheetId="' +
          s.number +
          '" r:id="rId' +
          s.number +
          '"/>',
      )
      .join("") +
    "</sheets></workbook>";
  files["xl/_rels/workbook.xml.rels"] =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (s) =>
          '<Relationship Id="rId' +
          s.number +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
          s.number +
          '.xml"/>',
      )
      .join("") +
    "</Relationships>";
  return { bytes: zip(files), longCells, sheets: sheets.map((s) => s.name) };
}
