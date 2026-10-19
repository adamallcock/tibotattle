// PostgreSQL 17 spec for src/analytics-v2/performance-source.ts (SPD-P2a):
// the A-1 reader of current accountless performance reports, keyset-paged
// and bound to the caller's read-only snapshot, on the promoted primary chain
// (0079).
//
// Each schema is built by the production migration runner (prefix
// a2_perf_src_) and written through the live 0079 guards with the shared,
// synthetic, content-free fixtures of postgres-test/fixtures/performance-
// telemetry.mjs. Records exist for all three dictionaries. Assertions compare
// keys and records in memory; no identifier, digest or body is printed.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//   node --test --test-concurrency=1 postgres-test/analytics-v2-performance-source.spec.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { parseTelemetryPerformanceRecord } from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  PERFORMANCE_DICTIONARY_REGISTRY,
  PERFORMANCE_MIGRATION_NAME,
  activatePerformanceRuntime,
  insertPerformanceGrant,
  insertPerformanceReport,
  performanceFixtureMaxBucket,
  performanceFixtureSpeedForBucket,
  performanceTable,
  seedPerformanceAccountlessOwner,
  syntheticPerformanceHistogram,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

const THROUGH_DAY = "2026-10-09";
const NOW_MS = Date.parse("2026-10-10T06:00:00.000Z");
const FAMILY_TAG = /^\/\* analytics_v2:([a-z_.]+) \*\/ /u;
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|START|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE|SET\s+TRANSACTION|SET\s+SESSION)\b/iu;

let pool;
let vite;
let source;
let owners;
const schemas = [];

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ ...endpoint, max: 8, application_name: "a2-performance-source", connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the local server must be PostgreSQL 17");
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "error",
    plugins: analyticsV2Config.plugins, resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
  source = await vite.ssrLoadModule("/src/analytics-v2/performance-source.ts");
  owners = await vite.ssrLoadModule("/src/analytics-v2/owners.ts");
});

after(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
  await vite?.close();
});

/** A schema on the full promoted chain (0079 included) with an active performance runtime. */
async function promotedSchema(label) {
  const schema = `a2_perf_src_${label}_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.ok(applied.migrations.some((migration) => migration.name === PERFORMANCE_MIGRATION_NAME));
  await activatePerformanceRuntime(pool, { schema });
  return schema;
}

const BASIS = Object.freeze({
  [PERFORMANCE_DICTIONARY_2026_09_21]: "v12_parser_inference",
  [PERFORMANCE_DICTIONARY_2026_09_29]: "v12_parser_inference",
  [PERFORMANCE_DICTIONARY_2026_10_10]: "client_declared",
});

/** One accountless owner with a current grant for `dictionary`. */
async function ownerWithGrant(schema, dictionary) {
  const owner = await seedPerformanceAccountlessOwner(pool, { schema });
  const grant = await insertPerformanceGrant(pool, {
    schema, owner, fieldDictionaryVersion: dictionary, dictionaryBasis: BASIS[dictionary],
  });
  return { owner, grant, dictionary };
}

/**
 * A contract record whose histograms hold several buckets: speeds in
 * centi-tokens/second at 10 s per turn (so the pooled rate is their mean and
 * lies inside the extrema), ttft and turn durations in milliseconds.
 */
function richRecord({ day, dictionary, speeds, ttfts, durations, speedMethod = "receipt", ...labels }) {
  const scheme = PERFORMANCE_DICTIONARY_REGISTRY[dictionary].bucketSchemeVersion;
  const turns = ttfts.length;
  assert.equal(durations.length, turns);
  const speedSamples = speedMethod === "unavailable" ? [] : speeds;
  if (speedMethod !== "unavailable") assert.equal(speeds.length, turns);
  const speedTurns = speedSamples.length;
  return syntheticPerformanceRecord({
    day,
    fieldDictionaryVersion: dictionary,
    speedMethod,
    ...labels,
    turns,
    speedTurns,
    ttftTurns: turns,
    completionTurns: turns,
    timedResponses: speedTurns,
    speedTokens: speedSamples.reduce((sum, value) => sum + value / 10, 0),
    speedDurationMs: 10_000 * speedTurns,
    speedHistogram: syntheticPerformanceHistogram(scheme, "speed", speedSamples),
    ttftHistogram: syntheticPerformanceHistogram(scheme, "ttft", ttfts),
    completionHistogram: syntheticPerformanceHistogram(scheme, "turnDuration", durations),
  });
}

/** Every key the reader may hold for one stored report (the strings no output may contain). */
function privateKeys(entries) {
  return entries.flatMap(({ owner, reportId }) => [owner.participantId, owner.deviceId, reportId]);
}

function assertKeyFree(value, keys) {
  const text = JSON.stringify(value);
  for (const key of keys) assert.equal(text.includes(key), false, "an opaque key reached a summary or checkpoint");
}

/** A client whose every statement is recorded (text and values) before it runs. */
function recording(client) {
  const statements = [];
  return {
    statements,
    query(text, values) {
      statements.push({ text, values });
      return client.query(text, values);
    },
  };
}

async function onSnapshot(schema, operation) {
  return owners.withAnalyticsV2ReadSnapshot({ pool, schema, nowMs: NOW_MS }, ({ client }) => operation(client));
}

async function sourceCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.name, "AnalyticsV2SourceError", "a closed source error");
    return error.code;
  }
  return assert.fail("expected an AnalyticsV2SourceError");
}

// ---------------------------------------------------------------------------
// One corpus for the round-trip, paging, deferral and bound tests.
// ---------------------------------------------------------------------------

let corpus;

async function buildCorpus() {
  if (corpus) return corpus;
  const schema = await promotedSchema("corpus");
  const v21 = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_09_21);
  const v29 = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_09_29);
  const v29b = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_09_29);
  const v10 = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_10_10);
  const v1Overflow = performanceFixtureMaxBucket("performance-histogram-v1", "speed");
  const v2Overflow = performanceFixtureMaxBucket("performance-histogram-v2", "speed");
  assert.equal(v1Overflow, 60);
  assert.equal(v2Overflow, 95);
  const speedV1 = (bucket) => performanceFixtureSpeedForBucket("performance-histogram-v1", bucket);
  const speedV2 = (bucket) => performanceFixtureSpeedForBucket("performance-histogram-v2", bucket);
  const maxDuration = 9_000_000_000;

  const expected = [];
  const all = [];
  const insert = async (who, reportDay, records, extra = {}) => {
    const report = await insertPerformanceReport(pool, {
      schema, owner: who.owner, grant: who.grant, reportDay, records, ...extra,
    });
    all.push({ owner: who.owner, reportId: report.reportId });
    return report;
  };
  const current = (who, report, reportDay, records) => {
    expected.push({ who, reportId: report.reportId, reportDay, records });
  };

  // 2026-09-21.1: v1 scheme, overflow at 60, no Ultrafast labels.
  const v21Records = [
    richRecord({ day: "2026-10-01", dictionary: v21.dictionary, speeds: [speedV1(0), speedV1(12), speedV1(v1Overflow)],
      ttfts: [0, 499, maxDuration], durations: [1, 7_500, maxDuration] }),
    richRecord({ day: "2026-10-01", dictionary: v21.dictionary, speedMode: "other", apiServiceTier: "priority",
      reasoningEffort: "high", speeds: [], speedMethod: "unavailable", ttfts: [1_200, 1_300], durations: [20_000, 21_000] }),
    syntheticPerformanceRecord({ day: "2026-10-01", fieldDictionaryVersion: v21.dictionary, speedMode: "fast",
      apiServiceTier: "priority", speedBucket: v1Overflow, turns: 4 }),
  ];
  current(v21, await insert(v21, "2026-10-01", v21Records), "2026-10-01", v21Records);

  // 2026-09-29.1: v1 scheme with Ultrafast labels; superseded and zero-record reports.
  const supersededRecords = [syntheticPerformanceRecord({ day: "2026-10-02", fieldDictionaryVersion: v29.dictionary })];
  await insert(v29, "2026-10-02", supersededRecords, { sourceRevision: 1, sourceGeneration: "gen-a" });
  const v29Records = [
    richRecord({ day: "2026-10-02", dictionary: v29.dictionary, speedMode: "ultrafast", apiServiceTier: "ultrafast",
      speedModeSource: "turn_context_service_tier", speeds: [speedV1(59), speedV1(v1Overflow)],
      ttfts: [700, 800], durations: [9_000, 10_000] }),
    syntheticPerformanceRecord({ day: "2026-10-02", fieldDictionaryVersion: v29.dictionary, speedMethod: "tool_free",
      speedBucket: 5, reasoningEffort: "low" }),
    syntheticPerformanceRecord({ day: "2026-10-02", fieldDictionaryVersion: v29.dictionary, speedMode: "unknown",
      speedModeSource: "unobserved", apiServiceTier: "unknown", speedBucket: 1 }),
  ];
  current(v29, await insert(v29, "2026-10-02", v29Records, { sourceRevision: 2, sourceGeneration: "gen-b" }),
    "2026-10-02", v29Records);
  // A zero-record report is a day tombstone: current, never read.
  await insert(v29, "2026-10-03", []);
  // A day whose only non-empty report was superseded by a zero-record one.
  await insert(v29b, "2026-10-04", [syntheticPerformanceRecord({ day: "2026-10-04",
    fieldDictionaryVersion: v29b.dictionary })], { sourceRevision: 1, sourceGeneration: "gen-a" });
  await insert(v29b, "2026-10-04", [], { sourceRevision: 2, sourceGeneration: "gen-b" });

  // 2026-10-10.1: the v2 scheme, speed resolved above 120 tok/s up to bucket 95.
  const v10Records = [
    richRecord({ day: "2026-10-05", dictionary: v10.dictionary, speedMode: "fast", apiServiceTier: "priority",
      speeds: [speedV2(61), speedV2(80), speedV2(94), speedV2(v2Overflow)],
      ttfts: [0, 100, 600, 5_000], durations: [400, 3_000, 30_000, 300_000] }),
    syntheticPerformanceRecord({ day: "2026-10-05", fieldDictionaryVersion: v10.dictionary, speedMode: "ultrafast",
      apiServiceTier: "ultrafast", speedBucket: v2Overflow, reasoningEffort: "xhigh" }),
    syntheticPerformanceRecord({ day: "2026-10-05", fieldDictionaryVersion: v10.dictionary, speedMode: "mixed",
      speedModeSource: "mixed", apiServiceTier: "mixed", speedBucket: 40 }),
  ];
  current(v10, await insert(v10, "2026-10-05", v10Records), "2026-10-05", v10Records);

  // Paging material: several devices on one day, and one report per day after.
  for (const [index, who] of [v21, v29, v29b, v10].entries()) {
    const records = [syntheticPerformanceRecord({ day: "2026-10-06", fieldDictionaryVersion: who.dictionary,
      speedBucket: 10 + index, turns: index + 1 })];
    current(who, await insert(who, "2026-10-06", records), "2026-10-06", records);
  }
  for (const [index, day] of ["2026-10-07", "2026-10-08", THROUGH_DAY].entries()) {
    const records = Array.from({ length: index + 1 }, (_, cohort) => syntheticPerformanceRecord({
      day, fieldDictionaryVersion: v10.dictionary, speedBucket: 20 + cohort, reasoningEffort: ["low", "medium", "high"][cohort],
    }));
    current(v10, await insert(v10, day, records), day, records);
  }

  // Deferred future days: 2026-10-10 (two devices) and 2026-10-12 hold current
  // non-empty reports; 2026-10-11 holds only a zero-record one and 2026-10-13
  // only a superseded one, so neither counts.
  await insert(v29, "2026-10-10", [syntheticPerformanceRecord({ day: "2026-10-10", fieldDictionaryVersion: v29.dictionary })]);
  await insert(v10, "2026-10-10", [syntheticPerformanceRecord({ day: "2026-10-10", fieldDictionaryVersion: v10.dictionary })]);
  await insert(v10, "2026-10-11", []);
  await insert(v21, "2026-10-12", [syntheticPerformanceRecord({ day: "2026-10-12", fieldDictionaryVersion: v21.dictionary })]);
  await insert(v29b, "2026-10-13", [syntheticPerformanceRecord({ day: "2026-10-13",
    fieldDictionaryVersion: v29b.dictionary })], { sourceRevision: 1, sourceGeneration: "gen-a" });
  await insert(v29b, "2026-10-13", [], { sourceRevision: 2, sourceGeneration: "gen-b" });

  // The reader's keyset order is (report_day, id) under the database collation.
  const order = await pool.query(`SELECT id FROM ${performanceTable(schema, "telemetry_performance_reports")}
     WHERE state = 'current' AND record_count > 0 AND report_day <= $1::date ORDER BY report_day, id`, [THROUGH_DAY]);
  const rank = new Map(order.rows.map((row, index) => [row.id, index]));
  expected.sort((left, right) => rank.get(left.reportId) - rank.get(right.reportId));
  assert.equal(expected.length, rank.size, "every current non-empty report up to throughDay is expected");
  const cohorts = expected.reduce((sum, report) => sum + report.records.length, 0);
  corpus = { schema, expected, all, cohorts };
  return corpus;
}

function expectedEntries(expected) {
  return expected.flatMap((report) => report.records.map((record) => ({ report, record })));
}

test("rebuilt records round-trip exactly for all three dictionaries, with keys and dictionary", { skip }, async () => {
  const { schema, expected, all, cohorts } = await buildCorpus();
  const { records, summary } = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY }));
  const entries = expectedEntries(expected);
  assert.equal(records.length, entries.length);
  assert.equal(summary.cohorts, cohorts);
  assert.equal(summary.reports, expected.length);
  assert.equal(summary.complete, true);
  const dictionaries = new Set();
  const v2Buckets = new Set();
  let v1Overflow = false;
  for (const [index, yielded] of records.entries()) {
    const { report, record } = entries[index];
    assert.deepEqual(Object.keys(yielded),
      ["participantKey", "deviceKey", "reportKey", "reportDay", "fieldDictionaryVersion", "record"]);
    assert.equal(yielded.participantKey, report.who.owner.participantId);
    assert.equal(yielded.deviceKey, report.who.owner.deviceId);
    assert.equal(yielded.reportKey, report.reportId);
    assert.equal(yielded.reportDay, report.reportDay);
    assert.equal(yielded.fieldDictionaryVersion, report.who.dictionary);
    // Exact: same values and the same key order (canonical text equality).
    assert.equal(JSON.stringify(yielded.record), JSON.stringify(record));
    assert.deepEqual(yielded.record, record);
    // Each rebuilt record is a valid contract record under its own dictionary.
    assert.doesNotThrow(() => parseTelemetryPerformanceRecord(yielded.record, yielded.fieldDictionaryVersion));
    for (const field of ["speedHistogram", "ttftHistogram", "completionHistogram"]) {
      const histogram = yielded.record[field];
      assert.equal(histogram.sampleCount, Object.values(histogram.buckets).reduce((sum, count) => sum + count, 0));
    }
    dictionaries.add(yielded.fieldDictionaryVersion);
    if (yielded.record.bucketSchemeVersion === "performance-histogram-v2") {
      for (const key of Object.keys(yielded.record.speedHistogram.buckets)) v2Buckets.add(Number(key));
    } else if (Object.hasOwn(yielded.record.speedHistogram.buckets, "60")) {
      v1Overflow = true;
    }
  }
  assert.deepEqual([...dictionaries].sort(), [
    PERFORMANCE_DICTIONARY_2026_09_21, PERFORMANCE_DICTIONARY_2026_09_29, PERFORMANCE_DICTIONARY_2026_10_10,
  ]);
  assert.ok(v1Overflow, "a v1 overflow bucket (60) round-trips");
  for (const bucket of [61, 80, 94, 95]) assert.ok(v2Buckets.has(bucket), `v2 bucket ${bucket} round-trips`);
  // Opaque keys never reach the summary.
  assert.deepEqual(Object.keys(summary).sort(), ["cohorts", "complete", "deferredFutureDays", "pages", "reports"]);
  assertKeyFree(summary, privateKeys(all));
});

test("superseded and zero-record reports are excluded; later days are deferred and counted", { skip }, async () => {
  const { schema, expected, all } = await buildCorpus();
  const { records, summary } = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY }));
  const yieldedReports = new Set(records.map((record) => record.reportKey));
  const expectedReports = new Set(expected.map((report) => report.reportId));
  assert.deepEqual(yieldedReports, expectedReports);
  const states = await pool.query(`SELECT id, state, record_count, to_char(report_day, 'YYYY-MM-DD') AS day
     FROM ${performanceTable(schema, "telemetry_performance_reports")}`);
  for (const row of states.rows) {
    const yielded = yieldedReports.has(row.id);
    assert.equal(yielded, row.state === "current" && row.record_count > 0 && row.day <= THROUGH_DAY,
      `${row.state} report with ${row.record_count === 0 ? "no" : "some"} records yields iff current, non-empty and due`);
  }
  assert.ok(states.rows.some((row) => row.state === "superseded"));
  assert.ok(states.rows.some((row) => row.state === "current" && row.record_count === 0));
  assert.ok(records.every((record) => record.reportDay <= THROUGH_DAY));
  assert.equal(summary.deferredFutureDays, 2);
  assert.equal(all.length > expected.length, true);

  // Moving throughDay forward reads the deferred days and defers nothing.
  const later = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: "2026-10-31" }));
  assert.equal(later.summary.deferredFutureDays, 0);
  assert.equal(later.summary.reports, expected.length + 3);
  // An earlier throughDay defers more: 2026-10-06..09 plus the two future days.
  const earlier = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: "2026-10-05" }));
  assert.equal(earlier.summary.deferredFutureDays, 6);
  assert.ok(earlier.records.every((record) => record.reportDay <= "2026-10-05"));
});

test("keyset paging is deterministic across page boundaries and equals the single-page read", { skip }, async () => {
  const { schema, expected, all } = await buildCorpus();
  const single = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, pageSize: 1_024 }));
  assert.equal(single.summary.pages, 1);
  for (const pageSize of [1, 2, 3, 5]) {
    const pages = [];
    await onSnapshot(schema, async (client) => {
      let checkpoint = null;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await source.readAnalyticsV2PerformanceSource(client,
          { schema, throughDay: THROUGH_DAY, pageSize, checkpoint });
        pages.push(page);
        assert.deepEqual(Object.keys(page.checkpoint ?? { kind: "" }), ["kind"]);
        assertKeyFree(page.summary, privateKeys(all));
        assertKeyFree(page.checkpoint, privateKeys(all));
        if (page.checkpoint === null) return;
        checkpoint = page.checkpoint;
      }
      assert.fail("paging did not end");
    });
    // One look-ahead row per page tells the last page it is complete, so no
    // trailing empty page is read.
    assert.equal(pages.length, Math.ceil(expected.length / pageSize), `${pageSize} reports per page`);
    for (const page of pages.slice(0, -1)) assert.equal(new Set(page.records.map((r) => r.reportKey)).size, pageSize);
    const paged = pages.flatMap((page) => page.records);
    assert.equal(JSON.stringify(paged), JSON.stringify(single.records), "the same records in the same order");
    const last = pages.at(-1).summary;
    assert.deepEqual({ ...last, pages: 0 }, { ...single.summary, pages: 0 });
    assert.equal(last.pages, pages.length);
    // A report never straddles a page: its cohorts arrive together, in cohort order.
    const seen = new Set();
    for (const page of pages) {
      for (const key of new Set(page.records.map((record) => record.reportKey))) {
        assert.equal(seen.has(key), false);
        seen.add(key);
      }
    }
  }
  // Repeating a read on the same snapshot gives identical pages.
  const twice = await onSnapshot(schema, async (client) => [
    await source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, pageSize: 2 }),
    await source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, pageSize: 2 }),
  ]);
  assert.equal(JSON.stringify(twice[0]), JSON.stringify(twice[1]));
});

test("bounds hold with closed codes: options, checkpoints and the per-run cohort budget", { skip }, async () => {
  const { schema, cohorts } = await buildCorpus();
  const read = (options) => onSnapshot(schema, (client) =>
    source.readAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, ...options }));
  for (const pageSize of [0, -1, 1.5, 1_025, Number.NaN, "2"]) {
    assert.equal(await sourceCode(read({ pageSize })), "ANALYTICS_V2_SOURCE_INVALID");
  }
  for (const maxCohorts of [0, 10_000_001, 2.5, null]) {
    assert.equal(await sourceCode(read({ maxCohorts })), "ANALYTICS_V2_SOURCE_INVALID");
  }
  for (const throughDay of ["2026-02-30", "2026-10-9", "", null]) {
    assert.equal(await sourceCode(read({ throughDay })), "ANALYTICS_V2_SOURCE_INVALID");
  }
  assert.equal(await sourceCode(onSnapshot(schema, (client) => source.readAnalyticsV2PerformanceSource(client,
    { schema: "bad schema\"", throughDay: THROUGH_DAY }))), "ANALYTICS_V2_SOURCE_INVALID");
  assert.equal(source.MAX_ANALYTICS_V2_PERFORMANCE_PAGE_REPORTS, 1_024);
  assert.equal(source.MAX_ANALYTICS_V2_PERFORMANCE_COHORTS, 10_000_000);
  assert.equal(source.DEFAULT_ANALYTICS_V2_PERFORMANCE_COHORTS, 10_000_000);
  assert.deepEqual([...source.PERFORMANCE_SOURCE_STATEMENT_FAMILIES], ["performance.reports", "performance.cohorts"]);

  // Checkpoints: only one this module issued, for the same run parameters.
  await onSnapshot(schema, async (client) => {
    const first = await source.readAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, pageSize: 2 });
    assert.notEqual(first.checkpoint, null);
    const continueWith = (options) => source.readAnalyticsV2PerformanceSource(client,
      { schema, throughDay: THROUGH_DAY, pageSize: 2, checkpoint: first.checkpoint, ...options });
    assert.equal(await sourceCode(continueWith({ throughDay: "2026-10-08" })), "ANALYTICS_V2_SOURCE_INVALID");
    assert.equal(await sourceCode(continueWith({ pageSize: 3 })), "ANALYTICS_V2_SOURCE_INVALID");
    assert.equal(await sourceCode(continueWith({ maxCohorts: 999 })), "ANALYTICS_V2_SOURCE_INVALID");
    assert.equal(await sourceCode(continueWith({ checkpoint: { kind: "analytics-v2-performance-source-checkpoint" } })),
      "ANALYTICS_V2_SOURCE_INVALID");
    assert.equal(await sourceCode(continueWith({ checkpoint: "after" })), "ANALYTICS_V2_SOURCE_INVALID");
    const second = await continueWith({});
    assert.equal(second.summary.pages, 2);
  });

  // The run budget: exactly the corpus fits; one less is refused before any
  // cohort row of the overflowing page is selected.
  const exact = await onSnapshot(schema, (client) => source.collectAnalyticsV2PerformanceSource(client,
    { schema, throughDay: THROUGH_DAY, maxCohorts: cohorts, pageSize: 3 }));
  assert.equal(exact.summary.cohorts, cohorts);
  await onSnapshot(schema, async (client) => {
    const recorder = recording(client);
    assert.equal(await sourceCode(source.collectAnalyticsV2PerformanceSource(recorder,
      { schema, throughDay: THROUGH_DAY, maxCohorts: cohorts - 1, pageSize: 3 })), "ANALYTICS_V2_SOURCE_LIMIT");
    const families = recorder.statements.map(({ text }) => FAMILY_TAG.exec(text)?.[1]);
    assert.equal(families.at(-1), "performance.reports", "the refused page selected no cohort row");
  });
  await onSnapshot(schema, async (client) => {
    const recorder = recording(client);
    assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(recorder,
      { schema, throughDay: THROUGH_DAY, maxCohorts: 1, pageSize: 1 })), "ANALYTICS_V2_SOURCE_LIMIT");
    assert.equal(recorder.statements.some(({ text }) => text.includes("analytics_v2:performance.cohorts")), false);
  });
});

test("the reader runs only inside the caller's read-only repeatable-read snapshot and opens no transaction",
  { skip }, async () => {
    const { schema } = await buildCorpus();
    // Autocommit and a read-write or read-committed transaction are refused.
    const client = await pool.connect();
    try {
      assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(client,
        { schema, throughDay: THROUGH_DAY })), "ANALYTICS_V2_SOURCE_UNAVAILABLE");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(client,
        { schema, throughDay: THROUGH_DAY })), "ANALYTICS_V2_SOURCE_UNAVAILABLE");
      await client.query("ROLLBACK");
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(client,
        { schema, throughDay: THROUGH_DAY })), "ANALYTICS_V2_SOURCE_UNAVAILABLE");
      await client.query("ROLLBACK");
      // The caller's own exported-style snapshot transaction is accepted, and
      // the reader issues only tagged statements, never transaction control.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const recorder = recording(client);
      const { summary } = await source.collectAnalyticsV2PerformanceSource(recorder,
        { schema, throughDay: THROUGH_DAY, pageSize: 4 });
      assert.ok(summary.pages > 1);
      for (const { text } of recorder.statements) {
        assert.equal(TRANSACTION_CONTROL.test(text), false);
        const family = FAMILY_TAG.exec(text)?.[1];
        assert.ok(["snapshot.read_only", ...source.PERFORMANCE_SOURCE_STATEMENT_FAMILIES].includes(family),
          "every statement carries a closed family tag");
      }
      const status = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
      assert.equal(status.rows[0].read_only, "on", "still inside the caller's transaction");
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

test("pages are bound to the snapshot: a report committed mid-run is not read", { skip }, async () => {
  const schema = await promotedSchema("snapshot");
  const who = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_10_10);
  for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
    await insertPerformanceReport(pool, { schema, owner: who.owner, grant: who.grant, reportDay: day,
      records: [syntheticPerformanceRecord({ day, fieldDictionaryVersion: who.dictionary })] });
  }
  const other = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_09_29);
  const pages = await onSnapshot(schema, async (client) => {
    const first = await source.readAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY, pageSize: 1 });
    // Committed elsewhere after the snapshot began: a later key and a replacement.
    await insertPerformanceReport(pool, { schema, owner: other.owner, grant: other.grant, reportDay: "2026-10-04",
      records: [syntheticPerformanceRecord({ day: "2026-10-04", fieldDictionaryVersion: other.dictionary })] });
    await insertPerformanceReport(pool, { schema, owner: who.owner, grant: who.grant, reportDay: "2026-10-03",
      records: [], sourceRevision: 2, sourceGeneration: "gen-b" });
    const rest = [];
    let checkpoint = first.checkpoint;
    while (checkpoint !== null) {
      const page = await source.readAnalyticsV2PerformanceSource(client,
        { schema, throughDay: THROUGH_DAY, pageSize: 1, checkpoint });
      rest.push(page);
      checkpoint = page.checkpoint;
    }
    return [first, ...rest];
  });
  const days = pages.flatMap((page) => page.records.map((record) => record.reportDay));
  assert.deepEqual(days, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(pages.at(-1).summary.reports, 3);
  // A fresh snapshot sees the new state.
  const fresh = await onSnapshot(schema, (client) =>
    source.collectAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY }));
  assert.deepEqual(fresh.records.map((record) => record.reportDay), ["2026-10-01", "2026-10-02", "2026-10-04"]);
});

/**
 * Two devices with one current report each on one day, and a function that
 * replaces the first-read device's day (revision 2, 3, ...) until the
 * replacement's id sorts after `afterKey`: the state in which a keyset position
 * carried into a later snapshot would read that device-day twice.
 */
async function replacementCorpus(label) {
  const schema = await promotedSchema(label);
  const day = "2026-10-01";
  const devices = [];
  for (let index = 0; index < 2; index += 1) {
    const who = await ownerWithGrant(schema, PERFORMANCE_DICTIONARY_2026_10_10);
    const report = await insertPerformanceReport(pool, { schema, owner: who.owner, grant: who.grant, reportDay: day,
      records: [syntheticPerformanceRecord({ day, fieldDictionaryVersion: who.dictionary })],
      sourceRevision: 1, sourceGeneration: "gen-1" });
    devices.push({ who, reportId: report.reportId });
  }
  const replaceAfter = async (afterKey) => {
    const { who } = devices.find((device) => device.reportId === afterKey);
    for (let revision = 2; revision < 64; revision += 1) {
      const report = await insertPerformanceReport(pool, { schema, owner: who.owner, grant: who.grant, reportDay: day,
        records: [syntheticPerformanceRecord({ day, fieldDictionaryVersion: who.dictionary, turns: revision })],
        sourceRevision: revision, sourceGeneration: `gen-${revision}` });
      const order = await pool.query("SELECT $1::text > $2::text AS after", [report.reportId, afterKey]);
      if (order.rows[0].after) return who;
    }
    return assert.fail("no replacement sorted after the checkpoint key");
  };
  return { schema, replaceAfter };
}

test("a checkpoint is refused on any other snapshot, so a replaced device-day is never read twice",
  { skip }, async () => {
    const { schema, replaceAfter } = await replacementCorpus("cross");
    const options = { schema, throughDay: THROUGH_DAY, pageSize: 1 };
    const first = await onSnapshot(schema, (client) => source.readAnalyticsV2PerformanceSource(client, options));
    assert.equal(first.records.length, 1);
    assert.notEqual(first.checkpoint, null);
    // Committed after snapshot A: the first device's day is replaced by a report
    // whose id sorts after A's keyset position.
    const replaced = await replaceAfter(first.records[0].reportKey);
    // Snapshot B refuses A's checkpoint before reading any report or cohort.
    await onSnapshot(schema, async (client) => {
      const recorder = recording(client);
      assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(recorder,
        { ...options, checkpoint: first.checkpoint })), "ANALYTICS_V2_SOURCE_INVALID");
      assert.deepEqual(recorder.statements.map(({ text }) => FAMILY_TAG.exec(text)?.[1]), ["snapshot.read_only"]);
    });
    // A fresh run in B reads each device-day exactly once, the replacement included.
    const fresh = await onSnapshot(schema, (client) => source.collectAnalyticsV2PerformanceSource(client, options));
    assert.equal(fresh.records.length, 2);
    assert.equal(new Set(fresh.records.map((record) => record.deviceKey)).size, 2);
    const replacement = fresh.records.find((record) => record.deviceKey === replaced.owner.deviceId);
    assert.notEqual(replacement.reportKey, first.records[0].reportKey);
  });

test("a checkpoint continues on another session that imported the same exported snapshot", { skip }, async () => {
  const { schema, replaceAfter } = await replacementCorpus("export");
  const options = { schema, throughDay: THROUGH_DAY, pageSize: 1 };
  const exporter = await pool.connect();
  const importer = await pool.connect();
  try {
    // The refresh Job's createSnapshotReadPool shape: export on one session,
    // import on another, both read-only repeatable read.
    await exporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const exported = (await exporter.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    assert.match(exported, /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/u);
    const first = await source.readAnalyticsV2PerformanceSource(exporter, options);
    assert.notEqual(first.checkpoint, null);
    // A later commit is invisible to the exported snapshot.
    await replaceAfter(first.records[0].reportKey);
    await importer.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await importer.query(`SET TRANSACTION SNAPSHOT '${exported}'`);
    const second = await source.readAnalyticsV2PerformanceSource(importer, { ...options, checkpoint: first.checkpoint });
    assert.equal(second.checkpoint, null);
    const records = [...first.records, ...second.records];
    assert.equal(records.length, 2, "one record per device-day, from the exported state");
    assert.equal(new Set(records.map((record) => record.deviceKey)).size, 2);
    assert.equal(second.summary.reports, 2);
    await importer.query("COMMIT");
    await exporter.query("COMMIT");
  } finally {
    await importer.query("ROLLBACK").catch(() => {});
    await exporter.query("ROLLBACK").catch(() => {});
    importer.release();
    exporter.release();
  }
});

test("a page whose statements see different snapshots fails closed", { skip }, async () => {
  const { schema } = await buildCorpus();
  // Autocommit with read-only repeatable-read session defaults passes the
  // per-statement settings check, but every statement takes a new snapshot.
  const client = await pool.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const statements = [];
    const interleaved = {
      async query(text, values) {
        statements.push(text);
        const result = await client.query(text, values);
        // Another session commits right after the page's report statement.
        if (text.includes("analytics_v2:performance.reports") && text.includes("ORDER BY r.report_day")) {
          await pool.query("SELECT pg_current_xact_id()");
        }
        return result;
      },
    };
    assert.equal(await sourceCode(source.readAnalyticsV2PerformanceSource(interleaved,
      { schema, throughDay: THROUGH_DAY, pageSize: 2 })), "ANALYTICS_V2_SOURCE_UNAVAILABLE");
    const families = statements.map((text) => FAMILY_TAG.exec(text)?.[1]);
    assert.deepEqual(families.slice(-2), ["performance.cohorts", "snapshot.read_only"],
      "the cohorts were consistent; the closing snapshot read refused the page");
  } finally {
    // Discard the session so its altered defaults never reach another test.
    client.release(true);
  }
});

test("an empty corpus reads one complete empty page", { skip }, async () => {
  const schema = await promotedSchema("empty");
  const page = await onSnapshot(schema, (client) =>
    source.readAnalyticsV2PerformanceSource(client, { schema, throughDay: THROUGH_DAY }));
  assert.deepEqual(page.records, []);
  assert.equal(page.checkpoint, null);
  assert.deepEqual({ ...page.summary }, { reports: 0, cohorts: 0, pages: 1, deferredFutureDays: 0, complete: true });
});

test("the page and cohort statements are index reads on 0079's keys", { skip }, async () => {
  const { schema } = await buildCorpus();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const recorder = recording(client);
    await source.collectAnalyticsV2PerformanceSource(recorder, { schema, throughDay: THROUGH_DAY, pageSize: 2 });
    // Plan shape only (no row value is printed): forbid sequential scans so the
    // planner shows which index each statement can use.
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = async (family, predicate = () => true) => {
      const statement = recorder.statements.find(({ text }) => text.includes(`analytics_v2:${family}`) && predicate(text));
      assert.ok(statement, `a ${family} statement ran`);
      const explained = await client.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values);
      return JSON.stringify(explained.rows[0]["QUERY PLAN"]);
    };
    const firstPage = await plan("performance.reports", (text) => text.includes("ORDER BY r.report_day, r.id") && !text.includes("$3"));
    const nextPage = await plan("performance.reports", (text) => text.includes("$3::date"));
    for (const text of [firstPage, nextPage]) {
      assert.match(text, /telemetry_performance_reports_community_day/u);
      assert.doesNotMatch(text, /"Seq Scan"/u);
      assert.doesNotMatch(text, /"Node Type":"Sort"/u, "the keyset order comes from the index");
    }
    const cohortsPlan = await plan("performance.cohorts");
    assert.match(cohortsPlan, /telemetry_performance_cohorts_pkey|telemetry_performance_cohort_identity/u);
    assert.match(cohortsPlan, /telemetry_performance_buckets_pkey/u);
    assert.doesNotMatch(cohortsPlan, /"Seq Scan"/u);
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
