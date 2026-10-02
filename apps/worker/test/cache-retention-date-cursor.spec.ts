import {cacheDateCursorMode,readCacheDateCursor,initializeCacheDateCursor,advanceCacheDateCursor,
 retireCacheDateCursorPage,cacheDateAfterAttempt,CACHE_DATE_CURSOR_SCHEMA,CACHE_DATE_CURSOR_TABLE} from '../src/cache-retention-date-cursor';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {eraseParticipantAsOwner} from '../src/participant-erasure';
import {advanceStorageErasureJobs,requireStorageParticipantErasureComplete} from '../src/storage-erasure';
import {hasDeletionTombstone} from '../src/retention';
import {ApiError} from '../src/errors';
import {makeV11Day} from './helpers/telemetry-v11';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
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

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;
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



const owner='a'.repeat(64),table=CACHE_DATE_CURSOR_TABLE;
async function cursorSetup(predecessor=false){
 await reset();await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS.filter(row=>!predecessor||row.name<'0034_'));
 await target().prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(sourceId,sourceNamespace).run();
 await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(sourceId,owner).run();
}
async function boundedCursor<T>(work:(db:D1Database)=>Promise<T>,raw=target()){
 const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950),targetMeter=createD1InvocationBudget(650);
 try{return await work(targetMeter.wrap(meter.wrap(profileAnalyticsDatabase(raw,'target',profile,()=> 'cursor_control'))));}
 finally{const statements=Object.values(profile.costs).reduce((n,row)=>n+row.statements,0);
  expect(statements).toBe(meter.queriesUsed);expect(statements).toBe(targetMeter.queriesUsed);expect(statements).toBeLessThanOrEqual(650);expect(profile.measurementFailures).toBe(0);
  console.info(JSON.stringify({event:'cache_date_cursor_control_cost',statements,chargedTarget:targetMeter.queriesUsed,chargedTotal:meter.queriesUsed,rowsRead:Object.values(profile.costs).reduce((n,row)=>n+row.rowsRead,0),
   rowsWritten:Object.values(profile.costs).reduce((n,row)=>n+row.rowsWritten,0),failedStatements:Object.values(profile.costs).reduce((n,row)=>n+row.failedStatements,0)}));}
}
const initialize=(db:D1Database,ownerDigest=owner)=>initializeCacheDateCursor(db,sourceId,ownerDigest,2,9);
const forward=(db:D1Database,before:NonNullable<Awaited<ReturnType<typeof initialize>>>)=>advanceCacheDateCursor(db,sourceId,owner,before,
 {cycle_upper_day:9,next_day:2,next_ordinal:1,day_slot_limit:2});
it('keeps genuine0033 predecessor while partial installed cursor loss refuses',async()=>{
 await cursorSetup(true);expect(await boundedCursor(cacheDateCursorMode)).toBe('predecessor');
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS.filter(row=>row.name>='0034_'));
 expect(await boundedCursor(cacheDateCursorMode)).toBe('installed');
 const guard=CACHE_DATE_CURSOR_SCHEMA.find(row=>row.name===table+'_update')!;
 await target().prepare(`DROP TRIGGER ${guard.name}`).run();expect(await boundedCursor(cacheDateCursorMode)).toBe('unavailable');
 await target().prepare(guard.sql).run();expect(await boundedCursor(cacheDateCursorMode)).toBe('installed');
 await target().prepare(`DROP TABLE ${table}`).run();expect(await boundedCursor(cacheDateCursorMode)).toBe('unavailable');
});
it('requires exact guards, columns and attachments before any position advances',async()=>{
 await cursorSetup();const before=(await boundedCursor(db=>initialize(db)))!;
 const guard=CACHE_DATE_CURSOR_SCHEMA.find(row=>row.name===table+'_update')!;
 await target().prepare(`DROP TRIGGER ${guard.name}`).run();
 expect(await boundedCursor(db=>forward(db,before))).toBeNull();expect(await boundedCursor(db=>readCacheDateCursor(db,sourceId,owner))).toEqual(before);
 await target().prepare(guard.sql).run();await target().prepare(`CREATE INDEX synthetic_unreviewed_date_cursor ON ${table}(revision)`).run();
 expect(await boundedCursor(cacheDateCursorMode)).toBe('unavailable');expect(await boundedCursor(db=>forward(db,before))).toBeNull();
 await target().prepare('DROP INDEX synthetic_unreviewed_date_cursor').run();
 await target().prepare(`ALTER TABLE ${table} ADD COLUMN unreviewed INTEGER`).run();expect(await boundedCursor(cacheDateCursorMode)).toBe('unavailable');
});
it('reserves one structural slot, holds its count, and advances past a throwing prefix',async()=>{
 await cursorSetup();await boundedCursor(async db=>{
  const before=(await initialize(db))!,one=await forward(db,before);expect(one).toEqual({...before,next_day:2,next_ordinal:1,day_slot_limit:2,revision:2});
  // Throw occurs after durable one-position ACK; no other slot was reserved.
  expect(()=>{throw new Error('SYNTHETIC_AFTER_RESERVATION');}).toThrow('SYNTHETIC_AFTER_RESERVATION');
  const seen=(await readCacheDateCursor(db,sourceId,owner))!;expect(seen).toEqual(one);
  const two=await advanceCacheDateCursor(db,sourceId,owner,seen,cacheDateAfterAttempt(seen,2,1,3));
  // A newly arrived third slot does not extend this held two-slot visit.
  expect(two).toEqual({...seen,next_day:3,next_ordinal:0,day_slot_limit:0,revision:3});
  expect(await forward(db,before)).toBeNull();
 });
});
it('uses exact CAS for concurrent readers and does not reset a held frontier on new arrivals',async()=>{
 await cursorSetup();await boundedCursor(async db=>{
  const before=(await initialize(db))!;
  const winners=await Promise.all([forward(db,before),forward(db,before)]);expect(winners.filter(Boolean)).toHaveLength(1);
  const saved=(await readCacheDateCursor(db,sourceId,owner))!;
  await expect(advanceCacheDateCursor(db,sourceId,owner,saved,{...saved,cycle_upper_day:10})).rejects.toThrow();
  expect(await readCacheDateCursor(db,sourceId,owner)).toEqual(saved);
  const exhausted=await advanceCacheDateCursor(db,sourceId,owner,saved,{cycle_upper_day:9,next_day:10,next_ordinal:0,day_slot_limit:0});
  expect(exhausted).not.toBeNull();
  const wrapped=await advanceCacheDateCursor(db,sourceId,owner,exhausted!,{cycle_upper_day:20,next_day:2,next_ordinal:0,day_slot_limit:0});
  expect(wrapped?.cycle_upper_day).toBe(20);expect(wrapped?.next_day).toBe(2);
 });
});
it('preserves response-loss advancement and rejects wrong incarnation and unsafe coordinates',async()=>{
 await cursorSetup();await boundedCursor(async db=>{
  const before=(await initialize(db))!;let fired=false;
  const lost=new Proxy(db,{get(value,key){if(key==='prepare')return(sql:string)=>{
   const statement=value.prepare(sql);if(!sql.startsWith(`UPDATE ${table}`))return statement;
   const wrap=(st:D1PreparedStatement):D1PreparedStatement=>new Proxy(st,{get(v,k){
    if(k==='bind')return(...args:unknown[])=>wrap(v.bind(...args));
    if(k==='all')return async()=>{await v.all();fired=true;throw new Error('SYNTHETIC_DATE_ACK_LOST');};
    const member=Reflect.get(v,k);return typeof member==='function'?member.bind(v):member;}});return wrap(statement);
  };const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
  await expect(forward(lost,before)).rejects.toThrow('SYNTHETIC_DATE_ACK_LOST');expect(fired).toBe(true);
  const after=(await readCacheDateCursor(db,sourceId,owner))!;expect(after.revision).toBe(before.revision+1);expect(after.next_ordinal).toBe(1);
  expect(await forward(db,before)).toBeNull();expect(await forward(db,{...after,cursor_id:after.cursor_id+1})).toBeNull();
  for(const next of [-719529,2932898,1.5,Number.MAX_SAFE_INTEGER])await expect(advanceCacheDateCursor(db,sourceId,owner,after,
   {cycle_upper_day:9,next_day:next,next_ordinal:0,day_slot_limit:0})).rejects.toThrow('CACHE_RETENTION_DATE_CURSOR_UNAVAILABLE');
  expect(await readCacheDateCursor(db,sourceId,owner)).toEqual(after);
 });
});
it('retires at most16 dispensable scheduling rows per cleanup page',async()=>{
 await cursorSetup();await boundedCursor(async db=>{
  for(let n=0;n<20;n++){
   const digest=(n+1).toString(16).padStart(64,'0');
   await db.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(sourceId,digest).run();await initialize(db,digest);
  }
  expect(await retireCacheDateCursorPage(db,sourceId)).toBe(16);expect(await retireCacheDateCursorPage(db,sourceId)).toBe(4);
  expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
 });
});
it('retains exact empty AUTOINCREMENT high-water through native local export/import',async()=>{
 await cursorSetup();const stale=(await boundedCursor(db=>initialize(db)))!;
 expect(await boundedCursor(db=>retireCacheDateCursorPage(db,sourceId))).toBe(1);
 const high=await boundedCursor(db=>db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first<number>('seq'));expect(high).toBe(stale.cursor_id);
 const captured=await captureAcceptedSourceTransfer(target(),'target');
 expect(captured.transfer.proof.autoIncrementSequenceSha256).toMatch(/^[0-9a-f]{64}$/u);
 const imported=await importAcceptedSourceTransfer(captured.transfer,b.STORAGE_INGESTION_A,'target');expect(imported.proof).toEqual(captured.transfer.proof);
 await boundedCursor(async db=>{
  expect(await db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first('seq')).toBe(high);
  const next=(await initialize(db))!;expect(next.cursor_id).toBeGreaterThan(high!);expect(await forward(db,stale)).toBeNull();
 },b.STORAGE_INGESTION_A);
 // Missing proof cannot cause an import even if every exported statement remains exact.
 const missing={...captured.transfer,proof:{...captured.transfer.proof,autoIncrementSequenceSha256:''}};
 await expect(importAcceptedSourceTransfer(missing,b.STORAGE_INGESTION_B,'target')).rejects.toThrow('invalid accepted source transfer');
 expect(await b.STORAGE_INGESTION_B.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").first('n')).toBe(0);
 console.info(JSON.stringify({event:'cache_date_cursor_local_transfer',emptyHighWaterPreserved:true,staleCasRefused:true,
  proof:captured.transfer.proof,capture:captured.profile,import:imported.importProfile,verification:imported.proofProfile}));
},30_000);
for(const damage of ['lowered','missing'] as const)it(`refuses ${damage} imported empty sequence high-water against exact captured proof`,async()=>{
 await cursorSetup();await boundedCursor(db=>initialize(db));
 await boundedCursor(db=>retireCacheDateCursorPage(db,sourceId));
 const exact=await captureAcceptedSourceTransfer(target(),'target');
 // Deliberate local corruption negative, never a restore implementation or a
 // substitute exporter. Both transfers remain verbatim native exports.
 await boundedCursor(db=>damage==='lowered'
  ?db.prepare('UPDATE sqlite_sequence SET seq=0 WHERE name=?').bind(table).run()
  :db.prepare('DELETE FROM sqlite_sequence WHERE name=?').bind(table).run());
 const damaged=await captureAcceptedSourceTransfer(target(),'target');
 expect(damaged.transfer.proof.autoIncrementSequenceSha256).not.toBe(exact.transfer.proof.autoIncrementSequenceSha256);
 const expected={...damaged.transfer,proof:{...damaged.transfer.proof,
  autoIncrementSequenceSha256:exact.transfer.proof.autoIncrementSequenceSha256}};
 await expect(importAcceptedSourceTransfer(expected,b.STORAGE_INGESTION_A,'target')).rejects.toThrow('accepted source import exact proof mismatch');
},30_000);
it('authentic owner erasure removes scheduling metadata and blocks recreation',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const measured=measurement(),run=measured.run;
 const days=[2,1].map(n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10));
 const {bad}=await seedConflict(run,days);
 const cursor=(await boundedCursor(db=>initialize(db,bad.ownerDigest)))!;expect(cursor).not.toBeNull();
 const profile=createAnalyticsProfile();
 async function invocation<T>(fn:(db:{source:D1Database;target:D1Database;ledger:D1Database})=>Promise<T>){
  const meter=createD1InvocationBudget(950),before=Object.values(profile.costs).reduce((n,row)=>n+row.statements,0);
  const db={source:meter.wrap(profileAnalyticsDatabase(source(),'source',profile,()=> 'erasure_control')),
   target:meter.wrap(profileAnalyticsDatabase(target(),'target',profile,()=> 'erasure_control')),
   ledger:meter.wrap(profileAnalyticsDatabase(b.DELETION_LEDGER,'ledger',profile,()=> 'erasure_control'))};
  try{return await fn(db);}finally{expect(Object.values(profile.costs).reduce((n,row)=>n+row.statements,0)-before).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);}
 }
 await invocation(async db=>{
  const configured={...b,ENVIRONMENT:'synthetic-development',USAGE_MONITOR_DB:db.source,DELETION_LEDGER:db.ledger} as Env;
  Reflect.set(configured,'TELEMETRY_STORAGE_MODE','typed');Reflect.set(configured,'TELEMETRY_STORAGE_NAMESPACE',sourceNamespace);Reflect.set(configured,'ANALYTICS_DB',db.target);
  try{expect((await eraseParticipantAsOwner(configured,'synthetic-cursor-owner',bad.participantId)).deleted).toBe(true);}
  catch(error){if(!(error instanceof ApiError)||error.code!=='BACKEND_STORAGE_UNAVAILABLE')throw error;expect(await hasDeletionTombstone(db.ledger,bad.participantId)).toBe(true);}
 });
 let complete=false;for(let pass=0;pass<256;pass++){
  const result=await invocation(db=>advanceStorageErasureJobs({...db,sourceId,sourceNamespace},{maxJobs:1}));if(!result.pending){complete=true;break;}
 }
 expect(complete).toBe(true);
 await invocation(async db=>{
  await requireStorageParticipantErasureComplete(db.ledger,bad.participantId,{...db,sourceId,sourceNamespace});
  expect(await readCacheDateCursor(db.target,sourceId,bad.ownerDigest)).toBeNull();
  await expect(initialize(db.target,bad.ownerDigest)).rejects.toThrow();
  expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(bad.participantId).first('n')).toBe(0);
 });
 expect(profile.measurementFailures).toBe(0);
},120_000);
// Add to the off-tree native cursor spec after root approves table+six guards.
// These are isolated target metadata fault controls, not an owner authorization
// claim or a valid production restore. Genuine owner erasure is a separate case.
it('replays an identical retained fence synchronously after a refused partial derived state',async()=>{
 await cursorSetup();const before=(await boundedCursor(db=>initialize(db)))!;
 const insert=CACHE_DATE_CURSOR_SCHEMA.find(row=>row.name===table+'_erasure')!;
 const replay=CACHE_DATE_CURSOR_SCHEMA.find(row=>row.name===table+'_erasure_replay')!;
 await boundedCursor(async db=>{
  await db.prepare(`DROP TRIGGER ${insert.name}`).run();
  expect(await cacheDateCursorMode(db)).toBe('unavailable');
  await db.prepare(`INSERT INTO analytics_storage_erasure_fences
   (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
   VALUES(?,?,?,1,1,1,1)`).bind(sourceId,owner,'b'.repeat(64)).run();
  // Fault injection deliberately preserves the pre-fence numeric row. The
  // missing trigger is never treated as a supported serving/restore contract.
  expect(await readCacheDateCursor(db,sourceId,owner)).toEqual(before);
  await db.prepare(insert.sql).run();expect(await cacheDateCursorMode(db)).toBe('installed');
  await expect(forward(db,before)).rejects.toThrow();
  const high=await db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first('seq');
  await db.prepare(`UPDATE analytics_storage_erasure_fences SET terminal_event_digest=terminal_event_digest,
   terminal_sequence=terminal_sequence,terminal_revision=terminal_revision,authority_epoch=authority_epoch,
   public_authority_epoch=public_authority_epoch WHERE source_id=? AND owner_digest=?`).bind(sourceId,owner).run();
  expect(await readCacheDateCursor(db,sourceId,owner)).toBeNull();
  expect(await db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first('seq')).toBe(high);
  expect(await db.prepare('SELECT count(*) n FROM analytics_storage_erasure_fences WHERE source_id=? AND owner_digest=?').bind(sourceId,owner).first('n')).toBe(1);
  await db.prepare(`DROP TRIGGER ${replay.name}`).run();expect(await cacheDateCursorMode(db)).toBe('unavailable');
 });
});
it('deletes only the matching cursor before native owner deletion and retains sequence high-water',async()=>{
 await cursorSetup();await boundedCursor(async db=>{
  const before=(await initialize(db))!,other='c'.repeat(64);
  await db.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(sourceId,other).run();
  const survivor=(await initialize(db,other))!;
  const high=await db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first('seq');
  await db.prepare('DELETE FROM analytics_owner_state WHERE source_id=? AND owner_digest=?').bind(sourceId,owner).run();
  expect(await readCacheDateCursor(db,sourceId,owner)).toBeNull();expect(await readCacheDateCursor(db,sourceId,other)).toEqual(survivor);
  expect(await db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(table).first('seq')).toBe(high);
  expect(await forward(db,before)).toBeNull();
  const guard=CACHE_DATE_CURSOR_SCHEMA.find(row=>row.name===table+'_owner_delete')!;
  await db.prepare(`DROP TRIGGER ${guard.name}`).run();expect(await cacheDateCursorMode(db)).toBe('unavailable');
 });
});
async function nativeEmptyOwnerDay(run:ReturnType<typeof measurement>['run'],device:Device){
 const predecessor=await run('admission',({source})=>createTelemetryV11DomainPredecessor(source,device));
 expect(predecessor.previousGenerationId).toBeNull();
 expect(predecessor.fromDay).toBe(predecessor.throughDay);
 return predecessor.throughDay;
}
async function acceptNativeV11Day(run:ReturnType<typeof measurement>['run'],device:Device,day:string,count:number){
 const prepared=await makeV11Day(day,{usage:Array.from({length:count},(_,index)=>{
  const eventTime=`${day}T00:00:${String(index).padStart(2,'0')}.000Z`;
  expect(Date.parse(eventTime)).toBeLessThan(Date.now());
  return v11UsageRecord(day,'a',{eventId:occurrence(9,0,index),eventTime});
 })});
 const staged=await run('admission',({source})=>registerTelemetryV11DayManifest(source,device,prepared.manifest));
 for(const chunk of prepared.chunks)await run('admission',async({source})=>{
  const envelopeDigest=await sha256Hex(canonicalTelemetryV11Json(chunk));
  const auth=await createDeviceUploadAuthorization(source,await authenticateDevice(source,device.authorization),envelopeDigest,1000);
  const claim=await claimDeviceUploadAuthorization(source,`Upload ${auth.uploadAuthorization}`,{envelopeDigest,bodyBytes:1000,contentType:'application/json'});
  await persistTypedV11StagedChunk(source,device,chunk,{sourceNamespace,chunkRowId:`chunk:${crypto.randomUUID()}`,
   r2Key:`synthetic/date-siblings/${crypto.randomUUID()}`,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
 });
 await run('admission',async({source})=>{
  const prior=await createTelemetryV11DomainPredecessor(source,device);
  expect(prior.fromDay).toBe(day);expect(prior.throughDay).toBe(day);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:prior.fromDay,throughDay:prior.throughDay,
   predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
   days:[{day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest}],manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source,device,manifest);
 });
 return staged;
}
it('visits both genuinely delivered same-day legacy tuples after a throwing first reservation',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const measured=measurement(),run=measured.run;
 const device=await run('admission',({source})=>createV11DeviceFixture(source,{grant:true}));
 await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source));
 const day=await nativeEmptyOwnerDay(run,device);
 const prior=await acceptNativeV11Day(run,device,day,2);await deliver(run,target(),1);
 const current=await acceptNativeV11Day(run,device,day,3);await deliver(run,target(),1);
 expect(current.manifestDigest).not.toBe(prior.manifestDigest);
 const selected=await run('proof',async({target})=>{
  const rows=(await target.prepare(`SELECT DISTINCT source_id,source_layout,source_namespace,owner_digest,
   device_id,manifest_id,manifest_digest,day FROM analytics_v11_reusable_values WHERE source_id=? AND day=?
   ORDER BY day,owner_digest,device_id,source_layout,source_namespace,manifest_id,manifest_digest`).bind(sourceId,day)
   .all<{source_id:string;source_layout:string;source_namespace:string;owner_digest:string;device_id:string;manifest_id:string;manifest_digest:string;day:string}>()).results;
  // This precondition must be native truth. If normal ordered delivery retires
  // the older tuple before this boundary, retain the fixture failure; never add it.
  expect(rows).toHaveLength(2);expect(rows.map(row=>row.manifest_digest).sort()).toEqual([prior.manifestDigest,current.manifestDigest].sort());
  expect(await target.prepare("SELECT count(*) n FROM analytics_community_daily_owners WHERE source_id=? AND day=? AND complete=1").bind(sourceId,day).first('n')).toBe(0);
  return rows;
 });
 const currentRow=selected.find(row=>row.manifest_digest===current.manifestDigest)!;
 const key:CacheRetentionDayCandidate={sourceId,sourceNamespace,sourceLayout:'typed-v11',ownerDigest:currentRow.owner_digest,
  deviceId:currentRow.device_id,manifestId:currentRow.manifest_id,manifestDigest:currentRow.manifest_digest,day};
 const carry=await run('proof',({target})=>readCacheRetentionCarryDays(target,key));
 const direct=await run('reference',({source,target,meter})=>createCacheRetentionDaySourceBuild({source,target,sourceNamespace})(key,carry,
  {remainingQueries:300,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000}));
 expect(direct.eventsRead).toBe(3);
 let fired=false;
 await expect(run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
  build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace,now:()=>{fired=true;throw new Error('SYNTHETIC_NATIVE_AFTER_DATE_RESERVATION');}}),
  remainingQueries:650,sourceQueries:300,sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,maxDays:1,maxWrites:48,fromDay:day})))
  .rejects.toThrow('SYNTHETIC_NATIVE_AFTER_DATE_RESERVATION');expect(fired).toBe(true);
 const reserved=await run('proof',({target})=>readCacheDateCursor(target,sourceId,key.ownerDigest));
 expect(reserved?.day_slot_limit).toBe(2);expect(reserved?.next_ordinal).toBe(1);
 for(let attempt=0;attempt<4;attempt++)await run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
  build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace}),remainingQueries:650,sourceQueries:300,
  sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,maxDays:1,maxWrites:48,fromDay:day}));
 const actual=await run('proof',({target})=>readCacheRetentionDay({target,key,carry}));expect(actual.status).toBe('ready');
 if(actual.status!=='ready')throw new Error('SYNTHETIC_NATIVE_CURRENT_SIBLING_ABSENT');expect(actual.aggregate).toEqual(direct);
 console.info(JSON.stringify({event:'cache_date_native_siblings',nativeTuples:2,firstReservationThrew:true,
  aggregateSha256:await sha256Hex(canonicalJson(actual.aggregate)),cost:measured.receipt(),componentOnly:true}));
},120_000);

for(const race of ['initialization_exhausted','attempt_cas_lost'] as const)
it(`bounds actual native date scheduling after ${race}`,async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const measured=measurement(),run=measured.run;
 const device=await run('admission',({source})=>createV11DeviceFixture(source,{grant:true}));
 await run('admission',({source})=>drainCommunityPublicSourceBootstrap(source));
 const day=await nativeEmptyOwnerDay(run,device);
 const dayKey=Date.parse(day+'T00:00:00.000Z')/86400000;
 await acceptNativeV11Day(run,device,day,2);await deliver(run,target(),1);
 const selected=await run('proof',async({target})=>{
  const rows=(await target.prepare(`SELECT DISTINCT owner_digest FROM analytics_v11_reusable_values
   WHERE source_id=? AND day=?`).bind(sourceId,day).all<{owner_digest:string}>()).results;
  expect(rows).toHaveLength(1);expect(await readCacheDateCursor(target,sourceId,rows[0]!.owner_digest)).toBeNull();return rows[0]!;
 });
 let fired=false,competingDispatches=0;
 const counts={allTarget:0,read:0,initialize:0,select:0,cas:0,casCapability:0,mode:0};
 const outcome=await run('cache',async({source,target,meter})=>{
  const observed=new Proxy(target,{get(db,key){
   if(key!=='prepare'){const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}
   return(sql:string)=>{
    const compact=sql.replace(/\s+/gu,' ').trim();
    const kind=compact.startsWith('SELECT cursor_id,cycle_upper_day,next_day,next_ordinal,day_slot_limit,revision')?'read'
     :compact.startsWith(`INSERT INTO ${table}`)?'initialize'
     :compact.startsWith(`UPDATE ${table}`)?'cas'
     :compact.startsWith('WITH universe AS (')||compact.startsWith('SELECT * FROM (SELECT * FROM (')?'select'
     :compact.startsWith('SELECT CASE WHEN ')&&compact.includes(table)
      ?compact.endsWith('END ready')?'casCapability':'mode':null;
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(st,method){
     if(method==='bind')return(...args:unknown[])=>wrap(st.bind(...args));
     if(method==='first'||method==='all'||method==='run'||method==='raw')return async(...args:unknown[])=>{
      counts.allTarget++;if(kind)counts[kind]++;
      if(!fired&&((race==='initialization_exhausted'&&kind==='initialize')||(race==='attempt_cas_lost'&&kind==='cas'))){
       fired=true;
       // A real second invocation over the same physical target. Its own650/950
       // meters/profile include all native helper SQL; no result is fabricated.
       await boundedCursor(async concurrent=>{
        const counted=new Proxy(concurrent,{get(other,key){
         if(key!=='prepare'){const value=Reflect.get(other,key);return typeof value==='function'?value.bind(other):value;}
         return(sql:string)=>{const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(st,k){
          if(k==='bind')return(...args:unknown[])=>wrap(st.bind(...args));
          if(k==='first'||k==='all'||k==='run'||k==='raw')return(...args:unknown[])=>{competingDispatches++;return Reflect.apply(Reflect.get(st,k),st,args);};
          const value=Reflect.get(st,k);return typeof value==='function'?value.bind(st):value;
         }});return wrap(other.prepare(sql));};
        }});
        const before=race==='initialization_exhausted'
         ?await initializeCacheDateCursor(counted,sourceId,selected.owner_digest,dayKey,dayKey)
         :await readCacheDateCursor(counted,sourceId,selected.owner_digest);
        expect(before).not.toBeNull();if(!before)throw new Error('SYNTHETIC_DATE_RACE_ROW_ABSENT');
        const advanced=await advanceCacheDateCursor(counted,sourceId,selected.owner_digest,before,
         cacheDateAfterAttempt(before,dayKey,0,1));
        expect(advanced?.next_day).toBe(dayKey+1);expect(advanced?.revision).toBe(before.revision+1);
       });
      }
      return Reflect.apply(Reflect.get(st,method),st,args);
     };
     const value=Reflect.get(st,method);return typeof value==='function'?value.bind(st):value;
    }});return wrap(db.prepare(sql));
   };
  }});
  const result=await advanceCacheRetentionDayLane({target:observed,sourceId,
   build:createCacheRetentionDaySourceBuild({source,target:observed,sourceNamespace}),remainingQueries:650,
   sourceQueries:300,sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,
   maxDays:1,maxWrites:48,fromDay:day});
  expect(result.actualBudget?.chargedTotalStatements).toBe(meter.queriesUsed);
  expect(result.actualBudget?.chargedTargetStatements).toBe(counts.allTarget);
  expect(result.actualBudget?.chargedBuildStatements).toBe(0);return result;
 });
 expect(fired).toBe(true);expect(outcome.built).toBe(0);expect(outcome.candidates).toBe(0);
 expect(outcome.reason).toBe(race==='initialization_exhausted'?'date_cycle':'cursor_changed');
 const helperDispatches=counts.read+counts.initialize+counts.select+counts.cas+counts.casCapability;
 expect(helperDispatches).toBe(race==='initialization_exhausted'?4:8);
 expect(counts).toEqual(race==='initialization_exhausted'
  ?{allTarget:8,read:2,initialize:1,select:1,cas:0,casCapability:0,mode:1}
  :{allTarget:11,read:2,initialize:1,select:3,cas:1,casCapability:1,mode:1});
 expect(competingDispatches).toBe(race==='initialization_exhausted'?3:2);
 const saved=await run('proof',({target})=>readCacheDateCursor(target,sourceId,selected.owner_digest));
 expect(saved?.next_day).toBe(dayKey+1);expect(saved?.revision).toBe(2);
 // The next ordinary invocation can wrap the acknowledged exhausted cursor
 // and perform its original native source/fold/write, without resetting it.
 const resumed=await run('cache',({source,target,meter})=>advanceCacheRetentionDayLane({target,sourceId,
  build:createCacheRetentionDaySourceBuild({source,target,sourceNamespace}),remainingQueries:650,sourceQueries:300,
  sharedRemainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,maxDays:1,maxWrites:48,fromDay:day}));
 expect(resumed.built).toBe(1);
 const after=await run('proof',({target})=>readCacheDateCursor(target,sourceId,selected.owner_digest));
 expect(after?.cursor_id).toBe(saved?.cursor_id);expect(after?.revision).toBe(4);expect(after?.next_day).toBe(dayKey+1);
 console.info(JSON.stringify({event:'cache_date_cursor_initialization_race',race,helperDispatches,
  targetDispatches:counts.allTarget,competingDispatches,counts,firstActualBudget:outcome.actualBudget,
  resumedActualBudget:resumed.actualBudget,cost:measured.receipt(),componentOnly:true}));
},120_000);
