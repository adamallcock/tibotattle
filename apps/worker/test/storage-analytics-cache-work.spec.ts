import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceAnalyticsCanonicalWork} from '../src/storage-analytics-canonical-work';
import {advanceAnalyticsCacheWork} from '../src/storage-analytics-cache-work';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,
 readAnalyticsWorkEffectKeys,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage,acknowledgeEffectiveDependencyAffectedRanges,readEffectiveDependencyAffectedRanges,
 acknowledgeEffectiveDependencyGlobalChange,readEffectiveDependencyGlobalChange} from '../src/storage-effective-selective-dependencies';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-cache-work',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
it('executes the concrete cache stage under one 950 statement meter and retains exact publication lineage',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  calendarDays:14,graphDays:2,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 for(let n=0;n<24;n++){const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
  participantId:corpus.participantId,maxSteps:64,maxRows:128});if(progress.status==='complete')break;}
 await acknowledgeEffectiveDependencyAffectedRanges(source(),await readEffectiveDependencyAffectedRanges(source(),128));
 const global=await readEffectiveDependencyGlobalChange(source());if(global)await acknowledgeEffectiveDependencyGlobalChange(source(),global);
 const hash='b'.repeat(64),request:AnalyticsWorkRequest={sourceId,ownerDigest:corpus.owner.ownerDigest,stage:'canonical',lane:'new',
  partitionKey:'input/'+hash,headKey:hash,inputRevision:hash,policyRevision:hash,day:corpus.graphDates[0]!,stream:'usage',
  selectionMethod:'effective-union-v1',residentBytes:4*1024*1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target(),[request]);
 const sources=[{sourceId,sourceNamespace:sourceId,database:source()}];
 let canonicalComplete=false,cacheComplete=0,featureComplete=0;const samples:{stage:string;reason:string;queries:number}[]=[];
 for(let pass=0;pass<100;pass++) {
  const outer=createD1InvocationBudget(950),meter=createD1InvocationBudget(900),db=outer.wrap(target());
  const leases=await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs:Date.now()});if(!leases.length)continue;
  const lease=leases[0]!;
  if(lease.stage==='activity'||lease.stage==='publication') {
   // Other stage owners are deliberately left with a live lease, not marked
   // complete by this scoped integration test.
   continue;
  }
  const input={target:db,sources:sources.map(binding=>({...binding,database:outer.wrap(binding.database)})),lease,
   budget:{meter,deadlineMs:Date.now()+60_000,now:Date.now,remainingQueries:()=>Math.min(outer.remainingQueries,meter.remainingQueries)}};
  const result=lease.stage==='cache'?await advanceAnalyticsCacheWork(input):await advanceAnalyticsCanonicalWork(input);
  if(!result.completedWithinLease)await releaseAnalyticsPartitionWork(db,lease,result.outcome,Date.now());
  samples.push({stage:lease.stage,reason:result.reason,queries:outer.queriesUsed});expect(outer.queriesUsed).toBeLessThanOrEqual(950);
  if(lease.stage==='canonical'&&result.outcome==='complete'&&!canonicalComplete) {
   canonicalComplete=true;for(let page=0;page<3;page++){const bridge=createD1InvocationBudget(950);
   await advanceAnalyticsWorkEffects({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
    meter:bridge,now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});}
  }
  if(result.reason==='features_prepared')featureComplete++;
  if(result.reason==='cache_prepared') {
   cacheComplete++;expect(result.completedWithinLease).toBe(true);
   const children=(await target().prepare(`SELECT w.work_key,w.stage FROM analytics_partition_work_links l JOIN analytics_partition_work w
    ON w.work_key=l.child_work_key WHERE l.parent_work_key=?`).bind(lease.workKey).all<{work_key:string;stage:string}>()).results;
   expect(children).toHaveLength(1);expect(children[0]!.stage).toBe('publication');
   expect((await readAnalyticsWorkEffectKeys(target(),children[0]!.work_key)).length).toBeGreaterThan(0);
   expect(await advanceAnalyticsCacheWork(input)).toMatchObject({outcome:'deferred',reason:'lease_changed',completedWithinLease:false});
   break;
  }
 }
 expect(canonicalComplete).toBe(true);expect(featureComplete).toBeGreaterThan(0);expect(cacheComplete,JSON.stringify(samples)).toBeGreaterThan(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_nodes').first<number>('n')).toBeGreaterThan(0);
 console.info('P6 actual statement samples',JSON.stringify(samples));
},120_000);
