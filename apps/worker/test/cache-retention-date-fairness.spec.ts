// OFF-TREE DRAFT. Not run. Imports resolve only when separately authorized in Worker test/.
import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget,D1InvocationBudgetExceededError,type D1InvocationBudget} from '../src/d1-invocation-budget';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {parseTelemetryV1Chunk,type TelemetryV1UsageEvent,type TelemetryV1Record} from '../src/telemetry-v1';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-compatibility';
import {insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {readStorageCommunityOwnerPage,captureStorageCommunityAuthority,type StorageCommunityOwner} from '../src/storage-community-authority';
import {advanceStorageCommunityDaily,readPublishedStorageCommunityDaily} from '../src/storage-community-daily';
import {readEffectiveTelemetryOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {effectiveHistoryDependency} from '../src/storage-effective-history';
import {createV11DailyProjectionValues,foldV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {readSharedAnalyticsFeatureDay} from '../src/storage-analytics-shared-features';
import {advanceCacheRetentionDayLane,createCacheRetentionDaySourceBuild,createCacheRetentionEffectiveDayBuild,
 cacheRetentionLookbackDays,readCacheRetentionCarryDays,readCacheRetentionDay,CacheRetentionDeferredError,
 CACHE_RETENTION_EFFECTIVE_DEVICE_ID,CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
 type CacheRetentionDayCandidate,type CacheRetentionCarryDay} from '../src/cache-retention-day';
import {CACHE_RETENTION_WORKER_QUERIES,CACHE_RETENTION_WORKER_TARGET_QUERIES,CACHE_RETENTION_WORKER_DAYS,
 CACHE_RETENTION_WORKER_WRITES} from '../src/cache-retention-day-worker';
import {CacheRetentionRefusedError,type CacheRetentionDayAggregate} from '../src/cache-retention-values';

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;
 TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const b=env as Bindings,source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,
 reference=()=>b.STORAGE_INGESTION_A;
const sourceId='synthetic-cache-date-rotation',sourceNamespace=sourceId;
type Owner=StorageCommunityOwner&{ownerDigest:string};
type Device=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Context={source:D1Database;target:D1Database;meter:D1InvocationBudget};
const phases=['admission','delivery','daily','cache','reference','proof'] as const;
type Phase=typeof phases[number];

// All native calls/probes below share one real950 meter per invocation. The
// standard local migration initializer is separate setup, never a cost claim.
function measurement(){
 const profile=createAnalyticsProfile(),calls:Record<string,number>={};
 async function run<T>(phase:Phase,work:(context:Context)=>Promise<T>,destination=target()):Promise<T>{
  const meter=createD1InvocationBudget(CACHE_RETENTION_WORKER_QUERIES);
  const start=Object.values(profile.costs).reduce((n,value)=>n+value.statements,0);
  const input={source:meter.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>phase)),
   target:meter.wrap(profileAnalyticsDatabase(destination,'target',profile,()=>phase)),meter};
  try{return await work(input);}finally{
   const count=Object.values(profile.costs).reduce((n,value)=>n+value.statements,0)-start;
   expect(count).toBe(meter.queriesUsed);expect(count).toBeLessThanOrEqual(950);
   expect(profile.measurementFailures).toBe(0);calls[phase]=(calls[phase]??0)+1;
   profile.maximumStatementsPerInvocation=Math.max(profile.maximumStatementsPerInvocation,count);
  }
 }
 return {run,receipt:()=>({calls,maximumStatementsPerInvocation:profile.maximumStatementsPerInvocation,
  statements:Object.values(profile.costs).reduce((n,value)=>n+value.statements,0),
  rowsRead:Object.values(profile.costs).reduce((n,value)=>n+value.rowsRead,0),
  rowsWritten:Object.values(profile.costs).reduce((n,value)=>n+value.rowsWritten,0),
  failedStatements:Object.values(profile.costs).reduce((n,value)=>n+value.failedStatements,0),
  measurementFailures:profile.measurementFailures,schemaInitializerCostMeasured:false})};
}
const occurrence=(owner:number,day:number,index:number)=>`event:v2:${(owner*1000+day*10+index+1).toString(16).padStart(64,'0')}`;
function usage(day:string,eventId:string,index=0):TelemetryV1UsageEvent{
 const original=v11UsageRecord(day,'a',{eventId,eventTime:`${day}T12:05:${index===0?'00':'30'}.000Z`});
 const projected=telemetryV11LegacyProjection('usage',original);
 if(!projected)throw new Error('SYNTHETIC_NATIVE_CARRY_PROJECTION');
 return JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
}
async function accept(db:D1Database,device:Device,day:string,records:readonly TelemetryV1Record[],stream:'usage'|'quota'='usage',sequence=0){
 const envelopeDigest=await sha256Hex(canonicalTelemetryV11Json(records));
 const principal=await authenticateDevice(db,device.authorization);
 const grant=await createDeviceUploadAuthorization(db,principal,envelopeDigest,1000);
 const claim=await claimDeviceUploadAuthorization(db,`Upload ${grant.uploadAuthorization}`,
  {envelopeDigest,bodyBytes:1000,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${stream}:${day}:${sequence}`,
  chunkRevision:1,chunkDigest:envelopeDigest,parserVersion:'synthetic-native-carry-v1',
  consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
   privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
 const accepted=await insertTypedTelemetryV1Chunk(db,{participantId:device.participantId,deviceId:device.deviceId,chunk,
  chunkRowId:`chunk:${crypto.randomUUID()}`,envelopeDigest,r2Key:`synthetic/carry/${crypto.randomUUID()}`,
  deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null},sourceNamespace);
 expect(accepted.acceptedRecords).toBe(records.length);expect(accepted.replay).toBe(false);
}
function exactOwners(rows:StorageCommunityOwner[],expectedCount=2):Owner[]{
 expect(rows).toHaveLength(expectedCount);expect(rows.every(owner=>owner.ownerDigest&&owner.hasEffective)).toBe(true);
 return rows as Owner[];
}
async function deliver(run:ReturnType<typeof measurement>['run'],destination:D1Database,expectedOwners=2){
 for(let attempt=0;attempt<128;attempt++){
  const result=await run('delivery',({source,target})=>advanceStorageAnalytics({source,target,sourceId,sourceNamespace}),destination);
  if(result.state==='idle'){
   await run('proof',async({source,target})=>{
    const accepted=await source.prepare('SELECT COALESCE(MAX(sequence),0) n FROM storage_ingestion_changes').first<number>('n');
    const delivered=await target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first<number>('sequence');
    expect(delivered).toBe(accepted);
    const rows=(await target.prepare("SELECT owner_digest,revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND state='active' ORDER BY owner_digest")
     .bind(sourceId).all<{owner_digest:string;revision:number;authority_epoch:number}>()).results;
    const owners=exactOwners(await readStorageCommunityOwnerPage(source),expectedOwners);
    expect(rows).toEqual(owners.map(owner=>({owner_digest:owner.ownerDigest,revision:owner.ownerRevision,
     authority_epoch:owner.authorityEpoch})).sort((a,c)=>a.owner_digest.localeCompare(c.owner_digest)));
   },destination);return;
  }
 }
 throw new Error('SYNTHETIC_NATIVE_CARRY_DELIVERY_BOUND');
}
async function sourceInputs(run:ReturnType<typeof measurement>['run'],owner:Owner,day:string){
 const digests:CacheRetentionCarryDay[]=[];
 for(const value of [...cacheRetentionLookbackDays(day),day])digests.push(await run('reference',async({source})=>{
  const dependency=await effectiveHistoryDependency(source,owner,sourceNamespace,value,value,{includeSessions:true});
  const present=dependency.v1.length+dependency.v11.length+dependency.v12.length+dependency.corrections.length+dependency.occurrenceLinks.length>0;
  return {day:value,manifestDigest:present?await sha256Hex(canonicalJson(dependency)):''};
 },reference()));
 const own=digests.pop()!;expect(own.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
 const key:CacheRetentionDayCandidate={sourceId,sourceLayout:'effective',sourceNamespace,ownerDigest:owner.ownerDigest,
  deviceId:CACHE_RETENTION_EFFECTIVE_DEVICE_ID,manifestId:CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,manifestDigest:own.manifestDigest,day};
 return {key,carry:digests};
}

async function seedConflict(run:ReturnType<typeof measurement>['run'],days:readonly string[],conflictPairs:readonly (readonly [number,number])[]=[[0,1]]){
  const devices:Device[]=[];
  for(let owner=0;owner<2;owner++)devices.push(await run('admission',({source})=>createV11DeviceFixture(source)));
  for(const [owner,device] of devices.entries())for(const [index,day] of days.entries())
   await run('admission',({source})=>accept(source,device,day,[usage(day,occurrence(owner,index,0)),usage(day,occurrence(owner,index,1),1)]));
  for(let attempt=0;attempt<16;attempt++){
   if((await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source))).completed)break;
   if(attempt===15)throw new Error('SYNTHETIC_NATIVE_CARRY_BOOTSTRAP_BOUND');
  }
  const ordered=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)));
  const conflict=ordered[0]!,healthyId=ordered[1]!.participantId;
  const conflictIndex=devices.findIndex(device=>device.participantId===conflict.participantId);
  expect(conflictIndex).toBeGreaterThanOrEqual(0);
  const otherDevice=await run('admission',({source})=>createV11DeviceFixture(source,{participantId:conflict.participantId}));
  for(const [oldDay,movedDay] of conflictPairs)
   await run('admission',({source})=>accept(source,otherDevice,days[movedDay]!,[usage(days[movedDay]!,occurrence(conflictIndex,oldDay,0))]));
  const owners=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)));
  expect(owners[0]!.participantId).toBe(conflict.participantId);
  const bad=owners[0]!,healthy=owners.find(owner=>owner.participantId===healthyId)!;
  for(const [oldDay,movedDay] of conflictPairs)for(const index of [oldDay,movedDay])await run('proof',async({source})=>{
   const day=days[index]!;
   const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace,ownerDigest:bad.ownerDigest,
    ownerRevision:bad.ownerRevision,authorityEpoch:bad.authorityEpoch,day,stream:'usage',limit:200});
   const row=page.rows.find(value=>value.occurrenceId===occurrence(conflictIndex,oldDay,0));
   expect(row?.status).toBe('conflict');expect(row?.eventTimeConflict).toBe(true);expect(row?.recordJson).toBeNull();
  });
  await deliver(run,target());
  return {owners,bad,healthy};
}


const cases=[
 {name:'reaches the same owner valid offset9 after genuine early carry conflict',days:10,pairs:[[0,1]] as const,passes:16},
 {name:'passes thirteen genuinely unavailable dates beyond maxDays12 without narrowing fromDay',days:18,pairs:[[0,1],[8,9]] as const,passes:32},
] as const;
for(const testCase of cases)it(testCase.name,async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
 const measured=measurement(),run=measured.run;
 const start=Date.parse(new Date(Date.now()-(testCase.days+2)*86400000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=Array.from({length:testCase.days},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10));
 const blocked=new Set<number>(testCase.pairs.flat());
 const passes:{built:number;skipped:number;chargedBuild:number;chargedTarget:number;chargedTotal:number}[]=[];
 let expectedHash:string|null=null,actualHash:string|null=null;
 try{
  const {owners,bad,healthy}=await seedConflict(run,days,testCase.pairs);await deliver(run,reference());
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  // Genuine owner folds only. There is no manufactured complete daily row/carry digest.
  for(const [index,day] of days.entries()){
   let published=false;
   for(let attempt=0;attempt<8;attempt++){
    const result=await run('daily',({source,target})=>advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,
     day,nowMs:start+testCase.days*86400000+43200000,maxOwners:4,sharedFeatures:false}));
    if(result.state==='published'||result.state==='unchanged'){published=true;break;}
   }
   expect(published).toBe(!blocked.has(index));
  }
  const later=await sourceInputs(run,bad,days.at(-1)!);
  expect(later.carry.map(row=>row.day)).toEqual(days.slice(-8,-1));
  expect(later.carry.every(row=>!blocked.has(days.indexOf(row.day)))).toBe(true);
  expect(await run('proof',({target})=>readCacheRetentionCarryDays(target,later.key))).toEqual(later.carry);
  let direct:CacheRetentionDayAggregate|undefined;
  for(let pass=0;pass<16&&!direct;pass++)await run('reference',async({source,target,meter})=>{
   try{direct=await createCacheRetentionEffectiveDayBuild({source,target,sourceNamespace,ownerDigest:bad.ownerDigest,
    ownerRevision:bad.ownerRevision,authorityEpoch:bad.authorityEpoch})(later.key,later.carry,
     {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000});}
   catch(error){if(!(error instanceof CacheRetentionDeferredError))throw error;}
  },reference());
  expect(direct?.eventsRead).toBe(2);expect(direct!.groups.some(group=>group.adjacencies>0)).toBe(true);
  expectedHash=await sha256Hex(canonicalJson(direct));
  // Both cases use full lane from offset2 and exactly original300/650/950,
  // maxDays12/maxWrites48. The second NEW control's32 calls cover a13-date
  // bad prefix plus healthy work; it does not replace any original16 assertion.
  for(let pass=0;pass<testCase.passes;pass++){
   const result=await run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
    build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures:false}),
    remainingQueries:CACHE_RETENTION_WORKER_TARGET_QUERIES,sourceQueries:300,
    sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,
    maxDays:CACHE_RETENTION_WORKER_DAYS,maxWrites:CACHE_RETENTION_WORKER_WRITES,fromDay:days[2]!}));
   expect(result.sourceQueriesUsed).toBeLessThanOrEqual(300);expect(result.actualBudget).toBeDefined();
   passes.push({built:result.built,skipped:result.skipped,chargedBuild:result.actualBudget!.chargedBuildStatements,
    chargedTarget:result.actualBudget!.chargedTargetStatements,chargedTotal:result.actualBudget!.chargedTotalStatements});
  }
  const actual=await run('proof',({target})=>readCacheRetentionDay({target,key:later.key,carry:later.carry}));
  expect(actual.status,'same owner later genuine carry remains reachable from original full range').toBe('ready');
  if(actual.status!=='ready')throw new Error('SYNTHETIC_SAME_OWNER_LATER_NOT_READY');
  expect(actual.aggregate).toEqual(direct);actualHash=await sha256Hex(canonicalJson(actual.aggregate));expect(actualHash).toBe(expectedHash);
  const early=await sourceInputs(run,bad,days[2]!);
  expect((await run('proof',({target})=>readCacheRetentionDay({target,key:early.key,carry:early.carry}))).status).not.toBe('ready');
  for(const day of [days[2]!,days.at(-1)!]){
   const input=await sourceInputs(run,healthy,day);
   expect((await run('proof',({target})=>readCacheRetentionDay({target,key:input.key,carry:input.carry}))).status).toBe('ready');
  }
  for(const offset of blocked)await run('proof',async({source,target})=>{
   expect((await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,
    fromDay:days[offset]!,throughDay:days[offset]!})).rows).toEqual([]);
  });
  await run('proof',async({source})=>{
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
   expect(exactOwners(await readStorageCommunityOwnerPage(source))).toEqual(owners);
  });
 }finally{console.info(JSON.stringify({event:'synthetic_same_owner_date_rotation',schema:'cache-date-fairness-draft-v1',
  sourceDays:testCase.days,configuredPasses:testCase.passes,expectedHash,actualHash,passes,cost:measured.receipt(),
  qualification:'component-only',publicConflictRefusalRequired:true}));}
},120_000);
