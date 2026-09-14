import { canonicalTelemetryV11Json, telemetryV11RecordAnchor,
 type TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from './canonical-json';
import { sha256, sha256Hex } from './crypto';
import { ApiError } from './errors';
import { telemetryV11LegacyProjection } from './telemetry-v11-compatibility';
import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { retainedTypedTelemetryOriginStatements } from './typed-telemetry-origins';
import { prepareTypedTelemetryInsert, type TypedTelemetrySourceRecord } from './typed-telemetry-repository';
import { MAX_TYPED_TELEMETRY_BATCH_BYTES } from './typed-telemetry-repository';
import { prepareTypedStorageAdmissionReservation, reconcileTypedStorageAdmissionReservation } from './typed-storage-capacity';
import type { OwnerStorageRoute } from './storage-routing';

type Row=Record<string,unknown>;
type Bind=string|number|null|ArrayBuffer;
const fail=()=>new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
const binary=(value:Uint8Array)=>Uint8Array.from(value).buffer;
const encoded=(value:string)=>binary(encodeTypedTelemetryId(value));
const MAX_ROWS=201;
const encoder=new TextEncoder();

interface ImportRow {
 move_id:string;owner_id:string;participant_id:string;source_namespace:string;
 state:'manifests'|'domains'|'complete';manifest_after_created_at:string|null;manifest_after_id:string|null;
 current_manifest_id:string|null;chunk_after_created_at:string|null;chunk_after_id:string|null;
 current_chunk_id:string|null;chunk_phase:'raw'|'typed'|null;last_domain_id:string|null;
 current_domain_id:string|null;domain_after_day:string|null;domain_count:number;
 source_head_generation_id:string|null;source_head_revision:number|null;source_head_updated_at:string|null;
 completed_digest:string|null;updated_at:string;
}

const AUTH_COLUMNS=['id','participant_id','issued_by_device_id','secret_hash','envelope_digest','body_bytes','content_type',
 'state','issued_at','expires_at','consumed_at','revoked_at','consume_lease_expires_at','consumed_contribution_id'] as const;
const MANIFEST_COLUMNS=['id','participant_id','device_id','chunk_day','manifest_digest','parser_version','manifest_json',
 'expected_chunk_count','state','created_at','ready_at'] as const;
const CHUNK_COLUMNS=['id','manifest_id','participant_id','device_id','stream','chunk_day','chunk_seq','chunk_id','chunk_digest',
 'envelope_digest','parser_version','record_count','r2_key','device_upload_authorization_id','quarantine_deleted_at','created_at'] as const;
const RECORD_COLUMNS=['chunk_id','manifest_id','stream','occurrence_id','observed_at','record_json','legacy_occurrence_id','legacy_record_json'] as const;
const PREDECESSOR_COLUMNS=['token_hash','participant_id','device_id','previous_generation_id','legacy_fingerprint','input_revision',
 'from_day','through_day','winners_json','created_at','expires_at','consumed_at'] as const;
const DOMAIN_COLUMNS=['id','participant_id','device_id','predecessor_token_hash','previous_generation_id','manifest_digest',
 'legacy_fingerprint','input_revision','from_day','through_day','days_json','created_at'] as const;
const EVENT_SOURCE_COLUMNS=['event_digest','owner_digest','participant_id','device_id','generation_id','manifest_digest',
 'from_day','through_day','head_revision','input_revision','recorded_ms'] as const;
const EVENT_CHANGE_COLUMNS=['event_digest','owner_digest','revision','kind','object_digest','content_digest','recorded_ms'] as const;

function normalized(value:unknown):unknown{
 if(value instanceof ArrayBuffer)return Array.from(new Uint8Array(value));
 if(value instanceof Uint8Array)return Array.from(value);
 if(Array.isArray(value))return value.map(normalized);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Row).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalized(v)]));
 return value;
}
function exact(result:D1Result<unknown>|undefined):Row{
 if(result?.success!==true||result.results.length!==1||!result.results[0]||typeof result.results[0]!=='object')throw fail();
 return result.results[0] as Row;
}
function same(actual:Row|null,expected:Row):void{
 if(!actual||canonicalJson(normalized(actual))!==canonicalJson(normalized(expected)))throw fail();
}
function values<C extends readonly string[]>(row:Row,columns:C):Bind[]{
 if(columns.some(column=>!Object.hasOwn(row,column)))throw fail();
 return columns.map(column=>row[column] as Bind);
}
function insert(db:D1Database,table:string,columns:readonly string[],row:Row,overrides:Row={}):D1PreparedStatement{
 const snapshot={...row,...overrides};
 return db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`)
  .bind(...values(snapshot,columns));
}
function growthBytes(values:unknown[],recordCount:number):number{
 const bytes=encoder.encode(canonicalJson(normalized(values))).byteLength+recordCount*1024;
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_TYPED_TELEMETRY_BATCH_BYTES
  ||!Number.isSafeInteger(recordCount)||recordCount<1||recordCount>200)throw fail();
 return bytes;
}
async function growthBatch(destination:D1Database,route:OwnerStorageRoute,bytes:number,recordCount:number,
 statements:D1PreparedStatement[]):Promise<D1Result<unknown>[]>{
 if(route.mode!=='catalog')throw fail();
 const reservation=await prepareTypedStorageAdmissionReservation(destination,route,{transactionBytes:bytes,recordCount});
 const result=await destination.batch([reservation.statement,...statements]);
 if(result.some(item=>!item.success))throw fail();
 await reconcileTypedStorageAdmissionReservation(destination,reservation,result[0],result.at(-1));
 return result.slice(1);
}
async function current(db:D1Database,moveId:string):Promise<ImportRow>{
 const row=await db.prepare('SELECT * FROM storage_owner_move_history_imports WHERE move_id=?').bind(moveId).first<ImportRow>();
 if(!row)throw fail();return row;
}
async function assertSourceOwner(source:D1Database,row:ImportRow):Promise<void>{
 const owner=await source.prepare(`SELECT ledger.installation_principal_id owner_id
  FROM participants p JOIN accountless_upload_owners o ON o.participant_id=p.id
  JOIN accountless_enrollment_ledger ledger ON ledger.device_id=o.enrollment_device_id
  WHERE p.id=? AND p.owner_kind='accountless' LIMIT 2`).bind(row.participant_id).all<{owner_id:string}>();
 if(owner.results.length!==1||owner.results[0]!.owner_id!==row.owner_id)throw fail();
}

async function sourceDomainAuthority(source:D1Database,row:ImportRow):Promise<{link:Row;revision:Row}>{
 const link=await source.prepare(`SELECT * FROM storage_v11_owner_links
  WHERE participant_id=? AND state='active'`).bind(row.participant_id).first<Row>();
 if(!link)throw fail();
 const revision=await source.prepare(`SELECT * FROM storage_owner_revisions
  WHERE owner_digest=? AND state='active'`).bind(link.owner_digest as string).first<Row>();
 if(!revision||revision.revision!==link.head_revision)throw fail();
 return {link,revision};
}

export async function initializeOwnerMoveHistoryImport(options:{destination:D1Database;moveId:string;ownerId:string;
 participantId:string;sourceNamespace:string;nowEpoch:number;destinationRoute:OwnerStorageRoute}):Promise<void>{
 const at=new Date(options.nowEpoch).toISOString();
 await growthBatch(options.destination,options.destinationRoute,8*1024,1,[options.destination.prepare(`INSERT INTO storage_owner_move_history_imports(
  move_id,owner_id,participant_id,source_namespace,state,updated_at) VALUES(?,?,?,?,'manifests',?)
  ON CONFLICT(move_id) DO NOTHING`).bind(options.moveId,options.ownerId,options.participantId,options.sourceNamespace,at)]);
 const row=await current(options.destination,options.moveId);
 if(row.owner_id!==options.ownerId||row.participant_id!==options.participantId||row.source_namespace!==options.sourceNamespace)throw fail();
}

async function startNextManifest(source:D1Database,destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<boolean>{
 const rows=(await source.prepare(`SELECT * FROM telemetry_v11_day_manifests WHERE participant_id=?
  AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 2`)
  .bind(row.participant_id,row.manifest_after_created_at,row.manifest_after_created_at,row.manifest_after_created_at,row.manifest_after_id).all<Row>()).results;
 if(rows.length>1){ /* bounded lookahead is expected */ }
 const manifest=rows[0];
 if(!manifest){
  await destination.prepare(`UPDATE storage_owner_move_history_imports SET state='domains',updated_at=?
   WHERE move_id=? AND state='manifests' AND current_manifest_id IS NULL`).bind(at,row.move_id).run();
  return false;
 }
 if(manifest.state!=='ready'||manifest.participant_id!==row.participant_id)throw fail();
 await growthBatch(destination,route,growthBytes([manifest],1),1,[
  destination.prepare(`UPDATE storage_owner_move_history_imports SET current_manifest_id=?,chunk_after_created_at=NULL,
   chunk_after_id=NULL,updated_at=? WHERE move_id=? AND state='manifests' AND current_manifest_id IS NULL`)
   .bind(manifest.id as string,at,row.move_id),
  insert(destination,'telemetry_v11_day_manifests',MANIFEST_COLUMNS,manifest,{state:'staged',ready_at:null}),
 ]);
 const actual=await destination.prepare('SELECT * FROM telemetry_v11_day_manifests WHERE id=?')
  .bind(manifest.id as string).first<Row>();
 same(actual,{...manifest,state:'staged',ready_at:null});
 return true;
}

async function startNextChunk(source:D1Database,destination:D1Database,row:ImportRow,at:string):Promise<boolean>{
 const rows=(await source.prepare(`SELECT * FROM telemetry_v11_chunks WHERE manifest_id=?
  AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 2`)
  .bind(row.current_manifest_id,row.chunk_after_created_at,row.chunk_after_created_at,row.chunk_after_created_at,row.chunk_after_id).all<Row>()).results;
 const chunk=rows[0];
 if(!chunk){
  const manifest=await source.prepare('SELECT * FROM telemetry_v11_day_manifests WHERE id=? AND participant_id=?')
   .bind(row.current_manifest_id,row.participant_id).first<Row>();if(!manifest||manifest.state!=='ready')throw fail();
  await destination.prepare(`UPDATE telemetry_v11_day_manifests SET state='ready',ready_at=? WHERE id=? AND state='staged'`)
   .bind(manifest.ready_at as string,manifest.id as string).run();
  same(await destination.prepare('SELECT * FROM telemetry_v11_day_manifests WHERE id=?').bind(manifest.id as string).first<Row>(),manifest);
  await destination.prepare(`UPDATE storage_owner_move_history_imports SET manifest_after_created_at=?,manifest_after_id=?,
   current_manifest_id=NULL,chunk_after_created_at=NULL,chunk_after_id=NULL,updated_at=?
   WHERE move_id=? AND state='manifests' AND current_manifest_id=? AND current_chunk_id IS NULL`)
   .bind(manifest.created_at as string,manifest.id as string,at,row.move_id,manifest.id as string).run();
  return false;
 }
 if(chunk.participant_id!==row.participant_id||chunk.manifest_id!==row.current_manifest_id)throw fail();
 await destination.prepare(`UPDATE storage_owner_move_history_imports SET current_chunk_id=?,chunk_phase='raw',updated_at=?
  WHERE move_id=? AND state='manifests' AND current_manifest_id=? AND current_chunk_id IS NULL`)
  .bind(chunk.id as string,at,row.move_id,row.current_manifest_id).run();
 return true;
}

async function importRawChunk(source:D1Database,destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<void>{
 const chunk=await source.prepare('SELECT * FROM telemetry_v11_chunks WHERE id=? AND participant_id=? AND manifest_id=?')
  .bind(row.current_chunk_id,row.participant_id,row.current_manifest_id).first<Row>();if(!chunk)throw fail();
 const auth=await source.prepare('SELECT * FROM device_upload_authorizations WHERE id=? AND participant_id=?')
  .bind(chunk.device_upload_authorization_id as string,row.participant_id).first<Row>();if(!auth||auth.state!=='consumed')throw fail();
 const records=(await source.prepare('SELECT * FROM telemetry_v11_records WHERE chunk_id=? ORDER BY occurrence_id LIMIT ?')
  .bind(row.current_chunk_id,MAX_ROWS).all<Row>()).results;
 if(records.length>200)throw fail();
 const result=await growthBatch(destination,route,growthBytes([auth,chunk,...records],Math.max(1,records.length)),
  Math.max(1,records.length),[
  insert(destination,'device_upload_authorizations',AUTH_COLUMNS,auth),
  insert(destination,'telemetry_v11_chunks',CHUNK_COLUMNS,chunk),
  ...records.map(record=>insert(destination,'telemetry_v11_records',RECORD_COLUMNS,record)),
 ]);
 if(result.some(item=>!item.success))throw fail();
 same(await destination.prepare('SELECT * FROM device_upload_authorizations WHERE id=?').bind(auth.id as string).first<Row>(),auth);
 same(await destination.prepare('SELECT * FROM telemetry_v11_chunks WHERE id=?').bind(chunk.id as string).first<Row>(),chunk);
 const copied=(await destination.prepare('SELECT * FROM telemetry_v11_records WHERE chunk_id=? ORDER BY occurrence_id LIMIT ?')
  .bind(row.current_chunk_id,MAX_ROWS).all<Row>()).results;
 if(canonicalJson(normalized(copied))!==canonicalJson(normalized(records)))throw fail();
 await destination.prepare(`UPDATE storage_owner_move_history_imports SET chunk_phase='typed',updated_at=?
  WHERE move_id=? AND state='manifests' AND current_chunk_id=? AND chunk_phase='raw'`)
  .bind(at,row.move_id,row.current_chunk_id).run();
}

async function importTypedChunk(destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<void>{
 const chunk=await destination.prepare('SELECT * FROM telemetry_v11_chunks WHERE id=? AND participant_id=?')
  .bind(row.current_chunk_id,row.participant_id).first<Row>();if(!chunk)throw fail();
 const staged=(await destination.prepare(`SELECT * FROM storage_owner_move_staged_records
  WHERE move_id=? AND participant_id=? AND chunk_row_id=? ORDER BY source_row_id LIMIT ?`)
  .bind(row.move_id,row.participant_id,row.current_chunk_id,MAX_ROWS).all<Row>()).results;
 if(staged.length!==Number(chunk.record_count)||staged.length>200)throw fail();
 const records:TypedTelemetrySourceRecord[]=staged.map(item=>({sourceNamespace:row.source_namespace,format:'v11',
  sourceRowId:Number(item.source_row_id),participantId:row.participant_id,deviceId:item.device_id as string,
  chunkRowId:item.chunk_row_id as string,manifestId:item.manifest_id as string,chunkDay:item.chunk_day as string,
  observedDay:item.observed_day as string,record:JSON.parse(item.canonical_record as string)}));
 const prepared=await prepareTypedTelemetryInsert(destination,records);
 const sourceIds=records.map(record=>record.sourceRowId),first=Math.min(...sourceIds);
 if(Math.max(...sourceIds)!==first+records.length-1)throw fail();
 const namespace=encoded(row.source_namespace);
 const statements=[destination.prepare('INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?) ON CONFLICT DO NOTHING').bind(namespace),
  ...retainedTypedTelemetryOriginStatements(destination,row.source_namespace,row.move_id,at),
  destination.prepare(`INSERT INTO typed_v11_chunk_allocations(chunk_id,namespace_id,chunk_original,first_source_row_id,record_count)
   SELECT ?,id,?,?,? FROM typed_telemetry_namespaces WHERE original_id=? ON CONFLICT DO NOTHING`)
   .bind(row.current_chunk_id,encoded(row.current_chunk_id!),first,records.length,namespace),...prepared.statements,
  destination.prepare(`INSERT INTO typed_v11_owner_memberships(participant_id,namespace_id,typed_owner_id)
   SELECT ?,r.namespace_id,r.owner_id FROM typed_telemetry_records r JOIN typed_telemetry_namespaces n ON n.id=r.namespace_id
   WHERE n.original_id=? AND r.format=11 AND r.source_row_id=? ON CONFLICT DO NOTHING`)
   .bind(row.participant_id,namespace,first),
  destination.prepare(`INSERT INTO typed_v11_manifest_memberships(manifest_id,namespace_id,typed_manifest_id)
   SELECT ?,r.namespace_id,r.manifest_id FROM typed_telemetry_records r JOIN typed_telemetry_namespaces n ON n.id=r.namespace_id
   WHERE n.original_id=? AND r.format=11 AND r.source_row_id=? ON CONFLICT DO NOTHING`)
   .bind(row.current_manifest_id,namespace,first)];
 for(const record of records){
  const stream=chunk.stream as 'usage'|'quota'|'session',typedRecord=record.record as TelemetryV11Record;
  const anchor=telemetryV11RecordAnchor(stream,typedRecord);
  const legacy=telemetryV11LegacyProjection(stream,typedRecord),base={...(typedRecord as unknown as Record<string,unknown>)};
  delete base.accountPlanAttribution;
  statements.push(destination.prepare(`INSERT INTO typed_v11_record_proofs(typed_record_id,chunk_key,manifest_key,
   stream_code,occurrence_blob,base_digest,legacy_occurrence_blob,legacy_digest,observed_at_ms)
   SELECT r.id,r.chunk_id,r.manifest_id,r.stream,r.occurrence_id,?,?,?,r.observed_at_ms
   FROM typed_telemetry_records r JOIN typed_telemetry_namespaces n ON n.id=r.namespace_id
   WHERE n.original_id=? AND r.format=11 AND r.source_row_id=? ON CONFLICT DO NOTHING`)
   .bind(binary(await sha256(canonicalTelemetryV11Json(base))),legacy?encoded(legacy.occurrenceId):null,
    legacy?binary(await sha256(legacy.canonicalRecord)):null,namespace,record.sourceRowId));
 }
 const result=await growthBatch(destination,route,growthBytes(staged,Math.max(1,records.length)),
  Math.max(1,records.length),statements);if(result.some(item=>!item.success))throw fail();
 const admitted=await destination.prepare('SELECT count(*) n FROM typed_v11_record_admissions WHERE chunk_id=? AND manifest_id=?')
  .bind(row.current_chunk_id,row.current_manifest_id).first<number>('n');
 if(admitted!==records.length)throw fail();
 await destination.prepare(`UPDATE storage_owner_move_history_imports SET chunk_after_created_at=?,chunk_after_id=?,
  current_chunk_id=NULL,chunk_phase=NULL,updated_at=? WHERE move_id=? AND state='manifests'
  AND current_chunk_id=? AND chunk_phase='typed'`).bind(chunk.created_at as string,chunk.id as string,at,row.move_id,row.current_chunk_id).run();
}

async function advanceManifest(source:D1Database,destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<void>{
 if(!row.current_manifest_id){await startNextManifest(source,destination,route,row,at);return;}
 if(!row.current_chunk_id){await startNextChunk(source,destination,row,at);return;}
 if(row.chunk_phase==='raw')await importRawChunk(source,destination,route,row,at);
 else if(row.chunk_phase==='typed')await importTypedChunk(destination,route,row,at);else throw fail();
}

async function startDomain(source:D1Database,destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<boolean>{
 const candidates=(await source.prepare(`SELECT * FROM telemetry_v11_domains WHERE participant_id=?
  AND previous_generation_id IS ? ORDER BY created_at,id LIMIT 2`).bind(row.participant_id,row.last_domain_id).all<Row>()).results;
 if(candidates.length>1)throw fail();const domain=candidates[0];
 if(!domain)return false;
 const predecessor=await source.prepare('SELECT * FROM telemetry_v11_domain_predecessors WHERE token_hash=? AND participant_id=?')
  .bind(domain.predecessor_token_hash as string,row.participant_id).first<Row>();if(!predecessor||predecessor.consumed_at===null)throw fail();
 const future='9999-12-31T23:59:59.999Z';
 const result=await growthBatch(destination,route,growthBytes([predecessor,domain],2),2,[
  destination.prepare(`UPDATE storage_owner_move_history_imports SET current_domain_id=?,domain_after_day=NULL,updated_at=?
   WHERE move_id=? AND state='domains' AND current_domain_id IS NULL AND last_domain_id IS ?`)
   .bind(domain.id as string,at,row.move_id,row.last_domain_id),
  insert(destination,'telemetry_v11_domain_predecessors',PREDECESSOR_COLUMNS,predecessor,{consumed_at:null,expires_at:future}),
  insert(destination,'telemetry_v11_domains',DOMAIN_COLUMNS,domain),
 ]);if(result.some(item=>!item.success))throw fail();
 same(await destination.prepare('SELECT * FROM telemetry_v11_domains WHERE id=?').bind(domain.id as string).first<Row>(),domain);
 same(await destination.prepare('SELECT * FROM telemetry_v11_domain_predecessors WHERE token_hash=?')
  .bind(predecessor.token_hash as string).first<Row>(),{...predecessor,consumed_at:null,expires_at:future});
 return true;
}

async function advanceDomain(source:D1Database,destination:D1Database,route:OwnerStorageRoute,row:ImportRow,at:string):Promise<void>{
 if(!row.current_domain_id){
   if(await startDomain(source,destination,route,row,at))return;
  const [sourceCount,sourceHead,destinationHead]=await Promise.all([
   source.prepare('SELECT count(*) n FROM telemetry_v11_domains WHERE participant_id=?').bind(row.participant_id).first<number>('n'),
   source.prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(row.participant_id).first<Row>(),
   destination.prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(row.participant_id).first<Row>(),
  ]);
  if(sourceCount!==row.domain_count||canonicalJson(normalized(sourceHead))!==canonicalJson(normalized(destinationHead)))throw fail();
  const authority=sourceHead?await sourceDomainAuthority(source,row):null;
  if(authority&&(authority.link.generation_id!==sourceHead!.generation_id||authority.link.head_revision!==sourceHead!.revision))throw fail();
  if(authority)same(await destination.prepare('SELECT * FROM storage_owner_revisions WHERE owner_digest=?')
   .bind(authority.link.owner_digest as string).first<Row>(),authority.revision);
  const digest=await sha256Hex(`app-usagemonitor/storage-owner-move-history/v1\0${canonicalJson({moveId:row.move_id,
   ownerId:row.owner_id,participantId:row.participant_id,sourceNamespace:row.source_namespace,
   manifestAfter:[row.manifest_after_created_at,row.manifest_after_id],head:normalized(sourceHead),domainCount:row.domain_count})}`);
  const statements:D1PreparedStatement[]=[];
  if(authority)statements.push(destination.prepare(`UPDATE storage_v11_owner_links SET state=?,generation_id=?,
   head_revision=?,object_digest=?,manifest_digest=? WHERE participant_id=? AND owner_digest=?`)
   .bind(authority.link.state as string,authority.link.generation_id as string,authority.link.head_revision as number,
    authority.link.object_digest as string,authority.link.manifest_digest as string,row.participant_id,
    authority.link.owner_digest as string));
  statements.push(destination.prepare(`UPDATE storage_owner_move_history_imports SET state='complete',completed_digest=?,
   source_head_generation_id=?,source_head_revision=?,source_head_updated_at=?,updated_at=?
   WHERE move_id=? AND state='domains' AND current_domain_id IS NULL`)
   .bind(digest,sourceHead?.generation_id??null,sourceHead?.revision??null,sourceHead?.updated_at??null,at,row.move_id));
  const copied=await destination.batch(statements);if(copied.some(item=>!item.success))throw fail();
  if(authority){
   same(await destination.prepare('SELECT * FROM storage_v11_owner_links WHERE participant_id=?')
    .bind(row.participant_id).first<Row>(),authority.link);
   same(await destination.prepare('SELECT * FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(authority.link.owner_digest as string).first<Row>(),authority.revision);
  }
  return;
 }
 const days=(await source.prepare(`SELECT * FROM telemetry_v11_domain_days WHERE generation_id=?
  AND (? IS NULL OR observed_day>?) ORDER BY observed_day LIMIT 100`)
  .bind(row.current_domain_id,row.domain_after_day,row.domain_after_day).all<Row>()).results;
 if(days.length){
   const result=await growthBatch(destination,route,growthBytes(days,days.length),days.length,[...days.map(day=>insert(destination,'telemetry_v11_domain_days',
   ['generation_id','observed_day','manifest_id'],day)),destination.prepare(`UPDATE storage_owner_move_history_imports
   SET domain_after_day=?,updated_at=? WHERE move_id=? AND state='domains' AND current_domain_id=? AND domain_after_day IS ?`)
   .bind(days.at(-1)!.observed_day as string,at,row.move_id,row.current_domain_id,row.domain_after_day)]);
  if(result.some(item=>!item.success))throw fail();return;
 }
 const [domain,predecessor,sourceHead,destinationHead,authority]=await Promise.all([
  source.prepare('SELECT * FROM telemetry_v11_domains WHERE id=? AND participant_id=?').bind(row.current_domain_id,row.participant_id).first<Row>(),
  source.prepare(`SELECT p.* FROM telemetry_v11_domains d JOIN telemetry_v11_domain_predecessors p
   ON p.token_hash=d.predecessor_token_hash WHERE d.id=? AND d.participant_id=?`).bind(row.current_domain_id,row.participant_id).first<Row>(),
  source.prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(row.participant_id).first<Row>(),
  destination.prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(row.participant_id).first<Row>(),
  sourceDomainAuthority(source,row),
 ]);if(!domain||!predecessor||predecessor.consumed_at===null)throw fail();
 const events=(await source.prepare(`SELECT event.* FROM storage_v11_event_sources event
  JOIN storage_v11_owner_links link ON link.owner_digest=event.owner_digest
  WHERE event.generation_id=? AND event.participant_id=? AND link.participant_id=?
  ORDER BY event.event_digest LIMIT 2`).bind(row.current_domain_id,row.participant_id,row.participant_id).all<Row>()).results;
 if(events.length!==1)throw fail();const event=events[0]!;
 const repeated=destinationHead?.generation_id===domain.id;
 const revision=repeated?Number(destinationHead!.revision):destinationHead?Number(destinationHead.revision)+1:1;
 if(sourceHead&&sourceHead.generation_id===domain.id&&sourceHead.revision!==revision)throw fail();
 if(event.owner_digest!==authority.link.owner_digest||event.participant_id!==row.participant_id
  ||event.device_id!==domain.device_id||event.generation_id!==domain.id||event.manifest_digest!==domain.manifest_digest
  ||event.head_revision!==revision||event.input_revision!==domain.input_revision)throw fail();
 const head=repeated
  ?destination.prepare(`UPDATE telemetry_v11_domain_heads SET generation_id=generation_id
    WHERE participant_id=? AND generation_id=? AND revision=?`).bind(row.participant_id,domain.id as string,revision)
  :destinationHead
  ?destination.prepare(`UPDATE telemetry_v11_domain_heads SET generation_id=?,revision=?,updated_at=?
    WHERE participant_id=? AND generation_id=? AND revision=?`).bind(domain.id as string,revision,predecessor.consumed_at as string,
      row.participant_id,destinationHead.generation_id as string,destinationHead.revision as number)
  :destination.prepare(`INSERT INTO telemetry_v11_domain_heads(participant_id,generation_id,revision,updated_at)
    VALUES(?,?,?,?)`).bind(row.participant_id,domain.id as string,revision,predecessor.consumed_at as string);
 const linkColumns=['participant_id','owner_digest','state','generation_id','head_revision','object_digest','manifest_digest'] as const;
  const result=await growthBatch(destination,route,growthBytes([domain,predecessor,event],3),3,[
  destination.prepare(`INSERT INTO storage_v11_owner_links(${linkColumns.join(',')}) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(participant_id) DO UPDATE SET state='active',generation_id=excluded.generation_id,
    head_revision=excluded.head_revision,object_digest=excluded.object_digest,manifest_digest=excluded.manifest_digest
   WHERE storage_v11_owner_links.owner_digest=excluded.owner_digest AND storage_v11_owner_links.state='active'`)
   .bind(authority.link.participant_id as string,authority.link.owner_digest as string,'active',domain.id as string,revision,
    authority.link.object_digest as string,domain.manifest_digest as string),
  head,
  insert(destination,'storage_v11_event_sources',EVENT_SOURCE_COLUMNS,event),
  destination.prepare(`UPDATE telemetry_v11_domain_predecessors SET expires_at=? WHERE token_hash=?`)
   .bind(predecessor.expires_at as string,predecessor.token_hash as string),
 ]);if(result.some(item=>!item.success))throw fail();
 same(await destination.prepare('SELECT * FROM telemetry_v11_domain_predecessors WHERE token_hash=?')
  .bind(predecessor.token_hash as string).first<Row>(),predecessor);
 same(await destination.prepare('SELECT * FROM storage_v11_event_sources WHERE event_digest=?')
  .bind(event.event_digest as string).first<Row>(),event);
 const sourceChange=await source.prepare(`SELECT ${EVENT_CHANGE_COLUMNS.join(',')} FROM storage_ingestion_changes
  WHERE event_digest=?`).bind(event.event_digest as string).first<Row>();
 if(!sourceChange)throw fail();
 same(await destination.prepare(`SELECT ${EVENT_CHANGE_COLUMNS.join(',')} FROM storage_ingestion_changes
  WHERE event_digest=?`).bind(event.event_digest as string).first<Row>(),sourceChange);
 await destination.prepare(`UPDATE storage_owner_move_history_imports SET last_domain_id=?,current_domain_id=NULL,
  domain_after_day=NULL,domain_count=domain_count+1,updated_at=? WHERE move_id=? AND state='domains' AND current_domain_id=?`)
  .bind(domain.id as string,at,row.move_id,row.current_domain_id).run();
}

/** Advance exactly one durable unit. Repeating after a lost acknowledgement
 * resumes from the destination journal; the source must remain fenced. */
export async function advanceOwnerMoveHistoryImport(options:{source:D1Database;destination:D1Database;moveId:string;nowEpoch:number;
 destinationRoute:OwnerStorageRoute}){
 const at=new Date(options.nowEpoch).toISOString(),row=await current(options.destination,options.moveId);
 if(row.state==='complete')return {state:row.state,completedDigest:row.completed_digest};
 await assertSourceOwner(options.source,row);
 if(row.owner_id!==options.destinationRoute.ownerId)throw fail();
 if(row.state==='manifests')await advanceManifest(options.source,options.destination,options.destinationRoute,row,at);
 else await advanceDomain(options.source,options.destination,options.destinationRoute,row,at);
 const next=await current(options.destination,options.moveId);
 return {state:next.state,completedDigest:next.completed_digest};
}

export async function requireOwnerMoveHistoryComplete(destination:D1Database,moveId:string):Promise<string>{
 const row=await current(destination,moveId);
 if(row.state!=='complete'||!row.completed_digest)throw fail();return row.completed_digest;
}
