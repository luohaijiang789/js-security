/** Shared browser-evidence contracts; no storage, transport or Vue dependencies. */
export type CaptureEvent = {
  id: string;
  scan_id: string;
  kind: string;
  category: string;
  time: string;
  tab_id?: number;
  session_id: string;
  epoch: string;
  data: Record<string, any>;
  /** Receiver-assigned body identifier; never computed in the browser. */
  object_id?: string;
  status: string;
  transport?: { stream_id: string; sequence: number };
};
export type RemoteSettings = { url: string; project: string };
export type ObjectAck = {
  object_id: string;
  url?: string | null;
  bytes: number;
  committed: true;
  durable: true;
};
export type DeliveryAck = {
  schema: string;
  event_id: string;
  event_sha256?: string;
  object_id?: string | null;
  durable: true;
  transport?: { stream_id: string; sequence: number; event_bytes: number };
};
export type DeliveryStatus = {
  stream_id: string;
  admitted: number;
  acknowledged: number;
  pending: number;
  rejected: number;
  pending_bytes: number;
  categories: Record<string, number>;
  bytes: number;
  sealed: boolean;
};
export type StreamReceipt = {
  schema: string;
  stream_id: string;
  scan_id: string;
  count: number;
  categories: Record<string, number>;
  bytes: number;
  sealed: true;
  durable: true;
};

export function validateRemote(s: RemoteSettings | undefined) {
  if (!s || !/^[A-Za-z0-9_-]{1,64}$/.test(s.project))
    throw Error("请填写远端地址和项目");
  const url = new URL(s.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw Error("请填写HTTP或HTTPS服务器源地址，例如http://服务器IP:8379");
}
