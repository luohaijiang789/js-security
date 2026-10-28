import { analyze } from "./analyzer.js";
import { performance } from "node:perf_hooks";
const [root, mode, maxSteps] = process.argv.slice(2),
  config = { maxSteps: Number(maxSteps), maxCandidates: 8 };
if (mode === "warm") await analyze(root, config);
const start = performance.now(),
  report = await analyze(root, config);
console.log(
  JSON.stringify({
    mode,
    elapsedMs: performance.now() - start,
    peakProcessRssKiB: process.resourceUsage().maxRSS,
    files: report.stats.files,
    steps: report.stats.steps,
    complete: report.stats.complete,
    endpoints: report.endpoints.length,
    diagnostics: report.diagnostics.length,
    config,
  }),
);
