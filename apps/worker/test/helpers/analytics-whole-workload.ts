import {canonicalJson} from '../../src/canonical-json';
import { createD1InvocationBudget } from '../../src/d1-invocation-budget';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile,
  type AnalyticsProfile, type AnalyticsStatementObserver } from './analytics-profile';

export const NATIVE_PUBLIC_GRAPH_WINDOW_DAYS=70;
/** Requested historical calculations and the native retained public graph are
 * separate populations. Current-day model output belongs to the latter. */
export function wholeWorkloadGraphPopulation(today:string,requestedDates:readonly string[]) {
 const ms=Date.parse(today+'T00:00:00.000Z'),dayMs=86_400_000;
 const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00.000Z'))
  &&new Date(Date.parse(day+'T00:00:00.000Z')).toISOString().slice(0,10)===day;
 if(!validDay(today)||![1,30,365].includes(requestedDates.length)||new Set(requestedDates).size!==requestedDates.length
  ||requestedDates.some(day=>!validDay(day)||day>=today))throw new Error('invalid whole-workload graph population');
 const requested=[...requestedDates].sort();
 for(let index=0;index<requested.length;index++)
  if(requested[index]!==new Date(ms-(requested.length-index)*dayMs).toISOString().slice(0,10))
   throw new Error('requested graph dates must be the complete preceding calendar');
 const retainedModelDates=Array.from({length:NATIVE_PUBLIC_GRAPH_WINDOW_DAYS},(_,index)=>
  new Date(ms-(NATIVE_PUBLIC_GRAPH_WINDOW_DAYS-1-index)*dayMs).toISOString().slice(0,10));
 const retained=new Set(retainedModelDates),requestedSet=new Set(requested);
 return {requestedDates:requested,retainedModelDates,calculatedModelDates:[...new Set([...requested,...retainedModelDates])].sort(),
  extraRequestedDates:requested.filter(day=>!retained.has(day)),maintainedOnlyDates:retainedModelDates.filter(day=>!requestedSet.has(day))};
}

export const WHOLE_WORKLOAD_CASES = Object.freeze([
  'cold','warm','no_op','unrelated_append','old_correction','cross_day_move',
  'timestamp_move','quota_change','plan_change','price_change','method_change',
  'runtime_activation','empty_day_arrival','clock_rollover','equal_time_ties',
  'partial_migration','authority_lag','stale_lease','duplicate_delivery',
  'interruption','withdrawal','physical_erasure','restore_after_erasure',
]);
export const WHOLE_WORKLOAD_PHASES = Object.freeze([
  'admission','owner_metadata','delivery','preparation','scheduler','analytics_role','cache_role','publication_role','closure','daily_publication','scope_capture',
  'graph_admission','graph_request','model_compute','current_scalar','adoption','cache_build','cache_write',
  'model_publication','preview_publication','final_visibility','cleanup','logical_inventory',
]);

export type WholeWorkloadRepresentation='native'|'canonical';
export type WholeWorkloadNativeProfile='optimized'|'unshared-diagnostic';
/** Representation and already deployed optimization switches are independent.
 * The unshared oracle is retained only as an explicitly named diagnostic. */
export function wholeWorkloadOptimizationProfile(representation:WholeWorkloadRepresentation,nativeProfile:WholeWorkloadNativeProfile='optimized') {
 if(!['native','canonical'].includes(representation)||!['optimized','unshared-diagnostic'].includes(nativeProfile))
  throw new Error('invalid whole-workload optimization profile');
 return Object.freeze({representation,nativeProfile,canonicalPipeline:representation==='canonical',
  sharedFeatures:representation==='canonical'||nativeProfile==='optimized',
  cacheSharedFeatures:nativeProfile==='optimized',modelBlocks:nativeProfile==='optimized',
  preparedFold:true as const,preparedEffectiveUsage:'native-default' as const,
  performanceBasis:nativeProfile==='optimized'?'existing-native-optimizations-v1':'unshared-oracle-diagnostic-only-v1'});
}
export function wholeWorkloadDailyPopulation(requestedDates:readonly string[],cacheDates:readonly string[]) {
 return [...new Set([...requestedDates,...cacheDates].flatMap(day=>{
  const anchor=Date.parse(day+'T00:00:00.000Z');
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(day)||!Number.isFinite(anchor)||new Date(anchor).toISOString().slice(0,10)!==day)
   throw new Error('invalid daily prerequisite date');
  return Array.from({length:8},(_,index)=>new Date(anchor-index*86_400_000).toISOString().slice(0,10));
 }))].sort();
}
/** Explicit local role configuration, shared by smoke and measured execution. */
export function wholeWorkloadRoleEnvironment(db:{source:D1Database;target:D1Database;ledger:D1Database},
 sourceId:string,sourceNamespace:string,profile:ReturnType<typeof wholeWorkloadOptimizationProfile>) {
 return {STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,DELETION_LEDGER:db.ledger,
  STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,
  STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',PUBLICATION_LANE:'enabled',
  PUBLICATION_LANE_EXTERNAL:'enabled',CACHE_RETENTION_BUILD:'enabled',
  STORAGE_ANALYTICS_MODEL_BLOCKS:profile.modelBlocks?'enabled' as const:'disabled' as const,
  STORAGE_ANALYTICS_SHARED_FEATURES:profile.sharedFeatures?'enabled' as const:'disabled' as const,
  CACHE_RETENTION_SHARED_FEATURES:profile.cacheSharedFeatures?'enabled' as const:'disabled' as const,
  ...(profile.canonicalPipeline?{STORAGE_ANALYTICS_CANONICAL_PIPELINE:'enabled' as const}:{})} as const;
}

/** There is no reset between scope capture and computation. All nested source
 * and target calls share one meter, and rejected/retried calls remain counted. */
export function createWholeWorkloadMeter(source: D1Database, target: D1Database,
 compose?:(db:{source:D1Database;target:D1Database})=>{source:D1Database;target:D1Database},
 makeBudget:typeof createD1InvocationBudget=createD1InvocationBudget,ledger?:D1Database,
 observeStatement?:AnalyticsStatementObserver,
 targetObserver?:{wrap(target:D1Database):D1Database;enterInvocation(target:D1Database):()=>void}) {
  const profile = createAnalyticsProfile();
  const invocationEvidence={contract:'actual-whole-invocation-reconciliation-v1' as const,invocations:0,
    actualStatements:0,profiledStatements:0,sourceStatements:0,failedReconciliations:0,activeInvocations:0};
  const sourceStatements=()=>Object.entries(profile.costs).filter(([key])=>key.split('.')[1]==='source').reduce((n,[,value])=>n+value.statements,0);
  let phase = 'owner_metadata';
  const profiledTarget=profileAnalyticsDatabase(target,'target',profile,()=>phase,observeStatement);
  const observed = { source: profileAnalyticsDatabase(source,'source',profile,()=>phase,observeStatement),
    target: targetObserver?targetObserver.wrap(profiledTarget):profiledTarget };
  const observedLedger=ledger?profileAnalyticsDatabase(ledger,'ledger',profile,()=>phase,observeStatement):undefined;
  return { profile, invocationEvidence:()=>({...invocationEvidence}), setPhase(value:string) {
    if (!(WHOLE_WORKLOAD_PHASES as readonly string[]).includes(value)) throw new Error('unknown workload phase');
    phase=value;
  }, async invocation<T>(operation:string,
    run:(db:typeof observed,meter:ReturnType<typeof createD1InvocationBudget>,ledger?:D1Database)=>Promise<T>):Promise<T> {
    const meter=makeBudget(950),before=summarizeAnalyticsProfile(profile).statements,sourceBefore=sourceStatements();
    invocationEvidence.activeInvocations++;
    const started=performance.now();
    const leaveTargetObserver=targetObserver?.enterInvocation(meter.wrap(profiledTarget));
    try { const db=compose?compose(observed):observed;
      return await run({source:meter.wrap(db.source),target:meter.wrap(db.target)},meter,observedLedger?meter.wrap(observedLedger):undefined); }
    finally {
      leaveTargetObserver?.();
      const count=summarizeAnalyticsProfile(profile).statements-before;
      invocationEvidence.activeInvocations--;invocationEvidence.invocations++;invocationEvidence.actualStatements+=meter.queriesUsed;
      invocationEvidence.profiledStatements+=count;invocationEvidence.sourceStatements+=sourceStatements()-sourceBefore;
      if(count!==meter.queriesUsed)invocationEvidence.failedReconciliations++;
      if(count!==meter.queriesUsed)throw new Error(`whole workload statement accounting mismatch: ${operation}, profiled=${count}, metered=${meter.queriesUsed}`);
      profile.invocations++;
      profile.operationInvocations[operation]=(profile.operationInvocations[operation]??0)+1;
      profile.maximumStatementsPerInvocation=Math.max(profile.maximumStatementsPerInvocation,meter.queriesUsed);
      profile.operationWallMs[operation]=(profile.operationWallMs[operation]??0)+performance.now()-started;
    }
  }};
}
export function summarizeWholeWorkload(profile:AnalyticsProfile) {
  return {...summarizeAnalyticsProfile(profile),
    phaseStatements:Object.fromEntries(WHOLE_WORKLOAD_PHASES.map(phase=>[phase,
      Object.entries(profile.costs).filter(([key])=>key.startsWith(`${phase}.`))
        .reduce((sum,[,value])=>sum+value.statements,0)])),
    resourceRateBasis:{id:'cloudflare-paid-standard-gross-2026-10-01',currency:'USD',
      d1ReadRowUsd:1e-9,d1WrittenRowUsd:1e-6,workerRequestUsd:3e-7,workerCpuMsUsd:2e-8,d1StorageGbMonthUsd:0.75,
      sources:['https://developers.cloudflare.com/workers/platform/pricing/','https://developers.cloudflare.com/d1/platform/pricing/'],
      contract:'Gross published paid Standard rates before included allowances; a modeled resource basis, not an account bill or marginal charge.'},
    measuredD1SubtotalUsd:Math.round(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsRead*1e-9+cost.rowsWritten*1e-6,0)*1e12)/1e12,
    cost:null,costUnavailableReason:'Only measured D1 rows are priced. Billable entrypoint mapping, exact CPU, cloud storage duration, failed-SQL resources and account allowances remain unqualified. Invocation counters are not billable request counts.',
    failedSqlResourceDimensionsUnknown:Object.values(profile.costs).some(cost=>cost.failedStatements>0),
  };
}

export const PUBLICATION_TIMESTAMP_CONTRACT = 'strict-common-analytical-clock-v1: both reviewed bundles publish under the same explicit analytical clock; payloads, stored timestamps, hashes and complete DTOs compare exactly. Real leases, deadlines and cohort expiry retain operational clocks. No timestamp normalization.';
/** Check only named public fields; never rewrite the output or an opaque hash. */
export function validateWholeWorkloadPublicationTimes<T>(value:T,nowMs:number):{output:T;timestampsChecked:number} {
 if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new Error('invalid publication clock');
 const time=new Date(nowMs).toISOString();let timestampsChecked=0;
 const check=(instant:unknown)=>{if(instant!==time)throw new Error('publication timestamp differs from analytical clock');timestampsChecked++;};
 const row=(input:unknown,key:'released_at'|'generated_at',payloadKey:'releasedAt'|'generatedAt')=>{
  if(!input||typeof input!=='object')throw new Error('invalid publication row');
  const item=input as Record<string,unknown>;
  if(typeof item.payload_json!=='string')throw new Error('invalid publication payload');
  const payload=JSON.parse(item.payload_json) as Record<string,unknown>;
  if(payload[payloadKey]!==item[key])throw new Error('publication timestamp mismatch');check(item[key]);
 };
 const visible=(input:unknown)=>{
  const item=input as {rows:unknown[];allowanceBreakdownsCache:unknown};
  for(const itemRow of item.rows)row(itemRow,'released_at','releasedAt');
  if(item.allowanceBreakdownsCache)row(item.allowanceBreakdownsCache,'generated_at','generatedAt');
 };
 const output=value as {preview:{generatedAt:unknown};daily:{value:unknown}[];publishedDaily?:{stored:unknown[];visible:unknown}[]};
 check(output.preview.generatedAt);
 for(const day of output.daily)visible(day.value);
 for(const day of output.publishedDaily??[]){for(const stored of day.stored)row(stored,'released_at','releasedAt');visible(day.visible);}
 return {output:value,timestampsChecked};
}

/** Scheduled roles already record best-effort lane faults. Request completion
 * still requires its own exact result guard after bounded real opportunities. */
export const WHOLE_WORKLOAD_ROLE_FAILURE_POLICY='record-and-bound-output-retries-v1';
export async function completeBoundedWholeWorkloadRequest<T>(input:{
 limit:number;request:(attempt:number)=>Promise<T>;complete:(result:T)=>boolean;
 advanceRoles:()=>Promise<unknown>;exhaustedMessage:string;
}):Promise<T> {
 if(!Number.isSafeInteger(input.limit)||input.limit<1)throw new Error('invalid workload request bound');
 for(let attempt=0;attempt<input.limit;attempt++) {
  const result=await input.request(attempt);
  if(input.complete(result))return result;
  await input.advanceRoles();
 }
 throw new Error(input.exhaustedMessage);
}

/** Lossless JSON transport of complete synthetic DTOs to the local controller.
 * Undefined members and negative zero remain distinct; unsupported values fail. */
export function encodeWholeWorkloadValue(value:unknown,depth=0):unknown {
 if(depth>128)throw new Error('complete DTO depth bound');
 if(value===undefined)return ['undefined'];if(value===null)return ['null'];
 if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
 if(typeof value==='number') {if(!Number.isFinite(value))throw new Error('nonfinite complete DTO number');return Object.is(value,-0)?['negative_zero']:['number',value];}
 if(Array.isArray(value))return ['array',value.map(child=>encodeWholeWorkloadValue(child,depth+1))];
 if(typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return ['object',Object.keys(value).map(key=>[key,encodeWholeWorkloadValue(Reflect.get(value,key),depth+1)])];
 throw new Error('unsupported complete DTO value');
}

/** Same selected owner/day lease lifecycle as native scheduling, with explicit
 * requested calendar instead of its chooser. Blocks keep their native range,
 * target adoption and unsupported-only fallback; no analytical kernel repair. */
export async function advanceNativeWholeWorkloadGraph(input:{
 kernel:typeof import('./analytics-native-reference');
 bindings:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string};
 owner:import('../../src/storage-community-authority').StorageCommunityOwner&{ownerDigest:string};day:string;metric:'fits'|'model';
 meter:ReturnType<typeof createD1InvocationBudget>;profile:ReturnType<typeof wholeWorkloadOptimizationProfile>;
 leased:boolean;setPhase:(phase:string)=>void;observeBlock?:(event:'start'|'complete'|'end')=>void;
 scopeBlockSource?:(source:D1Database)=>D1Database;
}):Promise<Awaited<ReturnType<typeof input.kernel.computeStorageGraphResult>>> {
 const {kernel,bindings,owner,day,metric,meter,profile,setPhase}=input;
 const capture=()=>kernel.captureStorageGraphScope(bindings.source,{owner,day,metric,
  sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,preparedFold:profile.preparedFold});
 let scope:Awaited<ReturnType<typeof capture>>;
 const compute=()=>kernel.computeStorageGraphResult(bindings,scope,{maxQueries:meter.remainingQueries-(input.leased?40:0),
  deadlineMs:Date.now()+60_000,preparedFold:profile.preparedFold,sharedFeatures:profile.sharedFeatures});
 if(!input.leased){setPhase('scope_capture');scope=await capture();setPhase(metric==='model'?'model_compute':'current_scalar');return compute();}
 setPhase('graph_admission');
 const key={sourceId:bindings.sourceId,ownerDigest:owner.ownerDigest,day,metric};
 const existing=await kernel.readStorageGraphWorkSelection(bindings.target,key);
 let selection:import('../../src/storage-community-graph-selection').StorageGraphWorkSelection|null=null;
 if(existing&&existing.state!=='complete') {
  selection=await kernel.loadLiveStorageGraphWorkSelection({...bindings,key,nowMs:Date.now()});
  if(!selection)return {state:'deferred',reason:'selection_invalidated'};
 }else{
  setPhase('scope_capture');scope=await capture();
  if(scope.source!=='effective')throw new Error('scoped fixture requires effective graph selection');
  setPhase('graph_admission');
  const ensured=await kernel.ensureStorageGraphWorkSelection({...bindings,nowMs:Date.now(),
   ...(existing?{expectedRevision:existing.revision}:{}),envelope:{version:2,source:'effective',...key,
    sourceNamespace:bindings.sourceNamespace,fixedNow:scope.fixedNow,dependencyDigest:scope.dependencyDigest,
    checkpointDependencyDigest:scope.checkpointDependencyDigest,targetAuthorityEpoch:scope.owner.authorityEpoch,
    participantId:scope.owner.participantId,ownerRevision:scope.owner.ownerRevision}});
  if(!('selection' in ensured)||!ensured.selection||ensured.status==='conflict')return {state:'deferred',reason:'selection_changed'};
  selection=ensured.selection;
 }
 const claimToken=crypto.randomUUID();
 const claimed=await kernel.claimStorageGraphWorkSelection({...bindings,selection,claimToken,nowMs:Date.now()});
 if(claimed.status!=='claimed'||!claimed.selection)return {state:'deferred',reason:'selection_busy'};
 selection=claimed.selection;
 try {
  setPhase('scope_capture');scope=await capture();const envelope=selection.envelope;
  if(envelope.source!=='effective'||scope.source!=='effective'||envelope.day!==scope.day||envelope.metric!==scope.metric
   ||envelope.fixedNow!==scope.fixedNow||envelope.dependencyDigest!==scope.dependencyDigest
   ||envelope.checkpointDependencyDigest!==scope.checkpointDependencyDigest||envelope.participantId!==scope.owner.participantId
   ||envelope.ownerRevision!==scope.owner.ownerRevision||envelope.targetAuthorityEpoch!==scope.owner.authorityEpoch){
   setPhase('graph_admission');await kernel.discardStorageGraphWorkSelection(bindings.target,selection);selection=null;
   return {state:'deferred',reason:'selection_changed'};
  }
  if(meter.remainingQueries<90)return {state:'deferred',reason:'query_budget'};
  setPhase(metric==='model'?'model_compute':'current_scalar');
  const today=new Date(kernel.publicationClockAdapted?kernel.readAnalyticsWorkloadPublicationClock():Date.now()).toISOString().slice(0,10);
  let result:Awaited<ReturnType<typeof kernel.computeStorageGraphResult>>|undefined,completedBlock=false;
  if(profile.modelBlocks&&metric==='model'&&day<today&&kernel.planHistoricalModelBlockRanges(today)
   .some(range=>range.outputFromDay<=day&&day<=range.outputThroughDay)) {
   let block:Awaited<ReturnType<typeof kernel.advanceStorageModelBlockGraphWork>>;input.observeBlock?.('start');
   try{block=await kernel.advanceStorageModelBlockGraphWork({...bindings,...(input.scopeBlockSource?{source:input.scopeBlockSource(bindings.source)}:{}),scope,nowMs:Date.now(),maxQueries:meter.remainingQueries-40,
    deadlineMs:Date.now()+60_000,sharedFeatures:profile.sharedFeatures});}
   finally{input.observeBlock?.('end');}
   if(block.state!=='unsupported') {
    if(block.state!=='complete')return {state:'deferred',reason:block.reason??'block_deferred'};
    setPhase('final_visibility');const visible=await kernel.readStorageGraphResult(bindings,scope);
    if(!visible)return {state:'deferred',reason:'result_visibility_changed'};
    result={state:'complete',result:visible,reused:block.reused===true};completedBlock=true;
   }
  }
  result??=await compute();
  if(result.state==='complete') {
   setPhase('adoption');const complete=await kernel.completeStorageGraphWorkSelection({target:bindings.target,selection,claimToken});
   if(complete.status!=='completed')return {state:'deferred',reason:'selection_changed'};
   selection=null;if(completedBlock)input.observeBlock?.('complete');
  }
  return result;
 }finally{if(selection){setPhase('graph_admission');await kernel.releaseStorageGraphWorkSelection({target:bindings.target,selection,claimToken});}}
}

export const WHOLE_WORKLOAD_C06_PHASES=['warm','no_op','unrelated_append'] as const;
export type WholeWorkloadSourceConsumer='cohort'|'daily'|'api'|'scalar'|'model'|'block'|'cache'|'publication'|'fixture'|'unclassified';
/** Labels actual harness entrypoints. Mixed scheduled analytics stays unknown. */
export function wholeWorkloadSourceConsumer(operation:string,metric?:'fits'|'model'):WholeWorkloadSourceConsumer {
 if(['scoped_graph_production_request','scoped_graph_production_visibility','scoped_graph_request'].includes(operation))return metric==='fits'?'scalar':metric==='model'?'model':'unclassified';
 if(['owner_metadata','reference_delivery_closure','candidate_source_closure','candidate_owner_pin_progress'].includes(operation))return 'cohort';
 if(operation==='daily_publication')return 'daily';
 if(['daily_api_visibility','daily_population_visibility'].includes(operation))return 'api';
 if(['model_publication','model_visibility','preview_publication','preview_visibility','candidate_publication_population','publication_schedule'].includes(operation))return 'publication';
 if(['cache_schedule','canonical_cache_day_visibility','cache_scope','cache_carry','cache_build','cache_write','cache_visibility','cache_series'].includes(operation))return 'cache';
 if(operation.startsWith('logical_inventory_')||['preview_counter_start','preview_counter_finish','actual_stored_population','functional_publication_rows','daily_population_dates','candidate_progress','candidate_source_progress'].includes(operation))return 'fixture';
 return 'unclassified';
}
/** Records successful entrypoints only. The caller registers this evidence
 * after the complete public-output proof, never on a deferred/null read. */
export function wholeWorkloadConsumerCompleted(operation:string,value:unknown):boolean {
 if(operation==='owner_metadata')return Array.isArray(value);
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const result=value as Record<string,unknown>;
 if(operation==='daily_api_visibility')return Array.isArray(result.rows);
 if(operation==='daily_population_visibility')return Array.isArray(result.stored)&&Boolean(result.visible&&typeof result.visible==='object'&&Array.isArray((result.visible as Record<string,unknown>).rows));
 if(['model_visibility','preview_visibility'].includes(operation))return typeof result.payload_json==='string'&&typeof result.payload_sha256==='string';
 if(operation==='cache_visibility')return result.status==='ready'&&Boolean(result.aggregate&&typeof result.aggregate==='object');
 if(['canonical_cache_day_visibility','cache_series'].includes(operation))return true;
 if(['daily_publication','model_publication','preview_publication'].includes(operation))return result.state==='published'||result.state==='unchanged';
 if(['scoped_graph_request','scoped_graph_production_request','scoped_graph_production_visibility'].includes(operation))return result.state==='complete'||result.state==='reused';
 return false;
}
/** Read-only setup/EXPLAIN work is deliberately outside analytical invocations.
 * Each dispatched diagnostic statement owns a separate actual950 meter. */
export function createWholeWorkloadSourceDiagnostic(source:D1Database){
 const meter=createWholeWorkloadMeter(source,source);meter.setPhase('scope_capture');let attempted=0,refused=0;
 const prepared=(sql:string,values:unknown[]=[]):D1PreparedStatement=>({bind:(...next:unknown[])=>prepared(sql,next),
  all:async()=>{attempted++;if(attempted>10000||!(/^(?:SELECT\b|EXPLAIN\s|PRAGMA (?:table_xinfo|index_xinfo)\()/u.test(sql))){refused++;throw Error('C06_DIAGNOSTIC_SQL_BOUND');}
   return meter.invocation('c06_source_diagnostic',db=>db.source.prepare(sql).bind(...values).all());},
 } as D1PreparedStatement);
 const database={prepare:prepared} as D1Database;
 return {database,report:()=>({contract:'c06-separate-readonly-diagnostic-meter-v1',actualStatementLimitPerInvocation:950,
  separateFromAnalyticalPhase:true,oneStatementPerDiagnosticInvocation:true,attempted,refused,profile:{...summarizeWholeWorkload(meter.profile),wallMs:Object.values(meter.profile.operationWallMs).reduce((n,value)=>n+value,0)}})};
}
