import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import {advanceEffectiveDependencyCoverage,readEffectiveDependencyAffectedRanges,acknowledgeEffectiveDependencyAffectedRanges,
 readEffectiveDependencyGlobalChange,acknowledgeEffectiveDependencyGlobalChange} from '../src/storage-effective-selective-dependencies';
import {admitAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
it('composes actual canonical, feature and cache jobs through durable claims, counters and reasons under the shared950 budget',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-runtime';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:12,graphDays:2,
  anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 for(let n=0;n<24;n++)if((await advanceEffectiveDependencyCoverage(source,{sourceId,sourceNamespace:sourceId,
  participantId:corpus.participantId,maxSteps:64,maxRows:128})).status==='complete')break;
 await acknowledgeEffectiveDependencyAffectedRanges(source,await readEffectiveDependencyAffectedRanges(source,128));
 const global=await readEffectiveDependencyGlobalChange(source);if(global)await acknowledgeEffectiveDependencyGlobalChange(source,global);
 const hash='b'.repeat(64),request:AnalyticsWorkRequest={sourceId,ownerDigest:corpus.owner.ownerDigest,stage:'canonical',lane:'new',
  partitionKey:'input/'+hash,headKey:hash,inputRevision:hash,policyRevision:hash,day:corpus.graphDates[0]!,stream:'usage',
  selectionMethod:'effective-union-v1',residentBytes:4*1024*1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target,[request]);
 const samples:unknown[]=[];let cacheComplete=0;
 for(let turn=0;turn<80&&!cacheComplete;turn++){
  const invocation=createD1InvocationBudget(950),progress=await runCanonicalAnalyticsWorkPass({source,target,sourceId,sourceNamespace:sourceId,
   invocation,now:Date.now,deadlineMs:Date.now()+60_000,maxWaves:4,stages:['canonical','features','cache']});
  samples.push(progress);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(progress.failed).toBe(0);
  cacheComplete=await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='complete'").first<number>('n')??0;
 }
 expect(cacheComplete,JSON.stringify(samples.slice(-8))).toBeGreaterThan(0);
 const stored=(await target.prepare(`SELECT stage,state,count(*) AS jobs FROM analytics_partition_work GROUP BY stage,state ORDER BY stage,state`)
  .all()).results;
 const counted=(await target.prepare(`SELECT stage,state,jobs FROM analytics_partition_work_counts WHERE jobs>0 ORDER BY stage,state`).all()).results;
 expect(counted).toEqual(stored);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE reason_code='cache_prepared'").first<number>('n')).toBeGreaterThan(0);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication' AND state='ready'").first<number>('n')).toBeGreaterThan(0);
},120_000);

it('gives bounded retirement a turn before pending coverage, while retaining a ready descendant',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-runtime-retirement';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:12,graphDays:2,
  anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 const hash='b'.repeat(64),nowMs=Date.now();
 const add=async(key:string,state:'complete'|'ready')=>target.prepare(`INSERT INTO analytics_partition_work
  (work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,day,
   stream,selection_method,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms,state)
  VALUES(?,?,?,NULL,?,?,?,'cleanup','history',NULL,NULL,NULL,1,1,0,0,0,?)`)
  .bind(key,key,sourceId,'retirement/'+key,hash,hash,state).run();
 for(let n=0;n<48;n++)await add(n.toString(16).padStart(64,'0'),'complete');
 const parent='c'.repeat(64),child='d'.repeat(64);
 await add(parent,'complete');await add(child,'ready');
 await target.prepare('INSERT INTO analytics_partition_work_links VALUES(?,?)').bind(parent,child).run();
 let pendingCoverage=false;
 for(let turn=0;turn<3;turn++){
  const meter=createD1InvocationBudget(950);
  const before=await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE state='complete'").first<number>('n');
  const result=await runCanonicalAnalyticsWorkPass({source,target,sourceId,sourceNamespace:sourceId,invocation:meter,
   now:()=>nowMs,deadlineMs:nowMs+60_000,maxWaves:1,stages:['canonical']});
  expect(result.retirement).toMatchObject({state:'progress',workRetired:16});
  expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE state='complete'").first<number>('n')).toBe(before!-16);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(result.failed).toBe(0);
  pendingCoverage||=result.coverage?.status==='progress'||result.coverage?.status==='deferred';
  expect(await target.prepare('SELECT count(*) n FROM analytics_partition_work_links WHERE parent_work_key=? AND child_work_key=?')
   .bind(parent,child).first<number>('n')).toBe(1);
 }
 expect(pendingCoverage).toBe(true);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE state='complete'").first<number>('n')).toBe(1);
 expect(await target.prepare('SELECT revision FROM analytics_partition_maintenance WHERE source_id=?').bind(sourceId).first<number>('revision')).toBe(3);
 // Publication/cache calls cannot acquire the analytics maintenance opportunity.
 const meter=createD1InvocationBudget(950);
 const other=await runCanonicalAnalyticsWorkPass({source,target,sourceId,sourceNamespace:sourceId,invocation:meter,
  now:()=>nowMs,deadlineMs:nowMs+60_000,maxWaves:1,stages:['cleanup'],bridge:false});
 expect(other.retirement).toBeUndefined();
 expect(await target.prepare('SELECT revision FROM analytics_partition_maintenance WHERE source_id=?').bind(sourceId).first<number>('revision')).toBe(3);
},60_000);


it('computes the per-job ceiling from the actual runtime meter and reports unclaimed work as pending',async({task})=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-runtime-admission';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const nowMs=Date.now(),day=new Date(nowMs).toISOString().slice(0,10),hash='b'.repeat(64);
 const [workKey]=await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'features',lane:'recovery',
  partitionKey:'effective-union-v1/usage/'+day+'/bb',headKey:hash,inputRevision:hash,policyRevision:hash,
  day,stream:'usage',selectionMethod:'effective-union-v1',residentBytes:4*1024*1024,admissionQueries:600}],nowMs);
 const before=await target.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(workKey).first();
 const claims:Record<string,unknown>[]=[];
 const observed=new Proxy(target,{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='all'&&sql.startsWith("UPDATE analytics_partition_work SET state='leased'"))return async(...args:unknown[])=>{
     const result=await Reflect.apply(inner.all,inner,args) as D1Result<Record<string,unknown>>;claims.push(...result.results);return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  }
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950);
 const meteredSource=invocation.wrap(profileAnalyticsDatabase(source,'source',profile,()=> 'runtime_meter_prelude'));
 const meteredTarget=profileAnalyticsDatabase(observed,'target',profile,()=> 'runtime_admission');
 // These are actual metered statements, not a rewritten query count or clock.
 // The complete invocation then carries only517 queries into the native pass.
 for(let n=0;n<433;n++)await meteredSource.prepare('SELECT 1 native_prelude').first();
 expect(invocation.remainingQueries).toBe(517);
 const result=await runCanonicalAnalyticsWorkPass({source:meteredSource,target:meteredTarget,sourceId,sourceNamespace:sourceId,
  invocation,now:()=>nowMs,deadlineMs:nowMs+60_000,maxWaves:1,stages:['features'],bridge:false});
 expect(result).toMatchObject({state:'deferred',reason:'work_pending',claimed:0,admitted:0,complete:0,failed:0});
 expect(claims).toEqual([]);
 const diagnostic=createD1InvocationBudget(950),proof=diagnostic.wrap(target);
 expect(await proof.prepare('SELECT * FROM analytics_partition_work WHERE work_key=?').bind(workKey).first()).toEqual(before);
 expect((await proof.prepare("SELECT * FROM analytics_partition_work_counts WHERE source_id=? AND stage='features' AND state='leased'")
  .bind(sourceId).all()).results).toEqual([]);
 const costs=Object.values(profile.costs);expect(costs.reduce((n,c)=>n+c.statements,0)).toBe(invocation.queriesUsed);
 expect(costs.reduce((n,c)=>n+c.failedStatements,0)).toBe(0);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 Object.assign(task.meta,{runtimeAdmission:{actualPreludeStatements:433,entryRemaining:517,result,statements:invocation.queriesUsed,
  rowsRead:costs.reduce((n,c)=>n+c.rowsRead,0),rowsWritten:costs.reduce((n,c)=>n+c.rowsWritten,0),diagnosticStatements:diagnostic.queriesUsed,
  qualification:'Actual runtime eligibility and pending receipt; no producer completion or all-output claim.'}});
},60_000);
