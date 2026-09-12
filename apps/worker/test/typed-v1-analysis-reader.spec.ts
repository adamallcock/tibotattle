import { createV1QuotaPageReader,backfillV1QuotaFitProjection } from '../src/quota-fit-projection';
import { readV1UsagePage,accountScopedQuotaAnalysisV1,accountScopedModelCompositionV1 } from '../src/quota-analysis-v1';
import { loadV1SourcePin } from '../src/telemetry-v1-source-selection';
import { loadTypedV1AnalysisScope,TYPED_V1_PLAN_PAGE_SQL,TYPED_V1_FIT_PAGE_SQL,TYPED_V1_USAGE_AT_TIME_SQL } from '../src/typed-v1-analysis-reader';
import { decodeTypedTelemetryUsageAnalysisRows,MAX_TYPED_V1_USAGE_ANALYSIS_BYTES } from '../src/typed-telemetry-compatibility';
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
 STORAGE_ANALYTICS_DB:D1Database; TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[]};
const source=()=>bindings.USAGE_MONITOR_DB, namespace='synthetic-v1-source', sourceId='synthetic-v1-journal';
const day=()=>new Date().toISOString().slice(0,10);
const changes=()=>readIngestionChanges(source(),sourceId,0);
const count=(table:string)=>source().prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
beforeEach(async()=>{
 await reset();await applyD1Migrations(source(),bindings.TEST_MIGRATIONS);
 await applyD1Migrations(bindings.STORAGE_ANALYTICS_DB,bindings.TEST_MIGRATIONS);
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


const raw=()=>bindings.STORAGE_ANALYTICS_DB;
type Fixture=Awaited<ReturnType<typeof createV11DeviceFixture>>;
async function pair(){const typed=await createV11DeviceFixture(source());const original=await createV11DeviceFixture(raw(),{participantId:typed.participantId});return {typed,original};}
async function write(database:D1Database,f:Fixture,records:TelemetryV1Record[],stream:'quota'|'usage'|'session',seq:number){
 const envelopeDigest=await sha256Hex(`synthetic-reader-${crypto.randomUUID()}`),device=await authenticateDevice(database,f.authorization);
 const authorization=await createDeviceUploadAuthorization(database,device,envelopeDigest,200);
 const claim=await claimDeviceUploadAuthorization(database,`Upload ${authorization.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${stream}:${day()}:${seq}`,chunkRevision:1,
  chunkDigest:await sha256Hex(canonicalTelemetryV11Json(records)),parserVersion:'synthetic-reader',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
 const insert={chunkRowId:`chunk:${crypto.randomUUID()}`,participantId:f.participantId,deviceId:f.deviceId,chunk,envelopeDigest,r2Key:`synthetic/reader-${crypto.randomUUID()}`,deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null};
 if(database===source())await insertTypedTelemetryV1Chunk(database,insert,namespace);else await insertTelemetryV1Chunk(database,insert);
}
async function both(f:Awaited<ReturnType<typeof pair>>,records:TelemetryV1Record[],stream:'quota'|'usage',seq=0){await write(source(),f.typed,records,stream,seq);await write(raw(),f.original,records,stream,seq);}
const normalize=(rows:unknown[])=>JSON.parse(JSON.stringify(rows).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'synthetic-device'));
function quota(i:number,resetsAt=`${day()}T23:00:00.000Z`):TelemetryV1Record{return {schemaVersion:'quota-observation-v1.0',observationId:`synthetic-quota-${i.toString().padStart(8,'0')}`,
 observedTime:`${day()}T12:00:00.000Z`,provider:'openai_codex',planType:i%3?'pro':'plus',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:0.30000000000000004,windowDurationMinutes:10080,resetsAt};}
function usage(i:number):TelemetryV1Record{return JSON.parse(telemetryV11LegacyProjection('usage',v11UsageRecord(day(),'a',{eventId:`event:v2:${i.toString(16).padStart(64,'0')}`}))!.canonicalRecord);}
describe('typed v1 existing analytical reader parity',()=>{
 it('drains time and reset ties with original IDs, exact floats and original ISO reset ordering',async()=>{
  const f=await pair();const records=[quota(0,'+010000-01-01T00:00:00.000Z'),quota(1,'-000001-01-01T00:00:00.000Z'),...Array.from({length:8},(_,i)=>quota(i+2))];
  await both(f,records,'quota');const t=await createV1QuotaPageReader(source(),f.typed.participantId),r=await createV1QuotaPageReader(raw(),f.original.participantId);
  for(const cursor of [{observedAt:`${day()}T00:00:00.000Z`,id:0},{observedAt:`${day()}T12:00:00.000Z`,id:3}]){
   expect(normalize(await t.readPlanPage(cursor,3))).toEqual(normalize(await r.readPlanPage(cursor,3)));
  }
  for(const resetsAt of ['+010000-01-01T00:00:00.000Z','-000001-01-01T00:00:00.000Z',`${day()}T23:00:00.000Z`]){
   for(const id of [0,4]){const cursor={resetsAt,observedAt:id?`${day()}T12:00:00.000Z`:'',id};
    expect(normalize(await t.readFitPage(cursor,3))).toEqual(normalize(await r.readFitPage(cursor,3)));}
  }
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v1_quota_fit_rows').first('n')).toBe(0);
  expect(await backfillV1QuotaFitProjection(source())).toMatchObject({status:'complete',pagesRun:0,queriesUsed:2,throughRecordId:10});
  await expect(source().prepare('UPDATE typed_telemetry_quota SET analysis_source_row_id=999').run()).rejects.toThrow();
 });
 it('returns a complete5000-row usage page with the original JSON and two physical queries',async()=>{
  const f=await pair();for(let chunk=0;chunk<25;chunk++)await both(f,Array.from({length:200},(_,i)=>usage(chunk*200+i)),'usage',chunk);
  const tp=await loadV1SourcePin(source(),{participantId:f.typed.participantId}),rp=await loadV1SourcePin(raw(),{participantId:f.original.participantId});
  let queries=0;const measured=new Proxy(source(),{get(db,key){if(key==='prepare')return(sql:string)=>{queries++;return db.prepare(sql);};const v=Reflect.get(db,key);return typeof v==='function'?v.bind(db):v;}});
  const scope=await loadTypedV1AnalysisScope(source(),f.typed.participantId);const before=queries;
  const typed=await readV1UsagePage(measured,tp.winnersJson,f.typed.participantId,`${day()}T00:00:00.000Z`,0,5000,undefined,scope);
  expect(queries-before).toBe(2);expect(typed).toHaveLength(5000);
  const original=await readV1UsagePage(raw(),rp.winnersJson,f.original.participantId,`${day()}T00:00:00.000Z`,0,5000,undefined,null);
  expect(typed).toEqual(original);
  const canonicalBytes=new TextEncoder().encode(JSON.stringify(typed)).byteLength;
  expect(canonicalBytes).toBeLessThan(MAX_TYPED_V1_USAGE_ANALYSIS_BYTES);
  console.info(JSON.stringify({syntheticUsageRows:typed.length,canonicalBytes,sourceReadQueries:queries-before}));
  expect(await readV1UsagePage(source(),tp.winnersJson,f.typed.participantId,typed.at(-1)!.observed_at,typed.at(-1)!.id,5000,undefined,scope)).toEqual([]);
 },30000);
 it('preserves the actual scalar and composition kernels through typed source selection',async()=>{
  const f=await pair(),base=Date.parse(`${day()}T00:00:00.000Z`),at=(hours:number)=>new Date(base+hours*3600000).toISOString();
  const q=Array.from({length:34},(_,i)=>({...quota(i,at(168)),planType:'pro',observedTime:at(i/2),usedPercent:i*2.5})) as TelemetryV1Record[];
  const u=Array.from({length:33},(_,i)=>({...usage(i),eventTime:at(i/2+0.25)})) as TelemetryV1Record[];
  await both(f,q,'quota');await both(f,u,'usage');const options={nowMs:base+86400000};
  const scalar=await accountScopedQuotaAnalysisV1(source(),f.typed.participantId,options);
  const clean=(value:object)=>{const {inputFingerprint,...rest}=value as Record<string,unknown>;if(inputFingerprint!==undefined)expect(inputFingerprint).toMatch(/^[0-9a-f]{64}$/);return rest;};
  expect(clean(scalar)).toEqual(clean(await accountScopedQuotaAnalysisV1(raw(),f.original.participantId,options)));
  expect(Reflect.get(scalar,'status')).not.toBe('not_testable');
  expect(clean(await accountScopedModelCompositionV1(source(),f.typed.participantId,options))).toEqual(
   clean(await accountScopedModelCompositionV1(raw(),f.original.participantId,options)));
 });
 it('uses declared seek indexes before bounded compatibility expansion',async()=>{
  const f=await pair();await both(f,[quota(0)],'quota');await both(f,[usage(0)],'usage');
  const scope=(await loadTypedV1AnalysisScope(source(),f.typed.participantId))!;
  for(const [sql,args,index] of [
   [TYPED_V1_PLAN_PAGE_SQL,[scope.ownerId,Date.parse(`${day()}T12:00:00.000Z`),0,3],'typed_v1_owner_observed'],
   [TYPED_V1_FIT_PAGE_SQL,[scope.ownerId,2,Date.parse(`${day()}T23:00:00.000Z`),Date.parse(`${day()}T12:00:00.000Z`),0,3],'typed_v1_quota_reset'],
   [TYPED_V1_USAGE_AT_TIME_SQL,[scope.ownerId,JSON.stringify([[f.typed.participantId,day(),f.typed.deviceId]]),Date.parse(`${day()}T12:05:00.000Z`),0,3],'typed_v1_owner_observed'],
  ] as const){const plan=await source().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{detail:string}>();
   expect(plan.results.some(row=>row.detail.includes('SEARCH')&&row.detail.includes(index))).toBe(true);}
 });
 it('refuses unqualified analytical schema instead of returning an empty JSON result',async()=>{
  const f=await pair();await source().prepare('DROP TABLE typed_v1_analytical_schema').run();
  await expect(createV1QuotaPageReader(source(),f.typed.participantId)).rejects.toThrow();
  await expect(backfillV1QuotaFitProjection(source())).rejects.toThrow();
 });
 it('keeps admission and same-slot correction working after removing legacy derived hooks',async()=>{
  await applyD1Migrations(source(),bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  const a=await seed();await insertTypedTelemetryV1Chunk(source(),a.insert,namespace);
  const b=await seed('usage',2,a.fixture,2);b.insert.supersedes=await currentTelemetryV1Chunk(source(),a.fixture.participantId,a.fixture.deviceId,'usage',day(),0);
  await insertTypedTelemetryV1Chunk(source(),b.insert,namespace);expect(await count('typed_telemetry_records')).toBe(2);
  expect(await changes()).toHaveLength(2);expect(await count('community_graph_update_scope')).toBe(0);
 });
});
