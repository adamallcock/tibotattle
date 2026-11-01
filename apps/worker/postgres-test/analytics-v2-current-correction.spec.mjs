/** Genuine PostgreSQL explicit current-source correction regression tests. Synthetic only. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import config from "../vitest.analytics-v2.config.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { grantAndVerifyRuntimePrivileges } from "../cloud-run/postgres-runtime-grants.mjs";
import { validateAnalyticsCurrentCorrectionResult } from "../cloud-run/analytics-reprice.mjs";
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
let vite, pool, store, derivedStore, runStore, domain, reprice, readReprice, prices, kernels, route, canonical, target, old, source;

before(async () => {
  vite = await createServer({ root: ROOT, configFile: false, plugins: config.plugins,
    resolve: config.resolve, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    logLevel: "silent", define: {
      __ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__: JSON.stringify(BUNDLED.computeClosureSha256),
      __ANALYTICS_V2_VENDOR_MANIFEST_SHA256__: JSON.stringify(BUNDLED.vendorManifestSha256),
    } });
  const load = (path) => vite.ssrLoadModule(path);
  store = await load("/src/analytics-v2/store.ts");
  derivedStore = await load("/src/analytics-v2/store-derived.ts");
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
  source = store.analyticsV2BaselineRunStamp(store.analyticsV2KernelRegistry().find(k => k.kernelId === 23));
  if (ENDPOINT) pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 4, connectionTimeoutMillis: 5000,
    application_name: "analytics-v2-current-correction-spec", options: "-c search_path=pg_catalog" });
});
after(async () => { await pool?.end(); await vite?.close(); });

function q(schema, table) {
  assert.match(schema, /^k_correction_[0-9a-f]+$/u);
  assert.match(table, /^[a-z_][a-z0-9_]*$/u);
  return `"${schema}"."${table}"`;
}
async function withSchema(work, { beforeReprice = false, beforeVersion = beforeReprice ? 77 : null } = {}) {
  const schema = `k_correction_${randomBytes(5).toString("hex")}`;
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
const options = (schema, overrides = {}) => ({ schema, stamp: target, bounds: bounds(overrides), sourceKernelId: source.kernel.kernelId });
async function plan(schema, overrides) { return reprice.planAnalyticsV2CurrentCorrection(pool, options(schema, overrides)); }
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
    return await reprice.executeAnalyticsV2CurrentCorrection(observedPool, { ...options(schema), runId: randomUUID(),
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
  wrongAssociation = false, excluded = [], quotaOwners = [], sameTarget = false } = {}) {
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
      if (quotaOnly || quotaOwners.includes(n)) values.counts.quota = n;
      else {
        const record = JSON.parse(usage(syntheticOwner(1), n, dayMs(day) + n * 1000).recordJson);
        values = kernels.foldV11DailyProjectionValues(values, [record]);
        const input = prices.analyticsV2PriceInput(record);
        const priced = prices.priceAnalyticsV2Input(input);
        assert.equal(priced.status, prices.ANALYTICS_V2_PRICE_STATUS.fullyPriced);
        events = [{ input, priced: changedCost ? { ...priced, costNanousd: 1 } : priced }];
        if (changedCost) { values.pricing.knownNanousd = "1"; values.cells[0].pricing.knownNanousd = "1"; }
      }
      if (!sameTarget) {
        values.registrySha256 = old.kernel.priceRegistrySha256;
        values.pricingMethodVersion = "server-api-price-equivalent-v0.5";
      }
      const digests = await store.analyticsV2ContributionDigests(values);
      await insert(client, schema, "analytics_v2_daily_owner_sets", { day, owner_digest: ownerDigest,
        first_revision: 4, provenance: 1, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
      await insert(client, schema, "analytics_v2_daily_contributions", { day, owner_digest: ownerDigest, version: 1,
        daily_values: JSON.stringify(values), values_schema: values.schemaVersion, values_sha256: digests.valuesSha256,
        stable_values_sha256: digests.stableValuesSha256, devices: n, price_kernel_id: old.kernel.kernelId,
        first_revision: 4, run_id: runId, kernel_id: old.kernel.kernelId, manifest_version: 1 });
      if (!quotaOnly && !quotaOwners.includes(n)) {
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

async function sourceInfrastructure(schema) {
  await infrastructure(schema);
  await transaction(async client => {
    await runStore.registerAnalyticsV2RunKernel(client,`"${schema}"`,source,NOW);
    await insert(client,schema,"analytics_v2_kernel_prices", { kernel_id: source.kernel.kernelId,
      compute_sha256: null,cards_sha256: hash("synthetic-current-cards"),cards: 1,
      projection_version: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION,registered_at: NOW });
  });
}
async function seedCurrentDay(schema, options = {}) {
  const { day = DAY, owners = [1], archiveOwners = [], badArchive = false } = options;
  await seedDay(schema,options);
  const sourceRunId = randomUUID();
  await transaction(async client => {
    await insert(client,schema,"analytics_v2_runs", { run_id: sourceRunId,started_at: NOW,finished_at: NOW,
      mode: "full",state: "complete",owners: owners.length,owner_days: owners.length,refusals: "[]",
      publication: JSON.stringify({ published: [],unchanged: [],blocked: [] }),timings: "{}",
      kernel_id: source.kernel.kernelId,manifest_version: 1,compatibility_sha256: hash("synthetic-current-compatibility"),
      exclusions_sha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256 });
    for (const n of owners) {
      const p = (await client.query(`SELECT * FROM ${q(schema,"analytics_v2_owner_day_price")} WHERE day=$1 AND owner_digest=$2`,[day,owner(n)])).rows[0];
      if (!p) continue; // Quota-only saved member deliberately has no inputs.
      const c = (await client.query(`SELECT * FROM ${q(schema,"analytics_v2_daily_contributions")} WHERE day=$1 AND owner_digest=$2`,[day,owner(n)])).rows[0];
      if (archiveOwners.includes(n)) await insert(client,schema,"analytics_v2_contribution_price_inputs", {
        day,owner_digest: owner(n),version: c.version,values_sha256: c.values_sha256,projection_version: p.projection_version,
        codec: p.codec,inputs: badArchive ? Buffer.from([255,1]) : p.inputs,inputs_sha256: p.inputs_sha256,
        source_inputs_sha256: p.inputs_sha256,input_events: p.input_events,run_id: c.run_id,kernel_id: c.price_kernel_id });
      const current = structuredClone(c.daily_values);
      current.registrySha256 = target.kernel.priceRegistrySha256;
      current.pricingMethodVersion = kernels.createV11DailyProjectionValues(day).pricingMethodVersion;
      await client.query(`DELETE FROM ${q(schema,"analytics_v2_owner_day")} WHERE day=$1 AND owner_digest=$2`,[day,owner(n)]);
      await insert(client,schema,"analytics_v2_owner_day", { day,owner_digest: owner(n),daily: current,refusal: null,
        run_id: sourceRunId,kernel_id: source.kernel.kernelId,manifest_version: 1 });
      await insert(client,schema,"analytics_v2_owner_day_price", { ...p,day,run_id: sourceRunId,kernel_id: source.kernel.kernelId,manifest_version: 1 });
    }
  });
  return sourceRunId;
}

test("PG correction: migration80 is required; planning is bounded read-only and stable", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema);
    await expectCode(plan(schema),"ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE");
  },{ beforeVersion: 80 });
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema);
    const before = await snapshot(schema), first = await plan(schema);
    assert.equal(first.schema,"analytics-v2-current-correction-plan-v1");
    assert.equal(first.inputSource,"current-owner-day"); assert.equal(first.sourceKernelId,23);
    assert.deepEqual(first,await plan(schema)); assert.deepEqual(await snapshot(schema),before);
    await expectCode(reprice.planAnalyticsV2CurrentCorrection(pool,{ ...options(schema),sourceKernelId: 0 }),"ANALYTICS_V2_REPRICE_INVALID");
    await expectCode(reprice.planAnalyticsV2CurrentCorrection(pool,{ ...options(schema),sourceKernelId: 32767 }),"ANALYTICS_V2_REPRICE_INVALID");
  });
});
test("PG correction: mixed archived/current/departed/quota/excluded saved members append atomically with honest provenance", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema);
    const sourceRunId = await seedCurrentDay(schema,{ owners: [1,2,3,4],archiveOwners: [2],quotaOwners: [3],excluded: [4] });
    const before = await snapshot(schema,["analytics_v2_runs","analytics_v2_owner_day","analytics_v2_owner_day_price","analytics_v2_journal_cursor","analytics_v2_preview"]);
    const original = await headRow(schema), planned = await plan(schema), runId = randomUUID();
    const receipt = await execute(schema,planned,{ runId });
    assert.deepEqual(receipt.counts,{ planned: 1,changed: 1,unchanged: 0,refused: 0,contributionVersions: 2,currentSourceVersions: 1,archiveSourceVersions: 1 });
    assert.equal(receipt.schema,"analytics-v2-current-correction-execution-v1");
    const current = await headRow(schema); assert.equal(current.revision,5);
    assert.equal(current.payload.apiEquivalentSpend.registrySha256,target.kernel.priceRegistrySha256);
    assert.equal(domain.analyticsV2RepriceNonSpend(current.payload),domain.analyticsV2RepriceNonSpend(original.payload));
    assert.deepEqual(await snapshot(schema,Object.keys(before)),before);
    const versions = (await pool.query(`SELECT owner_digest,version,devices,run_id::text,price_kernel_id FROM ${q(schema,"analytics_v2_daily_contributions")} ORDER BY owner_digest,version`)).rows;
    assert.equal(versions.length,6); assert.equal(versions.find(r=>r.owner_digest===owner(3)).version,1);
    assert.equal(versions.find(r=>r.owner_digest===owner(4)).version,1);
    const archives = (await pool.query(`SELECT owner_digest,version,values_sha256::text,projection_version,codec,inputs,inputs_sha256::text,
      input_events,run_id::text,kernel_id,source_inputs_sha256::text,correction_provenance FROM ${q(schema,"analytics_v2_contribution_price_inputs")} ORDER BY owner_digest,version`)).rows;
    assert.equal(archives.length,3);
    for (const row of archives.filter(r=>r.version===2)) {
      const p = row.correction_provenance;
      assert.equal(row.run_id,runId); assert.equal(row.kernel_id,target.kernel.kernelId);
      assert.equal(p.priorVersion,1); assert.equal(p.sourceInputsSha256,row.source_inputs_sha256);
      if (row.owner_digest===owner(1)) { assert.equal(p.inputSource,"current-owner-day"); assert.equal(p.sourceRunId,sourceRunId); assert.equal(p.sourceKernelId,23); }
      else { assert.equal(p.inputSource,"archive"); assert.equal(p.sourceKernelId,old.kernel.kernelId); }
      const decoded = await prices.decodeAnalyticsV2PriceInputs({ projectionVersion: row.projection_version,codec: row.codec,
        sha256: row.inputs_sha256,events: row.input_events,bytes: row.inputs });
      const values = (await pool.query(`SELECT daily_values FROM ${q(schema,"analytics_v2_daily_contributions")} WHERE day=$1 AND owner_digest=$2 AND version=2`,[DAY,row.owner_digest])).rows[0].daily_values;
      prices.assertAnalyticsV2PricesMatchDaily(DAY,decoded.events,values);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema,"analytics_v2_price_equivalences")}`)).rows[0].n,0);
    assert.deepEqual((await pool.query(`SELECT payload FROM ${q(schema,"analytics_v2_published_daily_log")} WHERE day=$1 AND revision=4`,[DAY])).rows[0].payload,original.payload);
    const after = await snapshot(schema);
    assert.deepEqual(await execute(schema,planned,{ runId }),{ ...receipt,replayed: true });
    assert.deepEqual(await snapshot(schema),after);
    const empty = await execute(schema,await plan(schema)); assert.equal(empty.counts.planned,0);
    await expectCode(reprice.executeAnalyticsV2Reprice(pool,{ ...options(schema),runId,expectedPlanSha256: planned.planSha256,nowMs: Date.parse(NOW) }),"ANALYTICS_V2_REPRICE_INVALID");
  });
});
test("PG correction: present corrupt archive refuses its whole day without current fallback; independent day commits", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema,{ owners: [1,2],archiveOwners: [2],badArchive: true });
    await seedCurrentDay(schema,{ day: NEXT_DAY,owners: [3] });
    const original = await headRow(schema), receipt = await execute(schema,await plan(schema));
    assert.equal(receipt.counts.refused,1); assert.equal(receipt.counts.changed,1); assert.equal(receipt.refusals.price_inputs_corrupt,1);
    assert.deepEqual(await headRow(schema),original);
    assert.equal((await pool.query(`SELECT max(version)::int AS n FROM ${q(schema,"analytics_v2_daily_contributions")} WHERE day=$1`,[DAY])).rows[0].n,1);
  });
});
for (const [kind,code] of [["nonspend","current_source_non_spend_drift"],["binding","current_source_binding_unproven"],
  ["failed-run","current_source_run_unproven"],["missing","current_source_unavailable"],["same-values","current_source_values_unchanged"]]) {
  test(`PG correction: ${kind} is a closed whole-day refusal`, { skip: SKIP }, async () => {
    await withSchema(async schema => {
      await sourceInfrastructure(schema); const run = await seedCurrentDay(schema,{ sameTarget: kind==="same-values" });
      if (kind==="nonspend") await pool.query(`UPDATE ${q(schema,"analytics_v2_owner_day")} SET daily=jsonb_set(daily,'{counts,session}','2'::jsonb)`);
      if (kind==="binding") await pool.query(`UPDATE ${q(schema,"analytics_v2_owner_day")} SET run_id=$1::uuid`,[randomUUID()]);
      if (kind==="failed-run") await pool.query(`UPDATE ${q(schema,"analytics_v2_runs")} SET state='failed' WHERE run_id=$1`,[run]);
      if (kind==="missing") await pool.query(`DELETE FROM ${q(schema,"analytics_v2_owner_day")}`);
      const original = await headRow(schema), receipt = await execute(schema,await plan(schema));
      assert.equal(receipt.refusals[code],1); assert.equal(receipt.counts.changed,0); assert.equal(receipt.counts.contributionVersions,0);
      assert.deepEqual(await headRow(schema),original);
    });
  });
}
test("PG correction: source quota mutation after planning refuses", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema);
    await pool.query(`UPDATE ${q(schema,"analytics_v2_owner_day")} SET daily=jsonb_set(daily,'{counts,quota}','1'::jsonb)`);
    const before = await snapshot(schema);
    await expectCode(execute(schema,planned),"ANALYTICS_V2_REPRICE_PLAN_CHANGED"); assert.deepEqual(await snapshot(schema),before);
  });
});
test("PG correction: a same-priced token mutation after planning changes the source digest", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema);
    await pool.query(`UPDATE ${q(schema,"analytics_v2_owner_day")} SET daily=jsonb_set(daily,'{tokens,outputReasoningTokens,unavailable}','1'::jsonb)`);
    assert.notEqual((await plan(schema)).planSha256,planned.planSha256);
    const before = await snapshot(schema);
    await expectCode(execute(schema,planned),"ANALYTICS_V2_REPRICE_PLAN_CHANGED"); assert.deepEqual(await snapshot(schema),before);
  });
});
test("PG correction: head/member/input caps and a full-refresh UUID cannot write", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); const run = await seedCurrentDay(schema,{ owners: [1,2] });
    await seedCurrentDay(schema,{ day: NEXT_DAY,owners: [3] });
    for (const bound of [{ maxDays: 1 },{ maxMembers: 1 },{ maxInputBytes: 1 }]) {
      const planned = await plan(schema,bound), before = await snapshot(schema);
      assert.ok(Object.values(planned.caps).some(Boolean));
      await expectCode(reprice.executeAnalyticsV2CurrentCorrection(pool,{ ...options(schema,bound),runId: randomUUID(),expectedPlanSha256: planned.planSha256,nowMs: Date.parse(NOW) }),"ANALYTICS_V2_REPRICE_LIMIT");
      assert.deepEqual(await snapshot(schema),before);
    }
    await expectCode(execute(schema,await plan(schema),{ runId: run }),"ANALYTICS_V2_REPRICE_INVALID");
  });
});
test("PG correction: late receipt failure rolls back publication, versions, archives and kernel registration", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema), before = await snapshot(schema);
    await pool.query(`CREATE FUNCTION "${schema}".deny_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE='P1005'; END $$`);
    await pool.query(`CREATE TRIGGER deny_correction BEFORE INSERT ON ${q(schema,"analytics_v2_reprice_runs")} FOR EACH ROW EXECUTE FUNCTION "${schema}".deny_correction()`);
    await expectCode(execute(schema,planned),"ANALYTICS_V2_REPRICE_WRITE_FAILED"); assert.deepEqual(await snapshot(schema),before);
  });
});
test("PG correction: archive conflict rolls back rather than replacing immutable evidence", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema), before = await snapshot(schema);
    await pool.query(`CREATE FUNCTION "${schema}".conflict_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO ${q(schema,"analytics_v2_contribution_price_inputs")}
      (day,owner_digest,version,values_sha256,projection_version,codec,inputs,inputs_sha256,source_inputs_sha256,input_events,run_id,kernel_id)
      SELECT NEW.day,NEW.owner_digest,NEW.version,NEW.values_sha256,p.projection_version,p.codec,p.inputs,p.inputs_sha256,p.inputs_sha256,p.input_events,NEW.run_id,NEW.price_kernel_id
      FROM ${q(schema,"analytics_v2_owner_day_price")} p WHERE p.day=NEW.day AND p.owner_digest=NEW.owner_digest;
      RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER conflict_archive AFTER INSERT ON ${q(schema,"analytics_v2_daily_contributions")} FOR EACH ROW EXECUTE FUNCTION "${schema}".conflict_archive()`);
    await expectCode(execute(schema,planned),"ANALYTICS_V2_REPRICE_WRITE_FAILED"); assert.deepEqual(await snapshot(schema),before);
  });
});
test("PG correction: closed provenance/receipt constraints and exact-owner archive erasure", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const receipt = await execute(schema,await plan(schema));
    assert.equal((await pool.query(`SELECT "${schema}".analytics_v2_current_correction_receipt_valid($1::jsonb) AS valid`,[receipt])).rows[0].valid,true);
    for (const invalid of [{ ...receipt,extra: true },{ ...receipt,sourceKernelId: null },{ ...receipt,counts: { ...receipt.counts,currentSourceVersions: 0 } },
      { ...receipt,refusals: { ...receipt.refusals,unbounded: 0 } }]) {
      assert.equal((await pool.query(`SELECT "${schema}".analytics_v2_current_correction_receipt_valid($1::jsonb) AS valid`,[invalid])).rows[0].valid,false);
    }
    const a = (await pool.query(`SELECT correction_provenance FROM ${q(schema,"analytics_v2_contribution_price_inputs")} WHERE version=2`)).rows[0].correction_provenance;
    for (const invalid of [{ ...a,extra: true },{ ...a,sourceRunId: "private-text" },{ ...a,sourceKernelId: null },{ ...a,priorVersion: -1 }]) {
      assert.equal((await pool.query(`SELECT "${schema}".analytics_v2_correction_provenance_valid($1::jsonb) AS valid`,[invalid])).rows[0].valid,false);
    }
    await assert.rejects(pool.query(`UPDATE ${q(schema,"analytics_v2_contribution_price_inputs")} SET correction_provenance=NULL`),e=>e.code==="P1005");
    await assert.rejects(pool.query(`DELETE FROM ${q(schema,"analytics_v2_contribution_price_inputs")}`),e=>e.code==="P1005");
    await transaction(async client => {
      await client.query("SELECT set_config('tibotattle.analytics_v2_offline_purge',$1,true)",[owner(1)]);
      await client.query(`DELETE FROM ${q(schema,"analytics_v2_daily_contributions")} WHERE owner_digest=$1`,[owner(1)]);
      await client.query(`DELETE FROM ${q(schema,"analytics_v2_daily_owner_sets")} WHERE owner_digest=$1`,[owner(1)]);
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema,"analytics_v2_contribution_price_inputs")}`)).rows[0].n,0);
  });
});
test("PG correction: a real concurrent source writer is locked before snapshot selection", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema);
    const writer = await pool.connect(); let announce, mutation;
    const entered = new Promise(resolve => { announce = resolve; });
    let correctionPid;
    const observingPool = { connect: async () => {
      const client = await pool.connect(); correctionPid = client.processID;
      return { query: (sql,...args) => {
        const result = client.query(sql,...args); if (typeof sql==="string" && sql.startsWith("LOCK TABLE")) announce();
        return result;
      },release: () => client.release() };
    } };
    try {
      await writer.query("BEGIN");
      await writer.query(`UPDATE ${q(schema,"analytics_v2_owner_day")} SET daily=jsonb_set(daily,'{counts,quota}','1'::jsonb)`);
      mutation = reprice.executeAnalyticsV2CurrentCorrection(observingPool,{ ...options(schema),runId: randomUUID(),expectedPlanSha256: planned.planSha256,nowMs: Date.parse(NOW) });
      const rejected = assert.rejects(mutation,e=>e.code==="ANALYTICS_V2_REPRICE_PLAN_CHANGED");
      await entered;
      let blocked = false;
      for (let i=0;i<40 && !blocked;i++) {
        blocked = (await writer.query("SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",[writer.processID,correctionPid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve=>setTimeout(resolve,2));
      }
      assert.equal(blocked,true,"the actual correction connection waits behind the source writer");
      await writer.query("COMMIT"); await rejected;
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q(schema,"analytics_v2_reprice_runs")}`)).rows[0].n,0);
      assert.equal((await headRow(schema)).revision,4);
    } finally { await writer.query("ROLLBACK"); writer.release(); if (mutation) await mutation.catch(()=>{}); }
  });
});
test("PG correction: the existing refresh advisory lock excludes a simultaneous correction", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema); const planned = await plan(schema), before = await snapshot(schema);
    const contract = await vite.ssrLoadModule("/src/analytics-v2/contract.ts"), ownerClient = await pool.connect();
    try {
      await ownerClient.query("BEGIN");
      await ownerClient.query("SELECT pg_advisory_xact_lock(hashtext($1))",[contract.ANALYTICS_V2_REFRESH_LOCK_KEY]);
      await expectCode(execute(schema,planned),"ANALYTICS_V2_REPRICE_WRITE_FAILED");
      assert.deepEqual(await snapshot(schema),before);
    } finally { await ownerClient.query("ROLLBACK"); ownerClient.release(); }
  });
});
test("PG correction: migration79 to80 preserves legacy receipt/archive bytes and rejects legacy UUID reuse", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedDay(schema,{ changedCost: true });
    const legacyPlan = await reprice.planAnalyticsV2Reprice(pool,options(schema)), runId = randomUUID();
    const legacy = await reprice.executeAnalyticsV2Reprice(pool,{ ...options(schema),runId,expectedPlanSha256: legacyPlan.planSha256,nowMs: Date.parse(NOW) });
    const originalLedger = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${q(schema,"analytics_v2_reprice_runs")} t`)).rows;
    const originalArchive = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${q(schema,"analytics_v2_contribution_price_inputs")} t`)).rows;
    await applyStockAndStagedMigrations({ role: "primary",schema,pool,stagedFiles: [] });
    assert.deepEqual((await pool.query(`SELECT to_jsonb(t)-ARRAY['input_source','source_kernel_id'] AS row FROM ${q(schema,"analytics_v2_reprice_runs")} t`)).rows,originalLedger);
    assert.deepEqual((await pool.query(`SELECT to_jsonb(t)-'correction_provenance' AS row FROM ${q(schema,"analytics_v2_contribution_price_inputs")} t`)).rows,originalArchive);
    const stored = (await pool.query(`SELECT input_source,source_kernel_id,receipt FROM ${q(schema,"analytics_v2_reprice_runs")}`)).rows[0];
    assert.equal(stored.input_source,"saved-snapshot"); assert.equal(stored.source_kernel_id,null);
    assert.equal(readReprice.validAnalyticsV2RepriceStoredReceipt(stored.receipt,legacyPlan.planSha256),true);
    assert.deepEqual(await reprice.executeAnalyticsV2Reprice(pool,{ ...options(schema),runId,expectedPlanSha256: legacyPlan.planSha256,nowMs: Date.parse(NOW) }),{ ...legacy,replayed: true });
    await expectCode(execute(schema,await plan(schema),{ runId }),"ANALYTICS_V2_REPRICE_PLAN_CHANGED");
  },{ beforeVersion: 80 });
});
test("PG correction: runtime role alone plans, executes and replays without schema ownership", { skip: SKIP }, async () => {
  const runtimeRole = `k_correction_runtime_${randomBytes(5).toString("hex")}`;
  await pool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  try {
    await withSchema(async schema => {
      await sourceInfrastructure(schema); await seedCurrentDay(schema);
      await grantAndVerifyRuntimePrivileges(pool,{ role: "primary",schema,runtimeRole,codePrefix: "" });
      const runtimePool = { connect: async () => {
        const client = await pool.connect(); await client.query(`SET ROLE "${runtimeRole}"`);
        assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,runtimeRole);
        return { query: (...args)=>client.query(...args),release: async () => {
          try { await client.query("RESET ROLE"); client.release(); } catch (error) { client.release(true); throw error; }
        } };
      } };
      const denied = await runtimePool.connect();
      try { await assert.rejects(denied.query(`CREATE TABLE ${q(schema,"synthetic_denied")} (id int)`),e=>e.code==="42501"); }
      finally { await denied.release(); }
      const planned = await reprice.planAnalyticsV2CurrentCorrection(runtimePool,options(schema)), runId = randomUUID();
      const args = { ...options(schema),runId,expectedPlanSha256: planned.planSha256,nowMs: Date.parse(NOW) };
      const receipt = await reprice.executeAnalyticsV2CurrentCorrection(runtimePool,args);
      assert.equal(receipt.counts.currentSourceVersions,1);
      assert.deepEqual(await reprice.executeAnalyticsV2CurrentCorrection(runtimePool,args),{ ...receipt,replayed: true });
    });
  } finally { await pool.query(`DROP OWNED BY "${runtimeRole}"`); await pool.query(`DROP ROLE "${runtimeRole}"`); }
});
test("PG correction: the latest saved version and its archive survive loss of mutable source rows", { skip: SKIP }, async () => {
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema);
    await execute(schema,await plan(schema));
    const latest = (await pool.query(`SELECT version,values_sha256::text FROM ${q(schema,"analytics_v2_daily_contributions")} ORDER BY version DESC LIMIT 1`)).rows[0];
    assert.equal(latest.version,2);
    const current = await headRow(schema), payload = structuredClone(current.payload);
    payload.apiEquivalentSpend.registrySha256 = old.kernel.priceRegistrySha256;
    payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.5";
    const publication = await vite.ssrLoadModule("/src/analytics-v2/store-publication.ts");
    const payloadSha256 = await store.analyticsV2DailyContentSha256(payload);
    await transaction(client=>publication.writeAnalyticsV2PublishedDaily(client,`"${schema}"`,{ revisionSeed: 0,
      dailyCandidates: [{ day: DAY,payload,payloadSha256,members: [],bootstrap: null }] },randomUUID(),NOW,target));
    await pool.query(`DELETE FROM ${q(schema,"analytics_v2_owner_day")}`);
    const receipt = await execute(schema,await plan(schema));
    assert.equal(receipt.counts.changed,1); assert.equal(receipt.counts.contributionVersions,0);
    assert.equal(receipt.counts.refused,0);
    assert.deepEqual((await pool.query(`SELECT version,values_sha256::text FROM ${q(schema,"analytics_v2_daily_contributions")} ORDER BY version DESC LIMIT 1`)).rows[0],latest);
  });
});

test("PG correction: the real bundled CLI plans, executes and replays the same UUID without duplicate versions", { skip: SKIP }, async t => {
  const bundle = join(ROOT,"cloud-run/dist/analytics-reprice.mjs");
  assert.equal((await stat(bundle)).isFile(),true,"the canonical Cloud Run build is required before PostgreSQL tests");
  const binary = process.env.EDGE_E2E_NODE || process.execPath;
  const runFile = promisify(execFile);
  // A fresh allowlist excludes inherited cloud configuration, credentials and
  // Node injection flags. The endpoint has already passed the owned socket guard.
  assert.match(ENDPOINT.host,/^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const env = { PATH: dirname(binary),ANALYTICS_V2_TEST_CLOCK: "1",PG_TEST_SOCKET: ENDPOINT.host,
    PG_TEST_PORT: String(ENDPOINT.port),PG_TEST_USER: ENDPOINT.user,PG_TEST_DATABASE: ENDPOINT.database,
    ...(ENDPOINT.password === undefined ? {} : { PG_TEST_PASSWORD: ENDPOINT.password }) };
  const runtime = await runFile(binary,["--version"],{ env,cwd: ROOT,timeout: 10_000,maxBuffer: 4096 });
  assert.equal(runtime.stderr,"");
  assert.equal(runtime.stdout.trim(),process.env.EDGE_E2E_NODE ? "v22.16.0" : process.version);
  t.diagnostic(`bundled CLI runtime ${runtime.stdout.trim()} (${process.env.EDGE_E2E_NODE ? "EDGE_E2E_NODE image runtime" : "process.execPath local fallback"})`);
  await withSchema(async schema => {
    await sourceInfrastructure(schema); await seedCurrentDay(schema);
    const original = await headRow(schema), reviewedPlan = await plan(schema), beforePlan = await snapshot(schema);
    const b = bounds(), inputSource = "current-owner-day", sourceKernelId = 23;
    const args = [`--schema=${schema}`,`--from-day=${b.fromDay}`,`--through-day=${b.throughDay}`,
      `--max-days=${b.maxDays}`,`--max-members=${b.maxMembers}`,`--max-input-bytes=${b.maxInputBytes}`,
      `--input-source=${inputSource}`,`--source-kernel=${sourceKernelId}`,`--now=${NOW}`];
    const cli = async (mode,extra = []) => {
      const output = await runFile(binary,[bundle,`--mode=${mode}`,...args,...extra],
        { env,cwd: ROOT,timeout: 30_000,maxBuffer: 64 * 1024 });
      assert.equal(output.stderr,"");
      const lines = output.stdout.trim().split("\n"); assert.equal(lines.length,1);
      const receipt = JSON.parse(lines[0]);
      assert.deepEqual(receipt,{ schemaVersion: "analytics-reprice-receipt-v2",inputSource,sourceKernelId,
        status: "ok",mode,target: null,now: NOW,clock: "test",
        kernel: { kernelId: target.kernel.kernelId,manifestVersion: target.manifestVersion },result: receipt.result });
      assert.deepEqual(validateAnalyticsCurrentCorrectionResult(receipt.result,{ mode,bounds: b,stamp: target,
        pricingMethodVersion: store.analyticsV2BundledPricer().pricingMethodVersion,
        expectedPlanSha256: reviewedPlan.planSha256,inputSource,sourceKernelId }),receipt.result);
      return receipt;
    };
    const planned = await cli("plan");
    assert.deepEqual(planned.result,reviewedPlan);
    assert.deepEqual(await snapshot(schema),beforePlan,"the bundled plan is read-only");
    const runId = randomUUID(), executeArgs = [`--run-id=${runId}`,`--expected-plan-sha256=${planned.result.planSha256}`];
    const executed = await cli("execute",executeArgs);
    assert.equal(executed.result.replayed,false);
    assert.deepEqual(executed.result.counts,{ planned: 1,changed: 1,unchanged: 0,refused: 0,
      contributionVersions: 1,currentSourceVersions: 1,archiveSourceVersions: 0 });
    const current = await headRow(schema);
    assert.equal(current.revision,original.revision+1); assert.equal(current.run_id,runId);
    assert.equal(current.kernel_id,target.kernel.kernelId);
    assert.equal(current.payload.apiEquivalentSpend.registrySha256,target.kernel.priceRegistrySha256);
    assert.equal(domain.analyticsV2RepriceNonSpend(current.payload),domain.analyticsV2RepriceNonSpend(original.payload));
    assert.deepEqual((await pool.query(`SELECT version FROM ${q(schema,"analytics_v2_daily_contributions")} ORDER BY version`)).rows,
      [{ version: 1 },{ version: 2 }]);
    const after = await snapshot(schema), replayed = await cli("execute",executeArgs);
    assert.deepEqual(replayed,{ ...executed,result: { ...executed.result,replayed: true } });
    assert.deepEqual(await snapshot(schema),after,"same-UUID replay appends no version, archive, ledger or public head");
  });
});
