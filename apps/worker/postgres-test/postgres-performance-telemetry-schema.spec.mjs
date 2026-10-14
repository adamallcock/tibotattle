// PostgreSQL 17 spec for primary 0079_performance_telemetry.sql: the
// accountless performance intake schema and the community publication heads.
//
// Every schema is built through the production runner on the promoted
// primary chain (applyPostgresMigrations), which ends at 0079; the
// pre-migration case uses promoted-migration-prefix.mjs. Fixtures come from
// postgres-test/fixtures/performance-telemetry.mjs and are synthetic and
// content-free. Each test drops only the schemas it created (prefix g1_perf_).
//
// It proves the runtime guard (including that only an audit row opened by the
// activating transaction itself is accepted), that the runtime role cannot
// write the dictionary registry, the grant revision/epoch rules and their
// race, the capability and report head fences, the receipt-to-report tie, the
// label and bucket CHECKs, the delete guards and participant cascade, the
// refusal counters, the DateStyle-stable lock keys the triggers call, the
// forward-only publication heads, and that every new function pins its
// search_path.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test postgres-test/postgres-performance-telemetry-schema.spec.mjs
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import * as telemetryContract from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { PRODUCTION_MIGRATIONS_CODE_PREFIX } from "../cloud-run/postgres-production-migrations.mjs";
import { grantAndVerifyRuntimePrivileges } from "../cloud-run/postgres-runtime-grants.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  PERFORMANCE_DICTIONARY_REGISTRY,
  PERFORMANCE_FIXTURE_DURATION_EDGES_MS,
  PERFORMANCE_FIXTURE_SPEED_EDGES_V1,
  PERFORMANCE_FIXTURE_SPEED_EDGES_V2,
  PERFORMANCE_INTAKE_ROUTE_IDS,
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  beginPerformanceActivationAudit,
  ensurePerformanceFixtureKernel,
  insertPerformanceGrant,
  insertPerformancePublicationHead,
  insertPerformanceReport,
  performanceFixtureMaxBucket,
  performanceInstant,
  performanceTable,
  seedPerformanceAccountlessOwner,
  seedPerformanceV12DayManifest,
  slidePerformanceOwnerLease,
  syntheticCommunityModelPerformancePayload,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

const NEW_TABLES = Object.freeze([
  "accountless_telemetry_performance_authorizations",
  "analytics_v2_published_performance",
  "telemetry_performance_buckets",
  "telemetry_performance_cohorts",
  "telemetry_performance_device_capabilities",
  "telemetry_performance_field_dictionaries",
  "telemetry_performance_receipts",
  "telemetry_performance_refusal_counts",
  "telemetry_performance_reports",
  "telemetry_performance_runtime",
]);
const DAY = "2026-10-09";

let pool;
let vite;
let modules;
const created = [];

after(async () => {
  if (pool) {
    for (const schema of created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

async function setup() {
  if (pool) return;
  pool = new pg.Pool({ ...endpoint, max: 8, application_name: "g1-performance-schema", connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  modules = {
    receipt: await vite.ssrLoadModule("/src/postgres-schema-receipt.ts"),
    runtime: await vite.ssrLoadModule("/src/postgres-runtime-schema.ts"),
  };
}

async function newSchemaName(label) {
  await setup();
  const schema = `g1_perf_${label}_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  return schema;
}

/** A schema on the full promoted chain; asserts it ends at 0079. */
async function promotedSchema(label) {
  const schema = await newSchemaName(label);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME);
  return schema;
}

/** An active runtime, a seeded owner and (optionally) its first grant. */
async function activeOwner(schema, { grant = true, fieldDictionaryVersion = PERFORMANCE_DICTIONARY_2026_09_29,
  dictionaryBasis, leaseMs } = {}) {
  const owner = await seedPerformanceAccountlessOwner(pool, { schema, ...(leaseMs === undefined ? {} : { leaseMs }) });
  if (!grant) return { owner };
  const basis = dictionaryBasis ?? (fieldDictionaryVersion === PERFORMANCE_DICTIONARY_2026_10_10
    ? "client_declared" : "v12_parser_inference");
  const tuple = await insertPerformanceGrant(pool, { schema, owner, fieldDictionaryVersion, dictionaryBasis: basis });
  return { owner, grant: tuple };
}

async function rejects(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${error?.code} ${error?.message}`);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

async function count(schema, table, where = "TRUE", values = []) {
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${performanceTable(schema, table)} WHERE ${where}`, values);
  return result.rows[0].n;
}

async function withClient(run) {
  const client = await pool.connect();
  try { return await run(client); } finally { client.release(); }
}

// No database: the shared fixture's records are what later items rebuild and
// re-parse, so each one must satisfy the telemetry contract under its own
// dictionary. A contract without dictionary adapters (before SPD-G0) parses
// under its single v1 vocabulary; v2 records are then checked with their
// scheme relabelled v1 wherever every bucket lies on the shared v1 edges.
test("fixtures: synthetic records pass the telemetry contract under their dictionary; edges equal the contract's", (t) => {
  const contract = telemetryContract;
  const dictionaryAware = typeof contract.PERFORMANCE_FIELD_DICTIONARIES === "object"
    && contract.PERFORMANCE_FIELD_DICTIONARIES !== null;
  const v2Aware = Array.isArray(contract.SPEED_BUCKET_UPPER_CENTI_TPS_V2);
  assert.equal(dictionaryAware, v2Aware, "dictionary adapters and the v2 speed edges arrive together");
  assert.deepEqual(PERFORMANCE_FIXTURE_SPEED_EDGES_V1, [...contract.SPEED_BUCKET_UPPER_CENTI_TPS]);
  assert.deepEqual(PERFORMANCE_FIXTURE_DURATION_EDGES_MS, [...contract.TTFT_BUCKET_UPPER_MS]);
  assert.deepEqual(PERFORMANCE_FIXTURE_DURATION_EDGES_MS, [...contract.TURN_DURATION_BUCKET_UPPER_MS]);
  if (v2Aware) assert.deepEqual(PERFORMANCE_FIXTURE_SPEED_EDGES_V2, [...contract.SPEED_BUCKET_UPPER_CENTI_TPS_V2]);
  const v1 = "performance-histogram-v1";
  const relabelV1 = (record) => ({ ...record, bucketSchemeVersion: v1,
    ...Object.fromEntries(["speedHistogram", "ttftHistogram", "completionHistogram"]
      .map((field) => [field, { ...record[field], schemaVersion: v1 }])) });
  let parsed = 0;
  let relabelled = 0;
  const parse = (record, dictionary) => {
    const scheme = PERFORMANCE_DICTIONARY_REGISTRY[dictionary].bucketSchemeVersion;
    if (dictionaryAware) return contract.parseTelemetryPerformanceRecord(record, dictionary);
    if (scheme === v1) return contract.parseTelemetryPerformanceRecord(record);
    if (Object.keys(record.speedHistogram.buckets).every((key) => Number(key) < PERFORMANCE_FIXTURE_SPEED_EDGES_V1.length)) {
      relabelled += 1;
      return contract.parseTelemetryPerformanceRecord(relabelV1(record));
    }
    return null;
  };
  const valid = (dictionary, fields) => {
    const record = syntheticPerformanceRecord({ day: DAY, fieldDictionaryVersion: dictionary, ...fields });
    if (parse(record, dictionary) !== null) parsed += 1;
  };
  for (const dictionary of Object.keys(PERFORMANCE_DICTIONARY_REGISTRY)) {
    const scheme = PERFORMANCE_DICTIONARY_REGISTRY[dictionary].bucketSchemeVersion;
    for (let speedBucket = 0; speedBucket <= performanceFixtureMaxBucket(scheme, "speed"); speedBucket += 1) {
      for (const turns of [1, 3]) valid(dictionary, { speedBucket, turns });
    }
    for (const ms of [0, 1, 499, 500, 900, 12_000, 1_000_000, 1_000_000_000]) {
      valid(dictionary, { ttftMs: ms, turnDurationMs: Math.max(1, ms) });
    }
    valid(dictionary, {});
    valid(dictionary, { speedMethod: "unavailable" });
    valid(dictionary, { speedMode: "fast", speedModeSource: "turn_context_service_tier", apiServiceTier: "priority" });
    valid(dictionary, { speedMode: "other", reasoningEffort: "high" });
    if (PERFORMANCE_DICTIONARY_REGISTRY[dictionary].ultrafastLabels) {
      valid(dictionary, { speedMode: "ultrafast", apiServiceTier: "ultrafast" });
    }
    // A mode/source mismatch is never contract-valid.
    assert.throws(() => parse(syntheticPerformanceRecord({ day: DAY, fieldDictionaryVersion: dictionary,
      speedMode: "unknown", speedModeSource: "rollout_thread_settings" }), dictionary),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  }
  // 2026-09-21.1 has no Ultrafast labels: those fixture records exist only to prove the database refuses them.
  if (dictionaryAware) {
    for (const fields of [{ speedMode: "ultrafast" }, { apiServiceTier: "ultrafast" }]) {
      assert.throws(() => parse(syntheticPerformanceRecord({ day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21,
        ...fields }), PERFORMANCE_DICTIONARY_2026_09_21), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
    }
  }
  assert.ok(parsed >= 2 * 61 + 2 * 61, `parsed ${parsed}`);
  if (!v2Aware) {
    assert.ok(relabelled >= 2 * 60, `relabelled ${relabelled}`);
    t.diagnostic(`v2 records checked with their scheme relabelled v1 (${relabelled}); the v2-only speed buckets `
      + "60..95 validate once the contract exports the v2 scheme (SPD-G0)");
  }
});

test("0079 is the promoted tail: a pre-0079 schema lacks it and is not current; new functions pin search_path", {
  skip, timeout: 240_000,
}, async () => {
  const before = await newSchemaName("prefix");
  const prefix = await applyMigrationsBefore({ role: "primary", schema: before, pool, name: PERFORMANCE_MIGRATION_NAME });
  assert.equal(prefix.target.version, 79);
  assert.equal(prefix.applied, 78);
  const full = await promotedSchema("full");
  const expected = modules.runtime.POSTGRES_RUNTIME_MIGRATIONS.primary;
  assert.equal(expected.length, 79);
  assert.equal(expected.at(-1).name, PERFORMANCE_MIGRATION_NAME);
  for (const table of NEW_TABLES) {
    const absent = await pool.query("SELECT to_regclass($1)::text AS name", [performanceTable(before, table)]);
    assert.equal(absent.rows[0].name, null, `${table} is absent before 0079`);
    const present = await pool.query("SELECT to_regclass($1)::text AS name", [performanceTable(full, table)]);
    assert.notEqual(present.rows[0].name, null, `${table} exists after 0079`);
  }
  await withClient(async (client) => {
    assert.equal(await modules.receipt.readSchemaReceipt(client, { schema: before, expected }), "receipt_mismatch");
    assert.equal(await modules.receipt.readSchemaReceipt(client, { schema: full, expected }), "current");
  });

  // Exactly the reviewed relations are new; the draft's community_model_performance_* never exist.
  const tables = async (schema) => new Set((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schema])).rows.map((row) => row.table_name));
  const [beforeTables, fullTables] = [await tables(before), await tables(full)];
  assert.deepEqual([...fullTables].filter((name) => !beforeTables.has(name)).sort(), [...NEW_TABLES]);
  assert.equal([...fullTables].some((name) => name.startsWith("community_model_performance")), false);
  // No new analytics_v2_% table holds an owner digest (out of the offline-purge inventory).
  const newAnalytics = [...fullTables].filter((name) => name.startsWith("analytics_v2_") && !beforeTables.has(name));
  assert.deepEqual(newAnalytics, ["analytics_v2_published_performance"]);
  const ownerColumns = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
        AND column_name IN ('owner_digest', 'participant_id', 'device_id', 'enrollment_device_id')`,
  [full, [...newAnalytics, "telemetry_performance_refusal_counts"]]);
  assert.deepEqual(ownerColumns.rows, []);

  // Every new function is plpgsql and pins its search_path.
  const functions = async (schema) => new Map((await pool.query(`SELECT p.proname, l.lanname, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = $1`, [schema])).rows.map((row) => [row.proname, row]));
  const [beforeFunctions, fullFunctions] = [await functions(before), await functions(full)];
  const added = [...fullFunctions.values()].filter((row) => !beforeFunctions.has(row.proname));
  assert.deepEqual(added.map((row) => row.proname).sort(), [
    "accountless_telemetry_performance_authorization_admission",
    "accountless_telemetry_performance_authorization_immutable",
    "analytics_v2_published_performance_forward_only",
    "telemetry_performance_capability_admission",
    "telemetry_performance_capability_immutable",
    "telemetry_performance_capability_lock_key",
    "telemetry_performance_delete_guard",
    "telemetry_performance_grant_lock_key",
    "telemetry_performance_report_admission",
    "telemetry_performance_report_immutable",
    "telemetry_performance_report_lock_key",
    "telemetry_performance_row_immutable",
    "telemetry_performance_runtime_guard",
  ]);
  // The same pinned search_path as the chain's earlier functions (the runner's).
  const reference = fullFunctions.get("analytics_v2_published_daily_forward_only").proconfig;
  assert.equal(reference.length, 1);
  assert.match(reference[0], /^search_path=/u);
  for (const row of added) {
    assert.equal(row.lanname, "plpgsql", row.proname);
    assert.deepEqual(row.proconfig, reference, row.proname);
  }

  // Seeds: three immutable dictionaries, a staged runtime at revision 1, no heads.
  const dictionaries = await pool.query(`SELECT field_dictionary_version, bucket_scheme_version, ultrafast_labels
      FROM ${performanceTable(full, "telemetry_performance_field_dictionaries")} ORDER BY field_dictionary_version`);
  assert.deepEqual(dictionaries.rows, [
    { field_dictionary_version: PERFORMANCE_DICTIONARY_2026_09_21, bucket_scheme_version: "performance-histogram-v1", ultrafast_labels: false },
    { field_dictionary_version: PERFORMANCE_DICTIONARY_2026_09_29, bucket_scheme_version: "performance-histogram-v1", ultrafast_labels: true },
    { field_dictionary_version: PERFORMANCE_DICTIONARY_2026_10_10, bucket_scheme_version: "performance-histogram-v2", ultrafast_labels: true },
  ]);
  await rejects(pool.query(`UPDATE ${performanceTable(full, "telemetry_performance_field_dictionaries")}
    SET ultrafast_labels = true WHERE field_dictionary_version = $1`, [PERFORMANCE_DICTIONARY_2026_09_21]),
  "P1005", "telemetry_performance_row_immutable");
  await rejects(pool.query(`DELETE FROM ${performanceTable(full, "telemetry_performance_field_dictionaries")}`),
    "P1005", "telemetry_performance_row_immutable");
  await rejects(pool.query(`INSERT INTO ${performanceTable(full, "telemetry_performance_field_dictionaries")}
      (field_dictionary_version, bucket_scheme_version, ultrafast_labels, registered_at)
    VALUES ('telemetry-performance-registry-2027-01-01.1', 'performance-histogram-v2', true, now())`),
  "P1005", "telemetry_performance_row_immutable");
  const runtime = await pool.query(`SELECT state, policy_revision FROM ${performanceTable(full, "telemetry_performance_runtime")}`);
  assert.deepEqual(runtime.rows, [{ state: "staged", policy_revision: 1 }]);
  assert.equal(await count(full, "analytics_v2_published_performance"), 0);
  // No index was added to telemetry_v12_day_manifests.
  const manifestIndexes = async (schema) => (await pool.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'telemetry_v12_day_manifests' ORDER BY indexname`, [schema])).rows;
  assert.deepEqual(await manifestIndexes(full), await manifestIndexes(before));
});

test("runtime: staged refuses intake; the guard allows exactly staged -> active through the audit and GUC", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("runtime");
  const t = (name) => performanceTable(schema, name);
  const owner = await seedPerformanceAccountlessOwner(pool, { schema });
  // Staged: the grant, a capability and a report are each refused.
  await rejects(insertPerformanceGrant(pool, { schema, owner, withCapability: false }),
    "P1005", "accountless_telemetry_performance_authorization_unavailable");
  await rejects(pool.query(`INSERT INTO ${t("telemetry_performance_device_capabilities")} (participant_id, device_id,
      schema_version, field_dictionary_version, dictionary_basis, privacy_contract_version, scope, capability_revision,
      authority_epoch, issued_at, expires_at, state, consented_at)
    VALUES ($1, $2, 'model-performance-daily-v1', $3, 'v12_parser_inference', 'privacy-safe-model-performance-v1',
      'model-performance-daily', 1, 1, now(), $4::timestamptz, 'accepted', now())`,
  [owner.participantId, owner.deviceId, PERFORMANCE_DICTIONARY_2026_09_29, owner.expiresAt]),
  "P1005", "telemetry_performance_capability_unavailable");
  await rejects(insertPerformanceReport(pool, { schema, owner, reportDay: DAY, withReceipt: false,
    grant: { capabilityRevision: 1, authorityEpoch: 1, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29 } }),
  "P1005", "telemetry_performance_report_admission_denied");

  const update = (client, { revision = "policy_revision + 1", state = "'active'" } = {}) => client.query(
    `UPDATE ${t("telemetry_performance_runtime")} SET state = ${state}, policy_revision = ${revision},
       updated_at = now() WHERE id = 1`);
  // No GUC, a GUC naming no audit row, and a GUC naming a finished row are refused.
  await rejects(update(pool), "P1005", "telemetry_performance_runtime_guarded");
  const inTransaction = (run) => withClient(async (client) => {
    await client.query("BEGIN");
    try { return await run(client); } finally { await client.query("ROLLBACK"); }
  });
  await rejects(inTransaction(async (client) => {
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [randomUUID()]);
    await update(client);
  }), "P1005", "telemetry_performance_runtime_guarded");
  await rejects(inTransaction(async (client) => {
    const operationId = await beginPerformanceActivationAudit(client, { schema });
    await client.query(`UPDATE ${t("admin_action_audit")} SET outcome = 'success' WHERE operation_id = $1`, [operationId]);
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
    await update(client);
  }), "P1005", "telemetry_performance_runtime_guarded");
  // A 'started' row from an earlier transaction (a crashed activation left it
  // behind) is never accepted, even with the GUC naming it; nor is one begun
  // inside a savepoint, whose xmin is a subtransaction's.
  const stale = await beginPerformanceActivationAudit(pool, { schema });
  await rejects(inTransaction(async (client) => {
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [stale]);
    await update(client);
  }), "P1005", "telemetry_performance_runtime_guarded");
  await rejects(inTransaction(async (client) => {
    await client.query("SAVEPOINT audit_in_subtransaction");
    const operationId = await beginPerformanceActivationAudit(client, { schema });
    await client.query("RELEASE SAVEPOINT audit_in_subtransaction");
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
    await update(client);
  }), "P1005", "telemetry_performance_runtime_guarded");
  assert.equal(await count(schema, "admin_action_audit", "operation_id = $1 AND outcome = 'started'", [stale]), 1);
  // With a started audit: a skipped revision, a non-advancing instant and a staged target are refused.
  for (const variant of [{ revision: "policy_revision + 2" }, { revision: "policy_revision" }, { state: "'staged'" }]) {
    await rejects(inTransaction(async (client) => {
      const operationId = await beginPerformanceActivationAudit(client, { schema });
      await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
      await update(client, variant);
    }), "P1005", "telemetry_performance_runtime_guarded");
  }
  await rejects(inTransaction(async (client) => {
    const operationId = await beginPerformanceActivationAudit(client, { schema });
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
    await client.query(`UPDATE ${t("telemetry_performance_runtime")} SET state = 'active',
      policy_revision = policy_revision + 1, updated_at = updated_at WHERE id = 1`);
  }), "P1005", "telemetry_performance_runtime_guarded");
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_runtime")} SET state = 'paused'`),
    "P1005", "telemetry_performance_runtime_guarded");
  await rejects(pool.query(`DELETE FROM ${t("telemetry_performance_runtime")}`), "P1005", "telemetry_performance_runtime_guarded");
  assert.deepEqual((await pool.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "staged", policy_revision: 1 }]);

  // The audited path activates once; nothing moves it again.
  const activation = await activatePerformanceRuntime(pool, { schema });
  assert.equal(activation.policyRevision, 2);
  assert.deepEqual((await pool.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "active", policy_revision: 2 }]);
  await rejects(activatePerformanceRuntime(pool, { schema }), "P1005", "telemetry_performance_runtime_guarded");
  await rejects(pool.query(`DELETE FROM ${t("telemetry_performance_runtime")}`), "P1005", "telemetry_performance_runtime_guarded");
  // Active: the same owner is now granted.
  const tuple = await insertPerformanceGrant(pool, { schema, owner });
  assert.deepEqual([tuple.capabilityRevision, tuple.authorityEpoch], [1, 1]);
});

test("grants: revision/epoch 1/1, 2/1 on an expiry slide, 3/2 after revocation; basis pairing CHECKs", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("grants");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  let { owner, grant } = await activeOwner(schema);
  assert.deepEqual([grant.capabilityRevision, grant.authorityEpoch], [1, 1]);
  // A grant whose expiry is not the owner's, or a repeated or skipped tuple, is refused.
  await rejects(insertPerformanceGrant(pool, { schema, owner: { ...owner, expiresAt: performanceInstant(Date.parse(owner.expiresAt) - 1) } }),
    "P1005", "accountless_telemetry_performance_authorization_unavailable");
  await rejects(insertPerformanceGrant(pool, { schema, owner, capabilityRevision: 1, authorityEpoch: 1 }),
    "P1005", "accountless_telemetry_performance_authorization_revision_conflict");
  await rejects(insertPerformanceGrant(pool, { schema, owner, capabilityRevision: 3, authorityEpoch: 1 }),
    "P1005", "accountless_telemetry_performance_authorization_revision_conflict");
  await rejects(insertPerformanceGrant(pool, { schema, owner, capabilityRevision: 2, authorityEpoch: 2 }),
    "P1005", "accountless_telemetry_performance_authorization_revision_conflict");

  // Expiry slide: revision 2, same epoch.
  owner = await slidePerformanceOwnerLease(pool, { schema, owner, expiresAtEpoch: Date.parse(owner.expiresAt) + 86_400_000 });
  grant = await insertPerformanceGrant(pool, { schema, owner });
  assert.deepEqual([grant.capabilityRevision, grant.authorityEpoch], [2, 1]);

  // Rows are immutable; revocation needs a revoked enrollment.
  await rejects(pool.query(`UPDATE ${t("accountless_telemetry_performance_authorizations")}
    SET field_dictionary_version = $2 WHERE enrollment_device_id = $1 AND capability_revision = 2`,
  [owner.enrollmentDeviceId, PERFORMANCE_DICTIONARY_2026_09_21]), "P1005", "accountless_telemetry_performance_authorization_immutable");
  const revoke = () => pool.query(`UPDATE ${t("accountless_telemetry_performance_authorizations")}
      SET state = 'revoked', revoked_at = now(), revocation_reason = 'security_reset'
    WHERE enrollment_device_id = $1 AND capability_revision = 2`, [owner.enrollmentDeviceId]);
  await rejects(revoke(), "P1005", "accountless_telemetry_performance_authorization_immutable");
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'revoked', revoked_at = now(),
    revocation_reason = 'security_reset' WHERE device_id = $1`, [owner.enrollmentDeviceId]);
  await revoke();
  await rejects(pool.query(`UPDATE ${t("accountless_telemetry_performance_authorizations")}
      SET state = 'active', revoked_at = NULL, revocation_reason = NULL
    WHERE enrollment_device_id = $1 AND capability_revision = 2`, [owner.enrollmentDeviceId]),
  "P1005", "accountless_telemetry_performance_authorization_immutable");
  await pool.query(`UPDATE ${t("telemetry_performance_device_capabilities")} SET state = 'revoked', revoked_at = now()
    WHERE participant_id = $1 AND device_id = $2 AND capability_revision = 2`, [owner.participantId, owner.deviceId]);
  // While the enrollment is revoked, nothing is granted.
  await rejects(insertPerformanceGrant(pool, { schema, owner }), "P1005", "accountless_telemetry_performance_authorization_unavailable");
  // A synthetic re-enrollment of the same installation: revision 3, a new epoch.
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'active', revoked_at = NULL,
    revocation_reason = NULL WHERE device_id = $1`, [owner.enrollmentDeviceId]);
  await rejects(insertPerformanceGrant(pool, { schema, owner, capabilityRevision: 3, authorityEpoch: 1 }),
    "P1005", "accountless_telemetry_performance_authorization_revision_conflict");
  grant = await insertPerformanceGrant(pool, { schema, owner });
  assert.deepEqual([grant.capabilityRevision, grant.authorityEpoch], [3, 2]);
  const heads = await pool.query(`SELECT capability_revision, authority_epoch, state
      FROM ${t("accountless_telemetry_performance_authorizations")} WHERE enrollment_device_id = $1
     ORDER BY capability_revision`, [owner.enrollmentDeviceId]);
  assert.deepEqual(heads.rows.map((row) => [row.capability_revision, row.authority_epoch, row.state]),
    [[1, 1, "active"], [2, 1, "revoked"], [3, 2, "active"]]);

  // Basis pairing: v1 with inference or the no-manifest default, v2 with a declaration.
  const insertRaw = (fresh, schemaVersion, dictionary, basis) => pool.query(
    `INSERT INTO ${t("accountless_telemetry_performance_authorizations")} (enrollment_device_id, participant_id,
       device_credential_id, schema_version, policy_version, authorization_basis, performance_schema_version,
       field_dictionary_version, dictionary_basis, privacy_contract_version, scope, capability_revision,
       authority_epoch, authorized_at, expires_at, state)
     VALUES ($1, $2, $1, $3, 'accountless-telemetry-performance-policy-v1', 'accountless-performance-policy-v1',
       'model-performance-daily-v1', $4, $5, 'privacy-safe-model-performance-v1', 'model-performance-daily', 1, 1,
       now(), $6::timestamptz, 'active')`,
    [fresh.enrollmentDeviceId, fresh.participantId, schemaVersion, dictionary, basis, fresh.expiresAt]);
  const fresh = await seedPerformanceAccountlessOwner(pool, { schema });
  for (const [schemaVersion, dictionary, basis] of [
    ["accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_09_29, "client_declared"],
    ["accountless-performance-owner-v2", PERFORMANCE_DICTIONARY_2026_09_29, "v12_parser_inference"],
    ["accountless-performance-owner-v2", PERFORMANCE_DICTIONARY_2026_09_29, "default_no_manifest"],
    ["accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_10_10, "v12_parser_inference"],
    ["accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_09_21, "default_no_manifest"],
    ["accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_09_29, "unknown_basis"],
    ["accountless-performance-owner-v3", PERFORMANCE_DICTIONARY_2026_09_29, "client_declared"],
  ]) await rejects(insertRaw(fresh, schemaVersion, dictionary, basis), "23514");
  await rejects(insertRaw(fresh, "accountless-performance-owner-v2", "telemetry-performance-registry-2027-01-01.1", "client_declared"), "23503");
  for (const [schemaVersion, dictionary, basis] of [
    ["accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_09_29, "default_no_manifest"],
  ]) await insertRaw(fresh, schemaVersion, dictionary, basis);
  const declared = await seedPerformanceAccountlessOwner(pool, { schema });
  await insertRaw(declared, "accountless-performance-owner-v2", PERFORMANCE_DICTIONARY_2026_10_10, "client_declared");
  const inferred = await seedPerformanceAccountlessOwner(pool, { schema });
  await insertRaw(inferred, "accountless-performance-owner-v1", PERFORMANCE_DICTIONARY_2026_09_21, "v12_parser_inference");
  // A signed-in (social) device is never granted.
  await pool.query(`UPDATE ${t("participants")} SET owner_kind = 'social' WHERE id = $1`, [owner.participantId]);
  owner = await slidePerformanceOwnerLease(pool, { schema, owner, expiresAtEpoch: Date.parse(owner.expiresAt) + 1_000 });
  await rejects(insertPerformanceGrant(pool, { schema, owner, withCapability: false }),
    "P1005", "accountless_telemetry_performance_authorization_unavailable");
});

test("grants: two connections racing for the first tuple yield one winner", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("race");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  const owner = await seedPerformanceAccountlessOwner(pool, { schema });
  const insert = (client) => client.query(`INSERT INTO ${t("accountless_telemetry_performance_authorizations")} (
      enrollment_device_id, participant_id, device_credential_id, schema_version, policy_version, authorization_basis,
      performance_schema_version, field_dictionary_version, dictionary_basis, privacy_contract_version, scope,
      capability_revision, authority_epoch, authorized_at, expires_at, state)
    VALUES ($1, $2, $1, 'accountless-performance-owner-v1', 'accountless-telemetry-performance-policy-v1',
      'accountless-performance-policy-v1', 'model-performance-daily-v1', $3, 'v12_parser_inference',
      'privacy-safe-model-performance-v1', 'model-performance-daily', 1, 1, now(), $4::timestamptz, 'active')`,
  [owner.enrollmentDeviceId, owner.participantId, PERFORMANCE_DICTIONARY_2026_09_29, owner.expiresAt]);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    await insert(first);
    const racing = insert(second).then(() => "inserted", (error) => error);
    // The second insert waits on the grant's advisory lock until the first commits.
    let waiting = false;
    for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
      const locks = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      waiting = locks.rows[0].n > 0;
      if (!waiting) await sleep(20);
    }
    assert.equal(waiting, true, "the racing insert waits on the advisory lock");
    await first.query("COMMIT");
    const outcome = await racing;
    assert.equal(outcome?.code, "P1005");
    assert.equal(outcome.message, "accountless_telemetry_performance_authorization_revision_conflict");
    await second.query("ROLLBACK");
  } finally {
    first.release();
    second.release();
  }
  assert.equal(await count(schema, "accountless_telemetry_performance_authorizations", "enrollment_device_id = $1",
    [owner.enrollmentDeviceId]), 1);
});

test("heads: the capability equals the grant tuple; the report equals the capability head; order and one current row", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("heads");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  const { owner } = await activeOwner(schema, { grant: false });
  // A grant without capability, then capabilities that disagree with it.
  const first = await insertPerformanceGrant(pool, { schema, owner, withCapability: false });
  const capability = (overrides = {}) => {
    const row = { revision: 1, epoch: 1, dictionary: PERFORMANCE_DICTIONARY_2026_09_29, basis: "v12_parser_inference",
      expiresAt: owner.expiresAt, state: "accepted", ...overrides };
    return pool.query(`INSERT INTO ${t("telemetry_performance_device_capabilities")} (participant_id, device_id,
        schema_version, field_dictionary_version, dictionary_basis, privacy_contract_version, scope, capability_revision,
        authority_epoch, issued_at, expires_at, state, consented_at, revoked_at)
      VALUES ($1, $2, 'model-performance-daily-v1', $3, $4, 'privacy-safe-model-performance-v1', 'model-performance-daily',
        $5, $6, now(), $7::timestamptz, $8, now(), CASE WHEN $8 = 'revoked' THEN now() END)`,
    [owner.participantId, owner.deviceId, row.dictionary, row.basis, row.revision, row.epoch, row.expiresAt, row.state]);
  };
  for (const overrides of [
    { dictionary: PERFORMANCE_DICTIONARY_2026_09_21 },
    { basis: "default_no_manifest" },
    { expiresAt: performanceInstant(Date.parse(owner.expiresAt) - 1) },
    { state: "revoked" },
  ]) await rejects(capability(overrides), "P1005", "telemetry_performance_capability_unavailable");
  await rejects(capability({ revision: 2 }), "P1005", "telemetry_performance_capability_revision_conflict");
  await capability();
  const tuple1 = { ...first };
  // Signed-in owner kinds are refused as capabilities too.
  const social = await seedPerformanceAccountlessOwner(pool, { schema });
  await pool.query(`UPDATE ${t("participants")} SET owner_kind = 'social' WHERE id = $1`, [social.participantId]);
  await rejects(insertPerformanceGrant(pool, { schema, owner: social }),
    "P1005", "accountless_telemetry_performance_authorization_unavailable");

  // Reports: the dictionary must be the capability head's.
  const record = syntheticPerformanceRecord({ day: DAY });
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21 }), "P1005", "telemetry_performance_report_admission_denied");
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: { ...tuple1, capabilityRevision: 2 }, reportDay: DAY,
    records: [record] }), "P1005", "telemetry_performance_report_admission_denied");
  const accepted = await insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    sourceRevision: 5 });
  assert.equal(accepted.outcome, "accepted");
  // Source revisions only move forward per device/day.
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    sourceRevision: 4, supersedeCurrent: false }), "P1005", "telemetry_performance_report_revision_conflict");
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    sourceRevision: 5, sourceDigest: "e".repeat(64), supersedeCurrent: false }),
  "P1005", "telemetry_performance_report_revision_conflict");
  // One current row per device-day: a newer source must supersede first.
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    sourceRevision: 6, supersedeCurrent: false }), "23505");
  const replaced = await insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: DAY, records: [record],
    sourceRevision: 6 });
  assert.equal(replaced.outcome, "replaced");
  const states = await pool.query(`SELECT id, state FROM ${t("telemetry_performance_reports")}
    WHERE participant_id = $1 ORDER BY source_revision`, [owner.participantId]);
  assert.deepEqual(states.rows.map((row) => row.state), ["superseded", "current"]);
  // Only current -> superseded: no revival, no rewrite of a superseded or current row.
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_reports")} SET state = 'current', superseded_at = NULL
    WHERE id = $1`, [accepted.reportId]), "P1005", "telemetry_performance_report_immutable");
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_reports")} SET record_count = 2 WHERE id = $1`,
    [replaced.reportId]), "P1005", "telemetry_performance_report_immutable");
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_cohorts")} SET turns = 9 WHERE report_id = $1`,
    [replaced.reportId]), "P1005", "telemetry_performance_row_immutable");
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_buckets")} SET bucket_count = 9 WHERE report_id = $1`,
    [replaced.reportId]), "P1005", "telemetry_performance_row_immutable");
  await rejects(pool.query(`UPDATE ${t("telemetry_performance_receipts")} SET outcome = 'accepted' WHERE report_id = $1`,
    [replaced.reportId]), "P1005", "telemetry_performance_row_immutable");

  // A newer grant makes the older heads stale: the old tuple's report and a
  // capability for the old authorization revision are refused.
  const second = await insertPerformanceGrant(pool, { schema, owner, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10,
    dictionaryBasis: "client_declared" });
  assert.deepEqual([second.capabilityRevision, second.authorityEpoch], [2, 1]);
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: tuple1, reportDay: "2026-10-08", records: [record] }),
    "P1005", "telemetry_performance_report_admission_denied");
  // The same day, under the declared v2 dictionary and a higher source revision, ends with one current row.
  const v2Record = syntheticPerformanceRecord({ day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10,
    speedBucket: 95 });
  await insertPerformanceReport(pool, { schema, owner, grant: second, reportDay: DAY, records: [v2Record], sourceRevision: 7 });
  assert.equal(await count(schema, "telemetry_performance_reports", "participant_id = $1 AND state = 'current'",
    [owner.participantId]), 1);
  const scheme = await pool.query(`SELECT field_dictionary_version, bucket_scheme_version FROM ${t("telemetry_performance_reports")}
    WHERE participant_id = $1 AND state = 'current'`, [owner.participantId]);
  assert.deepEqual(scheme.rows, [{ field_dictionary_version: PERFORMANCE_DICTIONARY_2026_10_10,
    bucket_scheme_version: "performance-histogram-v2" }]);
  // The report's scheme must be its dictionary's (registry composite FK).
  await rejects(insertPerformanceReport(pool, { schema, owner, grant: second, reportDay: "2026-10-07", records: [],
    bucketSchemeVersion: "performance-histogram-v1" }), "23503");
  // A zero-record report is a valid day tombstone.
  await insertPerformanceReport(pool, { schema, owner, grant: second, reportDay: "2026-10-06", records: [] });

  // The acceptance-instant index serves max(created_at) from one index entry.
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(`EXPLAIN (FORMAT JSON) SELECT max(created_at) FROM ${t("telemetry_performance_receipts")}`);
      const text = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
      assert.match(text, /"Index Name":"telemetry_performance_receipts_accepted_at"/u);
      assert.match(text, /"Scan Direction":"Backward"/u);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("heads: expired grant and capability heads are refused", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("expiry");
  await activatePerformanceRuntime(pool, { schema });
  const owner = await seedPerformanceAccountlessOwner(pool, { schema, issuedAtEpoch: Date.now() - 60_000, leaseMs: 62_500 });
  const grant = await insertPerformanceGrant(pool, { schema, owner });
  await sleep(Math.max(0, Date.parse(owner.expiresAt) - Date.now()) + 300);
  await rejects(insertPerformanceReport(pool, { schema, owner, grant, reportDay: DAY,
    records: [syntheticPerformanceRecord({ day: DAY })] }), "P1005", "telemetry_performance_report_admission_denied");
  await rejects(insertPerformanceGrant(pool, { schema, owner }),
    "P1005", "accountless_telemetry_performance_authorization_unavailable");
  // A manifest seeded for inference does not change admission.
  await seedPerformanceV12DayManifest(pool, { schema, owner, chunkDay: DAY, parserVersion: "unified-rollout-typed-v20" });
  assert.equal(await count(schema, "telemetry_performance_reports"), 0);
});

test("labels and buckets: 2026-09-21.1 refuses Ultrafast and accepts turn_context_service_tier; bucket ranges per scheme", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("labels");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  const old = await activeOwner(schema, { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21 });
  const day = (index) => `2026-10-0${index}`;
  await rejects(insertPerformanceReport(pool, { ...old, schema, reportDay: day(1), records: [syntheticPerformanceRecord({
    day: day(1), fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21, speedMode: "ultrafast" })] }), "23514");
  await rejects(insertPerformanceReport(pool, { ...old, schema, reportDay: day(1), records: [syntheticPerformanceRecord({
    day: day(1), fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21, apiServiceTier: "ultrafast" })] }), "23514");
  const accepted = await insertPerformanceReport(pool, { ...old, schema, reportDay: day(1), records: [
    syntheticPerformanceRecord({ day: day(1), fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21,
      speedModeSource: "turn_context_service_tier", speedMode: "fast", apiServiceTier: "priority" }),
    syntheticPerformanceRecord({ day: day(1), fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21,
      speedMode: "other", reasoningEffort: "high" }),
  ] });
  // Under 2026-09-29.1 the same Ultrafast labels are accepted.
  const current = await activeOwner(schema, { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29 });
  await insertPerformanceReport(pool, { ...current, schema, reportDay: day(1), records: [syntheticPerformanceRecord({
    day: day(1), speedMode: "ultrafast", apiServiceTier: "ultrafast" })] });
  // A mode/source mismatch is refused under every dictionary.
  await rejects(insertPerformanceReport(pool, { ...current, schema, reportDay: day(2), records: [syntheticPerformanceRecord({
    day: day(2), speedMode: "unknown", speedModeSource: "rollout_thread_settings" })] }), "23514");

  const bucket = (reportId, scheme, metric, index) => pool.query(`INSERT INTO ${t("telemetry_performance_buckets")}
      (report_id, cohort_index, bucket_scheme_version, metric, bucket_index, bucket_count) VALUES ($1, 0, $2, $3, $4, 1)`,
  [reportId, scheme, metric, index]);
  // v1: speed 0..60; 61 refused.
  await bucket(accepted.reportId, "performance-histogram-v1", "speed", 60);
  await rejects(bucket(accepted.reportId, "performance-histogram-v1", "speed", 61), "23514");
  await rejects(bucket(accepted.reportId, "performance-histogram-v1", "ttft", 58), "23514");
  await bucket(accepted.reportId, "performance-histogram-v1", "ttft", 0);
  await rejects(bucket(accepted.reportId, "performance-histogram-v1", "turnDuration", 0), "23514");
  await bucket(accepted.reportId, "performance-histogram-v1", "turnDuration", 57);
  // A v2 bucket on a v1 cohort: refused by the scheme foreign key.
  await rejects(bucket(accepted.reportId, "performance-histogram-v2", "speed", 70), "23503");
  // v2: speed 95 accepted, 96 refused.
  const v2 = await activeOwner(schema, { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10 });
  const v2Report = await insertPerformanceReport(pool, { ...v2, schema, reportDay: day(1), records: [syntheticPerformanceRecord({
    day: day(1), fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10, speedBucket: 61 })] });
  await bucket(v2Report.reportId, "performance-histogram-v2", "speed", 95);
  await rejects(bucket(v2Report.reportId, "performance-histogram-v2", "speed", 96), "23514");
  await rejects(bucket(v2Report.reportId, "performance-histogram-v1", "speed", 10), "23503");
  // A cohort whose scheme disagrees with its report is refused by the report foreign key.
  await rejects(pool.query(`INSERT INTO ${t("telemetry_performance_cohorts")} (report_id, cohort_index,
      field_dictionary_version, bucket_scheme_version, provider, model_id, reasoning_effort, speed_method, speed_mode,
      speed_mode_source, api_service_tier, turns, speed_turns, ttft_turns, completion_turns, timed_responses,
      speed_tokens, speed_duration_ms)
    VALUES ($1, 5, $2, 'performance-histogram-v1', 'openai_codex', 'gpt-5.5', 'low', 'unavailable', 'standard',
      'rollout_thread_settings', 'standard', 1, 0, 0, 0, 0, 0, 0)`, [v2Report.reportId, PERFORMANCE_DICTIONARY_2026_10_10]),
  "23503");
});

test("dictionaries: the runtime role cannot insert, update or delete registry rows", {
  skip, timeout: 240_000,
}, async () => {
  const schema = await promotedSchema("dictionary_role");
  const t = (name) => performanceTable(schema, name);
  const role = `g1_perf_runtime_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  try {
    // The migrate job's grant policy: DML on every table, the registry included.
    await grantAndVerifyRuntimePrivileges(pool, { role: "primary", schema, runtimeRole: role,
      codePrefix: PRODUCTION_MIGRATIONS_CODE_PREFIX });
    const privileges = await pool.query(`SELECT has_table_privilege($1, $2, 'INSERT') AS can_insert,
        has_table_privilege($1, $2, 'UPDATE') AS can_update, has_table_privilege($1, $2, 'DELETE') AS can_delete`,
    [role, t("telemetry_performance_field_dictionaries")]);
    assert.deepEqual(privileges.rows, [{ can_insert: true, can_update: true, can_delete: true }]);
    const asRuntime = (sql, values = []) => withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE "${role}"`);
        const result = await client.query(sql, values);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    // The role does write ordinary rows (control), but never a registry row.
    await asRuntime(`INSERT INTO ${t("telemetry_performance_refusal_counts")} (day, route_id, code, status, refusals)
      VALUES ($1::date, 'telemetry_performance_reports', 'BODY_INVALID', 400, 1)`, [DAY]);
    for (const [dictionary, scheme] of [
      ["telemetry-performance-registry-2027-01-01.1", "performance-histogram-v2"],
      ["telemetry-performance-registry-2026-10-10.2", "performance-histogram-v1"],
    ]) {
      await rejects(asRuntime(`INSERT INTO ${t("telemetry_performance_field_dictionaries")}
          (field_dictionary_version, bucket_scheme_version, ultrafast_labels, registered_at) VALUES ($1, $2, true, now())`,
      [dictionary, scheme]), "P1005", "telemetry_performance_row_immutable");
    }
    await rejects(asRuntime(`UPDATE ${t("telemetry_performance_field_dictionaries")} SET ultrafast_labels = NOT ultrafast_labels`),
      "P1005", "telemetry_performance_row_immutable");
    await rejects(asRuntime(`DELETE FROM ${t("telemetry_performance_field_dictionaries")} WHERE field_dictionary_version = $1`,
      [PERFORMANCE_DICTIONARY_2026_09_21]), "P1005", "telemetry_performance_row_immutable");
    await rejects(asRuntime(`TRUNCATE ${t("telemetry_performance_field_dictionaries")}`), "42501");
    // So a declared grant can only name one of the three seeded dictionaries.
    assert.equal(await count(schema, "telemetry_performance_field_dictionaries"), 3);
    await activatePerformanceRuntime(pool, { schema });
    const owner = await seedPerformanceAccountlessOwner(pool, { schema });
    await rejects(insertPerformanceGrant(pool, { schema, owner, dictionaryBasis: "client_declared",
      fieldDictionaryVersion: "telemetry-performance-registry-2027-01-01.1" }), "23503");
  } finally {
    await pool.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  }
});

test("receipts: a receipt names its report's participant, device, day and revision; one receipt per report", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("receipts");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await activeOwner(schema);
  const other = await activeOwner(schema);
  const report = await insertPerformanceReport(pool, { schema, owner, grant, reportDay: DAY, withReceipt: false,
    records: [syntheticPerformanceRecord({ day: DAY })] });
  const otherReport = await insertPerformanceReport(pool, { ...other, schema, reportDay: DAY, withReceipt: false,
    records: [syntheticPerformanceRecord({ day: DAY })] });
  const receipt = (overrides = {}) => {
    const row = { participantId: owner.participantId, deviceId: owner.deviceId, reportId: report.reportId,
      reportDay: DAY, reportRevision: report.reportRevision, envelope: randomBytes(32).toString("hex"),
      outcome: "accepted", ...overrides };
    return pool.query(`INSERT INTO ${t("telemetry_performance_receipts")} (id, participant_id, device_id, report_id,
        report_day, report_revision, envelope_digest, outcome, created_at)
      VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, now())`,
    [randomUUID(), row.participantId, row.deviceId, row.reportId, row.reportDay, row.reportRevision, row.envelope,
      row.outcome]);
  };
  // Each column that disagrees with the report row is refused by the composite foreign key.
  for (const overrides of [
    { reportDay: "2026-10-08" },
    { reportRevision: "a".repeat(64) },
    { reportRevision: otherReport.reportRevision },
    { participantId: other.owner.participantId, deviceId: other.owner.deviceId },
    { deviceId: other.owner.deviceId },
    { reportId: otherReport.reportId },
    { reportId: randomUUID() },
  ]) await rejects(receipt(overrides), "23503");
  // An idempotent replay writes no receipt: the outcome is accepted or replaced only.
  await rejects(receipt({ outcome: "idempotent" }), "23514");
  await receipt();
  await receipt({ participantId: other.owner.participantId, deviceId: other.owner.deviceId, reportId: otherReport.reportId,
    reportRevision: otherReport.reportRevision, outcome: "replaced" });
  // A second receipt for the same report revision is refused, whatever its envelope.
  await rejects(receipt(), "23505");
  assert.equal(await count(schema, "telemetry_performance_receipts", "report_id = $1", [report.reportId]), 1);
});

test("deletes: direct deletes are refused while the participant is active; DELETE FROM participants cascades", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("deletes");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await activeOwner(schema);
  const report = await insertPerformanceReport(pool, { schema, owner, grant, reportDay: DAY,
    records: [syntheticPerformanceRecord({ day: DAY })] });
  for (const [table, where] of [
    ["telemetry_performance_buckets", "report_id = $1"],
    ["telemetry_performance_cohorts", "report_id = $1"],
    ["telemetry_performance_receipts", "report_id = $1"],
    ["telemetry_performance_reports", "id = $1"],
  ]) {
    await rejects(pool.query(`DELETE FROM ${t(table)} WHERE ${where}`, [report.reportId]),
      "P1005", "telemetry_performance_source_immutable");
  }
  for (const table of ["accountless_telemetry_performance_authorizations", "telemetry_performance_device_capabilities"]) {
    await rejects(pool.query(`DELETE FROM ${t(table)} WHERE participant_id = $1`, [owner.participantId]),
      "P1005", "telemetry_performance_source_immutable");
  }
  const owned = async () => Object.fromEntries(await Promise.all([
    ["accountless_telemetry_performance_authorizations", "participant_id = $1"],
    ["telemetry_performance_device_capabilities", "participant_id = $1"],
    ["telemetry_performance_reports", "participant_id = $1"],
    ["telemetry_performance_receipts", "participant_id = $1"],
    ["telemetry_performance_cohorts", `report_id IN (SELECT id FROM ${t("telemetry_performance_reports")} WHERE participant_id = $1)`],
  ].map(async ([table, where]) => [table, await count(schema, table, where, [owner.participantId])])));
  assert.deepEqual(await owned(), {
    accountless_telemetry_performance_authorizations: 1, telemetry_performance_device_capabilities: 1,
    telemetry_performance_reports: 1, telemetry_performance_receipts: 1, telemetry_performance_cohorts: 1,
  });
  assert.ok(await count(schema, "telemetry_performance_buckets", "report_id = $1", [report.reportId]) > 0);
  // The offline purge's participant delete cascades every performance row.
  await pool.query(`DELETE FROM ${t("participants")} WHERE id = $1`, [owner.participantId]);
  assert.deepEqual(await owned(), {
    accountless_telemetry_performance_authorizations: 0, telemetry_performance_device_capabilities: 0,
    telemetry_performance_reports: 0, telemetry_performance_receipts: 0, telemetry_performance_cohorts: 0,
  });
  assert.equal(await count(schema, "telemetry_performance_buckets", "report_id = $1", [report.reportId]), 0);
  assert.equal(await count(schema, "telemetry_performance_cohorts", "report_id = $1", [report.reportId]), 0);
  // The enrollment ledger row remains.
  assert.equal(await count(schema, "accountless_enrollment_ledger", "device_id = $1", [owner.enrollmentDeviceId]), 1);
});

test("refusal counters: closed CHECKs, no owner columns, and the upsert increments", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("refusals");
  const table = performanceTable(schema, "telemetry_performance_refusal_counts");
  const upsert = (route, code, status, day = DAY) => pool.query(`INSERT INTO ${table} (day, route_id, code, status, refusals)
      VALUES ($1::date, $2, $3, $4, 1)
    ON CONFLICT (day, route_id, code, status) DO UPDATE SET refusals = ${table}.refusals + 1`, [day, route, code, status]);
  for (const route of PERFORMANCE_INTAKE_ROUTE_IDS) await upsert(route, "TELEMETRY_TRANSPORT_BLOCKED", 403);
  await upsert("telemetry_performance_reports", "TELEMETRY_TRANSPORT_BLOCKED", 403);
  await upsert("telemetry_performance_reports", "TELEMETRY_RECORD_INVALID", 409);
  const rows = await pool.query(`SELECT route_id, code, status, refusals::int FROM ${table} ORDER BY route_id, code`);
  assert.deepEqual(rows.rows, [
    { route_id: "accountless_telemetry_performance_authorization", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403, refusals: 1 },
    { route_id: "telemetry_performance_capabilities", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403, refusals: 1 },
    { route_id: "telemetry_performance_reports", code: "TELEMETRY_RECORD_INVALID", status: 409, refusals: 1 },
    { route_id: "telemetry_performance_reports", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403, refusals: 2 },
  ]);
  for (const [route, code, status] of [
    ["telemetry_performance_consent", "TELEMETRY_TRANSPORT_BLOCKED", 403],
    ["telemetry_performance_reports", "lowercase_code", 403],
    ["telemetry_performance_reports", "A", 403],
    ["telemetry_performance_reports", `A${"B".repeat(64)}`, 403],
    ["telemetry_performance_reports", "TELEMETRY_TRANSPORT_BLOCKED", 399],
    ["telemetry_performance_reports", "TELEMETRY_TRANSPORT_BLOCKED", 600],
  ]) await rejects(upsert(route, code, status), "23514", undefined);
  await rejects(pool.query(`INSERT INTO ${table} (day, route_id, code, status, refusals)
    VALUES ($1::date, 'telemetry_performance_reports', 'BODY_INVALID', 400, 0)`, [DAY]), "23514");
  const columns = await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'telemetry_performance_refusal_counts' ORDER BY ordinal_position`, [schema]);
  assert.deepEqual(columns.rows.map((row) => row.column_name), ["day", "route_id", "code", "status", "refusals"]);
});

test("lock keys: DateStyle-stable, and the admission triggers take exactly those locks", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("locks");
  const t = (name) => performanceTable(schema, name);
  const fn = (name) => `"${schema}".${name}`;
  const keys = (client) => client.query(`SELECT ${fn("telemetry_performance_grant_lock_key")}('device-a')::text AS grant_key,
      ${fn("telemetry_performance_capability_lock_key")}('participant:a', 'device-a')::text AS capability_key,
      ${fn("telemetry_performance_report_lock_key")}('participant:a', 'device-a', DATE '2026-10-09')::text AS report_key,
      DATE '2026-10-09'::text AS day_text`);
  await withClient(async (client) => {
    await client.query("SET DateStyle = 'ISO, MDY'");
    const iso = (await keys(client)).rows[0];
    await client.query("SET DateStyle = 'SQL, DMY'");
    const sql = (await keys(client)).rows[0];
    await client.query("RESET DateStyle");
    assert.notEqual(iso.day_text, sql.day_text, "the DateStyles render the day differently");
    assert.equal(sql.grant_key, iso.grant_key);
    assert.equal(sql.capability_key, iso.capability_key);
    assert.equal(sql.report_key, iso.report_key);
    const distinct = await client.query(`SELECT ${fn("telemetry_performance_report_lock_key")}('participant:a', 'device-a',
      DATE '2026-10-10')::text AS other`);
    assert.notEqual(distinct.rows[0].other, iso.report_key);
    await rejects(client.query(`SELECT ${fn("telemetry_performance_grant_lock_key")}(NULL)`),
      "P1005", "telemetry_performance_lock_key_invalid");
  });
  const sources = await pool.query(`SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname LIKE '%admission'`, [schema]);
  const source = Object.fromEntries(sources.rows.map((row) => [row.proname, row.prosrc]));
  assert.match(source.accountless_telemetry_performance_authorization_admission,
    /pg_advisory_xact_lock\(telemetry_performance_grant_lock_key\(NEW\.enrollment_device_id\)\)/u);
  assert.match(source.telemetry_performance_capability_admission,
    /pg_advisory_xact_lock\(telemetry_performance_capability_lock_key\(NEW\.participant_id, NEW\.device_id\)\)/u);
  assert.match(source.telemetry_performance_report_admission,
    /telemetry_performance_report_lock_key\(NEW\.participant_id, NEW\.device_id, NEW\.report_day\)/u);

  // Holding the shared key blocks each trigger: the waiter times out on the lock.
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await activeOwner(schema);
  const blocked = async (lockSql, lockValues, write) => {
    const holder = await pool.connect();
    const waiter = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(lockSql, lockValues);
      await waiter.query("BEGIN");
      await waiter.query("SET LOCAL lock_timeout = '300ms'");
      await rejects(write(waiter), "55P03");
    } finally {
      await waiter.query("ROLLBACK").catch(() => {});
      await holder.query("ROLLBACK").catch(() => {});
      waiter.release();
      holder.release();
    }
  };
  await blocked(`SELECT pg_advisory_xact_lock(${fn("telemetry_performance_grant_lock_key")}($1))`, [owner.enrollmentDeviceId],
    (client) => client.query(`INSERT INTO ${t("accountless_telemetry_performance_authorizations")} (enrollment_device_id,
        participant_id, device_credential_id, schema_version, policy_version, authorization_basis,
        performance_schema_version, field_dictionary_version, dictionary_basis, privacy_contract_version, scope,
        capability_revision, authority_epoch, authorized_at, expires_at, state)
      VALUES ($1, $2, $1, 'accountless-performance-owner-v1', 'accountless-telemetry-performance-policy-v1',
        'accountless-performance-policy-v1', 'model-performance-daily-v1', $3, 'v12_parser_inference',
        'privacy-safe-model-performance-v1', 'model-performance-daily', 2, 1, now(), $4::timestamptz, 'active')`,
    [owner.enrollmentDeviceId, owner.participantId, PERFORMANCE_DICTIONARY_2026_09_29, owner.expiresAt]));
  await blocked(`SELECT pg_advisory_xact_lock(${fn("telemetry_performance_capability_lock_key")}($1, $2))`,
    [owner.participantId, owner.deviceId],
    (client) => client.query(`INSERT INTO ${t("telemetry_performance_device_capabilities")} (participant_id, device_id,
        schema_version, field_dictionary_version, dictionary_basis, privacy_contract_version, scope, capability_revision,
        authority_epoch, issued_at, expires_at, state, consented_at)
      VALUES ($1, $2, 'model-performance-daily-v1', $3, 'v12_parser_inference', 'privacy-safe-model-performance-v1',
        'model-performance-daily', 2, 1, now(), $4::timestamptz, 'accepted', now())`,
    [owner.participantId, owner.deviceId, PERFORMANCE_DICTIONARY_2026_09_29, owner.expiresAt]));
  await blocked(`SELECT pg_advisory_xact_lock(${fn("telemetry_performance_report_lock_key")}($1, $2, $3::date))`,
    [owner.participantId, owner.deviceId, DAY],
    (client) => client.query(`INSERT INTO ${t("telemetry_performance_reports")} (id, participant_id, device_id, report_day,
        report_revision, source_generation, source_digest, source_revision, method_version, parser_version, schema_version,
        field_dictionary_version, bucket_scheme_version, privacy_contract_version, measurement_version, record_count,
        canonical_bytes, capability_revision, authority_epoch, state, created_at)
      VALUES ($1, $2, $3, $4::date, $5, 'synthetic-generation', $5, 1, 'performance-daily-histogram-v1',
        'unified-rollout-typed-v20', 'model-performance-daily-v1', $6, 'performance-histogram-v1',
        'privacy-safe-model-performance-v1', 'model-performance-samples-v1', 0, 2, $7, $8, 'current', now())`,
    [randomUUID(), owner.participantId, owner.deviceId, DAY, "f".repeat(64), PERFORMANCE_DICTIONARY_2026_09_29,
      grant.capabilityRevision, grant.authorityEpoch]));
});

test("publication heads: payload and column CHECKs, forward-only updates and the kernel foreign key", {
  skip, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema("heads_pub");
  const table = performanceTable(schema, "analytics_v2_published_performance");
  const kernelId = await ensurePerformanceFixtureKernel(pool, { schema });
  const payload = syntheticCommunityModelPerformancePayload({ period: "7", speedMode: "fast", revision: 1 });
  for (const [label, overrides] of [
    ["schema version", { payload: { ...payload, schemaVersion: "community-model-performance-v0" } }],
    ["missing schema version", { payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "schemaVersion")) }],
    ["period", { period: "30" }],
    ["missing period", { period: "7", payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "period")) }],
    ["missing speed mode", { speedMode: "fast", payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "speedMode")) }],
    ["missing revision", { revision: 1, payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "revision")) }],
    ["speed mode", { speedMode: "standard" }],
    ["unknown speed mode", { speedMode: "mixed", payload: { ...payload, speedMode: "mixed" } }],
    ["revision", { revision: 2 }],
    ["string revision", { revision: 1, payload: { ...payload, revision: "1" } }],
    ["numeric period", { period: "7", payload: { ...payload, period: 7 } }],
    ["unknown period", { period: "14", payload: { ...payload, period: "14" } }],
    ["digest", { payloadSha256: "G".repeat(64) }],
    ["manifest version", { manifestVersion: 0 }],
  ]) {
    await assert.rejects(insertPerformancePublicationHead(pool, { schema, payload, kernelId, ...overrides }),
      (error) => error?.code === "23514", label);
  }
  await rejects(insertPerformancePublicationHead(pool, { schema, payload, kernelId: 999 }), "23503");
  await rejects(pool.query(`INSERT INTO ${table} (period, speed_mode, revision, released_at, payload, payload_sha256, run_id,
      kernel_id, manifest_version) VALUES ('7', 'fast', 1, now(), '[]'::jsonb, $1, $2, $3, 1)`,
  ["a".repeat(64), randomUUID(), kernelId]), "23514");
  const head = await insertPerformancePublicationHead(pool, { schema, payload, kernelId });
  // All 12 slots can hold a head.
  for (const period of ["1", "7", "30", "all"]) {
    for (const speedMode of ["standard", "fast", "ultrafast"]) {
      if (period === "7" && speedMode === "fast") continue;
      await insertPerformancePublicationHead(pool, { schema, kernelId,
        payload: syntheticCommunityModelPerformancePayload({ period, speedMode }) });
    }
  }
  assert.equal(await count(schema, "analytics_v2_published_performance"), 12);
  await rejects(insertPerformancePublicationHead(pool, { schema, payload, kernelId }), "23505");
  // Forward only: no delete, no same or lower revision, no unchanged digest, no key change.
  await rejects(pool.query(`DELETE FROM ${table} WHERE period = '7' AND speed_mode = 'fast'`),
    "P1005", "analytics_v2_published_performance_no_delete");
  const next = syntheticCommunityModelPerformancePayload({ period: "7", speedMode: "fast", revision: 2, contributors: 1,
    devices: 1, reports: 1 });
  const update = (body, digest, revision = body.revision) => pool.query(`UPDATE ${table}
      SET payload = $1::jsonb, payload_sha256 = $2, revision = $3, released_at = now()
    WHERE period = '7' AND speed_mode = 'fast'`, [JSON.stringify(body), digest, revision]);
  await rejects(update(next, head.payloadSha256), "P1005", "analytics_v2_published_performance_forward_only");
  await rejects(update({ ...next, revision: 1 }, "b".repeat(64)), "P1005", "analytics_v2_published_performance_forward_only");
  await rejects(pool.query(`UPDATE ${table} SET period = '30', payload = jsonb_set(payload, '{period}', '"30"')
    WHERE period = '7' AND speed_mode = 'fast'`), "P1005", "analytics_v2_published_performance_forward_only");
  await update(next, "c".repeat(64));
  const stored = await pool.query(`SELECT revision, payload ->> 'contributors' AS contributors FROM ${table}
    WHERE period = '7' AND speed_mode = 'fast'`);
  assert.deepEqual(stored.rows, [{ revision: 2, contributors: "1" }]);
  await rejects(pool.query(`DELETE FROM ${table}`), "P1005", "analytics_v2_published_performance_no_delete");
});
