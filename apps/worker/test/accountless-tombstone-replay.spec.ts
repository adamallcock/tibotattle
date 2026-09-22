import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {enrollAccountlessDevice,parseAccountlessEnrollmentRequest,revokeAccountlessEnrollment} from '../src/accountless-enrollment';
import {createAccountlessUploadOwner} from '../src/accountless-ownership';
import {recordDeletionTombstone,replayDeletionTombstones,hasDeletionTombstone,participantDeletionDigest} from '../src/retention';
import {encodeBase64Url,sha256Hex} from '../src/crypto';
import {createV11DeviceFixture} from './helpers/telemetry-v11';
const b=env as Env&{TEST_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const db=()=>b.USAGE_MONITOR_DB;
beforeEach(async()=>{await reset();await applyD1Migrations(db(),b.TEST_MIGRATIONS);await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);});
async function owner(){
 const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
 const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`),bytes=new Uint8Array(prefix.length+secret.length);
 bytes.set(prefix);bytes.set(secret,prefix.length);const deviceSecretHash=await sha256Hex(bytes),authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;secret.fill(0);bytes.fill(0);
 await enrollAccountlessDevice(db(),parseAccountlessEnrollmentRequest({schemaVersion:'accountless-enrollment-v0.1',deviceId,deviceSecretHash,policyVersion:'accountless-opt-out-v1',authorizationBasis:'accountless-policy-v1'}));
 await createAccountlessUploadOwner(db(),authorization,{schemaVersion:'accountless-upload-owner-v0.1',policyVersion:'accountless-opt-out-v1',authorizationBasis:'accountless-policy-v1',telemetrySchemaVersion:'telemetry-contribution-v1.1'});
 const participantId=(await db().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?').bind(deviceId).first<string>('participant_id'))!;
 return {deviceId,participantId};
}
const replay=()=>replayDeletionTombstones(db(),b.DELETION_LEDGER,b.QUARANTINE);
describe('restored accountless authority behind independent tombstones',()=>{
 it('revokes authority before deleting only the ledger-proven restored owner',async()=>{
  const erased=await owner(),retained=await owner();await recordDeletionTombstone(b.DELETION_LEDGER,erased.participantId);
  await expect(db().prepare("UPDATE participants SET state='deleting',deletion_session_id=NULL WHERE id=?").bind(erased.participantId).run()).rejects.toThrow('participant owner shape invalid');
  expect(await replay()).toEqual({complete:true,suppressed:1});
  expect(await db().prepare('SELECT 1 FROM participants WHERE id=?').bind(erased.participantId).first()).toBeNull();
  expect(await db().prepare('SELECT state,revocation_reason FROM accountless_enrollment_ledger WHERE device_id=?').bind(erased.deviceId).first()).toEqual({state:'revoked',revocation_reason:'security_reset'});
  expect(await hasDeletionTombstone(b.DELETION_LEDGER,erased.participantId)).toBe(true);
  expect(await db().prepare('SELECT state FROM participants WHERE id=?').bind(retained.participantId).first('state')).toBe('active');
  expect(await db().prepare('SELECT state FROM accountless_enrollment_ledger WHERE device_id=?').bind(retained.deviceId).first('state')).toBe('active');
  expect(await replay()).toEqual({complete:true,suppressed:0});
 });
 it('resumes the exact accountless restore fence after revocation',async()=>{
  const f=await owner();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await revokeAccountlessEnrollment(db(),f.deviceId,'security_reset');
  const fence=`restore-replay:${await participantDeletionDigest(f.participantId)}`;
  await db().prepare("UPDATE participants SET state='deleting',deletion_session_id=? WHERE id=?").bind(fence,f.participantId).run();
  expect(await replay()).toEqual({complete:true,suppressed:1});expect(await hasDeletionTombstone(b.DELETION_LEDGER,f.participantId)).toBe(true);
 });
 it.each(['wrong-reserved','uuid'])('does not take over an accountless %s fence',async(kind)=>{
  const f=await owner();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);await revokeAccountlessEnrollment(db(),f.deviceId,'security_reset');
  const fence=kind==='uuid'?crypto.randomUUID():`restore-replay:${'f'.repeat(64)}`;
  await db().prepare("UPDATE participants SET state='deleting',deletion_session_id=? WHERE id=?").bind(fence,f.participantId).run();
  expect(await replay()).toEqual({complete:true,suppressed:0});
  expect(await db().prepare('SELECT deletion_session_id FROM participants WHERE id=?').bind(f.participantId).first('deletion_session_id')).toBe(fence);
 });
 it('retains the social NULL restore fence and completes its interrupted replay',async()=>{
  const f=await createV11DeviceFixture(db());await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await db().prepare("UPDATE participants SET state='deleting',deletion_session_id=NULL WHERE id=?").bind(f.participantId).run();
  expect(await replay()).toEqual({complete:true,suppressed:1});
 });
 it('does not take over an existing non-NULL owner-erasure fence',async()=>{
  const f=await createV11DeviceFixture(db()),fence=crypto.randomUUID();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await db().prepare("UPDATE participants SET state='deleting',deletion_session_id=? WHERE id=?").bind(fence,f.participantId).run();
  expect(await replay()).toEqual({complete:true,suppressed:0});
  expect(await db().prepare('SELECT state,deletion_session_id FROM participants WHERE id=?').bind(f.participantId).first()).toEqual({state:'deleting',deletion_session_id:fence});
 });
});
