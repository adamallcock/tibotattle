import { canonicalTelemetryV12Json,telemetryV12RequiredConsent,telemetryV12DayManifestDigestInput,
 telemetryV12DomainManifestDigestInput,telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest,type TelemetryV12Chunk,type TelemetryV12DayManifest,
 type TelemetryV12Record,type TelemetryV12UsageEvent } from '@app-usagemonitor/telemetry-contract';
import { registerTelemetryV12DayManifest,persistTelemetryV12StagedChunk } from '../src/telemetry-v12-repository';
import { activateTelemetryV12Domain,createTelemetryV12DomainPredecessor } from '../src/telemetry-v12-domain';
import { grantTelemetryV12Consent,grantTelemetryV12AccountlessAuthorization,parseTelemetryV12AccountlessAuthorizationRequest,
 ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS } from '../src/telemetry-transport-policy';
import { env,reset,applyD1Migrations,type D1Migration } from 'cloudflare:test';
import { beforeEach,describe,it,expect } from 'vitest';
import { createV11DeviceFixture,v11UsageRecord,makeV11Day } from './helpers/telemetry-v11';
import { initializeStorageSource } from '../src/analytics-delivery';
import { initializeTypedV1Admission,insertTypedTelemetryV1Chunk } from '../src/typed-v1-admission';
import { initializeTypedV11Admission,persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { activateTelemetryV11Domain,createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-compatibility';
import { parseTelemetryV1Chunk,type TelemetryV1UsageEvent } from '../src/telemetry-v1';
import { authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization } from '../src/device-auth';
import { encodeBase64Url,sha256Hex } from '../src/crypto';
import { canonicalJson } from '../src/canonical-json';
import { createD1InvocationBudget,readD1SchemaObjectsAvailable } from '../src/d1-invocation-budget';
import { advanceEffectiveDependencyCoverage,readEffectiveScopeMutationToken,effectiveSelectiveSchemaAvailable,
  readEffectiveDependencyAffectedRanges,acknowledgeEffectiveDependencyAffectedRanges,
  EFFECTIVE_SELECTIVE_TABLES } from '../src/storage-effective-selective-dependencies';
import { readEffectiveDependencySourceFence,readEffectiveScopeMutationTokens,readEffectiveDependencyResumeCursor,readEffectiveDependencyGlobalChange,acknowledgeEffectiveDependencyGlobalChange } from '../src/storage-effective-selective-dependencies';
import { canonicalOccurrenceKey } from '../src/canonical-analytics-facts';
import { createAnalyticsProfile,profileAnalyticsDatabase } from './helpers/analytics-profile';
import { effectiveHistoryDependency } from '../src/storage-effective-history';
import { prepareTelemetryUsageCorrectionCapture } from '../src/telemetry-usage-correction-repository';
import { readEffectiveDependencyMutationToken } from '../src/storage-effective-dependency-mutations';
import { enrollAccountlessDevice,revokeAccountlessEnrollment,parseAccountlessEnrollmentRequest,ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
 ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS } from '../src/accountless-enrollment';
import { createAccountlessUploadOwner,parseAccountlessOwnershipRequest,ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
 ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION } from '../src/accountless-ownership';
const b=env as Env & { TEST_MIGRATIONS:D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[] };
let selectedDatabase:D1Database|undefined;
const db=()=>selectedDatabase??b.USAGE_MONITOR_DB,namespace='synthetic-selective';
const selected='2026-09-20',outside='2026-09-21';
async function setup(includeSelective=true,ceiling=15) {
 selectedDatabase=undefined;await reset();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(db(),migrations);
 await initializeStorageSource(db(),namespace);await initializeTypedV1Admission(db(),namespace);await initializeTypedV11Admission(db(),namespace);
 await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>parseInt(m.name,10)<=ceiling&&(includeSelective||!m.name.startsWith('0015_'))));
}
async function insert(fixture:Awaited<ReturnType<typeof createV11DeviceFixture>>,day:string,id:string|readonly string[],sequence=0) {
 const records=(typeof id==='string'?[id]:id).map(eventId=>{
  const projected=telemetryV11LegacyProjection('usage',v11UsageRecord(day,'a',{eventId}));
  if(!projected)throw new Error('synthetic projection unavailable');
  return JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
 });
 const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
 const principal=await authenticateDevice(db(),fixture.authorization);
 const upload=await createDeviceUploadAuthorization(db(),principal,envelopeDigest,1000);
 const claimed=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,{
  envelopeDigest,bodyBytes:1000,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`usage:${day}:${sequence}`,
  chunkRevision:1,chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-selective',
  consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
   privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
 const receipt=await insertTypedTelemetryV1Chunk(db(),{chunkRowId:`chunk:${crypto.randomUUID()}`,participantId:fixture.participantId,
  deviceId:fixture.deviceId,chunk,envelopeDigest,r2Key:`synthetic/${crypto.randomUUID()}`,
  deviceUploadAuthorizationId:claimed.authorizationId,createdAt:new Date().toISOString(),supersedes:null},namespace);
 return {receipt,records};
}
async function identity(participantId:string) {
 const row=await db().prepare('SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?')
  .bind(participantId).first<{owner_digest:string}>();
 if(!row)throw new Error('synthetic owner unavailable');
 return {participantId,ownerDigest:row.owner_digest,sourceId:namespace,sourceNamespace:namespace};
}
async function scope(participantId:string,day=selected) {return {...await identity(participantId),fromDay:day,throughDay:day,includeSessions:true};}
async function drain(participantId:string,maxRows=32) {
 let sourceRows=0,statements=0;
 for(let attempts=0;attempts<100;attempts++) {
  const budget=createD1InvocationBudget(900);
  const progress=await advanceEffectiveDependencyCoverage(db(),{sourceId:namespace,sourceNamespace:namespace,
   participantId,maxSteps:32,maxRows,budget});
  sourceRows+=progress.sourceRows;statements+=progress.statements;
  if(progress.status==='complete')return {sourceRows,statements};
  expect(progress.status).not.toBe('unavailable');
 }
 throw new Error('synthetic coverage failed to converge');
}
async function native(participantId:string,selectedDay=selected) {
 const owner=await identity(participantId);
 const row=await db().prepare('SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=?')
  .bind(owner.ownerDigest).first<{revision:number;authority_epoch:number}>();
 return effectiveHistoryDependency(db(),{participantId,ownerDigest:owner.ownerDigest,ownerRevision:row!.revision,
  authorityEpoch:row!.authority_epoch,inputRevision:0,hasV1:true,hasV11:false,hasV12:false,hasLegacy:false},
  namespace,selectedDay,selectedDay,{includeSessions:true});
}
function v12UsageRecord(observedDay: string, eventId: string): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2", eventId,
    eventTime: `${observedDay}T12:05:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard",
    apiServiceTier: "default", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root",
    outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

async function stageV12Day(fixture: Pick<Awaited<ReturnType<typeof createV11DeviceFixture>>,'participantId'|'deviceId'|'authorization'>, observedDay: string,
  records: readonly TelemetryV12Record[]): Promise<Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>> {
  const consent = telemetryV12RequiredConsent();
  const chunks: TelemetryV12Chunk[] = [];
  for (const stream of ["quota", "session", "usage"] as const) {
    const selected = records.filter(record => record.schemaVersion.startsWith(`${stream}-`));
    for (let offset = 0; offset < selected.length; offset += 200) {
      const chunkRecords = selected.slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${observedDay}:${offset / 200}`, chunkRevision: 1,
        parserVersion: "synthetic-effective-history-v12", consent, records: chunkRecords,
        chunkDigest: await sha256Hex(canonicalTelemetryV12Json(chunkRecords)) });
    }
  }
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day: observedDay,
    parserVersion: "synthetic-effective-history-v12", consent,
    chunks: chunks.map(chunk => ({ chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    const principal = await authenticateDevice(db(), fixture.authorization);
    const envelopeDigest = await sha256Hex(`synthetic-v12-effective-history:${crypto.randomUUID()}`);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 4096);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: 4096, contentType: "application/json",
    });
    await persistTelemetryV12StagedChunk(db(), fixture, chunk, {
      chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/effective-history-v12/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return registerTelemetryV12DayManifest(db(), fixture, manifest);
}

async function activateV12(fixture: Pick<Awaited<ReturnType<typeof createV11DeviceFixture>>,'participantId'|'deviceId'|'authorization'>, candidates: readonly Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>[], nowEpoch = Date.now()) {
  const predecessor = await createTelemetryV12DomainPredecessor(db(), fixture, nowEpoch);
  const ordered = [...candidates].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(value => ({ day: value.day, manifestId: value.manifestId, manifestDigest: value.manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return activateTelemetryV12Domain(db(), fixture, manifest, nowEpoch);
}


async function accountlessSelectiveOwner(mode:'enrolled'|'owner'|'domain'='domain') {
 const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
 const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
 const input=new Uint8Array(prefix.length+secret.length);input.set(prefix);input.set(secret,prefix.length);
 const deviceSecretHash=await sha256Hex(input),authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
 input.fill(0);secret.fill(0);
 const now=Date.now();
 await enrollAccountlessDevice(db(),parseAccountlessEnrollmentRequest({schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  deviceId,deviceSecretHash}),now);
 if(mode==='enrolled')return {deviceId,participantId:null};
 await createAccountlessUploadOwner(db(),authorization,parseAccountlessOwnershipRequest({
  schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION}),now);
 const participantId=(await db().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?')
  .bind(deviceId).first<string>('participant_id'))!;
 if(mode==='owner')return {deviceId,participantId};
 const fixture={participantId,deviceId,authorization};
 await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
 await grantTelemetryV12AccountlessAuthorization(db(),fixture,parseTelemetryV12AccountlessAuthorizationRequest({
  schemaVersion:ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  authorizationBasis:ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,telemetrySchemaVersion:'telemetry-contribution-v1.2'}),now);
 const day=await stageV12Day(fixture,selected,[v12UsageRecord(selected,'event:synthetic-scoped-ledger')]);
 await activateV12(fixture,[day]);await drain(participantId);
 return {deviceId,participantId};
}
async function selectivePolicyStamp(){
 return (await db().prepare('SELECT policy_stamp FROM storage_effective_selective_runtime WHERE id=1')
  .first<number>('policy_stamp'))!;
}


beforeEach(()=>setup());
describe('sealed selective source dependencies',()=>{
 it('scopes a native mapped ledger-only revocation and preserves an unrelated sealed owner',async()=>{
  const unrelated=await createV11DeviceFixture(db());
  await insert(unrelated,selected,'event:synthetic-unrelated-ledger');await drain(unrelated.participantId);
  const owner=await accountlessSelectiveOwner();expect(owner.participantId).not.toBeNull();
  const unrelatedScope=await scope(unrelated.participantId),affectedScope=await scope(owner.participantId!);
  const unrelatedBefore=await readEffectiveScopeMutationToken(db(),unrelatedScope);
  const affectedBefore=await readEffectiveScopeMutationToken(db(),affectedScope);
  const unrelatedNativeBefore=await native(unrelated.participantId);
  expect(unrelatedBefore).toBeDefined();expect(affectedBefore).toBeDefined();
  const policyBefore=await selectivePolicyStamp();
  const effectBefore=await db().prepare(`SELECT stamp FROM storage_effective_selective_effects
   WHERE participant_id=? AND source_day='' AND through_day='' AND stream=0`)
   .bind(owner.participantId).first<number>('stamp');
  const now=new Date().toISOString();
  await db().prepare(`UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='security_reset'
   WHERE device_id=? AND state='active'`).bind(now,owner.deviceId).run();
  expect(await selectivePolicyStamp()).toBe(policyBefore);
  expect(await readEffectiveScopeMutationToken(db(),unrelatedScope)).toEqual(unrelatedBefore);
  expect(await native(unrelated.participantId)).toEqual(unrelatedNativeBefore);
  expect(await readEffectiveScopeMutationToken(db(),affectedScope)).toBeUndefined();
  const affected=await db().prepare(`SELECT l.state AS link_state,r.state AS revision_state,o.needs_work,o.broad_stamp,e.stamp
   FROM storage_v11_owner_links l JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest
   JOIN storage_effective_selective_owners o ON o.participant_id=l.participant_id
   JOIN storage_effective_selective_effects e ON e.participant_id=l.participant_id
    AND e.source_day='' AND e.through_day='' AND e.stream=0 WHERE l.participant_id=?`)
   .bind(owner.participantId).first<{link_state:string;revision_state:string;needs_work:number;broad_stamp:number;stamp:number}>();
  expect(affected).toMatchObject({link_state:'withdrawn',revision_state:'withdrawn',needs_work:1});
  expect(affected!.stamp).toBe(affected!.broad_stamp);
  expect(affected!.stamp).toBeGreaterThan(effectBefore??0);
 });

 it('keeps unbound, unbridged and key-changing ledger updates source-global',async()=>{
  const unbound=await accountlessSelectiveOwner('enrolled');
  const first=await selectivePolicyStamp();
  await db().prepare(`UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='security_reset'
   WHERE device_id=? AND state='active'`).bind(new Date().toISOString(),unbound.deviceId).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(first);
  const noHead=await accountlessSelectiveOwner('owner');expect(noHead.participantId).not.toBeNull();
  expect(await db().prepare('SELECT 1 FROM storage_v11_owner_links WHERE participant_id=?')
   .bind(noHead.participantId).first()).toBeNull();
  const second=await selectivePolicyStamp();
  await db().prepare(`UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='security_reset'
   WHERE device_id=? AND state='active'`).bind(new Date().toISOString(),noHead.deviceId).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(second);
  const keyChange=await accountlessSelectiveOwner('enrolled'),third=await selectivePolicyStamp();
  await db().prepare('UPDATE accountless_enrollment_ledger SET device_id=? WHERE device_id=?')
   .bind(crypto.randomUUID(),keyChange.deviceId).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(third);
 });

 it('retains the global fallback for an accepted historical marker and a ledger update after native erasure',async()=>{
  const retained=await accountlessSelectiveOwner();expect(retained.participantId).not.toBeNull();
  const first=await selectivePolicyStamp();
  expect(await revokeAccountlessEnrollment(db(),retained.deviceId,'user_opt_out')).toBe(true);
  expect(await db().prepare('SELECT count(*) n FROM accountless_public_history_retention WHERE enrollment_device_id=?')
   .bind(retained.deviceId).first<number>('n')).toBe(1);
  expect(await selectivePolicyStamp()).toBeGreaterThan(first);
  const erased=await accountlessSelectiveOwner();expect(erased.participantId).not.toBeNull();
  const owner=await identity(erased.participantId!);
  await db().prepare('DELETE FROM participants WHERE id=?').bind(erased.participantId).run();
  expect(await db().prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
   .bind(owner.ownerDigest).first<string>('state')).toBe('erased');
  expect(await db().prepare('SELECT 1 FROM storage_v11_owner_links WHERE owner_digest=?')
   .bind(owner.ownerDigest).first()).toBeNull();
  const second=await selectivePolicyStamp();
  await db().prepare(`UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='security_reset'
   WHERE device_id=? AND state='active'`).bind(new Date().toISOString(),erased.deviceId).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(second);
 });

 it('keeps an unrelated sealed owner unchanged through native participant erasure',async()=>{
  const unrelated=await createV11DeviceFixture(db());
  await insert(unrelated,selected,'event:synthetic-unrelated-erasure');await drain(unrelated.participantId);
  const unrelatedScope=await scope(unrelated.participantId);
  const unrelatedBefore=await readEffectiveScopeMutationToken(db(),unrelatedScope);
  const nativeBefore=await native(unrelated.participantId);
  expect(unrelatedBefore).toBeDefined();
  const erased=await accountlessSelectiveOwner();expect(erased.participantId).not.toBeNull();
  const owner=await identity(erased.participantId!);
  const policyBefore=await selectivePolicyStamp();
  await db().prepare('DELETE FROM participants WHERE id=?').bind(erased.participantId).run();
  expect(await db().prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
   .bind(owner.ownerDigest).first<string>('state')).toBe('erased');
  expect(await db().prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-erased'")
   .bind(owner.ownerDigest).first<number>('n')).toBe(1);
  expect(await db().prepare('SELECT 1 FROM storage_effective_selective_effects WHERE participant_id=?')
   .bind(erased.participantId).first()).toBeNull();
  expect(await selectivePolicyStamp()).toBe(policyBefore);
  expect(await readEffectiveScopeMutationToken(db(),unrelatedScope)).toEqual(unrelatedBefore);
  expect(await native(unrelated.participantId)).toEqual(nativeBefore);
 });

 it('falls back globally if a linked accountless grant is synthetically mismatched',async()=>{
  const mapped=await accountlessSelectiveOwner();expect(mapped.participantId).not.toBeNull();
  const other=await createV11DeviceFixture(db());
  const immutableGrant:readonly [type:'trigger',name:string]=['trigger','accountless_v11_authorization_immutable'];
  expect(await readD1SchemaObjectsAvailable(db(),[immutableGrant])).toBe(true);
  await db().prepare('DROP TRIGGER accountless_v11_authorization_immutable').run();
  expect(await readD1SchemaObjectsAvailable(db(),[immutableGrant])).toBe(false);
  await db().prepare('UPDATE accountless_v11_device_authorizations SET participant_id=? WHERE enrollment_device_id=?')
   .bind(other.participantId,mapped.deviceId).run();
  // This deliberately damaged source is not a valid analytics capability;
  // the test inspects only the trigger's conservative global fallback.
  const prior=await selectivePolicyStamp();
  await db().prepare(`UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='security_reset'
   WHERE device_id=? AND state='active'`).bind(new Date().toISOString(),mapped.deviceId).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(prior);
  expect(await readD1SchemaObjectsAvailable(db(),[immutableGrant])).toBe(false);
  expect(await db().prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='accountless_v11_authorization_immutable'").first()).toBeNull();
 });

 it('keeps source identity changes global even beside an exact terminal epoch in a partial schema',async()=>{
  const mapped=await accountlessSelectiveOwner();expect(mapped.participantId).not.toBeNull();
  const owner=await identity(mapped.participantId!);
  const source=await db().prepare('SELECT source_id,authority_epoch FROM storage_source_state WHERE singleton=1')
   .first<{source_id:string;authority_epoch:number}>();
  const revision=await db().prepare('SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=?')
   .bind(owner.ownerDigest).first<{revision:number;authority_epoch:number}>();
  expect(source).not.toBeNull();expect(revision).not.toBeNull();
  // This deliberately partial source isolates the selective trigger: normal
  // journal commit and source-identity guards would refuse this paired edit.
  await db().prepare('DROP TRIGGER storage_ingestion_change_commit').run();
  await db().prepare('DROP TRIGGER storage_source_identity_immutable').run();
  await db().prepare("UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=? AND state='active'")
   .bind(mapped.participantId).run();
  const terminal=await db().prepare(`SELECT revision,authority_epoch,public_authority_epoch
   FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-withdrawn' ORDER BY sequence DESC LIMIT 1`)
   .bind(owner.ownerDigest).first<{revision:number;authority_epoch:number;public_authority_epoch:number}>();
  expect(terminal).toEqual({revision:revision!.revision+1,authority_epoch:revision!.authority_epoch+1,
   public_authority_epoch:source!.authority_epoch+1});
  await db().prepare("UPDATE storage_owner_revisions SET revision=?,authority_epoch=?,state='withdrawn' WHERE owner_digest=?")
   .bind(terminal!.revision,terminal!.authority_epoch,owner.ownerDigest).run();
  const policyBefore=await selectivePolicyStamp();
  await db().prepare('UPDATE storage_source_state SET source_id=?,authority_epoch=? WHERE singleton=1')
   .bind(source!.source_id+'-changed',terminal!.public_authority_epoch).run();
  expect(await selectivePolicyStamp()).toBeGreaterThan(policyBefore);
 });

 it('refuses missing and partial source schemas',async()=>{
  await setup(false);expect(await effectiveSelectiveSchemaAvailable(db())).toBe(false);
  expect(await readEffectiveDependencySourceFence(db())).toBeUndefined();
  expect((await advanceEffectiveDependencyCoverage(db(),{sourceId:namespace,sourceNamespace:namespace,maxSteps:1,maxRows:1})).status).toBe('unavailable');
  await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>m.name.startsWith('0015_')));
  expect(await effectiveSelectiveSchemaAvailable(db())).toBe(true);
  await db().prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
  expect(await effectiveSelectiveSchemaAvailable(db())).toBe(false);
 });
 it('requires bounded old-history coverage and keeps no-op proofs without source scans',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-one');
  const selectedScope=await scope(fixture.participantId);
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toBeUndefined();
  const one=await advanceEffectiveDependencyCoverage(db(),{sourceId:namespace,sourceNamespace:namespace,
   participantId:fixture.participantId,maxSteps:1,maxRows:1,budget:createD1InvocationBudget(100)});
  expect(one.steps).toBe(1);expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toBeUndefined();
  await drain(fixture.participantId,1);
  const before=await readEffectiveScopeMutationToken(db(),selectedScope);expect(before).toBeDefined();
  await db().prepare('UPDATE telemetry_v1_chunks SET chunk_digest=chunk_digest WHERE participant_id=?').bind(fixture.participantId).run();
  await db().prepare('UPDATE storage_owner_revisions SET revision=revision WHERE owner_digest=?').bind(selectedScope.ownerDigest).run();
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toEqual(before);
  const warm=await drain(fixture.participantId);expect(warm.sourceRows).toBe(0);
 });
 it('preserves unrelated days after append and discovers new outside-day variants',async()=>{
  const fixture=await createV11DeviceFixture(db());
  const second=await createV11DeviceFixture(db(),{participantId:fixture.participantId});
  await insert(fixture,selected,'event:synthetic-linked');
  await drain(fixture.participantId);const selectedScope=await scope(fixture.participantId);
  const before=await readEffectiveScopeMutationToken(db(),selectedScope);
  const nativeBefore=await native(fixture.participantId);
  const broadBefore=await readEffectiveDependencyMutationToken(db(),await identity(fixture.participantId));
  await insert(fixture,outside,'event:synthetic-unrelated');
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toBeUndefined();await drain(fixture.participantId);
  expect((await readEffectiveDependencyMutationToken(db(),await identity(fixture.participantId)))?.stamp).not.toBe(broadBefore?.stamp);
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toEqual(before);
  expect(await native(fixture.participantId)).toEqual(nativeBefore);
  await insert(second,outside,'event:synthetic-linked',1);await drain(fixture.participantId);
  expect((await readEffectiveScopeMutationToken(db(),selectedScope))?.stamp).not.toBe(before?.stamp);
  expect(await native(fixture.participantId)).not.toEqual(nativeBefore);
 });
 it('invalidates runtime changes and uses globally monotonic durable effects with exact ACK',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-runtime');await drain(fixture.participantId);
  const selectedScope=await scope(fixture.participantId),before=await readEffectiveScopeMutationToken(db(),selectedScope);
  const effects=await readEffectiveDependencyAffectedRanges(db());expect(effects.length).toBeGreaterThan(0);
  expect(effects.every(row=>Number.isSafeInteger(row.stamp)&&row.stamp>0)).toBe(true);
  await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  expect((await readEffectiveScopeMutationToken(db(),selectedScope))?.stamp).not.toBe(before?.stamp);
  await acknowledgeEffectiveDependencyAffectedRanges(db(),effects);expect(await readEffectiveDependencyAffectedRanges(db())).toEqual([]);
  await expect(db().prepare('UPDATE storage_effective_selective_runtime SET sequence=sequence-1 WHERE id=1').run()).rejects.toThrow();
 });
 it('physically erases every owner-scoped catalog and work table at the owner erasure fence',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-erasure');await drain(fixture.participantId);
  const selectedScope=await scope(fixture.participantId);
  await advanceEffectiveDependencyCoverage(db(),{sourceId:namespace,sourceNamespace:namespace,maxSteps:4,maxRows:2});
  expect(await db().prepare('SELECT owner_cursor FROM storage_effective_selective_bootstrap').first('owner_cursor')).toBe(selectedScope.ownerDigest);
  await expect(db().prepare('DELETE FROM storage_effective_dependency_owner_mutations WHERE participant_id=?').bind(fixture.participantId).run()).rejects.toThrow('storage_effective_mutation_owner_retained');
  await db().prepare("UPDATE storage_owner_revisions SET state='erased',authority_epoch=authority_epoch+1 WHERE owner_digest=?")
   .bind(selectedScope.ownerDigest).run();
  for(const table of EFFECTIVE_SELECTIVE_TABLES.filter(name=>!name.endsWith('_runtime')&&!name.endsWith('_bootstrap'))) {
   expect(await db().prepare(`SELECT count(*) AS n FROM ${table} WHERE participant_id=?`).bind(fixture.participantId).first('n')).toBe(0);
  }
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toBeUndefined();
  expect(await db().prepare('SELECT count(*) FROM storage_effective_dependency_owner_mutations WHERE participant_id=?').bind(fixture.participantId).first('count(*)')).toBe(0);
  await expect(db().prepare('INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision) VALUES(?,1)').bind(fixture.participantId).run()).rejects.toThrow('storage_effective_mutation_owner_invalid');
  expect(await db().prepare('SELECT count(*) FROM storage_effective_dependency_owner_mutations WHERE participant_id=?').bind(fixture.participantId).first('count(*)')).toBe(0);
  expect(await db().prepare('SELECT owner_cursor FROM storage_effective_selective_bootstrap').first('owner_cursor')).toBe('');
 });
 it('erases broad and selective metadata through the native owner-link erasure transition',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-link-erasure');await drain(fixture.participantId);
  const chosen=await scope(fixture.participantId);
  await db().prepare("UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=?").bind(fixture.participantId).run();
  expect(await db().prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?').bind(chosen.ownerDigest).first('state')).toBe('erased');
  for(const table of [...EFFECTIVE_SELECTIVE_TABLES.filter(name=>!name.endsWith('_runtime')&&!name.endsWith('_bootstrap')),'storage_effective_dependency_owner_mutations'])
   expect(await db().prepare(`SELECT count(*) FROM ${table} WHERE participant_id=?`).bind(fixture.participantId).first('count(*)')).toBe(0);
 });
 it('physically removes conservative mutation metadata when an unused participant is deleted',async()=>{
  const fixture=await createV11DeviceFixture(db());
  expect(await db().prepare('SELECT count(*) FROM storage_effective_dependency_owner_mutations WHERE participant_id=?').bind(fixture.participantId).first('count(*)')).toBe(1);
  await db().prepare('DELETE FROM participants WHERE id=?').bind(fixture.participantId).run();
  expect(await db().prepare('SELECT count(*) FROM storage_effective_dependency_owner_mutations WHERE participant_id=?').bind(fixture.participantId).first('count(*)')).toBe(0);
 });
 it('resolves private resume cursors only under sealed scope proofs and makes warmed validation metadata-only',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-cursor');await drain(fixture.participantId);
  const selectedScope=await scope(fixture.participantId);
  const occurrenceKey=await canonicalOccurrenceKey({...await identity(fixture.participantId),selectionMethod:'effective-union-v1'},'usage','event:synthetic-cursor');
  expect(await readEffectiveDependencyResumeCursor(db(),selectedScope,'usage',occurrenceKey,Date.parse(selected+'T12:05:00.000Z')))
   .toEqual({occurrenceId:'event:synthetic-cursor',observedAtMs:Date.parse(selected+'T12:05:00.000Z')});
  const profile=createAnalyticsProfile();const wrapped=profileAnalyticsDatabase(db(),'source',profile,()=> 'warm');
  expect(await readEffectiveScopeMutationToken(wrapped,selectedScope)).toBeDefined();
  expect(Object.values(profile.costs).reduce((n,c)=>n+c.rawHistoryAccessStatements,0)).toBe(0);
  expect(await readEffectiveDependencyResumeCursor(db(),selectedScope,'usage',occurrenceKey,0)).toBeUndefined();
 });
 it('tracks a direct correction fact at unchanged owner CAS and converges on replay',async()=>{
  const fixture=await createV11DeviceFixture(db());const admitted=await insert(fixture,selected,'event:synthetic-correction');
  await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();await drain(fixture.participantId);
  const selectedScope=await scope(fixture.participantId),before=await readEffectiveScopeMutationToken(db(),selectedScope);
  const row=await db().prepare(`SELECT r.storage_row_id,r.source_row_id,r.chunk_row_id,o.revision,o.authority_epoch
   FROM typed_telemetry_compatibility_records r JOIN storage_v11_owner_links l ON l.participant_id=r.participant_id
   JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE r.participant_id=? LIMIT 1`)
   .bind(fixture.participantId).first<{storage_row_id:number;source_row_id:number;chunk_row_id:string;revision:number;authority_epoch:number}>();
  const input={...await identity(fixture.participantId),ownerRevision:row!.revision,authorityEpoch:row!.authority_epoch,
   sourceStorageRowId:row!.storage_row_id,sourceRowId:row!.source_row_id,sourceFormat:'v1' as const,
   sourceDeviceId:fixture.deviceId,sourceChunkId:row!.chunk_row_id,sourceManifestId:null,recordJson:canonicalJson(admitted.records[0])};
  const {sourceId:unused,...source}=input;void unused;
  await (await prepareTelemetryUsageCorrectionCapture(db(),source)).commit();
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toBeUndefined();await drain(fixture.participantId);
  const after=await readEffectiveScopeMutationToken(db(),selectedScope);expect(after?.stamp).not.toBe(before?.stamp);
  expect(await db().prepare('SELECT revision FROM storage_owner_revisions WHERE owner_digest=?').bind(selectedScope.ownerDigest).first('revision')).toBe(row!.revision);
  await (await prepareTelemetryUsageCorrectionCapture(db(),source)).commit();
  expect(await readEffectiveScopeMutationToken(db(),selectedScope)).toEqual(after);
 });
 it('keeps global policy work durable until exact stamp acknowledgement',async()=>{
  const first=await readEffectiveDependencyGlobalChange(db());expect(first).toBeDefined();
  await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  const second=await readEffectiveDependencyGlobalChange(db());expect(second!.stamp).toBeGreaterThan(first!.stamp);
  await acknowledgeEffectiveDependencyGlobalChange(db(),first!);expect(await readEffectiveDependencyGlobalChange(db())).toEqual(second);
  await acknowledgeEffectiveDependencyGlobalChange(db(),second!);expect(await readEffectiveDependencyGlobalChange(db())).toBeUndefined();
 });
 it('measures admission overhead in native D1 without per-record metadata INSERT hooks',async({annotate})=>{
  await setup(true,13);const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-cost-initial');
  async function measure(day:string,count:number,label:string) {
   const profile=createAnalyticsProfile();selectedDatabase=profileAnalyticsDatabase(b.USAGE_MONITOR_DB,'source',profile,()=> 'admission');
   try {await insert(fixture,day,Array.from({length:count},(_,i)=>`event:synthetic-cost-${label}-${i}`));}
   finally {selectedDatabase=undefined;}return profile;
  }
  const baselines=[await measure('2026-09-22',1,'before-small'),await measure('2026-09-23',200,'before-full')];
  // A separate index-only control attributes unavoidable bounded-keyset
  // index maintenance without weakening the exact trigger-scaling assertion.
  await db().batch([
   db().prepare('CREATE INDEX p2_benchmark_typed_page ON typed_telemetry_records(owner_id,observed_day,id)'),
   db().prepare('CREATE INDEX p2_benchmark_v12_page ON telemetry_v12_records(observed_day,id)'),
   db().prepare('CREATE INDEX p2_benchmark_correction_page ON telemetry_usage_correction_history(participant_id,event_time_ms,id)'),
  ]);
  const indexedBaselines=[await measure('2026-09-26',1,'indexed-small'),await measure('2026-09-27',200,'indexed-full')];
  await db().batch(['typed','v12','correction'].map(kind=>db().prepare(`DROP INDEX p2_benchmark_${kind}_page`)));
  await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>parseInt(m.name,10)>13&&parseInt(m.name,10)<=15));
  // Give both measured admissions the same existing pending-owner state.
  await advanceEffectiveDependencyCoverage(db(),{sourceId:namespace,sourceNamespace:namespace,participantId:fixture.participantId,maxSteps:1,maxRows:1});
  const candidates=[await measure('2026-09-24',1,'after-small'),await measure('2026-09-25',200,'after-full')];
  const sum=(p:ReturnType<typeof createAnalyticsProfile>,k:'statements'|'rowsWritten')=>Object.values(p.costs).reduce((n,c)=>n+c[k],0);
  const measured=baselines.map((baseline,index)=>{
   const candidate=candidates[index]!;
   expect(sum(candidate,'statements')).toBe(sum(baseline,'statements'));
   expect(sum(candidate,'rowsWritten')).toBeGreaterThan(sum(baseline,'rowsWritten'));
   return {nativeStatements:sum(baseline,'statements'),candidateStatements:sum(candidate,'statements'),
    nativeRowsWritten:sum(baseline,'rowsWritten'),candidateRowsWritten:sum(candidate,'rowsWritten'),
    admittedRecords:index===0?1:200,indexedNativeRowsWritten:sum(indexedBaselines[index]!,'rowsWritten'),
    totalExtraRowsWritten:sum(candidate,'rowsWritten')-sum(baseline,'rowsWritten'),
    extraRowsWritten:sum(candidate,'rowsWritten')-sum(indexedBaselines[index]!,'rowsWritten')};
  });
  await annotate(JSON.stringify(measured),'source-metadata-admission-overhead');
  expect(measured[1]!.extraRowsWritten).toBe(measured[0]!.extraRowsWritten);
  const triggers=(await db().prepare(`SELECT sql FROM sqlite_schema WHERE type='trigger'
   AND name LIKE 'storage_effective_%' AND (sql LIKE '%INSERT ON typed_telemetry_records%' OR sql LIKE '%INSERT ON typed_v11_record_proofs%')`).all()).results;
  expect(triggers).toEqual([]);
 });

 it('preserves unchanged retained v11 days across cumulative admission epochs',async()=>{
  const fixture=await createV11DeviceFixture(db(),{grant:true});
  const firstDay=new Date().toISOString().slice(0,10),secondDay=new Date(Date.parse(firstDay)+86400000).toISOString().slice(0,10);
  async function stage(day:string,id:string){
   const prepared=await makeV11Day(day,{usage:[v11UsageRecord(day,'a',{eventId:id})]});
   await registerTelemetryV11DayManifest(db(),fixture,prepared.manifest);
   for(const chunk of prepared.chunks){
    const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const principal=await authenticateDevice(db(),fixture.authorization);
    const upload=await createDeviceUploadAuthorization(db(),principal,envelopeDigest,1000);
    const claimed=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:1000,contentType:'application/json'});
    await persistTypedV11StagedChunk(db(),fixture,chunk,{sourceNamespace:namespace,chunkRowId:`chunk:${crypto.randomUUID()}`,
     r2Key:`synthetic/${crypto.randomUUID()}`,envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId});
   }
   return registerTelemetryV11DayManifest(db(),fixture,prepared.manifest);
  }
  async function activate(days:Awaited<ReturnType<typeof stage>>[]){
   const prior=await createTelemetryV11DomainPredecessor(db(),fixture);
   const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:days[0]!.day,throughDay:days.at(-1)!.day,
    predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
    days:days.map(value=>({day:value.day,manifestId:value.manifestId,manifestDigest:value.manifestDigest})),manifestDigest:'0'.repeat(64)};
   manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));return activateTelemetryV11Domain(db(),fixture,manifest);
  }
  const first=await stage(firstDay,'event:synthetic-v11-first');await activate([first]);await drain(fixture.participantId);
  const chosen=await scope(fixture.participantId,firstDay),before=await readEffectiveScopeMutationToken(db(),chosen),dependency=await native(fixture.participantId,firstDay);
  expect(before).toBeDefined();expect(dependency.v11).toHaveLength(1);
  const second=await stage(secondDay,'event:synthetic-v11-other');await activate([first,second]);await drain(fixture.participantId);
  expect(await readEffectiveScopeMutationToken(db(),chosen)).toEqual(before);expect(await native(fixture.participantId,firstDay)).toEqual(dependency);
 });

 it('covers retained v12 domains, empty manifests, proof completion and ordinary opt-out',async()=>{
  const fixture=await createV11DeviceFixture(db());
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  await grantTelemetryV12Consent(db(),fixture,telemetryV12RequiredConsent());
  const first=await stageV12Day(fixture,selected,[v12UsageRecord(selected,'event:synthetic-v12-link')]);
  await activateV12(fixture,[first]);await drain(fixture.participantId);
  const chosenScope=await scope(fixture.participantId),before=await readEffectiveScopeMutationToken(db(),chosenScope);
  expect(before).toBeDefined();const initialNative=await native(fixture.participantId);
  const second=await stageV12Day(fixture,outside,[v12UsageRecord(outside,'event:synthetic-v12-unrelated')]);
  await activateV12(fixture,[first,second]);
  await drain(fixture.participantId);
  expect(await readEffectiveScopeMutationToken(db(),chosenScope)).toEqual(before);
  expect(await native(fixture.participantId)).toEqual(initialNative);
  const emptyDay='2026-09-22',emptyScope=await scope(fixture.participantId,emptyDay);
  const emptyBefore=await readEffectiveScopeMutationToken(db(),emptyScope);
  const empty=await stageV12Day(fixture,emptyDay,[]);await activateV12(fixture,[first,second,empty]);
  expect(await readEffectiveScopeMutationToken(db(),emptyScope)).toBeUndefined();await drain(fixture.participantId);
  expect((await readEffectiveScopeMutationToken(db(),emptyScope))?.stamp).not.toBe(emptyBefore?.stamp);
  expect((await native(fixture.participantId,emptyDay)).v12).toHaveLength(1);
  const linked=await stageV12Day(fixture,outside,[v12UsageRecord(outside,'event:synthetic-v12-link')]);
  await activateV12(fixture,[first,linked,empty]);await drain(fixture.participantId);
  expect((await readEffectiveScopeMutationToken(db(),chosenScope))?.stamp).not.toBe(before?.stamp);
  expect((await native(fixture.participantId)).occurrenceLinks.length).toBeGreaterThan(0);
  const accepted=await native(fixture.participantId);
  await db().prepare("UPDATE telemetry_v12_device_capabilities SET state='revoked',revoked_at=? WHERE participant_id=?")
   .bind(new Date().toISOString(),fixture.participantId).run();
  await drain(fixture.participantId);
  expect(await native(fixture.participantId)).toEqual(accepted);
  expect(await readEffectiveScopeMutationToken(db(),chosenScope)).toBeDefined();
  expect(await db().prepare('SELECT count(*) FROM storage_effective_selective_variants WHERE participant_id=?').bind(fixture.participantId).first('count(*)')).toBeGreaterThan(0);
 });

 it('expires a sealed accountless clock token without erasing retained accepted history',async()=>{
  const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
  const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input=new Uint8Array(prefix.length+secret.length);input.set(prefix);input.set(secret,prefix.length);
  const deviceSecretHash=await sha256Hex(input),authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  input.fill(0);secret.fill(0);
  const expiresAtMs=Date.now()+8000,enrolledAt=expiresAtMs-ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS;
  await enrollAccountlessDevice(db(),parseAccountlessEnrollmentRequest({schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
   policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
   deviceId,deviceSecretHash}),enrolledAt);
  await createAccountlessUploadOwner(db(),authorization,parseAccountlessOwnershipRequest({
   schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
   authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION}),enrolledAt);
  const participantId=(await db().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?')
   .bind(deviceId).first<string>('participant_id'))!;
  const fixture={participantId,deviceId,authorization};
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  await grantTelemetryV12AccountlessAuthorization(db(),fixture,parseTelemetryV12AccountlessAuthorizationRequest({
   schemaVersion:ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
   authorizationBasis:ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,telemetrySchemaVersion:'telemetry-contribution-v1.2'}),enrolledAt);
  const staged=await stageV12Day(fixture,selected,[v12UsageRecord(selected,'event:synthetic-expiry')]);
  await activateV12(fixture,[staged]);await drain(participantId);
  const chosen=await scope(participantId),before=await readEffectiveScopeMutationToken(db(),chosen);
  expect(before?.validUntilMs).toBe(expiresAtMs);const accepted=await native(participantId);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAtMs-Date.now())+30));
  const after=await readEffectiveScopeMutationToken(db(),chosen);
  expect(after).toBeDefined();expect(after?.stamp).not.toBe(before?.stamp);
  expect(after?.validUntilMs).toBe(Number.MAX_SAFE_INTEGER);
  expect(await native(participantId)).toEqual(accepted);
  expect(await db().prepare('SELECT count(*) FROM storage_effective_selective_variants WHERE participant_id=?')
   .bind(participantId).first('count(*)')).toBeGreaterThan(0);
 },15000);

 it('discovers old owners through a durable bounded keyset and makes a warm global drain constant work',async()=>{
  await setup(true,13);
  const fixtures=[];
  for(let i=0;i<3;i++){const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,`event:synthetic-old-${i}`);fixtures.push(fixture);}
  await applyD1Migrations(db(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>parseInt(m.name,10)>13&&parseInt(m.name,10)<=15));
  const options={sourceId:namespace,sourceNamespace:namespace,maxSteps:1,maxRows:1};
  expect((await advanceEffectiveDependencyCoverage(db(),options)).status).toBe('progress');
  expect(await db().prepare('SELECT count(*) FROM storage_effective_selective_owners').first('count(*)')).toBe(1);
  for(let i=0;i<100;i++){
   const progress=await advanceEffectiveDependencyCoverage(db(),{...options,budget:createD1InvocationBudget(100)});
   expect(progress.steps).toBeLessThanOrEqual(1);expect(progress.sourceRows).toBeLessThanOrEqual(1);
   if(progress.status==='complete')break;if(i===99)throw new Error('bounded bootstrap did not converge');
  }
  for(const fixture of fixtures)expect(await readEffectiveScopeMutationToken(db(),await scope(fixture.participantId))).toBeDefined();
  const warm=await advanceEffectiveDependencyCoverage(db(),{...options,budget:createD1InvocationBudget(100)});
  expect(warm.status).toBe('complete');expect(warm.sourceRows).toBe(0);expect(warm.statements).toBeLessThanOrEqual(6);
 });

 it('fences request-local reuse with one metadata statement and refuses partial capability and notices source changes',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-fence');await drain(fixture.participantId);
  const full=await readEffectiveScopeMutationToken(db(),await scope(fixture.participantId));expect(full).toBeDefined();
  const profile=createAnalyticsProfile(),measured=profileAnalyticsDatabase(db(),'source',profile,()=> 'fence');
  const before=await readEffectiveDependencySourceFence(measured);expect(before).toBeDefined();
  expect(Object.values(profile.costs).reduce((n,c)=>n+c.statements,0)).toBe(1);
  expect(Object.values(profile.costs).reduce((n,c)=>n+c.rawHistoryAccessStatements,0)).toBe(0);
  await db().prepare('UPDATE telemetry_v1_chunks SET chunk_digest=chunk_digest').run();
  expect(await readEffectiveDependencySourceFence(db())).toEqual(before);
  await insert(fixture,outside,'event:synthetic-fence-append');
  const changed=await readEffectiveDependencySourceFence(db());expect(changed!.generation).toBeGreaterThan(before!.generation);
  expect(changed!.capabilityVersion).toBe(before!.capabilityVersion);
  const triggerSql=(await db().prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_correction_fact_insert'").first<string>('sql'))!;
  await db().prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
  expect(await readEffectiveDependencySourceFence(db())).toBeUndefined();expect(await effectiveSelectiveSchemaAvailable(db())).toBe(false);
  await db().prepare(triggerSql).run();expect(await readEffectiveDependencySourceFence(db())).toEqual(changed);
  await db().prepare('DROP TRIGGER typed_v1_event_guard').run();
  expect(await readEffectiveDependencySourceFence(db())).toBeUndefined();
 });

 it('reads 101 distinct singleton stamps in four metadata statements and preserves every unaffected day',async()=>{
  const fixture=await createV11DeviceFixture(db());await insert(fixture,selected,'event:synthetic-bulk-one');await drain(fixture.participantId);
  const owner=await identity(fixture.participantId);
  const scopes=Array.from({length:101},(_,index)=>{const day=new Date(Date.parse(selected)+(index-50)*86400000).toISOString().slice(0,10);
   return {fromDay:day,throughDay:day,includeSessions:true};});
  const profile=createAnalyticsProfile();const measured=profileAnalyticsDatabase(db(),'source',profile,()=> 'bulk');
  const before=await readEffectiveScopeMutationTokens(measured,owner,scopes);expect(before).toHaveLength(101);
  expect(Object.values(profile.costs).reduce((n,c)=>n+c.statements,0)).toBe(4);
  expect(Object.values(profile.costs).reduce((n,c)=>n+c.rawHistoryAccessStatements,0)).toBe(0);
  expect(before![50]).toEqual(await readEffectiveScopeMutationToken(db(),{...owner,...scopes[50]!}));
  await insert(fixture,outside,'event:synthetic-bulk-two');await drain(fixture.participantId);
  const after=await readEffectiveScopeMutationTokens(db(),owner,scopes);expect(after).toHaveLength(101);
  expect(after!.filter((token,index)=>token.stamp!==before![index]!.stamp)).toHaveLength(1);
  expect(after![51]!.stamp).not.toBe(before![51]!.stamp);
 });

});
