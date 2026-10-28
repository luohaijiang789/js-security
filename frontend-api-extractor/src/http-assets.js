import { fetch, ProxyAgent } from "undici";
export function httpUrl(input, base) {
  const u = new URL(input, base);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new Error("只允许无凭据HTTP/HTTPS地址");
  u.hash = "";
  return u;
}
export async function fetchAsset(
  input,
  { allowedHosts, maxBytes = 2 * 1024 * 1024, timeoutMs = 10000 } = {},
) {
  let url = httpUrl(input);
  const redirects = [];
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedHosts.includes(url.hostname))
      throw new Error("主机不在获取范围: " + url.hostname);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      proxy =
        url.protocol === "https:"
          ? process.env.HTTPS_PROXY
          : process.env.HTTP_PROXY;
    const noProxy = (process.env.NO_PROXY ?? "")
      .split(",")
      .some(
        (v) =>
          v.trim() &&
          (v.trim() === "*" ||
            url.hostname === v.trim() ||
            url.hostname.endsWith("." + v.trim().replace(/^\./, ""))),
      );
    const dispatcher =
      proxy && !local && !noProxy ? new ProxyAgent(proxy) : undefined;
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("重定向缺少Location");
        redirects.push(url.href);
        url = httpUrl(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("资产HTTP状态 " + response.status);
      }
      let bytes = 0;
      const parts = [];
      for await (const part of response.body) {
        bytes += part.length;
        if (bytes > maxBytes) throw new Error("单资产字节预算超限");
        parts.push(Buffer.from(part));
      }
      return {
        originalUrl: input,
        finalUrl: url.href,
        redirects,
        contentType: response.headers.get("content-type") ?? "",
        bytes,
        text: Buffer.concat(parts).toString("utf8"),
      };
    } finally {
      await dispatcher?.close();
    }
  }
  throw new Error("重定向层数超过5");
}
