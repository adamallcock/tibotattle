import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {v11UsageRecord} from './helpers/telemetry-v11';
import {canonicalOccurrenceKey,MAX_CANONICAL_PARTITION_ROWS,normalizeNativeEffectiveOccurrence,normalizeSelectedTelemetryRecord,
 type CanonicalFact,type CanonicalScope} from '../src/canonical-analytics-facts';
import {materializeCanonicalPage,materializeCanonicalPartition,readCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {canonicalCacheItems,cacheRetentionEventFromRecordValue,cacheRetentionSessionDigest} from '../src/cache-retention-events';
import {materializeCanonicalFeaturePartition} from '../src/storage-canonical-feature-contributions';
import {CANONICAL_DAILY_PRICE_METHOD,CANONICAL_FIT_PRICE_METHOD} from '../src/canonical-feature-contributions';
import {canonicalCachePair} from '../src/canonical-cache-pairs';
import {CANONICAL_CACHE_TABLES,CANONICAL_CACHE_PREPARED_READY_PREDICATE,canonicalCacheAvailable,canonicalCachePreparedRepairBlocked,
 canonicalCacheRepairPageBlocked,recordCanonicalCachePreparedReceipt,materializeCanonicalCachePartition,repairCanonicalCacheNeighbors,
 readCanonicalCacheDay,readCanonicalCacheSeries,readCanonicalCacheSeriesResult,retireCanonicalCachePage,
 CANONICAL_CACHE_SUPERSEDED_DELETE_SQL} from '../src/storage-canonical-cache-pairs';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,completeAnalyticsPartitionWork,
 recordAnalyticsPartitionWorkReason} from '../src/storage-analytics-partition-work';
import {createCacheRetentionCanonicalDayBuild,readCacheRetentionCommunitySeries,CACHE_RETENTION_EFFECTIVE_DEVICE_ID,CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,cacheRetentionLookbackDays} from '../src/cache-retention-day';
import {mergeCacheRetentionBands,publicCacheRetentionWindow,CACHE_RETENTION_WINDOWS,reduceCacheRetentionDay,CACHE_RETENTION_METHOD,type CacheRetentionEvent,type CacheRetentionItem} from '../src/cache-retention-values';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
const bindings=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=()=>bindings.STORAGE_ANALYTICS_DB,sourceId='synthetic-cache',day='2026-09-20';
const scope:CanonicalScope={sourceNamespace:sourceId,ownerDigest:'a'.repeat(64),selectionMethod:'effective-union-v1'};
const cacheScope={sourceId,ownerDigest:scope.ownerDigest,selectionMethod:scope.selectionMethod};
const unknown={presence:'unknown' as const,value:null};
const budget={remainingQueries:()=>950,now:()=>0,deadlineMs:60_000};
const current=async()=>true;
async function fact(id:string,at=day+'T12:00:00.000Z',overrides:Record<string,unknown>={},rank=0,legacySlot?:string,ownerScope:CanonicalScope=scope):Promise<CanonicalFact> {
 at=new Date(at).toISOString();
 const base=v11UsageRecord(at.slice(0,10));
 const record={...base,eventId:'event:v2:'+await sha256Hex(id),eventTime:at,...overrides,components:{...base.components,...(overrides.components as object??{})}};
 const unreadable=record.modelId===null;if(unreadable)record.modelId=base.modelId;
 const evidence={linkedDays:[at.slice(0,10)],variants:[{coordinate:'synthetic:'+id,format:'v11' as const,observedAtMs:Date.parse(at)}],
  boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown};
 if(legacySlot)return normalizeSelectedTelemetryRecord({...ownerScope,selectionMethod:'legacy-selected-v1'},
  {stream:'usage',occurrenceId:record.eventId,eventTime:at,recordJson:canonicalTelemetryV11Json(record),evidence,
   nativeOrder:rank,selectedSlotKey:await sha256Hex(legacySlot),sourceFamily:'v1',occurrenceTieOrder:0});
 const normalized=await normalizeNativeEffectiveOccurrence(ownerScope,{methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-local',
  ownerDigest:ownerScope.ownerDigest,occurrenceId:record.eventId,eventTime:at,eventTimeConflict:false,status:'compatible',sourceCount:1,
  sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),canonicalEvidence:evidence},rank);
 // Synthetic closed unreadable evidence tests the consumer independently of
 // the source adapter, whose strict parser currently refuses malformed rows.
 if(unreadable){const {revision:_revision,...body}=normalized;const value={...body,values:{...body.values,modelId:null}};return {...value,revision:await sha256Hex(canonicalJson(value))};}
 return normalized;
}
let stamp=0;
async function change(next:CanonicalFact|null,old:CanonicalFact|null=null,ownerScope:CanonicalScope=scope,
 bindingSourceId=sourceId,database=db()) {
 const value=next??old!;
 await materializeCanonicalPage({db:database,sourceId:bindingSourceId,scope:{...ownerScope,selectionMethod:value.provenance.selectionMethod},ownerRevision:1,authorityEpoch:1,
  pageKey:await sha256Hex('page:'+ ++stamp),sourceRevision:await sha256Hex('source:'+stamp),stillCurrent:current,load:async()=>[
   {occurrenceKey:value.occurrenceKey,stream:'usage',expectedRevision:old?.revision??null,fact:next}]});
 const keys=[...new Set([next?.location.partitionKey,old?.location.partitionKey].filter((key):key is string=>!!key))];
 for(const key of keys)await materializeCanonicalPartition(database,key);
 return keys;
}
async function sync(keys:readonly string[]) {
 for(const key of new Set(keys))await materializeCanonicalCachePartition({target:db(),partitionKey:key,budget,stillCurrent:current});
 for(let i=0;i<32;i++)if(await repairCanonicalCacheNeighbors({target:db(),budget,stillCurrent:current}))return;
 throw new Error('repairs did not settle');
}
async function read(label=day,selectionMethod=scope.selectionMethod){return readCanonicalCacheDay({target:db(),scope:{...cacheScope,selectionMethod},day:label,stillCurrent:current});}
async function oracle(facts:readonly CanonicalFact[],label=day) {
 const {items}=await canonicalCacheItems(facts),start=Date.parse(label+'T00:00:00Z');
 const own=items.filter(item=>item.observedAtMs>=start&&item.observedAtMs<start+86400000),sessions=new Set(own.map(item=>item.sessionDigest));
 const carry=new Map<string,CacheRetentionEvent>();
 for(const item of items.filter(item=>item.observedAtMs>=start-CACHE_RETENTION_METHOD.maximumGapMs&&item.observedAtMs<start&&sessions.has(item.sessionDigest))) {
  if('unreadable'in item)carry.delete(item.sessionDigest);else carry.set(item.sessionDigest,item);
 }
 return reduceCacheRetentionDay({day:label,events:own,carry:[...carry.values()],eventsRead:facts.filter(f=>f.location.day===label).length});
}
beforeEach(async()=>{
 await reset();stamp=0;await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await db().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)').bind(sourceId,sourceId).run();
 await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')").bind(sourceId,scope.ownerDigest).run();
});

it('defers only a prepared leaf whose first bounded repair page awaits another real leaf',async()=>{
 const setup=createAnalyticsProfile(),setupDb=profileAnalyticsDatabase(db(),'target',setup,()=> 'setup');
 const first=await fact('shared-logical',day+'T12:00:00Z',{},0,'prepared-slot-0');
 let second:CanonicalFact|undefined;
 for(let n=1;n<=32;n++){
  const candidate=await fact('shared-logical',day+'T12:00:00Z',{},1,'prepared-slot-'+n);
  if(candidate.location.partitionKey!==first.location.partitionKey){second=candidate;break;}
 }
 expect(second).toBeDefined();
 expect(second!.nativeScopes.logicalOccurrenceKey).toBe(first.nativeScopes.logicalOccurrenceKey);
 expect(new Set([first.location.partitionKey,second!.location.partitionKey]).size).toBe(2);
 await change(first,null,scope,sourceId,setupDb);await change(second!,null,scope,sourceId,setupDb);
 const nowMs=Date.parse(day+'T15:00:00Z');
 for(const value of [first,second!]){
  const partition=await readCanonicalPartition(db(),value.location.partitionKey);expect(partition).not.toBeNull();
  await admitAnalyticsPartitionWork(setupDb,[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',
   partitionKey:value.location.partitionKey,headKey:await sha256Hex('cache-head:'+value.location.partitionKey),
   inputRevision:partition!.manifest.contentRevision,policyRevision:'c'.repeat(64),day,stream:'usage',
   selectionMethod:'legacy-selected-v1',residentBytes:1024,admissionQueries:160}],nowMs);
 }
 const firstClaim=await claimAnalyticsPartitionWork(setupDb,{sourceId,limit:1,nowMs,stages:['cache']});
 expect(firstClaim).toHaveLength(1);
 const measured=async<T>(label:string,run:(target:D1Database,bounded:{remainingQueries:()=>number;now:()=>number;deadlineMs:number})=>Promise<T>)=>{
  const meter=createD1InvocationBudget(950),profile=createAnalyticsProfile();
  const target=meter.wrap(profileAnalyticsDatabase(db(),'target',profile,()=>label));
  const result=await run(target,{remainingQueries:()=>meter.remainingQueries,now:()=>nowMs,deadlineMs:nowMs+60_000});
  const costs=Object.values(profile.costs);
  expect(profile.measurementFailures).toBe(0);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  return {result,statements:meter.queriesUsed,rowsRead:costs.reduce((sum,cost)=>sum+cost.rowsRead,0),
   rowsWritten:costs.reduce((sum,cost)=>sum+cost.rowsWritten,0)};
 };
 // The lease identifies its work key, while the current work row identifies
 // its leaf. Keep the fair selector's order instead of forcing a chosen A.
 const selected=await db().prepare('SELECT partition_key FROM analytics_partition_work WHERE work_key=?')
  .bind(firstClaim[0]!.workKey).first<string>('partition_key');
 expect(selected).toBeTruthy();
 const a=selected===first.location.partitionKey?first:second!,b=selected===first.location.partitionKey?second!:first;
 expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:(await readCanonicalPartition(db(),a.location.partitionKey))!,
  lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(false);
 const prepared=await measured('prepare-A',(target,budget)=>materializeCanonicalCachePartition({target,partitionKey:a.location.partitionKey,
  budget,stillCurrent:current,lease:firstClaim[0]!,maxRepairs:8}));
 expect(prepared.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending',metrics:{slotsWritten:1}});
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(0);
 const prefix=a.occurrenceKey.slice(0,2);
 const slotPlan=(await db().prepare(`EXPLAIN QUERY PLAN SELECT slot_key,fact_revision,occurrence_key,root_partition_key
  FROM analytics_canonical_cache_slots INDEXED BY analytics_canonical_cache_slots_partition
  WHERE root_partition_key=? AND occurrence_key>=? AND occurrence_key<?
  ORDER BY occurrence_key LIMIT 17`).bind(a.location.partitionKey,prefix,prefix+'g').all<{detail:string}>()).results.map(row=>row.detail);
 const missingPlan=(await db().prepare(`EXPLAIN QUERY PLAN SELECT 1 missing FROM analytics_canonical_facts f INDEXED BY analytics_canonical_cache_fact_logical
  JOIN analytics_canonical_heads h ON h.revision=f.revision LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision
  WHERE f.selection_method=? AND f.erasure_key=? AND f.observed_day=? AND f.native_logical_occurrence_key=?
  AND s.slot_key IS NULL LIMIT 1`).bind('legacy-selected-v1',a.provenance.erasureKey,day,a.nativeScopes.logicalOccurrenceKey)
  .all<{detail:string}>()).results.map(row=>row.detail);
 expect(slotPlan.some(detail=>detail.includes('analytics_canonical_cache_slots_partition'))).toBe(true);
 expect(missingPlan.some(detail=>detail.includes('analytics_canonical_cache_fact_logical'))).toBe(true);
 const oldPath=await measured('old-retry-A',(target,budget)=>materializeCanonicalCachePartition({target,partitionKey:a.location.partitionKey,
  budget,stillCurrent:current,lease:firstClaim[0]!,maxRepairs:8}));
 expect(oldPath.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending',metrics:{slotsWritten:0}});
 const hinted=await measured('hint-retry-A',async(target,budget)=>{
  const partition=await readCanonicalPartition(target,a.location.partitionKey);expect(partition).not.toBeNull();
  return canonicalCachePreparedRepairBlocked({target,partition:partition!,lease:firstClaim[0]!,budget});
 });
 expect(hinted.result).toBe(true);expect(hinted.rowsWritten).toBe(0);
 expect(hinted.statements).toBeLessThan(oldPath.statements);
 expect(hinted.rowsRead).toBeLessThan(oldPath.rowsRead);
 const pinnedPartition=(await readCanonicalPartition(db(),a.location.partitionKey))!;
 expect(await canonicalCacheRepairPageBlocked({target:db(),budget:{remainingQueries:()=>950,now:()=>nowMs,
  deadlineMs:nowMs+60_000}})).toBe(true);
 expect(await recordCanonicalCachePreparedReceipt({target:db(),lease:firstClaim[0]!,partition:pinnedPartition,
  budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(true);
 expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=? AND
  ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(firstClaim[0]!.workKey).first<number>('ready')).toBeNull();
 expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:pinnedPartition,
  lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs+120_001,deadlineMs:nowMs+180_001}})).toBe(false);
 const trigger=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='analytics_canonical_cache_pair_admit'")
  .first<string>('sql');expect(trigger).toBeTruthy();
 await db().prepare('DROP TRIGGER analytics_canonical_cache_pair_admit').run();
 expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:pinnedPartition,
  lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(false);
 await db().prepare(trigger!).run();
 expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:pinnedPartition,
  lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(true);
 // A bounded result page must not silently become a broad scan after index loss.
 for(const index of ['analytics_canonical_cache_slots_partition','analytics_canonical_cache_fact_logical']){
  const indexSql=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
   .bind(index).first<string>('sql');expect(indexSql).toBeTruthy();
  await db().prepare('DROP INDEX '+index).run();
  expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:pinnedPartition,
   lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(false);
  expect(await canonicalCacheRepairPageBlocked({target:db(),budget:{remainingQueries:()=>950,now:()=>nowMs,
   deadlineMs:nowMs+60_000}})).toBe(false);
  await db().prepare(indexSql!).run();
  expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:pinnedPartition,
   lease:firstClaim[0]!,budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(true);
 }
 expect(await canonicalCachePreparedRepairBlocked({target:db(),partition:(await readCanonicalPartition(db(),a.location.partitionKey))!,
  lease:firstClaim[0]!,budget:{remainingQueries:()=>111,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(false);
 await recordAnalyticsPartitionWorkReason(db(),firstClaim[0]!,'cache_repairs_pending',nowMs);
 expect(await releaseAnalyticsPartitionWork(db(),firstClaim[0]!,'deferred',nowMs)).toBe(true);
 expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=? AND
  ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(firstClaim[0]!.workKey).first<number>('ready')).toBe(1);
 expect(await recordCanonicalCachePreparedReceipt({target:db(),lease:firstClaim[0]!,partition:pinnedPartition,
  budget:{remainingQueries:()=>950,now:()=>nowMs,deadlineMs:nowMs+60_000}})).toBe(false);
 expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=? AND
  ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(firstClaim[0]!.workKey).first<number>('ready')).toBe(1);
 const nextClaim=await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,stages:['cache']});
 expect(nextClaim).toHaveLength(1);
 expect((await db().prepare('SELECT partition_key FROM analytics_partition_work WHERE work_key=?')
  .bind(nextClaim[0]!.workKey).first<string>('partition_key'))).toBe(b.location.partitionKey);
 const completedB=await measured('prepare-B',(target,budget)=>materializeCanonicalCachePartition({target,partitionKey:b.location.partitionKey,
  budget,stillCurrent:current,lease:nextClaim[0]!,maxRepairs:8}));
 expect(completedB.result.state).toBe('complete');
 expect(await completeAnalyticsPartitionWork(db(),nextClaim[0]!,[],nowMs)).toBe(true);
 const resumed=await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,stages:['cache']});
 expect(resumed).toHaveLength(1);
 expect(resumed[0]!.workKey).toBe(firstClaim[0]!.workKey);
 const completedA=await measured('resume-A',(target,budget)=>materializeCanonicalCachePartition({target,partitionKey:a.location.partitionKey,
  budget,stillCurrent:current,lease:resumed[0]!,maxRepairs:8}));
 expect(completedA.result.state).toBe('complete');
 expect(await completeAnalyticsPartitionWork(db(),resumed[0]!,[],nowMs)).toBe(true);
 expect((await db().prepare('SELECT partition_key FROM analytics_canonical_cache_partitions').all()).results).toHaveLength(2);
 expect(await read(day,'legacy-selected-v1')).toEqual(await oracle([first,second!]));
 const summary=(sample:{result:unknown;statements:number;rowsRead:number;rowsWritten:number})=>({
  state:typeof sample.result==='object'&&sample.result!==null&&'state'in sample.result?sample.result.state:null,statements:sample.statements,
  rowsRead:sample.rowsRead,rowsWritten:sample.rowsWritten});
 console.info('cache prepared negative hint A/B',JSON.stringify({nativeSetup:{
  statements:Object.values(setup.costs).reduce((sum,cost)=>sum+cost.statements,0),
  rowsRead:Object.values(setup.costs).reduce((sum,cost)=>sum+cost.rowsRead,0),
  rowsWritten:Object.values(setup.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)},
  prepared:summary(prepared),oldPath:summary(oldPath),hinted:{...summary(hinted),blocked:hinted.result},
  completedB:summary(completedB),completedA:summary(completedA),
  plans:{slots:slotPlan,missing:missingPlan}}));
 // Optional scheduling metadata must leave the original cache product usable
 // if 0048 is absent or a same-name, unindexed partial table is present.
 await db().prepare('DROP TABLE analytics_canonical_cache_prepared_receipts').run();
 expect(await canonicalCacheAvailable(db())).toBe(true);
 expect(await canonicalCacheRepairPageBlocked({target:db(),budget:{remainingQueries:()=>950,now:()=>nowMs,
  deadlineMs:nowMs+60_000}})).toBe(false);
 await db().prepare(`CREATE TABLE analytics_canonical_cache_prepared_receipts(
  work_key TEXT,work_revision INTEGER,input_revision TEXT,partition_key TEXT,method TEXT,
  manifest_generation INTEGER,row_count INTEGER) STRICT`).run();
 expect(await canonicalCacheRepairPageBlocked({target:db(),budget:{remainingQueries:()=>950,now:()=>nowMs,
  deadlineMs:nowMs+60_000}})).toBe(false);
},120_000);

const ORIGINAL_CACHE_SUPERSEDED_DELETE_SQL=`DELETE FROM analytics_canonical_cache_partitions WHERE partition_key IN(
 SELECT c.partition_key FROM analytics_canonical_cache_partitions c JOIN analytics_canonical_manifests m USING(content_revision)
 WHERE m.generation!=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
 AND EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f USING(revision) WHERE r.content_revision=c.content_revision AND f.source_id=?)
 AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.partition_key=c.partition_key AND w.state='leased' AND w.claim_expires_ms>?)
 ORDER BY c.partition_key LIMIT ?) RETURNING partition_key`;
const SOURCE_FIRST_CACHE_SUPERSEDED_DELETE_SQL=`WITH source_revisions(content_revision) AS MATERIALIZED(
 SELECT DISTINCT r.content_revision FROM analytics_canonical_facts f INDEXED BY analytics_canonical_fact_subject
 JOIN analytics_canonical_manifest_rows r INDEXED BY analytics_canonical_manifest_fact ON r.revision=f.revision
 WHERE f.source_id=?
)
DELETE FROM analytics_canonical_cache_partitions WHERE partition_key IN(
 SELECT c.partition_key FROM source_revisions s
 JOIN analytics_canonical_cache_partitions c INDEXED BY analytics_canonical_cache_partition_revision USING(content_revision)
 JOIN analytics_canonical_manifests m USING(content_revision)
 WHERE m.generation!=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
 AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.partition_key=c.partition_key AND w.state='leased' AND w.claim_expires_ms>?)
 ORDER BY c.partition_key LIMIT ?) RETURNING partition_key`;

it('preserves exact cache-partition retirement across sources and measures a source-first no-op',async()=>{
 const otherSourceId='synthetic-cache-other',otherScope:CanonicalScope={...scope,sourceNamespace:otherSourceId,ownerDigest:'b'.repeat(64)};
 const setup=createAnalyticsProfile(),database=profileAnalyticsDatabase(db(),'target',setup,()=> 'setup');
 const setupStarted=performance.now(),nowMs=Date.parse(day+'T15:00:00Z');
 await database.prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
  .bind(otherSourceId,otherSourceId).run();
 await database.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
  .bind(otherSourceId,otherScope.ownerDigest).run();
 const owned:CanonicalFact[]=[],foreign:CanonicalFact[]=[],used=new Set<string>();
 for(let i=0;i<4096&&owned.length<16;i++){
  const value=await fact('retire-owned-'+i);if(used.has(value.location.partitionKey))continue;
  used.add(value.location.partitionKey);owned.push(value);
 }
 expect(owned).toHaveLength(16);
 // One manifest contains both sources. Its revision is relevant to either
 // source, while a distinct foreign-only stale manifest must not be retired.
 for(let i=0;i<4096;i++){
  const value=await fact('retire-shared-'+i,undefined,{},0,undefined,otherScope);
  if(value.location.partitionKey===owned[2]!.location.partitionKey){foreign.push(value);break;}
 }
 expect(foreign).toHaveLength(1);
 for(let i=0;i<4096&&foreign.length<17;i++){
  const value=await fact('retire-foreign-'+i,undefined,{},0,undefined,otherScope);
  if(used.has(value.location.partitionKey))continue;
  used.add(value.location.partitionKey);foreign.push(value);
 }
 expect(foreign).toHaveLength(17);
 for(const value of owned)await change(value,null,scope,sourceId,database);
 for(const value of foreign)await change(value,null,otherScope,otherSourceId,database);
 const partitionKeys=[...new Set([...owned,...foreign].map(value=>value.location.partitionKey))];
 const heads=(await database.prepare(`SELECT partition_key,content_revision FROM analytics_canonical_partition_heads
  WHERE partition_key IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(partitionKeys))
  .all<{partition_key:string;content_revision:string}>()).results;
 expect(heads).toHaveLength(partitionKeys.length);
 await database.batch(heads.map(row=>database.prepare(`INSERT INTO analytics_canonical_cache_partitions(partition_key,content_revision,method)
  VALUES(?,?,'cache-retention-v2')`).bind(row.partition_key,row.content_revision)));
 for(let offset=0;offset<384;offset+=32){
  const requests=await Promise.all(Array.from({length:32},async(_,index)=>{
   const n=offset+index;return {sourceId,ownerDigest:null,stage:'fits' as const,lane:'history' as const,
    partitionKey:'retirement-unrelated/'+n,headKey:await sha256Hex('retirement-head:'+n),inputRevision:'1'.repeat(64),
    policyRevision:'2'.repeat(64),day:null,stream:null,selectionMethod:null,residentBytes:0,admissionQueries:1};
  }));
  await admitAnalyticsPartitionWork(database,requests,nowMs);
 }
 const setupMs=performance.now()-setupStarted;
 const setupCost=Object.values(setup.costs).reduce((sum,cost)=>({statements:sum.statements+cost.statements,
  rowsRead:sum.rowsRead+cost.rowsRead,rowsWritten:sum.rowsWritten+cost.rowsWritten}),{statements:0,rowsRead:0,rowsWritten:0});
 const bind:[string,number,number]=[sourceId,nowMs,16];
 const originalPlan=(await db().prepare('EXPLAIN QUERY PLAN '+ORIGINAL_CACHE_SUPERSEDED_DELETE_SQL).bind(...bind)
  .all<{detail:string}>()).results.map(row=>row.detail);
 const proposedPlan=(await db().prepare('EXPLAIN QUERY PLAN '+SOURCE_FIRST_CACHE_SUPERSEDED_DELETE_SQL).bind(...bind)
  .all<{detail:string}>()).results.map(row=>row.detail);
 const lazyPlan=(await db().prepare('EXPLAIN QUERY PLAN '+CANONICAL_CACHE_SUPERSEDED_DELETE_SQL).bind(...bind)
  .all<{detail:string}>()).results.map(row=>row.detail);
 expect(proposedPlan.some(detail=>detail.includes('analytics_canonical_fact_subject'))).toBe(true);
 expect(proposedPlan.some(detail=>detail.includes('analytics_canonical_manifest_fact'))).toBe(true);
 expect(proposedPlan.some(detail=>detail.includes('analytics_canonical_cache_partition_revision'))).toBe(true);
 const observations:{case:string;limit:number;originalRowsRead:number;sourceFirstRowsRead:number;lazyRowsRead:number;deleted:number}[]=[];
 const compare=async(label:string,limit:number)=>{
  const before=(await db().prepare('SELECT partition_key,content_revision,method FROM analytics_canonical_cache_partitions')
   .all<{partition_key:string;content_revision:string;method:string}>()).results;
  const args:[string,number,number]=[sourceId,nowMs,limit];
  const original=await db().prepare(ORIGINAL_CACHE_SUPERSEDED_DELETE_SQL).bind(...args).all<{partition_key:string}>();
  const expected=original.results.map(row=>row.partition_key).sort();
  for(const key of expected){const row=before.find(value=>value.partition_key===key)!;
   await db().prepare('INSERT INTO analytics_canonical_cache_partitions(partition_key,content_revision,method) VALUES(?,?,?)')
    .bind(row.partition_key,row.content_revision,row.method).run();}
  const runVariant=async(sql:string)=>{
   const result=await db().prepare(sql).bind(...args).all<{partition_key:string}>();
   expect(result.results.map(row=>row.partition_key).sort()).toEqual(expected);
   expect((await db().prepare('SELECT partition_key FROM analytics_canonical_cache_partitions ORDER BY partition_key').all<{partition_key:string}>())
    .results.map(row=>row.partition_key)).toEqual(before.map(row=>row.partition_key).filter(key=>!expected.includes(key)).sort());
   for(const key of expected){const row=before.find(value=>value.partition_key===key)!;
    await db().prepare('INSERT INTO analytics_canonical_cache_partitions(partition_key,content_revision,method) VALUES(?,?,?)')
     .bind(row.partition_key,row.content_revision,row.method).run();}
   return result.meta.rows_read;
  };
  const sourceFirstRowsRead=await runVariant(SOURCE_FIRST_CACHE_SUPERSEDED_DELETE_SQL);
  const lazyRowsRead=await runVariant(CANONICAL_CACHE_SUPERSEDED_DELETE_SQL);
  observations.push({case:label,limit,originalRowsRead:original.meta.rows_read,sourceFirstRowsRead,lazyRowsRead,deleted:expected.length});
  return expected;
 };
 expect(await compare('current-no-op',16)).toEqual([]);
 // The first stale partition is protected by a different source's live work.
 // A second loses its dirty marker (current generation zero); the shared third
 // and a foreign-only fourth also become stale.
 await database.prepare(`UPDATE analytics_canonical_dirty_partitions SET generation=generation+1
  WHERE partition_key IN(SELECT value FROM json_each(?))`).bind(JSON.stringify([
   owned[0]!.location.partitionKey,owned[2]!.location.partitionKey,foreign[1]!.location.partitionKey])).run();
 const absentKey=owned[1]!.location.partitionKey;
 await database.prepare('UPDATE analytics_canonical_dirty_partitions SET generation=generation+1 WHERE partition_key=?').bind(absentKey).run();
 await materializeCanonicalPartition(database,absentKey);
 const fresh=await database.prepare('SELECT content_revision FROM analytics_canonical_partition_heads WHERE partition_key=?')
  .bind(absentKey).first<string>('content_revision');
 expect(fresh).toBeTruthy();
 await database.prepare('UPDATE analytics_canonical_cache_partitions SET content_revision=? WHERE partition_key=?').bind(fresh,absentKey).run();
 await database.prepare('DELETE FROM analytics_canonical_dirty_partitions WHERE partition_key=?').bind(absentKey).run();
 await admitAnalyticsPartitionWork(database,[{sourceId:otherSourceId,ownerDigest:null,stage:'fits',lane:'new',
  partitionKey:owned[0]!.location.partitionKey,headKey:await sha256Hex('retirement-foreign-lease'),
  inputRevision:'3'.repeat(64),policyRevision:'4'.repeat(64),day,stream:'usage',selectionMethod:scope.selectionMethod,
  residentBytes:0,admissionQueries:1}],nowMs);
 expect(await claimAnalyticsPartitionWork(database,{sourceId:otherSourceId,limit:1,nowMs,stages:['fits']})).toHaveLength(1);
 const selected=await compare('stale-with-cross-source-lease',16);
 expect(selected).toEqual([owned[1]!.location.partitionKey,owned[2]!.location.partitionKey].sort());
 expect(await compare('ordered-limit',1)).toEqual(selected.slice(0,1));
 const actual=await retireCanonicalCachePage(db(),sourceId,16,nowMs);
 expect(actual).toMatchObject({state:'complete',partitionsRetired:2});
 expect((await db().prepare('SELECT partition_key FROM analytics_canonical_cache_partitions ORDER BY partition_key')
  .all<{partition_key:string}>()).results.map(row=>row.partition_key)).not.toContain(owned[1]!.location.partitionKey);
 expect(observations.every(value=>value.lazyRowsRead*2<value.originalRowsRead)).toBe(true);
 console.log('canonical cache superseded cleanup comparison',JSON.stringify({setup:{...setupCost,elapsedMs:setupMs,partitions:partitionKeys.length,unrelatedReady:384},
  observations,queryPlan:{original:originalPlan,sourceFirst:proposedPlan,lazy:lazyPlan}}));
},120_000);
// P6 component boundary: these controls enter through the reviewed normalized
// canonical writer. Source-backed ingestion/lease qualification remains in the
// accepted-source cache integration/group and actual role skew files.
describe('exact cache subject repair pages',()=>{
 type Sample={statements:number;rowsRead:number;rowsWritten:number;failedStatements:number;
  pages:{family:'logical'|'pair';rowsRead:number|null;rowsWritten:number|null}[]};
 async function measured<T>(run:(target:D1Database,bounded:typeof budget)=>Promise<T>):Promise<{result:T;cost:Sample}> {
  const meter=createD1InvocationBudget(950),profile=createAnalyticsProfile(),pages:Sample['pages']=[];
  const target=meter.wrap(profileAnalyticsDatabase(db(),'target',profile,()=> 'subject-component',observation=>{
   if(observation.sql.startsWith('SELECT * FROM analytics_canonical_cache_logical_work\n  INDEXED BY analytics_canonical_cache_logical_page'))
    pages.push({family:'logical',rowsRead:observation.rowsRead,rowsWritten:observation.rowsWritten});
   if(observation.sql.startsWith('SELECT * FROM analytics_canonical_cache_pair_work\n  INDEXED BY analytics_canonical_cache_pair_page'))
    pages.push({family:'pair',rowsRead:observation.rowsRead,rowsWritten:observation.rowsWritten});
  }));
  const result=await run(target,{remainingQueries:()=>meter.remainingQueries,now:()=>0,deadlineMs:60_000});
  const costs=Object.values(profile.costs);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(profile.measurementFailures).toBe(0);
  return {result,cost:{statements:meter.queriesUsed,rowsRead:costs.reduce((n,c)=>n+c.rowsRead,0),
   rowsWritten:costs.reduce((n,c)=>n+c.rowsWritten,0),failedStatements:costs.reduce((n,c)=>n+c.failedStatements,0),pages}};
 }
 it('retains the native split-leaf prepared skip and falls back on a lost day index',async({task})=>{
  // Pigeonhole bound: after 256*128+1 distinct occurrence hashes, some
  // two-hex root has 129 rows. Only the accepted canonical writer may create
  // the split manifest; no test SQL fabricates headers or slots.
  const buckets=new Map<string,string[]>();let ids:string[]|undefined;
  for(let n=0;n<=256*MAX_CANONICAL_PARTITION_ROWS;n++){
   const id='prefix-split-'+n,eventId='event:v2:'+await sha256Hex(id),key=await canonicalOccurrenceKey(scope,'usage',eventId);
   const group=buckets.get(key.slice(0,2))??[];group.push(id);buckets.set(key.slice(0,2),group);
   if(group.length===MAX_CANONICAL_PARTITION_ROWS+1){ids=group;break;}
  }
  expect(ids).toHaveLength(MAX_CANONICAL_PARTITION_ROWS+1);
  const facts:CanonicalFact[]=[];
  for(const [rank,id] of ids!.entries())facts.push(await fact(id,day+'T12:00:00Z',{},rank));
  const root=facts[0]!.location.partitionKey;
  expect(new Set(facts.map(value=>value.location.partitionKey))).toEqual(new Set([root]));
  for(let offset=0;offset<facts.length;offset+=16){
   const page=facts.slice(offset,offset+16),ordinal=offset/16;
   await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,
    pageKey:await sha256Hex('prefix-split-page:'+ordinal),sourceRevision:await sha256Hex('prefix-split-source:'+ordinal),
    stillCurrent:current,load:async()=>page.map(value=>({occurrenceKey:value.occurrenceKey,stream:'usage' as const,
     expectedRevision:null,fact:value}))});
  }
  const rootResult=await materializeCanonicalPartition(db(),root);
  expect(rootResult.state).toBe('split');
  if(rootResult.state!=='split')throw new Error('native split missing');
  let leaf:Awaited<ReturnType<typeof readCanonicalPartition>>=null;
  for(const key of rootResult.partitions){
   const part=await materializeCanonicalPartition(db(),key);
   if(part.state==='complete'&&part.manifest.rowCount>=1&&part.manifest.rowCount<=8&&!leaf)
    leaf=await readCanonicalPartition(db(),key);
  }
  expect(leaf).not.toBeNull();expect(leaf!.manifest.partitionKey).not.toBe(root);
  const nowMs=1000;
  await admitAnalyticsPartitionWork(db(),[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',
   partitionKey:leaf!.manifest.partitionKey,headKey:await sha256Hex('prefix-split-leaf-head'),
   inputRevision:leaf!.manifest.contentRevision,policyRevision:'c'.repeat(64),day,stream:'usage',
   selectionMethod:scope.selectionMethod,residentBytes:4096,admissionQueries:160}],nowMs);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,stages:['cache']}))[0]!;
  expect(lease).toBeDefined();
  const staged=await measured((target,bounded)=>materializeCanonicalCachePartition({target,
   partitionKey:leaf!.manifest.partitionKey,budget:bounded,stillCurrent:current,maxRepairs:16}));
  expect(staged.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  expect(await recordCanonicalCachePreparedReceipt({target:db(),lease,partition:leaf!,budget})).toBe(true);
  await recordAnalyticsPartitionWorkReason(db(),lease,'cache_repairs_pending',nowMs);
  expect(await releaseAnalyticsPartitionWork(db(),lease,'deferred',nowMs)).toBe(true);
  expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=?
   AND ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(lease.workKey).first<number>('ready')).toBe(1);
  const plan=(await db().prepare(`EXPLAIN QUERY PLAN SELECT w.work_key FROM analytics_partition_work w
   WHERE w.work_key=? AND ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(lease.workKey)
   .all<{detail:string}>()).results.map(row=>row.detail);
  expect(plan.some(detail=>detail.includes('analytics_canonical_cache_logical_subject')&&detail.includes('SEARCH'))).toBe(true);
  expect(plan.some(detail=>detail.includes('analytics_canonical_cache_pair_work_subject')&&detail.includes('SEARCH'))).toBe(true);
  expect(plan.some(detail=>detail.includes('USE TEMP B-TREE'))).toBe(false);
  for(const index of ['analytics_canonical_cache_logical_subject','analytics_canonical_cache_pair_work_subject']){
   const ddl=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").bind(index).first<string>('sql');
   expect(ddl).toBeTruthy();await db().prepare('DROP INDEX '+index).run();
   expect(await canonicalCacheRepairPageBlocked({target:db(),budget})).toBe(false);
   await db().prepare(ddl!).run();
  }
  const ddl=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='analytics_canonical_cache_logical_subject'")
   .first<string>('sql');expect(ddl).toBeTruthy();
  await db().prepare('DROP INDEX analytics_canonical_cache_logical_subject').run();
  expect(await canonicalCacheRepairPageBlocked({target:db(),budget})).toBe(false);
  // The fresh negative probe is false, so the ordinary claim does not use a
  // stale prepared-skip predicate after physical index loss.
  const ordinary=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+5001,
   stages:['cache'],cacheRepairBlocked:false}))[0]!;
  expect(ordinary?.workKey).toBe(lease.workKey);
  await db().prepare(ddl!).run();
  Object.assign(task.meta,{nativeSplitCacheProof:{rootRows:facts.length,leafRows:leaf!.manifest.rowCount,
   staged:staged.cost,claimPlan:plan.filter(detail=>detail.includes('analytics_canonical_cache_')),
   boundary:'actual canonical writer split; setup/EXPLAIN/index migration costs excluded from stage measurement'}});
 },120_000);
 it('closes only a proved leased older UTC-day leaf while later same-owner repairs remain queued',async({task})=>{
  const older='2026-09-19',earlier=await fact('prefix-earlier',older+'T23:59:00Z'),later:CanonicalFact[]=[];
  await change(earlier);
  for(let n=0;n<12;n++){
   const value=await fact('prefix-future-'+n,new Date(Date.parse(day+'T00:01:00Z')+n*86400000).toISOString());
   later.push(value);await change(value);
  }
  const partition=(await readCanonicalPartition(db(),earlier.location.partitionKey))!;
  const nowMs=1000;
  await admitAnalyticsPartitionWork(db(),[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',
   partitionKey:earlier.location.partitionKey,headKey:await sha256Hex('prefix-earlier-head'),
   inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day:older,stream:'usage',
   selectionMethod:scope.selectionMethod,residentBytes:4096,admissionQueries:160}],nowMs);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,stages:['cache']}))[0]!;
  expect(lease).toBeDefined();
  const actual=await measured((target,bounded)=>materializeCanonicalCachePartition({target,partitionKey:earlier.location.partitionKey,
   budget:bounded,stillCurrent:current,lease,maxRepairs:8}));
  expect(actual.result.state).toBe('complete');
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_logical_work WHERE source_id=? AND owner_digest=? AND day>?')
   .bind(sourceId,scope.ownerDigest,older).first<number>('n')).toBeGreaterThan(0);
  expect(await db().prepare('SELECT 1 FROM analytics_canonical_cache_logical_work WHERE source_id=? AND owner_digest=? AND day<=? LIMIT 1')
   .bind(sourceId,scope.ownerDigest,older).first()).toBeNull();
  expect(await read(older)).toEqual(await oracle([earlier,...later],older));
  const publicResult=await readCanonicalCacheSeriesResult({target:db(),scopes:[cacheScope],
   nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current});
  expect(publicResult).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  const dayPlans:string[][]=[];
  for(const [table,index] of [['analytics_canonical_cache_logical_work','analytics_canonical_cache_logical_subject'],
   ['analytics_canonical_cache_pair_work','analytics_canonical_cache_pair_work_subject']] as const){
   const plan=(await db().prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY ${index}
    WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=? ORDER BY day LIMIT 8`)
    .bind(sourceId,scope.ownerDigest,scope.selectionMethod,older).all<{detail:string}>()).results;
   expect(plan.some(row=>row.detail.includes('SEARCH')&&row.detail.includes(index))).toBe(true);
   expect(plan.some(row=>row.detail.includes('USE TEMP B-TREE'))).toBe(false);
   dayPlans.push(plan.map(row=>row.detail));
  }
  Object.assign(task.meta,{cachePrefixComponent:{setupFacts:later.length+1,leaf:actual.cost,dayPlans,
   boundary:'synthetic normalized canonical writer; genuine source-seal and role scheduling remain separate'}});
 },60_000);
 it('keeps a prepared older leaf claimable when only later same-owner work is blocked',async()=>{
  const older='2026-09-19',first=await fact('prefix-receipt-earlier',older+'T23:59:00Z');await change(first);
  for(let n=0;n<9;n++)await change(await fact('prefix-receipt-future-'+n,
   new Date(Date.parse(day+'T00:01:00Z')+n*86400000).toISOString()));
  const partition=(await readCanonicalPartition(db(),first.location.partitionKey))!,nowMs=1000;
  await admitAnalyticsPartitionWork(db(),[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',
   partitionKey:first.location.partitionKey,headKey:await sha256Hex('prefix-receipt-head'),
   inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day:older,stream:'usage',
   selectionMethod:scope.selectionMethod,residentBytes:4096,admissionQueries:160}],nowMs);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,stages:['cache']}))[0]!;
  expect(lease).toBeDefined();
  // Simulate a pre-upgrade lease's original all-subject materialization. It
  // stages the exact slot and receipt, but does not finish behind future work.
  expect(await materializeCanonicalCachePartition({target:db(),partitionKey:first.location.partitionKey,
   budget,stillCurrent:current,maxRepairs:8})).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  expect(await recordCanonicalCachePreparedReceipt({target:db(),lease,partition,budget})).toBe(true);
  await recordAnalyticsPartitionWorkReason(db(),lease,'cache_repairs_pending',nowMs);
  expect(await releaseAnalyticsPartitionWork(db(),lease,'deferred',nowMs)).toBe(true);
  expect(await db().prepare(`SELECT 1 ready FROM analytics_partition_work w WHERE w.work_key=?
   AND ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(lease.workKey).first<number>('ready')).toBeNull();
  const resumed=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs:nowMs+5001,stages:['cache'],cacheRepairBlocked:true}))[0]!;
  expect(resumed?.workKey).toBe(lease.workKey);
  expect(await materializeCanonicalCachePartition({target:db(),partitionKey:first.location.partitionKey,
   budget,stillCurrent:current,lease:resumed,maxRepairs:8})).toMatchObject({state:'complete'});
 });
 it('repairs an exact subject across days without awaiting an unrelated blocked owner',async({task})=>{
  const setup:Sample[]=[];
  const p=await fact('subject-p','2026-09-19T23:59:00Z'),n=await fact('subject-n',day+'T00:01:00Z'),
   x=await fact('subject-x','2026-09-19T23:59:30Z');
  const otherScope={...scope,ownerDigest:'b'.repeat(64)},otherCacheScope={...cacheScope,ownerDigest:otherScope.ownerDigest};
  setup.push((await measured(target=>target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
   .bind(sourceId,otherScope.ownerDigest).run())).cost);
  const excluded=new Set([p,n,x].map(f=>f.location.partitionKey)),foreign:CanonicalFact[]=[];
  for(let index=0;index<128&&foreign.length<12;index++){
   const candidate=await fact('subject-other-'+index,undefined,{},0,undefined,otherScope);
   if(excluded.has(candidate.location.partitionKey))continue;foreign.push(candidate);
  }
  expect(foreign).toHaveLength(12);
  for(const value of [p,n,...foreign])setup.push((await measured(target=>change(value,null,
   value.provenance.erasureKey===p.provenance.erasureKey?scope:otherScope,sourceId,target))).cost);
  const foreignWork=()=>db().prepare('SELECT * FROM analytics_canonical_cache_logical_work WHERE source_id=? AND owner_digest=? ORDER BY logical_key')
   .bind(sourceId,otherScope.ownerDigest).all();
  const before=(await foreignWork()).results;expect(before).toHaveLength(12);
  const first=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:p.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(first.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  const second=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:n.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(second.result.state).toBe('complete');
  const resumed=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:p.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(resumed.result.state).toBe('complete');
  expect(await read()).toEqual(await oracle([p,n]));
  setup.push((await measured(target=>change(x,null,scope,sourceId,target))).cost);
  const inserted=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:x.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(inserted.result).toMatchObject({state:'complete',metrics:{logicalRepairs:1,pairRepairs:2}});
  expect(await read()).toEqual(await oracle([p,x,n]));
  expect(await read('2026-09-19')).toEqual(await oracle([p,x,n],'2026-09-19'));
  const pairs=(await db().prepare('SELECT prior_key,later_key FROM analytics_canonical_cache_pairs ORDER BY later_key').all<{prior_key:string;later_key:string}>()).results;
  expect(pairs).toHaveLength(2);
  expect(new Set(pairs.map(pair=>pair.prior_key))).toEqual(new Set([p,x].map(f=>[f.provenance.selectionMethod,f.provenance.erasureKey,f.location.day,f.nativeScopes.logicalOccurrenceKey].join('/'))));
  expect((await foreignWork()).results).toEqual(before);
  const global=await measured((target,budget)=>repairCanonicalCacheNeighbors({target,budget,stillCurrent:current,maxRepairs:8}));
  expect(global.result).toBe(false);expect((await foreignWork()).results).toEqual(before);
  const reader=await measured(target=>readCanonicalCacheSeriesResult({target,scopes:[cacheScope,otherCacheScope],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current}));
  expect(reader.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  const withdrawn=await measured(target=>change(null,x,scope,sourceId,target));
  const inverse=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:p.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(inverse.result.state).toBe('complete');expect(await read()).toEqual(await oracle([p,n]));
  expect((await foreignWork()).results).toEqual(before);
  Object.assign(task.meta,{cacheSubjectReceipt:{boundary:'Normalized native P1 writer component; common reset/migration laboratory setup separate; no accepted-source pipeline claim.',
   setup,first:first.cost,second:second.cost,resumed:resumed.cost,inserted:inserted.cost,global:global.cost,reader:reader.cost,
   withdrawn:withdrawn.cost,inverse:inverse.cost,foreignPending:12,subjectsPooled:false,cpuMs:null,observedPeakHeapBytes:null}});
 },60_000);
 it('uses bounded indexed all-day subject pages and refuses a missing ordering index before staging',async({task})=>{
  const setup:Sample[]=[],facts:CanonicalFact[]=[];
  for(let index=0;index<32;index++){
   const value=await fact('subject-density-'+index,new Date(Date.parse(day+'T12:00:00Z')+index*86400000).toISOString());
   facts.push(value);setup.push((await measured(target=>change(value,null,scope,sourceId,target))).cost);
  }
  const selected=facts[0]!,plans=[];
  for(const [table,index,key] of [['analytics_canonical_cache_logical_work','analytics_canonical_cache_logical_page','logical_key'],
   ['analytics_canonical_cache_pair_work','analytics_canonical_cache_pair_page','node_key']] as const){
   const sample=await measured(async target=>(await target.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY ${index}
    WHERE source_id=? AND owner_digest=? AND selection_method=? ORDER BY ${key} LIMIT ?`)
    .bind(sourceId,scope.ownerDigest,scope.selectionMethod,8).all<{detail:string}>()).results.map(row=>row.detail));
   expect(sample.result.some(detail=>detail.includes('SEARCH')&&detail.includes(index))).toBe(true);
   expect(sample.result.some(detail=>detail.includes('TEMP B-TREE')||detail.startsWith('SCAN'))).toBe(false);
   plans.push({index,detail:sample.result,cost:sample.cost});
   const ddl=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").bind(index).first<string>('sql');expect(ddl).toBeTruthy();
   await db().prepare('DROP INDEX '+index).run();
   const refused=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:selected.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
   expect(refused.result).toMatchObject({state:'refused',reason:'migration_required',metrics:{slotsWritten:0}});
   expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_slots').first<number>('n')).toBe(0);
   expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(0);
   // Same name on the right table with the former day-first order is a
   // partial capability too: it would sort every retained day before LIMIT8.
   await db().prepare(`CREATE INDEX ${index} ON ${table}(source_id,owner_digest,selection_method,day,${key})`).run();
   const wrongShape=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:selected.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
   expect(wrongShape.result).toMatchObject({state:'refused',reason:'migration_required',metrics:{slotsWritten:0}});
   expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_slots').first<number>('n')).toBe(0);
   await db().prepare('DROP INDEX '+index).run();await db().prepare(ddl!).run();
  }
  const prepared=await measured((target,budget)=>materializeCanonicalCachePartition({target,partitionKey:selected.location.partitionKey,budget,stillCurrent:current,maxRepairs:8}));
  expect(prepared.result).toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  expect(prepared.cost.pages.map(page=>page.family)).toEqual(['logical','pair']);
  for(const page of prepared.cost.pages){expect(page.rowsRead).not.toBeNull();expect(page.rowsRead!).toBeLessThanOrEqual(16);}
  Object.assign(task.meta,{cacheSubjectReceipt:{setup,prepared:prepared.cost,plans,subjectPendingInput:32,pageLimit:8,
   contract:'Charged reads of the two native indexed page selections only; full component SQL separately reported. CPU/isolateheap unknown.'}});
 },60_000);
 it('falls back from prepared subject hints for same-name partial and malformed indexes',async()=>{
  const value=await fact('subject-index-hint');await change(value);
  expect((await materializeCanonicalCachePartition({target:db(),partitionKey:value.location.partitionKey,budget,stillCurrent:current})).state).toBe('complete');
  const partition=(await readCanonicalPartition(db(),value.location.partitionKey))!,nowMs=20;
  await admitAnalyticsPartitionWork(db(),[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',partitionKey:value.location.partitionKey,
   headKey:await sha256Hex('subject-index-hint-head'),inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),
   day:value.location.day,stream:'usage',selectionMethod:scope.selectionMethod,residentBytes:4096,admissionQueries:160}],nowMs);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,leaseMs:1000,stages:['cache']}))[0]!;
  expect(lease).toBeDefined();
  const before=(await db().prepare('SELECT * FROM analytics_canonical_cache_slots ORDER BY slot_key').all()).results;
  const probe=async()=>{
   const meter=createD1InvocationBudget(950),profile=createAnalyticsProfile();let indexedProbes=0;
   const target=meter.wrap(profileAnalyticsDatabase(db(),'target',profile,()=> 'subject-hint-index',observation=>{
    if(/INDEXED BY analytics_canonical_cache_(logical_page|pair_page)/u.test(observation.sql))indexedProbes++;
   }));
   const result=await canonicalCachePreparedRepairBlocked({target,partition,lease,
    budget:{remainingQueries:()=>meter.remainingQueries,now:()=>nowMs,deadlineMs:nowMs+60_000}});
   expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(profile.measurementFailures).toBe(0);
   expect(Object.values(profile.costs).reduce((n,c)=>n+c.rowsWritten,0)).toBe(0);
   return {result,indexedProbes};
  };
  expect(await probe()).toEqual({result:false,indexedProbes:2});
  for(const [index,table,key] of [['analytics_canonical_cache_logical_page','analytics_canonical_cache_logical_work','logical_key'],
   ['analytics_canonical_cache_pair_page','analytics_canonical_cache_pair_work','node_key']] as const){
   const ddl=await db().prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").bind(index).first<string>('sql');expect(ddl).toBeTruthy();
   for(const kind of ['partial','malformed'] as const){
    await db().prepare('DROP INDEX '+index).run();
    await db().prepare(kind==='partial'
     ?`CREATE INDEX ${index} ON ${table}(source_id,owner_digest,selection_method,${key}) WHERE day='1900-01-01'`
     :`CREATE INDEX ${index} ON ${table}(source_id,owner_digest,selection_method,day)`).run();
    // A forced partial-index read formerly raised "no query solution". The
    // exact fresh shape proof must now refuse before either indexed probe.
    expect(await probe()).toEqual({result:false,indexedProbes:0});
    expect((await db().prepare('SELECT * FROM analytics_canonical_cache_slots ORDER BY slot_key').all()).results).toEqual(before);
    await db().prepare('DROP INDEX '+index).run();await db().prepare(ddl!).run();
    expect(await probe()).toEqual({result:false,indexedProbes:2});
   }
  }
 },60_000);
 it.each(['source','expired_lease','erasure'] as const)('refuses exact subject completion after native %s change',async(kind)=>{
  const value=await fact('subject-guard-'+kind);await change(value);
  const partition=(await readCanonicalPartition(db(),value.location.partitionKey))!;expect(partition).not.toBeNull();
  let nowMs=20;
  await admitAnalyticsPartitionWork(db(),[{sourceId,ownerDigest:scope.ownerDigest,stage:'cache',lane:'new',partitionKey:value.location.partitionKey,
   headKey:await sha256Hex('subject-guard-head:'+kind),inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),
   day:value.location.day,stream:'usage',selectionMethod:scope.selectionMethod,residentBytes:4096,admissionQueries:160}],nowMs);
  const lease=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,leaseMs:1000,stages:['cache']}))[0]!;
  expect(lease).toBeDefined();let checks=0,commitChecks=0;
  const sample=await measured(async(target,bounded)=>{
   const stillCurrent=async()=>{
    if(kind==='source'&&++checks===2)await target.prepare('UPDATE analytics_owner_state SET revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?')
     .bind(sourceId,scope.ownerDigest).run();
    return await target.prepare("SELECT 1 current FROM analytics_owner_state WHERE source_id=? AND owner_digest=? AND revision=1 AND authority_epoch=1 AND state='active'")
     .bind(sourceId,scope.ownerDigest).first<number>('current')===1;
   };
   const canCommit=async()=>{
    if(++commitChecks===2){
     if(kind==='expired_lease')nowMs=lease.expiresAtMs+1;
     if(kind==='erasure')await target.prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,
      terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,2,2,2)`).bind(sourceId,scope.ownerDigest,'e'.repeat(64)).run();
    }
    return true; // Deliberately stale cheap proof: native CAS/lease/FKs must still refuse.
   };
   return materializeCanonicalCachePartition({target,partitionKey:value.location.partitionKey,
    budget:{...bounded,now:()=>nowMs,deadlineMs:60_000},stillCurrent,canCommit,lease,maxRepairs:8});
  });
  expect(sample.result).toMatchObject({state:'deferred',reason:kind==='source'?'source_changed':'canonical_changed'});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(0);
  if(kind!=='source')expect(await completeAnalyticsPartitionWork(db(),lease,[],nowMs)).toBe(false);
  else {
   // This low-level producer never owns scheduling completion after refusal.
   // Its original live lease is retained; source-backed callers perform the
   // normal deferred release, rather than invoking target-only completion.
   expect(await db().prepare('SELECT state,revision,claim_token FROM analytics_partition_work WHERE work_key=?')
    .bind(lease.workKey).first()).toEqual({state:'leased',revision:lease.revision,claim_token:lease.claimToken});
  }
  if(kind==='erasure'){
   for(const table of CANONICAL_CACHE_TABLES.filter(table=>!table.endsWith('_clock')))
    expect(await db().prepare('SELECT count(*) n FROM '+table).first<number>('n'),table).toBe(0);
   expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }
  if(kind==='expired_lease'){
   const renewed=(await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs,leaseMs:1000,stages:['cache']}))[0]!;
   expect(renewed.workKey).toBe(lease.workKey);expect(renewed.revision).toBe(lease.revision+1);expect(renewed.claimToken).not.toBe(lease.claimToken);
   const recovered=await measured((target,bounded)=>materializeCanonicalCachePartition({target,partitionKey:value.location.partitionKey,
    budget:{...bounded,now:()=>nowMs},stillCurrent:current,lease:renewed,maxRepairs:8}));
   expect(recovered.result.state).toBe('complete');expect(await completeAnalyticsPartitionWork(db(),renewed,[],nowMs)).toBe(true);
  }
 },60_000);
});

describe('maintained native cache neighbors and counters',()=>{
 it('maps native readable, sparse, skipped and unreadable records and preserves tie rank',async()=>{
  const records=[{}, {components:{inputCacheReadTokens:null,inputUncachedTokens:10,inputCacheWriteTokens:0}},
   {components:{inputCacheReadTokens:0,inputUncachedTokens:0,inputCacheWriteTokens:0}}, {modelId:null}];
  for(const [rank,overrides]of records.entries()) {
   const value=await fact('mapper'+rank,undefined,overrides,rank),prepared=await canonicalCacheItems([value]);
   const record={...v11UsageRecord(day),...overrides};
   const item=cacheRetentionEventFromRecordValue({sessionDigest:await cacheRetentionSessionDigest({ownerDigest:scope.ownerDigest,
    provider:record.provider,sessionUuid:record.sessionUuid}),observedAtMs:value.location.observedAtMs!,
    orderKey:prepared.items[0]?.orderKey??'unused'},record);
   expect(prepared.items).toEqual(item?[item]:[]);expect(prepared.eventsRead).toBe(1);
  }
  const a=await fact('tie1',undefined,{},1),b=await fact('tie0',undefined,{},0);
  const pair=canonicalCachePair(...(await canonicalCacheItems([a,b])).items as [CacheRetentionItem,CacheRetentionItem]);
  expect(pair?.counters).toMatchObject({adjacencies:1,unorderedTies:1});
 });
 it('repairs P→N to P→X/X→N and inverses, with unchanged replay writes and no source decode',async()=>{
  const p=await fact('p'),n=await fact('n',day+'T12:04:00Z'),x=await fact('x',day+'T12:01:00Z');
  await sync([...(await change(p)),...(await change(n))]);expect(await read()).toEqual(await oracle([p,n]));
  await sync(await change(x));expect(await read()).toEqual(await oracle([p,x,n]));
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_pairs').first<number>('n')).toBe(2);
  await sync(await change(null,x));expect(await read()).toEqual(await oracle([p,n]));
  const before=(await db().prepare('SELECT * FROM analytics_canonical_cache_pairs').all()).results;
  const profile=createAnalyticsProfile();const warm=await materializeCanonicalCachePartition({target:profileAnalyticsDatabase(db(),'target',profile,()=> 'warm'),
   partitionKey:p.location.partitionKey,budget,stillCurrent:current});
  expect(warm).toMatchObject({state:'complete',metrics:{slotsWritten:0,logicalRepairs:0,pairRepairs:0,pairEvaluations:0,sourceRecordDecodes:0}});
  expect((await db().prepare('SELECT * FROM analytics_canonical_cache_pairs').all()).results).toEqual(before);
  console.log('canonical cache warm profile',JSON.stringify(profile));
 });
 it('repairs timestamp/midnight/session moves, break insertion/deletion, configuration and sparse corrections',async()=>{
  const p=await fact('p','2026-09-19T23:59:00Z'),n=await fact('n',day+'T00:01:00Z');
  await sync([...(await change(p)),...(await change(n))]);expect(await read()).toEqual(await oracle([p,n]));
  let x=await fact('x',day+'T00:00:00Z',{modelId:null});await sync(await change(x));expect(await read()).toEqual(await oracle([p,x,n]));
  let updated=await fact('x',day+'T00:00:00Z',{speedMode:'fast'});await sync(await change(updated,x));x=updated;
  expect(await read()).toEqual(await oracle([p,x,n]));
  updated=await fact('x','2026-09-19T23:58:00Z',{sessionUuid:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0c'});
  await sync(await change(updated,x));x=updated;expect(await read()).toEqual(await oracle([p,x,n]));
  expect(await read('2026-09-19')).toEqual(await oracle([p,x,n],'2026-09-19'));
  updated=await fact('n',day+'T00:01:00Z',{components:{inputCacheReadTokens:null,inputUncachedTokens:1000,inputCacheWriteTokens:0}});
  await sync(await change(updated,n));expect(await read()).toEqual(await oracle([p,x,updated]));
  await sync(await change(null,x));expect(await read()).toEqual(await oracle([p,updated]));
 });
 it('keeps the inclusive seven-day gap, contraction and exact session membership across bands and days',async()=>{
  const p=await fact('p','2026-09-13T12:00:00Z'),n=await fact('n'),x=await fact('x',day+'T12:00:10Z'),y=await fact('y',day+'T12:03:10Z'),z=await fact('z','2026-09-21T12:03:10Z');
  const facts=[p,n,x,y,z],keys:string[]=[];for(const f of facts)keys.push(...await change(f));await sync(keys);
  expect(await read()).toEqual(await oracle(facts));expect(await read('2026-09-21')).toEqual(await oracle(facts,'2026-09-21'));
  expect((await read())?.groups[0]?.sessions).toBe(1);
  const shifted=await fact('n',day+'T12:00:00.001Z');await sync(await change(shifted,n));facts[1]=shifted;
  expect(await read()).toEqual(await oracle(facts));
  const contracted=await fact('x',day+'T12:00:10Z',{components:{inputCacheReadTokens:400,inputUncachedTokens:0,inputCacheWriteTokens:0}});
  await sync(await change(contracted,x));facts[2]=contracted;expect(await read()).toEqual(await oracle(facts));
  const series=await readCanonicalCacheSeries({target:db(),scopes:[cacheScope],nowMs:Date.parse('2026-09-21T15:00:00Z'),stillCurrent:current});
  expect(series?.windows.find(window=>window.window==='week')?.bands.reduce((sum,band)=>sum+band.sessions,0)).toBeGreaterThan(1);
 });
 it('deduplicates legacy slots using native reader order while retaining physical eventsRead',async()=>{
  const first=await fact('same',day+'T12:00:00Z',{},0,'slot0'),duplicate=await fact('same',day+'T12:00:00Z',{speedMode:'fast'},1,'slot1'),
   next=await fact('next',day+'T12:01:00Z',{},2,'slot2');
  const keys:string[]=[];for(const f of [first,duplicate,next])keys.push(...await change(f));await sync(keys);
  expect(await read(day,'legacy-selected-v1')).toEqual(await oracle([first,duplicate,next]));
  expect((await read(day,'legacy-selected-v1'))?.eventsRead).toBe(3);
  await sync(await change(null,first));expect(await read(day,'legacy-selected-v1')).toEqual(await oracle([duplicate,next]));
 });
 it('maintains exact public windows across repairs and calendar rollover through native consumers',async()=>{
  const p=await fact('p'),a=await fact('a',day+'T12:00:10Z'),b=await fact('b',day+'T12:00:20Z'),c=await fact('c',day+'T12:00:30Z'),
   next=await fact('next','2026-09-21T12:00:00Z');
  let facts=[p,a,b,c,next];const keys:string[]=[];for(const f of facts)keys.push(...await change(f));await sync(keys);
  const nowMs=Date.parse('2026-09-21T15:00:00Z');
  const expected=async(at:number)=>{
   const aggregates=await Promise.all([day,'2026-09-21'].map(label=>oracle(facts,label)));
   return CACHE_RETENTION_WINDOWS.map(span=>{
    const from=span.days===null?'0000-01-01':new Date(at-(span.days-1)*86400000).toISOString().slice(0,10);
    const rows=aggregates.filter(aggregate=>aggregate.day>=from).flatMap(aggregate=>aggregate.groups.flatMap(group=>
     group.bands.map(band=>({...band,ownerDigest:scope.ownerDigest,model:group.model}))));
    return publicCacheRetentionWindow({window:span.id,days:span.days,
     pooled:mergeCacheRetentionBands(rows.map(({model:_model,...row})=>row)),modelRows:rows});
   });
  };
  const series=()=>readCacheRetentionCommunitySeries({target:db(),sourceId,nowMs,
   canonical:{scopes:[cacheScope],stillCurrent:current}});
  expect((await series())?.windows).toEqual(await expected(nowMs));
  // Multiple adjacencies in one band/session contribute one membership ref.
  await sync(await change(null,b));facts=facts.filter(f=>f!==b);
  expect((await series())?.windows).toEqual(await expected(nowMs));
  await sync(await change(b));facts.push(b);expect((await series())?.windows).toEqual(await expected(nowMs));
  const shifted=await fact('next','2026-09-21T12:00:00Z',{components:{inputCacheReadTokens:100,inputUncachedTokens:0,inputCacheWriteTokens:0}});
  await sync(await change(shifted,next));facts=facts.filter(f=>f!==next).concat(shifted);
  expect((await series())?.windows).toEqual(await expected(nowMs));
  const tomorrow=nowMs+86400000;
  expect((await readCanonicalCacheSeries({target:db(),scopes:[cacheScope],nowMs:tomorrow,stillCurrent:current}))?.windows).toEqual(await expected(tomorrow));
  const key={sourceId,sourceLayout:'effective' as const,sourceNamespace:sourceId,ownerDigest:scope.ownerDigest,
   deviceId:CACHE_RETENTION_EFFECTIVE_DEVICE_ID,manifestId:CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,manifestDigest:'b'.repeat(64),day};
  const build=createCacheRetentionCanonicalDayBuild({target:db(),now:()=>0,stillCurrent:current});
  expect(await build(key,cacheRetentionLookbackDays(day).map(label=>({day:label,manifestDigest:''})),
   {deadlineMs:60000,remainingQueries:100})).toEqual(await oracle(facts));
  await expect(readCanonicalCacheSeries({target:db(),scopes:[cacheScope,{...cacheScope,selectionMethod:'legacy-selected-v1'}],
   nowMs:tomorrow,stillCurrent:current})).rejects.toThrow('CANONICAL_CACHE_INVALID');
  const profile=createAnalyticsProfile();
  const warm=await readCanonicalCacheSeries({target:profileAnalyticsDatabase(db(),'target',profile,()=> 'warm_series'),scopes:[cacheScope],nowMs:tomorrow,stillCurrent:current});
  expect(warm?.windows).toEqual(await expected(tomorrow));
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)).toBe(0);
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rawHistoryAccessStatements,0)).toBe(0);
  const zeroDay=await fact('zero','2026-08-01T12:00:00Z');await sync(await change(zeroDay));await sync(await change(null,zeroDay));
  expect(await retireCanonicalCachePage(db(),sourceId,1)).toMatchObject({state:'complete',emptyDaysRetired:1});
 });
 it('preserves contributor concentration and session upper bounds with exact reversible membership',async()=>{
  const other={...scope,ownerDigest:'b'.repeat(64)};
  await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')").bind(sourceId,other.ownerDigest).run();
  const first=await Promise.all([0,10,20,30].map(second=>fact('first'+second,day+`T12:00:${String(second).padStart(2,'0')}Z`)));
  const second=await Promise.all([0,10].map(second=>fact('second'+second,day+`T12:00:${String(second).padStart(2,'0')}Z`,{},0,undefined,other)));
  const keys:string[]=[];for(const f of first)keys.push(...await change(f));for(const f of second)keys.push(...await change(f,null,other));await sync(keys);
  const scopes=[cacheScope,{...cacheScope,ownerDigest:other.ownerDigest}],nowMs=Date.parse(day+'T15:00:00Z');
  const readSeries=()=>readCanonicalCacheSeries({target:db(),scopes,nowMs,stillCurrent:current});
  const initial=await readSeries();expect(initial?.windows[0]?.bands[0]).toMatchObject({adjacencies:4,sessions:2,contributors:2,topContributorShare:.75});
  await sync(await change(null,first[1]!));
  expect((await readSeries())?.windows[0]?.bands[0]).toMatchObject({adjacencies:3,sessions:2,contributors:2,topContributorShare:2/3});
  // Same native session UUID in another owner never links the two streams.
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_pairs').first<number>('n')).toBe(3);
  await db().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?").bind(sourceId,other.ownerDigest).run();
  expect((await readCanonicalCacheSeries({target:db(),scopes:[cacheScope],nowMs,stillCurrent:current}))?.windows[0]?.bands[0])
   .toMatchObject({adjacencies:2,sessions:1,contributors:1,topContributorShare:1});
 });
 it('retains native model ranking/truncation and null evidence after maintained-window updates',async()=>{
  const keys:string[]=[];
  for(let model=0;model<10;model++)for(let event=0;event<2;event++) {
   const value=await fact('model'+model+':'+event,day+`T12:0${event}:00Z`,
    {modelId:'synthetic-model-'+model,sessionUuid:'synthetic-session-'+model});keys.push(...await change(value));
  }
  await sync(keys);
  const series=await readCanonicalCacheSeries({target:db(),scopes:[cacheScope],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current});
  expect(series?.windows[0]?.modelsTruncated).toBe(true);
  expect(series?.windows[0]?.byModel.map(model=>model.model)).toEqual(Array.from({length:8},(_,i)=>'synthetic-model-'+i));
  expect(series?.windows[0]?.bands[0]?.reusedMoreThanHalfRate).toBeNull();
 });
 it('preserves empty-own-day fast paths and fences concurrent canonical replacement',async()=>{
  const old=await fact('unprepared','2026-09-19T12:00:00Z');await change(old);
  expect(await read()).toEqual(await oracle([]));
  const zero=await fact('zero',day+'T12:00:00Z',{components:{inputCacheReadTokens:0,inputUncachedTokens:0,inputCacheWriteTokens:0}});
  const keys=await change(zero);await materializeCanonicalCachePartition({target:db(),partitionKey:keys[0]!,budget,stillCurrent:current});
  // Drain only this prepared logical key; the unrelated unprepared prior day
  // remains deferred, yet the native empty own day requires no carry input.
  await repairCanonicalCacheNeighbors({target:db(),budget,stillCurrent:current});expect(await read()).toEqual(await oracle([zero]));
  await sync([old.location.partitionKey]);
  const p=await fact('race'),revised=await fact('race',day+'T12:01:00Z');const [key]=await change(p);let checks=0;
  const result=await materializeCanonicalCachePartition({target:db(),partitionKey:key!,budget,stillCurrent:async()=>{
   if(++checks===2)await change(revised,p);return true;
  }});
  expect(result).toMatchObject({state:'deferred',reason:'canonical_changed'});
  await sync([revised.location.partitionKey]);expect(await read()).toEqual(await oracle([old,zero,revised]));
 });
 it.each(['terminal','delete','fence_update'] as const)('physically erases warmed window and membership products on %s',async(kind)=>{
  const p=await fact('p'),n=await fact('n',day+'T12:02:00Z');await sync([...(await change(p)),...(await change(n))]);
  await readCanonicalCacheSeries({target:db(),scopes:[cacheScope],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current});
  if(kind==='terminal')await db().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?").bind(sourceId,scope.ownerDigest).run();
  if(kind==='delete')await db().prepare('DELETE FROM analytics_owner_state WHERE source_id=? AND owner_digest=?').bind(sourceId,scope.ownerDigest).run();
  if(kind==='fence_update') {
   await db().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
    VALUES(?,?,?,1,2,2,2)`).bind(sourceId,scope.ownerDigest,'e'.repeat(64)).run();
   await db().prepare('UPDATE analytics_storage_erasure_fences SET terminal_revision=terminal_revision WHERE source_id=? AND owner_digest=?').bind(sourceId,scope.ownerDigest).run();
  }
  for(const table of CANONICAL_CACHE_TABLES.filter(table=>!table.endsWith('_clock')))
   expect(await db().prepare('SELECT count(*) n FROM '+table).first<number>('n'),table).toBe(0);
  expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 });
 it('resumes bounded cohort preparation and distinguishes closed empty evidence from pending work',async()=>{
  const scopes=[];
  for(let owner=0;owner<20;owner++) {
   const ownerDigest=owner.toString(16).padStart(64,'0');scopes.push({...cacheScope,ownerDigest});
   await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')").bind(sourceId,ownerDigest).run();
  }
  let completed=false;const statements:number[]=[];
  for(let step=0;step<6;step++) {
   const meter=createD1InvocationBudget(100);
   const result=await readCanonicalCacheSeriesResult({target:meter.wrap(db()),scopes,nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current,
    budget:{remainingQueries:()=>meter.remainingQueries,now:()=>0,deadlineMs:60000}});
   statements.push(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(80);
   if(result.state==='complete') {expect(result.value).toBeNull();expect(result.membershipDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.anchorDay).toBe(day);completed=true;break;}
   expect(result).toEqual({state:'deferred',reason:'window_preparation_pending'});
  }
  expect(completed,JSON.stringify(statements)).toBe(true);expect(statements).toHaveLength(5);
  const warm=createD1InvocationBudget(100);
  expect(await readCanonicalCacheSeriesResult({target:warm.wrap(db()),scopes,nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current,
   budget:{remainingQueries:()=>warm.remainingQueries,now:()=>0,deadlineMs:60000}})).toMatchObject({state:'complete',value:null});
  expect(warm.queriesUsed).toBeLessThanOrEqual(24);
  const value=await fact('pending');await change(value);
  expect(await readCanonicalCacheSeriesResult({target:db(),scopes:[cacheScope],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current}))
   .toMatchObject({state:'deferred',reason:'cache_repairs_pending'});
  expect(await readCanonicalCacheSeriesResult({target:db(),scopes:[],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:async()=>false}))
   .toEqual({state:'deferred',reason:'source_changed'});
 });
 it('resumes dense-day native session proofs and invalidates their seven-day carry dependencies',async()=>{
  const p=await fact('p'),n=await fact('n',day+'T12:01:00Z');await sync([...(await change(p)),...(await change(n))]);
  // Synthetic preaggregated skipped-row counts enter the dense guard without
  // constructing 500,000 source fixtures. Nodes/pairs still use real P1 facts;
  // this is a proof-checkpoint test, not a source population parity claim.
  const days=Array.from({length:5},(_,i)=>new Date(Date.parse(day+'T00:00:00Z')+i*86400000).toISOString().slice(0,10));
  for(const label of days)await db().prepare(`INSERT INTO analytics_canonical_cache_days(source_id,owner_digest,selection_method,day,events_read)
   VALUES(?,?,?,?,100001) ON CONFLICT(source_id,owner_digest,selection_method,day) DO UPDATE SET events_read=100001,revision=revision+1`)
   .bind(sourceId,scope.ownerDigest,scope.selectionMethod,label).run();
  const input={target:db(),scopes:[cacheScope],nowMs:Date.parse(day+'T15:00:00Z'),stillCurrent:current};
  expect(await readCanonicalCacheSeriesResult(input)).toEqual({state:'deferred',reason:'session_proofs_pending'});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_session_proofs').first<number>('n')).toBe(4);
  expect(await readCanonicalCacheSeriesResult(input)).toMatchObject({state:'complete'});
  expect(await db().prepare('SELECT peak FROM analytics_canonical_cache_session_proofs WHERE day=?').bind(day).first<number>('peak')).toBe(1);
  const prior=await fact('prior','2026-09-19T12:00:00Z');await sync(await change(prior));
  expect(await db().prepare(`SELECT count(*) n FROM analytics_canonical_cache_session_proofs p JOIN analytics_canonical_cache_days d
   USING(source_id,owner_digest,selection_method,day) WHERE p.day_revision!=d.revision`).first<number>('n')).toBe(5);
  expect(await readCanonicalCacheSeriesResult(input)).toEqual({state:'deferred',reason:'session_proofs_pending'});
  expect(await readCanonicalCacheSeriesResult(input)).toMatchObject({state:'complete'});
 });
 it('atomically refuses private staging after its cache lease disappears',async()=>{
  const value=await fact('lease');const [partitionKey]=await change(value);
  const result=await materializeCanonicalCachePartition({target:db(),partitionKey:partitionKey!,budget,stillCurrent:current,canCommit:current,
   lease:{contract:'analytics-partition-work-v1',workKey:'1'.repeat(64),headKey:'2'.repeat(64),claimToken:'synthetic-lost-lease',
    revision:1,stage:'cache',residentBytes:1024,admissionQueries:100,expiresAtMs:60000}});
  expect(result).toMatchObject({state:'deferred',reason:'canonical_changed'});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_slots').first<number>('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(0);
 });
 it('does not invalidate token evidence, neighbors or public cache counters on price-only revisions',async()=>{
  const p=await fact('p'),n=await fact('n',day+'T12:02:00Z');const keys=[...(await change(p)),...(await change(n))];await sync(keys);
  const before=(await db().prepare('SELECT * FROM analytics_canonical_cache_pairs ORDER BY later_key').all()).results;
  const revision=await db().prepare('SELECT revision FROM analytics_canonical_cache_clock').first<number>('revision');
  for(const partitionKey of keys) {
   expect(await materializeCanonicalFeaturePartition({target:db(),partitionKey,budget,stillCurrent:current})).toMatchObject({state:'complete'});
   expect(await materializeCanonicalFeaturePartition({target:db(),partitionKey,budget,stillCurrent:current,
    methods:[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:'0'.repeat(64)},CANONICAL_FIT_PRICE_METHOD]}))
    .toMatchObject({state:'complete',metrics:{quantitiesPrepared:0,fitPriceCalls:0}});
  }
  expect((await db().prepare('SELECT * FROM analytics_canonical_cache_pairs ORDER BY later_key').all()).results).toEqual(before);
  expect(await db().prepare('SELECT revision FROM analytics_canonical_cache_clock').first<number>('revision')).toBe(revision);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_cache_logical_work').first<number>('n')).toBe(0);
  expect(await read()).toEqual(await oracle([p,n]));
 });
 it('fences unprepared corrections, stale authority, partial schema and erasure, then leaves no subject rows',async()=>{
  const p=await fact('p'),n=await fact('n',day+'T12:02:00Z');await sync([...(await change(p)),...(await change(n))]);
  const revised=await fact('n',day+'T12:01:00Z');const keys=await change(revised,n);expect(await read()).toBeNull();
  await sync(keys);expect(await read()).toEqual(await oracle([p,revised]));
  expect(await readCanonicalCacheDay({target:db(),scope:cacheScope,day,stillCurrent:async()=>false})).toBeNull();
  await db().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,
   terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,2,2,2)`).bind(sourceId,scope.ownerDigest,'e'.repeat(64)).run();
  for(const table of CANONICAL_CACHE_TABLES.filter(table=>!table.endsWith('_clock')))
   expect(await db().prepare('SELECT count(*) n FROM '+table).first<number>('n'),table).toBe(0);
  expect(await read()).toBeNull();expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await db().prepare('DROP TRIGGER analytics_canonical_cache_pair_admit').run();expect(await canonicalCacheAvailable(db())).toBe(false);
 });
});
