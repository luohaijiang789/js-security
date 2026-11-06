// Use the pinned engine's Babel bindings; this module never executes captured JS.
module.exports = function collectSites(ast, source, babel) {
  const sites = [], traverse = babel.traverse.default || babel.traverse;
  const literal = (node) => node?.type === "StringLiteral" ? node.value : null;
  const member = (node) => node?.type === "MemberExpression" && !node.optional
    ? (!node.computed && node.property.type === "Identifier" ? node.property.name : literal(node.property)) : null;
  const global = (path, name) => !path.scope.getBinding(name);
  const point = (node) => ({ start: node.start, end: node.end, line: node.loc.start.line,
    column: node.loc.start.column, end_line: node.loc.end.line, end_column: node.loc.end.column, offset_unit: "utf16" });
  traverse(ast, {
    CallExpression(path) {
      const node = path.node, callee = node.callee;
      let sink, method, binding;
      if (callee.type === "Identifier" && callee.name === "fetch" && global(path, "fetch")) {
        sink = "fetch"; method = "GET"; binding = "unshadowed-browser-global";
        if (node.arguments.length > 1) {
          const options = node.arguments[1];
          if (options?.type !== "ObjectExpression" || options.properties.some((property) => property.type !== "ObjectProperty" || property.computed)) return;
          const methods = options.properties.filter((property) => (property.key.name || literal(property.key)) === "method");
          if (methods.length > 1 || (methods.length && literal(methods[0].value) === null)) return;
          if (methods.length) method = literal(methods[0].value).toUpperCase();
        }
      } else if (member(callee) === "sendBeacon" && callee.object.type === "Identifier" && callee.object.name === "navigator" && global(path, "navigator")) {
        sink = "sendBeacon"; method = "POST"; binding = "unshadowed-browser-global";
      } else if (["get", "post", "put", "patch", "delete", "head", "options"].includes(member(callee)) && callee.object.type === "Identifier") {
        const owner = path.scope.getBinding(callee.object.name);
        if (!owner?.constant || !owner.path.isImportDefaultSpecifier() || owner.path.parent.source.value !== "axios") return;
        sink = `axios.${member(callee)}`; method = member(callee).toUpperCase(); binding = "axios-default-import";
      } else return;
      const url = literal(node.arguments[0]);
      if (url === null) return; // Dynamic templates/wrappers need a separate binding proof.
      const fn = path.getFunctionParent();
      let name = fn?.node.id?.name || null;
      if (!name && fn?.parentPath.isVariableDeclarator()) name = fn.parentPath.node.id.name || null;
      let excerptEnd = Math.min(node.end, node.start + 2000);
      if (source.charCodeAt(excerptEnd - 1) >= 0xD800 && source.charCodeAt(excerptEnd - 1) <= 0xDBFF) excerptEnd--;
      sites.push({ sink, method, template: url, binding, ...point(node),
        excerpt: source.slice(node.start, excerptEnd), excerpt_end: excerptEnd,
        excerpt_truncated: node.end - node.start > 2000,
        lexical_context: fn ? { name, type: fn.node.type, ...point(fn.node) } : null });
    },
  });
  return sites;
};
