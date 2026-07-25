import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { assertValidExportRecord } from "./export-schema.js";
import { EXPORT_DIAGNOSTIC_CODES } from "./export-registries.js";
import {
  EXPORT_CHECKPOINT_PARSER_VERSION,
  createEmptyCodexCheckpointState,
  normalizeCodexCheckpointState,
  serializeCodexCheckpointState,
} from "./export-checkpoint-state.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
  normalizeExportResourceLimits,
} from "./export-resource-policy.js";
import { EXPORT_SOURCE_PLAN_VERSION, summarizeExportSourcePlan } from "./export-source-plan.js";
import { stableJson } from "./storage.js";

export const EXPORT_WORKSPACE_VERSION = "usage-export-workspace-v0.2";
export const DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes;
export const DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumSqliteBatchRecords;

const DATABASE_NAME = "workspace.sqlite3";
const EXPORT_WORKSPACE_APPLICATION_ID = 0x55534d32;
const EXPORT_WORKSPACE_USER_VERSION = 2;
const EXPORT_WORKSPACE_SCHEMA_SHA256 = "f66ba77a18c92a76f7ad0e09b57c7efe9bf941026b10905aebdfd353b93fa5c2";
const DEFAULT_CRASH_RECOVERY_RESERVATION_MS = 5_000;
const CHECKPOINT_PHASES = new Set(["tier_scan", "record_scan", "complete"]);
const OCCURRENCE_KINDS = new Set(["usage_event", "tool_call"]);
const SNAPSHOT_KINDS = new Set(["cumulative_usage", "tool_call"]);
const REVIEWED_DIAGNOSTIC_CODES = new Set(EXPORT_DIAGNOSTIC_CODES);
const MAX_CHECKPOINT_INDEX_OPERATIONS = 50_000;
const MAX_CHECKPOINT_OPEN_TASKS = 100_000;
const WORKSPACE_TABLES = Object.freeze([
  "chunks", "diagnostics", "resource_invocations", "resource_usage", "safe_records", "seen_occurrences",
  "source_checkpoints", "source_diagnostics", "source_open_tasks", "source_plan",
  "source_snapshots", "source_tier_events", "workspace_meta",
]);
const WORKSPACE_INDEXES = Object.freeze([
  "safe_records_total_order", "source_plan_pending_order", "source_snapshots_lookup", "source_tier_lookup",
]);
const WORKSPACE_COLUMNS = Object.freeze({
  chunks: ["chunk_index", "status", "metadata_json"],
  diagnostics: ["code", "count"],
  resource_invocations: ["singleton", "started_at_ms"],
  resource_usage: [
    "singleton", "policy_version", "source_files", "source_bytes", "directory_entries", "lines",
    "oversized_irrelevant_lines", "output_records", "expanded_record_bytes", "cumulative_elapsed_ms",
    "peak_rss_bytes", "workspace_high_water_bytes", "recovery_reservations",
  ],
  safe_records: [
    "family", "family_order", "record_id", "record_time", "record_json", "record_bytes",
    "embedded_record_bytes",
  ],
  seen_occurrences: ["kind", "occurrence_key", "source_key", "line_ordinal"],
  source_checkpoints: [
    "source_key", "phase", "byte_offset", "line_ordinal", "checkpoint_seq", "parser_version",
    "state_json", "last_batch_sha256",
  ],
  source_diagnostics: ["source_key", "code", "count"],
  source_open_tasks: ["source_key", "task_key"],
  source_plan: [
    "ordinal", "source_key", "source_path", "parent_source_key", "is_fork", "parent_missing",
    "device", "inode", "birthtime_ms", "prefix_bytes", "prefix_sha256", "scan_status",
  ],
  source_snapshots: ["source_key", "kind", "snapshot_key"],
  source_tier_events: ["source_key", "tier_index", "event_time_ms", "line_ordinal", "tier_state_json"],
  workspace_meta: ["key", "value_json"],
});
const RECORD_TYPE = Object.freeze({
  usageEvent: { family: "usageEvents", familyOrder: 0, idField: "eventId", timeField: "eventTime" },
  quotaSnapshot: { family: "quotaSnapshots", familyOrder: 1, idField: "snapshotId", timeField: "observedTime" },
  activityMarker: { family: "activityMarkers", familyOrder: 2, idField: "markerId", timeField: "observedTime" },
});

const SAFE_WORKSPACE_CODES = new Set([
  "exists",
  "missing",
  "directory",
  "database_type",
  "database_owner",
  "database_permissions",
  "database_links",
  "database_changed",
  "sqlite_unavailable",
  "schema",
  "checkpoint_mismatch",
  "record_conflict",
  "transaction",
  "disk",
]);

export class ExportWorkspaceError extends Error {
  constructor(code) {
    if (!SAFE_WORKSPACE_CODES.has(code)) throw new TypeError("Unknown export-workspace failure code");
    super(`Local export workspace failed (${code})`);
    this.name = "ExportWorkspaceError";
    this.code = `export_workspace_${code}`;
  }
}

function fail(code) {
  throw new ExportWorkspaceError(code);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validDescriptorResourceLimits(value) {
  try {
    return stableJson(value) === stableJson(normalizeExportResourceLimits(value));
  } catch {
    return false;
  }
}

function assertDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
      || descriptor.workspaceVersion !== EXPORT_WORKSPACE_VERSION
      || descriptor.resourcePolicyVersion !== EXPORT_RESOURCE_POLICY_VERSION
      || !validDescriptorResourceLimits(descriptor.resourceLimits)
      || typeof descriptor.participantId !== "string"
      || !/^participant:v1:[A-Za-z0-9_-]{43}$/.test(descriptor.participantId)
      || typeof descriptor.createdAt !== "string" || !Number.isFinite(Date.parse(descriptor.createdAt))
      || !descriptor.coveredAt || !Number.isFinite(Date.parse(descriptor.coveredAt.startAt))
      || !Number.isFinite(Date.parse(descriptor.coveredAt.endAt))
      || Date.parse(descriptor.coveredAt.endAt) < Date.parse(descriptor.coveredAt.startAt)
      || descriptor.sourcePlan?.schemaVersion !== EXPORT_SOURCE_PLAN_VERSION
      || !validSha256(descriptor.sourcePlan?.sourcePlanSha256)
      || !Number.isSafeInteger(descriptor.sourcePlan?.sourceFiles) || descriptor.sourcePlan.sourceFiles < 0
      || !Number.isSafeInteger(descriptor.sourcePlan?.sourceBytes) || descriptor.sourcePlan.sourceBytes < 0
      || !Number.isSafeInteger(descriptor.activityPlan?.recordCount) || descriptor.activityPlan.recordCount < 0
      || !validSha256(descriptor.activityPlan?.recordsSha256)
      || !descriptor.compatibility || typeof descriptor.compatibility !== "object"
      || !Array.isArray(descriptor.sourceProviders) || descriptor.sourceProviders.length < 1
      || descriptor.sourceProviders.some((provider) => provider !== "openai_codex" && provider !== "anthropic_claude_code")
      || !["macos", "linux", "windows", "other", "unknown"].includes(descriptor.clientPlatform)) {
    fail("schema");
  }
}

function descriptorWorkspaceCeiling(descriptor, requested) {
  const persisted = descriptor.resourceLimits.maximumWorkspaceBytes;
  if (requested === undefined) return persisted;
  if (!Number.isSafeInteger(requested) || requested < 1) fail("disk");
  return Math.min(requested, persisted);
}

function localPlatformName() {
  if (platform() === "darwin") return "macos";
  if (platform() === "linux") return "linux";
  if (platform() === "win32") return "windows";
  return "other";
}

function assertSourcePlanMatchesDescriptor(sourcePlan, descriptor) {
  const summary = summarizeExportSourcePlan(sourcePlan);
  if (stableJson(summary) !== stableJson(descriptor.sourcePlan)) fail("checkpoint_mismatch");
}

async function ensureOwnerDirectory(directory, { create = false } = {}) {
  const target = resolve(directory);
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") fail("missing");
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("directory");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("directory");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await chmod(target, 0o700);
    const corrected = await lstat(target);
    if ((corrected.mode & 0o077) !== 0) fail("directory");
  }
  const canonical = await realpath(target);
  return canonical;
}

function assertDatabaseStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("database_type");
  if (stats.nlink !== 1) fail("database_links");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("database_owner");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("database_permissions");
}

async function precreateDatabase(path) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") fail("exists");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectExistingDatabase(path) {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail("missing");
    throw error;
  }
  assertDatabaseStats(pathStats);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptorStats = await handle.stat();
    assertDatabaseStats(descriptorStats);
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) fail("database_changed");
    return { dev: descriptorStats.dev, ino: descriptorStats.ino };
  } finally {
    await handle.close();
  }
}

async function assertCompleteLineBoundary(path, byteOffset, prefixBytes) {
  if (!safeCount(byteOffset) || byteOffset > prefixBytes) fail("schema");
  if (byteOffset === 0) return;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const byte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(byte, 0, 1, byteOffset - 1);
    if (bytesRead !== 1 || byte[0] !== 0x0a) fail("checkpoint_mismatch");
  } catch (error) {
    if (error instanceof ExportWorkspaceError) throw error;
    fail("database_changed");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function loadSqlite() {
  try {
    const module = await import("node:sqlite");
    if (typeof module.DatabaseSync !== "function") fail("sqlite_unavailable");
    return module.DatabaseSync;
  } catch (error) {
    if (error instanceof ExportWorkspaceError) throw error;
    fail("sqlite_unavailable");
  }
}

function configureDatabase(database) {
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  database.exec("PRAGMA temp_store=FILE");
  database.enableDefensive?.(true);
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA application_id=${EXPORT_WORKSPACE_APPLICATION_ID};
    PRAGMA user_version=${EXPORT_WORKSPACE_USER_VERSION};
    CREATE TABLE workspace_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_plan (
      ordinal INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      parent_source_key TEXT REFERENCES source_plan(source_key),
      is_fork INTEGER NOT NULL DEFAULT 0 CHECK(is_fork IN (0, 1)),
      parent_missing INTEGER NOT NULL DEFAULT 0 CHECK(parent_missing IN (0, 1)),
      device INTEGER,
      inode INTEGER,
      birthtime_ms INTEGER,
      prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
      prefix_sha256 TEXT NOT NULL CHECK(length(prefix_sha256) = 64),
      scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending', 'complete'))
    ) STRICT;
    CREATE INDEX source_plan_pending_order ON source_plan(scan_status, ordinal);
    CREATE TABLE source_checkpoints (
      source_key TEXT PRIMARY KEY REFERENCES source_plan(source_key),
      phase TEXT NOT NULL CHECK(phase IN ('tier_scan', 'record_scan', 'complete')),
      byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 0),
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
      parser_version TEXT NOT NULL,
      state_json TEXT NOT NULL,
      last_batch_sha256 TEXT CHECK(last_batch_sha256 IS NULL OR length(last_batch_sha256) = 64)
    ) STRICT;
    CREATE TABLE source_tier_events (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      tier_index INTEGER NOT NULL CHECK(tier_index >= 0),
      event_time_ms INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 1),
      tier_state_json TEXT NOT NULL,
      PRIMARY KEY(source_key, tier_index)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_tier_lookup
      ON source_tier_events(source_key, event_time_ms DESC, line_ordinal DESC);
    CREATE TABLE seen_occurrences (
      kind TEXT NOT NULL CHECK(kind IN ('usage_event', 'tool_call')),
      occurrence_key TEXT NOT NULL CHECK(length(occurrence_key) = 64),
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 1),
      PRIMARY KEY(kind, occurrence_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE source_snapshots (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      kind TEXT NOT NULL CHECK(kind IN ('cumulative_usage', 'tool_call')),
      snapshot_key TEXT NOT NULL CHECK(length(snapshot_key) = 64),
      PRIMARY KEY(source_key, kind, snapshot_key)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_snapshots_lookup
      ON source_snapshots(kind, snapshot_key, source_key);
    CREATE TABLE source_open_tasks (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      task_key TEXT NOT NULL CHECK(length(task_key) = 64),
      PRIMARY KEY(source_key, task_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE source_diagnostics (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(source_key, code)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE resource_usage (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      policy_version TEXT NOT NULL,
      source_files INTEGER NOT NULL CHECK(source_files >= 0),
      source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
      directory_entries INTEGER NOT NULL CHECK(directory_entries >= 0),
      lines INTEGER NOT NULL CHECK(lines >= 0),
      oversized_irrelevant_lines INTEGER NOT NULL CHECK(oversized_irrelevant_lines >= 0),
      output_records INTEGER NOT NULL CHECK(output_records >= 0),
      expanded_record_bytes INTEGER NOT NULL CHECK(expanded_record_bytes >= 0),
      cumulative_elapsed_ms INTEGER NOT NULL CHECK(cumulative_elapsed_ms >= 0),
      peak_rss_bytes INTEGER NOT NULL CHECK(peak_rss_bytes >= 0),
      workspace_high_water_bytes INTEGER NOT NULL CHECK(workspace_high_water_bytes >= 0),
      recovery_reservations INTEGER NOT NULL CHECK(recovery_reservations >= 0)
    ) STRICT;
    CREATE TABLE resource_invocations (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0)
    ) STRICT;
    CREATE TABLE safe_records (
      family TEXT NOT NULL CHECK(family IN ('usageEvents', 'quotaSnapshots', 'activityMarkers')),
      family_order INTEGER NOT NULL CHECK(family_order BETWEEN 0 AND 2),
      record_id TEXT NOT NULL,
      record_time TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_bytes INTEGER NOT NULL CHECK(record_bytes > 0),
      embedded_record_bytes INTEGER NOT NULL CHECK(embedded_record_bytes > 0),
      PRIMARY KEY (family, record_id)
    ) STRICT;
    CREATE INDEX safe_records_total_order
      ON safe_records(family_order, record_time, record_id);
    CREATE TABLE diagnostics (
      code TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count >= 0)
    ) STRICT;
    CREATE TABLE chunks (
      chunk_index INTEGER PRIMARY KEY CHECK(chunk_index >= 0),
      status TEXT NOT NULL CHECK(status IN ('planned', 'published', 'verified')),
      metadata_json TEXT NOT NULL
    ) STRICT;
  `);
}

function validateWorkspaceSchema(database) {
  try {
    const applicationId = Number(database.prepare("PRAGMA application_id").get().application_id);
    const userVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (applicationId !== EXPORT_WORKSPACE_APPLICATION_ID || userVersion !== EXPORT_WORKSPACE_USER_VERSION) fail("schema");
    const tables = [...database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).iterate()].map((row) => row.name);
    if (stableJson(tables) !== stableJson(WORKSPACE_TABLES)) fail("schema");
    const indexes = [...database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).iterate()].map((row) => row.name);
    if (stableJson(indexes) !== stableJson(WORKSPACE_INDEXES)) fail("schema");
    const schemaRows = [...database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).iterate()].map((row) => ({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql,
    }));
    const schemaSha256 = createHash("sha256")
      .update("app-usagemonitor/export-workspace-schema/v2\0")
      .update(stableJson(schemaRows))
      .digest("hex");
    if (schemaSha256 !== EXPORT_WORKSPACE_SCHEMA_SHA256) fail("schema");
    const executableSchemaObjects = [...database.prepare(`
      SELECT type, name FROM sqlite_schema
      WHERE type IN ('trigger', 'view')
      ORDER BY type, name
    `).iterate()];
    if (executableSchemaObjects.length !== 0) fail("schema");
    for (const table of WORKSPACE_TABLES) {
      const columns = [...database.prepare(`PRAGMA table_xinfo(${table})`).iterate()].map((row) => row.name);
      if (stableJson(columns) !== stableJson(WORKSPACE_COLUMNS[table])) fail("schema");
    }
    const foreignKeyFailure = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyFailure) fail("schema");
    const integrity = database.prepare("PRAGMA quick_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok") fail("schema");
  } catch (error) {
    if (error instanceof ExportWorkspaceError) throw error;
    fail("schema");
  }
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      fail("transaction");
    }
    throw error;
  }
}

async function workspaceBytes(directory) {
  let total = 0;
  for (const name of [DATABASE_NAME, `${DATABASE_NAME}-journal`, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
    try {
      total += (await stat(join(directory, name))).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return total;
}

function parseCanonical(value) {
  try {
    const parsed = JSON.parse(value);
    if (stableJson(parsed) !== value) fail("schema");
    return parsed;
  } catch (error) {
    if (error instanceof ExportWorkspaceError) throw error;
    fail("schema");
  }
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertCheckpointExpected(value) {
  if (!exactKeys(value, ["checkpointSeq", "phase", "byteOffset", "lineOrdinal"])
      || !safeCount(value.checkpointSeq) || !CHECKPOINT_PHASES.has(value.phase)
      || !safeCount(value.byteOffset) || !safeCount(value.lineOrdinal)) fail("schema");
  return value;
}

function normalizeDiagnosticDeltas(value = []) {
  if (!Array.isArray(value) || value.length > 128) fail("schema");
  return value.map((item) => {
    if (!exactKeys(item, ["code", "count"])
        || typeof item.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item.code)
        || !REVIEWED_DIAGNOSTIC_CODES.has(item.code)
        || !safeCount(item.count)) fail("schema");
    return { code: item.code, count: item.count };
  });
}

function normalizeResourceDeltas(value = {}) {
  const keys = ["directoryEntries", "lines", "oversizedIrrelevantLines", "cumulativeElapsedMs", "peakRssBytes"];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) fail("schema");
  const normalized = Object.fromEntries(keys.map((key) => [key, value[key] ?? 0]));
  if (keys.some((key) => !safeCount(normalized[key]))) fail("schema");
  return normalized;
}

function validPrivateKey(value) {
  return validSha256(value);
}

function normalizeIndexRows(value, kindSet, keyName, { withLineOrdinal = false } = {}) {
  if (!Array.isArray(value) || value.length > 100_000) fail("schema");
  return value.map((item) => {
    const keys = withLineOrdinal ? ["kind", keyName, "lineOrdinal"] : ["kind", keyName];
    if (!exactKeys(item, keys) || !kindSet.has(item.kind) || !validPrivateKey(item[keyName])
        || (withLineOrdinal && (!Number.isSafeInteger(item.lineOrdinal) || item.lineOrdinal < 1))) {
      fail("schema");
    }
    return { kind: item.kind, [keyName]: item[keyName], ...(withLineOrdinal ? { lineOrdinal: item.lineOrdinal } : {}) };
  });
}

export function sourceCheckpointBatchSha256(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) fail("schema");
  const subject = structuredClone(batch);
  delete subject.batchSha256;
  return createHash("sha256")
    .update("app-usagemonitor/source-checkpoint-batch/v1\0")
    .update(stableJson(subject))
    .digest("hex");
}

function buildWorkspaceApi(database, directory, {
  maximumWorkspaceBytes = DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maximumWorkspaceBytes) || maximumWorkspaceBytes < 1) fail("disk");
  const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
  const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
  const maximumPages = Math.floor(maximumWorkspaceBytes / pageSize);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || maximumPages < pageCount) fail("disk");
  database.exec(`PRAGMA max_page_count=${maximumPages}`);
  const insertRecord = database.prepare(`
    INSERT INTO safe_records(
      family, family_order, record_id, record_time, record_json, record_bytes, embedded_record_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(family, record_id) DO NOTHING
  `);
  const selectRecord = database.prepare("SELECT record_json FROM safe_records WHERE family = ? AND record_id = ?");
  const insertDiagnostic = database.prepare(`
    INSERT INTO diagnostics(code, count) VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE SET count = excluded.count
  `);
  const selectCheckpoint = database.prepare(`
    SELECT c.source_key, c.phase, c.byte_offset, c.line_ordinal, c.checkpoint_seq,
           c.parser_version, c.state_json, c.last_batch_sha256,
           p.source_path, p.prefix_bytes, p.parent_source_key, p.is_fork, p.parent_missing
    FROM source_checkpoints c JOIN source_plan p USING(source_key)
    WHERE c.source_key = ?
  `);

  function insertSafeRecordEnvelope(envelope) {
    const shape = RECORD_TYPE[envelope?.recordType];
    if (!shape) fail("schema");
    const record = assertValidExportRecord(envelope.recordType, envelope.record);
    const id = record[shape.idField];
    const time = record[shape.timeField];
    if (typeof id !== "string" || !Number.isFinite(Date.parse(time))) fail("schema");
    const recordJson = stableJson(record);
    const recordBytes = Buffer.byteLength(recordJson);
    const lineCount = recordJson.split("\n").length - 1;
    const result = insertRecord.run(
      shape.family,
      shape.familyOrder,
      id,
      time,
      recordJson,
      recordBytes,
      recordBytes - 1 + (6 * lineCount),
    );
    if (result.changes === 0) {
      const existing = selectRecord.get(shape.family, id);
      if (!existing || existing.record_json !== recordJson) fail("record_conflict");
      return { inserted: false, recordBytes: 0 };
    }
    return { inserted: true, recordBytes };
  }

  function checkpointFromRow(row) {
    if (!row || row.parser_version !== EXPORT_CHECKPOINT_PARSER_VERSION) fail("schema");
    return {
      sourceKey: row.source_key,
      phase: row.phase,
      byteOffset: Number(row.byte_offset),
      lineOrdinal: Number(row.line_ordinal),
      checkpointSeq: Number(row.checkpoint_seq),
      parserVersion: row.parser_version,
      parserState: normalizeCodexCheckpointState(parseCanonical(row.state_json)),
      lastBatchSha256: row.last_batch_sha256,
      parentSourceKey: row.parent_source_key,
      isFork: row.is_fork === 1,
      parentMissing: row.parent_missing === 1,
      prefixBytes: Number(row.prefix_bytes),
    };
  }

  async function assertDiskBudget() {
    const bytes = await workspaceBytes(directory);
    if (!Number.isSafeInteger(maximumWorkspaceBytes) || maximumWorkspaceBytes < 1 || bytes > maximumWorkspaceBytes) fail("disk");
    return bytes;
  }

  return {
    directory,
    databaseFile: join(directory, DATABASE_NAME),
    getDescriptor() {
      const row = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'descriptor'").get();
      if (!row) fail("schema");
      const descriptor = parseCanonical(row.value_json);
      assertDescriptor(descriptor);
      return descriptor;
    },
    loadSourcePlan() {
      const descriptor = this.getDescriptor();
      const sources = [...database.prepare(`
        SELECT ordinal, source_key, source_path, parent_source_key, is_fork, parent_missing,
               device, inode, birthtime_ms, prefix_bytes, prefix_sha256
        FROM source_plan ORDER BY ordinal
      `).iterate()].map((row) => ({
        ordinal: row.ordinal,
        sourceKey: row.source_key,
        path: row.source_path,
        parentSourceKey: row.parent_source_key,
        isFork: row.is_fork === 1,
        parentMissing: row.parent_missing === 1,
        dev: row.device,
        ino: row.inode,
        birthtimeMs: row.birthtime_ms,
        prefixBytes: row.prefix_bytes,
        prefixSha256: row.prefix_sha256,
      }));
      const plan = {
        schemaVersion: EXPORT_SOURCE_PLAN_VERSION,
        startAt: descriptor.coveredAt.startAt,
        endAt: descriptor.coveredAt.endAt,
        sourcePlanSha256: descriptor.sourcePlan.sourcePlanSha256,
        sources,
      };
      assertSourcePlanMatchesDescriptor(plan, descriptor);
      return plan;
    },
    loadSourceCheckpoint(sourceKey) {
      if (!validSha256(sourceKey)) fail("schema");
      const row = selectCheckpoint.get(sourceKey);
      if (!row) fail("schema");
      return checkpointFromRow(row);
    },
    loadNextSourceCheckpoint() {
      const row = database.prepare(`
        SELECT c.source_key, c.phase, c.byte_offset, c.line_ordinal, c.checkpoint_seq,
               c.parser_version, c.state_json, c.last_batch_sha256,
               p.source_path, p.prefix_bytes, p.parent_source_key, p.is_fork, p.parent_missing
        FROM source_checkpoints c JOIN source_plan p USING(source_key)
        LEFT JOIN source_checkpoints parent ON parent.source_key = p.parent_source_key
        WHERE p.scan_status = 'pending' AND c.phase != 'complete'
          AND (p.parent_source_key IS NULL OR parent.phase = 'complete')
        ORDER BY p.ordinal LIMIT 1
      `).get();
      return row ? checkpointFromRow(row) : null;
    },
    hasSeenOccurrence(kind, occurrenceKey) {
      if (!OCCURRENCE_KINDS.has(kind) || !validPrivateKey(occurrenceKey)) fail("schema");
      return Boolean(database.prepare(`
        SELECT 1 FROM seen_occurrences WHERE kind = ? AND occurrence_key = ? LIMIT 1
      `).get(kind, occurrenceKey));
    },
    hasInheritedSnapshot(sourceKey, kind, snapshotKey) {
      if (!validSha256(sourceKey) || !SNAPSHOT_KINDS.has(kind) || !validPrivateKey(snapshotKey)) fail("schema");
      return Boolean(database.prepare(`
        WITH RECURSIVE ancestors(source_key) AS (
          SELECT parent_source_key FROM source_plan
          WHERE source_key = ? AND parent_source_key IS NOT NULL
          UNION ALL
          SELECT p.parent_source_key FROM source_plan p JOIN ancestors a ON p.source_key = a.source_key
          WHERE p.parent_source_key IS NOT NULL
        )
        SELECT 1 FROM source_snapshots s JOIN ancestors a USING(source_key)
        WHERE s.kind = ? AND s.snapshot_key = ? LIMIT 1
      `).get(sourceKey, kind, snapshotKey));
    },
    hasLocalSnapshot(sourceKey, kind, snapshotKey) {
      if (!validSha256(sourceKey) || !SNAPSHOT_KINDS.has(kind) || !validPrivateKey(snapshotKey)) fail("schema");
      return Boolean(database.prepare(`
        SELECT 1 FROM source_snapshots WHERE source_key = ? AND kind = ? AND snapshot_key = ? LIMIT 1
      `).get(sourceKey, kind, snapshotKey));
    },
    sourceTierAt(sourceKey, timestampMs) {
      if (!validSha256(sourceKey) || !Number.isSafeInteger(timestampMs)) fail("schema");
      const row = database.prepare(`
        SELECT tier_index, event_time_ms, line_ordinal, tier_state_json
        FROM source_tier_events
        WHERE source_key = ? AND event_time_ms <= ?
        ORDER BY event_time_ms DESC, line_ordinal DESC LIMIT 1
      `).get(sourceKey, timestampMs);
      return row ? {
        tierIndex: Number(row.tier_index),
        eventTimeMs: Number(row.event_time_ms),
        lineOrdinal: Number(row.line_ordinal),
        tierState: parseCanonical(row.tier_state_json),
      } : null;
    },
    sourceTierEvents(sourceKey) {
      if (!validSha256(sourceKey)) fail("schema");
      return [...database.prepare(`
        SELECT tier_index, event_time_ms, line_ordinal, tier_state_json
        FROM source_tier_events WHERE source_key = ? ORDER BY tier_index
      `).iterate(sourceKey)].map((row) => ({
        tierIndex: Number(row.tier_index),
        eventTimeMs: Number(row.event_time_ms),
        lineOrdinal: Number(row.line_ordinal),
        tierState: parseCanonical(row.tier_state_json),
      }));
    },
    sourceOpenTaskKeys(sourceKey) {
      if (!validSha256(sourceKey)) fail("schema");
      const keys = [...database.prepare(`
        SELECT task_key FROM source_open_tasks WHERE source_key = ? ORDER BY task_key LIMIT ?
      `).iterate(sourceKey, MAX_CHECKPOINT_OPEN_TASKS + 1)].map((row) => row.task_key);
      if (keys.length > MAX_CHECKPOINT_OPEN_TASKS) fail("schema");
      return keys;
    },
    rebindSourcePaths(sourcePlan) {
      if (!sourcePlan || !Array.isArray(sourcePlan.sources)) fail("schema");
      const stored = this.loadSourcePlan();
      if (sourcePlan.sourcePlanSha256 !== stored.sourcePlanSha256
          || sourcePlan.sources.length !== stored.sources.length) fail("checkpoint_mismatch");
      transaction(database, () => {
        const update = database.prepare("UPDATE source_plan SET source_path = ? WHERE source_key = ?");
        for (const source of sourcePlan.sources) {
          if (typeof source.path !== "string" || !validSha256(source.sourceKey)) fail("schema");
          const expected = stored.sources[source.ordinal];
          if (!expected || expected.sourceKey !== source.sourceKey) fail("checkpoint_mismatch");
          update.run(source.path, source.sourceKey);
        }
      });
    },
    resourceUsage() {
      const row = database.prepare("SELECT * FROM resource_usage WHERE singleton = 1").get();
      if (!row || row.policy_version !== EXPORT_RESOURCE_POLICY_VERSION) fail("schema");
      return {
        policyVersion: row.policy_version,
        sourceFiles: Number(row.source_files),
        sourceBytes: Number(row.source_bytes),
        directoryEntries: Number(row.directory_entries),
        lines: Number(row.lines),
        oversizedIrrelevantLines: Number(row.oversized_irrelevant_lines),
        outputRecords: Number(row.output_records),
        expandedRecordBytes: Number(row.expanded_record_bytes),
        cumulativeElapsedMs: Number(row.cumulative_elapsed_ms),
        peakRssBytes: Number(row.peak_rss_bytes),
        workspaceHighWaterBytes: Number(row.workspace_high_water_bytes),
        recoveryReservations: Number(row.recovery_reservations),
      };
    },
    beginInvocation({
      nowMs = Date.now(),
      recoveryReservationMs = DEFAULT_CRASH_RECOVERY_RESERVATION_MS,
    } = {}) {
      if (!safeCount(Math.trunc(nowMs)) || !Number.isFinite(nowMs)
          || !Number.isSafeInteger(recoveryReservationMs) || recoveryReservationMs < 1) fail("schema");
      return transaction(database, () => {
        const stale = database.prepare("SELECT started_at_ms FROM resource_invocations WHERE singleton = 1").get();
        if (stale) {
          const usage = database.prepare(`
            SELECT cumulative_elapsed_ms, recovery_reservations FROM resource_usage WHERE singleton = 1
          `).get();
          if (!usage || Number(usage.cumulative_elapsed_ms) > Number.MAX_SAFE_INTEGER - recoveryReservationMs
              || Number(usage.recovery_reservations) >= Number.MAX_SAFE_INTEGER) fail("schema");
          database.prepare(`
            UPDATE resource_usage SET
              cumulative_elapsed_ms = cumulative_elapsed_ms + ?,
              recovery_reservations = recovery_reservations + 1
            WHERE singleton = 1
          `).run(recoveryReservationMs);
        }
        database.prepare(`
          INSERT INTO resource_invocations(singleton, started_at_ms) VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET started_at_ms = excluded.started_at_ms
        `).run(Math.trunc(nowMs));
        return { recoveredStaleInvocation: Boolean(stale), recoveryReservationMs: stale ? recoveryReservationMs : 0 };
      });
    },
    finishInvocation({ resourceUsage: usage = null } = {}) {
      transaction(database, () => {
        if (usage !== null) {
          const keys = [
            "policyVersion", "sourceFiles", "sourceBytes", "directoryEntries", "lines",
            "oversizedIrrelevantLines", "outputRecords", "expandedRecordBytes",
            "cumulativeElapsedMs", "peakRssBytes", "workspaceHighWaterBytes", "recoveryReservations",
          ];
          if (!exactKeys(usage, keys) || usage.policyVersion !== EXPORT_RESOURCE_POLICY_VERSION
              || keys.slice(1).some((key) => !safeCount(usage[key]))) fail("schema");
          const stored = database.prepare(`
            SELECT source_files, source_bytes FROM resource_usage WHERE singleton = 1
          `).get();
          if (!stored || Number(stored.source_files) !== usage.sourceFiles
              || Number(stored.source_bytes) !== usage.sourceBytes) fail("checkpoint_mismatch");
          database.prepare(`
            UPDATE resource_usage SET
              directory_entries = MAX(directory_entries, ?),
              lines = MAX(lines, ?),
              oversized_irrelevant_lines = MAX(oversized_irrelevant_lines, ?),
              cumulative_elapsed_ms = MAX(cumulative_elapsed_ms, ?),
              peak_rss_bytes = MAX(peak_rss_bytes, ?),
              workspace_high_water_bytes = MAX(workspace_high_water_bytes, ?),
              recovery_reservations = MAX(recovery_reservations, ?)
            WHERE singleton = 1
          `).run(
            usage.directoryEntries,
            usage.lines,
            usage.oversizedIrrelevantLines,
            usage.cumulativeElapsedMs,
            usage.peakRssBytes,
            usage.workspaceHighWaterBytes,
            usage.recoveryReservations,
          );
        }
        database.prepare("DELETE FROM resource_invocations WHERE singleton = 1").run();
      });
    },
    async insertRecordBatch(envelopes) {
      if (!Array.isArray(envelopes) || envelopes.length > DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) fail("schema");
      const bytesBeforeCommit = await workspaceBytes(directory);
      const batchBytes = Buffer.byteLength(stableJson(envelopes), "utf8");
      const reservedWorkspaceBytes = bytesBeforeCommit + (8 * batchBytes) + (1024 * 1024);
      if (!Number.isSafeInteger(reservedWorkspaceBytes) || reservedWorkspaceBytes > maximumWorkspaceBytes) fail("disk");
      transaction(database, () => {
        let insertedRecords = 0;
        let insertedBytes = 0;
        for (const envelope of envelopes) {
          const inserted = insertSafeRecordEnvelope(envelope);
          if (inserted.inserted) {
            insertedRecords += 1;
            insertedBytes += inserted.recordBytes;
          }
        }
        const current = database.prepare(`
          SELECT output_records, expanded_record_bytes FROM resource_usage WHERE singleton = 1
        `).get();
        if (!current || Number(current.output_records) > Number.MAX_SAFE_INTEGER - insertedRecords
            || Number(current.expanded_record_bytes) > Number.MAX_SAFE_INTEGER - insertedBytes) fail("schema");
        database.prepare(`
          UPDATE resource_usage SET output_records = output_records + ?,
            expanded_record_bytes = expanded_record_bytes + ?,
            workspace_high_water_bytes = MAX(workspace_high_water_bytes, ?)
          WHERE singleton = 1
        `).run(insertedRecords, insertedBytes, reservedWorkspaceBytes);
      });
      await assertDiskBudget();
    },
    async commitSourceBatch(batch) {
      const requiredKeys = [
        "sourceKey", "expected", "next", "batchSha256", "records", "seenOccurrences",
        "localSnapshots", "tierEvents", "openTaskAdds", "openTaskDeletes",
        "diagnosticDeltas", "resourceDeltas",
      ];
      if (!exactKeys(batch, requiredKeys) || !validSha256(batch.sourceKey)
          || !validSha256(batch.batchSha256) || batch.batchSha256 !== sourceCheckpointBatchSha256(batch)
          || !Array.isArray(batch.records) || batch.records.length > DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) {
        fail("schema");
      }
      const expected = assertCheckpointExpected(batch.expected);
      const nextKeys = Object.keys(batch.next ?? {});
      const hasCompletedPhaseCursor = nextKeys.includes("completedPhaseCursor");
      if ((!exactKeys(batch.next, ["phase", "byteOffset", "lineOrdinal", "parserState"])
            && !exactKeys(batch.next, ["phase", "byteOffset", "lineOrdinal", "parserState", "completedPhaseCursor"]))
          || !CHECKPOINT_PHASES.has(batch.next.phase) || !safeCount(batch.next.byteOffset)
          || !safeCount(batch.next.lineOrdinal)) fail("schema");
      const completedPhaseCursor = hasCompletedPhaseCursor ? batch.next.completedPhaseCursor : null;
      if (completedPhaseCursor !== null
          && (!exactKeys(completedPhaseCursor, ["byteOffset", "lineOrdinal"])
            || !safeCount(completedPhaseCursor.byteOffset) || !safeCount(completedPhaseCursor.lineOrdinal))) {
        fail("schema");
      }
      const parserState = normalizeCodexCheckpointState(batch.next.parserState);
      const seenOccurrences = normalizeIndexRows(batch.seenOccurrences, OCCURRENCE_KINDS, "occurrenceKey", { withLineOrdinal: true });
      const localSnapshots = normalizeIndexRows(batch.localSnapshots, SNAPSHOT_KINDS, "snapshotKey");
      if (!Array.isArray(batch.tierEvents) || batch.tierEvents.length > 100_000) fail("schema");
      const tierEvents = batch.tierEvents.map((event) => {
        if (!exactKeys(event, ["tierIndex", "eventTimeMs", "lineOrdinal", "tierState"])
            || !safeCount(event.tierIndex) || !Number.isSafeInteger(event.eventTimeMs)
            || !Number.isSafeInteger(event.lineOrdinal) || event.lineOrdinal < 1
            || !event.tierState || typeof event.tierState !== "object" || Array.isArray(event.tierState)) fail("schema");
        const tierState = normalizeCodexCheckpointState({ ...createEmptyCodexCheckpointState(), tier: event.tierState }).tier;
        return { ...event, tierState };
      });
      for (const list of [batch.openTaskAdds, batch.openTaskDeletes]) {
        if (!Array.isArray(list) || list.length > 100_000 || list.some((key) => !validPrivateKey(key))) fail("schema");
      }
      if (seenOccurrences.length + localSnapshots.length + tierEvents.length
          + batch.openTaskAdds.length + batch.openTaskDeletes.length > MAX_CHECKPOINT_INDEX_OPERATIONS) {
        fail("schema");
      }
      const diagnosticDeltas = normalizeDiagnosticDeltas(batch.diagnosticDeltas);
      const resourceDeltas = normalizeResourceDeltas(batch.resourceDeltas);
      const before = selectCheckpoint.get(batch.sourceKey);
      if (!before) fail("schema");
      const boundaryOffset = completedPhaseCursor?.byteOffset ?? batch.next.byteOffset;
      await assertCompleteLineBoundary(before.source_path, boundaryOffset, Number(before.prefix_bytes));
      const bytesBeforeCommit = await workspaceBytes(directory);
      const batchBytes = Buffer.byteLength(stableJson(batch), "utf8");
      const reservedWorkspaceBytes = bytesBeforeCommit + (8 * batchBytes) + (1024 * 1024);
      if (!Number.isSafeInteger(reservedWorkspaceBytes) || reservedWorkspaceBytes > maximumWorkspaceBytes) fail("disk");

      const result = transaction(database, () => {
        const current = selectCheckpoint.get(batch.sourceKey);
        if (!current) fail("schema");
        if (current.last_batch_sha256 === batch.batchSha256) {
          return { alreadyCommitted: true, checkpoint: checkpointFromRow(current) };
        }
        if (Number(current.checkpoint_seq) !== expected.checkpointSeq || current.phase !== expected.phase
            || Number(current.byte_offset) !== expected.byteOffset || Number(current.line_ordinal) !== expected.lineOrdinal) {
          fail("checkpoint_mismatch");
        }
        const rank = { tier_scan: 0, record_scan: 1, complete: 2 };
        const currentRank = rank[current.phase];
        const nextRank = rank[batch.next.phase];
        const effectiveNextLineOrdinal = completedPhaseCursor?.lineOrdinal ?? batch.next.lineOrdinal;
        if (nextRank < currentRank || nextRank > currentRank + 1
            || (nextRank === currentRank && (batch.next.byteOffset < expected.byteOffset
              || batch.next.lineOrdinal < expected.lineOrdinal))
            || (current.phase === "tier_scan" && batch.next.phase === "record_scan"
              && (batch.next.byteOffset !== 0 || batch.next.lineOrdinal !== 0
                || completedPhaseCursor?.byteOffset !== Number(current.prefix_bytes)))
            || (current.phase !== "tier_scan" && completedPhaseCursor !== null)
            || (current.phase === "tier_scan" && batch.next.phase !== "record_scan" && completedPhaseCursor !== null)
            || (batch.next.phase === "complete" && batch.next.byteOffset !== Number(current.prefix_bytes))) {
          fail("checkpoint_mismatch");
        }
        if (effectiveNextLineOrdinal - expected.lineOrdinal !== resourceDeltas.lines) fail("checkpoint_mismatch");

        let insertedRecords = 0;
        let insertedRecordBytes = 0;
        for (const envelope of batch.records) {
          const inserted = insertSafeRecordEnvelope(envelope);
          if (inserted.inserted) {
            insertedRecords += 1;
            insertedRecordBytes += inserted.recordBytes;
          }
        }
        const insertOccurrence = database.prepare(`
          INSERT OR IGNORE INTO seen_occurrences(kind, occurrence_key, source_key, line_ordinal)
          VALUES (?, ?, ?, ?)
        `);
        const selectOccurrence = database.prepare(`
          SELECT source_key, line_ordinal FROM seen_occurrences WHERE kind = ? AND occurrence_key = ?
        `);
        for (const item of seenOccurrences) {
          const inserted = insertOccurrence.run(item.kind, item.occurrenceKey, batch.sourceKey, item.lineOrdinal);
          if (inserted.changes === 0) {
            const existing = selectOccurrence.get(item.kind, item.occurrenceKey);
            if (!existing || existing.source_key !== batch.sourceKey || Number(existing.line_ordinal) !== item.lineOrdinal) {
              fail("record_conflict");
            }
          }
        }
        const insertSnapshot = database.prepare(`
          INSERT OR IGNORE INTO source_snapshots(source_key, kind, snapshot_key) VALUES (?, ?, ?)
        `);
        for (const item of localSnapshots) insertSnapshot.run(batch.sourceKey, item.kind, item.snapshotKey);
        const insertTier = database.prepare(`
          INSERT INTO source_tier_events(source_key, tier_index, event_time_ms, line_ordinal, tier_state_json)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const event of tierEvents) {
          insertTier.run(batch.sourceKey, event.tierIndex, event.eventTimeMs, event.lineOrdinal, stableJson(event.tierState));
        }
        const addTask = database.prepare("INSERT OR IGNORE INTO source_open_tasks(source_key, task_key) VALUES (?, ?)");
        const deleteTask = database.prepare("DELETE FROM source_open_tasks WHERE source_key = ? AND task_key = ?");
        for (const key of batch.openTaskAdds) addTask.run(batch.sourceKey, key);
        for (const key of batch.openTaskDeletes) deleteTask.run(batch.sourceKey, key);
        const openTaskCount = Number(database.prepare(`
          SELECT COUNT(*) AS count FROM source_open_tasks WHERE source_key = ?
        `).get(batch.sourceKey).count);
        if (openTaskCount > MAX_CHECKPOINT_OPEN_TASKS) fail("schema");
        const addDiagnostic = database.prepare(`
          INSERT INTO source_diagnostics(source_key, code, count) VALUES (?, ?, ?)
          ON CONFLICT(source_key, code) DO UPDATE SET count = count + excluded.count
        `);
        const currentDiagnostic = database.prepare(`
          SELECT count FROM source_diagnostics WHERE source_key = ? AND code = ?
        `);
        for (const item of diagnosticDeltas) {
          const existing = Number(currentDiagnostic.get(batch.sourceKey, item.code)?.count ?? 0);
          if (existing > Number.MAX_SAFE_INTEGER - item.count) fail("schema");
          addDiagnostic.run(batch.sourceKey, item.code, item.count);
        }
        const currentUsage = database.prepare(`
          SELECT directory_entries, lines, oversized_irrelevant_lines, output_records,
                 expanded_record_bytes, cumulative_elapsed_ms
          FROM resource_usage WHERE singleton = 1
        `).get();
        const additions = [
          [Number(currentUsage.directory_entries), resourceDeltas.directoryEntries],
          [Number(currentUsage.lines), resourceDeltas.lines],
          [Number(currentUsage.oversized_irrelevant_lines), resourceDeltas.oversizedIrrelevantLines],
          [Number(currentUsage.output_records), insertedRecords],
          [Number(currentUsage.expanded_record_bytes), insertedRecordBytes],
          [Number(currentUsage.cumulative_elapsed_ms), resourceDeltas.cumulativeElapsedMs],
        ];
        if (additions.some(([currentValue, addition]) => !safeCount(currentValue)
          || currentValue > Number.MAX_SAFE_INTEGER - addition)) fail("schema");
        database.prepare(`
          UPDATE resource_usage SET
            directory_entries = directory_entries + ?,
            lines = lines + ?,
            oversized_irrelevant_lines = oversized_irrelevant_lines + ?,
            output_records = output_records + ?,
            expanded_record_bytes = expanded_record_bytes + ?,
            cumulative_elapsed_ms = cumulative_elapsed_ms + ?,
            peak_rss_bytes = MAX(peak_rss_bytes, ?),
            workspace_high_water_bytes = MAX(workspace_high_water_bytes, ?)
          WHERE singleton = 1
        `).run(
          resourceDeltas.directoryEntries,
          resourceDeltas.lines,
          resourceDeltas.oversizedIrrelevantLines,
          insertedRecords,
          insertedRecordBytes,
          resourceDeltas.cumulativeElapsedMs,
          resourceDeltas.peakRssBytes,
          reservedWorkspaceBytes,
        );
        database.prepare(`
          UPDATE source_checkpoints SET phase = ?, byte_offset = ?, line_ordinal = ?,
            checkpoint_seq = checkpoint_seq + 1, state_json = ?, last_batch_sha256 = ?
          WHERE source_key = ?
        `).run(
          batch.next.phase,
          batch.next.byteOffset,
          batch.next.lineOrdinal,
          serializeCodexCheckpointState(parserState),
          batch.batchSha256,
          batch.sourceKey,
        );
        if (batch.next.phase === "complete") {
          database.prepare("UPDATE source_plan SET scan_status = 'complete' WHERE source_key = ?").run(batch.sourceKey);
        }
        return { alreadyCommitted: false, checkpoint: checkpointFromRow(selectCheckpoint.get(batch.sourceKey)) };
      });
      await assertDiskBudget();
      return result;
    },
    replaceDiagnostics(diagnostics = []) {
      if (!Array.isArray(diagnostics) || diagnostics.length > 128) fail("schema");
      transaction(database, () => {
        database.exec("DELETE FROM diagnostics");
        for (const item of diagnostics) {
          if (!REVIEWED_DIAGNOSTIC_CODES.has(item?.code)
              || !Number.isSafeInteger(item.count) || item.count < 0) fail("schema");
          insertDiagnostic.run(item.code, item.count);
        }
      });
    },
    finalizeScan() {
      transaction(database, () => {
        const counts = database.prepare(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN c.phase = 'complete' THEN 1 ELSE 0 END) AS complete
          FROM source_plan p JOIN source_checkpoints c USING(source_key)
        `).get();
        const total = Number(counts.total);
        if (Number(counts.complete ?? 0) !== total) fail("checkpoint_mismatch");
        database.prepare("INSERT OR REPLACE INTO workspace_meta(key, value_json) VALUES ('scan_status', ?)")
          .run(stableJson({ status: "complete", sourceFilesScanned: total }));
      });
    },
    markPoisoned(code) {
      if (code !== "source_integrity") fail("schema");
      transaction(database, () => {
        database.prepare("INSERT OR REPLACE INTO workspace_meta(key, value_json) VALUES ('poison', ?)")
          .run(stableJson({ code }));
      });
    },
    isPoisoned() {
      const row = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'poison'").get();
      return row ? parseCanonical(row.value_json).code === "source_integrity" : false;
    },
    isScanComplete() {
      const row = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'scan_status'").get();
      if (!row || parseCanonical(row.value_json).status !== "complete") return false;
      const incomplete = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM source_checkpoints WHERE phase != 'complete'
      `).get().count);
      return incomplete === 0;
    },
    scanDiagnostics() {
      const row = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'scan_status'").get();
      const status = row ? parseCanonical(row.value_json) : null;
      return {
        sourceFilesScanned: Number.isSafeInteger(status?.sourceFilesScanned) ? status.sourceFilesScanned : 0,
        codes: this.diagnostics(),
      };
    },
    counts() {
      const counts = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
      for (const row of database.prepare("SELECT family, COUNT(*) AS count FROM safe_records GROUP BY family").iterate()) {
        counts[row.family] = Number(row.count);
      }
      return counts;
    },
    hasRecord(recordType, recordId) {
      const shape = RECORD_TYPE[recordType];
      if (!shape || typeof recordId !== "string" || recordId.length > 128) fail("schema");
      return Boolean(selectRecord.get(shape.family, recordId));
    },
    diagnostics() {
      return [...database.prepare(`
        SELECT code, SUM(count) AS count FROM (
          SELECT code, count FROM diagnostics
          UNION ALL
          SELECT code, count FROM source_diagnostics
        ) GROUP BY code ORDER BY code
      `).iterate()]
        .map((row) => ({ code: row.code, count: Number(row.count) }));
    },
    recordChunk(chunkIndex, status, metadata) {
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0
          || !["planned", "published", "verified"].includes(status)
          || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("schema");
      const metadataJson = stableJson(metadata);
      transaction(database, () => {
        const existing = database.prepare("SELECT status, metadata_json FROM chunks WHERE chunk_index = ?").get(chunkIndex);
        if (existing && existing.metadata_json !== metadataJson) fail("record_conflict");
        const rank = { planned: 0, published: 1, verified: 2 };
        if (existing && rank[status] < rank[existing.status]) return;
        database.prepare(`
          INSERT INTO chunks(chunk_index, status, metadata_json) VALUES (?, ?, ?)
          ON CONFLICT(chunk_index) DO UPDATE SET status = excluded.status
        `).run(chunkIndex, status, metadataJson);
      });
    },
    chunks() {
      return [...database.prepare("SELECT chunk_index, status, metadata_json FROM chunks ORDER BY chunk_index").iterate()]
        .map((row) => ({ index: row.chunk_index, status: row.status, metadata: parseCanonical(row.metadata_json) }));
    },
    markManifestComplete(metadata) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("schema");
      transaction(database, () => {
        database.prepare("INSERT OR REPLACE INTO workspace_meta(key, value_json) VALUES ('manifest', ?)")
          .run(stableJson(metadata));
      });
    },
    manifestState() {
      const row = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'manifest'").get();
      return row ? parseCanonical(row.value_json) : null;
    },
    *iterateRecords() {
      for (const row of database.prepare(`
        SELECT family, record_id, record_time, record_json, record_bytes, embedded_record_bytes
        FROM safe_records ORDER BY family_order, record_time, record_id
      `).iterate()) {
        yield {
          family: row.family,
          recordId: row.record_id,
          recordTime: row.record_time,
          record: parseCanonical(row.record_json),
          recordJson: row.record_json,
          recordBytes: row.record_bytes,
          embeddedRecordBytes: row.embedded_record_bytes,
        };
      }
    },
    async status() {
      const totals = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(record_bytes), 0) AS bytes FROM safe_records").get();
      return {
        workspaceVersion: EXPORT_WORKSPACE_VERSION,
        scanComplete: this.isScanComplete(),
        poisoned: this.isPoisoned(),
        recordCounts: this.counts(),
        expandedRecordBytes: Number(totals.bytes),
        workspaceBytes: await assertDiskBudget(),
      };
    },
    async storageBytes() {
      return assertDiskBudget();
    },
    close() {
      database.close();
    },
  };
}

export function buildExportWorkspaceDescriptor({
  participantId,
  createdAt,
  coveredAt,
  compatibility,
  sourcePlan,
  activityPlan,
  sourceProviders = ["openai_codex"],
  clientPlatform = localPlatformName(),
  resourceLimits = DEFAULT_EXPORT_RESOURCE_LIMITS,
} = {}) {
  const descriptor = {
    workspaceVersion: EXPORT_WORKSPACE_VERSION,
    resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
    resourceLimits: { ...normalizeExportResourceLimits(resourceLimits) },
    participantId,
    createdAt: new Date(createdAt).toISOString(),
    coveredAt: {
      startAt: new Date(coveredAt.startAt).toISOString(),
      endAt: new Date(coveredAt.endAt).toISOString(),
    },
    compatibility: structuredClone(compatibility),
    sourceProviders: [...sourceProviders],
    clientPlatform,
    sourcePlan: summarizeExportSourcePlan(sourcePlan),
    activityPlan: structuredClone(activityPlan),
  };
  assertDescriptor(descriptor);
  return descriptor;
}

export async function createExportWorkspace({
  directory,
  descriptor,
  sourcePlan,
  maximumWorkspaceBytes,
} = {}) {
  assertDescriptor(descriptor);
  assertSourcePlanMatchesDescriptor(sourcePlan, descriptor);
  const workspaceDirectory = await ensureOwnerDirectory(directory, { create: true });
  if (basename(workspaceDirectory) === DATABASE_NAME) fail("directory");
  const databaseFile = join(workspaceDirectory, DATABASE_NAME);
  await precreateDatabase(databaseFile);
  const DatabaseSync = await loadSqlite();
  const database = new DatabaseSync(databaseFile);
  try {
    configureDatabase(database);
    initializeSchema(database);
    validateWorkspaceSchema(database);
    transaction(database, () => {
      database.prepare("INSERT INTO workspace_meta(key, value_json) VALUES ('descriptor', ?)")
        .run(stableJson(descriptor));
      const insertSource = database.prepare(`
        INSERT INTO source_plan(
          ordinal, source_key, source_path, parent_source_key, is_fork, parent_missing,
          device, inode, birthtime_ms, prefix_bytes, prefix_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertCheckpoint = database.prepare(`
        INSERT INTO source_checkpoints(
          source_key, phase, byte_offset, line_ordinal, checkpoint_seq,
          parser_version, state_json, last_batch_sha256
        ) VALUES (?, 'tier_scan', 0, 0, 0, ?, ?, NULL)
      `);
      for (const source of sourcePlan.sources) {
        insertSource.run(
          source.ordinal,
          source.sourceKey,
          source.path,
          source.parentSourceKey ?? null,
          source.isFork ? 1 : 0,
          source.parentMissing ? 1 : 0,
          Number.isSafeInteger(source.dev) ? source.dev : null,
          Number.isSafeInteger(source.ino) ? source.ino : null,
          Number.isFinite(source.birthtimeMs) ? Math.trunc(source.birthtimeMs) : null,
          source.prefixBytes,
          source.prefixSha256,
        );
        insertCheckpoint.run(
          source.sourceKey,
          EXPORT_CHECKPOINT_PARSER_VERSION,
          serializeCodexCheckpointState(createEmptyCodexCheckpointState()),
        );
      }
      database.prepare(`
        INSERT INTO resource_usage(
          singleton, policy_version, source_files, source_bytes, directory_entries, lines,
          oversized_irrelevant_lines, output_records, expanded_record_bytes,
          cumulative_elapsed_ms, peak_rss_bytes, workspace_high_water_bytes, recovery_reservations
        ) VALUES (1, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      `).run(
        EXPORT_RESOURCE_POLICY_VERSION,
        sourcePlan.sources.length,
        sourcePlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0),
      );
    });
    await chmod(databaseFile, 0o600);
    const api = buildWorkspaceApi(database, workspaceDirectory, {
      maximumWorkspaceBytes: descriptorWorkspaceCeiling(descriptor, maximumWorkspaceBytes),
    });
    await api.status();
    return api;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function openExportWorkspace({
  directory,
  expectedDescriptor = null,
  maximumWorkspaceBytes,
} = {}) {
  const workspaceDirectory = await ensureOwnerDirectory(directory);
  const databaseFile = join(workspaceDirectory, DATABASE_NAME);
  const before = await inspectExistingDatabase(databaseFile);
  const DatabaseSync = await loadSqlite();
  const database = new DatabaseSync(databaseFile, { readOnly: false });
  try {
    configureDatabase(database);
    validateWorkspaceSchema(database);
    const after = await lstat(databaseFile);
    assertDatabaseStats(after);
    if (after.dev !== before.dev || after.ino !== before.ino) fail("database_changed");
    const descriptorRow = database.prepare("SELECT value_json FROM workspace_meta WHERE key = 'descriptor'").get();
    if (!descriptorRow) fail("schema");
    const descriptor = parseCanonical(descriptorRow.value_json);
    assertDescriptor(descriptor);
    const api = buildWorkspaceApi(database, workspaceDirectory, {
      maximumWorkspaceBytes: descriptorWorkspaceCeiling(descriptor, maximumWorkspaceBytes),
    });
    if (expectedDescriptor && stableJson(descriptor) !== stableJson(expectedDescriptor)) fail("checkpoint_mismatch");
    api.loadSourcePlan();
    await api.status();
    return api;
  } catch (error) {
    database.close();
    throw error;
  }
}
