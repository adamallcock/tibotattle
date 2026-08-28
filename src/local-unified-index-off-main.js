import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  ingestLocalUnifiedIndexIncrement,
} from "./local-unified-index-ingest.js";
import {
  validateLocalUnifiedIndexAttemptToken,
} from "./local-unified-index-build.js";
// Keep the worker entrypoint in the statically reviewed macOS runtime graph.
// The module runs its protocol only when Node loads it as a worker thread.
import "./local-unified-index-off-main-worker.js";
import {
  defaultLocalUnifiedIndexPath,
  removeExactLocalUnifiedIndexAttemptStages,
} from "./local-unified-index.js";

const WORKER_OPTION_KEYS = Object.freeze([
  "codexHome",
  "indexFile",
  "secretFile",
  "contractVersion",
  "startAt",
  "endAt",
  "commitRows",
  "maximumLineBytes",
  "coldBackfillWorkerCount",
  "coldRebuildIfMissing",
  "discoveryLimits",
]);

export const LOCAL_UNIFIED_INDEX_OFF_MAIN_ABORT_GRACE_MS = 30_000;

// The refresh controller already admits one run at a time. Keep this boundary
// closed independently so an injected caller cannot race two staged writers
// for the same live index while one worker is still shutting down.
const activeOffMainAttempts = new Map();

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(value, fallback) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
    ? value
    : fallback;
}

function activeIndexKey(options) {
  const indexFile = options.indexFile ?? defaultLocalUnifiedIndexPath();
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  return resolve(indexFile);
}

function claimActiveAttempt(indexFile, owner) {
  if (activeOffMainAttempts.has(indexFile)) {
    throw fixedError("local_unified_index_worker_busy");
  }
  activeOffMainAttempts.set(indexFile, owner);
}

function createAttemptToken() {
  try {
    return validateLocalUnifiedIndexAttemptToken(
      randomBytes(16).toString("hex"),
    );
  } catch {
    throw fixedError("local_unified_index_worker_failed");
  }
}

function releaseActiveAttempt(indexFile, owner) {
  if (activeOffMainAttempts.get(indexFile) === owner) {
    activeOffMainAttempts.delete(indexFile);
  }
}

/**
 * SQLite ingestion runs off the macOS companion's loopback event loop.
 * Windows retains its qualified in-process capabilities, and Linux retains
 * its existing direct path until that surface has separate runtime evidence.
 */
export function shouldRunLocalUnifiedIndexOffMain({
  platform = process.platform,
} = {}) {
  return platform === "darwin";
}

function cloneWorkerOptions(options, attemptToken) {
  const selected = {};
  if (options.coldRebuildIfMissing !== undefined
      && typeof options.coldRebuildIfMissing !== "boolean") {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  for (const key of WORKER_OPTION_KEYS) {
    if (options[key] !== undefined) selected[key] = options[key];
  }
  for (const key of [
    "windowsProtectedStateStore",
    "windowsFilesystemAdapter",
    "windowsQualificationModeContext",
    "windowsSqliteStateSession",
    "windowsSqliteStateSessionFactory",
    "windowsSqliteStateStaging",
  ]) {
    if (options[key] !== null && options[key] !== undefined) {
      throw fixedError("local_unified_index_windows_state_unqualified");
    }
  }
  for (const key of ["stateRoot", "resourceRoot"]) {
    if (options[key] !== null
        && options[key] !== undefined
        && (typeof options[key] !== "string" || options[key].length < 1)) {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
  }
  selected.attemptToken = validateLocalUnifiedIndexAttemptToken(attemptToken);
  return selected;
}

function acknowledgeProgress(worker, id) {
  try {
    worker.postMessage({ type: "progress_ack", id });
  } catch {
    // Worker shutdown is terminal; this acknowledgement carries no payload.
  }
}

function postProgressResult(worker, id, callback) {
  Promise.resolve()
    .then(callback)
    .then(
      () => acknowledgeProgress(worker, id),
      (error) => worker.postMessage({
        type: "progress_error",
        id,
        code: safeErrorCode(
          error?.code,
          "local_unified_index_progress_failed",
        ),
      }),
    )
    .catch(() => {
      // A terminal worker event owns the outcome if acknowledgement races exit.
    });
}

/**
 * Execute one staged ingestion attempt and settle only after the worker is
 * confirmed stopped. A cooperative abort lets the ingest catch path close and
 * remove its stage. A blocked synchronous/native call is force-terminated
 * after the bounded grace period; the live index remains the prior atomically
 * published generation and a retry cannot begin until shutdown is confirmed.
 */
export async function runLocalUnifiedIndexOffMainWorker(
  options,
  {
    signal = null,
    onProgress = null,
    WorkerClass = Worker,
    attemptToken = createAttemptToken(),
    abortGraceMs = LOCAL_UNIFIED_INDEX_OFF_MAIN_ABORT_GRACE_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function or null");
  }
  if (typeof WorkerClass !== "function") {
    throw new TypeError("WorkerClass must be a constructor");
  }
  if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 0) {
    throw new TypeError("abortGraceMs must be a non-negative safe integer");
  }
  if (typeof setTimeoutImpl !== "function"
      || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("timer hooks must be functions");
  }

  const token = validateLocalUnifiedIndexAttemptToken(attemptToken);
  if (token === null) {
    throw fixedError("local_unified_index_attempt_token_invalid");
  }

  const indexKey = activeIndexKey(options);
  const owner = token;
  claimActiveAttempt(indexKey, owner);
  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-unified-index-off-main-worker.js", import.meta.url),
      {
        workerData: {
          options: cloneWorkerOptions(options, token),
          hasProgress: onProgress !== null,
        },
        execArgv: [],
      },
    );
  } catch {
    releaseActiveAttempt(indexKey, owner);
    throw fixedError("local_unified_index_worker_failed");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortRequested = false;
    let graceTimer = null;
    let terminationStarted = false;
    let terminationSettled = false;
    let terminationError = null;
    let exitObserved = false;
    let terminal = null;

    const clearGrace = () => {
      if (graceTimer === null) return;
      try {
        clearTimeoutImpl(graceTimer);
      } catch {
        // Timer cleanup is best effort after the worker is already terminal.
      }
      graceTimer = null;
    };
    const finish = () => {
      if (settled || terminal === null) return;
      if (!exitObserved && !terminationSettled) return;
      if (terminationError !== null && !exitObserved) return;
      // If terminate() was requested and has not settled, its result still
      // determines whether shutdown was confirmed or failed.
      if (terminationStarted && !terminationSettled) return;
      settled = true;
      clearGrace();
      signal?.removeEventListener?.("abort", requestAbort);
      releaseActiveAttempt(indexKey, owner);
      const selected = terminal;
      terminal = null;
      if (terminationError !== null) reject(terminationError);
      else if (abortRequested) reject(fixedError("local_unified_index_aborted"));
      else if (selected.error !== null) reject(selected.error);
      else resolve(selected.value);
    };
    const selectTerminal = ({ value = null, error = null } = {}) => {
      if (settled || terminal !== null) return;
      terminal = { value, error };
      finish();
    };
    const requestTermination = () => {
      if (settled || terminationStarted || exitObserved) return;
      terminationStarted = true;
      Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => {
          terminationError = fixedError(
            "local_unified_index_worker_termination_failed",
          );
        })
        .then(async () => {
          if (terminationError === null) {
            try {
              await removeExactLocalUnifiedIndexAttemptStages(indexKey, token);
            } catch {
              // Exact cleanup is deliberately fail-closed. A filesystem race
              // or unsafe replacement stays available for the rotating stale
              // scanner; it must not disguise confirmed worker termination.
            }
          }
          terminationSettled = true;
          selectTerminal({ error: fixedError("local_unified_index_aborted") });
          finish();
        });
    };
    const requestAbort = () => {
      if (abortRequested || settled) return;
      abortRequested = true;
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        // Hard termination below owns a worker that cannot receive the abort.
      }
      try {
        graceTimer = setTimeoutImpl(requestTermination, abortGraceMs);
        graceTimer?.unref?.();
      } catch {
        requestTermination();
      }
    };

    signal?.addEventListener?.("abort", requestAbort, { once: true });
    if (signal?.aborted === true) requestAbort();
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        if (abortRequested || onProgress === null) {
          acknowledgeProgress(worker, message.id);
        } else {
          postProgressResult(worker, message.id, () => {
            if (!abortRequested) return onProgress(message.value);
          });
        }
        return;
      }
      if (abortRequested) return;
      if (message?.type === "result") {
        selectTerminal({ value: message.result });
      } else if (message?.type === "error") {
        selectTerminal({
          error: fixedError(safeErrorCode(
            message.code,
            "local_unified_index_worker_failed",
          )),
        });
      }
    });
    worker.on("error", () => {
      if (!abortRequested) {
        selectTerminal({ error: fixedError("local_unified_index_worker_failed") });
      }
    });
    worker.on("exit", (code) => {
      exitObserved = true;
      if (abortRequested) {
        selectTerminal({ error: fixedError("local_unified_index_aborted") });
      } else if (terminal === null) {
        selectTerminal({
          error: fixedError("local_unified_index_worker_failed"),
        });
      } else if (code !== 0 && terminal.error === null) {
        terminal = { value: null, error: fixedError("local_unified_index_worker_failed") };
      }
      finish();
    });
  });
}

export async function ingestLocalUnifiedIndexOffMain(options = {}) {
  const {
    signal = null,
    onProgress = null,
    ...ingestOptions
  } = options;
  delete ingestOptions.attemptToken;
  if (!shouldRunLocalUnifiedIndexOffMain()) {
    return ingestLocalUnifiedIndexIncrement({
      ...ingestOptions,
      signal,
      onProgress,
    });
  }
  if (ingestOptions.coldRebuildIfMissing === undefined) {
    ingestOptions.coldRebuildIfMissing = true;
  }
  return runLocalUnifiedIndexOffMainWorker(ingestOptions, {
    signal,
    onProgress,
  });
}
