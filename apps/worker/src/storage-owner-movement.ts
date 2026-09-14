import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { ApiError } from './errors';
import { createOwnerMoveCoordinator, type OwnerStorageRoute, type StorageShardBindings } from './storage-routing';
import { prepareTypedStorageAdmissionReservation, reconcileTypedStorageAdmissionReservation } from './typed-storage-capacity';
import { MAX_TYPED_TELEMETRY_BATCH_BYTES, readTypedTelemetryPage,
  type TypedTelemetryStoredRecord } from './typed-telemetry-repository';
import { ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS, ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION } from './accountless-enrollment';
import { ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS, ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION } from './accountless-ownership';
import { telemetryV11RequiredConsent } from '@app-usagemonitor/telemetry-contract';
import { advanceOwnerMoveHistoryImport, initializeOwnerMoveHistoryImport,
 requireOwnerMoveHistoryComplete } from './storage-owner-move-domain';

export const OWNER_MOVE_COPY_PAGE = 100;
const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const fail=()=>new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
type Row=Record<string,unknown>;
type PlanState='copying'|'ready'|'fencing'|'finalizing'|'verified'|'committed'|'abandoning'|'abandoned';
interface Plan {
 move_id:string;owner_id:string;source_shard_id:string;destination_shard_id:string;
 source_generation:number;destination_generation:number;reservation_bytes:number;source_namespace:string;
 state:PlanState;precopy_after_source_row_id:number;precopy_high_water:number;final_high_water:number|null;
 materialized_after_source_row_id:number;verify_after_source_row_id:number;verify_chain_digest:string|null;
 authority_digest:string|null;copy_digest:string|null;
}
interface Endpoint {binding_name:string}
interface AuthoritySnapshot {participantId:string;deviceId:string;digest:string;rows:Readonly<Record<string,Row>>}
interface AuthorityPin {participant_id:string;device_id:string;authority_digest:string;state:'prepared'|'materialized'}

const AUTHORITY_TABLES=Object.freeze({
 accountless_enrollment_ledger:['device_id','device_secret_hash','installation_principal_id','schema_version','policy_version','authorization_basis','state','issued_at','expires_at','revoked_at','revocation_reason','renewal_generation','renewed_at'],
 participants:['id','owner_kind','access_token_id','access_token_hash','recovery_token_id','recovery_token_hash','state','consent_version','consented_at','created_at','deletion_session_id','identity_link_key','identity_cooldown_digest'],
 device_credentials:['id','participant_id','authority_kind','paired_via_pairing_id','accountless_enrollment_device_id','secret_hash','state','issued_at','expires_at','last_used_at','revoked_at','social_verified_at','credential_generation'],
 accountless_upload_owners:['enrollment_device_id','participant_id','device_credential_id','policy_version','authorization_basis','authorized_at','expires_at','state','revoked_at','revocation_reason'],
 accountless_v11_device_authorizations:['enrollment_device_id','participant_id','device_credential_id','telemetry_schema_version','field_dictionary_version','privacy_contract_version','authorized_at','expires_at','state','revoked_at','revocation_reason'],
 attribution_enrollments:['participant_id','namespace','created_at'],
 telemetry_transport_participant_floors:['participant_id','minimum_rank','revision','changed_at'],
} as const);

function id(value:string){if(typeof value!=='string'||!ID.test(value))throw fail();}
function integer(value:number,min=0){if(!Number.isSafeInteger(value)||value<min)throw fail();}
function database(bindings:StorageShardBindings,name:string):D1Database{
 const value=bindings[name];if(!value)throw fail();return value;
}
function destinationRoute(value:Plan,bindingName:string):OwnerStorageRoute{
 return {ownerId:value.owner_id,shardId:value.destination_shard_id,bindingName,
  generation:value.destination_generation,mode:'catalog'};
}
function normalized(value:unknown):unknown{
 if(value instanceof ArrayBuffer)return Array.from(new Uint8Array(value));
 if(value instanceof Uint8Array)return Array.from(value);
 if(Array.isArray(value))return value.map(normalized);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Row).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalized(v)]));
 return value;
}
function exactRow(result:D1Result<unknown>|undefined):Row{
 if(result?.success!==true||result.results.length!==1||!result.results[0]||typeof result.results[0]!=='object')throw fail();
 return result.results[0] as Row;
}
function insertExact(db:D1Database,table:keyof typeof AUTHORITY_TABLES,row:Row):D1PreparedStatement{
 const columns=AUTHORITY_TABLES[table];
 if(columns.some(column=>!Object.hasOwn(row,column)))throw fail();
 return db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`)
  .bind(...columns.map(column=>row[column] as string|number|null|ArrayBuffer));
}
async function plan(catalog:D1Database,moveId:string):Promise<Plan>{
 id(moveId);const row=await catalog.prepare('SELECT * FROM storage_owner_move_preparations WHERE move_id=? LIMIT 1')
  .bind(moveId).first<Plan>();if(!row)throw fail();return row;
}
async function endpoints(catalog:D1Database,bindings:StorageShardBindings,value:Plan){
 const rows=await catalog.batch<Endpoint>([
  catalog.prepare('SELECT binding_name FROM storage_shards WHERE shard_id=?').bind(value.source_shard_id),
  catalog.prepare('SELECT binding_name FROM storage_shards WHERE shard_id=?').bind(value.destination_shard_id),
 ]);
 const sourceName=exactRow(rows[0]).binding_name,destinationName=exactRow(rows[1]).binding_name;
 if(typeof sourceName!=='string'||typeof destinationName!=='string'||sourceName===destinationName)throw fail();
 return {source:database(bindings,sourceName),destination:database(bindings,destinationName),
  sourceBindingName:sourceName,destinationBindingName:destinationName};
}
async function copyControl(destination:D1Database,value:Plan,state:'open'|'closed'){
 await destination.prepare(`INSERT INTO storage_owner_move_copy_controls(move_id,owner_id,state) VALUES(?,?,?)
  ON CONFLICT(move_id) DO UPDATE SET state='closed'
   WHERE excluded.owner_id=storage_owner_move_copy_controls.owner_id
    AND storage_owner_move_copy_controls.state='open' AND excluded.state='closed'`)
  .bind(value.move_id,value.owner_id,state).run();
 const row=await destination.prepare(`SELECT owner_id,state FROM storage_owner_move_copy_controls
  WHERE move_id=?`).bind(value.move_id).first<{owner_id:string;state:string}>();
 if(row?.owner_id!==value.owner_id||row.state!==state)throw fail();
}
async function requireCopyControl(destination:D1Database,value:Plan,state:'open'|'closed'){
 const row=await destination.prepare(`SELECT owner_id,state FROM storage_owner_move_copy_controls
  WHERE move_id=?`).bind(value.move_id).first<{owner_id:string;state:string}>();
 if(row?.owner_id!==value.owner_id||row.state!==state)throw fail();
}
async function erasedCopyControl(destination:D1Database,value:Plan):Promise<boolean>{
 return await destination.prepare(`SELECT completed FROM storage_owner_move_erasure_receipts
  WHERE move_id=? LIMIT 1`).bind(value.move_id).first<number>('completed')===1;
}
async function closeCopyControlForErasure(destination:D1Database,value:Plan):Promise<void>{
 if(await erasedCopyControl(destination,value))return;
 await copyControl(destination,value,'closed');
}
async function ownerParticipant(source:D1Database,ownerId:string,nowEpoch:number|null):Promise<{participantId:string;deviceId:string}>{
 if(nowEpoch!==null)integer(nowEpoch);const now=nowEpoch===null?null:new Date(nowEpoch).toISOString();
 const row=await source.prepare(`SELECT owner.participant_id participant_id,ledger.device_id device_id
  FROM accountless_enrollment_ledger ledger
  JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
  JOIN participants participant ON participant.id=owner.participant_id
  JOIN device_credentials credential ON credential.id=owner.device_credential_id
  JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
  WHERE ledger.installation_principal_id=? AND participant.owner_kind='accountless'
   AND participant.state='active' AND ledger.state='active' AND owner.state='active'
   AND credential.state='active' AND grant_row.state='active'
   AND credential.participant_id=participant.id AND credential.id=ledger.device_id
   AND grant_row.participant_id=participant.id AND grant_row.device_credential_id=credential.id
   AND (? IS NULL OR ledger.expires_at>?) AND credential.expires_at=ledger.expires_at
   AND owner.expires_at=ledger.expires_at AND grant_row.expires_at=ledger.expires_at
   AND credential.secret_hash=ledger.device_secret_hash
  LIMIT 2`).bind(ownerId,now,now).all<{participant_id:string;device_id:string}>();
 if(row.results.length!==1)throw fail();
 return {participantId:row.results[0]!.participant_id,deviceId:row.results[0]!.device_id};
}
async function assertSupported(source:D1Database,ownerId:string,sourceNamespace:string,nowEpoch:number){
 const owner=await ownerParticipant(source,ownerId,nowEpoch);
 const results=await source.batch([
  source.prepare(`SELECT count(*) n FROM telemetry_v1_chunks WHERE participant_id=?`).bind(owner.participantId),
  source.prepare(`SELECT count(*) n FROM telemetry_contributions WHERE participant_id=?`).bind(owner.participantId),
  source.prepare(`SELECT count(*) n FROM contributions WHERE participant_id=?`).bind(owner.participantId),
  source.prepare(`SELECT count(*) n FROM accountless_enrollment_ledger WHERE installation_principal_id=?`).bind(ownerId),
  source.prepare(`SELECT s.source_namespace FROM typed_v11_admission_state s
   JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=s.namespace_id
   WHERE s.id=1 AND s.runtime_contract_version=1 AND origin.access_mode='current-write'
    AND origin.v11_read_contract_version=2`),
  source.prepare(`SELECT count(*) n FROM typed_v11_owner_memberships membership
   JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=membership.namespace_id
   WHERE membership.participant_id=? AND origin.v11_read_contract_version=2
    AND (origin.source_namespace<>? OR origin.access_mode<>'current-write')`)
   .bind(owner.participantId,sourceNamespace),
 ]);
 const counts=results.slice(0,4).map(result=>Number(exactRow(result).n));
 if(counts.some((value,index)=>!Number.isSafeInteger(value)||(index===3?value!==1:value!==0))
  ||exactRow(results[4]).source_namespace!==sourceNamespace||Number(exactRow(results[5]).n)!==0)throw fail();
 return owner;
}
async function highWater(source:D1Database,participantId:string,sourceNamespace:string):Promise<number>{
 const value=await source.prepare(`SELECT COALESCE(max(r.source_row_id),0) maximum
  FROM typed_v11_owner_memberships membership
  JOIN typed_telemetry_owners owner ON owner.id=membership.typed_owner_id AND owner.namespace_id=membership.namespace_id
  JOIN typed_telemetry_records r INDEXED BY typed_telemetry_owner_source_cursor
    ON r.owner_id=owner.id AND r.format=11
  JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=r.namespace_id
  WHERE membership.participant_id=? AND origin.source_namespace=? AND origin.v11_read_contract_version=2`)
  .bind(participantId,sourceNamespace).first<number>('maximum');
 integer(value??0);return value??0;
}
async function authority(source:D1Database,ownerId:string,nowEpoch:number|null):Promise<AuthoritySnapshot>{
 const owner=await ownerParticipant(source,ownerId,nowEpoch);
 const queries=[
  source.prepare('SELECT * FROM accountless_enrollment_ledger WHERE installation_principal_id=?').bind(ownerId),
  source.prepare('SELECT * FROM participants WHERE id=?').bind(owner.participantId),
  source.prepare('SELECT * FROM device_credentials WHERE id=? AND participant_id=?').bind(owner.deviceId,owner.participantId),
  source.prepare('SELECT * FROM accountless_upload_owners WHERE participant_id=?').bind(owner.participantId),
  source.prepare('SELECT * FROM accountless_v11_device_authorizations WHERE participant_id=?').bind(owner.participantId),
  source.prepare('SELECT * FROM attribution_enrollments WHERE participant_id=?').bind(owner.participantId),
  source.prepare('SELECT * FROM telemetry_transport_participant_floors WHERE participant_id=?').bind(owner.participantId),
 ];
 const result=await source.batch(queries),entries=Object.keys(AUTHORITY_TABLES) as (keyof typeof AUTHORITY_TABLES)[];
 const rows=Object.fromEntries(entries.map((name,index)=>[name,exactRow(result[index])])) as Record<string,Row>;
 const participant=rows.participants!,ledger=rows.accountless_enrollment_ledger!,credential=rows.device_credentials!;
 const uploadOwner=rows.accountless_upload_owners!,grant=rows.accountless_v11_device_authorizations!,floor=rows.telemetry_transport_participant_floors!;
 const required=telemetryV11RequiredConsent();
 if(participant.id!==owner.participantId||participant.owner_kind!=='accountless'||participant.state!=='active'
  ||ledger.installation_principal_id!==ownerId||ledger.device_id!==owner.deviceId||ledger.state!=='active'
  ||ledger.schema_version!==ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION||ledger.policy_version!==ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
  ||ledger.authorization_basis!==ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
  ||!Number.isSafeInteger(ledger.renewal_generation)||Number(ledger.renewal_generation)<0
  ||(Number(ledger.renewal_generation)===0)!==(ledger.renewed_at===null)
  ||credential.id!==owner.deviceId||credential.participant_id!==owner.participantId||credential.authority_kind!=='accountless'
  ||credential.accountless_enrollment_device_id!==owner.deviceId||credential.state!=='active'
  ||uploadOwner.participant_id!==owner.participantId||uploadOwner.device_credential_id!==owner.deviceId||uploadOwner.state!=='active'
  ||uploadOwner.policy_version!==ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
  ||uploadOwner.authorization_basis!==ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS
  ||grant.participant_id!==owner.participantId||grant.device_credential_id!==owner.deviceId||grant.state!=='active'
  ||grant.telemetry_schema_version!==ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION
  ||grant.field_dictionary_version!==required.fieldDictionaryVersion||grant.privacy_contract_version!==required.privacyContractVersion
  ||floor.minimum_rank!==11||floor.revision!==0)throw fail();
 const digest=await sha256Hex(`app-usagemonitor/storage-owner-move-authority/v1\0${canonicalJson(normalized(rows))}`);
 return {participantId:owner.participantId,deviceId:owner.deviceId,digest,rows};
}
async function authorityPin(destination:D1Database,value:Plan):Promise<AuthorityPin>{
 const pin=await destination.prepare(`SELECT participant_id,device_id,authority_digest,state
  FROM storage_owner_move_authority_seeds WHERE move_id=? AND owner_id=? LIMIT 1`)
  .bind(value.move_id,value.owner_id).first<AuthorityPin>();
 if(!pin||!DIGEST.test(pin.authority_digest)||!['prepared','materialized'].includes(pin.state))throw fail();
 return pin;
}
async function pinAuthority(destination:D1Database,destinationBindingName:string,value:Plan,snapshot:AuthoritySnapshot){
 const rows=snapshot.rows,attribution=rows.attribution_enrollments!,floor=rows.telemetry_transport_participant_floors!;
 const reservation=await prepareTypedStorageAdmissionReservation(destination,
  {ownerId:value.owner_id,shardId:value.destination_shard_id,bindingName:destinationBindingName,
   generation:value.destination_generation,mode:'catalog'},{transactionBytes:16*1024,recordCount:1});
 const result=await destination.batch([reservation.statement,destination.prepare(`INSERT INTO storage_owner_move_authority_seeds(
  participant_id,device_id,move_id,owner_id,attribution_namespace,attribution_created_at,
  floor_minimum_rank,floor_revision,floor_changed_at,authority_digest,state)
  VALUES(?,?,?,?,?,?,?,?,?,?,'prepared') ON CONFLICT DO NOTHING`).bind(snapshot.participantId,snapshot.deviceId,
   value.move_id,value.owner_id,attribution.namespace,attribution.created_at,floor.minimum_rank,floor.revision,
   floor.changed_at,snapshot.digest)]);
 if(result.some(item=>!item.success))throw fail();
 await reconcileTypedStorageAdmissionReservation(destination,reservation,result[0],result.at(-1));
 const pin=await authorityPin(destination,value);
 if(pin.participant_id!==snapshot.participantId||pin.device_id!==snapshot.deviceId
  ||pin.authority_digest!==snapshot.digest||pin.state!=='prepared')throw fail();
}
async function copyAuthority(destination:D1Database,destinationBindingName:string,value:Plan,snapshot:AuthoritySnapshot){
 const {move_id:moveId,owner_id:ownerId}=value;
 const rows=snapshot.rows;
 const pin=await authorityPin(destination,value);
 if(pin.participant_id!==snapshot.participantId||pin.device_id!==snapshot.deviceId||pin.authority_digest!==snapshot.digest)throw fail();
 const statements=[insertExact(destination,'accountless_enrollment_ledger',rows.accountless_enrollment_ledger!),
  insertExact(destination,'participants',rows.participants!),insertExact(destination,'device_credentials',rows.device_credentials!),
  insertExact(destination,'accountless_upload_owners',rows.accountless_upload_owners!),
  insertExact(destination,'accountless_v11_device_authorizations',rows.accountless_v11_device_authorizations!),
  destination.prepare(`UPDATE storage_owner_move_authority_seeds SET state='materialized'
    WHERE participant_id=? AND move_id=? AND owner_id=? AND authority_digest=? AND state='prepared'`)
   .bind(snapshot.participantId,moveId,ownerId,snapshot.digest),
 ];
 const reservation=await prepareTypedStorageAdmissionReservation(destination,
  {ownerId,shardId:value.destination_shard_id,bindingName:destinationBindingName,generation:value.destination_generation,mode:'catalog'},
  {transactionBytes:64*1024,recordCount:1});
 const result=await destination.batch([reservation.statement,...statements]);
 if(result.some(value=>!value.success))throw fail();
 await reconcileTypedStorageAdmissionReservation(destination,reservation,result[0],result.at(-1));
 const receipt=await destination.prepare(`SELECT state,authority_digest FROM storage_owner_move_authority_seeds
  WHERE participant_id=? AND move_id=? AND owner_id=?`).bind(snapshot.participantId,moveId,ownerId)
  .first<{state:string;authority_digest:string}>();
 if(receipt?.state!=='materialized'||receipt.authority_digest!==snapshot.digest)throw fail();
 const actual=await authority(destination,ownerId,null);if(actual.digest!==snapshot.digest)throw fail();
}

async function assertDestinationMoveSchema(destination:D1Database):Promise<void>{
 const results=await destination.batch([
  destination.prepare('SELECT version FROM storage_owner_move_authority_contract WHERE id=1'),
  destination.prepare('SELECT version FROM storage_owner_move_copy_contract WHERE id=1'),
  destination.prepare('SELECT version FROM storage_owner_move_cursor_contract WHERE id=1'),
  destination.prepare('SELECT version FROM storage_owner_move_history_contract WHERE id=1'),
 ]);
 if(results.some(result=>Number(exactRow(result).version)!==1))throw fail();
}
async function fenceAccountlessSource(source:D1Database,value:Plan,nowEpoch:number):Promise<boolean>{
 integer(nowEpoch);const now=new Date(nowEpoch).toISOString(),required=telemetryV11RequiredConsent();
 await source.prepare(`UPDATE storage_owner_fences SET state='fenced',move_id=?
  WHERE owner_id=? AND shard_id=? AND route_generation=? AND state='active' AND move_id IS NULL
   AND EXISTS(SELECT 1 FROM accountless_enrollment_ledger ledger
    JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
    JOIN participants participant ON participant.id=owner.participant_id
    JOIN device_credentials credential ON credential.id=owner.device_credential_id
    JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
    JOIN attribution_enrollments attribution ON attribution.participant_id=participant.id
    JOIN telemetry_transport_participant_floors floor ON floor.participant_id=participant.id
    WHERE ledger.installation_principal_id=storage_owner_fences.owner_id
     AND participant.owner_kind='accountless' AND participant.state='active'
     AND ledger.state='active' AND owner.state='active' AND credential.state='active' AND grant_row.state='active'
     AND credential.participant_id=participant.id AND credential.id=ledger.device_id
     AND grant_row.participant_id=participant.id AND grant_row.device_credential_id=credential.id
     AND ledger.expires_at>? AND credential.expires_at=ledger.expires_at
     AND owner.expires_at=ledger.expires_at AND grant_row.expires_at=ledger.expires_at
     AND credential.secret_hash=ledger.device_secret_hash
     AND ledger.schema_version=? AND ledger.policy_version=? AND ledger.authorization_basis=?
     AND owner.policy_version=? AND owner.authorization_basis=?
     AND grant_row.telemetry_schema_version=? AND grant_row.field_dictionary_version=?
     AND grant_row.privacy_contract_version=? AND floor.minimum_rank=11 AND floor.revision=0
     AND (SELECT count(*) FROM accountless_enrollment_ledger exact_ledger
       WHERE exact_ledger.installation_principal_id=storage_owner_fences.owner_id)=1
     AND NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks v1 WHERE v1.participant_id=participant.id)
     AND NOT EXISTS(SELECT 1 FROM telemetry_contributions legacy WHERE legacy.participant_id=participant.id)
     AND NOT EXISTS(SELECT 1 FROM contributions legacy_owner WHERE legacy_owner.participant_id=participant.id)
     AND EXISTS(SELECT 1 FROM typed_v11_admission_state admission
       JOIN typed_telemetry_origin_contracts current_origin ON current_origin.namespace_id=admission.namespace_id
       WHERE admission.id=1 AND admission.runtime_contract_version=1
        AND current_origin.source_namespace=? AND current_origin.access_mode='current-write'
        AND current_origin.v11_read_contract_version=2)
     AND NOT EXISTS(SELECT 1 FROM typed_v11_owner_memberships membership
       JOIN typed_telemetry_origin_contracts retained_origin ON retained_origin.namespace_id=membership.namespace_id
       WHERE membership.participant_id=participant.id
        AND (retained_origin.source_namespace<>? OR retained_origin.access_mode<>'current-write'
          OR retained_origin.v11_read_contract_version<>2)))
 `).bind(value.move_id,value.owner_id,value.source_shard_id,value.source_generation,now,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  required.fieldDictionaryVersion,required.privacyContractVersion,value.source_namespace,value.source_namespace).run();
 const fence=await source.prepare(`SELECT shard_id,route_generation,state,move_id FROM storage_owner_fences
  WHERE owner_id=? LIMIT 1`).bind(value.owner_id)
  .first<{shard_id:string;route_generation:number;state:string;move_id:string|null}>();
 if(fence?.shard_id!==value.source_shard_id||fence.route_generation!==value.source_generation)throw fail();
 return fence.state==='fenced'&&fence.move_id===value.move_id;
}
function stagedStatement(destination:D1Database,moveId:string,ownerId:string,row:TypedTelemetryStoredRecord,digest:string){
 return destination.prepare(`INSERT INTO storage_owner_move_staged_records(
  move_id,owner_id,participant_id,source_namespace,source_row_id,device_id,chunk_row_id,manifest_id,
  chunk_day,observed_day,canonical_record,record_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(move_id,source_namespace,source_row_id) DO NOTHING`)
  .bind(moveId,ownerId,row.participantId,row.sourceNamespace,row.sourceRowId,row.deviceId,row.chunkRowId,row.manifestId,
   row.chunkDay,row.observedDay,row.canonicalRecord,digest);
}
async function stage(destination:D1Database,destinationBindingName:string,value:Plan,records:TypedTelemetryStoredRecord[]){
 if(!records.length)return;
 const digests=await Promise.all(records.map(row=>sha256Hex(row.canonicalRecord)));
 const bytes=records.reduce((total,row)=>total+new TextEncoder().encode(row.canonicalRecord).byteLength+1024,0);
 if(bytes>MAX_TYPED_TELEMETRY_BATCH_BYTES)throw fail();
 const reservation=await prepareTypedStorageAdmissionReservation(destination,
  {ownerId:value.owner_id,shardId:value.destination_shard_id,bindingName:destinationBindingName,generation:value.destination_generation,mode:'catalog'},
  {transactionBytes:bytes,recordCount:records.length});
 const result=await destination.batch([reservation.statement,...records.map((row,index)=>stagedStatement(destination,value.move_id,value.owner_id,row,digests[index]!))]);
 if(result.some(item=>!item.success))throw fail();
 await reconcileTypedStorageAdmissionReservation(destination,reservation,result[0],result.at(-1));
 const checks=await destination.batch(records.map((row,index)=>destination.prepare(`SELECT record_digest,canonical_record,participant_id,
   device_id,chunk_row_id,manifest_id,chunk_day,observed_day FROM storage_owner_move_staged_records
   WHERE move_id=? AND source_namespace=? AND source_row_id=?`).bind(value.move_id,row.sourceNamespace,row.sourceRowId)));
 for(const [index,result] of checks.entries()){
  const actual=exactRow(result),expected=records[index]!;
  if(actual.record_digest!==digests[index]||actual.canonical_record!==expected.canonicalRecord
   ||actual.participant_id!==expected.participantId||actual.device_id!==expected.deviceId
   ||actual.chunk_row_id!==expected.chunkRowId||actual.manifest_id!==expected.manifestId
   ||actual.chunk_day!==expected.chunkDay||actual.observed_day!==expected.observedDay)throw fail();
 }
}

/** Root-only movement coordinator. The pre-copy is readable only through this
 * module; HTTP keeps using the active route until the final source fence. */
export function createAccountlessV11OwnerMovement(options:{catalog:D1Database;bindings:StorageShardBindings;clock:()=>number}){
 const {catalog,bindings,clock}=options;
 const mover=createOwnerMoveCoordinator({catalog,bindings,clock,verifyDestinationCopy:async({move})=>{
  const value=await plan(catalog,move.move_id);
  if(value.state!=='verified'||value.copy_digest!==move.copy_digest&&move.copy_digest!==null)throw fail();
  if(!value.copy_digest||!DIGEST.test(value.copy_digest))throw fail();return value.copy_digest;
 }});
 async function copyPage(moveId:string,limit=OWNER_MOVE_COPY_PAGE){
  integer(limit,1);if(limit>OWNER_MOVE_COPY_PAGE)throw fail();const value=await plan(catalog,moveId);
  if(!['copying','ready','finalizing'].includes(value.state))throw fail();
  if(value.state==='ready')return {state:value.state,copied:0};
  const {source,destination,destinationBindingName}=await endpoints(catalog,bindings,value);
  await requireCopyControl(destination,value,'open');
  if(value.state==='finalizing')await source.prepare(`SELECT 1 FROM storage_owner_fences WHERE owner_id=? AND shard_id=?
    AND route_generation=? AND state='fenced' AND move_id=?`).bind(value.owner_id,value.source_shard_id,
     value.source_generation,moveId).first().then(row=>{if(!row)throw fail();});
  const owner=value.state==='finalizing'
   ?{participantId:(await authorityPin(destination,value)).participant_id}
   :await ownerParticipant(source,value.owner_id,clock());
  const upper=value.state==='copying'?value.precopy_high_water:value.final_high_water!;
  const page=await readTypedTelemetryPage(source,{sourceNamespace:value.source_namespace,format:'v11',
   participantId:owner.participantId,afterSourceRowId:value.precopy_after_source_row_id,limit});
  const records=page.records.filter(row=>row.sourceRowId<=upper);
  await stage(destination,destinationBindingName,value,records);
  const through=records.at(-1)?.sourceRowId??value.precopy_after_source_row_id;
  const exhausted=through>=upper||records.length===0||page.records.some(row=>row.sourceRowId>upper);
  const nextState=value.state==='copying'&&exhausted?'ready':value.state;
  await catalog.prepare(`UPDATE storage_owner_move_preparations SET precopy_after_source_row_id=?,state=?,
   materialized_after_source_row_id=CASE WHEN state='finalizing' AND ? THEN ? ELSE materialized_after_source_row_id END,
   updated_at=? WHERE move_id=? AND state=? AND precopy_after_source_row_id=?`)
   .bind(through,nextState,exhausted?1:0,upper,clock(),moveId,value.state,value.precopy_after_source_row_id).run();
  const current=await plan(catalog,moveId);
  if(current.precopy_after_source_row_id!==through||current.state!==nextState)throw fail();
  return {state:current.state,copied:records.length};
 }
 async function assertSourceFence(value:Plan):Promise<void>{
  const {source}=await endpoints(catalog,bindings,value);
  const row=await source.prepare(`SELECT 1 FROM storage_owner_fences WHERE owner_id=? AND shard_id=?
    AND route_generation=? AND state='fenced' AND move_id=?`).bind(value.owner_id,value.source_shard_id,
     value.source_generation,value.move_id).first();
  if(!row)throw fail();
 }
 async function rollbackPage(moveId:string,limit=OWNER_MOVE_COPY_PAGE){
  integer(limit,1);if(limit>OWNER_MOVE_COPY_PAGE)throw fail();let value=await plan(catalog,moveId);
  if(value.state==='abandoned')return {state:value.state,deleted:0};
  if(value.state==='copying'||value.state==='ready'){
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='abandoning',updated_at=?
    WHERE move_id=? AND state=?`).bind(clock(),moveId,value.state).run();
   value=await plan(catalog,moveId);
  }
  if(value.state!=='abandoning')throw fail();
  const {destination}=await endpoints(catalog,bindings,value);
  await copyControl(destination,value,'closed');
  const before=await destination.prepare(`SELECT count(*) n FROM storage_owner_move_staged_records
   WHERE move_id=? AND owner_id=?`).bind(moveId,value.owner_id).first<number>('n');
  integer(before??-1);
  await destination.prepare(`DELETE FROM storage_owner_move_staged_records WHERE rowid IN (
   SELECT rowid FROM storage_owner_move_staged_records WHERE move_id=? AND owner_id=? ORDER BY rowid LIMIT ?
  )`).bind(moveId,value.owner_id,limit).run();
  const remaining=await destination.prepare(`SELECT count(*) n FROM storage_owner_move_staged_records
   WHERE move_id=? AND owner_id=?`).bind(moveId,value.owner_id).first<number>('n');
  integer(remaining??-1);
  const deleted=before!-remaining!;
  if(deleted<0||deleted>limit)throw fail();
  if(remaining===0){
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='abandoned',updated_at=?
    WHERE move_id=? AND state='abandoning'`).bind(clock(),moveId).run();
  }
  const result=await plan(catalog,moveId);
  if(result.state!==(remaining===0?'abandoned':'abandoning'))throw fail();
  return {state:result.state,deleted};
 }
 const api={
  async prepare(moveId:string,route:OwnerStorageRoute,destinationShardId:string,sourceNamespace:string){
   id(moveId);id(route.ownerId);id(destinationShardId);if(route.mode!=='catalog'||route.shardId===destinationShardId)throw fail();
   const source=database(bindings,(await catalog.prepare('SELECT binding_name FROM storage_shards WHERE shard_id=?')
    .bind(route.shardId).first<string>('binding_name'))??'');
   const destinationName=await catalog.prepare('SELECT binding_name FROM storage_shards WHERE shard_id=?')
    .bind(destinationShardId).first<string>('binding_name');
   const destination=database(bindings,destinationName??'');
    const targetNamespace=await destination.prepare(`SELECT state.source_namespace FROM typed_v11_admission_state state
    JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=state.namespace_id
    WHERE state.id=1 AND state.runtime_contract_version=1 AND origin.access_mode='current-write'
     AND origin.v11_read_contract_version=2`).first<string>('source_namespace');
    if(!targetNamespace||targetNamespace===sourceNamespace)throw fail();
    await assertDestinationMoveSchema(destination);
   const owner=await assertSupported(source,route.ownerId,sourceNamespace,clock());
   const maximum=await highWater(source,owner.participantId,sourceNamespace);
   await catalog.prepare(`INSERT INTO storage_owner_move_preparations(move_id,owner_id,source_shard_id,
    destination_shard_id,source_generation,destination_generation,reservation_bytes,source_namespace,state,
    precopy_high_water,updated_at) SELECT ?,?,?,?,?,?,reservation_bytes,?,'copying',?,?
    FROM storage_owner_routes WHERE owner_id=? AND shard_id=? AND route_generation=? AND state='active'
    ON CONFLICT(move_id) DO NOTHING`).bind(moveId,route.ownerId,route.shardId,destinationShardId,route.generation,
     route.generation+1,sourceNamespace,maximum,clock(),route.ownerId,route.shardId,route.generation).run();
   const value=await plan(catalog,moveId);
   if(value.owner_id!==route.ownerId||value.source_shard_id!==route.shardId||value.destination_shard_id!==destinationShardId
    ||value.source_generation!==route.generation||value.source_namespace!==sourceNamespace)throw fail();
   await copyControl(destination,value,'open');
   return value;
  },
  copyPage,
  rollbackPage,
  async abortBeforeCopy(moveId:string){
   const result=await rollbackPage(moveId,OWNER_MOVE_COPY_PAGE);
   if(result.state!=='abandoned')throw fail();return plan(catalog,moveId);
  },
  async fenceSource(moveId:string){
    let value=await plan(catalog,moveId);
    if(value.state==='finalizing'){await assertSourceFence(value);await authorityPin((await endpoints(catalog,bindings,value)).destination,value);return value;}
   if(value.state==='ready'){
    const {source}=await endpoints(catalog,bindings,value);
    await assertSupported(source,value.owner_id,value.source_namespace,clock());
    await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='fencing',updated_at=?
     WHERE move_id=? AND state='ready'`).bind(clock(),moveId).run();
    value=await plan(catalog,moveId);
   }
   if(value.state!=='fencing')throw fail();const {source,destination,destinationBindingName}=await endpoints(catalog,bindings,value);
   await requireCopyControl(destination,value,'open');
   const sourceFence=await source.prepare(`SELECT shard_id,route_generation,state,move_id FROM storage_owner_fences
    WHERE owner_id=? LIMIT 1`).bind(value.owner_id).first<{shard_id:string;route_generation:number;state:string;move_id:string|null}>();
   const alreadyFenced=sourceFence?.shard_id===value.source_shard_id&&sourceFence.route_generation===value.source_generation
    &&sourceFence.state==='fenced'&&sourceFence.move_id===moveId;
   const stillActive=sourceFence?.shard_id===value.source_shard_id&&sourceFence.route_generation===value.source_generation
    &&sourceFence.state==='active'&&sourceFence.move_id===null;
   if(!alreadyFenced&&!stillActive)throw fail();
   const route:OwnerStorageRoute={ownerId:value.owner_id,shardId:value.source_shard_id,
    bindingName:(await catalog.prepare('SELECT binding_name FROM storage_shards WHERE shard_id=?').bind(value.source_shard_id).first<string>('binding_name'))!,
    generation:value.source_generation,mode:'catalog'};
   if(stillActive){
    const fenced=await fenceAccountlessSource(source,value,clock());
    if(!fenced){
     await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='ready',updated_at=?
      WHERE move_id=? AND state='fencing'`).bind(clock(),moveId).run();
     throw fail();
    }
   }
   await mover.begin(moveId,route,value.destination_shard_id);await mover.fenceSource(moveId);
   const snapshot=await authority(source,value.owner_id,null);
    await pinAuthority(destination,destinationBindingName,value,snapshot);
   // Only the high-water observed after the source-local fence is authoritative.
   // A concurrent last write before the fence must be included in catch-up.
    const finalHigh=await highWater(source,snapshot.participantId,value.source_namespace);
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='finalizing',final_high_water=?,updated_at=?
    WHERE move_id=? AND state='fencing'`).bind(finalHigh,clock(),moveId).run();
   const result=await plan(catalog,moveId);if(result.state!=='finalizing'||result.final_high_water!==finalHigh)throw fail();return result;
  },
  async materializeAuthority(moveId:string){
   const value=await plan(catalog,moveId);if(value.state!=='finalizing'||value.final_high_water===null
    ||value.materialized_after_source_row_id!==value.final_high_water)throw fail();
   const {source,destination,destinationBindingName}=await endpoints(catalog,bindings,value);
   await assertSourceFence(value);
    const nowEpoch=clock();const pin=await authorityPin(destination,value);
    const snapshot=await authority(source,value.owner_id,null);
    if(snapshot.participantId!==pin.participant_id||snapshot.deviceId!==pin.device_id||snapshot.digest!==pin.authority_digest)throw fail();
    await copyAuthority(destination,destinationBindingName,value,snapshot);
    await initializeOwnerMoveHistoryImport({destination,moveId,ownerId:value.owner_id,
     participantId:snapshot.participantId,sourceNamespace:value.source_namespace,nowEpoch,
     destinationRoute:destinationRoute(value,destinationBindingName)});
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET authority_digest=?,updated_at=?
    WHERE move_id=? AND state='finalizing' AND authority_digest IS NULL`).bind(snapshot.digest,clock(),moveId).run();
   const counts=await source.batch([
    source.prepare('SELECT count(*) n FROM telemetry_v11_day_manifests WHERE participant_id=?').bind(snapshot.participantId),
    source.prepare('SELECT count(*) n FROM telemetry_v11_domains WHERE participant_id=?').bind(snapshot.participantId),
   ]);
   if(counts.every(item=>Number(exactRow(item).n)===0)){
     await advanceOwnerMoveHistoryImport({source,destination,moveId,nowEpoch,
      destinationRoute:destinationRoute(value,destinationBindingName)});
     await advanceOwnerMoveHistoryImport({source,destination,moveId,nowEpoch,
      destinationRoute:destinationRoute(value,destinationBindingName)});
   }
   const result=await plan(catalog,moveId);if(result.authority_digest!==snapshot.digest)throw fail();return result;
  },
  async materializeHistoryPage(moveId:string){
   const value=await plan(catalog,moveId);if(value.state!=='finalizing'||!value.authority_digest)throw fail();
    await assertSourceFence(value);const {source,destination,destinationBindingName}=await endpoints(catalog,bindings,value);
    return advanceOwnerMoveHistoryImport({source,destination,moveId,nowEpoch:clock(),
     destinationRoute:destinationRoute(value,destinationBindingName)});
  },
  async verifyPage(moveId:string,limit=OWNER_MOVE_COPY_PAGE){
   integer(limit,1);if(limit>OWNER_MOVE_COPY_PAGE)throw fail();const value=await plan(catalog,moveId);
   if(value.state==='verified')return {state:value.state,verified:0};
   if(value.state!=='finalizing'||value.final_high_water===null||!value.authority_digest)throw fail();
   const finalHighWater=value.final_high_water;
   const {source,destination}=await endpoints(catalog,bindings,value);
   await assertSourceFence(value);
   const historyDigest=await requireOwnerMoveHistoryComplete(destination,moveId);
    const pin=await authorityPin(destination,value);
    const page=await readTypedTelemetryPage(source,{sourceNamespace:value.source_namespace,format:'v11',participantId:pin.participant_id,
    afterSourceRowId:value.verify_after_source_row_id,limit});
   const records=page.records.filter(row=>row.sourceRowId<=finalHighWater);
   const staged=records.length?await destination.batch<Row>(records.map(row=>destination.prepare(`SELECT * FROM storage_owner_move_staged_records
    WHERE move_id=? AND source_namespace=? AND source_row_id=?`).bind(moveId,row.sourceNamespace,row.sourceRowId))):[];
   let chain=value.verify_chain_digest??'0'.repeat(64);
   for(const [index,row] of records.entries()){
    const expected={move_id:moveId,owner_id:value.owner_id,participant_id:row.participantId,source_namespace:row.sourceNamespace,
     source_row_id:row.sourceRowId,device_id:row.deviceId,chunk_row_id:row.chunkRowId,manifest_id:row.manifestId,
     chunk_day:row.chunkDay,observed_day:row.observedDay,canonical_record:row.canonicalRecord,
     record_digest:await sha256Hex(row.canonicalRecord)};
    if(canonicalJson(normalized(exactRow(staged[index])))!==canonicalJson(normalized(expected)))throw fail();
    chain=await sha256Hex(`app-usagemonitor/storage-owner-move-chain/v1\0${chain}\0${canonicalJson(expected)}`);
   }
   const through=records.at(-1)?.sourceRowId??value.verify_after_source_row_id;
   const done=through>=finalHighWater||records.length===0||page.records.some(row=>row.sourceRowId>finalHighWater);
   const copyDigest=done?await sha256Hex(`app-usagemonitor/storage-owner-move-copy/v1\0${canonicalJson({moveId,
    ownerId:value.owner_id,sourceNamespace:value.source_namespace,finalHighWater,
    telemetryChainDigest:chain,authorityDigest:value.authority_digest,historyDigest})}`):null;
   if(done)await copyControl(destination,value,'closed');
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET verify_after_source_row_id=?,verify_chain_digest=?,
    state=CASE WHEN ? THEN 'verified' ELSE state END,copy_digest=CASE WHEN ? THEN ? ELSE copy_digest END,updated_at=?
    WHERE move_id=? AND state='finalizing' AND verify_after_source_row_id=?`)
    .bind(through,chain,done?1:0,done?1:0,copyDigest,clock(),moveId,value.verify_after_source_row_id).run();
   const result=await plan(catalog,moveId);if(result.verify_after_source_row_id!==through||result.verify_chain_digest!==chain)throw fail();
   return {state:result.state,verified:records.length};
  },
  async commit(moveId:string){
   const value=await plan(catalog,moveId);if(value.state==='committed')return mover.activateDestination(moveId);
   if(value.state!=='verified'||!value.copy_digest)throw fail();
   await mover.verifyCopied(moveId);await mover.commit(moveId);const route=await mover.activateDestination(moveId);
   await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='committed',updated_at=?
    WHERE move_id=? AND state='verified' AND copy_digest=?`).bind(clock(),moveId,value.copy_digest).run();
   const result=await plan(catalog,moveId);if(result.state!=='committed')throw fail();return route;
  },
 };
 return Object.assign(api,{
  /** One bounded recovery step for a move which already owns the source fence.
   * Schedulers may repeat this after timeout or response loss; every branch
   * reconciles its retained journal before issuing the next mutation. */
  async resumeFinalization(moveId:string){
   const value=await plan(catalog,moveId);
   if(value.state==='fencing')return api.fenceSource(moveId);
   if(value.state==='verified'||value.state==='committed')return api.commit(moveId);
   if(value.state!=='finalizing'||value.final_high_water===null)throw fail();
   if(value.materialized_after_source_row_id!==value.final_high_water)return api.copyPage(moveId);
   if(!value.authority_digest)return api.materializeAuthority(moveId);
   const {destination}=await endpoints(catalog,bindings,value);
   const history=await destination.prepare('SELECT state FROM storage_owner_move_history_imports WHERE move_id=?')
    .bind(moveId).first<string>('state');
   if(history!=='complete')return api.materializeHistoryPage(moveId);
   return api.verifyPage(moveId);
  },
 });
}

export interface AccountlessOwnerMoveErasurePreparation {
 readonly moveId:string;readonly ownerId:string;readonly participantId:string;
}

/** Remove bounded, terminal move-local raw owner locators after this exact
 * participant has been erased from an enumerated current or retained target. */
export async function eraseAccountlessOwnerMoveControls(options:{
 database:D1Database;ownerId:string;participantId:string;
}):Promise<void>{
 const {database:target,ownerId,participantId}=options;id(ownerId);id(participantId);
 const controls=(await target.prepare(`SELECT move_id,state FROM storage_owner_move_copy_controls
  WHERE owner_id=? ORDER BY move_id LIMIT 66`).bind(ownerId).all<{move_id:string;state:string}>()).results;
 if(controls.length>65||controls.some(control=>control.state!=='closed'))throw fail();
 for(const control of controls){
  await target.prepare(`INSERT INTO storage_owner_move_erasure_controls(move_id,owner_id,participant_id)
   VALUES(?,?,?)`).bind(control.move_id,ownerId,participantId).run();
 }
 const retained=await target.prepare('SELECT count(*) n FROM storage_owner_move_copy_controls WHERE owner_id=?')
  .bind(ownerId).first<number>('n');
 if(retained!==0)throw fail();
}

/** Serialize owner erasure with an unfinished pre-copy. The catalog transition
 * wins against the final-fence transition; the destination-local gate then
 * prevents a copy attempt that loaded stale catalog state from writing after
 * erasure has begun. */
export async function prepareAccountlessOwnerMoveErasure(options:{
 catalog:D1Database;bindings:StorageShardBindings;route:OwnerStorageRoute;participantId:string;clock?:()=>number;
}):Promise<AccountlessOwnerMoveErasurePreparation|null>{
 const {catalog,bindings,route,participantId}=options;
 if(route.mode==='single')return null;
 id(route.ownerId);id(participantId);integer(route.generation,1);
 const rows=(await catalog.prepare(`SELECT * FROM storage_owner_move_preparations
  WHERE owner_id=? AND state NOT IN('committed','abandoned') ORDER BY move_id LIMIT 2`)
  .bind(route.ownerId).all<Plan>()).results;
 if(rows.length===0)return null;if(rows.length!==1)throw fail();let value=rows[0]!;
 if(value.owner_id!==route.ownerId||value.source_shard_id!==route.shardId
  ||value.source_generation!==route.generation)throw fail();
 if(value.state==='copying'||value.state==='ready'){
  await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='abandoning',updated_at=?
   WHERE move_id=? AND owner_id=? AND state=?`).bind((options.clock??Date.now)(),value.move_id,
    value.owner_id,value.state).run();
  value=await plan(catalog,value.move_id);
 }
 if(value.state!=='abandoning')throw fail();
 const {destination}=await endpoints(catalog,bindings,value);
 await closeCopyControlForErasure(destination,value);
 return Object.freeze({moveId:value.move_id,ownerId:value.owner_id,participantId});
}

/** Release the catalog reservation only after exact destination cleanup is
 * visible. Lost catalog acknowledgements converge by rereading the retained
 * preparation; the source route remains active throughout rollback. */
export async function completeAccountlessOwnerMoveErasure(options:{
 catalog:D1Database;bindings:StorageShardBindings;preparation:AccountlessOwnerMoveErasurePreparation;clock?:()=>number;
}):Promise<void>{
 const {catalog,bindings,preparation}=options;let value=await plan(catalog,preparation.moveId);
 if(value.owner_id!==preparation.ownerId)throw fail();if(value.state==='abandoned')return;
 if(value.state!=='abandoning')throw fail();const {destination}=await endpoints(catalog,bindings,value);
 const alreadyErased=await erasedCopyControl(destination,value);
 if(!alreadyErased)await requireCopyControl(destination,value,'closed');
 const results=await destination.batch([
  destination.prepare(`SELECT count(*) n FROM storage_owner_move_staged_records
   WHERE move_id=? AND owner_id=?`).bind(value.move_id,value.owner_id),
  destination.prepare(`SELECT count(*) n FROM storage_owner_move_authority_seeds
   WHERE move_id=? AND owner_id=?`).bind(value.move_id,value.owner_id),
  destination.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(preparation.participantId),
 ]);
 if(results.some(result=>Number(exactRow(result).n)!==0))throw fail();
 if(!alreadyErased)await destination.prepare(`INSERT INTO storage_owner_move_erasure_controls(move_id,owner_id,participant_id)
  VALUES(?,?,?)`).bind(value.move_id,value.owner_id,preparation.participantId).run();
 const retained=await destination.batch([
  destination.prepare('SELECT count(*) n FROM storage_owner_move_copy_controls WHERE move_id=?').bind(value.move_id),
  destination.prepare('SELECT count(*) n FROM storage_owner_move_erasure_controls WHERE move_id=?').bind(value.move_id),
 ]);
 if(retained.some(result=>Number(exactRow(result).n)!==0))throw fail();
 await catalog.prepare(`UPDATE storage_owner_move_preparations SET state='abandoned',updated_at=?
  WHERE move_id=? AND owner_id=? AND state='abandoning'`).bind((options.clock??Date.now)(),value.move_id,value.owner_id).run();
 value=await plan(catalog,value.move_id);if(value.state!=='abandoned')throw fail();
}
