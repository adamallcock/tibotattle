import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {initializeStorageSource,prepareIngestionChange,type StorageChangeInput} from '../src/analytics-delivery';
import {readStorageCommunitySourceTerminalEpoch} from '../src/storage-community-authority';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';

const b=env as Env&{STORAGE_INGESTION_A:D1Database;TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]};
const raw=()=>b.STORAGE_INGESTION_A,sourceId='synthetic-terminal-index';
const terminalOwner='a'.repeat(64),activeOwner='b'.repeat(64);
let ordinal=0;
const sourceIndex=()=>{
 const migration=b.TEST_INGESTION_ISOLATION_MIGRATIONS.find(item=>item.name.startsWith('0014_'));
 const statement=migration?.queries.find(query=>query.includes('CREATE INDEX storage_ingestion_terminal_epoch'));
 const sql=statement?.slice(statement.indexOf('CREATE INDEX storage_ingestion_terminal_epoch')).trim();
 if(!sql||!/^[\s\S]*WHERE kind IN\('owner-withdrawn','owner-erased'\);?$/u.test(sql))
  throw Error('TERMINAL_INDEX_MIGRATION_REQUIRED');return sql;
};
const receipt:Record<string,unknown>[]=[];
async function invocation<T>(label:string,operation:(db:D1Database)=>Promise<T>){
 const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
 const db=meter.wrap(profileAnalyticsDatabase(raw(),'source',profile,()=>label));
 const value=await operation(db),cost=summarizeAnalyticsProfile(profile);
 expect(cost.statements).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 expect(cost.failedStatements).toBe(0);
 receipt.push({label,statements:cost.statements,rowsRead:cost.rowsRead,rowsWritten:cost.rowsWritten});
 return {value,cost};
}
function change(ownerDigest:string,revision:number,kind:StorageChangeInput['kind'],dayOrdinal:number):StorageChangeInput{
 return {sourceId,ownerDigest,revision,kind,eventDigest:(++ordinal).toString(16).padStart(64,'0'),
  objectDigest:'c'.repeat(64),contentDigest:'d'.repeat(64),recordedMs:Date.now()-dayOrdinal*86_400_000};
}
async function append(changes:readonly StorageChangeInput[]){
 for(let from=0;from<changes.length;from+=128)await invocation('native_journal_setup',async db=>{
  await db.batch(changes.slice(from,from+128).map(row=>prepareIngestionChange(db,row)));
 });
}
async function read(){return invocation('unchanged_native_terminal_read',db=>readStorageCommunitySourceTerminalEpoch(db));}

beforeEach(async()=>{
 await reset();ordinal=0;receipt.length=0;
 await applyD1Migrations(raw(),b.TEST_TYPED_INGESTION_MIGRATIONS.filter(item=>item.name.startsWith('0002_')));
 await initializeStorageSource(raw(),sourceId);
 await invocation('exact_pending_index',db=>db.prepare(sourceIndex()).run());
});

it('uses the unchanged native containment predicate with empty,14 and466-day journals',async({task})=>{
 const empty=await read();expect(empty.value).toBe(0);expect(empty.cost.rowsRead).toBeLessThanOrEqual(1);
 await append([change(activeOwner,1,'owner-active',466)]);
 await append(Array.from({length:13},(_,index)=>change(activeOwner,index+2,'source-updated',465-index)));
 const fourteen=await read();expect(fourteen.value).toBe(0);expect(fourteen.cost.rowsRead).toBeLessThanOrEqual(1);
 await append(Array.from({length:452},(_,index)=>change(activeOwner,index+15,'source-updated',452-index)));
 const larger=await read();expect(larger.value).toBe(0);expect(larger.cost.rowsRead).toBeLessThanOrEqual(1);
 await append([change(terminalOwner,1,'owner-active',1),change(terminalOwner,2,'owner-withdrawn',1)]);
 const terminal=await read();expect(terminal.value).toBe(3);expect(terminal.cost.rowsRead).toBeLessThanOrEqual(1);
 expect(await raw().prepare('SELECT count(*) n FROM storage_ingestion_changes').first<number>('n')).toBe(468);
 Object.assign(task.meta,{terminalIndexReceipt:{cases:['empty','14_day_nonterminal','466_day_nonterminal','source_ahead_withdrawal'],
  sourceDays:466,resources:[...receipt],qualification:'Native journal writer/query and local partial-index bound only; not complete all-consumer C06 or telemetry-history qualification.'}});
});

it('preserves source-ahead maximum and retained history with dense nonterminal and terminal evidence',async({task})=>{
 await append([change(terminalOwner,1,'owner-active',466),change(terminalOwner,2,'owner-withdrawn',465),
  change(terminalOwner,3,'owner-active',464),change(terminalOwner,4,'owner-erased',463),change(activeOwner,1,'owner-active',462)]);
 await append(Array.from({length:16384},(_,index)=>change(activeOwner,index+2,'source-updated',index%462)));
 const bounded=await read();expect(bounded.value).toBe(4);expect(bounded.cost.rowsRead).toBeLessThanOrEqual(1);
 await invocation('missing_index_control',db=>db.prepare('DROP INDEX storage_ingestion_terminal_epoch').run());
 const fallback=await read();expect(fallback.value).toBe(bounded.value);expect(fallback.cost.rowsRead).toBeGreaterThan(16384);
 await invocation('exact_index_restore',db=>db.prepare(sourceIndex()).run());
 const restored=await read();expect(restored.value).toBe(bounded.value);expect(restored.cost.rowsRead).toBeLessThanOrEqual(1);
 const proof=await invocation('retention_and_plan_diagnostic',async db=>({
  retained:await db.prepare('SELECT count(*) n FROM storage_ingestion_changes').first<number>('n'),
  terminals:await db.prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE kind IN('owner-withdrawn','owner-erased')").first<number>('n'),
  plan:(await db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(MAX(public_authority_epoch),0) AS epoch FROM storage_ingestion_changes WHERE kind IN('owner-withdrawn','owner-erased')").all<{detail:string}>()).results.map(row=>row.detail),
 }));
 expect(proof.value.retained).toBe(16389);expect(proof.value.terminals).toBe(2);
 expect(proof.value.plan.some(line=>line.includes('storage_ingestion_terminal_epoch'))).toBe(true);
 Object.assign(task.meta,{terminalIndexReceipt:{nonterminalRows:16387,terminalRows:2,retainedRows:proof.value.retained,
  boundedReads:bounded.cost.rowsRead,missingIndexReads:fallback.cost.rowsRead,restoredReads:restored.cost.rowsRead,
  nativeMaximum:bounded.value,resources:[...receipt],qualification:'Measured local native MAX bound and exact fallback/retention; missing index is explicitly not bounded.'}});
});
