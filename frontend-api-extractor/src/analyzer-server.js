import { importObservedScripts } from "./observed-scripts.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { collectScripts, analyzeScriptPackage } from "./script-assets.js";
import { writeDelivery } from "./delivery-cli.js";
export function createAnalyzerServer({
  origin,
  token,
  allowedHosts,
  workDir,
  collectorOptions = {},
}) {
  const parsed = new URL(origin);
  if (
    !["chrome-extension:", "http:", "https:"].includes(parsed.protocol) ||
    (parsed.protocol === "http:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)) ||
    typeof token !== "string" ||
    token.length < 16 ||
    !Array.isArray(allowedHosts) ||
    !allowedHosts.length
  )
    throw new Error("服务需明确Origin、至少16字符令牌和获取主机范围");
  const jobs = new Map();
  let active = false;
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    if (req.headers.origin !== origin) {
      respond(403, { error: "Origin不在授权范围" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Analyzer-Token",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const supplied = Buffer.from(String(req.headers["x-analyzer-token"] ?? "")),
      expected = Buffer.from(token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      respond(401, { error: "分析服务令牌无效" });
      return;
    }
    try {
      if (req.method === "POST" && ["/jobs", "/packages"].includes(req.url)) {
        if (active || jobs.size >= 20) {
          respond(429, { error: "服务正忙或任务记录已达上限" });
          return;
        }
        if (
          !String(req.headers["content-type"]).startsWith("application/json")
        ) {
          respond(415, { error: "需要JSON输入" });
          return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > (req.url === "/packages" ? 32 * 1024 * 1024 : 32768)) {
            respond(413, { error: "请求过大" });
            return;
          }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")),
          url = req.url === "/jobs" ? new URL(input.pageUrl) : null;
        if (url && !allowedHosts.includes(url.hostname)) {
          respond(403, { error: "页面主机不在服务获取范围" });
          return;
        }
        if (
          !Number.isInteger(input.maxDepth ?? 3) ||
          (input.maxDepth ?? 3) < 0 ||
          (input.maxDepth ?? 3) > 3
        ) {
          respond(400, { error: "探索深度范围为0..3" });
          return;
        }
        const id = randomUUID(),
          directory = path.join(path.resolve(workDir), id),
          job = {
            id,
            state: "running",
            phase: "collecting",
            startedAt: new Date().toISOString(),
          };
        jobs.set(id, job);
        active = true;
        const persist = async () => {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(
            path.join(directory, "job.json"),
            JSON.stringify(job, null, 2),
          );
        };
        void (async () => {
          try {
            await persist();
            const manifest = url
              ? await collectScripts(url.href, directory, {
                  ...collectorOptions,
                  allowedHosts,
                  mode: "website",
                  maxDepth: input.maxDepth ?? 3,
                })
              : await importObservedScripts(input.snapshot, directory);
            job.phase = "analyzing";
            await persist();
            const report = await analyzeScriptPackage(directory, manifest);
            job.phase = "exporting";
            await persist();
            await fs.writeFile(
              path.join(directory, "raw-analysis.json"),
              JSON.stringify(report, null, 2),
            );
            const d = await writeDelivery(report, directory);
            Object.assign(job, {
              state: "completed",
              phase: "completed",
              records: d.records.length,
              assets: manifest.assets.length,
              complete: d.scope.complete,
              finishedAt: new Date().toISOString(),
            });
          } catch (error) {
            Object.assign(job, {
              state: "failed",
              phase: "failed",
              error: error.message,
              finishedAt: new Date().toISOString(),
            });
          } finally {
            active = false;
            await persist();
          }
        })().catch(() => {
          active = false;
        });
        respond(202, { id, state: job.state });
        return;
      }
      const match =
        /^\/jobs\/([0-9a-f-]{36})(?:\/artifacts\/(analysis\.json|api_assets\.xlsx|assets-manifest\.json|raw-analysis\.json))?$/.exec(
          req.url ?? "",
        );
      if (req.method === "GET" && match) {
        const job = jobs.get(match[1]);
        if (!job) {
          respond(404, { error: "任务不存在" });
          return;
        }
        if (!match[2]) {
          respond(200, job);
          return;
        }
        if (job.state !== "completed") {
          respond(409, { error: "任务尚未完成" });
          return;
        }
        const data = await fs.readFile(
          path.join(path.resolve(workDir), job.id, match[2]),
        );
        res.writeHead(200, {
          "Content-Type": match[2].endsWith(".xlsx")
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(data);
        return;
      }
      respond(404, { error: "接口不存在" });
    } catch {
      respond(400, { error: "请求或任务读取失败" });
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  return server;
}
