import { modelHistoryWindow } from './model-history-window';
import { createV1QuotaPageReader } from './quota-fit-projection';
import { loadTypedV1AnalysisScope } from './typed-v1-analysis-reader';
import { assertV1SourcePinCurrent,V1_SOURCE_SELECTION_METHOD_VERSION,type V1SourcePin } from './telemetry-v1-source-selection';
import { advanceV1QuotaAcquisition,createV1QuotaAcquisitionCheckpoint,type V1QuotaAcquisitionIdentity,
 type V1QuotaAcquisitionCheckpoint,type V1CompletedQuotaAcquisition,type V1QuotaInvocationBudget } from './quota-analysis-v1-reader';
import { finishAccountScopedQuotaAnalysisV1,finishHistoricalModelCompositionV1,MODEL_HISTORY_METHOD_VERSION,
 V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,type V1ModelCompositionResult } from './quota-analysis-v1';
import { withStorageGraphFailureStage } from './storage-analytics-failure';

export type StorageV1HistoryCheckpoint={version:1;day:string;layout:string;identity:V1QuotaAcquisitionIdentity}&(
 {phase:'acquisition';acquisition:V1QuotaAcquisitionCheckpoint}|{phase:'finish';acquisition:V1CompletedQuotaAcquisition});
export type StorageV1HistoryResult={status:'deferred';checkpoint:StorageV1HistoryCheckpoint|null}|
 {status:'complete';analysis:V1ModelCompositionResult};
export type StorageV1CurrentFitResult={status:'deferred';checkpoint:StorageV1HistoryCheckpoint|null}|
 {status:'complete';analysis:object};
const fail=()=>new Error('STORAGE_V1_HISTORY_CHECKPOINT_MISMATCH');
/** Source-only historical kernel driver. The caller persists the returned
 * private checkpoint in its separately fenced analytics store; this function
 * never writes either database. Each acquisition call advances one bounded page
 * group. An interrupted group can replay from the last committed head. Completed
 * acquisition survives a short finishing budget, avoiding another history read. */
export async function advanceStorageV1HistoricalAnalysis(input:{source:D1Database;participantId:string;day:string;
 sourcePin:V1SourcePin;budget:V1QuotaInvocationBudget;checkpoint?:StorageV1HistoryCheckpoint|null;maxPages?:number}):Promise<StorageV1HistoryResult>{
 const {source,participantId,day,budget}=input,sourcePin=structuredClone(input.sourcePin),history=modelHistoryWindow(day);
 if(!('participantId'in sourcePin.scope)||sourcePin.scope.participantId!==participantId||sourcePin.scope.fromDay!==history.fromDay
  ||sourcePin.scope.throughDay!==day||sourcePin.methodVersion!==V1_SOURCE_SELECTION_METHOD_VERSION)throw fail();
 const identity:V1QuotaAcquisitionIdentity={participantId,inputFingerprint:sourcePin.fingerprint,sourceMethodVersion:MODEL_HISTORY_METHOD_VERSION,
  observedAtCutoff:history.observedAtCutoff,resetsAtCutoff:new Date(Date.parse(history.observedAtCutoff)+7*86400000).toISOString(),windowMinutes:10080,maxQuotaRows:60000};
 const prior=input.checkpoint?structuredClone(input.checkpoint):null;
 if(prior&&(prior.version!==1||prior.day!==day||!['acquisition','finish'].includes(prior.phase)
  ||Object.keys(prior.identity).length!==Object.keys(identity).length||Object.entries(identity).some(([key,value])=>Reflect.get(prior.identity,key)!==value)))throw fail();
 if(!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0||!Number.isFinite(budget.deadlineMs))throw fail();
 if(input.maxPages!==undefined&&(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>32))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 // At most: layout2 + initial source2 + successor1 + factory2 + final source2
 // + final successor1. Reserve before starting, never after an effect.
 if(budget.remainingQueries<10||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:prior};
 budget.remainingQueries-=10;
 const selected=await withStorageGraphFailureStage('graph_history_layout',
  ()=>loadTypedV1AnalysisScope(source,participantId));
 const layout=selected?`typed:${selected.sourceNamespace}`:'json';
 if(prior&&prior.layout!==layout)throw fail();
 const assertSource=async()=>{await assertV1SourcePinCurrent(source,sourcePin);
  if(await source.prepare('SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=? LIMIT 1').bind(participantId).first())throw fail();};
 await withStorageGraphFailureStage('graph_history_source_precheck',assertSource);
 let checkpoint:StorageV1HistoryCheckpoint=prior??{version:1,day,layout,identity,phase:'acquisition',acquisition:createV1QuotaAcquisitionCheckpoint(identity)};
 if(checkpoint.phase==='acquisition'){
  const acquisition=checkpoint.acquisition;
  const reader=await withStorageGraphFailureStage('graph_history_reader',
   ()=>createV1QuotaPageReader(source,participantId,history.observedAtBefore));
  const result=await withStorageGraphFailureStage('graph_history_acquisition_page',
   ()=>advanceV1QuotaAcquisition(reader,identity,new Map(sourcePin.winners.map(w=>[w.observed_day,w.device_id])),budget,
    acquisition,{maxPages:input.maxPages??1}));
  await withStorageGraphFailureStage('graph_history_source_postcheck',assertSource);
  if(result.status==='deferred')return {status:'deferred',checkpoint:{...checkpoint,acquisition:result.checkpoint}};
  if(result.status==='not_testable')return {status:'complete',analysis:{status:'not_testable',reason:result.reason}};
  checkpoint={version:1,day,layout,identity,phase:'finish',acquisition:{planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
  return {status:'deferred',checkpoint};
 }
 const finished=await withStorageGraphFailureStage('graph_history_finish',
  ()=>finishHistoricalModelCompositionV1(source,participantId,day,{identity,acquisition:checkpoint.acquisition},budget,{sourcePin}));
 if(finished.status==='deferred')return {status:'deferred',checkpoint};
 // The maintained finisher performs its own final source check. The caller
 // must still fence source dependency and authority when promoting this value.
 return finished;
}

/** Current scalar fit acquisition uses the same exact source pin and maintained
 * page reducer as historical composition. Each call advances a bounded group;
 * the caller durably promotes its deterministic successor before finishing.
 * Source checks cover the complete group, and failed groups replay the saved head. */
export async function advanceStorageV1CurrentFitAnalysis(input:{source:D1Database;participantId:string;day:string;
 sourcePin:V1SourcePin;budget:V1QuotaInvocationBudget;checkpoint?:StorageV1HistoryCheckpoint|null;maxPages?:number}):Promise<StorageV1CurrentFitResult>{
 const {source,participantId,day,budget}=input,sourcePin=structuredClone(input.sourcePin),window=modelHistoryWindow(day);
 if(!('participantId'in sourcePin.scope)||sourcePin.scope.participantId!==participantId
  ||sourcePin.scope.fromDay!==window.fromDay||sourcePin.scope.throughDay!==undefined
  ||sourcePin.methodVersion!==V1_SOURCE_SELECTION_METHOD_VERSION)throw fail();
 const identity:V1QuotaAcquisitionIdentity={participantId,inputFingerprint:sourcePin.fingerprint,
  sourceMethodVersion:V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,observedAtCutoff:window.observedAtCutoff,
  resetsAtCutoff:new Date(Date.parse(window.observedAtCutoff)+7*86400000).toISOString(),windowMinutes:10080,maxQuotaRows:60000};
 const prior=input.checkpoint?structuredClone(input.checkpoint):null;
 if(prior&&(prior.version!==1||prior.day!==day||!['acquisition','finish'].includes(prior.phase)
  ||Object.keys(prior.identity).length!==Object.keys(identity).length
  ||Object.entries(identity).some(([key,value])=>Reflect.get(prior.identity,key)!==value)))throw fail();
 if(!Number.isSafeInteger(budget.remainingQueries)||budget.remainingQueries<0||!Number.isFinite(budget.deadlineMs))throw fail();
 if(input.maxPages!==undefined&&(!Number.isSafeInteger(input.maxPages)||input.maxPages<1||input.maxPages>32))throw fail();
 const now=()=>{const value=(budget.now??Date.now)();if(!Number.isFinite(value))throw fail();return value;};
 if(budget.remainingQueries<10||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:prior};
 budget.remainingQueries-=10;
 return withStorageGraphFailureStage('graph_current_fit_compute',async()=>{
  const selected=await loadTypedV1AnalysisScope(source,participantId),layout=selected?`typed:${selected.sourceNamespace}`:'json';
  if(prior&&prior.layout!==layout)throw fail();
  const assertSource=async()=>{await assertV1SourcePinCurrent(source,sourcePin);
   if(await source.prepare('SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=? LIMIT 1').bind(participantId).first())throw fail();};
  await assertSource();
  let checkpoint:StorageV1HistoryCheckpoint=prior??{version:1,day,layout,identity,phase:'acquisition',
   acquisition:createV1QuotaAcquisitionCheckpoint(identity)};
  if(checkpoint.phase==='acquisition'){
   const reader=await createV1QuotaPageReader(source,participantId);
   const result=await advanceV1QuotaAcquisition(reader,identity,
    new Map(sourcePin.winners.map(w=>[w.observed_day,w.device_id])),budget,checkpoint.acquisition,{maxPages:input.maxPages??1});
   await assertSource();
   if(result.status==='deferred')return {status:'deferred',checkpoint:{...checkpoint,acquisition:result.checkpoint}};
   if(result.status==='not_testable')return {status:'complete',analysis:{schemaVersion:'account-scoped-quota-analysis-v0.1',
    status:'not_testable',reason:result.reason,tracks:[]}};
   checkpoint={version:1,day,layout,identity,phase:'finish',
    acquisition:{planAnchors:result.planAnchors,quotaRows:result.quotaRows}};
   return {status:'deferred',checkpoint};
  }
  const finished=await finishAccountScopedQuotaAnalysisV1(source,participantId,
   {identity,acquisition:checkpoint.acquisition},budget,{nowMs:Date.parse(window.fixedNow),sourcePin});
  return finished.status==='deferred'?{status:'deferred',checkpoint}:finished;
 });
}
