import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceCanonicalInputWork,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {materializeCanonicalPartition,readCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {advanceAnalyticsCacheWork} from '../src/storage-analytics-cache-work';
import {canonicalCacheRepairPageBlocked,CANONICAL_CACHE_PREPARED_READY_PREDICATE} from '../src/storage-canonical-cache-pairs';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,recordAnalyticsPartitionWorkReason,
 releaseAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {sha256Hex} from '../src/crypto';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,sourceId='synthetic-cache-receipt';
const currentReady=(workKey:string)=>target().prepare(`SELECT 1 ready FROM analytics_partition_work w
 WHERE w.work_key=? AND ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}`).bind(workKey).first<number>('ready');

it('records a prepared cache leaf only after a live source proof, skips its blocked claim, then wakes it after the second leaf',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:1,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 for(let pass=0;pass<48;pass++){
  const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
   participantId:corpus.participantId,maxSteps:64,maxRows:128});
  if(progress.status==='complete')break;
  expect(progress.status).not.toBe('unavailable');
 }
 const days=[corpus.equivalentDay,corpus.correctionDay];
 for(const day of days){
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
   participantId:corpus.participantId,day,stream:'usage',selectionMethod:'effective-union-v1'};
  let sealed=false;
  for(let pass=0;pass<24;pass++){
   const progress=await advanceCanonicalInputWork(source(),target(),{...scope,
    budget:{meter:createD1InvocationBudget(900),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}});
   if(progress.state==='complete'){sealed=true;expect(progress.seal?.empty).toBe(false);break;}
   expect(progress.state).toBe('progress');
  }
  expect(sealed).toBe(true);
 }
 const keys=(await target().prepare(`SELECT DISTINCT partition_key FROM analytics_canonical_facts
  WHERE source_id=? AND owner_digest=? AND selection_method='effective-union-v1' AND stream='usage'
  AND observed_day IN(?,?) ORDER BY partition_key`).bind(sourceId,corpus.owner.ownerDigest,...days)
  .all<{partition_key:string}>()).results.map(row=>row.partition_key);
 expect(keys.length).toBe(2);
 const manifests=[];
 for(const key of keys){
  const prepared=await materializeCanonicalPartition(target(),key);
  expect(prepared.state).toBe('complete');
  const partition=await readCanonicalPartition(target(),key);
  expect(partition?.facts.length).toBe(1);manifests.push(partition!.manifest);
 }
 const admitted:AnalyticsWorkRequest[]=await Promise.all(manifests.map(async(manifest,index)=>({
  sourceId,ownerDigest:corpus.owner.ownerDigest,stage:'cache' as const,lane:'new' as const,
  partitionKey:manifest.partitionKey,headKey:await sha256Hex('cache-receipt-head:'+index),
  inputRevision:manifest.contentRevision,policyRevision:'c'.repeat(64),day:days.find(day=>manifest.partitionKey.includes('/'+day+'/'))!,
  stream:'usage' as const,selectionMethod:'effective-union-v1' as const,residentBytes:1024*1024,admissionQueries:160
 })));
 const workKeys=await admitAnalyticsPartitionWork(target(),admitted,Date.now());
 expect(workKeys).toHaveLength(2);
 const nowMs=Date.now(),lost=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs,leaseMs:1000,
  stages:['cache']}))[0]!;
 const heldOther=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:nowMs+1,
  leaseMs:120_000,stages:['cache']}))[0]!;
 expect(heldOther.workKey).toBe(workKeys.find(key=>key!==lost.workKey));
 const execute=async(lease:typeof lost,time:number)=>{
  const outer=createD1InvocationBudget(950),meter=createD1InvocationBudget(900);
  const db=outer.wrap(target());
  const result=await advanceAnalyticsCacheWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,
   database:outer.wrap(source())}],lease,budget:{meter,now:()=>time,deadlineMs:time+60_000,
   remainingQueries:()=>Math.min(outer.remainingQueries,meter.remainingQueries)}});
  expect(outer.queriesUsed).toBeLessThanOrEqual(950);
  return result;
 };
 // A lost or expired lease cannot create a preparation receipt.
 expect(await execute(lost,lost.expiresAtMs+1)).toMatchObject({outcome:'deferred',reason:'lease_changed'});
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_prepared_receipts').first<number>('n')).toBe(0);
 const a=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:lost.expiresAtMs+1,
  leaseMs:120_000,stages:['cache']}))[0]!;
 expect(a.workKey).toBe(lost.workKey);
 const first=await execute(a,lost.expiresAtMs+2);
 expect(first).toMatchObject({outcome:'deferred',reason:'cache_repairs_pending',completedWithinLease:false});
 expect(await target().prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?')
  .bind(a.workKey).first<string>('work_key')).toBe(a.workKey);
 await recordAnalyticsPartitionWorkReason(target(),a,first.reason,lost.expiresAtMs+2);
 expect(await releaseAnalyticsPartitionWork(target(),a,'deferred',lost.expiresAtMs+2)).toBe(true);
 expect(await releaseAnalyticsPartitionWork(target(),heldOther,'deferred',lost.expiresAtMs+2)).toBe(true);
 expect(await currentReady(a.workKey)).toBe(1);
 const blocked=await canonicalCacheRepairPageBlocked({target:target(),budget:{remainingQueries:()=>950,
  now:()=>lost.expiresAtMs+3,deadlineMs:lost.expiresAtMs+60_000}});
 expect(blocked).toBe(true);
 const bLease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:lost.expiresAtMs+3,
  stages:['cache'],cacheRepairBlocked:blocked}))[0]!;
 expect(bLease.workKey).toBe(workKeys.find(key=>key!==a.workKey));
 const second=await execute(bLease,lost.expiresAtMs+4);
 expect(second.outcome).not.toBe('refused');
 if(!second.completedWithinLease){
  await recordAnalyticsPartitionWorkReason(target(),bLease,second.reason,lost.expiresAtMs+4);
  expect(await releaseAnalyticsPartitionWork(target(),bLease,'deferred',lost.expiresAtMs+4)).toBe(true);
 }
 expect(await canonicalCacheRepairPageBlocked({target:target(),budget:{remainingQueries:()=>950,
  now:()=>lost.expiresAtMs+5,deadlineMs:lost.expiresAtMs+60_000}})).toBe(false);
 const resumed=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:lost.expiresAtMs+5,
  stages:['cache']}))[0]!;
 expect(resumed.workKey).toBe(a.workKey);
 const finished=await execute(resumed,lost.expiresAtMs+6);
 expect(finished).toMatchObject({outcome:'complete',reason:'cache_prepared',completedWithinLease:true});
 if(!second.completedWithinLease){
  const bAgain=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:lost.expiresAtMs+7,
   stages:['cache']}))[0]!;
  expect(bAgain.workKey).toBe(bLease.workKey);
  expect(await execute(bAgain,lost.expiresAtMs+8)).toMatchObject({outcome:'complete',reason:'cache_prepared',
   completedWithinLease:true});
 }

 // A fresh accepted source correction invalidates the old input seal. A new
 // cache lease for that old manifest must not mint a credible receipt.
 await corpus.mutateCorrection();
 const staleKey=manifests.find(manifest=>manifest.partitionKey.includes('/'+corpus.correctionDay+'/'))!;
 const original=admitted.find(request=>request.partitionKey===staleKey.partitionKey)!;
 const [staleWork]=await admitAnalyticsPartitionWork(target(),[{...original,partitionKey:staleKey.partitionKey,
  headKey:await sha256Hex('cache-receipt-stale-source'),inputRevision:staleKey.contentRevision}],Date.now());
 const staleLease=(await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now(),stages:['cache']}))[0]!;
 expect(staleLease.workKey).toBe(staleWork);
 const changed=await execute(staleLease,Date.now());
 expect(changed).toMatchObject({outcome:'deferred',reason:'canonical_input_unsealed',completedWithinLease:false});
 expect(await target().prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?')
  .bind(staleWork).first()).toBeNull();
},120_000);
