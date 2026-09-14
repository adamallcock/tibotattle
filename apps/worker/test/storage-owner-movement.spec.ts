import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { encodeBase64Url, sha256Hex } from '../src/crypto';
import { canonicalJson } from '../src/canonical-json';
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization,
  deviceAuthorizationCapabilityHash, deviceHash } from '../src/device-auth';
import { handleRequest } from '../src/index';
import { createAccountlessUploadOwner, ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION, ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION } from '../src/accountless-ownership';
import { ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS, ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION, ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  revokeAccountlessEnrollment } from '../src/accountless-enrollment';
import { initializeStorageSource, STORAGE_OPERATING_BUDGET_BYTES } from '../src/analytics-delivery';
import { configureStorageShardAllocation, recordStorageCapacityObservation } from '../src/storage-capacity';
import { createAccountlessV11OwnerMovement } from '../src/storage-owner-movement';
import { createCatalogStorageRouter, type OwnerStorageRoute } from '../src/storage-routing';
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { insertTypedTelemetryV1Chunk } from '../src/typed-v1-admission';
import { TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION, TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
 TELEMETRY_V1_PRIVACY_CONTRACT_VERSION } from '../src/telemetry-v1';
import { readTypedTelemetryPage } from '../src/typed-telemetry-repository';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { qualifyStorageShardForTest } from './helpers/storage-shard-readiness';
import { makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import { eraseParticipantAsOwner } from '../src/participant-erasure';
import { registerParticipantOwnerRoute } from '../src/storage-routing-runtime';
import { ACCOUNTLESS_RENEWAL_SCHEMA_VERSION, renewAccountlessUploadOwner } from '../src/accountless-renewal';

interface Bindings extends Env {
  STORAGE_ROUTING_DB:D1Database; STORAGE_INGESTION_A:D1Database; STORAGE_INGESTION_B:D1Database;
  STORAGE_ANALYTICS_A:D1Database; STORAGE_ANALYTICS_B:D1Database; STORAGE_PUBLICATION_DB:D1Database;
  TEST_MIGRATIONS:D1Migration[]; TEST_ROUTING_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_ANALYTICS_MIGRATIONS:D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[];
}
const b=()=>env as Bindings,catalog=()=>b().STORAGE_ROUTING_DB,source=()=>b().STORAGE_INGESTION_A;
const destination=()=>b().STORAGE_INGESTION_B,NAMESPACE_A='synthetic-move-origin-a',NAMESPACE_B='synthetic-move-origin-b';
const NOW=Date.now(),RESERVATION=16_777_216;
const bindings=()=>({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:destination()});
const router=()=>createCatalogStorageRouter({catalog:catalog(),bindings:bindings(),clock:()=>NOW});
const movement=(moveBindings=bindings(),moveCatalog=catalog(),clock=()=>NOW)=>
 createAccountlessV11OwnerMovement({catalog:moveCatalog,bindings:moveBindings,clock});

function runtime():Env {
 return {...b(),ENVIRONMENT:'synthetic-development',ACCOUNT_SCOPED_INGEST_MODE:'disabled',
  ACCOUNTLESS_ENROLLMENT_MODE:'enabled',ACCOUNTLESS_OWNERSHIP_MODE:'enabled',STORAGE_ROUTING_MODE:'catalog',
  STORAGE_NEW_OWNER_RESERVATION_BYTES:String(RESERVATION),TELEMETRY_STORAGE_MODE:'typed',
  TELEMETRY_STORAGE_NAMESPACE:NAMESPACE_A,STORAGE_SOURCE_NAMESPACE_A:NAMESPACE_A,
  STORAGE_SOURCE_NAMESPACE_B:NAMESPACE_B,STORAGE_ANALYTICS_A:b().STORAGE_ANALYTICS_A,
  STORAGE_ANALYTICS_B:b().STORAGE_ANALYTICS_B,STORAGE_PUBLICATION_DB:b().STORAGE_PUBLICATION_DB,
  ALLOWANCE_RECONSTRUCTION_MODE:'paused'} as unknown as Env;
}
function ownerBody(){return {schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
 policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
 telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION} as const;}
function authorization(deviceId:string,secret:string){return `Device um_device_${deviceId}.${secret}`;}
async function qualify(shardId:'a'|'b',bindingName:'STORAGE_INGESTION_A'|'STORAGE_INGESTION_B'){
 await recordStorageCapacityObservation(catalog(),{shardId,observedBytes:1_000,observedAt:NOW-1000,
  validUntil:NOW+60_000,pressureState:'normal'});
 const receipt=await qualifyStorageShardForTest(catalog(),{shardId,bindingName,qualifiedAt:NOW-1000});
 await configureStorageShardAllocation(catalog(),{shardId,allocationTier:'active',allocationEnabled:true,
  qualificationDigest:receipt.readinessDigest,updatedAt:NOW-1000});
}
async function ownerFixture(){
 const ownerId=`accountless:${crypto.randomUUID()}`,deviceId=crypto.randomUUID();
 const secret=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),header=authorization(deviceId,secret);
 const route=await router().ensureOwner(ownerId,'a',RESERVATION),hash=await deviceHash(deviceId,secret);
 const issuedEpoch=NOW-24*86_400_000,issuedAt=new Date(issuedEpoch).toISOString();
 const expiresAt=new Date(issuedEpoch+ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS).toISOString();
 await router().write(route,db=>[db.prepare(`INSERT INTO accountless_enrollment_ledger(
  device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
  state,issued_at,expires_at) VALUES(?,?,?,?,?,?,'active',?,?)`).bind(deviceId,hash.buffer,ownerId,
   ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
   ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,issuedAt,expiresAt)]);
 const created=await createAccountlessUploadOwner(source(),header,ownerBody(),NOW,route);
 await router().registerCapability(await deviceAuthorizationCapabilityHash(header),route);
 return {ownerId,deviceId,participantId:created.participantId,header,route,expiresAt};
}
async function insertTyped(fixture:Awaited<ReturnType<typeof ownerFixture>>,route:OwnerStorageRoute,
 sourceNamespace:string,day:string,sequence:number){
 const db=route.shardId==='a'?source():destination();
 const principal=await authenticateDevice(db,fixture.header,{nowEpoch:NOW},route);
 const prepared=await makeV11Day(day,{usage:[v11UsageRecord(day,'gpt-5.5',
  {eventId:`event:v2:${sequence.toString(16).padStart(64,'0')}`})]});
 const staged=await registerTelemetryV11DayManifest(db,principal,prepared.manifest,NOW,route);
 const envelopeDigest=sequence.toString(16).padStart(64,'a');
 const upload=await createDeviceUploadAuthorization(db,principal,envelopeDigest,200,NOW,route);
 const claimed=await claimDeviceUploadAuthorization(db,`Upload ${upload.uploadAuthorization}`,
  {envelopeDigest,bodyBytes:200,contentType:'application/json'},route);
 const metadata={sourceNamespace,
  chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,
  envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId};
 const result=await persistTypedV11StagedChunk(db,principal,prepared.chunks[0],metadata,NOW,route);
 return {principal,staged,result,prepared,metadata};
}
async function drainHistory(mover:ReturnType<typeof movement>,moveId:string){
 for(let step=0;step<32;step++){
  const result=await mover.materializeHistoryPage(moveId);
  if(result.state==='complete')return result;
 }
 throw new Error('history import did not complete');
}
function loseStagingAcknowledgement(database:D1Database):D1Database{
 const sql=new WeakMap<object,string>();let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   const wrapped=new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});sql.set(wrapped,query);return wrapped;};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const staged=statements.some(statement=>(sql.get(statement as object)??'').includes('INSERT INTO storage_owner_move_staged_records'));
   const result=await target.batch(statements);if(staged&&!lost){lost=true;throw new Error('synthetic lost destination acknowledgement');}return result;
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function loseAuthorityAcknowledgement(database:D1Database):D1Database{
 const sql=new WeakMap<object,string>();let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const authority=statements.some(statement=>(sql.get(statement as object)??'').includes('UPDATE storage_owner_move_authority_seeds'));
   const result=await target.batch(statements);if(authority&&!lost){lost=true;throw new Error('synthetic lost authority acknowledgement');}return result;
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function loseHistoryAcknowledgement(database:D1Database):D1Database{
 const sql=new WeakMap<object,string>();let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const history=statements.some(statement=>(sql.get(statement as object)??'').includes('INSERT INTO telemetry_v11_chunks'));
   const result=await target.batch(statements);if(history&&!lost){lost=true;throw new Error('synthetic lost history acknowledgement');}return result;
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function observedPhysicalSize(database:D1Database,size:number){
 const sql=new WeakMap<object,string>();
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   const wrapped=new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});sql.set(wrapped,query);return wrapped;};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const queries=statements.map(statement=>sql.get(statement as object)??'');
   const results=await target.batch(statements),probe=queries.indexOf('SELECT 1 AS typed_admission_capacity_probe');
   if(probe>=0){const result=results[probe]!;results[probe]={...result,meta:{...result.meta,size_after:size}} as D1Result;}
   return results;
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function loseRouteSwitchAcknowledgement(database:D1Database):D1Database{
 const sql=new WeakMap<object,string>();let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const switched=statements.some(statement=>(sql.get(statement as object)??'').includes("UPDATE storage_owner_routes SET shard_id = ?"));
   const result=await target.batch(statements);if(switched&&!lost){lost=true;throw new Error('synthetic lost route-switch acknowledgement');}return result;
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function loseMoveErasureAcknowledgement(database:D1Database):D1Database{
 let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{
     const bound=value.bind(...args);
     if(!query.includes('INSERT INTO storage_owner_move_erasure_controls'))return bound;
     return new Proxy(bound,{get(inner,operation){
      if(operation==='run')return async()=>{const result=await inner.run();if(!lost){lost=true;throw new Error('synthetic lost move erasure acknowledgement');}return result;};
      const property=Reflect.get(inner,operation);return typeof property==='function'?property.bind(inner):property;
     }});
    };
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function revokeBeforeMoveFence(database:D1Database,deviceId:string,route:OwnerStorageRoute):D1Database{
 let revoked=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{
     const bound=value.bind(...args);
     if(!query.includes("UPDATE storage_owner_fences SET state='fenced',move_id=?"))return bound;
     return new Proxy(bound,{get(inner,operation){
      if(operation==='run')return async()=>{
       if(!revoked){revoked=true;await revokeAccountlessEnrollment(target,deviceId,'security_reset',NOW,route);}
       return inner.run();
      };
      const property=Reflect.get(inner,operation);return typeof property==='function'?property.bind(inner):property;
     }});
    };
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function loseAtomicMoveFenceAcknowledgement(database:D1Database):D1Database{
 let lost=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{
     const bound=value.bind(...args);
     if(!query.includes("UPDATE storage_owner_fences SET state='fenced',move_id=?"))return bound;
     return new Proxy(bound,{get(inner,operation){
      if(operation==='run')return async()=>{const result=await inner.run();
       if(!lost){lost=true;throw new Error('synthetic lost atomic fence acknowledgement');}return result;};
      const property=Reflect.get(inner,operation);return typeof property==='function'?property.bind(inner):property;
     }});
    };
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
function writeV1BeforeMoveFence(database:D1Database,write:()=>Promise<void>):D1Database{
 let written=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{
     const bound=value.bind(...args);
     if(!query.includes("UPDATE storage_owner_fences SET state='fenced',move_id=?"))return bound;
     return new Proxy(bound,{get(inner,operation){
      if(operation==='run')return async()=>{if(!written){written=true;await write();}return inner.run();};
      const property=Reflect.get(inner,operation);return typeof property==='function'?property.bind(inner):property;
     }});
    };
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
}
async function preparedLegacyV1Write(fixture:Awaited<ReturnType<typeof ownerFixture>>):Promise<()=>Promise<void>>{
 // This models a request admitted by a pre-v1.1 Worker but still protected by
 // the current owner route fence. Current accountless admission itself refuses
 // v1 at its transport floor, so only the historical writer guards are removed.
 await source().batch([
  source().prepare('DROP TRIGGER telemetry_transport_v1_insert'),
  source().prepare('DROP TRIGGER telemetry_v1_chunks_require_social_owner'),
  source().prepare('DROP TRIGGER telemetry_v1_consent_requires_social_owner'),
  source().prepare('DROP TRIGGER typed_v1_header_authority'),
 ]);
 await source().prepare(`INSERT INTO telemetry_v1_device_consents(participant_id,device_id,
  telemetry_schema_version,field_dictionary_version,privacy_contract_version,consented_at)
  VALUES(?,?,?,?,?,?)`).bind(fixture.participantId,fixture.deviceId,TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
   TELEMETRY_V1_FIELD_DICTIONARY_VERSION,TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,new Date(NOW).toISOString()).run();
 const principal=await authenticateDevice(source(),fixture.header,{nowEpoch:NOW},fixture.route);
 const envelopeDigest='9'.repeat(64),upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,200,NOW,fixture.route);
 const claimed=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,
  {envelopeDigest,bodyBytes:200,contentType:'application/json'},fixture.route);
 const day=new Date(NOW).toISOString().slice(0,10),record={schemaVersion:'usage-event-v1.0' as const,
  eventId:`event:v2:${'8'.repeat(64)}`,eventTime:`${day}T12:00:00.000Z`,sessionUuid:crypto.randomUUID(),
  provider:'openai_codex',modelId:'gpt-5.5',speedMode:'standard',apiServiceTier:'default',surface:'cli',
  billingSurface:'subscription',reasoningEffort:'medium',agentScope:'main',outcome:'success',
  totalInputContextTokens:1,components:{inputUncachedTokens:1,inputCacheReadTokens:null,
   inputCacheWriteTokens:null,outputTextTokens:1,outputReasoningTokens:null,outputCombinedTokens:1}};
 const records=[record],chunkDigest=await sha256Hex(canonicalJson(records));
 return async()=>{await insertTypedTelemetryV1Chunk(source(),{
  participantId:fixture.participantId,deviceId:fixture.deviceId,deviceUploadAuthorizationId:claimed.authorizationId,
  chunkRowId:`legacy-race:${crypto.randomUUID()}`,r2Key:`synthetic/legacy-race/${crypto.randomUUID()}`,
  envelopeDigest,chunk:{schemaVersion:TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,chunkId:`usage:${day}:0`,
   chunkRevision:1,chunkDigest,parserVersion:'synthetic-move-race',consent:{
    telemetrySchemaVersion:TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    fieldDictionaryVersion:TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
    privacyContractVersion:TELEMETRY_V1_PRIVACY_CONTRACT_VERSION},records} as never,
  supersedes:null,createdAt:new Date(NOW).toISOString()},NAMESPACE_A,fixture.route);};
}
function pauseStaging(database:D1Database){
 const sql=new WeakMap<object,string>();let release!:()=>void,arrived!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const reached=new Promise<void>(resolve=>{arrived=resolve;});
 const paused=new Proxy(database,{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   return new Proxy(statement,{get(value,member){
    if(member==='bind')return (...args:Parameters<D1PreparedStatement['bind']>)=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
    const property=Reflect.get(value,member);return typeof property==='function'?property.bind(value):property;
   }});};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   if(statements.some(statement=>(sql.get(statement as object)??'').includes('INSERT INTO storage_owner_move_staged_records'))){
    arrived();await gate;
   }
   return target.batch(statements);
  };
  const property=Reflect.get(target,key);return typeof property==='function'?property.bind(target):property;
 }});
 return {database:paused,reached,release};
}

beforeEach(async()=>{
 await reset();await applyD1Migrations(b().USAGE_MONITOR_DB,b().TEST_MIGRATIONS);
 await applyD1Migrations(b().DELETION_LEDGER,b().TEST_DELETION_LEDGER_MIGRATIONS);
 await applyD1Migrations(catalog(),b().TEST_ROUTING_MIGRATIONS);
 for(const [database,namespace,sourceId] of [[source(),NAMESPACE_A,'source-a'],[destination(),NAMESPACE_B,'source-b']] as const){
  await applyD1Migrations(database,b().TEST_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(database,sourceId);
  await applyD1Migrations(database,b().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_INGESTION_ROUTING_MIGRATIONS);
  await initializeTypedV11Admission(database,namespace);await initializeTypedV1Admission(database,namespace);
  await database.prepare(`UPDATE telemetry_transport_formats SET lifecycle='accepted'
   WHERE schema_version='telemetry-contribution-v1.1'`).run();
 }
 await catalog().batch([
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('a','STORAGE_INGESTION_A','active')"),
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('b','STORAGE_INGESTION_B','active')"),
 ]);
 await qualify('a','STORAGE_INGESTION_A');await qualify('b','STORAGE_INGESTION_B');
 for(const target of [b().STORAGE_ANALYTICS_A,b().STORAGE_ANALYTICS_B,b().STORAGE_PUBLICATION_DB]){
  await applyD1Migrations(target,b().TEST_ANALYTICS_MIGRATIONS);
 }
 await initializeStorageAnalyticsRuntime({source:source(),target:b().STORAGE_ANALYTICS_A,
  sourceId:'source-a',sourceNamespace:NAMESPACE_A});
 await initializeStorageAnalyticsRuntime({source:destination(),target:b().STORAGE_ANALYTICS_B,
  sourceId:'source-b',sourceNamespace:NAMESPACE_B});
});

describe('accountless v11 owner movement',()=>{
 it('switches an authority-only owner once and keeps credentials exact for new destination writes',async()=>{
  const fixture=await ownerFixture();
  expect(await renewAccountlessUploadOwner(source(),fixture.header,{schemaVersion:ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
   policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
   telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION},NOW,fixture.route))
   .toMatchObject({state:'renewed',renewalGeneration:1});
  const unrelated=await ownerFixture();await insertTyped(unrelated,unrelated.route,NAMESPACE_A,'2026-09-11',9);
  const mover=movement();await mover.prepare('move-one',fixture.route,'b',NAMESPACE_A);
  expect(await catalog().prepare('SELECT shard_id FROM storage_owner_routes WHERE owner_id=?').bind(fixture.ownerId).first('shard_id')).toBe('a');
  const replayBefore=await handleRequest(new Request('https://example.test/api/v1/accountless/ownership',{method:'POST',
   headers:{origin:'https://example.test',authorization:fixture.header,'content-type':'application/json'},body:JSON.stringify(ownerBody())}),runtime());
  expect(replayBefore.status,await replayBefore.clone().text()).toBe(200);
  expect(await mover.copyPage('move-one',1)).toMatchObject({state:'ready',copied:0});
  const finalizing=await mover.fenceSource('move-one');expect(finalizing.final_high_water).toBe(0);
  await expect(insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-14',3)).rejects.toThrow('STORAGE_ROUTE_STALE');
  expect(await mover.copyPage('move-one',1)).toMatchObject({state:'finalizing',copied:0});
  await mover.materializeAuthority('move-one');
  expect(await mover.verifyPage('move-one',1)).toMatchObject({state:'verified',verified:0});
  const destinationRoute=await mover.commit('move-one');
  expect(destinationRoute).toMatchObject({ownerId:fixture.ownerId,shardId:'b',generation:2,mode:'catalog'});
  expect((await mover.commit('move-one')).shardId).toBe('b');

  const replayAfter=await handleRequest(new Request('https://example.test/api/v1/accountless/ownership',{method:'POST',
   headers:{origin:'https://example.test',authorization:fixture.header,'content-type':'application/json'},body:JSON.stringify(ownerBody())}),runtime());
  expect(replayAfter.status,await replayAfter.clone().text()).toBe(200);
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records WHERE move_id=? AND source_namespace=?')
   .bind('move-one',NAMESPACE_A).first('n')).toBe(0);
  expect(await source().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(1);
  expect(await destination().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(0);
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records WHERE participant_id=?')
   .bind(unrelated.participantId).first('n')).toBe(0);
  expect(await destination().prepare('SELECT renewal_generation FROM accountless_enrollment_ledger WHERE device_id=?')
   .bind(fixture.deviceId).first('renewal_generation')).toBe(1);
  await insertTyped(fixture,destinationRoute,NAMESPACE_B,'2026-09-14',3);
  const newRows=await readTypedTelemetryPage(destination(),{sourceNamespace:NAMESPACE_B,format:'v11',participantId:fixture.participantId});
  expect(newRows.records.map(row=>[row.sourceNamespace,row.sourceRowId])).toEqual([[NAMESPACE_B,1]]);
  expect(await source().prepare(`SELECT state FROM storage_owner_fences WHERE owner_id=?`).bind(fixture.ownerId).first('state')).toBe('fenced');
 });

 it('moves canonical v1.1 replay history and retains original ids while new writes use the destination origin',async()=>{
  const fixture=await ownerFixture();const original=await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',1);
  const mover=movement();await mover.prepare('move-ready-gap',fixture.route,'b',NAMESPACE_A);
  expect(await mover.copyPage('move-ready-gap',1)).toMatchObject({state:'ready',copied:1});
  await mover.fenceSource('move-ready-gap');
  expect(await mover.copyPage('move-ready-gap',1)).toMatchObject({state:'finalizing',copied:0});
  await mover.materializeAuthority('move-ready-gap');
  await drainHistory(mover,'move-ready-gap');
  expect(await mover.verifyPage('move-ready-gap',1)).toMatchObject({state:'verified',verified:1});
  const route=await mover.commit('move-ready-gap');
  expect(route).toMatchObject({shardId:'b',generation:2});
  expect(await destination().prepare('SELECT id FROM telemetry_v11_chunks WHERE participant_id=?')
   .bind(fixture.participantId).first('id')).toBe(original.result.contributionId);
  expect(await destination().prepare(`SELECT origin.source_namespace FROM typed_v11_chunk_allocations allocation
   JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=allocation.namespace_id
   WHERE allocation.chunk_id=?`).bind(original.result.contributionId).first('source_namespace')).toBe(NAMESPACE_A);
  expect(await destination().prepare(`SELECT authorization.id,authorization.state,authorization.consumed_contribution_id
   FROM device_upload_authorizations authorization JOIN telemetry_v11_chunks chunk
    ON chunk.device_upload_authorization_id=authorization.id WHERE chunk.id=?`)
   .bind(original.result.contributionId).first()).toEqual(await source().prepare(`SELECT authorization.id,
    authorization.state,authorization.consumed_contribution_id FROM device_upload_authorizations authorization
    JOIN telemetry_v11_chunks chunk ON chunk.device_upload_authorization_id=authorization.id WHERE chunk.id=?`)
   .bind(original.result.contributionId).first());
  expect(await destination().prepare(`SELECT manifest.id,manifest.manifest_digest,manifest.manifest_json,manifest.state,
   chunk.chunk_id,chunk.chunk_digest,record.occurrence_id,record.record_json
   FROM telemetry_v11_day_manifests manifest JOIN telemetry_v11_chunks chunk ON chunk.manifest_id=manifest.id
   JOIN telemetry_v11_records record ON record.chunk_id=chunk.id WHERE chunk.id=?`)
   .bind(original.result.contributionId).first()).toEqual(await source().prepare(`SELECT manifest.id,
    manifest.manifest_digest,manifest.manifest_json,manifest.state,chunk.chunk_id,chunk.chunk_digest,
    record.occurrence_id,record.record_json FROM telemetry_v11_day_manifests manifest
    JOIN telemetry_v11_chunks chunk ON chunk.manifest_id=manifest.id
    JOIN telemetry_v11_records record ON record.chunk_id=chunk.id WHERE chunk.id=?`)
   .bind(original.result.contributionId).first());
  expect(await destination().prepare('SELECT count(*) n FROM typed_v11_record_admissions WHERE chunk_id=?')
   .bind(original.result.contributionId).first('n')).toBe(1);
  expect(await persistTypedV11StagedChunk(destination(),original.principal,original.prepared.chunks[0],
   {...original.metadata,sourceNamespace:NAMESPACE_B},NOW,route)).toMatchObject({replay:true,contributionId:original.result.contributionId});
  await insertTyped(fixture,route,NAMESPACE_B,'2026-09-14',2);
  const origins=await destination().prepare(`SELECT origin.source_namespace,count(*) n FROM typed_telemetry_records record
   JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=record.namespace_id
   GROUP BY origin.source_namespace ORDER BY origin.source_namespace`).all<{source_namespace:string;n:number}>();
  expect(origins.results).toEqual([{source_namespace:NAMESPACE_A,n:1},{source_namespace:NAMESPACE_B,n:1}]);
  await expect(mover.prepare('move-retained-origin-again',route,'a',NAMESPACE_B))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await catalog().prepare("SELECT count(*) n FROM storage_owner_move_preparations WHERE move_id='move-retained-origin-again'")
   .first('n')).toBe(0);
  await revokeAccountlessEnrollment(destination(),fixture.deviceId,'security_reset');
  const revokedReplay=await handleRequest(new Request('https://example.test/api/v1/accountless/ownership',{method:'POST',
   headers:{origin:'https://example.test',authorization:fixture.header,'content-type':'application/json'},body:JSON.stringify(ownerBody())}),runtime());
  expect(revokedReplay.status).toBe(401);
 });

 it('reconciles a lost pre-copy acknowledgement without duplicate evidence or capacity reservation',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',1);
  const unreliable=movement({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:loseStagingAcknowledgement(destination())});
  await unreliable.prepare('move-lost-ack',fixture.route,'b',NAMESPACE_A);
  await expect(unreliable.copyPage('move-lost-ack',1)).rejects.toThrow('synthetic lost destination acknowledgement');
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records').first('n')).toBe(1);
  expect(await movement().copyPage('move-lost-ack',1)).toMatchObject({state:'ready',copied:1});
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records').first('n')).toBe(1);
  expect(await destination().prepare('SELECT count(*) n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it('reconciles a lost authority-copy acknowledgement before the verified switch',async()=>{
  const fixture=await ownerFixture();
  const unreliable=movement({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:loseAuthorityAcknowledgement(destination())});
  await unreliable.prepare('move-authority-lost-ack',fixture.route,'b',NAMESPACE_A);
  await unreliable.copyPage('move-authority-lost-ack',1);await unreliable.fenceSource('move-authority-lost-ack');
  await unreliable.copyPage('move-authority-lost-ack',1);
  await expect(unreliable.materializeAuthority('move-authority-lost-ack')).rejects.toThrow('synthetic lost authority acknowledgement');
  expect(await destination().prepare('SELECT count(*) n FROM participants WHERE id=?').bind(fixture.participantId).first('n')).toBe(1);
  const mover=movement();await mover.materializeAuthority('move-authority-lost-ack');
  expect(await mover.verifyPage('move-authority-lost-ack',1)).toMatchObject({state:'verified'});
  expect(await mover.commit('move-authority-lost-ack')).toMatchObject({shardId:'b',generation:2});
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_authority_seeds WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(1);
 });

 it('resumes an exact history import after the raw chunk acknowledgement is lost',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',7);
  const mover=movement();await mover.prepare('move-history-lost-ack',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-history-lost-ack',1);await mover.fenceSource('move-history-lost-ack');
  await mover.copyPage('move-history-lost-ack',1);await mover.materializeAuthority('move-history-lost-ack');
  await mover.materializeHistoryPage('move-history-lost-ack');
  await mover.materializeHistoryPage('move-history-lost-ack');
  const unreliable=movement({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:loseHistoryAcknowledgement(destination())});
  await expect(unreliable.materializeHistoryPage('move-history-lost-ack')).rejects.toThrow('synthetic lost history acknowledgement');
  expect(await destination().prepare('SELECT count(*) n FROM storage_write_capacity_reservations').first<number>('n')).toBeGreaterThan(0);
  expect(await destination().prepare("SELECT chunk_phase FROM storage_owner_move_history_imports WHERE move_id='move-history-lost-ack'")
   .first('chunk_phase')).toBe('raw');
  for(let step=0;step<32;step++){
   await mover.resumeFinalization('move-history-lost-ack');
   if(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-history-lost-ack'").first('state')==='committed')break;
  }
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-history-lost-ack'").first('state')).toBe('committed');
  expect(await destination().prepare('SELECT count(*) n FROM telemetry_v11_chunks WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(1);
  expect(await destination().prepare('SELECT count(*) n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it('refuses a history growth unit at the physical cap without partially copying it',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',13);
  const mover=movement();await mover.prepare('move-history-capacity',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-history-capacity',1);await mover.fenceSource('move-history-capacity');
  await mover.copyPage('move-history-capacity',1);await mover.materializeAuthority('move-history-capacity');
  const blocked=movement({STORAGE_INGESTION_A:source(),
   STORAGE_INGESTION_B:observedPhysicalSize(destination(),STORAGE_OPERATING_BUDGET_BYTES)});
  await expect(blocked.materializeHistoryPage('move-history-capacity'))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await destination().prepare('SELECT count(*) n FROM telemetry_v11_day_manifests WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(0);
  expect(await destination().prepare("SELECT current_manifest_id FROM storage_owner_move_history_imports WHERE move_id='move-history-capacity'")
   .first('current_manifest_id')).toBeNull();
 });

 it('reconciles a lost final route-switch acknowledgement from its durable fenced state',async()=>{
  const fixture=await ownerFixture();const mover=movement();
  await mover.prepare('move-switch-lost-ack',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-switch-lost-ack',1);await mover.fenceSource('move-switch-lost-ack');
  await mover.copyPage('move-switch-lost-ack',1);await mover.materializeAuthority('move-switch-lost-ack');
  await mover.verifyPage('move-switch-lost-ack',1);
  const unreliable=movement(bindings(),loseRouteSwitchAcknowledgement(catalog()));
  await expect(unreliable.commit('move-switch-lost-ack')).rejects.toThrow();
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-switch-lost-ack'")
   .first('state')).toBe('verified');
  expect(await catalog().prepare('SELECT shard_id FROM storage_owner_routes WHERE owner_id=?')
   .bind(fixture.ownerId).first('shard_id')).toBe('b');
  await expect(mover.resumeFinalization('move-switch-lost-ack')).resolves.toMatchObject({shardId:'b',generation:2});
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-switch-lost-ack'")
   .first('state')).toBe('committed');
  expect(await destination().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
   .bind(fixture.ownerId).first('state')).toBe('active');
 });

 it('refuses a conflicting destination manifest and keeps the source fenced for deterministic repair',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',8);
  const mover=movement();await mover.prepare('move-history-conflict',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-history-conflict',1);await mover.fenceSource('move-history-conflict');
  await mover.copyPage('move-history-conflict',1);await mover.materializeAuthority('move-history-conflict');
  const manifest=await source().prepare('SELECT * FROM telemetry_v11_day_manifests WHERE participant_id=?')
   .bind(fixture.participantId).first<Record<string,unknown>>();
  await destination().prepare(`INSERT INTO telemetry_v11_day_manifests(id,participant_id,device_id,chunk_day,
   manifest_digest,parser_version,manifest_json,expected_chunk_count,state,created_at,ready_at)
   VALUES(?,?,?,?,?,?,?,?, 'staged',?,NULL)`).bind(manifest!.id as string,manifest!.participant_id as string,
    manifest!.device_id as string,manifest!.chunk_day as string,'f'.repeat(64),manifest!.parser_version as string,
    manifest!.manifest_json as string,manifest!.expected_chunk_count as number,manifest!.created_at as string).run();
  await expect(mover.materializeHistoryPage('move-history-conflict')).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  for(let attempt=0;attempt<12;attempt++){
   try{await mover.resumeFinalization('move-history-conflict');}catch{ /* retained conflict must remain resumable but blocked */ }
  }
  expect(await destination().prepare("SELECT state,current_manifest_id FROM storage_owner_move_history_imports WHERE move_id='move-history-conflict'")
   .first()).toEqual({state:'manifests',current_manifest_id:manifest!.id});
  expect(await source().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?').bind(fixture.ownerId).first('state')).toBe('fenced');
 });

 it('refuses a missing source chunk without marking its fenced history complete',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',11);
  const mover=movement();await mover.prepare('move-history-missing',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-history-missing',1);await mover.fenceSource('move-history-missing');
  await mover.copyPage('move-history-missing',1);await mover.materializeAuthority('move-history-missing');
  await mover.materializeHistoryPage('move-history-missing');
  await source().prepare('DELETE FROM telemetry_v11_chunks WHERE participant_id=?').bind(fixture.participantId).run();
  await expect(mover.materializeHistoryPage('move-history-missing')).rejects.toThrow();
  expect(await destination().prepare("SELECT state FROM storage_owner_move_history_imports WHERE move_id='move-history-missing'")
   .first('state')).toBe('manifests');
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-history-missing'")
   .first('state')).toBe('finalizing');
 });

 it('refuses a revoked accountless authority before reserving the destination',async()=>{
  const fixture=await ownerFixture();
  await revokeAccountlessEnrollment(source(),fixture.deviceId,'security_reset');
  const reserved=await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes');
  await expect(movement().prepare('move-revoked',fixture.route,'b',NAMESPACE_A))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(reserved);
 });

 it('refuses a previously qualified destination missing the complete movement schema before reserving it',async()=>{
  const fixture=await ownerFixture();
  const reserved=await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes');
  await destination().prepare('DROP TABLE storage_owner_move_history_contract').run();
  await expect(movement().prepare('move-stale-readiness',fixture.route,'b',NAMESPACE_A)).rejects.toThrow();
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(reserved);
  expect(await catalog().prepare("SELECT 1 FROM storage_owner_move_preparations WHERE move_id='move-stale-readiness'").first()).toBeNull();
  expect(await destination().prepare("SELECT 1 FROM storage_owner_move_copy_controls WHERE move_id='move-stale-readiness'").first()).toBeNull();
 });

 it('finishes from the fenced authority snapshot after its credential lease expires',async()=>{
  const fixture=await ownerFixture(),today=new Date(NOW).toISOString().slice(0,10);
  const day=await insertTyped(fixture,fixture.route,NAMESPACE_A,today,12);
  const predecessor=await createTelemetryV11DomainPredecessor(source(),day.principal,NOW,fixture.route);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:day.staged.day,throughDay:day.staged.day,
   predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
    legacyFingerprint:predecessor.legacyFingerprint},
   days:[{day:day.staged.day,manifestId:day.staged.manifestId,manifestDigest:day.staged.manifestDigest}],
   manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(),day.principal,manifest,NOW,fixture.route);
  let now=NOW;const mover=movement(bindings(),catalog(),()=>now);
  await mover.prepare('move-expired-after-fence',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-expired-after-fence',1);
  await mover.fenceSource('move-expired-after-fence');
  now=Date.parse(fixture.expiresAt)+1;
  await mover.copyPage('move-expired-after-fence',1);
  await mover.materializeAuthority('move-expired-after-fence');
  await drainHistory(mover,'move-expired-after-fence');
  await mover.verifyPage('move-expired-after-fence',1);
  await expect(mover.commit('move-expired-after-fence')).resolves.toMatchObject({shardId:'b',generation:2});
  expect(await destination().prepare('SELECT state FROM participants WHERE id=?').bind(fixture.participantId).first('state')).toBe('active');
 });

 it('does not fence an owner that expires while catalog fencing is awaiting its source mutation',async()=>{
  const fixture=await ownerFixture();let now=NOW;const mover=movement(bindings(),catalog(),()=>now);
  await mover.prepare('move-expired-before-source-fence',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-expired-before-source-fence',1);
  await catalog().prepare(`UPDATE storage_owner_move_preparations SET state='fencing',updated_at=?
   WHERE move_id='move-expired-before-source-fence' AND state='ready'`).bind(now).run();
  now=Date.parse(fixture.expiresAt)+1;
  await expect(mover.fenceSource('move-expired-before-source-fence'))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await source().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
   .bind(fixture.ownerId).first('state')).toBe('active');
 expect(await destination().prepare("SELECT 1 FROM storage_owner_move_authority_seeds WHERE move_id='move-expired-before-source-fence'")
   .first()).toBeNull();
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-expired-before-source-fence'")
   .first('state')).toBe('ready');
 });

 it('atomically refuses a revocation that wins immediately before the source fence',async()=>{
  const fixture=await ownerFixture(),raced=revokeBeforeMoveFence(source(),fixture.deviceId,fixture.route);
  const mover=movement({STORAGE_INGESTION_A:raced,STORAGE_INGESTION_B:destination()});
  await mover.prepare('move-revoked-at-source-fence',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-revoked-at-source-fence',1);
  await expect(mover.fenceSource('move-revoked-at-source-fence'))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await source().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
   .bind(fixture.ownerId).first('state')).toBe('active');
  expect(await source().prepare('SELECT state FROM accountless_enrollment_ledger WHERE device_id=?')
   .bind(fixture.deviceId).first('state')).toBe('revoked');
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-revoked-at-source-fence'")
   .first('state')).toBe('ready');
  expect(await catalog().prepare("SELECT 1 FROM storage_owner_moves WHERE move_id='move-revoked-at-source-fence'").first()).toBeNull();
  expect(await destination().prepare("SELECT 1 FROM storage_owner_move_authority_seeds WHERE move_id='move-revoked-at-source-fence'")
   .first()).toBeNull();
 await expect(mover.rollbackPage('move-revoked-at-source-fence',1)).resolves.toEqual({state:'abandoned',deleted:0});
 });

 it('atomically refuses a route-guarded legacy v1 write that wins immediately before the source fence',async()=>{
  const fixture=await ownerFixture(),write=await preparedLegacyV1Write(fixture);
  const mover=movement({STORAGE_INGESTION_A:writeV1BeforeMoveFence(source(),write),STORAGE_INGESTION_B:destination()});
  await mover.prepare('move-v1-at-source-fence',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-v1-at-source-fence',1);
  await expect(mover.fenceSource('move-v1-at-source-fence'))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v1_chunks WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(1);
  expect(await source().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
   .bind(fixture.ownerId).first('state')).toBe('active');
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-v1-at-source-fence'")
   .first('state')).toBe('ready');
  expect(await catalog().prepare("SELECT 1 FROM storage_owner_moves WHERE move_id='move-v1-at-source-fence'").first()).toBeNull();
 });

 it('reconciles a lost atomic source-fence acknowledgement from the owned preparation',async()=>{
  const fixture=await ownerFixture(),unreliable=movement({
   STORAGE_INGESTION_A:loseAtomicMoveFenceAcknowledgement(source()),STORAGE_INGESTION_B:destination(),
  });
  await unreliable.prepare('move-source-fence-lost-ack',fixture.route,'b',NAMESPACE_A);
  await unreliable.copyPage('move-source-fence-lost-ack',1);
  await expect(unreliable.fenceSource('move-source-fence-lost-ack'))
   .rejects.toThrow('synthetic lost atomic fence acknowledgement');
  expect(await source().prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
   .bind(fixture.ownerId).first('state')).toBe('fenced');
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-source-fence-lost-ack'")
   .first('state')).toBe('fencing');
  expect(await catalog().prepare("SELECT 1 FROM storage_owner_moves WHERE move_id='move-source-fence-lost-ack'").first()).toBeNull();
  await expect(movement().fenceSource('move-source-fence-lost-ack'))
   .resolves.toMatchObject({state:'finalizing',final_high_water:0});
  expect(await catalog().prepare("SELECT state FROM storage_owner_moves WHERE move_id='move-source-fence-lost-ack'")
   .first('state')).toBe('source_fenced');
 });

 it('allows an untouched pre-copy to abort and releases only its destination reservation',async()=>{
  const fixture=await ownerFixture(),before=await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes');
  await movement().prepare('move-abort',fixture.route,'b',NAMESPACE_A);
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(Number(before)+RESERVATION);
  expect((await movement().abortBeforeCopy('move-abort')).state).toBe('abandoned');
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(before);
  expect((await router().resolve(fixture.ownerId))?.shardId).toBe('a');
 });

 it('rolls back copied private rows in bounded pages before releasing destination capacity',async()=>{
  const fixture=await ownerFixture();
  await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-12',1);
  await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',2);
  const before=await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first<number>('reserved_bytes');
  const mover=movement();await mover.prepare('move-rollback',fixture.route,'b',NAMESPACE_A);
  expect(await mover.copyPage('move-rollback',2)).toMatchObject({state:'ready',copied:2});
  expect(await mover.rollbackPage('move-rollback',1)).toEqual({state:'abandoning',deleted:1});
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes'))
   .toBe(before!+RESERVATION);
  await expect(mover.copyPage('move-rollback',1)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await mover.rollbackPage('move-rollback',1)).toEqual({state:'abandoned',deleted:1});
  expect(await destination().prepare("SELECT state FROM storage_owner_move_copy_controls WHERE move_id='move-rollback'").first('state'))
   .toBe('closed');
  expect(await destination().prepare("SELECT count(*) n FROM storage_owner_move_staged_records WHERE move_id='move-rollback'").first('n')).toBe(0);
  expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(before);
  expect((await router().resolve(fixture.ownerId))?.shardId).toBe('a');
 });

 it('moves an activated domain head and permits one exact destination successor',async()=>{
  const fixture=await ownerFixture(),today=new Date(NOW).toISOString().slice(0,10);
  const day=await insertTyped(fixture,fixture.route,NAMESPACE_A,today,1);
  const predecessor=await createTelemetryV11DomainPredecessor(source(),day.principal,NOW,fixture.route);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:day.staged.day,throughDay:day.staged.day,
   predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
    legacyFingerprint:predecessor.legacyFingerprint},
   days:[{day:day.staged.day,manifestId:day.staged.manifestId,manifestDigest:day.staged.manifestDigest}],
   manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(),day.principal,manifest,NOW,fixture.route);
  const secondDay=new Date(NOW+86_400_000).toISOString().slice(0,10);
  const second=await insertTyped(fixture,fixture.route,NAMESPACE_A,secondDay,2);
  const secondPredecessor=await createTelemetryV11DomainPredecessor(source(),second.principal,NOW,fixture.route);
  const secondManifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:day.staged.day,throughDay:second.staged.day,
   predecessor:{token:secondPredecessor.token,previousGenerationId:secondPredecessor.previousGenerationId,
    legacyFingerprint:secondPredecessor.legacyFingerprint},days:[{day:day.staged.day,manifestId:day.staged.manifestId,
    manifestDigest:day.staged.manifestDigest},{day:second.staged.day,manifestId:second.staged.manifestId,
    manifestDigest:second.staged.manifestDigest}],manifestDigest:'0'.repeat(64)};
  secondManifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(secondManifest));
  await activateTelemetryV11Domain(source(),second.principal,secondManifest,NOW,fixture.route);
  const sourceHead=await source().prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?')
   .bind(fixture.participantId).first<Record<string,unknown>>();
  const mover=movement();await mover.prepare('move-active-domain',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-active-domain',2);await mover.fenceSource('move-active-domain');
  await mover.copyPage('move-active-domain',2);await mover.materializeAuthority('move-active-domain');
  await drainHistory(mover,'move-active-domain');await mover.verifyPage('move-active-domain',2);
  const destinationRoute=await mover.commit('move-active-domain');
  expect(await destination().prepare('SELECT * FROM telemetry_v11_domain_heads WHERE participant_id=?')
   .bind(fixture.participantId).first()).toEqual(sourceHead);
  expect(await source().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n')).toBe(2);
  expect(await destination().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n')).toBe(2);
  expect((await destination().prepare('SELECT event_digest FROM storage_ingestion_changes ORDER BY revision')
   .all<{event_digest:string}>()).results).toEqual((await source().prepare(
    'SELECT event_digest FROM storage_ingestion_changes ORDER BY revision').all<{event_digest:string}>()).results);
  for(let pass=0;pass<8;pass++){
   await runStorageAnalyticsPass({source:destination(),target:b().STORAGE_ANALYTICS_B,sourceId:'source-b',
    sourceNamespace:NAMESPACE_B,maxSteps:32,maxQueries:900,publishCommunity:false});
   if(await b().STORAGE_ANALYTICS_B.prepare('SELECT 1 FROM analytics_v11_owner_heads WHERE owner_digest=?')
    .bind((await destination().prepare('SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?')
     .bind(fixture.participantId).first<string>('owner_digest'))!).first())break;
  }
  expect(await b().STORAGE_ANALYTICS_B.prepare('SELECT count(*) n FROM analytics_v11_owner_heads').first('n')).toBe(1);
  expect(await b().STORAGE_ANALYTICS_B.prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(2);
  expect(await b().STORAGE_ANALYTICS_B.prepare('SELECT count(DISTINCT event_digest) n FROM analytics_applied_events')
   .first('n')).toBe(2);
  const nextDay=new Date(NOW+2*86_400_000).toISOString().slice(0,10);
  const next=await insertTyped(fixture,destinationRoute,NAMESPACE_B,nextDay,3);
  const nextPredecessor=await createTelemetryV11DomainPredecessor(destination(),next.principal,NOW,destinationRoute);
  const nextManifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:day.staged.day,
   throughDay:next.staged.day,predecessor:{token:nextPredecessor.token,previousGenerationId:nextPredecessor.previousGenerationId,
    legacyFingerprint:nextPredecessor.legacyFingerprint},days:[{day:day.staged.day,manifestId:day.staged.manifestId,
    manifestDigest:day.staged.manifestDigest},{day:second.staged.day,manifestId:second.staged.manifestId,
    manifestDigest:second.staged.manifestDigest},{day:next.staged.day,manifestId:next.staged.manifestId,
    manifestDigest:next.staged.manifestDigest}],manifestDigest:'0'.repeat(64)};
  nextManifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(nextManifest));
  await activateTelemetryV11Domain(destination(),next.principal,nextManifest,NOW,destinationRoute);
  expect(await destination().prepare('SELECT revision FROM telemetry_v11_domain_heads WHERE participant_id=?')
   .bind(fixture.participantId).first('revision')).toBe(Number(sourceHead!.revision)+1);
  const sourceOwner=await source().prepare(`SELECT owner_digest,revision FROM storage_v11_owner_links link
   JOIN storage_owner_revisions revision USING(owner_digest) WHERE participant_id=?`).bind(fixture.participantId)
   .first<{owner_digest:string;revision:number}>();
  const destinationOwner=await destination().prepare(`SELECT owner_digest,revision FROM storage_v11_owner_links link
   JOIN storage_owner_revisions revision USING(owner_digest) WHERE participant_id=?`).bind(fixture.participantId)
   .first<{owner_digest:string;revision:number}>();
  expect(destinationOwner).toEqual({owner_digest:sourceOwner!.owner_digest,revision:sourceOwner!.revision+1});
  expect(await destination().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n')).toBe(3);
  await revokeAccountlessEnrollment(destination(),fixture.deviceId,'security_reset');
  expect(await destination().prepare('SELECT state FROM storage_v11_owner_links WHERE participant_id=?')
   .bind(fixture.participantId).first('state')).toBe('withdrawn');
  expect(await destination().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n')).toBe(4);
 });

 it('includes an in-progress destination in exact owner erasure and removes its private copied rows',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',1);
  await registerParticipantOwnerRoute(runtime(),fixture.participantId,fixture.route);
  await movement().prepare('move-erased',fixture.route,'b',NAMESPACE_A);
  await movement().copyPage('move-erased',1);
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records').first('n')).toBe(1);
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-owner-admin',fixture.participantId)).resolves.toMatchObject({deleted:true});
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_staged_records').first('n')).toBe(0);
  expect(await source().prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first()).toBeNull();
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-erased'").first('state')).toBe('abandoned');
  await expect(movement().fenceSource('move-erased')).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 });

 it('closes the destination copy gate before erasure so a stale loaded page cannot reappear',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',1);
  await registerParticipantOwnerRoute(runtime(),fixture.participantId,fixture.route);
  const paused=pauseStaging(destination());
  const stale=movement({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:paused.database});
  await stale.prepare('move-erasure-race',fixture.route,'b',NAMESPACE_A);
  const copy=stale.copyPage('move-erasure-race',1);
  const refused=expect(copy).rejects.toThrow();
  await paused.reached;
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-owner-admin',fixture.participantId)).resolves.toMatchObject({deleted:true});
  paused.release();await refused;
  expect(await destination().prepare("SELECT count(*) n FROM storage_owner_move_staged_records WHERE move_id='move-erasure-race'").first('n')).toBe(0);
  expect(await destination().prepare("SELECT state FROM storage_owner_move_copy_controls WHERE move_id='move-erasure-race'").first('state')).toBeNull();
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-erasure-race'").first('state')).toBe('abandoned');
 });

 it('reconciles a lost move-control erasure acknowledgement without restoring the raw owner locator',async()=>{
  const fixture=await ownerFixture();await registerParticipantOwnerRoute(runtime(),fixture.participantId,fixture.route);
  const mover=movement();await mover.prepare('move-erasure-lost-ack',fixture.route,'b',NAMESPACE_A);
  await mover.copyPage('move-erasure-lost-ack',1);
  const unreliable={...runtime(),STORAGE_INGESTION_B:loseMoveErasureAcknowledgement(destination())} as unknown as Env;
  await expect(eraseParticipantAsOwner(unreliable,'synthetic-owner-admin',fixture.participantId))
   .rejects.toThrow('synthetic lost move erasure acknowledgement');
  expect(await destination().prepare("SELECT 1 FROM storage_owner_move_copy_controls WHERE move_id='move-erasure-lost-ack'").first()).toBeNull();
  expect(await destination().prepare("SELECT completed FROM storage_owner_move_erasure_receipts WHERE move_id='move-erasure-lost-ack'")
   .first('completed')).toBe(1);
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-erasure-lost-ack'")
   .first('state')).toBe('abandoning');
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-owner-admin',fixture.participantId))
   .resolves.toMatchObject({deleted:true});
  expect(await catalog().prepare("SELECT state FROM storage_owner_move_preparations WHERE move_id='move-erasure-lost-ack'")
   .first('state')).toBe('abandoned');
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_copy_controls WHERE owner_id=?')
   .bind(fixture.ownerId).first('n')).toBe(0);
 });

 it('erases canonical history from both the retained source and current destination after a move',async()=>{
  const fixture=await ownerFixture();await insertTyped(fixture,fixture.route,NAMESPACE_A,'2026-09-13',10);
  await registerParticipantOwnerRoute(runtime(),fixture.participantId,fixture.route);
  const mover=movement();await mover.prepare('move-then-erasure',fixture.route,'b',NAMESPACE_A);
  expect(await mover.copyPage('move-then-erasure',1)).toMatchObject({state:'ready',copied:1});
  await mover.fenceSource('move-then-erasure');
  expect(await mover.copyPage('move-then-erasure',1)).toMatchObject({state:'finalizing',copied:0});
  await mover.materializeAuthority('move-then-erasure');
  await drainHistory(mover,'move-then-erasure');
  expect(await mover.verifyPage('move-then-erasure',1)).toMatchObject({state:'verified',verified:1});
  expect(await mover.commit('move-then-erasure')).toMatchObject({shardId:'b',generation:2});
  expect(await source().prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first()).not.toBeNull();
  expect(await destination().prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first()).not.toBeNull();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-owner-admin',fixture.participantId)).resolves.toMatchObject({deleted:true});
  expect(await source().prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first()).toBeNull();
  expect(await destination().prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first()).toBeNull();
  expect(await destination().prepare('SELECT count(*) n FROM telemetry_v11_chunks WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(0);
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_history_imports WHERE participant_id=?')
   .bind(fixture.participantId).first('n')).toBe(0);
  expect(await destination().prepare('SELECT count(*) n FROM storage_owner_move_copy_controls WHERE owner_id=?')
   .bind(fixture.ownerId).first('n')).toBe(0);
 });
});
