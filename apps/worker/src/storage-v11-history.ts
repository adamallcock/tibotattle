import { canonicalJson } from './canonical-json';
import { advanceV11UsageReduction,createV11QuotaAcquisitionIdentity,finishV11UsageReduction,
  v11AnalysisWindow,type V11UsageReductionCheckpoint } from './quota-analysis-v11';
import { advanceV11QuotaAcquisition,createV11QuotaAcquisitionCheckpoint,
  type V11CompletedQuotaAcquisition,type V11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionIdentity,type V11QuotaInvocationBudget } from './quota-analysis-v11-reader';
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
 maxQuotaRows?:number}):Promise<StorageV11HistoryResult>{
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
 const prior=input.checkpoint??null;
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
  quotaAcquisition:acquisition};
 if(checkpoint.phase==='usage'&&checkpoint.usage.complete){
  await assertTypedV11GenerationSnapshotLive(source,snapshot);
  return {status:'complete',analysis:await finishV11UsageReduction(source,analysisPin,options,checkpoint.usage,metric,identity)};
 }
 const resumed=checkpoint.phase==='usage',before=budget.remainingQueries;
 const usage=await advanceV11UsageReduction(source,analysisPin,options,budget,
  checkpoint.phase==='usage'?checkpoint.usage:null,maxPages,identity);
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
