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
export async function runStorageAnalyticsSchedule(env:StorageAnalyticsWorkerEnv):Promise<void> {
 if(env.STORAGE_ANALYTICS_MODE===undefined||env.STORAGE_ANALYTICS_MODE==='disabled')return;
 if(env.STORAGE_ANALYTICS_MODE!=='enabled'||!env.STORAGE_INGESTION_DB||!env.STORAGE_ANALYTICS_DB
  ||!env.DELETION_LEDGER||!env.STORAGE_SOURCE_ID||!env.TELEMETRY_STORAGE_NAMESPACE)throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
 try {
  const publishCommunity=publicAnalyticsEnabled(env);
  const meter=createD1InvocationBudget(900);
  const bindings={source:meter.wrap(env.STORAGE_INGESTION_DB),target:meter.wrap(env.STORAGE_ANALYTICS_DB),
   sourceId:env.STORAGE_SOURCE_ID,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,ledger:meter.wrap(env.DELETION_LEDGER)};
  // Give ordered delivery its own bounded opportunity before expensive graph
  // work. Both sequential phases share one actual-statement meter; this does
  // not create competing cursor writers or two independent query allowances.
  const started=Date.now(),deadlineMs=started+40_000;
  const delivery=publishCommunity?await runStorageAnalyticsPass({...bindings,publishCommunity:false,
   maxSteps:32,maxQueries:250,deadlineMs:started+10_000}):null;
  if(Date.now()>=deadlineMs){
   console.log(JSON.stringify({event:'storage_analytics_schedule',...delivery,state:'deferred',reason:'deadline',
    queriesUsed:meter.queriesUsed}));return;
  }
  const result=await runStorageAnalyticsPass({...bindings,publishCommunity,maxQueries:meter.remainingQueries,
   deadlineMs:publishCommunity?Math.min(deadlineMs,Date.now()+20_000):started+20_000});
  console.log(JSON.stringify({event:'storage_analytics_schedule',...result,
   steps:result.steps+(delivery?.steps??0),recordsRead:result.recordsRead+(delivery?.recordsRead??0),
   queriesUsed:meter.queriesUsed}));
 }catch (error) {
  // Do not expose account identifiers, SQL, credentials or a stored record in
  // diagnostics. Retain the durable cursor and make scheduler failure visible.
  console.error(JSON.stringify({event:'storage_analytics_schedule',state:'unavailable',...storageGraphFailureFields(error)}));
  throw new Error('STORAGE_ANALYTICS_UNAVAILABLE');
 }
}
export default {
 fetch():Response {return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async scheduled(_controller:ScheduledController,env:StorageAnalyticsWorkerEnv):Promise<void> {
  await runStorageAnalyticsSchedule(env);
 },
} satisfies ExportedHandler<StorageAnalyticsWorkerEnv>;
