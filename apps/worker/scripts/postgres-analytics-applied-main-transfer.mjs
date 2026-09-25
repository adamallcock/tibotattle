import { createHash } from "node:crypto";
import {
  POSTGRES_ANALYTICS_APPLIED_EVENT_COLUMNS,
  POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE,
  canonicalAnalyticsAppliedEventRow,
  compareAnalyticsAppliedEventCursor,
  analyticsAppliedEventCursorFor,
  normalizeAnalyticsAppliedEventRow,
  readSealedAnalyticsAppliedEventPage,
  scanSealedAnalyticsAppliedEventSource,
} from "./postgres-analytics-applied-transfer.mjs";
import { inspectSealedSqliteAnalyticsSourceIdentity } from "./postgres-analytics-history-transfer.mjs";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "./postgres-migrations.mjs";

export const POSTGRES_ANALYTICS_APPLIED_MAIN_TRANSFER_SCHEMA = "sealed-d1-applied-events-to-postgres-v1";
export const POSTGRES_ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_PREFIX = "storage_journal_transfer_target_";
export const POSTGRES_ANALYTICS_APPLIED_MAIN_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE = POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE;

const RUNS = "_synthetic_analytics_applied_main_transfer_runs_v1";
const CHECKPOINTS = "_synthetic_analytics_applied_main_transfer_checkpoints_v1";
const JOURNAL_RUNS = "_storage_ingestion_journal_transfer_runs_v1";
const JOURNAL_CHECKPOINTS = "_storage_ingestion_journal_transfer_checkpoints_v1";
const MAIN_TABLE = "analytics_applied_events";
const JOURNAL_TABLE = "storage_ingestion_changes";
const SOURCE_STATE_TABLE = "storage_source_state";
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const TRANSFER_ID = /^synthetic-analytics-applied-main-[A-Za-z0-9._-]{1,96}$/u;
const JOURNAL_TRANSFER_ID = /^synthetic-ingestion-journal-[A-Za-z0-9._-]{1,96}$/u;
const JOURNAL_MAX_PAGE_SIZE = 250;
const EVENT_COLUMNS = POSTGRES_ANALYTICS_APPLIED_EVENT_COLUMNS;
const TARGET_COLUMNS = Object.freeze([
  "source_id", "sequence", "event_digest", "owner_digest", "authority_epoch", "projection_json",
  "event_tuple_version", "revision", "kind", "object_digest", "content_digest",
  "public_authority_epoch", "recorded_ms",
]);
const JOURNAL_COLUMNS = EVENT_COLUMNS;
const DOWNSTREAM_TABLES = Object.freeze([
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
const ALLOWED_TABLES = new Set([
  "collection_controls", SOURCE_STATE_TABLE, JOURNAL_TABLE, MAIN_TABLE,
  ...DOWNSTREAM_TABLES,
  RUNS, CHECKPOINTS, JOURNAL_RUNS, JOURNAL_CHECKPOINTS, "_tibotattle_migration_history",
]);

export class PostgresAnalyticsAppliedMainTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresAnalyticsAppliedMainTransferError";
    this.code = code;
  }
}

function fail(code) { throw new PostgresAnalyticsAppliedMainTransferError(code); }
function sha256() { return createHash("sha256"); }
function emptyPrefixHash() { return sha256().digest("hex"); }

function validatePageSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE) {
    fail("ANALYTICS_APPLIED_MAIN_PAGE_SIZE_INVALID");
  }
  return value;
}

function schemaName(value) {
  const suffix = typeof value === "string" && value.startsWith(POSTGRES_ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_PREFIX)
    ? value.slice(POSTGRES_ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_PREFIX.length) : "";
  if (typeof value !== "string" || !SCHEMA.test(value) || !TARGET_SUFFIX.test(suffix)
      || value.startsWith("pg_") || value === "information_schema" || value === "pg_catalog") {
    fail("ANALYTICS_APPLIED_MAIN_DISPOSABLE_SCHEMA_REQUIRED");
  }
  return value;
}

function relation(schema, name) {
  if (!ALLOWED_TABLES.has(name)) fail("ANALYTICS_APPLIED_MAIN_TABLE_INVALID");
  return `"${schemaName(schema)}"."${name}"`;
}

function normalizeInteger(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value).toString();
  fail("ANALYTICS_APPLIED_MAIN_TARGET_ROW_INVALID");
}

function checkpointChain(previous, rows) {
  const hash = sha256();
  hash.update(`${previous}\n`);
  for (const row of rows) hash.update(`${canonicalAnalyticsAppliedEventRow(row)}\n`);
  return hash.digest("hex");
}

function rowHash(hash, row) { hash.update(`${canonicalAnalyticsAppliedEventRow(row)}\n`); }

function sourceCursor(manifest) {
  return manifest.rowCount === "0" ? null : Object.freeze({
    sourceId: manifest.sourceId,
    sequence: manifest.rowCount,
  });
}

async function readMainManifest(source, pageSize) {
  let eventManifest;
  let identity;
  try {
    [eventManifest, identity] = await Promise.all([
      scanSealedAnalyticsAppliedEventSource(source, pageSize),
      inspectSealedSqliteAnalyticsSourceIdentity(source),
    ]);
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    if (error?.code === "ANALYTICS_HISTORY_SOURCE_CHANGED") fail("ANALYTICS_APPLIED_MAIN_SOURCE_CHANGED");
    if (error?.code === "ANALYTICS_HISTORY_SOURCE_IDENTITY_NOT_SINGLETON") {
      fail("ANALYTICS_APPLIED_MAIN_SOURCE_IDENTITY_NOT_SINGLETON");
    }
    fail("ANALYTICS_APPLIED_MAIN_SEALED_SOURCE_INVALID");
  }
  if (!SHA256.test(eventManifest?.snapshotSha256 ?? "") || !SHA256.test(eventManifest.rowsSha256 ?? "")
      || !/^(0|[1-9][0-9]*)$/u.test(eventManifest.rowCount ?? "")
      || identity.snapshotSha256 !== eventManifest.snapshotSha256
      || identity.snapshotId !== `sha256:${eventManifest.snapshotSha256}`
      || identity.contractVersion !== 1 || !SOURCE_ID.test(identity.sourceId ?? "")
      || !SHA256.test(identity.namespaceSha256 ?? "") || identity.sourceSequence !== eventManifest.rowCount) {
    fail("ANALYTICS_APPLIED_MAIN_SEALED_SOURCE_INVALID");
  }
  return Object.freeze({
    snapshotId: identity.snapshotId,
    snapshotSha256: identity.snapshotSha256,
    sourceId: identity.sourceId,
    sourceNamespaceSha256: identity.namespaceSha256,
    sourceSequence: identity.sourceSequence,
    sourceAuthorityEpoch: identity.sourceAuthorityEpoch,
    rowCount: eventManifest.rowCount,
    rowsSha256: eventManifest.rowsSha256,
    pageSize,
  });
}

async function readAppliedEventPage(source, after, limit) {
  const rows = [];
  let cursor = after;
  while (rows.length < limit) {
    const requestSize = Math.min(POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE, limit - rows.length);
    const page = await readSealedAnalyticsAppliedEventPage(source, cursor, requestSize);
    rows.push(...page);
    if (page.length === 0 || page.length < requestSize) break;
    cursor = analyticsAppliedEventCursorFor(page.at(-1));
  }
  return rows;
}

async function validateTarget(client, schema) {
  let server;
  try {
    server = await client.query("SELECT inet_server_addr() AS address,current_setting('server_version_num')::integer AS version");
  } catch {
    fail("ANALYTICS_APPLIED_MAIN_TARGET_UNAVAILABLE");
  }
  const version = Number(server.rows[0]?.version);
  if (server.rows[0]?.address !== null || Math.floor(version / 10_000) !== 17) {
    fail("ANALYTICS_APPLIED_MAIN_LOCAL_POSTGRES_17_REQUIRED");
  }
  let migrations;
  let applied;
  try {
    migrations = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT });
    if (migrations.length < 39 || migrations[38]?.name !== "0039_analytics_applied_projection_v1.sql") {
      fail("ANALYTICS_APPLIED_MAIN_MIGRATION_CONTRACT_UNAVAILABLE");
    }
    applied = await client.query(`SELECT version,name,checksum_sha256 FROM ${relation(schema, "_tibotattle_migration_history")} ORDER BY version`);
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail("ANALYTICS_APPLIED_MAIN_TARGET_MIGRATION_REQUIRED");
  }
  if (applied.rows.length !== migrations.length || migrations.some((migration, index) => {
    const row = applied.rows[index];
    return row?.version !== migration.version || row?.name !== migration.name || row?.checksum_sha256 !== migration.sha256;
  })) fail("ANALYTICS_APPLIED_MAIN_TARGET_MIGRATION_REQUIRED");
  for (const name of ["collection_controls", SOURCE_STATE_TABLE, JOURNAL_TABLE, MAIN_TABLE,
    ...DOWNSTREAM_TABLES, JOURNAL_RUNS, JOURNAL_CHECKPOINTS]) {
    let found;
    try { found = await client.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`]); }
    catch { fail("ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_REQUIRED"); }
    if (!found.rows[0]?.relation) fail("ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_REQUIRED");
  }
  return version;
}

async function assertContained(client, schema) {
  let result;
  try {
    result = await client.query(`SELECT control_state,enrollment_enabled,upload_registration_enabled,
      processing_enabled,publication_enabled FROM ${relation(schema, "collection_controls")} WHERE singleton=1`);
  } catch {
    fail("ANALYTICS_APPLIED_MAIN_TARGET_SCHEMA_REQUIRED");
  }
  const row = result.rows[0];
  if (result.rowCount !== 1 || row.control_state !== "contained" || row.enrollment_enabled !== false
      || row.upload_registration_enabled !== false || row.processing_enabled !== false || row.publication_enabled !== false) {
    fail("ANALYTICS_APPLIED_MAIN_TARGET_NOT_CONTAINED");
  }
}

async function assertNoAppliedEventTriggers(client, schema) {
  const result = await client.query(`SELECT count(*)::int AS count
    FROM pg_trigger trigger_row
    JOIN pg_class relation_row ON relation_row.oid=trigger_row.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid=relation_row.relnamespace
    WHERE namespace_row.nspname=$1 AND relation_row.relname=$2 AND NOT trigger_row.tgisinternal`, [schema, MAIN_TABLE]);
  if (result.rows[0]?.count !== 0) fail("ANALYTICS_APPLIED_MAIN_UNEXPECTED_TRIGGER");
}

async function assertNoDownstreamAuthority(client, schema) {
  const checks = DOWNSTREAM_TABLES.map((table, index) =>
    `EXISTS(SELECT 1 FROM ${relation(schema, table)} LIMIT 1) AS present_${index}`).join(",");
  let result;
  try { result = await client.query(`SELECT ${checks}`); }
  catch { fail("ANALYTICS_APPLIED_MAIN_TARGET_READ_FAILED"); }
  if (DOWNSTREAM_TABLES.some((_, index) => result.rows[0]?.[`present_${index}`] !== false)) {
    fail("ANALYTICS_APPLIED_MAIN_DOWNSTREAM_AUTHORITY_NOT_EMPTY");
  }
}

async function readSourceState(client, schema, manifest) {
  const state = await client.query(`SELECT singleton,source_id,authority_epoch::text AS authority_epoch
    FROM ${relation(schema, SOURCE_STATE_TABLE)}`);
  if (state.rows.length !== 1 || state.rows[0].singleton !== 1 || state.rows[0].source_id !== manifest.sourceId
      || normalizeInteger(state.rows[0].authority_epoch) !== manifest.sourceAuthorityEpoch) {
    fail("ANALYTICS_APPLIED_MAIN_SOURCE_STATE_MISMATCH");
  }
}

function normalizeJournalTarget(raw) {
  let row;
  try { row = normalizeAnalyticsAppliedEventRow(raw); }
  catch { fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH"); }
  if (normalizeInteger(raw.event_tuple_version) !== "1" || normalizeInteger(raw.owner_revision) !== "0") {
    fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
  }
  return row;
}

async function verifyJournalProof(client, schema, source, manifest, journalTransferId) {
  let runResult;
  let checkpointResult;
  try {
    [runResult, checkpointResult] = await Promise.all([
      client.query(`SELECT source_snapshot_id,source_snapshot_sha256,source_id,
          source_authority_epoch::text AS source_authority_epoch,source_row_count::text AS source_row_count,
          source_rows_sha256,page_size,last_sequence::text AS last_sequence,status,completed_at
        FROM ${relation(schema, JOURNAL_RUNS)} WHERE transfer_id=$1`, [journalTransferId]),
      client.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
          page_count,prefix_chain_sha256,complete FROM ${relation(schema, JOURNAL_CHECKPOINTS)} WHERE transfer_id=$1`,
        [journalTransferId]),
    ]);
  } catch { fail("ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_REQUIRED"); }
  const run = runResult.rows[0];
  const checkpoint = checkpointResult.rows[0];
  const lastSequence = manifest.rowCount;
  const journalPageCount = (BigInt(manifest.rowCount) + BigInt(Math.max(1, Number(run?.page_size ?? 0))) - 1n)
    / BigInt(Math.max(1, Number(run?.page_size ?? 0)));
  if (runResult.rowCount !== 1 || checkpointResult.rowCount !== 1 || run.status !== "complete"
      || !run.completed_at || run.source_snapshot_id !== `sha256:${run.source_snapshot_sha256}`
      || !SHA256.test(run.source_snapshot_sha256 ?? "") || run.source_id !== manifest.sourceId
      || normalizeInteger(run.source_authority_epoch) !== manifest.sourceAuthorityEpoch
      || normalizeInteger(run.source_row_count) !== manifest.rowCount || run.source_rows_sha256 !== manifest.rowsSha256
      || normalizeInteger(run.last_sequence) !== lastSequence || !Number.isSafeInteger(run.page_size)
      || run.page_size < 1 || run.page_size > JOURNAL_MAX_PAGE_SIZE
      || checkpoint.complete !== true || normalizeInteger(checkpoint.row_count) !== manifest.rowCount
      || normalizeInteger(checkpoint.last_sequence) !== lastSequence || !Number.isSafeInteger(checkpoint.page_count)
      || BigInt(checkpoint.page_count) !== journalPageCount
      || !SHA256.test(checkpoint.prefix_chain_sha256 ?? "")) {
    fail("ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_MISMATCH");
  }
  await readSourceState(client, schema, manifest);

  const hash = sha256();
  let chain = emptyPrefixHash();
  let rowsSeen = 0n;
  let pagesSeen = 0;
  let after = null;
  for (;;) {
    let sourceRows;
    try { sourceRows = await readAppliedEventPage(source, after, run.page_size); }
    catch { fail("ANALYTICS_APPLIED_MAIN_SOURCE_CHANGED"); }
    if (sourceRows.length === 0) break;
    if (sourceRows.some(row => row.source_id !== manifest.sourceId)) fail("ANALYTICS_APPLIED_MAIN_SOURCE_IDENTITY_MISMATCH");
    const firstSequence = sourceRows[0].sequence;
    const last = sourceRows.at(-1);
    let journalRows;
    try {
      const result = await client.query(`SELECT ${JOURNAL_COLUMNS.map(column => `"${column}"`).join(",")},
          owner_revision::text AS owner_revision,event_tuple_version
        FROM ${relation(schema, JOURNAL_TABLE)}
        WHERE source_id=$1 AND sequence BETWEEN $2 AND $3 ORDER BY sequence`,
      [manifest.sourceId, firstSequence, last.sequence]);
      journalRows = result.rows.map(normalizeJournalTarget);
      if (journalRows.length !== sourceRows.length) fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
    } catch (error) {
      if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
      fail("ANALYTICS_APPLIED_MAIN_JOURNAL_READ_FAILED");
    }
    for (let index = 0; index < sourceRows.length; index += 1) {
      const event = sourceRows[index];
      const journal = journalRows[index];
      if (canonicalAnalyticsAppliedEventRow(event) !== canonicalAnalyticsAppliedEventRow(journal)) {
        fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
      }
      rowHash(hash, event);
      after = analyticsAppliedEventCursorFor(event);
      rowsSeen += 1n;
    }
    chain = checkpointChain(chain, sourceRows);
    pagesSeen += 1;
    if (sourceRows.length < run.page_size) break;
  }
  if (rowsSeen.toString() !== manifest.rowCount || hash.digest("hex") !== manifest.rowsSha256
      || pagesSeen !== checkpoint.page_count || chain !== checkpoint.prefix_chain_sha256) {
    fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
  }
  const targetCount = await client.query(`SELECT count(*)::text AS count,
      count(*) FILTER (WHERE source_id<>$1)::text AS other_sources
    FROM ${relation(schema, JOURNAL_TABLE)}`, [manifest.sourceId]);
  if (targetCount.rows[0]?.count !== manifest.rowCount || targetCount.rows[0]?.other_sources !== "0") {
    fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
  }
  return Object.freeze({
    transferId: journalTransferId,
    snapshotId: run.source_snapshot_id,
    snapshotSha256: run.source_snapshot_sha256,
    rowCount: run.source_row_count,
    rowsSha256: run.source_rows_sha256,
    lastSequence: run.last_sequence,
    sourceId: run.source_id,
    sourceAuthorityEpoch: run.source_authority_epoch,
  });
}

async function assertSourceOnlyPreconditions(client, schema, source, manifest, journalTransferId, expectedReceiptRows) {
  await assertContained(client, schema);
  await assertNoAppliedEventTriggers(client, schema);
  await assertNoDownstreamAuthority(client, schema);
  await verifyJournalProof(client, schema, source, manifest, journalTransferId);
  await assertSourceOnlyState(client, schema, manifest, expectedReceiptRows);
}

async function assertSourceOnlyState(client, schema, manifest, expectedReceiptRows) {
  await assertContained(client, schema);
  await assertNoAppliedEventTriggers(client, schema);
  await assertNoDownstreamAuthority(client, schema);
  await readSourceState(client, schema, manifest);
  const journal = await client.query(`SELECT count(*)::text AS count,
      count(*) FILTER (WHERE source_id<>$1)::text AS other_sources,
      count(*) FILTER (WHERE event_tuple_version<>1 OR owner_revision<>0
        OR revision IS NULL OR object_digest IS NULL OR content_digest IS NULL OR public_authority_epoch IS NULL)::text AS unqualified
    FROM ${relation(schema, JOURNAL_TABLE)}`, [manifest.sourceId]);
  if (journal.rows[0]?.count !== manifest.rowCount || journal.rows[0]?.other_sources !== "0"
      || journal.rows[0]?.unqualified !== "0") fail("ANALYTICS_APPLIED_MAIN_JOURNAL_ROW_MISMATCH");
  const receipts = await client.query(`SELECT count(*)::text AS count,
      count(*) FILTER (WHERE source_id<>$1)::text AS other_sources,
      count(*) FILTER (WHERE event_tuple_version<>1 OR projection_json IS NOT NULL)::text AS wrong_qualification
    FROM ${relation(schema, MAIN_TABLE)}`, [manifest.sourceId]);
  if (receipts.rows[0]?.count !== expectedReceiptRows || receipts.rows[0]?.other_sources !== "0"
      || receipts.rows[0]?.wrong_qualification !== "0") {
    fail(expectedReceiptRows === "0" ? "ANALYTICS_APPLIED_MAIN_TARGET_NOT_EMPTY" : "ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  }
}

async function acquireLock(client, schema, name, code) {
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`${schema}:${name}`]);
    if (result.rows[0]?.locked !== true) fail(code);
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail(code);
  }
}

async function createTransferTables(client, schema) {
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, RUNS)} (
      transfer_id text PRIMARY KEY CHECK (transfer_id ~ '^synthetic-analytics-applied-main-[A-Za-z0-9._-]{1,96}$'),
      source_snapshot_id text NOT NULL,
      source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      source_id text NOT NULL,
      source_namespace_sha256 text NOT NULL CHECK (source_namespace_sha256 ~ '^[0-9a-f]{64}$'),
      source_contract_version integer NOT NULL CHECK (source_contract_version=1),
      source_sequence bigint NOT NULL CHECK (source_sequence>=0),
      source_authority_epoch bigint NOT NULL CHECK (source_authority_epoch>=0),
      source_event_count bigint NOT NULL CHECK (source_event_count>=0),
      source_events_sha256 text NOT NULL CHECK (source_events_sha256 ~ '^[0-9a-f]{64}$'),
      journal_transfer_id text NOT NULL,
      journal_source_snapshot_id text NOT NULL,
      journal_source_snapshot_sha256 text NOT NULL CHECK (journal_source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      journal_rows_sha256 text NOT NULL CHECK (journal_rows_sha256 ~ '^[0-9a-f]{64}$'),
      page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND ${POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE}),
      last_source_id text,
      last_sequence bigint,
      status text NOT NULL CHECK (status IN ('running','complete')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      CHECK ((last_source_id IS NULL) = (last_sequence IS NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(schema, CHECKPOINTS)} (
      transfer_id text PRIMARY KEY REFERENCES ${relation(schema, RUNS)}(transfer_id) ON DELETE CASCADE,
      last_source_id text,
      last_sequence bigint,
      row_count bigint NOT NULL CHECK (row_count>=0),
      page_count integer NOT NULL CHECK (page_count>=0),
      prefix_chain_sha256 text NOT NULL CHECK (prefix_chain_sha256 ~ '^[0-9a-f]{64}$'),
      complete boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((last_source_id IS NULL) = (last_sequence IS NULL))
    )`);
  } catch { fail("ANALYTICS_APPLIED_MAIN_CONTROL_SCHEMA_INVALID"); }
}

async function readCheckpoint(client, schema, transferId) {
  let result;
  try {
    result = await client.query(`SELECT last_source_id,last_sequence::text AS last_sequence,row_count::text AS row_count,
        page_count,prefix_chain_sha256,complete FROM ${relation(schema, CHECKPOINTS)} WHERE transfer_id=$1`, [transferId]);
  } catch { fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID"); }
  const row = result.rows[0];
  if (result.rowCount !== 1) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  const count = normalizeInteger(row.row_count);
  if (count === "0") {
    if (row.last_source_id !== null || row.last_sequence !== null || row.page_count !== 0
        || row.prefix_chain_sha256 !== emptyPrefixHash()) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  } else if (!SOURCE_ID.test(row.last_source_id ?? "") || BigInt(normalizeInteger(row.last_sequence)) < 1n
      || row.page_count < 1 || !SHA256.test(row.prefix_chain_sha256 ?? "")) {
    fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  }
  return row;
}

async function beginRun({ client, schema, manifest, journal, transferId, pageSize }) {
  await client.query("BEGIN");
  try {
    const found = await client.query(`SELECT source_snapshot_id,source_snapshot_sha256,source_id,
        source_namespace_sha256,source_contract_version,source_sequence::text AS source_sequence,
        source_authority_epoch::text AS source_authority_epoch,source_event_count::text AS source_event_count,
        source_events_sha256,journal_transfer_id,journal_source_snapshot_id,journal_source_snapshot_sha256,
        journal_rows_sha256,page_size,last_source_id,last_sequence::text AS last_sequence,status
      FROM ${relation(schema, RUNS)} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (found.rowCount === 0) {
      await assertSourceOnlyState(client, schema, manifest, "0");
      await client.query(`INSERT INTO ${relation(schema, RUNS)}(
        transfer_id,source_snapshot_id,source_snapshot_sha256,source_id,source_namespace_sha256,
        source_contract_version,source_sequence,source_authority_epoch,source_event_count,source_events_sha256,
        journal_transfer_id,journal_source_snapshot_id,journal_source_snapshot_sha256,journal_rows_sha256,
        page_size,last_source_id,last_sequence,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,NULL,'running')`,
      [transferId, manifest.snapshotId, manifest.snapshotSha256, manifest.sourceId, manifest.sourceNamespaceSha256,
        1, manifest.sourceSequence, manifest.sourceAuthorityEpoch, manifest.rowCount, manifest.rowsSha256,
        journal.transferId, journal.snapshotId, journal.snapshotSha256, journal.rowsSha256, pageSize]);
      await client.query(`INSERT INTO ${relation(schema, CHECKPOINTS)}(
        transfer_id,last_source_id,last_sequence,row_count,page_count,prefix_chain_sha256,complete)
        VALUES($1,NULL,NULL,0,0,$2,false)`, [transferId, emptyPrefixHash()]);
      await client.query("COMMIT");
      return Object.freeze({ resumed: false, status: "running" });
    }
    const row = found.rows[0];
    if (row.source_snapshot_id !== manifest.snapshotId || row.source_snapshot_sha256 !== manifest.snapshotSha256
        || row.source_id !== manifest.sourceId || row.source_namespace_sha256 !== manifest.sourceNamespaceSha256
        || row.source_contract_version !== 1 || row.source_sequence !== manifest.sourceSequence
        || row.source_authority_epoch !== manifest.sourceAuthorityEpoch || row.source_event_count !== manifest.rowCount
        || row.source_events_sha256 !== manifest.rowsSha256 || row.journal_transfer_id !== journal.transferId
        || row.journal_source_snapshot_id !== journal.snapshotId
        || row.journal_source_snapshot_sha256 !== journal.snapshotSha256 || row.journal_rows_sha256 !== journal.rowsSha256) {
      fail("ANALYTICS_APPLIED_MAIN_TRANSFER_SOURCE_MISMATCH");
    }
    if (row.page_size !== pageSize) fail("ANALYTICS_APPLIED_MAIN_PAGE_SIZE_MISMATCH");
    const checkpoint = await readCheckpoint(client, schema, transferId);
    if (row.last_source_id !== checkpoint.last_source_id || row.last_sequence !== checkpoint.last_sequence
        || ((row.status === "complete") !== (checkpoint.complete === true))) {
      fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
    }
    await assertSourceOnlyState(client, schema, manifest, checkpoint.row_count);
    await client.query("COMMIT");
    return Object.freeze({ resumed: true, status: row.status });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail("ANALYTICS_APPLIED_MAIN_RUN_INITIALIZATION_FAILED");
  }
}

function targetCursor(checkpoint) {
  if (checkpoint.last_source_id === null) return null;
  return Object.freeze({ sourceId: checkpoint.last_source_id, sequence: normalizeInteger(checkpoint.last_sequence) });
}

async function readTargetRows(client, schema, sourceRows) {
  if (sourceRows.length === 0) return;
  const condition = sourceRows.map((_, index) => `(source_id=$${index * 2 + 1} AND sequence=$${index * 2 + 2})`).join(" OR ");
  const params = sourceRows.flatMap(row => [row.source_id, row.sequence]);
  let result;
  try {
    result = await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
      FROM ${relation(schema, MAIN_TABLE)} WHERE ${condition}
      ORDER BY source_id COLLATE "C",sequence`, params);
  } catch { fail("ANALYTICS_APPLIED_MAIN_DESTINATION_READ_FAILED"); }
  if (result.rowCount !== sourceRows.length) fail("ANALYTICS_APPLIED_MAIN_DESTINATION_MISMATCH");
  for (let index = 0; index < sourceRows.length; index += 1) {
    const raw = result.rows[index];
    let target;
    try { target = normalizeAnalyticsAppliedEventRow(raw); }
    catch { fail("ANALYTICS_APPLIED_MAIN_DESTINATION_MISMATCH"); }
    if (raw.projection_json !== null || normalizeInteger(raw.event_tuple_version) !== "1"
        || canonicalAnalyticsAppliedEventRow(target) !== canonicalAnalyticsAppliedEventRow(sourceRows[index])) {
      fail("ANALYTICS_APPLIED_MAIN_DESTINATION_MISMATCH");
    }
  }
}

async function verifyCheckpoint({ client, schema, source, transferId, checkpoint, pageSize }) {
  const expected = BigInt(checkpoint.row_count);
  const cursor = targetCursor(checkpoint);
  let after = null;
  let count = 0n;
  let pages = 0;
  let chain = emptyPrefixHash();
  while (count < expected) {
    const remaining = expected - count;
    const limit = Number(remaining > BigInt(pageSize) ? BigInt(pageSize) : remaining);
    const rows = await readSealedAnalyticsAppliedEventPage(source, after, limit);
    if (rows.length !== limit || compareAnalyticsAppliedEventCursor(analyticsAppliedEventCursorFor(rows.at(-1)), cursor) > 0) {
      fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
    }
    await readTargetRows(client, schema, rows);
    chain = checkpointChain(chain, rows);
    after = analyticsAppliedEventCursorFor(rows.at(-1));
    count += BigInt(rows.length);
    pages += 1;
  }
  if (count !== expected || ((cursor === null) !== (after === null))
      || (cursor && compareAnalyticsAppliedEventCursor(after, cursor) !== 0)
      || pages !== checkpoint.page_count || chain !== checkpoint.prefix_chain_sha256) {
    fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  }
  const run = await client.query(`SELECT last_source_id,last_sequence::text AS last_sequence
    FROM ${relation(schema, RUNS)} WHERE transfer_id=$1`, [transferId]);
  if (run.rowCount !== 1 || run.rows[0].last_source_id !== checkpoint.last_source_id
      || run.rows[0].last_sequence !== checkpoint.last_sequence) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
  const total = await client.query(`SELECT count(*)::text AS count FROM ${relation(schema, MAIN_TABLE)}`);
  if (total.rows[0]?.count !== checkpoint.row_count) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
}

function insertRowsSql(schema, count) {
  const values = Array.from({ length: count }, (_, rowIndex) => {
    const offset = rowIndex * EVENT_COLUMNS.length;
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},NULL,1,`
      + `$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11})`;
  }).join(",");
  return `INSERT INTO ${relation(schema, MAIN_TABLE)} (${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}) VALUES ${values}`;
}

function targetValues(rows) {
  return rows.flatMap(row => [row.source_id, row.sequence, row.event_digest, row.owner_digest,
    row.authority_epoch, row.revision, row.kind, row.object_digest, row.content_digest,
    row.public_authority_epoch, row.recorded_ms]);
}

async function copyPage({ client, schema, manifest, transferId, prior, rows }) {
  if (rows.length === 0) return false;
  await client.query("BEGIN");
  try {
    const checkpoint = await readCheckpoint(client, schema, transferId);
    if (checkpoint.last_source_id !== prior.last_source_id || checkpoint.last_sequence !== prior.last_sequence
        || checkpoint.row_count !== prior.row_count || checkpoint.page_count !== prior.page_count
        || checkpoint.prefix_chain_sha256 !== prior.prefix_chain_sha256) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_RACE");
    await assertSourceOnlyState(client, schema, manifest, prior.row_count);
    const inserted = await client.query(insertRowsSql(schema, rows.length), targetValues(rows));
    if (inserted.rowCount !== rows.length) fail("ANALYTICS_APPLIED_MAIN_DESTINATION_CONFLICT");
    await readTargetRows(client, schema, rows);
    const last = analyticsAppliedEventCursorFor(rows.at(-1));
    const count = (BigInt(prior.row_count) + BigInt(rows.length)).toString();
    const pages = prior.page_count + 1;
    const chain = checkpointChain(prior.prefix_chain_sha256, rows);
    await client.query(`UPDATE ${relation(schema, CHECKPOINTS)} SET last_source_id=$2,last_sequence=$3,
      row_count=$4,page_count=$5,prefix_chain_sha256=$6,updated_at=clock_timestamp() WHERE transfer_id=$1`,
    [transferId, last.sourceId, last.sequence, count, pages, chain]);
    await client.query(`UPDATE ${relation(schema, RUNS)} SET last_source_id=$2,last_sequence=$3 WHERE transfer_id=$1`,
      [transferId, last.sourceId, last.sequence]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail("ANALYTICS_APPLIED_MAIN_PAGE_COMMIT_FAILED");
  }
}

async function scanMainTarget(client, schema, pageSize) {
  const hash = sha256();
  let rowCount = 0n;
  let after = null;
  for (;;) {
    const result = after === null
      ? await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
          FROM ${relation(schema, MAIN_TABLE)} ORDER BY source_id COLLATE "C",sequence LIMIT $1`, [pageSize])
      : await client.query(`SELECT ${TARGET_COLUMNS.map(column => `"${column}"`).join(",")}
          FROM ${relation(schema, MAIN_TABLE)} WHERE source_id COLLATE "C">$1::text COLLATE "C"
             OR (source_id=$1 AND sequence>$2) ORDER BY source_id COLLATE "C",sequence LIMIT $3`,
        [after.sourceId, after.sequence, pageSize]);
    if (result.rows.length > pageSize) fail("ANALYTICS_APPLIED_MAIN_DESTINATION_PAGE_INVALID");
    for (const raw of result.rows) {
      let row;
      try { row = normalizeAnalyticsAppliedEventRow(raw); }
      catch { fail("ANALYTICS_APPLIED_MAIN_DESTINATION_MISMATCH"); }
      if (raw.projection_json !== null || normalizeInteger(raw.event_tuple_version) !== "1"
          || (after !== null && compareAnalyticsAppliedEventCursor(analyticsAppliedEventCursorFor(row), after) <= 0)) {
        fail("ANALYTICS_APPLIED_MAIN_DESTINATION_MISMATCH");
      }
      rowHash(hash, row);
      after = analyticsAppliedEventCursorFor(row);
      rowCount += 1n;
    }
    if (result.rows.length < pageSize) break;
  }
  return Object.freeze({ rowCount: rowCount.toString(), rowsSha256: hash.digest("hex"), last: after });
}

async function finalizeRun(client, schema, source, manifest, journalTransferId, transferId, pageSize) {
  await client.query("BEGIN");
  try {
    await assertSourceOnlyPreconditions(client, schema, source, manifest, journalTransferId, manifest.rowCount);
    const checkpoint = await readCheckpoint(client, schema, transferId);
    if (checkpoint.row_count !== manifest.rowCount || checkpoint.last_source_id !== (sourceCursor(manifest)?.sourceId ?? null)
        || checkpoint.last_sequence !== (sourceCursor(manifest)?.sequence ?? null)) {
      fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
    }
    await client.query(`UPDATE ${relation(schema, CHECKPOINTS)} SET complete=true,updated_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await client.query(`UPDATE ${relation(schema, RUNS)} SET status='complete',completed_at=clock_timestamp()
      WHERE transfer_id=$1`, [transferId]);
    await client.query("COMMIT");
    return checkpoint;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail("ANALYTICS_APPLIED_MAIN_FINALIZE_FAILED");
  }
}

function resultValue({ status, schema, manifest, journal, target, pageSize, postgresVersion, pagesCommitted, rowsInserted, resumed }) {
  return Object.freeze({
    schema: POSTGRES_ANALYTICS_APPLIED_MAIN_TRANSFER_SCHEMA,
    status,
    targetSchema: schema,
    postgresMajor: Math.floor(postgresVersion / 10_000),
    sourceSnapshotSha256: manifest.snapshotSha256,
    eventRows: manifest.rowCount,
    eventRowsSha256: manifest.rowsSha256,
    targetRows: target.rowCount,
    targetRowsSha256: target.rowsSha256,
    journalSnapshotSha256: journal.snapshotSha256,
    journalRows: journal.rowCount,
    journalRowsSha256: journal.rowsSha256,
    pageSize,
    pagesCommitted,
    rowsInserted,
    resumed,
    restartMode: "verify_exact_prefix_and_resume_after_last_sequence",
    mainAppliedEventsWritten: true,
    projectionJsonFabricated: false,
    analyticsCursorAdvanced: false,
    ownerStateWritten: false,
    publicationActivated: false,
    sourceNamespaceCrossArtifactCompared: false,
  });
}

/**
 * Source-only rehearsal that writes exact v1 D1 event tuples into PostgreSQL's
 * main receipt table. It requires a completed sealed ingestion-journal import
 * and proves exact tuple parity first. The journal artifact has no namespace
 * field: namespace is snapshot-bound in this run, while cross-artifact identity
 * is established by source_id and full tuple equality. No cursor, owner, or
 * publication state is advanced.
 */
export async function transferPostgresAnalyticsAppliedMain({
  source,
  destinationPool,
  targetSchema: rawSchema,
  transferId,
  journalTransferId,
  pageSize = POSTGRES_ANALYTICS_APPLIED_MAIN_DEFAULT_PAGE_SIZE,
} = {}) {
  const schema = schemaName(rawSchema);
  const size = validatePageSize(pageSize);
  if (!TRANSFER_ID.test(transferId ?? "")) fail("ANALYTICS_APPLIED_MAIN_TRANSFER_ID_INVALID");
  if (!JOURNAL_TRANSFER_ID.test(journalTransferId ?? "")) fail("ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_ID_INVALID");
  if (!destinationPool || typeof destinationPool.connect !== "function") fail("ANALYTICS_APPLIED_MAIN_DESTINATION_REQUIRED");
  const manifest = await readMainManifest(source, size);
  let client;
  try { client = await destinationPool.connect(); }
  catch { fail("ANALYTICS_APPLIED_MAIN_DESTINATION_UNAVAILABLE"); }
  let mainLock = false;
  let journalLock = false;
  try {
    const postgresVersion = await validateTarget(client, schema);
    await acquireLock(client, schema, "ingestion-journal-transfer", "ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_BUSY");
    journalLock = true;
    await acquireLock(client, schema, "analytics-applied-main-transfer", "ANALYTICS_APPLIED_MAIN_TRANSFER_BUSY");
    mainLock = true;
    await assertContained(client, schema);
    await assertNoAppliedEventTriggers(client, schema);
    await assertNoDownstreamAuthority(client, schema);
    await readSourceState(client, schema, manifest);
    const journal = await verifyJournalProof(client, schema, source, manifest, journalTransferId);
    const current = await client.query(`SELECT count(*)::text AS count FROM ${relation(schema, MAIN_TABLE)}`);
    const runTable = await client.query("SELECT to_regclass($1) AS relation", [`${schema}.${RUNS}`]);
    const existingRun = runTable.rows[0]?.relation
      ? await client.query(`SELECT 1 FROM ${relation(schema, RUNS)} WHERE transfer_id=$1`, [transferId])
      : { rowCount: 0 };
    if (existingRun.rowCount === 0 && current.rows[0]?.count !== "0") fail("ANALYTICS_APPLIED_MAIN_TARGET_NOT_EMPTY");
    if (existingRun.rowCount > 0 && current.rows[0]?.count === "0" && manifest.rowCount !== "0") {
      fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
    }
    await createTransferTables(client, schema);
    const opened = await beginRun({ client, schema, manifest, journal, transferId, pageSize: size });
    let checkpoint = await readCheckpoint(client, schema, transferId);
    await verifyCheckpoint({ client, schema, source, transferId, checkpoint, pageSize: size });
    if (opened.status === "complete" && checkpoint.complete) {
      const target = await scanMainTarget(client, schema, size);
      if (target.rowCount !== manifest.rowCount || target.rowsSha256 !== manifest.rowsSha256) {
        fail("ANALYTICS_APPLIED_MAIN_SOURCE_DESTINATION_PARITY_FAILED");
      }
      const latest = await readMainManifest(source, size);
      if (latest.snapshotSha256 !== manifest.snapshotSha256 || latest.sourceNamespaceSha256 !== manifest.sourceNamespaceSha256
          || latest.rowCount !== manifest.rowCount || latest.rowsSha256 !== manifest.rowsSha256) {
        fail("ANALYTICS_APPLIED_MAIN_SOURCE_CHANGED");
      }
      return resultValue({ status: "already_complete", schema, manifest, journal, target, pageSize: size,
        postgresVersion, pagesCommitted: 0, rowsInserted: "0", resumed: true });
    }
    let pagesCommitted = 0;
    let rowsInserted = 0n;
    let after = targetCursor(checkpoint);
    for (;;) {
      const rows = await readSealedAnalyticsAppliedEventPage(source, after, size);
      if (rows.length === 0) break;
      if (after && compareAnalyticsAppliedEventCursor(analyticsAppliedEventCursorFor(rows[0]), after) <= 0) {
        fail("ANALYTICS_APPLIED_MAIN_SOURCE_ORDER_INVALID");
      }
      const committed = await copyPage({ client, schema, manifest, transferId, prior: checkpoint, rows });
      if (committed) {
        pagesCommitted += 1;
        rowsInserted += BigInt(rows.length);
        after = analyticsAppliedEventCursorFor(rows.at(-1));
        checkpoint = await readCheckpoint(client, schema, transferId);
      }
      if (rows.length < size) break;
    }
    const currentManifest = await readMainManifest(source, size);
    if (currentManifest.snapshotSha256 !== manifest.snapshotSha256
        || currentManifest.sourceNamespaceSha256 !== manifest.sourceNamespaceSha256
        || currentManifest.rowCount !== manifest.rowCount || currentManifest.rowsSha256 !== manifest.rowsSha256) {
      fail("ANALYTICS_APPLIED_MAIN_SOURCE_CHANGED");
    }
    checkpoint = await readCheckpoint(client, schema, transferId);
    if (checkpoint.row_count !== manifest.rowCount) fail("ANALYTICS_APPLIED_MAIN_CHECKPOINT_INVALID");
    const target = await scanMainTarget(client, schema, size);
    if (target.rowCount !== manifest.rowCount || target.rowsSha256 !== manifest.rowsSha256) {
      fail("ANALYTICS_APPLIED_MAIN_SOURCE_DESTINATION_PARITY_FAILED");
    }
    await finalizeRun(client, schema, source, manifest, journalTransferId, transferId, size);
    return resultValue({ status: "synthetic_analytics_applied_main_transfer_complete", schema, manifest,
      journal, target, pageSize: size, postgresVersion, pagesCommitted, rowsInserted: rowsInserted.toString(),
      resumed: opened.resumed });
  } catch (error) {
    if (error instanceof PostgresAnalyticsAppliedMainTransferError) throw error;
    fail("ANALYTICS_APPLIED_MAIN_TRANSFER_FAILED");
  } finally {
    if (mainLock) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:analytics-applied-main-transfer`]).catch(() => {});
    if (journalLock) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`${schema}:ingestion-journal-transfer`]).catch(() => {});
    client?.release();
  }
}
