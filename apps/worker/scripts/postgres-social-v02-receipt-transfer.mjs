import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "./postgres-migrations.mjs";

export const POSTGRES_SOCIAL_V02_RECEIPT_TRANSFER_SCHEMA = "sealed-d1-social-v02-receipts-to-postgres-v1";
export const SEALED_SQLITE_SOCIAL_V02_RECEIPT_SCHEMA = "sealed-sqlite-social-v02-receipt-projection-v1";
export const POSTGRES_SOCIAL_V02_RECEIPT_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_SOCIAL_V02_RECEIPT_MAX_PAGE_SIZE = 250;
export const POSTGRES_SOCIAL_V02_RECEIPT_TARGET_SCHEMA_PREFIX = "social_v02_receipt_transfer_target_";

const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const SOURCE_MANIFEST_TABLE = "social_v02_source_manifest";
const SOURCE_PROOFS_TABLE = "social_v02_receipt_proofs";
const TRUSTED_SOURCES = new WeakSet();

const PROOF_COLUMNS = Object.freeze([
  "event_digest", "owner_digest", "participant_id", "input_revision", "change_kind",
  "sequence", "journal_revision", "journal_kind", "object_digest", "content_digest",
  "authority_epoch", "public_authority_epoch", "recorded_ms", "owner_link_digest",
  "owner_link_state", "current_input_revision", "owner_head_revision",
  "owner_head_authority_epoch", "owner_head_state", "owner_head_last_sequence",
  "owner_head_object_digest", "owner_head_content_digest",
]);
const RECEIPT_COLUMNS = Object.freeze([
  "event_digest", "owner_digest", "participant_id", "input_revision", "change_kind",
]);
const JOURNAL_COLUMNS = Object.freeze([
  "source_id", "sequence", "event_digest", "owner_digest", "revision", "kind",
  "object_digest", "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms",
]);
const JOURNAL_TYPES = Object.freeze([
  "text", "bigint", "text", "text", "bigint", "text", "text", "text", "bigint", "bigint", "bigint",
]);
const JOURNAL_KINDS = Object.freeze(["source-updated", "owner-active", "owner-withdrawn", "owner-erased"]);
const RECEIPT_KINDS = Object.freeze(["owner-active", "source-updated"]);
const OWNER_STATES = Object.freeze(["active", "withdrawn", "erased"]);

export class PostgresSocialV02ReceiptTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresSocialV02ReceiptTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresSocialV02ReceiptTransferError(code);
}

function sha256() { return createHash("sha256"); }

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function normalizeInteger(value, code = "SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID", nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value).toString();
  fail(code);
}

function normalizeProof(raw, sourceId, sourceAuthorityEpoch, journalLastSequence) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID");
  const row = Object.create(null);
  for (const column of PROOF_COLUMNS) row[column] = raw[column];
  for (const column of [
    "input_revision", "sequence", "journal_revision", "authority_epoch", "public_authority_epoch",
    "recorded_ms", "owner_head_revision", "owner_head_authority_epoch", "owner_head_last_sequence",
  ]) row[column] = normalizeInteger(row[column]);
  row.current_input_revision = normalizeInteger(row.current_input_revision,
    "SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID", true);
  for (const column of ["event_digest", "owner_digest", "object_digest", "content_digest", "owner_link_digest",
    "owner_head_object_digest", "owner_head_content_digest"]) {
    if (typeof row[column] !== "string" || !SHA256.test(row[column])) fail("SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID");
  }
  if (typeof row.participant_id !== "string" || row.participant_id.length < 1
      || Buffer.byteLength(row.participant_id) > 256 || /[\u0000-\u001f\u007f]/u.test(row.participant_id)
      || row.owner_link_digest !== row.owner_digest
      || !RECEIPT_KINDS.includes(row.change_kind) || row.journal_kind !== row.change_kind
      || !OWNER_STATES.includes(row.owner_link_state) || !OWNER_STATES.includes(row.owner_head_state)
      || row.event_digest !== row.object_digest || row.event_digest !== row.content_digest
      || BigInt(row.input_revision) < 0n || BigInt(row.sequence) < 1n
      || BigInt(row.sequence) > BigInt(journalLastSequence) || BigInt(row.journal_revision) < 1n
      || BigInt(row.authority_epoch) < 1n || BigInt(row.public_authority_epoch) < 1n
      || BigInt(row.public_authority_epoch) > BigInt(sourceAuthorityEpoch) || BigInt(row.recorded_ms) < 0n
      || (row.current_input_revision !== null
        && BigInt(row.current_input_revision) < BigInt(row.input_revision))
      || BigInt(row.owner_head_revision) < BigInt(row.journal_revision)
      || BigInt(row.owner_head_authority_epoch) < BigInt(row.authority_epoch)
      || BigInt(row.owner_head_last_sequence) < BigInt(row.sequence)) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID");
  }
  if (sourceId === "" || !SOURCE_ID.test(sourceId)) fail("SOCIAL_V02_RECEIPT_SOURCE_ID_INVALID");
  if (row.owner_head_revision === row.journal_revision) {
    const state = row.journal_kind === "owner-withdrawn" ? "withdrawn"
      : row.journal_kind === "owner-erased" ? "erased" : "active";
    if (row.owner_head_last_sequence !== row.sequence || row.owner_head_authority_epoch !== row.authority_epoch
        || row.owner_head_state !== state || row.owner_head_object_digest !== row.object_digest
        || row.owner_head_content_digest !== row.content_digest) fail("SOCIAL_V02_RECEIPT_SOURCE_HEAD_INVALID");
  }
  return Object.freeze(row);
}

function canonical(columns, row) { return JSON.stringify(columns.map(column => row[column])); }

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_SOCIAL_V02_RECEIPT_MAX_PAGE_SIZE) {
    fail("SOCIAL_V02_RECEIPT_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function validateSource(source) {
  if (source === null || typeof source !== "object" || !TRUSTED_SOURCES.has(source)
      || source.snapshot?.kind !== "sealed-sqlite-social-v02-receipt-projection"
      || source.snapshot?.immutable !== true || typeof source.verifySnapshot !== "function"
      || typeof source.listPage !== "function") fail("SOCIAL_V02_RECEIPT_SEALED_SOURCE_REQUIRED");
  return source.snapshot;
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      fail("SOCIAL_V02_RECEIPT_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof PostgresSocialV02ReceiptTransferError) throw error;
      fail("SOCIAL_V02_RECEIPT_SQLITE_UNAVAILABLE");
    }
  }
}

async function fingerprintSqlite(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("SOCIAL_V02_RECEIPT_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) {
      fail("SOCIAL_V02_RECEIPT_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("SOCIAL_V02_RECEIPT_SQLITE_CHANGED");
    const hash = sha256();
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("SOCIAL_V02_RECEIPT_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(opened, after)) fail("SOCIAL_V02_RECEIPT_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresSocialV02ReceiptTransferError) throw error;
    fail("SOCIAL_V02_RECEIPT_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sqliteCount(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  const value = statement.get()?.count;
  if (typeof value !== "bigint" || value < 0n) fail("SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID");
  return value;
}

function validateSourceLayout(database) {
  const objects = database.prepare(`SELECT type,name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const expected = [
    `table:${SOURCE_PROOFS_TABLE}`,
    `table:${SOURCE_MANIFEST_TABLE}`,
  ];
  if (JSON.stringify(objects.map(row => `${row.type}:${row.name}`)) !== JSON.stringify(expected)) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID");
  }
  const tables = database.prepare("PRAGMA table_list").all()
    .filter(row => row.schema === "main" && row.name !== "sqlite_schema" && row.name !== "sqlite_sequence");
  if (tables.length !== 2 || tables.some(row => row.type !== "table" || row.strict !== 1)) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID");
  }
  const expectedColumns = {
    [SOURCE_MANIFEST_TABLE]: [
      ["singleton", "INTEGER", 0, 1], ["schema_version", "TEXT", 1, 0], ["source_id", "TEXT", 1, 0],
      ["source_authority_epoch", "INTEGER", 1, 0], ["journal_event_count", "INTEGER", 1, 0],
      ["journal_event_rows_sha256", "TEXT", 1, 0], ["journal_last_sequence", "INTEGER", 1, 0],
    ],
    [SOURCE_PROOFS_TABLE]: [
      ["event_digest", "TEXT", 1, 1], ["owner_digest", "TEXT", 1, 0], ["participant_id", "TEXT", 1, 0],
      ["input_revision", "INTEGER", 1, 0], ["change_kind", "TEXT", 1, 0], ["sequence", "INTEGER", 1, 0],
      ["journal_revision", "INTEGER", 1, 0], ["journal_kind", "TEXT", 1, 0], ["object_digest", "TEXT", 1, 0],
      ["content_digest", "TEXT", 1, 0], ["authority_epoch", "INTEGER", 1, 0],
      ["public_authority_epoch", "INTEGER", 1, 0], ["recorded_ms", "INTEGER", 1, 0],
      ["owner_link_digest", "TEXT", 1, 0], ["owner_link_state", "TEXT", 1, 0],
      ["current_input_revision", "INTEGER", 0, 0], ["owner_head_revision", "INTEGER", 1, 0],
      ["owner_head_authority_epoch", "INTEGER", 1, 0], ["owner_head_state", "TEXT", 1, 0],
      ["owner_head_last_sequence", "INTEGER", 1, 0], ["owner_head_object_digest", "TEXT", 1, 0],
      ["owner_head_content_digest", "TEXT", 1, 0],
    ],
  };
  for (const [table, wanted] of Object.entries(expectedColumns)) {
    const actual = database.prepare(`PRAGMA table_info("${table}")`).all();
    if (actual.length !== wanted.length || actual.some((column, index) => {
      const [name, type, notnull, pk] = wanted[index];
      return column.name !== name || String(column.type).toUpperCase() !== type
        || column.notnull !== notnull || column.pk !== pk;
    })) fail("SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID");
  }
  const proofIndexes = database.prepare(`PRAGMA index_list("${SOURCE_PROOFS_TABLE}")`).all();
  const unique = proofIndexes.filter(index => index.unique === 1)
    .map(index => database.prepare(`PRAGMA index_info("${index.name}")`).all().map(row => row.name))
    .map(columns => columns.join(",")).sort();
  if (JSON.stringify(unique) !== JSON.stringify(["event_digest", "participant_id,input_revision"].sort())) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID");
  }
}

function readSourceManifest(database, expectedSourceId) {
  const statement = database.prepare(`SELECT singleton,schema_version,source_id,source_authority_epoch,
      journal_event_count,journal_event_rows_sha256,journal_last_sequence FROM "${SOURCE_MANIFEST_TABLE}"`);
  statement.setReadBigInts(true);
  const manifest = statement.get();
  if (!manifest || sqliteCount(database, `SELECT count(*) AS count FROM "${SOURCE_MANIFEST_TABLE}"`) !== 1n
      || manifest.singleton !== 1n || manifest.schema_version !== SEALED_SQLITE_SOCIAL_V02_RECEIPT_SCHEMA) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_MANIFEST_INVALID");
  }
  if (typeof manifest.source_id !== "string" || !SOURCE_ID.test(manifest.source_id)) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_ID_INVALID");
  }
  if (manifest.source_id !== expectedSourceId) fail("SOCIAL_V02_RECEIPT_SOURCE_IDENTITY_MISMATCH");
  const sourceAuthorityEpoch = normalizeInteger(manifest.source_authority_epoch);
  const journalEventCount = normalizeInteger(manifest.journal_event_count);
  const journalLastSequence = normalizeInteger(manifest.journal_last_sequence);
  if (BigInt(sourceAuthorityEpoch) < 0n || BigInt(journalEventCount) < 0n || BigInt(journalLastSequence) < 0n
      || BigInt(journalEventCount) !== BigInt(journalLastSequence)
      || !SHA256.test(manifest.journal_event_rows_sha256 ?? "")
      || (BigInt(journalEventCount) === 0n && BigInt(sourceAuthorityEpoch) !== 0n)) {
    fail("SOCIAL_V02_RECEIPT_SOURCE_MANIFEST_INVALID");
  }
  return Object.freeze({ sourceId: manifest.source_id, sourceAuthorityEpoch, journalEventCount,
    journalEventRowsSha256: manifest.journal_event_rows_sha256, journalLastSequence });
}

export async function createSealedSqliteSocialV02ReceiptSource({
  path,
  expectedSha256,
  expectedSourceId,
} = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("SOCIAL_V02_RECEIPT_SQLITE_SHA256_REQUIRED");
  if (typeof expectedSourceId !== "string" || !SOURCE_ID.test(expectedSourceId)) fail("SOCIAL_V02_RECEIPT_SOURCE_ID_INVALID");
  const initial = await fingerprintSqlite(path);
  if (initial.sha256 !== expectedSha256) fail("SOCIAL_V02_RECEIPT_SQLITE_SHA256_MISMATCH");
  let database;
  let metadata;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("SOCIAL_V02_RECEIPT_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("SOCIAL_V02_RECEIPT_SQLITE_INTEGRITY_FAILED");
    }
    validateSourceLayout(database);
    metadata = readSourceManifest(database, expectedSourceId);
    const invalidCount = sqliteCount(database, `SELECT count(*) AS count FROM "${SOURCE_PROOFS_TABLE}"
      WHERE length(event_digest)<>64 OR event_digest GLOB '*[^0-9a-f]*'
         OR length(owner_digest)<>64 OR owner_digest GLOB '*[^0-9a-f]*'
         OR length(object_digest)<>64 OR object_digest GLOB '*[^0-9a-f]*'
         OR length(content_digest)<>64 OR content_digest GLOB '*[^0-9a-f]*'
         OR length(owner_link_digest)<>64 OR owner_link_digest GLOB '*[^0-9a-f]*'
         OR length(owner_head_object_digest)<>64 OR owner_head_object_digest GLOB '*[^0-9a-f]*'
         OR length(owner_head_content_digest)<>64 OR owner_head_content_digest GLOB '*[^0-9a-f]*'
         OR participant_id='' OR length(CAST(participant_id AS BLOB))>256
         OR input_revision<0 OR sequence<1 OR journal_revision<1 OR authority_epoch<1
         OR public_authority_epoch<1 OR public_authority_epoch>${metadata.sourceAuthorityEpoch}
         OR recorded_ms<0 OR owner_head_revision<journal_revision
         OR owner_head_authority_epoch<authority_epoch OR owner_head_last_sequence<sequence
         OR change_kind NOT IN ('owner-active','source-updated') OR journal_kind<>change_kind
         OR object_digest<>event_digest OR content_digest<>event_digest OR owner_link_digest<>owner_digest
         OR owner_link_state NOT IN ('active','withdrawn','erased')
         OR owner_head_state NOT IN ('active','withdrawn','erased')
         OR (current_input_revision IS NOT NULL AND current_input_revision<0)`);
    if (invalidCount !== 0n) fail("SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID");
    const receiptCount = sqliteCount(database, `SELECT count(*) AS count FROM "${SOURCE_PROOFS_TABLE}"`);
    const badSequence = sqliteCount(database, `SELECT count(*) AS count FROM "${SOURCE_PROOFS_TABLE}"
      WHERE sequence>${metadata.journalLastSequence}`);
    if (badSequence !== 0n) fail("SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID");
    const proofs = database.prepare(`SELECT ${PROOF_COLUMNS.map(column => `"${column}"`).join(",")}
      FROM "${SOURCE_PROOFS_TABLE}" WHERE event_digest>? ORDER BY event_digest LIMIT ?`);
    proofs.setReadBigInts(true);
    const snapshot = Object.freeze({
      kind: "sealed-sqlite-social-v02-receipt-projection",
      schema: SEALED_SQLITE_SOCIAL_V02_RECEIPT_SCHEMA,
      sourceId: metadata.sourceId,
      sourceAuthorityEpoch: metadata.sourceAuthorityEpoch,
      journalEventCount: metadata.journalEventCount,
      journalEventRowsSha256: metadata.journalEventRowsSha256,
      journalLastSequence: metadata.journalLastSequence,
      receiptCount: receiptCount.toString(),
      artifactSha256: expectedSha256,
      immutable: true,
    });
    let closed = false;
    const source = Object.freeze({
      snapshot,
      async verifySnapshot() {
        if (closed) fail("SOCIAL_V02_RECEIPT_SQLITE_CLOSED");
        const actual = await fingerprintSqlite(path);
        if (actual.sha256 !== expectedSha256 || !sameStat(initial.stat, actual.stat)) {
          fail("SOCIAL_V02_RECEIPT_SOURCE_CHANGED");
        }
        return Object.freeze({ sha256: actual.sha256, unchanged: true });
      },
      async listPage({ after = null, limit } = {}) {
        if (closed) fail("SOCIAL_V02_RECEIPT_SQLITE_CLOSED");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > POSTGRES_SOCIAL_V02_RECEIPT_MAX_PAGE_SIZE
            || (after !== null && (typeof after !== "string" || !SHA256.test(after)))) {
          fail("SOCIAL_V02_RECEIPT_PAGE_INVALID");
        }
        const rows = proofs.all(after ?? "", limit).map(raw => normalizeProof(raw, metadata.sourceId,
          metadata.sourceAuthorityEpoch, metadata.journalLastSequence));
        if (rows.some((row, index) => (after !== null && row.event_digest <= after)
            || (index > 0 && row.event_digest <= rows[index - 1].event_digest))) {
          fail("SOCIAL_V02_RECEIPT_SOURCE_ORDER_INVALID");
        }
        return Object.freeze({ rows: Object.freeze(rows) });
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
  } catch (error) {
    database?.close();
    if (error instanceof PostgresSocialV02ReceiptTransferError) throw error;
    fail("SOCIAL_V02_RECEIPT_SQLITE_INVALID");
  }
}

async function scanSource(source, pageSize) {
  const snapshot = validateSource(source);
  await source.verifySnapshot();
  const proofHash = sha256();
  const receiptHash = sha256();
  let count = 0n;
  let pagesRead = 0;
  let after = null;
  for (;;) {
    const page = await source.listPage({ after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("SOCIAL_V02_RECEIPT_SOURCE_PAGE_INVALID");
    pagesRead += 1;
    for (const row of page.rows) {
      const normalized = normalizeProof(row, snapshot.sourceId, snapshot.sourceAuthorityEpoch, snapshot.journalLastSequence);
      if (after !== null && normalized.event_digest <= after) fail("SOCIAL_V02_RECEIPT_SOURCE_ORDER_INVALID");
      proofHash.update(`${canonical(PROOF_COLUMNS, normalized)}\n`);
      receiptHash.update(`${canonical(RECEIPT_COLUMNS, normalized)}\n`);
      after = normalized.event_digest;
      count += 1n;
    }
    if (page.rows.length < pageSize) break;
  }
  await source.verifySnapshot();
  if (count.toString() !== snapshot.receiptCount) fail("SOCIAL_V02_RECEIPT_SOURCE_COUNT_INVALID");
  return Object.freeze({
    schema: SEALED_SQLITE_SOCIAL_V02_RECEIPT_SCHEMA,
    sourceIdSha256: sha256().update(snapshot.sourceId).digest("hex"),
    sourceSnapshotSha256: snapshot.artifactSha256,
    sourceAuthorityEpoch: snapshot.sourceAuthorityEpoch,
    journalEventCount: snapshot.journalEventCount,
    journalEventRowsSha256: snapshot.journalEventRowsSha256,
    journalLastSequence: snapshot.journalLastSequence,
    receiptRows: count.toString(),
    receiptRowsSha256: receiptHash.digest("hex"),
    proofRowsSha256: proofHash.digest("hex"),
    pageSize,
    pagesRead,
    postgresWrites: 0,
    journalRowsWritten: false,
    ownerHeadsWritten: false,
  });
}

export async function scanSealedSqliteSocialV02Receipts({
  source,
  pageSize = POSTGRES_SOCIAL_V02_RECEIPT_DEFAULT_PAGE_SIZE,
} = {}) {
  return scanSource(source, validatePageSize(pageSize));
}

function targetSchemaName(value) {
  const suffix = typeof value === "string" && value.startsWith(POSTGRES_SOCIAL_V02_RECEIPT_TARGET_SCHEMA_PREFIX)
    ? value.slice(POSTGRES_SOCIAL_V02_RECEIPT_TARGET_SCHEMA_PREFIX.length) : "";
  if (typeof value !== "string" || !SCHEMA.test(value) || !TARGET_SUFFIX.test(suffix)
      || value.startsWith("pg_") || value === "information_schema" || value === "pg_catalog") {
    fail("SOCIAL_V02_RECEIPT_DISPOSABLE_SCHEMA_REQUIRED");
  }
  return value;
}

function quoteSchema(schema) { return `"${targetSchemaName(schema)}"`; }
function relation(schema, name) {
  const allowed = new Set([
    "_tibotattle_migration_history", "storage_source_state", "storage_ingestion_changes", "storage_owner_revisions",
    "storage_v11_owner_links", "community_analytical_input_versions", "participants", "telemetry_contributions",
    "storage_legacy_event_sources", "community_public_source_bootstrap",
  ]);
  if (!allowed.has(name)) fail("SOCIAL_V02_RECEIPT_TARGET_TABLE_INVALID");
  return `${quoteSchema(schema)}."${name}"`;
}

function assertLocalTestEndpoint() {
  const socket = process.env.PG_TEST_SOCKET;
  const host = process.env.PG_TEST_HOST;
  const socketOk = typeof socket === "string" && /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u.test(socket);
  const hostOk = typeof host === "string" && ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!socketOk && !hostOk) fail("SOCIAL_V02_RECEIPT_LOCAL_POSTGRES_REQUIRED");
}

async function validateTarget(client, schema) {
  let locality;
  try {
    locality = await client.query("SELECT inet_server_addr() AS address,current_setting('server_version_num')::integer AS version");
  } catch {
    fail("SOCIAL_V02_RECEIPT_TARGET_UNAVAILABLE");
  }
  const version = Number(locality.rows[0]?.version);
  if (locality.rows[0]?.address !== null || Math.floor(version / 10_000) !== 17) {
    fail("SOCIAL_V02_RECEIPT_LOCAL_POSTGRES_17_REQUIRED");
  }
  const expected = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT });
  if (expected.at(-1)?.name !== "0046_owner_journal_authority.sql") fail("SOCIAL_V02_RECEIPT_MIGRATION_CONTRACT_UNAVAILABLE");
  let history;
  try {
    history = await client.query(`SELECT version,name,checksum_sha256 FROM ${relation(schema, "_tibotattle_migration_history")} ORDER BY version`);
  } catch {
    fail("SOCIAL_V02_RECEIPT_TARGET_MIGRATION_REQUIRED");
  }
  if (history.rows.length !== expected.length || expected.some((item, index) => {
    const actual = history.rows[index];
    return actual?.version !== item.version || actual?.name !== item.name || actual?.checksum_sha256 !== item.sha256;
  })) fail("SOCIAL_V02_RECEIPT_TARGET_MIGRATION_REQUIRED");
  const columns = await client.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='storage_legacy_event_sources' ORDER BY ordinal_position`, [schema]);
  const wanted = [
    ["event_digest", "text", "NO"], ["owner_digest", "text", "NO"], ["participant_id", "text", "NO"],
    ["input_revision", "bigint", "NO"], ["change_kind", "text", "NO"],
  ];
  if (columns.rows.length !== wanted.length || columns.rows.some((row, index) => {
    const [name, type, nullable] = wanted[index];
    return row.column_name !== name || row.data_type !== type || row.is_nullable !== nullable;
  })) fail("SOCIAL_V02_RECEIPT_TARGET_MIGRATION_REQUIRED");
  const functions = await client.query(`SELECT to_regprocedure($1) IS NOT NULL AS exists`, [`${schema}.community_public_source_bootstrap_pending()`]);
  const triggers = await client.query(`SELECT tgname FROM pg_trigger trigger
    JOIN pg_class relation_row ON relation_row.oid=trigger.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid=relation_row.relnamespace
    WHERE namespace_row.nspname=$1 AND relation_row.relname='storage_legacy_event_sources' AND NOT trigger.tgisinternal`, [schema]);
  const triggerNames = new Set(triggers.rows.map(row => row.tgname));
  if (functions.rows[0]?.exists !== true || ![
    "storage_legacy_event_source_membership_guard", "storage_legacy_event_source_retention_guard",
    "storage_legacy_event_source_truncate_refused",
  ].every(name => triggerNames.has(name))) fail("SOCIAL_V02_RECEIPT_TARGET_MIGRATION_REQUIRED");
  return version;
}

function sourceJournalRow(raw, sourceId) {
  const row = Object.create(null);
  row.source_id = raw.source_id;
  for (const column of JOURNAL_COLUMNS.slice(1)) row[column] = raw[column];
  for (const column of ["sequence", "revision", "authority_epoch", "public_authority_epoch", "recorded_ms"]) {
    row[column] = normalizeInteger(row[column], "SOCIAL_V02_RECEIPT_TARGET_JOURNAL_INVALID");
  }
  if (row.source_id !== sourceId || BigInt(row.sequence) < 1n || BigInt(row.revision) < 1n
      || BigInt(row.authority_epoch) < 1n || BigInt(row.public_authority_epoch) < 1n || BigInt(row.recorded_ms) < 0n
      || !JOURNAL_KINDS.includes(row.kind)
      || ![row.event_digest, row.owner_digest, row.object_digest, row.content_digest].every(value => SHA256.test(value ?? ""))) {
    fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_INVALID");
  }
  return Object.freeze(row);
}

async function scanTargetJournal(client, schema, sourceId, pageSize) {
  let unexpectedSourceRows;
  try {
    unexpectedSourceRows = await client.query(`SELECT 1 FROM ${relation(schema, "storage_ingestion_changes")}
      WHERE event_tuple_version=1 AND source_id<>$1 LIMIT 1`, [sourceId]);
  } catch {
    fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_READ_FAILED");
  }
  if (unexpectedSourceRows.rows.length !== 0) fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_SOURCE_MISMATCH");
  const hash = sha256();
  let count = 0n;
  let after = "0";
  let pages = 0;
  for (;;) {
    let result;
    try {
      result = await client.query(`SELECT ${JOURNAL_COLUMNS.map(column => `"${column}"`).join(",")}
        FROM ${relation(schema, "storage_ingestion_changes")}
        WHERE event_tuple_version=1 AND source_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,
      [sourceId, after, pageSize]);
    } catch {
      fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_READ_FAILED");
    }
    if (result.rows.length > pageSize) fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_PAGE_INVALID");
    pages += 1;
    for (const raw of result.rows) {
      const row = sourceJournalRow(raw, sourceId);
      if (BigInt(row.sequence) <= BigInt(after)) fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_ORDER_INVALID");
      hash.update(`${canonical(JOURNAL_COLUMNS, row)}\n`);
      after = row.sequence;
      count += 1n;
    }
    if (result.rows.length < pageSize) break;
  }
  return Object.freeze({ count: count.toString(), rowsSha256: hash.digest("hex"), lastSequence: after, pages });
}

function valuesSql(width, count, offset = 1) {
  return Array.from({ length: count }, (_, rowIndex) => `(${Array.from({ length: width }, (_, columnIndex) =>
    `$${offset + rowIndex * width + columnIndex}`).join(",")})`).join(",");
}

function proofValues(rows) { return rows.flatMap(row => PROOF_COLUMNS.map(column => row[column])); }

async function readTargetProofEvidence(client, schema, sourceId, rows) {
  if (rows.length === 0) return;
  const expectedColumns = PROOF_COLUMNS.map(column => `"${column}"`).join(",");
  const targetColumns = [
    "p.id AS participant_id", "link.owner_digest AS owner_link_digest", "link.state AS owner_link_state",
    "input.revision::text AS current_input_revision", "change.source_id", "change.sequence::text AS sequence",
    "change.event_digest", "change.owner_digest", "change.revision::text AS journal_revision",
    "change.kind AS journal_kind", "change.object_digest", "change.content_digest",
    "change.authority_epoch::text AS authority_epoch", "change.public_authority_epoch::text AS public_authority_epoch",
    "change.recorded_ms::text AS recorded_ms", "change.event_tuple_version",
    "head.revision::text AS owner_head_revision", "head.authority_epoch::text AS owner_head_authority_epoch",
    "head.state AS owner_head_state", "head.last_sequence::text AS owner_head_last_sequence",
    "head.object_digest AS owner_head_object_digest", "head.content_digest AS owner_head_content_digest",
  ].join(",");
  const values = rows.flatMap(row => PROOF_COLUMNS.map(column => row[column]));
  const expected = rows.map((_, index) => `(${PROOF_COLUMNS.map((__, columnIndex) => `$${index * PROOF_COLUMNS.length + columnIndex + 1}`).join(",")})`).join(",");
  const sql = `WITH expected(${expectedColumns}) AS (VALUES ${expected})
    SELECT ${targetColumns}
      FROM expected e
      LEFT JOIN ${relation(schema, "participants")} p ON p.id=e.participant_id
      LEFT JOIN ${relation(schema, "storage_v11_owner_links")} link
        ON link.participant_id=e.participant_id AND link.owner_digest=e.owner_link_digest
      LEFT JOIN ${relation(schema, "community_analytical_input_versions")} input
        ON input.participant_id=e.participant_id
      LEFT JOIN ${relation(schema, "storage_ingestion_changes")} change
        ON change.source_id=$${values.length + 1} AND change.sequence::text=e.sequence
      LEFT JOIN ${relation(schema, "storage_owner_revisions")} head
        ON head.source_id=$${values.length + 1} AND head.owner_digest=e.owner_digest
     ORDER BY e.event_digest`;
  let result;
  try {
    result = await client.query(sql, [...values, sourceId]);
  } catch {
    fail("SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_READ_FAILED");
  }
  if (result.rows.length !== rows.length) fail("SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH");
  for (let index = 0; index < rows.length; index += 1) {
    const expectedRow = rows[index];
    const actual = result.rows[index];
    if (actual.participant_id !== expectedRow.participant_id || actual.owner_link_digest !== expectedRow.owner_link_digest
        || actual.owner_link_state !== expectedRow.owner_link_state
        || normalizeInteger(actual.current_input_revision, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true)
          !== expectedRow.current_input_revision
        || actual.source_id !== sourceId || normalizeInteger(actual.sequence, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true)
          !== expectedRow.sequence || actual.event_digest !== expectedRow.event_digest || actual.owner_digest !== expectedRow.owner_digest
        || normalizeInteger(actual.journal_revision, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true) !== expectedRow.journal_revision
        || actual.journal_kind !== expectedRow.journal_kind || actual.object_digest !== expectedRow.object_digest
        || actual.content_digest !== expectedRow.content_digest
        || normalizeInteger(actual.authority_epoch, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true) !== expectedRow.authority_epoch
        || normalizeInteger(actual.public_authority_epoch, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true) !== expectedRow.public_authority_epoch
        || normalizeInteger(actual.recorded_ms, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true) !== expectedRow.recorded_ms
        || actual.event_tuple_version !== 1
        || normalizeInteger(actual.owner_head_revision, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true)
          !== expectedRow.owner_head_revision
        || normalizeInteger(actual.owner_head_authority_epoch, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true)
          !== expectedRow.owner_head_authority_epoch
        || actual.owner_head_state !== expectedRow.owner_head_state
        || normalizeInteger(actual.owner_head_last_sequence, "SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH", true)
          !== expectedRow.owner_head_last_sequence
        || actual.owner_head_object_digest !== expectedRow.owner_head_object_digest
        || actual.owner_head_content_digest !== expectedRow.owner_head_content_digest) {
      fail("SOCIAL_V02_RECEIPT_TARGET_AUTHORITY_MISMATCH");
    }
  }
}

async function verifyReceiptPage(client, schema, rows) {
  if (rows.length === 0) return;
  const width = RECEIPT_COLUMNS.length;
  const values = rows.flatMap(row => RECEIPT_COLUMNS.map(column => row[column]));
  try {
    await client.query(`INSERT INTO ${relation(schema, "storage_legacy_event_sources")}
      (${RECEIPT_COLUMNS.map(column => `"${column}"`).join(",")}) VALUES ${valuesSql(width, rows.length)}
      ON CONFLICT (event_digest) DO NOTHING`, values);
    const expected = rows.map((_, index) => `(${RECEIPT_COLUMNS.map((__, columnIndex) => `$${index * width + columnIndex + 1}`).join(",")})`).join(",");
    const readback = await client.query(`WITH expected(${RECEIPT_COLUMNS.map(column => `"${column}"`).join(",")}) AS (VALUES ${expected})
      SELECT actual.event_digest,actual.owner_digest,actual.participant_id,actual.input_revision::text AS input_revision,
             actual.change_kind
        FROM expected e LEFT JOIN ${relation(schema, "storage_legacy_event_sources")} actual
          ON actual.event_digest=e.event_digest
       ORDER BY e.event_digest`, values);
    if (readback.rows.length !== rows.length || readback.rows.some((actual, index) => {
      const row = rows[index];
      return actual.event_digest !== row.event_digest || actual.owner_digest !== row.owner_digest
        || actual.participant_id !== row.participant_id
        || normalizeInteger(actual.input_revision, "SOCIAL_V02_RECEIPT_TARGET_ROW_MISMATCH", true) !== row.input_revision
        || actual.change_kind !== row.change_kind;
    })) fail("SOCIAL_V02_RECEIPT_TARGET_ROW_MISMATCH");
  } catch (error) {
    if (error instanceof PostgresSocialV02ReceiptTransferError) throw error;
    fail("SOCIAL_V02_RECEIPT_TARGET_INSERT_FAILED");
  }
}

async function scanTargetReceipts(client, schema, pageSize) {
  const hash = sha256();
  let count = 0n;
  let after = "";
  let pages = 0;
  for (;;) {
    let result;
    try {
      result = await client.query(`SELECT event_digest,owner_digest,participant_id,input_revision::text AS input_revision,change_kind
        FROM ${relation(schema, "storage_legacy_event_sources")} WHERE event_digest>$1 ORDER BY event_digest LIMIT $2`,
      [after, pageSize]);
    } catch {
      fail("SOCIAL_V02_RECEIPT_TARGET_READ_FAILED");
    }
    if (result.rows.length > pageSize) fail("SOCIAL_V02_RECEIPT_TARGET_PAGE_INVALID");
    pages += 1;
    for (const raw of result.rows) {
      const row = Object.create(null);
      for (const column of RECEIPT_COLUMNS) row[column] = raw[column];
      row.input_revision = normalizeInteger(row.input_revision, "SOCIAL_V02_RECEIPT_TARGET_ROW_INVALID");
      if (!SHA256.test(row.event_digest ?? "") || !SHA256.test(row.owner_digest ?? "")
          || typeof row.participant_id !== "string" || !RECEIPT_KINDS.includes(row.change_kind)
          || row.event_digest <= after) fail("SOCIAL_V02_RECEIPT_TARGET_ROW_INVALID");
      hash.update(`${canonical(RECEIPT_COLUMNS, row)}\n`);
      after = row.event_digest;
      count += 1n;
    }
    if (result.rows.length < pageSize) break;
  }
  return Object.freeze({ count: count.toString(), rowsSha256: hash.digest("hex"), pages });
}

export async function transferPostgresSocialV02Receipts({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  pageSize = POSTGRES_SOCIAL_V02_RECEIPT_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = targetSchemaName(rawTargetSchema);
  const size = validatePageSize(pageSize);
  const snapshot = validateSource(source);
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("SOCIAL_V02_RECEIPT_DESTINATION_REQUIRED");
  assertLocalTestEndpoint();
  const manifest = await scanSource(source, size);
  let client;
  try { client = await destinationPool.connect(); } catch { fail("SOCIAL_V02_RECEIPT_TARGET_UNAVAILABLE"); }
  let transactionOpen = false;
  try {
    const postgresVersion = await validateTarget(client, schema);
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='300000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    for (const table of ["participants", "storage_v11_owner_links",
      "community_analytical_input_versions", "storage_source_state", "storage_ingestion_changes",
      "storage_owner_revisions", "storage_legacy_event_sources"]) {
      await client.query(`LOCK TABLE ${relation(schema, table)} IN ${table === "storage_legacy_event_sources" ? "SHARE ROW EXCLUSIVE" : "SHARE"} MODE`);
    }
    await source.verifySnapshot();
    const state = await client.query(`SELECT source_id,authority_epoch::text AS authority_epoch
      FROM ${relation(schema, "storage_source_state")} WHERE singleton=1`);
    if (state.rows.length !== 1 || state.rows[0].source_id !== snapshot.sourceId
        || state.rows[0].authority_epoch !== snapshot.sourceAuthorityEpoch) {
      fail("SOCIAL_V02_RECEIPT_TARGET_SOURCE_MISMATCH");
    }
    const journal = await scanTargetJournal(client, schema, snapshot.sourceId, size);
    if (journal.count !== snapshot.journalEventCount || journal.rowsSha256 !== snapshot.journalEventRowsSha256
        || journal.lastSequence !== snapshot.journalLastSequence) fail("SOCIAL_V02_RECEIPT_TARGET_JOURNAL_PARITY_FAILED");

    let inserted = 0n;
    let proofHash = sha256();
    let receiptHash = sha256();
    let count = 0n;
    let after = null;
    for (;;) {
      const page = await source.listPage({ after, limit: size });
      if (!page || !Array.isArray(page.rows) || page.rows.length > size) fail("SOCIAL_V02_RECEIPT_SOURCE_PAGE_INVALID");
      const rows = page.rows.map(raw => normalizeProof(raw, snapshot.sourceId,
        snapshot.sourceAuthorityEpoch, snapshot.journalLastSequence));
      for (const row of rows) {
        if (after !== null && row.event_digest <= after) fail("SOCIAL_V02_RECEIPT_SOURCE_ORDER_INVALID");
        proofHash.update(`${canonical(PROOF_COLUMNS, row)}\n`);
        receiptHash.update(`${canonical(RECEIPT_COLUMNS, row)}\n`);
        after = row.event_digest;
        count += 1n;
      }
      await readTargetProofEvidence(client, schema, snapshot.sourceId, rows);
      await verifyReceiptPage(client, schema, rows);
      inserted += BigInt(rows.length);
      if (rows.length < size) break;
    }
    await source.verifySnapshot();
    if (count.toString() !== manifest.receiptRows || proofHash.digest("hex") !== manifest.proofRowsSha256
        || receiptHash.digest("hex") !== manifest.receiptRowsSha256) fail("SOCIAL_V02_RECEIPT_SOURCE_CHANGED");
    const target = await scanTargetReceipts(client, schema, size);
    if (target.count !== manifest.receiptRows || target.rowsSha256 !== manifest.receiptRowsSha256) {
      fail("SOCIAL_V02_RECEIPT_SOURCE_DESTINATION_PARITY_FAILED");
    }
    const bootstrap = await client.query(`SELECT community_public_source_bootstrap_pending()::text AS pending`);
    await client.query("COMMIT");
    transactionOpen = false;
    return Object.freeze({
      schema: POSTGRES_SOCIAL_V02_RECEIPT_TRANSFER_SCHEMA,
      status: "synthetic_social_v02_receipt_transfer_complete",
      targetSchema: schema,
      sourceIdSha256: manifest.sourceIdSha256,
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      sourceJournalRows: manifest.journalEventCount,
      sourceJournalRowsSha256: manifest.journalEventRowsSha256,
      sourceReceiptRows: manifest.receiptRows,
      sourceReceiptRowsSha256: manifest.receiptRowsSha256,
      targetReceiptRows: target.count,
      targetReceiptRowsSha256: target.rowsSha256,
      postgresMajor: Math.floor(postgresVersion / 10_000),
      pageSize: size,
      pagesRead: manifest.pagesRead,
      rowsProcessed: inserted.toString(),
      bootstrapPending: bootstrap.rows[0]?.pending ?? null,
      journalRowsWritten: false,
      ownerHeadsWritten: false,
    });
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresSocialV02ReceiptTransferError) throw error;
    fail("SOCIAL_V02_RECEIPT_TRANSFER_FAILED");
  } finally {
    client?.release();
  }
}

export const POSTGRES_SOCIAL_V02_RECEIPT_PROOF_COLUMNS = Object.freeze([...PROOF_COLUMNS]);
export const POSTGRES_SOCIAL_V02_RECEIPT_ROW_COLUMNS = Object.freeze([...RECEIPT_COLUMNS]);
export const POSTGRES_SOCIAL_V02_RECEIPT_JOURNAL_COLUMNS = Object.freeze([...JOURNAL_COLUMNS]);
