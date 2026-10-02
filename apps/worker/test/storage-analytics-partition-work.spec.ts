import { env,reset } from 'cloudflare:test';
import { expect,it } from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {v11UsageRecord} from './helpers/telemetry-v11';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import {dispatchAnalyticsWork} from '../src/analytics-partition-work';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {normalizeNativeEffectiveOccurrence} from '../src/canonical-analytics-facts';
import {materializeCanonicalPage,materializeCanonicalPartition,readCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {materializeCanonicalCachePartition,canonicalCacheRepairPageBlocked,recordCanonicalCachePreparedReceipt,
 CANONICAL_CACHE_PREPARED_READY_PREDICATE} from '../src/storage-canonical-cache-pairs';
import {CANONICAL_CACHE_PAIR_METHOD} from '../src/canonical-cache-pairs';
import { admitAnalyticsPartitionWork,analyticsPartitionWorkAvailable,claimAnalyticsPartitionWork,
 completeAnalyticsPartitionWork,readAnalyticsPartitionWork,releaseAnalyticsPartitionWork,retireAnalyticsPartitionWork,
 recordAnalyticsPartitionWorkReason,previewAnalyticsFeatureGroup,
 type AnalyticsWorkRequest } from '../src/storage-analytics-partition-work';
import { initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-partition-work',db=()=>b.STORAGE_ANALYTICS_DB;
const h=(n:number)=>n.toString(16).padStart(64,'0');
function work(n:number,overrides:Partial<AnalyticsWorkRequest>={}):AnalyticsWorkRequest {
 return {sourceId,ownerDigest:null,stage:'features',lane:'new',partitionKey:'partition/'+h(n),headKey:h(n),
 inputRevision:h(n+100),policyRevision:h(999),day:'2026-09-20',stream:'usage',selectionMethod:'effective-union-v1',
 residentBytes:4096,admissionQueries:50,...overrides};
}
async function setup(preMigration=false) {
 await reset();await initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,db(),preMigration
 ?{...b,TEST_ANALYTICS_MIGRATIONS:b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0038_')}:b,sourceId);
}
const claim=(nowMs:number,limit=1)=>claimAnalyticsPartitionWork(db(),{sourceId,limit,nowMs,leaseMs:1000});
async function preparedCacheLeaf(nowMs:number,blockedSubject=false) {
 const ownerDigest='a'.repeat(64),day='2026-09-20',at=day+'T12:00:00.000Z';
 await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const record={...v11UsageRecord(day),eventId:'event:v2:'+h(79),eventTime:at};
 const fact=await normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
  {methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-local',ownerDigest,
   occurrenceId:record.eventId,eventTime:at,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],
   sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),canonicalEvidence:{linkedDays:[day],
    variants:[{coordinate:'synthetic:cache-prepared',format:'v11' as const,observedAtMs:Date.parse(at)}],
    boundaryFlags:{presence:'unknown' as const,value:null},tieOrder:{presence:'unknown' as const,value:null},
    cacheWriteFiveMinuteTokens:{presence:'unknown' as const,value:null},cacheWriteOneHourTokens:{presence:'unknown' as const,value:null}}},0);
 await materializeCanonicalPage({db:db(),sourceId,scope:{sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
  ownerRevision:1,authorityEpoch:1,pageKey:h(101),sourceRevision:h(102),stillCurrent:async()=>true,load:async()=>[
   {occurrenceKey:fact.occurrenceKey,stream:'usage',expectedRevision:null,fact}]});
 await materializeCanonicalPartition(db(),fact.location.partitionKey);
 const partition=await readCanonicalPartition(db(),fact.location.partitionKey);expect(partition).not.toBeNull();
 await materializeCanonicalCachePartition({target:db(),partitionKey:fact.location.partitionKey,
  budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000},stillCurrent:async()=>true});
 // A healthy own subject must stay claimable even if a caller holds a
 // global negative hint. Only genuine unprepared own canonical evidence makes
 // its subject page blocked; no queue row or receipt supplies that evidence.
 if(blockedSubject){
  let blocker:typeof fact|undefined;
  for(let n=80;n<112;n++){
   const extra={...record,eventId:'event:v2:'+h(n)};
   const candidate=await normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
    {methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-local',ownerDigest,
     occurrenceId:extra.eventId,eventTime:at,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],
     sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(extra),canonicalEvidence:{linkedDays:[day],
      variants:[{coordinate:'synthetic:cache-blocker',format:'v11' as const,observedAtMs:Date.parse(at)}],
      boundaryFlags:{presence:'unknown' as const,value:null},tieOrder:{presence:'unknown' as const,value:null},
      cacheWriteFiveMinuteTokens:{presence:'unknown' as const,value:null},cacheWriteOneHourTokens:{presence:'unknown' as const,value:null}}},0);
   if(candidate.location.partitionKey!==fact.location.partitionKey){blocker=candidate;break;}
  }
  expect(blocker).toBeDefined();
  await materializeCanonicalPage({db:db(),sourceId,scope:{sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
   ownerRevision:1,authorityEpoch:1,pageKey:h(103),sourceRevision:h(104),stillCurrent:async()=>true,load:async()=>[
    {occurrenceKey:blocker!.occurrenceKey,stream:'usage',expectedRevision:null,fact:blocker!}]});
  await materializeCanonicalPartition(db(),blocker!.location.partitionKey);
 }
 const [workKey]=await admitAnalyticsPartitionWork(db(),[work(79,{stage:'cache',ownerDigest,
  partitionKey:fact.location.partitionKey,inputRevision:partition!.manifest.contentRevision})],nowMs);
 return {workKey:workKey!,partition:partition!,fact,ownerDigest};
}
it('suppresses only a current ready prepared cache receipt while preserving ordinary and guarded claims',async()=>{
 await setup();const nowMs=20,{workKey,partition,fact,ownerDigest}=await preparedCacheLeaf(10,true);
 const first=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,leaseMs:1000,stages:['cache']}))[0]!;
 expect(first.workKey).toBe(workKey);
 await db().prepare(`INSERT INTO analytics_canonical_cache_prepared_receipts
  (work_key,work_revision,input_revision,partition_key,method,manifest_generation,row_count)
  VALUES(?,?,?,?,?,?,?)`).bind(workKey,first.revision,partition.manifest.contentRevision,partition.manifest.partitionKey,
   CANONICAL_CACHE_PAIR_METHOD,partition.manifest.generation,partition.manifest.rowCount).run();
 await recordAnalyticsPartitionWorkReason(db(),first,'cache_repairs_pending',nowMs);
 expect(await releaseAnalyticsPartitionWork(db(),first,'deferred',nowMs)).toBe(true);
 const current=()=>db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=?
  AND ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(workKey).first<number>('ready');
 expect(await current()).toBe(1);
 const [unpreparedKey]=await admitAnalyticsPartitionWork(db(),[work(80,{stage:'cache'})],nowMs+1);
 // A guarded companion must stop on its exact expected key. It cannot claim
 // the next eligible work as a substitute for the suppressed prepared leaf.
 expect(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true,expectedWorkKeys:[workKey]})).toEqual([]);
 expect(await db().prepare('SELECT attempts FROM analytics_partition_work WHERE work_key=?')
  .bind(unpreparedKey).first<number>('attempts')).toBe(0);
 const next=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+2,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true}))[0]!;
 expect(next.workKey).toBe(unpreparedKey);
 expect(await completeAnalyticsPartitionWork(db(),next,[],nowMs+2)).toBe(true);
 // The same durable row is eligible under the unchanged ordinary selector.
 const claimed=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+3,leaseMs:1000,
  stages:['cache']}))[0]!;
 expect(claimed.workKey).toBe(workKey);
 expect(await current()).toBeNull();
 // An expired lease is never suppressed by the ready-only receipt predicate.
 const renewed=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1004,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true}))[0]!;
 expect(renewed.workKey).toBe(workKey);expect(renewed.revision).toBe(claimed.revision+1);
 await db().prepare('UPDATE analytics_canonical_cache_prepared_receipts SET work_revision=? WHERE work_key=?')
  .bind(renewed.revision,workKey).run();
 await recordAnalyticsPartitionWorkReason(db(),renewed,'source_changed',nowMs+1004);
 expect(await releaseAnalyticsPartitionWork(db(),renewed,'deferred',nowMs+1004)).toBe(true);
 expect(await current()).toBeNull();
 const wrongReason=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1005,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true}))[0]!;
 expect(wrongReason.workKey).toBe(workKey);
 await recordAnalyticsPartitionWorkReason(db(),wrongReason,'cache_repairs_pending',nowMs+1005);
 expect(await releaseAnalyticsPartitionWork(db(),wrongReason,'deferred',nowMs+1005)).toBe(true);
 // Its old leased-revision receipt cannot suppress a newly released attempt.
 expect(await current()).toBeNull();
 const stale=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1006,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true}))[0]!;
 expect(stale.workKey).toBe(workKey);
 await db().prepare('UPDATE analytics_canonical_cache_prepared_receipts SET work_revision=? WHERE work_key=?')
  .bind(stale.revision,workKey).run();
 await recordAnalyticsPartitionWorkReason(db(),stale,'cache_repairs_pending',nowMs+1006);
 expect(await releaseAnalyticsPartitionWork(db(),stale,'deferred',nowMs+1006)).toBe(true);
 expect(await current()).toBe(1);
 const root=partition.manifest.partitionKey;
 await db().prepare(`INSERT INTO analytics_canonical_dirty_partitions(partition_key,generation) VALUES(?,?)
  ON CONFLICT(partition_key) DO UPDATE SET generation=excluded.generation`)
  .bind(root,partition.manifest.generation+1).run();
 expect(await current()).toBeNull();
 if(partition.manifest.generation===0)await db().prepare('DELETE FROM analytics_canonical_dirty_partitions WHERE partition_key=?').bind(root).run();
 else await db().prepare('UPDATE analytics_canonical_dirty_partitions SET generation=? WHERE partition_key=?')
  .bind(partition.manifest.generation,root).run();
 expect(await current()).toBe(1);
 await db().prepare('DELETE FROM analytics_canonical_cache_slots WHERE fact_revision=?').bind(fact.revision).run();
 expect(await current()).toBeNull();
 const missingSlot=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1007,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true}))[0]!;
 expect(missingSlot.workKey).toBe(workKey);
 // Terminal owner cleanup deletes the work row and its opaque sidecar receipt
 // together. The pending repair cannot retain a participant-derived key.
 await db().prepare(`UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1
  WHERE source_id=? AND owner_digest=?`).bind(sourceId,ownerDigest).run();
 expect(await db().prepare('SELECT work_key FROM analytics_partition_work WHERE work_key=?').bind(workKey).first()).toBeNull();
 expect(await db().prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?')
  .bind(workKey).first()).toBeNull();
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},60_000);
it('does not suppress a healthy own prepared subject under an unrelated global negative hint',async()=>{
 await setup();const nowMs=20,{workKey,partition}=await preparedCacheLeaf(10);
 const first=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,leaseMs:1000,stages:['cache']}))[0]!;
 expect(first.workKey).toBe(workKey);
 expect(await recordCanonicalCachePreparedReceipt({target:db(),lease:first,partition,
  budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(true);
 await recordAnalyticsPartitionWorkReason(db(),first,'cache_repairs_pending',nowMs);
 expect(await releaseAnalyticsPartitionWork(db(),first,'deferred',nowMs)).toBe(true);
 expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=? AND
  ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(workKey).first<number>('ready')).toBeNull();
 const next=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+1,leaseMs:1000,
  stages:['cache'],cacheRepairBlocked:true,expectedWorkKeys:[workKey]}))[0]!;
 expect(next.workKey).toBe(workKey);expect(next.revision).toBe(first.revision+2);
 expect(await completeAnalyticsPartitionWork(db(),next,[],nowMs+1)).toBe(true);
},60_000);
it('uses the original claim path before the optional cache receipt migration',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,db(),
  {...b,TEST_ANALYTICS_MIGRATIONS:b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0048_')},sourceId);
 await admitAnalyticsPartitionWork(db(),[work(91,{stage:'cache'})],10);
 expect(await canonicalCacheRepairPageBlocked({target:db(),budget:{remainingQueries:()=>950,now:()=>20,
  deadlineMs:60_000}})).toBe(false);
 const leases=await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:20,stages:['cache']});
 expect(leases).toHaveLength(1);expect(leases[0]?.stage).toBe('cache');
},60_000);
it('refuses prepared receipts for mismatched immutable cache stream or selection metadata',async()=>{
 await setup();const {workKey,partition,ownerDigest}=await preparedCacheLeaf(10);
 await db().prepare('DELETE FROM analytics_partition_work WHERE work_key=?').bind(workKey).run();
 for(const [index,overrides] of [[81,{selectionMethod:'legacy-selected-v1' as const}],
  [82,{stream:'quota' as const}]] as const){
  const [key]=await admitAnalyticsPartitionWork(db(),[work(index,{stage:'cache',ownerDigest,
   partitionKey:partition.manifest.partitionKey,inputRevision:partition.manifest.contentRevision,...overrides})],20+index);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:20+index,stages:['cache']}))[0]!;
  expect(lease.workKey).toBe(key);
  expect(await recordCanonicalCachePreparedReceipt({target:db(),lease,partition,
   budget:{remainingQueries:()=>950,now:()=>20+index,deadlineMs:20+index+60_000}})).toBe(false);
  expect(await db().prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?')
   .bind(key).first()).toBeNull();
  expect(await completeAnalyticsPartitionWork(db(),lease,[],20+index)).toBe(true);
 }
},60_000);
it('checks capability, rejects extra fields and idempotently admits only immutable work',async()=>{
 await setup(true);expect(await analyticsPartitionWorkAvailable(db())).toBe(false);
 await setup();expect(await analyticsPartitionWorkAvailable(db())).toBe(true);
 await expect(admitAnalyticsPartitionWork(db(),[{...work(1),payload:'private'} as AnalyticsWorkRequest],10)).rejects.toThrow('INVALID');
 const keys=await admitAnalyticsPartitionWork(db(),[work(1)],10);
 expect(await admitAnalyticsPartitionWork(db(),[work(1)],20)).toEqual(keys);
 expect(await db().prepare('SELECT count(*) n FROM analytics_partition_work').first('n')).toBe(1);
 expect(await db().prepare('SELECT created_ms n FROM analytics_partition_work').first('n')).toBe(10);
},60_000);
it('serializes shared heads across independent claims and fences expired completion and successors',async()=>{
 await setup();await admitAnalyticsPartitionWork(db(),[work(1),work(2,{headKey:h(1)})],10);
 const [left,right]=await Promise.all([claim(20),claim(20)]);expect(left.length+right.length).toBe(1);
 const old=[...left,...right][0]!;
 expect(await readAnalyticsPartitionWork(db(),old,21)).toMatchObject({headKey:h(1)});
 const renewed=(await claim(1021))[0]!;expect(renewed.claimToken).not.toBe(old.claimToken);
 expect(await completeAnalyticsPartitionWork(db(),old,[work(3)],1022)).toBe(false);
 expect(await db().prepare('SELECT count(*) n FROM analytics_partition_work').first('n')).toBe(2);
 expect(await releaseAnalyticsPartitionWork(db(),old,'complete',1022)).toBe(false);
 expect(await completeAnalyticsPartitionWork(db(),renewed,[work(3)],1022)).toBe(true);
 expect(await readAnalyticsPartitionWork(db(),renewed,1023)).toBeNull();
 expect(await db().prepare('SELECT count(*) n FROM analytics_partition_work').first('n')).toBe(3);
},60_000);
it('reserves history and withdrawal turns and rotates subjects under skewed fresh work',async()=>{
 await setup();await db().batch([1,2].map(n=>db().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
 VALUES(?,?,1,1,'active')`).bind(sourceId,h(n))));
 await admitAnalyticsPartitionWork(db(),[work(1,{lane:'withdrawal'}),work(2,{lane:'recovery'}),work(3,{lane:'history'}),
 ...Array.from({length:12},(_,i)=>work(i+10,{ownerDigest:h(1)})),work(30,{ownerDigest:h(2)})],10);
 const selected=[];
 for(let n=0;n<6;n++) {const lease=(await claim(20+n))[0]!;selected.push(await readAnalyticsPartitionWork(db(),lease,20+n));
 await releaseAnalyticsPartitionWork(db(),lease,'complete',20+n);}
 expect(selected.map(row=>row!.lane)).toContain('withdrawal');expect(selected.map(row=>row!.lane)).toContain('recovery');
 expect(selected[5]!.lane).toBe('history');
 expect(selected.filter(row=>row!.lane==='new').map(row=>row!.ownerDigest)).toContain(h(2));
},60_000);
it('recovers a lost claim response using expiry and meters actual statements',async()=>{
 await setup();await admitAnalyticsPartitionWork(db(),[work(1)],10);let lost=true;
 const transport=new Proxy(db(),{get(target,key){
 if(key==='prepare')return (sql:string)=>{
 const wrap=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(statement,k){
 if(k==='bind')return (...values:unknown[])=>wrap(statement.bind(...values));
 if(k==='first'&&sql.startsWith('UPDATE analytics_partition_work SET'))return async(...args:unknown[])=>{
 const result=await Reflect.apply(statement.first,statement,args);if(lost){lost=false;throw new Error('synthetic lost response');}return result;};
 const value=Reflect.get(statement,k);return typeof value==='function'?value.bind(statement):value;}});
 return wrap(target.prepare(sql));};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const meter=createD1InvocationBudget(950);
 await expect(claimAnalyticsPartitionWork(meter.wrap(transport),{sourceId,limit:1,nowMs:20,leaseMs:1000})).rejects.toThrow('lost response');
 expect(meter.queriesUsed).toBe(2);expect(await claim(21)).toEqual([]);
 const resumed=(await claim(1021))[0]!;expect((await readAnalyticsPartitionWork(db(),resumed,1022))!.attempts).toBe(2);
 const final=createD1InvocationBudget(950);await releaseAnalyticsPartitionWork(final.wrap(db()),resumed,'complete',1022);
 expect(final.queriesUsed).toBe(1);
},60_000);
it('terminal erasure fences writes and bounded cleanup preserves unrelated live and ready work',async()=>{
 await setup();await db().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
 VALUES(?,?,1,1,'active')`).bind(sourceId,h(1)).run();
 await admitAnalyticsPartitionWork(db(),[work(1,{ownerDigest:h(1)}),work(2),work(3),work(4)],10);
 const leases=await claim(20,3);
 const subject=(await Promise.all(leases.map(l=>readAnalyticsPartitionWork(db(),l,20)))).findIndex(row=>row?.ownerDigest===h(1));
 expect(subject).toBeGreaterThanOrEqual(0);
 await db().prepare(`UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1
 WHERE source_id=? AND owner_digest=?`).bind(sourceId,h(1)).run();
 expect(await releaseAnalyticsPartitionWork(db(),leases[subject]!,'complete',21)).toBe(false);
 await expect(admitAnalyticsPartitionWork(db(),[work(5,{ownerDigest:h(1)})],22)).rejects.toThrow('ineligible');
 expect(await releaseAnalyticsPartitionWork(db(),leases.find((_,i)=>i!==subject)!,'complete',23)).toBe(true);
 expect(await retireAnalyticsPartitionWork(db(),{sourceId,beforeMs:100,limit:1})).toBe(1);
 expect(await db().prepare("SELECT count(*) n FROM analytics_partition_work WHERE state IN('leased','ready')").first('n')).toBe(2);
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},60_000);
it('retains completed ancestors until children retire and rejects cycles without closing the live lease',async()=>{
 await setup();await admitAnalyticsPartitionWork(db(),[work(1)],10);
 const parent=(await claim(20))[0]!;expect(await completeAnalyticsPartitionWork(db(),parent,[work(2)],21)).toBe(true);
 expect(await retireAnalyticsPartitionWork(db(),{sourceId,beforeMs:100,limit:1})).toBe(0);
 const child=(await claim(22))[0]!;
 await expect(completeAnalyticsPartitionWork(db(),child,[work(1)],23)).rejects.toThrow('cycle');
 expect(await readAnalyticsPartitionWork(db(),child,24)).not.toBeNull();
 expect(await releaseAnalyticsPartitionWork(db(),child,'complete',25)).toBe(true);
 await retireAnalyticsPartitionWork(db(),{sourceId,beforeMs:100,limit:1});
 expect(await db().prepare('SELECT count(*) n FROM analytics_partition_work').first('n')).toBe(1);
 await retireAnalyticsPartitionWork(db(),{sourceId,beforeMs:100,limit:1});
 expect(await db().prepare('SELECT count(*) n FROM analytics_partition_work').first('n')).toBe(0);
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},60_000);


it('G06 bounds convergent terminal lineage and resumes while retaining ready descendants',async()=>{
 await setup();const [child,protectedParent]=await admitAnalyticsPartitionWork(db(),[work(1),work(2)],10);
 await db().prepare("UPDATE analytics_partition_work SET state='complete',revision=revision+1,updated_ms=10").run();
 const [ready]=await admitAnalyticsPartitionWork(db(),[work(3)],11);
 await db().prepare('INSERT INTO analytics_partition_work_links VALUES(?,?)').bind(protectedParent,ready).run();
 await db().prepare(`WITH RECURSIVE n(i) AS(SELECT 10000 UNION ALL SELECT i+1 FROM n WHERE i<12047)
  INSERT INTO analytics_partition_work(work_key,head_key,source_id,partition_key,input_revision,policy_revision,
    stage,lane,state,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
  SELECT printf('%064x',i),printf('%064x',i),?,'synthetic-parent/'||i,?,?,
    'features','history','complete',1,1,20,20,20 FROM n`).bind(sourceId,h(9),h(999)).run();
 await db().prepare(`INSERT INTO analytics_partition_work_links SELECT work_key,? FROM analytics_partition_work
  WHERE partition_key LIKE 'synthetic-parent/%'`).bind(child).run();
 const incoming=()=>db().prepare('SELECT count(*) n FROM analytics_partition_work_links WHERE child_work_key=?').bind(child).first<number>('n');
 expect(await incoming()).toBe(2048);
 for(let turn=0;turn<16;turn++) {
  const profile=createAnalyticsProfile();
  const retired=await retireAnalyticsPartitionWork(profileAnalyticsDatabase(db(),'target',profile,()=> 'lineage'),{sourceId,beforeMs:100,limit:1});
  expect(retired).toBeGreaterThanOrEqual(128);expect(retired).toBeLessThanOrEqual(130);
  expect(await incoming()).toBe(2048-(turn+1)*128);
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)).toBeLessThanOrEqual(600);
  if(turn<15)expect(await db().prepare('SELECT 1 alive FROM analytics_partition_work WHERE work_key=?').bind(child).first()).not.toBeNull();
  expect(await db().prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(ready).first()).toEqual({state:'ready'});
  expect(await db().prepare('SELECT 1 alive FROM analytics_partition_work_links WHERE parent_work_key=? AND child_work_key=?')
    .bind(protectedParent,ready).first()).not.toBeNull();
 }
 expect(await db().prepare('SELECT 1 alive FROM analytics_partition_work WHERE work_key=?').bind(child).first()).toBeNull();
 // Replaying retirement can remove other old leaves; it cannot remove the live dependency.
 await retireAnalyticsPartitionWork(db(),{sourceId,beforeMs:100,limit:1});
 expect(await db().prepare('SELECT 1 alive FROM analytics_partition_work WHERE work_key=?').bind(protectedParent).first()).not.toBeNull();
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},60_000);
it('rotates untouched anonymous heads despite repeated cache-role claims without prioritizing features globally',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),ownerDigest=h(77);
 await target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const featureKeys=await admitAnalyticsPartitionWork(target,[work(401),work(402)],10);
 const [cacheKey]=await admitAnalyticsPartitionWork(target,[work(403,{stage:'cache'})],20);
 const [fitsKey]=await admitAnalyticsPartitionWork(target,[work(404,{stage:'fits',ownerDigest})],30);
 // A retained pre-repair anonymous bucket supplies neither priority nor penalty.
 await target.prepare('INSERT INTO analytics_partition_subject_schedule(source_id,owner_digest,last_claimed) VALUES(?,?,?)')
  .bind(sourceId,'',999).run();
 for(let turn=0;turn<12;turn++){
  const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:40+turn,leaseMs:1000,stages:['cache']}))[0]!;
  expect(lease.workKey).toBe(cacheKey);expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',40+turn)).toBe(true);
 }
 expect(await target.prepare("SELECT last_claimed FROM analytics_partition_subject_schedule WHERE source_id=? AND owner_digest=''")
  .bind(sourceId).first<number>('last_claimed')).toBe(999);
 const selected=[];
 for(let turn=0;turn<4;turn++){
  const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:60+turn,leaseMs:1000,stages:['features','fits']}))[0]!;
  selected.push(lease.workKey);expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',60+turn)).toBe(true);
 }
 expect([selected[0],selected[2]]).toEqual([fitsKey,fitsKey]);
 expect(new Set([selected[1],selected[3]])).toEqual(new Set(featureKeys));
 expect(await target.prepare('SELECT last_claimed FROM analytics_partition_subject_schedule WHERE source_id=? AND owner_digest=?')
  .bind(sourceId,ownerDigest).first<number>('last_claimed')).toBeGreaterThan(0);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('carries anonymous head recency into a new immutable revision instead of resetting its fairness',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),original=work(411);
 const [oldKey]=await admitAnalyticsPartitionWork(target,[original],10);
 const old=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,leaseMs:1000}))[0]!;
 expect(old.workKey).toBe(oldKey);expect(await completeAnalyticsPartitionWork(target,old,[],21)).toBe(true);
 const oldRecency=await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(oldKey).first<number>('last_claimed');
 const [replacement]=await admitAnalyticsPartitionWork(target,[{...original,inputRevision:h(1411)}],22);
 const before=await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(replacement).first<Record<string,unknown>>();
 expect(before).toMatchObject({state:'ready',revision:0,attempts:0,last_claimed:oldRecency,head_key:original.headKey,
  input_revision:h(1411),claim_token:null,claim_expires_ms:0});
 const [untouched]=await admitAnalyticsPartitionWork(target,[work(412)],23);
 const next=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:24,leaseMs:1000}))[0]!;
 expect(next.workKey).toBe(untouched);
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(replacement).first()).toEqual(before);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('bounds anonymous retirement transfers and preserves a lower-recency live lease from interleaved tick reservations',async()=>{
 await setup();const original=work(421),[oldKey]=await admitAnalyticsPartitionWork(db(),[original],10);
 // Every successor uses immutable public admission; all are present before the
 // competing claim advances recency. This is queue metadata, not source work.
 const readyKeys:string[]=[];
 for(let offset=0;offset<131;offset+=32)readyKeys.push(...await admitAnalyticsPartitionWork(db(),
  Array.from({length:Math.min(32,131-offset)},(_,index)=>({...original,inputRevision:h(2000+offset+index)})),11));
 const meter=createD1InvocationBudget(950),target=meter.wrap(db());let interleaved=false;
 const transport=new Proxy(db(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first'&&sql.startsWith("UPDATE analytics_partition_work SET state='leased'"))return async(...args:unknown[])=>{
     if(!interleaved){
      interleaved=true;
      const competing=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,leaseMs:1000}))[0]!;
      expect(competing.workKey).toBe(oldKey);expect(await completeAnalyticsPartitionWork(target,competing,[],21)).toBe(true);
     }
     return Reflect.apply(inner.first,inner,args);
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  }
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const live=(await claimAnalyticsPartitionWork(meter.wrap(transport),{sourceId,limit:1,nowMs:30,leaseMs:1000}))[0]!;
 expect(readyKeys).toContain(live.workKey);
 const liveBefore=await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(live.workKey).first();
 expect(liveBefore).toMatchObject({state:'leased',last_claimed:1,revision:1});
 expect(await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(oldKey).first<number>('last_claimed')).toBe(2);
 const readyBefore=(await target.prepare("SELECT * FROM analytics_partition_work WHERE head_key=? AND state='ready' ORDER BY work_key")
  .bind(original.headKey).all<Record<string,unknown>>()).results;
 expect(readyBefore).toHaveLength(130);expect(readyBefore.every(row=>row.last_claimed===0&&row.revision===0)).toBe(true);
 expect(await retireAnalyticsPartitionWork(target,{sourceId,beforeMs:100,limit:1})).toBe(0);
 const firstPage=(await target.prepare("SELECT * FROM analytics_partition_work WHERE head_key=? AND state='ready' ORDER BY work_key")
  .bind(original.headKey).all<Record<string,unknown>>()).results;
 expect(firstPage.filter(row=>row.last_claimed===2)).toHaveLength(128);
 for(const row of firstPage){
  const before=readyBefore.find(value=>value.work_key===row.work_key)!;
  expect(row).toEqual({...before,revision:row.last_claimed===2?1:0,last_claimed:row.last_claimed===2?2:0});
 }
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(live.workKey).first()).toEqual(liveBefore);
 expect(await target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(oldKey).first<string>('state')).toBe('complete');
 expect(await retireAnalyticsPartitionWork(target,{sourceId,beforeMs:100,limit:1})).toBe(0);
 const secondPage=(await target.prepare("SELECT * FROM analytics_partition_work WHERE head_key=? AND state='ready' ORDER BY work_key")
  .bind(original.headKey).all<Record<string,unknown>>()).results;
 expect(secondPage).toHaveLength(130);
 for(const row of secondPage)expect(row).toEqual({...readyBefore.find(value=>value.work_key===row.work_key)!,revision:1,last_claimed:2});
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(live.workKey).first()).toEqual(liveBefore);
 expect(await releaseAnalyticsPartitionWork(target,live,'deferred',31)).toBe(true);
 const released=await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(live.workKey).first<Record<string,unknown>>();
 expect(await retireAnalyticsPartitionWork(target,{sourceId,beforeMs:100,limit:1})).toBe(1);
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(live.workKey).first())
  .toEqual({...released,revision:Number(released!.revision)+1,last_claimed:2});
 expect(await target.prepare('SELECT work_key FROM analytics_partition_work WHERE work_key=?').bind(oldKey).first()).toBeNull();
 expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('previews the exact anonymous eight-head prefix after unrelated cache claims',async()=>{
 await setup();const ownerDigest=h(431),day='2026-09-20';
 await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const facts:Awaited<ReturnType<typeof normalizeNativeEffectiveOccurrence>>[]=[];const roots=new Set<string>();
 for(let candidate=0;candidate<128&&facts.length<8;candidate++){
  const at=day+'T12:00:00.000Z',record={...v11UsageRecord(day),eventId:'event:v2:'+h(30000+candidate),eventTime:at};
  const fact=await normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
   {methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-local',ownerDigest,
    occurrenceId:record.eventId,eventTime:at,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],
    sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),canonicalEvidence:{linkedDays:[day],
     variants:[{coordinate:'synthetic:preview:'+candidate,format:'v11' as const,observedAtMs:Date.parse(at)}],
     boundaryFlags:{presence:'unknown' as const,value:null},tieOrder:{presence:'unknown' as const,value:null},
     cacheWriteFiveMinuteTokens:{presence:'unknown' as const,value:null},cacheWriteOneHourTokens:{presence:'unknown' as const,value:null}}},facts.length);
  if(roots.has(fact.location.partitionKey))continue;roots.add(fact.location.partitionKey);facts.push(fact);
 }
 expect(facts).toHaveLength(8);
 await materializeCanonicalPage({db:db(),sourceId,scope:{sourceNamespace:sourceId,ownerDigest,selectionMethod:'effective-union-v1'},
  ownerRevision:1,authorityEpoch:1,pageKey:h(3431),sourceRevision:h(3432),stillCurrent:async()=>true,
  load:async()=>facts.map(fact=>({occurrenceKey:fact.occurrenceKey,stream:'usage' as const,expectedRevision:null,fact}))});
 const requests:AnalyticsWorkRequest[]=[];
 for(const [index,fact] of facts.entries()){
  const partition=await materializeCanonicalPartition(db(),fact.location.partitionKey);expect(partition.state).toBe('complete');
  if(partition.state!=='complete')throw Error('SYNTHETIC_PREVIEW_PARTITION_REQUIRED');
  requests.push(work(431+index,{ownerDigest:index<4?ownerDigest:null,partitionKey:fact.location.partitionKey,
   headKey:await sha256Hex(canonicalJson(['features',sourceId,fact.location.partitionKey])),
   inputRevision:await sha256Hex(canonicalJson([fact.location.partitionKey,partition.manifest.generation]))}));
 }
 const workKeys=await admitAnalyticsPartitionWork(db(),requests,10);
 const [heavyKey]=await admitAnalyticsPartitionWork(db(),[work(449,{admissionQueries:600})],0);
 const heavyBefore=await db().prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(heavyKey).first();
 const [cacheKey]=await admitAnalyticsPartitionWork(db(),[work(450,{stage:'cache'})],20);
 const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 for(let turn=0;turn<12;turn++){
  const cache=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:30+turn,stages:['cache']}))[0]!;
  expect(cache.workKey).toBe(cacheKey);expect(await releaseAnalyticsPartitionWork(target,cache,'deferred',30+turn)).toBe(true);
 }
 const first=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:50,maxAdmissionQueries:50}))[0]!;
 expect(workKeys).toContain(first.workKey);
 // Across all stages, the next actual cache opportunity makes a homogeneous
 // preview ineligible. A declared feature-only caller retains its exact prefix.
 expect(await previewAnalyticsFeatureGroup({target,first,sourceId,nowMs:50}))
  .toEqual({state:'ineligible',reason:'incompatible_prefix'});
 const preview=await previewAnalyticsFeatureGroup({target,first,sourceId,nowMs:50,stages:['features'],maxAdmissionQueries:50});
 expect(preview.state).toBe('eligible');if(preview.state!=='eligible')throw Error('SYNTHETIC_PREVIEW_REQUIRED');
 expect(preview).toMatchObject({facts:8,scopes:1,residentBytes:8*4096});
 expect(await target.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn')).toBe(13);
 const actual=[first,...await claimAnalyticsPartitionWork(target,{sourceId,limit:7,nowMs:50,stages:['features'],maxAdmissionQueries:50,expectedWorkKeys:preview.workKeys.slice(1)})];
 expect(actual.map(lease=>lease.workKey)).toEqual(preview.workKeys);expect(new Set(actual.map(lease=>lease.headKey)).size).toBe(8);
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(heavyKey).first()).toEqual(heavyBefore);
 const classes=[];
 for(const lease of actual)classes.push((await readAnalyticsPartitionWork(target,lease,50))!.ownerDigest===null?'anonymous':'named');
 expect(classes).toEqual(['named','anonymous','named','anonymous','named','anonymous','named','anonymous']);
 expect(await target.prepare("SELECT last_claimed,claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).first()).toEqual({last_claimed:20,claim_count:8,jobs:8});
 for(const lease of actual)expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',51)).toBe(true);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_subject_schedule WHERE source_id=? AND owner_digest=''")
  .bind(sourceId).first<number>('n')).toBe(0);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('requires the maintained head-recency index and freshly recognizes its restoration',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 const create=await target.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='analytics_partition_work_head'").first<string>('sql');
 expect(typeof create).toBe('string');expect(create).toContain('CREATE INDEX analytics_partition_work_head');
 await target.prepare('DROP INDEX analytics_partition_work_head').run();
 expect(await analyticsPartitionWorkAvailable(target)).toBe(false);
 expect(await target.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first()).toBeNull();
 await target.prepare(create!).run();
 expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('keeps anonymous claim recency monotonic when a reserved tick follows a newer same-row deferral',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),[workKey]=await admitAnalyticsPartitionWork(target,[work(461)],10);
 let interleaved=false;let competing:Awaited<ReturnType<typeof claimAnalyticsPartitionWork>>[number]|undefined;
 const transport=new Proxy(db(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first'&&sql.startsWith("UPDATE analytics_partition_work SET state='leased'"))return async(...args:unknown[])=>{
     if(!interleaved){
      interleaved=true;
      competing=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,leaseMs:1000}))[0]!;
      expect(competing.workKey).toBe(workKey);
      expect(await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(workKey).first<number>('last_claimed')).toBe(2);
      expect(await releaseAnalyticsPartitionWork(target,competing,'deferred',21)).toBe(true);
     }
     return Reflect.apply(inner.first,inner,args);
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  }
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const delayed=(await claimAnalyticsPartitionWork(meter.wrap(transport),{sourceId,limit:1,nowMs:30,leaseMs:1000}))[0]!;
 expect(delayed.workKey).toBe(workKey);expect(delayed.claimToken).not.toBe(competing!.claimToken);
 expect(await target.prepare('SELECT revision,attempts,last_claimed,state FROM analytics_partition_work WHERE work_key=?')
  .bind(workKey).first()).toEqual({revision:3,attempts:2,last_claimed:2,state:'leased'});
 expect(await target.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn')).toBe(2);
 expect(await releaseAnalyticsPartitionWork(target,competing!,'complete',31)).toBe(false);
 expect(await previewAnalyticsFeatureGroup({target,first:delayed,sourceId,nowMs:30}))
  .toEqual({state:'ineligible',reason:'singleton_retry_required'});
 expect(await releaseAnalyticsPartitionWork(target,delayed,'deferred',31)).toBe(true);
 const next=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:32,leaseMs:1000}))[0]!;
 expect(next.workKey).toBe(workKey);
 expect(await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(workKey).first<number>('last_claimed')).toBe(3);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);
it('reserves named opportunities within a stage under continuously admitted anonymous heads',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),ownerDigest=h(471);
 await target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const [namedKey]=await admitAnalyticsPartitionWork(target,[work(471,{ownerDigest})],10);
 const warm=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,stages:['features']}))[0]!;
 expect(warm.workKey).toBe(namedKey);expect(await releaseAnalyticsPartitionWork(target,warm,'deferred',21)).toBe(true);
 const classes:string[]=[];
 for(let turn=0;turn<12;turn++){
  await admitAnalyticsPartitionWork(target,[work(480+turn)],30+turn);
  const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:30+turn,stages:['features']}))[0]!;
  const row=await readAnalyticsPartitionWork(target,lease,30+turn);expect(row).not.toBeNull();
  classes.push(row!.ownerDigest===null?'anonymous':'named');
  if(row!.ownerDigest!==null)expect(lease.workKey).toBe(namedKey);
  expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',30+turn)).toBe(true);
 }
 expect(classes.filter(value=>value==='named')).toHaveLength(6);
 expect(classes.filter(value=>value==='anonymous')).toHaveLength(6);
 expect(classes.every((value,index)=>index===0||value!==classes[index-1])).toBe(true);
 const counts=await target.prepare("SELECT last_claimed,claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).first();
 expect(counts).toEqual({last_claimed:13,claim_count:13,jobs:0});expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('reserves independent stage opportunities during continuous anonymous cache arrivals',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),ownerDigest=h(501);
 await target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 await admitAnalyticsPartitionWork(target,[work(501),work(502,{stage:'fits',ownerDigest})],10);
 const selected:string[]=[];
 for(let turn=0;turn<12;turn++){
  await admitAnalyticsPartitionWork(target,[work(510+turn,{stage:'cache'})],20+turn);
  const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20+turn,stages:['features','fits','cache']}))[0]!;
  selected.push(lease.stage);expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',20+turn)).toBe(true);
 }
 for(const stage of ['features','fits','cache']){
  expect(selected.filter(value=>value===stage)).toHaveLength(4);
  for(let start=0;start<=selected.length-3;start++)expect(selected.slice(start,start+3)).toContain(stage);
  expect(await target.prepare("SELECT claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage=? AND state='leased'")
   .bind(sourceId,stage).first()).toEqual({claim_count:4,jobs:0});
 }
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('records every actual anonymous stage claim once through lost responses, expired reclaim and terminal release',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 await admitAnalyticsPartitionWork(target,[work(530)],10);let lost=true;
 const transport=new Proxy(db(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first'&&sql.startsWith("UPDATE analytics_partition_work SET state='leased'"))return async(...args:unknown[])=>{
     const result=await Reflect.apply(inner.first,inner,args);if(lost){lost=false;throw Error('synthetic lost claim response');}return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  }
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const count=()=>target.prepare("SELECT last_claimed,claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).first();
 await expect(claimAnalyticsPartitionWork(meter.wrap(transport),{sourceId,limit:1,nowMs:20,leaseMs:1000})).rejects.toThrow('synthetic lost claim response');
 expect(await count()).toEqual({last_claimed:1,claim_count:1,jobs:1});
 expect(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:21,leaseMs:1000})).toEqual([]);
 expect(await count()).toEqual({last_claimed:1,claim_count:1,jobs:1});
 const renewed=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:1021,leaseMs:1000}))[0]!;
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:1});
 expect(await recordAnalyticsPartitionWorkReason(target,renewed,'producer_deferred',1021)).toBeUndefined();
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:1});
 expect(await completeAnalyticsPartitionWork(target,renewed,[],1022)).toBe(true);
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:0});
 expect(await releaseAnalyticsPartitionWork(target,renewed,'deferred',1022)).toBe(false);
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:0});
 expect(await retireAnalyticsPartitionWork(target,{sourceId,beforeMs:2000,limit:1})).toBe(1);
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:0});
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('requires the covering head-recency index and freshly recognizes its restoration',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 const create=await target.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='analytics_partition_work_head_recency'").first<string>('sql');
 expect(typeof create).toBe('string');expect(create).toContain('CREATE INDEX analytics_partition_work_head_recency');
 await target.prepare('DROP INDEX analytics_partition_work_head_recency').run();
 expect(await target.prepare("SELECT 1 present FROM sqlite_schema WHERE type='index' AND name='analytics_partition_work_head'").first<number>('present')).toBe(1);
 expect(await analyticsPartitionWorkAvailable(target)).toBe(false);
 expect(await target.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first()).toBeNull();
 await target.prepare(create!).run();expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('reads a dense anonymous head through the covering recency index with truthful claim costs',async({task})=>{
 const results=[];
 for(const priorRevisions of [1,128]){
  await setup();const setupMeter=createD1InvocationBudget(950),target=setupMeter.wrap(db()),original=work(550);
  for(let index=0;index<priorRevisions;index++){
   const [key]=await admitAnalyticsPartitionWork(target,[{...original,inputRevision:h(6000+index)}],10+index);
   const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:2000+index,stages:['features']}))[0]!;
   expect(lease.workKey).toBe(key);expect(await completeAnalyticsPartitionWork(target,lease,[],2000+index)).toBe(true);
  }
  const [nextKey]=await admitAnalyticsPartitionWork(target,[{...original,inputRevision:h(7000)}],3000);
  expect(await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(nextKey).first<number>('last_claimed')).toBe(priorRevisions);
  const probeProfile=createAnalyticsProfile(),probeMeter=createD1InvocationBudget(950);
  const probe=probeMeter.wrap(profileAnalyticsDatabase(db(),'target',probeProfile,()=> 'head_recency_probe'));
  // This isolates the same indexed MAX used by admission/selection. It is a
  // metadata index component, not a producer or whole-workload speed claim.
  expect(await probe.prepare(`SELECT MAX(last_claimed) maximum FROM analytics_partition_work
   INDEXED BY analytics_partition_work_head_recency WHERE head_key=? AND source_id=? AND owner_digest IS NULL`)
   .bind(original.headKey,sourceId).first<number>('maximum')).toBe(priorRevisions);
  const probeCosts=Object.values(probeProfile.costs),probeReads=probeCosts.reduce((sum,cost)=>sum+cost.rowsRead,0);
  expect(probeMeter.queriesUsed).toBe(1);expect(probeCosts.reduce((sum,cost)=>sum+cost.metadataSamples,0)).toBe(1);
  expect(probeReads).toBeLessThanOrEqual(2);
  const claimProfile=createAnalyticsProfile(),claimMeter=createD1InvocationBudget(950);
  const claimed=(await claimAnalyticsPartitionWork(claimMeter.wrap(profileAnalyticsDatabase(db(),'target',claimProfile,()=> 'actual_claim')),
   {sourceId,limit:1,nowMs:3001,stages:['features']}))[0]!;
  expect(claimed.workKey).toBe(nextKey);
  const claimCosts=Object.values(claimProfile.costs);
  expect(claimCosts.reduce((sum,cost)=>sum+cost.metadataSamples,0)).toBe(claimMeter.queriesUsed);
  expect(claimCosts.reduce((sum,cost)=>sum+cost.failedStatements,0)).toBe(0);
  expect(await target.prepare('SELECT last_claimed FROM analytics_partition_work WHERE work_key=?').bind(nextKey).first<number>('last_claimed')).toBe(priorRevisions+1);
  expect(await target.prepare("SELECT last_claimed,claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
   .bind(sourceId).first()).toEqual({last_claimed:priorRevisions+1,claim_count:priorRevisions+1,jobs:1});
  expect(setupMeter.queriesUsed).toBeLessThanOrEqual(950);expect(claimMeter.queriesUsed).toBeLessThanOrEqual(950);
  results.push({priorRevisions,nativeWorkSeedQueries:setupMeter.queriesUsed,indexProbe:{statements:probeMeter.queriesUsed,rowsRead:probeReads},
   actualClaim:{statements:claimMeter.queriesUsed,rowsRead:claimCosts.reduce((sum,cost)=>sum+cost.rowsRead,0),
    rowsWritten:claimCosts.reduce((sum,cost)=>sum+cost.rowsWritten,0)},cpuMs:null,observedPeakHeapBytes:null});
 }
 Object.assign(task.meta,{denseAnonymousHead:{results,contract:'Actual native API work admission/claims/completion and exact metadata index probe. Migration/setup is separate; rows-read is D1 metadata, not physical IO, network bytes or isolate CPU/peak heap.'}});
},60_000);

it('refuses anonymous claim and preview after the claim trigger disappears from a previously available schema',async({task})=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 const keys=await admitAnalyticsPartitionWork(target,Array.from({length:8},(_,index)=>work(580+index)),10);
 expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 const first=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,stages:['features']}))[0]!;
 const before=await target.prepare('SELECT * FROM analytics_partition_work WHERE source_id=? ORDER BY work_key')
  .bind(sourceId).all();
 const triggerQueries=b.TEST_ANALYTICS_MIGRATIONS.flatMap(migration=>migration.queries)
  .filter(sql=>sql.includes('CREATE TRIGGER analytics_partition_counts_claim '));
 expect(triggerQueries).toHaveLength(1);
 // The prior availability hint cannot authorize a claim after schema changes.
 // Restoration uses the exact migration statement, with no fabricated count
 // or work/lease mutation in this test adapter.
 await target.prepare('DROP TRIGGER analytics_partition_counts_claim').run();
 expect(await previewAnalyticsFeatureGroup({target,first,sourceId,nowMs:21,stages:['features']}))
  .toEqual({state:'ineligible',reason:'fair_prefix_incomplete'});
 expect(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:21,stages:['features']})).toEqual([]);
 expect((await target.prepare('SELECT * FROM analytics_partition_work WHERE source_id=? ORDER BY work_key')
  .bind(sourceId).all()).results).toEqual(before.results);
 const count=()=>target.prepare("SELECT last_claimed,claim_count,jobs FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).first();
 expect(await count()).toEqual({last_claimed:1,claim_count:1,jobs:1});
 expect(await analyticsPartitionWorkAvailable(target)).toBe(false);
 await target.prepare(triggerQueries[0]!).run();
 expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
 const resumed=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:22,stages:['features']}))[0]!;
 expect(keys).toContain(resumed.workKey);expect(resumed.workKey).not.toBe(first.workKey);
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:2});
 expect(await releaseAnalyticsPartitionWork(target,first,'complete',23)).toBe(true);
 expect(await releaseAnalyticsPartitionWork(target,resumed,'complete',23)).toBe(true);
 expect(await count()).toEqual({last_claimed:3,claim_count:2,jobs:0});
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 Object.assign(task.meta,{claimTriggerGuard:{statements:meter.queriesUsed,refused:{last_claimed:1,claim_count:1,jobs:1},
  restored:{last_claimed:3,claim_count:2,jobs:2},cpuMs:null,observedPeakHeapBytes:null}});
},60_000);


it('keeps underfunded history and recovery claims untouched until a funded natural turn',async({task})=>{
 await setup();const ownerDigest=h(610),setupMeter=createD1InvocationBudget(950),setupDb=setupMeter.wrap(db());
 await setupDb.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const keys=await admitAnalyticsPartitionWork(setupDb,[work(610,{stage:'fits',lane:'history',ownerDigest,day:null,admissionQueries:600}),
  work(611,{stage:'features',lane:'recovery',admissionQueries:600}),work(612,{stage:'cache',admissionQueries:160})],10);
 const before=(await setupDb.prepare('SELECT * FROM analytics_partition_work WHERE work_key IN(SELECT value FROM json_each(?)) ORDER BY work_key')
  .bind(JSON.stringify(keys.slice(0,2))).all()).results;
 const lowProfile=createAnalyticsProfile(),lowMeter=createD1InvocationBudget(517);
 const low=lowMeter.wrap(profileAnalyticsDatabase(db(),'target',lowProfile,()=> 'low_admission_claim'));
 const funded=(await claimAnalyticsPartitionWork(low,{sourceId,limit:1,nowMs:20,maxAdmissionQueries:511}))[0]!;
 expect(funded.workKey).toBe(keys[2]);expect(funded.admissionQueries).toBe(160);
 expect(await completeAnalyticsPartitionWork(low,funded,[],20)).toBe(true);
 expect((await low.prepare('SELECT * FROM analytics_partition_work WHERE work_key IN(SELECT value FROM json_each(?)) ORDER BY work_key')
  .bind(JSON.stringify(keys.slice(0,2))).all()).results).toEqual(before);
 expect((await low.prepare("SELECT stage,claim_count FROM analytics_partition_work_counts WHERE source_id=? AND stage IN('features','fits') AND state='leased'")
  .bind(sourceId).all()).results).toEqual([]);
 // Four explicitly unfunded ordinary opportunities advance only the source
 // cursor. No producer, head, class or stage turn is fabricated for them.
 expect(await claimAnalyticsPartitionWork(low,{sourceId,limit:4,nowMs:21,maxAdmissionQueries:0})).toEqual([]);
 expect(await low.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn')).toBe(5);
 const freshProfile=createAnalyticsProfile(),freshMeter=createD1InvocationBudget(950);
 const fresh=freshMeter.wrap(profileAnalyticsDatabase(db(),'target',freshProfile,()=> 'funded_history_claim'));
 const history=(await claimAnalyticsPartitionWork(fresh,{sourceId,limit:1,nowMs:22,maxAdmissionQueries:600}))[0]!;
 expect(history.workKey).toBe(keys[0]);expect((await readAnalyticsPartitionWork(fresh,history,22))!.lane).toBe('history');
 const execution=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,invocation:freshMeter,
  deadlineMs:60_000,now:()=>22,releaseQueries:2,claim:async()=>[history],
  execute:async(_,budget)=>{expect(budget.remainingQueries()).toBeGreaterThanOrEqual(600);
   await budget.meter.wrap(fresh).prepare('SELECT 1 admitted').first();return 'deferred';},
  release:async(lease,outcome)=>{expect(await releaseAnalyticsPartitionWork(fresh,lease,outcome,22)).toBe(true);}});
 expect(execution).toMatchObject({claimed:1,admitted:1,deferred:1,releaseDeferred:0});
 expect(await fresh.prepare("SELECT claim_count FROM analytics_partition_work_counts WHERE source_id=? AND stage='fits' AND state='leased'")
  .bind(sourceId).first<number>('claim_count')).toBe(1);
 const resources=[{limit:517,profile:lowProfile,meter:lowMeter},{limit:950,profile:freshProfile,meter:freshMeter}].map(({limit,profile,meter})=>{
  const costs=Object.values(profile.costs);expect(costs.reduce((n,c)=>n+c.statements,0)).toBe(meter.queriesUsed);
  expect(costs.reduce((n,c)=>n+c.failedStatements,0)).toBe(0);expect(meter.queriesUsed).toBeLessThanOrEqual(limit);
  return {limit,statements:meter.queriesUsed,rowsRead:costs.reduce((n,c)=>n+c.rowsRead,0),rowsWritten:costs.reduce((n,c)=>n+c.rowsWritten,0)};
 });
 Object.assign(task.meta,{admissionFairness:{resources,qualified:'Native claim and dispatcher admission controls only; producer output parity remains a separate role gate.'}});
},60_000);

it('retains expired underfunded leases and reclaims them when a full allowance returns',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 const [key]=await admitAnalyticsPartitionWork(target,[work(620,{lane:'history',admissionQueries:600})],10);
 const first=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,leaseMs:1000,maxAdmissionQueries:600}))[0]!;
 expect(first.workKey).toBe(key);
 const before=await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(key).first();
 const count=()=>target.prepare("SELECT * FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).first();const beforeCount=await count();
 expect(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:1021,leaseMs:1000,maxAdmissionQueries:511})).toEqual([]);
 expect(await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(key).first()).toEqual(before);
 expect(await count()).toEqual(beforeCount);
 const renewed=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:1022,leaseMs:1000,maxAdmissionQueries:600}))[0]!;
 expect(renewed.workKey).toBe(key);expect(renewed.revision).toBe(first.revision+1);expect(renewed.claimToken).not.toBe(first.claimToken);
 expect(await releaseAnalyticsPartitionWork(target,first,'complete',1022)).toBe(false);
 const [competingKey]=await admitAnalyticsPartitionWork(target,[work(621,{headKey:first.headKey,admissionQueries:50})],1023);
 expect(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:1023,maxAdmissionQueries:900})).toEqual([]);
 expect(await target.prepare('SELECT attempts FROM analytics_partition_work WHERE work_key=?').bind(competingKey).first<number>('attempts')).toBe(0);
 expect(await releaseAnalyticsPartitionWork(target,renewed,'complete',1024)).toBe(true);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('rejects invalid admission ceilings before claim or advisory preview writes',async()=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 await admitAnalyticsPartitionWork(target,[work(630)],10);
 const first=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20}))[0]!;
 const before=meter.queriesUsed;
 for(const maxAdmissionQueries of [-1,0.5,901,NaN,Infinity,'600' as unknown as number]){
  await expect(claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:21,maxAdmissionQueries})).rejects.toThrow('ANALYTICS_PARTITION_WORK_INVALID');
  await expect(previewAnalyticsFeatureGroup({target,first,sourceId,nowMs:21,maxAdmissionQueries})).rejects.toThrow('ANALYTICS_PARTITION_WORK_INVALID');
 }
 expect(meter.queriesUsed).toBe(before);
 expect(await releaseAnalyticsPartitionWork(target,first,'complete',22)).toBe(true);
},60_000);

it('keeps cumulative multi-claim admission and exact unadmitted release under a per-job ceiling',async({task})=>{
 await setup();const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
 const target=meter.wrap(profileAnalyticsDatabase(db(),'target',profile,()=> 'multi_admission_guard'));
 const keys=await admitAnalyticsPartitionWork(target,[work(640,{admissionQueries:600}),work(641,{admissionQueries:600})],10);
 const leases=await claimAnalyticsPartitionWork(target,{sourceId,limit:2,nowMs:20,maxAdmissionQueries:900});
 expect(leases).toHaveLength(2);expect(new Set(leases.map(lease=>lease.workKey))).toEqual(new Set(keys));
 const releases:string[]=[];
 const progress=await dispatchAnalyticsWork({degree:2,maxResidentBytes:32*1024*1024,invocation:meter,deadlineMs:60_000,
  now:()=>20,releaseQueries:2,claim:async()=>leases,
  execute:async(_,budget)=>{await budget.meter.wrap(target).prepare('SELECT 1 actual_admission').first();return 'deferred';},
  release:async(lease,outcome)=>{releases.push(outcome);expect(await releaseAnalyticsPartitionWork(target,lease,outcome,20)).toBe(true);}});
 expect(progress).toMatchObject({claimed:2,admitted:1,deferred:2,releaseDeferred:0});
 expect(releases.sort()).toEqual(['deferred','not_admitted']);
 expect((await target.prepare("SELECT state,claim_token,claim_expires_ms FROM analytics_partition_work WHERE source_id=? ORDER BY work_key")
  .bind(sourceId).all()).results).toEqual([{state:'ready',claim_token:null,claim_expires_ms:0},{state:'ready',claim_token:null,claim_expires_ms:0}]);
 const costs=Object.values(profile.costs);expect(costs.reduce((n,c)=>n+c.statements,0)).toBe(meter.queriesUsed);
 expect(costs.reduce((n,c)=>n+c.failedStatements,0)).toBe(0);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 Object.assign(task.meta,{multiAdmission:{statements:meter.queriesUsed,progress,qualified:'Per-job filtering does not replace the existing cumulative dispatcher guard.'}});
},60_000);

it('keeps history opportunities independent of interleaved cache-only claims',async({task})=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db()),ownerDigest=h(800);
 await target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(sourceId,ownerDigest).run();
 const [historyKey,cacheKey]=await admitAnalyticsPartitionWork(target,[work(800,{stage:'fits',lane:'history'}),
  work(801,{stage:'cache'}),...(['withdrawal','new','recovery'] as const).flatMap((lane,index)=>
   [work(810+index*2,{stage:'fits',lane,ownerDigest}),work(811+index*2,{stage:'fits',lane})])],10);
 const selected:string[]=[];
 for(let turn=0;turn<6;turn++){
  const fit=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20+turn,stages:['fits']}))[0]!;
  const row=await readAnalyticsPartitionWork(target,fit,20+turn);expect(row).not.toBeNull();
  selected.push(row!.lane);if(row!.lane==='history')expect(fit.workKey).toBe(historyKey);
  expect(await releaseAnalyticsPartitionWork(target,fit,'deferred',20+turn)).toBe(true);
  const cache=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:30+turn,stages:['cache']}))[0]!;
  expect(cache.workKey).toBe(cacheKey);expect(await releaseAnalyticsPartitionWork(target,cache,'deferred',30+turn)).toBe(true);
 }
 Object.assign(task.meta,{stageLaneCycleReceipt:{selected,queriesUsed:meter.queriesUsed,
  boundary:'Store selector only; real role producer and publication qualification remain separate.'}});
 expect(selected[5]).toBe('history');expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);


it('gives dated recovery a bounded age turn and retains FIFO turns during continuous arrivals',async({task})=>{
 await setup();const meter=createD1InvocationBudget(950),target=meter.wrap(db());
 const [oldKey]=await admitAnalyticsPartitionWork(target,[work(910,{lane:'recovery',day:'2026-01-01'})],10);
 const warm=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,stages:['features']}))[0]!;
 expect(warm.workKey).toBe(oldKey);expect(await releaseAnalyticsPartitionWork(target,warm,'deferred',20)).toBe(true);
 const [waitingKey]=await admitAnalyticsPartitionWork(target,[work(911,{lane:'recovery',day:'2026-08-01'})],21);
 const selected:string[]=[];
 for(let turn=0;turn<18;turn++){
  await admitAnalyticsPartitionWork(target,[work(920+turn,{lane:'recovery',day:'2026-09-20'})],30+turn);
  const lease=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:50+turn,stages:['features']}))[0]!;
  selected.push(lease.workKey);expect(await releaseAnalyticsPartitionWork(target,lease,'deferred',50+turn)).toBe(true);
 }
 Object.assign(task.meta,{datedRecoverySchedule:{queriesUsed:meter.queriesUsed,oldFirst:selected[0]===oldKey,
  waitingAt:selected.indexOf(waitingKey!)+1,totalTurns:selected.length}});
 expect(selected[0],'a retained date gets an age turn despite its prior claim').toBe(oldKey);
 expect(selected.indexOf(waitingKey!)).toBeGreaterThanOrEqual(0);
 expect(selected.indexOf(waitingKey!)+1,'a deferred oldest date cannot consume every FIFO opportunity').toBeLessThanOrEqual(12);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
},60_000);

it('gives fresh new dates a bounded turn before old unclaimed new work',async()=>{
 await setup();const target=createD1InvocationBudget(950).wrap(db());
 const [oldKey]=await admitAnalyticsPartitionWork(target,[work(970,{day:'2026-01-01'})],10);
 const [freshKey]=await admitAnalyticsPartitionWork(target,[work(971,{day:'2026-09-20'})],11);
 const first=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,stages:['features']}))[0]!;
 expect(first.workKey).toBe(freshKey);expect(first.workKey).not.toBe(oldKey);
},60_000);

it('shares failure backoff across same-input policy revisions while accepting changed input',async()=>{
 await setup();const target=createD1InvocationBudget(950).wrap(db()),request=work(980,{stage:'fits',lane:'history',day:null});
 const [oldKey]=await admitAnalyticsPartitionWork(target,[request],10);
 const old=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:20,stages:['fits']}))[0]!;
 expect(old.workKey).toBe(oldKey);
 const [newKey]=await admitAnalyticsPartitionWork(target,[{...request,policyRevision:h(1001),admissionQueries:30}],21);
 expect(await releaseAnalyticsPartitionWork(target,old,'failure',22)).toBe(true);
 expect(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:23,stages:['fits'],maxAdmissionQueries:30})).toEqual([]);
 const [changedKey]=await admitAnalyticsPartitionWork(target,[{...request,policyRevision:h(1001),inputRevision:h(1002),admissionQueries:30}],24);
 const changed=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:25,stages:['fits'],maxAdmissionQueries:30}))[0]!;
 expect(changed.workKey).toBe(changedKey);expect(await releaseAnalyticsPartitionWork(target,changed,'complete',25)).toBe(true);
 const resumed=(await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:5023,stages:['fits'],maxAdmissionQueries:30}))[0]!;
 expect(resumed.workKey).toBe(newKey);
},60_000);
