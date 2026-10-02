import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { initializeStorageSource } from '../src/analytics-delivery';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { initializeTypedV11Admission } from '../src/typed-v11-admission';
import { createV11DeviceFixture } from './helpers/telemetry-v11';
import { grantTelemetryV12Consent } from '../src/telemetry-transport-policy';
import { telemetryV12RequiredConsent } from '@app-usagemonitor/telemetry-contract';
import { authenticateDevice, revokeParticipantDevice } from '../src/device-auth';
import { readCollectionControls } from '../src/collection-controls';
import { setCollectionControls } from '../src/admin-operations';
import { enrollAccountlessDevice, parseAccountlessEnrollmentJson, ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION, ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS } from '../src/accountless-enrollment';
const b=env as Env & {TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]};
const db=()=>b.USAGE_MONITOR_DB;
beforeEach(async()=>{
  await reset();
  for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
    b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(db(),migrations);
  await initializeStorageSource(db(),'synthetic-direct-proof');
  await initializeTypedV1Admission(db(),'synthetic-direct-proof');
  await initializeTypedV11Admission(db(),'synthetic-direct-proof');
  await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
});
describe('direct admission proofs with maintained mutation triggers',()=>{
  it('admits real consent and pairing while still denying revoked credentials',async()=>{
    const fixture=await createV11DeviceFixture(db());
    await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
    await db().prepare("UPDATE participants SET owner_kind='social' WHERE id=?").bind(fixture.participantId).run();
    await expect(grantTelemetryV12Consent(db(),fixture,telemetryV12RequiredConsent())).resolves.toBeDefined();
    expect(await db().prepare('SELECT COUNT(*) n FROM telemetry_v12_device_capabilities WHERE participant_id=?')
      .bind(fixture.participantId).first<number>('n')).toBe(1);
    await expect(authenticateDevice(db(),fixture.authorization)).resolves.toMatchObject({deviceId:fixture.deviceId});
    expect(await revokeParticipantDevice(db(),fixture.participantId,fixture.deviceId)).toBe(true);
    await expect(authenticateDevice(db(),fixture.authorization)).rejects.toMatchObject({code:'DEVICE_AUTH_INVALID'});
  });
  it('admits accountless ledger once and preserves exact retry identity',async()=>{
    const request=parseAccountlessEnrollmentJson(JSON.stringify({schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId:crypto.randomUUID(),deviceSecretHash:'a'.repeat(64),policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS}));
    const now=Date.now(),first=await enrollAccountlessDevice(db(),request,now);
    const replay=await enrollAccountlessDevice(db(),request,now+1);
    expect(first.status).toBe(201);expect(replay.status).toBe(200);
    expect(replay.response).toMatchObject({deviceId:first.response.deviceId,expiresAt:first.response.expiresAt,state:'existing'});
    expect(await db().prepare('SELECT COUNT(*) n FROM accountless_enrollment_ledger').first<number>('n')).toBe(1);
  });
  it('accepts the exact control CAS and rejects a stale revision despite extra trigger writes',async()=>{
    const before=await readCollectionControls(db()),flags={enrollment:true,uploadRegistration:true,processing:false,publication:true};
    const result=await setCollectionControls(db(),'synthetic-owner',flags,'maintenance',before.revision);
    expect(result.revision).toBe(before.revision+1);
    await expect(setCollectionControls(db(),'synthetic-owner',{...flags,processing:true},'maintenance',before.revision))
      .rejects.toMatchObject({code:'ADMIN_ACTION_CONFLICT'});
    expect((await readCollectionControls(db())).revision).toBe(result.revision);
  });
});
