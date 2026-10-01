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
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import * as job from "../cloud-run/analytics-refresh.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import * as seedFixture from "./fixtures/analytics-v2/direct-seed.mjs";
import * as synthetic from "../analytics-v2-test/fixtures/synthetic-occurrences.mjs";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_PATH = join(WORKER_ROOT, "cloud-run", "analytics-refresh.mjs");
const STAGED_FILE = "0059_analytics_v2.sql";
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
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
        stagedFiles: [STAGED_FILE],
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
      };
    },
  };
}

function jobEnvironment(extra = {}) {
  const env = { ANALYTICS_V2_TEST_CLOCK: "1", ...extra };
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
    dependencies: { modules: { store, pipeline }, createPool },
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

test("PG17: 0059 applies on the 58 stock primary migrations and creates exactly the contract tables", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  await withDatabase("schema", async ({ pool, createSchema }) => {
    const stock = await readPostgresMigrations({ role: "primary" });
    const { schema, applied } = await createSchema();
    const stagedCount = applied.staged.length;
    assert.equal(stock.length + stagedCount, 59, "58 stock migrations plus the staged 0059");
    const history = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, "_tibotattle_migration_history")}`);
    assert.equal(history.rows[0].n, stock.length, "staged SQL is not recorded as a migration receipt");

    const tables = await pool.query(
      `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname LIKE 'analytics\\_v2\\_%'
        ORDER BY 1`,
      [schema],
    );
    assert.deepEqual(tables.rows.map((row) => row.name), Object.values(contract.ANALYTICS_V2_TABLES).sort());
    for (const [key, table] of Object.entries(contract.ANALYTICS_V2_TABLES)) {
      const columns = await pool.query(
        `SELECT column_name::text AS name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      );
      assert.deepEqual(columns.rows.map((row) => row.name), [...contract.ANALYTICS_V2_COLUMNS[key]], table);
      const primaryKey = await pool.query(
        `SELECT a.attname::text AS name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey::int2[], a.attnum)`,
        [`"${schema}"."${table}"`],
      );
      assert.deepEqual(primaryKey.rows.map((row) => row.name), [...contract.ANALYTICS_V2_PRIMARY_KEYS[key]], table);
    }
    const otherSchemas = await pool.query(
      `SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname LIKE 'analytics\\_v2\\_%' AND n.nspname = 'public'`,
    );
    assert.equal(otherSchemas.rows[0].n, 0, "nothing escaped into public");
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
      const ownerDay = `INSERT INTO ${quoted(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id)
                        VALUES ($1, $2, $3::jsonb, $4, $5)`;
      await expectRefusal(ownerDay, [OWNER_A.toUpperCase(), DAY_1, "{}", null, runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, null, null, runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, "{}", "usage_window_unrepresentable", runId], "23514");
      await expectRefusal(ownerDay, [OWNER_A, DAY_1, null, "free_form_reason", runId], "23514");
      // The owner-day CHECK accepts exactly the contract's owner-day reasons.
      // The cache-only reasons never replace prepared daily values, so 0059
      // refuses them there; together the two loops cover every closed reason.
      assert.deepEqual(
        [...contract.ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS, ...contract.ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS].sort(),
        [...contract.ANALYTICS_V2_REFUSAL_REASONS].sort(),
      );
      for (const reason of contract.ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS) {
        await accept(ownerDay, [OWNER_A, DAY_1, null, reason, runId]);
      }
      for (const reason of contract.ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS) {
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
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon: STAND_IN_HORIZON,
      }), { code: "ANALYTICS_V2_REFRESH_LOCK_NOT_HELD" });
      assert.deepEqual(await analyticsSnapshot(pool, schema), before);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [contract.ANALYTICS_V2_REFRESH_LOCK_KEY]);
      holder.release();
      writer.release();
    }
  });
});

function minimalOutputs(overrides = {}) {
  const nowMs = Date.parse(NOW_1);
  return {
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
        schema, runId: randomUUID(), startedAtMs: Date.now(), expectedCursor: null, horizon: STAND_IN_HORIZON,
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
        schema, runId: randomUUID(), startedAtMs: Date.now(), expectedCursor: null, horizon: STAND_IN_HORIZON,
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
    { POSTGRES_TEST_HTTP_MODE: "production" }, { POSTGRES_TEST_HTTP_MODE: "" }]) {
    assert.throws(() => job.parseAnalyticsRefreshArguments(["--mode=full", "--schema=s", `--now=${NOW_1}`], refused),
      { code: "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN" });
  }
  for (const allowed of [{ ANALYTICS_V2_TEST_CLOCK: "1" }, { POSTGRES_TEST_HTTP_MODE: "cloud-run-iam" },
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
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon,
      });
      const state0 = await store.readAnalyticsV2RefreshState(client, { schema });
      assert.deepEqual({ ...state0 }, { cursor: null, carriedBlockedDays: [], cacheFloorDay: null });

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
        schema, runId: randomUUID(), startedAtMs: Date.parse(NOW_1), expectedCursor: null, horizon: STAND_IN_HORIZON,
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
function wiringModules({ unlinked = [], failOwner = null, ownerAEvidence = ["2026-03-02", "2026-09-29"] } = {}) {
  const calls = { owners: 0, queued: [], occurrences: [], firstEvidence: [], devices: [], compute: null };
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
          return {
            contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION, mode: "full", nowMs: input.nowMs,
            today: utcDay(input.nowMs), revisionSeed: input.revisionSeed, owners: input.owners, ownerDays: [],
            cacheBands: [], ownerFits: [], ownerModelDates: [], preview: null, refusals: [], timings: {},
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

const WIRING_STATE = Object.freeze({ cursor: null, carriedBlockedDays: ["2026-04-10"], cacheFloorDay: "2026-02-20" });

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

  // The effective owner: every stream over the whole range, in contiguous chunks of at most 30 days.
  const rangeDays = spannedDays([required]);
  for (const stream of ["usage", "quota", "session"]) {
    const reads = calls.occurrences.filter((call) => call.ownerDigest === OWNER_A && call.stream === stream);
    assert.ok(reads.every((call) => spannedDays([call]).length <= 30));
    assert.deepEqual(spannedDays(reads), rangeDays, stream);
  }
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
  assert.deepEqual([...inputs.occurrencesByOwner.keys()], [OWNER_B, OWNER_A].sort());
  assert.deepEqual([...inputs.occurrencesByOwner.get(OWNER_B).keys()], ["2026-09-30"]);
  assert.deepEqual(inputs.occurrencesByOwner.get(OWNER_A).get("2026-09-29"),
    { usage: [occurrence(OWNER_A, "2026-09-29")], quota: [], session: [] });

  // Devices: every queued day, with the effective owners that have evidence on it.
  assert.equal(calls.devices.length, 1);
  const effectiveA = { participantId: contractOwner(OWNER_A, "effective").participantId, ownerDigest: OWNER_A,
    source: "effective" };
  assert.deepEqual([...calls.devices[0]], [
    ["2026-03-02", [effectiveA]], ["2026-04-10", []], ["2026-09-29", [effectiveA]], ["2026-09-30", []],
  ]);

  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 3 });
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
});

test("default wiring: cache history starts at the first evidence day, older than any window, queue or floor", async () => {
  // OWNER_A's first evidence is 2024-11-03, 697 days before today and never
  // queued; production builds a cache day for every delivered day.
  const { calls, modules } = wiringModules({ ownerAEvidence: ["2024-11-03", "2026-09-29"] });
  const pipeline = job.createAnalyticsV2Pipeline(modules);
  const inputs = await pipeline.read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS,
    state: { cursor: null, carriedBlockedDays: [], cacheFloorDay: null } });
  assert.equal(inputs.firstEvidenceDay, "2024-11-03");
  assert.equal(inputs.cacheFromDay, "2024-11-03");
  assert.deepEqual({ ...inputs.occurrenceRange }, { fromDay: "2024-10-27", throughDay: "2026-10-01" });
  assert.deepEqual([...inputs.occurrencesByOwner.get(OWNER_A).keys()], ["2024-11-03", "2026-09-29"]);
  const reads = calls.occurrences.filter((call) => call.ownerDigest === OWNER_A && call.stream === "usage");
  assert.deepEqual(spannedDays(reads), spannedDays([inputs.occurrenceRange]), "the whole history is read");
  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
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
  assert.equal(inputs.occurrencesByOwner.has(OWNER_A), true);
  const outputs = await pipeline.compute(inputs, { nowMs: WIRING_NOW_MS, revisionSeed: 0 });
  assert.deepEqual(outputs.dailyCandidates, []);
  assert.deepEqual(outputs.blockedDays, ["2026-03-02", "2026-04-10", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(outputs.readSummary, { unlinkedTypedOwners: 1, terminalOwners: 1, nonEffectiveUnread: 1 });

  // The same refusal for an effective owner fails the run.
  const failing = wiringModules({ failOwner: OWNER_A });
  await assert.rejects(job.createAnalyticsV2Pipeline(failing.modules)
    .read({ pool: {}, schema: "s", nowMs: WIRING_NOW_MS, state: WIRING_STATE }), { code: "ANALYTICS_V2_SOURCE_CONFLICT" });

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

      // (b) An identical rerun queues nothing new: only the carried blocked
      // days are recomputed, and no revision moves.
      const second = await runJob({ schema, now, pipeline });
      assert.equal(second.state, "complete");
      assert.deepEqual(second.published, []);
      assert.deepEqual(second.blocked, first.blocked);
      assert.deepEqual(await publishedRows(pool, schema), heads);
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
    owners: { listAnalyticsV2Owners: async () => ({ owners: corpus.owners, unlinked: [], correctionRuntimeActive: true }) },
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
