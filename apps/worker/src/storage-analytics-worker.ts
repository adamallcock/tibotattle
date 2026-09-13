import { runStorageAnalyticsPass } from './storage-analytics-runtime';
import { runMultiSourceAnalyticsPass, type StorageAnalyticsSource } from './storage-multi-source-analytics';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { publishStorageMultiSourceCohort,
  storageMultiSourceCohortPublicationQueryCeiling } from './storage-multi-source-cohort';

const MULTI_SOURCE_SCHEDULE_QUERY_LIMIT=900;
const MULTI_SOURCE_ANALYTICS_QUERIES_PER_SOURCE=115;
const MULTI_SOURCE_ANALYTICS_INITIALIZATION_QUERIES=8;
const MULTI_SOURCE_OWNER_LIMIT=5_000;
const MULTI_SOURCE_MAX_SOURCES=3;

export function storageMultiSourceScheduleQueryCeiling():number{
 return MULTI_SOURCE_MAX_SOURCES*(MULTI_SOURCE_ANALYTICS_QUERIES_PER_SOURCE
   +MULTI_SOURCE_ANALYTICS_INITIALIZATION_QUERIES)
  +storageMultiSourceCohortPublicationQueryCeiling(MULTI_SOURCE_OWNER_LIMIT,
   MULTI_SOURCE_MAX_SOURCES);
}

/** Separate scheduler entry point; it has no upload route or credential binding.
 * Resource binding/deployment belongs to the qualified Wrangler role plan. */
export interface StorageAnalyticsWorkerEnv {
 STORAGE_ANALYTICS_MODE?:'disabled'|'enabled'|'multi-source';
 STORAGE_SOURCE_ID?:string;
 TELEMETRY_STORAGE_NAMESPACE?:string;
 STORAGE_SOURCE_NAMESPACE_A?:string;
 STORAGE_SOURCE_NAMESPACE_B?:string;
 STORAGE_INGESTION_DB?:D1Database;
 STORAGE_ANALYTICS_DB?:D1Database;
 STORAGE_INGESTION_A?:D1Database;
 STORAGE_INGESTION_B?:D1Database;
 STORAGE_INGESTION_C?:D1Database;
 STORAGE_ANALYTICS_A?:D1Database;
 STORAGE_ANALYTICS_B?:D1Database;
 STORAGE_ANALYTICS_C?:D1Database;
 STORAGE_ROUTING_DB?:D1Database;
 STORAGE_PUBLICATION_DB?:D1Database;
 STORAGE_SOURCE_NAMESPACE_C?:string;
 DELETION_LEDGER?:D1Database;
}
export async function runStorageAnalyticsSchedule(env:StorageAnalyticsWorkerEnv):Promise<void> {
 if(env.STORAGE_ANALYTICS_MODE===undefined||env.STORAGE_ANALYTICS_MODE==='disabled')return;
 if(env.STORAGE_ANALYTICS_MODE==='multi-source'){
  if(!env.STORAGE_INGESTION_A||!env.STORAGE_INGESTION_B||!env.STORAGE_ANALYTICS_A
    ||!env.STORAGE_ANALYTICS_B||!env.DELETION_LEDGER)
    throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  const namespaceA=env.STORAGE_SOURCE_NAMESPACE_A??env.TELEMETRY_STORAGE_NAMESPACE;
  const namespaceB=env.STORAGE_SOURCE_NAMESPACE_B??env.TELEMETRY_STORAGE_NAMESPACE;
  if(!namespaceA||!namespaceB)throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  const hasAnalyticsC=!!env.STORAGE_ANALYTICS_C;
  const hasNamespaceC=typeof env.STORAGE_SOURCE_NAMESPACE_C==='string'
   &&env.STORAGE_SOURCE_NAMESPACE_C.length>0;
  if(hasAnalyticsC!==hasNamespaceC)throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  // Every source, target, catalog, ledger, and publication statement shares
  // one real counter. The three-source, 5,000-owner declared ceiling is 887:
  // 369 for source progress and 518 for cohort capture plus both artifacts.
  if(storageMultiSourceScheduleQueryCeiling()>MULTI_SOURCE_SCHEDULE_QUERY_LIMIT)
   throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  const budget=createD1InvocationBudget(MULTI_SOURCE_SCHEDULE_QUERY_LIMIT);
  const metered={...env,
   STORAGE_ROUTING_DB:env.STORAGE_ROUTING_DB&&budget.wrap(env.STORAGE_ROUTING_DB),
   STORAGE_INGESTION_A:budget.wrap(env.STORAGE_INGESTION_A),
   STORAGE_INGESTION_B:budget.wrap(env.STORAGE_INGESTION_B),
   STORAGE_INGESTION_C:env.STORAGE_INGESTION_C&&budget.wrap(env.STORAGE_INGESTION_C),
   STORAGE_ANALYTICS_A:budget.wrap(env.STORAGE_ANALYTICS_A),
   STORAGE_ANALYTICS_B:budget.wrap(env.STORAGE_ANALYTICS_B),
   STORAGE_ANALYTICS_C:env.STORAGE_ANALYTICS_C&&budget.wrap(env.STORAGE_ANALYTICS_C),
   STORAGE_PUBLICATION_DB:env.STORAGE_PUBLICATION_DB&&budget.wrap(env.STORAGE_PUBLICATION_DB),
   DELETION_LEDGER:budget.wrap(env.DELETION_LEDGER),
  };
  const requestedSources=[
    source(metered.STORAGE_INGESTION_A,metered.STORAGE_ANALYTICS_A,'analytics-a',namespaceA),
    source(metered.STORAGE_INGESTION_B,metered.STORAGE_ANALYTICS_B,'analytics-b',namespaceB),
  ];
  if(metered.STORAGE_ANALYTICS_C&&metered.STORAGE_SOURCE_NAMESPACE_C)
   requestedSources.push(source(metered.STORAGE_INGESTION_C!,metered.STORAGE_ANALYTICS_C,
    'analytics-c',metered.STORAGE_SOURCE_NAMESPACE_C));
  const discovered=await Promise.allSettled(requestedSources);
  const pairs=discovered.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
  if(!pairs.length)throw new Error('STORAGE_ANALYTICS_UNAVAILABLE');
  const results=await runMultiSourceAnalyticsPass({sources:pairs,ledger:metered.DELETION_LEDGER,
   publishCommunity:true,maxQueriesPerSource:MULTI_SOURCE_ANALYTICS_QUERIES_PER_SOURCE});
  let publication:'complete'|'deferred'|'unavailable'='unavailable';
  try{
   const published=await publishStorageMultiSourceCohort(metered);
   publication=published.daily.state==='deferred'||published.allowance.state==='deferred'
    ?'deferred':'complete';
  }catch{
   // Source cursors above are independent durable progress. A missing or
   // incomplete routing cohort blocks only central publication and is retried.
   publication='unavailable';
  }
  console.log(JSON.stringify({event:'storage_analytics_schedule',mode:'multi-source',
    progressed:results.filter(result=>result.state==='progress').length,
    unavailable:discovered.length-pairs.length+results.filter(result=>result.state==='unavailable').length,
    publication}));
  return;
 }
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
async function source(sourceDb:D1Database,target:D1Database,targetId:string,
  sourceNamespace:string):Promise<StorageAnalyticsSource>{
 const row=await sourceDb.prepare('SELECT source_id FROM storage_source_state WHERE singleton=1')
  .first<{source_id:string}>();
 if(!row?.source_id)throw new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
 return {source:sourceDb,target,sourceId:row.source_id,sourceNamespace,targetId};
}
export default {
 fetch():Response {return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async scheduled(_controller:ScheduledController,env:StorageAnalyticsWorkerEnv):Promise<void> {
  await runStorageAnalyticsSchedule(env);
 },
} satisfies ExportedHandler<StorageAnalyticsWorkerEnv>;
