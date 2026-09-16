import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { accountScopedQuotaAnalysis } from './quota-analysis';
import { accountScopedQuotaAnalysisV1, accountScopedHistoricalModelCompositionV1,
  MODEL_HISTORY_METHOD_VERSION, type V1ModelCompositionResult } from './quota-analysis-v1';
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';
import { assertV11SourcePinCurrent,type V11SourcePin } from './telemetry-v11-domain';
import { assertTypedV11GenerationSnapshotLive,type V11GenerationSnapshot } from './typed-v11-quota-reader';
import { assertV1SourcePinCurrent, loadV1SourcePin } from './telemetry-v1-source-selection';
import { modelHistoryWindow } from './model-history-window';
import { communityAnalysisCacheVersion, loadCommunitySourcePin, parsedCachedFits,
  selectCommunityAllowanceAnalysisFits, validCompleteCachedComposition, validCompleteScalarAnalysis,
  type CommunityAllowanceFit } from './community-allowance';
import { captureStorageCommunityAuthority, sameStorageCommunityCalculationAuthority,
  storageCommunityCalculationAuthorityIsCurrent,
  type StorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { advanceStorageV1CurrentFitAnalysis,advanceStorageV1HistoricalAnalysis,type StorageV1HistoryCheckpoint } from './storage-v1-history';
import { advanceStorageV11Analysis,type StorageV11HistoryCheckpoint } from './storage-v11-history';
import { loadStorageHistoryCheckpoint, readStorageHistoryCheckpointHead, saveStorageHistoryCheckpoint,
  type StorageHistoryCheckpoint,type StorageHistoryKey,type StorageHistoryLoadCursor } from './storage-history-checkpoint';
import { caughtStorageGraphFailureFields, withStorageGraphFailureStage,
  type StorageGraphFailureFields } from './storage-analytics-failure';

export const STORAGE_GRAPH_METHOD = communityAnalysisCacheVersion() + ':separate-results-1';
// Checkpoint storage is an implementation detail, separate from the semantic
// result identity above. Bump only this namespace when a prior generation's
// permanent anti-resurrection tombstones must remain valid but must not block
// a repaired reader from making new resumable progress.
export const STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':checkpoint-store-2';
export const STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':current-fit-checkpoint-1';
export const STORAGE_GRAPH_V11_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':v11-shared-checkpoint-2';
export const STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD = STORAGE_GRAPH_V11_CHECKPOINT_METHOD;
export const STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD = STORAGE_GRAPH_V11_CHECKPOINT_METHOD;
// Execution-only revision for the single optimistic direct historical read.
// This is deliberately absent from result/checkpoint identities: a reader fix
// may reopen one direct attempt without changing the analysis semantics.
const STORAGE_GRAPH_DIRECT_HISTORY_READER_REVISION = 'typed-v1-direct-cross-1';
const MAX_RESULT_BYTES = 1024 * 1024;
// Acquisition may consume its cooperative work deadline exactly. Keep an
// outer window for the final source proof and one bounded checkpoint-save
// batch, otherwise a deadline-limited pass can discard the page it acquired.
const STORAGE_GRAPH_CHECKPOINT_SAVE_HEADROOM_MS = 6_000;
const STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM = 32;
const STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM = 32;
const fail = () => new Error('STORAGE_GRAPH_RESULT_UNAVAILABLE');
const scopeChanged = () => new Error('storage graph scope changed');
export type StorageGraphSource = 'v0.2' | 'v1' | 'v1.1' | 'mixed';
type Source = StorageGraphSource;
type Pin = Awaited<ReturnType<typeof loadCommunitySourcePin>>['sourcePin'];
export interface StorageGraphScope {
  authority: StorageCommunityAuthority; owner: StorageCommunityOwner & {ownerDigest:string};
  source: Source; pin: Pin; day: string; fixedNow: string; metric:'fits'|'model';
  dependencyDigest:string; checkpointDependencyDigest:string;
  /** Graph-only immutable v1.1 generation selected before newer source work. */
  snapshot?:V11GenerationSnapshot;
  /** Target owner epoch captured by the work-selection CAS. */
  ownerAuthorityEpoch?:number;
}
export interface StorageGraphResult {
  scope:StorageGraphScope; fits:CommunityAllowanceFit[] | null; composition:V1ModelCompositionResult | null;
  unsupportedSource?:boolean;
}

/** Shared byte identity for computation and bounded publication revalidation.
 * Callers supply the exact elected metadata, never counts or newest timestamps. */
export async function storageGraphDependencyDigest(options:{
  authority:Pick<StorageCommunityAuthority,'sourceId'|'sourceNamespace'>;ownerDigest:string;
  source:StorageGraphSource;metric:'fits'|'model';day:string;dependency:unknown;
}):Promise<string> {
  const history=modelHistoryWindow(options.day);
  return sha256Hex(canonicalJson([options.authority.sourceId,options.authority.sourceNamespace,
    options.ownerDigest,options.source,options.metric,history.day,history.fromDay,STORAGE_GRAPH_METHOD,options.dependency]));
}

async function storageGraphCheckpointDependencyDigest(options:{
 authority:Pick<StorageCommunityAuthority,'sourceId'|'sourceNamespace'>;ownerDigest:string;
 source:StorageGraphSource;day:string;dependency:unknown;
}):Promise<string>{
 const history=modelHistoryWindow(options.day);
 return sha256Hex(canonicalJson([options.authority.sourceId,options.authority.sourceNamespace,
  options.ownerDigest,options.source,'shared-v11-usage',history.day,history.fromDay,STORAGE_GRAPH_METHOD,options.dependency]));
}

/** The cache key is the exact selected evidence in this window, not the newest
 * whole-domain generation. An append outside a closed historical window does
 * not invalidate completed work. The live pin still fences every calculation. */
export async function captureStorageGraphScope(sourceDb:D1Database, options:{
  owner:StorageCommunityOwner; day:string; metric:'fits'|'model';
  sourceId?:string; sourceNamespace?:string;
}):Promise<StorageGraphScope> {
  const owner={...options.owner}, history=modelHistoryWindow(options.day);
  if(!owner.ownerDigest || !/^[a-f0-9]{64}$/.test(owner.ownerDigest)
    || !['fits','model'].includes(options.metric))throw fail();
  const authority=await captureStorageCommunityAuthority(sourceDb,options);
  const source:Source=owner.hasV11?'v1.1':owner.hasV1?owner.hasLegacy?'mixed':'v1':'v0.2';
  // Pure-v1 history depends only on the closed model window. Loading the
  // current-fit adapter first materialized the wider open-ended chunk vector,
  // scanned irrelevant legacy metadata, reloaded that vector as an assertion,
  // then discarded it for this same closed pin. Mixed sources still require
  // the combined adapter and its legacy dependency vector.
  let loaded:Awaited<ReturnType<typeof loadCommunitySourcePin>>;
  if(options.metric==='model'&&source==='v1') {
    const sourcePin=await withStorageGraphFailureStage('graph_historical_pin',()=>loadV1SourcePin(sourceDb,
      {participantId:owner.participantId,fromDay:history.fromDay,throughDay:history.day},{includeDayDependencies:true}));
    loaded={sourcePin,fingerprint:sourcePin.fingerprint};
  } else loaded=await loadCommunitySourcePin(sourceDb,owner.participantId,history.fromDay,source,
    {includeDayDependencies:true});
  if(loaded.sourcePin.inputRevision!==owner.inputRevision)throw scopeChanged();
  let dependency:unknown=loaded.fingerprint;
  if('source' in loaded.sourcePin) {
    const rows=(await sourceDb.prepare(`SELECT d.observed_day,m.id,m.manifest_digest,m.device_id
      FROM telemetry_v11_domain_days d JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
      WHERE d.generation_id=? AND d.observed_day>=? AND d.observed_day<=?
      ORDER BY d.observed_day LIMIT 102`).bind(loaded.sourcePin.generationId,history.fromDay,history.day)
      .all<Record<string,unknown>>()).results;
    if(rows.length>101)throw fail();
    dependency=rows;
  } else if(source==='v1') {
    // The current legacy source-only adapter has no upper time predicate.
    // Retain its complete dependency vector; historical composition uses its
    // separate closed-window adapter and must not reuse this current result.
    if(!loaded.sourcePin.dayDependencies)throw fail();
    dependency=loaded.sourcePin.dayDependencies;
  }
  const dependencyDigest=await storageGraphDependencyDigest({authority,ownerDigest:owner.ownerDigest,
    source,metric:options.metric,day:history.day,dependency});
  const checkpointDependencyDigest=source==='v1.1'?await storageGraphCheckpointDependencyDigest({authority,
    ownerDigest:owner.ownerDigest,source,day:history.day,dependency}):dependencyDigest;
  if(!await storageCommunityCalculationAuthorityIsCurrent(sourceDb,authority))throw scopeChanged();
  return {authority,owner:owner as StorageGraphScope['owner'],source,pin:loaded.sourcePin,
    day:history.day,fixedNow:history.fixedNow,metric:options.metric,dependencyDigest,checkpointDependencyDigest};
}

/** Reconstruct a graph scope from one retained v1.1 generation selected before
 * a newer head was admitted. Dependency identities are recomputed from that
 * immutable generation; callers cannot supply or weaken them. */
export async function captureSelectedStorageGraphScope(sourceDb:D1Database,options:{
 owner:StorageCommunityOwner;day:string;metric:'fits'|'model';snapshot:V11GenerationSnapshot;
 ownerAuthorityEpoch:number;sourceId?:string;sourceNamespace?:string;
}):Promise<StorageGraphScope>{
 const owner={...options.owner},history=modelHistoryWindow(options.day),snapshot=structuredClone(options.snapshot);
 if(!owner.ownerDigest||!/^[a-f0-9]{64}$/u.test(owner.ownerDigest)||!owner.hasV11
  ||owner.participantId!==snapshot.participantId||!Number.isSafeInteger(options.ownerAuthorityEpoch)
  ||options.ownerAuthorityEpoch<1||snapshot.sourceNamespace!==options.sourceNamespace)throw fail();
 const authority=await captureStorageCommunityAuthority(sourceDb,options);
 await assertTypedV11GenerationSnapshotLive(sourceDb,snapshot);
 const rows=(await sourceDb.prepare(`SELECT d.observed_day,m.id,m.manifest_digest,m.device_id
   FROM telemetry_v11_domain_days d JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
   WHERE d.generation_id=? AND d.observed_day>=? AND d.observed_day<=?
   ORDER BY d.observed_day LIMIT 102`).bind(snapshot.generationId,history.fromDay,history.day)
   .all<Record<string,unknown>>()).results;
 if(rows.length>101)throw fail();
 const dependencyDigest=await storageGraphDependencyDigest({authority,ownerDigest:owner.ownerDigest,
  source:'v1.1',metric:options.metric,day:history.day,dependency:rows});
 const checkpointDependencyDigest=await storageGraphCheckpointDependencyDigest({authority,
  ownerDigest:owner.ownerDigest,source:'v1.1',day:history.day,dependency:rows});
 const pin:V11SourcePin={source:'v1.1',participantId:snapshot.participantId,generationId:snapshot.generationId,
  fromDay:snapshot.fromDay,throughDay:snapshot.throughDay,inputRevision:snapshot.inputRevision,
  mutationEpoch:authority.sourceEpoch,fingerprint:snapshot.fingerprint};
 if(!await storageCommunityCalculationAuthorityIsCurrent(sourceDb,authority))throw scopeChanged();
 return {authority,owner:{...owner,inputRevision:snapshot.inputRevision,ownerDigest:owner.ownerDigest},source:'v1.1',pin,
  day:history.day,fixedNow:history.fixedNow,metric:options.metric,dependencyDigest,checkpointDependencyDigest,
  snapshot,ownerAuthorityEpoch:options.ownerAuthorityEpoch};
}

async function selectedOwnerAuthorityIsCurrent(source:D1Database,scope:StorageGraphScope):Promise<boolean>{
 if(scope.ownerAuthorityEpoch===undefined)return true;
 const row=await source.prepare(`SELECT 1 AS ready FROM storage_v11_owner_links l
  JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest AND r.state='active' AND r.authority_epoch=?
  WHERE l.participant_id=? AND l.owner_digest=? AND l.state='active'`).bind(scope.ownerAuthorityEpoch,
   scope.owner.participantId,scope.owner.ownerDigest).first<number>('ready');
 return row===1;
}

async function current(source:D1Database,scope:StorageGraphScope):Promise<boolean> {
  if(scope.snapshot)await assertTypedV11GenerationSnapshotLive(source,scope.snapshot);
  else if('source' in scope.pin)await assertV11SourcePinCurrent(source,scope.pin);
  else await assertV1SourcePinCurrent(source,scope.pin);
  return await selectedOwnerAuthorityIsCurrent(source,scope)
    &&storageCommunityCalculationAuthorityIsCurrent(source,scope.authority);
}
async function targetReady(target:D1Database,scope:StorageGraphScope):Promise<void> {
  if(scope.snapshot&&(scope.source!=='v1.1'||!('source'in scope.pin)
    ||scope.snapshot.participantId!==scope.owner.participantId
    ||scope.snapshot.sourceNamespace!==scope.authority.sourceNamespace
    ||scope.snapshot.fingerprint!==scope.pin.fingerprint))throw fail();
  if(!await target.prepare(`SELECT 1 FROM analytics_runtime_sources WHERE source_id=?
    AND source_namespace=? AND contract_version=1`).bind(scope.authority.sourceId,scope.authority.sourceNamespace).first())throw fail();
  if(scope.ownerAuthorityEpoch!==undefined&&(!Number.isSafeInteger(scope.ownerAuthorityEpoch)
    ||scope.ownerAuthorityEpoch<0||!await target.prepare(`SELECT 1 FROM analytics_owner_state
      WHERE source_id=? AND owner_digest=? AND state='active' AND authority_epoch=?`)
      .bind(scope.authority.sourceId,scope.owner.ownerDigest,scope.ownerAuthorityEpoch).first()))throw fail();
}
function decoded(row:{payload_json:string;payload_fingerprint:string;source_kind:StorageGraphSource},scope:StorageGraphScope):StorageGraphResult|null {
  if(row.source_kind!==scope.source)return null;
  if(scope.metric==='fits') {
    const fits=parsedCachedFits(row.payload_json,scope.owner.ownerDigest);
    return fits===null?null:{scope,fits,composition:null};
  }
  let composition:unknown;try{composition=JSON.parse(row.payload_json)}catch{return null}
  if(canonicalJson(composition)==='{"reason":"legacy_source_overlap","status":"unsupported_source"}') {
    return scope.source==='v0.2'||scope.source==='mixed'?{scope,fits:null,composition:null,unsupportedSource:true}:null;
  }
  const method=scope.source==='v1.1'?V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:MODEL_HISTORY_METHOD_VERSION;
  return validCompleteCachedComposition(composition,row.payload_fingerprint,method)
    ?{scope,fits:null,composition}:null;
}

/** Private read. A matching method/dependency proves data reuse; a final source
 * read independently proves authority. Cache timestamps never prove either. */
export async function readStorageGraphResult(bindings:StorageAnalyticsBindings,scope:StorageGraphScope):Promise<StorageGraphResult|null> {
  if(bindings.sourceId!==scope.authority.sourceId||bindings.sourceNamespace!==scope.authority.sourceNamespace
    || bindings.source===bindings.target)throw fail();
  await targetReady(bindings.target,scope);
  const row=await bindings.target.prepare(`SELECT payload_json,payload_fingerprint,payload_sha256,authority_json,source_kind
    FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric=? AND day=?
      AND method=? AND dependency_digest=?`).bind(bindings.sourceId,scope.owner.ownerDigest,scope.metric,
        scope.day,STORAGE_GRAPH_METHOD,scope.dependencyDigest)
    .first<{payload_json:string;payload_fingerprint:string;payload_sha256:string;authority_json:string;source_kind:StorageGraphSource}>();
  if(!row)return null;
  let authority:StorageCommunityAuthority;try{authority=JSON.parse(row.authority_json)}catch{return null}
  if(!authority||!sameStorageCommunityCalculationAuthority(authority,scope.authority)
    ||new TextEncoder().encode(row.payload_json).byteLength>MAX_RESULT_BYTES
    ||await sha256Hex(row.payload_json)!==row.payload_sha256)return null;
  const result=decoded(row,scope);
  return result && await current(bindings.source,scope)?result:null;
}

/** Runs the existing kernels against read-only source evidence. Only their
 * completed, validated output is persisted in analytics. A target failure has
 * no transaction, cache write or backpressure hook in ingestion. */
export async function computeStorageGraphResult(bindings:StorageAnalyticsBindings,scope:StorageGraphScope,
  options:{maxQueries?:number;deadlineMs?:number;now?:()=>number}={}):Promise<
  {state:'complete';result:StorageGraphResult;reused:boolean}
  |{state:'deferred';reason:string;failure?:StorageGraphFailureFields}> {
  if(bindings.source===bindings.target)throw fail();
  const meter=createD1InvocationBudget(options.maxQueries??900),now=options.now??Date.now,
    startedMs=now(),deadlineMs=options.deadlineMs??startedMs+20_000,
    checkpointWorkDeadlineMs=deadlineMs-STORAGE_GRAPH_CHECKPOINT_SAVE_HEADROOM_MS;
  if(!Number.isFinite(startedMs)||!Number.isFinite(deadlineMs))throw fail();
  bindings={...bindings,source:meter.wrap(bindings.source),target:meter.wrap(bindings.target)};
  const cached=await readStorageGraphResult(bindings,scope);
  if(cached) {
    // Small proof refresh only. The exact window dependency was recomputed;
    // the completed payload and its original analytical fingerprint are kept.
    await bindings.target.prepare(`UPDATE analytics_community_graph_results SET input_revision=?
      WHERE source_id=? AND owner_digest=? AND metric=? AND day=? AND method=? AND dependency_digest=?
      AND input_revision<?`).bind(scope.owner.inputRevision,bindings.sourceId,scope.owner.ownerDigest,scope.metric,
        scope.day,STORAGE_GRAPH_METHOD,scope.dependencyDigest,scope.owner.inputRevision).run();
    return {state:'complete',result:cached,reused:true};
  }
  const nowMs=Date.parse(scope.fixedNow),source=bindings.source;
  const persistCheckpoint=async(key:StorageHistoryKey,checkpoint:StorageHistoryCheckpoint,
    expectedHead:string|null,reason:string):Promise<
    {state:'saved';head:string}|{state:'deferred';reason:string;failure?:StorageGraphFailureFields}>=>{
    if(!await current(source,scope))return {state:'deferred',reason};
    await targetReady(bindings.target,scope);
    try{
      while(meter.remainingQueries>=40&&now()<deadlineMs){
        const saved=await withStorageGraphFailureStage('graph_checkpoint_save',
          ()=>saveStorageHistoryCheckpoint({target:bindings.target,key,checkpoint,expectedHead}));
        if(saved.status==='saved')return {state:'saved',head:saved.headDigest};
      }
    }catch(error){
      const failure=caughtStorageGraphFailureFields('graph_checkpoint_save',error);
      if(!failure||failure.reason!=='checkpoint_unavailable')throw error;
      let latest;try{latest=await readStorageHistoryCheckpointHead({target:bindings.target,key});}catch{throw error;}
      if(latest?.retired===0&&latest.generation!==null&&latest.generation!==expectedHead)
        return {state:'deferred',reason,failure};
      throw error;
    }
    return {state:'deferred',reason};
  };
  let v11CompletedFingerprint:string|null=null;
  const computeV11=async(metric:'fits'|'model',pin:Extract<Pin,{source:'v1.1'}>):Promise<
    {state:'complete';analysis:object}|{state:'deferred';reason:string;failure?:StorageGraphFailureFields}>=>{
    // A typed domain can become source-visible before its ordered owner-active
    // journal event reaches the analytics target. Do not read or stage private
    // evidence until the target has the matching active owner authority.
    const ownerReady=await bindings.target.prepare(`SELECT 1 AS ready FROM analytics_owner_state
      WHERE source_id=? AND owner_digest=? AND state='active'`).bind(bindings.sourceId,scope.owner.ownerDigest)
      .first<number>('ready');
    if(ownerReady!==1)return {state:'deferred',reason:'v11_owner_pending'};
    const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
      ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,
      method:metric==='fits'?STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD:STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD};
    let cursor:StorageHistoryLoadCursor|undefined,head:string|null=null,checkpoint:StorageV11HistoryCheckpoint|undefined;
    for(;;){
      if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)return {state:'deferred',reason:'v11_checkpoint_read_budget'};
      const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
        ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
      if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
      head=loaded.headDigest??null;
      if(loaded.status==='ready'){
        if(!('source'in loaded.checkpoint)||loaded.checkpoint.source!=='v1.1')throw fail();
        checkpoint=loaded.checkpoint;
      }
      break;
    }
    // Resolve and fence the source once around a bounded page group, then
    // promote its deterministic successor once. If the read, final pin check,
    // or promotion fails, the last durable head remains the replay point.
    const next=await advanceStorageV11Analysis({source,sourceNamespace:bindings.sourceNamespace,
      participantId:scope.owner.participantId,day:scope.day,metric,nowMs,sourcePin:pin,
      generationSnapshot:scope.snapshot,
      closedDependencyDigest:scope.checkpointDependencyDigest,checkpoint,maxPages:STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM,
      budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),deadlineMs:checkpointWorkDeadlineMs,now}});
    if(next.status==='complete'){
      v11CompletedFingerprint=checkpoint?.snapshot?.fingerprint??pin.fingerprint;
      return {state:'complete',analysis:next.analysis};
    }
    if(!next.checkpoint)return {state:'deferred',reason:'v11_checkpoint'};
    const saved=await persistCheckpoint(key,next.checkpoint,head,'v11_checkpoint');
    if(saved.state==='deferred')return saved;
    if(saved.head===head)return {state:'deferred',reason:'v11_checkpoint'};
    // Persist each phase boundary before doing more work. Small owners can
    // acquire, reduce and finish in one invocation; large owners return after
    // one compact usage successor and resume from its exact cursor.
    let staged=next.checkpoint,stagedHead=saved.head;
    for(let transition=0;transition<2;transition++){
      if(staged.phase!=='finish'&&!(staged.phase==='usage'&&staged.usage.complete))break;
      const advanced=await advanceStorageV11Analysis({source,sourceNamespace:bindings.sourceNamespace,
        participantId:scope.owner.participantId,day:scope.day,metric,nowMs,sourcePin:pin,
        generationSnapshot:scope.snapshot,
        closedDependencyDigest:scope.checkpointDependencyDigest,checkpoint:staged,
        maxPages:STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM,
        budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),deadlineMs:checkpointWorkDeadlineMs,now}});
      if(advanced.status==='complete'){
        v11CompletedFingerprint=staged.snapshot?.fingerprint??pin.fingerprint;
        return {state:'complete',analysis:advanced.analysis};
      }
      if(!advanced.checkpoint)break;
      const promoted=await persistCheckpoint(key,advanced.checkpoint,stagedHead,'v11_checkpoint');
      if(promoted.state==='deferred')return promoted;
      if(promoted.head===stagedHead)break;
      staged=advanced.checkpoint;stagedHead=promoted.head;
    }
    return {state:'deferred',reason:'v11_checkpoint'};
  };
  let payload='';
  if(scope.metric==='fits') {
    const analyses:Array<{source:'v0.2'|'v1'|'v1.1';analysis:object}>=[];
    if('source' in scope.pin){
      const next=await computeV11('fits',scope.pin);if(next.state==='deferred')return next;
      analyses.push({source:'v1.1',analysis:next.analysis});
    }
    else if(scope.source==='v1'){
      const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
       ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.dependencyDigest,
       method:STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD};
      let cursor:StorageHistoryLoadCursor|undefined,head:string|null=null;
      let checkpoint:StorageV1HistoryCheckpoint|undefined;
      for(;;){
       if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)
        return {state:'deferred',reason:'current_fit_checkpoint_read_budget'};
       const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
        ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
       if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
       head=loaded.headDigest??null;if(loaded.status==='ready'){
        if('source'in loaded.checkpoint)throw fail();checkpoint=loaded.checkpoint;
       }break;
      }
      const pin=scope.pin;
      const advance=(savedCheckpoint:typeof checkpoint,maxPages:number)=>advanceStorageV1CurrentFitAnalysis({
       source,participantId:scope.owner.participantId,day:scope.day,sourcePin:pin,
       checkpoint:savedCheckpoint,maxPages,budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),
        deadlineMs:checkpointWorkDeadlineMs,now}});
      const next=await advance(checkpoint,STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM);
      if(next.status==='complete')analyses.push({source:'v1',analysis:next.analysis});
      else {
       if(!next.checkpoint)return {state:'deferred',reason:'current_fit_checkpoint'};
       const saved=await persistCheckpoint(key,next.checkpoint,head,'current_fit_checkpoint');
       if(saved.state==='deferred')return saved;
       if(saved.head===head)return {state:'deferred',reason:'current_fit_checkpoint'};
       if(next.checkpoint.phase==='finish'){
        const finished=await advance(next.checkpoint,1);
        if(finished.status==='complete')analyses.push({source:'v1',analysis:finished.analysis});
       }
      }
      if(!analyses.some(analysis=>analysis.source==='v1')){
       return {state:'deferred',reason:'current_fit_checkpoint'};
      }
    }
    else if(scope.source!=='v0.2')analyses.push({source:'v1',analysis:await accountScopedQuotaAnalysisV1(source,
      scope.owner.participantId,{nowMs,sourcePin:scope.pin})});
    if(scope.source==='mixed'||scope.source==='v0.2')analyses.push({source:'v0.2',
      analysis:await accountScopedQuotaAnalysis(source,scope.owner.participantId)});
    if(analyses.some(a=>!validCompleteScalarAnalysis(a.analysis,a.source,
      a.source==='v1.1'?v11CompletedFingerprint??scope.pin.fingerprint:scope.pin.fingerprint,
      !(scope.source==='v1'&&a.source==='v1'))))throw fail();
    payload=canonicalJson(selectCommunityAllowanceAnalysisFits(scope.owner.ownerDigest,analyses));
  } else {
    let composition:V1ModelCompositionResult | null=null;
    if('source' in scope.pin){
      const next=await computeV11('model',scope.pin);if(next.state==='deferred')return next;
      composition=next.analysis as V1ModelCompositionResult;
    }
    else {
      const window=modelHistoryWindow(scope.day);
      const overlap=scope.source==='mixed'?await source.prepare(`SELECT 1 FROM telemetry_records r
        WHERE r.participant_id=? AND r.record_kind='quota' AND r.provider='openai_codex' AND r.limit_id='codex'
          AND r.observed_at>=? AND r.observed_at<? AND EXISTS(SELECT 1 FROM telemetry_contribution_occurrences o
            JOIN telemetry_contributions c ON c.id=o.contribution_id WHERE o.participant_id=r.participant_id
              AND o.record_kind=r.record_kind AND o.occurrence_id=r.occurrence_id AND c.status='accepted'
              AND c.transport_schema_version='telemetry-contribution-v0.2') LIMIT 1`)
        .bind(scope.owner.participantId,window.observedAtCutoff,window.observedAtBefore).first():null;
      if(scope.source==='v0.2'||overlap)payload=canonicalJson({status:'unsupported_source',reason:'legacy_source_overlap'});
      else {
        // Durable intent precedes the direct read. If its response is lost or
        // execution fails, a retry takes the resumable reader instead of
        // repeating an oversized SQL reduction indefinitely.
        const executionAttemptDigest=await sha256Hex(canonicalJson([
          scope.dependencyDigest,STORAGE_GRAPH_DIRECT_HISTORY_READER_REVISION]));
        const attempt=await bindings.target.prepare(`INSERT INTO analytics_community_graph_execution
          VALUES(?,?,?,?,'checkpoint') ON CONFLICT(source_id,owner_digest,day) DO UPDATE SET
          dependency_digest=excluded.dependency_digest WHERE dependency_digest!=excluded.dependency_digest`)
          .bind(bindings.sourceId,scope.owner.ownerDigest,scope.day,executionAttemptDigest).run();
        if(attempt.meta.changes===1) {
          try {composition=await accountScopedHistoricalModelCompositionV1(source,
            scope.owner.participantId,scope.day,{sourcePin:scope.pin});}
          catch(error) {
            const failure=caughtStorageGraphFailureFields('graph_history_direct_read',error);
            return {state:'deferred',reason:'direct_read_unavailable',...(failure?{failure}:{})};
          }
        }
        else {
          const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
            ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.dependencyDigest,
            method:STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD};
          let cursor:StorageHistoryLoadCursor|undefined;
          let head:string|null=null;
          let checkpoint:StorageV1HistoryCheckpoint|undefined;
          for(;;) {
            if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)
              return {state:'deferred',reason:'checkpoint_read_budget'};
            const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
              ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
            if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
            head=loaded.headDigest??null;
            if(loaded.status==='ready'){
              if('source'in loaded.checkpoint)throw fail();checkpoint=loaded.checkpoint;
            }
            break;
          }
          const pin=scope.pin;
          const advance=(savedCheckpoint:typeof checkpoint,maxPages:number)=>advanceStorageV1HistoricalAnalysis({
            source,participantId:scope.owner.participantId,day:scope.day,sourcePin:pin,
            checkpoint:savedCheckpoint,maxPages,budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),
              deadlineMs:checkpointWorkDeadlineMs,now}});
          const next=await advance(checkpoint,STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM);
          if(next.status==='complete')composition=next.analysis;
          else {
            if(!next.checkpoint)return {state:'deferred',reason:'historical_checkpoint'};
            const saved=await persistCheckpoint(key,next.checkpoint,head,'historical_checkpoint');
            if(saved.state==='deferred')return saved;
            if(saved.head===head)return {state:'deferred',reason:'historical_checkpoint'};
            if(next.checkpoint.phase==='finish'){
              const finished=await advance(next.checkpoint,1);
              if(finished.status==='complete')composition=finished.analysis;
            }
          }
          if(composition===null)return {state:'deferred',reason:'historical_checkpoint'};
        }
      }
    }
    const method=scope.source==='v1.1'?V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:MODEL_HISTORY_METHOD_VERSION;
    if(composition!==null) {
      if(!validCompleteCachedComposition(composition,scope.pin.fingerprint,method))throw fail();
      payload=canonicalJson(composition);
    }
  }
  if(!payload)throw fail();
  if(new TextEncoder().encode(payload).byteLength>MAX_RESULT_BYTES)return {state:'deferred',reason:'result_size_limit'};
  if(!await current(source,scope))return {state:'deferred',reason:'authority_changed'};
  await targetReady(bindings.target,scope);
  const hash=await sha256Hex(payload);
  await bindings.target.prepare(`INSERT INTO analytics_community_graph_results
    (source_id,owner_digest,metric,day,method,dependency_digest,input_revision,payload_fingerprint,
      payload_json,payload_sha256,authority_json,computed_ms,source_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,owner_digest,metric,day) DO UPDATE SET method=excluded.method,
      dependency_digest=excluded.dependency_digest,input_revision=excluded.input_revision,
      payload_fingerprint=excluded.payload_fingerprint,payload_json=excluded.payload_json,
      payload_sha256=excluded.payload_sha256,authority_json=excluded.authority_json,computed_ms=excluded.computed_ms,
      source_kind=excluded.source_kind
    WHERE excluded.input_revision>=analytics_community_graph_results.input_revision`)
    .bind(bindings.sourceId,scope.owner.ownerDigest,scope.metric,scope.day,STORAGE_GRAPH_METHOD,
      scope.dependencyDigest,scope.owner.inputRevision,scope.pin.fingerprint,payload,hash,
      canonicalJson(scope.authority),Date.now(),scope.source).run();
  const result=await readStorageGraphResult(bindings,scope);
  return result?{state:'complete',result,reused:false}:{state:'deferred',reason:'source_changed'};
}
