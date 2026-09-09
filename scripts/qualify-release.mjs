#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as zlib from "node:zlib";
import { computeQualificationInputs, QUALIFICATION_TEST_FILES } from "./lib/release-qualification-inputs.mjs";
import { qualifyWithCache } from "./lib/release-qualification-cache.mjs";
import { operationError } from "./lib/release-operation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ADMISSION_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC",
  NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "test", UV_THREADPOOL_SIZE: "4" });
const TIMEOUT = 180_000;

export function parseQualificationArgs(argv) {
  const options = { mode: argv[0] ?? "inspect", cacheDirectory: resolve(ROOT, ".release-build/qualification"), refresh: false, timeoutMs: TIMEOUT };
  if (!["inspect", "run"].includes(options.mode)) throw operationError("RELEASE_QUALIFICATION_USAGE");
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) throw operationError("RELEASE_QUALIFICATION_USAGE");
    seen.add(flag);
    if (flag === "--refresh") { options.refresh = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("-") || value.includes("\0")) throw operationError("RELEASE_QUALIFICATION_USAGE");
    if (flag === "--cache") options.cacheDirectory = resolve(value);
    else if (flag === "--timeout-ms" && /^\d+$/.test(value)) options.timeoutMs = Number(value);
    else throw operationError("RELEASE_QUALIFICATION_USAGE");
  }
  if ((options.mode === "inspect" && options.refresh) || !Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1000 || options.timeoutMs > TIMEOUT) throw operationError("RELEASE_QUALIFICATION_USAGE");
  return options;
}

export function parseAdmissionTap(output, exitCode, durationMs) {
  const result = { exitCode: exitCode === 0 ? 0 : 1, durationMs: Math.round(durationMs) };
  for (const [field, label] of [["tests", "tests"], ["passed", "pass"], ["failed", "fail"], ["skipped", "skipped"], ["cancelled", "cancelled"], ["todo", "todo"]]) {
    const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))];
    if (matches.length !== 1) throw operationError("RELEASE_QUALIFICATION_SUMMARY_INVALID");
    result[field] = Number(matches[0][1]);
  }
  return result;
}

export async function runAdmissionTests({ repositoryRoot = ROOT, runDirectory, timeoutMs = TIMEOUT, spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > TIMEOUT) throw operationError("RELEASE_QUALIFICATION_TIMEOUT_INVALID");
  const started = performance.now();
  // Test HOME and scratch space are private synthetic locations, never the
  // real user's configuration. No NODE_OPTIONS, npm hooks or secrets inherited.
  const home = join(runDirectory, "home");
  const scratch = join(runDirectory, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const environment = { ...ADMISSION_ENVIRONMENT, HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  return await new Promise((accept, reject) => {
    let output = "", bytes = 0, failure = null, settled = false;
    const child = spawnProcess(process.execPath, ["--import=data:text/javascript,process.umask(0o022)", "--test", "--test-concurrency=1", "--test-reporter=tap", ...QUALIFICATION_TEST_FILES],
      { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(reapTimer);
      if (error) reject(error); else accept(result);
    };
    let reapTimer;
    const stop = (code) => {
      if (failure) return;
      failure = operationError(code);
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
      reapTimer = setTimeout(() => finish(operationError("RELEASE_QUALIFICATION_TERMINATION_UNCONFIRMED")), 5000);
    };
    const timer = setTimeout(() => stop("RELEASE_QUALIFICATION_TIMEOUT"), timeoutMs);
    child.on("error", () => finish(operationError("RELEASE_QUALIFICATION_CHILD_FAILED")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) stop("RELEASE_QUALIFICATION_OUTPUT_LIMIT"); else output += chunk; });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop("RELEASE_QUALIFICATION_OUTPUT_LIMIT"); });
    child.on("close", (code) => {
      if (failure) return finish(failure);
      try { finish(null, parseAdmissionTap(output, code, performance.now() - started)); }
      catch { finish(operationError("RELEASE_QUALIFICATION_SUMMARY_INVALID")); }
    });
  });
}

export async function main(argv) {
  const options = parseQualificationArgs(argv);
  if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.zstdDecompressSync !== "function") throw operationError("RELEASE_QUALIFICATION_RUNTIME_UNSUPPORTED");
  const summary = await qualifyWithCache({ ...options, inspect: options.mode === "inspect",
    computeInputs: () => computeQualificationInputs({ repositoryRoot: ROOT, environment: { ...ADMISSION_ENVIRONMENT, timeoutMs: String(options.timeoutMs), umask: "0022" } }),
    execute: async () => {
      // Cache ownership has already validated the canonical private parent.
      const directory = await realpath(await mkdtemp(join(options.cacheDirectory, "run-")));
      return runAdmissionTests({ runDirectory: directory, timeoutMs: options.timeoutMs });
    },
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (["failed", "not_run", "run_required"].includes(summary.status)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${/^RELEASE_QUALIFICATION_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "RELEASE_QUALIFICATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
