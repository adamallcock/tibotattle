import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import {createD1InvocationBudget,D1_BUDGET_ATTACHMENT,type D1BudgetAttachment,type D1InvocationBudget} from '../src/d1-invocation-budget';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {parseTelemetryV1Chunk} from '../src/telemetry-v1';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-compatibility';
import {insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {advanceStorageAnalytics,initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {advanceStorageCommunityDaily} from '../src/storage-community-daily';
import {readStorageCommunityOwnerPage,type StorageCommunityOwner} from '../src/storage-community-authority';
import {effectiveHistoryDependency} from '../src/storage-effective-history';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {advanceCacheRetentionDayLane,createCacheRetentionDaySourceBuild,createCacheRetentionEffectiveDayBuild,
 readCacheRetentionCarryDays,readCacheRetentionDay,CacheRetentionDeferredError,
 CACHE_RETENTION_EFFECTIVE_DEVICE_ID,CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,type CacheRetentionDayCandidate} from '../src/cache-retention-day';
import type {CacheRetentionDayAggregate} from '../src/cache-retention-values';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;
 TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const sourceDb=()=>b.USAGE_MONITOR_DB,targetDb=()=>b.STORAGE_ANALYTICS_DB,referenceDb=()=>b.STORAGE_INGESTION_A;
const sourceId='synthetic-native-cache-meter',sourceNamespace=sourceId;
type Device=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Owner=StorageCommunityOwner&{ownerDigest:string};
type Context={source:D1Database;target:D1Database;meter:D1InvocationBudget};
type InvocationReceipt={statements:number;source:number;target:number;limit:number;
 rowsRead:number;rowsWritten:number;failedStatements:number;measurementFailures:number};
let caseIndex=0;const caseReceipts:InvocationReceipt[][]=[];
const caseProfiles:ReturnType<typeof createAnalyticsProfile>[]=[];
function caseProfile(){const profile=createAnalyticsProfile();caseProfiles.push(profile);return profile;}
beforeEach(()=>{caseIndex++;caseReceipts.length=0;caseProfiles.length=0;});
afterEach(()=>{
 const values=caseProfiles.map(profile=>{const costs=Object.values(profile.costs);return {
  statements:costs.reduce((n,v)=>n+v.statements,0),
  source:Object.entries(profile.costs).filter(([key])=>key.startsWith('proof.source.')).reduce((n,[,v])=>n+v.statements,0),
  target:Object.entries(profile.costs).filter(([key])=>key.startsWith('proof.target.')).reduce((n,[,v])=>n+v.statements,0),
  rowsRead:costs.reduce((n,v)=>n+v.rowsRead,0),rowsWritten:costs.reduce((n,v)=>n+v.rowsWritten,0),
  failedStatements:costs.reduce((n,v)=>n+v.failedStatements,0),measurementFailures:profile.measurementFailures};});
 console.info(JSON.stringify({event:'synthetic_cache_actual_meter_case',caseIndex,
  costScope:'entire_test_native_setup_reference_lane_and_probes',schemaInitializerCostMeasured:false,
  outerMeterProfileSeries:values.length,completedInvocationReceipts:caseReceipts.flat().length,statements:values.reduce((n,v)=>n+v.statements,0),
  sourceStatements:values.reduce((n,v)=>n+v.source,0),targetStatements:values.reduce((n,v)=>n+v.target,0),
  rowsRead:values.reduce((n,v)=>n+v.rowsRead,0),rowsWritten:values.reduce((n,v)=>n+v.rowsWritten,0),
  failedStatements:values.reduce((n,v)=>n+v.failedStatements,0),measurementFailures:values.reduce((n,v)=>n+v.measurementFailures,0),
  maximumStatementsPerInvocation:Math.max(0,...values.map(v=>v.statements))}));
});
function measured(){
 const receipts:InvocationReceipt[]=[];caseReceipts.push(receipts);
 async function run<T>(work:(context:Context)=>Promise<T>,destination=targetDb(),limit=950){
  const profile=caseProfile(),meter=createD1InvocationBudget(limit);
  const source=meter.wrap(profileAnalyticsDatabase(sourceDb(),'source',profile,()=> 'proof'));
  const target=meter.wrap(profileAnalyticsDatabase(destination,'target',profile,()=> 'proof'));
  try{return await work({source,target,meter});}
  finally{
   const values=Object.values(profile.costs),statements=values.reduce((n,v)=>n+v.statements,0);
   expect(statements).toBe(meter.queriesUsed);expect(statements).toBeLessThanOrEqual(limit);
   expect(profile.measurementFailures).toBe(0);
   receipts.push({statements,source:Object.entries(profile.costs).filter(([key])=>key.startsWith('proof.source.')).reduce((n,[,v])=>n+v.statements,0),
    target:Object.entries(profile.costs).filter(([key])=>key.startsWith('proof.target.')).reduce((n,[,v])=>n+v.statements,0),limit,
    rowsRead:values.reduce((n,v)=>n+v.rowsRead,0),rowsWritten:values.reduce((n,v)=>n+v.rowsWritten,0),
    failedStatements:values.reduce((n,v)=>n+v.failedStatements,0),measurementFailures:profile.measurementFailures});
  }
 }
 return {run,receipts};
}
async function accept(source:D1Database,device:Device,day:string,sequence=0){
 const records=[0,1].map(index=>{
  const raw=v11UsageRecord(day,'a',{eventId:`event:v2:${(sequence*10+index+1).toString(16).padStart(64,'0')}`,
   eventTime:`${day}T12:05:${index===0?'00':'30'}.000Z`});
  const row=telemetryV11LegacyProjection('usage',raw);if(!row)throw new Error('SYNTHETIC_CACHE_METER_PROJECTION');
  return JSON.parse(row.canonicalRecord);
 });
 const digest=await sha256Hex(canonicalTelemetryV11Json(records)),principal=await authenticateDevice(source,device.authorization);
 const grant=await createDeviceUploadAuthorization(source,principal,digest,1000);
 const claim=await claimDeviceUploadAuthorization(source,`Upload ${grant.uploadAuthorization}`,
  {envelopeDigest:digest,bodyBytes:1000,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`usage:${day}:${sequence}`,
  chunkRevision:1,chunkDigest:digest,parserVersion:'synthetic-native-cache-meter-v1',
  consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
   privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
 const result=await insertTypedTelemetryV1Chunk(source,{participantId:device.participantId,deviceId:device.deviceId,chunk,
  chunkRowId:`chunk:${crypto.randomUUID()}`,envelopeDigest:digest,r2Key:`synthetic/cache-meter/${crypto.randomUUID()}`,
  deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null},sourceNamespace);
 expect(result.acceptedRecords).toBe(2);expect(result.replay).toBe(false);
}
async function fixture(count=1){
 await reset();await initializeSharedAnalyticsCorpusDatabases(sourceDb(),targetDb(),b,sourceId,sourceNamespace);
 await applyD1Migrations(referenceDb(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:sourceDb(),target:referenceDb(),sourceId,sourceNamespace});
 const m=measured(),run=m.run,device=await run(({source})=>createV11DeviceFixture(source));
 const first=Date.parse(new Date(Date.now()-10*86400000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=Array.from({length:count},(_,i)=>new Date(first+i*86400000).toISOString().slice(0,10));
 for(const [i,day] of days.entries())await run(({source})=>accept(source,device,day,i));
 for(let i=0;i<16;i++){if((await run(({source})=>drainCommunityPublicSourceBootstrap(source))).completed)break;
  if(i===15)throw new Error('SYNTHETIC_CACHE_METER_BOOTSTRAP');}
 for(const destination of [targetDb(),referenceDb()]){
  let complete=false;for(let i=0;i<64;i++)if((await run(({source,target})=>advanceStorageAnalytics({source,target,sourceId,sourceNamespace}),destination)).state==='idle'){complete=true;break;}
  expect(complete).toBe(true);
 }
 const owners=await run(({source})=>readStorageCommunityOwnerPage(source));expect(owners).toHaveLength(1);
 expect(owners[0]!.ownerDigest).toBeTruthy();const owner=owners[0]! as Owner;
 for(const day of days){let published=false;for(let i=0;i<8;i++){
  const result=await run(({source,target})=>advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,day,sharedFeatures:false}));
  if(result.state==='published'||result.state==='unchanged'){published=true;break;}
 }expect(published).toBe(true);}
 const inputs=await Promise.all(days.map(async day=>{
  const digest=await run(async({source})=>sha256Hex(canonicalJson(await effectiveHistoryDependency(source,owner,sourceNamespace,day,day,{includeSessions:true}))));
  const key:CacheRetentionDayCandidate={sourceId,sourceLayout:'effective',sourceNamespace,ownerDigest:owner.ownerDigest,
   deviceId:CACHE_RETENTION_EFFECTIVE_DEVICE_ID,manifestId:CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,manifestDigest:digest,day};
  return {key,carry:await run(({target})=>readCacheRetentionCarryDays(target,key))};
 }));
 return {...m,owner,device,days,inputs};
}
type StatementHook=(sql:string,bindings:readonly unknown[],perform:()=>Promise<unknown>)=>Promise<unknown>;
// Transparent fault boundary: original SQL/bindings/results are untouched.
function observe(db:D1Database,hook:StatementHook):D1Database{
 return new Proxy(db,{get(database,key){if(key==='prepare')return(sql:string)=>{
  const wrap=(stmt:D1PreparedStatement,bindings:readonly unknown[]):D1PreparedStatement=>new Proxy(stmt,{get(statement,method){
   if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args),args);
   if(['first','all','run','raw'].includes(String(method)))return(...args:unknown[])=>hook(sql,bindings,async()=>{
    const call=Reflect.get(statement,method);return Reflect.apply(call,statement,args);
   });
   const value=Reflect.get(statement,method);return typeof value==='function'?value.bind(statement):value;
  }});return wrap(database.prepare(sql),[]);
 };const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
}
const options=(source:D1Database,target:D1Database,day:string,sourceQueries=300)=>({target,sourceId,
 build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures:false}),remainingQueries:650,sourceQueries,
 sharedRemainingQueries:()=>950,deadlineMs:Date.now()+60000,maxDays:12,maxWrites:48,fromDay:day});
async function exactReference(f:Awaited<ReturnType<typeof fixture>>,index=0){
 const input=f.inputs[index]!;let value:CacheRetentionDayAggregate|undefined;
 for(let pass=0;pass<16&&!value;pass++)await f.run(async({source,target,meter})=>{
  try{value=await createCacheRetentionEffectiveDayBuild({source,target,sourceNamespace,ownerDigest:f.owner.ownerDigest,
   ownerRevision:f.owner.ownerRevision,authorityEpoch:f.owner.authorityEpoch})(input.key,input.carry,
    {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60000});}
  catch(error){if(!(error instanceof CacheRetentionDeferredError))throw error;}
 },referenceDb());expect(value).toBeDefined();return value!;
}
async function ready(f:Awaited<ReturnType<typeof fixture>>,index=0){
 const input=f.inputs[index]!;for(let pass=0;pass<16;pass++){
  const found=await f.run(({target})=>readCacheRetentionDay({target,...input}));if(found.status==='ready')return found.aggregate;
  await f.run(({source,target})=>advanceCacheRetentionDayLane(options(source,target,f.days[index]!)));
 }throw new Error('SYNTHETIC_CACHE_METER_COMPLETION_BOUND');
}
it('uses unchanged ordinary factory arguments for multiple native pages and exact physical accounting',async()=>{
 const f=await fixture(),reference=await exactReference(f);
 const result=await f.run(({source,target})=>advanceCacheRetentionDayLane(options(source,target,f.days[0]!)));
 expect(result.actualBudget?.accounting).toBe('build-target-total-v1');
 expect(result.actualBudget!.effectivePageAttempts).toBeGreaterThan(1);
 expect(result.actualBudget!.effectivePageAttempts).toBeLessThanOrEqual(16);
 expect(result.actualBudget!.chargedBuildStatements).toBeLessThanOrEqual(300);
 expect(result.actualBudget!.chargedTargetStatements).toBeLessThanOrEqual(650);
 const receipt=f.receipts.at(-1)!;expect(result.actualBudget!.chargedTotalStatements).toBe(receipt.statements);
 expect(result.actualBudget!.chargedTargetStatements).toBe(receipt.target);
 expect(result.actualBudget!.chargedBuildStatements).toBeGreaterThanOrEqual(receipt.source);
 expect(await ready(f)).toEqual(reference);
 console.info(JSON.stringify({event:'synthetic_cache_actual_meter',budget:result.actualBudget,physical:receipt}));
},120000);
it('shares its finite16 native page attempts across two genuine dates without resetting the pass',async()=>{
 const f=await fixture(2);
 // A separate cap-control supplies larger build headroom so the16-page stop,
 // rather than the original300 build allocation, is the independently tested bound.
 const result=await f.run(({source,target})=>advanceCacheRetentionDayLane({...options(source,target,f.days[0]!,950),remainingQueries:950}));
 expect(result.actualBudget?.effectivePageAttempts).toBe(16);expect(result.reason).toBe('query_budget');
 expect(result.built).toBe(1);
 const rows=await f.run(async({target})=>(await target.prepare('SELECT day,progress_revision FROM analytics_cache_retention_day_progress WHERE source_id=? ORDER BY day').bind(sourceId).all()).results);
 expect(rows).toHaveLength(1);expect(rows[0]!.day).toBe(f.days[1]);
},120000);
it('does not trust a high resetting callback or hide an enclosing-meter rejection',async()=>{
 const f=await fixture();const result=await f.run(({source,target})=>advanceCacheRetentionDayLane(options(source,target,f.days[0]!)),targetDb(),4);
 expect(result.reason).toBe('query_budget');expect(result.built).toBe(0);expect(result.skipped).toBe(0);
 expect(f.receipts.at(-1)!.statements).toBe(4);
 expect(result.actualBudget!.chargedTotalStatements).toBe(5); // one rejected inner credit, no fifth physical SQL
 expect(result.actualBudget!.chargedBuildStatements).toBe(1);
},120000);
it('retains ordinary conservative behavior for carried target attachments and rejects a mismatched target',async()=>{
 const f=await fixture();await f.run(async({source,target})=>{
  const make=(db:D1Database):D1BudgetAttachment=>({withBudget(wrap){return make(wrap(db));}});
  const attached=new Proxy(source,{get(db,key){if(key===D1_BUDGET_ATTACHMENT)return make(target);
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  const result=await advanceCacheRetentionDayLane(options(attached,target,f.days[0]!));
  expect(result.actualBudget).toBeUndefined();expect(result.sourceQueriesUsed).toBeLessThanOrEqual(300);
  const other=observe(target,(_sql,_bindings,perform)=>perform());
  await expect(advanceCacheRetentionDayLane({...options(source,target,f.days[0]!),target:other})).rejects.toThrow();
 });
},120000);
it('keeps a genuinely committed first checkpoint after response loss and resumes exact native output',async()=>{
 const f=await fixture(),reference=await exactReference(f);let lost=false;
 const result=await f.run(({source,target})=>{
  const observed=observe(target,async(sql,_bindings,perform)=>{
   const value=await perform();if(!lost&&sql.startsWith('INSERT INTO analytics_cache_retention_day_progress')){lost=true;throw new Error('SYNTHETIC_CACHE_CHECKPOINT_RESPONSE_LOST');}return value;
  });return advanceCacheRetentionDayLane(options(source,observed,f.days[0]!));
 });expect(lost).toBe(true);expect(result.reason).toBe('query_budget');expect(result.built).toBe(0);
 const revision=await f.run(({target})=>target.prepare('SELECT progress_revision FROM analytics_cache_retention_day_progress WHERE source_id=?').bind(sourceId).first('progress_revision'));
 expect(revision).toBe(1);expect(await ready(f)).toEqual(reference);
},120000);
it('preserves the prior checkpoint when a concurrent genuine serialized CAS wins',async()=>{
 const f=await fixture(),reference=await exactReference(f);let raced=false;
 const result=await f.run(({source,target})=>{
  const observed=observe(target,async(sql,bindings,perform)=>{
   if(!raced&&sql.startsWith('UPDATE analytics_cache_retention_day_progress SET')){
    raced=true;await f.run(({target:concurrent})=>concurrent.prepare(sql).bind(...bindings).run());
   }return perform();
  });return advanceCacheRetentionDayLane(options(source,observed,f.days[0]!));
 });expect(raced).toBe(true);expect(result.reason).toBe('query_budget');expect(await ready(f)).toEqual(reference);
},120000);
it('performs the final source fence on an empty lookback and refuses real native owner advancement',async()=>{
 const f=await fixture();let finals=0,admitted=false;
 const result=await f.run(({source,target})=>{
  const observed=observe(source,async(sql,_bindings,perform)=>{
   if(sql.includes('correction.state AS correction_state')&&sql.includes('JOIN storage_owner_revisions')&&!sql.includes('AS v1_namespace')){
    finals++;if(finals===2){admitted=true;const later=new Date(Date.parse(f.days[0]!) +3*86400000).toISOString().slice(0,10);
     await f.run(({source:native})=>accept(native,f.device,later,50));}
   }return perform();
  });return advanceCacheRetentionDayLane(options(observed,target,f.days[0]!));
 });expect(admitted).toBe(true);expect(finals).toBe(2);expect(result.built).toBe(0);expect(result.skipped).toBe(1);
 const rows=await f.run(async({target})=>(await target.prepare('SELECT progress_revision FROM analytics_cache_retention_day_progress WHERE source_id=?').bind(sourceId).all()).results);
 expect(rows).toEqual([{progress_revision:1}]);
 expect(await f.run(({target})=>target.prepare('SELECT count(*) n FROM analytics_cache_retention_day_marks WHERE source_id=?').bind(sourceId).first('n'))).toBe(0);
},120000);
it('accounts actual shared-feature release after a committed claim response is lost',async()=>{
 const f=await fixture();let lost=false;
 const result=await f.run(({source,target})=>{
  const observed=observe(target,async(sql,_bindings,perform)=>{
   const value=await perform();if(!lost&&sql.includes('UPDATE analytics_shared_feature_days SET')&&sql.includes('claim_token=?,claim_expires_ms=?')){
    lost=true;throw new Error('SYNTHETIC_CACHE_FEATURE_CLAIM_RESPONSE_LOST');
   }return value;
  });return advanceCacheRetentionDayLane({...options(source,observed,f.days[0]!),
   build:createCacheRetentionDaySourceBuild({source,target:observed,sourceNamespace,sharedFeatures:true})});
 });expect(lost).toBe(true);expect(result.built).toBe(0);
 const physical=f.receipts.at(-1)!;expect(result.actualBudget!.chargedTargetStatements).toBe(physical.target);
 expect(result.actualBudget!.chargedTotalStatements).toBe(physical.statements);
 expect(result.actualBudget!.chargedBuildStatements).toBeLessThanOrEqual(300);
 expect(await f.run(({target})=>target.prepare('SELECT count(*) n FROM analytics_shared_feature_days WHERE source_id=? AND claim_token IS NOT NULL').bind(sourceId).first('n'))).toBe(0);
},120000);
it('releases page checkpoint reservations when the real deadline ends after a complete read',async()=>{
 const f=await fixture();let clock=Date.now(),ended=false;const deadline=clock+60000;
 const result=await f.run(async({source,target,meter})=>{
  const observed=observe(source,async(sql,_bindings,perform)=>{
   const value=await perform();if(!ended&&sql.includes('correction.state AS correction_state')&&sql.includes('JOIN storage_owner_revisions')&&!sql.includes('AS v1_namespace')){
    ended=true;clock=deadline;
   }return value;
  });const response=await advanceCacheRetentionDayLane({...options(observed,target,f.days[0]!),now:()=>clock,deadlineMs:deadline,
   build:createCacheRetentionDaySourceBuild({source:observed,target,sourceNamespace,sharedFeatures:false,now:()=>clock})});
  // Probe the actual original lineage after close; no unspent reservation remains.
  expect(meter.remainingQueries).toBe(950-meter.queriesUsed);
  const remaining=meter.remainingQueries;await target.prepare('SELECT 1').first();expect(meter.remainingQueries).toBe(remaining-1);
  return response;
 });expect(ended).toBe(true);expect(result.reason).toBe('deadline');expect(result.built).toBe(0);
 expect(await f.run(({target})=>target.prepare('SELECT count(*) n FROM analytics_cache_retention_day_progress WHERE source_id=?').bind(sourceId).first('n'))).toBe(0);
},120000);

it('releases the first checkpoint reservation when the second actual outer credit is unavailable',async()=>{
 const f=await fixture();let held=false;
 const result=await f.run(async({source,target,meter})=>{
  const observed=observe(target,async(sql,_bindings,perform)=>{
   const value=await perform();
   if(!held&&sql.includes('FROM analytics_cache_retention_day_progress WHERE progress_key=?')){
    held=true;expect(value).toBeNull();
    // This is a real enclosing phase reserve, not an advisory callback. Only
    // one unreserved credit remains when the builder requests two final holds.
    meter.reserveQueries=meter.remainingQueries-1;
   }return value;
  });
  const response=await advanceCacheRetentionDayLane(options(source,observed,f.days[0]!));
  expect(meter.remainingQueries).toBe(1);
  const reserved=meter.reserveQueries;expect(reserved).toBeGreaterThan(0);
  expect(meter.queriesUsed+reserved+meter.remainingQueries).toBe(950);
  meter.reserveQueries=0;expect(meter.remainingQueries).toBe(950-meter.queriesUsed);
  return response;
 });expect(held).toBe(true);expect(result.reason).toBe('query_budget');expect(result.built).toBe(0);
 expect(result.actualBudget?.effectivePageAttempts).toBe(1);
 expect(await f.run(({target})=>target.prepare('SELECT count(*) n FROM analytics_cache_retention_day_progress WHERE source_id=?').bind(sourceId).first('n'))).toBe(0);
},120000);
it('does not activate actual mode for a wrapper builder or null carried-binding marker',async()=>{
 const f=await fixture();await f.run(async({source,target})=>{
  const native=createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures:false});
  const wrapped:typeof native=(candidate,carry,budget)=>native(candidate,carry,budget);
  const result=await advanceCacheRetentionDayLane({...options(source,target,f.days[0]!),build:wrapped});
  expect(result.actualBudget).toBeUndefined();expect(result.sourceQueriesUsed).toBeLessThanOrEqual(300);
  const marked=new Proxy(source,{get(db,key){if(key===D1_BUDGET_ATTACHMENT)return null;
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  const fallback=await advanceCacheRetentionDayLane(options(marked,target,f.days[0]!));
  expect(fallback.actualBudget).toBeUndefined();expect(fallback.sourceQueriesUsed).toBeLessThanOrEqual(300);
 });
},120000);
it('gives repeated invocations of one registered factory separate finite actual budgets',async()=>{
 const f=await fixture(2);const profile=caseProfile(),outer=createD1InvocationBudget(950);
 // The captured handles deliberately remain identical for both invocations;
 // each lane adds its own bounded real context instead of mutating the factory.
 const source=outer.wrap(profileAnalyticsDatabase(sourceDb(),'source',profile,()=> 'proof'));
 const target=outer.wrap(profileAnalyticsDatabase(targetDb(),'target',profile,()=> 'proof'));
 const opts=options(source,target,f.days[0]!);
 const first=await advanceCacheRetentionDayLane(opts);
 const firstStatements=Object.values(profile.costs).reduce((n,v)=>n+v.statements,0);
 expect(firstStatements).toBe(outer.queriesUsed);
 const second=await advanceCacheRetentionDayLane(opts);
 const secondStatements=Object.values(profile.costs).reduce((n,v)=>n+v.statements,0)-firstStatements;
 expect(first.actualBudget?.chargedTotalStatements).toBe(firstStatements);
 expect(second.actualBudget?.chargedTotalStatements).toBe(secondStatements);
 expect(first.actualBudget!.effectivePageAttempts).toBeGreaterThan(0);
 expect(second.actualBudget!.effectivePageAttempts).toBeGreaterThan(0);
 for(const value of [first,second]){
  expect(value.actualBudget!.chargedBuildStatements).toBeLessThanOrEqual(300);
  expect(value.actualBudget!.chargedTargetStatements).toBeLessThanOrEqual(650);
  expect(value.actualBudget!.chargedTotalStatements).toBeLessThanOrEqual(950);
  expect(value.actualBudget!.effectivePageAttempts).toBeLessThanOrEqual(16);
 }
 expect(firstStatements+secondStatements).toBe(outer.queriesUsed);
 expect(profile.measurementFailures).toBe(0);expect(await ready(f)).toEqual(await exactReference(f));
},120000);

it('keeps concurrent uses of one registered factory in separate measured pass contexts',async()=>{
 const f=await fixture(2),profile=caseProfile(),outer=createD1InvocationBudget(950);
 const source=outer.wrap(profileAnalyticsDatabase(sourceDb(),'source',profile,()=> 'proof'));
 const target=outer.wrap(profileAnalyticsDatabase(targetDb(),'target',profile,()=> 'proof'));
 const opts=options(source,target,f.days[0]!);
 const results=await Promise.all([advanceCacheRetentionDayLane(opts),advanceCacheRetentionDayLane(opts)]);
 expect(results.every(value=>value.actualBudget?.accounting==='build-target-total-v1')).toBe(true);
 const statements=Object.values(profile.costs).reduce((n,value)=>n+value.statements,0);
 expect(statements).toBe(outer.queriesUsed);expect(statements).toBeLessThanOrEqual(950);
 expect(results.reduce((n,value)=>n+value.actualBudget!.chargedTotalStatements,0)).toBe(statements);
 for(const result of results){
  expect(result.actualBudget!.chargedBuildStatements).toBeLessThanOrEqual(300);
  expect(result.actualBudget!.chargedTargetStatements).toBeLessThanOrEqual(650);
  expect(result.actualBudget!.effectivePageAttempts).toBeLessThanOrEqual(16);
 }
 expect(profile.measurementFailures).toBe(0);expect(await ready(f)).toEqual(await exactReference(f));
},120000);
