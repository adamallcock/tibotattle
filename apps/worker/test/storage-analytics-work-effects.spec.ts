import { env,reset,applyD1Migrations,type D1Migration } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { advanceAnalyticsWorkEffects } from '../src/storage-analytics-work-effects';
import { readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { advanceCanonicalInputWork } from '../src/storage-canonical-analytics-input';
import { readCanonicalPartition,materializeCanonicalPartition } from '../src/storage-canonical-analytics-facts';
import { acknowledgeEffectiveDependencyAffectedRanges,readEffectiveDependencyAffectedRanges,
 advanceEffectiveDependencyCoverage,readEffectiveDependencyGlobalChange } from '../src/storage-effective-selective-dependencies';
import { initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const sourceId='synthetic-work-effects',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
async function setup() {
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
 calendarDays:14,graphDays:2,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 for(let n=0;n<24;n++) {const step=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
 participantId:corpus.participantId,maxSteps:64,maxRows:128});if(step.status==='complete')break;}
 await acknowledgeEffectiveDependencyAffectedRanges(source(),await readEffectiveDependencyAffectedRanges(source(),128));return corpus;
}
async function run(database=target(),maxDays=2) {
 const meter=createD1InvocationBudget(950);const progress=await advanceAnalyticsWorkEffects({source:source(),target:database,
 sourceId,sourceNamespace:sourceId,meter,now:Date.now,deadlineMs:Date.now()+60000,maxEffects:4,maxDays});
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);return progress;
}
async function effect(participantId:string,from:string,through=from,stamp=900001) {
 await source().prepare(`INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 VALUES(?,?,?,1,?) ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp`)
 .bind(participantId,from,through,stamp).run();
}
it('commits bounded old-history expansion before exact source ACK and excludes raw identities from target work',async()=>{
 const corpus=await setup();await effect(corpus.participantId,'2024-01-01','2024-12-31');
 const progress=await run();expect(progress.rangesAdmitted).toBeGreaterThan(0);expect(progress.daysAdmitted).toBe(2);
 expect((await readEffectiveDependencyAffectedRanges(source())).some(row=>row.stamp===900001)).toBe(false);
 const ranges=(await target().prepare('SELECT * FROM analytics_partition_ranges WHERE source_stamp=900001').all()).results;
 expect(ranges).toHaveLength(1);expect(ranges[0]).toMatchObject({from_day:'2024-01-01',through_day:'2024-12-31',next_day:'2024-01-03',acknowledged:1});
 const jobs=(await target().prepare('SELECT * FROM analytics_partition_work').all()).results;
 expect(jobs.filter(row=>row.stage==='canonical')).toHaveLength(2);
 expect(JSON.stringify([ranges,jobs])).not.toContain(corpus.participantId);
 expect((await run()).daysAdmitted).toBe(2);
},120_000);
it('replays a lost target save without losing source work or duplicating target receipts',async()=>{
 const corpus=await setup(),day=corpus.graphDates[0]!;await effect(corpus.participantId,day);let lost=true;
 const unreliable=new Proxy(target(),{get(db,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
 const result=await db.batch(statements);if(lost){lost=false;throw new Error('synthetic target response lost');}return result;};
 const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
 await expect(run(unreliable)).rejects.toThrow('response lost');
 expect((await readEffectiveDependencyAffectedRanges(source())).some(row=>row.stamp===900001)).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_ranges WHERE source_stamp=900001').first('n')).toBe(1);
 await run();expect((await readEffectiveDependencyAffectedRanges(source())).some(row=>row.stamp===900001)).toBe(false);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_ranges WHERE source_stamp=900001').first('n')).toBe(1);
},120_000);
it('preserves a replacement source stamp arriving between target commit and exact ACK',async()=>{
 const corpus=await setup(),day=corpus.graphDates[0]!;await effect(corpus.participantId,day);let replaced=false;
 const interleaved=new Proxy(target(),{get(db,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
 const result=await db.batch(statements);if(!replaced){replaced=true;await effect(corpus.participantId,day,day,900002);}return result;};
 const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
 await run(interleaved);expect((await readEffectiveDependencyAffectedRanges(source())).some(row=>row.stamp===900002)).toBe(true);
 await run();expect(await target().prepare('SELECT count(DISTINCT source_stamp) n FROM analytics_partition_ranges WHERE source_stamp>=900001').first('n')).toBe(2);
},120_000);
it('journals canonical saves and keeps ownerless partition repair discoverable after physical erasure',async()=>{
 const corpus=await setup(),day=corpus.graphDates[0]!,owner=corpus.owner;
 for(let n=0;n<12;n++) {const result=await advanceCanonicalInputWork(source(),target(),{sourceId,sourceNamespace:sourceId,
 ownerDigest:owner.ownerDigest,participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1',
 budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60000}});
 if(result.state==='complete')break;expect(result.state).toBe('progress');}
 const pending=await target().prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n');
 expect(pending).toBeGreaterThan(0);
 const partition=await target().prepare('SELECT partition_key FROM analytics_canonical_heads LIMIT 1').first<string>('partition_key');
 expect(partition).toBeTruthy();expect((await materializeCanonicalPartition(target(),partition!)).state).toBe('complete');
 expect(await readCanonicalPartition(target(),partition!)).not.toBeNull();
 await run();expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND owner_digest IS NULL").first<number>('n')).toBeGreaterThan(0);
 await target().prepare(`UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1
 WHERE source_id=? AND owner_digest=?`).bind(sourceId,owner.ownerDigest).run();
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE source_id=? AND owner_digest=?').bind(sourceId,owner.ownerDigest).first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_canonical_effects').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_dirty_work WHERE generation>admitted_generation').first<number>('n')).toBeGreaterThan(0);
 await run();expect(await target().prepare('SELECT count(*) n FROM analytics_partition_dirty_work WHERE generation>admitted_generation').first<number>('n')).toBeLessThanOrEqual(pending!);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);

it('expands global policy work through a durable owner cursor before acknowledging its exact stamp',async()=>{
 await setup();
 for(const owner of await readStorageCommunityOwnerPage(source(),{requireLinkedOwner:true})) {
  await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
   VALUES(?,?,?,?,'active') ON CONFLICT(source_id,owner_digest) DO NOTHING`)
   .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
 }
 const initial=await readEffectiveDependencyGlobalChange(source());expect(initial).toBeDefined();
 await run();expect(await readEffectiveDependencyGlobalChange(source())).toEqual(initial);
 for(let n=0;n<12;n++){await run();if(!await readEffectiveDependencyGlobalChange(source()))break;}
 expect(await readEffectiveDependencyGlobalChange(source())).toBeUndefined();
 expect(await target().prepare(`SELECT state,acknowledged FROM analytics_partition_global_changes WHERE source_id=? AND source_stamp=?`)
  .bind(sourceId,initial!.stamp).first()).toEqual({state:'complete',acknowledged:1});
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_ranges WHERE lane='recovery' AND acknowledged=1").first<number>('n')).toBeGreaterThan(0);
},120_000);

async function setupEmpty() {
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const {createV11DeviceFixture}=await import('./helpers/telemetry-v11');
 const {prepareIngestionChange,readIngestionChanges,applyAnalyticsChange}=await import('../src/analytics-delivery');
 const fixture=await createV11DeviceFixture(source());const ownerDigest='e'.repeat(64);
 // A content-free active native owner with no accepted telemetry. The source
 // journal and ordinary target receipt establish authority; coverage is real.
 await source().batch([
  source().prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state,object_digest,manifest_digest)
   VALUES(?,?,'active',?,?)`).bind(fixture.participantId,ownerDigest,'a'.repeat(64),'b'.repeat(64)),
  prepareIngestionChange(source(),{sourceId,ownerDigest,revision:1,kind:'owner-active',eventDigest:'c'.repeat(64),
   objectDigest:'a'.repeat(64),contentDigest:'b'.repeat(64),recordedMs:Date.now()}),
 ]);
 await applyAnalyticsChange(target(),(await readIngestionChanges(source(),sourceId,0,1))[0]!,async()=>[]);
 const {readStorageCommunityOwner}=await import('../src/storage-community-authority');
 expect(await readStorageCommunityOwner(source(),{ownerDigest})).toMatchObject({ownerDigest,hasV1:false,hasV11:false,hasV12:false,hasLegacy:false,hasEffective:false});
 for(let n=0;n<4;n++)if((await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,maxSteps:64,maxRows:128})).status==='complete')break;
 await acknowledgeEffectiveDependencyAffectedRanges(source(),await readEffectiveDependencyAffectedRanges(source(),128));
 return {...fixture,ownerDigest};
}
async function emptyEffect(participantId:string,stamp=900001){
 await source().prepare(`INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 VALUES(?,'','',0,?) ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp`)
 .bind(participantId,stamp).run();
}
const hasStamp=async(stamp=900001)=>(await readEffectiveDependencyAffectedRanges(source(),128)).some(row=>row.stamp===stamp);
function intercept(database:D1Database,pattern:RegExp,after:()=>Promise<void>):D1Database{
 return new Proxy(database,{get(db,key){if(key==='prepare')return (sql:string)=>{
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(s,k){
   if(k==='bind')return (...args:unknown[])=>wrap(s.bind(...args));
   if(k==='run')return async()=>{const result=await s.run();if(pattern.test(sql))await after();return result;};
   const value=Reflect.get(s,k);return typeof value==='function'?value.bind(s):value;}});
  return wrap(db.prepare(sql));};const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
}
it('admits explicit source-backed empty outcomes and completes a global empty owner without raw identity',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);await run();
 expect(await hasStamp()).toBe(false);
 const receipts=(await target().prepare('SELECT * FROM analytics_partition_empty_outcomes').all()).results;
 expect(receipts.some(row=>row.source_stamp===900001&&row.acknowledged===1)).toBe(true);
 expect(JSON.stringify(receipts)).not.toContain(fixture.participantId);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_ranges').first('n')).toBe(0);
 for(let n=0;n<4;n++)await run();
 expect(await readEffectiveDependencyGlobalChange(source())).toBeUndefined();
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
},120_000);
it('keeps empty source effects pending for incomplete catalog or missing outcome migration',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);
 await source().prepare('UPDATE storage_effective_selective_owners SET seeded=0,needs_work=0 WHERE participant_id=?').bind(fixture.participantId).run();
 await run();expect(await hasStamp()).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
 await source().prepare('UPDATE storage_effective_selective_owners SET needs_work=1 WHERE participant_id=?').bind(fixture.participantId).run();
 await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,maxSteps:64,maxRows:128});
 await target().prepare('DROP TRIGGER analytics_partition_empty_erasure_replay').run();
 expect((await run()).state).toBe('unavailable');expect(await hasStamp()).toBe(true);
},120_000);
it('recovers an empty outcome save response loss and exact source ACK response loss',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);let lost=true;
 const targetLost=intercept(target(),/INSERT INTO analytics_partition_empty_outcomes/u,async()=>{if(lost){lost=false;throw new Error('synthetic empty save lost');}});
 await expect(run(targetLost)).rejects.toThrow('empty save lost');expect(await hasStamp()).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes WHERE source_stamp=900001').first('n')).toBe(1);
 const sourceLost=intercept(source(),/DELETE FROM storage_effective_selective_effects/u,async()=>{throw new Error('synthetic empty ACK lost');});
 const meter=createD1InvocationBudget(950);
 await expect(advanceAnalyticsWorkEffects({source:sourceLost,target:target(),sourceId,sourceNamespace:sourceId,meter,now:Date.now,
  deadlineMs:Date.now()+60000})).rejects.toThrow('empty ACK lost');expect(await hasStamp()).toBe(false);
 expect(await target().prepare('SELECT acknowledged FROM analytics_partition_empty_outcomes WHERE source_stamp=900001').first('acknowledged')).toBe(0);
 await run();expect(await target().prepare('SELECT acknowledged FROM analytics_partition_empty_outcomes WHERE source_stamp=900001').first('acknowledged')).toBe(1);
},120_000);
it('rejects a source mutation after empty receipt commit and preserves a replacement stamp',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);let changed=false;
 const changing=intercept(target(),/INSERT INTO analytics_partition_empty_outcomes/u,async()=>{if(!changed){changed=true;
  await source().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1').run();
  await emptyEffect(fixture.participantId,900002);
 }});
 await run(changing);expect(await hasStamp(900002)).toBe(true);
 await run();expect(await hasStamp(900002)).toBe(false);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);
it('does not ACK a native withdrawal before exact delivery and physical derived cleanup',async()=>{
 const fixture=await setupEmpty();
 await source().prepare("UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=?").bind(fixture.participantId).run();
 await emptyEffect(fixture.participantId);await run();expect(await hasStamp()).toBe(true);
 const {advanceStorageAnalytics}=await import('../src/storage-analytics-runtime');
 expect((await advanceStorageAnalytics({source:source(),target:target(),sourceId,sourceNamespace:sourceId})).state).not.toBe('idle');
 await run();expect(await hasStamp()).toBe(false);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
},120_000);
it('refuses stale target authority for empty facts and waits for all-source catalog closure at EOF',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);
 await target().prepare('UPDATE analytics_owner_state SET authority_epoch=authority_epoch+1 WHERE owner_digest=?').bind(fixture.ownerDigest).run();
 await run();expect(await hasStamp()).toBe(true);
 await target().prepare('UPDATE analytics_owner_state SET authority_epoch=authority_epoch-1 WHERE owner_digest=?').bind(fixture.ownerDigest).run();
 await run();expect(await hasStamp()).toBe(false);
 // This is a deliberately interrupted catalog checkpoint. Metadata absence is
 // not an empty population: even an enumerated cursor must not acknowledge it.
 await source().prepare('UPDATE storage_effective_selective_owners SET seeded=0,needs_work=0 WHERE participant_id=?').bind(fixture.participantId).run();
 for(let n=0;n<3;n++)await run();expect(await readEffectiveDependencyGlobalChange(source())).toBeDefined();
 await source().prepare('UPDATE storage_effective_selective_owners SET needs_work=1 WHERE participant_id=?').bind(fixture.participantId).run();
 for(let n=0;n<5;n++)await run();expect(await readEffectiveDependencyGlobalChange(source())).toBeUndefined();
},120_000);
it('keeps delivered withdrawal pending while a restored private outcome remains and purges outcomes on terminal replay',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);await run();
 const row=await target().prepare('SELECT * FROM analytics_partition_empty_outcomes WHERE source_stamp=900001').first();expect(row).not.toBeNull();
 const trigger=await target().prepare("SELECT sql FROM sqlite_schema WHERE name='analytics_partition_empty_terminal'").first<string>('sql');
 // Synthetic interrupted restore: retain the saved private row across delivery,
 // then reinstall the real guard before asking the completion proof to run.
 await target().prepare('UPDATE analytics_partition_empty_outcomes SET acknowledged=0 WHERE source_stamp=900001').run();
 await target().prepare('DROP TRIGGER analytics_partition_empty_terminal').run();
 await source().prepare("UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=?").bind(fixture.participantId).run();
 const {advanceStorageAnalytics}=await import('../src/storage-analytics-runtime');
 await advanceStorageAnalytics({source:source(),target:target(),sourceId,sourceNamespace:sourceId});
 await target().prepare(trigger!).run();await emptyEffect(fixture.participantId);await run();expect(await hasStamp()).toBe(true);
 await target().prepare("UPDATE analytics_owner_state SET state=state WHERE owner_digest=?").bind(fixture.ownerDigest).run();
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
 await run();expect(await hasStamp()).toBe(false);
},120_000);
it('requires physical erasure receipt and separately pins a newly replayed terminal event after source restoration',async()=>{
 const fixture=await setupEmpty();await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const {recordDeletionTombstone}=await import('../src/retention');
 const {prepareStorageParticipantErasure,advanceStorageErasureJobs}=await import('../src/storage-erasure');
 const {advanceStorageAnalytics}=await import('../src/storage-analytics-runtime');
 const {readIngestionChanges}=await import('../src/analytics-delivery');
 const bindings={source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace:sourceId};
 await recordDeletionTombstone(b.DELETION_LEDGER,fixture.participantId);await prepareStorageParticipantErasure(bindings,fixture.participantId);
 await source().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?").bind(fixture.participantId).run();
 const original=(await readIngestionChanges(source(),sourceId,1,1))[0]!;
 for(let n=0;n<5;n++)if(!(await advanceStorageErasureJobs(bindings)).pending)break;
 expect(await target().prepare('SELECT terminal_event_digest FROM analytics_storage_erasure_receipts').first('terminal_event_digest')).toBe(original.eventDigest);
 // Model a copied source backup from immediately before erasure. Only this
 // disposable fixture temporarily removes immutable native journal guards;
 // each original trigger is restored before the native replay is generated.
 const names=['storage_ingestion_change_retained','storage_v11_owner_identity'];
 const guards=(await source().prepare('SELECT name,sql FROM sqlite_schema WHERE name IN(SELECT value FROM json_each(?))')
  .bind(JSON.stringify(names)).all<{name:string;sql:string}>()).results;expect(guards).toHaveLength(2);
 await source().batch([
  ...guards.map(g=>source().prepare(`DROP TRIGGER ${g.name}`)),
  source().prepare('DELETE FROM storage_ingestion_changes WHERE sequence=?').bind(original.sequence),
  source().prepare("UPDATE storage_owner_revisions SET state='active',revision=1,authority_epoch=1 WHERE owner_digest=?").bind(fixture.ownerDigest),
  source().prepare('UPDATE storage_source_state SET authority_epoch=1 WHERE singleton=1'),
  source().prepare("UPDATE storage_v11_owner_links SET state='active' WHERE participant_id=?").bind(fixture.participantId),
  ...guards.map(g=>source().prepare(g.sql)),
 ]);
 await source().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?").bind(fixture.participantId).run();
 const replay=(await readIngestionChanges(source(),sourceId,1,1))[0]!;expect(replay.eventDigest).not.toBe(original.eventDigest);
 await emptyEffect(fixture.participantId);await run();expect(await hasStamp()).toBe(true); // first erasure receipt is not delivery of this event
 await advanceStorageAnalytics(bindings);await run();expect(await hasStamp()).toBe(false);
 expect(await target().prepare('SELECT terminal_event_digest FROM analytics_storage_erasure_receipts').first('terminal_event_digest')).toBe(original.eventDigest);
 expect(await target().prepare('SELECT event_digest FROM analytics_applied_events WHERE sequence=2').first('event_digest')).toBe(replay.eventDigest);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);
it('keeps an exactly delivered erasure pending until the independent physical receipt exists',async()=>{
 const fixture=await setupEmpty();await emptyEffect(fixture.participantId);await run();
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first<number>('n')).toBeGreaterThan(0);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const {recordDeletionTombstone}=await import('../src/retention');
 const {prepareStorageParticipantErasure,advanceStorageErasureJobs}=await import('../src/storage-erasure');
 const {advanceStorageAnalytics}=await import('../src/storage-analytics-runtime');
 const bindings={source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace:sourceId};
 await recordDeletionTombstone(b.DELETION_LEDGER,fixture.participantId);await prepareStorageParticipantErasure(bindings,fixture.participantId);
 await source().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?").bind(fixture.participantId).run();
 await advanceStorageAnalytics(bindings);await emptyEffect(fixture.participantId);await run();
 expect(await hasStamp()).toBe(true);expect(await target().prepare('SELECT count(*) n FROM analytics_storage_erasure_receipts').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
 for(let n=0;n<5;n++)if(!(await advanceStorageErasureJobs(bindings)).pending)break;
 await run();expect(await hasStamp()).toBe(false);
 expect(await target().prepare('SELECT count(*) n FROM analytics_storage_erasure_receipts').first('n')).toBe(1);
},120_000);
it('enumerates retained terminal owners after their private participant link is physically removed',async()=>{
 const fixture=await setupEmpty();await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const {recordDeletionTombstone}=await import('../src/retention');
 const {prepareStorageParticipantErasure,advanceStorageErasureJobs}=await import('../src/storage-erasure');
 const {advanceStorageAnalytics}=await import('../src/storage-analytics-runtime');
 const bindings={source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace:sourceId};
 await recordDeletionTombstone(b.DELETION_LEDGER,fixture.participantId);await prepareStorageParticipantErasure(bindings,fixture.participantId);
 await source().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?").bind(fixture.participantId).run();
 await source().prepare('DELETE FROM participants WHERE id=?').bind(fixture.participantId).run();
 await advanceStorageAnalytics(bindings);expect(await source().prepare('SELECT count(*) n FROM storage_v11_owner_links').first('n')).toBe(0);
 await run();expect(await readEffectiveDependencyGlobalChange(source())).toBeDefined();
 expect(await target().prepare('SELECT after_owner_digest FROM analytics_partition_global_changes').first('after_owner_digest')).toBe('');
 for(let n=0;n<5;n++)if(!(await advanceStorageErasureJobs(bindings)).pending)break;
 expect((await run()).globalOwners).toBe(1);
 for(let n=0;n<4;n++)await run();expect(await readEffectiveDependencyGlobalChange(source())).toBeUndefined();
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_empty_outcomes').first('n')).toBe(0);
},120_000);
