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
 * because the invocation budget or deadline stopped it. It returns the prior
 * checkpoint unchanged: a partial group is not a deterministic successor, and
 * staging one would give every invocation a different generation to abandon. */
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
 budget:V11QuotaInvocationBudget;checkpoint?:StorageV11HistoryCheckpoint|null;maxPages?:number}):Promise<StorageV11HistoryResult>{
 const {source,sourceNamespace,participantId,day,metric,nowMs,budget}=input,sourcePin=structuredClone(input.sourcePin);
 if(sourcePin.source!=='v1.1'||sourcePin.participantId!==participantId
  ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)||new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10)!==day
  ||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0
  ||!Number.isFinite(budget.deadlineMs))throw fail();
 if(!/^[0-9a-f]{64}$/.test(input.closedDependencyDigest))throw fail();
 if(input.maxPages!==undefined&&(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>32))throw fail();
 const prior=input.checkpoint?structuredClone(input.checkpoint):null;
 const layout=`typed-v11:${sourceNamespace}`;
 if(prior&&(prior.version!==1||prior.source!=='v1.1'||prior.day!==day||prior.layout!==layout
  ||!['acquisition','finish','usage'].includes(prior.phase)))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 // Reader scope1 + source pre/post2 + successor checks are fixed per group.
 // Preserve a bounded local reserve before starting a group; the outer D1 meter remains
 // the actual statement authority.
 if(budget.remainingQueries<8||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:prior,cut:true};
 budget.remainingQueries-=7;
 const maxPages=input.maxPages??1;
 const snapshot=prior?.snapshot??input.generationSnapshot
  ??await loadTypedV11GenerationSnapshot(source,{sourceNamespace,pin:sourcePin});
 await assertTypedV11GenerationSnapshotLive(source,snapshot);
 const analysisPin=pinForSnapshot(snapshot,sourcePin),liveIdentity=createV11QuotaAcquisitionIdentity(analysisPin,nowMs),
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
  const result=await advanceV11QuotaAcquisition(reader,identity,budget,checkpoint.acquisition,{maxPages});
  await assertTypedV11GenerationSnapshotLive(source,snapshot);
  // The acquisition reads one physical page per statement and only defers
  // when the budget, the deadline or the page bound stops it, so fewer than
  // `maxPages` pages means a budget cut rather than a natural group boundary.
  if(result.status==='deferred')return before-budget.remainingQueries<maxPages?{status:'deferred',checkpoint:prior,cut:true}
   :{status:'deferred',checkpoint:{...checkpoint,snapshot,acquisition:result.checkpoint}};
  if(result.status==='not_testable')return {status:'complete',analysis:{
   schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:result.reason,tracks:[]}};
  checkpoint={version:1,source:'v1.1',day,layout,identity,snapshot,phase:'finish',
   acquisition:{identity:result.identity,planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
  return {status:'deferred',checkpoint};
 }
 // The durable acquisition is identified by the exact selected historical
 // manifest vector, so a new domain generation outside this closed window can
 // reuse it. The maintained finisher still accepts only a live-pin identity;
 // rebind after the current-pin assertion above, without changing evidence.
 const acquisition={...checkpoint.acquisition,identity:liveIdentity},options={nowMs,sourcePin:analysisPin,
  typedSourceNamespace:sourceNamespace,generationSnapshot:snapshot,generationSnapshotFenced:true,
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
 // was cut by the budget or deadline, not by the end of its selected days.
 if(!usage.complete&&before-budget.remainingQueries-(resumed?0:1)<maxPages)return {status:'deferred',checkpoint:prior,cut:true};
 return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,snapshot,phase:'usage',
  acquisition:checkpoint.acquisition,usage}};
}
