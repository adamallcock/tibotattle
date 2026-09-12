import { projectAdminModelHistoryDay } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { buildAdminCommunityAllowancePreview, buildCommunityModelCompositionDay,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS, ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS, ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  PREVIEW_CACHE_JSON_LIMIT_BYTES, validCachedAdminCommunityAllowancePreview,
  type AdminCommunityModelCompositionDay, type AdminCommunityAllowancePreview } from './admin-community-allowance';
import { parsedCachedFits, validCompleteCachedComposition,
  type CommunityAllowanceFit, type CachedCommunityModelCompositions } from './community-allowance';
import { MODEL_HISTORY_METHOD_VERSION, type V1ModelCompositionResult } from './quota-analysis-v1';
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';
import { STORAGE_GRAPH_METHOD, storageGraphDependencyDigest } from './storage-community-graph';
import { modelHistoryWindow } from './model-history-window';
import { MAX_V1_SOURCE_CHUNKS, selectV1SourceDayDependencies, type V1SourceChunk } from './telemetry-v1-source-selection';
import { captureStorageCommunityAuthority, captureStorageCommunityRetirementAuthority, readStorageCommunityOwnerPage, sameStorageCommunityAuthority,
  storageCommunityAuthorityIsCurrent, type StorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import type { PublicAllowanceBreakdownsCacheRow } from './public-allowance-breakdowns';

const DAY_MS=86_400_000, MAX_COHORT_BYTES=2*1024*1024, MAX_FITS_BYTES=16*1024*1024,
  MAX_DEPENDENCY_BYTES=16*1024*1024;
const fail=()=>new Error('STORAGE_GRAPH_PUBLICATION_UNAVAILABLE');
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;
export type StorageGraphPublicationProgress = {state:'published'|'unchanged';memberCount:number}
  |{state:'deferred';reason:'cache_pending'|'source_changed'|'capacity';memberCount:number};
function validDay(day:string):void {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw fail();
}
function identity(owner:StorageCommunityOwner) {
  return {ownerDigest:owner.ownerDigest,inputRevision:owner.inputRevision,ownerRevision:owner.ownerRevision,
    hasV1:owner.hasV1,hasV11:owner.hasV11,hasLegacy:owner.hasLegacy};
}
async function owners(source:D1Database):Promise<StorageCommunityOwner[]|null|'capacity'> {
  const result:StorageCommunityOwner[]=[];let after='',size=0;
  for(;;){
    const page=await readStorageCommunityOwnerPage(source,{afterParticipantId:after});
    for(const owner of page){
      // Enrollment alone is not an uploading cohort member. A legacy uploader
      // without its journal bootstrap remains pending, never silently excluded.
      if(!owner.hasV1&&!owner.hasV11&&!owner.hasLegacy)continue;
      if(!owner.ownerDigest)return null;
      size+=bytes(canonicalJson(identity(owner)));if(size>MAX_COHORT_BYTES)return 'capacity';
      result.push(owner);
    }
    if(page.length<64)return result;after=page.at(-1)!.participantId;
  }
}
async function ready(bindings:StorageAnalyticsBindings):Promise<void> {
  if(bindings.source===bindings.target||!await bindings.target.prepare(`SELECT 1 FROM analytics_runtime_sources
    WHERE source_id=? AND source_namespace=? AND contract_version=1`).bind(bindings.sourceId,bindings.sourceNamespace).first())throw fail();
}
interface CapturedResult {
  owner:StorageCommunityOwner; source:'v0.2'|'v1'|'v1.1'|'mixed'; dependencyDigest:string;
  fits:CommunityAllowanceFit[]|null;composition:V1ModelCompositionResult|null;unsupportedSource?:boolean;
  inputCurrent:boolean;computedMs:number;sourceEpoch:number;sequence:number;
}
interface Capture {authority:StorageCommunityAuthority;members:StorageCommunityOwner[];results:CapturedResult[];}
interface CaptureCapacity {deferred:'capacity';memberCount:number;}
interface ResultRow {
  owner_digest:string;input_revision:number;dependency_digest:string;payload_json:string|null;
  payload_fingerprint:string;payload_sha256:string;authority_json:string;
  source_kind:CapturedResult['source'];computed_ms:number;
}

/** Read bounded immutable header metadata only, never telemetry records. SQL
 * withholds an oversized page before transferring it to the Worker. */
async function dependencyMetadata<T>(source:D1Database,sql:string,args:Array<string|number>,maxRows:number,
  budget:{remaining:number}):Promise<T[]|'capacity'> {
  const rows=(await source.prepare(`WITH selected AS MATERIALIZED (${sql} LIMIT ?),
    budget AS MATERIALIZED (SELECT count(*) n,COALESCE(SUM(length(CAST(row_json AS BLOB))),0) size FROM selected)
    SELECT CASE WHEN budget.n<=? AND budget.size<=? THEN row_json ELSE NULL END row_json
    FROM selected CROSS JOIN budget`).bind(...args,maxRows+1,maxRows,budget.remaining)
    .all<{row_json:string|null}>()).results;
  if(rows.some(row=>row.row_json===null))return 'capacity';
  const size=rows.reduce((sum,row)=>sum+bytes(row.row_json!),0);
  if(size>budget.remaining)return 'capacity';budget.remaining-=size;
  return rows.map(row=>JSON.parse(row.row_json!) as T);
}

/** A whole-owner input revision advances on today's append. Closed historical
 * values instead depend on the exact selected manifests/winning chunk vector.
 * Revalidate those identities in owner pages, then retain the final full source
 * fence. This neither accepts changed evidence nor rewrites calculation time. */
async function closedDependencies(bindings:StorageAnalyticsBindings,authority:StorageCommunityAuthority,
  page:StorageCommunityOwner[],day:string,budget:{remaining:number}):Promise<Map<string,string>|'capacity'|null> {
  const window=modelHistoryWindow(day),result=new Map<string,string>();
  if(page.some(owner=>!owner.hasV11&&(owner.hasLegacy||!owner.hasV1)))return null;
  const v11=page.filter(owner=>owner.hasV11);
  if(v11.length){
    type Day={participant_id:string;observed_day:string;id:string;manifest_digest:string;device_id:string};
    const rows=await dependencyMetadata<Day>(bindings.source,`SELECT json_object(
      'participant_id',h.participant_id,'observed_day',d.observed_day,'id',m.id,
      'manifest_digest',m.manifest_digest,'device_id',m.device_id) row_json
      FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domain_days d ON d.generation_id=h.generation_id
      JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
      WHERE h.participant_id IN(${v11.map(()=>'?').join(',')}) AND d.observed_day>=? AND d.observed_day<=?
      ORDER BY h.participant_id,d.observed_day`,[...v11.map(owner=>owner.participantId),window.fromDay,window.day],v11.length*101,budget);
    if(rows==='capacity')return rows;
    const grouped=new Map(v11.map(owner=>[owner.participantId,[] as Omit<Day,'participant_id'>[]]));
    for(const {participant_id,...row} of rows){const values=grouped.get(participant_id);if(!values)return null;values.push(row);}
    for(const owner of v11){
      const dependency=grouped.get(owner.participantId)!;if(dependency.length>101)return null;
      result.set(owner.ownerDigest!,await storageGraphDependencyDigest({authority,ownerDigest:owner.ownerDigest!,
        source:'v1.1',metric:'model',day,dependency}));
    }
  }
  const v1=page.filter(owner=>!owner.hasV11);
  if(v1.length){
    const rows=await dependencyMetadata<V1SourceChunk>(bindings.source,`SELECT json_object(
      'id',c.id,'participant_id',c.participant_id,'device_id',c.device_id,'chunk_day',c.chunk_day,
      'stream',c.stream,'revision',c.revision,'chunk_digest',c.chunk_digest,'parser_version',c.parser_version,
      'accepted_record_count',c.accepted_record_count,'created_at',c.created_at) row_json
      FROM telemetry_analytical_chunks c JOIN participants p ON p.id=c.participant_id AND p.state='active'
      WHERE c.participant_id IN(${v1.map(()=>'?').join(',')}) AND c.accepted_record_count>0
        AND c.chunk_day>=? AND c.chunk_day<=? ORDER BY c.participant_id,c.chunk_day,c.device_id,c.stream,c.id`,
      [...v1.map(owner=>owner.participantId),window.fromDay,window.day],MAX_V1_SOURCE_CHUNKS,budget);
    if(rows==='capacity')return rows;
    const grouped=new Map(v1.map(owner=>[owner.participantId,[] as V1SourceChunk[]]));
    for(const row of rows){const values=grouped.get(row.participant_id);if(!values)return null;values.push(row);}
    for(const owner of v1)result.set(owner.ownerDigest!,await storageGraphDependencyDigest({authority,
      ownerDigest:owner.ownerDigest!,source:'v1',metric:'model',day,
      dependency:await selectV1SourceDayDependencies(grouped.get(owner.participantId)!)}));
  }
  return result;
}
async function capture(bindings:StorageAnalyticsBindings,day:string,metric:'fits'|'model'):Promise<Capture|CaptureCapacity|null> {
  validDay(day);await ready(bindings);
  const authority=await captureStorageCommunityAuthority(bindings.source,bindings),members=await owners(bindings.source);
  if(members===null)return null;
  if(members==='capacity')return {deferred:'capacity',memberCount:0};
  const results:CapturedResult[]=[],dependencyBudget={remaining:MAX_DEPENDENCY_BYTES};let size=0;
  for(let offset=0;offset<members.length;offset+=32){
    const page=members.slice(offset,offset+32);
    // A completed cache is bound to the owner's source input revision. That
    // revision changes on every relevant accepted mutation. Equality plus the
    // final full-cohort/source fence makes repeated per-owner pin acquisition
    // unnecessary here. Older closed-window values additionally require exact
    // metadata equality. Current fits may form an explicitly dated completed
    // snapshot only across the same hard authority and source-format proof.
    const rows=(await bindings.target.prepare(`WITH selected AS MATERIALIZED (
      SELECT owner_digest,input_revision,dependency_digest,payload_json,payload_fingerprint,payload_sha256,authority_json,source_kind,computed_ms
      FROM analytics_community_graph_results WHERE source_id=? AND metric=? AND day=? AND method=?
        AND owner_digest IN(${page.map(()=>'?').join(',')})
      ),budget AS MATERIALIZED (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) n FROM selected)
      SELECT owner_digest,input_revision,dependency_digest,
        CASE WHEN budget.n<=? THEN payload_json ELSE NULL END payload_json,
        payload_fingerprint,payload_sha256,authority_json,source_kind,computed_ms FROM selected CROSS JOIN budget ORDER BY owner_digest`)
      .bind(bindings.sourceId,metric,day,STORAGE_GRAPH_METHOD,...page.map(owner=>owner.ownerDigest!),MAX_FITS_BYTES-size)
      .all<ResultRow>()).results;
    if(rows.length!==page.length)return null;
    const byOwner=new Map(rows.map(row=>[row.owner_digest,row]));
    const stale=page.filter(owner=>byOwner.get(owner.ownerDigest!)?.input_revision!==owner.inputRevision);
    const revalidated=stale.length&&metric==='model'
      ?await closedDependencies(bindings,authority,stale,day,dependencyBudget):null;
    if(revalidated==='capacity')return {deferred:'capacity',memberCount:members.length};
    for(const owner of page){
      const row=byOwner.get(owner.ownerDigest!);
      if(row?.payload_json===null)return {deferred:'capacity',memberCount:members.length};
      const source=owner.hasV11?'v1.1':owner.hasV1?owner.hasLegacy?'mixed':'v1':'v0.2';
      const rowAuthority=row?JSON.parse(row.authority_json) as StorageCommunityAuthority:null;
      if(!row||row.input_revision>owner.inputRevision
        ||!Number.isSafeInteger(row.input_revision)||row.input_revision<0||row.source_kind!==source
        ||(metric==='model'&&row.input_revision!==owner.inputRevision&&revalidated?.get(owner.ownerDigest!)!==row.dependency_digest)
        ||!/^[a-f0-9]{64}$/.test(row.dependency_digest)
        ||!rowAuthority||!sameStorageCommunityAuthority(rowAuthority,authority)
        ||!Number.isSafeInteger(rowAuthority.sourceEpoch)||rowAuthority.sourceEpoch<0||rowAuthority.sourceEpoch>authority.sourceEpoch
        ||!Number.isSafeInteger(rowAuthority.sequence)||rowAuthority.sequence<0||rowAuthority.sequence>authority.sequence
        ||!Number.isSafeInteger(row.computed_ms)||row.computed_ms<0||row.computed_ms>Date.now()+300_000
        ||bytes(row.payload_json)>1024*1024||await sha256Hex(row.payload_json)!==row.payload_sha256)return null;
      size+=bytes(row.payload_json);if(size>MAX_FITS_BYTES)return {deferred:'capacity',memberCount:members.length};
      const result:CapturedResult={owner,source,dependencyDigest:row.dependency_digest,fits:null,composition:null,
        inputCurrent:row.input_revision===owner.inputRevision,computedMs:row.computed_ms,
        sourceEpoch:rowAuthority.sourceEpoch,sequence:rowAuthority.sequence};
      if(metric==='fits'){
        result.fits=parsedCachedFits(row.payload_json,owner.ownerDigest!);if(result.fits===null)return null;
      } else {
        const composition:unknown=JSON.parse(row.payload_json);
        if(canonicalJson(composition)==='{"reason":"legacy_source_overlap","status":"unsupported_source"}'){
          if(source!=='v0.2'&&source!=='mixed')return null;result.unsupportedSource=true;
        } else {
          const method=source==='v1.1'?V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:MODEL_HISTORY_METHOD_VERSION;
          if(!validCompleteCachedComposition(composition,row.payload_fingerprint,method))return null;
          result.composition=composition;
        }
      }
      results.push(result);
    }
  }
  return {authority,members,results};
}
async function current(bindings:StorageAnalyticsBindings,captured:Capture):Promise<boolean> {
  const latest=await owners(bindings.source);
  return Array.isArray(latest)&&canonicalJson(latest.map(identity))===canonicalJson(captured.members.map(identity))
    && await storageCommunityAuthorityIsCurrent(bindings.source,captured.authority,true);
}
function cohortProof(captured:Capture) {
  // Exact window dependencies decide value reuse. Global inputRevision is a
  // calculation fence, never the identity of an unchanged historical result.
  return captured.results.map(s=>[s.owner.ownerDigest,s.source,s.dependencyDigest]);
}
function hardAuthority(authority:StorageCommunityAuthority) {return {...authority,sequence:0,sourceEpoch:0};}
interface PreviewFreshness {
  snapshot_source_epoch:number;inputs_current:0|1;oldest_computed_ms:number|null;newest_computed_ms:number|null;
}
function previewProof(captured:Capture):{authority:StorageCommunityAuthority;freshness:PreviewFreshness} {
  const inputsCurrent=captured.results.every(result=>result.inputCurrent),times=captured.results.map(result=>result.computedMs);
  return {authority:inputsCurrent?captured.authority:{...captured.authority,
    // This lower watermark is a completed-input proof, not a fabricated common
    // raw snapshot. The separately captured epoch owns the publication CAS.
    sourceEpoch:Math.min(...captured.results.map(result=>result.sourceEpoch)),
    sequence:Math.min(...captured.results.map(result=>result.sequence))},
    freshness:{snapshot_source_epoch:captured.authority.sourceEpoch,inputs_current:inputsCurrent?1:0,
      oldest_computed_ms:times.length?Math.min(...times):null,newest_computed_ms:times.length?Math.max(...times):null}};
}
function sameFreshness(left:PreviewFreshness,right:PreviewFreshness):boolean {
  return left.snapshot_source_epoch===right.snapshot_source_epoch&&left.inputs_current===right.inputs_current
    &&left.oldest_computed_ms===right.oldest_computed_ms&&left.newest_computed_ms===right.newest_computed_ms;
}
function validFreshness(value:PreviewFreshness,authority:StorageCommunityAuthority,nowMs:number):boolean {
  return Number.isSafeInteger(authority.sourceEpoch)&&authority.sourceEpoch>=0
    &&Number.isSafeInteger(authority.sequence)&&authority.sequence>=0
    &&Number.isSafeInteger(value.snapshot_source_epoch)&&value.snapshot_source_epoch>=authority.sourceEpoch
    &&[0,1].includes(value.inputs_current)
    &&(value.inputs_current!==1||value.snapshot_source_epoch===authority.sourceEpoch)
    &&((value.oldest_computed_ms===null&&value.newest_computed_ms===null)
      ||(Number.isSafeInteger(value.oldest_computed_ms)&&Number.isSafeInteger(value.newest_computed_ms)
        &&value.oldest_computed_ms!>=0&&value.newest_computed_ms!>=value.oldest_computed_ms!
        &&value.newest_computed_ms!<=nowMs+300_000));
}

/** Publish one real historical window. A missing owner result withholds this
 * point; a proved not-testable result contributes its actual refusal count. */
export async function publishStorageCommunityModelDay(bindings:StorageAnalyticsBindings,
  options:{day:string;nowMs?:number}):Promise<StorageGraphPublicationProgress> {
  const captured=await capture(bindings,options.day,'model');
  if(!captured)return {state:'deferred',reason:'cache_pending',memberCount:0};
  if('deferred' in captured)return {state:'deferred',reason:captured.deferred,memberCount:captured.memberCount};
  const collection:CachedCommunityModelCompositions={compositions:[],v1ParticipantCount:0,
    unsupportedSourceParticipantCount:0,refusedParticipantCount:0,storeAvailable:true};
  for(const result of captured.results){
    if(result.unsupportedSource){collection.unsupportedSourceParticipantCount++;continue;}
    if(!result.composition)return {state:'deferred',reason:'cache_pending',memberCount:captured.members.length};
    collection.v1ParticipantCount++;
    if(result.composition.status==='ready')collection.compositions.push({participantId:result.owner.ownerDigest!,composition:result.composition});
    else collection.refusedParticipantCount++;
  }
  const payload=buildCommunityModelCompositionDay(collection,options.day),payloadJson=canonicalJson(payload);
  if(bytes(payloadJson)>16*1024)return {state:'deferred',reason:'capacity',memberCount:captured.members.length};
  const cohortDigest=await sha256Hex(canonicalJson([STORAGE_GRAPH_METHOD,options.day,cohortProof(captured),hardAuthority(captured.authority)]));
  const previous=await bindings.target.prepare(`SELECT revision,cohort_digest,payload_json,payload_sha256 FROM analytics_community_model_publications
    WHERE source_id=? AND day=?`).bind(bindings.sourceId,options.day).first<{
      revision:number;cohort_digest:string;payload_json:string;payload_sha256:string}>();
  if(!await current(bindings,captured))return {state:'deferred',reason:'source_changed',memberCount:captured.members.length};
  if(previous?.cohort_digest===cohortDigest&&previous.payload_json===payloadJson
    &&await sha256Hex(previous.payload_json)===previous.payload_sha256)
    return {state:'unchanged',memberCount:captured.members.length};
  const computedMs=options.nowMs??Date.now();if(!Number.isFinite(computedMs))throw fail();
  const payloadHash=await sha256Hex(payloadJson);
  try {await bindings.target.prepare(`INSERT INTO analytics_community_model_publications
    (source_id,day,revision,method,cohort_digest,authority_json,payload_json,payload_sha256,computed_ms)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,day) DO UPDATE SET revision=excluded.revision,method=excluded.method,
      cohort_digest=excluded.cohort_digest,authority_json=excluded.authority_json,payload_json=excluded.payload_json,
      payload_sha256=excluded.payload_sha256,computed_ms=excluded.computed_ms
    WHERE analytics_community_model_publications.revision=?
      AND json_extract(analytics_community_model_publications.authority_json,'$.sourceEpoch')<=?
      AND analytics_community_model_publications.computed_ms<=?`).bind(bindings.sourceId,options.day,(previous?.revision??0)+1,
      STORAGE_GRAPH_METHOD,cohortDigest,canonicalJson(captured.authority),payloadJson,payloadHash,computedMs,
      previous?.revision??0,captured.authority.sourceEpoch,computedMs).run();}catch{ /* Reconcile an uncertain write by its exact cohort receipt. */ }
  const receipt=await bindings.target.prepare(`SELECT cohort_digest,payload_json,payload_sha256 FROM analytics_community_model_publications
    WHERE source_id=? AND day=?`).bind(bindings.sourceId,options.day)
    .first<{cohort_digest:string;payload_json:string;payload_sha256:string}>();
  return receipt?.cohort_digest===cohortDigest&&receipt.payload_sha256===payloadHash&&receipt.payload_json===payloadJson
    ?{state:'published',memberCount:captured.members.length}
    :{state:'deferred',reason:'source_changed',memberCount:captured.members.length};
}

/** The complete current fit cohort and independently completed historical
 * model days form one existing preview DTO. No model point is carried backward. */
export async function publishStorageCommunityGraphPreview(bindings:StorageAnalyticsBindings,
  options:{nowMs?:number}={}):Promise<StorageGraphPublicationProgress> {
  const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw fail();
  const today=new Date(nowMs).toISOString().slice(0,10),captured=await capture(bindings,today,'fits');
  if(!captured)return {state:'deferred',reason:'cache_pending',memberCount:0};
  if('deferred' in captured)return {state:'deferred',reason:captured.deferred,memberCount:captured.memberCount};
  const fits:CommunityAllowanceFit[]=[];
  for(const result of captured.results){if(result.fits===null)return {state:'deferred',reason:'cache_pending',memberCount:captured.members.length};
    fits.push(...result.fits);}
  const from=new Date(Date.parse(today)-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS).toISOString().slice(0,10);
  const results=await bindings.target.batch([
    bindings.target.prepare(`SELECT day,payload_json,payload_sha256,authority_json FROM analytics_community_model_publications
      WHERE source_id=? AND day BETWEEN ? AND ? AND method=? ORDER BY day LIMIT ?`)
      .bind(bindings.sourceId,from,today,STORAGE_GRAPH_METHOD,ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS+1),
    bindings.target.prepare(`SELECT model_revision FROM analytics_community_graph_publication_state WHERE source_id=?`).bind(bindings.sourceId),
    bindings.target.prepare(`SELECT revision,cohort_digest,payload_json,payload_sha256,authority_json,
      snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms
      FROM analytics_community_graph_previews WHERE source_id=?`).bind(bindings.sourceId),
  ]);
  const days:AdminCommunityModelCompositionDay[]=[];
  const modelRevision=Number((results[1]!.results[0] as {model_revision:number}|undefined)?.model_revision??0);
  for(const raw of results[0]!.results){
    const row=raw as {day:string;payload_json:string;payload_sha256:string;authority_json:string};
    const pin=JSON.parse(row.authority_json) as StorageCommunityAuthority;
    if(!sameStorageCommunityAuthority(pin,captured.authority))continue;
    if(bytes(row.payload_json)>16*1024||await sha256Hex(row.payload_json)!==row.payload_sha256)throw fail();
    const parsed=projectAdminModelHistoryDay(JSON.parse(row.payload_json));
    if(!parsed||parsed.day!==row.day)throw fail();days.push(parsed);
  }
  if(days.length>ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS)throw fail();
  const preview=buildAdminCommunityAllowancePreview(fits,nowMs,captured.members.map(m=>m.ownerDigest!),{
    modelConfig:ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,basis:ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate:ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,days});
  const payloadJson=canonicalJson(preview);
  if(!validCachedAdminCommunityAllowancePreview(preview,preview.generatedAt,nowMs)
    ||bytes(payloadJson)>PREVIEW_CACHE_JSON_LIMIT_BYTES)return {state:'deferred',reason:'capacity',memberCount:captured.members.length};
  const cohortDigest=await sha256Hex(canonicalJson([STORAGE_GRAPH_METHOD,today,cohortProof(captured),modelRevision,hardAuthority(captured.authority)]));
  const previous=results[2]!.results[0] as (PreviewFreshness&{revision:number;cohort_digest:string;payload_json:string;
    payload_sha256:string;authority_json:string})|undefined;
  const proof=previewProof(captured),authorityJson=canonicalJson(proof.authority),freshness=proof.freshness;
  if(!await current(bindings,captured))return {state:'deferred',reason:'source_changed',memberCount:captured.members.length};
  const previousPayload:unknown=previous?JSON.parse(previous.payload_json):null;
  if(previous?.cohort_digest===cohortDigest&&await sha256Hex(previous.payload_json)===previous.payload_sha256
    &&previousPayload!==null&&typeof previousPayload==='object'&&'generatedAt' in previousPayload
    &&typeof previousPayload.generatedAt==='string'
    &&validCachedAdminCommunityAllowancePreview(previousPayload,previousPayload.generatedAt,nowMs)
    &&previous.payload_json===canonicalJson({...preview,generatedAt:previousPayload.generatedAt})){
    if(previous.authority_json===authorityJson&&sameFreshness(previous,freshness))
      return {state:'unchanged',memberCount:captured.members.length};
    // Proof-only refresh: do not rewrite the aggregate or pretend it was
    // recalculated now. A completed current cohort may discharge queued work;
    // a partial snapshot keeps its real old-input watermark and explicit flag.
    try {await bindings.target.prepare(`UPDATE analytics_community_graph_previews SET revision=revision+1,
      authority_json=?,snapshot_source_epoch=?,inputs_current=?,oldest_computed_ms=?,newest_computed_ms=?
      WHERE source_id=? AND revision=? AND cohort_digest=? AND payload_sha256=? AND snapshot_source_epoch<=?
        AND COALESCE((SELECT model_revision FROM analytics_community_graph_publication_state WHERE source_id=?),0)=?`)
      .bind(authorityJson,freshness.snapshot_source_epoch,freshness.inputs_current,freshness.oldest_computed_ms,
        freshness.newest_computed_ms,bindings.sourceId,previous.revision,cohortDigest,previous.payload_sha256,
        captured.authority.sourceEpoch,bindings.sourceId,modelRevision).run();}catch{ /* Exact proof readback below. */ }
    const receipt=await bindings.target.prepare(`SELECT authority_json,payload_json,payload_sha256,
      snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms FROM analytics_community_graph_previews WHERE source_id=?`)
      .bind(bindings.sourceId).first<PreviewFreshness&{authority_json:string;payload_json:string;payload_sha256:string}>();
    return receipt?.authority_json===authorityJson&&receipt.payload_json===previous.payload_json
      &&receipt.payload_sha256===previous.payload_sha256&&sameFreshness(receipt,freshness)
      ?{state:'unchanged',memberCount:captured.members.length}
      :{state:'deferred',reason:'source_changed',memberCount:captured.members.length};
  }
  const payloadHash=await sha256Hex(payloadJson);
  try {await bindings.target.prepare(`INSERT INTO analytics_community_graph_previews
    (source_id,revision,method,cohort_digest,authority_json,model_revision,payload_json,payload_sha256,generated_at,
      snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT model_revision FROM analytics_community_graph_publication_state WHERE source_id=?),0)=?
    ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,method=excluded.method,cohort_digest=excluded.cohort_digest,
      authority_json=excluded.authority_json,model_revision=excluded.model_revision,payload_json=excluded.payload_json,
      payload_sha256=excluded.payload_sha256,generated_at=excluded.generated_at,snapshot_source_epoch=excluded.snapshot_source_epoch,
      inputs_current=excluded.inputs_current,oldest_computed_ms=excluded.oldest_computed_ms,newest_computed_ms=excluded.newest_computed_ms
    WHERE analytics_community_graph_previews.revision=?
      AND analytics_community_graph_previews.snapshot_source_epoch<=?
      AND analytics_community_graph_previews.generated_at<=?`).bind(bindings.sourceId,(previous?.revision??0)+1,STORAGE_GRAPH_METHOD,
      cohortDigest,authorityJson,modelRevision,payloadJson,payloadHash,preview.generatedAt,
      freshness.snapshot_source_epoch,freshness.inputs_current,freshness.oldest_computed_ms,freshness.newest_computed_ms,
      bindings.sourceId,modelRevision,previous?.revision??0,captured.authority.sourceEpoch,preview.generatedAt).run();}catch{ /* Exact readback owns uncertain success. */ }
  const receipt=await bindings.target.prepare(`SELECT cohort_digest,payload_json,payload_sha256,authority_json,
    snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms FROM analytics_community_graph_previews WHERE source_id=?`)
    .bind(bindings.sourceId).first<PreviewFreshness&{cohort_digest:string;payload_json:string;payload_sha256:string;authority_json:string}>();
  return receipt?.cohort_digest===cohortDigest&&receipt.payload_sha256===payloadHash&&receipt.payload_json===payloadJson
    &&receipt.authority_json===authorityJson&&sameFreshness(receipt,freshness)
    ?{state:'published',memberCount:captured.members.length}
    :{state:'deferred',reason:'source_changed',memberCount:captured.members.length};
}

/** Optional precomputed cache. No source analysis or target writes on GET. The
 * daily reader also retains its own final stamp across both activity and graph. */
export async function readPublishedStorageCommunityGraph(bindings:StorageAnalyticsBindings,
  nowMs=Date.now()):Promise<PublicAllowanceBreakdownsCacheRow|null> {
  await ready(bindings);const authority=await captureStorageCommunityAuthority(bindings.source,bindings);
  const row=await bindings.target.prepare(`SELECT payload_json,payload_sha256,authority_json,generated_at,
    snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms
    FROM analytics_community_graph_previews WHERE source_id=? AND method=?`)
    .bind(bindings.sourceId,STORAGE_GRAPH_METHOD).first<PreviewFreshness&{payload_json:string;payload_sha256:string;authority_json:string;generated_at:string}>();
  if(!row)return null;
  const publishedAuthority=JSON.parse(row.authority_json) as StorageCommunityAuthority;
  if(!sameStorageCommunityAuthority(publishedAuthority,authority)
    ||!validFreshness(row,publishedAuthority,nowMs)||row.snapshot_source_epoch>authority.sourceEpoch
    ||publishedAuthority.sequence>authority.sequence
    ||bytes(row.payload_json)>PREVIEW_CACHE_JSON_LIMIT_BYTES||await sha256Hex(row.payload_json)!==row.payload_sha256
    ||!validCachedAdminCommunityAllowancePreview(JSON.parse(row.payload_json),row.generated_at,nowMs))return null;
  if(!await storageCommunityAuthorityIsCurrent(bindings.source,authority))return null;
  return {payload_json:row.payload_json,generated_at:row.generated_at};
}

/** The authenticated admin route consumes the same independently fenced cache,
 * preserving its full maintained DTO rather than the public graph projection. */
export async function readPublishedStorageCommunityAdminPreview(bindings:StorageAnalyticsBindings,
  nowMs=Date.now()):Promise<AdminCommunityAllowancePreview|null> {
  const row=await readPublishedStorageCommunityGraph(bindings,nowMs);
  return row===null?null:JSON.parse(row.payload_json) as AdminCommunityAllowancePreview;
}

export async function retireStorageCommunityGraphPublications(bindings:StorageAnalyticsBindings,
  nowMs=Date.now()):Promise<number> {
  if(!Number.isFinite(nowMs))throw fail();
  const authority=await captureStorageCommunityRetirementAuthority(bindings.source,bindings);
  const from=new Date(Date.parse(new Date(nowMs).toISOString().slice(0,10))
    -(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS).toISOString().slice(0,10);
  const results=await bindings.target.batch([
    bindings.target.prepare(`DELETE FROM analytics_community_model_publications WHERE (source_id,day) IN(
      SELECT source_id,day FROM analytics_community_model_publications WHERE source_id=? AND (
       day<? OR method!=? OR json_extract(authority_json,'$.publicAuthorityEpoch')!=?
       OR json_extract(authority_json,'$.policyRevision')!=? OR json_extract(authority_json,'$.collectionRevision')!=?
       OR json_extract(authority_json,'$.graphInvalidationEpoch')!=?) ORDER BY day LIMIT 4)`)
      .bind(bindings.sourceId,from,STORAGE_GRAPH_METHOD,authority.publicAuthorityEpoch,authority.policyRevision,
        authority.collectionRevision,authority.graphInvalidationEpoch),
    bindings.target.prepare(`DELETE FROM analytics_community_graph_previews WHERE source_id=? AND (method!=?
      OR json_extract(authority_json,'$.publicAuthorityEpoch')!=? OR json_extract(authority_json,'$.policyRevision')!=?
      OR json_extract(authority_json,'$.collectionRevision')!=? OR json_extract(authority_json,'$.graphInvalidationEpoch')!=?)`)
      .bind(bindings.sourceId,STORAGE_GRAPH_METHOD,authority.publicAuthorityEpoch,authority.policyRevision,
        authority.collectionRevision,authority.graphInvalidationEpoch),
  ]);
  return results.reduce((n,r)=>n+r.meta.changes,0);
}
