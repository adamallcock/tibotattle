import { advanceCacheRetentionDayLane, createCacheRetentionDaySourceBuild,
 CACHE_RETENTION_MAX_SHARDS, CACHE_RETENTION_MAX_WRITES } from './cache-retention-day';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';

/**
 * The `cache_retention_by_pause` builder, as its own scheduled Worker.
 *
 * It is a separate cron for the same reason the prepared-graph-day builder was
 * given one: inside the analytics Worker it would compete for a single window,
 * and its budget could be funded only by taking another lane's admission floor.
 * Its own cron pays neither. The lane, the build and every protection are
 * reused unchanged: atomic day writes, resumable partial writes, recorded
 * refusals, metered source reads and isolation on failure.
 *
 * Sharding is configuration, not a redesign. `advanceCacheRetentionDayLane`
 * filters candidates on the owner digest's first two hex characters, so a
 * second instance is another cron with another `CACHE_RETENTION_SHARD` and two
 * instances can never select the same day.
 */
export interface CacheRetentionDayWorkerEnv {
 CACHE_RETENTION_BUILD?:'disabled'|'enabled';
 STORAGE_SOURCE_ID?:string;
 TELEMETRY_STORAGE_NAMESPACE?:string;
 STORAGE_INGESTION_DB?:D1Database;
 STORAGE_ANALYTICS_DB?:D1Database;
 /** Zero-based shard index and total shard count. Unset means one shard. */
 CACHE_RETENTION_SHARD?:string;
 CACHE_RETENTION_SHARDS?:string;
 /** The oldest day to prepare. Unset means every delivered day. */
 CACHE_RETENTION_FROM_DAY?:string;
}

/**
 * Deployment switch. Default OFF: no reader consumes these rows yet, so
 * building them must be an explicit operator decision rather than a
 * consequence of deploying this code.
 */
export function cacheRetentionBuildEnabled(env:unknown):boolean{
 if(!env||typeof env!=='object')return false;
 return Reflect.get(env,'CACHE_RETENTION_BUILD')==='enabled';
}

/**
 * One invocation's ceiling, and the arithmetic behind it.
 *
 * TARGET, per day: the carry read, the mark read, the staged read, the write
 * batches and the promotion check. A write batch is seven carry upserts plus
 * eight statements per `(model, effort)` group plus the mark; the production
 * corpus measures 4.26 groups per owner-day, so a typical day is 7 + 35 + 1 =
 * 43 statements and `maxWrites` of 48 finishes it in one batch. At 5 + 48 that
 * is 53 target statements a day, and the 650-statement target half affords 12.
 *
 * SOURCE, per day: this lane reads EIGHT days for every day it prepares — its
 * own plus the seven-day lookback a cross-midnight pair needs — at one page
 * per 5,000 usage rows and one generation fence each. A typical owner-day is
 * about 16 statements and the densest measured one about 32, so the
 * 350-statement source half affords between 10 and 21 days and is the bound
 * that actually binds on a dense owner. That eightfold read is the real cost of
 * attributing a pair to the current event's day, and it is why `maxDays` is 12
 * here where the prepared-graph-day lane affords 32.
 *
 * The four-minute window affords far more than 12 days of mostly waiting, so
 * the statement meter, not the clock, is the binding constraint on an ordinary
 * pass; the lane reports which one stopped it either way.
 */
export const CACHE_RETENTION_WORKER_QUERIES=1_000;
export const CACHE_RETENTION_WORKER_WINDOW_MS=4*60_000;
export const CACHE_RETENTION_WORKER_DAYS=12;
export const CACHE_RETENTION_WORKER_TARGET_QUERIES=650;
export const CACHE_RETENTION_WORKER_WRITES=48;

const invalid=()=>new Error('CACHE_RETENTION_CONFIGURATION_INVALID');
const DAY=/^\d{4}-\d{2}-\d{2}$/u;

function shard(env:CacheRetentionDayWorkerEnv):{index:number;count:number}{
 const count=env.CACHE_RETENTION_SHARDS===undefined?1:Number(env.CACHE_RETENTION_SHARDS);
 const index=env.CACHE_RETENTION_SHARD===undefined?0:Number(env.CACHE_RETENTION_SHARD);
 if(!Number.isSafeInteger(count)||count<1||count>CACHE_RETENTION_MAX_SHARDS
  ||!Number.isSafeInteger(index)||index<0||index>=count)throw invalid();
 return {index,count};
}

/**
 * One scheduled pass. An unset environment does nothing at all, so this Worker
 * and the analytics Worker are turned on and off independently.
 */
export async function runCacheRetentionDaySchedule(env:CacheRetentionDayWorkerEnv,
 options?:{nowMs?:number}):Promise<void>{
 if(!cacheRetentionBuildEnabled(env))return;
 if(!env.STORAGE_INGESTION_DB||!env.STORAGE_ANALYTICS_DB||!env.STORAGE_SOURCE_ID
  ||!env.TELEMETRY_STORAGE_NAMESPACE
  ||(env.CACHE_RETENTION_FROM_DAY!==undefined&&!DAY.test(env.CACHE_RETENTION_FROM_DAY))
  ||(options?.nowMs!==undefined&&(!Number.isSafeInteger(options.nowMs)||options.nowMs<0)))throw invalid();
 if(CACHE_RETENTION_WORKER_WRITES>CACHE_RETENTION_MAX_WRITES)throw invalid();
 const {index,count}=shard(env);
 const started=options?.nowMs??Date.now();
 const event='cache_retention_day_schedule';
 try{
  // Both databases share one invocation meter. The lane's own sub-meter covers
  // the target; the source allowance is passed explicitly because the build
  // reads through the unwrapped binding.
  const meter=createD1InvocationBudget(CACHE_RETENTION_WORKER_QUERIES);
  const target=meter.wrap(env.STORAGE_ANALYTICS_DB);
  const source=meter.wrap(env.STORAGE_INGESTION_DB);
  const lane=await advanceCacheRetentionDayLane({target,sourceId:env.STORAGE_SOURCE_ID,
   build:createCacheRetentionDaySourceBuild({source,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE}),
   deadlineMs:started+CACHE_RETENTION_WORKER_WINDOW_MS,
   remainingQueries:CACHE_RETENTION_WORKER_TARGET_QUERIES,
   sourceQueries:CACHE_RETENTION_WORKER_QUERIES-CACHE_RETENTION_WORKER_TARGET_QUERIES,
   maxDays:CACHE_RETENTION_WORKER_DAYS,maxWrites:CACHE_RETENTION_WORKER_WRITES,
   shardIndex:index,shardCount:count,
   ...(env.CACHE_RETENTION_FROM_DAY===undefined?{}:{fromDay:env.CACHE_RETENTION_FROM_DAY})});
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
  throw new Error('CACHE_RETENTION_UNAVAILABLE');
 }
}

export default {
 async scheduled(controller:ScheduledController,env:CacheRetentionDayWorkerEnv):Promise<void>{
  void controller;
  await runCacheRetentionDaySchedule(env);
 },
} satisfies ExportedHandler<CacheRetentionDayWorkerEnv>;
