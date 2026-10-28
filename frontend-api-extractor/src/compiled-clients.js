import ts from "typescript";
import fs from "node:fs";
import { createHash } from "node:crypto";
export const compiledClientModels = JSON.parse(
  fs.readFileSync(
    new URL("../models/compiled-clients.json", import.meta.url),
    "utf8",
  ),
).models;
// A narrowly matched facade contract, never a fuzzy URL/name/keyword classifier.
export function compiledClientFingerprint(text) {
  let sf = ts.createSourceFile(
    "module.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  // A synthetic export{} isolates virtual modules in the analyzer. Remove it
  // before binding fingerprint symbols so source and isolated forms normalize identically.
  const boundaries = sf.statements.filter(
    (n) =>
      ts.isExportDeclaration(n) &&
      !n.moduleSpecifier &&
      n.exportClause &&
      ts.isNamedExports(n.exportClause) &&
      !n.exportClause.elements.length,
  );
  for (const boundary of boundaries.reverse())
    text =
      text.slice(0, boundary.getStart(sf)) +
      " ".repeat(boundary.end - boundary.getStart(sf)) +
      text.slice(boundary.end);
  sf = ts.createSourceFile(
    "module.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const host = {
    getSourceFile: (n) => (n === sf.fileName ? sf : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (n) => n === sf.fileName,
    readFile: (n) => (n === sf.fileName ? text : undefined),
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
      [sf.fileName],
      { allowJs: true, noLib: true, noResolve: true },
      host,
    ),
    checker = program.getTypeChecker(),
    symbols = new Map(),
    deps = new Map(),
    tokens = [];
  const local = (s) =>
    s?.declarations?.some(
      (d) =>
        ts.isVariableDeclaration(d) ||
        ts.isParameter(d) ||
        ts.isFunctionDeclaration(d) ||
        ts.isBindingElement(d),
    );
  const visit = (n) => {
    if (
      ts.isExportDeclaration(n) &&
      !n.moduleSpecifier &&
      n.exportClause &&
      ts.isNamedExports(n.exportClause) &&
      !n.exportClause.elements.length
    )
      return;
    tokens.push(n.kind);
    if (ts.isIdentifier(n)) {
      const s = checker.getSymbolAtLocation(n),
        property =
          (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) ||
          (ts.isPropertyAssignment(n.parent) && n.parent.name === n);
      if (!property && local(s)) {
        if (!symbols.has(s)) symbols.set(s, symbols.size);
        tokens.push("binding:" + symbols.get(s));
        if (ts.isShorthandPropertyAssignment(n.parent))
          tokens.push("key:" + n.text);
      } else tokens.push(n.text);
    } else if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) {
      const p = n.parent,
        isDependency =
          ts.isCallExpression(p) &&
          p.arguments[0] === n &&
          ts.isIdentifier(p.expression) &&
          p.expression.text === "require" &&
          !checker.getSymbolAtLocation(p.expression)?.declarations?.length &&
          /^\.\/module-[0-9a-f]+\.js$/.test(n.text);
      if (isDependency) {
        if (!deps.has(n.text)) deps.set(n.text, deps.size);
        tokens.push("dependency:" + deps.get(n.text));
      } else tokens.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}
