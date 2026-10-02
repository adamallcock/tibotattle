import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,completeAnalyticsPartitionWork,
 readAnalyticsPartitionWork,type AnalyticsWorkRequest,type AnalyticsWorkLane} from '../src/storage-analytics-partition-work';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-capacity-reserve',hash='f'.repeat(64);
const request=(partitionKey:string,lane:AnalyticsWorkLane):AnalyticsWorkRequest=>({sourceId,ownerDigest:null,
 partitionKey,headKey:hash,inputRevision:hash,policyRevision:hash,stage:'cleanup',lane,
 day:null,stream:null,selectionMethod:null,residentBytes:1,admissionQueries:1});
async function setup(count:number){
 await reset();await initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,target,b,sourceId);
 const now=Date.now();
 await target.prepare(`WITH RECURSIVE seq(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<?)
 INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,
 stage,lane,day,stream,selection_method,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
 SELECT printf('%064x',n),printf('%064x',n),?,NULL,'capacity/'||n,?,?,'cleanup','history',NULL,NULL,NULL,1,1,?,?,? FROM seq`)
 .bind(count-1,sourceId,hash,hash,now,now,now).run();return now;
}
const pending=()=>target.prepare("SELECT sum(jobs) n FROM analytics_partition_work_counts WHERE state IN('ready','leased')")
 .first<number>('n');
it('protects fresh and withdrawal capacity while preserving duplicates and atomic dependent admission',async()=>{
 const now=await setup(65279);
 await admitAnalyticsPartitionWork(target,[request('background-last','history')],now);
 await admitAnalyticsPartitionWork(target,[request('background-last','history')],now);
 expect(await pending()).toBe(65280);
 for(const lane of ['history','recovery'] as const)
 await expect(admitAnalyticsPartitionWork(target,[request('blocked/'+lane,lane)],now)).rejects.toThrow('analytics_work_capacity');
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:now});expect(lease).toBeDefined();
 await expect(completeAnalyticsPartitionWork(target,lease!,[request('background-child','history')],now))
 .rejects.toThrow('analytics_work_capacity');
 expect(await readAnalyticsPartitionWork(target,lease!,now)).not.toBeNull();
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_work_links').first<number>('n')).toBe(0);
 expect(await completeAnalyticsPartitionWork(target,lease!,[request('fresh-child','new')],now)).toBe(true);
 expect(await pending()).toBe(65280);
 for(let offset=0;offset<192;offset+=32)await admitAnalyticsPartitionWork(target,
 Array.from({length:32},(_,n)=>request('fresh/'+(offset+n),'new')),now);
 expect(await pending()).toBe(65472);
 await expect(admitAnalyticsPartitionWork(target,[request('fresh-overflow','new')],now)).rejects.toThrow('analytics_work_capacity');
 for(let offset=0;offset<64;offset+=32)await admitAnalyticsPartitionWork(target,
 Array.from({length:32},(_,n)=>request('withdraw/'+(offset+n),'withdrawal')),now);
 expect(await pending()).toBe(65536);
 await admitAnalyticsPartitionWork(target,[request('withdraw/63','withdrawal')],now);
 await expect(admitAnalyticsPartitionWork(target,[request('withdraw-overflow','withdrawal')],now))
 .rejects.toThrow('analytics_work_capacity');
 expect(await pending()).toBe(65536);
},120000);
it('applies the same reserve to durable reopen transitions without changing refused state or counters',async()=>{
 const now=await setup(65280);
 for(const lane of ['history','new','withdrawal'] as const){
 const [key]=await admitAnalyticsPartitionWork(target,[request('reopen/'+lane,lane)],now).catch(error=>{
 if(lane!=='history')throw error;return [] as string[];});
 // A completed row can be restored or retained while the active queue is full.
 if(!key)await target.prepare(`INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,partition_key,
 input_revision,policy_revision,stage,lane,day,stream,selection_method,state,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
 VALUES(?,?,?,NULL,?,?,?,'cleanup',?,NULL,NULL,NULL,'complete',1,1,?,?,?)`)
 .bind('e'.repeat(64),hash,sourceId,'reopen/history',hash,hash,lane,now,now,now).run();
 else await target.prepare("UPDATE analytics_partition_work SET state='complete',revision=revision+1 WHERE work_key=?").bind(key).run();
 }
 const reopen=(lane:AnalyticsWorkLane)=>target.prepare(`UPDATE analytics_partition_work SET state='ready',revision=revision+1
 WHERE partition_key=? RETURNING work_key`).bind('reopen/'+lane).run();
 await expect(reopen('history')).rejects.toThrow('analytics_work_capacity');
 expect(await target.prepare("SELECT state,revision FROM analytics_partition_work WHERE partition_key='reopen/history'").first())
 .toEqual({state:'complete',revision:0});
 expect((await reopen('new')).results).toHaveLength(1);
 expect((await reopen('withdrawal')).results).toHaveLength(1);
 expect(await pending()).toBe(65282);
 expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120000);
