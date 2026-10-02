import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {prepareIngestionChange} from '../src/analytics-delivery';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceStorageCommunityDaily,readPublishedStorageCommunityDaily} from '../src/storage-community-daily';
import {advanceStorageAnalytics,initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {readAnalyticsWorkClosureFence} from '../src/storage-analytics-closure-fence';
import {admitAnalyticsPartitionWork} from '../src/storage-analytics-partition-work';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_B:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,reference=b.STORAGE_INGESTION_B,sourceId='synthetic-empty-daily';
const bindings={source,target,sourceId,sourceNamespace:sourceId};
async function setup(){
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 await applyD1Migrations(reference,b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({...bindings,target:reference});
 for(let attempt=0;attempt<16;attempt++){
  const invocation=createD1InvocationBudget(950);
  await runCanonicalAnalyticsWorkPass({...bindings,invocation,now:Date.now,deadlineMs:Date.now()+55000,
   maxWaves:1,stages:['canonical','features']});
  if(await readAnalyticsWorkClosureFence(bindings))return;
 }
 throw Error('SYNTHETIC_EMPTY_DAILY_CLOSURE_INCOMPLETE');
}
function options(day:string,nowMs:number,sourceDatabase=source,targetDatabase=target){
 const meter=createD1InvocationBudget(950);
 return {...bindings,source:meter.wrap(sourceDatabase),target:meter.wrap(targetDatabase),day,nowMs,sharedFeatures:true,
 canonicalPreparation:createCanonicalSharedFeaturePreparation,
 sharedFeatureBudget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60000,now:Date.now}};
}
it('publishes a fully reconciled first empty carry day through exact zero expectations with native daily parity',async()=>{
 await setup();const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);
 expect((await advanceStorageCommunityDaily({...bindings,target:reference,day,nowMs:now})).state).toBe('published');
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_work').first<number>('n')).toBe(0);
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'published',ownersAdvanced:0});
 const candidateRows=(await readPublishedStorageCommunityDaily({...bindings,fromDay:day,throughDay:day,canonicalPublications:true})).rows;
 const nativeRows=(await readPublishedStorageCommunityDaily({...bindings,target:reference,fromDay:day,throughDay:day})).rows;
 expect(candidateRows).toEqual(nativeRows);expect(candidateRows).toHaveLength(1);
 expect((await target.prepare("SELECT state,expected_count FROM analytics_canonical_publication_closures WHERE family='activity'").all()).results)
 .toEqual([{state:'complete',expected_count:0}]);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_expected').first<number>('n')).toBe(0);
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'unchanged',ownersAdvanced:0});
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(1);
});
it('never publishes zero while current source work remains pending',async()=>{
 await setup();const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);
 await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'features',lane:'new',
 partitionKey:'effective-union-v1/usage/'+day+'/aa',headKey:'a'.repeat(64),inputRevision:'b'.repeat(64),policyRevision:'c'.repeat(64),
 day,stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1,admissionQueries:1}],now);
 expect(await readAnalyticsWorkClosureFence(bindings)).toBeNull();
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'deferred',reason:'projection_pending'});
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
});

function observe(db:D1Database,beforePrepare:(sql:string)=>void=()=>{},beforeFirst:(sql:string)=>Promise<void>=async()=>{},
 afterFirst:(sql:string)=>void=()=>{}):D1Database {
 return new Proxy(db,{get(original,key){
  if(key==='prepare')return (sql:string)=>{
   beforePrepare(sql);
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(value,name){
    if(name==='bind')return (...values:unknown[])=>wrap(value.bind(...values));
    if(name==='first')return async<T>(column?:string)=>{await beforeFirst(sql);const result=column===undefined?await value.first<T>():await value.first<T>(column);afterFirst(sql);return result;};
    const method=Reflect.get(value,name);return typeof method==='function'?method.bind(value):method;
   }});return wrap(original.prepare(sql));
  };
  const method=Reflect.get(original,key);return typeof method==='function'?method.bind(original):method;
 }});
}
it('never converts incomplete source discovery into an empty daily result',async()=>{
 await setup();const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);
 await source.prepare('UPDATE storage_effective_selective_bootstrap SET complete=0 WHERE id=1').run();
 expect(await readAnalyticsWorkClosureFence(bindings)).toBeNull();
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'deferred',reason:'projection_pending'});
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
});
it('rejects a journaled source terminal between the final maintained fence and authority capture',async()=>{
 await setup();const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);
 let valuesSelected=false,finalTargetRead=false,raced=false,targetReads=0;
 const observedTarget=observe(target,sql=>{
  if(sql.startsWith('WITH budget AS MATERIALIZED(SELECT COALESCE(SUM(length(CAST(values_json'))valuesSelected=true;
 },undefined,sql=>{
  if(valuesSelected&&sql.startsWith('SELECT r.source_namespace AS namespace'))finalTargetRead=++targetReads===2;
 });
 const observedSource=observe(source,undefined,async sql=>{
  if(!raced&&finalTargetRead&&sql.startsWith('SELECT s.source_id AS sourceId')){
   raced=true;
   const common={sourceId,ownerDigest:'a'.repeat(64),objectDigest:'c'.repeat(64),contentDigest:'d'.repeat(64),recordedMs:now};
   await source.batch([prepareIngestionChange(source,{...common,eventDigest:'b'.repeat(64),revision:1,kind:'owner-active'}),
    prepareIngestionChange(source,{...common,eventDigest:'e'.repeat(64),revision:2,kind:'owner-withdrawn'})]);
  }
 });
 expect(await advanceStorageCommunityDaily(options(day,now,observedSource,observedTarget)))
 .toMatchObject({state:'deferred',reason:'source_changed'});
 expect(raced).toBe(true);
 expect(await source.prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE kind='owner-withdrawn'").first<number>('n')).toBe(1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
});
it.each(['sealed','complete'] as const)('resumes an explicit empty closure after a lost %s write response without duplicate publication',async state=>{
 await setup();const now=Date.now(),day=new Date(now-86400000).toISOString().slice(0,10);let lost=false;
 const interrupted=new Proxy(target,{get(original,key){
  if(key==='prepare')return (sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(value,name){
    if(name==='bind')return (...values:unknown[])=>wrap(value.bind(...values));
    if(name==='run')return async()=>{const result=await value.run();
     if(!lost&&sql.startsWith(`UPDATE analytics_canonical_publication_closures SET state='${state}'`)){
      lost=true;throw Error('SYNTHETIC_EMPTY_CLOSURE_LOST_RESPONSE');
     }return result;
    };
    const method=Reflect.get(value,name);return typeof method==='function'?method.bind(value):method;
   }});return wrap(original.prepare(sql));
  };
  const method=Reflect.get(original,key);return typeof method==='function'?method.bind(original):method;
 }});
 await expect(advanceStorageCommunityDaily(options(day,now,source,interrupted))).rejects.toThrow('SYNTHETIC_EMPTY_CLOSURE_LOST_RESPONSE');
 expect(lost).toBe(true);
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'published',ownersAdvanced:0});
 expect(await advanceStorageCommunityDaily(options(day,now))).toMatchObject({state:'unchanged',ownersAdvanced:0});
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(1);
});

it('never closes a current nonempty canonical day with zero expectations',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({...bindings,targetAuthority:'ordered-delivery',calendarDays:10,graphDays:1,
  anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 let deliveryIdle=false;
 for(let turn=0;turn<64;turn++){
  const meter=createD1InvocationBudget(950);
  const progress=await advanceStorageAnalytics({...bindings,source:meter.wrap(source),target:meter.wrap(target),deadlineMs:Date.now()+55000});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(progress.state==='idle'){deliveryIdle=true;break;}
 }
 expect(deliveryIdle).toBe(true);
 let closed=false;
 for(let turn=0;turn<160;turn++){
  const invocation=createD1InvocationBudget(950);
  const progress=await runCanonicalAnalyticsWorkPass({...bindings,invocation,now:Date.now,deadlineMs:Date.now()+55000,
   maxWaves:16,stages:['canonical','features']});
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(progress.failed).toBe(0);
  if(await readAnalyticsWorkClosureFence(bindings)){closed=true;break;}
 }
 expect(closed).toBe(true);const day=corpus.equivalentDay;
 expect(await target.prepare(`SELECT count(*) n FROM analytics_canonical_heads h JOIN analytics_canonical_facts f USING(revision)
  WHERE f.source_id=? AND f.observed_day=?`).bind(sourceId,day).first<number>('n')).toBeGreaterThan(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await advanceStorageCommunityDaily(options(day,Date.now()))).toMatchObject({state:'deferred',reason:'projection_pending'});
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
},120000);
