import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/*
 * This module is deliberately a content-free provenance/tombstone coordinator,
 * not a transcript parser, usage accountant, UI projection, or upload store.
 * Callers provide keyed record/artifact digests; the durable namespace only
 * owns lifecycle, correction identity, and deletion/re-import boundaries.
 */

export const CLAUDE_DESKTOP_SHADOW_STORE_VERSION =
  "claude-desktop-shadow-store-v0.1";
export const CLAUDE_DESKTOP_SHADOW_PROVIDER = "anthropic_claude_code";

export const CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES = Object.freeze([
  "ledger",
  "canonical",
  "projection",
  "cache",
  "checkpoint",
  "wal",
  "shm",
  "journal",
  "backup",
  "sidecar",
]);

// Quota has its own production-owned state and canonical/checkpoint material
// is represented only as closed logical artifacts. The shadow record table is
// therefore usage-only at the storage boundary, not merely by convention.
const RECORD_KINDS = new Set(["usage"]);
const LOGICAL_ARTIFACT_KINDS = new Set(["canonical", "projection", "cache", "checkpoint"]);
const PHYSICAL_ARTIFACT_CLASSES = new Set(CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES);
const HEX_KEY = /^[a-f0-9]{64}$/u;
const MAXIMUM_BATCH = 100_000;
const MAXIMUM_ARTIFACTS = 10_000;

export class ClaudeDesktopShadowStoreError extends Error {
  constructor(code) {
    super(`Claude Desktop shadow store failed (${code})`);
    this.name = "ClaudeDesktopShadowStoreError";
    this.code = `claude_desktop_shadow_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopShadowStoreError(code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTimestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("timestamp");
  return value;
}

function safePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("integer");
  return value;
}

function safeKey(value, code = "key") {
  if (typeof value !== "string" || !HEX_KEY.test(value)) fail(code);
  return value;
}

function safeEnum(value, values, code) {
  if (typeof value !== "string" || !values.has(value)) fail(code);
  return value;
}

function safeProvider(value) {
  if (value !== CLAUDE_DESKTOP_SHADOW_PROVIDER) fail("provider");
  return value;
}

function safeAbsolutePath(value, code = "configuration") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !isAbsolute(value)) fail(code);
  return resolve(value);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwnerOnlyDirectory(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail("state_parent");
  }
  const uid = currentUid();
  if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== null && stats.uid !== uid)
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("state_parent");
  }
}

function assertOwnerOnlyFile(path, { missingAllowed = false } = {}) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (missingAllowed && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return null;
    fail("state_file");
  }
  const uid = currentUid();
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (uid !== null && stats.uid !== uid)
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("state_file");
  }
  return stats;
}

function ensureStatePath(path) {
  const parent = dirname(path);
  assertOwnerOnlyDirectory(parent);
  const existing = assertOwnerOnlyFile(path, { missingAllowed: true });
  if (existing) return;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(descriptor);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    fail("state_file");
  }
  assertOwnerOnlyFile(path);
}

function configure(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA secure_delete = ON;
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS shadow_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS shadow_record (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      kind TEXT NOT NULL CHECK(kind = 'usage'),
      source_generation INTEGER NOT NULL CHECK(source_generation >= 1),
      event_time_ms INTEGER NOT NULL CHECK(event_time_ms >= 0),
      record_key TEXT NOT NULL CHECK(length(record_key) = 64),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
      PRIMARY KEY(provider, kind, source_generation, event_time_ms, record_key, revision)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS shadow_artifact (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      kind TEXT NOT NULL CHECK(kind IN ('canonical', 'projection', 'cache', 'checkpoint')),
      source_generation INTEGER NOT NULL CHECK(source_generation >= 1),
      event_time_ms INTEGER NOT NULL CHECK(event_time_ms >= -1),
      artifact_key TEXT NOT NULL CHECK(length(artifact_key) = 64),
      artifact_digest TEXT NOT NULL CHECK(length(artifact_digest) = 64),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      PRIMARY KEY(provider, kind, source_generation, event_time_ms, artifact_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS shadow_tombstone (
      tombstone_key TEXT PRIMARY KEY CHECK(length(tombstone_key) = 64),
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      source_generation INTEGER CHECK(source_generation IS NULL OR source_generation >= 1),
      start_at_ms INTEGER CHECK(start_at_ms IS NULL OR start_at_ms >= 0),
      end_at_ms INTEGER CHECK(end_at_ms IS NULL OR end_at_ms >= 0),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      CHECK(start_at_ms IS NULL OR end_at_ms IS NULL OR end_at_ms >= start_at_ms)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS shadow_purge_receipt (
      receipt_key TEXT PRIMARY KEY CHECK(length(receipt_key) = 64),
      tombstone_key TEXT NOT NULL REFERENCES shadow_tombstone(tombstone_key),
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      logical_records_deleted INTEGER NOT NULL CHECK(logical_records_deleted >= 0),
      logical_artifacts_deleted INTEGER NOT NULL CHECK(logical_artifacts_deleted >= 0),
      physical_removed INTEGER NOT NULL CHECK(physical_removed >= 0),
      physical_missing INTEGER NOT NULL CHECK(physical_missing >= 0),
      physical_failed INTEGER NOT NULL CHECK(physical_failed >= 0),
      physical_classes_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('purged', 'partial'))
    ) STRICT, WITHOUT ROWID;
  `);
  database.prepare("INSERT OR REPLACE INTO shadow_meta(key, value) VALUES ('schema_version', ?)")
    .run(CLAUDE_DESKTOP_SHADOW_STORE_VERSION);
  database.prepare("INSERT OR REPLACE INTO shadow_meta(key, value) VALUES ('provider', ?)")
    .run(CLAUDE_DESKTOP_SHADOW_PROVIDER);
  database.prepare("INSERT OR REPLACE INTO shadow_meta(key, value) VALUES ('local_only', 'true')")
    .run();
  database.prepare("INSERT OR REPLACE INTO shadow_meta(key, value) VALUES ('ui_enabled', 'false')")
    .run();
  database.prepare("INSERT OR REPLACE INTO shadow_meta(key, value) VALUES ('upload_enabled', 'false')")
    .run();
}

function validateExactKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function normalizeRecord(value, acceptedAtMs) {
  validateExactKeys(value, new Set([
    "provider",
    "kind",
    "sourceGeneration",
    "eventTimeMs",
    "recordKey",
    "payloadDigest",
    "revision",
  ]), "record");
  if (Object.hasOwn(value, "provider")) safeProvider(value.provider);
  return {
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    kind: safeEnum(value.kind, RECORD_KINDS, "record_kind"),
    sourceGeneration: safePositiveInteger(value.sourceGeneration),
    eventTimeMs: safeTimestamp(value.eventTimeMs),
    recordKey: safeKey(value.recordKey),
    payloadDigest: safeKey(value.payloadDigest, "digest"),
    revision: safePositiveInteger(value.revision ?? 1),
    acceptedAtMs,
  };
}

function normalizeLogicalArtifact(value, updatedAtMs) {
  validateExactKeys(value, new Set([
    "provider",
    "kind",
    "sourceGeneration",
    "eventTimeMs",
    "artifactKey",
    "artifactDigest",
  ]), "artifact");
  if (Object.hasOwn(value, "provider")) safeProvider(value.provider);
  const eventTimeMs = value.eventTimeMs === undefined || value.eventTimeMs === null
    ? -1 : safeTimestamp(value.eventTimeMs);
  return {
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    kind: safeEnum(value.kind, LOGICAL_ARTIFACT_KINDS, "artifact_kind"),
    sourceGeneration: safePositiveInteger(value.sourceGeneration),
    eventTimeMs,
    artifactKey: safeKey(value.artifactKey),
    artifactDigest: safeKey(value.artifactDigest, "digest"),
    updatedAtMs,
  };
}

function normalizeScope(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("purge");
  validateExactKeys(options, new Set([
    "sourceGeneration",
    "startAtMs",
    "endAtMs",
    "createdAtMs",
    "artifactRoot",
    "artifactRoots",
    "artifacts",
  ]), "purge");
  const sourceGeneration = options.sourceGeneration === undefined
    || options.sourceGeneration === null
    ? null : safePositiveInteger(options.sourceGeneration);
  const startAtMs = options.startAtMs === undefined || options.startAtMs === null
    ? null : safeTimestamp(options.startAtMs);
  const endAtMs = options.endAtMs === undefined || options.endAtMs === null
    ? null : safeTimestamp(options.endAtMs);
  if (startAtMs === null && endAtMs === null) {
    // An unbounded provider/source-generation purge is intentional and is the
    // only scope that can invalidate records whose event time is unknown.
  } else if (startAtMs !== null && endAtMs !== null && endAtMs < startAtMs) {
    fail("purge");
  }
  const roots = [];
  if (options.artifactRoot !== undefined && options.artifactRoot !== null) {
    roots.push(safeAbsolutePath(options.artifactRoot, "artifact_root"));
  }
  if (options.artifactRoots !== undefined) {
    if (!Array.isArray(options.artifactRoots)) fail("artifact_root");
    roots.push(...options.artifactRoots.map((path) => safeAbsolutePath(path, "artifact_root")));
  }
  const uniqueRoots = [...new Set(roots)];
  uniqueRoots.forEach(assertOwnerOnlyDirectory);
  if (options.artifacts !== undefined && !Array.isArray(options.artifacts)) fail("artifacts");
  const artifacts = options.artifacts ?? [];
  if (artifacts.length > MAXIMUM_ARTIFACTS) fail("artifacts");
  return {
    sourceGeneration,
    startAtMs,
    endAtMs,
    createdAtMs: safeTimestamp(options.createdAtMs ?? Date.now()),
    roots: uniqueRoots,
    artifacts,
  };
}

function pathWithin(root, path) {
  const result = relative(root, path);
  return result !== "" && result !== ".." && !result.startsWith(`..${sep}`)
    && !isAbsolute(result);
}

function pathWithinOrRoot(root, path) {
  return path === root || pathWithin(root, path);
}

function validatePhysicalArtifacts(scope, { protectedPaths = [] } = {}) {
  if (scope.artifacts.length === 0) return [];
  if (scope.roots.length === 0) fail("artifact_root");
  const seen = new Set();
  const protectedSet = new Set(protectedPaths);
  return scope.artifacts.map((value) => {
    validateExactKeys(value, new Set(["kind", "path"]), "artifact");
    const kind = safeEnum(value.kind, PHYSICAL_ARTIFACT_CLASSES, "artifact_kind");
    const path = safeAbsolutePath(value.path, "artifact_path");
    if (protectedSet.has(path)) fail("artifact_protected");
    if (seen.has(path)) fail("artifact_duplicate");
    seen.add(path);
    const root = scope.roots.find((candidate) => pathWithin(candidate, path));
    if (!root) fail("artifact_path");
    let stats = null;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") fail("artifact_path");
    }
    let parentReal;
    try {
      parentReal = realpathSync(dirname(path));
    } catch {
      fail("artifact_path");
    }
    if (!pathWithinOrRoot(realpathSync(root), parentReal)) fail("artifact_path");
    assertOwnerOnlyDirectory(parentReal);
    if (stats) {
      const uid = currentUid();
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
          || (uid !== null && stats.uid !== uid)
          || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
        fail("artifact_path");
      }
    }
    return { kind, path, root };
  });
}

function tombstoneMatches(database, {
  sourceGeneration,
  eventTimeMs,
}) {
  // Unknown-time artifacts (checkpoints, projections, and caches) are blocked
  // by any matching provider/source tombstone. They are generation-scoped
  // derived state, so allowing one back in after a bounded purge could
  // resurrect the purged interval through a projection even though no event
  // row was re-imported.
  if (eventTimeMs === null || eventTimeMs === -1) {
    return Boolean(database.prepare(`
      SELECT 1 FROM shadow_tombstone
      WHERE provider = ?
        AND (source_generation IS NULL OR source_generation = ?)
      LIMIT 1
    `).get(CLAUDE_DESKTOP_SHADOW_PROVIDER, sourceGeneration));
  }
  return Boolean(database.prepare(`
    SELECT 1 FROM shadow_tombstone
    WHERE provider = ?
      AND (source_generation IS NULL OR source_generation = ?)
      AND (start_at_ms IS NULL OR start_at_ms <= ?)
      AND (end_at_ms IS NULL OR end_at_ms >= ?)
    LIMIT 1
  `).get(
    CLAUDE_DESKTOP_SHADOW_PROVIDER,
    sourceGeneration,
    eventTimeMs,
    eventTimeMs,
  ));
}

function deleteScope(database, scope) {
  const provider = CLAUDE_DESKTOP_SHADOW_PROVIDER;
  const generationWhere = "(source_generation = ? OR ? IS NULL)";
  const generationArgs = [scope.sourceGeneration, scope.sourceGeneration];
  const bounded = scope.startAtMs !== null || scope.endAtMs !== null;
  const recordWhere = bounded
    ? "event_time_ms >= COALESCE(?, 0) AND event_time_ms <= COALESCE(?, 9223372036854775807)"
    : "1 = 1";
  const recordArgs = bounded ? [scope.startAtMs, scope.endAtMs] : [];
  let logicalRecordsDeleted = 0;
  for (const kind of RECORD_KINDS) {
    logicalRecordsDeleted += Number(database.prepare(`
      DELETE FROM shadow_record
      WHERE provider = ? AND kind = ? AND ${generationWhere} AND ${recordWhere}
    `).run(provider, kind, ...generationArgs, ...recordArgs).changes);
  }
  // A projection/cache/checkpoint has no useful independent meaning once any
  // part of its source generation is purged. Unknown-time artifacts therefore
  // disappear for a bounded source purge too; this is intentional cache
  // invalidation, not deletion of an event outside the selected interval.
  const artifactWhere = bounded
    ? "(event_time_ms = -1 OR (event_time_ms >= COALESCE(?, 0) AND event_time_ms <= COALESCE(?, 9223372036854775807)))"
    : "1 = 1";
  const artifactArgs = bounded ? [scope.startAtMs, scope.endAtMs] : [];
  const logicalArtifactsDeleted = Number(database.prepare(`
    DELETE FROM shadow_artifact
    WHERE provider = ? AND ${generationWhere} AND ${artifactWhere}
  `).run(provider, ...generationArgs, ...artifactArgs).changes);
  return { logicalRecordsDeleted, logicalArtifactsDeleted };
}

function emptyPhysicalClassCounts() {
  return Object.fromEntries(CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES.map((kind) => [kind, 0]));
}

function deletePhysicalArtifacts(artifacts) {
  const classCounts = emptyPhysicalClassCounts();
  let physicalRemoved = 0;
  let physicalMissing = 0;
  let physicalFailed = 0;
  for (const artifact of artifacts) {
    try {
      const stats = lstatSync(artifact.path);
      const parentReal = realpathSync(dirname(artifact.path));
      if (!pathWithinOrRoot(realpathSync(artifact.root), parentReal)) {
        physicalFailed += 1;
        continue;
      }
      const uid = currentUid();
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
          || (uid !== null && stats.uid !== uid)
          || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
        physicalFailed += 1;
        continue;
      }
      unlinkSync(artifact.path);
      classCounts[artifact.kind] += 1;
      physicalRemoved += 1;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") physicalMissing += 1;
      else physicalFailed += 1;
    }
  }
  return { classCounts, physicalRemoved, physicalMissing, physicalFailed };
}

function disabledStore() {
  const status = {
    schemaVersion: CLAUDE_DESKTOP_SHADOW_STORE_VERSION,
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    status: "disabled",
    enabled: false,
    localOnly: true,
    uiEnabled: false,
    uploadEnabled: false,
  };
  return {
    status: () => ({ ...status }),
    snapshot: () => ({ ...status, counts: { records: 0, artifacts: 0, tombstones: 0, receipts: 0 } }),
    readPurgeReceipts: () => [],
    purgeReceipts: () => [],
    ingest: () => ({ status: "disabled", inserted: 0, duplicates: 0, tombstoned: 0 }),
    putArtifact: () => ({ status: "disabled", inserted: 0, duplicate: false, tombstoned: 0 }),
    purge: () => ({ status: "disabled", logicalRecordsDeleted: 0, logicalArtifactsDeleted: 0 }),
    close: () => {},
  };
}

export function openClaudeDesktopShadowStore({
  statePath,
  enabled = false,
  localOnly = true,
  uiEnabled = false,
  uploadEnabled = false,
} = {}) {
  if (localOnly !== true || uiEnabled !== false || uploadEnabled !== false) {
    fail("local_only");
  }
  if (enabled !== true) return disabledStore();
  const path = safeAbsolutePath(statePath);
  ensureStatePath(path);
  let database;
  try {
    database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    assertOwnerOnlyFile(path);
    configure(database);
  } catch (error) {
    database?.close();
    if (error instanceof ClaudeDesktopShadowStoreError) throw error;
    fail("state_open");
  }
  let closed = false;
  const ensureOpen = () => {
    if (closed) fail("closed");
  };
  const storeStatus = () => ({
    schemaVersion: CLAUDE_DESKTOP_SHADOW_STORE_VERSION,
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    status: "enabled",
    enabled: true,
    localOnly: true,
    uiEnabled: false,
    uploadEnabled: false,
  });
  const readPurgeReceipts = () => {
    ensureOpen();
    return database.prepare(`
      SELECT receipt_key, tombstone_key, provider, created_at_ms,
             logical_records_deleted, logical_artifacts_deleted,
             physical_removed, physical_missing, physical_failed,
             physical_classes_json, status
      FROM shadow_purge_receipt WHERE provider = ? ORDER BY created_at_ms, receipt_key
    `).all(CLAUDE_DESKTOP_SHADOW_PROVIDER).map((row) => ({
      receiptKey: row.receipt_key,
      tombstoneKey: row.tombstone_key,
      provider: row.provider,
      createdAtMs: Number(row.created_at_ms),
      logicalRecordsDeleted: Number(row.logical_records_deleted),
      logicalArtifactsDeleted: Number(row.logical_artifacts_deleted),
      physicalRemoved: Number(row.physical_removed),
      physicalMissing: Number(row.physical_missing),
      physicalFailed: Number(row.physical_failed),
      physicalClasses: JSON.parse(row.physical_classes_json),
      status: row.status,
    }));
  };

  return {
    status() {
      ensureOpen();
      return storeStatus();
    },

    snapshot() {
      ensureOpen();
      const recordCount = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM shadow_record WHERE provider = ?",
      ).get(CLAUDE_DESKTOP_SHADOW_PROVIDER).count);
      const artifactCount = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM shadow_artifact WHERE provider = ?",
      ).get(CLAUDE_DESKTOP_SHADOW_PROVIDER).count);
      const tombstoneCount = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM shadow_tombstone WHERE provider = ?",
      ).get(CLAUDE_DESKTOP_SHADOW_PROVIDER).count);
      const receiptCount = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM shadow_purge_receipt WHERE provider = ?",
      ).get(CLAUDE_DESKTOP_SHADOW_PROVIDER).count);
      const byKind = Object.fromEntries([...RECORD_KINDS].map((kind) => [
        kind,
        Number(database.prepare(
          "SELECT COUNT(*) AS count FROM shadow_record WHERE provider = ? AND kind = ?",
        ).get(CLAUDE_DESKTOP_SHADOW_PROVIDER, kind).count),
      ]));
      return {
        ...storeStatus(),
        counts: { records: recordCount, artifacts: artifactCount, tombstones: tombstoneCount, receipts: receiptCount },
        recordsByKind: byKind,
      };
    },

    readPurgeReceipts() {
      return readPurgeReceipts();
    },

    purgeReceipts() {
      return readPurgeReceipts();
    },

    ingest(records, { acceptedAtMs = Date.now() } = {}) {
      ensureOpen();
      if (!Array.isArray(records) || records.length > MAXIMUM_BATCH) fail("record");
      const accepted = safeTimestamp(acceptedAtMs);
      const normalized = records.map((record) => normalizeRecord(record, accepted));
      let inserted = 0;
      let duplicates = 0;
      let tombstoned = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const record of normalized) {
          if (tombstoneMatches(database, {
            sourceGeneration: record.sourceGeneration,
            eventTimeMs: record.eventTimeMs,
          })) {
            tombstoned += 1;
            continue;
          }
          const prior = database.prepare(`
            SELECT payload_digest FROM shadow_record
            WHERE provider = ? AND kind = ? AND source_generation = ?
              AND event_time_ms = ? AND record_key = ? AND revision = ?
          `).get(
            record.provider,
            record.kind,
            record.sourceGeneration,
            record.eventTimeMs,
            record.recordKey,
            record.revision,
          );
          if (prior) {
            if (prior.payload_digest !== record.payloadDigest) fail("record_conflict");
            duplicates += 1;
            continue;
          }
          database.prepare(`
            INSERT INTO shadow_record(
              provider, kind, source_generation, event_time_ms, record_key,
              payload_digest, revision, accepted_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            record.provider,
            record.kind,
            record.sourceGeneration,
            record.eventTimeMs,
            record.recordKey,
            record.payloadDigest,
            record.revision,
            record.acceptedAtMs,
          );
          inserted += 1;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: "enabled", inserted, duplicates, tombstoned };
    },

    putArtifact(value, { updatedAtMs = Date.now() } = {}) {
      ensureOpen();
      const artifact = normalizeLogicalArtifact(value, safeTimestamp(updatedAtMs));
      let inserted = 0;
      let duplicate = false;
      let tombstoned = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        if (tombstoneMatches(database, {
          sourceGeneration: artifact.sourceGeneration,
          eventTimeMs: artifact.eventTimeMs,
        })) {
          tombstoned = 1;
        } else {
          const prior = database.prepare(`
            SELECT artifact_digest FROM shadow_artifact
            WHERE provider = ? AND kind = ? AND source_generation = ?
              AND event_time_ms = ? AND artifact_key = ?
          `).get(
            artifact.provider,
            artifact.kind,
            artifact.sourceGeneration,
            artifact.eventTimeMs,
            artifact.artifactKey,
          );
          if (prior) {
            if (prior.artifact_digest !== artifact.artifactDigest) fail("artifact_conflict");
            duplicate = true;
          } else {
            database.prepare(`
              INSERT INTO shadow_artifact(
                provider, kind, source_generation, event_time_ms,
                artifact_key, artifact_digest, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              artifact.provider,
              artifact.kind,
              artifact.sourceGeneration,
              artifact.eventTimeMs,
              artifact.artifactKey,
              artifact.artifactDigest,
              artifact.updatedAtMs,
            );
            inserted = 1;
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: "enabled", inserted, duplicate, tombstoned };
    },

    purge(options = {}) {
      ensureOpen();
      const scope = normalizeScope(options);
      const artifacts = validatePhysicalArtifacts(scope, { protectedPaths: [path] });
      const tombstoneKey = sha256(stableJson({
        provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
        sourceGeneration: scope.sourceGeneration,
        startAtMs: scope.startAtMs,
        endAtMs: scope.endAtMs,
      }));
      const receiptKey = sha256(stableJson({ tombstoneKey, createdAtMs: scope.createdAtMs }));
      const completedReplay = readPurgeReceipts().find((receipt) => (
        receipt.receiptKey === receiptKey && receipt.status === "purged"
      ));
      if (completedReplay) return completedReplay;
      let deleted;
      const pendingPhysicalClasses = emptyPhysicalClassCounts();
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT OR IGNORE INTO shadow_tombstone(
            tombstone_key, provider, source_generation, start_at_ms, end_at_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          tombstoneKey,
          CLAUDE_DESKTOP_SHADOW_PROVIDER,
          scope.sourceGeneration,
          scope.startAtMs,
          scope.endAtMs,
          scope.createdAtMs,
        );
        deleted = deleteScope(database, scope);
        // Persist an incomplete receipt before touching external files. If the
        // process crashes after unlinking a sidecar but before the outcome
        // update, reopening the DB still exposes a durable partial receipt and
        // a stable tombstone for a retry.
        database.prepare(`
          INSERT INTO shadow_purge_receipt(
            receipt_key, tombstone_key, provider, created_at_ms,
            logical_records_deleted, logical_artifacts_deleted,
            physical_removed, physical_missing, physical_failed,
            physical_classes_json, status
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'partial')
          ON CONFLICT(receipt_key) DO UPDATE SET
            created_at_ms = excluded.created_at_ms,
            logical_records_deleted = excluded.logical_records_deleted,
            logical_artifacts_deleted = excluded.logical_artifacts_deleted,
            physical_removed = 0,
            physical_missing = 0,
            physical_failed = 0,
            physical_classes_json = excluded.physical_classes_json,
            status = 'partial'
        `).run(
          receiptKey,
          tombstoneKey,
          CLAUDE_DESKTOP_SHADOW_PROVIDER,
          scope.createdAtMs,
          deleted.logicalRecordsDeleted,
          deleted.logicalArtifactsDeleted,
          stableJson(pendingPhysicalClasses),
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const physical = deletePhysicalArtifacts(artifacts);
      const status = physical.physicalFailed > 0 ? "partial" : "purged";
      const receipt = {
        receiptKey,
        tombstoneKey,
        provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
        createdAtMs: scope.createdAtMs,
        logicalRecordsDeleted: deleted.logicalRecordsDeleted,
        logicalArtifactsDeleted: deleted.logicalArtifactsDeleted,
        physicalRemoved: physical.physicalRemoved,
        physicalMissing: physical.physicalMissing,
        physicalFailed: physical.physicalFailed,
        physicalClasses: physical.classCounts,
        status,
      };
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO shadow_purge_receipt(
            receipt_key, tombstone_key, provider, created_at_ms,
            logical_records_deleted, logical_artifacts_deleted,
            physical_removed, physical_missing, physical_failed,
            physical_classes_json, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(receipt_key) DO UPDATE SET
            created_at_ms = excluded.created_at_ms,
            logical_records_deleted = excluded.logical_records_deleted,
            logical_artifacts_deleted = excluded.logical_artifacts_deleted,
            physical_removed = excluded.physical_removed,
            physical_missing = excluded.physical_missing,
            physical_failed = excluded.physical_failed,
            physical_classes_json = excluded.physical_classes_json,
            status = excluded.status
        `).run(
          receipt.receiptKey,
          receipt.tombstoneKey,
          receipt.provider,
          receipt.createdAtMs,
          receipt.logicalRecordsDeleted,
          receipt.logicalArtifactsDeleted,
          receipt.physicalRemoved,
          receipt.physicalMissing,
          receipt.physicalFailed,
          stableJson(receipt.physicalClasses),
          receipt.status,
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return receipt;
    },

    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

export const createClaudeDesktopShadowStore = openClaudeDesktopShadowStore;
