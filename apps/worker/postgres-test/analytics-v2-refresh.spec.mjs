/**
 * PG17 spec for the analytics_v2 schema (staged primary 0059), the store
 * (src/analytics-v2/store.ts) and the analytics-refresh Job entry
 * (cloud-run/analytics-refresh.mjs). A-3, GCP fast path.
 *
 * Each case applies the stock primary chain through the production runner
 * and the staged 0059 through the staged-migrations harness into a fresh
 * random schema, then drives the Job in-process with an injected pipeline.
 * The pipeline stands in for A-1 (readers) and A-2 (compute): it reads a tiny
 * content-free source model (two spec-owned tables in the same schema)
 * through the Job's snapshot read pool and derives contract-shaped outputs
 * from it, so these cases prove the schema, the store and the Job
 * orchestration, not the kernels. The default wiring
 * (createAnalyticsV2Pipeline) is proven twice: against stub modules with the
 * A-1/A-2 shapes, and end to end with the real A-1 readers and A-2 compute
 * over A-1's direct-seed corpus.
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
 *      PG_TEST_PORT=55433 node --test postgres-test/analytics-v2-refresh.spec.mjs
 * Without PG_TEST_SOCKET/PG_TEST_HOST the database cases skip; the Node 22
 * subprocess cases still run.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  NO_ANALYTICS_V2_EXCLUSIONS_SHA256,
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import * as job from "../cloud-run/analytics-refresh.mjs";
import { FASTPATH_TEST_CLOUD_TARGET } from "../cloud-run/origin-fastpath-mode.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "../cloud-run/cloud-run-iam-test-target.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import * as seedFixture from "./fixtures/analytics-v2/direct-seed.mjs";
import * as synthetic from "../analytics-v2-test/fixtures/synthetic-occurrences.mjs";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_PATH = join(WORKER_ROOT, "cloud-run", "analytics-refresh.mjs");
const STAGED_FILE = "0059_analytics_v2.sql";
// K-STAMP's run-stamps migration: staged as 0911, promoted as primary 0069 at
// the K-CORE-A merge. The harness skips a promoted name; the backfill case
// below applies the chain before it and then this file by hand.
const KERNEL_STAGED_FILE = "0069_analytics_v2_run_stamps.sql";
// K-PERCARD's per-card price staleness: staged as 0912, promoted as primary
// 0072 at the K-PERCARD merge. The harness skips a promoted name.
const PRICE_STAGED_FILE = "0072_analytics_v2_price_cards.sql";
const PRIMARY_MIGRATIONS_DIRECTORY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const STAGED_PRIMARY_DIRECTORY = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
// REV-SEED's revision floor: staged under a placeholder number until the
// integrator promotes it; found by its name suffix either way.
const FLOOR_SUFFIX = "_analytics_v2_revision_floor.sql";
const FLOOR_STAGED_FILE = await (async () => {
  const staged = (await readdir(STAGED_PRIMARY_DIRECTORY).catch(() => [])).filter((name) => name.endsWith(FLOOR_SUFFIX));
  const promoted = (await readPostgresMigrations({ role: "primary" })).map(({ name }) => name)
    .filter((name) => name.endsWith(FLOOR_SUFFIX));
  assert.equal(staged.length + promoted.length, 1, "exactly one revision-floor migration, staged or promoted");
  return { name: staged[0] ?? promoted[0], directory: staged.length === 1 ? STAGED_PRIMARY_DIRECTORY
    : PRIMARY_MIGRATIONS_DIRECTORY };
})();
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
/** The digest of no community aggregate exclusions (N-EXCL; exclusions.ts pins the same literal). */
const NO_EXCLUSIONS = NO_ANALYTICS_V2_EXCLUSIONS_SHA256;
/** An A-1 owners-module stand-in for a table with no exclusions (N-EXCL). */
const NO_EXCLUSION_READER = Object.freeze({
  async readAnalyticsV2Exclusions() {
    return { rows: 0, active: 0, sha256: NO_EXCLUSIONS, activeByParticipant: new Map() };
  },
});
/** A prior refresh state as readAnalyticsV2RefreshState returns it, with no exclusions applied. */
const specState = (state) => Object.freeze({ appliedExclusionsSha256: NO_EXCLUSIONS, publishedDays: [], ...state });
const NOW_1 = "2026-10-01T12:00:00.000Z";
const NOW_2 = "2026-10-01T18:30:00.000Z";
const NOW_3 = "2026-10-02T06:00:00.000Z";

const digest = (label) => createHash("sha256").update(`analytics-v2-refresh-spec:${label}`).digest("hex");
const OWNER_A = digest("owner-a");
const OWNER_B = digest("owner-b");
const OWNER_LEGACY = digest("owner-legacy");
const DAY_1 = "2026-09-28";
const DAY_2 = "2026-09-29";
const DAY_3 = "2026-09-30";
/** The stand-in recomputes every source day; the spec's days all follow this. */
const STAND_IN_HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });

let vite;
let contract;
let store;
let kernelIdentity;
let specStamp;
/** K-PERCARD: the price attribution, and the stored inputs of an owner-day with no usage event. */
let prices;
let emptyPriceInputs;
/** resources.ts: the GCP bounds the Job's environment mirrors. */
let resources;
/** The real A-1 readers and A-2 compute core, as the Job bundles them. */
let a1;
let a2;
/** The Worker modules A-1's direct-seed fixture digests its rows with. */
let seedModules;

before(async () => {
  // The analytics-v2 resolution: the vendored d43c8f92 kernels import the
  // packages vendored with them, as esbuild resolves them in the Job bundle.
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
  contract = await load("/src/analytics-v2/contract.ts");
  store = await load("/src/analytics-v2/store.ts");
  // The sources run unbundled here, so they carry no build-time kernel
  // identity: the spec states registry entry 1's (K-STAMP).
  const kernel = store.analyticsV2KernelRegistry()[0];
  kernelIdentity = Object.freeze({ vendorManifestSha256: kernel.vendorManifestSha256,
    computeClosureSha256: kernel.computeClosureSha256, methodVersion: kernel.methodVersion });
  specStamp = store.analyticsV2BaselineRunStamp(kernel);
  // The harness's literal is the module's digest of no exclusions.
  assert.equal((await load("/src/analytics-v2/exclusions.ts")).ANALYTICS_V2_NO_EXCLUSIONS_SHA256, NO_EXCLUSIONS);
  resources = await load("/src/analytics-v2/resources.ts");
  prices = await load("/src/analytics-v2/price-attribution.ts");
  emptyPriceInputs = (await prices.encodeAnalyticsV2PriceInputs([])).inputs;
  a1 = {
    owners: await load("/src/analytics-v2/owners.ts"),
    occurrences: await load("/src/analytics-v2/occurrence-source.ts"),
    devices: await load("/src/analytics-v2/devices.ts"),
    queuedDays: await load("/src/analytics-v2/queued-days.ts"),
  };
  a2 = await load("/src/analytics-v2/compute.ts");
  seedModules = {
    codec: await load("/src/typed-telemetry-codec.ts"),
    v12codec: await load("/src/telemetry-v12-typed-codec.ts"),
    reconciliation: await load("/src/telemetry-usage-reconciliation.ts"),
    sha256Hex: (await load("/src/crypto.ts")).sha256Hex,
  };
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function quoted(schema, table) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(table, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${table}"`;
}

function newPool(label, max = 4) {
  // search_path is pg_catalog alone: unqualified DDL or DML fails instead of
  // landing in the shared cluster's public schema.
  return new pg.Pool({
    ...ENDPOINT,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
    application_name: `analytics-v2-refresh-spec-${label}`,
    options: "-c search_path=pg_catalog",
  });
}

async function withDatabase(label, callback) {
  const pool = newPool(label);
  const created = [];
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
    const createSchema = async () => {
      const schema = `analytics_v2_refresh_${randomBytes(5).toString("hex")}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
      const applied = await applyStockAndStagedMigrations({
        role: "primary",
        schema,
        pool,
        stagedFiles: [STAGED_FILE, KERNEL_STAGED_FILE, FLOOR_STAGED_FILE.name, PRICE_STAGED_FILE],
      });
      // Before promotion 0059 is staged; after an unchanged promotion it is stock.
      assert.ok(
        applied.staged.some(({ name }) => name === STAGED_FILE) || applied.promoted.includes(STAGED_FILE),
        "0059 applied through the staged-migrations harness",
      );
      await pool.query(`CREATE TABLE ${quoted(schema, "spec_source_usage")} (
        owner_digest text NOT NULL, day date NOT NULL, usage_events integer NOT NULL,
        conflict boolean NOT NULL DEFAULT false, PRIMARY KEY (owner_digest, day))`);
      await pool.query(`CREATE TABLE ${quoted(schema, "spec_source_journal")} (
        sequence bigint PRIMARY KEY, day date NOT NULL)`);
      return { schema, applied };
    };
    return await callback({ pool, createSchema });
  } finally {
    for (const schema of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await pool.end();
  }
}

/** Set one owner-day in the synthetic source and append a journal event naming its day. */
async function setUsage(pool, schema, ownerDigest, day, usageEvents, { conflict = false, journal = true } = {}) {
  await pool.query(
    `INSERT INTO ${quoted(schema, "spec_source_usage")} (owner_digest, day, usage_events, conflict)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_digest, day) DO UPDATE SET usage_events = EXCLUDED.usage_events,
       conflict = EXCLUDED.conflict`,
    [ownerDigest, day, usageEvents, conflict],
  );
  if (journal) {
    await pool.query(
      `INSERT INTO ${quoted(schema, "spec_source_journal")} (sequence, day)
       SELECT COALESCE(max(sequence), 0) + 1, $1::date FROM ${quoted(schema, "spec_source_journal")}`,
      [day],
    );
  }
}

async function seedBaseCorpus(pool, schema) {
  await setUsage(pool, schema, OWNER_A, DAY_1, 3);
  await setUsage(pool, schema, OWNER_A, DAY_2, 5);
  await setUsage(pool, schema, OWNER_B, DAY_2, 7);
  await setUsage(pool, schema, OWNER_B, DAY_3, 11);
}

/** Every analytics_v2 row, canonicalized, for exact before/after comparison. */
async function analyticsSnapshot(pool, schema) {
  const snapshot = {};
  for (const table of Object.values(contract.ANALYTICS_V2_TABLES)) {
    const result = await pool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS rows
         FROM ${quoted(schema, table)} t`,
    );
    snapshot[table] = result.rows[0].rows;
  }
  return snapshot;
}

async function publishedRows(pool, schema) {
  const result = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, revision,
            to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at,
            payload, payload_sha256, run_id::text AS run_id
       FROM ${quoted(schema, "analytics_v2_published_daily")} ORDER BY day`,
  );
  return new Map(result.rows.map((row) => [row.day, row]));
}

async function runRows(pool, schema) {
  const result = await pool.query(
    `SELECT run_id::text AS run_id, mode, state, owners, owner_days, refusals, publication, timings
       FROM ${quoted(schema, "analytics_v2_runs")} ORDER BY finished_at, started_at`,
  );
  return result.rows;
}

async function count(pool, schema, table) {
  const result = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, table)}`);
  return result.rows[0].n;
}

/**
 * Load a synthetic REV-SEED revision floor by hand, as the cutover import's
 * loader writes it: the day rows, then the singleton that summarizes them.
 * `days` maps a day to Cloudflare's last revision.
 */
async function loadSpecFloor(pool, schema, days) {
  const entries = Object.entries(days).sort(([left], [right]) => (left < right ? -1 : 1));
  for (const [day, revision] of entries) {
    await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_revision_floor")} (day, revision) VALUES ($1, $2)`,
      [day, revision]);
  }
  await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_revision_floor_source")} (id, provenance, seal_id,
      floor_sha256, fence_receipt_sha256, analytics_bookmark_sha256, source_commit, captured_at, day_count, max_revision)
    VALUES (1, 'synthetic', $1, $2, $3, NULL, $4, $5, $6, $7)`,
  [digest("floor-seal"), digest(`floor:${JSON.stringify(entries)}`), digest("floor-fence"), "c".repeat(40), NOW_1,
    entries.length, Math.max(...entries.map(([, revision]) => revision))]);
}

// ---------------------------------------------------------------------------
// The injected pipeline (stands in for A-1 readers and A-2 compute)
// ---------------------------------------------------------------------------

function utcDay(epochMs) {
  return new Date(Math.floor(epochMs / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

function contractOwner(ownerDigest, source) {
  return {
    participantId: `participant-${ownerDigest.slice(0, 12)}`,
    ownerDigest,
    hasV1: false,
    hasV11: false,
    hasV12: source === "effective",
    hasLegacy: source === "v0.2",
    hasEffective: source === "effective",
    source,
  };
}

/**
 * K-PERCARD: the price row the prepared-day observer gives an owner-day of
 * `usageEvents` synthetic usage events (one fully priced d43c8f92 record
 * each), priced and encoded by the real attribution module.
 */
async function specPriceRow(ownerDigest, day, usageEvents) {
  const input = prices.analyticsV2PriceInput({ provider: "openai_codex", modelId: "gpt-5.6-sol",
    billingSurface: "chatgpt_subscription", speedMode: "standard", apiServiceTier: "default", reasoningEffort: "high",
    eventTime: `${day}T12:00:00.000Z`, totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } });
  const priced = prices.priceAnalyticsV2Input(input);
  const events = Array.from({ length: usageEvents }, () => ({ input, priced }));
  const { inputs, cardIds } = await prices.encodeAnalyticsV2PriceInputs(events);
  return { ownerDigest, day, cardIds, usageEvents, unpricedEvents: 0, partiallyPricedEvents: 0, inputs };
}

/** Price rows with no usage event for the owner-day rows with daily values (hand-built outputs). */
function emptyPriceRows(ownerDays) {
  return (Array.isArray(ownerDays) ? ownerDays : [])
    .filter((row) => row !== null && typeof row === "object" && row.daily !== null && row.daily !== undefined)
    .map((row) => ({ ownerDigest: row.ownerDigest, day: row.day, cardIds: [], usageEvents: 0, unpricedEvents: 0,
      partiallyPricedEvents: 0, inputs: emptyPriceInputs }));
}

/**
 * Reads go through the Job's snapshot pool on two separate connections, so
 * the snapshot case can prove they share one snapshot.
 */
function createSpecPipeline(hooks = {}) {
  return {
    async read({ pool, schema, nowMs, state }) {
      assert.equal(typeof nowMs, "number");
      const usageClient = await pool.connect();
      let usage;
      try {
        await usageClient.query("BEGIN READ ONLY");
        usage = (await usageClient.query(
          `SELECT owner_digest, to_char(day, 'YYYY-MM-DD') AS day, usage_events, conflict
             FROM ${quoted(schema, "spec_source_usage")} ORDER BY owner_digest, day`,
        )).rows;
        await usageClient.query("COMMIT");
      } finally {
        await usageClient.release();
      }
      await hooks.betweenReads?.(pool);
      const journalClient = await pool.connect();
      let journal;
      try {
        await journalClient.query("BEGIN READ ONLY");
        journal = (await journalClient.query(
          `SELECT sequence::text AS sequence, to_char(day, 'YYYY-MM-DD') AS day
             FROM ${quoted(schema, "spec_source_journal")}
            WHERE sequence > $1::bigint ORDER BY sequence`,
          [state.cursor ?? "0"],
        )).rows;
        await journalClient.query("COMMIT");
      } finally {
        await journalClient.release();
      }
      const queuedDays = job.analyticsRefreshPublicationDays(journal.map((row) => row.day), state);
      const lastSequence = journal.length === 0
        ? (state.cursor === null ? null : Number(state.cursor))
        : Number(journal[journal.length - 1].sequence);
      return { usage, queuedDays, lastSequence };
    },
    async compute(inputs, { nowMs, revisionSeed, mode }) {
      await hooks.beforeCompute?.();
      const today = utcDay(nowMs);
      const effective = [...new Set(inputs.usage.map((row) => row.owner_digest))].sort();
      const owners = [...effective.map((owner) => contractOwner(owner, "effective")),
        contractOwner(OWNER_LEGACY, "v0.2")];
      const ownerDays = [];
      const ownerDayPrices = [];
      const cacheBands = [];
      const ownerModelDates = [];
      const refusals = [{ ownerDigest: OWNER_LEGACY, day: null, family: "owner", reason: "non_effective_source_unported" }];
      const blocked = new Set();
      for (const row of inputs.usage) {
        if (row.conflict) {
          ownerDays.push({ ownerDigest: row.owner_digest, day: row.day, daily: null, refusal: "source_conflict_or_order" });
          refusals.push({ ownerDigest: row.owner_digest, day: row.day, family: "daily", reason: "source_conflict_or_order" });
          blocked.add(row.day);
          continue;
        }
        ownerDays.push({
          ownerDigest: row.owner_digest,
          day: row.day,
          daily: { usageEvents: row.usage_events, models: [{ modelId: "synthetic-model", usageEvents: row.usage_events }] },
          refusal: null,
        });
        ownerDayPrices.push(await specPriceRow(row.owner_digest, row.day, row.usage_events));
        for (const band of store.ANALYTICS_V2_CACHE_BANDS) {
          cacheBands.push({
            ownerDigest: row.owner_digest,
            day: row.day,
            model: "synthetic-model",
            effort: "medium",
            band,
            counters: {
              adjacencies: row.usage_events,
              reused_more_than_half: Math.floor(row.usage_events / 2),
              matched_or_exceeded: Math.floor(row.usage_events / 3),
              unordered_ties: 0,
              excluded_insufficient_evidence: 1,
              excluded_context_contracted: 0,
              sessions: Math.min(1, row.usage_events),
            },
          });
        }
        ownerModelDates.push({
          ownerDigest: row.owner_digest,
          day: row.day,
          result: { state: "ready", usageEvents: row.usage_events },
        });
      }
      const ownerFits = effective.map((ownerDigest) => ({
        ownerDigest,
        asOfDay: today,
        fits: [{
          participantId: `participant-${ownerDigest.slice(0, 12)}`,
          planType: "pro",
          capacityNanousd: inputs.usage.filter((row) => row.owner_digest === ownerDigest)
            .reduce((sum, row) => sum + row.usage_events, 0) * 1_000,
          lastObservedAt: `${today}T00:00:00.000Z`,
        }],
      }));
      const dailyCandidates = [];
      for (const day of inputs.queuedDays) {
        if (blocked.has(day)) continue;
        const rows = inputs.usage.filter((row) => row.day === day);
        const payload = {
          schemaVersion: "community-daily-v1.0",
          // Placeholders the store must replace; they must not reach the digest.
          aggregateId: `community-daily:${day}:r0`,
          day,
          revision: 0,
          releasedAt: new Date(nowMs).toISOString(),
          immutableRevision: true,
          recomputesOnLateData: true,
          totals: {
            contributingParticipants: new Set(rows.map((row) => row.owner_digest)).size,
            usageEvents: rows.reduce((sum, row) => sum + row.usage_events, 0),
          },
          cells: [],
        };
        dailyCandidates.push({ day, payload, payloadSha256: await store.analyticsV2DailyContentSha256(payload) });
      }
      return {
        contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION,
        mode,
        nowMs,
        today,
        revisionSeed,
        owners,
        ownerDays,
        ownerDayPrices,
        cacheBands,
        ownerFits,
        ownerModelDates,
        dailyCandidates,
        blockedDays: [...blocked].sort(),
        preview: { schemaVersion: "synthetic-preview", owners: effective.length },
        refusals,
        journal: { lastSequence: inputs.lastSequence },
        horizon: STAND_IN_HORIZON,
        timings: { prepare: 1, community: 1 },
        // The stand-in reads no exclusions table.
        exclusionsSha256: NO_EXCLUSIONS,
      };
    },
  };
}

/**
 * In-process runs use Node's default heap (about 4 GiB), so the per-owner
 * budget is set to its minimum (1,024 MiB): the heap check then needs about
 * 2.3 GiB (budget, 256 MiB runtime, the read reserve and a 64 MiB output
 * budget). The default budget (4,608 MiB) needs --max-old-space-size=6144,
 * as the Job is deployed.
 */
function jobEnvironment(extra = {}) {
  const env = { ANALYTICS_V2_TEST_CLOCK: "1", ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024", ...extra };
  for (const name of ["PG_TEST_SOCKET", "PG_TEST_HOST", "PG_TEST_PORT", "PG_TEST_USER",
    "PG_TEST_DATABASE", "PG_TEST_PASSWORD"]) {
    if (process.env[name]) env[name] ??= process.env[name];
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
    application_name: "analytics-v2-refresh-spec-job",
    options: "-c search_path=pg_catalog",
  });
}

function runJob({ schema, now = NOW_1, seed, pipeline = createSpecPipeline(), env, createPool = jobPool }) {
  return job.runAnalyticsRefresh({
    argv: ["--mode=full", `--schema=${schema}`, ...(now === null ? [] : [`--now=${now}`]),
      ...(seed === undefined ? [] : [`--revision-seed=${seed}`])],
    env: env ?? jobEnvironment(),
    dependencies: { modules: { store, pipeline }, createPool, kernelIdentity },
  });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("contract constants: the Job mirrors the lock key and the build entry", () => {
  assert.equal(job.ANALYTICS_REFRESH_LOCK_KEY, contract.ANALYTICS_V2_REFRESH_LOCK_KEY);
  assert.equal(job.ANALYTICS_REFRESH_ENTRY, contract.ANALYTICS_V2_REFRESH_ENTRY);
  assert.deepEqual([...job.ANALYTICS_REFRESH_MODES], [...contract.ANALYTICS_V2_MODES]);
  assert.equal(contract.ANALYTICS_V2_MIGRATION.name, STAGED_FILE);
});

test("resource constants: the Job's environment mirrors resources.ts; every roster A-1 lists can be written", () => {
  const MIB = 1_048_576;
  const bounds = resources.ANALYTICS_V2_RESOURCE_BOUNDS;
  const env = job.ANALYTICS_REFRESH_RESOURCE_ENV;
  const inMiB = (bound) => ({ minimum: bound.minimum / MIB, maximum: bound.maximum / MIB, default: bound.default / MIB });
  const pick = ({ minimum, maximum, default: value }) => ({ minimum, maximum, default: value });
  assert.deepEqual(pick(env.memoryBudgetMiB), inMiB(bounds.memoryBudgetBytes));
  assert.deepEqual(pick(env.maxDayOccurrences), pick(bounds.maxDayOccurrences));
  assert.deepEqual(pick(env.maxDayRecordMiB), inMiB(bounds.maxDayRecordBytes));
  // The output budget the Job derives stays inside A-2's bounds.
  assert.equal(job.ANALYTICS_REFRESH_HEAP_RESERVE.minimumOutputBudgetBytes >= bounds.outputBudgetBytes.minimum, true);
  assert.equal(job.analyticsRefreshResources({}, 64 * 1_024 * MIB).compute.outputBudgetBytes,
    bounds.outputBudgetBytes.maximum);
  assert.equal(job.ANALYTICS_REFRESH_MAX_READ_CANDIDATES, a1.occurrences.MAX_ANALYTICS_V2_CANDIDATES);
  assert.equal(job.ANALYTICS_REFRESH_MAX_READ_CANDIDATES, resources.ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES);
  assert.ok(env.readChunkOccurrences.maximum <= job.ANALYTICS_REFRESH_MAX_READ_CANDIDATES);
  assert.equal(store.ANALYTICS_V2_OUTPUT_LIMITS.owners, a1.owners.MAX_ANALYTICS_V2_OWNERS);
});

test("resources: environment within bounds, and a heap partitioned into budget, reserves and the output budget", () => {
  const MIB = 1_048_576;
  const heap = 6_192 * MIB;
  const defaults = job.analyticsRefreshResources({}, heap);
  const reserved = 4_608 * MIB + 256 * MIB + 250_000 * 4_096;
  // The rest of the heap is the output budget; no fixed reserve stands in for the outputs.
  assert.deepEqual(defaults.compute, { ...resources.ANALYTICS_V2_DEFAULT_RESOURCES, outputBudgetBytes: heap - reserved });
  assert.equal(defaults.readChunkOccurrences, 250_000);
  // 4,608 MiB + 256 MiB + 250,000 x 4 KiB + a 64 MiB output budget:
  // --max-old-space-size=6144 (heap limit 6,192 MiB) is enough.
  assert.equal(defaults.requiredHeapBytes, reserved + 64 * MIB);
  assert.ok(defaults.requiredHeapBytes <= heap);
  assert.equal(job.analyticsRefreshResources({}, defaults.requiredHeapBytes).compute.outputBudgetBytes, 64 * MIB);
  assert.throws(() => job.analyticsRefreshResources({}, defaults.requiredHeapBytes - 1),
    { code: "ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT" });
  assert.throws(() => job.analyticsRefreshResources({}, 4_144 * MIB), { code: "ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT" });
  // Inline (one worker), the dense budget lives in the main heap: a 12,288 MiB
  // old space (heap limit about 12,336 MiB) with the 10,752 MiB budget leaves
  // about 350 MiB of output budget.
  const dense = job.ANALYTICS_REFRESH_PRODUCTION_JOB;
  const inlineHeapMiB = 12_288;
  const denseResources = job.analyticsRefreshResources(
    { ANALYTICS_V2_MEMORY_BUDGET_MIB: String(dense.memoryBudgetMiB) }, (inlineHeapMiB + 48) * MIB);
  assert.ok(denseResources.requiredHeapBytes <= inlineHeapMiB * MIB);
  assert.equal(denseResources.compute.outputBudgetBytes,
    (inlineHeapMiB + 48 - dense.memoryBudgetMiB - 256) * MIB - 250_000 * 4_096);
  // A run adds the part of the budget its largest admitted owner leaves (the
  // plan fixes it before any output is charged): with owner e (1,517 MiB)
  // largest, about 9.4 GiB of output budget instead of 351 MiB.
  assert.equal(resources.analyticsV2OutputBudget(denseResources.compute, 1_517 * MIB, true),
    denseResources.compute.outputBudgetBytes + (dense.memoryBudgetMiB - 1_517) * MIB);
  // The production profile is inline (K-CORE-A review: no compute Workers
  // before MEAS-3 measures their heap peaks on real owners).
  assert.equal(dense.workers, 1);
  assert.equal(dense.heapMiB, inlineHeapMiB);
  // K-PAR (the test-deploy profile dense-workers, for MEAS-3): with four
  // Workers the budget is not in the 3,072 MiB main heap, which holds the
  // reserves and the output account (no reclaim).
  const parallelHeapMiB = 3_072;
  const parallel = job.analyticsRefreshResources(
    { ANALYTICS_V2_MEMORY_BUDGET_MIB: String(dense.memoryBudgetMiB) }, (parallelHeapMiB + 48) * MIB,
    { workers: 4 });
  assert.equal(parallel.workers, 4);
  assert.equal(parallel.compute.memoryBudgetBytes, dense.memoryBudgetMiB * MIB);
  assert.equal(parallel.compute.outputBudgetBytes, (parallelHeapMiB + 48 - 256) * MIB - 250_000 * 4_096);
  assert.throws(() => job.analyticsRefreshResources(
    { ANALYTICS_V2_MEMORY_BUDGET_MIB: String(dense.memoryBudgetMiB) }, (parallelHeapMiB + 48) * MIB),
  { code: "ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT" }, "inline, the budget does not fit the parallel heap");
  for (const workers of [0, 17, 1.5]) {
    assert.throws(() => job.analyticsRefreshResources({}, 64 * 1_024 * MIB, { workers }),
      { code: "ANALYTICS_V2_REFRESH_WORKERS_INVALID" });
  }
  const tuned = job.analyticsRefreshResources({ ANALYTICS_V2_MEMORY_BUDGET_MIB: "26624",
    ANALYTICS_V2_MAX_DAY_OCCURRENCES: "20000", ANALYTICS_V2_MAX_DAY_RECORD_MIB: "32",
    ANALYTICS_V2_READ_CHUNK_OCCURRENCES: "1000000" }, 32_768 * MIB);
  assert.deepEqual(tuned.compute, { memoryBudgetBytes: 26_624 * MIB, maxDayOccurrences: 20_000,
    maxDayRecordBytes: 32 * MIB, outputBudgetBytes: (32_768 - 26_624 - 256) * MIB - 1_000_000 * 4_096 });
  for (const [name, value] of [
    ["ANALYTICS_V2_MEMORY_BUDGET_MIB", "1023"], ["ANALYTICS_V2_MEMORY_BUDGET_MIB", "30721"],
    ["ANALYTICS_V2_MEMORY_BUDGET_MIB", "4608.5"], ["ANALYTICS_V2_MEMORY_BUDGET_MIB", "0x1200"],
    ["ANALYTICS_V2_MAX_DAY_OCCURRENCES", "19999"], ["ANALYTICS_V2_MAX_DAY_OCCURRENCES", "250001"],
    ["ANALYTICS_V2_MAX_DAY_RECORD_MIB", "31"], ["ANALYTICS_V2_MAX_DAY_RECORD_MIB", "257"],
    ["ANALYTICS_V2_READ_CHUNK_OCCURRENCES", "9999"], ["ANALYTICS_V2_READ_CHUNK_OCCURRENCES", "2000001"],
    ["ANALYTICS_V2_READ_CHUNK_OCCURRENCES", " 250000"],
  ]) {
    assert.throws(() => job.analyticsRefreshResources({ [name]: value }, 64 * 1_024 * MIB),
      (error) => error.code === "ANALYTICS_V2_REFRESH_RESOURCES_INVALID" && error.field === name, `${name}=${value}`);
  }
});

/**
 * The output projection the production profile must hold (C-REFRESH review,
 * 2026-10-02). It is a stated planning roster, not a production measurement:
 * OWN-3's owner counts and MEAS-3 replace it. Rates are what the dense
 * rehearsal's first run charged to the output account at 32215a26's dist
 * (b76aa67f..., docs/receipts/2026-10-02-gcp-c-refresh.md): owner e
 * 13,287,040 bytes and the heaviest light owner 2,888,220 bytes over the 170
 * analysis days. Each owner's whole output is charged per day of history,
 * although only its cache bands grow with history, so the rates err high.
 * The largest owner is taken at the high end of the largest real owner's
 * estimate (about 10 GiB when its records fall in the analysis days;
 * docs/receipts/2026-10-01-gcp-fastpath-caps.md), the case where the
 * profile's per-owner budget leaves the least to reclaim.
 */
const ANALYTICS_REFRESH_OUTPUT_PROJECTION = Object.freeze({
  largestOwnerEstimateMiB: 10_240,
  denseOwners: 4,
  denseBytesPerOwnerDay: Math.ceil(13_287_040 / 170),
  lightOwners: 60,
  lightBytesPerOwnerDay: Math.ceil(2_888_220 / 170),
  // The 170 analysis days plus a year of retained cache history.
  historyDays: 170 + 365,
});

test("the production profile's output budget holds the stated roster and history projection", () => {
  const MIB = 1_048_576;
  const profile = job.ANALYTICS_REFRESH_PRODUCTION_JOB;
  const projection = ANALYTICS_REFRESH_OUTPUT_PROJECTION;
  // The old-space size, not V8's slightly larger limit: the pin errs low.
  const partition = job.analyticsRefreshResources(
    { ANALYTICS_V2_MEMORY_BUDGET_MIB: String(profile.memoryBudgetMiB) }, profile.heapMiB * MIB,
    { workers: profile.workers }).compute;
  assert.equal(profile.workers, 1, "the production profile is inline");
  assert.ok(projection.largestOwnerEstimateMiB * MIB <= partition.memoryBudgetBytes, "the largest owner is admitted");
  const outputBudget = resources.analyticsV2OutputBudget(partition, projection.largestOwnerEstimateMiB * MIB, true);
  const perDay = projection.denseOwners * projection.denseBytesPerOwnerDay
    + projection.lightOwners * projection.lightBytesPerOwnerDay;
  const projected = perDay * projection.historyDays;
  assert.ok(projected <= outputBudget,
    `projected ${Math.ceil(projected / MIB)} MiB over an output budget of ${Math.floor(outputBudget / MIB)} MiB`);
  // The horizon the profile holds for this roster, recorded in the receipt:
  // 641 days at the high-end estimate, against 238 without the reclaim.
  assert.equal(Math.floor(outputBudget / perDay), 641);
  assert.equal(Math.floor(partition.outputBudgetBytes / perDay), 238);
  // K-PAR's dense-workers profile (3,072 MiB main heap, four Workers; MEAS-3
  // only): the owners' heaps are the Workers', so the main heap's output
  // budget does not depend on the largest owner (no reclaim): 1,447 days.
  const parallel = job.analyticsRefreshResources(
    { ANALYTICS_V2_MEMORY_BUDGET_MIB: String(profile.memoryBudgetMiB) }, 3_072 * MIB, { workers: 4 }).compute;
  assert.equal(Math.floor(parallel.outputBudgetBytes / perDay), 1_447);
});

test("read spans: contiguous, at most the day bound, and about the read chunk by the exact counts", () => {
  const range = { fromDay: "2026-01-01", throughDay: "2026-01-10" };
  const counts = new Map([["2026-01-02", 6], ["2026-01-03", 5], ["2026-01-05", 20], ["2026-01-09", 1]]);
  assert.deepEqual(job.analyticsRefreshReadSpans(range, 4, counts, 10), [
    { fromDay: "2026-01-01", throughDay: "2026-01-02", occurrences: 6 },
    { fromDay: "2026-01-03", throughDay: "2026-01-04", occurrences: 5 },
    // A day over the chunk is a span of its own; A-1 never splits a day.
    { fromDay: "2026-01-05", throughDay: "2026-01-05", occurrences: 20 },
    { fromDay: "2026-01-06", throughDay: "2026-01-09", occurrences: 1 },
    { fromDay: "2026-01-10", throughDay: "2026-01-10", occurrences: 0 },
  ]);
  // Without counts the spans are the plain day chunks.
  assert.deepEqual(job.analyticsRefreshReadSpans(range, 4, new Map(), 10)
    .map(({ fromDay, throughDay }) => ({ fromDay, throughDay })), job.analyticsRefreshRangeChunks(range, 4));
});

test("(f, heap) a heap below the budget plus the reserve is refused before any database work", async () => {
  let pools = 0;
  await assert.rejects(job.runAnalyticsRefresh({
    argv: ["--mode=full", "--schema=analytics_v2_heap_refusal"],
    env: { PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-unused/socket" },
    dependencies: { heapLimitBytes: 2_048 * 1_048_576, createPool: () => { pools += 1; return {}; } },
  }), (error) => {
    assert.equal(error.code, "ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT");
    assert.equal(error.phase, "configuration");
    return true;
  });
  assert.equal(pools, 0);
});

test("PG17: 0059 applies within the primary migration chain and creates exactly the contract tables", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("schema", async ({ pool, createSchema }) => {
    const stock = await readPostgresMigrations({ role: "primary" });
    const { schema, applied } = await createSchema();
    const stagedCount = applied.staged.length;
    assert.equal(stock.length + stagedCount, 72,
      "the 72-migration primary chain, 0059, the run stamps, the revision floor and the price cards staged or promoted");
    const history = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, "_tibotattle_migration_history")}`);
    assert.equal(history.rows[0].n, stock.length, "staged SQL is not recorded as a migration receipt");

    const tables = await pool.query(
      `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname LIKE 'analytics\\_v2\\_%'
        ORDER BY 1`,
      [schema],
    );
    // The contract's tables, and REV-SEED's revision floor, which the store
    // names (it decides no kernel value, so it stays out of contract.ts).
    assert.deepEqual(tables.rows.map((row) => row.name), [...Object.values(contract.ANALYTICS_V2_TABLES),
      ...Object.values(store.ANALYTICS_V2_REVISION_FLOOR_TABLES)].sort());
    const described = [
      ...Object.entries(contract.ANALYTICS_V2_TABLES).map(([key, table]) => [table,
        contract.ANALYTICS_V2_COLUMNS[key], contract.ANALYTICS_V2_PRIMARY_KEYS[key]]),
      ...Object.entries(store.ANALYTICS_V2_REVISION_FLOOR_TABLES).map(([key, table]) => [table,
        store.ANALYTICS_V2_REVISION_FLOOR_COLUMNS[key], store.ANALYTICS_V2_REVISION_FLOOR_PRIMARY_KEYS[key]]),
    ];
    for (const [table, expectedColumns, expectedKey] of described) {
      const columns = await pool.query(
        `SELECT column_name::text AS name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      );
      assert.deepEqual(columns.rows.map((row) => row.name), [...expectedColumns], table);
      const primaryKey = await pool.query(
        `SELECT a.attname::text AS name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey::int2[], a.attnum)`,
        [`"${schema}"."${table}"`],
      );
      assert.deepEqual(primaryKey.rows.map((row) => row.name), [...expectedKey], table);
    }
    const otherSchemas = await pool.query(
      `SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname LIKE 'analytics\\_v2\\_%' AND n.nspname = 'public'`,
    );
    assert.equal(otherSchemas.rows[0].n, 0, "nothing escaped into public");
  });
});

test("PG17: K-STAMP stamps every row with the registry kernel, refuses conflicts and regressions, and leaves earlier rows unattributed", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  const registry = store.analyticsV2KernelRegistry();
  assert.equal(registry[0].kernelId, 1);
  assert.equal(registry[0].productionCommit, "d43c8f92a059d9c577776f7eca8a331eb305b8a6");
  assert.equal(store.ANALYTICS_V2_MANIFEST_BASELINE_VERSION, 1);
  // An unregistered identity, and an unbundled run with none, refuse before any database work.
  assert.throws(() => store.resolveAnalyticsV2Kernel({ ...kernelIdentity, computeClosureSha256: "f".repeat(64) }),
    { code: "ANALYTICS_V2_KERNEL_UNREGISTERED" });
  assert.equal(store.analyticsV2BundledKernelIdentity(), null, "the sources carry no build-time identity");
  assert.throws(() => job.analyticsRefreshRunStamp(store, undefined), { code: "ANALYTICS_V2_KERNEL_UNREGISTERED" });
  assert.deepEqual(job.analyticsRefreshRunStamp(store, kernelIdentity), specStamp);
  await withDatabase("kernel-stamps", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    const kernels = async () => (await pool.query(`SELECT kernel_id, production_commit, vendor_manifest_sha256,
        compute_closure_sha256, price_registry_sha256, price_registry_version, method_version
       FROM ${quoted(schema, "analytics_v2_kernels")} ORDER BY kernel_id`)).rows;
    try {
      // The migration seeds no kernel: the first run that stamps registers its own.
      assert.deepEqual(await kernels(), []);
      const payload = { day: DAY_1, value: 1 };
      // A third argument, even undefined, replaces the recorded exclusions digest.
      const write = (stamp, options = {}, ...digest) => store.writeRunOutputs(client,
        minimalOutputs({
          ownerDays: [{ ownerDigest: OWNER_A, day: DAY_1, daily: { counts: 1 }, refusal: null }],
          ownerFits: [{ ownerDigest: OWNER_A, asOfDay: DAY_1, fits: [] }],
          ownerModelDates: [{ ownerDigest: OWNER_A, day: DAY_1, result: { status: "ready" } }],
          ...options,
        }), { schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null,
          horizon: STAND_IN_HORIZON, stamp, exclusionsSha256: digest.length === 0 ? NO_EXCLUSIONS : digest[0] });
      await write(specStamp, { dailyCandidates: [{ day: DAY_1, payload,
        payloadSha256: await store.analyticsV2DailyContentSha256(payload) }] });
      assert.deepEqual(await kernels(), [{ kernel_id: 1, production_commit: registry[0].productionCommit,
        vendor_manifest_sha256: registry[0].vendorManifestSha256, compute_closure_sha256: registry[0].computeClosureSha256,
        price_registry_sha256: registry[0].priceRegistrySha256, price_registry_version: registry[0].priceRegistryVersion,
        method_version: registry[0].methodVersion }]);
      for (const table of ["analytics_v2_runs", "analytics_v2_owner_day", "analytics_v2_owner_fits",
        "analytics_v2_owner_model_dates", "analytics_v2_published_daily", "analytics_v2_preview"]) {
        const stamps = await pool.query(`SELECT DISTINCT kernel_id, manifest_version FROM ${quoted(schema, table)}`);
        assert.deepEqual(stamps.rows, [{ kernel_id: 1, manifest_version: 1 }], table);
      }
      await write(specStamp);
      assert.equal(await count(pool, schema, "analytics_v2_kernels"), 1, "the registered kernel is not duplicated");
      // A run without a resource record has no compatibility class: null, never
      // inferred. Every run records the exclusions it applied (N-EXCL).
      assert.deepEqual((await pool.query(`SELECT DISTINCT compatibility_sha256, exclusions_sha256
        FROM ${quoted(schema, "analytics_v2_runs")}`)).rows, [{ compatibility_sha256: null, exclusions_sha256: NO_EXCLUSIONS }]);
      for (const exclusionsSha256 of [undefined, null, "F".repeat(64), "f".repeat(63)]) {
        await assert.rejects(write(specStamp, {}, exclusionsSha256), { code: "ANALYTICS_V2_RUN_INVALID",
          field: "exclusionsSha256" });
      }

      // A registry entry that disagrees with the stored kernel row is refused, atomically.
      const before = await analyticsSnapshot(pool, schema);
      for (const kernel of [{ ...specStamp.kernel, computeClosureSha256: "e".repeat(64) },
        { ...specStamp.kernel, kernelId: 2 }]) {
        await assert.rejects(write({ kernel, manifestVersion: 1 }), { code: "ANALYTICS_V2_KERNEL_CONFLICT" });
      }
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
      // A malformed stamp is refused before any database work.
      for (const stamp of [undefined, { kernel: specStamp.kernel, manifestVersion: 0 },
        { kernel: { ...specStamp.kernel, kernelId: 0 }, manifestVersion: 1 },
        { kernel: specStamp.kernel, manifestVersion: 1, extra: true }]) {
        await assert.rejects(write(stamp), { code: "ANALYTICS_V2_RUN_INVALID" });
      }

      // A newer kernel registers itself and stamps its rows; the older one may not write after it.
      const kernel2 = { ...specStamp.kernel, kernelId: 2, computeClosureSha256: "d".repeat(64) };
      await write({ kernel: kernel2, manifestVersion: 3 });
      assert.deepEqual((await kernels()).map((row) => row.kernel_id), [1, 2]);
      assert.deepEqual((await pool.query(`SELECT DISTINCT kernel_id, manifest_version
        FROM ${quoted(schema, "analytics_v2_owner_day")}`)).rows, [{ kernel_id: 2, manifest_version: 3 }]);
      const newer = await analyticsSnapshot(pool, schema);
      await assert.rejects(write(specStamp), { code: "ANALYTICS_V2_KERNEL_REGRESSION" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), newer, "an older kernel never mutates newer state");

      // The kernel rows are append-only, and every stamp column is required and bounded.
      await assert.rejects(pool.query(`UPDATE ${quoted(schema, "analytics_v2_kernels")} SET method_version =
        'analytics-v2-method-v9' WHERE kernel_id = 1`), { code: "P1005" });
      await assert.rejects(pool.query(`DELETE FROM ${quoted(schema, "analytics_v2_kernels")} WHERE kernel_id = 2`),
        { code: "P1005" });
      await assert.rejects(pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")}
        (owner_digest, day, daily, refusal, run_id, manifest_version) VALUES ($1, $2, '{}', NULL, $3, 1)`,
      [OWNER_B, DAY_2, randomUUID()]), { code: "23514" }, "no default kernel: a new row must name its kernel");
      await assert.rejects(pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")}
        (owner_digest, day, daily, refusal, run_id, kernel_id) VALUES ($1, $2, '{}', NULL, $3, 1)`,
      [OWNER_B, DAY_2, randomUUID()]), { code: "23502" }, "no default manifest: a new row must name its manifest");
      await assert.rejects(pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")}
        (owner_digest, day, daily, refusal, run_id, kernel_id, manifest_version) VALUES ($1, $2, '{}', NULL, $3, 1, 0)`,
      [OWNER_B, DAY_2, randomUUID()]), { code: "23514" }, "manifest version 0 does not exist");
      await assert.rejects(pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")}
        (owner_digest, day, daily, refusal, run_id, kernel_id, manifest_version) VALUES ($1, $2, '{}', NULL, $3, 9, 1)`,
      [OWNER_B, DAY_2, randomUUID()]), { code: "23503" }, "a kernel id the registry copy does not hold");
      await assert.rejects(pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_runs")} (run_id, started_at,
        finished_at, mode, state, owners, owner_days, refusals, publication, timings, kernel_id, manifest_version)
        VALUES ($1, $2, $2, 'full', 'complete', 0, 0, '[]', '{"published":[],"unchanged":[],"blocked":[]}', '{}', 1, 1)`,
      [randomUUID(), NOW_1]), { code: "23514" }, "a new run row must record the exclusions it applied");
    } finally {
      client.release();
    }
  });

  // Rows written before the migration (K-CORE-A review): their kernel is
  // unattributed (NULL), never inferred; their manifest is the compiled
  // baseline (the only configuration there was); their run rows record no
  // compatibility class and no exclusions digest, which reads as "no
  // exclusions applied". All without an UPDATE (0059's forward-only trigger
  // never fires). A later run stamps what it rewrites and leaves the rest.
  await withDatabase("kernel-backfill", async ({ pool }) => {
    const schema = `analytics_v2_refresh_${randomBytes(5).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // The promoted chain below the run stamps (primary 0069), applied by the
    // production runner, so the rows below are written before the migration.
    const kernelVersion = Number(KERNEL_STAGED_FILE.slice(0, 4));
    const prefixRoot = await mkdtemp(join(tmpdir(), "analytics-v2-run-stamps-"));
    try {
      await mkdir(join(prefixRoot, "primary"));
      for (const migration of await readPostgresMigrations({ role: "primary" })) {
        if (migration.version < kernelVersion) {
          await copyFile(join(PRIMARY_MIGRATIONS_DIRECTORY, migration.name), join(prefixRoot, "primary", migration.name));
        }
      }
      const prior = await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [STAGED_FILE],
        rootDirectory: prefixRoot });
      assert.equal(prior.stockApplied, kernelVersion - 1, "the chain stops before the run stamps");
      const runId = randomUUID();
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_runs")} (run_id, started_at, finished_at, mode, state,
        owners, owner_days, refusals, publication, timings) VALUES ($1, $2, $2, 'full', 'complete', 1, 1, '[]',
        '{"published":[],"unchanged":[],"blocked":[]}', '{}')`, [runId, NOW_1]);
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id)
        VALUES ($1, $2, '{}', NULL, $3), ($4, $2, '{}', NULL, $3)`, [OWNER_A, DAY_1, runId, OWNER_B]);
      const payload = { aggregateId: `community-daily:${DAY_1}:r1`, day: DAY_1, revision: 1 };
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_published_daily")} (day, revision, released_at,
        payload, payload_sha256, run_id) VALUES ($1, 1, $2, $3::jsonb, $4, $5)`,
      [DAY_1, NOW_1, JSON.stringify(payload), "a".repeat(64), runId]);
      const sql = await readFile(join(PRIMARY_MIGRATIONS_DIRECTORY, KERNEL_STAGED_FILE), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(sql);
        // REV-SEED's floor, which the store reads, follows the run stamps.
        await client.query(await readFile(join(FLOOR_STAGED_FILE.directory, FLOOR_STAGED_FILE.name), "utf8"));
        // K-PERCARD's tables (additive; the store writes them with every run).
        await client.query(await priceMigrationSql());
        await client.query("COMMIT");
        assert.equal(await count(pool, schema, "analytics_v2_kernels"), 0, "no kernel is seeded");
        for (const table of ["analytics_v2_runs", "analytics_v2_owner_day", "analytics_v2_published_daily"]) {
          assert.deepEqual((await pool.query(`SELECT DISTINCT kernel_id, manifest_version FROM ${quoted(schema, table)}`)).rows,
            [{ kernel_id: null, manifest_version: 1 }], table);
        }
        assert.deepEqual((await pool.query(`SELECT revision, compatibility_sha256, exclusions_sha256
          FROM ${quoted(schema, "analytics_v2_runs")} r CROSS JOIN ${quoted(schema, "analytics_v2_published_daily")} p`)).rows,
        [{ revision: 1, compatibility_sha256: null, exclusions_sha256: null }]);
        // The constraints were added NOT VALID, so the unattributed rows stay as they are.
        assert.deepEqual((await pool.query(`SELECT conname, convalidated FROM pg_constraint
          WHERE connamespace = $1::regnamespace AND conname LIKE '%_kernel_stamped' ORDER BY conname`,
        [`"${schema}"`])).rows.map((row) => row.convalidated), Array(7).fill(false));
        // The state reads the pre-migration run as having applied no exclusions.
        const state = await store.readAnalyticsV2RefreshState(client, { schema });
        assert.equal(state.appliedExclusionsSha256, NO_EXCLUSIONS);
        assert.deepEqual(state.publishedDays, [DAY_1]);
        // A later run stamps the rows it rewrites; the owner it does not compute keeps its unattributed rows.
        await store.writeRunOutputs(client, minimalOutputs({
          ownerDays: [{ ownerDigest: OWNER_A, day: DAY_1, daily: { counts: 2 }, refusal: null }],
        }), { schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_2), expectedCursor: null,
          horizon: STAND_IN_HORIZON, stamp: specStamp, exclusionsSha256: NO_EXCLUSIONS });
        assert.deepEqual((await pool.query(`SELECT owner_digest, kernel_id FROM ${quoted(schema, "analytics_v2_owner_day")}
          ORDER BY owner_digest`)).rows, [{ owner_digest: OWNER_A, kernel_id: 1 }, { owner_digest: OWNER_B, kernel_id: null }]
          .sort((left, right) => (left.owner_digest < right.owner_digest ? -1 : 1)));
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await rm(prefixRoot, { recursive: true, force: true });
    }
  });
});

test("PG17: 0059 constraints refuse malformed digests, bands, counters, reasons and backward moves", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("constraints", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    const runId = randomUUID();
    const expectRefusal = async (sql, values, sqlState) => {
      await client.query("SAVEPOINT probe");
      await assert.rejects(client.query(sql, values), (error) => {
        assert.equal(error.code, sqlState, sql);
        return true;
      });
      await client.query("ROLLBACK TO SAVEPOINT probe");
    };
    const accept = async (sql, values) => {
      await client.query("SAVEPOINT probe");
      await client.query(sql, values);
      await client.query("ROLLBACK TO SAVEPOINT probe");
    };
    try {
      await client.query("BEGIN");
      // 0059's own constraints: the run stamps (a later migration, with no
      // defaults and no seeded kernel) are given transaction-local defaults
      // and kernel 1 here; the stamp constraints have their own case.
      const kernel = specStamp.kernel;
      await client.query(`INSERT INTO ${quoted(schema, "analytics_v2_kernels")} (kernel_id, production_commit,
          vendor_manifest_sha256, compute_closure_sha256, price_registry_sha256, price_registry_version, method_version,
          registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [kernel.kernelId, kernel.productionCommit,
        kernel.vendorManifestSha256, kernel.computeClosureSha256, kernel.priceRegistrySha256, kernel.priceRegistryVersion,
        kernel.methodVersion, NOW_1]);
      for (const table of ["analytics_v2_runs", "analytics_v2_owner_day", "analytics_v2_cache_bands",
        "analytics_v2_owner_fits", "analytics_v2_owner_model_dates", "analytics_v2_published_daily",
        "analytics_v2_preview"]) {
        await client.query(`ALTER TABLE ${quoted(schema, table)} ALTER COLUMN kernel_id SET DEFAULT 1,
          ALTER COLUMN manifest_version SET DEFAULT 1`);
      }
      await client.query(`ALTER TABLE ${quoted(schema, "analytics_v2_runs")}
        ALTER COLUMN exclusions_sha256 SET DEFAULT '${NO_EXCLUSIONS}'`);
      const ownerDay = `INSERT INTO ${quoted(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id)
                        VALUES ($1, $2, $3::jsonb, $4, $5)`;
      await expectRefusal(ownerDay, [OWNER_A.toUpperCase(), DAY_1, "{}", null, runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, null, null, runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, "{}", "usage_window_unrepresentable", runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, null, "free_form_reason", runId], "23514");
      // The owner-day CHECK accepts exactly the contract's owner-day reasons.
      // The cache-only reasons never replace prepared daily values, and the
      // owner-only reasons (memory_budget) refuse an owner that writes no
      // owner-scoped row, so 0059 refuses both there; together the three
      // loops cover every closed reason.
      assert.deepEqual(
        [...contract.ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS, ...contract.ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS,
          ...contract.ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS].sort(),
        [...contract.ANALYTICS_V2_REFUSAL_REASONS].sort(),
      );
      assert.deepEqual([...contract.ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS], ["memory_budget"]);
      for (const reason of contract.ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS) {
        await accept(ownerDay, [OWNER_A, DAY_1, null, reason, runId]);
      }
      for (const reason of [...contract.ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS,
        ...contract.ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS]) {
        await expectRefusal(ownerDay, [OWNER_A, DAY_1, null, reason, runId], "23514");
      }

      const band = `INSERT INTO ${quoted(schema, "analytics_v2_cache_bands")}
        (owner_digest, day, model, effort, band, adjacencies, reused_more_than_half, matched_or_exceeded,
         unordered_ties, excluded_insufficient_evidence, excluded_context_contracted, sessions, run_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, $10, $11)`;
      for (const name of store.ANALYTICS_V2_CACHE_BANDS) {
        await accept(band, [OWNER_A, DAY_1, "m", "e", name, 4, 2, 1, 0, 1, runId]);
      }
      await expectRefusal(band, [OWNER_A, DAY_1, "m", "e", "one_to_five_minutes", 4, 2, 1, 0, 1, runId], "23514");
      await expectRefusal(band, [OWNER_A, DAY_1, "m", "e", "under_one_minute", 4, 5, 1, 0, 1, runId], "23514");
      await expectRefusal(band, [OWNER_A, DAY_1, "m", "e", "under_one_minute", 4, 2, 3, 0, 1, runId], "23514");
      await expectRefusal(band, [OWNER_A, DAY_1, "m", "e", "under_one_minute", 4, 2, 1, 0, 5, runId], "23514");
      await expectRefusal(band, [OWNER_A, DAY_1, "m/x", "e", "under_one_minute", 4, 2, 1, 0, 1, runId], "23514");
      await expectRefusal(band, [OWNER_A, DAY_1, "m", "", "under_one_minute", 4, 2, 1, 0, 1, runId], "23514");

      const published = `INSERT INTO ${quoted(schema, "analytics_v2_published_daily")}
        (day, revision, released_at, payload, payload_sha256, run_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`;
      const payload = (day, revision) => JSON.stringify({
        aggregateId: `community-daily:${day}:r${revision}`, day, revision, releasedAt: NOW_1,
      });
      const sha = "a".repeat(64);
      await expectRefusal(published, [DAY_1, 2, NOW_1, payload(DAY_1, 1), sha, runId], "23514");
      await expectRefusal(published, [DAY_1, 1, NOW_1, payload(DAY_2, 1), sha, runId], "23514");
      await expectRefusal(published, [DAY_1, 1, NOW_1, JSON.stringify({ day: DAY_1, revision: 1 }), sha, runId], "23514");
      await expectRefusal(published, [DAY_1, 1, NOW_1, payload(DAY_1, 1), "A".repeat(64), runId], "23514");
      await client.query(published, [DAY_1, 1, NOW_1, payload(DAY_1, 1), sha, runId]);
      const update = `UPDATE ${quoted(schema, "analytics_v2_published_daily")}
                         SET revision = $2, payload = $3::jsonb, payload_sha256 = $4 WHERE day = $1`;
      await expectRefusal(update, [DAY_1, 2, payload(DAY_1, 2), sha], "P1005");
      await expectRefusal(update, [DAY_1, 1, payload(DAY_1, 1), "b".repeat(64)], "P1005");
      await accept(update, [DAY_1, 2, payload(DAY_1, 2), "b".repeat(64)]);
      await expectRefusal(`DELETE FROM ${quoted(schema, "analytics_v2_published_daily")} WHERE day = $1`, [DAY_1], "P1005");

      const cursor = `INSERT INTO ${quoted(schema, "analytics_v2_journal_cursor")} (id, last_sequence, run_id)
                      VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence`;
      await expectRefusal(cursor, [2, 1, runId], "23514");
      await client.query(cursor, [1, 5, runId]);
      await expectRefusal(cursor, [1, 4, runId], "P1005");
      await expectRefusal(`DELETE FROM ${quoted(schema, "analytics_v2_journal_cursor")}`, [], "P1005");
      await accept(cursor, [1, 6, runId]);
      await expectRefusal(`INSERT INTO ${quoted(schema, "analytics_v2_preview")} (id, preview, computed_at, run_id)
                           VALUES (2, NULL, now(), $1)`, [runId], "23514");
      await expectRefusal(`INSERT INTO ${quoted(schema, "analytics_v2_runs")}
          (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings)
          VALUES ($1, now(), now(), 'memo', 'complete', 0, 0, '[]', '{"published":[],"unchanged":[],"blocked":[]}', '{}')`,
        [runId], "23514");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// (a) (b) (c): first run, identical rerun, one changed owner-day
// ---------------------------------------------------------------------------

test("PG17 (a)(b)(c): full runs write every family, rerun publishes nothing, one change bumps one day", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("abc", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);

    // (a) First full run: every family is written and the run row is complete.
    const first = await runJob({ schema });
    assert.equal(first.status, "ok");
    assert.equal(first.state, "complete");
    assert.equal(first.clock, "test");
    assert.equal(first.now, NOW_1);
    assert.deepEqual(first.published, [DAY_1, DAY_2, DAY_3]);
    assert.equal(first.unchanged, 0);
    assert.deepEqual(first.blocked, []);
    assert.equal(first.owners, 3);
    assert.equal(first.cursor, "4");
    assert.deepEqual(first.refusalsByReason, { non_effective_source_unported: 1 });
    for (const [table, expected] of [
      ["analytics_v2_owner_day", 4],
      ["analytics_v2_cache_bands", 40],
      ["analytics_v2_owner_fits", 2],
      ["analytics_v2_owner_model_dates", 4],
      ["analytics_v2_published_daily", 3],
      ["analytics_v2_preview", 1],
      ["analytics_v2_journal_cursor", 1],
      ["analytics_v2_runs", 1],
    ]) {
      assert.equal(await count(pool, schema, table), expected, table);
    }
    const runs1 = await runRows(pool, schema);
    assert.equal(runs1[0].run_id, first.runId);
    assert.equal(runs1[0].state, "complete");
    assert.equal(runs1[0].mode, "full");
    assert.equal(runs1[0].owners, 3);
    assert.equal(runs1[0].owner_days, 4);
    assert.deepEqual(runs1[0].refusals, [
      { ownerDigest: OWNER_LEGACY, day: null, family: "owner", reason: "non_effective_source_unported" },
    ]);
    assert.deepEqual(runs1[0].publication, { published: [DAY_1, DAY_2, DAY_3], unchanged: [], blocked: [] });
    assert.ok(Number.isFinite(runs1[0].timings.read) && Number.isFinite(runs1[0].timings.write));
    const heads1 = await publishedRows(pool, schema);
    for (const day of [DAY_1, DAY_2, DAY_3]) {
      const row = heads1.get(day);
      assert.equal(row.revision, 1);
      assert.equal(row.released_at, NOW_1);
      assert.equal(row.payload.aggregateId, `community-daily:${day}:r1`);
      assert.equal(row.payload.revision, 1);
      assert.equal(row.payload.releasedAt, NOW_1);
      assert.equal(row.payload.day, day);
      assert.equal(row.payload_sha256, await store.analyticsV2DailyContentSha256(row.payload),
        "payload_sha256 digests the payload without its revision-bound fields");
      assert.equal(row.run_id, first.runId);
    }
    assert.equal(heads1.get(DAY_2).payload.totals.usageEvents, 12);
    const preview = await pool.query(`SELECT preview, to_char(computed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at FROM ${quoted(schema, "analytics_v2_preview")}`);
    assert.deepEqual(preview.rows[0], { preview: { schemaVersion: "synthetic-preview", owners: 2 }, computed_at: NOW_1 });

    // (b) An identical second run: nothing is queued (production's queue), so no
    // head is recomputed and no revision moves.
    const second = await runJob({ schema });
    assert.equal(second.state, "complete");
    assert.deepEqual(second.published, []);
    assert.equal(second.unchanged, 0);
    assert.equal(second.cursor, "4");
    const runs2 = await runRows(pool, schema);
    assert.equal(runs2.length, 2);
    assert.deepEqual(runs2[1].publication, { published: [], unchanged: [], blocked: [] });
    assert.deepEqual(await publishedRows(pool, schema), heads1, "published heads are byte-identical");
    // Journal events re-queue the days without a source change, at a later
    // --now: the digests exclude releasedAt, so the run row records the three
    // days as unchanged and no revision moves.
    for (const day of [DAY_1, DAY_2, DAY_3]) {
      await pool.query(`INSERT INTO ${quoted(schema, "spec_source_journal")} (sequence, day)
        SELECT max(sequence) + 1, $1::date FROM ${quoted(schema, "spec_source_journal")}`, [day]);
    }
    const third = await runJob({ schema, now: NOW_2 });
    assert.equal(third.state, "complete");
    assert.deepEqual(third.published, []);
    assert.equal(third.unchanged, 3);
    assert.equal(third.cursor, "7");
    assert.deepEqual((await runRows(pool, schema))[2].publication,
      { published: [], unchanged: [DAY_1, DAY_2, DAY_3], blocked: [] });
    assert.deepEqual(await publishedRows(pool, schema), heads1, "published heads are byte-identical");

    // (c) One owner-day changes: exactly that day's revision moves by one.
    await setUsage(pool, schema, OWNER_B, DAY_3, 12);
    const fourth = await runJob({ schema, now: NOW_3 });
    assert.deepEqual(fourth.published, [DAY_3]);
    assert.equal(fourth.unchanged, 0, "only the queued day is recomputed");
    const heads4 = await publishedRows(pool, schema);
    assert.deepEqual(heads4.get(DAY_1), heads1.get(DAY_1));
    assert.deepEqual(heads4.get(DAY_2), heads1.get(DAY_2));
    const changed = heads4.get(DAY_3);
    assert.equal(changed.revision, heads1.get(DAY_3).revision + 1);
    assert.equal(changed.released_at, NOW_3);
    assert.equal(changed.payload.aggregateId, `community-daily:${DAY_3}:r2`);
    assert.equal(changed.payload.totals.usageEvents, 12);
    assert.equal(changed.run_id, fourth.runId);
    assert.notEqual(changed.payload_sha256, heads1.get(DAY_3).payload_sha256);
  });
});

test("PG17: revision = max(previous, revisionSeed) + 1 and released_at = --now, deterministically", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("seed", async ({ pool, createSchema }) => {
    const left = await createSchema();
    const right = await createSchema();
    for (const { schema } of [left, right]) {
      await seedBaseCorpus(pool, schema);
      const receipt = await runJob({ schema, seed: 41 });
      assert.deepEqual(receipt.published, [DAY_1, DAY_2, DAY_3]);
    }
    const leftHeads = await publishedRows(pool, left.schema);
    const rightHeads = await publishedRows(pool, right.schema);
    for (const day of [DAY_1, DAY_2, DAY_3]) {
      assert.equal(leftHeads.get(day).revision, 42);
      const { run_id: leftRun, ...leftRow } = leftHeads.get(day);
      const { run_id: rightRun, ...rightRow } = rightHeads.get(day);
      assert.notEqual(leftRun, rightRun);
      assert.deepEqual(leftRow, rightRow, "same sources, --now and seed give byte-identical heads");
    }
    await setUsage(pool, left.schema, OWNER_A, DAY_1, 4);
    await runJob({ schema: left.schema, seed: 0, now: NOW_2 });
    assert.equal((await publishedRows(pool, left.schema)).get(DAY_1).revision, 43);
    await setUsage(pool, left.schema, OWNER_A, DAY_1, 5);
    await runJob({ schema: left.schema, seed: 100, now: NOW_3 });
    const bumped = (await publishedRows(pool, left.schema)).get(DAY_1);
    assert.equal(bumped.revision, 101);
    assert.equal(bumped.payload.aggregateId, `community-daily:${DAY_1}:r101`);
    assert.equal(bumped.released_at, NOW_3);
  });
});

test("PG17 REV-SEED: a day continues above its revision floor, a day without one starts at r1, a rerun mints nothing", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("floor", async ({ pool, createSchema }) => {
    const floored = await createSchema();
    const twin = await createSchema();
    const bare = await createSchema();
    for (const { schema } of [floored, twin]) await loadSpecFloor(pool, schema, { [DAY_1]: 5, [DAY_3]: 2 });
    const receipts = [];
    for (const { schema } of [floored, twin, bare]) {
      await seedBaseCorpus(pool, schema);
      receipts.push(await runJob({ schema }));
    }
    assert.deepEqual(receipts[0].revisionFloor, { present: true, dayCount: 2, maxRevision: 5 });
    assert.deepEqual(receipts[2].revisionFloor, { present: false, dayCount: 0, maxRevision: 0 },
      "a test target publishes with an absent floor as 0");
    const heads = await publishedRows(pool, floored.schema);
    // Cloudflare's r5 continues at r6; a day it never published starts at r1.
    assert.deepEqual([DAY_1, DAY_2, DAY_3].map((day) => heads.get(day).revision), [6, 1, 3]);
    for (const day of [DAY_1, DAY_2, DAY_3]) {
      const head = heads.get(day);
      assert.equal(head.payload.revision, head.revision);
      assert.equal(head.payload.aggregateId, `community-daily:${day}:r${head.revision}`);
    }
    const bareHeads = await publishedRows(pool, bare.schema);
    assert.deepEqual([DAY_1, DAY_2, DAY_3].map((day) => bareHeads.get(day).revision), [1, 1, 1],
      "without a floor, full-mode revisions are exactly what they were");
    // The same prior state, floor, --now and seed give byte-identical heads.
    const twinHeads = await publishedRows(pool, twin.schema);
    for (const day of [DAY_1, DAY_2, DAY_3]) {
      const { run_id: _left, ...left } = heads.get(day);
      const { run_id: _right, ...right } = twinHeads.get(day);
      assert.deepEqual(left, right, day);
    }
    // A rerun over unchanged sources mints no revision; a change mints head + 1.
    const before = await analyticsSnapshot(pool, floored.schema);
    const rerun = await runJob({ schema: floored.schema, now: NOW_2 });
    assert.deepEqual(rerun.published, []);
    const after = await analyticsSnapshot(pool, floored.schema);
    assert.equal(after.analytics_v2_published_daily, before.analytics_v2_published_daily);
    await setUsage(pool, floored.schema, OWNER_A, DAY_1, 4);
    await runJob({ schema: floored.schema, now: NOW_3 });
    assert.equal((await publishedRows(pool, floored.schema)).get(DAY_1).revision, 7);
  });
});

test("PG17 REV-SEED: the floor and the revision seed combine as max(head, floor, seed) + 1", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("floor-seed", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await loadSpecFloor(pool, schema, { [DAY_1]: 5 });
    await seedBaseCorpus(pool, schema);
    await runJob({ schema, seed: 3 });
    let heads = await publishedRows(pool, schema);
    assert.deepEqual([DAY_1, DAY_2, DAY_3].map((day) => heads.get(day).revision), [6, 4, 4]);
    await setUsage(pool, schema, OWNER_A, DAY_1, 4);
    await setUsage(pool, schema, OWNER_B, DAY_2, 8);
    await runJob({ schema, seed: 10, now: NOW_2 });
    heads = await publishedRows(pool, schema);
    assert.deepEqual([DAY_1, DAY_2].map((day) => heads.get(day).revision), [11, 11]);
    // The one computation every publishing path uses.
    assert.equal(store.nextPublishedRevision({ head: 6, floor: 5, seed: 3 }), 7);
    assert.equal(store.nextPublishedRevision({ head: null, floor: 9, seed: 0 }), 10);
    assert.equal(store.nextPublishedRevision({ head: undefined, floor: undefined, seed: 0 }), 1);
    assert.throws(() => store.nextPublishedRevision({ head: -1, seed: 0 }), { code: "ANALYTICS_V2_STATE_INVALID" });
    assert.throws(() => store.nextPublishedRevision({ floor: 1.5, seed: 0 }), { code: "ANALYTICS_V2_STATE_INVALID" });
  });
});

// ---------------------------------------------------------------------------
// (d) concurrency
// ---------------------------------------------------------------------------

test("PG17 (d): of two concurrent invocations one completes and the other exits LOCK_HELD writing nothing", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("lock", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    let releaseGate;
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
    let signalHeld;
    const held = new Promise((resolveHeld) => { signalHeld = resolveHeld; });
    const base = createSpecPipeline();
    const gated = {
      async read(context) {
        signalHeld();
        await gate;
        return base.read(context);
      },
      compute: base.compute,
    };
    const first = runJob({ schema, pipeline: gated });
    await held;
    const before = await analyticsSnapshot(pool, schema);
    let secondPoolCreated = false;
    const second = await runJob({
      schema,
      createPool: (database) => {
        secondPoolCreated = true;
        return jobPool(database);
      },
    });
    assert.equal(secondPoolCreated, true);
    assert.equal(second.status, "ok");
    assert.equal(second.state, "LOCK_HELD");
    assert.equal(second.runId, undefined);
    assert.deepEqual(await analyticsSnapshot(pool, schema), before, "the LOCK_HELD invocation wrote nothing");
    releaseGate();
    const completed = await first;
    assert.equal(completed.state, "complete");
    assert.deepEqual(completed.published, [DAY_1, DAY_2, DAY_3]);
    assert.equal(await count(pool, schema, "analytics_v2_runs"), 1);
    // The lock was released: a later run acquires it.
    assert.equal((await runJob({ schema })).state, "complete");
  });
});

test("PG17: the store refuses to write without the refresh lock when another session holds it", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("store-lock", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const holder = await pool.connect();
    const writer = await pool.connect();
    try {
      const lock = await holder.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [contract.ANALYTICS_V2_REFRESH_LOCK_KEY]);
      assert.equal(lock.rows[0].acquired, true);
      const before = await analyticsSnapshot(pool, schema);
      await assert.rejects(store.writeRunOutputs(writer, minimalOutputs(), {
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon: STAND_IN_HORIZON, stamp: specStamp,
        exclusionsSha256: NO_EXCLUSIONS,
      }), { code: "ANALYTICS_V2_REFRESH_LOCK_NOT_HELD" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [contract.ANALYTICS_V2_REFRESH_LOCK_KEY]);
      holder.release();
      writer.release();
    }
  });
});

/** K-PERCARD's migration text, staged or promoted (found by its name suffix). */
async function priceMigrationSql() {
  for (const directory of [join(WORKER_ROOT, "postgres", "staged-migrations", "primary"), PRIMARY_MIGRATIONS_DIRECTORY]) {
    const name = (await readdir(directory).catch(() => [])).find((entry) => /^\d{4}_analytics_v2_price_cards\.sql$/u.test(entry));
    if (name !== undefined) return readFile(join(directory, name), "utf8");
  }
  throw new Error("the analytics_v2_price_cards migration is neither staged nor promoted");
}

function minimalOutputs(overrides = {}) {
  const nowMs = Date.parse(NOW_1);
  const outputs = {
    contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION,
    mode: "full",
    nowMs,
    today: utcDay(nowMs),
    revisionSeed: 0,
    owners: [contractOwner(OWNER_A, "effective")],
    ownerDays: [],
    cacheBands: [],
    ownerFits: [],
    ownerModelDates: [],
    dailyCandidates: [],
    blockedDays: [],
    preview: null,
    refusals: [],
    journal: { lastSequence: null },
    timings: {},
    ...overrides,
  };
  // K-PERCARD: every owner-day with daily values carries its price row.
  return Object.hasOwn(overrides, "ownerDayPrices") ? outputs
    : { ...outputs, ownerDayPrices: emptyPriceRows(outputs.ownerDays) };
}

// ---------------------------------------------------------------------------
// (e) atomicity
// ---------------------------------------------------------------------------

test("PG17 (e): a throw injected after half the writes leaves no analytics_v2 change", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("atomic", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    assert.equal((await runJob({ schema })).state, "complete");
    await setUsage(pool, schema, OWNER_A, DAY_2, 50);
    await setUsage(pool, schema, OWNER_B, DAY_3, 0);
    const before = await analyticsSnapshot(pool, schema);

    const statements = [];
    const failingPool = (database) => {
      const real = jobPool(database);
      return {
        async connect() {
          const client = await real.connect();
          return {
            async query(text, values) {
              statements.push(text);
              if (/^\s*INSERT INTO "[^"]+"\."analytics_v2_published_daily"/u.test(text)) {
                throw Object.assign(new Error("injected failure"), { code: "XX000" });
              }
              return client.query(text, values);
            },
            release: (discard) => client.release(discard),
          };
        },
        end: () => real.end(),
      };
    };
    await assert.rejects(runJob({ schema, now: NOW_2, createPool: failingPool }), (error) => {
      assert.equal(error.code, "ANALYTICS_V2_WRITE_FAILED");
      assert.equal(error.phase, "write");
      assert.equal(error.sqlState, "XX000");
      assert.doesNotMatch(error.message, /injected/u);
      return true;
    });
    const deletes = statements.filter((text) => /^DELETE FROM/u.test(text.trim()));
    const ownerInserts = statements.filter((text) =>
      /INSERT INTO "[^"]+"\."analytics_v2_(?:owner_day|cache_bands|owner_fits|owner_model_dates)"/u.test(text));
    assert.equal(deletes.length, 4, "the owner families were deleted before the injected throw");
    assert.equal(ownerInserts.length, 4, "and re-inserted before the injected throw");
    assert.deepEqual(await analyticsSnapshot(pool, schema), before, "no analytics_v2 row changed");

    // The failed run released the lock; the next run publishes both changed days.
    const recovered = await runJob({ schema, now: NOW_3 });
    assert.equal(recovered.state, "complete");
    assert.deepEqual(recovered.published, [DAY_2, DAY_3]);
  });
});

test("PG17: the store refuses invalid outputs before writing", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("store-validate", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    try {
      const before = await analyticsSnapshot(pool, schema);
      const payload = { day: DAY_1, totals: { usageEvents: 1 } };
      const good = await store.analyticsV2DailyContentSha256(payload);
      const write = (outputs, options = {}) => store.writeRunOutputs(client, outputs, {
        schema, runId: randomUUID(), startedAtMs: Date.now(), expectedCursor: null, horizon: STAND_IN_HORIZON, stamp: specStamp,
        exclusionsSha256: NO_EXCLUSIONS,
        ...options,
      });
      await assert.rejects(write(minimalOutputs({
        dailyCandidates: [{ day: DAY_1, payload, payloadSha256: "0".repeat(64) }],
      })), { code: "ANALYTICS_V2_DAILY_DIGEST_MISMATCH" });
      await assert.rejects(write(minimalOutputs({
        dailyCandidates: [{ day: DAY_1, payload, payloadSha256: good }],
        blockedDays: [DAY_1],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "dailyCandidates.day" });
      await assert.rejects(write(minimalOutputs({
        ownerDays: [{ ownerDigest: OWNER_B, day: DAY_1, daily: {}, refusal: null }],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.ownerDigest" });
      // A cache-only reason is a closed reason, but never an owner-day refusal:
      // the store refuses it before 0059's CHECK would.
      await assert.rejects(write(minimalOutputs({
        ownerDays: [{ ownerDigest: OWNER_A, day: DAY_1, daily: null, refusal: "group_limit_exceeded" }],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.refusal" });
      await assert.rejects(write(minimalOutputs({
        ownerFits: [{ ownerDigest: OWNER_A, asOfDay: DAY_1, fits: new Map() }],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerFits.fits" });
      await assert.rejects(write(minimalOutputs({
        ownerModelDates: [{ ownerDigest: OWNER_A, day: DAY_1, result: { value: Number.NaN } }],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerModelDates.result" });
      await assert.rejects(write(minimalOutputs({ today: DAY_1 })),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "today" });
      await assert.rejects(write(minimalOutputs({
        refusals: [{ ownerDigest: OWNER_A, day: null, family: "owner", reason: "made_up" }],
      })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "refusals.reason" });
      await assert.rejects(write(minimalOutputs(), { expectedCursor: "3" }), { code: "ANALYTICS_V2_CURSOR_MOVED" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
      assert.equal((await client.query("SELECT 1 AS ok")).rows[0].ok, 1, "the client left no open transaction");

      // A journal cursor that would move backwards is refused atomically.
      assert.equal((await write(minimalOutputs({ journal: { lastSequence: 9 } }))).cursor, "9");
      const afterFirst = await analyticsSnapshot(pool, schema);
      await assert.rejects(write(minimalOutputs({ journal: { lastSequence: 8 } }), { expectedCursor: "9" }),
        { code: "ANALYTICS_V2_CURSOR_REGRESSION" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), afterFirst);
      assert.equal((await write(minimalOutputs({ journal: { lastSequence: null } }), { expectedCursor: "9" })).cursor,
        "9", "an absent journal position keeps the cursor");
    } finally {
      client.release();
    }
  });
});

test("the store's resource record is closed and agrees with the owner refusals; a refused owner writes nothing", async () => {
  // Validation only (assertAnalyticsV2RunOutputs runs before any database work).
  const owners = [contractOwner(OWNER_A, "effective"), contractOwner(OWNER_B, "effective")];
  const configuration = { memoryModel: "analytics-v2-memory-model-v2", outputModel: "analytics-v2-output-model-v1",
    memoryBudgetBytes: 1_073_741_824, maxDayOccurrences: 250_000, maxDayRecordBytes: 268_435_456,
    outputBudgetBytes: 67_108_864 };
  const entry = (ownerDigest, admitted) => ({ ownerDigest, usage: 3, quota: 2, session: 1, analysisUsage: 3,
    maxDayOccurrences: 6, estimateBytes: 134_217_728, admitted, heapPeakBytes: admitted ? 1_000 : null,
    outputBytes: 500 });
  const account = { heldInputBytes: 100, accountBytes: 2_000, outputBudgetBytes: 67_108_864 };
  const ordered = [OWNER_A, OWNER_B].sort();
  const refusedB = [{ ownerDigest: OWNER_B, day: null, family: "owner", reason: "memory_budget" },
    { ownerDigest: OWNER_B, day: DAY_1, family: "daily", reason: "memory_budget" }];
  const outputs = (overrides = {}) => minimalOutputs({ owners, refusals: refusedB, blockedDays: [DAY_1],
    resources: { configuration, account, owners: ordered.map((digest) => entry(digest, digest !== OWNER_B)) }, ...overrides });
  const check = (value) => store.assertAnalyticsV2RunOutputs(value, STAND_IN_HORIZON);
  await check(outputs());
  await check(outputs({ resources: undefined }));
  // The refused owner is not computed: no owner-scoped row may name it.
  await assert.rejects(check(outputs({ ownerDays: [{ ownerDigest: OWNER_B, day: DAY_1, daily: {}, refusal: null }] })),
    { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.ownerDigest" });
  await assert.rejects(check(outputs({ ownerFits: [{ ownerDigest: OWNER_B, asOfDay: DAY_1, fits: [] }] })),
    { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerFits.ownerDigest" });
  // memory_budget is owner-only: never an owner-day refusal.
  await assert.rejects(check(outputs({ ownerDays: [{ ownerDigest: OWNER_A, day: DAY_1, daily: null,
    refusal: "memory_budget" }] })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.refusal" });
  // `admitted` must be false exactly for the owners refused as a whole.
  await assert.rejects(check(outputs({ resources: { configuration, account,
    owners: ordered.map((digest) => entry(digest, true)) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners.admitted" });
  await assert.rejects(check(outputs({ refusals: [] })),
    { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners.admitted" });
  // Closed shapes: no extra key, one entry per effective owner in digest order, no heap for a refused owner.
  await assert.rejects(check(outputs({ resources: { configuration: { ...configuration, extra: 1 }, account,
    owners: ordered.map((digest) => entry(digest, digest !== OWNER_B)) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.configuration" });
  await assert.rejects(check(outputs({ resources: { configuration, account,
    owners: [...ordered].reverse().map((digest) => entry(digest, digest !== OWNER_B)) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners.ownerDigest" });
  await assert.rejects(check(outputs({ resources: { configuration, account,
    owners: ordered.filter((digest) => digest === OWNER_A).map((digest) => entry(digest, true)) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners" });
  await assert.rejects(check(outputs({ resources: { configuration, account, owners: ordered.map((digest) =>
    ({ ...entry(digest, digest !== OWNER_B), heapPeakBytes: 5 })) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners.heapPeakBytes" });
  await assert.rejects(check(outputs({ resources: { configuration, account, owners: ordered.map((digest) =>
    ({ ...entry(digest, digest !== OWNER_B), contentHint: "x" })) } })),
  { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "resources.owners" });
  // The output account: closed, and never smaller than the owners' outputs plus the held inputs.
  const owned = ordered.map((digest) => entry(digest, digest !== OWNER_B));
  for (const [value, field] of [
    [{ configuration, owners: owned }, "resources"],
    [{ configuration, owners: owned, account, extra: 1 }, "resources"],
    [{ configuration, owners: owned, account: { ...account, extra: 1 } }, "resources.account"],
    [{ configuration, owners: owned, account: { ...account, heldInputBytes: 100, accountBytes: 1_099 } },
      "resources.account"],
    [{ configuration, owners: owned, account: { ...account, heldInputBytes: 3_000, accountBytes: 2_000 } },
      "resources.account"],
    [{ configuration, owners: owned, account: { ...account, heldInputBytes: -1, accountBytes: 2_000 } },
      "resources.account.heldInputBytes"],
    // The budget the account was held to: present, an integer, never below the
    // account, and either the configured one or that plus the memory budget
    // less the largest admitted estimate (A's 128 MiB; B is refused).
    [{ configuration, owners: owned, account: { heldInputBytes: 100, accountBytes: 2_000 } }, "resources.account"],
    [{ configuration, owners: owned, account: { ...account, outputBudgetBytes: 1.5 } },
      "resources.account.outputBudgetBytes"],
    [{ configuration, owners: owned, account: { ...account, outputBudgetBytes: 1_999 } },
      "resources.account.outputBudgetBytes"],
    [{ configuration, owners: owned, account: { ...account, outputBudgetBytes: 67_108_865 } },
      "resources.account.outputBudgetBytes"],
    [{ configuration, owners: owned, account: { ...account, outputBudgetBytes: 67_108_864 + 1_073_741_824 } },
      "resources.account.outputBudgetBytes"],
    [{ configuration, owners: owned.map((value) => ({ ...value, estimateBytes: 1_073_741_825 })),
      account: { ...account, outputBudgetBytes: 67_108_864 + 1_073_741_824 - 1_073_741_825 } },
    "resources.account.outputBudgetBytes"],
    [{ configuration: { ...configuration, outputModel: "x" }, owners: owned, account }, "resources.configuration"],
    [{ configuration: { ...configuration, outputBudgetBytes: 0 }, owners: owned, account },
      "resources.configuration.outputBudgetBytes"],
    [{ configuration, owners: owned.map((value) => ({ ...value, outputBytes: -1 })), account }, "resources.owners.outputBytes"],
  ]) {
    await assert.rejects(check(outputs({ resources: value })), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field }, field);
  }
  await check(outputs({ resources: { configuration, owners: owned,
    account: { ...account, heldInputBytes: 100, accountBytes: 1_100 } } }));
  // A run that reclaimed the unused per-owner budget: configured + budget - largest admitted estimate.
  await check(outputs({ resources: { configuration, owners: owned,
    account: { ...account, outputBudgetBytes: 67_108_864 + 1_073_741_824 - 134_217_728 } } }));
});

test("PG17: bulk owner families are written in bounded chunks with exact row counts", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("chunks", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    try {
      const cacheBands = [];
      for (let offset = 0; offset < 30; offset += 1) {
        const day = new Date(Date.parse("2026-09-01T00:00:00.000Z") + offset * 86_400_000).toISOString().slice(0, 10);
        for (const model of ["model-a", "model-b"]) {
          for (let effort = 0; effort < 10; effort += 1) {
            for (const band of store.ANALYTICS_V2_CACHE_BANDS) {
              cacheBands.push({
                ownerDigest: OWNER_A, day, model, effort: `effort-${effort}`, band,
                counters: {
                  adjacencies: 2, reused_more_than_half: 1, matched_or_exceeded: 1, unordered_ties: 0,
                  excluded_insufficient_evidence: 0, excluded_context_contracted: 0, sessions: 1,
                },
              });
            }
          }
        }
      }
      assert.equal(cacheBands.length, 6_000, "more than one 5,000-row chunk");
      const statements = [];
      const counting = {
        query: (text, values) => { statements.push(text); return client.query(text, values); },
        release: () => {},
      };
      const receipt = await store.writeRunOutputs(counting, minimalOutputs({ cacheBands }), {
        schema, runId: randomUUID(), startedAtMs: Date.now(), expectedCursor: null, horizon: STAND_IN_HORIZON, stamp: specStamp,
        exclusionsSha256: NO_EXCLUSIONS,
      });
      assert.equal(receipt.state, "complete");
      assert.equal(await count(pool, schema, "analytics_v2_cache_bands"), 6_000);
      assert.equal(statements.filter((text) => /INSERT INTO "[^"]+"\."analytics_v2_cache_bands"/u.test(text)).length, 2);
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// (f) the test clock
// ---------------------------------------------------------------------------

test("(f) --now is refused without the test-clock flag, before any database work", async () => {
  let poolCreated = false;
  const env = jobEnvironment();
  delete env.ANALYTICS_V2_TEST_CLOCK;
  await assert.rejects(job.runAnalyticsRefresh({
    argv: ["--mode=full", "--schema=analytics_v2_refresh_unused", `--now=${NOW_1}`],
    env,
    dependencies: { createPool: () => { poolCreated = true; throw new Error("unreachable"); } },
  }), { code: "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN", usage: true });
  assert.equal(poolCreated, false);
  for (const refused of [{ ANALYTICS_V2_TEST_CLOCK: "true" }, { ANALYTICS_V2_TEST_CLOCK: "0" },
    { POSTGRES_TEST_HTTP_MODE: "production" }, { POSTGRES_TEST_HTTP_MODE: "" },
    // The retired cloud-run-iam host mode (OD-6) no longer allows a test clock.
    { POSTGRES_TEST_HTTP_MODE: "cloud-run-iam" }]) {
    assert.throws(() => job.parseAnalyticsRefreshArguments(["--mode=full", "--schema=s", `--now=${NOW_1}`], refused),
      { code: "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN" });
  }
  for (const allowed of [{ ANALYTICS_V2_TEST_CLOCK: "1" }, { POSTGRES_TEST_HTTP_MODE: "fastpath-test" },
    { POSTGRES_TEST_HTTP_MODE: "health-only" }]) {
    assert.equal(job.parseAnalyticsRefreshArguments(["--mode=full", "--schema=s", `--now=${NOW_1}`], allowed).nowMs,
      Date.parse(NOW_1));
  }
  assert.equal(job.parseAnalyticsRefreshArguments(["--mode=full", "--schema=s"], {}).nowMs, null);
  for (const argv of [["--schema=s"], ["--mode=memo", "--schema=s"], ["--mode=full"],
    ["--mode=full", "--schema=pg_catalog"], ["--mode=full", "--schema=s", "--schema=t"],
    ["--mode=full", "--schema=s", "--revision-seed=-1"], ["--mode=full", "--schema=s", "--unknown=1"],
    ["--mode=full", "--schema=s", "--now=2026-10-01"]]) {
    assert.throws(() => job.parseAnalyticsRefreshArguments(argv, { ANALYTICS_V2_TEST_CLOCK: "1" }),
      (error) => error.usage === true && /^ANALYTICS_V2_/u.test(error.code), argv.join(" "));
  }
});

const NODE_22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");

test("the source entry runs --help and refuses --now under Node v22.16.0", async () => {
  const binary = NODE_22;
  await access(binary);
  const version = await execFileAsync(binary, ["--version"]);
  assert.equal(version.stdout.trim(), "v22.16.0");
  const help = await execFileAsync(binary, [JOB_PATH, "--help"], { cwd: WORKER_ROOT, env: { PATH: process.env.PATH } });
  assert.match(help.stdout, /^Usage: node analytics-refresh\.mjs --mode=full/u);
  assert.equal(help.stderr, "");
  await assert.rejects(execFileAsync(binary, [JOB_PATH, "--mode=full", "--schema=s", `--now=${NOW_1}`], {
    cwd: WORKER_ROOT,
    env: { PATH: process.env.PATH },
  }), (error) => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.deepEqual(JSON.parse(error.stderr), {
      schemaVersion: job.ANALYTICS_REFRESH_RECEIPT_VERSION,
      status: "failed",
      code: "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN",
      phase: "configuration",
    });
    return true;
  });
});

test("database targets: Cloud Run reaches only the private test primary; local needs loopback or a private socket", async () => {
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({}), { code: "ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED" });
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ PG_TEST_HOST: "10.0.0.5" }),
    { code: "ANALYTICS_V2_REFRESH_DATABASE_INVALID" });
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ PG_TEST_SOCKET: "/tmp/socket" }),
    { code: "ANALYTICS_V2_REFRESH_DATABASE_INVALID" });
  const local = await job.resolveAnalyticsRefreshDatabase({ PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "55433" });
  assert.deepEqual({ ...local }, { kind: "local", host: "127.0.0.1", port: 55433, user: "postgres", database: "postgres" });
  const cloud = {
    CLOUD_RUN_JOB: "analytics-refresh",
    PRIMARY_INSTANCE_CONNECTION_NAME: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    PRIMARY_DATABASE: "tibotattle",
    POSTGRES_IAM_USER: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
  };
  assert.equal((await job.resolveAnalyticsRefreshDatabase(cloud)).kind, "cloud-sql");
  for (const change of [{ PRIMARY_INSTANCE_CONNECTION_NAME: "tibotattle:us-east1:tibotattle-production" },
    { PRIMARY_DATABASE: "postgres" }, { POSTGRES_IAM_USER: "someone-else@tibotattle.iam" }]) {
    await assert.rejects(job.resolveAnalyticsRefreshDatabase({ ...cloud, ...change }),
      { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" });
  }
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ ...cloud, K_SERVICE: "tibotattle-test-app" }),
    { code: "ANALYTICS_V2_REFRESH_CONTEXT_INVALID" });

  // The fast-path refresh Job alone reaches the disposable tibotattle_fastpath
  // database, and only for the pinned or a seeded fast-path schema.
  const fastpath = { ...cloud, CLOUD_RUN_JOB: "tibotattle-fastpath-test-analytics-refresh",
    PRIMARY_DATABASE: "tibotattle_fastpath" };
  for (const schema of ["tibotattle_fastpath_20261001", "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d"]) {
    assert.deepEqual({ ...await job.resolveAnalyticsRefreshDatabase(fastpath, { schema }) }, {
      kind: "cloud-sql", instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
      database: "tibotattle_fastpath", iamUser: "tibotattle-test-runtime@tibotattle.iam",
    });
  }
  for (const schema of [undefined, "tibotattle_v12_a2_20260925", "tibotattle_fastpath_other",
    "typed_legacy_transfer_rehearsal_target_other", "public"]) {
    await assert.rejects(job.resolveAnalyticsRefreshDatabase(fastpath, { schema }),
      { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" }, String(schema));
  }
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ ...fastpath, PRIMARY_DATABASE: "tibotattle" },
    { schema: "tibotattle_fastpath_20261001" }), { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" });
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ ...cloud, PRIMARY_DATABASE: "tibotattle_fastpath" },
    { schema: "tibotattle_fastpath_20261001" }), { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" },
  "another Job never reaches the fast-path database");
  await assert.rejects(job.resolveAnalyticsRefreshDatabase({ ...fastpath, POSTGRES_IAM_USER: "someone-else@tibotattle.iam" },
    { schema: "tibotattle_fastpath_20261001" }), { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" });
});

// ---------------------------------------------------------------------------
// (g) blocked conflict days
// ---------------------------------------------------------------------------

test("PG17 (g): a blocked conflict day keeps its prior row, stays pending, and is absent on a fresh start", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("blocked", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    await runJob({ schema });
    const heads1 = await publishedRows(pool, schema);

    // DAY_2 gains a conflicting owner-day while its usage also changes.
    await setUsage(pool, schema, OWNER_A, DAY_2, 99, { conflict: true });
    await setUsage(pool, schema, OWNER_B, DAY_3, 13);
    const blockedRun = await runJob({ schema, now: NOW_2 });
    assert.deepEqual(blockedRun.blocked, [DAY_2]);
    assert.deepEqual(blockedRun.published, [DAY_3]);
    assert.deepEqual(blockedRun.refusalsByReason, { non_effective_source_unported: 1, source_conflict_or_order: 1 });
    const heads2 = await publishedRows(pool, schema);
    assert.deepEqual(heads2.get(DAY_2), heads1.get(DAY_2), "the blocked day keeps its prior row exactly");
    assert.equal(heads2.get(DAY_3).revision, 2);
    const runs = await runRows(pool, schema);
    assert.deepEqual(runs.at(-1).publication, { published: [DAY_3], unchanged: [], blocked: [DAY_2] });
    assert.deepEqual(runs.at(-1).refusals.filter((refusal) => refusal.family === "daily"),
      [{ ownerDigest: OWNER_A, day: DAY_2, family: "daily", reason: "source_conflict_or_order" }]);
    const refusedDay = await pool.query(`SELECT daily, refusal FROM ${quoted(schema, "analytics_v2_owner_day")}
      WHERE owner_digest = $1 AND day = $2`, [OWNER_A, DAY_2]);
    assert.deepEqual(refusedDay.rows, [{ daily: null, refusal: "source_conflict_or_order" }]);

    // The conflict resolves with no new journal event: the carried day is still pending.
    await setUsage(pool, schema, OWNER_A, DAY_2, 99, { journal: false });
    const resumed = await runJob({ schema, now: NOW_3 });
    assert.deepEqual(resumed.blocked, []);
    assert.deepEqual(resumed.published, [DAY_2]);
    const heads3 = await publishedRows(pool, schema);
    assert.equal(heads3.get(DAY_2).revision, 2);
    assert.equal(heads3.get(DAY_2).payload.totals.usageEvents, 106);
    assert.deepEqual(heads3.get(DAY_1), heads1.get(DAY_1));

    // Fresh start: a day blocked on its first run has no row at all.
    const fresh = await createSchema();
    await seedBaseCorpus(pool, fresh.schema);
    await setUsage(pool, fresh.schema, OWNER_B, DAY_3, 11, { conflict: true });
    const freshRun = await runJob({ schema: fresh.schema });
    assert.deepEqual(freshRun.published, [DAY_1, DAY_2]);
    assert.deepEqual(freshRun.blocked, [DAY_3]);
    assert.equal((await publishedRows(pool, fresh.schema)).has(DAY_3), false);
    // Queue semantics: the blocked day was not consumed with the cursor, so it
    // publishes once its conflict resolves, with no new journal event.
    await setUsage(pool, fresh.schema, OWNER_B, DAY_3, 11, { journal: false });
    const carried = await runJob({ schema: fresh.schema, now: NOW_2 });
    assert.deepEqual(carried.published, [DAY_3]);
    assert.deepEqual(carried.blocked, []);
    assert.equal((await publishedRows(pool, fresh.schema)).get(DAY_3).revision, 1);
  });
});

// ---------------------------------------------------------------------------
// Full-mode owner replacement and the read snapshot
// ---------------------------------------------------------------------------

test("PG17: a full run replaces only computed owners' families; absent owners' rows and untouched heads are retained", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("retain", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    const first = await runJob({ schema });
    const heads1 = await publishedRows(pool, schema);
    const ownerTables = ["analytics_v2_owner_day", "analytics_v2_cache_bands", "analytics_v2_owner_fits",
      "analytics_v2_owner_model_dates"];
    const ownerRows = async (ownerDigest) => {
      const rows = {};
      for (const table of ownerTables) {
        rows[table] = (await pool.query(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS rows
             FROM ${quoted(schema, table)} t WHERE owner_digest = $1`, [ownerDigest])).rows[0].rows;
      }
      return rows;
    };
    const ownerB1 = await ownerRows(OWNER_B);
    for (const table of ownerTables) assert.notEqual(ownerB1[table], "[]", table);

    // OWNER_B leaves the roster (opt-out, disconnect, expiry): no journal event.
    await pool.query(`DELETE FROM ${quoted(schema, "spec_source_usage")} WHERE owner_digest = $1`, [OWNER_B]);
    const receipt = await runJob({ schema, now: NOW_2 });
    assert.equal(receipt.state, "complete");
    assert.equal(receipt.owners, 2);
    assert.equal(receipt.retainedOwners, 1);
    assert.deepEqual(receipt.published, [], "no head is recomputed without a queued day");
    assert.deepEqual(await ownerRows(OWNER_B), ownerB1, "the absent owner's rows are retained exactly");
    for (const table of ownerTables) {
      const runIds = await pool.query(`SELECT DISTINCT run_id::text AS run_id FROM ${quoted(schema, table)}
        WHERE owner_digest = $1`, [OWNER_A]);
      assert.deepEqual(runIds.rows.map((row) => row.run_id), [receipt.runId], `${table}: computed owner replaced`);
    }
    assert.deepEqual(await publishedRows(pool, schema), heads1, "published history is not rewritten");

    // A later journal event re-queues DAY_3: that day alone is recomputed from
    // the current roster (production's queue semantics).
    await setUsage(pool, schema, OWNER_A, DAY_3, 4);
    const requeued = await runJob({ schema, now: NOW_3 });
    assert.deepEqual(requeued.published, [DAY_3]);
    const heads3 = await publishedRows(pool, schema);
    assert.deepEqual(heads3.get(DAY_1), heads1.get(DAY_1));
    assert.deepEqual(heads3.get(DAY_2), heads1.get(DAY_2));
    assert.equal(heads3.get(DAY_3).revision, 2);
    assert.equal(heads3.get(DAY_3).payload.totals.usageEvents, 4);
    assert.deepEqual(await ownerRows(OWNER_B), ownerB1);
    assert.notEqual(first.runId, requeued.runId);
  });
});

test("PG17: the store replaces computed owners' rows only inside the run horizon and reports the cache floor", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("horizon", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    try {
      const counters = (adjacencies) => ({
        adjacencies, reused_more_than_half: 1, matched_or_exceeded: 1, unordered_ties: 0,
        excluded_insufficient_evidence: 0, excluded_context_contracted: 0, sessions: 1,
      });
      const band = (day, adjacencies) => ({
        ownerDigest: OWNER_A, day, model: "model-a", effort: "high", band: "under_one_minute",
        counters: counters(adjacencies),
      });
      const ownerDay = (day, usageEvents) => ({ ownerDigest: OWNER_A, day, daily: { usageEvents }, refusal: null });
      const write = (outputs, horizon) => store.writeRunOutputs(client, minimalOutputs(outputs), {
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon, stamp: specStamp,
        exclusionsSha256: NO_EXCLUSIONS,
      });
      const state0 = await store.readAnalyticsV2RefreshState(client, { schema });
      assert.deepEqual({ ...state0 }, { cursor: null, carriedBlockedDays: [], cacheFloorDay: null,
        appliedExclusionsSha256: NO_EXCLUSIONS, publishedDays: [],
        revisionFloor: { present: false, dayCount: 0, maxRevision: 0 } });

      await write({
        ownerDays: [ownerDay("2026-03-01", 1), ownerDay("2026-09-28", 2)],
        cacheBands: [band("2026-03-01", 3), band("2026-09-28", 4)],
      }, { ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
      const state1 = await store.readAnalyticsV2RefreshState(client, { schema });
      assert.equal(state1.cacheFloorDay, "2026-03-01");

      // A later horizon recomputes 2026-09-28 only; the older rows are retained.
      const receipt = await write({
        ownerDays: [ownerDay("2026-09-28", 5)],
        cacheBands: [band("2026-09-28", 6)],
      }, { ownerDayFromDay: "2026-09-01", cacheBandsFromDay: "2026-09-08" });
      assert.equal(receipt.retainedOwners, 0);
      const days = await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, daily
        FROM ${quoted(schema, "analytics_v2_owner_day")} ORDER BY day`);
      assert.deepEqual(days.rows, [
        { day: "2026-03-01", daily: { usageEvents: 1 } },
        { day: "2026-09-28", daily: { usageEvents: 5 } },
      ]);
      const bands = await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, adjacencies::integer AS adjacencies
        FROM ${quoted(schema, "analytics_v2_cache_bands")} ORDER BY day`);
      assert.deepEqual(bands.rows, [{ day: "2026-03-01", adjacencies: 3 }, { day: "2026-09-28", adjacencies: 6 }]);
      assert.equal((await store.readAnalyticsV2RefreshState(client, { schema })).cacheFloorDay, "2026-03-01");

      // Rows outside the horizon, rows of an owner the run did not compute and
      // a missing horizon are refused before any write.
      const before = await analyticsSnapshot(pool, schema);
      const horizon = { ownerDayFromDay: "2026-09-01", cacheBandsFromDay: "2026-09-08" };
      await assert.rejects(write({ cacheBands: [band("2026-09-07", 1)] }, horizon),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "cacheBands.day" });
      await assert.rejects(write({ ownerDays: [ownerDay("2026-08-31", 1)] }, horizon),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.day" });
      await assert.rejects(write({
        owners: [contractOwner(OWNER_A, "effective"), contractOwner(OWNER_LEGACY, "v0.2")],
        ownerDays: [{ ownerDigest: OWNER_LEGACY, day: "2026-09-28", daily: {}, refusal: null }],
      }, horizon), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "ownerDays.ownerDigest" });
      await assert.rejects(write({}, undefined), { code: "ANALYTICS_V2_RUN_INVALID", field: "horizon" });
      await assert.rejects(write({}, { ownerDayFromDay: "2026-02-30", cacheBandsFromDay: "2026-09-01" }),
        { code: "ANALYTICS_V2_RUN_INVALID", field: "horizon" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
    } finally {
      client.release();
    }
  });
});

test("PG17: a payload over the cap in its jsonb text form is refused with its own code, atomically", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("payload-size", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const client = await pool.connect();
    try {
      // Compact JSON stays under the cap; jsonb's text form (", " and ": ")
      // does not, and that is what 0059's CHECK measures.
      const payload = { day: DAY_1, cells: Array.from({ length: 17_800 }, (_, index) => ({ a: index % 10, b: 1 })) };
      const stampedBytes = Buffer.byteLength(JSON.stringify(store.stampAnalyticsV2DailyPayload(payload,
        { day: DAY_1, revision: 1, releasedAt: NOW_1 })));
      assert.ok(stampedBytes < store.ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES, `compact ${stampedBytes}`);
      const jsonbBytes = (await client.query("SELECT octet_length($1::jsonb::text) AS n",
        [JSON.stringify(payload)])).rows[0].n;
      assert.ok(jsonbBytes > store.ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES, `jsonb ${jsonbBytes}`);
      const before = await analyticsSnapshot(pool, schema);
      await assert.rejects(store.writeRunOutputs(client, minimalOutputs({
        dailyCandidates: [{ day: DAY_1, payload, payloadSha256: await store.analyticsV2DailyContentSha256(payload) }],
      }), {
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon: STAND_IN_HORIZON, stamp: specStamp,
        exclusionsSha256: NO_EXCLUSIONS,
      }), { code: "ANALYTICS_V2_DAILY_PAYLOAD_TOO_LARGE", field: "dailyCandidates.payload" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
      assert.equal((await client.query("SELECT 1 AS ok")).rows[0].ok, 1, "the client left no open transaction");
    } finally {
      client.release();
    }
  });
});

test("PG17: every reader shares the run's REPEATABLE READ snapshot across connections and cannot write", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("snapshot", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    let writeRefusal;
    const pipeline = createSpecPipeline({
      async betweenReads(readPool) {
        // Committed outside the snapshot after the first read: invisible to the second.
        await setUsage(pool, schema, OWNER_A, DAY_3, 2);
        const client = await readPool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`INSERT INTO ${quoted(schema, "spec_source_journal")} (sequence, day) VALUES (999, $1)`, [DAY_1]);
        } catch (error) {
          writeRefusal = error.code;
        } finally {
          await client.release();
        }
        await assert.rejects(readPool.connect().then(async (autocommit) => {
          try {
            return await autocommit.query(`DELETE FROM ${quoted(schema, "spec_source_usage")}`);
          } finally {
            await autocommit.release();
          }
        }), { code: "25006" });
      },
    });
    const first = await runJob({ schema, pipeline });
    assert.equal(writeRefusal, "25006", "a reader's write is refused (read-only transaction)");
    assert.deepEqual(first.published, [DAY_1, DAY_2, DAY_3]);
    assert.equal(first.cursor, "4", "the journal read did not see the event committed after the snapshot");
    assert.equal((await publishedRows(pool, schema)).get(DAY_3).payload.totals.usageEvents, 11);
    const second = await runJob({ schema, now: NOW_2 });
    assert.equal(second.cursor, "5");
    assert.deepEqual(second.published, [DAY_3]);
    assert.equal((await publishedRows(pool, schema)).get(DAY_3).payload.totals.usageEvents, 13);
  });
});

test("PG17: a leaked reader client is discarded, and outputs that ignore the run's flags are refused", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => {
  await withDatabase("leak", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    const base = createSpecPipeline();
    const leaky = {
      async read(context) {
        const leaked = await context.pool.connect();
        await leaked.query("BEGIN READ ONLY");
        return base.read(context);
      },
      async compute(inputs, flags) {
        return { ...(await base.compute(inputs, flags)), revisionSeed: flags.revisionSeed + 7 };
      },
    };
    const before = await analyticsSnapshot(pool, schema);
    await assert.rejects(runJob({ schema, pipeline: leaky }), (error) => {
      assert.equal(error.code, "ANALYTICS_V2_REFRESH_OUTPUTS_INCONSISTENT");
      assert.equal(error.phase, "compute");
      return true;
    });
    assert.deepEqual(await analyticsSnapshot(pool, schema), before);
    // The leaked snapshot client did not hold the pool open or the lock.
    assert.equal((await runJob({ schema })).state, "complete");
  });
});

// ---------------------------------------------------------------------------
// The default wiring (createAnalyticsV2Pipeline) over the A-1/A-2 shapes
// ---------------------------------------------------------------------------

const WIRING_NOW_MS = Date.parse(NOW_1);
const WIRING_OWNER_B = { participantId: "participant-wiring-b", ownerDigest: OWNER_B, hasV1: false, hasV11: true,
  hasV12: false, hasLegacy: false, hasEffective: false, source: "v1.1" };
const occurrence = (ownerDigest, day) => ({ ownerDigest, day, occurrenceId: `wiring-${day}` });

/**
 * Stub A-1 readers with the landed signatures, and A-2's real range helpers
 * around a recording computeAnalyticsV2. Evidence: OWNER_A (effective) on
 * 2026-03-02 and 2026-09-29, OWNER_B (v1.1, typed) on 2026-09-30.
 */
function wiringModules({ unlinked = [], failOwner = null, ownerAEvidence = ["2026-03-02", "2026-09-29"],
  exclusionRead = undefined } = {}) {
  const calls = { owners: 0, queued: [], occurrences: [], counts: [], firstEvidence: [], devices: [], compute: null,
    loaded: new Map(), exclusions: 0 };
  const evidence = new Map([[OWNER_A, ownerAEvidence], [OWNER_B, ["2026-09-30"]]]);
  const pages = new Map([
    [0, { days: ["2026-09-30"], lastSequence: 5, terminalOwners: [digest("terminal")], events: 5, complete: false }],
    [5, { days: ["2026-03-02", "2026-09-29"], lastSequence: 9, terminalOwners: [], events: 4, complete: true }],
  ]);
  return {
    calls,
    modules: {
      owners: {
        async listAnalyticsV2Owners(context) {
          assert.equal(arguments.length, 1);
          assert.equal(context.nowMs, WIRING_NOW_MS);
          calls.owners += 1;
          return { owners: [contractOwner(OWNER_LEGACY, "v0.2"), WIRING_OWNER_B, contractOwner(OWNER_A, "effective")],
            unlinked, correctionRuntimeActive: false };
        },
        async readAnalyticsV2Exclusions(context) {
          assert.equal(context.nowMs, WIRING_NOW_MS);
          calls.exclusions += 1;
          // Not given: the empty table. An explicit value, null included, is returned as is.
          return exclusionRead === undefined ? NO_EXCLUSION_READER.readAnalyticsV2Exclusions() : exclusionRead;
        },
      },
      queuedDays: {
        async readQueuedDays(context, options) {
          calls.queued.push(options.afterSequence);
          return pages.get(options.afterSequence);
        },
      },
      occurrences: {
        MAX_ANALYTICS_V2_OCCURRENCE_DAYS: 30,
        async readOwnerFirstEvidenceDay(context, options) {
          assert.equal(context.nowMs, WIRING_NOW_MS);
          calls.firstEvidence.push({ ...options });
          const days = (evidence.get(options.ownerDigest) ?? []).filter((day) => day <= options.throughDay).sort();
          return days[0] ?? null;
        },
        async countOwnerOccurrences(context, options) {
          assert.equal(context.nowMs, WIRING_NOW_MS);
          calls.counts.push({ ...options });
          if (options.ownerDigest === failOwner) {
            throw Object.assign(new Error("ANALYTICS_V2_SOURCE_CONFLICT"), { code: "ANALYTICS_V2_SOURCE_CONFLICT" });
          }
          const result = new Map();
          if (options.stream !== "usage") return result;
          for (const day of evidence.get(options.ownerDigest) ?? []) {
            if (day >= options.fromDay && day <= options.throughDay) result.set(day, 1);
          }
          return result;
        },
        async readOwnerOccurrences(context, options) {
          assert.equal(context.nowMs, WIRING_NOW_MS);
          calls.occurrences.push({ ...options });
          if (options.ownerDigest === failOwner) {
            throw Object.assign(new Error("ANALYTICS_V2_SOURCE_CONFLICT"), { code: "ANALYTICS_V2_SOURCE_CONFLICT" });
          }
          const result = new Map();
          if (options.stream !== "usage") return result;
          for (const day of evidence.get(options.ownerDigest) ?? []) {
            if (day >= options.fromDay && day <= options.throughDay) {
              result.set(day, [occurrence(options.ownerDigest, day)]);
            }
          }
          return result;
        },
      },
      devices: {
        async countContributingDevices(context, options) {
          calls.devices.push(new Map([...options.days].map(([day, owners]) => [day, owners.map((owner) => ({ ...owner }))])));
          return new Map([...options.days].map(([day, owners]) =>
            [day, new Map(owners.map((owner) => [owner.ownerDigest, 2]))]));
        },
      },
      compute: {
        ANALYTICS_V2_ANALYSIS_DAYS: a2.ANALYTICS_V2_ANALYSIS_DAYS,
        analyticsV2RequiredOccurrenceRange: a2.analyticsV2RequiredOccurrenceRange,
        async computeAnalyticsV2(input) {
          calls.compute = input;
          // As A-2 does: each effective owner is loaded once, in digest order.
          for (const owner of [...input.owners].sort((left, right) => (left.ownerDigest < right.ownerDigest ? -1 : 1))) {
            if (owner.source === "effective") {
              calls.loaded.set(owner.ownerDigest, await input.loadOwnerOccurrences(owner.ownerDigest));
            }
          }
          return {
            contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION, mode: "full", nowMs: input.nowMs,
            today: utcDay(input.nowMs), revisionSeed: input.revisionSeed, owners: input.owners, ownerDays: [],
            ownerDayPrices: [], cacheBands: [], ownerFits: [], ownerModelDates: [], preview: null, refusals: [], timings: {},
            dailyCandidates: input.queuedDays.filter((day) => day !== "2026-04-10")
              .map((day) => ({ day, payload: { day }, payloadSha256: "0".repeat(64) })),
            blockedDays: ["2026-04-10"],
            journal: { lastSequence: null },
          };
        },
      },
    },
  };
}

const WIRING_STATE = specState({ cursor: null, carriedBlockedDays: ["2026-04-10"], cacheFloorDay: "2026-02-20" });

function spannedDays(ranges) {
  const days = [];
  for (const { fromDay, throughDay } of ranges) {
    for (let day = fromDay; day <= throughDay;
      day = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)) days.push(day);
  }
  return days;
}

test("default wiring: A-1 shapes in, one contiguous A-2 range out, non-effective owners read on queued days only", async () => {
  const { calls, modules } = wiringModules();
  const pipeline = job.createAnalyticsV2Pipeline(modules);
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE });

  // The journal is read page by page from the cursor until complete.
  assert.deepEqual(calls.queued, [0, 5]);
  const queued = ["2026-03-02", "2026-04-10", "2026-09-29", "2026-09-30"];
  assert.deepEqual(inputs.queuedDays, queued, "journal days plus the carried blocked day; no published heads");
  // The first evidence day is read for the effective owner only, over the
  // whole history through today.
  assert.deepEqual(calls.firstEvidence, [{ ownerDigest: OWNER_A, throughDay: "2026-10-01" }]);
  assert.equal(inputs.firstEvidenceDay, "2026-03-02");
  // Cache history reaches the stored floor; the range is A-2's required range.
  assert.equal(inputs.cacheFromDay, "2026-02-20");
  const required = a2.analyticsV2RequiredOccurrenceRange({ nowMs: WIRING_NOW_MS, queuedDays: queued,
    cacheFromDay: "2026-02-20" });
  assert.deepEqual({ ...inputs.occurrenceRange }, required);
  assert.deepEqual(required, { fromDay: "2026-02-13", throughDay: "2026-10-01" });

  // The effective owner is counted, not read, during read: every stream over
  // the whole range, in contiguous chunks of at most 30 days.
  const rangeDays = spannedDays([required]);
  for (const stream of ["usage", "quota", "session"]) {
    const counts = calls.counts.filter((call) => call.ownerDigest === OWNER_A && call.stream === stream);
    assert.ok(counts.every((call) => spannedDays([call]).length <= 30));
    assert.deepEqual(spannedDays(counts), rangeDays, stream);
  }
  assert.equal(calls.occurrences.some((call) => call.ownerDigest === OWNER_A), false, "read only while computing");
  assert.equal(calls.counts.some((call) => call.ownerDigest !== OWNER_A), false, "only effective owners are counted");
  assert.deepEqual([...inputs.ownerEvidence.keys()], [OWNER_A]);
  assert.deepEqual([...inputs.ownerEvidence.get(OWNER_A)], [
    ["2026-03-02", { usage: 1, quota: 0, session: 0 }], ["2026-09-29", { usage: 1, quota: 0, session: 0 }],
  ]);
  // The non-effective typed owner: the queued days only. The v0.2 owner: never read.
  const ownerBReads = calls.occurrences.filter((call) => call.ownerDigest === OWNER_B);
  assert.deepEqual(ownerBReads.filter((call) => call.stream === "usage").map(({ fromDay, throughDay }) =>
    ({ fromDay, throughDay })), [
    { fromDay: "2026-03-02", throughDay: "2026-03-02" },
    { fromDay: "2026-04-10", throughDay: "2026-04-10" },
    { fromDay: "2026-09-29", throughDay: "2026-09-30" },
  ]);
  assert.equal(ownerBReads.length, 9);
  assert.equal(calls.occurrences.some((call) => call.ownerDigest === OWNER_LEGACY), false);
  assert.deepEqual([...inputs.occurrencesByOwner.keys()], [OWNER_B]);
  assert.deepEqual([...inputs.occurrencesByOwner.get(OWNER_B).keys()], ["2026-09-30"]);

  // Devices: every queued day, with the effective owners that have evidence on it.
  assert.equal(calls.devices.length, 1);
  const effectiveA = { participantId: contractOwner(OWNER_A, "effective").participantId, ownerDigest: OWNER_A,
    source: "effective" };
  assert.deepEqual([...calls.devices[0]], [
    ["2026-03-02", [effectiveA]], ["2026-04-10", []], ["2026-09-29", [effectiveA]], ["2026-09-30", []],
  ]);

  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 3 });
  // While computing, the effective owner is read once over the whole range:
  // every stream in contiguous chunks of at most 30 days, each bounded by the read chunk.
  for (const stream of ["usage", "quota", "session"]) {
    const reads = calls.occurrences.filter((call) => call.ownerDigest === OWNER_A && call.stream === stream);
    assert.ok(reads.every((call) => spannedDays([call]).length <= 30));
    assert.deepEqual(spannedDays(reads), rangeDays, stream);
    assert.ok(reads.every((call) => call.maxCandidates === job.ANALYTICS_REFRESH_RESOURCE_ENV.readChunkOccurrences.default));
  }
  assert.deepEqual([...calls.loaded.keys()], [OWNER_A]);
  assert.deepEqual([...calls.loaded.get(OWNER_A).keys()], ["2026-03-02", "2026-09-29"]);
  assert.deepEqual(calls.loaded.get(OWNER_A).get("2026-09-29"),
    { usage: [occurrence(OWNER_A, "2026-09-29")], quota: [], session: [] });
  assert.equal(calls.compute.ownerEvidence, inputs.ownerEvidence);
  assert.equal(calls.compute.occurrencesByOwner, inputs.occurrencesByOwner);
  assert.equal(typeof calls.compute.memoryProbe, "function");
  assert.equal(calls.compute.occurrenceRange, inputs.occurrenceRange);
  assert.equal(calls.compute.cacheFromDay, "2026-02-20");
  assert.deepEqual(calls.compute.queuedDays, queued);
  assert.equal(calls.compute.devicesByDay, inputs.devicesByDay);
  assert.equal(calls.compute.revisionSeed, 3);
  assert.deepEqual(outputs.journal, { lastSequence: 9 });
  assert.deepEqual(outputs.horizon, { ownerDayFromDay: "2026-02-13", cacheBandsFromDay: "2026-02-20" });
  assert.deepEqual(outputs.readSummary, { unlinkedTypedOwners: 0, terminalOwners: 1, nonEffectiveUnread: 0 });
  assert.deepEqual(outputs.dailyCandidates.map((candidate) => candidate.day), ["2026-03-02", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(outputs.blockedDays, ["2026-04-10"]);
  // N-EXCL: read once, unchanged and empty: nothing reaches A-2 and nothing extra is queued.
  assert.equal(calls.exclusions, 1);
  assert.deepEqual([...calls.compute.exclusions], []);
  assert.equal(outputs.exclusionsSha256, NO_EXCLUSIONS);
  assert.deepEqual(outputs.exclusions, { rows: 0, active: 0, excludedOwners: 0, changed: false, republishedDays: 0 });
});

test("default wiring: a linked owner's active exclusions reach A-2, and a changed table queues every published day", async () => {
  const interval = Object.freeze({ effectiveAtUs: Date.parse("2026-09-29T00:00:00.000Z") * 1_000, expiresAtUs: null });
  const exclusionRead = { rows: 3, active: 2, sha256: "1".repeat(64), activeByParticipant: new Map([
    [contractOwner(OWNER_A, "effective").participantId, [interval]],
    ["participant-outside-the-roster", [interval]],
  ]) };
  const { calls, modules } = wiringModules({ exclusionRead });
  const pipeline = job.createAnalyticsV2Pipeline(modules);
  const state = specState({ cursor: null, carriedBlockedDays: ["2026-04-10"], cacheFloorDay: "2026-02-20",
    publishedDays: ["2026-01-05", "2026-09-29"] });
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state });
  // Every published head is queued again (2026-09-29 was queued by the journal already).
  assert.deepEqual(inputs.queuedDays, ["2026-01-05", "2026-03-02", "2026-04-10", "2026-09-29", "2026-09-30"]);
  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
  // Only the roster's owner, by its digest; an unlisted participant is in no aggregate.
  assert.deepEqual([...calls.compute.exclusions], [[OWNER_A, [interval]]]);
  assert.equal(outputs.exclusionsSha256, "1".repeat(64));
  assert.deepEqual(outputs.exclusions, { rows: 3, active: 2, excludedOwners: 1, changed: true, republishedDays: 1 });
  // The same table as the last run applied: nothing is requeued.
  const again = await job.createAnalyticsV2Pipeline(wiringModules({ exclusionRead }).modules).read({ pool: {}, schema: "s",
    nowMs: WIRING_NOW_MS, state: { ...state, appliedExclusionsSha256: "1".repeat(64) } });
  assert.deepEqual(again.queuedDays, ["2026-03-02", "2026-04-10", "2026-09-29", "2026-09-30"]);
  assert.equal(again.exclusions.changed, false);

  // A malformed read or prior state is refused, never read as "no exclusions".
  for (const malformed of [null, { ...exclusionRead, sha256: "x" }, { ...exclusionRead, rows: -1 },
    { ...exclusionRead, active: -1 }, { ...exclusionRead, active: 4 }, { ...exclusionRead, activeByParticipant: {} }]) {
    await assert.rejects(job.createAnalyticsV2Pipeline(wiringModules({ exclusionRead: malformed }).modules)
      .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state }), { code: "ANALYTICS_V2_REFRESH_EXCLUSIONS_INVALID" });
  }
  for (const malformed of [{ ...state, appliedExclusionsSha256: undefined }, { ...state, publishedDays: ["2026-02-30"] },
    { ...state, publishedDays: undefined }]) {
    await assert.rejects(job.createAnalyticsV2Pipeline(wiringModules().modules)
      .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: malformed }), { code: "ANALYTICS_V2_REFRESH_STATE_INVALID" });
  }
  // A pipeline without the exclusion reader cannot be built.
  const { owners: { readAnalyticsV2Exclusions: _read, ...ownersWithout }, ...rest } = wiringModules().modules;
  assert.throws(() => job.createAnalyticsV2Pipeline({ ...rest, owners: ownersWithout }),
    { code: "ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE" });
});

test("default wiring: cache history starts at the first evidence day, older than any window, queue or floor", async () => {
  // OWNER_A's first evidence is 2024-11-03, 697 days before today and never
  // queued; production builds a cache day for every delivered day.
  const { calls, modules } = wiringModules({ ownerAEvidence: ["2024-11-03", "2026-09-29"] });
  const pipeline = job.createAnalyticsV2Pipeline(modules);
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS,
    state: specState({ cursor: null, carriedBlockedDays: [], cacheFloorDay: null }) });
  assert.equal(inputs.firstEvidenceDay, "2024-11-03");
  assert.equal(inputs.cacheFromDay, "2024-11-03");
  assert.deepEqual({ ...inputs.occurrenceRange }, { fromDay: "2024-10-27", throughDay: "2026-10-01" });
  assert.deepEqual([...inputs.ownerEvidence.get(OWNER_A).keys()], ["2024-11-03", "2026-09-29"]);
  const counts = calls.counts.filter((call) => call.ownerDigest === OWNER_A && call.stream === "usage");
  assert.deepEqual(spannedDays(counts), spannedDays([inputs.occurrenceRange]), "the whole history is counted");
  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
  assert.deepEqual([...calls.loaded.get(OWNER_A).keys()], ["2024-11-03", "2026-09-29"]);
  const reads = calls.occurrences.filter((call) => call.ownerDigest === OWNER_A && call.stream === "usage");
  assert.deepEqual(spannedDays(reads), spannedDays([inputs.occurrenceRange]), "the whole history is read");
  assert.equal(calls.compute.cacheFromDay, "2024-11-03");
  assert.deepEqual(outputs.horizon, { ownerDayFromDay: "2024-10-27", cacheBandsFromDay: "2024-11-03" });
  // A pipeline without the first-evidence reader cannot be built.
  const { occurrences: { readOwnerFirstEvidenceDay: _first, ...withoutFirst }, ...rest } = wiringModules().modules;
  assert.throws(() => job.createAnalyticsV2Pipeline({ ...rest, occurrences: withoutFirst }),
    { code: "ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE" });
});

test("default wiring: an unlinked typed owner blocks every queued day; a non-effective source refusal fails closed", async () => {
  const unlinked = [
    { participantId: "participant-unlinked-legacy", hasV1: false, hasV11: false, hasV12: false, hasLegacy: true,
      hasEffective: false, source: "v0.2" },
  ];
  // An unlinked owner without typed evidence is not a daily-cohort member.
  const legacyOnly = wiringModules({ unlinked });
  const legacyPipeline = job.createAnalyticsV2Pipeline(legacyOnly.modules);
  const legacyOutputs = await legacyPipeline.compute(
    await legacyPipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE }),
    { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
  assert.equal(legacyOutputs.dailyCandidates.length, 3);

  // A typed one makes production's daily lane unavailable: nothing publishes.
  const typed = wiringModules({ unlinked: [...unlinked, { ...unlinked[0], participantId: "participant-unlinked-v1",
    hasV1: true, source: "mixed" }], failOwner: OWNER_B });
  const pipeline = job.createAnalyticsV2Pipeline(typed.modules);
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE });
  // OWNER_B's closed source refusal leaves it unread: A-2 then blocks every queued day for it.
  assert.equal(inputs.occurrencesByOwner.has(OWNER_B), false);
  assert.equal(inputs.ownerEvidence.has(OWNER_A), true);
  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
  assert.deepEqual(outputs.dailyCandidates, []);
  assert.deepEqual(outputs.blockedDays, ["2026-03-02", "2026-04-10", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(outputs.readSummary, { unlinkedTypedOwners: 1, terminalOwners: 1, nonEffectiveUnread: 1 });

  // The same refusal for an effective owner fails the run: at its count
  // (read) and, should only its read refuse, at its load (compute).
  const failing = wiringModules({ failOwner: OWNER_A });
  await assert.rejects(job.createAnalyticsV2Pipeline(failing.modules)
    .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE }), { code: "ANALYTICS_V2_SOURCE_CONFLICT" });
  const failingRead = wiringModules();
  const readOnly = failingRead.modules.occurrences.readOwnerOccurrences;
  failingRead.modules.occurrences.readOwnerOccurrences = async (context, options) => {
    if (options.ownerDigest === OWNER_A) {
      throw Object.assign(new Error("ANALYTICS_V2_SOURCE_LIMIT"), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
    }
    return readOnly(context, options);
  };
  const failingPipeline = job.createAnalyticsV2Pipeline(failingRead.modules);
  await assert.rejects(failingPipeline.compute(await failingPipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS,
    state: WIRING_STATE }), { nowMs: WIRING_NOW_MS, revisionSeed: 0 }), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  const { occurrences: { countOwnerOccurrences: _count, ...withoutCount }, ...others } = wiringModules().modules;
  assert.throws(() => job.createAnalyticsV2Pipeline({ ...others, occurrences: withoutCount }),
    { code: "ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE" });

  // Shapes other than the landed ones are refused, never coerced.
  const arrayOwners = wiringModules();
  arrayOwners.modules.owners.listAnalyticsV2Owners = async () => [contractOwner(OWNER_A, "effective")];
  await assert.rejects(job.createAnalyticsV2Pipeline(arrayOwners.modules)
    .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE }), { code: "ANALYTICS_V2_REFRESH_OWNERS_INVALID" });
  const stalled = wiringModules();
  stalled.modules.queuedDays.readQueuedDays = async (context, options) =>
    ({ days: [], lastSequence: options.afterSequence, terminalOwners: [], events: 0, complete: false });
  await assert.rejects(job.createAnalyticsV2Pipeline(stalled.modules)
    .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE }), { code: "ANALYTICS_V2_REFRESH_JOURNAL_INVALID" });
  const { compute: _compute, ...withoutCompute } = wiringModules().modules;
  assert.throws(() => job.createAnalyticsV2Pipeline({ ...withoutCompute, compute: { computeAnalyticsV2() {} } }),
    { code: "ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE" });
});

test("cache horizon and day spans: history is retained back to the floor; reads are chunked and contiguous", () => {
  assert.equal(job.analyticsRefreshCacheFromDay({ today: "2026-10-01", analysisDays: 170, queuedDays: [],
    cacheFloorDay: null }), "2026-04-15");
  assert.equal(job.analyticsRefreshCacheFromDay({ today: "2026-10-01", analysisDays: 170,
    queuedDays: ["2026-04-01", "2026-11-01"], cacheFloorDay: "2026-05-01" }), "2026-04-01");
  assert.equal(job.analyticsRefreshCacheFromDay({ today: "2027-06-01", analysisDays: 170, queuedDays: [],
    cacheFloorDay: "2026-07-12" }), "2026-07-12", "a later run never drops stored cache history");
  // No lower bound: evidence older than the 170-day analysis horizon, never
  // queued and never stored, still starts the cache horizon.
  assert.equal(job.analyticsRefreshCacheFromDay({ today: "2026-10-01", analysisDays: 170, queuedDays: [],
    cacheFloorDay: null, firstEvidenceDay: "2025-01-10" }), "2025-01-10");
  assert.equal(job.analyticsRefreshCacheFromDay({ today: "2026-10-01", analysisDays: 170,
    queuedDays: ["2026-04-01"], cacheFloorDay: "2026-05-01", firstEvidenceDay: "2026-09-01" }), "2026-04-01",
  "a later first evidence day never narrows the horizon");
  assert.deepEqual(job.analyticsRefreshDaySpans(["2026-01-03", "2026-01-01", "2026-01-02", "2026-01-05"], 2), [
    { fromDay: "2026-01-01", throughDay: "2026-01-02" },
    { fromDay: "2026-01-03", throughDay: "2026-01-03" },
    { fromDay: "2026-01-05", throughDay: "2026-01-05" },
  ]);
  assert.deepEqual(job.analyticsRefreshRangeChunks({ fromDay: "2026-01-30", throughDay: "2026-02-03" }, 2), [
    { fromDay: "2026-01-30", throughDay: "2026-01-31" },
    { fromDay: "2026-02-01", throughDay: "2026-02-02" },
    { fromDay: "2026-02-03", throughDay: "2026-02-03" },
  ]);
  assert.deepEqual(job.analyticsRefreshPublicationDays(["2026-09-30", "2026-09-28"],
    { carriedBlockedDays: ["2026-09-28", "2026-09-01"] }), ["2026-09-01", "2026-09-28", "2026-09-30"]);
  // N-EXCL: changed exclusions also queue every published day; unchanged ones queue none.
  const published = { carriedBlockedDays: ["2026-09-01"], publishedDays: ["2026-08-01", "2026-09-28"] };
  assert.deepEqual(job.analyticsRefreshPublicationDays(["2026-09-30"], published), ["2026-09-01", "2026-09-30"]);
  assert.deepEqual(job.analyticsRefreshPublicationDays(["2026-09-30"], published, { exclusionsChanged: true }),
    ["2026-08-01", "2026-09-01", "2026-09-28", "2026-09-30"]);
});

// ---------------------------------------------------------------------------
// Integration: the real A-1 readers and A-2 compute over A-1's direct-seed corpus
// ---------------------------------------------------------------------------

function realPipeline() {
  return job.createAnalyticsV2Pipeline({
    owners: a1.owners,
    occurrences: a1.occurrences,
    devices: a1.devices,
    queuedDays: a1.queuedDays,
    compute: a2,
  });
}

async function ownerScopedRows(pool, schema, table) {
  // run_id names the writing run; the content must not depend on it.
  const result = await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'run_id' ORDER BY (to_jsonb(t) - 'run_id')::text), '[]'::jsonb)::text AS rows
       FROM ${quoted(schema, table)} t`,
  );
  return result.rows[0].rows;
}

for (const correctionRuntime of ["active", "staged"]) {
  test(`PG17 integration (${correctionRuntime} correction runtime): real A-1 readers and A-2 compute over direct-seed`, {
    skip: PG_SKIP,
    timeout: 600_000,
  }, async () => {
    await withDatabase(`integration-${correctionRuntime}`, async ({ pool, createSchema }) => {
      const { schema } = await createSchema();
      const fixture = await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules, correctionRuntime });
      const pipeline = realPipeline();
      const now = new Date(seedFixture.NOW_MS).toISOString();

      // (a) First full run over the real readers and kernels.
      const first = await runJob({ schema, now, pipeline });
      assert.equal(first.state, "complete");
      assert.equal(first.cursor, String(fixture.sequences.last), "the whole journal was consumed");
      assert.equal(first.unlinkedTypedOwners, 0, "golf is unlinked without typed evidence");
      assert.equal(first.nonEffectiveUnread, 0);
      const runs = await runRows(pool, schema);
      assert.equal(runs[0].state, "complete");
      assert.ok(Array.isArray(runs[0].refusals) && runs[0].refusals.length > 0, "refusals are listed");
      assert.ok(first.refusalsByReason.non_effective_source_unported >= 1, "charlie (v0.2) is refused");
      // Staged runtime: bravo (mixed) and echo (v1.1) are typed, non-effective
      // members of the daily cohort with evidence on D1 only. They block D1
      // and nothing else; with the runtime active they are computed.
      const nonEffectiveDaily = runs[0].refusals
        .filter((refusal) => refusal.family === "daily" && refusal.reason === "non_effective_source_unported")
        .map((refusal) => refusal.day);
      assert.deepEqual(nonEffectiveDaily, correctionRuntime === "staged" ? [seedFixture.D1, seedFixture.D1] : []);
      // The crossed-midnight occurrence is a conflict on D1 and D2: both stay blocked.
      assert.deepEqual(first.blocked.filter((day) => [seedFixture.D1, seedFixture.D2].includes(day)),
        [seedFixture.D1, seedFixture.D2]);
      // D3 holds only an excluded owner's evidence. A non-effective owner blocks
      // only the queued days it has evidence on, so D3 publishes at both runtimes.
      assert.deepEqual(first.published, [seedFixture.D3]);
      const heads = await publishedRows(pool, schema);
      assert.deepEqual([...heads.keys()], [seedFixture.D3]);
      assert.equal(heads.get(seedFixture.D3).revision, 1);
      for (const table of ["analytics_v2_owner_day", "analytics_v2_owner_model_dates", "analytics_v2_preview"]) {
        assert.ok(await count(pool, schema, table) > 0, table);
      }
      // K-PERCARD: the kernel's cards are registered once, and every owner-day
      // with daily values has exactly one price row whose basis is the
      // kernel's cards (the prepared-day observer agreed with the kernel).
      const priced = async () => (await pool.query(`SELECT d.owner_digest, d.day::text AS day, p.price_basis_id,
          p.usage_events, p.unpriced_events, p.partially_priced_events, p.inputs_sha256, p.kernel_id, b.basis_sha256,
          (p.run_id = d.run_id) AS same_run,
          (d.daily -> 'pricing' ->> 'unpriced')::integer AS daily_unpriced,
          (d.daily -> 'counts' ->> 'usage')::integer AS daily_usage,
          NOT EXISTS (SELECT 1 FROM unnest(b.card_refs) AS ref WHERE NOT EXISTS (
            SELECT 1 FROM ${quoted(schema, "analytics_v2_kernel_cards")} k WHERE k.kernel_id = p.kernel_id AND k.card_ref = ref))
            AS basis_in_kernel
         FROM ${quoted(schema, "analytics_v2_owner_day")} d
         LEFT JOIN ${quoted(schema, "analytics_v2_owner_day_price")} p ON p.owner_digest = d.owner_digest AND p.day = d.day
         LEFT JOIN ${quoted(schema, "analytics_v2_price_bases")} b ON b.price_basis_id = p.price_basis_id
        WHERE d.daily IS NOT NULL ORDER BY d.owner_digest, d.day`)).rows;
      const firstPrices = await priced();
      // With the correction runtime active the effective owners have priced days.
      if (correctionRuntime === "active") assert.ok(firstPrices.length > 0);
      for (const row of firstPrices) {
        assert.ok(row.price_basis_id !== null, "every owner-day with daily values has a price row");
        assert.equal(row.same_run, true);
        assert.equal(row.basis_in_kernel, true);
        assert.equal(row.usage_events, row.daily_usage, "the price row counts the day's usage events");
        assert.equal(row.unpriced_events, row.daily_unpriced, "and agrees with the kernel's unpriced count");
      }
      assert.equal(await count(pool, schema, "analytics_v2_owner_day_price"), firstPrices.length);
      const kernelCards = await count(pool, schema, "analytics_v2_kernel_cards");
      assert.ok(kernelCards > 100, "the d43c8f92 registry's cards");
      assert.deepEqual(first.prices, { kernelCards, cardsRegistered: kernelCards,
        basesRegistered: await count(pool, schema, "analytics_v2_price_bases"), ownerDays: firstPrices.length,
        transitions: [] });

      // (b) An identical rerun queues nothing new: only the carried blocked
      // days are recomputed, and no revision moves.
      const second = await runJob({ schema, now, pipeline });
      assert.equal(second.state, "complete");
      assert.deepEqual(second.published, []);
      assert.deepEqual(second.blocked, first.blocked);
      assert.deepEqual(await publishedRows(pool, schema), heads);
      // The rerun registers nothing new and reproduces every price row (ids, bases, inputs).
      assert.deepEqual(second.prices, { kernelCards, cardsRegistered: 0, basesRegistered: 0, ownerDays: firstPrices.length,
        transitions: [] });
      assert.deepEqual(await priced(), firstPrices);
      const ownerDays2 = await ownerScopedRows(pool, schema, "analytics_v2_owner_day");
      const cacheBands2 = await ownerScopedRows(pool, schema, "analytics_v2_cache_bands");

      // Months later with no new evidence: stored owner-day and cache-band
      // history is neither dropped nor changed, and no head is republished.
      const later = new Date(seedFixture.NOW_MS + 200 * 86_400_000).toISOString();
      const third = await runJob({ schema, now: later, pipeline });
      assert.equal(third.state, "complete");
      assert.deepEqual(third.published, []);
      assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_owner_day"), ownerDays2);
      assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_cache_bands"), cacheBands2);
      assert.deepEqual(await publishedRows(pool, schema), heads);
    });
  });
}

// N-EXCL (round 5: "their use in GCP analytics"; D-PT4X's read contract): an
// active community_weekly exclusion leaves its owner out of each covered day's
// public daily, a change republishes every published day, an unchanged table
// republishes nothing, and the owner's own rows never move.
test("PG17 N-EXCL: an exclusion leaves its owner out of the days it covers, republishes on change and never otherwise", {
  skip: PG_SKIP,
  timeout: 600_000,
}, async () => {
  await withDatabase("exclusions", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const fixture = await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules,
      correctionRuntime: "active", legacyScope: true });
    const lima = fixture.owners.lima;
    const pipeline = realPipeline();
    const now = new Date(seedFixture.NOW_MS).toISOString();
    const exclusions = quoted(schema, "community_aggregate_exclusions");
    const D3 = seedFixture.D3;
    const runExclusions = async () => (await pool.query(`SELECT exclusions_sha256 FROM ${quoted(schema, "analytics_v2_runs")}
      ORDER BY finished_at DESC, started_at DESC LIMIT 1`)).rows[0].exclusions_sha256;
    const participants = (head) => head.payload.totals.contributingParticipants;
    const limaRows = async () => {
      const rows = {};
      for (const table of ["analytics_v2_owner_day", "analytics_v2_cache_bands", "analytics_v2_owner_model_dates"]) {
        rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'run_id' - 'kernel_id'
            ORDER BY (to_jsonb(t) - 'run_id')::text), '[]'::jsonb)::text AS rows
           FROM ${quoted(schema, table)} t WHERE owner_digest = $1`, [lima.ownerDigest])).rows[0].rows;
      }
      return rows;
    };

    const first = await runJob({ schema, now, pipeline });
    assert.deepEqual(first.exclusions, { rows: 0, active: 0, excludedOwners: 0, changed: false, republishedDays: 0 });
    assert.ok(first.published.includes(D3));
    assert.equal(await runExclusions(), NO_EXCLUSIONS);
    const before = (await publishedRows(pool, schema)).get(D3);
    assert.ok(participants(before) >= 1, "lima contributes on D3");
    const ownRows = await limaRows();

    // An active exclusion covering D3 only.
    await pool.query(`INSERT INTO ${exclusions} (exclusion_id, participant_id, scope, reason_code, state, effective_at,
        expires_at, created_at, created_by_digest) VALUES ('synthetic-exclusion-1', $1, 'community_weekly', 'data_quality',
        'active', $2, $3, $2, $4)`, [lima.participantId, `${D3}T00:00:00.000Z`, `${D3}T23:59:59.999999Z`, "e".repeat(64)]);
    const excluded = await runJob({ schema, now, pipeline });
    assert.deepEqual(excluded.exclusions, { rows: 1, active: 1, excludedOwners: 1, changed: true,
      republishedDays: excluded.exclusions.republishedDays });
    assert.ok(excluded.exclusions.republishedDays >= 1, "the published days are queued again");
    assert.deepEqual(excluded.published, [D3], "only the covered day changes");
    const during = (await publishedRows(pool, schema)).get(D3);
    assert.equal(during.revision, before.revision + 1);
    assert.equal(participants(during), participants(before) - 1);
    assert.notEqual(await runExclusions(), NO_EXCLUSIONS);
    assert.deepEqual(await limaRows(), ownRows, "the owner's own rows are unchanged");

    // An unchanged table queues nothing again.
    const unchanged = await runJob({ schema, now, pipeline });
    assert.deepEqual(unchanged.exclusions, { rows: 1, active: 1, excludedOwners: 1, changed: false, republishedDays: 0 });
    assert.deepEqual(unchanged.published, []);

    // A row for a participant outside the roster changes the table but no aggregate.
    await pool.query(`INSERT INTO ${exclusions} (exclusion_id, participant_id, scope, reason_code, state, effective_at,
        expires_at, created_at, created_by_digest) VALUES ('synthetic-exclusion-2', 'synthetic-unknown-participant',
        'community_weekly', 'abuse_signal', 'active', $1, NULL, $1, $2)`, [`${D3}T00:00:00.000Z`, "e".repeat(64)]);
    const outside = await runJob({ schema, now, pipeline });
    assert.equal(outside.exclusions.changed, true);
    assert.equal(outside.exclusions.excludedOwners, 1);
    assert.deepEqual(outside.published, [], "republished days with unchanged content keep their revisions");

    // Revocation (an UPDATE, as D1 revokes) restores the day's content under a new revision.
    await pool.query(`UPDATE ${exclusions} SET state = 'revoked', revoked_at = $1, revoked_by_digest = $2
      WHERE exclusion_id = 'synthetic-exclusion-1'`, [now, "f".repeat(64)]);
    const revoked = await runJob({ schema, now, pipeline });
    assert.deepEqual([revoked.exclusions.active, revoked.exclusions.excludedOwners, revoked.exclusions.changed], [1, 0, true]);
    assert.deepEqual(revoked.published, [D3]);
    const after = (await publishedRows(pool, schema)).get(D3);
    assert.equal(after.revision, during.revision + 1);
    assert.equal(after.payload_sha256, before.payload_sha256, "the excluded owner is back in the day it covered");
    assert.deepEqual(await limaRows(), ownRows);

    // The table is required: without it the run fails closed and writes nothing.
    await pool.query(`ALTER TABLE ${exclusions} RENAME TO community_aggregate_exclusions_hidden`);
    const runsBefore = await count(pool, schema, "analytics_v2_runs");
    await assert.rejects(runJob({ schema, now, pipeline }), { code: "ANALYTICS_V2_SOURCE_UNAVAILABLE" });
    assert.equal(await count(pool, schema, "analytics_v2_runs"), runsBefore);
    await pool.query(`ALTER TABLE ${quoted(schema, "community_aggregate_exclusions_hidden")}
      RENAME TO community_aggregate_exclusions`);
  });
});

// N-EXCL (K-CORE-A review): an owner excluded on day D is outside D's
// cohort, as d43c8f92's weekly builder removed an excluded participant before
// anything else. Its refusals (a refused owner-day, typed evidence of a
// non-effective source) are recorded as before but block no day it is
// excluded on; a day stays blocked while one owner not excluded on it blocks it.
test("PG17 N-EXCL: an excluded owner's refusals are recorded but block no day it is excluded on", {
  skip: PG_SKIP,
  timeout: 600_000,
}, async () => {
  await withDatabase("exclusion-refusals", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    // Staged runtime: alpha's crossed-midnight occurrence is a conflict on D1
    // and D2, and bravo (mixed) and echo (v1.1) are typed non-effective
    // members of the daily cohort with evidence on D1.
    const fixture = await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules,
      correctionRuntime: "staged" });
    const { alpha, bravo, echo } = fixture.owners;
    const { D1, D2, D3 } = seedFixture;
    const pipeline = realPipeline();
    const now = new Date(seedFixture.NOW_MS).toISOString();
    const exclusions = quoted(schema, "community_aggregate_exclusions");
    let next = 0;
    const exclude = (participantId, fromDay, throughDay) => pool.query(`INSERT INTO ${exclusions} (exclusion_id,
        participant_id, scope, reason_code, state, effective_at, expires_at, created_at, created_by_digest)
      VALUES ($1, $2, 'community_weekly', 'data_quality', 'active', $3, $4, $3, $5)`,
    [`synthetic-exclusion-${next += 1}`, participantId, `${fromDay}T00:00:00.000Z`,
      new Date(Date.parse(`${throughDay}T00:00:00.000Z`) + 86_400_000).toISOString(), "e".repeat(64)]);
    const lastRefusals = async () => (await runRows(pool, schema)).at(-1).refusals;
    const alphaRows = async () => {
      const rows = {};
      for (const table of ["analytics_v2_owner_day", "analytics_v2_cache_bands", "analytics_v2_owner_model_dates"]) {
        rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'run_id'
            ORDER BY (to_jsonb(t) - 'run_id')::text), '[]'::jsonb)::text AS rows
           FROM ${quoted(schema, table)} t WHERE owner_digest = $1`, [alpha.ownerDigest])).rows[0].rows;
      }
      return rows;
    };

    const first = await runJob({ schema, now, pipeline });
    assert.equal(first.state, "complete");
    assert.deepEqual(first.blocked, [D1, D2]);
    assert.deepEqual(first.published, [D3]);
    const refusals = await lastRefusals();
    const daily = (ownerDigest) => refusals.filter((refusal) => refusal.ownerDigest === ownerDigest
      && refusal.family === "daily").map((refusal) => `${refusal.day}:${refusal.reason}`);
    assert.deepEqual(daily(alpha.ownerDigest), [`${D1}:source_conflict_or_order`, `${D2}:source_conflict_or_order`]);
    assert.deepEqual(daily(bravo.ownerDigest), [`${D1}:non_effective_source_unported`]);
    assert.deepEqual(daily(echo.ownerDigest), [`${D1}:non_effective_source_unported`]);
    const ownRows = await alphaRows();

    // alpha excluded on D1 and D2: D2 (alpha its only blocker) publishes; D1
    // stays blocked by bravo and echo, which are not excluded on it.
    await exclude(alpha.participantId, D1, D2);
    const second = await runJob({ schema, now, pipeline });
    assert.equal(second.state, "complete");
    assert.deepEqual(second.blocked, [D1]);
    assert.deepEqual(second.published, [D2]);
    assert.deepEqual(await lastRefusals(), refusals, "every refusal is recorded as before");

    // bravo and echo excluded on D1 too: nothing blocks it any more.
    await exclude(bravo.participantId, D1, D1);
    await exclude(echo.participantId, D1, D1);
    const third = await runJob({ schema, now, pipeline });
    assert.equal(third.state, "complete");
    assert.deepEqual(third.blocked, []);
    assert.deepEqual(third.published, [D1]);
    assert.deepEqual(await lastRefusals(), refusals);
    const heads = await publishedRows(pool, schema);
    assert.deepEqual([...heads.keys()], [D1, D2, D3]);
    // D1 and D2 hold no evidence of an owner of their cohort: alpha, bravo and
    // echo are left out of their folds, not counted.
    for (const day of [D1, D2]) assert.equal(heads.get(day).payload.totals.contributingParticipants, 0, day);
    assert.deepEqual(await alphaRows(), ownRows, "the excluded owner's own rows are unchanged");
  });
});

// K-PAR: owners computed by compute Workers merge to exactly the inline rows.
test("PG17 K-PAR: --workers=2 (and 4) over the real readers and kernels writes exactly the inline run's rows", {
  skip: PG_SKIP,
  timeout: 900_000,
}, async () => {
  const workerUrl = new URL("../cloud-run/dist/analytics-refresh-worker.mjs", import.meta.url);
  await access(workerUrl, undefined).catch(() => assert.fail("build cloud-run/dist first (node cloud-run/build.mjs)"));
  const dump = async (pool, schema) => {
    const rows = {};
    for (const table of ["analytics_v2_owner_day", "analytics_v2_cache_bands", "analytics_v2_owner_fits",
      "analytics_v2_owner_model_dates", "analytics_v2_published_daily"]) {
      rows[table] = await ownerScopedRows(pool, schema, table);
    }
    rows.preview = (await pool.query(`SELECT preview::text AS preview, kernel_id, manifest_version
      FROM ${quoted(schema, "analytics_v2_preview")}`)).rows;
    rows.runs = (await pool.query(`SELECT refusals::text AS refusals, publication::text AS publication, kernel_id,
        manifest_version, compatibility_sha256, owners, owner_days
       FROM ${quoted(schema, "analytics_v2_runs")} ORDER BY finished_at, started_at`)).rows;
    return rows;
  };
  await withDatabase("workers", async ({ pool, createSchema }) => {
    const dumps = new Map();
    for (const workers of [1, 2, 4]) {
      const { schema } = await createSchema();
      await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules, correctionRuntime: "active" });
      const now = new Date(seedFixture.NOW_MS).toISOString();
      const run = await job.runAnalyticsRefresh({
        argv: ["--mode=full", `--schema=${schema}`, `--now=${now}`, `--workers=${workers}`],
        env: jobEnvironment(),
        dependencies: { modules: { store, pipeline: realPipeline() }, createPool: jobPool, kernelIdentity,
          workerUrl },
      });
      assert.equal(run.state, "complete");
      assert.equal(run.workers, workers);
      assert.equal(run.memory.workers, workers);
      assert.equal(run.memory.ownersComputed > 1, true, "more than one owner shares the pool");
      // K-PGSTAT: the read side's round trips are attributed by family.
      assert.equal(run.reads.model, job.ANALYTICS_REFRESH_STATEMENT_MODEL);
      assert.ok(run.reads.statements.calls > 0);
      assert.ok(run.reads.statements.families["occurrences.scope"].calls > 0);
      assert.ok(run.reads.statements.families["snapshot.control"].calls > 0);
      assert.equal(run.reads.statements.families.untagged, undefined, "every reader statement carries its family");
      assert.ok(run.reads.phaseWallMs >= 0 && run.reads.unattributedMs >= 0);
      // N-EXCL: the table (primary 0066) is empty, unchanged since no run: nothing is applied or republished.
      assert.deepEqual(run.exclusions, { rows: 0, active: 0, excludedOwners: 0, changed: false, republishedDays: 0 });
      dumps.set(workers, await dump(pool, schema));
      // A second run over the same snapshot state publishes nothing, as inline.
      const second = await job.runAnalyticsRefresh({
        argv: ["--mode=full", `--schema=${schema}`, `--now=${now}`, `--workers=${workers}`],
        env: jobEnvironment(),
        dependencies: { modules: { store, pipeline: realPipeline() }, createPool: jobPool, kernelIdentity,
          workerUrl },
      });
      assert.deepEqual(second.published, []);
    }
    const inline = JSON.stringify(dumps.get(1));
    assert.equal(JSON.stringify(dumps.get(2)), inline, "two Workers write the inline rows, byte for byte");
    assert.equal(JSON.stringify(dumps.get(4)), inline, "four Workers write the inline rows, byte for byte");
  });
});

// A Worker that fails fails the run, and nothing is written.
test("PG17 K-PAR: a compute Worker that cannot run fails the run with a closed code and writes nothing", {
  skip: PG_SKIP,
  timeout: 300_000,
}, async () => {
  await withDatabase("workers-failure", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules, correctionRuntime: "active" });
    const before = await analyticsSnapshot(pool, schema);
    const now = new Date(seedFixture.NOW_MS).toISOString();
    const failed = await job.runAnalyticsRefresh({
      argv: ["--mode=full", `--schema=${schema}`, `--now=${now}`, "--workers=2"],
      env: jobEnvironment(),
      dependencies: { modules: { store, pipeline: realPipeline() }, createPool: jobPool, kernelIdentity,
        // A Worker script that exits without a result.
        workerUrl: new URL("data:text/javascript,process.exit(0)") },
    }).then(() => null, (error) => error);
    assert.ok(["ANALYTICS_V2_REFRESH_WORKER_EXITED", "ANALYTICS_V2_REFRESH_WORKER_FAILED"].includes(failed?.code),
      String(failed?.code));
    assert.equal(failed.phase, "compute");
    assert.deepEqual(await analyticsSnapshot(pool, schema), before);
  });
});

// ---------------------------------------------------------------------------
// Cache history with the real A-2 kernels: not a rolling window
// ---------------------------------------------------------------------------

test("PG17: real A-2 cache-band history survives later runs unchanged (retention, not a display window)", {
  skip: PG_SKIP,
  timeout: 600_000,
}, async () => {
  const corpus = synthetic.composeProofCorpus();
  const facts = new Map(synthetic.COMPOSE_OWNERS.map((owner) => [owner.digest, synthetic.composeFacts(owner)]));
  // The compose-proof corpus behind stub A-1 readers with the landed shapes;
  // the compute core is the real A-2 module.
  const pipeline = job.createAnalyticsV2Pipeline({
    owners: { listAnalyticsV2Owners: async () => ({ owners: corpus.owners, unlinked: [], correctionRuntimeActive: true }),
      ...NO_EXCLUSION_READER },
    queuedDays: {
      readQueuedDays: async (context, { afterSequence }) => (afterSequence === 0
        ? { days: corpus.publishedDays, lastSequence: 7, terminalOwners: [], events: 7, complete: true }
        : { days: [], lastSequence: afterSequence, terminalOwners: [], events: 0, complete: true }),
    },
    occurrences: {
      readOwnerFirstEvidenceDay: async (context, { ownerDigest, throughDay }) => [...facts.get(ownerDigest)]
        .filter(([day, streams]) => day <= throughDay
          && streams.usage.length + streams.quota.length + streams.session.length > 0)
        .map(([day]) => day).sort()[0] ?? null,
      readOwnerOccurrences: async (context, { ownerDigest, stream, fromDay, throughDay }) => new Map(
        [...facts.get(ownerDigest)].filter(([day, streams]) => day >= fromDay && day <= throughDay
          && streams[stream].length > 0).map(([day, streams]) => [day, streams[stream]])),
      countOwnerOccurrences: async (context, { ownerDigest, stream, fromDay, throughDay }) => new Map(
        [...facts.get(ownerDigest)].filter(([day, streams]) => day >= fromDay && day <= throughDay
          && streams[stream].length > 0).map(([day, streams]) => [day, streams[stream].length])),
    },
    devices: {
      countContributingDevices: async (context, { days }) => new Map([...days].map(([day, owners]) =>
        [day, new Map(owners.map((owner) => [owner.ownerDigest, 1]))])),
    },
    compute: a2,
  });
  await withDatabase("cache-history", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const first = await runJob({ schema, now: new Date(synthetic.NOW_MS).toISOString(), pipeline });
    assert.equal(first.state, "complete");
    assert.deepEqual(first.published, corpus.publishedDays);
    const bands = await ownerScopedRows(pool, schema, "analytics_v2_cache_bands");
    assert.equal(await count(pool, schema, "analytics_v2_cache_bands"), 210, "7 days x 3 owners x 10 bands");
    const ownerDays = await ownerScopedRows(pool, schema, "analytics_v2_owner_day");
    const heads = await publishedRows(pool, schema);
    // 120 and 400 days later, nothing new: the history the first run computed
    // (back to today-80) is recomputed exactly, never dropped.
    for (const daysLater of [120, 400]) {
      const later = await runJob({ schema, now: new Date(synthetic.NOW_MS + daysLater * 86_400_000).toISOString(),
        pipeline });
      assert.equal(later.state, "complete");
      assert.deepEqual(later.published, []);
      assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_cache_bands"), bands, `${daysLater} days later`);
      const bandRuns = await pool.query(`SELECT DISTINCT run_id::text AS run_id
        FROM ${quoted(schema, "analytics_v2_cache_bands")}`);
      assert.deepEqual(bandRuns.rows.map((row) => row.run_id), [later.runId], "every stored cache day was recomputed");
      assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_owner_day"), ownerDays, `${daysLater} days later`);
      assert.deepEqual(await publishedRows(pool, schema), heads);
    }
  });
});

// ---------------------------------------------------------------------------
// GCP cap raise: owners beyond the shared reducers' bounds, and the memory guard
// ---------------------------------------------------------------------------

/**
 * Stub A-1 readers with the landed shapes over synthetic facts
 * (ownerDigest -> day -> streams), a journal of explicit events, and the real
 * A-2 compute. `countOf(ownerDigest, stream, day, actual)` may override a
 * count A-1 reports; `reads` records the owner of every occurrence read.
 */
function syntheticPipeline({ owners, facts, journal, countOf = (_owner, _stream, _day, actual) => actual, reads = [],
  exclusionRead = () => NO_EXCLUSION_READER.readAnalyticsV2Exclusions() }) {
  const daysOf = (ownerDigest, stream, fromDay, throughDay) => [...(facts.get(ownerDigest) ?? new Map())]
    .filter(([day, streams]) => day >= fromDay && day <= throughDay && streams[stream].length > 0);
  return job.createAnalyticsV2Pipeline({
    owners: { listAnalyticsV2Owners: async () => ({ owners, unlinked: [], correctionRuntimeActive: true }),
      readAnalyticsV2Exclusions: async () => exclusionRead() },
    queuedDays: {
      readQueuedDays: async (context, { afterSequence }) => {
        const events = journal.filter((event) => event.sequence > afterSequence);
        return { days: [...new Set(events.map((event) => event.day))].sort(),
          lastSequence: events.at(-1)?.sequence ?? afterSequence, terminalOwners: [], events: events.length, complete: true };
      },
    },
    occurrences: {
      readOwnerFirstEvidenceDay: async (context, { ownerDigest, throughDay }) => [...(facts.get(ownerDigest) ?? new Map())]
        .filter(([day, streams]) => day <= throughDay && streams.usage.length + streams.quota.length + streams.session.length > 0)
        .map(([day]) => day).sort()[0] ?? null,
      readOwnerOccurrences: async (context, { ownerDigest, stream, fromDay, throughDay }) => {
        reads.push(ownerDigest);
        return new Map(daysOf(ownerDigest, stream, fromDay, throughDay).map(([day, streams]) => [day, streams[stream]]));
      },
      countOwnerOccurrences: async (context, { ownerDigest, stream, fromDay, throughDay }) => new Map(
        daysOf(ownerDigest, stream, fromDay, throughDay)
          .map(([day, streams]) => [day, countOf(ownerDigest, stream, day, streams[stream].length)])),
    },
    devices: {
      countContributingDevices: async (context, { days }) => new Map([...days].map(([day, contributors]) =>
        [day, new Map(contributors.map((owner) => [owner.ownerDigest, 1]))])),
    },
    compute: a2,
  });
}

const journalOf = (days) => days.map((day, index) => ({ sequence: index + 1, day }));

test("PG17: an owner beyond the shared reducers' caps is computed and written, not refused", {
  skip: PG_SKIP,
  timeout: 900_000,
}, async () => {
  // Owner decision 2026-10-01: the d43c8f92 shared reducers refused a day
  // over 20,000 occurrences (day_row_limit) and a day whose quota preparation
  // reached its bound (quota_day_unrepresentable); the fast path recorded
  // those refusals and blocked the days. Both are now computed.
  const corpus = synthetic.composeProofCorpus();
  const dense = synthetic.syntheticOwner(4, "pro");
  const crowdedDay = synthetic.addDays(synthetic.TODAY, -30);
  const quotaDay = synthetic.addDays(synthetic.TODAY, -21);
  const denseFacts = synthetic.capFacts(dense, { firstDenseBack: 30, denseDays: 1, usagePerDay: 25_000 });
  denseFacts.set(quotaDay, synthetic.capFacts(dense, { firstDenseBack: 21, denseDays: 1, usagePerDay: 200,
    quotaPerDay: 6_000, idBase: 40_000_000 }).get(quotaDay));
  const facts = new Map([...synthetic.COMPOSE_OWNERS.map((owner) => [owner.digest, synthetic.composeFacts(owner)]),
    [dense.digest, denseFacts]]);
  const owners = [...corpus.owners, synthetic.effectiveV2Owner(dense)];
  const queued = [...corpus.publishedDays, crowdedDay, quotaDay].sort();
  const pipeline = syntheticPipeline({ owners, facts, journal: journalOf(queued) });
  await withDatabase("cap-raise", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const run = await runJob({ schema, now: new Date(synthetic.NOW_MS).toISOString(), pipeline });
    assert.equal(run.state, "complete");
    assert.equal(run.refusals, 0, "no owner, day or window is refused");
    assert.deepEqual(run.published, queued);
    assert.deepEqual(run.blocked, []);
    const heads = await publishedRows(pool, schema);
    assert.equal(heads.get(crowdedDay).payload.totals.usageEvents, 25_000);
    assert.equal(heads.get(quotaDay).payload.totals.quotaObservations, 6_000);
    const ownerDay = await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, daily, refusal
        FROM ${quoted(schema, "analytics_v2_owner_day")} WHERE owner_digest = $1 AND day IN ($2::date, $3::date) ORDER BY day`,
    [dense.digest, crowdedDay, quotaDay]);
    assert.deepEqual(ownerDay.rows.map((row) => [row.day, row.refusal, row.daily.counts]), [
      [crowdedDay, null, { usage: 25_000, quota: 9, session: 1 }],
      [quotaDay, null, { usage: 200, quota: 6_000, session: 1 }],
    ]);
    const modelDates = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, "analytics_v2_owner_model_dates")}
      WHERE owner_digest = $1`, [dense.digest]);
    assert.equal(modelDates.rows[0].n, 70);
    const fits = await pool.query(`SELECT fits FROM ${quoted(schema, "analytics_v2_owner_fits")} WHERE owner_digest = $1`,
      [dense.digest]);
    assert.ok(fits.rows[0].fits.length > 0, "the dense owner holds fits");

    // The run row records the bounds applied and each owner's evidence and memory figures.
    const [row] = await runRows(pool, schema);
    const { outputBudgetBytes, ...bounds } = row.timings.resources;
    assert.deepEqual(bounds, { memoryModel: "analytics-v2-memory-model-v2",
      outputModel: "analytics-v2-output-model-v1", memoryBudgetBytes: 1_024 * 1_048_576, maxDayOccurrences: 250_000,
      maxDayRecordBytes: 256 * 1_048_576 });
    // The output budget is what the heap leaves after the budget and the reserves.
    assert.equal(Math.floor(outputBudgetBytes / 1_048_576), run.memory.outputBudgetMiB);
    assert.ok(outputBudgetBytes >= job.ANALYTICS_REFRESH_HEAP_RESERVE.minimumOutputBudgetBytes);
    // The Job reclaims the part of the per-owner budget the largest admitted owner leaves.
    const largestAdmitted = Math.max(...row.timings.owners.filter((value) => value.admitted)
      .map((value) => value.estimateBytes));
    assert.equal(row.timings.account.outputBudgetBytes, outputBudgetBytes + 1_024 * 1_048_576 - largestAdmitted);
    assert.equal(run.memory.effectiveOutputBudgetMiB, Math.floor(row.timings.account.outputBudgetBytes / 1_048_576));
    // The account: every owner's outputs, recorded with the run and summarised in the receipt.
    assert.equal(row.timings.account.heldInputBytes, 0);
    assert.equal(row.timings.account.accountBytes, row.timings.owners.reduce((total, value) => total + value.outputBytes, 0));
    assert.equal(run.memory.accountMiB, Math.ceil(row.timings.account.accountBytes / 1_048_576));
    assert.ok(run.memory.accountMiB <= run.memory.outputBudgetMiB);
    assert.deepEqual(row.timings.owners.map((entry) => entry.ownerDigest), owners.map((owner) => owner.ownerDigest).sort());
    const entry = row.timings.owners.find((value) => value.ownerDigest === dense.digest);
    const total = (stream) => [...denseFacts.values()].reduce((sum, streams) => sum + streams[stream].length, 0);
    assert.deepEqual({ usage: entry.usage, quota: entry.quota, session: entry.session, admitted: entry.admitted,
      maxDayOccurrences: entry.maxDayOccurrences },
    { usage: total("usage"), quota: total("quota"), session: total("session"), admitted: true, maxDayOccurrences: 25_010 });
    assert.ok(Number.isSafeInteger(entry.heapPeakBytes) && entry.heapPeakBytes > 0, "the heap was sampled");
    assert.ok(entry.estimateBytes < 1_024 * 1_048_576);
    // The receipt reports the process's peak resident set, for sizing the Job.
    assert.ok(Number.isSafeInteger(run.memory.peakRssMiB) && run.memory.peakRssMiB > 0, "peak resident set reported");
    // The receipt carries only content-free aggregates.
    assert.deepEqual({ budgetMiB: run.memory.budgetMiB, ownersComputed: run.memory.ownersComputed,
      ownersRefused: run.memory.ownersRefused }, { budgetMiB: 1_024, ownersComputed: 4, ownersRefused: 0 });
    assert.equal(JSON.stringify(run).includes(dense.digest), false);
    assert.equal(Object.keys(run.timings).some((key) => key === "owners" || key === "resources"), false);
  });
});

test("PG17: an owner over the memory budget is refused with memory_budget, never read, and its rows are retained", {
  skip: PG_SKIP,
  timeout: 600_000,
}, async () => {
  const corpus = synthetic.composeProofCorpus();
  const big = synthetic.syntheticOwner(5, "plus");
  const facts = new Map([...synthetic.COMPOSE_OWNERS.map((owner) => [owner.digest, synthetic.composeFacts(owner)]),
    [big.digest, synthetic.composeFacts(big)]]);
  const owners = [...corpus.owners, synthetic.effectiveV2Owner(big)];
  const journal = journalOf(corpus.publishedDays);
  const reads = [];
  let grown = false;
  // After the first run the owner's evidence grows past the 1,024 MiB budget:
  // A-1 counts 200,000 usage occurrences on today (an estimate of about 1.6 GB).
  const countOf = (ownerDigest, stream, day, actual) =>
    (grown && ownerDigest === big.digest && stream === "usage" && day === synthetic.TODAY ? 200_000 : actual);
  // The table's read (A-1 readAnalyticsV2Exclusions' shape): none until the third run.
  let exclusionRead = NO_EXCLUSION_READER.readAnalyticsV2Exclusions();
  const pipeline = syntheticPipeline({ owners, facts, journal, countOf, reads, exclusionRead: () => exclusionRead });
  await withDatabase("memory-budget", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const now = new Date(synthetic.NOW_MS).toISOString();
    const first = await runJob({ schema, now, pipeline });
    assert.equal(first.state, "complete");
    assert.equal(first.memory.ownersRefused, 0);
    assert.ok(reads.includes(big.digest));
    const ownerDays = await ownerScopedRows(pool, schema, "analytics_v2_owner_day");
    const fits = await ownerScopedRows(pool, schema, "analytics_v2_owner_fits");
    const bands = await ownerScopedRows(pool, schema, "analytics_v2_cache_bands");
    const heads = await publishedRows(pool, schema);
    const previewBefore = (await pool.query(`SELECT preview FROM ${quoted(schema, "analytics_v2_preview")}`))
      .rows[0].preview;

    grown = true;
    reads.length = 0;
    journal.push({ sequence: journal.length + 1, day: synthetic.TODAY });
    const second = await runJob({ schema, now, pipeline });
    assert.equal(second.state, "complete");
    assert.equal(reads.includes(big.digest), false, "a refused owner is never read");
    assert.deepEqual(second.refusalsByReason, { memory_budget: 2 });
    assert.deepEqual(second.blocked, [synthetic.TODAY]);
    assert.deepEqual(second.published, []);
    assert.deepEqual({ ownersComputed: second.memory.ownersComputed, ownersRefused: second.memory.ownersRefused },
      { ownersComputed: 3, ownersRefused: 1 });
    const runs = await runRows(pool, schema);
    assert.deepEqual(runs[1].refusals, [
      { ownerDigest: big.digest, day: null, family: "owner", reason: "memory_budget" },
      { ownerDigest: big.digest, day: synthetic.TODAY, family: "daily", reason: "memory_budget" },
    ]);
    const entry = runs[1].timings.owners.find((value) => value.ownerDigest === big.digest);
    assert.equal(entry.admitted, false);
    assert.equal(entry.heapPeakBytes, null);
    assert.equal(entry.usage, 200_000 + 54);
    assert.ok(entry.estimateBytes > 1_024 * 1_048_576);
    // Nothing of the refused owner changed: its rows are retained, the blocked
    // day keeps its prior head, and every other owner is recomputed unchanged.
    assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_owner_day"), ownerDays);
    assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_owner_fits"), fits);
    assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_cache_bands"), bands);
    assert.deepEqual(await publishedRows(pool, schema), heads);
    // It has no current fit, so this run withholds the preview (stored null,
    // served as temporarily unavailable) rather than publish a cohort that
    // silently leaves it out; the first run's preview counted all four owners.
    assert.equal(previewBefore.coverage.uploadingParticipantCount, 4);
    const preview = (await pool.query(`SELECT preview FROM ${quoted(schema, "analytics_v2_preview")}`)).rows[0].preview;
    assert.equal(preview, null);

    // N-EXCL: the operator excludes it from every day. It is still refused
    // and never read, but its refusals no longer decide the community
    // outputs: today publishes, and the preview is the cohort's without it.
    exclusionRead = { rows: 1, active: 1, sha256: "3".repeat(64), activeByParticipant: new Map([
      [synthetic.effectiveV2Owner(big).participantId, [{ effectiveAtUs: 0, expiresAtUs: null }]]]) };
    reads.length = 0;
    const third = await runJob({ schema, now, pipeline });
    assert.equal(third.state, "complete");
    assert.equal(reads.includes(big.digest), false, "an excluded refused owner is still never read");
    // The changed table queues every published day, each holding its evidence:
    // one owner refusal and a daily refusal for each, recorded as before.
    assert.deepEqual(third.refusalsByReason, { memory_budget: 1 + corpus.publishedDays.length });
    assert.deepEqual(third.exclusions, { rows: 1, active: 1, excludedOwners: 1, changed: true,
      republishedDays: corpus.publishedDays.length - 1 });
    assert.deepEqual(third.blocked, []);
    // It contributed to every day of the first run's heads, so each day it is
    // now left out of is a new revision.
    assert.deepEqual(third.published, corpus.publishedDays);
    assert.deepEqual((await runRows(pool, schema))[2].refusals, [
      { ownerDigest: big.digest, day: null, family: "owner", reason: "memory_budget" },
      ...corpus.publishedDays.map((day) => ({ ownerDigest: big.digest, day, family: "daily", reason: "memory_budget" })),
    ]);
    const excludedPreview = (await pool.query(`SELECT preview FROM ${quoted(schema, "analytics_v2_preview")}`))
      .rows[0].preview;
    assert.notEqual(excludedPreview, null);
    assert.equal(excludedPreview.coverage.uploadingParticipantCount, 3);
    assert.equal(await ownerScopedRows(pool, schema, "analytics_v2_owner_fits"), fits,
      "the refused owner's stored fit is retained");
  });
});

test("PG17 integration (dense): the real readers count and stream a 25,000-occurrence v1.2 day, and A-2 computes it", {
  skip: PG_SKIP,
  timeout: 900_000,
}, async () => {
  await withDatabase("integration-dense", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const fixture = await seedFixture.seedAnalyticsV2Fixture({ pool, schema, modules: seedModules, correctionRuntime: "active",
      dense: { day: seedFixture.D2, usage: 25_000 } });
    const hotel = fixture.owners.hotel.ownerDigest;
    const context = { pool, schema, nowMs: seedFixture.NOW_MS };
    const options = { ownerDigest: hotel, stream: "usage", fromDay: seedFixture.D1, throughDay: seedFixture.D3 };
    // A-1's exact count is the reader's own row count, before anything is read.
    const counts = await a1.occurrences.countOwnerOccurrences(context, options);
    assert.deepEqual([...counts], [[seedFixture.D2, 25_000]]);
    const read = await a1.occurrences.readOwnerOccurrences(context, options);
    assert.equal(read.get(seedFixture.D2).length, 25_000);
    // The shared reducers refuse this day; the fast path used to refuse it too.
    const kernels = await vite.ssrLoadModule("/vendor/analytics-d43c8f92/entry.ts");
    await assert.rejects(kernels.prepareSharedAnalyticsDay({ day: seedFixture.D2, ownerDigest: hotel,
      usage: read.get(seedFixture.D2), quota: [], session: [] }), (error) => error.reason === "day_row_limit");

    const run = await runJob({ schema, now: new Date(seedFixture.NOW_MS).toISOString(), pipeline: realPipeline(),
      env: jobEnvironment({ ANALYTICS_V2_READ_CHUNK_OCCURRENCES: "10000" }) });
    assert.equal(run.state, "complete");
    assert.equal(run.memory.ownersRefused, 0);
    assert.equal(run.memory.readChunkOccurrences, 10_000);
    const runs = await runRows(pool, schema);
    assert.equal(runs[0].refusals.some((refusal) => refusal.ownerDigest === hotel), false, "hotel is not refused");
    const entry = runs[0].timings.owners.find((value) => value.ownerDigest === hotel);
    assert.deepEqual({ usage: entry.usage, quota: entry.quota, session: entry.session, admitted: entry.admitted,
      maxDayOccurrences: entry.maxDayOccurrences }, { usage: 25_000, quota: 0, session: 0, admitted: true,
      maxDayOccurrences: 25_000 });
    const ownerDay = await pool.query(`SELECT daily, refusal FROM ${quoted(schema, "analytics_v2_owner_day")}
      WHERE owner_digest = $1 AND day = $2::date`, [hotel, seedFixture.D2]);
    assert.equal(ownerDay.rows[0].refusal, null);
    assert.deepEqual(ownerDay.rows[0].daily.counts, { usage: 25_000, quota: 0, session: 0 });
    const modelDates = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, "analytics_v2_owner_model_dates")}
      WHERE owner_digest = $1`, [hotel]);
    assert.equal(modelDates.rows[0].n, 70);
    // D2 stays blocked by alpha's crossed-midnight conflict, as without hotel.
    assert.ok(run.blocked.includes(seedFixture.D2));
  });
});

// ---------------------------------------------------------------------------
// C-REFRESH: the production target path, segment loads and the time guard
// ---------------------------------------------------------------------------

/** A synthetic, content-free production (or staging) environment as Cloud Run renders the Job. */
function productionEnvironment(target = "production", extra = {}) {
  const staging = target === "staging";
  return {
    ANALYTICS_REFRESH_TARGET: target,
    PRIMARY_INSTANCE_CONNECTION_NAME: staging ? "example-ops-prod1:us-east1:example-staging-primary"
      : "example-ops-prod1:us-east1:example-primary",
    PRIMARY_DATABASE: "tibotattle",
    PRIMARY_SCHEMA: "tibotattle_runtime",
    POSTGRES_IAM_USER: "example-runtime@example-ops-prod1.iam.gserviceaccount.com",
    ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752",
    CLOUD_RUN_JOB: staging ? "example-staging-refresh" : "example-analytics-refresh",
    CLOUD_RUN_EXECUTION: "example-analytics-refresh-abcde",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    // Platform and deployment variables outside the closed namespaces are not read.
    DEPLOYMENT_SOURCE_COMMIT: "b".repeat(40),
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/node",
    NODE_VERSION: "22.16.0",
    ...extra,
  };
}

function without(env, name) {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

async function refusedTarget(env, code, field) {
  await assert.rejects(job.readAnalyticsRefreshProductionTarget(env), (error) => {
    assert.equal(error.code, code, JSON.stringify({ code: error.code, field: error.field }));
    if (field !== undefined) assert.equal(error.field, field);
    // A refusal names a setting, never a value.
    assert.equal(JSON.stringify({ message: error.message, field: error.field }).includes("example-"), false);
    return true;
  }, `${code}:${field}`);
}

test("production target: the closed contract reads the six variables and the dense profile", async () => {
  assert.equal(await job.readAnalyticsRefreshProductionTarget({ PG_TEST_SOCKET: "/x" }), null);
  for (const target of ["production", "staging"]) {
    const env = productionEnvironment(target);
    const read = await job.readAnalyticsRefreshProductionTarget(env);
    assert.deepEqual({ ...read }, {
      target,
      job: env.CLOUD_RUN_JOB,
      instanceConnectionName: env.PRIMARY_INSTANCE_CONNECTION_NAME,
      database: "tibotattle",
      schema: "tibotattle_runtime",
      iamUser: "example-runtime@example-ops-prod1.iam",
      taskTimeoutSeconds: 14_400,
    });
    assert.deepEqual({ ...await job.resolveAnalyticsRefreshDatabase(env, { schema: "tibotattle_runtime" }) }, {
      kind: "cloud-sql", target, instanceConnectionName: env.PRIMARY_INSTANCE_CONNECTION_NAME,
      database: "tibotattle", iamUser: "example-runtime@example-ops-prod1.iam" });
    // The schema is PRIMARY_SCHEMA and nothing else.
    await assert.rejects(job.resolveAnalyticsRefreshDatabase(env, { schema: "tibotattle_other" }),
      { code: "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN" });
    assert.equal(job.analyticsRefreshTaskTimeoutMs(env, read), 14_400_000);
  }
  // The contract C-INFRA renders.
  assert.deepEqual([...job.ANALYTICS_REFRESH_PRODUCTION_ENV], ["ANALYTICS_REFRESH_TARGET",
    "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "POSTGRES_IAM_USER",
    "ANALYTICS_V2_MEMORY_BUDGET_MIB"]);
  const profile = job.ANALYTICS_REFRESH_PRODUCTION_JOB;
  assert.deepEqual({ cpu: profile.cpu, memory: profile.memory, heapMiB: profile.heapMiB,
    memoryBudgetMiB: profile.memoryBudgetMiB, taskTimeoutSeconds: profile.taskTimeoutSeconds, tasks: profile.tasks,
    maxRetries: profile.maxRetries, workers: profile.workers }, { cpu: "4", memory: "16Gi", heapMiB: 12_288,
    memoryBudgetMiB: 10_752, taskTimeoutSeconds: 14_400, tasks: 1, maxRetries: 0, workers: 1 });
  // Inline until MEAS-3 measures the compute Workers on real owners (K-CORE-A review).
  assert.deepEqual([...profile.args], ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]);
  // The rendered invocation parses to the real clock and PRIMARY_SCHEMA.
  const parsed = job.parseAnalyticsRefreshArguments(profile.args.slice(2), productionEnvironment());
  assert.deepEqual({ ...parsed }, { help: false, mode: "full", schema: "tibotattle_runtime", nowMs: null,
    revisionSeed: 0, workers: 1 });
  // The profile's heap holds the budget, the reserves and the minimum output
  // budget, and the task memory all of it with room for native memory.
  const MIB = 1_048_576;
  assert.ok(job.analyticsRefreshResources(productionEnvironment(), profile.heapMiB * MIB,
    { workers: profile.workers }).requiredHeapBytes <= profile.heapMiB * MIB);
  const memory = job.ANALYTICS_REFRESH_TASK_MEMORY_CHECK;
  assert.ok(profile.heapMiB <= memory.taskMemoryMiB - memory.nativeReserveMiB);
});

test("production target: C-REFRESH's contract alone governs the job; CR-3 has no analytics-job profile", async () => {
  // Owner round 12 (OWN-20.1): CR-3's analytics-job profiles and the equality
  // pin between the two contracts are retired. CR-3 refuses either profile,
  // so no CR-3 read can configure this job, and the job's own policy is its own.
  const configuration = await import("../cloud-run/postgres-production-configuration.mjs");
  for (const [target, profile] of [["production", "analytics-job"], ["staging", "staging-analytics-job"]]) {
    assert.equal(configuration.PRODUCTION_CONFIGURATION_PROFILES.includes(profile), false, profile);
    assert.throws(() => configuration.readProductionConfiguration(productionEnvironment(target), profile),
      { code: "PRODUCTION_PROFILE_INVALID" }, profile);
    // The refresh contract reads the same environment on its own.
    const read = await job.readAnalyticsRefreshProductionTarget(productionEnvironment(target));
    assert.equal(typeof read.instanceConnectionName, "string", target);
  }
  // The job's policy stays closed and frozen; it is no mirror any more.
  const policy = job.ANALYTICS_REFRESH_CR3_POLICY;
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.forbiddenVariables) && Object.isFrozen(policy.fingerprint));
  assert.deepEqual(Object.keys(policy), ["forbiddenVariables", "forbiddenPrefixes", "stagingMarker", "productionMarker",
    "fingerprint"]);
  for (const name of policy.forbiddenVariables) {
    await refusedTarget(productionEnvironment("production", { [name]: "" }), "ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", name);
  }
  // Values the refresh contract refuses on its own.
  for (const [name, value] of [
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "ex:us-east1:primary"],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:useast1:example-primary"],
    ["PRIMARY_DATABASE", "tibotattle-db"],
    ["PRIMARY_SCHEMA", "pg_catalog"],
    ["PRIMARY_SCHEMA", "Runtime"],
    ["POSTGRES_IAM_USER", "bad user"],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", job.ANALYTICS_REFRESH_PRODUCTION_ENV.length === 6
      ? "tibotattle:us-east1:tibotattle-test-primary-20260922" : ""],
  ]) {
    const env = productionEnvironment("production", { [name]: value });
    await assert.rejects(job.readAnalyticsRefreshProductionTarget(env), (error) =>
      ["ANALYTICS_V2_REFRESH_ENV_INVALID", "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN"].includes(error.code)
        && error.field === name, `${name} (refresh)`);
  }
  // A staging run never names a production resource of the fingerprint.
  await refusedTarget(productionEnvironment("staging", { CLOUD_RUN_JOB: "app-usagemonitor-production" }),
    "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", "CLOUD_RUN_JOB");
  // Plane markers (CR-3's convention).
  await refusedTarget(productionEnvironment("production", {
    PRIMARY_INSTANCE_CONNECTION_NAME: "example-ops-prod1:us-east1:example-staging-primary" }),
  "ANALYTICS_V2_REFRESH_PLANE_MISMATCH", "PRIMARY_INSTANCE_CONNECTION_NAME");
  await refusedTarget(productionEnvironment("production", { CLOUD_RUN_JOB: "example-staging-refresh" }),
    "ANALYTICS_V2_REFRESH_PLANE_MISMATCH", "CLOUD_RUN_JOB");
  await refusedTarget(productionEnvironment("staging", { CLOUD_RUN_JOB: "example-analytics-refresh" }),
    "ANALYTICS_V2_REFRESH_PLANE_MISMATCH", "CLOUD_RUN_JOB");
  await refusedTarget(productionEnvironment("staging", {
    PRIMARY_INSTANCE_CONNECTION_NAME: "example-ops-prod1:us-east1:example-staging-production" }),
  "ANALYTICS_V2_REFRESH_PLANE_MISMATCH", "PRIMARY_INSTANCE_CONNECTION_NAME");
});

test("production target: every other variable, test seam, test target and context is refused", async () => {
  const env = productionEnvironment();
  for (const value of ["", "prod", "Production", "test", "local", "production "]) {
    await refusedTarget({ ...env, ANALYTICS_REFRESH_TARGET: value }, "ANALYTICS_V2_REFRESH_TARGET_INVALID");
  }
  // The test clock, even empty.
  await refusedTarget({ ...env, ANALYTICS_V2_TEST_CLOCK: "1" }, "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN");
  await refusedTarget({ ...env, ANALYTICS_V2_TEST_CLOCK: "" }, "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN");
  // CR-3's production-forbidden variables and prefixes, key credentials, and
  // anything else in the closed namespaces (the other resource knobs, the
  // rehearsal's seams, a ledger, a second schema).
  for (const name of ["POSTGRES_TEST_HTTP_MODE", "ACCESS_TEST_JWKS_JSON", "EDGE_PROOF_SECRET", "LEDGER_SCHEMA",
    "LEDGER_ANYTHING", "HOST_RATE_LIMIT_X", "GOOGLE_APPLICATION_CREDENTIALS", "ANALYTICS_V2_MAX_DAY_OCCURRENCES",
    "ANALYTICS_V2_MAX_DAY_RECORD_MIB", "ANALYTICS_V2_READ_CHUNK_OCCURRENCES", "ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS",
    "ANALYTICS_V2_ENABLED", "ANALYTICS_V2_TEST_NOW_MS", "PG_TEST_SOCKET", "PG_TEST_HOST", "PRIMARY_EXTRA",
    "POSTGRES_MIGRATOR_IAM_USER", "ANALYTICS_REFRESH_SCHEMA",
    // The libpq-style variables node-pg reads for anything the pool does not
    // set explicitly (session options, TLS mode, a password, timeouts, a host).
    "PGOPTIONS", "PGSSLMODE", "PGPASSWORD", "PGCONNECT_TIMEOUT", "PGHOST", "PGUSER", "PGDATABASE", "PGAPPNAME",
    // Node runtime variables that change the code loaded, the driver or TLS trust.
    ...job.ANALYTICS_REFRESH_RUNTIME_FORBIDDEN]) {
    await refusedTarget({ ...env, [name]: "" }, "ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", name);
    await refusedTarget({ ...env, [name]: "-c default_transaction_read_only=on" }, "ANALYTICS_V2_REFRESH_ENV_FORBIDDEN",
      name);
  }
  assert.deepEqual([...job.ANALYTICS_REFRESH_RUNTIME_FORBIDDEN], ["NODE_OPTIONS", "NODE_PG_FORCE_NATIVE",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"]);
  assert.equal(job.ANALYTICS_REFRESH_CLOSED_PREFIXES.includes("PG"), true);
  // Platform and image variables outside the closed names are tolerated (the
  // node image sets NODE_VERSION; OPS-10 renders DEPLOYMENT_SOURCE_COMMIT).
  const tolerated = await job.readAnalyticsRefreshProductionTarget({ ...env, NODE_VERSION: "22.16.0",
    YARN_VERSION: "1.22.22", DEPLOYMENT_SOURCE_COMMIT: "b".repeat(40), CLOUD_RUN_EXECUTION: "example-execution",
    CLOUD_RUN_TASK_ATTEMPT: "0", PATH: "/usr/local/bin", HOME: "/root" });
  assert.equal(tolerated.target, "production");
  // One task of a Cloud Run Job, never a service.
  for (const context of [without(env, "CLOUD_RUN_JOB"), { ...env, CLOUD_RUN_JOB: "" },
    { ...env, CLOUD_RUN_JOB: "Analytics_Refresh" }, { ...env, K_SERVICE: "example-origin" },
    { ...env, CLOUD_RUN_TASK_INDEX: "1" }, { ...env, CLOUD_RUN_TASK_COUNT: "2" }, without(env, "CLOUD_RUN_TASK_INDEX"),
    without(env, "CLOUD_RUN_TASK_COUNT")]) {
    await refusedTarget(context, "ANALYTICS_V2_REFRESH_CONTEXT_INVALID");
  }
  // Every contract variable is required and well formed.
  for (const name of job.ANALYTICS_REFRESH_PRODUCTION_ENV.slice(1)) {
    await refusedTarget(without(env, name), "ANALYTICS_V2_REFRESH_ENV_MISSING", name);
    await refusedTarget({ ...env, [name]: "" }, "ANALYTICS_V2_REFRESH_ENV_MISSING", name);
  }
  await refusedTarget({ ...env, ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752.0" }, "ANALYTICS_V2_REFRESH_ENV_INVALID",
    "ANALYTICS_V2_MEMORY_BUDGET_MIB");
  await refusedTarget({ ...env, PRIMARY_SCHEMA: "pg_toast" }, "ANALYTICS_V2_REFRESH_ENV_INVALID", "PRIMARY_SCHEMA");
  // Test and rehearsal targets: the IAM test and fast-path resources by
  // identity, and test or rehearsal names, prefixes and scratch instances.
  const iam = CLOUD_RUN_IAM_TEST_TARGET;
  const fastpath = FASTPATH_TEST_CLOUD_TARGET;
  for (const [name, value] of [
    ["PRIMARY_INSTANCE_CONNECTION_NAME", iam.postgres.primary.instanceConnectionName],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", fastpath.instanceConnectionName],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:us-east1:example-primary-rehearsal-0123abcd"],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:us-east1:example-test-primary"],
    ["PRIMARY_DATABASE", fastpath.database],
    ["PRIMARY_DATABASE", "tibotattle_test"],
    ["PRIMARY_SCHEMA", iam.postgres.primary.schema],
    ["PRIMARY_SCHEMA", fastpath.primarySchema],
    ["PRIMARY_SCHEMA", "typed_legacy_transfer_rehearsal_target_fastpath_0123abcd"],
    ["PRIMARY_SCHEMA", "tibotattle_fastpath_20261002"],
    ["PRIMARY_SCHEMA", "tibotattle_test_runtime"],
    ["PRIMARY_SCHEMA", "runtime_rehearsal"],
    ["POSTGRES_IAM_USER", iam.postgres.iamUser],
    ["POSTGRES_IAM_USER", `${fastpath.iamUser}.gserviceaccount.com`],
    ["CLOUD_RUN_JOB", fastpath.refreshJob],
    ["CLOUD_RUN_JOB", "example-analytics-refresh-test"],
    ["CLOUD_RUN_JOB", "app-usagemonitor-production"],
  ]) {
    await refusedTarget({ ...env, [name]: value }, "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", name);
  }
});

test("production target: --schema, --now and --revision-seed are refused before any connection", async () => {
  for (const flag of ["--schema=tibotattle_runtime", "--now=2026-10-01T12:00:00.000Z", "--revision-seed=7"]) {
    assert.throws(() => job.parseAnalyticsRefreshArguments(["--mode=full", flag], productionEnvironment()),
      (error) => error.code === "ANALYTICS_V2_REFRESH_ARGUMENT_FORBIDDEN" && error.usage === true
        && error.field === flag.slice(2, flag.indexOf("=")), flag);
    // An invalid target is refused the same way: the flags never reach it.
    assert.throws(() => job.parseAnalyticsRefreshArguments(["--mode=full", flag], { ANALYTICS_REFRESH_TARGET: "x" }),
      { code: "ANALYTICS_V2_REFRESH_ARGUMENT_FORBIDDEN" }, flag);
  }
  // Configuration refusals end the run before any pool, connector or module.
  let created = 0;
  for (const [env, code] of [
    [{ ...productionEnvironment(), ANALYTICS_V2_TEST_CLOCK: "1" }, "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN"],
    [{ ...productionEnvironment(), ANALYTICS_V2_READ_CHUNK_OCCURRENCES: "10000" }, "ANALYTICS_V2_REFRESH_ENV_FORBIDDEN"],
    [productionEnvironment("production", { PRIMARY_SCHEMA: "tibotattle_fastpath_20261001" }),
      "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN"],
  ]) {
    await assert.rejects(job.runAnalyticsRefresh({ argv: ["--mode=full"], env, dependencies: {
      createPool: () => { created += 1; return {}; }, createConnector: () => { created += 1; return {}; },
      modules: { get store() { created += 1; return {}; }, pipeline: {} } } }),
    (error) => error.code === code && error.phase === "configuration", code);
  }
  assert.equal(created, 0);
  // Under a production target the task timeout is the profile's; elsewhere it is opt-in and bounded.
  assert.equal(job.analyticsRefreshTaskTimeoutMs({}, null), null);
  assert.equal(job.analyticsRefreshTaskTimeoutMs({ ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: "3600" }, null), 3_600_000);
  for (const value of ["59", "604801", "1e3", "-1", " 60"]) {
    assert.throws(() => job.analyticsRefreshTaskTimeoutMs({ ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: value }, null),
      (error) => error.code === "ANALYTICS_V2_REFRESH_RESOURCES_INVALID"
        && error.field === "ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS", value);
  }
});

test("time guard (K-PAR): remaining owners are spread over the workers, never faster than the largest alone", () => {
  const model = job.ANALYTICS_REFRESH_TIME_MODEL;
  const clock = 1_000_000;
  const owner = (digit, usage) => ({ ownerDigest: digit.repeat(64), admitted: true, occurrences: usage, analysisUsage: usage });
  const ms = (usage) => (model.readMsPerOccurrence + model.prepareMsPerOccurrence + model.scalarMsPerAnalysisUsage
    + model.modelMsPerAnalysisUsage) * usage;
  const owners = [owner("a", 400_000), owner("b", 400_000), owner("c", 400_000), owner("d", 400_000)];
  // Four equal owners: four times one owner inline, one owner over four workers.
  const timeout = Math.ceil(ms(400_000) * 2 + model.exitMarginMs + model.writeFixedMs);
  const guardAt = () => job.createAnalyticsRefreshTimeGuard({ startedAtMs: 1_000_000, taskTimeoutMs: timeout,
    wallClock: () => clock });
  assert.throws(() => guardAt().checkpoint({ kind: "plan", owners }), { code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" });
  assert.throws(() => guardAt().checkpoint({ kind: "plan", owners, workers: 1 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" });
  const parallel = guardAt();
  parallel.checkpoint({ kind: "plan", owners, workers: 4 });
  assert.equal(parallel.summary().plannedSeconds, Math.ceil(ms(400_000) / 1_000));
  // Owners start out of order; a step names its own owner.
  parallel.checkpoint({ kind: "owner", index: 2, ownerDigest: owners[2].ownerDigest, accountBytes: 0 });
  parallel.checkpoint({ kind: "owner", index: 0, ownerDigest: owners[0].ownerDigest, accountBytes: 0 });
  parallel.checkpoint({ kind: "ownerDone", index: 2, accountBytes: 0 });
  parallel.checkpoint({ kind: "model", ownerIndex: 0, index: 0, accountBytes: 0 });
  // One owner larger than the others' share keeps the projection at its own length.
  const skewed = guardAt();
  assert.throws(() => skewed.checkpoint({ kind: "plan", owners: [owner("a", 900_000), owner("b", 10)], workers: 4 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" }, "the largest owner bounds the parallel projection");
  for (const workers of [0, 1.5, "4"]) {
    assert.throws(() => guardAt().checkpoint({ kind: "plan", owners, workers }), { code: "ANALYTICS_V2_REFRESH_DEADLINE_INVALID" });
  }
  assert.throws(() => parallel.checkpoint({ kind: "ownerDone", index: 9, accountBytes: 0 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_INVALID" });
});

test("time guard: refuses a hopeless plan, an owner that cannot finish and a step that could cross the deadline", () => {
  const model = job.ANALYTICS_REFRESH_TIME_MODEL;
  let clock = 1_000_000;
  const guardAt = (taskTimeoutMs) => job.createAnalyticsRefreshTimeGuard({ startedAtMs: 1_000_000, taskTimeoutMs,
    wallClock: () => clock });
  // Inert without a task timeout.
  const inert = guardAt(null);
  assert.equal(inert.active, false);
  inert.checkpoint({ kind: "plan", owners: [{ admitted: true, occurrences: 1e12, analysisUsage: 1e12 }] });
  assert.equal(inert.summary(), null);

  const hour = 3_600_000;
  const owners = [
    { ownerDigest: OWNER_A, admitted: true, occurrences: 360_000, analysisUsage: 294_000 },
    { ownerDigest: OWNER_B, admitted: false, occurrences: 1e9, analysisUsage: 1e9 },
  ];
  const ownerMs = (model.readMsPerOccurrence + model.prepareMsPerOccurrence) * 360_000
    + (model.scalarMsPerAnalysisUsage + model.modelMsPerAnalysisUsage) * 294_000;
  const refuseAt = (timeout, accountBytes = 0) => 1_000_000 + timeout - model.exitMarginMs - model.writeFixedMs
    - model.writeMsPerAccountMiB * accountBytes / 1_048_576;
  // A plan that fits; a refused owner costs nothing.
  const guard = guardAt(hour);
  guard.checkpoint({ kind: "read" });
  guard.checkpoint({ kind: "plan", owners });
  assert.deepEqual({ ...guard.summary() }, { taskTimeoutSeconds: 3_600, plannedSeconds: Math.ceil(ownerMs / 1_000) });
  guard.checkpoint({ kind: "owner", index: 0, ownerDigest: OWNER_A, accountBytes: 0 });
  // A step is projected at stepFactor times the measured rate.
  const segmentStep = model.stepFactor * (model.readMsPerOccurrence + model.prepareMsPerOccurrence) * 100_000;
  clock = Math.floor(refuseAt(hour) - segmentStep) - 1;
  guard.checkpoint({ kind: "segment", index: 0, occurrences: 100_000, accountBytes: 0 });
  clock += 2;
  assert.throws(() => guard.checkpoint({ kind: "segment", index: 1, occurrences: 100_000, accountBytes: 0 }), (error) => {
    assert.equal(error.code, "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED");
    assert.deepEqual(Object.keys(error.deadline).sort(), ["elapsedSeconds", "ownersPlanned", "ownersStarted",
      "projectedSeconds", "refuseAtSeconds", "taskTimeoutSeconds"]);
    assert.equal(error.deadline.ownersStarted, 1);
    assert.equal(error.deadline.ownersPlanned, 2);
    return true;
  });
  // The owner's scalar fit over its analysis rows.
  const scalarStep = model.stepFactor * model.scalarMsPerAnalysisUsage * 294_000;
  clock = Math.floor(refuseAt(hour) - scalarStep) - 1;
  guard.checkpoint({ kind: "scalar", accountBytes: 0 });
  clock += 2;
  assert.throws(() => guard.checkpoint({ kind: "scalar", accountBytes: 0 }), (error) => {
    assert.equal(error.code, "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED");
    assert.equal(error.deadline.projectedSeconds, Math.ceil(scalarStep / 1_000));
    return true;
  });
  // A model date: the owner's analysis rows over the 70 dates.
  const modelStep = model.stepFactor * model.modelMsPerAnalysisUsage * 294_000 / 70;
  clock = Math.floor(refuseAt(hour) - modelStep) + 1;
  assert.throws(() => guard.checkpoint({ kind: "model", index: 0, accountBytes: 0 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });
  // The write projection grows with the output account.
  clock = Math.floor(refuseAt(hour, 512 * 1_048_576)) + 1;
  guard.checkpoint({ kind: "community", accountBytes: 0 });
  assert.throws(() => guard.beforeWrite(512 * 1_048_576), { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });
  // Past the refusal point every checkpoint refuses.
  clock = refuseAt(hour) + 1;
  assert.throws(() => guard.checkpoint({ kind: "read" }), { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });

  // A plan that cannot finish even at the measured rates is refused at once.
  clock = 1_000_000;
  const short = guardAt(Math.floor(ownerMs) + model.exitMarginMs + model.writeFixedMs - 1);
  assert.throws(() => short.checkpoint({ kind: "plan", owners }), (error) => {
    assert.equal(error.code, "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED");
    assert.equal(error.deadline.projectedSeconds, Math.ceil(ownerMs / 1_000));
    assert.equal(error.deadline.ownersStarted, 0);
    return true;
  });
  // So is an owner whose remaining owners cannot finish, after time has passed.
  const later = guardAt(Math.ceil(ownerMs) + model.exitMarginMs + model.writeFixedMs + 10_000);
  later.checkpoint({ kind: "plan", owners });
  clock += 20_000;
  assert.throws(() => later.checkpoint({ kind: "owner", index: 0, ownerDigest: OWNER_A, accountBytes: 0 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" });
  // Closed inputs.
  for (const options of [{ startedAtMs: 1.5, taskTimeoutMs: hour, wallClock: () => 0 },
    { startedAtMs: 0, taskTimeoutMs: 0, wallClock: () => 0 }, { startedAtMs: 0, taskTimeoutMs: hour }]) {
    assert.throws(() => job.createAnalyticsRefreshTimeGuard(options), { code: "ANALYTICS_V2_REFRESH_DEADLINE_INVALID" });
  }
  const unplanned = guardAt(hour);
  clock = 1_000_000;
  assert.throws(() => unplanned.checkpoint({ kind: "owner", index: 0, accountBytes: 0 }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_INVALID" });
});

test("default wiring: A-2 segment loads read only their days, in spans of the read chunk, and stay inside the range", async () => {
  const { calls, modules } = wiringModules({ ownerAEvidence: ["2024-11-03", "2026-09-29"] });
  const pipeline = job.createAnalyticsV2Pipeline(modules);
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS,
    state: specState({ cursor: null, carriedBlockedDays: [], cacheFloorDay: null }) });
  const range = inputs.occurrenceRange;
  const segment = { fromDay: "2024-11-01", throughDay: "2024-12-30" };
  calls.occurrences.length = 0;
  const loaded = await inputs.loadOwnerOccurrences(OWNER_A, segment);
  assert.deepEqual([...loaded.keys()], ["2024-11-03"]);
  for (const stream of ["usage", "quota", "session"]) {
    const reads = calls.occurrences.filter((call) => call.stream === stream);
    assert.deepEqual(spannedDays(reads), spannedDays([segment]), stream);
  }
  for (const bad of [{ fromDay: range.fromDay, throughDay: "2026-10-02" },
    { fromDay: "2024-10-01", throughDay: "2024-10-02" }, { fromDay: "2024-12-30", throughDay: "2024-11-01" },
    { fromDay: "2024-11-1", throughDay: "2024-12-30" }, null]) {
    if (bad !== null && bad.fromDay >= range.fromDay && bad.throughDay <= range.throughDay && bad.fromDay <= bad.throughDay
        && /^\d{4}-\d{2}-\d{2}$/u.test(bad.fromDay)) continue;
    await assert.rejects(inputs.loadOwnerOccurrences(OWNER_A, bad), { code: "ANALYTICS_V2_REFRESH_RANGE_INVALID" },
      JSON.stringify(bad));
  }
});

test("PG17: the production target path runs a full refresh on the real clock and reports its target", {
  skip: PG_SKIP,
  timeout: 300_000,
}, async () => {
  await withDatabase("production-path", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    await seedBaseCorpus(pool, schema);
    const databases = [];
    const env = productionEnvironment("production", { PRIMARY_SCHEMA: schema, ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024" });
    let computed = 0;
    const productionRun = () => job.runAnalyticsRefresh({
      argv: ["--mode=full"],
      env,
      dependencies: {
        modules: { store, pipeline: createSpecPipeline({ beforeCompute: () => { computed += 1; } }) },
        kernelIdentity,
        createConnector: () => ({ close() {} }),
        // The Cloud SQL target resolved from the contract, served by the local cluster.
        createPool: async (database) => {
          databases.push(database);
          return jobPool(await job.resolveAnalyticsRefreshDatabase(jobEnvironment()));
        },
        closeResources: async ({ pools }) => { for (const value of pools) await value.end(); },
      },
    });
    // REV-SEED: without the cutover's revision floor a production run refuses
    // in the read snapshot, before compute, and writes nothing (no run row).
    const untouched = await analyticsSnapshot(pool, schema);
    await assert.rejects(productionRun(), (error) => {
      assert.equal(error.code, "ANALYTICS_V2_REVISION_FLOOR_ABSENT");
      assert.equal(error.phase, "read");
      return true;
    });
    assert.equal(computed, 0, "nothing was computed");
    assert.deepEqual(await analyticsSnapshot(pool, schema), untouched);
    assert.equal((await runRows(pool, schema)).length, 0);
    await loadSpecFloor(pool, schema, { [DAY_2]: 3 });
    databases.length = 0;
    const before = Date.now();
    const run = await productionRun();
    assert.equal(run.state, "complete");
    assert.deepEqual(run.revisionFloor, { present: true, dayCount: 1, maxRevision: 3 });
    assert.equal((await publishedRows(pool, schema)).get(DAY_2).revision, 4);
    assert.equal(run.target, "production");
    assert.equal(run.schema, schema);
    assert.equal(run.clock, "wall");
    assert.equal(run.revisionSeed, 0);
    assert.ok(Date.parse(run.now) >= before && Date.parse(run.now) <= Date.now(), "the real clock");
    assert.deepEqual(databases.map(({ kind, target, database, iamUser }) => ({ kind, target, database, iamUser })),
      [{ kind: "cloud-sql", target: "production", database: "tibotattle", iamUser: "example-runtime@example-ops-prod1.iam" }]);
    // The profile's task timeout arms the time guard.
    assert.deepEqual(run.timeGuard, { taskTimeoutSeconds: 14_400, plannedSeconds: null });
    assert.equal((await runRows(pool, schema)).length, 1);
  });
});

test("PG17: the time guard refuses with a receipt before the deadline and writes nothing", {
  skip: PG_SKIP,
  timeout: 600_000,
}, async () => {
  const corpus = synthetic.composeProofCorpus();
  const facts = new Map(synthetic.COMPOSE_OWNERS.map((owner) => [owner.digest, synthetic.composeFacts(owner)]));
  const pipeline = syntheticPipeline({ owners: corpus.owners, facts, journal: journalOf(corpus.publishedDays) });
  await withDatabase("time-guard", async ({ pool, createSchema }) => {
    const { schema } = await createSchema();
    const now = new Date(synthetic.NOW_MS).toISOString();
    const before = await analyticsSnapshot(pool, schema);
    // The clock jumps an hour after the plan: the next checkpoint is past the
    // refusal point of a one-hour task.
    let calls = 0;
    let base = null;
    const wallClock = () => {
      base ??= Date.now();
      calls += 1;
      return base + (calls > 3 ? 3_600_000 : 0);
    };
    await assert.rejects(job.runAnalyticsRefresh({
      argv: ["--mode=full", `--schema=${schema}`, `--now=${now}`],
      env: jobEnvironment({ ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: "3600" }),
      dependencies: { modules: { store, pipeline }, createPool: jobPool, wallClock, kernelIdentity },
    }), (error) => {
      assert.equal(error.code, "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED");
      assert.ok(["read", "compute"].includes(error.phase), error.phase);
      assert.equal(error.deadline.taskTimeoutSeconds, 3_600);
      assert.ok(error.deadline.elapsedSeconds >= 3_600);
      assert.ok(error.deadline.refuseAtSeconds < 3_600);
      return true;
    });
    assert.deepEqual(await analyticsSnapshot(pool, schema), before, "nothing is written");
    // The lock was released: a run with time completes.
    const run = await runJob({ schema, now, pipeline, env: jobEnvironment({ ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: "3600" }) });
    assert.equal(run.state, "complete");
    assert.equal(run.timeGuard.taskTimeoutSeconds, 3_600);
    assert.ok(Number.isSafeInteger(run.timeGuard.plannedSeconds));

    // An output account over the output budget is refused the same way.
    // (A-2's exact account and refusal are pinned in compute.spec.ts.)
    const MIB = 1_048_576;
    const afterRun = await analyticsSnapshot(pool, schema);
    const refused = await job.runAnalyticsRefresh({
      argv: ["--mode=full", `--schema=${schema}`, `--now=${now}`],
      env: jobEnvironment(),
      dependencies: { modules: { store, pipeline: {
        read: pipeline.read,
        compute: async () => {
          throw Object.assign(new Error("ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED"), {
            code: "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED", accountBytes: 70 * MIB + 1, outputBudgetBytes: 70 * MIB });
        },
      } }, createPool: jobPool, kernelIdentity },
    }).then(() => null, (error) => error);
    assert.equal(refused?.code, "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED");
    assert.equal(refused.phase, "compute");
    assert.deepEqual({ ...refused.outputAccount }, { accountMiB: 71, outputBudgetMiB: 70 });
    assert.deepEqual(await analyticsSnapshot(pool, schema), afterRun, "nothing is written");
  });
});

test("the source entry prints a deadline refusal's figures and exits 1, before any connection", { timeout: 120_000 }, async () => {
  // A one-minute task leaves no time after the exit margin and the write: it
  // is refused at the start, before modules, pools or the lock.
  const node22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
  const available = await access(node22).then(() => true, () => false);
  assert.ok(available, "Node v22.16.0 is required for the image runtime check");
  const result = await execFileAsync(node22,
    ["--max-old-space-size=6144", JOB_PATH, "--mode=full", "--schema=analytics_v2_deadline_cli", `--now=${NOW_1}`], {
      env: { ANALYTICS_V2_TEST_CLOCK: "1", PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-unused/socket",
        ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: "60", PATH: process.env.PATH },
      cwd: WORKER_ROOT,
    }).then(() => null, (error) => error);
  assert.equal(result?.code, 1);
  assert.equal(result.stdout, "");
  const line = JSON.parse(result.stderr.trim());
  assert.equal(line.code, "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED");
  assert.equal(line.phase, "configuration");
  assert.deepEqual(Object.keys(line).sort(), ["code", "deadline", "phase", "schemaVersion", "status"]);
  assert.deepEqual(Object.keys(line.deadline).sort(), ["elapsedSeconds", "ownersPlanned", "ownersStarted",
    "refuseAtSeconds", "taskTimeoutSeconds"]);
  assert.equal(line.deadline.taskTimeoutSeconds, 60);
  assert.equal(line.deadline.ownersPlanned, null);
});
