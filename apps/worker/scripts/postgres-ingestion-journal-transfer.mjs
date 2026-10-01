import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "./postgres-migrations.mjs";
import { POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX } from "./postgres-typed-legacy-transfer.mjs";

export const POSTGRES_INGESTION_JOURNAL_TRANSFER_SCHEMA = "sealed-d1-ingestion-journal-to-postgres-v1";
export const SEALED_SQLITE_INGESTION_JOURNAL_SCHEMA = "sealed-sqlite-d1-ingestion-journal-v1";
export const POSTGRES_INGESTION_JOURNAL_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_INGESTION_JOURNAL_MAX_PAGE_SIZE = 250;
export const POSTGRES_INGESTION_JOURNAL_TARGET_SCHEMA_PREFIX = "storage_journal_transfer_target_";

const CONTROL_RUNS = "_storage_ingestion_journal_transfer_runs_v1";
const CONTROL_CHECKPOINTS = "_storage_ingestion_journal_transfer_checkpoints_v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const TRANSFER_ID = /^synthetic-ingestion-journal-[A-Za-z0-9._-]{1,96}$/u;
const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const SOURCE_COLUMNS = Object.freeze([
  "sequence", "event_digest", "owner_digest", "revision", "kind", "object_digest",
  "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms",
]);
const ROW_COLUMNS = Object.freeze([
  "source_id", ...SOURCE_COLUMNS,
]);
const TARGET_COLUMNS = Object.freeze([
  "source_id", "sequence", "event_digest", "owner_digest", "owner_revision", "authority_epoch",
  "kind", "recorded_ms", "event_tuple_version", "revision", "object_digest", "content_digest",
  "public_authority_epoch",
]);
const ALLOWED_KINDS = Object.freeze(["source-updated", "owner-active", "owner-withdrawn", "owner-erased"]);
const TRUSTED_SOURCES = new WeakSet();

export class PostgresIngestionJournalTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresIngestionJournalTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresIngestionJournalTransferError(code);
}

function sha256() {
  return createHash("sha256");
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_INGESTION_JOURNAL_MAX_PAGE_SIZE) {
    fail("INGESTION_JOURNAL_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function validateSourceId(value) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) fail("INGESTION_JOURNAL_SOURCE_ID_INVALID");
  return value;
}

function normalizeInteger(value) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("INGESTION_JOURNAL_VALUE_INVALID");
  return parsed.toString();
}

function normalizeRow(sourceId, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INGESTION_JOURNAL_ROW_INVALID");
  const row = Object.create(null);
  row.source_id = sourceId;
  for (const column of SOURCE_COLUMNS) row[column] = raw[column];
  for (const column of ["sequence", "revision", "authority_epoch", "public_authority_epoch", "recorded_ms"]) {
    row[column] = normalizeInteger(row[column]);
  }
  if (BigInt(row.sequence) < 1n || BigInt(row.revision) < 1n || BigInt(row.authority_epoch) < 1n
      || BigInt(row.public_authority_epoch) < 1n || BigInt(row.recorded_ms) < 0n
      || !ALLOWED_KINDS.includes(row.kind)
      || ![row.event_digest, row.owner_digest, row.object_digest, row.content_digest].every(value => SHA256.test(value ?? ""))) {
    fail("INGESTION_JOURNAL_ROW_INVALID");
  }
  return Object.freeze(row);
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      fail("INGESTION_JOURNAL_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof PostgresIngestionJournalTransferError) throw error;
      fail("INGESTION_JOURNAL_SQLITE_UNAVAILABLE");
    }
  }
}

async function fingerprintSqlite(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("INGESTION_JOURNAL_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) {
      fail("INGESTION_JOURNAL_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("INGESTION_JOURNAL_SQLITE_CHANGED");
    const hash = sha256();
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("INGESTION_JOURNAL_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(opened, after)) fail("INGESTION_JOURNAL_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sqliteCount(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  const value = statement.get()?.count;
  if (typeof value !== "bigint" || value < 0n) fail("INGESTION_JOURNAL_SOURCE_INTEGRITY_INVALID");
  return value;
}

function indexColumns(database, indexName) {
  return database.prepare(`PRAGMA index_info("${indexName}")`).all().map(row => row.name);
}

function validateSqliteLayout(database) {
  const objects = database.prepare(`SELECT type,name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const actual = objects.map(row => `${row.type}:${row.name}`);
  const expected = ["index:storage_ingestion_owner_cursor", "table:storage_ingestion_changes", "table:storage_source_state"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("INGESTION_JOURNAL_SQLITE_LAYOUT_INVALID");

  const tables = database.prepare("PRAGMA table_list").all()
    .filter(row => row.schema === "main" && row.name !== "sqlite_schema" && row.name !== "sqlite_sequence");
  if (tables.length !== 2 || tables.some(row => row.type !== "table" || row.strict !== 1)) {
    fail("INGESTION_JOURNAL_SQLITE_LAYOUT_INVALID");
  }
  const expectedColumns = {
    storage_source_state: [
      ["singleton", "INTEGER", 0, 1, null], ["source_id", "TEXT", 1, 0, null],
      ["authority_epoch", "INTEGER", 1, 0, "0"],
    ],
    storage_ingestion_changes: [
      ["sequence", "INTEGER", 0, 1, null], ["event_digest", "TEXT", 1, 0, null],
      ["owner_digest", "TEXT", 1, 0, null], ["revision", "INTEGER", 1, 0, null],
      ["kind", "TEXT", 1, 0, null], ["object_digest", "TEXT", 1, 0, null],
      ["content_digest", "TEXT", 1, 0, null], ["authority_epoch", "INTEGER", 1, 0, null],
      ["public_authority_epoch", "INTEGER", 1, 0, null], ["recorded_ms", "INTEGER", 1, 0, null],
    ],
  };
  for (const [table, expectedForTable] of Object.entries(expectedColumns)) {
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
    if (columns.length !== expectedForTable.length || columns.some((column, index) => {
      const [name, type, notnull, pk, defaultValue] = expectedForTable[index];
      return column.name !== name || String(column.type).toUpperCase() !== type
        || column.notnull !== notnull || column.pk !== pk || column.dflt_value !== defaultValue;
    })) fail("INGESTION_JOURNAL_SQLITE_LAYOUT_INVALID");
  }

  const sourceIndexes = database.prepare('PRAGMA index_list("storage_source_state")').all();
  const changeIndexes = database.prepare('PRAGMA index_list("storage_ingestion_changes")').all();
  const sourceUnique = sourceIndexes.filter(index => index.unique === 1)
    .map(index => indexColumns(database, index.name));
  const changeUnique = changeIndexes.filter(index => index.unique === 1)
    .map(index => indexColumns(database, index.name)).sort((left, right) => left.join(",").localeCompare(right.join(",")));
  const ownerCursor = changeIndexes.filter(index => index.name === "storage_ingestion_owner_cursor" && index.unique === 0)
    .map(index => indexColumns(database, index.name));
  if (JSON.stringify(sourceUnique) !== JSON.stringify([["source_id"]])
      || JSON.stringify(changeUnique) !== JSON.stringify([["event_digest"], ["owner_digest", "revision"]])
      || JSON.stringify(ownerCursor) !== JSON.stringify([["owner_digest", "sequence"]])) {
    fail("INGESTION_JOURNAL_SQLITE_LAYOUT_INVALID");
  }
}

function validateSqliteRows(database, expectedSourceId) {
  const sourceStatement = database.prepare("SELECT singleton,source_id,authority_epoch FROM storage_source_state");
  sourceStatement.setReadBigInts(true);
  const source = sourceStatement.get();
  if (!source || sqliteCount(database, "SELECT count(*) AS count FROM storage_source_state") !== 1n) {
    fail("INGESTION_JOURNAL_SOURCE_IDENTITY_INVALID");
  }
  const sourceId = validateSourceId(source.source_id);
  if (source.singleton !== 1n || sourceId !== expectedSourceId) fail("INGESTION_JOURNAL_SOURCE_IDENTITY_MISMATCH");
  const sourceEpoch = normalizeInteger(source.authority_epoch);
  if (BigInt(sourceEpoch) < 0n) fail("INGESTION_JOURNAL_SOURCE_INTEGRITY_INVALID");

  const invalidRows = sqliteCount(database, `SELECT count(*) AS count FROM storage_ingestion_changes
    WHERE sequence < 1 OR revision < 1 OR authority_epoch < 1 OR public_authority_epoch < 1 OR recorded_ms < 0
       OR kind NOT IN ('source-updated','owner-active','owner-withdrawn','owner-erased')
       OR length(event_digest) <> 64 OR event_digest GLOB '*[^0-9a-f]*'
       OR length(owner_digest) <> 64 OR owner_digest GLOB '*[^0-9a-f]*'
       OR length(object_digest) <> 64 OR object_digest GLOB '*[^0-9a-f]*'
       OR length(content_digest) <> 64 OR content_digest GLOB '*[^0-9a-f]*'`);
  const invalidTransitions = sqliteCount(database, `WITH ordered AS (
      SELECT sequence,owner_digest,revision,kind,authority_epoch,public_authority_epoch,
        lag(sequence,1,0) OVER(ORDER BY sequence) AS prior_sequence,
        lag(revision,1,0) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_revision,
        lag(kind) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_kind,
        lag(authority_epoch,1,0) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_authority_epoch,
        lag(public_authority_epoch,1,0) OVER(ORDER BY sequence) AS prior_public_authority_epoch
      FROM storage_ingestion_changes
    )
    SELECT count(*) AS count FROM ordered
    WHERE sequence <> prior_sequence + 1
       OR revision <> prior_revision + 1
       OR authority_epoch <> prior_authority_epoch + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR public_authority_epoch <> prior_public_authority_epoch
          + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR (kind='source-updated' AND (prior_kind IS NULL OR prior_kind IN ('owner-withdrawn','owner-erased')))
       OR prior_kind='owner-erased'
       OR (kind IN ('owner-withdrawn','owner-erased') AND prior_kind IS NULL)`);
  const rowCount = sqliteCount(database, "SELECT count(*) AS count FROM storage_ingestion_changes");
  const boundsStatement = database.prepare(`SELECT coalesce(min(sequence),0) AS first_sequence,
      coalesce(max(sequence),0) AS last_sequence,
      coalesce((SELECT public_authority_epoch FROM storage_ingestion_changes ORDER BY sequence DESC LIMIT 1),0) AS latest_epoch
    FROM storage_ingestion_changes`);
  boundsStatement.setReadBigInts(true);
  const bounds = boundsStatement.get();
  if (invalidRows !== 0n || invalidTransitions !== 0n
      || (rowCount === 0n ? bounds.first_sequence !== 0n || bounds.last_sequence !== 0n || sourceEpoch !== "0"
        : bounds.first_sequence !== 1n || bounds.last_sequence !== rowCount
          || bounds.latest_epoch !== BigInt(sourceEpoch))) {
    fail("INGESTION_JOURNAL_SOURCE_INTEGRITY_INVALID");
  }
  return Object.freeze({ sourceId, sourceAuthorityEpoch: sourceEpoch, rowCount: rowCount.toString(),
    lastSequence: bounds.last_sequence.toString() });
}

export async function createSealedSqliteIngestionJournalSource({ path, expectedSha256, expectedSourceId } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("INGESTION_JOURNAL_SQLITE_SHA256_REQUIRED");
  const sourceId = validateSourceId(expectedSourceId);
  const initial = await fingerprintSqlite(path);
  if (initial.sha256 !== expectedSha256) fail("INGESTION_JOURNAL_SQLITE_SHA256_MISMATCH");
  let database;
  let sourceInfo;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("INGESTION_JOURNAL_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("INGESTION_JOURNAL_SQLITE_INTEGRITY_FAILED");
    }
    validateSqliteLayout(database);
    sourceInfo = validateSqliteRows(database, sourceId);
  } catch (error) {
    database?.close();
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_SQLITE_INVALID");
  }
  const statement = database.prepare(`SELECT ${SOURCE_COLUMNS.map(column => `"${column}"`).join(",")}
    FROM storage_ingestion_changes WHERE sequence > ? ORDER BY sequence LIMIT ?`);
  statement.setReadBigInts(true);
  const snapshot = Object.freeze({ kind: "sealed-sqlite-ingestion-journal", snapshotId: `sha256:${expectedSha256}`,
    artifactSha256: expectedSha256, sourceId, sourceAuthorityEpoch: sourceInfo.sourceAuthorityEpoch, immutable: true });
  let closed = false;
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("INGESTION_JOURNAL_SQLITE_CLOSED");
      const actual = await fingerprintSqlite(path);
      if (actual.sha256 !== expectedSha256 || !sameStat(initial.stat, actual.stat)) {
        fail("INGESTION_JOURNAL_SOURCE_CHANGED");
      }
      return Object.freeze({ snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256,
        sourceId, sourceAuthorityEpoch: sourceInfo.sourceAuthorityEpoch });
    },
    async verifyUnchanged() {
      if (closed) fail("INGESTION_JOURNAL_SQLITE_CLOSED");
      try {
        await assertNoSidecars(path);
        const current = await lstat(path);
        if (!sameStat(initial.stat, current) || !current.isFile() || current.isSymbolicLink()
            || (current.mode & 0o222) !== 0) fail("INGESTION_JOURNAL_SOURCE_CHANGED");
      } catch (error) {
        if (error instanceof PostgresIngestionJournalTransferError) throw error;
        fail("INGESTION_JOURNAL_SOURCE_CHANGED");
      }
    },
    async listPage({ after = null, limit } = {}) {
      if (closed) fail("INGESTION_JOURNAL_SQLITE_CLOSED");
      validatePageSize(limit);
      const afterSequence = after === null ? "0" : normalizeInteger(after);
      if (BigInt(afterSequence) < 0n) fail("INGESTION_JOURNAL_CURSOR_INVALID");
      try {
        const rawRows = statement.all(BigInt(afterSequence), BigInt(limit));
        if (rawRows.length > limit) fail("INGESTION_JOURNAL_SOURCE_PAGE_INVALID");
        return Object.freeze({ rows: Object.freeze(rawRows.map(row => normalizeRow(sourceId, row))) });
      } catch (error) {
        if (error instanceof PostgresIngestionJournalTransferError) throw error;
        fail("INGESTION_JOURNAL_SQLITE_READ_FAILED");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { database.exec("ROLLBACK"); } catch { /* Closing the handle also ends the read transaction. */ }
      database.close();
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

function assertSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || !source.snapshot
      || source.snapshot.kind !== "sealed-sqlite-ingestion-journal" || source.snapshot.immutable !== true
      || !SHA256.test(source.snapshot.artifactSha256 ?? "")
      || source.snapshot.snapshotId !== `sha256:${source.snapshot.artifactSha256}`
      || !SOURCE_ID.test(source.snapshot.sourceId ?? "")) fail("INGESTION_JOURNAL_SEALED_SOURCE_REQUIRED");
  return source.snapshot;
}

function canonicalRow(row) {
  return JSON.stringify(ROW_COLUMNS.map(column => row[column]));
}

function updateRowHash(hash, row) {
  hash.update(`${canonicalRow(row)}\n`);
}

function checkpointHash(previous, rows) {
  const hash = sha256();
  hash.update(`${previous}\n`);
  for (const row of rows) hash.update(`${canonicalRow(row)}\n`);
  return hash.digest("hex");
}

function cursorFor(row) { return row.sequence; }

function rowsEqual(left, right) {
  return ROW_COLUMNS.every(column => left[column] === right[column]);
}

function normalizeTargetRow(sourceId, raw) {
  const row = normalizeRow(sourceId, raw);
  if (normalizeInteger(raw.event_tuple_version) !== "1"
      || normalizeInteger(raw.owner_revision) !== "0") {
    fail("INGESTION_JOURNAL_DESTINATION_ROW_MISMATCH");
  }
  return row;
}

async function scanSource(source, pageSize) {
  const snapshot = assertSource(source);
  if (typeof source.verifyUnchanged !== "function") fail("INGESTION_JOURNAL_SEALED_SOURCE_REQUIRED");
  await source.verifyUnchanged();
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  let pagesRead = 0;
  for (;;) {
    const page = await source.listPage({ after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("INGESTION_JOURNAL_SOURCE_PAGE_INVALID");
    pagesRead += 1;
    for (const row of page.rows) {
      if (row.source_id !== snapshot.sourceId || BigInt(row.sequence) <= BigInt(after ?? "0")) {
        fail("INGESTION_JOURNAL_SOURCE_ORDER_INVALID");
      }
      updateRowHash(hash, row);
      after = cursorFor(row);
      rowCount += 1n;
    }
    if (page.rows.length < pageSize) break;
  }
  await source.verifyUnchanged();
  return Object.freeze({ sourceId: snapshot.sourceId, sourceAuthorityEpoch: snapshot.sourceAuthorityEpoch,
    sourceSnapshotSha256: snapshot.artifactSha256, eventRows: rowCount.toString(), eventRowsSha256: hash.digest("hex"),
    lastSequence: after ?? "0", pagesRead });
}

export async function scanSealedSqliteIngestionJournal({
  source,
  pageSize = POSTGRES_INGESTION_JOURNAL_DEFAULT_PAGE_SIZE,
} = {}) {
  const size = validatePageSize(pageSize);
  const sourceManifest = await scanSource(source, size);
  return Object.freeze({
    schema: SEALED_SQLITE_INGESTION_JOURNAL_SCHEMA,
    sourceIdSha256: sha256().update(sourceManifest.sourceId).digest("hex"),
    sourceSnapshotSha256: sourceManifest.sourceSnapshotSha256,
    sourceAuthorityEpoch: sourceManifest.sourceAuthorityEpoch,
    eventRows: sourceManifest.eventRows,
    eventRowsSha256: sourceManifest.eventRowsSha256,
    lastSequence: sourceManifest.lastSequence,
    pageSize: size,
    pagesRead: sourceManifest.pagesRead,
    postgresWrites: 0,
    analyticsCursorAdvanced: false,
    ownerStateWritten: false,
    appliedReceiptsWritten: false,
  });
}

function schemaName(value) {
  if (typeof value !== "string" || !SCHEMA.test(value) || value.startsWith("pg_")
      || value === "information_schema" || value === "pg_catalog") fail("INGESTION_JOURNAL_TARGET_SCHEMA_INVALID");
  return value;
}

// The disposable targets this importer may write: its own prefix, or the GCP
// fast-path rehearsal schema that holds every importer's tables at once.
const TARGET_SCHEMA_PREFIXES = Object.freeze([
  POSTGRES_INGESTION_JOURNAL_TARGET_SCHEMA_PREFIX,
  POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX,
]);

function targetSuffix(value) {
  const schema = schemaName(value);
  const prefix = TARGET_SCHEMA_PREFIXES.find((candidate) => schema.startsWith(candidate));
  const suffix = prefix === undefined ? "" : schema.slice(prefix.length);
  if (!TARGET_SUFFIX.test(suffix)) fail("INGESTION_JOURNAL_DISPOSABLE_SCHEMA_REQUIRED");
  return schema;
}

function quoteSchema(schema) { return `"${schemaName(schema)}"`; }
function relation(schema, name) {
  if (name !== "storage_ingestion_changes" && name !== "storage_source_state"
      && name !== CONTROL_RUNS && name !== CONTROL_CHECKPOINTS && name !== "_tibotattle_migration_history"
      && name !== "analytics_source_cursors" && name !== "analytics_owner_state" && name !== "analytics_applied_events"
      && name !== "analytics_publication_invalidations" && name !== "analytics_publication_owner_members"
      && name !== "community_daily_aggregates" && name !== "community_daily_allowance_publication_state"
      && name !== "community_daily_allowance_preview_cache") fail("INGESTION_JOURNAL_TARGET_TABLE_INVALID");
  return `${quoteSchema(schema)}."${name}"`;
}

async function validateTarget(client, schema) {
  let locality;
  try {
    locality = await client.query("SELECT inet_server_addr() AS address,current_setting('server_version_num')::integer AS version");
  } catch {
    fail("INGESTION_JOURNAL_TARGET_UNAVAILABLE");
  }
  const serverVersion = Number(locality.rows[0]?.version);
  if (locality.rows[0]?.address !== null || Math.floor(serverVersion / 10_000) !== 17) {
    fail("INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED");
  }
  const expected = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT });
  if (expected.length < 38 || expected[37]?.name !== "0038_analytics_event_tuple_versions.sql") {
    fail("INGESTION_JOURNAL_MIGRATION_CONTRACT_UNAVAILABLE");
  }
  let actual;
  try {
    actual = await client.query(`SELECT version,name,checksum_sha256 FROM ${relation(schema, "_tibotattle_migration_history")} ORDER BY version`);
  } catch {
    fail("INGESTION_JOURNAL_TARGET_MIGRATION_REQUIRED");
  }
  if (actual.rows.length !== expected.length || expected.some((item, index) => {
    const row = actual.rows[index];
    return row?.version !== item.version || row?.name !== item.name || row?.checksum_sha256 !== item.sha256;
  })) fail("INGESTION_JOURNAL_TARGET_MIGRATION_REQUIRED");
  return serverVersion;
}

async function acquireTargetLock(client, schema, transferId) {
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`${schema}:ingestion-journal-transfer`]);
  } catch {
    fail("INGESTION_JOURNAL_TARGET_LOCK_FAILED");
  }
}

async function createControls(client, schema) {
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, CONTROL_RUNS)} (
      transfer_id text PRIMARY KEY CHECK (transfer_id ~ '^synthetic-ingestion-journal-[A-Za-z0-9._-]{1,96}$'),
      source_snapshot_id text NOT NULL,
      source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      source_id text NOT NULL,
      source_authority_epoch bigint NOT NULL CHECK (source_authority_epoch >= 0),
      source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
      source_rows_sha256 text NOT NULL CHECK (source_rows_sha256 ~ '^[0-9a-f]{64}$'),
      page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND ${POSTGRES_INGESTION_JOURNAL_MAX_PAGE_SIZE}),
      last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
      status text NOT NULL CHECK (status IN ('running','complete')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, CONTROL_CHECKPOINTS)} (
      transfer_id text PRIMARY KEY REFERENCES ${relation(schema, CONTROL_RUNS)}(transfer_id) ON DELETE CASCADE,
      last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
      row_count bigint NOT NULL CHECK (row_count >= 0),
      page_count integer NOT NULL CHECK (page_count >= 0),
      prefix_chain_sha256 text NOT NULL CHECK (prefix_chain_sha256 ~ '^[0-9a-f]{64}$'),
      complete boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
  } catch {
    fail("INGESTION_JOURNAL_CONTROL_SCHEMA_INVALID");
  }
}

function emptyPrefixHash() { return sha256().digest("hex"); }

async function assertCleanDisposableTarget(client, schema, sourceId, expectedJournalRows) {
  const params = [sourceId];
  try {
    const checks = await client.query(`SELECT
      (SELECT count(*)::text FROM ${relation(schema, "storage_ingestion_changes")}) AS journal_rows,
      (SELECT count(*)::text FROM ${relation(schema, "storage_ingestion_changes")} WHERE source_id<>$1) AS other_journal_rows,
      (SELECT count(*)::text FROM ${relation(schema, "storage_source_state")}) AS source_states,
      (SELECT count(*)::text FROM ${relation(schema, "analytics_source_cursors")}) AS cursors,
      (SELECT count(*)::text FROM ${relation(schema, "analytics_owner_state")}) AS owners,
      (SELECT count(*)::text FROM ${relation(schema, "analytics_applied_events")}) AS receipts,
      (SELECT count(*)::text FROM ${relation(schema, "analytics_publication_invalidations")}) AS invalidations,
      (SELECT count(*)::text FROM ${relation(schema, "analytics_publication_owner_members")}) AS members,
      (SELECT count(*)::text FROM ${relation(schema, "community_daily_aggregates")}) AS daily_rows,
      (SELECT count(*)::text FROM ${relation(schema, "community_daily_allowance_publication_state")}) AS allowance_state,
      (SELECT count(*)::text FROM ${relation(schema, "community_daily_allowance_preview_cache")}) AS allowance_cache`, params);
    const row = checks.rows[0];
    if (!row || row.journal_rows !== String(expectedJournalRows) || row.other_journal_rows !== "0"
        || row.cursors !== "0" || row.owners !== "0" || row.receipts !== "0"
        || row.invalidations !== "0" || row.members !== "0" || row.daily_rows !== "0"
        || row.allowance_state !== "0" || row.allowance_cache !== "0") {
      fail("INGESTION_JOURNAL_TARGET_NOT_EMPTY");
    }
    if (row.source_states !== "0" && row.source_states !== "1") fail("INGESTION_JOURNAL_TARGET_SOURCE_IDENTITY_INVALID");
    const states = await client.query(`SELECT singleton,source_id,authority_epoch::text AS authority_epoch
      FROM ${relation(schema, "storage_source_state")}`);
    if (states.rows.length === 1 && (states.rows[0]?.singleton !== 1 || states.rows[0]?.source_id !== sourceId)) {
      fail("INGESTION_JOURNAL_TARGET_SOURCE_IDENTITY_MISMATCH");
    }
    return states.rows[0] ?? null;
  } catch (error) {
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_TARGET_READ_FAILED");
  }
}

async function scanTarget(client, schema, sourceId, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = "0";
  let pagesRead = 0;
  for (;;) {
    let result;
    try {
      result = await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
        FROM ${relation(schema, "storage_ingestion_changes")}
        WHERE source_id=$1 AND sequence > $2 ORDER BY sequence LIMIT $3`, [sourceId, after, pageSize]);
    } catch {
      fail("INGESTION_JOURNAL_TARGET_READ_FAILED");
    }
    if (result.rows.length > pageSize) fail("INGESTION_JOURNAL_TARGET_PAGE_INVALID");
    pagesRead += 1;
    for (const raw of result.rows) {
      const row = normalizeTargetRow(sourceId, raw);
      if (BigInt(row.sequence) <= BigInt(after)) fail("INGESTION_JOURNAL_TARGET_ORDER_INVALID");
      updateRowHash(hash, row);
      after = row.sequence;
      rowCount += 1n;
    }
    if (result.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), sha256: hash.digest("hex"), lastSequence: after, pagesRead });
}

async function verifyCheckpoint({ client, schema, source, sourceId, transferId, checkpoint, pageSize }) {
  const sequence = BigInt(checkpoint.last_sequence);
  const expectedRows = BigInt(checkpoint.row_count);
  if (sequence === 0n) {
    if (expectedRows !== 0n || checkpoint.page_count !== 0 || checkpoint.prefix_chain_sha256 !== emptyPrefixHash()) {
      fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    }
    return;
  }
  let chain = emptyPrefixHash();
  let pages = 0;
  let verifiedRows = 0n;
  let sourceAfter = null;
  let targetAfter = "0";
  while (verifiedRows < expectedRows) {
    const remaining = expectedRows - verifiedRows;
    const limit = Number(remaining > BigInt(pageSize) ? BigInt(pageSize) : remaining);
    const page = await source.listPage({ after: sourceAfter, limit });
    if (!page || !Array.isArray(page.rows) || page.rows.length !== limit) fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    const sourceRows = page.rows;
    if (sourceRows.some(row => row.source_id !== sourceId || BigInt(row.sequence) <= BigInt(sourceAfter ?? "0")
        || BigInt(row.sequence) > sequence)) fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    const target = await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
      FROM ${relation(schema, "storage_ingestion_changes")}
      WHERE source_id=$1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence LIMIT $4`,
    [sourceId, targetAfter, sourceRows.at(-1).sequence, limit]);
    if (target.rows.length !== sourceRows.length) fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    const targetRows = target.rows.map(row => normalizeTargetRow(sourceId, row));
    if (sourceRows.some((row, index) => !rowsEqual(row, targetRows[index]))) {
      fail("INGESTION_JOURNAL_DESTINATION_ROW_MISMATCH");
    }
    chain = checkpointHash(chain, sourceRows);
    sourceAfter = sourceRows.at(-1).sequence;
    targetAfter = sourceAfter;
    verifiedRows += BigInt(sourceRows.length);
    pages += 1;
  }
  if (verifiedRows !== expectedRows || BigInt(sourceAfter ?? "0") !== sequence
      || chain !== checkpoint.prefix_chain_sha256 || pages !== checkpoint.page_count) {
    fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
  }
  const checkpointRun = await client.query(`SELECT last_sequence::text AS last_sequence
    FROM ${relation(schema, CONTROL_RUNS)} WHERE transfer_id=$1`, [transferId]);
  if (checkpointRun.rows[0]?.last_sequence !== sequence.toString()) fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
}

function insertRowsSql(schema, count) {
  const width = TARGET_COLUMNS.length;
  const values = Array.from({ length: count }, (_, rowIndex) =>
    `(${TARGET_COLUMNS.map((_, columnIndex) => `$${rowIndex * width + columnIndex + 1}`).join(",")})`).join(",");
  return `INSERT INTO ${relation(schema, "storage_ingestion_changes")} (${TARGET_COLUMNS.map(column => `"${column}"`).join(",")})
    VALUES ${values} ON CONFLICT (source_id,sequence) DO NOTHING`;
}

function targetValues(rows) {
  // PostgreSQL owner_revision is separate from the exact D1 journal revision.
  // Zero is the schema's non-authoritative compatibility value; only the v1
  // revision column below carries the imported D1 revision.
  return rows.flatMap(row => [row.source_id, row.sequence, row.event_digest, row.owner_digest, 0,
    row.authority_epoch, row.kind, row.recorded_ms, 1, row.revision, row.object_digest,
    row.content_digest, row.public_authority_epoch]);
}

async function verifyInsertedPage(client, schema, sourceId, rows) {
  if (rows.length === 0) return;
  const first = rows[0].sequence;
  const last = rows.at(-1).sequence;
  let result;
  try {
    result = await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
      FROM ${relation(schema, "storage_ingestion_changes")}
      WHERE source_id=$1 AND sequence BETWEEN $2 AND $3 ORDER BY sequence`, [sourceId, first, last]);
  } catch {
    fail("INGESTION_JOURNAL_DESTINATION_READBACK_FAILED");
  }
  if (result.rows.length !== rows.length) fail("INGESTION_JOURNAL_DESTINATION_ROW_MISMATCH");
  const normalized = result.rows.map(row => normalizeTargetRow(sourceId, row));
  if (rows.some((row, index) => !rowsEqual(row, normalized[index]))) fail("INGESTION_JOURNAL_DESTINATION_ROW_MISMATCH");
}

async function establishRun({ client, schema, manifest, transferId, pageSize }) {
  await client.query("BEGIN");
  try {
    const current = await client.query(`SELECT source_snapshot_id,source_snapshot_sha256,source_id,
        source_authority_epoch::text AS source_authority_epoch,source_row_count::text AS source_row_count,
        source_rows_sha256,page_size,last_sequence::text AS last_sequence,status
      FROM ${relation(schema, CONTROL_RUNS)} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (current.rows.length === 0) {
      const state = await assertCleanDisposableTarget(client, schema, manifest.sourceId, "0");
      if (state && state.authority_epoch !== manifest.sourceAuthorityEpoch) {
        fail("INGESTION_JOURNAL_TARGET_SOURCE_IDENTITY_MISMATCH");
      }
      const anyEvents = await client.query(`SELECT count(*)::text AS count FROM ${relation(schema, "storage_ingestion_changes")}`);
      if (anyEvents.rows[0]?.count !== "0") fail("INGESTION_JOURNAL_TARGET_NOT_EMPTY");
      if (!state) {
        await client.query(`INSERT INTO ${relation(schema, "storage_source_state")}(singleton,source_id,authority_epoch)
          VALUES(1,$1,$2)`, [manifest.sourceId, manifest.sourceAuthorityEpoch]);
      }
      await client.query(`INSERT INTO ${relation(schema, CONTROL_RUNS)}(
        transfer_id,source_snapshot_id,source_snapshot_sha256,source_id,source_authority_epoch,
        source_row_count,source_rows_sha256,page_size,last_sequence,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'running')`, [transferId,
        `sha256:${manifest.sourceSnapshotSha256}`, manifest.sourceSnapshotSha256, manifest.sourceId,
        manifest.sourceAuthorityEpoch, manifest.eventRows, manifest.eventRowsSha256, pageSize]);
      await client.query(`INSERT INTO ${relation(schema, CONTROL_CHECKPOINTS)}(
        transfer_id,last_sequence,row_count,page_count,prefix_chain_sha256,complete)
        VALUES($1,0,0,0,$2,false)`, [transferId, emptyPrefixHash()]);
      await client.query("COMMIT");
      return { resumed: false, status: "running" };
    }
    const row = current.rows[0];
    if (row.source_snapshot_id !== `sha256:${manifest.sourceSnapshotSha256}`
        || row.source_snapshot_sha256 !== manifest.sourceSnapshotSha256 || row.source_id !== manifest.sourceId
        || row.source_authority_epoch !== manifest.sourceAuthorityEpoch || row.source_row_count !== manifest.eventRows
        || row.source_rows_sha256 !== manifest.eventRowsSha256) fail("INGESTION_JOURNAL_TRANSFER_SOURCE_MISMATCH");
    if (row.page_size !== pageSize) fail("INGESTION_JOURNAL_TRANSFER_PAGE_SIZE_MISMATCH");
    const checkpoint = await client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
        page_count,prefix_chain_sha256,complete FROM ${relation(schema, CONTROL_CHECKPOINTS)}
      WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (checkpoint.rows.length !== 1 || checkpoint.rows[0].last_sequence !== row.last_sequence) {
      fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    }
    if ((row.status === "complete") !== (checkpoint.rows[0].complete === true)) {
      fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    }
    const state = await assertCleanDisposableTarget(client, schema, manifest.sourceId, checkpoint.rows[0].row_count);
    if (!state || state.authority_epoch !== manifest.sourceAuthorityEpoch) {
      fail("INGESTION_JOURNAL_TARGET_SOURCE_IDENTITY_MISMATCH");
    }
    await client.query("COMMIT");
    return { resumed: true, status: row.status };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_RUN_INITIALIZATION_FAILED");
  }
}

async function loadCheckpoint(client, schema, transferId) {
  try {
    const result = await client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
        page_count,prefix_chain_sha256,complete
      FROM ${relation(schema, CONTROL_CHECKPOINTS)} WHERE transfer_id=$1`, [transferId]);
    if (result.rows.length !== 1) fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    return result.rows[0];
  } catch (error) {
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
  }
}

async function copyPage({ client, schema, source, sourceId, transferId, priorCheckpoint, rows }) {
  if (rows.length === 0) return false;
  const newChain = checkpointHash(priorCheckpoint.prefix_chain_sha256, rows);
  await client.query("BEGIN");
  try {
    const current = await client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
        page_count,prefix_chain_sha256 FROM ${relation(schema, CONTROL_CHECKPOINTS)}
      WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    const checkpoint = current.rows[0];
    if (!checkpoint || checkpoint.last_sequence !== priorCheckpoint.last_sequence
        || checkpoint.row_count !== priorCheckpoint.row_count || checkpoint.page_count !== priorCheckpoint.page_count
        || checkpoint.prefix_chain_sha256 !== priorCheckpoint.prefix_chain_sha256) fail("INGESTION_JOURNAL_CHECKPOINT_RACE");
    if (typeof source.verifyUnchanged !== "function") fail("INGESTION_JOURNAL_SEALED_SOURCE_REQUIRED");
    await source.verifyUnchanged();
    await client.query(insertRowsSql(schema, rows.length), targetValues(rows));
    await verifyInsertedPage(client, schema, sourceId, rows);
    const count = BigInt(priorCheckpoint.row_count) + BigInt(rows.length);
    const pageCount = priorCheckpoint.page_count + 1;
    const lastSequence = rows.at(-1).sequence;
    await client.query(`UPDATE ${relation(schema, CONTROL_CHECKPOINTS)}
      SET last_sequence=$2,row_count=$3,page_count=$4,prefix_chain_sha256=$5,updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId, lastSequence, count.toString(), pageCount, newChain]);
    await client.query(`UPDATE ${relation(schema, CONTROL_RUNS)} SET last_sequence=$2 WHERE transfer_id=$1`,
      [transferId, lastSequence]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_PAGE_COMMIT_FAILED");
  }
}

async function completeRun(client, schema, transferId) {
  try {
    await client.query("BEGIN");
    const checkpoint = await client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count
      FROM ${relation(schema, CONTROL_CHECKPOINTS)} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    await client.query(`UPDATE ${relation(schema, CONTROL_CHECKPOINTS)} SET complete=true,updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await client.query(`UPDATE ${relation(schema, CONTROL_RUNS)} SET status='complete',
      completed_at=clock_timestamp(),last_sequence=$2 WHERE transfer_id=$1`,
    [transferId, checkpoint.rows[0]?.last_sequence ?? "0"]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    fail("INGESTION_JOURNAL_FINALIZE_FAILED");
  }
}

/**
 * Replay a sealed D1 source journal into an isolated local PostgreSQL 17 schema.
 * Each bounded page and its durable checkpoint commit atomically. This imports
 * only version-1 storage_ingestion_changes tuples; it never advances analytics
 * cursors, writes owner state, or synthesizes applied-event receipts.
 */
export async function transferPostgresIngestionJournal({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  transferId,
  pageSize = POSTGRES_INGESTION_JOURNAL_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = targetSuffix(rawTargetSchema);
  const size = validatePageSize(pageSize);
  const snapshot = assertSource(source);
  if (!TRANSFER_ID.test(transferId ?? "")) fail("INGESTION_JOURNAL_TRANSFER_ID_INVALID");
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("INGESTION_JOURNAL_DESTINATION_REQUIRED");
  const manifest = await scanSource(source, size);
  let client;
  try {
    client = await destinationPool.connect();
  } catch {
    fail("INGESTION_JOURNAL_DESTINATION_UNAVAILABLE");
  }
  let lockHeld = false;
  try {
    const postgresVersion = await validateTarget(client, schema);
    await acquireTargetLock(client, schema, transferId);
    lockHeld = true;
    await createControls(client, schema);
    const opened = await establishRun({ client, schema, manifest, transferId, pageSize: size });
    let checkpoint = await loadCheckpoint(client, schema, transferId);
    await verifyCheckpoint({ client, schema, source, sourceId: snapshot.sourceId, transferId, checkpoint, pageSize: size });
    if (opened.status === "complete" && checkpoint.complete) {
      const target = await scanTarget(client, schema, snapshot.sourceId, size);
      if (target.rowCount !== manifest.eventRows || target.sha256 !== manifest.eventRowsSha256
          || target.lastSequence !== manifest.lastSequence) fail("INGESTION_JOURNAL_SOURCE_DESTINATION_PARITY_FAILED");
      return Object.freeze({
        schema: POSTGRES_INGESTION_JOURNAL_TRANSFER_SCHEMA,
        status: "already_complete",
        targetSchema: schema,
        sourceIdSha256: sha256().update(snapshot.sourceId).digest("hex"),
        sourceSnapshotSha256: manifest.sourceSnapshotSha256,
        eventRows: manifest.eventRows,
        eventRowsSha256: manifest.eventRowsSha256,
        targetRows: target.rowCount,
        targetRowsSha256: target.sha256,
        pageSize: size,
        postgresMajor: 17,
        pagesCommitted: 0,
        rowsInserted: "0",
        resumed: true,
        analyticsCursorAdvanced: false,
        ownerStateWritten: false,
        appliedReceiptsWritten: false,
      });
    }
    let pagesCommitted = 0;
    let rowsInserted = 0n;
    let after = checkpoint.last_sequence;
    for (;;) {
      const page = await source.listPage({ after, limit: size });
      if (!page || !Array.isArray(page.rows) || page.rows.length > size) fail("INGESTION_JOURNAL_SOURCE_PAGE_INVALID");
      for (const row of page.rows) {
        if (row.source_id !== snapshot.sourceId || BigInt(row.sequence) <= BigInt(after)) {
          fail("INGESTION_JOURNAL_SOURCE_ORDER_INVALID");
        }
      }
      if (page.rows.length === 0) break;
      const didCommit = await copyPage({ client, schema, source, sourceId: snapshot.sourceId, transferId,
        priorCheckpoint: checkpoint, rows: page.rows });
      if (didCommit) {
        pagesCommitted += 1;
        rowsInserted += BigInt(page.rows.length);
        after = page.rows.at(-1).sequence;
        checkpoint = await loadCheckpoint(client, schema, transferId);
      }
      if (page.rows.length < size) break;
    }
    const finalManifest = await scanSource(source, size);
    if (finalManifest.eventRows !== manifest.eventRows || finalManifest.eventRowsSha256 !== manifest.eventRowsSha256
        || finalManifest.lastSequence !== manifest.lastSequence) fail("INGESTION_JOURNAL_SOURCE_CHANGED");
    const checkpointAfter = await loadCheckpoint(client, schema, transferId);
    const state = await assertCleanDisposableTarget(client, schema, snapshot.sourceId, checkpointAfter.row_count);
    if (!state || state.authority_epoch !== manifest.sourceAuthorityEpoch) fail("INGESTION_JOURNAL_TARGET_SOURCE_IDENTITY_MISMATCH");
    const target = await scanTarget(client, schema, snapshot.sourceId, size);
    if (target.rowCount !== manifest.eventRows || target.sha256 !== manifest.eventRowsSha256
        || target.lastSequence !== manifest.lastSequence) fail("INGESTION_JOURNAL_SOURCE_DESTINATION_PARITY_FAILED");
    if (checkpointAfter.row_count !== manifest.eventRows || checkpointAfter.last_sequence !== manifest.lastSequence
        || (manifest.eventRows === "0" && checkpointAfter.last_sequence !== "0")) {
      fail("INGESTION_JOURNAL_CHECKPOINT_INVALID");
    }
    await completeRun(client, schema, transferId);
    return Object.freeze({
      schema: POSTGRES_INGESTION_JOURNAL_TRANSFER_SCHEMA,
      status: "synthetic_storage_ingestion_journal_transfer_complete",
      targetSchema: schema,
      sourceIdSha256: sha256().update(snapshot.sourceId).digest("hex"),
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      eventRows: manifest.eventRows,
      eventRowsSha256: manifest.eventRowsSha256,
      targetRows: target.rowCount,
      targetRowsSha256: target.sha256,
      pageSize: size,
      postgresMajor: Math.floor(postgresVersion / 10_000),
      pagesCommitted,
      rowsInserted: rowsInserted.toString(),
      resumed: opened.resumed,
      restartMode: "verify_checkpoint_and_resume_after_last_sequence",
      analyticsCursorAdvanced: false,
      ownerStateWritten: false,
      appliedReceiptsWritten: false,
    });
  } catch (error) {
    if (error instanceof PostgresIngestionJournalTransferError) throw error;
    fail("INGESTION_JOURNAL_TRANSFER_FAILED");
  } finally {
    if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:ingestion-journal-transfer`]).catch(() => {});
    client?.release();
  }
}

export const POSTGRES_INGESTION_JOURNAL_SOURCE_COLUMNS = Object.freeze([...SOURCE_COLUMNS]);
export const POSTGRES_INGESTION_JOURNAL_ROW_COLUMNS = Object.freeze([...ROW_COLUMNS]);
