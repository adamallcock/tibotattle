import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource, STORAGE_OPERATING_BUDGET_BYTES } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11ExportEntries } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin } from "../src/telemetry-v11-domain";
import { accountScopedModelCompositionV11,accountScopedQuotaAnalysisV11,advanceV11UsageReduction,
  createV11QuotaAcquisitionIdentity,finishV11UsageReduction,validateV11UsageReductionCheckpoint,
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11";
import { validCompleteCachedComposition,validCompleteScalarAnalysis } from "../src/community-allowance";
import { readTypedV11UsageAnalysisPage, readTypedV11ChunkRecords, TYPED_V11_USAGE_PAGE_SQL } from "../src/typed-v11-analysis-reader";
import { typedTelemetryReadNamespace } from "../src/typed-telemetry-read-layout";
import { sha256Hex } from "../src/crypto";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from "../src/storage-analytics-runtime";
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult,
  storageGraphDependencyDigest,STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD,
  STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD } from "../src/storage-community-graph";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { readPublishedStorageCommunityDaily } from "../src/storage-community-daily";
import { readPublishedStorageCommunityGraph } from "../src/storage-community-graph-publication";
import { readStorageCommunityProgress } from "../src/storage-community-progress";
import {loadStorageHistoryCheckpoint,saveStorageHistoryCheckpoint,
  type StorageHistoryKey,type StorageHistoryLoadCursor} from "../src/storage-history-checkpoint";
import {advanceStorageV11Analysis,type StorageV11HistoryCheckpoint} from '../src/storage-v11-history';
import {loadTypedV11GenerationSnapshot} from '../src/typed-v11-quota-reader';
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
  return activateDays(db,f,[prepared],isTyped);
}
async function activateDays(db:D1Database,f:Fixture,prepared:Prepared[],isTyped:boolean){
  const candidates=[];
  for(const value of prepared)candidates.push(await stage(db,f,value,isTyped));
  return activateCandidates(db,f,candidates);
}
async function activateCandidates(db:D1Database,f:Fixture,candidates:Awaited<ReturnType<typeof stage>>[]){
  candidates.sort((left,right)=>left.day.localeCompare(right.day));
  const prior=await createTelemetryV11DomainPredecessor(db,f);
  const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",
    fromDay:candidates[0]!.day,throughDay:candidates.at(-1)!.day,
    predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
      legacyFingerprint:prior.legacyFingerprint},days:candidates.map(candidate=>({day:candidate.day,
      manifestId:candidate.manifestId,manifestDigest:candidate.manifestDigest})),manifestDigest:"0".repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db,f,manifest);
}
function observePreparedSql(database:D1Database){
  const queries:string[]=[];
  return {queries,database:new Proxy(database,{get(value,key){
    if(key==='prepare')return(sql:string)=>{queries.push(sql);return value.prepare(sql)};
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }})};
}
function loseFirstBatchResponse(database:D1Database){let losses=0;
  return {losses:()=>losses,database:new Proxy(database,{get(value,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const result=await value.batch(statements);if(losses++===0)throw new Error('synthetic committed checkpoint response loss');
      return result;
    };
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }})};
}
function evidence(quotaCount=9,observedDay=day(),label="synthetic"){
  const start=Date.parse(observedDay+"T01:00:00.000Z");
  const interval=quotaCount===9?300000:1000;
  const attribution={accountBasis:"same_source" as const,accountTrackId:"account-track:v2:"+"a".repeat(64),
    planBasis:"same_source_occurrence" as const,planType:"pro" as const,planEraId:null};
  const quota:TelemetryV11QuotaObservation[]=Array.from({length:quotaCount},(_,i)=>({schemaVersion:"quota-observation-v1.1",
    observationId:`quota:${label}:${i}`,observedTime:new Date(start+i*interval).toISOString(),provider:"openai_codex",
    planType:"pro",planVariant:"unknown",limitId:"codex",slot:"seven_day",usedPercent:quotaCount===9?10+i*5:10+i%19*5,
    windowDurationMinutes:10080,resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...attribution}}));
  const usage=Array.from({length:8},(_,i)=>v11UsageRecord(observedDay,"a",{eventId:`event:${label}:${i}`,
    eventTime:new Date(start+i*300000+150000).toISOString(),accountPlanAttribution:{...attribution}}));
  return {quota,usage};
}
async function loadedCheckpoint(key:StorageHistoryKey):Promise<StorageV11HistoryCheckpoint>{
 let cursor:StorageHistoryLoadCursor|undefined;
 for(;;){const loaded=await loadStorageHistoryCheckpoint({target:b.STORAGE_ANALYTICS_DB,key,cursor});
  if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
  if(loaded.status!=='ready'||!('source'in loaded.checkpoint))throw new Error('synthetic v1.1 checkpoint unavailable');
  return loaded.checkpoint;
 }
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
    expect(await computeStorageGraphResult(bindings,scope)).toEqual({state:'deferred',reason:'v11_owner_pending'});
    expect(await bindings.target.prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const computed=await computeStorageGraphResult(bindings,scope);
    expect(computed.state).toBe("complete");
    if(computed.state!=="complete")throw new Error("synthetic fit did not complete");
    expect(computed.result.fits!.length).toBeGreaterThan(0);
    expect(computed.result.fits!.every(fit=>fit.participantId===owner.ownerDigest)).toBe(true);
    expect(computed.reused).toBe(false);
    expect(await bindings.target.prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
      WHERE source_id=? AND owner_digest=? AND method=?`).bind(namespace,owner.ownerDigest,
       STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD).first<number>('n')).toBe(2);
    const modelScope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:"model",sourceId:namespace,sourceNamespace:namespace});
    expect(modelScope.dependencyDigest).not.toBe(scope.dependencyDigest);
    expect(modelScope.checkpointDependencyDigest).toBe(scope.checkpointDependencyDigest);
    const modelReads=observePreparedSql(typed());
    const model=await computeStorageGraphResult({...bindings,source:modelReads.database},modelScope);
    expect(model.state).toBe('complete');
    if(model.state!=='complete')throw new Error('synthetic model did not complete');
    expect(model.result.composition?.status).toBe('ready');
    expect(await bindings.target.prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
      WHERE source_id=? AND owner_digest=? AND method=?`).bind(namespace,owner.ownerDigest,
       STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD).first<number>('n')).toBe(2);
    expect(modelReads.queries.filter(sql=>sql.includes("stream='usage'")
      ||sql.includes("stream = 'usage'")||sql.includes("stream=3"))).toHaveLength(0);
    const shared=await loadStorageHistoryCheckpoint({target:bindings.target,key:{sourceId:namespace,
      sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day:scope.day,
      dependencyDigest:scope.checkpointDependencyDigest,method:STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD}});
    expect(shared.status).toBe('ready');
    if(shared.status!=='ready'||!('source'in shared.checkpoint)||shared.checkpoint.phase!=='usage'
      ||!('source'in scope.pin))throw new Error('expected completed shared v11 usage checkpoint');
    const liveAcquisition={...shared.checkpoint.acquisition,
      identity:createV11QuotaAcquisitionIdentity(scope.pin,Date.parse(scope.fixedNow))};
    const reductionOptions={nowMs:Date.parse(scope.fixedNow),sourcePin:scope.pin,typedSourceNamespace:namespace,
      quotaAcquisition:liveAcquisition};
    expect(await finishV11UsageReduction(typed(),scope.pin,reductionOptions,shared.checkpoint.usage,'fits',shared.checkpoint.identity))
      .toEqual(await accountScopedQuotaAnalysisV11(typed(),participantId,{nowMs:Date.parse(scope.fixedNow),sourcePin:scope.pin}));
    expect(await finishV11UsageReduction(typed(),scope.pin,reductionOptions,shared.checkpoint.usage,'model',shared.checkpoint.identity))
      .toEqual(await accountScopedModelCompositionV11(typed(),participantId,{nowMs:Date.parse(scope.fixedNow),sourcePin:scope.pin}));
    const capped=await advanceV11UsageReduction(typed(),scope.pin,{...reductionOptions,maxWindowedUsageRows:1},
      {remainingQueries:32,deadlineMs:Date.now()+20_000},null,32,shared.checkpoint.identity);
    expect(capped).toMatchObject({complete:true,rowsRead:1,commonRefusal:'windowed_usage_limit_exceeded',
      previous:[],hazards:[],scalarBuckets:[],modelCosts:[],poisoned:[]});
    expect(validateV11UsageReductionCheckpoint(capped)).toBe(true);
    const oversized=structuredClone(shared.checkpoint.usage);
    oversized.complete=false;oversized.dayIndex=0;oversized.cursorTime=day()+"T00:00:00.000Z";
    oversized.cursorOccurrence="";oversized.rowsRead=2000;oversized.commonRefusal=null;
    oversized.previous=Array.from({length:2000},(_,index)=>({key:`session:${index.toString().padStart(5,'0')}:`+'x'.repeat(64),
      time:Date.parse(day()+"T01:00:00.000Z")+index,scope:null}));
    expect(validateV11UsageReductionCheckpoint(oversized)).toBe(true);
    const bounded=await advanceV11UsageReduction(typed(),scope.pin,{...reductionOptions,maxUsageCheckpointBytes:64*1024},
      {remainingQueries:32,deadlineMs:Date.now()+20_000},oversized,1,shared.checkpoint.identity);
    expect(bounded).toMatchObject({complete:true,commonRefusal:'reduced_usage_limit_exceeded',
      previous:[],hazards:[],scalarBuckets:[],modelCosts:[],poisoned:[]});
    expect(validateV11UsageReductionCheckpoint(bounded)).toBe(true);
    const meter=createD1InvocationBudget(20);
    const repeated=await computeStorageGraphResult({...bindings,source:meter.wrap(typed()),target:meter.wrap(bindings.target)},scope);
    expect(repeated.state==="complete"&&repeated.reused).toBe(true);
    expect(await typed().prepare("SELECT count(*) FROM community_allowance_fit_cache").first("count(*)")).toBe(0);
    expect(await typed().prepare("SELECT count(*) FROM telemetry_v11_records").first("count(*)")).toBe(0);
    expect(await bindings.target.prepare("SELECT count(*) FROM analytics_community_graph_results").first("count(*)")).toBe(2);
    await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    await expect(readStorageGraphResult(bindings,scope)).rejects.toThrow();
    expect(await typed().prepare("SELECT count(*) FROM typed_telemetry_records").first("count(*)")).toBe(17);
  });

  it("keeps the last promoted v1.1 page when the invocation query meter exhausts",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence(2048)),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    const observed=observePreparedSql(typed()),targetObserved=observePreparedSql(bindings.target);
    expect(await computeStorageGraphResult({...bindings,source:observed.database,target:targetObserved.database},scope,{maxQueries:80}))
      .toEqual({state:'deferred',reason:'v11_checkpoint'});
    const staged=await bindings.target.prepare(`SELECT count(*) n FROM analytics_history_checkpoint_heads h
      JOIN analytics_history_checkpoint_stages s ON s.key_digest=h.key_digest AND s.generation=h.generation
      WHERE s.source_id=? AND s.owner_digest=? AND s.method=? AND h.retired=0`)
      .bind(namespace,owner.ownerDigest,STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD).first<number>('n');
    expect(staged).toBe(1);
    const control=await bindings.target.prepare(`SELECT s.control_json FROM analytics_history_checkpoint_heads h
      JOIN analytics_history_checkpoint_stages s ON s.key_digest=h.key_digest AND s.generation=h.generation
      WHERE s.source_id=? AND s.owner_digest=? AND s.method=? AND h.retired=0`)
      .bind(namespace,owner.ownerDigest,STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD).first<string>('control_json');
    expect(JSON.parse(control!).phase).toBe('finish');
    // Retained-generation work performs a fixed capture/live fence around the
    // whole grouped read; it must not repeat the authority query per page.
    expect(observed.queries.filter(sql=>sql.includes('FROM typed_v11_admission_state s')).length).toBe(5);
    expect(observed.queries.filter(sql=>sql.includes('AS physical_id')
      &&sql.includes('typed_telemetry_owner_time'))).toHaveLength(9);
    expect(observed.queries.length).toBeLessThanOrEqual(25);
    expect(targetObserved.queries.length).toBeLessThanOrEqual(40);
    expect(observed.queries.length+targetObserved.queries.length).toBeLessThanOrEqual(65);
    const completed=await computeStorageGraphResult(bindings,scope,{maxQueries:900});
    expect(completed.state).toBe('complete');
    expect(await bindings.target.prepare(`SELECT count(*) n FROM analytics_community_graph_results
      WHERE source_id=? AND owner_digest=? AND metric='fits'`).bind(namespace,owner.ownerDigest).first<number>('n')).toBe(1);
  },120_000);

  it("persists a compact multi-page usage cursor once and reuses it for both v1.1 metrics",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true}),prepared=evidence();
    const attribution=prepared.quota[0]!.accountPlanAttribution,start=Date.parse(day()+"T01:00:00.000Z");
    prepared.usage=Array.from({length:5003},(_,index)=>v11UsageRecord(day(),"a",{
      eventId:`event:reduction:${index.toString().padStart(5,"0")}`,
      eventTime:new Date(start+index*1000).toISOString(),accountPlanAttribution:{...attribution}}));
    await activate(typed(),f,await makeV11Day(day(),prepared),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const fitScope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    expect((await computeStorageGraphResult(bindings,fitScope,{maxQueries:900})).state).toBe('complete');
    const loaded=await loadStorageHistoryCheckpoint({target:bindings.target,key:{sourceId:namespace,
      sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day:fitScope.day,
      dependencyDigest:fitScope.checkpointDependencyDigest,method:STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD}});
    expect(loaded.status).toBe('ready');
    if(loaded.status!=='ready'||!('source'in loaded.checkpoint)||loaded.checkpoint.phase!=='usage')
      throw new Error('expected usage checkpoint');
    expect(loaded.checkpoint.usage).toMatchObject({complete:true,rowsRead:5003,dayIndex:1});
    const encoded=JSON.stringify(loaded.checkpoint.usage);
    expect(encoded).not.toContain('record_json');expect(encoded).not.toContain('event:reduction:');
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(250_000);
    const modelScope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'model',sourceId:namespace,sourceNamespace:namespace});
    const reads=observePreparedSql(typed());
    expect((await computeStorageGraphResult({...bindings,source:reads.database},modelScope,{maxQueries:900})).state).toBe('complete');
    expect(reads.queries.filter(sql=>sql.includes("stream='usage'")||sql.includes("stream = 'usage'"))).toHaveLength(0);
  },120_000);

  it("persists a valid terminal refusal instead of an overflowing usage accumulator",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true}),prepared=evidence();
    prepared.usage[0]={...prepared.usage[0]!,totalInputContextTokens:1_000_000_000_000,
      components:{inputUncachedTokens:1_000_000_000_000,inputCacheReadTokens:0,inputCacheWriteTokens:0,
        outputTextTokens:0,outputReasoningTokens:0,outputCombinedTokens:null}};
    await activate(typed(),f,await makeV11Day(day(),prepared),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    expect((await computeStorageGraphResult(bindings,scope,{maxQueries:900})).state).toBe('complete');
    const loaded=await loadStorageHistoryCheckpoint({target:bindings.target,key:{sourceId:namespace,
      sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day:scope.day,
      dependencyDigest:scope.checkpointDependencyDigest,method:STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD}});
    expect(loaded.status).toBe('ready');
    if(loaded.status!=='ready'||!('source'in loaded.checkpoint)||loaded.checkpoint.phase!=='usage')
      throw new Error('expected terminal usage checkpoint');
    expect(loaded.checkpoint.usage.complete).toBe(true);
    if(!('source'in scope.pin))throw new Error('expected v11 pin');
    const stressed=structuredClone(loaded.checkpoint.usage);
    stressed.complete=false;stressed.dayIndex=0;stressed.cursorTime=day()+"T00:00:00.000Z";
    stressed.cursorOccurrence='';stressed.rowsRead=0;stressed.previous=[];stressed.hazards=[];stressed.poisoned=[];
    stressed.commonRefusal=null;stressed.scalarRefusal=null;stressed.modelRefusal=null;
    stressed.usageEventCount=0;stressed.unpricedUsageEventCount=0;stressed.attributionUnresolved=false;
    stressed.scalarBuckets.forEach(bucket=>{bucket.value.costNanousd=90_000_000_000_000});
    stressed.modelCosts.forEach(bucket=>{bucket.costNanousd=90_000_000_000_000});
    expect(validateV11UsageReductionCheckpoint(stressed)).toBe(true);
    const liveAcquisition={...loaded.checkpoint.acquisition,
      identity:createV11QuotaAcquisitionIdentity(scope.pin,Date.parse(scope.fixedNow))};
    const refused=await advanceV11UsageReduction(typed(),scope.pin,{nowMs:Date.parse(scope.fixedNow),
      sourcePin:scope.pin,typedSourceNamespace:namespace,quotaAcquisition:liveAcquisition},
      {remainingQueries:32,deadlineMs:Date.now()+20_000},stressed,32,loaded.checkpoint.identity);
    expect(refused).toMatchObject({complete:true,scalarRefusal:'usage_cost_limit_exceeded',
      modelRefusal:'usage_cost_limit_exceeded',scalarBuckets:[],modelCosts:[],poisoned:[]});
    expect(validateV11UsageReductionCheckpoint(refused)).toBe(true);
  },120_000);

  it("resumes a grouped v1.1 acquisition after the promoted response is lost without rereading source pages",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence(2048)),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    const lost=loseFirstBatchResponse(bindings.target);
    await expect(computeStorageGraphResult({...bindings,target:lost.database},scope,{maxQueries:80}))
      .rejects.toMatchObject({stage:'graph_checkpoint_save',reason:'application'});
    expect(lost.losses()).toBe(1);
    expect(await bindings.target.prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=0')
      .first<number>('n')).toBe(1);
    const resumed=observePreparedSql(typed());
    expect((await computeStorageGraphResult({...bindings,source:resumed.database},scope,{maxQueries:900})).state).toBe('complete');
    expect(resumed.queries.filter(sql=>sql.includes('r.id AS physical_id'))).toHaveLength(0);
    expect(resumed.queries.filter(sql=>sql.includes('FROM typed_v11_admission_state s'))).toHaveLength(5);
    expect(await bindings.target.prepare(`SELECT count(*) n FROM analytics_community_graph_results
      WHERE source_id=? AND owner_digest=? AND metric='fits'`).bind(namespace,owner.ownerDigest).first<number>('n')).toBe(1);
  },120_000);

  it("finishes a persisted quota acquisition on its selected generation after a successor upload",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const selected=await stage(typed(),f,await makeV11Day(day(),evidence(2048,day(),'quota-selected')),true);
    await activateCandidates(typed(),f,[selected]);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const epoch=await typed().prepare(`SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=?`)
      .bind(owner.ownerDigest).first<number>('authority_epoch');
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,?,'active')")
      .bind(namespace,owner.ownerDigest,epoch).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    if(!('source'in scope.pin))throw new Error('synthetic v1.1 pin unavailable');
    const snapshot=await loadTypedV11GenerationSnapshot(typed(),{sourceNamespace:namespace,pin:scope.pin});
    const key:StorageHistoryKey={sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day:scope.day,
      dependencyDigest:scope.checkpointDependencyDigest,method:STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD};
    const nowMs=Date.parse(scope.fixedNow);
    const first=await advanceStorageV11Analysis({source:typed(),sourceNamespace:namespace,participantId,
      day:scope.day,metric:'fits',nowMs,sourcePin:scope.pin,generationSnapshot:snapshot,
      closedDependencyDigest:scope.checkpointDependencyDigest,maxPages:1,
      budget:{remainingQueries:900,deadlineMs:Date.now()+120_000}});
    expect(first).toMatchObject({status:'deferred',checkpoint:{phase:'acquisition',snapshot:{fingerprint:snapshot.fingerprint}}});
    if(first.status!=='deferred'||!first.checkpoint)throw new Error('synthetic quota checkpoint unavailable');
    expect((await saveStorageHistoryCheckpoint({target:bindings.target,key,checkpoint:first.checkpoint,expectedHead:null})).status).toBe('saved');

    const nextDay=new Date(Date.parse(day()+'T00:00:00.000Z')+86400000).toISOString().slice(0,10);
    const successor=await stage(typed(),f,await makeV11Day(nextDay,evidence(1,nextDay,'quota-successor')),true);
    await activateCandidates(typed(),f,[selected,successor]);
    const currentPin=await loadV11SourcePin(typed(),participantId);if(!currentPin)throw new Error('synthetic successor pin unavailable');
    expect(currentPin.fingerprint).not.toBe(snapshot.fingerprint);
    let checkpoint=await loadedCheckpoint(key),complete=false;
    for(let pass=0;pass<6&&!complete;pass++){
      const advanced=await advanceStorageV11Analysis({source:typed(),sourceNamespace:namespace,participantId,
        day:scope.day,metric:'fits',nowMs,sourcePin:currentPin,closedDependencyDigest:scope.checkpointDependencyDigest,
        checkpoint,maxPages:32,budget:{remainingQueries:900,deadlineMs:Date.now()+120_000}});
      if(advanced.status==='complete'){complete=true;break;}
      if(!advanced.checkpoint)throw new Error('synthetic resumed quota checkpoint unavailable');
      checkpoint=advanced.checkpoint;
    }
    expect(complete).toBe(true);expect(checkpoint.snapshot?.fingerprint).toBe(snapshot.fingerprint);
  },180_000);

  it("persists and rereads a model finished from an older selected generation after a successor upload",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true}),records=evidence();
    const start=Date.parse(day()+'T01:00:00.000Z'),attribution=records.quota[0]!.accountPlanAttribution;
    records.usage=Array.from({length:5003},(_,index)=>v11UsageRecord(day(),'a',{
      eventId:`event:usage-selected:${index}`,eventTime:new Date(start+index*1000).toISOString(),
      sessionUuid:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
      accountPlanAttribution:{...attribution}}));
    const selected=await stage(typed(),f,await makeV11Day(day(),records),true);await activateCandidates(typed(),f,[selected]);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const epoch=await typed().prepare(`SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=?`)
      .bind(owner.ownerDigest).first<number>('authority_epoch');
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,?,'active')")
      .bind(namespace,owner.ownerDigest,epoch).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'model',sourceId:namespace,sourceNamespace:namespace});
    if(!('source'in scope.pin))throw new Error('synthetic v1.1 pin unavailable');
    const snapshot=await loadTypedV11GenerationSnapshot(typed(),{sourceNamespace:namespace,pin:scope.pin});
    const key:StorageHistoryKey={sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day:scope.day,
      dependencyDigest:scope.checkpointDependencyDigest,method:STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD};
    const nowMs=Date.parse(scope.fixedNow),advance=(checkpoint:StorageV11HistoryCheckpoint|null,maxPages:number,pin=scope.pin)=>
      advanceStorageV11Analysis({source:typed(),sourceNamespace:namespace,participantId,day:scope.day,metric:'model',nowMs,
        sourcePin:pin as Extract<typeof scope.pin,{source:'v1.1'}>,generationSnapshot:snapshot,
        closedDependencyDigest:scope.checkpointDependencyDigest,checkpoint,maxPages,
        budget:{remainingQueries:900,deadlineMs:Date.now()+120_000}});
    const acquired=await advance(null,32);if(acquired.status!=='deferred'||!acquired.checkpoint)
      throw new Error('synthetic quota phase unavailable');
    const reduced=await advance(acquired.checkpoint,1);expect(reduced).toMatchObject({status:'deferred',
      checkpoint:{phase:'usage',usage:{complete:false},snapshot:{fingerprint:snapshot.fingerprint}}});
    if(reduced.status!=='deferred'||!reduced.checkpoint)throw new Error('synthetic usage checkpoint unavailable');
    expect((await saveStorageHistoryCheckpoint({target:bindings.target,key,checkpoint:reduced.checkpoint,expectedHead:null})).status).toBe('saved');

    const nextDay=new Date(Date.parse(day()+'T00:00:00.000Z')+86400000).toISOString().slice(0,10);
    const successor=await stage(typed(),f,await makeV11Day(nextDay,evidence(1,nextDay,'usage-successor')),true);
    await activateCandidates(typed(),f,[selected,successor]);
    const currentPin=await loadV11SourcePin(typed(),participantId);if(!currentPin)throw new Error('synthetic successor pin unavailable');
    expect(currentPin.fingerprint).not.toBe(snapshot.fingerprint);
    const currentOwner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const successorScope=await captureStorageGraphScope(typed(),{owner:currentOwner,day:scope.day,metric:'model',
      sourceId:namespace,sourceNamespace:namespace});
    expect(successorScope.checkpointDependencyDigest).toBe(scope.checkpointDependencyDigest);
    expect(successorScope.pin.fingerprint).toBe(currentPin.fingerprint);
    expect((await computeStorageGraphResult(bindings,successorScope,{maxQueries:900})).state).toBe('complete');
    const stored=await bindings.target.prepare(`SELECT input_revision,payload_fingerprint,payload_json
      FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
      .bind(namespace,currentOwner.ownerDigest,scope.day)
      .first<{input_revision:number;payload_fingerprint:string;payload_json:string}>();
    expect(stored).toMatchObject({input_revision:currentOwner.inputRevision,payload_fingerprint:snapshot.fingerprint});
    expect(JSON.parse(stored!.payload_json)).toMatchObject({inputFingerprint:snapshot.fingerprint});
    expect(await readStorageGraphResult(bindings,successorScope)).toMatchObject({scope:{metric:'model'},composition:{
      inputFingerprint:snapshot.fingerprint}});
  },240_000);

  it("resumes a closed v1.1 window across an outside append and rejects changed or erased evidence",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const historyDay=new Date(Date.parse(day()+"T00:00:00.000Z")-86400000).toISOString().slice(0,10);
    const selected=await stage(typed(),f,await makeV11Day(historyDay,evidence(2048,historyDay,"history")),true);
    const current=await stage(typed(),f,await makeV11Day(day(),evidence(1,day(),"current")),true);
    await activateCandidates(typed(),f,[selected,current]);
    let owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const initial=await captureStorageGraphScope(typed(),{owner,day:historyDay,metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    expect(await computeStorageGraphResult(bindings,initial,{maxQueries:80}))
      .toEqual({state:'deferred',reason:'v11_checkpoint'});

    // A later-day activation increments the whole-owner input revision even
    // when the selected closed day vector is unchanged. Reproduce that exact
    // pin change without changing the closed manifests under test.
    await typed().prepare(`UPDATE community_analytical_input_versions
      SET revision=revision+1 WHERE participant_id=?`).bind(participantId).run();
    owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const outside=await captureStorageGraphScope(typed(),{owner,day:historyDay,metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    expect(outside.dependencyDigest).toBe(initial.dependencyDigest);
    expect('source'in outside.pin&&'source'in initial.pin&&outside.pin.fingerprint).not.toBe(
      'source'in initial.pin?initial.pin.fingerprint:null);
    expect((await computeStorageGraphResult(bindings,outside,{maxQueries:900})).state).toBe('complete');

    const changedDigest=await storageGraphDependencyDigest({authority:outside.authority,
      ownerDigest:owner.ownerDigest!,source:'v1.1',metric:'fits',day:historyDay,
      dependency:[{observed_day:historyDay,manifest_digest:'f'.repeat(64),id:'changed',device_id:'changed'}]});
    expect(changedDigest).not.toBe(outside.dependencyDigest);

    await typed().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(participantId).run();
    await expect(computeStorageGraphResult(bindings,outside,{maxQueries:900})).rejects.toThrow();
  },180_000);

  it("stages only whole deterministic v1.1 page groups so a cut pass leaves nothing to abandon",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence(2048)),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'fits',sourceId:namespace,sourceNamespace:namespace});
    if(!('source'in scope.pin))throw new Error('synthetic v1.1 pin unavailable');
    const pin=scope.pin,snapshot=await loadTypedV11GenerationSnapshot(typed(),{sourceNamespace:namespace,pin});
    const nowMs=Date.parse(scope.fixedNow);
    const advance=(remainingQueries:number)=>advanceStorageV11Analysis({source:typed(),sourceNamespace:namespace,participantId,
      day:scope.day,metric:'fits',nowMs,sourcePin:pin,generationSnapshot:snapshot,
      closedDependencyDigest:scope.checkpointDependencyDigest,maxPages:32,
      budget:{remainingQueries,deadlineMs:Date.now()+120_000}});
    // Nine physical pages per acquisition phase. Seven fixed statements plus a
    // five-page budget cannot finish the group: the prior (empty) checkpoint
    // comes back marked cut, so nothing is staged for a different generation.
    expect(await advance(12)).toEqual({status:'deferred',checkpoint:null,cut:true});
    expect(await advance(0)).toEqual({status:'deferred',checkpoint:null,cut:true});
    // The same head and budget reproduce a byte-identical successor, which is
    // what lets a later pass resume the parts an earlier pass already staged.
    const first=await advance(900),second=await advance(900);
    expect(first).toMatchObject({status:'deferred',checkpoint:{phase:'finish'}});
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(Reflect.has(first,'cut')).toBe(false);
    // Every invocation meter too small for the whole 16-statement group is a
    // deferral that stages no generation: first the read guard, then the cut
    // group. The first meter that affords the group stages its successor, and
    // a later pass with a whole budget completes from the same head.
    const reasons=new Set<string>();
    for(let maxQueries=44;maxQueries<=80;maxQueries+=2){
      const result=await computeStorageGraphResult(bindings,scope,{maxQueries});
      if(result.state!=='deferred'||!['v11_checkpoint_read_budget','v11_checkpoint_group_budget'].includes(result.reason))break;
      reasons.add(result.reason);
      expect(await bindings.target.prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
    }
    expect([...reasons].sort()).toEqual(['v11_checkpoint_group_budget','v11_checkpoint_read_budget']);
    expect((await computeStorageGraphResult(bindings,scope,{maxQueries:900})).state).toBe('complete');
  },180_000);

  it("returns a refused v1.1 acquisition in the metric's own publishable result shape",async()=>{
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
    await bindings.target.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(namespace,owner.ownerDigest).run();
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:'model',sourceId:namespace,sourceNamespace:namespace});
    if(!('source'in scope.pin))throw new Error('synthetic v1.1 pin unavailable');
    const pin=scope.pin,snapshot=await loadTypedV11GenerationSnapshot(typed(),{sourceNamespace:namespace,pin});
    const advance=(metric:'fits'|'model')=>advanceStorageV11Analysis({source:typed(),sourceNamespace:namespace,participantId,
      day:scope.day,metric,nowMs:Date.parse(scope.fixedNow),sourcePin:pin,generationSnapshot:snapshot,
      closedDependencyDigest:scope.checkpointDependencyDigest,maxPages:32,maxQuotaRows:1,
      budget:{remainingQueries:900,deadlineMs:Date.now()+120_000}});
    // A one-row downsampled bound refuses this owner's acquisition. The model
    // history receives the bare composition refusal that the cached validator
    // accepts; the scalar fit keeps its analysis-shaped refusal.
    const model=await advance('model');
    expect(model).toEqual({status:'complete',analysis:{status:'not_testable',reason:'downsampled_quota_limit_exceeded',tracks:[]}});
    if(model.status!=='complete')throw new Error('expected a complete refusal');
    expect(validCompleteCachedComposition(model.analysis,snapshot.fingerprint,V11_PLAN_ATTRIBUTION_ADAPTER_VERSION)).toBe(true);
    const fits=await advance('fits');
    expect(fits).toEqual({status:'complete',analysis:{schemaVersion:'account-scoped-quota-analysis-v0.1',
      status:'not_testable',reason:'downsampled_quota_limit_exceeded',tracks:[]}});
    if(fits.status!=='complete')throw new Error('expected a complete refusal');
    expect(validCompleteScalarAnalysis(fits.analysis,'v1.1',snapshot.fingerprint)).toBe(true);
    // The scalar shape is not a composition: returned for a model day it would
    // fail result validation on every pass and withhold the whole model day.
    expect(validCompleteCachedComposition(fits.analysis,snapshot.fingerprint,V11_PLAN_ATTRIBUTION_ADAPTER_VERSION)).toBe(false);
  },180_000);
});
