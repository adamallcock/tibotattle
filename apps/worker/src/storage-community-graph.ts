import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { accountScopedQuotaAnalysis } from './quota-analysis';
import { accountScopedQuotaAnalysisV1, accountScopedHistoricalModelCompositionV1,
  MODEL_HISTORY_METHOD_VERSION, type V1ModelCompositionResult } from './quota-analysis-v1';
import { accountScopedQuotaAnalysisV11, accountScopedModelCompositionV11,
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';
import { assertV11SourcePinCurrent } from './telemetry-v11-domain';
import { assertV1SourcePinCurrent, loadV1SourcePin } from './telemetry-v1-source-selection';
import { modelHistoryWindow } from './model-history-window';
import { communityAnalysisCacheVersion, loadCommunitySourcePin, parsedCachedFits,
  selectCommunityAllowanceAnalysisFits, validCompleteCachedComposition, validCompleteScalarAnalysis,
  type CommunityAllowanceFit } from './community-allowance';
import { captureStorageCommunityAuthority, sameStorageCommunityAuthority, storageCommunityAuthorityIsCurrent,
  type StorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { advanceStorageV1HistoricalAnalysis } from './storage-v1-history';
import { loadStorageHistoryCheckpoint, saveStorageHistoryCheckpoint,
  type StorageHistoryKey, type StorageHistoryLoadCursor } from './storage-history-checkpoint';

export const STORAGE_GRAPH_METHOD = communityAnalysisCacheVersion() + ':separate-results-1';
const MAX_RESULT_BYTES = 1024 * 1024;
const fail = () => new Error('STORAGE_GRAPH_RESULT_UNAVAILABLE');
export type StorageGraphSource = 'v0.2' | 'v1' | 'v1.1' | 'mixed';
type Source = StorageGraphSource;
type Pin = Awaited<ReturnType<typeof loadCommunitySourcePin>>['sourcePin'];
export interface StorageGraphScope {
  authority: StorageCommunityAuthority; owner: StorageCommunityOwner & {ownerDigest:string};
  source: Source; pin: Pin; day: string; fixedNow: string; metric:'fits'|'model';
  dependencyDigest:string;
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
  const loaded=await loadCommunitySourcePin(sourceDb,owner.participantId,history.fromDay,source,
    {includeDayDependencies:true});
  if(options.metric==='model' && !('source' in loaded.sourcePin)) {
    loaded.sourcePin=await loadV1SourcePin(sourceDb,{participantId:owner.participantId,fromDay:history.fromDay,
      throughDay:history.day},{includeDayDependencies:true});
  }
  if(loaded.sourcePin.inputRevision!==owner.inputRevision)throw fail();
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
  if(!await storageCommunityAuthorityIsCurrent(sourceDb,authority))throw fail();
  return {authority,owner:owner as StorageGraphScope['owner'],source,pin:loaded.sourcePin,
    day:history.day,fixedNow:history.fixedNow,metric:options.metric,dependencyDigest};
}

async function current(source:D1Database,scope:StorageGraphScope):Promise<boolean> {
  if('source' in scope.pin)await assertV11SourcePinCurrent(source,scope.pin);
  else await assertV1SourcePinCurrent(source,scope.pin);
  return storageCommunityAuthorityIsCurrent(source,scope.authority);
}
async function targetReady(target:D1Database,scope:StorageGraphScope):Promise<void> {
  if(!await target.prepare(`SELECT 1 FROM analytics_runtime_sources WHERE source_id=?
    AND source_namespace=? AND contract_version=1`).bind(scope.authority.sourceId,scope.authority.sourceNamespace).first())throw fail();
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
  if(!authority||!sameStorageCommunityAuthority(authority,scope.authority)
    ||new TextEncoder().encode(row.payload_json).byteLength>MAX_RESULT_BYTES
    ||await sha256Hex(row.payload_json)!==row.payload_sha256)return null;
  const result=decoded(row,scope);
  return result && await current(bindings.source,scope)?result:null;
}

/** Runs the existing kernels against read-only source evidence. Only their
 * completed, validated output is persisted in analytics. A target failure has
 * no transaction, cache write or backpressure hook in ingestion. */
export async function computeStorageGraphResult(bindings:StorageAnalyticsBindings,scope:StorageGraphScope,
  options:{maxQueries?:number;deadlineMs?:number}={}):Promise<
  {state:'complete';result:StorageGraphResult;reused:boolean}|{state:'deferred';reason:string}> {
  if(bindings.source===bindings.target)throw fail();
  const meter=createD1InvocationBudget(options.maxQueries??900),deadlineMs=options.deadlineMs??Date.now()+20_000;
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
  let payload='';
  if(scope.metric==='fits') {
    const analyses:Array<{source:'v0.2'|'v1'|'v1.1';analysis:object}>=[];
    if('source' in scope.pin)analyses.push({source:'v1.1',analysis:await accountScopedQuotaAnalysisV11(source,
      scope.owner.participantId,{nowMs,sourcePin:scope.pin})});
    else if(scope.source!=='v0.2')analyses.push({source:'v1',analysis:await accountScopedQuotaAnalysisV1(source,
      scope.owner.participantId,{nowMs,sourcePin:scope.pin})});
    if(scope.source==='mixed'||scope.source==='v0.2')analyses.push({source:'v0.2',
      analysis:await accountScopedQuotaAnalysis(source,scope.owner.participantId)});
    if(analyses.some(a=>!validCompleteScalarAnalysis(a.analysis,a.source,scope.pin.fingerprint,true)))throw fail();
    payload=canonicalJson(selectCommunityAllowanceAnalysisFits(scope.owner.ownerDigest,analyses));
  } else {
    let composition:V1ModelCompositionResult | null=null;
    if('source' in scope.pin)composition=await accountScopedModelCompositionV11(source,scope.owner.participantId,
      {nowMs,sourcePin:scope.pin});
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
        const attempt=await bindings.target.prepare(`INSERT INTO analytics_community_graph_execution
          VALUES(?,?,?,?,'checkpoint') ON CONFLICT(source_id,owner_digest,day) DO UPDATE SET
          dependency_digest=excluded.dependency_digest WHERE dependency_digest!=excluded.dependency_digest`)
          .bind(bindings.sourceId,scope.owner.ownerDigest,scope.day,scope.dependencyDigest).run();
        if(attempt.meta.changes===1) {
          try {composition=await accountScopedHistoricalModelCompositionV1(source,
            scope.owner.participantId,scope.day,{sourcePin:scope.pin});}
          catch {return {state:'deferred',reason:'direct_read_unavailable'};}
        }
        else {
          const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
            ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.dependencyDigest,method:STORAGE_GRAPH_METHOD};
          let cursor:StorageHistoryLoadCursor|undefined;
          let head:string|null=null,checkpoint;
          for(;;) {
            if(meter.remainingQueries<50||Date.now()>=deadlineMs)return {state:'deferred',reason:'checkpoint_read_budget'};
            const loaded=await loadStorageHistoryCheckpoint({target:bindings.target,key,cursor});
            if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
            head=loaded.headDigest??null;
            if(loaded.status==='ready')checkpoint=loaded.checkpoint;
            break;
          }
          const next=await advanceStorageV1HistoricalAnalysis({source,participantId:scope.owner.participantId,
            day:scope.day,sourcePin:scope.pin,checkpoint,budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),deadlineMs}});
          if(next.status==='complete')composition=next.analysis;
          else {
            if(next.checkpoint && await current(source,scope)) {
              while(meter.remainingQueries>=40&&Date.now()<deadlineMs) {
                const saved=await saveStorageHistoryCheckpoint({target:bindings.target,key,checkpoint:next.checkpoint,expectedHead:head});
                if(saved.status==='saved')break;
              }
            }
            return {state:'deferred',reason:'historical_checkpoint'};
          }
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
