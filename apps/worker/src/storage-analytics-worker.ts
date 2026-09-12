import { runStorageAnalyticsPass } from './storage-analytics-runtime';

/** Separate scheduler entry point; it has no upload route or credential binding.
 * Resource binding/deployment belongs to the qualified Wrangler role plan. */
export interface StorageAnalyticsWorkerEnv {
 STORAGE_ANALYTICS_MODE?:'disabled'|'enabled';
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
  const result=await runStorageAnalyticsPass({source:env.STORAGE_INGESTION_DB,target:env.STORAGE_ANALYTICS_DB,
   sourceId:env.STORAGE_SOURCE_ID,sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,ledger:env.DELETION_LEDGER,publishCommunity:true});
  console.log(JSON.stringify({event:'storage_analytics_schedule',...result}));
 }catch {
  // Do not expose account identifiers, SQL, credentials or a stored record in
  // diagnostics. Retain the durable cursor and make scheduler failure visible.
  console.error(JSON.stringify({event:'storage_analytics_schedule',state:'unavailable'}));
  throw new Error('STORAGE_ANALYTICS_UNAVAILABLE');
 }
}
export default {
 fetch():Response {return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async scheduled(_controller:ScheduledController,env:StorageAnalyticsWorkerEnv):Promise<void> {
  await runStorageAnalyticsSchedule(env);
 },
} satisfies ExportedHandler<StorageAnalyticsWorkerEnv>;
