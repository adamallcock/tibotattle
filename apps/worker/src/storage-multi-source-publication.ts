import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { buildCommunityDailyPayload } from './community-daily-aggregates';
import { buildAdminCommunityAllowancePreview, PREVIEW_CACHE_JSON_LIMIT_BYTES,
  validCachedAdminCommunityAllowancePreview } from './admin-community-allowance';
import { parsedCachedFits, type CommunityAllowanceFit } from './community-allowance';
import { captureStorageCommunityAuthority, sameStorageCommunityAuthority,
  storageCommunityAuthorityIsCurrent, type StorageCommunityAuthority } from './storage-community-authority';
import { buildStorageCommunityDailyPublicInputs, STORAGE_COMMUNITY_DAILY_METHOD } from './storage-community-daily';
import { STORAGE_GRAPH_METHOD } from './storage-community-graph';
import { validateV11DailyProjectionValues, type V11DailyProjectionValues } from './v11-daily-projection-values';
import type { StorageAnalyticsSource } from './storage-multi-source-analytics';

export interface MultiSourcePublicationMember {
  sourceId:string; ownerDigest:string; inputRevision:number; ownerRevision:number; routeGeneration:number;
}
export interface MultiSourcePublicationSet {
  sources:readonly StorageAnalyticsSource[];
  publicationTarget:D1Database;
  members:readonly MultiSourcePublicationMember[];
  routingGeneration:number;
  erasureGeneration:number;
  /** Trusted catalog epoch fence, rechecked immediately before commit. */
  assertRoutingCurrent?:()=>Promise<void>;
}
interface SourceCheckpoint {
  sourceId:string;sourceNamespace:string;targetId:string;sequence:number;publicAuthorityEpoch:number;
  sourceEpoch:number;policyRevision:number;collectionRevision:number;graphInvalidationEpoch:number;
  erasureFenceEpoch:number;
}
interface CapturedSource {binding:StorageAnalyticsSource;authority:StorageCommunityAuthority;checkpoint:SourceCheckpoint;}
type PublicationKind='daily'|'allowance';
const MAX_SOURCES=4,MAX_MEMBERS=5_000,MAX_CAPTURE_BYTES=16*1024*1024,MAX_PUBLICATION_BYTES=2*1024*1024;
const id=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/,digest=/^[a-f0-9]{64}$/;
const fail=()=>new Error('MULTI_SOURCE_PUBLICATION_UNAVAILABLE');
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
function integer(value:number,min=0):void {if(!Number.isSafeInteger(value)||value<min)throw fail();}
function day(value:string):void {if(!/^\d{4}-\d{2}-\d{2}$/.test(value)
  ||new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)!==value)throw fail();}

function validateSet(set:MultiSourcePublicationSet):void {
  if(!Array.isArray(set.sources)||set.sources.length<1||set.sources.length>MAX_SOURCES
    ||!Array.isArray(set.members)||set.members.length>MAX_MEMBERS)throw fail();
  integer(set.routingGeneration);integer(set.erasureGeneration);
  const sources=new Map<string,StorageAnalyticsSource>();
  for(const source of set.sources){if(!id.test(source.sourceId)||!id.test(source.targetId)
    ||sources.has(source.sourceId)||source.source===source.target||source.target===set.publicationTarget)throw fail();sources.set(source.sourceId,source);}
  const owners=new Set<string>();
  for(const member of set.members){integer(member.inputRevision);integer(member.ownerRevision,1);integer(member.routeGeneration);
    if(!digest.test(member.ownerDigest)||!sources.has(member.sourceId)||owners.has(member.ownerDigest)
      ||member.routeGeneration>set.routingGeneration)throw fail();owners.add(member.ownerDigest);}
  if(bytes(canonicalJson(set.members))>2*1024*1024)throw fail();
}

/** Required generation changes are durable before any capture. Routing lag may
 * keep the last complete output. An erasure increment makes it unservable at
 * once, even when the replacement publication cannot yet complete. */
export async function advanceMultiSourcePublicationGenerations(target:D1Database,generations:{
  routingGeneration:number;erasureGeneration:number;nowMs?:number;
}):Promise<void>{
  integer(generations.routingGeneration);integer(generations.erasureGeneration);
  const nowMs=generations.nowMs??Date.now();integer(nowMs);
  const result=await target.prepare(`UPDATE analytics_multi_source_control SET
    routing_generation=?,erasure_generation=?,updated_ms=? WHERE singleton=1
      AND routing_generation<=? AND erasure_generation<=?`)
    .bind(generations.routingGeneration,generations.erasureGeneration,nowMs,
      generations.routingGeneration,generations.erasureGeneration).run();
  if(result.meta.changes!==1)throw fail();
}

async function captureSource(binding:StorageAnalyticsSource):Promise<CapturedSource|null>{
  try{
    const authority=await captureStorageCommunityAuthority(binding.source,binding);
    const state=await binding.target.batch([
      binding.target.prepare(`SELECT c.sequence,c.authority_epoch FROM analytics_source_cursors c
       JOIN analytics_runtime_sources r ON r.source_id=c.source_id AND r.source_namespace=? AND r.contract_version=1
       WHERE c.source_id=?`).bind(binding.sourceNamespace,binding.sourceId),
      binding.target.prepare(`SELECT COALESCE(MAX(public_authority_epoch),0) AS erasure_fence_epoch
       FROM analytics_storage_erasure_fences WHERE source_id=?`).bind(binding.sourceId),
    ]);
    const cursor=state[0]!.results[0] as {sequence:number;authority_epoch:number}|undefined;
    const fence=state[1]!.results[0] as {erasure_fence_epoch:number}|undefined;
    if(!cursor||cursor.sequence!==authority.sequence||cursor.authority_epoch!==authority.publicAuthorityEpoch
      ||!fence||!Number.isSafeInteger(fence.erasure_fence_epoch)||fence.erasure_fence_epoch<0)return null;
    return {binding,authority,checkpoint:{sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,
      targetId:binding.targetId,sequence:cursor.sequence,publicAuthorityEpoch:cursor.authority_epoch,
      sourceEpoch:authority.sourceEpoch,policyRevision:authority.policyRevision,
      collectionRevision:authority.collectionRevision,graphInvalidationEpoch:authority.graphInvalidationEpoch,
      erasureFenceEpoch:fence.erasure_fence_epoch}};
  }catch{return null;}
}

async function captureSet(set:MultiSourcePublicationSet):Promise<CapturedSource[]|null>{
  validateSet(set);const captured:CapturedSource[]=[];
  for(const source of set.sources){const value=await captureSource(source);if(!value)return null;captured.push(value);}
  return captured;
}

async function stillCurrent(captured:readonly CapturedSource[]):Promise<boolean>{
  for(const item of captured){
    if(!await storageCommunityAuthorityIsCurrent(item.binding.source,item.authority,true))return false;
    const current=await captureSource(item.binding);
    if(!current||canonicalJson(current.checkpoint)!==canonicalJson(item.checkpoint))return false;
  }
  return true;
}
async function routingCurrent(set:MultiSourcePublicationSet):Promise<boolean>{
  if(!set.assertRoutingCurrent)return true;
  try{await set.assertRoutingCurrent();return true;}catch{return false;}
}

interface DailyRow {owner_digest:string;input_revision:number;owner_revision:number;method:string;complete:number;values_json:string|null;state:string|null;}
async function readDailyValues(captured:readonly CapturedSource[],set:MultiSourcePublicationSet,observedDay:string)
  :Promise<V11DailyProjectionValues[]|null>{
  const values:V11DailyProjectionValues[]=[];let transferred=0;
  for(const item of captured){
    const members=set.members.filter(member=>member.sourceId===item.binding.sourceId);
    for(let offset=0;offset<members.length;offset+=64){
      const page=members.slice(offset,offset+64),membersJson=canonicalJson(page);
      const rows=(await item.binding.target.prepare(`WITH requested AS MATERIALIZED(
        SELECT json_extract(value,'$.ownerDigest') owner_digest,
         json_extract(value,'$.inputRevision') input_revision,json_extract(value,'$.ownerRevision') owner_revision
        FROM json_each(?)), selected AS MATERIALIZED(
        SELECT c.owner_digest,c.input_revision,c.owner_revision,c.method,c.complete,c.values_json,o.state
        FROM requested r LEFT JOIN analytics_community_daily_owners c
         ON c.source_id=? AND c.day=? AND c.owner_digest=r.owner_digest
        LEFT JOIN analytics_owner_state o ON o.source_id=? AND o.owner_digest=r.owner_digest)
        SELECT owner_digest,input_revision,owner_revision,method,complete,
         CASE WHEN COALESCE((SELECT SUM(length(CAST(values_json AS BLOB))) FROM selected),0)<=?
          THEN values_json ELSE NULL END values_json,state FROM selected ORDER BY owner_digest`)
       .bind(membersJson,item.binding.sourceId,observedDay,item.binding.sourceId,MAX_CAPTURE_BYTES-transferred)
       .all<DailyRow>()).results;
      if(rows.length!==page.length)return null;
      const expected=new Map(page.map(member=>[member.ownerDigest,member]));
      for(const row of rows){const member=expected.get(row.owner_digest);
        if(!member||row.input_revision!==member.inputRevision||row.owner_revision!==member.ownerRevision
          ||row.method!==STORAGE_COMMUNITY_DAILY_METHOD||row.complete!==1||row.state!=='active'
          ||typeof row.values_json!=='string')return null;
        transferred+=bytes(row.values_json);if(transferred>MAX_CAPTURE_BYTES)return null;
        const value=JSON.parse(row.values_json) as V11DailyProjectionValues;validateV11DailyProjectionValues(value);values.push(value);
      }
    }
  }
  return values;
}

interface FitRow {owner_digest:string;input_revision:number;payload_json:string|null;payload_sha256:string;authority_json:string;}
async function readFits(captured:readonly CapturedSource[],set:MultiSourcePublicationSet,observedDay:string){
  const fits:CommunityAllowanceFit[]=[];
  let transferred=0;
  for(const item of captured){
    const members=set.members.filter(member=>member.sourceId===item.binding.sourceId);
    for(let offset=0;offset<members.length;offset+=64){
      const page=members.slice(offset,offset+64),membersJson=canonicalJson(page);
      const rows=(await item.binding.target.prepare(`WITH requested AS MATERIALIZED(
        SELECT json_extract(value,'$.ownerDigest') owner_digest,json_extract(value,'$.inputRevision') input_revision
        FROM json_each(?)), selected AS MATERIALIZED(
        SELECT r.owner_digest,g.input_revision,g.payload_json,g.payload_sha256,g.authority_json
        FROM requested r LEFT JOIN analytics_community_graph_results g ON g.source_id=? AND g.owner_digest=r.owner_digest
          AND g.metric='fits' AND g.day=? AND g.method=?)
        SELECT owner_digest,input_revision,CASE WHEN COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM selected),0)<=?
          THEN payload_json ELSE NULL END payload_json,payload_sha256,authority_json FROM selected ORDER BY owner_digest`)
       .bind(membersJson,item.binding.sourceId,observedDay,STORAGE_GRAPH_METHOD,MAX_CAPTURE_BYTES-transferred)
       .all<FitRow>()).results;
      if(rows.length!==page.length)return null;
      const expected=new Map(page.map(member=>[member.ownerDigest,member]));
      for(const row of rows){const member=expected.get(row.owner_digest);
        if(!member||row.input_revision!==member.inputRevision||typeof row.payload_json!=='string'
          ||await sha256Hex(row.payload_json)!==row.payload_sha256)return null;
        const authority=JSON.parse(row.authority_json) as StorageCommunityAuthority;
        if(!sameStorageCommunityAuthority(authority,item.authority))return null;
        transferred+=bytes(row.payload_json);if(transferred>MAX_CAPTURE_BYTES)return null;
        const parsed=parsedCachedFits(row.payload_json,row.owner_digest);if(parsed===null)return null;fits.push(...parsed);
      }
    }
  }
  return fits;
}

function stablePublicationPayload(kind:PublicationKind,payload:unknown):Record<string,unknown>{
  if(typeof payload!=='object'||payload===null||Array.isArray(payload))throw fail();
  const stable={...(payload as Record<string,unknown>)};
  if(kind==='daily'){
    delete stable.aggregateId;
    delete stable.revision;
    delete stable.releasedAt;
  }else delete stable.generatedAt;
  return stable;
}

async function commit(target:D1Database,kind:PublicationKind,key:string,set:MultiSourcePublicationSet,
  captured:readonly CapturedSource[],payload:unknown,nowMs:number){
  const checkpointsJson=canonicalJson(captured.map(value=>value.checkpoint));
  const checkpointsHash=await sha256Hex(checkpointsJson);
  const cohortDigest=await sha256Hex(canonicalJson({identityVersion:2,kind,
    method:kind==='daily'?STORAGE_COMMUNITY_DAILY_METHOD:STORAGE_GRAPH_METHOD,
    routingGeneration:set.routingGeneration,erasureGeneration:set.erasureGeneration,
    members:set.members.map(member=>[
      member.ownerDigest,member.sourceId,member.inputRevision,member.ownerRevision,member.routeGeneration]),
    checkpoints:captured.map(v=>v.checkpoint),payload:stablePublicationPayload(kind,payload)}));
  const payloadJson=canonicalJson(payload),payloadHash=await sha256Hex(payloadJson);
  const previous=await target.prepare(`SELECT h.revision,p.cohort_digest,p.routing_generation,p.erasure_generation
    FROM analytics_multi_source_heads h
    JOIN analytics_multi_source_publications p ON p.kind=h.kind AND p.publication_key=h.publication_key AND p.revision=h.revision
    WHERE h.kind=? AND h.publication_key=?`).bind(kind,key)
    .first<{revision:number;cohort_digest:string;routing_generation:number;erasure_generation:number}>();
  if(previous?.cohort_digest===cohortDigest&&previous.routing_generation===set.routingGeneration
    &&previous.erasure_generation===set.erasureGeneration)return {state:'unchanged' as const,revision:previous.revision};
  const revision=(previous?.revision??0)+1,releasedAt=new Date(nowMs).toISOString();
  try{await target.prepare(`INSERT INTO analytics_multi_source_publications
    (kind,publication_key,revision,routing_generation,erasure_generation,checkpoints_json,checkpoints_sha256,
     cohort_digest,payload_json,payload_sha256,released_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(kind,key,revision,set.routingGeneration,set.erasureGeneration,checkpointsJson,checkpointsHash,
      cohortDigest,payloadJson,payloadHash,releasedAt).run();}catch{/* Exact receipt decides uncertain success. */}
  const receipt=await target.prepare(`SELECT cohort_digest,payload_sha256 FROM analytics_multi_source_publications
    WHERE kind=? AND publication_key=? AND revision=?`).bind(kind,key,revision)
    .first<{cohort_digest:string;payload_sha256:string}>();
  if(receipt?.cohort_digest!==cohortDigest||receipt.payload_sha256!==payloadHash)return {state:'deferred' as const,reason:'changed' as const};
  return {state:'published' as const,revision};
}

export async function publishMultiSourceCommunityDaily(set:MultiSourcePublicationSet,options:{day:string;nowMs?:number}){
  day(options.day);validateSet(set);const nowMs=options.nowMs??Date.now();integer(nowMs);
  await advanceMultiSourcePublicationGenerations(set.publicationTarget,{routingGeneration:set.routingGeneration,
    erasureGeneration:set.erasureGeneration,nowMs});
  const captured=await captureSet(set);if(!captured)return {state:'deferred' as const,reason:'source_lag' as const};
  const values=await readDailyValues(captured,set,options.day);if(!values)return {state:'deferred' as const,reason:'source_lag' as const};
  const head=await set.publicationTarget.prepare(`SELECT revision FROM analytics_multi_source_heads WHERE kind='daily' AND publication_key=?`)
    .bind(options.day).first<number>('revision');
  const revision=(head??0)+1,releasedAt=new Date(nowMs).toISOString();
  const payload=buildCommunityDailyPayload({day:options.day,revision,releasedAt,
    ...buildStorageCommunityDailyPublicInputs(values)});
  if(!await stillCurrent(captured))return {state:'deferred' as const,reason:'source_changed' as const};
  if(!await routingCurrent(set))return {state:'deferred' as const,reason:'routing_changed' as const};
  return commit(set.publicationTarget,'daily',options.day,set,captured,payload,nowMs);
}

export async function publishMultiSourceAllowancePreview(set:MultiSourcePublicationSet,options:{nowMs?:number}={}){
  validateSet(set);const nowMs=options.nowMs??Date.now();integer(nowMs);
  await advanceMultiSourcePublicationGenerations(set.publicationTarget,{routingGeneration:set.routingGeneration,
    erasureGeneration:set.erasureGeneration,nowMs});
  const captured=await captureSet(set);if(!captured)return {state:'deferred' as const,reason:'source_lag' as const};
  const today=new Date(nowMs).toISOString().slice(0,10),fits=await readFits(captured,set,today);
  if(!fits)return {state:'deferred' as const,reason:'source_lag' as const};
  const preview=buildAdminCommunityAllowancePreview(fits,nowMs,set.members.map(member=>member.ownerDigest));
  const json=canonicalJson(preview);
  if(bytes(json)>PREVIEW_CACHE_JSON_LIMIT_BYTES||!validCachedAdminCommunityAllowancePreview(preview,preview.generatedAt,nowMs))
    return {state:'deferred' as const,reason:'capacity' as const};
  if(!await stillCurrent(captured))return {state:'deferred' as const,reason:'source_changed' as const};
  if(!await routingCurrent(set))return {state:'deferred' as const,reason:'routing_changed' as const};
  return commit(set.publicationTarget,'allowance','current',set,captured,preview,nowMs);
}

export async function readMultiSourcePublication(target:D1Database,kind:PublicationKind,key:string){
  const row=await target.prepare(`SELECT p.payload_json,p.payload_sha256,p.checkpoints_json,p.checkpoints_sha256,p.released_at,p.revision,
    p.routing_generation,p.erasure_generation,c.routing_generation AS required_routing_generation,
    c.erasure_generation AS required_erasure_generation
    FROM analytics_multi_source_heads h JOIN analytics_multi_source_publications p
      ON p.kind=h.kind AND p.publication_key=h.publication_key AND p.revision=h.revision
    JOIN analytics_multi_source_control c ON c.singleton=1 WHERE h.kind=? AND h.publication_key=?`)
    .bind(kind,key).first<{payload_json:string;payload_sha256:string;checkpoints_json:string;checkpoints_sha256:string;released_at:string;revision:number;
      routing_generation:number;erasure_generation:number;required_routing_generation:number;required_erasure_generation:number}>();
  if(!row||row.erasure_generation!==row.required_erasure_generation
    ||row.routing_generation>row.required_routing_generation||bytes(row.payload_json)>MAX_PUBLICATION_BYTES
    ||bytes(row.checkpoints_json)>64*1024||await sha256Hex(row.payload_json)!==row.payload_sha256
    ||await sha256Hex(row.checkpoints_json)!==row.checkpoints_sha256)return null;
  return {payloadJson:row.payload_json,releasedAt:row.released_at,revision:row.revision,
    routingGeneration:row.routing_generation,erasureGeneration:row.erasure_generation};
}
