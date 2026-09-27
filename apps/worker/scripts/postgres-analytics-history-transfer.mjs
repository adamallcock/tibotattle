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
export const POSTGRES_ANALYTICS_HISTORY_BOOTSTRAP_TARGET_SCHEMA_PREFIX = "storage_journal_transfer_target_";

const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const APPLIED_MAIN_TRANSFER_ID = /^synthetic-analytics-applied-main-[A-Za-z0-9._-]{1,96}$/u;
const INGESTION_JOURNAL_TRANSFER_ID = /^synthetic-ingestion-journal-[A-Za-z0-9._-]{1,96}$/u;
const APPLIED_MAIN_RUNS = "_synthetic_analytics_applied_main_transfer_runs_v1";
const APPLIED_MAIN_CHECKPOINTS = "_synthetic_analytics_applied_main_transfer_checkpoints_v1";
const INGESTION_JOURNAL_RUNS = "_storage_ingestion_journal_transfer_runs_v1";
const INGESTION_JOURNAL_CHECKPOINTS = "_storage_ingestion_journal_transfer_checkpoints_v1";
const MAX_INGESTION_JOURNAL_PAGE_SIZE = 250;
const TRUSTED_SOURCES = new WeakSet();
const SEALED_RUNTIME_SOURCE_REGISTRY_READERS = new WeakMap();
const RUNTIME_SOURCE_REGISTRY_SUBSET = "source_id_ascii_1_to_128_initial_alphanumeric_then_alphanumeric_colon_underscore_hyphen; namespace_utf8_bytes_1_to_256_and_unicode_characters_1_to_200_without_controls; contract_version_1";

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
  "storage_ingestion_changes",
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

function readSealedRuntimeSourceRegistryPage(source, { after = null, limit } = {}) {
  assertSource(source);
  validatePageSize(limit);
  const reader = SEALED_RUNTIME_SOURCE_REGISTRY_READERS.get(source);
  if (!reader) fail("ANALYTICS_HISTORY_SEALED_SOURCE_REQUIRED");
  try {
    return reader({ after, limit });
  } catch (error) {
    if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_READ_FAILED");
  }
}

function validateRuntimeSourceRegistryTuple(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.source_id !== "string"
      || !SOURCE_ID.test(raw.source_id) || typeof raw.source_namespace !== "string"
      || raw.contract_version !== 1) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TUPLE_UNSUPPORTED");
  }
  const namespace = raw.source_namespace;
  const codePointLength = [...namespace].length;
  const namespaceBytes = Buffer.from(namespace, "utf8");
  // D1 leaves these identifiers unbounded. This rehearsal deliberately accepts
  // only the existing transfer subset plus the 0092 text bounds; other D1-valid
  // tuples are refused unchanged, so this is not full D1 registry parity.
  if (namespaceBytes.byteLength < 1 || namespaceBytes.byteLength > 256
      || namespaceBytes.toString("utf8") !== namespace
      || codePointLength < 1 || codePointLength > 200 || /\p{Cc}/u.test(namespace)) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TUPLE_UNSUPPORTED");
  }
  return Object.freeze({ source_id: raw.source_id, source_namespace: namespace, contract_version: 1 });
}

function validatePostgresRuntimeSourceRegistryTuple(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.source_id !== "string"
      || [...raw.source_id].length < 1 || [...raw.source_id].length > 200 || /\p{Cc}/u.test(raw.source_id)
      || typeof raw.source_namespace !== "string" || raw.contract_version !== 1) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_ROW_INVALID");
  }
  const namespace = raw.source_namespace;
  const namespaceBytes = Buffer.from(namespace, "utf8");
  if (namespaceBytes.toString("utf8") !== namespace || [...namespace].length < 1
      || [...namespace].length > 200 || /\p{Cc}/u.test(namespace)) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_ROW_INVALID");
  }
  return Object.freeze({ source_id: raw.source_id, source_namespace: namespace, contract_version: 1 });
}

function updateRuntimeSourceRegistryHash(hash, row) {
  hash.update(`${JSON.stringify([row.source_id, row.source_namespace, row.contract_version])}\n`);
}

function compareUtf8BinaryText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function scanRuntimeSourceRegistrySource(source, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  let pagesRead = 0;
  for (;;) {
    const page = readSealedRuntimeSourceRegistryPage(source, { after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_PAGE_INVALID");
    }
    pagesRead += 1;
    for (const raw of page.rows) {
      const row = validateRuntimeSourceRegistryTuple(raw);
      if (after !== null && row.source_id <= after) fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_ORDER_INVALID");
      updateRuntimeSourceRegistryHash(hash, row);
      after = row.source_id;
      rowCount += 1n;
    }
    if (page.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), sha256: hash.digest("hex"), pagesRead });
}

async function scanRuntimeSourceRegistryTarget(client, schema, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  let pagesRead = 0;
  for (;;) {
    let result;
    try {
      result = after === null
        ? await client.query(`SELECT source_id,source_namespace,contract_version
            FROM ${relation(schema, "analytics_runtime_sources")}
            ORDER BY source_id COLLATE "C" LIMIT $1`, [pageSize])
        : await client.query(`SELECT source_id,source_namespace,contract_version
            FROM ${relation(schema, "analytics_runtime_sources")}
            WHERE source_id COLLATE "C" > $1::text COLLATE "C"
            ORDER BY source_id COLLATE "C" LIMIT $2`, [after, pageSize]);
    } catch {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_READ_FAILED");
    }
    if (!Array.isArray(result?.rows) || result.rows.length > pageSize) {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_READ_FAILED");
    }
    pagesRead += 1;
    for (const raw of result.rows) {
      const row = validatePostgresRuntimeSourceRegistryTuple({
        source_id: raw.source_id,
        source_namespace: raw.source_namespace,
        contract_version: Number(raw.contract_version),
      });
      if (after !== null && compareUtf8BinaryText(row.source_id, after) <= 0) {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_ORDER_INVALID");
      }
      updateRuntimeSourceRegistryHash(hash, row);
      after = row.source_id;
      rowCount += 1n;
    }
    if (result.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), sha256: hash.digest("hex"), pagesRead });
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
    async sourceIdentityManifest() {
      if (closed) fail("ANALYTICS_HISTORY_SQLITE_CLOSED");
      const registrations = database.prepare(`SELECT source_id,source_namespace,contract_version
        FROM analytics_runtime_sources ORDER BY source_id COLLATE BINARY`).all();
      const cursorStatement = database.prepare(`SELECT source_id,sequence,authority_epoch
        FROM analytics_source_cursors ORDER BY source_id COLLATE BINARY`);
      cursorStatement.setReadBigInts(true);
      const cursors = cursorStatement.all();
      return Object.freeze({
        runtimeSources: Object.freeze(registrations.map(row => Object.freeze({
          sourceId: row.source_id,
          namespaceSha256: sha256().update(row.source_namespace).digest("hex"),
          contractVersion: Number(row.contract_version),
        }))),
        sourceCursors: Object.freeze(cursors.map(row => Object.freeze({
          sourceId: row.source_id,
          sequence: normalizeInteger(row.sequence),
          authorityEpoch: normalizeInteger(row.authority_epoch),
        }))),
      });
    },
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
  SEALED_RUNTIME_SOURCE_REGISTRY_READERS.set(source, ({ after = null, limit } = {}) => {
    if (closed) fail("ANALYTICS_HISTORY_SQLITE_CLOSED");
    validatePageSize(limit);
    if (after !== null) validateSourceId(after);
    const key = `analytics_runtime_sources:${after === null ? "first" : "next"}`;
    let statement = prepared.get(key);
    if (!statement) {
      const columns = SOURCE_TABLES.analytics_runtime_sources.columns.map(column => `"${column}"`).join(",");
      const sql = after === null
        ? `SELECT ${columns} FROM "analytics_runtime_sources" ORDER BY source_id COLLATE BINARY LIMIT ?`
        : `SELECT ${columns} FROM "analytics_runtime_sources" WHERE source_id COLLATE BINARY > ? COLLATE BINARY
            ORDER BY source_id COLLATE BINARY LIMIT ?`;
      try {
        statement = database.prepare(sql);
        prepared.set(key, statement);
      } catch {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_READ_FAILED");
      }
    }
    try {
      const rows = after === null ? statement.all(BigInt(limit)) : statement.all(after, BigInt(limit));
      if (rows.length > limit) fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_PAGE_INVALID");
      return Object.freeze({ rows: Object.freeze(rows.map(row => Object.freeze({
        source_id: row.source_id,
        source_namespace: row.source_namespace,
        contract_version: Number(row.contract_version),
      }))) });
    } catch (error) {
      if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_READ_FAILED");
    }
  });
  return source;
}

/** Return a content-free identity binding for a trusted sealed analytics artifact. */
export async function inspectSealedSqliteAnalyticsSourceIdentity(source) {
  const snapshot = assertSource(source);
  if (typeof source.sourceIdentityManifest !== "function") fail("ANALYTICS_HISTORY_SEALED_SOURCE_REQUIRED");
  let identity;
  try {
    identity = await source.sourceIdentityManifest();
  } catch {
    fail("ANALYTICS_HISTORY_SOURCE_IDENTITY_INVALID");
  }
  if (!Array.isArray(identity?.runtimeSources) || !Array.isArray(identity?.sourceCursors)
      || identity.runtimeSources.length !== 1 || identity.sourceCursors.length !== 1) {
    fail("ANALYTICS_HISTORY_SOURCE_IDENTITY_NOT_SINGLETON");
  }
  const [runtime] = identity.runtimeSources;
  const [cursor] = identity.sourceCursors;
  if (!runtime || runtime.sourceId !== cursor?.sourceId || !SOURCE_ID.test(runtime.sourceId ?? "")
      || runtime.contractVersion !== 1 || !SHA256.test(runtime.namespaceSha256 ?? "")
      || normalizeInteger(cursor.sequence) !== cursor.sequence
      || normalizeInteger(cursor.authorityEpoch) !== cursor.authorityEpoch
      || BigInt(cursor.sequence) < 0n || BigInt(cursor.authorityEpoch) < 0n) {
    fail("ANALYTICS_HISTORY_SOURCE_IDENTITY_INVALID");
  }
  const verified = await source.verifySnapshot();
  if (verified?.snapshotId !== snapshot.snapshotId || verified?.artifactSha256 !== snapshot.artifactSha256) {
    fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
  }
  return Object.freeze({ snapshotId: snapshot.snapshotId, snapshotSha256: snapshot.artifactSha256,
    sourceId: runtime.sourceId, namespaceSha256: runtime.namespaceSha256,
    contractVersion: runtime.contractVersion, sourceSequence: cursor.sequence, sourceAuthorityEpoch: cursor.authorityEpoch });
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
  if (!SPEC_BY_NAME.has(name) && !TARGET_OPERATION_TABLES.includes(name) && name !== "collection_controls"
      && name !== "analytics_runtime_sources"
      && !["storage_source_state", APPLIED_MAIN_RUNS, APPLIED_MAIN_CHECKPOINTS, INGESTION_JOURNAL_RUNS,
        INGESTION_JOURNAL_CHECKPOINTS].includes(name)) {
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

async function assertNoTargetOperations(client, schema, { allowAppliedEventLane = false } = {}) {
  for (const table of TARGET_OPERATION_TABLES) {
    if (allowAppliedEventLane && (table === "analytics_applied_events" || table === "storage_ingestion_changes")) {
      continue;
    }
    const result = await client.query(`SELECT EXISTS(SELECT 1 FROM ${relation(schema, table)} LIMIT 1) AS present`);
    if (result.rows[0]?.present !== false) fail("ANALYTICS_HISTORY_TARGET_NOT_EMPTY");
  }
}

function validateAppliedEventTransfer(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "journalSource,journalTransferId,transferId"
      || !APPLIED_MAIN_TRANSFER_ID.test(value.transferId ?? "")
      || !INGESTION_JOURNAL_TRANSFER_ID.test(value.journalTransferId ?? "")) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  return value;
}

function transferHashChain(previous, spec, rows) {
  const hash = sha256();
  hash.update(`${previous}\n`);
  for (const row of rows) hash.update(`${canonicalRow(spec, row)}\n`);
  return hash.digest("hex");
}

function pageCount(rowCount, pageSize) {
  const count = BigInt(rowCount);
  if (count === 0n) return 0;
  return Number((count + BigInt(pageSize) - 1n) / BigInt(pageSize));
}

async function scanBootstrapSources({ source, journalSource, pageSize }) {
  try {
    assertSource(source);
    const identity = await inspectSealedSqliteAnalyticsSourceIdentity(source);
    const { scanSealedSqliteIngestionJournal } = await import("./postgres-ingestion-journal-transfer.mjs");
    const [events, journal] = await Promise.all([
      scanSealedSqliteAnalyticsEventJournal({ source, pageSize }),
      scanSealedSqliteIngestionJournal({ source: journalSource, pageSize }),
    ]);
    const journalSourceId = journalSource?.snapshot?.sourceId;
    const journalAuthorityEpoch = normalizeInteger(journalSource?.snapshot?.sourceAuthorityEpoch);
    if (identity.contractVersion !== 1 || identity.sourceSequence !== events.eventRows
        || identity.snapshotSha256 !== events.sourceSnapshotSha256
        || identity.sourceId !== journalSourceId || identity.sourceAuthorityEpoch !== journalAuthorityEpoch
        || journal.sourceIdSha256 !== sha256().update(identity.sourceId).digest("hex")
        || journal.sourceSnapshotSha256 !== journalSource.snapshot.artifactSha256
        || journal.sourceAuthorityEpoch !== identity.sourceAuthorityEpoch
        || journal.eventRows !== events.eventRows || journal.eventRowsSha256 !== events.eventRowsSha256
        || journal.lastSequence !== identity.sourceSequence) {
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    return Object.freeze({ identity, events, journal });
  } catch (error) {
    if (error instanceof PostgresAnalyticsHistoryTransferError) {
      if (error.code === "ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED") throw error;
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
}

async function readVerifiedJournalRows(client, schema, sourceId, sourceRows) {
  if (sourceRows.length === 0) return [];
  const columns = ANALYTICS_EVENT_SPEC.columns.map(column => `"${column}"`).join(",");
  let result;
  try {
    result = await client.query(`SELECT ${columns},owner_revision::text AS owner_revision,event_tuple_version
      FROM ${relation(schema, "storage_ingestion_changes")}
      WHERE source_id=$1 AND sequence BETWEEN $2 AND $3 ORDER BY sequence`,
    [sourceId, sourceRows[0].sequence, sourceRows.at(-1).sequence]);
  } catch { fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED"); }
  if (result.rowCount !== sourceRows.length) fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  const rows = [];
  for (let index = 0; index < sourceRows.length; index += 1) {
    let row;
    try { row = normalizeRow(ANALYTICS_EVENT_SPEC, result.rows[index]); }
    catch { fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED"); }
    if (normalizeInteger(result.rows[index].owner_revision) !== "0"
        || normalizeInteger(result.rows[index].event_tuple_version) !== "1"
        || !sameRow(ANALYTICS_EVENT_SPEC, sourceRows[index], row)) {
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    rows.push(row);
  }
  return rows;
}

async function readVerifiedAppliedRows(client, schema, sourceId, sourceRows) {
  if (sourceRows.length === 0) return [];
  const columns = ANALYTICS_EVENT_SPEC.columns.map(column => `"${column}"`).join(",");
  let result;
  try {
    result = await client.query(`SELECT ${columns},projection_json,event_tuple_version
      FROM ${relation(schema, "analytics_applied_events")}
      WHERE source_id=$1 AND sequence BETWEEN $2 AND $3 ORDER BY sequence`,
    [sourceId, sourceRows[0].sequence, sourceRows.at(-1).sequence]);
  } catch { fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED"); }
  if (result.rowCount !== sourceRows.length) fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  const rows = [];
  for (let index = 0; index < sourceRows.length; index += 1) {
    let row;
    try { row = normalizeRow(ANALYTICS_EVENT_SPEC, result.rows[index]); }
    catch { fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED"); }
    if (result.rows[index].projection_json !== null
        || normalizeInteger(result.rows[index].event_tuple_version) !== "1"
        || !sameRow(ANALYTICS_EVENT_SPEC, sourceRows[index], row)) {
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    rows.push(row);
  }
  return rows;
}

async function verifyBootstrapJournalTarget({ client, schema, journalSource, identity, journal, run, checkpoint }) {
  const size = run.page_size;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INGESTION_JOURNAL_PAGE_SIZE
      || run.source_snapshot_id !== `sha256:${journal.sourceSnapshotSha256}`
      || run.source_snapshot_sha256 !== journal.sourceSnapshotSha256 || run.source_id !== identity.sourceId
      || normalizeInteger(run.source_authority_epoch) !== identity.sourceAuthorityEpoch
      || normalizeInteger(run.source_row_count) !== journal.eventRows
      || run.source_rows_sha256 !== journal.eventRowsSha256
      || normalizeInteger(run.last_sequence) !== journal.lastSequence || run.status !== "complete" || !run.completed_at
      || normalizeInteger(checkpoint.last_sequence) !== journal.lastSequence
      || normalizeInteger(checkpoint.row_count) !== journal.eventRows || checkpoint.page_count !== pageCount(journal.eventRows, size)
      || checkpoint.complete !== true || !SHA256.test(checkpoint.prefix_chain_sha256 ?? "")) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  let count = 0n;
  let sourceHash = sha256();
  let targetHash = sha256();
  let chain = sha256().digest("hex");
  let pages = 0;
  let afterSequence = null;
  for (;;) {
    const page = await journalSource.listPage({ after: afterSequence, limit: size });
    if (!page || !Array.isArray(page.rows) || page.rows.length > size) {
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    const sourceRows = page.rows.map(row => normalizeRow(ANALYTICS_EVENT_SPEC, row));
    let sourceCursor = afterSequence === null ? null : { sourceId: identity.sourceId, sequence: afterSequence };
    for (const row of sourceRows) {
      if (row.source_id !== identity.sourceId || !cursorIsAfter(ANALYTICS_EVENT_SPEC, row, sourceCursor)) {
        fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
      }
      sourceCursor = { sourceId: row.source_id, sequence: row.sequence };
      updateRowHash(sourceHash, ANALYTICS_EVENT_SPEC, row);
      count += 1n;
    }
    if (sourceRows.length) {
      const targetRows = await readVerifiedJournalRows(client, schema, identity.sourceId, sourceRows);
      for (const row of targetRows) updateRowHash(targetHash, ANALYTICS_EVENT_SPEC, row);
      chain = transferHashChain(chain, ANALYTICS_EVENT_SPEC, sourceRows);
      pages += 1;
      afterSequence = sourceRows.at(-1).sequence;
    }
    if (sourceRows.length < size) break;
  }
  const totals = await client.query(`SELECT count(*)::text AS rows,
      count(*) FILTER (WHERE source_id<>$1)::text AS foreign_rows,
      count(*) FILTER (WHERE event_tuple_version<>1 OR owner_revision<>0)::text AS unqualified_rows
    FROM ${relation(schema, "storage_ingestion_changes")}`, [identity.sourceId]);
  if (count.toString() !== journal.eventRows || sourceHash.digest("hex") !== journal.eventRowsSha256
      || targetHash.digest("hex") !== journal.eventRowsSha256 || pages !== checkpoint.page_count
      || chain !== checkpoint.prefix_chain_sha256 || totals.rows[0]?.rows !== journal.eventRows
      || totals.rows[0]?.foreign_rows !== "0" || totals.rows[0]?.unqualified_rows !== "0") {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
}

async function verifyBootstrapAppliedTarget({ client, schema, source, identity, events, run, checkpoint }) {
  const size = run.page_size;
  if (!Number.isSafeInteger(size) || size < 1 || size > POSTGRES_ANALYTICS_HISTORY_MAX_PAGE_SIZE
      || run.source_snapshot_id !== identity.snapshotId || run.source_snapshot_sha256 !== identity.snapshotSha256
      || run.source_id !== identity.sourceId || run.source_namespace_sha256 !== identity.namespaceSha256
      || run.source_contract_version !== identity.contractVersion
      || normalizeInteger(run.source_sequence) !== identity.sourceSequence
      || normalizeInteger(run.source_authority_epoch) !== identity.sourceAuthorityEpoch
      || normalizeInteger(run.source_event_count) !== events.eventRows
      || run.source_events_sha256 !== events.eventRowsSha256 || run.status !== "complete" || !run.completed_at
      || checkpoint.last_source_id !== (events.eventRows === "0" ? null : identity.sourceId)
      || (events.eventRows === "0" ? checkpoint.last_sequence !== null
        : normalizeInteger(checkpoint.last_sequence) !== identity.sourceSequence)
      || normalizeInteger(checkpoint.row_count) !== events.eventRows
      || checkpoint.page_count !== pageCount(events.eventRows, size) || checkpoint.complete !== true
      || !SHA256.test(checkpoint.prefix_chain_sha256 ?? "")) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  let after = null;
  let count = 0n;
  let sourceHash = sha256();
  let targetHash = sha256();
  let chain = sha256().digest("hex");
  let pages = 0;
  for (;;) {
    const page = await source.listPage({ table: ANALYTICS_EVENT_SPEC.name, after, limit: size });
    if (!page || !Array.isArray(page.rows) || page.rows.length > size) {
      fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    }
    const sourceRows = page.rows.map(row => normalizeRow(ANALYTICS_EVENT_SPEC, row));
    let sourceCursor = after;
    for (const row of sourceRows) {
      if (row.source_id !== identity.sourceId || !cursorIsAfter(ANALYTICS_EVENT_SPEC, row, sourceCursor)) {
        fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
      }
      sourceCursor = cursorFor(ANALYTICS_EVENT_SPEC, row);
      updateRowHash(sourceHash, ANALYTICS_EVENT_SPEC, row);
      count += 1n;
    }
    if (sourceRows.length) {
      const targetRows = await readVerifiedAppliedRows(client, schema, identity.sourceId, sourceRows);
      for (const row of targetRows) updateRowHash(targetHash, ANALYTICS_EVENT_SPEC, row);
      chain = transferHashChain(chain, ANALYTICS_EVENT_SPEC, sourceRows);
      pages += 1;
      after = cursorFor(ANALYTICS_EVENT_SPEC, sourceRows.at(-1));
    }
    if (sourceRows.length < size) break;
  }
  const totals = await client.query(`SELECT count(*)::text AS rows,
      count(*) FILTER (WHERE source_id<>$1)::text AS foreign_rows,
      count(*) FILTER (WHERE event_tuple_version<>1 OR projection_json IS NOT NULL)::text AS unqualified_rows
    FROM ${relation(schema, "analytics_applied_events")}`, [identity.sourceId]);
  if (count.toString() !== events.eventRows || sourceHash.digest("hex") !== events.eventRowsSha256
      || targetHash.digest("hex") !== events.eventRowsSha256 || pages !== checkpoint.page_count
      || chain !== checkpoint.prefix_chain_sha256 || totals.rows[0]?.rows !== events.eventRows
      || totals.rows[0]?.foreign_rows !== "0" || totals.rows[0]?.unqualified_rows !== "0") {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
}

async function verifyAppliedEventBootstrap({ client, schema, source, appliedEventTransfer, pageSize }) {
  const manifests = await scanBootstrapSources({ source, journalSource: appliedEventTransfer.journalSource, pageSize });
  let sourceState;
  let triggerCount;
  let mainRun;
  let mainCheckpoint;
  let journalRun;
  let journalCheckpoint;
  try {
    sourceState = await client.query(`SELECT singleton,source_id,authority_epoch::text AS authority_epoch
      FROM ${relation(schema, "storage_source_state")}`);
    triggerCount = await client.query(`SELECT count(*)::int AS count FROM pg_trigger trigger_row
        JOIN pg_class relation_row ON relation_row.oid=trigger_row.tgrelid
        JOIN pg_namespace namespace_row ON namespace_row.oid=relation_row.relnamespace
        WHERE namespace_row.nspname=$1 AND relation_row.relname='analytics_applied_events'
          AND NOT trigger_row.tgisinternal`, [schema]);
    mainRun = await client.query(`SELECT source_snapshot_id,source_snapshot_sha256,source_id,source_namespace_sha256,
          source_contract_version,source_sequence::text AS source_sequence,
          source_authority_epoch::text AS source_authority_epoch,source_event_count::text AS source_event_count,
          source_events_sha256,journal_transfer_id,journal_source_snapshot_id,journal_source_snapshot_sha256,
          journal_rows_sha256,page_size,last_source_id,last_sequence::text AS last_sequence,status,completed_at
        FROM ${relation(schema, APPLIED_MAIN_RUNS)} WHERE transfer_id=$1`, [appliedEventTransfer.transferId]);
    mainCheckpoint = await client.query(`SELECT last_source_id,last_sequence::text AS last_sequence,row_count::text AS row_count,
          page_count,prefix_chain_sha256,complete FROM ${relation(schema, APPLIED_MAIN_CHECKPOINTS)} WHERE transfer_id=$1`,
    [appliedEventTransfer.transferId]);
    journalRun = await client.query(`SELECT source_snapshot_id,source_snapshot_sha256,source_id,
          source_authority_epoch::text AS source_authority_epoch,source_row_count::text AS source_row_count,
          source_rows_sha256,page_size,last_sequence::text AS last_sequence,status,completed_at
        FROM ${relation(schema, INGESTION_JOURNAL_RUNS)} WHERE transfer_id=$1`, [appliedEventTransfer.journalTransferId]);
    journalCheckpoint = await client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
          page_count,prefix_chain_sha256,complete FROM ${relation(schema, INGESTION_JOURNAL_CHECKPOINTS)}
        WHERE transfer_id=$1`, [appliedEventTransfer.journalTransferId]);
  } catch { fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED"); }
  if (sourceState.rowCount !== 1 || sourceState.rows[0]?.singleton !== 1
      || sourceState.rows[0]?.source_id !== manifests.identity.sourceId
      || normalizeInteger(sourceState.rows[0]?.authority_epoch) !== manifests.identity.sourceAuthorityEpoch
      || triggerCount.rows[0]?.count !== 0) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  const run = mainRun.rows[0];
  const checkpoint = mainCheckpoint.rows[0];
  const journalRunRow = journalRun.rows[0];
  const journalCheckpointRow = journalCheckpoint.rows[0];
  if (mainRun.rowCount !== 1 || mainCheckpoint.rowCount !== 1 || journalRun.rowCount !== 1
      || journalCheckpoint.rowCount !== 1 || run.journal_transfer_id !== appliedEventTransfer.journalTransferId
      || run.journal_source_snapshot_id !== `sha256:${manifests.journal.sourceSnapshotSha256}`
      || run.journal_source_snapshot_sha256 !== manifests.journal.sourceSnapshotSha256
      || run.journal_rows_sha256 !== manifests.journal.eventRowsSha256
      || run.last_source_id !== checkpoint.last_source_id || run.last_sequence !== checkpoint.last_sequence) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  await verifyBootstrapJournalTarget({ client, schema, journalSource: appliedEventTransfer.journalSource,
    identity: manifests.identity, journal: manifests.journal, run: journalRunRow, checkpoint: journalCheckpointRow });
  await verifyBootstrapAppliedTarget({ client, schema, source, identity: manifests.identity,
    events: manifests.events, run, checkpoint });
  return Object.freeze({
    sourceSnapshotSha256: manifests.identity.snapshotSha256,
    sourceNamespaceSha256: manifests.identity.namespaceSha256,
    eventRows: manifests.events.eventRows,
    eventRowsSha256: manifests.events.eventRowsSha256,
    journalSnapshotSha256: manifests.journal.sourceSnapshotSha256,
    journalRows: manifests.journal.eventRows,
    journalRowsSha256: manifests.journal.eventRowsSha256,
  });
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

async function validateRuntimeSourceRegistryTarget(client, schema) {
  let server;
  try {
    server = await client.query(`SELECT current_setting('server_version_num')::integer AS version,
      current_setting('server_encoding') AS encoding,inet_server_addr() AS address`);
  } catch {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  const row = server.rows?.[0];
  const version = Number(row?.version);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) {
    fail("ANALYTICS_HISTORY_POSTGRES_17_REQUIRED");
  }
  if (row?.address !== null || row?.encoding !== "UTF8") {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_LOCAL_TARGET_REQUIRED");
  }
  for (const name of ["collection_controls", "analytics_runtime_sources"]) {
    let relationResult;
    try {
      relationResult = await client.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`]);
    } catch {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
    }
    if (!relationResult.rows?.[0]?.relation) fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  const registryConstraints = new Map([
    ["analytics_runtime_sources_pkey", ["p", "PRIMARY KEY (source_id)"]],
    ["analytics_runtime_sources_source_id_check", ["c",
      "CHECK ((((char_length(source_id) >= 1) AND (char_length(source_id) <= 200)) AND (source_id !~ '[[:cntrl:]]'::text)))"]],
    ["analytics_runtime_sources_source_namespace_check", ["c",
      "CHECK ((((char_length(source_namespace) >= 1) AND (char_length(source_namespace) <= 200)) AND (source_namespace !~ '[[:cntrl:]]'::text)))"]],
    ["analytics_runtime_sources_contract_version_check", ["c", "CHECK ((contract_version = 1))"]],
  ]);
  let constraints;
  try {
    constraints = await client.query(`SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=ANY($2::text[])`,
    [`${schema}.analytics_runtime_sources`, [...registryConstraints.keys()]]);
  } catch {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  if (constraints.rowCount !== registryConstraints.size || constraints.rows.some(constraint => {
    const expected = registryConstraints.get(constraint.conname);
    return !expected || constraint.contype !== expected[0] || !constraint.convalidated
      || constraint.definition !== expected[1];
  })) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  const foreignKeys = new Map([
    ["analytics_admin_metric_snapshots_runtime_source_fk", "analytics_admin_metric_snapshots"],
    ["analytics_admin_metrics_history_cache_runtime_source_fk", "analytics_admin_metrics_history_cache"],
  ]);
  for (const [name, child] of foreignKeys) {
    let foreignKey;
    try {
      foreignKey = await client.query(`SELECT contype,convalidated,
          confrelid=to_regclass($2) AS references_registry,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$3`,
      [`${schema}.${child}`, `${schema}.analytics_runtime_sources`, name]);
    } catch {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
    }
    if (foreignKey.rowCount !== 1 || foreignKey.rows[0]?.contype !== "f"
        || !foreignKey.rows[0]?.convalidated || foreignKey.rows[0]?.references_registry !== true
        || foreignKey.rows[0]?.definition !== `FOREIGN KEY (source_id) REFERENCES ${schema}.analytics_runtime_sources(source_id)`) {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
    }
  }
  let triggers;
  try {
    triggers = await client.query(`SELECT trigger_row.tgname,trigger_row.tgenabled,
        trigger_row.tgtype::integer AS trigger_type,procedure_row.proname,
        function_schema.nspname AS function_schema,language_row.lanname,
        procedure_row.prosrc AS function_source
      FROM pg_trigger trigger_row
      JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
      JOIN pg_namespace function_schema ON function_schema.oid=procedure_row.pronamespace
      JOIN pg_language language_row ON language_row.oid=procedure_row.prolang
      WHERE trigger_row.tgrelid=to_regclass($1) AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname=ANY($2::text[]) ORDER BY trigger_row.tgname`,
    [`${schema}.analytics_runtime_sources`, [
      "analytics_runtime_source_immutable", "analytics_runtime_source_truncate_refused",
    ]]);
  } catch {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  const expectedFunctionSource = "BEGIN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'analytics_runtime_source_immutable'; RETURN NULL; END;";
  const triggerContract = new Map([
    ["analytics_runtime_source_immutable", 27],
    ["analytics_runtime_source_truncate_refused", 34],
  ]);
  if (triggers.rowCount !== triggerContract.size || triggers.rows.some(trigger =>
    trigger.tgenabled !== "O" || trigger.trigger_type !== triggerContract.get(trigger.tgname)
      || trigger.proname !== "reject_analytics_runtime_source_mutation"
      || trigger.function_schema !== schema || trigger.lanname !== "plpgsql"
      || trigger.function_source.replace(/\s+/gu, " ").trim() !== expectedFunctionSource)) {
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
  }
  return Math.floor(version / 10_000);
}

/**
 * Rehearse only the sealed D1 runtime-source tuple transfer into staged 0092.
 * The accepted D1 subset and the exact target are checked before a single row
 * is written. Namespace values stay internal to this function and its sealed
 * reader; receipts contain hashes and counts only. This does not import history
 * or qualify full D1 registry parity, analytics continuity, readers, publication,
 * or cutover.
 */
export async function transferPostgresAnalyticsRuntimeSourceRegistry({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  pageSize = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = typeof rawTargetSchema === "string" ? rawTargetSchema : "";
  const prefix = POSTGRES_ANALYTICS_HISTORY_TARGET_SCHEMA_PREFIX;
  const suffix = schema.startsWith(prefix) ? schema.slice(prefix.length) : "";
  if (!SCHEMA.test(schema) || !TARGET_SUFFIX.test(suffix)) fail("ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED");
  const size = validatePageSize(pageSize);
  const snapshot = assertSource(source);
  if (!destinationPool || typeof destinationPool.connect !== "function") {
    fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED");
  }
  await source.verifySnapshot();
  const sourceManifest = await scanRuntimeSourceRegistrySource(source, size);
  await source.verifySnapshot();

  let client;
  try {
    client = await destinationPool.connect();
  } catch {
    fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED");
  }
  let transactionStarted = false;
  let committed = false;
  let rowsInserted = 0n;
  try {
    const postgresMajor = await validateRuntimeSourceRegistryTarget(client, schema);
    await client.query("BEGIN");
    transactionStarted = true;
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
      [`${schema}:analytics-runtime-source-registry-transfer`]);
    if (lock.rows?.[0]?.locked !== true) fail("ANALYTICS_HISTORY_TRANSFER_BUSY");
    try {
      await client.query(`LOCK TABLE ${relation(schema, "analytics_runtime_sources")} IN SHARE ROW EXCLUSIVE MODE`);
    } catch {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_REQUIRED");
    }
    await validateRuntimeSourceRegistryTarget(client, schema);
    await assertContained(client, schema);

    let after = null;
    for (;;) {
      const page = readSealedRuntimeSourceRegistryPage(source, { after, limit: size });
      if (!page || !Array.isArray(page.rows) || page.rows.length > size) {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_PAGE_INVALID");
      }
      const rows = page.rows.map(validateRuntimeSourceRegistryTuple);
      if (rows.length === 0) break;
      for (let index = 0; index < rows.length; index += 1) {
        if ((after !== null && rows[index].source_id <= after)
            || (index > 0 && rows[index].source_id <= rows[index - 1].source_id)) {
          fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_SOURCE_ORDER_INVALID");
        }
      }
      const values = rows.flatMap(row => [row.source_id, row.source_namespace, row.contract_version]);
      const tuples = rows.map((_, index) => {
        const offset = index * 3;
        return `($${offset + 1},$${offset + 2},$${offset + 3})`;
      }).join(",");
      let inserted;
      try {
        inserted = await client.query(`INSERT INTO ${relation(schema, "analytics_runtime_sources")}
          (source_id,source_namespace,contract_version) VALUES ${tuples}
          ON CONFLICT (source_id) DO NOTHING`, values);
      } catch {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_INSERT_FAILED");
      }
      if (!Number.isSafeInteger(inserted.rowCount) || inserted.rowCount < 0 || inserted.rowCount > rows.length) {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_INSERT_FAILED");
      }
      rowsInserted += BigInt(inserted.rowCount);

      let readback;
      try {
        readback = await client.query(`SELECT source_id,source_namespace,contract_version
          FROM ${relation(schema, "analytics_runtime_sources")}
          WHERE source_id=ANY($1::text[]) ORDER BY source_id COLLATE "C"`,
        [rows.map(row => row.source_id)]);
      } catch {
        fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TARGET_READ_FAILED");
      }
      if (readback.rowCount !== rows.length) fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_CONFLICT");
      for (let index = 0; index < rows.length; index += 1) {
        const target = validatePostgresRuntimeSourceRegistryTuple({
          source_id: readback.rows[index]?.source_id,
          source_namespace: readback.rows[index]?.source_namespace,
          contract_version: Number(readback.rows[index]?.contract_version),
        });
        const expected = rows[index];
        if (target.source_id !== expected.source_id || target.source_namespace !== expected.source_namespace
            || target.contract_version !== expected.contract_version) {
          fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_CONFLICT");
        }
      }
      after = rows.at(-1).source_id;
      if (rows.length < size) break;
    }

    await source.verifySnapshot();
    const finalSourceManifest = await scanRuntimeSourceRegistrySource(source, size);
    if (finalSourceManifest.rowCount !== sourceManifest.rowCount
        || finalSourceManifest.sha256 !== sourceManifest.sha256) {
      fail("ANALYTICS_HISTORY_SOURCE_CHANGED");
    }
    await assertContained(client, schema);
    const targetManifest = await scanRuntimeSourceRegistryTarget(client, schema, size);
    if (targetManifest.rowCount !== sourceManifest.rowCount || targetManifest.sha256 !== sourceManifest.sha256) {
      fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_PARITY_FAILED");
    }
    await source.verifySnapshot();
    await client.query("COMMIT");
    committed = true;
    transactionStarted = false;
    return Object.freeze({
      schema: "sealed-d1-runtime-source-registry-transfer-v1",
      status: "partial_runtime_source_registry_stage_complete",
      targetSchema: schema,
      postgresMajor,
      sourceSnapshotSha256: snapshot.artifactSha256,
      sourceRows: sourceManifest.rowCount,
      targetRows: targetManifest.rowCount,
      sourceRowsSha256: sourceManifest.sha256,
      targetRowsSha256: targetManifest.sha256,
      pageSize: size,
      pagesRead: sourceManifest.pagesRead,
      rowsInserted: rowsInserted.toString(),
      resumed: rowsInserted.toString() !== sourceManifest.rowCount,
      supportedTransferSubset: RUNTIME_SOURCE_REGISTRY_SUBSET,
      fullD1RegistryParity: false,
      fullAnalyticsTransfer: false,
      analyticsContinuityQualified: false,
      readerEnabled: false,
      publicationEnabled: false,
      productionCutoverAuthorized: false,
      rawNamespaceIncluded: false,
      runtimeSourceRegistryTargetDdlOwned: false,
    });
  } catch (error) {
    if (transactionStarted && !committed) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
    fail("ANALYTICS_HISTORY_RUNTIME_REGISTRY_TRANSFER_FAILED");
  } finally {
    client.release();
  }
}

async function acquireTargetLock(client, schema) {
  const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
    [`${schema}:analytics-history-state-transfer`]);
  if (result.rows?.[0]?.locked !== true) fail("ANALYTICS_HISTORY_TRANSFER_BUSY");
}

async function acquireBootstrapLocks(client, schema, held) {
  try {
    for (const name of ["ingestion-journal-transfer", "analytics-applied-main-transfer", "analytics-history-state-transfer"]) {
      const lockKey = `${schema}:${name}`;
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey]);
      if (result.rows?.[0]?.locked !== true) fail("ANALYTICS_HISTORY_TRANSFER_BUSY");
      held.push(lockKey);
    }
  } catch {
    await releaseTargetLocks(client, held);
    held.length = 0;
    fail("ANALYTICS_HISTORY_TRANSFER_BUSY");
  }
  return held;
}

async function releaseTargetLocks(client, held) {
  for (const lockKey of held.toReversed()) {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => {});
  }
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

function compareSourceOrder(spec, left, right) {
  const columns = spec.name === "analytics_source_cursors" ? ["source_id"] : ["source_id", "owner_digest"];
  for (const column of columns) {
    if (left[column] < right[column]) return -1;
    if (left[column] > right[column]) return 1;
  }
  return 0;
}

async function assertTargetStateIsSourceSubset(client, schema, source, spec, pageSize) {
  let targetAfter = null;
  let sourceAfter = null;
  let sourceRows = [];
  let sourceIndex = 0;
  const nextSourceRow = async () => {
    if (sourceIndex >= sourceRows.length) {
      const page = await source.listPage({ table: spec.name, after: sourceAfter, limit: pageSize });
      if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) {
        fail("ANALYTICS_HISTORY_SOURCE_PAGE_INVALID");
      }
      sourceRows = page.rows;
      sourceIndex = 0;
    }
    const row = sourceRows[sourceIndex++];
    if (row) {
      if (!cursorIsAfter(spec, row, sourceAfter)) fail("ANALYTICS_HISTORY_SOURCE_ORDER_INVALID");
      sourceAfter = cursorFor(spec, row);
    }
    return row ?? null;
  };
  for (;;) {
    const { sql, values } = targetPageSql(schema, spec, targetAfter, pageSize);
    const result = await client.query(sql, values);
    if (result.rows.length > pageSize) fail("ANALYTICS_HISTORY_DESTINATION_PAGE_INVALID");
    const targetRows = result.rows.map(row => normalizeTargetRow(spec, row));
    for (const targetRow of targetRows) {
      if (!cursorIsAfter(spec, targetRow, targetAfter)) fail("ANALYTICS_HISTORY_DESTINATION_ORDER_INVALID");
      let sourceRow = await nextSourceRow();
      while (sourceRow && compareSourceOrder(spec, sourceRow, targetRow) < 0) sourceRow = await nextSourceRow();
      if (!sourceRow || compareSourceOrder(spec, sourceRow, targetRow) !== 0 || !sameRow(spec, sourceRow, targetRow)) {
        fail("ANALYTICS_HISTORY_DESTINATION_ROW_MISMATCH");
      }
      targetAfter = cursorFor(spec, targetRow);
    }
    if (targetRows.length < pageSize) break;
  }
}

function sameManifest(source, target) {
  return SPECS.every(spec => source.tables[spec.name].rowCount === target.tables[spec.name].rowCount
    && source.tables[spec.name].sha256 === target.tables[spec.name].sha256);
}

/**
 * Stage D1 owner-state and source-cursor rows with exact PostgreSQL counterparts.
 * By default, the contained target must have no analytics events, work, results,
 * or publications. The explicit appliedEventTransfer option permits the sealed
 * bootstrap to verify exact journal and event receipts first. Inserts are exact
 * and idempotent; restart replays prior pages and verifies conflicts. This never
 * transfers result/work/publication history or qualifies continuity, readers,
 * publication, or cutover.
 */
export async function transferPostgresAnalyticsHistoryState({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  pageSize = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
  appliedEventTransfer: rawAppliedEventTransfer,
} = {}) {
  const appliedEventTransfer = validateAppliedEventTransfer(rawAppliedEventTransfer);
  const schema = typeof rawTargetSchema === "string" ? rawTargetSchema : "";
  const prefix = appliedEventTransfer
    ? POSTGRES_ANALYTICS_HISTORY_BOOTSTRAP_TARGET_SCHEMA_PREFIX
    : POSTGRES_ANALYTICS_HISTORY_TARGET_SCHEMA_PREFIX;
  const suffix = schema.startsWith(prefix) ? schema.slice(prefix.length) : "";
  if (!SCHEMA.test(schema) || !TARGET_SUFFIX.test(suffix)) fail("ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED");
  const size = validatePageSize(pageSize);
  const snapshot = assertSource(source);
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED");
  await source.verifySnapshot();
  const client = await destinationPool.connect();
  const heldLocks = [];
  try {
    const postgresVersion = await validateTarget(client, schema);
    if (appliedEventTransfer) await acquireBootstrapLocks(client, schema, heldLocks);
    else {
      await acquireTargetLock(client, schema);
      heldLocks.push(`${schema}:analytics-history-state-transfer`);
    }
    await assertContained(client, schema);
    let appliedEventReceipt = null;
    if (appliedEventTransfer) {
      appliedEventReceipt = await verifyAppliedEventBootstrap({ client, schema, source,
        appliedEventTransfer, pageSize: size });
      for (const spec of SPECS) await assertTargetStateIsSourceSubset(client, schema, source, spec, size);
    }
    await assertNoTargetOperations(client, schema, { allowAppliedEventLane: Boolean(appliedEventTransfer) });
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
    if (appliedEventTransfer) {
      appliedEventReceipt = await verifyAppliedEventBootstrap({ client, schema, source,
        appliedEventTransfer, pageSize: size });
    }
    await assertNoTargetOperations(client, schema, { allowAppliedEventLane: Boolean(appliedEventTransfer) });
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
      appliedEventReceipt,
      fullAnalyticsTransfer: false,
      limitations: Object.freeze({
        appliedEventJournalTransferred: Boolean(appliedEventTransfer),
        historicalPublicationRowsTransferred: false,
        sourceNamespaceRegistryTransferred: false,
        runtimeSourceRegistryTargetDdlOwned: false,
        erasureFenceHistoryTransferred: false,
        analyticsContinuityQualified: false,
        readerEnabled: false,
        publicationEnabled: false,
        productionCutoverAuthorized: false,
      }),
    });
  } finally {
    await releaseTargetLocks(client, heldLocks);
    client.release();
  }
}

/**
 * Rehearse the sealed analytics bootstrap in one contained PostgreSQL schema:
 * ingestion journal, exact applied-event tuples, then exact owner/cursor state.
 * Completed event stages are verified from their source pins and target rows;
 * if state pages already exist, their exact source-subset proof resumes them
 * without replaying an event importer that correctly refuses downstream state.
 * This remains a partial, non-publishing rehearsal, not analytics cutover.
 */
export async function transferPostgresAnalyticsHistoryBootstrap({
  source,
  journalSource,
  destinationPool,
  targetSchema: rawTargetSchema,
  transferId,
  journalTransferId,
  pageSize = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = typeof rawTargetSchema === "string" ? rawTargetSchema : "";
  const suffix = schema.startsWith(POSTGRES_ANALYTICS_HISTORY_BOOTSTRAP_TARGET_SCHEMA_PREFIX)
    ? schema.slice(POSTGRES_ANALYTICS_HISTORY_BOOTSTRAP_TARGET_SCHEMA_PREFIX.length) : "";
  if (!SCHEMA.test(schema) || !TARGET_SUFFIX.test(suffix)) fail("ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED");
  const size = validatePageSize(pageSize);
  const appliedEventTransfer = validateAppliedEventTransfer({ transferId, journalTransferId, journalSource });
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED");
  const manifests = await scanBootstrapSources({ source, journalSource, pageSize: size });
  let client;
  try { client = await destinationPool.connect(); }
  catch { fail("ANALYTICS_HISTORY_DESTINATION_REQUIRED"); }
  let stateRows = "0";
  let appliedEventRows = "0";
  try {
    await validateTarget(client, schema);
    await assertContained(client, schema);
    await assertNoTargetOperations(client, schema, { allowAppliedEventLane: true });
    const counts = await client.query(`SELECT
        (SELECT count(*)::text FROM ${relation(schema, "analytics_owner_state")}) AS owners,
        (SELECT count(*)::text FROM ${relation(schema, "analytics_source_cursors")}) AS cursors,
        (SELECT count(*)::text FROM ${relation(schema, "analytics_applied_events")}) AS applied_events`);
    const row = counts.rows[0];
    if (!row || !/^\d+$/u.test(row.owners ?? "") || !/^\d+$/u.test(row.cursors ?? "")
        || !/^\d+$/u.test(row.applied_events ?? "")) fail("ANALYTICS_HISTORY_TARGET_READ_FAILED");
    stateRows = (BigInt(row.owners) + BigInt(row.cursors)).toString();
    appliedEventRows = row.applied_events;
  } catch (error) {
    client.release();
    if (error instanceof PostgresAnalyticsHistoryTransferError) throw error;
    fail("ANALYTICS_HISTORY_TARGET_READ_FAILED");
  }
  client.release();

  let journalTransfer = null;
  let appliedTransfer = null;
  if (stateRows === "0") {
    const { transferPostgresIngestionJournal } = await import("./postgres-ingestion-journal-transfer.mjs");
    const { transferPostgresAnalyticsAppliedMain } = await import("./postgres-analytics-applied-main-transfer.mjs");
    if (appliedEventRows === "0") {
      journalTransfer = await transferPostgresIngestionJournal({ source: journalSource, destinationPool,
        targetSchema: schema, transferId: journalTransferId, pageSize: size });
    }
    appliedTransfer = await transferPostgresAnalyticsAppliedMain({ source, destinationPool, targetSchema: schema,
      transferId, journalTransferId, pageSize: size });
  }
  const state = await transferPostgresAnalyticsHistoryState({ source, destinationPool, targetSchema: schema,
    pageSize: size, appliedEventTransfer });
  const receipt = state.appliedEventReceipt;
  if (!receipt || receipt.sourceSnapshotSha256 !== manifests.identity.snapshotSha256
      || receipt.sourceNamespaceSha256 !== manifests.identity.namespaceSha256
      || receipt.eventRows !== manifests.events.eventRows || receipt.eventRowsSha256 !== manifests.events.eventRowsSha256
      || receipt.journalSnapshotSha256 !== manifests.journal.sourceSnapshotSha256
      || receipt.journalRows !== manifests.journal.eventRows
      || receipt.journalRowsSha256 !== manifests.journal.eventRowsSha256) {
    fail("ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
  }
  return Object.freeze({
    schema: "sealed-analytics-owner-state-and-applied-events-bootstrap-v1",
    status: "partial_analytics_bootstrap_complete",
    targetSchema: schema,
    sourceSnapshotSha256: receipt.sourceSnapshotSha256,
    sourceNamespaceSha256: receipt.sourceNamespaceSha256,
    journalSnapshotSha256: receipt.journalSnapshotSha256,
    eventRows: receipt.eventRows,
    eventRowsSha256: receipt.eventRowsSha256,
    journalRows: receipt.journalRows,
    journalRowsSha256: receipt.journalRowsSha256,
    tables: state.tables,
    pageSize: size,
    pagesCommitted: state.pagesCommitted,
    rowsInserted: state.rowsInserted,
    resumed: state.resumed || stateRows !== "0" || Boolean(journalTransfer?.resumed) || Boolean(appliedTransfer?.resumed),
    journalStage: journalTransfer?.status ?? (stateRows !== "0" ? "verified_existing" : "already_present"),
    appliedEventStage: appliedTransfer?.status ?? (stateRows !== "0" ? "verified_existing" : "already_present"),
    fullAnalyticsTransfer: false,
    analyticsContinuityQualified: false,
    readerEnabled: false,
    publicationEnabled: false,
    productionCutoverAuthorized: false,
    limitations: state.limitations,
  });
}

export const POSTGRES_ANALYTICS_HISTORY_SOURCE_COLUMNS = Object.freeze(
  Object.fromEntries(Object.entries(SOURCE_TABLES).map(([name, spec]) => [name, spec.columns])),
);
