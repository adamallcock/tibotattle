import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {V11_DOMAIN_METHOD_VERSION} from './telemetry-v11-domain';
import {isV11GenerationSnapshot,type V11GenerationSnapshot} from './typed-v11-quota-reader';
import {modelHistoryWindow} from './model-history-window';

const HEX=/^[a-f0-9]{64}$/u,TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const unavailable=()=>new Error('STORAGE_GRAPH_SELECTION_UNAVAILABLE');
const invalid=()=>new TypeError('STORAGE_GRAPH_SELECTION_INVALID');
export type StorageGraphSelectionMetric='fits'|'model';
export interface StorageGraphSelectionKey {sourceId:string;ownerDigest:string;day:string;metric:StorageGraphSelectionMetric}
export interface StorageGraphV11WorkEnvelope {
 version:1;source:'v1.1';sourceId:string;sourceNamespace:string;ownerDigest:string;day:string;
 metric:StorageGraphSelectionMetric;fixedNow:string;dependencyDigest:string;checkpointDependencyDigest:string;
 checkpointMethod:string;checkpointKeyDigest:string;targetAuthorityEpoch:number;snapshot:V11GenerationSnapshot;
}
/** Effective evidence is recaptured after claiming, not resumed from a v1.1
 * generation. The lease covers the owner/day/metric across checkpoint formats;
 * the calculation retains its exact dependency and per-page owner fences. */
export interface StorageGraphEffectiveWorkEnvelope {
 version:2;source:'effective';sourceId:string;sourceNamespace:string;ownerDigest:string;day:string;
 metric:StorageGraphSelectionMetric;fixedNow:string;dependencyDigest:string;checkpointDependencyDigest:string;
 targetAuthorityEpoch:number;participantId:string;ownerRevision:number;
}
export type StorageGraphWorkEnvelope=StorageGraphV11WorkEnvelope|StorageGraphEffectiveWorkEnvelope;
export interface StorageGraphWorkSelection {key:StorageGraphSelectionKey;revision:number;
 state:'pending'|'claimed'|'complete';envelope:StorageGraphWorkEnvelope;envelopeSha256:string;
 claimToken:string|null;claimExpiresMs:number|null;createdMs:number;updatedMs:number}
interface Row {source_id:string;owner_digest:string;day:string;metric:string;authority_epoch:number;
 selection_revision:number;state:string;envelope_json:string;envelope_sha256:string;claim_token:string|null;
 claim_expires_ms:number|null;created_ms:number;updated_ms:number}

function safe(n:unknown):n is number{return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0}
function method(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=2048
 &&/^[A-Za-z0-9._:-]+$/u.test(value)}
function day(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(value)
 &&new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value}
function token(value:unknown,max=512):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&TOKEN.test(value)}
function validKey(key:unknown):key is StorageGraphSelectionKey {if(!key||typeof key!=='object'||Array.isArray(key))return false;
 const value=key as Record<string,unknown>;return Object.keys(value).sort().join(',')==='day,metric,ownerDigest,sourceId'
  &&token(value.sourceId,128)&&HEX.test(String(value.ownerDigest))&&day(value.day)&&['fits','model'].includes(String(value.metric));}
function binds(key:StorageGraphSelectionKey){if(!validKey(key))throw invalid();return [key.sourceId,key.ownerDigest,key.day,key.metric]}

async function normalizeEnvelope(value:unknown):Promise<StorageGraphWorkEnvelope>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const v=value as Record<string,unknown>;
 if(v.version===2&&v.source==='effective'){
  if(Object.keys(v).sort().join(',')!==['checkpointDependencyDigest','day','dependencyDigest','fixedNow','metric',
   'ownerDigest','ownerRevision','participantId','source','sourceId','sourceNamespace','targetAuthorityEpoch','version'].sort().join(',')
   ||!token(v.sourceId,128)||!token(v.sourceNamespace,256)||typeof v.ownerDigest!=='string'||!HEX.test(v.ownerDigest)||!day(v.day)
   ||v.metric!=='fits'&&v.metric!=='model'||v.fixedNow!==modelHistoryWindow(v.day as string).fixedNow
   ||typeof v.dependencyDigest!=='string'||!HEX.test(v.dependencyDigest)
   ||typeof v.checkpointDependencyDigest!=='string'||!HEX.test(v.checkpointDependencyDigest)
   ||!safe(v.targetAuthorityEpoch)||!safe(v.ownerRevision)||typeof v.participantId!=='string'
   ||v.participantId.length<1||v.participantId.length>256)throw invalid();
  return structuredClone(v) as unknown as StorageGraphEffectiveWorkEnvelope;
 }
 if(Object.keys(v).sort().join(',')!==['checkpointDependencyDigest','checkpointKeyDigest','checkpointMethod','day',
  'dependencyDigest','fixedNow','metric','ownerDigest','snapshot','source','sourceId','sourceNamespace',
  'targetAuthorityEpoch','version'].sort().join(',')||v.version!==1||v.source!=='v1.1'||!token(v.sourceId,128)
  ||!token(v.sourceNamespace,256)||!HEX.test(String(v.ownerDigest))||!day(v.day)||!['fits','model'].includes(String(v.metric))
  ||typeof v.fixedNow!=='string'||v.fixedNow!==modelHistoryWindow(v.day as string).fixedNow||!HEX.test(String(v.dependencyDigest))
  ||!HEX.test(String(v.checkpointDependencyDigest))||!HEX.test(String(v.checkpointKeyDigest))
  ||!method(v.checkpointMethod)||!safe(v.targetAuthorityEpoch)||!isV11GenerationSnapshot(v.snapshot))throw invalid();
 const snapshot=v.snapshot as V11GenerationSnapshot;
 if(snapshot.sourceNamespace!==v.sourceNamespace||snapshot.participantId.length<1)throw invalid();
 const fingerprint=await sha256Hex(canonicalJson({method:V11_DOMAIN_METHOD_VERSION,participantId:snapshot.participantId,
  generationId:snapshot.generationId,manifestDigest:snapshot.manifestDigest,fromDay:snapshot.fromDay,
  throughDay:snapshot.throughDay,inputRevision:snapshot.inputRevision}));
 if(fingerprint!==snapshot.fingerprint)throw invalid();
 return structuredClone(v) as unknown as StorageGraphWorkEnvelope;
}
function keyOf(e:StorageGraphWorkEnvelope):StorageGraphSelectionKey{return {sourceId:e.sourceId,ownerDigest:e.ownerDigest,day:e.day,metric:e.metric}}
async function encode(value:unknown){const envelope=await normalizeEnvelope(value),json=canonicalJson(envelope);
 if(new TextEncoder().encode(json).byteLength>16384)throw invalid();return {envelope,json,hash:await sha256Hex(json)};}
async function decode(row:Row):Promise<StorageGraphWorkSelection>{
 const key={sourceId:row.source_id,ownerDigest:row.owner_digest,day:row.day,metric:row.metric as StorageGraphSelectionMetric};
 if(!validKey(key)||!safe(row.authority_epoch)||!safe(row.selection_revision)||row.selection_revision<1
  ||!['pending','claimed','complete'].includes(row.state)||!HEX.test(row.envelope_sha256)
  ||!safe(row.created_ms)||!safe(row.updated_ms)||(row.state==='claimed')!==(row.claim_token!==null&&row.claim_expires_ms!==null)
  ||row.claim_token!==null&&!token(row.claim_token,128)||row.claim_expires_ms!==null&&!safe(row.claim_expires_ms))throw unavailable();
 let parsed:unknown;try{parsed=JSON.parse(row.envelope_json)}catch{throw unavailable()}
 const encoded=await encode(parsed);if(encoded.json!==row.envelope_json||encoded.hash!==row.envelope_sha256
  ||canonicalJson(keyOf(encoded.envelope))!==canonicalJson(key)
  ||encoded.envelope.targetAuthorityEpoch!==row.authority_epoch)throw unavailable();
 return {key,revision:row.selection_revision,state:row.state as StorageGraphWorkSelection['state'],
  envelope:encoded.envelope,envelopeSha256:row.envelope_sha256,claimToken:row.claim_token,
  claimExpiresMs:row.claim_expires_ms,createdMs:row.created_ms,updatedMs:row.updated_ms};
}
const SELECT=`SELECT source_id,owner_digest,day,metric,authority_epoch,selection_revision,state,envelope_json,
 envelope_sha256,claim_token,claim_expires_ms,created_ms,updated_ms FROM analytics_community_graph_work_selection`;
async function load(target:D1Database,key:StorageGraphSelectionKey){const row=await target.prepare(`${SELECT}
 WHERE source_id=? AND owner_digest=? AND day=? AND metric=?`).bind(...binds(key)).first<Row>();return row?decode(row):null}
export const readStorageGraphWorkSelection=(target:D1Database,key:StorageGraphSelectionKey)=>load(target,key);
async function targetLive(target:D1Database,e:StorageGraphWorkEnvelope){return !!await target.prepare(`SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.authority_epoch=?
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
 .bind(e.sourceId,e.ownerDigest,e.targetAuthorityEpoch).first()}
async function sourceLive(source:D1Database,e:StorageGraphWorkEnvelope){
 if(e.source==='effective')return !!await source.prepare(`SELECT 1
  FROM storage_v11_owner_links l
  JOIN participants p ON p.id=l.participant_id AND p.state='active'
  JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest AND r.state='active'
    AND r.revision=? AND r.authority_epoch=?
  JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1 AND a.source_namespace=?
  JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 AND b.source_namespace=a.source_namespace
  WHERE l.participant_id=? AND l.owner_digest=? AND l.state='active'`)
  .bind(e.ownerRevision,e.targetAuthorityEpoch,e.sourceNamespace,e.participantId,e.ownerDigest).first();
 const s=e.snapshot;return !!await source.prepare(`SELECT 1
 FROM typed_v11_admission_state a JOIN participants p ON p.id=? AND p.state='active'
 JOIN telemetry_v11_domains g ON g.id=? AND g.participant_id=p.id AND g.device_id=? AND g.manifest_digest=? AND g.from_day=? AND g.through_day=?
 JOIN device_credentials d ON d.id=g.device_id AND d.participant_id=p.id AND d.state='active'
 JOIN storage_v11_owner_links l ON l.participant_id=p.id AND l.owner_digest=? AND l.state='active'
 JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest AND r.state='active' AND r.authority_epoch=?
 WHERE a.id=1 AND a.runtime_contract_version=1 AND a.source_namespace=?
 AND EXISTS(SELECT 1 FROM storage_v11_event_sources x WHERE x.owner_digest=l.owner_digest AND x.participant_id=p.id
  AND x.device_id=g.device_id AND x.generation_id=g.id AND x.manifest_digest=g.manifest_digest
  AND x.from_day=g.from_day AND x.through_day=g.through_day)`)
 .bind(s.participantId,s.generationId,s.deviceId,s.manifestDigest,s.fromDay,s.throughDay,e.ownerDigest,
  e.targetAuthorityEpoch,s.sourceNamespace).first()}
async function live(source:D1Database,target:D1Database,e:StorageGraphWorkEnvelope){return await targetLive(target,e)&&await sourceLive(source,e)}
async function remove(target:D1Database,selection:StorageGraphWorkSelection){await target.prepare(`DELETE FROM analytics_community_graph_work_selection
 WHERE source_id=? AND owner_digest=? AND day=? AND metric=? AND selection_revision=?
 AND envelope_sha256=? AND state=? AND claim_token IS ?`).bind(...binds(selection.key),selection.revision,
 selection.envelopeSha256,selection.state,selection.claimToken).run()}

/** Discard a selection at its exact revision. A recorded envelope that no
 * longer matches the scope the current build computes is superseded work, not
 * work in flight: removing the row lets the next pass record a fresh selection
 * for the same owner-day. The revision, envelope and claim fences also leave a
 * deleted/recreated row untouched when its revision counter starts over. */
export const discardStorageGraphWorkSelection=(target:D1Database,selection:StorageGraphWorkSelection)=>remove(target,selection);

export async function loadLiveStorageGraphWorkSelection(options:{source:D1Database;target:D1Database;key:StorageGraphSelectionKey;nowMs?:number}){
 let selection=await load(options.target,options.key);if(!selection||selection.state==='complete')return null;
 const now=options.nowMs??Date.now();if(!safe(now))throw invalid();
 if(selection.state==='claimed'&&selection.claimExpiresMs!<=now){await options.target.prepare(`UPDATE analytics_community_graph_work_selection
  SET state='pending',selection_revision=selection_revision+1,claim_token=NULL,claim_expires_ms=NULL,updated_ms=?
  WHERE source_id=? AND owner_digest=? AND day=? AND metric=? AND selection_revision=?
  AND envelope_sha256=? AND state='claimed' AND claim_token=? AND claim_expires_ms<=?`)
  .bind(now,...binds(selection.key),selection.revision,selection.envelopeSha256,selection.claimToken,now).run();
  selection=await load(options.target,options.key);if(!selection)return null;}
 if(!await live(options.source,options.target,selection.envelope)){await remove(options.target,selection);return null}return selection;
}

export async function ensureStorageGraphWorkSelection(options:{source:D1Database;target:D1Database;envelope:StorageGraphWorkEnvelope;
 expectedRevision?:number;nowMs?:number}){const encoded=await encode(options.envelope),key=keyOf(encoded.envelope),now=options.nowMs??Date.now();
 if(!safe(now)||!await live(options.source,options.target,encoded.envelope))return {status:'blocked' as const};
 const current=await load(options.target,key);
 if(!current){const result=await options.target.prepare(`INSERT INTO analytics_community_graph_work_selection
  (source_id,owner_digest,day,metric,authority_epoch,selection_revision,state,envelope_json,envelope_sha256,created_ms,updated_ms)
  SELECT ?,?,?,?,?,1,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=? AND o.owner_digest=?
   AND o.state='active' AND o.authority_epoch=? AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
    WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)) ON CONFLICT DO NOTHING RETURNING source_id`)
  .bind(key.sourceId,key.ownerDigest,key.day,key.metric,encoded.envelope.targetAuthorityEpoch,encoded.json,encoded.hash,now,now,
   key.sourceId,key.ownerDigest,encoded.envelope.targetAuthorityEpoch).all();
  const selection=await load(options.target,key);return result.results.length===1&&selection?{status:'created' as const,selection}:
   selection?{status:'conflict' as const,selection}:{status:'blocked' as const};}
 if(current.envelopeSha256===encoded.hash&&current.state!=='complete')return {status:'existing' as const,selection:current};
 if(current.state!=='complete'||options.expectedRevision!==current.revision)return {status:'conflict' as const,selection:current};
 const updated=await options.target.prepare(`UPDATE analytics_community_graph_work_selection SET authority_epoch=?,selection_revision=selection_revision+1,
  state='pending',envelope_json=?,envelope_sha256=?,claim_token=NULL,claim_expires_ms=NULL,updated_ms=?
  WHERE source_id=? AND owner_digest=? AND day=? AND metric=? AND selection_revision=? AND state='complete' RETURNING source_id`)
  .bind(encoded.envelope.targetAuthorityEpoch,encoded.json,encoded.hash,now,...binds(key),current.revision).all();
 const selection=await load(options.target,key);return updated.results.length===1&&selection?{status:'replaced' as const,selection}:
  selection?{status:'conflict' as const,selection}:{status:'blocked' as const};}

export async function claimStorageGraphWorkSelection(options:{source:D1Database;target:D1Database;selection:StorageGraphWorkSelection;
 claimToken:string;nowMs?:number;leaseMs?:number}){const now=options.nowMs??Date.now(),lease=options.leaseMs??300_000;
 if(!token(options.claimToken,128)||!safe(now)||!safe(lease)||lease<1||now>Number.MAX_SAFE_INTEGER-lease)throw invalid();
 if(!await live(options.source,options.target,options.selection.envelope)){await remove(options.target,options.selection);return {status:'blocked' as const};}
 const result=await options.target.prepare(`UPDATE analytics_community_graph_work_selection SET state='claimed',selection_revision=selection_revision+1,
  claim_token=?,claim_expires_ms=?,updated_ms=? WHERE source_id=? AND owner_digest=? AND day=? AND metric=?
  AND selection_revision=? AND envelope_sha256=?
  AND (state='pending' OR (state='claimed' AND claim_expires_ms<=?)) RETURNING source_id`)
  .bind(options.claimToken,now+lease,now,...binds(options.selection.key),options.selection.revision,
   options.selection.envelopeSha256,now).all();
 const selection=await load(options.target,options.selection.key);return result.results.length===1&&selection?{status:'claimed' as const,selection}:
  selection?{status:selection.state==='claimed'?'busy' as const:'conflict' as const,selection}:{status:'blocked' as const};}

async function finishClaim(options:{target:D1Database;selection:StorageGraphWorkSelection;claimToken:string;nowMs?:number},complete:boolean){
 const now=options.nowMs??Date.now();if(!safe(now)||!token(options.claimToken,128))throw invalid();
 if(complete){const result=await options.target.prepare(`DELETE FROM analytics_community_graph_work_selection
  WHERE source_id=? AND owner_digest=? AND day=? AND metric=? AND selection_revision=?
  AND state='claimed' AND claim_token=? RETURNING source_id`).bind(...binds(options.selection.key),
   options.selection.revision,options.claimToken).all();return result.results.length===1?{status:'completed' as const,selection:null}:
   {status:'conflict' as const,selection:await load(options.target,options.selection.key)};}
 const result=await options.target.prepare(`UPDATE analytics_community_graph_work_selection SET state=?,selection_revision=selection_revision+1,
  claim_token=NULL,claim_expires_ms=NULL,updated_ms=? WHERE source_id=? AND owner_digest=? AND day=? AND metric=?
  AND selection_revision=? AND state='claimed' AND claim_token=? RETURNING source_id`)
  .bind('pending',now,...binds(options.selection.key),options.selection.revision,options.claimToken).all();
 return result.results.length===1?{status:'released' as const,selection:await load(options.target,options.selection.key)}:
  {status:'conflict' as const,selection:await load(options.target,options.selection.key)};}
export const releaseStorageGraphWorkSelection=(options:{target:D1Database;selection:StorageGraphWorkSelection;claimToken:string;nowMs?:number})=>finishClaim(options,false);
export const completeStorageGraphWorkSelection=(options:{target:D1Database;selection:StorageGraphWorkSelection;claimToken:string;nowMs?:number})=>finishClaim(options,true);

export async function cleanupStorageGraphWorkSelections(options:{target:D1Database;beforeMs:number;limit?:number}){const limit=options.limit??32;
 if(!safe(options.beforeMs)||!safe(limit)||limit<1||limit>100)throw invalid();const result=await options.target.prepare(`DELETE FROM analytics_community_graph_work_selection
 WHERE (source_id,owner_digest,day,metric) IN(SELECT source_id,owner_digest,day,metric FROM analytics_community_graph_work_selection
  WHERE state='complete' AND updated_ms<? ORDER BY updated_ms LIMIT ?) RETURNING source_id`).bind(options.beforeMs,limit).all();return result.results.length;}
