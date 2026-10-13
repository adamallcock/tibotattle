/**
 * PG17 spec for the community model performance stage of the analytics-refresh
 * Job (SPD-P3): the in-process Job (cloud-run/analytics-refresh.mjs) with the
 * default pipeline (createAnalyticsV2Pipeline) over the real A-1 readers, the
 * real A-2 compute core and the optional performance stage, which streams the
 * current performance reports (src/analytics-v2/performance-source.ts) into
 * the fold (src/analytics-v2/compute-performance.ts) after computeAnalyticsV2
 * returns, and publishes through the store (store-publication.ts).
 *
 * It proves, on the promoted primary chain (0001-0079) with the shared SPD-G1
 * fixtures (postgres-test/fixtures/performance-telemetry.mjs):
 * - an empty corpus, or one with no included record (excluded, unknown-mode
 *   or after the publication's end), writes no head (deferred empty first
 *   publication, GATE-Q 12);
 * - the first run with data publishes all twelve heads with kernel stamps; a
 *   rerun writes nothing; a new report bumps only the slots it reaches;
 * - the candidates are charged to the run's output account exactly once
 *   (the fold gets no account; the run row records them);
 * - community aggregate exclusions apply per participant and day;
 * - purge propagation: after DELETE FROM participants the next run revises
 *   every head to empty models;
 * - a forced withhold (an invalid stored record) keeps every prior head and
 *   records its code in the run row and the receipt, while the daily
 *   publication of the same run commits;
 * - a pipeline without the performance stage writes nothing new.
 * Without PostgreSQL it still proves the digest parity of the fold's and the
 * store's content digests on every golden candidate, and that the store's
 * deferred-empty predicate equals GATE-Q 12's measure under the fold.
 *
 * Every identifier, payload and record is synthetic and content-free.
 * Registered in apps/worker/package.json's postgres:domain:check.
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<id>/socket PG_TEST_PORT=<port> \
 *   node --test --test-concurrency=1 postgres-test/analytics-v2-model-performance.spec.mjs
 * Without PG_TEST_SOCKET/PG_TEST_HOST the database cases skip.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import * as job from "../cloud-run/analytics-refresh.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import * as seedFixture from "./fixtures/analytics-v2/direct-seed.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_FIXTURE_MODEL,
  PERFORMANCE_MIGRATION_NAME,
  PERFORMANCE_PUBLICATION_PERIODS,
  PERFORMANCE_PUBLICATION_SPEED_MODES,
  activatePerformanceRuntime,
  insertPerformanceGrant,
  insertPerformanceReport,
  performanceTable,
  seedPerformanceAccountlessOwner,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(WORKER_ROOT, "analytics-v2-test", "golden-performance");
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
// The direct-seed corpus's clock: the publication ends on the latest completed UTC day.
const NOW = seedFixture.NOW;
const NOW_MS = seedFixture.NOW_MS;
const END = "2026-09-30";
const DAY_BEFORE = "2026-09-29";
const TODAY = "2026-10-01";
const SLOTS = PERFORMANCE_PUBLICATION_PERIODS.flatMap((period) =>
  PERFORMANCE_PUBLICATION_SPEED_MODES.map((speedMode) => `${period}:${speedMode}`));
const HEADS = "analytics_v2_published_performance";
const UNREVIEWED_MODEL = "synthetic-unreviewed-model";
// Fixture rows are stamped ten days before the Job's clock, inside their leases.
const SEEDED_AT_MS = NOW_MS - 10 * 86_400_000;

let vite;
let store;
let resources;
let performanceContract;
let computePerformance;
let performanceSource;
let a1;
let a2;
let seedModules;
let kernelIdentity;
let pool;
const schemas = [];

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    plugins: analyticsV2Config.plugins,
    resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  store = await load("/src/analytics-v2/store.ts");
  resources = await load("/src/analytics-v2/resources.ts");
  performanceContract = await load("/src/analytics-v2/performance-publication-contract.ts");
  computePerformance = await load("/src/analytics-v2/compute-performance.ts");
  performanceSource = await load("/src/analytics-v2/performance-source.ts");
  a1 = {
    owners: await load("/src/analytics-v2/owners.ts"),
    occurrences: await load("/src/analytics-v2/occurrence-source.ts"),
    devices: await load("/src/analytics-v2/devices.ts"),
    queuedDays: await load("/src/analytics-v2/queued-days.ts"),
    ownerSets: await load("/src/analytics-v2/owner-sets.ts"),
  };
  a2 = await load("/src/analytics-v2/compute.ts");
  seedModules = {
    codec: await load("/src/typed-telemetry-codec.ts"),
    v12codec: await load("/src/telemetry-v12-typed-codec.ts"),
    reconciliation: await load("/src/telemetry-usage-reconciliation.ts"),
    sha256Hex: (await load("/src/crypto.ts")).sha256Hex,
  };
  // The sources run unbundled, so they carry no build-time kernel identity:
  // the spec states registry entry 1's (K-STAMP), as the refresh spec does.
  const kernel = store.analyticsV2KernelRegistry()[0];
  kernelIdentity = Object.freeze({ vendorManifestSha256: kernel.vendorManifestSha256,
    computeClosureSha256: kernel.computeClosureSha256, methodVersion: kernel.methodVersion });
  if (ENDPOINT !== null) {
    pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 6, connectionTimeoutMillis: 5_000,
      application_name: "analytics-v2-model-performance-spec", options: "-c search_path=pg_catalog" });
    pool.on("error", () => {});
    const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
  }
});

after(async () => {
  if (pool !== undefined) {
    for (const schema of schemas.reverse()) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Without PostgreSQL: digest parity and the deferred-empty measure
// ---------------------------------------------------------------------------

async function goldenFold() {
  const input = JSON.parse(await readFile(join(GOLDEN, "input.json"), "utf8"));
  const expected = JSON.parse(await readFile(join(GOLDEN, "expected.json"), "utf8"));
  const excluded = new Set(input.exclusions.map(({ participantKey, day }) => `${participantKey}\u0000${day}`));
  const excludedOn = (participantKey, day) => excluded.has(`${String(participantKey)}\u0000${day}`);
  return { input, expected, excludedOn };
}

const namesModel = (outputs) => outputs.candidates.some((candidate) => candidate.payload.models.length > 0);

test("digest parity: the fold's and the store's content digests agree on every golden candidate", async () => {
  const { input, expected, excludedOn } = await goldenFold();
  const replay = await computePerformance.computeAnalyticsV2Performance({ records: input.records, nowMs: input.nowMs,
    excludedOn });
  assert.equal(expected.withheld, null);
  assert.equal(expected.candidates.length, 12);
  for (const [index, candidate] of [...expected.candidates, ...replay.candidates].entries()) {
    const closureSide = await computePerformance.analyticsV2PerformanceContentSha256(candidate.payload);
    const storeSide = await performanceContract.analyticsV2PerformanceContentSha256(candidate.payload);
    assert.equal(closureSide, candidate.payloadSha256, `candidate ${index}: the fold's digest`);
    assert.equal(storeSide, closureSide, `candidate ${index}: the store's digest equals the fold's`);
    // A stamped head (the store's revision and generatedAt) keeps the same content digest on both sides.
    const stamped = performanceContract.stampAnalyticsV2PerformancePayload(candidate.payload,
      { revision: 7 + index, generatedAt: "2027-01-02T03:04:05.006Z" });
    assert.equal(await computePerformance.analyticsV2PerformanceContentSha256(stamped), closureSide);
    assert.equal(await performanceContract.analyticsV2PerformanceContentSha256(stamped), closureSide);
  }
  assert.deepEqual(replay.candidates.map((candidate) => candidate.payloadSha256),
    expected.candidates.map((candidate) => candidate.payloadSha256), "the committed golden replays");
  // Any content change moves both digests alike.
  const changed = { ...expected.candidates[0].payload, excludedUnknownTurns: 1 + expected.candidates[0].payload.excludedUnknownTurns };
  assert.equal(await computePerformance.analyticsV2PerformanceContentSha256(changed),
    await performanceContract.analyticsV2PerformanceContentSha256(changed));
  assert.notEqual(await computePerformance.analyticsV2PerformanceContentSha256(changed), expected.candidates[0].payloadSha256);
});

test("GATE-Q 12: under the fold, a candidate names a model exactly when an included record was counted", async () => {
  const { input, expected, excludedOn } = await goldenFold();
  const fold = (records, predicate = excludedOn) => computePerformance.computeAnalyticsV2Performance({ records,
    nowMs: input.nowMs, excludedOn: predicate });
  const results = [
    await fold(input.records),
    await fold([]),
    // Every participant excluded on every day.
    await fold(input.records, () => true),
    // Only the records the publication leaves out (unknown, mixed or other modes, or after its end).
    await fold(input.records.filter((item) => !["standard", "fast", "ultrafast"].includes(item.record.speedMode)
      || item.reportDay > expected.summary.end)),
  ];
  // Each record alone: included, excluded, deferred or left out by its mode.
  for (const item of input.records) results.push(await fold([item]));
  let included = 0;
  let empty = 0;
  for (const outputs of results) {
    if (outputs.withheld !== null) continue;
    assert.equal(outputs.summary.includedRecords > 0, namesModel(outputs),
      "the store's deferred-empty predicate (no candidate names a model) equals includedRecords === 0");
    if (outputs.summary.includedRecords > 0) included += 1;
    else empty += 1;
  }
  assert.ok(included > 0 && empty > 0, "both sides of the equivalence are exercised");
});

// ---------------------------------------------------------------------------
// The Job over PostgreSQL
// ---------------------------------------------------------------------------

async function promotedSchema() {
  const schema = `p3_perf_${randomBytes(5).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME, "the promoted chain ends at 0079");
  await activatePerformanceRuntime(pool, { schema, nowEpoch: SEEDED_AT_MS });
  return schema;
}

const t = (schema, name) => performanceTable(schema, name);

/**
 * The default pipeline with the performance stage. `fold` records each fold
 * call's input keys (the Job must give it no output account); `computed`
 * keeps each run's outputs as the store receives them.
 */
function stagePipeline({ withPerformance = true } = {}) {
  const folds = [];
  const computed = [];
  const fold = Object.freeze({
    ...computePerformance,
    async computeAnalyticsV2Performance(input) {
      folds.push(Object.keys(input).sort());
      return computePerformance.computeAnalyticsV2Performance(input);
    },
  });
  const inner = job.createAnalyticsV2Pipeline({ ...a1, compute: a2,
    ...(withPerformance ? { performance: { source: performanceSource, compute: fold } } : {}) });
  return {
    folds,
    computed,
    pipeline: Object.freeze({
      read: (...args) => inner.read(...args),
      async compute(...args) {
        const outputs = await inner.compute(...args);
        computed.push(outputs);
        return outputs;
      },
    }),
  };
}

function jobEnvironment() {
  const env = { ANALYTICS_V2_TEST_CLOCK: "1", ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024" };
  for (const name of ["PG_TEST_SOCKET", "PG_TEST_HOST", "PG_TEST_PORT", "PG_TEST_USER",
    "PG_TEST_DATABASE", "PG_TEST_PASSWORD"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function jobPool(database) {
  assert.equal(database.kind, "local");
  return new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.user,
    database: database.database,
    ...(database.password === undefined ? {} : { password: database.password }),
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
    application_name: "analytics-v2-model-performance-spec-job",
    options: "-c search_path=pg_catalog",
  });
}

function runJob(schema, pipeline) {
  return job.runAnalyticsRefresh({
    argv: ["--mode=full", `--schema=${schema}`, `--now=${NOW}`],
    env: jobEnvironment(),
    dependencies: { modules: { store, pipeline }, createPool: jobPool, kernelIdentity },
  });
}

/** One accountless owner with a current 2026-09-29.1 grant (fixture rows stamped before the Job's clock). */
async function contributor(schema) {
  const owner = await seedPerformanceAccountlessOwner(pool, { schema, issuedAtEpoch: SEEDED_AT_MS - 86_400_000,
    leaseMs: 60 * 86_400_000 });
  const grant = await insertPerformanceGrant(pool, { schema, owner, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    dictionaryBasis: "v12_parser_inference", nowEpoch: SEEDED_AT_MS });
  return { owner, grant };
}

/** One current report for `day` holding `records` (record options, see syntheticPerformanceRecord). */
async function report(schema, who, day, records, { sourceRevision = 1 } = {}) {
  return insertPerformanceReport(pool, { schema, owner: who.owner, grant: who.grant, reportDay: day,
    records: records.map((options) => syntheticPerformanceRecord({ day, ...options })), sourceRevision,
    nowEpoch: SEEDED_AT_MS });
}

async function heads(schema) {
  const rows = (await pool.query(`SELECT period, speed_mode, revision, payload, payload_sha256, run_id::text AS run_id,
      kernel_id, manifest_version FROM ${t(schema, HEADS)} ORDER BY period, speed_mode`)).rows;
  return new Map(rows.map((row) => [`${row.period}:${row.speed_mode}`, row]));
}

async function headsSnapshot(schema) {
  return (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.period, h.speed_mode), '[]'::jsonb)::text
    AS rows FROM ${t(schema, HEADS)} h`)).rows[0].rows;
}

async function runRow(schema, runId) {
  return (await pool.query(`SELECT publication, timings, kernel_id FROM ${t(schema, "analytics_v2_runs")}
    WHERE run_id = $1::uuid`, [runId])).rows[0];
}

async function publishedDays(schema) {
  return (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, revision FROM ${t(schema, "analytics_v2_published_daily")}
    ORDER BY day`)).rows;
}

const slotPayload = (stored, slot) => stored.get(slot).payload;

test("PG17: an empty corpus, or one without an included record, writes no head (deferred empty first publication)", {
  skip: PG_SKIP, timeout: 300_000,
}, async () => {
  const schema = await promotedSchema();
  const { pipeline } = stagePipeline();
  const empty = await runJob(schema, pipeline);
  assert.equal(empty.state, "complete");
  assert.deepEqual(empty.performance, { reports: 0, cohorts: 0, excludedUnknownTurns: 0, deferredFutureDays: 0,
    published: [], unchanged: 0, withheld: null, deferredEmpty: true });
  assert.deepEqual((await runRow(schema, empty.runId)).publication.performance,
    { published: [], unchanged: [], withheld: null, deferredEmpty: true });
  assert.equal((await heads(schema)).size, 0);

  // Records the publication leaves out: an unknown-mode turn, an excluded
  // participant's record and a report after the publication's end.
  const unknownMode = await contributor(schema);
  await report(schema, unknownMode, END, [{ speedMode: "unknown", speedModeSource: "unobserved", turns: 4 }]);
  const excluded = await contributor(schema);
  await report(schema, excluded, END, [{}]);
  await pool.query(`INSERT INTO ${t(schema, "community_aggregate_exclusions")} (exclusion_id, participant_id, scope,
      reason_code, state, effective_at, expires_at, created_at, created_by_digest)
    VALUES ('synthetic-exclusion-deferred', $1, 'community_weekly', 'data_quality', 'active', $2, $3, $2, $4)`,
  [excluded.owner.participantId, `${END}T00:00:00.000Z`, `${END}T23:59:59.999999Z`, "e".repeat(64)]);
  const later = await contributor(schema);
  await report(schema, later, TODAY, [{}]);
  const leftOut = await runJob(schema, pipeline);
  assert.equal(leftOut.state, "complete");
  assert.deepEqual(leftOut.performance, { reports: 2, cohorts: 2, excludedUnknownTurns: 4, deferredFutureDays: 1,
    published: [], unchanged: 0, withheld: null, deferredEmpty: true });
  assert.equal((await heads(schema)).size, 0, "nothing is published until the first run with an included record");
});

test("PG17: the first run with data publishes twelve stamped heads, a rerun writes nothing, a new report bumps only its slots", {
  skip: PG_SKIP, timeout: 300_000,
}, async () => {
  const schema = await promotedSchema();
  const { pipeline, folds, computed } = stagePipeline();
  const first = await contributor(schema);
  await report(schema, first, DAY_BEFORE, [{ speedMode: "standard", speedBucket: 30 }, { speedMode: "ultrafast",
    speedBucket: 50, turns: 2 }]);
  const run1 = await runJob(schema, pipeline);
  assert.equal(run1.state, "complete");
  assert.deepEqual(run1.performance, { reports: 1, cohorts: 2, excludedUnknownTurns: 0, deferredFutureDays: 0,
    published: SLOTS, unchanged: 0, withheld: null, deferredEmpty: false });
  const row1 = await runRow(schema, run1.runId);
  assert.deepEqual(row1.publication.performance, { published: SLOTS, unchanged: [], withheld: null, deferredEmpty: false });
  // The daily side is unchanged by the stage: nothing is queued, nothing published.
  assert.deepEqual(row1.publication.published, []);
  assert.deepEqual(row1.publication.blocked, []);
  const stored1 = await heads(schema);
  assert.equal(stored1.size, 12);
  for (const slot of SLOTS) {
    const head = stored1.get(slot);
    assert.equal(head.revision, 1);
    assert.equal(head.payload.revision, 1);
    assert.equal(head.payload.generatedAt, NOW);
    assert.equal(head.payload.end, END);
    // Kernel stamps: the run's kernel and manifest, and the run itself.
    assert.equal(head.kernel_id, row1.kernel_id);
    assert.equal(head.kernel_id, store.analyticsV2KernelRegistry()[0].kernelId);
    assert.equal(head.manifest_version, store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry()[0]).manifestVersion);
    assert.equal(head.run_id, run1.runId);
    assert.equal(head.payload_sha256, await performanceContract.analyticsV2PerformanceContentSha256(head.payload));
  }
  assert.deepEqual(slotPayload(stored1, "7:standard").models.map((model) => [model.provider, model.modelId, model.turns]),
    [[PERFORMANCE_FIXTURE_MODEL.provider, PERFORMANCE_FIXTURE_MODEL.modelId, 3]]);
  assert.equal(slotPayload(stored1, "7:ultrafast").models[0].turns, 2);
  assert.deepEqual(slotPayload(stored1, "1:standard").models, [], "the 1-day window holds only the end day");
  assert.deepEqual(slotPayload(stored1, "all:fast").models, []);

  // Charged exactly once: the fold ran without an account, and the run row's
  // account is compute's plus the candidates' bytes, recorded once.
  // (No task timeout here, so the Job passes no checkpoint either.)
  assert.deepEqual(folds, [["excludedOn", "nowMs", "records"]]);
  const outputs1 = computed.at(-1);
  assert.equal(outputs1.performance.candidates.length, 12);
  const charged = outputs1.performance.candidates.reduce((total, candidate) =>
    total + resources.analyticsV2OutputRowBytes(candidate), 0);
  assert.ok(charged > 0);
  assert.ok(outputs1.resources !== undefined, "the Job's run carries a resource record");
  assert.equal(row1.timings.account.accountBytes, outputs1.resources.account.accountBytes + charged);
  assert.equal(row1.timings.account.heldInputBytes, outputs1.resources.account.heldInputBytes);
  assert.equal(row1.timings.account.outputBudgetBytes, outputs1.resources.account.outputBudgetBytes);

  // A rerun over the same reports writes nothing.
  const snapshot1 = await headsSnapshot(schema);
  const run2 = await runJob(schema, pipeline);
  assert.deepEqual(run2.performance, { reports: 1, cohorts: 2, excludedUnknownTurns: 0, deferredFutureDays: 0,
    published: [], unchanged: 12, withheld: null, deferredEmpty: false });
  assert.deepEqual((await runRow(schema, run2.runId)).publication.performance,
    { published: [], unchanged: SLOTS, withheld: null, deferredEmpty: false });
  assert.equal(await headsSnapshot(schema), snapshot1);

  // A new Fast report on the end day reaches the four Fast slots only.
  const second = await contributor(schema);
  await report(schema, second, END, [{ speedMode: "fast", speedBucket: 40 }]);
  const run3 = await runJob(schema, pipeline);
  const fastSlots = SLOTS.filter((slot) => slot.endsWith(":fast"));
  assert.deepEqual(run3.performance.published, fastSlots);
  assert.equal(run3.performance.unchanged, 8);
  const stored3 = await heads(schema);
  for (const slot of SLOTS) {
    const before = stored1.get(slot);
    const now = stored3.get(slot);
    if (fastSlots.includes(slot)) {
      assert.equal(now.revision, 2, slot);
      assert.equal(now.run_id, run3.runId, slot);
      assert.equal(now.payload.models.length, 1, slot);
    } else {
      assert.deepEqual(now, before, `${slot} keeps its row`);
    }
  }
});

test("PG17: community aggregate exclusions leave a participant out of the days they cover", {
  skip: PG_SKIP, timeout: 300_000,
}, async () => {
  const schema = await promotedSchema();
  const { pipeline } = stagePipeline();
  const kept = await contributor(schema);
  const excluded = await contributor(schema);
  await report(schema, kept, END, [{ turns: 2 }]);
  await report(schema, excluded, END, [{ turns: 5 }]);
  await report(schema, excluded, DAY_BEFORE, [{ turns: 7 }]);
  // Active on the end day only: the day before still counts.
  await pool.query(`INSERT INTO ${t(schema, "community_aggregate_exclusions")} (exclusion_id, participant_id, scope,
      reason_code, state, effective_at, expires_at, created_at, created_by_digest)
    VALUES ('synthetic-exclusion-perf', $1, 'community_weekly', 'data_quality', 'active', $2, $3, $2, $4)`,
  [excluded.owner.participantId, `${END}T00:00:00.000Z`, `${END}T23:59:59.999999Z`, "e".repeat(64)]);
  const run = await runJob(schema, pipeline);
  assert.equal(run.state, "complete");
  const stored = await heads(schema);
  const one = slotPayload(stored, "1:standard");
  assert.equal(one.contributors, 1, "the excluded participant is out of the end day");
  assert.equal(one.models[0].turns, 2);
  const seven = slotPayload(stored, "7:standard");
  assert.equal(seven.contributors, 2, "and still counts on the day before");
  assert.equal(seven.models[0].turns, 9);
  assert.equal(run.performance.reports, 3);
  assert.equal(run.performance.cohorts, 3);
});

test("PG17: purge propagation: after DELETE FROM participants the next run revises every head to empty models", {
  skip: PG_SKIP, timeout: 300_000,
}, async () => {
  const schema = await promotedSchema();
  const { pipeline } = stagePipeline();
  const who = await contributor(schema);
  await report(schema, who, END, [{ speedMode: "standard" }, { speedMode: "fast" }, { speedMode: "ultrafast" }]);
  const published = await runJob(schema, pipeline);
  assert.deepEqual(published.performance.published, SLOTS);
  // The offline purge removes the participant; its performance rows cascade.
  await pool.query(`DELETE FROM ${t(schema, "participants")} WHERE id = $1`, [who.owner.participantId]);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS n FROM ${t(schema, "telemetry_performance_reports")}`))
    .rows[0].n), 0);
  const purged = await runJob(schema, pipeline);
  assert.equal(purged.state, "complete");
  assert.deepEqual(purged.performance, { reports: 0, cohorts: 0, excludedUnknownTurns: 0, deferredFutureDays: 0,
    published: SLOTS, unchanged: 0, withheld: null, deferredEmpty: false });
  const stored = await heads(schema);
  assert.equal(stored.size, 12);
  for (const slot of SLOTS) {
    const head = stored.get(slot);
    assert.equal(head.revision, 2, slot);
    assert.equal(head.run_id, purged.runId);
    assert.deepEqual(head.payload.models, [], slot);
    assert.equal(head.payload.contributors, 0);
    assert.equal(head.payload.devices, 0);
    assert.equal(head.payload.reports, 0);
  }
});

test("PG17: a forced withhold keeps every prior head and records its code, while the daily publication commits", {
  skip: PG_SKIP, timeout: 600_000,
}, async () => {
  const schema = await promotedSchema();
  const { pipeline } = stagePipeline();
  const who = await contributor(schema);
  await report(schema, who, DAY_BEFORE, [{}]);
  const first = await runJob(schema, pipeline);
  assert.deepEqual(first.performance.published, SLOTS);
  const before = await headsSnapshot(schema);

  // The daily corpus arrives (A-1's direct-seed fixture: D3 publishes), and so
  // does a stored record the contract refuses (a model the reviewed catalog
  // does not name), which withholds the whole performance publication.
  await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules, correctionRuntime: "active" });
  const invalid = await contributor(schema);
  await report(schema, invalid, END, [{ modelId: UNREVIEWED_MODEL }]);
  const withheld = await runJob(schema, pipeline);
  assert.equal(withheld.state, "complete");
  assert.ok(withheld.published.includes(seedFixture.D3), "the daily publication commits in the same run");
  assert.deepEqual((await publishedDays(schema)).filter(({ day }) => day === seedFixture.D3),
    [{ day: seedFixture.D3, revision: 1 }]);
  assert.deepEqual(withheld.performance, { reports: 2, cohorts: 2, excludedUnknownTurns: 0, deferredFutureDays: 0,
    published: [], unchanged: 0, withheld: "ANALYTICS_V2_PERFORMANCE_RECORD_INVALID", deferredEmpty: false });
  const row = await runRow(schema, withheld.runId);
  assert.deepEqual(row.publication.performance, { published: [], unchanged: [],
    withheld: "ANALYTICS_V2_PERFORMANCE_RECORD_INVALID", deferredEmpty: false });
  assert.equal(await headsSnapshot(schema), before, "every prior head is kept byte for byte");
  // Nothing in the receipt or the run row names the refused model.
  assert.equal(JSON.stringify(withheld).includes(UNREVIEWED_MODEL), false);
  assert.equal(JSON.stringify(row).includes(UNREVIEWED_MODEL), false);
});

test("PG17: a pipeline without the performance stage writes nothing new", {
  skip: PG_SKIP, timeout: 300_000,
}, async () => {
  const schema = await promotedSchema();
  const who = await contributor(schema);
  await report(schema, who, END, [{}]);
  const { pipeline, computed } = stagePipeline({ withPerformance: false });
  const run = await runJob(schema, pipeline);
  assert.equal(run.state, "complete");
  assert.equal(Object.hasOwn(run, "performance"), false, "the receipt has no performance block");
  assert.equal(Object.hasOwn(computed[0], "performance"), false);
  const row = await runRow(schema, run.runId);
  assert.equal(Object.hasOwn(row.publication, "performance"), false, "the run row has no performance block");
  assert.equal((await heads(schema)).size, 0);
});
