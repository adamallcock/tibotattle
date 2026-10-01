import { canonicalJson } from './canonical-json';
import { advanceV11UsageReduction,createV11QuotaAcquisitionIdentity,finishV11UsageReduction,
  foldV11UsageModelReduction,v11AnalysisWindow,type V11UsageReductionCheckpoint } from './quota-analysis-v11';
import { advanceV11QuotaAcquisition,createV11QuotaAcquisitionCheckpoint,foldV11QuotaAcquisition,
  type V11CompletedQuotaAcquisition,type V11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionIdentity,type V11QuotaInvocationBudget } from './quota-analysis-v11-reader';
import { validGraphDayProjection,type GraphDayProjection } from './graph-day-projection-values';
import { readGraphDayProjection,GRAPH_DAY_PROJECTION_MAX_LOAD_PARTS,
  type GraphDayProjectionKey,type GraphDayProjectionLoadCursor } from './graph-day-projection';
import type { V11SourcePin } from './telemetry-v11-domain';
import { assertTypedV11GenerationSnapshotLive,createTypedV11QuotaPageReader,
  loadTypedV11GenerationSnapshot,type V11GenerationSnapshot } from './typed-v11-quota-reader';

export type StorageV11HistoryCheckpoint={version:1;source:'v1.1';day:string;layout:string;
 identity:V11QuotaAcquisitionIdentity;snapshot?:V11GenerationSnapshot}&(
 {phase:'acquisition';acquisition:V11QuotaAcquisitionCheckpoint}|
 {phase:'finish';acquisition:V11CompletedQuotaAcquisition}|
 {phase:'usage';acquisition:V11CompletedQuotaAcquisition;usage:V11UsageReductionCheckpoint});
/** A `cut` deferral consumed fewer source pages than the requested group
 * because the invocation budget or deadline stopped it. It returns no
 * checkpoint: a partial group is not a deterministic successor, and staging one
 * would give every invocation a different generation to abandon. The input
 * checkpoint is advanced in place and must not be reused after a cut.
 *
 * `partialGroup` returns that partial successor instead, and ends an
 * acquisition group at each deterministic sub-phase boundary. It is only safe while the successor's whole save completes
 * in the calling invocation: such a generation is promoted or lost whole, so a
 * pass that reproduces a different successor abandons nothing. A successor
 * needing several save batches must keep the whole-group rule, because
 * resuming its staged parts requires every later pass to reproduce the
 * identical successor, which only a fixed group size and a fixed head can
 * guarantee; the caller checks that before staging. A group that consumed no
 * source page returns a cut even under `partialGroup`: there is no progress to
 * promote. */
export type StorageV11HistoryResult={status:'deferred';checkpoint:StorageV11HistoryCheckpoint|null;cut?:true}|
 {status:'complete';analysis:object};

/** Whether a caller's prepared per-day projections may settle the acquisition
 * instead of paging the owner's window once per sub-phase.
 *
 * OFF. The fold is proven byte-identical against the paged path by the parity
 * oracle, and the acquisition checkpoint method has moved to `-4` so an
 * in-flight `-3` generation cannot be resumed under it — but the prepared-day
 * lane that builds the artifacts is not yet producing them, and the switch is
 * meant to be thrown at the start of a graph-only long pass, not on deploy.
 * Turning this on without prepared days changes nothing: the paged path still
 * serves every group whose caller supplies none. */
export const STORAGE_V11_PREPARED_FOLD=false;

/** The deployment switch, mirroring the builder's `GRAPH_DAY_PROJECTION_BUILD`.
 * Enabling the fold is then a configuration change on a deploy and revertible
 * the same way, rather than a source edit. Unset means off. */
export function storageV11PreparedFoldEnabled(env:unknown):boolean{
 if(!env||typeof env!=='object')return STORAGE_V11_PREPARED_FOLD;
 return Reflect.get(env,'GRAPH_DAY_PROJECTION_FOLD')==='enabled';
}

/** The gate, as a pure rule so it can be proven rather than described: a group
 * folds prepared days only when the caller supplied them AND the switch above
 * is on. Nothing supplies them today, so this is off twice over. */
export function storageV11FoldsPreparedDays(preparedDays:readonly GraphDayProjection[]|undefined,
 enabled:boolean=STORAGE_V11_PREPARED_FOLD):boolean{
 return enabled&&preparedDays!==undefined;
}

/** Whether the model metric runs its usage reduction WITHOUT the scalar half.
 *
 * This is the same function of `(metric, preparedFold)` that
 * `storageGraphV11CheckpointMethod` uses to pick the checkpoint namespace, and
 * it must stay that way: the reducer's scalar-mode fence refuses to resume a
 * successor staged under the other mode, so a key whose mode is not fixed by
 * the key itself is bistable and wedges the lane for good.
 *
 * It deliberately does NOT consult `preparedDays`. Whether a pass actually
 * loaded the prepared artifacts varies per pass — the load returns
 * `incomplete` until the builder has produced that window, and `budget` when
 * the pass is short — so gating the mode on it made one model key stage
 * scalar-on before its days existed and resume scalar-off afterwards. That is
 * the defect this rule exists to remove; a group that has no prepared days
 * still takes the paged reduction, now with the mode its namespace declares.
 *
 * The cost is the one the fold already accepted: under the fold, a model
 * result is measured without the shared `reduced_usage_limit_exceeded` bucket
 * state, so a day that refused under the fold-off corpus can be ready under
 * the fold-on one. Flipping the switch already does that; what this removes is
 * the corpus being heterogeneous WITHIN a single fold setting. */
export function storageV11ModelDropsScalar(metric:'fits'|'model',
 preparedFold:boolean=STORAGE_V11_PREPARED_FOLD):boolean{
 return metric==='model'&&preparedFold;
}

/** Whether a staged usage reduction may be resumed by a claim running
 * `scalarRequested`.
 *
 * The reducer fails closed on a mode it did not stage, so the caller has to
 * decide first. A successor whose mode disagrees is not corrupt and not a
 * conflict to resolve: it is derived state built under a rule that has since
 * changed, and the only way past it is to drop it and re-acquire. Returning
 * `false` is therefore a decision to redo work, never to publish anything the
 * evidence did not support. */
export function storageV11UsageSuccessorResumable(
 staged:V11UsageReductionCheckpoint|null|undefined,scalarRequested:boolean):boolean{
 return staged!==null&&staged!==undefined&&staged.scalarReduced===scalarRequested;
}

/** Statements one prepared-day read costs: the head row, then one per page
 * call. A day's artifact is a handful of kilobytes, so it is one page call in
 * practice and this is the measured bound rather than an estimate. */
export const STORAGE_V11_PREPARED_DAY_QUERIES=2;
/** Reserve left for the group and its promotion after the load. A load that
 * cannot finish inside it defers to the paged path rather than half-reading. */
export const STORAGE_V11_PREPARED_LOAD_RESERVE=120;

export type StorageV11PreparedDayLoad=
 {status:'ready';days:readonly GraphDayProjection[];statements:number}|
 /** `incomplete` is the safety case: the store does not hold every day this
  * window expects, so the caller MUST take the paged path. Folding a partial
  * set publishes a smaller, complete-looking result under an unchanged result
  * identity, and the fold refuses rather than falling back, so the refusal
  * itself would be published. The kernel's coverage assertion stays a
  * fail-closed backstop; this is the decision. */
 {status:'incomplete'|'budget'|'off';days:undefined;statements:number};

/** Load every prepared day this window expects, or nothing.
 *
 * `enabled` defaults to the deployment flag; it is a parameter so the rule can
 * be exercised without the flag being on. */
export async function loadStorageV11PreparedDays(input:{source:D1Database;target:D1Database;
 sourceId:string;sourceNamespace:string;ownerDigest:string;snapshot:V11GenerationSnapshot;
 sourcePin:V11SourcePin;nowMs:number;
 budget:{remainingQueries:number;deadlineMs:number;now?:()=>number};
 enabled?:boolean}):Promise<StorageV11PreparedDayLoad>{
 if(!(input.enabled??STORAGE_V11_PREPARED_FOLD))return {status:'off',days:undefined,statements:0};
 const now=input.budget.now??Date.now;
 const analysisPin=pinForSnapshot(input.snapshot,input.sourcePin);
 const window=v11AnalysisWindow(analysisPin,input.nowMs);
 if(Date.parse(window.end)<=Date.parse(window.start))return {status:'off',days:undefined,statements:0};
 if(input.budget.remainingQueries<STORAGE_V11_PREPARED_LOAD_RESERVE||now()>=input.budget.deadlineMs){
  return {status:'budget',days:undefined,statements:0};
 }
 const manifests=await v11WindowDayManifests(input.source,input.snapshot,window);
 let statements=1;
 const days:GraphDayProjection[]=[];
 for(const manifest of manifests){
  const key:GraphDayProjectionKey={sourceId:input.sourceId,sourceLayout:'typed-v11',
   sourceNamespace:input.sourceNamespace,ownerDigest:input.ownerDigest,deviceId:manifest.deviceId,
   manifestId:manifest.manifestId,manifestDigest:manifest.manifestDigest,day:manifest.day};
  let cursor:GraphDayProjectionLoadCursor|undefined;
  for(;;){
   if(input.budget.remainingQueries-statements<STORAGE_V11_PREPARED_LOAD_RESERVE||now()>=input.budget.deadlineMs){
    return {status:'budget',days:undefined,statements};
   }
   const read=await readGraphDayProjection({target:input.target,key,cursor,
    maxParts:GRAPH_DAY_PROJECTION_MAX_LOAD_PARTS});
   statements+=1;
   if(read.status==='absent')return {status:'incomplete',days:undefined,statements};
   if(read.status==='ready'){
    if(!validGraphDayProjection(read.projection))throw fail();
    days.push(read.projection);
    break;
   }
   cursor=read.cursor;
  }
 }
 return {status:'ready',days,statements};
}

/** The generation's own observed days inside this analysis window, which is
 * the exact day set a prepared fold must be given. Derived from the same
 * immutable snapshot the acquisition reads, so a lane that has not finished
 * building, or a day the builder refused, is a missing day here rather than a
 * silently smaller result. */
async function v11WindowDayManifests(source:D1Database,snapshot:V11GenerationSnapshot,
 window:{start:string;end:string}):Promise<Array<{day:string;deviceId:string;manifestId:string;manifestDigest:string}>>{
 const rows=(await source.prepare(`SELECT d.observed_day,m.id,m.manifest_digest,m.device_id
  FROM telemetry_v11_domain_days d JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
  WHERE d.generation_id=? AND d.observed_day>=? AND d.observed_day<? ORDER BY d.observed_day LIMIT 103`)
  .bind(snapshot.generationId,window.start.slice(0,10),window.end.slice(0,10))
  .all<{observed_day:string;id:string;manifest_digest:string;device_id:string}>()).results;
 if(rows.length>102)throw fail();
 return rows.map(row=>({day:row.observed_day,deviceId:row.device_id,
  manifestId:String(row.id),manifestDigest:row.manifest_digest}));
}
async function v11WindowDays(source:D1Database,snapshot:V11GenerationSnapshot,
 window:{start:string;end:string}):Promise<string[]>{
 return (await v11WindowDayManifests(source,snapshot,window)).map(row=>row.day);
}

const fail=()=>new Error('STORAGE_V11_HISTORY_CHECKPOINT_MISMATCH');
function sameIdentity(left:V11QuotaAcquisitionIdentity,right:V11QuotaAcquisitionIdentity):boolean{
 return canonicalJson(left)===canonicalJson(right);
}
function pinForSnapshot(snapshot:V11GenerationSnapshot,current:V11SourcePin):V11SourcePin{
 if(snapshot.sourceNamespace.length<1||snapshot.participantId!==current.participantId)throw fail();
 return {source:'v1.1',participantId:snapshot.participantId,generationId:snapshot.generationId,
  fromDay:snapshot.fromDay,throughDay:snapshot.throughDay,inputRevision:snapshot.inputRevision,
  mutationEpoch:current.mutationEpoch,fingerprint:snapshot.fingerprint};
}

/** One bounded source-only v1.1 quota-page group. The graph caller durably
 * promotes the returned deterministic checkpoint before requesting another group. The
 * maintained finisher retains its own final source-pin check; graph result
 * promotion still performs the independent source/privacy fence. */
export async function advanceStorageV11Analysis(input:{source:D1Database;sourceNamespace:string;
 participantId:string;day:string;metric:'fits'|'model';nowMs:number;sourcePin:V11SourcePin;
 generationSnapshot?:V11GenerationSnapshot;
 closedDependencyDigest:string;
 budget:V11QuotaInvocationBudget;checkpoint?:StorageV11HistoryCheckpoint|null;maxPages?:number;
 /** Stage the partial successor of a budget- or deadline-cut group instead of
  * discarding it. Only for callers that promote a single-batch successor. */
 partialGroup?:boolean;
 /** Kernel downsampled-quota bound; part of the acquisition identity. Tests
  * lower it to reach the refusal path; production keeps the kernel default. */
 maxQuotaRows?:number;
 /** The window's prepared per-day projections, in ascending day order. Honoured
  * only while `STORAGE_V11_PREPARED_FOLD` is on; otherwise the paged
  * acquisition serves exactly as before. */
 preparedDays?:readonly GraphDayProjection[];
 /** Whether this call may fold the prepared days it was given. Absent means
  * the module constant, so every existing caller and test is unchanged; the
  * composition root passes the deployment switch. */
 preparedFold?:boolean}):Promise<StorageV11HistoryResult>{
 const {source,sourceNamespace,participantId,day,metric,nowMs,budget}=input,sourcePin=structuredClone(input.sourcePin);
 if(sourcePin.source!=='v1.1'||sourcePin.participantId!==participantId
  ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)||new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10)!==day
  ||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0
  ||!Number.isFinite(budget.deadlineMs))throw fail();
 if(!/^[0-9a-f]{64}$/.test(input.closedDependencyDigest))throw fail();
 if(input.maxPages!==undefined&&(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>1024))throw fail();
 if(input.partialGroup!==undefined&&typeof input.partialGroup!=='boolean')throw fail();
 const partialGroup=input.partialGroup===true;
 // The acquisition advances the given checkpoint in place: a defensive deep
 // copy of a 60,000-row acquisition can exhaust the isolate on its own. The
 // caller treats the input as consumed; a cut group returns no checkpoint.
 const prior=input.checkpoint??null,preparedDays=input.preparedDays;
 if(input.preparedFold!==undefined&&typeof input.preparedFold!=='boolean')throw fail();
 const preparedFold=input.preparedFold??STORAGE_V11_PREPARED_FOLD;
 const layout=`typed-v11:${sourceNamespace}`;
 if(prior&&(prior.version!==1||prior.source!=='v1.1'||prior.day!==day||prior.layout!==layout
  ||!['acquisition','finish','usage'].includes(prior.phase)))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 // Reader scope1 + source pre/post2 + successor checks are fixed per group.
 // Preserve a bounded local reserve before starting a group; the outer D1 meter remains
 // the actual statement authority.
 if(budget.remainingQueries<8||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null,cut:true};
 budget.remainingQueries-=7;
 const maxPages=input.maxPages??1;
 const snapshot=prior?.snapshot??input.generationSnapshot
  ??await loadTypedV11GenerationSnapshot(source,{sourceNamespace,pin:sourcePin});
 await assertTypedV11GenerationSnapshotLive(source,snapshot);
 const analysisPin=pinForSnapshot(snapshot,sourcePin),liveIdentity=createV11QuotaAcquisitionIdentity(analysisPin,nowMs,input.maxQuotaRows),
  identity={...liveIdentity,inputFingerprint:input.closedDependencyDigest};
 if(prior&&!sameIdentity(prior.identity,identity))throw fail();
 let checkpoint:StorageV11HistoryCheckpoint=prior??{version:1,source:'v1.1',day,layout,identity,snapshot,
  phase:'acquisition',acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
 if(checkpoint.phase==='acquisition'){
  const window=v11AnalysisWindow(analysisPin,nowMs);
  // A historical day can precede this exact v1.1 domain. Preserve the same
  // empty-window result as the maintained reducer without issuing an invalid
  // physical range query; the empty completed evidence remains identity-bound
  // and is durably promoted before the finisher runs.
  if(Date.parse(window.end)<=Date.parse(window.start)){
   await assertTypedV11GenerationSnapshotLive(source,snapshot);
   return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,snapshot,phase:'finish',
    acquisition:{identity,planAnchors:[],quotaRows:[]}}};
  }
  if(storageV11FoldsPreparedDays(preparedDays,preparedFold)&&preparedDays!==undefined){
   // A prepared fold reads no source page, so the whole window is settled in
   // one step. The days are still fenced by the same live-generation proof the
   // paged path takes, and every day must be inside this analysis window and
   // structurally valid before the kernel sees it.
   if(preparedDays.length>102||!preparedDays.every(prepared=>validGraphDayProjection(prepared)
    &&prepared.day>=window.start.slice(0,10)&&`${prepared.day}T00:00:00.000Z`<window.end))throw fail();
   const folded=foldV11QuotaAcquisition(identity,preparedDays,
    await v11WindowDays(source,snapshot,window));
   await assertTypedV11GenerationSnapshotLive(source,snapshot);
   if(folded.status==='not_testable')return {status:'complete',analysis:metric==='model'
    ?{status:'not_testable',reason:folded.reason,tracks:[]}
    :{schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:folded.reason,tracks:[]}};
   if(folded.status!=='complete')throw fail();
   return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,snapshot,phase:'finish',
    acquisition:{identity:folded.identity,planAnchors:folded.planAnchors,quotaRows:folded.quotaRows}}};
  }
  const reader=await createTypedV11QuotaPageReader(source,{sourceNamespace,snapshot,fenceSnapshotPages:false,
   fromObservedAtMs:Date.parse(window.start),beforeObservedAtMs:Date.parse(window.end)});
  const before=budget.remainingQueries;
  // A staged partial successor stops on each sub-phase boundary: a boundary
  // successor is compact, while one cut mid-sub-phase carries that sub-phase's
  // whole accumulated state and can reach hundreds of parts.
  const result=await advanceV11QuotaAcquisition(reader,identity,budget,checkpoint.acquisition,
   {maxPages,...(partialGroup?{stopAtPhaseBoundary:true}:{})});
  await assertTypedV11GenerationSnapshotLive(source,snapshot);
  // The acquisition reads one physical page per statement and only defers
  // when the budget, the deadline or the page bound stops it, so fewer than
  // `maxPages` pages means a budget cut rather than a natural group boundary.
  if(result.status==='deferred'){
   const pages=before-budget.remainingQueries,successor:StorageV11HistoryResult={status:'deferred',
    checkpoint:{...checkpoint,snapshot,acquisition:result.checkpoint}};
   return pages<maxPages&&!(partialGroup&&pages>0)?{status:'deferred',checkpoint:null,cut:true}:successor;
  }
  // A refused acquisition is a complete, publishable result in the shape the
  // metric's maintained finisher would return: the bare composition refusal
  // for the model history, the scalar analysis refusal for fits. The cached
  // composition validator rejects any other keys, so the fits shape must not
  // leak into a model result.
  if(result.status==='not_testable')return {status:'complete',analysis:metric==='model'
   ?{status:'not_testable',reason:result.reason,tracks:[]}
   :{schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:result.reason,tracks:[]}};
  checkpoint={version:1,source:'v1.1',day,layout,identity,snapshot,phase:'finish',
   acquisition:{identity:result.identity,planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
  return {status:'deferred',checkpoint};
 }
 // The durable acquisition is identified by the exact selected historical
 // manifest vector, so a new domain generation outside this closed window can
 // reuse it. The maintained finisher still accepts only a live-pin identity;
 // rebind after the current-pin assertion above, without changing evidence.
 // The kernel rebuilds the acquisition identity from its own bound, so a
 // lowered bound has to reach the finisher too or the completed evidence is
 // rejected as belonging to a different acquisition.
 const acquisition={...checkpoint.acquisition,identity:liveIdentity},options={nowMs,sourcePin:analysisPin,
  typedSourceNamespace:sourceNamespace,generationSnapshot:snapshot,generationSnapshotFenced:true,
  ...(input.maxQuotaRows!==undefined?{maxDownsampledQuotaRows:input.maxQuotaRows}:{}),
  // The model metric needs no scalar fit half, and that half is where a v1.1
  // usage checkpoint's bytes are. The two metrics therefore no longer share a
  // reduction, which is why they no longer share a checkpoint namespace.
  //
  // Gated on the fold ALONE, so that this is the same function of the metric
  // and the switch that picks the namespace. See `storageV11ModelDropsScalar`.
  // With the fold off the paged reduction is byte-unchanged.
  scalarRequested:!storageV11ModelDropsScalar(metric,preparedFold),
  quotaAcquisition:acquisition};
 // A staged usage reduction carries the scalar mode it was built under, and
 // the reducer fails closed rather than resume one built under the other. A
 // key whose mode was not fixed by the key itself could hold such a
 // successor — model keys staged before `storageV11ModelDropsScalar` existed
 // did, whenever the prepared days had not been built yet — and every later
 // pass then threw on the same row for good, with nothing able to clear it.
 //
 // The reduction is derived state that any pass can rebuild, so a mode that
 // disagrees discards it and re-acquires from the phase start. That costs the
 // pages already spent once; a wedged key costs the lane forever. The fence
 // inside the reducer stays as the backstop for a mode changing mid-group.
 const stagedUsage=checkpoint.phase==='usage'?checkpoint.usage:null;
 const usagePrior=storageV11UsageSuccessorResumable(stagedUsage,options.scalarRequested!==false)
  ?stagedUsage:null;
 if(usagePrior!==null&&usagePrior.complete){
  await assertTypedV11GenerationSnapshotLive(source,snapshot);
  return {status:'complete',analysis:await finishV11UsageReduction(source,analysisPin,options,usagePrior,metric,identity)};
 }
 // Gated on there being no RESUMABLE reduction rather than on the phase: a
 // staged successor this pass had to discard leaves the phase at `usage` with
 // nothing to continue, and re-paging a hundred-day window is exactly the work
 // the prepared days settle in one step.
 if(storageV11FoldsPreparedDays(preparedDays,preparedFold)&&preparedDays!==undefined&&metric==='model'
  &&usagePrior===null){
  // The model composition needs no scalar half and no usage row: the prepared
  // days carry exact 2-hour cells, the sessions that cross midnight and the
  // openers whose account break only carry-in can decide. The day set is the
  // generation's own, so a window with a day still unbuilt refuses here rather
  // than folding to a smaller composition.
  const usageWindow=v11AnalysisWindow(analysisPin,nowMs);
  const usage=await foldV11UsageModelReduction(source,analysisPin,options,preparedDays,
   await v11WindowDays(source,snapshot,usageWindow),identity);
  await assertTypedV11GenerationSnapshotLive(source,snapshot);
  return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,snapshot,phase:'usage',
   acquisition:checkpoint.acquisition,usage}};
 }
 // `resumed` follows the checkpoint actually handed to the reducer, not the
 // phase: a discarded successor spends the initialization statement again and
 // the cut accounting below has to reserve it, or a fresh reduction reads as a
 // budget cut and the group is thrown away every pass.
 const resumed=usagePrior!==null,before=budget.remainingQueries;
 const usage=await advanceV11UsageReduction(source,analysisPin,options,budget,
  usagePrior,maxPages,identity);
 await assertTypedV11GenerationSnapshotLive(source,snapshot);
 // The reducer spends one statement to initialize a fresh reduction and one
 // per day page; an incomplete reduction that read fewer than `maxPages` pages
 // was cut by the budget or deadline, not by the end of its selected days. A
 // fresh reduction that only selected its days still advanced the checkpoint.
 const usagePages=before-budget.remainingQueries-(resumed?0:1);
 if(!usage.complete&&usagePages<maxPages&&!(partialGroup&&(usagePages>0||!resumed)))
  return {status:'deferred',checkpoint:null,cut:true};
 return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,snapshot,phase:'usage',
  acquisition:checkpoint.acquisition,usage}};
}
