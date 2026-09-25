import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const POSTGRES_ERASURE_LEDGER_TRANSFER_SCHEMA = "postgres-erasure-ledger-transfer-v1";
export const POSTGRES_ERASURE_LEDGER_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_ERASURE_LEDGER_MAX_PAGE_SIZE = 200;
export const POSTGRES_ERASURE_LEDGER_TARGET_SCHEMA_PREFIX = "erasure_ledger_transfer_target_";
export const POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET = Object.freeze({
  mode: "gcp_named_test",
  contractId: "gcp-tibotattle-ledger-test-v1",
  projectId: "tibotattle",
  projectNumber: "806510610397",
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
  database: "tibotattle_ledger",
  schema: "tibotattle_ledger",
  cloudRunJob: "tibotattle-test-erasure-ledger-transfer",
  serviceAccount: "tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com",
  iamDatabaseRole: "tibotattle-test-transfer@tibotattle.iam",
});

const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const CLOUD_RUN_EXECUTION = /^[a-z][a-z0-9-]{0,62}$/u;
const HEX_ZERO = "0".repeat(64);
const TRUSTED_SOURCES = new WeakSet();
const encoder = new TextEncoder();

const TABLES = Object.freeze([
  Object.freeze({
    name: "deletion_tombstones",
    stage: "postgres_erasure_ledger_transfer_tombstones",
    columns: Object.freeze(["participant_digest", "schema_version", "deleted_at", "retain_until"]),
    types: Object.freeze(["text", "text", "instant", "instant"]),
    sqliteTypes: Object.freeze(["TEXT", "TEXT", "TEXT", "TEXT"]),
    sqliteNotNull: Object.freeze([1, 1, 1, 1]),
    sqlitePrimaryKey: Object.freeze([1, 0, 0, 0]),
    withoutRowid: false,
    key: Object.freeze(["participant_digest"]),
  }),
  Object.freeze({
    name: "identity_reenrollment_cooldowns",
    stage: "postgres_erasure_ledger_transfer_cooldowns",
    columns: Object.freeze(["identity_cooldown_digest", "schema_version", "deleted_at", "retain_until"]),
    types: Object.freeze(["text", "text", "instant", "instant"]),
    sqliteTypes: Object.freeze(["TEXT", "TEXT", "TEXT", "TEXT"]),
    sqliteNotNull: Object.freeze([1, 1, 1, 1]),
    sqlitePrimaryKey: Object.freeze([1, 0, 0, 0]),
    withoutRowid: false,
    key: Object.freeze(["identity_cooldown_digest"]),
  }),
  Object.freeze({
    name: "storage_erasure_jobs",
    stage: "postgres_erasure_ledger_transfer_jobs",
    columns: Object.freeze([
      "participant_digest", "source_id", "owner_digest", "source_namespace", "state",
      "terminal_json", "completed_at", "attempted_ms",
    ]),
    types: Object.freeze(["text", "text", "text", "text", "text", "text", "instant|null", "i64"]),
    sqliteTypes: Object.freeze(["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER"]),
    sqliteNotNull: Object.freeze([1, 1, 1, 1, 1, 0, 0, 1]),
    sqlitePrimaryKey: Object.freeze([1, 2, 3, 0, 0, 0, 0, 0]),
    withoutRowid: true,
    key: Object.freeze(["participant_digest", "source_id", "owner_digest"]),
  }),
]);
const TABLE_BY_NAME = new Map(TABLES.map((spec) => [spec.name, spec]));
const STAGE_TO_SOURCE = new Map(TABLES.map((spec) => [spec.stage, spec]));

export class PostgresErasureLedgerTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresErasureLedgerTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresErasureLedgerTransferError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function schemaName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)
      || value.startsWith("pg_") || value === "information_schema" || value === "pg_catalog") {
    fail("ERASURE_LEDGER_SCHEMA_INVALID");
  }
  return value;
}

function qualified(schema, name) {
  const spec = TABLE_BY_NAME.get(name);
  if (!spec) fail("ERASURE_LEDGER_TABLE_INVALID");
  return `"${schemaName(schema)}"."${name}"`;
}

function qualifiedControl(schema, name) {
  const allowed = new Set([
    "postgres_erasure_ledger_transfer_runs",
    "postgres_erasure_ledger_transfer_checkpoints",
    "postgres_erasure_ledger_transfer_table_receipts",
    "postgres_erasure_ledger_transfer_target_contracts",
    "postgres_erasure_ledger_transfer_named_attempts",
  ]);
  if (!allowed.has(name)) fail("ERASURE_LEDGER_TABLE_INVALID");
  return `"${schemaName(schema)}"."${name}"`;
}

function qualifiedStage(schema, name) {
  if (!STAGE_TO_SOURCE.has(name)) fail("ERASURE_LEDGER_TABLE_INVALID");
  return `"${schemaName(schema)}"."${name}"`;
}

function validTargetSchema(value, targetMode = "disposable") {
  const disposable = typeof value === "string" && IDENTIFIER.test(value)
    && value.startsWith(POSTGRES_ERASURE_LEDGER_TARGET_SCHEMA_PREFIX)
    && TARGET_SUFFIX.test(value.slice(POSTGRES_ERASURE_LEDGER_TARGET_SCHEMA_PREFIX.length));
  const namedTest = targetMode === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode
    && value === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.schema;
  if (targetMode === "disposable" ? !disposable : !namedTest) {
    fail("ERASURE_LEDGER_TARGET_SCHEMA_REQUIRED");
  }
  return value;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      fail("ERASURE_LEDGER_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof PostgresErasureLedgerTransferError) throw error;
      fail("ERASURE_LEDGER_SQLITE_UNAVAILABLE");
    }
  }
}

async function fingerprintSqlite(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("ERASURE_LEDGER_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) {
      fail("ERASURE_LEDGER_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("ERASURE_LEDGER_SQLITE_CHANGED");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("ERASURE_LEDGER_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(opened, after)) fail("ERASURE_LEDGER_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresErasureLedgerTransferError) throw error;
    fail("ERASURE_LEDGER_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function canonicalInstant(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    value = value.toISOString();
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) {
    fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  return value;
}

function normalizeInteger(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value).toString();
  fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
}

function validateDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  return value;
}

function validateTerminalJson(value, job) {
  if (value === null) return null;
  if (typeof value !== "string" || encoder.encode(value).byteLength > 65_536) {
    fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail("ERASURE_LEDGER_SOURCE_ROW_INVALID"); }
  const keys = ["sourceId", "sequence", "eventDigest", "ownerDigest", "revision", "kind", "objectDigest",
    "contentDigest", "authorityEpoch", "publicAuthorityEpoch", "recordedMs"].sort().join(",");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== keys
      || parsed.sourceId !== job.source_id || parsed.ownerDigest !== job.owner_digest || parsed.kind !== "owner-erased"
      || ![parsed.eventDigest, parsed.ownerDigest, parsed.objectDigest, parsed.contentDigest].every((digest) =>
        typeof digest === "string" && DIGEST.test(digest))
      || ![parsed.sequence, parsed.revision, parsed.authorityEpoch, parsed.publicAuthorityEpoch]
        .every((number) => Number.isSafeInteger(number) && number > 0)
      || !Number.isSafeInteger(parsed.recordedMs) || parsed.recordedMs < 0) {
    fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  }
  return value;
}

function normalizeRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  const row = Object.create(null);
  for (const column of spec.columns) {
    if (!Object.hasOwn(raw, column)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    row[column] = raw[column];
  }
  if (spec.name === "deletion_tombstones") {
    row.participant_digest = validateDigest(row.participant_digest);
    if (row.schema_version !== "participant-deletion-tombstone-v0.1") fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    row.deleted_at = canonicalInstant(row.deleted_at);
    row.retain_until = canonicalInstant(row.retain_until);
    if (Date.parse(row.retain_until) <= Date.parse(row.deleted_at)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  } else if (spec.name === "identity_reenrollment_cooldowns") {
    row.identity_cooldown_digest = validateDigest(row.identity_cooldown_digest);
    if (row.schema_version !== "identity-reenrollment-cooldown-v0.1") fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    row.deleted_at = canonicalInstant(row.deleted_at);
    row.retain_until = canonicalInstant(row.retain_until);
    if (Date.parse(row.retain_until) <= Date.parse(row.deleted_at)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
  } else {
    row.participant_digest = validateDigest(row.participant_digest);
    row.owner_digest = validateDigest(row.owner_digest);
    if (typeof row.source_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(row.source_id)
        || typeof row.source_namespace !== "string" || [...row.source_namespace].length < 1
        || [...row.source_namespace].length > 256
        || !["pending", "complete"].includes(row.state)) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    row.attempted_ms = normalizeInteger(row.attempted_ms);
    if (BigInt(row.attempted_ms) < 0n) fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    row.completed_at = row.completed_at === null ? null : canonicalInstant(row.completed_at);
    row.terminal_json = validateTerminalJson(row.terminal_json, row);
    if ((row.state === "pending" && row.completed_at !== null)
        || (row.state === "complete" && (row.completed_at === null || row.terminal_json === null))) {
      fail("ERASURE_LEDGER_SOURCE_ROW_INVALID");
    }
  }
  return row;
}

function validateSqliteLayout(database) {
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const spec of TABLES) {
    if (!names.has(spec.name)) fail("ERASURE_LEDGER_SQLITE_LAYOUT_INVALID");
    const columns = database.prepare(`PRAGMA table_info("${spec.name}")`).all();
    if (columns.length !== spec.columns.length
        || columns.some((column, index) => column.name !== spec.columns[index]
          || String(column.type).toUpperCase() !== spec.sqliteTypes[index]
          || Number(column.notnull) !== spec.sqliteNotNull[index]
          || Number(column.pk) !== spec.sqlitePrimaryKey[index])) {
      fail("ERASURE_LEDGER_SQLITE_LAYOUT_INVALID");
    }
    const table = database.prepare("PRAGMA table_list").all().find((entry) => entry.name === spec.name);
    if (!table || Number(table.strict) !== 1 || Number(table.wr) !== Number(spec.withoutRowid)) {
      fail("ERASURE_LEDGER_SQLITE_LAYOUT_INVALID");
    }
  }
  const jobForeignKeys = database.prepare('PRAGMA foreign_key_list("storage_erasure_jobs")').all();
  if (jobForeignKeys.length !== 1 || jobForeignKeys[0].table !== "deletion_tombstones"
      || jobForeignKeys[0].from !== "participant_digest" || jobForeignKeys[0].to !== "participant_digest"
      || String(jobForeignKeys[0].on_delete).toUpperCase() !== "CASCADE") {
    fail("ERASURE_LEDGER_SQLITE_LAYOUT_INVALID");
  }
  if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
    fail("ERASURE_LEDGER_SQLITE_INTEGRITY_FAILED");
  }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) fail("ERASURE_LEDGER_SQLITE_INTEGRITY_FAILED");
    const orphanCount = database.prepare(`SELECT count(*) AS count FROM storage_erasure_jobs job
      LEFT JOIN deletion_tombstones tombstone ON tombstone.participant_digest=job.participant_digest
      WHERE tombstone.participant_digest IS NULL`).get().count;
    if (BigInt(orphanCount) !== 0n) fail("ERASURE_LEDGER_SQLITE_INTEGRITY_FAILED");
}

function validatePageSize(value) {
  const size = value ?? POSTGRES_ERASURE_LEDGER_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > POSTGRES_ERASURE_LEDGER_MAX_PAGE_SIZE) {
    fail("ERASURE_LEDGER_PAGE_SIZE_INVALID");
  }
  return size;
}

function normalizeCursor(spec, value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length !== spec.key.length) fail("ERASURE_LEDGER_CURSOR_INVALID");
  const cursor = value.map((entry) => {
    if (typeof entry !== "string" || entry.length < 1 || encoder.encode(entry).byteLength > 4096) {
      fail("ERASURE_LEDGER_CURSOR_INVALID");
    }
    return entry;
  });
  if (cursor.some((entry, index) => entry !== value[index])) fail("ERASURE_LEDGER_CURSOR_INVALID");
  return cursor;
}

function key(spec, row) {
  return spec.key.map((column) => row[column]);
}

function compareKey(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function canonicalValue(type, value) {
  if (value === null) return null;
  if (type === "i64") return ["int64", value];
  if (type === "instant" || type === "instant|null") return ["instant", value];
  return ["text", value];
}

function rowString(spec, row) {
  return JSON.stringify(spec.columns.map((column, index) => canonicalValue(spec.types[index], row[column])));
}

function updateHash(hash, spec, row) {
  hash.update(`${rowString(spec, row)}\n`);
}

function tableManifest(spec, rowCount, digest) {
  return Object.freeze({ rowCount, sha256: digest });
}

function manifestDigest(tables) {
  return sha256(JSON.stringify({
    schema: POSTGRES_ERASURE_LEDGER_TRANSFER_SCHEMA,
    tables: TABLES.map((spec) => ({
      name: spec.name,
      rowCount: tables[spec.name].rowCount,
      sha256: tables[spec.name].sha256,
    })),
  }));
}

function sourceSelect(spec, after, limit) {
  const columns = spec.columns.map((column) => `"${column}"`).join(",");
  const order = spec.key.map((column) => `"${column}"`).join(",");
  if (after === null) return { sql: `SELECT ${columns} FROM "${spec.name}" ORDER BY ${order} LIMIT ?`, values: [BigInt(limit)] };
  if (spec.key.length === 1) {
    return { sql: `SELECT ${columns} FROM "${spec.name}" WHERE "${spec.key[0]}" > ? ORDER BY ${order} LIMIT ?`,
      values: [after[0], BigInt(limit)] };
  }
  return { sql: `SELECT ${columns} FROM "${spec.name}" WHERE ("${spec.key.join("\",\"")}") > (?,?,?) ORDER BY ${order} LIMIT ?`,
    values: [...after, BigInt(limit)] };
}

/** Opens an immutable, mode-0400 SQLite D1 export and serves bounded keyset pages. */
export async function createSealedSqliteErasureLedgerSource({ path, expectedSha256 } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("ERASURE_LEDGER_SQLITE_SHA256_REQUIRED");
  const initial = await fingerprintSqlite(path);
  if (initial.sha256 !== expectedSha256) fail("ERASURE_LEDGER_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("ERASURE_LEDGER_SQLITE_SIDECAR_PRESENT");
    }
    validateSqliteLayout(database);
    for (const spec of TABLES) {
      let after = null;
      let rowCount = 0;
      for (;;) {
        const query = sourceSelect(spec, after, POSTGRES_ERASURE_LEDGER_MAX_PAGE_SIZE);
        const statement = database.prepare(query.sql);
        statement.setReadBigInts(true);
        const rows = statement.all(...query.values).map((raw) => normalizeRow(spec, raw));
        for (let index = 0; index < rows.length; index += 1) {
          if (index > 0 && compareKey(key(spec, rows[index - 1]), key(spec, rows[index])) >= 0) {
            fail("ERASURE_LEDGER_SOURCE_ORDER_INVALID");
          }
          after = key(spec, rows[index]);
          rowCount += 1;
        }
        if (rows.length < POSTGRES_ERASURE_LEDGER_MAX_PAGE_SIZE) break;
      }
      const countStatement = database.prepare(`SELECT count(*) AS row_count FROM "${spec.name}"`);
      countStatement.setReadBigInts(true);
      const count = countStatement.get().row_count;
      if (BigInt(count) !== BigInt(rowCount)) fail("ERASURE_LEDGER_SOURCE_ORDER_INVALID");
    }
  } catch (error) {
    database?.close();
    if (error instanceof PostgresErasureLedgerTransferError) throw error;
    fail("ERASURE_LEDGER_SQLITE_INVALID");
  }
  const prepared = new Map();
  let closed = false;
  const snapshot = Object.freeze({
    kind: "sealed-d1-erasure-ledger-export",
    snapshotId: `sha256:${expectedSha256}`,
    artifactSha256: expectedSha256,
    immutable: true,
  });
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("ERASURE_LEDGER_SQLITE_CLOSED");
      const actual = await fingerprintSqlite(path);
      if (actual.sha256 !== expectedSha256 || !sameStat(initial.stat, actual.stat)) fail("ERASURE_LEDGER_SOURCE_CHANGED");
      return Object.freeze({ snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 });
    },
    async listPage({ table, after = null, limit } = {}) {
      if (closed) fail("ERASURE_LEDGER_SQLITE_CLOSED");
      const spec = TABLE_BY_NAME.get(table);
      if (!spec) fail("ERASURE_LEDGER_TABLE_INVALID");
      const pageSize = validatePageSize(limit);
      const cursor = normalizeCursor(spec, after);
      const query = sourceSelect(spec, cursor, pageSize);
      const statementKey = `${table}:${cursor === null ? "first" : spec.key.length}`;
      let statement = prepared.get(statementKey);
      if (!statement) {
        try {
          statement = database.prepare(query.sql);
          statement.setReadBigInts(true);
          prepared.set(statementKey, statement);
        } catch {
          fail("ERASURE_LEDGER_SQLITE_READ_FAILED");
        }
      }
      try {
        const rows = statement.all(...query.values).map((raw) => normalizeRow(spec, raw));
        if (rows.length > pageSize) fail("ERASURE_LEDGER_SOURCE_PAGE_INVALID");
        for (let index = 0; index < rows.length; index += 1) {
          if (cursor !== null && index === 0 && compareKey(key(spec, rows[index]), cursor) <= 0
              || index > 0 && compareKey(key(spec, rows[index - 1]), key(spec, rows[index])) >= 0) {
            fail("ERASURE_LEDGER_SOURCE_ORDER_INVALID");
          }
        }
        return Object.freeze({ rows: Object.freeze(rows) });
      } catch (error) {
        if (error instanceof PostgresErasureLedgerTransferError) throw error;
        fail("ERASURE_LEDGER_SQLITE_READ_FAILED");
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
  try {
    await source.verifySnapshot();
  } catch (error) {
    source.close();
    throw error;
  }
  return source;
}

function trustedSnapshot(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || source.snapshot?.kind !== "sealed-d1-erasure-ledger-export"
      || source.snapshot?.immutable !== true || !SHA256.test(source.snapshot.artifactSha256 ?? "")
      || source.snapshot.snapshotId !== `sha256:${source.snapshot.artifactSha256}`) {
    fail("ERASURE_LEDGER_SEALED_SOURCE_REQUIRED");
  }
  return source.snapshot;
}

async function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const spec of TABLES) {
    let after = null;
    let rowCount = 0;
    const hash = createHash("sha256");
    for (;;) {
      const page = await source.listPage({ table: spec.name, after, limit: pageSize });
      if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("ERASURE_LEDGER_SOURCE_PAGE_INVALID");
      const rows = page.rows.map((raw) => normalizeRow(spec, raw));
      for (let index = 0; index < rows.length; index += 1) {
        if (after !== null && compareKey(key(spec, rows[index]), after) <= 0
            || index > 0 && compareKey(key(spec, rows[index - 1]), key(spec, rows[index])) >= 0) {
          fail("ERASURE_LEDGER_SOURCE_ORDER_INVALID");
        }
        updateHash(hash, spec, rows[index]);
        after = key(spec, rows[index]);
        rowCount += 1;
      }
      if (rows.length < pageSize) break;
    }
    tables[spec.name] = tableManifest(spec, rowCount, hash.digest("hex"));
  }
  return Object.freeze({ tables: Object.freeze(tables), sha256: manifestDigest(tables) });
}

function normalizePgValue(spec, column, value) {
  const type = spec.types[spec.columns.indexOf(column)];
  if (type === "instant" || type === "instant|null") return value === null ? null : canonicalInstant(value);
  if (type === "i64") return normalizeInteger(value);
  return value;
}

function normalizeTargetRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ERASURE_LEDGER_TARGET_ROW_INVALID");
  const row = Object.create(null);
  for (const column of spec.columns) {
    if (!Object.hasOwn(raw, column)) fail("ERASURE_LEDGER_TARGET_ROW_INVALID");
    row[column] = normalizePgValue(spec, column, raw[column]);
  }
  return normalizeRow(spec, row);
}

function relationForSpec(schema, spec, staged) {
  return staged ? qualifiedStage(schema, spec.stage) : qualified(schema, spec.name);
}

function pageSql(spec, relation, after, limit, bindTransfer = false) {
  const columns = spec.columns.map((column) => `"${column}"`).join(",");
  const order = spec.key.map((column) => `"${column}"`).join(",");
  const transferClause = bindTransfer ? "transfer_id=$1 AND " : "";
  const offset = bindTransfer ? 1 : 0;
  if (after === null) {
    return { sql: `SELECT ${columns} FROM ${relation} WHERE ${bindTransfer ? "transfer_id=$1" : "TRUE"} ORDER BY ${order} LIMIT $${offset + 1}`,
      values: bindTransfer ? [bindTransfer, limit] : [limit] };
  }
  if (spec.key.length === 1) {
    return { sql: `SELECT ${columns} FROM ${relation} WHERE ${transferClause}"${spec.key[0]}" > $${offset + 1} ORDER BY ${order} LIMIT $${offset + 2}`,
      values: [...(bindTransfer ? [bindTransfer] : []), after[0], limit] };
  }
  const tuple = `(${spec.key.map((column) => `"${column}"`).join(",")})`;
  const placeholders = `(${spec.key.map((_, index) => `$${offset + index + 1}`).join(",")})`;
  return { sql: `SELECT ${columns} FROM ${relation} WHERE ${transferClause}${tuple} > ${placeholders} ORDER BY ${order} LIMIT $${offset + spec.key.length + 1}`,
    values: [...(bindTransfer ? [bindTransfer] : []), ...after, limit] };
}

function stageInsertSql(schema, spec, rowCount) {
  const relation = qualifiedStage(schema, spec.stage);
  const columns = ["transfer_id", ...spec.columns];
  let parameter = 0;
  const rows = Array.from({ length: rowCount }, () => `(${columns.map((column) => {
    parameter += 1;
    return column === "deleted_at" || column === "retain_until" || column === "completed_at"
      ? `$${parameter}::timestamptz` : `$${parameter}`;
  }).join(",")})`).join(",");
  return `INSERT INTO ${relation} (${columns.map((column) => `"${column}"`).join(",")}) VALUES ${rows} ON CONFLICT DO NOTHING`;
}

function sourceValues(spec, transferId, rows) {
  return rows.flatMap((row) => [transferId, ...spec.columns.map((column) => row[column])]);
}

async function queryStagePage(client, schema, spec, transferId, after, limit) {
  const relation = relationForSpec(schema, spec, true);
  const { sql, values } = pageSql(spec, relation, after, limit, transferId);
  const result = await client.query(sql, values);
  if (!Array.isArray(result.rows) || result.rows.length > limit) fail("ERASURE_LEDGER_TARGET_PAGE_INVALID");
  return result.rows.map((raw) => normalizeTargetRow(spec, raw));
}

async function verifyPage(client, schema, spec, transferId, rows) {
  if (rows.length === 0) return;
  const relation = relationForSpec(schema, spec, true);
  const first = key(spec, rows[0]);
  const last = key(spec, rows.at(-1));
  const where = spec.key.length === 1
    ? `"${spec.key[0]}" >= $2 AND "${spec.key[0]}" <= $3`
    : `("${spec.key.join("\",\"")}") >= ($2,$3,$4) AND ("${spec.key.join("\",\"")}") <= ($5,$6,$7)`;
  const values = spec.key.length === 1 ? [transferId, first[0], last[0]] : [transferId, ...first, ...last];
  const result = await client.query(`SELECT ${spec.columns.map((column) => `"${column}"`).join(",")}
    FROM ${relation} WHERE transfer_id=$1 AND ${where} ORDER BY ${spec.key.map((column) => `"${column}"`).join(",")}`, values);
  if (result.rows.length !== rows.length) fail("ERASURE_LEDGER_DESTINATION_ROW_MISMATCH");
  const target = result.rows.map((raw) => normalizeTargetRow(spec, raw));
  for (let index = 0; index < rows.length; index += 1) {
    if (rowString(spec, rows[index]) !== rowString(spec, target[index])) fail("ERASURE_LEDGER_DESTINATION_ROW_MISMATCH");
  }
}

function checkpointRelation(schema) {
  return qualifiedControl(schema, "postgres_erasure_ledger_transfer_checkpoints");
}

async function latestCheckpoint(client, schema, transferId, tableName) {
  const result = await client.query(`SELECT checkpoint_no::text,row_count::text,page_count::text,last_key,
      prefix_sha256,complete FROM ${checkpointRelation(schema)}
    WHERE transfer_id=$1 AND table_name=$2 ORDER BY checkpoint_no DESC LIMIT 1`, [transferId, tableName]);
  return result.rows[0] ?? null;
}

function prefixAdvance(prefix, spec, row) {
  return sha256(`${prefix}\n${rowString(spec, row)}`);
}

async function verifyCheckpoint({ source, pool, schema, transferId, spec, checkpoint, pageSize }) {
  if (!checkpoint) return { after: null, rowCount: 0, pageCount: 0, checkpointNo: 0, prefix: HEX_ZERO, complete: false };
  const rowCount = Number(checkpoint.row_count);
  const pageCount = Number(checkpoint.page_count);
  const checkpointNo = Number(checkpoint.checkpoint_no);
  if (![rowCount, pageCount, checkpointNo].every(Number.isSafeInteger)
      || rowCount < 0 || pageCount < 0 || checkpointNo < 1 || pageCount > checkpointNo) {
    fail("ERASURE_LEDGER_CHECKPOINT_INVALID");
  }
  const after = normalizeCursor(spec, checkpoint.last_key);
  const client = await pool.connect();
  let seen = 0;
  let pages = 0;
  let sourceAfter = null;
  let prefix = HEX_ZERO;
  try {
    while (seen < rowCount) {
      const pageAfter = sourceAfter;
      const take = Math.min(pageSize, rowCount - seen);
      const page = await source.listPage({ table: spec.name, after: sourceAfter, limit: take });
      if (!Array.isArray(page?.rows) || page.rows.length !== take) fail("ERASURE_LEDGER_CHECKPOINT_INVALID");
      const rows = page.rows.map((raw) => normalizeRow(spec, raw));
      if (rows.length > 0) pages += 1;
      for (const row of rows) {
        prefix = prefixAdvance(prefix, spec, row);
        sourceAfter = key(spec, row);
        seen += 1;
      }
      const targetRows = await queryStagePage(client, schema, spec, transferId, pageAfter, take);
      if (targetRows.length !== rows.length
          || rows.some((row, index) => rowString(spec, row) !== rowString(spec, targetRows[index]))) {
        fail("ERASURE_LEDGER_CHECKPOINT_INVALID");
      }
    }
    if (compareKey(after ?? [], sourceAfter ?? []) !== 0
        || pageCount !== pages || checkpoint.prefix_sha256 !== prefix
        || pageCount !== Math.ceil(rowCount / pageSize)
        || (checkpoint.complete !== true && (rowCount === 0 || rowCount !== pageCount * pageSize))) {
      fail("ERASURE_LEDGER_CHECKPOINT_INVALID");
    }
    const tail = await source.listPage({ table: spec.name, after: sourceAfter, limit: pageSize });
    if (!Array.isArray(tail?.rows) || tail.rows.length > pageSize
        || checkpoint.complete === true && tail.rows.length !== 0
        || checkpoint.complete !== true && tail.rows.length === 0) {
      fail("ERASURE_LEDGER_CHECKPOINT_INVALID");
    }
    return { after, rowCount, pageCount, checkpointNo, prefix, complete: checkpoint.complete === true };
  } finally {
    client.release();
  }
}

async function copyTable({ source, pool, schema, transferId, spec, pageSize, existingRunStatus }) {
  const checkpointClient = await pool.connect();
  let checkpoint;
  try { checkpoint = await latestCheckpoint(checkpointClient, schema, transferId, spec.name); }
  finally { checkpointClient.release(); }
  const progress = await verifyCheckpoint({ source, pool, schema, transferId, spec, checkpoint, pageSize });
  if (progress.complete) return { pages: 0, resumed: checkpoint !== null };
  if (existingRunStatus !== "copying") fail("ERASURE_LEDGER_TRANSFER_STATE_INVALID");
  let { after, rowCount, pageCount, checkpointNo, prefix } = progress;
  let pagesCommitted = 0;
  for (;;) {
    const page = await source.listPage({ table: spec.name, after, limit: pageSize });
    if (!Array.isArray(page?.rows) || page.rows.length > pageSize) fail("ERASURE_LEDGER_SOURCE_PAGE_INVALID");
    const rows = page.rows.map((raw) => normalizeRow(spec, raw));
    for (let index = 0; index < rows.length; index += 1) {
      if (after !== null && compareKey(key(spec, rows[index]), after) <= 0
          || index > 0 && compareKey(key(spec, rows[index - 1]), key(spec, rows[index])) >= 0) {
        fail("ERASURE_LEDGER_SOURCE_ORDER_INVALID");
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (rows.length > 0) {
        await client.query(stageInsertSql(schema, spec, rows.length), sourceValues(spec, transferId, rows));
        await verifyPage(client, schema, spec, transferId, rows);
        for (const row of rows) {
          prefix = prefixAdvance(prefix, spec, row);
          after = key(spec, row);
        }
        rowCount += rows.length;
        pageCount += 1;
        pagesCommitted += 1;
      }
      checkpointNo += 1;
      const complete = rows.length < pageSize;
      await client.query(`INSERT INTO ${checkpointRelation(schema)}
        (transfer_id,table_name,checkpoint_no,last_key,row_count,page_count,page_row_count,prefix_sha256,complete)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`, [transferId, spec.name, checkpointNo,
        after === null ? null : JSON.stringify(after), rowCount, pageCount, rows.length, prefix, complete]);
      await client.query("COMMIT");
      if (complete) break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof PostgresErasureLedgerTransferError) throw error;
      fail("ERASURE_LEDGER_PAGE_COMMIT_FAILED");
    } finally {
      client.release();
    }
  }
  return { pages: pagesCommitted, resumed: checkpoint !== null };
}

async function scanPgTable(pool, schema, spec, { transferId = null, staged = false, pageSize }) {
  const relation = relationForSpec(schema, spec, staged);
  let after = null;
  let rowCount = 0;
  const hash = createHash("sha256");
  for (;;) {
    const query = pageSql(spec, relation, after, pageSize, staged ? transferId : null);
    const result = await pool.query(query.sql, query.values);
    if (!Array.isArray(result.rows) || result.rows.length > pageSize) fail("ERASURE_LEDGER_TARGET_PAGE_INVALID");
    const rows = result.rows.map((raw) => normalizeTargetRow(spec, raw));
    for (let index = 0; index < rows.length; index += 1) {
      if (after !== null && compareKey(key(spec, rows[index]), after) <= 0
          || index > 0 && compareKey(key(spec, rows[index - 1]), key(spec, rows[index])) >= 0) {
        fail("ERASURE_LEDGER_TARGET_ORDER_INVALID");
      }
      updateHash(hash, spec, rows[index]);
      after = key(spec, rows[index]);
      rowCount += 1;
    }
    if (rows.length < pageSize) break;
  }
  return tableManifest(spec, rowCount, hash.digest("hex"));
}

function manifestsEqual(left, right) {
  return left?.rowCount === right?.rowCount && left?.sha256 === right?.sha256;
}

async function validateTarget(pool, schema, targetMode = "disposable") {
  const version = Number((await pool.query("SHOW server_version_num")).rows?.[0]?.server_version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("ERASURE_LEDGER_POSTGRES_17_REQUIRED");
  const requiredTables = [
    "deletion_tombstones", "identity_reenrollment_cooldowns", "storage_erasure_jobs",
    "postgres_erasure_ledger_transfer_runs", "postgres_erasure_ledger_transfer_checkpoints",
    "postgres_erasure_ledger_transfer_table_receipts",
    ...TABLES.map((spec) => spec.stage),
  ];
  if (targetMode === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode) {
    requiredTables.push("postgres_erasure_ledger_transfer_target_contracts",
      "postgres_erasure_ledger_transfer_named_attempts");
  }
  for (const name of requiredTables) {
    const result = await pool.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`]);
    if (!result.rows?.[0]?.relation) fail("ERASURE_LEDGER_TARGET_SCHEMA_REQUIRED");
  }
  if (targetMode === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode) {
    const identity = await pool.query(
      "SELECT current_database() AS database, current_user AS role",
    );
    const identityRow = identity.rows?.[0];
    if (identityRow?.database !== POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.database
        || identityRow?.role !== POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.iamDatabaseRole) {
      fail("ERASURE_LEDGER_NAMED_TARGET_IDENTITY_INVALID");
    }
    const contract = await pool.query(`SELECT mode,project_id,project_number,instance_connection_name,
        database_name,schema_name,cloud_run_job_name,service_account_email,iam_database_role
      FROM ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_target_contracts")}
      WHERE target_contract_id=$1`, [POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.contractId]);
    const expected = POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET;
    const row = contract.rows?.[0];
    if (contract.rows?.length !== 1
        || row.mode !== expected.mode
        || row.project_id !== expected.projectId
        || row.project_number !== expected.projectNumber
        || row.instance_connection_name !== expected.instanceConnectionName
        || row.database_name !== expected.database
        || row.schema_name !== expected.schema
        || row.cloud_run_job_name !== expected.cloudRunJob
        || row.service_account_email !== expected.serviceAccount
        || row.iam_database_role !== expected.iamDatabaseRole) {
      fail("ERASURE_LEDGER_NAMED_TARGET_CONTRACT_INVALID");
    }
  }
  return version;
}

async function acquireLock(pool, schema) {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [`${schema}:postgres-erasure-ledger-transfer`]);
    if (result.rows?.[0]?.locked !== true) fail("ERASURE_LEDGER_TRANSFER_BUSY");
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function ensureRun({ pool, schema, transferId, snapshot, sourceManifest, pageSize,
  targetMode, targetContractId, sourceSealManifestSha256 }) {
  const runs = qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs");
  const values = [transferId, POSTGRES_ERASURE_LEDGER_TRANSFER_SCHEMA, schema,
    snapshot.artifactSha256, sourceManifest.sha256, pageSize];
  if (targetMode === "disposable") {
    // Ledger migration 0006 intentionally has no named-target columns. Keep
    // the disposable importer usable while migration 0007 remains a proposal.
    await pool.query(`INSERT INTO ${runs} (
        transfer_id,schema_version,target_schema,source_snapshot_sha256,source_manifest_sha256,page_size,status
      ) VALUES ($1,$2,$3,$4,$5,$6,'copying') ON CONFLICT (transfer_id) DO NOTHING`, values);
  } else {
    await pool.query(`INSERT INTO ${runs} (
        transfer_id,schema_version,target_schema,source_snapshot_sha256,source_manifest_sha256,page_size,status,
        target_mode,target_contract_id,source_seal_manifest_sha256
      ) VALUES ($1,$2,$3,$4,$5,$6,'copying',$7,$8,$9) ON CONFLICT (transfer_id) DO NOTHING`, [
      ...values, targetMode, targetContractId, sourceSealManifestSha256,
    ]);
  }
  const namedColumns = targetMode === "disposable" ? "" :
    ",target_mode,target_contract_id,source_seal_manifest_sha256";
  const result = await pool.query(`SELECT schema_version,target_schema,source_snapshot_sha256,
      source_manifest_sha256,page_size,status,target_manifest_sha256${namedColumns}
    FROM ${runs} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
  const row = result.rows[0];
  if (!row || row.schema_version !== POSTGRES_ERASURE_LEDGER_TRANSFER_SCHEMA || row.target_schema !== schema
      || row.source_snapshot_sha256 !== snapshot.artifactSha256 || row.source_manifest_sha256 !== sourceManifest.sha256
      || Number(row.page_size) !== pageSize
      || (targetMode !== "disposable" && (row.target_mode !== targetMode
        || row.target_contract_id !== targetContractId
        || row.source_seal_manifest_sha256 !== sourceSealManifestSha256))
      || !["copying", "staged", "complete"].includes(row.status)) {
    fail("ERASURE_LEDGER_TRANSFER_ID_REUSED");
  }
  return row;
}

async function registerNamedAttempt({ pool, schema, transferId, execution, snapshot,
  sourceSealManifestSha256 }) {
  const attempts = qualifiedControl(schema, "postgres_erasure_ledger_transfer_named_attempts");
  const target = POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET;
  await pool.query(`INSERT INTO ${attempts} (
      transfer_id,target_contract_id,cloud_run_execution,cloud_run_job_name,
      service_account_email,iam_database_role,source_snapshot_sha256,source_seal_manifest_sha256
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (transfer_id,cloud_run_execution) DO NOTHING`, [
    transferId, target.contractId, execution, target.cloudRunJob, target.serviceAccount,
    target.iamDatabaseRole, snapshot.artifactSha256, sourceSealManifestSha256,
  ]);
  const result = await pool.query(`SELECT target_contract_id,cloud_run_job_name,service_account_email,
      iam_database_role,source_snapshot_sha256,source_seal_manifest_sha256
    FROM ${attempts} WHERE transfer_id=$1 AND cloud_run_execution=$2`, [transferId, execution]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1
      || row.target_contract_id !== target.contractId
      || row.cloud_run_job_name !== target.cloudRunJob
      || row.service_account_email !== target.serviceAccount
      || row.iam_database_role !== target.iamDatabaseRole
      || row.source_snapshot_sha256 !== snapshot.artifactSha256
      || row.source_seal_manifest_sha256 !== sourceSealManifestSha256) {
    fail("ERASURE_LEDGER_NAMED_ATTEMPT_MISMATCH");
  }
}

async function insertReceipts({ pool, schema, transferId, sourceTables, stagedTables }) {
  const table = qualifiedControl(schema, "postgres_erasure_ledger_transfer_table_receipts");
  for (const spec of TABLES) {
    const source = sourceTables[spec.name];
    const target = stagedTables[spec.name];
    if (!manifestsEqual(source, target)) fail("ERASURE_LEDGER_SOURCE_DESTINATION_PARITY_FAILED");
    let result = await pool.query(`SELECT source_row_count::text,source_sha256,target_row_count::text,target_sha256
      FROM ${table} WHERE transfer_id=$1 AND table_name=$2`, [transferId, spec.name]);
    if (result.rows.length === 0) {
      await pool.query(`INSERT INTO ${table} (
          transfer_id,table_name,source_row_count,source_sha256,target_row_count,target_sha256
        ) VALUES ($1,$2,$3,$4,$3,$4)`, [transferId, spec.name, source.rowCount, source.sha256]);
      result = await pool.query(`SELECT source_row_count::text,source_sha256,target_row_count::text,target_sha256
        FROM ${table} WHERE transfer_id=$1 AND table_name=$2`, [transferId, spec.name]);
    }
    const row = result.rows[0];
    if (!row || BigInt(row.source_row_count) !== BigInt(source.rowCount) || row.source_sha256 !== source.sha256
        || BigInt(row.target_row_count) !== BigInt(target.rowCount) || row.target_sha256 !== target.sha256) {
      fail("ERASURE_LEDGER_RECEIPT_MISMATCH");
    }
  }
}

async function setStaged({ pool, schema, transferId, manifestSha, currentStatus }) {
  if (currentStatus === "staged" || currentStatus === "complete") {
    const result = await pool.query(`SELECT target_manifest_sha256 FROM ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs")}
      WHERE transfer_id=$1`, [transferId]);
    if (result.rows[0]?.target_manifest_sha256 !== manifestSha) fail("ERASURE_LEDGER_RECEIPT_MISMATCH");
    return;
  }
  const update = await pool.query(`UPDATE ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs")}
    SET status='staged',target_manifest_sha256=$2 WHERE transfer_id=$1 AND status='copying' RETURNING transfer_id`,
  [transferId, manifestSha]);
  if (update.rowCount !== 1) fail("ERASURE_LEDGER_TRANSFER_STATE_INVALID");
}

async function validateOrPromoteOperationalRows({ pool, schema, transferId, sourceManifest, pageSize }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query(`SELECT status,target_manifest_sha256 FROM ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs")}
      WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (!["staged", "complete"].includes(run.rows[0]?.status)
        || run.rows[0]?.target_manifest_sha256 !== manifestDigest(sourceManifest.tables)) {
      fail("ERASURE_LEDGER_TRANSFER_STATE_INVALID");
    }
    for (const spec of TABLES) {
      await client.query(`LOCK TABLE ${qualified(schema, spec.name)} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const before = Object.create(null);
    for (const spec of TABLES) before[spec.name] = await scanPgTable(client, schema, spec, { pageSize });
    const empty = Object.values(before).every((manifest) => manifest.rowCount === 0);
    const alreadyExact = TABLES.every((spec) => manifestsEqual(before[spec.name], sourceManifest.tables[spec.name]));
    if (!empty && !alreadyExact) fail("ERASURE_LEDGER_EXISTING_TARGET_DRIFT");
    if (run.rows[0].status === "complete" && !alreadyExact) fail("ERASURE_LEDGER_EXISTING_TARGET_DRIFT");
    if (alreadyExact) {
      if (run.rows[0].status === "staged") {
        await client.query(`UPDATE ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs")}
          SET status='complete',completed_at=clock_timestamp() WHERE transfer_id=$1 AND status='staged'`, [transferId]);
      }
      await client.query("COMMIT");
      return false;
    }
    if (run.rows[0].status !== "staged") fail("ERASURE_LEDGER_TRANSFER_STATE_INVALID");
    for (const spec of TABLES) {
      const live = qualified(schema, spec.name);
      const staged = qualifiedStage(schema, spec.stage);
      const columns = spec.columns.map((column) => `"${column}"`).join(",");
      await client.query(`INSERT INTO ${live} (${columns}) SELECT ${columns} FROM ${staged}
        WHERE transfer_id=$1 ORDER BY ${spec.key.map((column) => `"${column}"`).join(",")}
        ON CONFLICT DO NOTHING`, [transferId]);
    }
    const promoted = Object.create(null);
    for (const spec of TABLES) promoted[spec.name] = await scanPgTable(client, schema, spec, { pageSize });
    if (!TABLES.every((spec) => manifestsEqual(promoted[spec.name], sourceManifest.tables[spec.name]))) {
      fail("ERASURE_LEDGER_SOURCE_DESTINATION_PARITY_FAILED");
    }
    await client.query(`UPDATE ${qualifiedControl(schema, "postgres_erasure_ledger_transfer_runs")}
      SET status='complete',completed_at=clock_timestamp()
      WHERE transfer_id=$1 AND status='staged'`, [transferId]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresErasureLedgerTransferError) throw error;
    fail("ERASURE_LEDGER_PROMOTION_FAILED");
  } finally {
    client.release();
  }
}

/**
 * Import a sealed D1 erasure-ledger SQLite export into PostgreSQL.
 * Rows remain in transfer staging tables until all three source/staging count
 * and digest receipts agree. A final transaction promotes only into an empty
 * target or verifies an already-exact target; drift is never overwritten.
 */
async function executeTransfer({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  transferId,
  pageSize = POSTGRES_ERASURE_LEDGER_DEFAULT_PAGE_SIZE,
  targetMode = "disposable",
  targetContractId = null,
  cloudRunExecution = null,
  sourceSealManifestSha256 = null,
} = {}) {
  const schema = validTargetSchema(rawTargetSchema, targetMode);
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("ERASURE_LEDGER_TRANSFER_ID_INVALID");
  const size = validatePageSize(pageSize);
  if (targetMode === "disposable") {
    if (targetContractId !== null || cloudRunExecution !== null || sourceSealManifestSha256 !== null) {
      fail("ERASURE_LEDGER_NAMED_TARGET_PROOF_INVALID");
    }
  } else if (targetMode !== POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode
      || targetContractId !== POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.contractId
      || typeof cloudRunExecution !== "string" || !CLOUD_RUN_EXECUTION.test(cloudRunExecution)
      || typeof sourceSealManifestSha256 !== "string" || !DIGEST.test(sourceSealManifestSha256)) {
    fail("ERASURE_LEDGER_NAMED_TARGET_PROOF_INVALID");
  }
  const snapshot = trustedSnapshot(source);
  if (!destinationPool || typeof destinationPool.query !== "function" || typeof destinationPool.connect !== "function") {
    fail("ERASURE_LEDGER_DESTINATION_REQUIRED");
  }
  await source.verifySnapshot();
  const postgresVersion = await validateTarget(destinationPool, schema, targetMode);
  const sourceManifest = await scanSource(source, size);
  await source.verifySnapshot();
  const lockClient = await acquireLock(destinationPool, schema);
  try {
    const run = await ensureRun({ pool: destinationPool, schema, transferId, snapshot,
      sourceManifest, pageSize: size, targetMode, targetContractId, sourceSealManifestSha256 });
    if (targetMode === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode) {
      await registerNamedAttempt({ pool: destinationPool, schema, transferId,
        execution: cloudRunExecution, snapshot, sourceSealManifestSha256 });
    }
    let pagesCommitted = 0;
    let resumed = run.status !== "copying";
    for (const spec of TABLES) {
      const result = await copyTable({ source, pool: destinationPool, schema, transferId, spec,
        pageSize: size, existingRunStatus: run.status });
      pagesCommitted += result.pages;
      resumed ||= result.resumed;
    }
    await source.verifySnapshot();
    const finalSource = await scanSource(source, size);
    if (finalSource.sha256 !== sourceManifest.sha256) fail("ERASURE_LEDGER_SOURCE_CHANGED");
    await source.verifySnapshot();

    const stagedTables = Object.create(null);
    for (const spec of TABLES) stagedTables[spec.name] = await scanPgTable(destinationPool, schema, spec,
      { transferId, staged: true, pageSize: size });
    const stagedSha = manifestDigest(stagedTables);
    await insertReceipts({ pool: destinationPool, schema, transferId,
      sourceTables: sourceManifest.tables, stagedTables });
    await setStaged({ pool: destinationPool, schema, transferId, manifestSha: stagedSha, currentStatus: run.status });
    await source.verifySnapshot();
    const promoted = await validateOrPromoteOperationalRows({ pool: destinationPool, schema, transferId,
      sourceManifest, pageSize: size });
    const targetTables = Object.create(null);
    for (const spec of TABLES) targetTables[spec.name] = await scanPgTable(destinationPool, schema, spec, { pageSize: size });
    if (!TABLES.every((spec) => manifestsEqual(targetTables[spec.name], sourceManifest.tables[spec.name]))) {
      fail("ERASURE_LEDGER_SOURCE_DESTINATION_PARITY_FAILED");
    }
    await source.verifySnapshot();
    return Object.freeze({
      schema: POSTGRES_ERASURE_LEDGER_TRANSFER_SCHEMA,
      status: "historical_erasure_ledger_reconciled",
      targetSchema: schema,
      postgresMajor: Math.floor(postgresVersion / 10_000),
      sourceSnapshotSha256: snapshot.artifactSha256,
      sourceManifestSha256: sourceManifest.sha256,
      stagedManifestSha256: stagedSha,
      operationalManifestSha256: manifestDigest(targetTables),
      tables: Object.freeze(Object.fromEntries(TABLES.map((spec) => [spec.name, Object.freeze({
        sourceRows: sourceManifest.tables[spec.name].rowCount,
        targetRows: targetTables[spec.name].rowCount,
        sourceSha256: sourceManifest.tables[spec.name].sha256,
        targetSha256: targetTables[spec.name].sha256,
      })]))),
      pageSize: size,
      pagesCommitted,
      resumed,
      operationalRowsPromoted: promoted,
      capabilities: Object.freeze({ historicalRowsReconciled: true, transferReceiptsWritten: true,
        namedTestTarget: targetMode === POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode,
        applicationLedgerRoutingChanged: false, erasureRuntimeActivated: false, productionCutoverAuthorized: false }),
    });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:postgres-erasure-ledger-transfer`]).catch(() => {});
    lockClient.release();
  }
}

/** Reconcile to the one fixed GCP test ledger using its dedicated Cloud Run IAM database role. */
export async function runPostgresNamedGcpTestErasureLedgerTransfer({
  source,
  destinationPool,
  transferId,
  cloudRunExecution,
  sourceSealManifestSha256,
  pageSize = POSTGRES_ERASURE_LEDGER_DEFAULT_PAGE_SIZE,
} = {}) {
  const snapshot = trustedSnapshot(source);
  const expectedTransferId = `gcp-test-erasure-${snapshot.artifactSha256}`;
  if (transferId !== expectedTransferId) fail("ERASURE_LEDGER_NAMED_TRANSFER_ID_INVALID");
  return executeTransfer({
    source,
    destinationPool,
    targetSchema: POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.schema,
    transferId,
    pageSize,
    targetMode: POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode,
    targetContractId: POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.contractId,
    cloudRunExecution,
    sourceSealManifestSha256,
  });
}

/** Preserve the disposable-only importer as the default and unrestricted public entrypoint. */
export async function runPostgresErasureLedgerTransfer(options = {}) {
  return executeTransfer({ ...options, targetMode: "disposable", targetContractId: null,
    cloudRunExecution: null, sourceSealManifestSha256: null });
}

export const POSTGRES_ERASURE_LEDGER_SOURCE_COLUMNS = Object.freeze(
  Object.fromEntries(TABLES.map((spec) => [spec.name, spec.columns])),
);
