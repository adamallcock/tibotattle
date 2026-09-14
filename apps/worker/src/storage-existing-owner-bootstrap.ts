import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { ApiError } from './errors';
import { participantDeletionDigest } from './participant-deletion-digest';
import { participantStorageLocatorDigest } from './storage-routing-runtime';
import { createCatalogStorageRouter, finalizeAccountlessIssuanceBaseline,
 historicalAccountlessIssuanceRosterDigest, importHistoricalAccountlessIssuanceReservation,
 type HistoricalAccountlessIssuanceReservation } from './storage-routing';

export const EXISTING_ACCOUNTLESS_BOOTSTRAP_SCHEMA_VERSION='storage-existing-accountless-bootstrap-v1';
export const MAX_EXISTING_ACCOUNTLESS_SOURCE_PAGE=100;
export const MAX_EXISTING_ACCOUNTLESS_IMPORT_PAGE=32;
const DIGEST=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BINDING=/^[A-Z][A-Z0-9_]{0,63}$/;
const PARTICIPANT=/^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUIRED_SOURCE_TABLES=['accountless_enrollment_issuance','accountless_enrollment_ledger',
 'accountless_upload_owners','accountless_v11_device_authorizations','contributions','device_credentials','participants',
 'storage_owner_fences','storage_route_write_checks','storage_source_state','storage_v11_owner_links',
 'telemetry_contributions','telemetry_v1_chunks','telemetry_v11_chunks'];

export interface ExistingAccountlessOwnerManifestRow extends HistoricalAccountlessIssuanceReservation {
 readonly participantLocatorDigest:string|null;
 readonly deletionLocatorDigest:string|null;
 readonly localOwnerDigest:string|null;
 readonly localOwnerState:'active'|'withdrawn'|'erased'|null;
 readonly ownershipState:'enrollment-only'|'owned';
}
export interface ExistingAccountlessBootstrapManifest {
 readonly schemaVersion:typeof EXISTING_ACCOUNTLESS_BOOTSTRAP_SCHEMA_VERSION;
 readonly manifestDigest:string;
 readonly sourceId:string;
 readonly sourceSchemaDigest:string;
 readonly sourceClosureDigest:string;
 readonly shardId:string;
 readonly bindingName:string;
 readonly routeGeneration:1;
 readonly routeReservationBytes:number;
 readonly owners:readonly ExistingAccountlessOwnerManifestRow[];
 readonly ownerRosterDigest:string;
 readonly historicalReservationRosterDigest:string;
 readonly baseline:{readonly budgetDay:string;readonly dailyReserved:number;readonly lifetimeReserved:number;
  readonly baselineDigest:string;readonly initializedAt:number};
}
export interface ExistingAccountlessBootstrapPolicy {
 readonly sourceId:string;readonly sourceClosureDigest:string;readonly shardId:string;readonly bindingName:string;
 readonly routeReservationBytes:number;readonly assertSourceClosed:()=>Promise<string>;
}
interface SourceState {source_id:string}
interface IssuanceRow {budget_day:string;daily_issued:number;lifetime_issued:number;last_issue_token:string;updated_at:string}
interface RawOwnerRow {
 owner_id:string;reservation_key:string;device_id:string;issued_at:string;
 ledger_state:string;participant_id:string|null;participant_owner_kind:string|null;participant_state:string|null;
 owner_participant_id:string|null;owner_device_credential_id:string|null;owner_state:string|null;
 grant_participant_id:string|null;grant_device_credential_id:string|null;grant_state:string|null;
 credential_participant_id:string|null;credential_authority_kind:string|null;credential_enrollment_device_id:string|null;
 credential_secret_hash:string|null;credential_state:string|null;owner_count:number;grant_count:number;credential_count:number;
 local_owner_digest:string|null;local_owner_state:string|null;local_owner_count:number;has_data:number;
}
interface BootstrapProgress {manifest_digest:string;state:'importing'|'ready';after_owner_id:string;
 imported_count:number;revision:number;updated_at:number}

function unavailable():never{throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');}
function integer(value:number,min=0,max=Number.MAX_SAFE_INTEGER-1){if(!Number.isSafeInteger(value)||value<min||value>max)unavailable();}
function digest(value:string){if(typeof value!=='string'||!DIGEST.test(value))unavailable();}
function id(value:string){if(typeof value!=='string'||!ID.test(value))unavailable();}
function bindingName(value:string){if(typeof value!=='string'||!BINDING.test(value))unavailable();}
function same(a:unknown,b:unknown){return canonicalJson(a)===canonicalJson(b);}
async function closure(policy:ExistingAccountlessBootstrapPolicy){
 let receipt:string;try{receipt=await policy.assertSourceClosed();}catch{unavailable();}digest(receipt);
 if(receipt!==policy.sourceClosureDigest)unavailable();
}
async function sourceSchemaDigest(source:D1Database):Promise<string>{
 const rows=(await source.prepare(`SELECT type,name,sql FROM sqlite_master WHERE type='table'
  AND name IN (${REQUIRED_SOURCE_TABLES.map(()=>'?').join(',')}) ORDER BY name LIMIT ?`)
  .bind(...REQUIRED_SOURCE_TABLES,REQUIRED_SOURCE_TABLES.length+1).all<{type:string;name:string;sql:string}>()).results;
 if(rows.length!==REQUIRED_SOURCE_TABLES.length||rows.some((row,index)=>row.name!==[...REQUIRED_SOURCE_TABLES].sort()[index]||!row.sql))unavailable();
 return sha256Hex(`app-usagemonitor/storage-existing-accountless-source-schema/v1\0${canonicalJson(rows)}`);
}
async function sourceHeader(source:D1Database,expectedSourceId:string){
 const results=await source.batch([
  source.prepare('SELECT source_id FROM storage_source_state WHERE singleton=1'),
  source.prepare(`SELECT budget_day,daily_issued,lifetime_issued,last_issue_token,updated_at
   FROM accountless_enrollment_issuance WHERE singleton=1`),
 ]);
 const state=results[0]?.results[0] as SourceState|undefined,issuance=results[1]?.results[0] as IssuanceRow|undefined;
 if(state?.source_id!==expectedSourceId||!issuance||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(issuance.budget_day)
  ||!Number.isSafeInteger(issuance.daily_issued)||issuance.daily_issued<0||issuance.daily_issued>1000
  ||!Number.isSafeInteger(issuance.lifetime_issued)||issuance.lifetime_issued<issuance.daily_issued||issuance.lifetime_issued>10000
  ||typeof issuance.last_issue_token!=='string'||!Number.isFinite(Date.parse(issuance.updated_at))
  ||new Date(Date.parse(issuance.updated_at)).toISOString()!==issuance.updated_at
  ||issuance.lifetime_issued===0&&issuance.last_issue_token!==''
  ||issuance.lifetime_issued>0&&!ID.test(issuance.last_issue_token))unavailable();
 return {state,issuance,schemaDigest:await sourceSchemaDigest(source)};
}
const OWNER_SELECT=`SELECT ledger.installation_principal_id AS owner_id,lower(hex(ledger.device_secret_hash)) AS reservation_key,
 ledger.device_id,ledger.issued_at,ledger.state AS ledger_state,participant.id AS participant_id,
 participant.owner_kind AS participant_owner_kind,participant.state AS participant_state,
 owner.participant_id AS owner_participant_id,owner.device_credential_id AS owner_device_credential_id,owner.state AS owner_state,
 grant_row.participant_id AS grant_participant_id,grant_row.device_credential_id AS grant_device_credential_id,grant_row.state AS grant_state,
 credential.participant_id AS credential_participant_id,credential.authority_kind AS credential_authority_kind,
 credential.accountless_enrollment_device_id AS credential_enrollment_device_id,
 lower(hex(credential.secret_hash)) AS credential_secret_hash,credential.state AS credential_state,
 (SELECT count(*) FROM accountless_upload_owners x WHERE x.enrollment_device_id=ledger.device_id) AS owner_count,
 (SELECT count(*) FROM accountless_v11_device_authorizations x WHERE x.enrollment_device_id=ledger.device_id) AS grant_count,
 (SELECT count(*) FROM device_credentials x WHERE x.accountless_enrollment_device_id=ledger.device_id) AS credential_count,
 link.owner_digest AS local_owner_digest,link.state AS local_owner_state,
 (SELECT count(*) FROM storage_v11_owner_links x WHERE x.participant_id=owner.participant_id) AS local_owner_count,
 CASE WHEN EXISTS(SELECT 1 FROM telemetry_contributions x WHERE x.participant_id=owner.participant_id)
   OR EXISTS(SELECT 1 FROM telemetry_v1_chunks x WHERE x.participant_id=owner.participant_id)
   OR EXISTS(SELECT 1 FROM telemetry_v11_chunks x WHERE x.participant_id=owner.participant_id)
   OR EXISTS(SELECT 1 FROM contributions x WHERE x.participant_id=owner.participant_id) THEN 1 ELSE 0 END AS has_data
 FROM accountless_enrollment_ledger ledger
 LEFT JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
 LEFT JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
 LEFT JOIN device_credentials credential ON credential.accountless_enrollment_device_id=ledger.device_id
 LEFT JOIN participants participant ON participant.id=owner.participant_id
 LEFT JOIN storage_v11_owner_links link ON link.participant_id=owner.participant_id`;

async function manifestRow(raw:RawOwnerRow):Promise<ExistingAccountlessOwnerManifestRow>{
 id(raw.owner_id);digest(raw.reservation_key);
 const reservedAt=Date.parse(raw.issued_at),budgetDay=raw.issued_at.slice(0,10);integer(reservedAt);
 if(new Date(reservedAt).toISOString()!==raw.issued_at||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(budgetDay)
  ||!['active','revoked'].includes(raw.ledger_state))unavailable();
 const counts=[raw.owner_count,raw.grant_count,raw.credential_count];counts.forEach(value=>integer(value,0,1));
 const empty=counts.every(value=>value===0)&&raw.participant_id===null&&raw.local_owner_count===0&&raw.has_data===0;
 if(empty)return Object.freeze({reservationKey:raw.reservation_key,ownerId:raw.owner_id,
  deviceDigest:await sha256Hex(`app-usagemonitor/storage-accountless-device/v1\0${raw.device_id}`),budgetDay,reservedAt,
  participantLocatorDigest:null,deletionLocatorDigest:null,localOwnerDigest:null,localOwnerState:null,ownershipState:'enrollment-only'});
 if(counts.some(value=>value!==1)||!raw.participant_id||!PARTICIPANT.test(raw.participant_id)
  ||raw.participant_owner_kind!=='accountless'||!['active','deleting'].includes(raw.participant_state??'')
  ||raw.owner_participant_id!==raw.participant_id||raw.grant_participant_id!==raw.participant_id
  ||raw.credential_participant_id!==raw.participant_id||raw.owner_device_credential_id!==raw.device_id
  ||raw.grant_device_credential_id!==raw.device_id||raw.credential_enrollment_device_id!==raw.device_id
  ||raw.credential_authority_kind!=='accountless'||raw.credential_secret_hash!==raw.reservation_key
  ||!['active','revoked'].includes(raw.owner_state??'')||!['active','revoked'].includes(raw.grant_state??'')
  ||!['active','revoked'].includes(raw.credential_state??'')||raw.local_owner_count>1
  ||(raw.has_data===1&&raw.local_owner_count!==1))unavailable();
 if(raw.local_owner_count===1){digest(raw.local_owner_digest??'');if(!['active','withdrawn','erased'].includes(raw.local_owner_state??''))unavailable();}
 return Object.freeze({reservationKey:raw.reservation_key,ownerId:raw.owner_id,
  deviceDigest:await sha256Hex(`app-usagemonitor/storage-accountless-device/v1\0${raw.device_id}`),budgetDay,reservedAt,
  participantLocatorDigest:await participantStorageLocatorDigest(raw.participant_id),
  deletionLocatorDigest:await participantDeletionDigest(raw.participant_id),localOwnerDigest:raw.local_owner_digest,
  localOwnerState:raw.local_owner_state as ExistingAccountlessOwnerManifestRow['localOwnerState'],ownershipState:'owned'});
}

async function readOwnerPage(source:D1Database,afterOwnerId:string,limit:number){
 id(afterOwnerId||'cursor');integer(limit,1,MAX_EXISTING_ACCOUNTLESS_SOURCE_PAGE);
 const rows=(await source.prepare(`${OWNER_SELECT} WHERE ledger.installation_principal_id>?
  ORDER BY ledger.installation_principal_id LIMIT ?`).bind(afterOwnerId,limit+1).all<RawOwnerRow>()).results;
 if(rows.length>limit)return {rows:await Promise.all(rows.slice(0,limit).map(manifestRow)),more:true};
 return {rows:await Promise.all(rows.map(manifestRow)),more:false};
}

export async function existingAccountlessBootstrapManifestDigest(body:Omit<ExistingAccountlessBootstrapManifest,'manifestDigest'>){
 return sha256Hex(`app-usagemonitor/storage-existing-accountless-bootstrap-manifest/v1\0${canonicalJson(body)}`);
}
async function extractExistingAccountlessBootstrapManifestImpl(source:D1Database,policy:ExistingAccountlessBootstrapPolicy,
 pageSize=MAX_EXISTING_ACCOUNTLESS_SOURCE_PAGE):Promise<ExistingAccountlessBootstrapManifest>{
 id(policy.sourceId);id(policy.shardId);bindingName(policy.bindingName);digest(policy.sourceClosureDigest);
 integer(policy.routeReservationBytes,1,9_000_000_000);integer(pageSize,1,MAX_EXISTING_ACCOUNTLESS_SOURCE_PAGE);
 await closure(policy);const initial=await sourceHeader(source,policy.sourceId),owners:ExistingAccountlessOwnerManifestRow[]=[];
 let cursor='';for(let page=0;page<=Math.ceil(10_000/pageSize);page++){
  const result=await readOwnerPage(source,cursor,pageSize);owners.push(...result.rows);
  if(owners.length>10_000)unavailable();if(!result.more)break;
  cursor=result.rows.at(-1)?.ownerId??unavailable();if(page===Math.ceil(10_000/pageSize))unavailable();
 }
 const stable=await sourceHeader(source,policy.sourceId);await closure(policy);
 const dayOwners=owners.filter(owner=>owner.budgetDay===initial.issuance.budget_day).length;
 if(!same(initial,stable)||owners.length>initial.issuance.lifetime_issued
  ||dayOwners>initial.issuance.daily_issued)unavailable();
 const reservationRoster=owners.map(({reservationKey,ownerId,deviceDigest,budgetDay,reservedAt})=>
  ({reservationKey,ownerId,deviceDigest,budgetDay,reservedAt}));
 const ownerRosterDigest=await sha256Hex(`app-usagemonitor/storage-existing-accountless-owner-roster/v1\0${canonicalJson(owners)}`);
 const historicalReservationRosterDigest=await historicalAccountlessIssuanceRosterDigest(reservationRoster);
 const baselineDigest=await sha256Hex(`app-usagemonitor/storage-existing-accountless-issuance-baseline/v1\0${canonicalJson({
  sourceId:policy.sourceId,sourceSchemaDigest:initial.schemaDigest,sourceClosureDigest:policy.sourceClosureDigest,
  ...initial.issuance,ownerRosterDigest,historicalReservationRosterDigest})}`);
 const body=Object.freeze({schemaVersion:EXISTING_ACCOUNTLESS_BOOTSTRAP_SCHEMA_VERSION,sourceId:policy.sourceId,
  sourceSchemaDigest:initial.schemaDigest,sourceClosureDigest:policy.sourceClosureDigest,shardId:policy.shardId,
  bindingName:policy.bindingName,routeGeneration:1 as const,routeReservationBytes:policy.routeReservationBytes,
  owners:Object.freeze(owners),ownerRosterDigest,
  historicalReservationRosterDigest,baseline:Object.freeze({budgetDay:initial.issuance.budget_day,
   dailyReserved:initial.issuance.daily_issued,lifetimeReserved:initial.issuance.lifetime_issued,baselineDigest,
   initializedAt:Date.parse(initial.issuance.updated_at)})});
 return Object.freeze({...body,manifestDigest:await existingAccountlessBootstrapManifestDigest(body)});
}

/** Root-only extraction seam. The caller must prove the named source is
 * closed and keep the returned manifest private until it is imported. */
export async function extractExistingAccountlessBootstrapManifest(source:D1Database,
 policy:ExistingAccountlessBootstrapPolicy,pageSize=MAX_EXISTING_ACCOUNTLESS_SOURCE_PAGE){
 try{return await extractExistingAccountlessBootstrapManifestImpl(source,policy,pageSize);}
 catch(error){if(error instanceof ApiError)throw error;return unavailable();}
}

async function validateManifest(manifest:ExistingAccountlessBootstrapManifest){
 if(manifest.schemaVersion!==EXISTING_ACCOUNTLESS_BOOTSTRAP_SCHEMA_VERSION||!DIGEST.test(manifest.manifestDigest)
  ||manifest.owners.length>10_000||manifest.owners.some((row,index)=>index>0&&row.ownerId<=manifest.owners[index-1]!.ownerId))unavailable();
 id(manifest.sourceId);id(manifest.shardId);bindingName(manifest.bindingName);digest(manifest.sourceSchemaDigest);
 if(manifest.routeGeneration!==1)unavailable();
 digest(manifest.sourceClosureDigest);digest(manifest.ownerRosterDigest);
 digest(manifest.historicalReservationRosterDigest);digest(manifest.baseline.baselineDigest);
 for(const row of manifest.owners){
  id(row.ownerId);digest(row.reservationKey);digest(row.deviceDigest);integer(row.reservedAt);
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(row.budgetDay)
   ||!['enrollment-only','owned'].includes(row.ownershipState)
   ||(row.ownershipState==='enrollment-only'&&(row.participantLocatorDigest!==null
    ||row.deletionLocatorDigest!==null||row.localOwnerDigest!==null||row.localOwnerState!==null))
   ||(row.ownershipState==='owned'&&(!row.participantLocatorDigest||!row.deletionLocatorDigest))){unavailable();}
  if(row.participantLocatorDigest)digest(row.participantLocatorDigest);
  if(row.deletionLocatorDigest)digest(row.deletionLocatorDigest);
  if(row.localOwnerDigest)digest(row.localOwnerDigest);
  if(row.localOwnerState!==null&&!['active','withdrawn','erased'].includes(row.localOwnerState))unavailable();
 }
 const {manifestDigest,...body}=manifest;if(await existingAccountlessBootstrapManifestDigest(body)!==manifestDigest)unavailable();
 const extractedReservationDigest=await historicalAccountlessIssuanceRosterDigest(manifest.owners);
 if(extractedReservationDigest!==manifest.historicalReservationRosterDigest
  ||await sha256Hex(`app-usagemonitor/storage-existing-accountless-owner-roster/v1\0${canonicalJson(manifest.owners)}`)!==manifest.ownerRosterDigest)unavailable();
 integer(manifest.routeReservationBytes,1,9_000_000_000);integer(manifest.baseline.dailyReserved,0,1000);
 integer(manifest.baseline.lifetimeReserved,manifest.owners.length,10000);integer(manifest.baseline.initializedAt);
 if(manifest.baseline.lifetimeReserved<manifest.owners.length
  ||manifest.baseline.dailyReserved<manifest.owners.filter(row=>row.budgetDay===manifest.baseline.budgetDay).length
  ||!/^\d{4}-\d{2}-\d{2}$/u.test(manifest.baseline.budgetDay))unavailable();
}

async function pinManifest(catalog:D1Database,manifest:ExistingAccountlessBootstrapManifest,nowEpoch:number){
 try{await catalog.batch([
  catalog.prepare(`INSERT INTO storage_existing_accountless_bootstrap_manifests
   (singleton_id,manifest_digest,schema_version,source_id,source_schema_digest,source_closure_digest,shard_id,binding_name,
    route_generation,route_reservation_bytes,owner_count,owner_roster_digest,historical_reservation_roster_digest,
    baseline_budget_day,baseline_daily_reserved,baseline_lifetime_reserved,baseline_digest,baseline_initialized_at,created_at)
   VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO NOTHING`).bind(manifest.manifestDigest,
    manifest.schemaVersion,manifest.sourceId,manifest.sourceSchemaDigest,manifest.sourceClosureDigest,manifest.shardId,
    manifest.bindingName,manifest.routeGeneration,manifest.routeReservationBytes,manifest.owners.length,manifest.ownerRosterDigest,
    manifest.historicalReservationRosterDigest,manifest.baseline.budgetDay,manifest.baseline.dailyReserved,
    manifest.baseline.lifetimeReserved,manifest.baseline.baselineDigest,manifest.baseline.initializedAt,nowEpoch),
  catalog.prepare(`INSERT INTO storage_existing_accountless_bootstrap_progress
   (singleton_id,manifest_digest,state,after_owner_id,imported_count,revision,updated_at)
   SELECT 1,?,'importing','',0,0,? WHERE EXISTS(SELECT 1 FROM storage_existing_accountless_bootstrap_manifests
    WHERE singleton_id=1 AND manifest_digest=?) ON CONFLICT(singleton_id) DO NOTHING`)
   .bind(manifest.manifestDigest,nowEpoch,manifest.manifestDigest),
 ]);}catch{ /* Exact readback below resolves an uncertain acknowledgement. */ }
 const pinned=await catalog.prepare('SELECT * FROM storage_existing_accountless_bootstrap_manifests WHERE singleton_id=1').first<Record<string,unknown>>();
 if(!pinned||pinned.manifest_digest!==manifest.manifestDigest||pinned.schema_version!==manifest.schemaVersion
  ||pinned.owner_count!==manifest.owners.length
  ||pinned.owner_roster_digest!==manifest.ownerRosterDigest||pinned.source_id!==manifest.sourceId
  ||pinned.source_schema_digest!==manifest.sourceSchemaDigest||pinned.source_closure_digest!==manifest.sourceClosureDigest
  ||pinned.shard_id!==manifest.shardId||pinned.binding_name!==manifest.bindingName
  ||pinned.route_generation!==manifest.routeGeneration
  ||pinned.route_reservation_bytes!==manifest.routeReservationBytes
  ||pinned.historical_reservation_roster_digest!==manifest.historicalReservationRosterDigest
  ||pinned.baseline_budget_day!==manifest.baseline.budgetDay
  ||pinned.baseline_daily_reserved!==manifest.baseline.dailyReserved
  ||pinned.baseline_lifetime_reserved!==manifest.baseline.lifetimeReserved
  ||pinned.baseline_digest!==manifest.baseline.baselineDigest
  ||pinned.baseline_initialized_at!==manifest.baseline.initializedAt)unavailable();
}

async function verifyExactOwner(source:D1Database,expected:ExistingAccountlessOwnerManifestRow){
 const raw=await source.prepare(`${OWNER_SELECT} WHERE ledger.installation_principal_id=? LIMIT 2`).bind(expected.ownerId).all<RawOwnerRow>();
 if(raw.results.length!==1||!same(await manifestRow(raw.results[0]!),expected))unavailable();
}

async function importExistingAccountlessBootstrapPageImpl(options:{catalog:D1Database;source:D1Database;
 manifest:ExistingAccountlessBootstrapManifest;policy:ExistingAccountlessBootstrapPolicy;nowEpoch?:number;pageSize?:number}){
 const {catalog,source,manifest,policy}=options,nowEpoch=options.nowEpoch??Date.now(),pageSize=options.pageSize??MAX_EXISTING_ACCOUNTLESS_IMPORT_PAGE;
 integer(nowEpoch);integer(pageSize,1,MAX_EXISTING_ACCOUNTLESS_IMPORT_PAGE);await validateManifest(manifest);
 if(nowEpoch<manifest.baseline.initializedAt)unavailable();
 if(manifest.sourceId!==policy.sourceId||manifest.shardId!==policy.shardId||manifest.bindingName!==policy.bindingName
  ||manifest.routeGeneration!==1||manifest.routeReservationBytes!==policy.routeReservationBytes
  ||manifest.sourceClosureDigest!==policy.sourceClosureDigest)unavailable();
 await closure(policy);await pinManifest(catalog,manifest,nowEpoch);
 const initialProgress=await catalog.prepare('SELECT * FROM storage_existing_accountless_bootstrap_progress WHERE singleton_id=1').first<BootstrapProgress>();
 if(!initialProgress||initialProgress.manifest_digest!==manifest.manifestDigest)unavailable();
 let progress:BootstrapProgress=initialProgress;
 if(progress.state==='ready')return Object.freeze({complete:true,imported:0,afterOwnerId:progress.after_owner_id});
 const router=createCatalogStorageRouter({catalog,bindings:{[manifest.bindingName]:source},clock:()=>nowEpoch});
 const start=manifest.owners.findIndex(row=>row.ownerId>progress!.after_owner_id);
 const page=start<0?[]:manifest.owners.slice(start,start+pageSize);let imported=0;
 for(const owner of page){
  if(owner.ownerId<=progress.after_owner_id)continue;
  await closure(policy);await verifyExactOwner(source,owner);
  await closure(policy);
  const route=await router.ensureOwner(owner.ownerId,manifest.shardId,manifest.routeReservationBytes);
  if(route.bindingName!==manifest.bindingName||route.generation!==1)unavailable();
  if(owner.ownershipState==='owned'){
   await closure(policy);
   await router.registerParticipantOwner(owner.participantLocatorDigest!,owner.deletionLocatorDigest!,route);
  }
  await closure(policy);
  await importHistoricalAccountlessIssuanceReservation(catalog,owner);
  await closure(policy);
  const updated:BootstrapProgress|null=await catalog.prepare(`UPDATE storage_existing_accountless_bootstrap_progress
   SET after_owner_id=?,imported_count=imported_count+1,revision=revision+1,updated_at=?
   WHERE singleton_id=1 AND manifest_digest=? AND state='importing' AND after_owner_id=?
    AND imported_count=? AND revision=? RETURNING *`).bind(owner.ownerId,nowEpoch,manifest.manifestDigest,
    progress.after_owner_id,progress.imported_count,progress.revision).first<BootstrapProgress>();
  if(!updated){
   const raced=await catalog.prepare('SELECT * FROM storage_existing_accountless_bootstrap_progress WHERE singleton_id=1').first<BootstrapProgress>();
   if(!raced||raced.manifest_digest!==manifest.manifestDigest||raced.after_owner_id<owner.ownerId
    ||raced.imported_count<progress.imported_count+1||raced.revision<progress.revision+1)unavailable();progress=raced;
  }else{progress=updated;imported++;}
 }
 if(progress.imported_count<manifest.owners.length){
  if(page.length===0)unavailable();
  return Object.freeze({complete:false,imported,afterOwnerId:progress.after_owner_id});
 }
 await closure(policy);
 const stable=await extractExistingAccountlessBootstrapManifest(source,policy);
 if(stable.manifestDigest!==manifest.manifestDigest)unavailable();
 await finalizeAccountlessIssuanceBaseline(catalog,{...manifest.baseline,historicalRosterCount:manifest.owners.length,
  historicalRosterDigest:manifest.historicalReservationRosterDigest});
 if(progress.state==='importing'){
  const ready=await catalog.prepare(`UPDATE storage_existing_accountless_bootstrap_progress SET state='ready',revision=revision+1,updated_at=?
   WHERE singleton_id=1 AND manifest_digest=? AND state='importing' AND imported_count=? AND revision=? RETURNING *`)
   .bind(nowEpoch,manifest.manifestDigest,manifest.owners.length,progress.revision).first<BootstrapProgress>();
  if(!ready){const raced=await catalog.prepare('SELECT * FROM storage_existing_accountless_bootstrap_progress WHERE singleton_id=1').first<BootstrapProgress>();
   if(raced?.state!=='ready'||raced.manifest_digest!==manifest.manifestDigest)unavailable();progress=raced;}else progress=ready;
 }
 return Object.freeze({complete:true,imported,afterOwnerId:progress.after_owner_id});
}

/** Root-only, resumable import seam. One call advances at most pageSize exact
 * historical owners and never selects a destination outside the manifest. */
export async function importExistingAccountlessBootstrapPage(options:{catalog:D1Database;source:D1Database;
 manifest:ExistingAccountlessBootstrapManifest;policy:ExistingAccountlessBootstrapPolicy;nowEpoch?:number;pageSize?:number}){
 try{return await importExistingAccountlessBootstrapPageImpl(options);}
 catch(error){if(error instanceof ApiError)throw error;return unavailable();}
}
