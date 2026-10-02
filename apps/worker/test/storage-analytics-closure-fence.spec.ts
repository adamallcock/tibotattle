import { env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createD1InvocationBudget,D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { readAnalyticsWorkClosureFence } from '../src/storage-analytics-closure-fence';
import { runCanonicalAnalyticsWorkPass } from '../src/storage-analytics-canonical-runtime';
import { admitAnalyticsPartitionWork } from '../src/storage-analytics-partition-work';
import { EFFECTIVE_SELECTIVE_TRIGGERS } from '../src/storage-effective-selective-dependencies';
import { initializeSharedAnalyticsCorpusDatabases, type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-closure-fast-refusal';
const bindings={source,target,sourceId,sourceNamespace:sourceId};
async function ready() {
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 for(let attempt=0;attempt<16;attempt++) {
  const invocation=createD1InvocationBudget(950);
  await runCanonicalAnalyticsWorkPass({...bindings,invocation,now:Date.now,deadlineMs:Date.now()+55_000,
   maxWaves:1,stages:['canonical','features']});
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
  const fence=await readAnalyticsWorkClosureFence(bindings);
  if(fence)return fence;
 }
 throw new Error('SYNTHETIC_CLOSURE_SETUP_INCOMPLETE');
}
function countedSource() {
 let reads=0;
 const database=new Proxy(source,{get(value,key){
  if(key==='prepare')return(sql:string)=>{reads++;return value.prepare(sql);};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
 }});
 return {database,reads:()=>reads};
}
it('rejects fresh pending target work with zero source reads and does not cache that refusal',async()=>{
 const initial=await ready(),nowMs=Date.now();
 await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'features',lane:'new',
  partitionKey:'effective-union-v1/usage/'+new Date(nowMs).toISOString().slice(0,10)+'/aa',
  headKey:'a'.repeat(64),inputRevision:'b'.repeat(64),policyRevision:'c'.repeat(64),
  day:new Date(nowMs).toISOString().slice(0,10),stream:'usage',selectionMethod:'effective-union-v1',
  residentBytes:1024,admissionQueries:160}],nowMs);
 const observed=countedSource(),meter=createD1InvocationBudget(950);
 expect(await readAnalyticsWorkClosureFence({...bindings,source:meter.wrap(observed.database),target:meter.wrap(target)})).toBeNull();
 expect(observed.reads()).toBe(0);expect(meter.queriesUsed).toBe(1);
 // A stale zero summary must never grant closure: the complete target work
 // inventory still finds the exact original pending producer before source SQL.
 await target.prepare("UPDATE analytics_partition_work_counts SET jobs=0 WHERE source_id=? AND stage='features' AND state='ready'").bind(sourceId).run();
 const stale=createD1InvocationBudget(950);
 expect(await readAnalyticsWorkClosureFence({...bindings,source:stale.wrap(observed.database),target:stale.wrap(target)})).toBeNull();
 expect(observed.reads()).toBe(0);expect(stale.queriesUsed).toBe(2);
 await target.prepare("UPDATE analytics_partition_work_counts SET jobs=(SELECT count(*) FROM analytics_partition_work w WHERE w.source_id=analytics_partition_work_counts.source_id AND w.stage=analytics_partition_work_counts.stage AND w.state=analytics_partition_work_counts.state) WHERE source_id=?").bind(sourceId).run();
 await target.prepare("DELETE FROM analytics_partition_work WHERE stage='features'").run();
 expect((await readAnalyticsWorkClosureFence({...bindings,source:observed.database}))?.proofDigest).toBe(initial.proofDigest);
 expect(observed.reads()).toBeGreaterThan(0);
});
it('still refuses a settled target when a full source capability is missing',async()=>{
 await ready();const trigger=EFFECTIVE_SELECTIVE_TRIGGERS[0]!;
 const sql=await source.prepare('SELECT sql FROM sqlite_schema WHERE name=?').bind(trigger).first<string>('sql');
 expect(sql).toBeTruthy();await source.prepare('DROP TRIGGER '+trigger).run();
 expect(await readAnalyticsWorkClosureFence(bindings)).toBeNull();
 await source.prepare(sql!).run();expect(await readAnalyticsWorkClosureFence(bindings)).not.toBeNull();
});

it('propagates final-proof budget exhaustion without orphaning concurrent source promises',async()=>{
 await ready();const complete=createD1InvocationBudget(950);
 expect(await readAnalyticsWorkClosureFence({...bindings,source:complete.wrap(source),target:complete.wrap(target)})).not.toBeNull();
 expect(complete.queriesUsed).toBeGreaterThan(4);
 // Cover the bounded final proof while its source-capability read is waiting
 // on D1 and another metered first() can refuse synchronously.
 for(const reserve of [2,3,4]){
  const meter=createD1InvocationBudget(complete.queriesUsed-reserve);
  await expect(readAnalyticsWorkClosureFence({...bindings,source:meter.wrap(source),target:meter.wrap(target)}))
   .rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
  expect(meter.queriesUsed).toBeLessThanOrEqual(complete.queriesUsed-reserve);
 }
 expect(await readAnalyticsWorkClosureFence(bindings)).not.toBeNull();
});
