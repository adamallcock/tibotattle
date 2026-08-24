import { Worker } from "node:worker_threads";

import {
  ingestLocalUnifiedIndexIncrement,
} from "./local-unified-index-ingest.js";

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
  "discoveryLimits",
]);

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

/**
 * The Electron companion is started with ELECTRON_RUN_AS_NODE=1. Windows is
 * deliberately excluded even when that marker is present: its qualified
 * native SQLite/session boundary must remain in the existing process and may
 * not be replaced by a worker that cannot carry native capability objects.
 */
export function shouldRunLocalUnifiedIndexOffMain({
  platform = process.platform,
  environment = process.env,
} = {}) {
  return platform !== "win32"
    && environment?.ELECTRON_RUN_AS_NODE === "1";
}

function workerOptions(options) {
  const selected = {};
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
  // The server composition carries these roots for every platform. They are
  // ordinary path context on Darwin/Linux, not transferable Windows
  // capabilities, and the non-Windows ingest path does not need them.
  for (const key of ["stateRoot", "resourceRoot"]) {
    if (options[key] !== null
        && options[key] !== undefined
        && typeof options[key] !== "string") {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
  }
  return selected;
}

function postProgressResult(worker, id, callback) {
  Promise.resolve()
    .then(() => callback())
    .then(
      () => worker.postMessage({ type: "progress_ack", id }),
      (error) => worker.postMessage({
        type: "progress_error",
        id,
        code: safeErrorCode(error?.code, "local_unified_index_progress_failed"),
      }),
    )
    .catch(() => {
      // The worker may have exited after the result or cancellation. Its
      // terminal message is authoritative; there is no user-facing payload
      // in this best-effort acknowledgement path.
    });
}

async function runInWorker(options, { signal = null, onProgress = null } = {}) {
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function or null");
  }

  const worker = new Worker(
    new URL("./local-unified-index-off-main-worker.js", import.meta.url),
    {
      workerData: {
        options: workerOptions(options),
        hasProgress: onProgress !== null,
      },
      execArgv: [],
    },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortSent = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", sendAbort);
      callback(value);
    };
    const sendAbort = () => {
      if (abortSent) return;
      abortSent = true;
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        // The worker's exit/error event completes the operation. This keeps
        // cancellation content-free and avoids surfacing transport details.
      }
    };
    const failWorker = (error) => finish(reject, error);
    signal?.addEventListener?.("abort", sendAbort, { once: true });
    if (signal?.aborted === true) sendAbort();
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        if (onProgress === null) {
          try {
            worker.postMessage({ type: "progress_ack", id: message.id });
          } catch {
            // Terminal worker state determines the result.
          }
          return;
        }
        postProgressResult(
          worker,
          message.id,
          () => onProgress(message.value),
        );
        return;
      }
      if (message?.type === "result") {
        finish(resolve, message.result);
        return;
      }
      if (message?.type === "error") {
        failWorker(fixedError(
          safeErrorCode(message.code, "local_unified_index_worker_failed"),
        ));
      }
    });
    worker.on("error", () => {
      failWorker(fixedError("local_unified_index_worker_failed"));
    });
    worker.on("exit", (code) => {
      if (settled) return;
      if (signal?.aborted === true) {
        failWorker(fixedError("local_unified_index_aborted"));
      } else if (code !== 0) {
        failWorker(fixedError("local_unified_index_worker_failed"));
      } else {
        failWorker(fixedError("local_unified_index_worker_failed"));
      }
    });
  });
}

/**
 * Run unified-index ingestion off the Electron companion's HTTP event loop.
 * Native Windows callers and ordinary Node/native callers retain the direct
 * implementation, which keeps the qualified Windows capability path intact
 * and avoids changing the native macOS process contract.
 */
export async function ingestLocalUnifiedIndexOffMain(options = {}) {
  const {
    signal = null,
    onProgress = null,
    ...ingestOptions
  } = options;
  if (!shouldRunLocalUnifiedIndexOffMain()) {
    return ingestLocalUnifiedIndexIncrement({
      ...ingestOptions,
      signal,
      onProgress,
    });
  }
  return runInWorker(ingestOptions, { signal, onProgress });
}
