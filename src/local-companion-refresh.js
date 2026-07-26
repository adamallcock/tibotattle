import { homedir } from "node:os";
import { join } from "node:path";
import { selectProductionAccountObservationSecret } from "./account-observation-production.js";
import { runCollectorOnce } from "./passive-collector.js";

const PUBLIC_REFRESH_ERROR_CODES = new Set([
  "app_server_unavailable",
  "malformed_output",
  "temporary_disconnect",
]);

function safeCollectorErrorCode(code) {
  return PUBLIC_REFRESH_ERROR_CODES.has(code) ? code : "collection_failed";
}

export function createLocalCollectorRefreshRunner({
  codexHome = join(homedir(), ".codex"),
  selectAccountObservationSecret = selectProductionAccountObservationSecret,
  runCollector = runCollectorOnce,
} = {}) {
  if (typeof selectAccountObservationSecret !== "function") {
    throw new TypeError("selectAccountObservationSecret must be a function");
  }
  if (typeof runCollector !== "function") throw new TypeError("runCollector must be a function");
  return async function refreshLocalCollector() {
    let selection;
    try {
      selection = selectAccountObservationSecret();
    } catch {
      selection = { loadAccountObservationSecret: null };
    }
    const result = await runCollector({
      codexHome,
      staleAfterMs: 0,
      refreshStale: true,
      backfill: false,
      maximumBufferedLineBytes: 16 * 1024 * 1024,
      maximumRecordBatchSize: 500,
      maximumRecentEventKeys: 5_000,
      loadAccountObservationSecret: selection.loadAccountObservationSecret,
    });
    return {
      rolloutRecordsWritten: Number.isSafeInteger(result?.rolloutRecordsWritten)
        ? result.rolloutRecordsWritten
        : 0,
      filesDiscovered: Number.isSafeInteger(result?.filesDiscovered) ? result.filesDiscovered : 0,
      quotaRefresh: {
        attempted: result?.refresh?.attempted === true,
        recordWritten: result?.refresh?.recordWritten === true,
        errorCode: result?.refresh?.errorCode
          ? safeCollectorErrorCode(result.refresh.errorCode)
          : null,
      },
    };
  };
}

function publicRefreshResult(result) {
  return {
    rolloutRecordsWritten: Number.isSafeInteger(result?.rolloutRecordsWritten)
      ? result.rolloutRecordsWritten
      : 0,
    filesDiscovered: Number.isSafeInteger(result?.filesDiscovered) ? result.filesDiscovered : 0,
    quotaRefresh: {
      attempted: result?.quotaRefresh?.attempted === true,
      recordWritten: result?.quotaRefresh?.recordWritten === true,
      errorCode: result?.quotaRefresh?.errorCode
        ? safeCollectorErrorCode(result.quotaRefresh.errorCode)
        : null,
    },
  };
}

export class LocalCompanionRefreshController {
  #clock;
  #dataStore;
  #inFlight = null;
  #runner;
  #state;
  #timeoutMs;

  constructor({
    runner,
    dataStore,
    timeoutMs = 60_000,
    clock = () => Date.now(),
  }) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (!dataStore || typeof dataStore.reload !== "function") {
      throw new TypeError("dataStore.reload must be a function");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000) {
      throw new TypeError("timeoutMs must be between 1,000 and 300,000");
    }
    this.#runner = runner;
    this.#dataStore = dataStore;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
    this.#state = {
      status: "idle",
      startedAt: null,
      finishedAt: null,
      result: null,
      errorCode: null,
    };
  }

  getStatus() {
    return structuredClone(this.#state);
  }

  isRunning() {
    return this.#inFlight !== null;
  }

  start() {
    if (this.#inFlight !== null) return false;
    const startedAt = this.#clock();
    this.#state = {
      status: "running",
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
      result: null,
      errorCode: null,
    };
    let timedOut = false;
    let timeout;
    const work = Promise.resolve()
      .then(() => this.#runner())
      .then(async (result) => {
        if (timedOut) return;
        await this.#dataStore.reload();
        this.#state = {
          status: "succeeded",
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: publicRefreshResult(result),
          errorCode: null,
        };
      })
      .catch(() => {
        if (timedOut) return;
        this.#state = {
          status: "failed",
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: null,
          errorCode: "refresh_failed",
        };
      })
      .finally(() => {
        clearTimeout(timeout);
        this.#inFlight = null;
      });
    timeout = setTimeout(() => {
      timedOut = true;
      this.#state = {
        status: "failed",
        startedAt: this.#state.startedAt,
        finishedAt: new Date(this.#clock()).toISOString(),
        result: null,
        errorCode: "refresh_timed_out",
      };
    }, this.#timeoutMs);
    timeout.unref?.();
    this.#inFlight = work;
    return true;
  }
}
