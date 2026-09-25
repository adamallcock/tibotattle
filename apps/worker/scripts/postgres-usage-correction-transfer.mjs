import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const POSTGRES_USAGE_CORRECTION_TRANSFER_SCHEMA = "postgres-usage-correction-transfer-v1";
export const POSTGRES_USAGE_CORRECTION_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_USAGE_CORRECTION_MAX_PAGE_SIZE = 200;
export const POSTGRES_USAGE_CORRECTION_TARGET_SCHEMA_PREFIX = "usage_correction_transfer_target_";

const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const MAX_SAFE_ID = 9_007_199_254_740_991n;
const TRUSTED_SOURCES = new WeakSet();
const encoder = new TextEncoder();

const SPECIFICATIONS = Object.freeze([
  Object.freeze({
    name: "telemetry_usage_correction_runtime",
    columns: Object.freeze(["id", "schema_version", "method_version", "state", "max_capture_rows", "max_history_page"]),
    types: Object.freeze(["i16", "text", "text", "text", "i32", "i32"]),
    sqliteTypes: Object.freeze(["INTEGER", "TEXT", "TEXT", "TEXT", "INTEGER", "INTEGER"]),
  }),
  Object.freeze({
    name: "telemetry_usage_correction_history",
    columns: Object.freeze([
      "id", "participant_id", "owner_digest", "owner_revision", "authority_epoch", "source_format",
      "namespace_id", "owner_id", "device_id", "chunk_id", "manifest_id", "source_storage_row_id",
      "source_row_id", "occurrence_id", "event_time_ms", "provider_id", "session_id", "model_id",
      "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id", "reasoning_effort_id",
      "agent_scope_id", "outcome_id", "attribution_id", "total_input_context_tokens", "input_uncached_tokens",
      "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens",
      "output_combined_tokens", "source_chunk_digest", "source_event_digest", "record_digest", "base_digest",
      "captured_at_ms",
    ]),
    types: Object.freeze([
      "i64", "text", "bytes", "i64", "i64", "i16", "i64", "i64", "i64", "i64", "i64", "i64",
      "i64", "bytes", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64",
      "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "bytes", "bytes", "bytes",
      "bytes", "i64",
    ]),
    sqliteTypes: Object.freeze([
      "INTEGER", "TEXT", "BLOB", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER",
      "INTEGER", "INTEGER", "INTEGER", "INTEGER", "BLOB", "INTEGER", "INTEGER", "INTEGER", "INTEGER",
      "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER",
      "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "BLOB", "BLOB", "BLOB", "BLOB",
      "INTEGER",
    ]),
  }),
  Object.freeze({
    name: "telemetry_usage_correction_facts",
    columns: Object.freeze(["id", "history_id", "method_version", "captured_at_ms"]),
    types: Object.freeze(["i64", "i64", "i16", "i64"]),
    sqliteTypes: Object.freeze(["INTEGER", "INTEGER", "INTEGER", "INTEGER"]),
  }),
]);
const SPEC_BY_NAME = new Map(SPECIFICATIONS.map(spec => [spec.name, spec]));
const CONTROL_TABLES = new Set([
  "postgres_usage_correction_transfer_runs",
  "postgres_usage_correction_transfer_checkpoints",
  "postgres_usage_correction_transfer_table_receipts",
]);

export class PostgresUsageCorrectionTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresUsageCorrectionTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresUsageCorrectionTransferError(code);
}

function quoteSchema(value) {
  if (typeof value !== "string" || !SCHEMA.test(value)) fail("USAGE_CORRECTION_SCHEMA_INVALID");
  return `"${value}"`;
}

function relation(schema, name) {
  if (!SPEC_BY_NAME.has(name) && !CONTROL_TABLES.has(name)) fail("USAGE_CORRECTION_TABLE_INVALID");
  return `${quoteSchema(schema)}."${name}"`;
}

function sha256() {
  return createHash("sha256");
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      fail("USAGE_CORRECTION_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof PostgresUsageCorrectionTransferError) throw error;
      fail("USAGE_CORRECTION_SQLITE_UNAVAILABLE");
    }
  }
}

async function fingerprintSqlite(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("USAGE_CORRECTION_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) {
      fail("USAGE_CORRECTION_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("USAGE_CORRECTION_SQLITE_CHANGED");
    const hash = sha256();
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("USAGE_CORRECTION_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(opened, after)) fail("USAGE_CORRECTION_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresUsageCorrectionTransferError) throw error;
    fail("USAGE_CORRECTION_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateSqliteLayout(database) {
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const spec of SPECIFICATIONS) {
    if (!names.has(spec.name)) fail("USAGE_CORRECTION_SQLITE_LAYOUT_INVALID");
    const columns = database.prepare(`PRAGMA table_info("${spec.name}")`).all();
    if (columns.length !== spec.columns.length
        || columns.some((column, index) => column.name !== spec.columns[index]
          || String(column.type).toUpperCase() !== spec.sqliteTypes[index])) {
      fail("USAGE_CORRECTION_SQLITE_LAYOUT_INVALID");
    }
  }
  const runtimeCount = database.prepare("SELECT count(*) AS count FROM telemetry_usage_correction_runtime").get().count;
  if (BigInt(runtimeCount) !== 1n) fail("USAGE_CORRECTION_RUNTIME_INVALID");
  const orphanFacts = database.prepare(`SELECT count(*) AS count
    FROM telemetry_usage_correction_facts fact
    LEFT JOIN telemetry_usage_correction_history history ON history.id=fact.history_id
    WHERE history.id IS NULL OR fact.method_version <> 1
       OR fact.captured_at_ms <> history.captured_at_ms`).get().count;
  const missingFacts = database.prepare(`SELECT count(*) AS count
    FROM telemetry_usage_correction_history history
    LEFT JOIN telemetry_usage_correction_facts fact
      ON fact.history_id=history.id AND fact.method_version=1
    WHERE fact.id IS NULL`).get().count;
  if (BigInt(orphanFacts) !== 0n || BigInt(missingFacts) !== 0n) fail("USAGE_CORRECTION_FACT_PARITY_INVALID");
}

function validSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || source.snapshot?.kind !== "sealed-sqlite-rehearsal"
      || source.snapshot?.immutable !== true || !SHA256.test(source.snapshot.artifactSha256 ?? "")
      || source.snapshot.snapshotId !== `sha256:${source.snapshot.artifactSha256}`) {
    fail("USAGE_CORRECTION_SEALED_SOURCE_REQUIRED");
  }
  return source.snapshot;
}

export async function createSealedSqliteUsageCorrectionSource({ path, expectedSha256 } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("USAGE_CORRECTION_SQLITE_SHA256_REQUIRED");
  const initial = await fingerprintSqlite(path);
  if (initial.sha256 !== expectedSha256) fail("USAGE_CORRECTION_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("USAGE_CORRECTION_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("USAGE_CORRECTION_SQLITE_INTEGRITY_FAILED");
    }
    validateSqliteLayout(database);
  } catch (error) {
    database?.close();
    if (error instanceof PostgresUsageCorrectionTransferError) throw error;
    fail("USAGE_CORRECTION_SQLITE_INVALID");
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
      if (closed) fail("USAGE_CORRECTION_SQLITE_CLOSED");
      const actual = await fingerprintSqlite(path);
      if (actual.sha256 !== expectedSha256 || !sameStat(initial.stat, actual.stat)) {
        fail("USAGE_CORRECTION_SOURCE_CHANGED");
      }
      return { snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 };
    },
    async listPage({ table, after = null, limit } = {}) {
      if (closed) fail("USAGE_CORRECTION_SQLITE_CLOSED");
      const spec = SPEC_BY_NAME.get(table);
      if (!spec) fail("USAGE_CORRECTION_TABLE_INVALID");
      validatePageSize(limit);
      if (after !== null) {
        const cursor = normalizeInteger(after, "i64");
        if (cursor === null || !positiveInteger(cursor)) fail("USAGE_CORRECTION_CURSOR_INVALID");
      }
      const statementKey = `${table}:${after === null ? "first" : "next"}`;
      let statement = prepared.get(statementKey);
      if (!statement) {
        const columns = spec.columns.map(column => `"${column}"`).join(",");
        const sql = after === null
          ? `SELECT ${columns} FROM "${table}" ORDER BY id LIMIT ?`
          : `SELECT ${columns} FROM "${table}" WHERE id > ? ORDER BY id LIMIT ?`;
        try {
          statement = database.prepare(sql);
          statement.setReadBigInts(true);
          prepared.set(statementKey, statement);
        } catch {
          fail("USAGE_CORRECTION_SQLITE_READ_FAILED");
        }
      }
      try {
        const rawRows = after === null ? statement.all(BigInt(limit)) : statement.all(BigInt(after), BigInt(limit));
        if (rawRows.length > limit) fail("USAGE_CORRECTION_SOURCE_PAGE_INVALID");
        return Object.freeze({ rows: Object.freeze(rawRows.map(row => normalizeRow(spec, row))) });
      } catch (error) {
        if (error instanceof PostgresUsageCorrectionTransferError) throw error;
        fail("USAGE_CORRECTION_SQLITE_READ_FAILED");
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
  validSource(source);
  return source;
}

function normalizeInteger(value, type) {
  if (value === null || value === undefined) return null;
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("USAGE_CORRECTION_VALUE_INVALID");
  if (type === "i64") return parsed.toString();
  const min = type === "i16" ? -32768 : -2147483648;
  const max = type === "i16" ? 32767 : 2147483647;
  if (parsed < BigInt(min) || parsed > BigInt(max)) fail("USAGE_CORRECTION_VALUE_INVALID");
  return Number(parsed);
}

function normalizeValue(type, value) {
  if (value === null) return null;
  if (value === undefined) fail("USAGE_CORRECTION_VALUE_INVALID");
  if (["i64", "i16", "i32"].includes(type)) return normalizeInteger(value, type);
  if (type === "text") {
    if (typeof value !== "string" || encoder.encode(value).byteLength > 512) fail("USAGE_CORRECTION_VALUE_INVALID");
    return value;
  }
  if (type === "bytes") {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer)) {
      fail("USAGE_CORRECTION_VALUE_INVALID");
    }
    return Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  }
  fail("USAGE_CORRECTION_COLUMN_TYPE_INVALID");
}

function normalizeRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("USAGE_CORRECTION_SOURCE_ROW_INVALID");
  const row = Object.create(null);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    row[column] = normalizeValue(spec.types[index], raw[column]);
  }
  validateSourceRow(spec, row);
  return row;
}

function positiveInteger(value, max = MAX_SAFE_ID) {
  if (value === null || value === undefined) return false;
  const number = BigInt(value);
  return number >= 1n && number <= max;
}

function validateSourceRow(spec, row) {
  if (spec.name === "telemetry_usage_correction_runtime") {
    if (row.id !== 1 || row.schema_version !== "telemetry-usage-correction-v1"
        || row.method_version !== "usage-total-correction-v1" || !["staged", "active"].includes(row.state)
        || row.max_capture_rows < 1 || row.max_capture_rows > 200
        || row.max_history_page < 1 || row.max_history_page > 200) fail("USAGE_CORRECTION_RUNTIME_INVALID");
    return;
  }
  if (spec.name === "telemetry_usage_correction_facts") {
    if (!positiveInteger(row.id) || !positiveInteger(row.history_id) || row.method_version !== 1
        || !positiveInteger(row.captured_at_ms, 8_640_000_000_000_000n)) fail("USAGE_CORRECTION_FACT_INVALID");
    return;
  }
  if (!positiveInteger(row.id) || typeof row.participant_id !== "string"
      || encoder.encode(row.participant_id).byteLength < 1 || encoder.encode(row.participant_id).byteLength > 256
      || row.owner_digest.byteLength !== 32 || !positiveInteger(row.owner_revision)
      || !positiveInteger(row.authority_epoch) || row.source_format !== 10
      || !positiveInteger(row.namespace_id) || !positiveInteger(row.owner_id)
      || !positiveInteger(row.device_id) || !positiveInteger(row.chunk_id)
      || row.manifest_id !== null || !positiveInteger(row.source_storage_row_id)
      || !positiveInteger(row.source_row_id) || row.occurrence_id.byteLength < 2
      || row.occurrence_id.byteLength > 257 || BigInt(row.event_time_ms) < -8_640_000_000_000_000n
      || BigInt(row.event_time_ms) > 8_640_000_000_000_000n) fail("USAGE_CORRECTION_HISTORY_INVALID");
  for (const name of ["provider_id", "session_id", "model_id", "speed_mode_id", "api_service_tier_id",
    "surface_id", "billing_surface_id", "reasoning_effort_id", "agent_scope_id", "outcome_id"]) {
    if (!positiveInteger(row[name])) fail("USAGE_CORRECTION_HISTORY_INVALID");
  }
  if (row.attribution_id !== null && !positiveInteger(row.attribution_id)) fail("USAGE_CORRECTION_HISTORY_INVALID");
  for (const name of ["total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens",
    "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"]) {
    if (row[name] !== null && (BigInt(row[name]) < 0n || BigInt(row[name]) > 1_000_000_000_000n)) {
      fail("USAGE_CORRECTION_HISTORY_INVALID");
    }
  }
  for (const name of ["source_chunk_digest", "source_event_digest", "record_digest", "base_digest"]) {
    if (row[name].byteLength !== 32) fail("USAGE_CORRECTION_HISTORY_INVALID");
  }
  if (!positiveInteger(row.captured_at_ms, 8_640_000_000_000_000n)) fail("USAGE_CORRECTION_HISTORY_INVALID");
}

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_USAGE_CORRECTION_MAX_PAGE_SIZE) {
    fail("USAGE_CORRECTION_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function canonicalValue(type, value) {
  if (value === null) return null;
  if (type === "bytes") return ["bytea", value.toString("base64")];
  if (type === "i64") return ["int64", value];
  if (type === "i16" || type === "i32") return [type, value];
  return ["text", value];
}

function updateRowHash(hash, spec, row) {
  hash.update(`${JSON.stringify(spec.columns.map((column, index) => canonicalValue(spec.types[index], row[column])))}\n`);
}

function manifestDigest(tables) {
  return sha256().update(JSON.stringify({
    schema: POSTGRES_USAGE_CORRECTION_TRANSFER_SCHEMA,
    tables: SPECIFICATIONS.map(spec => ({
      name: spec.name,
      rowCount: tables[spec.name].rowCount,
      sha256: tables[spec.name].sha256,
    })),
  })).digest("hex");
}

async function scanSourceTable(source, spec, pageSize) {
  const hash = sha256();
  let count = 0;
  let after = null;
  for (;;) {
    const page = await source.listPage({ table: spec.name, after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("USAGE_CORRECTION_SOURCE_PAGE_INVALID");
    for (const row of page.rows) {
      if (after !== null && BigInt(row.id) <= BigInt(after)) fail("USAGE_CORRECTION_SOURCE_ORDER_INVALID");
      updateRowHash(hash, spec, row);
      after = row.id;
      count += 1;
    }
    if (page.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: count, sha256: hash.digest("hex") });
}

async function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const spec of SPECIFICATIONS) tables[spec.name] = await scanSourceTable(source, spec, pageSize);
  if (tables.telemetry_usage_correction_runtime.rowCount !== 1) fail("USAGE_CORRECTION_RUNTIME_INVALID");
  return Object.freeze({ tables: Object.freeze(tables), sha256: manifestDigest(tables) });
}

function normalizeTargetRow(spec, raw) {
  if (spec.name !== "telemetry_usage_correction_runtime") return normalizeRow(spec, raw);
  const row = {
    id: normalizeValue("i16", raw.id),
    schema_version: normalizeValue("text", raw.schema_version),
    method_version: normalizeValue("text", raw.method_version),
    state: normalizeValue("text", raw.source_state),
    max_capture_rows: normalizeValue("i32", raw.max_capture_rows),
    max_history_page: normalizeValue("i32", raw.max_history_page),
  };
  validateSourceRow(spec, row);
  if (raw.operational_state !== "staged") fail("USAGE_CORRECTION_RUNTIME_ACTIVATION_REFUSED");
  return row;
}

function targetColumns(spec) {
  if (spec.name === "telemetry_usage_correction_runtime") {
    return ["id", "schema_version", "method_version", "state", "source_state", "max_capture_rows", "max_history_page"];
  }
  return spec.columns;
}

function sourceInsertValues(spec, row) {
  if (spec.name !== "telemetry_usage_correction_runtime") return spec.columns.map(column => row[column]);
  return [row.id, row.schema_version, row.method_version, "staged", row.state,
    row.max_capture_rows, row.max_history_page];
}

function insertSql(schema, spec, count) {
  const columns = targetColumns(spec);
  const values = Array.from({ length: count }, (_, rowIndex) =>
    `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`).join(",");
  const list = columns.map(column => `"${column}"`).join(",");
  return `INSERT INTO ${relation(schema, spec.name)} (${list}) VALUES ${values} ON CONFLICT (id) DO NOTHING`;
}

function valuesForRows(spec, rows) {
  return rows.flatMap(row => sourceInsertValues(spec, row));
}

async function verifyTargetPage(client, schema, spec, sourceRows) {
  if (sourceRows.length === 0) return;
  const columns = spec.name === "telemetry_usage_correction_runtime"
    ? `id,schema_version,method_version,state AS operational_state,source_state,max_capture_rows,max_history_page`
    : spec.columns.map(column => `"${column}"`).join(",");
  const ids = sourceRows.map(row => row.id);
  const result = await client.query(`SELECT ${columns} FROM ${relation(schema, spec.name)} WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  if (result.rowCount !== sourceRows.length) fail("USAGE_CORRECTION_DESTINATION_ROW_MISMATCH");
  for (let index = 0; index < sourceRows.length; index += 1) {
    const target = normalizeTargetRow(spec, result.rows[index]);
    const source = sourceRows[index];
    if (spec.columns.some(column => !sameValue(source[column], target[column]))) {
      fail("USAGE_CORRECTION_DESTINATION_ROW_MISMATCH");
    }
  }
}

function sameValue(left, right) {
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  return left === right;
}

async function validateTarget(pool, schema) {
  const version = Number((await pool.query("SHOW server_version_num")).rows?.[0]?.server_version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("USAGE_CORRECTION_POSTGRES_17_REQUIRED");
  for (const name of [...SPEC_BY_NAME.keys(), ...CONTROL_TABLES]) {
    const result = await pool.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`]);
    if (!result.rows?.[0]?.relation) fail("USAGE_CORRECTION_TARGET_SCHEMA_REQUIRED");
  }
  return version;
}

async function ensureRun({ pool, schema, transferId, snapshot, sourceManifest, runtimeState }) {
  const runs = relation(schema, "postgres_usage_correction_transfer_runs");
  await pool.query(`INSERT INTO ${runs} (
      transfer_id,schema_version,target_schema,source_snapshot_sha256,source_manifest_sha256,
      source_runtime_state,status
    ) VALUES ($1,$2,$3,$4,$5,$6,'running') ON CONFLICT (transfer_id) DO NOTHING`, [
    transferId, POSTGRES_USAGE_CORRECTION_TRANSFER_SCHEMA, schema,
    snapshot.artifactSha256, sourceManifest.sha256, runtimeState,
  ]);
  const result = await pool.query(`SELECT schema_version,target_schema,source_snapshot_sha256,
      source_manifest_sha256,source_runtime_state,status
    FROM ${runs} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
  const row = result.rows[0];
  if (!row || row.schema_version !== POSTGRES_USAGE_CORRECTION_TRANSFER_SCHEMA
      || row.target_schema !== schema || row.source_snapshot_sha256 !== snapshot.artifactSha256
      || row.source_manifest_sha256 !== sourceManifest.sha256 || row.source_runtime_state !== runtimeState) {
    fail("USAGE_CORRECTION_TRANSFER_ID_REUSED");
  }
  return row.status;
}

async function acquireLock(pool, schema, transferId) {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [`${schema}:usage-correction:${transferId}`]);
    if (result.rows?.[0]?.locked !== true) fail("USAGE_CORRECTION_TRANSFER_BUSY");
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function readCheckpoint(client, schema, transferId, tableName) {
  const result = await client.query(`SELECT last_id::text,row_count::text,page_count::text,complete
    FROM ${relation(schema, "postgres_usage_correction_transfer_checkpoints")}
    WHERE transfer_id=$1 AND table_name=$2`, [transferId, tableName]);
  return result.rows[0] ?? null;
}

async function copyTable({ source, pool, schema, transferId, spec, pageSize }) {
  const checkpointClient = await pool.connect();
  let checkpoint;
  try {
    checkpoint = await readCheckpoint(checkpointClient, schema, transferId, spec.name);
  } finally {
    checkpointClient.release();
  }
  if (checkpoint?.complete) return { pages: 0, resumed: true };
  let after = checkpoint?.last_id ?? null;
  let rowCount = Number(checkpoint?.row_count ?? 0);
  let pageCount = Number(checkpoint?.page_count ?? 0);
  if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(pageCount)) fail("USAGE_CORRECTION_CHECKPOINT_INVALID");
  let pagesWritten = 0;
  for (;;) {
    const { rows } = await source.listPage({ table: spec.name, after, limit: pageSize });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (rows.length > 0) {
        await client.query(insertSql(schema, spec, rows.length), valuesForRows(spec, rows));
        await verifyTargetPage(client, schema, spec, rows);
        after = rows.at(-1).id;
        rowCount += rows.length;
        pageCount += 1;
        pagesWritten += 1;
      }
      const complete = rows.length < pageSize;
      await client.query(`INSERT INTO ${relation(schema, "postgres_usage_correction_transfer_checkpoints")}
        (transfer_id,table_name,last_id,row_count,page_count,complete)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (transfer_id,table_name) DO UPDATE SET last_id=EXCLUDED.last_id,
          row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=EXCLUDED.complete`, [
        transferId, spec.name, after, rowCount, pageCount, complete,
      ]);
      await client.query("COMMIT");
      if (complete) break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof PostgresUsageCorrectionTransferError) throw error;
      fail("USAGE_CORRECTION_PAGE_COMMIT_FAILED");
    } finally {
      client.release();
    }
  }
  return { pages: pagesWritten, resumed: checkpoint !== null };
}

async function scanTargetTable(pool, schema, spec, pageSize) {
  const hash = sha256();
  const columns = spec.name === "telemetry_usage_correction_runtime"
    ? `id,schema_version,method_version,state AS operational_state,source_state,max_capture_rows,max_history_page`
    : spec.columns.map(column => `"${column}"`).join(",");
  let after = null;
  let rowCount = 0;
  for (;;) {
    const values = after === null ? [pageSize] : [after, pageSize];
    const cursor = after === null ? "" : " WHERE id > $1";
    const limit = after === null ? "$1" : "$2";
    const result = await pool.query(`SELECT ${columns} FROM ${relation(schema, spec.name)}${cursor}
      ORDER BY id LIMIT ${limit}`, values);
    const rows = result.rows.map(raw => normalizeTargetRow(spec, raw));
    if (rows.length > pageSize) fail("USAGE_CORRECTION_DESTINATION_PAGE_INVALID");
    for (const row of rows) {
      if (after !== null && BigInt(row.id) <= BigInt(after)) fail("USAGE_CORRECTION_DESTINATION_ORDER_INVALID");
      updateRowHash(hash, spec, row);
      after = row.id;
      rowCount += 1;
    }
    if (rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount, sha256: hash.digest("hex") });
}

function tableManifestEquals(left, right) {
  return left.rowCount === right.rowCount && left.sha256 === right.sha256;
}

async function finalizeRun({ pool, schema, transferId, sourceManifest, targetManifest, runStatus }) {
  const runTable = relation(schema, "postgres_usage_correction_transfer_runs");
  const tableReceipts = relation(schema, "postgres_usage_correction_transfer_table_receipts");
  for (const spec of SPECIFICATIONS) {
    const sourceTable = sourceManifest.tables[spec.name];
    const targetTable = targetManifest.tables[spec.name];
    if (!tableManifestEquals(sourceTable, targetTable)) fail("USAGE_CORRECTION_SOURCE_DESTINATION_PARITY_FAILED");
    let receipt = await pool.query(`SELECT source_row_count::text,source_sha256,target_row_count::text,target_sha256
      FROM ${tableReceipts} WHERE transfer_id=$1 AND table_name=$2`, [transferId, spec.name]);
    if (receipt.rowCount === 0) {
      if (runStatus === "complete") fail("USAGE_CORRECTION_RECEIPT_MISMATCH");
      await pool.query(`INSERT INTO ${tableReceipts} (
          transfer_id,table_name,source_row_count,source_sha256,target_row_count,target_sha256
        ) VALUES ($1,$2,$3,$4,$3,$4)`, [transferId, spec.name, sourceTable.rowCount, sourceTable.sha256]);
      receipt = await pool.query(`SELECT source_row_count::text,source_sha256,target_row_count::text,target_sha256
        FROM ${tableReceipts} WHERE transfer_id=$1 AND table_name=$2`, [transferId, spec.name]);
    }
    const row = receipt.rows[0];
    if (!row || Number(row.source_row_count) !== sourceTable.rowCount
        || row.source_sha256 !== sourceTable.sha256 || Number(row.target_row_count) !== targetTable.rowCount
        || row.target_sha256 !== targetTable.sha256) fail("USAGE_CORRECTION_RECEIPT_MISMATCH");
  }
  const targetDigest = manifestDigest(targetManifest.tables);
  const result = await pool.query(`UPDATE ${runTable}
      SET status='complete',target_manifest_sha256=$2,updated_at=clock_timestamp(),completed_at=clock_timestamp()
    WHERE transfer_id=$1 AND status='running' RETURNING transfer_id`, [transferId, targetDigest]);
  if (result.rowCount === 0) {
    const existing = await pool.query(`SELECT status,target_manifest_sha256 FROM ${runTable} WHERE transfer_id=$1`, [transferId]);
    if (existing.rows[0]?.status !== "complete" || existing.rows[0]?.target_manifest_sha256 !== targetDigest) {
      fail("USAGE_CORRECTION_RECEIPT_MISMATCH");
    }
  }
}

/**
 * Copy sealed D1 correction evidence into a migrated PostgreSQL rehearsal
 * schema. Each page and its checkpoint commit atomically. Repeating the same
 * transfer id resumes only against the same sealed bytes and source manifest.
 * Runtime is kept staged even when `source_state` says `active`.
 */
export async function runPostgresUsageCorrectionTransfer({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  transferId,
  pageSize = POSTGRES_USAGE_CORRECTION_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = typeof rawTargetSchema === "string" ? rawTargetSchema : "";
  const suffix = schema.startsWith(POSTGRES_USAGE_CORRECTION_TARGET_SCHEMA_PREFIX)
    ? schema.slice(POSTGRES_USAGE_CORRECTION_TARGET_SCHEMA_PREFIX.length) : "";
  if (!SCHEMA.test(schema) || !TARGET_SUFFIX.test(suffix)) fail("USAGE_CORRECTION_TARGET_SCHEMA_REQUIRED");
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("USAGE_CORRECTION_TRANSFER_ID_INVALID");
  const size = validatePageSize(pageSize);
  const snapshot = validSource(source);
  if (!destinationPool || typeof destinationPool.query !== "function" || typeof destinationPool.connect !== "function") {
    fail("USAGE_CORRECTION_DESTINATION_REQUIRED");
  }
  await source.verifySnapshot();
  const postgresVersion = await validateTarget(destinationPool, schema);
  const sourceManifest = await scanSource(source, size);
  const runtimeRows = await source.listPage({ table: "telemetry_usage_correction_runtime", after: null, limit: 1 });
  const sourceRuntimeState = runtimeRows.rows[0]?.state;
  if (!sourceRuntimeState) fail("USAGE_CORRECTION_RUNTIME_INVALID");
  await source.verifySnapshot();
  const lockClient = await acquireLock(destinationPool, schema, transferId);
  let lockReleased = false;
  try {
    const status = await ensureRun({
      pool: destinationPool, schema, transferId, snapshot, sourceManifest, runtimeState: sourceRuntimeState,
    });
    let pagesCommitted = 0;
    for (const spec of SPECIFICATIONS) {
      const result = await copyTable({ source, pool: destinationPool, schema, transferId, spec, pageSize: size });
      pagesCommitted += result.pages;
    }
    await source.verifySnapshot();
    const finalSource = await scanSource(source, size);
    if (finalSource.sha256 !== sourceManifest.sha256) fail("USAGE_CORRECTION_SOURCE_CHANGED");
    await source.verifySnapshot();
    const targetTables = Object.create(null);
    for (const spec of SPECIFICATIONS) targetTables[spec.name] = await scanTargetTable(destinationPool, schema, spec, size);
    const targetManifest = Object.freeze({ tables: Object.freeze(targetTables) });
    await finalizeRun({ pool: destinationPool, schema, transferId, sourceManifest, targetManifest, runStatus: status });
    return Object.freeze({
      schema: POSTGRES_USAGE_CORRECTION_TRANSFER_SCHEMA,
      status: "staged_usage_correction_transfer_complete",
      targetSchema: schema,
      postgresMajor: Math.floor(postgresVersion / 10_000),
      sourceSnapshotSha256: snapshot.artifactSha256,
      sourceManifestSha256: sourceManifest.sha256,
      targetManifestSha256: manifestDigest(targetManifest.tables),
      sourceRuntimeState,
      targetRuntimeState: "staged",
      tables: Object.freeze(Object.fromEntries(SPECIFICATIONS.map(spec => [spec.name, Object.freeze({
        sourceRows: sourceManifest.tables[spec.name].rowCount,
        targetRows: targetManifest.tables[spec.name].rowCount,
        sourceSha256: sourceManifest.tables[spec.name].sha256,
        targetSha256: targetManifest.tables[spec.name].sha256,
      })]))),
      pageSize: size,
      pagesCommitted,
      capabilities: Object.freeze({ correctionRowsTransferred: true, readerEnabled: false,
        ownerErasureAuthorized: false, semanticReconstructionQualified: false,
        productionCutoverAuthorized: false }),
      resumed: status === "complete",
    });
  } finally {
    if (!lockReleased) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [`${schema}:usage-correction:${transferId}`]).catch(() => {});
      lockReleased = true;
      lockClient.release();
    }
  }
}

export const POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS = Object.freeze(
  Object.fromEntries(SPECIFICATIONS.map(spec => [spec.name, spec.columns])),
);
