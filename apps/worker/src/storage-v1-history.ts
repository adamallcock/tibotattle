import { modelHistoryWindow } from './model-history-window';
import { createV1QuotaPageReader } from './quota-fit-projection';
import { loadTypedV1AnalysisScope } from './typed-v1-analysis-reader';
import { assertV1SourcePinCurrent,V1_SOURCE_SELECTION_METHOD_VERSION,type V1SourcePin } from './telemetry-v1-source-selection';
import { advanceV1QuotaAcquisition,createV1QuotaAcquisitionCheckpoint,type V1QuotaAcquisitionIdentity,
 type V1QuotaAcquisitionCheckpoint,type V1CompletedQuotaAcquisition,type V1QuotaInvocationBudget } from './quota-analysis-v1-reader';
import { finishHistoricalModelCompositionV1,MODEL_HISTORY_METHOD_VERSION,type V1ModelCompositionResult } from './quota-analysis-v1';

export type StorageV1HistoryCheckpoint={version:1;day:string;layout:string;identity:V1QuotaAcquisitionIdentity}&(
 {phase:'acquisition';acquisition:V1QuotaAcquisitionCheckpoint}|{phase:'finish';acquisition:V1CompletedQuotaAcquisition});
export type StorageV1HistoryResult={status:'deferred';checkpoint:StorageV1HistoryCheckpoint|null}|
 {status:'complete';analysis:V1ModelCompositionResult};
const fail=()=>new Error('STORAGE_V1_HISTORY_CHECKPOINT_MISMATCH');
/** Source-only historical kernel driver. The caller persists the returned
 * private checkpoint in its separately fenced analytics store; this function
 * never writes either database. Each acquisition call advances exactly one page
 * so an interrupted staged save can replay from the committed head regardless
 * of the next invocation budget. A completed acquisition survives a short
 * finishing budget, rather than rereading quota history on every invocation. */
export async function advanceStorageV1HistoricalAnalysis(input:{source:D1Database;participantId:string;day:string;
 sourcePin:V1SourcePin;budget:V1QuotaInvocationBudget;checkpoint?:StorageV1HistoryCheckpoint|null}):Promise<StorageV1HistoryResult>{
 const {source,participantId,day,budget}=input,sourcePin=structuredClone(input.sourcePin),history=modelHistoryWindow(day);
 if(!('participantId'in sourcePin.scope)||sourcePin.scope.participantId!==participantId||sourcePin.scope.fromDay!==history.fromDay
  ||sourcePin.scope.throughDay!==day||sourcePin.methodVersion!==V1_SOURCE_SELECTION_METHOD_VERSION)throw fail();
 const identity:V1QuotaAcquisitionIdentity={participantId,inputFingerprint:sourcePin.fingerprint,sourceMethodVersion:MODEL_HISTORY_METHOD_VERSION,
  observedAtCutoff:history.observedAtCutoff,resetsAtCutoff:new Date(Date.parse(history.observedAtCutoff)+7*86400000).toISOString(),windowMinutes:10080,maxQuotaRows:60000};
 const prior=input.checkpoint?structuredClone(input.checkpoint):null;
 if(prior&&(prior.version!==1||prior.day!==day||!['acquisition','finish'].includes(prior.phase)
  ||Object.keys(prior.identity).length!==Object.keys(identity).length||Object.entries(identity).some(([key,value])=>Reflect.get(prior.identity,key)!==value)))throw fail();
 if(!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0||!Number.isFinite(budget.deadlineMs))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 // At most: layout2 + initial source2 + successor1 + factory2 + final source2
 // + final successor1. Reserve before starting, never after an effect.
 if(budget.remainingQueries<10||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:prior};
 budget.remainingQueries-=10;
 const selected=await loadTypedV1AnalysisScope(source,participantId),layout=selected?`typed:${selected.sourceNamespace}`:'json';
 if(prior&&prior.layout!==layout)throw fail();
 const assertSource=async()=>{await assertV1SourcePinCurrent(source,sourcePin);
  if(await source.prepare('SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=? LIMIT 1').bind(participantId).first())throw fail();};
 await assertSource();
 let checkpoint:StorageV1HistoryCheckpoint=prior??{version:1,day,layout,identity,phase:'acquisition',acquisition:createV1QuotaAcquisitionCheckpoint(identity)};
 if(checkpoint.phase==='acquisition'){
  const reader=await createV1QuotaPageReader(source,participantId,history.observedAtBefore);
  const result=await advanceV1QuotaAcquisition(reader,identity,new Map(sourcePin.winners.map(w=>[w.observed_day,w.device_id])),budget,checkpoint.acquisition,{maxPages:1});
  await assertSource();
  if(result.status==='deferred')return {status:'deferred',checkpoint:{...checkpoint,acquisition:result.checkpoint}};
  if(result.status==='not_testable')return {status:'complete',analysis:{status:'not_testable',reason:result.reason}};
  checkpoint={version:1,day,layout,identity,phase:'finish',acquisition:{planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
  return {status:'deferred',checkpoint};
 }
 const finished=await finishHistoricalModelCompositionV1(source,participantId,day,{identity,acquisition:checkpoint.acquisition},budget,{sourcePin});
 if(finished.status==='deferred')return {status:'deferred',checkpoint};
 // The maintained finisher performs its own final source check. The caller
 // must still fence source dependency and authority when promoting this value.
 return finished;
}
