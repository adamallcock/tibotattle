import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  ingestLocalUnifiedIndexIncrement,
} from "./local-unified-index-ingest.js";
import { validateLocalUnifiedIndexAttemptToken } from "./local-unified-index-build.js";
import { defaultLocalUnifiedIndexPath } from "./local-unified-index.js";

const WORKER_OPTION_KEYS = Object.freeze([
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

export const LOCAL_UNIFIED_INDEX_OFF_MAIN_ABORT_GRACE_MS = 30_000;

// The companion controller admits one refresh at a time, but keep the
// off-main boundary fail-closed on its own as well. Without this guard, two
// workers in the same process could pass different tokens to the abandoned
// stage scanner and one could reclaim the other's still-live stage by PID.
const activeOffMainAttempts = new Map();

function activeIndexKey(options) {
  const indexFile = options.indexFile ?? defaultLocalUnifiedIndexPath();
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  return resolve(indexFile);
}

function claimActiveOffMainAttempt(indexFile, token) {
  if (activeOffMainAttempts.has(indexFile)) {
    throw fixedError("local_unified_index_worker_busy");
  }
  activeOffMainAttempts.set(indexFile, token);
}

function releaseActiveOffMainAttempt(indexFile, token) {
  if (activeOffMainAttempts.get(indexFile) === token) {
    activeOffMainAttempts.delete(indexFile);
  }
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

function cloneWorkerCodexRoot(value) {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
    return value;
  }
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || typeof value.path !== "string"
      || value.path.length === 0) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  const identity = value.id ?? value.rootId ?? value.path;
  if (typeof identity !== "string" || identity.length === 0) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  // Preserve only the provider-owned descriptor semantics. Arbitrary fields,
  // prototypes, and accessors never cross the worker structured-clone seam.
  return Object.freeze({ path: value.path, id: identity });
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

function workerOptions(options, attemptToken) {
  const selected = {};
  const hasCodexHome = options.codexHome !== null
    && options.codexHome !== undefined;
  const hasCodexHomes = options.codexHomes !== null
    && options.codexHomes !== undefined;
  if (hasCodexHome && hasCodexHomes) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  if (hasCodexHome) {
    if (typeof options.codexHome !== "string" || options.codexHome.length === 0) {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
    selected.codexHome = options.codexHome;
  }
  if (hasCodexHomes) {
    if (!Array.isArray(options.codexHomes)
        || options.codexHomes.length < 1
        || options.codexHomes.length > 8) {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
    const roots = options.codexHomes.map(cloneWorkerCodexRoot);
    const paths = roots.map((value) => (
      typeof value === "string" ? value : value.path
    ));
    const identities = roots.map((value) => (
      typeof value === "string" ? value : value.id
    ));
    if (new Set(paths).size !== roots.length
        || new Set(identities).size !== roots.length) {
      throw fixedError("local_unified_index_worker_options_invalid");
    }
    // Worker structured cloning creates another array, but copy here as well
    // so a caller cannot mutate the admitted root list during construction.
    selected.codexHomes = roots;
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
  selected.attemptToken = validateLocalUnifiedIndexAttemptToken(attemptToken);
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

function acknowledgeProgress(worker, id) {
  try {
    worker.postMessage({ type: "progress_ack", id });
  } catch {
    // The worker may have exited after the result or cancellation. Its
    // terminal message is authoritative; this best-effort acknowledgement
    // carries no user-facing payload.
  }
}

/**
 * Execute one parent-owned off-main attempt. The worker may acknowledge an
 * abort cooperatively, or it may ignore the message while blocked in native
 * or synchronous work. In both cases this promise remains pending until the
 * worker has exited (or termination has resolved). Cooperative cleanup is
 * owned by the worker's ingest catch path. A hard-terminated worker leaves a
 * PID/token-scoped orphan for the existing bounded abandoned-stage scanner;
 * the parent never unlinks a pathname after worker shutdown.
 *
 * The dependency hooks are deliberately narrow and are used by focused tests
 * to model a worker that never exits or returns a late result. Production
 * calls retain the real Worker, timer, and filesystem implementations.
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
  const activeIndexFile = activeIndexKey(options);
  claimActiveOffMainAttempt(activeIndexFile, token);
  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-unified-index-off-main-worker.js", import.meta.url),
      {
        workerData: {
          options: workerOptions(options, token),
          hasProgress: onProgress !== null,
        },
        execArgv: [],
      },
    );
  } catch {
    releaseActiveOffMainAttempt(activeIndexFile, token);
    throw fixedError("local_unified_index_worker_failed");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let settlementStarted = false;
    let abortSent = false;
    let abortRequested = false;
    let graceTimer = null;
    let terminationStarted = false;
    let terminationResolved = false;
    let terminationError = null;
    let workerExitObserved = false;
    let pendingTerminal = null;

    const clearGraceTimer = () => {
      if (graceTimer === null) return;
      try {
        clearTimeoutImpl(graceTimer);
      } catch {
        // The terminal operation remains bounded by the worker termination;
        // timer cleanup itself carries no user-facing detail.
      }
      graceTimer = null;
    };

    const finishAfterWorkerShutdown = (callback, value, terminalError = null) => {
      if (settled || settlementStarted) return;
      settlementStarted = true;
      clearGraceTimer();
      if (settled) return;
      settled = true;
      // This runs only after worker exit or a resolved termination, so a new
      // attempt cannot race live worker SQLite work. If termination never
      // confirms, the guard intentionally remains held and retry stays
      // bounded/fail-closed.
      releaseActiveOffMainAttempt(activeIndexFile, token);
      signal?.removeEventListener?.("abort", sendAbort);
      if (terminalError !== null) {
        reject(terminalError);
      } else {
        callback(value);
      }
    };

    const flushTerminal = () => {
      if (pendingTerminal === null
          || (!workerExitObserved && !terminationResolved)) {
        return;
      }
      const terminal = pendingTerminal;
      pendingTerminal = null;
      finishAfterWorkerShutdown(
        terminal.callback,
        terminal.value,
        terminal.error,
      );
    };

    const requestFinish = (callback, value, terminalError = null) => {
      if (settled || settlementStarted) return;
      pendingTerminal = {
        callback,
        value,
        error: terminalError
          ?? (abortRequested ? fixedError("local_unified_index_aborted") : null),
      };
      flushTerminal();
    };

    const finishWorkerFailure = () => requestFinish(
      reject,
      fixedError("local_unified_index_worker_failed"),
    );

    const sendAbort = () => {
      if (abortSent || settled || settlementStarted) return;
      abortSent = true;
      abortRequested = true;
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        // The grace timer escalates if the worker cannot receive the message.
      }
      const terminateAfterGrace = () => {
        if (settled || settlementStarted || terminationStarted) return;
        terminationStarted = true;
        Promise.resolve()
          .then(() => worker.terminate())
          .catch(() => {
            terminationError = fixedError(
              "local_unified_index_worker_termination_failed",
            );
          })
          .then(() => {
            if (terminationError === null) terminationResolved = true;
            // A rejected terminate() is not proof that the worker stopped.
            // Keep the operation pending until the exit event confirms that
            // cleanup cannot race live SQLite work.
            requestFinish(
              reject,
              fixedError("local_unified_index_aborted"),
              terminationError,
            );
          });
      };
      try {
        graceTimer = setTimeoutImpl(terminateAfterGrace, abortGraceMs);
        graceTimer?.unref?.();
      } catch {
        terminateAfterGrace();
      }
    };

    const finishAbortIfExited = () => {
      // Node may emit `exit` before worker.terminate() resolves. Keep waiting
      // for the termination promise in that case; either signal is enough
      // only once the other has also confirmed the worker is gone.
      if (terminationStarted && !terminationResolved && terminationError === null) {
        return;
      }
      requestFinish(
        reject,
        fixedError("local_unified_index_aborted"),
        terminationError,
      );
    };

    signal?.addEventListener?.("abort", sendAbort, { once: true });
    if (signal?.aborted === true) sendAbort();
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        // Abort is a terminal UI transition. A progress message already
        // queued in the parent event loop must still be acknowledged so the
        // worker protocol can drain, but it must not call back into the
        // renderer after cancellation has been requested.
        if (abortRequested || onProgress === null) {
          acknowledgeProgress(worker, message.id);
          return;
        }
        postProgressResult(
          worker,
          message.id,
          () => {
            if (abortRequested) return;
            return onProgress(message.value);
          },
        );
        return;
      }
      if (message?.type === "result") {
        // A result posted after cancellation is not a successful retry. The
        // worker must still exit and the token candidates must still settle.
        if (!abortRequested) requestFinish(resolve, message.result);
        return;
      }
      if (message?.type === "error") {
        if (!abortRequested) {
          requestFinish(
            reject,
            fixedError(
              safeErrorCode(message.code, "local_unified_index_worker_failed"),
            ),
          );
        }
      }
    });
    worker.on("error", () => {
      if (!abortRequested) finishWorkerFailure();
    });
    worker.on("exit", (code) => {
      if (settled) return;
      workerExitObserved = true;
      if (abortRequested || signal?.aborted === true) {
        finishAbortIfExited();
      } else if (code !== 0) {
        finishWorkerFailure();
      } else if (pendingTerminal === null) {
        finishWorkerFailure();
      } else {
        flushTerminal();
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
    // A caller cannot provide or reuse the parent token. The off-main parent
    // creates one per attempt so a later retry can never target an older stage.
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
  return runLocalUnifiedIndexOffMainWorker(ingestOptions, {
    signal,
    onProgress,
  });
}
