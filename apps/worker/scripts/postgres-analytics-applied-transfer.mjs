import { createHash } from "node:crypto";
import {
  POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE,
  POSTGRES_ANALYTICS_HISTORY_MAX_PAGE_SIZE,
  scanSealedSqliteAnalyticsEventJournal,
} from "./postgres-analytics-history-transfer.mjs";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "./postgres-migrations.mjs";

export const POSTGRES_ANALYTICS_APPLIED_TRANSFER_SCHEMA = "synthetic-analytics-applied-receipts-transfer-v1";
export const POSTGRES_ANALYTICS_APPLIED_TARGET_SCHEMA_PREFIX = "analytics_applied_transfer_target_";
export const POSTGRES_ANALYTICS_APPLIED_DEFAULT_PAGE_SIZE = POSTGRES_ANALYTICS_HISTORY_DEFAULT_PAGE_SIZE;
export const POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE = POSTGRES_ANALYTICS_HISTORY_MAX_PAGE_SIZE;
export const POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE = "synthetic_analytics_applied_event_receipts_v1";

const CONTROL_RUNS = "_synthetic_analytics_applied_transfer_runs_v1";
const CONTROL_CHECKPOINTS = "_synthetic_analytics_applied_transfer_checkpoints_v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const TRANSFER_ID = /^synthetic-analytics-applied-[A-Za-z0-9._-]{1,96}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const DIGEST_COLUMNS = Object.freeze(["event_digest", "owner_digest", "object_digest", "content_digest"]);
const EVENT_COLUMNS = Object.freeze([
  "source_id", "sequence", "event_digest", "owner_digest", "revision", "kind", "object_digest",
  "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms",
]);
const EVENT_COLUMN_TYPES = Object.freeze([
  "text", "bigint", "text", "text", "bigint", "text", "text", "text", "bigint", "bigint", "bigint",
]);
const EVENT_KINDS = Object.freeze(["source-updated", "owner-active", "owner-withdrawn", "owner-erased"]);
const PRESERVED_APP_TABLES = Object.freeze([
  "storage_source_state",
  "analytics_applied_events",
  "analytics_source_cursors",
  "analytics_owner_state",
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
  "analytics_admin_metric_snapshots",
  "analytics_admin_metrics_history_cache",
  "analytics_admin_allowance_preview_cache",
  "analytics_admin_progress_cache",
  "community_model_history_dependencies",
  "community_model_composition_days",
  "community_analytical_input_versions",
  "community_daily_aggregates",
  "community_daily_allowance_publication_state",
  "community_daily_allowance_preview_cache",
]);

export class PostgresAnalyticsAppliedTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresAnalyticsAppliedTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresAnalyticsAppliedTransferError(code);
}

function sha256() { return createHash("sha256"); }
function emptyPrefixHash() { return sha256().digest("hex"); }

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE) {
    fail("ANALYTICS_APPLIED_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function normalizeInteger(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value).toString();
  fail("ANALYTICS_APPLIED_ROW_INVALID");
}

function normalizeRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ANALYTICS_APPLIED_ROW_INVALID");
  const row = Object.create(null);
  for (const column of EVENT_COLUMNS) row[column] = raw[column];
  if (typeof row.source_id !== "string" || !SOURCE_ID.test(row.source_id)) fail("ANALYTICS_APPLIED_ROW_INVALID");
  for (const column of ["sequence", "revision", "authority_epoch", "public_authority_epoch", "recorded_ms"]) {
    row[column] = normalizeInteger(row[column]);
  }
  for (const column of DIGEST_COLUMNS) {
    if (typeof row[column] !== "string" || !SHA256.test(row[column])) fail("ANALYTICS_APPLIED_ROW_INVALID");
  }
  if (BigInt(row.sequence) < 1n || BigInt(row.revision) < 1n || BigInt(row.authority_epoch) < 1n
      || BigInt(row.public_authority_epoch) < 1n || BigInt(row.recorded_ms) < 0n
      || !EVENT_KINDS.includes(row.kind)) fail("ANALYTICS_APPLIED_ROW_INVALID");
  return Object.freeze(row);
}

function canonicalRow(row) {
  return JSON.stringify(EVENT_COLUMNS.map(column => row[column]));
}

function cursorFor(row) { return Object.freeze({ sourceId: row.source_id, sequence: row.sequence }); }

function cursorIsAfter(row, after) {
  return after === null || row.source_id > after.sourceId
    || (row.source_id === after.sourceId && BigInt(row.sequence) > BigInt(after.sequence));
}

function compareCursor(left, right) {
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  const leftSequence = BigInt(left.sequence);
  const rightSequence = BigInt(right.sequence);
  return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
}

function schemaName(value) {
  const suffix = typeof value === "string" && value.startsWith(POSTGRES_ANALYTICS_APPLIED_TARGET_SCHEMA_PREFIX)
    ? value.slice(POSTGRES_ANALYTICS_APPLIED_TARGET_SCHEMA_PREFIX.length) : "";
  if (typeof value !== "string" || !SCHEMA.test(value) || !TARGET_SUFFIX.test(suffix)
      || value.startsWith("pg_") || value === "information_schema" || value === "pg_catalog") {
    fail("ANALYTICS_APPLIED_DISPOSABLE_SCHEMA_REQUIRED");
  }
  return value;
}

function quoteSchema(schema) { return `"${schemaName(schema)}"`; }

const ALLOWED_TABLES = new Set([
  ...PRESERVED_APP_TABLES,
  "collection_controls",
  POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE,
  CONTROL_RUNS,
  CONTROL_CHECKPOINTS,
  "_tibotattle_migration_history",
]);

function relation(schema, name) {
  if (!ALLOWED_TABLES.has(name)) fail("ANALYTICS_APPLIED_TABLE_INVALID");
  return `${quoteSchema(schema)}."${name}"`;
}

async function validateTarget(client, schema) {
  let locality;
  try {
    locality = await client.query("SELECT inet_server_addr() AS address,current_setting('server_version_num')::integer AS version");
  } catch {
    fail("ANALYTICS_APPLIED_TARGET_UNAVAILABLE");
  }
  const serverVersion = Number(locality.rows[0]?.version);
  if (locality.rows[0]?.address !== null || Math.floor(serverVersion / 10_000) !== 17) {
    fail("ANALYTICS_APPLIED_LOCAL_POSTGRES_17_REQUIRED");
  }
  let migrations;
  let applied;
  try {
    migrations = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT });
    if (migrations.length < 38 || migrations[37]?.name !== "0038_analytics_event_tuple_versions.sql") {
      fail("ANALYTICS_APPLIED_MIGRATION_CONTRACT_UNAVAILABLE");
    }
    applied = await client.query(`SELECT version,name,checksum_sha256 FROM ${relation(schema, "_tibotattle_migration_history")} ORDER BY version`);
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_TARGET_MIGRATION_REQUIRED");
  }
  if (applied.rows.length !== migrations.length || migrations.some((item, index) => {
    const row = applied.rows[index];
    return row?.version !== item.version || row?.name !== item.name || row?.checksum_sha256 !== item.sha256;
  })) fail("ANALYTICS_APPLIED_TARGET_MIGRATION_REQUIRED");
  return serverVersion;
}

async function acquireTargetLock(client, schema) {
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [`${schema}:synthetic-analytics-applied-transfer`]);
    if (result.rows[0]?.locked !== true) fail("ANALYTICS_APPLIED_TRANSFER_BUSY");
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_TARGET_LOCK_FAILED");
  }
}

async function assertContained(client, schema) {
  let result;
  try {
    result = await client.query(`SELECT control_state,enrollment_enabled,upload_registration_enabled,
        processing_enabled,publication_enabled FROM ${relation(schema, "collection_controls")} WHERE singleton=1`);
  } catch {
    fail("ANALYTICS_APPLIED_TARGET_SCHEMA_REQUIRED");
  }
  const row = result.rows[0];
  if (result.rowCount !== 1 || row.control_state !== "contained" || row.enrollment_enabled !== false
      || row.upload_registration_enabled !== false || row.processing_enabled !== false || row.publication_enabled !== false) {
    fail("ANALYTICS_APPLIED_TARGET_NOT_CONTAINED");
  }
}

async function assertAppAnalyticsTablesEmpty(client, schema) {
  try {
    const fields = PRESERVED_APP_TABLES.map((table, index) =>
      `EXISTS(SELECT 1 FROM ${relation(schema, table)} LIMIT 1) AS state_${index}`).join(",");
    const result = await client.query(`SELECT ${fields}`);
    if (PRESERVED_APP_TABLES.some((_, index) => result.rows[0]?.[`state_${index}`] !== false)) {
      fail("ANALYTICS_APPLIED_APP_STATE_NOT_EMPTY");
    }
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_TARGET_READ_FAILED");
  }
}

async function createTransferTables(client, schema) {
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)} (
      source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
      sequence bigint NOT NULL CHECK (sequence > 0),
      event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
      owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
      revision bigint NOT NULL CHECK (revision > 0),
      kind text NOT NULL CHECK (kind IN ('source-updated','owner-active','owner-withdrawn','owner-erased')),
      object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
      content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
      authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
      public_authority_epoch bigint NOT NULL CHECK (public_authority_epoch > 0),
      recorded_ms bigint NOT NULL CHECK (recorded_ms >= 0),
      PRIMARY KEY (source_id,sequence),
      UNIQUE (source_id,event_digest)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, CONTROL_RUNS)} (
      transfer_id text PRIMARY KEY CHECK (transfer_id ~ '^synthetic-analytics-applied-[A-Za-z0-9._-]{1,96}$'),
      source_snapshot_id text NOT NULL,
      source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      source_event_count bigint NOT NULL CHECK (source_event_count >= 0),
      source_events_sha256 text NOT NULL CHECK (source_events_sha256 ~ '^[0-9a-f]{64}$'),
      page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND ${POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE}),
      last_source_id text,
      last_sequence bigint,
      status text NOT NULL CHECK (status IN ('running','complete')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      CHECK ((last_source_id IS NULL) = (last_sequence IS NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, CONTROL_CHECKPOINTS)} (
      transfer_id text PRIMARY KEY REFERENCES ${relation(schema, CONTROL_RUNS)}(transfer_id) ON DELETE CASCADE,
      last_source_id text,
      last_sequence bigint,
      row_count bigint NOT NULL CHECK (row_count >= 0),
      page_count integer NOT NULL CHECK (page_count >= 0),
      prefix_chain_sha256 text NOT NULL CHECK (prefix_chain_sha256 ~ '^[0-9a-f]{64}$'),
      complete boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((last_source_id IS NULL) = (last_sequence IS NULL)),
      CHECK ((row_count = 0) = (last_source_id IS NULL))
    )`);
  } catch {
    fail("ANALYTICS_APPLIED_CONTROL_SCHEMA_INVALID");
  }
  const columns = await client.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE]);
  if (columns.rows.length !== EVENT_COLUMNS.length || columns.rows.some((row, index) => {
    return row.column_name !== EVENT_COLUMNS[index] || row.data_type !== EVENT_COLUMN_TYPES[index] || row.is_nullable !== "NO";
  })) fail("ANALYTICS_APPLIED_TARGET_LAYOUT_INVALID");
  const constraints = await client.query(`SELECT contype,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u') ORDER BY contype,definition`,
  [`${schema}.${POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE}`]);
  const definitions = constraints.rows.map(row => row.definition.replaceAll(/\s+/gu, " ").trim()).sort();
  if (JSON.stringify(definitions) !== JSON.stringify(["PRIMARY KEY (source_id, sequence)",
    "UNIQUE (source_id, event_digest)"].sort())) fail("ANALYTICS_APPLIED_TARGET_LAYOUT_INVALID");
}

function checkpointChain(previous, rows) {
  const hash = sha256();
  hash.update(`${previous}\n`);
  for (const row of rows) hash.update(`${canonicalRow(row)}\n`);
  return hash.digest("hex");
}

function updateRowHash(hash, row) { hash.update(`${canonicalRow(row)}\n`); }

async function readSourcePage(source, after, limit) {
  let page;
  try {
    page = await source.listPage({ table: "analytics_applied_events", after, limit });
  } catch {
    fail("ANALYTICS_APPLIED_SOURCE_READ_FAILED");
  }
  if (!page || !Array.isArray(page.rows) || page.rows.length > limit) fail("ANALYTICS_APPLIED_SOURCE_PAGE_INVALID");
  const rows = page.rows.map(normalizeRow);
  for (let index = 0; index < rows.length; index += 1) {
    if (!cursorIsAfter(rows[index], after)
        || (index > 0 && !cursorIsAfter(rows[index], cursorFor(rows[index - 1])))) {
      fail("ANALYTICS_APPLIED_SOURCE_ORDER_INVALID");
    }
  }
  return rows;
}

async function sourceManifest(source, pageSize) {
  let receipt;
  try {
    receipt = await scanSealedSqliteAnalyticsEventJournal({ source, pageSize });
  } catch (error) {
    if (error?.code === "ANALYTICS_HISTORY_SOURCE_CHANGED") fail("ANALYTICS_APPLIED_SOURCE_CHANGED");
    if (error?.code === "ANALYTICS_HISTORY_SEALED_SOURCE_REQUIRED") fail("ANALYTICS_APPLIED_SEALED_SOURCE_REQUIRED");
    if (error?.code) fail("ANALYTICS_APPLIED_SEALED_SOURCE_INVALID");
    fail("ANALYTICS_APPLIED_SEALED_SOURCE_REQUIRED");
  }
  if (receipt?.schema !== "sealed-sqlite-analytics-events-v1" || receipt.postgresWrites !== 0
      || receipt.sourceCursorAdvanced !== false || !SHA256.test(receipt.sourceSnapshotSha256 ?? "")
      || !SHA256.test(receipt.eventRowsSha256 ?? "") || !/^(0|[1-9][0-9]*)$/u.test(receipt.eventRows ?? "")) {
    fail("ANALYTICS_APPLIED_SEALED_SOURCE_REQUIRED");
  }
  const snapshot = source.snapshot;
  if (snapshot?.immutable !== true || snapshot?.artifactSha256 !== receipt.sourceSnapshotSha256
      || snapshot?.snapshotId !== `sha256:${receipt.sourceSnapshotSha256}`
      || typeof source.verifySnapshot !== "function") fail("ANALYTICS_APPLIED_SEALED_SOURCE_REQUIRED");
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    snapshotSha256: receipt.sourceSnapshotSha256,
    rowCount: receipt.eventRows,
    rowsSha256: receipt.eventRowsSha256,
    pageSize,
    pagesRead: receipt.pagesRead,
  });
}

function cursorFromCheckpoint(checkpoint) {
  if (checkpoint.last_source_id === null) return null;
  if (typeof checkpoint.last_source_id !== "string" || !SOURCE_ID.test(checkpoint.last_source_id)) {
    fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
  }
  return Object.freeze({ sourceId: checkpoint.last_source_id, sequence: normalizeInteger(checkpoint.last_sequence) });
}

async function readCheckpoint(client, schema, transferId) {
  try {
    const result = await client.query(`SELECT last_source_id,last_sequence::text AS last_sequence,
        row_count::text AS row_count,page_count,prefix_chain_sha256,complete
      FROM ${relation(schema, CONTROL_CHECKPOINTS)} WHERE transfer_id=$1`, [transferId]);
    if (result.rows.length !== 1) fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    const checkpoint = result.rows[0];
    if (BigInt(checkpoint.row_count) === 0n) {
      if (checkpoint.last_source_id !== null || checkpoint.last_sequence !== null || checkpoint.page_count !== 0
          || checkpoint.prefix_chain_sha256 !== emptyPrefixHash()) fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    } else if (!cursorFromCheckpoint(checkpoint) || checkpoint.page_count < 1 || !SHA256.test(checkpoint.prefix_chain_sha256)) {
      fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    }
    return checkpoint;
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
  }
}

async function readTargetRowsForPage(client, schema, rows) {
  const conditions = rows.map((_, index) => `(source_id=$${index * 2 + 1} AND sequence=$${index * 2 + 2})`).join(" OR ");
  const values = rows.flatMap(row => [row.source_id, row.sequence]);
  let result;
  try {
    result = await client.query(`SELECT ${EVENT_COLUMNS.map(column => `"${column}"`).join(",")}
      FROM ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)} WHERE ${conditions}
      ORDER BY source_id COLLATE "C",sequence`, values);
  } catch {
    fail("ANALYTICS_APPLIED_DESTINATION_READ_FAILED");
  }
  if (result.rows.length !== rows.length) fail("ANALYTICS_APPLIED_DESTINATION_MISMATCH");
  const targets = result.rows.map(normalizeRow);
  for (let index = 0; index < rows.length; index += 1) {
    if (canonicalRow(rows[index]) !== canonicalRow(targets[index])) fail("ANALYTICS_APPLIED_DESTINATION_MISMATCH");
  }
}

async function verifyCheckpoint({ client, schema, source, transferId, checkpoint, pageSize }) {
  const expectedRows = BigInt(checkpoint.row_count);
  if (expectedRows === 0n) return;
  const checkpointCursor = cursorFromCheckpoint(checkpoint);
  let sourceAfter = null;
  let verifiedRows = 0n;
  let pageCount = 0;
  let chain = emptyPrefixHash();
  while (verifiedRows < expectedRows) {
    const remaining = expectedRows - verifiedRows;
    const limit = Number(remaining > BigInt(pageSize) ? BigInt(pageSize) : remaining);
    const rows = await readSourcePage(source, sourceAfter, limit);
    if (rows.length !== limit || compareCursor(cursorFor(rows.at(-1)), checkpointCursor) > 0) {
      fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    }
    await readTargetRowsForPage(client, schema, rows);
    chain = checkpointChain(chain, rows);
    sourceAfter = cursorFor(rows.at(-1));
    verifiedRows += BigInt(rows.length);
    pageCount += 1;
  }
  if (verifiedRows !== expectedRows || compareCursor(sourceAfter, checkpointCursor) !== 0
      || pageCount !== checkpoint.page_count || chain !== checkpoint.prefix_chain_sha256) {
    fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
  }
  const run = await client.query(`SELECT last_source_id,last_sequence::text AS last_sequence
    FROM ${relation(schema, CONTROL_RUNS)} WHERE transfer_id=$1`, [transferId]);
  if (run.rows.length !== 1 || run.rows[0].last_source_id !== checkpoint.last_source_id
      || run.rows[0].last_sequence !== checkpoint.last_sequence) fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
}

async function beginRun(client, schema, transferId, manifest) {
  await client.query("BEGIN");
  try {
    const current = await client.query(`SELECT source_snapshot_id,source_snapshot_sha256,
        source_event_count::text AS source_event_count,source_events_sha256,page_size,status
      FROM ${relation(schema, CONTROL_RUNS)} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (current.rows.length === 0) {
      await assertContained(client, schema);
      await assertAppAnalyticsTablesEmpty(client, schema);
      const target = await client.query(`SELECT count(*)::text AS rows FROM ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}`);
      if (target.rows[0]?.rows !== "0") fail("ANALYTICS_APPLIED_TARGET_NOT_EMPTY");
      await client.query(`INSERT INTO ${relation(schema, CONTROL_RUNS)}(
          transfer_id,source_snapshot_id,source_snapshot_sha256,source_event_count,source_events_sha256,
          page_size,last_source_id,last_sequence,status)
        VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,'running')`, [transferId, manifest.snapshotId,
        manifest.snapshotSha256, manifest.rowCount, manifest.rowsSha256, manifest.pageSize]);
      await client.query(`INSERT INTO ${relation(schema, CONTROL_CHECKPOINTS)}(
          transfer_id,last_source_id,last_sequence,row_count,page_count,prefix_chain_sha256,complete)
        VALUES($1,NULL,NULL,0,0,$2,false)`, [transferId, emptyPrefixHash()]);
      await client.query("COMMIT");
      return Object.freeze({ resumed: false, status: "running" });
    }
    const row = current.rows[0];
    if (row.source_snapshot_id !== manifest.snapshotId || row.source_snapshot_sha256 !== manifest.snapshotSha256
        || row.source_event_count !== manifest.rowCount || row.source_events_sha256 !== manifest.rowsSha256) {
      fail("ANALYTICS_APPLIED_TRANSFER_SOURCE_MISMATCH");
    }
    if (row.page_size !== manifest.pageSize) fail("ANALYTICS_APPLIED_TRANSFER_PAGE_SIZE_MISMATCH");
    const checkpoint = await readCheckpoint(client, schema, transferId);
    if ((row.status === "complete") !== (checkpoint.complete === true)) fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    await assertContained(client, schema);
    await assertAppAnalyticsTablesEmpty(client, schema);
    await client.query("COMMIT");
    return Object.freeze({ resumed: true, status: row.status });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_RUN_INITIALIZATION_FAILED");
  }
}

function insertRowsSql(schema, count) {
  const values = Array.from({ length: count }, (_, rowIndex) =>
    `(${EVENT_COLUMNS.map((_, columnIndex) => `$${rowIndex * EVENT_COLUMNS.length + columnIndex + 1}`).join(",")})`).join(",");
  return `INSERT INTO ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}
    (${EVENT_COLUMNS.map(column => `"${column}"`).join(",")}) VALUES ${values}
    ON CONFLICT (source_id,sequence) DO NOTHING`;
}

function rowValues(rows) { return rows.flatMap(row => EVENT_COLUMNS.map(column => row[column])); }

async function copyPage({ client, schema, transferId, prior, rows }) {
  if (rows.length === 0) return false;
  await client.query("BEGIN");
  try {
    const current = await readCheckpoint(client, schema, transferId);
    if (current.last_source_id !== prior.last_source_id || current.last_sequence !== prior.last_sequence
        || current.row_count !== prior.row_count || current.page_count !== prior.page_count
        || current.prefix_chain_sha256 !== prior.prefix_chain_sha256) fail("ANALYTICS_APPLIED_CHECKPOINT_RACE");
    await assertContained(client, schema);
    await assertAppAnalyticsTablesEmpty(client, schema);
    const inserted = await client.query(insertRowsSql(schema, rows.length), rowValues(rows));
    await readTargetRowsForPage(client, schema, rows);
    if (inserted.rowCount !== rows.length) fail("ANALYTICS_APPLIED_DESTINATION_CONFLICT");
    const last = cursorFor(rows.at(-1));
    const rowCount = (BigInt(prior.row_count) + BigInt(rows.length)).toString();
    const pageCount = prior.page_count + 1;
    const chain = checkpointChain(prior.prefix_chain_sha256, rows);
    await client.query(`UPDATE ${relation(schema, CONTROL_CHECKPOINTS)} SET
        last_source_id=$2,last_sequence=$3,row_count=$4,page_count=$5,prefix_chain_sha256=$6,updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId, last.sourceId, last.sequence, rowCount, pageCount, chain]);
    await client.query(`UPDATE ${relation(schema, CONTROL_RUNS)} SET last_source_id=$2,last_sequence=$3 WHERE transfer_id=$1`,
      [transferId, last.sourceId, last.sequence]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_PAGE_COMMIT_FAILED");
  }
}

async function scanTarget(client, schema, pageSize) {
  const hash = sha256();
  let count = 0n;
  let after = null;
  for (;;) {
    const result = after === null
      ? await client.query(`SELECT ${EVENT_COLUMNS.map(column => `"${column}"`).join(",")}
          FROM ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}
         ORDER BY source_id COLLATE "C",sequence LIMIT $1`, [pageSize])
      : await client.query(`SELECT ${EVENT_COLUMNS.map(column => `"${column}"`).join(",")}
          FROM ${relation(schema, POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}
         WHERE source_id COLLATE "C" > $1::text COLLATE "C"
            OR (source_id=$1 AND sequence>$2)
         ORDER BY source_id COLLATE "C",sequence LIMIT $3`, [after.sourceId, after.sequence, pageSize]);
    if (result.rows.length > pageSize) fail("ANALYTICS_APPLIED_DESTINATION_PAGE_INVALID");
    const rows = result.rows.map(normalizeRow);
    for (const row of rows) {
      if (!cursorIsAfter(row, after)) fail("ANALYTICS_APPLIED_DESTINATION_ORDER_INVALID");
      updateRowHash(hash, row);
      after = cursorFor(row);
      count += 1n;
    }
    if (rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: count.toString(), rowsSha256: hash.digest("hex"), last: after });
}

async function finalizeRun(client, schema, transferId) {
  await client.query("BEGIN");
  try {
    await assertContained(client, schema);
    await assertAppAnalyticsTablesEmpty(client, schema);
    const checkpoint = await readCheckpoint(client, schema, transferId);
    await client.query(`UPDATE ${relation(schema, CONTROL_CHECKPOINTS)} SET complete=true,updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await client.query(`UPDATE ${relation(schema, CONTROL_RUNS)} SET status='complete',completed_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await client.query("COMMIT");
    return checkpoint;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_FINALIZE_FAILED");
  }
}

function resultValue({ status, schema, manifest, target, pageSize, postgresVersion, pagesCommitted, rowsInserted, resumed }) {
  return Object.freeze({
    schema: POSTGRES_ANALYTICS_APPLIED_TRANSFER_SCHEMA,
    status,
    targetSchema: schema,
    postgresMajor: Math.floor(postgresVersion / 10_000),
    sourceSnapshotSha256: manifest.snapshotSha256,
    eventRows: manifest.rowCount,
    eventRowsSha256: manifest.rowsSha256,
    targetRows: target.rowCount,
    targetRowsSha256: target.rowsSha256,
    pageSize,
    pagesCommitted,
    rowsInserted,
    resumed,
    restartMode: "verify_checkpoint_and_resume_after_last_source_sequence",
    receiptStagingTable: POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE,
    mainAppliedEventsWritten: false,
    analyticsCursorAdvanced: false,
    ownerStateWritten: false,
    publicationActivated: false,
    projectionJsonFabricated: false,
  });
}

/**
 * Import sealed D1 applied-event tuples into an isolated staging table only.
 * PostgreSQL's application receipt table requires projection_json, which D1
 * does not provide; this never fabricates it, advances cursors, writes owner
 * authority, or activates publications.
 */
export async function transferPostgresAnalyticsAppliedReceipts({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  transferId,
  pageSize = POSTGRES_ANALYTICS_APPLIED_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = schemaName(rawTargetSchema);
  const size = validatePageSize(pageSize);
  if (!TRANSFER_ID.test(transferId ?? "")) fail("ANALYTICS_APPLIED_TRANSFER_ID_INVALID");
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("ANALYTICS_APPLIED_DESTINATION_REQUIRED");
  const manifest = await sourceManifest(source, size);
  let client;
  try { client = await destinationPool.connect(); } catch { fail("ANALYTICS_APPLIED_DESTINATION_UNAVAILABLE"); }
  let lockHeld = false;
  try {
    const postgresVersion = await validateTarget(client, schema);
    await acquireTargetLock(client, schema);
    lockHeld = true;
    await assertContained(client, schema);
    await assertAppAnalyticsTablesEmpty(client, schema);
    await createTransferTables(client, schema);
    const opened = await beginRun(client, schema, transferId, manifest);
    let checkpoint = await readCheckpoint(client, schema, transferId);
    await verifyCheckpoint({ client, schema, source, transferId, checkpoint, pageSize: size });
    if (opened.status === "complete" && checkpoint.complete) {
      const target = await scanTarget(client, schema, size);
      if (target.rowCount !== manifest.rowCount || target.rowsSha256 !== manifest.rowsSha256) {
        fail("ANALYTICS_APPLIED_SOURCE_DESTINATION_PARITY_FAILED");
      }
      const currentManifest = await sourceManifest(source, size);
      if (currentManifest.snapshotSha256 !== manifest.snapshotSha256
          || currentManifest.rowCount !== manifest.rowCount || currentManifest.rowsSha256 !== manifest.rowsSha256) {
        fail("ANALYTICS_APPLIED_SOURCE_CHANGED");
      }
      return resultValue({ status: "already_complete", schema, manifest, target, pageSize: size,
        postgresVersion, pagesCommitted: 0, rowsInserted: "0", resumed: true });
    }
    let after = cursorFromCheckpoint(checkpoint);
    let pagesCommitted = 0;
    let rowsInserted = 0n;
    for (;;) {
      const rows = await readSourcePage(source, after, size);
      if (rows.length === 0) break;
      if (after !== null && compareCursor(cursorFor(rows[0]), after) <= 0) fail("ANALYTICS_APPLIED_SOURCE_ORDER_INVALID");
      const inserted = await copyPage({ client, schema, transferId, prior: checkpoint, rows });
      if (inserted) {
        pagesCommitted += 1;
        rowsInserted += BigInt(rows.length);
        after = cursorFor(rows.at(-1));
        checkpoint = await readCheckpoint(client, schema, transferId);
      }
      if (rows.length < size) break;
    }
    const currentManifest = await sourceManifest(source, size);
    if (currentManifest.snapshotSha256 !== manifest.snapshotSha256 || currentManifest.rowCount !== manifest.rowCount
        || currentManifest.rowsSha256 !== manifest.rowsSha256) fail("ANALYTICS_APPLIED_SOURCE_CHANGED");
    await assertContained(client, schema);
    await assertAppAnalyticsTablesEmpty(client, schema);
    checkpoint = await readCheckpoint(client, schema, transferId);
    if (checkpoint.row_count !== manifest.rowCount) fail("ANALYTICS_APPLIED_CHECKPOINT_INVALID");
    const target = await scanTarget(client, schema, size);
    if (target.rowCount !== manifest.rowCount || target.rowsSha256 !== manifest.rowsSha256) {
      fail("ANALYTICS_APPLIED_SOURCE_DESTINATION_PARITY_FAILED");
    }
    await finalizeRun(client, schema, transferId);
    return resultValue({ status: "synthetic_analytics_applied_receipt_transfer_complete", schema, manifest,
      target, pageSize: size, postgresVersion, pagesCommitted, rowsInserted: rowsInserted.toString(), resumed: opened.resumed });
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedTransferError) throw error;
    fail("ANALYTICS_APPLIED_TRANSFER_FAILED");
  } finally {
    if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:synthetic-analytics-applied-transfer`]).catch(() => {});
    client?.release();
  }
}

// Shared sealed-source primitives for the separate main-table transfer. Keep
// this an explicit export surface so the importer reuses the same closed D1
// tuple validation, source keyset ordering, and content-free manifest.
export {
  EVENT_COLUMNS as POSTGRES_ANALYTICS_APPLIED_EVENT_COLUMNS,
  canonicalRow as canonicalAnalyticsAppliedEventRow,
  compareCursor as compareAnalyticsAppliedEventCursor,
  cursorFor as analyticsAppliedEventCursorFor,
  normalizeRow as normalizeAnalyticsAppliedEventRow,
  readSourcePage as readSealedAnalyticsAppliedEventPage,
  sourceManifest as scanSealedAnalyticsAppliedEventSource,
};
