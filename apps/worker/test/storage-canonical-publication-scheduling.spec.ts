import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {readAnalyticsWorkClosureFence} from '../src/storage-analytics-closure-fence';
import {admitAnalyticsPartitionWork} from '../src/storage-analytics-partition-work';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-publication-scheduling';
const bindings={source,target,sourceId,sourceNamespace:sourceId};
const day=()=>new Date(Date.now()-86400000).toISOString().slice(0,10);
async function setup(){
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 for(let attempt=0;attempt<16;attempt++){
  const invocation=createD1InvocationBudget(950);
  await runCanonicalAnalyticsWorkPass({...bindings,invocation,now:Date.now,deadlineMs:Date.now()+55000,
   maxWaves:1,stages:['canonical','features']});
  if(await readAnalyticsWorkClosureFence(bindings)){
   await target.prepare('INSERT INTO analytics_community_daily_queue(source_id,day,revision) VALUES(?,?,1)').bind(sourceId,day()).run();
   return;
  }
 }
 throw new Error('SYNTHETIC_PUBLICATION_SCHEDULING_SETUP_INCOMPLETE');
}
async function pending(){
 await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'features',lane:'new',
  partitionKey:'effective-union-v1/usage/'+day()+'/aa',headKey:'a'.repeat(64),inputRevision:'b'.repeat(64),
  policyRevision:'c'.repeat(64),day:day(),stream:'usage',selectionMethod:'effective-union-v1',
  residentBytes:1024,admissionQueries:160}]);
}
function traced(db:D1Database,statements:string[],afterFirst:(sql:string)=>Promise<void>=async()=>{}):D1Database{
 return new Proxy(db,{get(value,key){
  if(key==='prepare')return(sql:string)=>{
   statements.push(sql);
   const wrap=(inner:D1PreparedStatement):D1PreparedStatement=>new Proxy(inner,{get(statement,name){
    if(name==='bind')return(...values:unknown[])=>wrap(statement.bind(...values));
    if(name==='first')return async<T>(column?:string)=>{
     const result=column===undefined?await statement.first<T>():await statement.first<T>(column);
     await afterFirst(sql);return result;
    };
    const member=Reflect.get(statement,name);return typeof member==='function'?member.bind(statement):member;
   }});return wrap(value.prepare(sql));
  };
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
 }});
}
const pass=(extra:Partial<Parameters<typeof runStorageAnalyticsPass>[0]>={})=>runStorageAnalyticsPass({
 ...bindings,ledger:b.DELETION_LEDGER,publishCommunity:true,publicOnly:true,publicationOnly:true,
 canonicalPipeline:true,maxSteps:32,maxQueries:950,deadlineMs:Date.now()+60000,...extra,
});

it('suppresses blocked publication once, retains erasure and every ordinary retirement page, and probes again next invocation',async()=>{
 await setup();await pending();const queries:string[]=[],ledgerQueries:string[]=[];
 const before=await target.prepare("SELECT work_key,revision,attempts,state FROM analytics_partition_work WHERE stage='features'").first();
 const result=await pass({target:traced(target,queries),ledger:traced(b.DELETION_LEDGER,ledgerQueries)});
 expect(result).toMatchObject({state:'deferred',reason:'source_prefix_pending',steps:1,dailyPublications:0,graphCalculations:0});
 expect(result.queriesUsed).toBeLessThan(100);
 expect(ledgerQueries.some(sql=>sql.includes('storage_erasure_jobs'))).toBe(true);
 for(const table of ['analytics_v1_chunk_values','analytics_v11_projection_work','analytics_community_graph_results',
  'analytics_community_daily_publications','analytics_community_model_publications'])
  expect(queries.some(sql=>sql.includes(table))).toBe(true);
 expect(queries.some(sql=>sql.includes('SELECT day FROM analytics_community_daily_queue'))).toBe(false);
 expect(await target.prepare('SELECT revision FROM analytics_community_daily_queue WHERE source_id=? AND day=?').bind(sourceId,day()).first<number>('revision')).toBe(1);
 expect(await target.prepare("SELECT work_key,revision,attempts,state FROM analytics_partition_work WHERE stage='features'").first()).toEqual(before);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
 await target.prepare("DELETE FROM analytics_partition_work WHERE stage='features'").run();
 const next=await pass();expect(next.reason).not.toBe('source_prefix_pending');expect(next.queriesUsed).toBeLessThanOrEqual(950);
 expect(next.dailyPublications).toBe(1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(1);
 console.log(JSON.stringify({event:'synthetic_publication_negative_hint_cost',pendingQueries:result.queriesUsed,pendingSteps:result.steps,retryQueries:next.queriesUsed,published:next.dailyPublications}));
});

it('uses a negative hint for only one invocation when a producer settles during the hint',async()=>{
 await setup();await pending();let settledDuringHint=false;
 const observed=traced(target,[],async sql=>{
  if(!settledDuringHint&&sql.includes('SELECT 1 pending FROM analytics_partition_work_counts')){
   settledDuringHint=true;await target.prepare("DELETE FROM analytics_partition_work WHERE stage='features'").run();
  }
 });
 expect(await pass({target:observed})).toMatchObject({state:'deferred',reason:'source_prefix_pending',dailyPublications:0});
 expect(settledDuringHint).toBe(true);expect(await readAnalyticsWorkClosureFence(bindings)).not.toBeNull();
 expect((await pass()).reason).not.toBe('source_prefix_pending');
});

it('retains the complete publication source proof after a positive target hint',async()=>{
 await setup();let targetRead=false;
 const observed=traced(target,[],async sql=>{
  if(!targetRead&&sql.startsWith('SELECT r.source_namespace AS namespace')){
   targetRead=true;await source.prepare('UPDATE storage_effective_selective_bootstrap SET complete=0 WHERE id=1').run();
  }
 });
 const result=await pass({target:observed});expect(targetRead).toBe(true);
 expect(result.reason).not.toBe('source_prefix_pending');expect(result.dailyPublications).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
 expect(await readAnalyticsWorkClosureFence(bindings)).toBeNull();
});


it('retains deadline precedence and starts no extra publication retirement after an ordinary sweep crosses the deadline',async()=>{
 await setup();await pending();const started=Date.now(),deadlineMs=started+60000;
 let current=started,crossed=false;const queries:string[]=[];
 const observed=traced(target,queries,async sql=>{
  if(sql.startsWith('SELECT s.key_digest,s.generation FROM analytics_history_checkpoint_stages')){
   crossed=true;current=deadlineMs;
  }
 });
 const clock=vi.spyOn(Date,'now').mockImplementation(()=>current);
 try{
  const result=await pass({target:observed,deadlineMs});
  expect(crossed).toBe(true);expect(result).toMatchObject({state:'deferred',reason:'deadline',dailyPublications:0});
  expect(queries.some(sql=>sql.startsWith('DELETE FROM analytics_community_daily_owners'))).toBe(false);
  expect(queries.some(sql=>sql.startsWith('DELETE FROM analytics_community_model_publications'))).toBe(false);
 }finally{clock.mockRestore();}
});
