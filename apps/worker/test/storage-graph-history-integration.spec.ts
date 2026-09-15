import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {pricedModelHistoryUsage,MODEL_HISTORY_TEST_CAPACITIES} from './helpers/model-history';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {parseTelemetryV1Chunk,type TelemetryV1Record} from '../src/telemetry-v1';
import {initializeTypedV1Admission,insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-repository';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {captureStorageGraphScope,computeStorageGraphResult,storageGraphDependencyDigest} from '../src/storage-community-graph';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';

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
function observeDirectAttempts(database:D1Database,failFirst:boolean){let attempts=0;
 const statement=(inner:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args),sql);
  if(key==='all'&&sql.includes('typed_plan_input AS MATERIALIZED'))return async(...args:unknown[])=>{
   attempts++;if(failFirst&&attempts===1)throw new Error('synthetic direct read unavailable');
   return Reflect.apply(Reflect.get(value,key) as Function,value,args);};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
 return {database:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql),sql);
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),attempts:()=>attempts};}
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
},60000);
