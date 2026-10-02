import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceCanonicalInputWork,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartition} from '../src/storage-canonical-feature-contributions';
import {advanceAnalyticsPublicationWork} from '../src/storage-analytics-publication-work';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {countStorageDailyContributingDevices,readCanonicalDailyDeviceCounts} from '../src/storage-community-daily-devices';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-publication-work',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
function interceptCacheWrite(mode:'lost'|'race') {
 let fired=false;
 return new Proxy(target(),{get(db,property){
  if(property==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(value,name){
    if(name==='bind')return(...values:unknown[])=>wrap(value.bind(...values));
    if(name==='run'&&sql.startsWith('INSERT INTO analytics_canonical_cache_publications'))return async()=>{
     if(!fired&&mode==='race'){fired=true;await db.prepare('UPDATE analytics_canonical_cache_clock SET expected_revision=revision,revision=revision+1 WHERE id=1').run();}
     const result=await value.run();if(!fired&&mode==='lost'){fired=true;throw Error('synthetic cache lost response');}return result;};
    const method=Reflect.get(value,name);return typeof method==='function'?method.bind(value):method;
   }});return wrap(db.prepare(sql));};
  const method=Reflect.get(db,property);return typeof method==='function'?method.bind(db):method;
 }});
}
it('runs a real leased native activity partition, preserves devices and admits publication only after its receipt',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
 calendarDays:14,graphDays:2,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 for(let i=0;i<48;i++){const result=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
 participantId:corpus.participantId,maxSteps:64,maxRows:128});if(result.status==='complete')break;}
 const day=corpus.equivalentDay,scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
 participantId:corpus.participantId,day,stream:'usage',selectionMethod:'effective-union-v1'};
 for(let i=0;i<32;i++){
 const result=await advanceCanonicalInputWork(source(),target(),{...scope,budget:{meter:createD1InvocationBudget(900),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60000}});
 if(result.state==='complete')break;expect(result.state).toBe('progress');}
 const keys=(await target().prepare(`SELECT DISTINCT partition_key FROM analytics_canonical_facts
 WHERE source_id=? AND owner_digest=? AND observed_day=? AND stream='usage'`).bind(sourceId,corpus.owner.ownerDigest,day).all<{partition_key:string}>()).results;
 expect(keys.length).toBeGreaterThan(0);
 const partition=await materializeCanonicalPartition(target(),keys[0]!.partition_key);
 if(partition.state!=='complete')throw Error('unexpected synthetic split');
 const prepared=await materializeCanonicalFeaturePartition({target:target(),partitionKey:partition.manifest.partitionKey,
 budget:{remainingQueries:()=>950,now:Date.now,deadlineMs:Date.now()+60000},stillCurrent:async()=>true});
 expect(prepared.state).toBe('complete');
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'activity',lane:'new',partitionKey:partition.manifest.partitionKey,
 headKey:'b'.repeat(64),inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day,stream:'usage',
 selectionMethod:'effective-union-v1',residentBytes:4*1024*1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target(),[request]);
 const [lease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});expect(lease).toBeTruthy();
 const meter=createD1InvocationBudget(950);
 const result=await advanceAnalyticsPublicationWork({target:target(),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:lease!,
 budget:{meter,now:Date.now,deadlineMs:Date.now()+60000,remainingQueries:()=>meter.remainingQueries},canonicalPreparation:createCanonicalSharedFeaturePreparation});
 expect(result).toMatchObject({outcome:'complete',reason:'activity_replaced',completedWithinLease:true});
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 const durable=(await target().prepare('SELECT payload FROM analytics_canonical_publication_parts').all<{payload:string}>()).results;
 expect(durable).toHaveLength(1);
 const native=await countStorageDailyContributingDevices(source(),day,[{owner:corpus.owner,effective:true}]);
 expect(JSON.parse(durable[0]!.payload).contributingDevices).toBe(native.get(corpus.owner.ownerDigest));
 const children=(await target().prepare(`SELECT w.stage,w.state FROM analytics_partition_work_links l JOIN analytics_partition_work w
 ON w.work_key=l.child_work_key WHERE l.parent_work_key=?`).bind(lease!.workKey).all()).results;
 expect(children).toEqual([{stage:'publication',state:'ready'}]);
 // A still-undrained admitted source prefix cannot be converted to a completed
 // public total merely because one activity partition has finished.
 const [publicationLease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});
 const second=createD1InvocationBudget(950);
 const publication=await advanceAnalyticsPublicationWork({target:target(),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:publicationLease!,
 budget:{meter:second,now:Date.now,deadlineMs:Date.now()+60000,remainingQueries:()=>second.remainingQueries},canonicalPreparation:createCanonicalSharedFeaturePreparation});
 expect(publication).toMatchObject({outcome:'deferred',reason:'source_prefix_pending',completedWithinLease:false});
 const counts=await readCanonicalDailyDeviceCounts(target(),sourceId,day,[{owner:corpus.owner,effective:true}]);
 if(keys.length===1)expect(counts?.get(corpus.owner.ownerDigest)).toBe(native.get(corpus.owner.ownerDigest));
},120000);

it('publishes an explicit first empty cache cohort through real leases and persists absence without fabricated curves',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const selective=await import('../src/storage-effective-selective-dependencies');
 for(let n=0;n<16;n++){const progress=await selective.advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,maxSteps:64,maxRows:128});
 if(progress.status==='complete')break;}
 await selective.acknowledgeEffectiveDependencyAffectedRanges(source(),await selective.readEffectiveDependencyAffectedRanges(source(),128));
 const global=await selective.readEffectiveDependencyGlobalChange(source());if(global)await selective.acknowledgeEffectiveDependencyGlobalChange(source(),global);
 await target().prepare('INSERT INTO analytics_partition_reconciliation(source_id,complete) VALUES(?,1)').bind(sourceId).run();
 const day=new Date().toISOString().slice(0,10),partitionKey='effective-union-v1/usage/'+day+'/00';
 const partition=await materializeCanonicalPartition(target(),partitionKey);if(partition.state!=='complete')throw Error('empty partition');
 await admitAnalyticsPartitionWork(target(),[{sourceId,ownerDigest:null,stage:'cache',lane:'new',partitionKey,
 headKey:'d'.repeat(64),inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day,stream:'usage',
 selectionMethod:'effective-union-v1',residentBytes:2*1024*1024,admissionQueries:100}]);
 const {advanceAnalyticsCacheWork}=await import('../src/storage-analytics-cache-work');
 const [cacheLease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});
 const budget=()=>{const meter=createD1InvocationBudget(950);return {meter,now:Date.now,deadlineMs:Date.now()+60000,remainingQueries:()=>meter.remainingQueries};};
 expect(await advanceAnalyticsCacheWork({target:target(),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:cacheLease!,budget:budget()}))
 .toMatchObject({outcome:'complete',reason:'cache_prepared'});
 const [lease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});
 const measured=budget();
 expect(await advanceAnalyticsPublicationWork({target:interceptCacheWrite('lost'),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:lease!,budget:measured,
 canonicalPreparation:createCanonicalSharedFeaturePreparation})).toMatchObject({outcome:'complete',reason:'cache_published',completedWithinLease:true});
 expect(measured.meter.queriesUsed).toBeLessThan(600);
 console.log('canonical empty cache publication queries',measured.meter.queriesUsed);
 const row=await target().prepare('SELECT payload_json,revision FROM analytics_canonical_cache_publications WHERE source_id=?').bind(sourceId)
 .first<{payload_json:string;revision:number}>();expect(row).toEqual({payload_json:'null',revision:1});
 expect((await target().prepare("SELECT outcome FROM analytics_canonical_publication_expected e JOIN analytics_canonical_publication_closures c USING(closure_key) WHERE c.family='cache'").all()).results)
 .toEqual([{outcome:'empty'}]);
 const {readPublishedCanonicalCache}=await import('../src/storage-community-cache-publication');
 const {captureStorageCommunityAuthority}=await import('../src/storage-community-authority');
 expect(await readPublishedCanonicalCache({target:target(),sourceId,nowMs:Date.now(),terminalEpoch:0,
 authority:await captureStorageCommunityAuthority(source(),{sourceId,sourceNamespace:sourceId})})).toBeNull();
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'publication',lane:'new',partitionKey,
  headKey:'f'.repeat(64),inputRevision:partition.manifest.contentRevision,policyRevision:'c'.repeat(64),day,stream:'usage',
  selectionMethod:'effective-union-v1',residentBytes:2*1024*1024,admissionQueries:200};
 await admitAnalyticsPartitionWork(target(),[request]);
 const [replayLease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});
 expect(await advanceAnalyticsPublicationWork({target:target(),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:replayLease!,budget:budget(),
 canonicalPreparation:createCanonicalSharedFeaturePreparation})).toMatchObject({outcome:'complete',reason:'cache_unchanged'});
 expect(await target().prepare('SELECT revision FROM analytics_canonical_cache_publications').first<number>('revision')).toBe(1);
 // A changed prepared cache clock must lose at the actual snapshot writer,
 // even after all source and membership proofs passed.
 await target().prepare('UPDATE analytics_canonical_cache_clock SET expected_revision=revision,revision=revision+1 WHERE id=1').run();
 await admitAnalyticsPartitionWork(target(),[{...request,headKey:'e'.repeat(64)}]);
 const [raceLease]=await claimAnalyticsPartitionWork(target(),{sourceId,limit:1,nowMs:Date.now()});
 expect(await advanceAnalyticsPublicationWork({target:interceptCacheWrite('race'),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:raceLease!,budget:budget(),
 canonicalPreparation:createCanonicalSharedFeaturePreparation})).toMatchObject({outcome:'deferred',reason:'publication_changed'});
 expect(await target().prepare('SELECT revision FROM analytics_canonical_cache_publications').first<number>('revision')).toBe(1);
 expect(await advanceAnalyticsPublicationWork({target:target(),sources:[{sourceId,sourceNamespace:sourceId,database:source()}],lease:raceLease!,budget:budget(),
 canonicalPreparation:createCanonicalSharedFeaturePreparation})).toMatchObject({outcome:'complete',reason:'cache_published'});
 expect(await target().prepare('SELECT revision FROM analytics_canonical_cache_publications').first<number>('revision')).toBe(2);
 const {admitCanonicalCachePublicationRefresh}=await import('../src/storage-community-cache-publication');
 const clockInput={source:source(),target:target(),sourceId,sourceNamespace:sourceId,policyRevision:'c'.repeat(64),nowMs:Date.now()};
 expect(await admitCanonicalCachePublicationRefresh(clockInput)).toEqual([]);
 expect(await admitCanonicalCachePublicationRefresh({...clockInput,sourceNamespace:'synthetic-wrong-binding',nowMs:Date.now()+86400000})).toEqual([]);
 const nextDay={...clockInput,nowMs:Date.now()+86400000},keys=await admitCanonicalCachePublicationRefresh(nextDay);
 expect(keys).toHaveLength(1);
 await target().prepare('UPDATE analytics_canonical_cache_clock SET expected_revision=revision,revision=revision+1 WHERE id=1').run();
 expect(await admitCanonicalCachePublicationRefresh(nextDay)).toEqual(keys);
 expect(await target().prepare('SELECT day FROM analytics_partition_work WHERE work_key=?').bind(keys[0]).first<string>('day'))
 .toBe(new Date(nextDay.nowMs).toISOString().slice(0,10));
},120000);
