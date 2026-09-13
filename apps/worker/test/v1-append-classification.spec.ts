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

const bindings=env as Env & {TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]};
const source=()=>bindings.USAGE_MONITOR_DB, namespace='synthetic-v1-source', sourceId='synthetic-v1-journal';
const day=()=>new Date().toISOString().slice(0,10);
const changes=()=>readIngestionChanges(source(),sourceId,0);
const count=(table:string)=>source().prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
beforeEach(async()=>{
 await reset();await applyD1Migrations(source(),bindings.TEST_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_INGESTION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV1Admission(source(),namespace);
});
function withBatch(batch:D1Database['batch']):D1Database{return new Proxy(source(),{get(db,key){if(key==='batch')return batch;
 const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});}
async function seed(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1, fixture = undefined as Awaited<ReturnType<typeof createV11DeviceFixture>> | undefined, revision=1, seq=0, offset=0) {
  fixture ??= await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(day(), 'a', { eventId: `event:v2:${(i+offset).toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${(i+offset).toString(16).padStart(64, '0')}`,
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

async function stamp(){return {
 authority:await source().prepare('SELECT authority_epoch FROM storage_source_state').first<number>('authority_epoch'),
 hard:await source().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first<number>('graph_invalidation_epoch')};}
describe('isolated typed v1 conservative append classification',()=>{
 it('keeps a completed owner authority across 200-record append with one event and exact receipt replay',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);const before=await stamp();
  const next=await seed('usage',200,first.fixture,1,1,1);
  await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  const events=await changes();expect(events.map(e=>e.kind)).toEqual(['owner-active','source-updated']);
  expect(events[1]!.authorityEpoch).toBe(events[0]!.authorityEpoch);expect(await stamp()).toEqual(before);
  expect(await count('typed_telemetry_records')).toBe(201);expect(await count('telemetry_v1_records')).toBe(0);
  expect(await lookupTypedV1Source(source(),events[1]!)).toMatchObject({disposition:'chunk',chunkId:next.insert.chunkRowId});
  expect(await validateTypedTelemetryV1Receipt(source(),{sourceNamespace:namespace,participantId:first.fixture.participantId,
   deviceId:first.fixture.deviceId,chunkRowId:next.insert.chunkRowId})).toMatchObject({accepted_record_count:200});
  expect(await insertTypedTelemetryV1Chunk(source(),next.insert,namespace)).toMatchObject({replay:true});expect(await changes()).toHaveLength(2);
 });
 it('keeps supersession hard even when the replacement retains the old occurrence',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);const before=await stamp();
  const next=await seed('usage',2,first.fixture,2);next.insert.supersedes=await currentTelemetryV1Chunk(source(),first.fixture.participantId,first.fixture.deviceId,'usage',day(),0);
  await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  expect((await changes()).map(e=>e.kind)).toEqual(['owner-active','owner-active']);
  expect((await stamp()).authority).toBeGreaterThan(before.authority!);
 });
 it('keeps another device hard even with disjoint occurrences and a unique chunk slot',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);const before=await stamp();
  const other=await createV11DeviceFixture(source(),{participantId:first.fixture.participantId});
  const next=await seed('usage',1,other,1,1,4);await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  expect((await changes()).at(-1)!.kind).toBe('owner-active');expect((await stamp()).authority).toBeGreaterThan(before.authority!);
  expect(await count('typed_telemetry_records')).toBe(2);
 });
 it('keeps a legacy-format crossover hard even for a unique same-device append',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v0.2'").run();
  const owner=first.fixture,upload=`upload:${crypto.randomUUID()}`,contribution=`contribution:${crypto.randomUUID()}`;
  const digest='f'.repeat(64),now=new Date().toISOString(),future=new Date(Date.now()+86400000).toISOString();
  await source().batch([
   source().prepare("INSERT INTO upload_authorizations(id,participant_id,issued_by_session_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at) VALUES(?,?,?,?,?,1,'application/json','consuming',?,?,?)").bind(upload,owner.participantId,owner.sessionId,new Uint8Array(32).buffer,digest,now,future,future),
   source().prepare("INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,schema_version,range_start,range_end,client_platform,provider_policy_epoch,estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at,upload_authorization_id,transport_schema_version,dataset_id,dataset_part_index,dataset_part_count,dataset_completeness,dataset_range_start,dataset_range_end) VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1',?,?,'macos','synthetic',NULL,100,0,0,'server_repricing',1,?,?,'telemetry-contribution-v0.2',?,1,1,'complete',?,?)")
    .bind(contribution,owner.participantId,digest,digest,'synthetic/crossover',now,now,now,upload,`dataset:v1:${digest}`,now,now),
  ]);
  const before=await stamp(),next=await seed('usage',1,first.fixture,1,1,7);
  await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  expect((await changes()).at(-1)!.kind).toBe('owner-active');expect((await stamp()).authority).toBeGreaterThan(before.authority!);
 });
 it('refuses occurrence stealing and rolls back header, allocator and event',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);const before=await stamp();
  const next=await seed('usage',1,first.fixture,1,1);
  await expect(insertTypedTelemetryV1Chunk(source(),next.insert,namespace)).rejects.toMatchObject({code:'RECORD_OWNED_BY_OTHER_CHUNK'});
  expect(await changes()).toHaveLength(1);expect(await count('telemetry_v1_chunks')).toBe(1);expect(await stamp()).toEqual(before);
  expect(await source().prepare('SELECT next_source_row_id FROM typed_v1_admission_state').first('next_source_row_id')).toBe(2);
 });
 it('requires the exact transaction request for soft classification and keeps unknown events hard',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);const before=await stamp();
  // Remove only the classification evidence after actual header admission.
  // Restore/bootstrap never has this live request either; absence cannot confer append status.
  await source().prepare(`CREATE TRIGGER synthetic_missing_request BEFORE INSERT ON typed_v1_event_sources
   BEGIN DELETE FROM typed_v1_authority_requests WHERE chunk_id=NEW.chunk_id; END`).run();
  const next=await seed('usage',1,first.fixture,1,1,3);await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);
  expect((await changes()).at(-1)!.kind).toBe('owner-active');expect((await stamp()).authority).toBeGreaterThan(before.authority!);
 });
 it('refuses revoked authority and retains the pre-pass state on a late journal failure',async()=>{
  const first=await seed();await insertTypedTelemetryV1Chunk(source(),first.insert,namespace);
  const next=await seed('usage',1,first.fixture,1,1,3);const before=await stamp();
  await source().prepare(`CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON storage_ingestion_changes
   BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END`).run();
  await expect(insertTypedTelemetryV1Chunk(source(),next.insert,namespace)).rejects.toThrow('synthetic event failure');
  expect(await stamp()).toEqual(before);expect(await count('typed_telemetry_records')).toBe(1);expect(await changes()).toHaveLength(1);
  await source().prepare('DROP TRIGGER synthetic_event_failure').run();
  const revoked=withBatch(async statements=>{await source().prepare("UPDATE device_credentials SET state='revoked',revoked_at=? WHERE id=?")
   .bind(new Date().toISOString(),first.fixture.deviceId).run();return source().batch(statements);});
  await expect(insertTypedTelemetryV1Chunk(revoked,next.insert,namespace)).rejects.toThrow();expect(await count('typed_telemetry_records')).toBe(1);
 });
});
