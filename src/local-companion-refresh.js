import { homedir } from "node:os";
import { join } from "node:path";
import { selectProductionAccountObservationSecret } from "./account-observation-production.js";
import { runCollectorOnce } from "./passive-collector.js";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  readReplaySafeAccountingCache,
} from "./replay-safe-accounting-cache.js";

const PUBLIC_REFRESH_ERROR_CODES = new Set([
  "app_server_unavailable",
  "malformed_output",
  "temporary_disconnect",
]);
const RECENT_INDEX_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const EARLY_HEADLINE_RECENT_RUN_BYTES = 64 * 1024 * 1024;
const MAX_REUSABLE_ACCOUNTING_CACHE_AGE_MS = 30 * 60 * 1_000;
const INDEXING_MODES = new Set(["recent_7d", "prospective"]);
const INDEXING_STATUSES = new Set([
  "recent_7d_indexing",
  "recent_7d_complete",
  "recent_7d_partial",
  "prospective_only",
  "bounded_pause",
]);
const INDEXING_PHASES = new Set([
  "discovering",
  "rollout_index",
  "quota_refresh",
  "quick_result",
  "complete",
  "paused",
  "prospective",
]);
const ACCOUNTING_REFRESH_STATUSES = new Set(["reused", "rebuilt"]);
const HEADLINE_READY_INDEXING_STATUSES = new Set([
  "recent_7d_complete",
  "recent_7d_partial",
  "prospective_only",
  "bounded_pause",
]);

function isResourceLimitedRefreshError(error) {
  const code = error?.code;
  return typeof code === "string"
    && (
      code.startsWith("accounting_scan_")
      || code.startsWith("accounting_transition_")
      || code.startsWith("export_resource_")
      || code.startsWith("collector_resource_")
    );
}

function collectorResourceLimit(result) {
  const limit = result?.resourceLimit;
  return limit && typeof limit === "object"
      && typeof limit.code === "string"
      && limit.code.startsWith("collector_resource_")
    ? limit
    : null;
}

function throwCollectorResourceLimit() {
  const error = new Error("collector_resource_limit_exceeded");
  error.code = "collector_resource_limit_exceeded";
  throw error;
}

function safeCollectorErrorCode(code) {
  return PUBLIC_REFRESH_ERROR_CODES.has(code) ? code : "collection_failed";
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addReportedCounts(left, right) {
  if (!Number.isSafeInteger(left) || left < 0
      || !Number.isSafeInteger(right) || right < 0) return null;
  return left > Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

function mergeReportedBooleans(left, right) {
  if (left === true || right === true) return true;
  return left === false && right === false ? false : null;
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
  const rawStartAt = value.coveredAt?.startAt;
  const startAt = rawStartAt === null ? null : safeCanonicalInstant(rawStartAt);
  const endAt = value.coveredAt?.endAt === null
    ? null
    : safeCanonicalInstant(value.coveredAt?.endAt);
  if ((startAt === null
        && !(value.status === "recent_7d_partial" && rawStartAt === null))
      || (value.coveredAt?.endAt !== null && endAt === null)) return null;
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

function mergeCollectorPasses(early, continued) {
  const earlyRefresh = early?.refresh ?? {};
  const continuedRefresh = continued?.refresh ?? {};
  const latestAttempt = continuedRefresh.attempted === true
    ? continuedRefresh
    : earlyRefresh;
  return {
    ...continued,
    rolloutRecordsWritten: addReportedCounts(
      early?.rolloutRecordsWritten,
      continued?.rolloutRecordsWritten,
    ),
    filesDiscovered: Math.max(
      safeCount(early?.filesDiscovered),
      safeCount(continued?.filesDiscovered),
    ),
    refresh: {
      attempted: mergeReportedBooleans(
        earlyRefresh.attempted,
        continuedRefresh.attempted,
      ),
      recordWritten: mergeReportedBooleans(
        earlyRefresh.recordWritten,
        continuedRefresh.recordWritten,
      ),
      errorCode: latestAttempt?.errorCode ?? null,
    },
  };
}

export function createLocalCollectorRefreshRunner({
  codexHome = join(homedir(), ".codex"),
  dataFile = null,
  checkpointFile = null,
  lockFile = null,
  journalFile = null,
  accountObservationOperationLockFile = null,
  selectAccountObservationSecret = selectProductionAccountObservationSecret,
  runCollector = runCollectorOnce,
  readAccountingCache = readReplaySafeAccountingCache,
  refreshAccounting = null,
  accountingCacheFile = null,
  // Collection-time capture of the Codex speed-mode baseline. Codex writes the
  // mode to the rollout log only when it is applied or changed, so a session's
  // baseline exists nowhere but the configuration's `service_tier` key - and
  // that key is rewritten on every toggle, so it proves only the value at the
  // moment it is read. Reading it here stamps it with that moment; it is never
  // used to backfill anything earlier. Returns the covering windows.
  recordCodexSpeedBaseline = null,
  clock = () => Date.now(),
  recentIndexWindowMs = RECENT_INDEX_WINDOW_MS,
} = {}) {
  if (typeof selectAccountObservationSecret !== "function") {
    throw new TypeError("selectAccountObservationSecret must be a function");
  }
  if (typeof runCollector !== "function") throw new TypeError("runCollector must be a function");
  if (typeof readAccountingCache !== "function") {
    throw new TypeError("readAccountingCache must be a function");
  }
  if (refreshAccounting !== null && typeof refreshAccounting !== "function") {
    throw new TypeError("refreshAccounting must be a function or null");
  }
  if (recordCodexSpeedBaseline !== null
      && typeof recordCodexSpeedBaseline !== "function") {
    throw new TypeError("recordCodexSpeedBaseline must be a function or null");
  }
  for (const [name, value] of Object.entries({
    dataFile,
    checkpointFile,
    lockFile,
    journalFile,
    accountObservationOperationLockFile,
    accountingCacheFile,
  })) {
    if (value !== null && (typeof value !== "string" || value.length < 1)) {
      throw new TypeError(`${name} must be a non-empty string or null`);
    }
  }
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
    // Record the declared baseline before the pass reads any usage, so the
    // reading is stamped no later than the turns it may attribute. A failure
    // here is never allowed to block collection: it simply leaves those turns
    // to the stated preference, or unknown.
    let declaredSpeedBaselines = [];
    if (recordCodexSpeedBaseline !== null) {
      try {
        const recorded = await recordCodexSpeedBaseline();
        if (Array.isArray(recorded)) declaredSpeedBaselines = recorded;
      } catch {
        declaredSpeedBaselines = [];
      }
    }
    let selection;
    try {
      selection = selectAccountObservationSecret(
        accountObservationOperationLockFile === null
          ? {}
          : {
            operationLockFile:
              accountObservationOperationLockFile,
          },
      );
    } catch {
      selection = { loadAccountObservationSecret: null };
    }
    const collectorOptions = {
      codexHome,
      ...(dataFile === null ? {} : { dataFile }),
      ...(checkpointFile === null ? {} : { checkpointFile }),
      ...(lockFile === null ? {} : { lockFile }),
      ...(journalFile === null ? {} : { journalFile }),
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
    };
    // The headline pass uses the collector's ordinary atomic ledger/checkpoint
    // path with a much smaller read budget. It therefore publishes only after
    // a durable bounded pass, while leaving the same checkpoint resumable.
    let result = await runCollector({
      ...collectorOptions,
      maximumRecentRunBytes: EARLY_HEADLINE_RECENT_RUN_BYTES,
    });
    let headlinePublished = false;
    const publishHeadline = async (indexing) => {
      if (headlinePublished
          || signal?.aborted === true
          || indexing === null
          || !HEADLINE_READY_INDEXING_STATUSES.has(indexing.status)) return;
      headlinePublished = true;
      await onProgress?.({
        ...indexing,
        phase: "quick_result",
      });
    };
    const earlyIndex = publicIndexingResult(result?.indexing);
    await publishHeadline(earlyIndex);
    if (earlyIndex?.status === "bounded_pause"
        && signal?.aborted !== true) {
      const earlyLimit = collectorResourceLimit(result);
      if (earlyLimit !== null
          && earlyLimit.dimension !== "source_bytes") {
        throwCollectorResourceLimit();
      }
      // Resume without the headline override so the collector's reviewed
      // normal-pass budget and source-consistency checks remain authoritative.
      const continued = await runCollector(collectorOptions);
      result = mergeCollectorPasses(result, continued);
      if (collectorResourceLimit(continued) !== null) {
        throwCollectorResourceLimit();
      }
    }
    const completedIndex = publicIndexingResult(result?.indexing);
    await publishHeadline(completedIndex);
    const accountingMayRun = completedIndex === null
      || ["recent_7d_complete", "recent_7d_partial", "prospective_only"]
        .includes(completedIndex.status);
    let accounting = null;
    let accountingRefreshStatus = null;
    if (refreshAccounting !== null && accountingMayRun) {
      // A provider quota observation does not alter replay-safe token
      // accounting. Reuse a current cache when no rollout usage record was
      // added, while the collector ledger continues to supply the fresh quota
      // card independently.
      const collectorWroteNoRolloutUsage =
        result?.rolloutRecordsWritten === 0;
      if (collectorWroteNoRolloutUsage && signal?.aborted !== true) {
        try {
          const existing = await readAccountingCache({
            ...(accountingCacheFile === null
              ? {}
              : { cacheFile: accountingCacheFile }),
            now: clock,
            maximumAgeMs: MAX_REUSABLE_ACCOUNTING_CACHE_AGE_MS,
          });
          if (signal?.aborted !== true
              && existing?.status === "available"
              && existing.cache?.schemaVersion
                === REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION) {
            accounting = existing.cache;
            accountingRefreshStatus = "reused";
          }
        } catch {
          // A failed cache read is never authoritative. Rebuild below.
        }
      }
      if (accounting === null) {
        accounting = await refreshAccounting({
          codexHome,
          ...(accountingCacheFile === null ? {} : { cacheFile: accountingCacheFile }),
          now: clock,
          windowDays: 31,
          declaredSpeedBaselines,
          signal,
        });
        accountingRefreshStatus = "rebuilt";
      }
    }
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
      ...(accounting === null
        ? {}
        : {
          accounting: {
            status: "replay_safe",
            refreshStatus: accountingRefreshStatus,
            generatedAt: accounting.generatedAt,
            events: accounting.periods
              ?.find((period) => period.id === "7d")?.events ?? 0,
            forkReplayEventsExcluded:
              accounting.diagnostics?.forkReplayEventsExcluded ?? 0,
          },
        }),
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
  if (result?.accounting?.status === "replay_safe"
      && safeCanonicalInstant(result.accounting.generatedAt) !== null) {
    projected.accounting = {
      status: "replay_safe",
      ...(ACCOUNTING_REFRESH_STATUSES.has(result.accounting.refreshStatus)
        ? { refreshStatus: result.accounting.refreshStatus }
        : {}),
      generatedAt: result.accounting.generatedAt,
      events: safeCount(result.accounting.events),
      forkReplayEventsExcluded:
        safeCount(result.accounting.forkReplayEventsExcluded),
    };
  }
  return projected;
}

export class LocalCompanionRefreshController {
  #abortController = null;
  #cancelRequested = false;
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
      quickResultAt: null,
      errorCode: null,
    };
  }

  getStatus() {
    return structuredClone(this.#state);
  }

  isRunning() {
    return this.#inFlight !== null;
  }

  cancel() {
    if (this.#inFlight === null
        || this.#abortController === null
        || this.#state.status !== "running"
        || this.#cancelRequested) return false;
    this.#cancelRequested = true;
    this.#state = {
      ...this.#state,
      status: "cancelling",
    };
    this.#abortController.abort();
    return true;
  }

  start() {
    if (this.#inFlight !== null) return false;
    const startedAt = this.#clock();
    this.#cancelRequested = false;
    this.#state = {
      status: "running",
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
      result: null,
      progress: null,
      quickResultAt: null,
      errorCode: null,
    };
    let timedOut = false;
    let timeout;
    const controller = new AbortController();
    this.#abortController = controller;
    const work = Promise.resolve()
      .then(() => this.#runner({
        signal: controller.signal,
        onProgress: async (progress) => {
          if (timedOut
              || !["running", "cancelling"].includes(this.#state.status)) return;
          const projected = publicIndexingResult(progress);
          if (projected === null) return;
          let quickResultAt = this.#state.quickResultAt;
          if (projected.phase === "quick_result"
              && !this.#cancelRequested) {
            try {
              await this.#dataStore.reload();
              quickResultAt = new Date(this.#clock()).toISOString();
            } catch {
              // Keep the previous good dashboard. Deep accounting can still
              // complete and publish a fully verified replacement.
            }
          }
          if (timedOut) return;
          this.#state = {
            ...this.#state,
            progress: projected,
            quickResultAt,
          };
        },
      }))
      .then(async (result) => {
        if (this.#cancelRequested) {
          try {
            await this.#dataStore.reload();
          } catch {
            // Cancellation preserves the last good dashboard snapshot.
          }
          this.#state = {
            status: "cancelled",
            startedAt: this.#state.startedAt,
            finishedAt: new Date(this.#clock()).toISOString(),
            result: publicRefreshResult(result),
            progress: publicIndexingResult(result?.indexing)
              ?? this.#state.progress,
            quickResultAt: this.#state.quickResultAt,
            errorCode: "refresh_cancelled",
          };
          return;
        }
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
            quickResultAt: this.#state.quickResultAt,
            errorCode: "refresh_timed_out",
          };
          return;
        }
        await this.#dataStore.reload();
        const finalProgress = publicIndexingResult(result?.indexing);
        this.#state = {
          status: "succeeded",
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: publicRefreshResult(result),
          progress: finalProgress?.status === "bounded_pause"
              && this.#state.quickResultAt !== null
            ? { ...finalProgress, phase: "quick_result" }
            : finalProgress,
          quickResultAt: this.#state.quickResultAt,
          errorCode: null,
        };
      })
      .catch((error) => {
        if (this.#cancelRequested) {
          this.#state = {
            status: "cancelled",
            startedAt: this.#state.startedAt,
            finishedAt: new Date(this.#clock()).toISOString(),
            result: null,
            progress: this.#state.progress,
            quickResultAt: this.#state.quickResultAt,
            errorCode: "refresh_cancelled",
          };
          return;
        }
        if (timedOut) return;
        this.#state = {
          status: "failed",
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: null,
          progress: this.#state.progress,
          quickResultAt: this.#state.quickResultAt,
          errorCode: isResourceLimitedRefreshError(error)
            ? "refresh_resource_limited"
            : "refresh_failed",
        };
      })
      .finally(() => {
        clearTimeout(timeout);
        this.#abortController = null;
        this.#cancelRequested = false;
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
        quickResultAt: this.#state.quickResultAt,
        errorCode: "refresh_timed_out",
      };
    }, this.#timeoutMs);
    timeout.unref?.();
    this.#inFlight = work;
    return true;
  }
}
