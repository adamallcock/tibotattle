import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  stableJson,
  syncDirectory,
  truncateDurably,
  unlinkDurably,
} from "./storage.js";
import { readBoundedUtf8LineEntries } from "./platform/index.js";

// This database is deliberately the one durable owner-controlled store for
// local collector facts, cursors, quota observations and derived accounting.
// Raw Codex rollout JSONL is input owned by Codex, not application state.
export const LOCAL_COLLECTOR_STATE_SCHEMA_VERSION =
  "local-collector-state-v1";
export const LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION =
  "local-collector-legacy-refresh-use-v1";
export const LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX = 1_000_000;

const STATE_APPLICATION_ID = 0x554d4353;
const STATE_USER_VERSION = 1;
const MAX_LEGACY_RECORD_BYTES = 16 * 1024 * 1024;
// The old append-only collector ledger was only ever intended as a bounded
// transitional store. Keep a deliberately generous ceiling for a one-time
// import, but never let a malformed or unexpectedly huge legacy file turn a
// startup migration into an unbounded read/write transaction.
const MAX_LEGACY_COLLECTOR_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
const MAX_LEGACY_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_LEGACY_ACCOUNTING_BYTES = 64 * 1024 * 1024;
const MAX_LEGACY_LOCK_BYTES = 16 * 1024;
const MAX_MIGRATION_LEASE_BYTES = 16 * 1024;
const MIGRATION_LEASE_WAIT_MS = 30_000;
const MIGRATION_LEASE_RETRY_INITIAL_MS = 25;
const MIGRATION_LEASE_RETRY_MAX_MS = 250;
const MAX_EVENT_KEY_LENGTH = 512;
export const LOCAL_COLLECTOR_STATE_REVIEW_FILE_BYTES = 512 * 1024 * 1024;
export const LOCAL_COLLECTOR_STATE_REVIEW_RECORDS = 1_000_000;
const MANAGED_LEGACY_BASENAMES = new Set([
  "collector-events.jsonl",
  "collector-events.jsonl.projection-v1.json",
  "collector-checkpoint-v0.3.json",
  "collector-checkpoint-v0.3.json.batch-journal",
  "collector.lock",
  "local-replay-safe-accounting-v0.1.json",
  "local-replay-safe-accounting-v0.2.json",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerOnlyRegularFile(metadata) {
  return metadata?.isFile?.()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function sameFileIdentity(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validIso(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function emptyLegacyRefreshUse() {
  return {
    schemaVersion: LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION,
    sourceMode: "legacy",
    attempts: 0,
    saturated: false,
    lastAttemptedAt: null,
  };
}

function normalizeLegacyRefreshUse(value) {
  if (value === null) return emptyLegacyRefreshUse();
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
      || (value.lastAttemptedAt !== null && !validIso(value.lastAttemptedAt))) {
    throw fixedError("local_collector_state_corrupt");
  }
  return {
    schemaVersion: LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION,
    sourceMode: "legacy",
    attempts: value.attempts,
    saturated: value.saturated,
    lastAttemptedAt: value.lastAttemptedAt,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function recordDigest(record) {
  return sha256(stableJson(record));
}

function recordEventKey(record) {
  const value = record?.eventKey;
  return typeof value === "string"
      && value.length > 0
      && value.length <= MAX_EVENT_KEY_LENGTH
    ? value
    : null;
}

function recordObservedAt(record) {
  const observedAt = record?.observedAt;
  if (!validIso(observedAt)) return { observedAt: null, observedAtMs: null };
  return { observedAt, observedAtMs: Date.parse(observedAt) };
}

function configureDatabase(database, { readOnly = false } = {}) {
  if (!readOnly) {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
    `);
  }
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-16384;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive?.(true);
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA application_id=${STATE_APPLICATION_ID};
    PRAGMA user_version=${STATE_USER_VERSION};
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS records (
      record_id INTEGER PRIMARY KEY,
      -- The collector checkpoint owns the bounded live dedupe window. Keep
      -- historical rows non-unique here so an old append-only JSONL ledger
      -- migrates byte-for-record parity even if it contains an earlier
      -- repeated event after that window rolled over.
      event_key TEXT,
      record_digest TEXT NOT NULL CHECK(length(record_digest) = 64),
      kind TEXT NOT NULL,
      observed_at TEXT,
      observed_at_ms INTEGER,
      record_json TEXT NOT NULL,
      inserted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS records_observed_at
      ON records(observed_at_ms, record_id);
    CREATE INDEX IF NOT EXISTS records_kind_observed_at
      ON records(kind, observed_at_ms, record_id);
    CREATE INDEX IF NOT EXISTS records_event_key
      ON records(event_key, record_id);
    CREATE INDEX IF NOT EXISTS records_digest
      ON records(record_digest, record_id);
    CREATE TABLE IF NOT EXISTS instance_locks (
      name TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(`
    INSERT OR IGNORE INTO meta(key, value_json) VALUES (?, ?)
  `).run("schema_version", JSON.stringify(LOCAL_COLLECTOR_STATE_SCHEMA_VERSION));
}

function validateDatabase(database) {
  const applicationId = Number(
    database.prepare("PRAGMA application_id").get().application_id,
  );
  const userVersion = Number(
    database.prepare("PRAGMA user_version").get().user_version,
  );
  const schema = database.prepare(
    "SELECT value_json FROM meta WHERE key = 'schema_version'",
  ).get();
  if (applicationId !== STATE_APPLICATION_ID
      || userVersion !== STATE_USER_VERSION
      || schema?.value_json !== JSON.stringify(LOCAL_COLLECTOR_STATE_SCHEMA_VERSION)) {
    throw fixedError("local_collector_state_schema_invalid");
  }
}

async function assertSafeStateFile(path, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw fixedError("local_collector_state_missing");
    throw fixedError("local_collector_state_unavailable");
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw fixedError("local_collector_state_unavailable");
  }
  return metadata;
}

async function prepareStateFile(stateFile) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const existing = await assertSafeStateFile(stateFile, { allowMissing: true });
  return existing !== null;
}

function localCollectorMigrationLeasePath(stateFile) {
  return `${resolve(stateFile)}.migration.lock`;
}

async function lstatMigrationLease(path, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw fixedError("local_collector_state_migration_lease_unavailable");
  }
  if (!ownerOnlyRegularFile(metadata)
      || metadata.size > MAX_MIGRATION_LEASE_BYTES) {
    throw fixedError("local_collector_state_migration_lease_unavailable");
  }
  return metadata;
}

async function readMigrationLease(path) {
  const initial = await lstatMigrationLease(path, { allowMissing: true });
  if (initial === null) return null;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!ownerOnlyRegularFile(opened)
        || opened.size > MAX_MIGRATION_LEASE_BYTES
        || !sameFileIdentity(initial, opened)) {
      throw fixedError("local_collector_state_migration_lease_unavailable");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const completed = await handle.stat();
    if (bytesRead > opened.size
        || !sameFileIdentity(opened, completed)
        || completed.size !== opened.size) {
      throw fixedError("local_collector_state_migration_lease_unavailable");
    }
    let value;
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw fixedError("local_collector_state_migration_lease_invalid");
    }
    if (Object.keys(value ?? {}).sort().join("\0") !== "pid\0startedAt"
        || !Number.isSafeInteger(value.pid)
        || value.pid < 1
        || !validIso(value.startedAt)) {
      throw fixedError("local_collector_state_migration_lease_invalid");
    }
    return { value, metadata: completed };
  } catch (error) {
    if (error?.code?.startsWith("local_collector_state_")) throw error;
    throw fixedError("local_collector_state_migration_lease_unavailable");
  } finally {
    await handle?.close();
  }
}

async function unlinkMigrationLeaseIfUnchanged(path, expected) {
  const current = await lstatMigrationLease(path, { allowMissing: true });
  if (current === null) return false;
  if (!sameFileIdentity(current, expected)) {
    throw fixedError("local_collector_state_migration_lease_changed");
  }
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw fixedError("local_collector_state_migration_lease_unavailable");
  }
  await syncDirectory(dirname(path));
  return true;
}

async function createMigrationLease(path, clock) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(stableJson({
      pid: process.pid,
      startedAt: new Date(clock()).toISOString(),
    }), "utf8");
    await handle.sync();
    const metadata = await handle.stat();
    if (!ownerOnlyRegularFile(metadata)
        || metadata.size > MAX_MIGRATION_LEASE_BYTES) {
      throw fixedError("local_collector_state_migration_lease_unavailable");
    }
    await syncDirectory(dirname(path));
    return metadata;
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    if (error?.code?.startsWith("local_collector_state_")) throw error;
    throw fixedError("local_collector_state_migration_lease_unavailable");
  } finally {
    await handle?.close();
  }
}

async function acquireLocalCollectorMigrationLease({
  stateFile,
  clock,
  processExists = defaultLegacyProcessExists,
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof clock !== "function" || typeof processExists !== "function") {
    throw new TypeError("Local collector migration lease options are invalid");
  }
  await mkdir(dirname(resolve(stateFile)), { recursive: true, mode: 0o700 });
  const path = localCollectorMigrationLeasePath(stateFile);
  const startedAt = Date.now();
  let retryMs = MIGRATION_LEASE_RETRY_INITIAL_MS;
  for (;;) {
    let metadata;
    try {
      metadata = await createMigrationLease(path, clock);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readMigrationLease(path);
      if (existing === null) continue;
      if (!processExists(existing.value.pid)) {
        await unlinkMigrationLeaseIfUnchanged(path, existing.metadata);
        continue;
      }
      if (Date.now() - startedAt >= MIGRATION_LEASE_WAIT_MS) {
        throw fixedError("local_collector_state_migration_busy");
      }
      await delay(retryMs);
      retryMs = Math.min(MIGRATION_LEASE_RETRY_MAX_MS, retryMs * 2);
      continue;
    }
    return async () => {
      await unlinkMigrationLeaseIfUnchanged(path, metadata);
    };
  }
}

async function withLocalCollectorMigrationLease(options, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Local collector migration callback must be a function");
  }
  const release = await acquireLocalCollectorMigrationLease(options);
  try {
    return await callback();
  } finally {
    await release();
  }
}

function openDatabase(stateFile, { readOnly = false, create = false } = {}) {
  let database;
  try {
    database = new DatabaseSync(stateFile, {
      readOnly,
      timeout: 5_000,
    });
    configureDatabase(database, { readOnly });
    if (create) initializeSchema(database);
    validateDatabase(database);
    return database;
  } catch (error) {
    if (database?.isOpen) database.close();
    if (error?.code?.startsWith("local_collector_state_")) throw error;
    throw fixedError("local_collector_state_unavailable");
  }
}

async function recoverPendingLocalCollectorRollbackJournal(stateFile) {
  const resolvedStateFile = resolve(stateFile);
  const metadata = await assertSafeStateFile(resolvedStateFile, {
    allowMissing: true,
  });
  if (metadata === null) return false;

  const journalFile = `${resolvedStateFile}-journal`;
  let journalMetadata;
  try {
    journalMetadata = await lstat(journalFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw fixedError("local_collector_state_unavailable");
  }
  if (!ownerOnlyRegularFile(journalMetadata)) {
    throw fixedError("local_collector_state_unavailable");
  }

  // A process killed during a DELETE-journal transaction leaves a valid hot
  // rollback journal. SQLite must open the database read/write once to roll it
  // back before the normal read-only startup path can inspect settled state.
  // A live writer remains protected by SQLite's own lock and timeout; an
  // unsafe journal fails closed above rather than being followed or removed.
  let database;
  try {
    database = openDatabase(resolvedStateFile, { readOnly: false });
  } finally {
    database?.close();
  }
  await syncStateFile(resolvedStateFile);
  return true;
}

async function syncStateFile(stateFile) {
  // Windows FlushFileBuffers rejects a read-only file handle with EPERM.
  // This state database is already opened read/write for every call site;
  // request the writable handle Windows requires while retaining the narrower
  // POSIX handle used by the existing durability path.
  const flags = process.platform === "win32"
    ? constants.O_RDWR
    : constants.O_RDONLY;
  const handle = await open(stateFile, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(stateFile));
}

async function ensureDatabase(stateFile) {
  const exists = await prepareStateFile(stateFile);
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: false, create: !exists });
  } finally {
    database?.close();
  }
  await chmod(stateFile, 0o600);
  await syncStateFile(stateFile);
}

function readMeta(database, key) {
  const row = database.prepare(
    "SELECT value_json FROM meta WHERE key = ?",
  ).get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    throw fixedError("local_collector_state_corrupt");
  }
}

function writeMeta(database, key, value) {
  database.prepare(`
    INSERT INTO meta(key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
  `).run(key, stableJson(value));
}

function recordInsertStatement(database) {
  return database.prepare(`
    INSERT INTO records(
      event_key, record_digest, kind, observed_at, observed_at_ms,
      record_json, inserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
}

function insertRecord(insert, record, insertedAt) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("collector record must be an object");
  }
  const { observedAt, observedAtMs } = recordObservedAt(record);
  const result = insert.run(
    recordEventKey(record),
    recordDigest(record),
    typeof record.kind === "string" ? record.kind : "unknown",
    observedAt,
    observedAtMs,
    stableJson(record),
    insertedAt,
  );
  return Number(result.changes ?? 0);
}

function insertRecords(database, records, insertedAt) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const insert = recordInsertStatement(database);
  let written = 0;
  for (const record of records) {
    written += insertRecord(insert, record, insertedAt);
  }
  return written;
}

function readRecords(database) {
  const records = [];
  for (const row of database.prepare(`
    SELECT record_json FROM records ORDER BY record_id ASC
  `).iterate()) {
    try {
      records.push(JSON.parse(row.record_json));
    } catch {
      throw fixedError("local_collector_state_corrupt");
    }
  }
  return records;
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function defaultLocalCollectorStatePath(root = process.cwd()) {
  return resolve(root, ".usage-monitor", "local-collector-state-v1.sqlite");
}

export function legacyLocalCollectorStatePaths(stateFile = defaultLocalCollectorStatePath()) {
  const root = dirname(resolve(stateFile));
  const collectorFile = join(root, "collector-events.jsonl");
  return Object.freeze({
    collectorFile,
    collectorProjectionFile: `${collectorFile}.projection-v1.json`,
    checkpointFile: join(root, "collector-checkpoint-v0.3.json"),
    journalFile: join(root, "collector-checkpoint-v0.3.json.batch-journal"),
    lockFile: join(root, "collector.lock"),
    // The former reader used v0.2. Prefer it when both historical cache
    // revisions happen to remain after an interrupted app upgrade.
    accountingCacheFiles: [
      join(root, "local-replay-safe-accounting-v0.2.json"),
      join(root, "local-replay-safe-accounting-v0.1.json"),
    ],
  });
}

async function legacyFileSize(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw fixedError("local_collector_state_legacy_unavailable");
    }
    return metadata.size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    if (error?.code?.startsWith("local_collector_state_")) throw error;
    throw error;
  }
}

async function digestLegacyFileSlice(path, start, length) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, length)));
    let position = start;
    let remaining = length;
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw fixedError("local_collector_state_legacy_journal_out_of_bounds");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

// The old JSON journal is read exactly once, only before importing the old
// ledger into SQLite. It is not an active writer or recovery protocol in the
// new collector.
export async function recoverLegacyCollectorBatchJournal({
  dataFile,
  checkpointFile,
  journalFile,
  truncateLedger = truncateDurably,
  removeJournal = unlinkDurably,
} = {}) {
  if (typeof dataFile !== "string" || typeof checkpointFile !== "string"
      || typeof journalFile !== "string") {
    throw new TypeError("Legacy collector journal paths are required");
  }
  const journal = await readOwnedJson(journalFile, MAX_LEGACY_CHECKPOINT_BYTES);
  if (journal === null) return { status: "none" };
  const valid = journal.schemaVersion === "0.1"
    && journal.state === "prepared"
    && Number.isSafeInteger(journal.dataStartOffset)
    && journal.dataStartOffset >= 0
    && Number.isSafeInteger(journal.payloadBytes)
    && journal.payloadBytes > 0
    && typeof journal.payloadDigest === "string"
    && /^[a-f0-9]{64}$/u.test(journal.payloadDigest)
    && typeof journal.checkpointAfterDigest === "string"
    && /^[a-f0-9]{64}$/u.test(journal.checkpointAfterDigest);
  if (!valid) throw fixedError("local_collector_state_legacy_journal_invalid");
  const durableCheckpoint = await readOwnedJson(checkpointFile, MAX_LEGACY_CHECKPOINT_BYTES);
  const checkpointCommitted = durableCheckpoint !== null
    && sha256(stableJson(durableCheckpoint)) === journal.checkpointAfterDigest;
  const size = await legacyFileSize(dataFile);
  const expectedEnd = journal.dataStartOffset + journal.payloadBytes;
  if (size < journal.dataStartOffset || size > expectedEnd) {
    throw fixedError("local_collector_state_legacy_journal_changed");
  }
  if (checkpointCommitted) {
    if (size !== expectedEnd) {
      throw fixedError("local_collector_state_legacy_journal_incomplete");
    }
    const digest = await digestLegacyFileSlice(
      dataFile,
      journal.dataStartOffset,
      journal.payloadBytes,
    );
    if (digest !== journal.payloadDigest) {
      throw fixedError("local_collector_state_legacy_journal_digest_invalid");
    }
    await removeJournal(journalFile);
    return { status: "committed_batch_retained" };
  }
  if (size === expectedEnd) {
    const digest = await digestLegacyFileSlice(
      dataFile,
      journal.dataStartOffset,
      journal.payloadBytes,
    );
    if (digest !== journal.payloadDigest) {
      throw fixedError("local_collector_state_legacy_journal_digest_invalid");
    }
  }
  if (size !== journal.dataStartOffset) {
    await truncateLedger(dataFile, journal.dataStartOffset);
  }
  await removeJournal(journalFile);
  return {
    status: size === journal.dataStartOffset
      ? "prepared_batch_absent"
      : "uncommitted_batch_rolled_back",
  };
}

export async function readLocalCollectorState({
  stateFile = defaultLocalCollectorStatePath(),
  includeRecords = true,
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof includeRecords !== "boolean") {
    throw new TypeError("Local collector state request is invalid");
  }
  const metadata = await assertSafeStateFile(stateFile, { allowMissing: true });
  if (metadata === null) {
    return {
      status: "missing",
      checkpoint: null,
      accountingCache: null,
      legacyRefreshUse: emptyLegacyRefreshUse(),
      migration: null,
      records: includeRecords ? [] : null,
    };
  }
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    return {
      status: "available",
      checkpoint: readMeta(database, "checkpoint"),
      accountingCache: readMeta(database, "accounting_cache"),
      legacyRefreshUse: normalizeLegacyRefreshUse(
        readMeta(database, "legacy_refresh_use"),
      ),
      migration: readMeta(database, "legacy_migration"),
      records: includeRecords ? readRecords(database) : null,
    };
  } finally {
    database?.close();
  }
}

export async function recordLocalCollectorLegacyRefreshAttempt({
  stateFile = defaultLocalCollectorStatePath(),
  clock = () => Date.now(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof clock !== "function") {
    throw new TypeError("Local legacy refresh receipt request is invalid");
  }
  const nowMs = clock();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("clock must return a finite epoch timestamp");
  }
  const lastAttemptedAt = new Date(nowMs).toISOString();
  await ensureDatabase(stateFile);
  let database;
  let receipt;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    receipt = transaction(database, () => {
      const current = normalizeLegacyRefreshUse(
        readMeta(database, "legacy_refresh_use"),
      );
      const attempts = Math.min(
        LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX,
        current.attempts + 1,
      );
      const next = {
        schemaVersion: LOCAL_COLLECTOR_LEGACY_REFRESH_USE_SCHEMA_VERSION,
        sourceMode: "legacy",
        attempts,
        saturated: attempts === LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX,
        lastAttemptedAt,
      };
      writeMeta(database, "legacy_refresh_use", next);
      return next;
    });
    database.exec("PRAGMA optimize");
  } finally {
    database?.close();
  }
  await chmod(stateFile, 0o600);
  await syncStateFile(stateFile);
  return receipt;
}

export async function readLocalCollectorLegacyRefreshUse({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  const state = await readLocalCollectorState({
    stateFile,
    includeRecords: false,
  });
  return {
    status: state.status,
    receipt: state.legacyRefreshUse,
  };
}

export async function readLocalCollectorCheckpoint({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  const state = await readLocalCollectorState({ stateFile, includeRecords: false });
  return state.checkpoint;
}

export async function readLocalCollectorRecords({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  const state = await readLocalCollectorState({ stateFile, includeRecords: true });
  return {
    status: state.status,
    records: state.records ?? [],
  };
}

// Dashboard projections process facts one at a time. This deliberately avoids
// reintroducing an unbounded in-memory JSONL replay just because the durable
// backend is SQLite.
export async function forEachLocalCollectorRecord({
  stateFile = defaultLocalCollectorStatePath(),
  onRecord,
  orderBy = "record_id",
  kinds = null,
} = {}) {
  if (typeof onRecord !== "function"
      || !["record_id", "observed_at"].includes(orderBy)
      || (kinds !== null && (!Array.isArray(kinds)
        || kinds.some((kind) => typeof kind !== "string" || kind.length < 1)))) {
    throw new TypeError("Local collector record callback must be a function");
  }
  const metadata = await assertSafeStateFile(stateFile, { allowMissing: true });
  if (metadata === null) return { status: "missing", recordCount: 0 };
  let database;
  let recordCount = 0;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    const selectedKinds = kinds === null ? null : [...new Set(kinds)];
    if (selectedKinds?.length === 0) {
      return { status: "available", recordCount: 0 };
    }
    const where = selectedKinds === null
      ? ""
      : ` WHERE kind IN (${selectedKinds.map(() => "?").join(", ")})`;
    const order = orderBy === "observed_at"
      ? " ORDER BY observed_at_ms ASC, record_id ASC"
      : " ORDER BY record_id ASC";
    const statement = database.prepare(
      `SELECT record_json FROM records${where}${order}`,
    );
    for (const row of statement.iterate(...(selectedKinds ?? []))) {
      let record;
      try {
        record = JSON.parse(row.record_json);
      } catch {
        throw fixedError("local_collector_state_corrupt");
      }
      await onRecord(record);
      recordCount += 1;
    }
    return { status: "available", recordCount };
  } finally {
    database?.close();
  }
}

function finiteDatabaseInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

// The dashboard often has an authoritative replay-safe usage projection and
// needs only current quota/tool records from the collector. These indexed
// facts retain exact whole-ledger counts and time bounds without parsing
// hundreds of thousands of usage JSON records that it will not use.
export async function readLocalCollectorRecordSummary({
  stateFile = defaultLocalCollectorStatePath(),
  maximumUsageObservedAtMs = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || !Number.isSafeInteger(maximumUsageObservedAtMs)) {
    throw new TypeError("Local collector record summary request is invalid");
  }
  const metadata = await assertSafeStateFile(stateFile, { allowMissing: true });
  if (metadata === null) {
    return {
      status: "missing",
      recordCount: 0,
      recordCounts: { usage: 0, quota: 0, tools: 0, other: 0 },
      firstObservedAtMs: null,
      latestObservedAtMs: null,
      firstUsageObservedAtMs: null,
      latestUsageObservedAtMs: null,
    };
  }
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    const row = database.prepare(`
      SELECT COUNT(*) AS record_count,
             COALESCE(SUM(CASE WHEN kind = 'codex_rollout_usage_snapshot' THEN 1 ELSE 0 END), 0)
               AS usage_count,
             COALESCE(SUM(CASE WHEN kind = 'codex_quota_snapshot' THEN 1 ELSE 0 END), 0)
               AS quota_count,
             COALESCE(SUM(CASE WHEN kind = 'codex_tool_class_event' THEN 1 ELSE 0 END), 0)
               AS tool_count,
             MIN(observed_at_ms) AS first_observed_at_ms,
             MAX(observed_at_ms) AS latest_observed_at_ms,
             MIN(CASE
               WHEN kind = 'codex_rollout_usage_snapshot'
                 AND observed_at_ms <= ?
               THEN observed_at_ms END) AS first_usage_observed_at_ms,
             MAX(CASE
               WHEN kind = 'codex_rollout_usage_snapshot'
                 AND observed_at_ms <= ?
               THEN observed_at_ms END) AS latest_usage_observed_at_ms
      FROM records
    `).get(maximumUsageObservedAtMs, maximumUsageObservedAtMs);
    const recordCount = finiteDatabaseInteger(row?.record_count);
    const usage = finiteDatabaseInteger(row?.usage_count);
    const quota = finiteDatabaseInteger(row?.quota_count);
    const tools = finiteDatabaseInteger(row?.tool_count);
    if ([recordCount, usage, quota, tools].includes(null)
        || usage + quota + tools > recordCount) {
      throw fixedError("local_collector_state_corrupt");
    }
    const nullableInteger = (value) => (
      value === null ? null : finiteDatabaseInteger(value)
    );
    const firstObservedAtMs = nullableInteger(row.first_observed_at_ms);
    const latestObservedAtMs = nullableInteger(row.latest_observed_at_ms);
    const firstUsageObservedAtMs = nullableInteger(row.first_usage_observed_at_ms);
    const latestUsageObservedAtMs = nullableInteger(row.latest_usage_observed_at_ms);
    if ([firstObservedAtMs, latestObservedAtMs,
      firstUsageObservedAtMs, latestUsageObservedAtMs].some(
      (value, index) => value === null && [
        row.first_observed_at_ms,
        row.latest_observed_at_ms,
        row.first_usage_observed_at_ms,
        row.latest_usage_observed_at_ms,
      ][index] !== null,
    )) {
      throw fixedError("local_collector_state_corrupt");
    }
    return {
      status: "available",
      recordCount,
      recordCounts: {
        usage,
        quota,
        tools,
        other: recordCount - usage - quota - tools,
      },
      firstObservedAtMs,
      latestObservedAtMs,
      firstUsageObservedAtMs,
      latestUsageObservedAtMs,
    };
  } finally {
    database?.close();
  }
}

function safeNonNegativeDifference(left, right) {
  return Number.isSafeInteger(left) && left >= 0
      && Number.isSafeInteger(right) && right >= 0
      && left >= right
    ? left - right
    : null;
}

// Exact p50/p90 values are computed by SQLite's on-disk ordering rather than
// accumulating a potentially unbounded ledger-sized JavaScript array.
export async function readLocalCollectorRolloutStalenessSummary({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1) {
    throw new TypeError("Local collector state request is invalid");
  }
  const metadata = await assertSafeStateFile(stateFile, { allowMissing: true });
  if (metadata === null) {
    return { status: "missing", recordCount: 0, p50: null, p90: null };
  }
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    const count = finiteDatabaseInteger(database.prepare(`
      SELECT COUNT(*) AS count
      FROM records
      WHERE kind = 'codex_rollout_usage_snapshot'
        AND json_type(record_json, '$.stalenessMs') IN ('integer', 'real')
    `).get()?.count);
    if (count === null) throw fixedError("local_collector_state_corrupt");
    if (count === 0) {
      return { status: "available", recordCount: 0, p50: null, p90: null };
    }
    const percentilePositions = [0.5, 0.9].map((probability) => {
      const position = (count - 1) * probability;
      return {
        probability,
        lower: Math.floor(position),
        upper: Math.ceil(position),
        weight: position - Math.floor(position),
      };
    });
    const requiredOffsets = new Set(percentilePositions.flatMap(
      ({ lower, upper }) => [lower, upper],
    ));
    const valuesByOffset = new Map();
    let offset = 0;
    for (const row of database.prepare(`
      SELECT CAST(json_extract(record_json, '$.stalenessMs') AS REAL) AS value
      FROM records
      WHERE kind = 'codex_rollout_usage_snapshot'
        AND json_type(record_json, '$.stalenessMs') IN ('integer', 'real')
      ORDER BY CAST(json_extract(record_json, '$.stalenessMs') AS REAL) ASC,
        record_id ASC
    `).iterate()) {
      if (requiredOffsets.has(offset)) {
        const value = Number(row.value);
        if (!Number.isFinite(value)) {
          throw fixedError("local_collector_state_corrupt");
        }
        valuesByOffset.set(offset, value);
        requiredOffsets.delete(offset);
        if (requiredOffsets.size === 0) break;
      }
      offset += 1;
    }
    const percentile = ({ lower, upper, weight }) => {
      const lowerValue = valuesByOffset.get(lower);
      const upperValue = valuesByOffset.get(upper);
      if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue)) {
        throw fixedError("local_collector_state_corrupt");
      }
      return lowerValue + (upperValue - lowerValue) * weight;
    };
    return {
      status: "available",
      recordCount: count,
      p50: percentile(percentilePositions[0]),
      p90: percentile(percentilePositions[1]),
    };
  } finally {
    database?.close();
  }
}

function emptyLocalCollectorStateStorageStatus() {
  return {
    status: "missing",
    fileBytes: 0,
    databaseBytes: 0,
    freePageBytes: 0,
    recordCount: 0,
    recordJsonBytes: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    accountingCacheBytes: 0,
    migrationStatus: null,
    needsReview: false,
  };
}

// A content-free size/status view for maintenance. It intentionally offers no
// compaction or deletion operation; retention remains a separately confirmed
// lifecycle decision rather than a surprise background side effect.
export async function inspectLocalCollectorStateStorage({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1) {
    throw new TypeError("Local collector state request is invalid");
  }
  const metadata = await assertSafeStateFile(stateFile, { allowMissing: true });
  if (metadata === null) return emptyLocalCollectorStateStorageStatus();
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    const pageCount = finiteDatabaseInteger(
      database.prepare("PRAGMA page_count").get()?.page_count,
    );
    const pageSize = finiteDatabaseInteger(
      database.prepare("PRAGMA page_size").get()?.page_size,
    );
    const freePages = finiteDatabaseInteger(
      database.prepare("PRAGMA freelist_count").get()?.freelist_count,
    );
    const aggregate = database.prepare(`
      SELECT
        COUNT(*) AS record_count,
        COALESCE(SUM(length(record_json)), 0) AS record_json_bytes,
        MIN(observed_at) AS first_observed_at,
        MAX(observed_at) AS last_observed_at
      FROM records
    `).get();
    const cache = database.prepare(`
      SELECT length(value_json) AS bytes
      FROM meta WHERE key = 'accounting_cache'
    `).get();
    const recordCount = finiteDatabaseInteger(aggregate?.record_count);
    const recordJsonBytes = finiteDatabaseInteger(aggregate?.record_json_bytes);
    const accountingCacheBytes = cache === undefined || cache === null
      ? 0
      : finiteDatabaseInteger(cache.bytes);
    const databaseBytes = pageCount !== null && pageSize !== null
      && pageCount <= Math.floor(Number.MAX_SAFE_INTEGER / pageSize)
      ? pageCount * pageSize
      : null;
    const freePageBytes = freePages !== null && pageSize !== null
      && freePages <= Math.floor(Number.MAX_SAFE_INTEGER / pageSize)
      ? freePages * pageSize
      : null;
    if ([recordCount, recordJsonBytes, accountingCacheBytes, databaseBytes, freePageBytes]
      .some((value) => value === null)) {
      throw fixedError("local_collector_state_corrupt");
    }
    const migration = readMeta(database, "legacy_migration");
    const migrationStatus = ["parity_verified", "complete"].includes(migration?.status)
      ? migration.status
      : null;
    return {
      status: "available",
      fileBytes: metadata.size,
      databaseBytes,
      freePageBytes,
      recordCount,
      recordJsonBytes,
      firstObservedAt: validIso(aggregate?.first_observed_at)
        ? aggregate.first_observed_at
        : null,
      lastObservedAt: validIso(aggregate?.last_observed_at)
        ? aggregate.last_observed_at
        : null,
      accountingCacheBytes,
      migrationStatus,
      needsReview: metadata.size >= LOCAL_COLLECTOR_STATE_REVIEW_FILE_BYTES
        || recordCount >= LOCAL_COLLECTOR_STATE_REVIEW_RECORDS,
    };
  } finally {
    database?.close();
  }
}

export async function planLocalCollectorStateRetention({
  stateFile = defaultLocalCollectorStatePath(),
  before,
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || !validIso(before)) {
    throw new TypeError("Collector retention planning requires a canonical --before timestamp");
  }
  const storage = await inspectLocalCollectorStateStorage({ stateFile });
  if (storage.status === "missing") {
    return {
      schemaVersion: "local-collector-retention-plan-v1",
      status: "missing",
      before,
      action: "no_changes",
      eligible: {
        recordCount: 0,
        recordJsonBytes: 0,
        firstObservedAt: null,
        lastObservedAt: null,
        digest: sha256("local-collector-retention-plan/v1\0"),
      },
      retained: { recordCount: 0, recordJsonBytes: 0 },
      guidance: "Read-only plan: it does not archive, compact, or delete collector state.",
    };
  }
  const beforeMs = Date.parse(before);
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: true });
    const aggregate = database.prepare(`
      SELECT
        COUNT(*) AS record_count,
        COALESCE(SUM(length(record_json)), 0) AS record_json_bytes,
        MIN(observed_at) AS first_observed_at,
        MAX(observed_at) AS last_observed_at
      FROM records
      WHERE observed_at_ms IS NOT NULL AND observed_at_ms < ?
    `).get(beforeMs);
    const recordCount = finiteDatabaseInteger(aggregate?.record_count);
    const recordJsonBytes = finiteDatabaseInteger(aggregate?.record_json_bytes);
    if (recordCount === null || recordJsonBytes === null) {
      throw fixedError("local_collector_state_corrupt");
    }
    const hash = createHash("sha256").update("local-collector-retention-plan/v1\0");
    for (const row of database.prepare(`
      SELECT record_id, record_digest
      FROM records
      WHERE observed_at_ms IS NOT NULL AND observed_at_ms < ?
      ORDER BY record_id ASC
    `).iterate(beforeMs)) {
      hash.update(String(row.record_id)).update("\0").update(row.record_digest).update("\n");
    }
    return {
      schemaVersion: "local-collector-retention-plan-v1",
      status: "available",
      before,
      action: "no_changes",
      eligible: {
        recordCount,
        recordJsonBytes,
        firstObservedAt: validIso(aggregate?.first_observed_at)
          ? aggregate.first_observed_at
          : null,
        lastObservedAt: validIso(aggregate?.last_observed_at)
          ? aggregate.last_observed_at
          : null,
        digest: hash.digest("hex"),
      },
      retained: {
        recordCount: safeNonNegativeDifference(storage.recordCount, recordCount),
        recordJsonBytes: safeNonNegativeDifference(storage.recordJsonBytes, recordJsonBytes),
      },
      guidance: "Read-only plan: it does not archive, compact, or delete collector state.",
    };
  } finally {
    database?.close();
  }
}

export async function commitLocalCollectorState({
  stateFile = defaultLocalCollectorStatePath(),
  checkpoint,
  records = [],
  clock = () => Date.now(),
  session = null,
} = {}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
      || typeof clock !== "function") {
    throw new TypeError("Local collector state commit is invalid");
  }
  if (!Number.isFinite(clock())) throw new TypeError("clock must return a finite epoch timestamp");
  if (session !== null) return session.commit({ checkpoint, records });
  await ensureDatabase(stateFile);
  let database;
  let result;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    const inserted = transaction(database, () => {
      const now = new Date(clock()).toISOString();
      const written = insertRecords(database, records, now);
      writeMeta(database, "checkpoint", checkpoint);
      return written;
    });
    database.exec("PRAGMA optimize");
    const quickCheck = database.prepare("PRAGMA quick_check").get();
    if (quickCheck?.quick_check !== "ok") {
      throw fixedError("local_collector_state_integrity_failed");
    }
    result = { inserted };
  } finally {
    database?.close();
  }
  await chmod(stateFile, 0o600);
  await syncStateFile(stateFile);
  return result;
}

/**
 * A multi-batch write session over one open connection.
 *
 * `PRAGMA quick_check` reads every page in the database, so its cost scales
 * with the size of the store rather than with the size of the batch. Measured
 * on the live 1.7 GB collector state it was 636-663 ms of a 754 ms batch —
 * 84% of the write path — and it ran on every one of the 1,000-record batches.
 * Moving it to once per session took a 642,609-record rebuild from 308.6s to
 * 95.0s; keeping the connection and the prepared statement open across batches
 * and syncing once at the end took it to 36.3s.
 *
 * The integrity check is not weakened, only relocated: a session that fails it
 * on close reports exactly the same error. Each batch is still its own
 * `BEGIN IMMEDIATE` transaction with `synchronous=FULL`, so an interrupted run
 * loses at most the batch in flight — the same guarantee as before.
 */
export async function openLocalCollectorStateSession({
  stateFile = defaultLocalCollectorStatePath(),
  clock = () => Date.now(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof clock !== "function") {
    throw new TypeError("Local collector state session options are invalid");
  }
  await ensureDatabase(stateFile);
  const database = openDatabase(stateFile, { readOnly: false });
  const insert = recordInsertStatement(database);
  let batches = 0;
  let inserted = 0;
  let verified = false;
  return {
    get batches() { return batches; },
    get inserted() { return inserted; },
    commit({ checkpoint, records = [] }) {
      const written = transaction(database, () => {
        const now = new Date(clock()).toISOString();
        let count = 0;
        for (const record of records) count += insertRecord(insert, record, now);
        writeMeta(database, "checkpoint", checkpoint);
        return count;
      });
      batches += 1;
      inserted += written;
      return { inserted: written };
    },
    async close({ verifyIntegrity = true } = {}) {
      try {
        // Proportionate to what the session actually did. `quick_check` reads
        // every page, so running it after a session that inserted no records
        // is not a safety property — it is a full scan of a store this run did
        // not write to. The foreground collector reconciles on a short timer,
        // and paying that on every idle cycle measured at +11.2 ms per cycle
        // (40.6 ms -> 51.8 ms median for a run with nothing to do).
        //
        // A checkpoint-only commit is still durable without it: every batch is
        // its own `synchronous=FULL` transaction, so SQLite has already synced
        // before this point.
        if (inserted > 0) {
          database.exec("PRAGMA optimize");
          if (verifyIntegrity) {
            const quickCheck = database.prepare("PRAGMA quick_check").get();
            if (quickCheck?.quick_check !== "ok") {
              throw fixedError("local_collector_state_integrity_failed");
            }
            verified = true;
          }
        }
      } finally {
        database.close();
      }
      await chmod(stateFile, 0o600);
      await syncStateFile(stateFile);
      return { batches, inserted, verified };
    },
    async abort() {
      if (!database.isOpen) return;
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

export async function saveLocalCollectorCheckpoint({
  stateFile = defaultLocalCollectorStatePath(),
  checkpoint,
  clock = () => Date.now(),
  session = null,
} = {}) {
  return commitLocalCollectorState({
    stateFile,
    checkpoint,
    records: [],
    clock,
    session,
  });
}

export async function writeLocalCollectorAccountingCache({
  stateFile = defaultLocalCollectorStatePath(),
  cache,
} = {}) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    throw new TypeError("Local collector accounting cache is invalid");
  }
  await ensureDatabase(stateFile);
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    transaction(database, () => {
      writeMeta(database, "accounting_cache", cache);
    });
    database.exec("PRAGMA optimize");
  } finally {
    database?.close();
  }
  await chmod(stateFile, 0o600);
  await syncStateFile(stateFile);
}

export async function readLocalCollectorAccountingCache({
  stateFile = defaultLocalCollectorStatePath(),
} = {}) {
  const state = await readLocalCollectorState({ stateFile, includeRecords: false });
  return {
    status: state.status,
    cache: state.accountingCache,
  };
}

async function readOwnedJson(path, maximumBytes) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size > maximumBytes
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fixedError("local_collector_state_legacy_invalid");
  }
}

async function streamOwnedLegacyRecords(path, onRecord) {
  if (typeof onRecord !== "function") {
    throw new TypeError("Legacy collector record callback must be a function");
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { recordCount: 0, malformedLines: 0, recordsDigest: sha256("") };
    }
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size > MAX_LEGACY_COLLECTOR_BYTES
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw fixedError(metadata.size > MAX_LEGACY_COLLECTOR_BYTES
      ? "local_collector_state_legacy_records_too_large"
      : "local_collector_state_legacy_unavailable");
  }
  const hash = createHash("sha256");
  let recordCount = 0;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!ownerOnlyRegularFile(opened)
        || opened.size > MAX_LEGACY_COLLECTOR_BYTES
        || !sameFileIdentity(metadata, opened)
        || opened.size !== metadata.size) {
      throw fixedError("local_collector_state_legacy_unavailable");
    }
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      maximumLineBytes: MAX_LEGACY_RECORD_BYTES,
      maximumTotalBytes: opened.size,
      highWaterMark: 64 * 1024,
      createLimitError: (limit) => fixedError(
        limit === "line_bytes"
          ? "local_collector_state_legacy_record_too_large"
          : "local_collector_state_legacy_records_too_large",
      ),
    })) {
      const line = entry.line;
      if (line.length === 0) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw fixedError("local_collector_state_legacy_records_invalid");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw fixedError("local_collector_state_legacy_records_invalid");
      }
      hash.update(stableJson(value)).update("\n");
      await onRecord(value);
      recordCount += 1;
    }
    const completed = await handle.stat();
    if (!sameFileIdentity(opened, completed)
        || completed.size !== opened.size) {
      throw fixedError("local_collector_state_legacy_changed");
    }
    return { recordCount, malformedLines: 0, recordsDigest: hash.digest("hex") };
  } catch (error) {
    if (error?.code?.startsWith("local_collector_state_")) throw error;
    throw fixedError("local_collector_state_legacy_unavailable");
  } finally {
    await handle?.close();
  }
}

function defaultLegacyProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial still proves that a process may own the old lock. Do
    // not turn an uncertain owner into a stale lock deletion.
    return error?.code !== "ESRCH";
  }
}

function storedRecordSummary(database) {
  const hash = createHash("sha256");
  let recordCount = 0;
  for (const row of database.prepare(`
    SELECT record_json FROM records ORDER BY record_id ASC
  `).iterate()) {
    hash.update(row.record_json).update("\n");
    recordCount += 1;
  }
  return { recordCount, recordsDigest: hash.digest("hex") };
}

function writableManagedLegacyPath(stateFile, path) {
  const root = dirname(resolve(stateFile));
  const target = resolve(path);
  return dirname(target) === root && MANAGED_LEGACY_BASENAMES.has(basename(target));
}

async function removeManagedLegacyPath(stateFile, path) {
  if (!writableManagedLegacyPath(stateFile, path)) return false;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || (typeof process.getuid === "function"
          && metadata.uid !== process.getuid())
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw fixedError("local_collector_state_legacy_unavailable");
    }
    await unlink(path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function uniqueLegacyCandidateNames(candidates) {
  return [...new Set(candidates.map((candidate) => basename(candidate)))].sort();
}

function receiptListsManagedLegacyCandidates(receipt, candidateNames) {
  if (!Array.isArray(receipt?.managedLegacyFiles)) return false;
  const actual = [...new Set(receipt.managedLegacyFiles)]
    .filter((value) => typeof value === "string")
    .sort();
  return actual.length === candidateNames.length
    && actual.every((value, index) => value === candidateNames[index]);
}

async function managedLegacyPathExists(stateFile, path) {
  if (!writableManagedLegacyPath(stateFile, path)) {
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  if (!ownerOnlyRegularFile(metadata)) {
    throw fixedError("local_collector_state_legacy_unavailable");
  }
  return true;
}

async function remainingManagedLegacyPaths(stateFile, candidates) {
  const remaining = [];
  for (const candidate of candidates) {
    if (await managedLegacyPathExists(stateFile, candidate)) {
      remaining.push(candidate);
    }
  }
  return remaining;
}

async function completeLegacyRetirement({
  stateFile,
  migration,
  legacyCandidates,
  removeLegacy,
  removeLegacyPath,
  clock,
}) {
  const managedLegacyFiles = uniqueLegacyCandidateNames(legacyCandidates);
  const parityVerified = {
    ...migration,
    status: "parity_verified",
    managedLegacyFiles,
    removedLegacyFiles: [...new Set((migration.removedLegacyFiles ?? [])
      .filter((value) => typeof value === "string" && managedLegacyFiles.includes(value)))],
  };
  delete parityVerified.completedAt;
  if (!removeLegacy) {
    await writeMigrationReceipt(stateFile, parityVerified);
    return parityVerified;
  }
  for (const candidate of legacyCandidates) {
    if (await removeLegacyPath(stateFile, candidate)) {
      const name = basename(candidate);
      if (!parityVerified.removedLegacyFiles.includes(name)) {
        parityVerified.removedLegacyFiles.push(name);
      }
    }
  }
  const remaining = await remainingManagedLegacyPaths(stateFile, legacyCandidates);
  if (remaining.length > 0) {
    // Preserve the durable parity receipt. A later run may retry only this
    // cleanup phase, but no result is ever labelled "complete" while a
    // managed JSON artifact still exists.
    await writeMigrationReceipt(stateFile, parityVerified);
    throw fixedError("local_collector_state_legacy_cleanup_incomplete");
  }
  const completed = {
    ...parityVerified,
    status: "complete",
    completedAt: new Date(clock()).toISOString(),
  };
  await writeMigrationReceipt(stateFile, completed);
  return completed;
}

// A legacy JSON lock can mean an older binary is still writing the JSONL
// ledger. Inspect it before importing, but leave even a stale lock in place
// until the SQLite parity receipt is durable. That preserves the same
// "verify, then retire" rule as the ledger itself.
async function inspectLegacyCollectorLock({
  lockFile,
  processExists = defaultLegacyProcessExists,
} = {}) {
  if (typeof lockFile !== "string"
      || typeof processExists !== "function") {
    throw new TypeError("Legacy collector lock inspection options are invalid");
  }
  const lock = await readOwnedJson(lockFile, MAX_LEGACY_LOCK_BYTES);
  if (lock === null) return { status: "none" };
  const exactKeys = Object.keys(lock).sort().join("\0")
    === "pid\0startedAt";
  if (!exactKeys
      || !Number.isSafeInteger(lock.pid)
      || lock.pid < 1
      || !validIso(lock.startedAt)) {
    throw fixedError("local_collector_state_legacy_lock_invalid");
  }
  if (processExists(lock.pid)) {
    throw fixedError("local_collector_state_legacy_lock_held");
  }
  return { status: "stale" };
}

async function writeMigrationReceipt(stateFile, receipt) {
  await ensureDatabase(stateFile);
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    transaction(database, () => writeMeta(database, "legacy_migration", receipt));
  } finally {
    database?.close();
  }
  await syncStateFile(stateFile);
}

// Import only verified, owner-only state. The migration is intentionally
// idempotent and leaves the legacy files in place if any parity check fails.
// Callers must hold the short-lived migration lease before entering this body.
async function migrateLegacyLocalCollectorStateUnlocked({
  stateFile = defaultLocalCollectorStatePath(),
  collectorFile = legacyLocalCollectorStatePaths(stateFile).collectorFile,
  checkpointFile = legacyLocalCollectorStatePaths(stateFile).checkpointFile,
  accountingCacheFiles = legacyLocalCollectorStatePaths(stateFile).accountingCacheFiles,
  collectorProjectionFile = legacyLocalCollectorStatePaths(stateFile).collectorProjectionFile,
  journalFile = legacyLocalCollectorStatePaths(stateFile).journalFile,
  lockFile = legacyLocalCollectorStatePaths(stateFile).lockFile,
  removeLegacy = true,
  removeLegacyPath = removeManagedLegacyPath,
  legacyProcessExists = defaultLegacyProcessExists,
  clock = () => Date.now(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof collectorFile !== "string" || typeof checkpointFile !== "string"
      || typeof collectorProjectionFile !== "string" || typeof journalFile !== "string"
      || typeof lockFile !== "string"
      || !Array.isArray(accountingCacheFiles)
      || !accountingCacheFiles.every((value) => typeof value === "string")
      || typeof removeLegacy !== "boolean" || typeof removeLegacyPath !== "function"
      || typeof legacyProcessExists !== "function"
      || typeof clock !== "function") {
    throw new TypeError("Legacy local collector migration options are invalid");
  }
  // A prepared legacy batch is ambiguous until its old transaction journal has
  // been recovered by the caller. Never delete an old ledger in that state.
  try {
    await lstat(journalFile);
    throw fixedError("local_collector_state_legacy_journal_pending");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existing = await readLocalCollectorState({ stateFile, includeRecords: false });
  await inspectLegacyCollectorLock({
    lockFile,
    processExists: legacyProcessExists,
  });
  const legacyCandidates = [
    lockFile,
    collectorFile,
    checkpointFile,
    collectorProjectionFile,
    ...accountingCacheFiles,
  ];
  if (existing.migration?.status === "complete") {
    const remaining = await remainingManagedLegacyPaths(stateFile, legacyCandidates);
    if (remaining.length === 0) {
      return existing.migration;
    }
    // A current-format completion receipt explicitly names every legacy
    // artifact it retired. If one reappears, do not mistake potentially new
    // JSON state for a safe cleanup retry.
    if (receiptListsManagedLegacyCandidates(
      existing.migration,
      uniqueLegacyCandidateNames(legacyCandidates),
    )) {
      throw fixedError("local_collector_state_legacy_reappeared");
    }
    // Older versions could incorrectly label a dry run complete. Their
    // receipt does not establish which files were intentionally retired, so
    // conservatively downgrade it to the parity stage and finish the verified
    // cleanup path rather than silently reporting migration success.
    const parityVerified = {
      ...existing.migration,
      status: "parity_verified",
      managedLegacyFiles: uniqueLegacyCandidateNames(legacyCandidates),
      removedLegacyFiles: [...(existing.migration.removedLegacyFiles ?? [])],
    };
    delete parityVerified.completedAt;
    return completeLegacyRetirement({
      stateFile,
      migration: parityVerified,
      legacyCandidates,
      removeLegacy,
      removeLegacyPath,
      clock,
    });
  }
  // Deletion is deliberately a second phase. If a process exits after the
  // parity receipt is durable, a later startup can safely finish cleanup
  // without rereading a partly deleted old ledger.
  if (existing.migration?.status === "parity_verified") {
    return completeLegacyRetirement({
      stateFile,
      migration: existing.migration,
      legacyCandidates,
      removeLegacy,
      removeLegacyPath,
      clock,
    });
  }

  const checkpoint = await readOwnedJson(checkpointFile, MAX_LEGACY_CHECKPOINT_BYTES);
  let accountingCache = null;
  for (const candidate of accountingCacheFiles) {
    const value = await readOwnedJson(candidate, MAX_LEGACY_ACCOUNTING_BYTES);
    if (value !== null) {
      accountingCache = value;
      break;
    }
  }
  await ensureDatabase(stateFile);
  let database;
  let source;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    database.exec("BEGIN IMMEDIATE");
    try {
      if (existing.checkpoint !== null && checkpoint !== null
          && stableJson(existing.checkpoint) !== stableJson(checkpoint)) {
        throw fixedError("local_collector_state_legacy_conflict");
      }
      if (existing.accountingCache !== null && accountingCache !== null
          && stableJson(existing.accountingCache) !== stableJson(accountingCache)) {
        throw fixedError("local_collector_state_legacy_conflict");
      }
      const insert = recordInsertStatement(database);
      const insertedAt = new Date(clock()).toISOString();
      source = await streamOwnedLegacyRecords(
        collectorFile,
        async (record) => insertRecord(insert, record, insertedAt),
      );
      if (checkpoint !== null) writeMeta(database, "checkpoint", checkpoint);
      if (accountingCache !== null) writeMeta(database, "accounting_cache", accountingCache);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database?.close();
  }
  await chmod(stateFile, 0o600);
  await syncStateFile(stateFile);

  const migrated = await readLocalCollectorState({ stateFile, includeRecords: false });
  let verificationDatabase;
  let stored;
  try {
    verificationDatabase = openDatabase(stateFile, { readOnly: true });
    stored = storedRecordSummary(verificationDatabase);
  } finally {
    verificationDatabase?.close();
  }
  const parity = {
    records: stored.recordCount === source.recordCount
      && stored.recordsDigest === source.recordsDigest,
    checkpoint: checkpoint === null || stableJson(migrated.checkpoint) === stableJson(checkpoint),
    accountingCache: accountingCache === null
      || stableJson(migrated.accountingCache) === stableJson(accountingCache),
  };
  if (!parity.records || !parity.checkpoint || !parity.accountingCache) {
    throw fixedError("local_collector_state_legacy_parity_failed");
  }
  const receipt = {
    status: "parity_verified",
    verifiedAt: new Date(clock()).toISOString(),
    source: {
      recordCount: source.recordCount,
      malformedLines: source.malformedLines,
      recordsDigest: source.recordsDigest,
      checkpointPresent: checkpoint !== null,
      accountingCachePresent: accountingCache !== null,
    },
    parity,
    managedLegacyFiles: uniqueLegacyCandidateNames(legacyCandidates),
    removedLegacyFiles: [],
  };
  await writeMigrationReceipt(stateFile, receipt);
  return completeLegacyRetirement({
    stateFile,
    migration: receipt,
    legacyCandidates,
    removeLegacy,
    removeLegacyPath,
    clock,
  });
}

export async function migrateLegacyLocalCollectorState(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Legacy local collector migration options are invalid");
  }
  const stateFile = options.stateFile ?? defaultLocalCollectorStatePath();
  const clock = options.clock ?? (() => Date.now());
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof clock !== "function") {
    throw new TypeError("Legacy local collector migration options are invalid");
  }
  return withLocalCollectorMigrationLease({ stateFile, clock }, () =>
    migrateLegacyLocalCollectorStateUnlocked({ ...options, stateFile, clock }),
  );
}

// Every normal product entry point calls this before reading or mutating the
// state database. It makes old JSON recovery a one-way, private migration
// detail rather than an alternate runtime storage path.
export async function prepareLocalCollectorState({
  stateFile = defaultLocalCollectorStatePath(),
  clock = () => Date.now(),
} = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || typeof clock !== "function") {
    throw new TypeError("Local collector state preparation options are invalid");
  }
  const legacyPaths = legacyLocalCollectorStatePaths(stateFile);
  await recoverPendingLocalCollectorRollbackJournal(stateFile);
  // A settled installation should not fsync a lease file on every dashboard
  // read. The receipt still has to be checked against the managed legacy
  // names, so a reappearing old artifact is never silently ignored.
  const settled = await readLocalCollectorState({
    stateFile,
    includeRecords: false,
  });
  if (settled.migration?.status === "complete"
      && (await remainingManagedLegacyPaths(stateFile, [
        legacyPaths.lockFile,
        legacyPaths.collectorFile,
        legacyPaths.checkpointFile,
        legacyPaths.collectorProjectionFile,
        ...legacyPaths.accountingCacheFiles,
      ])).length === 0) {
    return settled.migration;
  }
  return withLocalCollectorMigrationLease({ stateFile, clock }, async () => {
    await recoverLegacyCollectorBatchJournal({
      dataFile: legacyPaths.collectorFile,
      checkpointFile: legacyPaths.checkpointFile,
      journalFile: legacyPaths.journalFile,
    });
    return migrateLegacyLocalCollectorStateUnlocked({
      stateFile,
      collectorFile: legacyPaths.collectorFile,
      checkpointFile: legacyPaths.checkpointFile,
      collectorProjectionFile: legacyPaths.collectorProjectionFile,
      journalFile: legacyPaths.journalFile,
      lockFile: legacyPaths.lockFile,
      accountingCacheFiles: legacyPaths.accountingCacheFiles,
      clock,
    });
  });
}

export async function acquireLocalCollectorStateLock(
  stateFile = defaultLocalCollectorStatePath(),
  {
    clock = () => Date.now(),
    processExists = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  } = {},
) {
  if (typeof clock !== "function" || typeof processExists !== "function") {
    throw new TypeError("Local collector lock options are invalid");
  }
  await ensureDatabase(stateFile);
  let database;
  try {
    database = openDatabase(stateFile, { readOnly: false });
    transaction(database, () => {
      const existing = database.prepare(`
        SELECT pid FROM instance_locks WHERE name = 'collector'
      `).get();
      if (existing && processExists(Number(existing.pid))) {
        throw fixedError("local_collector_state_lock_held");
      }
      if (existing) database.prepare(
        "DELETE FROM instance_locks WHERE name = 'collector'",
      ).run();
      database.prepare(`
        INSERT INTO instance_locks(name, pid, acquired_at) VALUES (?, ?, ?)
      `).run("collector", process.pid, new Date(clock()).toISOString());
    });
  } finally {
    database?.close();
  }
  await syncStateFile(stateFile);
  return async () => {
    let releaseDatabase;
    try {
      await assertSafeStateFile(stateFile);
      releaseDatabase = openDatabase(stateFile, { readOnly: false });
      transaction(releaseDatabase, () => {
        releaseDatabase.prepare(`
          DELETE FROM instance_locks WHERE name = 'collector' AND pid = ?
        `).run(process.pid);
      });
    } finally {
      releaseDatabase?.close();
    }
    await syncStateFile(stateFile);
  };
}
