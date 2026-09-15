import { advanceV1DailyProjection,advanceV1DailyProjectionPage,readV1ProjectedChunkPage,retireV1DailyProjectionPage } from '../src/v1-daily-projection';
import { initializeStorageAnalyticsRuntime,runStorageAnalyticsPass,runStorageAnalyticsV1CatchupPass } from '../src/storage-analytics-runtime';
import * as storageAnalyticsRuntime from '../src/storage-analytics-runtime';
import { mergeV11DailyProjectionValues,createV11DailyProjectionValues } from '../src/v11-daily-projection-values';
import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture, v11UsageRecord } from './helpers/telemetry-v11';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { currentTelemetryV1Chunk, insertTelemetryV1Chunk, type TelemetryV1ChunkInsert } from '../src/telemetry-v1-repository';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-repository';
import { parseTelemetryV1Chunk, type TelemetryV1Record } from '../src/telemetry-v1';
import { sha256Hex } from '../src/crypto';
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk, lookupTypedV1Source, validateTypedTelemetryV1Receipt } from '../src/typed-v1-admission';
import { initializeTypedV11Admission } from '../src/typed-v11-admission';
import { initializeStorageSource, readIngestionChanges } from '../src/analytics-delivery';
import { readTypedTelemetryRowsByStorageIds } from '../src/typed-telemetry-compatibility';
import { runStorageAnalyticsV1CatchupQueue,STORAGE_ANALYTICS_CATCHUP_CONTROL_SQL,STORAGE_ANALYTICS_CATCHUP_RECEIPT_SQL,
 type StorageAnalyticsV1CatchupMessage } from '../src/storage-analytics-catchup-worker';
const bindings=env as Env & {TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_ANALYTICS_MIGRATIONS:D1Migration[]; STORAGE_ANALYTICS_DB:D1Database; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const source=()=>bindings.USAGE_MONITOR_DB, namespace='synthetic-v1-source', sourceId='synthetic-v1-journal';
const day=()=>new Date().toISOString().slice(0,10);
const changes=()=>readIngestionChanges(source(),sourceId,0);
const count=(table:string)=>source().prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
beforeEach(async()=>{
 await reset();await applyD1Migrations(source(),bindings.TEST_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_INGESTION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
 await applyD1Migrations(source(),(bindings as typeof bindings&{TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[]}).TEST_TYPED_V11_ADMISSION_MIGRATIONS);
 await applyD1Migrations(source(),bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV11Admission(source(),namespace);await initializeTypedV1Admission(source(),namespace);
 await applyD1Migrations(bindings.STORAGE_ANALYTICS_DB,bindings.TEST_ANALYTICS_MIGRATIONS);
 await applyD1Migrations(bindings.DELETION_LEDGER,bindings.TEST_DELETION_LEDGER_MIGRATIONS);
});
function withBatch(batch:D1Database['batch']):D1Database{return new Proxy(source(),{get(db,key){if(key==='batch')return batch;
 const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});}
async function seed(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1, fixture = undefined as Awaited<ReturnType<typeof createV11DeviceFixture>> | undefined, revision=1, seq=0) {
  fixture ??= await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(day(), 'a', { eventId: `event:v2:${(seq*1000+i).toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${(seq*1000+i).toString(16).padStart(64, '0')}`,
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
function observe(database:D1Database){let calls=0,batches=0;const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
 const statement=(inner:D1PreparedStatement):D1PreparedStatement=>{const wrapped=new Proxy(inner,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>statement(value.bind(...args));
  if(['first','all','run','raw'].includes(String(key)))return(...args:unknown[])=>{calls++;return Reflect.apply(Reflect.get(value,key) as Function,value,args);};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});originals.set(wrapped,inner);return wrapped;};
 return {db:new Proxy(database,{get(value,key){if(key==='prepare')return(sql:string)=>statement(value.prepare(sql));
  if(key==='batch')return(items:D1PreparedStatement[])=>{calls++;batches++;return value.batch(items.map(item=>originals.get(item)??item));};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}}),stats:()=>({calls,batches})};}
async function seedPage(count=4,records=1){const first=await seed('usage',records);const values=[first];
 for(let index=1;index<count;index++)values.push(await seed(index%2?'quota':'usage',records,first.fixture,1,index));
 for(const value of values)await insertTypedTelemetryV1Chunk(source(),value.insert,namespace);return values;}
async function catchupRun(pageEvents=4,maxPages=1,publicationEnabled=false){const runId=crypto.randomUUID(),now=Date.now();
 await source().prepare(`UPDATE collection_controls SET publication_enabled=?,control_state=?,revision=revision+1
  WHERE singleton=1 AND publication_enabled!=?`).bind(publicationEnabled?1:0,publicationEnabled?'operational':'degraded',publicationEnabled?1:0).run();
 const expectedCollectionRevision=await source().prepare('SELECT revision FROM collection_controls WHERE singleton=1').first<number>('revision');
 if(expectedCollectionRevision===null)throw new Error('synthetic collection control missing');
 await target().prepare(STORAGE_ANALYTICS_CATCHUP_CONTROL_SQL).run();
 await target().prepare(STORAGE_ANALYTICS_CATCHUP_RECEIPT_SQL).run();
 await target().prepare(`INSERT INTO storage_analytics_v1_catchup_runs
  (run_id,source_id,source_namespace,page_events,max_pages,pages_completed,expected_collection_revision,expected_publication_enabled,
   generation,expected_sequence,state,result_reason,updated_ms)
  VALUES(?,?,?,?,?,0,?,?,1,0,'sent',NULL,?)`).bind(runId,sourceId,namespace,pageEvents,maxPages,expectedCollectionRevision,
   publicationEnabled?1:0,now).run();
 return {runId,expectedCollectionRevision,expectedPublicationEnabled:publicationEnabled};}
const catchupMessage=(run:{runId:string;expectedCollectionRevision:number;expectedPublicationEnabled:boolean},generation=1,
 expectedSequence=0,pageEvents=4,maxPages=1)=>({schema:'storage-analytics-v1-catchup-message-v3' as const,runId:run.runId,
 generation,expectedSequence,pageEvents,maxPages,expectedCollectionRevision:run.expectedCollectionRevision,
 expectedPublicationEnabled:run.expectedPublicationEnabled});
function queueBatch(body:StorageAnalyticsV1CatchupMessage,id=crypto.randomUUID()){let acknowledgements=0;
 const message={id,timestamp:new Date(),body,attempts:1,retry(){},ack(){acknowledgements++;}};
 const batch={messages:[message],queue:'synthetic-analytics-catchup',metadata:{metrics:{backlogCount:0,backlogBytes:0}},retryAll(){},ackAll(){}} as MessageBatch<StorageAnalyticsV1CatchupMessage>;
 return {batch,acks:()=>acknowledgements};}
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
 it('commits four ordered receipts in one target batch with bounded source round trips',async()=>{
  await seedPage(4,200);const page=await changes();const seenSource=observe(source()),seenTarget=observe(target());
  expect(await advanceV1DailyProjectionPage({source:seenSource.db,target:seenTarget.db,sourceId,sourceNamespace:namespace,changes:page}))
   .toMatchObject({state:'applied',events:4,sequence:4,recordsRead:800});
  expect(seenTarget.stats()).toEqual({calls:2,batches:1});
  expect(seenSource.stats()).toEqual({calls:5,batches:4});
  expect(await target().prepare('SELECT group_concat(sequence) value FROM analytics_applied_events ORDER BY sequence').first('value')).toBe('1,2,3,4');
  const summaries=(await target().prepare('SELECT values_json FROM analytics_v1_chunk_values').all<{values_json:string}>()).results;
  expect(summaries.reduce((sum,row)=>sum+JSON.parse(row.values_json).counts.usage,0)).toBe(400);
  expect(summaries.reduce((sum,row)=>sum+JSON.parse(row.values_json).counts.quota,0)).toBe(400);
 });
 it('commits the maximum sixteen-event, 3200-record backlog page without adding binding round trips',async()=>{
  await seedPage(16,200);const page=await changes();const seenSource=observe(source()),seenTarget=observe(target());
  expect(await advanceV1DailyProjectionPage({source:seenSource.db,target:seenTarget.db,sourceId,sourceNamespace:namespace,changes:page}))
   .toMatchObject({state:'applied',events:16,sequence:16,recordsRead:3200});
  expect(seenTarget.stats()).toEqual({calls:2,batches:1});
  expect(seenSource.stats()).toEqual({calls:5,batches:4});
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(16);
  expect(await target().prepare('SELECT count(*) n FROM analytics_v1_chunk_values').first('n')).toBe(16);
 });
 it('reconciles a lost page acknowledgement without duplicate projection writes',async()=>{
  await seedPage();const page=await changes();let writes=0;
  const lost=targetBatch(async statements=>{writes++;await target().batch(statements);throw new Error('synthetic lost response');});
  expect(await advanceV1DailyProjectionPage({source:source(),target:lost,sourceId,sourceNamespace:namespace,changes:page}))
   .toMatchObject({events:4});
  expect(await advanceV1DailyProjectionPage({source:source(),target:target(),sourceId,sourceNamespace:namespace,changes:page}))
   .toMatchObject({events:4});
  expect(writes).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(4);
  expect(await target().prepare('SELECT count(*) n FROM analytics_v1_chunk_values').first('n')).toBe(4);
 });
 it('rolls back every page receipt when a later ordered event fails',async()=>{
  await seedPage();await target().prepare(`CREATE TRIGGER synthetic_page_failure BEFORE INSERT ON analytics_applied_events
   WHEN NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'synthetic page failure'); END`).run();
  await expect(advanceV1DailyProjectionPage({source:source(),target:target(),sourceId,sourceNamespace:namespace,changes:await changes()}))
   .rejects.toThrow('ANALYTICS_DELIVERY_UNACKNOWLEDGED');
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM analytics_v1_chunk_values').first('n')).toBe(0);
 });
 it('refuses a correction that commits before the final source recheck',async()=>{
 const [first]=await seedPage(1);const correction=await seed('usage',2,first!.fixture,2);
  const publicationControlRevision=(await source().prepare('SELECT revision FROM collection_controls WHERE singleton=1').first<number>('revision'))!;
  correction.insert.supersedes=await currentTelemetryV1Chunk(source(),first!.fixture.participantId,first!.fixture.deviceId,'usage',day(),0);
  let batches=0,mutated=false;const proxy=new Proxy(source(),{get(value,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   batches++;if(batches===4&&!mutated){mutated=true;await insertTypedTelemetryV1Chunk(source(),correction.insert,namespace);}return value.batch(statements);};
   const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
  await expect(advanceV1DailyProjectionPage({source:proxy,target:target(),sourceId,sourceNamespace:namespace,
   changes:await changes().then(v=>v.slice(0,1)),publicationControlRevision,publicationEnabled:true})).rejects.toThrow();
  expect(mutated).toBe(true);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
 });
 it('refuses an erasure that commits before the final source recheck',async()=>{
  const [first]=await seedPage(1);const publicationControlRevision=(await source().prepare('SELECT revision FROM collection_controls WHERE singleton=1').first<number>('revision'))!;
  let batches=0,erased=false;const proxy=new Proxy(source(),{get(value,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   batches++;if(batches===4&&!erased){erased=true;await source().prepare('DELETE FROM participants WHERE id=?').bind(first!.fixture.participantId).run();}
   return value.batch(statements);};const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;}});
  await expect(advanceV1DailyProjectionPage({source:proxy,target:target(),sourceId,sourceNamespace:namespace,
   changes:await changes().then(v=>v.slice(0,1)),publicationControlRevision,publicationEnabled:true})).rejects.toThrow();
 expect(erased).toBe(true);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
 });
 it('refuses an enabled-publication revision change at the final pre-transaction check',async()=>{
  await seedPage(1);const publicationControlRevision=(await source().prepare('SELECT revision FROM collection_controls WHERE singleton=1').first<number>('revision'))!;
  let changed=false;const proxy=new Proxy(source(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes('FROM collection_controls'))return statement;
   return new Proxy(statement,{get(value,member){if(member==='first')return async()=>{
    if(!changed){changed=true;await source().prepare('UPDATE collection_controls SET revision=revision+1 WHERE singleton=1').run();}
    return value.first();};const result=Reflect.get(value,member);return typeof result==='function'?result.bind(value):result;}});};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  await expect(advanceV1DailyProjectionPage({source:proxy,target:target(),sourceId,sourceNamespace:namespace,
   changes:await changes(),publicationControlRevision,publicationEnabled:true})).rejects.toThrow('STORAGE_ANALYTICS_PUBLICATION_CONTROL_CHANGED');
  expect(changed).toBe(true);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
 });
 it('uses the page only while publication is paused and reports actual statement budget',async()=>{
  await seedPage(4,200);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  expect(await runStorageAnalyticsPass({source:source(),target:target(),sourceId,sourceNamespace:namespace,maxSteps:4,
   maxQueries:20,publishCommunity:false})).toMatchObject({state:'deferred',reason:'query_budget',steps:0});
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
  const pass=await runStorageAnalyticsPass({source:source(),target:target(),sourceId,sourceNamespace:namespace,maxSteps:4,publishCommunity:false});
  expect(pass).toMatchObject({state:'progress',reason:'step_limit',steps:4,recordsRead:800});expect(pass.queriesUsed).toBe(78);
 });
 it('runs the separate maximum backlog page within the shared query budget and rejects broader pages',async()=>{
  await seedPage(16,200);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  await expect(runStorageAnalyticsV1CatchupPass({source:source(),target:target(),sourceId,sourceNamespace:namespace,
   pageEvents:17})).rejects.toThrow('STORAGE_ANALYTICS_CONTRACT_UNAVAILABLE');
  const pass=await runStorageAnalyticsV1CatchupPass({source:source(),target:target(),sourceId,sourceNamespace:namespace,
   pageEvents:16,maxSteps:16});
  expect(pass).toMatchObject({state:'progress',reason:'step_limit',steps:16,recordsRead:3200});
  expect(pass.queriesUsed).toBe(159);
 });
 it('serializes chained queue pages through a durable generation claim',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,2),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);return {metadata:{metrics:{backlogCount:1,backlogBytes:1}}};}} as Queue<StorageAnalyticsV1CatchupMessage>;
  const env={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),
   STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,4,2));
  await runStorageAnalyticsV1CatchupQueue(first.batch,env);expect(first.acks()).toBe(1);expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({generation:2,expectedSequence:4});
  const next=queueBatch(sent[0]!);await runStorageAnalyticsV1CatchupQueue(next.batch,env);expect(next.acks()).toBe(1);
  expect(await target().prepare('SELECT state FROM storage_analytics_v1_catchup_runs').first('state')).toBe('complete');
 const duplicate=queueBatch(first.batch.messages[0]!.body);await runStorageAnalyticsV1CatchupQueue(duplicate.batch,env);
  expect(duplicate.acks()).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(4);
 });
 it('processes up to three maximum pages per delivery and stops at the exact page bound',async()=>{
  await seedPage(32,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,2,true),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,16,2));await runStorageAnalyticsV1CatchupQueue(first.batch,workerEnv);
  expect(first.acks()).toBe(1);expect(sent).toHaveLength(0);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:32,pages_completed:2,state:'complete',result_reason:'page_limit'});
  expect((await target().prepare(`SELECT generation,expected_sequence,observed_sequence,events_applied,result_reason
   FROM storage_analytics_v1_catchup_receipts ORDER BY generation`).all()).results).toEqual([
    {generation:1,expected_sequence:0,observed_sequence:16,events_applied:16,result_reason:'step_limit'},
    {generation:2,expected_sequence:16,observed_sequence:32,events_applied:16,result_reason:'page_limit'}]);
 });
 it('enqueues once after three internal pages and resumes the exact next generation',async()=>{
  await seedPage(64,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,4,true),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const ledger=observe(bindings.DELETION_LEDGER);
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:ledger.db,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,16,4));await runStorageAnalyticsV1CatchupQueue(first.batch,workerEnv);
  expect(first.acks()).toBe(1);expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({generation:4,expectedSequence:48,pageEvents:16,maxPages:4});
  expect(ledger.stats().calls).toBeGreaterThanOrEqual(3);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:4,expected_sequence:48,pages_completed:3,state:'sent'});
  const second=queueBatch(sent[0]!);await runStorageAnalyticsV1CatchupQueue(second.batch,workerEnv);
  expect(second.acks()).toBe(1);expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:5,expected_sequence:64,pages_completed:4,state:'complete',result_reason:'page_limit'});
  expect(await target().prepare('SELECT count(*) n FROM storage_analytics_v1_catchup_receipts').first('n')).toBe(4);
 });
 it('carries a costly first page budget into page two and gracefully yields on a late budget race',async()=>{
  await seedPage(48,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,3,true),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const ledger=observe(bindings.DELETION_LEDGER),original=storageAnalyticsRuntime.runStorageAnalyticsV1CatchupPass;
  let secondBudget:number|undefined;
  const pass=vi.spyOn(storageAnalyticsRuntime,'runStorageAnalyticsV1CatchupPass').mockImplementationOnce(async options=>{
   const result=await original(options);return {...result,queriesUsed:500};
  }).mockImplementationOnce(async options=>{secondBudget=options.maxQueries;return original({...options,maxQueries:20});});
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:ledger.db,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,16,3));await runStorageAnalyticsV1CatchupQueue(first.batch,workerEnv);pass.mockRestore();
  expect(first.acks()).toBe(1);expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({generation:2,expectedSequence:16});
  expect(ledger.stats().calls).toBeGreaterThan(0);expect(secondBudget).toBe(340);
  expect(await target().prepare('SELECT metered_queries FROM storage_analytics_v1_catchup_receipts WHERE generation=1').first('metered_queries')).toBe(500);
  expect(await target().prepare('SELECT count(*) n FROM storage_analytics_v1_catchup_receipts').first('n')).toBe(1);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:16,pages_completed:1,state:'sent'});
  const resumed=queueBatch(sent[0]!);await runStorageAnalyticsV1CatchupQueue(resumed.batch,workerEnv);
  expect(resumed.acks()).toBe(1);expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:4,expected_sequence:48,pages_completed:3,state:'complete',result_reason:'page_limit'});
 });
 it('retains the first page and blocks before a second page when publication controls change',async()=>{
  await seedPage(32,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,2,true);let controlReads=0;
  const changingSource=new Proxy(source(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes('FROM collection_controls'))return statement;
   return new Proxy(statement,{get(value,member){if(member==='first')return async(...args:unknown[])=>{
    controlReads++;if(controlReads===3)await source().prepare('UPDATE collection_controls SET revision=revision+1 WHERE singleton=1').run();
    return Reflect.apply(Reflect.get(value,member) as Function,value,args);};const result=Reflect.get(value,member);
    return typeof result==='function'?result.bind(value):result;}});};const value=Reflect.get(database,key);
   return typeof value==='function'?value.bind(database):value;}});
  const queue={async send(){throw new Error('unexpected send');}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const env={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:changingSource,STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const delivery=queueBatch(catchupMessage(run,1,0,16,2));await runStorageAnalyticsV1CatchupQueue(delivery.batch,env);
  expect(delivery.acks()).toBe(1);expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:16,pages_completed:1,state:'blocked',result_reason:'publication_control'});
  expect((await target().prepare('SELECT generation,events_applied,result_reason FROM storage_analytics_v1_catchup_receipts ORDER BY generation').all()).results)
   .toEqual([{generation:1,events_applied:16,result_reason:'step_limit'},{generation:2,events_applied:0,result_reason:'publication_control'}]);
 });
 it('recovers a crash at the internal checkpoint from a stale delivery without replay',async()=>{
  await seedPage(32,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,2,true),sent:StorageAnalyticsV1CatchupMessage[]=[];let claims=0;
  const crashingControl=new Proxy(target(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes("SET state='running'"))return statement;
   return new Proxy(statement,{get(value,member){if(member==='bind')return(...args:unknown[])=>{
    const bound=value.bind(...args);return new Proxy(bound,{get(inner,operation){if(operation==='run')return async()=>{
     claims++;if(claims===2)throw new Error('synthetic crash at internal checkpoint');return inner.run();};
     const result=Reflect.get(inner,operation);return typeof result==='function'?result.bind(inner):result;}});};
    const result=Reflect.get(value,member);return typeof result==='function'?result.bind(value):result;}});};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const common={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,16,2));
  await expect(runStorageAnalyticsV1CatchupQueue(first.batch,{...common,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:crashingControl})).rejects.toThrow();
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:16,pages_completed:1,state:'send-pending'});
  const retry=queueBatch(first.batch.messages[0]!.body);await runStorageAnalyticsV1CatchupQueue(retry.batch,{...common,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target()});
  expect(retry.acks()).toBe(1);expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({generation:2,expectedSequence:16});
  const resumed=queueBatch(sent[0]!);await runStorageAnalyticsV1CatchupQueue(resumed.batch,{...common,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target()});
  expect(resumed.acks()).toBe(1);expect(await target().prepare('SELECT expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({expected_sequence:32,pages_completed:2,state:'complete',result_reason:'page_limit'});
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(32);
 });
 it('continues a retried delivery from its exact retained internal claim',async()=>{
  await seedPage(32,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,2,true),claim='synthetic-retained-delivery';
  const first=await runStorageAnalyticsV1CatchupPass({source:source(),target:target(),sourceId,sourceNamespace:namespace,
   pageEvents:16,maxSteps:16,publicationControlRevision:run.expectedCollectionRevision,publicationEnabled:true});
  expect(first.steps).toBe(16);
  await target().batch([
   target().prepare(`INSERT INTO storage_analytics_v1_catchup_receipts
    (run_id,generation,expected_sequence,observed_sequence,events_applied,records_read,decoded_bytes,metered_queries,
     source_read_ms,fold_ms,source_recheck_ms,target_write_ms,page_duration_ms,invocation_duration_ms,result_reason,completed_ms)
    VALUES(?,1,0,16,16,?,?,?,?,?,?,?,?,?,'step_limit',?)`).bind(run.runId,first.recordsRead,first.metrics.decodedBytes,first.queriesUsed,
      first.metrics.sourceReadMs,first.metrics.foldMs,first.metrics.sourceRecheckMs,first.metrics.targetWriteMs,
      first.metrics.pageDurationMs,1,Date.now()),
   target().prepare(`UPDATE storage_analytics_v1_catchup_runs SET generation=2,expected_sequence=16,pages_completed=1,
    state='running',claim_id=?,updated_ms=? WHERE run_id=?`).bind(claim,Date.now(),run.runId),
  ]);
  const queue={async send(){throw new Error('unexpected send');}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const env={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const altered=queueBatch({...catchupMessage(run,1,0,16,2),maxPages:3},claim);
  await expect(runStorageAnalyticsV1CatchupQueue(altered.batch,env)).rejects.toThrow('STORAGE_ANALYTICS_CATCHUP_INVALID');
  expect(await target().prepare('SELECT generation,expected_sequence,state,claim_id FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:16,state:'running',claim_id:claim});
  const retry=queueBatch(catchupMessage(run,1,0,16,2),claim);await runStorageAnalyticsV1CatchupQueue(retry.batch,env);
  expect(retry.acks()).toBe(1);expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:32,pages_completed:2,state:'complete',result_reason:'page_limit'});
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(32);
 });
 it('gracefully yields when the shared invocation deadline expires after the next page claim',async()=>{
  await seedPage(32,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(16,2,true),sent:StorageAnalyticsV1CatchupMessage[]=[];const base=Date.now();let now=base,claims=0;
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
  const expiringControl=new Proxy(target(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes("SET state='running'"))return statement;
   return new Proxy(statement,{get(value,member){if(member==='bind')return(...args:unknown[])=>{
    const bound=value.bind(...args);return new Proxy(bound,{get(inner,operation){if(operation==='run')return async()=>{
     const result=await inner.run();claims++;if(claims===2)now=base+20_001;return result;};
     const result=Reflect.get(inner,operation);return typeof result==='function'?result.bind(inner):result;}});};
    const result=Reflect.get(value,member);return typeof result==='function'?result.bind(value):result;}});};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const common={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,16,2));await runStorageAnalyticsV1CatchupQueue(first.batch,{...common,
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(base+60_000).toISOString(),STORAGE_INGESTION_DB:source(),
   STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:expiringControl});
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:16,pages_completed:1,state:'sent',result_reason:null});
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({generation:2,expectedSequence:16});
  expect(await target().prepare('SELECT count(*) n FROM storage_analytics_v1_catchup_receipts').first('n')).toBe(1);
  const resumed=queueBatch(sent[0]!);await runStorageAnalyticsV1CatchupQueue(resumed.batch,{...common,
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(base+120_000).toISOString(),STORAGE_INGESTION_DB:source()});
  clock.mockRestore();expect(resumed.acks()).toBe(1);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:32,pages_completed:2,state:'complete',result_reason:'page_limit'});
 });
 it('stops the initial four-event canary after one page and persists content-free measurements',async()=>{
  await seedPage(4,2);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,1),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const delivery=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(delivery.batch,workerEnv);
  expect(delivery.acks()).toBe(1);expect(sent).toHaveLength(0);
  expect(await target().prepare(`SELECT generation,expected_sequence,pages_completed,state,result_reason
   FROM storage_analytics_v1_catchup_runs`).first()).toEqual({generation:2,expected_sequence:4,pages_completed:1,state:'complete',result_reason:'page_limit'});
  const receipt=await target().prepare(`SELECT expected_sequence,observed_sequence,events_applied,records_read,decoded_bytes,
   metered_queries,source_read_ms,fold_ms,source_recheck_ms,target_write_ms,page_duration_ms,invocation_duration_ms,result_reason
   FROM storage_analytics_v1_catchup_receipts`).first<Record<string,number|string>>();
  expect(receipt).toMatchObject({expected_sequence:0,observed_sequence:4,events_applied:4,records_read:8,result_reason:'page_limit'});
  for(const key of ['decoded_bytes','metered_queries','source_read_ms','fold_ms','source_recheck_ms','target_write_ms','page_duration_ms','invocation_duration_ms'])
   expect(receipt![key],key).toEqual(expect.any(Number));
 expect(JSON.stringify(receipt)).not.toContain((await changes())[0]!.ownerDigest);
 });
 it('runs one bounded four-event page against an exact enabled-publication revision',async()=>{
  await seedPage(4,2);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,1,true),sent:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const delivery=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(delivery.batch,workerEnv);
  expect(delivery.acks()).toBe(1);expect(sent).toHaveLength(0);
  expect(await target().prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first('sequence')).toBe(4);
  expect(await target().prepare('SELECT pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({pages_completed:1,state:'complete',result_reason:'page_limit'});
 });
 it('blocks and resumes safely when an ordinary projection wins the target transaction',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,1,true);let raced=false;
  const racingTarget=new Proxy(target(),{get(database,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   if(!raced){raced=true;await step();}return database.batch(statements);};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  const queue={async send(){}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const common={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),DELETION_LEDGER:bindings.DELETION_LEDGER,
   STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(first.batch,{...common,STORAGE_ANALYTICS_DB:racingTarget});
  expect(raced).toBe(true);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(1);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:1,pages_completed:0,state:'blocked',result_reason:'failed'});
  await target().prepare(`UPDATE storage_analytics_v1_catchup_runs SET state='send-pending',result_reason=NULL,updated_ms=?
   WHERE run_id=? AND generation=2 AND expected_sequence=1 AND state='blocked' AND pages_completed<max_pages`).bind(Date.now(),run.runId).run();
  const resumed=queueBatch(catchupMessage(run,2,1));await runStorageAnalyticsV1CatchupQueue(resumed.batch,{...common,STORAGE_ANALYTICS_DB:target()});
  expect(resumed.acks()).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(4);
  expect(await target().prepare('SELECT pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({pages_completed:1,state:'complete',result_reason:'page_limit'});
 });
 it('checkpoints an ordinary cursor advance beyond one page instead of stranding the claim',async()=>{
  await seedPage(9,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,1,true);for(let index=0;index<5;index++)await step();
  const sent:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sent.push(value);}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const stale=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(stale.batch,workerEnv);
  expect(stale.acks()).toBe(1);expect(sent).toHaveLength(0);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:5,pages_completed:0,state:'blocked',result_reason:'cursor_advanced'});
  expect(await target().prepare(`SELECT expected_sequence,observed_sequence,events_applied,records_read,result_reason
   FROM storage_analytics_v1_catchup_receipts WHERE generation=1`).first())
   .toEqual({expected_sequence:0,observed_sequence:5,events_applied:5,records_read:null,result_reason:'cursor_advanced'});
  await target().prepare(`UPDATE storage_analytics_v1_catchup_runs SET state='send-pending',result_reason=NULL,updated_ms=?
   WHERE run_id=? AND generation=2 AND expected_sequence=5 AND state='blocked' AND pages_completed<max_pages`).bind(Date.now(),run.runId).run();
  const resumed=queueBatch(catchupMessage(run,2,5));await runStorageAnalyticsV1CatchupQueue(resumed.batch,workerEnv);
  expect(resumed.acks()).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(9);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:9,pages_completed:1,state:'complete',result_reason:'page_limit'});
 });
 it('checkpoints an initial cursor read failure instead of stranding the claim',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,1,true);let failed=false;
  const failingTarget=new Proxy(target(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes('SELECT sequence FROM analytics_source_cursors'))return statement;
   return new Proxy(statement,{get(value,member){if(member==='bind')return(...args:unknown[])=>{
    const bound=value.bind(...args);return new Proxy(bound,{get(inner,operation){if(operation==='first')return async(...firstArgs:unknown[])=>{
     if(!failed){failed=true;throw new Error('synthetic cursor read failure');}
     return Reflect.apply(Reflect.get(inner,operation) as Function,inner,firstArgs);};
     const result=Reflect.get(inner,operation);return typeof result==='function'?result.bind(inner):result;}});};
    const result=Reflect.get(value,member);return typeof result==='function'?result.bind(value):result;}});};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  const queue={async send(){throw new Error('unexpected send');}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:failingTarget,
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const delivery=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(delivery.batch,workerEnv);
  expect(failed).toBe(true);expect(delivery.acks()).toBe(1);
  expect(await target().prepare('SELECT generation,expected_sequence,pages_completed,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:0,pages_completed:0,state:'blocked',result_reason:'failed'});
  expect(await target().prepare('SELECT expected_sequence,observed_sequence,events_applied,result_reason FROM storage_analytics_v1_catchup_receipts').first())
   .toEqual({expected_sequence:0,observed_sequence:0,events_applied:0,result_reason:'failed'});
 });
 it('blocks before analytics writes when publication is enabled or its exact revision changes',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun();await source().prepare(`UPDATE collection_controls SET publication_enabled=1,control_state='operational',revision=revision+1
   WHERE singleton=1`).run();
  const queue={async send(){throw new Error('unexpected send');}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const delivery=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(delivery.batch,workerEnv);
  expect(delivery.acks()).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(0);
  expect(await target().prepare('SELECT generation,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,state:'blocked',result_reason:'publication_control'});
 });
 it('retains a failed checkpoint that can be manually resumed without replay',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun();await target().prepare(`CREATE TRIGGER synthetic_catchup_failure BEFORE INSERT ON analytics_applied_events
   BEGIN SELECT RAISE(ABORT,'synthetic catchup failure'); END`).run();
  const queue={async send(){}} as unknown as Queue<StorageAnalyticsV1CatchupMessage>;
  const workerEnv={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const failed=queueBatch(catchupMessage(run));await runStorageAnalyticsV1CatchupQueue(failed.batch,workerEnv);
  expect(await target().prepare('SELECT generation,expected_sequence,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:2,expected_sequence:0,state:'blocked',result_reason:'failed'});
  expect(await target().prepare('SELECT records_read,decoded_bytes,metered_queries,result_reason FROM storage_analytics_v1_catchup_receipts').first())
   .toEqual({records_read:null,decoded_bytes:null,metered_queries:null,result_reason:'failed'});
  await target().prepare('DROP TRIGGER synthetic_catchup_failure').run();
  await target().prepare(`UPDATE storage_analytics_v1_catchup_runs SET state='send-pending',result_reason=NULL,updated_ms=?
   WHERE run_id=? AND generation=2 AND expected_sequence=0 AND state='blocked' AND result_reason='failed' AND pages_completed<max_pages`)
   .bind(Date.now(),run.runId).run();
  const resumed=queueBatch(catchupMessage(run,2));await runStorageAnalyticsV1CatchupQueue(resumed.batch,workerEnv);
  expect(resumed.acks()).toBe(1);expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(4);
  expect(await target().prepare('SELECT generation,expected_sequence,state,result_reason FROM storage_analytics_v1_catchup_runs').first())
   .toEqual({generation:3,expected_sequence:4,state:'complete',result_reason:'page_limit'});
 });
 it('retains a lost chained send and resends without replaying the committed page',async()=>{
  await seedPage(4,1);await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace:namespace});
  const run=await catchupRun(4,2);let sends=0;const queued:StorageAnalyticsV1CatchupMessage[]=[];
  const queue={async send(value:StorageAnalyticsV1CatchupMessage){sends++;queued.push(value);if(sends===1)throw new Error('synthetic lost send response');
   return {metadata:{metrics:{backlogCount:1,backlogBytes:1}}};}} as Queue<StorageAnalyticsV1CatchupMessage>;
  const env={STORAGE_ANALYTICS_CATCHUP_MODE:'enabled' as const,STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME:'synthetic-analytics-catchup',
   STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),
   STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:target(),
   DELETION_LEDGER:bindings.DELETION_LEDGER,STORAGE_ANALYTICS_CATCHUP_CONTROL_DB:target(),STORAGE_ANALYTICS_CATCHUP_QUEUE:queue};
  const first=queueBatch(catchupMessage(run,1,0,4,2));
  await expect(runStorageAnalyticsV1CatchupQueue(first.batch,env)).rejects.toThrow('synthetic lost send response');
  expect(await target().prepare('SELECT state FROM storage_analytics_v1_catchup_runs').first('state')).toBe('send-pending');
  await runStorageAnalyticsV1CatchupQueue(first.batch,env);expect(first.acks()).toBe(1);expect(sends).toBe(2);
  expect(await target().prepare('SELECT state FROM storage_analytics_v1_catchup_runs').first('state')).toBe('sent');
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(4);
 });
});
