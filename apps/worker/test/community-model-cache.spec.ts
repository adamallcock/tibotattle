import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { calibrateCompositionCapacities, type CompositionObservation } from "@app-usagemonitor/quota-analysis";
import {
  CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL,
  COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  COMMUNITY_MODEL_CACHE_MAX_QUERIES,
  readCachedCommunityModelCompositions,
} from "../src/community-allowance";
import { V1_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v1";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11";
import { SERVER_PRICING_METHOD_VERSION } from "../src/server-pricing";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[] }
const db = () => (env as Bindings).USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const FROM = "2026-05-24";
const FINGERPRINT = "a".repeat(64);
const suffix = `${APP_PRICE_REGISTRY_MANIFEST.sha256}:v1-composition-3:${SERVER_PRICING_METHOD_VERSION}:${COMMUNITY_ATTRIBUTION_METHOD_VERSION}`;
const key = (source = "v1", revision = 1) => `${source}:${revision}:${FROM}:${suffix}`;
const budget = (remainingQueries = 18) => ({ remainingQueries, deadlineMs: 1, now: () => 0 });
async function statements(sql: string) {
  await db().batch(sql.split(";").map(value => value.trim()).filter(Boolean).map(value => db().prepare(value)));
}
async function fixture() {
  await statements(`
    CREATE TABLE participants(id TEXT PRIMARY KEY NOT NULL,state TEXT NOT NULL);
    CREATE TABLE community_snapshot_mutation_control(singleton_id INTEGER PRIMARY KEY,mutation_epoch INTEGER NOT NULL);
    INSERT INTO community_snapshot_mutation_control VALUES(1,1);
    CREATE TABLE community_analytical_input_versions(participant_id TEXT PRIMARY KEY,revision INTEGER);
    CREATE TABLE telemetry_contributions(id TEXT PRIMARY KEY,participant_id TEXT,status TEXT,transport_schema_version TEXT,created_at TEXT);
    CREATE INDEX telemetry_contributions_participant_created ON telemetry_contributions(participant_id,created_at);
    CREATE TABLE telemetry_v1_chunks(id TEXT PRIMARY KEY,participant_id TEXT,device_id TEXT,stream TEXT,chunk_day TEXT,chunk_seq INTEGER,superseded_at TEXT);
    CREATE UNIQUE INDEX telemetry_v1_chunks_current_identity ON telemetry_v1_chunks(participant_id,device_id,stream,chunk_day,chunk_seq) WHERE superseded_at IS NULL;
    CREATE TABLE telemetry_v11_domain_heads(participant_id TEXT PRIMARY KEY);
    CREATE TABLE telemetry_records(id INTEGER PRIMARY KEY,participant_id TEXT,record_kind TEXT,occurrence_id TEXT,provider TEXT,limit_id TEXT,observed_at TEXT);
    CREATE INDEX telemetry_records_participant_time ON telemetry_records(participant_id,observed_at);
    CREATE TABLE telemetry_contribution_occurrences(participant_id TEXT,record_kind TEXT,occurrence_id TEXT,contribution_id TEXT,
      PRIMARY KEY(participant_id,record_kind,occurrence_id,contribution_id));
    CREATE INDEX telemetry_contribution_occurrences_record ON telemetry_contribution_occurrences(participant_id,record_kind,occurrence_id);
    CREATE TABLE community_model_composition_cache(participant_id TEXT PRIMARY KEY,cache_key TEXT,composition_json TEXT,input_fingerprint TEXT,source_method_version TEXT);
  `);
}
async function participant(id: string, source: "v1" | "legacy" | "mixed" | "v1.1" | "none" = "v1", state = "active") {
  await db().batch([
    db().prepare("INSERT INTO participants VALUES(?,?)").bind(id,state),
    db().prepare("INSERT INTO community_analytical_input_versions VALUES(?,1)").bind(id),
  ]);
  if (["v1", "mixed", "v1.1"].includes(source)) await db().prepare("INSERT INTO telemetry_v1_chunks VALUES(?,?,'device','quota','2026-08-01',0,NULL)").bind(`chunk:${id}`,id).run();
  if (["legacy", "mixed", "v1.1"].includes(source)) await db().prepare("INSERT INTO telemetry_contributions VALUES(?,?,'accepted','telemetry-contribution-v0.2','2026-08-01')").bind(`legacy:${id}`,id).run();
  if (source === "v1.1") await db().prepare("INSERT INTO telemetry_v11_domain_heads VALUES(?)").bind(id).run();
}
async function overlap(id: string, time = "2026-08-01T00:00:00.000Z") {
  await db().batch([
    db().prepare("INSERT INTO telemetry_records(participant_id,record_kind,occurrence_id,provider,limit_id,observed_at) VALUES(?,'quota',?,'openai_codex','codex',?)").bind(id,`occurrence:${id}`,time),
    db().prepare("INSERT INTO telemetry_contribution_occurrences VALUES(?,'quota',?,?)").bind(id,`occurrence:${id}`,`legacy:${id}`),
  ]);
}
function ready(source = "v1"): Record<string, unknown> {
  return { status: "ready", planType: "pro", fit: calibrateCompositionCapacities([]),
    voidedBinCount: 0, poolCount: 1, quotaRowCount: 2, usageEventCount: 0,
    unpricedUsageEventCount: 0, poisonedBinCount: 0, latestQuotaObservedAt: "2026-08-01T00:00:00.000Z",
    attributionStatus: "legacy_conditional", attributionMethod: source === "v1.1"
      ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: FINGERPRINT };
}
async function cache(id: string, value: unknown = ready(), source = "v1") {
  await db().prepare("INSERT OR REPLACE INTO community_model_composition_cache VALUES(?,?,?,?,?)")
    .bind(id,key(source),JSON.stringify(value),FINGERPRINT,COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
}
function monitored(onPrepare?: (query: string, count: number) => void) {
  const queries: string[] = [];
  const database = new Proxy(db(), {
    get(target, property) {
      if (property === "prepare") return (query: string) => {
        queries.push(query);
        expect(query).toMatch(/^\s*(?:SELECT|WITH)\b/u);
        expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu);
        expect(query).not.toContain("telemetry_analytical_");
        expect(query).not.toContain("telemetry_v1_records");
        onPrepare?.(query,queries.length);
        return target.prepare(query);
      };
      if (property === "batch" || property === "exec") return () => { throw new Error("cache reader attempted batch/exec"); };
      const value: unknown = Reflect.get(target,property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database,queries };
}
beforeEach(async () => { await reset(); });

describe("bounded SELECT-only community composition cache", () => {
  it("preserves v1.1 precedence, mixed-domain overlap and legitimate refusal counts", async () => {
    await fixture();
    await participant("a-ready"); await cache("a-ready");
    await participant("b-refused"); await cache("b-refused",{status:"not_testable",reason:"multi_plan_window_unsupported"});
    await participant("c-legacy","legacy");
    await participant("d-overlap","mixed"); await overlap("d-overlap");
    await participant("e-disjoint","mixed"); await overlap("e-disjoint","2026-05-01T00:00:00.000Z"); await cache("e-disjoint");
    await participant("f-successor","v1.1"); await overlap("f-successor"); await cache("f-successor",ready("v1.1"),"v1.1");
    await participant("g-inactive","v1","deleting");
    await participant("h-empty","none");
    const {database,queries}=monitored(); const shared=budget();
    const result=await readCachedCommunityModelCompositions(database,NOW,{budget:shared,pageSize:3});
    expect(result).toMatchObject({v1ParticipantCount:4,unsupportedSourceParticipantCount:2,refusedParticipantCount:1,storeAvailable:true});
    expect(result?.compositions.map(row=>row.participantId)).toEqual(["a-ready","e-disjoint","f-successor"]);
    expect(queries).toHaveLength(5); expect(shared.remainingQueries).toBe(13);
  });

  it("requires final epoch proof even for an empty or wholly unsupported cohort", async () => {
    await fixture(); const observed=monitored();
    expect(await readCachedCommunityModelCompositions(observed.database,NOW,{budget:budget()}))
      .toEqual({compositions:[],v1ParticipantCount:0,unsupportedSourceParticipantCount:0,refusedParticipantCount:0,storeAvailable:true});
    expect(observed.queries).toHaveLength(3);
    const incomplete=budget(2);
    expect(await readCachedCommunityModelCompositions(db(),NOW,{budget:incomplete})).toBeNull();
    expect(incomplete.remainingQueries).toBe(0);
    await participant("legacy","legacy");
    expect((await readCachedCommunityModelCompositions(db(),NOW,{budget:budget()}))?.unsupportedSourceParticipantCount).toBe(1);
  });

  it("defers the whole cohort on missing, stale, malformed or source-mismatched cache data", async () => {
    await fixture(); await participant("a"); await cache("a"); await participant("b");
    expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
    await cache("b");
    for (const [column,value] of [
      ["cache_key",key("v1",0)], ["cache_key",key("v1.1")],
      ["source_method_version","outdated"], ["input_fingerprint","x".repeat(64)],
      ["composition_json","{"], ["composition_json",JSON.stringify({...ready(),inputFingerprint:"b".repeat(64)})],
      ["composition_json",JSON.stringify({...ready(),attributionMethod:V11_PLAN_ATTRIBUTION_ADAPTER_VERSION})],
    ]) {
      await cache("b"); await db().prepare(`UPDATE community_model_composition_cache SET ${column}=? WHERE participant_id='b'`).bind(value).run();
      expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
    }
    await cache("b"); await db().prepare("UPDATE community_analytical_input_versions SET revision=2 WHERE participant_id='b'").run();
    expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
    await db().prepare("UPDATE participants SET state='unknown' WHERE id='b'").run();
    expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
  });

  it("rejects malformed nested fit/count data and never turns unfinished/error payloads into refusals", async () => {
    await fixture(); await participant("a");
    const base=ready();
    for (const value of [
      {status:"deferred"}, {status:"not_testable",reason:"INTERNAL_ERROR"},
      {status:"not_testable",reason:"multi_plan_window_unsupported",detail:"unexpected"},
      {...base,quotaRowCount:60_001}, {...base,usageEventCount:1_000_001}, {...base,poolCount:-1},
      {...base,latestQuotaObservedAt:"invalid"}, {...base,fit:{}},
      {...base,fit:{...calibrateCompositionCapacities([]),modelCostShares:{model:1.1}}},
      {...base,fit:{...calibrateCompositionCapacities([]),totalCostUsd:-1}},
      {...base,fit:{...calibrateCompositionCapacities([]),status:"fitted",capacityUsdByModel:{model:100}}},
    ]) {
      await cache("a",value); expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
    }
    await cache("a");
    await db().prepare("UPDATE community_model_composition_cache SET composition_json=?")
      .bind(JSON.stringify(base).replace('"totalCostUsd":0','"totalCostUsd":1e400')).run();
    expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
  });

  it("accepts actual shared-kernel insufficient, fallback and fitted payload shapes", async () => {
    await fixture(); await participant("a");
    const observations=Array.from({length:100},(_,n): CompositionObservation=>{
      const a=1+(n%7),b=1+((n*3)%11);
      return {binStartMs:n*7_200_000,poolKey:"pool",segmentIndex:0,ppDelta:a+b/4,
        costByModel:{"model-a":a,"model-b":b}};
    });
    const fits=[calibrateCompositionCapacities([]),calibrateCompositionCapacities(observations.map(row=>({...row,costByModel:{"model-a":1}}))),
      calibrateCompositionCapacities(observations)];
    expect(fits.map(fit=>fit.status)).toEqual(["insufficient_observations","fallback_blended","fitted"]);
    for(const fit of fits){await cache("a",{...ready(),fit});expect((await readCachedCommunityModelCompositions(db(),NOW))?.compositions).toHaveLength(1);}
  });

  it("enforces bytes before returning rows and defers complete cohorts at total/page/query ceilings", async () => {
    await fixture(); await participant("a"); await cache("a");
    const oversized=JSON.stringify({...ready(),padding:"é".repeat(9_000)});
    expect(oversized.length).toBeLessThan(16*1024);
    await db().prepare("UPDATE community_model_composition_cache SET composition_json=?").bind(oversized).run();
    const row=(await db().prepare(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL).bind("",65,FROM+"T00:00:00.000Z",16*1024).all<{composition_json:string|null}>()).results[0];
    expect(row?.composition_json).toBeNull();expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
    await cache("a");await participant("b");await cache("b");await participant("c","none");
    expect(await readCachedCommunityModelCompositions(db(),NOW,{pageSize:1,maxPages:2})).toBeNull();
    expect(await readCachedCommunityModelCompositions(db(),NOW,{maxBytes:1})).toBeNull();
    expect(await readCachedCommunityModelCompositions(db(),NOW,{budget:budget(2)})).toBeNull();
    expect((await readCachedCommunityModelCompositions(db(),NOW,{pageSize:1,maxPages:3}))?.compositions).toHaveLength(2);
  });

  it("bounds physical noncontributor prefixes and observes the exact 18-statement maximum", async () => {
    await fixture();
    await db().prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1025)
      INSERT INTO participants SELECT printf('participant-%04d',x),'active' FROM n`).run();
    let observer=monitored(); const exhausted=budget();
    expect(await readCachedCommunityModelCompositions(observer.database,NOW,{budget:exhausted})).toBeNull();
    expect(observer.queries).toHaveLength(17);expect(exhausted.remainingQueries).toBe(1);
    await db().prepare("DELETE FROM participants WHERE id='participant-1025'").run();
    observer=monitored();const complete=budget();
    expect((await readCachedCommunityModelCompositions(observer.database,NOW,{budget:complete}))?.compositions).toEqual([]);
    expect(observer.queries).toHaveLength(COMMUNITY_MODEL_CACHE_MAX_QUERIES);expect(complete.remainingQueries).toBe(0);
  });

  it("does not read a large unrelated source history before restricting the physical page", async () => {
    await fixture();await participant("a","mixed");await overlap("a");await cache("a");
    await participant("b");await cache("b");
    const page=()=>db().prepare(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL)
      .bind("",2,FROM+"T00:00:00.000Z",16*1024).all<{participant_id:string}>();
    const baseline=await page();
    await participant("z-outside-page","mixed");
    await statements(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO telemetry_contributions
        SELECT 'outside-contribution-'||x,'z-outside-page','accepted','telemetry-contribution-v0.2','2026-08-01' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO telemetry_v1_chunks
        SELECT 'outside-chunk-'||x,'z-outside-page','device','quota','2026-08-01',x,NULL FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO telemetry_records(participant_id,record_kind,occurrence_id,provider,limit_id,observed_at)
        SELECT 'z-outside-page','quota','outside-occurrence-'||x,'openai_codex','codex','2026-08-01T00:00:00.000Z' FROM n;
    `);
    const populated=await page();
    expect(populated.results.map(row=>row.participant_id)).toEqual(["a","b"]);
    expect(baseline.meta.rows_read).toBeGreaterThan(0);
    expect(populated.meta.rows_read).toBe(baseline.meta.rows_read);
  });

  it("preserves caller reserves and refuses expired clocks and source/epoch changes", async () => {
    await fixture();await participant("a");await cache("a");
    const reserved={...budget(3),reserveQueries:1};expect(await readCachedCommunityModelCompositions(db(),NOW,{budget:reserved})).toBeNull();
    expect(reserved.remainingQueries).toBe(1);
    for(const now of [()=>1,()=>NaN]){const observer=monitored();expect(await readCachedCommunityModelCompositions(observer.database,NOW,{budget:{...budget(),now}})).toBeNull();expect(observer.queries).toHaveLength(0);}
    // Return a later epoch from the final read without exposing any source payload.
    const observed=monitored();let epochs=0;
    const changed=new Proxy(observed.database,{get(target,property){
      if(property==='prepare')return(query:string)=>{const prepared=target.prepare(query);if(query.startsWith("SELECT mutation_epoch")&&++epochs===2)
        return new Proxy(prepared,{get(statement,key){if(key==='first')return async()=>({mutation_epoch:2});const value:unknown=Reflect.get(statement,key);return typeof value==='function'?value.bind(statement):value;}});return prepared;};
      const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
    expect(await readCachedCommunityModelCompositions(changed,NOW,{budget:budget()})).toBeNull();
  });

  it("defers read errors without fallback, writes or partial results", async () => {
    await fixture();await participant("a");await cache("a");
    const observer=monitored((query)=>{if(query===CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL)throw new Error("synthetic database failure");});
    expect(await readCachedCommunityModelCompositions(observer.database,NOW,{budget:budget()})).toBeNull();
    expect(observer.queries).toHaveLength(2);
    await db().prepare("DROP TABLE community_model_composition_cache").run();
    expect(await readCachedCommunityModelCompositions(db(),NOW)).toBeNull();
  });

  it("uses indexed source/cache lookups only after a bounded physical page on the full migrated schema", async () => {
    await applyD1Migrations(db(),(env as Bindings).TEST_MIGRATIONS);
    const plan=(await db().prepare("EXPLAIN QUERY PLAN "+CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL)
      .bind("synthetic-cursor",65,FROM+"T00:00:00.000Z",16*1024).all<{detail:string}>()).results.map(row=>row.detail);
    expect(plan.some(line=>line.includes("MATERIALIZE participant_page"))).toBe(true);
    expect(plan.some(line=>/SEARCH participants .*\(id>\?\)/u.test(line))).toBe(true);
    for(const alias of ["c","h","r","o","versions","cache"]){expect(plan.some(line=>new RegExp(`SEARCH ${alias} USING (?:COVERING )?INDEX`).test(line)),plan.join("\n")).toBe(true);}
    expect(plan.filter(line=>/SCAN (?:participants|c|h|r|o|versions|cache)\b/u.test(line))).toEqual([]);
    expect(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL).not.toContain("telemetry_analytical_");
    expect(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL.indexOf("LIMIT ?2")).toBeLessThan(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL.indexOf("FROM telemetry_contributions"));
    const result=await readCachedCommunityModelCompositions(db(),NOW,{budget:budget()});
    expect(result?.compositions).toEqual([]);
  });
});
