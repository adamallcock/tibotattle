// PostgreSQL 17 spec for the interim frozen public read (owner decision OD-10,
// stream C-IPR): the staged migration, the loader and the route's three states.
//
// Until GCP's first own publication, GET /api/v1/community/daily serves a
// frozen copy of Cloudflare's response:
//   (1) a publication exists                         -> the route never serves the copy again;
//   (2) none exists and a frozen export is loaded    -> the copy, labelled in headers;
//   (3) neither                                      -> exactly the answer the route gave before.
// A tampered or unreadable copy is 503, never an empty answer.
//
// Schemas: the promoted primary chain through the production runner plus the
// staged interim migration through the staged-migrations harness (or, once the
// integrator has promoted it, the stock chain alone; the spec finds the file
// by its suffix so renumbering needs no edit here). Every fixture is synthetic
// and content-free: the Q-1 oracle golden widened to a full-year window.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//   node --test postgres-test/analytics-v2-interim-public-read.spec.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { classifyContractOperations } from "../cloud-run/postgres-production-migrations.mjs";
import {
  applyStockAndStagedMigrations,
  listStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";
import { VENDORED_PACKAGE_ENTRIES, usesVendoredPackages } from "../vitest.analytics-v2.config.mjs";
import {
  denseGoldenExportBody,
  exportBytes,
  exportInput,
  goldenExportBody,
  sha256Hex,
  FIXTURE_CAPTURED_AT,
  FIXTURE_EVIDENCE_DATE,
  FIXTURE_SOURCE_COMMIT,
} from "../analytics-v2-test/fixtures/interim-public-read-export.mjs";
import {
  checkInterimPublicRead,
  loadInterimPublicRead,
  loadInterimPublicReadInTransaction,
  runInterimPublicReadLoad,
} from "../scripts/gcp-interim-public-read-load.mjs";
import { normalizeCommunityDailySeries } from "../vendor/analytics-d43c8f92/apps/web/public/community-data.js";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERIM_SUFFIX = "_interim_public_read.sql";
const TABLE = "community_daily_frozen_export";
const ORIGIN = "http://127.0.0.1:8080";
const PATH = "/api/v1/community/daily";
const FULL = "?from=2025-10-01&to=2026-10-01";
const NOW_MS = Date.parse("2026-10-02T06:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RUN_ID = "00000000-0000-4000-8000-0000000000c1";
const GOLDEN = goldenExportBody();
const GOLDEN_FIRST_DAY = GOLDEN.days[0].day;

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

let vite;
let modules;
let pool;
let migrationName;
let migrationSql;
const schemas = [];
const roles = [];

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
    resolve: { mainFields: ["module", "main"] },
    ssr: { noExternal: ["jsonc-parser"] },
  });
  return {
    route: await vite.ssrLoadModule("/src/analytics-v2/community-daily-route.ts"),
    interim: await vite.ssrLoadModule("/src/analytics-v2/interim-public-read.ts"),
    canonical: await vite.ssrLoadModule("/src/canonical-json.ts"),
    errors: await vite.ssrLoadModule("/src/errors.ts"),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const q = (schema, name) => `"${schema}"."${name}"`;

async function interimMigration() {
  const [staged, stock] = await Promise.all([
    listStagedMigrations("primary"), readPostgresMigrations({ role: "primary" }),
  ]);
  const found = [...staged, ...stock].filter(({ name }) => name.endsWith(INTERIM_SUFFIX));
  assert.equal(found.length, 1, "exactly one interim public read migration, staged or promoted");
  return found[0];
}

/** A fresh schema: the stock chain, the interim migration, and the controls open. */
async function createSchema() {
  const schema = `c_ipr_${randomBytes(6).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [migrationName] });
  await pool.query(`UPDATE ${q(schema, "collection_controls")} SET revision = revision + 1,
      control_state = 'operational', enrollment_enabled = true, upload_registration_enabled = true,
      processing_enabled = true, publication_enabled = true, reason_code = 'maintenance',
      updated_at = clock_timestamp() WHERE singleton = 1`);
  return schema;
}

/** The schema as it is before the interim migration: no frozen table and no trigger function. */
async function createSchemaWithoutFrozenTable() {
  const schema = await createSchema();
  await pool.query(`DROP TABLE ${q(schema, TABLE)}`);
  await pool.query(`DROP FUNCTION "${schema}".community_daily_frozen_export_immutable()`);
  return schema;
}

async function setPublication(schema, publication) {
  await pool.query(`UPDATE ${q(schema, "collection_controls")} SET revision = revision + 1,
      control_state = $1, publication_enabled = $2, updated_at = clock_timestamp() WHERE singleton = 1`,
  [publication ? "operational" : "degraded", publication]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The loader's own check of an export: the prepared record every load takes. */
async function prepared(body = goldenExportBody(), facts = {}) {
  const input = exportInput(body, facts);
  const { prepared: result } = await checkInterimPublicRead({
    exportBytes: input.exportBytes, sha256: input.expectedSha256, capturedAt: input.capturedAt,
    sourceCommit: input.sourceCommit, evidenceDate: input.evidenceDate,
  });
  return result;
}

async function loadFrozen(schema, body = goldenExportBody(), facts = {}) {
  return loadInterimPublicRead({ pool, schema, prepared: await prepared(body, facts) });
}

/** One GCP-published day, built from a golden day so it is a valid published head. */
async function publishDay(schema, goldenDay = GOLDEN.days.find((entry) => entry.day === "2026-09-20")) {
  assert.notEqual(goldenDay, undefined);
  const payload = goldenDay.payload;
  const { aggregateId: _a, revision: _r, releasedAt: _t, ...content } = payload;
  const digest = sha256Hex(new TextEncoder().encode(modules.canonical.canonicalJson(content)));
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_runs")}
      (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings)
    VALUES ($1, $2, $2, 'full', 'complete', 0, 0, '[]', '{"published":[],"unchanged":[],"blocked":[]}', '{}')
    ON CONFLICT DO NOTHING`, [RUN_ID, goldenDay.releasedAt]);
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")}
      (day, revision, released_at, payload, payload_sha256, run_id) VALUES ($1, $2, $3, $4, $5, $6)`,
  [goldenDay.day, goldenDay.revision, goldenDay.releasedAt, JSON.stringify(payload), digest, RUN_ID]);
  return goldenDay;
}

async function seedCacheBands(schema) {
  for (const [band, adjacencies] of [["under_one_minute", 10], ["five_to_ten_minutes", 4]]) {
    await pool.query(`INSERT INTO ${q(schema, "analytics_v2_cache_bands")}
        (owner_digest, day, model, effort, band, adjacencies, reused_more_than_half, matched_or_exceeded,
         unordered_ties, excluded_insufficient_evidence, excluded_context_contracted, sessions, run_id)
      VALUES ($1, '2026-10-01', 'gpt-6-sol', 'high', $2, $3, 2, 1, 0, 0, 0, 2, $4)`,
    ["a".repeat(64), band, adjacencies, RUN_ID]);
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function createRoute(schema, overrides = {}) {
  return modules.route.createAnalyticsV2CommunityDailyRoute({
    pool, schema, clock: () => NOW_MS, originMode: "fastpath-test", ...overrides,
  });
}

async function get(schema, query, { method = "GET", route = createRoute(schema) } = {}) {
  const response = await route.handler(new Request(`${ORIGIN}${PATH}${query}`, { method }), {});
  return { response, text: await response.text() };
}

function interimHeaders(response) {
  return Object.fromEntries(["x-tibotattle-interim-read", "x-tibotattle-evidence-date",
    "x-tibotattle-interim-sha256", "last-modified"].map((name) => [name, response.headers.get(name)]));
}

function assertNoInterimHeaders(response) {
  for (const [name, value] of Object.entries(interimHeaders(response))) {
    assert.equal(value, null, `${name} is only on the interim answer`);
  }
}

function assertStorageUnavailable({ response, text }) {
  assert.equal(response.status, 503);
  assert.match(text, /^\{"error":\{"code":"BACKEND_STORAGE_UNAVAILABLE","requestId":"[0-9a-f-]{36}"\}\}$/u);
  assert.match(JSON.parse(text).error.requestId, UUID);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertNoInterimHeaders(response);
  // Nothing of the frozen copy reaches an error.
  assert.equal(text.includes("community-daily"), false);
}

before(async () => {
  if (skip) return;
  modules = await loadModules();
  pool = new pg.Pool({
    ...endpoint, ssl: false, max: 6,
    application_name: "analytics-v2-interim-public-read-test", connectionTimeoutMillis: 5_000,
  });
  const version = await pool.query("SELECT version() AS version");
  assert.match(version.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  const migration = await interimMigration();
  migrationName = migration.name;
  migrationSql = migration.sql;
});

after(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const role of roles) await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    await pool.end();
  }
  if (vite) await vite.close();
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("the migration is additive, classified expand-compatible, and pins its trigger function's search_path", { skip }, async () => {
  assert.deepEqual(classifyContractOperations(migrationSql), [],
    "no drop, rename, tightening or dynamic SQL: no CONTRACT_MIGRATIONS entry is needed");
  const schema = await createSchema();
  const functions = await pool.query(`SELECT p.proname, p.proconfig FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY p.proname`, [schema]);
  const trigger = functions.rows.find((row) => row.proname === "community_daily_frozen_export_immutable");
  assert.ok(trigger, "the immutability trigger function exists");
  assert.ok(trigger.proconfig?.some((entry) => entry.startsWith("search_path=")), "its search_path is pinned");
  const columns = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, TABLE]);
  assert.deepEqual(columns.rows.map((row) => [row.column_name, row.data_type, row.is_nullable]), [
    ["id", "smallint", "NO"], ["payload_text", "text", "NO"], ["payload_sha256", "text", "NO"],
    ["captured_at", "timestamp with time zone", "NO"], ["source_commit", "text", "NO"],
    ["evidence_date", "date", "NO"], ["loaded_at", "timestamp with time zone", "NO"],
  ]);
});

test("the table refuses what the loader would: a wrong digest, schema, commit, evidence date or id", { skip }, async () => {
  const schema = await createSchema();
  const text = JSON.stringify(goldenExportBody());
  const row = (overrides = {}) => ({
    id: 1, payload_text: text, payload_sha256: sha256Hex(new TextEncoder().encode(text)),
    captured_at: FIXTURE_CAPTURED_AT, source_commit: FIXTURE_SOURCE_COMMIT, evidence_date: FIXTURE_EVIDENCE_DATE,
    ...overrides,
  });
  const insert = (values) => pool.query(`INSERT INTO ${q(schema, TABLE)}
      (id, payload_text, payload_sha256, captured_at, source_commit, evidence_date)
      VALUES ($1, $2, $3, $4::timestamptz, $5, $6::date)`,
  [values.id, values.payload_text, values.payload_sha256, values.captured_at, values.source_commit, values.evidence_date]);
  const bad = (sha) => `${sha.slice(0, 63)}${sha.endsWith("0") ? "1" : "0"}`;
  for (const [name, overrides] of [
    ["digest of other bytes", { payload_sha256: bad(row().payload_sha256) }],
    ["uppercase digest", { payload_sha256: row().payload_sha256.toUpperCase() }],
    ["short commit", { source_commit: "abc123" }],
    ["evidence date after capture", { evidence_date: "2026-10-02" }],
    ["evidence date two days before capture", { evidence_date: "2026-09-29" }],
    ["id other than 1", { id: 2 }],
    ["wrong schemaVersion", (() => {
      const other = text.replace("community-daily-read-v1.0", "community-daily-read-v9.9");
      return { payload_text: other, payload_sha256: sha256Hex(new TextEncoder().encode(other)) };
    })()],
    ["not an object", (() => {
      const other = "[1,2,3]";
      return { payload_text: other, payload_sha256: sha256Hex(new TextEncoder().encode(other)) };
    })()],
  ]) {
    await assert.rejects(insert(row(overrides)), (error) => error?.code === "23514", name);
  }
  await assert.rejects(insert(row({ payload_text: "not json", payload_sha256: sha256Hex(new TextEncoder().encode("not json")) })),
    (error) => error?.code === "22P02", "text that is not JSON");
  const empty = await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`);
  assert.equal(empty.rows[0].count, 0, "every refusal left the table empty");
});

test("a loaded row is immutable: no update, no delete, no second row", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  await assert.rejects(pool.query(`UPDATE ${q(schema, TABLE)} SET source_commit = $1`, ["0".repeat(40)]),
    (error) => error?.code === "P1005");
  await assert.rejects(pool.query(`DELETE FROM ${q(schema, TABLE)}`), (error) => error?.code === "P1005");
  await assert.rejects(pool.query(`INSERT INTO ${q(schema, TABLE)}
      (id, payload_text, payload_sha256, captured_at, source_commit, evidence_date)
      SELECT 1, payload_text, payload_sha256, captured_at, source_commit, evidence_date FROM ${q(schema, TABLE)}`),
  (error) => error?.code === "23505");
  const stored = await pool.query(`SELECT count(*)::int AS count, min(source_commit) AS commit FROM ${q(schema, TABLE)}`);
  assert.deepEqual(stored.rows[0], { count: 1, commit: FIXTURE_SOURCE_COMMIT });
});

test("the runtime role, granted as OPS-10 grants it, reads the frozen export and cannot rewrite it", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  const role = `c_ipr_rt_${randomBytes(4).toString("hex")}`;
  roles.push(role);
  await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  // The runtime grant policy: DML on every table, and nothing more.
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
  await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
  const runtimePool = {
    async connect() {
      const client = await pool.connect();
      await client.query(`SET ROLE "${role}"`);
      return {
        query: (text, values) => client.query(text, values),
        async release(discard) {
          await client.query("RESET ROLE").catch(() => {});
          client.release(discard);
        },
      };
    },
  };
  const { response, text } = await get(schema, FULL, { route: createRoute(schema, { pool: runtimePool }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tibotattle-interim-read"), "frozen");
  assert.equal(text, JSON.stringify(goldenExportBody()));
  const asRuntime = async (sql) => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE "${role}"`);
      return await client.query(sql);
    } finally {
      await client.query("RESET ROLE").catch(() => {});
      client.release();
    }
  };
  await assert.rejects(asRuntime(`UPDATE ${q(schema, TABLE)} SET source_commit = '${"0".repeat(40)}'`),
    (error) => error?.code === "P1005");
  await assert.rejects(asRuntime(`DELETE FROM ${q(schema, TABLE)}`), (error) => error?.code === "P1005");
  assert.equal((await asRuntime(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 1);
});

// ---------------------------------------------------------------------------
// State 3: neither
// ---------------------------------------------------------------------------

test("neither a publication nor a frozen export: exactly the answer the route gave before", { skip }, async () => {
  const withTable = await createSchema();
  const withoutTable = await createSchemaWithoutFrozenTable();
  for (const schema of [withTable, withoutTable]) await seedCacheBands(schema);
  for (const query of [FULL, "?from=2026-09-01&to=2026-09-15", "?from=2026-10-01&to=2026-10-01"]) {
    const empty = await get(withTable, query);
    const before = await get(withoutTable, query);
    assert.equal(empty.response.status, 200);
    assert.equal(empty.text, before.text, "an empty frozen table changes nothing");
    assert.equal(empty.response.headers.get("cache-control"), before.response.headers.get("cache-control"));
    assertNoInterimHeaders(empty.response);
    const body = JSON.parse(empty.text);
    assert.deepEqual(body.days, []);
    assert.equal(body.allowanceState, "updating");
    assert.equal(body.allowanceReadState, "temporarily_unavailable");
    assert.equal(empty.response.headers.get("cache-control"), "no-store");
    assert.equal(body.cacheRetention.windows.length, 4, "this line's own cache series is still served");
  }
});

// ---------------------------------------------------------------------------
// State 2: a frozen export, nothing published
// ---------------------------------------------------------------------------

test("a frozen export is served for the full window byte for byte, labelled in headers, body unchanged", { skip }, async () => {
  const schema = await createSchema();
  const receipt = await loadFrozen(schema);
  assert.equal(receipt.state, "loaded");
  const { response, text } = await get(schema, FULL);
  assert.equal(response.status, 200);
  assert.equal(text, JSON.stringify(goldenExportBody()), "the pinned export, byte for byte");
  assert.equal(sha256Hex(new TextEncoder().encode(text)), receipt.payloadSha256);
  assert.deepEqual(interimHeaders(response), {
    "x-tibotattle-interim-read": "frozen",
    "x-tibotattle-evidence-date": FIXTURE_EVIDENCE_DATE,
    "x-tibotattle-interim-sha256": receipt.payloadSha256,
    "last-modified": "Thu, 01 Oct 2026 23:30:00 GMT",
  });
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  // The label is outside the closed body: its keys are the contract's own.
  assert.deepEqual(Object.keys(JSON.parse(text)), ["schemaVersion", "from", "to", "allowanceState",
    "allowanceReadState", "allowanceBreakdowns", "cacheRetention", "days"]);
  // No private diagnostic crosses the boundary.
  for (const secret of ["capacityByPlanType", "ownerDigest", "participantId"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  // Every day keeps the revision and release time Cloudflare published.
  const days = JSON.parse(text).days;
  assert.deepEqual(days.map((day) => [day.day, day.revision, day.releasedAt]),
    GOLDEN.days.map((day) => [day.day, day.revision, day.releasedAt]));
  // The site reader of the golden's own code accepts the answer.
  const series = normalizeCommunityDailySeries(JSON.parse(text), { nowMs: NOW_MS });
  assert.equal(series.state, "published");
  assert.equal(series.days.length, GOLDEN.days.length);
});

test("a sub-range and a later window serve the overlap and echo the request", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  const inRange = (from, to) => GOLDEN.days.filter((day) => day.day >= from && day.day <= to);
  for (const [from, to] of [["2026-09-01", "2026-09-15"], ["2026-04-15", "2026-04-15"],
    ["2025-10-02", "2026-10-02"], ["2025-10-05", "2026-04-14"], ["2026-10-02", "2026-10-02"]]) {
    const { response, text } = await get(schema, `?from=${from}&to=${to}`);
    assert.equal(response.status, 200, `${from}..${to}`);
    const body = JSON.parse(text);
    assert.deepEqual([body.from, body.to], [from, to]);
    assert.deepEqual(body.days, inRange(from, to));
    assert.equal(response.headers.get("x-tibotattle-interim-read"), "frozen");
    assert.equal(response.headers.get("x-tibotattle-evidence-date"), FIXTURE_EVIDENCE_DATE);
    if (body.allowanceBreakdowns !== undefined) {
      assert.deepEqual(body.allowanceBreakdowns.days.map((row) => row.day),
        GOLDEN.allowanceBreakdowns.days.map((row) => row.day).filter((day) => day >= from && day <= to));
      assert.equal(body.allowanceState, "ready");
    } else {
      assert.equal(body.allowanceState, "updating");
    }
    assert.deepEqual(body.cacheRetention, GOLDEN.cacheRetention);
  }
  // The client's own next-day window is the golden's days, whole.
  const later = JSON.parse((await get(schema, "?from=2025-10-02&to=2026-10-02")).text);
  assert.equal(later.days.length, GOLDEN.days.length);
  assert.equal(later.allowanceState, "ready");
  assert.equal(normalizeCommunityDailySeries(later, { nowMs: NOW_MS }).state, "published");
});

test("the frozen answer keeps every guard of the ordinary route: control, limiter, parameters and method", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  assert.equal((await get(schema, FULL)).response.status, 200);
  // The publication control comes first, before parameters.
  await setPublication(schema, false);
  try {
    for (const query of [FULL, "?from=bad"]) {
      const { response, text } = await get(schema, query);
      assert.equal(response.status, 503);
      assert.equal(JSON.parse(text).error.code, "PUBLICATION_DISABLED");
      assertNoInterimHeaders(response);
    }
  } finally {
    await setPublication(schema, true);
  }
  // The public-read limiter runs once, before the parameters are validated, and its refusal is the answer.
  const calls = [];
  const limited = createRoute(schema, { assertPublicReadAllowed: async (request) => { calls.push(new URL(request.url).search); } });
  assert.equal((await get(schema, "?from=bad", { route: limited })).response.status, 400);
  assert.equal((await get(schema, FULL, { route: limited })).response.status, 200);
  assert.deepEqual(calls, ["?from=bad", FULL]);
  const refusing = createRoute(schema, { assertPublicReadAllowed: async () => {
    throw new modules.errors.ApiError(503, "ADMISSION_RATE_LIMIT_UNAVAILABLE", { responseHeaders: { "retry-after": "30" } });
  } });
  const refused = await get(schema, FULL, { route: refusing });
  assert.equal(refused.response.status, 503);
  assert.equal(refused.response.headers.get("retry-after"), "30");
  assertNoInterimHeaders(refused.response);
  // Parameters and method are the production envelope.
  for (const query of ["", "?from=2026-09-01", `${FULL}&day=2026-10-01`, "?from=2026-02-31&to=2026-03-01",
    "?from=2026-10-01&to=2026-09-30", "?from=2025-09-30&to=2026-10-01"]) {
    const { response, text } = await get(schema, query);
    assert.equal(response.status, 400, query);
    assert.equal(JSON.parse(text).error.code, "BODY_INVALID");
    assertNoInterimHeaders(response);
  }
  const post = await get(schema, FULL, { method: "POST" });
  assert.equal(post.response.status, 405);
  assert.equal(post.response.headers.get("allow"), "GET");
});

test("an export captured with the allowance unavailable is not cached, as production's was not", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema, denseGoldenExportBody());
  const { response, text } = await get(schema, FULL);
  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.allowanceReadState, "temporarily_unavailable");
  assert.equal(body.allowanceState, "updating");
  assert.equal("allowanceBreakdowns" in body, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-tibotattle-interim-read"), "frozen");
});

// ---------------------------------------------------------------------------
// State 1: the first publication ends the interim read
// ---------------------------------------------------------------------------

test("once any day is published the frozen export is never served again", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  const before = await get(schema, FULL);
  assert.equal(before.response.headers.get("x-tibotattle-interim-read"), "frozen");
  assert.equal(JSON.parse(before.text).days.length, GOLDEN.days.length);

  // One published day, outside the range of the second request below.
  const published = await publishDay(schema);
  const after = await get(schema, FULL);
  assert.equal(after.response.status, 200);
  assertNoInterimHeaders(after.response);
  const body = JSON.parse(after.text);
  assert.deepEqual(body.days.map((day) => day.day), [published.day], "only this line's own published day");
  assert.equal(after.text.includes("payload_text"), false);
  // A range holding none of the published days is the ordinary empty answer, not the frozen copy.
  for (const query of ["?from=2026-09-21&to=2026-10-01", "?from=2025-10-01&to=2026-09-19"]) {
    const empty = await get(schema, query);
    assert.equal(empty.response.status, 200);
    assertNoInterimHeaders(empty.response);
    assert.deepEqual(JSON.parse(empty.text).days, [], query);
  }
  // The frozen row is still stored, immutable, and never read again.
  const stored = await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`);
  assert.equal(stored.rows[0].count, 1);
  // A published day is never deleted, so the interim read cannot come back.
  await assert.rejects(pool.query(`DELETE FROM ${q(schema, "analytics_v2_published_daily")}`),
    (error) => error?.code === "P1005");
  assertNoInterimHeaders((await get(schema, FULL)).response);
});

test("a publication that predates the load keeps the export out of the route and out of the loader", { skip }, async () => {
  const schema = await createSchema();
  await publishDay(schema);
  await assert.rejects(loadFrozen(schema), (error) => error?.code === "INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS");
  const stored = await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`);
  assert.equal(stored.rows[0].count, 0, "nothing was written");
  assertNoInterimHeaders((await get(schema, FULL)).response);
  // Were a row there anyway (loaded before the publication, then published), the publication still wins.
  const raced = await createSchema();
  await loadFrozen(raced);
  await publishDay(raced);
  for (const query of [FULL, "?from=2026-09-21&to=2026-10-01"]) {
    const { response, text } = await get(raced, query);
    assertNoInterimHeaders(response);
    assert.equal(JSON.parse(text).days.length <= 1, true, "never the frozen days");
  }
});

// ---------------------------------------------------------------------------
// A tampered or unreadable export fails closed
// ---------------------------------------------------------------------------

/**
 * Tampering needs more than ordinary SQL: the trigger refuses an update and the
 * table's own CHECKs refuse a row whose digest, facts or JSON are wrong. The
 * test bypasses both as the schema owner, which is exactly the corruption the
 * route's own verification exists to catch.
 */
async function tamper(schema, change, fn) {
  const original = (await pool.query(`SELECT * FROM ${q(schema, TABLE)}`)).rows[0];
  const checks = await pool.query(`SELECT conname FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c'`, [q(schema, TABLE)]);
  for (const { conname } of checks.rows) {
    await pool.query(`ALTER TABLE ${q(schema, TABLE)} DROP CONSTRAINT "${conname}"`);
  }
  await pool.query(`ALTER TABLE ${q(schema, TABLE)} DISABLE TRIGGER community_daily_frozen_export_immutable`);
  const columns = Object.keys(change);
  const set = (values) => pool.query(
    `UPDATE ${q(schema, TABLE)} SET ${columns.map((column, index) => `"${column}" = $${index + 1}`).join(", ")}`,
    values);
  try {
    await set(columns.map((column) => change[column]));
    return await fn();
  } finally {
    await set(columns.map((column) => original[column]));
    await pool.query(`ALTER TABLE ${q(schema, TABLE)} ENABLE TRIGGER community_daily_frozen_export_immutable`);
  }
}

test("a tampered frozen export is 503, never an empty or partial answer", { skip }, async () => {
  const schema = await createSchema();
  const receipt = await loadFrozen(schema);
  const text = JSON.stringify(goldenExportBody());
  const digestOf = (value) => sha256Hex(new TextEncoder().encode(value));
  const flipped = `${text.slice(0, 2000)}${text[2000] === "1" ? "2" : "1"}${text.slice(2001)}`;
  const poisoned = JSON.stringify({ ...goldenExportBody(), days: goldenExportBody().days.map((day, index) => (
    index === 0 ? { ...day, payload: { ...day.payload, capacityByPlanType: { pro: { capacityUsd: 1 } } } } : day)) });
  const wrongWindow = JSON.stringify({ ...goldenExportBody(), from: "2026-01-01" });
  const cases = [
    ["one changed byte under the stored digest", { payload_text: flipped }],
    ["a different digest over intact text", { payload_sha256: `${receipt.payloadSha256.slice(0, 63)}${receipt.payloadSha256.endsWith("0") ? "1" : "0"}` }],
    ["a self-consistent row whose export breaks the contract", { payload_text: poisoned, payload_sha256: digestOf(poisoned) }],
    ["a self-consistent row whose window is not the full year", { payload_text: wrongWindow, payload_sha256: digestOf(wrongWindow) }],
    ["a self-consistent row that is not an export", { payload_text: "{}", payload_sha256: digestOf("{}") }],
    ["a self-consistent row that is not JSON", { payload_text: "oops", payload_sha256: digestOf("oops") }],
    ["an evidence date that disagrees with the window", { evidence_date: "2026-09-30" }],
    ["a capture instant before the days it holds", { captured_at: "2026-04-15T00:00:00.000Z", evidence_date: "2026-04-15" }],
    ["a source commit that is not a commit", { source_commit: "not-a-commit" }],
  ];
  assert.equal((await get(schema, FULL)).response.status, 200, "intact before tampering");
  for (const [name, change] of cases) {
    await tamper(schema, change, async () => {
      for (const query of [FULL, "?from=2026-09-01&to=2026-09-15"]) {
        const answer = await get(schema, query);
        assertStorageUnavailable(answer);
      }
    });
    const restored = await get(schema, FULL);
    assert.equal(restored.response.status, 200, `served again once restored (${name})`);
    assert.equal(restored.text, text);
  }
});

test("an unreadable frozen row is 503; a schema without the table is the same as no export", { skip }, async () => {
  const schema = await createSchema();
  await loadFrozen(schema);
  // The table exists but its row cannot be read: not an empty answer.
  await pool.query(`ALTER TABLE ${q(schema, TABLE)} RENAME COLUMN payload_text TO payload_text_hidden`);
  try {
    assertStorageUnavailable(await get(schema, FULL));
  } finally {
    await pool.query(`ALTER TABLE ${q(schema, TABLE)} RENAME COLUMN payload_text_hidden TO payload_text`);
  }
  assert.equal((await get(schema, FULL)).response.status, 200);
  // A schema that predates the table cannot hold an export: the ordinary empty answer.
  const old = await createSchemaWithoutFrozenTable();
  const { response, text } = await get(old, FULL);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text).days, []);
  assertNoInterimHeaders(response);
  // The published-days table failing is still the route's own 503, before any frozen read.
  const broken = await createSchema();
  await loadFrozen(broken);
  await pool.query(`ALTER TABLE ${q(broken, "analytics_v2_published_daily")} RENAME TO analytics_v2_published_daily_hidden`);
  try {
    assertStorageUnavailable(await get(broken, FULL));
  } finally {
    await pool.query(`ALTER TABLE ${q(broken, "analytics_v2_published_daily_hidden")} RENAME TO analytics_v2_published_daily`);
  }
});

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

test("the loader writes once, repeats as a no-op, and refuses any other export or facts", { skip }, async () => {
  const schema = await createSchema();
  const first = await loadFrozen(schema);
  assert.equal(first.state, "loaded");
  assert.equal(first.schema, "tibotattle-gcp-interim-public-read-load-v1");
  assert.deepEqual([first.evidenceDate, first.capturedAt, first.sourceCommit],
    [FIXTURE_EVIDENCE_DATE, FIXTURE_CAPTURED_AT, FIXTURE_SOURCE_COMMIT]);
  assert.equal(first.payloadSha256, sha256Hex(exportBytes(goldenExportBody())));
  assert.equal(first.export.dayCount, GOLDEN.days.length);
  const row = (await pool.query(`SELECT loaded_at::text AS loaded_at, payload_sha256 FROM ${q(schema, TABLE)}`)).rows[0];

  const again = await loadFrozen(schema);
  assert.equal(again.state, "already-loaded");
  assert.equal(again.payloadSha256, first.payloadSha256);
  assert.deepEqual((await pool.query(`SELECT loaded_at::text AS loaded_at, payload_sha256 FROM ${q(schema, TABLE)}`)).rows[0], row,
    "a repeat writes nothing");

  // A different export, the same export with other facts, and a changed commit are all refused, and nothing moves.
  for (const [body, facts] of [
    [denseGoldenExportBody(), {}],
    [goldenExportBody(), { capturedAt: "2026-10-01T23:31:00.000Z" }],
    [goldenExportBody(), { sourceCommit: "0".repeat(40) }],
    [goldenExportBody(), { capturedAt: "2026-10-02T00:30:00.000Z" }],
  ]) {
    await assert.rejects(loadFrozen(schema, body, facts), (error) => {
      assert.equal(error.code, "INTERIM_PUBLIC_READ_LOAD_ALREADY_LOADED_DIFFERENT");
      assert.equal(error.detail, first.payloadSha256, "the stored digest is named, the candidate's value never");
      return true;
    });
  }
  assert.deepEqual((await pool.query(`SELECT loaded_at::text AS loaded_at, payload_sha256 FROM ${q(schema, TABLE)}`)).rows[0], row);
});

test("two concurrent identical loads converge on one row", { skip }, async () => {
  const schema = await createSchema();
  const loaded = await Promise.all([loadFrozen(schema), loadFrozen(schema)]);
  assert.deepEqual(loaded.map(({ state }) => state).sort(), ["already-loaded", "loaded"]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 1);
});

test("the loader refuses a missing table, a bad schema or pool, and rolls back a failed read-back", { skip }, async () => {
  const old = await createSchemaWithoutFrozenTable();
  await assert.rejects(loadFrozen(old), (error) => error?.code === "INTERIM_PUBLIC_READ_LOAD_TABLE_MISSING");
  const target = await prepared();
  for (const schema of ["Bad-Schema", "", "a\"; DROP SCHEMA x; --", "x".repeat(64), null]) {
    await assert.rejects(loadInterimPublicRead({ pool, schema, prepared: target }),
      (error) => error?.code === "INTERIM_PUBLIC_READ_LOAD_SCHEMA_INVALID");
  }
  await assert.rejects(loadInterimPublicRead({ pool: null, schema: old, prepared: target }),
    (error) => error?.code === "INTERIM_PUBLIC_READ_LOAD_USAGE");
  // A failure after the insert undoes the insert: the read-back is part of the same transaction.
  const schema = await createSchema();
  const failing = {
    async connect() {
      const client = await pool.connect();
      return {
        query: (text, values) => (typeof text === "string" && text.includes("SELECT f.payload_text")
          ? Promise.reject(Object.assign(new Error("synthetic read-back failure"), { code: "57014" }))
          : client.query(text, values)),
        release: (discard) => client.release(discard),
      };
    },
  };
  await assert.rejects(loadInterimPublicRead({ pool: failing, schema, prepared: target }), (error) => {
    assert.equal(error.code, "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED");
    assert.equal(error.detail, "57014", "only the SQLSTATE is reported");
    assert.equal(error.message.includes("synthetic"), false);
    return true;
  });
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 0);
  // And the same schema loads cleanly afterwards.
  assert.equal((await loadFrozen(schema)).state, "loaded");
});

test("PT-8-lite's entrypoint loads inside a transaction the caller owns, and a caller rollback leaves nothing", { skip }, async () => {
  const schema = await createSchema();
  const target = await prepared();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await loadInterimPublicReadInTransaction({ client, schema, prepared: target });
    assert.equal(receipt.state, "loaded");
    // Visible inside the caller's transaction, not outside it.
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 0);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 0);
  assertNoInterimHeaders((await get(schema, FULL)).response);
  const second = await pool.connect();
  try {
    await second.query("BEGIN");
    await loadInterimPublicReadInTransaction({ client: second, schema, prepared: target });
    await second.query("COMMIT");
  } finally {
    second.release();
  }
  assert.equal((await get(schema, FULL)).response.headers.get("x-tibotattle-interim-read"), "frozen");
});

test("the command line checks offline and loads only to a local target", { skip }, async () => {
  const schema = await createSchema();
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-ipr-"));
  try {
    const bytes = exportBytes(goldenExportBody());
    const file = join(directory, "export.json");
    await writeFile(file, bytes);
    const flags = ["--export", file, "--sha256", sha256Hex(bytes), "--captured-at", FIXTURE_CAPTURED_AT,
      "--source-commit", FIXTURE_SOURCE_COMMIT, "--evidence-date", FIXTURE_EVIDENCE_DATE];
    const run = async (argv, env = {}, createPool = undefined) => {
      let out = "";
      let err = "";
      const code = await runInterimPublicReadLoad(argv, {
        env: { PG_TEST_SOCKET: process.env.PG_TEST_SOCKET, PG_TEST_HOST: process.env.PG_TEST_HOST,
          PG_TEST_PORT: process.env.PG_TEST_PORT, ...env },
        stdout: { write: (value) => { out += value; } },
        stderr: { write: (value) => { err += value; } },
        ...(createPool === undefined ? {} : { createPool }),
      });
      return { code, out, err };
    };
    // check: no connection, no write.
    const never = async () => { throw new Error("check must not open a connection"); };
    const checked = await run(["check", ...flags], {}, never);
    assert.equal(checked.code, 0, checked.err);
    assert.equal(JSON.parse(checked.out).mode, "check");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, TABLE)}`)).rows[0].count, 0);
    // load: through the local target and the injected pool, receipt on stdout, content-free.
    const pooled = async () => ({ connect: () => pool.connect(), end: async () => {} });
    const loaded = await run(["load", ...flags, "--schema", schema], {}, pooled);
    assert.equal(loaded.code, 0, loaded.err);
    const receipt = JSON.parse(loaded.out);
    assert.equal(receipt.state, "loaded");
    assert.equal(loaded.out.includes("payloadText"), false);
    assert.equal(loaded.out.includes("capacityByPlanType"), false);
    const repeat = await run(["load", ...flags, "--schema", schema], {}, pooled);
    assert.equal(JSON.parse(repeat.out).state, "already-loaded");
    // A target that is not a local PostgreSQL is refused before any connection.
    for (const env of [
      { PG_TEST_SOCKET: undefined, PG_TEST_HOST: "db.example.com" },
      { PG_TEST_SOCKET: "/var/run/postgresql", PG_TEST_HOST: undefined },
      { PG_TEST_SOCKET: undefined, PG_TEST_HOST: undefined },
    ]) {
      const refused = await run(["load", ...flags, "--schema", schema], env, never);
      assert.equal(refused.code, 1);
      assert.match(JSON.parse(refused.err).error.code, /^INTERIM_PUBLIC_READ_LOAD_TARGET_(UNSUPPORTED|UNCONFIGURED)$/u);
    }
    // The served answer after a CLI load is the frozen export.
    assert.equal((await get(schema, FULL)).response.headers.get("x-tibotattle-interim-read"), "frozen");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
