// PostgreSQL 17 spec for src/postgres-telemetry-runtime-activation.ts: the
// owner-only activation task of the accountless performance runtime
// (primary 0079_performance_telemetry.sql).
//
// Every schema is built through the production runner on the promoted
// primary chain (applyPostgresMigrations), which ends at 0079; the
// pre-migration case uses promoted-migration-prefix.mjs applyMigrationsBefore.
// Fixtures are synthetic and content-free (a constant commit, random UUID
// keys, a constant synthetic owner identity). Each test drops only the
// schemas it created (prefix g5_act_).
//
// It proves the exact body parser, the manifest digest the request must name
// (the migrate receipt's historySha256), the happy path from staged revision
// 1 to active revision 2 with its replay, the refusals (revision conflict,
// disabled collection controls, wrong commit or digest, unconfigured commit,
// drifted dictionary registry) that leave no audit row, the pre-migration
// refusal, the reconcile of a started row left behind by an interrupted
// writer, atomicity of the audit and the runtime move, concurrent
// activations with one winner, and that 0079's guard refuses a direct update
// without the audit row and the setting.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test --test-concurrency=1 postgres-test/postgres-telemetry-runtime-activation.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  beginPerformanceActivationAudit,
  performanceTable,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

const APPLICATION_NAME = "g5-runtime-activation";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const IDENTITY_KEY = "synthetic-owner-identity";
const CONFIRMATION = "activate_telemetry_performance_runtime";
const DETAILS_SCHEMA_VERSION = "postgres-telemetry-runtime-activation-v1";
const T0 = Date.parse("2026-10-11T00:00:00.000Z");

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

async function loadModules() {
  if (modules) return modules;
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  modules = {
    activation: await vite.ssrLoadModule("/src/postgres-telemetry-runtime-activation.ts"),
    runtime: await vite.ssrLoadModule("/src/postgres-runtime-schema.ts"),
  };
  return modules;
}

async function setup() {
  await loadModules();
  if (pool) return;
  pool = new pg.Pool({ ...endpoint, max: 12, application_name: APPLICATION_NAME, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
}

function manifest() {
  return modules.runtime.POSTGRES_RUNTIME_MIGRATIONS.primary;
}

/** The migrate job's canonicalJson, restated independently of the module. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The production migrate receipt's historySha256 for a migration list, restated. */
function receiptHistorySha256(migrations) {
  return createHash("sha256")
    .update(canonicalJson(migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 }))))
    .digest("hex");
}

async function newSchemaName(label) {
  await setup();
  const schema = `g5_act_${label}_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  return schema;
}

/** A schema on the full promoted chain with operational collection controls. */
async function promotedSchema(label) {
  const schema = await newSchemaName(label);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME);
  await setControls(schema, { uploadRegistration: true, processing: true });
  return schema;
}

/** Set the controls singleton; the state follows the flag count (0050's rule). */
async function setControls(schema, { uploadRegistration, processing }) {
  const flags = [true, uploadRegistration, processing, true];
  const enabled = flags.filter(Boolean).length;
  const state = enabled === 4 ? "operational" : enabled === 0 ? "contained" : "degraded";
  await pool.query(`UPDATE ${performanceTable(schema, "collection_controls")}
      SET revision = revision + 1, control_state = $1, enrollment_enabled = true,
          upload_registration_enabled = $2, processing_enabled = $3, publication_enabled = true,
          reason_code = 'maintenance', updated_at = clock_timestamp()
    WHERE singleton = 1`, [state, uploadRegistration, processing]);
}

async function historySha256() {
  return modules.activation.postgresRuntimeMigrationHistorySha256(manifest());
}

async function body({ idempotencyKey = randomUUID(), expectedRevision = 1, sourceCommit = COMMIT,
  history, target = "performance", confirmation = CONFIRMATION } = {}) {
  return {
    action: "run_maintenance",
    telemetryRuntimeActivation: {
      confirmation,
      deployment: { historySha256: history ?? await historySha256(), sourceCommit },
      expectedRevision,
      idempotencyKey,
      target,
    },
  };
}

function task(schema, overrides = {}) {
  return modules.activation.createPostgresTelemetryRuntimeActivationTask({
    pool,
    schema,
    sourceCommit: COMMIT,
    expectedMigrations: manifest(),
    clock: () => T0,
    ...overrides,
  });
}

async function runtime(schema) {
  const rows = (await pool.query(`SELECT state, policy_revision FROM ${performanceTable(schema, "telemetry_performance_runtime")}`)).rows;
  assert.equal(rows.length, 1);
  return rows[0];
}

async function audits(schema) {
  return (await pool.query(`SELECT operation_id, action, actor_identity_digest, outcome, details_json
      FROM ${performanceTable(schema, "admin_action_audit")} ORDER BY id`)).rows;
}

async function refused(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${error?.code} ${error?.message}`);
    assert.equal(error.status, status);
    return true;
  });
}

async function staysStagedWithoutAudit(schema) {
  assert.deepEqual(await runtime(schema), { state: "staged", policy_revision: 1 });
  assert.deepEqual(await audits(schema), [], "a refusal leaves no audit row");
}

/** Insert one committed audit row under `operationId` (an interrupted earlier writer). */
async function insertAudit(schema, { operationId, outcome = "started", details }) {
  await pool.query(`INSERT INTO ${performanceTable(schema, "admin_action_audit")}
      (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
    VALUES ($1, 'run_maintenance', $2, $3, $4, $5::timestamptz)`,
  [operationId, createHash("sha256").update("synthetic-earlier-writer").digest("hex"), outcome,
    JSON.stringify(details), new Date(T0 - 60_000).toISOString()]);
}

async function intentDetails(request) {
  const activation = request.telemetryRuntimeActivation;
  return {
    schemaVersion: DETAILS_SCHEMA_VERSION,
    task: "telemetry_runtime_activation",
    target: "performance",
    idempotencyKey: activation.idempotencyKey,
    expectedRevision: activation.expectedRevision,
    deployment: activation.deployment,
  };
}

/** Wait until `count` backends of this spec's pool wait on a heavyweight lock. */
async function waitForLockWaiters(count) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = (await pool.query(`SELECT count(*)::integer AS waiting FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'`, [APPLICATION_NAME])).rows;
    if (rows[0].waiting >= count) return;
    if (Date.now() > deadline) assert.fail(`expected ${count} lock waiters, saw ${rows[0].waiting}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// Parser and manifest digest (no database)
// ---------------------------------------------------------------------------

test("the parser accepts exactly the owner body and refuses everything else, usage_v12 included, as 400 BODY_INVALID", async () => {
  const { activation } = await loadModules();
  const valid = await body();
  const parsed = activation.parsePostgresTelemetryRuntimeActivationRequest(valid);
  assert.deepEqual(parsed, valid.telemetryRuntimeActivation);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.deployment));
  assert.equal(activation.parsePostgresTelemetryRuntimeActivationRequest(
    await body({ expectedRevision: 2_147_483_647 })).expectedRevision, 2_147_483_647);

  const inner = (patch) => ({ ...valid, telemetryRuntimeActivation: { ...valid.telemetryRuntimeActivation, ...patch } });
  const deployment = (patch) => inner({ deployment: { ...valid.telemetryRuntimeActivation.deployment, ...patch } });
  const { confirmation: _confirmation, ...withoutConfirmation } = valid.telemetryRuntimeActivation;
  const invalid = [
    null, [], "run_maintenance", {},
    { action: "run_maintenance" },
    { ...valid, action: "sync_distribution" },
    { ...valid, extra: true },
    { ...valid, telemetryRuntimeActivation: withoutConfirmation },
    inner({ extra: 1 }),
    inner({ target: "usage_v12" }),
    inner({ target: "usage_v12", confirmation: "activate_telemetry_v12_runtime" }),
    inner({ target: "Performance" }),
    inner({ confirmation: "activate_telemetry_v12_runtime" }),
    inner({ expectedRevision: 0 }),
    inner({ expectedRevision: 1.5 }),
    inner({ expectedRevision: "1" }),
    inner({ expectedRevision: 2_147_483_648 }),
    inner({ idempotencyKey: randomUUID().toUpperCase() }),
    inner({ idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
    inner({ idempotencyKey: "not-a-uuid" }),
    inner({ deployment: null }),
    inner({ deployment: [] }),
    deployment({ extra: "x" }),
    deployment({ sourceCommit: COMMIT.toUpperCase() }),
    deployment({ sourceCommit: COMMIT.slice(0, 12) }),
    deployment({ sourceCommit: undefined }),
    deployment({ historySha256: "A".repeat(64) }),
    deployment({ historySha256: "a".repeat(63) }),
    deployment({ historySha256: 7 }),
  ];
  for (const [index, value] of invalid.entries()) {
    assert.throws(() => activation.parsePostgresTelemetryRuntimeActivationRequest(value), (error) => {
      assert.equal(error?.code, "BODY_INVALID", `case ${index}`);
      assert.equal(error.status, 400);
      return true;
    });
  }
});

test("the manifest digest is the migrate receipt's historySha256 over the image's promoted primary chain", async () => {
  const { activation, runtime: runtimeSchema } = await loadModules();
  const expected = runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS.primary;
  const promoted = await readPostgresMigrations({ role: "primary" });
  assert.deepEqual(expected.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
    promoted.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
    "the image manifest equals the files the migrate job applies");
  assert.equal(expected.at(-1).name, PERFORMANCE_MIGRATION_NAME);
  const digest = await activation.postgresRuntimeMigrationHistorySha256(expected);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest, receiptHistorySha256(promoted));
  // A known answer pins the canonical form (sorted keys, no whitespace).
  const tiny = [{ version: 1, name: "0001_a.sql", sha256: "a".repeat(64) }];
  assert.equal(await activation.postgresRuntimeMigrationHistorySha256(tiny),
    createHash("sha256").update(`[{"name":"0001_a.sql","sha256":"${"a".repeat(64)}","version":1}]`).digest("hex"));
  // Every entry changes the digest.
  assert.notEqual(await activation.postgresRuntimeMigrationHistorySha256(expected.slice(0, -1)), digest);
  for (const bad of [[], [{ version: 2, name: "0002_a.sql", sha256: "a".repeat(64) }],
    [{ version: 1, name: "a.sql", sha256: "a".repeat(64) }], null]) {
    await assert.rejects(activation.postgresRuntimeMigrationHistorySha256(bad),
      /TELEMETRY_RUNTIME_ACTIVATION_CONFIGURATION_INVALID: expectedMigrations/u);
  }
});

test("construction refuses a structurally invalid configuration with a TypeError", async () => {
  const { activation, runtime: runtimeSchema } = await loadModules();
  const fakePool = { connect: async () => assert.fail("no storage call") };
  const base = { pool: fakePool, schema: "g5_unused", sourceCommit: COMMIT,
    expectedMigrations: runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS.primary };
  for (const [field, overrides] of [
    ["options", null],
    ["pool", { pool: {} }],
    ["schema", { schema: "Bad-Schema" }],
    ["schema", { schema: "pg_catalog" }],
    ["expectedMigrations", { expectedMigrations: [] }],
    ["clock", { clock: 5 }],
  ]) {
    assert.throws(() => activation.createPostgresTelemetryRuntimeActivationTask(overrides === null ? null : { ...base, ...overrides }),
      (error) => error instanceof TypeError
        && error.message === `TELEMETRY_RUNTIME_ACTIVATION_CONFIGURATION_INVALID: ${field}`);
  }
  // A malformed body is refused before any storage call.
  const run = activation.createPostgresTelemetryRuntimeActivationTask(base);
  await refused(run({ body: { action: "run_maintenance" }, identityKey: IDENTITY_KEY }), 400, "BODY_INVALID");
});

// ---------------------------------------------------------------------------
// PostgreSQL 17
// ---------------------------------------------------------------------------

test("PG17 the happy path moves staged revision 1 to active revision 2 under one success audit row, and replays", { skip, timeout: 120_000 }, async () => {
  const schema = await promotedSchema("happy");
  await staysStagedWithoutAudit(schema);
  const request = await body();
  const key = request.telemetryRuntimeActivation.idempotencyKey;
  const run = task(schema);

  const first = await run({ body: request, identityKey: IDENTITY_KEY });
  assert.deepEqual(first, {
    task: "telemetry_runtime_activation", operationId: key, target: "performance", state: "active",
    fromRevision: 1, toRevision: 2, revision: 2, replayed: false, reconciled: false,
  });
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });
  const rows = await audits(schema);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation_id, key);
  assert.equal(rows[0].action, "run_maintenance");
  assert.equal(rows[0].outcome, "success");
  assert.match(rows[0].actor_identity_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(JSON.parse(rows[0].details_json), {
    ...await intentDetails(request), fromRevision: 1, toRevision: 2, state: "active", reconciled: false,
  });
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(IDENTITY_KEY, "u"), "the identity key is stored only as a digest");
  const updated = await pool.query(`SELECT updated_at FROM ${performanceTable(schema, "telemetry_performance_runtime")}`);
  assert.equal(updated.rows[0].updated_at.toISOString(), new Date(T0).toISOString(), "updated_at is the task clock");

  // Replay: the recorded result, no second row, no second move.
  const replay = await run({ body: request, identityKey: IDENTITY_KEY });
  assert.deepEqual(replay, { ...first, replayed: true });
  // A replay after a redeploy (another image commit) still answers from the record.
  const redeployed = task(schema, { sourceCommit: OTHER_COMMIT });
  assert.deepEqual(await redeployed({ body: request, identityKey: IDENTITY_KEY }), { ...first, replayed: true });
  assert.equal((await audits(schema)).length, 1);
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });

  // The key is spent for any other intent; a new key cannot activate again.
  await refused(run({ body: await body({ idempotencyKey: key, expectedRevision: 2 }), identityKey: IDENTITY_KEY }),
    409, "ADMIN_ACTION_CONFLICT");
  await refused(run({ body: await body({ expectedRevision: 1 }), identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  await refused(run({ body: await body({ expectedRevision: 2 }), identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  assert.equal((await audits(schema)).length, 1);
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });
});

test("PG17 refusals before the audit leave no audit row and no fence: revision, controls, commit, digest, configuration, registry", { skip, timeout: 120_000 }, async () => {
  const schema = await promotedSchema("refuse");
  const run = task(schema);
  const call = async (overrides, runner = run) => runner({ body: await body(overrides), identityKey: IDENTITY_KEY });

  await refused(call({ expectedRevision: 2 }), 409, "ADMIN_ACTION_CONFLICT");
  await staysStagedWithoutAudit(schema);

  await setControls(schema, { uploadRegistration: false, processing: false });
  await refused(call({}), 503, "UPLOAD_REGISTRATION_DISABLED");
  await setControls(schema, { uploadRegistration: true, processing: false });
  await refused(call({}), 503, "PROCESSING_DISABLED");
  await setControls(schema, { uploadRegistration: false, processing: true });
  await refused(call({}), 503, "UPLOAD_REGISTRATION_DISABLED");
  await staysStagedWithoutAudit(schema);
  await setControls(schema, { uploadRegistration: true, processing: true });

  await refused(call({ sourceCommit: OTHER_COMMIT }), 409, "ADMIN_ACTION_CONFLICT");
  await refused(call({ history: "e".repeat(64) }), 409, "ADMIN_ACTION_CONFLICT");
  const drifted = await modules.activation.postgresRuntimeMigrationHistorySha256(manifest().slice(0, -1));
  await refused(call({ history: drifted }), 409, "ADMIN_ACTION_CONFLICT");
  await refused(call({}, task(schema, { sourceCommit: null })), 503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  await refused(call({}, task(schema, { sourceCommit: "abc1234" })), 503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  await refused(call({}, task(schema, { clock: () => Number.NaN })), 503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  await staysStagedWithoutAudit(schema);

  // A registry that no longer equals the image's pairing (the migration's
  // own guard disabled, as only a reviewed migration may) refuses too.
  const registry = performanceTable(schema, "telemetry_performance_field_dictionaries");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${registry} DISABLE TRIGGER telemetry_performance_field_dictionaries_immutable`);
    await client.query(`UPDATE ${registry} SET ultrafast_labels = true
      WHERE field_dictionary_version = 'telemetry-performance-registry-2026-09-21.1'`);
    await client.query(`ALTER TABLE ${registry} ENABLE TRIGGER telemetry_performance_field_dictionaries_immutable`);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await refused(call({}), 503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  await staysStagedWithoutAudit(schema);
});

test("PG17 the refusals left nothing behind: the same schema still activates afterwards", { skip, timeout: 120_000 }, async () => {
  const schema = await promotedSchema("after");
  const run = task(schema);
  const request = await body();
  await refused(run({ body: await body({ ...request.telemetryRuntimeActivation, sourceCommit: OTHER_COMMIT }),
    identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  await setControls(schema, { uploadRegistration: true, processing: false });
  await refused(run({ body: request, identityKey: IDENTITY_KEY }), 503, "PROCESSING_DISABLED");
  await setControls(schema, { uploadRegistration: true, processing: true });
  const activated = await run({ body: request, identityKey: IDENTITY_KEY });
  assert.equal(activated.replayed, false);
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });
});

test("PG17 a schema without 0079 (or any receipt drift) is refused by the schema receipt before any write", { skip, timeout: 120_000 }, async () => {
  const before = await newSchemaName("pre");
  const prefix = await applyMigrationsBefore({ role: "primary", schema: before, pool, name: PERFORMANCE_MIGRATION_NAME });
  assert.equal(prefix.target.name, PERFORMANCE_MIGRATION_NAME);
  await setControls(before, { uploadRegistration: true, processing: true });
  await refused(task(before)({ body: await body(), identityKey: IDENTITY_KEY }), 503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  assert.deepEqual(await audits(before), []);
  const regclass = await pool.query("SELECT to_regclass($1)::text AS runtime",
    [performanceTable(before, "telemetry_performance_runtime")]);
  assert.equal(regclass.rows[0].runtime, null, "the pre-migration schema has no runtime table");

  // A full schema read by an image whose manifest ends earlier is drift too.
  const full = await promotedSchema("drift");
  const older = task(full, { expectedMigrations: manifest().slice(0, -1) });
  const olderHistory = await modules.activation.postgresRuntimeMigrationHistorySha256(manifest().slice(0, -1));
  await refused(older({ body: await body({ history: olderHistory }), identityKey: IDENTITY_KEY }),
    503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  await staysStagedWithoutAudit(full);
});

test("PG17 a started row for the same intent is finished when the runtime already shows the activation, else reconcile is required", { skip, timeout: 120_000 }, async () => {
  // Runtime still staged: nothing changes, 503 reconcile required.
  const staged = await promotedSchema("recstaged");
  const stagedRequest = await body();
  const stagedKey = stagedRequest.telemetryRuntimeActivation.idempotencyKey;
  await insertAudit(staged, { operationId: stagedKey, details: await intentDetails(stagedRequest) });
  await refused(task(staged)({ body: stagedRequest, identityKey: IDENTITY_KEY }),
    503, "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED");
  assert.deepEqual(await runtime(staged), { state: "staged", policy_revision: 1 });
  assert.deepEqual((await audits(staged)).map(({ outcome }) => outcome), ["started"]);
  // The guard never accepts that committed started row as the activation's own.
  await assert.rejects((async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [stagedKey]);
      await client.query(`UPDATE ${performanceTable(staged, "telemetry_performance_runtime")}
          SET state = 'active', policy_revision = 2, updated_at = updated_at + interval '1 second'`);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  })(), (error) => error?.code === "P1005" && error.message === "telemetry_performance_runtime_guarded");

  // Runtime already active at expectedRevision + 1: finish with success.
  const active = await promotedSchema("recactive");
  const request = await body();
  const key = request.telemetryRuntimeActivation.idempotencyKey;
  await insertAudit(active, { operationId: key, details: await intentDetails(request) });
  await activatePerformanceRuntime(pool, { schema: active, nowEpoch: T0 - 30_000 });
  assert.deepEqual(await runtime(active), { state: "active", policy_revision: 2 });
  const run = task(active);
  const reconciled = await run({ body: request, identityKey: IDENTITY_KEY });
  assert.deepEqual(reconciled, {
    task: "telemetry_runtime_activation", operationId: key, target: "performance", state: "active",
    fromRevision: 1, toRevision: 2, revision: 2, replayed: true, reconciled: true,
  });
  const row = (await audits(active)).find(({ operation_id: id }) => id === key);
  assert.equal(row.outcome, "success");
  assert.deepEqual(JSON.parse(row.details_json), {
    ...await intentDetails(request), fromRevision: 1, toRevision: 2, state: "active", reconciled: true,
  });
  assert.deepEqual(await runtime(active), { state: "active", policy_revision: 2 }, "reconcile moves nothing");
  assert.deepEqual(await run({ body: request, identityKey: IDENTITY_KEY }), reconciled, "and then replays");

  // Another intent under the key, another shape, or a failure row: conflict.
  const other = await promotedSchema("recother");
  const otherRequest = await body();
  const otherKey = otherRequest.telemetryRuntimeActivation.idempotencyKey;
  await insertAudit(other, { operationId: otherKey,
    details: { ...await intentDetails(otherRequest), expectedRevision: 2 } });
  await refused(task(other)({ body: otherRequest, identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  const shaped = await body();
  await insertAudit(other, { operationId: shaped.telemetryRuntimeActivation.idempotencyKey,
    details: { operation: "telemetryRuntimeActivation" } });
  await refused(task(other)({ body: shaped, identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  const failed = await body();
  await insertAudit(other, { operationId: failed.telemetryRuntimeActivation.idempotencyKey, outcome: "failure",
    details: await intentDetails(failed) });
  await refused(task(other)({ body: failed, identityKey: IDENTITY_KEY }), 409, "ADMIN_ACTION_CONFLICT");
  assert.deepEqual(await runtime(other), { state: "staged", policy_revision: 1 });
  assert.deepEqual((await audits(other)).map(({ outcome }) => outcome), ["started", "started", "failure"]);
});

test("PG17 the audit row and the runtime move commit or vanish together", { skip, timeout: 120_000 }, async () => {
  const schema = await promotedSchema("atomic");
  // A pool whose clients fail the audit finish (step 10), after the runtime
  // UPDATE (step 9) has run inside the same transaction.
  const seen = [];
  const failingPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (/^\s*UPDATE\s+\S+\."admin_action_audit"/u.test(text)) {
            seen.push("audit finish");
            throw Object.assign(new Error("synthetic interruption"), { code: "57P01" });
          }
          const result = await client.query(text, values);
          if (/^\s*UPDATE\s+\S+\."telemetry_performance_runtime"/u.test(text)) seen.push(`runtime moved ${result.rowCount}`);
          return result;
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
  const request = await body();
  await refused(task(schema, { pool: failingPool })({ body: request, identityKey: IDENTITY_KEY }),
    503, "BACKEND_STORAGE_UNAVAILABLE");
  assert.deepEqual(seen, ["runtime moved 1", "audit finish"], "the runtime moved inside the transaction before the interruption");
  await staysStagedWithoutAudit(schema);
  const activated = await task(schema)({ body: request, identityKey: IDENTITY_KEY });
  assert.equal(activated.replayed, false, "the same key then activates normally");
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });
});

test("PG17 concurrent activations have exactly one winner; concurrent requests with one key converge on it", { skip, timeout: 120_000 }, async () => {
  async function race(schema, bodies) {
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT 1 FROM ${performanceTable(schema, "telemetry_performance_runtime")} WHERE id = 1 FOR UPDATE`);
      const run = task(schema);
      const pending = bodies.map((request) => run({ body: request, identityKey: IDENTITY_KEY }));
      const settled = Promise.allSettled(pending);
      await waitForLockWaiters(bodies.length);
      await blocker.query("ROLLBACK");
      return await settled;
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  }

  const distinct = await promotedSchema("race");
  const outcomes = await race(distinct, [await body(), await body()]);
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].value.replayed, false);
  assert.equal(losers[0].reason.code, "ADMIN_ACTION_CONFLICT");
  assert.equal(losers[0].reason.status, 409);
  assert.deepEqual(await runtime(distinct), { state: "active", policy_revision: 2 });
  const rows = await audits(distinct);
  assert.deepEqual(rows.map(({ operation_id: id, outcome }) => [id, outcome]), [[winners[0].value.operationId, "success"]]);

  const shared = await promotedSchema("racekey");
  const request = await body();
  const same = await race(shared, [request, request]);
  assert.deepEqual(same.map(({ status }) => status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(same.map(({ value }) => value.replayed).sort(), [false, true]);
  assert.equal(new Set(same.map(({ value }) => value.operationId)).size, 1);
  assert.deepEqual(await runtime(shared), { state: "active", policy_revision: 2 });
  assert.equal((await audits(shared)).length, 1);
});

test("PG17 0079's guard refuses a direct runtime update without the activation's own audit row and setting", { skip, timeout: 120_000 }, async () => {
  const schema = await promotedSchema("guard");
  const runtimeTable = performanceTable(schema, "telemetry_performance_runtime");
  const move = `UPDATE ${runtimeTable} SET state = 'active', policy_revision = policy_revision + 1,
      updated_at = updated_at + interval '1 second' WHERE id = 1`;
  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
  const guarded = (error) => error?.code === "P1005" && error.message === "telemetry_performance_runtime_guarded";

  // Neither audit row nor setting.
  await assert.rejects(pool.query(move), guarded);
  // The setting names no audit row.
  await assert.rejects(inTransaction(async (client) => {
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [randomUUID()]);
    await client.query(move);
  }), guarded);
  // A fresh started audit row, but no setting.
  await assert.rejects(inTransaction(async (client) => {
    await beginPerformanceActivationAudit(client, { schema });
    await client.query(move);
  }), guarded);
  // A started row committed earlier, named by the setting.
  const earlier = await beginPerformanceActivationAudit(pool, { schema });
  await assert.rejects(inTransaction(async (client) => {
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [earlier]);
    await client.query(move);
  }), guarded);
  // A fresh row and the setting, but inside a savepoint.
  await assert.rejects(inTransaction(async (client) => {
    await client.query("SAVEPOINT nested");
    const operationId = await beginPerformanceActivationAudit(client, { schema });
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
    await client.query(move);
  }), guarded);
  assert.deepEqual(await runtime(schema), { state: "staged", policy_revision: 1 });

  // The task's path is the one that passes.
  const activated = await task(schema)({ body: await body(), identityKey: IDENTITY_KEY });
  assert.equal(activated.toRevision, 2);
  assert.deepEqual(await runtime(schema), { state: "active", policy_revision: 2 });
});
