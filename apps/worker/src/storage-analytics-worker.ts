import { graphDayProjectionBuildEnabled, runStorageAnalyticsPass } from './storage-analytics-runtime';
import { storageV11PreparedFoldEnabled } from './storage-v11-history';
import { createGraphDayProjectionSourceBuild } from './graph-day-projection';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { publicAnalyticsEnabled } from './public-analytics-gate';
import { storageGraphFailureFields } from './storage-analytics-failure';

/** Separate scheduler entry point; it has no upload route or credential binding.
 * Resource binding/deployment belongs to the qualified Wrangler role plan. */
export interface StorageAnalyticsWorkerEnv {
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
 // Which pass runs is a property of the scheduled minute, not of the delivered
 // cron expression. With publication deployed off there is no graph lane at
 // all, so every invocation stays on the ordinary bounded pass.
 const longPass=publishCommunity
  &&new Date(options?.nowMs??Date.now()).getUTCMinutes()%STORAGE_ANALYTICS_LONG_PASS_MINUTES===0;
 const event=longPass?'storage_analytics_long_schedule':'storage_analytics_schedule';
 try {
  const meter=createD1InvocationBudget(900);
  const bindings={source:meter.wrap(env.STORAGE_INGESTION_DB),target:meter.wrap(env.STORAGE_ANALYTICS_DB),
   sourceId:env.STORAGE_SOURCE_ID,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,ledger:meter.wrap(env.DELETION_LEDGER)};
  // Give ordered delivery its own bounded opportunity before expensive graph
  // work, on every invocation including the long one, so ingestion delivery
  // never skips a minute. Both sequential phases share one actual-statement
  // meter; this does not create competing cursor writers or two independent
  // query allowances. The second phase then uses the rest of this invocation's
  // work window: the minute schedule's, or the long pass's eight minutes. Graph
  // checkpoints reserve their own final save time. A slow in-flight query can
  // overrun this cooperative deadline; subsequent work must still stop rather
  // than receive a fresh allowance.
  const started=Date.now(),deadlineMs=started+(longPass?LONG_PASS_WINDOW_MS:55_000);
  const delivery=publishCommunity?await runStorageAnalyticsPass({...bindings,publishCommunity:false,
   maxSteps:32,maxQueries:175,deadlineMs:started+10_000}):null;
  if(Date.now()>=deadlineMs){
   console.log(JSON.stringify({event,...delivery,state:'deferred',reason:'deadline',
    deliverySteps:delivery?.steps??0,deliveryRecordsRead:delivery?.recordsRead??0,
    deliveryQueriesUsed:delivery?.queriesUsed??0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0,
    queriesUsed:meter.queriesUsed}));return;
  }
  // The builder lane opens only on this second pass: the delivery phase has
  // 175 statements and the long pass is graph-only. Both switches must be open,
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
