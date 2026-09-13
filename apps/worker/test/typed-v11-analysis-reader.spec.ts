import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource, STORAGE_OPERATING_BUDGET_BYTES } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11ExportEntries } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin } from "../src/telemetry-v11-domain";
import { accountScopedQuotaAnalysisV11 } from "../src/quota-analysis-v11";
import { readTypedV11UsageAnalysisPage, readTypedV11ChunkRecords, TYPED_V11_USAGE_PAGE_SQL } from "../src/typed-v11-analysis-reader";
import { typedTelemetryReadNamespace } from "../src/typed-telemetry-read-layout";
import { sha256Hex } from "../src/crypto";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from "../src/storage-analytics-runtime";
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult } from "../src/storage-community-graph";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { readPublishedStorageCommunityDaily } from "../src/storage-community-daily";
import { readPublishedStorageCommunityGraph } from "../src/storage-community-graph-publication";
import { readStorageCommunityProgress } from "../src/storage-community-progress";
import { handleRequest } from "../src/index";
import { runBackendLifecycle } from "../src/retention";
import { reconcilePendingQuarantineObjects } from "../src/quarantine-reconciliation";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

const b=env as Env & { STORAGE_INGESTION_A:D1Database; TEST_MIGRATIONS:D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];
  STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[] };
const typed=()=>b.STORAGE_INGESTION_A, legacy=()=>b.USAGE_MONITOR_DB;
const namespace="synthetic-analysis-source", participantId="participant:synthetic-analysis";
const day=()=>new Date().toISOString().slice(0,10);
type Fixture=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Prepared=Awaited<ReturnType<typeof makeV11Day>>;
beforeEach(async()=>{
  await reset();
  await applyD1Migrations(legacy(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(typed(),namespace);
  await initializeTypedV11Admission(typed(),namespace);
});
async function stage(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  if(!isTyped)return stageV11Day(db,f,prepared);
  await registerTelemetryV11DayManifest(db,f,prepared.manifest);
  for(const chunk of prepared.chunks){
    const digest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const device=await authenticateDevice(db,f.authorization);
    const grant=await createDeviceUploadAuthorization(db,device,digest,200);
    const claim=await claimDeviceUploadAuthorization(db,`Upload ${grant.uploadAuthorization}`,
      {envelopeDigest:digest,bodyBytes:200,contentType:"application/json"});
    await persistTypedV11StagedChunk(db,f,chunk,{sourceNamespace:namespace,
      chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,
      envelopeDigest:digest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  return registerTelemetryV11DayManifest(db,f,prepared.manifest);
}
async function activate(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  const candidate=await stage(db,f,prepared,isTyped);
  const prior=await createTelemetryV11DomainPredecessor(db,f);
  const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",
    fromDay:day(),throughDay:day(),predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
      legacyFingerprint:prior.legacyFingerprint},days:[{day:day(),manifestId:candidate.manifestId,
      manifestDigest:candidate.manifestDigest}],manifestDigest:"0".repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db,f,manifest);
}
function evidence(){
  const start=Date.parse(day()+"T01:00:00.000Z");
  const attribution={accountBasis:"same_source" as const,accountTrackId:"account-track:v2:"+"a".repeat(64),
    planBasis:"same_source_occurrence" as const,planType:"pro" as const,planEraId:null};
  const quota:TelemetryV11QuotaObservation[]=Array.from({length:9},(_,i)=>({schemaVersion:"quota-observation-v1.1",
    observationId:`quota:synthetic:${i}`,observedTime:new Date(start+i*300000).toISOString(),provider:"openai_codex",
    planType:"pro",planVariant:"unknown",limitId:"codex",slot:"seven_day",usedPercent:10+i*5,
    windowDurationMinutes:10080,resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...attribution}}));
  const usage=Array.from({length:8},(_,i)=>v11UsageRecord(day(),"a",{eventId:`event:synthetic:${i}`,
    eventTime:new Date(start+i*300000+150000).toISOString(),accountPlanAttribution:{...attribution}}));
  return {quota,usage};
}

describe("typed active-domain analytical reads",()=>{
  it("qualifies ingestion independently of analytics without claiming its rebuild completed",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
    const now=Date.now();
    await runBackendLifecycle(typed(),b.DELETION_LEDGER,b.QUARANTINE,now);
    await reconcilePendingQuarantineObjects(typed(),b.QUARANTINE,now);
    const settings:Env={...b,USAGE_MONITOR_DB:typed()};
    Reflect.set(settings,'TELEMETRY_STORAGE_MODE','typed');
    Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE',namespace);
    Object.defineProperty(settings,'ANALYTICS_DB',{get(){throw new Error('analytics offline');}});
    const response=await handleRequest(new Request('https://example.test/api/ready'),settings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:'ready',checks:{aggregateRebuildComplete:false,aggregateRebuildDelegated:true}});
    Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE','uninitialized-source');
    expect((await handleRequest(new Request('https://example.test/api/ready'),settings)).status).toBe(503);
  });
  it("advances the independent scheduler through daily and graph publication without legacy analytical writes",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence()),true);
    let available=false;
    for(let n=0;n<12;n++){
      const pass=await runStorageAnalyticsPass({...bindings,publishCommunity:true,maxSteps:3});
      expect(pass.queriesUsed).toBeLessThanOrEqual(900);
      const daily=await readPublishedStorageCommunityDaily({...bindings,fromDay:day(),throughDay:day()});
      if(daily.rows.length>0&&await readPublishedStorageCommunityGraph(bindings)){available=true;break;}
    }
    expect(available).toBe(true);
    const progress=await readStorageCommunityProgress(bindings,Date.now(),{includePreparation:true});
    expect(progress.publication.state).toBe('ready');expect(progress.work.updatedAt).not.toBeNull();
    expect(JSON.stringify(progress)).not.toContain(participantId);
    expect(await typed().prepare('SELECT count(*) n FROM community_allowance_fit_cache').first('n')).toBe(0);
    expect(await typed().prepare('SELECT count(*) n FROM community_prepared_usage_rows').first('n')).toBe(0);
    // The operating cap blocks new calculation, but must not trap obsolete
    // results forever, including while public serving is paused.
    await bindings.target.prepare(`INSERT INTO analytics_community_model_publications
      SELECT source_id,'2000-01-01',revision,method,cohort_digest,authority_json,payload_json,payload_sha256,computed_ms
      FROM analytics_community_model_publications LIMIT 1`).run();
    expect(await bindings.target.prepare("SELECT count(*) n FROM analytics_community_model_publications WHERE day='2000-01-01'").first('n')).toBe(1);
    await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    const before=await bindings.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(namespace).first('sequence');
    const full=new Proxy(bindings.target,{get(db,key){
      if(key==='prepare')return (sql:string)=>{
        const statement=db.prepare(sql);
        if(sql!=='SELECT 1 AS capacity_probe')return statement;
        return new Proxy(statement,{get(stmt,method){
          if(method==='run')return async()=>{const receipt=await stmt.run();
            return {...receipt,meta:{...receipt.meta,size_after:STORAGE_OPERATING_BUDGET_BYTES}};};
          const value=Reflect.get(stmt,method,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(db,key,db);return typeof value==='function'?value.bind(db):value;
    }});
    const capped=await runStorageAnalyticsPass({...bindings,target:full,publishCommunity:true,maxSteps:1});
    expect(capped.reason).toBe('capacity');expect(capped.steps).toBe(0);expect(capped.graphCalculations).toBe(0);
    expect(await bindings.target.prepare("SELECT count(*) n FROM analytics_community_model_publications WHERE day='2000-01-01'").first('n')).toBe(0);
    expect(await bindings.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(namespace).first('sequence')).toBe(before);
  },60000);
  it("preserves scalar quota results while keeping the JSON record table empty",async()=>{
    const a=await createV11DeviceFixture(legacy(),{participantId,grant:true});
    const c=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const prepared=await makeV11Day(day(),evidence());
    await activate(legacy(),a,prepared,false);await activate(typed(),c,prepared,true);
    const old=await accountScopedQuotaAnalysisV11(legacy(),participantId);
    const next=await accountScopedQuotaAnalysisV11(typed(),participantId);
    const summarize=(value:object)=>{
      const parsed=value as {status:string;tracks:Array<{continuity:{accountScopeId:string;planType:string};
        calibration:{tracks:Array<{resets:Array<{status:string;capacityNanousd:number|null;refusalCodes:string[]}>}>}}>};
      return {status:parsed.status,tracks:parsed.tracks.map(t=>({account:t.continuity.accountScopeId,plan:t.continuity.planType,
        resets:t.calibration.tracks.flatMap(q=>q.resets.map(r=>({status:r.status,capacity:r.capacityNanousd,refusals:r.refusalCodes})))}))};
    };
    expect(summarize(old).tracks).toHaveLength(1);
    expect(summarize(old).tracks[0]!.resets.some(r=>r.capacity!==null)).toBe(true);
    expect(summarize(next)).toEqual(summarize(old));
    expect(await typed().prepare("SELECT count(*) FROM telemetry_v11_records").first("count(*)")).toBe(0);
  });

  it("pages exact usage across chunks and rejects a different namespace",async()=>{
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const records=Array.from({length:5003},(_,i)=>v11UsageRecord(day(),"a",{eventId:`event:synthetic:${i.toString().padStart(5,"0")}`,
      eventTime:new Date(Date.parse(day()+"T01:00:00.000Z")+i*1000).toISOString()}));
    await activate(typed(),f,await makeV11Day(day(),{usage:records}),true);
    const pin=(await loadV11SourcePin(typed(),participantId))!;
    const options={sourceNamespace:namespace,pin,day:day(),from:day()+"T00:00:00.000Z",to:day()+"T23:59:59.999Z",
      afterTime:day()+"T00:00:00.000Z",afterOccurrence:""};
    const meter=createD1InvocationBudget(1);
    const first=await readTypedV11UsageAnalysisPage(meter.wrap(typed()),options);
    expect(first).toHaveLength(5000);
    expect(meter.queriesUsed).toBe(1);
    const second=await readTypedV11UsageAnalysisPage(typed(),{...options,afterTime:first.at(-1)!.observed_at,
      afterOccurrence:first.at(-1)!.occurrence_id});
    expect(second).toHaveLength(3);
    expect([...first,...second].map(r=>JSON.parse(r.record_json))).toEqual(records);
    await expect(readTypedV11UsageAnalysisPage(typed(),{...options,sourceNamespace:"wrong-source"})).rejects.toThrow();
    const explain=await typed().prepare("EXPLAIN QUERY PLAN "+TYPED_V11_USAGE_PAGE_SQL).bind(participantId,pin.generationId,
      day(),Date.parse(options.from),Date.parse(options.to),Date.parse(options.afterTime),"",200).all<{detail:string}>();
    expect(explain.results.some(r=>r.detail.includes("typed_v11_manifest_observed"))).toBe(true);
  },60_000);

  it("exports staged typed records through the existing private export iterator",async()=>{
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const records=[v11UsageRecord(day(),"b"),v11UsageRecord(day(),"a")];
    await stage(typed(),f,await makeV11Day(day(),{usage:records}),true);
    const entries=[];for await(const entry of telemetryV11ExportEntries(typed(),participantId,new Date().toISOString()))entries.push(entry);
    const chunks=entries.filter(x=>Reflect.get(x,"kind")==="chunk");expect(chunks).toHaveLength(1);
    expect(Reflect.get(chunks[0]!,"records")).toEqual([...records].reverse());
    expect(Reflect.get(chunks[0]!,"activeWhenRead")).toBe(false);
    const chunkId=(await typed().prepare("SELECT id FROM telemetry_v11_chunks").first<string>("id"))!;
    await expect(readTypedV11ChunkRecords(typed(),{sourceNamespace:namespace,participantId:"foreign",chunkId,expectedCount:2})).rejects.toThrow();
    expect(await typedTelemetryReadNamespace(legacy())).toBeNull();
  });

  it("calculates and reuses exact allowance fits in the separate database, then fences a policy change",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence()),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:"fits",sourceId:namespace,sourceNamespace:namespace});
    const computed=await computeStorageGraphResult(bindings,scope);
    expect(computed.state).toBe("complete");
    if(computed.state!=="complete")throw new Error("synthetic fit did not complete");
    expect(computed.result.fits!.length).toBeGreaterThan(0);
    expect(computed.result.fits!.every(fit=>fit.participantId===owner.ownerDigest)).toBe(true);
    expect(computed.reused).toBe(false);
    const meter=createD1InvocationBudget(20);
    const repeated=await computeStorageGraphResult({...bindings,source:meter.wrap(typed()),target:meter.wrap(bindings.target)},scope);
    expect(repeated.state==="complete"&&repeated.reused).toBe(true);
    expect(await typed().prepare("SELECT count(*) FROM community_allowance_fit_cache").first("count(*)")).toBe(0);
    expect(await typed().prepare("SELECT count(*) FROM telemetry_v11_records").first("count(*)")).toBe(0);
    expect(await bindings.target.prepare("SELECT count(*) FROM analytics_community_graph_results").first("count(*)")).toBe(1);
    await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    await expect(readStorageGraphResult(bindings,scope)).rejects.toThrow();
    expect(await typed().prepare("SELECT count(*) FROM typed_telemetry_records").first("count(*)")).toBe(17);
  });
});
