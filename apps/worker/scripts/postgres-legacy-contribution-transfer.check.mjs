import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readCutoverSeal } from "./cutover-source-seal.mjs";
import {
  LEGACY_CONTRIBUTIONS_ORDER,
  LEGACY_CONTRIBUTIONS_STAGE,
  LEGACY_MUST_BE_EMPTY,
  LEGACY_TRANSFER_COLUMN_MAP,
  LEGACY_TRANSFER_DISPOSITIONS,
  LEGACY_TRANSFER_MAX_PAGE_BYTES,
  LEGACY_TRANSFER_MAX_PAGE_ROWS,
  LEGACY_TRIGGER_POLICY,
  LegacyContributionTransferError,
  OPERATIONAL_HISTORY_STAGE,
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  PENDING_OBJECT_TRANSFER_HOLD_GUARD,
  PENDING_OBJECT_TRANSFER_HOLD_TABLE,
  PENDING_REGISTRATIONS_PREREQUISITE_STAGES,
  PENDING_REGISTRATIONS_STAGE,
  PRODUCTION_RETAINED_RELATIONS,
  PRODUCTION_STAGING_RELATIONS,
  TRIGGER_POLICY,
  checkPendingObjectTransferGuard,
  legacyContributionPolicySha256,
  legacySourceValue,
  runLegacyContributionsProduction,
  runOperationalHistoryProduction,
  runPendingRegistrationsProduction,
} from "./postgres-legacy-contribution-transfer.mjs";
import { PostgresTransferTargetError, TRANSFER_STAGES } from "./postgres-transfer-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { Q1_INGESTION_DUMP } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// D-PT4X contract checks without a database: the frozen column maps, order,
// dispositions and trigger policy; the canonical value codec; every sealed-
// source refusal (each fires before the runner touches its target: an
// unregistered handle is only reached once every sealed-source check has
// passed); and the source pins tying the E-PT4 guard to the reconciler and the
// staged migrations. The PostgreSQL acceptance lives in
// postgres-test/postgres-legacy-contribution-transfer.spec.mjs.
// Run: node --test ./scripts/postgres-legacy-contribution-transfer.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A reviewed change to the order, column maps, trigger policy, dispositions,
// prerequisites or the exclusion filter must update this pin.
const POLICY_SHA256 = "5f8200b0f281791d0737267a1ff960048d9c2a42f724c78f24b40c88fe12e2f3";
const DISPOSITION = /^(?:(?:imported|mapped|claimed-by):[a-z][a-z0-9]*(?:-[a-z0-9]+)*|verified-equal|must-be-empty|schema-marker|source-machinery|runtime-reset|edge-retained|not-transferred-expiring|target-missing)$/u;
let world;
let seal;
let manifestPath;

const isCode = code => error => (error instanceof LegacyContributionTransferError
  || error instanceof PostgresTransferTargetError) && error.code === code;
const RUNNERS = Object.freeze([runLegacyContributionsProduction, runPendingRegistrationsProduction,
  runOperationalHistoryProduction]);

before(async () => {
  world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
  const run = await sealWorld(world);
  const result = await run.run();
  manifestPath = outputPathsOf(run.out).manifest;
  seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
});

after(async () => {
  await world?.dispose();
});

test("the stages, order, dispositions and trigger policy are frozen and pinned", () => {
  assert.equal(legacyContributionPolicySha256(), POLICY_SHA256);
  for (const stage of [LEGACY_CONTRIBUTIONS_STAGE, PENDING_REGISTRATIONS_STAGE, OPERATIONAL_HISTORY_STAGE,
    ...PENDING_REGISTRATIONS_PREREQUISITE_STAGES]) {
    assert.ok(TRANSFER_STAGES.includes(stage), stage);
  }
  // PT-8-lite's order: the pending registrations come after every telemetry stage that maps chunk-owned rows.
  for (const prerequisite of PENDING_REGISTRATIONS_PREREQUISITE_STAGES) {
    assert.ok(TRANSFER_STAGES.indexOf(prerequisite) < TRANSFER_STAGES.indexOf(PENDING_REGISTRATIONS_STAGE), prerequisite);
  }
  assert.deepEqual(LEGACY_CONTRIBUTIONS_ORDER, ["telemetry_contributions", "telemetry_records",
    "telemetry_contribution_occurrences", "telemetry_contribution_admission_windows", "telemetry_v1_chunk_admission_windows"]);
  assert.deepEqual(LEGACY_MUST_BE_EMPTY, ["contributions"]);
  for (const [table, entry] of Object.entries(LEGACY_TRANSFER_DISPOSITIONS)) {
    assert.match(entry.token, DISPOSITION, table);
    assert.ok(TRANSFER_STAGES.includes(entry.stage), table);
    assert.ok(Object.hasOwn(LEGACY_TRANSFER_COLUMN_MAP, table), table);
  }
  assert.equal(LEGACY_TRANSFER_DISPOSITIONS.pending_quarantine_objects.token, "mapped:pending-registrations");
  assert.equal(LEGACY_TRANSFER_DISPOSITIONS.community_aggregate_exclusions.token, "imported:community-aggregate-exclusions");
  for (const [tableName, triggers] of Object.entries(LEGACY_TRIGGER_POLICY)) {
    for (const [trigger, entry] of Object.entries(triggers)) {
      assert.ok(["fire", "suppress"].includes(entry.policy), `${tableName}.${trigger}`);
      assert.ok(entry.reason.length > 0 && entry.reason.length <= 240, `${tableName}.${trigger}`);
    }
  }
  const suppressed = Object.entries(LEGACY_TRIGGER_POLICY).flatMap(([tableName, triggers]) =>
    Object.entries(triggers).filter(([, entry]) => entry.policy === "suppress").map(([trigger]) => `${tableName}.${trigger}`)).sort();
  assert.deepEqual(suppressed, [
    "telemetry_contributions.telemetry_contributions_enforce_admission_window",
    "telemetry_contributions.telemetry_contributions_record_admission_window",
    "telemetry_contributions.telemetry_retained_source_revision",
    "telemetry_records.telemetry_retained_record_source_revision",
  ]);
  assert.equal(TRIGGER_POLICY, LEGACY_TRIGGER_POLICY);
  assert.deepEqual([PRODUCTION_STAGING_RELATIONS, PRODUCTION_RETAINED_RELATIONS], [[], []]);
});

test("the column maps are closed over the d43c8f92 D1 schema", async () => {
  const dump = JSON.parse(await readFile(Q1_INGESTION_DUMP, "utf8"));
  const database = new DatabaseSync(":memory:");
  try {
    for (const entry of dump.schema.filter(item => item.type === "table")) database.exec(entry.sql);
    for (const [name, mapped] of Object.entries(LEGACY_TRANSFER_COLUMN_MAP)) {
      const columns = database.prepare(`PRAGMA table_xinfo("${name}")`).all().filter(column => column.hidden === 0)
        .map(column => column.name).sort();
      assert.ok(columns.length > 0, `${name} exists at d43c8f92`);
      if (name === "contributions") continue;
      assert.deepEqual([...mapped.columns.map(([source]) => source)].sort(), columns, name);
    }
  } finally {
    database.close();
  }
});

test("the codec canonicalizes reals, decimals, JSON and instants and refuses anything it cannot round-trip", () => {
  assert.deepEqual(legacySourceValue("real", 0.1, "t", "c"), ["0.1", "0.1"]);
  assert.deepEqual(legacySourceValue("real", 1e-7, "t", "c"), ["1e-7", "1e-7"]);
  assert.deepEqual(legacySourceValue("real", 7n, "t", "c"), ["7", "7"]);
  assert.deepEqual(legacySourceValue("decimal", "12.50", "t", "c"), ["12.50", "12.50"]);
  assert.deepEqual(legacySourceValue("json", `{ "b": [2, {"d":1,"c":0}], "a": 1.0 }`, "t", "c"),
    [`{"a":1,"b":[2,{"c":0,"d":1}]}`, `{ "b": [2, {"d":1,"c":0}], "a": 1.0 }`]);
  assert.deepEqual(legacySourceValue("instant", "2026-09-01T10:00:00Z", "t", "c"),
    ["2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"]);
  assert.deepEqual(legacySourceValue("instant-key", "2026-09-01T10:00:00.000Z", "t", "c"),
    ["2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"]);
  assert.deepEqual(legacySourceValue("decimal", null, "t", "c"), [null, null]);
  for (const [type, value] of [["real", Number.NaN], ["real", Infinity], ["real", "1"], ["decimal", "1e-3"],
    ["decimal", "-1"], ["decimal", ".5"], ["decimal", "01"], ["decimal", 1], ["json", "{"], ["json", "\"\0\""],
    ["instant", "2026-09-01 10:00:00"], ["instant", "2026-09-01T10:00:00.123456Z"],
    ["instant-key", "2026-09-01T10:00:00Z"], ["text", 3], ["int", 1.5]]) {
    assert.throws(() => legacySourceValue(type, value, "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"),
      `${type} ${String(value)}`);
  }
});

test("arguments are closed: pages at most 256 rows and 4 MiB, a handle, a hook function and known owner flags", async () => {
  const handle = { sealManifestSha256: seal.manifest.sealId };
  for (const run of RUNNERS) {
    for (const options of [{ pageRows: LEGACY_TRANSFER_MAX_PAGE_ROWS + 1 }, { pageRows: 0 },
      { pageBytes: LEGACY_TRANSFER_MAX_PAGE_BYTES + 1 }, { pageBytes: 10 }, { onPage: "kill" }, { handle: null }]) {
      await assert.rejects(run({ handle, sealManifestPath: manifestPath, ...options }),
        isCode("CUTOVER_LEGACY_ARGUMENT_INVALID"), `${run.name} ${JSON.stringify(Object.keys(options))}`);
    }
    await assert.rejects(run({ handle: { sealManifestSha256: "0".repeat(64) }, sealManifestPath: manifestPath }),
      error => error?.code === "CUTOVER_SEAL_MANIFEST_INVALID", run.name);
  }
  for (const ownerFlags of [["accept-everything"], "x", [OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
    OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING]]) {
    await assert.rejects(runPendingRegistrationsProduction({ handle, sealManifestPath: manifestPath, ownerFlags }),
      isCode("CUTOVER_LEGACY_ARGUMENT_INVALID"));
    await assert.rejects(checkPendingObjectTransferGuard(handle, { ownerFlags }), isCode("CUTOVER_LEGACY_ARGUMENT_INVALID"));
  }
  // A clean seal passes every source check and only then meets the target:
  // the unregistered handle is refused by PT-1 (no database was reached).
  for (const run of RUNNERS) {
    await assert.rejects(run({ handle, sealManifestPath: manifestPath }), isCode("CUTOVER_TARGET_HANDLE_INVALID"), run.name);
  }
  await assert.rejects(checkPendingObjectTransferGuard(handle), isCode("CUTOVER_TARGET_HANDLE_INVALID"));
});

test("every sealed-source refusal fires before the target is touched", async () => {
  const participant = world.fixture.ids.participant;
  const instant = new Date(world.fixture.nowMs).toISOString();
  const cases = [
    [runLegacyContributionsProduction, `DROP TRIGGER IF EXISTS contributions_require_consuming_upload;
      DROP TRIGGER IF EXISTS contributions_consume_session_upload; DROP TRIGGER IF EXISTS contributions_consume_device_upload;
      DROP TRIGGER IF EXISTS contributions_require_social_owner; DROP TRIGGER IF EXISTS contributions_require_active_participant;
      DROP TRIGGER IF EXISTS contributions_clear_pending_quarantine; DROP TRIGGER IF EXISTS contributions_block_reconciling_quarantine;
      INSERT INTO contributions (id, participant_id, envelope_digest, r2_key, envelope_schema_version, key_id, status,
        fixture_id, range_start, range_end, quota_window_minutes, quota_used_percent_before, quota_used_percent_after,
        quota_display_precision, model_id, subscription_speed, api_tier_assumption, input_uncached_tokens,
        input_cached_tokens, output_text_tokens, output_reasoning_tokens, web_search_calls, unknown_tool_units,
        estimated_api_cost_usd, priced_event_coverage_percent, unknown_billable_units, price_basis, created_at)
      VALUES ('${randomUUID()}', '${participant}', 'e', 'synthetic/${randomUUID()}', 'v', 'k', 'accepted_synthetic', 'f',
        '${instant}', '${instant}', 300, 1, 2, 0, 'm', 's', 'a', 1, 0, 1, 0, 0, 0, '0.01', 100, 0, 'b', '${instant}')`,
    "CUTOVER_TABLE_TARGET_MISSING"],
    [runLegacyContributionsProduction, "DROP TABLE contributions", "CUTOVER_SOURCE_TABLE_MISSING"],
    [runLegacyContributionsProduction, "ALTER TABLE telemetry_records ADD COLUMN synthetic_extra TEXT", "CUTOVER_COLUMN_UNMAPPED"],
    [runLegacyContributionsProduction, "ALTER TABLE telemetry_contribution_occurrences DROP COLUMN policy_epoch",
      "CUTOVER_COLUMN_UNMAPPED"],
    [runLegacyContributionsProduction, `INSERT INTO telemetry_contribution_admission_windows
        (participant_id, window_started_at, accepted_count, last_accepted_at)
      VALUES ('${participant}', '2026-07-27T00:00:00Z', 1, '${instant}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runLegacyContributionsProduction, `DROP TRIGGER IF EXISTS storage_legacy_telemetry_records_insert;
      INSERT INTO telemetry_records (participant_id, record_kind, occurrence_id, observed_at, estimated_api_cost_usd, record_json)
      VALUES ('${participant}', 'usage', 'o-1', '${instant}', '1e-3', '{}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runLegacyContributionsProduction, `DROP TRIGGER IF EXISTS storage_legacy_telemetry_records_insert;
      INSERT INTO telemetry_records (participant_id, record_kind, occurrence_id, observed_at, record_json)
      VALUES ('${participant}', 'usage', 'o-2', '${instant}', '{not json')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runPendingRegistrationsProduction, `PRAGMA ignore_check_constraints = ON;
      INSERT INTO pending_quarantine_objects (r2_key, contribution_id, object_kind, registered_at)
      VALUES ('telemetry/${randomUUID()}', '${randomUUID()}', 'synthetic', '${instant}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runPendingRegistrationsProduction, `PRAGMA ignore_check_constraints = ON;
      INSERT INTO pending_quarantine_objects (r2_key, contribution_id, object_kind, registered_at, reconciliation_state)
      VALUES ('telemetry/${randomUUID()}', '${randomUUID()}', 'telemetry', '${instant}', 'deleting')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runPendingRegistrationsProduction, "ALTER TABLE pending_quarantine_objects ADD COLUMN synthetic_extra TEXT",
      "CUTOVER_COLUMN_UNMAPPED"],
    [runOperationalHistoryProduction, `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
      VALUES ('${instant}', '{"participantsTotal":-1}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runOperationalHistoryProduction, `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
      VALUES ('${instant}', '{"participantsTotal":{"nested":1}}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runOperationalHistoryProduction, `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
      VALUES ('${instant.slice(0, 19)}Z', '{"participantsTotal":1}')`, "CUTOVER_SOURCE_VALUE_INVALID"],
    [runOperationalHistoryProduction, "DELETE FROM storage_source_state", "CUTOVER_SOURCE_SINGLETON_INVALID"],
    [runOperationalHistoryProduction, `INSERT INTO community_aggregate_exclusions (exclusion_id, participant_id, scope,
        reason_code, state, effective_at, created_at, created_by_digest)
      VALUES ('x', '${participant}', 'community_weekly', 'other', 'active', 'soon', '${instant}', '${"a".repeat(64)}')`,
    "CUTOVER_SOURCE_VALUE_INVALID"],
  ];
  for (const [run, sql, code] of cases) {
    const forged = await forgeVariantSeal(seal, sql);
    await assert.rejects(run({ handle: { sealManifestSha256: forged.sealId }, sealManifestPath: forged.manifestPath }),
      isCode(code), `${run.name}: ${sql.slice(0, 80)}`);
  }
  // An invalid cache contributes nothing and is reported; it is not a refusal.
  const forged = await forgeVariantSeal(seal, `INSERT INTO admin_metrics_history_cache (singleton, generated_at, payload_json)
    VALUES (1, '${instant}', '{"schemaVersion":"admin-metrics-history-v0.2","gauges":{"snapshots":[]}}')`);
  await assert.rejects(runOperationalHistoryProduction({ handle: { sealManifestSha256: forged.sealId },
    sealManifestPath: forged.manifestPath }), isCode("CUTOVER_TARGET_HANDLE_INVALID"));
});

test("the E-PT4 guard is pinned to the reconciler and the staged migrations", async () => {
  const reconciler = await readFile(join(WORKER_ROOT, "src", "postgres-quarantine-reconciliation.ts"), "utf8");
  assert.match(reconciler, new RegExp(`POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE = "${PENDING_OBJECT_TRANSFER_HOLD_TABLE}"`, "u"));
  // The due-row scan excludes held keys, and the claim re-checks under its row lock.
  const dueRows = reconciler.slice(reconciler.indexOf("async function dueRows("), reconciler.indexOf("async function claimObject("));
  assert.match(dueRows, /const unheld = holds \? `AND \$\{unheldSql\(schema, "pending\.object_key"\)\}` : "";/u);
  assert.match(dueRows, /\n\s+\$\{unheld\}\n\s+ORDER BY pending\.registered_at/u);
  const claim = reconciler.slice(reconciler.indexOf("async function claimObject("), reconciler.indexOf("async function clearDeletedObject("));
  assert.match(claim, /if \(holds && await isTransferHeld\(client, schema, current\.object_key\)\)/u);
  assert.match(reconciler, /hold\.object_key = \$\{keyExpression\} AND hold\.released_at IS NULL/u);
  const staged = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
  const promoted = join(WORKER_ROOT, "postgres", "migrations", "primary");
  const find = async suffix => {
    for (const directory of [staged, promoted]) {
      let names = [];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const name = names.find(candidate => candidate.endsWith(suffix));
      if (name !== undefined) return readFile(join(directory, name), "utf8");
    }
    return assert.fail(`${suffix} is neither staged nor promoted`);
  };
  const holds = await find("_pending_object_transfer_holds.sql");
  assert.match(holds, new RegExp(`CREATE TABLE ${PENDING_OBJECT_TRANSFER_HOLD_TABLE} \\(`, "u"));
  assert.match(holds, new RegExp(`CREATE TRIGGER ${PENDING_OBJECT_TRANSFER_HOLD_GUARD}\\s+BEFORE UPDATE OR DELETE`, "u"));
  assert.match(holds, new RegExp(`EXECUTE FUNCTION ${PENDING_OBJECT_TRANSFER_HOLD_GUARD}\\(\\)`, "u"));
  const exclusions = await find("_community_aggregate_exclusions.sql");
  assert.match(exclusions, /CREATE TABLE community_aggregate_exclusions \(/u);
  for (const trigger of Object.keys(LEGACY_TRIGGER_POLICY.community_aggregate_exclusions)) {
    assert.match(exclusions, new RegExp(`CREATE TRIGGER ${trigger}\\b`, "u"));
  }
  for (const sql of [holds, exclusions]) {
    assert.doesNotMatch(sql, /\bGRANT\b/u);
    for (const match of sql.matchAll(/CREATE FUNCTION [a-z_]+\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql([^$]*)\$\$/gu)) {
      assert.match(match[1], /SET search_path FROM CURRENT/u);
    }
  }
});
