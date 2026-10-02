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
const sourceId='synthetic-native-cache-carry',sourceNamespace=sourceId;
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

async function seedConflict(run:ReturnType<typeof measurement>['run'],days:readonly string[]){
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
  await run('admission',({source})=>accept(source,otherDevice,days[1]!,[usage(days[1]!,occurrence(conflictIndex,0,0))]));
  const owners=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)));
  expect(owners[0]!.participantId).toBe(conflict.participantId);
  const bad=owners[0]!,healthy=owners.find(owner=>owner.participantId===healthyId)!;
  for(const day of days.slice(0,2))await run('proof',async({source})=>{
   const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace,ownerDigest:bad.ownerDigest,
    ownerRevision:bad.ownerRevision,authorityEpoch:bad.authorityEpoch,day,stream:'usage',limit:200});
   const row=page.rows.find(value=>value.occurrenceId===occurrence(conflictIndex,0,0));
   expect(row?.status).toBe('conflict');expect(row?.eventTimeConflict).toBe(true);expect(row?.recordJson).toBeNull();
  });
  await deliver(run,target());
  return {owners,bad,healthy};
}

// Faults occur before the original target statement is prepared or executed.
// All actual SQL keeps the existing real invocation meter/profile handles.
function beforeOwnerWrite(db:D1Database,attempt:()=>void):D1Database{
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>{
   if(sql.startsWith('INSERT INTO analytics_community_daily_owners'))attempt();
   return target.prepare(sql);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

it('bounds deferred daily owners without swallowing budget or unexpected failures',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const measured=measurement(),run=measured.run;
 const start=Date.parse(new Date(Date.now()-4*86_400_000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=[0,1].map(index=>new Date(start+index*86_400_000).toISOString().slice(0,10));
 let faultAttempts=0;
 try{
  const {owners,bad,healthy}=await seedConflict(run,days);
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  const advance=(maxOwners:number,kind?:'unexpected'|'budget')=>run('daily',({source,target,meter})=>
   advanceStorageCommunityDaily({source,target:kind?beforeOwnerWrite(target,()=>{
    faultAttempts++;
    if(kind==='unexpected')throw new Error('SYNTHETIC_DAILY_OWNER_WRITE_UNAVAILABLE');
    meter.reserveQueries=meter.remainingQueries;
   }):target,sourceId,sourceNamespace,day:days[0]!,maxOwners,sharedFeatures:false}));
  for(const maxOwners of [0,17,1.5])await expect(advance(maxOwners)).rejects.toThrow();
  // The first owner is a genuine immutable conflict. One attempt cannot reach
  // the healthy second owner or report a deferred attempt as successful work.
  expect(await advance(1,'unexpected')).toEqual({state:'deferred',ownersAdvanced:0,reason:'projection_pending'});
  expect(faultAttempts).toBe(0);
  await expect(advance(2,'unexpected')).rejects.toThrow('SYNTHETIC_DAILY_OWNER_WRITE_UNAVAILABLE');
  expect(faultAttempts).toBe(1);
  await expect(advance(2,'budget')).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
  expect(faultAttempts).toBe(2);
  await run('proof',async({target})=>{
   expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_owners WHERE source_id=? AND day=?')
    .bind(sourceId,days[0]).first('n')).toBe(0);
   expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications WHERE source_id=? AND day=?')
    .bind(sourceId,days[0]).first('n')).toBe(0);
  });
  expect(await advance(2)).toEqual({state:'progress',ownersAdvanced:1,reason:'projection_pending'});
  expect(await advance(2)).toEqual({state:'deferred',ownersAdvanced:0,reason:'projection_pending'});
  await run('proof',async({source,target})=>{
   const prepared=(await target.prepare('SELECT owner_digest,complete,progress_revision,values_json FROM analytics_community_daily_owners WHERE source_id=? AND day=?')
    .bind(sourceId,days[0]).all<{owner_digest:string;complete:number;progress_revision:number;values_json:string}>()).results;
   expect(prepared).toHaveLength(1);expect(prepared[0]!.owner_digest).toBe(healthy.ownerDigest);
   expect(prepared[0]!.owner_digest).not.toBe(bad.ownerDigest);
   expect(prepared[0]!.complete).toBe(1);expect(prepared[0]!.progress_revision).toBe(1);
   expect(JSON.parse(prepared[0]!.values_json).counts.usage).toBe(2);
   expect((await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,fromDay:days[0]!,throughDay:days[0]!})).rows).toEqual([]);
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
   expect(exactOwners(await readStorageCommunityOwnerPage(source))).toEqual(owners);
  });
 }finally{console.info(JSON.stringify({event:'synthetic_daily_deferred_owner_controls',owners:2,faultAttempts,cost:measured.receipt()}));}
},120_000);

it.each([false,true])('authentic conflict carry permits healthy private preparation; shared=%s',async(sharedFeatures)=>{
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
 const measured=measurement(),run=measured.run;
 const start=Date.parse(new Date(Date.now()-12*86_400_000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=Array.from({length:10},(_,index)=>new Date(start+index*86_400_000).toISOString().slice(0,10));
 const destination=days[2]!,outsideCarry=days[9]!,analyticalNowMs=start+10*86_400_000+12*3_600_000;
 const laneStates:{built:number;staged:number;refused:number;skipped:number;sourceQueriesUsed:number}[]=[];
 let directDigest:string|null=null,actualDigest:string|null=null,healthyMissingCarry=0,nativeConflictRefused=false;
 try{
  const {owners,bad,healthy}=await seedConflict(run,days);
  await deliver(run,reference());
  const authorityBefore=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  for(const [index,day] of days.entries()){
   let published=false;
   for(let attempt=0;attempt<8;attempt++){
    const result=await run('daily',({source,target,meter})=>advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,
     day,nowMs:analyticalNowMs,maxOwners:4,sharedFeatures,
     sharedFeatureBudget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,now:Date.now}}));
    if(result.state==='published'||result.state==='unchanged'){published=true;break;}
   }
   expect(published).toBe(index>=2);
  }
  const badInputs=await sourceInputs(run,bad,destination);
  for(let pass=0;pass<16&&!nativeConflictRefused;pass++)await run('reference',async({source,target,meter})=>{
   try{await createCacheRetentionEffectiveDayBuild({source,target,sourceNamespace,ownerDigest:bad.ownerDigest,
    ownerRevision:bad.ownerRevision,authorityEpoch:bad.authorityEpoch})(badInputs.key,badInputs.carry,
     {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000});
    throw new Error('SYNTHETIC_NATIVE_CONFLICT_WAS_ACCEPTED');}
   catch(error){if(error instanceof CacheRetentionRefusedError){expect(error.reason).toBe('usage_row_refused');nativeConflictRefused=true;}
    else if(!(error instanceof CacheRetentionDeferredError))throw error;}
  },reference());
  expect(nativeConflictRefused).toBe(true);
  const inputs=await sourceInputs(run,healthy,destination);
  const carryBefore=await run('proof',({target})=>readCacheRetentionCarryDays(target,inputs.key));
  healthyMissingCarry=carryBefore.filter((row,index)=>row.manifestDigest===''&&inputs.carry[index]!.manifestDigest!=='').length;
  let direct:CacheRetentionDayAggregate|undefined;
  for(let pass=0;pass<16&&!direct;pass++)await run('reference',async({source,target,meter})=>{
   try{direct=await createCacheRetentionEffectiveDayBuild({source,target,sourceNamespace,ownerDigest:healthy.ownerDigest,
    ownerRevision:healthy.ownerRevision,authorityEpoch:healthy.authorityEpoch})(inputs.key,inputs.carry,
     {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000});}
   catch(error){if(!(error instanceof CacheRetentionDeferredError))throw error;}
  },reference());
  expect(direct?.eventsRead).toBe(2);expect(direct!.groups.some(group=>group.adjacencies>0)).toBe(true);
  directDigest=await sha256Hex(canonicalJson(direct));
  for(let pass=0;pass<16;pass++){
   const result=await run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
    build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures}),
    remainingQueries:CACHE_RETENTION_WORKER_TARGET_QUERIES,sourceQueries:CACHE_RETENTION_WORKER_QUERIES-CACHE_RETENTION_WORKER_TARGET_QUERIES,
    sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,
    maxDays:CACHE_RETENTION_WORKER_DAYS,maxWrites:CACHE_RETENTION_WORKER_WRITES,fromDay:destination}));
   expect(result.sourceQueriesUsed).toBeLessThanOrEqual(300);
   laneStates.push({built:result.built,staged:result.staged,refused:result.refused,skipped:result.skipped,sourceQueriesUsed:result.sourceQueriesUsed});
  }
  // A complete private cache result must not silently complete either bad
  // daily cohort, exclude its owner, or change the source authority.
  await run('proof',async({source,target})=>{
   const visible=await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,fromDay:days[0]!,throughDay:days[1]!});
   expect(visible.rows).toEqual([]);
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authorityBefore);
   expect(exactOwners(await readStorageCommunityOwnerPage(source))).toEqual(owners);
  });
  const prepared=await run('proof',({target})=>readCacheRetentionDay({target,key:inputs.key,carry:inputs.carry}));
  if(prepared.status==='ready')actualDigest=await sha256Hex(canonicalJson(prepared.aggregate));
  // The baseline returned absent: the healthy carry was obstructed by the
  // unrelated owner's blocked daily fold. The exact private result must agree.
  expect(prepared.status,'healthy exact-source carry remains reachable').toBe('ready');
  if(prepared.status!=='ready')throw new Error('SYNTHETIC_NATIVE_CARRY_NOT_READY');
  expect(prepared.aggregate).toEqual(direct);expect(actualDigest).toBe(directDigest);
  const later=await sourceInputs(run,healthy,outsideCarry);
  expect((await run('proof',({target})=>readCacheRetentionDay({target,key:later.key,carry:later.carry}))).status).toBe('ready');
 }finally{
  console.info(JSON.stringify({event:'synthetic_native_conflict_carry',schema:'native-cache-carry-correctness-v1',sharedFeatures,
   owners:2,sourceDays:10,healthyMissingCarry,nativeConflictRefused,directDigest,actualDigest,passes:laneStates,cost:measured.receipt(),
   qualification:'component-only',publicConflictRefusalRequired:true}));
 }
},120_000);

type ProgressRow={owner:'healthy'|'conflict';dayOffset:number;phase:'discover'|'lookback'|'own'|'write';
 lookbackIndex:number;revision:number;hasCursor:number};
type MarkRow={owner:'healthy'|'conflict';dayOffset:number;refused:number};
type ProgressSnapshot={progress:ProgressRow[];marks:MarkRow[]};
async function progressSnapshot(run:ReturnType<typeof measurement>['run'],healthy:Owner,bad:Owner,startDay:string):Promise<ProgressSnapshot>{
 return run('proof',async({target})=>{
  // Closed roles/offsets and reducer control metadata only; neither source
  // records nor durable keys, sessions, cursor values or fold bodies leave SQL.
  const ownerCase="CASE owner_digest WHEN ?3 THEN 'healthy' WHEN ?4 THEN 'conflict' ELSE 'unknown' END";
  const progress=(await target.prepare(`SELECT ${ownerCase} AS owner,
   CAST(julianday(day)-julianday(?2) AS INTEGER) AS dayOffset,
   json_extract(state_json,'$.phase') AS phase,json_extract(state_json,'$.lookbackIndex') AS lookbackIndex,
   progress_revision AS revision,CASE WHEN json_type(state_json,'$.cursor')='null' THEN 0 ELSE 1 END AS hasCursor
   FROM analytics_cache_retention_day_progress WHERE source_id=?1 ORDER BY day,owner_digest LIMIT 21`)
   .bind(sourceId,startDay,healthy.ownerDigest,bad.ownerDigest).all<ProgressRow>()).results;
  const marks=(await target.prepare(`SELECT ${ownerCase} AS owner,
   CAST(julianday(day)-julianday(?2) AS INTEGER) AS dayOffset,CASE WHEN refusal IS NULL THEN 0 ELSE 1 END AS refused
   FROM analytics_cache_retention_day_marks WHERE source_id=?1 ORDER BY day,owner_digest LIMIT 21`)
   .bind(sourceId,startDay,healthy.ownerDigest,bad.ownerDigest).all<MarkRow>()).results;
  expect(progress.length).toBeLessThanOrEqual(20);expect(marks.length).toBeLessThanOrEqual(20);
  for(const row of [...progress,...marks]){
   expect(['healthy','conflict']).toContain(row.owner);expect(Number.isSafeInteger(row.dayOffset)).toBe(true);
   expect(row.dayOffset).toBeGreaterThanOrEqual(0);expect(row.dayOffset).toBeLessThan(10);
  }
  for(const row of progress){
   expect(['discover','lookback','own','write']).toContain(row.phase);
   expect(Number.isSafeInteger(row.revision)).toBe(true);expect(row.revision).toBeGreaterThan(0);
   expect(Number.isSafeInteger(row.lookbackIndex)).toBe(true);expect(row.lookbackIndex).toBeGreaterThanOrEqual(0);
   expect(row.lookbackIndex).toBeLessThanOrEqual(7);expect([0,1]).toContain(row.hasCursor);
  }
  return {progress,marks};
 });
}
function assertProgressPreserved(prior:ProgressSnapshot,next:ProgressSnapshot){
 for(const row of prior.progress){
  const later=next.progress.find(value=>value.owner===row.owner&&value.dayOffset===row.dayOffset);
  if(later){expect(later.revision).toBeGreaterThanOrEqual(row.revision);if(later.revision===row.revision)expect(later).toEqual(row);}
  else expect(next.marks.some(value=>value.owner===row.owner&&value.dayOffset===row.dayOffset)).toBe(true);
 }
 for(const row of prior.marks)expect(next.marks).toContainEqual(row);
}

it('observes unchanged16 full-lane progress and separate later-day-only selection',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
 const measured=measurement(),run=measured.run;
 const start=Date.parse(new Date(Date.now()-12*86_400_000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=Array.from({length:10},(_,index)=>new Date(start+index*86_400_000).toISOString().slice(0,10));
 const phases:{stage:'full16'|'later_only';pass:number;built:number;skipped:number;sourceQueriesUsed:number;snapshot:ProgressSnapshot}[]=[];
 const stageCosts:Record<string,ReturnType<typeof measured.receipt>>={};
 const privateHashes:Record<string,string>={};let laterComplete=false;
 try{
  const {owners,bad,healthy}=await seedConflict(run,days);await deliver(run,reference());
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  for(const [index,day] of days.entries()){
   let published=false;
   for(let pass=0;pass<8;pass++){
    const result=await run('daily',({source,target})=>advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,
     day,maxOwners:4,sharedFeatures:false,nowMs:start+10*86_400_000+12*3_600_000}));
    if(result.state==='published'||result.state==='unchanged'){published=true;break;}
   }
   expect(published).toBe(index>=2);
  }
  const publications=()=>run('proof',async({target})=>(await target.prepare(
   'SELECT * FROM analytics_community_daily_publications WHERE source_id=? ORDER BY day,revision LIMIT 11')
   .bind(sourceId).all()).results);
  const beforePublic=await publications();expect(beforePublic).toHaveLength(8);
  const captureCost=(label:string)=>{stageCosts[label]=JSON.parse(JSON.stringify(measured.receipt()));};
  captureCost('setupCumulative');
  let prior=await progressSnapshot(run,healthy,bad,days[0]!);
  const advance=async(stage:'full16'|'later_only',pass:number,fromDay:string)=>{
   const result=await run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
    build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures:false}),
    remainingQueries:CACHE_RETENTION_WORKER_TARGET_QUERIES,sourceQueries:300,
    sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,
    maxDays:CACHE_RETENTION_WORKER_DAYS,maxWrites:CACHE_RETENTION_WORKER_WRITES,fromDay}));
   expect(result.sourceQueriesUsed).toBeLessThanOrEqual(300);
   const snapshot=await progressSnapshot(run,healthy,bad,days[0]!);assertProgressPreserved(prior,snapshot);prior=snapshot;
   phases.push({stage,pass,built:result.built,skipped:result.skipped,sourceQueriesUsed:result.sourceQueriesUsed,snapshot});
  };
  // Preserve the failed experiment's exact16-pass opportunity. This probe
  // records its incomplete state; it never replaces that test's readiness check.
  for(let pass=1;pass<=16;pass++)await advance('full16',pass,days[2]!);
  captureCost('full16Cumulative');
  expect(prior.marks.some(row=>row.owner==='healthy'&&row.dayOffset===2&&row.refused===0)).toBe(true);
  expect(phases.filter(row=>row.stage==='full16').some(row=>row.snapshot.progress.some(value=>value.owner==='healthy'&&value.dayOffset>2))).toBe(true);
  // Freshly authenticated carry includes exactly seven days, and the isolated
  // later day excludes both conflicted dates without erasing retained evidence.
  const laterInputs=[];
  for(const owner of [healthy,bad]){
   const inputs=await sourceInputs(run,owner,days[9]!);
   expect(inputs.carry.map(row=>row.day)).toEqual(days.slice(2,9));
   expect(await run('proof',({target})=>readCacheRetentionCarryDays(target,inputs.key))).toEqual(inputs.carry);
   laterInputs.push({owner:owner===healthy?'healthy':'conflict',...inputs});
  }
  // Separate selection control: two owners x (discover+7carry+own)=18 native
  // pages, plus two bounded selection turns. Original full-lane bound is16.
  for(let pass=1;pass<=20;pass++){
   await advance('later_only',pass,days[9]!);
   laterComplete=laterInputs.every(input=>prior.marks.some(row=>row.owner===input.owner&&row.dayOffset===9&&row.refused===0));
   if(laterComplete)break;
  }
  captureCost('laterOnlyCumulative');expect(laterComplete).toBe(true);
  for(const [index,input] of laterInputs.entries()){
   const owner=index===0?healthy:bad;let direct:CacheRetentionDayAggregate|undefined;
   for(let pass=0;pass<16&&!direct;pass++)await run('reference',async({source,target,meter})=>{
    try{direct=await createCacheRetentionEffectiveDayBuild({source,target,sourceNamespace,ownerDigest:owner.ownerDigest,
     ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch})(input.key,input.carry,
      {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000});}
    catch(error){if(!(error instanceof CacheRetentionDeferredError))throw error;}
   },reference());
   expect(direct?.eventsRead).toBe(2);expect(direct!.groups.some(row=>row.adjacencies>0)).toBe(true);
   const actual=await run('proof',({target})=>readCacheRetentionDay({target,key:input.key,carry:input.carry}));
   expect(actual.status).toBe('ready');if(actual.status!=='ready')throw new Error('SYNTHETIC_LATER_CONTROL_NOT_READY');
   expect(actual.aggregate).toEqual(direct);privateHashes[input.owner]=await sha256Hex(canonicalJson(direct));
  }
  expect(await publications()).toEqual(beforePublic);
  await run('proof',async({source,target})=>{
   expect((await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,fromDay:days[0]!,throughDay:days[1]!})).rows).toEqual([]);
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
   expect(exactOwners(await readStorageCommunityOwnerPage(source))).toEqual(owners);
  });
 }finally{console.info(JSON.stringify({event:'synthetic_native_carry_progress_probe',schema:'native-cache-carry-progress-v1',
  originalFullLaneLimit:16,separateLaterOnlyLimit:20,laterComplete,phases,privateHashes,stageCosts,cost:measured.receipt(),
  qualification:'separate-progress-diagnostic',doesNotReplaceOriginalFailure:true}));}
},120_000);


it('rotates past four genuinely conflicted owners to prepare the fifth at maxOwners4',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const measured=measurement(),run=measured.run;
 const start=Date.parse(new Date(Date.now()-4*86_400_000).toISOString().slice(0,10)+'T00:00:00.000Z');
 const days=[0,1].map(offset=>new Date(start+offset*86_400_000).toISOString().slice(0,10));
 const outcomes:{state:string;ownersAdvanced:number;reason:string|null;preparedOwners:number}[]=[];
 let privateDigest:string|null=null,actualDigest:string|null=null;
 try{
  const devices:Device[]=[];
  for(let owner=0;owner<5;owner++)devices.push(await run('admission',({source})=>createV11DeviceFixture(source)));
  for(const [index,device] of devices.entries())for(const [dayIndex,day] of days.entries())
   await run('admission',({source})=>accept(source,device,day,[usage(day,occurrence(index,dayIndex,0)),usage(day,occurrence(index,dayIndex,1),1)]));
  for(let attempt=0;attempt<16;attempt++){
   if((await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source))).completed)break;
   if(attempt===15)throw new Error('SYNTHETIC_FIVE_OWNER_BOOTSTRAP_BOUND');
  }
  const ordered=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)),5);
  for(const owner of ordered.slice(0,4)){
   const index=devices.findIndex(device=>device.participantId===owner.participantId);expect(index).toBeGreaterThanOrEqual(0);
   const additional=await run('admission',({source})=>createV11DeviceFixture(source,{participantId:owner.participantId}));
   await run('admission',({source})=>accept(source,additional,days[1]!,[usage(days[1]!,occurrence(index,0,0))]));
  }
  const owners=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)),5);
  expect(owners.map(owner=>owner.participantId)).toEqual(ordered.map(owner=>owner.participantId));
  for(const owner of owners.slice(0,4))for(const day of days)await run('proof',async({source})=>{
   const index=devices.findIndex(device=>device.participantId===owner.participantId);
   const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace,ownerDigest:owner.ownerDigest,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream:'usage',limit:200});
   const conflicted=page.rows.find(row=>row.occurrenceId===occurrence(index,0,0));
   expect(conflicted?.status).toBe('conflict');expect(conflicted?.eventTimeConflict).toBe(true);expect(conflicted?.recordJson).toBeNull();
  });
  await deliver(run,target(),5);
  const healthy=owners[4]!;
  let expected=createV11DailyProjectionValues(days[0]!);
  for(const stream of ['usage','quota','session'] as const)await run('reference',async({source})=>{
   const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace,ownerDigest:healthy.ownerDigest,
    ownerRevision:healthy.ownerRevision,authorityEpoch:healthy.authorityEpoch,day:days[0]!,stream,limit:200});
   expect(page.next).toBeNull();expect(page.rows).toHaveLength(stream==='usage'?2:0);
   expect(page.rows.every(row=>row.status==='compatible'&&typeof row.recordJson==='string')).toBe(true);
   expected=foldV11DailyProjectionValues(expected,page.rows.map(row=>JSON.parse(row.recordJson!)));
  });
  expect(expected.counts.usage).toBe(2);privateDigest=await sha256Hex(canonicalJson(expected));
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  for(let pass=0;pass<3;pass++){
   const result=await run('daily',({source,target})=>advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,
    day:days[0]!,maxOwners:4,sharedFeatures:false}));
   expect(result.ownersAdvanced).toBeLessThanOrEqual(4);
   const preparedOwners=await run('proof',async({source,target})=>{
    expect((await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,fromDay:days[0]!,throughDay:days[1]!})).rows).toEqual([]);
    expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
    expect(exactOwners(await readStorageCommunityOwnerPage(source),5)).toEqual(owners);
    return await target.prepare('SELECT count(*) n FROM analytics_community_daily_owners WHERE source_id=? AND day=? AND complete=1')
     .bind(sourceId,days[0]).first<number>('n');
   });
   outcomes.push({state:result.state,ownersAdvanced:result.ownersAdvanced,reason:result.reason??null,preparedOwners:preparedOwners??0});
  }
  const healthyRow=await run('proof',({target})=>target.prepare(
   'SELECT complete,values_json FROM analytics_community_daily_owners WHERE source_id=? AND day=? AND owner_digest=?')
   .bind(sourceId,days[0],healthy.ownerDigest).first<{complete:number;values_json:string}>());
  if(healthyRow)actualDigest=await sha256Hex(healthyRow.values_json);
  expect(healthyRow?.complete,'the fifth compatible owner must receive a bounded turn').toBe(1);
  expect(JSON.parse(healthyRow!.values_json)).toEqual(expected);expect(actualDigest).toBe(privateDigest);
 }finally{console.info(JSON.stringify({event:'synthetic_five_owner_daily_fairness',owners:5,conflictedOwners:4,
  maxOwners:4,passes:3,outcomes,privateDigest,actualDigest,cost:measured.receipt(),publicIncompleteCohortRefused:true}));}
},120_000);


it('reserves only the attempted daily owner before a throwing prefix and preserves bounded later turns',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const measured=measurement(),run=measured.run,day=new Date(Date.now()-3*86_400_000).toISOString().slice(0,10);
 const attempted:string[]=[];
 try{
  for(let index=0;index<5;index++){
   const device=await run('admission',({source})=>createV11DeviceFixture(source));
   await run('admission',({source})=>accept(source,device,day,[usage(day,occurrence(index,0,0))]));
  }
  for(let n=0;n<16;n++){
   if((await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source))).completed)break;
   if(n===15)throw new Error('SYNTHETIC_THROWING_CURSOR_BOOTSTRAP_BOUND');
  }
  await deliver(run,target(),5);
  const owners=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)),5);
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  for(let pass=0;pass<3;pass++)await expect(run('daily',({source,target})=>{
   const interrupted=new Proxy(target,{get(db,key){
    if(key==='prepare')return(sql:string)=>{
     const statement=db.prepare(sql);if(!sql.startsWith('INSERT INTO analytics_community_daily_owners'))return statement;
     return new Proxy(statement,{get(value,method){
      if(method==='bind')return(...args:unknown[])=>{
       expect(typeof args[2]).toBe('string');attempted.push(args[2] as string);
       throw new Error('SYNTHETIC_OWNER_ATTEMPT_INTERRUPTED');
      };
      const member=Reflect.get(value,method);return typeof member==='function'?member.bind(value):member;
     }});
    };
    const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
   }});
   return advanceStorageCommunityDaily({source,target:interrupted,sourceId,sourceNamespace,day,maxOwners:4,sharedFeatures:false});
  })).rejects.toThrow('SYNTHETIC_OWNER_ATTEMPT_INTERRUPTED');
  expect(attempted).toEqual(owners.slice(0,3).map(owner=>owner.ownerDigest));
  for(let pass=0;pass<2;pass++)expect(await run('daily',({source,target})=>
   advanceStorageCommunityDaily({source,target,sourceId,sourceNamespace,day,maxOwners:1,sharedFeatures:false})))
   .toEqual({state:'progress',ownersAdvanced:1,reason:'projection_pending'});
  await run('proof',async({source,target})=>{
   const prepared=(await target.prepare('SELECT owner_digest,complete,values_json FROM analytics_community_daily_owners WHERE source_id=? AND day=? ORDER BY owner_digest')
    .bind(sourceId,day).all<{owner_digest:string;complete:number;values_json:string}>()).results;
   expect(prepared.map(row=>row.owner_digest)).toEqual(owners.slice(3).map(owner=>owner.ownerDigest).sort());
   expect(prepared.every(row=>row.complete===1&&JSON.parse(row.values_json).counts.usage===1)).toBe(true);
   expect((await readPublishedStorageCommunityDaily({source,target,sourceId,sourceNamespace,fromDay:day,throughDay:day})).rows).toEqual([]);
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
  });
 }finally{console.info(JSON.stringify({event:'synthetic_daily_attempt_rotation',throwingCalls:3,maxOwners:4,
  actualFailedOwnerAttempts:attempted.length,successfulSingleOwnerCalls:2,cost:measured.receipt(),qualification:'bounded-component'}));}
},120_000);

it('resumes native dense fallback after authentic shared day_row_limit under300source950total',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
 const measured=measurement(),run=measured.run;
 const day=new Date(Date.now()-3*86_400_000).toISOString().slice(0,10),dayMs=Date.parse(day+'T00:00:00.000Z');
 type DenseProgress={phase:string;lookbackIndex:number;revision:number;hasCursor:number;eventsRead:number}|null;
 const trace:{lane:'native'|'shared';pass:number;sourceAllowanceUsed:number;state:'complete'|'deferred';
  reason:string|null;progress:DenseProgress;featureState:string|null;featureRevision:number|null}[]=[];
 let refusal:string|null=null,postRefusalCalls=0,nativeHash:string|null=null,sharedHash:string|null=null;
 const checkpoints=(destination:D1Database)=>run('proof',async({target})=>{
  const progress=await target.prepare(`SELECT json_extract(state_json,'$.phase') AS phase,
   json_extract(state_json,'$.lookbackIndex') AS lookbackIndex,progress_revision AS revision,
   CASE WHEN json_type(state_json,'$.cursor')='null' THEN 0 ELSE 1 END AS hasCursor,
   json_extract(state_json,'$.eventsRead') AS eventsRead FROM analytics_cache_retention_day_progress WHERE source_id=? AND day=?`)
   .bind(sourceId,day).first<NonNullable<DenseProgress>>();
  if(progress){expect(['discover','lookback','own','write']).toContain(progress.phase);
   expect(Number.isSafeInteger(progress.revision)).toBe(true);expect(progress.revision).toBeGreaterThan(0);
   expect([0,1]).toContain(progress.hasCursor);expect(progress.eventsRead).toBeLessThanOrEqual(401);}
  const feature=await target.prepare('SELECT state,head_revision FROM analytics_shared_feature_days WHERE source_id=? AND day=?')
   .bind(sourceId,day).first<{state:string;head_revision:number}>();
  return {progress,featureState:feature?.state??null,featureRevision:feature?.head_revision??null};
 },destination);
 try{
  const device=await run('admission',({source})=>createV11DeviceFixture(source));
  for(const [stream,count] of [['quota',6001],['usage',401]] as const)for(let offset=0;offset<count;offset+=200){
   const records:TelemetryV1Record[]=Array.from({length:Math.min(200,count-offset)},(_,local)=>{
    const index=offset+local;
    if(stream==='usage')return {...usage(day,occurrence(0,0,index)),eventTime:new Date(dayMs+12*3_600_000+index*1000).toISOString()};
    return {schemaVersion:'quota-observation-v1.0',observationId:`quota-occurrence:v1:${(index+1).toString(16).padStart(64,'0')}`,
     observedTime:new Date(dayMs+8*3_600_000+index*1000).toISOString(),provider:'openai_codex',planType:'pro',planVariant:'unknown',
     limitId:'codex',slot:'secondary',usedPercent:index%95,windowDurationMinutes:10080,
     resetsAt:new Date(dayMs+7*86_400_000).toISOString()};
   });
   await run('admission',({source})=>accept(source,device,day,records,stream,offset/200));
  }
  for(let attempt=0;attempt<16;attempt++){
   if((await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source))).completed)break;
   if(attempt===15)throw new Error('SYNTHETIC_DENSE_NATIVE_BOOTSTRAP_BOUND');
  }
  const owner=exactOwners(await run('proof',({source})=>readStorageCommunityOwnerPage(source)),1)[0]!;
  await run('proof',async({source})=>{
   const headers=(await source.prepare(`SELECT stream,SUM(record_count) AS records,COUNT(*) AS chunks
    FROM telemetry_v1_chunks WHERE participant_id=? AND superseded_at IS NULL GROUP BY stream ORDER BY stream`)
    .bind(owner.participantId).all()).results;
   expect(headers).toEqual([{stream:'quota',records:6001,chunks:31},{stream:'usage',records:401,chunks:3}]);
  });
  await deliver(run,target(),1);await deliver(run,reference(),1);
  const authority=await run('proof',({source})=>captureStorageCommunityAuthority(source,{sourceId,sourceNamespace}));
  const inputs=await sourceInputs(run,owner,day);expect(inputs.carry).toHaveLength(7);
  expect(inputs.carry.every(row=>row.manifestDigest==='')).toBe(true);
  const results:Partial<Record<'native'|'shared',CacheRetentionDayAggregate>>={};
  for(const lane of ['native','shared'] as const){
   const destination=lane==='native'?reference():target();let prior:DenseProgress=null;
   for(let pass=1;pass<=(lane==='native'?32:96)&&!results[lane];pass++){
    let reason:string|null=null,sourceAllowanceUsed=0;
    await run('cache',async({source,target,meter})=>{
     const budget={remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000};
     try{results[lane]=await createCacheRetentionDaySourceBuild({source,target,sourceNamespace,sharedFeatures:lane==='shared'})(inputs.key,inputs.carry,budget);}
     catch(error){if(!(error instanceof CacheRetentionDeferredError))throw error;reason=error.reason;}
     finally{sourceAllowanceUsed=300-budget.remainingQueries;expect(sourceAllowanceUsed).toBeLessThanOrEqual(300);}
    },destination);
    const state=await checkpoints(destination);
    if(prior&&state.progress)expect(state.progress.revision).toBeGreaterThanOrEqual(prior.revision);
    prior=state.progress;
    trace.push({lane,pass,sourceAllowanceUsed,state:results[lane]?'complete':'deferred',reason,...state});
    if(lane==='shared'&&state.featureState==='refused'&&refusal===null){
     const feature=await run('proof',({source,target,meter})=>readSharedAnalyticsFeatureDay({source,target,sourceId,sourceNamespace,
      owner,day,budget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,now:Date.now}}));
     expect(feature.state).toBe('refused');if(feature.state!=='refused')throw new Error('SYNTHETIC_DENSE_REFUSAL_NOT_CURRENT');
     refusal=feature.reason;expect(refusal).toBe('day_row_limit');
    }else if(lane==='shared'&&refusal!==null){postRefusalCalls++;if(postRefusalCalls>=16)break;}
   }
   if(lane==='native'){
    expect(results.native?.eventsRead).toBe(401);expect(results.native!.groups.some(group=>group.adjacencies>0)).toBe(true);
    nativeHash=await sha256Hex(canonicalJson(results.native));
   }
  }
  if(results.shared)sharedHash=await sha256Hex(canonicalJson(results.shared));
  await run('proof',async({source,target})=>{
   expect(await captureStorageCommunityAuthority(source,{sourceId,sourceNamespace})).toEqual(authority);
   expect(exactOwners(await readStorageCommunityOwnerPage(source),1)).toEqual([owner]);
   expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications WHERE source_id=?').bind(sourceId).first('n')).toBe(0);
  });
  expect(refusal,'the shared source must reach its authentic row bound').toBe('day_row_limit');
  expect(results.shared,'current refusal must permit exact native fallback progress').toEqual(results.native);
  expect(sharedHash).toBe(nativeHash);
 }finally{console.info(JSON.stringify({event:'synthetic_dense_native_cache_fallback',quotaRows:6001,usageRows:401,
  maximumChunkRecords:200,nativePassLimit:32,sharedPassLimit:96,postRefusalPassLimit:16,postRefusalCalls,
  refusal,nativeHash,sharedHash,trace,cost:measured.receipt(),
  qualification:'native-source-builder-component-only',selectionAndPublicPublicationQualified:false}));}
},120_000);
