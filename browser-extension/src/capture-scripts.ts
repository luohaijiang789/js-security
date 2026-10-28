// Read already parsed code through CDP; never evaluate it or request business APIs.
export async function captureLoadedScripts(
  api: typeof chrome = chrome,
  {
    maxScripts = 200,
    maxSourceBytes = 4 * 1024 * 1024,
    maxTotalBytes = 12 * 1024 * 1024,
    settleMs = 200,
  } = {},
) {
  const tabs = (await api.tabs.query({})).filter(
      (t) => t.id !== undefined && /^https?:\/\//i.test(t.url ?? ""),
    ),
    assets: any[] = [],
    pages: any[] = [],
    gaps: string[] = [];
  let totalBytes = 0;
  const sha = async (value: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  for (const tab of tabs) {
    const target = { tabId: tab.id! },
      scripts = new Map<
        string,
        { source: chrome.debugger.DebuggerSession; data: any }
      >(),
      contexts = new Map<string, any>();
    let owned = false;
    const listener = (
      source: chrome.debugger.DebuggerSession,
      method: string,
      params?: object,
    ) => {
      if (source.tabId !== tab.id) return;
      const p = params as any,
        key = source.sessionId ?? "";
      if (method === "Runtime.executionContextCreated")
        contexts.set(key + ":" + p.context.id, p.context);
      if (method === "Debugger.scriptParsed" && scripts.size < maxScripts)
        scripts.set(key + ":" + p.scriptId, { source, data: p });
    };
    api.debugger.onEvent.addListener(listener);
    try {
      try {
        await api.debugger.sendCommand(target, "Runtime.enable");
      } catch {
        await api.debugger.attach(target, "1.3");
        owned = true;
        await api.debugger.sendCommand(target, "Runtime.enable");
      }
      await api.debugger.sendCommand(target, "Page.enable");
      const tree = (await api.debugger.sendCommand(
        target,
        "Page.getFrameTree",
      )) as any;
      const dom = (await api.debugger.sendCommand(target, "DOM.getDocument", {
        depth: 0,
      })) as any;
      const page = {
        url: tree.frameTree.frame.url,
        frameId: tree.frameTree.frame.id,
        baseUrl: dom.root.baseURL ?? null,
        tabId: tab.id,
      };
      pages.push(page);
      await api.debugger.sendCommand(target, "Debugger.enable");
      await new Promise((r) => setTimeout(r, settleMs));
      if (scripts.size >= maxScripts)
        gaps.push("脚本数量达到快照上限: " + tab.url);
      for (const { source, data } of scripts.values()) {
        if (assets.length >= maxScripts) {
          gaps.push("总脚本数量预算超限");
          break;
        }
        try {
          const result = (await api.debugger.sendCommand(
              source,
              "Debugger.getScriptSource",
              { scriptId: data.scriptId },
            )) as any,
            content = result.scriptSource;
          if (typeof content !== "string") {
            gaps.push("脚本源不可取得: " + data.scriptId);
            continue;
          }
          const size = new TextEncoder().encode(content).length;
          if (size > maxSourceBytes || totalBytes + size > maxTotalBytes) {
            gaps.push("脚本字节预算超限: " + (data.url || data.scriptId));
            continue;
          }
          totalBytes += size;
          const execution = contexts.get(
              (source.sessionId ?? "") + ":" + data.executionContextId,
            ),
            top =
              execution?.auxData?.frameId === page.frameId &&
              execution?.auxData?.isDefault === true;
          let url =
            typeof data.url === "string" &&
            data.url.length < 4096 &&
            /^(https?:|blob:)/.test(data.url)
              ? data.url
              : `debugger-script:${tab.id}/${source.sessionId ?? "root"}/${data.scriptId}`;
          try {
            const parsed = new URL(url);
            if (parsed.username || parsed.password)
              url = `debugger-script:${tab.id}/${data.scriptId}`;
          } catch {}
          assets.push({
            url,
            content,
            sha256: await sha(content),
            scriptId: data.scriptId,
            sessionId: source.sessionId ?? null,
            tabId: tab.id,
            startLine: data.startLine ?? 0,
            startColumn: data.startColumn ?? 0,
            context:
              top && page.baseUrl && /^https?:\/\//.test(page.baseUrl)
                ? { kind: "document", pageUrl: page.url, baseUrl: page.baseUrl }
                : { kind: "unknown", pageUrl: page.url, baseUrl: null },
            captureState: "parsed-script-source",
            parentState: "unknown",
            fetchDepth: null,
          });
        } catch {
          gaps.push("读取脚本源失败: " + data.scriptId);
        }
      }
    } catch {
      gaps.push("网页调试连接或脚本读取失败: " + tab.url);
    } finally {
      api.debugger.onEvent.removeListener(listener);
      if (owned) await api.debugger.detach(target).catch(() => {});
    }
  }
  return {
    schemaVersion: 1,
    kind: "debugger-script-snapshot",
    pages,
    assets,
    gaps,
    totalBytes,
    limitations: [
      "读取已解析代码不证明其接口已发送",
      "父引用与外部获取深度未知，不伪装成第一层",
      "未加载脚本、其他iframe/worker与后续动态脚本未保证完整",
    ],
  };
}
