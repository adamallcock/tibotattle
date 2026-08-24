import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, opendir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CodexAppServerClient,
  CodexAppServerError,
  deriveOpenAIAccountScopeWithSecretLoader,
  sanitizeCodexAccountSnapshotWithSecretLoader,
  sanitizeRateLimit,
  sanitizeAccountScope,
} from "./providers/codex/account.js";
import {
  canonicalComponents,
  canonicalRateLimitWindows,
  classifyToolCall,
  normalizeTokenUsage,
  readRolloutLineage,
} from "./codex-log-scan.js";
import {
  normalizeProviderTier,
  unknownCodexTier,
} from "./providers/codex/logs.js";
import {
  stableJson,
} from "./storage.js";
import {
  isLocalCollectorStateWindowsBoundaryActive,
} from "./platform/index.js";
import { forEachRolloutLine } from "./rollout-line-reader.js";
import {
  acquireLocalCollectorStateLock,
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
  openLocalCollectorStateSession,
  prepareLocalCollectorState,
  readLocalCollectorCheckpoint,
  saveLocalCollectorCheckpoint,
} from "./local-collector-state.js";
import { SPARK_QUOTA_LIMIT_IDS } from "./local-companion-usage-model.js";

const CHECKPOINT_SCHEMA_VERSION = "0.3";
const RECORD_SCHEMA_VERSION = "0.3";
const MAX_RECENT_EVENT_KEYS = 5_000;
const MAX_ACCOUNT_SCOPE_MARKER_AGE_MS = 5 * 60_000;
const MAX_BUFFERED_ROLLOUT_LINE_BYTES = 16 * 1024 * 1024;
// Every line the collector can act on is tiny. Measured across the largest
// rollout files (36,395 relevant lines): the longest `turn_context` was 2 KiB,
// `token_count` 1 KiB, `thread_settings_applied` 1 KiB — not one relevant line
// reached 64 KiB. The 80 MiB lines in those same files are `compacted`,
// `response_item` and `agent_reasoning` records, which are never parsed.
//
// So a line above this cap is provably not one of ours, and is stepped over
// without ever being buffered or concatenated. That is what makes peak memory
// independent of rollout file size: a 15.34 GiB single file costs no more than
// a small one. `MAX_BUFFERED_ROLLOUT_LINE_BYTES` remains the separate,
// far larger allowance for realigning a cursor onto a line boundary.
const MAX_RELEVANT_ROLLOUT_LINE_BYTES = 64 * 1024;
// Matched against the raw line buffer, so an irrelevant line is rejected by a
// SIMD memchr rather than by decoding it to a JavaScript string first.
//
// `"custom_tool_call"` replaces a bare `tool_call` substring test. The loose
// marker matched large records that were never going to classify as a tool
// call, and tightening it was worth 6.8s of cumulative scan time across the
// corpus on its own.
const ROLLOUT_LINE_NEEDLES = Object.freeze([
  Buffer.from('"turn_context"'),
  Buffer.from('"token_count"'),
  Buffer.from('"thread_settings_applied"'),
  Buffer.from('"function_call"'),
  Buffer.from('"custom_tool_call"'),
]);
const MAX_RECORD_BATCH_SIZE = 1_000;
const MAX_RECENT_TAIL_BYTES = 768 * 1024 * 1024;
const MAX_RECENT_PRELUDE_BYTES = 32 * 1024 * 1024;
const MAX_RECENT_RUN_BYTES = 1536 * 1024 * 1024;
const MAX_LINEAGE_PREFIX_BYTES = 1024 * 1024;
const MAX_CURSOR_SEED_BYTES = 8 * 1024 * 1024;
// Both the responsive collector and the resumable archive index must be able
// to discover the same substantial Codex history. These remain hard limits:
// they are deliberately generous enough for established local histories, not
// permission for unbounded recursive traversal.
export const MAX_DISCOVERY_DIRECTORY_ENTRIES = 500_000;
export const MAX_DISCOVERY_ROLLOUT_FILES = 125_000;
const INDEXING_BOUNDARY = "modified_at_and_collection_start";
const INDEXING_PHASES = new Set([
  "discovering",
  "rollout_index",
  "quota_refresh",
  "complete",
  "paused",
  "prospective",
]);
const INDEXING_STATUSES = new Set([
  "recent_7d_indexing",
  "recent_7d_complete",
  "recent_7d_partial",
  "prospective_only",
  "bounded_pause",
]);
// This deliberately narrow projection is the only quota evidence that the
// native notification feature may consume.  It is built from the direct
// `account/rateLimits/read` pass after that pass has committed a local record;
// log-derived snapshots and app-server push notifications are not eligible.
const QUOTA_NOTIFICATION_EVIDENCE_SCHEMA =
  "tibotattle-notification-evidence-v2";
const QUOTA_NOTIFICATION_WINDOW_MINUTES = new Set([300, 10_080]);
const QUOTA_NOTIFICATION_SCOPE_DOMAIN =
  "app-usagemonitor/quota-notification-continuity/v1\u0000";
const OPENAI_SCOPE_ID_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const ROLLOUT_FILENAME_TIME =
  /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/u;
const DIAGNOSTIC_COUNT_FIELDS = Object.freeze([
  "filesDiscovered",
  "filesInitializedAtEnd",
  "filesTruncated",
  "filesReplacedOrNew",
  "completeLinesRead",
  "oversizedLinesSkipped",
  "partialLinesDeferred",
  "malformedLines",
  "malformedTimestamps",
  "malformedUsageRecords",
  "duplicateEventsSkipped",
  "preCollectionEventsSkipped",
  "rolloutRecordsWritten",
  "rolloutRecordBatchesWritten",
  "appServerRecordsWritten",
  "accountCredentialLocked",
  "accountCredentialUnavailable",
  "tierSettingEvents",
  "tierSettingOmissions",
  "malformedTierSettingEvents",
]);
const COLLECTOR_RESOURCE_LIMIT_CODES = Object.freeze({
  directory_entries: "collector_resource_directory_entries_limit_exceeded",
  rollout_files: "collector_resource_rollout_files_limit_exceeded",
  source_bytes: "collector_resource_source_bytes_limit_exceeded",
});
const COLLECTOR_RESOURCE_LIMIT_CODE_SET = new Set(
  Object.values(COLLECTOR_RESOURCE_LIMIT_CODES),
);
const COLLECTOR_DISCOVERY_STOP_CODES = new Set([
  "collector_discovery_aborted",
  COLLECTOR_RESOURCE_LIMIT_CODES.directory_entries,
  COLLECTOR_RESOURCE_LIMIT_CODES.rollout_files,
]);

export function defaultCollectorStateFile() {
  return defaultLocalCollectorStatePath(process.cwd());
}

function indexingDescriptor({
  mode,
  status,
  phase,
  filesDiscovered = 0,
  filesSelected = 0,
  filesProcessed = 0,
  recordsWritten = 0,
  startAt,
  endAt = null,
}) {
  if (!["recent_7d", "prospective"].includes(mode)
      || !INDEXING_STATUSES.has(status)
      || !INDEXING_PHASES.has(phase)) {
    throw new TypeError("Collector indexing descriptor is invalid");
  }
  return {
    mode,
    status,
    phase,
    boundedBy: INDEXING_BOUNDARY,
    filesDiscovered,
    filesSelected,
    filesProcessed,
    recordsWritten,
    coveredAt: { startAt, endAt },
  };
}

function emptyCheckpoint(nowIso, backfill, backfillSinceAt = null) {
  const collectionStartedAt = backfill
    ? (backfillSinceAt ?? "1970-01-01T00:00:00.000Z")
    : nowIso;
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    collectionStartedAt,
    indexing: indexingDescriptor({
      mode: backfill ? "recent_7d" : "prospective",
      status: backfill ? "recent_7d_indexing" : "prospective_only",
      phase: backfill ? "discovering" : "prospective",
      startAt: collectionStartedAt,
      endAt: backfill ? null : nowIso,
    }),
    files: {},
    recentEventKeys: [],
    lastQuotaObservedAt: null,
    accountScopeMarker: null,
    diagnostics: {
      filesDiscovered: 0,
      filesInitializedAtEnd: 0,
      filesTruncated: 0,
      filesReplacedOrNew: 0,
      completeLinesRead: 0,
      oversizedLinesSkipped: 0,
      partialLinesDeferred: 0,
      malformedLines: 0,
      malformedTimestamps: 0,
      malformedUsageRecords: 0,
      duplicateEventsSkipped: 0,
      preCollectionEventsSkipped: 0,
      rolloutRecordsWritten: 0,
      rolloutRecordBatchesWritten: 0,
      appServerRecordsWritten: 0,
      accountCredentialLocked: 0,
      accountCredentialUnavailable: 0,
      appServerErrorCounts: {},
      ingestionErrorCounts: {},
      watcherErrorCounts: {},
      tierSettingEvents: 0,
      tierSettingOmissions: 0,
      malformedTierSettingEvents: 0,
      tierSettingCounts: {},
    },
  };
}

function canonicalInstant(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function validSignal(signal) {
  return signal === undefined || signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function"
      && typeof signal.removeEventListener === "function");
}

function cloneIndexing(value) {
  return value ? structuredClone(value) : null;
}

function validCheckpointIndexing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== [
    "boundedBy",
    "coveredAt",
    "filesDiscovered",
    "filesProcessed",
    "filesSelected",
    "mode",
    "phase",
    "recordsWritten",
    "status",
  ].sort().join("\0")) return false;
  if (!["recent_7d", "prospective"].includes(value.mode)
      || !INDEXING_STATUSES.has(value.status)
      || !INDEXING_PHASES.has(value.phase)
      || value.boundedBy !== INDEXING_BOUNDARY) return false;
  if (!value.coveredAt || typeof value.coveredAt !== "object"
      || Array.isArray(value.coveredAt)
      || Object.keys(value.coveredAt).sort().join("\0") !== "endAt\0startAt") return false;
  try {
    if (value.coveredAt.startAt === null) {
      if (value.status !== "recent_7d_partial") return false;
    } else {
      canonicalInstant(value.coveredAt.startAt, "indexing coveredAt.startAt");
    }
    if (value.coveredAt.endAt !== null) {
      canonicalInstant(value.coveredAt.endAt, "indexing coveredAt.endAt");
    }
  } catch {
    return false;
  }
  return ["filesDiscovered", "filesSelected", "filesProcessed", "recordsWritten"]
    .every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function publicDiagnostics(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const result = Object.fromEntries(DIAGNOSTIC_COUNT_FIELDS.map((key) => [
    key,
    Number.isSafeInteger(source[key]) && source[key] >= 0 ? source[key] : 0,
  ]));
  for (const mapKey of [
    "appServerErrorCounts",
    "ingestionErrorCounts",
    "tierSettingCounts",
    "watcherErrorCounts",
  ]) {
    const candidate = source[mapKey];
    result[mapKey] = {};
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    for (const [key, count] of Object.entries(candidate)) {
      if (/^[a-z0-9_:-]{1,64}$/iu.test(key)
          && Number.isSafeInteger(count) && count >= 0) {
        result[mapKey][key] = count;
      }
    }
  }
  return result;
}

async function emitIndexingProgress(onProgress, descriptor) {
  if (onProgress === null || onProgress === undefined) return;
  await onProgress(cloneIndexing(descriptor));
}

function ensureCheckpointIndexing(checkpoint, {
  created,
  backfill,
  backfillSinceAt,
  nowIso,
}) {
  if (validCheckpointIndexing(checkpoint.indexing)) return checkpoint.indexing;
  const legacyStart = canonicalInstant(checkpoint.collectionStartedAt, "checkpoint collectionStartedAt");
  const legacyHistorical = legacyStart === "1970-01-01T00:00:00.000Z";
  const requestedRecent = created && backfill;
  checkpoint.indexing = indexingDescriptor({
    mode: legacyHistorical || requestedRecent ? "recent_7d" : "prospective",
    status: legacyHistorical
      ? "recent_7d_complete"
      : requestedRecent ? "recent_7d_indexing" : "prospective_only",
    phase: legacyHistorical
      ? "complete"
      : requestedRecent ? "discovering" : "prospective",
    startAt: requestedRecent ? backfillSinceAt : legacyStart,
    endAt: legacyHistorical || !requestedRecent ? nowIso : null,
  });
  return checkpoint.indexing;
}

function eventKey(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function addRecentKey(checkpoint, key, recentSet) {
  recentSet.add(key);
  checkpoint.recentEventKeys.push(key);
}

function trimRecentKeys(checkpoint, recentSet, maximumRecentEventKeys) {
  const excess = checkpoint.recentEventKeys.length - maximumRecentEventKeys;
  if (excess <= 0) return;
  const removed = checkpoint.recentEventKeys.splice(0, excess);
  for (const item of removed) recentSet.delete(item);
}

function tierUpdateFromRecord(record, diagnostics) {
  if (record?.type !== "event_msg" || record.payload?.type !== "thread_settings_applied") return null;
  const settings = record.payload?.thread_settings;
  if (!settings || typeof settings !== "object" || !Object.hasOwn(settings, "service_tier")) {
    diagnostics.tierSettingOmissions = (diagnostics.tierSettingOmissions ?? 0) + 1;
    return null;
  }
  const observedAtMs = Date.parse(record.timestamp);
  if (!Number.isFinite(observedAtMs)) {
    diagnostics.malformedTierSettingEvents = (diagnostics.malformedTierSettingEvents ?? 0) + 1;
    return null;
  }
  const rawTier = settings.service_tier;
  if (rawTier !== null && typeof rawTier !== "string") {
    diagnostics.malformedTierSettingEvents = (diagnostics.malformedTierSettingEvents ?? 0) + 1;
    return null;
  }
  const tier = normalizeProviderTier(rawTier, {
    billingSurface: "chatgpt_subscription",
    tierSource: "rollout_thread_settings",
    tierObservedAt: record.timestamp,
  });
  if (rawTier !== null && tier.providerTierRaw === null) {
    diagnostics.malformedTierSettingEvents = (diagnostics.malformedTierSettingEvents ?? 0) + 1;
    return null;
  }
  diagnostics.tierSettingEvents = (diagnostics.tierSettingEvents ?? 0) + 1;
  diagnostics.tierSettingCounts ??= {};
  diagnostics.tierSettingCounts[tier.codexSpeedMode] = (diagnostics.tierSettingCounts[tier.codexSpeedMode] ?? 0) + 1;
  return { providerTierRaw: tier.providerTierRaw, observedAt: record.timestamp, observedAtMs };
}

function updateTierState(state, update) {
  if (!update) return;
  const priorMs = Date.parse(state.tierState?.observedAt);
  if (Number.isFinite(priorMs) && priorMs > update.observedAtMs) return;
  state.tierState = { providerTierRaw: update.providerTierRaw, observedAt: update.observedAt };
}

function tierForUsage(state, observedAt) {
  const tierState = state.tierState;
  const usageMs = Date.parse(observedAt);
  const tierMs = Date.parse(tierState?.observedAt);
  if (!tierState || !Number.isFinite(usageMs) || !Number.isFinite(tierMs) || tierMs > usageMs) return unknownCodexTier();
  return normalizeProviderTier(tierState.providerTierRaw, {
    billingSurface: "chatgpt_subscription",
    tierSource: "rollout_thread_settings",
    tierObservedAt: tierState.observedAt,
  });
}

function addUsageDelta(current, previous) {
  const result = {};
  for (const key of ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    result[key] = Math.max(0, current[key] - (previous?.[key] ?? 0));
  }
  return result;
}

function sameUsage(left, right) {
  return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
    .every((key) => left[key] === right[key]);
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function collectorResourceLimitEvidence(dimension, limit, observed) {
  const code = COLLECTOR_RESOURCE_LIMIT_CODES[dimension];
  if (!code) throw new TypeError("Collector resource-limit dimension is invalid");
  return Object.freeze({ code, dimension, limit, observed });
}

function collectorResourceLimitError(dimension, limit, observed, discoveryProgress = null) {
  const error = new Error("Collector stopped at a content-free resource limit");
  error.name = "CollectorResourceLimitError";
  error.code = COLLECTOR_RESOURCE_LIMIT_CODES[dimension];
  error.resourceLimit = collectorResourceLimitEvidence(dimension, limit, observed);
  if (discoveryProgress) error.discoveryProgress = Object.freeze({ ...discoveryProgress });
  return error;
}

function recordCollectorResourceLimit(checkpoint, resourceLimit) {
  const code = resourceLimit?.code;
  if (!COLLECTOR_RESOURCE_LIMIT_CODE_SET.has(code)) return;
  checkpoint.diagnostics.ingestionErrorCounts ??= {};
  checkpoint.diagnostics.ingestionErrorCounts[code] =
    (checkpoint.diagnostics.ingestionErrorCounts[code] ?? 0) + 1;
}

function collectorDiscoveryAbortError(discoveryProgress) {
  const error = new Error("Collector discovery was aborted");
  error.name = "AbortError";
  error.code = "collector_discovery_aborted";
  error.discoveryProgress = Object.freeze({ ...discoveryProgress });
  return error;
}

function assertDiscoveryNotAborted(signal, discoveryProgress) {
  if (signal?.aborted) throw collectorDiscoveryAbortError(discoveryProgress);
}

function safeBudgetTotal(current, addition, limit) {
  if (!Number.isSafeInteger(addition) || addition < 0) return limit + 1;
  const total = current + addition;
  return Number.isSafeInteger(total) ? total : limit + 1;
}

async function collectJsonlFiles(root, location, {
  signal,
  discoveryProgress,
  maximumDirectoryEntries,
  maximumRolloutFiles,
}) {
  const files = [];
  async function walk(directory) {
    assertDiscoveryNotAborted(signal, discoveryProgress);
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    try {
      while (true) {
        assertDiscoveryNotAborted(signal, discoveryProgress);
        const entry = await handle.read();
        assertDiscoveryNotAborted(signal, discoveryProgress);
        if (entry === null) break;
        discoveryProgress.directoryEntries += 1;
        if (discoveryProgress.directoryEntries > maximumDirectoryEntries) {
          throw collectorResourceLimitError(
            "directory_entries",
            maximumDirectoryEntries,
            discoveryProgress.directoryEntries,
            discoveryProgress,
          );
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          discoveryProgress.rolloutFiles += 1;
          if (discoveryProgress.rolloutFiles > maximumRolloutFiles) {
            throw collectorResourceLimitError(
              "rollout_files",
              maximumRolloutFiles,
              discoveryProgress.rolloutFiles,
              discoveryProgress,
            );
          }
          const metadata = await stat(path);
          assertDiscoveryNotAborted(signal, discoveryProgress);
          files.push({ path, location, metadata });
        }
      }
    } finally {
      await handle.close();
    }
  }
  await walk(root);
  return files;
}

function rolloutName(path) {
  return basename(path);
}

function rolloutFilenameTime(path) {
  const match = rolloutName(path).match(ROLLOUT_FILENAME_TIME);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`);
}

function rolloutMayOverlap(file, sinceMs) {
  if (!Number.isFinite(sinceMs)) return true;
  return [file.metadata.mtimeMs, rolloutFilenameTime(file.path)]
    .some((value) => Number.isFinite(value) && value >= sinceMs);
}

export async function discoverCollectorRollouts(
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  {
    sinceAt = null,
    signal = null,
    maximumDirectoryEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES,
    maximumRolloutFiles = MAX_DISCOVERY_ROLLOUT_FILES,
  } = {},
) {
  if (!validSignal(signal)) throw new TypeError("signal must be an AbortSignal");
  positiveSafeInteger(maximumDirectoryEntries, "maximumDirectoryEntries");
  positiveSafeInteger(maximumRolloutFiles, "maximumRolloutFiles");
  const sinceMs = sinceAt === null ? Number.NaN : Date.parse(canonicalInstant(sinceAt, "sinceAt"));
  const discoveryProgress = { directoryEntries: 0, rolloutFiles: 0 };
  assertDiscoveryNotAborted(signal, discoveryProgress);
  const archived = await collectJsonlFiles(join(codexHome, "archived_sessions"), "archive", {
    signal,
    discoveryProgress,
    maximumDirectoryEntries,
    maximumRolloutFiles,
  });
  const active = await collectJsonlFiles(join(codexHome, "sessions"), "active", {
    signal,
    discoveryProgress,
    maximumDirectoryEntries,
    maximumRolloutFiles,
  });
  assertDiscoveryNotAborted(signal, discoveryProgress);
  const selected = new Map();
  for (const file of archived) selected.set(rolloutName(file.path), file);
  for (const file of active) selected.set(rolloutName(file.path), file);
  return [...selected.values()]
    .filter((file) => rolloutMayOverlap(file, sinceMs))
    .sort((left, right) => rolloutName(left.path).localeCompare(rolloutName(right.path)));
}

function cursorKey(metadata) {
  return `${metadata.ino}:${Math.trunc(metadata.birthtimeMs)}`;
}

async function forEachCompleteLine(path, offset, size, onLine, {
  maximumBufferedLineBytes = MAX_RELEVANT_ROLLOUT_LINE_BYTES,
  highWaterMark = 1024 * 1024,
  signal = null,
} = {}) {
  let oversizedLinesSkipped = 0;
  const read = await forEachRolloutLine(path, {
    start: offset,
    end: size,
    maximumLineBytes: maximumBufferedLineBytes,
    highWaterMark,
    signal,
    onLine: (line, lineEndOffset, partial) => {
      if (partial) oversizedLinesSkipped += 1;
      return onLine(line, lineEndOffset, partial);
    },
  });
  return {
    nextOffset: read.nextOffset,
    partialDeferred: read.partialDeferred,
    oversizedLinesSkipped,
    aborted: read.aborted,
  };
}

async function seedCursorFromTail(path, size, {
  maximumBytes = MAX_CURSOR_SEED_BYTES,
  diagnostics = {},
} = {}) {
  const start = Math.max(0, size - maximumBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    let currentModel = null;
    let previousTotals = null;
    const tierState = {};
    let earliestRelevantMs = Number.POSITIVE_INFINITY;
    let latestRelevantMs = Number.NEGATIVE_INFINITY;
    let lastRelevantMs = Number.NEGATIVE_INFINITY;
    let timestampOrderViolated = false;
    for (const line of text.split("\n")) {
      if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"thread_settings_applied"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const observedAtMs = Date.parse(record?.timestamp);
      if (Number.isFinite(observedAtMs)) {
        if (Number.isFinite(lastRelevantMs) && observedAtMs < lastRelevantMs) {
          timestampOrderViolated = true;
        }
        earliestRelevantMs = Math.min(earliestRelevantMs, observedAtMs);
        latestRelevantMs = Math.max(latestRelevantMs, observedAtMs);
        lastRelevantMs = observedAtMs;
      }
      if (record.type === "turn_context" && typeof record.payload?.model === "string") {
        currentModel = record.payload.model;
      } else if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
        updateTierState(tierState, tierUpdateFromRecord(record, diagnostics));
      } else if (record.type === "event_msg" && record.payload?.type === "token_count") {
        const total = normalizeTokenUsage(record.payload?.info?.total_token_usage);
        if (total) previousTotals = total;
      }
    }
    return {
      currentModel,
      previousTotals,
      tierState: tierState.tierState ?? null,
      earliestRelevantAt: Number.isFinite(earliestRelevantMs)
        ? new Date(earliestRelevantMs).toISOString()
        : null,
      latestRelevantAt: Number.isFinite(latestRelevantMs)
        ? new Date(latestRelevantMs).toISOString()
        : null,
      lastRelevantAt: Number.isFinite(lastRelevantMs)
        ? new Date(lastRelevantMs).toISOString()
        : null,
      timestampOrderViolated,
    };
  } finally {
    await handle.close();
  }
}

async function lineStartAtOrAfter(path, offset, size, {
  maximumScanBytes = MAX_BUFFERED_ROLLOUT_LINE_BYTES,
  signal = null,
} = {}) {
  if (offset <= 0) return 0;
  if (offset >= size) return size;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(256 * 1024, maximumScanBytes));
    let position = offset;
    let remaining = Math.min(maximumScanBytes, size - offset);
    while (remaining > 0) {
      if (signal?.aborted) return null;
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) return size;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) return position + newline + 1;
      position += bytesRead;
      remaining -= bytesRead;
    }
    // The straddling line is itself beyond the normal bounded-line policy.
    // Starting at the cap lets the ordinary parser skip its remaining suffix
    // without allocating the complete line.
    return Math.min(size, offset + maximumScanBytes);
  } finally {
    await handle.close();
  }
}

function rolloutRecord({ record, state, receivedAt, checkpoint }) {
  const observedMs = Date.parse(record.timestamp);
  if (!Number.isFinite(observedMs)) {
    checkpoint.diagnostics.malformedTimestamps += 1;
    return null;
  }
  const markerCapturedMs = Date.parse(checkpoint.accountScopeMarker?.capturedAt);
  const receivedMs = Date.parse(receivedAt);
  const markerIsFresh = Number.isFinite(markerCapturedMs)
    && Number.isFinite(receivedMs)
    && Math.abs(receivedMs - markerCapturedMs) <= MAX_ACCOUNT_SCOPE_MARKER_AGE_MS;
  const receiptIsFresh = Number.isFinite(receivedMs)
    && receivedMs - observedMs >= 0
    && receivedMs - observedMs <= MAX_ACCOUNT_SCOPE_MARKER_AGE_MS;
  const accountScope = markerIsFresh && receiptIsFresh
    ? sanitizeAccountScope(checkpoint.accountScopeMarker.accountScope)
    : sanitizeAccountScope(null);
  const accountScopeAttribution = accountScope.status === "available"
    ? "provisional_fresh_app_server_marker"
    : "unavailable_no_fresh_contemporaneous_marker";
  if (record.type === "turn_context") {
    if (typeof record.payload?.model === "string") state.currentModel = record.payload.model;
    return null;
  }
  if (record.type === "response_item") {
    const type = record.payload?.type;
    if (type !== "function_call" && type !== "custom_tool_call") return null;
    const safe = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      kind: "codex_tool_class_event",
      provider: "openai_codex",
      observedAt: record.timestamp,
      receivedAt,
      stalenessMs: Math.max(0, Date.parse(receivedAt) - observedMs),
      source: "rollout_tool_call",
      toolClass: classifyToolCall(record.payload?.name),
      surfaceClassification: state.surfaceClassification,
      accountScope,
      accountScopeAttribution,
      controlledState: "unknown",
    };
    safe.eventKey = eventKey({ ...safe, receivedAt: undefined, stalenessMs: undefined });
    return safe;
  }
  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return null;
  const info = record.payload?.info;
  const total = normalizeTokenUsage(info?.total_token_usage);
  const last = normalizeTokenUsage(info?.last_token_usage);
  if ((info?.total_token_usage && !total) || (info?.last_token_usage && !last)) {
    checkpoint.diagnostics.malformedUsageRecords += 1;
  }
  let usage = null;
  if (total) {
    const delta = addUsageDelta(total, state.previousTotals);
    if (state.previousTotals === null) usage = last;
    else if (delta.total_tokens > 0) usage = last && sameUsage(last, delta) ? last : delta;
    state.previousTotals = total;
  } else {
    usage = last;
  }
  const windows = canonicalRateLimitWindows(record.payload?.rate_limits);
  if ((!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) && windows.length === 0) return null;
  const safe = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    kind: "codex_rollout_usage_snapshot",
    provider: "openai_codex",
    observedAt: record.timestamp,
    receivedAt,
    stalenessMs: Math.max(0, Date.parse(receivedAt) - observedMs),
    source: "rollout_token_count",
    model: record.payload?.model ?? info?.model ?? state.currentModel ?? "unknown",
    components: usage ? canonicalComponents(usage) : null,
    tierSemantics: tierForUsage(state, record.timestamp),
    surfaceClassification: state.surfaceClassification,
    accountScope,
    accountScopeAttribution,
    windows,
    controlledState: "unknown",
  };
  safe.eventKey = eventKey({ ...safe, receivedAt: undefined, stalenessMs: undefined });
  return safe;
}

export async function ingestRolloutUpdates({
  codexHome,
  checkpoint,
  clock = () => Date.now(),
  initializeAtEnd = false,
  maximumBufferedLineBytes = MAX_BUFFERED_ROLLOUT_LINE_BYTES,
  maximumRecordBatchSize = MAX_RECORD_BATCH_SIZE,
  maximumRecentEventKeys = MAX_RECENT_EVENT_KEYS,
  recentBackfillSinceAt = null,
  maximumRecentTailBytes = MAX_RECENT_TAIL_BYTES,
  maximumRecentPreludeBytes = MAX_RECENT_PRELUDE_BYTES,
  maximumRecentRunBytes = MAX_RECENT_RUN_BYTES,
  maximumLineagePrefixBytes = MAX_LINEAGE_PREFIX_BYTES,
  maximumDiscoveryDirectoryEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES,
  maximumDiscoveryRolloutFiles = MAX_DISCOVERY_ROLLOUT_FILES,
  commitRecordBatch,
  rollouts = null,
  signal = null,
  onProgress = null,
}) {
  if (!Number.isSafeInteger(maximumRecordBatchSize) || maximumRecordBatchSize < 1) {
    throw new TypeError("maximumRecordBatchSize must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumRecentEventKeys) || maximumRecentEventKeys < 1) {
    throw new TypeError("maximumRecentEventKeys must be a positive safe integer");
  }
  for (const [name, value] of Object.entries({
    maximumRecentTailBytes,
    maximumRecentPreludeBytes,
    maximumRecentRunBytes,
    maximumLineagePrefixBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  // A caller may make the relevant-line cap tighter than the measured 64 KiB
  // ceiling but never looser: the bound is what keeps peak memory independent
  // of rollout file size, so it is not a knob a caller can give away.
  // `maximumBufferedLineBytes` continues to govern cursor realignment, which
  // legitimately needs a much larger allowance.
  const relevantLineBytes = Math.min(
    maximumBufferedLineBytes,
    MAX_RELEVANT_ROLLOUT_LINE_BYTES,
  );
  const recentSinceAt = recentBackfillSinceAt === null
    ? null
    : canonicalInstant(recentBackfillSinceAt, "recentBackfillSinceAt");
  const recentSinceMs = recentSinceAt === null
    ? Number.NaN
    : Date.parse(recentSinceAt);
  if (!validSignal(signal)) throw new TypeError("signal must be an AbortSignal");
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (typeof commitRecordBatch !== "function") {
    throw new TypeError("commitRecordBatch must be a function");
  }
  positiveSafeInteger(maximumDiscoveryDirectoryEntries, "maximumDiscoveryDirectoryEntries");
  positiveSafeInteger(maximumDiscoveryRolloutFiles, "maximumDiscoveryRolloutFiles");
  const files = rollouts ?? await discoverCollectorRollouts(codexHome, {
    signal,
    maximumDirectoryEntries: maximumDiscoveryDirectoryEntries,
    maximumRolloutFiles: maximumDiscoveryRolloutFiles,
  });
  if (!Array.isArray(files)) throw new TypeError("rollouts must be an array");
  checkpoint.diagnostics.filesDiscovered += files.length;
  const recentSet = new Set(checkpoint.recentEventKeys);
  let recordBatch = [];
  let recordsWritten = 0;
  let recordBatchesWritten = 0;
  let maximumBufferedRecords = 0;
  let changed = false;
  let changeVersion = 0;
  let committedVersion = -1;
  let filesProcessed = 0;
  let aborted = signal?.aborted === true;
  let sourceReadBudget = 0;
  let resourceLimit = null;
  let recentCoverageComplete = true;
  let recentCoverageStartMs = Number.NaN;
  const receivedAt = new Date(clock()).toISOString();

  function markChanged() {
    changed = true;
    changeVersion += 1;
  }

  function reserveSourceBytes(byteCount) {
    const observed = safeBudgetTotal(sourceReadBudget, byteCount, maximumRecentRunBytes);
    if (observed > maximumRecentRunBytes) {
      resourceLimit = collectorResourceLimitEvidence(
        "source_bytes",
        maximumRecentRunBytes,
        observed,
      );
      aborted = true;
      return false;
    }
    sourceReadBudget = observed;
    return true;
  }

  async function flushRecordBatch() {
    if (recordBatch.length === 0) return;
    trimRecentKeys(checkpoint, recentSet, maximumRecentEventKeys);
    const batchSize = recordBatch.length;
    checkpoint.diagnostics.rolloutRecordsWritten += batchSize;
    checkpoint.diagnostics.rolloutRecordBatchesWritten = (checkpoint.diagnostics.rolloutRecordBatchesWritten ?? 0) + 1;
    await commitRecordBatch(recordBatch);
    recordsWritten += batchSize;
    recordBatchesWritten += 1;
    recordBatch = [];
    committedVersion = changeVersion;
    await onProgress?.({
      recordsWritten,
      recordBatchesWritten,
      filesProcessed,
      filesDiscovered: files.length,
    });
  }

  for (const file of files) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const key = cursorKey(file.metadata);
    let state = checkpoint.files[key];
    if (!state) {
      const boundedRecentTail = recentSinceAt !== null
        && file.metadata.size > maximumRecentTailBytes;
      let recentTailStart = null;
      if (boundedRecentTail) {
        const proposedStart = Math.max(0, file.metadata.size - maximumRecentTailBytes);
        const alignmentReservation = Math.min(
          maximumBufferedLineBytes,
          file.metadata.size - proposedStart,
        );
        const reservedRead = file.metadata.size - proposedStart
          + Math.min(maximumRecentPreludeBytes, proposedStart)
          + alignmentReservation
          + maximumLineagePrefixBytes;
        if (!reserveSourceBytes(reservedRead)) break;
        recentTailStart = await lineStartAtOrAfter(
          file.path,
          proposedStart,
          file.metadata.size,
          { maximumScanBytes: maximumBufferedLineBytes, signal },
        );
        if (recentTailStart === null) {
          aborted = true;
          break;
        }
      } else {
        const mainRead = initializeAtEnd ? 0 : file.metadata.size;
        const lineageRead = Math.min(file.metadata.size, maximumLineagePrefixBytes);
        const seedRead = initializeAtEnd && file.location === "active"
          ? Math.min(file.metadata.size, MAX_CURSOR_SEED_BYTES)
          : 0;
        if (!reserveSourceBytes(mainRead + lineageRead + seedRead)) break;
      }
      const lineage = await readRolloutLineage(file.path, {
        maximumTotalBytes: maximumLineagePrefixBytes,
      });
      const seedBoundary = boundedRecentTail
        ? recentTailStart
        : file.metadata.size;
      const seed = (initializeAtEnd && file.location === "active") || boundedRecentTail
        ? await seedCursorFromTail(file.path, seedBoundary, {
          maximumBytes: maximumRecentPreludeBytes,
          diagnostics: checkpoint.diagnostics,
        })
        : { currentModel: null, previousTotals: null, tierState: null };
      state = {
        cursorKind: "filesystem_inode_and_birthtime_not_session_identifier",
        offset: boundedRecentTail
          ? recentTailStart
          : initializeAtEnd ? file.metadata.size : 0,
        previousTotals: seed.previousTotals,
        currentModel: seed.currentModel,
        tierState: seed.tierState,
        tailSeeded: initializeAtEnd || boundedRecentTail,
        surfaceClassification: lineage.surfaceClassification,
        lineageDisposition: lineage.surfaceClassification?.lineageDisposition ?? "standalone",
      };
      if (boundedRecentTail) {
        const seedLatestMs = Date.parse(seed.latestRelevantAt);
        state.recentTail = {
          strategy: "bounded_recent_tail_v0.2",
          requestedSinceAt: recentSinceAt,
          actualCoverageStartAt: null,
          latestRelevantAt: null,
          preludeLatestAt: Number.isFinite(seedLatestMs)
            ? seed.latestRelevantAt
            : null,
          preludeLastAt: seed.lastRelevantAt ?? null,
          firstMainAt: null,
          lastScannedAt: seed.lastRelevantAt ?? null,
          timestampOrderViolated: seed.timestampOrderViolated === true,
          orderingVerified: seed.timestampOrderViolated !== true,
          coverageComplete: seed.timestampOrderViolated !== true
            && Number.isFinite(seedLatestMs)
            && seedLatestMs < recentSinceMs,
          cumulativeBaselineAvailable: seed.previousTotals !== null,
          modelSeedAvailable: seed.currentModel !== null,
          tierSeedAvailable: seed.tierState !== null,
        };
      }
      checkpoint.files[key] = state;
      markChanged();
      checkpoint.diagnostics.filesReplacedOrNew += 1;
      if (initializeAtEnd) {
        checkpoint.diagnostics.filesInitializedAtEnd += 1;
        filesProcessed += 1;
        await onProgress?.({
          recordsWritten,
          recordBatchesWritten,
          filesProcessed,
          filesDiscovered: files.length,
        });
        continue;
      }
    } else {
      const effectiveOffset = file.metadata.size < state.offset ? 0 : state.offset;
      const mainRead = Math.max(0, file.metadata.size - effectiveOffset);
      const lineageRead = state.surfaceClassification
        ? 0
        : Math.min(file.metadata.size, maximumLineagePrefixBytes);
      const seedRead = state.currentModel === null
          && state.tailSeeded !== true
          && file.location === "active"
          && effectiveOffset > 0
        ? Math.min(effectiveOffset, MAX_CURSOR_SEED_BYTES)
        : 0;
      if (!reserveSourceBytes(mainRead + lineageRead + seedRead)) break;
    }
    if (!state.surfaceClassification) {
      const lineage = await readRolloutLineage(file.path, {
        maximumTotalBytes: maximumLineagePrefixBytes,
      });
      state.surfaceClassification = lineage.surfaceClassification;
      state.lineageDisposition = lineage.surfaceClassification?.lineageDisposition ?? "standalone";
      markChanged();
    }
    if (file.metadata.size < state.offset) {
      state.offset = 0;
      state.previousTotals = null;
      state.currentModel = null;
      state.tierState = null;
      state.tailSeeded = false;
      checkpoint.diagnostics.filesTruncated += 1;
      markChanged();
    }
    if (state.currentModel === null && state.tailSeeded !== true && file.location === "active" && state.offset > 0) {
      const seed = await seedCursorFromTail(file.path, state.offset, { diagnostics: checkpoint.diagnostics });
      state.currentModel = seed.currentModel;
      if (state.previousTotals === null) state.previousTotals = seed.previousTotals;
      if (state.tierState === null) state.tierState = seed.tierState;
      state.tailSeeded = true;
      markChanged();
    }
    let earliestRelevantMs = Number.POSITIVE_INFINITY;
    let latestRelevantMs = Number.NEGATIVE_INFINITY;
    let firstRelevantMs = Number.POSITIVE_INFINITY;
    let lastRelevantMs = Date.parse(state.recentTail?.lastScannedAt);
    let timestampOrderViolated = state.recentTail?.timestampOrderViolated === true;
    const chunk = await forEachCompleteLine(file.path, state.offset, file.metadata.size, async (line, lineEndOffset, partial) => {
      state.offset = lineEndOffset;
      markChanged();
      if (line.length === 0) return;
      checkpoint.diagnostics.completeLinesRead += 1;
      // Byte-level relevance test. The overwhelming majority of rollout lines
      // are irrelevant, and matching on the raw buffer means they are never
      // decoded to UTF-8 at all.
      if (!ROLLOUT_LINE_NEEDLES.some((needle) => line.includes(needle))) return;
      if (partial) {
        // Degrade, don't discard. A relevant line above the cap has already
        // been counted as oversized; salvage only the model carried forward
        // from `turn_context`, so a truncated record cannot silently reset the
        // model for every later event in the file. Token counters are never
        // guessed at here: a partial cumulative total would corrupt the delta
        // baseline for the rest of the file, and a wrong number is worse than
        // a missing one.
        const prefix = line.toString("utf8");
        if (prefix.includes('"turn_context"')) {
          const salvaged = /"model"\s*:\s*"([A-Za-z0-9._:-]{1,64})"/u.exec(prefix);
          if (salvaged !== null) state.currentModel = salvaged[1];
        }
        return;
      }
      let raw;
      try {
        raw = JSON.parse(line.toString("utf8"));
      } catch {
        checkpoint.diagnostics.malformedLines += 1;
        return;
      }
      const rawTimestampMs = Date.parse(raw?.timestamp);
      if (Number.isFinite(rawTimestampMs)) {
        if (!Number.isFinite(firstRelevantMs)) firstRelevantMs = rawTimestampMs;
        if (Number.isFinite(lastRelevantMs) && rawTimestampMs < lastRelevantMs) {
          timestampOrderViolated = true;
        }
        earliestRelevantMs = Math.min(earliestRelevantMs, rawTimestampMs);
        latestRelevantMs = Math.max(latestRelevantMs, rawTimestampMs);
        lastRelevantMs = rawTimestampMs;
      }
      updateTierState(state, tierUpdateFromRecord(raw, checkpoint.diagnostics));
      const safe = rolloutRecord({ record: raw, state, receivedAt, checkpoint });
      if (!safe) return;
      if (safe.observedAt < checkpoint.collectionStartedAt) {
        checkpoint.diagnostics.preCollectionEventsSkipped += 1;
        return;
      }
      if (recentSet.has(safe.eventKey)) {
        checkpoint.diagnostics.duplicateEventsSkipped += 1;
        return;
      }
      addRecentKey(checkpoint, safe.eventKey, recentSet);
      recordBatch.push(safe);
      maximumBufferedRecords = Math.max(maximumBufferedRecords, recordBatch.length);
      if (safe.windows?.length > 0) checkpoint.lastQuotaObservedAt = safe.observedAt;
      if (recordBatch.length >= maximumRecordBatchSize) await flushRecordBatch();
    }, { maximumBufferedLineBytes: relevantLineBytes, signal });
    if (chunk.partialDeferred) checkpoint.diagnostics.partialLinesDeferred += 1;
    checkpoint.diagnostics.oversizedLinesSkipped = (checkpoint.diagnostics.oversizedLinesSkipped ?? 0) + chunk.oversizedLinesSkipped;
    if (chunk.nextOffset !== state.offset) {
      state.offset = chunk.nextOffset;
      markChanged();
    }
    if (state.recentTail?.requestedSinceAt === recentSinceAt) {
      const priorStartMs = Date.parse(state.recentTail.actualCoverageStartAt);
      const priorLatestMs = Date.parse(state.recentTail.latestRelevantAt);
      const mergedStartMs = Math.min(
        Number.isFinite(priorStartMs) ? priorStartMs : Number.POSITIVE_INFINITY,
        earliestRelevantMs,
      );
      const mergedLatestMs = Math.max(
        Number.isFinite(priorLatestMs) ? priorLatestMs : Number.NEGATIVE_INFINITY,
        latestRelevantMs,
      );
      if (Number.isFinite(mergedStartMs)) {
        state.recentTail.actualCoverageStartAt = new Date(mergedStartMs).toISOString();
      }
      if (Number.isFinite(mergedLatestMs)) {
        state.recentTail.latestRelevantAt = new Date(mergedLatestMs).toISOString();
      }
      if (state.recentTail.firstMainAt === null && Number.isFinite(firstRelevantMs)) {
        state.recentTail.firstMainAt = new Date(firstRelevantMs).toISOString();
      }
      if (Number.isFinite(lastRelevantMs)) {
        state.recentTail.lastScannedAt = new Date(lastRelevantMs).toISOString();
      }
      state.recentTail.timestampOrderViolated = timestampOrderViolated;
      state.recentTail.orderingVerified = state.recentTail.orderingVerified === true
        && timestampOrderViolated !== true;
      const firstMainMs = Date.parse(state.recentTail.firstMainAt);
      const boundaryReached = (Number.isFinite(firstMainMs) && firstMainMs <= recentSinceMs)
        || (Number.isFinite(mergedLatestMs) && mergedLatestMs < recentSinceMs);
      state.recentTail.coverageComplete = state.recentTail.orderingVerified === true
        && timestampOrderViolated !== true
        && (state.recentTail.coverageComplete === true || boundaryReached);
      markChanged();
    }
    if (chunk.aborted) {
      aborted = true;
      break;
    }
    if (state.recentTail?.requestedSinceAt === recentSinceAt) {
      recentCoverageComplete &&= state.recentTail.coverageComplete === true;
      const actualStartMs = Date.parse(state.recentTail.actualCoverageStartAt);
      if (Number.isFinite(actualStartMs)) {
        recentCoverageStartMs = Number.isFinite(recentCoverageStartMs)
          ? Math.max(recentCoverageStartMs, actualStartMs)
          : actualStartMs;
      }
    }
    filesProcessed += 1;
    await onProgress?.({
      recordsWritten,
      recordBatchesWritten,
      filesProcessed,
      filesDiscovered: files.length,
    });
  }
  await flushRecordBatch();
  return {
    recordsWritten,
    recordBatchesWritten,
    maximumBufferedRecords,
    filesDiscovered: files.length,
    filesProcessed,
    aborted,
    recentCoverageComplete,
    recentCoverageStartAt: Number.isFinite(recentCoverageStartMs)
      ? new Date(recentCoverageStartMs).toISOString()
      : null,
    sourceBytesReserved: sourceReadBudget,
    resourceLimit,
    changed,
    lastChangeCommitted: commitRecordBatch !== null && committedVersion === changeVersion,
  };
}

function windowsFromAppPayload(payload) {
  const envelope = payload?.rateLimits?.rateLimits ? payload.rateLimits : payload;
  const canonical = sanitizeRateLimit(envelope?.rateLimits ?? envelope);
  const byLimit = envelope?.rateLimitsByLimitId ?? {};
  const limits = new Map();
  if (canonical?.limitId) limits.set(canonical.limitId, canonical);
  for (const [id, raw] of Object.entries(byLimit)) {
    const limit = sanitizeRateLimit(raw);
    if (limit) limits.set(id, limit);
  }
  const windows = [];
  for (const limit of limits.values()) {
    for (const slot of ["primary", "secondary"]) {
      const window = limit?.[slot];
      if (!window) continue;
      windows.push({
        provider: "openai_codex",
        planType: limit.planType ?? "unknown",
        limitId: limit.limitId ?? "unknown",
        slot,
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
      });
    }
  }
  return windows.sort((left, right) => left.limitId.localeCompare(right.limitId) || left.slot.localeCompare(right.slot));
}

export function appServerSnapshotRecord(payload, { source, receivedAt }) {
  const accountSnapshot = payload?.accountScope ? payload : null;
  const windows = windowsFromAppPayload(accountSnapshot?.byLimitId ? {
    rateLimits: accountSnapshot.canonical,
    rateLimitsByLimitId: accountSnapshot.byLimitId,
  } : payload);
  if (windows.length === 0) throw new CodexAppServerError("malformed_output", "Codex app-server returned no valid quota windows");
  const safe = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: receivedAt,
    receivedAt,
    stalenessMs: 0,
    source,
    windows,
    providerSurface: "account_shared_unallocated",
    accountScope: sanitizeAccountScope(accountSnapshot?.accountScope),
    officialDailyTokens: source === "app_server_read" ? (accountSnapshot?.officialDailyTokens ?? []) : [],
    officialUsageSummary: source === "app_server_read" ? (accountSnapshot?.officialUsageSummary ?? null) : null,
    controlledState: "unknown",
  };
  safe.eventKey = eventKey(source === "app_server_notification"
    ? { source, windows, accountScope: safe.accountScope.scopeId }
    : { source, windows, accountScope: safe.accountScope.scopeId, observedAt: receivedAt });
  return safe;
}

/**
 * Return the closed, local-only notification projection for one freshly
 * committed direct provider observation.  This is intentionally not a
 * generic quota serializer: a missing continuity marker, unexpected schema,
 * stale timestamp, or unfamiliar quota window suppresses notifications.
 *
 * The projection is evidence about the codex limit's windows alone.  The
 * separate Spark allowance (`SPARK_QUOTA_LIMIT_IDS`) has ridden alongside
 * them in every direct read since 2026-07-23, so a recognized Spark window
 * is passed over rather than treated as the schema drift that suppresses
 * the receipt; any other limit id still fails closed until it is
 * deliberately modeled.
 *
 * The continuity key is a second one-way digest of the existing local
 * account-scope HMAC.  It permits a local baseline to be partitioned without
 * exposing a provider account subject to the loopback client or notification
 * text.
 */
export function notificationEvidenceFromAppServerRecord(record) {
  if (!record || typeof record !== "object"
      || record.kind !== "codex_quota_snapshot"
      || record.provider !== "openai_codex"
      || record.source !== "app_server_read"
      || record.stalenessMs !== 0
      || record.observedAt !== record.receivedAt) return null;
  const observedAt = record.observedAt;
  const observedAtMs = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observedAtMs)
      || new Date(observedAtMs).toISOString() !== observedAt) return null;

  const accountScope = record.accountScope;
  if (accountScope?.status !== "available"
      || accountScope.version !== "openai-account-v1"
      || !OPENAI_SCOPE_ID_PATTERN.test(accountScope.scopeId ?? "")) return null;
  const continuityKey = createHash("sha256")
    .update(QUOTA_NOTIFICATION_SCOPE_DOMAIN, "utf8")
    .update(accountScope.scopeId, "utf8")
    .digest("base64url");

  if (!Array.isArray(record.windows) || record.windows.length === 0) return null;
  const windows = [];
  for (const window of record.windows) {
    if (!window || typeof window !== "object"
        || window.provider !== "openai_codex") return null;
    // The Spark allowance is a recognized separate pool that this evidence
    // says nothing about, not an unfamiliar window: its numeric fields are
    // deliberately not held to the codex rules below (its live pre-2026-08-19
    // shape was a 525,600-minute window with an unknown plan label, and its
    // re-introduced 2026-08-19 shape mirrors the codex durations exactly).
    if (SPARK_QUOTA_LIMIT_IDS.includes(window.limitId)) continue;
    if (window.limitId !== "codex"
        || !["primary", "secondary"].includes(window.slot)
        || typeof window.planType !== "string"
        || window.planType.length === 0
        || window.planType === "unknown"
        || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0
        || window.usedPercent > 100
        || !Number.isSafeInteger(window.windowDurationMins)
        || !QUOTA_NOTIFICATION_WINDOW_MINUTES.has(window.windowDurationMins)
        || !Number.isSafeInteger(window.resetsAt)
        || window.resetsAt <= 0) return null;
    const resetAtMs = window.resetsAt * 1_000;
    if (!Number.isSafeInteger(resetAtMs)
        || !Number.isFinite(new Date(resetAtMs).getTime())
        || resetAtMs <= observedAtMs) return null;
    windows.push({
      lane: window.slot,
      usedPercent: window.usedPercent,
      durationMinutes: window.windowDurationMins,
      resetAt: new Date(resetAtMs).toISOString(),
      // `resetsAt` tells us which allowance window the provider currently
      // reports. It is a schedule, not an observed reset event or stable
      // provider reset identity. Keep that distinction explicit so native
      // notification code can partition threshold dedupe without pretending
      // that a later schedule has proved a reset occurred.
      resetProofKind: "provider_reported_schedule_only",
    });
  }
  // A snapshot whose only windows belong to the Spark pool carries no codex
  // evidence at all; that is ineligibility, not an empty fresh observation.
  if (windows.length === 0) return null;
  windows.sort((left, right) => left.lane.localeCompare(right.lane));
  return {
    schemaVersion: QUOTA_NOTIFICATION_EVIDENCE_SCHEMA,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey,
    windows,
  };
}

async function readSanitizedAppServerSnapshot(client, capturedAt, loadAccountObservationSecret) {
  const rateLimits = await client.readRateLimits();
  const [account, accountUsage] = await Promise.all([
    typeof client.readAccount === "function" ? client.readAccount().catch(() => null) : Promise.resolve(null),
    typeof client.readAccountUsage === "function" ? client.readAccountUsage().catch(() => null) : Promise.resolve(null),
  ]);
  return sanitizeCodexAccountSnapshotWithSecretLoader(
    { account, rateLimits, accountUsage },
    capturedAt,
    { loadAccountObservationSecret },
  );
}

async function appendAppRecord({ payload, source, checkpoint, clock, commitRecord }) {
  if (typeof commitRecord !== "function") {
    throw new TypeError("commitRecord must be a function");
  }
  const receivedAt = new Date(clock()).toISOString();
  const record = appServerSnapshotRecord(payload, { source, receivedAt });
  const recentSet = new Set(checkpoint.recentEventKeys);
  if (recentSet.has(record.eventKey)) {
    checkpoint.diagnostics.duplicateEventsSkipped += 1;
    return null;
  }
  addRecentKey(checkpoint, record.eventKey, recentSet);
  trimRecentKeys(checkpoint, recentSet, MAX_RECENT_EVENT_KEYS);
  if (Object.hasOwn(payload ?? {}, "accountScope")) {
    if (record.accountScope.reason === "credential_locked") {
      checkpoint.diagnostics.accountCredentialLocked = (checkpoint.diagnostics.accountCredentialLocked ?? 0) + 1;
    }
    if (record.accountScope.reason === "credential_unavailable") {
      checkpoint.diagnostics.accountCredentialUnavailable = (checkpoint.diagnostics.accountCredentialUnavailable ?? 0) + 1;
    }
    if (record.accountScope.status === "available") {
      checkpoint.accountScopeMarker = {
        capturedAt: record.observedAt,
        accountScope: record.accountScope,
        source: record.source,
      };
    } else {
      checkpoint.accountScopeMarker = null;
    }
  }
  checkpoint.lastQuotaObservedAt = record.observedAt;
  checkpoint.diagnostics.appServerRecordsWritten += 1;
  await commitRecord([record]);
  return record;
}

function resultStateProperties(result, { stateFile }) {
  Object.defineProperties(result, {
    stateFile: { value: stateFile, enumerable: false },
  });
  return result;
}

function safeErrorCode(error) {
  if (error instanceof CodexAppServerError) return error.code;
  if (error?.code === "ENOENT") return "app_server_unavailable";
  return "temporary_disconnect";
}

function recordAppServerError(checkpoint, error) {
  checkpoint.diagnostics.appServerErrorCounts ??= {};
  const code = safeErrorCode(error);
  checkpoint.diagnostics.appServerErrorCounts[code] = (checkpoint.diagnostics.appServerErrorCounts[code] ?? 0) + 1;
  return code;
}

// A failed app-server refresh leaves the in-memory checkpoint speculatively
// mutated: the append records the dedupe key and observation stamp before its
// atomic commit, so keeping either after a failed commit would make the next
// pass skip a snapshot that was never stored. Recovery therefore rewinds to
// the durable checkpoint — or, on a first-ever run, to the pristine baseline
// captured at creation, because the durable row is only written after this
// very refresh: a machine whose first quota read fails must still complete
// the pass and record the provider error, not fail every refresh forever.
// Records and checkpoint commit in one transaction, so a null durable row
// also proves no record from this pass was stored and the baseline loses
// nothing. Only a checkpoint that was durably present when the run started
// and is gone now is a store fault; that stays fatal, under a stable code
// the refresh surface can name.
async function rewindCheckpointAfterAppRecordFailure({
  stateFile,
  checkpoint,
  pristineCheckpoint,
}) {
  const restored = await readLocalCollectorCheckpoint({ stateFile });
  if (!restored && pristineCheckpoint === null) {
    const failure = new Error(
      "Collector app-record recovery completed without a durable checkpoint",
    );
    failure.code = "app_record_checkpoint_unavailable";
    throw failure;
  }
  for (const key of Object.keys(checkpoint)) delete checkpoint[key];
  Object.assign(checkpoint, restored ?? structuredClone(pristineCheckpoint));
}

export async function runCollectorOnce({
  codexHome,
  stateFile = defaultCollectorStateFile(),
  staleAfterMs = 60_000,
  refreshStale = true,
  backfill = false,
  backfillSinceAt = null,
  // Unified-index authority does not need the legacy rollout ledger. This
  // opt-in path keeps the checkpoint and quota snapshot semantics, but skips
  // rollout discovery/ingestion entirely so an inherited recent backfill can
  // never keep growing collector state. It is intentionally false by
  // default; legacy callers retain the existing collection behavior.
  skipRolloutIngestion = false,
  signal = null,
  onProgress = null,
  maximumBufferedLineBytes = MAX_BUFFERED_ROLLOUT_LINE_BYTES,
  maximumRecordBatchSize = MAX_RECORD_BATCH_SIZE,
  maximumRecentEventKeys = MAX_RECENT_EVENT_KEYS,
  maximumRecentTailBytes = MAX_RECENT_TAIL_BYTES,
  maximumRecentPreludeBytes = MAX_RECENT_PRELUDE_BYTES,
  maximumRecentRunBytes = MAX_RECENT_RUN_BYTES,
  maximumLineagePrefixBytes = MAX_LINEAGE_PREFIX_BYTES,
  maximumDiscoveryDirectoryEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES,
  maximumDiscoveryRolloutFiles = MAX_DISCOVERY_ROLLOUT_FILES,
  clock = () => Date.now(),
  appServerFactory = () => new CodexAppServerClient(),
  loadAccountObservationSecret = null,
  commitState = commitLocalCollectorState,
  saveState = saveLocalCollectorCheckpoint,
} = {}) {
  if (!validSignal(signal)) throw new TypeError("signal must be an AbortSignal");
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (backfillSinceAt !== null) {
    canonicalInstant(backfillSinceAt, "backfillSinceAt");
    if (!backfill) throw new TypeError("backfillSinceAt requires backfill");
  }
  if (typeof skipRolloutIngestion !== "boolean") {
    throw new TypeError("skipRolloutIngestion must be boolean");
  }
  if (typeof stateFile !== "string" || stateFile.length < 1) {
    throw new TypeError("stateFile must be a non-empty string");
  }
  // The migration lease serializes one-time JSON retirement before the normal
  // collector instance lock. Reversing that order can make a second startup
  // wait on SQLite while the first startup is still importing into it.
  await prepareLocalCollectorState({ stateFile, clock });
  const release = await acquireLocalCollectorStateLock(stateFile, { clock });
  let client = null;
  let abortClient = null;
  // One open connection for the whole run instead of one per batch, and one
  // integrity check plus one fsync at the end instead of one per batch. The
  // per-batch `PRAGMA quick_check` reads every page of the store, so it grew
  // with the store: 636-663 ms of a 754 ms batch on the live 1.7 GB state.
  // Only the built-in write path can be pooled this way; an injected
  // `commitState` or `saveState` keeps its exact previous behaviour.
  // The native Windows SQLite lease is deliberately non-reentrant within one
  // process. The pooled connection cannot coexist with the collector's
  // checkpoint reads (and other state helpers), which open the same database
  // through the protected session boundary. Keep the ordinary pooled
  // connection on macOS/Linux; Windows uses the same protected boundary for
  // each sequential operation so no raw or concurrently leased path is
  // introduced.
  const pooled = !isLocalCollectorStateWindowsBoundaryActive()
    && commitState === commitLocalCollectorState
    && saveState === saveLocalCollectorCheckpoint
    ? await openLocalCollectorStateSession({ stateFile, clock })
    : null;
  let sessionSettled = false;
  try {
    const nowIso = new Date(clock()).toISOString();
    const existing = await readLocalCollectorCheckpoint({ stateFile });
    const saveCheckpoint = async () => {
      await saveState({ stateFile, checkpoint, clock, session: pooled });
    };
    const commitRecords = async (records) => {
      await commitState({ stateFile, records, checkpoint, clock, session: pooled });
    };
    const requestedBackfillStart = backfill
      ? (backfillSinceAt ?? "1970-01-01T00:00:00.000Z")
      : null;
    const checkpoint = existing
      ?? emptyCheckpoint(nowIso, backfill, requestedBackfillStart);
    const indexing = ensureCheckpointIndexing(checkpoint, {
      created: existing === null,
      backfill,
      backfillSinceAt: requestedBackfillStart,
      nowIso,
    });
    // The exact rewind target for a failed app-server refresh on a run that
    // started with no durable checkpoint. Non-null only then: a run that read
    // a durable row must find one again, or fail as a store fault.
    const pristineCheckpoint = existing === null
      ? structuredClone(checkpoint)
      : null;

    if (skipRolloutIngestion) {
      // The unified index owns usage facts. Keep the existing bounded
      // indexing descriptor available to the quick headline, then perform
      // only the independent provider quota refresh below. No raw rollout
      // files are discovered or read, and no legacy collector records are
      // appended.
      await emitIndexingProgress(onProgress, indexing);
      const lastObservedMs = checkpoint.lastQuotaObservedAt
        ? Date.parse(checkpoint.lastQuotaObservedAt)
        : Number.NEGATIVE_INFINITY;
      const shouldRefresh = !signal?.aborted
        && refreshStale
        && clock() - lastObservedMs > staleAfterMs;
      let refresh = { attempted: false, recordWritten: false, errorCode: null };
      if (shouldRefresh) {
        refresh.attempted = true;
        try {
          client = appServerFactory();
          abortClient = () => client?.close();
          signal?.addEventListener("abort", abortClient, { once: true });
          await client.start();
          if (signal?.aborted) throw new Error("collector_aborted");
          const capturedAt = new Date(clock()).toISOString();
          const payload = await readSanitizedAppServerSnapshot(
            client,
            capturedAt,
            loadAccountObservationSecret,
          );
          if (signal?.aborted) throw new Error("collector_aborted");
          const record = await appendAppRecord({
            payload,
            source: "app_server_read",
            checkpoint,
            clock,
            commitRecord: commitRecords,
          });
          refresh.recordWritten = record !== null;
          if (record !== null) {
            const notificationEvidence = notificationEvidenceFromAppServerRecord(record);
            if (notificationEvidence !== null) {
              refresh.notificationEvidence = notificationEvidence;
            }
          }
        } catch (error) {
          await rewindCheckpointAfterAppRecordFailure({
            stateFile,
            checkpoint,
            pristineCheckpoint,
          });
          if (!signal?.aborted) refresh.errorCode = recordAppServerError(checkpoint, error);
        } finally {
          signal?.removeEventListener("abort", abortClient);
          abortClient = null;
          client?.close();
        }
      }
      checkpoint.savedAt = new Date(clock()).toISOString();
      await saveCheckpoint();
      await emitIndexingProgress(onProgress, checkpoint.indexing);
      const skippedResult = {
        mode: "run_once",
        status: signal?.aborted ? "bounded_pause" : "complete",
        pauseReason: signal?.aborted ? "collector_aborted" : null,
        resourceLimit: null,
        rolloutRecordsWritten: 0,
        recordBatchesWritten: 0,
        maximumBufferedRecords: 0,
        filesDiscovered: 0,
        filesSelected: 0,
        filesProcessed: 0,
        refresh,
        indexing: cloneIndexing(checkpoint.indexing),
        diagnostics: publicDiagnostics(checkpoint.diagnostics),
      };
      if (pooled !== null) {
        sessionSettled = true;
        await pooled.close();
      }
      return resultStateProperties(skippedResult, { stateFile });
    }

    const indexingRun = indexing.mode === "recent_7d"
      && !["recent_7d_complete", "recent_7d_partial"].includes(indexing.status);
    const priorIndexedRecords = indexing.status === "bounded_pause"
      ? indexing.recordsWritten
      : 0;
    if (indexingRun) {
      indexing.status = "recent_7d_indexing";
      indexing.phase = "discovering";
      indexing.filesProcessed = 0;
      indexing.coveredAt.endAt = null;
    }
    let discovered;
    try {
      discovered = await discoverCollectorRollouts(codexHome, {
        signal,
        maximumDirectoryEntries: maximumDiscoveryDirectoryEntries,
        maximumRolloutFiles: maximumDiscoveryRolloutFiles,
      });
    } catch (error) {
      if (!COLLECTOR_DISCOVERY_STOP_CODES.has(error?.code)) throw error;
      const discoveryProgress = error.discoveryProgress ?? {};
      const filesDiscovered = Number.isSafeInteger(discoveryProgress.rolloutFiles)
        ? discoveryProgress.rolloutFiles
        : 0;
      if (indexingRun || indexing.mode === "prospective") {
        indexing.status = "bounded_pause";
        indexing.phase = "paused";
        indexing.filesDiscovered = filesDiscovered;
        indexing.filesSelected = 0;
        indexing.filesProcessed = 0;
        indexing.coveredAt.endAt = null;
      }
      checkpoint.indexing = cloneIndexing(indexing);
      recordCollectorResourceLimit(checkpoint, error.resourceLimit);
      checkpoint.savedAt = new Date(clock()).toISOString();
      await saveCheckpoint();
      await emitIndexingProgress(onProgress, checkpoint.indexing);
      const paused = {
        mode: "run_once",
        status: "bounded_pause",
        pauseReason: error.code,
        resourceLimit: error.resourceLimit ?? null,
        rolloutRecordsWritten: 0,
        recordBatchesWritten: 0,
        maximumBufferedRecords: 0,
        filesDiscovered,
        filesSelected: 0,
        filesProcessed: 0,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
        indexing: cloneIndexing(checkpoint.indexing),
        diagnostics: publicDiagnostics(checkpoint.diagnostics),
      };
      return resultStateProperties(paused, { stateFile });
    }
    const collectionStartMs = Date.parse(checkpoint.collectionStartedAt);
    const selected = discovered.filter((file) => rolloutMayOverlap(file, collectionStartMs));
    if (indexingRun || indexing.mode === "prospective") {
      indexing.filesDiscovered = discovered.length;
      indexing.filesSelected = selected.length;
      indexing.filesProcessed = 0;
      if (indexingRun) indexing.recordsWritten = priorIndexedRecords;
    }
    await emitIndexingProgress(onProgress, indexing);
    if (signal?.aborted && indexingRun) {
      indexing.status = "bounded_pause";
      indexing.phase = "paused";
      checkpoint.savedAt = new Date(clock()).toISOString();
      await saveCheckpoint();
      await emitIndexingProgress(onProgress, indexing);
      const paused = {
        mode: "run_once",
        status: "bounded_pause",
        pauseReason: "collector_aborted",
        resourceLimit: null,
        rolloutRecordsWritten: 0,
        recordBatchesWritten: 0,
        maximumBufferedRecords: 0,
        filesDiscovered: discovered.length,
        filesSelected: selected.length,
        filesProcessed: 0,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
        indexing: cloneIndexing(indexing),
        diagnostics: publicDiagnostics(checkpoint.diagnostics),
      };
      return resultStateProperties(paused, { stateFile });
    }
    if (indexingRun) indexing.phase = "rollout_index";
    const ingestion = await ingestRolloutUpdates({
      codexHome,
      checkpoint,
      clock,
      initializeAtEnd: existing === null && !backfill,
      maximumBufferedLineBytes,
      maximumRecordBatchSize,
      maximumRecentEventKeys,
      recentBackfillSinceAt: indexingRun ? checkpoint.collectionStartedAt : null,
      maximumRecentTailBytes,
      maximumRecentPreludeBytes,
      maximumRecentRunBytes,
      maximumLineagePrefixBytes,
      maximumDiscoveryDirectoryEntries,
      maximumDiscoveryRolloutFiles,
      rollouts: selected,
      signal,
      onProgress: async (progress) => {
        if (indexingRun) {
          indexing.filesProcessed = progress.filesProcessed;
          indexing.recordsWritten = priorIndexedRecords + progress.recordsWritten;
        } else if (indexing.mode === "prospective") {
          indexing.filesProcessed = progress.filesProcessed;
          indexing.recordsWritten = progress.recordsWritten;
        }
        await emitIndexingProgress(onProgress, indexing);
      },
      commitRecordBatch: commitRecords,
    });
    recordCollectorResourceLimit(checkpoint, ingestion.resourceLimit);
    if (indexingRun) {
      indexing.filesProcessed = ingestion.filesProcessed;
      indexing.recordsWritten = priorIndexedRecords + ingestion.recordsWritten;
      indexing.status = ingestion.aborted
        ? "bounded_pause"
        : ingestion.recentCoverageComplete
          ? "recent_7d_complete"
          : "recent_7d_partial";
      indexing.phase = ingestion.aborted ? "paused" : "complete";
      indexing.coveredAt.endAt = ingestion.aborted ? null : nowIso;
      if (!ingestion.aborted) {
        indexing.coveredAt.startAt = ingestion.recentCoverageComplete
          ? checkpoint.collectionStartedAt
          : ingestion.recentCoverageStartAt;
      }
    } else if (indexing.mode === "prospective") {
      indexing.status = ingestion.aborted ? "bounded_pause" : "prospective_only";
      indexing.phase = ingestion.aborted ? "paused" : "prospective";
      indexing.filesProcessed = ingestion.filesProcessed;
      indexing.recordsWritten = ingestion.recordsWritten;
      indexing.coveredAt.endAt = ingestion.aborted ? null : nowIso;
    }
    if (ingestion.changed && ingestion.lastChangeCommitted !== true) {
      checkpoint.savedAt = new Date(clock()).toISOString();
      await saveCheckpoint();
    }
    const lastObservedMs = checkpoint.lastQuotaObservedAt ? Date.parse(checkpoint.lastQuotaObservedAt) : Number.NEGATIVE_INFINITY;
    const shouldRefresh = !signal?.aborted
      && refreshStale
      && clock() - lastObservedMs > staleAfterMs;
    let refresh = { attempted: false, recordWritten: false, errorCode: null };
    if (shouldRefresh) {
      if (indexingRun) {
        indexing.phase = "quota_refresh";
        await emitIndexingProgress(onProgress, indexing);
      }
      refresh.attempted = true;
      try {
        client = appServerFactory();
        abortClient = () => client?.close();
        signal?.addEventListener("abort", abortClient, { once: true });
        await client.start();
        if (signal?.aborted) throw new Error("collector_aborted");
        const capturedAt = new Date(clock()).toISOString();
        const payload = await readSanitizedAppServerSnapshot(client, capturedAt, loadAccountObservationSecret);
        if (signal?.aborted) throw new Error("collector_aborted");
        const record = await appendAppRecord({
          payload,
          source: "app_server_read",
          checkpoint,
          clock,
          commitRecord: commitRecords,
        });
        refresh.recordWritten = record !== null;
        if (record !== null) {
          const notificationEvidence = notificationEvidenceFromAppServerRecord(record);
          if (notificationEvidence !== null) {
            refresh.notificationEvidence = notificationEvidence;
          }
        }
      } catch (error) {
        await rewindCheckpointAfterAppRecordFailure({
          stateFile,
          checkpoint,
          pristineCheckpoint,
        });
        if (!signal?.aborted) refresh.errorCode = recordAppServerError(checkpoint, error);
      } finally {
        signal?.removeEventListener("abort", abortClient);
        abortClient = null;
        client?.close();
      }
    }
    if (indexingRun) {
      indexing.phase = ingestion.aborted ? "paused" : "complete";
      checkpoint.indexing = cloneIndexing(indexing);
    }
    checkpoint.savedAt = new Date(clock()).toISOString();
    await saveCheckpoint();
    await emitIndexingProgress(onProgress, checkpoint.indexing);
    const result = {
      mode: "run_once",
      status: ingestion.aborted || signal?.aborted
        ? "bounded_pause"
        : checkpoint.indexing?.status === "recent_7d_partial"
          ? "partial"
          : "complete",
      pauseReason: ingestion.resourceLimit?.code
        ?? (ingestion.aborted || signal?.aborted ? "collector_aborted" : null),
      resourceLimit: ingestion.resourceLimit,
      rolloutRecordsWritten: ingestion.recordsWritten,
      recordBatchesWritten: ingestion.recordBatchesWritten,
      maximumBufferedRecords: ingestion.maximumBufferedRecords,
      filesDiscovered: discovered.length,
      filesSelected: selected.length,
      filesProcessed: ingestion.filesProcessed,
      refresh,
      indexing: cloneIndexing(checkpoint.indexing),
      diagnostics: publicDiagnostics(checkpoint.diagnostics),
    };
    if (pooled !== null) {
      sessionSettled = true;
      await pooled.close();
    }
    return resultStateProperties(result, { stateFile });
  } finally {
    signal?.removeEventListener("abort", abortClient);
    client?.close();
    if (pooled !== null && !sessionSettled) {
      sessionSettled = true;
      // A run that is exiting through an error path still owes the store its
      // settle: everything already committed stays committed, and the
      // integrity check is not skipped just because the run did not finish.
      try {
        await pooled.close();
      } catch {
        await pooled.abort().catch(() => {});
      }
    }
    await release();
  }
}

function waitForAbort(signal, timeoutMs) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, timeoutMs);
    function onAbort() {
      clearTimeout(timer);
      resolve("aborted");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runCollectorForeground({
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  stateFile = defaultCollectorStateFile(),
  staleAfterMs = 60_000,
  reconciliationMs = 60_000,
  reconnectBaseMs = 1_000,
  signal,
  clock = () => Date.now(),
  appServerFactory = () => new CodexAppServerClient(),
  watchRoot = watch,
  loadAccountObservationSecret = null,
  ingestUpdates = ingestRolloutUpdates,
  maximumRecordBatchSize = MAX_RECORD_BATCH_SIZE,
  maximumRecentEventKeys = MAX_RECENT_EVENT_KEYS,
  maximumRecentRunBytes = MAX_RECENT_RUN_BYTES,
  maximumDiscoveryDirectoryEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES,
  maximumDiscoveryRolloutFiles = MAX_DISCOVERY_ROLLOUT_FILES,
  commitState = commitLocalCollectorState,
  saveState = saveLocalCollectorCheckpoint,
} = {}) {
  if (typeof watchRoot !== "function") throw new TypeError("watchRoot must be a function");
  if (typeof stateFile !== "string" || stateFile.length < 1) {
    throw new TypeError("stateFile must be a non-empty string");
  }
  await prepareLocalCollectorState({ stateFile, clock });
  const release = await acquireLocalCollectorStateLock(stateFile, { clock });
  const existing = await readLocalCollectorCheckpoint({ stateFile });
  const checkpoint = existing ?? emptyCheckpoint(new Date(clock()).toISOString(), false);
  let client = null;
  let reconnectAttempts = 0;
  let totalReconnectAttempts = 0;
  let notificationRecords = 0;
  let rolloutRecords = 0;
  let recordBatchesWritten = 0;
  let maximumBufferedRecords = 0;
  let checkpointWrites = 0;
  let ingestionRuns = 0;
  let watcherEvents = 0;
  let watcherFallbackActive = false;
  let wakeReconciliation = null;
  let reconciliationCycles = 0;
  let operationTail = Promise.resolve();
  let ingestionQueued = false;
  let ingestionDirty = false;
  let pendingRateLimitNotification = null;
  let rateLimitNotificationQueued = false;
  let rateLimitNotificationsPaused = false;
  let rateLimitNotificationEvents = 0;
  let rateLimitNotificationOperations = 0;
  let rateLimitNotificationPayloadsProcessed = 0;
  let rateLimitNotificationPayloadsCoalesced = 0;
  let maximumPendingRateLimitNotifications = 0;
  let finalized = false;
  let hasDurableCheckpoint = existing !== null;
  const watchers = [];

  checkpoint.diagnostics.ingestionErrorCounts ??= {};
  checkpoint.diagnostics.watcherErrorCounts ??= {};

  async function save() {
    checkpoint.savedAt = new Date(clock()).toISOString();
    await saveState({ stateFile, checkpoint, clock });
    checkpointWrites += 1;
    hasDurableCheckpoint = true;
  }

  async function restoreCheckpoint() {
    const durable = await readLocalCollectorCheckpoint({ stateFile });
    const restored = durable ?? emptyCheckpoint(checkpoint.collectionStartedAt, false);
    hasDurableCheckpoint = durable !== null;
    for (const key of Object.keys(checkpoint)) delete checkpoint[key];
    Object.assign(checkpoint, restored);
    checkpoint.diagnostics.ingestionErrorCounts ??= {};
    checkpoint.diagnostics.watcherErrorCounts ??= {};
  }

  async function appendForegroundAppRecord(payload, source) {
    try {
      return await appendAppRecord({
        payload,
        source,
        checkpoint,
        clock,
        commitRecord: async (records) => {
          await commitState({ stateFile, records, checkpoint, clock });
          checkpointWrites += 1;
          hasDurableCheckpoint = true;
        },
      });
    } catch (error) {
      await restoreCheckpoint();
      throw error;
    }
  }

  function recordOperationError(kind, error) {
    const code = typeof error?.code === "string" && /^[a-z0-9_:-]{1,64}$/i.test(error.code)
      ? error.code
      : "unknown";
    const key = `${kind}:${code}`;
    checkpoint.diagnostics.ingestionErrorCounts[key] = (checkpoint.diagnostics.ingestionErrorCounts[key] ?? 0) + 1;
  }

  function recordWatcherError(error) {
    const code = typeof error?.code === "string" && /^[a-z0-9_:-]{1,64}$/i.test(error.code)
      ? error.code
      : "unknown";
    checkpoint.diagnostics.watcherErrorCounts[code] =
      (checkpoint.diagnostics.watcherErrorCounts[code] ?? 0) + 1;
  }

  function activateWatcherFallback() {
    watcherFallbackActive = true;
    wakeReconciliation?.();
  }

  function waitForReconciliation(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      function finish(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (wakeReconciliation === wake) wakeReconciliation = null;
        resolve(reason);
      }
      function onAbort() {
        finish("aborted");
      }
      function wake() {
        finish("wake");
      }
      wakeReconciliation = wake;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish("aborted");
        return;
      }
      timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
  }

  function enqueueOperation(kind, operation) {
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        recordOperationError(kind, error);
      }
    };
    operationTail = operationTail.then(run, run);
    return operationTail;
  }

  function queueIngestion() {
    ingestionDirty = true;
    if (ingestionQueued) return operationTail;
    ingestionQueued = true;
    return enqueueOperation("rollout_ingestion", async () => {
      try {
        while (ingestionDirty) {
          ingestionDirty = false;
          ingestionRuns += 1;
          let result;
          try {
            result = await ingestUpdates({
              codexHome,
              checkpoint,
              clock,
              initializeAtEnd: !hasDurableCheckpoint && checkpoint.diagnostics.filesDiscovered === 0,
              maximumRecordBatchSize,
              maximumRecentEventKeys,
              maximumRecentRunBytes,
              maximumDiscoveryDirectoryEntries,
              maximumDiscoveryRolloutFiles,
              signal,
              commitRecordBatch: async (records) => {
                await commitState({ stateFile, records, checkpoint, clock });
                checkpointWrites += 1;
                hasDurableCheckpoint = true;
              },
            });
          } catch (error) {
            await restoreCheckpoint();
            throw error;
          }
          recordCollectorResourceLimit(checkpoint, result.resourceLimit);
          rolloutRecords += result.recordsWritten ?? result.records?.length ?? 0;
          recordBatchesWritten += result.recordBatchesWritten ?? 0;
          maximumBufferedRecords = Math.max(maximumBufferedRecords, result.maximumBufferedRecords ?? 0);
          if (result.changed && result.lastChangeCommitted !== true) await save();
        }
      } finally {
        ingestionQueued = false;
        if (ingestionDirty) queueIngestion();
      }
    });
  }

  async function drainOperations() {
    let observed;
    do {
      observed = operationTail;
      await observed;
    } while (observed !== operationTail);
  }

  async function notificationPayloadFor(connectedClient, canonical) {
    if (!canonical) return canonical;
    let accountScope;
    try {
      const account = typeof connectedClient.readAccount === "function"
        ? await connectedClient.readAccount()
        : null;
      accountScope = await deriveOpenAIAccountScopeWithSecretLoader(account, {
        loadAccountObservationSecret,
        planType: account?.account?.planType ?? canonical.planType,
      });
    } catch {
      accountScope = sanitizeAccountScope(null);
    }
    return {
      accountScope,
      canonical,
      byLimitId: {},
      officialDailyTokens: [],
      officialUsageSummary: null,
    };
  }

  function scheduleRateLimitNotificationOperation() {
    if (rateLimitNotificationsPaused || rateLimitNotificationQueued || pendingRateLimitNotification === null) {
      return operationTail;
    }
    rateLimitNotificationQueued = true;
    rateLimitNotificationOperations += 1;
    return enqueueOperation("rate_limit_notification", async () => {
      try {
        while (pendingRateLimitNotification !== null) {
          const pending = pendingRateLimitNotification;
          pendingRateLimitNotification = null;
          rateLimitNotificationPayloadsProcessed += 1;
          const notificationPayload = await notificationPayloadFor(pending.connectedClient, pending.canonical);
          const record = await appendForegroundAppRecord(notificationPayload, "app_server_notification");
          if (record) notificationRecords += 1;
          if (!record) await save();
        }
      } finally {
        rateLimitNotificationQueued = false;
        if (pendingRateLimitNotification !== null) scheduleRateLimitNotificationOperation();
      }
    });
  }

  function queueRateLimitNotification(connectedClient, payload) {
    rateLimitNotificationEvents += 1;
    let canonical = null;
    try {
      canonical = sanitizeRateLimit(payload?.rateLimits ?? payload);
    } catch {
      // Retain only a fixed invalid sentinel. The queued operation records the
      // same content-free malformed-output failure as the previous path.
    }
    if (pendingRateLimitNotification !== null) rateLimitNotificationPayloadsCoalesced += 1;
    pendingRateLimitNotification = { connectedClient, canonical };
    maximumPendingRateLimitNotifications = Math.max(maximumPendingRateLimitNotifications, 1);
    return scheduleRateLimitNotificationOperation();
  }

  async function connect({ afterReconnect = false } = {}) {
    client?.close();
    client = appServerFactory();
    const connectedClient = client;
    rateLimitNotificationsPaused = true;
    client.on("rateLimitsUpdated", (payload) => {
      queueRateLimitNotification(connectedClient, payload);
    });
    client.on("disconnect", () => {
      client = null;
    });
    try {
      await client.start();
      reconnectAttempts = 0;
      // A client may emit immediately from start(). Keep those snapshots in the
      // one-slot coalescer and finish any prior queued mutation before the
      // direct refresh touches the shared checkpoint/journal.
      await drainOperations();
      const lastObservedMs = checkpoint.lastQuotaObservedAt ? Date.parse(checkpoint.lastQuotaObservedAt) : Number.NEGATIVE_INFINITY;
      if (afterReconnect || clock() - lastObservedMs > staleAfterMs) {
        const capturedAt = new Date(clock()).toISOString();
        const payload = await readSanitizedAppServerSnapshot(client, capturedAt, loadAccountObservationSecret);
        const record = await appendForegroundAppRecord(payload, "app_server_read");
        if (record) notificationRecords += 1;
      }
    } finally {
      rateLimitNotificationsPaused = false;
      scheduleRateLimitNotificationOperation();
    }
  }

  try {
    await queueIngestion();
    try {
      await connect();
    } catch (error) {
      recordAppServerError(checkpoint, error);
      client = null;
      reconnectAttempts = 1;
      totalReconnectAttempts = 1;
    }
    for (const root of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
      try {
        const watcher = watchRoot(root, { recursive: true }, () => {
          watcherEvents += 1;
          queueIngestion();
        });
        watcher.on("error", (error) => {
          recordWatcherError(error);
          activateWatcherFallback();
          watcher.close();
        });
        watchers.push(watcher);
      } catch (error) {
        if (error.code !== "ENOENT") {
          recordWatcherError(error);
          activateWatcherFallback();
        }
      }
    }
    while (!signal?.aborted) {
      const connectedDelay = watcherFallbackActive ? Math.min(reconciliationMs, 1_000) : reconciliationMs;
      const delay = client ? connectedDelay : Math.min(30_000, reconnectBaseMs * 2 ** Math.min(reconnectAttempts, 5));
      if (await waitForReconciliation(delay) === "aborted") break;
      reconciliationCycles += 1;
      await queueIngestion();
      if (!client) {
        try {
          await connect({ afterReconnect: true });
        } catch (error) {
          recordAppServerError(checkpoint, error);
          reconnectAttempts += 1;
          totalReconnectAttempts += 1;
          client = null;
        }
      }
    }
    await drainOperations();
    await save();
    finalized = true;
    return {
      mode: "foreground",
      rolloutRecordsWritten: rolloutRecords,
      recordBatchesWritten,
      maximumBufferedRecords,
      appServerRecordsWritten: notificationRecords,
      reconnectAttempts: totalReconnectAttempts,
      shutdown: "clean",
      diagnostics: checkpoint.diagnostics,
      resourceActivity: {
        checkpointWrites,
        ingestionRuns,
        watcherEvents,
        watcherFallbackActive,
        reconciliationCycles,
        reconciliationMs,
        recordBatchesWritten,
        maximumBufferedRecords,
        rateLimitNotificationEvents,
        rateLimitNotificationOperations,
        rateLimitNotificationPayloadsProcessed,
        rateLimitNotificationPayloadsCoalesced,
        maximumPendingRateLimitNotifications,
      },
    };
  } finally {
    for (const watcher of watchers) watcher.close();
    client?.close();
    await drainOperations().catch(() => {});
    if (!finalized) await save().catch(() => {});
    await release();
  }
}
