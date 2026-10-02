import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import * as budgetModule from '../src/d1-invocation-budget';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import * as canonical from '../src/storage-canonical-analytics-input';
import {advanceCanonicalInputWork,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {materializeCanonicalPartition,readCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {advanceAnalyticsCacheWork} from '../src/storage-analytics-cache-work';
import {readAnalyticsWorkClosureFence} from '../src/storage-analytics-closure-fence';
import {readStorageCommunityOwner} from '../src/storage-community-authority';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {canonicalOccurrenceKey} from '../src/canonical-analytics-facts';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {canonicalTelemetryV11Json,telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {authenticateDevice,claimDeviceUploadAuthorization,createDeviceUploadAuthorization} from '../src/device-auth';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {eraseParticipantAsOwner} from '../src/participant-erasure';
import {advanceStorageErasureJobs,requireStorageParticipantErasureComplete} from '../src/storage-erasure';
import {hasDeletionTombstone} from '../src/retention';
import type {AnalyticsWorkLease} from '../src/analytics-partition-work';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,
 type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {sha256Hex} from '../src/crypto';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,makeV11Day,stageV11Day,v11UsageRecord} from './helpers/telemetry-v11';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;
 TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-cache-prerequisite';
type InputRow={state:string;source_stamp:string;version:number;seen_count:number;page_ordinal:number};
const inputRow=(scope:CanonicalInputScope)=>target().prepare(`SELECT state,source_stamp,version,seen_count,page_ordinal
 FROM analytics_canonical_input_work WHERE source_id=? AND owner_digest=? AND source_day=?
  AND stream=? AND selection_method=?`).bind(scope.sourceId,scope.ownerDigest,scope.day,
 scope.stream,scope.selectionMethod).first<InputRow>();
async function cover(participantId:string) {
 let complete=false;
 for(let pass=0;pass<48;pass++) {
  const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
   participantId,maxSteps:64,maxRows:128});
  expect(progress.status).not.toBe('unavailable');
  if(progress.status==='complete'){complete=true;break;}
 }
 expect(complete).toBe(true);
}
async function fixture(stale=true) {
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:1,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 await cover(corpus.participantId);
 const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
  participantId:corpus.participantId,day:corpus.correctionDay,stream:'usage',selectionMethod:'effective-union-v1'};
 let sealed=false;
 for(let pass=0;pass<32;pass++) {
  const progress=await advanceCanonicalInputWork(source(),target(),{...scope,
   budget:{meter:createD1InvocationBudget(900),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}});
  if(progress.state==='complete'){sealed=true;expect(progress.seal).toBeTruthy();break;}
  expect(progress.state).toBe('progress');
 }
 expect(sealed).toBe(true);
 const key=await target().prepare(`SELECT partition_key FROM analytics_canonical_facts
  WHERE source_id=? AND owner_digest=? AND observed_day=? AND stream='usage'
  AND selection_method='effective-union-v1' ORDER BY revision LIMIT 1`)
  .bind(sourceId,scope.ownerDigest,scope.day).first<string>('partition_key');
 expect(key).toBeTruthy();
 const materialized=await materializeCanonicalPartition(target(),key!);
 expect(materialized.state).toBe('complete');
 const partition=await readCanonicalPartition(target(),key!);
 expect(partition?.manifest.rowCount).toBeGreaterThan(0);
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'cache',lane:'new',
  partitionKey:key!,headKey:await sha256Hex('cache-prerequisite-leaf'),
  inputRevision:partition!.manifest.contentRevision,policyRevision:'c'.repeat(64),day:scope.day,
  stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1024*1024,admissionQueries:160};
 const [workKey]=await admitAnalyticsPartitionWork(target(),[request],Date.now());
 expect(workKey).toBeTruthy();
 const before=await inputRow(scope);expect(before?.state).toBe('sealed');
 if(stale){await corpus.mutateCorrection();await cover(corpus.participantId);}
 return {scope,workKey:workKey!,before,corpus,manifest:partition!.manifest};
}
async function execute(lease:AnalyticsWorkLease,remaining=950,time=Date.now()) {
 const outer=createD1InvocationBudget(950),meter=createD1InvocationBudget(Math.min(900,remaining));
 const profile=createAnalyticsProfile();
 const db=outer.wrap(profileAnalyticsDatabase(target(),'target',profile,()=> 'cache_prerequisite'));
 const src=outer.wrap(profileAnalyticsDatabase(source(),'source',profile,()=> 'cache_prerequisite'));
 const start=outer.queriesUsed;
 const result=await advanceAnalyticsCacheWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,database:src}],lease,
  budget:{meter,now:()=>time,deadlineMs:time+60_000,
   remainingQueries:()=>Math.min(outer.remainingQueries,meter.remainingQueries)}});
 expect(result.statements).toBe(meter.queriesUsed);
 expect(outer.queriesUsed-start).toBe(meter.queriesUsed);
 expect(outer.queriesUsed).toBeLessThanOrEqual(950);
 const observed=summarizeAnalyticsProfile(profile);
 expect(observed.statements).toBe(outer.queriesUsed);
 return {result,outerQueries:outer.queriesUsed,workQueries:meter.queriesUsed,
  rowsRead:observed.rowsRead,rowsWritten:observed.rowsWritten};
}
const children=(workKey:string)=>target().prepare(`SELECT count(*) n FROM analytics_partition_work_links
 WHERE parent_work_key=?`).bind(workKey).first<number>('n');

it('makes only bounded canonical input progress for a real stale-seal cache lease, then defers private completion',async({task})=>{
 const {scope,workKey,before}=await fixture();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const make=budgetModule.createD1InvocationBudget;
 let childMeter:ReturnType<typeof make>|undefined;
 const meterFactory=vi.spyOn(budgetModule,'createD1InvocationBudget').mockImplementation(max=>{
  const meter=make(max);if(max===300)childMeter=meter;return meter;
 });
 const context=vi.spyOn(canonical,'createCanonicalInputReadContext');
 const producer=vi.spyOn(canonical,'advanceCanonicalInputWork');
 let measured:Awaited<ReturnType<typeof execute>>;
 try {
  measured=await execute(lease,950,now+1);
  const observed=await inputRow(scope);
  Object.assign(task.meta,{cachePrerequisiteBaseline:{
   setupAuthority:'synthetic target mirror; source evidence accepted through native writers',
   before:{state:before?.state,version:before?.version,seenCount:before?.seen_count,
    pageOrdinal:before?.page_ordinal},
   after:{state:observed?.state,version:observed?.version,seenCount:observed?.seen_count,
    pageOrdinal:observed?.page_ordinal},
   stampChanged:observed?.source_stamp!==before?.source_stamp,
   cacheOutcome:measured.result.outcome,cacheReason:measured.result.reason,
   childCalls:meterFactory.mock.calls.filter(([max])=>max===300).length,
   childQueries:childMeter?.queriesUsed??null,
   outerQueries:measured.outerQueries,workQueries:measured.workQueries,
   rowsRead:measured.rowsRead,rowsWritten:measured.rowsWritten}});
  expect(childMeter).toBeDefined();expect(childMeter!.queriesUsed).toBeGreaterThan(0);
  expect(childMeter!.queriesUsed).toBeLessThanOrEqual(300);
  expect(context).toHaveBeenCalledTimes(2);expect(producer).toHaveBeenCalledTimes(1);
  expect(producer.mock.calls[0]![0]).toBe(context.mock.calls[1]![0]);
  expect(producer.mock.calls[0]![1]).toBe(context.mock.calls[1]![1]);
  expect(producer.mock.calls[0]![2].budget.maxSteps).toBe(4);
  expect(producer.mock.calls[0]![2].budget.meter).toBe(childMeter);
 } finally {
  meterFactory.mockRestore();context.mockRestore();producer.mockRestore();
 }
 const {result,outerQueries,workQueries,rowsRead,rowsWritten}=measured;
 expect(result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 const after=await inputRow(scope);
 expect(after).toBeTruthy();
 expect(after?.source_stamp!==before?.source_stamp||after!.version>before!.version
  ||after!.seen_count>before!.seen_count||after!.page_ordinal>before!.page_ordinal).toBe(true);
 expect(outerQueries).toBe(workQueries);expect(outerQueries).toBeLessThanOrEqual(950);
 expect(rowsRead).toBeGreaterThan(0);expect(rowsWritten).toBeGreaterThan(0);
 expect(await children(workKey)).toBe(0);
 expect(await readAnalyticsWorkClosureFence({source:source(),target:target(),sourceId,
  sourceNamespace:sourceId})).toBeNull();
 expect(await target().prepare(`SELECT state FROM analytics_partition_work WHERE work_key=?`)
  .bind(workKey).first<string>('state')).toBe('leased');
 const releaseMeter=createD1InvocationBudget(950);
 expect(await releaseAnalyticsPartitionWork(releaseMeter.wrap(target()),lease,'deferred',now+2)).toBe(true);
 expect(releaseMeter.queriesUsed).toBeGreaterThan(0);
},120_000);

it('does not prepare on a lost cache lease or without the 300-query child plus release reserve',async()=>{
 const {scope,workKey,before}=await fixture();
 const now=Date.now(),lost=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:1000,stages:['cache']}))[0]!;
 expect(lost.workKey).toBe(workKey);
 expect((await execute(lost,950,lost.expiresAtMs+1)).result).toMatchObject({outcome:'deferred',reason:'lease_changed'});
 expect(await inputRow(scope)).toEqual(before);
 const fresh=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:lost.expiresAtMs+1,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(fresh.workKey).toBe(workKey);
 const low=await execute(fresh,331,lost.expiresAtMs+2);
 // The failed full proof itself consumes statements. Whatever remains below
 // 332 after that proof cannot enter the child producer.
 expect(low.result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey)).toBe(0);
},120_000);

it('keeps a stale source scope deferred when a real native capability disappears, then restores normal preparation',async()=>{
 const {scope,workKey,before}=await fixture();
 const name='storage_effective_selective_sequence_guard';
 const sql=await source().prepare(`SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?`)
  .bind(name).first<string>('sql');
 expect(sql).toBeTruthy();
 await source().prepare('DROP TRIGGER '+name).run();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 try {
  expect((await execute(lease,950,now+1)).result).toMatchObject({outcome:'deferred',
   reason:'canonical_input_unsealed',completedWithinLease:false});
  expect(await inputRow(scope)).toEqual(before);
  expect(await children(workKey)).toBe(0);
 } finally {await source().prepare(sql!).run();}
 const resumed=await execute(lease,950,now+2);
 expect(resumed.result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',
  completedWithinLease:false});
 const after=await inputRow(scope);
 expect(after?.source_stamp!==before?.source_stamp||after!.version>before!.version
  ||after!.seen_count>before!.seen_count||after!.page_ordinal>before!.page_ordinal).toBe(true);
 expect(await children(workKey)).toBe(0);
},120_000);

it('does not promote a cache child when its real metered canonical preparation budget expires',async()=>{
 const {scope,workKey,before}=await fixture();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const create=budgetModule.createD1InvocationBudget;
 const child=vi.spyOn(budgetModule,'createD1InvocationBudget').mockImplementation(max=>create(max===300?1:max));
 try {
  const {result}=await execute(lease,950,now+1);
  expect(child).toHaveBeenCalledWith(300);
  expect(result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 } finally {child.mockRestore();}
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey)).toBe(0);
},120_000);

it('refuses source mutation after acquiring the prerequisite context without cache completion',async()=>{
 const {scope,workKey,before,corpus}=await fixture();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const original=canonical.advanceCanonicalInputWork;
 const producer=vi.spyOn(canonical,'advanceCanonicalInputWork').mockImplementation(async(...args)=>{
  await corpus.appendOutsideV11();
  return original(...args);
 });
 try {
  const {result}=await execute(lease,950,now+1);
  expect(producer).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 } finally {producer.mockRestore();}
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey)).toBe(0);
},120_000);

it('does not enter canonical preparation after the held cache lease is released during context acquisition',async()=>{
 const {scope,workKey,before}=await fixture();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const original=canonical.createCanonicalInputReadContext;
 let contexts=0;
 const create=vi.spyOn(canonical,'createCanonicalInputReadContext').mockImplementation(async(...args)=>{
  const context=await original(...args);
  contexts++;
  if(contexts===2&&context)expect(await releaseAnalyticsPartitionWork(target(),lease,'deferred',now+1)).toBe(true);
  return context;
 });
 try {
  const {result}=await execute(lease,950,now+1);
  expect(contexts).toBe(2);
  expect(result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 } finally {create.mockRestore();}
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey)).toBe(0);
},120_000);

it('retains the original missing-head and dirty-generation refusals before any prerequisite work',async()=>{
 for(const mode of ['missing_head','stale_dirty_generation'] as const) {
  const {scope,workKey,before,manifest}=await fixture();
  const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
   nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
  expect(lease.workKey).toBe(workKey);
  if(mode==='missing_head')await target().prepare('DELETE FROM analytics_canonical_partition_heads WHERE partition_key=?')
   .bind(manifest.partitionKey).run();
  else {
   const root=await target().prepare('SELECT root_partition_key FROM analytics_canonical_manifests WHERE content_revision=?')
    .bind(manifest.contentRevision).first<string>('root_partition_key');
   expect(root).toBeTruthy();
   // This is a deliberately stale target generation, as after a later
   // admitted effect; it changes no fact or source payload.
   await target().prepare(`INSERT INTO analytics_canonical_dirty_partitions(partition_key,generation)
    VALUES(?,?) ON CONFLICT(partition_key) DO UPDATE SET generation=generation+1`)
    .bind(root,manifest.generation+1).run();
  }
  const {result}=await execute(lease,950,now+1);
  expect(result).toMatchObject({outcome:'deferred',reason:'manifest_changed',completedWithinLease:false});
  expect(await inputRow(scope)).toEqual(before);
  expect(await children(workKey)).toBe(0);
 }
},120_000);

it('fails closed when the dirty-generation schema is absent, without a cache child or input rewrite',async()=>{
 const {scope,workKey,before}=await fixture();
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 await target().prepare('DROP TABLE analytics_canonical_dirty_partitions').run();
 const create=budgetModule.createD1InvocationBudget;
 const child=vi.spyOn(budgetModule,'createD1InvocationBudget').mockImplementation(max=>create(max));
 try {
  await expect(execute(lease,950,now+1)).rejects.toThrow(/no such table: analytics_canonical_dirty_partitions/u);
  expect(child.mock.calls.some(([max])=>max===300)).toBe(false);
 } finally {child.mockRestore();}
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey)).toBe(0);
},120_000);

it('refuses the native owner terminal and physical erasure without recreating its cache leaf',async()=>{
 const {scope,workKey,corpus}=await fixture();
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const configured={...b,ANALYTICS_DB:target(),STORAGE_ANALYTICS_DB:target(),
  TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:sourceId,
  ENVIRONMENT:'synthetic-development'} as unknown as Env;
 // actorIdentityKey is the synthetic admin audit actor, not the owner key.
 // The exact source participantId selects the native owner-erasure target.
 try {expect((await eraseParticipantAsOwner(configured,'synthetic-admin',corpus.participantId)).deleted).toBe(true);}
 catch(error) {if(!error||typeof error!=='object'||Reflect.get(error,'code')!=='BACKEND_STORAGE_UNAVAILABLE')throw error;
  expect(await hasDeletionTombstone(b.DELETION_LEDGER,corpus.participantId)).toBe(true);}
 expect(await readStorageCommunityOwner(source(),{ownerDigest:scope.ownerDigest})).toBeNull();
 const immediate=await execute(lease,950,now+1);
 expect(immediate.result.outcome).not.toBe('complete');
 expect(immediate.result.completedWithinLease).toBe(false);
 expect(await children(workKey)).toBe(0);
 const bindings={source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace:sourceId};
 let completed=false;
 for(let page=0;page<32;page++){
  const step=await advanceStorageErasureJobs(bindings,{maxJobs:1});
  if(!step.pending){completed=true;break;}
 }
 expect(completed).toBe(true);
 await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,corpus.participantId,bindings);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?')
  .bind(scope.ownerDigest).first<number>('n')).toBe(0);
 const physical=await execute(lease,950,now+2);
 expect(physical.result.outcome).not.toBe('complete');
 expect(physical.result.completedWithinLease).toBe(false);
 expect(await children(workKey)).toBe(0);
},120_000);

it('keeps a previously private cache result unpublishable after a genuine later source correction and dirty effect',async()=>{
 const {scope,workKey,manifest,corpus}=await fixture(false);
 const now=Date.now(),lease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,
  nowMs:now,leaseMs:60_000,stages:['cache']}))[0]!;
 expect(lease.workKey).toBe(workKey);
 const first=await execute(lease,950,now+1);
 expect(first.result).toMatchObject({outcome:'complete',reason:'cache_prepared',completedWithinLease:true});
 const oldCache=await target().prepare(`SELECT content_revision FROM analytics_canonical_cache_partitions
  WHERE partition_key=?`).bind(manifest.partitionKey).first<string>('content_revision');
 expect(oldCache).toBe(manifest.contentRevision);
 await corpus.mutateCorrection();await cover(corpus.participantId);
 let sealed=false;
 for(let pass=0;pass<16;pass++){
  const progress=await advanceCanonicalInputWork(source(),target(),{...scope,
   budget:{meter:createD1InvocationBudget(900),maxSteps:4,now:Date.now,deadlineMs:Date.now()+60_000}});
  if(progress.state==='complete'){sealed=true;break;}
  expect(progress.state).toBe('progress');
 }
 expect(sealed).toBe(true);
 for(let page=0;page<16;page++)await advanceAnalyticsWorkEffects({source:source(),target:target(),
  sourceId,sourceNamespace:sourceId,meter:createD1InvocationBudget(950),now:Date.now,
  deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
 const root=await target().prepare(`SELECT root_partition_key FROM analytics_canonical_manifests
  WHERE content_revision=?`).bind(manifest.contentRevision).first<string>('root_partition_key');
 expect(root).toBeTruthy();
 const generation=await target().prepare(`SELECT generation FROM analytics_canonical_dirty_partitions
  WHERE partition_key=?`).bind(root).first<number>('generation');
 expect(generation).toBeGreaterThan(manifest.generation);
 expect(await readCanonicalPartition(target(),manifest.partitionKey)).toBeNull();
 // The accepted non-noop effect invalidates the old private marker through
 // analytics_canonical_cache_effect; it must not survive as a publishable head.
 expect(await target().prepare(`SELECT content_revision FROM analytics_canonical_cache_partitions
  WHERE partition_key=?`).bind(manifest.partitionKey).first<string>('content_revision')).toBeNull();
 expect(await readAnalyticsWorkClosureFence({source:source(),target:target(),sourceId,
  sourceNamespace:sourceId})).toBeNull();
 expect(await target().prepare(`SELECT count(*) n FROM analytics_canonical_publication_closures
  WHERE family='cache' AND state='complete'`).first<number>('n')).toBe(0);
},120_000);

it('never guesses one owner from a mixed accepted leaf with the synthetic target authority mirror',async()=>{
 const {scope,manifest,before}=await fixture();
 const device=await createV11DeviceFixture(source(),{grant:true});
 const nowEpoch=Date.now(),today=new Date(nowEpoch).toISOString().slice(0,10);
 const firstMs=Date.parse(scope.day+'T00:00:00.000Z');
 const lastMs=Date.parse(today+'T00:00:00.000Z');
 expect((lastMs-firstMs)/86_400_000).toBeLessThanOrEqual(14);
 const readyByDay=new Map<string,Awaited<ReturnType<typeof stageV11Day>>>();
 for(let ms=firstMs;ms<=lastMs;ms+=86_400_000){
  const day=new Date(ms).toISOString().slice(0,10);
  readyByDay.set(day,await stageV11Day(source(),device,await makeV11Day(day,{},'mixed-cache-empty')));
 }
 const activate=async(replacement?:Awaited<ReturnType<typeof stageV11Day>>)=>{
  if(replacement)readyByDay.set(replacement.day,replacement);
  const prior=await createTelemetryV11DomainPredecessor(source(),device,nowEpoch);
  const days=[...readyByDay.values()].sort((a,b)=>a.day.localeCompare(b.day));
  expect(days[0]?.day).toBe(scope.day);
  expect(days.at(-1)?.day).toBe(today);
  expect(prior.fromDay>=scope.day&&prior.throughDay<=today).toBe(true);
  const domain:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:scope.day,throughDay:today,
   predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
    legacyFingerprint:prior.legacyFingerprint},
   days:days.map(ready=>({day:ready.day,manifestId:ready.manifestId,manifestDigest:ready.manifestDigest})),
   manifestDigest:'0'.repeat(64)};
  domain.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(domain));
  await activateTelemetryV11Domain(source(),device,domain,nowEpoch);
 };
 await activate();
 const foreign=(await readStorageCommunityOwnerPage(source())).find(row=>row.participantId===device.participantId);
 expect(foreign?.ownerDigest).toMatch(/^[0-9a-f]{64}$/u);
 const targetPrefix=manifest.partitionKey.slice(-2);
 let chosen:string|undefined;
 for(let candidate=0;candidate<4096;candidate++){
  const id='event:v2:'+await sha256Hex('mixed-cache-owner:'+candidate);
  const key=await canonicalOccurrenceKey({sourceNamespace:sourceId,ownerDigest:foreign!.ownerDigest!,
   selectionMethod:'effective-union-v1'},'usage',id);
  if(key.startsWith(targetPrefix)){chosen=id;break;}
 }
 expect(chosen).toBeTruthy();
 const prepared=await makeV11Day(scope.day,{usage:[
  v11UsageRecord(scope.day,'a',{eventId:chosen!})]},'mixed-cache-selected');
 await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
 for(const chunk of prepared.chunks){
  const envelope=canonicalTelemetryV11Json({syntheticTestEnvelope:chunk.chunkDigest,
   manifestDigest:chunk.manifestDigest,nonce:crypto.randomUUID()});
  const envelopeDigest=await sha256Hex(envelope);
  const bodyBytes=new TextEncoder().encode(envelope).byteLength;
  const principal=await authenticateDevice(source(),device.authorization);
  const upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,bodyBytes);
  const claimed=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,
   {envelopeDigest,bodyBytes,contentType:'application/json'});
  await persistTypedV11StagedChunk(source(),device,chunk,{sourceNamespace:sourceId,
   chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`telemetry/v11-test-${crypto.randomUUID()}`,
   envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId});
 }
 const selected=await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
 await activate(selected);
 const current=(await readStorageCommunityOwnerPage(source())).find(row=>row.participantId===device.participantId);
 expect(current?.ownerDigest).toBe(foreign!.ownerDigest);
 // Source rows are genuinely admitted through the native v1.1 writer; the
 // target owner-state mirror follows this shared corpus fixture's existing
 // synthetic authority mode and does not claim ordered-delivery proof.
 await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
  VALUES(?,?,?,?,'active')`).bind(sourceId,current!.ownerDigest,current!.ownerRevision,
  current!.authorityEpoch).run();
 await cover(device.participantId);
 const foreignScope:CanonicalInputScope={...scope,ownerDigest:current!.ownerDigest!,participantId:device.participantId};
 let sealed=false;
 for(let pass=0;pass<32;pass++){
  const progress=await advanceCanonicalInputWork(source(),target(),{...foreignScope,
   budget:{meter:createD1InvocationBudget(900),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}});
  if(progress.state==='complete'){sealed=true;break;}
  expect(progress.state).toBe('progress');
 }
 expect(sealed).toBe(true);
 const mixed=await materializeCanonicalPartition(target(),manifest.partitionKey);
 expect(mixed.state).toBe('complete');
 if(mixed.state!=='complete')throw Error('actual mixed leaf split');
 const rows=(await target().prepare(`SELECT DISTINCT f.owner_digest FROM analytics_canonical_manifest_rows r
  JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=?`)
  .bind(mixed.manifest.contentRevision).all<{owner_digest:string}>()).results;
 expect(rows.map(row=>row.owner_digest).sort()).toEqual([scope.ownerDigest,current!.ownerDigest!].sort());
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'cache',lane:'new',
  partitionKey:mixed.manifest.partitionKey,headKey:await sha256Hex('mixed-cache-replacement'),
  inputRevision:mixed.manifest.contentRevision,policyRevision:'d'.repeat(64),day:scope.day,
  stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1024*1024,admissionQueries:160};
 const [workKey]=await admitAnalyticsPartitionWork(target(),[request],Date.now());
 expect(workKey).toBeTruthy();
 const now=Date.now(),leases=await claimAnalyticsPartitionWork(target(),{sourceId,limit:2,
  nowMs:now,leaseMs:60_000,stages:['cache']});
 const lease=leases.find(value=>value.workKey===workKey);expect(lease).toBeTruthy();
 const create=budgetModule.createD1InvocationBudget;
 const child=vi.spyOn(budgetModule,'createD1InvocationBudget').mockImplementation(max=>create(max));
 try {
  const {result}=await execute(lease!,950,now+1);
  expect(result).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
  expect(child.mock.calls.some(([max])=>max===300)).toBe(false);
 } finally {child.mockRestore();}
 expect(await inputRow(scope)).toEqual(before);
 expect(await children(workKey!)).toBe(0);
},120_000);

it('leaves a genuine empty sibling manifest on the original authority path without a guessed owner',async()=>{
 const {scope,manifest}=await fixture();
 const root=manifest.partitionKey.slice(0,-2);
 const occupied=(await target().prepare(`SELECT DISTINCT partition_key FROM analytics_canonical_heads
  WHERE partition_key LIKE ?`).bind(root+'%').all<{partition_key:string}>()).results;
 const taken=new Set(occupied.map(row=>row.partition_key));
 const suffix=Array.from({length:256},(_,index)=>index.toString(16).padStart(2,'0'))
  .find(value=>!taken.has(root+value));
 expect(suffix).toBeTruthy();
 const empty=await materializeCanonicalPartition(target(),root+suffix);
 expect(empty.state).toBe('complete');
 if(empty.state!=='complete')throw Error('actual empty sibling split');
 expect(empty.manifest.rowCount).toBe(0);
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'cache',lane:'new',
  partitionKey:empty.manifest.partitionKey,headKey:await sha256Hex('empty-cache-sibling'),
  inputRevision:empty.manifest.contentRevision,policyRevision:'e'.repeat(64),day:scope.day,
  stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1024*1024,admissionQueries:160};
 const [workKey]=await admitAnalyticsPartitionWork(target(),[request],Date.now());
 expect(workKey).toBeTruthy();
 const now=Date.now(),leases=await claimAnalyticsPartitionWork(target(),{sourceId,limit:2,
  nowMs:now,leaseMs:60_000,stages:['cache']});
 const lease=leases.find(value=>value.workKey===workKey);expect(lease).toBeTruthy();
 const create=budgetModule.createD1InvocationBudget;
 const child=vi.spyOn(budgetModule,'createD1InvocationBudget').mockImplementation(max=>create(max));
 try {
  const {result}=await execute(lease!,950,now+1);
  expect(result.reason).not.toBe('canonical_input_unsealed');
  expect(child.mock.calls.some(([max])=>max===300)).toBe(false);
 } finally {child.mockRestore();}
},120_000);
