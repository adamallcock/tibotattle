import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {readAnalyticsWorkClosureFence,readAnalyticsWorkTargetSettled} from '../src/storage-analytics-closure-fence';
import {admitAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-publication-admission',day=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
const scope=()=>({target:target(),sourceId,sourceNamespace:sourceId});
const hash=(character:string)=>character.repeat(64);
const request=(stage:'features'|'activity'|'publication',character:string):AnalyticsWorkRequest=>({
 sourceId,ownerDigest:null,stage,lane:stage==='activity'?'history':'new',
 partitionKey:stage==='publication'?'activity/'+day:stage+'-synthetic/'+day,
 headKey:hash(character),inputRevision:hash(character),policyRevision:hash('e'),day,stream:'usage',
 selectionMethod:'effective-union-v1',residentBytes:1024,admissionQueries:160,
});
async function settled():Promise<void>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 for(let attempt=0;attempt<16;attempt++){
  const invocation=createD1InvocationBudget(950);
  await runCanonicalAnalyticsWorkPass({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
   invocation,now:Date.now,deadlineMs:Date.now()+55_000,stages:['canonical','features'],maxWaves:1});
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
  if(await readAnalyticsWorkClosureFence({source:source(),...scope()}))return;
 }
 throw new Error('SYNTHETIC_PUBLICATION_ADMISSION_SETUP_INCOMPLETE');
}

it('reads every target pending bit afresh and never treats a wrong namespace or absent scope as settled',async()=>{
 await settled();expect(await readAnalyticsWorkTargetSettled(scope())).toBe(true);
 const db=target(),owner=hash('a');
 expect(await readAnalyticsWorkTargetSettled({...scope(),sourceNamespace:'wrong-namespace'})).toBe(false);
 expect(await readAnalyticsWorkTargetSettled({...scope(),sourceId:'absent-source'})).toBe(false);
 await db.prepare('INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,?)')
  .bind(sourceId,owner,'active').run();
 const toggles:[string,string][]=[
  [`INSERT INTO analytics_partition_ranges(effect_key,source_id,owner_digest,from_day,through_day,next_day,stream,
    selection_method,source_stamp,lane,updated_ms) VALUES('${hash('1')}','${sourceId}','${owner}','${day}','${day}',
    '${day}','usage','effective-union-v1',0,'new',0)`,`DELETE FROM analytics_partition_ranges WHERE effect_key='${hash('1')}'`],
  [`INSERT INTO analytics_partition_global_changes(source_id,source_stamp,updated_ms) VALUES('${sourceId}',1,0)`,
   `DELETE FROM analytics_partition_global_changes WHERE source_id='${sourceId}'`],
  [`UPDATE analytics_partition_reconciliation SET complete=0 WHERE source_id='${sourceId}'`,
   `UPDATE analytics_partition_reconciliation SET complete=1 WHERE source_id='${sourceId}'`],
  [`INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation) VALUES('${sourceId}','pending',1)`,
   `DELETE FROM analytics_partition_dirty_work WHERE source_id='${sourceId}' AND partition_key='pending'`],
 ];
 for(const [add,remove] of toggles){
  await db.prepare(add).run();expect(await readAnalyticsWorkTargetSettled(scope())).toBe(false);
  await db.prepare(remove).run();expect(await readAnalyticsWorkTargetSettled(scope())).toBe(true);
 }
 await admitAnalyticsPartitionWork(db,[request('features','b')]);
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(false);
 await db.prepare("DELETE FROM analytics_partition_work WHERE stage='features'").run();
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(true);
 await db.prepare(`INSERT INTO analytics_canonical_pages(change_key,source_id,owner_digest,owner_revision,authority_epoch,
  source_revision,effect_count,state) VALUES(?,?,?,?,?,?,1,'writing')`).bind(hash('2'),sourceId,owner,1,1,hash('3')).run();
 await db.prepare(`INSERT INTO analytics_canonical_effects(effect_key,change_key,occurrence_key,selection_method,stream,
  erasure_key,authority_revision,kind) VALUES(?,?,?,'effective-union-v1','usage',?,1,'noop')`)
  .bind(hash('4'),hash('2'),'synthetic-occurrence',hash('5')).run();
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(false);
 await db.prepare('DELETE FROM analytics_canonical_pages WHERE change_key=?').bind(hash('2')).run();
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(true);
 const metered=createD1InvocationBudget(2);
 expect(await readAnalyticsWorkTargetSettled({...scope(),target:metered.wrap(db)})).toBe(true);
 expect(metered.queriesUsed).toBe(2);
 await expect(readAnalyticsWorkTargetSettled({...scope(),target:metered.wrap(db)}))
  .rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 await db.prepare('DROP TABLE analytics_partition_reconciliation').run();
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(false);
});

it('leaves publication leases untouched while producer work is pending, claims activity, then retries publication after settlement',async()=>{
 await settled();const db=target();
 await admitAnalyticsPartitionWork(db,[request('publication','c'),request('activity','d'),request('features','f')]);
 const before=await db.prepare("SELECT work_key,revision,attempts,state FROM analytics_partition_work WHERE stage='publication'")
  .first<{work_key:string;revision:number;attempts:number;state:string}>();
 const publicationOnly=createD1InvocationBudget(950);
 expect(await runCanonicalAnalyticsWorkPass({source:source(),target:db,sourceId,sourceNamespace:sourceId,
  invocation:publicationOnly,now:Date.now,deadlineMs:Date.now()+55_000,bridge:false,stages:['publication'],maxWaves:1}))
  .toMatchObject({state:'deferred',reason:'source_prefix_pending',claimed:0,deferred:0});
 expect(publicationOnly.queriesUsed).toBeLessThanOrEqual(950);
 const invocation=createD1InvocationBudget(950);
 const guarded=await runCanonicalAnalyticsWorkPass({source:source(),target:db,sourceId,sourceNamespace:sourceId,
  invocation,now:Date.now,deadlineMs:Date.now()+55_000,bridge:false,stages:['activity','publication'],maxWaves:1});
 expect(guarded.claimed).toBe(1);expect(guarded.state).toBe('deferred');
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 expect(await db.prepare('SELECT revision,attempts,state FROM analytics_partition_work WHERE work_key=?').bind(before!.work_key)
  .first()).toEqual({revision:before!.revision,attempts:before!.attempts,state:before!.state});
 expect(await db.prepare("SELECT attempts FROM analytics_partition_work WHERE stage='activity'").first<number>('attempts')).toBe(1);
 await db.prepare("DELETE FROM analytics_partition_work WHERE stage IN('activity','features')").run();
 expect(await readAnalyticsWorkTargetSettled(scope())).toBe(true);
 const next=createD1InvocationBudget(950);
 const resumed=await runCanonicalAnalyticsWorkPass({source:source(),target:db,sourceId,sourceNamespace:sourceId,
  invocation:next,now:Date.now,deadlineMs:Date.now()+55_000,bridge:false,stages:['publication'],maxWaves:1});
 expect(resumed.claimed).toBe(1);expect(next.queriesUsed).toBeLessThanOrEqual(950);
 expect(await db.prepare('SELECT attempts FROM analytics_partition_work WHERE work_key=?').bind(before!.work_key)
  .first<number>('attempts')).toBe(1);
});
