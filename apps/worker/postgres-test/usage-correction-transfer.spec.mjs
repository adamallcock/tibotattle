import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import {
  createSealedSqliteUsageCorrectionSource,
  POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS,
  runPostgresUsageCorrectionTransfer,
} from "../scripts/postgres-usage-correction-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";

function sqliteType(table, column) {
  if (table === "telemetry_usage_correction_runtime") {
    return ["schema_version", "method_version", "state"].includes(column) ? "TEXT" : "INTEGER";
  }
  if (table === "telemetry_usage_correction_history") {
    if (column === "participant_id") return "TEXT";
    if (["owner_digest", "occurrence_id", "source_chunk_digest", "source_event_digest",
      "record_digest", "base_digest"].includes(column)) return "BLOB";
  }
  return "INTEGER";
}

function correctionHistoryRow(id, suffix, participantId, ownerDigest) {
  const row = Object.fromEntries(POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS.telemetry_usage_correction_history
    .map(column => [column, null]));
  Object.assign(row, {
    id,
    participant_id: participantId,
    owner_digest: ownerDigest,
    owner_revision: 3,
    authority_epoch: 2,
    source_format: 10,
    namespace_id: 7,
    owner_id: 8,
    device_id: 9,
    chunk_id: 10,
    manifest_id: null,
    source_storage_row_id: 100 + suffix,
    source_row_id: 200 + suffix,
    occurrence_id: Buffer.from(`synthetic-occurrence-${suffix}`),
    event_time_ms: 1_790_000_000_000 + suffix,
    provider_id: 11,
    session_id: 12,
    model_id: 13,
    speed_mode_id: 14,
    api_service_tier_id: 15,
    surface_id: 16,
    billing_surface_id: 17,
    reasoning_effort_id: 18,
    agent_scope_id: 19,
    outcome_id: 20,
    attribution_id: null,
    total_input_context_tokens: 50 + suffix,
    input_uncached_tokens: 40 + suffix,
    input_cache_read_tokens: 10,
    input_cache_write_tokens: 0,
    output_text_tokens: 20,
    output_reasoning_tokens: null,
    output_combined_tokens: 20,
    source_chunk_digest: Buffer.alloc(32, 0x02),
    source_event_digest: Buffer.alloc(32, 0x03),
    record_digest: Buffer.alloc(32, 0x04 + suffix),
    base_digest: Buffer.alloc(32, 0x05),
    captured_at_ms: 1_790_000_100_000 + suffix,
  });
  return row;
}

async function sealedCorrectionSource({ participantId, ownerDigest }) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-usage-correction-pg17-"));
  const path = join(directory, "correction-source.sqlite");
  const database = new DatabaseSync(path);
  try {
    for (const [table, columns] of Object.entries(POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS)) {
      const definition = columns.map(column => `"${column}" ${sqliteType(table, column)}${column === "id" ? " PRIMARY KEY" : ""}`).join(",");
      database.exec(`CREATE TABLE "${table}" (${definition})`);
    }
    database.prepare(`INSERT INTO telemetry_usage_correction_runtime
      (id,schema_version,method_version,state,max_capture_rows,max_history_page)
      VALUES(1,'telemetry-usage-correction-v1','usage-total-correction-v1','active',200,200)`).run();
    const histories = [
      correctionHistoryRow(2, 1, participantId, ownerDigest),
      correctionHistoryRow(5, 2, participantId, ownerDigest),
      correctionHistoryRow(9, 3, participantId, ownerDigest),
    ];
    const historyColumns = POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS.telemetry_usage_correction_history;
    const insertHistory = database.prepare(`INSERT INTO telemetry_usage_correction_history
      (${historyColumns.map(column => `"${column}"`).join(",")})
      VALUES (${historyColumns.map(() => "?").join(",")})`);
    const integerColumns = new Set([
      "id", "owner_revision", "authority_epoch", "source_format", "namespace_id", "owner_id", "device_id",
      "chunk_id", "source_storage_row_id", "source_row_id", "event_time_ms", "provider_id", "session_id",
      "model_id", "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id",
      "reasoning_effort_id", "agent_scope_id", "outcome_id", "total_input_context_tokens",
      "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens",
      "output_reasoning_tokens", "output_combined_tokens", "captured_at_ms", "attribution_id",
    ]);
    for (const row of histories) {
      insertHistory.run(...historyColumns.map(column => row[column] === null ? null
        : integerColumns.has(column) ? BigInt(row[column]) : row[column]));
    }
    const insertFact = database.prepare(`INSERT INTO telemetry_usage_correction_facts
      (id,history_id,method_version,captured_at_ms) VALUES(?,?,1,?)`);
    histories.forEach((row, index) => insertFact.run(BigInt(41 + index), BigInt(row.id), BigInt(row.captured_at_ms)));
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const source = await createSealedSqliteUsageCorrectionSource({ path: await realpath(path), expectedSha256 });
  return { directory, source };
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

test("PG17 correction transfer stages active source state, seals parity receipts, and obeys erasure", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  const schema = `usage_correction_transfer_target_${randomBytes(6).toString("hex")}`;
  const participantId = `synthetic-correction-participant-${randomUUID()}`;
  const ownerDigest = randomBytes(32).toString("hex");
  const transferId = `synthetic-correction-${randomUUID()}`;
  let schemaCreated = false;
  let fixture;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.applied, applied.migrations.length);
    assert.ok(applied.migrations.some((migration) =>
      migration.name === "0034_usage_correction_history.sql"));
    assert.equal(applied.migrations.at(-1)?.name, "0068_v12_ready_manifest_ready_at_index.sql");
    const table = name => `"${schema}"."${name}"`;
    const createdAt = new Date().toISOString();
    await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES($1,$2)`, [participantId, createdAt]);
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
      VALUES($1,$2,'active')`, [participantId, ownerDigest]);
    fixture = await sealedCorrectionSource({ participantId, ownerDigest: Buffer.from(ownerDigest, "hex") });

    await pool.query(`ALTER TABLE ${table("telemetry_usage_correction_history")}
      ADD CONSTRAINT synthetic_interruption CHECK (id <> 5)`);
    await assert.rejects(runPostgresUsageCorrectionTransfer({
      source: fixture.source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    }), error => error?.code === "USAGE_CORRECTION_PAGE_COMMIT_FAILED");
    const interrupted = await pool.query(`SELECT table_name,last_id::text,row_count::text,complete
      FROM ${table("postgres_usage_correction_transfer_checkpoints")} WHERE transfer_id=$1 ORDER BY table_name`, [transferId]);
    assert.deepEqual(interrupted.rows, [
      { table_name: "telemetry_usage_correction_history", last_id: "2", row_count: "1", complete: false },
      { table_name: "telemetry_usage_correction_runtime", last_id: "1", row_count: "1", complete: true },
    ]);
    await pool.query(`ALTER TABLE ${table("telemetry_usage_correction_history")} DROP CONSTRAINT synthetic_interruption`);
    const result = await runPostgresUsageCorrectionTransfer({
      source: fixture.source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    });
    assert.equal(result.status, "staged_usage_correction_transfer_complete");
    assert.equal(result.sourceRuntimeState, "active");
    assert.equal(result.targetRuntimeState, "staged");
    assert.equal(result.capabilities.readerEnabled, false);
    assert.equal(result.capabilities.semanticReconstructionQualified, false);
    assert.equal(result.capabilities.productionCutoverAuthorized, false);
    assert.equal(result.pagesCommitted, 5);
    for (const tableName of ["telemetry_usage_correction_runtime", "telemetry_usage_correction_history",
      "telemetry_usage_correction_facts"]) {
      assert.equal(result.tables[tableName].sourceRows, result.tables[tableName].targetRows);
      assert.equal(result.tables[tableName].sourceSha256, result.tables[tableName].targetSha256);
    }
    const runtime = await pool.query(`SELECT state,source_state FROM ${table("telemetry_usage_correction_runtime")} WHERE id=1`);
    assert.deepEqual(runtime.rows[0], { state: "staged", source_state: "active" });
    const history = await pool.query(`SELECT id,source_storage_row_id,source_row_id,encode(record_digest,'hex') AS digest
      FROM ${table("telemetry_usage_correction_history")} ORDER BY id`);
    assert.deepEqual(history.rows.map(row => [Number(row.id), Number(row.source_storage_row_id), Number(row.source_row_id)]),
      [[2, 101, 201], [5, 102, 202], [9, 103, 203]]);
    const checkpoints = await pool.query(`SELECT count(*)::int AS count,bool_and(complete) AS complete
      FROM ${table("postgres_usage_correction_transfer_checkpoints")} WHERE transfer_id=$1`, [transferId]);
    assert.deepEqual(checkpoints.rows[0], { count: 3, complete: true });
    const tableReceipts = await pool.query(`SELECT count(*)::int AS count,bool_and(NOT semantic_reconstruction_qualified) AS archival_only
      FROM ${table("postgres_usage_correction_transfer_table_receipts")} WHERE transfer_id=$1`, [transferId]);
    assert.deepEqual(tableReceipts.rows[0], { count: 3, archival_only: true });

    await assert.rejects(pool.query(`DELETE FROM ${table("telemetry_usage_correction_history")} WHERE id=2`),
      error => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM ${table("telemetry_usage_correction_facts")} WHERE history_id=2`),
      error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE ${table("postgres_usage_correction_transfer_runs")}
      SET target_manifest_sha256=$2 WHERE transfer_id=$1`, [transferId, "a".repeat(64)]),
    error => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM ${table("postgres_usage_correction_transfer_runs")} WHERE transfer_id=$1`,
      [transferId]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE ${table("postgres_usage_correction_transfer_table_receipts")}
      SET source_row_count=source_row_count+1 WHERE transfer_id=$1`, [transferId]),
    error => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM ${table("postgres_usage_correction_transfer_table_receipts")} WHERE transfer_id=$1`,
      [transferId]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE ${table("postgres_usage_correction_transfer_checkpoints")}
      SET complete=false WHERE transfer_id=$1`, [transferId]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM ${table("postgres_usage_correction_transfer_checkpoints")} WHERE transfer_id=$1`,
      [transferId]), error => error?.code === "P1005");

    const resumed = await runPostgresUsageCorrectionTransfer({
      source: fixture.source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 2,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.pagesCommitted, 0);

    await pool.query(`DELETE FROM ${table("participants")} WHERE id=$1`, [participantId]);
    const erasedRows = await pool.query(`SELECT
        (SELECT count(*)::int FROM ${table("telemetry_usage_correction_history")}) AS history,
        (SELECT count(*)::int FROM ${table("telemetry_usage_correction_facts")}) AS facts,
        (SELECT count(*)::int FROM ${table("storage_owner_erasure_receipts")} WHERE owner_digest=$1) AS receipt`,
    [ownerDigest]);
    assert.deepEqual(erasedRows.rows[0], { history: 0, facts: 0, receipt: 1 });
  } finally {
    fixture?.source.close();
    if (fixture) await rm(fixture.directory, { recursive: true, force: true });
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});
