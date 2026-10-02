import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {MAINTAINED_ANALYTICS_ERASURE_FAMILIES,MAINTAINED_ANALYTICS_REPLAY_TRIGGERS,
 MAINTAINED_SOURCE_ERASURE_FAMILIES,MAINTAINED_SOURCE_REPLAY_TRIGGERS,
 readMaintainedAnalyticsErasureInventory,requireMaintainedSourceErasureProof} from '../src/storage-erasure-artifacts';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,readAnalyticsPartitionWork,
 releaseAnalyticsPartitionWork,retireAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const tableNames=(migrations:readonly D1Migration[])=>migrations.flatMap(m=>[...m.queries.join('\n').matchAll(/CREATE TABLE\s+(\w+)/gu)].map(v=>v[1]!)).sort();
it('inventories every maintained physical table and validates all cleanup/cascade contracts',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB,b,'synthetic-erasure-inventory');
 expect(MAINTAINED_ANALYTICS_ERASURE_FAMILIES.flatMap(f=>f.tables.map(t=>t.name)).sort()).toEqual(tableNames(b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name>='0034'&&m.name<'0049')));
 expect(MAINTAINED_SOURCE_ERASURE_FAMILIES.flatMap(f=>[...f.tables]).sort()).toEqual(tableNames(b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>m.name>='0014'&&m.name<'0016')));
 const inventory=await readMaintainedAnalyticsErasureInventory(b.STORAGE_ANALYTICS_DB);
 expect(inventory.ownerTables).toContain('analytics_partition_work_subjects');
 expect(inventory.ownerTables).toContain('analytics_cache_retention_date_cursor');
 expect(inventory.ownerTables).toContain('analytics_canonical_publication_part_subjects');
 expect(inventory.ownerTables).not.toContain('analytics_canonical_dirty_partitions');
 expect(inventory.ownerTables).not.toContain('analytics_partition_work_counts');
 expect(inventory.ownerTables).not.toContain('analytics_pipeline_runtime');
 expect(inventory.ownerTables).not.toContain('analytics_canonical_cache_prepared_receipts');
 expect(MAINTAINED_ANALYTICS_ERASURE_FAMILIES.find(f=>f.migration==='0048')?.tables).toEqual([
  {name:'analytics_canonical_cache_prepared_receipts',subject:false,references:['analytics_partition_work:cascade']},
 ]);
 await requireMaintainedSourceErasureProof(b.USAGE_MONITOR_DB,true);
 // Each replay guard is required even if there are currently no payload rows.
 for(const [db,names,check]of [
  [b.STORAGE_ANALYTICS_DB,MAINTAINED_ANALYTICS_REPLAY_TRIGGERS,()=>readMaintainedAnalyticsErasureInventory(b.STORAGE_ANALYTICS_DB)],
  [b.USAGE_MONITOR_DB,MAINTAINED_SOURCE_REPLAY_TRIGGERS,()=>requireMaintainedSourceErasureProof(b.USAGE_MONITOR_DB)],
 ]as const)for(const name of names){
  const sql=await db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').bind(name).first<string>('sql');expect(sql).toBeTruthy();
  await db.prepare('DROP TRIGGER '+name).run();await expect(check()).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  await db.prepare(sql!).run();
 }
});
it('fails closed before replay migration while retaining predecessor schema compatibility',async()=>{
 await reset();await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0034'));
 expect(await readMaintainedAnalyticsErasureInventory(b.STORAGE_ANALYTICS_DB)).toEqual({ownerTables:[],predicates:[]});
 await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0042'));
 await expect(readMaintainedAnalyticsErasureInventory(b.STORAGE_ANALYTICS_DB)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
 expect((await readMaintainedAnalyticsErasureInventory(b.STORAGE_ANALYTICS_DB)).ownerTables.length).toBeGreaterThan(20);
});
it('rejects orphan subject fairness rows while allowing anonymous global scheduling',async()=>{
 await reset();const db=b.STORAGE_ANALYTICS_DB;await applyD1Migrations(db,b.TEST_ANALYTICS_MIGRATIONS);
 await db.prepare("INSERT INTO analytics_runtime_sources VALUES('synthetic-subject','synthetic-subject',1)").run();
 await db.prepare("INSERT INTO analytics_partition_subject_schedule VALUES('synthetic-subject','',1)").run();
 await expect(db.prepare("INSERT INTO analytics_partition_subject_schedule VALUES('synthetic-subject',?,1)").bind('a'.repeat(64)).run()).rejects.toThrow('analytics_partition_subject_ineligible');
 await db.prepare("INSERT INTO analytics_owner_state VALUES('synthetic-subject',?,1,1,'active')").bind('a'.repeat(64)).run();
 await db.prepare("INSERT INTO analytics_partition_subject_schedule VALUES('synthetic-subject',?,1)").bind('a'.repeat(64)).run();
 await db.prepare("UPDATE analytics_owner_state SET state='erased' WHERE owner_digest=?").bind('a'.repeat(64)).run();
 expect((await db.prepare('SELECT owner_digest FROM analytics_partition_subject_schedule').all()).results).toEqual([{owner_digest:''}]);
 await expect(db.prepare("INSERT INTO analytics_partition_subject_schedule VALUES('synthetic-subject',?,1)").bind('a'.repeat(64)).run()).rejects.toThrow('analytics_partition_subject_ineligible');
});

it.each([
 ['analytics_partition_graph_subjects','subject_key',''],
 ['analytics_partition_graph_subjects','subject_key','ON DELETE CASCADE'],
 ['analytics_partition_graph_input_refs','scope_key',''],
 ['analytics_partition_graph_input_refs','scope_key','ON DELETE CASCADE'],
]as const)('rejects a graph fairness cursor to %s without its exact SET NULL action (%s)',async(parent,column,action)=>{
 await reset();const db=b.STORAGE_ANALYTICS_DB;
 await applyD1Migrations(db,b.TEST_ANALYTICS_MIGRATIONS);
 await expect(readMaintainedAnalyticsErasureInventory(db)).resolves.toBeTruthy();
 const sql=await db.prepare("SELECT sql FROM sqlite_schema WHERE name='analytics_partition_graph_control'").first<string>('sql');
 expect(sql).toBeTruthy();
 const reference=`REFERENCES ${parent}(${column}) ON DELETE SET NULL`;
 expect(sql).toContain(reference);
 await db.prepare('DROP TABLE analytics_partition_graph_control').run();
 await db.prepare(sql!.replace(reference,`REFERENCES ${parent}(${column}) ${action}`)).run();
 const foreignKeys=(await db.prepare('PRAGMA foreign_key_list(analytics_partition_graph_control)').all<{table:string;on_delete:string}>()).results;
 expect(foreignKeys.find(row=>row.table===parent)?.on_delete).toBe(action?'CASCADE':'NO ACTION');
 await expect(readMaintainedAnalyticsErasureInventory(db)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 await db.prepare('DROP TABLE analytics_partition_graph_control').run();
 await db.prepare(sql!).run();
 await expect(readMaintainedAnalyticsErasureInventory(db)).resolves.toBeTruthy();
});

const preparedSource='synthetic-prepared-erasure';
function preparedWork(n:number,ownerDigest:string):AnalyticsWorkRequest {
 const h=(value:number)=>value.toString(16).padStart(64,'0');
 return {sourceId:preparedSource,ownerDigest,stage:'cache',lane:'new',partitionKey:'synthetic-prepared/'+n,
  headKey:h(n),inputRevision:h(n+100),policyRevision:h(999),day:'2026-10-01',stream:'usage',
  selectionMethod:'effective-union-v1',residentBytes:1024,admissionQueries:160};
}
async function preparedParents(owners:readonly string[]) {
 await reset();const db=b.STORAGE_ANALYTICS_DB;await applyD1Migrations(db,b.TEST_ANALYTICS_MIGRATIONS);
 await db.prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(preparedSource,preparedSource).run();
 for(const owner of new Set(owners))await db.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
  .bind(preparedSource,owner).run();
 const meter=createD1InvocationBudget(950),target=meter.wrap(db);
 await admitAnalyticsPartitionWork(target,owners.map((owner,n)=>preparedWork(n+1,owner)),10);
 const leases=await claimAnalyticsPartitionWork(target,{sourceId:preparedSource,stages:['cache'],limit:owners.length,nowMs:20,leaseMs:1000});
 expect(leases).toHaveLength(owners.length);
 for(const lease of leases){
  const work=await readAnalyticsPartitionWork(target,lease,20);expect(work).not.toBeNull();
  // Receipt rows are scheduling metadata only. This fixture proves physical
  // lifecycle, without claiming prepared cache slots or source authority.
  await target.prepare(`INSERT INTO analytics_canonical_cache_prepared_receipts
   VALUES(?,?,?,?, 'canonical-cache-neighbors-v1',0,1)`)
   .bind(lease.workKey,lease.revision,work!.inputRevision,work!.partitionKey).run();
 }
 return {db,target,meter,leases};
}
it('cascades prepared receipts through bounded original-parent retirement while retaining ready and live leases',async()=>{
 const {db,target,meter,leases}=await preparedParents(['a'.repeat(64),'a'.repeat(64),'a'.repeat(64)]);
 expect(await releaseAnalyticsPartitionWork(target,leases[0]!,'complete',21)).toBe(true);
 expect(await releaseAnalyticsPartitionWork(target,leases[1]!,'deferred',21)).toBe(true);
 expect(await retireAnalyticsPartitionWork(target,{sourceId:preparedSource,beforeMs:100,limit:1})).toBe(1);
 const remaining=(await db.prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts ORDER BY work_key').all<{work_key:string}>())
  .results.map(row=>row.work_key);
 expect(remaining).toEqual([leases[1]!.workKey,leases[2]!.workKey].sort());
 expect((await db.prepare('SELECT state FROM analytics_partition_work ORDER BY state').all<{state:string}>()).results)
  .toEqual([{state:'leased'},{state:'ready'}]);
 expect(await readAnalyticsPartitionWork(target,leases[2]!,22)).not.toBeNull();
 expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
});

it('replays a retained terminal fence against restored prepared receipts without erasing another owner',async()=>{
 const erased='a'.repeat(64),other='b'.repeat(64),{db,target,meter,leases}=await preparedParents([erased,other]);
 const workRows=(await db.prepare('SELECT work_key,owner_digest FROM analytics_partition_work').all<{work_key:string;owner_digest:string}>()).results;
 const erasedKey=workRows.find(row=>row.owner_digest===erased)!.work_key,otherKey=workRows.find(row=>row.owner_digest===other)!.work_key;
 const before=(await db.prepare('SELECT * FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?').bind(otherKey).all()).results;
 // An old derived snapshot can precede an independently retained terminal
 // ledger. Restore INSERT hooks in the same fixture transaction, then exercise
 // the production replay UPDATE. No hook is weakened during verification.
 const hooks=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='analytics_storage_erasure_fences'")
  .all<{name:string;sql:string}>()).results.filter(row=>/AFTER INSERT/iu.test(row.sql));
 expect(hooks.length).toBeGreaterThan(0);
 await db.batch([...hooks.map(row=>db.prepare('DROP TRIGGER '+row.name)),
  db.prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,
   terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,2,2,2)`).bind(preparedSource,erased,'e'.repeat(64)),
  ...hooks.map(row=>db.prepare(row.sql))]);
 expect(await db.prepare('SELECT count(*) n FROM analytics_canonical_cache_prepared_receipts').first<number>('n')).toBe(2);
 await expect(readMaintainedAnalyticsErasureInventory(db)).resolves.toBeTruthy();
 await target.prepare('UPDATE analytics_storage_erasure_fences SET terminal_revision=terminal_revision WHERE source_id=? AND owner_digest=?')
  .bind(preparedSource,erased).run();
 expect(await db.prepare('SELECT 1 alive FROM analytics_partition_work WHERE work_key=?').bind(erasedKey).first()).toBeNull();
 expect(await db.prepare('SELECT 1 alive FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?').bind(erasedKey).first()).toBeNull();
 expect((await db.prepare('SELECT * FROM analytics_canonical_cache_prepared_receipts WHERE work_key=?').bind(otherKey).all()).results).toEqual(before);
 expect(await releaseAnalyticsPartitionWork(target,leases.find(lease=>lease.workKey===erasedKey)!,'complete',22)).toBe(false);
 await expect(admitAnalyticsPartitionWork(target,[preparedWork(9,erased)],22)).rejects.toThrow('ineligible');
 expect(await db.prepare('SELECT count(*) n FROM analytics_storage_erasure_fences').first<number>('n')).toBe(1);
 expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
});

it.each(['','ON DELETE SET NULL'] as const)('refuses restored prepared-receipt tables without original-parent CASCADE (%s)',async action=>{
 await reset();const db=b.STORAGE_ANALYTICS_DB;await applyD1Migrations(db,b.TEST_ANALYTICS_MIGRATIONS);
 const sql=await db.prepare("SELECT sql FROM sqlite_schema WHERE name='analytics_canonical_cache_prepared_receipts'")
  .first<string>('sql');expect(sql).toBeTruthy();
 const original='REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE';expect(sql).toContain(original);
 await db.prepare('DROP TABLE analytics_canonical_cache_prepared_receipts').run();
 await db.prepare(sql!.replace(original,'REFERENCES analytics_partition_work(work_key) '+action)).run();
 await expect(readMaintainedAnalyticsErasureInventory(db)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 await db.prepare('DROP TABLE analytics_canonical_cache_prepared_receipts').run();await db.prepare(sql!).run();
 await expect(readMaintainedAnalyticsErasureInventory(db)).resolves.toBeTruthy();
});
