import { readIngestionChanges, STORAGE_OPERATING_BUDGET_BYTES } from './analytics-delivery';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { lookupV11StorageSource } from './v11-storage-journal';
import { advanceV11DailyProjection, retireV11DailyProjectionPage } from './v11-daily-projection';
import { advanceV1DailyProjection, prepareV1ProjectionOwnerFence, retireV1DailyProjectionPage } from './v1-daily-projection';
import { isLegacyStorageChange, advanceLegacyStorageAcknowledgement } from './legacy-storage-journal';
import { advanceNextStorageCommunityDaily, retireStorageCommunityDailyPage } from './storage-community-daily';
import { advanceStorageCommunityGraphWork } from './storage-community-graph-work';
import { retireStorageGraphPage } from './storage-graph-retirement';
import { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview,
 retireStorageCommunityGraphPublications } from './storage-community-graph-publication';
import { readCollectionControls } from './collection-controls';
import { advanceStorageErasureJobs } from './storage-erasure';

import type { StorageAnalyticsBindings } from './analytics-delivery';
export type { StorageAnalyticsBindings } from './analytics-delivery';
const invalid=()=>new Error('STORAGE_ANALYTICS_CONTRACT_UNAVAILABLE');
function identifiers(sourceId:string,namespace:string):void {
 if(!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(sourceId)
   || typeof namespace!=='string' || namespace.length<1 || namespace.length>256)throw invalid();
}
/** Explicit local/operator initialization. Source credentials are never copied
 * into analytics; the journal ID and original namespace are independently pinned. */
export async function initializeStorageAnalyticsRuntime(options:StorageAnalyticsBindings):Promise<void> {
 identifiers(options.sourceId,options.sourceNamespace);
 if(options.source===options.target)throw invalid();
 if(await options.target.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name IN ('participants','storage_source_state') LIMIT 1").first())throw invalid();
 await assertSource(options);
 await options.target.prepare(`INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version)
  VALUES(?,?,1) ON CONFLICT(source_id) DO NOTHING`).bind(options.sourceId,options.sourceNamespace).run();
 await assertRuntime(options);
}
async function assertSource({source,sourceId,sourceNamespace}:StorageAnalyticsBindings):Promise<void> {
 const row=await source.prepare(`SELECT s.source_id,a.source_namespace AS v1_namespace,b.source_namespace AS v11_namespace
  FROM storage_source_state s JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
  JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 WHERE s.singleton=1`).first<{
   source_id:string;v1_namespace:string;v11_namespace:string}>();
 if(!row||row.source_id!==sourceId||row.v1_namespace!==sourceNamespace||row.v11_namespace!==sourceNamespace)throw invalid();
}
async function assertRuntime(options:StorageAnalyticsBindings):Promise<number> {
 identifiers(options.sourceId,options.sourceNamespace);if(options.source===options.target)throw invalid();
 const row=await options.target.prepare('SELECT source_namespace,contract_version FROM analytics_runtime_sources WHERE source_id=?')
  .bind(options.sourceId).first<{source_namespace:string;contract_version:number}>();
 if(!row||row.source_namespace!==options.sourceNamespace||row.contract_version!==1)throw invalid();
 await assertSource(options);
 // A cursor is meaningful only against the exact journal that produced its
 // retained receipt. The legacy-to-fresh-typed restore operator does not repair
 // typed rollback: a new source incarnation or explicit journal reconciliation
 // is required. Never raise epochs or reinterpret a divergent source as idle.
 const cursor=await options.target.prepare(`SELECT c.sequence,c.authority_epoch AS cursor_epoch,
   e.event_digest,e.owner_digest,e.revision,e.kind,e.object_digest,e.content_digest,
   e.authority_epoch,e.public_authority_epoch,e.recorded_ms
  FROM analytics_source_cursors c LEFT JOIN analytics_applied_events e
   ON e.source_id=c.source_id AND e.sequence=c.sequence WHERE c.source_id=?`)
  .bind(options.sourceId).first<{sequence:number;cursor_epoch:number;event_digest:string|null;
   owner_digest:string;revision:number;kind:string;object_digest:string;content_digest:string;
   authority_epoch:number;public_authority_epoch:number;recorded_ms:number}>();
 if(!cursor)return 0;
 const reconciliation=()=>new Error('ANALYTICS_SOURCE_RESTORE_RECONCILIATION_REQUIRED');
 if(!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0)throw reconciliation();
 if(cursor.sequence===0){if(cursor.cursor_epoch!==0)throw reconciliation();return 0;}
 if(!cursor.event_digest||cursor.cursor_epoch!==cursor.public_authority_epoch)throw reconciliation();
 const matching=await options.source.prepare(`SELECT 1 FROM storage_ingestion_changes
  WHERE sequence=? AND event_digest=? AND owner_digest=? AND revision=? AND kind=?
   AND object_digest=? AND content_digest=? AND authority_epoch=? AND public_authority_epoch=? AND recorded_ms=?`)
  .bind(cursor.sequence,cursor.event_digest,cursor.owner_digest,cursor.revision,cursor.kind,
   cursor.object_digest,cursor.content_digest,cursor.authority_epoch,cursor.public_authority_epoch,cursor.recorded_ms).first();
 if(!matching)throw reconciliation();
 return cursor.sequence;
}

/** One format-dispatched journal step. A terminal fence is committed before an
 * acknowledgement which could let later work proceed. Response loss may leave
 * a conservative fence, never a falsely acknowledged or publicly eligible row. */
export async function advanceStorageAnalytics(options:StorageAnalyticsBindings&{signal?:AbortSignal}) {
 const {source,target,sourceId,sourceNamespace}=options;
 const sequence=await assertRuntime(options);options.signal?.throwIfAborted();
 const change=(await readIngestionChanges(source,sourceId,sequence,1))[0];
 if(!change)return {state:'idle' as const,sequence,recordsRead:0};
 if(change.sequence!==sequence+1)throw new Error('ANALYTICS_SOURCE_GAP');
 if(await isLegacyStorageChange(source,change))return advanceLegacyStorageAcknowledgement({source,target,sourceId,signal:options.signal});
 const v1=await source.prepare('SELECT 1 FROM typed_v1_event_sources WHERE event_digest=? AND owner_digest=?')
  .bind(change.eventDigest,change.ownerDigest).first();
 if(v1)return advanceV1DailyProjection({...options});
 const proof=await lookupV11StorageSource(source,change);
 if(proof.disposition==='discard') {
  const statements=prepareV1ProjectionOwnerFence(target,change,proof);
  if(statements.length)await target.batch(statements);
 }
 return advanceV11DailyProjection({source,target,sourceId,signal:options.signal,
  sourceLayout:{kind:'typed-v11',sourceNamespace}});
}
export interface StorageAnalyticsPass {
 state:'idle'|'progress'|'deferred';steps:number;recordsRead:number;queriesUsed:number;
 dailyPublications:number;graphCalculations:number;
 reason:'complete'|'step_limit'|'deadline'|'query_budget'|'capacity';
}
/** Runs in an independent scheduled invocation. The actual query meter is
 * shared by BOTH databases; a batch counts all statements. A failed calculation
 * cannot participate in, roll back or delay an upload transaction. */
export async function runStorageAnalyticsPass(options:StorageAnalyticsBindings&{
 maxSteps?:number;deadlineMs?:number;maxQueries?:number;signal?:AbortSignal;
 publishCommunity?:boolean;
 ledger?:D1Database;
}):Promise<StorageAnalyticsPass> {
 const maxSteps=options.maxSteps??8,deadlineMs=options.deadlineMs??Date.now()+20_000;
 if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>32||!Number.isFinite(deadlineMs))throw invalid();
 const meter=createD1InvocationBudget(options.maxQueries??900);
 const scoped={...options,source:meter.wrap(options.source),target:meter.wrap(options.target)};
 let steps=0,recordsRead=0,dailyPublications=0,graphCalculations=0;
 const result=(state:StorageAnalyticsPass['state'],reason:StorageAnalyticsPass['reason']):StorageAnalyticsPass=>
  ({state,reason,steps,recordsRead,queriesUsed:meter.queriesUsed,dailyPublications,graphCalculations});
 try {
  if(Date.now()>=deadlineMs)return result('deferred','deadline');
  // Privacy cleanup is independent of publication and capacity admission for
  // new analytical work. The same invocation meter covers all three databases.
  if(options.ledger)await advanceStorageErasureJobs({...scoped,ledger:meter.wrap(options.ledger)},{maxJobs:1});
  // Physical use is an observed operating guard. This is not a distributed
  // allocation reservation; the operator keeps concurrent writers within budget.
  const probe=await scoped.target.prepare('SELECT 1 AS capacity_probe').run();
  const size=probe.meta.size_after;
  if(!Number.isSafeInteger(size)||size<0)throw invalid();
  if(size>STORAGE_OPERATING_BUDGET_BYTES-16*1024*1024){
   // A full derived store must still reclaim superseded work. Otherwise the
   // admission guard would permanently prevent the cleanup that frees space.
   // Retirement is bounded and remains available with publication paused.
   await retireV11DailyProjectionPage(scoped.target,options.sourceId);
   await retireV1DailyProjectionPage(scoped.target,options.sourceId);
   await retireStorageGraphPage(scoped.target,options.sourceId);
   await retireStorageCommunityDailyPage(scoped);
   await retireStorageCommunityGraphPublications(scoped);
   return result('deferred','capacity');
  }
  for(;steps<maxSteps;) {
   options.signal?.throwIfAborted();
   if(Date.now()>=deadlineMs)return result('deferred','deadline');
   if(meter.remainingQueries<100)return result('deferred','query_budget');
   const step=await advanceStorageAnalytics(scoped);steps++;recordsRead+=step.recordsRead;
   // Retiring old generations cannot be starved by an always-busy journal.
   const v11=await retireV11DailyProjectionPage(scoped.target,options.sourceId);
   const v1=await retireV1DailyProjectionPage(scoped.target,options.sourceId);
   const retiredGraph=await retireStorageGraphPage(scoped.target,options.sourceId);
   let publicIdle=true;
   if(options.publishCommunity && meter.remainingQueries>=100 && Date.now()<deadlineMs
     && (await readCollectionControls(scoped.source)).publication) {
    const daily=await advanceNextStorageCommunityDaily(scoped);
    if(daily.state==='published')dailyPublications++;
    publicIdle=daily.state==='idle';
    await retireStorageCommunityDailyPage(scoped);
    if(meter.remainingQueries>=550 && Date.now()<deadlineMs) {
     const graph=await advanceStorageCommunityGraphWork({...scoped,remainingQueries:meter.remainingQueries,deadlineMs});
     if(graph.state==='complete')graphCalculations++;
     if((graph.state==='complete'||graph.state==='reused')&&meter.remainingQueries>=250&&Date.now()<deadlineMs) {
      if(graph.metric==='model'&&graph.day)await publishStorageCommunityModelDay(scoped,{day:graph.day});
      if(meter.remainingQueries>=250&&Date.now()<deadlineMs)await publishStorageCommunityGraphPreview(scoped);
     }
     if(meter.remainingQueries>=30)await retireStorageCommunityGraphPublications(scoped);
     publicIdle=publicIdle&&graph.state==='idle';
    } else publicIdle=false;
   }
   if(step.state==='idle'&&v11.state==='idle'&&v1.state==='idle'&&retiredGraph.state==='idle'&&publicIdle)return result('idle','complete');
  }
  return result('progress','step_limit');
 }catch(error){
  if(error instanceof D1InvocationBudgetExceededError)return result('deferred','query_budget');
  throw error;
 }
}
