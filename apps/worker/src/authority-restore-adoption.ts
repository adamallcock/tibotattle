import { canonicalTelemetryV11Json, telemetryV11RecordAnchor, type TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { sha256 } from './crypto';
import { encodeTypedTelemetryId, typedTelemetryCanonicalRecords, encodeTypedTelemetryRecord } from './typed-telemetry-codec';
import { MAX_TYPED_TELEMETRY_BATCH_BYTES, readTypedTelemetryPage } from './typed-telemetry-repository';
import { MAX_STORAGE_TRANSACTION_STATEMENTS } from './storage-routing-batch-budget';

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
export const MAX_AUTHORITY_ADOPTION_ROWS = 200;
// Includes the typed reader (at most three session-tool queries), the keyed
// metadata reads below, terminal checks, checkpoint/CAS and uncertain readback.
// The coordinator separately reserves its unchanged source/capacity statements.
const FIXED_STATEMENTS = 32, FIXED_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const limitFailure = () => new Error('AUTHORITY_RESTORE_ADOPTION_LIMIT');
interface Query { sql:string; args:unknown[] }
const queryBytes = ({sql,args}:Query) => encoder.encode(sql).byteLength + args.reduce<number>((total,value) => total +
 (typeof value==='string'?encoder.encode(value).byteLength:value instanceof ArrayBuffer?value.byteLength:8),0);
const statement = (db:D1Database,query:Query) => db.prepare(query.sql).bind(...query.args);
function keyedRows<T extends Record<string,unknown>>(result:D1Result<T>|undefined,key:string,values:unknown[]):T[] {
 if(result?.success!==true||!Array.isArray(result.results)||result.results.length!==values.length)throw fail();
 const rows=new Map<unknown,T>();
 for(const row of result.results){
  if(!row||!values.includes(row[key])||rows.has(row[key]))throw fail();
  rows.set(row[key],row);
 }
 return values.map(value=>{const row=rows.get(value);if(!row)throw fail();return row;});
}
interface ProofGroup {table:string;key:string;projection:string;expected:Map<unknown,Record<string,unknown>>}
function proofQueries(groups:Map<string,ProofGroup>):{query:Query;key:string;expected:Record<string,unknown>[]}[] {
 const queries:{query:Query;key:string;expected:Record<string,unknown>[]}[]=[];
 for(const group of groups.values()){
  const entries=[...group.expected.entries()];
  for(let offset=0;offset<entries.length;offset+=100){
   const part=entries.slice(offset,offset+100);
   queries.push({query:{sql:`SELECT ${group.projection} FROM ${group.table} WHERE ${group.key} IN (${part.map(()=>'?').join(',')}) LIMIT ${part.length+1}`,
    args:part.map(([value])=>value)},key:group.key,expected:part.map(([,value])=>value)});
  }
 }
 return queries;
}
interface State {high_water:number;after_id:number;copied:number;done:number;verify_after:number;verified:number;verify_done:number}
async function phase(db:D1Database,pin:string,verify:boolean){
 const row=await db.prepare('SELECT contract_digest,phase FROM _authority_restore_run WHERE id=1').first<{contract_digest:string;phase:string}>();
 if(row?.contract_digest!==pin||row.phase!==(verify?'sealed':'copying'))throw fail();
}
export async function restoreTypedAdmissionPage(db:D1Database,options:{format:'v1'|'v11';sourceNamespace:string;contractDigest:string;verify?:boolean;limit?:number;maxStatements?:number;maxBytes?:number}){
 const {format,sourceNamespace,contractDigest}=options, verify=options.verify===true, p=prefix(format);
 const limit=options.limit??MAX_AUTHORITY_ADOPTION_ROWS;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_AUTHORITY_ADOPTION_ROWS)throw fail();
 const maxStatements=options.maxStatements??MAX_STORAGE_TRANSACTION_STATEMENTS-64,maxBytes=options.maxBytes??MAX_TYPED_TELEMETRY_BATCH_BYTES;
 if(!Number.isSafeInteger(maxStatements)||maxStatements<FIXED_STATEMENTS||maxStatements>MAX_STORAGE_TRANSACTION_STATEMENTS
  ||!Number.isSafeInteger(maxBytes)||maxBytes<FIXED_BYTES||maxBytes>MAX_TYPED_TELEMETRY_BATCH_BYTES)throw limitFailure();
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
 const statements:D1PreparedStatement[]=[];
 // Fetch the same indexed rows in <=100-bind sets. Explicit keyed cardinality
 // checks retain per-record identity even if the provider reorders result rows.
 const fieldsForPage=page.records.map(record=>{
  const fields=encodeTypedTelemetryRecord(format,JSON.parse(record.canonicalRecord));
  if(record.observedDay!==record.chunkDay||new Date(fields.observedAtMs).toISOString().slice(0,10)!==record.chunkDay)throw fail();
  return fields;
 });
 const storedQueries:Query[]=[];
 for(let offset=0;offset<page.records.length;offset+=98){
  const ids=page.records.slice(offset,offset+98).map(record=>record.sourceRowId);
  storedQueries.push({sql:`SELECT source_row_id,id,owner_id,chunk_id,manifest_id,stream,occurrence_id,observed_at_ms,canonical_digest FROM typed_telemetry_records WHERE namespace_id=? AND format=? AND source_row_id IN (${ids.map(()=>'?').join(',')}) LIMIT ${ids.length+1}`,
   args:[namespace,code(format),...ids]});
 }
 const storedResults=storedQueries.length?await db.batch<Stored&Record<string,unknown>>(storedQueries.map(query=>statement(db,query))):[];
 if(storedResults.length!==storedQueries.length)throw fail();
 const storedRows=storedResults.flatMap((result,index)=>keyedRows(result,'source_row_id',storedQueries[index]!.args.slice(2)));
 for(const row of storedRows){
  if([row.id,row.owner_id,row.chunk_id].some(value=>!Number.isSafeInteger(value)||value<1)
   ||(row.manifest_id!==null&&(!Number.isSafeInteger(row.manifest_id)||row.manifest_id<1))
   ||![1,2,3].includes(row.stream)||!Number.isSafeInteger(row.observed_at_ms)
   ||!Array.isArray(row.canonical_digest)||row.canonical_digest.length!==32
   ||!Array.isArray(row.occurrence_id)||!row.occurrence_id.length
   ||[...row.canonical_digest,...row.occurrence_id].some(value=>!Number.isInteger(value)||value<0||value>255))throw fail();
 }
 // Choose the largest deterministic prefix whose distinct memberships and
 // every per-record proof fit. No header/proof SQL is executed for its suffix;
 // the initial bounded typed/metadata page has already been read and checked.
 const headerKey=(index:number)=>canonicalTelemetryV11Json([storedRows[index]!.chunk_id,page.records[index]!.chunkRowId,
  page.records[index]!.participantId,page.records[index]!.deviceId,fieldsForPage[index]!.stream,page.records[index]!.chunkDay]);
 const headers=new Set<string>(),chunks=new Map<string,string>(),owners=new Map<string,string>(),manifests=new Map<string,string>();
 const same=(map:Map<string,string>,key:string,value:unknown)=>{const encoded=canonicalTelemetryV11Json(value);if(map.has(key)&&map.get(key)!==encoded)throw fail();map.set(key,encoded);};
 let count=0;
 for(const [index,record] of page.records.entries()){
  headers.add(headerKey(index));
  same(chunks,record.chunkRowId,[namespace,storedRows[index]!.chunk_id,headerKey(index)]);
  same(owners,record.participantId,storedRows[index]!.owner_id);
  if(format==='v11')same(manifests,record.manifestId!,storedRows[index]!.manifest_id);
  const recordCount=index+1;
  const proofCount=verify?(Math.ceil(recordCount/100)*(format==='v11'?2:1)+Math.ceil(chunks.size/100)+Math.ceil(owners.size/100)+Math.ceil(manifests.size/100))
   :recordCount+chunks.size+owners.size+manifests.size;
  if(FIXED_STATEMENTS+headers.size*2+proofCount>maxStatements)break;
  count=recordCount;
 }
 if(page.records.length&&!count)throw limitFailure();
 // Chunk ranges and staged headers are shared by records, but only when all
 // original membership fields match. Never key this cache on chunk ID alone.
 const headerQueries:Query[]=[],headerIndices=new Map<string,number>(),recordHeaders:number[]=[];let headerBytes=0;
 for(const [index,record] of page.records.slice(0,count).entries()){
  const key=headerKey(index);
  let at=headerIndices.get(key);
  if(at===undefined){at=headerQueries.length;headerIndices.set(key,at);
   // The namespace/source-row index can otherwise scan the entire format.
   // This exact core UNIQUE index starts with chunk_id. At most 201 rows
   // prove a valid <=200-row range or force the existing overfull refusal.
   const added:Query[]=[{sql:`SELECT min(source_row_id) first_id,max(source_row_id) last_id,count(*) count
    FROM (SELECT source_row_id FROM typed_telemetry_records INDEXED BY sqlite_autoindex_typed_telemetry_records_2
     WHERE namespace_id=? AND format=? AND chunk_id=? LIMIT 201)`,args:[namespace,code(format),storedRows[index]!.chunk_id]},
    {sql:`SELECT record_count FROM _authority_stage_telemetry_${format}_chunks WHERE id=? AND participant_id=? AND device_id=? AND stream=? AND chunk_day=?`,
     args:[record.chunkRowId,record.participantId,record.deviceId,fieldsForPage[index]!.stream,record.chunkDay]}];
   const addedBytes=added.reduce((bytes,query)=>bytes+queryBytes(query),0);
   if(FIXED_BYTES+headerBytes+addedBytes>maxBytes){count=index;break;}
   headerBytes+=addedBytes;
   headerQueries.push(...added);
  }
  recordHeaders.push(at);
 }
 if(page.records.length&&!count)throw limitFailure();
 const headerResults=headerQueries.length?await db.batch<Range|{record_count:number}>(headerQueries.map(query=>statement(db,query))):[];
 if(headerResults.length!==headerQueries.length)throw fail();
 const prepared=[];
 for(const [index,record] of page.records.slice(0,count).entries()){
  const fields=fieldsForPage[index]!,stored=storedRows[index]!;
  const range=exactRead(headerResults[recordHeaders[index]!]) as Range,header=exactRead(headerResults[recordHeaders[index]!+1]) as {record_count:number};
  if([range.count,range.first_id,range.last_id].some(value=>!Number.isSafeInteger(value)||value<1)
   ||range.count!==header.record_count||range.count>200||range.last_id-range.first_id+1!==range.count||!Number.isSafeInteger(range.last_id+1))throw fail();
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
  prepared.push({record,stored,expectedDigest,allocation,membership,proof,physicalProof,manifestMembership});
 }
 let writes:Query[]=[],reads:ReturnType<typeof proofQueries>=[];
 while(true){
  writes=[];const groups=new Map<string,ProofGroup>(),sharedWrites=new Map<string,string>();
  const proofRead=(table:string,expected:Record<string,unknown>,key:string,value:unknown,shared=false,projection='*')=>{
   const identity=canonicalTelemetryV11Json([table,key,projection]);let group=groups.get(identity);
   if(!group){group={table,key,projection,expected:new Map()};groups.set(identity,group);}
   if(group.expected.has(value)){if(!shared||canonicalTelemetryV11Json(group.expected.get(value))!==canonicalTelemetryV11Json(expected))throw fail();return;}
   group.expected.set(value,expected);
  };
  for(const item of prepared.slice(0,count)){
   const {record,stored,expectedDigest,allocation,membership,proof,physicalProof,manifestMembership}=item;
   if(verify){
    if(format==='v11'){
     proofRead('typed_v11_record_proofs',physicalProof,'typed_record_id',stored.id,false,Object.keys(physicalProof).join(','));
     proofRead('typed_v11_manifest_memberships',manifestMembership,'manifest_id',record.manifestId,true);
    }
    for(const [table,expected,key,value] of [[`${p}_chunk_allocations`,allocation,'chunk_id',record.chunkRowId],[`${p}_owner_memberships`,membership,'participant_id',record.participantId],[`${p}_record_admissions`,proof,'typed_record_id',stored.id]] as const)
     proofRead(table,expected,key,value,key!=='typed_record_id');
   }else{
    for(const [table,expected,key,value] of [[`${p}_chunk_allocations`,allocation,'chunk_id',record.chunkRowId],[`${p}_owner_memberships`,membership,'participant_id',record.participantId],
     ...(format==='v11'?[['typed_v11_manifest_memberships',manifestMembership,'manifest_id',record.manifestId] as const]:[]),
     [format==='v11'?'typed_v11_record_proofs':`${p}_record_admissions`,physicalProof,'typed_record_id',stored.id]] as const){
     if(key!=='typed_record_id'){
      const identity=canonicalTelemetryV11Json([table,key,value]),encoded=canonicalTelemetryV11Json(expected);
      if(sharedWrites.has(identity)){if(sharedWrites.get(identity)!==encoded)throw fail();continue;}
      sharedWrites.set(identity,encoded);
     }
     const keys=Object.keys(expected),values=Object.values(expected).map(v=>Array.isArray(v)?Uint8Array.from(v as number[]).buffer:v);
     writes.push({sql:`INSERT INTO ${table}(${keys.join(',')}) SELECT ${keys.map(()=>'?').join(',')}
      WHERE EXISTS(SELECT 1 FROM typed_telemetry_records WHERE id=? AND namespace_id=? AND format=? AND source_row_id=? AND canonical_digest=?) ON CONFLICT DO NOTHING`,
      args:[...values,stored.id,namespace,code(format),record.sourceRowId,expectedDigest]});
    }
   }
  }
  reads=proofQueries(groups);
  const queries=[...headerQueries,...writes,...reads.map(read=>read.query)];
  if(FIXED_STATEMENTS+queries.length<=maxStatements&&FIXED_BYTES+queries.reduce((bytes,query)=>bytes+queryBytes(query),0)<=maxBytes)break;
  if(count<2)throw limitFailure();count=Math.floor(count/2);
 }
 if(reads.length){
  const results=await db.batch<Record<string,unknown>>(reads.map(read=>statement(db,read.query)));
  if(results.length!==reads.length)throw fail();
  for(const [index,result] of results.entries()){
   const read=reads[index]!,actual=keyedRows(result,read.key,read.expected.map(row=>row[read.key]));
   for(const [at,row] of actual.entries())if(canonicalTelemetryV11Json(row)!==canonicalTelemetryV11Json(read.expected[at]))throw fail();
  }
 }
 statements.push(...writes.map(query=>statement(db,query)));
 const through=page.records[count-1]?.sourceRowId??after, done=page.records.length===0;
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
  .bind(through,count,done?1:0,format,after));
 // A CAS guard rolls back every proof insert when another page has advanced.
 statements.push(db.prepare('INSERT INTO _authority_restore_adoption_assert SELECT 1 WHERE changes()!=1'));
 try{await db.batch(statements);}catch{
  const current=await db.prepare(`SELECT ${cursor} position,${counter} count,${finished} done FROM _authority_restore_adoption WHERE format=?`).bind(format).first<{position:number;count:number;done:number}>();
  if(!current||current.position!==through||current.count!==(verify?checkpoint.verified:checkpoint.copied)+count||current.done!==(done?1:0))throw new Error('AUTHORITY_RESTORE_ADOPTION_UNACKNOWLEDGED');
 }
 return {done,records:count};
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
