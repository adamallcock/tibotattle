import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect} from 'vitest';
import * as native from './analytics-native-reference';
import * as candidate from './analytics-candidate';
import type {SharedAnalyticsCorpusMigrations} from '../fixtures/shared-analytics-corpus';
import {seedLegacySelectedFunctionalCorpus,initializeLegacyFunctionalDatabases} from '../fixtures/analytics-legacy-selected-corpus';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
export {native,candidate};
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database};
export const source=b.USAGE_MONITOR_DB,sourceId='synthetic-p11-functional',sourceNamespace=sourceId;
export const lanes=[{name:'reference',kernel:native,target:b.STORAGE_INGESTION_A},{name:'candidate',kernel:candidate,target:b.STORAGE_ANALYTICS_DB}] as const;
export const bindings=(target:D1Database)=>({source,target,sourceId,sourceNamespace});
export async function setupLegacyFunctional(){
 await reset();await initializeLegacyFunctionalDatabases(source,b.STORAGE_ANALYTICS_DB,b,sourceId);
 await applyD1Migrations(b.STORAGE_INGESTION_A,b.TEST_ANALYTICS_MIGRATIONS.filter(m=>native.nativeMigrationNames.TEST_ANALYTICS_MIGRATIONS?.includes(m.name)));
 await native.initializeStorageAnalyticsRuntime(bindings(b.STORAGE_INGESTION_A));
 const nowMs=Date.now()-120000;native.setAnalyticsWorkloadPublicationClock(nowMs);candidate.setAnalyticsWorkloadPublicationClock(nowMs);
 const corpus=await seedLegacySelectedFunctionalCorpus(source,sourceNamespace,nowMs);
 for(const lane of lanes){
  const measured=createWholeWorkloadMeter(source,lane.target);let idle=false;
  for(let n=0;n<64;n++){const result=await measured.invocation('delivery',db=>lane.kernel.advanceStorageAnalytics({...bindings(lane.target),...db}));
   if(result.state==='idle'){idle=true;break;}}
  expect(idle,'FUNCTIONAL_DELIVERY_BOUND').toBe(true);
  const p=summarizeWholeWorkload(measured.profile);console.log('functional-setup',JSON.stringify({lane:lane.name,phase:'delivery',statements:p.statements,invocations:p.invocations,maximum:p.maximumStatementsPerInvocation}));
 }
 return {...corpus,nowMs};
}
export async function prepareLegacyFunctional(){
 const target=b.STORAGE_ANALYTICS_DB,measured=createWholeWorkloadMeter(source,target,undefined,candidate.createD1InvocationBudget);
 let closed=false;
 for(let n=0;n<160;n++){
  await measured.invocation('canonical', (db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(target),...db,invocation,
   now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,stages:['canonical','features']}));
  if(await candidate.readAnalyticsWorkClosureFence(bindings(target))){closed=true;break;}
 }
 expect(closed,'FUNCTIONAL_SOURCE_CLOSURE_BOUND').toBe(true);
 let prepared=false;
 for(let n=0;n<120;n++){
  await measured.invocation('activity_cache',(db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(target),...db,invocation,
   now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,bridge:false,stages:['activity','cache']}));
  const pending=await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage IN('activity','cache') AND state IN('ready','leased')").first<number>('n');
  if(pending===0){prepared=true;break;}
 }
 expect(prepared,'FUNCTIONAL_ACTIVITY_CACHE_BOUND').toBe(true);
 const p=summarizeWholeWorkload(measured.profile);console.log('functional-setup',JSON.stringify({lane:'candidate',phase:'maintained',statements:p.statements,invocations:p.invocations,maximum:p.maximumStatementsPerInvocation}));
}
