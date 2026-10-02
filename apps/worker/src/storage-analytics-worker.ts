import {recordAnalyticsPipelineRuntime} from './storage-analytics-runtime-controls';
import {runCanonicalAnalyticsWorkPass,type CanonicalAnalyticsWorkPassProgress} from './storage-analytics-canonical-runtime';
import { withMaintainedEffectiveDependencies } from './storage-effective-dependency-summaries';
import { advanceStorageAnalyticsPreparation, type StorageAnalyticsPreparationResult } from './storage-analytics-preparation';
import { graphDayProjectionBuildEnabled, runStorageAnalyticsPass } from './storage-analytics-runtime';
import { storageV11PreparedFoldEnabled } from './storage-v11-history';
import { createGraphDayProjectionSourceBuild } from './graph-day-projection';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { publicAnalyticsEnabled } from './public-analytics-gate';
import { storageGraphFailureFields } from './storage-analytics-failure';
import { analyticsFeatureControls,type AnalyticsFeatureControlEnv } from './analytics-feature-controls';

/** Separate scheduler entry point; it has no upload route or credential binding.
 * Resource binding/deployment belongs to the qualified Wrangler role plan. */
export interface StorageAnalyticsWorkerEnv extends AnalyticsFeatureControlEnv {
 STORAGE_ANALYTICS_MODE?:'disabled'|'enabled';
 PUBLIC_ANALYTICS_MODE?:'disabled'|'enabled';
 STORAGE_SOURCE_ID?:string;
 TELEMETRY_STORAGE_NAMESPACE?:string;
 STORAGE_INGESTION_DB?:D1Database;
 STORAGE_ANALYTICS_DB?:D1Database;
 DELETION_LEDGER?:D1Database;
 /** Deployment switch for the prepared-graph-day builder. Default OFF: the
  * fold does not read these rows yet, so building them is an explicit operator
  * decision and never a consequence of deploying this code. */
 GRAPH_DAY_PROJECTION_BUILD?:'disabled'|'enabled';
 /** Switches the prepared-day FOLD on. Separate from the builder's switch so
  * the artifacts can be built and verified for as long as wanted before any
  * result is computed from them, and so the fold can be reverted on its own. */
 GRAPH_DAY_PROJECTION_FOLD?:'disabled'|'enabled';
 /** Let the builder take the bulk of the graph-only long pass while coverage is
  * incomplete. Revertible independently of the builder and the fold. */
 GRAPH_DAY_PROJECTION_LONG_PASS?:'disabled'|'enabled';
}
/** One deployed trigger drives both passes. A second, ten-minute trigger does
 * not produce a second invocation: with both registered, the platform delivered
 * exactly one invocation at each tenth minute, carrying the minute expression,
 * so a pass selected by cron string never ran. The invocation's own UTC minute
 * selects the pass instead, and the delivered expression is accepted for
 * diagnostics only. Deploy this Worker with this one trigger. */
export const STORAGE_ANALYTICS_MINUTE_CRON='* * * * *';
/** Every tenth UTC minute gives the graph lane the long window. */
export const STORAGE_ANALYTICS_LONG_PASS_MINUTES=10;
/** Eight minutes, well inside the fifteen-minute cron wall-clock allowance and
 * leaving the kernel's own save headroom and this invocation's final release
 * inside it. The shared meter binds first in any case: the graph phase starts
 * with roughly 725 statements once delivery has taken its share, which is about
 * four to five minutes of paged reads at production latency. The window is also
 * kept short enough that a lease outliving it still expires before the next
 * long tick. The deployed Worker must set limits.cpu_ms to 300000. */
const LONG_PASS_WINDOW_MS=8*60_000;
/** Nine and a half minutes: longer than the window, so a pass that works for
 * its whole window still holds its claim at the end and no concurrent pass
 * forks the same owner-day; and shorter than the ten-minute long-pass cadence,
 * so a claim abandoned by a killed isolate has expired before the next long
 * pass and that owner-day is skipped once rather than twice. Both bounds are
 * validated by the pass against its own deadline. */
const LONG_PASS_GRAPH_LEASE_MS=570_000;
/** Recovery is reserved for a verified public-authority gap. Leave enough of
 * the shared invocation meter for the public phase if delivery becomes idle. */
const AUTHORITY_RECOVERY_DELIVERY_QUERIES=850;
/** Public work has an initial capacity/cleanup phase before its 100-query
 * iteration floor. Leave a modest statement margin above that floor. */
const PUBLIC_PHASE_ADMISSION_QUERIES=140;
async function authorityRecoveryAdmitted(bindings:{source:D1Database;target:D1Database;
 sourceId:string;sourceNamespace:string}):Promise<boolean> {
 // Both indexed singleton/key reads use the same invocation meter as the
 // passes. A missing cursor can be an ordinary bootstrap state. Missing or
 // malformed metadata cannot grant the longer delivery window; the normal
 // pass retains its own complete runtime/source identity checks.
 const source=await bindings.source.prepare(`SELECT s.source_id AS sourceId,
  a.source_namespace AS v1Namespace,b.source_namespace AS v11Namespace,
  s.authority_epoch AS authorityEpoch FROM storage_source_state s
  JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
  JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1
  WHERE s.singleton=1`).first<{sourceId:unknown;v1Namespace:unknown;v11Namespace:unknown;
   authorityEpoch:unknown}>();
 const target=await bindings.target.prepare(`SELECT r.source_id AS sourceId,
  r.source_namespace AS sourceNamespace,r.contract_version AS contractVersion,
  c.sequence AS cursorSequence,c.authority_epoch AS cursorEpoch
  FROM analytics_runtime_sources r JOIN analytics_source_cursors c ON c.source_id=r.source_id
  WHERE r.source_id=?`).bind(bindings.sourceId).first<{sourceId:unknown;sourceNamespace:unknown;
   contractVersion:unknown;cursorSequence:unknown;cursorEpoch:unknown}>();
 if(!source||source.sourceId!==bindings.sourceId||source.v1Namespace!==bindings.sourceNamespace
  ||source.v11Namespace!==bindings.sourceNamespace||!Number.isSafeInteger(source.authorityEpoch)
  ||(source.authorityEpoch as number)<0||!target||target.sourceId!==bindings.sourceId
  ||target.sourceNamespace!==bindings.sourceNamespace||target.contractVersion!==1
  ||!Number.isSafeInteger(target.cursorSequence)||(target.cursorSequence as number)<0
  ||!Number.isSafeInteger(target.cursorEpoch)||(target.cursorEpoch as number)<0
  ||(target.cursorEpoch as number)>(source.authorityEpoch as number))return false;
 return (source.authorityEpoch as number)>(target.cursorEpoch as number);
}
/** Do not expose account identifiers, SQL, credentials or a stored record in
 * diagnostics. Retain the durable cursor and make scheduler failure visible.
 * Internal failure constants are closed uppercase identifiers; provider or
 * runtime messages (spaces, SQL, punctuation) never match and stay hidden. */
function reportScheduleFailure(event:'storage_analytics_schedule'|'storage_analytics_long_schedule',error:unknown):never {
 const message=error instanceof Error?error.message:'';
 const code=/^[A-Z][A-Z0-9_]{2,63}$/.test(message)?{code:message}:{};
 console.error(JSON.stringify({event,state:'unavailable',...code,...storageGraphFailureFields(error)}));
 throw new Error('STORAGE_ANALYTICS_UNAVAILABLE');
}
export async function runStorageAnalyticsSchedule(env:StorageAnalyticsWorkerEnv,
 options?:{cron?:string;nowMs?:number}):Promise<void> {
 if(env.STORAGE_ANALYTICS_MODE===undefined||env.STORAGE_ANALYTICS_MODE==='disabled')return;
 if(env.STORAGE_ANALYTICS_MODE!=='enabled'||!env.STORAGE_INGESTION_DB||!env.STORAGE_ANALYTICS_DB
  ||!env.DELETION_LEDGER||!env.STORAGE_SOURCE_ID||!env.TELEMETRY_STORAGE_NAMESPACE
  ||(options?.cron!==undefined&&typeof options.cron!=='string')
  ||(options?.nowMs!==undefined&&(!Number.isSafeInteger(options.nowMs)||options.nowMs<0)))throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
 const publishCommunity=publicAnalyticsEnabled(env);
 const features=analyticsFeatureControls(env);
 // Once the publication worker is live this worker stops publishing, so the two
 // never share a 55-second window. Unset means this worker keeps the lane, so
 // deploying the split changes nothing until both switches are thrown.
 const skipPublication=Reflect.get(env,'PUBLICATION_LANE_EXTERNAL')==='enabled';
 // Which pass runs is a property of the scheduled minute, not of the delivered
 // cron expression. With publication deployed off there is no graph lane at
 // all, so every invocation stays on the ordinary bounded pass.
 const longPass=publishCommunity
  &&new Date(options?.nowMs??Date.now()).getUTCMinutes()%STORAGE_ANALYTICS_LONG_PASS_MINUTES===0;
 const event=longPass?'storage_analytics_long_schedule':'storage_analytics_schedule';
 try {
  // Leave 50 of the paid D1 invocation's 1,000-query ceiling unused.
  const meter=createD1InvocationBudget(950);
  const bindings={source:meter.wrap(features.canonicalPipeline?withMaintainedEffectiveDependencies(env.STORAGE_INGESTION_DB,
    env.STORAGE_ANALYTICS_DB,env.STORAGE_SOURCE_ID,env.TELEMETRY_STORAGE_NAMESPACE):env.STORAGE_INGESTION_DB),
   target:meter.wrap(env.STORAGE_ANALYTICS_DB),
   sourceId:env.STORAGE_SOURCE_ID,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,ledger:meter.wrap(env.DELETION_LEDGER)};
  if(env.STORAGE_ANALYTICS_CANONICAL_PIPELINE!==undefined)await recordAnalyticsPipelineRuntime(meter.wrap(env.STORAGE_ANALYTICS_DB),env.STORAGE_SOURCE_ID,{
   role:'analytics',method:'maintained-analytics-v1',canonicalPipeline:features.canonicalPipeline,
   sharedFeatures:features.sharedFeatures||features.canonicalPipeline,modelBlocks:features.modelBlocks,
   degree:1,queryLimit:950,observedMs:Date.now()});
  // Give ordered delivery its own bounded opportunity before expensive graph
  // work, on every invocation including the long one, so ingestion delivery
  // never skips a minute. Both sequential phases share one actual-statement
  // meter; within this invocation they are sequential, with one cursor writer
  // and no independent query allowances. The second phase uses the rest of the
  // invocation's work window: the minute's, or the long pass's eight minutes. Graph
  // checkpoints reserve their own final save time. A slow in-flight query can
  // overrun this cooperative deadline; subsequent work must still stop rather
  // than receive a fresh allowance.
  const started=Date.now(),deadlineMs=started+(longPass?LONG_PASS_WINDOW_MS:55_000);
  // Cron's scheduled instant can precede isolate startup. Recovery must not
  // consume the next minute's opportunity even when this invocation starts
  // late; the ordinary public phase keeps its existing 55-second deadline.
  const recoveryDeadlineMs=Math.min(started+45_000,(options?.nowMs??started)+45_000);
  const authorityLag=publishCommunity&&!longPass?await authorityRecoveryAdmitted(bindings):false;
  const recoveryAdmitted=authorityLag&&recoveryDeadlineMs-Date.now()>=5_000;
  const deliveryStarted=Date.now();
  const delivery=publishCommunity?await runStorageAnalyticsPass({...bindings,publishCommunity:false,
   maxSteps:32,maxQueries:recoveryAdmitted
    ?Math.min(AUTHORITY_RECOVERY_DELIVERY_QUERIES,meter.remainingQueries):175,
   deadlineMs:recoveryAdmitted?recoveryDeadlineMs:started+10_000}):null;
  const deliveryElapsedMs=publishCommunity?Date.now()-deliveryStarted:0;
  const deliveryComplete=!recoveryAdmitted||delivery?.state==='idle'&&delivery.reason==='complete';
  if(Date.now()>=deadlineMs){
   console.log(JSON.stringify({event,...delivery,state:'deferred',reason:'deadline',
    recoveryAdmitted,deliveryElapsedMs,
    deliverySteps:delivery?.steps??0,deliveryRecordsRead:delivery?.recordsRead??0,
    deliveryQueriesUsed:delivery?.queriesUsed??0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0,
    queriesUsed:meter.queriesUsed}));return;
  }
  if(!deliveryComplete||meter.remainingQueries===0
   ||recoveryAdmitted&&meter.remainingQueries<PUBLIC_PHASE_ADMISSION_QUERIES){
   console.log(JSON.stringify({event,...delivery,state:'deferred',
    reason:deliveryComplete?'query_budget':delivery?.reason??'query_budget',
    recoveryAdmitted,deliveryElapsedMs,
    deliverySteps:delivery?.steps??0,deliveryRecordsRead:delivery?.recordsRead??0,
    deliveryQueriesUsed:delivery?.queriesUsed??0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0,
    queriesUsed:meter.queriesUsed}));return;
  }
  // Independent day preparation receives a bounded opening slice on the
  // existing trigger. It shares the actual invocation meter and leaves the
  // graph lane's ordinary 550-statement admission plus a small margin intact.
  // Consumers retain their own schedules, source proofs and refusal fallback.
  let canonicalWork:CanonicalAnalyticsWorkPassProgress|undefined;
  if(features.canonicalPipeline&&publishCommunity&&meter.remainingQueries>=180){
   canonicalWork=await runCanonicalAnalyticsWorkPass({...bindings,invocation:meter,now:Date.now,modelBlocks:features.modelBlocks,
    deadlineMs:Math.min(deadlineMs,Date.now()+(longPass?90_000:20_000)),maxWaves:longPass?8:4,
    ...(skipPublication?{stages:['canonical','features','activity','fits','cache'] as const}:{})});
  }
  const preparationStarted=meter.queriesUsed;
  const preparationReserve=publishCommunity?560:100;
  const preparationCap=longPass?250:180;
  let preparation:StorageAnalyticsPreparationResult|undefined;
  if(features.sharedFeatures&&!features.canonicalPipeline&&meter.remainingQueries>=preparationReserve+130) {
   try {
    preparation=await advanceStorageAnalyticsPreparation({...bindings,sharedFeatures:true,maxAttempts:4,
     budget:{remainingQueries:()=>Math.max(0,Math.min(meter.remainingQueries-preparationReserve,
       preparationCap-(meter.queriesUsed-preparationStarted))),
       deadlineMs:Math.min(deadlineMs,Date.now()+(longPass?30_000:5_000)),now:Date.now}});
   } catch {
    // A maintenance failure cannot close the existing consumer lanes. No SQL,
    // identity or source payload enters this closed diagnostic.
    preparation={state:'deferred',reason:'lane_failure',attempts:0,prepared:0,reused:0,refused:0,deferred:0,
     resumeAttempts:0,recentAttempts:0,dirtyAttempts:0,historyAttempts:0};
   }
  }
  const preparationQueries=meter.queriesUsed-preparationStarted;
  // The builder lane opens only on this second pass: delivery normally has
  // 175 statements, or at most 850 on an admitted ordinary-minute authority
  // recovery; the long pass remains graph-only. Both switches must be open,
  // and the build reads the SAME metered source binding as everything else.
  const buildProjections=graphDayProjectionBuildEnabled(env);
  const foldProjections=storageV11PreparedFoldEnabled(env);
  // The two switches are independent: building fills the store, folding reads
  // it, and either can be turned on or reverted without the other.
  const projectionOptions={...(buildProjections?{buildGraphDayProjections:true,
   graphDayProjectionBuild:createGraphDayProjectionSourceBuild({source:bindings.source,
    sourceNamespace:bindings.sourceNamespace})}:{}),
   ...(foldProjections?{foldGraphDayProjections:true}:{}),
   ...(buildProjections&&env.GRAPH_DAY_PROJECTION_LONG_PASS==='enabled'
    ?{graphDayProjectionLongPass:true}:{})};
  const result=await runStorageAnalyticsPass({...bindings,...projectionOptions,publishCommunity,
   ...(features.canonicalPipeline?{canonicalPipeline:true}:{}),
   ...(features.modelBlocks?{modelBlocks:true}:{}),
   ...(features.sharedFeatures?{sharedFeatures:true}:{}),
   ...(skipPublication?{skipPublication:true}:{}),
   ...(publishCommunity?{publicOnly:true}:{}),maxQueries:meter.remainingQueries,
   ...(publishCommunity?{maxSteps:32}:{}),
   // Erasure and the retirement pages already had their bounded opportunity
   // in the delivery phase of this same invocation; the daily lane waits for
   // the next minute, which is one minute in ten.
   ...(longPass?{graphOnly:true,graphLeaseMs:LONG_PASS_GRAPH_LEASE_MS}:{}),
   deadlineMs:publishCommunity?deadlineMs:started+20_000});
  // One line of tail must say which of "never opened", "opened and selected
  // nothing" and "selected and prepared nothing" the builder is in.
  const projection=result.graphDayProjection;
  console.log(JSON.stringify({event,...result,
   recoveryAdmitted,deliveryElapsedMs,
   ...(preparation?{preparation,preparationQueries}:{}),
   ...(canonicalWork?{canonicalWork}:{}),
   ...(projection?{projectionOpened:projection.opened,projectionBuilt:projection.built,
    projectionRefused:projection.refused,projectionSkipped:projection.skipped,
    projectionCandidates:projection.candidates,projectionSourceQueries:projection.sourceQueriesUsed,
    projectionState:projection.state,projectionReason:projection.reason,
    projectionSlot:projection.slot,projectionSliceMs:projection.sliceMs,
    projectionElapsedMs:projection.elapsedMs}:{}),
   steps:result.steps+(delivery?.steps??0),recordsRead:result.recordsRead+(delivery?.recordsRead??0),
   deliverySteps:publishCommunity?delivery?.steps??0:result.steps,
   deliveryRecordsRead:publishCommunity?delivery?.recordsRead??0:result.recordsRead,
   deliveryQueriesUsed:publishCommunity?delivery?.queriesUsed??0:result.queriesUsed,
   publicIterations:publishCommunity?result.steps:0,
   publicRecordsRead:publishCommunity?result.recordsRead:0,publicQueriesUsed:publishCommunity?result.queriesUsed:0,
   // Where the public phase's statements actually went. A high `publicQueriesUsed`
   // with `dailyPublications:0` reads as a stuck publisher; if `sweepQueries`
   // accounts for most of it the publisher is fine and the retirement sweeps are
   // the ones consuming the meter the graph lane needs.
   sweepQueries:result.sweepQueries??0,sweepIterations:result.sweepIterations??0,
   sweepWorked:(result.sweepV11Worked??0)+(result.sweepV1Worked??0)+(result.sweepGraphWorked??0),
   queriesUsed:meter.queriesUsed}));
 }catch (error) {reportScheduleFailure(event,error);}
}
export default {
 fetch():Response {return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async scheduled(controller:ScheduledController,env:StorageAnalyticsWorkerEnv):Promise<void> {
  // The scheduled instant selects the pass. The expression is carried only so
  // the pass never depends on which trigger the platform reported.
  await runStorageAnalyticsSchedule(env,{cron:controller.cron,nowMs:controller.scheduledTime});
 },
} satisfies ExportedHandler<StorageAnalyticsWorkerEnv>;
