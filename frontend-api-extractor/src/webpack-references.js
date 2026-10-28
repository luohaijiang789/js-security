import ts from "typescript";
const unknown = Symbol("unknown constant");
const walk = (n, fn) => {
  fn(n);
  ts.forEachChild(n, (c) => walk(c, fn));
};
function constant(node, env, owner, publicPath) {
  if (!node) return unknown;
  if (ts.isParenthesizedExpression(node))
    return constant(node.expression, env, owner, publicPath);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node))
    return env.has(node.text) ? env.get(node.text) : unknown;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "p" &&
    node.expression.getText() === owner
  )
    return publicPath;
  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name))
        return unknown;
      const value = constant(p.initializer, env, owner, publicPath);
      if (value === unknown) return unknown;
      Object.defineProperty(object, p.name.text, { value, enumerable: true });
    }
    return object;
  }
  if (ts.isElementAccessExpression(node)) {
    const object = constant(node.expression, env, owner, publicPath),
      key = constant(node.argumentExpression, env, owner, publicPath);
    return object !== unknown &&
      object &&
      typeof object === "object" &&
      key !== unknown
      ? object[key]
      : unknown;
  }
  if (ts.isBinaryExpression(node)) {
    const a = constant(node.left, env, owner, publicPath);
    if (a === unknown) return unknown;
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken)
      return a || constant(node.right, env, owner, publicPath);
    if (op === ts.SyntaxKind.QuestionQuestionToken)
      return a ?? constant(node.right, env, owner, publicPath);
    const b = constant(node.right, env, owner, publicPath);
    if (b === unknown) return unknown;
    if (
      op === ts.SyntaxKind.PlusToken &&
      ["string", "number"].includes(typeof a) &&
      ["string", "number"].includes(typeof b)
    )
      return a + b;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
  }
  if (ts.isConditionalExpression(node)) {
    const c = constant(node.condition, env, owner, publicPath);
    return c === unknown
      ? unknown
      : constant(c ? node.whenTrue : node.whenFalse, env, owner, publicPath);
  }
  return unknown;
}
export function webpackReferences(text, file) {
  const namespaces = [
    ...new Set(text.match(/webpackChunk[\w$]*|webpackJsonp[\w$]*/g) ?? []),
  ];
  if (namespaces.length !== 1)
    return { namespace: null, resolvers: [], requests: [] };
  const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    paths = new Map(),
    resolvers = [],
    requests = [];
  walk(sf, (n) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.name.text === "p" &&
      ts.isStringLiteralLike(n.right)
    )
      paths.set(n.left.expression.getText(sf), n.right.text);
  });
  walk(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "e"
    ) {
      const p = sf.getLineAndCharacterOfPosition(n.getStart(sf)),
        a = n.arguments[0];
      requests.push({
        id:
          a && (ts.isStringLiteralLike(a) || ts.isNumericLiteral(a))
            ? a.text
            : null,
        line: p.line + 1,
        column: p.character + 1,
      });
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ["u", "e"].includes(n.left.name.text) &&
      (ts.isArrowFunction(n.right) || ts.isFunctionExpression(n.right)) &&
      n.right.parameters.length === 1 &&
      ts.isIdentifier(n.right.parameters[0].name)
    ) {
      const owner = n.left.expression.getText(sf),
        publicPath = paths.get(owner);
      if (publicPath === undefined) return;
      let expression;
      if (n.left.name.text === "u")
        expression = ts.isBlock(n.right.body)
          ? n.right.body.statements.find(ts.isReturnStatement)?.expression
          : n.right.body;
      else
        walk(n.right.body, (c) => {
          if (
            ts.isBinaryExpression(c) &&
            c.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(c.left) &&
            c.left.name.text === "src" &&
            c.right.getText(sf).includes(owner + ".p")
          )
            expression = c.right;
        });
      if (expression) {
        const parameter = n.right.parameters[0].name.text;
        resolvers.push({
          resolve: (id) => {
            const value = constant(
              expression,
              new Map([
                [parameter, /^\d+$/.test(String(id)) ? Number(id) : id],
              ]),
              owner,
              publicPath,
            );
            return typeof value === "string"
              ? n.left.name.text === "u"
                ? publicPath + value
                : value
              : null;
          },
        });
      }
    }
  });
  return { namespace: namespaces[0], resolvers, requests };
}
