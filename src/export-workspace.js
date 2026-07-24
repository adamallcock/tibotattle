import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { assertValidExportRecord } from "./export-schema.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, EXPORT_RESOURCE_POLICY_VERSION } from "./export-resource-policy.js";
import { EXPORT_SOURCE_PLAN_VERSION, summarizeExportSourcePlan } from "./export-source-plan.js";
import { stableJson } from "./storage.js";

export const EXPORT_WORKSPACE_VERSION = "usage-export-workspace-v0.1";
export const DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes;
export const DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumSqliteBatchRecords;

const DATABASE_NAME = "workspace.sqlite3";
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

function assertDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
      || descriptor.workspaceVersion !== EXPORT_WORKSPACE_VERSION
      || descriptor.resourcePolicyVersion !== EXPORT_RESOURCE_POLICY_VERSION
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
    CREATE TABLE workspace_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_plan (
      ordinal INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      device INTEGER,
      inode INTEGER,
      birthtime_ms INTEGER,
      prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
      prefix_sha256 TEXT NOT NULL CHECK(length(prefix_sha256) = 64),
      scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending', 'complete'))
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

function buildWorkspaceApi(database, directory, {
  maximumWorkspaceBytes = DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES,
} = {}) {
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
        SELECT ordinal, source_key, source_path, device, inode, birthtime_ms, prefix_bytes, prefix_sha256
        FROM source_plan ORDER BY ordinal
      `).iterate()].map((row) => ({
        ordinal: row.ordinal,
        sourceKey: row.source_key,
        path: row.source_path,
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
    async insertRecordBatch(envelopes) {
      if (!Array.isArray(envelopes) || envelopes.length > DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) fail("schema");
      transaction(database, () => {
        for (const envelope of envelopes) {
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
          }
        }
      });
      await assertDiskBudget();
    },
    replaceDiagnostics(diagnostics = []) {
      if (!Array.isArray(diagnostics) || diagnostics.length > 128) fail("schema");
      transaction(database, () => {
        database.exec("DELETE FROM diagnostics");
        for (const item of diagnostics) {
          if (typeof item?.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item.code)
              || !Number.isSafeInteger(item.count) || item.count < 0) fail("schema");
          insertDiagnostic.run(item.code, item.count);
        }
      });
    },
    markScanComplete({ sourceFilesScanned } = {}) {
      if (!Number.isSafeInteger(sourceFilesScanned) || sourceFilesScanned < 0) fail("schema");
      transaction(database, () => {
        database.prepare("INSERT OR REPLACE INTO workspace_meta(key, value_json) VALUES ('scan_status', ?)")
          .run(stableJson({ status: "complete", sourceFilesScanned }));
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
      return row ? parseCanonical(row.value_json).status === "complete" : false;
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
    diagnostics() {
      return [...database.prepare("SELECT code, count FROM diagnostics ORDER BY code").iterate()]
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
} = {}) {
  const descriptor = {
    workspaceVersion: EXPORT_WORKSPACE_VERSION,
    resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
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
    transaction(database, () => {
      database.prepare("INSERT INTO workspace_meta(key, value_json) VALUES ('descriptor', ?)")
        .run(stableJson(descriptor));
      const insertSource = database.prepare(`
        INSERT INTO source_plan(
          ordinal, source_key, source_path, device, inode, birthtime_ms, prefix_bytes, prefix_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of sourcePlan.sources) {
        insertSource.run(
          source.ordinal,
          source.sourceKey,
          source.path,
          Number.isSafeInteger(source.dev) ? source.dev : null,
          Number.isSafeInteger(source.ino) ? source.ino : null,
          Number.isFinite(source.birthtimeMs) ? Math.trunc(source.birthtimeMs) : null,
          source.prefixBytes,
          source.prefixSha256,
        );
      }
    });
    await chmod(databaseFile, 0o600);
    const api = buildWorkspaceApi(database, workspaceDirectory, { maximumWorkspaceBytes });
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
    const after = await lstat(databaseFile);
    assertDatabaseStats(after);
    if (after.dev !== before.dev || after.ino !== before.ino) fail("database_changed");
    const api = buildWorkspaceApi(database, workspaceDirectory, { maximumWorkspaceBytes });
    const descriptor = api.getDescriptor();
    if (expectedDescriptor && stableJson(descriptor) !== stableJson(expectedDescriptor)) fail("checkpoint_mismatch");
    api.loadSourcePlan();
    await api.status();
    return api;
  } catch (error) {
    database.close();
    throw error;
  }
}
