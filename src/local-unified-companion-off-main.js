import { Worker } from "node:worker_threads";

import {
  readLocalUnifiedCompanionProjection,
} from "./local-unified-companion-source.js";
// Keep the worker entrypoint in the statically reviewed native runtime graph.
// Importing it on the main thread does not run the worker protocol.
import "./local-unified-companion-off-main-worker.js";

const PROJECTION_MODES = new Set(["full", "deferred"]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(value) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
    ? value
    : "local_unified_companion_projection_worker_failed";
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (typeof options.indexFile !== "string" || options.indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  const mode = options.mode ?? "full";
  if (!PROJECTION_MODES.has(mode)) {
    throw new TypeError("mode must be full or deferred");
  }
  return {
    indexFile: options.indexFile,
    nowMs,
    declaredSpeedBaselines: Array.isArray(options.declaredSpeedBaselines)
      ? options.declaredSpeedBaselines
      : [],
    mode,
  };
}

export function shouldRunLocalUnifiedCompanionProjectionOffMain({
  platform = process.platform,
  mode = "full",
} = {}) {
  return platform === "darwin" && mode === "full";
}

/**
 * Keep the native companion control plane responsive while SQLite projects a
 * large published generation. Other platforms retain their qualified direct
 * reader, and deferred reads never pay worker startup cost.
 *
 * The worker is read-only, so an abort can terminate it immediately without
 * risking a partial publication or database mutation.
 */
export async function readLocalUnifiedCompanionProjectionOffMain(
  options = {},
  {
    signal = null,
    platform = process.platform,
    WorkerClass = Worker,
  } = {},
) {
  const selected = validateOptions(options);
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (typeof WorkerClass !== "function") {
    throw new TypeError("WorkerClass must be a constructor");
  }
  if (!shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform,
    mode: selected.mode,
  })) {
    return readLocalUnifiedCompanionProjection(selected);
  }
  if (signal?.aborted === true) {
    throw fixedError("local_unified_companion_projection_aborted");
  }

  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-unified-companion-off-main-worker.js", import.meta.url),
      { workerData: { options: selected }, execArgv: [] },
    );
  } catch {
    throw fixedError("local_unified_companion_projection_worker_failed");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminal = null;
    let exitObserved = false;

    const cleanup = () => {
      signal?.removeEventListener?.("abort", abort);
    };
    const finish = () => {
      if (settled || terminal === null || !exitObserved) return;
      settled = true;
      cleanup();
      if (terminal.error !== null) reject(terminal.error);
      else resolve(terminal.result);
    };
    const selectTerminal = ({ result = null, error = null } = {}) => {
      if (terminal !== null || settled) return;
      terminal = { result, error };
      finish();
    };
    const abort = () => {
      if (settled || terminal !== null) return;
      selectTerminal({
        error: fixedError("local_unified_companion_projection_aborted"),
      });
      Promise.resolve(worker.terminate()).catch(() => {
        // Exit remains the authoritative shutdown acknowledgement.
      });
    };

    signal?.addEventListener?.("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (message?.type === "result") {
        selectTerminal({ result: message.result });
      } else if (message?.type === "error") {
        selectTerminal({ error: fixedError(safeErrorCode(message.code)) });
      }
    });
    worker.on("error", () => {
      selectTerminal({
        error: fixedError("local_unified_companion_projection_worker_failed"),
      });
    });
    worker.on("exit", (code) => {
      exitObserved = true;
      if (code !== 0 && terminal?.error === null) {
        terminal = {
          result: null,
          error: fixedError("local_unified_companion_projection_worker_failed"),
        };
      } else if (terminal === null) {
        selectTerminal({
          error: fixedError("local_unified_companion_projection_worker_failed"),
        });
      }
      finish();
    });
  });
}
