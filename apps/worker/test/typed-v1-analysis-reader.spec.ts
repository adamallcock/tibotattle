import { createV1QuotaPageReader,backfillV1QuotaFitProjection } from '../src/quota-fit-projection';
import { readV1UsagePage,accountScopedQuotaAnalysisV1,accountScopedModelCompositionV1 } from '../src/quota-analysis-v1';
import { loadV1SourcePin } from '../src/telemetry-v1-source-selection';
import { createTypedV1QuotaPageReader,loadTypedV1AnalysisScope,TYPED_V1_PLAN_PAGE_SQL,TYPED_V1_FIT_PAGE_SQL,
 TYPED_V1_USAGE_AT_TIME_SQL,typedV1MultiPlanPageSql,typedV1MultiFitPageSql,typedV1MultiUsagePageSql } from '../src/typed-v1-analysis-reader';
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
import { persistTypedTelemetryBatch } from '../src/typed-telemetry-repository';
import { encodeTypedTelemetryId } from '../src/typed-telemetry-codec';
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from '../src/typed-telemetry-origins';
import { V1_ORIGIN_CURSOR_VERSION } from '../src/quota-analysis-v1-reader';
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
async function seed(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1, fixture = undefined as Awaited<ReturnType<typeof createV11DeviceFixture>> | undefined, revision=1, seq=0,recordOffset=0) {
  fixture ??= await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(day(), 'a', { eventId: `event:v2:${(i+recordOffset).toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${(i+recordOffset).toString(16).padStart(64, '0')}`,
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

const bytes=(value:string)=>Uint8Array.from(encodeTypedTelemetryId(value)).buffer;
async function admitRetainedV1(input:Awaited<ReturnType<typeof seed>>,sourceNamespace:string){
 // Create the authenticated local header through the ordinary current lane,
 // then replace only its synthetic typed copy with the retained provenance
 // fixture that a future copier would have installed.
 await insertTypedTelemetryV1Chunk(source(),input.insert,namespace);
 const currentNamespaceId=(await source().prepare('SELECT namespace_id FROM typed_v1_chunk_allocations WHERE chunk_id=?')
  .bind(input.insert.chunkRowId).first<number>('namespace_id'))!;
 const retainedTrigger=(await source().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='typed_v1_current_record_retained'")
  .first<string>('sql'))!;
 await source().exec('DROP TRIGGER typed_v1_current_record_retained');
 await source().prepare('DELETE FROM typed_v1_record_admissions WHERE chunk_id=?').bind(input.insert.chunkRowId).run();
 await source().prepare('DELETE FROM typed_v1_chunk_allocations WHERE chunk_id=?').bind(input.insert.chunkRowId).run();
 await source().prepare('DELETE FROM typed_telemetry_chunks WHERE namespace_id=? AND format=10 AND original_id=?')
  .bind(currentNamespaceId,bytes(input.insert.chunkRowId)).run();
 await source().prepare(retainedTrigger).run();
 const retainedRows=input.insert.chunk.records.map((record,index)=>({sourceNamespace,format:'v1' as const,
  sourceRowId:index+1,participantId:input.insert.participantId,deviceId:input.insert.deviceId,
  chunkRowId:input.insert.chunkRowId,manifestId:null,chunkDay:input.insert.chunk.chunkId.split(':')[1]!,
  observedDay:(record as {observedTime?:string;eventTime?:string}).observedTime?.slice(0,10)
    ??(record as {eventTime:string}).eventTime.slice(0,10),record}));
 const allocationTrigger=(await source().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='typed_v1_allocated_row'")
  .first<string>('sql'))!;
 await source().exec('DROP TRIGGER typed_v1_allocated_row');
 await persistTypedTelemetryBatch(source(),retainedRows);
 await source().prepare(allocationTrigger).run();
 const namespaceId=(await source().prepare('SELECT id FROM typed_telemetry_namespaces WHERE original_id=?').bind(bytes(sourceNamespace)).first<number>('id'))!;
 await source().prepare(`INSERT INTO typed_telemetry_origin_contracts(namespace_id,namespace_original,access_mode,
  v1_read_contract_version,v11_read_contract_version,source_schema_digest,registered_move_id,registered_at)
  VALUES(?,?,'retained-read',2,0,?,'synthetic-reader-move','2026-09-13T00:00:00.000Z')`)
  .bind(namespaceId,bytes(sourceNamespace),TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).run();
 const ownerId=(await source().prepare('SELECT id FROM typed_telemetry_owners WHERE namespace_id=? AND original_id=?')
  .bind(namespaceId,bytes(input.insert.participantId)).first<number>('id'))!;
 await source().prepare('INSERT INTO typed_v1_owner_memberships(participant_id,namespace_id,typed_owner_id) VALUES(?,?,?)')
  .bind(input.insert.participantId,namespaceId,ownerId).run();
 const allocationGuards=[];
 for(const name of ['typed_v1_allocation_guard','typed_v1_allocation_advance']){
  allocationGuards.push((await source().prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?').bind(name).first<string>('sql'))!);
  await source().exec(`DROP TRIGGER ${name}`);
 }
 await source().prepare(`INSERT INTO typed_v1_chunk_allocations(chunk_id,namespace_id,chunk_original,first_source_row_id,record_count)
  VALUES(?,?,?,?,?)`).bind(input.insert.chunkRowId,namespaceId,bytes(input.insert.chunkRowId),1,input.insert.chunk.records.length).run();
 for(const sql of allocationGuards)await source().prepare(sql).run();
 const records=(await source().prepare('SELECT id FROM typed_telemetry_records WHERE namespace_id=? AND format=10 ORDER BY source_row_id')
  .bind(namespaceId).all<{id:number}>()).results;
 await source().batch(records.map(record=>source().prepare('INSERT INTO typed_v1_record_admissions(typed_record_id,chunk_id) VALUES(?,?)')
  .bind(record.id,input.insert.chunkRowId)));
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
 it('pages two qualified origins by namespace without relabeling colliding source row IDs',async()=>{
  const current=await seed('quota',1,undefined,1,0,100);await insertTypedTelemetryV1Chunk(source(),current.insert,namespace);
  const retainedNamespace='synthetic-v1-origin-a';const retained=await seed('quota',1,current.fixture,1,1,0);
  await admitRetainedV1(retained,retainedNamespace);
  const scope=(await loadTypedV1AnalysisScope(source(),current.fixture.participantId))!;
  expect(scope.origins.map(origin=>origin.sourceNamespace)).toEqual([retainedNamespace,namespace]);
  const originBindings=scope.origins.flatMap(origin=>[origin.sourceNamespace,origin.typedOwnerId]);
  const plans=await Promise.all([
   source().prepare(`EXPLAIN QUERY PLAN ${typedV1MultiPlanPageSql(scope.origins.length)}`)
    .bind(Date.parse(`${day()}T00:00:00.000Z`),'',0,1,8_640_000_000_000_001,...originBindings).all<{detail:string}>(),
   source().prepare(`EXPLAIN QUERY PLAN ${typedV1MultiFitPageSql(scope.origins.length)}`)
    .bind(2,Date.parse(`${day()}T13:00:00.000Z`),Date.parse(`${day()}T00:00:00.000Z`),'',0,1,...originBindings)
    .all<{detail:string}>(),
   source().prepare(`EXPLAIN QUERY PLAN ${typedV1MultiUsagePageSql(scope.origins.length)}`)
    .bind('[]',Date.parse(`${day()}T00:00:00.000Z`),'',0,1,8_640_000_000_000_001,...originBindings).all<{detail:string}>(),
  ]);
  for(const plan of plans)expect(plan.results.some(row=>row.detail.includes('MATERIALIZE typed_v1_current_records'))).toBe(false);
  expect(plans[0].results.filter(row=>row.detail.includes('SEARCH r USING')&&row.detail.includes('typed_v1_owner_observed')))
   .toHaveLength(scope.origins.length);
  expect(plans[1].results.filter(row=>row.detail.includes('SEARCH q USING INDEX typed_v1_quota_reset')))
   .toHaveLength(scope.origins.length);
  expect(plans[2].results.filter(row=>row.detail.includes('SEARCH base USING')&&row.detail.includes('typed_v1_owner_observed')))
   .toHaveLength(scope.origins.length);
  const reader=createTypedV1QuotaPageReader(source(),scope);
  expect(reader.cursorVersion).toBe(V1_ORIGIN_CURSOR_VERSION);
  const initial={cursorVersion:V1_ORIGIN_CURSOR_VERSION,sourceNamespace:'',observedAt:`${day()}T00:00:00.000Z`,id:0} as const;
  const first=await reader.readPlanPage(initial,1);
  expect(first).toMatchObject([{id:1,source_namespace:retainedNamespace}]);
  const second=await reader.readPlanPage({...initial,observedAt:first[0]!.observed_at,
    sourceNamespace:first[0]!.source_namespace!,id:first[0]!.id},1);
  expect(second).toMatchObject([{id:1,source_namespace:namespace}]);
  const fitInitial={cursorVersion:V1_ORIGIN_CURSOR_VERSION,sourceNamespace:'',resetsAt:'1970-01-01T00:00:00.000Z',
    observedAt:'',id:0} as const;
  const fitFirst=await reader.readFitPage(fitInitial,1);
  expect(fitFirst).toMatchObject([{id:1,source_namespace:retainedNamespace}]);
  const fitSecond=await reader.readFitPage({...fitInitial,resetsAt:fitFirst[0]!.resets_at,
    observedAt:fitFirst[0]!.observed_at,sourceNamespace:fitFirst[0]!.source_namespace!,id:fitFirst[0]!.id},1);
  expect(fitSecond).toMatchObject([{id:1,source_namespace:namespace}]);
 expect((await source().prepare(`SELECT source_namespace,source_row_id FROM typed_v1_current_records
    WHERE participant_id=? ORDER BY source_namespace COLLATE BINARY`).bind(current.fixture.participantId).all()).results)
    .toEqual([{source_namespace:retainedNamespace,source_row_id:1},{source_namespace:namespace,source_row_id:1}]);
 });
 it('drains colliding usage row IDs from two origins exactly once',async()=>{
  const current=await seed('usage',1,undefined,1,0,100);await insertTypedTelemetryV1Chunk(source(),current.insert,namespace);
  const retainedNamespace='synthetic-v1-origin-a';const retained=await seed('usage',1,current.fixture,1,1,0);
  await admitRetainedV1(retained,retainedNamespace);
  const scope=(await loadTypedV1AnalysisScope(source(),current.fixture.participantId))!;
  const pin=await loadV1SourcePin(source(),{participantId:current.fixture.participantId});
  const first=await readV1UsagePage(source(),pin.winnersJson,current.fixture.participantId,`${day()}T00:00:00.000Z`,0,1,
    undefined,scope,'');
  expect(first).toMatchObject([{id:1,source_namespace:retainedNamespace}]);
  const second=await readV1UsagePage(source(),pin.winnersJson,current.fixture.participantId,first[0]!.observed_at,first[0]!.id,1,
    undefined,scope,first[0]!.source_namespace);
  expect(second).toMatchObject([{id:1,source_namespace:namespace}]);
  const done=await readV1UsagePage(source(),pin.winnersJson,current.fixture.participantId,second[0]!.observed_at,second[0]!.id,1,
    undefined,scope,second[0]!.source_namespace);
  expect(done).toEqual([]);
  expect(new Set([...first,...second].map(row=>row.occurrence_id)).size).toBe(2);
 });
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
