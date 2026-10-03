/**
 * PG17 spec for E-OWNERSET: the staged owner-sets migration (saved owner sets,
 * versioned member contributions, the per-day receipt of how each set began),
 * its reader (src/analytics-v2/owner-sets.ts) and the store's owner-set write
 * (src/analytics-v2/store-owner-sets.ts, inside writeRunOutputs).
 *
 * Each case applies the stock primary chain through the production runner and
 * the owner-sets migration (found by its name suffix, staged or promoted)
 * through the staged-migrations harness into a fresh random schema, dropped
 * afterwards. Synthetic, content-free digests and values only.
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
 *      PG_TEST_PORT=55433 node --test postgres-test/analytics-v2-owner-sets.spec.mjs
 * Without PG_TEST_SOCKET/PG_TEST_HOST every case skips.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  NO_ANALYTICS_V2_EXCLUSIONS_SHA256,
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
  stagedOrPromotedMigrationName,
} from "./staged-migrations-harness.mjs";
import { denseGoldenExportBody, exportInput } from "../analytics-v2-test/fixtures/interim-public-read-export.mjs";
import { checkInterimPublicRead, loadInterimPublicRead } from "../scripts/gcp-interim-public-read-load.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const OWNER_SETS_FILE = await stagedOrPromotedMigrationName("primary", "_analytics_v2_owner_sets.sql");
const NOW = "2026-10-01T12:00:00.000Z";
const DAY_1 = "2026-09-28";
const DAY_2 = "2026-09-29";
const DAY_3 = "2026-09-30";
const digest = (label) => createHash("sha256").update(`analytics-v2-owner-sets-spec:${label}`).digest("hex");
const OWNER_A = digest("owner-a");
const OWNER_B = digest("owner-b");
const OWNER_C = digest("owner-c");
const [A, B, C] = [OWNER_A, OWNER_B, OWNER_C].sort();
const HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
const NO_OWNER_SETS = Object.freeze({ contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
  memberContributionUnavailableDays: [], memberLinkUnavailableDays: [] });
const NO_FROZEN = Object.freeze({ frozenParticipants: null, frozenExportSha256: null, frozenFromDay: null,
  frozenThroughDay: null });
/** A day's first recording outside the frozen window (1), and an unrecorded head's adoption (4). */
const FIRST = Object.freeze({ provenance: 1, ...NO_FROZEN });
const ADOPTED = Object.freeze({ provenance: 4, ...NO_FROZEN });
const writes = (overrides = {}) => ({ ...NO_OWNER_SETS, membersAdded: 0, contributionVersions: 0, daysRecorded: 0,
  bootstrapVerifiedDays: [], bootstrapDisclosedDays: [], bootstrapAdoptedDays: [], ...overrides });

let vite;
let contract;
let store;
let ownerSets;
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
  ownerSets = await vite.ssrLoadModule("/src/analytics-v2/owner-sets.ts");
  specStamp = store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry()[0]);
  if (ENDPOINT !== null) {
    pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 4, connectionTimeoutMillis: 5_000,
      application_name: "analytics-v2-owner-sets-spec", options: "-c search_path=pg_catalog" });
  }
});

after(async () => {
  if (pool !== undefined) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  await vite?.close();
});

function q(schema, table) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(table, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${table}"`;
}

async function createSchema({ ownerSetsMigration = true } = {}) {
  const schema = `e_ownerset_${randomBytes(5).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const stock = await readPostgresMigrations({ role: "primary" });
  const promoted = stock.find(({ name }) => name === OWNER_SETS_FILE);
  if (ownerSetsMigration || promoted === undefined) {
    await applyStockAndStagedMigrations({ role: "primary", schema, pool,
      stagedFiles: ownerSetsMigration ? [OWNER_SETS_FILE] : [] });
    return schema;
  }
  // Promoted: the stock chain before the owner-sets migration, from a copy of
  // the primary directory holding only that prefix.
  const prefixRoot = await mkdtemp(join(tmpdir(), "analytics-v2-owner-sets-"));
  try {
    await mkdir(join(prefixRoot, "primary"));
    for (const migration of stock.filter(({ version }) => version < promoted.version)) {
      await copyFile(join(WORKER_ROOT, "postgres", "migrations", "primary", migration.name),
        join(prefixRoot, "primary", migration.name));
    }
    const prior = await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [],
      rootDirectory: prefixRoot });
    assert.equal(prior.stockApplied, promoted.version - 1, "the chain stops before the owner-sets migration");
  } finally {
    await rm(prefixRoot, { recursive: true, force: true });
  }
  return schema;
}

async function withClient(work) {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

/** Every owner-set row, canonicalized, for exact before/after comparison. */
async function ownerSetSnapshot(schema) {
  const snapshot = {};
  for (const table of [contract.ANALYTICS_V2_TABLES.dailyOwnerSets, contract.ANALYTICS_V2_TABLES.dailyContributions,
    contract.ANALYTICS_V2_TABLES.ownerSetBootstrap, contract.ANALYTICS_V2_TABLES.publishedDaily,
    contract.ANALYTICS_V2_TABLES.runs]) {
    snapshot[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text
      AS rows FROM ${q(schema, table)} t`)).rows[0].rows;
  }
  return snapshot;
}

const values = (n, schemaVersion = "synthetic-daily-values-v1") => ({ schemaVersion, usageEvents: n });
const computed = (ownerDigest, n, devices = 1) =>
  ({ ownerDigest, origin: "computed", values: values(n), devices, savedVersion: null });
const saved = (ownerDigest, savedVersion, origin = "saved") =>
  ({ ownerDigest, origin, values: null, devices: null, savedVersion });

/** A published-day candidate whose payload counts the folded members. */
async function candidate(day, members, { marker = 0, bootstrap = null } = {}) {
  const payload = { day, marker, totals: { contributingParticipants: members.filter((m) => m.origin !== "excluded").length } };
  return { day, payload, payloadSha256: await store.analyticsV2DailyContentSha256(payload), members, bootstrap };
}

function outputs(dailyCandidates, overrides = {}) {
  const nowMs = Date.parse(NOW);
  return {
    contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION,
    mode: "full",
    nowMs,
    today: NOW.slice(0, 10),
    revisionSeed: 0,
    owners: [OWNER_A, OWNER_B, OWNER_C].map((ownerDigest) => ({ participantId: `participant-${ownerDigest.slice(0, 8)}`,
      ownerDigest, hasV1: false, hasV11: false, hasV12: true, hasLegacy: false, hasEffective: true, source: "effective" })),
    ownerDays: [],
    ownerDayPrices: [],
    cacheBands: [],
    ownerFits: [],
    ownerModelDates: [],
    dailyCandidates,
    blockedDays: [],
    ownerSets: NO_OWNER_SETS,
    preview: null,
    refusals: [],
    journal: { lastSequence: null },
    timings: {},
    ...overrides,
  };
}

function write(client, schema, runOutputs) {
  return store.writeRunOutputs(client, runOutputs, { schema, runId: randomUUID(), startedAtMs: Date.parse(NOW),
    expectedCursor: null, horizon: HORIZON, stamp: specStamp, exclusionsSha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256 });
}

async function setRows(schema) {
  return (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, owner_digest, first_revision, provenance,
      kernel_id, manifest_version FROM ${q(schema, "analytics_v2_daily_owner_sets")} ORDER BY day, owner_digest`)).rows;
}

async function contributionRows(schema) {
  return (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, owner_digest, version, daily_values, devices,
      values_schema, first_revision, price_kernel_id, evidence_fp, price_basis_id, values_sha256, stable_values_sha256
      FROM ${q(schema, "analytics_v2_daily_contributions")} ORDER BY day, owner_digest, version`)).rows;
}

async function insertKernel(schema) {
  const kernel = specStamp.kernel;
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_kernels")} (kernel_id, production_commit,
      vendor_manifest_sha256, compute_closure_sha256, price_registry_sha256, price_registry_version, method_version,
      registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-02T00:00:00Z')`,
  [kernel.kernelId, kernel.productionCommit, kernel.vendorManifestSha256, kernel.computeClosureSha256,
    kernel.priceRegistrySha256, kernel.priceRegistryVersion, kernel.methodVersion]);
}

const RUN = "00000000-0000-4000-8000-000000000001";
/** The day's receipt (provenance 1) unless it has one. */
async function insertReceipt(client, schema, day, { provenance = 1, setSize = 0 } = {}) {
  await client.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_set_bootstrap")}
      (day, provenance, set_size, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, $3, 1, $4, 1, 1) ON CONFLICT (day) DO NOTHING`, [day, provenance, setSize, RUN]);
}
async function insertMember(client, schema, day, ownerDigest, { revision = 1, versions = [1] } = {}) {
  await insertReceipt(client, schema, day);
  await client.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_sets")}
      (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, $3, 1, $4, 1, 1)`, [day, ownerDigest, revision, RUN]);
  for (const [index, version] of versions.entries()) {
    await client.query(`INSERT INTO ${q(schema, "analytics_v2_daily_contributions")}
        (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
         price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
        VALUES ($1, $2, $3, $4::jsonb, 'synthetic-daily-values-v1', $5, $5, 1, 1, $6, $7, 1, 1)`,
    [day, ownerDigest, version, JSON.stringify(values(version)), "c".repeat(64), revision + index, RUN]);
  }
}

/** Run `statements` in one transaction; the error a statement or the commit raises, or null. */
async function inTransaction(statements) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      for (const statement of statements) await statement(client);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return error;
    }
  });
}

test("PG17: the owner-sets migration is append-only, deletes only for the purge's named owner, and keeps versions ordered", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await insertKernel(schema);
  const appendOnly = { code: "P1005", message: "analytics_v2_owner_sets_append_only" };
  const sets = q(schema, "analytics_v2_daily_owner_sets");
  const contributions = q(schema, "analytics_v2_daily_contributions");
  const bootstrap = q(schema, "analytics_v2_daily_owner_set_bootstrap");

  assert.equal(await inTransaction([(client) => insertMember(client, schema, DAY_1, A, { versions: [1, 2] })]), null);
  // A member without a contribution is refused at commit, and so is a contribution without a member.
  assert.match((await inTransaction([(client) => client.query(`INSERT INTO ${sets}
      (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 1, 1, $3, 1, 1)`, [DAY_1, B, RUN])]))?.message ?? "", /member_without_contribution/u);
  // A member of a day without a receipt is refused at commit: a day's set always records how it began.
  const receiptless = "2026-09-10";
  assert.match((await inTransaction([(client) => client.query(`INSERT INTO ${sets}
      (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 1, 1, $3, 1, 1)`, [receiptless, B, RUN]), (client) => client.query(`INSERT INTO ${contributions}
      (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
       price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 1, '{"schemaVersion":"synthetic-daily-values-v1"}', 'synthetic-daily-values-v1', $3, $3, 1, 1, 1,
        $4, 1, 1)`, [receiptless, B, "c".repeat(64), RUN])]))?.message ?? "", /member_without_receipt/u);
  // Provenance 4 (adopted) is a set provenance; 5 is none.
  assert.equal((await inTransaction([(client) => insertReceipt(client, schema, receiptless), (client) => client.query(
    `INSERT INTO ${sets} (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version)
     VALUES ($1, $2, 1, 5, $3, 1, 1)`, [receiptless, B, RUN])]))?.code, "23514");
  assert.equal((await inTransaction([(client) => client.query(`INSERT INTO ${contributions}
      (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
       price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 1, '{"schemaVersion":"synthetic-daily-values-v1"}', 'synthetic-daily-values-v1', $3, $3, 1, 1, 1,
        $4, 1, 1)`, [DAY_2, B, "c".repeat(64), RUN])]))?.code, "23503");
  // Versions follow the current one, each at a later revision; a gap or a replay is refused.
  for (const [version, revision] of [[4, 9], [2, 9], [3, 2], [3, 1]]) {
    const error = await inTransaction([(client) => client.query(`INSERT INTO ${contributions}
        (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
         price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
        VALUES ($1, $2, $3, '{"schemaVersion":"synthetic-daily-values-v1"}', 'synthetic-daily-values-v1', $4, $4, 1, 1,
          $5, $6, 1, 1)`, [DAY_1, A, version, "c".repeat(64), revision, RUN])]);
    assert.ok(error !== null && /version_order|duplicate key/u.test(error.message), `version ${version} at r${revision}`);
  }
  // The stored schema is the values' own.
  assert.equal((await inTransaction([(client) => client.query(`INSERT INTO ${contributions}
      (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
       price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 3, '{"schemaVersion":"other-v1"}', 'synthetic-daily-values-v1', $3, $3, 1, 1, 5, $4, 1, 1)`,
  [DAY_1, A, "c".repeat(64), RUN])]))?.code, "23514");

  // No update, no truncate, no delete without the purge flag naming the owner.
  for (const statement of [
    `UPDATE ${sets} SET provenance = 2`, `UPDATE ${contributions} SET devices = 2`,
    `DELETE FROM ${contributions}`, `DELETE FROM ${sets}`, `TRUNCATE ${contributions}`, `TRUNCATE ${sets} CASCADE`,
  ]) {
    await assert.rejects(pool.query(statement), appendOnly, statement);
  }
  const purge = (ownerDigest, ...statements) => inTransaction([
    (client) => client.query("SELECT set_config('tibotattle.analytics_v2_offline_purge', $1, true)", [ownerDigest]),
    ...statements.map((statement) => (client) => client.query(statement)),
  ]);
  const purgeError = await purge(B, `DELETE FROM ${contributions} WHERE owner_digest = '${A}'`);
  assert.equal(purgeError?.message, appendOnly.message, "the flag names another owner");
  // Removing a member's contributions without its set row fails at commit.
  assert.match((await purge(A, `DELETE FROM ${contributions} WHERE owner_digest = '${A}'`))?.message ?? "",
    /member_without_contribution/u);
  // The set row is referenced by its contributions, so they go first.
  assert.equal((await purge(A, `DELETE FROM ${sets} WHERE owner_digest = '${A}'`))?.code, "23503");
  assert.equal(await purge(A, `DELETE FROM ${contributions} WHERE owner_digest = '${A}'`,
    `DELETE FROM ${sets} WHERE owner_digest = '${A}'`), null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${sets}`)).rows[0].n, 0);

  // The receipt: verified exactly when the counts agree; 2 and 3 name the
  // frozen export and a window holding the day, 1 and 4 none; immutable.
  const receipt = (provenance, setSize, frozen, sha = "e".repeat(64), from = "2025-10-01", through = DAY_2) =>
    pool.query(`INSERT INTO ${bootstrap}
      (day, provenance, set_size, frozen_participants, frozen_export_sha256, frozen_from_day, frozen_through_day,
       first_revision, run_id, kernel_id, manifest_version) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 1, 1)`,
    [DAY_2, provenance, setSize, frozen, sha, from, through, RUN]);
  for (const args of [[2, 3, 4], [2, 0, null], [3, 3, 3], [1, 3, 3], [1, 3, null], [4, 3, null], [5, 3, null, null, null, null],
    [3, 2, null, null], [3, 2, null, "e".repeat(64), null], [3, 2, null, "e".repeat(64), "2026-09-30", "2026-10-01"],
    [3, 2, null, "e".repeat(64), "2025-10-01", "2026-09-28"], [1, 0, 0, null, null, null]]) {
    await assert.rejects(receipt(...args), { code: "23514" }, JSON.stringify(args));
  }
  await receipt(3, 2, null);
  for (const statement of [`UPDATE ${bootstrap} SET set_size = 3`, `DELETE FROM ${bootstrap}`, `TRUNCATE ${bootstrap}`]) {
    await assert.rejects(pool.query(statement), { code: "P1005", message: "analytics_v2_owner_set_bootstrap_immutable" });
  }
  // 1 and 4 carry no frozen export.
  for (const [day, provenance] of [["2026-09-01", 1], ["2026-09-02", 4]]) {
    await pool.query(`INSERT INTO ${bootstrap} (day, provenance, set_size, first_revision, run_id, kernel_id,
        manifest_version) VALUES ($1, $2, 0, 1, $3, 1, 1)`, [day, provenance, RUN]);
  }
});

test("PG17: every analytics_v2 table holding an owner is in the offline purge inventory", {
  skip: PG_SKIP,
  timeout: 120_000,
}, async () => {
  const schema = await createSchema();
  const holding = (await pool.query(`SELECT table_name::text AS name FROM information_schema.columns
      WHERE table_schema = $1 AND column_name = 'owner_digest' AND table_name LIKE 'analytics\\_v2\\_%'
      ORDER BY 1`, [schema])).rows.map((row) => row.name);
  const inventory = contract.ANALYTICS_V2_OWNER_SCOPED_TABLES.map((key) => contract.ANALYTICS_V2_TABLES[key]);
  assert.deepEqual([...inventory].sort(), holding);
  // Delete order: a table is purged before every table it references.
  const references = (await pool.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = $1 AND c.contype = 'f'`, [schema])).rows;
  const position = (relation) => inventory.findIndex((table) => relation === `${schema}.${table}`
    || relation === `"${schema}".${table}`);
  for (const { child, parent } of references) {
    if (position(child) >= 0 && position(parent) >= 0) assert.ok(position(child) < position(parent), `${child} -> ${parent}`);
  }
});

/** A participant and its owner link (any state), as the roster's owners have. */
async function linkOwner(schema, participantId, ownerDigest, state = "active") {
  await pool.query(`INSERT INTO ${q(schema, "participants")} (id, created_at) VALUES ($1, $2)`,
    [participantId, "2026-01-01T00:00:00.000Z"]);
  await pool.query(`INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id, owner_digest, state)
    VALUES ($1, $2, $3)`, [participantId, ownerDigest, state]);
}

/** A head published without a recorded set (an image without saved owner sets). */
async function insertHead(schema, day, revision, payload) {
  const stamped = store.stampAnalyticsV2DailyPayload(payload, { day, revision, releasedAt: NOW });
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")} (day, revision, released_at, payload,
      payload_sha256, run_id, kernel_id, manifest_version) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 1, 1)`,
  [day, revision, NOW, JSON.stringify(stamped), await store.analyticsV2DailyContentSha256(payload), RUN]);
}

test("PG17: the reader refuses a schema without the migration and reads sets, links, receipts and heads", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const bare = await createSchema({ ownerSetsMigration: false });
  await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState({ pool, schema: bare, nowMs: Date.parse(NOW) },
    { days: [DAY_1] }), { code: "ANALYTICS_V2_SOURCE_UNAVAILABLE" });
  const schema = await createSchema();
  await insertKernel(schema);
  assert.equal(await inTransaction([(client) => insertMember(client, schema, DAY_1, A, { versions: [1, 2] }),
    (client) => insertMember(client, schema, DAY_1, B)]), null);
  // A's owner link (withdrawn: off the roster) names its participant; B has none.
  await linkOwner(schema, "participant-owner-a", A, "withdrawn");
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} (day, provenance, set_size,
      frozen_participants, frozen_export_sha256, frozen_from_day, frozen_through_day, first_revision, run_id, kernel_id,
      manifest_version) VALUES ($1, 3, 0, NULL, $2, '2025-09-30', $1, 1, $3, 1, 1)`, [DAY_2, "e".repeat(64), RUN]);
  await insertHead(schema, "2026-09-30", 4, { day: "2026-09-30", totals: { contributingParticipants: 0 } });
  const context = { pool, schema, nowMs: Date.parse(NOW) };
  const state = await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [DAY_2, DAY_1, "2026-09-30"] });
  assert.deepEqual([...state.days.keys()], [DAY_1, DAY_2, "2026-09-30"]);
  assert.deepEqual([...state.days.get(DAY_1).members], [
    [A, { version: 2, devices: 1, valuesSha256: "c".repeat(64), participantId: "participant-owner-a" }],
    [B, { version: 1, devices: 1, valuesSha256: "c".repeat(64), participantId: null }]]
    .sort(([left], [right]) => (left < right ? -1 : 1)));
  assert.deepEqual([DAY_1, DAY_2, "2026-09-30"].map((day) => [state.days.get(day).recorded,
    state.days.get(day).headPublished]), [[true, false], [true, false], [false, true]]);
  assert.equal(state.days.get("2026-09-30").members.size, 0);
  assert.equal(state.frozen, null, "no first publication inside the recorded window: nothing to compare");
  // The recorded window outlives the frozen row: a first publication inside it
  // is refused while the row is absent, never recorded as outside it.
  await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState(context, { days: ["2026-09-20"] }),
    { code: "ANALYTICS_V2_SOURCE_UNAVAILABLE" });
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: ["2026-10-02"] })).frozen, null);
  for (const days of [["2026-02-30"], [DAY_1, DAY_1], "2026-09-28"]) {
    await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState(context, { days }), { code: "ANALYTICS_V2_SOURCE_INVALID" });
  }

  // Stored values load by exact version, and only when they match their stored digest.
  const key = { day: DAY_1, ownerDigest: A, version: 2 };
  await assert.rejects(ownerSets.readAnalyticsV2SavedContributionValues(context, [key]),
    { code: "ANALYTICS_V2_SOURCE_CONFLICT" }, "the synthetic digest is not the values' digest");
  const real = await ownerSets.analyticsV2ContributionDigests(values(9));
  await inTransaction([(client) => client.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_sets")}
      (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version) VALUES ($1, $2, 1, 1, $3, 1, 1)`,
    [DAY_2, C, RUN]), (client) => client.query(`INSERT INTO ${q(schema, "analytics_v2_daily_contributions")}
      (day, owner_digest, version, daily_values, values_schema, values_sha256, stable_values_sha256, devices,
       price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, 1, $3::jsonb, 'synthetic-daily-values-v1', $4, $5, 1, 1, 1, $6, 1, 1)`,
  [DAY_2, C, JSON.stringify(values(9)), real.valuesSha256, real.stableValuesSha256, RUN])]);
  const loaded = await ownerSets.readAnalyticsV2SavedContributionValues(context, [{ day: DAY_2, ownerDigest: C, version: 1 }]);
  assert.deepEqual([...loaded], [[ownerSets.analyticsV2ContributionKey({ day: DAY_2, ownerDigest: C, version: 1 }), values(9)]]);
  await assert.rejects(ownerSets.readAnalyticsV2SavedContributionValues(context, [{ day: DAY_2, ownerDigest: C, version: 2 }]),
    { code: "ANALYTICS_V2_SOURCE_CONFLICT" }, "an absent version is never read as empty");
  await assert.rejects(ownerSets.readAnalyticsV2SavedContributionValues(context, [{ day: DAY_2, ownerDigest: "C", version: 1 }]),
    { code: "ANALYTICS_V2_SOURCE_INVALID" });
  // No fixed count bounds a load: 100,001 keys are read in chunks (the
  // compute core's output budget is the bound), and absent ones conflict.
  const many = Array.from({ length: 100_001 }, (_, index) => ({ day: DAY_2, ownerDigest: C, version: index + 1 }));
  await assert.rejects(ownerSets.readAnalyticsV2SavedContributionValues(context, many),
    { code: "ANALYTICS_V2_SOURCE_CONFLICT" });
});

/**
 * Tampering needs more than ordinary SQL: the trigger refuses an update and the
 * table's own CHECKs refuse a row whose digest, facts or JSON are wrong. The
 * spec bypasses both as the schema owner, which is the corruption the reader's
 * verification exists to catch (as the interim-public-read spec does).
 */
async function tamperFrozen(schema, change, fn) {
  const table = q(schema, "community_daily_frozen_export");
  const original = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
  const checks = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`,
    [table]);
  for (const { conname } of checks.rows) await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "${conname}"`);
  await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER community_daily_frozen_export_immutable`);
  const columns = Object.keys(change);
  const set = (row) => pool.query(`UPDATE ${table} SET ${columns.map((column, index) => `"${column}" = $${index + 1}`)
    .join(", ")}`, columns.map((column) => row[column]));
  try {
    await set(change);
    return await fn();
  } finally {
    await set(original);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER community_daily_frozen_export_immutable`);
  }
}

test("PG17: the reader verifies the frozen export only for a first publication inside its window, and refuses it otherwise", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  const body = denseGoldenExportBody();
  const input = exportInput(body);
  const { prepared } = await checkInterimPublicRead({ exportBytes: input.exportBytes, sha256: input.expectedSha256,
    capturedAt: input.capturedAt, sourceCommit: input.sourceCommit, evidenceDate: input.evidenceDate });
  await loadInterimPublicRead({ pool, schema, prepared });
  const context = { pool, schema, nowMs: Date.parse(NOW) };
  const inWindow = body.days[0].day;
  const state = await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [inWindow] });
  assert.equal(state.frozen.exportSha256, input.expectedSha256);
  assert.equal(state.frozen.throughDay, body.to);
  assert.equal(state.frozen.fromDay, body.from);
  assert.equal(state.frozen.participants.get(inWindow), body.days[0].payload.totals.contributingParticipants);
  assert.equal(state.frozen.participants.size, body.days.length);
  // A day after the window needs no frozen read.
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: ["2026-10-02"] })).frozen, null);

  // An unverifiable frozen row is never read as "no export".
  const text = (await pool.query(`SELECT payload_text FROM ${q(schema, "community_daily_frozen_export")}`)).rows[0]
    .payload_text;
  const flipped = `${text.slice(0, 2000)}${text[2000] === "1" ? "2" : "1"}${text.slice(2001)}`;
  const otherDay = (day, delta) => new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10);
  for (const [name, change] of [
    ["one changed byte under the stored digest", { payload_text: flipped }],
    ["a different digest over intact text", { payload_sha256: `${input.expectedSha256.slice(0, 63)}${
      input.expectedSha256.endsWith("0") ? "1" : "0"}` }],
    ["an evidence date the export's window does not end on", { evidence_date: otherDay(body.to, -1) }],
  ]) {
    await tamperFrozen(schema, change, async () => {
      await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState(context, { days: [inWindow] }),
        { code: "ANALYTICS_V2_SOURCE_CONFLICT" }, name);
    });
  }

  // A recorded day, and an unrecorded head (adopted, never compared), need no
  // frozen read.
  await insertKernel(schema);
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} (day, provenance, set_size,
      frozen_participants, frozen_export_sha256, frozen_from_day, frozen_through_day, first_revision, run_id, kernel_id,
      manifest_version) VALUES ($1, 3, 0, NULL, $2, $3, $4, 1, $5, 1, 1)`,
  [inWindow, input.expectedSha256, body.from, body.to, RUN]);
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [inWindow] })).frozen, null);
  const headDay = body.days[1].day;
  await insertHead(schema, headDay, 2, { day: headDay, totals: { contributingParticipants: 0 } });
  const adopted = await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [headDay] });
  assert.deepEqual([adopted.frozen, adopted.days.get(headDay).headPublished], [null, true]);
  // A first publication inside the window reads the export the receipts recorded.
  const another = body.days[2].day;
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [another] })).frozen.exportSha256,
    input.expectedSha256);
  // Receipts that name another export, or another window, conflict with the row.
  for (const [sha, from, through] of [["d".repeat(64), body.from, body.to],
    [input.expectedSha256, otherDay(body.from, 1), body.to]]) {
    const other = await createSchema();
    await loadInterimPublicRead({ pool, schema: other, prepared });
    await insertKernel(other);
    await pool.query(`INSERT INTO ${q(other, "analytics_v2_daily_owner_set_bootstrap")} (day, provenance, set_size,
        frozen_participants, frozen_export_sha256, frozen_from_day, frozen_through_day, first_revision, run_id, kernel_id,
        manifest_version) VALUES ($1, 3, 0, NULL, $2, $3, $4, 1, $5, 1, 1)`, [inWindow, sha, from, through, RUN]);
    await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState({ ...context, schema: other }, { days: [another] }),
      { code: "ANALYTICS_V2_SOURCE_CONFLICT" }, `${sha.slice(0, 1)} ${from}`);
  }
  // The interim table is required: without it nothing is known of the window.
  await pool.query(`ALTER TABLE ${q(schema, "community_daily_frozen_export")} RENAME TO frozen_export_hidden`);
  await assert.rejects(ownerSets.readAnalyticsV2OwnerSetState(context, { days: ["2026-10-02"] }),
    { code: "ANALYTICS_V2_SOURCE_UNAVAILABLE" });
});

test("PG17: the store records each publication's set and contributions at its revision and appends only changes", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await withClient(async (client) => {
    // A first publication that does not name its first recording is refused.
    await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3)])])),
      { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field: "dailyCandidates.bootstrap" });
    // Run 1 publishes DAY_1 with A and B, under a revision seed (the single publication helper).
    const first = await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3), computed(B, 5, 2)],
      { bootstrap: FIRST })], { revisionSeed: 10 }));
    assert.deepEqual(first.publication.ownerSets, writes({ membersAdded: 2, contributionVersions: 2, daysRecorded: 1 }));
    assert.equal(store.nextPublishedRevision({ head: null, seed: 10 }), 11);
    assert.deepEqual((await setRows(schema)).map((row) => [row.owner_digest, row.first_revision, row.provenance,
      row.kernel_id, row.manifest_version]), [[A, 11, 1, 1, 1], [B, 11, 1, 1, 1]]);
    const firstContributions = await contributionRows(schema);
    assert.deepEqual(firstContributions.map((row) => [row.owner_digest, row.version, row.devices, row.first_revision,
      row.price_kernel_id, row.evidence_fp, row.price_basis_id, row.values_schema]),
    [[A, 1, 1, 11, 1, null, null, "synthetic-daily-values-v1"], [B, 1, 2, 11, 1, null, null, "synthetic-daily-values-v1"]]);
    const digests = await store.analyticsV2ContributionDigests(values(3));
    assert.equal(firstContributions[0].values_sha256, digests.valuesSha256);
    assert.equal(firstContributions[0].stable_values_sha256, digests.stableValuesSha256);
    const runRow = (await pool.query(`SELECT publication FROM ${q(schema, "analytics_v2_runs")}`)).rows[0].publication;
    assert.deepEqual(runRow.ownerSets, first.publication.ownerSets, "the run row records the owner-set summary");

    assert.deepEqual((await pool.query(`SELECT provenance, set_size, first_revision, frozen_export_sha256
        FROM ${q(schema, "analytics_v2_daily_owner_set_bootstrap")}`)).rows,
    [{ provenance: 1, set_size: 2, first_revision: 11, frozen_export_sha256: null }]);

    // An unchanged recorded head records nothing, whatever the fold names.
    const unchanged = await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3), computed(B, 5, 2)])]));
    assert.deepEqual(unchanged.publication.unchanged, [DAY_1]);
    assert.equal(unchanged.publication.ownerSets.contributionVersions, 0);
    // A recorded day never takes a first recording again, published or not.
    for (const bootstrap of [FIRST, ADOPTED]) {
      await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3), computed(B, 5, 2)],
        { bootstrap })])), { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field: "dailyCandidates.bootstrap" });
    }

    // Run 3: B departed (not computed; folds its version 1), A's values changed, C joins.
    const departed = { owners: outputs([]).owners.filter((owner) => owner.ownerDigest !== B) };
    const third = await write(client, schema, outputs([await candidate(DAY_1,
      [computed(A, 4), saved(B, 1), computed(C, 1)], { marker: 1 })], departed));
    assert.deepEqual(third.publication.published, [DAY_1]);
    assert.deepEqual({ added: third.publication.ownerSets.membersAdded,
      versions: third.publication.ownerSets.contributionVersions }, { added: 1, versions: 2 });
    assert.deepEqual((await setRows(schema)).map((row) => [row.owner_digest, row.first_revision]),
      [[A, 11], [B, 11], [C, 12]]);
    assert.deepEqual((await contributionRows(schema)).map((row) => [row.owner_digest, row.version, row.first_revision,
      row.daily_values.usageEvents]), [[A, 1, 11, 3], [A, 2, 12, 4], [B, 1, 11, 5], [C, 1, 12, 1]]);

    // A fold over a set that is not the stored one is refused, atomically.
    const before = await ownerSetSnapshot(schema);
    for (const [members, field] of [
      [[computed(A, 4), computed(C, 1)], "dailyCandidates.members"],
      [[computed(A, 4), saved(B, 2), computed(C, 1)], "dailyCandidates.members.savedVersion"],
      [[computed(A, 4), saved(B, 1), computed(C, 1), saved(digest("z").replace(/^./u, "f"), 1)], "dailyCandidates.members"],
      [[computed(A, 4), saved(B, 1), { ...saved(C, null, "excluded") }, { ...saved("f".repeat(64), null, "excluded") }],
        "dailyCandidates.members"],
    ]) {
      await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, members, { marker: 2 })], departed)),
        { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field });
      assert.deepEqual(await ownerSetSnapshot(schema), before);
    }
    await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, [computed(A, 4), saved(B, 1),
      computed(C, 1)], { marker: 2, bootstrap: { provenance: 3, frozenParticipants: 1,
      frozenExportSha256: "e".repeat(64) } })], departed)), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "dailyCandidates.bootstrap" });
    assert.deepEqual(await ownerSetSnapshot(schema), before);
  });
});

// Finding (E-OWNERSET review): a head published before saved owner sets were
// recorded (an older image, or a database that held heads when the migration
// was applied) is adopted the first time a run queues it, unchanged or not,
// with provenance 4 and a receipt; it is never left unrecorded, so a later
// departure cannot silently drop a member it folded.
test("PG17: an unrecorded head is adopted at its own revision when unchanged and at its new one when republished", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await insertKernel(schema);
  await withClient(async (client) => {
    const unchanged = await candidate(DAY_1, [computed(A, 1), computed(B, 2)]);
    await insertHead(schema, DAY_1, 7, unchanged.payload);
    const changed = await candidate(DAY_2, [computed(A, 3)]);
    await insertHead(schema, DAY_2, 4, { day: DAY_2, marker: 9, totals: { contributingParticipants: 1 } });
    const heads = async () => (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, revision, payload_sha256
        FROM ${q(schema, "analytics_v2_published_daily")} ORDER BY day`)).rows;
    const before = await heads();
    // The fold must name the adoption: a first publication's provenance, or
    // none, is refused for a day that has a head; an adoption for a day
    // without one is refused too.
    const settled = await ownerSetSnapshot(schema);
    for (const [candidates, field] of [
      [[{ ...unchanged, bootstrap: FIRST }], "dailyCandidates.bootstrap"],
      [[{ ...changed, bootstrap: null }], "dailyCandidates.bootstrap"],
      [[await candidate(DAY_3, [computed(A, 1)], { bootstrap: ADOPTED })], "dailyCandidates.bootstrap"],
    ]) {
      await assert.rejects(write(client, schema, outputs(candidates)), { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field });
      assert.deepEqual(await ownerSetSnapshot(schema), settled);
    }
    const run = await write(client, schema, outputs([{ ...unchanged, bootstrap: ADOPTED },
      { ...changed, bootstrap: ADOPTED }]));
    assert.deepEqual([run.publication.published, run.publication.unchanged], [[DAY_2], [DAY_1]]);
    assert.deepEqual(run.publication.ownerSets, writes({ membersAdded: 3, contributionVersions: 3, daysRecorded: 2,
      bootstrapAdoptedDays: [DAY_1, DAY_2] }));
    // The unchanged head keeps its row; its set is recorded at its revision.
    const after = await heads();
    assert.deepEqual(after[0], before[0]);
    assert.equal(after[1].revision, 5);
    assert.deepEqual((await setRows(schema)).map((row) => [row.day, row.owner_digest, row.first_revision, row.provenance]),
      [[DAY_1, A, 7, 4], [DAY_1, B, 7, 4], [DAY_2, A, 5, 4]]);
    assert.deepEqual((await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, provenance, set_size, first_revision
        FROM ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} ORDER BY day`)).rows,
    [{ day: DAY_1, provenance: 4, set_size: 2, first_revision: 7 }, { day: DAY_2, provenance: 4, set_size: 1, first_revision: 5 }]);
    // Recorded now: the next unchanged run records nothing, and the reader
    // sees the days as recorded.
    const again = await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 1), computed(B, 2)])]));
    assert.deepEqual(again.publication.ownerSets, writes());
    const state = await ownerSets.readAnalyticsV2OwnerSetState({ pool, schema, nowMs: Date.parse(NOW) },
      { days: [DAY_1, DAY_2] });
    assert.deepEqual([...state.days.values()].map((day) => [day.recorded, day.headPublished, day.members.size]),
      [[true, true, 2], [true, true, 1]]);
  });
});

test("PG17: a frozen-window first recording writes its receipt once, and the store refuses malformed sets", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await withClient(async (client) => {
    const bootstrap = { provenance: 3, frozenParticipants: 5, frozenExportSha256: "e".repeat(64),
      frozenFromDay: "2025-09-30", frozenThroughDay: DAY_2 };
    const first = await write(client, schema, outputs([
      await candidate(DAY_1, [computed(A, 1), computed(B, 1)], { bootstrap }),
      await candidate(DAY_2, [computed(A, 1)], { bootstrap: { ...bootstrap, provenance: 2, frozenParticipants: 1 } }),
    ]));
    assert.deepEqual({ verified: first.publication.ownerSets.bootstrapVerifiedDays,
      disclosed: first.publication.ownerSets.bootstrapDisclosedDays }, { verified: [DAY_2], disclosed: [DAY_1] });
    assert.deepEqual((await setRows(schema)).map((row) => [row.day, row.owner_digest, row.provenance]),
      [[DAY_1, A, 3], [DAY_1, B, 3], [DAY_2, A, 2]]);
    assert.deepEqual((await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, provenance, set_size,
        frozen_participants, first_revision, to_char(frozen_from_day, 'YYYY-MM-DD') AS from_day,
        to_char(frozen_through_day, 'YYYY-MM-DD') AS through_day
        FROM ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} ORDER BY day`)).rows,
    [{ day: DAY_1, provenance: 3, set_size: 2, frozen_participants: 5, first_revision: 1, from_day: "2025-09-30",
      through_day: DAY_2 },
    { day: DAY_2, provenance: 2, set_size: 1, frozen_participants: 1, first_revision: 1, from_day: "2025-09-30",
      through_day: DAY_2 }]);
    // A day's set is bootstrapped once; a later member joins with provenance 1.
    const before = await ownerSetSnapshot(schema);
    await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, [computed(A, 1), computed(B, 1),
      computed(C, 1)], { marker: 1, bootstrap })])), { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field: "dailyCandidates.bootstrap" });
    assert.deepEqual(await ownerSetSnapshot(schema), before);
    await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 1), computed(B, 1), computed(C, 1)],
      { marker: 1 })]));
    assert.deepEqual((await setRows(schema)).filter((row) => row.day === DAY_1).map((row) => row.provenance), [3, 3, 1]);

    // A receipt without members (a first recording whose set was empty, then
    // purged, or a set of size 0) still marks the day recorded: a bootstrap
    // against it is refused, atomically.
    const empty = "2026-09-25";
    await insertReceipt(client, schema, empty, { provenance: 1, setSize: 0 });
    const withReceipt = await ownerSetSnapshot(schema);
    await assert.rejects(write(client, schema, outputs([await candidate(empty, [computed(A, 1)],
      { bootstrap: FIRST })])), { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field: "dailyCandidates.bootstrap" });
    assert.deepEqual(await ownerSetSnapshot(schema), withReceipt);
    const joined = await write(client, schema, outputs([await candidate(empty, [computed(A, 1)])]));
    assert.deepEqual([joined.publication.ownerSets.membersAdded, joined.publication.ownerSets.daysRecorded], [1, 0]);

    // Closed validation before any database work.
    const settled = await ownerSetSnapshot(schema);
    const legacy = { participantId: "participant-legacy", ownerDigest: digest("legacy"), hasV1: false, hasV11: false,
      hasV12: false, hasLegacy: true, hasEffective: false, source: "v0.2" };
    const invalidCases = [
      [[computed(B, 1), computed(A, 1)], {}, "dailyCandidates.members"],
      [[computed(A, 1), computed(A, 1)], {}, "dailyCandidates.members"],
      [[{ ...computed(A, 1), extra: true }], {}, "dailyCandidates.members"],
      [[computed(legacy.ownerDigest, 1)], { owners: [...outputs([]).owners, legacy] }, "dailyCandidates.members.computed"],
      [[{ ...computed(A, 1), values: { usageEvents: 1 } }], {}, "dailyCandidates.members.computed"],
      [[{ ...computed(A, 1), devices: 0 }], {}, "dailyCandidates.members.devices"],
      [[{ ...computed(A, 1), savedVersion: 1 }], {}, "dailyCandidates.members.computed"],
      [[saved(A, 1)], {}, "dailyCandidates.members.origin"],
      [[saved(A, 1, "retained"), saved(legacy.ownerDigest, 1, "retained")], { owners: [...outputs([]).owners, legacy] },
        "dailyCandidates.members.origin"],
      [[{ ...saved(A, 1), values: values(1) }], {}, "dailyCandidates.members.values"],
      [[saved(A, 0, "retained")], {}, "dailyCandidates.members.savedVersion"],
      [[{ ...saved(A, 1, "excluded") }], {}, "dailyCandidates.members.savedVersion"],
    ];
    for (const [members, overrides, field] of invalidCases) {
      await assert.rejects(write(client, schema, outputs([await candidate("2026-09-20", members)], overrides)),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID", field }, field);
    }
    const counted = await candidate("2026-09-20", [computed(A, 1)]);
    await assert.rejects(write(client, schema, outputs([{ ...counted, payload: { ...counted.payload,
      totals: { contributingParticipants: 2 } }, payloadSha256: await store.analyticsV2DailyContentSha256({
      ...counted.payload, totals: { contributingParticipants: 2 } }) }])),
    { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "dailyCandidates.members.contributingParticipants" });
    for (const value of [{ ...bootstrap, provenance: 2 }, { ...bootstrap, provenance: 1 }, { ...bootstrap, extra: 1 },
      { ...bootstrap, frozenExportSha256: "E".repeat(64) }, { ...bootstrap, provenance: 5 },
      { ...bootstrap, frozenFromDay: "2026-09-21" }, { ...bootstrap, frozenThroughDay: "2026-09-19" },
      { ...bootstrap, frozenFromDay: null }, { ...FIRST, frozenParticipants: 1 }, { ...ADOPTED, frozenThroughDay: DAY_2 },
      { provenance: 1 }]) {
      await assert.rejects(write(client, schema, outputs([await candidate("2026-09-20", [computed(A, 1)],
        { bootstrap: value })])), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "dailyCandidates.bootstrap" });
    }
    for (const value of [undefined, { ...NO_OWNER_SETS, extra: 0 }, { ...NO_OWNER_SETS, savedMembersFolded: -1 },
      { ...NO_OWNER_SETS, memberContributionUnavailableDays: ["2026-09-20"] },
      { ...NO_OWNER_SETS, memberLinkUnavailableDays: ["2026-09-20"] },
      { contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0, memberContributionUnavailableDays: [] }]) {
      await assert.rejects(write(client, schema, outputs([], { ownerSets: value })),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID" });
    }
    assert.deepEqual(await ownerSetSnapshot(schema), settled, "a refused run writes nothing");
  });
});
