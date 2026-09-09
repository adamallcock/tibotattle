import { env } from "cloudflare:workers";
import { applyD1Migrations,reset,type D1Migration } from "cloudflare:test";
import { beforeEach,describe,expect,it } from "vitest";
import { advanceCommunityPublication,readCapturedCommunityPublication,markCommunityPublicationPublished } from "../src/community-publication";
import { readCachedCommunityAllowanceCorpus,readCachedCommunityModelCompositions,COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  V1_FIT_CACHE_KEY_SUFFIX,COMPOSITION_CACHE_KEY_SUFFIX,summarizeCommunityAllowanceDay } from "../src/community-allowance";
import { warmCommunityAnalysisCaches } from "../src/community-analysis-warmer";
import { buildAdminCommunityAllowancePreview,readCachedAdminCommunityAllowancePreview,
  warmAdminCommunityAllowancePreviewCache } from "../src/admin-community-allowance";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { seedModelHistoryFixture,insertModelHistoryRecords } from "./helpers/model-history";
import { rebuildPendingCommunityDailyAggregates } from "../src/community-daily-aggregates";

const db=()=>env.USAGE_MONITOR_DB,NOW=Date.parse("2026-09-08T12:00:00.000Z"),LEASE="synthetic-captured-publication";
const budget=(queries=900)=>({remainingQueries:queries,deadlineMs:Date.now()+30_000});
beforeEach(async()=>{
  await reset();await applyD1Migrations(db(),(env as Env & {TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS);
  await db().prepare("UPDATE retention_state SET maintenance_lease_token=?,maintenance_lease_expires_at='2030-01-01T00:00:00.000Z'")
    .bind(LEASE).run();
});
async function warm() {
  for(let pass=0;pass<20;pass++) {
    const meter=createD1InvocationBudget(900);
    const result=await warmCommunityAnalysisCaches(meter.wrap(db()),NOW,{meter,deadlineMs:Date.now()+30_000,maintenanceLease:LEASE});
    if(result.status==="complete")return;
  }
  throw new Error("synthetic current caches did not finish");
}
function observed(hook?:(sql:string,moment:"before"|"after")=>Promise<void>) {
  const errors:string[]=[],queries:string[]=[],originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>(),texts=new WeakMap<D1PreparedStatement,string>();
  const reads=new Map<string,{calls:number;rows:number}>();
  const record=(sql:string,result:unknown)=>{
    if(!result||typeof result!=="object"||!("meta" in result))return;
    const rows=(result as D1Result).meta.rows_read;if(!Number.isFinite(rows))return;
    const name=sql.trim().slice(0,150),old=reads.get(name)??{calls:0,rows:0};old.calls++;old.rows+=rows;reads.set(name,old);
  };
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,key){
      if(key==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
      if(["all","first","run","raw"].includes(String(key)))return async(...args:unknown[])=>{
        queries.push(sql);
        try{await hook?.(sql,"before");const result:unknown=await Reflect.apply(Reflect.get(target,key),target,args);
          record(sql,result);
          await hook?.(sql,"after");return result;}
        catch(error){errors.push(String(error));throw error;}
      };
      const value:unknown=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});originals.set(proxy,statement);texts.set(proxy,sql);return proxy;
  };
  return {errors,queries,reads,database:new Proxy(db(),{get(target,key){
    if(key==="prepare")return(sql:string)=>wrap(target.prepare(sql),sql);
    if(key==="batch")return async(statements:D1PreparedStatement[])=>{
      const sql=statements.map(statement=>texts.get(statement)??"");queries.push(...sql);
      try{for(const text of sql)await hook?.(text,"before");
        const result=await target.batch(statements.map(statement=>originals.get(statement)??statement));
        result.forEach((item,index)=>record(sql[index]!,item));
        for(const text of sql)await hook?.(text,"after");return result;}
      catch(error){errors.push(String(error));throw error;}
    };
    const value:unknown=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }})};
}
describe("restartable captured cohort publication",()=>{
  it("preserves exact scalar/model evidence through bounded capture and the actual preview path",async()=>{
    await seedModelHistoryFixture();await warm();
    const scalar=await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:budget()});
    const models=await readCachedCommunityModelCompositions(db(),NOW,{budget:budget()});
    const observedDb=observed();
    const status=await advanceCommunityPublication(observedDb.database,NOW,{budget:budget()});
    expect(status,JSON.stringify({errors:observedDb.errors,head:await db().prepare("SELECT * FROM community_publication_generation").first()})).toMatchObject({status:"ready",memberCount:1,preparedCount:1});
    const capture=await readCapturedCommunityPublication(db(),NOW,{budget:budget()});
    expect(capture?.corpus).toEqual(scalar);expect(capture?.compositions).toEqual(models);
    expect(await warmAdminCommunityAllowancePreviewCache(db(),NOW,{mode:"cache-only",budget:budget()}))
      .toEqual({code:"ALLOWANCE_PREVIEW_CACHE_REFRESHED"});
    const preview=await readCachedAdminCommunityAllowancePreview(db(),NOW);
    const expected=buildAdminCommunityAllowancePreview(scalar!.fits,NOW,scalar!.participantIds);
    expect(preview.days).toEqual(expected.days);expect(preview.coverage).toEqual(expected.coverage);
    expect(await warmAdminCommunityAllowancePreviewCache(db(),NOW,{mode:"cache-only",budget:budget()}))
      .toEqual({code:"ALLOWANCE_PREVIEW_CACHE_CURRENT"});
  });
  it("waits for every captured member and freezes complete versions despite later uploads",async()=>{
    const fixture=await seedModelHistoryFixture();await warm();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:2})).status).toBe("deferred");
    const membership=await db().prepare("SELECT * FROM community_publication_members").first();
    expect(membership).toMatchObject({selected_revision:null});
    await db().prepare("DELETE FROM community_model_composition_cache").run();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("deferred");
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toBeNull();
    await warm();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    const before=await readCapturedCommunityPublication(db(),NOW,{budget:budget()});
    await insertModelHistoryRecords(fixture,"post-capture",[{stream:"quota",observedAt:"2026-09-08T00:00:00.000Z",usedPercent:1}]);
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toEqual(before);
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).generation).toBe(before!.generation);
    await db().batch([markCommunityPublicationPublished(db(),before!)]);
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:1})).status).toBe("deferred");
  });
  it("immediately refuses a hard withdrawal during capture and after a ready snapshot",async()=>{
    await seedModelHistoryFixture();await warm();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    const capture=await readCapturedCommunityPublication(db(),NOW,{budget:budget()});expect(capture).not.toBeNull();
    await db().prepare("UPDATE participants SET state='deleting'").run();
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toBeNull();
    const result=await markCommunityPublicationPublished(db(),capture!).all();expect(result.results).toHaveLength(0);
  });
  it("rolls back a crash between member copy and progress promotion, then resumes exactly",async()=>{
    await seedModelHistoryFixture();await warm();
    await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:2});
    await db().prepare(`CREATE TRIGGER synthetic_publication_crash BEFORE UPDATE ON community_publication_generation
      WHEN NEW.prepared_count>OLD.prepared_count BEGIN SELECT RAISE(ABORT,'synthetic publication interruption');END`).run();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("unavailable");
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_publication_members WHERE selected_revision IS NOT NULL").first())
      .toEqual({n:0});
    expect(await db().prepare("SELECT prepared_count,payload_bytes FROM community_publication_generation").first())
      .toEqual({prepared_count:0,payload_bytes:0});
    await db().prepare("DROP TRIGGER synthetic_publication_crash").run();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    expect((await readCapturedCommunityPublication(db(),NOW,{budget:budget()}))?.corpus.participantIds).toHaveLength(1);
  });
  it("does not copy a cache changed after validation and never returns a partial cohort",async()=>{
    await seedModelHistoryFixture();await warm();let changed=false;
    const observer=observed(async(sql,moment)=>{
      if(!changed&&moment==="after"&&sql.includes("FROM weighted w LEFT JOIN community_allowance_fit_cache")) {
        changed=true;await db().prepare("UPDATE community_allowance_fit_cache SET cache_key='invalidated-after-read'").run();
      }
    });
    expect((await advanceCommunityPublication(observer.database,NOW,{budget:budget()})).status).toBe("deferred");
    expect(changed).toBe(true);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_publication_members WHERE selected_revision IS NOT NULL").first())
      .toEqual({n:0});
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toBeNull();
  });
  it("uses a byte-bounded prefix rather than truncating large member payloads",async()=>{
    for(const participantId of ["synthetic-large-publication-a","synthetic-large-publication-b"]) {
      await seedModelHistoryFixture({participantId,binCount:0});
    }
    await warm();
    const paddedFits=" ".repeat(1_100_000)+"[]";
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json=?").bind(paddedFits).run();
    await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:2});
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:1})).status).toBe("deferred");
    expect(await db().prepare("SELECT prepared_count FROM community_publication_generation").first()).toEqual({prepared_count:1});
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toBeNull();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    const observer=observed(),result=await readCapturedCommunityPublication(observer.database,NOW,{budget:budget()});
    expect(result?.corpus.participantIds).toHaveLength(2);expect(result?.corpus.fits).toEqual([]);
    expect(observer.queries.filter(sql=>sql.includes("SELECT m.* FROM weighted w"))).toHaveLength(2);
  });
  it("restarts obsolete source-family membership instead of waiting for an impossible cache",async()=>{
    await seedModelHistoryFixture();await warm();
    await advanceCommunityPublication(db(),NOW,{budget:budget(),maxPages:2});
    // Recreate an older legacy-only captured identity followed by a newer v1
    // source cache. The obsolete member must never admit a mismatched prefix.
    await db().prepare("UPDATE community_publication_members SET source='v0.2',composition_supported=0").run();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("deferred");
    expect(await db().prepare("SELECT phase FROM community_publication_generation").first()).toEqual({phase:"retiring"});
    expect(await readCapturedCommunityPublication(db(),NOW,{budget:budget()})).toBeNull();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    expect((await readCapturedCommunityPublication(db(),NOW,{budget:budget()}))?.corpus.participantIds).toHaveLength(1);
  });
  it("publishes a daily graph when an unrelated upload arrives during immutable cohort reading",async()=>{
    const fixture=await seedModelHistoryFixture();await warm();
    expect((await advanceCommunityPublication(db(),NOW,{budget:budget()})).status).toBe("ready");
    const captured=await readCapturedCommunityPublication(db(),NOW,{budget:budget()});let uploaded=false;
    const observer=observed(async(sql,moment)=>{
      if(!uploaded&&moment==="after"&&sql.includes("SELECT m.* FROM weighted w")) {
        uploaded=true;await insertModelHistoryRecords(fixture,"while-daily-reads",[
          {stream:"quota",observedAt:"2026-09-08T00:00:00.000Z",usedPercent:1}]);
      }
    });
    const result=await rebuildPendingCommunityDailyAggregates(observer.database,NOW,1,{chunks:64,events:1000},
      {mode:"cache-only",budget:budget()});
    expect(uploaded).toBe(true);expect(result.processed,JSON.stringify(observer.errors)).toBe(1);
    const row=await db().prepare("SELECT day,payload_json FROM community_daily_aggregates WHERE release_state='published'")
      .first<{day:string;payload_json:string}>();expect(row).not.toBeNull();
    expect(JSON.parse(row!.payload_json).allowance).toEqual(summarizeCommunityAllowanceDay(captured!.corpus.fits,row!.day));
  });
  it("blocks daily publication if withdrawal occurs after capture but before the final day transaction",async()=>{
    await seedModelHistoryFixture();await warm();await advanceCommunityPublication(db(),NOW,{budget:budget()});
    let withdrawn=false;
    const observer=observed(async(sql,moment)=>{
      if(!withdrawn&&moment==="before"&&sql.includes("INSERT INTO community_daily_aggregates")) {
        withdrawn=true;await db().prepare("UPDATE participants SET state='deleting'").run();
      }
    });
    await rebuildPendingCommunityDailyAggregates(observer.database,NOW,1,{chunks:64,events:1000},{mode:"cache-only",budget:budget()});
    expect(withdrawn).toBe(true);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_daily_aggregates WHERE release_state='published'").first()).toEqual({n:0});
  });
  it("captures beyond1024 contributors across restarts without a physical census ceiling",async()=>{
    const count=1025,from="2026-05-31",fp="a".repeat(64);
    // Publication unit fixtures intentionally use terminal empty fits/refusals.
    // The independent scale qualification uses real dense fitted calculators.
    for(let index=0;index<count;index++) {
      const id=`synthetic-publication-${String(index).padStart(4,"0")}`;
      await seedModelHistoryFixture({participantId:id,binCount:0});
      const revision=(await db().prepare("SELECT revision FROM community_analytical_input_versions WHERE participant_id=?")
        .bind(id).first<{revision:number}>())!.revision;
      await db().batch([
        db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at,input_fingerprint,source_method_version)
          VALUES(?,?,'[]','2026-09-08T00:00:00.000Z',?,?)`).bind(id,`v1:${revision}:${from}:${V1_FIT_CACHE_KEY_SUFFIX}`,fp,COMMUNITY_ATTRIBUTION_METHOD_VERSION),
        db().prepare(`INSERT INTO community_model_composition_cache(participant_id,cache_key,composition_json,computed_at,input_fingerprint,source_method_version)
          VALUES(?,?,?,'2026-09-08T00:00:00.000Z',?,?)`).bind(id,`v1:${revision}:${from}:${COMPOSITION_CACHE_KEY_SUFFIX}`,
            JSON.stringify({status:"not_testable",reason:"plan_attribution_limit_exceeded"}),fp,COMMUNITY_ATTRIBUTION_METHOD_VERSION),
      ]);
    }
    let ready=false,queries=0;const observation=observed();
    for(let attempt=0;attempt<40&&!ready;attempt++) {
      const meter=createD1InvocationBudget(30),allocation=budget(30);
      const progress=await advanceCommunityPublication(meter.wrap(observation.database),NOW,{budget:allocation,maxPages:1});
      expect(meter.queriesUsed).toBeLessThanOrEqual(30);queries+=meter.queriesUsed;ready=progress.status==="ready";
    }
    expect(ready).toBe(true);expect(queries).toBeLessThan(220);
    const meter=createD1InvocationBudget(30),result=await readCapturedCommunityPublication(meter.wrap(db()),NOW,{budget:budget(30)});
    expect(result?.corpus.participantIds).toHaveLength(count);expect(result?.corpus.fits).toEqual([]);
    expect(result?.compositions.refusedParticipantCount).toBe(count);expect(meter.queriesUsed).toBe(19);
    const readCounts=[...observation.reads],totalRowsRead=readCounts.reduce((sum,[,value])=>sum+value.rows,0);
    // These are observed SQLite rows, not SQL-text estimates. In particular,
    // the progress SUM must seek only this page's IDs rather than rejoining
    // every captured member for every json_each value (formerly575,591 rows).
    const progressReads=readCounts.find(([sql])=>sql.startsWith("UPDATE community_publication_generation SET\n      prepared_count"));
    expect(progressReads?.[1].calls).toBe(17);expect(progressReads?.[1].rows).toBeLessThan(count*4);
    expect(totalRowsRead,JSON.stringify(readCounts)).toBeLessThan(count*120);
  },30_000);
});
