import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {admitMaintainedGraphPublications,admitMaintainedAnalyticsPolicyWork,maintainedAnalyticsPolicyRevision,retireMaintainedGraphWork} from '../src/storage-analytics-maintained-work';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,completeAnalyticsPartitionWork,readAnalyticsPartitionWork,
 releaseAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-maintained-output';
async function setup(){await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 return seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});}
it('retains every adopted graph date and repairs lost queue notification without duplicate admission',async()=>{
 const corpus=await setup(),days=corpus.graphDates,policyRevision=await maintainedAnalyticsPolicyRevision();
 // Synthetic native result rows test the transactional notification contract;
 // payload validity and actual output adoption are covered by native P7 tests.
 for(const day of days)await target.prepare(`INSERT INTO analytics_community_graph_results(source_id,owner_digest,metric,day,method,
 dependency_digest,input_revision,payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind)
 VALUES(?,?,'model',?,'synthetic',?,0,?,'{}',?,'{}',0,'effective')`)
 .bind(sourceId,corpus.owner.ownerDigest,day,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64)).run();
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_graph_dirty').first<number>('n')).toBe(days.length);
 expect(await admitMaintainedGraphPublications({target,sourceId,policyRevision,nowMs:Date.now()})).toBe(days.length);
 const count=await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication'").first<number>('n');
 expect(await admitMaintainedGraphPublications({target,sourceId,policyRevision,nowMs:Date.now()})).toBe(0);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication'").first<number>('n')).toBe(count);
 await target.prepare(`UPDATE analytics_community_graph_results SET payload_sha256=? WHERE day=?`).bind('d'.repeat(64),days[0]).run();
 expect(await admitMaintainedGraphPublications({target,sourceId,policyRevision,nowMs:Date.now()})).toBe(1);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication'").first<number>('n')).toBe(count!+1);
});
it('pages code-policy changes over maintained roots without rewriting quantities or re-admitting unchanged policy',async()=>{
 await setup();const hash='e'.repeat(64);
 for(let n=0;n<6;n++){const key='effective-union-v1/usage/2026-09-01/'+n.toString(16).padStart(2,'0');
 await target.prepare('INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation,admitted_generation) VALUES(?,?,1,1)')
 .bind(sourceId,key).run();}
 expect(await admitMaintainedAnalyticsPolicyWork({target,sourceId,policyRevision:hash,nowMs:Date.now()})).toBe(4);
 expect(await admitMaintainedAnalyticsPolicyWork({target,sourceId,policyRevision:hash,nowMs:Date.now()})).toBe(2);
 expect(await admitMaintainedAnalyticsPolicyWork({target,sourceId,policyRevision:hash,nowMs:Date.now()})).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_feature_quantities').first<number>('n')).toBe(0);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features'").first<number>('n')).toBe(6);
 expect(await admitMaintainedAnalyticsPolicyWork({target,sourceId,policyRevision:'f'.repeat(64),nowMs:Date.now()})).toBe(4);
});
it('enforces the actual65536 pending cap atomically and preserves a live parent on refused downstream admission',async()=>{
 await setup();const now=Date.now(),hash='f'.repeat(64);
 await target.prepare(`WITH RECURSIVE seq(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<65534)
 INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,
 stage,lane,day,stream,selection_method,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
 SELECT printf('%064x',n),printf('%064x',n),?,NULL,'capacity/'||n,?,?,'cleanup','withdrawal',NULL,NULL,NULL,1,1,?,?,? FROM seq`)
 .bind(sourceId,hash,hash,now,now,now).run();
 const request=(partitionKey:string):AnalyticsWorkRequest=>({sourceId,ownerDigest:null,partitionKey,headKey:hash,inputRevision:hash,
 policyRevision:hash,stage:'cleanup',lane:'withdrawal',day:null,stream:null,selectionMethod:null,residentBytes:1,admissionQueries:1});
 await admitAnalyticsPartitionWork(target,[request('last')],now);
 await admitAnalyticsPartitionWork(target,[request('last')],now);
 expect(await target.prepare("SELECT sum(jobs) n FROM analytics_partition_work_counts WHERE state IN('ready','leased')").first<number>('n')).toBe(65536);
 await expect(admitAnalyticsPartitionWork(target,[request('overflow')],now)).rejects.toThrow('analytics_work_capacity');
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:now});expect(lease).toBeDefined();
 await expect(completeAnalyticsPartitionWork(target,lease!,[request('child-a'),request('child-b')],now)).rejects.toThrow('analytics_work_capacity');
 expect(await readAnalyticsPartitionWork(target,lease!,now)).not.toBeNull();
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_work_links').first<number>('n')).toBe(0);
 await releaseAnalyticsPartitionWork(target,lease!,'complete',now);
 await admitAnalyticsPartitionWork(target,[request('overflow')],now);
 expect(await target.prepare("SELECT sum(jobs) n FROM analytics_partition_work_counts WHERE state IN('ready','leased')").first<number>('n')).toBe(65536);
},120_000);

// These synthetic sealed rows exercise the durable notification contract. The
// canonical-work test above acquires and closes the same contract through P1.
import {admitMaintainedGraphComputations,maintainedGraphAffectedDates,maintainedGraphWorkIsCurrent,
 closeObsoleteAnalyticsManifestWork} from '../src/storage-analytics-maintained-work';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {sha256Hex} from '../src/crypto';
import {canonicalJson} from '../src/canonical-json';
import {materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
const iso=(offset=0)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
async function sealed(owner:string,day:string,scopeKey:string,selection='effective-union-v1',stamp='a'.repeat(64)) {
 await target.prepare(`INSERT INTO analytics_canonical_input_work
 (scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,owner_revision,authority_epoch,state)
 SELECT ?,source_id,owner_digest,?,'usage',?,?,revision,authority_epoch,'sealed' FROM analytics_owner_state
 WHERE source_id=? AND owner_digest=?`).bind(scopeKey,selection,day,stamp,sourceId,owner).run();
}
async function demandRows() {return (await target.prepare(`SELECT metric,day,input_revision,generation,admitted_generation
 FROM analytics_partition_graph_demands ORDER BY metric,day`).all<{metric:string;day:string;input_revision:string;generation:number;admitted_generation:number}>()).results;}
it('uses the native inclusive 100-day dependency and 70-day output retention, including future legacy current fits',()=>{
 const today='2026-10-01';
 expect(maintainedGraphAffectedDates({day:'2026-04-15',today,selectionMethod:'effective-union-v1'}).model).toEqual(['2026-07-24']);
 expect(maintainedGraphAffectedDates({day:'2026-04-14',today,selectionMethod:'effective-union-v1'}).model).toEqual([]);
 expect(maintainedGraphAffectedDates({day:'2026-06-23',today,selectionMethod:'effective-union-v1'}).fits).toBe(true);
 expect(maintainedGraphAffectedDates({day:'2026-06-22',today,selectionMethod:'effective-union-v1'}).fits).toBe(false);
 expect(maintainedGraphAffectedDates({day:'2026-10-02',today,selectionMethod:'effective-union-v1'})).toEqual({model:[],fits:false});
 expect(maintainedGraphAffectedDates({day:'2026-10-02',today,selectionMethod:'legacy-selected-v1'})).toEqual({model:[],fits:true});
});
it('coalesces sealed replay, changes only exact affected dates and fairly admits current, recent and history jobs',async()=>{
 const corpus=await setup(),owner=corpus.owner.ownerDigest,scope='1'.repeat(64),policyRevision=await maintainedAnalyticsPolicyRevision(),nowMs=Date.now();
 await sealed(owner,iso(-1),scope);
 const args={target,sourceId,policyRevision,nowMs};
 expect(await admitMaintainedGraphComputations(args)).toBe(4);
 const first=await demandRows();expect(first).toHaveLength(71);
 const jobs=(await target.prepare("SELECT partition_key,day FROM analytics_partition_work WHERE stage='fits' ORDER BY created_ms,work_key").all<{partition_key:string;day:string}>()).results;
 expect(jobs.some(r=>r.partition_key.startsWith('graph/fits/'))).toBe(true);
 expect(jobs.some(r=>r.partition_key.startsWith('graph/model/')&&r.day>=iso(-6))).toBe(true);
 expect(jobs.some(r=>r.partition_key.startsWith('graph/model/')&&r.day<iso(-6))).toBe(true);
 // Repeating the native seal from draining with identical stamp is idempotent.
 await target.prepare("UPDATE analytics_canonical_input_work SET state='draining' WHERE scope_key=?").bind(scope).run();
 await target.prepare("UPDATE analytics_canonical_input_work SET state='sealed' WHERE scope_key=?").bind(scope).run();
 await admitMaintainedGraphComputations(args);
 expect((await demandRows()).map(({admitted_generation:_,...r})=>r)).toEqual(first.map(({admitted_generation:_,...r})=>r));
 await target.prepare("UPDATE analytics_canonical_input_work SET state='draining',source_stamp=? WHERE scope_key=?").bind('b'.repeat(64),scope).run();
 await target.prepare("UPDATE analytics_canonical_input_work SET state='sealed' WHERE scope_key=?").bind(scope).run();
 await admitMaintainedGraphComputations(args);
 const changed=await demandRows();
 expect(changed.filter(r=>r.input_revision!==first.find(p=>p.metric===r.metric&&p.day===r.day)!.input_revision).map(r=>r.metric+'/'+r.day))
 .toEqual(['fits/'+iso(),'model/'+iso(-1),'model/'+iso()]);
 for(let n=0;n<20;n++)await admitMaintainedGraphComputations(args);
 const meter=createD1InvocationBudget(100);expect(await admitMaintainedGraphComputations({...args,target:meter.wrap(target)})).toBe(0);
 expect(meter.queriesUsed).toBeLessThan(12);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_feature_quantities').first<number>('n')).toBe(0);
});
it('blocks relevant incomplete input, immediately invalidates old demands, and readmits policy and UTC outputs without source arithmetic',async()=>{
 const corpus=await setup(),owner=corpus.owner.ownerDigest,scope='2'.repeat(64),nowMs=Date.now(),policyRevision=await maintainedAnalyticsPolicyRevision();
 await sealed(owner,iso(),scope);
 const args={target,sourceId,policyRevision,nowMs};await admitMaintainedGraphComputations(args);
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs,stages:['fits']});expect(lease).toBeDefined();
 const work=(await readAnalyticsPartitionWork(target,lease!,nowMs))!;expect(await maintainedGraphWorkIsCurrent(target,work,nowMs)).toBe(true);
 // A provisional direct B02/rolling acquisition has no queue/ref row yet.
 await target.prepare(`INSERT INTO analytics_canonical_input_work
 (scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,owner_revision,authority_epoch,state)
 SELECT ?,source_id,owner_digest,'effective-union-v1','usage',?,?,revision,authority_epoch,'reading'
 FROM analytics_owner_state WHERE source_id=? AND owner_digest=?`)
 .bind('7'.repeat(64),work.day,'a'.repeat(64),sourceId,owner).run();
 expect(await maintainedGraphWorkIsCurrent(target,work,nowMs)).toBe(false);
 await target.prepare('DELETE FROM analytics_canonical_input_work WHERE scope_key=?').bind('7'.repeat(64)).run();
 expect(await maintainedGraphWorkIsCurrent(target,work,nowMs)).toBe(true);
 // An exact pending source scope invalidates a relevant admitted request before
 // the bounded demand dispatcher has consumed its outbox row.
 const day=work.day!;await sealed(owner,day,'3'.repeat(64));
 expect(await maintainedGraphWorkIsCurrent(target,work,nowMs)).toBe(false);
 let closed=false;for(let n=0;n<20&&!closed;n++){await admitMaintainedGraphComputations(args);closed=await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs);}
 expect(closed).toBe(true);
 expect(await target.prepare('SELECT state,reason_code FROM analytics_partition_work WHERE work_key=?').bind(lease!.workKey).first())
 .toEqual({state:'refused',reason_code:'obsolete_input'});
 const before=await demandRows();
 await admitMaintainedGraphComputations({...args,policyRevision:'f'.repeat(64)});
 expect((await demandRows()).every(r=>r.input_revision!==before.find(p=>p.metric===r.metric&&p.day===r.day)!.input_revision)).toBe(true);
 await admitMaintainedGraphComputations({...args,policyRevision:'f'.repeat(64),nowMs:nowMs+86400000});
 expect((await demandRows()).filter(r=>r.metric==='fits').map(r=>r.day)).toEqual([iso(1)]);
 expect((await demandRows()).some(r=>r.metric==='model'&&r.day===iso(1))).toBe(true);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_facts').first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_cache_pairs').first<number>('n')).toBe(0);
});
it('physically removes graph subjects and nulls private cursors on terminal owner changes',async()=>{
 const corpus=await setup(),owner=corpus.owner.ownerDigest;await sealed(owner,iso(),'4'.repeat(64));
 await admitMaintainedGraphComputations({target,sourceId,policyRevision:'a'.repeat(64),nowMs:Date.now()});
 expect(await target.prepare('SELECT after_input_key FROM analytics_partition_graph_control').first<string>('after_input_key')).not.toBeNull();
 await target.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?").bind(sourceId,owner).run();
 for(const table of ['subjects','input_refs','demands'])expect(await target.prepare('SELECT count(*) n FROM analytics_partition_graph_'+table).first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT after_subject_key,after_input_key FROM analytics_partition_graph_control').first()).toEqual({after_subject_key:null,after_input_key:null});
});
it('keeps missing-manifest work live and closes it only after exact newer dirty generation admission',async()=>{
 await setup();const nowMs=Date.now(),key='effective-union-v1/usage/'+iso()+'/aa',hash='e'.repeat(64);
 await target.prepare('INSERT INTO analytics_canonical_dirty_partitions VALUES(?,1)').bind(key).run();
 const old=await materializeCanonicalPartition(target,key);expect(old.state).toBe('complete');if(old.state!=='complete')throw Error('manifest');
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'cache',lane:'new',partitionKey:key,
 headKey:hash,inputRevision:old.manifest.contentRevision,policyRevision:hash,day:iso(),stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target,[request],nowMs);
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs,stages:['cache']});expect(lease).toBeDefined();
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(false);
 await target.prepare('UPDATE analytics_canonical_dirty_partitions SET generation=2 WHERE partition_key=?').bind(key).run();
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(false);
 const revision=await sha256Hex(canonicalJson([key,2]));
 await admitAnalyticsPartitionWork(target,[{...request,stage:'features',headKey:'f'.repeat(64),inputRevision:revision}],nowMs);
 await target.prepare('INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation,admitted_generation) VALUES(?,?,2,2)').bind(sourceId,key).run();
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(true);
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(false);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(1);
});
it('coalesces a bounded sealed-input page before admitting any dependent current fit',async()=>{
 const corpus=await setup(),owner=corpus.owner.ownerDigest,policyRevision=await maintainedAnalyticsPolicyRevision(),nowMs=Date.now();
 for(let n=0;n<7;n++)await sealed(owner,iso(-n),(n+10).toString(16).padStart(64,'0'));
 const args={target,sourceId,policyRevision,nowMs};await admitMaintainedGraphComputations(args);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE partition_key LIKE 'graph/fits/%'").first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_partition_graph_input_refs WHERE generation>applied_generation').first<number>('n')).toBe(3);
 await admitMaintainedGraphComputations(args);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE partition_key LIKE 'graph/fits/%'").first<number>('n')).toBe(1);
 for(let n=0;n<20;n++)await admitMaintainedGraphComputations(args);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE partition_key LIKE 'graph/fits/%'").first<number>('n')).toBe(1);
});
it('requires all16 replacement split leaves before retiring an obsolete unsplit consumer',async()=>{
 await setup();const nowMs=Date.now(),key='effective-union-v1/usage/'+iso()+'/ab',hash='a'.repeat(64);
 await target.prepare('INSERT INTO analytics_canonical_dirty_partitions VALUES(?,1)').bind(key).run();
 const old=await materializeCanonicalPartition(target,key);if(old.state!=='complete')throw Error('manifest');
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'activity',lane:'new',partitionKey:key,
 headKey:hash,inputRevision:old.manifest.contentRevision,policyRevision:hash,day:iso(),stream:'usage',selectionMethod:'effective-union-v1',residentBytes:1024,admissionQueries:160};
 await admitAnalyticsPartitionWork(target,[request],nowMs);
 const [lease]=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs,stages:['activity']});expect(lease).toBeDefined();
 await target.prepare('UPDATE analytics_canonical_dirty_partitions SET generation=2 WHERE partition_key=?').bind(key).run();
 await target.prepare('INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation,admitted_generation) VALUES(?,?,2,2)').bind(sourceId,key).run();
 const inputRevision=await sha256Hex(canonicalJson([key,2]));
 for(const suffix of '0123456789abcde')await admitAnalyticsPartitionWork(target,[{...request,stage:'features',partitionKey:key+suffix,
 headKey:await sha256Hex(key+suffix),inputRevision}],nowMs);
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(false);
 await admitAnalyticsPartitionWork(target,[{...request,stage:'features',partitionKey:key+'f',headKey:await sha256Hex(key+'f'),inputRevision}],nowMs);
 expect(await closeObsoleteAnalyticsManifestWork(target,lease!,nowMs)).toBe(true);
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(16);
});
it('replays a retained identical terminal fence over restored graph metadata and private cursor links',async()=>{
 const corpus=await setup(),owner=corpus.owner.ownerDigest;await sealed(owner,iso(),'5'.repeat(64));
 await admitMaintainedGraphComputations({target,sourceId,policyRevision:'a'.repeat(64),nowMs:Date.now()});
 const names=['analytics_canonical_input_work','analytics_partition_graph_subjects','analytics_partition_graph_input_refs','analytics_partition_graph_demands'];
 const saved=await Promise.all(names.map(async name=>({name,rows:(await target.prepare('SELECT * FROM '+name).all<Record<string,unknown>>()).results})));
 await target.prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,1,1,1,1)').bind(sourceId,owner,'f'.repeat(64)).run();
 for(const name of names)expect(await target.prepare('SELECT count(*) n FROM '+name).first<number>('n')).toBe(0);
 // A restore can put historical payloads behind an existing irreversible fence.
 // Remove only insertion guards while reconstructing that synthetic condition.
 const guards=['analytics_canonical_input_admit','analytics_partition_graph_subject_admit','analytics_partition_graph_ref_admit',
 'analytics_partition_graph_demand_admit','analytics_partition_graph_input_insert'];
 const definitions=await Promise.all(guards.map(async name=>({name,sql:(await target.prepare('SELECT sql FROM sqlite_schema WHERE name=?').bind(name).first<string>('sql'))!})));
 for(const guard of definitions)await target.prepare('DROP TRIGGER '+guard.name).run();
 for(const table of saved)for(const row of table.rows){const columns=Object.keys(row);
 await target.prepare('INSERT INTO '+table.name+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...columns.map(c=>row[c])).run();}
 for(const guard of definitions)await target.prepare(guard.sql).run();
 await target.prepare('UPDATE analytics_partition_graph_control SET after_subject_key=(SELECT subject_key FROM analytics_partition_graph_subjects LIMIT 1),after_input_key=?').bind('5'.repeat(64)).run();
 await target.prepare('UPDATE analytics_storage_erasure_fences SET terminal_sequence=terminal_sequence WHERE source_id=? AND owner_digest=?').bind(sourceId,owner).run();
 for(const name of names)expect(await target.prepare('SELECT count(*) n FROM '+name).first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT after_subject_key,after_input_key FROM analytics_partition_graph_control').first()).toEqual({after_subject_key:null,after_input_key:null});
 await expect(sealed(owner,iso(),'6'.repeat(64))).rejects.toThrow('canonical_input_authority');
});


it('retires only old unclaimed graph notifications in bounded pages',async()=>{
 await setup();const nowMs=Date.now(),today=new Date(nowMs).toISOString().slice(0,10);
 const oldest=new Date(Date.parse(today)-69*86400000).toISOString().slice(0,10);
 for(let n=0;n<20;n++)await target.prepare("INSERT INTO analytics_partition_graph_dirty VALUES(?,'model',?,1,0)")
  .bind(sourceId,new Date(Date.parse(oldest)-(n+1)*86400000).toISOString().slice(0,10)).run();
 for(const [metric,date]of [['model',oldest],['fits',today],['fits','2099-01-01'],['fits',new Date(Date.parse(today)-86400000).toISOString().slice(0,10)]])
  await target.prepare('INSERT INTO analytics_partition_graph_dirty VALUES(?,?,?,1,0)').bind(sourceId,metric,date).run();
 const heldDay=new Date(Date.parse(oldest)-86400000).toISOString().slice(0,10);
 await admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'publication',lane:'history',partitionKey:'model/'+heldDay,
  headKey:'1'.repeat(64),inputRevision:'2'.repeat(64),policyRevision:'3'.repeat(64),day:heldDay,stream:null,selectionMethod:null,
  residentBytes:1,admissionQueries:1}],nowMs);
 expect(await retireMaintainedGraphWork(target,{sourceId,nowMs,limit:16})).toBe(16);
 expect(await target.prepare('SELECT 1 ready FROM analytics_partition_graph_dirty WHERE day=?').bind(heldDay).first()).not.toBeNull();
 expect(await retireMaintainedGraphWork(target,{sourceId,nowMs,limit:16})).toBe(4);
 const rows=(await target.prepare('SELECT metric,day FROM analytics_partition_graph_dirty ORDER BY metric,day').all()).results;
 expect(rows).toEqual([{metric:'fits',day:today},{metric:'fits',day:'2099-01-01'},{metric:'model',day:heldDay},{metric:'model',day:oldest}]);
});
