import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {configureStorageShardAllocation,readStorageCapacityObservation,readStorageShardAllocationPolicy,
 recordStorageCapacityObservation} from '../src/storage-capacity';
import {createCatalogStorageRouter,createOwnerMoveCoordinator} from '../src/storage-routing';
import {captureStorageShardReadinessSchemaDigests,qualifyStorageShardRuntimeTuple,readStorageShardReadiness,recordStorageShardReadiness,
 revokeStorageShardReadiness,type StorageShardReadinessPlan} from '../src/storage-shard-readiness';

interface Bindings extends Env{
 STORAGE_ROUTING_DB:D1Database;STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;
 STORAGE_ANALYTICS_A:D1Database;STORAGE_ANALYTICS_B:D1Database;STORAGE_PUBLICATION_DB:D1Database;
 DELETION_LEDGER:D1Database;TEST_ROUTING_MIGRATIONS:D1Migration[];TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[];
 TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[];
}
const b=env as Bindings;
const UUIDS={
 qualificationA:'11111111-1111-4111-8111-111111111111',qualificationB:'22222222-2222-4222-8222-222222222222',
 ingestionA:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',ingestionB:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
 analyticsA:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',analyticsB:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
 ledger:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',publication:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 catalog:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
} as const;
const sourceMigrations=()=>[b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,
 b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,
 b.TEST_TYPED_V1_ADMISSION_MIGRATIONS];
async function prepareSource(database:D1Database,sourceId:string,namespace:string){
 for(const migrations of sourceMigrations())await applyD1Migrations(database,migrations);
 await initializeStorageSource(database,sourceId);
 await initializeTypedV11Admission(database,namespace);
 await initializeTypedV1Admission(database,namespace);
 await applyD1Migrations(database,b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await applyD1Migrations(database,b.TEST_INGESTION_ROUTING_MIGRATIONS);
}
const schemaPins=new Map<'a'|'b',Awaited<ReturnType<typeof captureStorageShardReadinessSchemaDigests>>>();
function plan(shard:'a'|'b'):StorageShardReadinessPlan{return {
 qualificationId:shard==='a'?UUIDS.qualificationA:UUIDS.qualificationB,shardId:shard,
 catalogDatabaseId:UUIDS.catalog,
 catalogBindingName:'STORAGE_ROUTING_DB',
 bindingName:`STORAGE_INGESTION_${shard.toUpperCase()}`,
 ingestionDatabaseId:shard==='a'?UUIDS.ingestionA:UUIDS.ingestionB,
 sourceId:`source-${shard}`,sourceNamespace:`namespace-${shard}`,
 analyticsTargetId:`analytics-${shard}`,analyticsBindingName:`STORAGE_ANALYTICS_${shard.toUpperCase()}`,
 analyticsDatabaseId:shard==='a'?UUIDS.analyticsA:UUIDS.analyticsB,
 erasureTargetId:`analytics-${shard}`,deletionLedgerBindingName:'DELETION_LEDGER',
 deletionLedgerDatabaseId:UUIDS.ledger,publicationBindingName:'STORAGE_PUBLICATION_DB',
 publicationDatabaseId:UUIDS.publication,qualifiedAt:1_000,
 expectedSchemaDigests:schemaPins.get(shard)!};}
const databases=(shard:'a'|'b')=>({catalog:b.STORAGE_ROUTING_DB,
 ingestion:shard==='a'?b.STORAGE_INGESTION_A:b.STORAGE_INGESTION_B,
 analytics:shard==='a'?b.STORAGE_ANALYTICS_A:b.STORAGE_ANALYTICS_B,
 deletionLedger:b.DELETION_LEDGER,publication:b.STORAGE_PUBLICATION_DB});

beforeEach(async()=>{
 await reset();
 await applyD1Migrations(b.STORAGE_ROUTING_DB,b.TEST_ROUTING_MIGRATIONS);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await applyD1Migrations(b.STORAGE_PUBLICATION_DB,b.TEST_ANALYTICS_MIGRATIONS);
 for(const shard of ['a','b'] as const){
  const db=databases(shard);await prepareSource(db.ingestion,`source-${shard}`,`namespace-${shard}`);
  await applyD1Migrations(db.analytics,b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({source:db.ingestion,target:db.analytics,
   sourceId:`source-${shard}`,sourceNamespace:`namespace-${shard}`});
 }
 await b.STORAGE_ROUTING_DB.batch((['a','b'] as const).map(shard=>b.STORAGE_ROUTING_DB.prepare(
  `INSERT INTO storage_shards(shard_id,binding_name,state) VALUES(?,?,'active')`)
   .bind(shard,`STORAGE_INGESTION_${shard.toUpperCase()}`)));
 for(const shard of ['a','b'] as const) schemaPins.set(shard,
  await captureStorageShardReadinessSchemaDigests(databases(shard)));
});

async function enable(shard:'a'|'b'){
 const qualified=await qualifyStorageShardRuntimeTuple(plan(shard),databases(shard));
 const receipt=await recordStorageShardReadiness(b.STORAGE_ROUTING_DB,qualified);
 await recordStorageCapacityObservation(b.STORAGE_ROUTING_DB,{shardId:shard,observedBytes:0,
  observedAt:900,validUntil:2_000,pressureState:'normal'});
 await configureStorageShardAllocation(b.STORAGE_ROUTING_DB,{shardId:shard,allocationTier:shard==='a'?'active':'spare',
  allocationEnabled:true,qualificationDigest:receipt.readinessDigest,updatedAt:1_000});
 return receipt;
}

describe('storage shard runtime readiness',()=>{
 it('refuses allocation policy without a current exact receipt',async()=>{
  await expect(configureStorageShardAllocation(b.STORAGE_ROUTING_DB,{shardId:'a',allocationTier:'spare',
   allocationEnabled:true,qualificationDigest:'0'.repeat(64),updatedAt:1_000}))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_allocation_policy`)
   .first('n')).toBe(0);
 });

 it('binds and replays one exact complete tuple before allocation',async()=>{
  const receipt=await enable('a');
  await expect(readStorageCapacityObservation(b.STORAGE_ROUTING_DB,'a')).resolves.toEqual({
   shardId:'a',observedBytes:0,observedAt:900,validUntil:2_000,pressureState:'normal'});
  await expect(readStorageShardAllocationPolicy(b.STORAGE_ROUTING_DB,'a')).resolves.toEqual({
   shardId:'a',allocationTier:'active',allocationEnabled:true,
   qualificationDigest:receipt.readinessDigest,updatedAt:1_000});
  await expect(readStorageCapacityObservation(b.STORAGE_ROUTING_DB,'missing')).resolves.toBeNull();
  await expect(readStorageShardAllocationPolicy(b.STORAGE_ROUTING_DB,'missing')).resolves.toBeNull();
  await expect(readStorageShardReadiness(b.STORAGE_ROUTING_DB,receipt.readinessDigest)).resolves.toEqual(receipt);
  await expect(readStorageShardReadiness(b.STORAGE_ROUTING_DB,'0'.repeat(64))).resolves.toBeNull();
  expect(await recordStorageShardReadiness(b.STORAGE_ROUTING_DB,receipt)).toEqual(receipt);
  const router=createCatalogStorageRouter({catalog:b.STORAGE_ROUTING_DB,
   bindings:{STORAGE_INGESTION_A:b.STORAGE_INGESTION_A},clock:()=>1_100});
  await expect(router.ensureOwner('accountless:ready-owner','a',16_777_216))
   .resolves.toMatchObject({shardId:'a',generation:1});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness`)
   .first('n')).toBe(1);
  await expect(b.STORAGE_ROUTING_DB.prepare(`UPDATE storage_shard_runtime_readiness
   SET source_namespace='changed' WHERE readiness_digest=?`).bind(receipt.readinessDigest).run())
   .rejects.toThrow('STORAGE_SHARD_READINESS_IMMUTABLE');
  await expect(b.STORAGE_ROUTING_DB.prepare(`DELETE FROM storage_shard_runtime_readiness
   WHERE readiness_digest=?`).bind(receipt.readinessDigest).run())
   .rejects.toThrow('STORAGE_SHARD_READINESS_HISTORY_REQUIRED');
 });

 it('refuses an incomplete analytics tuple without publishing catalog evidence',async()=>{
  await b.STORAGE_ANALYTICS_A.prepare(`DELETE FROM analytics_runtime_sources WHERE source_id='source-a'`)
   .run().catch(()=>{});
  // The retained trigger refuses deletion, so use an unregistered otherwise complete target.
  await expect(qualifyStorageShardRuntimeTuple(plan('a'),{...databases('a'),analytics:b.STORAGE_ANALYTICS_B}))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness`)
   .first('n')).toBe(0);
 });

 it('refuses an incomplete deletion member without catalog evidence',async()=>{
  await b.DELETION_LEDGER.prepare(`DROP TABLE storage_catalog_deletion_replay_pending`).run();
  await expect(qualifyStorageShardRuntimeTuple(plan('a'),databases('a')))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness`)
   .first('n')).toBe(0);
 });

 it('refuses an incomplete publication member without catalog evidence',async()=>{
  await b.STORAGE_PUBLICATION_DB.prepare(`DROP TABLE analytics_multi_source_publications`).run();
  await expect(qualifyStorageShardRuntimeTuple(plan('a'),databases('a')))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness`)
   .first('n')).toBe(0);
 });

 it('refuses a schema changed after the reviewed canonical digest was pinned',async()=>{
  await b.DELETION_LEDGER.prepare(`ALTER TABLE storage_erasure_targets ADD COLUMN unreviewed TEXT`).run();
  await expect(qualifyStorageShardRuntimeTuple(plan('a'),databases('a')))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness`)
   .first('n')).toBe(0);
 });

 it('revocation closes both new allocation and the atomic move reservation',async()=>{
  await enable('a');const targetReceipt=await enable('b');
  const bindings={STORAGE_INGESTION_A:b.STORAGE_INGESTION_A,STORAGE_INGESTION_B:b.STORAGE_INGESTION_B};
  const router=createCatalogStorageRouter({catalog:b.STORAGE_ROUTING_DB,bindings,clock:()=>1_100});
  const route=await router.ensureOwner('accountless:moving-owner','a',16_777_216);
  await revokeStorageShardReadiness(b.STORAGE_ROUTING_DB,targetReceipt.readinessDigest,1_200);
  await expect(router.ensureOwner('accountless:later-owner','b',16_777_216))
   .rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
  const mover=createOwnerMoveCoordinator({catalog:b.STORAGE_ROUTING_DB,bindings,clock:()=>1_200,
   verifyDestinationCopy:async()=> 'f'.repeat(64)});
  await expect(mover.begin('move-after-revocation',route,'b'))
   .rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
 expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_owner_moves`).first('n')).toBe(0);
 });

 it('requires revocation before a separately identified requalification',async()=>{
  const first=await enable('a');
  const replacementPlan={...plan('a'),qualificationId:'33333333-3333-4333-8333-333333333333',qualifiedAt:1_200};
  const replacement=await qualifyStorageShardRuntimeTuple(replacementPlan,databases('a'));
  await expect(recordStorageShardReadiness(b.STORAGE_ROUTING_DB,replacement))
   .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  await revokeStorageShardReadiness(b.STORAGE_ROUTING_DB,first.readinessDigest,1_200);
  await expect(recordStorageShardReadiness(b.STORAGE_ROUTING_DB,replacement))
   .resolves.toMatchObject({readinessDigest:replacement.readinessDigest,state:'active'});
 });

 it('serializes concurrent qualification receipts to one active tuple',async()=>{
  const left=await qualifyStorageShardRuntimeTuple(plan('a'),databases('a'));
  const right=await qualifyStorageShardRuntimeTuple({...plan('a'),
   qualificationId:'33333333-3333-4333-8333-333333333333'},databases('a'));
  const outcomes=await Promise.allSettled([
   recordStorageShardReadiness(b.STORAGE_ROUTING_DB,left),
   recordStorageShardReadiness(b.STORAGE_ROUTING_DB,right),
  ]);
  expect(outcomes.map(result=>result.status).sort()).toEqual(['fulfilled','rejected']);
  expect(await b.STORAGE_ROUTING_DB.prepare(`SELECT count(*) n FROM storage_shard_runtime_readiness
   WHERE shard_id='a' AND state='active'`).first('n')).toBe(1);
 });

 it('keeps physical size freshness independent from an active receipt',async()=>{
  await enable('a');
  const router=createCatalogStorageRouter({catalog:b.STORAGE_ROUTING_DB,
   bindings:{STORAGE_INGESTION_A:b.STORAGE_INGESTION_A},clock:()=>2_001});
  await expect(router.ensureOwner('accountless:stale-size','a',1))
   .rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
 });
});
