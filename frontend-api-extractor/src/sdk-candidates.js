import ts from "typescript";
import { sdkHttpModel } from "./sdk-http-model.js";
import { createHash } from "node:crypto";
const stableId = (kind, value) =>
  kind +
  "_" +
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const u = (n) => ({ __unknown: n?.getText() ?? "unknown" });
function literal(n) {
  if (!n) return null;
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isParenthesizedExpression(n)) return literal(n.expression);
  if (ts.isObjectLiteralExpression(n)) {
    const value = {};
    for (const p of n.properties) {
      if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name))
        value[p.name.text] = literal(p.initializer);
      else if (ts.isShorthandPropertyAssignment(p))
        value[p.name.text] = u(p.name);
      else value.__unknown = p.getText();
    }
    return value;
  }
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(literal);
  return u(n);
}
function fieldPaths(value, path = [], result = []) {
  if (!value || typeof value !== "object" || value.__unknown) return result;
  for (const [key, v] of Object.entries(value)) {
    result.push([...path, key]);
    fieldPaths(v, [...path, key], result);
  }
  return result;
}
export function sdkCandidates(program, files, relative, version = null) {
  const checker = program.getTypeChecker(),
    result = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const modules = new Set(),
      created = new Map(),
      factories = new Map(),
      vars = new Map(),
      constructors = [];
    const sym = (n) => checker.getSymbolAtLocation(n);
    const mutated = new Set();
    const pos = (n) => {
      const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      return {
        file: relative(file),
        line: p.line + 1,
        column: p.character + 1,
      };
    };
    const walk = (n, fn) => {
      fn(n);
      ts.forEachChild(n, (c) => walk(c, fn));
    };
    walk(sf, (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left)
      )
        mutated.add(sym(n.left));
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          n.operator,
        ) &&
        ts.isIdentifier(n.operand)
      )
        mutated.add(sym(n.operand));
    });
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        n.initializer.expression.getText(sf) === "require" &&
        !sym(n.initializer.expression)?.declarations?.some(
          (d) => d.getSourceFile().fileName === sf.fileName,
        ) &&
        n.initializer.arguments[0]?.text === "aliyun-sdk"
      )
        modules.add(sym(n.name));
      if (
        ts.isImportDeclaration(n) &&
        n.moduleSpecifier.text === "aliyun-sdk"
      ) {
        const name =
          n.importClause?.name ?? n.importClause?.namedBindings?.name;
        if (name) modules.add(sym(name));
      }
    });
    walk(sf, (n) => {
      if (
        !ts.isNewExpression(n) ||
        !ts.isPropertyAccessExpression(n.expression) ||
        !modules.has(sym(n.expression.expression)) ||
        mutated.has(sym(n.expression.expression)) ||
        !["STS", "RAM"].includes(n.expression.name.text)
      )
        return;
      const config = literal(n.arguments?.[0]),
        service = n.expression.name.text;
      const candidate = {
        id: stableId("sdk-init", [pos(n), service]),
        candidateKind: "sdk-initialization",
        module: "aliyun-sdk",
        service,
        configurationState:
          config &&
          typeof config === "object" &&
          !Array.isArray(config) &&
          !config.__unknown &&
          Object.keys(config).every((k) =>
            [
              "endpoint",
              "region",
              "apiVersion",
              "accessKeyId",
              "secretAccessKey",
              "sessionToken",
              "securityToken",
              "sslEnabled",
              "maxRetries",
            ].includes(k),
          )
            ? "supported"
            : "unknown",
        declaredSdkVersion: version,
        sdkVersion:
          typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
            ? version
            : null,
        endpoint: config?.endpoint ?? null,
        region: config?.region ?? null,
        apiVersion: config?.apiVersion ?? null,
        creation: pos(n),
        httpState: "unmodeled",
        gaps: ["SDK配置/操作候选不是HTTP请求；版本、签名、载体与序列化未证明"],
      };
      created.set(n, candidate);
      constructors.push(candidate);
      if (ts.isVariableDeclaration(n.parent))
        vars.set(sym(n.parent.name), [candidate]);
      if (ts.isReturnStatement(n.parent)) {
        let fn = n.parent.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        if (fn?.name) {
          const key = sym(fn.name);
          factories.set(key, [...(factories.get(key) ?? []), candidate]);
        }
      }
    });
    const resolve = (n) =>
      created.has(n)
        ? [created.get(n)]
        : ts.isIdentifier(n)
          ? mutated.has(sym(n))
            ? []
            : (vars.get(sym(n)) ?? [])
          : ts.isCallExpression(n)
            ? (factories.get(sym(n.expression)) ?? [])
            : [];
    for (let pass = 0; pass < 4; pass++)
      walk(sf, (n) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const candidates = resolve(n.initializer);
          if (candidates.length) vars.set(sym(n.name), candidates);
        }
        if (ts.isReturnStatement(n) && n.expression) {
          const candidates = resolve(n.expression);
          if (candidates.length) {
            let fn = n.parent;
            while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
            if (fn?.name) {
              const key = sym(fn.name);
              factories.set(key, [
                ...new Set([...(factories.get(key) ?? []), ...candidates]),
              ]);
            }
          }
        }
      });
    for (const init of constructors) result.push(init);
    walk(sf, (n) => {
      if (
        !ts.isCallExpression(n) ||
        !ts.isPropertyAccessExpression(n.expression)
      )
        return;
      const clients = resolve(n.expression.expression);
      if (!clients.length) return;
      const input = literal(n.arguments[0]);
      for (const init of clients)
        result.push({
          id: stableId("sdk-operation", [
            init.id,
            pos(n),
            n.expression.name.text,
          ]),
          candidateKind: "sdk-operation",
          initializationId: init.id,
          module: init.module,
          service: init.service,
          declaredSdkVersion: version,
          sdkVersion: init.sdkVersion,
          endpoint: init.endpoint,
          apiVersion: init.apiVersion,
          configurationState: init.configurationState,
          operation: n.expression.name.text,
          input,
          inputFields: fieldPaths(input),
          creation: init.creation,
          location: pos(n),
          httpState: "unmodeled",
          gaps: [...init.gaps],
        });
    });
  }
  for (const candidate of result) {
    const http = sdkHttpModel(candidate);
    if (http) {
      candidate.modeledHttp = http;
      candidate.httpState = "protocol-model-candidate";
    }
  }
  return result;
}
