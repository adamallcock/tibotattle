import { createHash } from "node:crypto";
import { createReadStream, watch } from "node:fs";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CodexAppServerClient,
  CodexAppServerError,
  deriveOpenAIAccountScopeWithSecretLoader,
  sanitizeCodexAccountSnapshotWithSecretLoader,
  sanitizeRateLimit,
} from "./codex-app-server.js";
import {
  canonicalComponents,
  canonicalRateLimitWindows,
  classifyToolCall,
  normalizeTokenUsage,
  readRolloutLineage,
} from "./codex-log-scan.js";
import { sanitizeAccountScope } from "./account-scope.js";
import { normalizeProviderTier, unknownCodexTier } from "./tier-semantics.js";
import {
  appendJsonLinesOwnerOnly,
  appendOwnerOnlyText,
  readJsonIfExists,
  serializeJsonLines,
  stableJson,
  truncateDurably,
  unlinkDurably,
  writeJsonOwnerOnlyAtomic,
} from "./storage.js";

const CHECKPOINT_SCHEMA_VERSION = "0.3";
const RECORD_SCHEMA_VERSION = "0.3";
const MAX_RECENT_EVENT_KEYS = 5_000;
const MAX_ACCOUNT_SCOPE_MARKER_AGE_MS = 5 * 60_000;
const MAX_BUFFERED_ROLLOUT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BATCH_SIZE = 1_000;
const MAX_RECENT_TAIL_BYTES = 768 * 1024 * 1024;
const MAX_RECENT_PRELUDE_BYTES = 32 * 1024 * 1024;
const MAX_RECENT_RUN_BYTES = 1536 * 1024 * 1024;
const MAX_LINEAGE_PREFIX_BYTES = 1024 * 1024;
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

export function defaultCollectorDataFile() {
  return resolve(process.cwd(), ".usage-monitor", "collector-events.jsonl");
}

export function defaultCollectorCheckpointFile() {
  return resolve(process.cwd(), ".usage-monitor", "collector-checkpoint-v0.3.json");
}

export function defaultCollectorLockFile() {
  return resolve(process.cwd(), ".usage-monitor", "collector.lock");
}

export function defaultCollectorBatchJournalFile(checkpointFile = defaultCollectorCheckpointFile()) {
  return `${checkpointFile}.batch-journal`;
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
  for (const mapKey of ["appServerErrorCounts", "ingestionErrorCounts", "tierSettingCounts"]) {
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

function jsonDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function digestFileSlice(path, start, length) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, length)));
    let position = start;
    let remaining = length;
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Collector batch journal points beyond the event ledger");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function commitCollectorRecordBatch({
  records,
  checkpoint,
  dataFile,
  checkpointFile,
  journalFile = defaultCollectorBatchJournalFile(checkpointFile),
  clock = () => Date.now(),
  writeJournal = writeJsonOwnerOnlyAtomic,
  writeCheckpoint = writeJsonOwnerOnlyAtomic,
  removeJournal = unlinkDurably,
}) {
  const payload = serializeJsonLines(records);
  if (payload.length === 0) return;
  checkpoint.savedAt = new Date(clock()).toISOString();
  const dataStartOffset = await fileSize(dataFile);
  const payloadBytes = Buffer.byteLength(payload);
  const journal = {
    schemaVersion: "0.1",
    state: "prepared",
    dataStartOffset,
    payloadBytes,
    payloadDigest: createHash("sha256").update(payload).digest("hex"),
    checkpointAfterDigest: jsonDigest(checkpoint),
  };
  await writeJournal(journalFile, journal);
  await appendOwnerOnlyText(dataFile, payload, { sync: true });
  await writeCheckpoint(checkpointFile, checkpoint);
  await removeJournal(journalFile);
}

export async function recoverCollectorBatchJournal({
  dataFile,
  checkpointFile,
  journalFile = defaultCollectorBatchJournalFile(checkpointFile),
  truncateLedger = truncateDurably,
  removeJournal = unlinkDurably,
}) {
  const journal = await readJsonIfExists(journalFile, null);
  if (journal === null) return { status: "none" };
  const valid = journal.schemaVersion === "0.1"
    && journal.state === "prepared"
    && Number.isSafeInteger(journal.dataStartOffset)
    && journal.dataStartOffset >= 0
    && Number.isSafeInteger(journal.payloadBytes)
    && journal.payloadBytes > 0
    && typeof journal.payloadDigest === "string"
    && /^[a-f0-9]{64}$/.test(journal.payloadDigest)
    && typeof journal.checkpointAfterDigest === "string"
    && /^[a-f0-9]{64}$/.test(journal.checkpointAfterDigest);
  if (!valid) throw new Error("Collector batch journal is malformed; refusing automatic recovery");

  const durableCheckpoint = await readJsonIfExists(checkpointFile, null);
  const checkpointCommitted = durableCheckpoint !== null && jsonDigest(durableCheckpoint) === journal.checkpointAfterDigest;
  const size = await fileSize(dataFile);
  const expectedEnd = journal.dataStartOffset + journal.payloadBytes;
  if (size < journal.dataStartOffset || size > expectedEnd) {
    throw new Error("Collector event ledger changed outside the prepared batch; refusing automatic recovery");
  }
  if (checkpointCommitted) {
    if (size !== expectedEnd) throw new Error("Collector checkpoint committed but its event batch is incomplete");
    const digest = await digestFileSlice(dataFile, journal.dataStartOffset, journal.payloadBytes);
    if (digest !== journal.payloadDigest) throw new Error("Collector committed event batch failed digest verification");
    await removeJournal(journalFile);
    return { status: "committed_batch_retained" };
  }

  if (size === expectedEnd) {
    const digest = await digestFileSlice(dataFile, journal.dataStartOffset, journal.payloadBytes);
    if (digest !== journal.payloadDigest) throw new Error("Collector uncommitted event batch failed digest verification");
  }
  if (size !== journal.dataStartOffset) await truncateLedger(dataFile, journal.dataStartOffset);
  await removeJournal(journalFile);
  return { status: size === journal.dataStartOffset ? "prepared_batch_absent" : "uncommitted_batch_rolled_back" };
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

async function collectJsonlFiles(root, location) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const metadata = await stat(path);
        files.push({ path, location, metadata });
      }
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
  { sinceAt = null } = {},
) {
  const sinceMs = sinceAt === null ? Number.NaN : Date.parse(canonicalInstant(sinceAt, "sinceAt"));
  const [active, archived] = await Promise.all([
    collectJsonlFiles(join(codexHome, "sessions"), "active"),
    collectJsonlFiles(join(codexHome, "archived_sessions"), "archive"),
  ]);
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
  maximumBufferedLineBytes = MAX_BUFFERED_ROLLOUT_LINE_BYTES,
  highWaterMark = 256 * 1024,
  signal = null,
} = {}) {
  if (size <= offset) {
    return {
      nextOffset: offset,
      partialDeferred: false,
      oversizedLinesSkipped: 0,
      aborted: signal?.aborted === true,
    };
  }
  const input = createReadStream(path, { start: offset, end: size - 1, highWaterMark });
  let lineChunks = [];
  let lineBytes = 0;
  let skippingOversized = false;
  let absolutePosition = offset;
  let nextOffset = offset;
  let oversizedLinesSkipped = 0;
  let aborted = false;

  function appendSegment(segment) {
    if (skippingOversized || segment.length === 0) return;
    lineBytes += segment.length;
    if (lineBytes > maximumBufferedLineBytes) {
      lineChunks = [];
      skippingOversized = true;
      return;
    }
    lineChunks.push(segment);
  }

  for await (const chunk of input) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (chunk[index] !== 0x0a) continue;
      appendSegment(chunk.subarray(segmentStart, index));
      const lineEndOffset = absolutePosition + index + 1;
      if (skippingOversized) oversizedLinesSkipped += 1;
      else await onLine(Buffer.concat(lineChunks, lineBytes).toString("utf8"), lineEndOffset);
      lineChunks = [];
      lineBytes = 0;
      skippingOversized = false;
      nextOffset = lineEndOffset;
      segmentStart = index + 1;
    }
    if (aborted) break;
    appendSegment(chunk.subarray(segmentStart));
    absolutePosition += chunk.length;
  }
  return {
    nextOffset,
    partialDeferred: !aborted && absolutePosition > nextOffset,
    oversizedLinesSkipped,
    aborted,
  };
}

async function seedCursorFromTail(path, size, {
  maximumBytes = 8 * 1024 * 1024,
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
  dataFile,
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
  commitRecordBatch = null,
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
  const files = rollouts ?? await discoverCollectorRollouts(codexHome);
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
  let recentReadBudget = 0;
  let recentCoverageComplete = true;
  let recentCoverageStartMs = Number.NaN;
  const receivedAt = new Date(clock()).toISOString();

  function markChanged() {
    changed = true;
    changeVersion += 1;
  }

  async function flushRecordBatch() {
    if (recordBatch.length === 0) return;
    trimRecentKeys(checkpoint, recentSet, maximumRecentEventKeys);
    const batchSize = recordBatch.length;
    checkpoint.diagnostics.rolloutRecordsWritten += batchSize;
    checkpoint.diagnostics.rolloutRecordBatchesWritten = (checkpoint.diagnostics.rolloutRecordBatchesWritten ?? 0) + 1;
    if (commitRecordBatch) await commitRecordBatch(recordBatch);
    else await appendJsonLinesOwnerOnly(dataFile, recordBatch);
    recordsWritten += batchSize;
    recordBatchesWritten += 1;
    recordBatch = [];
    if (commitRecordBatch) committedVersion = changeVersion;
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
        if (recentReadBudget + reservedRead > maximumRecentRunBytes) {
          aborted = true;
          break;
        }
        recentReadBudget += reservedRead;
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
      } else if (recentSinceAt !== null) {
        const estimatedRead = file.metadata.size + maximumLineagePrefixBytes;
        if (recentReadBudget + estimatedRead > maximumRecentRunBytes) {
          aborted = true;
          break;
        }
        recentReadBudget += estimatedRead;
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
    } else if (recentSinceAt !== null && file.metadata.size > state.offset) {
      const estimatedRead = file.metadata.size - state.offset;
      if (recentReadBudget + estimatedRead > maximumRecentRunBytes) {
        aborted = true;
        break;
      }
      recentReadBudget += estimatedRead;
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
    const chunk = await forEachCompleteLine(file.path, state.offset, file.metadata.size, async (line, lineEndOffset) => {
      state.offset = lineEndOffset;
      markChanged();
      if (!line) return;
      checkpoint.diagnostics.completeLinesRead += 1;
      if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"thread_settings_applied"') && !line.includes('"function_call"') && !line.includes("tool_call")) return;
      let raw;
      try {
        raw = JSON.parse(line);
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
    }, { maximumBufferedLineBytes, signal });
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

async function appendAppRecord({ payload, source, checkpoint, dataFile, clock, commitRecord = null }) {
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
  if (commitRecord) await commitRecord([record]);
  else await appendJsonLinesOwnerOnly(dataFile, [record]);
  return record;
}

export async function acquireCollectorLock(lockFile, { clock = () => Date.now(), processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
} } = {}) {
  await mkdir(dirname(lockFile), { recursive: true });
  async function acquire(allowStaleRecovery) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(clock()).toISOString() }));
      await handle.close();
      return async () => {
        try {
          await unlink(lockFile);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJsonIfExists(lockFile, {});
      if (allowStaleRecovery && Number.isInteger(existing?.pid) && !processExists(existing.pid)) {
        await unlink(lockFile);
        return acquire(false);
      }
      throw new Error(`Collector lock is already held at ${lockFile}`);
    }
  }
  return acquire(true);
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

export async function runCollectorOnce({
  codexHome,
  dataFile = defaultCollectorDataFile(),
  checkpointFile = defaultCollectorCheckpointFile(),
  lockFile = defaultCollectorLockFile(),
  journalFile = defaultCollectorBatchJournalFile(checkpointFile),
  staleAfterMs = 60_000,
  refreshStale = true,
  backfill = false,
  backfillSinceAt = null,
  signal = null,
  onProgress = null,
  maximumBufferedLineBytes = MAX_BUFFERED_ROLLOUT_LINE_BYTES,
  maximumRecordBatchSize = MAX_RECORD_BATCH_SIZE,
  maximumRecentEventKeys = MAX_RECENT_EVENT_KEYS,
  maximumRecentTailBytes = MAX_RECENT_TAIL_BYTES,
  maximumRecentPreludeBytes = MAX_RECENT_PRELUDE_BYTES,
  maximumRecentRunBytes = MAX_RECENT_RUN_BYTES,
  maximumLineagePrefixBytes = MAX_LINEAGE_PREFIX_BYTES,
  clock = () => Date.now(),
  appServerFactory = () => new CodexAppServerClient(),
  loadAccountObservationSecret = null,
  commitBatch = commitCollectorRecordBatch,
} = {}) {
  if (!validSignal(signal)) throw new TypeError("signal must be an AbortSignal");
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (backfillSinceAt !== null) {
    canonicalInstant(backfillSinceAt, "backfillSinceAt");
    if (!backfill) throw new TypeError("backfillSinceAt requires backfill");
  }
  const release = await acquireCollectorLock(lockFile, { clock });
  let client = null;
  let abortClient = null;
  try {
    await recoverCollectorBatchJournal({ dataFile, checkpointFile, journalFile });
    const nowIso = new Date(clock()).toISOString();
    const existing = await readJsonIfExists(checkpointFile, null);
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
    const discovered = await discoverCollectorRollouts(codexHome);
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
      await writeJsonOwnerOnlyAtomic(checkpointFile, checkpoint);
      await emitIndexingProgress(onProgress, indexing);
      const paused = {
        mode: "run_once",
        status: "bounded_pause",
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
      Object.defineProperties(paused, {
        checkpointFile: { value: checkpointFile, enumerable: false },
        dataFile: { value: dataFile, enumerable: false },
      });
      return paused;
    }
    if (indexingRun) indexing.phase = "rollout_index";
    const ingestion = await ingestRolloutUpdates({
      codexHome,
      checkpoint,
      dataFile,
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
      commitRecordBatch: (records) => commitBatch({
        records,
        checkpoint,
        dataFile,
        checkpointFile,
        journalFile,
        clock,
      }),
    });
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
      await writeJsonOwnerOnlyAtomic(checkpointFile, checkpoint);
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
          dataFile,
          clock,
          commitRecord: (records) => commitBatch({
            records,
            checkpoint,
            dataFile,
            checkpointFile,
            journalFile,
            clock,
          }),
        });
        refresh.recordWritten = record !== null;
      } catch (error) {
        if (await readJsonIfExists(journalFile, null)) {
          const recovery = await recoverCollectorBatchJournal({ dataFile, checkpointFile, journalFile });
          if (recovery.status === "committed_batch_retained") refresh.recordWritten = true;
        }
        const restored = await readJsonIfExists(checkpointFile, null);
        if (!restored) throw new Error("Collector app-record recovery completed without a durable checkpoint");
        for (const key of Object.keys(checkpoint)) delete checkpoint[key];
        Object.assign(checkpoint, restored);
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
    await writeJsonOwnerOnlyAtomic(checkpointFile, checkpoint);
    await emitIndexingProgress(onProgress, checkpoint.indexing);
    const result = {
      mode: "run_once",
      status: ingestion.aborted || signal?.aborted
        ? "bounded_pause"
        : checkpoint.indexing?.status === "recent_7d_partial"
          ? "partial"
          : "complete",
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
    Object.defineProperties(result, {
      checkpointFile: { value: checkpointFile, enumerable: false },
      dataFile: { value: dataFile, enumerable: false },
    });
    return result;
  } finally {
    signal?.removeEventListener("abort", abortClient);
    client?.close();
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
  dataFile = defaultCollectorDataFile(),
  checkpointFile = defaultCollectorCheckpointFile(),
  lockFile = defaultCollectorLockFile(),
  journalFile = defaultCollectorBatchJournalFile(checkpointFile),
  staleAfterMs = 60_000,
  reconciliationMs = 60_000,
  reconnectBaseMs = 1_000,
  signal,
  clock = () => Date.now(),
  appServerFactory = () => new CodexAppServerClient(),
  loadAccountObservationSecret = null,
  ingestUpdates = ingestRolloutUpdates,
  maximumRecordBatchSize = MAX_RECORD_BATCH_SIZE,
  maximumRecentEventKeys = MAX_RECENT_EVENT_KEYS,
} = {}) {
  const release = await acquireCollectorLock(lockFile, { clock });
  let existing;
  try {
    await recoverCollectorBatchJournal({ dataFile, checkpointFile, journalFile });
    existing = await readJsonIfExists(checkpointFile, null);
  } catch (error) {
    await release();
    throw error;
  }
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

  async function save() {
    checkpoint.savedAt = new Date(clock()).toISOString();
    await writeJsonOwnerOnlyAtomic(checkpointFile, checkpoint);
    checkpointWrites += 1;
    hasDurableCheckpoint = true;
  }

  async function restoreCheckpoint() {
    await recoverCollectorBatchJournal({ dataFile, checkpointFile, journalFile });
    const durable = await readJsonIfExists(checkpointFile, null);
    const restored = durable ?? emptyCheckpoint(checkpoint.collectionStartedAt, false);
    hasDurableCheckpoint = durable !== null;
    for (const key of Object.keys(checkpoint)) delete checkpoint[key];
    Object.assign(checkpoint, restored);
    checkpoint.diagnostics.ingestionErrorCounts ??= {};
  }

  async function appendForegroundAppRecord(payload, source) {
    try {
      return await appendAppRecord({
        payload,
        source,
        checkpoint,
        dataFile,
        clock,
        commitRecord: async (records) => {
          await commitCollectorRecordBatch({ records, checkpoint, dataFile, checkpointFile, journalFile, clock });
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
              dataFile,
              clock,
              initializeAtEnd: !hasDurableCheckpoint && checkpoint.diagnostics.filesDiscovered === 0,
              maximumRecordBatchSize,
              maximumRecentEventKeys,
              commitRecordBatch: async (records) => {
                await commitCollectorRecordBatch({ records, checkpoint, dataFile, checkpointFile, journalFile, clock });
                checkpointWrites += 1;
                hasDurableCheckpoint = true;
              },
            });
          } catch (error) {
            await restoreCheckpoint();
            throw error;
          }
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
        const watcher = watch(root, { recursive: true }, () => {
          watcherEvents += 1;
          queueIngestion();
        });
        watchers.push(watcher);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    while (!signal?.aborted) {
      const delay = client ? reconciliationMs : Math.min(30_000, reconnectBaseMs * 2 ** Math.min(reconnectAttempts, 5));
      if (await waitForAbort(signal, delay) === "aborted") break;
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
