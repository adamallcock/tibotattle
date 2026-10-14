// PostgreSQL 17 spec for src/postgres-telemetry-performance-reports.ts
// (SPD-G3): dictionary-aware performance report admission and the bounded
// device-scoped read, on the promoted primary chain (0079).
//
// Two tests need no database: the closed parser's refusal details, and the
// error mapping against a scripted fake pool (trigger P1005 messages, the
// unique-race re-read and driver failures). Every other test builds its own
// schema through the production migration runner (prefix g3_perf_) and writes
// through the live 0079 guards with the shared, synthetic, content-free
// fixtures of postgres-test/fixtures/performance-telemetry.mjs. Records exist
// for all three dictionaries; no identifier, digest or body is printed.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test --test-concurrency=1 postgres-test/postgres-telemetry-performance-reports.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  canonicalTelemetryPerformanceJson,
  PERFORMANCE_FIELD_DICTIONARIES,
  REVIEWED_MODEL_CATALOG,
} from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { PERFORMANCE_TELEMETRY_RECORD_INVALID_DETAILS } from "../cloud-run/routes/performance-telemetry.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  PERFORMANCE_DICTIONARY_REGISTRY,
  PERFORMANCE_FIXTURE_DURATION_EDGES_MS,
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  insertPerformanceGrant,
  insertPerformanceReport,
  performanceInstant,
  performanceTable,
  seedPerformanceAccountlessOwner,
  syntheticPerformanceHistogram,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

const DAY_MS = 86_400_000;
/** The UTC day `offset` days from the UTC day of `epoch`. */
function utcDayAt(epoch, offset = 0) {
  return new Date(Math.floor(epoch / DAY_MS) * DAY_MS + offset * DAY_MS).toISOString().slice(0, 10);
}
// Report days sit inside admission's server-time window (today - 10 through
// today + 1) at the real clock the 0079 trigger also reads, so the spec does
// not age out: three and two days before today.
const DAY = utcDayAt(Date.now(), -3);
const NEXT_DAY = utcDayAt(Date.now(), -2);
const LATER_DAY = utcDayAt(Date.now(), -1);
const REPORT_SCHEMA_VERSION = "telemetry-performance-report-v1";
const METHOD_VERSION = "performance-daily-histogram-v1";
const PRIVACY_CONTRACT_VERSION = "privacy-safe-model-performance-v1";
const MEASUREMENT_VERSION = "model-performance-samples-v1";
const RECORD_SCHEMA_VERSION = "model-performance-daily-v1";
const SCOPE = "model-performance-daily";

let pool;
let vite;
let reports;
let canonicalJson;
const pools = [];
const created = [];

after(async () => {
  for (const extra of pools) await extra.end().catch(() => {});
  if (pool) {
    for (const schema of created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

async function loadModules() {
  if (reports) return;
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  reports = await vite.ssrLoadModule("/src/postgres-telemetry-performance-reports.ts");
  ({ canonicalJson } = await vite.ssrLoadModule("/src/canonical-json.ts"));
}

async function setup() {
  await loadModules();
  if (pool) return;
  pool = new pg.Pool({ ...endpoint, max: 12, application_name: "g3-performance-reports", connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
}

/** A schema on the full promoted chain, which includes 0079. */
async function promotedSchema(label) {
  await setup();
  const schema = `g3_perf_${label}_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.ok(applied.migrations.some((migration) => migration.name === PERFORMANCE_MIGRATION_NAME));
  return schema;
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function digest() {
  return randomBytes(32).toString("hex");
}

/** The capability response the route read (readPostgresTelemetryPerformanceCapability's shape). */
function capabilityFor(grant) {
  return {
    schemaVersion: "telemetry-performance-capabilities-v1",
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: ["receipt", "tool_free"],
    requiredConsent: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      fieldDictionaryVersion: grant.fieldDictionaryVersion,
      privacyContractVersion: PRIVACY_CONTRACT_VERSION,
      scope: SCOPE,
    },
    authorization: {
      schemaVersion: "telemetry-performance-authorization-v1",
      capabilityRevision: grant.capabilityRevision,
      authorityEpoch: grant.authorityEpoch,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      scope: SCOPE,
    },
  };
}

/** A contract-shaped report body: records sorted canonically, its revision the digest of the rest. */
function buildReport({
  day = DAY,
  dictionary = PERFORMANCE_DICTIONARY_2026_09_29,
  // An unregistered dictionary's report carries 2026-09-29.1 records.
  records = [syntheticPerformanceRecord({ day, fieldDictionaryVersion: Object.hasOwn(PERFORMANCE_DICTIONARY_REGISTRY, dictionary)
    ? dictionary : PERFORMANCE_DICTIONARY_2026_09_29 })],
  sourceRevision = 1,
  sourceGeneration = "synthetic-generation-1",
  sourceDigest = sha256Hex(`synthetic-source:${sourceGeneration}:${sourceRevision}`),
  parserVersion = "unified-rollout-typed-v20",
  sort = true,
  ...overrides
} = {}) {
  const key = (record) => {
    try {
      return canonicalTelemetryPerformanceJson(record, dictionary);
    } catch {
      return canonicalJson(record);
    }
  };
  const ordered = sort
    ? [...records].sort((left, right) => {
      const a = key(left);
      const b = key(right);
      return a < b ? -1 : a > b ? 1 : 0;
    })
    : records;
  const body = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    day,
    sourceGeneration,
    sourceDigest,
    sourceRevision,
    methodVersion: METHOD_VERSION,
    parserVersion,
    fieldDictionaryVersion: dictionary,
    privacyContractVersion: PRIVACY_CONTRACT_VERSION,
    bucketSchemeVersion: PERFORMANCE_DICTIONARY_REGISTRY[dictionary]?.bucketSchemeVersion ?? "performance-histogram-v1",
    measurementVersion: MEASUREMENT_VERSION,
    records: ordered,
    ...overrides,
  };
  return { ...body, reportRevision: sha256Hex(canonicalJson(body)) };
}

/** Distinct cohorts of one dictionary (different efforts), each contract-valid. */
function cohortRecords(day, dictionary, count = 2, fields = {}) {
  const efforts = ["low", "medium", "high", "xhigh", "max", "minimal", "none", "ultra"];
  return efforts.slice(0, count).map((reasoningEffort, index) => syntheticPerformanceRecord({
    day, fieldDictionaryVersion: dictionary, reasoningEffort, turns: index + 1, ...fields,
  }));
}

async function owned(schema, { fieldDictionaryVersion = PERFORMANCE_DICTIONARY_2026_09_29, ...ownerOptions } = {}) {
  const owner = await seedPerformanceAccountlessOwner(pool, { schema, ...ownerOptions });
  const grant = await insertPerformanceGrant(pool, {
    schema, owner, fieldDictionaryVersion,
    dictionaryBasis: fieldDictionaryVersion === PERFORMANCE_DICTIONARY_2026_10_10 ? "client_declared" : "v12_parser_inference",
  });
  return { owner, grant };
}

function admit(schema, owner, grant, plaintext, { capability = capabilityFor(grant), envelopeDigest = digest(),
  nowEpoch, db = pool } = {}) {
  return reports.admitPostgresTelemetryPerformanceReport(db, {
    schema: { primarySchema: schema },
    principal: { participantId: owner.participantId, deviceId: owner.deviceId },
    plaintext,
    capability,
    envelopeDigest,
    ...(nowEpoch === undefined ? {} : { nowEpoch }),
  });
}

function read(schema, owner, options = {}, db = pool) {
  return reports.readPostgresTelemetryPerformanceReports(db, {
    schema: { primarySchema: schema },
    participantId: owner.participantId,
    deviceId: owner.deviceId,
    ...options,
  });
}

async function rejectsApi(promise, status, code, detail) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "ApiError", String(error?.code));
    assert.equal(error.status, status, `${error.status} ${error.code}`);
    assert.equal(error.code, code);
    assert.equal(error.message, code, "the message is the closed code only");
    assert.equal(error.publicDetails, null, "no detail reaches the response body");
    if (detail !== undefined) assert.equal(reports.postgresTelemetryPerformanceRecordInvalidDetail(error), detail);
    return true;
  });
}

function rejectsParse(value, detail, options) {
  assert.throws(() => reports.parsePostgresTelemetryPerformanceReport(value, options), (error) => {
    assert.equal(error?.status, 409);
    assert.equal(error.code, "TELEMETRY_RECORD_INVALID");
    assert.equal(error.publicDetails, null);
    assert.equal(error.detail, detail, `expected ${detail}, got ${error.detail}`);
    assert.equal(reports.postgresTelemetryPerformanceRecordInvalidDetail(error), detail);
    return true;
  });
}

async function count(schema, name, where = "TRUE", values = []) {
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${performanceTable(schema, name)} WHERE ${where}`, values);
  return result.rows[0].n;
}

async function ownerRows(schema, owner) {
  const where = "participant_id = $1 AND device_id = $2";
  const values = [owner.participantId, owner.deviceId];
  return {
    reports: await count(schema, "telemetry_performance_reports", where, values),
    receipts: await count(schema, "telemetry_performance_receipts", where, values),
    cohorts: await count(schema, "telemetry_performance_cohorts",
      `report_id IN (SELECT id FROM ${performanceTable(schema, "telemetry_performance_reports")} WHERE ${where})`, values),
  };
}

function bucketEntries(records) {
  return records.reduce((total, record) => total
    + ["speedHistogram", "ttftHistogram", "completionHistogram"]
      .reduce((sum, field) => sum + Object.keys(record[field].buckets).length, 0), 0);
}

/** 1,024 distinct 2026-09-29.1 cohorts whose latency histograms fill every bucket. */
function denseRecords(day) {
  const dictionary = PERFORMANCE_DICTIONARY_2026_09_29;
  const scheme = PERFORMANCE_DICTIONARY_REGISTRY[dictionary].bucketSchemeVersion;
  const edges = PERFORMANCE_FIXTURE_DURATION_EDGES_MS;
  const ttftValues = [0, ...edges.slice(0, 57)];
  const durationValues = [1, 1, ...edges.slice(1, 57)];
  const ttftHistogram = syntheticPerformanceHistogram(scheme, "ttft", ttftValues);
  const completionHistogram = syntheticPerformanceHistogram(scheme, "turnDuration", durationValues);
  const models = REVIEWED_MODEL_CATALOG.filter((model) => model.provider === "openai_codex").slice(0, 3);
  const modes = [["standard", "rollout_thread_settings"], ["fast", "rollout_thread_settings"],
    ["other", "lineage_inherited"], ["unknown", "unobserved"], ["mixed", "mixed"]];
  const records = [];
  outer: for (const model of models) {
    for (const reasoningEffort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]) {
      for (const [speedMode, speedModeSource] of modes) {
        for (const apiServiceTier of PERFORMANCE_FIELD_DICTIONARIES[dictionary].apiServiceTiers) {
          records.push(syntheticPerformanceRecord({
            day, fieldDictionaryVersion: dictionary, reasoningEffort, speedMode, speedModeSource, apiServiceTier,
            turns: 58, provider: model.provider, modelId: model.id, ttftHistogram, completionHistogram,
          }));
          if (records.length === 1_024) break outer;
        }
      }
    }
  }
  assert.equal(records.length, 1_024);
  return records;
}

// ---------------------------------------------------------- no database --

test("parser: every accepted dictionary parses with its scheme; each invalid class has its closed detail", async () => {
  await loadModules();
  const parse = reports.parsePostgresTelemetryPerformanceReport;
  // Accepted: 2026-09-21.1 with turn_context_service_tier, 2026-09-29.1 with
  // Ultrafast labels, 2026-10-10.1 with a v2-only speed bucket.
  const v21 = buildReport({ dictionary: PERFORMANCE_DICTIONARY_2026_09_21, records: [syntheticPerformanceRecord({
    day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21, speedMode: "fast",
    speedModeSource: "turn_context_service_tier", apiServiceTier: "priority" })] });
  assert.equal(parse(v21).bucketSchemeVersion, "performance-histogram-v1");
  const v29 = buildReport({ records: [syntheticPerformanceRecord({ day: DAY, speedMode: "ultrafast",
    apiServiceTier: "ultrafast" })] });
  assert.equal(parse(v29).fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);
  const v2 = buildReport({ dictionary: PERFORMANCE_DICTIONARY_2026_10_10, records: [syntheticPerformanceRecord({
    day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10, speedBucket: 80 })] });
  const parsedV2 = parse(v2);
  assert.equal(parsedV2.bucketSchemeVersion, "performance-histogram-v2");
  assert.deepEqual(Object.keys(parsedV2.records[0].speedHistogram.buckets), ["80"]);
  // A zero-record report is a day tombstone.
  assert.equal(parse(buildReport({ records: [] })).records.length, 0);

  // SHAPE: report keys and constants, records that are not an array, labels a
  // dictionary lacks, a mode/source mismatch, and a non-object record.
  rejectsParse({ ...v29, extra: true }, "SHAPE");
  rejectsParse({ ...v29, schemaVersion: "telemetry-performance-report-v2" }, "SHAPE");
  rejectsParse({ ...v29, sourceRevision: -1 }, "SHAPE");
  rejectsParse({ ...v29, records: {} }, "SHAPE");
  rejectsParse(null, "SHAPE");
  for (const fields of [{ speedMode: "ultrafast" }, { apiServiceTier: "ultrafast" }]) {
    rejectsParse(buildReport({ dictionary: PERFORMANCE_DICTIONARY_2026_09_21, records: [syntheticPerformanceRecord({
      day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21, ...fields })] }), "SHAPE");
  }
  rejectsParse(buildReport({ records: [syntheticPerformanceRecord({ day: DAY, speedMode: "unknown",
    speedModeSource: "rollout_thread_settings" })] }), "SHAPE");
  rejectsParse(buildReport({ records: [7], sort: false }), "SHAPE");

  // DICTIONARY_UNACCEPTED: unknown, and a draft entry of an injected registry.
  rejectsParse(buildReport({ dictionary: "telemetry-performance-registry-2026-01-01.1" }), "DICTIONARY_UNACCEPTED");
  const draft = { ...PERFORMANCE_FIELD_DICTIONARIES,
    [PERFORMANCE_DICTIONARY_2026_10_10]: { ...PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_DICTIONARY_2026_10_10], state: "draft" } };
  rejectsParse(v2, "DICTIONARY_UNACCEPTED", { dictionaries: draft });
  assert.equal(parse(v29, { dictionaries: draft }).fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);

  // SCHEME_MISMATCH: the report's scheme, and a v2 record inside a v1 report.
  rejectsParse(buildReport({ bucketSchemeVersion: "performance-histogram-v2" }), "SCHEME_MISMATCH");
  rejectsParse(buildReport({ records: [syntheticPerformanceRecord({ day: DAY,
    fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10 })] }), "SCHEME_MISMATCH");

  // MODEL_UNREVIEWED: a well-formed model the reviewed catalog does not name.
  rejectsParse(buildReport({ records: [syntheticPerformanceRecord({ day: DAY,
    modelId: "gpt-synthetic-unreviewed" })] }), "MODEL_UNREVIEWED");

  // ORDER and DUPLICATE_COHORT.
  const pair = cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2);
  const sorted = buildReport({ records: pair }).records;
  rejectsParse(buildReport({ records: [sorted[1], sorted[0]], sort: false }), "ORDER");
  rejectsParse(buildReport({ records: [sorted[0], sorted[0]], sort: false }), "DUPLICATE_COHORT");
  const sameCohort = [syntheticPerformanceRecord({ day: DAY, turns: 1 }), syntheticPerformanceRecord({ day: DAY, turns: 2 })];
  rejectsParse(buildReport({ records: sameCohort }), "DUPLICATE_COHORT");

  // DAY_MISMATCH.
  rejectsParse(buildReport({ records: [syntheticPerformanceRecord({ day: NEXT_DAY })] }), "DAY_MISMATCH");

  // SIZE: more than 1,024 records, and more than 1.25 MB of canonical bytes.
  rejectsParse(buildReport({ records: Array.from({ length: 1_025 }, () => sorted[0]), sort: false }), "SIZE");
  const dense = buildReport({ records: denseRecords(DAY) });
  assert.ok(Buffer.byteLength(canonicalJson(dense)) > 1_250_000);
  rejectsParse(dense, "SIZE");
  assert.equal(parse(buildReport({ records: dense.records.slice(0, 512), sort: false })).records.length, 512);

  // Any other error has no detail.
  assert.equal(reports.postgresTelemetryPerformanceRecordInvalidDetail(new Error("x")), null);
  assert.deepEqual([...reports.POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS].sort(), [
    "DAY_MISMATCH", "DICTIONARY_UNACCEPTED", "DUPLICATE_COHORT", "MODEL_UNREVIEWED", "ORDER",
    "REPORT_DAY_OUT_OF_WINDOW", "SCHEME_MISMATCH", "SHAPE", "SIZE"]);
  // The route's counter-code suffixes mirror these details exactly.
  assert.deepEqual([...PERFORMANCE_TELEMETRY_RECORD_INVALID_DETAILS].sort(),
    [...reports.POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS].sort());
});

test("report-day window: today - 10 through today + 1 at the server's UTC day, from named constants", async () => {
  await loadModules();
  assert.equal(reports.POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_PAST_DAYS, 10);
  assert.equal(reports.POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_FUTURE_DAYS, 1);
  const window = reports.postgresTelemetryPerformanceReportDayWindow;
  // The UTC day decides, at either edge of it, across a month and a year end.
  assert.deepEqual(window(Date.UTC(2026, 9, 12, 0, 0, 0, 0)), { fromDay: "2026-10-02", throughDay: "2026-10-13" });
  assert.deepEqual(window(Date.UTC(2026, 9, 12, 23, 59, 59, 999)), { fromDay: "2026-10-02", throughDay: "2026-10-13" });
  assert.deepEqual(window(Date.UTC(2026, 9, 13)), { fromDay: "2026-10-03", throughDay: "2026-10-14" });
  assert.deepEqual(window(Date.UTC(2027, 0, 5, 12)), { fromDay: "2026-12-26", throughDay: "2027-01-06" });
  assert.deepEqual(window(Date.UTC(2026, 11, 31, 12)), { fromDay: "2026-12-21", throughDay: "2027-01-01" });
  assert.ok(Object.isFrozen(window(Date.now())));
  for (const invalid of [-1, 1.5, Number.NaN, 8_640_000_000_000_001, "1"]) {
    assert.throws(() => window(invalid), (error) => error?.status === 503 && error.code === "BACKEND_STORAGE_UNAVAILABLE");
  }
});

/**
 * A scripted pool: the transaction scaffolding succeeds, the report INSERT
 * throws `insertError`, the in-transaction idempotency read finds nothing and
 * the re-read after an aborted transaction returns `rereadRows`.
 */
function scriptedPool({ insertError, rereadRows = [], connectError = null, firstReadRows = [] }) {
  const statements = [];
  let idempotencyReads = 0;
  return {
    statements,
    async connect() {
      if (connectError) throw connectError;
      return {
        async query(text) {
          const sql = text.replace(/\s+/gu, " ").trim();
          statements.push(sql);
          if (/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql)) return { rows: [], rowCount: 0 };
          if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
          if (sql.includes("AND report_revision = $4")) {
            idempotencyReads += 1;
            const rows = idempotencyReads === 1 ? firstReadRows : rereadRows;
            return { rows, rowCount: rows.length };
          }
          if (sql.startsWith("INSERT INTO") && sql.includes("telemetry_performance_reports")) throw insertError;
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

test("error mapping: trigger P1005 messages, unique races and driver failures (scripted pool)", async () => {
  await loadModules();
  const owner = { participantId: "participant:synthetic", deviceId: "device-synthetic" };
  const grant = { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29, capabilityRevision: 1, authorityEpoch: 1,
    issuedAt: "2026-10-09T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
  const report = buildReport();
  const run = (db) => admit("tibotattle", owner, grant, report, { db });
  const p1005 = (message) => Object.assign(new Error(message), { code: "P1005" });

  await rejectsApi(run(scriptedPool({ insertError: p1005("telemetry_performance_report_admission_denied") })),
    403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(run(scriptedPool({ insertError: p1005("telemetry_performance_report_revision_conflict") })),
    409, "TELEMETRY_MANIFEST_CONFLICT");
  await rejectsApi(run(scriptedPool({ insertError: p1005("telemetry_performance_lock_key_invalid") })),
    503, "BACKEND_STORAGE_UNAVAILABLE");
  await rejectsApi(run(scriptedPool({ insertError: Object.assign(new Error("terminating connection"), { code: "57P01" }) })),
    503, "BACKEND_STORAGE_UNAVAILABLE");
  await rejectsApi(run(scriptedPool({ insertError: new Error("socket hang up"), connectError: new Error("refused") })),
    503, "BACKEND_STORAGE_UNAVAILABLE");

  // A unique race: the same revision committed first is idempotent; anything else conflicts.
  const unique = () => Object.assign(new Error("duplicate key"), { code: "23505" });
  const raced = scriptedPool({ insertError: unique(),
    rereadRows: [{ id: "00000000-0000-4000-8000-000000000001", report_day: DAY, report_revision: report.reportRevision }] });
  assert.deepEqual(await run(raced), { status: "idempotent", reportId: "00000000-0000-4000-8000-000000000001",
    day: DAY, reportRevision: report.reportRevision });
  assert.ok(raced.statements.some((sql) => sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")),
    "the re-read runs in its own read transaction");
  await rejectsApi(run(scriptedPool({ insertError: unique() })), 409, "TELEMETRY_MANIFEST_CONFLICT");

  // Order: the report/day advisory lock (the 0079 function, schema-qualified)
  // precedes the idempotency read; the lock key is never derived in TypeScript.
  const order = scriptedPool({ insertError: p1005("telemetry_performance_report_admission_denied") });
  await run(order).catch(() => {});
  const work = order.statements.filter((sql) => !/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql));
  assert.match(work[0], /^SELECT pg_advisory_xact_lock\("tibotattle"\.telemetry_performance_report_lock_key\(\$1, \$2, \$3::date\)\)$/u);
  assert.match(work[1], /AND report_revision = \$4$/u);
  assert.match(work[2], /FOR UPDATE$/u);

  // The report-day window is checked after the lock and the idempotency read
  // and before the revision digest and the current-row lock: a stored
  // revision replays as idempotent outside the window; a new one is refused.
  const late = Date.parse(`${DAY}T12:00:00.000Z`) + 11 * DAY_MS;
  const outside = scriptedPool({ insertError: new Error("unreachable") });
  await rejectsApi(admit("tibotattle", owner, grant, { ...report, reportRevision: "f".repeat(64) },
    { db: outside, nowEpoch: late }), 409, "TELEMETRY_RECORD_INVALID", "REPORT_DAY_OUT_OF_WINDOW");
  const refusedWork = outside.statements.filter((sql) => !/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql));
  assert.equal(refusedWork.length, 2, "only the lock and the idempotency read ran");
  assert.match(refusedWork[0], /pg_advisory_xact_lock/u);
  assert.match(refusedWork[1], /AND report_revision = \$4$/u);
  assert.ok(outside.statements.includes("ROLLBACK"), "the refused transaction rolls back");
  const stored = scriptedPool({ insertError: new Error("unreachable"),
    firstReadRows: [{ id: "00000000-0000-4000-8000-000000000002", report_day: DAY, report_revision: report.reportRevision }] });
  assert.deepEqual(await admit("tibotattle", owner, grant, report, { db: stored, nowEpoch: late }),
    { status: "idempotent", reportId: "00000000-0000-4000-8000-000000000002", day: DAY, reportRevision: report.reportRevision });

  // Refusals before any database work: invalid envelope digest, principal and capability.
  const untouched = scriptedPool({ insertError: new Error("unreachable") });
  await rejectsApi(admit("tibotattle", owner, grant, report, { db: untouched, envelopeDigest: "A".repeat(64) }),
    409, "TELEMETRY_RECORD_INVALID", "SHAPE");
  await rejectsApi(reports.admitPostgresTelemetryPerformanceReport(untouched, { schema: { primarySchema: "tibotattle" },
    principal: { participantId: "bad id", deviceId: "device" }, plaintext: report, capability: capabilityFor(grant),
    envelopeDigest: digest() }), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(admit("tibotattle", owner, grant, report, { db: untouched,
    capability: { ...capabilityFor(grant), authorization: { ...capabilityFor(grant).authorization, capabilityRevision: 0 } } }),
  403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(admit("tibotattle", owner, { ...grant, expiresAt: "2026-01-01T00:00:00.000Z" }, report, { db: untouched }),
    403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(admit("tibotattle", owner, grant, { ...report, extra: 1 }, { db: untouched }),
    409, "TELEMETRY_RECORD_INVALID", "SHAPE");
  assert.deepEqual(untouched.statements, []);
});

// -------------------------------------------------------------- database --

test("admission: accepted, idempotent replay and replaced by a newer sourceRevision", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("status");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const first = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 3), sourceRevision: 4 });
  const t1 = Date.now() - 5_000;
  const envelope = digest();
  const accepted = await admit(schema, owner, grant, first, { nowEpoch: t1, envelopeDigest: envelope });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.day, DAY);
  assert.equal(accepted.reportRevision, first.reportRevision);
  assert.match(accepted.reportId, /^[0-9a-f-]{36}$/u);
  assert.ok(Object.isFrozen(accepted));

  const row = (await pool.query(`SELECT to_char(report_day, 'YYYY-MM-DD') AS day, state, source_revision::text AS sr,
      field_dictionary_version, bucket_scheme_version, record_count, canonical_bytes, capability_revision,
      authority_epoch, parser_version, method_version, schema_version,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM ${performanceTable(schema, "telemetry_performance_reports")} WHERE id = $1`, [accepted.reportId])).rows[0];
  assert.deepEqual(row, {
    day: DAY, state: "current", sr: "4", field_dictionary_version: PERFORMANCE_DICTIONARY_2026_09_29,
    bucket_scheme_version: "performance-histogram-v1", record_count: 3,
    canonical_bytes: Buffer.byteLength(canonicalJson(first)), capability_revision: grant.capabilityRevision,
    authority_epoch: grant.authorityEpoch, parser_version: "unified-rollout-typed-v20", method_version: METHOD_VERSION,
    schema_version: RECORD_SCHEMA_VERSION, created_at: performanceInstant(t1),
  });
  assert.equal(await count(schema, "telemetry_performance_cohorts", "report_id = $1 AND bucket_scheme_version = $2",
    [accepted.reportId, "performance-histogram-v1"]), 3);
  assert.equal(await count(schema, "telemetry_performance_buckets", "report_id = $1", [accepted.reportId]),
    bucketEntries(first.records));
  const receipt = (await pool.query(`SELECT participant_id = $2 AS same_participant, device_id = $3 AS same_device,
      to_char(report_day, 'YYYY-MM-DD') AS day, report_revision = $4 AS same_revision, envelope_digest = $5 AS same_envelope,
      outcome FROM ${performanceTable(schema, "telemetry_performance_receipts")} WHERE report_id = $1`,
  [accepted.reportId, owner.participantId, owner.deviceId, first.reportRevision, envelope])).rows;
  assert.deepEqual(receipt, [{ same_participant: true, same_device: true, day: DAY, same_revision: true,
    same_envelope: true, outcome: "accepted" }]);

  // A replay (a fresh envelope of the same report) is idempotent and writes nothing.
  const before = await ownerRows(schema, owner);
  const replay = await admit(schema, owner, grant, first);
  assert.deepEqual(replay, { status: "idempotent", reportId: accepted.reportId, day: DAY, reportRevision: first.reportRevision });
  assert.deepEqual(await ownerRows(schema, owner), before);

  // A newer sourceRevision replaces the current row in the same transaction.
  const second = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2), sourceRevision: 5,
    sourceGeneration: "synthetic-generation-2" });
  const t2 = t1 + 2_000;
  const replaced = await admit(schema, owner, grant, second, { nowEpoch: t2 });
  assert.equal(replaced.status, "replaced");
  const states = (await pool.query(`SELECT id, state,
      to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS superseded_at
    FROM ${performanceTable(schema, "telemetry_performance_reports")} WHERE participant_id = $1 ORDER BY created_at`,
  [owner.participantId])).rows;
  assert.deepEqual(states, [
    { id: accepted.reportId, state: "superseded", superseded_at: performanceInstant(t2) },
    { id: replaced.reportId, state: "current", superseded_at: null },
  ]);
  const outcomes = (await pool.query(`SELECT outcome FROM ${performanceTable(schema, "telemetry_performance_receipts")}
    WHERE participant_id = $1 ORDER BY created_at`, [owner.participantId])).rows.map((entry) => entry.outcome);
  assert.deepEqual(outcomes, ["accepted", "replaced"]);
  // The superseded revision replays as idempotent too (Worker parity), with no write.
  const stale = await admit(schema, owner, grant, first);
  assert.deepEqual(stale, { status: "idempotent", reportId: accepted.reportId, day: DAY, reportRevision: first.reportRevision });
  assert.deepEqual(await ownerRows(schema, owner), { reports: 2, receipts: 2, cohorts: 5 });
});

test("admission: an older or equal-but-different source and a revision digest mismatch are 409", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("order");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const current = buildReport({ sourceRevision: 5, sourceGeneration: "synthetic-generation-5" });
  assert.equal((await admit(schema, owner, grant, current)).status, "accepted");
  const baseline = await ownerRows(schema, owner);
  const records = cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2);
  // Older sourceRevision.
  await rejectsApi(admit(schema, owner, grant, buildReport({ records, sourceRevision: 4,
    sourceGeneration: "synthetic-generation-5" })), 409, "TELEMETRY_MANIFEST_CONFLICT");
  // Equal sourceRevision, different generation; then different digest.
  await rejectsApi(admit(schema, owner, grant, buildReport({ records, sourceRevision: 5,
    sourceGeneration: "synthetic-generation-other", sourceDigest: current.sourceDigest })), 409, "TELEMETRY_MANIFEST_CONFLICT");
  await rejectsApi(admit(schema, owner, grant, buildReport({ records, sourceRevision: 5,
    sourceGeneration: "synthetic-generation-5", sourceDigest: digest() })), 409, "TELEMETRY_MANIFEST_CONFLICT");
  // A revision that is not the digest of the body.
  await rejectsApi(admit(schema, owner, grant, { ...buildReport({ records, sourceRevision: 9 }), reportRevision: "f".repeat(64) }),
    409, "TELEMETRY_MANIFEST_CONFLICT");
  assert.deepEqual(await ownerRows(schema, owner), baseline);
  // An equal counter naming the same generation and digest replaces (Worker parity).
  const same = await admit(schema, owner, grant, buildReport({ records, sourceRevision: 5,
    sourceGeneration: "synthetic-generation-5", sourceDigest: current.sourceDigest }));
  assert.equal(same.status, "replaced");
});

test("admission: a dictionary other than the capability's is 403; each invalid class is 409 with its detail", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("refusals");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const v2 = buildReport({ dictionary: PERFORMANCE_DICTIONARY_2026_10_10, records: [syntheticPerformanceRecord({
    day: DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10 })] });
  await rejectsApi(admit(schema, owner, grant, v2), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  const pair = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2) }).records;
  const invalid = [
    ["SHAPE", { ...buildReport(), extra: true }],
    ["DICTIONARY_UNACCEPTED", buildReport({ dictionary: "telemetry-performance-registry-2026-01-01.1" })],
    ["SCHEME_MISMATCH", buildReport({ bucketSchemeVersion: "performance-histogram-v2" })],
    ["MODEL_UNREVIEWED", buildReport({ records: [syntheticPerformanceRecord({ day: DAY, modelId: "gpt-synthetic-unreviewed" })] })],
    ["ORDER", buildReport({ records: [pair[1], pair[0]], sort: false })],
    ["DUPLICATE_COHORT", buildReport({ records: [syntheticPerformanceRecord({ day: DAY, turns: 1 }),
      syntheticPerformanceRecord({ day: DAY, turns: 2 })] })],
    ["DAY_MISMATCH", buildReport({ records: [syntheticPerformanceRecord({ day: NEXT_DAY })] })],
    ["SIZE", buildReport({ records: Array.from({ length: 1_025 }, () => pair[0]), sort: false })],
  ];
  for (const [detail, plaintext] of invalid) {
    await rejectsApi(admit(schema, owner, grant, plaintext), 409, "TELEMETRY_RECORD_INVALID", detail);
  }
  await rejectsApi(admit(schema, owner, grant, buildReport(), { envelopeDigest: "not-a-digest" }),
    409, "TELEMETRY_RECORD_INVALID", "SHAPE");
  assert.deepEqual(await ownerRows(schema, owner), { reports: 0, receipts: 0, cohorts: 0 });
});

test("admission: report days from today - 10 through today + 1 are admitted; outside is 409 REPORT_DAY_OUT_OF_WINDOW with no write", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("window");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const now = Date.now();
  const oldest = utcDayAt(now, -10);
  const newest = utcDayAt(now, 1);
  assert.deepEqual(reports.postgresTelemetryPerformanceReportDayWindow(now), { fromDay: oldest, throughDay: newest });
  const dayReport = (day, fields = {}) => buildReport({ day,
    records: cohortRecords(day, PERFORMANCE_DICTIONARY_2026_09_29, 1), ...fields });

  // Both edges are admitted.
  const edges = {};
  for (const day of [oldest, newest]) {
    edges[day] = dayReport(day, { sourceRevision: 2 });
    const result = await admit(schema, owner, grant, edges[day], { nowEpoch: now });
    assert.deepEqual([result.status, result.day], ["accepted", day]);
  }
  const admitted = await ownerRows(schema, owner);
  assert.deepEqual(admitted, { reports: 2, receipts: 2, cohorts: 2 });

  // One day past either edge, and far outside, is refused before any write.
  for (const day of [utcDayAt(now, -11), utcDayAt(now, 2), "2001-01-01", "0001-01-01", "9999-12-31"]) {
    await rejectsApi(admit(schema, owner, grant, dayReport(day), { nowEpoch: now }),
      409, "TELEMETRY_RECORD_INVALID", "REPORT_DAY_OUT_OF_WINDOW");
  }
  assert.deepEqual(await ownerRows(schema, owner), admitted, "nothing stored for a refused day");

  // A day later the oldest edge has left the window. An exact replay of its
  // stored revision still answers idempotent and writes nothing; a
  // replacement for that day (a newer sourceRevision) is refused.
  const nextDay = now + DAY_MS;
  assert.equal(reports.postgresTelemetryPerformanceReportDayWindow(nextDay).fromDay, utcDayAt(now, -9));
  const replay = await admit(schema, owner, grant, edges[oldest], { nowEpoch: nextDay });
  assert.equal(replay.status, "idempotent");
  assert.equal(replay.reportRevision, edges[oldest].reportRevision);
  await rejectsApi(admit(schema, owner, grant, dayReport(oldest, { sourceRevision: 3,
    sourceGeneration: "synthetic-generation-3" }), { nowEpoch: nextDay }),
  409, "TELEMETRY_RECORD_INVALID", "REPORT_DAY_OUT_OF_WINDOW");
  // The newest edge is still inside and still replaceable.
  const replaced = await admit(schema, owner, grant, dayReport(newest, { sourceRevision: 3,
    sourceGeneration: "synthetic-generation-3" }), { nowEpoch: nextDay });
  assert.equal(replaced.status, "replaced");
  assert.deepEqual(await ownerRows(schema, owner), { reports: 3, receipts: 3, cohorts: 3 });
  const currentDays = (await pool.query(`SELECT to_char(report_day, 'YYYY-MM-DD') AS day
      FROM ${performanceTable(schema, "telemetry_performance_reports")}
     WHERE participant_id = $1 AND device_id = $2 AND state = 'current' ORDER BY report_day`,
  [owner.participantId, owner.deviceId])).rows.map((row) => row.day);
  assert.deepEqual(currentDays, [oldest, newest]);
});

test("admission: a day under 2026-09-29.1/v1 then 2026-10-10.1/v2 with a higher sourceRevision ends with one current row", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("upgrade");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const v1 = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2), sourceRevision: 1 });
  const first = await admit(schema, owner, grant, v1);
  assert.equal(first.status, "accepted");
  // The client upgrades and re-grants with a declared dictionary: the latest grant wins.
  const v2Grant = await insertPerformanceGrant(pool, { schema, owner, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10,
    dictionaryBasis: "client_declared" });
  assert.deepEqual([v2Grant.capabilityRevision, v2Grant.authorityEpoch], [2, 1]);
  const v2 = buildReport({ dictionary: PERFORMANCE_DICTIONARY_2026_10_10, sourceRevision: 2,
    records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_10_10, 2, { speedBucket: 80 }) });
  // The stale v1 capability no longer admits anything: v2 bytes are 403 by
  // dictionary, v1 bytes are 403 by the trigger's capability-head fence.
  await rejectsApi(admit(schema, owner, grant, v2), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(admit(schema, owner, grant, buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 1),
    sourceRevision: 3 })), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  const replaced = await admit(schema, owner, v2Grant, v2);
  assert.equal(replaced.status, "replaced");
  const rows = (await pool.query(`SELECT id, state, field_dictionary_version, bucket_scheme_version, capability_revision
      FROM ${performanceTable(schema, "telemetry_performance_reports")}
     WHERE participant_id = $1 AND device_id = $2 AND report_day = $3::date ORDER BY created_at`,
  [owner.participantId, owner.deviceId, DAY])).rows;
  assert.deepEqual(rows, [
    { id: first.reportId, state: "superseded", field_dictionary_version: PERFORMANCE_DICTIONARY_2026_09_29,
      bucket_scheme_version: "performance-histogram-v1", capability_revision: 1 },
    { id: replaced.reportId, state: "current", field_dictionary_version: PERFORMANCE_DICTIONARY_2026_10_10,
      bucket_scheme_version: "performance-histogram-v2", capability_revision: 2 },
  ]);
  assert.equal(await count(schema, "telemetry_performance_buckets",
    "report_id = $1 AND metric = 'speed' AND bucket_index = 80 AND bucket_scheme_version = 'performance-histogram-v2'",
    [replaced.reportId]), 2);
  const current = await read(schema, owner);
  assert.equal(current.reports.length, 1);
  assert.equal(current.reports[0].fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_10_10);
  assert.deepEqual(current.reports[0].cohorts.map((cohort) => cohort.speedHistogram.buckets)
    .sort((left, right) => left[0].count - right[0].count), [[{ index: 80, count: 1 }], [{ index: 80, count: 2 }]]);
});

test("admission: 2026-09-21.1 accepts turn_context_service_tier days and refuses Ultrafast labels", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("legacy");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema, { fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_21 });
  const dictionary = PERFORMANCE_DICTIONARY_2026_09_21;
  for (const [index, day] of [DAY, NEXT_DAY].entries()) {
    const result = await admit(schema, owner, grant, buildReport({ day, dictionary, sourceRevision: index + 1, records: [
      syntheticPerformanceRecord({ day, fieldDictionaryVersion: dictionary, speedMode: "fast",
        speedModeSource: "turn_context_service_tier", apiServiceTier: "priority" }),
      syntheticPerformanceRecord({ day, fieldDictionaryVersion: dictionary, speedMode: "other",
        speedModeSource: "turn_context_service_tier", apiServiceTier: "other", reasoningEffort: "high" }),
    ] }));
    assert.equal(result.status, "accepted");
  }
  assert.equal(await count(schema, "telemetry_performance_cohorts",
    "speed_mode_source = 'turn_context_service_tier' AND field_dictionary_version = $1", [dictionary]), 4);
  for (const fields of [{ speedMode: "ultrafast" }, { apiServiceTier: "ultrafast" }]) {
    await rejectsApi(admit(schema, owner, grant, buildReport({ dictionary, sourceRevision: 9, records: [
      syntheticPerformanceRecord({ day: DAY, fieldDictionaryVersion: dictionary, ...fields })] })),
    409, "TELEMETRY_RECORD_INVALID", "SHAPE");
  }
  assert.deepEqual(await ownerRows(schema, owner), { reports: 2, receipts: 2, cohorts: 4 });
});

test("admission: concurrent identical POSTs give one write and idempotent answers; the lock precedes the replay read", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("race");
  await activatePerformanceRuntime(pool, { schema });
  const { owner, grant } = await owned(schema);
  const report = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 3) });
  const envelopeDigest = digest();
  const results = await Promise.all(Array.from({ length: 6 }, () => admit(schema, owner, grant, report, { envelopeDigest })));
  assert.deepEqual(results.map((result) => result.status).sort(),
    ["accepted", "idempotent", "idempotent", "idempotent", "idempotent", "idempotent"]);
  assert.equal(new Set(results.map((result) => result.reportId)).size, 1);
  assert.deepEqual(await ownerRows(schema, owner), { reports: 1, receipts: 1, cohorts: 3 });

  // While another transaction holds the report/day lock, even a replay waits.
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT pg_advisory_xact_lock("${schema}".telemetry_performance_report_lock_key($1, $2, $3::date))`,
      [owner.participantId, owner.deviceId, DAY]);
    let settled = false;
    const pending = admit(schema, owner, grant, report).finally(() => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "the replay waits for the report/day lock");
    await holder.query("COMMIT");
    assert.equal((await pending).status, "idempotent");
  } finally {
    holder.release();
  }
  // A different day takes a different lock and proceeds at once.
  const other = buildReport({ day: NEXT_DAY, records: cohortRecords(NEXT_DAY, PERFORMANCE_DICTIONARY_2026_09_29, 1) });
  assert.equal((await admit(schema, owner, grant, other)).status, "accepted");
});

test("admission: revoked or expired capabilities are 403 with no writes", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("fence");
  await activatePerformanceRuntime(pool, { schema });
  const t = (name) => performanceTable(schema, name);

  // A revoked capability head: the trigger refuses.
  const revokedCapability = await owned(schema);
  await pool.query(`UPDATE ${t("telemetry_performance_device_capabilities")} SET state = 'revoked', revoked_at = now()
    WHERE participant_id = $1 AND device_id = $2`, [revokedCapability.owner.participantId, revokedCapability.owner.deviceId]);
  await rejectsApi(admit(schema, revokedCapability.owner, revokedCapability.grant, buildReport()),
    403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await ownerRows(schema, revokedCapability.owner), { reports: 0, receipts: 0, cohorts: 0 });

  // A revoked enrollment: the owner graph is no longer active.
  const revokedEnrollment = await owned(schema);
  await pool.query(`UPDATE ${t("accountless_enrollment_ledger")} SET state = 'revoked', revoked_at = now(),
    revocation_reason = 'security_reset' WHERE device_id = $1`, [revokedEnrollment.owner.enrollmentDeviceId]);
  await rejectsApi(admit(schema, revokedEnrollment.owner, revokedEnrollment.grant, buildReport()),
    403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await ownerRows(schema, revokedEnrollment.owner), { reports: 0, receipts: 0, cohorts: 0 });

  // An expired grant and capability: refused by the capability check at the
  // caller's clock, and by the trigger's now() even when the caller's clock lags.
  const expiring = await owned(schema, { issuedAtEpoch: Date.now() - 60_000, leaseMs: 62_500 });
  const lagging = Date.parse(expiring.owner.expiresAt) - 1_000;
  await sleep(Math.max(0, Date.parse(expiring.owner.expiresAt) - Date.now()) + 300);
  await rejectsApi(admit(schema, expiring.owner, expiring.grant, buildReport()), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  await rejectsApi(admit(schema, expiring.owner, expiring.grant, buildReport(), { nowEpoch: lagging }),
    403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(await ownerRows(schema, expiring.owner), { reports: 0, receipts: 0, cohorts: 0 });
});

test("read: the Worker DTO, device scope, day filters, includeSuperseded and request validation", {
  skip, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema("read");
  await activatePerformanceRuntime(pool, { schema });
  // A session whose DateStyle and TimeZone differ from ISO/UTC: days and
  // instants are rendered with to_char, so the DTO is unchanged.
  const skewed = new pg.Pool({ ...endpoint, max: 2, application_name: "g3-performance-reports-skewed",
    options: "-c DateStyle=SQL,DMY -c TimeZone=Pacific/Chatham" });
  skewed.on("error", () => {});
  pools.push(skewed);
  const { owner, grant } = await owned(schema);
  const other = await owned(schema);
  const t1 = Date.now() - 10_000;
  const day1 = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 2), sourceRevision: 1 });
  const day2 = buildReport({ day: NEXT_DAY, records: cohortRecords(NEXT_DAY, PERFORMANCE_DICTIONARY_2026_09_29, 1) });
  const day1b = buildReport({ records: cohortRecords(DAY, PERFORMANCE_DICTIONARY_2026_09_29, 1, { speedMethod: "unavailable" }),
    sourceRevision: 2 });
  await admit(schema, owner, grant, day1, { nowEpoch: t1, db: skewed });
  await admit(schema, owner, grant, day2, { nowEpoch: t1 + 1_000 });
  await admit(schema, owner, grant, day1b, { nowEpoch: t1 + 2_000, db: skewed });
  await admit(schema, other.owner, other.grant, buildReport());

  const current = await read(schema, owner, {}, skewed);
  assert.equal(current.schemaVersion, "telemetry-performance-read-v1");
  assert.equal(current.population, "reported_samples");
  assert.ok(Object.isFrozen(current) && Object.isFrozen(current.reports));
  assert.deepEqual(current.reports.map((entry) => [entry.day, entry.state, entry.sourceRevision, entry.createdAt]), [
    [DAY, "current", 2, performanceInstant(t1 + 2_000)],
    [NEXT_DAY, "current", 1, performanceInstant(t1 + 1_000)],
  ]);
  const unavailable = current.reports[0].cohorts[0];
  const source = day1b.records[0];
  assert.deepEqual(unavailable, {
    provider: source.provider, modelId: source.modelId, reasoningEffort: source.reasoningEffort,
    speedMethod: "unavailable", speedMode: source.speedMode, speedModeSource: source.speedModeSource,
    apiServiceTier: source.apiServiceTier, turns: source.turns, speedTurns: 0, ttftTurns: source.ttftTurns,
    completionTurns: source.completionTurns, timedResponses: 0, speedTokens: 0, speedDurationMs: 0,
    speedHistogram: { metric: "speed", min: null, max: null, buckets: [] },
    ttftHistogram: { metric: "ttft", min: source.ttftHistogram.min, max: source.ttftHistogram.max,
      buckets: Object.entries(source.ttftHistogram.buckets).map(([index, value]) => ({ index: Number(index), count: value })) },
    completionHistogram: { metric: "turnDuration", min: source.completionHistogram.min, max: source.completionHistogram.max,
      buckets: Object.entries(source.completionHistogram.buckets).map(([index, value]) => ({ index: Number(index), count: value })) },
  });
  assert.deepEqual(current.reports[1], {
    day: NEXT_DAY, reportRevision: day2.reportRevision, sourceGeneration: day2.sourceGeneration,
    sourceDigest: day2.sourceDigest, sourceRevision: 1, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    state: "current", createdAt: performanceInstant(t1 + 1_000), cohorts: current.reports[1].cohorts,
  });
  assert.equal(current.reports[1].cohorts[0].speedHistogram.buckets[0].index, 30);

  const all = await read(schema, owner, { includeSuperseded: true });
  assert.deepEqual(all.reports.map((entry) => [entry.day, entry.state, entry.cohorts.length]), [
    [DAY, "superseded", 2], [DAY, "current", 1], [NEXT_DAY, "current", 1]]);
  assert.deepEqual((await read(schema, owner, { fromDay: NEXT_DAY })).reports.map((entry) => entry.day), [NEXT_DAY]);
  assert.deepEqual((await read(schema, owner, { throughDay: DAY })).reports.map((entry) => entry.day), [DAY]);
  assert.deepEqual((await read(schema, owner, { fromDay: LATER_DAY })).reports, []);
  // Device scope: another device's id under this participant reads nothing.
  assert.deepEqual((await read(schema, { participantId: owner.participantId, deviceId: other.owner.deviceId })).reports, []);
  assert.equal((await read(schema, other.owner)).reports.length, 1);

  // Request validation is the Worker's 409.
  for (const options of [{ fromDay: "2026-13-01" }, { throughDay: "2026-02-30" }, { fromDay: NEXT_DAY, throughDay: DAY },
    { includeSuperseded: "true" }]) {
    await rejectsApi(read(schema, owner, options), 409, "TELEMETRY_RECORD_INVALID");
  }
  await rejectsApi(read(schema, { participantId: "bad id", deviceId: owner.deviceId }), 409, "TELEMETRY_RECORD_INVALID");
  await rejectsApi(read(schema, { participantId: owner.participantId, deviceId: undefined }), 409, "TELEMETRY_RECORD_INVALID");
});

/** A pool that records the SQL it runs, to prove fences fire before detail rows are selected. */
function recordingPool(base) {
  const statements = [];
  return {
    statements,
    async connect() {
      const client = await base.connect();
      return {
        query(text, values) { statements.push(text.replace(/\s+/gu, " ").trim()); return client.query(text, values); },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

test("read fences: 256 reports, declared bytes and records, counted cohort and bucket fan-out, and storage drift", {
  skip, timeout: 240_000,
}, async () => {
  const schema = await promotedSchema("fences");
  await activatePerformanceRuntime(pool, { schema });
  const t = (name) => performanceTable(schema, name);
  // Raw report rows through the live admission trigger, `n` consecutive days
  // from DAY, with declared counts the parser would never produce.
  const rawReports = async ({ owner, grant }, n, recordCount, canonicalBytes) => pool.query(
    `INSERT INTO ${t("telemetry_performance_reports")} (id, participant_id, device_id, report_day, report_revision,
       source_generation, source_digest, source_revision, method_version, parser_version, schema_version,
       field_dictionary_version, bucket_scheme_version, privacy_contract_version, measurement_version, record_count,
       canonical_bytes, capability_revision, authority_epoch, state, created_at)
     SELECT gen_random_uuid()::text, $1, $2, $3::date + g, encode(sha256(convert_to('r:' || $2 || g, 'UTF8')), 'hex'),
       'synthetic-generation-1', encode(sha256(convert_to('s:' || g, 'UTF8')), 'hex'), 1, '${METHOD_VERSION}',
       'unified-rollout-typed-v20', '${RECORD_SCHEMA_VERSION}', $4, 'performance-histogram-v1', '${PRIVACY_CONTRACT_VERSION}',
       '${MEASUREMENT_VERSION}', $5, $6, $7, $8, 'current', now()
       FROM generate_series(0, $9 - 1) AS g`,
    [owner.participantId, owner.deviceId, DAY, grant.fieldDictionaryVersion, recordCount, canonicalBytes,
      grant.capabilityRevision, grant.authorityEpoch, n]);
  const rawCohorts = async ({ owner }, perReport) => pool.query(
    `INSERT INTO ${t("telemetry_performance_cohorts")} (report_id, cohort_index, field_dictionary_version,
       bucket_scheme_version, provider, model_id, reasoning_effort, speed_method, speed_mode, speed_mode_source,
       api_service_tier, turns, speed_turns, ttft_turns, completion_turns, timed_responses, speed_tokens,
       speed_duration_ms, speed_min, speed_max, ttft_min, ttft_max, completion_min, completion_max)
     SELECT r.id, g, r.field_dictionary_version, r.bucket_scheme_version, 'openai_codex', 'gpt-5.5', 'e' || g, 'receipt',
       'standard', 'rollout_thread_settings', 'standard', 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1
       FROM ${t("telemetry_performance_reports")} r CROSS JOIN generate_series(0, $2 - 1) AS g
      WHERE r.participant_id = $1`, [owner.participantId, perReport]);
  const rawBuckets = async ({ owner }) => pool.query(
    `INSERT INTO ${t("telemetry_performance_buckets")} (report_id, cohort_index, bucket_scheme_version, metric,
       bucket_index, bucket_count)
     SELECT c.report_id, c.cohort_index, c.bucket_scheme_version, m.metric, i::smallint, 1
       FROM ${t("telemetry_performance_cohorts")} c
       JOIN ${t("telemetry_performance_reports")} r ON r.id = c.report_id
       CROSS JOIN (VALUES ('speed', 0, 60), ('ttft', 0, 57), ('turnDuration', 1, 57)) AS m(metric, lo, hi)
       CROSS JOIN LATERAL generate_series(m.lo, m.hi) AS i
      WHERE r.participant_id = $1`, [owner.participantId]);
  const detailSelected = (statements) => statements.some((sql) => /ORDER BY report_id, cohort_index/u.test(sql));
  const fenced = async (subject, status, code, { detailRead = false, options = {} } = {}) => {
    const recorder = recordingPool(pool);
    await rejectsApi(read(schema, subject.owner, options, recorder), status, code);
    assert.equal(detailSelected(recorder.statements), detailRead);
  };

  // 257 reports exceed the 256-report fence; 256 read. The reports run from
  // DAY (relative to the clock) for 257 days, so the bounded read ends at
  // DAY + 255, never a fixed date (a fixed one ages out as the clock moves).
  const many = await owned(schema);
  await rawReports(many, 257, 0, 100);
  await fenced(many, 400, "SYNC_RANGE_TOO_LARGE");
  const lastReadDay = utcDayAt(Date.parse(`${DAY}T00:00:00.000Z`), 255);
  assert.equal((await read(schema, many.owner, { throughDay: lastReadDay })).reports.length, 256);

  // Declared canonical bytes over 8 MiB, and declared records over 16,384.
  const bytes = await owned(schema);
  await rawReports(bytes, 7, 0, 1_250_000);
  await fenced(bytes, 400, "SYNC_RANGE_TOO_LARGE");
  const records = await owned(schema);
  await rawReports(records, 17, 1_024, 1_000);
  await fenced(records, 400, "SYNC_RANGE_TOO_LARGE");

  // Counted fan-out: cohort rows over 16,384, then bucket rows over 65,536,
  // although the declared metadata is small.
  const cohorts = await owned(schema);
  await rawReports(cohorts, 17, 0, 100);
  await rawCohorts(cohorts, 1_024);
  await fenced(cohorts, 400, "SYNC_RANGE_TOO_LARGE");
  const buckets = await owned(schema);
  await rawReports(buckets, 1, 0, 100);
  await rawCohorts(buckets, 400);
  await rawBuckets(buckets);
  assert.ok(await count(schema, "telemetry_performance_buckets",
    `report_id IN (SELECT id FROM ${t("telemetry_performance_reports")} WHERE participant_id = $1)`,
    [buckets.owner.participantId]) > 65_536);
  await fenced(buckets, 400, "SYNC_RANGE_TOO_LARGE");

  // Storage drift: detail rows that disagree with the declared record count are unavailable.
  const drift = await owned(schema);
  await rawReports(drift, 1, 0, 100);
  await rawCohorts(drift, 1);
  await fenced(drift, 503, "BACKEND_STORAGE_UNAVAILABLE");

  // A tombstone day (zero records) reads as a report with no cohorts.
  const tombstone = await owned(schema);
  await insertPerformanceReport(pool, { schema, owner: tombstone.owner, grant: tombstone.grant, reportDay: DAY, records: [] });
  const empty = await read(schema, tombstone.owner);
  assert.deepEqual(empty.reports.map((entry) => [entry.day, entry.cohorts]), [[DAY, []]]);
});
