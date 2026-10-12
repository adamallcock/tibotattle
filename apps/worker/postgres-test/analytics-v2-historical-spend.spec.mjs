// Content-free historical publication fixtures through the maintained PG17 route.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import { VENDORED_PACKAGE_ENTRIES, usesVendoredPackages } from "../vitest.analytics-v2.config.mjs";
import { normalizeCommunityDailySeries } from "../../web/public/community-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "local PostgreSQL 17 required" : false;
const NOW = Date.parse("2026-10-09T01:00:00.000Z");
const NO_EXCLUSIONS = "881387e9ebd61f0993e6e10b6c5cdb6f8fd807432640bbfeca0c0fe15e460118";
const OLD_REGISTRY = "48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9";
let vite, pool, schema, routeModule, kernels, compatibility, exclusions;
const fixtures = [];
const q = table => `"${schema}"."${table}"`;
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value !== null && typeof value === "object"
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = payload => {
  const { aggregateId, revision, releasedAt, ...content } = payload;
  return sha(JSON.stringify(canonical(content)));
};
async function registerKernel(k) {
  await pool.query(`INSERT INTO ${q("analytics_v2_kernels")}
    (kernel_id,production_commit,vendor_manifest_sha256,compute_closure_sha256,price_registry_sha256,price_registry_version,method_version,registered_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-09-01T00:00:00Z')`,[k.kernelId,k.productionCommit,k.vendorManifestSha256,
      k.computeClosureSha256,k.priceRegistrySha256,k.priceRegistryVersion,k.methodVersion]);
}
async function enablePublication() {
  await pool.query(`UPDATE ${q("collection_controls")} SET revision=revision+1,control_state='operational',
    enrollment_enabled=true,upload_registration_enabled=true,processing_enabled=true,
    publication_enabled=true,reason_code='maintenance',updated_at=clock_timestamp() WHERE singleton=1`);
}
function oldSpend(overrides = {}) {
  return { basis: "reported_usage_event_time_api_price_equivalent_v1", currency: "USD", knownCostUsd: 1.2345,
    coverage: "complete", usageEvents: 1, fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 0,
    unpricedUsageEvents: 0, pricingMethodVersion: "server-api-price-equivalent-v0.5", registrySha256: OLD_REGISTRY,
    ...overrides };
}
async function seed(overrides = {}) {
  const day = new Date(Date.parse("2026-09-01T00:00:00Z") + fixtures.length * 86_400_000).toISOString().slice(0, 10);
  const releasedAt = `${day}T20:00:00.000Z`;
  const runId = overrides.runId ?? randomUUID();
  if (!overrides.missingRun) await pool.query(`INSERT INTO ${q("analytics_v2_runs")}
    (run_id,started_at,finished_at,mode,state,owners,owner_days,refusals,publication,timings,kernel_id,manifest_version,exclusions_sha256)
    VALUES ($1,$2,$2,'full',$3,0,0,'[]','{"published":[],"unchanged":[],"blocked":[]}','{}',$4,$5,$6)`,
    [runId,releasedAt,overrides.runState ?? "complete",overrides.runKernel ?? 10,overrides.runManifest ?? 1,
      overrides.exclusionsSha ?? NO_EXCLUSIONS]);
  const payload = { schemaVersion: "community-daily-aggregate-v1.0", policyVersion: "community-daily-v1.0",
    aggregateId: `community-daily:${day}:r7`, day, revision: 7, releasedAt, immutableRevision: true,
    recomputesOnLateData: true, suppression: "none_daily_grain_by_owner_decision", cells: [], cellsTruncated: false,
    totals: { contributingParticipants: 1, contributingDevices: 1, usageEvents: 1, quotaObservations: 0,
      sessionDimensions: 0, inputUncachedTokens: 100, inputCacheReadTokens: 20, inputCacheWriteTokens: 0,
      outputTextTokens: 5, outputReasoningTokens: 5, outputCombinedTokens: 0 },
    apiEquivalentSpend: overrides.spend ?? oldSpend(), ...overrides.payload };
  await pool.query(`INSERT INTO ${q("analytics_v2_published_daily")}
    (day,revision,released_at,payload,payload_sha256,run_id,kernel_id,manifest_version)
    VALUES ($1,7,$2,$3::jsonb,$4,$5,$6,$7)`,
    [day,releasedAt,JSON.stringify(payload),overrides.corruptDigest ? "0".repeat(64) : digest(payload),runId,
      overrides.kernel ?? 10,overrides.manifest ?? 1]);
  const fixture = { day, payload, runId };
  fixtures.push(fixture);
  return fixture;
}
async function get(fixture, options = {}) {
  const route = routeModule.createAnalyticsV2CommunityDailyRoute({ pool, schema, clock: () => NOW,
    originMode: "fastpath-test", ...options });
  const response = await route.handler(new Request(`http://127.0.0.1/api/v1/community/daily?from=${fixture.day}&to=${fixture.day}`));
  return { response, body: await response.json() };
}
before(async () => {
  if (skip) return;
  vite = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom",
    logLevel: "silent", plugins: [{ name: "historical-test-vendor", enforce: "pre", resolveId(source, importer) {
      return usesVendoredPackages(importer) ? VENDORED_PACKAGE_ENTRIES[source] ?? null : null;
    } }], resolve: { mainFields: ["module", "main"] }, ssr: { noExternal: ["jsonc-parser"] } });
  routeModule = await vite.ssrLoadModule("/src/analytics-v2/community-daily-route.ts");
  kernels = await vite.ssrLoadModule("/vendor/analytics-d43c8f92/entry.ts");
  // Baseline route regression can run without a product compatibility module.
  try { compatibility = await vite.ssrLoadModule("/src/analytics-v2/published-spend-compatibility.ts"); } catch {}
  exclusions = await vite.ssrLoadModule("/src/analytics-v2/exclusions.ts");
  pool = new pg.Pool({ ...endpoint, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  assert.match((await pool.query("SELECT version() AS version")).rows[0].version, /^PostgreSQL 17\./u);
  schema = `hist_spend_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  const registry = JSON.parse(await readFile(resolve(ROOT,"src/analytics-v2/kernel-registry.json"),"utf8"));
  for (const k of registry.kernels.filter(k => [9,10,11].includes(k.kernelId))) await registerKernel(k);
  await enablePublication();
});
after(async () => {
  if (pool) { if (schema) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
  if (vite) await vite.close();
});

test("historical kernel 10 publication preserves its original spend and stamps", { skip }, async () => {
  const fixture = await seed();
  assert.equal(kernels.isCurrentCommunityDailySpend(fixture.payload.apiEquivalentSpend),false);
  const { response, body } = await get(fixture);
  assert.equal(response.status,200);
  assert.deepEqual(body.days[0].payload.apiEquivalentSpend,fixture.payload.apiEquivalentSpend);
  assert.equal(body.days[0].releasedAt,fixture.payload.releasedAt);
  assert.equal(body.days[0].revision,7);
  assert.equal(body.days[0].payload.aggregateId,fixture.payload.aggregateId);
  assert.equal("kernel_id" in body.days[0],false);
  for (const retained of [false,true]) {
    const normalized=normalizeCommunityDailySeries(body,{nowMs:NOW,retained});
    assert.equal(normalized.state,"published");
    assert.deepEqual(normalized.days[0].apiEquivalentSpend,fixture.payload.apiEquivalentSpend);
    assert.equal(normalized.days[0].releasedAt,fixture.payload.releasedAt);
  }
  const stored = (await pool.query(`SELECT payload::text,kernel_id,revision FROM ${q("analytics_v2_published_daily")} WHERE day=$1`,[fixture.day])).rows[0];
  assert.deepEqual(JSON.parse(stored.payload),fixture.payload);
  assert.equal(stored.kernel_id,10);
  assert.equal(stored.revision,7);
});

test("historical read withholds unknown attribution and malformed spend without weakening current pricing", { skip }, async () => {
  const bad = [
    {kernel:9},{kernel:11},{manifest:2},{runKernel:11},{runManifest:2},{runState:"failed"},{missingRun:true},
    {exclusionsSha:"1".repeat(64)}, {spend:oldSpend({registrySha256:"0".repeat(64)})},
    {spend:oldSpend({pricingMethodVersion:"server-api-price-equivalent-v0.6"})},
    {spend:oldSpend({fullyPricedUsageEvents:0})},{spend:oldSpend({usageEvents:2})},
    {spend:oldSpend({knownCostUsd:-1})},{spend:oldSpend({coverage:"partial"})},
    {spend:oldSpend({unexpected:0})},{payload:{schemaVersion:"community-daily-aggregate-v9.0"}},
    {payload:{policyVersion:"community-daily-v9.0"}},
  ];
  for (const spec of bad) {
    const { response, body } = await get(await seed(spec));
    assert.equal(response.status,200);
    assert.equal("apiEquivalentSpend" in body.days[0].payload,false,JSON.stringify(spec));
  }
  const current = kernels.finalizeCommunityDailySpend({usageEvents:1,knownNanousd:1234500000n,
    fullyPricedUsageEvents:1,partiallyPricedUsageEvents:0,unpricedUsageEvents:0});
  const fixture = await seed({kernel:11,runKernel:11,exclusionsSha:"1".repeat(64),spend:current});
  assert.deepEqual((await get(fixture)).body.days[0].payload.apiEquivalentSpend,current);
  const corrupt = await get(await seed({corruptDigest:true}));
  assert.equal(corrupt.response.status,503);
  assert.equal(corrupt.body.error.code,"BACKEND_STORAGE_UNAVAILABLE");
});

test("historical grammar retains zero, partial, unavailable and exact resource refusal semantics", { skip }, () => {
  assert.ok(compatibility);
  for (const spend of [oldSpend({usageEvents:0,fullyPricedUsageEvents:0,knownCostUsd:0}),
    oldSpend({fullyPricedUsageEvents:0,partiallyPricedUsageEvents:1,coverage:"partial"}),
    oldSpend({fullyPricedUsageEvents:0,unpricedUsageEvents:1,coverage:"unavailable",knownCostUsd:null}),
    oldSpend({usageEvents:200001,fullyPricedUsageEvents:0,unpricedUsageEvents:0,coverage:"unavailable",knownCostUsd:null,
      unprocessedUsageEvents:200001,unavailableReason:"processing_capacity_exceeded",processingPolicyVersion:"daily-spend-capacity-2048-chunks-200000-events"})]) {
    assert.equal(compatibility.isKernel10PublishedSpend(spend,spend.usageEvents),true);
  }
  for (const override of [{unprocessedUsageEvents:0},{knownCostUsd:null},{knownCostUsd:Infinity},{usageEvents:1.5},
    {unprocessedUsageEvents:1,fullyPricedUsageEvents:0,coverage:"unavailable",knownCostUsd:null,unavailableReason:"processing_capacity_exceeded",processingPolicyVersion:"daily-spend-capacity-2048-chunks-200000-events"}]) {
    const spend=oldSpend(override);
    assert.equal(compatibility.isKernel10PublishedSpend(spend,spend.usageEvents),false);
  }
});

test("historical proof uses the head's run and one repeatable-read exclusion snapshot", { skip }, async () => {
  const fixture = await seed();
  let inserted=false;
  const exclusion={exclusionId:"synthetic-exclusion",participantId:"synthetic-participant",scope:"community_weekly",state:"active",
    effectiveAtUs:Date.parse("2026-09-01T00:00:00Z")*1000,expiresAtUs:null};
  const wrappedPool={async connect(){const client=await pool.connect();return {release:()=>client.release(),async query(sql,values){
    const result=await client.query(sql,values);
    if (!inserted && sql.includes("ORDER BY exclusion_id COLLATE")) {
      inserted=true;
      await pool.query(`INSERT INTO ${q("community_aggregate_exclusions")}
        (exclusion_id,participant_id,scope,reason_code,state,effective_at,created_at,created_by_digest)
        VALUES ('synthetic-exclusion','synthetic-participant','community_weekly','manual_review','active','2026-09-01','2026-09-01',$1)`,["a".repeat(64)]);
      // A newer completed run has the new digest, but did not publish this head.
      await seed({exclusionsSha:await exclusions.analyticsV2ExclusionsSha256([exclusion])});
    }
    return result;
  }};}};
  const during=await get(fixture,{pool:wrappedPool});
  assert.equal(inserted,true);
  assert.deepEqual(during.body.days[0].payload.apiEquivalentSpend,fixture.payload.apiEquivalentSpend);
  assert.equal("apiEquivalentSpend" in (await get(fixture)).body.days[0].payload,false);
  const current=kernels.finalizeCommunityDailySpend({usageEvents:1,knownNanousd:1n,fullyPricedUsageEvents:1,partiallyPricedUsageEvents:0,unpricedUsageEvents:0});
  assert.deepEqual((await get(await seed({kernel:11,runKernel:11,spend:current}))).body.days[0].payload.apiEquivalentSpend,current);
  // An unreadable optional exclusion proof still cannot turn old evidence current.
  const unavailablePool={async connect(){const client=await pool.connect();return {release:()=>client.release(),query(sql,values){
    if(sql.includes("ORDER BY exclusion_id COLLATE")) return Promise.reject(new Error("synthetic read failure"));
    return client.query(sql,values);
  }};}};
  assert.equal("apiEquivalentSpend" in (await get(fixture,{pool:unavailablePool})).body.days[0].payload,false);
});

test("a kernel number with a different registered closure is not historical authority", { skip }, async () => {
  const originalSchema=schema;
  const isolatedSchema=`hist_spend_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${isolatedSchema}"`);
  try {
    schema=isolatedSchema;
    await applyPostgresMigrations({role:"primary",schema,pool});
    const registry=JSON.parse(await readFile(resolve(ROOT,"src/analytics-v2/kernel-registry.json"),"utf8"));
    await registerKernel({...registry.kernels[9],computeClosureSha256:"0".repeat(64)});
    await enablePublication();
    const result=await get(await seed());
    assert.equal(result.response.status,200);
    assert.equal("apiEquivalentSpend" in result.body.days[0].payload,false);
  } finally {
    schema=originalSchema;
    await pool.query(`DROP SCHEMA "${isolatedSchema}" CASCADE`);
  }
});
