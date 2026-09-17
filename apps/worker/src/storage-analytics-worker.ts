import { runStorageAnalyticsPass } from './storage-analytics-runtime';
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
}
/** The deployed trigger set. The per-minute schedule keeps ordered delivery and
 * one bounded public pass; the ten-minute schedule runs a graph-only pass whose
 * window is long enough for one owner-day claim to advance many groups instead
 * of one per invocation. Both expressions fire in the same minute every ten
 * minutes, which is safe because owner-day claims exclude each other: the
 * minute pass takes another selection or defers rather than forking work. */
export const STORAGE_ANALYTICS_MINUTE_CRON='* * * * *';
export const STORAGE_ANALYTICS_LONG_CRON='*/10 * * * *';
/** Nine minutes of the fifteen-minute cron wall-clock allowance, leaving the
 * kernel's own save headroom and this invocation's final release inside it.
 * The deployed Worker must raise limits.cpu_ms for this window. */
const LONG_PASS_WINDOW_MS=9*60_000;
/** The graph claim must outlive the whole long window and its release, so a
 * concurrent minute pass treats the owner-day as busy for the entire time, and
 * must stay within one cron invocation's fifteen-minute wall clock so an
 * abandoned claim recovers by the next long schedule. The pass validates both
 * bounds against its own deadline. */
const LONG_PASS_GRAPH_LEASE_MS=12*60_000;
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
 options?:{cron?:string}):Promise<void> {
 if(env.STORAGE_ANALYTICS_MODE===undefined||env.STORAGE_ANALYTICS_MODE==='disabled')return;
 if(env.STORAGE_ANALYTICS_MODE!=='enabled'||!env.STORAGE_INGESTION_DB||!env.STORAGE_ANALYTICS_DB
  ||!env.DELETION_LEDGER||!env.STORAGE_SOURCE_ID||!env.TELEMETRY_STORAGE_NAMESPACE
  ||(options?.cron!==undefined&&typeof options.cron!=='string'))throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
 if(options?.cron===STORAGE_ANALYTICS_LONG_CRON) {
  // Graph-only long pass. Public analytics gates it exactly as the minute
  // pass gates its public phase; with publication deployed off there is no
  // graph lane to run, so the invocation ends without touching a database.
  if(!publicAnalyticsEnabled(env))return;
  try {
   // One meter for the whole invocation, below D1's 1000-statement ceiling.
   // Ordered delivery, erasure, the admin snapshot and the daily lane stay on
   // the minute schedule; this window belongs to the graph lane alone.
   const meter=createD1InvocationBudget(900),started=Date.now();
   const result=await runStorageAnalyticsPass({source:meter.wrap(env.STORAGE_INGESTION_DB),
    target:meter.wrap(env.STORAGE_ANALYTICS_DB),sourceId:env.STORAGE_SOURCE_ID,
    sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,publishCommunity:true,publicOnly:true,graphOnly:true,
    maxSteps:32,maxQueries:900,deadlineMs:started+LONG_PASS_WINDOW_MS,graphLeaseMs:LONG_PASS_GRAPH_LEASE_MS});
   console.log(JSON.stringify({event:'storage_analytics_long_schedule',...result,queriesUsed:meter.queriesUsed}));
  }catch (error) {reportScheduleFailure('storage_analytics_long_schedule',error);}
  return;
 }
 try {
  const publishCommunity=publicAnalyticsEnabled(env);
  const meter=createD1InvocationBudget(900);
  const bindings={source:meter.wrap(env.STORAGE_INGESTION_DB),target:meter.wrap(env.STORAGE_ANALYTICS_DB),
   sourceId:env.STORAGE_SOURCE_ID,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,ledger:meter.wrap(env.DELETION_LEDGER)};
  // Give ordered delivery its own bounded opportunity before expensive graph
  // work. Both sequential phases share one actual-statement meter; this does
  // not create competing cursor writers or two independent query allowances.
  // Use the minute schedule's available work window. The same 900-statement
  // meter bounds both phases, and graph checkpoints reserve their own final
  // save time. A slow in-flight query can overrun this cooperative deadline;
  // subsequent work must still stop rather than receive a fresh allowance.
  const started=Date.now(),deadlineMs=started+55_000;
  const delivery=publishCommunity?await runStorageAnalyticsPass({...bindings,publishCommunity:false,
   maxSteps:32,maxQueries:175,deadlineMs:started+10_000}):null;
  if(Date.now()>=deadlineMs){
   console.log(JSON.stringify({event:'storage_analytics_schedule',...delivery,state:'deferred',reason:'deadline',
    deliverySteps:delivery?.steps??0,deliveryRecordsRead:delivery?.recordsRead??0,
    deliveryQueriesUsed:delivery?.queriesUsed??0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0,
    queriesUsed:meter.queriesUsed}));return;
  }
  const result=await runStorageAnalyticsPass({...bindings,publishCommunity,
   ...(publishCommunity?{publicOnly:true}:{}),maxQueries:meter.remainingQueries,
   ...(publishCommunity?{maxSteps:32}:{}),
   deadlineMs:publishCommunity?deadlineMs:started+20_000});
  console.log(JSON.stringify({event:'storage_analytics_schedule',...result,
   steps:result.steps+(delivery?.steps??0),recordsRead:result.recordsRead+(delivery?.recordsRead??0),
   deliverySteps:publishCommunity?delivery?.steps??0:result.steps,
   deliveryRecordsRead:publishCommunity?delivery?.recordsRead??0:result.recordsRead,
   deliveryQueriesUsed:publishCommunity?delivery?.queriesUsed??0:result.queriesUsed,
   publicIterations:publishCommunity?result.steps:0,
   publicRecordsRead:publishCommunity?result.recordsRead:0,publicQueriesUsed:publishCommunity?result.queriesUsed:0,
   queriesUsed:meter.queriesUsed}));
 }catch (error) {reportScheduleFailure('storage_analytics_schedule',error);}
}
export default {
 fetch():Response {return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async scheduled(controller:ScheduledController,env:StorageAnalyticsWorkerEnv):Promise<void> {
  // The triggering expression selects the pass; an unrecognized cron keeps the
  // existing minute behaviour rather than skipping the scheduled work.
  await runStorageAnalyticsSchedule(env,{cron:controller.cron});
 },
} satisfies ExportedHandler<StorageAnalyticsWorkerEnv>;
