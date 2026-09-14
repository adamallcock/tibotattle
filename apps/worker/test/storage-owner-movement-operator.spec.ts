import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS, ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION, ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS } from '../src/accountless-enrollment';
import { ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS, ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION, ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  createAccountlessUploadOwner } from '../src/accountless-ownership';
import { encodeBase64Url, sha256Hex } from '../src/crypto';
import { deviceAuthorizationCapabilityHash, deviceHash } from '../src/device-auth';
import { initializeStorageSource } from '../src/analytics-delivery';
import { configureStorageShardAllocation, recordStorageCapacityObservation } from '../src/storage-capacity';
import { createAccountlessV11OwnerMovement } from '../src/storage-owner-movement';
import { createCatalogStorageRouter } from '../src/storage-routing';
import { initializeTypedV11Admission } from '../src/typed-v11-admission';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { createStorageOwnerMovementWorker, readStorageOwnerMovementRuntimeStatus }
  from '../scripts/storage-owner-movement-runtime.mjs';
import { qualifyStorageShardForTest } from './helpers/storage-shard-readiness';

interface Bindings extends Env {
  STORAGE_ROUTING_DB:D1Database; STORAGE_INGESTION_A:D1Database; STORAGE_INGESTION_B:D1Database;
  TEST_MIGRATIONS:D1Migration[]; TEST_ROUTING_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
}
const b=()=>env as Bindings, catalog=()=>b().STORAGE_ROUTING_DB, source=()=>b().STORAGE_INGESTION_A;
const destination=()=>b().STORAGE_INGESTION_B, NOW=Date.now(), RESERVATION=16_777_216;
const NAMESPACE_A='synthetic-operator-origin-a',NAMESPACE_B='synthetic-operator-origin-b';
const shardBindings=()=>({STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:destination()});
const router=()=>createCatalogStorageRouter({catalog:catalog(),bindings:shardBindings(),clock:()=>NOW});

async function qualify(shardId:'a'|'b',bindingName:'STORAGE_INGESTION_A'|'STORAGE_INGESTION_B'){
 await recordStorageCapacityObservation(catalog(),{shardId,observedBytes:1_000,observedAt:NOW-1_000,
  validUntil:NOW+60_000,pressureState:'normal'});
 const receipt=await qualifyStorageShardForTest(catalog(),{shardId,bindingName,qualifiedAt:NOW-1_000});
 await configureStorageShardAllocation(catalog(),{shardId,allocationTier:'active',allocationEnabled:true,
  qualificationDigest:receipt.readinessDigest,updatedAt:NOW-1_000});
}

async function ownerFixture(){
 const ownerId=`accountless:${crypto.randomUUID()}`,deviceId=crypto.randomUUID();
 const secret=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),header=`Device um_device_${deviceId}.${secret}`;
 const route=await router().ensureOwner(ownerId,'a',RESERVATION),secretHash=await deviceHash(deviceId,secret);
 const issuedAt=new Date(NOW-24*86_400_000).toISOString();
 const expiresAt=new Date(NOW-24*86_400_000+ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS).toISOString();
 await router().write(route,db=>[db.prepare(`INSERT INTO accountless_enrollment_ledger(
  device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
  state,issued_at,expires_at) VALUES(?,?,?,?,?,?,'active',?,?)`).bind(deviceId,secretHash.buffer,ownerId,
   ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
   ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,issuedAt,expiresAt)]);
 const created=await createAccountlessUploadOwner(source(),header,{schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION},NOW,route);
 await router().registerCapability(await deviceAuthorizationCapabilityHash(header),route);
 return {ownerId,participantId:created.participantId,route};
}

beforeEach(async()=>{
 await reset();await applyD1Migrations(catalog(),b().TEST_ROUTING_MIGRATIONS);
 for(const [database,namespace,sourceId] of [[source(),NAMESPACE_A,'source-a'],[destination(),NAMESPACE_B,'source-b']] as const){
  await applyD1Migrations(database,b().TEST_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(database,sourceId);
  await applyD1Migrations(database,b().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(database,b().TEST_INGESTION_ROUTING_MIGRATIONS);
  await initializeTypedV11Admission(database,namespace);await initializeTypedV1Admission(database,namespace);
 }
 await catalog().batch([
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('a','STORAGE_INGESTION_A','active')"),
  catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('b','STORAGE_INGESTION_B','active')"),
 ]);
 await qualify('a','STORAGE_INGESTION_A');await qualify('b','STORAGE_INGESTION_B');
});

describe('private owner movement operator runtime',()=>{
 it('executes one bounded primitive per delivery and completes a real two-D1 route switch',async()=>{
  const fixture=await ownerFixture(),moveId='operator-move-one';
  const runtimePlan={schema:'storage-owner-movement-runtime-v1',operationDigest:'a'.repeat(64),moveId,
   ownerDigest:await sha256Hex(`app-usagemonitor/storage-owner-movement-owner/v1\0${fixture.ownerId}`),
   sourceRoute:fixture.route,destinationShardId:'b',sourceNamespace:NAMESPACE_A,
   catalogBinding:'STORAGE_ROUTING_DB',sourceBinding:'STORAGE_INGESTION_A',
   destinationBinding:'STORAGE_INGESTION_B',pageSize:1,expiresAt:NOW+60_000} as const;
  const worker=createStorageOwnerMovementWorker({createMovement:createAccountlessV11OwnerMovement,
   plan:runtimePlan,clock:()=>NOW});
  const runtimeEnv={STORAGE_OWNER_MOVEMENT_MODE:'enabled',
   STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST:runtimePlan.operationDigest,STORAGE_ROUTING_DB:catalog(),
   STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:destination()};
  let sequence=0;
  const deliver=async(action:'prepare'|'copy'|'fence'|'resume'|'abort')=>{
   let acknowledgements=0;await worker.queue({messages:[{body:{schema:'storage-owner-movement-wakeup-v1',
    operationDigest:runtimePlan.operationDigest,action,sequence:++sequence},ack(){acknowledgements++;}}]},runtimeEnv);
   expect(acknowledgements).toBe(1);return readStorageOwnerMovementRuntimeStatus(runtimeEnv,runtimePlan);
  };
  expect((await deliver('prepare')).state).toBe('copying');
  expect((await deliver('copy')).state).toBe('ready');
  expect((await deliver('fence')).state).toBe('finalizing');
  expect((await deliver('resume')).authorityDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await deliver('resume')).state).toBe('verified');
  const committed=await deliver('resume');expect(committed.state).toBe('committed');
  expect(committed).toMatchObject({destinationGeneration:2,reservationBytes:RESERVATION,
   sourceNamespace:NAMESPACE_A,materializedCursor:committed.finalHighWater,
   verifyCursor:committed.finalHighWater,copyControl:'closed',stagedInvalidCount:0});
  expect(committed.verifyChainDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(committed.history).toMatchObject({ownerId:fixture.ownerId,sourceNamespace:NAMESPACE_A,
   state:'complete'});expect(committed.history?.completedDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(committed.authority).toMatchObject({ownerId:fixture.ownerId,state:'materialized',
   authorityDigest:committed.authorityDigest});
  expect(committed.move).toEqual({moveId,ownerId:fixture.ownerId,sourceShardId:'a',destinationShardId:'b',
   sourceGeneration:1,destinationGeneration:2,reservationBytes:RESERVATION,state:'committed',
   copyDigest:committed.copyDigest});
  expect(committed.route).toEqual({shardId:'b',bindingName:'STORAGE_INGESTION_B',generation:2});
  expect(committed.sourceFence).toMatchObject({state:'fenced',moveId});
  expect(committed.destinationFence).toMatchObject({state:'active',moveId});
  expect(await destination().prepare('SELECT id FROM participants WHERE id=?')
   .bind(fixture.participantId).first('id')).toBe(fixture.participantId);
  expect((await worker.fetch()).status).toBe(404);
 });

 it('replays an acknowledged primitive exactly and refuses extra message fields',async()=>{
  const fixture=await ownerFixture(),moveId='operator-move-replay';
  const runtimePlan={schema:'storage-owner-movement-runtime-v1',operationDigest:'b'.repeat(64),moveId,
   ownerDigest:await sha256Hex(`app-usagemonitor/storage-owner-movement-owner/v1\0${fixture.ownerId}`),
   sourceRoute:fixture.route,destinationShardId:'b',sourceNamespace:NAMESPACE_A,
   catalogBinding:'STORAGE_ROUTING_DB',sourceBinding:'STORAGE_INGESTION_A',
   destinationBinding:'STORAGE_INGESTION_B',pageSize:1,expiresAt:NOW+60_000} as const;
  const worker=createStorageOwnerMovementWorker({createMovement:createAccountlessV11OwnerMovement,
   plan:runtimePlan,clock:()=>NOW}),runtimeEnv={STORAGE_OWNER_MOVEMENT_MODE:'enabled',
    STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST:runtimePlan.operationDigest,STORAGE_ROUTING_DB:catalog(),
    STORAGE_INGESTION_A:source(),STORAGE_INGESTION_B:destination()};
  const message={schema:'storage-owner-movement-wakeup-v1',operationDigest:runtimePlan.operationDigest,
   action:'prepare',sequence:1} as const;
  await worker.queue({messages:[{body:message,ack(){}}]},runtimeEnv);
  await worker.queue({messages:[{body:message,ack(){}}]},runtimeEnv);
  expect(await catalog().prepare('SELECT count(*) AS n FROM storage_owner_move_preparations WHERE move_id=?')
   .bind(moveId).first('n')).toBe(1);
  await expect(worker.queue({messages:[{body:{...message,ownerId:fixture.ownerId},ack(){}}]},runtimeEnv))
   .rejects.toThrow('MESSAGE_INVALID');
 });

});
