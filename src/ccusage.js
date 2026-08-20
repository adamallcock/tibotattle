import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The app's Keychain broker announcement names a descriptor in *this* process,
// and this child's descriptor 0 is /dev/null. No secret leaks — the child
// cannot reach the socketpair — but an announcement that resolves to an
// unrelated descriptor is a trap for anything downstream that trusts it, so
// the key never crosses the spawn.
const KEYCHAIN_BROKER_FD_ENV = "USAGE_MONITOR_KEYCHAIN_BROKER_FD";

export function ccusageChildEnv(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment[KEYCHAIN_BROKER_FD_ENV];
  return childEnvironment;
}

export function runCcusageCodexDaily({ since, until, timezone = "UTC", offline = false }) {
  const cli = require.resolve("ccusage/src/cli.js");
  const args = [cli, "codex", "daily", "--since", since, "--until", until, "--timezone", timezone, "--json"];
  if (offline) args.push("--offline");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: ccusageChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`ccusage failed (${code ?? signal}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`ccusage returned invalid JSON: ${error.message}`));
      }
    });
  });
}

export function summarizeCcusage(report) {
  const byModel = {};
  for (const day of report.daily ?? []) {
    for (const [model, usage] of Object.entries(day.models ?? {})) {
      const target = byModel[model] ??= {
        inputUncachedTokens: 0,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        fallbackModel: false,
      };
      target.inputUncachedTokens += usage.inputTokens ?? 0;
      target.inputCacheReadTokens += usage.cacheReadTokens ?? 0;
      target.inputCacheWriteTokens += usage.cacheCreationTokens ?? 0;
      target.outputTokens += usage.outputTokens ?? 0;
      target.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
      target.totalTokens += usage.totalTokens ?? 0;
      target.fallbackModel ||= usage.isFallback === true;
    }
  }
  return {
    totals: {
      inputUncachedTokens: report.totals?.inputTokens ?? 0,
      inputCacheReadTokens: report.totals?.cacheReadTokens ?? 0,
      inputCacheWriteTokens: report.totals?.cacheCreationTokens ?? 0,
      outputTokens: report.totals?.outputTokens ?? 0,
      reasoningOutputTokens: report.totals?.reasoningOutputTokens ?? 0,
      totalTokens: report.totals?.totalTokens ?? 0,
      costUsd: report.totals?.costUSD ?? null,
    },
    byModel,
    daily: (report.daily ?? []).map((day) => ({
      date: day.date,
      totalTokens: day.totalTokens,
      costUsd: day.costUSD,
    })),
    limitations: [
      "ccusage JSON reports cacheCreationTokens as zero for Codex 20.0.18 even when the local schema has a cache-write field",
      "ccusage cost uses standard API pricing and is not provider subscription accounting",
    ],
  };
}
