import { homedir } from "node:os";
import { join } from "node:path";
import { selectProductionAccountObservationSecret } from "./account-observation-production.js";
import { runCollectorOnce } from "./passive-collector.js";

const PUBLIC_REFRESH_ERROR_CODES = new Set([
  "app_server_unavailable",
  "malformed_output",
  "temporary_disconnect",
]);
const RECENT_INDEX_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const INDEXING_MODES = new Set(["recent_7d", "prospective"]);
const INDEXING_STATUSES = new Set([
  "recent_7d_indexing",
  "recent_7d_complete",
  "prospective_only",
  "bounded_pause",
]);
const INDEXING_PHASES = new Set([
  "discovering",
  "rollout_index",
  "quota_refresh",
  "complete",
  "paused",
  "prospective",
]);

function safeCollectorErrorCode(code) {
  return PUBLIC_REFRESH_ERROR_CODES.has(code) ? code : "collection_failed";
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCanonicalInstant(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function publicIndexingResult(value) {
  if (!value || !INDEXING_MODES.has(value.mode)
      || !INDEXING_STATUSES.has(value.status)
      || !INDEXING_PHASES.has(value.phase)
      || value.boundedBy !== "modified_at_and_collection_start") return null;
  const startAt = safeCanonicalInstant(value.coveredAt?.startAt);
  const endAt = value.coveredAt?.endAt === null
    ? null
    : safeCanonicalInstant(value.coveredAt?.endAt);
  if (startAt === null || (value.coveredAt?.endAt !== null && endAt === null)) return null;
  return {
    mode: value.mode,
    status: value.status,
    phase: value.phase,
    boundedBy: "modified_at_and_collection_start",
    filesDiscovered: safeCount(value.filesDiscovered),
    filesSelected: safeCount(value.filesSelected),
    filesProcessed: safeCount(value.filesProcessed),
    recordsWritten: safeCount(value.recordsWritten),
    coveredAt: { startAt, endAt },
  };
}

export function createLocalCollectorRefreshRunner({
  codexHome = join(homedir(), ".codex"),
  selectAccountObservationSecret = selectProductionAccountObservationSecret,
  runCollector = runCollectorOnce,
  clock = () => Date.now(),
  recentIndexWindowMs = RECENT_INDEX_WINDOW_MS,
} = {}) {
  if (typeof selectAccountObservationSecret !== "function") {
    throw new TypeError("selectAccountObservationSecret must be a function");
  }
  if (typeof runCollector !== "function") throw new TypeError("runCollector must be a function");
  if (typeof clock !== "function"
      || !Number.isSafeInteger(recentIndexWindowMs)
      || recentIndexWindowMs < 60_000
      || recentIndexWindowMs > 31 * 24 * 60 * 60 * 1_000) {
    throw new TypeError("recent index window is invalid");
  }
  return async function refreshLocalCollector({
    signal = null,
    onProgress = null,
  } = {}) {
    if (onProgress !== null && typeof onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
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
      backfill: true,
      backfillSinceAt: new Date(clock() - recentIndexWindowMs).toISOString(),
      signal,
      onProgress: async (value) => {
        const progress = publicIndexingResult(value);
        if (progress !== null) await onProgress?.(progress);
      },
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
      ...(publicIndexingResult(result?.indexing) === null
        ? {}
        : { indexing: publicIndexingResult(result.indexing) }),
    };
  };
}

function publicRefreshResult(result) {
  const projected = {
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
  const indexing = publicIndexingResult(result?.indexing);
  if (indexing !== null) projected.indexing = indexing;
  return projected;
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
      progress: null,
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
      progress: null,
      errorCode: null,
    };
    let timedOut = false;
    let timeout;
    const controller = new AbortController();
    const work = Promise.resolve()
      .then(() => this.#runner({
        signal: controller.signal,
        onProgress: (progress) => {
          if (timedOut || this.#state.status !== "running") return;
          this.#state = {
            ...this.#state,
            progress: publicIndexingResult(progress),
          };
        },
      }))
      .then(async (result) => {
        if (timedOut) {
          try {
            await this.#dataStore.reload();
          } catch {
            // The timeout remains authoritative; the last good dashboard
            // snapshot is already retained by the data store.
          }
          this.#state = {
            status: "failed",
            startedAt: this.#state.startedAt,
            finishedAt: this.#state.finishedAt
              ?? new Date(this.#clock()).toISOString(),
            result: publicRefreshResult(result),
            progress: publicIndexingResult(result?.indexing)
              ?? this.#state.progress,
            errorCode: "refresh_timed_out",
          };
          return;
        }
        await this.#dataStore.reload();
        this.#state = {
          status: "succeeded",
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: publicRefreshResult(result),
          progress: publicIndexingResult(result?.indexing),
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
          progress: this.#state.progress,
          errorCode: "refresh_failed",
        };
      })
      .finally(() => {
        clearTimeout(timeout);
        this.#inFlight = null;
      });
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      this.#state = {
        status: "failed",
        startedAt: this.#state.startedAt,
        finishedAt: new Date(this.#clock()).toISOString(),
        result: null,
        progress: this.#state.progress,
        errorCode: "refresh_timed_out",
      };
    }, this.#timeoutMs);
    timeout.unref?.();
    this.#inFlight = work;
    return true;
  }
}
