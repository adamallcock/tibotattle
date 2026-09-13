import { advanceV1DailyProjection,readV1ProjectedChunkPage,retireV1DailyProjectionPage } from '../src/v1-daily-projection';
import { mergeV11DailyProjectionValues,createV11DailyProjectionValues } from '../src/v11-daily-projection-values';
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
 TEST_ANALYTICS_MIGRATIONS:D1Migration[]; STORAGE_ANALYTICS_DB:D1Database; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[]};
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
 await applyD1Migrations(bindings.STORAGE_ANALYTICS_DB,bindings.TEST_ANALYTICS_MIGRATIONS);
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

const target=()=>bindings.STORAGE_ANALYTICS_DB;
const step=(db=target())=>advanceV1DailyProjection({source:source(),target:db,sourceId,sourceNamespace:namespace});
const owner=async()=> (await changes())[0]!.ownerDigest;
const read=async(options:{limit?:number;afterIndex?:number;fingerprint?:string}={})=>readV1ProjectedChunkPage({source:source(),target:target(),sourceId,sourceNamespace:namespace,ownerDigest:await owner(),day:day(),...options});
function targetBatch(batch:D1Database['batch']):D1Database{return new Proxy(target(),{get(db,key){if(key==='batch')return batch;
 const v=Reflect.get(db,key);return typeof v==='function'?v.bind(db):v;}});}
describe('separate typed v1 analytical projection',()=>{
 it('reads exact disjoint values only when caught up, and retains no private IDs',async()=>{
  const a=await seed();const b=await seed('quota',1,a.fixture);
  await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);
  await step();expect(await read()).toBeNull();await step();
  const first=await read({limit:1});expect(first!.nextIndex).toBe(1);
  const second=await read({limit:1,afterIndex:1,fingerprint:first!.fingerprint});expect(second!.nextIndex).toBeNull();
  const values=[...first!.values,...second!.values].reduce(mergeV11DailyProjectionValues,createV11DailyProjectionValues(day()));
  expect(values.counts).toEqual({usage:1,quota:1,session:0});expect(values.tokens.nonOverlappingTotal.knownSum).toBe('1075');
  const retained=JSON.stringify((await target().prepare('SELECT * FROM analytics_v1_chunk_values').all()).results);
  for(const privateId of [a.insert.participantId,a.insert.deviceId,a.insert.chunkRowId,'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b'])expect(retained).not.toContain(privateId);
 });
 it('delivers all200 distinct valid model cells from an accepted maximum-size chunk',async()=>{
  const a=await seed('usage',200);
  a.insert.chunk.records.forEach((r,i)=>{(r as any).modelId=`synthetic-model-${i}`;});
  a.insert.chunk.chunkDigest=await sha256Hex(canonicalTelemetryV11Json(a.insert.chunk.records));
  await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  expect(await step()).toMatchObject({state:'applied',recordsRead:200});
  const values=(await read())!.values[0]!;
  expect(values.cells).toHaveLength(200);expect(values.counts.usage).toBe(200);
  expect(new Set(values.cells.map(c=>c.modelId))).toEqual(new Set(Array.from({length:200},(_,i)=>`synthetic-model-${i}`)));
  expect(values.tokens.nonOverlappingTotal.knownSum).toBe('215000');
  expect(await step()).toMatchObject({state:'idle'});
 });
 it('replaces a corrected slot atomically, with failed projection leaving its cursor and prior value intact',async()=>{
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);await step();
  const b=await seed('usage',2,a.fixture,2);b.insert.supersedes=await currentTelemetryV1Chunk(source(),a.fixture.participantId,a.fixture.deviceId,'usage',day(),0);
  await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);expect(await read()).toBeNull();
  await target().prepare("CREATE TRIGGER synthetic_projection_failure BEFORE UPDATE ON analytics_v1_chunk_values BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  await expect(step()).rejects.toThrow('ANALYTICS_DELIVERY_UNACKNOWLEDGED');
  expect(await target().prepare('SELECT sequence FROM analytics_source_cursors').first('sequence')).toBe(1);
  await target().prepare('DROP TRIGGER synthetic_projection_failure').run();await step();
  expect((await read())!.values[0]!.counts.usage).toBe(2);
  expect(await target().prepare('SELECT count(*) n FROM analytics_v1_chunk_values').first('n')).toBe(1);
 });
 it('converges concurrent delivery and a lost target response without duplicate totals',async()=>{
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  const lost=targetBatch(async statements=>{await target().batch(statements);throw new Error('synthetic lost response');});
  await Promise.all([step(lost),step()]);expect((await read())!.values[0]!.counts.usage).toBe(1);
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(1);
 });
 it('acknowledges proven supersession without disguising it as withdrawal',async()=>{
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  const b=await seed('usage',2,a.fixture,2);b.insert.supersedes=await currentTelemetryV1Chunk(source(),a.fixture.participantId,a.fixture.deviceId,'usage',day(),0);
  await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);
  expect((await step()).state).toBe('discarded');
  expect(await target().prepare('SELECT disposition FROM analytics_v1_projection_receipts').first('disposition')).toBe('superseded');
  expect(await target().prepare('SELECT state FROM analytics_owner_state').first('state')).toBe('active');
  await step();expect((await read())!.values[0]!.counts.usage).toBe(2);
 });
 it('elects one device instead of summing alternate captures',async()=>{
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  await source().prepare('UPDATE telemetry_v1_chunks SET created_at=? WHERE id=?').bind(`${day()}T00:00:00.000Z`,a.insert.chunkRowId).run();
  const f=await createV11DeviceFixture(source(),{participantId:a.fixture.participantId});const b=await seed('usage',2,f);
  await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);await step();await step();
  const value=await read();expect(value!.totalChunks).toBe(1);expect(value!.values[0]!.counts.usage).toBe(2);
 });
 it('fences withdrawal immediately, preserves reversible summaries, and purges erasure in bounded pages',async()=>{
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);await step();
  await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(a.fixture.participantId).run();
  expect(await read()).toBeNull();await step();
  expect(await retireV1DailyProjectionPage(target(),sourceId,1)).toEqual({state:'idle',deleted:0});
  expect(await target().prepare('SELECT count(*) n FROM analytics_v1_chunk_values').first('n')).toBe(1);
  await source().prepare("UPDATE participants SET state='active' WHERE id=?").bind(a.fixture.participantId).run();
  expect(await read()).toBeNull();
  const next=await seed('quota',1,a.fixture);await insertTypedTelemetryV1Chunk(source(),next.insert,namespace);await step();
  expect((await read())!.totalChunks).toBe(2);
  await source().prepare('DELETE FROM participants WHERE id=?').bind(a.fixture.participantId).run();await step();
  expect(await retireV1DailyProjectionPage(target(),sourceId,1)).toEqual({state:'retiring',deleted:1});
  expect(await retireV1DailyProjectionPage(target(),sourceId,1)).toEqual({state:'retiring',deleted:1});
  expect(await retireV1DailyProjectionPage(target(),sourceId,1)).toEqual({state:'idle',deleted:0});
  expect(await read()).toBeNull();
 });
 it('rejects a wrong namespace and refuses page continuation after source mutation',async()=>{
  const a=await seed();const b=await seed('quota',1,a.fixture);await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);
  await expect(advanceV1DailyProjection({source:source(),target:target(),sourceId,sourceNamespace:'wrong'})).rejects.toThrow();
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
  await step();await step();const first=await read({limit:1});
  await source().prepare('UPDATE telemetry_v1_chunks SET parser_version=? WHERE id=?').bind('synthetic-new-parser',a.insert.chunkRowId).run();
  await expect(read({afterIndex:1,fingerprint:first!.fingerprint})).rejects.toThrow();
 });
});
