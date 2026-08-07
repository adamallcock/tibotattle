import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isValidQuotaWindowDuration,
} from "@app-usagemonitor/quota-analysis";
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
const EARLY_HEADLINE_RECENT_RUN_BYTES = 128 * 1024 * 1024;
// The first pass exists to make the dashboard useful quickly on machines with
// a large Codex history. Keep one individual rollout bounded as well as the
// whole pass: otherwise a single multi-gigabyte rollout can consume the entire
// headline budget before the UI receives either a result or a useful progress
// update. The normal resumable pass retains the wider collector limits.
const EARLY_HEADLINE_RECENT_TAIL_BYTES = 4 * 1024 * 1024;
const EARLY_HEADLINE_RECENT_PRELUDE_BYTES = 512 * 1024;
const EARLY_HEADLINE_BUFFERED_LINE_BYTES = 1024 * 1024;
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
const ARCHIVE_INDEX_STATUSES = new Set(["complete", "partial"]);
const ARCHIVE_INDEX_PHASES = new Set(["complete", "awaiting_resume"]);
const ARCHIVE_INDEX_ERROR_CODES = new Set([
  "archive_directory_entries",
  "archive_rollout_files",
  "archive_timeout",
  "archive_interrupted",
  "archive_disk_space",
  "archive_storage_unavailable",
  "archive_index_unavailable",
]);
const ARCHIVE_INDEX_PROGRESS_KIND = "archive_index";
const REFRESH_FAILURE_STEPS = new Set([
  "collector",
  "accounting",
  "archive_index",
  "unified_index",
  "assemble",
]);
const REFRESH_FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const HEADLINE_READY_INDEXING_STATUSES = new Set([
  "recent_7d_complete",
  "recent_7d_partial",
  "prospective_only",
  "bounded_pause",
]);
const QUOTA_NOTIFICATION_EVIDENCE_SCHEMA =
  "tibotattle-notification-evidence-v2";
const QUOTA_NOTIFICATION_LANES = new Set(["primary", "secondary"]);
const QUOTA_NOTIFICATION_CONTINUITY_KEY = /^[A-Za-z0-9_-]{43}$/u;
const MAX_NOTIFICATION_EVIDENCE_AGE_MS = 5 * 60 * 1_000;

function isResourceLimitedRefreshError(error) {
  const code = error?.code;
  return typeof code === "string"
    && (
      code.startsWith("accounting_scan_")
      || code.startsWith("accounting_transition_")
      || code.startsWith("export_resource_")
      || code.startsWith("collector_resource_")
      || code.startsWith("codex_log_discovery_")
      || code === "local_archive_index_timeout"
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

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

/**
 * The loopback response deliberately exposes a closed, minimal notification
 * contract instead of a dashboard/ledger projection.  Anything that is not
 * a just-collected direct provider observation is omitted rather than being
 * relabelled as fresh evidence for the native shell.
 */
function publicNotificationEvidence(value, now = Date.now()) {
  const evidenceKeys = [
    "continuityKey",
    "freshness",
    "observedAt",
    "provider",
    "schemaVersion",
    "source",
    "status",
    "windows",
  ];
  if (!hasExactKeys(value, evidenceKeys)
      || value.schemaVersion !== QUOTA_NOTIFICATION_EVIDENCE_SCHEMA
      || value.status !== "fresh_provider_observation"
      || value.provider !== "openai_codex"
      || value.source !== "app_server_read"
      || value.freshness !== "fresh"
      || safeCanonicalInstant(value.observedAt) === null
      || !QUOTA_NOTIFICATION_CONTINUITY_KEY.test(value.continuityKey)
      || !Array.isArray(value.windows)
      || value.windows.length < 1
      || value.windows.length > QUOTA_NOTIFICATION_LANES.size) return null;
  const ageMs = now - Date.parse(value.observedAt);
  if (!Number.isFinite(now)
      || !Number.isFinite(ageMs)
      || ageMs < 0
      || ageMs > MAX_NOTIFICATION_EVIDENCE_AGE_MS) return null;
  const seenLanes = new Set();
  const windows = [];
  for (const window of value.windows) {
    if (!hasExactKeys(window, [
      "durationMinutes",
      "lane",
      "resetAt",
      "resetProofKind",
      "usedPercent",
    ])
        || !QUOTA_NOTIFICATION_LANES.has(window.lane)
        || seenLanes.has(window.lane)
        || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0
        || window.usedPercent > 100
        || !Number.isSafeInteger(window.durationMinutes)
        || !isValidQuotaWindowDuration(window.durationMinutes)
        || safeCanonicalInstant(window.resetAt) === null
        || Date.parse(window.resetAt) <= Date.parse(value.observedAt)
        || window.resetProofKind !== "provider_reported_schedule_only") return null;
    seenLanes.add(window.lane);
    windows.push({
      lane: window.lane,
      usedPercent: window.usedPercent,
      durationMinutes: window.durationMinutes,
      resetAt: window.resetAt,
      resetProofKind: "provider_reported_schedule_only",
    });
  }
  return {
    schemaVersion: QUOTA_NOTIFICATION_EVIDENCE_SCHEMA,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: value.observedAt,
    continuityKey: value.continuityKey,
    windows: windows.sort((left, right) => left.lane.localeCompare(right.lane)),
  };
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

function publicArchiveIndexResult(value) {
  if (!value || !ARCHIVE_INDEX_STATUSES.has(value.status)
      || !ARCHIVE_INDEX_PHASES.has(value.phase)
      || safeCanonicalInstant(value.generatedAt) === null
      || safeCanonicalInstant(value.coveredAt?.startAt) === null
      || safeCanonicalInstant(value.coveredAt?.endAt) === null
      || !Number.isSafeInteger(value.sourceCount)
      || value.sourceCount < 0
      || !Number.isSafeInteger(value.indexedSourceCount)
      || value.indexedSourceCount < 0
      || !Number.isSafeInteger(value.pendingSourceCount)
      || value.pendingSourceCount < 0
      || value.indexedSourceCount + value.pendingSourceCount
        !== value.sourceCount
      || !Number.isSafeInteger(value.sourceBytes)
      || value.sourceBytes < 0
      || !Number.isSafeInteger(value.indexedBytes)
      || value.indexedBytes < 0
      || value.indexedBytes > value.sourceBytes
      || !Number.isSafeInteger(value.readBudgetBytes)
      || value.readBudgetBytes < 1
      || !Number.isSafeInteger(value.scanBytes)
      || value.scanBytes < 0) return null;
  return {
    status: value.status,
    phase: value.phase,
    generatedAt: value.generatedAt,
    coveredAt: {
      startAt: value.coveredAt.startAt,
      endAt: value.coveredAt.endAt,
    },
    sourceCount: value.sourceCount,
    indexedSourceCount: value.indexedSourceCount,
    pendingSourceCount: value.pendingSourceCount,
    sourceBytes: value.sourceBytes,
    indexedBytes: value.indexedBytes,
    readBudgetBytes: value.readBudgetBytes,
    scanBytes: value.scanBytes,
    ...(ARCHIVE_INDEX_ERROR_CODES.has(value.errorCode)
      ? { errorCode: value.errorCode }
      : {}),
  };
}

function publicArchiveIndexProgress(value) {
  return value?.kind === ARCHIVE_INDEX_PROGRESS_KIND
      && value.status === "scanning"
    ? { kind: ARCHIVE_INDEX_PROGRESS_KIND, status: "scanning" }
    : null;
}

function publicRefreshProgress(value) {
  return publicIndexingResult(value) ?? publicArchiveIndexProgress(value);
}

function terminalRefreshProgress(value) {
  return value?.kind === ARCHIVE_INDEX_PROGRESS_KIND ? null : value;
}

function mergeCollectorPasses(early, continued, now = Date.now()) {
  const earlyRefresh = early?.refresh ?? {};
  const continuedRefresh = continued?.refresh ?? {};
  const latestAttempt = continuedRefresh.attempted === true
    ? continuedRefresh
    : earlyRefresh;
  const notificationEvidence = publicNotificationEvidence(
    latestAttempt?.notificationEvidence,
    now,
  );
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
      ...(notificationEvidence === null
        ? {}
        : { notificationEvidence }),
    },
  };
}

export function createLocalCollectorRefreshRunner({
  codexHome = join(homedir(), ".codex"),
  stateFile = null,
  accountObservationOperationLockFile = null,
  selectAccountObservationSecret = selectProductionAccountObservationSecret,
  runCollector = runCollectorOnce,
  readAccountingCache = readReplaySafeAccountingCache,
  refreshAccounting = null,
  refreshArchiveIndex = null,
  archiveIndexFile = null,
  archiveIndexSecretFile = null,
  // Cursor-based incremental advance of the unified local index. An ordinary
  // pass reads only the bytes the rollout corpus grew since the last one, so
  // it is safe to run on every foreground refresh.
  refreshUnifiedIndex = null,
  unifiedIndexFile = null,
  unifiedIndexSecretFile = null,
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
  if (refreshArchiveIndex !== null && typeof refreshArchiveIndex !== "function") {
    throw new TypeError("refreshArchiveIndex must be a function or null");
  }
  if (refreshUnifiedIndex !== null && typeof refreshUnifiedIndex !== "function") {
    throw new TypeError("refreshUnifiedIndex must be a function or null");
  }
  if (recordCodexSpeedBaseline !== null
      && typeof recordCodexSpeedBaseline !== "function") {
    throw new TypeError("recordCodexSpeedBaseline must be a function or null");
  }
  for (const [name, value] of Object.entries({
    stateFile,
    accountObservationOperationLockFile,
    archiveIndexFile,
    archiveIndexSecretFile,
    unifiedIndexFile,
    unifiedIndexSecretFile,
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
    // A refresh failure that reaches the app collapses to one generic code,
    // and companion stderr is deliberately discarded. Stamp every escaping
    // error with the pipeline step it left from, so the refresh status can
    // name the failing step without carrying content.
    let refreshStep = "collector";
    const stampStep = (error) => {
      if (error !== null && typeof error === "object"
          && error.refreshStep === undefined) {
        error.refreshStep = refreshStep;
      }
      throw error;
    };
    try {
      return await (async () => {
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
      ...(stateFile === null ? {} : { stateFile }),
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
    // The headline pass uses the collector's ordinary atomic SQLite state
    // transaction with a much smaller read budget. It therefore publishes
    // only after a durable bounded pass, while leaving the same checkpoint
    // resumable.
    let result = await runCollector({
      ...collectorOptions,
      maximumRecentRunBytes: EARLY_HEADLINE_RECENT_RUN_BYTES,
      maximumRecentTailBytes: EARLY_HEADLINE_RECENT_TAIL_BYTES,
      maximumRecentPreludeBytes: EARLY_HEADLINE_RECENT_PRELUDE_BYTES,
      maximumBufferedLineBytes: EARLY_HEADLINE_BUFFERED_LINE_BYTES,
    });
    let headlinePublished = false;
    let collectorResourceLimitDeferred = false;
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
        // Preserve the foreground resource-limit receipt, but let the
        // independent archive pass use this same bounded refresh to advance
        // its own checkpoint before the receipt is surfaced.
        collectorResourceLimitDeferred = true;
      } else {
        // Resume without the headline override so the collector's reviewed
        // normal-pass budget and source-consistency checks remain authoritative.
        const continued = await runCollector(collectorOptions);
        result = mergeCollectorPasses(result, continued, clock());
        if (collectorResourceLimit(continued) !== null) {
          collectorResourceLimitDeferred = true;
        }
      }
    }
    const completedIndex = publicIndexingResult(result?.indexing);
    await publishHeadline(completedIndex);
    const accountingMayRun = completedIndex === null
      || ["recent_7d_complete", "recent_7d_partial", "prospective_only"]
        .includes(completedIndex.status);
    let accounting = null;
    let accountingRefreshStatus = null;
    refreshStep = "accounting";
    if (refreshAccounting !== null && accountingMayRun) {
      // A provider quota observation does not alter replay-safe token
      // accounting. Reuse a current cache when no rollout usage record was
      // added, while the collector state continues to supply the fresh quota
      // card independently.
      const collectorWroteNoRolloutUsage =
        result?.rolloutRecordsWritten === 0;
      if (collectorWroteNoRolloutUsage && signal?.aborted !== true) {
        try {
          const existing = await readAccountingCache({
            ...(stateFile === null ? {} : { stateFile }),
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
          ...(stateFile === null ? {} : { stateFile }),
          now: clock,
          windowDays: 31,
          declaredSpeedBaselines,
          signal,
        });
        accountingRefreshStatus = "rebuilt";
      }
    }
    const notificationEvidence = publicNotificationEvidence(
      result?.refresh?.notificationEvidence,
      clock(),
    );
    let archiveIndex = null;
    refreshStep = "archive_index";
    if (refreshArchiveIndex !== null
        && signal?.aborted !== true) {
      // Archive coverage is independent of the recent collector's accounting
      // gate. A bounded recent pass may remain paused while this one foreground
      // refresh still advances the archive's durable source offsets. The
      // callback is invoked at most once per runner invocation; there is no
      // background continuation.
      await onProgress?.({
        kind: ARCHIVE_INDEX_PROGRESS_KIND,
        status: "scanning",
      });
      archiveIndex = await refreshArchiveIndex({
        codexHome,
        ...(archiveIndexFile === null ? {} : { indexFile: archiveIndexFile }),
        ...(archiveIndexSecretFile === null
          ? {}
          : { secretFile: archiveIndexSecretFile }),
        declaredSpeedBaselines,
        now: clock,
        signal,
      });
    }
    let unifiedIndex = null;
    refreshStep = "unified_index";
    if (refreshUnifiedIndex !== null && signal?.aborted !== true) {
      // The unified index advances by its cursors, so this ordinarily reads
      // only appended bytes. A failure here must never block collection or
      // quota reporting: the snapshot degrades honestly to the bounded window
      // and says so.
      try {
        unifiedIndex = publicUnifiedIndexResult(await refreshUnifiedIndex({
          codexHome,
          ...(unifiedIndexFile === null ? {} : { indexFile: unifiedIndexFile }),
          ...(unifiedIndexSecretFile === null
            ? {}
            : { secretFile: unifiedIndexSecretFile }),
          signal,
        }));
      } catch (error) {
        unifiedIndex = {
          status: "failed",
          errorCode: typeof error?.code === "string"
              && error.code.startsWith("local_unified_index_")
            ? error.code
            : "local_unified_index_refresh_failed",
        };
      }
    }
    refreshStep = "assemble";
    if (collectorResourceLimitDeferred) throwCollectorResourceLimit();
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
      ...(notificationEvidence === null ? {} : { notificationEvidence }),
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
      ...(publicArchiveIndexResult(archiveIndex) === null
        ? {}
        : { archiveIndex: publicArchiveIndexResult(archiveIndex) }),
      ...(unifiedIndex === null ? {} : { unifiedIndex }),
      ...(publicIndexingResult(result?.indexing) === null
        ? {}
        : { indexing: publicIndexingResult(result.indexing) }),
    };
      })();
    } catch (error) {
      stampStep(error);
    }
  };
}

// Content-free projection of an incremental unified-index pass: counts,
// bytes and timings only. Anything malformed collapses to a typed failure
// rather than leaking whatever shape the ingest returned.
function publicUnifiedIndexResult(value) {
  if (value?.status !== "ingested") {
    return { status: "failed", errorCode: "local_unified_index_refresh_failed" };
  }
  const counts = {};
  for (const key of [
    "sources",
    "sourcesSkipped",
    "sourcesTouched",
    "sourcesResumed",
    "sourcesRescanned",
    "sourcesScanned",
    "bytesScanned",
    "forkReplayEventsSkipped",
    "unattributedForkReplayEventsSkipped",
    "insertedUsageEvents",
    "totalUsageEvents",
  ]) {
    counts[key] = Number.isSafeInteger(value[key]) && value[key] >= 0
      ? value[key]
      : 0;
  }
  return {
    status: "ingested",
    ...counts,
    wallMs: Number.isFinite(value.wallMs) && value.wallMs >= 0
      ? Math.round(value.wallMs)
      : 0,
  };
}

function publicRefreshResult(result, now = Date.now()) {
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
  const notificationEvidence = publicNotificationEvidence(
    result?.notificationEvidence,
    now,
  );
  if (notificationEvidence !== null) {
    projected.notificationEvidence = notificationEvidence;
  }
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
  const archiveIndex = publicArchiveIndexResult(result?.archiveIndex);
  if (archiveIndex !== null) projected.archiveIndex = archiveIndex;
  return projected;
}

export class LocalCompanionRefreshController {
  #abortController = null;
  #cancelRequested = false;
  #clock;
  #createRefreshId;
  #dataStore;
  #inFlight = null;
  #runner;
  #state;
  #timeoutMs;

  constructor({
    runner,
    dataStore,
    timeoutMs = 5 * 60_000,
    clock = () => Date.now(),
    createRefreshId = randomUUID,
  }) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (!dataStore || typeof dataStore.reload !== "function") {
      throw new TypeError("dataStore.reload must be a function");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000) {
      throw new TypeError("timeoutMs must be between 1,000 and 300,000");
    }
    if (typeof createRefreshId !== "function") {
      throw new TypeError("createRefreshId must be a function");
    }
    this.#runner = runner;
    this.#dataStore = dataStore;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
    this.#createRefreshId = createRefreshId;
    this.#state = {
      status: "idle",
      refreshId: null,
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
    const refreshId = this.#createRefreshId();
    if (typeof refreshId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(refreshId)) {
      throw new TypeError("createRefreshId must return a UUID");
    }
    this.#cancelRequested = false;
    this.#state = {
      status: "running",
      refreshId,
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
          const projected = publicRefreshProgress(progress);
          if (projected === null) return;
          let quickResultAt = this.#state.quickResultAt;
          if (projected.kind !== ARCHIVE_INDEX_PROGRESS_KIND
              && projected.phase === "quick_result"
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
            refreshId: this.#state.refreshId,
            startedAt: this.#state.startedAt,
            finishedAt: new Date(this.#clock()).toISOString(),
            result: publicRefreshResult(result, this.#clock()),
            progress: publicIndexingResult(result?.indexing)
              ?? (this.#state.progress?.kind === ARCHIVE_INDEX_PROGRESS_KIND
                ? null
                : this.#state.progress),
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
            refreshId: this.#state.refreshId,
            startedAt: this.#state.startedAt,
            finishedAt: this.#state.finishedAt
              ?? new Date(this.#clock()).toISOString(),
            result: publicRefreshResult(result, this.#clock()),
            progress: publicIndexingResult(result?.indexing)
              ?? (this.#state.progress?.kind === ARCHIVE_INDEX_PROGRESS_KIND
                ? null
                : this.#state.progress),
            quickResultAt: this.#state.quickResultAt,
            errorCode: "refresh_timed_out",
          };
          return;
        }
        await this.#dataStore.reload();
        const finalProgress = publicIndexingResult(result?.indexing);
        this.#state = {
          status: "succeeded",
          refreshId: this.#state.refreshId,
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: publicRefreshResult(result, this.#clock()),
          progress: finalProgress?.status === "bounded_pause"
              && this.#state.quickResultAt !== null
            ? { ...finalProgress, phase: "quick_result" }
            : finalProgress,
          quickResultAt: this.#state.quickResultAt,
          errorCode: null,
        };
      })
      .catch(async (error) => {
        if (this.#cancelRequested) {
          this.#state = {
            status: "cancelled",
            refreshId: this.#state.refreshId,
            startedAt: this.#state.startedAt,
            finishedAt: new Date(this.#clock()).toISOString(),
            result: null,
            progress: terminalRefreshProgress(this.#state.progress),
            quickResultAt: this.#state.quickResultAt,
            errorCode: "refresh_cancelled",
          };
          return;
        }
        if (timedOut) return;
        if (error?.code === "collector_resource_limit_exceeded") {
          // The runner may have completed one independent archive checkpoint
          // before surfacing the recent collector's fixed safety stop. Publish
          // that content-free coverage receipt while retaining the previous
          // foreground result.
          try {
            await this.#dataStore.reload();
          } catch {
            // Keep the prior good dashboard if the receipt reload is unavailable.
          }
        }
        this.#state = {
          status: "failed",
          refreshId: this.#state.refreshId,
          startedAt: this.#state.startedAt,
          finishedAt: new Date(this.#clock()).toISOString(),
          result: null,
          progress: terminalRefreshProgress(this.#state.progress),
          quickResultAt: this.#state.quickResultAt,
          errorCode: isResourceLimitedRefreshError(error)
            ? "refresh_resource_limited"
            : "refresh_failed",
          // Content-free failure identity: a fixed step name and a bounded
          // machine code, never message text. Without these every failure
          // collapses into one undiagnosable "refresh_failed".
          ...(REFRESH_FAILURE_STEPS.has(error?.refreshStep)
            ? { failedStep: error.refreshStep }
            : {}),
          ...(typeof error?.code === "string"
              && REFRESH_FAILURE_CODE_PATTERN.test(error.code)
            ? { failureCode: error.code }
            : {}),
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
        refreshId: this.#state.refreshId,
        startedAt: this.#state.startedAt,
        finishedAt: new Date(this.#clock()).toISOString(),
        result: null,
        progress: terminalRefreshProgress(this.#state.progress),
        quickResultAt: this.#state.quickResultAt,
        errorCode: "refresh_timed_out",
      };
    }, this.#timeoutMs);
    timeout.unref?.();
    this.#inFlight = work;
    return true;
  }
}
