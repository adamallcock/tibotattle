import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";

export const R7_WORKER_WATCHDOG_VERSION = "g1-r7-worker-watchdog-v0.1";
export const R7_WORKER_RSS_SAMPLE_INTERVAL_MS = 100;
export const R7_WORKER_MAXIMUM_STDOUT_BYTES = 256 * 1024;
export const R7_WORKER_MAXIMUM_STDERR_BYTES = 256 * 1024;
export const R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES = 1024 * 1024;
export const R7_WORKER_MAXIMUM_STDIN_BYTES = 32 * 1024 * 1024;
export const R7_WORKER_TERMINATION_GRACE_MS = 2_000;
export const R7_WORKER_MAXIMUM_TIMEOUT_MS = 10 * 60 * 1_000;

export const R7_WORKER_WATCHDOG_OUTCOMES = Object.freeze([
  "completed",
  "spawn_failed",
  "worker_failed",
  "timed_out",
  "stdout_limit_exceeded",
  "stderr_limit_exceeded",
  "rss_limit_exceeded",
  "stdout_rejected",
  "termination_unconfirmed",
  "unsupported_platform",
]);

export const R7_WORKER_TERMINATIONS = Object.freeze([
  "clean",
  "nonzero",
  "signaled",
  "sigkill",
  "spawn_error",
  "not_started",
  "timed_out",
  "stdout_limit_exceeded",
  "stderr_limit_exceeded",
  "rss_limit_exceeded",
  "worker_failed",
]);

export const R7_WORKER_RSS_SAMPLE_OUTCOMES = Object.freeze([
  "sampled",
  "process_missing",
  "unavailable",
  "unsupported_platform",
]);

const CHILD_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
const MAXIMUM_PS_OUTPUT_BYTES = 1_024;
const PS_TIMEOUT_MS = 1_000;

function fixedEnvironment() {
  return { ...CHILD_ENVIRONMENT };
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function saturatedAdd(left, right) {
  if (!Number.isSafeInteger(right) || right < 0) return Number.MAX_SAFE_INTEGER;
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function elapsedMilliseconds(startedAtNs, nowNs) {
  const elapsed = nowNs > startedAtNs ? nowNs - startedAtNs : 0n;
  return Number((elapsed + 999_999n) / 1_000_000n);
}

function fixedResult({
  outcome,
  termination,
  startedAtNs,
  nowNs,
  peakRssBytes,
  rssSampleCount,
  rssSampleFailureCount,
  stdoutBytes,
  stderrBytes,
}) {
  return {
    watchdogVersion: R7_WORKER_WATCHDOG_VERSION,
    outcome,
    termination,
    elapsedMs: elapsedMilliseconds(startedAtNs, nowNs),
    peakRssBytes,
    rssSampleCount,
    rssSampleFailureCount,
    rssMeasurementStatus: rssSampleCount > 0 ? "sampled" : "unavailable",
    rssSamplingIntervalMs: R7_WORKER_RSS_SAMPLE_INTERVAL_MS,
    stdoutBytes,
    stderrBytes,
  };
}

function validateAbsolutePath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function normalizeInput(input) {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input);
  throw new TypeError("R7 worker input must be bytes or a string");
}

function normalizeRequest(request, hardMaximumRssBytes) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("R7 worker request must be an object");
  }
  const runtimeExecutable = validateAbsolutePath(request.runtimeExecutable, "runtimeExecutable");
  const workerPath = validateAbsolutePath(request.workerPath, "workerPath");
  const cwd = validateAbsolutePath(request.cwd, "cwd");
  const input = normalizeInput(request.input);
  const maximumStdinBytes = request.maximumStdinBytes
    ?? R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES;
  if (!Number.isSafeInteger(maximumStdinBytes) || maximumStdinBytes < 1
      || maximumStdinBytes > R7_WORKER_MAXIMUM_STDIN_BYTES) {
    throw new RangeError("maximumStdinBytes is outside its fixed range");
  }
  if (input.length > maximumStdinBytes) {
    throw new RangeError("R7 worker input exceeds its selected byte limit");
  }
  const timeoutMs = request.timeoutMs ?? R7_WORKER_MAXIMUM_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > R7_WORKER_MAXIMUM_TIMEOUT_MS) {
    throw new RangeError("R7 worker timeout is outside its fixed range");
  }
  if (request.consumeStdout !== undefined && typeof request.consumeStdout !== "function") {
    throw new TypeError("consumeStdout must be a function when provided");
  }
  if (request.requireLifetimePeakRss !== undefined
      && typeof request.requireLifetimePeakRss !== "boolean") {
    throw new TypeError("requireLifetimePeakRss must be a boolean when provided");
  }
  if (request.requireLifetimePeakRss === true && request.consumeStdout === undefined) {
    throw new TypeError("requireLifetimePeakRss requires consumeStdout");
  }
  if (!Number.isSafeInteger(hardMaximumRssBytes) || hardMaximumRssBytes < 1) {
    throw new TypeError("hardMaximumRssBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.maximumRssBytes) || request.maximumRssBytes < 1) {
    throw new TypeError("maximumRssBytes must be a positive safe integer");
  }
  if (request.maximumRssBytes > hardMaximumRssBytes) {
    throw new RangeError("maximumRssBytes exceeds the R7 watchdog hard maximum");
  }
  return {
    runtimeExecutable,
    workerPath,
    cwd,
    input,
    maximumStdinBytes,
    timeoutMs,
    maximumRssBytes: request.maximumRssBytes,
    consumeStdout: request.consumeStdout,
    requireLifetimePeakRss: request.requireLifetimePeakRss === true,
  };
}

function sampleResult(status, rssBytes = null) {
  return { status, rssBytes };
}

/**
 * Sample one direct child process on the first-release platform. `ps` reports
 * RSS in KiB on Darwin. No shell or inherited environment is involved.
 */
export async function sampleDarwinArm64ChildRss(pid, {
  platform = process.platform,
  architecture = process.arch,
  execFileProcess = execFile,
} = {}) {
  if (platform !== "darwin" || architecture !== "arm64") {
    return sampleResult("unsupported_platform");
  }
  if (!validPid(pid)) return sampleResult("unavailable");
  return new Promise((resolve) => {
    let completed = false;
    const finish = (value) => {
      if (completed) return;
      completed = true;
      resolve(value);
    };
    try {
      execFileProcess(
        "/bin/ps",
        ["-o", "rss=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: fixedEnvironment(),
          maxBuffer: MAXIMUM_PS_OUTPUT_BYTES,
          timeout: PS_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            finish(sampleResult(error?.code === 1 ? "process_missing" : "unavailable"));
            return;
          }
          const value = typeof stdout === "string" ? stdout.trim() : "";
          if (!/^[0-9]+$/.test(value)) {
            finish(sampleResult(value.length === 0 ? "process_missing" : "unavailable"));
            return;
          }
          const kibibytes = Number(value);
          const bytes = kibibytes * 1_024;
          if (!Number.isSafeInteger(bytes) || bytes < 0) {
            finish(sampleResult("unavailable"));
            return;
          }
          finish(sampleResult("sampled", bytes));
        },
      );
    } catch {
      finish(sampleResult("unavailable"));
    }
  });
}

/**
 * Run one R7 worker under a bounded parent watchdog. The returned value is
 * aggregate-only. A caller that needs the worker's bounded JSON may consume it
 * synchronously with `consumeStdout`; the bytes are never returned or retained
 * after settlement. Stderr is counted and discarded without being exposed.
 * RSS enforcement covers the direct child PID only, not descendants. When
 * `requireLifetimePeakRss` is selected, `consumeStdout` must synchronously
 * return the worker's positive `process.resourceUsage().maxRSS` converted
 * to bytes. That lifetime high-water mark is enforced after a clean close, so
 * a short-lived peak cannot pass merely because periodic sampling missed it.
 */
export async function runR7WorkerWatchdog(request, {
  platform = process.platform,
  architecture = process.arch,
  spawnProcess = spawn,
  sampleRss = sampleDarwinArm64ChildRss,
  monotonicNow = process.hrtime.bigint,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  scheduleInterval = setInterval,
  cancelInterval = clearInterval,
  hardMaximumRssBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
} = {}) {
  const normalized = normalizeRequest(request, hardMaximumRssBytes);
  const startedAtNs = monotonicNow();
  if (typeof startedAtNs !== "bigint") throw new TypeError("monotonicNow must return nanoseconds as bigint");
  if (platform !== "darwin" || architecture !== "arm64") {
    return fixedResult({
      outcome: "unsupported_platform",
      termination: "not_started",
      startedAtNs,
      nowNs: monotonicNow(),
      peakRssBytes: 0,
      rssSampleCount: 0,
      rssSampleFailureCount: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  }

  let child;
  try {
    child = spawnProcess(normalized.runtimeExecutable, [normalized.workerPath], {
      cwd: normalized.cwd,
      env: fixedEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return fixedResult({
      outcome: "spawn_failed",
      termination: "not_started",
      startedAtNs,
      nowNs: monotonicNow(),
      peakRssBytes: 0,
      rssSampleCount: 0,
      rssSampleFailureCount: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let forcedOutcome = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let peakRssBytes = 0;
    let rssSampleCount = 0;
    let rssSampleFailureCount = 0;
    let sampleInFlight = null;
    let deadlineHandle = null;
    let sampleHandle = null;
    let terminationHandle = null;
    const deadlineNs = startedAtNs + (BigInt(normalized.timeoutMs) * 1_000_000n);

    const clearScheduledWork = () => {
      if (deadlineHandle !== null) cancelTimeout(deadlineHandle);
      if (sampleHandle !== null) cancelInterval(sampleHandle);
      if (terminationHandle !== null) cancelTimeout(terminationHandle);
      deadlineHandle = null;
      sampleHandle = null;
      terminationHandle = null;
    };

    const observeRss = () => {
      if (settled || sampleInFlight || !validPid(child?.pid)) return;
      sampleInFlight = Promise.resolve()
        .then(() => sampleRss(child.pid, { platform, architecture }))
        .then((sample) => {
          if (sample?.status === "sampled" && Number.isSafeInteger(sample.rssBytes)
              && sample.rssBytes >= 0) {
            rssSampleCount += 1;
            peakRssBytes = Math.max(peakRssBytes, sample.rssBytes);
            if (sample.rssBytes > normalized.maximumRssBytes) {
              forceTermination("rss_limit_exceeded");
            }
          } else {
            rssSampleFailureCount += 1;
          }
        }, () => {
          rssSampleFailureCount += 1;
        })
        .finally(() => { sampleInFlight = null; });
    };

    const finish = async (outcome, termination) => {
      if (settled) return;
      settled = true;
      clearScheduledWork();
      if (sampleInFlight) await sampleInFlight;
      if (outcome === "completed" && monotonicNow() >= deadlineNs) {
        outcome = "timed_out";
      }
      if (outcome === "completed" && normalized.consumeStdout) {
        try {
          const consumed = normalized.consumeStdout(Buffer.concat(stdoutChunks, stdoutBytes));
          if (consumed && typeof consumed.then === "function") throw new TypeError("async consumer refused");
          if (normalized.requireLifetimePeakRss) {
            if (!Number.isSafeInteger(consumed) || consumed < 1) {
              throw new TypeError("lifetime peak RSS refused");
            }
            if (consumed > normalized.maximumRssBytes) outcome = "rss_limit_exceeded";
          }
        } catch {
          outcome = "stdout_rejected";
        }
      }
      if (outcome === "completed" && peakRssBytes > normalized.maximumRssBytes) {
        outcome = "rss_limit_exceeded";
      }
      stdoutChunks = [];
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(fixedResult({
        outcome,
        termination,
        startedAtNs,
        nowNs: monotonicNow(),
        peakRssBytes,
        rssSampleCount,
        rssSampleFailureCount,
        stdoutBytes,
        stderrBytes,
      }));
    };

    const forceTermination = (outcome) => {
      if (settled || forcedOutcome !== null) return;
      forcedOutcome = outcome;
      stdoutChunks = [];
      if (sampleHandle !== null) {
        cancelInterval(sampleHandle);
        sampleHandle = null;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Settlement is still bounded by the termination confirmation timer.
      }
      terminationHandle = scheduleTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* fixed outcome below */ }
        void finish("termination_unconfirmed", outcome);
      }, R7_WORKER_TERMINATION_GRACE_MS);
    };

    const armDeadline = () => {
      const remainingNs = deadlineNs - monotonicNow();
      if (remainingNs <= 0n) {
        forceTermination("timed_out");
        return;
      }
      const remainingMs = Number((remainingNs + 999_999n) / 1_000_000n);
      deadlineHandle = scheduleTimeout(() => {
        deadlineHandle = null;
        armDeadline();
      }, Math.max(1, remainingMs));
    };

    child.stdout.on("data", (value) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes = saturatedAdd(stdoutBytes, chunk.length);
      if (stdoutBytes <= R7_WORKER_MAXIMUM_STDOUT_BYTES) stdoutChunks.push(chunk);
      else forceTermination("stdout_limit_exceeded");
    });
    child.stderr.on("data", (value) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value));
      stderrBytes = saturatedAdd(stderrBytes, bytes);
      if (stderrBytes > R7_WORKER_MAXIMUM_STDERR_BYTES) forceTermination("stderr_limit_exceeded");
    });
    child.stdin.on("error", () => forceTermination("worker_failed"));
    child.on("error", () => {
      if (forcedOutcome === null) void finish("spawn_failed", "spawn_error");
    });
    child.on("close", (code, signal) => {
      const clean = code === 0 && signal === null;
      const termination = signal === "SIGKILL"
        ? "sigkill"
        : signal === null
          ? (clean ? "clean" : "nonzero")
          : "signaled";
      const deadlineExceeded = monotonicNow() >= deadlineNs;
      void finish(forcedOutcome ?? (deadlineExceeded ? "timed_out" : clean ? "completed" : "worker_failed"), termination);
    });

    observeRss();
    sampleHandle = scheduleInterval(observeRss, R7_WORKER_RSS_SAMPLE_INTERVAL_MS);
    armDeadline();
    try {
      child.stdin.end(normalized.input);
    } catch {
      forceTermination("worker_failed");
    }
  });
}
