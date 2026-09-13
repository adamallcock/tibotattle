import {applyD1Migrations,env,reset} from 'cloudflare:test';
import type {D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {enrollAccountlessDevice,ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
 ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
 type AccountlessEnrollmentRequest} from '../src/accountless-enrollment';
import {createAccountlessUploadOwner,ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
 ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
 ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION} from '../src/accountless-ownership';
import {initializeStorageSource} from '../src/analytics-delivery';
import {encodeBase64Url} from '../src/crypto';
import {deviceHash} from '../src/device-auth';
import {participantDeletionDigest} from '../src/participant-deletion-digest';
import {configureStorageShardAllocation,recordStorageCapacityObservation} from '../src/storage-capacity';
import {extractExistingAccountlessBootstrapManifest,
 importExistingAccountlessBootstrapPage,type ExistingAccountlessBootstrapPolicy} from '../src/storage-existing-owner-bootstrap';
import {createCatalogStorageRouter} from '../src/storage-routing';
import {participantStorageLocatorDigest,storageForAccountlessEnrollment,
 storageForDeviceAuthorization,storageForParticipantDeletionDigest,
 storageForParticipantOwner} from '../src/storage-routing-runtime';

interface Bindings extends Env {
 STORAGE_ROUTING_DB:D1Database;STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;
 STORAGE_INGESTION_C:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_ROUTING_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
}
const b=()=>env as Bindings,catalog=()=>b().STORAGE_ROUTING_DB,source=()=>b().STORAGE_INGESTION_A;
const NOW=Date.parse('2026-09-13T12:00:00.000Z'),RESERVATION=16_777_216;
const SOURCE_ID='existing-accountless-source-a',CLOSURE='c'.repeat(64);
const policy=(overrides:Partial<ExistingAccountlessBootstrapPolicy>={}):ExistingAccountlessBootstrapPolicy=>({
 sourceId:SOURCE_ID,sourceClosureDigest:CLOSURE,shardId:'a',bindingName:'STORAGE_INGESTION_A',
 routeReservationBytes:RESERVATION,assertSourceClosed:async()=>CLOSURE,...overrides,
});
function runtime():Env{return {...b(),STORAGE_ROUTING_MODE:'catalog',STORAGE_NEW_OWNER_RESERVATION_BYTES:String(RESERVATION)} as unknown as Env;}
function bearer(deviceId:string,secret:Uint8Array){return `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;}
async function enrollment(secret=crypto.getRandomValues(new Uint8Array(32))){
 const deviceId=crypto.randomUUID();
 const request:AccountlessEnrollmentRequest={schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,deviceId,
  deviceSecretHash:await deviceHash(deviceId,encodeBase64Url(secret)),policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS};
 expect((await enrollAccountlessDevice(source(),request,NOW)).status).toBe(201);
 const ownerId=await source().prepare('SELECT installation_principal_id FROM accountless_enrollment_ledger WHERE device_id=?')
  .bind(deviceId).first<string>('installation_principal_id');
 if(!ownerId)throw Error('synthetic enrollment owner required');
 return {deviceId,secret,request,ownerId,authorization:bearer(deviceId,secret)};
}
async function own(row:Awaited<ReturnType<typeof enrollment>>){
 const result=await createAccountlessUploadOwner(source(),row.authorization,{schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION},NOW+1);
 return {...row,participantId:result.participantId};
}
async function importAll(manifest:Awaited<ReturnType<typeof extractExistingAccountlessBootstrapManifest>>){
 let result=await importExistingAccountlessBootstrapPage({catalog:catalog(),source:source(),manifest,policy:policy(),nowEpoch:NOW+100,pageSize:1});
 for(let count=0;!result.complete&&count<manifest.owners.length;count++)result=await importExistingAccountlessBootstrapPage({
  catalog:catalog(),source:source(),manifest,policy:policy(),nowEpoch:NOW+101+count,pageSize:1});
 return result;
}

beforeEach(async()=>{
 await reset();
 await applyD1Migrations(catalog(),b().TEST_ROUTING_MIGRATIONS);
 for(const database of [source(),b().STORAGE_INGESTION_B,b().STORAGE_INGESTION_C]){
  await applyD1Migrations(database,b().TEST_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_INGESTION_ROUTING_MIGRATIONS);
 }
 await applyD1Migrations(source(),b().TEST_TYPED_INGESTION_MIGRATIONS);
 await initializeStorageSource(source(),SOURCE_ID);
 await applyD1Migrations(source(),b().TEST_INGESTION_BRIDGE_MIGRATIONS);
 await catalog().batch([
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('a','STORAGE_INGESTION_A','active')"),
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('b','STORAGE_INGESTION_B','active')"),
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('c','STORAGE_INGESTION_C','active')"),
 ]);
 await recordStorageCapacityObservation(catalog(),{shardId:'a',observedBytes:1_000,observedAt:NOW,
  validUntil:NOW+10_000,pressureState:'normal'});
 await configureStorageShardAllocation(catalog(),{shardId:'a',allocationTier:'active',allocationEnabled:true,updatedAt:NOW});
});

describe('trusted existing accountless owner bootstrap',()=>{
 it('finalizes an authoritative empty source without inventing a reservation',async()=>{
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy(),1);
  expect(manifest.owners).toEqual([]);
  expect(manifest.baseline).toMatchObject({dailyReserved:0,lifetimeReserved:0});
  expect((await importAll(manifest)).complete).toBe(true);
  expect(await catalog().prepare('SELECT initialization_state FROM storage_accountless_issuance_state').first('initialization_state'))
   .toBe('ready');
  expect(await catalog().prepare('SELECT count(*) n FROM storage_owner_routes').first('n')).toBe(0);
 });

 it('preserves an authoritative issuance count above the retained retry roster',async()=>{
  const removed=await enrollment();
  await source().prepare('DELETE FROM accountless_enrollment_ledger WHERE device_id=?').bind(removed.deviceId).run();
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy());
  expect(manifest.owners).toEqual([]);
  expect(manifest.baseline).toMatchObject({dailyReserved:1,lifetimeReserved:1});
  expect((await importAll(manifest)).complete).toBe(true);
  expect(await catalog().prepare('SELECT daily_reserved,lifetime_reserved FROM storage_accountless_issuance_state').first())
   .toEqual({daily_reserved:1,lifetime_reserved:1});
 });

 it('imports a paginated populated source and restores credential retry plus both erasure locators',async()=>{
  const owned=await own(await enrollment());
  const empty=await enrollment();
  const localDigest='d'.repeat(64);
  await source().prepare("INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state) VALUES(?,?,'active')")
   .bind(owned.participantId,localDigest).run();
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy(),1);
  expect(manifest.owners).toHaveLength(2);
  expect(manifest.baseline).toMatchObject({dailyReserved:2,lifetimeReserved:2});
  expect(manifest.owners.find(row=>row.ownerId===owned.ownerId)).toMatchObject({
   ownershipState:'owned',localOwnerDigest:localDigest,participantLocatorDigest:await participantStorageLocatorDigest(owned.participantId),
   deletionLocatorDigest:await participantDeletionDigest(owned.participantId),
  });
  expect((await importExistingAccountlessBootstrapPage({catalog:catalog(),source:source(),manifest,
   policy:policy(),nowEpoch:NOW+100,pageSize:1})).complete).toBe(false);
  expect((await importAll(manifest)).complete).toBe(true);

  expect(await catalog().prepare("SELECT count(*) n FROM storage_owner_routes WHERE shard_id='a' AND state='active'").first('n')).toBe(2);
  expect(await catalog().prepare('SELECT daily_reserved,lifetime_reserved,initialization_state FROM storage_accountless_issuance_state WHERE singleton_id=1').first())
   .toEqual({daily_reserved:2,lifetime_reserved:2,initialization_state:'ready'});
  expect(await catalog().prepare('SELECT count(*) n FROM storage_accountless_historical_issuance_reservations').first('n')).toBe(2);
  expect((await storageForDeviceAuthorization(runtime(),owned.authorization)).route).toMatchObject({ownerId:owned.ownerId,shardId:'a'});
  expect((await storageForParticipantOwner(runtime(),owned.participantId)).route.ownerId).toBe(owned.ownerId);
  expect((await storageForParticipantDeletionDigest(runtime(),await participantDeletionDigest(owned.participantId))).route.ownerId).toBe(owned.ownerId);
  const replay=await storageForAccountlessEnrollment(runtime(),owned.request);
  expect(replay.route.ownerId).toBe(owned.ownerId);
  expect((await enrollAccountlessDevice(replay.database,owned.request,NOW+200,replay.route,replay.issuanceReservation)).status).toBe(200);
  expect(await catalog().prepare(`SELECT count(*) n FROM storage_participant_owner_locators
   WHERE participant_digest=? AND participant_digest<>?`).bind(await participantStorageLocatorDigest(owned.participantId),owned.participantId).first('n')).toBe(1);
  expect(await catalog().prepare(`SELECT count(*) n FROM storage_participant_deletion_replay_locators
   WHERE participant_digest=? AND participant_digest<>?`).bind(await participantDeletionDigest(owned.participantId),owned.participantId).first('n')).toBe(1);
  expect((await importAll(manifest)).complete).toBe(true);
  expect(await catalog().prepare('SELECT count(*) n FROM storage_owner_routes').first('n')).toBe(2);
 });

 it('pins the exact manifest before source access and resumes after the source is restored',async()=>{
  const row=await enrollment();
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy());
  await source().prepare("UPDATE accountless_enrollment_ledger SET device_secret_hash=randomblob(32) WHERE device_id=?")
   .bind(row.deviceId).run();
  await expect(importExistingAccountlessBootstrapPage({catalog:catalog(),source:source(),manifest,policy:policy(),nowEpoch:NOW+100}))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await catalog().prepare('SELECT manifest_digest FROM storage_existing_accountless_bootstrap_manifests').first('manifest_digest'))
   .toBe(manifest.manifestDigest);
  expect(await catalog().prepare('SELECT count(*) n FROM storage_owner_routes').first('n')).toBe(0);
  await source().prepare("UPDATE accountless_enrollment_ledger SET device_secret_hash=? WHERE device_id=?")
   .bind(row.request.deviceSecretHash,row.deviceId).run();
  expect((await importAll(manifest)).complete).toBe(true);
 });

 it('refuses a conflicting destination route without publishing credential or erasure locators',async()=>{
  const row=await own(await enrollment());
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy());
  await recordStorageCapacityObservation(catalog(),{shardId:'b',observedBytes:1_000,observedAt:NOW,
   validUntil:NOW+10_000,pressureState:'normal'});
  await configureStorageShardAllocation(catalog(),{shardId:'b',allocationTier:'active',allocationEnabled:true,updatedAt:NOW});
  const wrong=createCatalogStorageRouter({catalog:catalog(),bindings:{STORAGE_INGESTION_B:b().STORAGE_INGESTION_B},clock:()=>NOW});
  await wrong.ensureOwner(row.ownerId,'b',RESERVATION);
  await expect(importExistingAccountlessBootstrapPage({catalog:catalog(),source:source(),manifest,policy:policy(),nowEpoch:NOW+100}))
   .rejects.toBeTruthy();
  expect(await catalog().prepare('SELECT count(*) n FROM storage_capability_locators').first('n')).toBe(0);
  expect(await catalog().prepare('SELECT count(*) n FROM storage_participant_owner_locators').first('n')).toBe(0);
  expect(await catalog().prepare('SELECT count(*) n FROM storage_participant_deletion_replay_locators').first('n')).toBe(0);
 });

 it('refuses closure loss and a source roster that cannot prove the authoritative counters',async()=>{
  await enrollment();
  await expect(extractExistingAccountlessBootstrapManifest(source(),policy({assertSourceClosed:async()=>{throw Error('private');}})))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await catalog().prepare('SELECT count(*) n FROM storage_existing_accountless_bootstrap_manifests').first('n')).toBe(0);
  await source().prepare("UPDATE accountless_enrollment_issuance SET daily_issued=0,lifetime_issued=0,last_issue_token=''").run();
  await expect(extractExistingAccountlessBootstrapManifest(source(),policy(),1))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 });

 it('refuses an owned graph with unexplained telemetry and no local owner link',async()=>{
  await own(await enrollment());
  function forceData(database:D1Database):D1Database{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
    if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
    if(key==='all')return async<T=Record<string,unknown>>()=>{
     const result=await target.all<T>();
     return {...result,results:result.results.map(row=>({...row,has_data:1}))};
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
   return new Proxy(database,{get(target,key){
    if(key==='prepare')return(sql:string)=>sql.includes(' AS has_data')?wrap(target.prepare(sql)):target.prepare(sql);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
  }
  await expect(extractExistingAccountlessBootstrapManifest(forceData(source()),policy()))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 });

 it('converges after an unknown progress acknowledgement without double importing an owner',async()=>{
  await enrollment();
  const manifest=await extractExistingAccountlessBootstrapManifest(source(),policy());
  let lose=true;
  const uncertain=new Proxy(catalog(),{get(target,key){
   if(key!=='prepare'){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}
   return(sql:string)=>{
    const statement=target.prepare(sql);
    if(!sql.includes('UPDATE storage_existing_accountless_bootstrap_progress\n   SET after_owner_id='))return statement;
    const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{get(inner,method){
     if(method==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
     if(method==='first')return async<T=Record<string,unknown>>(column?:string)=>{
      const result=await inner.first<T>(column as never);if(lose){lose=false;throw Error('unknown acknowledgement');}return result;
     };
     const member=Reflect.get(inner,method);return typeof member==='function'?member.bind(inner):member;
    }});return wrap(statement);
   };
  }});
  await expect(importExistingAccountlessBootstrapPage({catalog:uncertain,source:source(),manifest,policy:policy(),nowEpoch:NOW+100}))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE',message:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await catalog().prepare('SELECT imported_count FROM storage_existing_accountless_bootstrap_progress').first('imported_count')).toBe(1);
  expect((await importExistingAccountlessBootstrapPage({catalog:catalog(),source:source(),manifest,policy:policy(),nowEpoch:NOW+101})).complete).toBe(true);
  expect(await catalog().prepare('SELECT count(*) n FROM storage_accountless_historical_issuance_reservations').first('n')).toBe(1);
 });
});
