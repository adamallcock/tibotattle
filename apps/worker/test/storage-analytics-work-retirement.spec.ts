import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {advanceAnalyticsWorkRetirement,ANALYTICS_WORK_CLEANUP_INTERVAL_MS} from '../src/storage-analytics-work-retirement';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-retirement-cadence';
async function setup(){await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);}
function observe(database:D1Database){const deletes:string[]=[];return {deletes,database:new Proxy(database,{get(value,key){
 if(key==='prepare')return(sql:string)=>{if(/DELETE FROM/iu.test(sql))deletes.push(sql);return value.prepare(sql);};
 const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
}})};}
async function run(database:D1Database,nowMs:number){const meter=createD1InvocationBudget(950);
 const result=await advanceAnalyticsWorkRetirement({target:database,sourceId,meter,now:()=>nowMs,
 deadlineMs:nowMs+60_000,completedBeforeMs:1});expect(meter.queriesUsed).toBeLessThanOrEqual(950);return result;}
it('serializes due lifecycle sweeps and avoids recurring empty scans until the durable retry time',async()=>{
 await setup();const nowMs=Date.now(),observed=observe(target);
 const attempts=await Promise.all([run(observed.database,nowMs),run(observed.database,nowMs)]);
 expect(attempts.every(value=>value.state==='idle')).toBe(true);
 const scans=observed.deletes.length;expect(scans).toBeGreaterThan(0);
 const skipped=await run(observed.database,nowMs+1);
 expect(skipped.statements).toBeLessThanOrEqual(4);expect(observed.deletes.length).toBe(scans);
 await run(observed.database,nowMs+ANALYTICS_WORK_CLEANUP_INTERVAL_MS);
 expect(observed.deletes.length).toBeGreaterThan(scans);
});
it('keeps productive bounded pages immediately due until old completed jobs are drained',async()=>{
 await setup();const nowMs=Date.now(),hash='a'.repeat(64);
 for(let n=0;n<32;n++)await target.prepare(`INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,
 partition_key,input_revision,policy_revision,stage,lane,day,stream,selection_method,resident_bytes,admission_queries,
 ready_ms,created_ms,updated_ms,state) VALUES(?,?,?,NULL,?,?,?,'cleanup','history',NULL,NULL,NULL,1,1,0,0,0,'complete')`)
 .bind(n.toString(16).padStart(64,'0'),n.toString(16).padStart(64,'0'),sourceId,'old/'+n,hash,hash).run();
 const first=await run(target,nowMs);expect(first).toMatchObject({state:'progress',workRetired:16});
 const second=await run(target,nowMs);expect(second).toMatchObject({state:'progress',workRetired:16});
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_work').first<number>('n')).toBe(0);
 const settled=await run(target,nowMs);expect(settled.state).toBe('idle');
 const skipped=await run(target,nowMs+1);expect(skipped.statements).toBeLessThanOrEqual(4);
});

it('keeps productive shared feature cleanup immediately due across bounded head pages',async()=>{
 await setup();const nowMs=Date.now(),owner='b'.repeat(64),method='c'.repeat(64),dependency='d'.repeat(64);
 await target.prepare('INSERT INTO analytics_owner_state VALUES(?,?,1,1,\'active\')').bind(sourceId,owner).run();
 for(let n=0;n<6;n++)await target.prepare(`INSERT INTO analytics_shared_feature_days
  (job_key,source_id,source_namespace,owner_digest,day,method_digest,dependency_digest,
   owner_revision,authority_epoch,input_revision,updated_ms) VALUES(?,?,?,?,?,?,?,1,1,0,0)`)
  .bind(n.toString(16).padStart(64,'0'),sourceId,sourceId,owner,'2026-09-'+String(10+n),method,dependency).run();
 expect((await run(target,nowMs)).state).toBe('progress');
 expect(await target.prepare('SELECT count(*) n FROM analytics_shared_feature_days').first<number>('n')).toBe(2);
 expect((await run(target,nowMs)).state).toBe('progress');
 expect(await target.prepare('SELECT count(*) n FROM analytics_shared_feature_days').first<number>('n')).toBe(0);
 expect((await run(target,nowMs)).state).toBe('idle');
 expect((await run(target,nowMs+1)).statements).toBeLessThanOrEqual(4);
});
