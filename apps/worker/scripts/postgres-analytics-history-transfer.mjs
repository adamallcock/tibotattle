import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const POSTGRES_ANALYTICS_HISTORY_TRANSFER_SCHEMA = "postgres-analytics-history-transfer-v1";
export const SEALED_ANALYTICS_EVENT_EXPORT_SCHEMA = "sealed-sqlite-analytics-events-v1";
export const POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_ANALYTICS_HISTORY_MAX_PAGE_SIZE = 200;
export const POSTGRES_ANALYTICS_HISTORY_TARGET_SCHEMA_PREFIX = "analytics_history_transfer_target_";

const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const TRUSTED_SOURCES = new WeakSet();

const SOURCE_TABLES = Object.freeze({
  analytics_runtime_sources: Object.freeze({
    columns: Object.freeze(["source_id", "source_namespace", "contract_version"]),
    types: Object.freeze(["TEXT", "TEXT", "INTEGER"]),
  }),
  analytics_source_cursors: Object.freeze({
    columns: Object.freeze(["source_id", "sequence", "authority_epoch"]),
    types: Object.freeze(["TEXT", "INTEGER", "INTEGER"]),
  }),
  analytics_owner_state: Object.freeze({
    columns: Object.freeze(["source_id", "owner_digest", "revision", "authority_epoch", "state"]),
    types: Object.freeze(["TEXT", "TEXT", "INTEGER", "INTEGER", "TEXT"]),
  }),
  analytics_applied_events: Object.freeze({
    columns: Object.freeze(["source_id", "sequence", "event_digest", "owner_digest", "revision", "kind",
      "object_digest", "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms"]),
    types: Object.freeze(["TEXT", "INTEGER", "TEXT", "TEXT", "INTEGER", "TEXT", "TEXT", "TEXT",
      "INTEGER", "INTEGER", "INTEGER"]),
  }),
});

const SPECS = Object.freeze([
  Object.freeze({
    name: "analytics_owner_state",
    columns: Object.freeze(["source_id", "owner_digest", "revision", "authority_epoch", "state"]),
    types: Object.freeze(["text", "text", "i64", "i64", "text"]),
    key: Object.freeze(["source_id", "owner_digest"]),
  }),
  Object.freeze({
    name: "analytics_source_cursors",
    columns: Object.freeze(["source_id", "sequence", "authority_epoch"]),
    types: Object.freeze(["text", "i64", "i64"]),
    key: Object.freeze(["source_id"]),
  }),
]);
const SPEC_BY_NAME = new Map(SPECS.map(spec => [spec.name, spec]));
const ANALYTICS_EVENT_SPEC = Object.freeze({
  name: "analytics_applied_events",
  columns: SOURCE_TABLES.analytics_applied_events.columns,
  types: Object.freeze(["text", "i64", "text", "text", "i64", "text", "text", "text", "i64", "i64", "i64"]),
  key: Object.freeze(["source_id", "sequence"]),
});
const SEALED_SOURCE_PAGE_SPEC_BY_NAME = new Map([
  ...SPECS.map(spec => [spec.name, spec]),
  [ANALYTICS_EVENT_SPEC.name, ANALYTICS_EVENT_SPEC],
]);

// These families are deliberately not part of this import. They either have a
// different PostgreSQL contract or require authority fields not present in the
// D1 rows. Keeping them empty prevents a partial state/cursor copy from being
// mistaken for a publication-ready analytics transfer.
const TARGET_OPERATION_TABLES = Object.freeze([
  "analytics_applied_events",
  "analytics_owner_results",
  "analytics_scheduler_delivery_cursors",
  "analytics_publication_captures",
  "analytics_publications",
  "analytics_publication_owner_members",
  "analytics_publication_invalidations",
  "analytics_prepared_source_heads",
  "analytics_prepared_source_rows",
  "analytics_prepared_source_streams",
  "analytics_prepared_source_controls",
  "analytics_prepared_source_outputs",
  "analytics_analysis_work_heads",
  "analytics_analysis_work_parts",
]);

export class PostgresAnalyticsHistoryTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresAnalyticsHistoryTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresAnalyticsHistoryTransferError(code);
}

function sha256() {
  return createHash("sha256");
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_ANALYTICS_HISTORY_MAX_PAGE_SIZE) {
    fail("ANALYTICS_HISTORY_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function validateSourceId(value) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) fail("ANALYTICS_HISTORY_SOURCE_ID_INVALID");
  return value;
}

function validateOwnerDigest(value) {
  if (typeof value !== "string" || !OWNER_DIGEST.test(value)) fail("ANALYTICS_HISTORY_OWNER_DIGEST_INVALID");
  return value;
}

function normalizeInteger(value) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("ANALYTICS_HISTORY_INTEGER_INVALID");
  return parsed.toString();
}

function normalizeValue(type, value) {
  if (value === null) return null;
  if (type === "i64") return normalizeInteger(value);
  if (type === "text" && typeof value === "string") return value;
  fail("ANALYTICS_HISTORY_VALUE_INVALID");
}

function normalizeRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ANALYTICS_HISTORY_ROW_INVALID");
  const row = Object.create(null);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    row[column] = normalizeValue(spec.types[index], raw[column]);
  }
  validateTransferRow(spec, row);
  return row;
}

function validateTransferRow(spec, row) {
  validateSourceId(row.source_id);
  if (spec.name === "analytics_source_cursors") {
    if (BigInt(row.sequence) < 0n || BigInt(row.authority_epoch) < 0n) fail("ANALYTICS_HISTORY_CURSOR_INVALID");
    return;
  }
  if (spec.name === "analytics_applied_events") {
    validateOwnerDigest(row.owner_digest);
    if (BigInt(row.sequence) < 1n || BigInt(row.revision) < 1n || BigInt(row.authority_epoch) < 1n
        || BigInt(row.public_authority_epoch) < 1n || BigInt(row.recorded_ms) < 0n
        || ![row.event_digest, row.object_digest, row.content_digest].every(value => SHA256.test(value ?? ""))
        || !["source-updated", "owner-active", "owner-withdrawn", "owner-erased"].includes(row.kind)) {
      fail("ANALYTICS_HISTORY_EVENT_INVALID");
    }
    return;
  }
  validateOwnerDigest(row.owner_digest);
  if (BigInt(row.revision) < 1n || BigInt(row.authority_epoch) < 1n
      || !["active", "withdrawn", "erased"].includes(row.state)) fail("ANALYTICS_HISTORY_OWNER_STATE_INVALID");
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      fail("ANALYTICS_HISTORY_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
      fail("ANALYTICS_HISTORY_SQLITE_UNAVAILABLE");
    }
  }
}

async function fingerprintSqlite(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("ANALYTICS_HISTORY_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) {
      fail("ANALYTICS_HISTORY_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("ANALYTICS_HISTORY_SQLITE_CHANGED");
    const hash = sha256();
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("ANALYTICS_HISTORY_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(opened, after)) fail("ANALYTICS_HISTORY_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
    fail("ANALYTICS_HISTORY_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateSqliteLayout(database) {
  for (const [table, spec] of Object.entries(SOURCE_TABLES)) {
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
    if (columns.length !== spec.columns.length
        || columns.some((column, index) => column.name !== spec.columns[index]
          || String(column.type).toUpperCase() !== spec.types[index])) {
      fail("ANALYTICS_HISTORY_SQLITE_LAYOUT_INVALID");
    }
  }
}

function sqliteCount(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  const value = statement.get()?.count;
  if (typeof value !== "bigint" || value < 0n) fail("ANALYTICS_HISTORY_SOURCE_INTEGRITY_INVALID");
  return value;
}

function validateSqliteRows(database) {
  const invalidRegistrations = sqliteCount(database, `SELECT count(*) AS count FROM analytics_runtime_sources
    WHERE length(source_id) NOT BETWEEN 1 AND 128
       OR substr(source_id,1,1) NOT GLOB '[A-Za-z0-9]'
       OR source_id GLOB '*[^A-Za-z0-9:_-]*'
       OR length(CAST(source_namespace AS BLOB)) NOT BETWEEN 1 AND 256
       OR contract_version <> 1`);
  const invalidCursorOrEvent = sqliteCount(database, `SELECT count(*) AS count FROM analytics_source_cursors cursor
    LEFT JOIN analytics_runtime_sources runtime ON runtime.source_id=cursor.source_id
    LEFT JOIN (
      SELECT source_id,count(*) AS event_count,min(sequence) AS first_sequence,max(sequence) AS last_sequence
        FROM analytics_applied_events GROUP BY source_id
    ) stats ON stats.source_id=cursor.source_id
    LEFT JOIN (
      SELECT source_id,public_authority_epoch,
        row_number() OVER(PARTITION BY source_id ORDER BY sequence DESC) AS position
        FROM analytics_applied_events
    ) latest ON latest.source_id=cursor.source_id AND latest.position=1
    WHERE runtime.source_id IS NULL
       OR cursor.sequence < 0 OR cursor.authority_epoch < 0
       OR coalesce(stats.event_count,0) <> cursor.sequence
       OR coalesce(stats.first_sequence,0) <> CASE WHEN cursor.sequence=0 THEN 0 ELSE 1 END
       OR coalesce(stats.last_sequence,0) <> cursor.sequence
       OR coalesce(latest.public_authority_epoch,0) <> cursor.authority_epoch`);
  const invalidEventTransitions = sqliteCount(database, `WITH ordered AS (
      SELECT source_id,sequence,owner_digest,revision,kind,authority_epoch,public_authority_epoch,
        lag(sequence,1,0) OVER(PARTITION BY source_id ORDER BY sequence) AS prior_sequence,
        lag(revision,1,0) OVER(PARTITION BY source_id,owner_digest ORDER BY sequence) AS prior_revision,
        lag(kind) OVER(PARTITION BY source_id,owner_digest ORDER BY sequence) AS prior_kind,
        lag(authority_epoch,1,0) OVER(PARTITION BY source_id,owner_digest ORDER BY sequence) AS prior_authority_epoch,
        lag(public_authority_epoch,1,0) OVER(PARTITION BY source_id ORDER BY sequence) AS prior_public_authority_epoch
      FROM analytics_applied_events
    )
    SELECT count(*) AS count FROM ordered
    WHERE sequence <> prior_sequence + 1
       OR revision <> prior_revision + 1
       OR authority_epoch <> prior_authority_epoch + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR public_authority_epoch <> prior_public_authority_epoch
          + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR prior_kind='owner-erased'
       OR (kind='source-updated' AND prior_kind IN ('owner-withdrawn','owner-erased'))
       OR (kind IN ('owner-withdrawn','owner-erased') AND prior_kind IS NULL)`);
  const orphanEventSources = sqliteCount(database, `SELECT count(*) AS count
    FROM analytics_applied_events event
    LEFT JOIN analytics_source_cursors cursor ON cursor.source_id=event.source_id
    LEFT JOIN analytics_runtime_sources runtime ON runtime.source_id=event.source_id
    WHERE cursor.source_id IS NULL OR runtime.source_id IS NULL`);
  const invalidEvents = sqliteCount(database, `SELECT count(*) AS count FROM analytics_applied_events
    WHERE sequence < 1 OR revision < 1 OR authority_epoch < 1 OR public_authority_epoch < 1 OR recorded_ms < 0
       OR kind NOT IN ('source-updated','owner-active','owner-withdrawn','owner-erased')
       OR length(event_digest) <> 64 OR event_digest GLOB '*[^0-9a-f]*'
       OR length(owner_digest) <> 64 OR owner_digest GLOB '*[^0-9a-f]*'
       OR length(object_digest) <> 64 OR object_digest GLOB '*[^0-9a-f]*'
       OR length(content_digest) <> 64 OR content_digest GLOB '*[^0-9a-f]*'`);
  const invalidOwners = sqliteCount(database, `WITH ranked AS (
      SELECT source_id,owner_digest,revision,authority_epoch,kind,
        row_number() OVER(PARTITION BY source_id,owner_digest ORDER BY sequence DESC) AS position
      FROM analytics_applied_events
    ), latest AS (SELECT * FROM ranked WHERE position=1), mismatches AS (
      SELECT latest.source_id FROM latest LEFT JOIN analytics_owner_state owner
        ON owner.source_id=latest.source_id AND owner.owner_digest=latest.owner_digest
       WHERE owner.source_id IS NULL OR owner.revision <> latest.revision
          OR owner.authority_epoch <> latest.authority_epoch
          OR owner.state <> CASE latest.kind WHEN 'owner-withdrawn' THEN 'withdrawn'
            WHEN 'owner-erased' THEN 'erased' ELSE 'active' END
      UNION ALL
      SELECT owner.source_id FROM analytics_owner_state owner LEFT JOIN latest
        ON latest.source_id=owner.source_id AND latest.owner_digest=owner.owner_digest
       WHERE latest.source_id IS NULL
    ) SELECT count(*) AS count FROM mismatches`);
  const unregisteredOwners = sqliteCount(database, `SELECT count(*) AS count FROM analytics_owner_state owner
    LEFT JOIN analytics_runtime_sources runtime ON runtime.source_id=owner.source_id
    WHERE runtime.source_id IS NULL OR owner.revision < 1 OR owner.authority_epoch < 1
       OR owner.state NOT IN ('active','withdrawn','erased')
       OR length(owner.owner_digest) <> 64 OR owner.owner_digest GLOB '*[^0-9a-f]*'`);
  if (invalidRegistrations || invalidCursorOrEvent || invalidEventTransitions || orphanEventSources || invalidEvents
      || invalidOwners || unregisteredOwners) fail("ANALYTICS_HISTORY_SOURCE_INTEGRITY_INVALID");
}

export async function createSealedSqliteAnalyticsHistorySource({ path, expectedSha256 } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("ANALYTICS_HISTORY_SQLITE_SHA256_REQUIRED");
  const initial = await fingerprintSqlite(path);
  if (initial.sha256 !== expectedSha256) fail("ANALYTICS_HISTORY_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("ANALYTICS_HISTORY_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("ANALYTICS_HISTORY_SQLITE_INTEGRITY_FAILED");
    }
    validateSqliteLayout(database);
    validateSqliteRows(database);
  } catch (error) {
    database?.close();
    if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
    fail("ANALYTICS_HISTORY_SQLITE_INVALID");
  }
  const prepared = new Map();
  const snapshot = Object.freeze({
    kind: "sealed-sqlite-rehearsal",
    snapshotId: `sha256:${expectedSha256}`,
    artifactSha256: expectedSha256,
    immutable: true,
  });
  let closed = false;
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("ANALYTICS_HISTORY_SQLITE_CLOSED");
      const actual = await fingerprintSqlite(path);
      if (actual.sha256 !== expectedSha256 || !sameStat(initial.stat, actual.stat)) {
        fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
      }
      return Object.freeze({ snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 });
    },
    async listPage({ table, after = null, limit } = {}) {
      if (closed) fail("ANALYTICS_HISTORY_SQLITE_CLOSED");
      const spec = SEALED_SOURCE_PAGE_SPEC_BY_NAME.get(table);
      if (!spec) fail("ANALYTICS_HISTORY_TABLE_INVALID");
      validatePageSize(limit);
      if (table === "analytics_source_cursors" && after !== null) validateSourceId(after);
      if (table === "analytics_owner_state" && after !== null) {
        if (!after || typeof after !== "object" || Array.isArray(after)) fail("ANALYTICS_HISTORY_CURSOR_INVALID");
        validateSourceId(after.sourceId);
        validateOwnerDigest(after.ownerDigest);
      }
      if (table === "analytics_applied_events" && after !== null) {
        if (!after || typeof after !== "object" || Array.isArray(after)) fail("ANALYTICS_HISTORY_CURSOR_INVALID");
        validateSourceId(after.sourceId);
        if (BigInt(normalizeInteger(after.sequence)) < 1n) fail("ANALYTICS_HISTORY_CURSOR_INVALID");
      }
      const statementKey = `${table}:${after === null ? "first" : "next"}`;
      let statement = prepared.get(statementKey);
      if (!statement) {
        const columns = spec.columns.map(column => `"${column}"`).join(",");
        const sql = table === "analytics_source_cursors"
          ? after === null
            ? `SELECT ${columns} FROM "${table}" ORDER BY source_id COLLATE BINARY LIMIT ?`
            : `SELECT ${columns} FROM "${table}" WHERE source_id COLLATE BINARY > ? COLLATE BINARY ORDER BY source_id COLLATE BINARY LIMIT ?`
          : table === "analytics_applied_events"
            ? after === null
              ? `SELECT ${columns} FROM "${table}" ORDER BY source_id COLLATE BINARY,sequence LIMIT ?`
              : `SELECT ${columns} FROM "${table}" WHERE source_id COLLATE BINARY > ? COLLATE BINARY
                  OR (source_id COLLATE BINARY = ? COLLATE BINARY AND sequence > ?)
                  ORDER BY source_id COLLATE BINARY,sequence LIMIT ?`
          : after === null
            ? `SELECT ${columns} FROM "${table}" ORDER BY source_id COLLATE BINARY, owner_digest COLLATE BINARY LIMIT ?`
            : `SELECT ${columns} FROM "${table}" WHERE source_id COLLATE BINARY > ? COLLATE BINARY
                OR (source_id = ? AND owner_digest COLLATE BINARY > ? COLLATE BINARY)
                ORDER BY source_id COLLATE BINARY, owner_digest COLLATE BINARY LIMIT ?`;
        try {
          statement = database.prepare(sql);
          statement.setReadBigInts(true);
          prepared.set(statementKey, statement);
        } catch {
          fail("ANALYTICS_HISTORY_SQLITE_READ_FAILED");
        }
      }
      try {
        let rawRows;
        if (table === "analytics_source_cursors") {
          rawRows = after === null ? statement.all(BigInt(limit)) : statement.all(after, BigInt(limit));
        } else if (table === "analytics_applied_events") {
          rawRows = after === null ? statement.all(BigInt(limit))
            : statement.all(after.sourceId, after.sourceId, BigInt(normalizeInteger(after.sequence)), BigInt(limit));
        } else if (after === null) rawRows = statement.all(BigInt(limit));
        else rawRows = statement.all(after.sourceId, after.sourceId, after.ownerDigest, BigInt(limit));
        if (rawRows.length > limit) fail("ANALYTICS_HISTORY_SOURCE_PAGE_INVALID");
        return Object.freeze({ rows: Object.freeze(rawRows.map(row => normalizeRow(spec, row))) });
      } catch (error) {
        if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
        fail("ANALYTICS_HISTORY_SQLITE_READ_FAILED");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      prepared.clear();
      database.close();
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

function assertSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || source.snapshot?.kind !== "sealed-sqlite-rehearsal"
      || source.snapshot?.immutable !== true || !SHA256.test(source.snapshot.artifactSha256 ?? "")
      || source.snapshot.snapshotId !== `sha256:${source.snapshot.artifactSha256}`) {
    fail("ANALYTICS_HISTORY_SEALED_SOURCE_REQUIRED");
  }
  return source.snapshot;
}

function quoteSchema(schema) {
  if (!SCHEMA.test(schema)) fail("ANALYTICS_HISTORY_SCHEMA_INVALID");
  return `"${schema}"`;
}

function relation(schema, name) {
  if (!SPEC_BY_NAME.has(name) && !TARGET_OPERATION_TABLES.includes(name) && name !== "collection_controls") {
    fail("ANALYTICS_HISTORY_TABLE_INVALID");
  }
  return `${quoteSchema(schema)}."${name}"`;
}

function cursorFor(spec, row) {
  if (spec.name === "analytics_source_cursors") return row.source_id;
  if (spec.name === "analytics_applied_events") {
    return Object.freeze({ sourceId: row.source_id, sequence: row.sequence });
  }
  return Object.freeze({ sourceId: row.source_id, ownerDigest: row.owner_digest });
}

function cursorIsAfter(spec, row, after) {
  if (after === null) return true;
  if (spec.name === "analytics_source_cursors") return row.source_id > after;
  if (spec.name === "analytics_applied_events") return row.source_id > after.sourceId
    || (row.source_id === after.sourceId && BigInt(row.sequence) > BigInt(after.sequence));
  return row.source_id > after.sourceId
    || (row.source_id === after.sourceId && row.owner_digest > after.ownerDigest);
}

function canonicalRow(spec, row) {
  return JSON.stringify(spec.columns.map(column => row[column]));
}

function updateRowHash(hash, spec, row) {
  hash.update(`${canonicalRow(spec, row)}\n`);
}

function manifestDigest(tables) {
  return sha256().update(JSON.stringify({
    schema: POSTGRES_ANALYTICS_HISTORY_TRANSFER_SCHEMA,
    tables: SPECS.map(spec => ({ name: spec.name, rowCount: tables[spec.name].rowCount,
      sha256: tables[spec.name].sha256 })),
  })).digest("hex");
}

async function scanSourceTable(source, spec, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  for (;;) {
    const page = await source.listPage({ table: spec.name, after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("ANALYTICS_HISTORY_SOURCE_PAGE_INVALID");
    for (const row of page.rows) {
      if (!cursorIsAfter(spec, row, after)) fail("ANALYTICS_HISTORY_SOURCE_ORDER_INVALID");
      updateRowHash(hash, spec, row);
      after = cursorFor(spec, row);
      rowCount += 1n;
    }
    if (page.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), sha256: hash.digest("hex") });
}

/**
 * Produce a content-free receipt for the sealed D1 event journal. Callers can
 * separately consume `source.listPage({ table: "analytics_applied_events" })`
 * for bounded row export; this scanner never writes to PostgreSQL or advances
 * an analytics cursor.
 */
export async function scanSealedSqliteAnalyticsEventJournal({
  source,
  pageSize = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
} = {}) {
  const snapshot = assertSource(source);
  const size = validatePageSize(pageSize);
  const initial = await source.verifySnapshot();
  if (initial?.snapshotId !== snapshot.snapshotId
      || initial?.artifactSha256 !== snapshot.artifactSha256) fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  let pagesRead = 0;
  for (;;) {
    const page = await source.listPage({ table: ANALYTICS_EVENT_SPEC.name, after, limit: size });
    if (!page || !Array.isArray(page.rows) || page.rows.length > size) {
      fail("ANALYTICS_HISTORY_SOURCE_PAGE_INVALID");
    }
    pagesRead += 1;
    for (const row of page.rows) {
      if (!cursorIsAfter(ANALYTICS_EVENT_SPEC, row, after)) fail("ANALYTICS_HISTORY_SOURCE_ORDER_INVALID");
      updateRowHash(hash, ANALYTICS_EVENT_SPEC, row);
      after = cursorFor(ANALYTICS_EVENT_SPEC, row);
      rowCount += 1n;
    }
    if (page.rows.length < size) break;
  }
  const final = await source.verifySnapshot();
  if (final?.snapshotId !== snapshot.snapshotId
      || final?.artifactSha256 !== snapshot.artifactSha256) fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
  return Object.freeze({
    schema: SEALED_ANALYTICS_EVENT_EXPORT_SCHEMA,
    sourceSnapshotSha256: snapshot.artifactSha256,
    eventRows: rowCount.toString(),
    eventRowsSha256: hash.digest("hex"),
    pageSize: size,
    pagesRead,
    postgresWrites: 0,
    sourceCursorAdvanced: false,
  });
}

async function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const spec of SPECS) tables[spec.name] = await scanSourceTable(source, spec, pageSize);
  return Object.freeze({ tables: Object.freeze(tables), sha256: manifestDigest(tables) });
}

function normalizeTargetRow(spec, raw) {
  return normalizeRow(spec, raw);
}

function sameRow(spec, left, right) {
  return spec.columns.every(column => left[column] === right[column]);
}

function insertSql(schema, spec, count) {
  const columns = spec.columns.map(column => `"${column}"`).join(",");
  const values = Array.from({ length: count }, (_, rowIndex) =>
    `(${spec.columns.map((_, columnIndex) => `$${rowIndex * spec.columns.length + columnIndex + 1}`).join(",")})`).join(",");
  const conflict = spec.key.map(column => `"${column}"`).join(",");
  return `INSERT INTO ${relation(schema, spec.name)} (${columns}) VALUES ${values}
    ON CONFLICT (${conflict}) DO NOTHING`;
}

function rowValues(spec, rows) {
  return rows.flatMap(row => spec.columns.map(column => row[column]));
}

async function assertContained(client, schema) {
  const controls = await client.query(`SELECT control_state,enrollment_enabled,upload_registration_enabled,
      processing_enabled,publication_enabled
    FROM ${relation(schema, "collection_controls")} WHERE singleton=1 FOR SHARE`);
  const row = controls.rows[0];
  if (controls.rowCount !== 1 || row.control_state !== "contained" || row.enrollment_enabled !== false
      || row.upload_registration_enabled !== false || row.processing_enabled !== false
      || row.publication_enabled !== false) fail("ANALYTICS_HISTORY_TARGET_NOT_CONTAINED");
}

async function assertNoTargetOperations(client, schema) {
  for (const table of TARGET_OPERATION_TABLES) {
    const result = await client.query(`SELECT EXISTS(SELECT 1 FROM ${relation(schema, table)} LIMIT 1) AS present`);
    if (result.rows[0]?.present !== false) fail("ANALYTICS_HISTORY_TARGET_NOT_EMPTY");
  }
}

async function validateTarget(client, schema) {
  const version = Number((await client.query("SHOW server_version_num")).rows?.[0]?.server_version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("ANALYTICS_HISTORY_POSTGRES_17_REQUIRED");
  for (const name of ["collection_controls", ...SPEC_BY_NAME.keys(), ...TARGET_OPERATION_TABLES]) {
    const result = await client.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`]);
    if (!result.rows?.[0]?.relation) fail("ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED");
  }
  return version;
}

async function acquireTargetLock(client, schema) {
  const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
    [`${schema}:analytics-history-state-transfer`]);
  if (result.rows?.[0]?.locked !== true) fail("ANALYTICS_HISTORY_TRANSFER_BUSY");
}

async function verifyTargetPage(client, schema, spec, sourceRows) {
  if (sourceRows.length === 0) return;
  const keyWidth = spec.key.length;
  const values = sourceRows.flatMap(row => spec.key.map(column => row[column]));
  const condition = sourceRows.map((_, rowIndex) => `(${spec.key.map((column, columnIndex) =>
    `"${column}"=$${rowIndex * keyWidth + columnIndex + 1}`).join(" AND ")})`).join(" OR ");
  const order = spec.key.map(column => `"${column}" COLLATE "C"`).join(",");
  const result = await client.query(`SELECT ${spec.columns.map(column => `"${column}"`).join(",")}
    FROM ${relation(schema, spec.name)} WHERE ${condition} ORDER BY ${order}`, values);
  if (result.rowCount !== sourceRows.length) fail("ANALYTICS_HISTORY_DESTINATION_ROW_MISMATCH");
  for (let index = 0; index < sourceRows.length; index += 1) {
    const target = normalizeTargetRow(spec, result.rows[index]);
    if (!sameRow(spec, sourceRows[index], target)) fail("ANALYTICS_HISTORY_DESTINATION_ROW_MISMATCH");
  }
}

async function copyTable({ client, schema, source, spec, pageSize }) {
  let after = null;
  let pagesCommitted = 0;
  let rowsInserted = 0n;
  let sawConflict = false;
  for (;;) {
    const { rows } = await source.listPage({ table: spec.name, after, limit: pageSize });
    if (rows.length === 0) break;
    try {
      await client.query("BEGIN");
      await assertContained(client, schema);
      const inserted = await client.query(insertSql(schema, spec, rows.length), rowValues(spec, rows));
      await verifyTargetPage(client, schema, spec, rows);
      after = cursorFor(spec, rows.at(-1));
      rowsInserted += BigInt(inserted.rowCount);
      if (inserted.rowCount !== rows.length) sawConflict = true;
      await client.query("COMMIT");
      pagesCommitted += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
      fail("ANALYTICS_HISTORY_PAGE_COMMIT_FAILED");
    }
  }
  return Object.freeze({ pagesCommitted, rowsInserted: rowsInserted.toString(), sawConflict });
}

function targetPageSql(schema, spec, after, pageSize) {
  const columns = spec.columns.map(column => `"${column}"`).join(",");
  if (spec.name === "analytics_source_cursors") {
    if (after === null) return { sql: `SELECT ${columns} FROM ${relation(schema, spec.name)}
      ORDER BY source_id COLLATE "C" LIMIT $1`, values: [pageSize] };
    return { sql: `SELECT ${columns} FROM ${relation(schema, spec.name)}
      WHERE source_id COLLATE "C" > $1::text COLLATE "C"
      ORDER BY source_id COLLATE "C" LIMIT $2`, values: [after, pageSize] };
  }
  if (after === null) return { sql: `SELECT ${columns} FROM ${relation(schema, spec.name)}
    ORDER BY source_id COLLATE "C",owner_digest COLLATE "C" LIMIT $1`, values: [pageSize] };
  return { sql: `SELECT ${columns} FROM ${relation(schema, spec.name)}
    WHERE source_id COLLATE "C" > $1::text COLLATE "C"
       OR (source_id = $1 AND owner_digest COLLATE "C" > $2::text COLLATE "C")
    ORDER BY source_id COLLATE "C",owner_digest COLLATE "C" LIMIT $3`,
  values: [after.sourceId, after.ownerDigest, pageSize] };
}

async function scanTargetTable(client, schema, spec, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  for (;;) {
    const { sql, values } = targetPageSql(schema, spec, after, pageSize);
    const result = await client.query(sql, values);
    const rows = result.rows.map(row => normalizeTargetRow(spec, row));
    if (rows.length > pageSize) fail("ANALYTICS_HISTORY_DESTINATION_PAGE_INVALID");
    for (const row of rows) {
      if (!cursorIsAfter(spec, row, after)) fail("ANALYTICS_HISTORY_DESTINATION_ORDER_INVALID");
      updateRowHash(hash, spec, row);
      after = cursorFor(spec, row);
      rowCount += 1n;
    }
    if (rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), sha256: hash.digest("hex") });
}

async function scanTarget(client, schema, pageSize) {
  const tables = Object.create(null);
  for (const spec of SPECS) tables[spec.name] = await scanTargetTable(client, schema, spec, pageSize);
  return Object.freeze({ tables: Object.freeze(tables), sha256: manifestDigest(tables) });
}

function sameManifest(source, target) {
  return SPECS.every(spec => source.tables[spec.name].rowCount === target.tables[spec.name].rowCount
    && source.tables[spec.name].sha256 === target.tables[spec.name].sha256);
}

/**
 * Stage only the D1 owner-state and source-cursor rows that already have exact
 * PostgreSQL counterparts. The target must remain contained and have no
 * analytics events, work, results, or publications. Inserts are exact and
 * idempotent; a restart replays prior pages and verifies conflicts. This does
 * not transfer the applied-event journal or any public publication, and it
 * does not qualify continuity, a reader, publication, or cutover.
 */
export async function transferPostgresAnalyticsHistoryState({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  pageSize = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = typeof rawTargetSchema === "string" ? rawTargetSchema : "";
  const suffix = schema.startsWith(POSTGRES_ANALYTICS_HISTORY_TARGET_SCHEMA_PREFIX)
    ? schema.slice(POSTGRES_ANALYTICS_HISTORY_TARGET_SCHEMA_PREFIX.length) : "";
  if (!SCHEMA.test(schema) || !TARGET_SUFFIX.test(suffix)) fail("ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED");
  const size = validatePageSize(pageSize);
  const snapshot = assertSource(source);
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED");
  await source.verifySnapshot();
  const client = await destinationPool.connect();
  let lockHeld = false;
  try {
    const postgresVersion = await validateTarget(client, schema);
    await acquireTargetLock(client, schema);
    lockHeld = true;
    await assertContained(client, schema);
    await assertNoTargetOperations(client, schema);
    const sourceManifest = await scanSource(source, size);
    let pagesCommitted = 0;
    let rowsInserted = 0n;
    let resumed = false;
    for (const spec of SPECS) {
      const copied = await copyTable({ client, schema, source, spec, pageSize: size });
      pagesCommitted += copied.pagesCommitted;
      rowsInserted += BigInt(copied.rowsInserted);
      resumed ||= copied.sawConflict;
    }
    await source.verifySnapshot();
    const finalSourceManifest = await scanSource(source, size);
    if (finalSourceManifest.sha256 !== sourceManifest.sha256) fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
    await assertContained(client, schema);
    await assertNoTargetOperations(client, schema);
    const targetManifest = await scanTarget(client, schema, size);
    if (!sameManifest(sourceManifest, targetManifest)) fail("ANALYTICS_HISTORY_SOURCE_DESTINATION_PARITY_FAILED");
    return Object.freeze({
      schema: POSTGRES_ANALYTICS_HISTORY_TRANSFER_SCHEMA,
      status: "partial_analytics_state_cursor_stage_complete",
      targetSchema: schema,
      postgresMajor: Math.floor(postgresVersion / 10_000),
      sourceSnapshotSha256: snapshot.artifactSha256,
      sourceManifestSha256: sourceManifest.sha256,
      targetManifestSha256: targetManifest.sha256,
      tables: Object.freeze(Object.fromEntries(SPECS.map(spec => [spec.name, Object.freeze({
        sourceRows: sourceManifest.tables[spec.name].rowCount,
        targetRows: targetManifest.tables[spec.name].rowCount,
        sourceSha256: sourceManifest.tables[spec.name].sha256,
        targetSha256: targetManifest.tables[spec.name].sha256,
      })]))),
      pageSize: size,
      pagesCommitted,
      rowsInserted: rowsInserted.toString(),
      resumed,
      restartMode: "replay_pages_and_verify_existing_rows",
      fullAnalyticsTransfer: false,
      limitations: Object.freeze({
        appliedEventJournalTransferred: false,
        historicalPublicationRowsTransferred: false,
        sourceNamespaceRegistryTransferred: false,
        analyticsContinuityQualified: false,
        readerEnabled: false,
        publicationEnabled: false,
        productionCutoverAuthorized: false,
      }),
    });
  } finally {
    if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:analytics-history-state-transfer`]).catch(() => {});
    client.release();
  }
}

export const POSTGRES_ANALYTICS_HISTORY_SOURCE_COLUMNS = Object.freeze(
  Object.fromEntries(Object.entries(SOURCE_TABLES).map(([name, spec]) => [name, spec.columns])),
);
