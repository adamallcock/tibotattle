import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { advanceGraphDayProjectionLane, createGraphDayProjectionSourceBuild,
 GRAPH_DAY_PROJECTION_MAX_SHARDS } from './graph-day-projection';
import { graphDayProjectionBuildEnabled } from './storage-analytics-runtime';

/**
 * The prepared-graph-day builder, as its own scheduled Worker.
 *
 * It was a lane inside the analytics Worker, where it competed with the graph
 * lane for one window: the budget could be funded only by taking the graph
 * lane's admission floor, and the clock only by taking its long pass. Both are
 * real costs paid every minute for work that ends once coverage is complete.
 * Its own cron pays neither. The lane, the build and every protection are
 * reused unchanged: atomic day writes, resumable partial writes, recorded
 * refusals, metered source reads and isolation on failure.
 *
 * Sharding is configuration, not a redesign. `advanceGraphDayProjectionLane`
 * filters candidates on the owner digest's first two hex characters, so a
 * second instance is another cron with another `GRAPH_DAY_PROJECTION_SHARD`
 * and two instances can never select the same day.
 */
export interface GraphDayProjectionWorkerEnv {
 GRAPH_DAY_PROJECTION_BUILD?:'disabled'|'enabled';
 STORAGE_SOURCE_ID?:string;
 TELEMETRY_STORAGE_NAMESPACE?:string;
 STORAGE_INGESTION_DB?:D1Database;
 STORAGE_ANALYTICS_DB?:D1Database;
 /** Zero-based shard index and total shard count. Unset means one shard. */
 GRAPH_DAY_PROJECTION_SHARD?:string;
 GRAPH_DAY_PROJECTION_SHARDS?:string;
 /** The oldest day to prepare. Unset means every delivered day. */
 GRAPH_DAY_PROJECTION_FROM_DAY?:string;
}

/** One invocation's ceiling. A day costs about six source statements to read
 * and about twelve target statements to write, so 1,000 statements split
 * evenly affords 41 writes and 83 reads; and a day costs roughly six seconds
 * of mostly waiting, so a four-minute window affords 40. `maxDays` is the
 * smaller of those, with headroom on both: 32 days is 384 target, 192 source
 * and about 192 seconds. */
export const GRAPH_DAY_PROJECTION_WORKER_QUERIES=1_000;
export const GRAPH_DAY_PROJECTION_WORKER_WINDOW_MS=4*60_000;
export const GRAPH_DAY_PROJECTION_WORKER_DAYS=32;

const invalid=()=>new Error('GRAPH_DAY_PROJECTION_CONFIGURATION_INVALID');
const DAY=/^\d{4}-\d{2}-\d{2}$/u;

function shard(env:GraphDayProjectionWorkerEnv):{index:number;count:number}{
 const count=env.GRAPH_DAY_PROJECTION_SHARDS===undefined?1:Number(env.GRAPH_DAY_PROJECTION_SHARDS);
 const index=env.GRAPH_DAY_PROJECTION_SHARD===undefined?0:Number(env.GRAPH_DAY_PROJECTION_SHARD);
 if(!Number.isSafeInteger(count)||count<1||count>GRAPH_DAY_PROJECTION_MAX_SHARDS
  ||!Number.isSafeInteger(index)||index<0||index>=count)throw invalid();
 return {index,count};
}

/**
 * One scheduled pass. Gated by the same build switch the analytics Worker
 * reads, so an unset environment does nothing at all and the two can be turned
 * on and off independently.
 */
export async function runGraphDayProjectionSchedule(env:GraphDayProjectionWorkerEnv,
 options?:{nowMs?:number}):Promise<void>{
 if(!graphDayProjectionBuildEnabled(env))return;
 if(!env.STORAGE_INGESTION_DB||!env.STORAGE_ANALYTICS_DB||!env.STORAGE_SOURCE_ID
  ||!env.TELEMETRY_STORAGE_NAMESPACE
  ||(env.GRAPH_DAY_PROJECTION_FROM_DAY!==undefined&&!DAY.test(env.GRAPH_DAY_PROJECTION_FROM_DAY))
  ||(options?.nowMs!==undefined&&(!Number.isSafeInteger(options.nowMs)||options.nowMs<0)))throw invalid();
 const {index,count}=shard(env);
 const started=options?.nowMs??Date.now();
 const event='graph_day_projection_schedule';
 try{
  // Both databases share one invocation meter, exactly as the analytics pass
  // does. The lane's own sub-meter covers the target; the source allowance is
  // passed explicitly because the build reads through the unwrapped binding.
  const meter=createD1InvocationBudget(GRAPH_DAY_PROJECTION_WORKER_QUERIES);
  const target=meter.wrap(env.STORAGE_ANALYTICS_DB);
  const source=meter.wrap(env.STORAGE_INGESTION_DB);
  const half=Math.floor(GRAPH_DAY_PROJECTION_WORKER_QUERIES/2);
  const lane=await advanceGraphDayProjectionLane({target,sourceId:env.STORAGE_SOURCE_ID,
   build:createGraphDayProjectionSourceBuild({source,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE}),
   deadlineMs:started+GRAPH_DAY_PROJECTION_WORKER_WINDOW_MS,
   remainingQueries:half,sourceQueries:GRAPH_DAY_PROJECTION_WORKER_QUERIES-half,
   maxDays:GRAPH_DAY_PROJECTION_WORKER_DAYS,shardIndex:index,shardCount:count,
   ...(env.GRAPH_DAY_PROJECTION_FROM_DAY===undefined?{}:{fromDay:env.GRAPH_DAY_PROJECTION_FROM_DAY})});
  console.log(JSON.stringify({event,state:lane.state,reason:lane.reason,built:lane.built,
   staged:lane.staged,refused:lane.refused,skipped:lane.skipped,candidates:lane.candidates,
   sourceQueriesUsed:lane.sourceQueriesUsed,queriesUsed:meter.queriesUsed,
   shard:index,shards:count,durationMs:Math.max(0,Date.now()-started)}));
 }catch(error){
  // Closed fields only, never a provider message: a failing builder is an
  // isolated scheduled task and nothing downstream depends on this invocation.
  const message=error instanceof Error?error.message:'';
  const code=error instanceof D1InvocationBudgetExceededError?'D1_INVOCATION_BUDGET_DEFERRED'
   :/^[A-Z][A-Z0-9_]{2,63}$/.test(message)?message:null;
  console.error(JSON.stringify({event,state:'unavailable',...(code?{code}:{}),
   shard:index,shards:count,durationMs:Math.max(0,Date.now()-started)}));
  throw new Error('GRAPH_DAY_PROJECTION_UNAVAILABLE');
 }
}

export default {
 async scheduled(controller:ScheduledController,env:GraphDayProjectionWorkerEnv):Promise<void>{
  void controller;
  await runGraphDayProjectionSchedule(env);
 },
} satisfies ExportedHandler<GraphDayProjectionWorkerEnv>;
