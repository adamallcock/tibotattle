import {env,reset} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {CANONICAL_FEATURE_QUANTITY_METHOD} from '../src/canonical-feature-contributions';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {dispatchAnalyticsFeatureGroup,dispatchAnalyticsWork,selectAnalyticsFeatureGroup,
 type AnalyticsFeatureGroupEstimate} from '../src/analytics-partition-work';
import {advanceAnalyticsFeatureGroup,type AnalyticsFeatureGroupInput,type AnalyticsFeatureGroupResult} from '../src/storage-analytics-feature-group';
import {advanceAnalyticsCanonicalWork} from '../src/storage-analytics-canonical-work';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {captureAnalyticsManifestGroupProof} from '../src/storage-analytics-work-proof';
import {advanceCanonicalInputWork} from '../src/storage-canonical-analytics-input';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,previewAnalyticsFeatureGroup,readAnalyticsPartitionWork} from '../src/storage-analytics-partition-work';
import {materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-feature-group',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
let snapshot:{source:AcceptedSourceTransfer;target:AcceptedSourceTransfer},ownerDigest:string,readyJobs=0;
let laboratoryReceipt:unknown;
async function setupFixture(commonScope=false){
 await reset();const start=performance.now();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const initializationMs=performance.now()-start,profile=createAnalyticsProfile();
 const setupSource=profileAnalyticsDatabase(source(),'source',profile,()=> 'laboratory_setup');
 const setupTarget=profileAnalyticsDatabase(target(),'target',profile,()=> 'laboratory_setup');
 const corpus=await seedSharedAnalyticsCorpus({source:setupSource,target:setupTarget,sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:2,denseUsageRows:commonScope?8:0,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 const day=commonScope?corpus.graphDates[0]!:corpus.equivalentDay;
 ownerDigest=corpus.owner.ownerDigest;
 const owners=(await readStorageCommunityOwnerPage(setupSource)).filter(owner=>owner.ownerDigest);
 expect(owners.length).toBeGreaterThanOrEqual(2);
 for(const owner of owners.filter(owner=>!commonScope||owner.ownerDigest===ownerDigest)){
  await setupTarget.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
   VALUES(?,?,?,?,'active') ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  let covered=false;
  for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(setupSource,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128})).status==='complete'){covered=true;break;}
  expect(covered).toBe(true);let sealed=false;
  for(let n=0;n<32;n++)if((await advanceCanonicalInputWork(setupSource,setupTarget,{sourceId,sourceNamespace:sourceId,
   ownerDigest:owner.ownerDigest!,participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1',
   budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}})).state==='complete'){sealed=true;break;}
  expect(sealed).toBe(true);
 }
 // Actual outbox admission resolves these canonical effects. Unrelated range
 // expansion and canonical jobs are retained; no fixture ACK/deletion shortcut.
 for(let n=0;n<16;n++){
  await advanceAnalyticsWorkEffects({source:setupSource,target:setupTarget,sourceId,sourceNamespace:sourceId,meter:createD1InvocationBudget(950),
   now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
  if(await setupTarget.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')===0)break;
 }
 expect(await setupTarget.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')).toBe(0);
 readyJobs=await setupTarget.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')??0;
 // The accepted graph-day corpus also contains native model-window usage.
 // Retain those genuine leaves; sixteen is a per-group union bound, not a
 // truncation of accepted input or of the complete comparison fixture.
 expect(readyJobs).toBeGreaterThanOrEqual(commonScope?8:2);expect(readyJobs).toBeLessThanOrEqual(commonScope?128:8);
 expect(await setupTarget.prepare('SELECT count(DISTINCT owner_digest) n FROM analytics_canonical_facts').first<number>('n')).toBe(commonScope?1:2);
 const populations=(await setupTarget.prepare(`SELECT observed_day,stream,selection_method,count(*) facts,count(DISTINCT partition_key) roots
  FROM analytics_canonical_facts GROUP BY observed_day,stream,selection_method ORDER BY observed_day,stream,selection_method`).all()).results;
 if(commonScope){expect(populations).toHaveLength(1);expect(populations[0]).toMatchObject({observed_day:day,stream:'usage',selection_method:'effective-union-v1'});
  expect(populations[0]!.roots).toBeGreaterThanOrEqual(8);}
 const capturedSource=await captureAcceptedSourceTransfer(source()),capturedTarget=await captureAcceptedSourceTransfer(target());
 snapshot={source:capturedSource.transfer,target:capturedTarget.transfer};
 const setupSummary=summarizeAnalyticsProfile(profile);
 laboratoryReceipt={elapsedMs:performance.now()-start,initializationMs,initializationStatements:null,
  initializationStatementReason:'Migration application is separate laboratory initialization, outside the scheduled invocation meter.',
  populations,acceptanceCoverageBridge:{statements:setupSummary.statements,failedStatements:setupSummary.failedStatements,
   rowsRead:setupSummary.rowsRead,rowsWritten:setupSummary.rowsWritten},readyJobs,commonScope,
  source:capturedSource.transfer.proof,target:capturedTarget.transfer.proof,
  measurement:'Synthetic acceptance, coverage, canonical input, bridge and export are laboratory setup; not measured feature execution.'};
}
beforeAll(()=>setupFixture(),120_000);
async function restore(){await reset();const started=performance.now();
 const left=await importAcceptedSourceTransfer(snapshot.source,source()),right=await importAcceptedSourceTransfer(snapshot.target,target());
 expect(left.proof).toEqual(snapshot.source.proof);expect(right.proof).toEqual(snapshot.target.proof);
 return {elapsedMs:performance.now()-started,statements:left.importProfile.statements+left.proofProfile.statements+right.importProfile.statements+right.proofProfile.statements};}
async function commonFixture<T>(execute:()=>Promise<T>):Promise<T>{
 const original={snapshot,ownerDigest,readyJobs,laboratoryReceipt};
 try{await setupFixture(true);return await execute();}
 finally{({snapshot,ownerDigest,readyJobs,laboratoryReceipt}=original);}
}

const semanticQueries={
 facts:'SELECT * FROM analytics_canonical_facts ORDER BY revision',heads:'SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key,selection_method',
 variants:'SELECT * FROM analytics_canonical_variants ORDER BY revision,variant_key',
 days:'SELECT * FROM analytics_canonical_days ORDER BY revision,day',tools:'SELECT * FROM analytics_canonical_tools ORDER BY revision,tool_class',
 inputDependencies:`SELECT scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,
  owner_revision,authority_epoch,state,seen_count FROM analytics_canonical_input_work ORDER BY scope_key`,
 inputRefs:'SELECT * FROM analytics_partition_graph_input_refs ORDER BY scope_key',
 summaries:`SELECT scope_key,source_id,source_namespace,owner_digest,from_day,through_day,include_sessions,
  mutation_stamp,dependency_digest,payload,owner_revision,authority_epoch FROM analytics_effective_dependency_summaries ORDER BY scope_key`,
 quantities:'SELECT * FROM analytics_canonical_feature_quantities ORDER BY fact_revision',
 prices:'SELECT * FROM analytics_canonical_feature_prices ORDER BY fact_revision,family,dependency_digest',
 membership:'SELECT * FROM analytics_canonical_feature_membership ORDER BY fact_revision,dependency_revision',
 activityHeads:'SELECT * FROM analytics_canonical_activity_heads ORDER BY content_revision',
 manifests:'SELECT * FROM analytics_canonical_manifests ORDER BY content_revision',
 manifestRows:'SELECT * FROM analytics_canonical_manifest_rows ORDER BY content_revision,ordinal',
 partitionHeads:'SELECT * FROM analytics_canonical_partition_heads ORDER BY partition_key',
 work:`SELECT work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,day,stream,selection_method,
  resident_bytes,admission_queries,state FROM analytics_partition_work ORDER BY work_key`,
 links:'SELECT * FROM analytics_partition_work_links ORDER BY parent_work_key,child_work_key',
 subjects:'SELECT * FROM analytics_partition_work_subjects ORDER BY work_key,source_id,owner_digest',
 effects:'SELECT * FROM analytics_partition_effect_refs ORDER BY work_key,effect_key',
 publicHeads:'SELECT * FROM analytics_community_daily_heads ORDER BY day',
 closures:'SELECT * FROM analytics_canonical_publication_closures ORDER BY closure_key',
} as const;
async function semantics(){const exact:Record<string,unknown>={};for(const [name,sql] of Object.entries(semanticQueries))exact[name]=(await target().prepare(sql).all()).results;return exact;}
async function run(mode:'group'|'single',factory?:AnalyticsFeatureGroupInput['captureGroupProof'],adapter?:(db:D1Database)=>D1Database){
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();
 const rawTarget=adapter?adapter(target()):target();
 const database=invocation.wrap(profileAnalyticsDatabase(rawTarget,'target',profile,()=>mode));
 const ingestion=invocation.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>mode));
 let group:AnalyticsFeatureGroupResult|undefined;
 let proofMembers:readonly {workKey:string;headKey:string;partitionKey:string;inputRevision:string;manifestRevision:string;rowCount:number}[]=[];
 const common={invocation,now:Date.now,deadlineMs:Date.now()+60_000,
  claim:(limit:number)=>claimAnalyticsPartitionWork(database,{sourceId,limit,nowMs:Date.now(),stages:['features']}),
  release:async(lease:Parameters<typeof releaseAnalyticsPartitionWork>[1],outcome:Parameters<typeof releaseAnalyticsPartitionWork>[2])=>{await releaseAnalyticsPartitionWork(database,lease,outcome,Date.now());}};
 const progress=mode==='group'?await dispatchAnalyticsFeatureGroup({...common,execute:async(leases,budget)=>{
  group=await advanceAnalyticsFeatureGroup({target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],leases,budget,
   captureGroupProof:async input=>{
    // Original synthetic head vectors only; no source row, owner identifier,
    // private body or extra observational SQL is retained.
    proofMembers=input.members.map(({work,manifest})=>({workKey:work.workKey,headKey:work.headKey,partitionKey:work.partitionKey,
     inputRevision:work.inputRevision,manifestRevision:manifest.contentRevision,rowCount:manifest.rowCount}));
    return (factory??captureAnalyticsManifestGroupProof)(input);
   }});return group.members;
 }}):await dispatchAnalyticsWork({...common,degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,
  execute:async(lease,budget)=>(await advanceAnalyticsCanonicalWork({target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,budget})).outcome});
 profile.wallMs=performance.now()-started;profile.invocations=1;profile.maximumStatementsPerInvocation=invocation.queriesUsed;
 const summary=summarizeAnalyticsProfile(profile);
 expect(summary.statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 return {progress,group,proofMembers,receipt:{...summary,cpuMs:null,peakHeapBytes:null,
  unavailableReason:'Isolate CPU/heap and physical wire are not observed.'}};
}
async function compareFixture(label:string,maxAdmitted?:number){
 const receipts:Record<string,unknown>={laboratory:laboratoryReceipt};let baseline:Awaited<ReturnType<typeof semantics>>|undefined;
 for(const mode of ['single','group'] as const){
  const imported=await restore(),waves:Awaited<ReturnType<typeof run>>[]=[];
  for(let n=0;n<128;n++){
   if(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state IN('ready','leased')").first<number>('n')===0)break;
   const wave=await run(mode);waves.push(wave);expect(wave.progress.failed).toBe(0);expect(wave.progress.releaseDeferred).toBe(0);
   expect(wave.receipt.failedStatements).toBe(0);expect(wave.progress.complete).toBeGreaterThan(0);
   if(mode==='group')expect(wave.group).toMatchObject({facts:expect.any(Number),scopes:expect.any(Number)});
  }
  expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state IN('ready','leased')").first<number>('n')).toBe(0);
  expect(waves.reduce((n,wave)=>n+wave.progress.complete,0)).toBe(readyJobs);
  const exact=await semantics();if(baseline)expect(exact).toEqual(baseline);else baseline=exact;
  if(mode==='group'){
   const admitted=Math.max(...waves.map(wave=>wave.progress.admitted));expect(admitted).toBeGreaterThan(1);
   if(maxAdmitted!==undefined)expect(admitted).toBe(maxAdmitted);
   for(const wave of waves){expect(wave.group!.facts).toBeLessThanOrEqual(16);expect(wave.group!.scopes).toBeLessThanOrEqual(4);
    expect(wave.group!.residentBytes).toBeLessThanOrEqual(32*1024*1024);}
  }
  expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  receipts[mode]={imported,waves:waves.length,claimed:waves.reduce((n,wave)=>n+wave.progress.claimed,0),
   completed:waves.reduce((n,wave)=>n+wave.progress.complete,0),maxAdmitted:Math.max(...waves.map(wave=>wave.progress.admitted)),
   statements:waves.reduce((n,wave)=>n+wave.receipt.statements,0),rowsRead:waves.reduce((n,wave)=>n+wave.receipt.rowsRead,0),
   rowsWritten:waves.reduce((n,wave)=>n+wave.receipt.rowsWritten,0),elapsedMs:waves.reduce((n,wave)=>n+wave.receipt.wallMs,0),
   maxStatements:Math.max(...waves.map(wave=>wave.receipt.maximumStatementsPerInvocation)),
   maxFacts:mode==='group'?Math.max(...waves.map(wave=>wave.group!.facts)):null,
   maxScopes:mode==='group'?Math.max(...waves.map(wave=>wave.group!.scopes)):null,
   maxReservedResidentBytes:mode==='group'?Math.max(...waves.map(wave=>wave.group!.residentBytes)):4*1024*1024,
   computeReserve:600,releaseReservePerMember:2,concurrentExecutors:1,
   firstGroup:mode==='group'?{scopes:waves[0]!.group!.scopes,facts:waves[0]!.group!.facts,
    admitted:waves[0]!.progress.admitted,completed:waves[0]!.progress.complete,statements:waves[0]!.receipt.statements,
    residentBytes:waves[0]!.group!.residentBytes,originalMembers:waves[0]!.proofMembers}:null,
   outputHash:await sha256Hex(canonicalJson(exact)),cpuMs:null,peakHeapBytes:null};
 }
 console.info(label+' '+JSON.stringify(receipts));
}
it('compares actual grouped and individual feature production from the exact same ready snapshot',
 ()=>compareFixture('A04_FEATURE_GROUP_PROFILE'),120_000);
it('amortizes actual preparation of eight sparse eligible leaves sharing one exact source scope',async()=>{
 const original={snapshot,ownerDigest,readyJobs,laboratoryReceipt};
 try{await setupFixture(true);await compareFixture('A04_FEATURE_GROUP_COMMON_SCOPE_PROFILE',8);}
 finally{({snapshot,ownerDigest,readyJobs,laboratoryReceipt}=original);}
},120_000);

/** Transparent local transport fault: underlying D1 still executes every
 * original statement. No source values or SQL enter diagnostic receipts. */
function afterBatch(db:D1Database,shouldFault:(sql:readonly string[])=>boolean,after:()=>Promise<void>,loseResponse=false):D1Database{
 const statements=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string}>();let fired=false;
 const wrap=(original:D1PreparedStatement,sql:string):D1PreparedStatement=>{const proxy=new Proxy(original,{get(inner,key){
  if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql);
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});statements.set(proxy,{original,sql});return proxy;};
 return new Proxy(db,{get(inner,key){
  if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(key==='batch')return async(batch:D1PreparedStatement[])=>{
   const values=batch.map(statement=>statements.get(statement)!);if(values.some(value=>!value))throw Error('foreign fault statement');
   const result=await inner.batch(values.map(value=>value.original));
   if(!fired&&shouldFault(values.map(value=>value.sql))){fired=true;await after();if(loseResponse)throw Error('synthetic accepted response lost');}
   return result;
  };
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
}
const completesLeaf=(sql:readonly string[])=>sql.some(value=>/UPDATE\s+analytics_partition_work\s+SET\s+state\s*=\s*'complete'/iu.test(value));
async function mutatePinnedOwner(database:D1Database){
 const before=await readStorageCommunityOwnerPage(database);const owner=before.find(value=>value.ownerDigest===ownerDigest);
 expect(owner).toBeTruthy();
 const updated=await database.prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=? RETURNING revision')
  .bind(owner!.participantId).first<number>('revision');
 expect(updated).toBe(owner!.inputRevision+1);
}
it('recovers a lost first completion response without duplicate successors and permits subsequent exact member completion',async()=>{
 await restore();let responseLost=false;
 const result=await run('group',undefined,db=>afterBatch(db,completesLeaf,async()=>{responseLost=true;},true));
 expect(responseLost).toBe(true);
 expect(result.progress.complete).toBe(readyJobs);expect(result.progress.failed).toBe(0);expect(result.progress.releaseDeferred).toBe(0);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_partition_work_links l JOIN analytics_partition_work p ON p.work_key=l.parent_work_key
  WHERE p.stage='features'`).first<number>('n')).toBe(readyJobs*2);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage IN('activity','cache')").first<number>('n')).toBe(readyJobs*2);
});
it('refuses source mutation after real joint proof acquisition',async()=>{
 await restore();let changed=false;const result=await run('group',async input=>{
  const proof=await captureAnalyticsManifestGroupProof(input);if(proof.state==='complete'){
   await mutatePinnedOwner(input.budget.meter.wrap(input.sources[0]!.database));changed=true;
  }return proof;
 });
 expect(changed).toBe(true);expect(result.progress.failed).toBe(0);
 expect(result.progress.complete).toBe(0);expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_feature_quantities').first<number>('n')).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(readyJobs);
});
it('physically erases one mixed subject after union writes and never seals a partial group',async()=>{
 await restore();let measuredTarget:D1Database;
 const result=await run('group',async input=>{measuredTarget=input.budget.meter.wrap(input.target);return captureAnalyticsManifestGroupProof(input);},db=>afterBatch(db,
  sql=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_feature_quantities')),async()=>{
   await measuredTarget.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,ownerDigest).run();
  }));
 expect(result.progress.complete).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?').bind(ownerDigest).first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest!=?').bind(ownerDigest).first<number>('n')).toBeGreaterThan(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_feature_quantities q JOIN analytics_canonical_facts f ON f.revision=q.fact_revision WHERE f.owner_digest=?')
  .bind(ownerDigest).first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_activity_heads').first<number>('n')).toBe(0);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('keeps a source change after first completion explicit and leaves unfinished original leaves discoverable',async()=>{
 await restore();let measuredSource:D1Database,changed=false;
 const result=await run('group',async input=>{measuredSource=input.budget.meter.wrap(input.sources[0]!.database);return captureAnalyticsManifestGroupProof(input);},db=>afterBatch(db,
  completesLeaf,async()=>{
   await mutatePinnedOwner(measuredSource);changed=true;
  }));
 expect(changed).toBe(true);
 expect(result.progress.complete).toBe(0);
 expect(result.group!.members.filter(member=>member.completedWithinLease)).toHaveLength(1);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='complete'").first<number>('n')).toBe(1);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(readyJobs-1);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
},20_000);
it('recovers unfinished members after an interruption following one durable completion',async()=>{
 await restore();let interrupted=false;
 const partial=await run('group',async input=>{
  const proof=await captureAnalyticsManifestGroupProof(input);if(proof.state!=='complete')return proof;
  const last=input.members.at(-1)!;return {...proof,forMember:key=>{
   if(key===last.work.workKey){interrupted=true;throw Error('synthetic interruption after first completion');}
   return proof.forMember(key);
  }};
 });
 expect(interrupted).toBe(true);expect(partial.progress.failed).toBeGreaterThan(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='complete'").first<number>('n')).toBe(readyJobs-1);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(1);
 // A real failure release preserves the existing five-second recovery
 // backoff. Resume only when the original ready receipt becomes eligible.
 const readyAt=await target().prepare("SELECT ready_ms FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('ready_ms');
 expect(readyAt).not.toBeNull();const waitMs=Math.max(0,readyAt!-Date.now()+10);expect(waitMs).toBeLessThanOrEqual(5100);
 if(waitMs)await new Promise(resolve=>setTimeout(resolve,waitMs));
 const resumed=await run('single');expect(resumed.progress.complete).toBe(1);
 expect(await target().prepare('SELECT count(*) n FROM analytics_partition_work_links').first<number>('n')).toBe(readyJobs*2);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage IN('activity','cache')").first<number>('n')).toBe(readyJobs*2);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},20_000);
it('uses the real degree1 runtime composition for exactly the fair eight common-scope heads',()=>commonFixture(async()=>{
 await restore();for(let n=0;n<8;n++)expect((await run('single')).progress.complete).toBe(1);
 const expected=await semantics();await restore();
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();
 const progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',profile,()=> 'runtime'),
  target:profileAnalyticsDatabase(target(),'target',profile,()=> 'runtime'),sourceId,sourceNamespace:sourceId,
  invocation,now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['features'],bridge:false});
 const summary=summarizeAnalyticsProfile(profile);
 expect(progress.complete).toBe(8);expect(progress.claimed).toBe(8);expect(progress.failed).toBe(0);
 expect(summary.statements).toBe(invocation.queriesUsed);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 expect(await semantics()).toEqual(expected);
 console.info('A04_FEATURE_GROUP_RUNTIME '+JSON.stringify({completed:progress.complete,statements:invocation.queriesUsed,
  rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:performance.now()-started,cpuMs:null,peakHeapBytes:null}));
}),120_000);
it('previews the exact ordinary seven-claim prefix without changing queue or fairness state',()=>commonFixture(async()=>{
 await restore();const invocation=createD1InvocationBudget(950),database=invocation.wrap(target()),nowMs=Date.now();
 const first=(await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']}))[0]!;
 const queue=async()=>({work:(await target().prepare('SELECT * FROM analytics_partition_work ORDER BY work_key').all()).results,
  schedule:(await target().prepare('SELECT * FROM analytics_partition_schedule ORDER BY source_id').all()).results,
  subjects:(await target().prepare('SELECT * FROM analytics_partition_subject_schedule ORDER BY source_id,owner_digest').all()).results});
 const before=await queue(),started=invocation.queriesUsed;
 const preview=await previewAnalyticsFeatureGroup({target:database,first,sourceId,nowMs,stages:['features']});
 expect(preview.state).toBe('eligible');if(preview.state!=='eligible')throw Error('expected common prefix');
 expect(preview).toMatchObject({scopes:1,residentBytes:32*1024*1024});expect(preview.facts).toBeLessThanOrEqual(16);
 expect(invocation.queriesUsed-started).toBe(17);expect(await queue()).toEqual(before);
 const rest=await claimAnalyticsPartitionWork(database,{sourceId,limit:7,nowMs,stages:['features']});
 expect([first,...rest].map(lease=>lease.workKey)).toEqual(preview.workKeys);
 const others=[...rest];
 for(let n=0;n<readyJobs;n++){
  const next=await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']});
  if(!next.length)break;others.push(next[0]!);
 }
 await releaseAnalyticsPartitionWork(database,first,'not_admitted',nowMs);
 const retry=(await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']}))[0]!;
 expect(retry.workKey).toBe(first.workKey);
 expect((await readAnalyticsPartitionWork(database,retry,nowMs))!.attempts).toBe(2);
 expect(await previewAnalyticsFeatureGroup({target:database,first:retry,sourceId,nowMs,stages:['features']})).toEqual({state:'ineligible',reason:'singleton_retry_required'});
 await releaseAnalyticsPartitionWork(database,retry,'not_admitted',nowMs);
 for(const lease of others)await releaseAnalyticsPartitionWork(database,lease,'not_admitted',nowMs);
}),120_000);
it('declines the ordinary prospective retried head instead of skipping to compatible fresh heads',()=>commonFixture(async()=>{
 await restore();const database=createD1InvocationBudget(950).wrap(target()),nowMs=Date.now();
 const previous=(await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']}))[0]!;
 await releaseAnalyticsPartitionWork(database,previous,'not_admitted',nowMs);
 const first=(await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']}))[0]!;
 expect(first.workKey).not.toBe(previous.workKey);
 // The fair untouched prefix eventually contains the original attempted
 // head; there is no alternative search through the compatible population.
 const held:typeof first[]=[first];
 let preview=await previewAnalyticsFeatureGroup({target:database,first,sourceId,nowMs,stages:['features']});
 for(let n=0;n<readyJobs&&preview.state==='eligible';n++){
  const next=await claimAnalyticsPartitionWork(database,{sourceId,limit:1,nowMs,stages:['features']});
  if(!next.length)break;held.push(next[0]!);
  preview=await previewAnalyticsFeatureGroup({target:database,first:next[0]!,sourceId,nowMs,stages:['features']});
 }
 expect(preview).toEqual({state:'ineligible',reason:'singleton_retry_required'});
 for(const lease of held)await releaseAnalyticsPartitionWork(database,lease,'not_admitted',nowMs);
}),120_000);
it('keeps every-member retry leaves on their original singleton path before group discovery',async()=>{
 await restore();const initial=await run('group',async input=>{
  const proof=await captureAnalyticsManifestGroupProof(input);return proof.state==='complete'?{...proof,stillCurrent:async()=>false}:proof;
 });
 expect(initial.progress.complete).toBe(0);
 const retry=await run('group');expect(retry.progress.admitted).toBe(0);
 expect(retry.group!.members.every(member=>member.reason==='singleton_retry_required')).toBe(true);
 expect(retry.group!.fallbackWorkKeys).toHaveLength(readyJobs);
 expect(retry.group!.selectedWorkKeys).toEqual([]);expect(retry.group!.statements).toBe(readyJobs);
 for(let n=0;n<readyJobs;n++)expect((await run('single')).progress.complete).toBe(1);
});
it('uses only the original fair first leaf when a real concurrent claim changes the preview prefix',()=>commonFixture(async()=>{
 await restore();expect((await run('single')).progress.complete).toBe(1);const expected=await semantics();await restore();
 let competing:Awaited<ReturnType<typeof claimAnalyticsPartitionWork>>=[];
 const concurrent=createD1InvocationBudget(950),other=concurrent.wrap(target());
 const raw=new Proxy(target(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='first')return async(...args:unknown[])=>{
     const result=await Reflect.apply(inner.first,inner,args);
     if(!competing.length&&sql.includes('AND w.last_claimed=? AND w.attempts=1'))
      competing=await claimAnalyticsPartitionWork(other,{sourceId,limit:1,nowMs:Date.now(),stages:['features']});
     return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  };
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const invocation=createD1InvocationBudget(950);
 const progress=await runCanonicalAnalyticsWorkPass({source:source(),target:raw,sourceId,sourceNamespace:sourceId,invocation,
  now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['features'],bridge:false});
 expect(competing).toHaveLength(1);expect(progress).toMatchObject({claimed:1,admitted:1,complete:1,deferred:0,failed:0,releaseDeferred:0});
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='leased'").first<number>('n')).toBe(1);
 expect(await readAnalyticsPartitionWork(other,competing[0]!,Date.now())).not.toBeNull();
 await releaseAnalyticsPartitionWork(other,competing[0]!,'not_admitted',Date.now());
 expect(await semantics()).toEqual(expected);expect(invocation.reserveQueries).toBe(0);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 expect(progress.statements).toBe(invocation.queriesUsed);expect(concurrent.queriesUsed).toBe(5);
}),120_000);
it('reports and releases the exact fair first claim if its SQL execution crosses the runtime deadline',async()=>{
 await restore();let crossed=false,offsetMs=0;const deadlineMs=Date.now()+60_000;
 const raw=new Proxy(target(),{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
    if(property==='all')return async()=>{
     const result=await inner.all();
     if(!crossed&&/UPDATE\s+analytics_partition_work\s+SET\s+state='leased'/iu.test(sql)){
      crossed=true;offsetMs=60_001;
     }
     return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  };
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950);
 const progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',profile,()=> 'deadline'),
  target:profileAnalyticsDatabase(raw,'target',profile,()=> 'deadline'),sourceId,sourceNamespace:sourceId,invocation,
  now:()=>Date.now()+offsetMs,deadlineMs,degree:1,maxWaves:1,stages:['features'],bridge:false});
 expect(crossed).toBe(true);expect(progress).toMatchObject({claimed:1,admitted:0,complete:0,deferred:1,failed:0,releaseDeferred:0});
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='leased'").first<number>('n')).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(readyJobs);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND (claim_token IS NOT NULL OR claim_expires_ms!=0)").first<number>('n')).toBe(0);
 expect(summarizeAnalyticsProfile(profile).statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.reserveQueries).toBe(0);expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
});
it('makes deterministic group value refusal explicitly eligible for the original singleton fallback',async()=>{
 await restore();const revision=await target().prepare('SELECT revision FROM analytics_canonical_heads ORDER BY revision LIMIT 1').first<string>('revision');
 await target().prepare('INSERT INTO analytics_canonical_feature_quantities(fact_revision,method,payload,payload_digest) VALUES(?,?,?,?)')
  .bind(revision,CANONICAL_FEATURE_QUANTITY_METHOD,'{"syntheticInvalidQuantity":true}','0'.repeat(64)).run();
 const result=await run('group');expect(result.group!.fallbackRequired).toBe(true);
 expect(result.group!.fallbackWorkKeys.length).toBeGreaterThan(0);expect(result.progress.complete).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBe(readyJobs);
});
it('recovers an actual eight-claim refusal after real predecessor work leaves less than the singleton reserve',()=>commonFixture(async()=>{
 await restore();const laboratory=createAnalyticsProfile(),lab=profileAnalyticsDatabase(target(),'target',laboratory,()=> 'refusal_laboratory');
 const planningLeases=await claimAnalyticsPartitionWork(lab,{sourceId,limit:2,nowMs:Date.now(),stages:['features']});
 const originalJobs=await Promise.all(planningLeases.map(lease=>readAnalyticsPartitionWork(lab,lease,Date.now())));
 expect(originalJobs).toHaveLength(2);expect(originalJobs.every(job=>job!==null)).toBe(true);
 // Discard the laboratory planning fork via the accepted original snapshot;
 // actual measured jobs still have attempts0 and no inherited laboratory claim.
 await restore();
 // One genuine original feature predecessor uses its ordinary600 admission.
 // Seal only its exact original manifest in separately counted lab setup;
 // no ready job, source effect, retained fact or grouping identity is removed.
 expect((await materializeCanonicalPartition(lab,originalJobs[0]!.partitionKey)).state).toBe('complete');
 const invalidJob=originalJobs[1]!,invalidRevision=await lab.prepare('SELECT revision FROM analytics_canonical_heads WHERE partition_key=? ORDER BY occurrence_key LIMIT 1')
  .bind(invalidJob.partitionKey).first<string>('revision');expect(invalidRevision).not.toBeNull();
 await lab.prepare('INSERT INTO analytics_canonical_feature_quantities(fact_revision,method,payload,payload_digest) VALUES(?,?,?,?)')
  .bind(invalidRevision,CANONICAL_FEATURE_QUANTITY_METHOD,'{"syntheticInvalidQuantity":true}','0'.repeat(64)).run();
 const captured=await captureAcceptedSourceTransfer(target());snapshot={...snapshot,target:captured.transfer};
 await restore();for(let n=0;n<readyJobs;n++){
  const next=await run('single');expect(next.progress.complete+next.progress.refused).toBe(1);expect(next.progress.failed).toBe(0);
 }
 const expected=await semantics(),imported=await restore();
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();
 const database=invocation.wrap(profileAnalyticsDatabase(target(),'target',profile,()=> 'refusal_predecessor'));
 const ingestion=invocation.wrap(profileAnalyticsDatabase(source(),'source',profile,()=> 'refusal_predecessor'));
 const predecessors=[];
 for(let n=0;n<1;n++){
  const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,invocation,
   deadlineMs:Date.now()+60_000,now:Date.now,
   claim:limit=>claimAnalyticsPartitionWork(database,{sourceId,limit,nowMs:Date.now(),stages:['features']}),
   execute:async(lease,budget)=>(await advanceAnalyticsCanonicalWork({target:database,
    sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,budget})).outcome,
   release:async(lease,outcome)=>{await releaseAnalyticsPartitionWork(database,lease,outcome,Date.now());}});
  expect(result.complete).toBe(1);predecessors.push(result);
 }
 const predecessorStatements=invocation.queriesUsed,remainingBeforeRuntime=invocation.remainingQueries;
 expect(remainingBeforeRuntime).toBeGreaterThanOrEqual(740);
 const refusedGroup=await runCanonicalAnalyticsWorkPass({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,
  invocation,now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['features'],bridge:false});
 expect(refusedGroup).toMatchObject({claimed:8,admitted:8,complete:0,deferred:8,refused:0,failed:0,releaseDeferred:0});
 expect(invocation.remainingQueries).toBeLessThan(600);expect(invocation.reserveQueries).toBe(0);
 const deferred=(await target().prepare(`SELECT work_key,attempts,state,claim_token,claim_expires_ms FROM analytics_partition_work
  WHERE stage='features' AND attempts=1 AND state='ready' ORDER BY work_key`).all()).results;
 expect(deferred).toHaveLength(8);expect(deferred.some(row=>row.work_key===invalidJob.workKey)).toBe(true);
 expect(deferred.every(row=>row.claim_token===null&&row.claim_expires_ms===0)).toBe(true);
 expect(summarizeAnalyticsProfile(profile).statements).toBe(invocation.queriesUsed);
 const retries=[];
 for(let n=0;n<readyJobs;n++){
  if(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state IN('ready','leased')").first<number>('n')===0)break;
  const meter=createD1InvocationBudget(950),retryProfile=createAnalyticsProfile();
  const progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',retryProfile,()=> 'refusal_retry'),
   target:profileAnalyticsDatabase(target(),'target',retryProfile,()=> 'refusal_retry'),sourceId,sourceNamespace:sourceId,invocation:meter,
   now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['features'],bridge:false});
  expect(progress.complete+progress.refused).toBeGreaterThan(0);expect(progress.failed).toBe(0);expect(progress.releaseDeferred).toBe(0);
  expect(summarizeAnalyticsProfile(retryProfile).statements).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  expect(meter.reserveQueries).toBe(0);retries.push({claimed:progress.claimed,completed:progress.complete,refused:progress.refused,statements:meter.queriesUsed});
 }
 expect(await target().prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(invalidJob.workKey).first<string>('state')).toBe('refused');
 const retried=(await target().prepare(`SELECT work_key,attempts,state FROM analytics_partition_work
  WHERE work_key IN(SELECT value FROM json_each(?)) ORDER BY work_key`).bind(JSON.stringify(deferred.map(row=>row.work_key))).all()).results;
 expect(retried).toHaveLength(8);expect(retried.every(row=>row.attempts===2&&['complete','refused'].includes(String(row.state)))).toBe(true);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state IN('ready','leased')").first<number>('n')).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='complete'").first<number>('n')).toBe(readyJobs-1);
 expect(await semantics()).toEqual(expected);expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 console.info('A04_FEATURE_GROUP_REFUSAL_RECOVERY '+JSON.stringify({laboratory:laboratoryReceipt,additionalLaboratory:summarizeAnalyticsProfile(laboratory),
  imported,predecessorCompleted:predecessors.reduce((n,value)=>n+value.complete,0),predecessorStatements,remainingBeforeRuntime,
  refusedGroup,remainingAfterRuntime:invocation.remainingQueries,totalStatements:invocation.queriesUsed,
  totalElapsedMs:performance.now()-started,retries,outputHash:await sha256Hex(canonicalJson(expected)),cpuMs:null,peakHeapBytes:null}));
}),120_000);
it('refuses changed canonical capabilities before sealing any original manifest activity heads',async()=>{
 await restore();let measuredTarget:D1Database;
 const result=await run('group',async input=>{measuredTarget=input.budget.meter.wrap(input.target);return captureAnalyticsManifestGroupProof(input);},db=>afterBatch(db,
  sql=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_feature_quantities')),async()=>{
   await measuredTarget.prepare('DROP TRIGGER analytics_canonical_fact_immutable').run();
  }));
 expect(result.progress.complete).toBe(0);expect(result.group!.members.some(member=>member.reason==='migration_required')).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_activity_heads').first<number>('n')).toBe(0);
});
it('cannot adopt or release a member after another claim replaces its original live lease',async()=>{
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
 expect(renewed).toBeTruthy();expect(result.progress.complete).toBe(readyJobs-1);
 const held=await target().prepare('SELECT state,claim_token FROM analytics_partition_work WHERE claim_token=?').bind(renewed!).first();
 expect(held).toEqual({state:'leased',claim_token:renewed});expect(result.progress.releaseDeferred).toBe(0);
});

const hash=(n:number)=>n.toString(16).padStart(64,'0');
function estimate(n:number,overrides:Partial<AnalyticsFeatureGroupEstimate>={}):AnalyticsFeatureGroupEstimate{return {
 workKey:hash(n),headKey:hash(n),stage:'features',sourceId:'synthetic',policyRevision:hash(100),day:'2026-09-20',stream:'usage',selectionMethod:'effective-union-v1',
 partitionKey:'effective-union-v1/usage/2026-09-20/'+n.toString(16).padStart(2,'0'),residentBytes:4*1024*1024,
 refs:[{occurrenceKey:hash(n),revision:hash(n+100)}],scopeKeys:['["synthetic","owner","2026-09-20","usage","effective-union-v1"]'],...overrides};}
it('retains a deterministic compatible subset across hot first leaf, facts/scopes/residency and overlap bounds',()=>{
 const hot=estimate(1,{refs:Array.from({length:17},(_,i)=>({occurrenceKey:hash(i+20),revision:hash(i+120)}))});
 expect(selectAnalyticsFeatureGroup([hot,estimate(2),estimate(3)]).selected).toEqual([hash(2),hash(3)]);
 const four=Array.from({length:4},(_,i)=>estimate(i+1,{scopeKeys:['scope'+i]}));
 expect(selectAnalyticsFeatureGroup([...four,estimate(5,{scopeKeys:['scope4']}),estimate(6)])).toMatchObject({selected:four.map(value=>value.workKey),scopes:4});
 expect(selectAnalyticsFeatureGroup([estimate(1),estimate(2,{partitionKey:estimate(1).partitionKey+'a'})]).selected).toEqual([hash(1)]);
 expect(selectAnalyticsFeatureGroup([estimate(1),estimate(2,{refs:estimate(1).refs})]).selected).toEqual([hash(1)]);
 expect(selectAnalyticsFeatureGroup([estimate(1),estimate(2,{policyRevision:hash(999)})]).selected).toEqual([hash(1)]);
 expect(()=>selectAnalyticsFeatureGroup(Array.from({length:9},(_,i)=>estimate(i+1)))).toThrow('ANALYTICS_WORK_CONTRACT_INVALID');
});
it('reserves full computation and every release without increasing concurrent executors',async()=>{
 const invocation=createD1InvocationBudget(950);invocation.reserveQueries=3;
 const leases=[1,2].map(n=>({contract:'analytics-partition-work-v1' as const,workKey:hash(n),headKey:hash(n),claimToken:'synthetic-claim-0001',
  revision:1,stage:'features' as const,residentBytes:4*1024*1024,admissionQueries:600,expiresAtMs:1000}));
 let executions=0;const released:string[]=[];
 const result=await dispatchAnalyticsFeatureGroup({invocation,deadlineMs:900,now:()=>0,claim:async()=>leases,
  execute:async()=>{executions++;expect(invocation.reserveQueries).toBe(7);return leases.map(lease=>({workKey:lease.workKey,outcome:'complete' as const,admitted:true}));},
  release:async lease=>{released.push(lease.workKey);}});
 expect(result).toMatchObject({groupsAdmitted:1,admitted:2,complete:2});expect(executions).toBe(1);expect(released).toHaveLength(2);expect(invocation.reserveQueries).toBe(3);
 let claimed=false;const blocked=await dispatchAnalyticsFeatureGroup({invocation:createD1InvocationBudget(615),deadlineMs:900,now:()=>0,
  claim:async()=>{claimed=true;return leases;},execute:async()=>[],release:async()=>{}});
 expect(claimed).toBe(false);expect(blocked.claimed).toBe(0);
});
