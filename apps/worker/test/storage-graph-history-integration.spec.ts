import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {pricedModelHistoryUsage,MODEL_HISTORY_TEST_CAPACITIES} from './helpers/model-history';
import {createV1QuotaAcquisitionCheckpoint} from '../src/quota-analysis-v1-reader';
import {MODEL_HISTORY_METHOD_VERSION} from '../src/quota-analysis-v1';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {parseTelemetryV1Chunk,type TelemetryV1Record} from '../src/telemetry-v1';
import {initializeTypedV1Admission,insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-repository';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics,runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {captureStorageGraphScope,computeStorageGraphResult,storageGraphDependencyDigest,
 STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD,
 STORAGE_GRAPH_METHOD} from '../src/storage-community-graph';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceStorageCommunityGraphWork} from '../src/storage-community-graph-work';
import {retireStorageHistoryCheckpoint,saveStorageHistoryCheckpoint,type StorageHistoryKey} from '../src/storage-history-checkpoint';
import type {StorageV1HistoryCheckpoint} from '../src/storage-v1-history';

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
async function fixture(){
 const owner=await createV11DeviceFixture(source()),groups=new Map<string,TelemetryV1Record[]>();
 const base=Date.parse('2026-09-01T00:00:00Z'),at=(h:number)=>new Date(base+h*3600000).toISOString();
 const push=(stream:string,time:string,record:TelemetryV1Record)=>{const key=`${stream}:${time.slice(0,10)}`;
  const group=groups.get(key)??[];group.push(record);groups.set(key,group);};
 let percent=0;
 const quota=(time:string)=>push('quota',time,{schemaVersion:'quota-observation-v1.0',observationId:`synthetic:${time}`,
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
  quota(at(bin*2+1));
 }
 for(const [key,records] of groups){
  const digest=await sha256Hex(`synthetic:${key}`),principal=await authenticateDevice(source(),owner.authorization);
  const auth=await createDeviceUploadAuthorization(source(),principal,digest,200);
  const claim=await claimDeviceUploadAuthorization(source(),`Upload ${auth.uploadAuthorization}`,{envelopeDigest:digest,bodyBytes:200,contentType:'application/json'});
  const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${key}:0`,chunkRevision:1,
   chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-history',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',
    fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  await insertTypedTelemetryV1Chunk(source(),{chunkRowId:`chunk:${crypto.randomUUID()}`,participantId:owner.participantId,deviceId:owner.deviceId,
   chunk,envelopeDigest:digest,r2Key:`synthetic/${key}`,deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null},namespace);
 }
 for(let n=0;n<30;n++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
 return (await readStorageCommunityOwnerPage(source()))[0]!;
}

it('advances current v1 fits through a durable bounded acquisition before semantic result promotion',async()=>{
 const owner=await fixture(),observed=observePreparedSql(source());
 const scope=await captureStorageGraphScope(observed.database,{owner,day,metric:'fits',sourceId,sourceNamespace:namespace});
 const first=await computeStorageGraphResult({...bindings(),source:observed.database},scope);
 expect(first).toEqual({state:'deferred',reason:'current_fit_checkpoint'});
 expect(observed.queries.some(sql=>sql.includes('typed_quota_input AS MATERIALIZED'))).toBe(false);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND method=?`)
  .bind(sourceId,owner.ownerDigest,day,scope.dependencyDigest,STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD).first('n')).toBe(1);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_results
  WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`).bind(sourceId,owner.ownerDigest,day).first('n')).toBe(0);

 let completed:Awaited<ReturnType<typeof computeStorageGraphResult>>|undefined;
 for(let attempt=0;attempt<4;attempt++){
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
 expect(concurrent.every(result=>result.state==='deferred')).toBe(true);
 expect(concurrent.flatMap(result=>result.state==='deferred'&&result.failure?[result.failure]:[]))
  .toEqual([{phase:'graph_history_direct_read',reason:'application'}]);
 expect(attempts.attempts()).toBe(1);
 const executionDigest=await target().prepare(`SELECT dependency_digest FROM analytics_community_graph_execution
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,owner.ownerDigest,day).first<string>('dependency_digest');
 expect(executionDigest).toMatch(/^[a-f0-9]{64}$/);expect(executionDigest).not.toBe(scope.dependencyDigest);
 let deferred=0,completed=false;
 for(let i=0;i<24;i++){
  const meter=createD1InvocationBudget(900);
  const result=await computeStorageGraphResult({...bindings(),source:meter.wrap(attempts.database),target:meter.wrap(target())},scope);
  expect(meter.queriesUsed).toBeLessThanOrEqual(900);
  if(result.state==='deferred'){deferred++;continue;}
  expect(result.result.composition).toEqual(expected);completed=true;break;
 }
 expect(deferred).toBeGreaterThan(0);expect(completed).toBe(true);
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

it('rethrows an unavailable checkpoint failure when the exact head is unchanged',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 await expect(computeStorageGraphResult({...bindings(),target:unavailableCheckpointOwner(target())},scope))
  .rejects.toMatchObject({stage:'graph_checkpoint_save',reason:'checkpoint_unavailable'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
});

it('defers an unavailable checkpoint after a newer exact head is promoted',async()=>{
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
 expect(result).toEqual({state:'deferred',reason:'historical_checkpoint',failure:{phase:'graph_checkpoint_save',reason:'checkpoint_unavailable'}});
 expect(promotedHead).toMatch(/^[a-f0-9]{64}$/);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(0);
});

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
 expect(resumed).toMatchObject({state:'deferred',reason:'historical_checkpoint'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads WHERE retired=1').first('n')).toBe(1);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE method=? AND dependency_digest=?`).bind(STORAGE_GRAPH_METHOD,scope.dependencyDigest).first('n')).toBe(0);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_history_checkpoint_stages
  WHERE method=? AND dependency_digest=?`).bind(STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD,scope.dependencyDigest).first<number>('n'))
  .toBeGreaterThan(0);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_execution
  WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId,owner.ownerDigest,day).first('n')).toBe(1);
},60000);
