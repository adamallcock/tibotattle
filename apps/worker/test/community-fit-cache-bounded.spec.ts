import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { CACHED_COMMUNITY_ALLOWANCE_PAYLOADS_SQL,COMMUNITY_ATTRIBUTION_METHOD_VERSION, readCachedCommunityAllowanceCorpus } from "../src/community-allowance";
import { SERVER_PRICING_METHOD_VERSION } from "../src/server-pricing";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";

const db = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-01T00:00:00.000Z"), FROM = "2026-05-24", FP="a".repeat(64);
const suffix = `${APP_PRICE_REGISTRY_MANIFEST.sha256}:v1-fit-7:${SERVER_PRICING_METHOD_VERSION}:${COMMUNITY_ATTRIBUTION_METHOD_VERSION}`;
const budget = (remainingQueries=30) => ({remainingQueries, deadlineMs:1, now:()=>0});
async function fixture() {
  await db().batch([
    "CREATE TABLE participants(id TEXT PRIMARY KEY,state TEXT)",
    "CREATE TABLE community_snapshot_mutation_control(singleton_id INTEGER PRIMARY KEY,mutation_epoch INTEGER)",
    "INSERT INTO community_snapshot_mutation_control VALUES(1,1)",
    "CREATE TABLE community_analytical_input_versions(participant_id TEXT PRIMARY KEY,revision INTEGER)",
    "CREATE TABLE community_current_analysis_queue(id INTEGER PRIMARY KEY,participant_id TEXT UNIQUE)",
    "CREATE TABLE telemetry_contributions(participant_id TEXT,status TEXT,transport_schema_version TEXT)",
    "CREATE INDEX legacy_participant ON telemetry_contributions(participant_id)",
    "CREATE TABLE telemetry_v1_chunks(participant_id TEXT,superseded_at TEXT)",
    "CREATE INDEX telemetry_v1_chunks_current_identity ON telemetry_v1_chunks(participant_id) WHERE superseded_at IS NULL",
    "CREATE TABLE telemetry_v11_domain_heads(participant_id TEXT PRIMARY KEY)",
    "CREATE TABLE community_allowance_fit_cache(participant_id TEXT PRIMARY KEY,cache_key TEXT,fits_json TEXT,input_fingerprint TEXT,source_method_version TEXT)",
  ].map(query=>db().prepare(query)));
}
function fit(participantId: string) { return {participantId,planType:"pro",capacityNanousd:123_000_000_000,lastObservedAt:"2026-08-20T00:00:00.000Z"}; }
async function participant(id: string, source="v1", state="active") {
  const statements = [db().prepare("INSERT INTO participants VALUES(?,?)").bind(id,state),
    db().prepare("INSERT INTO community_analytical_input_versions VALUES(?,1)").bind(id),
    db().prepare("INSERT INTO community_current_analysis_queue(participant_id) VALUES(?)").bind(id)];
  if (["v1","mixed","v1.1"].includes(source)) statements.push(db().prepare("INSERT INTO telemetry_v1_chunks VALUES(?,NULL)").bind(id));
  if (["v0.2","mixed","v1.1"].includes(source)) statements.push(db().prepare("INSERT INTO telemetry_contributions VALUES(?,'accepted','telemetry-contribution-v0.2')").bind(id));
  if (source==="v1.1") statements.push(db().prepare("INSERT INTO telemetry_v11_domain_heads VALUES(?)").bind(id));
  statements.push(db().prepare("INSERT INTO community_allowance_fit_cache VALUES(?,?,?,?,?)")
    .bind(id,`${source}:1:${FROM}:${suffix}`,JSON.stringify([fit(id)]),FP,COMMUNITY_ATTRIBUTION_METHOD_VERSION));
  await db().batch(statements);
}
beforeEach(async()=>{ await reset(); await fixture(); });

describe("bounded cache-only scalar fit corpus",()=>{
  it("matches the existing complete corpus across source formats and physical page seams",async()=>{
    await participant("a","v1"); await participant("b","v0.2"); await participant("c","mixed");
    await participant("d","v1.1"); await participant("e","none"); await participant("f","v1","deleting");
    const reference=await readCachedCommunityAllowanceCorpus(db(),NOW);
    const allocation=budget(), meter=createD1InvocationBudget(30);
    const result=await readCachedCommunityAllowanceCorpus(meter.wrap(db()),NOW,{budget:allocation,pageSize:2});
    expect(result).toEqual(reference); expect(result?.participantIds).toEqual(["a","b","c","d"]);
    expect(meter.queriesUsed).toBe(6); expect(allocation.remainingQueries).toBe(24);
  });
  it("returns no partial cohort when a later cache is missing, stale or corrupt",async()=>{
    await participant("a"); await participant("b");
    for (const [column,value] of [["cache_key","old"],["fits_json","[false]"],["input_fingerprint","not-a-fingerprint"],
      ["source_method_version","obsolete"]]) {
      const old=await db().prepare(`SELECT ${column} AS value FROM community_allowance_fit_cache WHERE participant_id='b'`).first<{value:string}>();
      await db().prepare(`UPDATE community_allowance_fit_cache SET ${column}=? WHERE participant_id='b'`).bind(value).run();
      expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(),pageSize:1})).toBeNull();
      await db().prepare(`UPDATE community_allowance_fit_cache SET ${column}=? WHERE participant_id='b'`).bind(old!.value).run();
    }
    await db().prepare("DELETE FROM community_allowance_fit_cache WHERE participant_id='b'").run();
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget()})).toBeNull();
  });
  it("fails closed on byte, page, query and deadline limits",async()=>{
    await participant("a"); await participant("b");
    const bytes=new TextEncoder().encode(JSON.stringify([fit("a")])).byteLength;
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(),maxBytes:bytes})).toBeNull();
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(),pageSize:1,maxPages:1})).toBeNull();
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(3)})).toBeNull();
    const expired=budget(); expired.deadlineMs=0;
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:expired})).toBeNull();
    expect(expired.remainingQueries).toBe(30);
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(5),maxBytes:2*bytes})).not.toBeNull();
  });
  it("requires a final epoch check even for an empty cohort",async()=>{
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(2)})).toBeNull();
    expect(await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget(3)})).toEqual({participantIds:[],fits:[]});
  });
  it("rejects a source mutation between metadata and payload reads",async()=>{
    await participant("a"); let mutated=false;
    const monitored=new Proxy(db(),{get(target,property){
      if(property==="prepare") return (sql:string)=>{
        const statement=target.prepare(sql);
        if(sql!==CACHED_COMMUNITY_ALLOWANCE_PAYLOADS_SQL) return statement;
        const wrap=(original:D1PreparedStatement):D1PreparedStatement=>new Proxy(original,{get(item,key){
          if(key==="bind") return (...values:unknown[])=>wrap(item.bind(...values));
          if(key==="all") return async()=>{
            if(!mutated){ mutated=true; await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=2").run(); }
            return item.all();
          };
          const value:unknown=Reflect.get(item,key); return typeof value==="function"?value.bind(item):value;
        }});
        return wrap(statement);
      };
      const value:unknown=Reflect.get(target,property); return typeof value==="function"?value.bind(target):value;
    }});
    expect(await readCachedCommunityAllowanceCorpus(monitored,NOW,{budget:budget()})).toBeNull();
    expect(mutated).toBe(true);
  });
});
