import { decodeStorageChangeRow, readIngestionChanges, STORAGE_OPERATING_BUDGET_BYTES, type StorageChange } from './analytics-delivery';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { lookupV11StorageSource } from './v11-storage-journal';
import { advanceAdmittedV11DailyProjection, retireV11DailyProjectionPage,
 V11ProjectionDeadlineExceededError } from './v11-daily-projection';
import { advanceV1DailyProjection, advanceV1DailyProjectionPage, prepareV1ProjectionOwnerFence, retireV1DailyProjectionPage } from './v1-daily-projection';
import { advanceLegacyStorageAcknowledgement } from './legacy-storage-journal';
import { advanceNextStorageCommunityDaily, retireStorageCommunityDailyPage } from './storage-community-daily';
import { advanceStorageCommunityGraphWork, type StorageGraphWorkProgress } from './storage-community-graph-work';
import { retireStorageGraphPage } from './storage-graph-retirement';
import { advanceGraphDayProjectionLane, retireGraphDayProjectionPage,
 type GraphDayProjectionBuild } from './graph-day-projection';
import { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview,
 retireStorageCommunityGraphPublications, storageCommunityGraphPreviewReadyHint } from './storage-community-graph-publication';
import { readCollectionControls } from './collection-controls';
import { advanceStorageErasureJobs } from './storage-erasure';
import { captureStorageAdminMetricSnapshot, warmStorageAdminMetricsHistoryCache } from './admin-metrics-history';
import { caughtStorageGraphFailureFields, storageGraphFailureDetail,
 type StorageGraphFailureFields } from './storage-analytics-failure';

import type { StorageAnalyticsBindings } from './analytics-delivery';
export type { StorageAnalyticsBindings } from './analytics-delivery';
const invalid=()=>new Error('STORAGE_ANALYTICS_CONTRACT_UNAVAILABLE');
/** Statements the graph lane refuses to open below. A pass that gets one graph
 * attempt per invocation reserves a whole heavy attempt and its checkpoint
 * save. A graph-only pass returns to the same lane for its whole window, so it
 * reserves only one small group plus the kernel's continue guard; a floor sized
 * for the other pass would end its window with most of the meter unspent. */
const GRAPH_LANE_ADMISSION_QUERIES=550,GRAPH_ONLY_ADMISSION_QUERIES=120;
/** The prepared-graph-day builder's whole allowance. It is a small carve-out
 * on purpose: the lane prepares reusable input for a fold that is not live yet,
 * so it must never reduce the graph lane below its 550-statement floor and must
 * never open inside a graph-only long pass, which exists to give ONE resumable
 * owner-day claim a whole window. */
const GRAPH_DAY_PROJECTION_LANE_QUERIES=60;
/** The OPENING slot's allowance, which is a different problem from the
 * trailing one. A day's build costs source statements — one reader scope, one
 * page per 16,384 quota rows, one per 5,000 usage rows, two generation fences,
 * plus three to resolve a new owner — and the trailing slot's 60, halved, left
 * about 18. That is under the cost of one dense day, so the lane started a day,
 * exhausted its allowance part way through, discarded the work and did the same
 * thing next pass: a livelock, not a stall. The opening slot runs before the
 * publication lanes with the graph lane's floor already reserved, so it can
 * have what is left above that floor without taking anything from it. */
const GRAPH_DAY_PROJECTION_OPEN_QUERIES=250;
/** What the opening slot leaves behind, which is NOT the graph lane's 550
 * floor. Reserving that floor first is what made the slot unfundable: the
 * public pass starts with the worker meter's remainder after delivery, often
 * 500-700 rather than 900, so `remaining - 650` reached zero before the 250
 * ceiling ever bound and the slot got no source budget at all. On its one
 * minute in five the builder takes its bounded slice FIRST and the graph lane
 * may not open that minute. That is a deliberate yield, not an oversight: the
 * graph lane is busy precisely because nothing is prepared, and the builder
 * goes idle by itself once coverage is complete. This reserve is the ordinary
 * delivery and retirement headroom the pass needs whatever else happens. */
const GRAPH_DAY_PROJECTION_OPEN_RESERVE=100;
/** The long pass, while coverage is incomplete. The budget stopped binding once
 * the slot was funded: a day costs about six source statements but each read
 * takes roughly a second, so an eight-second slice one minute in five runs the
 * job at a ~1.6% duty cycle — over a day for ~270 days of about six seconds
 * each. The eight-minute graph-only pass is the only window with real clock in
 * it. Six of those eight minutes at ~6s per day is ~60 days of clock, and the
 * statement half admits 32, so a long pass prepares about 32 days and the whole
 * backlog takes ~9 of them, roughly ninety minutes. The graph lane keeps the
 * remaining two minutes, and when the selection finds no candidates this costs
 * one statement and the long pass is exactly what it is today. */
const GRAPH_DAY_PROJECTION_LONG_SLICE_MS=6*60_000;
const GRAPH_DAY_PROJECTION_LONG_QUERIES=780,GRAPH_DAY_PROJECTION_LONG_DAYS=32;
/** The lane's allowance covers BOTH databases. The build reads the source,
 * which the lane's own sub-meter does not wrap, so half the carve-out is
 * reserved for it explicitly; otherwise the build's pages, its snapshot
 * resolution and its fences would be drawn straight from the outer meter and
 * could eat the graph lane's floor on the next step. */
const GRAPH_DAY_PROJECTION_SOURCE_SHARE=2;
/** How often the builder gets the OPENING slice of a pass rather than the
 * leftovers. The daily and graph lanes already alternate by minute so neither
 * starves the other; this is the same rule on a smaller share. Minute 2 of
 * every 5 never lands on the `minute % 10 === 0` graph-only long pass, so that
 * window is untouched, and once coverage is complete the lane finds no
 * candidates and costs a single selection statement. */
const GRAPH_DAY_PROJECTION_OPEN_EVERY=5,GRAPH_DAY_PROJECTION_OPEN_MINUTE=2;
/** The opening slice's own deadline, so a pass that opens with the builder
 * still leaves the graph and daily lanes a usable window. The lane stops
 * cleanly at its own deadline and never half-writes a day. */
const GRAPH_DAY_PROJECTION_OPEN_SLICE_MS=8_000;
/** Days one opening slot may prepare. At a 250-statement allowance the target
 * half (125) affords `floor(124 / 12)` = 10 writes, and the source half (125)
 * affords about 20 days at the measured 5-6 statements each, so the target
 * half is the binding bound rather than a hope. The trailing slot keeps its
 * default of 4. */
const GRAPH_DAY_PROJECTION_OPEN_DAYS=10;
/** Deployment switch for the prepared-graph-day builder. Default OFF: the fold
 * does not read these rows yet, so building them must be an explicit operator
 * decision and not a consequence of deploying this code. The pass option is the
 * second, independent gate. */
export function graphDayProjectionBuildEnabled(env:unknown):boolean{
 if(!env||typeof env!=='object')return false;
 return Reflect.get(env,'GRAPH_DAY_PROJECTION_BUILD')==='enabled';
}
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
 graphFailure?:StorageGraphFailureFields;
 /** The prepared-day builder, closed and content-free. Absent means the lane is
  * switched off. Present with `opened:false` means it was switched on but never
  * admitted; `candidates` with no `built` and no `refused` means it selected
  * days and could not prepare any of them. One line of log then says which. */
 graphDayProjection?:StorageGraphDayProjectionFields;
 reason:'complete'|'step_limit'|'deadline'|'query_budget'|'capacity'|'format_boundary';
}
export interface StorageGraphDayProjectionFields {
 opened:boolean;slot:'opening'|'trailing'|'long';sliceMs:number|null;elapsedMs:number;
 built:number;refused:number;skipped:number;candidates:number;
 sourceQueriesUsed:number;state:'idle'|'progress'|'deferred'|'failed';
 reason:'complete'|'deadline'|'query_budget'|'day_limit'|'not_admitted'|'lane_failure';
}
export interface StorageAnalyticsCatchupMetrics {
 decodedBytes:number;sourceReadMs:number;foldMs:number;sourceRecheckMs:number;targetWriteMs:number;pageDurationMs:number;
}
/** Runs in an independent scheduled invocation. The actual query meter is
 * shared by BOTH databases; a batch counts all statements. A failed calculation
 * cannot participate in, roll back or delay an upload transaction. */
export async function runStorageAnalyticsPass(options:StorageAnalyticsBindings&{
 maxSteps?:number;deadlineMs?:number;maxQueries?:number;signal?:AbortSignal;
 publishCommunity?:boolean;publicOnly?:boolean;
  ledger?:D1Database;skipV1PrefixProbe?:boolean;
 /** Public lane order. The daily and graph lanes each need most of one
  * scheduled window when both have work, so passes alternate which lane opens
  * by wall-clock minute unless the caller pins the order. */
 graphLaneFirst?:boolean;
 /** Long-window graph-only pass. A separate, less frequent schedule gives one
  * owner-day claim a window many times the minute pass, so the kernel can
  * advance many groups under a single claim. Ordered delivery, erasure, the
  * admin snapshot, the bounded retirement pages and the daily lane stay on the
  * minute schedule; the lane order is then irrelevant. */
 graphOnly?:boolean;
 /** Graph claim lease. The caller sets it above this pass's own deadline so a
  * concurrent scheduled pass sees the owner-day as busy for the whole window. */
 graphLeaseMs?:number;
 /** Prepared-graph-day builder lane. BOTH gates must be open: the deployment
  * switch (`graphDayProjectionBuildEnabled`) and this pass option, which also
  * carries the day builder. With either absent the lane opens no statement. */
 buildGraphDayProjections?:boolean;
 graphDayProjectionBuild?:GraphDayProjectionBuild;
 graphDayProjectionFromDay?:string;
 /** Fold prepared days in the GRAPH lane instead of paging the source, when
  * the store holds every day of a window. Independent of the builder switch:
  * building is what fills the store, folding is what reads it, and the two are
  * deployed and reverted separately. Absent means the kernel default, off. */
 foldGraphDayProjections?:boolean;
 /** Pin the builder's opening slot instead of selecting it by wall-clock
  * minute. Tests use it; production lets the minute decide. */
 projectionLaneFirst?:boolean;
 /** Let the builder take the bulk of the graph-only long pass while coverage is
  * incomplete. Its own switch, revertible independently of the builder and the
  * fold, and self-limiting: an empty selection costs one statement. */
 graphDayProjectionLongPass?:boolean;
}):Promise<StorageAnalyticsPass> {
 const maxSteps=options.maxSteps??8,deadlineMs=options.deadlineMs??Date.now()+20_000;
 if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>32||!Number.isFinite(deadlineMs)
   ||(options.publicOnly!==undefined&&typeof options.publicOnly!=='boolean')
   ||(options.publicOnly===true&&options.publishCommunity!==true)
   ||(options.graphLaneFirst!==undefined&&typeof options.graphLaneFirst!=='boolean')
   ||(options.graphOnly!==undefined&&typeof options.graphOnly!=='boolean')
   // A graph-only pass publishes community results and opens no ordered
   // journal step; any other combination is a caller contract error.
   ||(options.graphOnly===true&&(options.publishCommunity!==true||options.publicOnly!==true))
   // A claim is recoverable only by lease expiry. It must outlive this pass's
   // own window, or a second claimant forks the same checkpoint key while this
   // one is still writing; and it must stay inside one cron invocation's
   // wall clock, or an abandoned claim wedges that owner-day for longer than a
   // scheduled attempt can recover it.
   ||(options.graphLeaseMs!==undefined&&(!Number.isSafeInteger(options.graphLeaseMs)||options.graphLeaseMs<60_000
    ||options.graphLeaseMs>15*60_000||options.graphLeaseMs<=deadlineMs-Date.now()))
   ||(options.skipV1PrefixProbe!==undefined&&typeof options.skipV1PrefixProbe!=='boolean')
   ||(options.buildGraphDayProjections!==undefined&&typeof options.buildGraphDayProjections!=='boolean')
   ||(options.graphDayProjectionBuild!==undefined&&typeof options.graphDayProjectionBuild!=='function')
   ||(options.graphDayProjectionFromDay!==undefined&&typeof options.graphDayProjectionFromDay!=='string')
   ||(options.foldGraphDayProjections!==undefined&&typeof options.foldGraphDayProjections!=='boolean')
   ||(options.projectionLaneFirst!==undefined&&typeof options.projectionLaneFirst!=='boolean')
   ||(options.graphDayProjectionLongPass!==undefined&&typeof options.graphDayProjectionLongPass!=='boolean'))throw invalid();
 const graphLaneFirst=options.graphLaneFirst??Math.floor(Date.now()/60_000)%2===1;
 const projectionLaneFirst=options.projectionLaneFirst
  ??Math.floor(Date.now()/60_000)%GRAPH_DAY_PROJECTION_OPEN_EVERY===GRAPH_DAY_PROJECTION_OPEN_MINUTE;
 const graphAdmission=options.graphOnly?GRAPH_ONLY_ADMISSION_QUERIES:GRAPH_LANE_ADMISSION_QUERIES;
 const meter=createD1InvocationBudget(options.maxQueries??900);
 const scoped={...options,source:meter.wrap(options.source),target:meter.wrap(options.target)};
 let steps=0,recordsRead=0,dailyPublications=0,graphCalculations=0,graphFailure:StorageGraphFailureFields|undefined;
 let graphDayProjection:StorageGraphDayProjectionFields|undefined;
 const result=(state:StorageAnalyticsPass['state'],reason:StorageAnalyticsPass['reason']):StorageAnalyticsPass=>
  ({state,reason,steps,recordsRead,queriesUsed:meter.queriesUsed,dailyPublications,graphCalculations,
   ...(graphFailure?{graphFailure}:{}),...(graphDayProjection?{graphDayProjection}:{})});
 // A graph-only pass has exactly one lane, and an exhausted lane reports itself
 // idle for the rest of the pass. Without this, a window that ended with its
 // owner-day still unfinished would report an idle cohort or ordinary progress
 // and read as "nothing to do" in the scheduler log while the same selection
 // keeps failing. The minute pass keeps its existing lane semantics.
 const graphOnlyStalled=():boolean=>options.graphOnly===true&&graphFailure!==undefined;
 try {
  if(Date.now()>=deadlineMs)return result('deferred','deadline');
  // Privacy cleanup is independent of publication and capacity admission for
  // new analytical work. The same invocation meter covers all three databases.
  // A graph-only pass runs beside the minute schedule, which keeps advancing
  // erasure every minute. Leave that cleanup there rather than spending this
  // window's meter on it twice.
  if(options.ledger&&!options.graphOnly)await advanceStorageErasureJobs({...scoped,ledger:meter.wrap(options.ledger)},{maxJobs:1});
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
   await retireGraphDayProjectionPage(scoped.target,options.sourceId);
   await retireStorageCommunityDailyPage(scoped);
   await retireStorageCommunityGraphPublications(scoped);
   return result('deferred','capacity');
  }
  // Restore the owner dashboard even while the ordered analytics journal is
  // catching up. This optional phase has its own hard 40-query sub-budget and
  // leaves 100 queries for mandatory delivery. Its source readers are also
  // capped by row count, so failure preserves the prior cache and cannot turn
  // missing evidence into zero.
  // The scheduler's second phase is intentionally public-only: the bounded
  // delivery phase already had this opportunity and public work must retain
  // its graph admission budget while an ordered source backlog remains.
  if(!options.publicOnly&&meter.remainingQueries>=140&&deadlineMs-Date.now()>=5_000){
   const adminMeter=createD1InvocationBudget(40);
   const adminScoped={...scoped,source:adminMeter.wrap(scoped.source),target:adminMeter.wrap(scoped.target)};
   const snapshot=await captureStorageAdminMetricSnapshot(adminScoped,Date.now());
   if(snapshot.code!=='SNAPSHOT_UNAVAILABLE'&&adminMeter.remainingQueries>0&&Date.now()<deadlineMs) {
    await warmStorageAdminMetricsHistoryCache(adminScoped,Date.now());
   }
  }
  // Completed current fits can arrive at the deadline of an earlier invocation.
  // Give them one cheap publication chance before another graph calculation.
  // The aggregate hint is advisory; the existing publisher repeats the full
  // cohort, payload, source and privacy-authority validation before any write.
  // A lane's application failure is recorded with its closed stage and the
  // pass continues with the other lanes. Budget and deadline exhaustion keep
  // their deferred semantics, so one failing owner-day or one malformed row
  // can no longer stall daily activity and graph work for every minute.
  let graphExhausted=false,projectionExhausted=false;
  const laneFailure=(stage:'daily_publish'|'graph_work',error:unknown):void=>{
   if(error instanceof D1InvocationBudgetExceededError||error instanceof V11ProjectionDeadlineExceededError)throw error;
   const fields=caughtStorageGraphFailureFields(stage,error);
   graphFailure??=fields;
   // Closed fields plus a one-way token of the wrapped error: enough to match
   // a kernel's static error string offline, never a message or identifier.
   if(fields)console.log(JSON.stringify({event:'storage_analytics_lane_failure',lane:stage,phase:fields.phase,
    reason:fields.reason,detail:storageGraphFailureDetail(error)??null}));
   if(stage==='graph_work')graphExhausted=true;
  };
  // A graph-only pass skips this opportunistic publication: its cost scales
  // with the cohort and could spend the graph lane's admission floor before any
  // calculation starts. The minute pass still runs it every minute, and the
  // graph lane publishes its own preview after a completed calculation.
  if(options.publishCommunity&&!options.graphOnly&&meter.remainingQueries>=253&&deadlineMs-Date.now()>=5_000
    &&(await readCollectionControls(scoped.source)).publication) {
   options.signal?.throwIfAborted();
   try{
    const ready=await storageCommunityGraphPreviewReadyHint(scoped);
    options.signal?.throwIfAborted();
    if(ready&&meter.remainingQueries>=250&&Date.now()<deadlineMs)await publishStorageCommunityGraphPreview(scoped);
   }catch(error){laneFailure('graph_work',error);}
  }
  for(;steps<maxSteps;) {
   options.signal?.throwIfAborted();
   if(Date.now()>=deadlineMs)return result('deferred','deadline');
   // A graph-only pass has no other lane to fall back on: once the shared meter
   // can no longer admit the graph lane's admission floor, stop instead of
   // spending the remaining steps on repeated control reads.
   if(meter.remainingQueries<(options.graphOnly?graphAdmission:100))return result('deferred','query_budget');
   // Publication-paused catch-up can combine a current typed-v1 prefix. The
   // scheduler's public-only phase never opens the ordered journal: its finite
   // steps count public iterations, leaving pending delivery for the next
   // bounded delivery phase instead of consuming the public deadline.
   const page=!options.publicOnly&&!options.publishCommunity&&!options.skipV1PrefixProbe
    ?await advanceStorageAnalyticsV1Page(scoped,Math.min(4,maxSteps-steps)):null;
   const v11Pages=Math.min(5,Math.max(1,1+Math.floor(Math.max(0,meter.remainingQueries-100)/12)));
   const step=options.publicOnly?{state:'idle' as const,recordsRead:0}
    :page&&page.events>0?page:await advanceStorageAnalytics({...scoped,maxV11PhysicalPages:v11Pages,deadlineMs});
   steps+=!options.publicOnly&&page&&page.events>0?page.events:1;recordsRead+=step.recordsRead;
   // Retiring old generations cannot be starved by an always-busy journal. The
   // graph-only pass leaves those bounded pages to the minute schedule, which
   // keeps running them, and gives its whole window to one resumable claim.
   const idlePage={state:'idle' as const};
   const v11=options.graphOnly?idlePage:await retireV11DailyProjectionPage(scoped.target,options.sourceId);
   const v1=options.graphOnly?idlePage:await retireV1DailyProjectionPage(scoped.target,options.sourceId);
   const retiredGraph=options.graphOnly?idlePage:await retireStorageGraphPage(scoped.target,options.sourceId);
   // The prepared-graph-day sweep costs statements in the hot loop, so it runs
   // only where its rows can exist: with the builder lane switched on. The two
   // paths that must never depend on that switch keep it unconditional —
   // owner erasure, which is a privacy guarantee, and the capacity branch,
   // which must be able to reclaim space whatever the lane is doing.
   // The long-pass build is the one case where the lane runs in a graph-only
   // pass. The bounded retirement sweep stays off there, as before.
   const longPassBuild=options.graphOnly===true&&options.graphDayProjectionLongPass===true
    &&options.buildGraphDayProjections===true;
   const projectionLane=options.buildGraphDayProjections===true&&(!options.graphOnly||longPassBuild);
   const retiredProjection=projectionLane&&!options.graphOnly
    ?await retireGraphDayProjectionPage(scoped.target,options.sourceId):idlePage;
   let publicIdle=true,graphRan=false;
   let projectionIdle=true,projectionRan=false;
   const runProjectionLane=async(slot:'opening'|'trailing'|'long'):Promise<void>=>{
    const sliceMs=slot==='trailing'?null
     :slot==='long'?GRAPH_DAY_PROJECTION_LONG_SLICE_MS:GRAPH_DAY_PROJECTION_OPEN_SLICE_MS;
    const build=options.graphDayProjectionBuild;
    if(!(projectionLane&&build&&!projectionExhausted&&!projectionRan&&Date.now()<deadlineMs))return;
    projectionRan=true;
    const opening=sliceMs!==null;
    const startedMs=Date.now();
    // The trailing slot still reserves the graph lane's whole admission floor.
    // The opening slot reserves only the pass's ordinary headroom, which is the
    // explicit trade above: at most `GRAPH_DAY_PROJECTION_OPEN_QUERIES` and one
    // 8-second slice, one minute in five.
    const floor=slot==='long'?GRAPH_ONLY_ADMISSION_QUERIES
     :opening?GRAPH_DAY_PROJECTION_OPEN_RESERVE
     :(graphRan?0:GRAPH_LANE_ADMISSION_QUERIES)+100;
    const allowance=Math.min(slot==='long'?GRAPH_DAY_PROJECTION_LONG_QUERIES
      :opening?GRAPH_DAY_PROJECTION_OPEN_QUERIES:GRAPH_DAY_PROJECTION_LANE_QUERIES,
     Math.max(0,meter.remainingQueries-floor));
    // Both halves bind: a day costs `4 + maxWrites` target statements to write
    // and one reader scope, its pages and two fences to read. An even split
    // keeps either from being the reason the other cannot finish a day.
    const targetQueries=allowance-Math.floor(allowance/GRAPH_DAY_PROJECTION_SOURCE_SHARE);
    const sourceQueries=allowance-targetQueries;
    // An opening slice needs enough window to be worth taking AND must leave
    // the rest to the other lanes; a trailing run takes whatever is left.
    // The opening slot must leave the rest of a minute pass to the other lanes,
    // so it asks for its whole slice plus their margin. The long slot is meant
    // to take the bulk of its window, so it asks only to be worth starting; its
    // own deadline below still caps it at the slice and never overruns the
    // pass, which leaves the graph lane the remainder of the long window.
    const required=slot==='long'||sliceMs===null?5_000:sliceMs+5_000;
    const laneDeadline=sliceMs===null?deadlineMs:Math.min(deadlineMs,Date.now()+sliceMs);
    if(targetQueries>=8&&sourceQueries>=8&&deadlineMs-Date.now()>=required){
     const laneMeter=createD1InvocationBudget(targetQueries);
     try{
      const lane=await advanceGraphDayProjectionLane({target:laneMeter.wrap(scoped.target),
       sourceId:options.sourceId,build:build,deadlineMs:laneDeadline,sourceQueries,
       remainingQueries:laneMeter.remainingQueries,
       ...(slot==='long'?{maxDays:GRAPH_DAY_PROJECTION_LONG_DAYS}
        :opening?{maxDays:GRAPH_DAY_PROJECTION_OPEN_DAYS}:{}),
       ...(options.graphDayProjectionFromDay===undefined?{}:{fromDay:options.graphDayProjectionFromDay})});
      projectionIdle=lane.state==='idle';
      // A pass runs several iterations, so the counters ACCUMULATE. Reporting
      // only the last one hides the work: a pass that built its whole selection
      // in the first iteration then reports zero candidates from the second.
      graphDayProjection={opened:true,slot,sliceMs,
       elapsedMs:(graphDayProjection?.elapsedMs??0)+(Date.now()-startedMs),
       built:(graphDayProjection?.built??0)+lane.built,
       refused:(graphDayProjection?.refused??0)+lane.refused,
       skipped:(graphDayProjection?.skipped??0)+lane.skipped,
       candidates:(graphDayProjection?.candidates??0)+lane.candidates,
       sourceQueriesUsed:(graphDayProjection?.sourceQueriesUsed??0)+lane.sourceQueriesUsed,
       state:lane.state,reason:lane.reason};
      // The lane's own meter wraps only the target. The build reads the SOURCE
      // through the composition root's binding, so without this the number that
      // gates the graph lane's 550 floor over-reports by the whole build spend
      // and the outer 900-statement meter can trip inside the graph lane, where
      // a budget error fails the entire schedule.
      if(lane.sourceQueriesUsed>0)meter.reserveQueries=Math.min(meter.reserveQueries+lane.sourceQueriesUsed,
       meter.reserveQueries+Math.max(0,meter.remainingQueries));
     }catch(error){
      if(error instanceof D1InvocationBudgetExceededError||error instanceof V11ProjectionDeadlineExceededError){
       projectionIdle=false;
       graphDayProjection={opened:true,slot,sliceMs,elapsedMs:Date.now()-startedMs,built:0,refused:0,
        skipped:0,candidates:0,sourceQueriesUsed:0,state:'deferred',reason:'query_budget'};
      }else{
       // Isolated exactly like the other lanes: a failing builder records its
       // closed stage, stops for the rest of this pass, and cannot stall
       // delivery, the daily lane or the graph lane.
       projectionExhausted=true;
       graphDayProjection={opened:true,slot,sliceMs,elapsedMs:Date.now()-startedMs,built:0,refused:0,
        skipped:0,candidates:0,sourceQueriesUsed:0,state:'failed',reason:'lane_failure'};
       console.log(JSON.stringify({event:'storage_analytics_lane_failure',lane:'graph_day_projection',
        phase:null,reason:'graph_day_projection_failure',detail:storageGraphFailureDetail(error)??null}));
      }
     }
     // No allowance and no time is not pending work: reporting it as busy would
     // keep an under-budget pass looping until it burned its step limit.
    }else graphDayProjection??={opened:false,slot,sliceMs,elapsedMs:0,built:0,refused:0,skipped:0,
     candidates:0,sourceQueriesUsed:0,state:'deferred',reason:'not_admitted'};
   };
   // On its opening minute the builder takes a bounded slice BEFORE the
   // publication lanes. Running last is what stalled it in production: in
   // steady state the graph lane consumes the whole window, so a lane needing
   // five seconds of remaining clock never opened, and the graph lane stayed
   // slow because nothing built the days that would speed it up.
   if(longPassBuild)await runProjectionLane('long');
   else if(projectionLaneFirst)await runProjectionLane('opening');

   if(options.publishCommunity && meter.remainingQueries>=100 && Date.now()<deadlineMs
     && (await readCollectionControls(scoped.source)).publication) {
    // Recover several already prepared days without consuming the graph's
    // 550-statement admission floor while the graph lane is still to run.
    // Stale published heads receive three of four selection slots while a
    // durable queue exists, and both selectors fall back to the other lane
    // when their preferred lane is empty.
    const runDailyLane=async():Promise<boolean>=>{
     const dailyAllowance=Math.min(90,Math.max(0,meter.remainingQueries-(graphRan?100:560)));
     let dailyIdle=false;
     const dailyTimeRemaining=deadlineMs-Date.now();
     if(dailyAllowance>0&&dailyTimeRemaining>=5_000){
      const dailyMeter=createD1InvocationBudget(dailyAllowance);
      const dailyScoped={...scoped,source:dailyMeter.wrap(scoped.source),target:dailyMeter.wrap(scoped.target)};
      // A normal 20-second direct pass has already spent part of its deadline
      // on setup. Admit one bounded day there; only longer passes batch days.
      const dailyAttempts=dailyTimeRemaining>20_000?4:1;
      const skipDays:string[]=[];
      try{
       for(let attempt=0;attempt<dailyAttempts&&deadlineMs-Date.now()>=(attempt===0?5_000:15_000);attempt++){
        const slot=Math.floor(Date.now()/60_000)+attempt;
        const daily=await advanceNextStorageCommunityDaily({...dailyScoped,preferStaleHead:slot%4!==3,skipDays});
        if(daily.state==='published')dailyPublications++;
        if(daily.state==='idle'){dailyIdle=true;break;}
        // A day waiting on a pending projection or on capacity yields to the
        // next candidate within this pass; one blocked day cannot hold the lane.
        if(daily.state==='deferred'&&daily.reason!=='source_changed')skipDays.push(daily.day);
        if(daily.state==='deferred'&&daily.reason==='source_changed')break;
       }
      }catch(error){
       if(error instanceof D1InvocationBudgetExceededError)dailyIdle=false;
       else laneFailure('daily_publish',error);
      }
     }
     try{await retireStorageCommunityDailyPage(scoped);}catch(error){laneFailure('daily_publish',error);}
     return dailyIdle;
    };
    // A graph attempt that failed or was deferred with a recorded failure has
    // already spent this isolate's memory on one heavy owner-day read. Do not
    // start another heavy calculation in the same invocation; the next
    // scheduled pass retries from its durable checkpoint and selection.
    const runGraphLane=async():Promise<boolean>=>{
     if(!(meter.remainingQueries>=graphAdmission && Date.now()<deadlineMs && !graphExhausted))return graphExhausted;
     graphRan=true;
     let graph:StorageGraphWorkProgress={state:'deferred',reason:'graph_failure'};
     try{
      graph=await advanceStorageCommunityGraphWork({...scoped,remainingQueries:meter.remainingQueries,deadlineMs,
       admissionQueries:graphAdmission,...(options.graphLeaseMs===undefined?{}:{leaseMs:options.graphLeaseMs}),
       ...(options.foldGraphDayProjections===undefined?{}:{preparedFold:options.foldGraphDayProjections})});
      if(graph.failure)graphFailure??=graph.failure;
      if(graph.state==='complete')graphCalculations++;
      if((graph.state==='complete'||graph.state==='reused')&&meter.remainingQueries>=250&&Date.now()<deadlineMs) {
       if(graph.metric==='model'&&graph.day)await publishStorageCommunityModelDay(scoped,{day:graph.day});
       if(meter.remainingQueries>=250&&Date.now()<deadlineMs)await publishStorageCommunityGraphPreview(scoped);
      }
      if(meter.remainingQueries>=30)await retireStorageCommunityGraphPublications(scoped);
     }catch(error){laneFailure('graph_work',error);}
     if(graph.failure||graph.reason==='graph_failure')graphExhausted=true;
     return graph.state==='idle';
    };
    // Both lanes need most of one scheduled window when both have work. The
    // opening lane alternates by minute so a long daily queue cannot starve a
    // resumable graph checkpoint for hours, and vice versa; an idle lane costs
    // a few statements and hands the rest of the window to the other.
    if(options.graphOnly)publicIdle=await runGraphLane();
    else if(graphLaneFirst){const graphIdle=await runGraphLane();const dailyIdle=await runDailyLane();publicIdle=dailyIdle&&graphIdle;}
    else {const dailyIdle=await runDailyLane();const graphIdle=await runGraphLane();publicIdle=dailyIdle&&graphIdle;}
   }
   // The prepared-graph-day builder. It is the last lane on purpose: it prepares
   // reusable input for a fold that is not live yet, so it may only spend what
   // the publication lanes left, may never open in a graph-only long pass, and
   // reserves the graph lane's own admission floor whenever that lane has not
   // already run in this iteration.
   await runProjectionLane('trailing');
   if(step.state==='idle'&&v11.state==='idle'&&v1.state==='idle'&&retiredGraph.state==='idle'
     &&retiredProjection.state==='idle'&&publicIdle&&projectionIdle)
    return graphOnlyStalled()?result('deferred','step_limit'):result('idle','complete');
  }
  return graphOnlyStalled()?result('deferred','step_limit'):result('progress','step_limit');
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
