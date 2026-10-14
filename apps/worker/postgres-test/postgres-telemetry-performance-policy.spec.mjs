// PostgreSQL 17 spec for src/postgres-telemetry-performance-policy.ts: the
// accountless performance grant (v1 and v2 bodies), per-device dictionary
// resolution, the storage gate and the capability read, on the promoted
// primary chain (applyPostgresMigrations ends at 0079).
//
// Fixtures come from postgres-test/fixtures/performance-telemetry.mjs and are
// synthetic and content-free. Each test drops only the schemas this file
// created (prefix g2_perf_). Gate answer 1 (OVERRIDE) applies: a v1 grant with
// no v1.2 manifest, or an unmapped parser, is granted 2026-09-29.1 with the
// basis default_no_manifest instead of being refused.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test --test-concurrency=1 postgres-test/postgres-telemetry-performance-policy.spec.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  PERFORMANCE_FIELD_DICTIONARIES,
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { runTelemetryPerformanceSync } from "../../../src/contribution/telemetry-performance-sync.js";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  performanceInstant,
  performanceTable,
  seedPerformanceAccountlessOwner,
  seedPerformanceV12DayManifest,
  slidePerformanceOwnerLease,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;
const DAY_MS = 86_400_000;

const V1_BODY = Object.freeze({
  schemaVersion: "accountless-performance-owner-v1",
  policyVersion: "accountless-telemetry-performance-policy-v1",
  authorizationBasis: "accountless-performance-policy-v1",
});
function v2Body(fieldDictionaryVersion) {
  return {
    schemaVersion: "accountless-performance-owner-v2",
    policyVersion: "accountless-telemetry-performance-policy-v1",
    authorizationBasis: "accountless-performance-policy-v1",
    fieldDictionaryVersion,
  };
}

let pool;
let vite;
let policy;
let workerPolicy;
let activeSchema;
let stagedSchema;
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
  pool = new pg.Pool({ ...endpoint, max: 10, application_name: "g2-performance-policy", connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  policy = await vite.ssrLoadModule("/src/postgres-telemetry-performance-policy.ts");
  workerPolicy = await vite.ssrLoadModule("/src/telemetry-performance-policy.ts");
}

async function newSchemaName(label) {
  await setup();
  const schema = `g2_perf_${label}_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  return schema;
}

async function promotedSchema(label) {
  const schema = await newSchemaName(label);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME);
  return schema;
}

/** One schema with an active runtime, shared by the tests that need it. */
async function active() {
  if (activeSchema === undefined) {
    activeSchema = await promotedSchema("active");
    await activatePerformanceRuntime(pool, { schema: activeSchema });
  }
  return activeSchema;
}

/** One schema whose runtime stays staged (0079's seed). */
async function staged() {
  if (stagedSchema === undefined) stagedSchema = await promotedSchema("staged");
  return stagedSchema;
}

function principalOf(owner) {
  return { participantId: owner.participantId, deviceId: owner.deviceId };
}

function grant(schema, owner, body, { nowEpoch = Date.now() } = {}) {
  return policy.grantPostgresTelemetryPerformanceAccountlessAuthorization(pool, {
    schema: { primarySchema: schema },
    principal: principalOf(owner),
    request: policy.parsePostgresTelemetryPerformanceGrantRequest(body),
    nowEpoch,
  });
}

function capability(schema, owner, { nowEpoch = Date.now() } = {}) {
  return policy.readPostgresTelemetryPerformanceCapability(pool, {
    schema: { primarySchema: schema }, principal: principalOf(owner), nowEpoch,
  });
}

async function apiRejects(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "ApiError", String(error?.name));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function grantRows(schema, owner) {
  const authorizations = await pool.query(`SELECT capability_revision, authority_epoch, field_dictionary_version,
      dictionary_basis, schema_version, state
      FROM ${performanceTable(schema, "accountless_telemetry_performance_authorizations")}
     WHERE enrollment_device_id = $1 ORDER BY capability_revision`, [owner.enrollmentDeviceId]);
  const capabilities = await pool.query(`SELECT capability_revision, authority_epoch, field_dictionary_version,
      dictionary_basis, state
      FROM ${performanceTable(schema, "telemetry_performance_device_capabilities")}
     WHERE participant_id = $1 AND device_id = $2 ORDER BY capability_revision`, [owner.participantId, owner.deviceId]);
  return { authorizations: authorizations.rows, capabilities: capabilities.rows };
}

async function ownerWithManifest(schema, parserVersion, { day = "2026-10-09" } = {}) {
  const owner = await seedPerformanceAccountlessOwner(pool, { schema });
  if (parserVersion !== null) {
    await seedPerformanceV12DayManifest(pool, { schema, owner, chunkDay: day, parserVersion });
  }
  return owner;
}

test("the parser mapping is exact: v18 is 2026-09-21.1, v19 and above 2026-09-29.1, nothing else", { skip }, async () => {
  {
    await setup();
    const resolveParser = policy.resolvePostgresTelemetryPerformanceParserDictionary;
    assert.equal(resolveParser("unified-rollout-typed-v18"), PERFORMANCE_DICTIONARY_2026_09_21);
    for (const generation of ["19", "20", "21", "99", "100", "123456789012345678901234567890"]) {
      assert.equal(resolveParser(`unified-rollout-typed-v${generation}`), PERFORMANCE_DICTIONARY_2026_09_29, generation);
    }
    for (const value of ["unified-rollout-typed-v17", "unified-rollout-typed-v15", "unified-rollout-typed-v1",
      "unified-rollout-typed-v0", "unified-rollout-typed-v018", "unified-rollout-typed-v19x", "unified-rollout-typed-v",
      "unified-rollout-typed-v19 ", " unified-rollout-typed-v19", "unified-rollout-typed-v19\n", "UNIFIED-ROLLOUT-TYPED-V19",
      "unified-rollout-v19", "unified-rollout-typed-v-19", "unified-rollout-typed-v1.9", "", null, undefined, 19, {}]) {
      assert.equal(resolveParser(value), null, JSON.stringify(value));
    }
  }
});

test("the grant body parser accepts only the exact v1 and v2 shapes and accepted dictionaries", { skip }, async () => {
  await setup();
  const parse = policy.parsePostgresTelemetryPerformanceGrantRequest;
  const v1 = parse({ ...V1_BODY });
  assert.deepEqual(v1, { echo: V1_BODY, schemaVersion: V1_BODY.schemaVersion, declaredFieldDictionaryVersion: null });
  assert.equal(JSON.stringify(v1.echo), JSON.stringify(V1_BODY));
  for (const dictionary of Object.keys(PERFORMANCE_FIELD_DICTIONARIES)) {
    const body = v2Body(dictionary);
    const parsed = parse(body);
    assert.equal(parsed.declaredFieldDictionaryVersion, dictionary);
    assert.equal(parsed.schemaVersion, "accountless-performance-owner-v2");
    assert.equal(JSON.stringify(parsed.echo), JSON.stringify(body), "the echo is the exact body, key order included");
  }
  // Any other key set is 400 BODY_INVALID.
  for (const value of [null, [], "v1", 1, {}, { ...V1_BODY, extra: "x" },
    { schemaVersion: V1_BODY.schemaVersion, policyVersion: V1_BODY.policyVersion },
    { ...v2Body(PERFORMANCE_DICTIONARY_2026_10_10), extra: "x" }]) {
    assert.throws(() => parse(value), (error) => error.status === 400 && error.code === "BODY_INVALID",
      JSON.stringify(value));
  }
  // Wrong values, an unknown or non-string dictionary, or a draft one: 403 TELEMETRY_CONSENT_INVALID.
  const refusals = [
    { ...V1_BODY, policyVersion: "accountless-telemetry-performance-policy-v2" },
    { ...V1_BODY, authorizationBasis: "accountless-policy-v1" },
    { ...V1_BODY, schemaVersion: "accountless-performance-owner-v2" },
    { ...v2Body(PERFORMANCE_DICTIONARY_2026_10_10), schemaVersion: "accountless-performance-owner-v1" },
    v2Body("telemetry-performance-registry-2026-12-31.1"),
    v2Body("telemetry-v1.2-registry-2026-09-20.1"),
    v2Body(20261010),
    v2Body(null),
  ];
  for (const value of refusals) {
    assert.throws(() => parse(value), (error) => error.status === 403 && error.code === "TELEMETRY_CONSENT_INVALID",
      JSON.stringify(value));
  }
  const draftRegistry = {
    ...PERFORMANCE_FIELD_DICTIONARIES,
    [PERFORMANCE_DICTIONARY_2026_10_10]: { ...PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_DICTIONARY_2026_10_10], state: "draft" },
  };
  assert.throws(() => parse(v2Body(PERFORMANCE_DICTIONARY_2026_10_10), { dictionaries: draftRegistry }),
    (error) => error.status === 403 && error.code === "TELEMETRY_CONSENT_INVALID");
  assert.equal(parse(v2Body(PERFORMANCE_DICTIONARY_2026_09_29), { dictionaries: draftRegistry })
    .declaredFieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);
  // A registry entry the contract does not know is refused even when injected as accepted.
  const unknown = "telemetry-performance-registry-2026-12-31.1";
  assert.throws(() => parse(v2Body(unknown), { dictionaries: {
    ...PERFORMANCE_FIELD_DICTIONARIES,
    [unknown]: { ...PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_DICTIONARY_2026_10_10], fieldDictionaryVersion: unknown },
  } }), (error) => error.status === 403 && error.code === "TELEMETRY_CONSENT_INVALID");
});

test("the storage gate needs typed storage and the runtime row; driver errors are 503", { skip }, async () => {
  const schema = await staged();
  const typed = { kind: "typed", sourceNamespace: "synthetic-namespace" };
  await policy.assertPostgresTelemetryPerformanceStorage(pool, { schema: { primarySchema: schema }, mode: typed });
  for (const mode of [{ kind: "json" }, { kind: "typed" }, { kind: "typed", sourceNamespace: "" }, null, "typed"]) {
    await apiRejects(policy.assertPostgresTelemetryPerformanceStorage(pool, { schema: { primarySchema: schema }, mode }),
      503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const empty = await newSchemaName("empty");
  await apiRejects(policy.assertPostgresTelemetryPerformanceStorage(pool, { schema: { primarySchema: empty }, mode: typed }),
    503, "BACKEND_STORAGE_UNAVAILABLE");
  const broken = { connect: async () => { throw Object.assign(new Error("synthetic connect failure"), { code: "08006" }); } };
  await apiRejects(policy.assertPostgresTelemetryPerformanceStorage(broken, { schema: { primarySchema: schema }, mode: typed }),
    503, "BACKEND_STORAGE_UNAVAILABLE");
  await apiRejects(policy.assertPostgresTelemetryPerformanceStorage(pool, { schema: { primarySchema: "Bad-Schema" }, mode: typed }),
    503, "BACKEND_STORAGE_UNAVAILABLE");
});

test("a staged runtime refuses every grant and capability with 403 and writes nothing", { skip }, async () => {
  const schema = await staged();
  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await apiRejects(grant(schema, owner, V1_BODY), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(grant(schema, owner, v2Body(PERFORMANCE_DICTIONARY_2026_10_10)), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(capability(schema, owner), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await grantRows(schema, owner), { authorizations: [], capabilities: [] });
  const totals = await pool.query(`SELECT
      (SELECT count(*)::integer FROM ${performanceTable(schema, "accountless_telemetry_performance_authorizations")}) AS authorizations,
      (SELECT count(*)::integer FROM ${performanceTable(schema, "telemetry_performance_device_capabilities")}) AS capabilities`);
  assert.deepEqual(totals.rows[0], { authorizations: 0, capabilities: 0 });
});

test("v1 grants infer the dictionary from the newest v1.2 manifest parser and the capability echoes it", { skip }, async () => {
  const schema = await active();
  const cases = [
    ["unified-rollout-typed-v18", PERFORMANCE_DICTIONARY_2026_09_21],
    ["unified-rollout-typed-v19", PERFORMANCE_DICTIONARY_2026_09_29],
    ["unified-rollout-typed-v20", PERFORMANCE_DICTIONARY_2026_09_29],
    ["unified-rollout-typed-v21", PERFORMANCE_DICTIONARY_2026_09_29],
  ];
  for (const [parserVersion, dictionary] of cases) {
    const owner = await ownerWithManifest(schema, parserVersion);
    const result = await grant(schema, owner, V1_BODY);
    assert.deepEqual({ ...result }, {
      echo: V1_BODY, outcome: "granted", fieldDictionaryVersion: dictionary,
      dictionaryBasis: "v12_parser_inference", capabilityRevision: 1, authorityEpoch: 1,
    }, parserVersion);
    const rows = await grantRows(schema, owner);
    assert.deepEqual(rows.authorizations, [{ capability_revision: 1, authority_epoch: 1, field_dictionary_version: dictionary,
      dictionary_basis: "v12_parser_inference", schema_version: "accountless-performance-owner-v1", state: "active" }]);
    assert.deepEqual(rows.capabilities, [{ capability_revision: 1, authority_epoch: 1, field_dictionary_version: dictionary,
      dictionary_basis: "v12_parser_inference", state: "accepted" }]);
    const read = await capability(schema, owner);
    assert.equal(read.requiredConsent.fieldDictionaryVersion, dictionary, parserVersion);
  }

  // The newest evidence day wins over an older day, and the latest manifest within that day.
  const upgraded = await seedPerformanceAccountlessOwner(pool, { schema });
  const base = Date.now() - 3_600_000;
  await seedPerformanceV12DayManifest(pool, { schema, owner: upgraded, chunkDay: "2026-10-08", parserVersion: "unified-rollout-typed-v20", createdAtEpoch: base + 50_000 });
  await seedPerformanceV12DayManifest(pool, { schema, owner: upgraded, chunkDay: "2026-10-09", parserVersion: "unified-rollout-typed-v19", createdAtEpoch: base });
  await seedPerformanceV12DayManifest(pool, { schema, owner: upgraded, chunkDay: "2026-10-09", parserVersion: "unified-rollout-typed-v18", createdAtEpoch: base + 1_000 });
  assert.equal((await grant(schema, upgraded, V1_BODY)).fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_21);
  await seedPerformanceV12DayManifest(pool, { schema, owner: upgraded, chunkDay: "2026-10-10", parserVersion: "unified-rollout-typed-v20", createdAtEpoch: base + 2_000 });
  const corrected = await grant(schema, upgraded, V1_BODY);
  assert.deepEqual([corrected.outcome, corrected.fieldDictionaryVersion, corrected.capabilityRevision, corrected.authorityEpoch],
    ["granted", PERFORMANCE_DICTIONARY_2026_09_29, 2, 1], "a later manifest corrects the choice on the next grant");

  // Another device's manifest never leaks into this device's inference.
  const neighbour = await seedPerformanceAccountlessOwner(pool, { schema });
  await seedPerformanceV12DayManifest(pool, { schema, owner: neighbour, chunkDay: "2026-10-11", parserVersion: "unified-rollout-typed-v18" });
  const inferred = await pool.connect();
  try {
    assert.equal(await policy.inferPostgresTelemetryPerformanceDictionary(inferred,
      { schema: { primarySchema: schema }, principal: principalOf(upgraded) }), PERFORMANCE_DICTIONARY_2026_09_29);
  } finally {
    inferred.release();
  }
});

test("gate answer 1: an unmapped parser or no manifest gets 2026-09-29.1 by default_no_manifest", { skip }, async () => {
  const schema = await active();
  for (const parserVersion of ["unified-rollout-typed-v17", "unified-rollout-typed-v018", "unified-rollout-typed-v19x",
    "legacy-parser-v19", null]) {
    const owner = await ownerWithManifest(schema, parserVersion);
    const result = await grant(schema, owner, V1_BODY);
    assert.deepEqual([result.outcome, result.fieldDictionaryVersion, result.dictionaryBasis],
      ["granted", PERFORMANCE_DICTIONARY_2026_09_29, "default_no_manifest"], String(parserVersion));
    const rows = await grantRows(schema, owner);
    assert.deepEqual(rows.authorizations.map((row) => [row.field_dictionary_version, row.dictionary_basis, row.schema_version]),
      [[PERFORMANCE_DICTIONARY_2026_09_29, "default_no_manifest", "accountless-performance-owner-v1"]]);
    assert.equal((await capability(schema, owner)).requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);
    const inferred = await pool.connect();
    try {
      assert.equal(await policy.inferPostgresTelemetryPerformanceDictionary(inferred,
        { schema: { primarySchema: schema }, principal: principalOf(owner) }), null);
    } finally {
      inferred.release();
    }
  }
});

test("the inference read is one backward probe of telemetry_v12_manifests_device_day, with no sort", { skip }, async () => {
  const schema = await active();
  const owners = [];
  for (let index = 0; index < 4; index += 1) owners.push(await seedPerformanceAccountlessOwner(pool, { schema }));
  for (const owner of owners) {
    await pool.query(`INSERT INTO ${performanceTable(schema, "telemetry_v12_day_manifests")} (
        id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json,
        expected_chunk_count, state, created_at)
      SELECT gen_random_uuid()::text, $1, $2, DATE '2025-01-01' + series, md5(series::text || $2) || md5($2 || series::text),
             'unified-rollout-typed-v20', '{}', 0, 'staged', TIMESTAMPTZ '2025-01-01 00:00:00+00' + series * interval '1 hour'
        FROM generate_series(1, 600) AS series`, [owner.participantId, owner.deviceId]);
  }
  await pool.query(`ANALYZE ${performanceTable(schema, "telemetry_v12_day_manifests")}`);
  const client = await pool.connect();
  try {
    const captured = [];
    const recording = {
      query(text, values) {
        captured.push({ text, values });
        return client.query(text, values);
      },
      release() {},
    };
    assert.equal(await policy.inferPostgresTelemetryPerformanceDictionary(recording,
      { schema: { primarySchema: schema }, principal: principalOf(owners[1]) }), PERFORMANCE_DICTIONARY_2026_09_29);
    assert.equal(captured.length, 1, "inference is a single statement");
    const explained = await client.query(`EXPLAIN (FORMAT JSON) ${captured[0].text}`, captured[0].values);
    const nodes = [];
    const walk = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(explained.rows[0]["QUERY PLAN"][0].Plan);
    assert.deepEqual(nodes.map((node) => node["Node Type"]), ["Limit", "Index Scan"], JSON.stringify(nodes.map((node) => node["Node Type"])));
    assert.equal(nodes[1]["Index Name"], "telemetry_v12_manifests_device_day");
    assert.equal(nodes[1]["Scan Direction"], "Backward");
    assert.equal(nodes.some((node) => node["Node Type"] === "Sort"), false);
  } finally {
    client.release();
  }
});

test("a declared v2 dictionary wins over inference; a v1.1-only device is served by both bodies", { skip }, async () => {
  const schema = await active();
  const declared = await ownerWithManifest(schema, "unified-rollout-typed-v18");
  const result = await grant(schema, declared, v2Body(PERFORMANCE_DICTIONARY_2026_10_10));
  assert.deepEqual({ ...result }, {
    echo: v2Body(PERFORMANCE_DICTIONARY_2026_10_10), outcome: "granted", fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10,
    dictionaryBasis: "client_declared", capabilityRevision: 1, authorityEpoch: 1,
  });
  assert.equal((await grantRows(schema, declared)).authorizations[0].schema_version, "accountless-performance-owner-v2");
  assert.equal((await capability(schema, declared)).requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_10_10);

  // A device that only ever uploaded v1.1 has no v1.2 manifest.
  const v11Declared = await ownerWithManifest(schema, null);
  assert.equal((await grant(schema, v11Declared, v2Body(PERFORMANCE_DICTIONARY_2026_09_21))).fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_09_21);
  assert.equal((await capability(schema, v11Declared)).requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_21);
  const v11Default = await ownerWithManifest(schema, null);
  const defaulted = await grant(schema, v11Default, V1_BODY);
  assert.deepEqual([defaulted.fieldDictionaryVersion, defaulted.dictionaryBasis],
    [PERFORMANCE_DICTIONARY_2026_09_29, "default_no_manifest"], "gate answer 1: v1 is served, not refused");
});

test("re-grants are idempotent; a dictionary change and an expiry slide each append a revision", { skip }, async () => {
  const schema = await active();
  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v18");
  assert.equal((await grant(schema, owner, V1_BODY)).outcome, "granted");
  const repeat = await grant(schema, owner, V1_BODY);
  assert.deepEqual([repeat.outcome, repeat.capabilityRevision, repeat.authorityEpoch], ["idempotent", 1, 1]);
  const before = await capability(schema, owner);
  assert.equal((await grantRows(schema, owner)).authorizations.length, 1);

  const changed = await grant(schema, owner, v2Body(PERFORMANCE_DICTIONARY_2026_10_10));
  assert.deepEqual([changed.outcome, changed.capabilityRevision, changed.authorityEpoch, changed.fieldDictionaryVersion],
    ["granted", 2, 1, PERFORMANCE_DICTIONARY_2026_10_10], "the latest grant wins and keeps the epoch");
  assert.equal((await grant(schema, owner, v2Body(PERFORMANCE_DICTIONARY_2026_10_10))).outcome, "idempotent");
  const back = await grant(schema, owner, V1_BODY);
  assert.deepEqual([back.outcome, back.capabilityRevision, back.fieldDictionaryVersion, back.dictionaryBasis],
    ["granted", 3, PERFORMANCE_DICTIONARY_2026_09_21, "v12_parser_inference"]);

  const slid = await slidePerformanceOwnerLease(pool, { schema, owner, expiresAtEpoch: Date.parse(owner.expiresAt) + 7 * DAY_MS });
  await apiRejects(capability(schema, slid), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  const renewed = await grant(schema, slid, V1_BODY);
  assert.deepEqual([renewed.outcome, renewed.capabilityRevision, renewed.authorityEpoch], ["granted", 4, 1]);
  const after = await capability(schema, slid);
  assert.equal(after.authorization.expiresAt, slid.expiresAt);
  assert.equal(after.authorization.capabilityRevision, 4);
  assert.notEqual(after.authorization.expiresAt, before.authorization.expiresAt);
  assert.equal((await grant(schema, slid, V1_BODY)).outcome, "idempotent");

  const rows = await grantRows(schema, slid);
  assert.deepEqual(rows.authorizations.map((row) => [row.capability_revision, row.authority_epoch, row.field_dictionary_version, row.state]), [
    [1, 1, PERFORMANCE_DICTIONARY_2026_09_21, "active"],
    [2, 1, PERFORMANCE_DICTIONARY_2026_10_10, "active"],
    [3, 1, PERFORMANCE_DICTIONARY_2026_09_21, "active"],
    [4, 1, PERFORMANCE_DICTIONARY_2026_09_21, "active"],
  ]);
  assert.deepEqual(rows.capabilities.map((row) => [row.capability_revision, row.authority_epoch, row.field_dictionary_version]),
    rows.authorizations.map((row) => [row.capability_revision, row.authority_epoch, row.field_dictionary_version]));
});

test("a revoked tuple is never reactivated: refused while revoked, a fresh epoch afterwards", { skip }, async () => {
  const schema = await active();
  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, owner, V1_BODY);
  const t = (name) => performanceTable(schema, name);
  const revokedAt = performanceInstant(Date.now());
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'revoked', revoked_at = $2::timestamptz,
      revocation_reason = 'user_opt_out' WHERE device_id = $1`, [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("accountless_upload_owners")} SET state = 'revoked', revoked_at = $2::timestamptz,
      revocation_reason = 'user_opt_out' WHERE enrollment_device_id = $1`, [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("accountless_telemetry_performance_authorizations")} SET state = 'revoked',
      revoked_at = $2::timestamptz, revocation_reason = 'user_opt_out' WHERE enrollment_device_id = $1`,
  [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("telemetry_performance_device_capabilities")} SET state = 'revoked', revoked_at = $3::timestamptz
    WHERE participant_id = $1 AND device_id = $2`, [owner.participantId, owner.deviceId, revokedAt]);

  await apiRejects(grant(schema, owner, V1_BODY), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(capability(schema, owner), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual((await grantRows(schema, owner)).authorizations.map((row) => [row.capability_revision, row.state]),
    [[1, "revoked"]]);

  // Synthetic: put the owner graph back without touching the performance rows.
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'active', revoked_at = NULL,
      revocation_reason = NULL WHERE device_id = $1`, [owner.enrollmentDeviceId]);
  await pool.query(`UPDATE ${t("accountless_upload_owners")} SET state = 'active', revoked_at = NULL,
      revocation_reason = NULL WHERE enrollment_device_id = $1`, [owner.enrollmentDeviceId]);
  await apiRejects(capability(schema, owner), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  const fresh = await grant(schema, owner, V1_BODY);
  assert.deepEqual([fresh.outcome, fresh.capabilityRevision, fresh.authorityEpoch], ["granted", 2, 2]);
  const rows = await grantRows(schema, owner);
  assert.deepEqual(rows.authorizations.map((row) => [row.capability_revision, row.authority_epoch, row.state]),
    [[1, 1, "revoked"], [2, 2, "active"]]);
  assert.deepEqual(rows.capabilities.map((row) => [row.capability_revision, row.authority_epoch, row.state]),
    [[1, 1, "revoked"], [2, 2, "accepted"]]);
  assert.equal((await capability(schema, owner)).authorization.authorityEpoch, 2);
});

test("concurrent grants for one device yield one tuple", { skip }, async () => {
  const schema = await active();
  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v19");
  const results = await Promise.all(Array.from({ length: 6 }, () => grant(schema, owner, V1_BODY)));
  assert.deepEqual(results.map((result) => result.outcome).sort(),
    ["granted", "idempotent", "idempotent", "idempotent", "idempotent", "idempotent"]);
  assert.ok(results.every((result) => result.capabilityRevision === 1 && result.authorityEpoch === 1));
  const rows = await grantRows(schema, owner);
  assert.equal(rows.authorizations.length, 1);
  assert.equal(rows.capabilities.length, 1);
});

test("trigger refusals become 403 TELEMETRY_CONSENT_INVALID and driver failures 503, with no write", { skip }, async () => {
  const schema = await active();
  // The owner expired by the database clock, though not by the caller's clock: the
  // policy's own fence passes and the 0079 admission trigger refuses (P1005).
  const lapsed = await seedPerformanceAccountlessOwner(pool, { schema, issuedAtEpoch: Date.now() - 10 * DAY_MS, leaseMs: DAY_MS });
  await apiRejects(grant(schema, lapsed, V1_BODY, { nowEpoch: Date.now() - 10 * DAY_MS + 3_600_000 }),
    403, "TELEMETRY_CONSENT_INVALID");
  assert.deepEqual(await grantRows(schema, lapsed), { authorizations: [], capabilities: [] });
  await apiRejects(grant(schema, lapsed, V1_BODY), 403, "TELEMETRY_TRANSPORT_BLOCKED");

  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  const broken = { connect: async () => { throw Object.assign(new Error("synthetic connect failure"), { code: "08006" }); } };
  await apiRejects(policy.grantPostgresTelemetryPerformanceAccountlessAuthorization(broken, {
    schema: { primarySchema: schema }, principal: principalOf(owner),
    request: policy.parsePostgresTelemetryPerformanceGrantRequest(V1_BODY),
  }), 503, "BACKEND_STORAGE_UNAVAILABLE");
  await apiRejects(policy.readPostgresTelemetryPerformanceCapability(broken, {
    schema: { primarySchema: schema }, principal: principalOf(owner),
  }), 503, "BACKEND_STORAGE_UNAVAILABLE");
  const empty = await newSchemaName("missing");
  await apiRejects(grant(empty, owner, V1_BODY), 503, "BACKEND_STORAGE_UNAVAILABLE");
  await apiRejects(capability(empty, owner), 503, "BACKEND_STORAGE_UNAVAILABLE");
  assert.deepEqual(await grantRows(schema, owner), { authorizations: [], capabilities: [] });

  // A request that is not the parser's output is refused before any read.
  await apiRejects(policy.grantPostgresTelemetryPerformanceAccountlessAuthorization(pool, {
    schema: { primarySchema: schema }, principal: principalOf(owner),
    request: { echo: V1_BODY, schemaVersion: V1_BODY.schemaVersion, declaredFieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10 },
  }), 403, "TELEMETRY_CONSENT_INVALID");
  await apiRejects(policy.grantPostgresTelemetryPerformanceAccountlessAuthorization(pool, {
    schema: { primarySchema: schema }, principal: { participantId: "", deviceId: owner.deviceId },
    request: policy.parsePostgresTelemetryPerformanceGrantRequest(V1_BODY),
  }), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await grantRows(schema, owner), { authorizations: [], capabilities: [] });
});

test("the capability fence refuses every miss with 403", { skip }, async () => {
  const schema = await active();
  const t = (name) => performanceTable(schema, name);
  const ungranted = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await apiRejects(capability(schema, ungranted), 403, "TELEMETRY_TRANSPORT_BLOCKED");

  const owner = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, owner, V1_BODY);
  await capability(schema, owner);
  await apiRejects(capability(schema, owner, { nowEpoch: Date.parse(owner.expiresAt) }), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(capability(schema, { ...owner, deviceId: ungranted.deviceId }), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(capability(schema, { ...owner, participantId: ungranted.participantId }), 403, "TELEMETRY_TRANSPORT_BLOCKED");

  const ownerRevoked = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, ownerRevoked, V1_BODY);
  await pool.query(`UPDATE ${t("accountless_upload_owners")} SET state = 'revoked', revoked_at = now(),
      revocation_reason = 'security_reset' WHERE enrollment_device_id = $1`, [ownerRevoked.enrollmentDeviceId]);
  await apiRejects(capability(schema, ownerRevoked), 403, "TELEMETRY_TRANSPORT_BLOCKED");

  const deviceRevoked = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, deviceRevoked, V1_BODY);
  await pool.query(`UPDATE ${t("device_credentials")} SET state = 'revoked', revoked_at = now() WHERE id = $1`,
    [deviceRevoked.deviceId]);
  await apiRejects(capability(schema, deviceRevoked), 403, "TELEMETRY_TRANSPORT_BLOCKED");

  // A signed-in (social) participant stays excluded, from the capability and the grant.
  const social = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, social, V1_BODY);
  await pool.query(`UPDATE ${t("participants")} SET owner_kind = 'social' WHERE id = $1`, [social.participantId]);
  await apiRejects(capability(schema, social), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await apiRejects(grant(schema, social, v2Body(PERFORMANCE_DICTIONARY_2026_10_10)), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.equal((await grantRows(schema, social)).authorizations.length, 1);
});

test("the capability matches the Worker's response bytes and passes the client's capability check", { skip }, async () => {
  const schema = await active();
  // The legacy D1 Worker is pinned to 2026-09-29.1 on this line (its D1 schema
  // carries ingestion-isolation 0013_performance_ultrafast), so byte parity is
  // checked for a device the origin resolves to that dictionary (parser v19 or
  // later): the same row yields byte-identical capabilities on both.
  const pinned = await ownerWithManifest(schema, "unified-rollout-typed-v20");
  await grant(schema, pinned, V1_BODY);
  const pinnedCapability = await capability(schema, pinned);
  assert.equal(pinnedCapability.authorization.issuedAt.length, 24);
  assert.equal(pinnedCapability.authorization.expiresAt, pinned.expiresAt);
  assert.equal(pinnedCapability.requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);
  const worker = workerPolicy.telemetryPerformanceCapabilityResponse({
    participant_id: pinned.participantId, device_id: pinned.deviceId,
    capability_revision: pinnedCapability.authorization.capabilityRevision,
    authority_epoch: pinnedCapability.authorization.authorityEpoch,
    schema_version: "model-performance-daily-v1", field_dictionary_version: PERFORMANCE_DICTIONARY_2026_09_29,
    privacy_contract_version: "privacy-safe-model-performance-v1", scope: "model-performance-daily", state: "accepted",
    issued_at: pinnedCapability.authorization.issuedAt, expires_at: pinnedCapability.authorization.expiresAt,
    owner_kind: "accountless", authority_kind: "accountless",
  });
  assert.equal(JSON.stringify(pinnedCapability), JSON.stringify(worker),
    "byte-identical to the Worker's capability for the same row");
  workerPolicy.parseTelemetryPerformanceCapability(JSON.parse(JSON.stringify(pinnedCapability)));

  // A device the origin resolves to 2026-09-21.1 (parser v18) keeps that
  // dictionary, which the pinned legacy Worker no longer issues.
  const legacy = await ownerWithManifest(schema, "unified-rollout-typed-v18");
  await grant(schema, legacy, V1_BODY);
  const ours = await capability(schema, legacy);
  assert.equal(ours.authorization.issuedAt.length, 24);
  assert.equal(ours.authorization.expiresAt, legacy.expiresAt);
  assert.equal(ours.requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_21);

  // The client on this line emits PERFORMANCE_FIELD_DICTIONARY_VERSION: its own
  // capability() accepts a capability for that dictionary and refuses another.
  const runClient = async (cap) => {
    const seen = [];
    const result = await runTelemetryPerformanceSync({
      day: "2026-10-10",
      nowEpoch: Date.now(),
      readCapabilities: async () => JSON.parse(JSON.stringify(cap)),
      prepareDay: async ({ capability: accepted }) => {
        seen.push(accepted);
        throw new Error("synthetic stop after the capability check");
      },
      createEnvelope: async () => { throw new Error("unreachable"); },
      send: async () => { throw new Error("unreachable"); },
    });
    return { seen, result };
  };
  const current = PERFORMANCE_FIELD_DICTIONARY_VERSION === PERFORMANCE_DICTIONARY_2026_09_29
    ? await ownerWithManifest(schema, "unified-rollout-typed-v20")
    : await ownerWithManifest(schema, null);
  if (PERFORMANCE_FIELD_DICTIONARY_VERSION === PERFORMANCE_DICTIONARY_2026_09_29) {
    await grant(schema, current, V1_BODY);
  } else {
    await grant(schema, current, v2Body(PERFORMANCE_FIELD_DICTIONARY_VERSION));
  }
  const accepted = await capability(schema, current);
  assert.equal(accepted.requiredConsent.fieldDictionaryVersion, PERFORMANCE_FIELD_DICTIONARY_VERSION);
  const run = await runClient(accepted);
  assert.equal(run.seen.length, 1, "the client accepted the capability and asked for the day report");
  assert.deepEqual(run.seen[0], JSON.parse(JSON.stringify(accepted)));
  assert.equal(run.result.state.lastOutcome.code, "report_invalid");

  const mismatched = await runClient(ours.requiredConsent.fieldDictionaryVersion === PERFORMANCE_FIELD_DICTIONARY_VERSION
    ? accepted : ours);
  if (ours.requiredConsent.fieldDictionaryVersion !== PERFORMANCE_FIELD_DICTIONARY_VERSION) {
    assert.equal(mismatched.seen.length, 0);
    assert.equal(mismatched.result.state.lastOutcome.code, "response_invalid");
  }
});
