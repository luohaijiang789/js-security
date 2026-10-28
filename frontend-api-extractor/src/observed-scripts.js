import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { stableId } from "./delivery.js";
import { scriptReferences } from "./script-assets.js";
import { httpUrl } from "./http-assets.js";
export async function importObservedScripts(snapshot, directory) {
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.kind !== "debugger-script-snapshot" ||
    !Array.isArray(snapshot.assets) ||
    snapshot.assets.length > 200 ||
    !Array.isArray(snapshot.pages) ||
    snapshot.pages.length > 100
  )
    throw new Error("不支持的浏览器脚本快照");
  const assets = [],
    edges = [],
    gaps = [
      ...(snapshot.gaps ?? []),
      "读取已解析脚本不证明接口已发送；父链/未加载脚本/其他iframe与worker未保证完整",
    ],
    byKey = new Map(),
    texts = new Map();
  let totalBytes = 0;
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  for (const source of snapshot.assets) {
    if (
      typeof source.content !== "string" ||
      typeof source.url !== "string" ||
      source.url.length > 4096 ||
      !/^(?:https?:|blob:|debugger-script:)/.test(source.url)
    )
      throw new Error("浏览器脚本身份无效");
    const bytes = Buffer.from(source.content),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    totalBytes += bytes.length;
    if (bytes.length > 4 * 1024 * 1024 || totalBytes > 12 * 1024 * 1024)
      throw new Error("浏览器快照字节预算超限");
    if (sha256 !== source.sha256) throw new Error("浏览器脚本哈希不匹配");
    const context = source.context;
    if (
      !context ||
      !["document", "unknown"].includes(context.kind) ||
      (context.baseUrl !== null && typeof context.baseUrl !== "string")
    )
      throw new Error("快照上下文无效");
    if (context.kind === "unknown" && context.baseUrl !== null)
      throw new Error("未知上下文不能假定基址");
    if (context.baseUrl) httpUrl(context.baseUrl);
    if (/^https?:/.test(source.url)) httpUrl(source.url);
    const startLine =
        Number.isSafeInteger(source.startLine) && source.startLine >= 0
          ? source.startLine
          : 0,
      startColumn =
        Number.isSafeInteger(source.startColumn) && source.startColumn >= 0
          ? source.startColumn
          : 0;
    const key = JSON.stringify([source.url, sha256, startLine, startColumn]);
    let asset = byKey.get(key);
    if (!asset) {
      const id = stableId("script", [
        source.url,
        sha256,
        startLine,
        startColumn,
      ]);
      asset = {
        id,
        file: "assets/" + id + ".js",
        originalUrls: [source.url],
        finalUrl: source.url,
        sha256,
        bytes: bytes.length,
        fetchDepth: null,
        redirects: [],
        contexts: [],
        parents: [],
        state: "observed-loaded",
        inline:
          source.url === context.pageUrl && (startLine > 0 || startColumn > 0),
        scriptStartLine:
          Number.isSafeInteger(source.startLine) && source.startLine >= 0
            ? source.startLine
            : 0,
        scriptStartColumn:
          Number.isSafeInteger(source.startColumn) && source.startColumn >= 0
            ? source.startColumn
            : 0,
        browserEvidence: [],
      };
      assets.push(asset);
      byKey.set(key, asset);
      texts.set(id, source.content);
      await fs.writeFile(path.join(directory, asset.file), bytes);
    }
    asset.browserEvidence.push({
      tabId: source.tabId ?? null,
      sessionId: source.sessionId ?? null,
      scriptId: source.scriptId ?? null,
      provenance: "user-imported-CDP-source; origin not independently attested",
    });
    if (
      !asset.contexts.some((c) => JSON.stringify(c) === JSON.stringify(context))
    )
      asset.contexts.push(context);
    edges.push({
      id: stableId("edge", [asset.id, context, "observed-root"]),
      parentAssetId: null,
      assetId: asset.id,
      url: asset.finalUrl,
      depth: null,
      state: "fetched",
      reference: { kind: "observed-loaded-root", parentState: "unknown" },
      context,
    });
  }
  for (const asset of assets) {
    const { refs } = scriptReferences(texts.get(asset.id), asset.file);
    for (const ref of refs.filter((r) =>
      ["module", "dynamic-module"].includes(r.kind),
    )) {
      if (!ref.specifier) {
        gaps.push("动态JS引用无法关联");
        continue;
      }
      for (const context of asset.contexts) {
        try {
          const targetUrl = httpUrl(
              ref.specifier,
              asset.inline ? context.baseUrl : asset.finalUrl,
            ).href,
            candidates = assets.filter(
              (a) =>
                a.finalUrl === targetUrl &&
                a.contexts.some(
                  (c) => JSON.stringify(c) === JSON.stringify(context),
                ),
            );
          if (candidates.length === 1) {
            const target = candidates[0];
            target.parents.push(asset.id);
            edges.push({
              id: stableId("edge", [asset.id, target.id, ref, context]),
              parentAssetId: asset.id,
              assetId: target.id,
              url: targetUrl,
              depth: null,
              state: "fetched",
              reference: ref,
              context,
            });
          } else gaps.push("已解析脚本引用缺失或同URL多版本: " + targetUrl);
        } catch {
          gaps.push("脚本引用基址未知: " + asset.finalUrl);
        }
      }
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: "script-assets",
    mode: "browser-source-import",
    page: snapshot.pages[0]
      ? {
          originalUrl: snapshot.pages[0].url,
          finalUrl: snapshot.pages[0].url,
          baseUrl: snapshot.pages[0].baseUrl,
          sha256: null,
        }
      : null,
    pages: snapshot.pages,
    limits: {
      maxDepth: null,
      acquisition: "no new fetch; already parsed code",
      maxAssets: 200,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 12 * 1024 * 1024,
    },
    totalBytes,
    assets,
    edges,
    gaps: [...new Set(gaps)],
    complete: false,
  };
  await fs.writeFile(
    path.join(directory, "assets-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
