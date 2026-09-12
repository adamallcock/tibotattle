import { Worker } from "node:worker_threads";

import {
  LOCAL_COLLECTOR_PROJECTION_WORKER_CONTRACT,
} from "./local-collector-projection-off-main-worker.js";
import {
  readLocalCollectorProjection,
} from "./local-collector-projection.js";

const WORKER_ERROR = "local_collector_projection_worker_failed";
const ABORT_ERROR = "local_collector_projection_aborted";
const WORKER_SETTLEMENT_TIMEOUT_MS = 500;
const PROPAGATED_ERROR_CODES = new Set([
  "collector_invalid_size",
  "collector_unavailable",
  "local_collector_state_corrupt",
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

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("collector projection options must be an object");
  }
  if (typeof options.stateFile !== "string" || options.stateFile.length < 1) {
    throw new TypeError("collector projection stateFile must be a non-empty string");
  }
  if (!Number.isFinite(options.nowMs)) {
    throw new TypeError("collector projection nowMs must be finite");
  }
  const summarizeUsageEvents = options.summarizeUsageEvents ?? true;
  if (typeof summarizeUsageEvents !== "boolean") {
    throw new TypeError("collector projection summarizeUsageEvents must be boolean");
  }
  const declaredSpeedBaselines = options.declaredSpeedBaselines ?? [];
  if (!Array.isArray(declaredSpeedBaselines)) {
    throw new TypeError("collector projection declaredSpeedBaselines must be an array");
  }
  return {
    stateFile: options.stateFile,
    nowMs: options.nowMs,
    summarizeUsageEvents,
    declaredSpeedBaselines,
  };
}

function validSignal(signal) {
  return signal === null || (typeof signal === "object"
    && typeof signal.aborted === "boolean"
    && typeof signal.addEventListener === "function"
    && typeof signal.removeEventListener === "function");
}

/**
 * Read the bounded collector projection outside the companion event loop.
 *
 * The projection is the same structured-cloneable public snapshot component
 * produced by the direct reader. The state path is a process-local worker
 * input only; raw SQLite rows, paths, and errors never cross back in a result
 * or diagnostic. This has no platform selector: all desktop builds use the
 * same read-only worker contract.
 */
export async function readLocalCollectorProjectionOffMain(
  options = {},
  {
    signal = null,
    WorkerClass = Worker,
  } = {},
) {
  const selected = validateOptions(options);
  if (!validSignal(signal)) {
    throw new TypeError("collector projection signal must be an AbortSignal or null");
  }
  if (typeof WorkerClass !== "function") {
    throw new TypeError("collector projection WorkerClass must be a constructor");
  }
  if (signal?.aborted === true) throw fixedError(ABORT_ERROR);

  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-collector-projection-off-main-worker.js", import.meta.url),
      {
        workerData: {
          contract: LOCAL_COLLECTOR_PROJECTION_WORKER_CONTRACT,
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
      else resolve(terminal.result);
    };
    const finishAfterExit = () => {
      if (settled || terminal === null || !exitObserved) return;
      settle();
    };
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      Promise.resolve(worker.terminate()).catch(() => {
        // The fixed terminal result below remains content-free either way.
      });
    };
    const armBoundedSettlement = () => {
      if (settlementTimer !== null || settled || exitObserved) return;
      settlementTimer = setTimeout(() => {
        if (settled || exitObserved) return;
        if (terminal?.error === null) {
          terminal = { result: null, error: fixedError(WORKER_ERROR) };
        }
        requestTermination();
        settle();
      }, WORKER_SETTLEMENT_TIMEOUT_MS);
    };
    const selectTerminal = ({ result = null, error = null } = {}, {
      terminate = false,
    } = {}) => {
      if (terminal !== null || settled) return;
      terminal = { result, error };
      if (terminate) requestTermination();
      armBoundedSettlement();
      finishAfterExit();
    };
    const abort = () => {
      if (settled || terminal !== null) return;
      selectTerminal({ error: fixedError(ABORT_ERROR) }, { terminate: true });
    };

    signal?.addEventListener?.("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (message?.type === "result" && Object.keys(message).length === 2) {
        selectTerminal({ result: message.result });
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
        terminal = { result: null, error: fixedError(WORKER_ERROR) };
      } else if (terminal === null) {
        selectTerminal({ error: fixedError(WORKER_ERROR) });
      }
      finishAfterExit();
    });
  });
}

export {
  readLocalCollectorProjection,
};
