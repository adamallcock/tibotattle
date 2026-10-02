// PostgreSQL 17 spec for the analytics-v2 GET /api/v1/community/daily route
// module (GCP fast path, A-4).
//
// The route reproduces production handleCommunityDaily (d43c8f92, typed
// storage mode) over the analytics_v2_* tables. This spec seeds those tables
// from a small synthetic, content-free fixture (two 64-hex owner digests,
// reviewed model ids, synthetic counts) and checks the full response bytes at
// an injected clock against an expected JSON written out below, plus the
// production error envelope, the publication control, both Cache-Control
// branches, the cache-retention withholding gate, and the test-clock refusal.
//
// Schema: the full promoted primary chain through the production runner,
// which carries A-3's 0059_analytics_v2.sql and ends at the promoted tail
// 0063_enrollment_grants_erased_redeemer.sql (both asserted). 0059 keeps published
// heads append-only, so published rows are seeded once and never updated or
// deleted; scenarios vary only the preview and cache rows.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//   node --test postgres-test/analytics-v2-community-daily-route.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import { createOriginRouteModuleRegistry, defineOriginRouteModule } from "../cloud-run/origin-route-modules.mjs";
import { VENDORED_PACKAGE_ENTRIES, usesVendoredPackages } from "../vitest.analytics-v2.config.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A3_MIGRATION = "0059_analytics_v2.sql";
const PRIMARY_TAIL = "0063_enrollment_grants_erased_redeemer.sql";

const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");
const GENERATED_AT = "2026-10-01T12:00:00.000Z";
const FROM = "2026-09-25";
const TO = "2026-10-01";
const ORIGIN = "http://127.0.0.1:8080";
const PATH = "/api/v1/community/daily";
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

// ---------------------------------------------------------------------------
// Module loading: the route and the vendored kernels through Vite SSR, with
// the vendored d43c8f92 packages resolved for vendored importers exactly as
// vitest.analytics-v2.config.mjs and the vendor tsconfig paths do.
// ---------------------------------------------------------------------------

let vite;
let modules;
let pool;
let schema;
let quotedSchema;
let ddl;
let runId;

async function loadModules() {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    plugins: [{
      name: "analytics-v2-vendored-packages",
      enforce: "pre",
      resolveId(source, importer) {
        const entry = VENDORED_PACKAGE_ENTRIES[source];
        return entry && usesVendoredPackages(importer) ? entry : null;
      },
    }],
    // jsonc-parser publishes UMD as `main`; take its ESM build as esbuild does.
    resolve: { mainFields: ["module", "main"] },
    ssr: { noExternal: ["jsonc-parser"] },
  });
  return {
    route: await vite.ssrLoadModule("/src/analytics-v2/community-daily-route.ts"),
    v13: await vite.ssrLoadModule("/src/analytics-v2/public-allowance-breakdowns-v13.ts"),
    cacheWindows: await vite.ssrLoadModule("/src/analytics-v2/cache-windows-sql.ts"),
    canonical: await vite.ssrLoadModule("/src/canonical-json.ts"),
    routeRegistry: await vite.ssrLoadModule("/src/route-registry.ts"),
    kernels: await vite.ssrLoadModule("/vendor/analytics-d43c8f92/entry.ts"),
    cacheValues: await vite.ssrLoadModule("/vendor/analytics-d43c8f92/apps/worker/src/cache-retention-values.ts"),
    contract: await vite.ssrLoadModule("/vendor/analytics-d43c8f92/packages/telemetry-contract/index.js"),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function q(name) {
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `${quotedSchema}."${name}"`;
}

async function createSchema() {
  schema = `a4_cdr_${randomBytes(6).toString("hex")}`;
  quotedSchema = `"${schema}"`;
  await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.at(-1)?.name, PRIMARY_TAIL, "the promoted chain ends at 0063");
  assert.equal(applied.migrations.filter(({ name }) => name === A3_MIGRATION).length, 1,
    "the promoted chain carries A-3's 0059");
  ddl = `promoted primary chain through ${PRIMARY_TAIL}`;
}

/** A run id of the column's type, and a parent run row when the schema has a runs table. */
async function seedRun() {
  const columns = await pool.query(`SELECT table_name, column_name, data_type
      FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE 'analytics_v2_%'`, [schema]);
  const runIdType = columns.rows.find((row) => row.table_name === "analytics_v2_published_daily"
    && row.column_name === "run_id")?.data_type;
  assert.notEqual(runIdType, undefined, "analytics_v2_published_daily.run_id exists");
  const id = runIdType === "uuid" ? "00000000-0000-4000-8000-0000000000a4"
    : /int|numeric/u.test(runIdType) ? 1 : "synthetic-run-a4";
  const runColumns = new Set(columns.rows.filter((row) => row.table_name === "analytics_v2_runs")
    .map((row) => row.column_name));
  if (runColumns.size > 0) {
    const values = {
      run_id: id, started_at: GENERATED_AT, finished_at: GENERATED_AT, mode: "full", state: "complete",
      owners: 0, owner_days: 0, refusals: "[]",
      publication: JSON.stringify({ published: [], unchanged: [], blocked: [] }), timings: "{}",
    };
    await insert("analytics_v2_runs", Object.fromEntries(Object.entries(values)
      .filter(([column]) => runColumns.has(column))));
  }
  return id;
}

async function insert(table, row) {
  const names = Object.keys(row);
  await pool.query(`INSERT INTO ${q(table)} (${names.map((name) => `"${name}"`).join(", ")})
    VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`, Object.values(row));
}

async function setControls({ publication }) {
  await pool.query(`UPDATE ${q("collection_controls")} SET revision = revision + 1,
      control_state = $1, enrollment_enabled = true, upload_registration_enabled = true,
      processing_enabled = true, publication_enabled = $2, reason_code = 'maintenance',
      updated_at = clock_timestamp() WHERE singleton = 1`,
  [publication ? "operational" : "degraded", publication]);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function spend(usageEvents) {
  return modules.kernels.finalizeCommunityDailySpend({
    usageEvents, knownNanousd: 123_456_789n, fullyPricedUsageEvents: usageEvents - 2,
    partiallyPricedUsageEvents: 1, unpricedUsageEvents: 1,
  });
}

function dailyPayload({ day, revision, releasedAt, usageEvents, spendBlock }) {
  return {
    schemaVersion: "community-daily-aggregate-v1.0",
    aggregateId: `community-daily:${day}:r${revision}`,
    day,
    revision,
    releasedAt,
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: "community-daily-v1.0",
    suppression: "none_daily_grain_by_owner_decision",
    allowance: {
      basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
      fitCount: 2, participantCount: 2, centralUsd: 1_200, band80Usd: null,
    },
    totals: {
      contributingParticipants: 2, contributingDevices: 3, usageEvents, quotaObservations: 4,
      sessionDimensions: 2, inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75,
    },
    cellsTruncated: false,
    cells: [{ provider: "openai", modelId: "gpt-6-sol", usageEvents,
      inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75 }],
    capacityByPlanType: { pro: { capacityUsd: 1_200, participantCount: 1 } },
    apiEquivalentSpend: spendBlock,
  };
}

const CORRUPT_DIGEST_DAY = "2025-06-15";
const CORRUPT_STAMP_DAY = "2025-06-20";

/**
 * Published heads: a valid spend, a stale-price spend, a totals mismatch,
 * today, one row before the requested range, and two corrupt rows in June
 * 2025 that only the storage-failure case reads.
 */
function publishedRows() {
  const valid = spend(12);
  return [
    { day: CORRUPT_DIGEST_DAY, revision: 1, releasedAt: "2025-06-16T00:05:00.000Z", usageEvents: 12,
      spendBlock: valid, corrupt: "digest" },
    { day: CORRUPT_STAMP_DAY, revision: 1, releasedAt: "2025-06-21T00:05:00.000Z", usageEvents: 12,
      spendBlock: valid, corrupt: "releasedAt" },
    { day: "2026-09-20", revision: 1, releasedAt: "2026-09-21T00:05:00.000Z", usageEvents: 12, spendBlock: valid },
    { day: "2026-09-28", revision: 1, releasedAt: "2026-09-29T00:05:00.000Z", usageEvents: 12, spendBlock: valid },
    { day: "2026-09-29", revision: 3, releasedAt: "2026-09-30T03:10:00.123Z", usageEvents: 12,
      spendBlock: { ...valid, registrySha256: "0".repeat(64) } },
    { day: "2026-09-30", revision: 2, releasedAt: "2026-10-01T00:05:00.000Z", usageEvents: 13, spendBlock: valid },
    { day: "2026-10-01", revision: 1, releasedAt: "2026-10-01T11:00:00.000Z", usageEvents: 12, spendBlock: valid },
  ].map(({ corrupt, ...spec }) => ({ ...spec, corrupt, payload: dailyPayload(spec) }));
}

function modelDay(day, values) {
  const value = modules.contract.projectAdminModelHistoryDay({
    day,
    catalogVersion: modules.contract.ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values,
    fittedParticipantCount: 1,
    unstableParticipantCount: 0,
    staleParticipantCount: 0,
    refusedParticipantCount: 0,
    v1ParticipantCount: 1,
    unsupportedSourceParticipantCount: 0,
  });
  assert.notEqual(value, null, "synthetic model day is valid");
  return value;
}

/** Two synthetic fits: a plus fit from 2026-09-29 and a pro fit from 2026-09-30. */
function preview() {
  const { kernels } = modules;
  return kernels.buildAdminCommunityAllowancePreview([
    { participantId: "synthetic-participant-pro", planType: "pro",
      capacityNanousd: 1_200_000_000_000, lastObservedAt: "2026-09-30T12:00:00.000Z" },
    { participantId: "synthetic-participant-plus", planType: "plus",
      capacityNanousd: 60_000_000_000, lastObservedAt: "2026-09-29T12:00:00.000Z" },
  ], NOW_MS, undefined, {
    modelConfig: kernels.ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
    basis: kernels.ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: kernels.ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
    days: [
      modelDay("2026-09-29", [["gpt-6-sol", 900, 1]]),
      modelDay("2026-09-30", [["gpt-6-astra", 1_166, 1], ["gpt-6-sol", 1_000, 1]]),
    ],
  });
}

const ZERO = { reuse: 0, match: 0, ties: 0, exIns: 0, exCtx: 0 };
const SYNTHETIC_ADJACENCIES = [9, 8, 7, 6, 5, 4, 4, 2, 1];

/** owner, day, model, effort, band, counters. */
function cacheRows() {
  const rows = [
    [OWNER_A, "2026-10-01", "gpt-6-sol", "high", "under_one_minute",
      { adj: 10, reuse: 9, match: 8, ties: 1, exIns: 2, exCtx: 0, sess: 3 }],
    [OWNER_A, "2026-10-01", "gpt-6-sol", "low", "under_one_minute",
      { adj: 4, reuse: 4, match: 3, ties: 0, exIns: 0, exCtx: 1, sess: 2 }],
    [OWNER_B, "2026-10-01", "gpt-6-astra", "high", "under_one_minute",
      { adj: 6, reuse: 3, match: 2, ties: 0, exIns: 1, exCtx: 0, sess: 2 }],
    // Window edges: each window is calendar days ending today inclusive.
    [OWNER_A, "2026-09-30", "gpt-6-sol", "high", "one_to_two_minutes", // week, not day
      { adj: 3, reuse: 3, match: 3, ties: 0, exIns: 0, exCtx: 0, sess: 1 }],
    [OWNER_B, "2026-09-25", "gpt-6-astra", "high", "two_to_five_minutes", // first day of week
      { adj: 4, reuse: 1, match: 0, ties: 0, exIns: 0, exCtx: 0, sess: 2 }],
    [OWNER_B, "2026-09-28", "gpt-6-sol", "high", "five_to_ten_minutes",
      { adj: 5, reuse: 2, match: 1, ties: 1, exIns: 0, exCtx: 0, sess: 1 }],
    [OWNER_A, "2026-09-24", "gpt-6-astra", "high", "ten_to_thirty_minutes", // month, not week
      { adj: 7, reuse: 5, match: 5, ties: 2, exIns: 0, exCtx: 0, sess: 3 }],
    [OWNER_B, "2026-09-02", "gpt-6-sol", "high", "thirty_minutes_to_one_hour", // first day of month
      { adj: 1, reuse: 1, match: 0, ties: 0, exIns: 0, exCtx: 0, sess: 1 }],
    [OWNER_A, "2026-09-10", "gpt-6-astra", "high", "over_twenty_four_hours",
      { adj: 2, reuse: 0, match: 0, ties: 0, exIns: 3, exCtx: 1, sess: 1 }],
    [OWNER_A, "2026-09-01", "gpt-6-sol", "high", "six_to_twenty_four_hours", // all, not month
      { adj: 2, reuse: 1, match: 1, ties: 0, exIns: 0, exCtx: 0, sess: 2 }],
    [OWNER_B, "2026-06-01", "gpt-6-sol", "high", "one_to_two_hours",
      { adj: 8, reuse: 4, match: 4, ties: 0, exIns: 0, exCtx: 0, sess: 4 }],
    // A model with no adjacency adds exclusions to the pooled band only.
    [OWNER_A, "2026-06-01", "synthetic-model-zero", "high", "two_to_six_hours",
      { adj: 0, ...ZERO, exIns: 1, sess: 0 }],
  ];
  // Nine more models in the all-time window exercise the production limit of
  // 8; models 06 and 07 tie at the cut and the name decides.
  SYNTHETIC_ADJACENCIES.forEach((adj, index) => {
    rows.push([OWNER_A, "2026-06-01", `synthetic-model-0${index + 1}`, "high", "two_to_six_hours",
      { adj, ...ZERO, sess: 1 }]);
  });
  return rows;
}

function cacheBandRow([owner, day, model, effort, band, counters], run) {
  return {
    owner_digest: owner, day, model, effort, band,
    adjacencies: counters.adj, reused_more_than_half: counters.reuse,
    matched_or_exceeded: counters.match, unordered_ties: counters.ties,
    excluded_insufficient_evidence: counters.exIns, excluded_context_contracted: counters.exCtx,
    sessions: counters.sess, run_id: run,
  };
}

/**
 * The stored digest: SHA-256 of the canonical payload without the revision
 * fields analytics-refresh assigns (A-3 store.ts analyticsV2DailyContentSha256).
 */
function contentSha256(payload) {
  const { aggregateId: _aggregateId, revision: _revision, releasedAt: _releasedAt, ...content } = payload;
  return sha256(modules.canonical.canonicalJson(content));
}

/** Seed the append-only published heads once per schema. */
async function seedPublished() {
  for (const row of publishedRows()) {
    const payload = row.corrupt === "releasedAt"
      ? { ...row.payload, releasedAt: "2025-06-21T00:05:00.001Z" } : row.payload;
    const digest = contentSha256(row.payload);
    await insert("analytics_v2_published_daily", {
      day: row.day, revision: row.revision, released_at: row.releasedAt,
      payload: JSON.stringify(payload),
      payload_sha256: row.corrupt === "digest" ? `${digest.slice(0, 63)}${digest[63] === "0" ? "1" : "0"}` : digest,
      run_id: runId,
    });
  }
}

const NO_PREVIEW_ROW = Symbol("no preview row");

/** Replace the preview and cache rows (never the published heads) and open every control. */
async function reseed({ previewValue = preview(), cache = cacheRows() } = {}) {
  await pool.query(`DELETE FROM ${q("analytics_v2_preview")}`);
  await pool.query(`DELETE FROM ${q("analytics_v2_cache_bands")}`);
  if (previewValue !== NO_PREVIEW_ROW) {
    await insert("analytics_v2_preview", {
      id: 1, preview: previewValue === null ? null : JSON.stringify(previewValue),
      computed_at: GENERATED_AT, run_id: runId,
    });
  }
  for (const row of cache) await insert("analytics_v2_cache_bands", cacheBandRow(row, runId));
  await setControls({ publication: true });
}

// ---------------------------------------------------------------------------
// Expected response (hand-derived from the fixture above)
// ---------------------------------------------------------------------------

const BANDS = [
  ["under_one_minute", 0, 60_000],
  ["one_to_two_minutes", 60_000, 120_000],
  ["two_to_five_minutes", 120_000, 300_000],
  ["five_to_ten_minutes", 300_000, 600_000],
  ["ten_to_thirty_minutes", 600_000, 1_800_000],
  ["thirty_minutes_to_one_hour", 1_800_000, 3_600_000],
  ["one_to_two_hours", 3_600_000, 7_200_000],
  ["two_to_six_hours", 7_200_000, 21_600_000],
  ["six_to_twenty_four_hours", 21_600_000, 86_400_000],
  ["over_twenty_four_hours", 86_400_000, 604_800_000],
];

/** Every band in method order; listed bands carry the hand-summed counters. */
function curve(evidence = {}) {
  return BANDS.map(([band, startMs, endMs]) => {
    const e = evidence[band];
    const adjacencies = e?.adj ?? 0;
    return {
      band, startMs, endMs,
      adjacencies,
      sessions: e?.sess ?? 0,
      contributors: e?.contributors ?? 0,
      reusedMoreThanHalf: e?.reuse ?? 0,
      matchedOrExceeded: e?.match ?? 0,
      reusedMoreThanHalfRate: adjacencies === 0 ? null : e.reuse / adjacencies,
      matchedOrExceededRate: adjacencies === 0 ? null : e.match / adjacencies,
      topContributorShare: adjacencies === 0 ? null : e.top / adjacencies,
      excludedInsufficientEvidence: e?.exIns ?? 0,
      excludedContextContracted: e?.exCtx ?? 0,
      unorderedTies: e?.ties ?? 0,
    };
  });
}

// Pooled band sums (owner A + owner B where both contribute).
const U1M = { adj: 20, reuse: 16, match: 13, ties: 1, exIns: 3, exCtx: 1, sess: 7, contributors: 2, top: 14 };
const U1M_SOL = { adj: 14, reuse: 13, match: 11, ties: 1, exIns: 2, exCtx: 1, sess: 5, contributors: 1, top: 14 };
const U1M_ASTRA = { adj: 6, reuse: 3, match: 2, ties: 0, exIns: 1, exCtx: 0, sess: 2, contributors: 1, top: 6 };
const M1_2 = { adj: 3, reuse: 3, match: 3, ties: 0, exIns: 0, exCtx: 0, sess: 1, contributors: 1, top: 3 };
const M2_5 = { adj: 4, reuse: 1, match: 0, ties: 0, exIns: 0, exCtx: 0, sess: 2, contributors: 1, top: 4 };
const M5_10 = { adj: 5, reuse: 2, match: 1, ties: 1, exIns: 0, exCtx: 0, sess: 1, contributors: 1, top: 5 };
const M10_30 = { adj: 7, reuse: 5, match: 5, ties: 2, exIns: 0, exCtx: 0, sess: 3, contributors: 1, top: 7 };
const M30_60 = { adj: 1, reuse: 1, match: 0, ties: 0, exIns: 0, exCtx: 0, sess: 1, contributors: 1, top: 1 };
const H1_2 = { adj: 8, reuse: 4, match: 4, ties: 0, exIns: 0, exCtx: 0, sess: 4, contributors: 1, top: 8 };
// 9+8+7+6+5+4+4+2+1 = 46 adjacencies over nine sessions, plus the zero model's exclusion.
const H2_6 = { adj: 46, reuse: 0, match: 0, ties: 0, exIns: 1, exCtx: 0, sess: 9, contributors: 1, top: 46 };
const H6_24 = { adj: 2, reuse: 1, match: 1, ties: 0, exIns: 0, exCtx: 0, sess: 2, contributors: 1, top: 2 };
const OVER_24H = { adj: 2, reuse: 0, match: 0, ties: 0, exIns: 3, exCtx: 1, sess: 1, contributors: 1, top: 2 };
const synthetic = (number) => {
  const adj = SYNTHETIC_ADJACENCIES[number - 1];
  return { model: `synthetic-model-0${number}`,
    bands: curve({ two_to_six_hours: { adj, ...ZERO, sess: 1, contributors: 1, top: adj } }) };
};

function expectedCacheRetention() {
  const solWeek = { under_one_minute: U1M_SOL, one_to_two_minutes: M1_2, five_to_ten_minutes: M5_10 };
  const astraWeek = { under_one_minute: U1M_ASTRA, two_to_five_minutes: M2_5 };
  const solMonth = { ...solWeek, thirty_minutes_to_one_hour: M30_60 };
  const astraMonth = { ...astraWeek, ten_to_thirty_minutes: M10_30, over_twenty_four_hours: OVER_24H };
  const week = { under_one_minute: U1M, one_to_two_minutes: M1_2, two_to_five_minutes: M2_5,
    five_to_ten_minutes: M5_10 };
  const month = { ...week, ten_to_thirty_minutes: M10_30, thirty_minutes_to_one_hour: M30_60,
    over_twenty_four_hours: OVER_24H };
  return {
    schemaVersion: "community-cache-retention-v1.0",
    metric: "cache_retention_by_pause",
    methodVersion: "cache-retention-v2",
    measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end",
    windows: [
      { window: "day", days: 1, bands: curve({ under_one_minute: U1M }),
        byModel: [
          { model: "gpt-6-sol", bands: curve({ under_one_minute: U1M_SOL }) },
          { model: "gpt-6-astra", bands: curve({ under_one_minute: U1M_ASTRA }) },
        ],
        modelsTruncated: false },
      // sol 22, astra 10.
      { window: "week", days: 7, bands: curve(week),
        byModel: [
          { model: "gpt-6-sol", bands: curve(solWeek) },
          { model: "gpt-6-astra", bands: curve(astraWeek) },
        ],
        modelsTruncated: false },
      // sol 23, astra 19.
      { window: "month", days: 30, bands: curve(month),
        byModel: [
          { model: "gpt-6-sol", bands: curve(solMonth) },
          { model: "gpt-6-astra", bands: curve(astraMonth) },
        ],
        modelsTruncated: false },
      { window: "all", days: null,
        bands: curve({ ...month, one_to_two_hours: H1_2, two_to_six_hours: H2_6,
          six_to_twenty_four_hours: H6_24 }),
        // Adjacency order, then name: sol 33, astra 19, models 01-05, then
        // 06 and 07 tie at 4 and 06 wins by name; 07-09 and the zero model drop.
        byModel: [
          { model: "gpt-6-sol",
            bands: curve({ ...solMonth, one_to_two_hours: H1_2, six_to_twenty_four_hours: H6_24 }) },
          { model: "gpt-6-astra", bands: curve(astraMonth) },
          synthetic(1), synthetic(2), synthetic(3), synthetic(4), synthetic(5), synthetic(6),
        ],
        modelsTruncated: true },
    ],
  };
}

const EMPTY_SUMMARY = { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null };

/**
 * The declared model-metadata block (KM-7, owner decision round 7): the
 * committed catalog baseline (manifest_version 1) file's public roster, built
 * independently of the compiled baseline the route reads.
 */
function expectedModelConfig() {
  return modules.v13.buildPublicModelMetadata(
    JSON.parse(readFileSync(resolve(WORKER_ROOT, "catalog/manifest-0001.json"), "utf8")));
}

/** d43c8f92's v1.1 projection relabelled v1.3, with the block appended last. */
function expectedAllowanceBreakdowns() {
  return {
    schemaVersion: "community-allowance-breakdowns-v1.3",
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_plus_x20",
    modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition",
    modelGate: "shared_composition_kernel_identification",
    generatedAt: GENERATED_AT,
    // Closed published days only: 2026-10-01 is today and stays out.
    days: [
      { day: "2026-09-28", combined: EMPTY_SUMMARY,
        byPlanType: { pro: EMPTY_SUMMARY, prolite: EMPTY_SUMMARY, plus: EMPTY_SUMMARY }, models: [] },
      { day: "2026-09-29",
        combined: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null },
        byPlanType: { pro: EMPTY_SUMMARY, prolite: EMPTY_SUMMARY,
          plus: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null } },
        models: [["gpt-6-sol", 900, 1]] },
      { day: "2026-09-30",
        combined: { centralUsd: 1_200, participantCount: 2, fitCount: 2, band80Usd: null },
        byPlanType: {
          pro: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null },
          prolite: EMPTY_SUMMARY,
          plus: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null },
        },
        models: [["gpt-6-astra", 1_166, 1], ["gpt-6-sol", 1_000, 1]] },
    ],
    modelConfig: expectedModelConfig(),
  };
}

/** Production's served payload: canonical key order, private and stale fields removed. */
function expectedDay(row, { keepSpend }) {
  const payload = { ...row.payload };
  delete payload.capacityByPlanType;
  delete payload.allowance;
  if (!keepSpend) delete payload.apiEquivalentSpend;
  return { day: row.day, revision: row.revision, releasedAt: row.releasedAt, payload: sortKeys(payload) };
}

function expectedResponse() {
  const rows = new Map(publishedRows().map((row) => [row.day, row]));
  return {
    schemaVersion: "community-daily-read-v1.0",
    from: FROM,
    to: TO,
    allowanceState: "ready",
    allowanceReadState: "confirmed",
    allowanceBreakdowns: expectedAllowanceBreakdowns(),
    cacheRetention: expectedCacheRetention(),
    days: [
      expectedDay(rows.get("2026-09-28"), { keepSpend: true }),
      // Stale price registry: not current-price evidence.
      expectedDay(rows.get("2026-09-29"), { keepSpend: false }),
      // Spend counts 12 events while totals say 13.
      expectedDay(rows.get("2026-09-30"), { keepSpend: false }),
      expectedDay(rows.get("2026-10-01"), { keepSpend: true }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function createRoute(overrides = {}) {
  return modules.route.createAnalyticsV2CommunityDailyRoute({
    pool, schema, clock: () => NOW_MS, originMode: "fastpath-test", ...overrides,
  });
}

async function get(query, { route = createRoute(), method = "GET" } = {}) {
  const response = await route.handler(new Request(`${ORIGIN}${PATH}${query}`, { method }), {});
  return { response, text: await response.text() };
}

function assertErrorEnvelope({ response, text }, status, code) {
  assert.equal(response.status, status);
  assert.match(text, new RegExp(`^\\{"error":\\{"code":"${code}","requestId":"[0-9a-f-]{36}"\\}\\}$`, "u"));
  assert.match(JSON.parse(text).error.requestId, UUID);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

before(async () => {
  if (skip) return;
  modules = await loadModules();
  pool = new pg.Pool({
    ...endpoint,
    ssl: false,
    max: 4,
    application_name: "analytics-v2-community-daily-route-test",
    connectionTimeoutMillis: 5_000,
  });
  const version = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
  assert.match(version.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  await createSchema();
  runId = await seedRun();
  await seedPublished();
});

after(async () => {
  if (pool) {
    if (quotedSchema) await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.end();
  }
  if (vite) await vite.close();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test("route module: the IN-1 seam shape, accepted by the origin route-module registry", { skip }, (t) => {
  t.diagnostic(`analytics_v2 DDL: ${ddl}`);
  const route = createRoute();
  assert.deepEqual(Object.keys(route).sort(), ["handler", "method", "overridesBuiltIn", "pathname"]);
  assert.equal(route.method, "GET");
  assert.equal(route.pathname, PATH);
  assert.equal(route.overridesBuiltIn, true);
  assert.ok(Object.isFrozen(route));
  const registry = createOriginRouteModuleRegistry({
    modules: [defineOriginRouteModule(route)],
    routePolicy: modules.routeRegistry.WORKER_ROUTE_POLICY,
  });
  assert.equal(registry.resolve("GET", PATH)?.handler, route.handler);
  assert.equal(registry.resolve("POST", PATH), null);
  // The withholding gate uses the vendored production band vocabulary.
  assert.deepEqual([...modules.cacheWindows.ANALYTICS_V2_CACHE_RETENTION_BAND_IDS],
    [...modules.cacheValues.CACHE_RETENTION_BAND_IDS]);
  assert.deepEqual(BANDS.map(([band]) => band), [...modules.cacheValues.CACHE_RETENTION_BAND_IDS]);
});

test("(a) the response equals the fixture-expected JSON byte for byte at the injected clock", { skip }, async () => {
  await reseed();
  const first = await get(`?from=${FROM}&to=${TO}`);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(first.response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(first.text), expectedResponse());
  assert.equal(first.text, JSON.stringify(expectedResponse()));
  // Deterministic: a second request through a second route instance is identical.
  const second = await get(`?from=${FROM}&to=${TO}`);
  assert.equal(second.text, first.text);
  // No owner digest, participant id or private diagnostic crosses the boundary.
  for (const secret of [OWNER_A, OWNER_B, "synthetic-participant", "capacityByPlanType",
    "fittedParticipantCount", "uploadingParticipantCount", "synthetic-model-07", "synthetic-model-zero"]) {
    assert.equal(first.text.includes(secret), false, secret);
  }
});

test("breakdowns v1.3: only the declared relabel and catalog-baseline block differ from the v1.1 projection", { skip }, async () => {
  await reseed();
  const { text } = await get(`?from=${FROM}&to=${TO}`);
  const served = JSON.parse(text).allowanceBreakdowns;
  // The route's block (compiled baseline) is the committed manifest_version 1 file's.
  assert.deepEqual(modules.route.analyticsV2PublicModelMetadata(), expectedModelConfig());
  assert.equal(served.modelConfig.length, 6);
  const { base, metadata } = modules.v13.reducePublicAllowanceBreakdownsV13(served);
  assert.deepEqual(metadata, expectedModelConfig());
  // The parity compare's declared block is the same bytes.
  assert.equal(JSON.stringify(served.modelConfig), JSON.stringify(JSON.parse(readFileSync(resolve(WORKER_ROOT,
    "analytics-v2-test/fixtures/breakdowns-v13-declared-model-metadata.json"), "utf8"))));
  const { modelConfig: _modelConfig, ...v11 } = expectedAllowanceBreakdowns();
  assert.equal(JSON.stringify(base), JSON.stringify({ ...v11, schemaVersion: "community-allowance-breakdowns-v1.1" }));
  // Only the public roster is ever named: this fixture's served models are
  // both on it, and neither a separate-track model nor one the owner's selected
  // comparison keeps off the public page (GPT-5.5) is named.
  const servedIds = new Set(served.days.flatMap((day) => day.models.map(([id]) => id)));
  const named = new Set(served.modelConfig.map((entry) => entry.id));
  assert.ok([...servedIds].every((id) => named.has(id)));
  assert.equal(named.has("gpt-5.3-codex-spark"), false);
  assert.equal(named.has("gpt-5.5"), false);
});

test("(b) bad parameters are 400 BODY_INVALID in the production error envelope", { skip }, async () => {
  await reseed();
  for (const query of [
    "", `?from=${FROM}`, `?to=${TO}`, `?from=${FROM}&to=${TO}&day=${TO}`, `?from=&to=${TO}`,
    "?from=2026-9-25&to=2026-10-01", "?from=2026-02-31&to=2026-03-01", "?from=2026-10-01&to=2026-09-30",
    "?from=2026-09-25T00:00:00Z&to=2026-10-01",
    // 2025-09-30 .. 2026-10-01 is 367 calendar days.
    "?from=2025-09-30&to=2026-10-01",
  ]) {
    assertErrorEnvelope(await get(query), 400, "BODY_INVALID");
  }
  // 366 days is the inclusive maximum.
  const maximum = await get("?from=2025-10-01&to=2026-10-01");
  assert.equal(maximum.response.status, 200);
  assert.deepEqual(JSON.parse(maximum.text).days.map((day) => day.day),
    ["2026-09-20", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
  // A repeated, valid `from` reads the first value, as URLSearchParams.get does in production.
  assert.equal((await get(`?from=${FROM}&to=${TO}&from=2026-01-01`)).response.status, 200);
  const notAllowed = await get(`?from=${FROM}&to=${TO}`, { method: "POST" });
  assertErrorEnvelope(notAllowed, 405, "METHOD_NOT_ALLOWED");
  assert.equal(notAllowed.response.headers.get("allow"), "GET");
});

test("(c) a disabled publication control is 503 PUBLICATION_DISABLED, before parameter checks", { skip }, async () => {
  await reseed();
  await setControls({ publication: false });
  try {
    assertErrorEnvelope(await get(`?from=${FROM}&to=${TO}`), 503, "PUBLICATION_DISABLED");
    assertErrorEnvelope(await get("?from=bad"), 503, "PUBLICATION_DISABLED");
  } finally {
    await setControls({ publication: true });
  }
  assert.equal((await get(`?from=${FROM}&to=${TO}`)).response.status, 200);
});

test("(d) Cache-Control is public for a confirmed allowance read and no-store when it is unavailable", { skip }, async () => {
  await reseed();
  const confirmed = await get(`?from=${FROM}&to=${TO}`);
  assert.equal(confirmed.response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(JSON.parse(confirmed.text).allowanceReadState, "confirmed");

  // Confirmed read, but no closed published day in range: updating, still public.
  const todayOnly = await get(`?from=${TO}&to=${TO}`);
  assert.equal(todayOnly.response.headers.get("cache-control"), "public, max-age=300");
  const todayBody = JSON.parse(todayOnly.text);
  assert.equal(todayBody.allowanceState, "updating");
  assert.equal(todayBody.allowanceReadState, "confirmed");
  assert.equal("allowanceBreakdowns" in todayBody, false);

  const unavailable = (body) => {
    assert.equal(body.allowanceState, "updating");
    assert.equal(body.allowanceReadState, "temporarily_unavailable");
    assert.equal("allowanceBreakdowns" in body, false);
    assert.deepEqual(body.days.map((day) => day.day), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    assert.deepEqual(body.cacheRetention, expectedCacheRetention());
  };
  // No preview row, a NULL preview, and a preview generated after the clock (beyond skew).
  for (const previewValue of [NO_PREVIEW_ROW, null,
    { ...preview(), generatedAt: "2026-10-01T12:05:00.001Z" }]) {
    await reseed({ previewValue });
    const { response, text } = await get(`?from=${FROM}&to=${TO}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    unavailable(JSON.parse(text));
  }
  // A failed preview read degrades the same way and keeps the verified days.
  await reseed();
  await pool.query(`ALTER TABLE ${q("analytics_v2_preview")} RENAME TO analytics_v2_preview_hidden`);
  try {
    const { response, text } = await get(`?from=${FROM}&to=${TO}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    unavailable(JSON.parse(text));
  } finally {
    await pool.query(`ALTER TABLE ${q("analytics_v2_preview_hidden")} RENAME TO analytics_v2_preview`);
  }
});

test("(e) the cache series is withheld when a band is missing, and omitted without evidence", { skip }, async () => {
  const { publishableAnalyticsV2CacheRetentionSeries: gate } = modules.route;
  const full = expectedCacheRetention();
  assert.equal(gate(full), full);
  assert.equal(gate(null), null);
  const withoutWindowBand = structuredClone(full);
  withoutWindowBand.windows[2].bands.pop();
  assert.equal(gate(withoutWindowBand), null);
  const withoutModelBand = structuredClone(full);
  withoutModelBand.windows[3].byModel[7].bands.splice(4, 1);
  assert.equal(gate(withoutModelBand), null);
  const withoutWindow = structuredClone(full);
  withoutWindow.windows.pop();
  assert.equal(gate(withoutWindow), null);
  assert.equal(gate({ ...full, methodVersion: "cache-retention-v1" }), null);
  assert.equal(gate({ ...full, schemaVersion: "community-cache-retention-v0.9" }), null);

  // Sparse evidence is not a missing band: production zero-fills every band
  // with null rates, so a single stored band still serves all four windows.
  await reseed({ cache: [[OWNER_B, "2026-09-28", "gpt-6-sol", "high", "five_to_ten_minutes",
    { adj: 5, reuse: 2, match: 1, ties: 1, exIns: 0, exCtx: 0, sess: 1 }]] });
  const sparse = JSON.parse((await get(`?from=${FROM}&to=${TO}`)).text).cacheRetention;
  assert.deepEqual(sparse.windows.map((window) => [window.window, window.bands.length,
    window.bands.reduce((total, band) => total + band.adjacencies, 0)]),
  [["day", 10, 0], ["week", 10, 5], ["month", 10, 5], ["all", 10, 5]]);
  assert.deepEqual(sparse.windows[0].byModel, []);

  // No evidence in any window: the series is absent, not ten zeroes.
  await reseed({ cache: [] });
  const empty = await get(`?from=${FROM}&to=${TO}`);
  assert.equal(empty.response.status, 200);
  assert.equal("cacheRetention" in JSON.parse(empty.text), false);

  // An aggregate the vendored validation refuses (reuse above adjacencies)
  // cannot be stored: the analytics_v2 schema refuses it as a check violation.
  const invalidRow = [OWNER_A, "2026-10-01", "gpt-6-sol", "high", "ten_to_thirty_minutes",
    { adj: 1, reuse: 2, match: 0, ties: 0, exIns: 0, exCtx: 0, sess: 1 }];
  await assert.rejects(reseed({ cache: [invalidRow] }), (error) => error?.code === "23514");
  // Were one ever read, composition throws, and the route serves no series
  // rather than one partly right (production's read fails the same way).
  assert.throws(() => modules.cacheWindows.composeAnalyticsV2CacheRetentionSeries(
    [["day", 1], ["week", 7], ["month", 30], ["all", null]].map(([window, days]) => ({
      window, days, fromDay: null, modelRows: [],
      pooled: [{ ownerDigest: OWNER_A, band: "ten_to_thirty_minutes", adjacencies: 1, reusedMoreThanHalf: 2,
        matchedOrExceeded: 0, unorderedTies: 0, excludedInsufficientEvidence: 0,
        excludedContextContracted: 0, sessions: 1 }],
    })),
  ), /CACHE_RETENTION_ROW_INVALID/u);

  // A failed cache read omits the series and keeps the days and allowance.
  await reseed();
  await pool.query(`ALTER TABLE ${q("analytics_v2_cache_bands")} RENAME TO analytics_v2_cache_bands_hidden`);
  try {
    const { response, text } = await get(`?from=${FROM}&to=${TO}`);
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal("cacheRetention" in body, false);
    assert.deepEqual(body.allowanceBreakdowns, expectedAllowanceBreakdowns());
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  } finally {
    await pool.query(`ALTER TABLE ${q("analytics_v2_cache_bands_hidden")} RENAME TO analytics_v2_cache_bands`);
  }
});

test("storage failures are 503 BACKEND_STORAGE_UNAVAILABLE", { skip }, async () => {
  await reseed();
  // A head whose content no longer matches its stored digest.
  assertErrorEnvelope(await get("?from=2025-06-01&to=2025-06-15"), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // A head whose payload releasedAt disagrees with its row.
  assertErrorEnvelope(await get("?from=2025-06-16&to=2025-06-20"), 503, "BACKEND_STORAGE_UNAVAILABLE");
  // A range without either corrupt head is served; the stored row is never read.
  const clean = await get("?from=2025-06-21&to=2025-06-30");
  assert.equal(clean.response.status, 200);
  assert.deepEqual(JSON.parse(clean.text).days, []);

  // The required daily read failing.
  await pool.query(`ALTER TABLE ${q("analytics_v2_published_daily")} RENAME TO analytics_v2_published_daily_hidden`);
  try {
    assertErrorEnvelope(await get(`?from=${FROM}&to=${TO}`), 503, "BACKEND_STORAGE_UNAVAILABLE");
  } finally {
    await pool.query(`ALTER TABLE ${q("analytics_v2_published_daily_hidden")}
      RENAME TO analytics_v2_published_daily`);
  }

  // Unreadable collection controls are the AA-0 reader's 503.
  const brokenPool = { connect: async () => { throw new Error("synthetic connect failure"); } };
  const broken = createRoute({ pool: brokenPool });
  assertErrorEnvelope(await get(`?from=${FROM}&to=${TO}`, { route: broken }), 503,
    "COLLECTION_CONTROL_UNAVAILABLE");
});

test("(f) an injected clock is refused outside the loopback fast-path test mode", { skip }, () => {
  const { createAnalyticsV2CommunityDailyRoute: create } = modules.route;
  const clock = () => NOW_MS;
  for (const originMode of [undefined, null, "", "cloud-run-iam", "health-only",
    "health-and-v12-day-manifest", "production", "FASTPATH-TEST"]) {
    assert.throws(() => create({ pool, schema, clock, ...(originMode === undefined ? {} : { originMode }) }),
      /^Error: ANALYTICS_V2_COMMUNITY_DAILY_TEST_CLOCK_REFUSED$/u, String(originMode));
  }
  assert.equal(typeof create({ pool, schema, clock, originMode: "fastpath-test" }).handler, "function");
  // Without a clock the route uses Date.now in every mode, production included.
  for (const originMode of [undefined, null, "cloud-run-iam", "fastpath-test"]) {
    assert.equal(create({ pool, schema, originMode }).method, "GET");
  }
  for (const options of [
    { pool, schema: "Not-A-Schema" },
    { pool, schema: "pg_catalog\"; DROP" },
    { pool: {}, schema },
    { pool, schema, now: clock },
    { pool, schema, clock: NOW_MS, originMode: "fastpath-test" },
  ]) {
    assert.throws(() => create(options), /^Error: ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID$/u);
  }
});

test("the injected clock moves today, the closed allowance days and the cache windows", { skip }, async () => {
  await reseed();
  // One day later: 2026-10-01 becomes a closed day and the day window is 2026-10-02 (no rows).
  const later = createRoute({ clock: () => NOW_MS + 86_400_000 });
  const body = JSON.parse((await get(`?from=${FROM}&to=${TO}`, { route: later })).text);
  assert.deepEqual(body.cacheRetention.windows[0].bands, curve());
  assert.deepEqual(body.cacheRetention.windows[0].byModel, []);
  // The week now starts 2026-09-26, so the 2026-09-25 row leaves it.
  assert.deepEqual(body.cacheRetention.windows[1].bands,
    curve({ under_one_minute: U1M, one_to_two_minutes: M1_2, five_to_ten_minutes: M5_10 }));
  assert.deepEqual(body.allowanceBreakdowns.days.map((day) => day.day), ["2026-09-28", "2026-09-29", "2026-09-30"]);
  // A clock that is not a safe integer is an internal error, never a guessed date.
  const invalid = createRoute({ clock: () => Number.NaN });
  assertErrorEnvelope(await get(`?from=${FROM}&to=${TO}`, { route: invalid }), 500, "INTERNAL_ERROR");
});

test("the all window has no lower bound: a band 400 days old counts there and nowhere else", { skip }, async () => {
  // Production's `all` window is unbounded (d43c8f92 readCacheRetentionCommunityBands
  // binds no day for it) and the cache lane builds every delivered day, so a
  // band older than any analysis horizon still counts in `all`.
  const old = "2025-08-27";
  const recent = [OWNER_B, "2026-09-28", "gpt-6-sol", "high", "five_to_ten_minutes",
    { adj: 5, reuse: 2, match: 1, ties: 1, exIns: 0, exCtx: 0, sess: 1 }];
  const ancient = [OWNER_A, old, "gpt-6-sol", "high", "five_to_ten_minutes",
    { adj: 4, reuse: 1, match: 1, ties: 0, exIns: 0, exCtx: 0, sess: 2 }];
  await reseed({ cache: [recent, ancient] });
  const body = JSON.parse((await get(`?from=${FROM}&to=${TO}`)).text).cacheRetention;
  const band = (window) => window.bands.find((entry) => entry.band === "five_to_ten_minutes");
  assert.deepEqual(body.windows.map((window) => [window.window, band(window).adjacencies, band(window).contributors]),
    [["day", 0, 0], ["week", 5, 1], ["month", 5, 1], ["all", 9, 2]]);
  const allSql = modules.cacheWindows.analyticsV2CacheBandsSql(schema, { byModel: false, bounded: false });
  assert.equal(/WHERE/u.test(allSql), false, "the all-window aggregate reads every stored day");
  assert.equal(modules.cacheWindows.analyticsV2CacheWindowFromDay(NOW_MS, null), null);
  await reseed();
});
