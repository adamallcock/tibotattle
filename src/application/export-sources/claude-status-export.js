import {
  ExportResourceLimitError,
} from "../../export/index.js";

export function createClaudeStatusExportContext(configuration) {
const {
  allocUnsafe,
  bufferByteLength,
  bufferFrom,
  bufferIsBuffer,
  createHash,
  createHmac,
  createExportResourceGuard,
  currentUid,
  DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES,
  DEFAULT_CLAUDE_STATUS_MAX_RECORDS,
  fsConstants: constants,
  inspectClaudeStatusLedgerDirectoriesForExport,
  joinPath: join,
  lstat,
  MAX_CLAUDE_STATUS_RECORD_BYTES,
  open,
  openDirectory: opendir,
  platform,
  revalidateClaudeStatusLedgerDirectoriesForExport,
  validateClaudeStatusSnapshot,
} = configuration;

const CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION = "claude-status-ledger-export-source-plan-v0.1";
const CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION = "claude-status-ledger-export-cursor-v0.1";
const CLAUDE_STATUS_LEDGER_OCCURRENCE_VERSION = "claude-ledger-occurrence-v0.1";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const RECORD_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f-]{27}\.json$/u;
const PENDING_NAME = /^\.pending-[0-9a-f-]{36}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_KEY_PATTERN = /^claude-ledger-source:v1:[A-Za-z0-9_-]{43}$/u;
const OCCURRENCE_PATTERN = /^claude-ledger-occurrence:v1:[A-Za-z0-9_-]{43}$/u;
const SAFE_CODES = new Set([
  "state_unavailable",
  "state_unsafe",
  "ledger_entry",
  "ledger_bound",
  "record_invalid",
  "record_changed",
  "directory_changed",
  "plan_invalid",
  "cursor_invalid",
  "secret_invalid",
  "failpoint_invalid",
  "injected_failure",
]);
const PLAN_KEYS = Object.freeze([
  "schemaVersion", "startAt", "endAt", "stateDirectory", "rootIdentity",
  "recordsDirectoryIdentity", "records", "recordCount", "totalBytes",
  "inventorySha256", "sourceKey",
]);
const IDENTITY_KEYS = Object.freeze(["device", "inode", "birthtimeMs"]);
const RECORD_KEYS = Object.freeze(["name", "device", "inode", "birthtimeMs", "size", "sha256"]);
const CURSOR_KEYS = Object.freeze(["schemaVersion", "sourceKey", "nextRecordIndex"]);

class ClaudeStatusLedgerExportSourceError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown Claude ledger export-source failure code");
    super(`Claude status ledger export source failed (${code})`);
    this.name = "ClaudeStatusLedgerExportSourceError";
    this.code = `claude_status_ledger_export_${code}`;
  }
}

function fail(code) {
  throw new ClaudeStatusLedgerExportSourceError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === "string")
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? canonical : null;
}

function normalizeBounds(startAt, endAt) {
  if (typeof startAt !== "string" || typeof endAt !== "string") fail("plan_invalid");
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) fail("plan_invalid");
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  if (!start || !end || Date.parse(end) < Date.parse(start)) fail("plan_invalid");
  return { startAt: start, endAt: end, startMs: Date.parse(start), endMs: Date.parse(end) };
}

function normalizeSecret(secret) {
  if (!bufferIsBuffer(secret) && !(secret instanceof Uint8Array)) fail("secret_invalid");
  const normalized = bufferFrom(secret);
  if (normalized.byteLength !== 32) fail("secret_invalid");
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmacIdentifier(secret, prefix, domain, material) {
  const digest = createHmac("sha256", secret)
    .update(`app-usagemonitor/${domain}\0`, "utf8")
    .update(stableJson(material), "utf8")
    .digest("base64url");
  return `${prefix}:v1:${digest}`;
}

function safeIdentity(stats) {
  return {
    device: stats.dev,
    inode: stats.ino,
    birthtimeMs: Math.trunc(stats.birthtimeMs),
  };
}

function identityMatches(stats, expected) {
  return stats.dev === expected.device
    && stats.ino === expected.inode
    && Math.trunc(stats.birthtimeMs) === expected.birthtimeMs;
}

function sameStatsIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && Math.trunc(left.birthtimeMs) === Math.trunc(right.birthtimeMs);
}

function sameMutationMetadata(left, right) {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSafeRecordStats(stats, expected = null) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("record_changed");
  if (stats.nlink !== 1) fail("record_changed");
  if (currentUid() !== null && stats.uid !== currentUid()) fail("record_changed");
  if (platform !== "win32" && (stats.mode & 0o777) !== 0o600) fail("record_changed");
  if (!Number.isSafeInteger(stats.size) || stats.size < 2 || stats.size > MAX_CLAUDE_STATUS_RECORD_BYTES) {
    fail("record_invalid");
  }
  if (expected && (!identityMatches(stats, expected) || stats.size !== expected.size)) fail("record_changed");
}

function assertSafePendingStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) fail("ledger_entry");
  if (currentUid() !== null && stats.uid !== currentUid()) fail("ledger_entry");
  if (platform !== "win32" && (stats.mode & 0o777) !== 0o600) fail("ledger_entry");
}

async function safeFailpoint(failpoint, point, detail) {
  if (typeof failpoint !== "function") fail("failpoint_invalid");
  try {
    await failpoint(point, detail);
  } catch {
    fail("injected_failure");
  }
}

async function safeLstat(path, missingCode = "record_changed") {
  try {
    return await lstat(path);
  } catch {
    fail(missingCode);
  }
}

async function verifiedBoundary(stateDirectory, expected = null) {
  let boundary;
  try {
    boundary = expected
      ? await revalidateClaudeStatusLedgerDirectoriesForExport(expected)
      : await inspectClaudeStatusLedgerDirectoriesForExport(stateDirectory);
  } catch {
    fail(expected ? "directory_changed" : "state_unsafe");
  }
  return boundary;
}

function parseCanonicalRecordBytes(bytes) {
  if (bytes[bytes.length - 1] !== 0x0a || bytes.indexOf(0x0a) !== bytes.length - 1) fail("record_invalid");
  let parsed;
  try {
    parsed = JSON.parse(bytes.subarray(0, bytes.length - 1).toString("utf8"));
  } catch {
    fail("record_invalid");
  }
  let snapshot;
  try {
    snapshot = validateClaudeStatusSnapshot(parsed);
  } catch {
    fail("record_invalid");
  }
  const canonical = bufferFrom(`${JSON.stringify(snapshot)}\n`, "utf8");
  if (!canonical.equals(bytes)) fail("record_invalid");
  return snapshot;
}

function recordNameMatchesSnapshot(name, snapshot) {
  const prefix = `${snapshot.capturedAt.replaceAll("-", "").replaceAll(":", "").replace(".", "")}-`;
  return name.startsWith(prefix);
}

async function readCanonicalRecord(boundary, record, {
  failpoint,
  recordIndex,
  resourceGuard,
} = {}) {
  await verifiedBoundary(boundary.root, boundary);
  await safeFailpoint(failpoint, "before_record_open", { recordIndex });
  const path = join(boundary.recordsDirectory, record.name);
  const before = await safeLstat(path);
  assertSafeRecordStats(before, record);
  let handle;
  let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    assertSafeRecordStats(opened, record);
    if (!sameStatsIdentity(opened, before)) fail("record_changed");
    bytes = allocUnsafe(record.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      resourceGuard.checkRuntime();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== record.size) fail("record_changed");
    bytes = bytes.subarray(0, offset);
    await safeFailpoint(failpoint, "after_record_read", { recordIndex });
    const afterRead = await handle.stat();
    assertSafeRecordStats(afterRead, record);
    if (!sameStatsIdentity(afterRead, opened) || !sameMutationMetadata(afterRead, opened)) fail("record_changed");
    const verification = allocUnsafe(record.size);
    let verificationOffset = 0;
    while (verificationOffset < verification.length) {
      resourceGuard.checkRuntime();
      const { bytesRead } = await handle.read(
        verification,
        verificationOffset,
        verification.length - verificationOffset,
        verificationOffset,
      );
      if (bytesRead === 0) break;
      verificationOffset += bytesRead;
    }
    if (verificationOffset !== record.size || sha256(verification) !== record.sha256) fail("record_changed");
  } catch (error) {
    if (error instanceof ClaudeStatusLedgerExportSourceError || error instanceof ExportResourceLimitError) throw error;
    fail("record_changed");
  } finally {
    await handle?.close().catch(() => {});
  }
  const afterPath = await safeLstat(path);
  assertSafeRecordStats(afterPath, record);
  if (!sameMutationMetadata(afterPath, before)) fail("record_changed");
  await verifiedBoundary(boundary.root, boundary);
  if (sha256(bytes) !== record.sha256) fail("record_changed");
  const snapshot = parseCanonicalRecordBytes(bytes);
  if (!recordNameMatchesSnapshot(record.name, snapshot)) fail("record_invalid");
  return snapshot;
}

function inventoryMaterial(plan) {
  return {
    schemaVersion: CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION,
    startAt: plan.startAt,
    endAt: plan.endAt,
    rootIdentity: plan.rootIdentity,
    recordsDirectoryIdentity: plan.recordsDirectoryIdentity,
    records: plan.records,
    recordCount: plan.recordCount,
    totalBytes: plan.totalBytes,
  };
}

function inventoryDigest(plan) {
  return sha256(bufferFrom(stableJson(inventoryMaterial(plan)), "utf8"));
}

function sourceKey(secret, plan) {
  return hmacIdentifier(secret, "claude-ledger-source", "claude-ledger-source/v1", {
    stateDirectory: plan.stateDirectory,
    inventorySha256: plan.inventorySha256,
  });
}

function validateIdentity(value) {
  return exactKeys(value, IDENTITY_KEYS)
    && IDENTITY_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validatePlan(plan, secret) {
  if (!exactKeys(plan, PLAN_KEYS)
      || plan.schemaVersion !== CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION
      || !canonicalIso(plan.startAt) || !canonicalIso(plan.endAt)
      || Date.parse(plan.endAt) < Date.parse(plan.startAt)
      || typeof plan.stateDirectory !== "string" || plan.stateDirectory.length < 1 || plan.stateDirectory.length > 4096
      || !validateIdentity(plan.rootIdentity) || !validateIdentity(plan.recordsDirectoryIdentity)
      || !Array.isArray(plan.records)
      || !Number.isSafeInteger(plan.recordCount) || plan.recordCount < 0 || plan.recordCount !== plan.records.length
      || !Number.isSafeInteger(plan.totalBytes) || plan.totalBytes < 0
      || !SHA256_PATTERN.test(plan.inventorySha256 ?? "")
      || !SOURCE_KEY_PATTERN.test(plan.sourceKey ?? "")) fail("plan_invalid");
  let totalBytes = 0;
  let priorName = null;
  for (const record of plan.records) {
    if (!exactKeys(record, RECORD_KEYS)
        || !RECORD_NAME.test(record.name ?? "")
        || !Number.isSafeInteger(record.device) || record.device < 0
        || !Number.isSafeInteger(record.inode) || record.inode < 0
        || !Number.isSafeInteger(record.birthtimeMs) || record.birthtimeMs < 0
        || !Number.isSafeInteger(record.size) || record.size < 2 || record.size > MAX_CLAUDE_STATUS_RECORD_BYTES
        || !SHA256_PATTERN.test(record.sha256 ?? "")
        || (priorName !== null && record.name.localeCompare(priorName) <= 0)) fail("plan_invalid");
    priorName = record.name;
    totalBytes += record.size;
    if (!Number.isSafeInteger(totalBytes)) fail("plan_invalid");
  }
  if (totalBytes !== plan.totalBytes || inventoryDigest(plan) !== plan.inventorySha256
      || sourceKey(secret, plan) !== plan.sourceKey) fail("plan_invalid");
  return plan;
}

function normalizePlanBounds(maximumRecords, maximumLedgerBytes) {
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1
      || maximumRecords > DEFAULT_CLAUDE_STATUS_MAX_RECORDS
      || !Number.isSafeInteger(maximumLedgerBytes) || maximumLedgerBytes < MAX_CLAUDE_STATUS_RECORD_BYTES
      || maximumLedgerBytes > DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES) fail("ledger_bound");
}

function freezePlan(plan) {
  Object.freeze(plan.rootIdentity);
  Object.freeze(plan.recordsDirectoryIdentity);
  for (const record of plan.records) Object.freeze(record);
  Object.freeze(plan.records);
  return Object.freeze(plan);
}

async function listNames(recordsDirectory, resourceGuard) {
  const names = [];
  try {
    const directory = await opendir(recordsDirectory);
    for await (const entry of directory) {
      resourceGuard.observeDirectoryEntry();
      names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof ExportResourceLimitError) throw error;
    fail("state_unavailable");
  }
  return names.sort();
}

async function verifySelectedRecords(plan, secret, {
  resourceGuard,
  failpoint,
  observeSourcePlan = true,
} = {}) {
  validatePlan(plan, secret);
  resourceGuard.assertCoveredInterval(Date.parse(plan.startAt), Date.parse(plan.endAt));
  if (observeSourcePlan) resourceGuard.observeSourcePlan(plan.recordCount, plan.totalBytes);
  const boundary = await verifiedBoundary(plan.stateDirectory, {
    root: plan.stateDirectory,
    recordsDirectory: join(plan.stateDirectory, "records"),
    rootIdentity: plan.rootIdentity,
    recordsIdentity: plan.recordsDirectoryIdentity,
  });
  for (let index = 0; index < plan.records.length; index += 1) {
    await readCanonicalRecord(boundary, plan.records[index], { failpoint, recordIndex: index, resourceGuard });
  }
  await safeFailpoint(failpoint, "before_final_directory_verify", { recordCount: plan.recordCount });
  await verifiedBoundary(plan.stateDirectory, boundary);
  return boundary;
}

async function createClaudeStatusLedgerExportSourcePlan({
  stateDirectory,
  startAt,
  endAt,
  secret,
  maximumRecords = DEFAULT_CLAUDE_STATUS_MAX_RECORDS,
  maximumLedgerBytes = DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES,
  resourceGuard = createExportResourceGuard(),
  failpoint = async () => {},
} = {}) {
  const normalizedSecret = normalizeSecret(secret);
  const bounds = normalizeBounds(startAt, endAt);
  normalizePlanBounds(maximumRecords, maximumLedgerBytes);
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  const boundary = await verifiedBoundary(stateDirectory);
  const names = await listNames(boundary.recordsDirectory, resourceGuard);
  const records = [];
  let selectedBytes = 0;
  let completeRecordCount = 0;
  let completeLedgerBytes = 0;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const path = join(boundary.recordsDirectory, name);
    if (PENDING_NAME.test(name)) {
      const pending = await safeLstat(path, "ledger_entry");
      assertSafePendingStats(pending);
      continue;
    }
    if (!RECORD_NAME.test(name)) fail("ledger_entry");
    const stats = await safeLstat(path);
    assertSafeRecordStats(stats);
    completeRecordCount += 1;
    completeLedgerBytes += stats.size;
    if (completeRecordCount > maximumRecords || completeLedgerBytes > maximumLedgerBytes) fail("ledger_bound");
    const record = { name, ...safeIdentity(stats), size: stats.size, sha256: "0".repeat(64) };
    const bytesHashRecord = { ...record };
    let handle;
    let bytes;
    let opened;
    await verifiedBoundary(boundary.root, boundary);
    await safeFailpoint(failpoint, "before_inventory_record_open", { recordIndex: index });
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      opened = await handle.stat();
      assertSafeRecordStats(opened, record);
      if (!sameStatsIdentity(opened, stats)) fail("record_changed");
      bytes = allocUnsafe(record.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        resourceGuard.checkRuntime();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== record.size) fail("record_changed");
      bytes = bytes.subarray(0, offset);
      const after = await handle.stat();
      assertSafeRecordStats(after, record);
      if (!sameStatsIdentity(after, opened) || !sameMutationMetadata(after, opened)) fail("record_changed");
    } catch (error) {
      if (error instanceof ClaudeStatusLedgerExportSourceError || error instanceof ExportResourceLimitError) throw error;
      fail("record_changed");
    } finally {
      await handle?.close().catch(() => {});
    }
    const afterPath = await safeLstat(path);
    assertSafeRecordStats(afterPath, record);
    if (!sameMutationMetadata(afterPath, stats)) fail("record_changed");
    await verifiedBoundary(boundary.root, boundary);
    bytesHashRecord.sha256 = sha256(bytes);
    const snapshot = parseCanonicalRecordBytes(bytes);
    if (!recordNameMatchesSnapshot(name, snapshot)) fail("record_invalid");
    if (Date.parse(snapshot.capturedAt) >= bounds.startMs && Date.parse(snapshot.capturedAt) <= bounds.endMs) {
      records.push(bytesHashRecord);
      if (records.length > resourceGuard.limits.maximumSourceFiles) {
        throw new ExportResourceLimitError("source_files");
      }
      selectedBytes += bytesHashRecord.size;
      if (selectedBytes > resourceGuard.limits.maximumSourceBytes) {
        throw new ExportResourceLimitError("source_bytes");
      }
    }
  }
  const totalBytes = selectedBytes;
  const plan = {
    schemaVersion: CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION,
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    stateDirectory: boundary.root,
    rootIdentity: boundary.rootIdentity,
    recordsDirectoryIdentity: boundary.recordsIdentity,
    records,
    recordCount: records.length,
    totalBytes,
    inventorySha256: "0".repeat(64),
    sourceKey: `claude-ledger-source:v1:${"A".repeat(43)}`,
  };
  plan.inventorySha256 = inventoryDigest(plan);
  plan.sourceKey = sourceKey(normalizedSecret, plan);
  resourceGuard.observeSourcePlan(plan.recordCount, plan.totalBytes);
  await verifySelectedRecords(plan, normalizedSecret, { resourceGuard, failpoint, observeSourcePlan: false });
  return freezePlan(plan);
}

async function verifyClaudeStatusLedgerExportSourcePlan(plan, {
  secret,
  resourceGuard = createExportResourceGuard(),
  failpoint = async () => {},
} = {}) {
  const normalizedSecret = normalizeSecret(secret);
  await verifySelectedRecords(plan, normalizedSecret, { resourceGuard, failpoint });
  return {
    schemaVersion: CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION,
    sourceKey: plan.sourceKey,
    sourceFiles: plan.recordCount,
    sourceBytes: plan.totalBytes,
  };
}

function createClaudeStatusLedgerExportCursor(plan, { secret } = {}) {
  validatePlan(plan, normalizeSecret(secret));
  return {
    schemaVersion: CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION,
    sourceKey: plan.sourceKey,
    nextRecordIndex: 0,
  };
}

function validateCursor(plan, cursor) {
  const value = cursor;
  if (!exactKeys(value, CURSOR_KEYS)
      || value.schemaVersion !== CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION
      || value.sourceKey !== plan.sourceKey
      || !Number.isSafeInteger(value.nextRecordIndex) || value.nextRecordIndex < 0
      || value.nextRecordIndex > plan.recordCount) fail("cursor_invalid");
  return { ...value };
}

function occurrenceIdentity(secret, plan, record, recordIndex) {
  const value = hmacIdentifier(secret, "claude-ledger-occurrence", "claude-ledger-occurrence/v1", {
    sourceKey: plan.sourceKey,
    recordIndex,
    name: record.name,
    device: record.device,
    inode: record.inode,
    birthtimeMs: record.birthtimeMs,
    size: record.size,
    sha256: record.sha256,
  });
  if (!OCCURRENCE_PATTERN.test(value)) fail("record_invalid");
  return value;
}

async function scanClaudeStatusLedgerExportSource(plan, {
  secret,
  cursor = null,
  maximumRecords = 1_000,
  resourceGuard = createExportResourceGuard(),
  failpoint = async () => {},
} = {}) {
  const normalizedSecret = normalizeSecret(secret);
  validatePlan(plan, normalizedSecret);
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 100_000) {
    fail("ledger_bound");
  }
  const next = cursor === null
    ? createClaudeStatusLedgerExportCursor(plan, { secret: normalizedSecret })
    : validateCursor(plan, cursor);
  resourceGuard.assertCoveredInterval(Date.parse(plan.startAt), Date.parse(plan.endAt));
  resourceGuard.observeSourcePlan(plan.recordCount, plan.totalBytes);
  const boundary = await verifiedBoundary(plan.stateDirectory, {
    root: plan.stateDirectory,
    recordsDirectory: join(plan.stateDirectory, "records"),
    rootIdentity: plan.rootIdentity,
    recordsIdentity: plan.recordsDirectoryIdentity,
  });
  const records = [];
  while (next.nextRecordIndex < plan.recordCount && records.length < maximumRecords) {
    const recordIndex = next.nextRecordIndex;
    const frozen = plan.records[recordIndex];
    const snapshot = await readCanonicalRecord(boundary, frozen, { failpoint, recordIndex, resourceGuard });
    const physicalOccurrenceMaterial = occurrenceIdentity(normalizedSecret, plan, frozen, recordIndex);
    const safeRecord = { snapshot, physicalOccurrenceMaterial };
    resourceGuard.observeLine(frozen.size);
    resourceGuard.observeOutputRecord(bufferByteLength(JSON.stringify(safeRecord), "utf8"));
    records.push(safeRecord);
    next.nextRecordIndex += 1;
  }
  await safeFailpoint(failpoint, "before_final_directory_verify", { recordCount: records.length });
  await verifiedBoundary(plan.stateDirectory, boundary);
  return {
    sourceKey: plan.sourceKey,
    records,
    cursor: next,
    complete: next.nextRecordIndex === plan.recordCount,
  };
}

return Object.freeze({
  CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION,
  CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION,
  CLAUDE_STATUS_LEDGER_OCCURRENCE_VERSION,
  ClaudeStatusLedgerExportSourceError,
  createClaudeStatusLedgerExportCursor,
  createClaudeStatusLedgerExportSourcePlan,
  scanClaudeStatusLedgerExportSource,
  verifyClaudeStatusLedgerExportSourcePlan,
});
}
