import {env,reset} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {dispatchAnalyticsActivityGroup,dispatchAnalyticsWork} from '../src/analytics-partition-work';
import {advanceAnalyticsActivityGroup,type AnalyticsActivityGroupInput,type AnalyticsActivityGroupResult} from '../src/storage-analytics-activity-group';
import {advanceAnalyticsCanonicalWork} from '../src/storage-analytics-canonical-work';
import {advanceAnalyticsPublicationWork} from '../src/storage-analytics-publication-work';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {captureAnalyticsManifestGroupProof} from '../src/storage-analytics-work-proof';
import {claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,readAnalyticsPartitionWork,previewAnalyticsActivityGroup,
 analyticsPartitionWorkAvailable} from '../src/storage-analytics-partition-work';
import {readCanonicalPartitionManifests,readCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {advanceCanonicalInputWork} from '../src/storage-canonical-analytics-input';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-activity-group',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
let snapshot:{source:AcceptedSourceTransfer;target:AcceptedSourceTransfer},readyJobs=0,ownerDigest:string,laboratoryReceipt:unknown;
let mixedSnapshot:{snapshot:typeof snapshot;readyJobs:number;ownerDigest:string;laboratoryReceipt:unknown}|undefined;
async function fixture(common=true,minimumLeaves=common?8:2){
 await reset();const started=performance.now();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const initializationMs=performance.now()-started,profile=createAnalyticsProfile();
 const ingestion=profileAnalyticsDatabase(source(),'source',profile,()=> 'laboratory'),database=profileAnalyticsDatabase(target(),'target',profile,()=> 'laboratory');
 const corpus=await seedSharedAnalyticsCorpus({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  denseUsageRows:common?8:0,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 ownerDigest=corpus.owner.ownerDigest;const day=common?corpus.graphDates[0]!:corpus.equivalentDay;
 const owners=(await readStorageCommunityOwnerPage(ingestion)).filter(owner=>owner.ownerDigest&&(!common||owner.ownerDigest===ownerDigest));
 expect(owners.length).toBe(common?1:2);
 for(const owner of owners){
  await database.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')
   ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  let covered=false;for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(ingestion,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128})).status==='complete'){covered=true;break;}expect(covered).toBe(true);
  let sealed=false;for(let n=0;n<32;n++)if((await advanceCanonicalInputWork(ingestion,database,{sourceId,sourceNamespace:sourceId,
   ownerDigest:owner.ownerDigest!,participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1',
   budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}})).state==='complete'){sealed=true;break;}expect(sealed).toBe(true);
 }
 for(let n=0;n<16;n++){
  await advanceAnalyticsWorkEffects({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,meter:createD1InvocationBudget(950),
   now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')===0)break;
 }
 expect(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')).toBe(0);
 // Actual predecessor feature consumers create the original activity jobs.
 // Retain cache jobs, unrelated source ranges and all lineage/evidence.
 let featuresCompleted=0;for(let n=0;n<128;n++){
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')===0)break;
  const invocation=createD1InvocationBudget(950),db=invocation.wrap(database),src=invocation.wrap(ingestion);
  const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,invocation,now:Date.now,deadlineMs:Date.now()+60_000,
   claim:limit=>claimAnalyticsPartitionWork(db,{sourceId,limit,nowMs:Date.now(),stages:['features']}),
   execute:async(lease,budget)=>(await advanceAnalyticsCanonicalWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,database:src}],lease,budget})).outcome,
   release:async(lease,outcome)=>{await releaseAnalyticsPartitionWork(db,lease,outcome,Date.now());}});
  expect(result.complete).toBe(1);featuresCompleted+=result.complete;expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 }
 readyJobs=await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='ready'").first<number>('n')??0;
 expect(readyJobs).toBe(featuresCompleted);expect(readyJobs).toBeGreaterThanOrEqual(minimumLeaves);expect(readyJobs).toBeLessThanOrEqual(128);
 const left=await captureAcceptedSourceTransfer(source()),right=await captureAcceptedSourceTransfer(target());snapshot={source:left.transfer,target:right.transfer};
 const summary=summarizeAnalyticsProfile(profile);laboratoryReceipt={common,readyJobs,featuresCompleted,elapsedMs:performance.now()-started,
  initializationMs,initializationStatements:null,statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,
  source:left.transfer.proof,target:right.transfer.proof,contract:'Acceptance, coverage, original feature consumers and snapshot copying are laboratory setup.'};
}
beforeAll(()=>fixture(),120_000);
async function restore(){await reset();const started=performance.now(),left=await importAcceptedSourceTransfer(snapshot.source,source()),right=await importAcceptedSourceTransfer(snapshot.target,target());
 expect(left.proof).toEqual(snapshot.source.proof);expect(right.proof).toEqual(snapshot.target.proof);
 return {elapsedMs:performance.now()-started,statements:left.importProfile.statements+left.proofProfile.statements+right.importProfile.statements+right.proofProfile.statements};}
async function mixed<T>(execute:()=>Promise<T>,minimumLeaves=2){const original={snapshot,readyJobs,ownerDigest,laboratoryReceipt};try{
 if(!mixedSnapshot){
  const attempts:unknown[]=[];
  // Native owner/occurrence identities may share the same two-hex root. The
  // two-leaf controls require a declared shape, so bound fresh lab generation
  // to three accepted fixtures; retain every attempt's setup/import proof cost.
  for(let n=0;n<3;n++){
   await fixture(false,1);attempts.push(laboratoryReceipt);
   if(readyJobs>=2){laboratoryReceipt={accepted:laboratoryReceipt,setupAttempts:attempts,setupAttemptCount:attempts.length,
    contract:'Bounded native fixture generation for2real subjects/2distinct original leaves; no source/job/root edits.'};
    mixedSnapshot={snapshot,readyJobs,ownerDigest,laboratoryReceipt};break;}
  }
  if(!mixedSnapshot){console.info('A04_ACTIVITY_MIXED_SETUP_REFUSED '+JSON.stringify({attempts}));throw Error('SYNTHETIC_MIXED_LEAF_COLLISION');}
 }
 ({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=mixedSnapshot);expect(readyJobs).toBeGreaterThanOrEqual(minimumLeaves);
 return await execute();
 }finally{({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=original);}}
const exactQueries={
 facts:'SELECT * FROM analytics_canonical_facts ORDER BY revision',heads:'SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key,selection_method',
 quantities:'SELECT * FROM analytics_canonical_feature_quantities ORDER BY fact_revision',prices:'SELECT * FROM analytics_canonical_feature_prices ORDER BY fact_revision,family,dependency_digest',
 membership:'SELECT * FROM analytics_canonical_feature_membership ORDER BY fact_revision,dependency_revision',activityHeads:'SELECT * FROM analytics_canonical_activity_heads ORDER BY content_revision',
 manifests:'SELECT * FROM analytics_canonical_manifests ORDER BY content_revision',manifestRows:'SELECT * FROM analytics_canonical_manifest_rows ORDER BY content_revision,ordinal',
 parts:'SELECT revision,source_id,day,partition_key,content_revision,payload,payload_digest,fact_count FROM analytics_canonical_publication_parts ORDER BY revision',
 partHeads:'SELECT * FROM analytics_canonical_publication_part_heads ORDER BY source_id,partition_key',partFacts:'SELECT * FROM analytics_canonical_publication_part_facts ORDER BY part_revision,fact_revision',
 partSubjects:'SELECT * FROM analytics_canonical_publication_part_subjects ORDER BY part_revision,source_id,owner_digest',
 replacements:'SELECT replacement_key,source_id,partition_key,old_revision,new_revision FROM analytics_canonical_publication_replacements ORDER BY replacement_key',
 work:'SELECT work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,day,stream,selection_method,resident_bytes,admission_queries,state FROM analytics_partition_work ORDER BY work_key',
 links:'SELECT * FROM analytics_partition_work_links ORDER BY parent_work_key,child_work_key',subjects:'SELECT * FROM analytics_partition_work_subjects ORDER BY work_key,source_id,owner_digest',
 effects:'SELECT * FROM analytics_partition_effect_refs ORDER BY work_key,effect_key',closures:'SELECT * FROM analytics_canonical_publication_closures ORDER BY closure_key',publicHeads:'SELECT * FROM analytics_community_daily_heads ORDER BY day',
} as const;
async function exact(){const values:Record<string,unknown>={};for(const [name,sql] of Object.entries(exactQueries))values[name]=(await target().prepare(sql).all()).results;return values;}
async function run(mode:'group'|'single',factory?:AnalyticsActivityGroupInput['captureGroupProof'],adapter?:(db:D1Database)=>D1Database){
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();let phase='claim';
 const native=adapter?adapter(target()):target();
 const profiled=profileAnalyticsDatabase(native,'target',profile,()=>phase);
 const observed=mode==='group'?afterEachBatch(profiled,partBatch,async()=>{phase='work_receipt';}):profiled;
 const database=invocation.wrap(observed);
 const ingestion=invocation.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>phase));let group:AnalyticsActivityGroupResult|undefined;
 const proofFactory:NonNullable<AnalyticsActivityGroupInput['captureGroupProof']>=async input=>{
  phase='proof';const proof=await (factory??captureAnalyticsManifestGroupProof)(input);phase='membership';
  if(proof.state!=='complete')return proof;let adopting=false;
  return {...proof,canCommit:async()=>{if(!adopting)phase='preparation';return proof.canCommit();},
   stillCurrent:async()=>{if(!adopting)phase='preparation';return proof.stillCurrent();},
   forMember:key=>{adopting=true;phase='part_adoption';return proof.forMember(key);}};
 };
 const common={invocation,now:Date.now,deadlineMs:Date.now()+60_000,
  claim:(limit:number)=>{phase='claim';return claimAnalyticsPartitionWork(database,{sourceId,limit,nowMs:Date.now(),stages:['activity']});},
  release:async(lease:Parameters<typeof releaseAnalyticsPartitionWork>[1],outcome:Parameters<typeof releaseAnalyticsPartitionWork>[2])=>{phase='release';await releaseAnalyticsPartitionWork(database,lease,outcome,Date.now());}};
 const progress=mode==='group'?await dispatchAnalyticsActivityGroup({...common,execute:async(leases,budget)=>{
  phase='discovery';group=await advanceAnalyticsActivityGroup({target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],leases,budget,captureGroupProof:proofFactory});return group.members;
 }}):await dispatchAnalyticsWork({...common,degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,execute:async(lease,budget)=>(await advanceAnalyticsPublicationWork({
  target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,budget,canonicalPreparation:createCanonicalSharedFeaturePreparation})).outcome});
 profile.wallMs=performance.now()-started;profile.invocations=1;profile.maximumStatementsPerInvocation=invocation.queriesUsed;
 const summary=summarizeAnalyticsProfile(profile);expect(summary.statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 return {progress,group,receipt:{statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:summary.wallMs,
  maxStatements:invocation.queriesUsed,phaseStatements:Object.fromEntries(['claim','discovery','proof','membership','preparation','part_adoption','work_receipt','release'].map(label=>[label,Object.entries(summary.costs).filter(([key])=>key.startsWith(label+'.')).reduce((n,[,value])=>n+value.statements,0)])),cpuMs:null,peakHeapBytes:null}};
}
async function compare(count:number,label:string){
 await restore();const singles=[];for(let n=0;n<count;n++){const value=await run('single');expect(value.progress.complete).toBe(1);singles.push(value);}
 const expected=await exact(),imported=await restore(),group=await run('group');expect(group.progress).toMatchObject({complete:count,failed:0,releaseDeferred:0});
 expect(group.group).toMatchObject({facts:expect.any(Number),scopes:expect.any(Number)});expect(group.group!.facts).toBeLessThanOrEqual(16);
 expect(group.group!.residentBytes).toBeLessThanOrEqual(32*1024*1024);expect(await exact()).toEqual(expected);
 console.info(label+' '+JSON.stringify({laboratory:laboratoryReceipt,imported,originalSingletons:{completed:count,
  statements:singles.reduce((n,v)=>n+v.receipt.statements,0),rowsRead:singles.reduce((n,v)=>n+v.receipt.rowsRead,0),rowsWritten:singles.reduce((n,v)=>n+v.receipt.rowsWritten,0),
  elapsedMs:singles.reduce((n,v)=>n+v.receipt.elapsedMs,0)},group:{...group.receipt,claimed:group.progress.claimed,completed:group.progress.complete,facts:group.group!.facts,scopes:group.group!.scopes},
  computeReserve:850,releasePerMember:2,executors:1,outputHash:await sha256Hex(canonicalJson(expected)),operationalClocks:'Lease/schedule and private part/replacement creation clocks remain real and are excluded; analytical payloads and immutable revisions are exact.'}));
}
it('matches eight original native singleton activity leaves from the same accepted ready snapshot',()=>compare(8,'A04_ACTIVITY_GROUP_COMMON_PROFILE'),120_000);
it('preserves direct small mixed-scope activity groups and reports their actual cost',()=>mixed(()=>compare(readyJobs,'A04_ACTIVITY_GROUP_MIXED_PROFILE')),120_000);
it('previews the exact eight fair activity heads and pins every original manifest revision',async()=>{
 await restore();const meter=createD1InvocationBudget(950),db=meter.wrap(target()),nowMs=Date.now();
 const first=(await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:['activity']}))[0]!;
 const start=meter.queriesUsed,preview=await previewAnalyticsActivityGroup({target:db,first,sourceId,nowMs,stages:['activity']});expect(preview.state).toBe('eligible');
 expect(meter.queriesUsed-start).toBe(25);if(preview.state!=='eligible')throw Error('expected activity prefix');
 const rest=await claimAnalyticsPartitionWork(db,{sourceId,limit:7,nowMs,stages:['activity']});expect([first,...rest].map(value=>value.workKey)).toEqual(preview.workKeys);
 for(const lease of [first,...rest])await releaseAnalyticsPartitionWork(db,lease,'not_admitted',nowMs);
});
it('reads a bounded original manifest union exactly without rehydrating eight value payloads',async()=>{
 await restore();const leases=await claimAnalyticsPartitionWork(target(),{sourceId,limit:8,nowMs:Date.now(),stages:['activity']});
 const works=await Promise.all(leases.map(lease=>readAnalyticsPartitionWork(target(),lease,Date.now()))),expected=works.map(work=>({partitionKey:work!.partitionKey,contentRevision:work!.inputRevision}));
 const full=await Promise.all(expected.map(value=>readCanonicalPartition(target(),value.partitionKey))),meter=createD1InvocationBudget(950);
 expect(await readCanonicalPartitionManifests(meter.wrap(target()),expected)).toEqual(full.map(value=>value!.manifest));expect(meter.queriesUsed).toBeLessThanOrEqual(5);
 expect(await readCanonicalPartitionManifests(target(),[{...expected[0]!,contentRevision:'f'.repeat(64)}])).toBeNull();
 await expect(readCanonicalPartitionManifests(target(),[expected[0]!,expected[0]!])).rejects.toThrow('CANONICAL_LIMIT');
 await target().prepare('UPDATE analytics_canonical_dirty_partitions SET generation=generation+1 WHERE partition_key=?').bind(expected[0]!.partitionKey.slice(0,expected[0]!.partitionKey.lastIndexOf('/')+3)).run();
 expect(await readCanonicalPartitionManifests(target(),expected)).toBeNull();
});
function afterEachBatch(db:D1Database,predicate:(sql:readonly string[])=>boolean,after:()=>Promise<void>):D1Database{return afterBatch(db,predicate,after,false,false);}
function afterBatch(db:D1Database,predicate:(sql:readonly string[])=>boolean,after:()=>Promise<void>,lost=false,once=true):D1Database{
 const entries=new WeakMap<D1PreparedStatement,{sql:string;original:D1PreparedStatement}>();let fired=false;
 const wrap=(original:D1PreparedStatement,sql:string):D1PreparedStatement=>{const proxy=new Proxy(original,{get(inner,key){
  if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql);const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});entries.set(proxy,{sql,original});return proxy;};
 return new Proxy(db,{get(inner,key){if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const values=statements.map(statement=>entries.get(statement)!);expect(values.every(Boolean)).toBe(true);
   const result=await inner.batch(values.map(value=>value.original));if((!once||!fired)&&predicate(values.map(value=>value.sql))){fired=true;await after();if(lost)throw Error('synthetic accepted response lost');}return result;};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
}
const partBatch=(sql:readonly string[])=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_publication_part_heads'));
const completeBatch=(sql:readonly string[])=>sql.some(value=>/UPDATE\s+analytics_partition_work\s+SET\s+state='complete'/iu.test(value));
for(const [label,predicate] of [['part',partBatch],['completion',completeBatch]] as const)it('recovers lost '+label+' responses only through original exact receipts without duplicate successors',async()=>{
 await restore();let lost=false;const result=await run('group',undefined,db=>afterBatch(db,predicate,async()=>{lost=true;},true));
 expect(lost).toBe(true);expect(result.progress).toMatchObject({complete:8,failed:0,releaseDeferred:0});
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work_links l JOIN analytics_partition_work w ON w.work_key=l.parent_work_key WHERE w.stage='activity'").first<number>('n')).toBe(8);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication'").first<number>('n')).toBe(8);
});
async function mutateSource(db:D1Database){const owner=(await readStorageCommunityOwnerPage(db)).find(value=>value.ownerDigest===ownerDigest);expect(owner).toBeTruthy();
 expect(await db.prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=? RETURNING revision')
  .bind(owner!.participantId).first<number>('revision')).toBe(owner!.inputRevision+1);}
for(const [label,predicate,completed] of [['part',partBatch,0],['completion',completeBatch,1]] as const)it('fences source mutation after the first durable '+label+' and retains unfinished original jobs',async()=>{
 await restore();let measured:D1Database,changed=false;
 const result=await run('group',async input=>{measured=input.budget.meter.wrap(input.sources[0]!.database);return captureAnalyticsManifestGroupProof(input);},
  db=>afterBatch(db,predicate,async()=>{await mutateSource(measured);changed=true;}));
 expect(changed).toBe(true);expect(result.progress.complete).toBe(0);expect(result.progress.failed).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='complete'").first<number>('n')).toBe(completed);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='ready'").first<number>('n')).toBe(readyJobs-completed);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_heads').first<number>('n')).toBe(0);
});
it('refuses mixed stages or mismatched activity input revisions in the shared group proof',async()=>{
 await restore();const meter=createD1InvocationBudget(950),db=meter.wrap(target()),leases=await claimAnalyticsPartitionWork(db,{sourceId,limit:2,nowMs:Date.now(),stages:['activity']});
 const works=await Promise.all(leases.map(lease=>readAnalyticsPartitionWork(db,lease,Date.now()))),manifests=await readCanonicalPartitionManifests(db,works.map(work=>({partitionKey:work!.partitionKey,contentRevision:work!.inputRevision})));
 const members=works.map((work,index)=>({work:work!,lease:leases[index]!,manifest:manifests![index]!}));
 const base={target:db,sources:[{sourceId,sourceNamespace:sourceId,database:meter.wrap(source())}],budget:{meter,now:Date.now,deadlineMs:Date.now()+60_000,remainingQueries:()=>meter.remainingQueries}};
 expect(await captureAnalyticsManifestGroupProof({...base,members:[{...members[0]!,work:{...members[0]!.work,inputRevision:'f'.repeat(64)}}]})).toEqual({state:'deferred',reason:'manifest_changed'});
 expect(await captureAnalyticsManifestGroupProof({...base,members:[members[0]!,{...members[1]!,work:{...members[1]!.work,stage:'features'},lease:{...members[1]!.lease,stage:'features'}}]})).toEqual({state:'deferred',reason:'manifest_changed'});
});
it('never groups an original retried activity leaf and preserves its singleton progress',async()=>{
 await restore();const partial=await run('group',async input=>{const proof=await captureAnalyticsManifestGroupProof(input);return proof.state==='complete'?{...proof,stillCurrent:async()=>false}:proof;});
 expect(partial.progress.complete).toBe(0);
 // Untouched fair leaves may precede the attempted prefix; preserve that fair
 // selection and continue actual groups until the attempted leaf is offered.
 let retry:Awaited<ReturnType<typeof run>>|undefined;
 for(let n=0;n<readyJobs;n++){retry=await run('group');if(retry.group!.fallbackRequired)break;expect(retry.progress.complete).toBeGreaterThan(0);}
 expect(retry!.progress.admitted).toBe(0);expect(retry!.group!.members.every(member=>member.reason==='singleton_retry_required')).toBe(true);
 expect((await run('single')).progress.complete).toBe(1);
});
it('rechecks exact work table/trigger capability hints after actual drop and restore in the same operation',async()=>{
 await restore();const meter=createD1InvocationBudget(950),db=meter.wrap(target()),name='analytics_partition_work_link_acyclic';
 const sql=await target().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").bind(name).first<string>('sql');expect(sql).toBeTruthy();
 expect(await analyticsPartitionWorkAvailable(db)).toBe(true);expect(await analyticsPartitionWorkAvailable(db)).toBe(true);
 await db.prepare('DROP TRIGGER '+name).run();expect(await analyticsPartitionWorkAvailable(db)).toBe(false);
 await db.prepare(sql!).run();expect(await analyticsPartitionWorkAvailable(db)).toBe(true);
});
it('uses the real runtime for the exact fair eight activity heads and original singleton outputs',async()=>{
 await restore();for(let n=0;n<8;n++)expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();
 const meter=createD1InvocationBudget(950),profile=createAnalyticsProfile(),started=performance.now();
 const progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',profile,()=> 'runtime'),target:profileAnalyticsDatabase(target(),'target',profile,()=> 'runtime'),
  sourceId,sourceNamespace:sourceId,invocation:meter,now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
 expect(progress).toMatchObject({claimed:8,admitted:8,complete:8,failed:0,releaseDeferred:0});expect(await exact()).toEqual(expected);
 const summary=summarizeAnalyticsProfile(profile);expect(summary.statements).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(meter.reserveQueries).toBe(0);
 console.info('A04_ACTIVITY_GROUP_RUNTIME '+JSON.stringify({completed:progress.complete,statements:meter.queriesUsed,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,
  elapsedMs:performance.now()-started,cpuMs:null,peakHeapBytes:null}));
},120_000);

it('uses only the original fair first activity leaf after a real concurrent preview-prefix claim',async()=>{
 await restore();expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();
 let competing:Awaited<ReturnType<typeof claimAnalyticsPartitionWork>>=[];
 const concurrent=createD1InvocationBudget(950),other=concurrent.wrap(target());
 const raw=new Proxy(target(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first')return async(...args:unknown[])=>{
     const result=await Reflect.apply(inner.first,inner,args);
     if(!competing.length&&sql.includes('AND w.last_claimed=? AND w.attempts=1'))
      competing=await claimAnalyticsPartitionWork(other,{sourceId,limit:1,nowMs:Date.now(),stages:['activity']});
     return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  };
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const invocation=createD1InvocationBudget(950);
 const progress=await runCanonicalAnalyticsWorkPass({source:source(),target:raw,sourceId,sourceNamespace:sourceId,invocation,
  now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
 expect(competing).toHaveLength(1);expect(progress).toMatchObject({claimed:1,admitted:1,complete:1,deferred:0,failed:0,releaseDeferred:0});
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='leased'").first<number>('n')).toBe(1);
 expect(await readAnalyticsPartitionWork(other,competing[0]!,Date.now())).not.toBeNull();
 await releaseAnalyticsPartitionWork(other,competing[0]!,'not_admitted',Date.now());
 expect(await exact()).toEqual(expected);expect(invocation.reserveQueries).toBe(0);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 expect(progress.statements).toBe(invocation.queriesUsed);
});
it('takes the exact original retried activity head through the real runtime singleton path',async()=>{
 await restore();expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();
 const lab=createD1InvocationBudget(950),db=lab.wrap(target()),nowMs=Date.now();
 const first=(await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:['activity']}))[0]!,held=[];
 for(let n=0;n<readyJobs;n++){const next=await claimAnalyticsPartitionWork(db,{sourceId,limit:8,nowMs,stages:['activity']});if(!next.length)break;held.push(...next);}
 expect(held).toHaveLength(readyJobs-1);await releaseAnalyticsPartitionWork(db,first,'not_admitted',nowMs);
 const meter=createD1InvocationBudget(950),progress=await runCanonicalAnalyticsWorkPass({source:source(),target:target(),sourceId,sourceNamespace:sourceId,invocation:meter,
  now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
 expect(progress).toMatchObject({claimed:1,admitted:1,complete:1,failed:0,releaseDeferred:0});
 expect(await target().prepare('SELECT state,attempts FROM analytics_partition_work WHERE work_key=?').bind(first.workKey).first()).toEqual({state:'complete',attempts:2});
 for(const lease of held)await releaseAnalyticsPartitionWork(db,lease,'not_admitted',Date.now());
 expect(await exact()).toEqual(expected);expect(meter.reserveQueries).toBe(0);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
});
it('physically erases a mixed subject at the union seal and never adopts a partial activity group',()=>mixed(async()=>{
 await restore();let measuredTarget:D1Database,erased=false;
 expect(await target().prepare('SELECT count(DISTINCT owner_digest) n FROM analytics_canonical_facts').first<number>('n')).toBe(2);
 expect((await target().prepare('SELECT DISTINCT source_id,owner_digest,observed_day,stream,selection_method FROM analytics_canonical_facts').all()).results).toHaveLength(2);
 const result=await run('group',async input=>{measuredTarget=input.budget.meter.wrap(input.target);return captureAnalyticsManifestGroupProof(input);},db=>afterBatch(db,
  sql=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_activity_heads')),async()=>{
   await measuredTarget.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,ownerDigest).run();erased=true;
  }));
 expect(erased).toBe(true);expect(result.progress.complete).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?').bind(ownerDigest).first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest!=?').bind(ownerDigest).first<number>('n')).toBeGreaterThan(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_part_heads').first<number>('n')).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='complete'").first<number>('n')).toBe(0);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},1),120_000);
it('preserves a replacement live lease and never adopts the replaced activity member',()=>mixed(async()=>{
 await restore();let renewed:string|undefined;
 const result=await run('group',async input=>{
  const proof=await captureAnalyticsManifestGroupProof(input);if(proof.state!=='complete')return proof;
  const last=input.members.at(-1)!;return {...proof,forMember:key=>{
   const original=proof.forMember(key);if(key!==last.work.workKey)return original;
   return original&&{...original,stillCurrent:async()=>{
    renewed=crypto.randomUUID();await input.budget.meter.wrap(input.target).prepare(`UPDATE analytics_partition_work SET revision=revision+1,claim_token=?
     WHERE work_key=? AND state='leased' AND revision=?`).bind(renewed,key,last.lease.revision).run();return original.stillCurrent();
   }};
  }};
 });
 expect(renewed).toBeTruthy();expect(result.progress.complete).toBe(1);
 expect(await target().prepare('SELECT state,claim_token FROM analytics_partition_work WHERE claim_token=?').bind(renewed!).first()).toEqual({state:'leased',claim_token:renewed});
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_part_heads').first<number>('n')).toBe(1);
 expect(result.progress.releaseDeferred).toBe(0);
}),120_000);
it('recovers the original remaining activity leaf after interruption following a durable part and child receipt',()=>mixed(async()=>{
 await restore();expect((await run('single')).progress.complete).toBe(1);let controlFailed=false;
 const failBeforePart=(db:D1Database)=>new Proxy(db,{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(['first','all'].includes(String(property))&&sql.startsWith('SELECT revision FROM analytics_canonical_publication_part_heads'))return async()=>{
     controlFailed=true;throw Error('synthetic singleton interruption before part');
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  };
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 expect((await run('single',undefined,failBeforePart)).progress.failed).toBe(1);expect(controlFailed).toBe(true);
 const waitForOriginalRecovery=async()=>{const readyAt=await target().prepare("SELECT ready_ms FROM analytics_partition_work WHERE stage='activity' AND state='ready'").first<number>('ready_ms');
  expect(readyAt).not.toBeNull();const waitMs=Math.max(0,readyAt!-Date.now()+10);expect(waitMs).toBeLessThanOrEqual(5100);if(waitMs)await new Promise(resolve=>setTimeout(resolve,waitMs));};
 await waitForOriginalRecovery();expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();let interrupted=false;
 const partial=await run('group',async input=>{
  const proof=await captureAnalyticsManifestGroupProof(input);if(proof.state!=='complete')return proof;const last=input.members.at(-1)!;
  return {...proof,forMember:key=>{if(key===last.work.workKey){interrupted=true;throw Error('synthetic interruption after first completion');}return proof.forMember(key);}};
 });
 expect(interrupted).toBe(true);expect(partial.progress.failed).toBeGreaterThan(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='complete'").first<number>('n')).toBe(1);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='ready'").first<number>('n')).toBe(1);
 await waitForOriginalRecovery();expect((await run('single')).progress.complete).toBe(1);expect(await exact()).toEqual(expected);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='publication'").first<number>('n')).toBe(2);
}),120_000);
it('makes residual-meter activity progress through bounded original work and exact singleton retries',async()=>{
 await restore();for(let n=0;n<readyJobs;n++)expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();let phase='predecessor';
 const database=invocation.wrap(profileAnalyticsDatabase(target(),'target',profile,()=>phase)),ingestion=invocation.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>phase));
 const predecessor=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,invocation,now:Date.now,deadlineMs:Date.now()+60_000,
  claim:limit=>claimAnalyticsPartitionWork(database,{sourceId,limit,nowMs:Date.now(),stages:['activity']}),
  execute:async(lease,budget)=>(await advanceAnalyticsPublicationWork({target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,budget,
   canonicalPreparation:createCanonicalSharedFeaturePreparation})).outcome,
  release:async(lease,outcome)=>{await releaseAnalyticsPartitionWork(database,lease,outcome,Date.now());}});
 expect(predecessor.complete).toBe(1);const predecessorStatements=invocation.queriesUsed,remainingBefore=invocation.remainingQueries;expect(remainingBefore).toBeGreaterThanOrEqual(740);expect(remainingBefore).toBeLessThan(905);
 phase='residual_runtime';const progress=await runCanonicalAnalyticsWorkPass({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,invocation,
  now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
 expect(progress).toMatchObject({claimed:1,admitted:1,complete:1,deferred:0,failed:0,releaseDeferred:0});
 const durableCompleted=await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='complete'").first<number>('n');
 console.info('A04_ACTIVITY_RESIDUAL_BOUNDARY '+JSON.stringify({predecessorStatements,remainingBefore,progress,totalStatements:invocation.queriesUsed,durableCompleted,residual:invocation.remainingQueries}));
 expect(durableCompleted).toBe(2);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='leased'").first<number>('n')).toBe(0);
 const attempted=(await target().prepare("SELECT work_key,attempts FROM analytics_partition_work WHERE stage='activity' AND state='ready' AND attempts>0 ORDER BY work_key").all<{work_key:string;attempts:number}>()).results;
 expect(attempted).toEqual([]);expect(invocation.reserveQueries).toBe(0);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 expect(summarizeAnalyticsProfile(profile).statements).toBe(invocation.queriesUsed);
 const retries=[];for(let n=0;n<readyJobs;n++){
  if(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state IN('ready','leased')").first<number>('n')===0)break;
  const meter=createD1InvocationBudget(950),next=await runCanonicalAnalyticsWorkPass({source:source(),target:target(),sourceId,sourceNamespace:sourceId,invocation:meter,
   now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
  expect(next.complete).toBeGreaterThan(0);expect(next.failed).toBe(0);expect(next.releaseDeferred).toBe(0);expect(meter.reserveQueries).toBe(0);expect(meter.queriesUsed).toBeLessThanOrEqual(950);retries.push({claimed:next.claimed,complete:next.complete,statements:meter.queriesUsed});
 }
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state IN('ready','leased')").first<number>('n')).toBe(0);
 for(const row of attempted)expect(await target().prepare('SELECT state,attempts FROM analytics_partition_work WHERE work_key=?').bind(row.work_key).first()).toEqual({state:'complete',attempts:2});
 expect(await exact()).toEqual(expected);
 console.info('A04_ACTIVITY_RESIDUAL_PROFILE '+JSON.stringify({predecessorStatements,remainingBefore,runtime:progress,totalStatements:invocation.queriesUsed,
  residual:invocation.remainingQueries,durableAttemptedReady:attempted.length,retries,elapsedMs:performance.now()-started,cpuMs:null,peakHeapBytes:null,
  contract:'One real original activity predecessor then the actual runtime under one unchanged950 meter. Subsequent retries use fresh950 meters; no filler SQL or reduced admissions.'}));
},120_000);

async function withdrawalAfterFirstActivity(){
 const nowMs=Date.now(),meter=createD1InvocationBudget(950),db=meter.wrap(target()),allowed=['activity','cache'] as const;
 // Preserve every actual feature-derived cache job. Its due time changes in
 // lab setup so the role's ordinary first claim is genuinely activity.
 await db.prepare("UPDATE analytics_partition_work SET ready_ms=?,revision=revision+1,updated_ms=? WHERE stage='cache' AND state='ready'")
  .bind(nowMs+120_000,nowMs).run();
 const first=(await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:allowed}))[0]!;expect(first.stage).toBe('activity');
 const sibling=await db.prepare(`SELECT c.work_key FROM analytics_partition_work_links a JOIN analytics_partition_work_links l ON l.parent_work_key=a.parent_work_key
  JOIN analytics_partition_work c ON c.work_key=l.child_work_key WHERE a.child_work_key=? AND c.stage='cache'`).bind(first.workKey).first<string>('work_key');expect(sibling).toBeTruthy();
 await db.prepare("UPDATE analytics_partition_work SET lane='withdrawal',ready_ms=?,revision=revision+1,updated_ms=? WHERE work_key=? AND stage='cache' AND state='ready'")
  .bind(nowMs,nowMs,sibling).run();
 return {nowMs,meter,db,allowed,first,sibling:sibling!};
}
it('declines the ordinary mixed-stage withdrawal prefix instead of skipping a genuine existing cache head',async()=>{
 await restore();const {nowMs,db,allowed,first,sibling}=await withdrawalAfterFirstActivity();
 expect(await previewAnalyticsActivityGroup({target:db,sourceId,first,nowMs,stages:allowed})).toEqual({state:'ineligible',reason:'incompatible_prefix'});
 expect(await previewAnalyticsActivityGroup({target:db,sourceId,first,nowMs})).toEqual({state:'ineligible',reason:'incompatible_prefix'});
 expect(await db.prepare('SELECT stage,lane,state,attempts FROM analytics_partition_work WHERE work_key=?').bind(sibling).first())
  .toEqual({stage:'cache',lane:'withdrawal',state:'ready',attempts:0});
 const scoped=await previewAnalyticsActivityGroup({target:db,sourceId,first,nowMs,stages:['activity']});expect(scoped.state).toBe('eligible');
 if(scoped.state!=='eligible')throw Error('expected activity-only role');
 const fork=(await captureAcceptedSourceTransfer(target())).transfer,turnBefore=await db.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn');
 const rest=await claimAnalyticsPartitionWork(db,{sourceId,limit:7,nowMs,stages:allowed,expectedWorkKeys:scoped.workKeys.slice(1)});
 const guardedTurn=await db.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn');expect(guardedTurn).toBe(turnBefore!+rest.length+1);
 // The current ordinary turn may reach withdrawal immediately or after one
 // new activity turn. Stop at its exact candidate; do not impose a lane turn.
 expect(rest.length).toBeLessThanOrEqual(1);expect(rest.map(lease=>lease.workKey)).toEqual(scoped.workKeys.slice(1,rest.length+1));
 expect(await db.prepare('SELECT stage,lane,state,attempts FROM analytics_partition_work WHERE work_key=?').bind(sibling).first())
  .toEqual({stage:'cache',lane:'withdrawal',state:'ready',attempts:0});
 for(const lease of [first,...rest])await releaseAnalyticsPartitionWork(db,lease,'not_admitted',nowMs);
 // Restore the identical accepted target state before the guarded call.
 // Actual ordinary single claims consume the same attempted turns, including
 // the refused foreign candidate. Its ordinary admission also proves progress.
 await reset();await importAcceptedSourceTransfer(snapshot.source,source());await importAcceptedSourceTransfer(fork,target());
 const control=createD1InvocationBudget(950).wrap(target()),ordinary=[];
 for(let n=0;n<rest.length+1;n++)ordinary.push((await claimAnalyticsPartitionWork(control,{sourceId,limit:1,nowMs,stages:allowed}))[0]!);
 expect(ordinary.map(lease=>lease.workKey)).toEqual([...rest.map(lease=>lease.workKey),sibling]);expect(ordinary.at(-1)!.stage).toBe('cache');
 expect(await control.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn')).toBe(guardedTurn);
 for(const lease of [first,...ordinary])await releaseAnalyticsPartitionWork(control,lease,'not_admitted',nowMs);
});
it('continues an exact guarded prefix for a role that intentionally permits activity only',async()=>{
 await restore();const {nowMs,db,first,sibling,meter}=await withdrawalAfterFirstActivity();
 const preview=await previewAnalyticsActivityGroup({target:db,sourceId,first,nowMs,stages:['activity']});expect(preview.state).toBe('eligible');
 if(preview.state!=='eligible')throw Error('expected role prefix');const started=meter.queriesUsed;
 const rest=await claimAnalyticsPartitionWork(db,{sourceId,limit:7,nowMs,stages:['activity'],expectedWorkKeys:preview.workKeys.slice(1)});
 expect(rest).toHaveLength(7);expect(meter.queriesUsed-started).toBe(21);
 expect([first,...rest].map(lease=>lease.workKey)).toEqual(preview.workKeys);
 expect(await db.prepare('SELECT state,attempts FROM analytics_partition_work WHERE work_key=?').bind(sibling).first()).toEqual({state:'ready',attempts:0});
 for(const lease of [first,...rest])await releaseAnalyticsPartitionWork(db,lease,'not_admitted',nowMs);
});
it('validates exact expected keys before mutation and never selects a hinted noncandidate directly',async()=>{
 await restore();const meter=createD1InvocationBudget(950),db=meter.wrap(target()),nowMs=Date.now();
 const key=await db.prepare("SELECT work_key FROM analytics_partition_work WHERE stage='cache' AND state='ready' ORDER BY work_key LIMIT 1").first<string>('work_key');expect(key).toBeTruthy();
 const before=meter.queriesUsed;
 for(const expectedWorkKeys of [[],[key!,key!],['invalid-key']])await expect(claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:['activity'],expectedWorkKeys})).rejects.toThrow('ANALYTICS_PARTITION_WORK_INVALID');
 expect(meter.queriesUsed).toBe(before);
 expect(await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:['activity'],expectedWorkKeys:[key!]})).toEqual([]);
 expect(meter.queriesUsed-before).toBe(2);expect(await db.prepare("SELECT count(*) n FROM analytics_partition_work WHERE state='leased'").first<number>('n')).toBe(0);
 expect(await db.prepare('SELECT state,attempts FROM analytics_partition_work WHERE work_key=?').bind(key).first()).toEqual({state:'ready',attempts:0});
});
it('releases only the claimed homogeneous prefix when a concurrent claim changes a later companion',async()=>{
 await restore();expect((await run('single')).progress.complete).toBe(1);const expected=await exact();await restore();
 const turnBefore=await target().prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn');
 let fired=false,matched:string|undefined,competing:Awaited<ReturnType<typeof claimAnalyticsPartitionWork>>=[];
 const other=createD1InvocationBudget(950).wrap(target());
 const raw=new Proxy(target(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first')return async(...args:unknown[])=>{
     const result=await Reflect.apply(inner.first,inner,args);
     if(!fired&&sql.includes('AND work_key=?')&&/UPDATE\s+analytics_partition_work\s+SET\s+state='leased'/iu.test(sql)){
      fired=true;matched=(result as {work_key:string}).work_key;
      competing=await claimAnalyticsPartitionWork(other,{sourceId,limit:1,nowMs:Date.now(),stages:['activity']});
     }return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  };
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const invocation=createD1InvocationBudget(950),progress=await runCanonicalAnalyticsWorkPass({source:source(),target:raw,sourceId,sourceNamespace:sourceId,invocation,
  now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['activity'],bridge:false});
 expect(fired).toBe(true);expect(competing).toHaveLength(1);expect(progress).toMatchObject({claimed:2,admitted:1,complete:1,deferred:1,failed:0,releaseDeferred:0});
 expect(await target().prepare('SELECT state,claim_token,claim_expires_ms FROM analytics_partition_work WHERE work_key=?').bind(matched!).first())
  .toEqual({state:'ready',claim_token:null,claim_expires_ms:0});
 expect(await readAnalyticsPartitionWork(other,competing[0]!,Date.now())).not.toBeNull();
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state='leased'").first<number>('n')).toBe(1);
 const stoppedTurn=await target().prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn');expect(stoppedTurn).toBe(turnBefore!+4);
 await releaseAnalyticsPartitionWork(other,competing[0]!,'not_admitted',Date.now());expect(await exact()).toEqual(expected);
 await restore();const control=createD1InvocationBudget(950).wrap(target()),ordinary=[];
 for(let n=0;n<4;n++)ordinary.push((await claimAnalyticsPartitionWork(control,{sourceId,limit:1,nowMs:Date.now(),stages:['activity']}))[0]!);
 expect(ordinary[1]!.workKey).toBe(matched);expect(ordinary[2]!.workKey).toBe(competing[0]!.workKey);
 expect(await control.prepare('SELECT turn FROM analytics_partition_schedule WHERE source_id=?').bind(sourceId).first<number>('turn')).toBe(stoppedTurn);
 for(const lease of ordinary)await releaseAnalyticsPartitionWork(control,lease,'not_admitted',Date.now());
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);expect(progress.statements).toBe(invocation.queriesUsed);
});
