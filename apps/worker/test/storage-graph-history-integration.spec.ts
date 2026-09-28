import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,it,expect,vi} from 'vitest';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {pricedModelHistoryUsage,MODEL_HISTORY_TEST_CAPACITIES} from './helpers/model-history';
import {createV1QuotaAcquisitionCheckpoint,V1_QUOTA_ACQUISITION_VERSION} from '../src/quota-analysis-v1-reader';
import {V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION} from '../src/quota-analysis-v11';
import {modelHistoryWindow} from '../src/model-history-window';
import {accountScopedQuotaAnalysisV1,MODEL_HISTORY_METHOD_VERSION} from '../src/quota-analysis-v1';
import {selectCommunityAllowanceAnalysisFits} from '../src/community-allowance';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization,revokeParticipantDevice} from '../src/device-auth';
import {parseTelemetryV1Chunk,type TelemetryV1Record} from '../src/telemetry-v1';
import type {V1SourcePin} from '../src/telemetry-v1-source-selection';
import {initializeTypedV1Admission,insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {registerTelemetryV11DayManifest,telemetryV11LegacyProjection} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {readEffectiveUsageOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {readTypedTelemetryRowsByStorageIds} from '../src/typed-telemetry-compatibility';
import {parseTelemetryV11Record,telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest,type TelemetryV11Record} from '@app-usagemonitor/telemetry-contract';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics,runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {COMMUNITY_ALLOWANCE_FIT_METHOD} from '../src/community-allowance';
import {captureStorageGraphScope,computeStorageGraphResult,readStorageGraphResult,storageGraphDependencyDigest,
 STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD,
 STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD,type StorageGraphScope,
 storageGraphEffectiveCheckpointMethod,storageGraphEffectiveCheckpointKey,
 STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS,STORAGE_GRAPH_METHOD} from '../src/storage-community-graph';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceStorageCommunityGraphWork} from '../src/storage-community-graph-work';
import {retireStorageGraphPage} from '../src/storage-graph-retirement';
import {loadStorageHistoryCheckpoint,retireStorageHistoryCheckpoint,saveStorageHistoryCheckpoint,
 storageHistoryKeyDigest,readStorageHistoryCheckpointHead,type StorageHistoryKey} from '../src/storage-history-checkpoint';
import type {StorageV1HistoryCheckpoint} from '../src/storage-v1-history';
import {advanceStorageEffectiveAnalysis,type StorageEffectiveHistoryCheckpoint} from '../src/storage-effective-history';
import * as effectiveHistory from '../src/storage-effective-history';
import {createStorageEffectiveQuotaPreparation} from '../src/storage-effective-quota-days';
import {readGraphDayEffectiveQuotaHeads,readGraphDayProjection,writeGraphDayProjection} from '../src/graph-day-projection';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,sourceId='synthetic-history-integration';
const namespace='synthetic-history-origin',day='2026-09-05';
const bindings=()=>({source:source(),target:target(),sourceId,sourceNamespace:namespace});
function observePreparedSql(database:D1Database){
 const queries:string[]=[];
 const observed=new Proxy(database,{get(target,key){
  if(key==='prepare')return (sql:string)=>{queries.push(sql);return target.prepare(sql)};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 return {database:observed,queries};
}
function advanceClockAfterQuotaPages(database:D1Database,setNow:(value:number)=>void){let pages=0;
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  if(key==='all'&&(sql.includes('WITH same_time AS MATERIALIZED')||sql.includes('WITH same_key AS MATERIALIZED')))
   return async(...args:unknown[])=>{const result=await Reflect.apply(Reflect.get(value,key) as Function,value,args);
    pages++;setNow(pages===1?14_000:20_000);return result;};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),pages:()=>pages};
}
function advanceClockAfterUsagePages(database:D1Database,setNow:(value:number)=>void){let pages=0,rowsRead=0;
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  const usagePage=sql.includes('WITH page AS MATERIALIZED')
    &&(sql.includes('base.stream=1')||sql.includes("r.stream = 'usage'"));
  if(key==='all'&&usagePage)return async(...args:unknown[])=>{const result=await Reflect.apply(Reflect.get(value,key) as Function,value,args);
   pages++;rowsRead+=result.results.length;setNow(pages===1?10_000:12_000);return result;};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),pages:()=>pages,rowsRead:()=>rowsRead};
}
function observeDirectAttempts(database:D1Database,failFirst:boolean){let attempts=0;
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  if(key==='all'&&sql.includes('typed_plan_input AS MATERIALIZED'))return async(...args:unknown[])=>{
   attempts++;if(failFirst&&attempts===1)throw new Error('synthetic direct read unavailable');
   return Reflect.apply(Reflect.get(value,key) as Function,value,args);};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),attempts:()=>attempts};}
function unavailableCheckpointOwner(database:D1Database,onUnavailable?:()=>Promise<void>):D1Database{
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  if(key==='first'&&sql.includes('SELECT revision,authority_epoch FROM analytics_owner_state'))return async()=>{await onUnavailable?.();return null;};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
}
function beforeFirstCheckpointSave(database:D1Database,beforeSave:()=>Promise<void>){let saves=0;
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  if(key==='first'&&sql.includes('SELECT revision,authority_epoch FROM analytics_owner_state'))return async(...args:unknown[])=>{
   const owner=await Reflect.apply(Reflect.get(value,key) as Function,value,args);
   if(++saves===1)await beforeSave();return owner;
  };
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),saves:()=>saves};
}
function loseFirstCheckpointBatchResponse(database:D1Database){let losses=0;
 return {database:new Proxy(database,{get(value,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await value.batch(statements);
   if(losses++===0)throw new Error('synthetic committed checkpoint response loss');return result;};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),losses:()=>losses};
}
function observeEffectiveQuotaPages(database:D1Database,afterPage?:(page:number)=>void|Promise<void>){let pages=0;
 const statement=(inner:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql,args);
  if(key==='all'&&sql.includes('SELECT occurrence_id,observed_at_ms FROM grouped')&&sql.includes('chunk.stream=?')&&bound.includes('quota'))return async(...args:unknown[])=>{
   const result=await Reflect.apply(Reflect.get(value,key) as Function,value,args);
   pages++;await afterPage?.(pages);return result;};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),pages:()=>pages};
}
const effectiveKey=(scope:StorageGraphScope,preparedFold=false,format:2|3=3):Promise<StorageHistoryKey>=>storageGraphEffectiveCheckpointKey({sourceId,sourceNamespace:namespace,
 ownerDigest:scope.owner.ownerDigest!,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,
 method:storageGraphEffectiveCheckpointMethod(scope.metric)},preparedFold,format);
async function clearSyntheticGraph(scope:StorageGraphScope){
 // This test owns its disposable source/target and preserves the source corpus
 // so both checkpoint strategies calculate exactly the same dependency.
 await target().prepare('DELETE FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric=? AND day=?')
  .bind(sourceId,scope.owner.ownerDigest,scope.metric,scope.day).run();
 for(const [prepared,format] of [[false,3],[true,2],[true,3]] as const){
  const key=await storageHistoryKeyDigest(await effectiveKey(scope,prepared,format));
  await target().batch([
   target().prepare('DELETE FROM analytics_history_checkpoint_heads WHERE key_digest=?').bind(key),
   target().prepare('DELETE FROM analytics_history_checkpoint_parts WHERE key_digest=?').bind(key),
   target().prepare('DELETE FROM analytics_history_checkpoint_stages WHERE key_digest=?').bind(key),
  ]);
 }
}
function observeEffectiveCheckpointWrites(database:D1Database,afterBatch?:()=>void){
 let inserts=0,payloadBytes=0;
 const statements=new WeakMap<D1PreparedStatement,{statement:D1PreparedStatement;sql:string;bound:unknown[]}>();
 const count=(sql:string,bound:unknown[])=>{if(sql.includes('INSERT INTO analytics_history_checkpoint_parts')){
  expect(Number.isSafeInteger(bound[4])).toBe(true);inserts++;payloadBytes+=bound[4] as number;
 }};
 const statement=(inner:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>{
  const wrapped=new Proxy(inner,{get(value,key){
   if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql,args);
   if(key==='run')return async(...args:unknown[])=>{count(sql,bound);return Reflect.apply(value.run,value,args);};
   const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }});statements.set(wrapped,{statement:inner,sql,bound});return wrapped;
 };
 return {counts:()=>({checkpointPartInserts:inserts,checkpointPayloadBytes:payloadBytes}),
  database:new Proxy(database,{get(value,key){
   if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
   if(key==='batch')return async(parts:D1PreparedStatement[])=>{
    let checkpointParts=false;
    const result=await value.batch(parts.map(part=>{
     const retained=statements.get(part);if(!retained)return part;
     checkpointParts ||= retained.sql.includes('INSERT INTO analytics_history_checkpoint_parts');
     count(retained.sql,retained.bound);return retained.statement;
    }));
    if(checkpointParts)afterBatch?.();
    return result;
   };
   const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }})};
}
type EffectiveGraphMeasurement={source:number;target:number;state:string;quotaPages:number;
 checkpointPartInserts:number;checkpointPayloadBytes:number};
async function measuredEffectiveGraphPass(scope:StorageGraphScope,
 options:NonNullable<Parameters<typeof computeStorageGraphResult>[2]>,afterPage?:(page:number)=>void|Promise<void>){
 const maxQueries=options.maxQueries??950,meter=createD1InvocationBudget(maxQueries),
  sourceMeter=createD1InvocationBudget(maxQueries),targetMeter=createD1InvocationBudget(maxQueries);
 const observed=observeEffectiveQuotaPages(source(),afterPage),writes=observeEffectiveCheckpointWrites(target());
 const result=await computeStorageGraphResult({...bindings(),source:meter.wrap(sourceMeter.wrap(observed.database)),
  target:meter.wrap(targetMeter.wrap(writes.database))},scope,options);
 expect(meter.queriesUsed).toBeLessThanOrEqual(maxQueries);
 const measurement:EffectiveGraphMeasurement={source:sourceMeter.queriesUsed,target:targetMeter.queriesUsed,
  state:result.state,quotaPages:observed.pages(),...writes.counts()};
 return {result,measurement};
}
async function finishEffectiveGraph(scope:StorageGraphScope,effectiveCheckpointPages:1|4=4,maxQueries=950,preparedFold=false){
 const measurements:EffectiveGraphMeasurement[]=[];
 for(let attempt=0;attempt<30;attempt++){
  const {result,measurement}=await measuredEffectiveGraphPass(scope,
   {maxQueries,deadlineMs:Date.now()+60_000,effectiveCheckpointPages,preparedFold});
  measurements.push(measurement);
  if(result.state==='complete')return {result,measurements,
   queries:measurements.reduce((sum,row)=>sum+row.source+row.target,0),
   targetQueries:measurements.reduce((sum,row)=>sum+row.target,0)};
  expect(result.reason).toBe('effective_checkpoint');
 }
 throw new Error('effective graph did not finish');
}
type EffectiveAcquisitionPhase=Extract<StorageEffectiveHistoryCheckpoint,{phase:'acquisition'}>['acquisition']['phase'];
async function effectiveCheckpointAt(scope:StorageGraphScope,phase:EffectiveAcquisitionPhase,midpoint=false){
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 let checkpoint:StorageEffectiveHistoryCheckpoint|undefined;
 for(let page=0;page<160;page++){
  const next=await advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,owner:scope.owner,
   pin:scope.pin,day:scope.day,metric:scope.metric,nowMs:Date.parse(scope.fixedNow),checkpoint,
   budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
  if(next.status!=='deferred'||!next.checkpoint)throw new Error('synthetic phase was not reached');
  checkpoint=next.checkpoint;
  if(checkpoint.phase==='acquisition'&&checkpoint.acquisition.phase===phase
   &&(!midpoint||checkpoint.effectiveCursor.phase===phase&&checkpoint.effectiveCursor.after!==null))return checkpoint;
 }
 throw new Error('synthetic phase bound');
}
async function storeEffectiveCheckpoint(scope:StorageGraphScope,checkpoint:StorageEffectiveHistoryCheckpoint,
 prepared=true,format:2|3=3){
 const key=await effectiveKey(scope,prepared,format);
 let saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint,expectedHead:null});
 while(saved.status==='staging')saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint,
  expectedHead:null,cursor:saved.cursor});
 return {key,head:saved.headDigest};
}
async function readEffectiveCheckpoint(key:StorageHistoryKey){
 let loaded=await loadStorageHistoryCheckpoint({target:target(),key,maxParts:32});
 while(loaded.status==='deferred')loaded=await loadStorageHistoryCheckpoint({target:target(),key,
  maxParts:32,cursor:loaded.cursor});
 return loaded;
}
async function clearEffectiveQuotaDays(){
 await target().prepare("DELETE FROM analytics_graph_day_values WHERE source_id=? AND source_layout='effective'").bind(sourceId).run();
 await target().prepare(`DELETE FROM analytics_graph_day_pages WHERE source_id=?
  AND NOT EXISTS(SELECT 1 FROM analytics_graph_day_values v WHERE v.value_key=analytics_graph_day_pages.value_key)`)
  .bind(sourceId).run();
}
async function effectivePreparedDays(){
 return (await target().prepare(`SELECT day,quota_rows_read FROM analytics_graph_day_values
  WHERE source_id=? AND source_layout='effective' ORDER BY day`).bind(sourceId)
  .all<{day:string;quota_rows_read:number}>()).results;
}
const originalEffectiveAdvance=advanceStorageEffectiveAnalysis;
async function observeEffectivePreparation<T>(planOnly:boolean,operation:()=>Promise<T>){
 const stores:{phase:EffectiveAcquisitionPhase;day:string;quotaRowsRead:number}[]=[];
 const observed=vi.spyOn(effectiveHistory,'advanceStorageEffectiveAnalysis').mockImplementation(input=>{
  const preparation=input.preparedQuota;
  if(!preparation)return originalEffectiveAdvance(input);
  const phase=input.checkpoint?.phase==='acquisition'?input.checkpoint.acquisition.phase:'plan';
  return originalEffectiveAdvance({...input,preparedQuota:{...preparation,
   shouldPrepare:async day=>(!planOnly||phase==='plan')&&(await preparation.shouldPrepare?.(day)??true),
   store:async day=>{stores.push({phase,day:day.projection.day,quotaRowsRead:day.quotaRowsRead});await preparation.store(day);},
  }});
 });
 try{return {value:await operation(),stores};}finally{observed.mockRestore();}
}
const totalEffectiveMeasurements=(measurements:EffectiveGraphMeasurement[])=>measurements.reduce((sum,row)=>({
 source:sum.source+row.source,target:sum.target+row.target,quotaPages:sum.quotaPages+row.quotaPages,
 checkpointPartInserts:sum.checkpointPartInserts+row.checkpointPartInserts,
 checkpointPayloadBytes:sum.checkpointPayloadBytes+row.checkpointPayloadBytes,
}),{source:0,target:0,quotaPages:0,checkpointPartInserts:0,checkpointPayloadBytes:0});
async function effectiveFixture(){
 await fixture();
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 return captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
}
function checkpointForKey(key:StorageHistoryKey):StorageV1HistoryCheckpoint{
 const identity={participantId:'synthetic-checkpoint-participant',inputFingerprint:'c'.repeat(64),sourceMethodVersion:MODEL_HISTORY_METHOD_VERSION,
  observedAtCutoff:'2026-05-28T00:00:00.000Z',resetsAtCutoff:'2026-06-04T00:00:00.000Z',windowMinutes:10080,maxQuotaRows:60000};
 return {version:1,day:key.day,layout:`typed:${key.sourceNamespace}`,identity,phase:'acquisition',acquisition:createV1QuotaAcquisitionCheckpoint(identity)};
}
beforeEach(async()=>{
 await reset();for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),sourceId);await initializeTypedV1Admission(source(),namespace);await initializeTypedV11Admission(source(),namespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 expect((await drainCommunityPublicSourceBootstrap(source())).completed).toBe(true);
 await initializeStorageAnalyticsRuntime(bindings());
});
async function fixture(extraUsageCount=0,v11CompatibleQuota=false,quotaSamplesPerBin=1){
 const owner=await createV11DeviceFixture(source()),groups=new Map<string,TelemetryV1Record[]>();
 const base=Date.parse('2026-09-01T00:00:00Z'),at=(h:number)=>new Date(base+h*3600000).toISOString();
 const push=(stream:string,time:string,record:TelemetryV1Record)=>{const key=`${stream}:${time.slice(0,10)}`;
  const group=groups.get(key)??[];group.push(record);groups.set(key,group);};
 let percent=0;
 const quota=(time:string)=>push('quota',time,{schemaVersion:'quota-observation-v1.0',observationId:v11CompatibleQuota
   ?`q:${Date.parse(time)}:codex:seven_day`:`synthetic:${time}`,
  observedTime:time,provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',slot:'seven_day',
  usedPercent:percent,windowDurationMinutes:10080,resetsAt:at(168)});
 quota(at(0));
 for(let bin=0;bin<60;bin++){
  for(const [index,[model,capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()){
   const cost=(5+((bin*7+index*11)%17)/4)*((bin+index)%3===0?0.2:1),time=at(bin*2+.5);
   const priced=pricedModelHistoryUsage(model,cost,time),fields=JSON.parse(priced.record.recordJson!);
   const record=v11UsageRecord(time.slice(0,10),'a',{...fields,eventTime:time,eventId:`synthetic:${bin}:${index}`});
   push('usage',time,JSON.parse(telemetryV11LegacyProjection('usage',record)!.canonicalRecord));
   percent+=priced.costUsd*100/capacity;
  }
  for(let sample=1;sample<=quotaSamplesPerBin;sample++)quota(at(bin*2+sample/quotaSamplesPerBin));
 }
 for(let index=0;index<extraUsageCount;index++){
  const time=at(3+index/3_600_000),priced=pricedModelHistoryUsage('gpt-5.6-sol',0.0001,time),fields=JSON.parse(priced.record.recordJson!);
  const record=v11UsageRecord(time.slice(0,10),'x',{...fields,eventTime:time,eventId:`synthetic:extra:${index}`});
  push('usage',time,JSON.parse(telemetryV11LegacyProjection('usage',record)!.canonicalRecord));
 }
 for(const [key,records] of groups){
  for(let offset=0;offset<records.length;offset+=200){
   const page=records.slice(offset,offset+200),digest=await sha256Hex(`synthetic:${key}:${offset}`),principal=await authenticateDevice(source(),owner.authorization);
   const auth=await createDeviceUploadAuthorization(source(),principal,digest,200);
   const claim=await claimDeviceUploadAuthorization(source(),`Upload ${auth.uploadAuthorization}`,{envelopeDigest:digest,bodyBytes:200,contentType:'application/json'});
   const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${key}:${offset/200}`,chunkRevision:1,
    chunkDigest:await sha256Hex(canonicalJson(page)),parserVersion:'synthetic-history',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',
     fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records:page});
   await insertTypedTelemetryV1Chunk(source(),{chunkRowId:`chunk:${crypto.randomUUID()}`,participantId:owner.participantId,deviceId:owner.deviceId,
    chunk,envelopeDigest:digest,r2Key:`synthetic/${key}:${offset/200}`,deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null},namespace);
  }
 }
 for(let n=0;n<30;n++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
 return (await readStorageCommunityOwnerPage(source()))[0]!;
}

it('advances current v1 fits through a durable bounded acquisition before semantic result promotion',async()=>{
 const owner=await fixture(),observed=observePreparedSql(source());
 const scope=await captureStorageGraphScope(observed.database,{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 const meter=createD1InvocationBudget(900);
 const first=await computeStorageGraphResult({...bindings(),source:meter.wrap(observed.database),target:meter.wrap(target())},scope);
 expect(first.state).toBe('complete');
 expect(meter.queriesUsed).toBeLessThanOrEqual(900);
 expect(observed.queries.some(sql=>sql.includes('typed_quota_input AS MATERIALIZED'))).toBe(false);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND method=?`)
  .bind(sourceId,owner.ownerDigest,day,scope.dependencyDigest,STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD).first<number>('n'))
  .toBe(1);

 let completed:Awaited<ReturnType<typeof computeStorageGraphResult>>|undefined=first;
 for(let attempt=0;attempt<4;attempt++){
  if(completed.state==='complete')break;
  const next=await computeStorageGraphResult(bindings(),scope);
  if(next.state==='complete'){completed=next;break;}
  expect(next.reason).toBe('current_fit_checkpoint');
 }
 expect(completed?.state).toBe('complete');
 if(completed?.state!=='complete')throw new Error('current fit did not complete');
 expect(completed.result.fits).not.toBeNull();
 expect(await target().prepare(`SELECT method,dependency_digest FROM analytics_community_graph_results
  WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`).bind(sourceId,owner.ownerDigest,day).first())
  .toEqual({method:STORAGE_GRAPH_METHOD,dependency_digest:scope.dependencyDigest});
 expect(await readStorageGraphResult(bindings(),scope)).not.toBeNull();
 // Relabel the completed payload with the identity the previous v1 acquisition
 // contract would have given it: a pre-clustering v1 result is not reused.
 await target().prepare(`UPDATE analytics_community_graph_results SET dependency_digest=?
  WHERE source_id=? AND owner_digest=? AND metric='fits'`).bind('c'.repeat(64),sourceId,owner.ownerDigest).run();
 expect(await readStorageGraphResult(bindings(),scope)).toBeNull();
},60000);

it('persists and resumes the current-fit usage phase before publishing the equivalent fit',async()=>{
 const owner=await fixture(5_001),scope=await captureStorageGraphScope(source(),{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 let now=0;const observed=advanceClockAfterUsagePages(source(),value=>{now=value});
 const first=await computeStorageGraphResult({...bindings(),source:observed.database},scope,{deadlineMs:20_000,now:()=>now});
 expect(first).toEqual({state:'deferred',reason:'current_fit_checkpoint'});
 expect(observed.pages()).toBeGreaterThanOrEqual(1);expect(observed.rowsRead()).toBe(5_000);
 const key:StorageHistoryKey={sourceId,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day,
  dependencyDigest:scope.dependencyDigest,method:STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD};
 const saved=await loadStorageHistoryCheckpoint({target:target(),key});
 expect(saved.status).toBe('ready');
 if(saved.status!=='ready')throw new Error('current-fit usage checkpoint missing');
 if('source'in saved.checkpoint)throw new Error('unexpected v1.1 checkpoint');
 expect(saved.checkpoint.phase).toBe('usage');
 if(saved.checkpoint.phase!=='usage')throw new Error('current-fit usage phase missing');
 expect(saved.checkpoint.usage.rowsRead).toBe(5_000);
 expect(saved.checkpoint.usage.cursorId).toBeGreaterThan(0);

 const resumed=await computeStorageGraphResult({...bindings(),source:observed.database},scope);
 expect(resumed.state).toBe('complete');
 if(resumed.state!=='complete')throw new Error('resumed current fit did not complete');
 expect(observed.pages()).toBeGreaterThan(1);expect(observed.rowsRead()).toBe(5_121);
 const baseline=await accountScopedQuotaAnalysisV1(source(),owner.participantId,{nowMs:Date.parse(scope.fixedNow),sourcePin:scope.pin as V1SourcePin});
 type FitInput=Parameters<typeof selectCommunityAllowanceAnalysisFits>[1][number];
 const expected=selectCommunityAllowanceAnalysisFits(scope.owner.ownerDigest!,[{source:'v1',analysis:baseline as FitInput['analysis']}]);
 expect(resumed.result.fits).toEqual(expected);
 expect(await target().prepare(`SELECT payload_json FROM analytics_community_graph_results
  WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`).bind(sourceId,owner.ownerDigest,day).first()).not.toBeNull();
},60000);

it('saves current-fit progress acquired at the work deadline inside the outer deadline',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 let now=0;const observed=advanceClockAfterQuotaPages(source(),value=>{now=value});
 const result=await computeStorageGraphResult({...bindings(),source:observed.database},scope,
  {deadlineMs:20_000,now:()=>now});
 expect(result).toEqual({state:'deferred',reason:'current_fit_checkpoint'});
 expect(observed.pages()).toBe(1);
 expect(now).toBe(14_000);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=0').first('n')).toBe(1);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND method=?`)
  .bind(sourceId,owner.ownerDigest,day,scope.dependencyDigest,STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD).first<number>('n'))
  .toBeGreaterThan(0);
},60000);

it('resumes from a page promoted before its response was lost',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 const lost=loseFirstCheckpointBatchResponse(target());
 await expect(computeStorageGraphResult({...bindings(),target:lost.database},scope))
  .rejects.toMatchObject({message:'STORAGE_GRAPH_OPERATION_UNAVAILABLE',stage:'graph_checkpoint_save',reason:'application'});
 expect(lost.losses()).toBe(1);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=0').first('n')).toBe(1);
 const resumed=await computeStorageGraphResult(bindings(),scope);
 expect(resumed).toMatchObject({state:'complete'});
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND method=?`)
  .bind(sourceId,owner.ownerDigest,day,scope.dependencyDigest,STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD).first<number>('n'))
  .toBe(1);
},60000);

it('reopens one repaired direct attempt, serializes concurrent claims, then falls back to the same semantic checkpoint',async()=>{
 const owner=await fixture(),observed=observePreparedSql(source());
 const scope=await captureStorageGraphScope(observed.database,{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const vectors=observed.queries.filter(sql=>sql.includes('FROM telemetry_analytical_chunks c'));
 expect(vectors).toHaveLength(1);
 expect(vectors[0]).toContain('c.chunk_day <= ?');
 expect(observed.queries.some(sql=>sql.includes('FROM telemetry_contributions'))).toBe(false);
 expect('source' in scope.pin).toBe(false);
 if('source' in scope.pin)throw new Error('unexpected v1.1 pin');
 expect(scope.pin.scope).toEqual({participantId:owner.participantId,fromDay:'2026-05-28',throughDay:day});
 expect(scope.dependencyDigest).toBe(await storageGraphDependencyDigest({authority:scope.authority,
  ownerDigest:owner.ownerDigest!,source:'v1',metric:'model',day,dependency:scope.pin.dayDependencies}));
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');if(direct.state!=='complete')throw new Error('direct missing');
 const expected=direct.result.composition;expect(expected?.status).toBe('ready');
 // A marker from the prior reader revision must permit exactly one repaired
 // direct attempt. Fail that attempt synthetically so both concurrent callers
 // converge on the unchanged durable-checkpoint fallback.
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 await target().prepare(`UPDATE analytics_community_graph_execution SET dependency_digest=?
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(scope.dependencyDigest,sourceId,owner.ownerDigest,day).run();
 const attempts=observeDirectAttempts(source(),true),concurrentBindings={...bindings(),source:attempts.database};
 const concurrent=await Promise.all([
  computeStorageGraphResult(concurrentBindings,scope),computeStorageGraphResult(concurrentBindings,scope)]);
 expect(concurrent.some(result=>result.state==='complete')).toBe(true);
 expect(concurrent.flatMap(result=>result.state==='deferred'&&result.failure?[result.failure]:[]))
  .toEqual([{phase:'graph_history_direct_read',reason:'application'}]);
 expect(attempts.attempts()).toBe(1);
 const executionDigest=await target().prepare(`SELECT dependency_digest FROM analytics_community_graph_execution
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,owner.ownerDigest,day).first<string>('dependency_digest');
 expect(executionDigest).toMatch(/^[a-f0-9]{64}$/);expect(executionDigest).not.toBe(scope.dependencyDigest);
 let completed=concurrent.some(result=>result.state==='complete');
 for(let i=0;i<24;i++){
  if(completed)break;
  const meter=createD1InvocationBudget(900);
  const result=await computeStorageGraphResult({...bindings(),source:meter.wrap(attempts.database),target:meter.wrap(target())},scope);
  expect(meter.queriesUsed).toBeLessThanOrEqual(900);
  if(result.state==='deferred')continue;
  expect(result.result.composition).toEqual(expected);completed=true;break;
 }
 expect(completed).toBe(true);
 expect(attempts.attempts()).toBe(1);
 expect(await target().prepare(`SELECT dependency_digest FROM analytics_community_graph_execution
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,owner.ownerDigest,day).first('dependency_digest')).toBe(executionDigest);
 expect(await target().prepare(`SELECT dependency_digest FROM analytics_community_graph_results
  WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`).bind(sourceId,owner.ownerDigest,day).first('dependency_digest'))
  .toBe(scope.dependencyDigest);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest!=?`)
  .bind(sourceId,owner.ownerDigest,day,scope.dependencyDigest).first('n')).toBe(0);
 expect(await source().prepare('SELECT count(*) n FROM community_prepared_usage_rows').first('n')).toBe(0);
 expect(await source().prepare('SELECT count(*) n FROM telemetry_v1_records').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads').first<number>('n')).toBeGreaterThan(0);

 const directWork=observeDirectAttempts(source(),true);
 await target().prepare(`INSERT INTO analytics_community_graph_scan(source_id,revision,tick,current_position,history_position)
  VALUES(?,1,1,0,0) ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1`).bind(sourceId).run();
 const work=await advanceStorageCommunityGraphWork({...bindings(),source:directWork.database});
 expect(work).toMatchObject({state:'deferred',metric:'model',reason:'direct_read_unavailable',
  failure:{phase:'graph_history_direct_read',reason:'application'}});
 expect(directWork.attempts()).toBe(1);

 await target().prepare(`UPDATE analytics_community_graph_execution SET dependency_digest=? WHERE source_id=? AND day=?`)
  .bind('0'.repeat(64),sourceId,work.day).run();
 await target().prepare('UPDATE analytics_community_graph_scan SET revision=revision+1,tick=1').run();
 const scheduledDirect=observeDirectAttempts(source(),true);
 const pass=await runStorageAnalyticsPass({...bindings(),source:scheduledDirect.database,publishCommunity:true,maxSteps:1,
  deadlineMs:Date.now()+20_000});
 expect(pass.graphFailure).toEqual({phase:'graph_history_direct_read',reason:'application'});
 expect(JSON.parse(JSON.stringify({event:'storage_analytics_schedule',...pass}))).toMatchObject({
  event:'storage_analytics_schedule',graphFailure:{phase:'graph_history_direct_read',reason:'application'}});
 expect(scheduledDirect.attempts()).toBe(1);
},60000);

it('rethrows an unavailable checkpoint failure when the exact head is still absent',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 await expect(computeStorageGraphResult({...bindings(),target:unavailableCheckpointOwner(target())},scope))
  .rejects.toMatchObject({stage:'graph_checkpoint_save',reason:'checkpoint_unavailable'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
});

it('reports checkpoint advancement without a failure after a newer exact head is promoted',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 const key:StorageHistoryKey={sourceId,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day,
  dependencyDigest:scope.dependencyDigest,method:STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD};
 let promotedHead:string|undefined;
 const result=await computeStorageGraphResult({...bindings(),target:unavailableCheckpointOwner(target(),async()=>{
  const saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:checkpointForKey(key),expectedHead:null});
  if(saved.status!=='saved')throw new Error('synthetic promotion did not finish');promotedHead=saved.headDigest;
 })},scope);
 expect(result).toEqual({state:'deferred',reason:'checkpoint_advanced'});
 expect(promotedHead).toMatch(/^[a-f0-9]{64}$/);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
});

it.each(['unchanged','null','retired','malformed'] as const)('keeps an unavailable save visible when the exact effective head is %s',async(headState)=>{
 const scope=await effectiveFixture(),key=await effectiveKey(scope);
 expect(await computeStorageGraphResult(bindings(),scope,{maxQueries:250,deadlineMs:Date.now()+60_000}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 const saved=await loadStorageHistoryCheckpoint({target:target(),key});
 if(saved.status!=='ready')throw new Error('synthetic effective checkpoint missing');
 const digest=await storageHistoryKeyDigest(key);
 await expect(computeStorageGraphResult({...bindings(),target:unavailableCheckpointOwner(target(),async()=>{
  if(headState==='retired')await retireStorageHistoryCheckpoint({target:target(),key,expectedHead:saved.headDigest,maxWrites:2});
  if(headState==='null'||headState==='malformed')await target().prepare('UPDATE analytics_history_checkpoint_heads SET generation=? WHERE key_digest=?')
   .bind(headState==='null'?null:'synthetic-invalid-head',digest).run();
 })},scope,{deadlineMs:Date.now()+60_000}))
  .rejects.toMatchObject({stage:'graph_checkpoint_save',reason:'checkpoint_unavailable'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
 expect(await target().prepare('SELECT generation,retired FROM analytics_history_checkpoint_heads WHERE key_digest=?').bind(digest).first())
  .toEqual({generation:headState==='unchanged'?saved.headDigest:headState==='malformed'?'synthetic-invalid-head':null,
   retired:headState==='retired'?1:0});
},30000);

it('preserves a retired legacy tombstone while a repaired checkpoint generation advances',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 const legacyKey:StorageHistoryKey={sourceId,sourceNamespace:namespace,ownerDigest:owner.ownerDigest!,day,
  dependencyDigest:scope.dependencyDigest,method:STORAGE_GRAPH_METHOD};
 expect(await retireStorageHistoryCheckpoint({target:target(),key:legacyKey,expectedHead:null}))
  .toEqual({status:'retired'});

 const resumed=await computeStorageGraphResult(bindings(),scope);
 expect(resumed).toMatchObject({state:'complete'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=1').first('n')).toBe(1);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE method=? AND dependency_digest=?`).bind(STORAGE_GRAPH_METHOD,scope.dependencyDigest).first('n')).toBe(0);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE method=? AND dependency_digest=?`).bind(STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD,scope.dependencyDigest).first<number>('n'))
  .toBe(1);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_execution
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,owner.ownerDigest,day).first('n')).toBe(1);
},60000);

it('binds only the v1 result identity to the v1 acquisition contract',async()=>{
 const authority={sourceId:'synthetic-identity-source',sourceNamespace:'synthetic-identity-source'};
 const ownerDigest='a'.repeat(64),target='2026-09-05',history=modelHistoryWindow(target);
 const dependency=[{observed_day:target}];
 const digest=(source:'v0.2'|'v1'|'v1.1'|'mixed',extra:readonly unknown[],metric:'fits'|'model'='fits')=>
  sha256Hex(canonicalJson([
   authority.sourceId,authority.sourceNamespace,ownerDigest,source,metric,history.day,history.fromDay,
   STORAGE_GRAPH_METHOD,dependency,...(metric==='fits'?[COMMUNITY_ALLOWANCE_FIT_METHOD]:[]),...extra]));
 const computed=(source:'v0.2'|'v1'|'v1.1'|'mixed',metric:'fits'|'model'='fits')=>
  storageGraphDependencyDigest({authority,ownerDigest,source,metric,day:target,dependency});
 // A change to how v1 evidence is acquired retires v1 results only.
 expect(await computed('v1')).toBe(await digest('v1',[V1_QUOTA_ACQUISITION_VERSION]));
 expect(await computed('v1')).not.toBe(await digest('v1',[]));
 expect(await computed('v1.1')).toBe(await digest('v1.1',[V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION]));
 expect(await computed('v0.2')).toBe(await digest('v0.2',[]));
 expect(await computed('mixed')).toBe(await digest('mixed',[]));
});

it('binds the fit gates to the fits identity and leaves model compositions alone',async()=>{
 // The fit gates and the reset-evidence method beneath them decide what a FIT
 // is. `buildResetEvidence` is reached only from the scalar half, so a model
 // composition cannot contain that statistic and must not be retired to
 // recompute it. Folding this into STORAGE_GRAPH_METHOD instead would discard
 // the entire by-model corpus on every gate change — which is the whole reason
 // this discriminator is metric-scoped rather than method-scoped.
 const authority={sourceId:'synthetic-identity-source',sourceNamespace:'synthetic-identity-source'};
 const ownerDigest='b'.repeat(64),target='2026-09-05',history=modelHistoryWindow(target);
 const dependency=[{observed_day:target}];
 const withoutFitMethod=(metric:'fits'|'model')=>sha256Hex(canonicalJson([
  authority.sourceId,authority.sourceNamespace,ownerDigest,'v1.1',metric,history.day,history.fromDay,
  STORAGE_GRAPH_METHOD,dependency,V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION]));
 const computed=(metric:'fits'|'model')=>storageGraphDependencyDigest({authority,ownerDigest,
  source:'v1.1',metric,day:target,dependency});
 // The model identity is exactly what it was before the discriminator existed.
 expect(await computed('model')).toBe(await withoutFitMethod('model'));
 // The fits identity is not, so every fit recomputes under the new gates.
 expect(await computed('fits')).not.toBe(await withoutFitMethod('fits'));
 // And the two metrics never collide.
 expect(await computed('fits')).not.toBe(await computed('model'));
});

it('starts v1 checkpoint work under new keys when the acquisition contract changes',async()=>{
 // Both v1 checkpoint methods carry acquisition state, so both moved with the
 // contract, and both are registered as live so retirement keeps them.
 expect(STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD).toBe(STORAGE_GRAPH_METHOD+':current-fit-checkpoint-2');
 expect(STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD).toBe(STORAGE_GRAPH_METHOD+':checkpoint-store-3');
 expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS).toContain(STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD);
 expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS).toContain(STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD);
 // A head left under either previous method is a different key digest, so no
 // reader can load it and nothing it holds can block work under the new one.
 const previous=[STORAGE_GRAPH_METHOD+':current-fit-checkpoint-1',STORAGE_GRAPH_METHOD+':checkpoint-store-2'];
 for(const method of previous)expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS).not.toContain(method);
 const key=(method:string):StorageHistoryKey=>({sourceId:'synthetic-identity-source',sourceNamespace:'synthetic-identity-source',
  ownerDigest:'a'.repeat(64),day:'2026-09-05',dependencyDigest:'b'.repeat(64),method});
 const digests=await Promise.all([...previous,STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,
  STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD].map(method=>storageHistoryKeyDigest(key(method))));
 expect(new Set(digests).size).toBe(digests.length);
});


it.each([1,100])('routes correction-active owners through a resumable effective graph with %i quota samples per bin',async(samples)=>{
 await fixture(0,false,samples);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 expect(owner).toMatchObject({hasV1:true,hasV12:false,hasEffective:true});
 const scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 expect(scope.source).toBe('effective');
 const baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 const grouped=await finishEffectiveGraph(scope);
 const result=grouped.result;
 expect(result.result).toEqual(baseline.result.result);
 expect(grouped.queries).toBeLessThan(baseline.queries*0.8);
 expect(grouped.targetQueries).toBeLessThan(baseline.targetQueries*0.45);
 expect(grouped.measurements.length).toBeLessThanOrEqual(baseline.measurements.length);
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('ready');
 expect(result.result.composition?.status).toBe('ready');
 expect(await readStorageGraphResult(bindings(),scope)).not.toBeNull();
 expect(await target().prepare("SELECT source_kind FROM analytics_community_graph_results WHERE owner_digest=? AND metric='model'")
   .bind(owner.ownerDigest).first<string>('source_kind')).toBe('effective');
 const replay=await computeStorageGraphResult(bindings(),scope);
 expect(replay).toMatchObject({state:'complete',reused:true});
 await source().prepare("UPDATE storage_owner_revisions SET revision=revision+1 WHERE owner_digest=?").bind(owner.ownerDigest).run();
 await expect(readStorageGraphResult(bindings(),scope)).rejects.toThrow();
},90000);

it.each([false,true])('resumes a different effective successor after losing checkpoint CAS with preparation=%s',async(preparedFold)=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope);
 await clearSyntheticGraph(scope);
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 const pin=scope.pin;
 const advance=(checkpoint?:StorageEffectiveHistoryCheckpoint)=>advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,
  owner:scope.owner,pin,day,metric:'model',nowMs:Date.parse(scope.fixedNow),checkpoint,
  budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
 const first=await advance();
 if(first.status!=='deferred'||!first.checkpoint)throw new Error('synthetic first effective page missing');
 const key=await effectiveKey(scope,preparedFold),digest=await storageHistoryKeyDigest(key);
 const initial=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:first.checkpoint,expectedHead:null});
 if(initial.status!=='saved')throw new Error('synthetic initial checkpoint did not promote');
 const competing=await advance(structuredClone(first.checkpoint));
 if(competing.status!=='deferred'||!competing.checkpoint)throw new Error('synthetic competing effective page missing');
 const winningCheckpoint=structuredClone(competing.checkpoint);
 const observed=observeEffectiveQuotaPages(source());
 let winningHead:string|undefined;
 const race=beforeFirstCheckpointSave(target(),async()=>{
  // The loser has already read four pages. Promote a different, one-page
  // successor immediately before its save reads the head; no Promise timing
  // or duplicate-generation short circuit can turn this into a false pass.
  expect(observed.pages()).toBe(4);
  const winner=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:winningCheckpoint,expectedHead:initial.headDigest});
  if(winner.status!=='saved')throw new Error('synthetic winning checkpoint did not promote');
  winningHead=winner.headDigest;
 });
 expect(await computeStorageGraphResult({...bindings(),source:observed.database,target:race.database},scope,
  {deadlineMs:Date.now()+60_000,maxQueries:950,effectiveCheckpointPages:4,preparedFold}))
  .toEqual({state:'deferred',reason:'checkpoint_advanced'});
 expect(race.saves()).toBe(1);
 expect(winningHead).toMatch(/^[a-f0-9]{64}$/u);
 expect(winningHead).not.toBe(initial.headDigest);
 expect(await loadStorageHistoryCheckpoint({target:target(),key}))
  .toMatchObject({status:'ready',headDigest:winningHead,checkpoint:winningCheckpoint});
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages WHERE key_digest=?').bind(digest).first('n')).toBe(2);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);

 const retry=await computeStorageGraphResult(bindings(),scope,
  {deadlineMs:Date.now()+60_000,maxQueries:250,effectiveCheckpointPages:4,preparedFold});
 expect(retry).toEqual({state:'deferred',reason:'effective_checkpoint'});
 // A fresh invocation must resume the winner, then CAS from that exact head.
 // This proves it did not simply restart at the previous or empty checkpoint.
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages WHERE key_digest=? AND expected_head=?')
  .bind(digest,winningHead!).first('n')).toBe(1);
 expect((await finishEffectiveGraph(scope,4,950,preparedFold)).result.result).toEqual(baseline.result.result);
},60000);

it('reuses newly completed effective days in the same cold invocation without probing after each page',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope);
 expect(baseline.measurements.reduce((sum,row)=>sum+row.quotaPages,0)).toBe(20);
 await clearSyntheticGraph(scope);
 expect(await effectivePreparedDays()).toEqual([]);
 const sql=observePreparedSql(target()),meter=createD1InvocationBudget(950);
 const headProbes=()=>sql.queries.filter(query=>query.includes('WITH heads AS MATERIALIZED')
  &&query.includes('FROM analytics_graph_day_values')).length;
 const quota=observeEffectiveQuotaPages(source(),()=>{
  // The initial missing-window lookup is retained through all five source
  // pages; incomplete cache progress must not cause another metadata scan.
  expect(headProbes()).toBe(1);
 });
 const result=await computeStorageGraphResult({...bindings(),source:meter.wrap(quota.database),
  target:meter.wrap(sql.database)},scope,{maxQueries:950,deadlineMs:Date.now()+60_000,preparedFold:true});
 expect(result.state).toBe('complete');
 if(result.state!=='complete')throw new Error('cold effective invocation did not finish');
 expect(result.result).toEqual(baseline.result.result);
 expect(quota.pages()).toBe(5);
 expect(headProbes()).toBe(2);
 expect(await effectivePreparedDays()).toHaveLength(5);
 expect(meter.queriesUsed).toBeLessThan(baseline.queries);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 console.info('same invocation effective quota reuse',JSON.stringify({baselineStatements:baseline.queries,
  coldStatements:meter.queriesUsed,baselineQuotaPages:20,coldQuotaPages:quota.pages(),headProbes:headProbes()}));
},30000);

it('reuses effective quota days across metrics and adjacent windows with exact cold and warm results',async()=>{
 await fixture(0,false,100);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const model=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const fits=await captureStorageGraphScope(source(),{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 const adjacent=await captureStorageGraphScope(source(),{owner,day:'2026-09-06',metric:'model',sourceId,sourceNamespace:namespace});
 const baselineModel=await finishEffectiveGraph(model),baselineFits=await finishEffectiveGraph(fits),baselineAdjacent=await finishEffectiveGraph(adjacent);
 for(const scope of [model,fits,adjacent])await clearSyntheticGraph(scope);
 const cold=await finishEffectiveGraph(model,4,950,true);
 expect(cold.result.result).toEqual(baselineModel.result.result);
 expect(await target().prepare("SELECT count(*) n FROM analytics_graph_day_values WHERE source_layout='effective'").first('n')).toBe(5);
 const warmFits=await finishEffectiveGraph(fits,4,950,true),warmAdjacent=await finishEffectiveGraph(adjacent,4,950,true);
 expect(warmFits.result.result).toEqual(baselineFits.result.result);
 expect(warmAdjacent.result.result).toEqual(baselineAdjacent.result.result);
 for(const warm of [warmFits,warmAdjacent])expect(warm.measurements.reduce((sum,row)=>sum+row.quotaPages,0)).toBe(0);
 expect(warmFits.queries).toBeLessThan(baselineFits.queries*0.5);
 expect(warmAdjacent.queries).toBeLessThan(baselineAdjacent.queries*0.5);
 expect(cold.queries+warmFits.queries+warmAdjacent.queries)
  .toBeLessThan(baselineModel.queries+baselineFits.queries+baselineAdjacent.queries);
 // Retain aggregate measurements only: synthetic source content never enters
 // a performance receipt. Output is shown only by an explicitly verbose run.
 console.info('effective quota reuse statements',JSON.stringify({baselineModel:baselineModel.measurements,
  baselineFits:baselineFits.measurements,baselineAdjacent:baselineAdjacent.measurements,
  cold:cold.measurements,warmFits:warmFits.measurements,warmAdjacent:warmAdjacent.measurements}));
},180000);

it('resumes an unfinished prepared quota day from the ordinary durable checkpoint',async()=>{
 await fixture(0,false,20);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const baseline=await finishEffectiveGraph(scope);
 await clearSyntheticGraph(scope);
 let now=0;
 const observed=observeEffectiveQuotaPages(source(),page=>{if(page===1)now=9_000;});
 expect(await computeStorageGraphResult({...bindings(),source:observed.database},scope,
  {maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 const saved=await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope,true)});
 expect(saved).toMatchObject({status:'ready',checkpoint:{phase:'acquisition',preparingQuota:{day:'2026-09-01',quotaRowsRead:200}}});
 const resumed=await finishEffectiveGraph(scope,4,950,true);
 expect(resumed.result.result).toEqual(baseline.result.result);
 expect(await target().prepare("SELECT count(*) n FROM analytics_graph_day_values WHERE source_layout='effective'").first('n')).toBe(5);
},90000);

it('adopts an existing effective checkpoint when quota-day preparation is enabled',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope);
 await clearSyntheticGraph(scope);
 const first=await computeStorageGraphResult(bindings(),scope,{maxQueries:250,deadlineMs:Date.now()+60_000});
 expect(first).toEqual({state:'deferred',reason:'effective_checkpoint'});
 const prior=await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)});
 expect(prior.status).toBe('ready');
 expect((await finishEffectiveGraph(scope,4,950,true)).result.result).toEqual(baseline.result.result);
 expect(await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).toEqual(prior);
 expect(await readStorageHistoryCheckpointHead({target:target(),key:await effectiveKey(scope,true)})).toEqual({generation:null,retired:1});
 // Once computation marks the prepared key retired, even the old seven-method
 // cleanup drains its remaining payload pages without knowing the new format.
 for(let attempt=0;attempt<20;attempt++){
  if((await retireStorageGraphPage(target(),sourceId,Date.parse(day+'T12:00:00.000Z'))).state==='idle')break;
 }
 const preparedDigest=await storageHistoryKeyDigest(await effectiveKey(scope,true));
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages WHERE key_digest=?')
  .bind(preparedDigest).first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts WHERE key_digest=?')
  .bind(preparedDigest).first('n')).toBe(0);
},30000);

it('adopts v2 effective work before the original key and leaves both older checkpoints intact',async()=>{
 await fixture(0,false,20);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const baseline=await finishEffectiveGraph(scope);
 await clearSyntheticGraph(scope);
 const early=await effectiveCheckpointAt(scope,'plan',true),later=await effectiveCheckpointAt(scope,'fitability');
 const original=await storeEffectiveCheckpoint(scope,early,false),v2=await storeEffectiveCheckpoint(scope,later,true,2);
 const originalBefore=await readEffectiveCheckpoint(original.key),v2Before=await readEffectiveCheckpoint(v2.key);
 let first:StorageEffectiveHistoryCheckpoint|undefined,now=0;
 const advance=vi.spyOn(effectiveHistory,'advanceStorageEffectiveAnalysis').mockImplementation(input=>{
  first??=structuredClone(input.checkpoint??undefined);return originalEffectiveAdvance(input);
 });
 try{
  const cut=await measuredEffectiveGraphPass(scope,{maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true},
   page=>{if(page===1)now=9_000;});
  expect(cut.result).toEqual({state:'deferred',reason:'effective_checkpoint'});
 }finally{advance.mockRestore();}
 expect(first).toEqual(later);
 const adopted=await readEffectiveCheckpoint(await effectiveKey(scope,true));
 expect(adopted).toMatchObject({status:'ready',checkpoint:{phase:'acquisition',acquisition:{phase:'fitability'},
  preparingQuota:{day:'2026-09-01',quotaRowsRead:200}}});
 expect(await readEffectiveCheckpoint(original.key)).toEqual(originalBefore);
 expect(await readEffectiveCheckpoint(v2.key)).toEqual(v2Before);
 expect((await finishEffectiveGraph(scope,4,950,true)).result.result).toEqual(baseline.result.result);
 expect(await readEffectiveCheckpoint(original.key)).toEqual(originalBefore);
 expect(await readEffectiveCheckpoint(v2.key)).toEqual(v2Before);
},90000);

it.each(['plan','fitability','endpoints'] as const)(
 'backfills missing effective quota days from an in-flight %s scan and warms the adjacent result',async phase=>{
 await fixture(0,false,20);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const adjacent=await captureStorageGraphScope(source(),{owner,day:'2026-09-06',metric:'model',sourceId,sourceNamespace:namespace});
 const oracle=await finishEffectiveGraph(scope),adjacentOracle=await finishEffectiveGraph(adjacent);
 const seed=await effectiveCheckpointAt(scope,phase,phase==='plan');
 const run=async(planOnly:boolean)=>{
  await clearSyntheticGraph(scope);await clearSyntheticGraph(adjacent);await clearEffectiveQuotaDays();
  // Both policies begin with the same durable old-format job and missing
  // cache. The plan case is already 200 rows into the first input day.
  const old=await storeEffectiveCheckpoint(scope,seed,true,2),oldBefore=await readEffectiveCheckpoint(old.key);
  const observed=await observeEffectivePreparation(planOnly,async()=>{
   let now=0;
   const cut=await measuredEffectiveGraphPass(scope,{maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true},
    page=>{if(page===1)now=9_000;});
   expect(cut.result).toEqual({state:'deferred',reason:'effective_checkpoint'});
   const adoptedKey=await effectiveKey(scope,true),adopted=await readEffectiveCheckpoint(adoptedKey);
   expect(adopted.status).toBe('ready');
   if(adopted.status!=='ready'||!('source'in adopted.checkpoint)||adopted.checkpoint.source!=='effective')
    throw new Error('synthetic adopted checkpoint missing');
   if(!planOnly&&phase!=='plan')expect(adopted.checkpoint).toMatchObject({phase:'acquisition',
    acquisition:{phase},preparingQuota:{day:'2026-09-01',quotaRowsRead:200,rows:expect.any(Array)}});
   else expect(adopted.checkpoint).not.toHaveProperty('preparingQuota');
   // A resumed midpoint must not promote its suffix as a complete day.
   expect(await effectivePreparedDays()).toEqual([]);
   const pending=await target().prepare(`SELECT count(*) AS parts,COALESCE(sum(payload_bytes),0) AS bytes
    FROM analytics_history_checkpoint_parts WHERE key_digest=?`)
    .bind(await storageHistoryKeyDigest(adoptedKey)).first<{parts:number;bytes:number}>();
   const completed=await finishEffectiveGraph(scope,4,950,true);
   expect(completed.result.result).toEqual(oracle.result.result);
   expect(await readEffectiveCheckpoint(old.key)).toEqual(oldBefore);
   const days=await effectivePreparedDays();
   if(planOnly)expect(days.map(row=>row.day)).toEqual(phase==='plan'
    ?['2026-09-02','2026-09-03','2026-09-04','2026-09-05']:[]);
   else expect(days).toEqual(Array.from({length:5},(_,index)=>({day:`2026-09-0${index+1}`,quota_rows_read:index===0?241:240})));
   const warm=await finishEffectiveGraph(adjacent,4,950,true);
   expect(warm.result.result).toEqual(adjacentOracle.result.result);
   if(!planOnly)expect(warm.measurements.reduce((sum,row)=>sum+row.quotaPages,0)).toBe(0);
   return {current:totalEffectiveMeasurements([cut.measurement,...completed.measurements]),
    adjacent:totalEffectiveMeasurements(warm.measurements),pending};
  });
  return {...observed.value,stores:observed.stores};
 };
 const planOnly=await run(true),allPhases=await run(false);
 expect(planOnly.stores.every(store=>store.phase==='plan')).toBe(true);
 if(phase==='plan'){
  expect(allPhases.stores.some(store=>store.day==='2026-09-01'&&store.phase==='clusters')).toBe(true);
  expect(allPhases.stores.some(store=>store.day==='2026-09-01'&&store.phase==='plan')).toBe(false);
 }else{
  expect(allPhases.stores.some(store=>store.day==='2026-09-01'&&store.phase===phase&&store.quotaRowsRead===241)).toBe(true);
  expect(allPhases.pending!.bytes).toBeGreaterThan(planOnly.pending!.bytes);
 }
 expect(planOnly.adjacent.quotaPages).toBeGreaterThan(0);
 expect(allPhases.adjacent.source+allPhases.adjacent.target).toBeLessThan(planOnly.adjacent.source+planOnly.adjacent.target);
 // Include source, target and every attempted checkpoint part/byte. Preparing
 // during the last scan can cost more for this result; the next window is a
 // separate measured benefit rather than an assumed current-job speedup.
 console.info('in-flight effective quota preparation',JSON.stringify({phase,
  planOnly:{current:planOnly.current,adjacent:planOnly.adjacent,pending:planOnly.pending},
  allPhases:{current:allPhases.current,adjacent:allPhases.adjacent,pending:allPhases.pending}}));
},180000);

it('falls back to the effective pager when a prepared middle day is missing or migration support is absent',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,4,950,true);
 await clearSyntheticGraph(scope);
 await target().prepare("DELETE FROM analytics_graph_day_values WHERE source_layout='effective' AND day='2026-09-03'").run();
 const missing=await finishEffectiveGraph(scope,4,950,true);
 expect(missing.result.result).toEqual(baseline.result.result);
 expect(missing.measurements.reduce((sum,row)=>sum+row.quotaPages,0)).toBeGreaterThan(0);
 await clearSyntheticGraph(scope);
 await target().prepare('DROP TRIGGER analytics_graph_day_effective_quota_contract').run();
 const unsupported=await finishEffectiveGraph(scope,4,950,true);
 expect(unsupported.result.result).toEqual(baseline.result.result);
 expect(unsupported.measurements.reduce((sum,row)=>sum+row.quotaPages,0)).toBeGreaterThan(0);
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('ready');
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope,true)})).status).toBe('absent');
},60000);

it('promotes a partial effective group at its work deadline and resumes the identical result',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 let now=0;
 const observed=observeEffectiveQuotaPages(source(),page=>{if(page===2)now=9_000;});
 const cut=await computeStorageGraphResult({...bindings(),source:observed.database},scope,{deadlineMs:20_000,now:()=>now});
 expect(cut).toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(observed.pages()).toBe(2);
 const saved=await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)});
 expect(saved.status).toBe('ready');
 if(saved.status!=='ready'||!('source'in saved.checkpoint)||saved.checkpoint.source!=='effective')throw new Error('effective checkpoint missing');
 expect(saved.checkpoint.effectiveCursor).toMatchObject({phase:'plan',day:'2026-09-03',ordinal:25});
 expect((await finishEffectiveGraph(scope)).result.result).toEqual(baseline.result.result);
},30000);

it('makes progress with a small effective query budget and resumes a checkpoint written by the one-page mode',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 const meter=createD1InvocationBudget(250);
 const cut=await computeStorageGraphResult({...bindings(),source:meter.wrap(source()),target:meter.wrap(target())},scope,
  {maxQueries:250,deadlineMs:Date.now()+60_000,effectiveCheckpointPages:1});
 expect(cut).toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(meter.queriesUsed).toBeLessThanOrEqual(250);
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('ready');
 const resumed=await finishEffectiveGraph(scope,4,250);
 expect(resumed.measurements.length).toBeGreaterThan(1);
 expect(resumed.result.result).toEqual(baseline.result.result);
},30000);

it('reproduces the exact effective successor after only some of its checkpoint parts were staged',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 let checkpoint:StorageEffectiveHistoryCheckpoint|undefined;
 for(let page=0;page<4;page++){
  const next=await advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,owner:scope.owner,
   pin:scope.pin,day,metric:'model',nowMs:Date.parse(scope.fixedNow),checkpoint,
   budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
  if(next.status!=='deferred'||!next.checkpoint)throw new Error('effective group finished unexpectedly');
  checkpoint=next.checkpoint;
 }
 const staged=await saveStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope),checkpoint:checkpoint!,expectedHead:null,maxWrites:3});
 expect(staged.status).toBe('staging');
 if(staged.status!=='staging')throw new Error('effective group did not stage partially');
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('absent');
 expect((await finishEffectiveGraph(scope)).result.result).toEqual(baseline.result.result);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=?')
  .bind(await storageHistoryKeyDigest(await effectiveKey(scope)),staged.generation).first<number>('n')).toBe(staged.totalParts);
},30000);

it('retries a many-part later-phase pending day after its completed prefix has warmed the cache',async()=>{
 await fixture(0,false,20);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const baseline=await finishEffectiveGraph(scope);
 await clearSyntheticGraph(scope);
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 const seed=await effectiveCheckpointAt(scope,'fitability');
 // Retain a valid large analytical frame while the optional day preparation
 // is only 200 rows into its first day. Redundant anchors remain inside the
 // same settled plan era and preserve its first/last boundaries, so they
 // enlarge persistence without changing the analytical output.
 const anchor=seed.acquisition.plan.observations[0]!;
 seed.acquisition.plan.observations=[...seed.acquisition.plan.observations,
  ...Array.from({length:30_000},(_,index)=>({...anchor,observedAtMs:anchor.observedAtMs+index+1}))]
  .sort((left,right)=>left.observedAtMs-right.observedAtMs);
 const preparation=await createStorageEffectiveQuotaPreparation({source:source(),target:target(),sourceId,
  sourceNamespace:namespace,owner:scope.owner,remainingQueries:()=>950,deadlineMs:Date.now()+60_000,now:Date.now});
 const pending=await advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,owner:scope.owner,
  pin:scope.pin,day,metric:'model',nowMs:Date.parse(scope.fixedNow),checkpoint:seed,preparedQuota:preparation,
  budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
 if(pending.status!=='deferred'||pending.checkpoint?.phase!=='acquisition')throw new Error('later pending day missing');
 expect(pending.checkpoint).toMatchObject({acquisition:{phase:'fitability'},
  preparingQuota:{day:'2026-09-01',quotaRowsRead:200}});
 const saved=await storeEffectiveCheckpoint(scope,pending.checkpoint),keyDigest=await storageHistoryKeyDigest(saved.key);
 const before=await readEffectiveCheckpoint(saved.key);
 expect(before.status==='ready'&&before.partCount).toBeGreaterThan(30);
 let now=0;
 const interruptedWrites=observeEffectiveCheckpointWrites(target(),()=>{now=20_000;});
 const interruptedSource=observeEffectiveQuotaPages(source()),meter=createD1InvocationBudget(950);
 expect(await computeStorageGraphResult({...bindings(),source:meter.wrap(interruptedSource.database),
  target:meter.wrap(interruptedWrites.database)},scope,
  {maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 expect(interruptedSource.pages()).toBe(4);
 expect(interruptedWrites.counts().checkpointPartInserts).toBe(30);
 expect(await readEffectiveCheckpoint(saved.key)).toEqual(before);
 const staged=await target().prepare(`SELECT generation,part_count FROM analytics_history_checkpoint_stages
  WHERE key_digest=? AND generation!=?`).bind(keyDigest,saved.head).first<{generation:string;part_count:number}>();
 expect(staged?.part_count).toBeGreaterThan(30);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_parts
  WHERE key_digest=? AND generation=?`).bind(keyDigest,staged!.generation).first<number>('n')).toBe(30);
 expect(await effectivePreparedDays()).toEqual([
  {day:'2026-09-01',quota_rows_read:241},{day:'2026-09-02',quota_rows_read:240}]);
 // These exact cache days were absent when the uncommitted successor began.
 // Reloading may skip their new preparation, but must reproduce the same
 // analytical state and the same remaining third-day prefix.
 now=0;
 const retriedWrites=observeEffectiveCheckpointWrites(target(),()=>{now=20_000;});
 const retriedSource=observeEffectiveQuotaPages(source()),retryMeter=createD1InvocationBudget(950);
 expect(await computeStorageGraphResult({...bindings(),source:retryMeter.wrap(retriedSource.database),
  target:retryMeter.wrap(retriedWrites.database)},scope,
  {maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(retryMeter.queriesUsed).toBeLessThanOrEqual(950);
 expect(retriedSource.pages()).toBe(4);
 expect(retriedWrites.counts().checkpointPartInserts).toBe(staged!.part_count-30);
 const promoted=await readEffectiveCheckpoint(saved.key);
 expect(promoted).toMatchObject({status:'ready',headDigest:staged!.generation,
  checkpoint:{acquisition:{phase:'fitability'},preparingQuota:{day:'2026-09-03',quotaRowsRead:200}}});
 expect((await finishEffectiveGraph(scope,4,950,true)).result.result).toEqual(baseline.result.result);
},120000);

it('resumes an effective four-page group whose committed response was lost',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 const observed=observeEffectiveQuotaPages(source()),lost=loseFirstCheckpointBatchResponse(target());
 await expect(computeStorageGraphResult({...bindings(),source:observed.database,target:lost.database},scope,{deadlineMs:Date.now()+60_000}))
  .rejects.toMatchObject({stage:'graph_checkpoint_save',reason:'application'});
 expect(lost.losses()).toBe(1);expect(observed.pages()).toBe(4);
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('ready');
 expect((await finishEffectiveGraph(scope)).result.result).toEqual(baseline.result.result);
},30000);

it('saves a deterministic large successor after a stale prepared-day fallback cuts the page group',async()=>{
 const scope=await effectiveFixture();
 await finishEffectiveGraph(scope,4,950,true);
 await clearSyntheticGraph(scope);
 const heads=await readGraphDayEffectiveQuotaHeads({target:target(),sourceId,sourceNamespace:namespace,
  ownerDigest:scope.owner.ownerDigest!,fromDay:'2026-09-01',throughDay:day});
 const last=heads?.find(head=>head.key.day===day);
 if(!last)throw new Error('synthetic prepared day missing');
 const projection=await readGraphDayProjection({target:target(),key:last.key,cursor:last.cursor,maxParts:32});
 if(projection.status!=='ready')throw new Error('synthetic prepared day not ready');
 // Retain a well-framed stale candidate so coverage is present and only the
 // final source dependency check discovers the miss.
 await target().prepare('DELETE FROM analytics_graph_day_values WHERE value_key=?').bind(projection.valueKey).run();
 expect((await writeGraphDayProjection({target:target(),key:{...last.key,manifestDigest:'e'.repeat(64)},
  projection:projection.projection,effectiveQuota:projection.effectiveQuota})).status).toBe('stored');
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 const first=await advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,owner:scope.owner,
  pin:scope.pin,day,metric:'model',nowMs:Date.parse(scope.fixedNow),
  budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
 if(first.status!=='deferred'||first.checkpoint?.phase!=='acquisition')throw new Error('effective acquisition missing');
 first.checkpoint.acquisition.plan.observations=Array.from({length:30_000},(_,index)=>({
  contextKey:'openai_codex|codex',observedAtMs:Date.parse(first.checkpoint!.identity.observedAtCutoff)+index,
  planType:'pro',planVariant:'unknown',continuityId:null,conflicted:false,accountScopeId:null,planBasis:null}));
 const key=await effectiveKey(scope,true);
 let saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:first.checkpoint,expectedHead:null});
 while(saved.status==='staging')saved=await saveStorageHistoryCheckpoint({target:target(),key,
  checkpoint:first.checkpoint,expectedHead:null,cursor:saved.cursor});
 expect(saved.totalParts).toBeGreaterThan(30);
 let now=0;
 const observed=observeEffectiveQuotaPages(source(),()=>{now=9_000;});
 expect(await computeStorageGraphResult({...bindings(),source:observed.database},scope,
  {maxQueries:300,deadlineMs:20_000,now:()=>now,preparedFold:true}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(observed.pages()).toBe(1);
 let successor=await loadStorageHistoryCheckpoint({target:target(),key});
 while(successor.status==='deferred')successor=await loadStorageHistoryCheckpoint({target:target(),key,cursor:successor.cursor});
 expect(successor.status).toBe('ready');
 if(successor.status!=='ready')throw new Error('large successor missing');
 expect(successor.headDigest).not.toBe(saved.headDigest);
 expect(successor.checkpoint).toMatchObject({effectiveCursor:{ordinal:25}});
},30000);

it('keeps the old effective head when a deadline cuts a group whose checkpoint needs multiple batches',async()=>{
 const scope=await effectiveFixture();
 if(!('source'in scope.pin))throw new Error('effective source pin missing');
 const first=await advanceStorageEffectiveAnalysis({source:source(),sourceNamespace:namespace,owner:scope.owner,
  pin:scope.pin,day,metric:'model',nowMs:Date.parse(scope.fixedNow),
  budget:{remainingQueries:950,deadlineMs:Date.now()+60_000}});
 if(first.status!=='deferred'||first.checkpoint?.phase!=='acquisition')throw new Error('effective acquisition missing');
 // A valid, large synthetic retained acquisition exercises the save boundary
 // without importing thousands of additional source chunks in this test.
 first.checkpoint.acquisition.plan.observations=Array.from({length:30_000},(_,index)=>({
  contextKey:'openai_codex|codex',observedAtMs:Date.parse(first.checkpoint!.identity.observedAtCutoff)+index,
  planType:'pro',planVariant:'unknown',continuityId:null,conflicted:false,accountScopeId:null,planBasis:null}));
 const key=await effectiveKey(scope);
 let saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:first.checkpoint,expectedHead:null});
 while(saved.status==='staging')saved=await saveStorageHistoryCheckpoint({target:target(),key,
  checkpoint:first.checkpoint,expectedHead:null,cursor:saved.cursor});
 expect(saved.totalParts).toBeGreaterThan(30);
 let now=0;
 const observed=observeEffectiveQuotaPages(source(),page=>{if(page===2)now=9_000;});
 expect(await computeStorageGraphResult({...bindings(),source:observed.database},scope,{deadlineMs:20_000,now:()=>now}))
  .toEqual({state:'deferred',reason:'effective_checkpoint'});
 expect(observed.pages()).toBe(2);
 expect(await target().prepare('SELECT generation FROM analytics_history_checkpoint_heads WHERE key_digest=?')
  .bind(await storageHistoryKeyDigest(key)).first<string>('generation')).toBe(saved.headDigest);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages WHERE key_digest=?')
  .bind(await storageHistoryKeyDigest(key)).first<number>('n')).toBe(1);
 const resumed=await computeStorageGraphResult(bindings(),scope,{maxQueries:950,deadlineMs:Date.now()+60_000});
 if(resumed.state==='deferred')expect(resumed.reason).toBe('effective_checkpoint');
 expect(await target().prepare('SELECT generation FROM analytics_history_checkpoint_heads WHERE key_digest=?')
  .bind(await storageHistoryKeyDigest(key)).first<string>('generation')).not.toBe(saved.headDigest);
},30000);

it('retries failed effective reads from the last promoted group without double counting',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 const observed=observeEffectiveQuotaPages(source(),page=>{if(page===6)throw new Error('synthetic page unavailable');});
 await expect(computeStorageGraphResult({...bindings(),source:observed.database},scope,{deadlineMs:Date.now()+60_000})).rejects.toThrow();
 const saved=await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)});
 expect(saved.status).toBe('ready');
 if(saved.status!=='ready'||!('source'in saved.checkpoint)||saved.checkpoint.source!=='effective')throw new Error('effective checkpoint missing');
 // Five pages finished the plan phase and were promoted; the failed first
 // cluster page must be read again from that phase boundary.
 expect(saved.checkpoint.phase).toBe('acquisition');
 if(saved.checkpoint.phase!=='acquisition')throw new Error('effective acquisition missing');
 expect(saved.checkpoint.acquisition.phase).toBe('clusters');
 expect((await finishEffectiveGraph(scope)).result.result).toEqual(baseline.result.result);
},30000);

it.each(['revision','authority_epoch'] as const)('refuses effective work when owner %s changes inside a page group',async(field)=>{
 const scope=await effectiveFixture();
 const observed=observeEffectiveQuotaPages(source(),async page=>{if(page===2){
  const sql=field==='revision'?'UPDATE storage_owner_revisions SET revision=revision+1 WHERE owner_digest=?'
   :'UPDATE storage_owner_revisions SET authority_epoch=authority_epoch+1 WHERE owner_digest=?';
  await source().prepare(sql).bind(scope.owner.ownerDigest).run();
 }});
 await expect(computeStorageGraphResult({...bindings(),source:observed.database},scope,{deadlineMs:Date.now()+60_000})).rejects.toThrow();
 expect(observed.pages()).toBe(2);
 expect((await loadStorageHistoryCheckpoint({target:target(),key:await effectiveKey(scope)})).status).toBe('absent');
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first<number>('n')).toBe(0);
},30000);

it('converges concurrent effective group writers on the same analytical result',async()=>{
 const scope=await effectiveFixture(),baseline=await finishEffectiveGraph(scope,1);
 await clearSyntheticGraph(scope);
 const attempts=await Promise.all([1,2].map(()=>computeStorageGraphResult(bindings(),scope,{deadlineMs:Date.now()+60_000})));
 for(const result of attempts){
  if(result.state==='complete')expect(result.result).toEqual(baseline.result.result);
  else expect(result.reason).toBe('effective_checkpoint');
 }
 expect((await finishEffectiveGraph(scope)).result.result).toEqual(baseline.result.result);
},30000);

it('folds mixed v1 and v1.1 evidence once through resumable model and fit graphs',async()=>{
 await fixture(0,true);
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const before=(await readStorageCommunityOwnerPage(source())).find(row=>row.hasV1)!;
 expect(before).toMatchObject({hasV1:true,hasV11:false,hasEffective:true});

 // The fixture's v1 records were produced from complete v1.1-shaped source
 // records before the legacy projection. Rehydrate every admitted v1 row as
 // its v1.1 variant: domain activation requires the successor to preserve
 // each winning legacy occurrence, not merely one overlap sample.
 const metadata=(await source().prepare(`SELECT storage_row_id,stream,observed_day
   FROM typed_telemetry_compatibility_records
   WHERE source_namespace=? AND participant_id=? AND format='v1' AND stream IN ('usage','quota')
   ORDER BY observed_day,observed_at,occurrence_id`).bind(namespace,before.participantId)
   .all<{storage_row_id:number;stream:'usage'|'quota';observed_day:string}>()).results;
 const decoded=[];
 for(let offset=0;offset<metadata.length;offset+=200){
   decoded.push(...await readTypedTelemetryRowsByStorageIds(source(),{sourceNamespace:namespace,
     participantId:before.participantId,storageRowIds:metadata.slice(offset,offset+200).map(row=>row.storage_row_id)}));
 }
 if(decoded.length!==metadata.length||decoded.length<1)throw new Error('mixed graph fixture lost typed v1 rows');
 const byDay=new Map<string,{quota:TelemetryV11Record[];usage:TelemetryV11Record[]}>();
 for(const row of decoded){
   if(row.stream!=='usage'&&row.stream!=='quota')continue;
   const value={...JSON.parse(row.record_json) as Record<string,unknown>};
   if(typeof value.schemaVersion!=='string'||!value.schemaVersion.endsWith('-v1.0'))throw new Error('mixed graph fixture has an unexpected v1 schema');
   value.schemaVersion=`${value.schemaVersion.slice(0,-4)}v1.1`;
   const planType=row.stream==='quota'&&typeof value.planType==='string'?value.planType:'unknown';
   value.accountPlanAttribution={accountBasis:'unavailable',accountTrackId:null,
     planBasis:planType==='unknown'?'unavailable':'same_source_occurrence',planType,planEraId:null};
   const group=byDay.get(row.observed_day)??{quota:[],usage:[]};
   group[row.stream].push(parseTelemetryV11Record(row.stream,value));byDay.set(row.observed_day,group);
 }
 const duplicateSource=decoded.find(row=>row.stream==='usage'&&row.observed_day===day);
 if(!duplicateSource)throw new Error('mixed graph fixture lost its target-day v1 usage row');
 const duplicateRecord=JSON.parse(duplicateSource.record_json) as {eventId:string;eventTime:string};

 // A separately granted device proves that the effective path can combine
 // concurrent client families without raising a new owner-wide v1 floor.
 const v11Device=await createV11DeviceFixture(source(),{participantId:before.participantId,grant:true});
 const predecessor=await createTelemetryV11DomainPredecessor(source(),v11Device);
 const stageTypedDay=async(prepared:Awaited<ReturnType<typeof makeV11Day>>)=>{
   const candidate=await registerTelemetryV11DayManifest(source(),v11Device,prepared.manifest);
   for(const chunk of prepared.chunks){
     const raw=canonicalJson({syntheticTestEnvelope:chunk.chunkDigest,manifestDigest:chunk.manifestDigest,nonce:crypto.randomUUID()});
     const envelopeDigest=await sha256Hex(raw);
     const principal=await authenticateDevice(source(),v11Device.authorization);
     const upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,new TextEncoder().encode(raw).byteLength);
     const claimed=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,{
       envelopeDigest,bodyBytes:new TextEncoder().encode(raw).byteLength,contentType:'application/json'});
     await persistTypedV11StagedChunk(source(),principal,chunk,{sourceNamespace:namespace,
       chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/mixed-graph/${crypto.randomUUID()}`,
       envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId});
   }
   return candidate;
 };
 const days:string[]=[];
 for(let cursor=predecessor.fromDay;;){
   days.push(cursor);
   if(cursor===predecessor.throughDay)break;
   cursor=new Date(Date.parse(`${cursor}T00:00:00.000Z`)+86_400_000).toISOString().slice(0,10);
 }
 const candidates=[];
 for(const candidateDay of days){
   const prepared=await makeV11Day(candidateDay,byDay.get(candidateDay)??{});
   candidates.push(await stageTypedDay(prepared));
 }
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:predecessor.fromDay,throughDay:predecessor.throughDay,
   predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
     legacyFingerprint:predecessor.legacyFingerprint},
   days:candidates.sort((left,right)=>left.day.localeCompare(right.day)).map(candidate=>({
     day:candidate.day,manifestId:candidate.manifestId,manifestDigest:candidate.manifestDigest,
   })),manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
 const proofs=await source().prepare(`SELECT old.occurrence_id AS old_occurrence,old.canonical_sha256 AS old_digest,
     new.legacy_occurrence_id AS new_occurrence,lower(hex(new.legacy_digest)) AS new_digest
   FROM typed_telemetry_compatibility_records old
   JOIN typed_v1_record_admissions old_admission ON old_admission.typed_record_id=old.storage_row_id
   JOIN telemetry_v11_day_manifests m ON m.participant_id=old.participant_id AND m.device_id=?
     AND m.chunk_day=old.observed_day
   JOIN typed_v11_record_admissions new ON new.manifest_id=m.id AND new.stream=old.stream
     AND new.legacy_occurrence_id=old.occurrence_id
   WHERE old.source_namespace=? AND old.participant_id=? AND old.format='v1' AND old.stream IN ('usage','quota')`)
   .bind(v11Device.deviceId,namespace,before.participantId).all<{old_occurrence:string;old_digest:string;new_occurrence:string;new_digest:string}>();
 const digestMismatches=proofs.results.filter(row=>row.old_digest!==row.new_digest);
 expect({sourceRows:metadata.length,proofRows:proofs.results.length,digestMismatches:digestMismatches.slice(0,3)})
   .toEqual({sourceRows:metadata.length,proofRows:metadata.length,digestMismatches:[]});
 await activateTelemetryV11Domain(source(),v11Device,manifest);
 for(let attempt=0;attempt<30;attempt++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;

 const owner=(await readStorageCommunityOwnerPage(source())).find(row=>row.participantId===before.participantId)!;
 expect(owner).toMatchObject({hasV1:true,hasV11:true,hasEffective:true});
 const inputDays=[...byDay.keys()].sort();
 const dependencies=await effectiveHistory.createEffectiveHistoryDayDependencyReader(source(),owner,namespace,
  inputDays,{includeSessions:true});
 expect(dependencies).toBeDefined();
 let mixedDependency=false;
 for(const inputDay of inputDays){
  const dependency=await effectiveHistory.effectiveHistoryDependency(source(),owner,namespace,inputDay,inputDay,
   {includeSessions:true});
  mixedDependency ||= dependency.v1.length>0&&dependency.v11.length>0;
  expect(await dependencies!.readDigest(inputDay)).toBe(await sha256Hex(canonicalJson(dependency)));
 }
 expect(mixedDependency).toBe(true);
 const usage=await readEffectiveUsageOwnerDayPage(source(),{sourceNamespace:namespace,
   ownerDigest:owner.ownerDigest!,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
   day,stream:'usage',limit:200});
 const overlap=usage.rows.find(row=>row.occurrenceId===duplicateRecord.eventId);
 expect(overlap).toMatchObject({status:'compatible',sourceCount:2,sourceFormats:['v1','v11']});
 expect(new Set(usage.rows.map(row=>row.occurrenceId)).size).toBe(usage.rows.length);
 const last=usage.rows.at(-1)!;
 expect(last.eventTime).not.toBeNull();
 const noProgress=await readEffectiveUsageOwnerDayPage(source(),{sourceNamespace:namespace,
   ownerDigest:owner.ownerDigest!,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
   day,stream:'usage',limit:200,after:{observedAtMs:Date.parse(last.eventTime!),occurrenceId:last.occurrenceId}});
 expect(noProgress.rows).toHaveLength(0);
 expect(noProgress.next).toBeNull();

 const compute=async(metric:'model'|'fits')=>{
   const scope=await captureStorageGraphScope(source(),{owner,day,metric,sourceId,sourceNamespace:namespace});
   let result:Awaited<ReturnType<typeof computeStorageGraphResult>>|undefined;
   for(let attempt=0;attempt<16;attempt++){
     result=await computeStorageGraphResult(bindings(),scope,{maxQueries:900,deadlineMs:Date.now()+60_000});
     if(result.state==='complete'){
       const replay=await computeStorageGraphResult(bindings(),scope);
       expect(replay).toMatchObject({state:'complete',reused:true});
       return {result,scope};
     }
     expect(result.reason).toBe('effective_checkpoint');
   }
   throw new Error(`mixed ${metric} graph did not finish`);
 };
 const model=await compute('model');
 expect(model.result.state).toBe('complete');
 if(model.result.state!=='complete')throw new Error('mixed model graph did not complete');
 expect(model.result.result.composition?.status).toBe('ready');
 if(model.result.result.composition?.status!=='ready')throw new Error('mixed model composition not ready');
 expect(model.result.result.composition.usageEventCount).toBe(metadata.filter(row=>row.stream==='usage').length);
 expect(model.result.result.composition.quotaRowCount).toBeGreaterThan(0);
 const fits=await compute('fits');
 expect(fits.result.state).toBe('complete');
 if(fits.result.state!=='complete')throw new Error('mixed fit graph did not complete');
 expect(fits.result.result.fits).not.toBeNull();
 // Disconnect changes future upload authority, not accepted analytical history.
 await revokeParticipantDevice(source(), before.participantId, v11Device.deviceId);
 const retainedOwner=(await readStorageCommunityOwnerPage(source())).find(row=>row.participantId===before.participantId)!;
 const retained=await readEffectiveUsageOwnerDayPage(source(),{sourceNamespace:namespace,
   ownerDigest:retainedOwner.ownerDigest!,ownerRevision:retainedOwner.ownerRevision,authorityEpoch:retainedOwner.authorityEpoch,
   day,stream:'usage',limit:200});
 expect(retained.rows.find(row=>row.occurrenceId===duplicateRecord.eventId))
   .toMatchObject({status:'compatible',sourceCount:2,sourceFormats:['v1','v11']});
},180000);
