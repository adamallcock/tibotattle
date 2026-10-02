import { env,reset } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { advanceAnalyticsCanonicalWork } from '../src/storage-analytics-canonical-work';
import { advanceAnalyticsWorkEffects } from '../src/storage-analytics-work-effects';
import { admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,
 readAnalyticsWorkEffectKeys,type AnalyticsWorkRequest } from '../src/storage-analytics-partition-work';
import { advanceEffectiveDependencyCoverage,acknowledgeEffectiveDependencyAffectedRanges,readEffectiveDependencyAffectedRanges,
 acknowledgeEffectiveDependencyGlobalChange,readEffectiveDependencyGlobalChange } from '../src/storage-effective-selective-dependencies';
import { initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-canonical-queue',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
it('runs durable canonical pages through real feature preparation and fenced downstream admission within one actual meter',async()=>{
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
 const samples:{stage:string;queries:number;reason:string}[]=[];let inputComplete=false,featureComplete=0;
 async function step() {
 const invocation=createD1InvocationBudget(950),db=invocation.wrap(target()),ingestion=invocation.wrap(source());
 const leases=await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs:Date.now()});if(!leases.length)return null;
 const lease=leases[0]!,meter=createD1InvocationBudget(900);
 const result=await advanceAnalyticsCanonicalWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,
 budget:{meter,deadlineMs:Date.now()+60000,now:Date.now,remainingQueries:()=>Math.min(meter.remainingQueries,invocation.remainingQueries)}});
 if(!result.completedWithinLease)await releaseAnalyticsPartitionWork(db,lease,result.outcome,Date.now());
 samples.push({stage:lease.stage,queries:invocation.queriesUsed,reason:result.reason});expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 return {lease,result};
 }
 for(let n=0;n<16;n++){const progress=await step();if(progress?.lease.stage==='canonical'&&progress.result.outcome==='complete'){inputComplete=true;break;}}
 expect(inputComplete).toBe(true);
 const bridge=createD1InvocationBudget(950);await advanceAnalyticsWorkEffects({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
 meter:bridge,now:Date.now,deadlineMs:Date.now()+60000,maxEffects:16,maxDays:1});
 for(let n=0;n<20;n++){const progress=await step();if(progress?.result.reason==='features_prepared'){
 featureComplete++;expect(progress.result.completedWithinLease).toBe(true);expect(progress.result.featurePartition!.facts.length).toBeGreaterThan(0);
 const children=(await target().prepare('SELECT child_work_key FROM analytics_partition_work_links WHERE parent_work_key=?')
 .bind(progress.lease.workKey).all<{child_work_key:string}>()).results;expect(children).toHaveLength(2);
 for(const child of children)expect((await readAnalyticsWorkEffectKeys(target(),child.child_work_key)).length).toBeGreaterThan(0);
 break;}}
 expect(featureComplete).toBeGreaterThan(0);
 const work=(await target().prepare("SELECT stage,state FROM analytics_partition_work WHERE stage IN('activity','cache')").all<{stage:string;state:string}>()).results;
 expect(work.some(row=>row.stage==='activity'&&row.state==='ready')).toBe(true);
 expect(work.some(row=>row.stage==='cache'&&row.state==='ready')).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_work_subjects WHERE owner_digest=?')
 .bind(corpus.owner.ownerDigest).first<number>('n')).toBeGreaterThan(0);
 await target().prepare(`UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1
 WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest).run();
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_work_subjects WHERE owner_digest=?')
 .bind(corpus.owner.ownerDigest).first<number>('n')).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage IN('activity','cache')").first<number>('n')).toBe(0);
 console.info('P8 actual statement samples',JSON.stringify(samples));
},120_000);
