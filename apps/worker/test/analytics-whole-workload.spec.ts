import {c06IndependentReviewPolicy} from './helpers/analytics-c06-independent-policy';
import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as native from './helpers/analytics-native-reference';
import * as candidate from './helpers/analytics-candidate';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
import { createWholeWorkloadMeter, summarizeWholeWorkload, validateWholeWorkloadPublicationTimes, PUBLICATION_TIMESTAMP_CONTRACT, WHOLE_WORKLOAD_CASES, wholeWorkloadGraphPopulation,wholeWorkloadRoleEnvironment,completeBoundedWholeWorkloadRequest,WHOLE_WORKLOAD_ROLE_FAILURE_POLICY,encodeWholeWorkloadValue,wholeWorkloadOptimizationProfile,wholeWorkloadDailyPopulation,advanceNativeWholeWorkloadGraph,wholeWorkloadSourceConsumer,wholeWorkloadConsumerCompleted,createWholeWorkloadSourceDiagnostic,WHOLE_WORKLOAD_C06_PHASES,type WholeWorkloadSourceConsumer } from './helpers/analytics-whole-workload';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile, installAnalyticalDecodeCounter } from './helpers/analytics-profile';
import {snapshotLogicalStores,type LogicalStoreSnapshot} from './helpers/analytics-logical-bytes';
import {copyAcceptedAnalyticsSource,SOURCE_SNAPSHOT_CONTRACT,captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {proveFunctionalAuthorityLag,expireFunctionalGraphLease} from './helpers/analytics-functional-boundaries';
import {startFunctionalActionPreviewTrace,assertFunctionalActionPreviewStartup,type FunctionalActionPreviewCheckpoint} from './helpers/analytics-functional-action-trace';
import {replayFunctionalTerminalLedger,replayFunctionalDuplicateDelivery,interruptFunctionalV11Delivery,revokeFunctionalDevices,withdrawFunctionalAccountlessOwner,optOutFunctionalAccountlessOwner,eraseFunctionalParticipant} from './helpers/analytics-functional-scenarios';
import {validateRetainedFunctionalPublicationTimes,type FunctionalPublicationRows,RETAINED_FUNCTIONAL_CLOCK_CONTRACT} from './helpers/analytics-retained-functional-clock';
import {captureCompletedFunctionalBase,captureFunctionalTerminalLedgerBase,startFunctionalBranch,assertFunctionalExpectedOwners,planFunctionalBranchPopulation,assertFunctionalPublicationPair} from './helpers/analytics-functional-branches';
import {createC06PhaseEvidenceRecorder,acceptedC06SourceReceiptSha256,runC06IndependentReview,type C06PhaseProvenance} from './helpers/analytics-c06-phase-evidence';
import {c06SourceLineageObserver,C06_CONSUMERS} from './helpers/analytics-c06-source-lineage';
import {c06ScopeSource,c06ScopeConsumer,C06_DATABASE_SCOPE,C06_OPERATION_SCOPES,type C06OperationScope} from './helpers/analytics-c06-operation-scope';
import {createNativePreviewCounter,createNativePreviewActionGuard,type NativePreviewCounterProof,NATIVE_PREVIEW_COUNTER_CONTRACT} from './helpers/analytics-preview-counter';
import {applyPairedFunctionalNativeInput} from './helpers/analytics-functional-input-scenarios';
import type {FunctionalNativeKind,FunctionalNativeAdmission} from './helpers/analytics-functional-native-input';
import {executePairedNativeMutation} from './helpers/analytics-mutation-replay';
import {canonicalRollingSqlProfile} from './helpers/canonical-rolling-profile';
import {createAnalyticsPerformanceHistogram,createAnalyticsRoleOutcomeHistogram} from './helpers/analytics-performance-histogram';
import type { StorageCommunityOwner } from '../src/storage-community-authority';
import type { CacheRetentionDayCandidate, CacheRetentionDayWriteCursor } from '../src/cache-retention-day';
import type { CacheRetentionDayAggregate } from '../src/cache-retention-values';

type Kernel=typeof native;
type Owner=StorageCommunityOwner&{ownerDigest:string};
type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;
  STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;STORAGE_ROUTING_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const b=env as Bindings;
const settings=(import.meta as ImportMeta&{env?:Record<string,string>}).env??{};
const enabled=settings.VITE_WHOLE_WORKLOAD==='enabled';
const compare=settings.VITE_WHOLE_WORKLOAD_COMPARE==='enabled';
const upgradeSource=settings.VITE_WHOLE_WORKLOAD_SOURCE_UPGRADE==='enabled';
const functionalMutations=settings.VITE_WHOLE_WORKLOAD_FUNCTIONAL_MUTATIONS==='enabled';
const functionalBranches=(settings.VITE_WHOLE_WORKLOAD_FUNCTIONAL_BRANCHES??'').split(',').filter(Boolean);
const nativeInputKinds=['timestamp_move','cross_day_move','quota_change','plan_change','equal_time_tie','empty_day_replacement','same_occurrence_total_repair'] as const;
const functionalAccountlessSecondary=settings.VITE_WHOLE_WORKLOAD_FUNCTIONAL_ACCOUNTLESS_SECONDARY==='enabled';
const integrationDebugDays=Number(settings.VITE_WHOLE_WORKLOAD_INTEGRATION_DEBUG_DAYS??'0');
const calendarDays=integrationDebugDays||466;
const sharedSeedScale=settings.VITE_WHOLE_WORKLOAD_SCALE_MATRIX==='enabled';
const sharedSeedProof=settings.VITE_WHOLE_WORKLOAD_SHARED_SEED_PROOF??'';
const graphDays=integrationDebugDays?calendarDays-8:70;
const outputCount=Number(settings.VITE_WHOLE_WORKLOAD_DATES??'1');
const preparationLimit=Number(settings.VITE_WHOLE_WORKLOAD_PREPARATION_LIMIT??'4000');
const publicationLimit=integrationDebugDays?preparationLimit:4000;
const coverageOnly=settings.VITE_WHOLE_WORKLOAD_COVERAGE_ONLY==='enabled';
const traceSql=settings.VITE_WHOLE_WORKLOAD_SQL_PROFILE==='enabled';
const sourceLineageEnabled=settings.VITE_WHOLE_WORKLOAD_SOURCE_LINEAGE==='enabled';
if(functionalAccountlessSecondary&&!functionalBranches.length)throw Error('FUNCTIONAL_ACCOUNTLESS_STARTUP_REQUIRES_BRANCHES');
if(functionalBranches.some(name=>['withdrawal','opt_out_retained'].includes(name))&&!functionalAccountlessSecondary)throw Error('FUNCTIONAL_WITHDRAWAL_REQUIRES_ACCOUNTLESS');
if(traceSql&&functionalBranches.some(name=>!WHOLE_WORKLOAD_CASES.includes(name)))throw Error('FUNCTIONAL_SQL_PROFILE_PHASE_UNSUPPORTED');
const nativeProfile=(settings.VITE_WHOLE_WORKLOAD_NATIVE_PROFILE??'optimized') as 'optimized'|'unshared-diagnostic';
const phases=(settings.VITE_WHOLE_WORKLOAD_PHASES??'cold,warm,no_op').split(',');
const sourceId='synthetic-p11-whole-workload',sourceNamespace=sourceId;
const freshLane=settings.VITE_WHOLE_WORKLOAD_LANE as 'seed'|'reference'|'candidate'|undefined;
const nowMs=Number(settings.VITE_WHOLE_WORKLOAD_ANALYTICAL_NOW??Date.now()),DAY_MS=86_400_000;
if(sharedSeedScale&&preparationLimit!==400)throw Error('SHARED_SEED_SCALE_PREPARATION_BOUND');
if(sharedSeedScale&&(!compare||!upgradeSource||integrationDebugDays||calendarDays!==466||functionalMutations||functionalBranches.length||phases.join(',')!=='cold,warm,no_op'||!['seed','reference','candidate'].includes(freshLane??'')))throw Error('SHARED_SEED_SCALE_MODE');
if(sharedSeedScale&&freshLane!=='seed'&&!/^[a-f0-9]{64}$/u.test(sharedSeedProof))throw Error('SHARED_SEED_SCALE_PROOF');
async function transferLaboratory(message:Record<string,unknown>) {
 const endpoint=settings.VITE_WHOLE_WORKLOAD_TRANSFER_URL;
 if(!endpoint||!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/u.test(endpoint))throw new Error('missing loopback laboratory transfer');
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...message,lane:freshLane})});
 const value=await response.json() as {acknowledged?:boolean;seed?:AcceptedSeed};
 if(!response.ok||value.acknowledged!==true)throw new Error('laboratory transfer ACK unavailable');return value;
}
interface AcceptedSeed {transfer:AcceptedSourceTransfer;historyDates:string[];analyticalNowMs:number;}

const today=new Date(nowMs).toISOString().slice(0,10);
const initialAnalyticalNowMs=nowMs,operationalStartDay=new Date(Date.now()).toISOString().slice(0,10);
const date=(value:number)=>new Date(value).toISOString().slice(0,10);

const dayBefore=(day:string,days:number)=>date(Date.parse(day+'T00:00:00.000Z')-days*DAY_MS);
async function checkpointProfile<T extends {c06SourceLineage?:unknown}>(profile:T){
 if(!profile.c06SourceLineage)return profile;
 const census=profile.c06SourceLineage as {contract:string;status:string;noRescanQualified:boolean;expectedSourceCalls:number;diagnostics:unknown};
 return {...profile,c06SourceLineage:{contract:census.contract,status:census.status,noRescanQualified:census.noRescanQualified,
  expectedSourceCalls:census.expectedSourceCalls,diagnostics:census.diagnostics,fullReceiptSha256:await sha256Hex(canonicalJson(census)),completeCensusLocation:'final-functional-receipt'}};
}


async function runLane(kernel:Kernel,source:D1Database,target:D1Database,ledger:D1Database,dates:readonly string[],canonical:boolean,cacheDates:readonly string[]=dates,workloadPhase='cold',options:{c06Provenance?:C06PhaseProvenance;analyticalNowMs?:number;expectedOwnerDigests?:readonly string[];actionPreviewCheckpoint?:FunctionalActionPreviewCheckpoint;priorPublication?:{output:unknown;rows:FunctionalPublicationRows;analyticalNowMs:number}}={}) {
  const nowMs=options.analyticalNowMs??initialAnalyticalNowMs;
  if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isFinite(new Date(nowMs).getTime()))throw Error('Invalid scenario analytical clock');
  const today=new Date(nowMs).toISOString().slice(0,10);
  if(new Date(Date.now()).toISOString().slice(0,10)!==operationalStartDay)throw new Error('workload crossed operational UTC day');
  kernel.setAnalyticsWorkloadPublicationClock(nowMs);
  const optimization=wholeWorkloadOptimizationProfile(canonical?'canonical':'native',nativeProfile);
  let sourceConsumer:WholeWorkloadSourceConsumer='fixture',graphMetric:'fits'|'model'|undefined;
  const sourceLineage=sourceLineageEnabled&&(WHOLE_WORKLOAD_C06_PHASES as readonly string[]).includes(workloadPhase)?c06SourceLineageObserver(source,()=>({consumer:sourceConsumer,phase:workloadPhase}),{allowedPhases:WHOLE_WORKLOAD_C06_PHASES,bindingEvidence:true}):null;
  const sourceDiagnostics=sourceLineage?createWholeWorkloadSourceDiagnostic(source):null;
  const c06Evidence=sourceLineage?createC06PhaseEvidenceRecorder(()=>sourceLineage.snapshotCounters()):null;
  let operationScopeFailures=0;
  const fixedSourceScope:typeof c06ScopeSource=(database,scope)=>{
    if(Reflect.get(database,C06_DATABASE_SCOPE)!==true){operationScopeFailures++;throw Error('C06_PRODUCER_SOURCE_MARKER_ABSENT');}
    return c06ScopeSource(database,scope,{onFailure:()=>{operationScopeFailures++;}});
  };
  const installC06Scope=(kernel as Kernel&{installAnalyticsC06ScopeSource?:(scope:typeof c06ScopeSource|null)=>void}).installAnalyticsC06ScopeSource;
  if(sourceLineageEnabled&&canonical&&typeof installC06Scope!=='function')throw Error('C06_PRODUCER_BOUNDARY_ABSENT');
  const installBlockCompletion=kernel.installAnalyticsC06BlockCompletion;
  let blockCompletions=0,blockCompletionFailures=0;
  const blockCompletion=(event:import('./helpers/analytics-workload-kernels').AnalyticsC06BlockCompletion)=>{
    if(!event||Object.keys(event).sort().join(',')!=='adoptedDates,day,metric,queriesUsed,reused,state'
      ||event.state!=='complete'||event.metric!=='model'||typeof event.reused!=='boolean'
      ||!/^\d{4}-\d{2}-\d{2}$/u.test(event.day)||!Number.isFinite(Date.parse(event.day+'T00:00:00Z'))
      ||new Date(event.day+'T00:00:00Z').toISOString().slice(0,10)!==event.day||event.day>=today
      ||!Number.isSafeInteger(event.adoptedDates)||event.adoptedDates<0||event.adoptedDates>32
      ||!Number.isSafeInteger(event.queriesUsed)||event.queriesUsed<0||event.queriesUsed>950||blockCompletions>=20000){
      blockCompletionFailures++;throw Error('C06_BLOCK_COMPLETION_CONTRACT');}
    blockCompletions++;completedConsumers.set('block',(completedConsumers.get('block')??0)+1);
  };
  if(sourceLineage&&canonical&&typeof installBlockCompletion!=='function')throw Error('C06_BLOCK_COMPLETION_BOUNDARY_ABSENT');
  const operationSourceCalls=Object.fromEntries(C06_OPERATION_SCOPES.map(scope=>[scope,0])) as Record<C06OperationScope,number>;
  const sourceCalls=Object.fromEntries(C06_CONSUMERS.map(name=>[name,0])) as Record<WholeWorkloadSourceConsumer,number>;
  const completedConsumers=new Map<Exclude<WholeWorkloadSourceConsumer,'fixture'|'unclassified'>,number>();
  let sourceLineageReport:unknown=null;
  const diagnosticSql=traceSql?canonicalRollingSqlProfile(()=>canonical?'candidate':'reference'):null;
  const performanceHistogram=traceSql?createAnalyticsPerformanceHistogram({lane:canonical?'candidate':'reference',workloadPhase}):null;
  const roleOutcomes=traceSql?createAnalyticsRoleOutcomeHistogram():null;
  const previewCounter=functionalBranches.length?createNativePreviewCounter(sourceId):null;
  let previewCounterProof:NativePreviewCounterProof|null=null;
  const observedSource=sourceLineage?.source??source;
  const measured=createWholeWorkloadMeter(diagnosticSql?diagnosticSql.wrap(observedSource,'source'):observedSource,diagnosticSql?diagnosticSql.wrap(target,'target'):target,canonical?db=>({...db,source:candidate.withMaintainedEffectiveDependencies(db.source,db.target,sourceId,sourceNamespace)}):undefined,canonical?candidate.createD1InvocationBudget:undefined,ledger,performanceHistogram||sourceLineage?row=>{
    performanceHistogram?.observe(row);roleOutcomes?.observe(row);c06Evidence?.observe(row);if(sourceLineage&&row.side==='source'){sourceCalls[row.operationScope?c06ScopeConsumer(row.operationScope):sourceConsumer]++;operationSourceCalls[row.operationScope??'unclassified']++;}
  }:undefined,previewCounter??undefined);let started=performance.now();
  const logicalStoreSnapshots:Record<string,Record<string,LogicalStoreSnapshot>>={};
  const snapshot=async(label:string)=>{
    measured.setPhase('logical_inventory');
    logicalStoreSnapshots[label]=await measured.invocation('logical_inventory_'+label,async(db,_meter,ledger)=>{
      if(!ledger)throw new Error('logical inventory requires physical ledger');
      return {source:await snapshotLogicalStores(db.source,'source'),target:await snapshotLogicalStores(db.target,'target'),ledger:await snapshotLogicalStores(ledger,'ledger')};
    });
  };
  const graphPopulation=wholeWorkloadGraphPopulation(today,dates);
  const calculatedModelDates=compare?graphPopulation.calculatedModelDates:dates;
  const publicModelDates=compare?graphPopulation.retainedModelDates:dates.filter(day=>day>=dayBefore(today,69)&&day<today);
  const modelOutcomeCounts:Record<string,number>={};
  let actualStoredPopulation:Record<string,unknown>|null=null;
  const dailyPublicationInventory:unknown[]=[];
  let publicationRows:FunctionalPublicationRows|null=null;
  const output:{publishedDaily:unknown[];daily:unknown[];ownerModels:unknown[];currentScalar:unknown[];
    modelPublications:unknown[];preview:unknown;cacheDays:unknown[];cacheSeries:unknown}=
    {publishedDaily:[],daily:[],ownerModels:[],currentScalar:[],modelPublications:[],preview:null,cacheDays:[],cacheSeries:null};
  const bindings=(db:{source:D1Database;target:D1Database})=>({...db,sourceId,sourceNamespace});
  let lastCandidateAttempt:number|null=null,laneCompleted=false;
  let observerStarted=false,observerUnavailable=false,runtimeObservation:unknown=null,lastBoundary='lane_initialization';
  const runtimeSegments:Record<string,unknown>[]=[],runtimeGaps:Record<string,unknown>[]=[];
  let segmentInvocations=0,segmentStarted=0;
  const observationSummary=()=>{
    const ids=runtimeSegments.map(segment=>(segment.result as {identity?:{isolateId?:string}})?.identity?.isolateId);
    if(ids.some(id=>id!==ids[0]))throw new Error('runtime segment isolate changed');
    return {lane:canonical?'candidate':'reference',phase:workloadPhase,basis:freshLane?'fresh-worker-lane-segments-v1':'shared-vitest-isolate-phase-diagnostic-v1',
      comparativeHeapQualification:false,isolateId:ids[0]??null,segments:runtimeSegments,gaps:runtimeGaps,
      complete:runtimeGaps.length===0&&runtimeSegments.length>0&&runtimeSegments.every(segment=>(segment.result as {complete?:boolean})?.complete===true),
      maximumInvocationsPerRecording:60,rotateAfterWallMs:15_000,
      contract:'Separate Profiler recordings around complete metered invocations. Segment stop/start, HTTP/inspector barriers, gaps and startup overhead are explicit; missing time is not filled as CPU. No forced GC; heap values are observations, not true peak.',
      exactWorkerCpuMs:null,billedWorkerCpuMs:null,truePeakIsolateHeapBytes:null,physicalWireBytes:null};
  };
  const runtimeBarrierWallMs:Record<string,number>={};
  const observe=async(kind:'start'|'stop')=>{
    const url=settings.VITE_WHOLE_WORKLOAD_OBSERVER_URL;if(!url)return;
    if(!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/u.test(url))throw new Error('runtime observer must be explicit loopback');
    const barrierStarted=performance.now();
    try {
    lastBoundary='observer_'+kind+'_fetch';
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,lane:canonical?'candidate':'reference',phase:workloadPhase})});
    lastBoundary='observer_'+kind+'_response';
    const result=await response.json() as {acknowledged?:boolean;observation?:unknown};
    if(!response.ok||result.acknowledged!==true)throw new Error('runtime observer ACK unavailable');
    if(kind==='start'){observerStarted=true;segmentInvocations=0;segmentStarted=performance.now();}
    else {runtimeSegments.push(result.observation as Record<string,unknown>);runtimeObservation=observationSummary();observerStarted=false;}
    }finally{runtimeBarrierWallMs[kind]=(runtimeBarrierWallMs[kind]??0)+performance.now()-barrierStarted;}
    lastBoundary='observer_'+kind+'_acknowledged';
  };
  const stopObservation=async()=>{
    if(!observerStarted)return;
    try{await observe('stop');}
    catch(error){runtimeGaps.push({boundary:lastBoundary,reason:'observer_stop_transport_unavailable'});observerStarted=false;observerUnavailable=true;runtimeObservation=observationSummary();}
  };
  const originalInvocation=measured.invocation;
  measured.invocation=async <T>(operation:string,run:Parameters<typeof originalInvocation<T>>[1])=>{
    lastBoundary='invocation_'+operation;
    sourceConsumer=wholeWorkloadSourceConsumer(operation,graphMetric);
    const directScope:Partial<Record<WholeWorkloadSourceConsumer,C06OperationScope>>={cohort:'direct_cohort',daily:'direct_daily',api:'direct_api',scalar:'direct_scalar',model:'direct_model',block:'native_block',cache:'direct_cache',publication:'direct_publication',fixture:'fixture'};
    // Scheduled producers receive the original metered handle. Exact transformed
    // inner call boundaries own their scopes; mixed/shared work stays unknown.
    const scope=sourceLineage&&!operation.endsWith('_schedule')?directScope[sourceConsumer]:undefined;
    const fixtureWindow=sourceConsumer==='fixture'?c06Evidence?.beginFixture():undefined;
    let value:T,succeeded=false;
    try{value=await originalInvocation(operation,(db,meter,ledger)=>run(scope?{...db,source:fixedSourceScope(db.source,scope)}:db,meter,ledger));succeeded=true;}
    finally{if(fixtureWindow)c06Evidence!.endFixture(fixtureWindow,succeeded);}
    if(sourceLineage&&sourceConsumer!=='fixture'&&sourceConsumer!=='unclassified'){
      if(wholeWorkloadConsumerCompleted(operation,value))completedConsumers.set(sourceConsumer,(completedConsumers.get(sourceConsumer)??0)+1);
    }
    lastBoundary='completed_'+operation;
    if(observerStarted&&(++segmentInvocations>=60||performance.now()-segmentStarted>=15_000)) {
      if(runtimeSegments.length>=4095)throw new Error('runtime recording count bound');
      await stopObservation();
      if(!observerUnavailable)await observe('start');
    }
    return value;
  };
  let lastRequest:Record<string,unknown>|null=null;
  const roleFailures:{role:string;lane:string|null;phase:string|null;reason:string|null;detail:string|null;invocation:number;queriesUsed:number}[]=[];
  const decoding=installAnalyticalDecodeCounter();
  kernel.resetPricingCalls();
  try {
    installC06Scope?.(sourceLineage?fixedSourceScope:null);
    installBlockCompletion?.(sourceLineage&&canonical?blockCompletion:null);
    if(sourceLineage&&sourceDiagnostics){await sourceLineage.establishSchema(sourceDiagnostics.database);started=performance.now();}
    await observe('start');
    if(previewCounter)await measured.invocation('preview_counter_start',async db=>{
      const startup=await db.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind(sourceId).first<Record<string,unknown>>();
      if(options.actionPreviewCheckpoint)assertFunctionalActionPreviewStartup(options.actionPreviewCheckpoint,startup);
      else if(options.priorPublication)expect(startup).toEqual(options.priorPublication.rows.previewRow);else expect(startup).toBeNull();
      await previewCounter.start(startup);
    });
    await snapshot('initial');
    measured.setPhase('owner_metadata');
    const owners=(await measured.invocation('owner_metadata',db=>kernel.readStorageCommunityOwnerPage(db.source)))
      .filter((owner):owner is Owner=>typeof owner.ownerDigest==='string');
    assertFunctionalExpectedOwners(owners.map(owner=>owner.ownerDigest),options.expectedOwnerDigests);
    if(!compare)for(const owner of owners)await measured.invocation('owner_pin',db=>db.target.prepare(`INSERT OR REPLACE INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
      .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,'active').run());
    const advanceRoles=async()=>{
      const progress:Record<string,unknown>={};
      for(const [role,run] of [['analytics',kernel.runStorageAnalyticsSchedule],
        ['cache',kernel.runCacheRetentionDaySchedule],['publication',kernel.runStoragePublicationSchedule]] as const) {
        measured.setPhase(`${role}_role`);
        let scheduleEvents=0,roleThrew=true;
        roleOutcomes?.begin(role,measured.profile);
        try {
        await measured.invocation(`${role}_schedule`,async(db,_meter,ledger)=>{
          if(!ledger)throw new Error('scheduled role requires metered deletion ledger');
          const log=console.log;
          console.log=(...args:unknown[])=>{
            if(typeof args[0]==='string'&&args[0].startsWith('{')) {
              const value=JSON.parse(args[0]) as {event?:string;lane?:unknown;phase?:unknown;reason?:unknown;detail?:unknown};
              if(value.event==='storage_analytics_lane_failure') {
                const field=(item:unknown)=>typeof item==='string'&&/^[a-z0-9_]{1,64}$/u.test(item)?item:null;
                roleFailures.push({role,lane:field(value.lane),phase:field(value.phase),reason:field(value.reason),detail:field(value.detail),
                  invocation:measured.profile.invocations+1,queriesUsed:_meter.queriesUsed});
              }
              if(value.event?.endsWith('_schedule')){scheduleEvents++;progress[role]=value;return;}
            }
            log(...args);
          };
          try {
            const roleEnv=wholeWorkloadRoleEnvironment({...db,ledger},sourceId,sourceNamespace,optimization);
            await run(roleEnv);
          } finally {console.log=log;}
        });
        roleThrew=false;
        } finally {roleOutcomes?.end({role,event:progress[role],eventCount:scheduleEvents,threw:roleThrew,profile:measured.profile});}
        // The real scheduler records best-effort lane faults and retries later.
        // Keep every event/cost; only exact bounded output guards complete work.
      }
      return progress;
    };
    const advanceCandidate=advanceRoles;
    if(compare&&!canonical)for(let attempt=0;attempt<preparationLimit;attempt++) {
      await advanceRoles();
      measured.setPhase('closure');
      const delivered=await measured.invocation('reference_delivery_closure',async db=>{
        const sourceSequence=await db.source.prepare('SELECT coalesce(max(sequence),0) n FROM storage_ingestion_changes').first<number>('n');
        const targetSequence=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first<number>('sequence');
        return sourceSequence===targetSequence;
      });
      if(delivered)break;
      if(attempt===preparationLimit-1)throw new Error('reference role delivery invocation bound exceeded');
    }
    if(canonical) {
      for(let attempt=0;attempt<preparationLimit;attempt++) {
        lastCandidateAttempt=attempt;
        const progress=await advanceCandidate();
        if(coverageOnly&&(progress.analytics as {canonicalWork?:{coverage?:{status?:string}}})?.canonicalWork?.coverage?.status==='complete') {
          console.log('analytics-candidate-coverage-complete',JSON.stringify({attempt,progress}));
          throw new Error('coverage-only diagnostic reached complete source coverage');
        }
        measured.setPhase('closure');
        const closed=await measured.invocation('candidate_source_closure',db=>candidate.readAnalyticsWorkClosureFence(bindings(db)));
        if(closed)break;
        if(attempt%25===0) {
          measured.setPhase('scheduler');
          const states=await measured.invocation('candidate_progress',db=>db.target.prepare(
            'SELECT stage,state,reason_code,count(*) n FROM analytics_partition_work GROUP BY stage,state,reason_code').all());
          const sourceProgress=await measured.invocation('candidate_source_progress',db=>db.source.batch([
            db.source.prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1'),
            db.source.prepare('SELECT seeded,needs_work,count(*) n FROM storage_effective_selective_owners GROUP BY seeded,needs_work'),
            db.source.prepare('SELECT family,count(*) n,min(day_cursor) first_day,max(day_cursor) last_day FROM storage_effective_selective_work GROUP BY family'),
            db.source.prepare('SELECT count(*) n FROM storage_effective_selective_reverse_work'),
          ]));
          const ownerPins=await measured.invocation('candidate_owner_pin_progress',async db=>{
            const fresh=await kernel.readStorageCommunityOwnerPage(db.source);
            const pins=(await db.target.prepare('SELECT owner_digest,revision,authority_epoch FROM analytics_owner_state WHERE source_id=?').bind(sourceId)
              .all<{owner_digest:string;revision:number;authority_epoch:number}>()).results;
            return {source:fresh.length,target:pins.length,exact:fresh.filter(owner=>pins.some(pin=>pin.owner_digest===owner.ownerDigest
              &&pin.revision===owner.ownerRevision&&pin.authority_epoch===owner.authorityEpoch)).length};
          });
          console.log('analytics-candidate-progress',JSON.stringify({attempt,progress,states:states.results,sourceProgress:sourceProgress.map(row=>row.results),ownerPins,
            statements:summarizeWholeWorkload(measured.profile).statements}));
        }
        if(attempt===preparationLimit-1)throw new Error('candidate source closure invocation bound exceeded');
      }
    }
    // A scoped calendar request uses the same public lease operations as the
    // production chooser. The separate fair calendar chooser remains a gate;
    // no harness UPDATE declares a graph result or queue job complete.
    const scopedGraph=async(owner:Owner,day:string,metric:'fits'|'model'):Promise<Awaited<ReturnType<Kernel['computeStorageGraphResult']>>>=>{
      graphMetric=metric;
      if(canonical) {
        measured.setPhase('graph_request');
        const progress=await measured.invocation('scoped_graph_production_request',(db,meter)=>candidate.advanceStorageCommunityGraphWork({
          ...bindings(db),nowMs:Date.now(),deadlineMs:Date.now()+60_000,
          get remainingQueries(){return meter.remainingQueries;},admissionQueries:50,
          canonicalPipeline:true,sharedFeatures:optimization.sharedFeatures,preparedFold:optimization.preparedFold,modelBlocks:optimization.modelBlocks,
          request:{ownerDigest:owner.ownerDigest,day,metric}}));
        if(progress.state!=='complete'&&progress.state!=='reused')return {state:'deferred',reason:progress.reason??'graph_pending',
          ...(progress.failure?{failure:progress.failure}:{})};
        measured.setPhase('final_visibility');
        return measured.invocation('scoped_graph_production_visibility',async db=>{
          const scope=await kernel.captureStorageGraphScope(db.source,{owner,day,metric,sourceId,sourceNamespace,preparedFold:true});
          const result=await kernel.readStorageGraphResult(bindings(db),scope);
          if(!result)return {state:'deferred',reason:'result_visibility_changed'};
          return {state:'complete',result,reused:progress.state==='reused'};
        });
      }
      return measured.invocation('scoped_graph_request',(db,meter)=>advanceNativeWholeWorkloadGraph({
        kernel,bindings:bindings(db),owner,day,metric,meter,profile:optimization,leased:true,
        setPhase:phase=>measured.setPhase(phase),...(sourceLineage?{scopeBlockSource:(source:D1Database)=>fixedSourceScope(source,'native_block')}:{}),observeBlock:event=>{if(event==='start')sourceConsumer='block';else if(event==='end')sourceConsumer=metric==='fits'?'scalar':'model';
          else completedConsumers.set('block',(completedConsumers.get('block')??0)+1);}}));
    };
    const dailyDays=wholeWorkloadDailyPopulation(dates,cacheDates);
    for(const day of dailyDays) {
      await completeBoundedWholeWorkloadRequest({limit:160,
        request:async attempt=>{
          measured.setPhase('daily_publication');
          const result=await measured.invocation('daily_publication',(db,meter)=>kernel.advanceStorageCommunityDaily({
            ...bindings(db),day,maxOwners:4,sharedFeatures:optimization.sharedFeatures,
            ...(optimization.sharedFeatures?{sharedFeatureBudget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000,now:Date.now}}:{})}));
          lastRequest={family:'daily',day,attempt,state:result.state,reason:result.reason??null};
          if(!['published','unchanged','progress','deferred'].includes(result.state))throw new Error('unexpected daily refusal');
          return result;
        },complete:result=>result.state==='published'||result.state==='unchanged',
        advanceRoles:async()=>{if(compare)await advanceRoles();},
        exhaustedMessage:'daily publication invocation bound exceeded'});
    }
    for(const day of calculatedModelDates) {
      for(const owner of owners) {
        let complete=false;
        for(let attempt=0;attempt<160;attempt++) {
          const result=await scopedGraph(owner,day,'model');
          lastRequest={family:'model',day,attempt,state:result.state,reason:'reason' in result?result.reason:null};
          if(result.state==='complete') {
            const outcome=result.result.unsupportedSource?'unsupported_source':result.result.composition?.status;
            if(!outcome)throw new Error('complete model outcome missing');
            modelOutcomeCounts[outcome]=(modelOutcomeCounts[outcome]??0)+1;
            output.ownerModels.push({day,value:result.result});complete=true;break;
          }
          if(result.failure)throw new Error('model computation failed');
          if(compare)await advanceRoles();
        }
        if(!complete)throw new Error('model computation invocation bound exceeded');
      }
      // Publish every native retained date, including explicit empty/refused
      // outcomes and today. Older requested calculations stay private.
      if(publicModelDates.includes(day)) {
        measured.setPhase('model_publication');
        let published=false;
        for(let attempt=0;attempt<160;attempt++) {
          measured.setPhase('model_publication');
          const result=await measured.invocation('model_publication',db=>kernel.publishStorageCommunityModelDay(bindings(db),{day}));
          lastRequest={family:'model_publication',day,attempt,state:result.state,reason:'reason' in result?result.reason:null};
          if(result.state==='published'||result.state==='unchanged'){published=true;break;}
          if(compare)await advanceRoles();
        }
        if(!published)throw new Error('model publication invocation bound exceeded');
        measured.setPhase('final_visibility');
        const row=await measured.invocation('model_visibility',db=>db.target.prepare(`SELECT payload_json,payload_sha256
          FROM analytics_community_model_publications WHERE source_id=? AND day=?`).bind(sourceId,day)
          .first<{payload_json:string;payload_sha256:string}>());
        if(!row||row.payload_sha256!==await sha256Hex(row.payload_json))throw new Error('model publication visibility proof failed');
        output.modelPublications.push({day,value:JSON.parse(row.payload_json)});
      }
    }
    for(const day of cacheDates) {
      for(const owner of owners) {
        if(canonical) {
          let aggregate:CacheRetentionDayAggregate|null=null;
          for(let attempt=0;attempt<160&&!aggregate;attempt++) {
            measured.setPhase('final_visibility');
            aggregate=await measured.invocation('canonical_cache_day_visibility',db=>candidate.readCandidateCacheDay({
              ...bindings(db),ownerDigest:owner.ownerDigest,day}));
            lastRequest={family:'cache_day',day,attempt,state:aggregate?'complete':'deferred'};
            if(!aggregate)await advanceCandidate();
          }
          if(!aggregate)throw new Error('canonical cache day readiness bound exceeded');
          output.cacheDays.push({day,value:{status:'ready',aggregate}});
          continue;
        }
        measured.setPhase('cache_build');
        const fingerprint=await measured.invocation('cache_scope',db=>db.target.prepare(`SELECT fingerprint
          FROM analytics_community_daily_owners WHERE source_id=? AND owner_digest=? AND day=? AND source_format='effective' AND complete=1`)
          .bind(sourceId,owner.ownerDigest,day).first<string>('fingerprint'));
        if(fingerprint===null)throw new Error('cache daily scope unavailable');
        const key:CacheRetentionDayCandidate={sourceId,sourceNamespace,sourceLayout:'effective',ownerDigest:owner.ownerDigest,
          deviceId:kernel.CACHE_RETENTION_EFFECTIVE_DEVICE_ID,manifestId:kernel.CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
          manifestDigest:(JSON.parse(fingerprint) as {dependencyDigest:string}).dependencyDigest,day};
        const carry=await measured.invocation('cache_carry',db=>kernel.readCacheRetentionCarryDays(db.target,key));
        let aggregate:CacheRetentionDayAggregate|undefined;
        for(let attempt=0;attempt<160&&!aggregate;attempt++) {
          aggregate=await measured.invocation('cache_build',async(db,meter)=>{
            try {return await kernel.createCacheRetentionDaySourceBuild({source:db.source,target:db.target,sourceNamespace,sharedFeatures:optimization.sharedFeatures})
              (key,carry,{remainingQueries:meter.remainingQueries,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+60_000});}
            catch(error){if(!(error instanceof kernel.CacheRetentionDeferredError))throw error;return undefined;}
          });
          lastRequest={family:'cache_build',day,attempt,state:aggregate?'complete':'deferred'};
          if(!aggregate&&compare)await advanceRoles();
        }
        if(!aggregate)throw new Error('cache build invocation bound exceeded');
        let cursor:CacheRetentionDayWriteCursor|undefined,stored=false;
        measured.setPhase('cache_write');
        for(let attempt=0;attempt<160;attempt++) {
          const result=await measured.invocation('cache_write',db=>kernel.writeCacheRetentionDay({target:db.target,key,carry,aggregate:aggregate!,...(cursor?{cursor}:{})}));
          lastRequest={family:'cache_write',day,attempt,state:result.status};
          if(result.status==='stored'){stored=true;break;}cursor=result.cursor;
          if(compare)await advanceRoles();
        }
        if(!stored)throw new Error('cache write invocation bound exceeded');
        measured.setPhase('final_visibility');
        const visible=await measured.invocation('cache_visibility',db=>kernel.readCacheRetentionDay({target:db.target,key,carry}));
        if(visible.status!=='ready')throw new Error('native cache day not ready');
        output.cacheDays.push({day,value:compare?{status:'ready',aggregate:visible.aggregate}:visible});
      }
    }
    for(const owner of owners) {
      let complete=false;
      for(let attempt=0;attempt<160;attempt++) {
        const result=await scopedGraph(owner,today,'fits');
        lastRequest={family:'fits',day:today,attempt,state:result.state,reason:'reason' in result?result.reason:null};
        if(result.state==='complete'){output.currentScalar.push(result.result);complete=true;break;}
        if(result.failure)throw new Error('scalar computation failed');
        if(compare)await advanceRoles();
      }
      if(!complete)throw new Error('scalar invocation bound exceeded');
    }
    measured.setPhase('preview_publication');
    let previewPublished=false;
    for(let attempt=0;attempt<160;attempt++) {
      measured.setPhase('preview_publication');
      const preview=await measured.invocation('preview_publication',db=>kernel.publishStorageCommunityGraphPreview(bindings(db),{nowMs:Date.now()}));
      lastRequest={family:'preview_publication',attempt,state:preview.state,reason:'reason' in preview?preview.reason:null};
      if(preview.state==='published'||preview.state==='unchanged'){previewPublished=true;break;}
      if(compare)await advanceRoles();
    }
    if(!previewPublished)throw new Error('preview publication invocation bound exceeded');
    measured.setPhase('final_visibility');
    const visible=await measured.invocation('preview_visibility',db=>kernel.readPublishedStorageCommunityGraph(bindings(db),nowMs));
    if(!visible)throw new Error('preview visibility proof failed');
    output.preview=JSON.parse(visible.payload_json);
    if(canonical) {
      for(let attempt=0;attempt<publicationLimit;attempt++) {
        await advanceCandidate();
        measured.setPhase('final_visibility');
        const complete=await measured.invocation('candidate_publication_population',db=>db.target.prepare(
          "SELECT count(*) n FROM analytics_partition_work WHERE source_id=? AND state IN('ready','leased')").bind(sourceId).first<number>('n'));
        lastRequest={family:'durable_publications',attempt,pending:complete,state:complete===0?'complete':'deferred'};
        if(complete===0)break;
        if(attempt===publicationLimit-1)throw new Error('candidate publication invocation bound exceeded');
      }
      output.cacheSeries=await measured.invocation('cache_series',db=>candidate.readCandidatePublishedCache({...bindings(db),nowMs:Date.now()}));
    } else output.cacheSeries=await measured.invocation('cache_series',db=>kernel.readCacheRetentionCommunitySeries({target:db.target,sourceId,nowMs}));
    if(output.cacheSeries===null)throw new Error('complete cache public DTO unavailable');
    for(const day of dates) {
      const value=await measured.invocation('daily_api_visibility',db=>kernel.readPublishedStorageCommunityDaily({...bindings(db),fromDay:day,throughDay:day}));
      if(value.rows.length!==1||value.rows[0]!.day!==day)throw new Error('complete daily public DTO unavailable');
      output.daily.push({day,value});
    }
    await snapshot('before_cleanup');
    measured.setPhase('cleanup');
    await measured.invocation('graph_cleanup',db=>kernel.retireStorageCommunityGraphPublications(bindings(db),nowMs));
    if(compare)for(let attempt=0;attempt<1024;attempt++) {
      const retired=await measured.invocation('graph_result_cleanup',db=>kernel.retireStorageGraphPage(db.target,sourceId,nowMs));
      if(retired.state==='idle')break;
      if(attempt===1023)throw new Error('native graph retirement invocation bound exceeded');
    }
    await measured.invocation('daily_cleanup',db=>kernel.retireStorageCommunityDailyPage(bindings(db)));
    for(let attempt=0;attempt<160;attempt++) {
      const result=await measured.invocation('cache_cleanup',db=>kernel.retireCacheRetentionDayPage(db.target,sourceId));
      if(result.state==='idle')break;
      if(attempt===159)throw new Error('cache cleanup invocation bound exceeded');
    }
    if(canonical)await measured.invocation('candidate_cleanup',(db,meter)=>candidate.advanceAnalyticsWorkRetirement({
      target:db.target,sourceId,meter,now:Date.now,deadlineMs:Date.now()+60_000,completedBeforeMs:nowMs-86_400_000}));
    await snapshot('after_cleanup');
    // Compare every retained published body and every prerequisite outcome,
    // including empty, unavailable and age-retired dates. These full DTOs keep
    // their exact publication clocks; no new normalization exception applies.
    measured.setPhase('final_visibility');
    const storedDailyDates=await measured.invocation('daily_population_dates',async db=>(await db.target.prepare(
      'SELECT DISTINCT day FROM analytics_community_daily_publications WHERE source_id=? ORDER BY day').bind(sourceId).all<{day:string}>()).results.map(row=>row.day));
    for(const day of [...new Set([...dailyDays,...storedDailyDates])].sort()) {
      const population=await measured.invocation('daily_population_visibility',async db=>{
        const stored=(await db.target.prepare(functionalBranches.length?'SELECT * FROM analytics_community_daily_publications WHERE source_id=? AND day=? ORDER BY revision':'SELECT revision,payload_json,payload_sha256,released_at FROM analytics_community_daily_publications WHERE source_id=? AND day=? ORDER BY revision')
          .bind(sourceId,day).all<{revision:number;payload_json:string;payload_sha256:string;released_at:string}>()).results;
        for(const row of stored)if(await sha256Hex(row.payload_json)!==row.payload_sha256)throw new Error('daily population payload proof failed');
        return {day,stored,visible:await kernel.readPublishedStorageCommunityDaily({...bindings(db),fromDay:day,throughDay:day})};
      });
      output.publishedDaily.push(population);
      dailyPublicationInventory.push({day,requested:dates.includes(day),prerequisite:dailyDays.includes(day),
        stored:population.stored.map(row=>({revision:row.revision,payloadSha256:row.payload_sha256,releasedAt:row.released_at})),
        visibleRevisions:population.visible.rows.map(row=>row.revision),
        publicDtoSha256:await sha256Hex(canonicalJson(population.visible))});
    }
    if(compare) {
      measured.setPhase('final_visibility');
      actualStoredPopulation=await measured.invocation('actual_stored_population',async db=>{
        const graph=(await db.target.prepare('SELECT owner_digest,metric,day,method,payload_sha256 FROM analytics_community_graph_results WHERE source_id=? ORDER BY metric,day,owner_digest,method')
          .bind(sourceId).all<{owner_digest:string;metric:string;day:string;method:string;payload_sha256:string}>()).results;
        const expected=owners.flatMap(owner=>[{owner_digest:owner.ownerDigest,metric:'fits',day:today,method:kernel.STORAGE_GRAPH_METHOD},
          ...publicModelDates.map(day=>({owner_digest:owner.ownerDigest,metric:'model',day,method:kernel.STORAGE_GRAPH_METHOD}))]);
        const key=(row:{owner_digest:string;metric:string;day:string;method:string})=>[row.metric,row.day,row.owner_digest,row.method].join('/');
        expect(graph.map(key).sort()).toEqual(expected.map(key).sort());
        const published=(await db.target.prepare('SELECT day FROM analytics_community_model_publications WHERE source_id=? ORDER BY day')
          .bind(sourceId).all<{day:string}>()).results.map(row=>row.day);
        expect(published).toEqual(publicModelDates);
        const daily=await db.target.prepare('SELECT count(*) revisions,count(DISTINCT day) days,min(day) first_day,max(day) last_day FROM analytics_community_daily_publications WHERE source_id=?')
          .bind(sourceId).first();
        return {checkedAfterCleanup:true,graphInventorySha256:await sha256Hex(canonicalJson(graph.map(row=>[key(row),row.payload_sha256]).sort((left,right)=>left[0]!.localeCompare(right[0]!)))),graphResults:graph.length,modelOwnerResults:graph.filter(row=>row.metric==='model').length,
          modelDates:publicModelDates.length,calculatedModelDates:calculatedModelDates.length,calculatedModelOwnerResults:output.ownerModels.length,
          retiredCalculationDates:graphPopulation.extraRequestedDates.length,currentFitOwners:graph.filter(row=>row.metric==='fits').length,
          modelPublicationDates:published.length,dailyPublicationInventory,dailyPublications:{...daily,dates:storedDailyDates},prerequisiteDailyDates:dailyDays,requestedDailyDates:dates.length,
          cacheOwnerDaysCompared:output.cacheDays.length,modelOutcomeCounts};
      });
    }
    if(functionalBranches.length)publicationRows=await measured.invocation('functional_publication_rows',async db=>{
      const modelRows=(await db.target.prepare('SELECT * FROM analytics_community_model_publications WHERE source_id=? ORDER BY day').bind(sourceId).all<Record<string,unknown>>()).results;
      const previewRow=await db.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=? AND method=?').bind(sourceId,kernel.STORAGE_GRAPH_METHOD).first<Record<string,unknown>>();
      if(!previewRow||modelRows.length!==70)throw Error('FUNCTIONAL_PUBLICATION_ROWS_INCOMPLETE');return {modelRows,previewRow};
    });
    if(previewCounter){if(!publicationRows)throw Error('PREVIEW_COUNTER_PUBLICATION_ROWS_REQUIRED');
      previewCounterProof=await measured.invocation('preview_counter_finish',()=>previewCounter.finish(publicationRows!.previewRow));}
    measured.profile.wallMs=performance.now()-started;
    if(new Date(Date.now()).toISOString().slice(0,10)!==operationalStartDay)throw new Error('workload crossed operational UTC day');
    lastBoundary='publication_timestamp_validation';
    const retainedTimes=options.priorPublication?await validateRetainedFunctionalPublicationTimes({output,priorOutput:options.priorPublication.output as typeof output,rows:publicationRows!,priorRows:options.priorPublication.rows,nowMs,priorNowMs:options.priorPublication.analyticalNowMs}):null;
    const timestamps=retainedTimes??validateWholeWorkloadPublicationTimes(output,nowMs);
    await stopObservation();
    const sqlPerformanceHistogram=performanceHistogram?await performanceHistogram.report(measured.profile):undefined;
    const scheduledRoleOutcomes=roleOutcomes?.report(measured.profile);
    if(sourceLineage&&sourceDiagnostics){
      const publicCompleteReceiptSha256=await sha256Hex(canonicalJson(timestamps.output));
      for(const [consumer,calls] of completedConsumers)for(let call=0;call<calls;call++)sourceLineage.registerConsumerCompletion({consumer,publicCompleteReceiptSha256});
      const expectedSourceCalls=Object.values(sourceCalls).reduce((sum,n)=>sum+n,0);
      const profiledSourceCalls=Object.entries(measured.profile.costs).filter(([key])=>key.split('.')[1]==='source').reduce((sum,[,cost])=>sum+cost.statements,0);
      let diagnostic:Awaited<ReturnType<typeof sourceLineage.report>>|null=null,unavailable=false;
      try{diagnostic=await sourceLineage.report({expectedSourceCalls,diagnosticDatabase:sourceDiagnostics.database});}catch{unavailable=true;}
      sourceLineageReport={contract:'whole-workload-c06-source-census-v1',lane:canonical?'candidate':'reference',phase:workloadPhase,
        status:unavailable?'unavailable':'diagnostic',candidateQualificationEligible:canonical,noRescanQualified:false,qualificationReason:canonical?'reviewed_certificate_not_attached':'native_reference_diagnostic_only',
        publicCompleteReceiptSha256,expectedSourceCalls,profiledSourceCalls,perConsumerExpectedSourceCalls:sourceCalls,
        operationScopeFailures,operationScopesComplete:operationScopeFailures===0&&diagnostic!==null&&diagnostic.boundaryFailures===0,producerScopeContract:'immutable-prepared-operation-scope-v1',producerBoundaryTransform:canonical?'candidate-shared-boundaries-v2':'native-direct-entrypoints-only',perOperationExpectedSourceCalls:operationSourceCalls,
        operationCountsReconciled:diagnostic!==null&&C06_OPERATION_SCOPES.every(scope=>diagnostic.measurements.filter(row=>row.operationScope===scope).reduce((sum,row)=>sum+row.attempts,0)===operationSourceCalls[scope]),
        sourceCallCountsReconciled:expectedSourceCalls===profiledSourceCalls&&diagnostic?.calls===expectedSourceCalls,
        consumerCountsReconciled:diagnostic!==null&&C06_CONSUMERS.every(name=>diagnostic.perConsumer[name]?.attempts===sourceCalls[name]),
        diagnosticCountsReconciled:diagnostic!==null&&sourceDiagnostics.report().profile.statements===diagnostic.schemaSetupStatements+diagnostic.diagnosticStatements,
        diagnostics:sourceDiagnostics.report(),report:diagnostic,
        independentReview:canonical&&diagnostic?await runC06IndependentReview({policy:c06IndependentReviewPolicy,
          pin:settings.VITE_C06_REVIEW_POLICY_ENTRY?{entrySha256:settings.VITE_C06_REVIEW_POLICY_ENTRY,bundleSha256:settings.VITE_C06_REVIEW_POLICY_BUNDLE??''}:null,
          report:diagnostic,bindings:await sourceLineage.privateBindingReview()}):null,
        blockCompletionEvidence:{contract:'native-guarded-block-completions-v1',candidateWitnesses:blockCompletions,boundaryFailures:blockCompletionFailures,registered:completedConsumers.get('block')??0},
        phaseEvidence:diagnostic&&c06Evidence?await c06Evidence.finish({phase:workloadPhase as C06PhaseProvenance['phase'],provenance:options.c06Provenance,
          report:diagnostic,invocation:measured.invocationEvidence(),runtimeArtifactSha256:settings[canonical?'VITE_WHOLE_WORKLOAD_CANDIDATE_BUNDLE':'VITE_WHOLE_WORKLOAD_REFERENCE_BUNDLE']??'',
          ownFullOutputSha256:publicCompleteReceiptSha256,diagnosticMeterStatements:sourceDiagnostics.report().profile.statements,diagnosticMeterReceipt:sourceDiagnostics.report()}):null};
    }
    laneCompleted=true;
    return {output:timestamps.output,actualStoredPopulation,publicationRows,previewCounterProof,observedOwnerDigests:owners.map(owner=>owner.ownerDigest),profile:{...summarizeWholeWorkload(measured.profile),...(sourceLineageReport?{c06SourceLineage:sourceLineageReport}:{}),...(previewCounterProof?{nativePreviewCounter:{boundary:options.actionPreviewCheckpoint?'lane-entry-after-traced-native-action':options.priorPublication?'lane-entry-after-native-action':'cold-null-startup',startupFullBaseRowMatched:Boolean(options.priorPublication&&!options.actionPreviewCheckpoint),...(options.actionPreviewCheckpoint?{actionCheckpoint:options.actionPreviewCheckpoint.receipt}:{}),receipt:previewCounterProof.receipt}}:{}),...(sqlPerformanceHistogram?{sqlPerformanceHistogram,scheduledRoleOutcomes}:{}),runtimeObservation,runtimeBarrierWallMs,logicalStoreSnapshots,logicalInventoryCostContract:'Aggregate observer SQL is included in total costs and separately attributed to logical_inventory; no physical byte inference.',publicationTimestampsChecked:timestamps.timestampsChecked,...(retainedTimes?{retainedPublicationClock:{contract:retainedTimes.contract,retainedExactRows:retainedTimes.retainedExactRows,newClockRows:retainedTimes.newClockRows,priorAnalyticalNowMs:options.priorPublication!.analyticalNowMs,analyticalNowMs:nowMs}}:{}),analyticalDecodes:decoding.read().analyticalDecodes,decodeInstrumentation:decoding.read(),
      roleFailurePolicy:WHOLE_WORKLOAD_ROLE_FAILURE_POLICY,scheduledLaneFailures:roleFailures,
      unexpectedCandidateRoleFailures:canonical?roleFailures.length:null,
      pricingEntryCalls:kernel.pricingCalls(),pricingCounterContract:'Calls into native daily and fit price entrypoints; wrapper/value calls are separately counted invocations, not unique priced occurrences.'}};
  } catch(error) {
    const failureBoundary=lastBoundary;
    if(previewCounter)console.log('analytics-preview-counter-incomplete',JSON.stringify({lane:canonical?'candidate':'reference',phase:workloadPhase,...previewCounter.diagnostic()}));
    await stopObservation();
    if(canonical) {
      measured.setPhase('closure');
      const diagnostics=await measured.invocation('candidate_final_diagnostic',async db=>({
        target:(await db.target.batch([
          db.target.prepare('SELECT stage,state,reason_code,count(*) n FROM analytics_partition_work WHERE source_id=? GROUP BY stage,state,reason_code').bind(sourceId),
          db.target.prepare("SELECT stream,reason_code,count(*) n,min(day) first_day,max(day) last_day FROM analytics_partition_work WHERE source_id=? AND stage='features' AND state!='complete' GROUP BY stream,reason_code").bind(sourceId),
          db.target.prepare('SELECT state,acknowledged,count(*) n FROM analytics_partition_ranges WHERE source_id=? GROUP BY state,acknowledged').bind(sourceId),
          db.target.prepare('SELECT state,acknowledged,count(*) n FROM analytics_partition_global_changes WHERE source_id=? GROUP BY state,acknowledged').bind(sourceId),
          db.target.prepare('SELECT count(*) n FROM analytics_partition_dirty_work WHERE source_id=? AND generation>admitted_generation').bind(sourceId),
          db.target.prepare('SELECT complete,count(*) n FROM analytics_partition_reconciliation WHERE source_id=? GROUP BY complete').bind(sourceId),
          db.target.prepare("SELECT q.state,count(*) n FROM analytics_partition_canonical_effects q JOIN analytics_canonical_effects e USING(effect_key) JOIN analytics_canonical_pages p USING(change_key) WHERE p.source_id=? GROUP BY q.state").bind(sourceId),
          db.target.prepare('SELECT state,stream,count(*) n,min(source_day) first_day,max(source_day) last_day FROM analytics_canonical_input_work WHERE source_id=? GROUP BY state,stream').bind(sourceId),
          db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId),
          db.target.prepare('SELECT metric,count(*) n,count(DISTINCT day) days,min(day) first_day,max(day) last_day,sum(CASE WHEN day IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END) requested_date_results FROM analytics_community_graph_results WHERE source_id=? GROUP BY metric').bind(JSON.stringify(dates),sourceId),
          db.target.prepare('SELECT count(*) n,min(day) first_day,max(day) last_day,sum(CASE WHEN day IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END) requested_dates FROM analytics_community_model_publications WHERE source_id=?').bind(JSON.stringify(dates),sourceId),
          db.target.prepare('SELECT count(*) n,count(DISTINCT day) days,min(day) first_day,max(day) last_day FROM analytics_community_daily_publications WHERE source_id=?').bind(sourceId),
          db.target.prepare('SELECT count(*) n FROM analytics_canonical_cache_publications WHERE source_id=?').bind(sourceId),
          db.target.prepare(`SELECT w.lane,w.owner_digest IS NULL ownerless,count(*) n,
            min(w.attempts) min_attempts,max(w.attempts) max_attempts,min(w.last_claimed) first_claim,max(w.last_claimed) last_claim,
            min(w.admission_queries) min_admission,max(w.admission_queries) max_admission,
            min(w.ready_ms) first_ready_ms,max(w.ready_ms) last_ready_ms,? observed_ms,
            sum(CASE WHEN w.ready_ms<=? THEN 1 ELSE 0 END) ready_now,
            sum(CASE WHEN EXISTS(SELECT 1 FROM analytics_partition_work held WHERE held.head_key=w.head_key
              AND held.state='leased' AND held.claim_expires_ms>?) THEN 1 ELSE 0 END) held_heads,
            sum(CASE WHEN w.owner_digest IS NULL OR EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=w.source_id
              AND o.owner_digest=w.owner_digest AND o.state='active' AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
                WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)) THEN 1 ELSE 0 END) eligible_owners
            FROM analytics_partition_work w WHERE w.source_id=? AND w.stage='features' AND w.state='ready'
            GROUP BY w.lane,w.owner_digest IS NULL`).bind(Date.now(),Date.now(),Date.now(),sourceId),
        ])).map(result=>result.results),
        source:(await db.source.batch([
          db.source.prepare('SELECT sequence,policy_stamp,acknowledged_policy_stamp FROM storage_effective_selective_runtime WHERE id=1'),
          db.source.prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1'),
          db.source.prepare('SELECT seeded,needs_work,count(*) n FROM storage_effective_selective_owners GROUP BY seeded,needs_work'),
          db.source.prepare('SELECT family,count(*) n,min(day_cursor) first_day,max(day_cursor) last_day FROM storage_effective_selective_work GROUP BY family'),
          db.source.prepare('SELECT count(*) n FROM storage_effective_selective_reverse_work'),
          db.source.prepare('SELECT count(*) n FROM storage_effective_selective_effects'),
        ])).map(result=>result.results),
      }));
      console.log('analytics-candidate-final-diagnostic',JSON.stringify({lastCandidateAttempt,lastRequest,roleFailures,
        targetOrder:['stage_states','pending_features','ranges','global_changes','dirty_survivors','reconciliation','canonical_effects','input_work','delivered_sequence','actual_graph_results','actual_model_publications','actual_daily_publications','actual_cache_publications','pending_feature_claim_eligibility'],
        sourceOrder:['runtime','bootstrap','owners','work','reverse','effects'],...diagnostics}));
    }
    measured.profile.wallMs=performance.now()-started;
    console.log('analytics-workload-incomplete',JSON.stringify({lane:canonical?'candidate':'reference',
      completed:false,lastRequest,failureBoundary,roleFailures,...(sourceLineage?{c06SourceLineageFailure:{contract:'whole-workload-c06-incomplete-census-v1',noRescanQualified:false,
        operationScopeFailures,expectedSourceCalls:Object.values(sourceCalls).reduce((sum,n)=>sum+n,0),perConsumerExpectedSourceCalls:sourceCalls,
        perOperationExpectedSourceCalls:operationSourceCalls,reason:'lane_not_complete',diagnostics:sourceDiagnostics?.report()}}:{}),profile:{...summarizeWholeWorkload(measured.profile),...(performanceHistogram?{sqlPerformanceHistogram:await performanceHistogram.report(measured.profile),scheduledRoleOutcomes:roleOutcomes?.report(measured.profile)}:{}),runtimeObservation,runtimeBarrierWallMs,logicalStoreSnapshots},analyticalDecodes:decoding.read().analyticalDecodes,decodeInstrumentation:decoding.read(),pricingEntryCalls:kernel.pricingCalls()}));
    if(canonical&&lastRequest?.family==='daily'&&typeof lastRequest.day==='string') {
      try {console.log('analytics-candidate-daily-guard-diagnostic',JSON.stringify(await candidate.readCandidateDailyFailureSnapshot({
        source,target,sourceId,sourceNamespace,day:lastRequest.day})));}
      catch {console.log('analytics-candidate-daily-guard-diagnostic',JSON.stringify({
        schema:'p11-daily-guard-diagnostic-v1',state:'unavailable',measurementContract:'Read-only diagnostic failed outside measured lane.'}));}
    }
    throw error;
  } finally {
    try{await stopObservation();}finally{installBlockCompletion?.(null);installC06Scope?.(null);decoding.restore();previewCounter?.close();}
    if(diagnosticSql)console.log('analytics-workload-sql-diagnostic',JSON.stringify({
      lane:canonical?'candidate':'reference',completed:laneCompleted,measurementContract:'Separate synthetic SQL attribution and unmetered read-only EXPLAIN; excluded from qualifying receipt.',
      ...(await diagnosticSql.report())}));
  }
}

it.skipIf(!enabled)('records a pinned native complete-output baseline and optional isolated-source candidate parity',async()=>{
  native.setAnalyticsWorkloadPublicationClock(nowMs);
  if(compare)candidate.setAnalyticsWorkloadPublicationClock(nowMs);
  expect(native.referenceCommit).toBe('f056940fefabed0c7f0e88353cf54845b077f0c8');
  expect([1,30,365]).toContain(outputCount);
  if(integrationDebugDays) {
    expect([10,30]).toContain(integrationDebugDays);
    expect(compare&&upgradeSource&&outputCount===1).toBe(true);
  }
  try {
    await reset();
    // Native admission executes once. An exact accepted logical snapshot supplies
    // the independent candidate source before its schema upgrade; copy costs are separate.
    const migrations={...b};
    for(const [key,names] of Object.entries(native.nativeMigrationNames)) {
      const group=key as keyof SharedAnalyticsCorpusMigrations;
      migrations[group]=b[group].filter(migration=>names.includes(migration.name));
    }
    const laboratorySetup={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
    const admission={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
    let activeProfiles=laboratorySetup,admissionPhase='schema_setup';
    const physical={reference:{source:b.USAGE_MONITOR_DB,target:b.STORAGE_INGESTION_A,ledger:b.DELETION_LEDGER},
      candidate:{source:b.STORAGE_INGESTION_B,target:b.STORAGE_ANALYTICS_DB,ledger:b.STORAGE_ROUTING_DB}};
    const admittedSource=profileAnalyticsDatabase(physical.reference.source,'source',()=>activeProfiles.reference,()=>admissionPhase);
    const targets={reference:profileAnalyticsDatabase(physical.reference.target,'target',()=>activeProfiles.reference,()=>admissionPhase),
      candidate:profileAnalyticsDatabase(physical.candidate.target,'target',()=>activeProfiles.candidate,()=>admissionPhase)};
    const summarizePair=(profiles:typeof admission)=>({reference:summarizeAnalyticsProfile(profiles.reference),candidate:summarizeAnalyticsProfile(profiles.candidate)});
    let corpus:Pick<Awaited<ReturnType<typeof native.seedSharedAnalyticsCorpus>>,'historyDates'> & Partial<Pick<Awaited<ReturnType<typeof native.seedSharedAnalyticsCorpus>>,'appendOutsideV11'|'mutateCorrection'|'participantId'|'correctionDay'|'v11DomainThroughDay'|'secondaryAccountless'|'functionalInputs'>>;
    let sourceSnapshot:unknown,snapshotImport:Awaited<ReturnType<typeof importAcceptedSourceTransfer>>|null=null;
    const sourceUpgrade={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
    if(freshLane==='seed') {
      await native.initializeSharedAnalyticsCorpusDatabases(admittedSource,targets.reference,migrations,sourceId,sourceNamespace);
      activeProfiles=admission;admissionPhase='admission';
      corpus=await native.seedSharedAnalyticsCorpus({source:admittedSource,target:targets.reference,sourceId,sourceNamespace,
        anchorDay:today,calendarDays,graphDays,correctionAffectsModelFit:true,targetAuthority:'ordered-delivery'});
      const captured=await captureAcceptedSourceTransfer(physical.reference.source);
      await transferLaboratory({kind:'write_seed',seed:{transfer:captured.transfer,snapshotProfile:captured.profile,
        snapshotExportWallMs:captured.exportWallMs,initialAdmission:summarizeAnalyticsProfile(admission.reference),
        laboratorySetup:summarizeAnalyticsProfile(laboratorySetup.reference),historyDates:corpus.historyDates,analyticalNowMs:nowMs}});
      console.log('analytics-workload-seed-complete',JSON.stringify({completed:true,proof:captured.transfer.proof,
        snapshotProfile:captured.profile,initialAdmission:summarizeAnalyticsProfile(admission.reference),laboratorySetup:summarizeAnalyticsProfile(laboratorySetup.reference),exportResourceMetadata:null,physicalSnapshotBytes:null}));
      return;
    } else if(freshLane) {
      if(!compare||!['candidate','reference'].includes(freshLane))throw new Error('invalid independent lane mode');
      const seed=(await transferLaboratory({kind:'read_seed'})).seed;
      if(!seed||seed.analyticalNowMs!==nowMs)throw new Error('accepted seed analytical anchor differs');
      corpus={historyDates:seed.historyDates};
      const db=physical[freshLane];
      if(sharedSeedScale&&await sha256Hex(canonicalJson(seed.transfer.proof))!==sharedSeedProof)throw Error('SHARED_SEED_SCALE_SOURCE_CHANGED');
      snapshotImport=await importAcceptedSourceTransfer(seed.transfer,db.source);
      seed.transfer.statements.length=0; // Release only the local transport; the controller keeps the accepted immutable source.
      sourceSnapshot={schemaVersion:'analytics-source-snapshot-v1',...snapshotImport.proof,exactSchemaAndData:true,exactRowids:true};
      await applyD1Migrations(targets[freshLane],freshLane==='candidate'?b.TEST_ANALYTICS_MIGRATIONS:migrations.TEST_ANALYTICS_MIGRATIONS);
      await applyD1Migrations(profileAnalyticsDatabase(db.ledger,'ledger',laboratorySetup[freshLane],()=> 'schema_setup'),b.TEST_DELETION_LEDGER_MIGRATIONS);
      await native.initializeStorageAnalyticsRuntime({source:profileAnalyticsDatabase(db.source,'source',laboratorySetup[freshLane],()=> 'schema_setup'),target:targets[freshLane],sourceId,sourceNamespace});
      if(freshLane==='candidate')await applyD1Migrations(profileAnalyticsDatabase(db.source,'source',sourceUpgrade.candidate,()=> 'schema_upgrade'),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
      expect(await targets[freshLane].prepare('SELECT count(*) n FROM analytics_applied_events').first<number>('n')).toBe(0);
      expect(await targets[freshLane].prepare('SELECT count(*) n FROM analytics_owner_state WHERE source_id=?').bind(sourceId).first<number>('n')).toBe(0);
      activeProfiles=admission;
    } else {
    for(const lane of ['reference','candidate'] as const)
      await applyD1Migrations(profileAnalyticsDatabase(physical[lane].ledger,'ledger',()=>activeProfiles[lane],()=>admissionPhase),b.TEST_DELETION_LEDGER_MIGRATIONS);
    await native.initializeSharedAnalyticsCorpusDatabases(admittedSource,targets.reference,migrations,sourceId,sourceNamespace);
    await applyD1Migrations(targets.candidate,compare?b.TEST_ANALYTICS_MIGRATIONS:migrations.TEST_ANALYTICS_MIGRATIONS);
    activeProfiles=admission;admissionPhase='admission';
    corpus=await native.seedSharedAnalyticsCorpus({source:admittedSource,target:targets.reference,sourceId,sourceNamespace,
      anchorDay:today,calendarDays,graphDays,correctionAffectsModelFit:true,
      targetAuthority:compare?'ordered-delivery':'fixture-direct',secondaryOwnerKind:functionalAccountlessSecondary?'accountless':'social'});
    if(functionalAccountlessSecondary&&!corpus.secondaryAccountless)throw Error('FUNCTIONAL_ACCOUNTLESS_STARTUP_MISSING');
    sourceSnapshot=await copyAcceptedAnalyticsSource(physical.reference.source,physical.candidate.source);
    await native.initializeStorageAnalyticsRuntime({source:profileAnalyticsDatabase(physical.candidate.source,'source',laboratorySetup.candidate,()=> 'schema_setup'),target:profileAnalyticsDatabase(physical.candidate.target,'target',laboratorySetup.candidate,()=> 'schema_setup'),sourceId,sourceNamespace});
    if(compare)for(const target of Object.values(targets)) {
      expect(await target.prepare('SELECT count(*) n FROM analytics_applied_events').first<number>('n')).toBe(0);
      expect(await target.prepare('SELECT count(*) n FROM analytics_owner_state WHERE source_id=?').bind(sourceId).first<number>('n')).toBe(0);
    }
    if(upgradeSource) {
      if(!compare)throw new Error('source upgrade requires a candidate comparison');
      await applyD1Migrations(profileAnalyticsDatabase(physical.candidate.source,'source',sourceUpgrade.candidate,()=> 'schema_upgrade'),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    }
    }
    const initialAdmission=summarizePair(admission);
    const dates=corpus.historyDates.slice(-outputCount-1,-1);
    const cacheDates=compare?corpus.historyDates:dates;
    const graphPopulation=wholeWorkloadGraphPopulation(today,dates);
    if(compare&&!upgradeSource)throw new Error('integrated comparison requires current source migrations');
    expect(dates).toHaveLength(outputCount);
    const reports:Record<string,unknown>={};
    let priorOutput:Awaited<ReturnType<typeof runLane>>['output']|null=null;
    const priorPhaseOutputSha256:Partial<Record<'candidate'|'reference',string>>={};
    const acceptedSourceReceiptSha256=await acceptedC06SourceReceiptSha256(sourceSnapshot);
    let coldPair:{reference:Awaited<ReturnType<typeof runLane>>;candidate:Awaited<ReturnType<typeof runLane>>}|null=null;
    for(const phase of phases) {
      // Incremental mutation replay requires its own exact isolation proof; an
      // accepted snapshot reset would discard candidate maintenance state.
      admissionPhase='mutation';
      const admissionBefore=summarizePair(admission);
      let mutationProof:Awaited<ReturnType<typeof executePairedNativeMutation>>|null=null;
      if(functionalMutations){
        if(!compare||freshLane||!upgradeSource)throw Error('Persistent physical mutation mode requires both independent stores');
        if(['no_op','unrelated_append','old_correction'].includes(phase)){
          const day=phase==='old_correction'?corpus.correctionDay:corpus.v11DomainThroughDay;
          if(!day||!corpus.participantId)throw Error('Native mutation corpus identity missing');
          mutationProof=await executePairedNativeMutation({
            reference:{...physical.reference,kernel:native as unknown as typeof import('./helpers/analytics-mutation-native-reference')},
            candidate:{...physical.candidate,kernel:candidate as unknown as typeof import('./helpers/analytics-mutation-native-reference')},
            sourceId,sourceNamespace,participantId:corpus.participantId,day,kind:phase as 'no_op'|'unrelated_append'|'old_correction'});
          console.log('analytics-functional-mutation-proof',JSON.stringify({phase,...mutationProof,allFamilyParity:'pending'}));
        }else if(!['cold','warm'].includes(phase))throw Error('Unsupported persistent mutation action');
      }else{
        if(compare&&!['cold','warm','no_op'].includes(phase))throw new Error('isolated incremental mutation admission is not yet qualified');
        if(phase==='unrelated_append'||phase==='old_correction') {
          if(phase==='unrelated_append')await corpus.appendOutsideV11!();else await corpus.mutateCorrection!();
        }else if(!['cold','warm','no_op'].includes(phase))throw new Error('unsupported mutation case');
      }
      const checkpoint=async(lane:'candidate'|'reference',result:Awaited<ReturnType<typeof runLane>>)=>{
        // Persist a completed lane before its peer starts. This is diagnostic
        // evidence only: paired parity and whole-workload gates remain open.
        console.log('analytics-workload-lane-complete',JSON.stringify({schemaVersion:'analytics-workload-lane-diagnostic-v1',
          lane,phase,completed:true,pairParity:'not_checked',wholeWorkloadQualification:false,
          requestedDates:dates,cachePopulationDays:cacheDates.length,graphPopulation,
          actualStoredPopulation:result.actualStoredPopulation,profile:await checkpointProfile(result.profile),
          output:{sha256:await sha256Hex(canonicalJson(result.output)),
            familySha256:Object.fromEntries(await Promise.all(Object.entries(result.output).map(async([key,value])=>[key,await sha256Hex(canonicalJson(value))]))),
            completed:{dailyDays:result.output.daily.length,publishedDailyOutcomes:result.output.publishedDaily.length,currentScalarOwners:result.output.currentScalar.length,
              calculatedOwnerModelResults:result.output.ownerModels.length,nativePublishedModelDates:result.output.modelPublications.length,
              cacheOwnerDays:result.output.cacheDays.length,preview:1,cacheSeries:1}},
          evidenceContract:'Synthetic output hashes and closed resource counters; a completed peer and exact comparison are still required.'}));
      };
      const phaseProvenance=async(lane:'candidate'|'reference'):Promise<C06PhaseProvenance|undefined>=>{
        if(!['warm','no_op','unrelated_append'].includes(phase))return undefined;
        const action=mutationProof?phase==='no_op'?'native-no-op-v2':'native-append-v2':'none';
        return {contract:'retained-source-phase-v1',phase:phase as C06PhaseProvenance['phase'],acceptedSourceReceiptSha256,
          priorCompleteOutputSha256:priorPhaseOutputSha256[lane]??'',analyticalNowMs:nowMs,storesRetained:true,action,
          actionReceiptSha256:mutationProof?await sha256Hex(canonicalJson(mutationProof)):null};
      };
      const next=compare&&freshLane!=='reference'?await runLane(candidate,physical.candidate.source,physical.candidate.target,physical.candidate.ledger,dates,true,cacheDates,phase,{c06Provenance:await phaseProvenance('candidate')}):null;
      if(next)await checkpoint('candidate',next);
      const normal=freshLane!=='candidate'?await runLane(native,physical.reference.source,physical.reference.target,physical.reference.ledger,dates,false,cacheDates,phase,{c06Provenance:await phaseProvenance('reference')}):null;
      if(normal)await checkpoint('reference',normal);
      if(next)priorPhaseOutputSha256.candidate=await sha256Hex(canonicalJson(next.output));
      if(normal)priorPhaseOutputSha256.reference=await sha256Hex(canonicalJson(normal.output));
      if(next&&normal)expect(next.output).toEqual(normal.output);
      if(phase==='cold'&&next&&normal)coldPair={reference:normal,candidate:next};
      const local=normal??next;if(!local)throw new Error('no completed lane');
      let mutationEffects:Record<string,unknown>|null=null;
      if(functionalMutations&&mutationProof){
        if(!priorOutput)throw Error('MUTATION_PRIOR_OUTPUT_REQUIRED');
        if(phase==='no_op'){
          expect(local.output).toEqual(priorOutput);
          mutationEffects={kind:phase,allFamiliesUnchanged:true};
        }else{
          const affectedDay=phase==='old_correction'?corpus.correctionDay:corpus.v11DomainThroughDay;
          if(!affectedDay)throw Error('MUTATION_AFFECTED_DAY_REQUIRED');
          const eventCount=(output:typeof local.output)=>output.cacheDays.reduce<number>((sum,raw)=>{
            const row=raw as {day:string;value:{status:string;aggregate:CacheRetentionDayAggregate}};
            return row.day===affectedDay?sum+row.value.aggregate.eventsRead:sum;
          },0);
          const beforeEvents=eventCount(priorOutput),afterEvents=eventCount(local.output);
          expect(afterEvents,'Authentic accepted occurrence must reach the affected cache-day aggregate').toBe(beforeEvents+1);
          const requestedDailyUnchanged=canonicalJson(local.output.daily)===canonicalJson(priorOutput.daily);
          if(phase==='unrelated_append'){
            expect(dates.every(day=>day<affectedDay),'Append must be outside every requested historical day').toBe(true);
            expect(local.output.daily).toEqual(priorOutput.daily);
          }
          expect(local.output.cacheDays).not.toEqual(priorOutput.cacheDays);
          mutationEffects={kind:phase,affectedDays:1,affectedCacheEventsBefore:beforeEvents,affectedCacheEventsAfter:afterEvents,
            requestedDailyUnchanged,appendOutsideRequestedDays:phase==='unrelated_append',affectedAggregateChanged:true};
        }
      }
      if(functionalMutations)priorOutput=local.output;
      if(freshLane)await transferLaboratory({kind:'write_phase',phase,output:encodeWholeWorkloadValue(local.output)});
      const after=summarizePair(admission);
      const fields=['statements','rowsRead','rowsWritten','databaseMs','serializedBoundBytesSubmitted','serializedResultBytesRead'] as const;
      reports[phase]={reference:normal?.profile??null,candidate:next?.profile??null,...(functionalMutations?{mutationProof,mutationEffects}:{}),
        actualStoredPopulation:{reference:normal?.actualStoredPopulation??null,candidate:next?.actualStoredPopulation??null},
        inputMutation:Object.fromEntries((['reference','candidate'] as const).map(lane=>[lane,Object.fromEntries(fields.map(field=>[field,after[lane][field]-admissionBefore[lane][field]]))])),
        output:{sha256:await sha256Hex(canonicalJson(local.output)),
          familySha256:Object.fromEntries(await Promise.all(Object.entries(local.output).map(async([key,value])=>[key,await sha256Hex(canonicalJson(value))]))),
          completed:{dailyDays:local.output.daily.length,publishedDailyOutcomes:local.output.publishedDaily.length,currentScalarOwners:local.output.currentScalar.length,
            ...(compare?{calculatedOwnerModelResults:local.output.ownerModels.length,
              requestedOwnerModelResults:2*dates.length,maintainedOwnerModelResults:2*graphPopulation.retainedModelDates.length}
              :{historicalOwnerModelResults:local.output.ownerModels.length}),
            nativePublishedModelDates:local.output.modelPublications.length,
            cacheOwnerDays:local.output.cacheDays.length,preview:1,cacheSeries:1},
          parity:freshLane?'peer_not_run':next?'exact':'baseline_only'}};
    }
    if(functionalBranches.length){
      if(!coldPair||!compare||!upgradeSource||freshLane||functionalMutations||phases.join(',')!=='cold')throw Error('FUNCTIONAL_BRANCH_STARTUP');
      const base=await captureCompletedFunctionalBase({stores:physical,analyticalNowMs:nowMs,completed:coldPair,
        inputSha256:{reference:settings.VITE_WHOLE_WORKLOAD_REFERENCE_INPUT??'',candidate:settings.VITE_WHOLE_WORKLOAD_CANDIDATE_INPUT??''}});
      console.log('analytics-functional-base-complete',JSON.stringify(base.receipt));
      const branchReports:Record<string,unknown>={};
      for(const scenario of functionalBranches){
        let branchNow=nowMs;
        if(scenario==='clock_advance'){branchNow+=1000;if(date(branchNow)!==today)throw Error('FUNCTIONAL_CLOCK_ADVANCE_CROSSES_DAY');}
        else if(scenario==='utc_rollover')branchNow=Date.parse(today+'T00:00:00.000Z')+DAY_MS+1000;
        const population=planFunctionalBranchPopulation({baseAnalyticalNowMs:nowMs,analyticalNowMs:branchNow,requestedDates:dates,cacheDates});
        let startupBase=base;
        if(scenario==='restore_after_erasure'){
          let preparationEvidence:unknown;
          await startFunctionalBranch(base,{scenario:'restore_ledger_preparation',stores:physical,resetLaboratory:reset,analyticalNowMs:branchNow,
            recordIncomplete:receipt=>console.log('analytics-functional-branch-incomplete',JSON.stringify(receipt))},async context=>{
            const trace=await startFunctionalActionPreviewTrace({context,sourceId,expected:{reference:coldPair!.reference.publicationRows!.previewRow,candidate:coldPair!.candidate.publicationRows!.previewRow}});
            try{
              const erased=await eraseFunctionalParticipant({context,kernels:{reference:native,candidate},sourceId,sourceNamespace,participantId:corpus.participantId!,targetObservers:trace.targetObservers,
                environment:db=>({...b,USAGE_MONITOR_DB:db.source,ANALYTICS_DB:db.target,STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,DELETION_LEDGER:db.ledger,
                  STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,TELEMETRY_STORAGE_MODE:'typed',STORAGE_ANALYTICS_MODE:'enabled',ENVIRONMENT:'synthetic-development'} as unknown as Env)});
              const observed=await trace.finish();preparationEvidence={erasure:erased.evidence,previewActionTrace:observed.receipt};
              return {outcome:'terminal',reference:{nativePhysicalCompletion:true,expectedOwnerDigests:erased.expectedOwnerDigests},candidate:{nativePhysicalCompletion:true,expectedOwnerDigests:erased.expectedOwnerDigests}};
            }catch(error){console.log('analytics-functional-action-incomplete',JSON.stringify({scenario:'restore_ledger_preparation',...trace.diagnostic()}));throw error;}
            finally{trace.close();}
          });
          startupBase=await captureFunctionalTerminalLedgerBase(base,{stores:physical,sourceId,sourceNamespace,participantId:corpus.participantId!,kernels:{reference:native,candidate},preparationEvidence});
        }
        const branch=await startFunctionalBranch(startupBase,{scenario,stores:physical,resetLaboratory:reset,analyticalNowMs:branchNow,
          recordIncomplete:receipt=>console.log('analytics-functional-branch-incomplete',JSON.stringify(receipt))},async physicalContext=>{
          const actionGuards=scenario==='restore_after_erasure'?null:{reference:createNativePreviewActionGuard(physicalContext.reference.target),candidate:createNativePreviewActionGuard(physicalContext.candidate.target)};
          const context=actionGuards?{...physicalContext,reference:{...physicalContext.reference,target:actionGuards.reference.target},candidate:{...physicalContext.candidate,target:actionGuards.candidate.target}}:physicalContext;
          const actionTrace=scenario==='restore_after_erasure'?await startFunctionalActionPreviewTrace({context,sourceId,expected:{reference:coldPair!.reference.publicationRows!.previewRow,candidate:coldPair!.candidate.publicationRows!.previewRow}}):null;
          let actionCheckpoints:Record<'reference'|'candidate',FunctionalActionPreviewCheckpoint>|undefined;
          try{
          native.setAnalyticsWorkloadPublicationClock(context.analyticalNowMs);candidate.setAnalyticsWorkloadPublicationClock(context.analyticalNowMs);
          let action:unknown={kind:scenario,sourceMutation:false};
          let expectedOwnerDigests:readonly string[]|undefined;
          if(!corpus.participantId)throw Error('FUNCTIONAL_BRANCH_CORPUS');
          const lifecycle={context,kernels:{reference:native,candidate},sourceId,sourceNamespace,participantId:corpus.participantId,...(actionTrace?{targetObservers:actionTrace.targetObservers}:{})};
          if(['no_op','unrelated_append','old_correction','interruption','authority_lag'].includes(scenario)){
            const day=scenario==='old_correction'?corpus.correctionDay:corpus.v11DomainThroughDay;
            if(!day||!corpus.participantId)throw Error('FUNCTIONAL_BRANCH_CORPUS');
            action=await executePairedNativeMutation({reference:{...context.reference,kernel:native as unknown as typeof import('./helpers/analytics-mutation-native-reference')},
              candidate:{...context.candidate,kernel:candidate as unknown as typeof import('./helpers/analytics-mutation-native-reference')},
              sourceId,sourceNamespace,participantId:corpus.participantId,day,kind:(scenario==='authority_lag'?'metadata_change':scenario==='interruption'?'unrelated_append':scenario) as 'no_op'|'unrelated_append'|'old_correction'|'metadata_change',
              ...(scenario==='interruption'?{afterAdmission:()=>interruptFunctionalV11Delivery(lifecycle)}:scenario==='authority_lag'?{afterAdmission:()=>proveFunctionalAuthorityLag(lifecycle)}:{})});
          }else if((nativeInputKinds as readonly string[]).includes(scenario)){
            const coordinates=corpus.functionalInputs;if(!coordinates)throw Error('FUNCTIONAL_INPUT_COORDINATES_REQUIRED');
            const kind=scenario as FunctionalNativeKind;
            const selected=kind==='empty_day_replacement'?{day:coordinates.emptyDay}
              :kind==='quota_change'||kind==='plan_change'?coordinates.quota:coordinates.usage;
            if(!selected?.day)throw Error('FUNCTIONAL_INPUT_COORDINATE_UNAVAILABLE');
            const result=await applyPairedFunctionalNativeInput({...lifecycle,
              kernels:{reference:native as unknown as FunctionalNativeAdmission,candidate:candidate as unknown as FunctionalNativeAdmission},
              action:{kind,day:selected.day,...('occurrenceId' in selected?{occurrenceId:selected.occurrenceId}:{}),
                ...(kind==='cross_day_move'?{destinationDay:coordinates.crossDayDestination}:{})}});
            // Complete native comparisons happened in the adapter; public receipts retain only identity hashes.
            const freshEffective=Object.fromEntries(await Promise.all((['reference','candidate'] as const).map(async lane=>[lane,
              await Promise.all(result.evidence.freshEffective[lane].map(async({occurrenceId,...item})=>
                ({...item,occurrenceSha256:await sha256Hex(occurrenceId)})))])));
            action={evidence:{...result.evidence,freshEffective,receiptProjection:'hash-only-native-input-v1'}};
          }else if(scenario==='duplicate_delivery')action=await replayFunctionalDuplicateDelivery(lifecycle);
          else if(scenario==='stale_lease')action=await expireFunctionalGraphLease({...lifecycle,day:population.requestedDates[0]!});
          else if(scenario==='restore_after_erasure'){
            const result=await replayFunctionalTerminalLedger({...lifecycle,quarantine:b.QUARANTINE});
            if(!result.expectedOwnerDigests)throw Error('FUNCTIONAL_RESTORE_SURVIVOR_PROOF');
            action={evidence:result.evidence};expectedOwnerDigests=result.expectedOwnerDigests;
          }
          else if(['device_revocation','withdrawal','opt_out_retained','physical_erasure'].includes(scenario)){
            if(['withdrawal','opt_out_retained'].includes(scenario)&&!corpus.secondaryAccountless)throw Error('FUNCTIONAL_ACCOUNTLESS_STARTUP_REQUIRED');
            const result=scenario==='device_revocation'?await revokeFunctionalDevices(lifecycle)
              :scenario==='opt_out_retained'?await optOutFunctionalAccountlessOwner({...lifecycle,participantId:corpus.secondaryAccountless!.participantId,
                enrollmentDeviceId:corpus.secondaryAccountless!.enrollmentDeviceId})
              :scenario==='withdrawal'?await withdrawFunctionalAccountlessOwner({...lifecycle,participantId:corpus.secondaryAccountless!.participantId,
                enrollmentDeviceId:corpus.secondaryAccountless!.enrollmentDeviceId})
              :await eraseFunctionalParticipant({...lifecycle,
                environment:db=>({...b,USAGE_MONITOR_DB:db.source,ANALYTICS_DB:db.target,STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,DELETION_LEDGER:db.ledger,
                  STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,TELEMETRY_STORAGE_MODE:'typed',STORAGE_ANALYTICS_MODE:'enabled',ENVIRONMENT:'synthetic-development'} as unknown as Env)});
            if(!result.expectedOwnerDigests)throw Error('FUNCTIONAL_SURVIVOR_PROOF_REQUIRED');action={evidence:result.evidence};expectedOwnerDigests=result.expectedOwnerDigests;
          }else if(!['clock_advance','utc_rollover'].includes(scenario))throw Error('FUNCTIONAL_BRANCH_UNSUPPORTED');
          let previewActionProof:unknown;
          if(actionTrace){const observed=await actionTrace.finish();actionCheckpoints=observed.checkpoints;previewActionProof=observed.receipt;}
          else{if(!actionGuards)throw Error('FUNCTIONAL_ACTION_GUARD_REQUIRED');previewActionProof={reference:actionGuards.reference.assertNoMutation(),candidate:actionGuards.candidate.assertNoMutation()};}
          const completed={} as {reference:Awaited<ReturnType<typeof runLane>>;candidate:Awaited<ReturnType<typeof runLane>>};
          for(const lane of ['candidate','reference'] as const){const db=physicalContext[lane];
            completed[lane]=await runLane(lane==='candidate'?candidate:native,db.source,db.target,db.ledger,population.requestedDates,lane==='candidate',population.cacheDates,scenario,
              {...(['no_op','unrelated_append'].includes(scenario)?{c06Provenance:{contract:'retained-source-phase-v1' as const,
                phase:scenario as 'no_op'|'unrelated_append',acceptedSourceReceiptSha256:await sha256Hex(canonicalJson(startupBase.receipt)),
                priorCompleteOutputSha256:await sha256Hex(canonicalJson(coldPair![lane].output)),analyticalNowMs:context.analyticalNowMs,storesRetained:true as const,
                action:scenario==='no_op'?'native-no-op-v2' as const:'native-append-v2' as const,actionReceiptSha256:await sha256Hex(canonicalJson(action))}}:{}),
                analyticalNowMs:context.analyticalNowMs,...(actionCheckpoints?{actionPreviewCheckpoint:actionCheckpoints[lane]}:{}),expectedOwnerDigests:expectedOwnerDigests??coldPair![lane].observedOwnerDigests,priorPublication:{output:coldPair![lane].output,rows:coldPair![lane].publicationRows!,analyticalNowMs:nowMs}});
            console.log('analytics-functional-branch-lane-complete',JSON.stringify({scenario,lane,complete:true,pairParity:'pending',profile:await checkpointProfile(completed[lane].profile),
              outputSha256:await sha256Hex(canonicalJson(completed[lane].output)),actualStoredPopulation:completed[lane].actualStoredPopulation}));
          }
          expect(completed.candidate.output).toEqual(completed.reference.output);
          assertFunctionalPublicationPair(completed.reference,completed.candidate);
          let effects:Record<string,unknown>={kind:scenario};
          if(scenario==='no_op'||scenario==='duplicate_delivery'||scenario==='stale_lease'||scenario==='device_revocation'||scenario==='opt_out_retained'){expect(completed.reference.output).toEqual(coldPair!.reference.output);assertFunctionalPublicationPair(coldPair!.reference,completed.reference);assertFunctionalPublicationPair(coldPair!.candidate,completed.candidate);effects={...effects,allFamiliesUnchanged:true};}
          if(scenario==='unrelated_append'||scenario==='old_correction'||scenario==='interruption'||scenario==='authority_lag'){
            const affectedDay=scenario==='old_correction'?corpus.correctionDay:corpus.v11DomainThroughDay;
            const events=(output:typeof completed.reference.output)=>output.cacheDays.reduce<number>((sum,raw)=>{
              const row=raw as {day:string;value:{aggregate:CacheRetentionDayAggregate}};return row.day===affectedDay?sum+row.value.aggregate.eventsRead:sum;},0);
            const before=events(coldPair!.reference.output),after=events(completed.reference.output);expect(after).toBe(before+1);
            if(scenario==='unrelated_append'||scenario==='interruption'){expect(population.requestedDates.every(day=>day<affectedDay!)).toBe(true);expect(completed.reference.output.daily).toEqual(coldPair!.reference.output.daily);}
            effects={...effects,affectedDays:1,affectedCacheEventsBefore:before,affectedCacheEventsAfter:after,affectedAggregateChanged:true,
              appendOutsideRequestedDays:scenario==='unrelated_append'||scenario==='interruption',requestedDailyUnchanged:canonicalJson(completed.reference.output.daily)===canonicalJson(coldPair!.reference.output.daily)};
          }
          if((nativeInputKinds as readonly string[]).includes(scenario))effects={...effects,nativeInputProved:true,
            publicChangedFamilies:Object.keys(completed.reference.output).filter(family=>
              canonicalJson(completed.reference.output[family as keyof typeof completed.reference.output])!==
              canonicalJson(coldPair!.reference.output[family as keyof typeof completed.reference.output]))};
          branchReports[scenario]={action,effects,previewActionProof,analyticalNowMs:context.analyticalNowMs,population,
            profiles:{reference:completed.reference.profile,candidate:completed.candidate.profile},expectedOwnerCount:completed.reference.observedOwnerDigests.length};
          return {outcome:'complete',completed};
          }catch(error){if(actionTrace)console.log('analytics-functional-action-incomplete',JSON.stringify({scenario,...actionTrace.diagnostic()}));throw error;}
          finally{actionTrace?.close();}
        });
        branchReports[scenario]={...(branchReports[scenario] as Record<string,unknown>),...(scenario==='restore_after_erasure'?{restoreBase:startupBase.receipt}:{}),startup:branch.receipt};
        const interim=branchReports[scenario] as {profiles:{reference:Awaited<ReturnType<typeof runLane>>['profile'];candidate:Awaited<ReturnType<typeof runLane>>['profile']}};
        console.log('analytics-functional-branch-complete',JSON.stringify({scenario,...(branchReports[scenario] as Record<string,unknown>),profiles:{reference:await checkpointProfile(interim.profiles.reference),candidate:await checkpointProfile(interim.profiles.candidate)}}));
      }
      console.log('analytics-functional-branches',JSON.stringify({schemaVersion:'analytics-retained-functional-branches-v1',referenceCommit:native.referenceCommit,
        wholeWorkloadQualification:false,runtimeObservationEnabled:false,sourceLineageEnabled,sharedIsolate:true,physicalStores:6,functionalAccountlessSecondary,secondaryOwnerKind:functionalAccountlessSecondary?'accountless':'social',outputDates:outputCount,sharedUniqueHistoryCalendarDays:calendarDays,
        analyticalNowMs:nowMs,previewCounterContract:NATIVE_PREVIEW_COUNTER_CONTRACT,publicationTimestampContract:PUBLICATION_TIMESTAMP_CONTRACT,retainedPublicationClockContract:RETAINED_FUNCTIONAL_CLOCK_CONTRACT,roleComposition:'actual-three-role-schedules-v1',
        optimizationProfiles:{reference:wholeWorkloadOptimizationProfile('native',nativeProfile),candidate:wholeWorkloadOptimizationProfile('canonical',nativeProfile)},
        sourceSnapshot,initialAdmission,laboratorySetup:summarizePair(laboratorySetup),sourceSchemaUpgrade:summarizePair(sourceUpgrade),cold:reports.cold,base:base.receipt,branches:branchReports,
        remainingGates:['Unexecuted functional case matrix and full466/30/365 traversal','Frozen owning Worker gate','Resource qualification remains separate; exact CPU/peak/physical bytes unavailable']}));
      return;
    }
    const summary={schemaVersion:functionalMutations?'analytics-persistent-mutation-functional-v1':integrationDebugDays?'analytics-integration-debug-v5':compare?'analytics-whole-workload-v6':'analytics-whole-workload-native-diagnostic-v2',cachePopulationDays:cacheDates.length,referenceCommit:native.referenceCommit,
      wholeWorkloadQualification:false,sourceLineageEnabled,runtimeObservationEnabled:Boolean(settings.VITE_WHOLE_WORKLOAD_OBSERVER_URL),integrationDebug:Boolean(integrationDebugDays),outputDates:outputCount,sharedUniqueHistoryCalendarDays:calendarDays,analyticalNowMs:nowMs,
      ...(sharedSeedScale?{sharedSeedScale:{contract:'accepted-shared-seed-v1',sourceProofSha256:sharedSeedProof,analyticalNowMs:nowMs,historyCalendarDays:466,requestedDates:outputCount}}:{}),
      nativePublicModelWindowDays:70,graphPopulation:compare?graphPopulation:null,initialAdmission,
      fixtureAdmission:'Maintained synthetic corpus helper with explicitly selected target-authority mode; all source admission production dependencies use the pinned native revision.',
      targetAuthority:compare?'ordered-delivery':'fixture-direct',
      sourceSchema:upgradeSource?'separate_native_pinned_candidate_upgraded':'separate_pinned_sources',sourceSchemaUpgrade:summarizePair(sourceUpgrade),
      sourceIsolation:SOURCE_SNAPSHOT_CONTRACT,sourceSnapshot,laboratorySetup:summarizePair(laboratorySetup),
      ...(functionalMutations?{functionalMutationExecution:{basis:'persistent-independent-physical-stores-shared-isolate-v1',physicalSources:2,physicalTargets:2,physicalLedgers:2,storesRetainedAcrossAllPhases:true,postColdSourceReplacements:0,comparativeHeapQualification:false,freshIsolateMutationQualification:false,proofContract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'}}:{}),
      admissionContract:functionalMutations?'Initial native admission is executed once and cloned exactly before candidate upgrade. Each later native action executes the same SQL/binds against both retained physical sources; actual admission, ordered delivery and raw snapshot proof costs are recorded separately. Local v2 permits only its proven administrative receipt differences; all public outputs and analytical clocks remain exact.':'Initial native admission is executed and measured once; the candidate receives the exact accepted logical snapshot. No second candidate admission measurement is inferred. Later isolated incremental mutation replay is not qualified.',
      costBoundaryContract:'Per-phase role/request/fence/cleanup/logical-inventory costs are complete measured lane work. Initial admission, per-lane laboratory schemas, snapshot import/proofs and candidate-only source upgrade are separate explicit cost records. Both local exporter calls have unknown resource metadata; no combined CPU, physical-byte or monetary qualification is claimed.',
      inputAdmission:summarizePair(admission),
      cacheDayComparison:compare?'Exact status and aggregate; native markKey storage handle is validated by its reader and excluded from cross-representation equality.':'Native stored markKey and aggregate.',
      publicationTimestampContract:PUBLICATION_TIMESTAMP_CONTRACT,
      optimizationProfiles:{reference:wholeWorkloadOptimizationProfile('native',nativeProfile),candidate:wholeWorkloadOptimizationProfile('canonical',nativeProfile)},
      dailyPopulationContract:'Identical requested/cache prerequisite dates plus seven carry days; every retained stored publication body and native visibility/refusal/expiry outcome is compared exactly, without timestamp normalization.',
      roleComposition:compare?'actual-three-role-schedules-v1':null,
      roleFailurePolicy:WHOLE_WORKLOAD_ROLE_FAILURE_POLICY,
      roleCompositionContract:compare?'Actual pinned/native and candidate analytics, cache and publication schedule entrypoints; external publication enabled and cache enabled, separate 950-statement source/target/ledger meters. Explicit optimizationProfiles preserve native B02/D02 and prepared usage defaults independently of candidate canonical representation. Repeated local role opportunities use the real operational clock; scoped calendar requests remain explicit.':null,
      graphRetentionContract:compare?'Both lanes run native graph retirement through idle before comparing the retained 70 model dates and current fits. Extra 365-stress calculations are compared at completion and may not remain stored; later warm requests obey native retired-checkpoint semantics.':null,
      graphRequestBasis:compare?'retained-plus-requested-calendar-v3-candidate-production-facade':'direct-kernel-request-v1',
      comparisonBasis:functionalMutations?'persistent-independent-physical-stores-shared-isolate-functional-v1':integrationDebugDays?'small-fresh-worker-retained-graph-cache-and-ordered-delivery-debug-v5':compare?'fresh-worker-retained-graph-cache-and-ordered-delivery-v6':'requested-date-cache-v1',
      measuredPhases:'Scope capture, native computation/checkpoints, daily/API, current scalar, historical owner models, native model/preview publication, cache carry/build/writes/public series, final visibility and cleanup.',
      pendingCases:WHOLE_WORKLOAD_CASES.filter(value=>!phases.includes(value)),
      remainingGates:functionalMutations?['Complete 23-case functional coverage map and frozen owning Worker gate','Full 466-day and wider request populations remain separate from this 10-day functional scenario','Complete C06 source-query lineage and no-rescan proof','Fresh-isolate incremental resource qualification, exact CPU/peak/physical bytes and fixed monetary basis remain open; tenfold target deferred by user']:['Production fair calendar chooser population and complete durable graph admission','Operational versus analytical clock qualification','Integrated P1-P10 candidate','Independent preparation and model-block adoption integration','All listed mutation/refusal/lease/erasure/restore cases','No unchanged raw-history scans on warm and unrelated append','Fixed common price sheet if monetary cost is computed','Measured whole repeated-history tenfold target','Final frozen owning Worker gate'],
      phases:reports};
    if(freshLane) {await transferLaboratory({kind:'write_lane',evidence:{completed:true,summary,snapshotImport}});console.log('analytics-workload-independent-lane-exit',JSON.stringify({lane:freshLane,completed:true,pairParity:'not_checked'}));}
    else console.log(functionalMutations?'analytics-functional-mutations':integrationDebugDays?'analytics-integration-debug':'analytics-whole-workload',JSON.stringify(summary));
  } finally { /* Native lease time and SQLite time both use the real clock. */ }
},1_800_000);
