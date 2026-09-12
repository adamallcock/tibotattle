import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture, v11UsageRecord } from './helpers/telemetry-v11';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { currentTelemetryV1Chunk, insertTelemetryV1Chunk, type TelemetryV1ChunkInsert } from '../src/telemetry-v1-repository';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-repository';
import { parseTelemetryV1Chunk, type TelemetryV1Record } from '../src/telemetry-v1';
import { sha256Hex } from '../src/crypto';
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk, lookupTypedV1Source, validateTypedTelemetryV1Receipt } from '../src/typed-v1-admission';
import { initializeStorageSource, readIngestionChanges } from '../src/analytics-delivery';
import { readTypedTelemetryRowsByStorageIds } from '../src/typed-telemetry-compatibility';
const bindings=env as Env & {TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[]};
const source=()=>bindings.USAGE_MONITOR_DB, namespace='synthetic-v1-source', sourceId='synthetic-v1-journal';
const day=()=>new Date().toISOString().slice(0,10);
const changes=()=>readIngestionChanges(source(),sourceId,0);
const count=(table:string)=>source().prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
beforeEach(async()=>{
 await reset();await applyD1Migrations(source(),bindings.TEST_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_INGESTION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV1Admission(source(),namespace);
});
function withBatch(batch:D1Database['batch']):D1Database{return new Proxy(source(),{get(db,key){if(key==='batch')return batch;
 const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});}
async function seed(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1, fixture = undefined as Awaited<ReturnType<typeof createV11DeviceFixture>> | undefined, revision=1, seq=0) {
  fixture ??= await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(day(), 'a', { eventId: `event:v2:${i.toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${i.toString(16).padStart(64, '0')}`,
      observedTime: `${day()}T12:00:00.000Z`, provider: 'openai_codex', planType: 'pro', planVariant: 'unknown',
      limitId: 'codex', slot: 'secondary', usedPercent: 0.30000000000000004, windowDurationMinutes: 10080,
      resetsAt: `${day()}T13:00:00.000Z` }
    : { schemaVersion: 'session-dimension-v1.0', sessionUuid: '0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
      firstEventTime: `${day()}T12:00:00.000Z`, provider: 'openai_codex', toolClassCounts: { shell: 0, other: 3 } }) as TelemetryV1Record[];
  const envelopeDigest = await sha256Hex(`synthetic-proof-${crypto.randomUUID()}`);
  const auth = await authenticateDevice(source(), fixture.authorization);
  const uploaded = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${uploaded.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: 'application/json' });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: 'telemetry-contribution-v1.0', chunkId: `${stream}:${day()}:${seq}`,
    chunkRevision: revision, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: 'synthetic-proof-v1',
    consent: { telemetrySchemaVersion: 'telemetry-contribution-v1.0', fieldDictionaryVersion: 'telemetry-v1.0-registry-2026-08-07.1',
      privacyContractVersion: 'ongoing-privacy-safe-telemetry-v1.0' }, records });
  return { fixture, insert: { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/proof-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null } as TelemetryV1ChunkInsert };
}

describe('typed legacy v1 atomic admission',()=>{
 it('stores all3 streams with exact source IDs and bytes, consumes auth and journals only acceptance',async()=>{
  for(const stream of ['usage','quota','session'] as const){
   const {insert}=await seed(stream);expect(await insertTypedTelemetryV1Chunk(source(),insert,namespace)).toMatchObject({acceptedRecords:1,replay:false});
   expect(await source().prepare('SELECT state FROM device_upload_authorizations WHERE id=?').bind(insert.deviceUploadAuthorizationId).first('state')).toBe('consumed');
   const id=await source().prepare('SELECT max(id) id FROM typed_telemetry_records').first<number>('id');
   const rows=await readTypedTelemetryRowsByStorageIds(source(),{sourceNamespace:namespace,participantId:insert.participantId,storageRowIds:[id!]});
   expect(rows[0]!.record_json).toBe(canonicalTelemetryV11Json(insert.chunk.records[0]));
   expect(rows[0]!.source_row_id).toBe(id);
  }
  expect(await count('telemetry_v1_records')).toBe(0);expect(await changes()).toHaveLength(3);
  expect(await count('community_graph_update_scope')).toBe(0);
 });
 it('replays a lost committed response without new IDs, admission charges or journal events',async()=>{
  const {insert}=await seed();const lost=withBatch(async statements=>{await source().batch(statements);throw new Error('synthetic lost response');});
  expect(await insertTypedTelemetryV1Chunk(lost,insert,namespace)).toMatchObject({replay:true});
  expect(await insertTypedTelemetryV1Chunk(source(),insert,namespace)).toMatchObject({replay:true});
  expect(await changes()).toHaveLength(1);expect(await count('typed_v1_record_admissions')).toBe(1);
  expect((await validateTypedTelemetryV1Receipt(source(),{sourceNamespace:namespace,participantId:insert.participantId,deviceId:insert.deviceId,chunkRowId:insert.chunkRowId}))?.id).toBe(insert.chunkRowId);
  await expect(validateTypedTelemetryV1Receipt(source(),{sourceNamespace:'wrong-source',participantId:insert.participantId,deviceId:insert.deviceId,chunkRowId:insert.chunkRowId})).rejects.toThrow();
  expect(await source().prepare('SELECT next_source_row_id FROM typed_v1_admission_state').first('next_source_row_id')).toBe(2);
 });
 it('supersedes exactly its original current rows and proves obsolete events without claiming withdrawal',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
  const old=(await changes())[0]!;const next=await seed('usage',2,first.fixture,2);
  next.insert.supersedes=await currentTelemetryV1Chunk(source(),first.fixture.participantId,first.fixture.deviceId,'usage',day(),0);
  await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  expect(await count('typed_telemetry_records')).toBe(2);expect(await count('telemetry_v1_chunks')).toBe(2);
  expect((await validateTypedTelemetryV1Receipt(source(),{sourceNamespace:namespace,participantId:first.insert.participantId,deviceId:first.insert.deviceId,chunkRowId:first.insert.chunkRowId}))?.superseded_at).not.toBeNull();
  expect((await changes()).map(e=>e.kind)).toEqual(['owner-active','owner-active']);
  expect(await lookupTypedV1Source(source(),old)).toMatchObject({disposition:'superseded',supersedingEventDigest:(await changes())[1]!.eventDigest});
  expect(await lookupTypedV1Source(source(),(await changes())[1]!)).toMatchObject({disposition:'chunk',revision:2});
  expect((await source().prepare('SELECT source_row_id FROM typed_telemetry_records ORDER BY source_row_id').all()).results).toEqual([{source_row_id:2},{source_row_id:3}]);
 });
 it('refuses stealing an occurrence from another current chunk and rolls all effects back',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
  const second=await seed('usage',1,first.fixture,1,1);
  await expect(insertTypedTelemetryV1Chunk(source(),second.insert,namespace)).rejects.toMatchObject({code:'RECORD_OWNED_BY_OTHER_CHUNK'});
  expect(await count('telemetry_v1_chunks')).toBe(1);expect(await changes()).toHaveLength(1);
  expect(await source().prepare('SELECT next_source_row_id FROM typed_v1_admission_state').first('next_source_row_id')).toBe(2);
 });
 it('rolls back correction, authorization and allocation on a late journal failure',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
  const next=await seed('usage',2,first.fixture,2);next.insert.supersedes=await currentTelemetryV1Chunk(source(),first.fixture.participantId,first.fixture.deviceId,'usage',day(),0);
  await source().prepare("CREATE TRIGGER synthetic_journal_failure BEFORE INSERT ON typed_v1_event_sources BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  await expect(insertTypedTelemetryV1Chunk(source(),next.insert,namespace)).rejects.toThrow('synthetic failure');
  expect((await currentTelemetryV1Chunk(source(),first.fixture.participantId,first.fixture.deviceId,'usage',day(),0))!.id).toBe(first.insert.chunkRowId);
  expect(await count('typed_telemetry_records')).toBe(1);expect(await changes()).toHaveLength(1);
  expect(await source().prepare('SELECT state FROM device_upload_authorizations WHERE id=?').bind(next.insert.deviceUploadAuthorizationId).first('state')).toBe('consuming');
 });
 it('rejects revoked authority inside the transaction and mixed JSON writes',async()=>{
  const {insert}=await seed();const revoked=withBatch(async statements=>{
   await source().prepare("UPDATE device_credentials SET state='revoked',revoked_at=? WHERE id=?").bind(new Date().toISOString(),insert.deviceId).run();return source().batch(statements);
  });
  await expect(insertTypedTelemetryV1Chunk(revoked,insert,namespace)).rejects.toThrow();expect(await count('typed_telemetry_records')).toBe(0);expect(await changes()).toEqual([]);
  const fresh=await seed();await expect(insertTelemetryV1Chunk(source(),fresh.insert)).rejects.toMatchObject({code:'UPLOAD_AUTH_INVALID'});
  expect(await count('telemetry_v1_records')).toBe(0);
 });
 it('serializes competing numeric allocations and retries only the uncommitted chunk',async()=>{
  const a=await seed();const b=await seed('quota',1,a.fixture);
  let calls=0;let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const raced=withBatch(async statements=>{calls++;if(calls===2)release();await barrier;return source().batch(statements);});
  const inputs=[a.insert,b.insert];const outcomes=await Promise.allSettled(inputs.map(insert=>insertTypedTelemetryV1Chunk(raced,insert,namespace)));
  expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
  const index=outcomes.findIndex(outcome=>outcome.status==='rejected');
  expect((outcomes[index] as PromiseRejectedResult).reason).toMatchObject({code:'UPLOAD_IN_PROGRESS'});
  await insertTypedTelemetryV1Chunk(source(),inputs[index]!,namespace);
  expect(await count('typed_telemetry_records')).toBe(2);expect(await changes()).toHaveLength(2);
  expect(await source().prepare('SELECT count(DISTINCT source_row_id) n FROM typed_telemetry_records').first('n')).toBe(2);
 });
 it('handles full200 distinct contexts and sessions and participant erasure while keeping terminal owner proof',async()=>{
  const {insert}=await seed('usage',200);
  insert.chunk.records=insert.chunk.records.map((r,i)=>({...r,modelId:`synthetic-model-${i}`,sessionUuid:`${i.toString(16).padStart(8,'0')}-8b2d-4c3e-9a6f-2f4f1c7d9e0b`})) as TelemetryV1Record[];
  insert.chunk.chunkDigest=await sha256Hex(canonicalTelemetryV11Json(insert.chunk.records));
  await insertTypedTelemetryV1Chunk(source(),insert,namespace);
  expect(await count('typed_telemetry_records')).toBe(200);
  await expect(source().prepare('DELETE FROM typed_telemetry_usage').run()).rejects.toThrow('typed_v1_current_record_retained');
  await source().prepare('DELETE FROM participants WHERE id=?').bind(insert.participantId).run();
  for(const table of ['typed_telemetry_records','typed_v1_record_admissions','typed_v1_event_sources','typed_telemetry_owners'])expect(await count(table)).toBe(0);
  expect((await changes()).at(-1)!.kind).toBe('owner-erased');
 });
});
