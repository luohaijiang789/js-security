import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { parse } from "parse5";
import { webpackReferences } from "./webpack-references.js";
import { fetchAsset, httpUrl } from "./http-assets.js";
import { analyze } from "./analyzer.js";
import { analyzeBuild } from "./build-assets.js";
import { requestRows } from "./request-table.js";
import { stableId } from "./delivery.js";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const walk = (n, fn) => {
  fn(n);
  ts.forEachChild(n, (c) => walk(c, fn));
};
const printer = ts.createPrinter({ removeComments: true });
const fingerprint = (sf, n) =>
  printer.printNode(ts.EmitHint.Unspecified, n, sf).replace(/\s+/g, " ");
export function scriptReferences(text, file) {
  const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    refs = [];
  const add = (node, kind, argument) => {
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    refs.push({
      kind,
      specifier:
        argument && ts.isStringLiteralLike(argument) ? argument.text : null,
      expression: argument?.getText(sf) ?? "",
      line: p.line + 1,
      column: p.character + 1,
      start: argument?.getStart(sf),
      end: argument?.end,
    });
  };
  walk(sf, (n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier
    )
      add(n, "module", n.moduleSpecifier);
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      add(n, "dynamic-module", n.arguments[0]);
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "importScripts"
    )
      for (const a of n.arguments) add(n, "importScripts", a);
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ["Worker", "SharedWorker"].includes(n.expression.text)
    ) {
      const a = n.arguments?.[0];
      if (a && ts.isNewExpression(a) && a.expression.getText() === "URL")
        add(n, "worker", a.arguments?.[0]);
      else add(n, "worker", a);
    }
  });
  return { sf, refs };
}
export async function collectScripts(
  pageUrl,
  directory,
  {
    mode = "website",
    maxDepth = mode === "build" ? 1 : 3,
    allowedHosts,
    maxAssets = 100,
    maxFileBytes = 2 * 1024 * 1024,
    maxTotalBytes = 20 * 1024 * 1024,
    timeoutMs = 10000,
    totalTimeoutMs = 120000,
    fetcher = fetchAsset,
  } = {},
) {
  if (
    !["website", "build"].includes(mode) ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > (mode === "build" ? 1 : 3)
  )
    throw new Error("获取深度超出网站3层/构建1层限制");
  if (
    !Number.isInteger(maxAssets) ||
    maxAssets < 1 ||
    maxAssets > 1000 ||
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < maxFileBytes ||
    maxTotalBytes > 128 * 1024 * 1024 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 1 ||
    totalTimeoutMs > 300000
  )
    throw new Error("脚本资产预算无效");
  const seed = httpUrl(pageUrl),
    hosts = allowedHosts ?? [seed.hostname];
  if (
    !Array.isArray(hosts) ||
    hosts.some((v) => typeof v !== "string" || !v) ||
    !hosts.includes(seed.hostname)
  )
    throw new Error("页面主机必须在allowedHosts中");
  const started = Date.now(),
    deadline = started + totalTimeoutMs,
    assets = [],
    edges = [],
    gaps = [],
    queue = [],
    byUrl = new Map(),
    edgeSeen = new Set(),
    contextSeen = new Map(),
    webpackResolvers = new Map(),
    webpackPending = [];
  let totalBytes = 0;
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  const get = async (url) => {
    if (Date.now() >= deadline) throw new Error("资产任务总时间预算超限");
    const r = await fetcher(url, {
      allowedHosts: hosts,
      maxBytes: maxFileBytes,
      timeoutMs: Math.min(timeoutMs, Math.max(1, deadline - Date.now())),
    });
    totalBytes += r.bytes;
    if (totalBytes > maxTotalBytes) throw new Error("总资产字节预算超限");
    return r;
  };
  const page = await get(seed.href),
    tree = parse(page.text);
  let baseUrl = page.finalUrl,
    baseFound = false,
    inlineIndex = 0;
  const htmlNodes = [];
  const htmlWalk = (n) => {
    htmlNodes.push(n);
    for (const child of n.childNodes ?? []) htmlWalk(child);
  };
  htmlWalk(tree);
  for (const n of htmlNodes)
    if (n.tagName === "base" && !baseFound) {
      const href = n.attrs?.find((a) => a.name === "href")?.value;
      if (href) {
        baseUrl = httpUrl(href, page.finalUrl).href;
        baseFound = true;
      }
    }
  const importMap = {};
  for (const n of htmlNodes)
    if (
      n.tagName === "script" &&
      n.attrs?.some((a) => a.name === "type" && a.value === "importmap")
    ) {
      try {
        const map = JSON.parse(
          (n.childNodes ?? []).map((c) => c.value ?? "").join(""),
        );
        for (const [key, value] of Object.entries(map.imports ?? {}))
          if (typeof value === "string")
            importMap[key] = httpUrl(value, baseUrl).href;
        if (map.scopes) gaps.push("importmap scopes尚未支持");
      } catch {
        gaps.push("importmap无法解析");
      }
    }
  const context = { kind: "document", pageUrl: page.finalUrl, baseUrl };
  const enqueue = (url, depth, parent, reference, ctx, inlineText) =>
    queue.push({ url, depth, parent, reference, context: ctx, inlineText });
  for (const n of htmlNodes)
    if (n.tagName === "script") {
      const attrs = Object.fromEntries(
          (n.attrs ?? []).map((a) => [a.name, a.value]),
        ),
        type = (attrs.type ?? "").toLowerCase();
      if (
        type &&
        ![
          "module",
          "text/javascript",
          "application/javascript",
          "text/ecmascript",
          "application/ecmascript",
        ].includes(type)
      )
        continue;
      if (attrs.src) {
        try {
          enqueue(
            httpUrl(attrs.src, baseUrl).href,
            1,
            null,
            { kind: "html-script" },
            context,
          );
        } catch (error) {
          gaps.push(error.message);
        }
      } else {
        const text = (n.childNodes ?? [])
          .filter((c) => c.nodeName === "#text")
          .map((c) => c.value)
          .join("");
        const url = page.finalUrl + "#inline-" + ++inlineIndex;
        enqueue(url, 0, null, { kind: "inline-script" }, context, text);
      }
    }
  while (queue.length) {
    const task = queue.shift(),
      edgeKey = JSON.stringify([
        task.parent,
        task.url,
        task.reference.kind,
        task.reference.line,
        task.reference.column,
        task.context.baseUrl,
        task.depth,
      ]);
    if (edgeSeen.has(edgeKey)) continue;
    edgeSeen.add(edgeKey);
    const edge = {
      id: stableId("edge", edgeKey),
      parentAssetId: task.parent,
      url: task.url,
      depth: task.depth,
      reference: task.reference,
      context: task.context,
      state: "pending",
      assetId: null,
    };
    edges.push(edge);
    if (task.depth > maxDepth) {
      edge.state = "depth-exceeded";
      gaps.push("脚本引用超过深度: " + task.url);
      continue;
    }
    if (Date.now() >= deadline) {
      edge.state = "time-budget";
      gaps.push("资产任务总时间预算超限");
      continue;
    }
    let asset = byUrl.get(task.url);
    if (!asset) {
      if (assets.length >= maxAssets) {
        edge.state = "asset-budget";
        gaps.push("脚本数量预算超限: " + task.url);
        continue;
      }
      try {
        const response =
          task.inlineText !== undefined
            ? {
                finalUrl: task.url,
                text: task.inlineText,
                bytes: Buffer.byteLength(task.inlineText),
                redirects: [],
                contentType: "application/javascript",
              }
            : await get(task.url);
        if (task.inlineText !== undefined) {
          totalBytes += response.bytes;
          if (totalBytes > maxTotalBytes || response.bytes > maxFileBytes)
            throw new Error("内联脚本字节预算超限");
        }
        if (
          ![
            "application/javascript",
            "text/javascript",
            "application/ecmascript",
            "text/ecmascript",
            "application/x-javascript",
            "text/plain",
            "",
          ].some(
            (type) =>
              response.contentType.split(";")[0].trim().toLowerCase() === type,
          )
        )
          throw new Error("引用不是支持的JS内容类型");
        const existing = byUrl.get(response.finalUrl);
        if (existing) asset = existing;
        else {
          const sha256 = hash(response.text),
            id = stableId("script", [response.finalUrl, sha256]),
            file = "assets/" + id + ".js";
          asset = {
            id,
            file,
            originalUrls: [],
            finalUrl: response.finalUrl,
            sha256,
            bytes: response.bytes,
            fetchDepth: task.depth,
            redirects: response.redirects,
            contexts: [],
            parents: [],
            state: "fetched",
            inline: task.inlineText !== undefined,
          };
          assets.push(asset);
          await fs.writeFile(path.join(directory, file), response.text);
        }
        byUrl.set(response.finalUrl, asset);
        byUrl.set(task.url, asset);
      } catch (error) {
        edge.state = "fetch-failed";
        edge.reason = error.message;
        gaps.push(task.url + ": " + error.message);
        continue;
      }
    }
    if (!asset.originalUrls.includes(task.url))
      asset.originalUrls.push(task.url);
    asset.fetchDepth = Math.min(asset.fetchDepth, task.depth);
    if (task.parent && !asset.parents.includes(task.parent))
      asset.parents.push(task.parent);
    edge.state = "fetched";
    edge.assetId = asset.id;
    const ctx =
      task.reference.kind === "worker"
        ? {
            kind: "worker",
            pageUrl: task.context.pageUrl,
            baseUrl: asset.finalUrl,
          }
        : task.context;
    const contextKey = JSON.stringify(ctx);
    if (!asset.contexts.some((c) => JSON.stringify(c) === contextKey))
      asset.contexts.push(ctx);
    const visitKey = asset.id + "|" + contextKey;
    if (contextSeen.has(visitKey) && contextSeen.get(visitKey) <= task.depth)
      continue;
    contextSeen.set(visitKey, task.depth);
    const text = await fs.readFile(path.join(directory, asset.file), "utf8"),
      { refs } = scriptReferences(text, asset.file);
    const webpack = webpackReferences(text, asset.file);
    if (webpack.namespace) {
      const group = JSON.stringify([webpack.namespace, ctx]);
      if (webpack.resolvers.length)
        webpackResolvers.set(group, [
          ...(webpackResolvers.get(group) ?? []),
          ...webpack.resolvers,
        ]);
      for (const request of webpack.requests)
        webpackPending.push({
          group,
          request,
          parent: asset.id,
          context: ctx,
          depth: task.depth + 1,
          done: false,
        });
      for (const pending of webpackPending.filter((p) => !p.done)) {
        const resolvers = webpackResolvers.get(pending.group) ?? [];
        if (!resolvers.length || pending.request.id === null) continue;
        const candidates = resolvers.map((r) => r.resolve(pending.request.id));
        if (candidates.some((v) => !v)) continue;
        const unique = [...new Set(candidates)];
        if (unique.length !== 1) continue;
        try {
          enqueue(
            httpUrl(unique[0], pending.context.baseUrl).href,
            pending.depth,
            pending.parent,
            {
              kind: "webpack-chunk",
              line: pending.request.line,
              column: pending.request.column,
              chunkId: pending.request.id,
            },
            pending.context,
          );
          pending.done = true;
        } catch {}
      }
    }

    for (const ref of refs) {
      if (!ref.specifier) {
        edges.push({
          id: stableId("edge", [asset.id, ref]),
          parentAssetId: asset.id,
          depth: null,
          state: "dynamic-reference",
          reference: ref,
          context: ctx,
          assetId: null,
        });
        gaps.push("动态JS引用未解析: " + asset.finalUrl + ":" + ref.line);
        continue;
      }
      try {
        const base =
          ref.kind === "importScripts"
            ? ctx.baseUrl
            : asset.inline
              ? baseUrl
              : asset.finalUrl;
        let specifier = ref.specifier;
        if (
          ["module", "dynamic-module"].includes(ref.kind) &&
          !/^(?:\.{1,2}\/|\/|https?:)/.test(specifier)
        ) {
          const key =
            ctx.kind === "document"
              ? Object.keys(importMap)
                  .filter(
                    (k) =>
                      specifier === k ||
                      (k.endsWith("/") && specifier.startsWith(k)),
                  )
                  .sort((a, b) => b.length - a.length)[0]
              : null;
          if (!key) {
            edges.push({
              id: stableId("edge", [asset.id, ref]),
              parentAssetId: asset.id,
              depth: null,
              state: "bare-module-unresolved",
              reference: ref,
              context: ctx,
              assetId: null,
            });
            gaps.push("裸模块缺少可用importmap: " + specifier);
            continue;
          }
          specifier = importMap[key] + specifier.slice(key.length);
        }
        enqueue(
          httpUrl(specifier, base).href,
          task.depth + 1,
          asset.id,
          ref,
          ctx,
        );
      } catch (error) {
        gaps.push(error.message);
      }
    }
  }
  for (const pending of webpackPending)
    if (!pending.done) {
      edges.push({
        id: stableId("edge", pending),
        parentAssetId: pending.parent,
        assetId: null,
        depth: pending.depth,
        state: "webpack-chunk-unresolved",
        reference: pending.request,
        context: pending.context,
      });
      gaps.push("Webpack chunk映射/ID不确定，未枚举或猜测获取");
    }
  const manifest = {
    schemaVersion: 1,
    kind: "script-assets",
    mode,
    page: {
      originalUrl: seed.href,
      finalUrl: page.finalUrl,
      baseUrl,
      sha256: hash(page.text),
    },
    importMap,
    limits: {
      maxDepth,
      maxAssets,
      maxFileBytes,
      maxTotalBytes,
      totalTimeoutMs,
    },
    totalBytes,
    assets,
    edges,
    gaps: [...new Set(gaps)],
    complete: !gaps.length,
  };
  await fs.writeFile(
    path.join(directory, "assets-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
export async function analyzeScriptPackage(directory, manifest, options = {}) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "script-assets" ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > 1000 ||
    !Array.isArray(manifest.edges) ||
    manifest.edges.length > 10000
  )
    throw new Error("不支持的脚本资产包");
  const root = await fs.realpath(directory),
    derived = path.join(root, "analysis-scripts");
  await fs.mkdir(derived, { recursive: true });
  const sourceFiles = new Map(),
    byId = new Map(manifest.assets.map((a) => [a.id, a])),
    mappings = new Map(),
    packageGaps = [...(manifest.gaps ?? [])];
  let inputBytes = 0;
  for (const asset of manifest.assets) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(asset.id) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Array.isArray(asset.contexts) ||
      asset.contexts.length > 100
    )
      throw new Error("脚本资产身份或上下文无效");
    if (
      typeof asset.file !== "string" ||
      path.isAbsolute(asset.file) ||
      asset.file.split(/[\\/]/).includes("..")
    )
      throw new Error("资产路径无效");
    const file = await fs.realpath(path.join(root, asset.file));
    if (!file.startsWith(root + path.sep))
      throw new Error("资产文件越过包目录");
    const size = (await fs.stat(file)).size;
    inputBytes += size;
    if (size > 32 * 1024 * 1024 || inputBytes > 128 * 1024 * 1024)
      throw new Error("导入脚本字节预算超限");
    const bytes = await fs.readFile(file);
    if (hash(bytes) !== asset.sha256) throw new Error("脚本哈希不匹配");
    const name = asset.id + ".js",
      text = bytes.toString("utf8"),
      { sf, refs: verifiedRefs } = scriptReferences(text, asset.file),
      edits = [];
    for (const edge of manifest.edges.filter(
      (e) =>
        e.parentAssetId === asset.id &&
        e.state === "fetched" &&
        ["module", "dynamic-module"].includes(e.reference.kind),
    )) {
      const target = byId.get(edge.assetId),
        ref = edge.reference;
      if (
        !verifiedRefs.some(
          (r) =>
            r.start === ref.start &&
            r.end === ref.end &&
            r.specifier === ref.specifier &&
            r.kind === ref.kind,
        )
      )
        throw new Error("引用位置与原始脚本不符");
      if (target && Number.isInteger(ref.start) && Number.isInteger(ref.end))
        edits.push({
          start: ref.start,
          end: ref.end,
          text: JSON.stringify("./" + target.id + ".js"),
        });
    }
    let code = text;
    const unique = new Map(edits.map((e) => [e.start, e]));
    for (const e of [...unique.values()].sort((a, b) => b.start - a.start))
      code = code.slice(0, e.start) + e.text + code.slice(e.end);
    await fs.writeFile(path.join(derived, name), code);
    sourceFiles.set(name, asset);
    const originalCalls = new Map();
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) {
        const key = fingerprint(sf, n);
        if (!originalCalls.has(key)) originalCalls.set(key, []);
        const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        originalCalls
          .get(key)
          .push({ line: p.line + 1, column: p.character + 1 });
      }
    });
    const dsf = ts.createSourceFile(
        name,
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
      calls = new Map();
    walk(dsf, (n) => {
      if (ts.isCallExpression(n)) {
        const key = fingerprint(dsf, n);
        if (!calls.has(key)) calls.set(key, []);
        calls.get(key).push(n);
      }
    });
    for (const [key, nodes] of calls) {
      const original = originalCalls.get(key);
      if (original?.length !== nodes.length) continue;
      for (let i = 0; i < nodes.length; i++) {
        const p = dsf.getLineAndCharacterOfPosition(nodes[i].getStart(dsf));
        mappings.set(`${name}:${p.line + 1}:${p.character + 1}`, original[i]);
      }
    }
  }
  const contexts = [
    ...new Map(
      manifest.assets
        .flatMap((a) => a.contexts)
        .map((c) => [JSON.stringify(c), c]),
    ).values(),
  ];
  const rows = [],
    endpoints = [],
    assetCandidates = [],
    diagnostics = [],
    partitions = [];
  let usedSteps = 0,
    allComplete = true;
  const totalSteps = options.maxSteps ?? 100000;
  for (const [contextIndex, context] of contexts.entries()) {
    const key = JSON.stringify(context),
      files = manifest.assets
        .filter((a) => a.contexts.some((c) => JSON.stringify(c) === key))
        .map((a) => a.id + ".js");
    const entries = [
      ...new Set(
        manifest.edges
          .filter((e) => {
            if (
              e.state !== "fetched" ||
              (e.parentAssetId !== null && e.reference.kind !== "worker")
            )
              return false;
            const asset = byId.get(e.assetId);
            const actual =
              e.reference.kind === "worker"
                ? {
                    kind: "worker",
                    pageUrl: e.context.pageUrl,
                    baseUrl: asset?.finalUrl,
                  }
                : e.context;
            return JSON.stringify(actual) === key;
          })
          .map((e) => byId.get(e.assetId)?.id + ".js"),
      ),
    ];
    if (usedSteps >= totalSteps) {
      packageGaps.push("执行上下文分析达到共享总预算");
      allComplete = false;
      break;
    }
    const limit = Math.max(
      1,
      Math.floor((totalSteps - usedSteps) / (contexts.length - contextIndex)),
    );
    let report,
      locations = new Map(),
      webpackModules = [],
      webpackMode = false;
    const hasWebpack = (
      await Promise.all(
        files.map((file) => fs.readFile(path.join(derived, file), "utf8")),
      )
    ).some((text) =>
      /webpackChunk|webpackJsonp|__webpack_modules__|__webpack_require__/.test(
        text,
      ),
    );
    if (hasWebpack) {
      const contextRoot = path.join(root, "context-" + contextIndex);
      await fs.mkdir(path.join(contextRoot, "scripts"), { recursive: true });
      for (const file of files)
        await fs.copyFile(
          path.join(derived, file),
          path.join(contextRoot, "scripts", file),
        );
      const built = await analyzeBuild(
        contextRoot,
        ["scripts"],
        path.join(contextRoot, "output"),
        { ...options, maxSteps: limit },
      );
      report = built.report;
      locations = built.locations;
      webpackModules = built.webpack?.modules ?? [];
      webpackMode = built.mode === "webpack-module-static";
      packageGaps.push(
        ...built.gaps.map((g) => "上下文 " + contextIndex + ": " + g),
      );
    } else
      report = await analyze(derived, {
        ...options,
        maxSteps: limit,
        entries,
        include: files,
        exclude: [],
      });
    usedSteps += report.stats.steps;
    allComplete = allComplete && report.stats.complete;
    endpoints.push(...report.endpoints);
    assetCandidates.push(...report.assetCandidates);
    diagnostics.push(
      ...report.diagnostics.map((d) => ({ ...d, executionContext: context })),
    );
    partitions.push(
      ...report.stats.partitions.map((p) => ({
        ...p,
        executionContext: context,
      })),
    );
    for (const original of requestRows(
      report,
      { mode: "website-js-static", deploymentUrl: context.baseUrl },
      locations,
    )) {
      const originFile =
        original.generatedFile ??
        webpackModules.find((m) => m.file === original.sourceFile)
          ?.generatedFile;
      const sourceName =
        webpackMode && originFile
          ? path.basename(originFile)
          : original.sourceFile;
      const asset = sourceFiles.get(sourceName);
      if (!asset) continue;
      const pos = mappings.get(
        `${sourceName}:${webpackMode ? original.generatedLine : original.sourceLine}:${webpackMode ? original.generatedColumn : original.sourceColumn}`,
      );
      const row = {
        ...original,
        sourceKind: "website-js-static",
        discoveryBasis: webpackMode
          ? "website-webpack-module-static"
          : original.discoveryBasis,
        assetId: asset.id,
        javascriptUrl: asset.finalUrl,
        scriptSha256: asset.sha256,
        fetchDepth: asset.fetchDepth,
        executionContext: context,
        sourceFile: asset.finalUrl,
        sourceLine: pos ? pos.line + (asset.scriptStartLine ?? 0) : null,
        sourceColumn: pos
          ? pos.column + (pos.line === 1 ? (asset.scriptStartColumn ?? 0) : 0)
          : null,
        generatedFile: asset.finalUrl,
        generatedLine: pos ? pos.line + (asset.scriptStartLine ?? 0) : null,
        generatedColumn: pos
          ? pos.column + (pos.line === 1 ? (asset.scriptStartColumn ?? 0) : 0)
          : null,
      };
      if (!pos) row.gaps.push("派生脚本的发送位置未映射到原JS");
      row.id = stableId("website-row", [
        asset.id,
        context,
        row.entry,
        row.method,
        row.url,
        row.query,
        row.body,
        row.headers,
        row.stage,
      ]);
      rows.push(row);
    }
  }
  return {
    schemaVersion: 1,
    mode: "website-js-static",
    assets: manifest.assets,
    assetManifest: manifest,
    rows,
    endpoints,
    assetCandidates,
    diagnostics,
    gaps: packageGaps,
    stats: {
      files: sourceFiles.size,
      executionContexts: contexts.length,
      partitions,
      steps: usedSteps,
      complete: allComplete && manifest.complete && !packageGaps.length,
    },
  };
}
