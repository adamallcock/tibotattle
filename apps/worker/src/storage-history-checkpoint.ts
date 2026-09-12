import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { encodeV1QuotaWorkCheckpoint,decodeV1QuotaWorkCheckpoint,createV1QuotaAcquisitionCheckpoint,
 validateV1CompletedQuotaAcquisition,V1_QUOTA_WORK_COMPONENTS,type V1QuotaWorkComponent } from './quota-analysis-v1-reader';
import type { StorageV1HistoryCheckpoint } from './storage-v1-history';
export const STORAGE_HISTORY_PART_BYTES=128*1024,STORAGE_HISTORY_CONTROL_BYTES=16*1024;
export const STORAGE_HISTORY_MAX_PARTS=1024,STORAGE_HISTORY_MAX_WRITES=32;
export interface StorageHistoryKey {sourceId:string;ownerDigest:string;day:string;dependencyDigest:string;sourceNamespace:string;method:string}
interface Part {component:string;sha256:string;bytes:number}
interface Frame {control:string;manifest:Part[];parts:string[]}
interface Stage {generation:string;expected_head:string|null;control_json:string;manifest_json:string;part_count:number;owner_revision:number;authority_epoch:number}
export interface StorageHistoryLoadCursor {generation:string;parts:string[]}
const encoder=new TextEncoder(),hash=/^[a-f0-9]{64}$/u;
const fail=()=>new Error('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
const size=(text:string)=>encoder.encode(text).byteLength;
const parse=(text:string):any=>{try{return JSON.parse(text);}catch{throw fail();}};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function keys(key:StorageHistoryKey){if(!key||Object.keys(key).sort().join(',')!=='day,dependencyDigest,method,ownerDigest,sourceId,sourceNamespace'
 ||!hash.test(key.ownerDigest)||!hash.test(key.dependencyDigest)||!/^\d{4}-\d{2}-\d{2}$/.test(key.day)
 ||new Date(`${key.day}T00:00:00.000Z`).toISOString().slice(0,10)!==key.day
 ||typeof key.sourceId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key.sourceId)
 ||typeof key.method!=='string'||!key.method.length||key.method.length>2048)throw fail();
 try{encodeTypedTelemetryId(key.sourceNamespace);}catch{throw fail();}}
function bounded(value:number,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail();}
function pin(value:string|null){if(value!==null&&!hash.test(value))throw fail();}
async function keyDigest(key:StorageHistoryKey){keys(key);return sha256Hex(canonicalJson(key));}
function decode(controlText:string,manifest:Part[],parts:string[]):StorageV1HistoryCheckpoint{
 const control=parse(controlText),components:Record<string,unknown[]>={};
 if(size(controlText)>STORAGE_HISTORY_CONTROL_BYTES||!control||control.version!==1||!['acquisition','finish'].includes(control.phase))throw fail();
 createV1QuotaAcquisitionCheckpoint(control.identity);
 for(let i=0;i<parts.length;i++){
  const part=parse(parts[i]!);if(!Array.isArray(part))throw fail();
  (components[manifest[i]!.component]??=[]).push(...part);
 }
 if(control.phase==='acquisition'){
  for(const name of V1_QUOTA_WORK_COMPONENTS)components[name]??=[];
  return {version:1,day:control.day,layout:control.layout,identity:control.identity,phase:'acquisition',
   acquisition:decodeV1QuotaWorkCheckpoint(control.identity,control.acquisition,components)};
 }
 const acquisition={planAnchors:components.planAnchors??[],quotaRows:components.quotaRows??[]};
 if(!validateV1CompletedQuotaAcquisition(acquisition)||Object.keys(components).some(k=>!['planAnchors','quotaRows'].includes(k)))throw fail();
 return {version:1,day:control.day,layout:control.layout,identity:control.identity,phase:'finish',acquisition};
}
async function frame(key:StorageHistoryKey,checkpoint:StorageV1HistoryCheckpoint):Promise<Frame>{
 if(checkpoint.version!==1||checkpoint.day!==key.day||checkpoint.layout!==`typed:${key.sourceNamespace}`&&checkpoint.layout!=='json')throw fail();
 createV1QuotaAcquisitionCheckpoint(checkpoint.identity);
 const components:Record<string,unknown[]>=checkpoint.phase==='acquisition'?{...encodeV1QuotaWorkCheckpoint(checkpoint.acquisition).components}
  :{planAnchors:checkpoint.acquisition.planAnchors,quotaRows:checkpoint.acquisition.quotaRows};
 const control=canonicalJson({version:1,day:checkpoint.day,layout:checkpoint.layout,identity:checkpoint.identity,phase:checkpoint.phase,
  acquisition:checkpoint.phase==='acquisition'?encodeV1QuotaWorkCheckpoint(checkpoint.acquisition).control:null});
 if(size(control)>STORAGE_HISTORY_CONTROL_BYTES)throw fail();
 const manifest:Part[]=[],parts:string[]=[];
 for(const component of Object.keys(components).sort()){
  const entries=components[component];if(!Array.isArray(entries))throw fail();let chunk:unknown[]=[],bytes=2;
  const emit=async()=>{const text=canonicalJson(chunk);parts.push(text);manifest.push({component,sha256:await sha256Hex(text),bytes:size(text)});
   if(parts.length>STORAGE_HISTORY_MAX_PARTS)throw fail();chunk=[];bytes=2;};
  for(const entry of entries){const length=size(canonicalJson(entry));if(length+2>STORAGE_HISTORY_PART_BYTES)throw fail();
   if(bytes+length+(chunk.length?1:0)>STORAGE_HISTORY_PART_BYTES)await emit();bytes+=length+(chunk.length?1:0);chunk.push(entry);}
  if(chunk.length)await emit();
 }
 if(size(canonicalJson(manifest))>STORAGE_HISTORY_PART_BYTES)throw fail();
 const roundtrip=decode(control,manifest,parts);if(!same(roundtrip,checkpoint))throw fail();return {control,manifest,parts};
}
const ACTIVE=`EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=s.source_id AND o.owner_digest=s.owner_digest
 AND o.state='active' AND o.authority_epoch=s.authority_epoch)`;
async function current(target:D1Database,id:string){return target.prepare('SELECT generation,retired FROM analytics_history_checkpoint_heads WHERE key_digest=?').bind(id).first<{generation:string|null;retired:number}>();}
/** The target key is a private dependency identity, not authorization. Caller
 * must prove source eligibility before saving and before promoting final fits.
 * Each call writes at most32 statements; replay sends the same immutable input. */
export async function saveStorageHistoryCheckpoint(input:{target:D1Database;key:StorageHistoryKey;checkpoint:StorageV1HistoryCheckpoint;expectedHead:string|null;maxWrites?:number}){
 const {target}=input,key={...input.key},expected=input.expectedHead,max=input.maxWrites??32;bounded(max,3,32);pin(expected);
 const id=await keyDigest(key),f=await frame(key,structuredClone(input.checkpoint)),manifest=canonicalJson(f.manifest);
 const owner=await target.prepare("SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=? AND state='active'").bind(key.sourceId,key.ownerDigest).first<{revision:number;authority_epoch:number}>();
 if(!owner)throw fail();
 const generation=await sha256Hex(canonicalJson({key,expectedHead:expected,authorityEpoch:owner.authority_epoch,control:f.control,manifest:f.manifest}));
 let head=await current(target,id);if(head?.retired)throw fail();
 if(head?.generation===generation)return {status:'saved' as const,headDigest:generation};
 if((head?.generation??null)!==expected)throw fail();
 await target.prepare(`INSERT INTO analytics_history_checkpoint_stages
 (key_digest,generation,source_id,owner_digest,day,dependency_digest,source_namespace,method,expected_head,owner_revision,authority_epoch,control_json,manifest_json,part_count)
 SELECT ?,?,?,?,?,?,?,?,?,o.revision,o.authority_epoch,?,?,? FROM analytics_owner_state o
 WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.authority_epoch=?
 AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=? AND (h.retired=1 OR h.generation IS NOT ?))
 ON CONFLICT(key_digest,generation) DO NOTHING`).bind(id,generation,key.sourceId,key.ownerDigest,key.day,key.dependencyDigest,key.sourceNamespace,key.method,expected,
 f.control,manifest,f.parts.length,key.sourceId,key.ownerDigest,owner.authority_epoch,id,expected).run();
 const stage=await target.prepare(`SELECT s.* FROM analytics_history_checkpoint_stages s WHERE s.key_digest=? AND s.generation=? AND ${ACTIVE}`).bind(id,generation).first<Stage>();
 if(!stage||stage.control_json!==f.control||stage.manifest_json!==manifest||stage.expected_head!==expected)throw fail();
 const retained=(await target.prepare('SELECT part_index,sha256,payload_bytes FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=? ORDER BY part_index LIMIT 1025')
 .bind(id,generation).all<{part_index:number;sha256:string;payload_bytes:number}>()).results;
 const present=new Set<number>();for(const row of retained){const wanted=f.manifest[row.part_index];
 if(!wanted||wanted.sha256!==row.sha256||wanted.bytes!==row.payload_bytes)throw fail();present.add(row.part_index);}
 const missing=f.parts.map((_,i)=>i).filter(i=>!present.has(i)),page=missing.slice(0,max-2);
 const statements=page.map(i=>target.prepare(`INSERT INTO analytics_history_checkpoint_parts
 (key_digest,generation,part_index,sha256,payload_bytes,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
 .bind(id,generation,i,f.manifest[i]!.sha256,f.manifest[i]!.bytes,f.parts[i]!));
 const complete=page.length===missing.length;
 if(complete)statements.push(target.prepare(`INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired)
 SELECT s.key_digest,s.generation,0 FROM analytics_history_checkpoint_stages s WHERE s.key_digest=? AND s.generation=? AND ${ACTIVE}
 AND (SELECT count(*) FROM analytics_history_checkpoint_parts p WHERE p.key_digest=s.key_digest AND p.generation=s.generation)=s.part_count
 AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=s.key_digest AND (h.retired=1 OR h.generation IS NOT s.expected_head))
 ON CONFLICT(key_digest) DO UPDATE SET generation=excluded.generation WHERE analytics_history_checkpoint_heads.retired=0 AND analytics_history_checkpoint_heads.generation IS ?`).bind(id,generation,expected));
 if(statements.length)await target.batch(statements);
 head=await current(target,id);if(head?.retired)throw fail();
 if(head?.generation===generation)return {status:'saved' as const,headDigest:generation};
 if((head?.generation??null)!==expected||complete)throw fail();
 return {status:'staging' as const,generation,storedParts:present.size+page.length,totalParts:f.parts.length};
}
/** At most8 payload reads per call. In-memory cursor is private and bound to a
 * single promoted generation; every payload is rehashed before final decode. */
export async function loadStorageHistoryCheckpoint(input:{target:D1Database;key:StorageHistoryKey;cursor?:StorageHistoryLoadCursor;maxParts?:number}){
 const {target}=input,key={...input.key},max=input.maxParts??8;bounded(max,1,8);const id=await keyDigest(key),head=await current(target,id);
 if(!head?.generation||head.retired)return {status:'absent' as const};
 const stage=await target.prepare(`SELECT s.* FROM analytics_history_checkpoint_stages s WHERE s.key_digest=? AND s.generation=? AND ${ACTIVE}`)
 .bind(id,head.generation).first<Stage>();if(!stage)return {status:'absent' as const,headDigest:head.generation};
 const cursor=input.cursor;if(cursor&&(cursor.generation!==head.generation||!Array.isArray(cursor.parts)))throw fail();
 const parts=cursor?[...cursor.parts]:[],manifest=parse(stage.manifest_json) as Part[];
 if(!Array.isArray(manifest)||manifest.length!==stage.part_count||manifest.length>1024||parts.length>manifest.length)throw fail();
 const rows=(await target.prepare('SELECT part_index,sha256,payload_bytes,payload_json FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=? AND part_index>=? ORDER BY part_index LIMIT ?')
 .bind(id,head.generation,parts.length,max).all<{part_index:number;sha256:string;payload_bytes:number;payload_json:string}>()).results;
 for(const row of rows){const expected=manifest[parts.length];if(row.part_index!==parts.length||!expected||expected.sha256!==row.sha256||expected.bytes!==row.payload_bytes
  ||size(row.payload_json)!==row.payload_bytes||await sha256Hex(row.payload_json)!==row.sha256)throw fail();parts.push(row.payload_json);}
 if(parts.length<manifest.length){if(!rows.length)throw fail();return {status:'deferred' as const,cursor:{generation:head.generation,parts}};}
 for(let i=0;i<parts.length;i++)if(size(parts[i]!)!==manifest[i]!.bytes||await sha256Hex(parts[i]!)!==manifest[i]!.sha256)throw fail();
 const checkpoint=decode(stage.control_json,manifest,parts),f=await frame(key,checkpoint);
 if(await sha256Hex(canonicalJson({key,expectedHead:stage.expected_head,authorityEpoch:stage.authority_epoch,control:f.control,manifest:f.manifest}))!==head.generation)throw fail();
 const final=await target.prepare(`SELECT h.generation FROM analytics_history_checkpoint_heads h JOIN analytics_history_checkpoint_stages s
 ON s.key_digest=h.key_digest AND s.generation=h.generation WHERE h.key_digest=? AND h.retired=0 AND ${ACTIVE}`).bind(id).first<string>('generation');
 if(final!==head.generation)throw fail();return {status:'ready' as const,headDigest:head.generation,checkpoint};
}
/** Retire exactly this dependency key, never other days/owners. Head tombstone
 * prevents a delayed writer resurrecting it; payload deletion stays paged. */
export async function retireStorageHistoryCheckpoint(input:{target:D1Database;key:StorageHistoryKey;expectedHead:string|null;maxWrites?:number}){
 const {target}=input,max=input.maxWrites??32;bounded(max,2,32);pin(input.expectedHead);const id=await keyDigest({...input.key}),head=await current(target,id);
 if(head&&!head.retired&&head.generation!==input.expectedHead||!head&&input.expectedHead!==null)throw fail();
 await target.prepare(`INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired) VALUES(?,NULL,1)
 ON CONFLICT(key_digest) DO UPDATE SET retired=1,generation=NULL WHERE analytics_history_checkpoint_heads.retired=1 OR analytics_history_checkpoint_heads.generation IS ?`).bind(id,input.expectedHead).run();
 if(!(await current(target,id))?.retired)throw fail();
 const rows=(await target.prepare('SELECT generation,part_index FROM analytics_history_checkpoint_parts WHERE key_digest=? ORDER BY generation,part_index LIMIT ?').bind(id,max-1)
 .all<{generation:string;part_index:number}>()).results;
 if(rows.length)await target.batch(rows.map(row=>target.prepare('DELETE FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=? AND part_index=?').bind(id,row.generation,row.part_index)));
 else {const stages=(await target.prepare('SELECT generation FROM analytics_history_checkpoint_stages WHERE key_digest=? LIMIT ?').bind(id,max-1).all<{generation:string}>()).results;
  if(stages.length)await target.batch(stages.map(row=>target.prepare('DELETE FROM analytics_history_checkpoint_stages WHERE key_digest=? AND generation=?').bind(id,row.generation)));
  if(stages.length)return {status:'retiring' as const};}
 return {status:rows.length?'retiring' as const:'retired' as const};
}
