import {
  CODEX_COLLECTOR_CANDIDATE_VERSION,
  ExportResourceLimitError,
} from "../../export/index.js";

export function createCodexCollectorExportContext(configuration) {
const {
  allocUnsafe,
  bufferByteLength,
  createHash,
  createExportResourceGuard,
  currentUid,
  fsConstants: constants,
  lstat,
  open,
  platform,
  readBoundedUtf8LineEntries,
  resolvePath: resolve,
} = configuration;

const CODEX_COLLECTOR_SOURCE_PLAN_VERSION = "codex-collector-export-source-plan-v0.1";
const CODEX_COLLECTOR_SOURCE_CURSOR_VERSION = "codex-collector-export-cursor-v0.1";

const COLLECTOR_RECORD_VERSION = "0.3";
const ACCOUNT_SCOPE_VERSION = "openai-account-v1";
const ACCOUNT_SCOPE_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const PLAN_TYPES = new Set(["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"]);
const LIMIT_IDS = new Set(["codex", "codex-spark"]);
const SOURCES = new Set(["app_server_read", "app_server_notification"]);
const SLOTS = new Set(["primary", "secondary"]);
const ACCOUNT_UNAVAILABLE_REASONS = new Set([
  "missing_account", "malformed_subject", "missing_secret", "credential_locked", "credential_unavailable",
]);
const MAXIMUM_WINDOW_MINUTES = 366 * 24 * 60;
const RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "provider",
  "observedAt",
  "receivedAt",
  "stalenessMs",
  "source",
  "windows",
  "providerSurface",
  "accountScope",
  "officialDailyTokens",
  "officialUsageSummary",
  "controlledState",
  "eventKey",
]);
const WINDOW_KEYS = Object.freeze([
  "provider", "planType", "limitId", "slot", "usedPercent", "windowDurationMins", "resetsAt",
]);
const ACCOUNT_KEYS = Object.freeze(["status", "reason", "version", "scopeId", "planType"]);
const DAILY_TOKEN_KEYS = Object.freeze(["date", "tokens"]);
const SUMMARY_KEYS = Object.freeze([
  "currentStreakDays", "lifetimeTokens", "longestRunningTurnSec", "longestStreakDays", "peakDailyTokens",
]);
const SAFE_SOURCE_CODES = new Set([
  "source_missing",
  "source_type",
  "source_owner",
  "source_links",
  "source_permissions",
  "source_changed",
  "source_prefix",
  "plan_invalid",
  "cursor_invalid",
]);
const PLAN_KEYS = Object.freeze([
  "schemaVersion", "startAt", "endAt", "path", "device", "inode", "birthtimeMs",
  "prefixBytes", "prefixLines", "prefixSha256", "sourcePlanSha256",
]);

class CodexCollectorExportSourceError extends Error {
  constructor(code) {
    if (!SAFE_SOURCE_CODES.has(code)) throw new TypeError("Unknown Codex collector export-source failure code");
    super(`Codex collector export source failed (${code})`);
    this.name = "CodexCollectorExportSourceError";
    this.code = `codex_collector_export_${code}`;
  }
}

function fail(code) {
  throw new CodexCollectorExportSourceError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? canonical : null;
}

function normalizeBound(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("plan_invalid");
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function stablePlanMaterial(plan) {
  return JSON.stringify({
    schemaVersion: CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
    startAt: plan.startAt,
    endAt: plan.endAt,
    path: plan.path,
    device: plan.device,
    inode: plan.inode,
    birthtimeMs: plan.birthtimeMs,
    prefixBytes: plan.prefixBytes,
    prefixLines: plan.prefixLines,
    prefixSha256: plan.prefixSha256,
  });
}

function sourcePlanDigest(plan) {
  return createHash("sha256")
    .update("app-usagemonitor/codex-collector-source-plan/v0.1\0")
    .update(stablePlanMaterial(plan))
    .digest("hex");
}

function sameIdentity(stats, expected) {
  return stats.dev === expected.device
    && stats.ino === expected.inode
    && Math.trunc(stats.birthtimeMs) === expected.birthtimeMs;
}

function assertSafeSourceStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("source_type");
  if (stats.nlink !== 1) fail("source_links");
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) fail("source_owner");
  if (platform !== "win32" && (stats.mode & 0o077) !== 0) fail("source_permissions");
}

async function openSafeSource(path, expected = null) {
  let pathStats;
  let handle;
  try {
    pathStats = await lstat(path);
    assertSafeSourceStats(pathStats);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStats = await handle.stat();
    assertSafeSourceStats(descriptorStats);
    if (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) fail("source_changed");
    if (expected && !sameIdentity(descriptorStats, expected)) fail("source_changed");
    return { handle, stats: descriptorStats };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof CodexCollectorExportSourceError) throw error;
    if (error?.code === "ENOENT") fail("source_missing");
    if (error?.code === "ELOOP") fail("source_type");
    fail("source_changed");
  }
}

async function completeLinePrefixBytes(handle, size, resourceGuard) {
  if (!Number.isSafeInteger(size) || size < 0) fail("source_changed");
  const chunkSize = 256 * 1024;
  const maximumTailBytes = resourceGuard?.limits?.maximumLineBytes;
  if (!Number.isSafeInteger(maximumTailBytes) || maximumTailBytes < 1) {
    throw new TypeError("Codex collector prefix discovery requires a bounded maximum line size");
  }
  let scannedBytes = 0;
  for (let end = size; end > 0;) {
    resourceGuard?.checkRuntime();
    const remainingDiscoveryBytes = maximumTailBytes + 1 - scannedBytes;
    if (remainingDiscoveryBytes <= 0) throw new ExportResourceLimitError("line_bytes");
    const start = Math.max(0, end - Math.min(chunkSize, remainingDiscoveryBytes));
    const buffer = allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) fail("source_changed");
    scannedBytes += bytesRead;
    const newline = buffer.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    if (scannedBytes > maximumTailBytes) throw new ExportResourceLimitError("line_bytes");
    end = start;
  }
  return 0;
}

async function countPrefixLines(handle, prefixBytes, resourceGuard) {
  const buffer = allocUnsafe(256 * 1024);
  let offset = 0;
  let lines = 0;
  while (offset < prefixBytes) {
    resourceGuard?.checkRuntime();
    const length = Math.min(buffer.length, prefixBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) lines += 1;
    }
    offset += bytesRead;
  }
  return lines;
}

async function hashAndCountPrefix(handle, prefixBytes, resourceGuard) {
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) fail("source_prefix");
  const digest = createHash("sha256");
  const buffer = allocUnsafe(256 * 1024);
  let offset = 0;
  let lines = 0;
  while (offset < prefixBytes) {
    resourceGuard?.checkRuntime();
    const length = Math.min(buffer.length, prefixBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    for (let index = 0; index < bytesRead; index += 1) {
      if (chunk[index] === 0x0a) lines += 1;
    }
    offset += bytesRead;
  }
  return { prefixSha256: digest.digest("hex"), prefixLines: lines };
}

function validatePlan(plan) {
  if (!exactKeys(plan, PLAN_KEYS)
      || plan.schemaVersion !== CODEX_COLLECTOR_SOURCE_PLAN_VERSION
      || typeof plan.path !== "string" || plan.path.length === 0
      || !canonicalIso(plan.startAt) || !canonicalIso(plan.endAt)
      || Date.parse(plan.endAt) < Date.parse(plan.startAt)
      || !Number.isSafeInteger(plan.device) || plan.device < 0
      || !Number.isSafeInteger(plan.inode) || plan.inode < 0
      || !Number.isFinite(plan.birthtimeMs) || plan.birthtimeMs < 0
      || !Number.isSafeInteger(plan.prefixBytes) || plan.prefixBytes < 0
      || !Number.isSafeInteger(plan.prefixLines) || plan.prefixLines < 0
      || !SHA256_PATTERN.test(plan.prefixSha256 ?? "")
      || !SHA256_PATTERN.test(plan.sourcePlanSha256 ?? "")
      || sourcePlanDigest(plan) !== plan.sourcePlanSha256) fail("plan_invalid");
  return plan;
}

async function verifyOpenedPrefixBoundary(plan, handle) {
  const descriptorStats = await handle.stat();
  assertSafeSourceStats(descriptorStats);
  if (!sameIdentity(descriptorStats, plan) || descriptorStats.size < plan.prefixBytes) fail("source_changed");
  if (plan.prefixBytes > 0) {
    const tail = allocUnsafe(1);
    const { bytesRead } = await handle.read(tail, 0, 1, plan.prefixBytes - 1);
    if (bytesRead !== 1 || tail[0] !== 0x0a) fail("source_prefix");
  }
}

async function verifyBoundPath(plan) {
  let pathStats;
  try {
    pathStats = await lstat(plan.path);
  } catch (error) {
    if (error?.code === "ENOENT") fail("source_missing");
    fail("source_changed");
  }
  assertSafeSourceStats(pathStats);
  if (!sameIdentity(pathStats, plan)) fail("source_changed");
}

async function verifyOpenedPrefix(plan, handle, resourceGuard) {
  await verifyOpenedPrefixBoundary(plan, handle);
  const measured = await hashAndCountPrefix(handle, plan.prefixBytes, resourceGuard);
  if (measured.prefixSha256 !== plan.prefixSha256 || measured.prefixLines !== plan.prefixLines) {
    fail("source_changed");
  }
  await verifyBoundPath(plan);
}

async function createCodexCollectorExportSourcePlan({
  collectorPath,
  startAt,
  endAt,
  resourceGuard = createExportResourceGuard(),
} = {}) {
  if (typeof collectorPath !== "string" || collectorPath.length === 0) fail("plan_invalid");
  const start = normalizeBound(startAt);
  const end = normalizeBound(endAt);
  if (end.milliseconds < start.milliseconds) fail("plan_invalid");
  resourceGuard.assertCoveredInterval(start.milliseconds, end.milliseconds);
  const canonicalPath = resolve(collectorPath);
  const { handle, stats } = await openSafeSource(canonicalPath);
  try {
    // Prefix discovery scans backward from EOF. Enforce the declared source
    // ceiling before the first discovery read so a sparse or unterminated file
    // cannot turn planning into an unbounded pre-policy scan.
    if (stats.size > resourceGuard.limits.maximumSourceBytes) {
      throw new ExportResourceLimitError("source_bytes");
    }
    const prefixBytes = await completeLinePrefixBytes(handle, stats.size, resourceGuard);
    const plan = {
      schemaVersion: CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
      startAt: start.iso,
      endAt: end.iso,
      path: canonicalPath,
      device: stats.dev,
      inode: stats.ino,
      birthtimeMs: Math.trunc(stats.birthtimeMs),
      prefixBytes,
      ...(await hashAndCountPrefix(handle, prefixBytes, resourceGuard)),
    };
    plan.sourcePlanSha256 = sourcePlanDigest(plan);
    resourceGuard.observeSourcePlan(1, prefixBytes);
    await verifyOpenedPrefix(plan, handle, resourceGuard);
    return Object.freeze(plan);
  } finally {
    await handle.close();
  }
}

async function verifyCodexCollectorExportSourcePlan(plan, {
  resourceGuard = createExportResourceGuard(),
} = {}) {
  validatePlan(plan);
  resourceGuard.assertCoveredInterval(Date.parse(plan.startAt), Date.parse(plan.endAt));
  resourceGuard.observeSourcePlan(1, plan.prefixBytes);
  const { handle } = await openSafeSource(plan.path, plan);
  try {
    await verifyOpenedPrefix(plan, handle, resourceGuard);
  } finally {
    await handle.close();
  }
  return {
    schemaVersion: CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
    sourcePlanSha256: plan.sourcePlanSha256,
    sourceFiles: 1,
    sourceBytes: plan.prefixBytes,
  };
}

function createCodexCollectorExportCursor(plan) {
  validatePlan(plan);
  return {
    schemaVersion: CODEX_COLLECTOR_SOURCE_CURSOR_VERSION,
    sourcePlanSha256: plan.sourcePlanSha256,
    nextByte: 0,
    nextLineOrdinal: 1,
    nextWindowOrdinal: 0,
  };
}

function validateCursor(plan, cursor) {
  const value = cursor ?? createCodexCollectorExportCursor(plan);
  if (!exactKeys(value, [
    "schemaVersion", "sourcePlanSha256", "nextByte", "nextLineOrdinal", "nextWindowOrdinal",
  ])
      || value.schemaVersion !== CODEX_COLLECTOR_SOURCE_CURSOR_VERSION
      || value.sourcePlanSha256 !== plan.sourcePlanSha256
      || !Number.isSafeInteger(value.nextByte) || value.nextByte < 0 || value.nextByte > plan.prefixBytes
      || !Number.isSafeInteger(value.nextLineOrdinal) || value.nextLineOrdinal < 1
      || value.nextLineOrdinal > plan.prefixLines + 1
      || !Number.isSafeInteger(value.nextWindowOrdinal) || value.nextWindowOrdinal < 0
      || (value.nextByte === plan.prefixBytes
        && (value.nextWindowOrdinal !== 0 || value.nextLineOrdinal !== plan.prefixLines + 1))) fail("cursor_invalid");
  return { ...value };
}

async function verifyCursorBoundary(handle, cursor, resourceGuard, { verifyLineOrdinal = true } = {}) {
  if (cursor.nextByte > 0) {
    const preceding = allocUnsafe(1);
    const { bytesRead } = await handle.read(preceding, 0, 1, cursor.nextByte - 1);
    if (bytesRead !== 1 || preceding[0] !== 0x0a) fail("cursor_invalid");
  }
  if (verifyLineOrdinal
      && await countPrefixLines(handle, cursor.nextByte, resourceGuard) !== cursor.nextLineOrdinal - 1) {
    fail("cursor_invalid");
  }
}

function validNonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isoFromUnixSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 1) return null;
  try {
    return new Date(value * 1_000).toISOString();
  } catch {
    return null;
  }
}

function validateOfficialFields(record) {
  if (!Array.isArray(record.officialDailyTokens)
      || !record.officialDailyTokens.every((bucket) => exactKeys(bucket, DAILY_TOKEN_KEYS)
        && typeof bucket.date === "string" && DATE_PATTERN.test(bucket.date)
        && validNonnegativeNumber(bucket.tokens))) return false;
  if (record.officialUsageSummary !== null
      && (!exactKeys(record.officialUsageSummary, SUMMARY_KEYS)
        || !SUMMARY_KEYS.every((key) => record.officialUsageSummary[key] === null
          || validNonnegativeNumber(record.officialUsageSummary[key])))) return false;
  if (record.source === "app_server_notification"
      && (record.officialDailyTokens.length !== 0 || record.officialUsageSummary !== null)) return false;
  return true;
}

function validateAccountScope(value) {
  if (!exactKeys(value, ACCOUNT_KEYS) || value.version !== ACCOUNT_SCOPE_VERSION) return null;
  const validPlanType = value.planType === null || PLAN_TYPES.has(value.planType);
  if (!validPlanType) return null;
  if (value.status === "available" && value.reason === null && ACCOUNT_SCOPE_PATTERN.test(value.scopeId ?? "")) {
    return { subject: value.scopeId, planType: value.planType };
  }
  if (value.status === "unavailable" && ACCOUNT_UNAVAILABLE_REASONS.has(value.reason)
      && value.scopeId === null) return { subject: "unattributed", planType: value.planType };
  return null;
}

function validateWindows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMIT_IDS.size * SLOTS.size) return null;
  const windows = [];
  const keys = new Set();
  let priorSortKey = null;
  for (const window of value) {
    if (!exactKeys(window, WINDOW_KEYS)
        || window.provider !== "openai_codex"
        || !PLAN_TYPES.has(window.planType)
        || !LIMIT_IDS.has(window.limitId)
        || !SLOTS.has(window.slot)
        || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || !Number.isSafeInteger(window.windowDurationMins) || window.windowDurationMins < 1
        || window.windowDurationMins > MAXIMUM_WINDOW_MINUTES
        || isoFromUnixSeconds(window.resetsAt) === null) return null;
    const key = `${window.limitId}\0${window.slot}`;
    if (keys.has(key) || (priorSortKey !== null && key.localeCompare(priorSortKey) <= 0)) return null;
    keys.add(key);
    priorSortKey = key;
    windows.push(window);
  }
  return windows;
}

function freshDiagnostics() {
  return {
    linesSeen: 0,
    candidatesEmitted: 0,
    emptyLines: 0,
    irrelevantRecords: 0,
    malformedJsonLines: 0,
    malformedRecordShapes: 0,
    unsupportedSchemaRecords: 0,
    unsupportedSourceRecords: 0,
    malformedWindows: 0,
    malformedAccountScopes: 0,
    outOfBoundsRecords: 0,
    oversizedIrrelevantLines: 0,
  };
}

function classifyRecord(record, bounds, diagnostics) {
  if (!isPlainObject(record)) {
    diagnostics.malformedRecordShapes += 1;
    return null;
  }
  if (record.kind !== "codex_quota_snapshot") {
    diagnostics.irrelevantRecords += 1;
    return null;
  }
  if (record.schemaVersion !== COLLECTOR_RECORD_VERSION) {
    diagnostics.unsupportedSchemaRecords += 1;
    return null;
  }
  if (!exactKeys(record, RECORD_KEYS) || record.provider !== "openai_codex"
      || record.providerSurface !== "account_shared_unallocated"
      || record.controlledState !== "unknown"
      || !SHA256_PATTERN.test(record.eventKey ?? "")
      || !Number.isSafeInteger(record.stalenessMs) || record.stalenessMs < 0
      || !validateOfficialFields(record)) {
    diagnostics.malformedRecordShapes += 1;
    return null;
  }
  if (!SOURCES.has(record.source)) {
    diagnostics.unsupportedSourceRecords += 1;
    return null;
  }
  const observedAt = canonicalIso(record.observedAt);
  const receivedAt = canonicalIso(record.receivedAt);
  if (!observedAt || !receivedAt
      || Date.parse(receivedAt) < Date.parse(observedAt)
      || Date.parse(receivedAt) - Date.parse(observedAt) !== record.stalenessMs) {
    diagnostics.malformedRecordShapes += 1;
    return null;
  }
  const windows = validateWindows(record.windows);
  if (!windows) {
    diagnostics.malformedWindows += 1;
    return null;
  }
  const account = validateAccountScope(record.accountScope);
  if (!account || windows.some((window) => account.planType !== null && account.planType !== window.planType)) {
    diagnostics.malformedAccountScopes += 1;
    return null;
  }
  const observedMs = Date.parse(observedAt);
  if (observedMs < bounds.startMs || observedMs > bounds.endMs) {
    diagnostics.outOfBoundsRecords += 1;
    return null;
  }
  return { observedAt, receivedAt, windows, account };
}

function displayPrecision(value) {
  const text = String(value);
  return text.includes(".") ? Math.min(6, text.split(".")[1].length) : 0;
}

function occurrenceIdentityMaterial(record, normalized, window, lineOrdinal, windowOrdinal) {
  const material = JSON.stringify({
    identityVersion: "codex-collector-safe-occurrence-v0.1",
    provider: "openai_codex",
    source: record.source,
    observedTime: normalized.observedAt,
    receivedTime: normalized.receivedAt,
    lineOrdinal,
    windowOrdinal,
    planType: window.planType,
    limitId: window.limitId,
    slot: window.slot,
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMins,
    resetsAt: window.resetsAt,
  });
  return createHash("sha256")
    .update("app-usagemonitor/codex-collector-safe-occurrence/v0.1\0")
    .update(material)
    .digest("hex");
}

function candidateFromWindow(record, normalized, window, lineOrdinal, windowOrdinal) {
  return {
    candidateVersion: CODEX_COLLECTOR_CANDIDATE_VERSION,
    kind: "quota_snapshot_candidate",
    provider: "openai_codex",
    observedTime: normalized.observedAt,
    receivedTime: normalized.receivedAt,
    source: record.source,
    planType: window.planType,
    limitId: window.limitId,
    slot: window.slot,
    usedPercent: window.usedPercent,
    displayPrecision: displayPrecision(window.usedPercent),
    windowDurationMinutes: window.windowDurationMins,
    resetsAt: isoFromUnixSeconds(window.resetsAt),
    sharedPoolSurface: "account_shared_unallocated",
    accountScopeSubject: normalized.account.subject,
    sessionScopeId: null,
    observationIdentityMaterial: occurrenceIdentityMaterial(record, normalized, window, lineOrdinal, windowOrdinal),
  };
}

/**
 * Read one bounded candidate batch. Raw collector objects never cross this
 * interface. A cursor may stop inside a multi-window source line; resuming
 * revalidates that line and continues at its exact next window.
 */
async function scanCodexCollectorExportSource(plan, {
  cursor = null,
  maximumCandidateRecords = 1_000,
  resourceGuard = createExportResourceGuard(),
  highWaterMark = 256 * 1024,
  verifyWholePrefix = true,
} = {}) {
  validatePlan(plan);
  if (!Number.isSafeInteger(maximumCandidateRecords) || maximumCandidateRecords < 1) {
    throw new TypeError("maximumCandidateRecords must be a positive safe integer");
  }
  if (typeof verifyWholePrefix !== "boolean") {
    throw new TypeError("verifyWholePrefix must be boolean");
  }
  const next = validateCursor(plan, cursor);
  const bounds = {
    startMs: Date.parse(plan.startAt),
    endMs: Date.parse(plan.endAt),
  };
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  resourceGuard.observeSourcePlan(1, plan.prefixBytes);
  const diagnostics = freshDiagnostics();
  const candidates = [];
  const { handle } = await openSafeSource(plan.path, plan);
  try {
    // Workspace callers checkpoint a descriptor-bound cursor atomically. They can
    // avoid re-counting every prior line per bounded batch, while the default
    // standalone scanner retains its independent cursor proof and whole-prefix
    // verification on every call.
    await verifyOpenedPrefixBoundary(plan, handle);
    await verifyCursorBoundary(handle, next, resourceGuard, {
      verifyLineOrdinal: verifyWholePrefix,
    });
    if (next.nextByte < plan.prefixBytes) {
      for await (const entry of readBoundedUtf8LineEntries(handle, {
        maximumLineBytes: resourceGuard.limits.maximumLineBytes,
        highWaterMark,
        resourceGuard,
        // An oversized object or array could hide a quota kind behind arbitrary
        // whitespace or key ordering. Fail closed for all structured JSON;
        // only oversized non-JSON text is proven irrelevant enough to skip.
        oversizedIrrelevantNeedles: ["{", "["],
        maximumTotalBytes: plan.prefixBytes,
        startByte: next.nextByte,
        startLineOrdinal: next.nextLineOrdinal,
      })) {
        diagnostics.linesSeen += 1;
        if (entry.line === null) {
          diagnostics.oversizedIrrelevantLines += 1;
          next.nextByte = entry.endByteExclusive;
          next.nextLineOrdinal = entry.lineOrdinal + 1;
          next.nextWindowOrdinal = 0;
          continue;
        }
        if (entry.line.trim().length === 0) {
          diagnostics.emptyLines += 1;
          next.nextByte = entry.endByteExclusive;
          next.nextLineOrdinal = entry.lineOrdinal + 1;
          next.nextWindowOrdinal = 0;
          continue;
        }
        let record;
        try {
          record = JSON.parse(entry.line);
        } catch {
          diagnostics.malformedJsonLines += 1;
          next.nextByte = entry.endByteExclusive;
          next.nextLineOrdinal = entry.lineOrdinal + 1;
          next.nextWindowOrdinal = 0;
          continue;
        }
        const normalized = classifyRecord(record, bounds, diagnostics);
        if (!normalized) {
          next.nextByte = entry.endByteExclusive;
          next.nextLineOrdinal = entry.lineOrdinal + 1;
          next.nextWindowOrdinal = 0;
          continue;
        }
        if (next.nextWindowOrdinal >= normalized.windows.length) fail("cursor_invalid");
        for (let windowOrdinal = next.nextWindowOrdinal; windowOrdinal < normalized.windows.length; windowOrdinal += 1) {
          const candidate = candidateFromWindow(record, normalized, normalized.windows[windowOrdinal], entry.lineOrdinal, windowOrdinal);
          resourceGuard.observeOutputRecord(bufferByteLength(JSON.stringify(candidate), "utf8"));
          candidates.push(candidate);
          diagnostics.candidatesEmitted += 1;
          if (candidates.length >= maximumCandidateRecords) {
            if (windowOrdinal + 1 < normalized.windows.length) {
              next.nextByte = entry.startByte;
              next.nextLineOrdinal = entry.lineOrdinal;
              next.nextWindowOrdinal = windowOrdinal + 1;
            } else {
              next.nextByte = entry.endByteExclusive;
              next.nextLineOrdinal = entry.lineOrdinal + 1;
              next.nextWindowOrdinal = 0;
            }
            break;
          }
        }
        if (candidates.length >= maximumCandidateRecords) break;
        next.nextByte = entry.endByteExclusive;
        next.nextLineOrdinal = entry.lineOrdinal + 1;
        next.nextWindowOrdinal = 0;
      }
    }
    if (verifyWholePrefix) {
      await verifyOpenedPrefix(plan, handle, resourceGuard);
    } else {
      // Cheap per-batch defenses still reject truncation, replacement,
      // symlinks, hardlinks, permission changes, and a changed prefix boundary.
      // The workspace performs the expensive content proof once before the
      // terminal checkpoint is committed.
      await verifyOpenedPrefixBoundary(plan, handle);
      await verifyBoundPath(plan);
    }
  } finally {
    await handle.close();
  }
  return {
    candidates,
    cursor: next,
    complete: next.nextByte === plan.prefixBytes && next.nextWindowOrdinal === 0,
    diagnostics,
  };
}

return Object.freeze({
  CODEX_COLLECTOR_CANDIDATE_VERSION,
  CODEX_COLLECTOR_SOURCE_CURSOR_VERSION,
  CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
  CodexCollectorExportSourceError,
  createCodexCollectorExportCursor,
  createCodexCollectorExportSourcePlan,
  scanCodexCollectorExportSource,
  verifyCodexCollectorExportSourcePlan,
});
}
