/**
 * PG17 spec for E-OWNERSET: the staged owner-sets migration (saved owner sets,
 * versioned member contributions, the frozen-window bootstrap receipt), its
 * reader (src/analytics-v2/owner-sets.ts) and the store's owner-set write
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
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
const digest = (label) => createHash("sha256").update(`analytics-v2-owner-sets-spec:${label}`).digest("hex");
const OWNER_A = digest("owner-a");
const OWNER_B = digest("owner-b");
const OWNER_C = digest("owner-c");
const [A, B, C] = [OWNER_A, OWNER_B, OWNER_C].sort();
const HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
const NO_OWNER_SETS = Object.freeze({ contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
  memberContributionUnavailableDays: [] });

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
  await applyStockAndStagedMigrations({ role: "primary", schema, pool,
    stagedFiles: ownerSetsMigration ? [OWNER_SETS_FILE] : [] });
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
async function insertMember(client, schema, day, ownerDigest, { revision = 1, versions = [1] } = {}) {
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

  // The bootstrap receipt: verified exactly when the counts agree, and immutable.
  const receipt = (provenance, setSize, frozen) => pool.query(`INSERT INTO ${bootstrap}
      (day, provenance, set_size, frozen_participants, frozen_export_sha256, first_revision, run_id, kernel_id,
       manifest_version) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, 1)`, [DAY_2, provenance, setSize, frozen, "e".repeat(64), RUN]);
  for (const [provenance, setSize, frozen] of [[2, 3, 4], [2, 0, null], [3, 3, 3], [1, 3, 3]]) {
    await assert.rejects(receipt(provenance, setSize, frozen), { code: "23514" });
  }
  await receipt(3, 2, null);
  for (const statement of [`UPDATE ${bootstrap} SET set_size = 3`, `DELETE FROM ${bootstrap}`, `TRUNCATE ${bootstrap}`]) {
    await assert.rejects(pool.query(statement), { code: "P1005", message: "analytics_v2_owner_set_bootstrap_immutable" });
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

test("PG17: the reader refuses a schema without the migration and reads sets, current versions and receipts", {
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
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} (day, provenance, set_size,
      frozen_participants, frozen_export_sha256, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, 3, 0, NULL, $2, 1, $3, 1, 1)`, [DAY_2, "e".repeat(64), RUN]);
  const context = { pool, schema, nowMs: Date.parse(NOW) };
  const state = await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [DAY_2, DAY_1, "2026-09-30"] });
  assert.deepEqual([...state.days.keys()], [DAY_1, DAY_2, "2026-09-30"]);
  assert.deepEqual([...state.days.get(DAY_1).members], [
    [A, { version: 2, devices: 1, valuesSha256: "c".repeat(64) }],
    [B, { version: 1, devices: 1, valuesSha256: "c".repeat(64) }]].sort(([left], [right]) => (left < right ? -1 : 1)));
  assert.equal(state.days.get(DAY_2).bootstrapped, true);
  assert.equal(state.days.get("2026-09-30").members.size, 0);
  assert.equal(state.frozen, null, "no frozen export: nothing to compare with");
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
});

test("PG17: the reader verifies the frozen export only for a first recording inside its window", {
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
  // A day after the window, or one already recorded, needs no frozen read.
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: ["2026-10-02"] })).frozen, null);
  await insertKernel(schema);
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} (day, provenance, set_size,
      frozen_participants, frozen_export_sha256, first_revision, run_id, kernel_id, manifest_version)
      VALUES ($1, 3, 0, NULL, $2, 1, $3, 1, 1)`, [inWindow, "e".repeat(64), RUN]);
  assert.equal((await ownerSets.readAnalyticsV2OwnerSetState(context, { days: [inWindow] })).frozen, null);
});

test("PG17: the store records each publication's set and contributions at its revision and appends only changes", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await withClient(async (client) => {
    // Run 1 publishes DAY_1 with A and B, under a revision seed (the single publication helper).
    const first = await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3), computed(B, 5, 2)])],
      { revisionSeed: 10 }));
    assert.deepEqual(first.publication.ownerSets, { ...NO_OWNER_SETS, membersAdded: 2, contributionVersions: 2,
      bootstrapVerifiedDays: [], bootstrapDisclosedDays: [] });
    assert.equal(store.nextPublishedRevision({ headRevision: null, revisionSeed: 10 }), 11);
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

    // An unchanged head records nothing, whatever the fold names.
    const unchanged = await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 3), computed(B, 5, 2)])]));
    assert.deepEqual(unchanged.publication.unchanged, [DAY_1]);
    assert.equal(unchanged.publication.ownerSets.contributionVersions, 0);

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

test("PG17: a frozen-window first recording writes its receipt once, and the store refuses malformed sets", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const schema = await createSchema();
  await withClient(async (client) => {
    const bootstrap = { provenance: 3, frozenParticipants: 5, frozenExportSha256: "e".repeat(64) };
    const first = await write(client, schema, outputs([
      await candidate(DAY_1, [computed(A, 1), computed(B, 1)], { bootstrap }),
      await candidate(DAY_2, [computed(A, 1)], { bootstrap: { ...bootstrap, provenance: 2, frozenParticipants: 1 } }),
    ]));
    assert.deepEqual({ verified: first.publication.ownerSets.bootstrapVerifiedDays,
      disclosed: first.publication.ownerSets.bootstrapDisclosedDays }, { verified: [DAY_2], disclosed: [DAY_1] });
    assert.deepEqual((await setRows(schema)).map((row) => [row.day, row.owner_digest, row.provenance]),
      [[DAY_1, A, 3], [DAY_1, B, 3], [DAY_2, A, 2]]);
    assert.deepEqual((await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, provenance, set_size,
        frozen_participants, first_revision FROM ${q(schema, "analytics_v2_daily_owner_set_bootstrap")} ORDER BY day`)).rows,
    [{ day: DAY_1, provenance: 3, set_size: 2, frozen_participants: 5, first_revision: 1 },
      { day: DAY_2, provenance: 2, set_size: 1, frozen_participants: 1, first_revision: 1 }]);
    // A day's set is bootstrapped once; a later member joins with provenance 1.
    const before = await ownerSetSnapshot(schema);
    await assert.rejects(write(client, schema, outputs([await candidate(DAY_1, [computed(A, 1), computed(B, 1),
      computed(C, 1)], { marker: 1, bootstrap })])), { code: "ANALYTICS_V2_OWNER_SET_CHANGED", field: "dailyCandidates.bootstrap" });
    assert.deepEqual(await ownerSetSnapshot(schema), before);
    await write(client, schema, outputs([await candidate(DAY_1, [computed(A, 1), computed(B, 1), computed(C, 1)],
      { marker: 1 })]));
    assert.deepEqual((await setRows(schema)).filter((row) => row.day === DAY_1).map((row) => row.provenance), [3, 3, 1]);

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
      { ...bootstrap, frozenExportSha256: "E".repeat(64) }]) {
      await assert.rejects(write(client, schema, outputs([await candidate("2026-09-20", [computed(A, 1)],
        { bootstrap: value })])), { code: "ANALYTICS_V2_OUTPUTS_INVALID", field: "dailyCandidates.bootstrap" });
    }
    for (const value of [undefined, { ...NO_OWNER_SETS, extra: 0 }, { ...NO_OWNER_SETS, savedMembersFolded: -1 },
      { ...NO_OWNER_SETS, memberContributionUnavailableDays: ["2026-09-20"] }]) {
      await assert.rejects(write(client, schema, outputs([], { ownerSets: value })),
        { code: "ANALYTICS_V2_OUTPUTS_INVALID" });
    }
    assert.deepEqual(await ownerSetSnapshot(schema), settled, "a refused run writes nothing");
  });
});
