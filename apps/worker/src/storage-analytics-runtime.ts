import { decodeStorageChangeRow, readIngestionChanges, STORAGE_OPERATING_BUDGET_BYTES, type StorageChange } from './analytics-delivery';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { lookupV11StorageSource } from './v11-storage-journal';
import { advanceAdmittedV11DailyProjection, retireV11DailyProjectionPage,
 V11ProjectionDeadlineExceededError } from './v11-daily-projection';
import { advanceV1DailyProjection, advanceV1DailyProjectionPage, prepareV1ProjectionOwnerFence, retireV1DailyProjectionPage } from './v1-daily-projection';
import { advanceLegacyStorageAcknowledgement } from './legacy-storage-journal';
import { advanceNextStorageCommunityDaily, retireStorageCommunityDailyPage } from './storage-community-daily';
import { advanceStorageCommunityGraphWork } from './storage-community-graph-work';
import { retireStorageGraphPage } from './storage-graph-retirement';
import { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview,
 retireStorageCommunityGraphPublications } from './storage-community-graph-publication';
import { readCollectionControls } from './collection-controls';
import { advanceStorageErasureJobs } from './storage-erasure';
import { captureStorageAdminMetricSnapshot, warmStorageAdminMetricsHistoryCache } from './admin-metrics-history';

import type { StorageAnalyticsBindings } from './analytics-delivery';
export type { StorageAnalyticsBindings } from './analytics-delivery';
const invalid=()=>new Error('STORAGE_ANALYTICS_CONTRACT_UNAVAILABLE');
const SOURCE_IDENTITY_SQL=`SELECT s.source_id,a.source_namespace AS v1_namespace,b.source_namespace AS v11_namespace
  FROM storage_source_state s JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
  JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 WHERE s.singleton=1`;
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
 const row=await source.prepare(SOURCE_IDENTITY_SQL).first<{
   source_id:string;v1_namespace:string;v11_namespace:string}>();
 if(!row||row.source_id!==sourceId||row.v1_namespace!==sourceNamespace||row.v11_namespace!==sourceNamespace)throw invalid();
}

interface RuntimeCursorRow {
 runtime_namespace:string;contract_version:number;cursor_sequence:number|null;cursor_epoch:number|null;
 receipt_sequence:number|null;event_digest:string|null;owner_digest:string|null;revision:number|null;kind:string|null;
 object_digest:string|null;content_digest:string|null;authority_epoch:number|null;public_authority_epoch:number|null;recorded_ms:number|null;
}
function exactChange(a:StorageChange,b:StorageChange):boolean{
 return a.sourceId===b.sourceId&&a.sequence===b.sequence&&a.eventDigest===b.eventDigest&&a.ownerDigest===b.ownerDigest
  &&a.revision===b.revision&&a.kind===b.kind&&a.objectDigest===b.objectDigest&&a.contentDigest===b.contentDigest
  &&a.authorityEpoch===b.authorityEpoch&&a.publicAuthorityEpoch===b.publicAuthorityEpoch&&a.recordedMs===b.recordedMs;
}
/** One closed ordinary-dispatch admission. The Queue's same-cursor hint never
 * reaches this function: all runtime, source identity, prior receipt and next
 * event fields are read again from their current databases. */
async function readOrdinaryAdmission(options:StorageAnalyticsBindings):Promise<{sequence:number;change:StorageChange|null}>{
 identifiers(options.sourceId,options.sourceNamespace);if(options.source===options.target)throw invalid();
 const targetResult=await options.target.prepare(`SELECT r.source_namespace AS runtime_namespace,r.contract_version,
   c.sequence AS cursor_sequence,c.authority_epoch AS cursor_epoch,e.sequence AS receipt_sequence,e.event_digest,
   e.owner_digest,e.revision,e.kind,e.object_digest,e.content_digest,e.authority_epoch,e.public_authority_epoch,e.recorded_ms
  FROM analytics_runtime_sources r LEFT JOIN analytics_source_cursors c ON c.source_id=r.source_id
  LEFT JOIN analytics_applied_events e ON e.source_id=c.source_id AND e.sequence=c.sequence WHERE r.source_id=?`)
  .bind(options.sourceId).all<RuntimeCursorRow>();
 if(targetResult.success!==true||!Array.isArray(targetResult.results)||targetResult.results.length!==1)throw invalid();
 const row=targetResult.results[0]!;
 if(row.runtime_namespace!==options.sourceNamespace||row.contract_version!==1)throw invalid();
 const reconciliation=()=>new Error('ANALYTICS_SOURCE_RESTORE_RECONCILIATION_REQUIRED');
 const sequence=row.cursor_sequence??0;if(!Number.isSafeInteger(sequence)||sequence<0)throw reconciliation();
 let prior:StorageChange|null=null;
 if(sequence===0){
  if(row.cursor_sequence!==null&&row.cursor_epoch!==0)throw reconciliation();
  if(row.receipt_sequence!==null)throw invalid();
 }else{
  try{
   prior=decodeStorageChangeRow(options.sourceId,{sequence:row.receipt_sequence,event_digest:row.event_digest,
    owner_digest:row.owner_digest,revision:row.revision,kind:row.kind,object_digest:row.object_digest,
    content_digest:row.content_digest,authority_epoch:row.authority_epoch,
    public_authority_epoch:row.public_authority_epoch,recorded_ms:row.recorded_ms});
  }catch{throw reconciliation();}
  if(prior.sequence!==sequence||row.cursor_epoch!==prior.publicAuthorityEpoch)throw reconciliation();
 }
 const sourceResults=await options.source.batch([
  options.source.prepare(SOURCE_IDENTITY_SQL),
  options.source.prepare('SELECT * FROM storage_ingestion_changes WHERE sequence=?').bind(sequence),
  options.source.prepare('SELECT * FROM storage_ingestion_changes WHERE sequence>? ORDER BY sequence LIMIT 1').bind(sequence),
 ]);
 if(!Array.isArray(sourceResults)||sourceResults.length!==3
   ||sourceResults.some(result=>result?.success!==true||!Array.isArray(result.results)))throw invalid();
 const [identityResult,priorResult,nextResult]=sourceResults;
 if(identityResult!.results.length!==1||priorResult!.results.length>1||nextResult!.results.length>1)throw invalid();
 if(sequence===0?priorResult!.results.length!==0:priorResult!.results.length!==1)throw reconciliation();
 const identity=identityResult!.results[0] as {source_id?:unknown;v1_namespace?:unknown;v11_namespace?:unknown};
 if(identity.source_id!==options.sourceId||identity.v1_namespace!==options.sourceNamespace
   ||identity.v11_namespace!==options.sourceNamespace)throw invalid();
 if(prior){
  let sourcePrior:StorageChange;try{sourcePrior=decodeStorageChangeRow(options.sourceId,priorResult!.results[0]);}
  catch{throw reconciliation();}
  if(!exactChange(prior,sourcePrior))throw reconciliation();
 }
 if(nextResult!.results.length===0)return {sequence,change:null};
 const change=decodeStorageChangeRow(options.sourceId,nextResult!.results[0]);
 if(change.sequence!==sequence+1)throw new Error('ANALYTICS_SOURCE_GAP');
 return {sequence,change};
}

async function classifyOrdinaryChange(source:D1Database,change:StorageChange):Promise<'legacy'|'v1'|'v11'>{
 const results=await source.batch([
  source.prepare('SELECT 1 AS present FROM storage_legacy_event_sources WHERE event_digest=? AND owner_digest=? LIMIT 2')
   .bind(change.eventDigest,change.ownerDigest),
  source.prepare('SELECT 1 AS present FROM typed_v1_event_sources WHERE event_digest=? AND owner_digest=? LIMIT 2')
   .bind(change.eventDigest,change.ownerDigest),
 ]);
 if(!Array.isArray(results)||results.length!==2||results.some(result=>result?.success!==true
   ||!Array.isArray(result.results)||result.results.length>1
   ||result.results.some(row=>(row as {present?:unknown}).present!==1)))throw invalid();
 const legacy=results[0]!.results.length===1,v1=results[1]!.results.length===1;
 if(legacy&&v1)throw invalid();return legacy?'legacy':v1?'v1':'v11';
}
async function assertRuntime(options:StorageAnalyticsBindings):Promise<number> {
 identifiers(options.sourceId,options.sourceNamespace);if(options.source===options.target)throw invalid();
 // The target contract row and source identity are independent reads. Start
 // both together without removing the later cursor-to-journal receipt proof.
 const [row]=await Promise.all([
  options.target.prepare('SELECT source_namespace,contract_version FROM analytics_runtime_sources WHERE source_id=?')
   .bind(options.sourceId).first<{source_namespace:string;contract_version:number}>(),
  assertSource(options),
 ]);
 if(!row||row.source_namespace!==options.sourceNamespace||row.contract_version!==1)throw invalid();
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
export async function advanceStorageAnalytics(options:StorageAnalyticsBindings&{
 signal?:AbortSignal;maxV11PhysicalPages?:number;deadlineMs?:number;
}) {
 const {source,target,sourceId,sourceNamespace}=options;
 const {sequence,change}=await readOrdinaryAdmission(options);options.signal?.throwIfAborted();
 if(!change)return {state:'idle' as const,sequence,recordsRead:0};
 const format=await classifyOrdinaryChange(source,change);
 if(format==='legacy')return advanceLegacyStorageAcknowledgement({source,target,sourceId,signal:options.signal});
 if(format==='v1')return advanceV1DailyProjection({...options});
 const proof=await lookupV11StorageSource(source,change);
 if(proof.disposition==='discard') {
  const statements=prepareV1ProjectionOwnerFence(target,change,proof);
  if(statements.length)await target.batch(statements);
 }
 return advanceAdmittedV11DailyProjection({source,target,sourceId,change,input:proof,signal:options.signal,
  maxPhysicalPages:options.maxV11PhysicalPages,deadlineMs:options.deadlineMs,
  sourceLayout:{kind:'typed-v11',sourceNamespace}});
}
async function advanceStorageAnalyticsV1Page(options:StorageAnalyticsBindings&{
 signal?:AbortSignal;publicationControlRevision?:number;publicationEnabled?:boolean;
},limit:number){
 const sequence=await assertRuntime(options);options.signal?.throwIfAborted();
 const changes=await readIngestionChanges(options.source,options.sourceId,sequence,limit);
 if(!changes.length)return {state:'idle' as const,sequence,events:0,recordsRead:0,decodedBytes:0,
  sourceReadMs:0,foldMs:0,sourceRecheckMs:0,targetWriteMs:0,pageDurationMs:0};
 return advanceV1DailyProjectionPage({...options,changes});
}
export interface StorageAnalyticsPass {
 state:'idle'|'progress'|'deferred';steps:number;recordsRead:number;queriesUsed:number;
 dailyPublications:number;graphCalculations:number;
 reason:'complete'|'step_limit'|'deadline'|'query_budget'|'capacity'|'format_boundary';
}
export interface StorageAnalyticsCatchupMetrics {
 decodedBytes:number;sourceReadMs:number;foldMs:number;sourceRecheckMs:number;targetWriteMs:number;pageDurationMs:number;
}
/** Runs in an independent scheduled invocation. The actual query meter is
 * shared by BOTH databases; a batch counts all statements. A failed calculation
 * cannot participate in, roll back or delay an upload transaction. */
export async function runStorageAnalyticsPass(options:StorageAnalyticsBindings&{
 maxSteps?:number;deadlineMs?:number;maxQueries?:number;signal?:AbortSignal;
 publishCommunity?:boolean;
  ledger?:D1Database;skipV1PrefixProbe?:boolean;
}):Promise<StorageAnalyticsPass> {
 const maxSteps=options.maxSteps??8,deadlineMs=options.deadlineMs??Date.now()+20_000;
 if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>32||!Number.isFinite(deadlineMs)
   ||(options.skipV1PrefixProbe!==undefined&&typeof options.skipV1PrefixProbe!=='boolean'))throw invalid();
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
  // Restore the owner dashboard even while the ordered analytics journal is
  // catching up. This optional phase has its own hard 40-query sub-budget and
  // leaves 100 queries for mandatory delivery. Its source readers are also
  // capped by row count, so failure preserves the prior cache and cannot turn
  // missing evidence into zero.
  if(meter.remainingQueries>=140&&deadlineMs-Date.now()>=5_000){
   const adminMeter=createD1InvocationBudget(40);
   const adminScoped={...scoped,source:adminMeter.wrap(scoped.source),target:adminMeter.wrap(scoped.target)};
   const snapshot=await captureStorageAdminMetricSnapshot(adminScoped,Date.now());
   if(snapshot.code!=='SNAPSHOT_UNAVAILABLE'&&adminMeter.remainingQueries>0&&Date.now()<deadlineMs) {
    await warmStorageAdminMetricsHistoryCache(adminScoped,Date.now());
   }
  }
  for(;steps<maxSteps;) {
   options.signal?.throwIfAborted();
   if(Date.now()>=deadlineMs)return result('deferred','deadline');
   if(meter.remainingQueries<100)return result('deferred','query_budget');
   // Publication-paused catch-up can combine a current typed-v1 prefix. Public
   // work retains the ordinary one-event cadence so serving gates and derived
   // publication interleave exactly as before.
   const page=!options.publishCommunity&&!options.skipV1PrefixProbe
    ?await advanceStorageAnalyticsV1Page(scoped,Math.min(4,maxSteps-steps)):null;
   const v11Pages=Math.min(5,Math.max(1,1+Math.floor(Math.max(0,meter.remainingQueries-100)/12)));
   const step=page&&page.events>0?page:await advanceStorageAnalytics({...scoped,maxV11PhysicalPages:v11Pages,deadlineMs});
   steps+=page&&page.events>0?page.events:1;recordsRead+=step.recordsRead;
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
  if(error instanceof V11ProjectionDeadlineExceededError)return result('deferred','deadline');
  throw error;
 }
}

/** Operator-only typed-v1 backlog pass. It never dispatches a legacy, v1.1,
 * terminal or authority event and never publishes derived data. The ordinary
 * scheduler remains responsible for that exact boundary. */
export async function runStorageAnalyticsV1CatchupPass(options:StorageAnalyticsBindings&{
 pageEvents?:number;maxSteps?:number;deadlineMs?:number;maxQueries?:number;signal?:AbortSignal;
 ledger?:D1Database;publicationControlRevision?:number;publicationEnabled?:boolean;
}):Promise<StorageAnalyticsPass&{metrics:StorageAnalyticsCatchupMetrics}>{
 const pageEvents=options.pageEvents??16,maxSteps=options.maxSteps??pageEvents;
 const deadlineMs=options.deadlineMs??Date.now()+20_000;
 if(!Number.isSafeInteger(pageEvents)||pageEvents<1||pageEvents>16||!Number.isSafeInteger(maxSteps)
  ||maxSteps<1||maxSteps>64||!Number.isFinite(deadlineMs)
  ||(options.publicationControlRevision!==undefined&&(!Number.isSafeInteger(options.publicationControlRevision)||options.publicationControlRevision<1))
  ||((options.publicationControlRevision===undefined)!==(options.publicationEnabled===undefined)))throw invalid();
 const meter=createD1InvocationBudget(options.maxQueries??900);
 const scoped={...options,source:meter.wrap(options.source),target:meter.wrap(options.target)};
 let steps=0,recordsRead=0;
 const metrics:StorageAnalyticsCatchupMetrics={decodedBytes:0,sourceReadMs:0,foldMs:0,sourceRecheckMs:0,targetWriteMs:0,pageDurationMs:0};
 const result=(state:StorageAnalyticsPass['state'],reason:StorageAnalyticsPass['reason']):StorageAnalyticsPass&{metrics:StorageAnalyticsCatchupMetrics}=>({
  state,reason,steps,recordsRead,queriesUsed:meter.queriesUsed,dailyPublications:0,graphCalculations:0,
  metrics:{...metrics},
 });
 try{
  if(Date.now()>=deadlineMs)return result('deferred','deadline');
  if(options.ledger)await advanceStorageErasureJobs({...scoped,ledger:meter.wrap(options.ledger)},{maxJobs:1});
  const probe=await scoped.target.prepare('SELECT 1 AS capacity_probe').run();
  const size=probe.meta.size_after;
  if(!Number.isSafeInteger(size)||size<0)throw invalid();
  if(size>STORAGE_OPERATING_BUDGET_BYTES-16*1024*1024){
   await retireV11DailyProjectionPage(scoped.target,options.sourceId);
   await retireV1DailyProjectionPage(scoped.target,options.sourceId);
   await retireStorageGraphPage(scoped.target,options.sourceId);
   return result('deferred','capacity');
  }
  while(steps<maxSteps){
   options.signal?.throwIfAborted();
   if(Date.now()>=deadlineMs)return result('deferred','deadline');
   // A maximum 16-event page uses at most 48 record reads, 48 tool reads,
   // 16 metadata, admission and final checks, plus 48 target statements.
   // Refuse before source work if the shared invocation meter cannot hold it.
   if(meter.remainingQueries<250)return result('deferred','query_budget');
   const page=await advanceStorageAnalyticsV1Page(scoped,Math.min(pageEvents,maxSteps-steps));
   metrics.decodedBytes+=page.decodedBytes;metrics.sourceReadMs+=page.sourceReadMs;metrics.foldMs+=page.foldMs;
   metrics.sourceRecheckMs+=page.sourceRecheckMs;metrics.targetWriteMs+=page.targetWriteMs;metrics.pageDurationMs+=page.pageDurationMs;
   if(page.state==='idle')return result(steps?'progress':'idle','complete');
   if(page.state==='boundary')return result('deferred','format_boundary');
   steps+=page.events;recordsRead+=page.recordsRead;
   await retireV11DailyProjectionPage(scoped.target,options.sourceId);
   await retireV1DailyProjectionPage(scoped.target,options.sourceId);
   await retireStorageGraphPage(scoped.target,options.sourceId);
  }
  return result('progress','step_limit');
 }catch(error){
  if(error instanceof D1InvocationBudgetExceededError)return result('deferred','query_budget');
  throw error;
 }
}
