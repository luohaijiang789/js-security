import {
  defaults,
  gap,
  now,
  uid,
  type Scan,
  type RecordEntry,
  type Config,
  type Group,
  type InitiatorParentMatch,
  type InitiatorRelation,
  type InitiatorNode,
} from "./model";
import { matchFilter } from "./filter";
import {
  parseBody,
  parseResponseBody,
  protectRecord,
  safeURL,
} from "./privacy";
import { fingerprint } from "./group";
import * as db from "./store";
import { StackCapture } from "./stack";
import { savedFieldSet, selectRecordFields } from "./field-selection";
type Source = chrome.debugger.DebuggerSession;
type Hop = {
  record: RecordEntry;
  requestExtra?: boolean;
  responseExtra?: boolean;
  body?: Promise<void>;
  responseBody?: Promise<void>;
  stack?: Promise<void>;
  done?: boolean;
  finishing?: boolean;
};
type Channel = {
  hops: Hop[];
  requestExtras: any[];
  responseExtras: any[];
  source: Source;
  suppressed?: boolean;
};
const pairs = (h: Record<string, string> = {}) =>
  Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));

const responseMetadata = (response: any) => ({
  status_text: String(response?.statusText ?? ""),
  mime_type: String(response?.mimeType ?? ""),
  protocol: String(response?.protocol ?? ""),
  remote_ip_address: String(response?.remoteIPAddress ?? ""),
  remote_port: Number.isFinite(response?.remotePort)
    ? Number(response.remotePort)
    : null,
  from_disk_cache: !!response?.fromDiskCache,
  from_service_worker: !!response?.fromServiceWorker,
  from_prefetch_cache: !!response?.fromPrefetchCache,
  encoded_data_length: Number.isFinite(response?.encodedDataLength)
    ? Number(response.encodedDataLength)
    : null,
  timing: response?.timing ?? null,
  security_details: response?.securityDetails ?? null,
});
export class Recorder {
  scan: Scan | null = null;
  channels = new Map<string, Channel>();
  unavailableTabs = new Set<number>();
  targets = new Map<string, string>();
  connection = uid();
  entries: RecordEntry[] = [];
  groups = new Map<string, Group>();
  tail: Promise<void> = Promise.resolve();
  writing = false;
  flushPromise: Promise<void> | null = null;
  failure = "";
  bodyReads = 0;
  finalizers = 0;
  stacks: StackCapture;
  observedByURL = new Map<string, Map<string, string[]>>();
  observedByCdpId = new Map<string, Map<string, string>>();
  initiatorNodes: InitiatorNode[] = [];
  constructor(public send: (s: Source, m: string, p?: object) => Promise<any>) {
    this.stacks = new StackCapture(send);
  }
  async create(
    name: string,
    tabs: { id: number; url: string }[],
    config: Config,
    tabScope: "all" | "selected" = "selected",
  ) {
    if (this.scan && this.scan.state !== "ended")
      throw Error("请先停止当前任务");
    const time = now();
    this.scan = {
      id: uid(),
      name: name.trim() || "未命名任务",
      state: "recording",
      started_at: time,
      heartbeat: time,
      tab_scope: tabScope,
      tabs: tabs.map((tab) => ({
        ...tab,
        url: safeURL(tab.url, config.value_storage !== "complete"),
      })),
      config: structuredClone(config),
      versions: [
        { version: 1, effective_at: time, config: structuredClone(config) },
      ],
      browser: navigator.userAgent,
      plugin: "0.4.0",
      stats: {
        observed: 0,
        pending: 0,
        matched: 0,
        excluded: 0,
        unknown: 0,
        persisted: 0,
        groups: 0,
        bytes: 0,
        lost: 0,
      },
      gaps: [],
      rule_hits: {},
      integrity: "observed_scope",
    };
    this.channels.clear();
    this.unavailableTabs.clear();
    this.targets.clear();
    this.stacks.reset();
    this.observedByURL.clear();
    this.observedByCdpId.clear();
    this.initiatorNodes = [];
    this.entries = [];
    this.groups.clear();
    this.connection = uid();
    await db.put("scans", this.scan);
    return this.scan;
  }
  includeTab(tab: { id: number; url: string }) {
    if (!this.scan) return;
    const previous = this.scan.tabs.find((t) => t.id === tab.id);
    const url = safeURL(tab.url, this.scan.config.value_storage !== "complete");
    if (previous) previous.url = url;
    else this.scan.tabs.push({ id: tab.id, url });
    this.unavailableTabs.delete(tab.id);
  }
  async interruptTab(tabId: number, reason: string) {
    this.unavailableTabs.add(tabId);
    for (const c of this.channels.values())
      if (c.source.tabId === tabId)
        for (const h of c.hops)
          if (!h.done && h.record.request_state === "pending") {
            h.record.request_state = "incomplete";
            h.record.error = reason;
            this.finish(h);
          }
    await this.tail;
    for (const [key, c] of this.channels)
      if (c.source.tabId === tabId && c.hops.every((h) => h.done))
        this.channels.delete(key);
    await this.flush();
  }
  key(s: Source, id: string) {
    return `${s.tabId}:${s.sessionId ?? "root"}:${id}`;
  }
  initiatorContext(source: Source, loaderId: unknown) {
    return `${source.tabId}:${source.sessionId ?? "root"}:${typeof loaderId === "string" ? loaderId : ""}`;
  }
  resolveInitiator(
    source: Source,
    event: any,
    redirectParent?: RecordEntry,
  ): {
    parent: string | null;
    match: InitiatorParentMatch;
    relation: InitiatorRelation;
  } {
    if (redirectParent)
      return {
        parent: redirectParent.request_id,
        match: "redirect",
        relation: "redirect",
      };
    const context = this.initiatorContext(source, event.loaderId),
      sourceRequestId = event.initiator?.requestId;
    if (typeof sourceRequestId === "string") {
      const parent = this.observedByCdpId.get(context)?.get(sourceRequestId);
      return parent
        ? {
            parent,
            match: "exact",
            relation:
              event.initiator?.type === "preflight"
                ? "preflight"
                : "request-id",
          }
        : { parent: null, match: "missing", relation: "request-id" };
    }
    const url =
      event.initiator?.url ??
      event.initiator?.stack?.callFrames?.[0]?.url ??
      null;
    if (!url) return { parent: null, match: "none", relation: "none" };
    const candidates = this.observedByURL.get(context)?.get(url) ?? [];
    return candidates.length === 1
      ? {
          parent: candidates[0],
          match: "inferred",
          relation: "initiator-url",
        }
      : {
          parent: null,
          match: candidates.length ? "ambiguous" : "missing",
          relation: "initiator-url",
        };
  }
  rememberInitiatorCandidate(source: Source, event: any, record: RecordEntry) {
    const context = this.initiatorContext(source, event.loaderId);
    let ids = this.observedByCdpId.get(context);
    if (!ids) this.observedByCdpId.set(context, (ids = new Map()));
    ids.set(record.cdp_request_id, record.request_id);
    let urls = this.observedByURL.get(context);
    if (!urls) this.observedByURL.set(context, (urls = new Map()));
    const matches = urls.get(event.request.url) ?? [];
    matches.push(record.request_id);
    urls.set(event.request.url, matches);
  }
  async configure(source: Source) {
    await this.send(source, "Network.enable", {
      maxPostDataSize: this.scan?.config.body_limit ?? 1048576,
    });
    const stackWarnings = await this.stacks.configure(source);
    if (stackWarnings.length && this.scan)
      gap(this.scan, "stack_configuration", stackWarnings.join("；"));
    await this.send(source, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: true }, {}],
    }).catch(() => {
      if (this.scan)
        gap(this.scan!, "child_target", "当前目标未支持子目标自动附加");
    });
  }
  async event(source: Source, method: string, p: any) {
    const scan = this.scan;
    if (
      !scan ||
      !scan.tabs.some((t) => t.id === source.tabId) ||
      scan.state === "ended"
    )
      return;
    if (method === "Target.attachedToTarget") {
      this.targets.set(`${source.tabId}:${p.sessionId}`, p.targetInfo.targetId);
      await this.configure({ tabId: source.tabId, sessionId: p.sessionId });
      return;
    }
    if (method === "Target.detachedFromTarget") {
      this.stacks.forget({ tabId: source.tabId, sessionId: p.sessionId });
      for (const c of this.channels.values())
        if (
          c.source.tabId === source.tabId &&
          c.source.sessionId === p.sessionId
        )
          for (const h of c.hops)
            if (!h.done && h.record.request_state === "pending") {
              h.record.request_state = "incomplete";
              h.record.error = "子目标断开";
              this.finish(h);
            }
      gap(scan, "child_target_detached", "子目标断开，相关在途请求可能不完整");
      return;
    }
    if (!method.startsWith("Network.")) return;
    if (source.tabId !== undefined && this.unavailableTabs.has(source.tabId))
      return;
    const key = this.key(source, p.requestId);
    let channel = this.channels.get(key);
    if (method === "Network.requestWillBeSent") {
      let redirectParent: RecordEntry | undefined;
      if (p.redirectResponse && channel) {
        const previous = channel.hops.at(-1);
        if (previous) {
          redirectParent = previous.record;
          previous.responseExtra = !!p.redirectHasExtraInfo;
          this.applyResponse(
            previous,
            p.redirectResponse,
            !!p.redirectHasExtraInfo,
          );
          previous.record.request_state = "redirect";
          previous.record.capture_status.response_body = {
            state: "missing",
            reason: "重定向响应正文未读取",
          };
          this.applyExtras(channel);
          this.finish(previous);
        }
      }
      if (scan.state !== "recording") {
        if (channel) channel.suppressed = true;
        return;
      }
      let u: URL;
      try {
        u = new URL(p.request.url);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(u.protocol)) return;
      if (this.pendingCount() >= scan.config.queue_count) {
        this.protect("请求队列达到条数上限", 1);
        return;
      }
      channel ??= {
        hops: [],
        requestExtras: [],
        responseExtras: [],
        source,
      };
      channel.suppressed = false;
      this.channels.set(key, channel);
      const headers = pairs(p.request.headers),
        ct =
          headers.find((h) => h.name.toLowerCase() === "content-type")?.value ??
          "";
      const parsed = parseBody(
        p.request.postData,
        ct,
        !!p.request.hasPostData,
        scan.config.body_limit,
        false,
        scan.config.value_storage !== "complete",
      );
      const stack = this.stacks.snapshot(p.initiator?.stack),
        initiator =
          p.initiator?.url ?? p.initiator?.stack?.callFrames?.[0]?.url ?? null;
      const hop = channel.hops.length;
      const parent = this.resolveInitiator(source, p, redirectParent);
      const r: RecordEntry = {
        scan_id: scan.id,
        request_id: `${this.connection}:${source.tabId}:${source.sessionId ?? "root"}:${p.requestId}:${hop}`,
        cdp_request_id: p.requestId,
        session_id: source.sessionId ?? "root",
        target_id:
          this.targets.get(`${source.tabId}:${source.sessionId ?? "root"}`) ??
          null,
        redirect_hop: hop,
        timestamp: p.wallTime
          ? new Date(p.wallTime * 1000).toISOString()
          : now(),
        tab_id: source.tabId!,
        frame_id: p.frameId ?? null,
        loader_id: typeof p.loaderId === "string" ? p.loaderId : null,
        page_url: p.documentURL || null,
        referer:
          headers.find((h) => h.name.toLowerCase() === "referer")?.value ??
          null,
        request_url: p.request.url,
        domain: u.hostname,
        pathname: u.pathname,
        method: p.request.method,
        resource_type: p.type ?? "Other",
        status_code: null,
        request_state: "pending",
        request_headers: headers,
        query_params: [...u.searchParams].map(([name, value]) => ({
          name,
          value,
        })),
        request_body: parsed.body,
        content_type: ct,
        response_headers: [],
        response_headers_raw: null,
        response_body: { representation: "unavailable", parsed: null },
        response_content_type: "",
        response_metadata: responseMetadata(null),
        initiator_url: initiator,
        initiator_stack: stack,
        initiator: {
          type: String(p.initiator?.type ?? "other"),
          url: initiator
            ? safeURL(initiator, scan.config.value_storage !== "complete")
            : null,
          ...(typeof p.initiator?.requestId === "string"
            ? { request_id: p.initiator.requestId }
            : {}),
          ...(Number.isFinite(p.initiator?.lineNumber)
            ? { line_number: p.initiator.lineNumber }
            : {}),
          ...(Number.isFinite(p.initiator?.columnNumber)
            ? { column_number: p.initiator.columnNumber }
            : {}),
        },
        initiator_parent_id: parent.parent,
        initiator_parent_match: parent.match,
        initiator_relation: parent.relation,
        capture_status: {
          headers: {
            state: "partial",
            reason: "等待 ExtraInfo；CDP 可能不提供完整请求头",
          },
          body: parsed.quality,
          response_headers: {
            state: "missing",
            reason: "尚未收到响应头",
          },
          response_body: {
            state: "missing",
            reason: "尚未收到响应正文",
          },
          response_metadata: {
            state: "missing",
            reason: "尚未收到响应元数据",
          },
          stack: stack
            ? {
                state: "partial",
                reason: "仅 CDP 可见调用栈，不保证异步父链完整",
              }
            : { state: "missing", reason: "该请求未提供 JS 调用栈" },
          page: p.documentURL
            ? { state: "complete" }
            : { state: "missing", reason: "无 documentURL，不回填当前标签页" },
        },
        protection: {
          version:
            scan.config.value_storage === "complete"
              ? "retain-complete-v1"
              : "retain-truncate-v1",
          redacted: false,
          truncated: parsed.truncated,
        },
        filter_version: scan.versions.at(-1)!.version,
      };
      const h: Hop = { record: r, requestExtra: true };
      this.rememberInitiatorCandidate(source, p, r);
      h.stack = this.stacks
        .capture(source, p.initiator?.stack)
        .then((result) => {
          if (!h.done && this.scan === scan) {
            r.initiator_stack = result.stack;
            r.capture_status.stack = result.quality;
          }
        });
      if (typeof p.request.postData === "string" && !parsed.truncated)
        r.request_body.raw = p.request.postData;
      channel.hops.push(h);
      scan.stats.observed++;
      scan.stats.pending++;
      if (p.request.hasPostData && p.request.postData === undefined) {
        if (this.bodyReads < 4) {
          this.bodyReads++;
          h.body = this.body(
            source,
            p.requestId,
            r,
            scan.config.body_limit,
          ).finally(() => this.bodyReads--);
        } else
          r.capture_status.body = {
            state: "missing",
            reason: "正文读取并发上限，未读取",
          };
      }
      if (this.estimateBytes() > scan.config.queue_bytes)
        this.protect("请求队列达到字节上限", 0);
      this.applyExtras(channel);
      return;
    }
    if (method === "Network.requestWillBeSentExtraInfo") {
      if (!channel) {
        if (scan.state !== "recording") return;
        if (this.channels.size >= scan.config.queue_count) {
          this.protect("事件关联通道达到上限", 1);
          return;
        }
        channel = {
          hops: [],
          requestExtras: [],
          responseExtras: [],
          source,
        };
        this.channels.set(key, channel);
        setTimeout(() => {
          if (channel && !channel.hops.length) this.channels.delete(key);
        }, 2000);
      }
      if (channel.requestExtras.length < 16) channel.requestExtras.push(p);
      else this.protect("ExtraInfo 队列达到上限", 1);
      this.applyExtras(channel);
      return;
    }
    if (method === "Network.responseReceivedExtraInfo") {
      if (!channel) return;
      if (channel.responseExtras.length < 16) channel.responseExtras.push(p);
      else this.protect("响应 ExtraInfo 队列达到上限", 1);
      this.applyExtras(channel);
      return;
    }
    if (!channel) return;
    if (channel.suppressed) {
      if (
        method === "Network.loadingFinished" ||
        method === "Network.loadingFailed"
      )
        this.channels.delete(key);
      return;
    }
    const h = channel.hops.at(-1);
    if (!h) return;
    if (method === "Network.responseReceived") {
      h.responseExtra = !!p.hasExtraInfo;
      this.applyResponse(h, p.response, !!p.hasExtraInfo);
      this.applyExtras(channel);
    }
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      h.record.request_state = method.endsWith("Failed")
        ? "failed"
        : "complete";
      if (Number.isFinite(p.encodedDataLength) && h.record.response_metadata)
        h.record.response_metadata.encoded_data_length = Number(
          p.encodedDataLength,
        );
      if (method === "Network.loadingFinished") {
        const config = scan.versions.find(
          (version) => version.version === h.record.filter_version,
        )?.config;
        if (config && savedFieldSet(config).has("response_body")) {
          if (
            h.record.method === "HEAD" ||
            [204, 205, 304].includes(h.record.status_code ?? 0)
          ) {
            h.record.response_body = {
              representation: "empty",
              parsed: null,
              raw: "",
              encoding: "utf8",
            };
            h.record.capture_status.response_body = {
              state: "complete",
              reason: "该方法或状态码没有响应正文",
            };
          } else if (this.bodyReads < 4) {
            this.bodyReads++;
            h.responseBody = this.responseBody(
              source,
              p.requestId,
              h.record,
              config.body_limit,
            ).finally(() => this.bodyReads--);
          } else
            h.record.capture_status.response_body = {
              state: "missing",
              reason: "正文读取并发上限，未读取响应体",
            };
        }
      } else
        h.record.capture_status.response_body = {
          state: "missing",
          reason: "请求失败，响应正文不可用",
        };
      if (p.errorText) {
        h.record.error = p.errorText;
        gap(
          scan,
          "request_failed",
          "请求发送失败，详见请求状态",
          h.record.request_id,
        );
      }
      this.finish(h);
      setTimeout(() => {
        this.applyExtras(channel!);
        if (channel!.hops.every((x) => x.done)) this.channels.delete(key);
      }, 2000);
    }
  }
  async body(source: Source, id: string, r: RecordEntry, limit: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.send(source, "Network.getRequestPostData", { requestId: id }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(Error("正文读取超时")), 1500);
        }),
      ]);
      const parsed = parseBody(
        result.postData,
        r.content_type,
        true,
        limit,
        false,
        this.scan?.versions.find((v) => v.version === r.filter_version)?.config
          .value_storage !== "complete",
      );
      r.request_body = parsed.body;
      if (typeof result.postData === "string" && !parsed.truncated)
        r.request_body.raw = result.postData;
      r.capture_status.body = parsed.quality;
      r.protection.truncated = parsed.truncated;
    } catch {
      r.capture_status.body = {
        state: "missing",
        reason: "正文不可用或读取超时",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async responseBody(
    source: Source,
    id: string,
    r: RecordEntry,
    limit: number,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.send(source, "Network.getResponseBody", { requestId: id }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("响应正文读取超时")), 1500);
        }),
      ]);
      if (typeof result?.body !== "string") throw Error("CDP 未返回响应正文");
      const config = this.scan?.versions.find(
        (version) => version.version === r.filter_version,
      )?.config;
      const parsed = parseResponseBody(
        result.body,
        !!result.base64Encoded,
        r.response_content_type ?? "",
        limit,
        config?.value_storage !== "complete",
      );
      r.response_body = parsed.body;
      if (!result.base64Encoded && !parsed.truncated)
        r.response_body.raw = result.body;
      r.capture_status.response_body = parsed.quality;
      r.protection.truncated = r.protection.truncated || parsed.truncated;
    } catch {
      r.capture_status.response_body = {
        state: "missing",
        reason: "响应正文不可用、已被浏览器清理或读取超时",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  applyResponse(h: Hop, response: any, hasExtraInfo: boolean) {
    h.record.status_code = Number.isFinite(response?.status)
      ? Number(response.status)
      : h.record.status_code;
    h.record.response_headers = pairs(response?.headers);
    h.record.response_content_type =
      h.record.response_headers.find(
        (header) => header.name.toLowerCase() === "content-type",
      )?.value ?? String(response?.mimeType ?? "");
    h.record.response_metadata = responseMetadata(response);
    h.record.capture_status.response_headers = hasExtraInfo
      ? { state: "partial", reason: "等待响应 ExtraInfo" }
      : {
          state: "complete",
          reason: "浏览器未声明额外响应头信息",
        };
    h.record.capture_status.response_metadata = { state: "complete" };
  }
  applyExtras(c: Channel) {
    for (const h of c.hops) {
      if (h.requestExtra === false) continue;
      if (h.requestExtra === undefined) break;
      if (c.requestExtras.length) {
        const extra = c.requestExtras.shift();
        h.requestExtra = false;
        if (h.done) continue;
        h.record.request_headers = pairs(extra.headers);
        h.record.referer =
          h.record.request_headers.find(
            (p) => p.name.toLowerCase() === "referer",
          )?.value ?? null;
        h.record.capture_status.headers = {
          state: "complete",
          reason: "CDP ExtraInfo 可观测头；不声明线上字节级一致",
        };
        const ct = h.record.request_headers.find(
          (p) => p.name.toLowerCase() === "content-type",
        )?.value;
        if (
          ct &&
          ct !== h.record.content_type &&
          h.record.request_body.raw !== undefined
        ) {
          const raw = h.record.request_body.raw;
          const config = this.scan?.versions.find(
            (v) => v.version === h.record.filter_version,
          )?.config;
          const parsed = parseBody(
            raw,
            ct,
            true,
            config?.body_limit ?? 1048576,
            false,
            config?.value_storage !== "complete",
          );
          h.record.request_body = { ...parsed.body, raw };
          h.record.content_type = ct;
          h.record.capture_status.body = parsed.quality;
        }
      } else break;
    }
    for (const h of c.hops) {
      if (h.responseExtra === false) continue;
      if (h.responseExtra === undefined) break;
      if (!c.responseExtras.length) break;
      const extra = c.responseExtras.shift();
      h.responseExtra = false;
      if (h.done) continue;
      h.record.response_headers = pairs(extra.headers);
      h.record.response_headers_raw =
        typeof extra.headersText === "string" ? extra.headersText : null;
      h.record.response_content_type =
        h.record.response_headers.find(
          (header) => header.name.toLowerCase() === "content-type",
        )?.value ?? h.record.response_content_type;
      if (Number.isFinite(extra.statusCode))
        h.record.status_code = Number(extra.statusCode);
      if (h.record.response_metadata) {
        if (typeof extra.resourceIPAddressSpace === "string")
          h.record.response_metadata.resource_ip_address_space =
            extra.resourceIPAddressSpace;
        if (Array.isArray(extra.blockedCookies))
          h.record.response_metadata.blocked_cookies = extra.blockedCookies;
      }
      h.record.capture_status.response_headers = {
        state: "complete",
        reason: "CDP 响应 ExtraInfo 可观测头；原始头文本在可用时一并保存",
      };
    }
  }
  finish(h: Hop) {
    if (h.finishing) return;
    h.finishing = true;
    this.finalizers++;
    const grace = new Promise((r) => setTimeout(r, 250));
    this.tail = this.tail
      .then(async () => {
        await Promise.all([h.body, h.responseBody, h.stack]);
        await grace;
        await this.finalize(h);
      })
      .catch((e) => {
        this.failure = String(e);
        if (this.scan) {
          gap(this.scan, "processing", "请求处理或持久化失败；保留待写记录");
          this.scan.state = "paused";
        }
      })
      .finally(() => this.finalizers--);
  }
  async finalize(h: Hop) {
    if (h.done || !this.scan) return;
    const scan = this.scan,
      r = h.record;
    const config = scan.versions.find(
      (v) => v.version === r.filter_version,
    )!.config;
    if (["failed", "incomplete"].includes(r.request_state)) {
      for (const [carrier, label] of [
        ["response_headers", "响应头"],
        ["response_body", "响应体"],
        ["response_metadata", "响应元数据"],
      ] as const) {
        const quality = r.capture_status[carrier];
        if (quality?.state === "missing" && quality.reason?.startsWith("尚未"))
          r.capture_status[carrier] = {
            state: "missing",
            reason: `请求${r.request_state === "failed" ? "失败" : "未完成"}，${label}未取得`,
          };
      }
    }
    const hits: Record<string, number> = {};
    r.filter_result ??= matchFilter(config.filter, r, true, hits);
    for (const [key, count] of Object.entries(hits)) {
      const name = `v${r.filter_version}.${key}`;
      scan.rule_hits[name] = (scan.rule_hits[name] ?? 0) + count;
    }
    scan.stats[r.filter_result]++;
    scan.stats.pending--;
    h.done = true;
    if (savedFieldSet(config).has("initiator"))
      this.initiatorNodes.push({
        scan_id: r.scan_id,
        request_id: r.request_id,
        request_url: safeURL(
          r.request_url,
          config.value_storage !== "complete",
        ),
        parent_id: r.initiator_parent_id ?? null,
        resolution: r.initiator_parent_match ?? "none",
        relation: r.initiator_relation ?? "none",
      });
    if (r.filter_result === "excluded" && config.retention === "matching") {
      this.checkStorageLimit(config);
      if (this.initiatorNodes.length >= 200) await this.flush();
      return;
    }
    const safe = protectRecord(
      selectRecordFields(r, config),
      config.value_storage !== "complete",
    );
    for (const [carrier, status] of Object.entries(safe.capture_status))
      if (
        status.state !== "complete" &&
        !status.reason?.startsWith("任务未选择保存")
      )
        gap(
          scan,
          "capture_" + carrier,
          status.reason ?? status.state,
          safe.request_id,
        );
    if (config.merge !== "none") {
      try {
        const fp = await fingerprint(safe, config);
        safe.group_id = fp.id;
        safe.normalized_url = fp.normalized_url;
        let g =
          this.groups.get(fp.id) ?? (await db.get<Group>("groups", fp.id));
        if (!g) {
          g = {
            id: fp.id,
            scan_id: scan.id,
            key: fp.key,
            representative_id: safe.request_id,
            normalized_url: fp.normalized_url,
            count: 0,
            first: safe.timestamp,
            last: safe.timestamp,
            candidate: fp.candidate,
            changes: [],
          };
          scan.stats.groups++;
        }
        g.count++;
        g.first = g.first < safe.timestamp ? g.first : safe.timestamp;
        g.last = g.last > safe.timestamp ? g.last : safe.timestamp;
        if (g.count > 1) {
          const representative =
            this.entries.find((r) => r.request_id === g!.representative_id) ??
            (await db.get<RecordEntry>("requests", g.representative_id));
          if (representative) {
            for (const field of [
              "request_url",
              "request_body",
              "query_params",
              "request_headers",
              "page_url",
              "initiator_stack",
            ] as const)
              if (
                JSON.stringify(representative[field]) !==
                  JSON.stringify(safe[field]) &&
                !g.changes.includes(field)
              )
                g.changes.push(field);
          }
        }
        if (config.merge === "representative" && g.count > 1) {
          g.changes = Array.from(
            new Set([
              ...g.changes,
              "有损：仅保留代表请求，动态值/逐次栈及页面无法恢复",
            ]),
          );
          this.groups.set(g.id, g);
          return;
        }
        this.groups.set(g.id, g);
      } catch {
        delete safe.group_id;
        delete safe.normalized_url;
        gap(
          scan,
          "grouping_failure",
          "分组索引读取或计算失败；原始请求仍待写入",
          safe.request_id,
        );
        scan.state = "paused";
      }
    }
    safe.ordinal = scan.stats.persisted + this.entries.length + 1;
    this.entries.push(safe);
    // Keep redirect/ExtraInfo ordering metadata without retaining another copy of large bodies.
    h.record = {
      ...safe,
      request_body: { representation: "released", parsed: null },
      request_headers: [],
      query_params: [],
      initiator_stack: null,
    };
    this.checkStorageLimit(config);
    if (this.entries.length >= 200 || this.initiatorNodes.length >= 200)
      await this.flush();
  }
  pendingCount() {
    return (
      [...this.channels.values()].reduce(
        (n, c) => n + c.hops.filter((h) => !h.done).length,
        0,
      ) + this.entries.length
    );
  }
  estimateBytes() {
    let n = this.bufferedPersistBytes();
    for (const c of this.channels.values())
      for (const h of c.hops)
        if (!h.done)
          n += new TextEncoder().encode(JSON.stringify(h.record)).length;
    return n;
  }
  bufferedPersistBytes() {
    const encoder = new TextEncoder();
    return [...this.entries, ...this.initiatorNodes].reduce(
      (sum, value) => sum + encoder.encode(JSON.stringify(value)).length,
      0,
    );
  }
  checkStorageLimit(config: Config) {
    if (!this.scan) return;
    const projectedBytes = this.scan.stats.bytes + this.bufferedPersistBytes();
    if (
      projectedBytes >= config.storage_limit * 0.8 &&
      !this.scan.gaps.some((g) => g.type === "storage_warning")
    )
      gap(this.scan, "storage_warning", "本任务数据达到配置容量的 80%");
    if (projectedBytes >= config.storage_limit)
      this.protect("本任务达到容量上限", 0);
  }
  protect(reason: string, lost: number) {
    if (!this.scan) return;
    this.scan.stats.lost += lost;
    gap(this.scan, "backpressure", reason, undefined, lost);
    this.scan.state = "paused";
  }
  async flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.write();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }
  async write() {
    if (!this.scan) return;
    this.writing = true;
    try {
      const scan = this.scan;
      scan.heartbeat = now();
      const entries = this.entries.slice();
      const groups = new Map(
        [...this.groups].map(([id, g]) => [id, structuredClone(g)]),
      );
      const active = [...this.channels.values()].flatMap((c) =>
        c.hops
          .filter((h) => !h.done)
          .map((h) => {
            const config = scan.versions.find(
              (version) => version.version === h.record.filter_version,
            )?.config;
            const effective = config ?? defaults();
            return protectRecord(
              selectRecordFields(h.record, effective),
              effective.value_storage !== "complete",
            );
          }),
      );
      const initiatorNodes = this.initiatorNodes.slice();
      const snapshot = structuredClone(scan);
      const bytes = [...entries, ...initiatorNodes].reduce(
        (n, value) =>
          n + new TextEncoder().encode(JSON.stringify(value)).length,
        0,
      );
      snapshot.stats.persisted += entries.length;
      snapshot.stats.bytes += bytes;
      await db.commit(snapshot, entries, groups, active, initiatorNodes);
      scan.stats.persisted += entries.length;
      scan.stats.bytes += bytes;
      this.entries.splice(0, entries.length);
      this.initiatorNodes.splice(0, initiatorNodes.length);
      for (const [id, g] of groups)
        if (this.groups.get(id)?.count === g.count) this.groups.delete(id);
      if (scan.gaps.length > 200) scan.gaps.splice(0, scan.gaps.length - 100);
      this.failure = "";
    } catch (e) {
      this.failure = "IndexedDB 写入失败，数据仍在待写队列";
      if (this.scan) {
        gap(this.scan, "storage_failure", this.failure);
        this.scan.state = "paused";
      }
      throw e;
    } finally {
      this.writing = false;
    }
  }
  async pause() {
    if (!this.scan || this.scan.state !== "recording")
      throw Error("只有采集中的任务可以暂停");
    this.scan.state = "paused";
    gap(this.scan, "pause", "用户暂停：新请求不纳入；在途关联继续处理");
    await this.flush();
  }
  async resume() {
    if (!this.scan || !["paused", "interrupted"].includes(this.scan.state))
      throw Error("任务不可恢复");
    for (const g of this.scan.gaps)
      if (
        ["pause", "backpressure", "debugger_detach"].includes(g.type) &&
        !g.end
      )
        g.end = now();
    gap(this.scan, "resume", "恢复采集；之前中断窗口不计入已采集范围");
    this.scan.state = "recording";
    await this.flush();
  }
  async update(config: Config) {
    if (
      !this.scan ||
      !["recording", "paused", "interrupted"].includes(this.scan.state)
    )
      throw Error("当前任务状态不能修改配置");
    this.scan.config = structuredClone(config);
    this.scan.versions.push({
      version: this.scan.versions.length + 1,
      effective_at: now(),
      config: structuredClone(config),
    });
    await this.flush();
  }
  async stop() {
    if (!this.scan || this.scan.state === "ended") return;
    if (this.scan.state === "draining") throw Error("任务正在收尾，请等待完成");
    this.scan.state = "draining";
    await this.flush();
    const until = Date.now() + this.scan.config.stop_wait_ms;
    while (this.scan.stats.pending > 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50));
    for (const c of this.channels.values())
      for (const h of c.hops)
        if (!h.done && !h.finishing) {
          h.record.request_state = "incomplete";
          h.record.error = "停止等待超时，未观测到终态";
          gap(this.scan, "unfinished", h.record.error, h.record.request_id);
          this.finish(h);
        }
    await this.tail;
    await this.flush();
    if (this.failure) throw Error(this.failure);
    this.scan.state = "ended";
    this.scan.ended_at = now();
    await this.flush();
    this.channels.clear();
    this.observedByURL.clear();
    this.observedByCdpId.clear();
  }
}
