/**
 * PG17 spec for the community model performance publication store (SPD-P1):
 * the twelve community-model-performance-v1 heads in
 * analytics_v2_published_performance (primary 0079), written by
 * src/analytics-v2/store-publication.ts writeAnalyticsV2PublishedPerformance
 * inside the run's one write transaction (store.ts writeRunOutputs), after the
 * closed validation in store-run.ts prepareOutputs.
 *
 * It proves: the first write; a deferred all-empty first run (no row
 * written); an unchanged rerun writes nothing and a changed slot bumps only
 * its own revision; purge propagation (after DELETE FROM participants the
 * all-empty candidates revise every head to empty models with zero counts);
 * the forward-only trigger; the kernel stamps; a withheld run leaves every
 * head untouched; a run without performance outputs writes nothing of it;
 * and the closed refusals (shape, slots, placeholders, digest, output account)
 * write nothing.
 *
 * Each case applies the promoted primary chain (0001-0079) into a fresh
 * random schema, dropped afterwards. Every payload, digest and identifier is
 * synthetic and content-free; owner graphs come from the shared SPD-G1
 * fixtures (postgres-test/fixtures/performance-telemetry.mjs).
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<id>/socket PG_TEST_PORT=<port> \
 *   node --test --test-concurrency=1 postgres-test/analytics-v2-performance-publication.spec.mjs
 * Without PG_TEST_SOCKET/PG_TEST_HOST every case skips.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import * as telemetryContract from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { NO_ANALYTICS_V2_EXCLUSIONS_SHA256, postgresTestEndpoint } from "./staged-migrations-harness.mjs";
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
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const NOW = "2026-10-11T03:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const END = "2026-10-10";
const REPORT_DAY = "2026-10-09";
const HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
const NO_OWNER_SETS = Object.freeze({ contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
  memberContributionUnavailableDays: [], memberLinkUnavailableDays: [] });
const SLOTS = PERFORMANCE_PUBLICATION_PERIODS.flatMap((period) =>
  PERFORMANCE_PUBLICATION_SPEED_MODES.map((speedMode) => ({ period, speedMode })));
const slotKey = ({ period, speedMode }) => `${period}:${speedMode}`;
const ALL_SLOT_KEYS = SLOTS.map(slotKey);
const HEADS = "analytics_v2_published_performance";

let vite;
let contract;
let store;
let specStamp;
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
  contract = await vite.ssrLoadModule("/src/analytics-v2/contract.ts");
  store = await vite.ssrLoadModule("/src/analytics-v2/store.ts");
  specStamp = store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry()[0]);
  if (ENDPOINT !== null) {
    pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 6, connectionTimeoutMillis: 5_000,
      application_name: "analytics-v2-performance-publication-spec", options: "-c search_path=pg_catalog" });
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

async function promotedSchema() {
  const schema = `p1_perf_${randomBytes(5).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PERFORMANCE_MIGRATION_NAME, "the promoted chain ends at 0079");
  return schema;
}

const t = (schema, name) => performanceTable(schema, name);

/** A median-only point (n < 5) at `day`. */
function point(day, estimate, n = 1, unresolved = 0) {
  return { day, n, unresolved, p10: null, p25: null,
    median: { estimate, lower: Math.max(0, estimate - 5), upper: estimate + 5 }, p75: null, p90: null };
}

/**
 * A candidate payload for one slot, as the fold emits it: the placeholder
 * revision 1 and generatedAt = nowMs, a window ending on END. `speed` > 0
 * adds one reviewed model with one speed and one first-token sample;
 * 0 publishes no model and zero counts.
 */
function payloadFor({ period, speedMode }, speed = 0) {
  const start = period === "all" ? "2026-09-21"
    : new Date(Date.parse(`${END}T00:00:00.000Z`) - (Number(period) - 1) * 86_400_000).toISOString().slice(0, 10);
  const models = speed > 0 ? [{
    provider: PERFORMANCE_FIXTURE_MODEL.provider,
    modelId: PERFORMANCE_FIXTURE_MODEL.modelId,
    turns: 1, speedTurns: 1, ttftTurns: 1, timedResponses: 1, toolFreeTurns: 0, contributors: 1, devices: 1,
    speed: { unit: "tokens_per_second", points: [point(END, speed)] },
    ttft: { unit: "milliseconds", points: [point(END, 900)] },
  }] : [];
  const payload = {
    schemaVersion: "community-model-performance-v1",
    methodVersion: "performance-histogram-pool-type7-bounds-v1",
    population: "reported_samples",
    approximate: true,
    revision: 1,
    generatedAt: NOW,
    period,
    interval: "day",
    start,
    end: END,
    speedMode,
    excludedUnknownTurns: 0,
    contributors: models.length,
    devices: models.length,
    reports: models.length,
    models,
  };
  return telemetryContract.parseCommunityModelPerformance(payload);
}

/** The twelve candidates; `speeds` maps a slot key to its model speed (absent: empty). */
async function candidates(speeds = {}) {
  return Promise.all(SLOTS.map(async (slot) => {
    const payload = payloadFor(slot, speeds[slotKey(slot)] ?? 0);
    return { period: slot.period, speedMode: slot.speedMode, payload,
      payloadSha256: await store.analyticsV2PerformanceContentSha256(payload) };
  }));
}

const SUMMARY = Object.freeze({ reports: 0, cohorts: 0, includedRecords: 0, excludedRecords: 0,
  excludedUnknownTurns: 0, deferredFutureDays: 0, end: END });

function performance(list, overrides = {}) {
  return { candidates: list, summary: { ...SUMMARY }, withheld: null, ...overrides };
}

function outputs(perf, overrides = {}) {
  return {
    contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION,
    mode: "full",
    nowMs: NOW_MS,
    today: NOW.slice(0, 10),
    revisionSeed: 0,
    owners: [],
    ownerDays: [],
    ownerDayPrices: [],
    cacheBands: [],
    ownerFits: [],
    ownerModelDates: [],
    dailyCandidates: [],
    blockedDays: [],
    ownerSets: NO_OWNER_SETS,
    preview: null,
    refusals: [],
    journal: { lastSequence: null },
    timings: {},
    ...(perf === undefined ? {} : { performance: perf }),
    ...overrides,
  };
}

async function write(schema, runOutputs, { runId = randomUUID(), stamp = specStamp } = {}) {
  const client = await pool.connect();
  try {
    return await store.writeRunOutputs(client, runOutputs, { schema, runId, startedAtMs: NOW_MS,
      expectedCursor: null, horizon: HORIZON, stamp, exclusionsSha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256 });
  } finally {
    client.release();
  }
}

/** Every head, keyed by slot. */
async function heads(schema) {
  const rows = (await pool.query(`SELECT period, speed_mode, revision, released_at, payload, payload_sha256,
      run_id::text AS run_id, kernel_id, manifest_version FROM ${t(schema, HEADS)} ORDER BY period, speed_mode`)).rows;
  return new Map(rows.map((row) => [`${row.period}:${row.speed_mode}`, row]));
}

/** The heads table, canonicalized, for exact before/after comparison. */
async function headsSnapshot(schema) {
  return (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.period, h.speed_mode), '[]'::jsonb)::text
    AS rows FROM ${t(schema, HEADS)} h`)).rows[0].rows;
}

async function runRow(schema, runId) {
  return (await pool.query(`SELECT publication FROM ${t(schema, "analytics_v2_runs")} WHERE run_id = $1::uuid`,
    [runId])).rows[0];
}

async function count(schema, table, where = "TRUE") {
  return Number((await pool.query(`SELECT count(*)::integer AS n FROM ${t(schema, table)} WHERE ${where}`)).rows[0].n);
}

const refusedWith = (code, field) => (error) => {
  assert.equal(error?.name, "AnalyticsV2StoreError", String(error?.message));
  assert.equal(error.code, code);
  if (field !== undefined) assert.equal(error.field, field);
  return true;
};

test("PG17: the first write publishes all twelve slots with store-stamped revisions and kernel stamps", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  const list = await candidates(Object.fromEntries(ALL_SLOT_KEYS.map((key, index) => [key, 40 + index])));
  const runId = randomUUID();
  const receipt = await write(schema, outputs(performance(list), { revisionSeed: 6 }), { runId });
  assert.deepEqual(receipt.publication.performance,
    { published: ALL_SLOT_KEYS, unchanged: [], withheld: null, deferredEmpty: false });
  const stored = await heads(schema);
  assert.equal(stored.size, 12);
  for (const candidate of list) {
    const head = stored.get(slotKey(candidate));
    // nextPublishedRevision({ head: none, floor: null, seed: 6 }) = 7.
    assert.equal(head.revision, 7);
    assert.equal(head.payload.revision, 7);
    assert.equal(head.payload.generatedAt, NOW, "generatedAt is the run's release instant");
    assert.equal(head.released_at.toISOString(), NOW);
    assert.equal(head.payload_sha256, candidate.payloadSha256);
    assert.equal(await store.analyticsV2PerformanceContentSha256(head.payload), candidate.payloadSha256,
      "the digest excludes the stamped revision and generatedAt");
    assert.deepEqual({ ...head.payload, revision: 1 }, candidate.payload);
    assert.doesNotThrow(() => telemetryContract.parseCommunityModelPerformance(head.payload));
    assert.equal(head.run_id, runId);
    assert.equal(head.kernel_id, specStamp.kernel.kernelId);
    assert.equal(head.manifest_version, specStamp.manifestVersion);
  }
  const row = await runRow(schema, runId);
  assert.deepEqual(row.publication.performance,
    { published: ALL_SLOT_KEYS, unchanged: [], withheld: null, deferredEmpty: false });
  // The block is content-free: slot names, a code and a flag.
  assert.deepEqual(Object.keys(row.publication.performance).sort(), ["deferredEmpty", "published", "unchanged", "withheld"]);
});

test("PG17: an all-empty first run is deferred and writes no head; the first run with data then publishes", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  const empty = await candidates();
  const runId = randomUUID();
  const receipt = await write(schema, outputs(performance(empty)), { runId });
  assert.deepEqual(receipt.publication.performance, { published: [], unchanged: [], withheld: null, deferredEmpty: true });
  assert.equal(await count(schema, HEADS), 0, "no row is written");
  assert.deepEqual((await runRow(schema, runId)).publication.performance,
    { published: [], unchanged: [], withheld: null, deferredEmpty: true });
  // A second empty run is still deferred.
  await write(schema, outputs(performance(empty)));
  assert.equal(await count(schema, HEADS), 0);
  // Any included record in any slot publishes every slot, empty ones included.
  const withData = await candidates({ "30:fast": 77 });
  const published = await write(schema, outputs(performance(withData)));
  assert.equal(published.publication.performance.deferredEmpty, false);
  assert.deepEqual(published.publication.performance.published, ALL_SLOT_KEYS);
  const stored = await heads(schema);
  assert.equal(stored.size, 12);
  assert.equal(stored.get("30:fast").payload.models.length, 1);
  assert.equal(stored.get("7:standard").payload.models.length, 0);
});

test("PG17: an unchanged rerun writes nothing; a changed slot bumps only its own revision", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  const speeds = { "1:standard": 50, "7:standard": 51, "all:ultrafast": 52 };
  const first = await candidates(speeds);
  await write(schema, outputs(performance(first)));
  const before = await headsSnapshot(schema);
  const rerunId = randomUUID();
  const rerun = await write(schema, outputs(performance(first)), { runId: rerunId });
  assert.deepEqual(rerun.publication.performance,
    { published: [], unchanged: ALL_SLOT_KEYS, withheld: null, deferredEmpty: false });
  assert.equal(await headsSnapshot(schema), before, "an unchanged rerun leaves every row byte-identical");
  assert.deepEqual((await runRow(schema, rerunId)).publication.performance.unchanged, ALL_SLOT_KEYS);

  const changedId = randomUUID();
  const changed = await write(schema, outputs(performance(await candidates({ ...speeds, "7:standard": 63 }))),
    { runId: changedId });
  assert.deepEqual(changed.publication.performance.published, ["7:standard"]);
  assert.deepEqual(changed.publication.performance.unchanged, ALL_SLOT_KEYS.filter((key) => key !== "7:standard"));
  const stored = await heads(schema);
  for (const [key, head] of stored) {
    assert.equal(head.revision, key === "7:standard" ? 2 : 1, key);
    assert.equal(head.run_id === changedId, key === "7:standard", key);
  }
  assert.equal(stored.get("7:standard").payload.models[0].speed.points[0].median.estimate, 63);
  assert.equal(stored.get("7:standard").payload.revision, 2);
  // A later seed above every head lifts only the changed slot (max(head, seed) + 1).
  await write(schema, outputs(performance(await candidates({ ...speeds, "7:standard": 63, "1:standard": 70 })), { revisionSeed: 40 }));
  const seeded = await heads(schema);
  assert.equal(seeded.get("1:standard").revision, 41);
  assert.equal(seeded.get("7:standard").revision, 2);
  assert.equal(seeded.get("all:ultrafast").revision, 1);
});

test("PG17: purge propagation: after DELETE FROM participants the all-empty candidates revise every head to empty", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  await activatePerformanceRuntime(pool, { schema });
  const owner = await seedPerformanceAccountlessOwner(pool, { schema });
  const grant = await insertPerformanceGrant(pool, { schema, owner, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    dictionaryBasis: "v12_parser_inference" });
  for (const speedMode of ["standard", "fast"]) {
    await insertPerformanceReport(pool, { schema, owner, grant, reportDay: REPORT_DAY,
      records: [syntheticPerformanceRecord({ day: REPORT_DAY, speedMode })], sourceRevision: speedMode === "fast" ? 2 : 1 });
  }
  assert.ok(await count(schema, "telemetry_performance_reports") > 0);
  // The published contribution of that owner, in every slot.
  const withData = await candidates(Object.fromEntries(ALL_SLOT_KEYS.map((key) => [key, 45])));
  await write(schema, outputs(performance(withData)));
  for (const head of (await heads(schema)).values()) {
    assert.equal(head.payload.models.length, 1);
    assert.equal(head.payload.contributors, 1);
  }

  // The offline purge removes the participant; its performance rows cascade.
  await pool.query(`DELETE FROM ${t(schema, "participants")} WHERE id = $1`, [owner.participantId]);
  for (const table of ["telemetry_performance_reports", "telemetry_performance_cohorts", "telemetry_performance_buckets",
    "telemetry_performance_receipts", "accountless_telemetry_performance_authorizations",
    "telemetry_performance_device_capabilities"]) {
    assert.equal(await count(schema, table), 0, `${table} cascades`);
  }
  // The heads hold no owner reference, so they still show the contribution until the next run.
  assert.equal((await heads(schema)).get("7:standard").payload.models.length, 1);

  // The next run's fold sees no record: every candidate is empty, and every head is revised.
  const purgeId = randomUUID();
  const empty = await candidates();
  const receipt = await write(schema, outputs(performance(empty)), { runId: purgeId });
  assert.deepEqual(receipt.publication.performance,
    { published: ALL_SLOT_KEYS, unchanged: [], withheld: null, deferredEmpty: false },
    "once any head exists, empty candidates are never deferred");
  const stored = await heads(schema);
  assert.equal(stored.size, 12);
  for (const candidate of empty) {
    const head = stored.get(slotKey(candidate));
    assert.equal(head.revision, 2);
    assert.equal(head.run_id, purgeId);
    assert.equal(head.payload_sha256, candidate.payloadSha256);
    assert.deepEqual(head.payload.models, []);
    for (const name of ["contributors", "devices", "reports", "excludedUnknownTurns"]) assert.equal(head.payload[name], 0, name);
  }
  // No purged contribution remains anywhere in the heads.
  assert.equal(await count(schema, HEADS, "jsonb_array_length(payload -> 'models') > 0"), 0);
  assert.equal(await count(schema, HEADS, `payload::text LIKE '%${PERFORMANCE_FIXTURE_MODEL.modelId}%'`), 0);
});

test("PG17: the forward-only trigger refuses a delete, a stale revision and an unchanged digest", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  await write(schema, outputs(performance(await candidates({ "1:fast": 30 }))));
  const forwardOnly = { code: "P1005", message: "analytics_v2_published_performance_forward_only" };
  await assert.rejects(pool.query(`DELETE FROM ${t(schema, HEADS)} WHERE period = '1' AND speed_mode = 'fast'`),
    { code: "P1005", message: "analytics_v2_published_performance_no_delete" });
  // The same digest at a higher revision.
  await assert.rejects(pool.query(`UPDATE ${t(schema, HEADS)} SET revision = 2,
      payload = jsonb_set(payload, '{revision}', '2') WHERE period = '1' AND speed_mode = 'fast'`), forwardOnly);
  // A new digest at the same revision.
  await assert.rejects(pool.query(`UPDATE ${t(schema, HEADS)} SET payload_sha256 = $1
      WHERE period = '1' AND speed_mode = 'fast'`, ["f".repeat(64)]), forwardOnly);
  // Moving a head to another slot.
  await assert.rejects(pool.query(`UPDATE ${t(schema, HEADS)} SET speed_mode = 'ultrafast', revision = 2,
      payload_sha256 = $1, payload = payload || '{"speedMode":"ultrafast","revision":2}'::jsonb
      WHERE period = '1' AND speed_mode = 'fast'`, ["e".repeat(64)]), forwardOnly);
  // A head stamped with an unregistered kernel is refused by the foreign key.
  await assert.rejects(pool.query(`UPDATE ${t(schema, HEADS)} SET revision = 2, payload_sha256 = $1, kernel_id = 999,
      payload = jsonb_set(payload, '{revision}', '2') WHERE period = '1' AND speed_mode = 'fast'`, ["d".repeat(64)]),
  { code: "23503" });
  assert.equal(await count(schema, HEADS, "revision = 1"), 12, "every refused statement left the heads at r1");
});

test("PG17: a later kernel restamps only the slots it publishes", { skip: PG_SKIP, timeout: 180_000 }, async () => {
  const registry = store.analyticsV2KernelRegistry();
  assert.ok(registry.length >= 2, "the registry holds at least two kernels");
  const schema = await promotedSchema();
  const older = specStamp;
  const newer = store.analyticsV2BaselineRunStamp(registry.at(-1));
  assert.notEqual(newer.kernel.kernelId, older.kernel.kernelId);
  await write(schema, outputs(performance(await candidates({ "30:standard": 20 }))), { stamp: older });
  await write(schema, outputs(performance(await candidates({ "30:standard": 21 }))), { stamp: newer });
  for (const [key, head] of await heads(schema)) {
    assert.equal(head.kernel_id, key === "30:standard" ? newer.kernel.kernelId : older.kernel.kernelId, key);
    assert.equal(head.manifest_version, key === "30:standard" ? newer.manifestVersion : older.manifestVersion, key);
  }
});

test("PG17: a withheld run leaves every head untouched and records its code; the rest of the run commits", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  await write(schema, outputs(performance(await candidates({ "7:fast": 88 }))));
  const before = await headsSnapshot(schema);
  const runId = randomUUID();
  const preview = { schemaVersion: "synthetic-preview-v1", marker: 3 };
  const receipt = await write(schema, outputs(performance([], { withheld: "ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED" }),
    { preview }), { runId });
  assert.deepEqual(receipt.publication.performance,
    { published: [], unchanged: [], withheld: "ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED", deferredEmpty: false });
  assert.equal(await headsSnapshot(schema), before, "the heads are byte-identical");
  assert.deepEqual((await runRow(schema, runId)).publication.performance,
    { published: [], unchanged: [], withheld: "ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED", deferredEmpty: false });
  const stored = (await pool.query(`SELECT preview, run_id::text AS run_id FROM ${t(schema, "analytics_v2_preview")}`)).rows;
  assert.deepEqual(stored, [{ preview, run_id: runId }], "the preview of the same run committed");
  // A withheld first run publishes nothing either.
  const fresh = await promotedSchema();
  await write(fresh, outputs(performance([], { withheld: "ANALYTICS_V2_PERFORMANCE_CAPACITY" })));
  assert.equal(await count(fresh, HEADS), 0);
});

test("PG17: a run without performance outputs writes no head and no performance block", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  await write(schema, outputs(performance(await candidates({ "1:standard": 10 }))));
  const before = await headsSnapshot(schema);
  const runId = randomUUID();
  const receipt = await write(schema, outputs(undefined), { runId });
  assert.equal(Object.hasOwn(receipt.publication, "performance"), false);
  const row = await runRow(schema, runId);
  assert.deepEqual(Object.keys(row.publication).sort(), ["blocked", "ownerSets", "published", "unchanged"]);
  assert.equal(await headsSnapshot(schema), before);
});

test("PG17: closed validation refuses malformed performance outputs before any write", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const schema = await promotedSchema();
  const list = await candidates({ "1:standard": 33 });
  const invalid = "ANALYTICS_V2_PERFORMANCE_OUTPUTS_INVALID";
  const restamp = async (candidate, payload) => ({ ...candidate, payload,
    payloadSha256: await store.analyticsV2PerformanceContentSha256(payload) });
  const cases = [
    [performance(list.slice(1)), invalid, "performance.candidates"],
    [performance([...list.slice(1), list[1]]), invalid, "performance.candidates"],
    [performance([...list, list[0]]), invalid, "performance.candidates"],
    [performance(list, { withheld: "ANALYTICS_V2_PERFORMANCE_CAPACITY" }), invalid, "performance.candidates"],
    [performance(list, { withheld: "ANALYTICS_V2_SOMETHING_ELSE" }), invalid, "performance.withheld"],
    [performance(list, { summary: { ...SUMMARY, end: "2026-10-11" } }), invalid, "performance.summary.end"],
    [performance(list, { summary: { ...SUMMARY, reports: -1 } }), invalid, "performance.summary.reports"],
    [performance(list, { summary: { ...SUMMARY, extra: 1 } }), invalid, "performance.summary"],
    [{ ...performance(list), extra: true }, invalid, "performance"],
    [performance([{ ...list[0], extra: 1 }, ...list.slice(1)]), invalid, "performance.candidates"],
    [performance([{ ...list[0], speedMode: "mixed" }, ...list.slice(1)]), invalid, "performance.candidates"],
    // The payload must name its own slot.
    [performance([{ ...list[0], period: "7" }, ...list.slice(1)]), invalid, "performance.candidates.payload"],
    // The fold's placeholders: revision 1 and generatedAt = nowMs.
    [performance([await restamp(list[0], { ...list[0].payload, revision: 7 }), ...list.slice(1)]), invalid,
      "performance.candidates.payload"],
    [performance([await restamp(list[0], { ...list[0].payload, generatedAt: "2026-10-11T04:00:00.000Z" }),
      ...list.slice(1)]), invalid, "performance.candidates.payload"],
    // A payload that is not community-model-performance-v1.
    [performance([await restamp(list[0], { ...list[0].payload, approximate: false }), ...list.slice(1)]), invalid,
      "performance.candidates.payload"],
    [performance([await restamp(list[0], { ...list[0].payload, contributors: 0 }), ...list.slice(1)]), invalid,
      "performance.candidates.payload"],
    // A digest that disagrees is refused, never re-derived.
    [performance([{ ...list[0], payloadSha256: "0".repeat(64) }, ...list.slice(1)]),
      "ANALYTICS_V2_PERFORMANCE_DIGEST_MISMATCH", "performance.candidates.payloadSha256"],
    [performance([{ ...list[0], payloadSha256: "A".repeat(64) }, ...list.slice(1)]), invalid,
      "performance.candidates.payloadSha256"],
  ];
  for (const [perf, code, field] of cases) {
    await assert.rejects(store.assertAnalyticsV2RunOutputs(outputs(perf), HORIZON), refusedWith(code, field), field);
  }
  // Through the writer: the refusal leaves every analytics_v2 table unchanged.
  await assert.rejects(write(schema, outputs(cases[0][0])), refusedWith(invalid));
  assert.equal(await count(schema, HEADS), 0);
  assert.equal(await count(schema, "analytics_v2_runs"), 0);
});

test("PG17: each candidate is charged to the run's output account, which must stay within its budget", {
  skip: PG_SKIP, timeout: 180_000,
}, async () => {
  const list = await candidates({ "all:standard": 90 });
  const charged = list.reduce((total, candidate) =>
    total + 128 + 2 * JSON.stringify(candidate).length, 0);
  const resources = (accountBytes, outputBudgetBytes) => ({
    configuration: { memoryModel: "analytics-v2-memory-model-v1", outputModel: "analytics-v2-output-model-v1",
      memoryBudgetBytes: 1_048_576, maxDayOccurrences: 1_000, maxDayRecordBytes: 1_048_576, outputBudgetBytes },
    owners: [],
    account: { heldInputBytes: 0, accountBytes, outputBudgetBytes },
  });
  const budget = 4_194_304;
  // Exactly enough room: accepted.
  await store.assertAnalyticsV2RunOutputs(outputs(performance(list), { resources: resources(budget - charged, budget) }),
    HORIZON);
  // One byte short: refused as output capacity.
  await assert.rejects(store.assertAnalyticsV2RunOutputs(outputs(performance(list),
    { resources: resources(budget - charged + 1, budget) }), HORIZON),
  refusedWith("ANALYTICS_V2_OUTPUTS_CAPACITY_EXCEEDED", "performance.candidates"));
  // A withheld run charges nothing.
  await store.assertAnalyticsV2RunOutputs(outputs(performance([], { withheld: "ANALYTICS_V2_PERFORMANCE_CAPACITY" }),
    { resources: resources(budget, budget) }), HORIZON);
  // Through the writer, a refused charge writes nothing.
  const schema = await promotedSchema();
  await assert.rejects(write(schema, outputs(performance(list), { resources: resources(budget, budget) })),
    refusedWith("ANALYTICS_V2_OUTPUTS_CAPACITY_EXCEEDED"));
  assert.equal(await count(schema, HEADS), 0);
});

test("PG17: the store's table, columns and slots match the promoted migration and the contract", {
  skip: PG_SKIP, timeout: 120_000,
}, async () => {
  const schema = await promotedSchema();
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
  [schema, store.ANALYTICS_V2_PERFORMANCE_TABLES.publishedPerformance])).rows.map((row) => row.column_name);
  assert.deepEqual(columns, [...store.ANALYTICS_V2_PERFORMANCE_COLUMNS.publishedPerformance]);
  const key = (await pool.query(`SELECT a.attname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary ORDER BY k.ord`,
  [schema, store.ANALYTICS_V2_PERFORMANCE_TABLES.publishedPerformance])).rows.map((row) => row.attname);
  assert.deepEqual(key, [...store.ANALYTICS_V2_PERFORMANCE_PRIMARY_KEYS.publishedPerformance]);
  assert.deepEqual([...store.ANALYTICS_V2_PERFORMANCE_PERIODS], [...telemetryContract.COMMUNITY_MODEL_PERFORMANCE_PERIODS]);
  assert.deepEqual([...store.ANALYTICS_V2_PERFORMANCE_SPEED_MODES],
    [...telemetryContract.COMMUNITY_MODEL_PERFORMANCE_SPEED_MODES]);
  assert.equal(store.ANALYTICS_V2_MAX_PERFORMANCE_PAYLOAD_BYTES, telemetryContract.MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES);
  assert.deepEqual(store.ANALYTICS_V2_PERFORMANCE_SLOTS.map(slotKey), ALL_SLOT_KEYS);
  assert.deepEqual([...store.ANALYTICS_V2_PERFORMANCE_REVISION_FIELDS], ["revision", "generatedAt"]);
});
