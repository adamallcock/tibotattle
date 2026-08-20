import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReplaySafeAccountingCache,
  REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION,
} from "./replay-safe-accounting-cache.js";
import { createIndexedCodexLogScan } from "./local-analysis-index.js";
// The reviewed canonical-JSON entrypoint, NOT legacy storage: the child needs
// only the stable serialization (the byte layer of the parent's integrity
// check), and the legacy storage module's direct-caller ledger is frozen.
import { stableJson } from "./export/canonical-json.js";

// The accounting-rebuild child. refreshReplaySafeAccountingCache runs the full
// cache build in this short-lived subprocess so the RSS budget is charged to a
// process that starts from a clean baseline and returns every byte to the OS
// on exit. Running the build inside the resident menu-bar companion could not
// achieve either: after real indexing on a large corpus the companion
// legitimately idles at a residency comparable to the accounting target
// itself, so the budget-relative guard had no headroom left for ANY rebuild
// growth, and the rebuild deferred forever (live 0.1.13 incident, 2026-08-19:
// a 4,852-source / ~80 GB companion sat at 1.88 GiB whole-process RSS after
// indexing, against a 2 GiB target at the time, and logged
// accounting_rebuild_deferred / accounting_transition_rss_limit_exceeded on
// every attempt even after the streaming-corpus fix bounded per-batch
// residency). The 2026-08-20 raise leaves that headroom argument less tight at
// today's numbers, but the other two reasons are structural and do not depend
// on the ceiling at all: growth here never enlarges the resident process, and
// exit returns every rebuild byte to the OS instead of fossilizing the next
// attempt's baseline.
//
// Contract (see buildReplaySafeAccountingCacheInSubprocess, the only caller):
// argv carries exactly two file paths — a request file the parent wrote and a
// result file this process creates. The request is the JSON-serializable
// subset of the build options; non-serializable characterization seams
// (injected scan/rss functions) never cross the boundary, so those callers
// stay on the in-process build. The child writes the finished cache artifact
// to the result file as canonical stable JSON and prints ONE envelope line on
// stdout naming the payload's byte count and SHA-256, which the parent
// verifies before parsing. A build failure becomes a typed error envelope
// carrying only the fixed error code (never message text, never paths); a
// crash produces no envelope at all and the parent fails closed to the same
// deferral a memory-budget miss produces.
//
// The generation and file-identity verification the streaming corpus performs
// at open and at finish runs INSIDE this process, against the same index file
// the parent named — the process boundary adds transport integrity checks on
// top of those, it never substitutes for them.

const CHILD_MODULE_FILE = fileURLToPath(import.meta.url);
// Mirrors the refresh wrapper's bounded failure-code shape: a child error
// whose code cannot be safely restated collapses to the subprocess-failure
// code rather than leaking arbitrary text across the boundary.
const CHILD_FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
// The closed measurement shape a budget miss may carry back. Three keys, whole
// non-negative MiB or null, nothing else — the same shape the parent
// re-validates, so neither side has to trust the other.
const CHILD_MEASUREMENT_KEYS = Object.freeze([
  "baselineRssMib",
  "observedRssMib",
  "ceilingRssMib",
]);

function boundedChildMeasurements(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const bounded = {};
  for (const key of CHILD_MEASUREMENT_KEYS) {
    const measurement = value[key];
    bounded[key] = Number.isSafeInteger(measurement) && measurement >= 0
      ? measurement
      : null;
  }
  return bounded;
}

function requestPath(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError("rebuild request path is invalid");
  }
  return value;
}

function parseRebuildRequest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("rebuild request is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.version !== REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION) {
    throw new TypeError("rebuild request version is not supported");
  }
  if (!Number.isFinite(value.nowMs)
      || !Number.isSafeInteger(value.windowDays)
      || !["unified", "legacy"].includes(value.sourceMode)
      || typeof value.contextBehavior !== "string"
      || !Array.isArray(value.declaredSpeedBaselines)) {
    throw new TypeError("rebuild request is invalid");
  }
  requestPath(value.codexHome);
  requestPath(value.unifiedIndexFile, { allowNull: true });
  if (value.sourceMode === "legacy") {
    requestPath(value.legacyIndexFile);
    requestPath(value.legacyIndexSecretFile);
    if (!Number.isSafeInteger(value.legacyIndexWorkerCount)
        || value.legacyIndexWorkerCount < 1) {
      throw new TypeError("rebuild request legacy worker count is invalid");
    }
    if (value.legacyIndexChunkBytes !== null
        && !Number.isSafeInteger(value.legacyIndexChunkBytes)) {
      throw new TypeError("rebuild request legacy chunk bytes are invalid");
    }
  }
  if (value.maximumRssBytes !== null
      && (!Number.isSafeInteger(value.maximumRssBytes)
        || value.maximumRssBytes < 1)) {
    throw new TypeError("rebuild request RSS ceiling is invalid");
  }
  if (value.transitionResourceLimits !== null
      && (typeof value.transitionResourceLimits !== "object"
        || Array.isArray(value.transitionResourceLimits))) {
    throw new TypeError("rebuild request transition limits are invalid");
  }
  return value;
}

function buildOptionsForRequest(request, signal) {
  return {
    codexHome: request.codexHome,
    // The parent sampled its clock ONCE and the anchor crosses as a number, so
    // the artifact's endMs/generatedAt/coveredAt stamps are exactly what the
    // in-process build would have produced from the same clock call. The scan
    // guard therefore sees a frozen clock (its elapsed-time arm stays inert in
    // the child); the binding wall-clock stop remains the parent, which kills
    // this process on abort or refresh timeout.
    now: () => request.nowMs,
    windowDays: request.windowDays,
    sourceMode: request.sourceMode,
    contextBehavior: request.contextBehavior,
    expectedGeneration: request.expectedGeneration ?? null,
    unifiedIndexFile: request.unifiedIndexFile,
    declaredSpeedBaselines: request.declaredSpeedBaselines,
    signal,
    ...(request.transitionResourceLimits === null
      ? {}
      : { transitionResourceLimits: request.transitionResourceLimits }),
    ...(request.maximumRssBytes === null
      ? {}
      : { maximumRssBytes: request.maximumRssBytes }),
    // Legacy authority reconstructs the exact indexed scan the refresh wrapper
    // builds in-process; unified authority leaves scan unset so the build
    // constructs the unified reader itself, with identical inputs to the
    // wrapper's own construction. Only serializable inputs exist on either
    // arm, which is what makes this reconstruction sound.
    ...(request.sourceMode === "legacy"
      ? {
        scan: createIndexedCodexLogScan({
          indexFile: request.legacyIndexFile,
          secretFile: request.legacyIndexSecretFile,
          workerCount: request.legacyIndexWorkerCount,
          ...(request.legacyIndexChunkBytes === null
            ? {}
            : { chunkBytes: request.legacyIndexChunkBytes }),
        }),
      }
      : {}),
  };
}

/**
 * Runs one rebuild request end to end and returns the envelope the parent
 * consumes. Never throws: every failure — unreadable request, invalid shape,
 * build error, unwritable result — becomes a bounded typed-error envelope so
 * the parent can distinguish "the build refused for reason X" (code
 * passthrough, preserving the deferral and passthrough classifications the
 * in-process path has) against "the child died" (no envelope at all).
 * Exported for direct characterization; production enters through the main
 * invocation below.
 */
export async function runReplaySafeAccountingRebuildChild({
  requestFile,
  resultFile,
  signal = null,
} = {}) {
  try {
    const request = parseRebuildRequest(
      await readFile(requestPath(requestFile), "utf8"),
    );
    const cache = await buildReplaySafeAccountingCache(
      buildOptionsForRequest(request, signal),
    );
    const payload = stableJson(cache);
    // 'wx' keeps the write honest: the parent created a fresh private work
    // directory, so a pre-existing result file means the protocol was not
    // followed and the write must refuse rather than overwrite.
    await writeFile(requestPath(resultFile), payload, {
      mode: 0o600,
      flag: "wx",
    });
    return {
      status: "ok",
      resultBytes: Buffer.byteLength(payload),
      resultSha256: createHash("sha256").update(payload).digest("hex"),
    };
  } catch (error) {
    // A budget miss carries the three quantities its guard compared. Those
    // must cross the boundary or the production path — which is the isolated
    // child whenever isolation is eligible — records a deferral with no
    // numbers, which is exactly the undiagnosable state the instrumentation
    // exists to end. Rounded MiB integers only, re-validated on both sides,
    // so this stays a fixed numeric shape and never a text channel.
    const measurements = boundedChildMeasurements(error?.measurements);
    return {
      status: "error",
      code: typeof error?.code === "string"
          && CHILD_FAILURE_CODE_PATTERN.test(error.code)
        ? error.code
        : "accounting_rebuild_subprocess_failed",
      name: error?.name === "AbortError" ? "AbortError" : "Error",
      ...(measurements === null ? {} : { measurements }),
    };
  }
}

function isMainInvocation() {
  return typeof process.argv[1] === "string"
    && process.argv[1].length > 0
    && resolve(process.argv[1]) === CHILD_MODULE_FILE;
}

if (isMainInvocation()) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // The parent kills with SIGTERM on abort/timeout; a graceful unwind through
  // the build's own abort checks produces the typed abort envelope instead of
  // a signal death, so the parent can report the abort it requested.
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  // The parent holds this pipe open for the child's whole life. End-of-input
  // therefore means the parent is gone; abort so an orphaned rebuild can never
  // keep grinding an index nobody will read.
  process.stdin.once("end", abort);
  process.stdin.once("error", abort);
  process.stdin.resume();
  const [requestFile = null, resultFile = null] = process.argv.slice(2, 4);
  runReplaySafeAccountingRebuildChild({
    requestFile,
    resultFile,
    signal: controller.signal,
  }).then((envelope) => {
    // Resumed stdin (and any legacy-scan worker threads mid-teardown) can hold
    // the event loop open; exit explicitly once the envelope byte stream is
    // flushed so the child stays short-lived by construction.
    process.stdout.write(`${JSON.stringify(envelope)}\n`, () => {
      process.exit(0);
    });
  }, () => {
    process.exit(70);
  });
}
