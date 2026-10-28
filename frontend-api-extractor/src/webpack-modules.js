import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import {
  compiledClientFingerprint,
  compiledClientModels,
} from "./compiled-clients.js";
const printer = ts.createPrinter({ removeComments: true });
const walk = (n, f) => {
  f(n);
  ts.forEachChild(n, (c) => walk(c, f));
};
const literalId = (n) =>
  n && (ts.isNumericLiteral(n) || ts.isStringLiteralLike(n))
    ? String(n.text)
    : null;
const position = (sf, n) => {
  const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
  return { line: p.line + 1, column: p.character + 1 };
};
const fingerprint = (sf, n) =>
  printer.printNode(ts.EmitHint.Unspecified, n, sf).replace(/\s+/g, " ");
export async function unpackWebpack(
  checkout,
  assets,
  output,
  clientContracts = compiledClientModels,
) {
  const root = path.join(output, "webpack-modules");
  await fs.mkdir(root, { recursive: true });
  const definitions = new Map(),
    chunks = [],
    gaps = [],
    files = [],
    native = [];
  let recognized = false,
    derivedBytes = 0;
  for (const asset of assets) {
    const text = await fs.readFile(path.join(checkout, asset.file), "utf8");
    if (
      !/webpackChunk|webpackJsonp|__webpack_modules__|__webpack_require__/.test(
        text,
      )
    ) {
      native.push({ asset, text });
      continue;
    }
    recognized = true;
    const sf = ts.createSourceFile(
      asset.file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const host = {
      getSourceFile: (n) => (n === asset.file ? sf : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (n) => n === asset.file,
      readFile: (n) => (n === asset.file ? text : undefined),
      getCanonicalFileName: (n) => n,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    };
    const program = ts.createProgram(
        [asset.file],
        { allowJs: true, noLib: true, noResolve: true },
        host,
      ),
      checker = program.getTypeChecker();
    const tables = new Set();
    walk(sf, (n) => {
      // A library can embed its own webpack bootstrap inside an outer factory.
      // Its numeric IDs belong to a different runtime and must not overwrite the outer table.
      for (let parent = n.parent; parent; parent = parent.parent)
        if (tables.has(parent)) return;
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "push" &&
        /webpackJsonp|webpackChunk/.test(n.expression.expression.getText(sf)) &&
        ts.isArrayLiteralExpression(n.arguments[0])
      ) {
        const [ids, table] = n.arguments[0].elements;
        if (
          table &&
          (ts.isObjectLiteralExpression(table) ||
            ts.isArrayLiteralExpression(table))
        ) {
          tables.add(table);
          chunks.push({
            asset: asset.file,
            chunkIds: ts.isArrayLiteralExpression(ids)
              ? ids.elements.map(literalId).filter((v) => v !== null)
              : [],
            ...position(sf, n),
          });
        }
      }
      if (
        ts.isVariableDeclaration(n) &&
        n.name.getText(sf) === "__webpack_modules__" &&
        ts.isObjectLiteralExpression(n.initializer ?? {})
      ) {
        const props = n.initializer.properties;
        if (
          props.length &&
          props.every(
            (p) =>
              ts.isPropertyAssignment(p) &&
              literalId(p.name) !== null &&
              (ts.isArrowFunction(p.initializer) ||
                ts.isFunctionExpression(p.initializer)),
          )
        )
          tables.add(n.initializer);
      }
      // Only a bootstrap which actually invokes its module-array parameter.
      // Arbitrary callback arrays inside vendor modules must not become tables.
      if (ts.isCallExpression(n)) {
        let bootstrap = n.expression;
        while (ts.isParenthesizedExpression(bootstrap))
          bootstrap = bootstrap.expression;
        if (ts.isFunctionExpression(bootstrap) || ts.isArrowFunction(bootstrap))
          for (const [index, a] of n.arguments.entries()) {
            if (
              !ts.isArrayLiteralExpression(a) ||
              !a.elements.length ||
              !a.elements.every(
                (e) =>
                  e.kind === ts.SyntaxKind.OmittedExpression ||
                  ts.isFunctionExpression(e) ||
                  ts.isArrowFunction(e),
              )
            )
              continue;
            const parameter = bootstrap.parameters[index];
            if (!parameter || !ts.isIdentifier(parameter.name)) continue;
            const symbol = checker.getSymbolAtLocation(parameter.name);
            let invokes = false;
            walk(bootstrap.body, (call) => {
              if (
                ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                call.expression.name.text === "call" &&
                ts.isElementAccessExpression(call.expression.expression) &&
                checker.getSymbolAtLocation(
                  call.expression.expression.expression,
                ) === symbol
              )
                invokes = true;
            });
            if (invokes) tables.add(a);
          }
      }
    });
    for (const table of tables) {
      const items = ts.isArrayLiteralExpression(table)
        ? table.elements.map((factory, i) => ({ id: String(i), factory }))
        : table.properties
            .filter(ts.isPropertyAssignment)
            .map((p) => ({ id: literalId(p.name), factory: p.initializer }));
      for (const { id, factory } of items) {
        if (id === null || !factory.body || !ts.isBlock(factory.body)) continue;
        const signature = fingerprint(sf, factory.body);
        if (definitions.has(id)) {
          if (definitions.get(id).signature !== signature) {
            definitions.get(id).conflict = true;
            gaps.push("Webpack module ID conflict: " + id);
          }
          continue;
        }
        definitions.set(id, {
          id,
          factory,
          sf,
          checker,
          asset: asset.file,
          signature,
        });
      }
    }
  }
  if (!recognized) return null;
  const moduleName = (id) =>
    "module-" + Buffer.from(id).toString("hex") + ".js";
  const locations = new Map(),
    moduleAssets = [],
    clientModels = [];
  for (const item of definitions.values()) {
    if (item.conflict) continue;
    const { factory, sf, checker, id, asset } = item;
    if (
      factory.parameters
        .slice(0, 3)
        .some(
          (p) => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer,
        )
    ) {
      gaps.push("Unsupported webpack factory parameters in " + id);
      continue;
    }
    const parameterSymbols = factory.parameters
      .slice(0, 3)
      .map((p) => checker.getSymbolAtLocation(p.name));
    const requireSymbol = parameterSymbols[2];
    const isRequire = (n) =>
      Boolean(
        requireSymbol && checker.getSymbolAtLocation(n) === requireSymbol,
      );
    const interopBindings = new Set(),
      rebound = new Set();
    walk(factory.body, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        ts.isCallExpression(n.initializer ?? {}) &&
        ts.isPropertyAccessExpression(n.initializer.expression) &&
        isRequire(n.initializer.expression.expression) &&
        n.initializer.expression.name.text === "n"
      )
        interopBindings.add(checker.getSymbolAtLocation(n.name));
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left)
      )
        rebound.add(checker.getSymbolAtLocation(n.left));
    });
    const getter = (n) =>
      n && ts.isParenthesizedExpression(n)
        ? getter(n.expression)
        : ts.isArrowFunction(n) || ts.isFunctionExpression(n)
          ? ts.isBlock(n.body)
            ? n.body.statements.find(ts.isReturnStatement)?.expression
            : n.body
          : null;
    const originalCalls = new Map();
    walk(factory.body, (n) => {
      if (ts.isCallExpression(n)) {
        const key = fingerprint(sf, n);
        if (!originalCalls.has(key)) originalCalls.set(key, []);
        originalCalls.get(key).push({
          file: asset,
          ...position(sf, n),
          sourceVersionMatch: null,
          moduleId: id,
        });
      }
    });
    const transform = ts.transform(factory.body, [
      (context) => {
        const f = context.factory;
        const visit = (node) => {
          // Webpack4 defines getter.a with the same value returned by getter().
          if (
            ts.isPropertyAccessExpression(node) &&
            node.name.text === "a" &&
            ts.isIdentifier(node.expression) &&
            interopBindings.has(checker.getSymbolAtLocation(node.expression)) &&
            !rebound.has(checker.getSymbolAtLocation(node.expression))
          )
            return f.createCallExpression(
              ts.visitNode(node.expression, visit),
              undefined,
              [],
            );
          if (ts.isCallExpression(node)) {
            if (isRequire(node.expression)) {
              const target = literalId(node.arguments[0]);
              if (target !== null) {
                if (!definitions.has(target))
                  gaps.push(
                    `Missing webpack module ${target} referenced by ${id}`,
                  );
                return f.createCallExpression(
                  f.createIdentifier("require"),
                  undefined,
                  [f.createStringLiteral("./" + moduleName(target))],
                );
              }
              gaps.push("Dynamic webpack require in module " + id);
            }
            if (
              ts.isPropertyAccessExpression(node.expression) &&
              isRequire(node.expression.expression)
            ) {
              const method = node.expression.name.text;
              if (method === "d") {
                let pairs = [];
                if (ts.isObjectLiteralExpression(node.arguments[1] ?? {}))
                  pairs = node.arguments[1].properties
                    .filter(ts.isPropertyAssignment)
                    .map((p) => [p.name.text, getter(p.initializer)]);
                else if (ts.isStringLiteralLike(node.arguments[1] ?? {}))
                  pairs = [[node.arguments[1].text, getter(node.arguments[2])]];
                if (
                  !pairs.length ||
                  pairs.some(
                    ([name, value]) => !value || !/^[\w$]+$/.test(name),
                  )
                ) {
                  gaps.push("Unsupported webpack export getter in " + id);
                  return f.createVoidZero();
                }
                return f.createCommaListExpression(
                  pairs.map(([name, value]) =>
                    f.createBinaryExpression(
                      f.createPropertyAccessExpression(
                        f.createIdentifier("exports"),
                        name,
                      ),
                      f.createToken(ts.SyntaxKind.EqualsToken),
                      ts.visitNode(value, visit),
                    ),
                  ),
                );
              }
              if (method === "r") return f.createVoidZero();
              if (method === "n") {
                const m = f.createIdentifier("m"),
                  param = f.createParameterDeclaration(undefined, undefined, m);
                const value = f.createConditionalExpression(
                  f.createBinaryExpression(
                    m,
                    f.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
                    f.createPropertyAccessExpression(m, "__esModule"),
                  ),
                  f.createToken(ts.SyntaxKind.QuestionToken),
                  f.createPropertyAccessExpression(m, "default"),
                  f.createToken(ts.SyntaxKind.ColonToken),
                  m,
                );
                return f.createCallExpression(
                  f.createParenthesizedExpression(
                    f.createArrowFunction(
                      undefined,
                      undefined,
                      [param],
                      undefined,
                      f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      f.createArrowFunction(
                        undefined,
                        undefined,
                        [],
                        undefined,
                        f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                        value,
                      ),
                    ),
                  ),
                  undefined,
                  node.arguments.map((a) => ts.visitNode(a, visit)),
                );
              }
              if (method === "e" && literalId(node.arguments[0]) === null)
                gaps.push("Dynamic webpack chunk ID in module " + id);
            }
            if (
              ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "then" &&
              node.arguments.length === 1
            ) {
              const cb = node.arguments[0];
              if (
                ts.isCallExpression(cb) &&
                ts.isPropertyAccessExpression(cb.expression) &&
                cb.expression.name.text === "bind" &&
                isRequire(cb.expression.expression)
              ) {
                const target = literalId(cb.arguments[1]);
                if (target !== null) {
                  if (!definitions.has(target))
                    gaps.push("Missing async webpack module " + target);
                  return f.createCallExpression(
                    f.createToken(ts.SyntaxKind.ImportKeyword),
                    undefined,
                    [f.createStringLiteral("./" + moduleName(target))],
                  );
                }
              }
            }
          }
          if (
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression)
          ) {
            const call = node.expression;
            if (
              ts.isPropertyAccessExpression(call.expression) &&
              isRequire(call.expression.expression) &&
              call.expression.name.text === "d"
            ) {
              let exports = [];
              if (ts.isObjectLiteralExpression(call.arguments[1] ?? {}))
                exports = call.arguments[1].properties
                  .filter(ts.isPropertyAssignment)
                  .map((p) => [p.name.text, getter(p.initializer)]);
              else if (ts.isStringLiteralLike(call.arguments[1] ?? {}))
                exports = [[call.arguments[1].text, getter(call.arguments[2])]];
              if (
                exports.some(
                  ([name, value]) => !value || !/^[\w$]+$/.test(name),
                )
              ) {
                gaps.push("Unsupported webpack export getter in " + id);
                return f.createEmptyStatement();
              }
              return exports.map(([name, value]) =>
                f.createExpressionStatement(
                  f.createBinaryExpression(
                    f.createPropertyAccessExpression(
                      f.createIdentifier("exports"),
                      name,
                    ),
                    f.createToken(ts.SyntaxKind.EqualsToken),
                    ts.visitNode(value, visit),
                  ),
                ),
              );
            }
          }
          if (ts.isIdentifier(node)) {
            const binding = checker.getSymbolAtLocation(node);
            const index = binding ? parameterSymbols.indexOf(binding) : -1;
            if (index >= 0)
              return f.createIdentifier(
                ["module", "exports", "require"][index],
              );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (node) => ts.visitNode(node, visit);
      },
    ]);
    const body = transform.transformed[0];
    const flatten = (n) =>
      ts.isCommaListExpression(n)
        ? n.elements.flatMap(flatten)
        : ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.CommaToken
          ? [...flatten(n.left), ...flatten(n.right)]
          : [n];
    const statements = body.statements.flatMap((s) =>
      ts.isExpressionStatement(s)
        ? flatten(s.expression).map((e) =>
            ts.factory.createExpressionStatement(e),
          )
        : [s],
    );
    // Match the transformed call syntax back to the original call node, including interop rewrites.
    originalCalls.clear();
    walk(body, (n) => {
      if (!ts.isCallExpression(n)) return;
      const original = ts.getOriginalNode(n);
      if (!ts.isCallExpression(original) || original.pos < 0) return;
      const key = fingerprint(sf, n);
      if (!originalCalls.has(key)) originalCalls.set(key, []);
      originalCalls
        .get(key)
        .push({
          file: asset,
          ...position(sf, original),
          sourceVersionMatch: null,
          moduleId: id,
        });
    });
    const code =
      statements
        .map((s) => printer.printNode(ts.EmitHint.Unspecified, s, sf))
        .join("\n") + "\nexport {};\n";
    transform.dispose();
    if (files.length >= 10000) {
      gaps.push("Webpack module count budget exceeded");
      break;
    }
    derivedBytes += Buffer.byteLength(code);
    if (derivedBytes > 128 * 1024 * 1024) {
      gaps.push("Webpack derived byte budget exceeded");
      break;
    }
    const name = moduleName(id);
    await fs.writeFile(path.join(root, name), code);
    const signatureSha256 = clientContracts.some(
        (c) =>
          !c.screenTokens ||
          c.screenTokens.every((token) => code.includes(token)),
      )
        ? compiledClientFingerprint(code)
        : null,
      contract = clientContracts.find(
        (c) => c.signatureSha256 === signatureSha256,
      );
    if (contract) {
      const model = {
        ...contract,
        file: name,
        sha256: createHash("sha256").update(code).digest("hex"),
        signatureSha256,
        dependencyState: "unverified-implementations",
      };
      clientModels.push(model);
      gaps.push(
        "Compiled client facade contract (reference " +
          contract.module +
          "@" +
          contract.version +
          ") matched " +
          asset +
          "#" +
          id +
          "; installed package version/dependency implementations/transport behavior remain unverified",
      );
    }
    files.push(name);
    moduleAssets.push({
      file: name,
      moduleId: id,
      generatedFile: asset,
      range: position(sf, factory),
      basis: "recognized webpack factory; no target runtime executed",
    });
    const derived = ts.createSourceFile(
        name,
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
      derivedCalls = new Map();
    const imports = [];
    let forwardsClient = false;
    for (const statement of derived.statements) {
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression)
      ) {
        const a = statement.expression;
        if (
          a.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          a.left.getText(derived) === "module.exports" &&
          ts.isCallExpression(a.right) &&
          a.right.expression.getText(derived) === "require" &&
          ts.isStringLiteralLike(a.right.arguments[0] ?? {})
        )
          forwardsClient = true;
      }
    }
    moduleAssets.at(-1).imports = imports;
    moduleAssets.at(-1).forwardsClient = forwardsClient;
    walk(derived, (n) => {
      if (ts.isCallExpression(n)) {
        if (
          ts.isIdentifier(n.expression) &&
          n.expression.text === "require" &&
          ts.isStringLiteralLike(n.arguments[0] ?? {}) &&
          n.arguments[0].text.startsWith("./")
        )
          imports.push(n.arguments[0].text.slice(2));
        const key = fingerprint(derived, n);
        if (!derivedCalls.has(key)) derivedCalls.set(key, []);
        derivedCalls.get(key).push(position(derived, n));
      }
    });
    for (const [key, positions] of derivedCalls) {
      const originals = originalCalls.get(key);
      if (!originals || originals.length !== positions.length) continue;
      for (let i = 0; i < positions.length; i++)
        locations.set(`${name}:${positions[i].line}:${positions[i].column}`, [
          originals[i],
        ]);
    }
  }
  for (const { asset, text } of native) {
    const name = path.basename(asset.file);
    if (files.includes(name)) {
      gaps.push("Native module filename conflict: " + name);
      continue;
    }
    await fs.writeFile(path.join(root, name), text);
    files.push(name);
    moduleAssets.push({
      file: name,
      moduleId: null,
      generatedFile: asset.file,
      basis: "native script alongside webpack",
    });
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) {
        const p = position(sf, n);
        locations.set(`${name}:${p.line}:${p.column}`, [
          { file: asset.file, ...p, sourceVersionMatch: null },
        ]);
      }
    });
  }
  if (!files.length)
    gaps.push("Webpack signature found but no supported module table");
  gaps.push(
    "Webpack factories analyzed as module inventory; business entry/lifecycle and all runtime behaviors are not proven",
  );
  const clientFiles = new Set(clientModels.map((m) => m.file));
  for (let pass = 0; pass < 4; pass++)
    for (const asset of moduleAssets)
      if (
        asset.forwardsClient &&
        asset.imports?.length === 1 &&
        clientFiles.has(asset.imports[0])
      )
        clientFiles.add(asset.file);
  const entryPriority = moduleAssets
    .filter(
      (asset) =>
        !clientModels.some((m) => m.file === asset.file) &&
        asset.imports?.some((file) => clientFiles.has(file)),
    )
    .map((asset) => asset.file);
  return {
    root,
    files,
    entryPriority,
    locations,
    moduleAssets,
    clientModels,
    chunks,
    gaps: [...new Set(gaps)],
  };
}
