export type Phase =
  | "collecting"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "interrupted";
export interface Gap {
  kind: string;
  message: string;
  source?: string;
}
export interface CaptureContext {
  type: "page" | "unknown";
  page_url: string | null;
  request_base_url: string | null;
  evidence: string;
}
export interface Asset {
  id: string;
  task_id: string;
  url: string | null;
  location: string;
  content: string;
  sha256: string;
  bytes: number;
  context_key: string;
  context: CaptureContext;
  capture_url: string;
  script_id: string;
  captured_at: string;
}
export interface Task {
  id: string;
  phase: Phase;
  started_at: string;
  assets: number;
  bytes: number;
  gaps: Gap[];
  omitted_gaps: number;
  tabs: number[];
}
export interface Snapshot {
  schema_version: "capture-0.1";
  snapshot_id: string;
  task_id: string;
  assets: Asset[];
  gaps: Gap[];
  frozen_at: string;
}
export const LIMITS = {
  files: 300,
  assetBytes: 2 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  pending: 500,
  gaps: 200,
  targets: 60,
};
export function httpURL(value: unknown): boolean {
  try {
    const u = new URL(String(value));
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
export async function sha(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
