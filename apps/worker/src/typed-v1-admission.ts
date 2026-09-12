import { assertTypedStorageAdmissionCapacity } from './typed-storage-capacity';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { ApiError } from './errors';
import { encodeTypedTelemetryId, TypedTelemetryError } from './typed-telemetry-codec';
import { prepareTypedTelemetryInsert } from './typed-telemetry-repository';
import { readTypedTelemetryRowsByStorageIds } from './typed-telemetry-compatibility';
import { MAX_STORAGE_TRANSACTION_STATEMENTS } from './storage-routing-batch-budget';
import { prepareTelemetryV1ChunkWrite, existingTelemetryV1ChunkByEnvelopeDigest, type TelemetryV1ChunkInsert, type TelemetryV1ChunkRow } from './telemetry-v1-repository';
import { parseTelemetryV1Chunk, assertTelemetryV1ConsentCurrent } from './telemetry-v1';
import { readIngestionChanges, type StorageChange } from './analytics-delivery';

const encoded = (value: string): ArrayBuffer => Uint8Array.from(encodeTypedTelemetryId(value)).buffer;
const conflict = () => new TypedTelemetryError('TYPED_TELEMETRY_CONFLICT');
interface State { runtime_contract_version:number; namespace_id: number; source_namespace: string; next_source_row_id: number }
/** New target only. Does not import retained v1 evidence or replace authority. */
export async function initializeTypedV1Admission(db: D1Database, namespace: string): Promise<void> {
 const bytes = encoded(namespace);
 const other=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='typed_v11_admission_state'").first();
 if(other){const pin=await db.prepare('SELECT source_namespace FROM typed_v11_admission_state WHERE id=1').first<{source_namespace:string}>();
  if(pin && pin.source_namespace!==namespace) throw conflict();}
 await db.batch([
  db.prepare('INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?) ON CONFLICT DO NOTHING').bind(bytes),
  db.prepare(`INSERT INTO typed_v1_admission_state(id,source_namespace,namespace_id,next_source_row_id)
   VALUES(1,?,(SELECT id FROM typed_telemetry_namespaces WHERE original_id=?),1)
   ON CONFLICT(id) DO UPDATE SET source_namespace=excluded.source_namespace,namespace_id=excluded.namespace_id`).bind(namespace,bytes),
  db.prepare('UPDATE typed_v1_admission_state SET runtime_contract_version=1 WHERE id=1'),
 ]);

}
/** Read-only committed receipt validation. A superseded receipt needs a newer
 * exact-slot journal proof; its removed old rows are never treated as current. */
export async function validateTypedTelemetryV1Receipt(db:D1Database, input:{sourceNamespace:string;participantId:string;deviceId:string;chunkRowId:string}):Promise<TelemetryV1ChunkRow|null> {
 const scope={...input};
 const row=await db.prepare('SELECT * FROM telemetry_v1_chunks WHERE id=? AND participant_id=? AND device_id=?')
  .bind(scope.chunkRowId,scope.participantId,scope.deviceId).first<TelemetryV1ChunkRow>();
 if(!row)return null;
 const event=await db.prepare(`SELECT j.*,s.source_id FROM storage_source_state s CROSS JOIN typed_v1_event_sources e JOIN storage_ingestion_changes j ON j.event_digest=e.event_digest
  WHERE e.chunk_id=? AND e.participant_id=? AND e.source_namespace=? AND j.owner_digest=e.owner_digest AND j.content_digest=?`)
  .bind(row.id,scope.participantId,scope.sourceNamespace,row.chunk_digest).first<{source_id:string;sequence:number}>();
 if(!event || row.record_count<1 || row.record_count>200 || row.accepted_record_count!==row.record_count)throw conflict();
 const change=(await readIngestionChanges(db,event.source_id,event.sequence-1,1))[0];
 if(!change)throw conflict();
 const disposition=await lookupTypedV1Source(db,change);
 if(row.superseded_at!==null){if(disposition.disposition!=='superseded')throw conflict();return row;}
 const ids=(await db.prepare('SELECT typed_record_id FROM typed_v1_record_admissions WHERE chunk_id=? ORDER BY typed_record_id')
  .bind(row.id).all<{typed_record_id:number}>()).results.map(r=>r.typed_record_id);
 if(ids.length!==row.record_count)throw conflict();
 const records=await readTypedTelemetryRowsByStorageIds(db,{sourceNamespace:scope.sourceNamespace,participantId:scope.participantId,storageRowIds:ids});
 if(records.some(r=>r.format!=='v1'||r.device_id!==scope.deviceId||r.chunk_row_id!==row.id)
  ||await sha256Hex(canonicalJson(records.map(r=>JSON.parse(r.record_json))))!==row.chunk_digest)throw conflict();
 return row;
}
async function replay(db: D1Database, insert: TelemetryV1ChunkInsert, namespace: string): Promise<boolean> {
 const row = await existingTelemetryV1ChunkByEnvelopeDigest(db,insert.participantId,insert.envelopeDigest);
 if (!row) return false;
 if (row.device_id!==insert.deviceId || row.chunk_digest!==insert.chunk.chunkDigest || row.stream!==insert.chunk.stream
  || row.chunk_day!==insert.chunk.chunkDay || row.chunk_seq!==insert.chunk.chunkSeq || row.revision!==insert.chunk.chunkRevision
  || row.record_count!==insert.chunk.records.length || row.superseded_at!==null) throw conflict();
 const proofs=(await db.prepare('SELECT typed_record_id FROM typed_v1_record_admissions WHERE chunk_id=? ORDER BY typed_record_id')
  .bind(row.id).all<{typed_record_id:number}>()).results;
 if(proofs.length!==row.record_count) throw conflict();
 const records=await readTypedTelemetryRowsByStorageIds(db,{sourceNamespace:namespace,participantId:insert.participantId,storageRowIds:proofs.map(p=>p.typed_record_id)});
 if(records.some(r=>r.device_id!==insert.deviceId || r.chunk_row_id!==row.id || r.format!=='v1')
  || canonicalJson(records.map(r=>r.record_json).sort())!==canonicalJson(insert.chunk.records.map(r=>canonicalJson(r)).sort())
  || !await db.prepare('SELECT 1 FROM typed_v1_event_sources WHERE chunk_id=? AND source_namespace=?').bind(row.id,namespace).first()) throw conflict();
 return true;
}
/** Same baseline header/authorization/supersession transaction, compact rows.
 * All legacy graph invalidation triggers remain; a split role must replace their
 * derived-data work separately. No analytics database is called by this adapter.
 */
export async function insertTypedTelemetryV1Chunk(db: D1Database, value: TelemetryV1ChunkInsert & {authorizationEnvelopeDigest?:string},
 sourceNamespace: string): Promise<{acceptedRecords:number;replay:boolean}> {
 const insert=JSON.parse(JSON.stringify(value)) as TelemetryV1ChunkInsert & {authorizationEnvelopeDigest?:string};
 const authorizationEnvelopeDigest=insert.authorizationEnvelopeDigest??insert.envelopeDigest;
 if(!/^[a-f0-9]{64}$/.test(authorizationEnvelopeDigest))throw conflict();
 for(const id of [sourceNamespace,insert.participantId,insert.deviceId,insert.chunkRowId]) encoded(id);
 const c=insert.chunk;
 const chunk=parseTelemetryV1Chunk({schemaVersion:c.schemaVersion,chunkId:c.chunkId,chunkRevision:c.chunkRevision,
  chunkDigest:c.chunkDigest,parserVersion:c.parserVersion,consent:c.consent,records:c.records});
 assertTelemetryV1ConsentCurrent(chunk.consent); insert.chunk=chunk;
 const prior=insert.supersedes;
 if(prior && (prior.participant_id!==insert.participantId || prior.device_id!==insert.deviceId
  || prior.stream!==chunk.stream || prior.chunk_day!==chunk.chunkDay || prior.chunk_seq!==chunk.chunkSeq
  || prior.revision+1!==chunk.chunkRevision || prior.superseded_at!==null)) throw conflict();
 if(!prior && chunk.chunkRevision!==1) throw conflict();
 if(await sha256Hex(canonicalJson(chunk.records))!==chunk.chunkDigest) throw new ApiError(400,'CHUNK_DIGEST_MISMATCH');
 const state=await db.prepare('SELECT * FROM typed_v1_admission_state WHERE id=1').first<State>();
 if(!state || state.runtime_contract_version!==1 || state.source_namespace!==sourceNamespace || !Number.isSafeInteger(state.next_source_row_id)
  || state.next_source_row_id<1 || !Number.isSafeInteger(state.next_source_row_id+chunk.records.length)) throw conflict();
 if(await replay(db,insert,sourceNamespace)) return {acceptedRecords:chunk.records.length,replay:true};
 await assertTypedStorageAdmissionCapacity(db);
 const start=state.next_source_row_id;
 const typed:D1PreparedStatement[]=[db.prepare(`INSERT INTO typed_v1_chunk_allocations(chunk_id,namespace_id,chunk_original,first_source_row_id,record_count)
 VALUES(?,?,?,?,?)`).bind(insert.chunkRowId,state.namespace_id,encoded(insert.chunkRowId),start,chunk.records.length)];
 const rows=chunk.records.map((record,i)=>({sourceNamespace,format:'v1' as const,sourceRowId:start+i,participantId:insert.participantId,
 deviceId:insert.deviceId,chunkRowId:insert.chunkRowId,manifestId:null,chunkDay:chunk.chunkDay,observedDay:chunk.chunkDay,record}));
 // Conservatively account for all subpages plus the bounded header/journal SQL
 // and bound metadata. No individual subpage can hide a combined D1 byte limit.
 let transactionBytes=64*1024+new TextEncoder().encode(canonicalJson({...insert,chunk:{...chunk,records:[]}})).byteLength;
 for(let offset=0;offset<rows.length;offset+=100){
  const page=await prepareTypedTelemetryInsert(db,rows.slice(offset,offset+100));transactionBytes+=page.byteLength;
  if(transactionBytes>4*1024*1024)throw new TypedTelemetryError('TYPED_TELEMETRY_LIMIT');
  typed.push(...page.statements);
 }
 typed.push(db.prepare(`INSERT INTO typed_v1_owner_memberships(participant_id,typed_owner_id)
 SELECT ?,owner_id FROM typed_telemetry_records WHERE namespace_id=? AND format=10 AND source_row_id=?
 ON CONFLICT(participant_id) DO UPDATE SET typed_owner_id=excluded.typed_owner_id`).bind(insert.participantId,state.namespace_id,start));
 typed.push(db.prepare(`INSERT INTO typed_v1_record_admissions(typed_record_id,chunk_id)
 SELECT id,? FROM typed_telemetry_records WHERE namespace_id=? AND format=10 AND source_row_id>=? AND source_row_id<?`)
 .bind(insert.chunkRowId,state.namespace_id,start,start+rows.length));
 typed.push(db.prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
 VALUES(?,lower(hex(randomblob(32))),'active') ON CONFLICT(participant_id) DO NOTHING`).bind(insert.participantId));
 typed.push(db.prepare(`INSERT INTO typed_v1_event_sources(event_digest,owner_digest,participant_id,chunk_id,source_namespace)
 SELECT lower(hex(randomblob(32))),owner_digest,participant_id,?,? FROM storage_v11_owner_links WHERE participant_id=?`)
 .bind(insert.chunkRowId,sourceNamespace,insert.participantId));
 const deletes=insert.supersedes?[db.prepare(`DELETE FROM typed_telemetry_chunks WHERE namespace_id=? AND format=10
 AND original_id=(SELECT chunk_original FROM typed_v1_chunk_allocations WHERE chunk_id=?)`)
 .bind(state.namespace_id,insert.supersedes.id)]:[];
 const {statements,chunkStatementIndex}=prepareTelemetryV1ChunkWrite(db,insert,{insertStatements:typed,deleteSupersededStatements:deletes,authorizationEnvelopeDigest});
 statements.unshift(db.prepare(`INSERT INTO typed_v1_authority_requests(chunk_id,participant_id,device_id,authorization_id,authorization_digest,envelope_digest)
 VALUES(?,?,?,?,?,?)`).bind(insert.chunkRowId,insert.participantId,insert.deviceId,insert.deviceUploadAuthorizationId,authorizationEnvelopeDigest,insert.envelopeDigest));
 statements.push(db.prepare('DELETE FROM typed_v1_authority_requests WHERE chunk_id=?').bind(insert.chunkRowId));
 if(statements.length>MAX_STORAGE_TRANSACTION_STATEMENTS) throw new TypedTelemetryError('TYPED_TELEMETRY_LIMIT');
 try {
  const results=await db.batch(statements);
  if(results.some(r=>!r.success) || results[chunkStatementIndex+1]?.results.length!==1) throw conflict();
 } catch(error) {
  if(await replay(db,insert,sourceNamespace)) return {acceptedRecords:rows.length,replay:true};
  const message=String(error);
  if(message.includes('typed_v1_allocator_conflict')) throw new ApiError(409,'UPLOAD_IN_PROGRESS');
  if(message.includes('typed_telemetry_records.device_id')) throw new ApiError(409,'RECORD_OWNED_BY_OTHER_CHUNK');
  if(message.includes('upload unavailable')) throw new ApiError(401,'UPLOAD_AUTH_INVALID');
  throw error;
 }
 return {acceptedRecords:rows.length,replay:false};
}

/** Source-proven v1 change metadata, never a mutable "latest owner" substitute.
 * Consumers must handle superseded explicitly; it is NOT owner withdrawal.
 * Rows from a different device/slot are not eligible supersession evidence. */
export async function lookupTypedV1Source(db:D1Database, change:StorageChange):Promise<{
 disposition:'chunk'|'superseded';sourceNamespace:string;participantId:string;deviceId:string;chunkId:string;
 stream:string;day:string;chunkSeq:number;revision:number;chunkDigest:string; supersedingEventDigest:string|null;
}> {
 const actual=(await readIngestionChanges(db,change.sourceId,change.sequence-1,1))[0];
 if(!actual || canonicalJson(actual)!==canonicalJson(change)) throw conflict();
 const row=await db.prepare(`SELECT e.source_namespace,c.* FROM typed_v1_event_sources e JOIN telemetry_v1_chunks c ON c.id=e.chunk_id
 WHERE e.event_digest=? AND e.owner_digest=? AND c.chunk_digest=?`).bind(change.eventDigest,change.ownerDigest,change.contentDigest)
 .first<{source_namespace:string;id:string;participant_id:string;device_id:string;stream:string;chunk_day:string;chunk_seq:number;revision:number;chunk_digest:string;superseded_at:string|null}>();
 if(!row) throw conflict();
 let newer:string|null=null;
 if(row.superseded_at!==null){
  const proof=await db.prepare(`SELECT e.event_digest FROM telemetry_v1_chunks c JOIN typed_v1_event_sources e ON e.chunk_id=c.id
   JOIN storage_ingestion_changes j ON j.event_digest=e.event_digest AND j.owner_digest=e.owner_digest
   WHERE c.participant_id=? AND c.device_id=? AND c.stream=? AND c.chunk_day=? AND c.chunk_seq=?
   AND c.revision>? AND c.superseded_at IS NULL AND e.owner_digest=? AND e.source_namespace=? AND j.sequence>?`)
   .bind(row.participant_id,row.device_id,row.stream,row.chunk_day,row.chunk_seq,row.revision,change.ownerDigest,row.source_namespace,change.sequence)
   .first<{event_digest:string}>();
  if(!proof) throw conflict(); newer=proof.event_digest;
 }
 return {disposition:newer?'superseded':'chunk',sourceNamespace:row.source_namespace,participantId:row.participant_id,
 deviceId:row.device_id,chunkId:row.id,stream:row.stream,day:row.chunk_day,chunkSeq:row.chunk_seq,revision:row.revision,
 chunkDigest:row.chunk_digest,supersedingEventDigest:newer};
}
