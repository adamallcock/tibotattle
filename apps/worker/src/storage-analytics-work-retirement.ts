import { type D1InvocationBudget } from './d1-invocation-budget';
import { analyticsPartitionWorkAvailable,retireAnalyticsPartitionWork } from './storage-analytics-partition-work';
import { retireCanonicalAnalyticsPage } from './storage-canonical-analytics-facts';
import { canonicalRollingInputsAvailable,retireCanonicalRollingInputs } from './storage-canonical-rolling-inputs';
import { retireSharedAnalyticsFeaturePage } from './storage-analytics-shared-features';
import { retireCanonicalCachePage } from './storage-canonical-cache-pairs';
import { canonicalPublicationAvailable,retireCanonicalPublicationPage } from './storage-canonical-publication';
import { retireMaintainedPublicationCohorts } from './storage-community-publication-cohort';
import { retireObsoleteModelBlockPage } from './storage-analytics-model-block';
import { retireMaintainedGraphWork } from './storage-analytics-maintained-work';

export const ANALYTICS_WORK_CLEANUP_INTERVAL_MS=60_000;

/** Bounded artifact retirement goes through each store's lifecycle contract.
 * Immutable feature children drain before obsolete P1 fact roots; live source facts and
 * current manifests are never removed by this scheduler's metadata retention. */
export async function advanceAnalyticsWorkRetirement(input:{
 target:D1Database;sourceId:string;meter:D1InvocationBudget;now:()=>number;deadlineMs:number;
 /** Explicit age for completed queue metadata, not a source retention policy. */
 completedBeforeMs:number;
}):Promise<{state:'progress'|'idle'|'deferred'|'unavailable';workRetired:number;canonicalRetired:number;rollingRetired:number;cacheRetired:number;publicationRetired:number;cohortsRetired:number;statements:number}> {
 const start=input.meter.queriesUsed,target=input.meter.wrap(input.target);
 let workRetired=0,canonicalRetired=0,rollingRetired=0,cacheRetired=0,publicationRetired=0,cohortsRetired=0,otherRetired=0;
 const productive=()=>workRetired+canonicalRetired+rollingRetired+cacheRetired+publicationRetired+cohortsRetired+otherRetired>0;
 const done=(state:'progress'|'idle'|'deferred'|'unavailable')=>({state,workRetired,canonicalRetired,rollingRetired,cacheRetired,publicationRetired,cohortsRetired,statements:input.meter.queriesUsed-start});
 const available=(reserve:number)=>input.meter.remainingQueries>=reserve+2&&input.now()<input.deadlineMs-1500;
 if(!Number.isSafeInteger(input.completedBeforeMs)||input.completedBeforeMs<0)throw new Error('ANALYTICS_RETIREMENT_INVALID');
 if(!available(120))return done('deferred');
 if(!await analyticsPartitionWorkAvailable(target))return done('unavailable');
 const nowMs=input.now();
 if(!Number.isSafeInteger(nowMs)||nowMs<0||nowMs>Number.MAX_SAFE_INTEGER-ANALYTICS_WORK_CLEANUP_INTERVAL_MS)
  throw new Error('ANALYTICS_RETIREMENT_INVALID');
 await target.prepare('INSERT INTO analytics_partition_maintenance(source_id) VALUES(?) ON CONFLICT DO NOTHING').bind(input.sourceId).run();
 const claim=await target.prepare(`UPDATE analytics_partition_maintenance SET next_cleanup_ms=?,revision=revision+1
  WHERE source_id=? AND next_cleanup_ms<=? RETURNING revision`)
  .bind(nowMs+ANALYTICS_WORK_CLEANUP_INTERVAL_MS,input.sourceId,nowMs).first<{revision:number}>();
 if(!claim)return done('idle');
 const finish=async(state:'progress'|'idle'|'deferred'|'unavailable')=>{
  // Productive pages remain immediately due. A no-op or interrupted page keeps
  // its durable retry time; the response includes this final actual statement.
  if(productive())
   await target.prepare(`UPDATE analytics_partition_maintenance SET next_cleanup_ms=?
    WHERE source_id=? AND revision=?`).bind(nowMs,input.sourceId,claim.revision).run();
  return done(state);
 };
 workRetired=await retireAnalyticsPartitionWork(target,{sourceId:input.sourceId,beforeMs:input.completedBeforeMs,limit:16});
 workRetired+=await retireMaintainedGraphWork(target,{sourceId:input.sourceId,nowMs:input.now(),limit:16});
 if(!available(90))return finish('deferred');
 if(await canonicalRollingInputsAvailable(target))rollingRetired=await retireCanonicalRollingInputs(target,input.sourceId,16,{nowMs:input.now()});
 if(!available(80))return finish('deferred');
 const canonical=await retireCanonicalAnalyticsPage(target,input.sourceId,16);
 if(canonical.state==='unavailable')return finish('unavailable');
 canonicalRetired=canonical.partitionHeadsRetired+canonical.manifestsRetired+canonical.pagesRetired+canonical.factsRetired+canonical.dirtyPartitionsRetired+canonical.factChildrenRetired;
 if(!available(75))return finish('deferred');
 const cache=await retireCanonicalCachePage(target,input.sourceId,16,input.now());
 cacheRetired=cache.slotsRetired+cache.emptyDaysRetired+cache.partitionsRetired;
 if(!available(60))return finish('deferred');
 if(await canonicalPublicationAvailable(target)) {
  publicationRetired=await retireCanonicalPublicationPage(target,{sourceId:input.sourceId,beforeMs:input.completedBeforeMs,limit:16,nowMs:input.now()});
  cohortsRetired=await retireMaintainedPublicationCohorts(target,{sourceId:input.sourceId,beforeMs:input.completedBeforeMs,limit:16,nowMs:input.now()});
 }
 if(!available(60))return finish('deferred');
 const budget={remainingQueries:()=>input.meter.remainingQueries,now:input.now,deadlineMs:input.deadlineMs};
 const features=await retireSharedAnalyticsFeaturePage({target,sourceId:input.sourceId,budget});
 if(features.state==='complete')otherRetired+=features.headsRemoved+features.partsRemoved;
 if(!available(40))return finish('deferred');
 const now=input.now(),model=await retireObsoleteModelBlockPage({target,sourceId:input.sourceId,now,todayDay:new Date(now).toISOString().slice(0,10)});
 otherRetired+=model.deletedJobs+model.cascadedParts+model.policiesAdvanced;
 return finish(productive()?'progress':'idle');
}
