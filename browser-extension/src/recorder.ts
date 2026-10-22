import {
  defaults,
  gap,
  now,
  uid,
  type Scan,
  type RecordEntry,
  type Config,
  type Group,
} from "./model";
import { matchFilter } from "./filter";
import { parseBody, protectRecord, safeURL } from "./privacy";
import { fingerprint } from "./group";
import * as db from "./store";
import { StackCapture } from "./stack";
type Source = chrome.debugger.DebuggerSession;
type Hop = {
  record: RecordEntry;
  extra?: boolean;
  body?: Promise<void>;
  stack?: Promise<void>;
  done?: boolean;
  finishing?: boolean;
};
type Channel = {
  hops: Hop[];
  extras: any[];
  source: Source;
  suppressed?: boolean;
};
const pairs = (h: Record<string, string> = {}) =>
  Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
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
      tabs: tabs.map((t) => ({ ...t, url: safeURL(t.url) })),
      config: structuredClone(config),
      versions: [
        { version: 1, effective_at: time, config: structuredClone(config) },
      ],
      browser: navigator.userAgent,
      plugin: "0.2.1",
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
    this.entries = [];
    this.groups.clear();
    this.connection = uid();
    await db.put("scans", this.scan);
    return this.scan;
  }
  includeTab(tab: { id: number; url: string }) {
    if (!this.scan) return;
    const previous = this.scan.tabs.find((t) => t.id === tab.id);
    if (previous) previous.url = safeURL(tab.url);
    else this.scan.tabs.push({ id: tab.id, url: safeURL(tab.url) });
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
      if (p.redirectResponse && channel) {
        const previous = channel.hops.at(-1);
        if (previous) {
          previous.extra = !!p.redirectHasExtraInfo;
          previous.record.status_code = p.redirectResponse.status;
          previous.record.request_state = "redirect";
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
      channel ??= { hops: [], extras: [], source };
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
      );
      const stack = this.stacks.snapshot(p.initiator?.stack),
        initiator =
          p.initiator?.url ?? p.initiator?.stack?.callFrames?.[0]?.url ?? null;
      const hop = channel.hops.length;
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
        initiator_url: initiator,
        initiator_stack: stack,
        capture_status: {
          headers: {
            state: "partial",
            reason: "等待 ExtraInfo；CDP 可能不提供完整线头",
          },
          body: parsed.quality,
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
          version: "sensitive-v1",
          redacted: false,
          truncated: parsed.truncated,
        },
        filter_version: scan.versions.at(-1)!.version,
      };
      const h: Hop = { record: r };
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
        channel = { hops: [], extras: [], source };
        this.channels.set(key, channel);
        setTimeout(() => {
          if (channel && !channel.hops.length) this.channels.delete(key);
        }, 2000);
      }
      if (channel.extras.length < 16) channel.extras.push(p);
      else this.protect("ExtraInfo 队列达到上限", 1);
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
      h.record.status_code = p.response.status;
      h.extra = !!p.hasExtraInfo;
      this.applyExtras(channel);
    }
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      h.record.request_state = method.endsWith("Failed")
        ? "failed"
        : "complete";
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
  applyExtras(c: Channel) {
    for (const h of c.hops) {
      if (h.extra === false) continue;
      if (h.extra === undefined) break;
      if (c.extras.length) {
        const extra = c.extras.shift();
        h.extra = false;
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
          );
          h.record.request_body = { ...parsed.body, raw };
          h.record.content_type = ct;
          h.record.capture_status.body = parsed.quality;
        }
      } else break;
    }
  }
  finish(h: Hop) {
    if (h.finishing) return;
    h.finishing = true;
    this.finalizers++;
    const grace = new Promise((r) => setTimeout(r, 250));
    this.tail = this.tail
      .then(async () => {
        await Promise.all([h.body, h.stack]);
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
    const hits: Record<string, number> = {};
    r.filter_result ??= matchFilter(config.filter, r, true, hits);
    for (const [key, count] of Object.entries(hits)) {
      const name = `v${r.filter_version}.${key}`;
      scan.rule_hits[name] = (scan.rule_hits[name] ?? 0) + count;
    }
    scan.stats[r.filter_result]++;
    scan.stats.pending--;
    h.done = true;
    if (r.filter_result === "excluded" && config.retention === "matching")
      return;
    const safe = protectRecord(r);
    for (const [carrier, status] of Object.entries(safe.capture_status))
      if (status.state !== "complete")
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
    const projectedBytes =
      scan.stats.bytes +
      this.entries.reduce(
        (n, r) => n + new TextEncoder().encode(JSON.stringify(r)).length,
        0,
      );
    if (
      projectedBytes >= config.storage_limit * 0.8 &&
      !scan.gaps.some((g) => g.type === "storage_warning")
    )
      gap(scan, "storage_warning", "本任务数据达到配置容量的 80%");
    if (projectedBytes >= config.storage_limit)
      this.protect("本任务达到容量上限", 0);
    if (this.entries.length >= 200) await this.flush();
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
    let n = this.entries.reduce(
      (sum, r) => sum + new TextEncoder().encode(JSON.stringify(r)).length,
      0,
    );
    for (const c of this.channels.values())
      for (const h of c.hops)
        if (!h.done)
          n += new TextEncoder().encode(JSON.stringify(h.record)).length;
    return n;
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
        c.hops.filter((h) => !h.done).map((h) => protectRecord(h.record)),
      );
      const snapshot = structuredClone(scan);
      const bytes = entries.reduce(
        (n, r) => n + new TextEncoder().encode(JSON.stringify(r)).length,
        0,
      );
      snapshot.stats.persisted += entries.length;
      snapshot.stats.bytes += bytes;
      await db.commit(snapshot, entries, groups, active);
      scan.stats.persisted += entries.length;
      scan.stats.bytes += bytes;
      this.entries.splice(0, entries.length);
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
  }
}
