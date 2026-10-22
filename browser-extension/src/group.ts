import type { Config, RecordEntry } from "./model";
import { REDACTED } from "./privacy";
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as any)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export async function fingerprint(r: RecordEntry, c: Config) {
  const u = new URL(r.request_url);
  let body = structuredClone(r.request_body.parsed);
  const normalized = c.merge === "normalized" || c.merge === "representative";
  if (normalized) {
    for (const k of c.dynamic_query) {
      const vals = u.searchParams.getAll(k);
      if (vals.length) {
        u.searchParams.delete(k);
        vals.forEach(() => u.searchParams.append(k, "{DYNAMIC}"));
      }
    }
    for (const path of c.dynamic_json) {
      const keys = path.split(".");
      let parent: any = body;
      for (const k of keys.slice(0, -1)) parent = parent?.[k];
      if (parent && Object.hasOwn(parent, keys.at(-1)!))
        parent[keys.at(-1)!] = "{DYNAMIC}";
    }
    if (c.uuid_path)
      u.pathname = u.pathname.replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        "{UUID}",
      );
  }
  // Stable sort by name keeps duplicate values in their original order.
  const query = [...u.searchParams]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  u.search = "";
  query.forEach((p) => u.searchParams.append(p.name, p.value));
  const key = canonical({
    method: r.method,
    url: u.href,
    headers: r.request_headers,
    body,
    initiator: c.same_initiator ? r.initiator_url : null,
    version: r.filter_version,
  });
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return {
    id: r.scan_id + ":" + digest,
    key,
    normalized_url: u.href,
    candidate:
      key.includes(REDACTED) ||
      r.capture_status.body.state !== "complete" ||
      r.capture_status.headers.state !== "complete",
  };
}
