import { canonicalJson } from './canonical-json';
import { accountScopedModelCompositionV11,accountScopedQuotaAnalysisV11,
  createV11QuotaAcquisitionIdentity,v11AnalysisWindow } from './quota-analysis-v11';
import { advanceV11QuotaAcquisition,createV11QuotaAcquisitionCheckpoint,
  type V11CompletedQuotaAcquisition,type V11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionIdentity,type V11QuotaInvocationBudget } from './quota-analysis-v11-reader';
import { assertV11SourcePinCurrent,type V11SourcePin } from './telemetry-v11-domain';
import { createTypedV11QuotaPageReader } from './typed-v11-quota-reader';

export type StorageV11HistoryCheckpoint={version:1;source:'v1.1';day:string;layout:string;
 identity:V11QuotaAcquisitionIdentity}&(
 {phase:'acquisition';acquisition:V11QuotaAcquisitionCheckpoint}|
 {phase:'finish';acquisition:V11CompletedQuotaAcquisition});
export type StorageV11HistoryResult={status:'deferred';checkpoint:StorageV11HistoryCheckpoint|null}|
 {status:'complete';analysis:object};

const fail=()=>new Error('STORAGE_V11_HISTORY_CHECKPOINT_MISMATCH');
function sameIdentity(left:V11QuotaAcquisitionIdentity,right:V11QuotaAcquisitionIdentity):boolean{
 return canonicalJson(left)===canonicalJson(right);
}

/** One bounded source-only v1.1 quota-page group. The graph caller durably
 * promotes the returned deterministic checkpoint before requesting another group. The
 * maintained finisher retains its own final source-pin check; graph result
 * promotion still performs the independent source/privacy fence. */
export async function advanceStorageV11Analysis(input:{source:D1Database;sourceNamespace:string;
 participantId:string;day:string;metric:'fits'|'model';nowMs:number;sourcePin:V11SourcePin;
 closedDependencyDigest:string;
 budget:V11QuotaInvocationBudget;checkpoint?:StorageV11HistoryCheckpoint|null;maxPages?:number}):Promise<StorageV11HistoryResult>{
 const {source,sourceNamespace,participantId,day,metric,nowMs,budget}=input,sourcePin=structuredClone(input.sourcePin);
 if(sourcePin.source!=='v1.1'||sourcePin.participantId!==participantId
  ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)||new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10)!==day
  ||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0
  ||!Number.isFinite(budget.deadlineMs))throw fail();
 if(!/^[0-9a-f]{64}$/.test(input.closedDependencyDigest))throw fail();
 if(input.maxPages!==undefined&&(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>32))throw fail();
 const liveIdentity=createV11QuotaAcquisitionIdentity(sourcePin,nowMs),
  identity={...liveIdentity,inputFingerprint:input.closedDependencyDigest},layout=`typed-v11:${sourceNamespace}`;
 const prior=input.checkpoint?structuredClone(input.checkpoint):null;
 if(prior&&(prior.version!==1||prior.source!=='v1.1'||prior.day!==day||prior.layout!==layout
  ||!['acquisition','finish'].includes(prior.phase)||!sameIdentity(prior.identity,identity)))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 // Reader scope1 + source pre/post2 + successor checks are fixed per group.
 // Preserve a bounded local reserve before starting a group; the outer D1 meter remains
 // the actual statement authority.
 if(budget.remainingQueries<8||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:prior};
 budget.remainingQueries-=7;
 await assertV11SourcePinCurrent(source,sourcePin);
 let checkpoint:StorageV11HistoryCheckpoint=prior??{version:1,source:'v1.1',day,layout,identity,
  phase:'acquisition',acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
 if(checkpoint.phase==='acquisition'){
  const window=v11AnalysisWindow(sourcePin,nowMs);
  // A historical day can precede this exact v1.1 domain. Preserve the same
  // empty-window result as the maintained reducer without issuing an invalid
  // physical range query; the empty completed evidence remains identity-bound
  // and is durably promoted before the finisher runs.
  if(Date.parse(window.end)<=Date.parse(window.start)){
   await assertV11SourcePinCurrent(source,sourcePin);
   return {status:'deferred',checkpoint:{version:1,source:'v1.1',day,layout,identity,phase:'finish',
    acquisition:{identity,planAnchors:[],quotaRows:[]}}};
  }
  const reader=await createTypedV11QuotaPageReader(source,{sourceNamespace,pin:sourcePin,
   fromObservedAtMs:Date.parse(window.start),beforeObservedAtMs:Date.parse(window.end)});
  const before=budget.remainingQueries;
  const result=await advanceV11QuotaAcquisition(reader,identity,budget,checkpoint.acquisition,
   {maxPages:input.maxPages??1});
  await assertV11SourcePinCurrent(source,sourcePin);
  if(result.status==='deferred')return {status:'deferred',checkpoint:before===budget.remainingQueries?prior:
   {...checkpoint,acquisition:result.checkpoint}};
  if(result.status==='not_testable')return {status:'complete',analysis:{
   schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:result.reason,tracks:[]}};
  checkpoint={version:1,source:'v1.1',day,layout,identity,phase:'finish',
   acquisition:{identity:result.identity,planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
  return {status:'deferred',checkpoint};
 }
 // The durable acquisition is identified by the exact selected historical
 // manifest vector, so a new domain generation outside this closed window can
 // reuse it. The maintained finisher still accepts only a live-pin identity;
 // rebind after the current-pin assertion above, without changing evidence.
 const options={nowMs,sourcePin,quotaAcquisition:{...checkpoint.acquisition,identity:liveIdentity}};
 const analysis=metric==='fits'
  ?await accountScopedQuotaAnalysisV11(source,participantId,options)
  :await accountScopedModelCompositionV11(source,participantId,options);
 return {status:'complete',analysis};
}
