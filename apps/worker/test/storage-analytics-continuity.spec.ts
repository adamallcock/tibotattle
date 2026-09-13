import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {initializeStorageSource,prepareIngestionChange,readIngestionChanges,applyAnalyticsChange} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-continuity',sourceNamespace='synthetic-original';
const options=()=>({source:source(),target:target(),sourceId,sourceNamespace});
const reconciliation='ANALYTICS_SOURCE_RESTORE_RECONCILIATION_REQUIRED';
beforeEach(async()=>{
 await reset();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV11Admission(source(),sourceNamespace);
 await initializeTypedV1Admission(source(),sourceNamespace);await initializeStorageAnalyticsRuntime(options());
});
async function accepted(ordinal=1){
 await source().batch([prepareIngestionChange(source(),{sourceId,ownerDigest:ordinal.toString(16).padStart(64,'0'),
  revision:1,kind:'owner-active',eventDigest:(ordinal+100).toString(16).padStart(64,'0'),
  objectDigest:'a'.repeat(64),contentDigest:'b'.repeat(64),recordedMs:ordinal})]);
 const event=(await readIngestionChanges(source(),sourceId,ordinal-1,1))[0]!;
 await applyAnalyticsChange(target(),event,async()=>[]);
}
async function targetState(){return {
 cursor:(await target().prepare('SELECT * FROM analytics_source_cursors').all()).results,
 receipts:(await target().prepare('SELECT * FROM analytics_applied_events ORDER BY sequence').all()).results,
 owners:(await target().prepare('SELECT * FROM analytics_owner_state ORDER BY owner_digest').all()).results,
};}
// Deliberately altered synthetic DBs model restored backups. Runtime never
// weakens these journal guards; only the disposable fixtures remove them.
describe('analytics source restore continuity',()=>{
 it('accepts a fresh pair and exact retained continuity as events arrive',async()=>{
  expect(await advanceStorageAnalytics(options())).toMatchObject({state:'idle',sequence:0});
  await accepted();expect(await advanceStorageAnalytics(options())).toMatchObject({state:'idle',sequence:1});
  await accepted(2);expect(await advanceStorageAnalytics(options())).toMatchObject({state:'idle',sequence:2});
 });
 it('refuses an older source below the target cursor without changing target receipts',async()=>{
  await accepted();await accepted(2);
  await source().prepare('DROP TRIGGER storage_ingestion_change_retained').run();
  await source().prepare('DELETE FROM storage_ingestion_changes WHERE sequence=2').run();
  const before=await targetState();await expect(advanceStorageAnalytics(options())).rejects.toThrow(reconciliation);
  expect(await targetState()).toEqual(before);
 });
 it.each(['event_digest','content_digest'])('refuses divergent %s at the same sequence',async(column)=>{
  await accepted();await source().prepare('DROP TRIGGER storage_ingestion_change_immutable').run();
  await source().prepare(`UPDATE storage_ingestion_changes SET ${column}=? WHERE sequence=1`).bind('c'.repeat(64)).run();
  const before=await targetState();await expect(advanceStorageAnalytics(options())).rejects.toThrow(reconciliation);
  expect(await targetState()).toEqual(before);
 });
 it('refuses a target cursor missing its exact delivery receipt',async()=>{
  await accepted();await target().prepare('DELETE FROM analytics_applied_events WHERE sequence=1').run();
  await expect(advanceStorageAnalytics(options())).rejects.toThrow(reconciliation);
 });
 it('refuses a cursor epoch inconsistent with its immutable receipt',async()=>{
  await accepted();await target().prepare('UPDATE analytics_source_cursors SET authority_epoch=9').run();
  await expect(advanceStorageAnalytics(options())).rejects.toThrow(reconciliation);
 });
});
