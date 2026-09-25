import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSealedSqliteUsageCorrectionSource,
  POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS,
  runPostgresUsageCorrectionTransfer,
} from "./postgres-usage-correction-transfer.mjs";

function sourceType(table, column) {
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

function historyRow(id, suffix) {
  const row = Object.fromEntries(POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS.telemetry_usage_correction_history
    .map(column => [column, null]));
  Object.assign(row, {
    id,
    participant_id: "synthetic-participant",
    owner_digest: Buffer.alloc(32, 0x01),
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

async function makeSealedSource() {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-usage-correction-source-"));
  const path = join(await realpath(directory), "correction-source.sqlite");
  const database = new DatabaseSync(path);
  try {
    for (const [table, columns] of Object.entries(POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS)) {
      const declaration = columns.map(column => `"${column}" ${sourceType(table, column)}${column === "id" ? " PRIMARY KEY" : ""}`).join(",");
      database.exec(`CREATE TABLE "${table}" (${declaration})`);
    }
    database.prepare(`INSERT INTO telemetry_usage_correction_runtime
      (id,schema_version,method_version,state,max_capture_rows,max_history_page)
      VALUES(1,'telemetry-usage-correction-v1','usage-total-correction-v1','active',200,200)`).run();
    const histories = [historyRow(2, 1), historyRow(5, 2), historyRow(9, 3)];
    const historyColumns = POSTGRES_USAGE_CORRECTION_SOURCE_COLUMNS.telemetry_usage_correction_history;
    const insertHistory = database.prepare(`INSERT INTO telemetry_usage_correction_history
      (${historyColumns.map(column => `"${column}"`).join(",")})
      VALUES (${historyColumns.map(() => "?").join(",")})`);
    for (const row of histories) insertHistory.run(...historyColumns.map(column => {
      const value = row[column];
      return value === null || value === undefined ? null
        : ["id", "owner_revision", "authority_epoch", "source_format", "namespace_id", "owner_id", "device_id",
          "chunk_id", "source_storage_row_id", "source_row_id", "event_time_ms", "provider_id", "session_id",
          "model_id", "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id",
          "reasoning_effort_id", "agent_scope_id", "outcome_id", "total_input_context_tokens",
          "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens",
          "output_reasoning_tokens", "output_combined_tokens", "captured_at_ms", "attribution_id"].includes(column)
          ? BigInt(value) : value;
    }));
    const insertFact = database.prepare(`INSERT INTO telemetry_usage_correction_facts
      (id,history_id,method_version,captured_at_ms) VALUES(?,?,1,?)`);
    histories.forEach((row, index) => insertFact.run(BigInt(41 + index), BigInt(row.id), BigInt(row.captured_at_ms)));
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path, expectedSha256 };
}

test("sealed correction source uses bounded keyset pages past page one", async () => {
  const fixture = await makeSealedSource();
  let source;
  try {
    source = await createSealedSqliteUsageCorrectionSource(fixture);
    const first = await source.listPage({ table: "telemetry_usage_correction_history", after: null, limit: 2 });
    const second = await source.listPage({ table: "telemetry_usage_correction_history", after: first.rows.at(-1).id, limit: 2 });
    assert.deepEqual(first.rows.map(row => row.id), ["2", "5"]);
    assert.deepEqual(second.rows.map(row => row.id), ["9"]);
    assert.deepEqual((await source.listPage({ table: "telemetry_usage_correction_history", after: "9", limit: 2 })).rows, []);
    assert.equal((await source.listPage({ table: "telemetry_usage_correction_runtime", limit: 1 })).rows[0].state, "active");
    assert.equal((await source.verifySnapshot()).artifactSha256, fixture.expectedSha256);
    await assert.rejects(source.listPage({ table: "telemetry_usage_correction_history", after: "-1", limit: 2 }), {
      code: "USAGE_CORRECTION_CURSOR_INVALID",
    });
    await assert.rejects(source.listPage({ table: "participants", after: null, limit: 1 }), {
      code: "USAGE_CORRECTION_TABLE_INVALID",
    });
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("correction importer refuses caller-built unsealed source descriptors", async () => {
  await assert.rejects(runPostgresUsageCorrectionTransfer({
    source: {
      snapshot: { kind: "sealed-sqlite-rehearsal", immutable: true,
        artifactSha256: "a".repeat(64), snapshotId: `sha256:${"a".repeat(64)}` },
      async verifySnapshot() { return this.snapshot; },
      async listPage() { return { rows: [] }; },
    },
    destinationPool: {},
    targetSchema: "usage_correction_transfer_target_synthetic",
    transferId: "synthetic-run",
  }), { code: "USAGE_CORRECTION_SEALED_SOURCE_REQUIRED" });
});

test("correction importer rejects page sizes above its bounded maximum", async () => {
  await assert.rejects(runPostgresUsageCorrectionTransfer({
    source: {}, destinationPool: {}, targetSchema: "usage_correction_transfer_target_synthetic",
    transferId: "synthetic-run", pageSize: 201,
  }), { code: "USAGE_CORRECTION_PAGE_SIZE_INVALID" });
});
