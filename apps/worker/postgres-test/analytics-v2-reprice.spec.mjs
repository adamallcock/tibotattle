/** Genuine PostgreSQL saved-cohort repricing regression tests. Synthetic only. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import config from "../vitest.analytics-v2.config.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { applyStockAndStagedMigrations, postgresTestEndpoint,
  NO_ANALYTICS_V2_EXCLUSIONS_SHA256 } from "./staged-migrations-harness.mjs";
import { dayMs, syntheticOwner, usage } from "../analytics-v2-test/fixtures/synthetic-occurrences.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = await postgresTestEndpoint();
const SKIP = ENDPOINT === null ? "set the reviewed local PG_TEST_HOST/socket and PG_TEST_PORT" : false;
const BUNDLED = JSON.parse(await readFile(join(ROOT, "src/analytics-v2/kernel-registry.json"), "utf8")).kernels.at(-1);
const DAY = "2026-09-20", NEXT_DAY = "2026-09-21";
const NOW = "2026-10-09T12:00:00.000Z", RELEASED = "2026-09-22T03:00:00.000Z";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const owner = (n) => n.toString(16).padStart(64, "0");
let vite, pool, store, runStore, domain, reprice, readReprice, prices, kernels, route, canonical, target, old;

before(async () => {
  vite = await createServer({ root: ROOT, configFile: false, plugins: config.plugins,
    resolve: config.resolve, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    logLevel: "silent", define: {
      __ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__: JSON.stringify(BUNDLED.computeClosureSha256),
      __ANALYTICS_V2_VENDOR_MANIFEST_SHA256__: JSON.stringify(BUNDLED.vendorManifestSha256),
    } });
  const load = (path) => vite.ssrLoadModule(path);
  store = await load("/src/analytics-v2/store.ts");
  runStore = await load("/src/analytics-v2/store-run.ts");
  domain = await load("/src/analytics-v2/reprice.ts");
  reprice = await load("/src/analytics-v2/reprice-store.ts");
  readReprice = await load("/src/analytics-v2/reprice-read.ts");
  prices = await load("/src/analytics-v2/price-attribution.ts");
  kernels = await load("/vendor/analytics-d43c8f92/entry.ts");
  route = await load("/src/analytics-v2/community-daily-route.ts");
  canonical = (await load("/src/canonical-json.ts")).canonicalJson;
  target = store.analyticsV2BaselineRunStamp(BUNDLED);
  old = store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry()[9]);
  if (ENDPOINT) pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 4, connectionTimeoutMillis: 5000,
    application_name: "analytics-v2-reprice-spec", options: "-c search_path=pg_catalog" });
});
after(async () => { await pool?.end(); await vite?.close(); });

function q(schema, table) {
  assert.match(schema, /^k_reprice_[0-9a-f]+$/u);
  assert.match(table, /^[a-z_][a-z0-9_]*$/u);
  return `"${schema}"."${table}"`;
}
async function withSchema(work, { beforeReprice = false, beforeVersion = beforeReprice ? 77 : null } = {}) {
  const schema = `k_reprice_${randomBytes(5).toString("hex")}`;
  let prefix;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  try {
    if (beforeVersion !== null) {
      prefix = await mkdtemp(join(tmpdir(), "tibotattle-reprice-migrations-"));
      await mkdir(join(prefix, "primary"));
      for (const migration of await readPostgresMigrations({ role: "primary" })) {
        if (migration.version < beforeVersion) await copyFile(join(ROOT, "postgres/migrations/primary", migration.name),
          join(prefix, "primary", migration.name));
      }
    }
    await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [],
      ...(prefix ? { rootDirectory: prefix } : {}) });
    return await work(schema);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (prefix) await rm(prefix, { recursive: true, force: true });
  }
}
async function transaction(work, { rollback = false } = {}) {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function insert(client, schema, table, values) {
  const keys = Object.keys(values);
  return client.query(`INSERT INTO ${q(schema, table)} (${keys.map((key) => `"${key}"`).join(",")})
    VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(values));
}
const bounds = (overrides = {}) => ({ fromDay: DAY, throughDay: NEXT_DAY,
  maxDays: 2, maxMembers: 10, maxInputBytes: 1048576, ...overrides });
const options = (schema, overrides = {}) => ({ schema, stamp: target, bounds: bounds(overrides) });
async function plan(schema, overrides) { return reprice.planAnalyticsV2Reprice(pool, options(schema, overrides)); }
async function execute(schema, receipt, overrides = {}) {
  let sourceFailure;
  const observedPool = { connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (...args) => {
      try { return await client.query(...args); }
      catch (error) {
        sourceFailure = { sqlstate: error.code, constraint: error.constraint ?? null,
          table: [...coreTables, ...auditTables].find((table) => String(args[0]).includes(table)) ?? null };
        throw error;
      }
    } };
  } };
  try {
    return await reprice.executeAnalyticsV2Reprice(observedPool, { ...options(schema), runId: randomUUID(),
      expectedPlanSha256: receipt.planSha256, nowMs: Date.parse(NOW), ...overrides });
  } catch (error) {
    if (sourceFailure) error.sourceFailure = sourceFailure; // Safe structural diagnostics; never bind values or driver text.
    throw error;
  }
}
const coreTables = ["analytics_v2_runs", "analytics_v2_kernels", "analytics_v2_owner_day", "analytics_v2_owner_day_price",
  "analytics_v2_published_daily", "analytics_v2_daily_owner_sets", "analytics_v2_daily_contributions",
  "analytics_v2_daily_owner_set_bootstrap", "analytics_v2_journal_cursor", "analytics_v2_preview"];
const auditTables = ["analytics_v2_reprice_runs", "analytics_v2_price_equivalences",
  "analytics_v2_published_daily_log", "analytics_v2_contribution_price_inputs"];
async function snapshot(schema, tables = [...coreTables, ...auditTables]) {
  const output = {};
  for (const table of tables) output[table] = (await pool.query(`SELECT
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows FROM ${q(schema, table)} t`)).rows[0].rows;
  return output;
}
async function headRow(schema, day = DAY) {
  return (await pool.query(`SELECT day::text,revision,payload,payload_sha256::text,run_id::text,kernel_id,
    released_at::text FROM ${q(schema, "analytics_v2_published_daily")} WHERE day=$1`, [day])).rows[0];
}
async function infrastructure(schema) {
  await transaction(async (client) => {
    await runStore.registerAnalyticsV2RunKernel(client, `"${schema}"`, old, RELEASED);
    await insert(client, schema, "analytics_v2_kernel_prices", { kernel_id: old.kernel.kernelId,
      compute_sha256: null, cards_sha256: hash("synthetic-cards"), cards: 1,
      projection_version: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, registered_at: RELEASED });
    await insert(client, schema, "analytics_v2_price_bases", { price_basis_id: 1, basis_sha256: hash([]), card_refs: [] });
    const runId = randomUUID();
    await insert(client, schema, "analytics_v2_runs", { run_id: runId, started_at: RELEASED, finished_at: RELEASED,
      mode: "full", state: "complete", owners: 0, owner_days: 0, refusals: "[]",
      publication: JSON.stringify({ published: [], unchanged: [], blocked: [] }), timings: "{}",
      kernel_id: old.kernel.kernelId, manifest_version: 1, compatibility_sha256: hash("synthetic-compatibility"),
      exclusions_sha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256 });
    await insert(client, schema, "analytics_v2_journal_cursor", { id: 1, last_sequence: 123, run_id: runId });
    await insert(client, schema, "analytics_v2_preview", { id: 1, preview: JSON.stringify({ synthetic: "sentinel" }),
      computed_at: RELEASED, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
  });
  await pool.query(`UPDATE ${q(schema, "collection_controls")} SET revision=revision+1, control_state='operational',
    enrollment_enabled=true,upload_registration_enabled=true,processing_enabled=true,publication_enabled=true,
    reason_code='maintenance',updated_at=clock_timestamp() WHERE singleton=1`);
}
/** Old stamps and pricing are hand-built; all non-price values use the real kernel fold. */
async function seedDay(schema, { day = DAY, owners = [1], quotaOnly = false, changedCost = false,
  wrongAssociation = false, excluded = [] } = {}) {
  const runId = randomUUID(), members = [];
  await transaction(async (client) => {
    await insert(client, schema, "analytics_v2_daily_owner_set_bootstrap", { day, provenance: 1,
      set_size: owners.length, first_revision: 4, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
    for (const n of owners) {
      const ownerDigest = owner(n), participant = `synthetic-reprice-owner-${n}`;
      await client.query(`INSERT INTO ${q(schema, "participants")} (id,created_at) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [participant, RELEASED]);
      await client.query(`INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
        VALUES($1,$2,'withdrawn') ON CONFLICT DO NOTHING`, [participant, ownerDigest]);
      let values = kernels.createV11DailyProjectionValues(day), events = [];
      if (quotaOnly) values.counts.quota = n;
      else {
        const record = JSON.parse(usage(syntheticOwner(1), n, dayMs(day) + n * 1000).recordJson);
        values = kernels.foldV11DailyProjectionValues(values, [record]);
        const input = prices.analyticsV2PriceInput(record);
        const priced = prices.priceAnalyticsV2Input(input);
        assert.equal(priced.status, prices.ANALYTICS_V2_PRICE_STATUS.fullyPriced);
        events = [{ input, priced: changedCost ? { ...priced, costNanousd: 1 } : priced }];
        if (changedCost) { values.pricing.knownNanousd = "1"; values.cells[0].pricing.knownNanousd = "1"; }
      }
      values.registrySha256 = old.kernel.priceRegistrySha256;
      values.pricingMethodVersion = "server-api-price-equivalent-v0.5";
      const digests = await store.analyticsV2ContributionDigests(values);
      await insert(client, schema, "analytics_v2_daily_owner_sets", { day, owner_digest: ownerDigest,
        first_revision: 4, provenance: 1, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
      await insert(client, schema, "analytics_v2_daily_contributions", { day, owner_digest: ownerDigest, version: 1,
        daily_values: JSON.stringify(values), values_schema: values.schemaVersion, values_sha256: digests.valuesSha256,
        stable_values_sha256: digests.stableValuesSha256, devices: n, price_kernel_id: old.kernel.kernelId,
        first_revision: 4, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
      if (!quotaOnly) {
        const priceRun = wrongAssociation ? randomUUID() : runId;
        const { inputs } = await prices.encodeAnalyticsV2PriceInputs(events);
        await insert(client, schema, "analytics_v2_owner_day", { day, owner_digest: ownerDigest,
          daily: JSON.stringify(values), refusal: null, run_id: priceRun, kernel_id: old.kernel.kernelId, manifest_version: 1 });
        await insert(client, schema, "analytics_v2_owner_day_price", { day, owner_digest: ownerDigest, price_basis_id: 1,
          usage_events: 1, unpriced_events: 0, partially_priced_events: 0, projection_version: inputs.projectionVersion,
          codec: inputs.codec, inputs: Buffer.from(inputs.data, "base64"), inputs_sha256: inputs.sha256, input_events: 1,
          run_id: priceRun, kernel_id: old.kernel.kernelId, manifest_version: 1 });
      }
      if (excluded.includes(n)) await insert(client, schema, "community_aggregate_exclusions", {
        exclusion_id: `synthetic-reprice-exclusion-${n}`, participant_id: participant, scope: "community_weekly",
        reason_code: "manual_review", state: "active", effective_at: "2026-01-01T00:00:00.000Z",
        created_at: RELEASED, created_by_digest: hash("synthetic-admin") });
      members.push({ ownerDigest, values, devices: n, excluded: excluded.includes(n) });
    }
    const folded = members.filter((m) => !m.excluded);
    const normalized = folded.map((m) => ({ ...m.values,
      registrySha256: kernels.createV11DailyProjectionValues(day).registrySha256,
      pricingMethodVersion: kernels.createV11DailyProjectionValues(day).pricingMethodVersion }));
    const payload = kernels.buildCommunityDailyPayload({ day, revision: 4, releasedAt: RELEASED,
      ...kernels.publicInputs(normalized, folded.map((m) => m.devices)) });
    payload.apiEquivalentSpend.registrySha256 = old.kernel.priceRegistrySha256;
    payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.5";
    await insert(client, schema, "analytics_v2_published_daily", { day, revision: 4, released_at: RELEASED,
      payload: JSON.stringify(payload), payload_sha256: await store.analyticsV2DailyContentSha256(payload),
      run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
  });
  return members;
}
async function expectCode(promise, code) { await assert.rejects(promise, (error) => error?.code === code); }

test("PG: pre-migration planning/execution refuse; post-migration planning is stable and read-only", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await expectCode(plan(schema), "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE");
    await expectCode(execute(schema, { planSha256: "0".repeat(64) }), "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE");
    const metadata = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'analytics_v2_reprice%'", [schema]);
    assert.equal(metadata.rows[0].n, 0);
  }, { beforeReprice: true });
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { quotaOnly: true });
    const before = await snapshot(schema);
    let readOnly = false;
    const observedPool = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (...args) => {
        const result = await client.query(...args);
        if (String(args[0]).startsWith("BEGIN")) {
          readOnly = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
        }
        for (const row of result.rows ?? []) {
          assert.equal(Object.hasOwn(row, "inputs"), false, "planning never retrieves compressed input bodies");
          assert.equal(Object.hasOwn(row, "daily_values"), false, "planning never retrieves contribution documents");
          assert.equal(Object.hasOwn(row, "payload"), false, "planning never retrieves published payloads");
        }
        return result;
      } };
    } };
    const first = await reprice.planAnalyticsV2Reprice(observedPool, options(schema)), second = await plan(schema);
    assert.equal(readOnly, true);
    assert.deepEqual(first, second);
    assert.match(first.planSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(first.counts, { heads: 1, members: 1, inputBytes: 0 });
    assert.deepEqual(first.caps, { heads: false, members: false, inputBytes: false });
    assert.deepEqual(Object.keys(first).sort(), ["caps", "counts", "planSha256", "schema", "status", "target"]);
    assert.deepEqual(await snapshot(schema), before);
  });
});

test("PG: quota-only equivalence preserves heads, proves the public reader and replays without writes", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { quotaOnly: true, owners: [1, 2], excluded: [2] });
    const before = await snapshot(schema, coreTables), original = await headRow(schema), planned = await plan(schema);
    const runId = randomUUID(), receipt = await execute(schema, planned, { runId });
    assert.deepEqual(receipt.counts, { planned: 1, changed: 0, equivalent: 1, unchanged: 0, refused: 0, contributionVersions: 0 });
    assert.deepEqual(await snapshot(schema, coreTables), { ...before,
      analytics_v2_kernels: (await snapshot(schema, ["analytics_v2_kernels"])).analytics_v2_kernels });
    assert.deepEqual(await headRow(schema), original);
    const heads = [{ day: DAY, revision: original.revision, payloadSha256: original.payload_sha256 }];
    const proof = await transaction((client) => readReprice.readAnalyticsV2RepriceEquivalences(client,
      { schema, stamp: target, heads }), { rollback: true });
    assert.deepEqual([...proof], [[DAY, { registrySha256: target.kernel.priceRegistrySha256,
      pricingMethodVersion: kernels.createV11DailyProjectionValues(DAY).pricingMethodVersion }]]);
    const response = await route.createAnalyticsV2CommunityDailyRoute({ pool, schema }).handler(
      new Request(`http://127.0.0.1/api/v1/community/daily?from=${DAY}&to=${DAY}`));
    assert.equal(response.status, 200);
    const served = (await response.json()).days[0];
    assert.equal(served.revision, 4);
    assert.equal(served.payload.apiEquivalentSpend.registrySha256, target.kernel.priceRegistrySha256);
    assert.equal(served.payload.apiEquivalentSpend.knownCostUsd, 0);
    const after = await snapshot(schema);
    assert.deepEqual(await execute(schema, planned, { runId }), { ...receipt, replayed: true });
    assert.deepEqual(await snapshot(schema), after);
    const next = await execute(schema, await plan(schema));
    assert.deepEqual(next.counts, { planned: 1, changed: 0, equivalent: 0, unchanged: 1, refused: 0, contributionVersions: 0 });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema, "analytics_v2_price_equivalences")}`)).rows[0].n, 1);
  });
});

test("PG: changed dollars advance one revision, archive the prior head and retain exact versioned inputs", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { changedCost: true });
    const before = await snapshot(schema, ["analytics_v2_journal_cursor", "analytics_v2_preview", "analytics_v2_runs"]);
    const original = await headRow(schema), runId = randomUUID(), planned = await plan(schema);
    const receipt = await execute(schema, planned, { runId });
    assert.deepEqual(receipt.counts, { planned: 1, changed: 1, equivalent: 0, unchanged: 0, refused: 0, contributionVersions: 1 });
    const current = await headRow(schema);
    assert.equal(current.revision, 5);
    assert.equal(current.kernel_id, target.kernel.kernelId);
    assert.notEqual(current.payload.apiEquivalentSpend.knownCostUsd, original.payload.apiEquivalentSpend.knownCostUsd);
    assert.equal(domain.analyticsV2RepriceNonSpend(current.payload), domain.analyticsV2RepriceNonSpend(original.payload));
    const archived = (await pool.query(`SELECT revision,payload,payload_sha256::text,run_id::text,kernel_id FROM
      ${q(schema, "analytics_v2_published_daily_log")} WHERE day=$1`, [DAY])).rows;
    assert.deepEqual(archived, [{ revision: 4, payload: original.payload, payload_sha256: original.payload_sha256,
      run_id: original.run_id, kernel_id: original.kernel_id }]);
    const retained = (await pool.query(`SELECT version,values_sha256::text,inputs_sha256::text,source_inputs_sha256::text,
      inputs,input_events,run_id::text,kernel_id FROM ${q(schema, "analytics_v2_contribution_price_inputs")}`)).rows[0];
    assert.equal(retained.version, 2);
    assert.equal(retained.run_id, runId);
    assert.equal(retained.kernel_id, target.kernel.kernelId);
    const values = (await pool.query(`SELECT daily_values,values_sha256::text FROM
      ${q(schema, "analytics_v2_daily_contributions")} WHERE version=2`)).rows[0];
    assert.equal(retained.values_sha256, values.values_sha256);
    const decoded = await prices.decodeAnalyticsV2PriceInputs({ projectionVersion: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION,
      codec: prices.ANALYTICS_V2_PRICE_INPUTS_CODEC, sha256: retained.inputs_sha256,
      bytes: retained.inputs, events: retained.input_events });
    prices.assertAnalyticsV2PricesMatchDaily(DAY, decoded.events, values.daily_values);
    assert.equal(decoded.events[0].priced.costNanousd, prices.priceAnalyticsV2Input(decoded.events[0].input).costNanousd);
    assert.deepEqual(await snapshot(schema, Object.keys(before)), before);
    const after = await snapshot(schema);
    assert.deepEqual(await execute(schema, planned, { runId }), { ...receipt, replayed: true });
    assert.deepEqual(await snapshot(schema), after);
    assert.equal((await plan(schema)).counts.heads, 0);
    // Ordinary owner-day replacement cascades its mutable price row, never the saved version's input archive.
    await pool.query(`DELETE FROM ${q(schema, "analytics_v2_owner_day")} WHERE owner_digest=$1 AND day=$2`, [owner(1), DAY]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema, "analytics_v2_owner_day_price")}`)).rows[0].n, 0);
    const replacementRun = randomUUID(), replacementValues = kernels.createV11DailyProjectionValues(DAY);
    replacementValues.counts.quota = 9;
    const replacementInputs = (await prices.encodeAnalyticsV2PriceInputs([])).inputs;
    await transaction(async (client) => {
      await insert(client, schema, "analytics_v2_owner_day", { day: DAY, owner_digest: owner(1),
        daily: JSON.stringify(replacementValues), refusal: null, run_id: replacementRun,
        kernel_id: old.kernel.kernelId, manifest_version: 1 });
      await insert(client, schema, "analytics_v2_owner_day_price", { day: DAY, owner_digest: owner(1), price_basis_id: 1,
        usage_events: 0, unpriced_events: 0, partially_priced_events: 0,
        projection_version: replacementInputs.projectionVersion, codec: replacementInputs.codec,
        inputs: Buffer.from(replacementInputs.data, "base64"), inputs_sha256: replacementInputs.sha256,
        input_events: 0, run_id: replacementRun, kernel_id: old.kernel.kernelId, manifest_version: 1 });
    });
    const replacement = (await pool.query(`SELECT run_id::text,inputs_sha256::text,input_events FROM
      ${q(schema, "analytics_v2_owner_day_price")} WHERE owner_digest=$1 AND day=$2`, [owner(1), DAY])).rows[0];
    assert.deepEqual(replacement, { run_id: replacementRun, inputs_sha256: replacementInputs.sha256, input_events: 0 });
    assert.notEqual(replacement.inputs_sha256, retained.inputs_sha256);
    assert.deepEqual((await pool.query(`SELECT version,values_sha256::text,inputs_sha256::text,source_inputs_sha256::text,
      inputs,input_events,run_id::text,kernel_id FROM ${q(schema, "analytics_v2_contribution_price_inputs")}`)).rows[0], retained);
  });
});

test("PG: a strict association refusal preserves its head while an independent valid day commits", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { changedCost: true, wrongAssociation: true });
    await seedDay(schema, { day: NEXT_DAY, changedCost: true, owners: [2] });
    const original = await headRow(schema), planned = await plan(schema);
    const receipt = await execute(schema, planned);
    assert.equal(receipt.counts.refused, 1);
    assert.equal(receipt.counts.changed, 1);
    assert.equal(receipt.refusals.price_input_association_unproven, 1);
    assert.deepEqual(await headRow(schema), original);
    assert.equal((await headRow(schema, NEXT_DAY)).revision, 5);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema, "analytics_v2_contribution_price_inputs")} WHERE day=$1`, [DAY])).rows[0].n, 0);
  });
});

test("PG: changed plans and each planning cap refuse without writes", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { quotaOnly: true, owners: [1, 2] });
    const planned = await plan(schema);
    await pool.query(`INSERT INTO ${q(schema, "community_aggregate_exclusions")}
      (exclusion_id,participant_id,scope,reason_code,state,effective_at,created_at,created_by_digest)
      VALUES('synthetic-plan-change','synthetic-reprice-owner-1','community_weekly','manual_review','active',$1,$1,$2)`,
      [RELEASED, hash("synthetic-admin")]);
    const changed = await snapshot(schema);
    await expectCode(execute(schema, planned), "ANALYTICS_V2_REPRICE_PLAN_CHANGED");
    assert.deepEqual(await snapshot(schema), changed);
    await seedDay(schema, { day: NEXT_DAY, quotaOnly: true, owners: [3] });
    for (const [overrides, cap] of [[{ maxDays: 1 }, "heads"], [{ maxMembers: 1 }, "members"], [{ maxInputBytes: 1 }, "inputBytes"]]) {
      const capped = await plan(schema, overrides), before = await snapshot(schema);
      assert.equal(capped.caps[cap], true);
      await expectCode(execute(schema, capped, { bounds: bounds(overrides) }), "ANALYTICS_V2_REPRICE_LIMIT");
      assert.deepEqual(await snapshot(schema), before);
    }
  });
});

test("PG: a late receipt-write failure rolls back publication, contribution, archive and registration together", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { changedCost: true });
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P1005'; END $$`);
    await pool.query(`CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON ${q(schema, "analytics_v2_reprice_runs")}
      FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_receipt_failure()`);
    const planned = await plan(schema), before = await snapshot(schema);
    await assert.rejects(execute(schema, planned), (error) => error.code === "ANALYTICS_V2_REPRICE_WRITE_FAILED"
      && error.sourceFailure?.sqlstate === "P1005" && error.sourceFailure?.table === "analytics_v2_reprice_runs");
    assert.deepEqual(await snapshot(schema), before);
  });
});

test("PG: audit/archive rows are append-only and archived inputs allow only exact-owner offline deletion", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { changedCost: true });
    await seedDay(schema, { day: NEXT_DAY, quotaOnly: true, owners: [2] });
    await execute(schema, await plan(schema));
    const before = await snapshot(schema);
    for (const table of auditTables) {
      const column = table === "analytics_v2_contribution_price_inputs" ? "version" : table === "analytics_v2_reprice_runs" ? "manifest_version" : "revision";
      for (const sql of [`UPDATE ${q(schema, table)} SET ${column}=${column}`, `DELETE FROM ${q(schema, table)}`,
        `TRUNCATE ${q(schema, table)} CASCADE`]) {
        await assert.rejects(pool.query(sql), (error) => error.code === "P1005");
      }
    }
    await assert.rejects(transaction(async (client) => {
      await client.query("SELECT set_config('tibotattle.analytics_v2_offline_purge',$1,true)", [owner(2)]);
      await client.query(`DELETE FROM ${q(schema, "analytics_v2_contribution_price_inputs")} WHERE owner_digest=$1`, [owner(1)]);
    }), (error) => error.code === "P1005");
    await transaction(async (client) => {
      await client.query("SELECT set_config('tibotattle.analytics_v2_offline_purge',$1,true)", [owner(1)]);
      const result = await client.query(`DELETE FROM ${q(schema, "analytics_v2_contribution_price_inputs")} WHERE owner_digest=$1`, [owner(1)]);
      assert.equal(result.rowCount, 1);
    }, { rollback: true });
    await transaction(async (client) => {
      await client.query("SELECT set_config('tibotattle.analytics_v2_offline_purge',$1,true)", [owner(1)]);
      const contributions = await client.query(`DELETE FROM ${q(schema, "analytics_v2_daily_contributions")}
        WHERE owner_digest=$1`, [owner(1)]);
      assert.equal(contributions.rowCount, 2);
      const members = await client.query(`DELETE FROM ${q(schema, "analytics_v2_daily_owner_sets")}
        WHERE owner_digest=$1`, [owner(1)]);
      assert.equal(members.rowCount, 1);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM
        ${q(schema, "analytics_v2_contribution_price_inputs")} WHERE owner_digest=$1`, [owner(1)])).rows[0].n, 0,
      "exact-owner contribution deletion cascades to its immutable input archive");
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM
        ${q(schema, "analytics_v2_daily_contributions")} WHERE owner_digest=$1`, [owner(2)])).rows[0].n, 1);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM
        ${q(schema, "analytics_v2_published_daily")}`)).rows[0].n, 2);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, { rollback: true });
    assert.deepEqual(await snapshot(schema), before);
  });
});

test("PG: a completed newer reprice prevents an ordinary writer from registering an older kernel", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    await infrastructure(schema);
    await seedDay(schema, { quotaOnly: true });
    await execute(schema, await plan(schema));
    const before = await snapshot(schema);
    const previous = store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry().at(-2));
    await expectCode(transaction((client) => runStore.registerAnalyticsV2RunKernel(client, `"${schema}"`, previous, NOW)),
      "ANALYTICS_V2_KERNEL_REGRESSION");
    assert.deepEqual(await snapshot(schema), before);
  });
});

test("PG: an unattributed pre-0069 head retains its NULL kernel in the archive after a forward publication", { skip: SKIP }, async () => {
  await withSchema(async (schema) => {
    const values = kernels.createV11DailyProjectionValues(DAY);
    values.counts.quota = 1;
    const payload = kernels.buildCommunityDailyPayload({ day: DAY, revision: 4, releasedAt: RELEASED,
      ...kernels.publicInputs([values], [1]) });
    const runId = randomUUID(), digest = await store.analyticsV2DailyContentSha256(payload);
    await insert(pool, schema, "analytics_v2_published_daily", { day: DAY, revision: 4, released_at: RELEASED,
      payload: JSON.stringify(payload), payload_sha256: digest, run_id: runId });
    await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [] });
    assert.equal((await headRow(schema)).kernel_id, null);
    await transaction(async (client) => {
      await runStore.registerAnalyticsV2RunKernel(client, `"${schema}"`, target, NOW);
      const changed = { ...payload, totals: { ...payload.totals, quotaObservations: 2 } };
      await (await vite.ssrLoadModule("/src/analytics-v2/store-publication.ts")).writeAnalyticsV2PublishedDaily(
        client, `"${schema}"`, { revisionSeed: 0, dailyCandidates: [{ day: DAY, payload: changed,
          payloadSha256: await store.analyticsV2DailyContentSha256(changed), members: [], bootstrap: null }] },
        randomUUID(), NOW, target);
    });
    const archived = (await pool.query(`SELECT revision,kernel_id,manifest_version,payload_sha256::text,payload
      FROM ${q(schema, "analytics_v2_published_daily_log")} WHERE day=$1`, [DAY])).rows;
    assert.deepEqual(archived, [{ revision: 4, kernel_id: null, manifest_version: 1,
      payload_sha256: digest, payload }]);
    assert.equal((await headRow(schema)).kernel_id, target.kernel.kernelId);
    const newPayload = { ...payload, day: NEXT_DAY, aggregateId: `community-daily:${NEXT_DAY}:r4` };
    await assert.rejects(insert(pool, schema, "analytics_v2_published_daily", { day: NEXT_DAY, revision: 4,
      released_at: RELEASED, payload: JSON.stringify(newPayload), payload_sha256: await store.analyticsV2DailyContentSha256(newPayload),
      run_id: randomUUID(), kernel_id: null, manifest_version: 1 }),
    (error) => error.code === "23514" && error.constraint === "analytics_v2_published_daily_kernel_stamped");
  }, { beforeVersion: 69 });
});
