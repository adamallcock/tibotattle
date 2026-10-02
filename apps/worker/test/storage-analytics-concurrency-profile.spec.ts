import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {type AnalyticsWorkDegree,type AnalyticsWorkLease} from '../src/analytics-partition-work';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {maintainedAnalyticsPolicyRevision} from '../src/storage-analytics-maintained-work';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,completeAnalyticsPartitionWork,
 readAnalyticsPartitionWork,releaseAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage,readEffectiveDependencyAffectedRanges,
 readEffectiveDependencyGlobalChange} from '../src/storage-effective-selective-dependencies';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,
 type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile,
 type AnalyticsProfile} from './helpers/analytics-profile';
import {ANALYTICS_STORE_COLUMNS} from './helpers/analytics-store-inventory';

// This measures actual consumers of an already-ready queue. Source admission,
// coverage, snapshot export/import and diagnostic reads are separately observed
// laboratory setup. It is neither a whole-role benchmark nor capacity evidence.
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-concurrency-profile';
const degrees:readonly AnalyticsWorkDegree[]=[1,2,4,8];
type Stage='canonical'|'features';
const maxTurns=96;
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

function metrics(profile:AnalyticsProfile) {
 const s=summarizeAnalyticsProfile(profile);
 return {statements:s.statements,failedStatements:s.failedStatements,rowsRead:s.rowsRead,rowsWritten:s.rowsWritten,
  databaseMs:s.databaseMs,statementCallWallMs:s.statementCallWallMs,allocatedBatchWallMs:s.allocatedBatchWallMs,
  elapsedMs:profile.invocations?s.wallMs:null,
  maximumStatementsPerInvocation:profile.invocations?s.maximumStatementsPerInvocation:null,
  cpuMs:null,peakHeapBytes:null,unavailableReason:'No isolate CPU/heap observer is attached. SQL duration and wall time are separate.'};
}

function laboratory() {
 const profile=createAnalyticsProfile();let phase='fixture';
 return {profile,setPhase(value:string){phase=value;},
  source:profileAnalyticsDatabase(b.USAGE_MONITOR_DB,'source',profile,()=>phase),
  target:profileAnalyticsDatabase(b.STORAGE_ANALYTICS_DB,'target',profile,()=>phase)};
}
type Lab=ReturnType<typeof laboratory>;
async function readyHeads(lab:Lab,stage:Stage) {
 lab.setPhase('diagnostic_census');
 return await lab.target.prepare(`SELECT count(DISTINCT head_key) n FROM analytics_partition_work
  WHERE source_id=? AND stage=? AND state='ready'`).bind(sourceId,stage).first<number>('n')??0;
}

// The existing exact transfer helper is database-agnostic: it verifies installed
// schema, every typed row, implicit rowids and the exact sorted local SQL export.
// Its internal profiler calls the binding "source"; these receipts identify the
// actual source/target store explicitly. Transport SQL never enters the report.
async function capture() {
 const source=await captureAcceptedSourceTransfer(b.USAGE_MONITOR_DB);
 const target=await captureAcceptedSourceTransfer(b.STORAGE_ANALYTICS_DB);
 return {source:source.transfer,target:target.transfer,receipt:{
  source:{proof:source.transfer.proof,statements:source.profile.statements,elapsedMs:source.wallMs},
  target:{proof:target.transfer.proof,statements:target.profile.statements,elapsedMs:target.wallMs},
  exportResourceMetadata:null,physicalSnapshotBytes:null}};
}
type Snapshot={source:AcceptedSourceTransfer;target:AcceptedSourceTransfer};
async function restore(snapshot:Snapshot) {
 await reset();
 const source=await importAcceptedSourceTransfer(snapshot.source,b.USAGE_MONITOR_DB);
 const target=await importAcceptedSourceTransfer(snapshot.target,b.STORAGE_ANALYTICS_DB);
 expect(source.proof).toEqual(snapshot.source.proof);expect(target.proof).toEqual(snapshot.target.proof);
 return {source:{exactSchemaAndData:source.exactSchemaAndData,exactRowids:source.exactRowids,
   importStatements:source.importProfile.statements,proofStatements:source.proofProfile.statements,elapsedMs:source.wallMs},
  target:{exactSchemaAndData:target.exactSchemaAndData,exactRowids:target.exactRowids,
   importStatements:target.importProfile.statements,proofStatements:target.proofProfile.statements,elapsedMs:target.wallMs},
  exportResourceMetadata:null,physicalSnapshotBytes:null};
}

const semanticQueries={
 facts:'SELECT f.* FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision ORDER BY f.revision',
 heads:'SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key,selection_method',
 variants:'SELECT v.* FROM analytics_canonical_variants v JOIN analytics_canonical_heads h USING(revision) ORDER BY v.revision,v.variant_key',
 days:'SELECT d.* FROM analytics_canonical_days d JOIN analytics_canonical_heads h USING(revision) ORDER BY d.revision,d.day',
 tools:'SELECT t.* FROM analytics_canonical_tools t JOIN analytics_canonical_heads h USING(revision) ORDER BY t.revision,t.tool_class',
 inputDependencies:`SELECT scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,
  owner_revision,authority_epoch,state,seen_count FROM analytics_canonical_input_work ORDER BY scope_key`,
 inputRefs:'SELECT * FROM analytics_partition_graph_input_refs ORDER BY scope_key',
 quantities:'SELECT * FROM analytics_canonical_feature_quantities ORDER BY fact_revision',
 prices:'SELECT * FROM analytics_canonical_feature_prices ORDER BY fact_revision,family,dependency_digest',
 memberships:'SELECT * FROM analytics_canonical_feature_membership ORDER BY fact_revision,dependency_revision',
 activityHeads:'SELECT * FROM analytics_canonical_activity_heads ORDER BY content_revision',
 partitionHeads:'SELECT * FROM analytics_canonical_partition_heads ORDER BY partition_key',
 manifests:`SELECT m.* FROM analytics_canonical_manifests m WHERE EXISTS(
  SELECT 1 FROM analytics_canonical_partition_heads h WHERE h.content_revision=m.content_revision) ORDER BY m.content_revision`,
 manifestRows:`SELECT r.* FROM analytics_canonical_manifest_rows r WHERE EXISTS(
  SELECT 1 FROM analytics_canonical_partition_heads h WHERE h.content_revision=r.content_revision) ORDER BY r.content_revision,r.ordinal`,
 summaries:`SELECT scope_key,source_id,source_namespace,owner_digest,from_day,through_day,include_sessions,
  mutation_stamp,dependency_digest,payload,owner_revision,authority_epoch FROM analytics_effective_dependency_summaries ORDER BY scope_key`,
 cacheInvalidationClock:'SELECT * FROM analytics_canonical_cache_clock ORDER BY id',
} as const;
async function semantics(lab:Lab) {
 lab.setPhase('diagnostic_semantics');
 const exact:Record<string,string>={},receipt:Record<string,{rows:number;sha256:string}>={};
 for(const [family,sql] of Object.entries(semanticQueries)) {
  const rows=(await lab.target.prepare(sql).all()).results;
  exact[family]=canonicalJson(rows);receipt[family]={rows:rows.length,sha256:await digest(rows)};
 }
 // Queue/lease clocks and memo expiry are operational, deliberately outside this
 // component's semantic comparison. No analytical/publication time is normalized.
 return {exact,receipt};
}
async function publicationState(lab:Lab) {
 lab.setPhase('diagnostic_publication');
 const tables=Object.keys(ANALYTICS_STORE_COLUMNS.target).filter(name=>name.includes('publication')
  ||name.includes('preview')||name.includes('checkpoint')||name==='analytics_community_daily_heads'
  ||name==='analytics_community_daily_owners'||name==='analytics_community_daily_queue'
  ||name==='analytics_community_graph_results'
  ||name==='analytics_canonical_cache_window_heads'||name==='analytics_pipeline_runtime');
 const exact:Record<string,string>={};
 for(const table of tables) {
  // Full rows, including timestamps, are retained exactly. Sorting serialized
  // rows only establishes deterministic row order for tables with different PKs.
  exact[table]=canonicalJson((await lab.target.prepare(`SELECT * FROM ${quote(table)}`).all()).results
   .map(row=>canonicalJson(row)).sort());
 }
 // Canonical effects advance revision through the actual cache invalidation
 // trigger. Its full value is compared by degree in semantics; the publication
 // CAS marker and all released output rows must remain unchanged here.
 exact.cachePublicationCas=canonicalJson((await lab.target.prepare('SELECT id,expected_revision FROM analytics_canonical_cache_clock ORDER BY id').all()).results);
 exact.publicationQueue=canonicalJson((await lab.target.prepare("SELECT * FROM analytics_partition_work WHERE stage='publication' ORDER BY work_key").all()).results);
 return exact;
}

interface Claims {heads:Set<string>;owners:Set<string>;byLane:Record<string,number>;duplicateHeads:number}
/** Observe actual claim results without mocks, extra runtime SQL, a retained spy
 * history or changes to the underlying prepared/batch operation. */
function observeClaims(database:D1Database,claims:Claims,blockedHead?:string):D1Database {
 const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
  const proxy=new Proxy(statement,{get(inner,key){
   if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql);
   if(key==='first'&&/^UPDATE analytics_partition_work SET state='leased'/u.test(sql))return async(...args:unknown[])=>{
    const row=await Reflect.apply(inner.first,inner,args) as Record<string,unknown>|null;
    if(row) {
     if(typeof row.head_key!=='string'||typeof row.lane!=='string')throw new Error('claim observation shape changed');
     if(claims.heads.has(row.head_key))claims.duplicateHeads++;
     claims.heads.add(row.head_key);claims.byLane[row.lane]=(claims.byLane[row.lane]??0)+1;
     if(typeof row.owner_digest==='string')claims.owners.add(row.owner_digest);
     if(blockedHead!==undefined&&row.head_key===blockedHead)throw new Error('live head was claimed concurrently');
    }
    return row;
   };
   const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
  }});
  originals.set(proxy,statement);return proxy;
 };
 return new Proxy(database,{get(inner,key){
  if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(key==='batch')return(statements:D1PreparedStatement[])=>inner.batch(statements.map(statement=>{
   const original=originals.get(statement);if(!original)throw new Error('foreign observed batch statement');return original;
  }));
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
}

async function wave(stage:Stage,degree:AnalyticsWorkDegree,blockedHead?:string) {
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950);
 const claims:Claims={heads:new Set(),owners:new Set(),byLane:{},duplicateHeads:0};
 const source=profileAnalyticsDatabase(b.USAGE_MONITOR_DB,'source',profile,()=>stage);
 const target=observeClaims(profileAnalyticsDatabase(b.STORAGE_ANALYTICS_DB,'target',profile,()=>stage),claims,blockedHead);
 const started=performance.now();
 const progress=await runCanonicalAnalyticsWorkPass({source,target,sourceId,sourceNamespace:sourceId,
  invocation,now:Date.now,deadlineMs:Date.now()+60_000,degree,maxWaves:1,stages:[stage],bridge:false});
 profile.wallMs=performance.now()-started;profile.invocations=1;profile.maximumStatementsPerInvocation=invocation.queriesUsed;
 const measured=metrics(profile);
 const sourceRowsWritten=Object.entries(profile.costs).filter(([key])=>key.includes('.source.'))
  .reduce((total,[,cost])=>total+cost.rowsWritten,0);
 expect(measured.statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 expect(progress.failed).toBe(0);expect(progress.releaseDeferred).toBe(0);expect(measured.failedStatements).toBe(0);
 expect(sourceRowsWritten).toBe(0);
 expect(claims.heads.size).toBe(progress.claimed);expect(claims.duplicateHeads).toBe(0);
 expect(progress.admitted).toBeLessThanOrEqual(stage==='features'?1:Math.min(degree,5));
 return {configuredDegree:degree,stage,...progress,...measured,elapsedMs:profile.wallMs,
  maximumStatementsPerInvocation:invocation.queriesUsed,sourceRowsWritten,claimedHeadCollisions:claims.duplicateHeads,
  claimedOwnerSubjects:claims.owners.size,claimedByLane:claims.byLane,
  headCollisionDeferrals:null,deferralReasonGap:'Runtime aggregate deferrals do not expose individual admission causes.'};
}
async function drain(lab:Lab,stage:Stage,degree:AnalyticsWorkDegree,blockedHead?:string) {
 const waves:Awaited<ReturnType<typeof wave>>[]=[];
 for(let n=0;n<maxTurns;n++) {
  lab.setPhase('diagnostic_census');
  const runnable=await lab.target.prepare(`SELECT count(*) n FROM analytics_partition_work
   WHERE source_id=? AND stage=? AND state IN('ready','leased') AND (? IS NULL OR head_key!=?)`)
   .bind(sourceId,stage,blockedHead??null,blockedHead??null).first<number>('n')??0;
  if(!runnable)break;
  waves.push(await wave(stage,degree,blockedHead));
 }
 const remaining=await lab.target.prepare(`SELECT count(*) n FROM analytics_partition_work
  WHERE source_id=? AND stage=? AND state IN('ready','leased') AND (? IS NULL OR head_key!=?)`)
  .bind(sourceId,stage,blockedHead??null,blockedHead??null).first<number>('n')??0;
 const receipt={stage,configuredDegree:degree,waves:waves.length,remaining,
  claimed:waves.reduce((n,x)=>n+x.claimed,0),admitted:waves.reduce((n,x)=>n+x.admitted,0),
  completed:waves.reduce((n,x)=>n+x.complete,0),deferred:waves.reduce((n,x)=>n+x.deferred,0),
  refused:waves.reduce((n,x)=>n+x.refused,0),maximumAdmitted:Math.max(0,...waves.map(x=>x.admitted)),
  elapsedMs:waves.reduce((n,x)=>n+x.elapsedMs,0),statements:waves.reduce((n,x)=>n+x.statements,0),
  rowsRead:waves.reduce((n,x)=>n+x.rowsRead,0),rowsWritten:waves.reduce((n,x)=>n+x.rowsWritten,0),
  databaseMs:waves.reduce((n,x)=>n+x.databaseMs,0),maximumStatementsPerInvocation:Math.max(0,...waves.map(x=>x.statements)),
  claimedHeadCollisions:waves.reduce((n,x)=>n+x.claimedHeadCollisions,0),cpuMs:null,peakHeapBytes:null,waveReceipts:waves};
 // Emit bounded content-free evidence before a meaningful convergence failure.
 console.info('G04 actual stage measurement',JSON.stringify(receipt));
 expect(remaining,JSON.stringify({stage,degree,lastWaves:waves.slice(-3)})).toBe(0);
 expect(receipt.completed).toBeGreaterThan(0);
 return receipt;
}

async function seed(lab:Lab) {
 lab.setPhase('fixture');
 await initializeSharedAnalyticsCorpusDatabases(lab.source,lab.target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:lab.source,target:lab.target,sourceId,sourceNamespace:sourceId,
  calendarDays:14,graphDays:2,denseDays:true,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 let covered=false;
 for(let n=0;n<32;n++) {
  const meter=createD1InvocationBudget(950);
  const progress=await advanceEffectiveDependencyCoverage(meter.wrap(lab.source),{sourceId,sourceNamespace:sourceId,
   maxSteps:64,maxRows:128,budget:meter});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(progress.status==='complete'){covered=true;break;}
 }
 expect(covered).toBe(true);
 // Only these eight genuine accepted scopes are scheduled here. Unrepresented
 // source effects/global change remain pending. bridge:false below separates
 // targeted consumer scheduling from full source delivery/publication closure.
 const pendingSourceRanges=(await readEffectiveDependencyAffectedRanges(lab.source,128)).length;
 const pendingGlobalChange=(await readEffectiveDependencyGlobalChange(lab.source))!==undefined;
 const policyRevision=await maintainedAnalyticsPolicyRevision(),requests:AnalyticsWorkRequest[]=[];
 // Keep the light phase clear of the corpus's separate sixty-bin model-fit
 // start dates; every chosen date still has genuine accepted dense-day usage.
 const selectedDays=corpus.historyDates.filter(day=>!corpus.modelFitDates.includes(day)).slice(0,8);
 expect(selectedDays).toHaveLength(8);
 for(const day of selectedDays) {
  const partitionKey='input/'+await digest([sourceId,corpus.owner.ownerDigest,day,'usage','effective-union-v1']);
  requests.push({sourceId,ownerDigest:corpus.owner.ownerDigest,stage:'canonical',lane:'new',partitionKey,
   headKey:await digest(['canonical',partitionKey]),inputRevision:await digest(['synthetic-ready-scope',partitionKey]),
   policyRevision,day,stream:'usage',selectionMethod:'effective-union-v1',residentBytes:4*1024*1024,admissionQueries:160});
 }
 await admitAnalyticsPartitionWork(lab.target,requests);
 expect(await readyHeads(lab,'canonical')).toBe(8);
 return {calendarDays:14,denseDays:true,denseUsageRows:0,canonicalReadyHeads:8,
  pendingSourceRanges,pendingGlobalChange,sourceEffectsAcknowledgedByFixture:0,writerDegree:1};
}

it('G04 compares actual canonical and heavy feature waves from identical ready snapshots at degrees1/2/4/8',async()=>{
 await reset();const setupLab=laboratory(),setupStarted=performance.now();
 const fixture=await seed(setupLab);
 const setupReceipt={...metrics(setupLab.profile),elapsedMs:performance.now()-setupStarted};
 const canonicalSnapshot=await capture();
 const phases:Record<string,unknown>={};let canonicalBaseline:Awaited<ReturnType<typeof semantics>>|undefined;
 let canonicalComplete:Awaited<ReturnType<typeof capture>>|undefined;
 for(const degree of degrees) {
  const imported=await restore(canonicalSnapshot),lab=laboratory(),before=await publicationState(lab);
  expect(await readyHeads(lab,'canonical')).toBe(8);
  const measured=await drain(lab,'canonical',degree),semantic=await semantics(lab);
  expect(semantic.receipt.heads!.rows).toBeGreaterThanOrEqual(8);
  if(canonicalBaseline)expect(semantic.exact).toEqual(canonicalBaseline.exact);else canonicalBaseline=semantic;
  expect(await publicationState(lab)).toEqual(before);
  expect((await lab.target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  phases['canonical/'+degree]={imported,measured,semantics:semantic.receipt,laboratoryDiagnostics:metrics(lab.profile)};
  if(degree===1)canonicalComplete=await capture();
 }
 expect(canonicalComplete).toBeDefined();
 await restore(canonicalComplete!);const heavyLab=laboratory();
 for(let n=0;n<32;n++) {
  const meter=createD1InvocationBudget(950);
  await advanceAnalyticsWorkEffects({source:heavyLab.source,target:heavyLab.target,sourceId,sourceNamespace:sourceId,
   meter,now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:4});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  const outstanding=await heavyLab.target.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n');
  if(outstanding===0&&await readyHeads(heavyLab,'features')>=8)break;
 }
 const heavyHeads=await readyHeads(heavyLab,'features');expect(heavyHeads).toBeGreaterThanOrEqual(8);
 // The real bridge can also represent previously pending source ranges and
 // admit unrelated canonical work. Preserve it; the features-only phase must
 // not execute or alter those queued canonical rows.
 const heavyCanonicalRows=canonicalJson((await heavyLab.target.prepare("SELECT * FROM analytics_partition_work WHERE stage='canonical' ORDER BY work_key").all()).results);
 const heavySnapshot=await capture();let heavyBaseline:Awaited<ReturnType<typeof semantics>>|undefined;
 for(const degree of degrees) {
  const imported=await restore(heavySnapshot),lab=laboratory(),before=await publicationState(lab);
  expect(await readyHeads(lab,'features')).toBe(heavyHeads);
  const measured=await drain(lab,'features',degree),semantic=await semantics(lab);
  expect(measured.maximumAdmitted).toBe(1);expect(semantic.receipt.quantities!.rows).toBeGreaterThan(0);
  if(heavyBaseline)expect(semantic.exact).toEqual(heavyBaseline.exact);else heavyBaseline=semantic;
  expect(await publicationState(lab)).toEqual(before);
  expect(canonicalJson((await lab.target.prepare("SELECT * FROM analytics_partition_work WHERE stage='canonical' ORDER BY work_key").all()).results)).toBe(heavyCanonicalRows);
  expect(await lab.target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage IN('activity','cache') AND state='ready'").first<number>('n')).toBeGreaterThan(0);
  expect((await lab.target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  phases['features/'+degree]={imported,measured,semantics:semantic.receipt,laboratoryDiagnostics:metrics(lab.profile)};
 }

 // A real pending replay of the same accepted scope has a distinct work key but
 // shares the held head. It must stay ready while the other real scopes execute.
 // Its scheduling token is synthetic, as in the eight initial requests. The
 // actual consumer rereads native source authority when the replay executes.
 const controlImport=await restore(canonicalSnapshot),controlLab=laboratory(),claimMeter=createD1InvocationBudget(950);
 const [held]=await claimAnalyticsPartitionWork(claimMeter.wrap(controlLab.target),{sourceId,limit:1,nowMs:Date.now(),leaseMs:300_000,stages:['canonical']});
 expect(held).toBeDefined();
 const heldWork=await readAnalyticsPartitionWork(claimMeter.wrap(controlLab.target),held!,Date.now());
 expect(heldWork).not.toBeNull();
 const {workKey:_workKey,attempts:_attempts,...request}=heldWork!;
 const [replayKey]=await admitAnalyticsPartitionWork(claimMeter.wrap(controlLab.target),
  [{...request,inputRevision:await digest(['synthetic-pending-scope-replay',request.inputRevision])}]);
 expect(replayKey).not.toBe(held!.workKey);
 const leaseState=(lab:Lab,lease:AnalyticsWorkLease)=>lab.target.prepare(`SELECT state,revision,claim_token,claim_expires_ms
  FROM analytics_partition_work WHERE work_key=?`).bind(lease.workKey).first();
 const heldState=await leaseState(controlLab,held!);
 const control=await drain(controlLab,'canonical',8,held!.headKey);
 expect(await leaseState(controlLab,held!)).toEqual(heldState);
 expect(await controlLab.target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(replayKey).first<string>('state')).toBe('ready');
 const releaseMeter=createD1InvocationBudget(950);
 expect(await releaseAnalyticsPartitionWork(releaseMeter.wrap(controlLab.target),held!,'deferred',Date.now())).toBe(true);
 await drain(controlLab,'canonical',1);
 expect((await semantics(controlLab)).exact).toEqual(canonicalBaseline!.exact);
 expect((await controlLab.target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

 // Restore the original eight-job snapshot for an independent same-work-key
 // stale handle check. Claiming all distinct heads finds the real renewed lease
 // without modifying fairness order, deadlines, claim tokens or queue rows.
 const staleImport=await restore(canonicalSnapshot),staleLab=laboratory(),renewMeter=createD1InvocationBudget(950);
 const staleDb=renewMeter.wrap(staleLab.target);
 const [original]=await claimAnalyticsPartitionWork(staleDb,{sourceId,limit:1,nowMs:Date.now(),stages:['canonical']});
 expect(original).toBeDefined();
 expect(await releaseAnalyticsPartitionWork(staleDb,original!,'deferred',Date.now())).toBe(true);
 const renewedLeases=await claimAnalyticsPartitionWork(staleDb,{sourceId,limit:8,nowMs:Date.now(),stages:['canonical']});
 const renewed=renewedLeases.find(lease=>lease.workKey===original!.workKey);expect(renewed).toBeDefined();
 expect(renewed!.claimToken).not.toBe(original!.claimToken);
 const current=await leaseState(staleLab,renewed!),staleMeter=createD1InvocationBudget(950),db=staleMeter.wrap(staleLab.target);
 expect(await completeAnalyticsPartitionWork(db,original!,[],Date.now())).toBe(false);
 expect(await releaseAnalyticsPartitionWork(db,original!,'complete',Date.now())).toBe(false);
 expect(await leaseState(staleLab,renewed!)).toEqual(current);
 for(const lease of renewedLeases)expect(await releaseAnalyticsPartitionWork(db,lease,'deferred',Date.now())).toBe(true);
 await drain(staleLab,'canonical',1);
 expect((await semantics(staleLab)).exact).toEqual(canonicalBaseline!.exact);
 expect((await staleLab.target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 console.info('G04 concurrency component receipt',JSON.stringify({schemaVersion:'actual-stage-concurrency-v1',fixture,
  setup:setupReceipt,snapshots:{canonical:canonicalSnapshot.receipt,features:heavySnapshot.receipt},
  heavyBridgeLaboratory:metrics(heavyLab.profile),phases,liveHeadControl:{...control,imported:controlImport,blockedReadyReplays:1,
   claimStatements:claimMeter.queriesUsed,releaseStatements:releaseMeter.queriesUsed,laboratoryDiagnostics:metrics(controlLab.profile)},
  staleLeaseControl:{imported:staleImport,staleCompletion:false,staleRelease:false,renewStatements:renewMeter.queriesUsed,
   staleCheckStatements:staleMeter.queriesUsed,laboratoryDiagnostics:metrics(staleLab.profile)},
  withdrawalFairnessQualified:false,withdrawalFairnessGap:'This bounded ready-source component has no actual withdrawn source input.',
  contract:'Each wave uses one actual950 statement meter, production32MiB residency and2-query release reserves; feature600 and canonical160 reservations are unchanged. Only canonical/features consumers execute. Publication writer remains1 and full publication/control rows stay exact. Setup/import/proof/diagnostic SQL is separate laboratory work. No CPU, true peak heap, parallel-primary SQL, backend capacity, whole-role speedup or H04 claim.'}));
},240_000);
