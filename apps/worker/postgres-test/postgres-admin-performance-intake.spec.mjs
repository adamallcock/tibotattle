// PostgreSQL 17 spec for src/postgres-admin-performance-intake.ts (the
// 'admin-performance-intake-v0.1' read model) and the admin route that serves
// it (cloud-run/routes/admin-performance-intake.mjs).
//
// Every schema is built through the production runner on the promoted
// primary chain (applyPostgresMigrations), which ends at 0079; the
// pre-migration case uses promoted-migration-prefix.mjs applyMigrationsBefore.
// Rows are synthetic and content-free, written through the live guards with
// the shared SPD-G1 fixtures (fixtures/performance-telemetry.mjs). Each test
// drops only the schemas it created (prefix a1_intake_).
//
// The synthetic clock is fixed in 2035, so every seeded expiry stays in the
// database's future (the triggers compare expiries to now()) while the read
// model's windows derive only from the nowEpoch the test passes.
//
// It proves exact DTO equality over the seeded rows (ADMIN_PERFORMANCE_INTAKE_FIXTURE
// below is the contract fixture SPD-E3 copies), the window and unit semantics
// at every boundary, expiry by nowEpoch, separate superseded counts, the
// empty state (explicit nulls, no invented values), the single REPEATABLE
// READ READ ONLY snapshot, 503 on an absent runtime row, a pre-0079 schema,
// a malformed value, invalid options or a failing pool, the route over the
// real reader, and a negative scan: no seeded id, digest or revision appears
// in the body.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test --test-concurrency=1 postgres-test/postgres-admin-performance-intake.spec.mjs
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { PERFORMANCE_FIELD_DICTIONARIES } from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  ensurePerformanceFixtureKernel,
  insertPerformanceGrant,
  insertPerformancePublicationHead,
  insertPerformanceReport,
  performanceInstant,
  performanceTable,
  seedPerformanceAccountlessOwner,
  syntheticCommunityModelPerformancePayload,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

const APPLICATION_NAME = "a1-admin-performance-intake";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2035-06-15T12:00:00.000Z");
const FROM_INSTANT = Date.parse("2034-05-12T00:00:00.000Z");
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HISTORY_SHA256 = "ab".repeat(32);
const OWNER = "owner@example.invalid";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const ROUTE_CLASSES = Object.freeze({
  telemetry_performance_reports: "performance",
  accountless_telemetry_performance_authorization: "performance",
  telemetry_performance_capabilities: "performance",
  community_model_performance: "scope",
});
const SECOND_MODEL = Object.freeze({ provider: "openai_codex", modelId: "gpt-6.1-sol" });

/**
 * The contract fixture: the exact 'admin-performance-intake-v0.1' body for
 * the rows seedIntake writes, read at NOW with ROUTE_CLASSES, SOURCE_COMMIT,
 * HISTORY_SHA256 and the contract's PERFORMANCE_FIELD_DICTIONARIES. Plain
 * JSON, content-free; SPD-E3 copies it for the admin UI.
 */
const ADMIN_PERFORMANCE_INTAKE_FIXTURE = Object.freeze(JSON.parse(`{
  "schemaVersion": "admin-performance-intake-v0.1",
  "generatedAt": "2035-06-15T12:00:00.000Z",
  "windows": {
    "days": 400,
    "from": "2034-05-12",
    "through": "2035-06-15",
    "last24HoursFrom": "2035-06-14T12:00:00.000Z",
    "last7DaysFrom": "2035-06-08T12:00:00.000Z"
  },
  "routes": [
    { "routeId": "accountless_telemetry_performance_authorization", "routeClass": "performance" },
    { "routeId": "community_model_performance", "routeClass": "scope" },
    { "routeId": "telemetry_performance_capabilities", "routeClass": "performance" },
    { "routeId": "telemetry_performance_reports", "routeClass": "performance" }
  ],
  "deployment": {
    "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
    "historySha256": "abababababababababababababababababababababababababababababababab"
  },
  "runtime": {
    "state": "active",
    "policyRevision": 2,
    "schemaVersion": "model-performance-daily-v1",
    "privacyContractVersion": "privacy-safe-model-performance-v1",
    "methodVersion": "performance-daily-histogram-v1",
    "updatedAt": "2035-06-05T12:00:00.000Z"
  },
  "dictionaries": [
    { "fieldDictionaryVersion": "telemetry-performance-registry-2026-09-21.1",
      "bucketSchemeVersion": "performance-histogram-v1", "contractState": "accepted" },
    { "fieldDictionaryVersion": "telemetry-performance-registry-2026-09-29.1",
      "bucketSchemeVersion": "performance-histogram-v1", "contractState": "accepted" },
    { "fieldDictionaryVersion": "telemetry-performance-registry-2026-10-10.1",
      "bucketSchemeVersion": "performance-histogram-v2", "contractState": "accepted" }
  ],
  "grants": {
    "active": 2,
    "expired": 2,
    "revoked": 1,
    "total": 5,
    "authorizedLast24Hours": 2,
    "authorizedLast7Days": 4,
    "activeByDictionary": [
      { "fieldDictionaryVersion": "telemetry-performance-registry-2026-09-21.1",
        "dictionaryBasis": "v12_parser_inference", "devices": 1 },
      { "fieldDictionaryVersion": "telemetry-performance-registry-2026-10-10.1",
        "dictionaryBasis": "client_declared", "devices": 1 }
    ]
  },
  "capabilities": { "active": 2, "expired": 2, "revoked": 1 },
  "reports": {
    "current": 9,
    "superseded": 1,
    "contributors": 5,
    "devices": 5,
    "latestReportDay": "2035-06-16",
    "latestAcceptedAt": "2035-06-15T12:00:00.001Z",
    "byEvidenceDay": [
      { "day": "2034-05-12", "current": 1, "superseded": 0, "records": 1 },
      { "day": "2035-06-10", "current": 1, "superseded": 0, "records": 1 },
      { "day": "2035-06-12", "current": 1, "superseded": 0, "records": 1 },
      { "day": "2035-06-13", "current": 1, "superseded": 0, "records": 1 },
      { "day": "2035-06-14", "current": 1, "superseded": 1, "records": 2 },
      { "day": "2035-06-15", "current": 2, "superseded": 0, "records": 3 }
    ],
    "byArrivalDay": [
      { "day": "2035-06-13", "accepted": 1, "replaced": 0 },
      { "day": "2035-06-14", "accepted": 1, "replaced": 0 },
      { "day": "2035-06-15", "accepted": 5, "replaced": 1 }
    ],
    "byDictionary": [
      { "fieldDictionaryVersion": "telemetry-performance-registry-2026-09-21.1",
        "current": 5, "superseded": 0, "records": 4 },
      { "fieldDictionaryVersion": "telemetry-performance-registry-2026-09-29.1",
        "current": 2, "superseded": 1, "records": 2 },
      { "fieldDictionaryVersion": "telemetry-performance-registry-2026-10-10.1",
        "current": 2, "superseded": 0, "records": 5 }
    ],
    "outsideWindow": { "evidenceBefore": 1, "evidenceAfter": 1, "arrivalBefore": 1, "arrivalAfter": 1 }
  },
  "cohorts": {
    "bySpeedMode": [
      { "speedMode": "fast", "cohorts": 2, "turns": 7 },
      { "speedMode": "mixed", "cohorts": 1, "turns": 6 },
      { "speedMode": "other", "cohorts": 1, "turns": 2 },
      { "speedMode": "standard", "cohorts": 3, "turns": 8 },
      { "speedMode": "ultrafast", "cohorts": 1, "turns": 4 },
      { "speedMode": "unknown", "cohorts": 1, "turns": 7 }
    ],
    "byModel": [
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "fast", "cohorts": 1, "turns": 5 },
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "mixed", "cohorts": 1, "turns": 6 },
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "other", "cohorts": 1, "turns": 2 },
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "standard", "cohorts": 3, "turns": 8 },
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "ultrafast", "cohorts": 1, "turns": 4 },
      { "provider": "openai_codex", "modelId": "gpt-5.5", "speedMode": "unknown", "cohorts": 1, "turns": 7 },
      { "provider": "openai_codex", "modelId": "gpt-6.1-sol", "speedMode": "fast", "cohorts": 1, "turns": 2 }
    ],
    "excludedFromPublicationTurns": 15
  },
  "refusals": {
    "last24Hours": 9,
    "byDay": [
      { "day": "2034-05-12", "routeId": "telemetry_performance_capabilities",
        "code": "TELEMETRY_TRANSPORT_BLOCKED", "status": 403, "refusals": 1 },
      { "day": "2035-06-13", "routeId": "accountless_telemetry_performance_authorization",
        "code": "TELEMETRY_CONSENT_INVALID", "status": 403, "refusals": 1 },
      { "day": "2035-06-14", "routeId": "telemetry_performance_reports",
        "code": "TELEMETRY_RECORD_INVALID_SHAPE", "status": 409, "refusals": 2 },
      { "day": "2035-06-15", "routeId": "telemetry_performance_capabilities",
        "code": "TELEMETRY_TRANSPORT_BLOCKED", "status": 403, "refusals": 7 }
    ],
    "outsideWindow": { "before": 4, "after": 3 }
  },
  "publication": {
    "slots": [
      { "period": "1", "speedMode": "standard", "revision": 2, "releasedAt": "2035-06-13T12:00:00.000Z",
        "end": "2035-06-13", "kernelId": 1 },
      { "period": "7", "speedMode": "fast", "revision": 3, "releasedAt": "2035-06-14T12:00:00.000Z",
        "end": "2035-06-13", "kernelId": 1 }
    ],
    "lastRun": {
      "finishedAt": "2035-06-14T12:00:00.000Z",
      "published": ["7:fast"],
      "unchanged": ["1:standard"],
      "withheld": null,
      "deferredEmpty": false
    }
  }
}`));

let pool;
let vite;
let modules;
const created = [];
let seeded;

after(async () => {
  if (pool) {
    for (const schema of created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

async function setup() {
  if (!modules) {
    vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    modules = {
      intake: await vite.ssrLoadModule("/src/postgres-admin-performance-intake.ts"),
      route: await vite.ssrLoadModule("/cloud-run/routes/admin-performance-intake.mjs"),
      activation: await vite.ssrLoadModule("/src/postgres-telemetry-runtime-activation.ts"),
      runtime: await vite.ssrLoadModule("/src/postgres-runtime-schema.ts"),
    };
  }
  if (pool) return;
  pool = new pg.Pool({ ...endpoint, max: 10, application_name: APPLICATION_NAME, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
}

async function newSchemaName(label) {
  await setup();
  const schema = `a1_intake_${label}_${randomBytes(4).toString("hex")}`;
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

function options(schema, overrides = {}) {
  return {
    schema: { primarySchema: schema },
    nowEpoch: NOW,
    routeClasses: ROUTE_CLASSES,
    deployment: { sourceCommit: SOURCE_COMMIT, historySha256: HISTORY_SHA256 },
    contractDictionaries: PERFORMANCE_FIELD_DICTIONARIES,
    ...overrides,
  };
}

function read(schema, overrides = {}, db = pool) {
  return modules.intake.readPostgresAdminPerformanceIntake(db, options(schema, overrides));
}

/** A JSON round trip: the body exactly as the route serializes it. */
function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

async function expectUnavailable(promise) {
  await assert.rejects(promise, (error) => error?.name === "ApiError" && error.status === 503
    && error.code === "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE" && error.publicDetails === null);
}

const record = (fieldDictionaryVersion, day, extra = {}) => syntheticPerformanceRecord({
  day, fieldDictionaryVersion, ...extra,
});
const unknownMode = { speedMode: "unknown", speedModeSource: "unobserved", apiServiceTier: "unknown" };
const fastMode = { speedMode: "fast", apiServiceTier: "priority" };
const ultrafastMode = { speedMode: "ultrafast", apiServiceTier: "ultrafast" };
const mixedMode = { speedMode: "mixed", speedModeSource: "mixed", apiServiceTier: "mixed" };
const otherMode = { speedMode: "other", apiServiceTier: "other" };

async function revokeOwner(schema, owner, revokedAtEpoch) {
  const t = (name) => performanceTable(schema, name);
  const revokedAt = performanceInstant(revokedAtEpoch);
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'revoked', revoked_at = $2::timestamptz,
      revocation_reason = 'user_opt_out' WHERE device_id = $1`, [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("accountless_upload_owners")} SET state = 'revoked', revoked_at = $2::timestamptz,
      revocation_reason = 'user_opt_out' WHERE enrollment_device_id = $1`, [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("accountless_telemetry_performance_authorizations")} SET state = 'revoked',
      revoked_at = $2::timestamptz, revocation_reason = 'user_opt_out' WHERE enrollment_device_id = $1`,
  [owner.enrollmentDeviceId, revokedAt]);
  await pool.query(`UPDATE ${t("telemetry_performance_device_capabilities")} SET state = 'revoked',
      revoked_at = $3::timestamptz WHERE participant_id = $1 AND device_id = $2`,
  [owner.participantId, owner.deviceId, revokedAt]);
}

async function insertRun(schema, { finishedAtEpoch, performance, kernelId }) {
  const publication = { published: [], unchanged: [], blocked: [], ownerSets: [],
    ...(performance === undefined ? {} : { performance }) };
  await pool.query(`INSERT INTO ${performanceTable(schema, "analytics_v2_runs")}
      (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings,
       kernel_id, manifest_version, exclusions_sha256)
    VALUES ($1::uuid, $2::timestamptz, $2::timestamptz, 'full', 'complete', 0, 0, '[]', $3::jsonb, '{}',
      $4, 1, $5)`,
  [randomUUID(), performanceInstant(finishedAtEpoch), JSON.stringify(publication), kernelId, "cd".repeat(32)]);
}

/**
 * Seed the fixture's rows: five accountless owners (active, expired,
 * revoked, expiring exactly at NOW, active), ten reports across the three
 * dictionaries (one superseded; one tombstone; one before and one after the
 * window; arrivals before, at and after the window edges), six refusal
 * rows, two publication heads and three analytics runs.
 */
async function seedIntake() {
  if (seeded) return seeded;
  const schema = await promotedSchema("seeded");
  const t = (name) => performanceTable(schema, name);
  await activatePerformanceRuntime(pool, { schema, nowEpoch: NOW - 10 * DAY });
  const owner = (leaseDays) => seedPerformanceAccountlessOwner(pool, {
    schema, issuedAtEpoch: NOW - 30 * DAY, leaseMs: leaseDays * DAY });
  const a = await owner(40);
  const b = await owner(29);
  const c = await owner(40);
  const d = await owner(30);
  const e = await owner(40);

  // A: a v1.2-inferred 2026-09-29.1 grant, a first report for 06-14, then a
  // declared 2026-10-10.1 grant whose report replaces it, and one for 06-15.
  const a1 = await insertPerformanceGrant(pool, { schema, owner: a, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    dictionaryBasis: "v12_parser_inference", nowEpoch: NOW - 20 * DAY });
  await insertPerformanceReport(pool, { schema, owner: a, grant: a1, reportDay: "2035-06-14", sourceRevision: 1,
    records: [record(PERFORMANCE_DICTIONARY_2026_09_29, "2035-06-14", { turns: 2 })], nowEpoch: NOW - 30 * HOUR });
  const a2 = await insertPerformanceGrant(pool, { schema, owner: a, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10,
    dictionaryBasis: "client_declared", nowEpoch: NOW - 12 * HOUR });
  await insertPerformanceReport(pool, { schema, owner: a, grant: a2, reportDay: "2035-06-14", sourceRevision: 2,
    records: [
      record(PERFORMANCE_DICTIONARY_2026_10_10, "2035-06-14", { turns: 4 }),
      record(PERFORMANCE_DICTIONARY_2026_10_10, "2035-06-14", { turns: 7, ...unknownMode }),
    ], nowEpoch: NOW - 6 * HOUR });
  await insertPerformanceReport(pool, { schema, owner: a, grant: a2, reportDay: "2035-06-15",
    records: [
      record(PERFORMANCE_DICTIONARY_2026_10_10, "2035-06-15", { turns: 3 }),
      record(PERFORMANCE_DICTIONARY_2026_10_10, "2035-06-15", { turns: 5, ...fastMode }),
      record(PERFORMANCE_DICTIONARY_2026_10_10, "2035-06-15", { turns: 2, ...fastMode, ...SECOND_MODEL }),
    ], nowEpoch: NOW - HOUR });

  // B: the 2026-09-29.1 default (no manifest); its lease ended a day before NOW.
  const bGrant = await insertPerformanceGrant(pool, { schema, owner: b, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    dictionaryBasis: "default_no_manifest", nowEpoch: NOW - 3 * DAY });
  await insertPerformanceReport(pool, { schema, owner: b, grant: bGrant, reportDay: "2035-06-13",
    records: [record(PERFORMANCE_DICTIONARY_2026_09_29, "2035-06-13", { turns: 4, ...ultrafastMode })],
    nowEpoch: NOW - 2 * DAY });

  // C: 2026-09-21.1, a report that arrives 1 ms after NOW, then revoked.
  const cGrant = await insertPerformanceGrant(pool, { schema, owner: c, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21,
    dictionaryBasis: "v12_parser_inference", nowEpoch: NOW - 25 * DAY });
  await insertPerformanceReport(pool, { schema, owner: c, grant: cGrant, reportDay: "2035-06-12",
    records: [record(PERFORMANCE_DICTIONARY_2026_09_21, "2035-06-12", { turns: 6, ...mixedMode })],
    nowEpoch: NOW + 1 });
  await revokeOwner(schema, c, NOW - DAY);

  // D: expires exactly at NOW; authorized exactly 24 h before NOW; a receipt
  // 1 ms before the window opens.
  const dGrant = await insertPerformanceGrant(pool, { schema, owner: d, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    dictionaryBasis: "default_no_manifest", nowEpoch: NOW - 24 * HOUR });
  await insertPerformanceReport(pool, { schema, owner: d, grant: dGrant, reportDay: "2035-06-10",
    records: [record(PERFORMANCE_DICTIONARY_2026_09_29, "2035-06-10", { turns: 2, ...otherMode })],
    nowEpoch: FROM_INSTANT - 1 });

  // E: authorized 24 h - 1 ms before NOW; reports on the window's first day,
  // the day before it, the day after it, and a tombstone arriving at NOW.
  const eGrant = await insertPerformanceGrant(pool, { schema, owner: e, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21,
    dictionaryBasis: "v12_parser_inference", nowEpoch: NOW - 24 * HOUR + 1 });
  for (const [reportDay, turns, ago] of [["2034-05-12", 1, 2], ["2034-05-11", 9, 3], ["2035-06-16", 8, 4]]) {
    await insertPerformanceReport(pool, { schema, owner: e, grant: eGrant, reportDay,
      records: [record(PERFORMANCE_DICTIONARY_2026_09_21, reportDay, { turns })], nowEpoch: NOW - ago * HOUR });
  }
  await insertPerformanceReport(pool, { schema, owner: e, grant: eGrant, reportDay: "2035-06-15", records: [],
    nowEpoch: NOW });

  for (const [day, routeId, code, status, refusals] of [
    ["2035-06-15", "telemetry_performance_capabilities", "TELEMETRY_TRANSPORT_BLOCKED", 403, 7],
    ["2035-06-14", "telemetry_performance_reports", "TELEMETRY_RECORD_INVALID_SHAPE", 409, 2],
    ["2035-06-13", "accountless_telemetry_performance_authorization", "TELEMETRY_CONSENT_INVALID", 403, 1],
    ["2034-05-12", "telemetry_performance_capabilities", "TELEMETRY_TRANSPORT_BLOCKED", 403, 1],
    ["2034-05-11", "telemetry_performance_capabilities", "TELEMETRY_TRANSPORT_BLOCKED", 403, 4],
    ["2035-06-16", "telemetry_performance_reports", "TELEMETRY_RECORD_INVALID_SHAPE", 409, 3],
  ]) {
    await pool.query(`INSERT INTO ${t("telemetry_performance_refusal_counts")} (day, route_id, code, status, refusals)
      VALUES ($1::date, $2, $3, $4, $5)`, [day, routeId, code, status, refusals]);
  }

  const kernelId = await ensurePerformanceFixtureKernel(pool, { schema });
  // Inserted out of slot order: the read model orders them.
  await insertPerformancePublicationHead(pool, { schema, kernelId, releasedAtEpoch: NOW - DAY,
    payload: syntheticCommunityModelPerformancePayload({ period: "7", speedMode: "fast", revision: 3, end: "2035-06-13" }) });
  await insertPerformancePublicationHead(pool, { schema, kernelId, releasedAtEpoch: NOW - 2 * DAY,
    payload: syntheticCommunityModelPerformancePayload({ period: "1", speedMode: "standard", revision: 2, end: "2035-06-13" }) });
  await insertRun(schema, { kernelId, finishedAtEpoch: NOW - 2 * DAY,
    performance: { published: ["1:standard"], unchanged: [], withheld: null, deferredEmpty: false } });
  await insertRun(schema, { kernelId, finishedAtEpoch: NOW - DAY,
    performance: { published: ["7:fast"], unchanged: ["1:standard"], withheld: null, deferredEmpty: false } });
  // The newest run carried no performance block: lastRun skips it.
  await insertRun(schema, { kernelId, finishedAtEpoch: NOW - HOUR });
  seeded = Object.freeze({ schema, owners: Object.freeze({ a, b, c, d, e }), kernelId });
  return seeded;
}

// ---------------------------------------------------------------------------

test("exact DTO equality over the synthetic rows (the SPD-E3 contract fixture)", { skip }, async () => {
  const { schema, kernelId } = await seedIntake();
  assert.equal(kernelId, 1);
  const body = await read(schema);
  assert.deepEqual(wire(body), ADMIN_PERFORMANCE_INTAKE_FIXTURE);
  // Key order is part of the wire contract the admin UI renders.
  assert.equal(JSON.stringify(body), JSON.stringify(ADMIN_PERFORMANCE_INTAKE_FIXTURE));
  assert.ok(Object.isFrozen(body) && Object.isFrozen(body.reports.byEvidenceDay));
});

test("superseded reports are counted apart from current ones, per state, day and dictionary", { skip }, async () => {
  const { schema } = await seedIntake();
  const { reports } = await read(schema);
  const counts = await pool.query(`SELECT state, count(*)::int AS n FROM ${performanceTable(schema, "telemetry_performance_reports")}
    GROUP BY state ORDER BY state`);
  assert.deepEqual(counts.rows, [{ state: "current", n: 9 }, { state: "superseded", n: 1 }]);
  assert.equal(reports.current, 9);
  assert.equal(reports.superseded, 1);
  // The replaced 06-14 report is superseded on its evidence day and under its own dictionary (2026-09-29.1);
  // its records are not added to the day's or the dictionary's records.
  assert.deepEqual(reports.byEvidenceDay.find((row) => row.day === "2035-06-14"),
    { day: "2035-06-14", current: 1, superseded: 1, records: 2 });
  assert.deepEqual(reports.byDictionary.find((row) => row.fieldDictionaryVersion === PERFORMANCE_DICTIONARY_2026_09_29),
    { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29, current: 2, superseded: 1, records: 2 });
  // Its receipt is the arrival's 'replaced' outcome.
  assert.equal(reports.byArrivalDay.reduce((sum, row) => sum + row.replaced, 0), 1);
});

test("window and unit semantics at every boundary", { skip }, async () => {
  const { schema } = await seedIntake();
  const body = await read(schema);
  // 400 UTC days ending on the day of nowEpoch.
  assert.equal((Date.parse(`${body.windows.through}T00:00:00Z`) - Date.parse(`${body.windows.from}T00:00:00Z`)) / DAY + 1, 400);
  // Evidence: 2034-05-12 (first day) is in; 2034-05-11 and 2035-06-16 are counted outside, not dropped.
  assert.equal(body.reports.byEvidenceDay[0].day, "2034-05-12");
  assert.equal(body.reports.outsideWindow.evidenceBefore, 1);
  assert.equal(body.reports.outsideWindow.evidenceAfter, 1);
  // Arrivals: a receipt exactly at nowEpoch is in; 1 ms after is outside; 1 ms before the window is outside.
  assert.equal(body.reports.outsideWindow.arrivalAfter, 1);
  assert.equal(body.reports.outsideWindow.arrivalBefore, 1);
  // Cohorts read only current reports inside the window (E's 9 and 8 turns lie outside).
  assert.equal(body.cohorts.bySpeedMode.find((row) => row.speedMode === "standard").turns, 8);
  // Grant windows are (now - w, now]: exactly 24 h before is out of the 24 h count, 1 ms later is in.
  assert.equal(body.grants.authorizedLast24Hours, 2);
  assert.equal(body.grants.authorizedLast7Days, 4);
  // Refusal counters are per UTC day: last24Hours sums the days overlapping (now - 24 h, now].
  assert.equal(body.refusals.last24Hours, 9);
  assert.deepEqual(body.refusals.outsideWindow, { before: 4, after: 3 });
  // Units: turns and records are integer counts, statuses are integers, instants are UTC milliseconds.
  for (const row of body.refusals.byDay) assert.ok(Number.isSafeInteger(row.status) && Number.isSafeInteger(row.refusals));
  assert.match(body.reports.latestAcceptedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

  // One millisecond later E's grant (authorized 24 h - 1 ms before NOW) sits on the open bound and drops
  // out, and C's receipt (1 ms after NOW) arrives inside the window.
  const later = await read(schema, { nowEpoch: NOW + 1 });
  assert.equal(later.grants.authorizedLast24Hours, 1);
  assert.equal(later.reports.outsideWindow.arrivalAfter, 0);
  assert.equal(later.reports.byArrivalDay.at(-1).accepted, 6);
  // At the next UTC day the window slides by one day and 2034-05-12 falls out.
  const nextDay = await read(schema, { nowEpoch: Date.parse("2035-06-16T00:00:00.000Z") });
  assert.equal(nextDay.windows.from, "2034-05-13");
  assert.equal(nextDay.windows.through, "2035-06-16");
  assert.equal(nextDay.reports.outsideWindow.evidenceBefore, 2);
  assert.equal(nextDay.reports.outsideWindow.evidenceAfter, 0);
  assert.equal(nextDay.refusals.outsideWindow.before, 5);
  assert.equal(nextDay.refusals.outsideWindow.after, 0);
});

test("expiry follows nowEpoch: expires_at <= now is expired, never active", { skip }, async () => {
  const { schema } = await seedIntake();
  const atNow = await read(schema);
  assert.deepEqual([atNow.grants.active, atNow.grants.expired, atNow.grants.revoked], [2, 2, 1]);
  assert.deepEqual(atNow.capabilities, { active: 2, expired: 2, revoked: 1 });
  // 1 ms before NOW, D (expiring exactly at NOW) is still active; B ended a day earlier.
  const justBefore = await read(schema, { nowEpoch: NOW - 1 });
  assert.deepEqual([justBefore.grants.active, justBefore.grants.expired], [3, 1]);
  assert.deepEqual(justBefore.capabilities, { active: 3, expired: 1, revoked: 1 });
  assert.deepEqual(justBefore.grants.activeByDictionary.map((row) => [row.dictionaryBasis, row.devices]),
    [["v12_parser_inference", 1], ["default_no_manifest", 1], ["client_declared", 1]]);
  // Two days earlier B is active too; the revoked head stays revoked whatever the clock.
  const earlier = await read(schema, { nowEpoch: NOW - 2 * DAY });
  assert.deepEqual([earlier.grants.active, earlier.grants.expired, earlier.grants.revoked], [4, 0, 1]);
  // Eleven days later every lease has ended.
  const after11 = await read(schema, { nowEpoch: NOW + 11 * DAY });
  assert.deepEqual([after11.grants.active, after11.grants.expired, after11.grants.revoked, after11.grants.total],
    [0, 4, 1, 5]);
  assert.deepEqual(after11.grants.activeByDictionary, []);
  assert.deepEqual(after11.capabilities, { active: 0, expired: 4, revoked: 1 });
});

test("the empty promoted chain: staged runtime, explicit nulls and empty series", { skip }, async () => {
  const schema = await promotedSchema("empty");
  const body = wire(await read(schema));
  assert.deepEqual(body.runtime, {
    state: "staged", policyRevision: 1, schemaVersion: "model-performance-daily-v1",
    privacyContractVersion: "privacy-safe-model-performance-v1", methodVersion: "performance-daily-histogram-v1",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.deepEqual(body.dictionaries, ADMIN_PERFORMANCE_INTAKE_FIXTURE.dictionaries);
  assert.deepEqual(body.grants, { active: 0, expired: 0, revoked: 0, total: 0, authorizedLast24Hours: 0,
    authorizedLast7Days: 0, activeByDictionary: [] });
  assert.deepEqual(body.capabilities, { active: 0, expired: 0, revoked: 0 });
  assert.deepEqual(body.reports, { current: 0, superseded: 0, contributors: 0, devices: 0, latestReportDay: null,
    latestAcceptedAt: null, byEvidenceDay: [], byArrivalDay: [], byDictionary: [],
    outsideWindow: { evidenceBefore: 0, evidenceAfter: 0, arrivalBefore: 0, arrivalAfter: 0 } });
  assert.deepEqual(body.cohorts, { bySpeedMode: [], byModel: [], excludedFromPublicationTurns: 0 });
  assert.deepEqual(body.refusals, { last24Hours: 0, byDay: [], outsideWindow: { before: 0, after: 0 } });
  assert.deepEqual(body.publication, { slots: [], lastRun: null });
});

test("dictionary contract state is read from the injected contract; a registry row it lacks is 'absent'", { skip }, async () => {
  const { schema } = await seedIntake();
  const contract = Object.fromEntries(Object.entries(PERFORMANCE_FIELD_DICTIONARIES)
    .filter(([version]) => version !== PERFORMANCE_DICTIONARY_2026_10_10)
    .map(([version, entry]) => [version, version === PERFORMANCE_DICTIONARY_2026_09_21 ? { ...entry, state: "draft" } : entry]));
  const body = await read(schema, { contractDictionaries: contract });
  assert.deepEqual(body.dictionaries.map((row) => row.contractState), ["draft", "accepted", "absent"]);
});

test("deployment echoes the migrate receipt digest SPD-G5 computes and a null commit", { skip }, async () => {
  const { schema } = await seedIntake();
  const historySha256 = await modules.activation.postgresRuntimeMigrationHistorySha256(
    modules.runtime.POSTGRES_RUNTIME_MIGRATIONS.primary);
  const body = await read(schema, { deployment: { sourceCommit: null, historySha256 } });
  assert.deepEqual(body.deployment, { sourceCommit: null, historySha256 });
});

test("one REPEATABLE READ READ ONLY snapshot with the 10 s statement and 5 s lock timeouts", { skip }, async () => {
  const { schema } = await seedIntake();
  const statements = [];
  const recording = {
    async connect() {
      const client = await pool.connect();
      return {
        query(text, values) {
          statements.push(text);
          return client.query(text, values);
        },
        release(discard) { client.release(discard); },
      };
    },
  };
  await read(schema, {}, recording);
  assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements[1], "SET LOCAL statement_timeout='10000ms'");
  assert.equal(statements[2], "SET LOCAL lock_timeout='5000ms'");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.filter((text) => /^(BEGIN|COMMIT)/u.test(text)).length, 2);
  // Read-only: no statement writes.
  assert.equal(statements.some((text) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/u.test(text)), false);
  // latestAcceptedAt is a one-entry read of the receipts' acceptance-instant index (SPD-G1).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query(`EXPLAIN SELECT max(created_at) FROM ${performanceTable(schema, "telemetry_performance_receipts")}`);
    assert.match(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"), /telemetry_performance_receipts_accepted_at/u);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("an absent runtime row is 503, never 'staged'", { skip }, async () => {
  const schema = await promotedSchema("noruntime");
  const runtime = performanceTable(schema, "telemetry_performance_runtime");
  // The guard refuses DELETE; the test (as superuser) bypasses it in this throwaway schema only.
  await pool.query(`ALTER TABLE ${runtime} DISABLE TRIGGER telemetry_performance_runtime_guard`);
  await pool.query(`DELETE FROM ${runtime}`);
  await pool.query(`ALTER TABLE ${runtime} ENABLE TRIGGER telemetry_performance_runtime_guard`);
  await expectUnavailable(read(schema));
});

test("a schema before 0079 is 503", { skip }, async () => {
  const schema = await newSchemaName("pre0079");
  await applyMigrationsBefore({ role: "primary", schema, pool, name: PERFORMANCE_MIGRATION_NAME });
  await expectUnavailable(read(schema));
});

test("a malformed stored value is 503 (strict coercers)", { skip }, async () => {
  const { schema } = await seedIntake();
  const tampering = (column, value) => ({
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (!Array.isArray(result.rows) || result.rows.length === 0 || !(column in result.rows[0])) return result;
          return { ...result, rows: [{ ...result.rows[0], [column]: value }, ...result.rows.slice(1)] };
        },
        release(discard) { client.release(discard); },
      };
    },
  });
  for (const [column, value] of [
    ["policy_revision", "01"], ["policy_revision", "0"], ["state", "paused"], ["updated_at", "2035-06-15T12:00:00Z"],
    ["active", "-1"], ["active", 1], ["total", "99"], ["devices", "9007199254740993"],
    ["latest_report_day", "2035-02-30"], ["field_dictionary_version", "telemetry-performance-registry-2026-9-21.1"],
    ["bucket_scheme_version", "performance-histogram-v3"],
    ["speed_mode", "turbo"], ["model_id", "has space"], ["status", "200"], ["route_id", "telemetry_v12_consent"],
    ["window_end", null], ["kernel_id", "0"], ["performance", "{\"published\":[\"9:fast\"],\"unchanged\":[],\"withheld\":null,\"deferredEmpty\":false}"],
    ["performance", "{\"published\":[],\"unchanged\":[],\"withheld\":null}"], ["performance", "not json"],
  ]) {
    await expectUnavailable(read(schema, {}, tampering(column, value))).catch((error) => {
      throw new Error(`tampered ${column} was served: ${error.message}`);
    });
  }
});

test("invalid options are 503 without a connection", { skip }, async () => {
  const { schema } = await seedIntake();
  let connects = 0;
  const counting = { connect: async () => { connects += 1; return pool.connect(); } };
  for (const overrides of [
    { nowEpoch: 1.5 }, { nowEpoch: "1" }, { nowEpoch: Date.UTC(1999, 0, 1) }, { schema: { primarySchema: "Bad-Name" } },
    { schema: { primarySchema: "pg_catalog" } }, { routeClasses: null }, { routeClasses: { "Bad Id": "performance" } },
    { routeClasses: { telemetry_performance_reports: "Bad Class" } }, { deployment: { sourceCommit: "abc", historySha256: HISTORY_SHA256 } },
    { deployment: { sourceCommit: SOURCE_COMMIT, historySha256: "AB".repeat(32) } }, { deployment: { historySha256: HISTORY_SHA256 } },
    { contractDictionaries: null },
    { contractDictionaries: { [PERFORMANCE_DICTIONARY_2026_09_21]: { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
      state: "accepted", bucketSchemeVersion: "performance-histogram-v1" } } },
  ]) {
    await expectUnavailable(read(schema, overrides, counting));
  }
  await expectUnavailable(modules.intake.readPostgresAdminPerformanceIntake(null, options(schema)));
  await expectUnavailable(modules.intake.readPostgresAdminPerformanceIntake(counting, null));
  assert.equal(connects, 0);
});

test("a failing pool is 503 with no driver detail", { skip }, async () => {
  const { schema } = await seedIntake();
  const failingConnect = { connect: async () => { throw new Error("driver text that must not leak"); } };
  const failingQuery = {
    async connect() {
      let calls = 0;
      return {
        async query() {
          calls += 1;
          if (calls > 3) throw Object.assign(new Error("relation detail that must not leak"), { code: "42P01" });
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  for (const db of [failingConnect, failingQuery]) {
    await assert.rejects(read(schema, {}, db), (error) => error.code === "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE"
      && !/leak/u.test(error.message) && !/leak/u.test(String(error.stack)));
  }
});

test("the route serves the real reader: 200 body equals the fixture; a failing source is 503", { skip }, async () => {
  const { schema } = await seedIntake();
  const contexts = new WeakMap();
  const dispatchOver = (db) => modules.route.createAdminPerformanceIntakeDispatch({
    requestContext: (request) => contexts.get(request),
    clock: () => NOW,
    admin: {
      readPerformanceIntake: ({ nowEpoch }) => modules.intake.readPostgresAdminPerformanceIntake(db,
        options(schema, { nowEpoch })),
    },
  });
  const request = (identity = OWNER) => {
    const value = new Request(`https://admin.example.invalid${modules.route.ADMIN_PERFORMANCE_INTAKE_PATHNAMES[0]}`);
    contexts.set(value, Object.freeze({ requestId: REQUEST_ID, routeId: "admin_performance_intake",
      ...(identity === null ? {} : { adminIdentityKey: identity }) }));
    return value;
  };
  const ok = await dispatchOver(pool)(request());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("vary"), "Cookie");
  assert.equal(await ok.text(), JSON.stringify(ADMIN_PERFORMANCE_INTAKE_FIXTURE));

  const failing = await dispatchOver({ connect: async () => { throw new Error("down"); } })(request());
  assert.equal(failing.status, 503);
  assert.deepEqual(await failing.json(), { error: { code: "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE", requestId: REQUEST_ID } });

  let reads = 0;
  const counted = modules.route.createAdminPerformanceIntakeDispatch({
    requestContext: (value) => contexts.get(value), clock: () => NOW,
    admin: { readPerformanceIntake: async () => { reads += 1; return {}; } },
  });
  assert.equal((await counted(request(null))).status, 403);
  assert.equal(reads, 0);
});

test("negative scan: no seeded id, revision or digest appears in the body", { skip }, async () => {
  const { schema, owners } = await seedIntake();
  const text = JSON.stringify(await read(schema));
  const t = (name) => performanceTable(schema, name);
  const secrets = new Set();
  for (const owner of Object.values(owners)) {
    for (const value of [owner.participantId, owner.deviceId, owner.enrollmentDeviceId]) secrets.add(value);
  }
  for (const statement of [
    `SELECT id AS v FROM ${t("participants")}`,
    `SELECT id AS v FROM ${t("device_credentials")}`,
    `SELECT device_id AS v FROM ${t("accountless_enrollment_ledger")}`,
    `SELECT installation_principal_id AS v FROM ${t("accountless_enrollment_ledger")}`,
    `SELECT id AS v FROM ${t("telemetry_performance_reports")}`,
    `SELECT report_revision AS v FROM ${t("telemetry_performance_reports")}`,
    `SELECT source_digest AS v FROM ${t("telemetry_performance_reports")}`,
    `SELECT source_generation AS v FROM ${t("telemetry_performance_reports")}`,
    `SELECT parser_version AS v FROM ${t("telemetry_performance_reports")}`,
    `SELECT id AS v FROM ${t("telemetry_performance_receipts")}`,
    `SELECT envelope_digest AS v FROM ${t("telemetry_performance_receipts")}`,
    `SELECT operation_id::text AS v FROM ${t("admin_action_audit")}`,
    `SELECT actor_identity_digest AS v FROM ${t("admin_action_audit")}`,
    `SELECT payload_sha256::text AS v FROM ${t("analytics_v2_published_performance")}`,
    `SELECT run_id::text AS v FROM ${t("analytics_v2_published_performance")}`,
    `SELECT run_id::text AS v FROM ${t("analytics_v2_runs")}`,
    `SELECT exclusions_sha256::text AS v FROM ${t("analytics_v2_runs")}`,
  ]) {
    for (const row of (await pool.query(statement)).rows) secrets.add(String(row.v));
  }
  assert.ok(secrets.size > 40);
  for (const value of secrets) {
    assert.equal(text.includes(value), false, "a seeded identifier or digest reached the body");
  }
  // Nor does any 64-hex digest or UUID other than the deployment digest the caller supplied.
  const withoutDeployment = text.replace(HISTORY_SHA256, "");
  assert.doesNotMatch(withoutDeployment, /[0-9a-f]{64}/u);
  assert.doesNotMatch(withoutDeployment, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u);
  assert.doesNotMatch(text, /participant:|accountless:|synthetic-generation|unified-rollout/u);
});
