import {env, reset, applyD1Migrations, type D1Migration} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest}
 from '@app-usagemonitor/telemetry-contract';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {advanceStorageCommunityGraphWork} from '../src/storage-community-graph-work';
import {readStorageGraphWorkSelection} from '../src/storage-community-graph-selection';
import {planHistoricalModelBlockRanges} from '../src/analytics-model-block-contract';
import {createV11DeviceFixture,makeV11Day} from './helpers/telemetry-v11';

const {blockWork}=vi.hoisted(()=>({blockWork:vi.fn()}));
vi.mock('../src/storage-community-graph-model-block',()=>({advanceStorageModelBlockGraphWork:blockWork}));

const b=env as Env&{STORAGE_INGESTION_A:D1Database;STORAGE_ANALYTICS_DB:D1Database;
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
 TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const namespace='synthetic-model-block-scheduler';
const source=()=>b.STORAGE_INGESTION_A,target=()=>b.STORAGE_ANALYTICS_DB;
const bindings=()=>({source:source(),target:target(),sourceId:namespace,sourceNamespace:namespace});
// The latest clipped historical range ends yesterday.
const historicalDay=planHistoricalModelBlockRanges(new Date().toISOString().slice(0,10)).at(-1)!.outputThroughDay;
const today=new Date(Date.parse(`${historicalDay}T00:00:00.000Z`)+86_400_000).toISOString().slice(0,10);
const nowMs=Date.parse(`${today}T12:00:00.000Z`);
const sourceToday=new Date().toISOString().slice(0,10);

beforeEach(async()=>{
 blockWork.mockReset();
 await reset();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),namespace);
 await initializeTypedV1Admission(source(),namespace);await initializeTypedV11Admission(source(),namespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await drainCommunityPublicSourceBootstrap(source());await initializeStorageAnalyticsRuntime(bindings());
});

async function effectiveOwner(){
 const device=await createV11DeviceFixture(source(),{participantId:'participant:synthetic-block-scheduler',grant:true});
 const days=[];
 for(let ms=Date.parse(`${historicalDay}T00:00:00.000Z`);ms<=Date.parse(`${sourceToday}T00:00:00.000Z`);ms+=86_400_000){
  const day=new Date(ms).toISOString().slice(0,10);
  const prepared=await makeV11Day(day,{});
  const registered=await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
  days.push({day,manifestId:registered.manifestId,manifestDigest:registered.manifestDigest});
 }
 const prior=await createTelemetryV11DomainPredecessor(source(),device);
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
  fromDay:historicalDay,throughDay:sourceToday,
  predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
   legacyFingerprint:prior.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
 await activateTelemetryV11Domain(source(),device,manifest);
 for(let pass=0;pass<32;pass++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
 await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 expect(owner).toMatchObject({hasEffective:true});
 expect(owner.ownerDigest).toMatch(/^[0-9a-f]{64}$/u);
 await target().prepare(`INSERT INTO analytics_community_graph_scan
  (source_id,revision,tick,current_position,history_position) VALUES(?,1,1,0,0)
  ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1,current_position=0,history_position=0`)
  .bind(namespace).run();
 return owner;
}

describe('model block graph-work scheduling',()=>{
 it('keeps the model block path off by default and advances the normal historical selection',async()=>{
  const owner=await effectiveOwner();
  expect(planHistoricalModelBlockRanges(today).some(range=>range.outputThroughDay===historicalDay)).toBe(true);
 const result=await advanceStorageCommunityGraphWork({...bindings(),nowMs});
  expect(result).toMatchObject({state:'complete',metric:'model',day:historicalDay});
  expect(blockWork).not.toHaveBeenCalled();
  expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(namespace,owner.ownerDigest,historicalDay).first<number>('n')).toBe(1);
  expect(await target().prepare('SELECT tick,history_position FROM analytics_community_graph_scan').first())
   .toMatchObject({tick:2,history_position:1});
  expect(owner.ownerDigest).toBeTruthy();
 });

 it('routes an eligible claimed historical model date through the shared allowance and completes its selection',async()=>{
  const owner=await effectiveOwner();
  const meter=createD1InvocationBudget(950),deadlineMs=Date.now()+60_000;
  blockWork.mockImplementation(async(input:{maxQueries:number})=>{
   expect(input.maxQueries).toBe(meter.remainingQueries-40);
   return {state:'complete',reused:false,adoptedDates:1,queriesUsed:0};
  });
  const result=await advanceStorageCommunityGraphWork({...bindings(),source:meter.wrap(source()),target:meter.wrap(target()),
   get remainingQueries(){return meter.remainingQueries;},nowMs,deadlineMs,modelBlocks:true});
  expect(result).toEqual({state:'complete',metric:'model',day:historicalDay});
  expect(blockWork).toHaveBeenCalledTimes(1);
  const input=blockWork.mock.calls[0]![0];
  expect(input).toMatchObject({sourceId:namespace,sourceNamespace:namespace,nowMs,deadlineMs,
   scope:{source:'effective',day:historicalDay,metric:'model',owner:{ownerDigest:owner.ownerDigest}}});
  expect(input.maxQueries).toBeGreaterThanOrEqual(600);
  expect(meter.queriesUsed).toBeLessThan(950);
  expect(await readStorageGraphWorkSelection(target(),{sourceId:namespace,ownerDigest:owner.ownerDigest!,
   day:historicalDay,metric:'model'})).toBeNull();
  expect(await target().prepare('SELECT tick,history_position FROM analytics_community_graph_scan').first())
   .toMatchObject({tick:2,history_position:1});
 });

 it('falls back to the native graph calculation when an eligible block is unsupported',async()=>{
  const owner=await effectiveOwner();
  blockWork.mockResolvedValue({state:'unsupported',reason:'migration_required',adoptedDates:0,queriesUsed:0});
  const result=await advanceStorageCommunityGraphWork({...bindings(),nowMs,modelBlocks:true});
  expect(blockWork).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({state:'complete',metric:'model',day:historicalDay});
  expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(namespace,owner.ownerDigest,historicalDay).first<number>('n')).toBe(1);
 });

 it('keeps the selected owner-day pending when block work yields',async()=>{
  const owner=await effectiveOwner();
  blockWork.mockResolvedValue({state:'deferred',reason:'query_budget',adoptedDates:0,queriesUsed:0});
  expect(await advanceStorageCommunityGraphWork({...bindings(),nowMs,modelBlocks:true}))
   .toEqual({state:'deferred',metric:'model',day:historicalDay,reason:'query_budget'});
  expect(blockWork).toHaveBeenCalledTimes(1);
  expect(await readStorageGraphWorkSelection(target(),{sourceId:namespace,ownerDigest:owner.ownerDigest!,
   day:historicalDay,metric:'model'})).toMatchObject({state:'pending',claimToken:null});
  expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
  .bind(namespace,owner.ownerDigest,historicalDay).first<number>('n')).toBe(0);
 });

 it('keeps today on the native graph path with model blocks enabled',async()=>{
  const owner=await effectiveOwner();
  await target().prepare(`UPDATE analytics_community_graph_scan SET revision=revision+1,
   tick=0,current_position=1,history_position=0 WHERE source_id=?`).bind(namespace).run();
  const result=await advanceStorageCommunityGraphWork({...bindings(),nowMs,modelBlocks:true});
  expect(result).toMatchObject({state:'complete',metric:'model',day:today});
  expect(blockWork).not.toHaveBeenCalled();
  expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(namespace,owner.ownerDigest,today).first<number>('n')).toBe(1);
 });
});
