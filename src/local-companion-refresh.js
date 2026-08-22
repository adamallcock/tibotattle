import { randomInt, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isValidQuotaWindowDuration,
} from "@app-usagemonitor/quota-analysis";
import { selectProductionAccountObservationSecret } from "./account-observation-production.js";
import {
  LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX,
  LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION,
  recordLocalCollectorLegacyRefreshAttempt,
} from "./local-collector-state.js";
import { runCollectorOnce } from "./passive-collector.js";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  readReplaySafeAccountingCache,
} from "./replay-safe-accounting-cache.js";
import {
  assertWindowsFilesystemProductionSafe,
  isWindowsFilesystemAdapter,
  isWindowsQualificationModeContextFor,
  withLocalCollectorStateSessionBoundary,
} from "./platform/index.js";

const PUBLIC_REFRESH_ERROR_CODES = new Set([
  "app_server_unavailable",
  "malformed_output",
  "temporary_disconnect",
]);
const CLAUDE_QUOTA_PROVIDER = "anthropic_claude_code";
const CLAUDE_QUOTA_AUTHORITY = "claude_desktop_plan_history";
const CLAUDE_QUOTA_STATUSES = new Set(["available", "stale", "unavailable"]);
const CLAUDE_QUOTA_SOURCE_STATUSES = new Set([
  "present",
  "missing_suspected",
  "inaccessible",
  "partial",
]);
const CLAUDE_QUOTA_FRESHNESS = new Set(["fresh", "stale"]);
const CLAUDE_QUOTA_COVERAGE = new Set(["complete", "partial", "unavailable"]);
const CLAUDE_QUOTA_METERS = new Set([
  "five_hour",
  "seven_day_all_models",
  "extra_usage",
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
// After an accounting rebuild misses its memory budget the FULL rebuild is
// backed off for this long. The refresh endpoint is driven by an external
// ~5-minute scheduler, and without a backoff every tick re-ran the same doomed
// pass — the live incident looped that way for five hours, blanking the
// dashboard on each miss. During the backoff the cheap recent collector pass
// and quota refresh still run and the retained accounting cache is served, so
// the surface stays populated instead of flip-flopping; a successful rebuild
// clears the backoff immediately.
const ACCOUNTING_REBUILD_BUDGET_BACKOFF_MS = 30 * 60 * 1_000;
// Standing owner rule (2026-08-08, after five rounds of cap-shuffling): NEVER
// introduce or retain small data-window caps — a history limit is either
// absent or extreme (365+ days), never convenience-sized. 31 and 93 were both
// wrong. This window now bounds only the periods/timeline scan; the
// calibration corpus itself is sourced from the unified index (no time bound
// at all) whenever that index is present.
const ACCOUNTING_SCAN_WINDOW_DAYS = 365;
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
const ACCOUNTING_REFRESH_STATUSES = new Set(["reused", "rebuilt", "deferred"]);
const GENERATION_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
// Accounting reader failures are deliberately closed over a fixed vocabulary.
// A caller-controlled `accounting_*` string must never become a public
// diagnostic or an implicit promise that an unreviewed failure is safe to
// expose.
const ACCOUNTING_UNAVAILABLE_CODES = new Set([
  "accounting_unified_source_unavailable",
  "accounting_unified_coverage_incomplete",
  "accounting_unified_coverage_unavailable",
  "accounting_unified_index_missing",
  "accounting_unified_index_unavailable",
  "accounting_unified_generation_changed",
  "accounting_unified_generation_mismatch",
  "accounting_unified_generation_required",
  "accounting_unified_generation_unavailable",
  "accounting_unified_index_incompatible",
  "accounting_unified_index_invalid",
  "accounting_unified_read_failed",
  "accounting_unified_callback_failed",
  "accounting_unified_history_unavailable",
  "accounting_calibration_corpus_unavailable",
  "accounting_history_unavailable",
  "accounting_refresh_aborted",
]);
const ACCOUNTING_RESOURCE_LIMIT_CODES = new Set([
  "accounting_scan_source_bytes_limit_exceeded",
  "accounting_scan_rss_limit_exceeded",
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_transition_usage_limit_exceeded",
  "accounting_transition_snapshot_limit_exceeded",
  "accounting_transition_input_limit_exceeded",
  "accounting_transition_derivation_limit_exceeded",
  "accounting_archive_rss_limit_exceeded",
]);
const ACCOUNTING_TERMINAL_FAILURE_CODES = new Set([
  "accounting_transition_rss_measurement_invalid",
  "accounting_archive_rss_measurement_invalid",
]);
// Only reviewed, content-free unified-index failures may cross the public
// refresh boundary. Prefix/shape validation is insufficient here: an
// arbitrary internal string can still be well formed while carrying an
// unreviewed diagnostic promise.
const UNIFIED_INDEX_PUBLIC_ERROR_CODES = new Set([
  "local_unified_index_aborted",
  "local_unified_index_directory_sync_failed",
  "local_unified_index_file_changed",
  "local_unified_index_file_invalid",
  "local_unified_index_generation_invalid",
  "local_unified_index_generation_mismatch",
  "local_unified_index_integrity_failed",
  "local_unified_index_journal_mode_refused",
  "local_unified_index_meta_invalid",
  "local_unified_index_missing",
  "local_unified_index_publication_durability_uncertain",
  "local_unified_index_schema_invalid",
  "local_unified_index_secondary_indexes_failed",
  "local_unified_index_secondary_indexes_missing",
  "local_unified_index_secret_invalid",
  "local_unified_index_secret_unavailable",
  "local_unified_index_unavailable",
  "local_unified_index_worker_failed",
]);
const DEFAULT_UNIFIED_INDEX_PUBLIC_ERROR_CODE =
  "local_unified_index_refresh_failed";
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

function safeUnifiedIndexPublicErrorCode(value) {
  return UNIFIED_INDEX_PUBLIC_ERROR_CODES.has(value)
    ? value
    : DEFAULT_UNIFIED_INDEX_PUBLIC_ERROR_CODE;
}

// A five-hour refresh_resource_limited loop once wrote NOTHING to
// diagnostics-v0.1.log: the terminal classification lived only in the
// in-memory refresh state, so once the dashboard moved on there was zero
// local trail. Every terminal refresh failure now files one bounded note —
// codes and a step name only, matching the log's privacy posture.
//
// Rate limit: a scheduler retry loop repeats an identical failure signature
// every few minutes (the incident looped for five hours), so one note per
// distinct (code, step, detail) signature per hour bounds that loop to 24
// lines/day (~4 KB against the log's 256 KiB cap) while a genuinely NEW
// signature — a different terminal code, failing step, or underlying typed
// error — is never suppressed and lands immediately.
const REFRESH_FAILURE_NOTE_INTERVAL_MS = 60 * 60 * 1_000;
// The signature map cannot grow with a pathological churn of codes: bounded
// vocabulary in practice, hard-capped here regardless.
const REFRESH_FAILURE_NOTE_SIGNATURE_LIMIT = 64;
const REFRESH_FAILURE_NOTE_SURFACE = "local_refresh";
// Same alphabet the dashboard mints references from (Crockford-style base32,
// no I/L/O/U), so a server-minted note is quotable to support exactly like a
// dashboard-minted one.
const DIAGNOSTIC_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The onTerminalFailure sink for LocalCompanionRefreshController: shapes a
 * terminal refresh failure into one bounded diagnostics note and rate-limits
 * it. Everything written is either chosen from a fixed set (surface, step),
 * identifier-shaped and pattern-checked (codes), or minted here (the
 * reference). No message text, path, or payload can pass through.
 */
export function createTerminalRefreshFailureRecorder({
  recordNote,
  clock = () => Date.now(),
  randomIndex = (bound) => randomInt(bound),
} = {}) {
  if (typeof recordNote !== "function") {
    throw new TypeError("recordNote must be a function");
  }
  if (typeof clock !== "function" || typeof randomIndex !== "function") {
    throw new TypeError("terminal refresh failure recorder controls are invalid");
  }
  const lastNoteAtBySignature = new Map();
  return async function recordTerminalRefreshFailure(failure) {
    const code = typeof failure?.errorCode === "string"
        && REFRESH_FAILURE_CODE_PATTERN.test(failure.errorCode)
      ? failure.errorCode
      : "refresh_failed";
    const step = REFRESH_FAILURE_STEPS.has(failure?.failedStep)
      ? failure.failedStep
      : null;
    const detail = typeof failure?.failureCode === "string"
        && REFRESH_FAILURE_CODE_PATTERN.test(failure.failureCode)
        && failure.failureCode !== code
      ? failure.failureCode
      : null;
    const signature = `${code}\0${step ?? ""}\0${detail ?? ""}`;
    const now = clock();
    const lastAt = lastNoteAtBySignature.get(signature);
    if (Number.isFinite(lastAt)
        && now - lastAt < REFRESH_FAILURE_NOTE_INTERVAL_MS) {
      return false;
    }
    // Re-inserting keeps the map in recency order, so the hard cap evicts the
    // stalest signature. The stamp lands BEFORE the write: a broken log can
    // cost this hour's line, never turn the failure loop into a write storm.
    lastNoteAtBySignature.delete(signature);
    lastNoteAtBySignature.set(signature, now);
    if (lastNoteAtBySignature.size > REFRESH_FAILURE_NOTE_SIGNATURE_LIMIT) {
      lastNoteAtBySignature.delete(
        lastNoteAtBySignature.keys().next().value,
      );
    }
    let reference = "TT-";
    for (let symbol = 0; symbol < 6; symbol += 1) {
      reference += DIAGNOSTIC_REFERENCE_ALPHABET[randomIndex(32)];
    }
    try {
      await recordNote({
        reference,
        surface: REFRESH_FAILURE_NOTE_SURFACE,
        code,
        requestId: "",
        ...(step === null ? {} : { step }),
        ...(detail === null ? {} : { detail }),
      });
    } catch {
      // The diagnostics trail must never affect the refresh outcome.
      return false;
    }
    return true;
  };
}

/**
 * The onDegradedOutcome sink for LocalCompanionRefreshController: a rebuild
 * that missed its memory budget is now a SOFT outcome (the refresh succeeds
 * serving the retained cache), so the terminal-failure recorder never sees it.
 * This files the one bounded, rate-limited diagnostics note that keeps the
 * trail the incident was found by — a fixed surface/code/step plus the budget
 * reason code, no message text, path, or payload. Rate-limited on the same
 * (code, step, detail) signature cadence as the terminal recorder so a backed
 * off scheduler loop cannot turn it into a write storm.
 */
export function createDeferredAccountingRebuildRecorder({
  recordNote,
  clock = () => Date.now(),
  randomIndex = (bound) => randomInt(bound),
} = {}) {
  if (typeof recordNote !== "function") {
    throw new TypeError("recordNote must be a function");
  }
  if (typeof clock !== "function" || typeof randomIndex !== "function") {
    throw new TypeError("deferred accounting rebuild recorder controls are invalid");
  }
  const lastNoteAtBySignature = new Map();
  return async function recordDeferredAccountingRebuild(outcome) {
    const detail = typeof outcome?.reason === "string"
        && REFRESH_FAILURE_CODE_PATTERN.test(outcome.reason)
      ? outcome.reason
      : null;
    const signature = `accounting_rebuild_deferred\0accounting\0${detail ?? ""}`;
    const now = clock();
    const lastAt = lastNoteAtBySignature.get(signature);
    if (Number.isFinite(lastAt)
        && now - lastAt < REFRESH_FAILURE_NOTE_INTERVAL_MS) {
      return false;
    }
    lastNoteAtBySignature.delete(signature);
    lastNoteAtBySignature.set(signature, now);
    if (lastNoteAtBySignature.size > REFRESH_FAILURE_NOTE_SIGNATURE_LIMIT) {
      lastNoteAtBySignature.delete(
        lastNoteAtBySignature.keys().next().value,
      );
    }
    let reference = "TT-";
    for (let symbol = 0; symbol < 6; symbol += 1) {
      reference += DIAGNOSTIC_REFERENCE_ALPHABET[randomIndex(32)];
    }
    try {
      await recordNote({
        reference,
        surface: REFRESH_FAILURE_NOTE_SURFACE,
        code: "accounting_rebuild_deferred",
        requestId: "",
        step: "accounting",
        ...(detail === null ? {} : { detail }),
        // The guard's own three quantities when it recorded them. The note
        // writer re-validates and drops anything that is not the closed
        // three-key MiB shape, so this can only ever add integers.
        ...(outcome?.measurements == null
          ? {}
          : { measurements: outcome.measurements }),
      });
    } catch {
      // The diagnostics trail must never affect the refresh outcome.
      return false;
    }
    return true;
  };
}

function isResourceLimitedRefreshError(error) {
  const code = error?.code;
  return typeof code === "string"
    && (
      ACCOUNTING_RESOURCE_LIMIT_CODES.has(code)
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

function fixedWindowsCollectorStateUnavailable() {
  const error = new Error("local_collector_state_unavailable");
  error.code = "local_collector_state_unavailable";
  return error;
}

function assertWindowsCollectorFilesystemBoundary({
  adapter,
  windowsQualificationModeContext = null,
  stateRoot = null,
  resourceRoot = null,
} = {}) {
  if (process.platform === "win32" && adapter === null) {
    throw fixedWindowsCollectorStateUnavailable();
  }
  if (adapter === null) return;
  // A shape-compatible object, or a copied native adapter, is not an
  // authenticated boundary. The central module brands only adapters it
  // created, and its production assertion remains disabled until the native
  // state/JOURNAL/WAL sidecars are qualified.
  if (!isWindowsFilesystemAdapter(adapter)) {
    throw fixedWindowsCollectorStateUnavailable();
  }
  if (windowsQualificationModeContext !== null) {
    let qualificationBinding = false;
    try {
      qualificationBinding = isWindowsQualificationModeContextFor({
        context: windowsQualificationModeContext,
        adapter,
        stateRoot,
        resourceRoot,
      }) === true
        && windowsQualificationModeContext.qualificationOnly === true
        && windowsQualificationModeContext.productionSafe === false
        && adapter.productionSafe === false
        && adapter.sqliteStateLeaseSafe === false;
    } catch {
      qualificationBinding = false;
    }
    if (!qualificationBinding) throw fixedWindowsCollectorStateUnavailable();
    return;
  }
  try {
    assertWindowsFilesystemProductionSafe(adapter);
  } catch {
    throw fixedWindowsCollectorStateUnavailable();
  }
  // The current adapter deliberately reports sqliteStateLeaseSafe=false, so
  // this remains a fail-closed gate today.  Once the native lease and its
  // sidecar qualification are positively proven, the state-session boundary
  // below becomes the only Windows database path.
  if (process.platform === "win32"
      && adapter.sqliteStateLeaseSafe !== true) {
    throw fixedWindowsCollectorStateUnavailable();
  }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeGenerationToken(value) {
  if (typeof value === "string" && GENERATION_TOKEN_PATTERN.test(value)) {
    return value;
  }
  if (Number.isSafeInteger(value) && value >= 1) return String(value);
  return null;
}

function publicUnifiedGeneration(value) {
  const source = value?.generationDescriptor ?? value?.generation;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const id = Number(source.id ?? source.generationId);
  const fingerprint = safeGenerationToken(
    source.fingerprint ?? source.generationFingerprint,
  );
  const status = ["complete", "partial"].includes(source.status)
    ? source.status
    : null;
  if (!Number.isSafeInteger(id) || id < 1 || fingerprint === null
      || status === null) {
    return null;
  }
  const token = (candidate) => safeGenerationToken(candidate);
  // The runner projects the ingest descriptor before it uses the generation
  // as accounting authority, and the controller projects the complete runner
  // result once more for the HTTP receipt. Accept both the internal
  // millisecond/count names and that already-bounded public shape so the
  // second pass is lossless rather than replacing real coverage with zeros.
  const publicCoveredStart = source.coveredAt?.startAt;
  const publicCoveredEnd = source.coveredAt?.endAt;
  const coveredStart = Number.isSafeInteger(source.coveredStartMs)
    ? new Date(source.coveredStartMs).toISOString()
    : publicCoveredStart === null || publicCoveredStart === undefined
      ? null
      : safeCanonicalInstant(publicCoveredStart);
  const coveredEnd = Number.isSafeInteger(source.coveredEndMs)
    ? new Date(source.coveredEndMs).toISOString()
    : publicCoveredEnd === null || publicCoveredEnd === undefined
      ? null
      : safeCanonicalInstant(publicCoveredEnd);
  if ((publicCoveredStart !== null && publicCoveredStart !== undefined
        && coveredStart === null)
      || (publicCoveredEnd !== null && publicCoveredEnd !== undefined
        && coveredEnd === null)) {
    return null;
  }
  const discoveredSourceCount = safeCount(
    source.discoveredSourceCount ?? source.sourceCount,
  );
  const discoveredSourceBytes = safeCount(
    source.discoveredSourceBytes ?? source.sourceBytes,
  );
  const indexedSourceCount = safeCount(
    source.indexedSourceCount ?? source.sourceCount
      ?? source.discoveredSourceCount,
  );
  const indexedSourceBytes = safeCount(
    source.indexedSourceBytes ?? source.sourceBytes
      ?? source.discoveredSourceBytes,
  );
  return {
    id,
    fingerprint,
    status,
    blockReason: token(source.blockReason),
    schemaVersion: token(source.schemaVersion),
    parserVersion: token(source.parserVersion),
    contractVersion: token(source.contractVersion),
    coveredAt: {
      startAt: coveredStart,
      endAt: coveredEnd,
    },
    sourceCount: indexedSourceCount,
    sourceBytes: indexedSourceBytes,
    discoveredSourceCount,
    discoveredSourceBytes,
    indexedSourceCount,
    indexedSourceBytes,
    usageEvents: safeCount(source.usageEvents),
    quotaOccurrences: safeCount(source.quotaOccurrences),
    toolFacts: safeCount(source.toolFacts),
    toolFactFingerprint: safeGenerationToken(source.toolFactFingerprint),
    discoveryComplete: source.discoveryComplete === true,
    diagnosticsComplete: source.diagnosticsComplete === true,
    usageProvenanceComplete: source.usageProvenanceComplete === true,
    sourceOrderComplete: source.sourceOrderComplete === true,
    quotaProvenanceComplete: source.quotaProvenanceComplete === true,
    toolProvenanceComplete: source.toolProvenanceComplete === true,
  };
}

function unifiedGenerationAuthoritative(value) {
  const generation = value?.generation;
  const accountingStatus = generation?.status === "complete"
    || (generation?.status === "partial"
      && generation?.blockReason === "tool_provenance_incomplete"
      && generation?.toolProvenanceComplete === false);
  return value?.status === "ingested"
    && accountingStatus
    && generation.discoveryComplete === true
    && generation.diagnosticsComplete === true
    && generation.usageProvenanceComplete === true
    && generation.sourceOrderComplete === true
    && generation.quotaProvenanceComplete === true;
}

function safeAccountingUnavailableCode(value) {
  return typeof value === "string"
      && ACCOUNTING_UNAVAILABLE_CODES.has(value)
    ? value
    : "accounting_unified_source_unavailable";
}

function unifiedAccountingCacheHasZeroFallback(cache) {
  const fallbackCount = cache?.sourceDescriptor?.fallbackCount;
  return Number.isSafeInteger(fallbackCount) && fallbackCount === 0;
}

function publicAccountingCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of [
    "readsRawSources",
    "deterministicCanonicalOrder",
    "sourceOrderingProvenance",
    "sourceOffsetProvenance",
    "sourceScopedQuotaOccurrences",
    "durableDiagnostics",
    "crashSafeGenerationPublication",
  ]) {
    if (typeof value[key] !== "boolean") return null;
    result[key] = value[key];
  }
  return result;
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

function publicLegacyRefreshUse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion
        !== LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION
      || value.sourceMode !== "legacy"
      || !Number.isSafeInteger(value.attempts)
      || value.attempts < 0
      || value.attempts > LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX
      || typeof value.saturated !== "boolean"
      || value.saturated
        !== (value.attempts === LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX)
      || (value.lastAttemptedAt !== null
        && safeCanonicalInstant(value.lastAttemptedAt) === null)) {
    return null;
  }
  return {
    schemaVersion: LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION,
    sourceMode: "legacy",
    attempts: value.attempts,
    saturated: value.saturated,
    lastAttemptedAt: value.lastAttemptedAt,
  };
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

function failedClaudeQuotaResult() {
  return {
    schemaVersion: "local-claude-quota-v0.1",
    provider: CLAUDE_QUOTA_PROVIDER,
    authority: CLAUDE_QUOTA_AUTHORITY,
    status: "failed",
    errorCode: "claude_quota_refresh_failed",
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
  };
}

function runClaudeQuotaRefresh(refreshClaudeQuota, signal) {
  if (refreshClaudeQuota === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      resolve(value);
    };
    const abort = () => finish(failedClaudeQuotaResult());
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    Promise.resolve()
      .then(() => refreshClaudeQuota({ signal }))
      .then((value) => finish(publicClaudeQuotaResult(value)))
      .catch(() => finish(failedClaudeQuotaResult()));
  });
}

// The Claude usage shadow is deliberately an internal side effect: it runs
// beside the production refresh when explicitly injected, but contributes no
// field to the loopback response and therefore cannot become an accidental UI
// or upload contract. Abort releases the foreground refresh even if an
// injected test callback is non-cooperative; the real controller propagates
// the same signal through inventory, canonicalization, ledger, and pricing.
function runClaudeUsageShadowRefresh(refreshClaudeUsageShadow, signal) {
  if (refreshClaudeUsageShadow === null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      resolve();
    };
    const abort = () => finish();
    if (signal?.aborted === true) {
      finish();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    Promise.resolve()
      .then(() => refreshClaudeUsageShadow({ signal }))
      .then(finish, finish);
  });
}

export function createLocalCollectorRefreshRunner({
  codexHome = join(homedir(), ".codex"),
  stateFile = null,
  accountObservationOperationLockFile = null,
  // A qualified Windows filesystem boundary is deliberately carried through
  // the composition root even while the current collector still uses Node's
  // SQLite path. The native adapter presently cannot pin SQLite's journal/WAL
  // sidecars; keeping this value explicit prevents a later caller from
  // silently falling back to POSIX checks while that prerequisite is closed.
  windowsFilesystemAdapter = null,
  // Windows SQLite must be opened through the native lease/session seam. This
  // is qualification-only plumbing until sqliteStateLeaseSafe is true; the
  // current production refresh remains fail-closed on Windows.
  windowsSqliteStateSessionFactory = null,
  // The qualification context is a capability, not a readiness override. It
  // is independently checked against the adapter and roots before it enters
  // the collector boundary; production continues through the assertion above.
  windowsQualificationModeContext = null,
  stateRoot = null,
  resourceRoot = null,
  windowsSqliteStateStaging = null,
  selectAccountObservationSecret = selectProductionAccountObservationSecret,
  runCollector = runCollectorOnce,
  readAccountingCache = readReplaySafeAccountingCache,
  refreshAccounting = null,
  // Native Claude plan quota is a separate source and store. Start it beside
  // the Codex collector so either provider can advance without feeding paths,
  // transcripts, or identities into the other callback.
  refreshClaudeQuota = null,
  // Disabled unless an explicit production-shaped shadow controller is
  // injected. Its result is intentionally not part of the public refresh
  // projection; only its provider-isolated local stores are advanced.
  refreshClaudeUsageShadow = null,
  // Explicit source authority. The legacy default is retained only for direct
  // compatibility/test callers; the production composition root always passes
  // its selected mode. Neither path is ever entered as an error fallback.
  accountingSourceMode = "legacy",
  legacyAnalysisIndexFile = null,
  legacyAnalysisIndexSecretFile = null,
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
  if (refreshClaudeQuota !== null && typeof refreshClaudeQuota !== "function") {
    throw new TypeError("refreshClaudeQuota must be a function or null");
  }
  if (refreshClaudeUsageShadow !== null
      && typeof refreshClaudeUsageShadow !== "function") {
    throw new TypeError("refreshClaudeUsageShadow must be a function or null");
  }
  if (!["unified", "legacy"].includes(accountingSourceMode)) {
    throw new TypeError("accountingSourceMode must be unified or legacy");
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
  if (windowsFilesystemAdapter !== null
      && (typeof windowsFilesystemAdapter !== "object"
        || Array.isArray(windowsFilesystemAdapter))) {
    throw new TypeError("windowsFilesystemAdapter must be an object or null");
  }
  if (windowsSqliteStateSessionFactory !== null
      && typeof windowsSqliteStateSessionFactory !== "function") {
    throw new TypeError("windowsSqliteStateSessionFactory must be a function or null");
  }
  if (windowsSqliteStateStaging !== null
      && (typeof windowsSqliteStateStaging !== "object"
        || Array.isArray(windowsSqliteStateStaging))) {
    throw new TypeError("windowsSqliteStateStaging must be an object or null");
  }
  for (const [name, value] of Object.entries({
    stateFile,
    accountObservationOperationLockFile,
    legacyAnalysisIndexFile,
    legacyAnalysisIndexSecretFile,
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
  // Cross-invocation backoff for a memory-budget miss. Held in the runner
  // closure so it survives between the external scheduler's ticks: once a
  // rebuild defers, the FULL rebuild is skipped (the retained cache is served)
  // until this instant passes. A successful rebuild resets it to 0.
  let accountingRebuildDeferUntilMs = 0;
  // How many rebuild ATTEMPTS in a row deferred over budget, across ticks.
  // Backoff passes that never attempt the rebuild do not count and do not
  // reset it; only a completed rebuild does. The count is what lets a surface
  // distinguish one soft miss from a rebuild that is never landing (the
  // 2026-08-19 livelock ran for hours behind a bare unavailable estimate).
  let accountingRebuildDeferredStreak = 0;
  return async function refreshLocalCollector({
    signal = null,
    onProgress = null,
  } = {}) {
    if (onProgress !== null && typeof onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    if (signal !== null && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
      throw new TypeError("signal must be an AbortSignal or null");
    }
    // Validate the optional native boundary before recording a refresh receipt
    // or invoking the collector. The current SQLite state path still creates
    // journal/WAL/SHM sidecars that are not covered by the Windows adapter.
    assertWindowsCollectorFilesystemBoundary({
      adapter: windowsFilesystemAdapter,
      windowsQualificationModeContext,
      stateRoot,
      resourceRoot,
    });
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
      return await withLocalCollectorStateSessionBoundary({
        windowsFilesystemAdapter,
        windowsSqliteStateSessionFactory,
        windowsQualificationModeContext,
        stateRoot,
        resourceRoot,
      }, async () => {
    // Legacy is an explicit rollback authority, never an error fallback. Stamp
    // the attempted use before any collector/accounting work so a later
    // failure still leaves a durable, bounded receipt in owner-only state.
    let legacyRefreshUse = null;
    if (accountingSourceMode === "legacy" && stateFile !== null) {
      try {
        legacyRefreshUse = await recordLocalCollectorLegacyRefreshAttempt({
          stateFile,
          clock,
        });
      } catch (error) {
        // Test/injected runners may deliberately point at a non-writable
        // placeholder path. Do not turn that unrelated setup failure into a
        // refresh failure; malformed existing receipt metadata still fails
        // closed so a real owner-state corruption is not hidden.
        if (error?.code !== "local_collector_state_unavailable") throw error;
      }
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
    const claudeQuotaPromise = runClaudeQuotaRefresh(refreshClaudeQuota, signal);
    const claudeUsageShadowPromise = runClaudeUsageShadowRefresh(
      refreshClaudeUsageShadow,
      signal,
    );
    let selection;
    try {
      selection = selectAccountObservationSecret(
        accountObservationOperationLockFile === null
          ? {}
          : {
            operationLockFile:
              accountObservationOperationLockFile,
            ...(windowsFilesystemAdapter === null
              ? {}
              : { windowsFilesystemAdapter }),
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
      // Usage facts are authoritative in the unified index. In that mode the
      // collector remains responsible for the provider quota/quick headline,
      // but must not resume an inherited legacy recent-7d rollout backfill.
      // Legacy mode keeps the historical two-pass collector unchanged.
      backfill: accountingSourceMode === "legacy",
      ...(accountingSourceMode === "legacy"
        ? { backfillSinceAt: new Date(clock() - recentIndexWindowMs).toISOString() }
        : {}),
      ...(accountingSourceMode === "unified"
        ? { skipRolloutIngestion: true }
        : {}),
      signal,
      onProgress: async (value) => {
        const progress = publicIndexingResult(value);
        if (progress !== null) await onProgress?.(progress);
      },
      maximumBufferedLineBytes: 16 * 1024 * 1024,
      maximumRecordBatchSize: 500,
      maximumRecentEventKeys: 5_000,
      loadAccountObservationSecret: selection.loadAccountObservationSecret,
      ...(windowsFilesystemAdapter === null
        ? {}
        : { windowsFilesystemAdapter }),
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
      if (accountingSourceMode === "unified") {
        // A custom/injected collector may still report its own bounded pause
        // even though unified production collection opts out of rollout
        // ingestion. Remember the fixed limit for the assemble decision, but
        // never launch a second legacy continuation in unified mode.
        collectorResourceLimitDeferred = earlyLimit !== null;
      } else if (earlyLimit !== null
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
    const accountingMayRun = accountingSourceMode === "unified"
      ? completedIndex === null
        || [
          "recent_7d_complete",
          "recent_7d_partial",
          "prospective_only",
          // Unified accounting reads the published index, not the bounded
          // collector ledger, so a collector-only pause must not suppress a
          // complete-generation accounting pass.
          "bounded_pause",
        ].includes(completedIndex.status)
      : completedIndex === null
        || ["recent_7d_complete", "recent_7d_partial", "prospective_only"]
          .includes(completedIndex.status);
    let unifiedIndex = null;
    refreshStep = "unified_index";
    if (accountingSourceMode === "unified"
        && refreshUnifiedIndex !== null
        && signal?.aborted !== true) {
      // The unified index advances by its cursors, so this ordinarily reads
      // only appended bytes. It runs BEFORE accounting so the full-history
      // calibration corpus the accounting rebuild reads from the index
      // already includes this pass's collection. A failure here must never
      // block collection or quota reporting: the snapshot degrades honestly
      // to the bounded window and says so.
      try {
        unifiedIndex = publicUnifiedIndexResult(await refreshUnifiedIndex({
          codexHome,
          ...(unifiedIndexFile === null ? {} : { indexFile: unifiedIndexFile }),
          ...(unifiedIndexSecretFile === null
            ? {}
            : { secretFile: unifiedIndexSecretFile }),
          ...(windowsSqliteStateSessionFactory === null
            ? {}
            : { windowsSqliteStateSessionFactory }),
          ...(windowsSqliteStateStaging === null
            ? {}
            : { windowsSqliteStateStaging }),
          signal,
        }));
      } catch (error) {
        unifiedIndex = {
          status: "failed",
          errorCode: safeUnifiedIndexPublicErrorCode(error?.code),
        };
      }
    }
    const unifiedAccountingReady = accountingSourceMode === "legacy"
      || unifiedGenerationAuthoritative(unifiedIndex);
    let accounting = null;
    let accountingRefreshStatus = null;
    let accountingRebuildDeferred = null;
    let accountingUnavailableCode = accountingSourceMode === "unified"
        && !unifiedAccountingReady
      ? unifiedIndex?.status === "failed"
        ? "accounting_unified_source_unavailable"
        : "accounting_unified_coverage_incomplete"
      : null;
    refreshStep = "accounting";
    if (refreshAccounting !== null
        && accountingMayRun
        && unifiedAccountingReady) {
      // A provider quota observation does not alter replay-safe token
      // accounting. Reuse a current cache when no rollout usage record was
      // added, while the collector state continues to supply the fresh quota
      // card independently.
      const collectorWroteNoRolloutUsage =
        result?.rolloutRecordsWritten === 0;
      // A recent rebuild that missed its memory budget backs the FULL rebuild
      // off: within this window we serve the retained cache rather than re-run
      // the doomed pass on every scheduler tick and blank the surface again.
      const withinRebuildBackoff = clock() < accountingRebuildDeferUntilMs;
      if ((collectorWroteNoRolloutUsage || withinRebuildBackoff)
          && signal?.aborted !== true) {
        try {
          const existing = await readAccountingCache({
            ...(stateFile === null ? {} : { stateFile }),
            now: clock,
            sourceMode: accountingSourceMode,
            ...(accountingSourceMode === "unified"
              ? {
                contextBehavior: "legacy_zero",
                expectedGeneration: unifiedIndex.generation,
              }
              : {}),
            // During backoff a labelled estimate beats a blank surface, so the
            // ordinary reuse-age gate is lifted (a valid cache then reads
            // "available" regardless of age). Outside backoff the gate stays,
            // so a cache older than the reuse age is not silently reused.
            ...(withinRebuildBackoff
              ? {}
              : { maximumAgeMs: MAX_REUSABLE_ACCOUNTING_CACHE_AGE_MS }),
          });
          if (signal?.aborted !== true
              && existing?.status === "available"
              && existing.cache?.schemaVersion
                === REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
              && (accountingSourceMode !== "unified"
                || unifiedAccountingCacheHasZeroFallback(existing.cache))) {
            accounting = existing.cache;
            // No new usage -> the reused cache still covers every event, so it
            // is exact ("reused"). Otherwise it is served only because the
            // rebuild is backed off, so it is a deferred (possibly stale)
            // estimate the surface labels as pending.
            accountingRefreshStatus = collectorWroteNoRolloutUsage
              ? "reused"
              : "deferred";
          }
        } catch {
          // A failed cache read is never authoritative. Rebuild below.
        }
      }
      if (accounting === null && !withinRebuildBackoff) {
        let rebuilt = null;
        try {
          rebuilt = await refreshAccounting({
            codexHome,
            ...(stateFile === null ? {} : { stateFile }),
            now: clock,
            sourceMode: accountingSourceMode,
            // The scan window bounds only the periods/timeline scan and obeys
            // the standing rule above: extreme, never convenience-sized. The
            // calibration corpus does not follow this window at all when the
            // unified index is present.
            windowDays: ACCOUNTING_SCAN_WINDOW_DAYS,
            ...(unifiedIndexFile === null ? {} : { unifiedIndexFile }),
            ...(accountingSourceMode === "legacy"
                && legacyAnalysisIndexFile !== null
              ? { indexFile: legacyAnalysisIndexFile }
              : {}),
            ...(accountingSourceMode === "legacy"
                && legacyAnalysisIndexSecretFile !== null
              ? { indexSecretFile: legacyAnalysisIndexSecretFile }
              : {}),
            ...(accountingSourceMode === "unified"
              ? { expectedGeneration: unifiedIndex.generation }
              : {}),
            ...(accountingSourceMode === "unified"
              ? { contextBehavior: "legacy_zero" }
              : {}),
            declaredSpeedBaselines,
            signal,
          });
        } catch (error) {
          if (accountingSourceMode !== "unified"
              || error?.name === "AbortError") {
            throw error;
          }
          // Resource limits are terminal refresh safety stops, not ordinary
          // unavailable evidence. Let the controller classify the fixed code
          // as refresh_resource_limited; swallowing it here would report a
          // misleading successful refresh with an unavailable cache.
          if (ACCOUNTING_RESOURCE_LIMIT_CODES.has(error?.code)
              || ACCOUNTING_TERMINAL_FAILURE_CODES.has(error?.code)) {
            throw error;
          }
          // Unified mode never falls back to raw logs or the old index. Keep
          // the last cache on disk untouched and return a bounded unavailable
          // receipt; a later complete generation can validate and reuse it.
          accountingUnavailableCode = safeAccountingUnavailableCode(
            error?.code,
          );
        }
        if (rebuilt?.status === "accounting_rebuild_deferred") {
          // Memory-budget miss soft-failed inside the rebuild: the prior
          // on-disk cache was retained untouched. Do NOT fail the refresh —
          // back off the full rebuild and serve whatever valid cache is on
          // disk so the dashboard keeps its last honest estimate instead of
          // blanking.
          accountingRebuildDeferUntilMs = clock()
            + ACCOUNTING_REBUILD_BUDGET_BACKOFF_MS;
          accountingRebuildDeferredStreak += 1;
          accountingRebuildDeferred = {
            reason: REFRESH_FAILURE_CODE_PATTERN.test(rebuilt.reason ?? "")
              ? rebuilt.reason
              : "accounting_rebuild_deferred",
            retained: rebuilt.retained === true,
            consecutive: accountingRebuildDeferredStreak,
          };
          if (rebuilt.retained === true && signal?.aborted !== true) {
            try {
              const existing = await readAccountingCache({
                ...(stateFile === null ? {} : { stateFile }),
                now: clock,
                sourceMode: accountingSourceMode,
                ...(accountingSourceMode === "unified"
                  ? {
                    contextBehavior: "legacy_zero",
                    expectedGeneration: unifiedIndex.generation,
                  }
                  : {}),
              });
              if (existing?.status === "available"
                  && existing.cache?.schemaVersion
                    === REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
                  && (accountingSourceMode !== "unified"
                    || unifiedAccountingCacheHasZeroFallback(existing.cache))) {
                accounting = existing.cache;
                accountingRefreshStatus = "deferred";
              } else if (accountingSourceMode === "unified") {
                accountingUnavailableCode =
                  "accounting_unified_source_unavailable";
              }
            } catch {
              // Retained-cache read failed; the surface shows honest
              // insufficient-evidence rather than a fabricated total.
            }
          }
        } else if (rebuilt !== null) {
          if (accountingSourceMode === "unified"
              && !unifiedAccountingCacheHasZeroFallback(rebuilt)) {
            // A unified cache is authoritative only when its source receipt
            // proves that no legacy/raw fallback was used. Do not publish a
            // plausible-looking result when the attestation is absent or
            // non-zero.
            accountingUnavailableCode = "accounting_unified_source_unavailable";
          } else {
            accounting = rebuilt;
          }
          if (accounting !== null) {
            accountingRefreshStatus = "rebuilt";
            // A successful rebuild clears any prior budget-miss backoff and
            // ends the deferral streak.
            accountingRebuildDeferUntilMs = 0;
            accountingRebuildDeferredStreak = 0;
          }
        }
      }
    }
    const notificationEvidence = publicNotificationEvidence(
      result?.refresh?.notificationEvidence,
      clock(),
    );
    let archiveIndex = null;
    refreshStep = "archive_index";
    if (accountingSourceMode === "legacy"
        && refreshArchiveIndex !== null
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
    refreshStep = "assemble";
    const claudeQuota = await claudeQuotaPromise;
    await claudeUsageShadowPromise;
    const unifiedCollectorPauseSoftened = accountingSourceMode === "unified"
      && unifiedAccountingReady
      && accounting !== null;
    if (collectorResourceLimitDeferred && !unifiedCollectorPauseSoftened) {
      throwCollectorResourceLimit();
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
      ...(notificationEvidence === null ? {} : { notificationEvidence }),
      ...(legacyRefreshUse === null ? {} : { legacyRefreshUse }),
      ...(accounting !== null
        ? {
          accounting: {
            status: "replay_safe",
            sourceMode: accountingSourceMode,
            refreshStatus: accountingRefreshStatus,
            readerVersion: accounting.sourceDescriptor?.readerVersion ?? null,
            compatibilityBehavior:
              accounting.sourceDescriptor?.contextBehavior ?? null,
            coverageStatus:
              accounting.sourceDescriptor?.coverageStatus ?? null,
            generation: accounting.sourceDescriptor?.generation ?? null,
            generationFingerprint:
              accounting.sourceDescriptor?.generationFingerprint ?? null,
            generationMatched:
              accounting.sourceDescriptor?.generationMatched === true,
            fallbackCount:
              safeCount(accounting.sourceDescriptor?.fallbackCount),
            diagnosticsAvailable:
              accounting.sourceDescriptor?.diagnosticsAvailable === true,
            capabilities: accounting.sourceDescriptor?.capabilities ?? null,
            generatedAt: accounting.generatedAt,
            events: accounting.periods
              ?.find((period) => period.id === "7d")?.events ?? 0,
            forkReplayEventsExcluded:
              accounting.diagnostics?.forkReplayEventsExcluded ?? 0,
          },
        }
        : accountingSourceMode === "unified"
          ? {
            accounting: {
              status: "unavailable",
              sourceMode: "unified",
              errorCode: safeAccountingUnavailableCode(
                accountingUnavailableCode,
              ),
              compatibilityBehavior: "legacy_zero",
              coverageStatus: unifiedIndex?.generation?.status ?? "unavailable",
              generation: unifiedIndex?.generation?.id ?? null,
              generationFingerprint:
                unifiedIndex?.generation?.fingerprint ?? null,
              generationMatched: false,
              fallbackCount: 0,
              diagnosticsAvailable: false,
            },
          }
          : {}),
      ...(publicArchiveIndexResult(archiveIndex) === null
        ? {}
        : { archiveIndex: publicArchiveIndexResult(archiveIndex) }),
      ...(accountingRebuildDeferred === null
        ? {}
        : { accountingRebuildDeferred }),
      ...(unifiedIndex === null ? {} : { unifiedIndex }),
      ...(claudeQuota === null ? {} : { claudeQuota }),
      ...(publicIndexingResult(result?.indexing) === null
        ? {}
        : { indexing: publicIndexingResult(result.indexing) }),
    };
      });
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
    return {
      status: "failed",
      errorCode: DEFAULT_UNIFIED_INDEX_PUBLIC_ERROR_CODE,
    };
  }
  const generation = publicUnifiedGeneration(value);
  if (generation === null) {
    return {
      status: "failed",
      errorCode: "local_unified_index_generation_invalid",
    };
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
    unchanged: value.unchanged === true,
    generation,
    ...counts,
    wallMs: Number.isFinite(value.wallMs) && value.wallMs >= 0
      ? Math.round(value.wallMs)
      : 0,
  };
}

/**
 * Closed, content-free Claude quota projection for refresh receipts and the
 * loopback consumer route. Unknown native meters remain counted but their
 * keyed identities never cross this boundary.
 */
export function publicClaudeQuotaResult(value) {
  if (value?.schemaVersion === "local-claude-quota-v0.1"
      && value.provider === CLAUDE_QUOTA_PROVIDER
      && value.authority === CLAUDE_QUOTA_AUTHORITY
      && value.status === "failed") {
    return {
      schemaVersion: "local-claude-quota-v0.1",
      provider: CLAUDE_QUOTA_PROVIDER,
      authority: CLAUDE_QUOTA_AUTHORITY,
      status: "failed",
      errorCode: value.errorCode === "claude_quota_refresh_failed"
        ? value.errorCode : "claude_quota_projection_invalid",
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
    };
  }
  const projection = value?.projection ?? (
    value?.schemaVersion === "local-claude-quota-v0.1"
      ? {
        ...value,
        source: {
          status: value.sourceStatus,
          lastSuccessAtMs: value.lastSuccessAtMs,
        },
      }
      : value
  );
  if (!projection || projection.provider !== CLAUDE_QUOTA_PROVIDER
      || projection.authority !== CLAUDE_QUOTA_AUTHORITY
      || !CLAUDE_QUOTA_STATUSES.has(projection.status)
      || !CLAUDE_QUOTA_SOURCE_STATUSES.has(projection.source?.status)
      || !CLAUDE_QUOTA_FRESHNESS.has(projection.freshness)
      || !CLAUDE_QUOTA_COVERAGE.has(projection.coverage?.state)) {
    return {
      schemaVersion: "local-claude-quota-v0.1",
      provider: CLAUDE_QUOTA_PROVIDER,
      authority: CLAUDE_QUOTA_AUTHORITY,
      status: "failed",
      errorCode: "claude_quota_projection_invalid",
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
    };
  }
  const windows = [];
  if (!Array.isArray(projection.windows)) {
    return publicClaudeQuotaResult(null);
  }
  for (const window of projection.windows) {
    if (!window || !CLAUDE_QUOTA_METERS.has(window.meterId)
        || typeof window.utilizationPercent !== "number"
        || !Number.isFinite(window.utilizationPercent)
        || window.utilizationPercent < 0 || window.utilizationPercent > 100
        || !Number.isSafeInteger(window.observedAtMs) || window.observedAtMs < 0
        || (window.resetsAtMs !== null
          && (!Number.isSafeInteger(window.resetsAtMs) || window.resetsAtMs < 0))) {
      return publicClaudeQuotaResult(null);
    }
    windows.push({
      meterId: window.meterId,
      utilizationPercent: window.utilizationPercent,
      remainingPercent: 100 - window.utilizationPercent,
      observedAtMs: window.observedAtMs,
      resetsAtMs: window.resetsAtMs,
      windowDurationMinutes: Number.isSafeInteger(window.windowDurationMinutes)
          && window.windowDurationMinutes > 0
        ? window.windowDurationMinutes
        : null,
    });
  }
  return {
    schemaVersion: "local-claude-quota-v0.1",
    provider: CLAUDE_QUOTA_PROVIDER,
    authority: CLAUDE_QUOTA_AUTHORITY,
    status: projection.status,
    sourceStatus: projection.source.status,
    freshness: projection.freshness,
    lastSuccessAtMs: Number.isSafeInteger(projection.source.lastSuccessAtMs)
        && projection.source.lastSuccessAtMs >= 0
      ? projection.source.lastSuccessAtMs
      : null,
    coverage: {
      state: projection.coverage.state,
      gapCount: safeCount(projection.coverage.gapCount),
    },
    counts: {
      observations: safeCount(projection.counts?.observations),
      points: safeCount(projection.counts?.points),
      accounts: safeCount(projection.counts?.accounts),
      meters: safeCount(projection.counts?.meters),
      unknownMeters: safeCount(projection.counts?.unknownMeters),
    },
    windows,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
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
  if (result?.claudeQuota !== undefined) {
    projected.claudeQuota = publicClaudeQuotaResult(result.claudeQuota);
  }
  const legacyRefreshUse = publicLegacyRefreshUse(result?.legacyRefreshUse);
  if (legacyRefreshUse !== null) {
    projected.legacyRefreshUse = legacyRefreshUse;
  }
  if (result?.unifiedIndex?.status === "ingested") {
    projected.unifiedIndex = publicUnifiedIndexResult(result.unifiedIndex);
  } else if (result?.unifiedIndex?.status === "failed") {
    projected.unifiedIndex = {
      status: "failed",
      errorCode: safeUnifiedIndexPublicErrorCode(
        result.unifiedIndex.errorCode,
      ),
    };
  }
  if (result?.accounting?.status === "replay_safe"
      && safeCanonicalInstant(result.accounting.generatedAt) !== null
      && (result.accounting.sourceMode !== "unified"
        || (Number.isSafeInteger(result.accounting.fallbackCount)
          && result.accounting.fallbackCount === 0))) {
    const capabilities = publicAccountingCapabilities(
      result.accounting.capabilities,
    );
    projected.accounting = {
      status: "replay_safe",
      sourceMode: ["unified", "legacy"].includes(result.accounting.sourceMode)
        ? result.accounting.sourceMode
        : "legacy",
      ...(ACCOUNTING_REFRESH_STATUSES.has(result.accounting.refreshStatus)
        ? { refreshStatus: result.accounting.refreshStatus }
        : {}),
      readerVersion: safeGenerationToken(result.accounting.readerVersion),
      compatibilityBehavior:
        ["legacy_zero", "source_native"].includes(
          result.accounting.compatibilityBehavior,
        )
          ? result.accounting.compatibilityBehavior
          : null,
      coverageStatus: ["complete", "partial"].includes(
        result.accounting.coverageStatus,
      ) ? result.accounting.coverageStatus : null,
      generation: safeGenerationToken(result.accounting.generation),
      generationFingerprint: safeGenerationToken(
        result.accounting.generationFingerprint,
      ),
      generationMatched: result.accounting.generationMatched === true,
      fallbackCount: safeCount(result.accounting.fallbackCount),
      diagnosticsAvailable:
        result.accounting.diagnosticsAvailable === true,
      ...(capabilities === null ? {} : { capabilities }),
      generatedAt: result.accounting.generatedAt,
      events: safeCount(result.accounting.events),
      forkReplayEventsExcluded:
        safeCount(result.accounting.forkReplayEventsExcluded),
    };
  } else if (result?.accounting?.sourceMode === "unified"
      && ["unavailable", "replay_safe"].includes(result.accounting.status)) {
    projected.accounting = {
      status: "unavailable",
      sourceMode: "unified",
      errorCode: safeAccountingUnavailableCode(
        result.accounting.status === "replay_safe"
          ? "accounting_unified_source_unavailable"
          : result.accounting.errorCode,
      ),
      compatibilityBehavior: "legacy_zero",
      coverageStatus: ["complete", "partial"].includes(
        result.accounting.coverageStatus,
      ) ? result.accounting.coverageStatus : "unavailable",
      generation: safeGenerationToken(result.accounting.generation),
      generationFingerprint: safeGenerationToken(
        result.accounting.generationFingerprint,
      ),
      generationMatched: false,
      fallbackCount: 0,
      diagnosticsAvailable: false,
    };
  }
  const archiveIndex = publicArchiveIndexResult(result?.archiveIndex);
  if (archiveIndex !== null) projected.archiveIndex = archiveIndex;
  const deferred = result?.accountingRebuildDeferred;
  if (deferred && typeof deferred === "object" && !Array.isArray(deferred)) {
    // A memory-budget miss is a soft, non-terminal outcome: the refresh
    // succeeded serving the retained cache. Surface it so a first-party caller
    // can show "using the estimate from <time>; a fuller rebuild is pending"
    // instead of treating the run as breakage. Content-free: a fixed status
    // plus the bounded budget reason code, and how many rebuild attempts in a
    // row have now deferred — the count that separates one soft miss from a
    // rebuild that is never landing.
    projected.accountingRebuildDeferred = {
      status: "deferred",
      reason: typeof deferred.reason === "string"
          && REFRESH_FAILURE_CODE_PATTERN.test(deferred.reason)
        ? deferred.reason
        : "accounting_rebuild_deferred",
      retained: deferred.retained === true,
      consecutive: Number.isSafeInteger(deferred.consecutive)
          && deferred.consecutive >= 1
        ? deferred.consecutive
        : 1,
    };
  }
  return projected;
}

export class LocalCompanionRefreshController {
  #abortController = null;
  #cancelRequested = false;
  #clock;
  #createRefreshId;
  #dataStore;
  #degradedNotified = false;
  #failureNotified = false;
  #inFlight = null;
  #onDegradedOutcome;
  #onTerminalFailure;
  #runner;
  #state;
  #timeoutMs;

  constructor({
    runner,
    dataStore,
    timeoutMs = 5 * 60_000,
    clock = () => Date.now(),
    createRefreshId = randomUUID,
    // Observer for terminal refresh failures. Receives only the bounded
    // identity the failed state itself carries — errorCode, and failedStep /
    // failureCode when known — so a sink can file a content-free diagnostics
    // note. Never invoked for success, cancellation, or non-terminal states,
    // and at most once per run; its own failures are swallowed.
    onTerminalFailure = null,
    // Observer for a SOFT degraded outcome: a refresh that SUCCEEDED but whose
    // accounting rebuild missed its memory budget and was deferred (the
    // retained cache is served). Receives only { reason, retained }, so a sink
    // can file a content-free note keeping the trail the terminal recorder no
    // longer sees. At most once per run; its own failures are swallowed.
    onDegradedOutcome = null,
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
    if (onTerminalFailure !== null && typeof onTerminalFailure !== "function") {
      throw new TypeError("onTerminalFailure must be a function or null");
    }
    if (onDegradedOutcome !== null && typeof onDegradedOutcome !== "function") {
      throw new TypeError("onDegradedOutcome must be a function or null");
    }
    this.#runner = runner;
    this.#dataStore = dataStore;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
    this.#createRefreshId = createRefreshId;
    this.#onTerminalFailure = onTerminalFailure;
    this.#onDegradedOutcome = onDegradedOutcome;
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

  // Fire-and-forget: the diagnostics trail must never affect refresh state
  // handling, and a run that fails twice over (the timeout marks it failed,
  // then the settling promise rejects) still files exactly one entry.
  #notifyTerminalFailure() {
    if (this.#onTerminalFailure === null
        || this.#failureNotified
        || this.#state.status !== "failed") return;
    this.#failureNotified = true;
    const { errorCode, failedStep, failureCode } = this.#state;
    try {
      Promise.resolve(this.#onTerminalFailure({
        errorCode,
        ...(failedStep === undefined ? {} : { failedStep }),
        ...(failureCode === undefined ? {} : { failureCode }),
      })).catch(() => {});
    } catch {
      // A throwing sink is treated exactly like a rejecting one.
    }
  }

  // Fire-and-forget, mirroring #notifyTerminalFailure but for a SOFT degraded
  // outcome: a succeeded run whose accounting rebuild was deferred over budget.
  // Only the bounded { reason, retained } identity is passed; at most once per
  // run, and the sink's own failures never touch refresh state.
  #notifyDegradedOutcome(result) {
    if (this.#onDegradedOutcome === null || this.#degradedNotified) return;
    const deferred = result?.accountingRebuildDeferred;
    if (!deferred || typeof deferred !== "object" || Array.isArray(deferred)) {
      return;
    }
    this.#degradedNotified = true;
    try {
      Promise.resolve(this.#onDegradedOutcome({
        reason: typeof deferred.reason === "string" ? deferred.reason : null,
        retained: deferred.retained === true,
      })).catch(() => {});
    } catch {
      // A throwing sink is treated exactly like a rejecting one.
    }
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
    this.#failureNotified = false;
    this.#degradedNotified = false;
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
              await this.#dataStore.reload({ purpose: "quick" });
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
            await this.#dataStore.reload({ purpose: "full" });
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
            await this.#dataStore.reload({ purpose: "full" });
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
          this.#notifyTerminalFailure();
          return;
        }
        await this.#dataStore.reload({ purpose: "full" });
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
        // A budget miss is a SOFT outcome: the run succeeded serving the
        // retained cache. File the degraded-event note (kept from the incident)
        // now that the terminal-failure path no longer sees it.
        this.#notifyDegradedOutcome(result);
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
            await this.#dataStore.reload({ purpose: "full" });
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
        this.#notifyTerminalFailure();
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
      // The timeout IS the terminal failure the user sees, and a hung runner
      // may never settle — file the trail entry now, not at settlement.
      this.#notifyTerminalFailure();
    }, this.#timeoutMs);
    timeout.unref?.();
    this.#inFlight = work;
    return true;
  }
}
