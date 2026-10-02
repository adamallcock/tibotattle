import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {admitMaintainedGraphPublications} from '../src/storage-analytics-maintained-work';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,type AnalyticsWorkRequest}
 from '../src/storage-analytics-partition-work';
import {advanceAnalyticsPublicationWork} from '../src/storage-analytics-publication-work';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-graph-retention',hash='a'.repeat(64);
const dayAt=(now:number,offset:number)=>new Date(now+offset*86400000).toISOString().slice(0,10);
async function setup(){await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);return Date.now();}
it('admits retained model boundary and current fits while leaving obsolete and future markers for lifecycle handling',async()=>{
 const now=await setup(),today=dayAt(now,0),oldest=dayAt(now,-69);
 const dates=[['model',dayAt(now,-70)],['model',oldest],['model',today],['model',dayAt(now,1)],
 ['fits',dayAt(now,-1)],['fits',today],['fits',dayAt(now,1)]];
 for(const [metric,day]of dates)await target.prepare('INSERT INTO analytics_partition_graph_dirty VALUES(?,?,?,1,0)')
 .bind(sourceId,metric,day).run();
 expect(await admitMaintainedGraphPublications({target,sourceId,policyRevision:hash,nowMs:now})).toBe(3);
 expect((await target.prepare("SELECT partition_key FROM analytics_partition_work WHERE stage='publication' ORDER BY partition_key").all()).results)
 .toEqual([{partition_key:'fits/'+today},{partition_key:'model/'+oldest},{partition_key:'model/'+today}]);
 expect(await admitMaintainedGraphPublications({target,sourceId,policyRevision:hash,nowMs:now})).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_graph_dirty WHERE admitted_generation=0').first<number>('n')).toBe(4);
});
it('refuses obsolete leased dates and defers future dates without writing a public result',async()=>{
 const now=await setup();
 for(const [metric,offset,outcome,reason] of [['model',-70,'refused','obsolete_input'],['fits',-1,'refused','obsolete_input'],
 ['model',1,'deferred','clock_pending'],['fits',1,'deferred','clock_pending']] as const){
 const day=dayAt(now,offset),request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'publication',lane:'history',
 partitionKey:metric+'/'+day,headKey:hash,inputRevision:hash,policyRevision:hash,day,stream:null,selectionMethod:null,
 residentBytes:1,admissionQueries:1};
 await admitAnalyticsPartitionWork(target,[request],now);
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:now,stages:['publication']});expect(lease).toBeDefined();
 const meter=createD1InvocationBudget(950),result=await advanceAnalyticsPublicationWork({target,
 sources:[{sourceId,sourceNamespace:sourceId,database:source}],lease:lease!,budget:{meter,now:()=>now,deadlineMs:now+60000,
 remainingQueries:()=>meter.remainingQueries},canonicalPreparation:createCanonicalSharedFeaturePreparation});
 expect(result).toMatchObject({outcome,reason,completedWithinLease:false});
 expect(meter.queriesUsed).toBeLessThan(10);
 // Scheduler owns refusal/retry release; the adapter must not forge completion.
 expect(await releaseAnalyticsPartitionWork(target,lease!,outcome,now)).toBe(true);
 if(outcome==='deferred')await target.prepare("UPDATE analytics_partition_work SET ready_ms=?,revision=revision+1 WHERE work_key=?")
 .bind(now+86400000,lease!.workKey).run();
 }
 for(const table of ['analytics_canonical_publication_closures','analytics_community_model_publications','analytics_community_graph_previews'])
 expect(await target.prepare('SELECT count(*) n FROM '+table).first<number>('n')).toBe(0);
});
