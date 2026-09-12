import { canonicalTelemetryV11Json, telemetryV11RecordAnchor, type TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { sha256 } from './crypto';
import { encodeTypedTelemetryId, typedTelemetryCanonicalRecords, encodeTypedTelemetryRecord } from './typed-telemetry-codec';
import { readTypedTelemetryPage } from './typed-telemetry-repository';

/** Only the isolated restore coordinator calls this adapter. Original source
 * rows are copied and independently verified elsewhere; this reconstructs the
 * bounded runtime proof indexes before ordinary triggers are installed. */
export const AUTHORITY_ADMISSION_TABLES = Object.freeze(['typed_v1_admission_state','typed_v1_chunk_allocations',
  'typed_v1_owner_memberships','typed_v1_record_admissions','typed_v11_admission_state','typed_v11_chunk_allocations',
  'typed_v11_owner_memberships','typed_v11_record_proofs','typed_v11_manifest_memberships']);
const binary=(value:Uint8Array)=>Uint8Array.from(value).buffer;
const fail=()=>new Error('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
const prefix=(format:'v1'|'v11')=>format==='v1'?'typed_v1':'typed_v11';
const code=(format:'v1'|'v11')=>format==='v1'?10:11;
interface Stored {id:number;owner_id:number;chunk_id:number;manifest_id:number|null;stream:number;occurrence_id:number[];observed_at_ms:number;canonical_digest:number[]}
interface Range {first_id:number;last_id:number;count:number}
function exactRead<T>(result:D1Result<T>|undefined):T {
 if(result?.success!==true||!Array.isArray(result.results)||result.results.length!==1)throw fail();
 return result.results[0]!;
}
export const MAX_AUTHORITY_ADOPTION_ROWS = 100;
interface State {high_water:number;after_id:number;copied:number;done:number;verify_after:number;verified:number;verify_done:number}
async function phase(db:D1Database,pin:string,verify:boolean){
 const row=await db.prepare('SELECT contract_digest,phase FROM _authority_restore_run WHERE id=1').first<{contract_digest:string;phase:string}>();
 if(row?.contract_digest!==pin||row.phase!==(verify?'sealed':'copying'))throw fail();
}
export async function restoreTypedAdmissionPage(db:D1Database,options:{format:'v1'|'v11';sourceNamespace:string;contractDigest:string;verify?:boolean;limit?:number}){
 const {format,sourceNamespace,contractDigest}=options, verify=options.verify===true, p=prefix(format);
 const limit=options.limit??MAX_AUTHORITY_ADOPTION_ROWS;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_AUTHORITY_ADOPTION_ROWS)throw fail();
 if(!['v1','v11'].includes(format)||!/^[0-9a-f]{64}$/.test(contractDigest))throw fail();
 await phase(db,contractDigest,verify);
 const checkpoint=await db.prepare('SELECT * FROM _authority_restore_adoption WHERE format=?').bind(format).first<State>();
 if(!checkpoint)throw fail();
 if(verify?checkpoint.verify_done:checkpoint.done)return {done:true,records:0};
 const after=verify?checkpoint.verify_after:checkpoint.after_id;
 const page=await readTypedTelemetryPage(db,{sourceNamespace,format,afterSourceRowId:after,limit});
 if(!verify)await db.prepare('INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?) ON CONFLICT DO NOTHING').bind(binary(encodeTypedTelemetryId(sourceNamespace))).run();
 const namespace=await db.prepare('SELECT id FROM typed_telemetry_namespaces WHERE original_id=?').bind(binary(encodeTypedTelemetryId(sourceNamespace))).first<number>('id');
 if(!namespace){if(page.records.length)throw fail();}
 const statements:D1PreparedStatement[]=[],proofReads:D1PreparedStatement[]=[],proofExpected:Record<string,unknown>[]=[];
 // The bounded 100-row page bounds all result sets. These reads are independent;
 // batch them without changing the proof writes or their checkpoint transaction.
 const fieldsForPage=page.records.map(record=>{
  const fields=encodeTypedTelemetryRecord(format,JSON.parse(record.canonicalRecord));
  if(record.observedDay!==record.chunkDay||new Date(fields.observedAtMs).toISOString().slice(0,10)!==record.chunkDay)throw fail();
  return fields;
 });
 const storedResults=page.records.length?await db.batch<Stored>(page.records.map(record=>db.prepare('SELECT id,owner_id,chunk_id,manifest_id,stream,occurrence_id,observed_at_ms,canonical_digest FROM typed_telemetry_records WHERE namespace_id=? AND format=? AND source_row_id=?')
  .bind(namespace,code(format),record.sourceRowId))):[];
 if(storedResults.length!==page.records.length)throw fail();
 const storedRows=storedResults.map(result=>exactRead(result));
 // Chunk ranges and staged headers are shared by records, but only when all
 // original membership fields match. Never key this cache on chunk ID alone.
 const headerReads:D1PreparedStatement[]=[],headerIndices=new Map<string,number>(),recordHeaders:number[]=[];
 for(const [index,record] of page.records.entries()){
  const key=canonicalTelemetryV11Json([storedRows[index]!.chunk_id,record.chunkRowId,record.participantId,record.deviceId,fieldsForPage[index]!.stream,record.chunkDay]);
  let at=headerIndices.get(key);
  if(at===undefined){at=headerReads.length;headerIndices.set(key,at);
   // The namespace/source-row index can otherwise scan the entire format.
   // This exact core UNIQUE index starts with chunk_id. At most 201 rows
   // prove a valid <=200-row range or force the existing overfull refusal.
   headerReads.push(db.prepare(`SELECT min(source_row_id) first_id,max(source_row_id) last_id,count(*) count
    FROM (SELECT source_row_id FROM typed_telemetry_records INDEXED BY sqlite_autoindex_typed_telemetry_records_2
     WHERE namespace_id=? AND format=? AND chunk_id=? LIMIT 201)`)
    .bind(namespace,code(format),storedRows[index]!.chunk_id),
    db.prepare(`SELECT record_count FROM _authority_stage_telemetry_${format}_chunks WHERE id=? AND participant_id=? AND device_id=? AND stream=? AND chunk_day=?`)
    .bind(record.chunkRowId,record.participantId,record.deviceId,fieldsForPage[index]!.stream,record.chunkDay));
  }
  recordHeaders.push(at);
 }
 const headerResults=headerReads.length?await db.batch<Range|{record_count:number}>(headerReads):[];
 if(headerResults.length!==headerReads.length)throw fail();
 const sharedProofs=new Map<string,string>();
 const proofRead=(table:string,expected:Record<string,unknown>,key:string,value:unknown,shared=false)=>{
  const identity=canonicalTelemetryV11Json([table,key,value]),encoded=canonicalTelemetryV11Json(expected);
  if(shared&&sharedProofs.has(identity)){if(sharedProofs.get(identity)!==encoded)throw fail();return;}
  if(shared)sharedProofs.set(identity,encoded);
  proofReads.push(db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).bind(value));proofExpected.push(expected);
 };
 for(const [index,record] of page.records.entries()){
  const fields=fieldsForPage[index]!,stored=storedRows[index]!;
  const range=exactRead(headerResults[recordHeaders[index]!]) as Range,header=exactRead(headerResults[recordHeaders[index]!+1]) as {record_count:number};
  if(range.count!==header.record_count||range.count<1||range.count>200||range.last_id-range.first_id+1!==range.count||!Number.isSafeInteger(range.last_id+1))throw fail();
  const parsed=typedTelemetryCanonicalRecords(encodeTypedTelemetryRecord(format,JSON.parse(record.canonicalRecord)));
  const expectedDigest=binary(await sha256(parsed.canonicalRecord));
  if(canonicalTelemetryV11Json(Array.from(new Uint8Array(expectedDigest)))!==canonicalTelemetryV11Json(stored.canonical_digest))throw fail();
  const allocation={chunk_id:record.chunkRowId,namespace_id:namespace,chunk_original:Array.from(encodeTypedTelemetryId(record.chunkRowId)),first_source_row_id:range.first_id,record_count:range.count};
  const membership={participant_id:record.participantId,typed_owner_id:stored.owner_id};
  let proof:Record<string,unknown>={typed_record_id:stored.id,chunk_id:record.chunkRowId};
  if(format==='v11'){
   const base={...parsed.record} as Record<string,unknown>;delete base.accountPlanAttribution;
   const anchor=telemetryV11RecordAnchor(fields.stream,parsed.record as TelemetryV11Record);
   proof={...proof,manifest_id:record.manifestId,stream:fields.stream,occurrence_id:anchor.occurrenceId,
    base_digest:Array.from(await sha256(canonicalTelemetryV11Json(base))),legacy_occurrence_id:parsed.legacy?.occurrenceId??null,
    legacy_digest:parsed.legacy?Array.from(await sha256(parsed.legacy.canonicalRecord)):null,observed_at_ms:encodeTypedTelemetryRecord(format,parsed.record).observedAtMs};
  }
  const physicalProof=format==='v11'?{typed_record_id:stored.id,chunk_key:stored.chunk_id,manifest_key:stored.manifest_id,
   stream_code:stored.stream,occurrence_blob:stored.occurrence_id,base_digest:proof.base_digest,
   legacy_occurrence_blob:parsed.legacy?Array.from(encodeTypedTelemetryId(parsed.legacy.occurrenceId)):null,
   legacy_digest:proof.legacy_digest,observed_at_ms:stored.observed_at_ms}:proof;
  const manifestMembership={manifest_id:record.manifestId,typed_manifest_id:stored.manifest_id};
  if(verify&&format==='v11'){
   proofReads.push(db.prepare(`SELECT ${Object.keys(physicalProof).join(',')} FROM typed_v11_record_proofs WHERE typed_record_id=?`).bind(stored.id));
   proofExpected.push(physicalProof);
   proofRead('typed_v11_manifest_memberships',manifestMembership,'manifest_id',record.manifestId,true);
  }
  if(verify){
   for(const [table,expected,key,value] of [[`${p}_chunk_allocations`,allocation,'chunk_id',record.chunkRowId],[`${p}_owner_memberships`,membership,'participant_id',record.participantId],[`${p}_record_admissions`,proof,'typed_record_id',stored.id]] as const){
    proofRead(table,expected,key,value,key!=='typed_record_id');
   }
  }else{
   for(const [table,expected] of [[`${p}_chunk_allocations`,allocation],[`${p}_owner_memberships`,membership],
    ...(format==='v11'?[['typed_v11_manifest_memberships',manifestMembership] as const]:[]),
    [format==='v11'?'typed_v11_record_proofs':`${p}_record_admissions`,physicalProof]] as const){
    const keys=Object.keys(expected),values=Object.values(expected).map(v=>Array.isArray(v)?Uint8Array.from(v as number[]).buffer:v);
    // Shared chunk/owner entries are repeated across pages; conflicts do not
    // mutate them. Independent verification rejects any differing prior row.
    statements.push(db.prepare(`INSERT INTO ${table}(${keys.join(',')}) SELECT ${keys.map(()=>'?').join(',')}
     WHERE EXISTS(SELECT 1 FROM typed_telemetry_records WHERE id=? AND namespace_id=? AND format=? AND source_row_id=? AND canonical_digest=?) ON CONFLICT DO NOTHING`)
     .bind(...values,stored.id,namespace,code(format),record.sourceRowId,expectedDigest));
   }
  }
 }
 if(proofReads.length){
  const results=await db.batch<Record<string,unknown>>(proofReads);
  if(results.length!==proofExpected.length)throw fail();
  for(const [index,result] of results.entries())if(canonicalTelemetryV11Json(exactRead(result))!==canonicalTelemetryV11Json(proofExpected[index]))throw fail();
 }
 const through=page.records.at(-1)?.sourceRowId??after, done=page.records.length===0;
 if(done){
  const expected=await db.prepare('SELECT max(source_row_id) maximum,count(*) count FROM typed_telemetry_records WHERE namespace_id=? AND format=?').bind(namespace,code(format)).first<{maximum:number|null;count:number}>();
  const next=Math.max(expected?.maximum??0,checkpoint.high_water)+1;
  if(!expected||!Number.isSafeInteger(next)||(verify?checkpoint.verified:checkpoint.copied)!==expected.count)throw fail();
  if(verify){
   const state=await db.prepare(`SELECT source_namespace,namespace_id,next_source_row_id,runtime_contract_version FROM ${p}_admission_state WHERE id=1`).first();
   if(canonicalTelemetryV11Json(state)!==canonicalTelemetryV11Json({source_namespace:sourceNamespace,namespace_id:namespace,next_source_row_id:next,runtime_contract_version:1}))throw fail();
   for(const [table,key,typedKey] of [[`${p}_chunk_allocations`,'chunk_id','chunk_id'],[`${p}_owner_memberships`,'participant_id','owner_id']] as const){const actual=await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');const expectedCount=await db.prepare(`SELECT count(DISTINCT ${typedKey}) n FROM typed_telemetry_records WHERE namespace_id=? AND format=?`).bind(namespace,code(format)).first<number>('n');if(actual!==expectedCount)throw fail();}
   const count=await db.prepare(`SELECT count(*) n FROM ${p}_record_admissions`).first<number>('n');if(count!==expected.count)throw fail();
   if(format==='v11'){
    if(await db.prepare('SELECT count(*) n FROM typed_v11_record_proofs').first<number>('n')!==expected.count)throw fail();
    const maps=await db.prepare('SELECT count(*) n FROM typed_v11_manifest_memberships').first<number>('n');
    if(maps!==await db.prepare('SELECT count(DISTINCT manifest_id) n FROM typed_telemetry_records WHERE namespace_id=? AND format=11').bind(namespace).first<number>('n'))throw fail();
   }
  }else{
   if(!namespace)throw fail();
   statements.push(db.prepare(`INSERT INTO ${p}_admission_state(id,source_namespace,namespace_id,next_source_row_id,runtime_contract_version) VALUES(1,?,?,?,1)`).bind(sourceNamespace,namespace,next));
  }
 }
 const cursor=verify?'verify_after':'after_id',counter=verify?'verified':'copied',finished=verify?'verify_done':'done';
 statements.push(db.prepare(`UPDATE _authority_restore_adoption SET ${cursor}=?,${counter}=${counter}+?,${finished}=? WHERE format=? AND ${cursor}=? AND ${finished}=0 RETURNING ${cursor}`)
  .bind(through,page.records.length,done?1:0,format,after));
 // A CAS guard rolls back every proof insert when another page has advanced.
 statements.push(db.prepare('INSERT INTO _authority_restore_adoption_assert SELECT 1 WHERE changes()!=1'));
 try{await db.batch(statements);}catch{
  const current=await db.prepare(`SELECT ${cursor} position,${counter} count,${finished} done FROM _authority_restore_adoption WHERE format=?`).bind(format).first<{position:number;count:number;done:number}>();
  if(!current||current.position!==through||current.count!==(verify?checkpoint.verified:checkpoint.copied)+page.records.length||current.done!==(done?1:0))throw new Error('AUTHORITY_RESTORE_ADOPTION_UNACKNOWLEDGED');
 }
 return {done,records:page.records.length};
}

/** One exact restored legacy chunk. Uses the normal source-event trigger and
 * authority predicates; repeated calls retain the existing event identity.
 * The operator must keep this target unbound until all retained current owners
 * have been traversed and the independent analytics consumer catches up. */
export async function bootstrapRestoredV1Chunk(db:D1Database,contractDigest:string,chunkId:string):Promise<'eligible-chunk'|'ineligible'> {
 const run=await db.prepare("SELECT 1 FROM _authority_restore_run WHERE id=1 AND contract_digest=? AND phase='ready'").bind(contractDigest).first();
 if(!run||typeof chunkId!=='string'||chunkId.length>256)throw fail();
 const eligible=`SELECT c.id,c.participant_id,s.source_namespace FROM telemetry_v1_chunks c
 JOIN typed_v1_admission_state s ON s.id=1 AND s.runtime_contract_version=1
 JOIN community_public_source_owners p ON p.participant_id=c.participant_id AND p.owner_kind='social'
 WHERE c.id=? AND c.superseded_at IS NULL AND c.record_count=c.accepted_record_count
 AND c.record_count=(SELECT count(*) FROM typed_v1_record_admissions a WHERE a.chunk_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=c.participant_id)`;
 await db.batch([
  db.prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
   SELECT participant_id,lower(hex(randomblob(32))),'active' FROM (${eligible}) WHERE 1
   ON CONFLICT(participant_id) DO NOTHING`).bind(chunkId),
  db.prepare(`INSERT INTO typed_v1_event_sources(event_digest,owner_digest,participant_id,chunk_id,source_namespace)
   SELECT lower(hex(randomblob(32))),link.owner_digest,c.participant_id,c.id,c.source_namespace FROM (${eligible}) c
   JOIN storage_v11_owner_links link ON link.participant_id=c.participant_id AND link.state='active'
   WHERE NOT EXISTS(SELECT 1 FROM typed_v1_event_sources WHERE chunk_id=c.id)`).bind(chunkId),
 ]);
 const row=await db.prepare(`SELECT 1 FROM (${eligible}) c JOIN typed_v1_event_sources e ON e.chunk_id=c.id
  JOIN storage_v11_owner_links link ON link.participant_id=c.participant_id AND link.owner_digest=e.owner_digest AND link.state='active'
  WHERE e.source_namespace=c.source_namespace`).bind(chunkId).first();
 return row?'eligible-chunk':'ineligible';
}
