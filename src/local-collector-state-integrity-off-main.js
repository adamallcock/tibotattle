import { Worker } from "node:worker_threads";

import {
  LOCAL_COLLECTOR_STATE_INTEGRITY_WORKER_CONTRACT,
} from "./local-collector-state-integrity-off-main-worker.js";

const WORKER_ERROR = "local_collector_state_integrity_worker_failed";
const ABORT_ERROR = "local_collector_state_integrity_aborted";
const WORKER_SETTLEMENT_TIMEOUT_MS = 500;
const PROPAGATED_ERROR_CODES = new Set([
  "local_collector_state_integrity_failed",
  "local_collector_state_schema_invalid",
  "local_collector_state_unavailable",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(value) {
  return PROPAGATED_ERROR_CODES.has(value) ? value : WORKER_ERROR;
}

function validIdentity(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "dev\0ino"
    && Number.isSafeInteger(value.dev)
    && value.dev >= 0
    && Number.isSafeInteger(value.ino)
    && value.ino >= 0;
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).sort().join("\0") !== "expectedIdentity\0stateFile") {
    throw new TypeError("collector state integrity options must be an object");
  }
  if (typeof options.stateFile !== "string" || options.stateFile.length < 1
      || !validIdentity(options.expectedIdentity)) {
    throw new TypeError("collector state integrity options are invalid");
  }
  return {
    stateFile: options.stateFile,
    expectedIdentity: {
      dev: options.expectedIdentity.dev,
      ino: options.expectedIdentity.ino,
    },
  };
}

function validSignal(signal) {
  return signal === null || (typeof signal === "object"
    && typeof signal.aborted === "boolean"
    && typeof signal.addEventListener === "function"
    && typeof signal.removeEventListener === "function");
}

/**
 * Run one full collector-state integrity scan outside the companion event
 * loop. The fixed terminal protocol never carries a state path, SQLite row,
 * file identity, or native diagnostic back to the caller.
 */
export async function verifyLocalCollectorStateIntegrityOffMain(
  options = {},
  {
    signal = null,
    WorkerClass = Worker,
  } = {},
) {
  const selected = validateOptions(options);
  if (!validSignal(signal)) {
    throw new TypeError("collector state integrity signal must be an AbortSignal or null");
  }
  if (typeof WorkerClass !== "function") {
    throw new TypeError("collector state integrity WorkerClass must be a constructor");
  }
  if (signal?.aborted === true) throw fixedError(ABORT_ERROR);

  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-collector-state-integrity-off-main-worker.js", import.meta.url),
      {
        workerData: {
          contract: LOCAL_COLLECTOR_STATE_INTEGRITY_WORKER_CONTRACT,
          options: selected,
        },
        execArgv: [],
      },
    );
  } catch {
    throw fixedError(WORKER_ERROR);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminal = null;
    let exitObserved = false;
    let settlementTimer = null;
    let terminationRequested = false;

    const cleanup = () => {
      signal?.removeEventListener?.("abort", abort);
      if (settlementTimer !== null) clearTimeout(settlementTimer);
    };
    const settle = () => {
      if (settled || terminal === null) return;
      settled = true;
      cleanup();
      if (terminal.error !== null) reject(terminal.error);
      else resolve();
    };
    const finishAfterExit = () => {
      if (settled || terminal === null || !exitObserved) return;
      settle();
    };
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      Promise.resolve(worker.terminate()).catch(() => {
        // The fixed terminal outcome owns worker shutdown failure.
      });
    };
    const armBoundedSettlement = () => {
      if (settlementTimer !== null || settled || exitObserved) return;
      settlementTimer = setTimeout(() => {
        if (settled || exitObserved) return;
        if (terminal?.error === null) {
          terminal = { error: fixedError(WORKER_ERROR) };
        }
        requestTermination();
        settle();
      }, WORKER_SETTLEMENT_TIMEOUT_MS);
    };
    const selectTerminal = ({ error = null } = {}, { terminate = false } = {}) => {
      if (terminal !== null || settled) return;
      terminal = { error };
      if (terminate) requestTermination();
      armBoundedSettlement();
      finishAfterExit();
    };
    const abort = () => {
      if (settled || terminal !== null) return;
      selectTerminal({ error: fixedError(ABORT_ERROR) }, { terminate: true });
    };

    signal?.addEventListener?.("abort", abort, { once: true });
    // A caller can abort while its listener is being registered. Recheck the
    // flag so that race still owns a fixed termination rather than leaving a
    // worker running without an observer.
    if (signal?.aborted === true) abort();
    worker.on("message", (message) => {
      if (message?.type === "result" && Object.keys(message).length === 1) {
        selectTerminal();
      } else if (message?.type === "error" && Object.keys(message).length === 2) {
        selectTerminal({ error: fixedError(safeErrorCode(message.code)) });
      } else {
        selectTerminal({ error: fixedError(WORKER_ERROR) }, { terminate: true });
      }
    });
    worker.on("error", () => {
      selectTerminal({ error: fixedError(WORKER_ERROR) }, { terminate: true });
    });
    worker.on("exit", (code) => {
      exitObserved = true;
      if (code !== 0 && terminal?.error === null) {
        terminal = { error: fixedError(WORKER_ERROR) };
      } else if (terminal === null) {
        selectTerminal({ error: fixedError(WORKER_ERROR) });
      }
      finishAfterExit();
    });
  });
}
