import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import * as native from './helpers/analytics-native-reference';
import * as candidate from './helpers/analytics-candidate';
import type {SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';
import {sha256Hex} from '../src/crypto';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database};
const source=b.USAGE_MONITOR_DB,sourceId='synthetic-p11-strict-clock',sourceNamespace=sourceId;
const lanes=[{name:'reference',kernel:native,target:b.STORAGE_INGESTION_A},{name:'candidate',kernel:candidate,target:b.STORAGE_ANALYTICS_DB}] as const;
const golden=it.skipIf(!native.publicationClockAdapted||!candidate.publicationClockAdapted);
const dayAt=(t:number,offset=0)=>new Date(t+offset*86400000).toISOString().slice(0,10);
const bindings=(target:D1Database)=>({source,target,sourceId,sourceNamespace});
const setClock=(t:number)=>{native.setAnalyticsWorkloadPublicationClock(t);candidate.setAnalyticsWorkloadPublicationClock(t);};
async function setup(){
 await reset();await candidate.initializeSharedAnalyticsCorpusDatabases(source,b.STORAGE_ANALYTICS_DB,b,sourceId);
 await applyD1Migrations(b.STORAGE_INGESTION_A,b.TEST_ANALYTICS_MIGRATIONS.filter(m=>native.nativeMigrationNames.TEST_ANALYTICS_MIGRATIONS?.includes(m.name)));
 await native.initializeStorageAnalyticsRuntime(bindings(b.STORAGE_INGESTION_A));
 const t=Date.now()-120000;setClock(t);await prepare();return t;
}
async function prepare(){
 for(const lane of lanes){
  const measured=createWholeWorkloadMeter(source,lane.target);
  let idle=false;
  for(let n=0;n<64;n++){
   const r=await measured.invocation('source_delivery',(db)=>lane.kernel.advanceStorageAnalytics({...bindings(lane.target),...db}));
   if(r.state==='idle'){idle=true;break;}
  }
  expect(idle).toBe(true);
  const profile=summarizeWholeWorkload(measured.profile);
  console.log('clock-golden-setup',JSON.stringify({phase:'delivery',lane:lane.name,invocations:profile.invocations,statements:profile.statements,rowsRead:profile.rowsRead,rowsWritten:profile.rowsWritten,max:profile.maximumStatementsPerInvocation}));
 }
 const meter=createWholeWorkloadMeter(source,b.STORAGE_ANALYTICS_DB,undefined,candidate.createD1InvocationBudget);
 let last:unknown,closed=false;for(let n=0;n<160;n++){
  last=await meter.invocation('canonical_preparation',(db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(b.STORAGE_ANALYTICS_DB),...db,
   invocation,now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,stages:['canonical','features']}));
  if(await candidate.readAnalyticsWorkClosureFence(bindings(b.STORAGE_ANALYTICS_DB))){closed=true;break;}
 }
 const preparation=summarizeWholeWorkload(meter.profile);
 if(closed)for(let n=0;n<80;n++){
  last=await meter.invocation('activity_preparation',(db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(b.STORAGE_ANALYTICS_DB),...db,
   invocation,now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,bridge:false,stages:['activity']}));
  const pending=await b.STORAGE_ANALYTICS_DB.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='activity' AND state IN('ready','leased')").first<number>('n');
  if(pending===0){const total=summarizeWholeWorkload(meter.profile);console.log('clock-golden-setup',JSON.stringify({phase:'maintained_preparation',sourceInvocations:preparation.invocations,sourceStatements:preparation.statements,activityInvocations:total.invocations-preparation.invocations,activityStatements:total.statements-preparation.statements,rowsRead:total.rowsRead,rowsWritten:total.rowsWritten,max:total.maximumStatementsPerInvocation}));return;}
 }
 console.log('clock-preparation-diagnostic',JSON.stringify({last,
  work:(await b.STORAGE_ANALYTICS_DB.prepare("SELECT stage,state,reason_code,count(*) n,min(attempts) attempts FROM analytics_partition_work GROUP BY stage,state,reason_code").all()).results,
  source:(await source.prepare("SELECT seeded,needs_work,count(*) n FROM storage_effective_selective_owners GROUP BY seeded,needs_work").all()).results,
  target:(await b.STORAGE_ANALYTICS_DB.prepare("SELECT complete,count(*) n FROM analytics_partition_reconciliation GROUP BY complete").all()).results}));
 throw Error('CLOCK_GOLDEN_PREPARATION_BOUND');
}
async function publish(lane:typeof lanes[number],day:string){
 const meter=createWholeWorkloadMeter(source,lane.target,undefined,candidate.createD1InvocationBudget);
 let daily:Awaited<ReturnType<typeof native.advanceStorageCommunityDaily>>|undefined;
 for(let n=0;n<32;n++){
  if(lane.name==='candidate')await meter.invocation('publication_role',(db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(lane.target),...db,
   invocation,now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,bridge:false,stages:['publication']}));
  daily=await meter.invocation('daily_publication',(db,budget)=>lane.kernel.advanceStorageCommunityDaily({...bindings(lane.target),...db,day,
   // Intentionally real, matching actual role callers: the named analytical leaf must ignore this override.
   nowMs:Date.now(),sharedFeatures:true,sharedFeatureBudget:{now:Date.now,deadlineMs:Date.now()+55000,remainingQueries:()=>budget.remainingQueries}}));
  if(daily.state==='published'||daily.state==='unchanged')break;
 }
 expect(['published','unchanged'],JSON.stringify({lane:lane.name,daily})).toContain(daily?.state);
 const model=await meter.invocation('model_publication',db=>lane.kernel.publishStorageCommunityModelDay({...bindings(lane.target),...db},{day,nowMs:Date.now()}));
 expect(['published','unchanged'],JSON.stringify({lane:lane.name,model})).toContain(model.state);
 const preview=await meter.invocation('preview_publication',db=>lane.kernel.publishStorageCommunityGraphPreview({...bindings(lane.target),...db},{nowMs:Date.now()}));
 expect(['published','unchanged'],JSON.stringify({lane:lane.name,preview})).toContain(preview.state);
 return {daily:daily!.state,model:model.state,preview:preview.state};
}
async function rows(target:D1Database,day:string){
 const daily=(await target.prepare('SELECT revision,payload_json,payload_sha256,released_at FROM analytics_community_daily_publications WHERE source_id=? AND day=? ORDER BY revision').bind(sourceId,day).all()).results;
 const model=await target.prepare('SELECT revision,payload_json,payload_sha256,computed_ms FROM analytics_community_model_publications WHERE source_id=? AND day=?').bind(sourceId,day).first();
 const preview=await target.prepare('SELECT revision,payload_json,payload_sha256,generated_at FROM analytics_community_graph_previews WHERE source_id=?').bind(sourceId).first();
 for(const row of [...daily,model,preview]){expect(row).not.toBeNull();expect(await sha256Hex(row!.payload_json as string)).toBe(row!.payload_sha256);}
 return {daily,model,preview};
}
async function assertPair(day:string){
 const a=await rows(lanes[0].target,day),c=await rows(lanes[1].target,day);expect(c).toEqual(a);
 const payloads=await Promise.all(lanes.map(l=>l.kernel.readPublishedStorageCommunityDaily({...bindings(l.target),fromDay:day,throughDay:day})));
 expect(payloads[1]).toEqual(payloads[0]);
 const previews=await Promise.all(lanes.map(l=>l.kernel.readPublishedStorageCommunityGraph(bindings(l.target),l.kernel.readAnalyticsWorkloadPublicationClock())));
 expect(previews[1]).toEqual(previews[0]);return a;
}
golden('uses strict common T for empty publisher payloads, rows and hashes; T2 replay preserves T and revision',async()=>{
 const t=await setup(),day=dayAt(t,-1);
 for(const lane of lanes)expect(await publish(lane,day)).toEqual({daily:'published',model:'published',preview:'published'});
 const first=await assertPair(day),iso=new Date(t).toISOString();
 expect(first.daily[0]!.released_at).toBe(iso);expect(JSON.parse(first.daily[0]!.payload_json as string).releasedAt).toBe(iso);
 expect(first.model!.computed_ms).toBe(t);expect(first.preview!.generated_at).toBe(iso);expect(JSON.parse(first.preview!.payload_json as string).generatedAt).toBe(iso);
 setClock(t+60000);
 for(const lane of lanes)expect(await publish(lane,day)).toEqual({daily:'unchanged',model:'unchanged',preview:'unchanged'});
 expect(await assertPair(day)).toEqual(first);
 for(const lane of lanes)expect(await publish(lane,day)).toEqual({daily:'unchanged',model:'unchanged',preview:'unchanged'});
 expect(await assertPair(day)).toEqual(first);
},60000);

golden('keeps actual expired publication leases and maintained cohorts refused under an older logical T',async()=>{
 const t=await setup(),day=dayAt(t,-1),target=lanes[1].target;
 await publish(lanes[1],day);const before=await rows(target,day);
 const now=Date.now(),hash='a'.repeat(64);
 await candidate.admitAnalyticsPartitionWork(target,[{sourceId,ownerDigest:null,stage:'publication',lane:'history',partitionKey:'activity/'+day,
  headKey:hash,inputRevision:hash,policyRevision:hash,day,stream:null,selectionMethod:null,residentBytes:1,admissionQueries:1}],now-10000);
 const [lease]=await candidate.claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:now-10000,leaseMs:1000,stages:['publication']});expect(lease).toBeDefined();
 expect(await target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE state='leased' AND claim_expires_ms>? AND claim_expires_ms<?").bind(t-86400000,Date.now()).first<number>('n')).toBe(1);
 expect(await candidate.readMaintainedPublicationCohort(bindings(target))).not.toBeNull();
 setClock(t-86400000);
 const meter=createWholeWorkloadMeter(source,target,undefined,candidate.createD1InvocationBudget);
 const result=await meter.invocation('expired_publication',(db,budget)=>candidate.advanceStorageCommunityDaily({...bindings(target),...db,day,
  nowMs:Date.now(),publicationLease:lease!,sharedFeatureBudget:{now:Date.now,deadlineMs:Date.now()+55000,remainingQueries:()=>budget.remainingQueries}}));
 expect(result.state).toBe('deferred');expect(await rows(target,day)).toEqual(before);
 // The existing complete cohort is legitimate. Expire only its operational validity as an adversarial negative fixture.
 await target.prepare('UPDATE analytics_canonical_publication_cohorts SET valid_until_ms=?').bind(now-1).run();
 expect(await candidate.readMaintainedPublicationCohort(bindings(target))).toBeNull();
 expect(await candidate.publishStorageCommunityModelDay(bindings(target),{day,nowMs:Date.now()})).toMatchObject({state:'deferred',reason:'cache_pending'});
 expect(await rows(target,day)).toEqual(before);
},60000);

golden('stores genuine changed-input publications at T2 with exact native parity and rejects future graph input',async()=>{
 const t=await setup(),day=dayAt(t,-1);
 const corpus=await candidate.seedSharedAnalyticsCorpus({...bindings(lanes[0].target),calendarDays:10,graphDays:2,anchorDay:dayAt(t),
  targetAuthority:'ordered-delivery',correctionAffectsModelFit:true});
 await prepare();
 async function compute(){for(const lane of lanes){
  const owners=await lane.kernel.readStorageCommunityOwnerPage(source);
  const measured=createWholeWorkloadMeter(source,lane.target,undefined,candidate.createD1InvocationBudget);
  for(const owner of owners)for(const [metric,date] of [['model',day],['fits',dayAt(t)]] as const){
   let completed=false;
   for(let n=0;n<32;n++){
    const result=await measured.invocation('clock_graph',async(db,meter)=>{
     const scope=await lane.kernel.captureStorageGraphScope(db.source,{owner,day:date,metric,sourceId,sourceNamespace,preparedFold:true});
     return lane.kernel.computeStorageGraphResult({...bindings(lane.target),...db},scope,{maxQueries:meter.remainingQueries,deadlineMs:Date.now()+55000,preparedFold:true,sharedFeatures:true});
    });
    if(result.state==='complete'){completed=true;break;}expect(result.failure).toBeUndefined();
   }
   expect(completed).toBe(true);
  }
 }}
 const graphRows=async(target:D1Database)=>(await target.prepare('SELECT owner_digest,metric,day,payload_json,payload_sha256,computed_ms FROM analytics_community_graph_results ORDER BY owner_digest,metric,day').all<{owner_digest:string;metric:string;day:string;payload_json:string;payload_sha256:string;computed_ms:number}>()).results;
 await compute();for(const lane of lanes)await publish(lane,day);const first=await assertPair(day);
 const initialGraphs=await graphRows(lanes[0].target);expect(await graphRows(lanes[1].target)).toEqual(initialGraphs);
 for(const lane of lanes)expect((await lane.target.prepare('SELECT DISTINCT computed_ms FROM analytics_community_graph_results').all()).results).toEqual([{computed_ms:t}]);
 setClock(t+60000);await corpus.mutateCorrection();await prepare();await compute();
 for(const lane of lanes)await publish(lane,day);const changed=await assertPair(day);
 expect(changed.daily.at(-1)!.revision).toBeGreaterThan(first.daily.at(-1)!.revision as number);
 expect(changed.daily.at(-1)!.released_at).toBe(new Date(t+60000).toISOString());
 expect(changed.daily.at(-1)!.payload_sha256).not.toBe(first.daily.at(-1)!.payload_sha256);
 expect(changed.preview!.generated_at).toBe(new Date(t+60000).toISOString());
 expect(changed.preview!.payload_sha256).not.toBe(first.preview!.payload_sha256);
 expect({...JSON.parse(changed.preview!.payload_json as string),generatedAt:null}).not.toEqual({...JSON.parse(first.preview!.payload_json as string),generatedAt:null});
 const updatedGraphs=await graphRows(lanes[0].target);expect(await graphRows(lanes[1].target)).toEqual(updatedGraphs);
 const graphChanges=updatedGraphs.filter((row,index)=>row.payload_sha256!==initialGraphs[index]?.payload_sha256);expect(graphChanges.length).toBeGreaterThan(0);
 for(const row of graphChanges)expect(row.computed_ms).toBe(t+60000);
 expect(changed.model!.computed_ms).toBe(t+60000);expect(changed.model!.revision).toBeGreaterThan(first.model!.revision as number);
 for(const lane of lanes){
  await publish(lane,day);expect(await rows(lane.target,day)).toEqual(changed);
  await lane.target.prepare("UPDATE analytics_community_graph_results SET computed_ms=? WHERE metric='model' AND day=?").bind(t+60000+300001,day).run();
  expect(await lane.kernel.publishStorageCommunityModelDay(bindings(lane.target),{day,nowMs:Date.now()})).toMatchObject({state:'deferred',reason:'cache_pending'});
  expect(await rows(lane.target,day)).toEqual(changed);
 }
},180000);
