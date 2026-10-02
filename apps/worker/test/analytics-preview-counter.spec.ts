import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {publishStorageCommunityGraphPreview,publishStorageCommunityModelDay,retireStorageCommunityGraphPublications} from '../src/storage-community-graph-publication';
import {advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';
import {createNativePreviewCounter,nativePreviewCounterSql,assertNativePreviewCounterPair} from './helpers/analytics-preview-counter';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-p11-preview-counter',sourceNamespace=sourceId;
type Row=Record<string,unknown>;
const row=(db:D1Database)=>db.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind(sourceId).first<Row>();
const columns=['source_id','revision','method','cohort_digest','authority_json','model_revision','payload_json','payload_sha256','generated_at','snapshot_source_epoch','inputs_current','oldest_computed_ms','newest_computed_ms'];
const bindings=(db:{source:D1Database;target:D1Database})=>({...db,sourceId,sourceNamespace});
async function setup(){
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const meter=createWholeWorkloadMeter(source,target);
 let done=false;for(let i=0;i<16;i++){const r=await meter.invocation('delivery',db=>advanceStorageAnalytics(bindings(db)));if(r.state==='idle'){done=true;break;}}
 expect(done).toBe(true);return Date.now()-60000;
}
function observed(targetDb=target){
 const counter=createNativePreviewCounter(sourceId),meter=createWholeWorkloadMeter(source,targetDb,undefined,undefined,undefined,undefined,counter);
 const read=()=>meter.invocation('counter_read',db=>row(db.target));
 const start=async()=>{const current=await read();await meter.invocation('counter_start',()=>counter.start(current));return current;};
 const finish=async()=>{const current=await read();const proof=await meter.invocation('counter_finish',()=>counter.finish(current));return {row:current!,proof};};
 return {counter,meter,read,start,finish,publish:(nowMs:number)=>meter.invocation('preview',db=>publishStorageCommunityGraphPreview(bindings(db),{nowMs}))};
}
function refreshBinds(r:Row,inputs=r.inputs_current){return [r.authority_json,r.snapshot_source_epoch,inputs,r.oldest_computed_ms,r.newest_computed_ms,sourceId,r.revision,r.cohort_digest,r.payload_sha256,r.snapshot_source_epoch,sourceId,r.model_revision];}
function upsertBinds(r:Row,expected:number,extras:unknown[]=[]){return [...columns.map(name=>name==='revision'?expected+1:r[name]),sourceId,r.model_revision,...extras,expected,r.snapshot_source_epoch,r.generated_at];}
function responseLoss(database:D1Database){let fired=false;
 const prepare=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(inner,key){
  if(key==='bind')return(...values:unknown[])=>prepare(inner.bind(...values),sql);
  if(key==='run')return async()=>{const result=await inner.run();if(!fired&&sql.includes('INSERT INTO analytics_community_graph_previews')){fired=true;throw Error('SYNTHETIC_COMMITTED_RESPONSE_LOSS');}return result;};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
 return {database:new Proxy(database,{get(inner,key){if(key==='prepare')return(sql:string)=>prepare(inner.prepare(sql),sql);const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;}}),fired:()=>fired};
}
it('traces actual native insert, unchanged replay and changed model publication with every probe in the same 950 meter',async()=>{
 const now=await setup(),o=observed();await o.start();
 expect((await o.publish(now)).state).toBe('published');const first=await o.read();expect(first!.revision).toBe(1);
 expect((await o.publish(now+1)).state).toBe('unchanged');expect(await o.read()).toEqual(first);
 const day=new Date(now-86400000).toISOString().slice(0,10);
 expect((await o.meter.invocation('model',db=>publishStorageCommunityModelDay(bindings(db),{day,nowMs:now}))).state).toBe('published');
 expect((await o.publish(now+2)).state).toBe('published');
 const final=await o.finish(),summary=summarizeWholeWorkload(o.meter.profile);
 expect(final.row.revision).toBe(2);expect(final.proof.receipt).toMatchObject({complete:true,initialRevision:null,finalRevision:2,counts:{upsert:2,refresh:0,retire:0,unchanged:0,failedWrites:0,unknownWrites:0},observationCost:{statements:10,includedInInvocationMeter:true,includedInWorkloadProfile:true}});
 expect(summary.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);expect(summary.measurementFailures).toBe(0);
 assertNativePreviewCounterPair(final,final);
 expect(()=>assertNativePreviewCounterPair(final,{...final,row:{...final.row,revision:3}})).toThrow('UNPROVED_ROW');
 expect(()=>assertNativePreviewCounterPair(final,{row:final.row,proof:{receipt:final.proof.receipt}})).toThrow('UNPROVED_ROW');
 console.log('preview-counter-component',JSON.stringify({schema:'native-preview-counter-component-v1',receipt:final.proof.receipt,statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,maxStatements:summary.maximumStatementsPerInvocation}));
},60000);
it('proves native proof-only refresh and native retirement delete/reinsert from exact observed startup rows',async()=>{
 const now=await setup();expect((await publishStorageCommunityGraphPreview({source,target,sourceId,sourceNamespace},{nowMs:now})).state).toBe('published');
 // Explicit stale-proof startup fixture, before tracing; native arithmetic/body remains intact.
 await target.prepare('UPDATE analytics_community_graph_previews SET inputs_current=0 WHERE source_id=?').bind(sourceId).run();
 const o=observed(),before=await o.start();expect((await o.publish(now+1)).state).toBe('unchanged');const fresh=await o.finish();
 expect(fresh.proof.receipt).toMatchObject({initialRevision:1,finalRevision:2,counts:{refresh:1,upsert:0}});
 expect(fresh.row).toEqual({...before,revision:2,inputs_current:1});
 // A native-obsolete method at the next independent trace startup owns retirement.
 await target.prepare("UPDATE analytics_community_graph_previews SET method='synthetic-obsolete' WHERE source_id=?").bind(sourceId).run();
 const retired=observed();await retired.start();await retired.meter.invocation('retire',db=>retireStorageCommunityGraphPublications(bindings(db)));expect(await retired.read()).toBeNull();
 expect((await retired.publish(now+2)).state).toBe('published');const final=await retired.finish();
 expect(final.proof.receipt).toMatchObject({initialRevision:2,finalRevision:1,counts:{retire:1,upsert:1}});
},60000);
it('records exact native stale CAS, missing closure and missing lease as unchanged rows without trusting changes metadata',async()=>{
 const now=await setup(),o=observed();await o.start();await o.publish(now);const before=(await o.read())!;
 await o.meter.invocation('stale_cas',async db=>{const result=await db.target.prepare(nativePreviewCounterSql('upsert')).bind(...upsertBinds(before,9)).run();expect(result.success).toBe(true);});
 await o.meter.invocation('closure_refused',db=>db.target.prepare(nativePreviewCounterSql('upsert',{closure:true})).bind(...upsertBinds(before,1,['missing'])).run());
 await o.meter.invocation('lease_refused',db=>db.target.prepare(nativePreviewCounterSql('upsert',{lease:true})).bind(...upsertBinds(before,1,['missing',1,'missing',Date.now()])).run());
 expect(await o.read()).toEqual(before);const final=await o.finish();expect(final.proof.receipt).toMatchObject({counts:{upsert:1,unchanged:3},finalRevision:1});
},60000);
it('rejects unobserved full-row changes, unknown writes and schema changes even when a native operation can continue',async()=>{
 const now=await setup();await publishStorageCommunityGraphPreview({source,target,sourceId,sourceNamespace},{nowMs:now});
 const tamper=observed();await tamper.start();await target.prepare('UPDATE analytics_community_graph_previews SET revision=revision+1 WHERE source_id=?').bind(sourceId).run();
 await expect(tamper.finish()).rejects.toThrow('FINAL_ROW');tamper.counter.close();
 const unknown=observed();await unknown.start();await unknown.meter.invocation('unknown',db=>db.target.prepare('UPDATE analytics_community_graph_previews SET revision=revision WHERE source_id=?').bind(sourceId).run());
 await expect(unknown.finish()).rejects.toThrow('INCOMPLETE_TRACE');expect(unknown.counter.diagnostic().gaps).toContain('UNKNOWN_PREVIEW_WRITE');unknown.counter.close();
 const schema=observed();await schema.start();await schema.meter.invocation('ddl',db=>db.target.prepare('CREATE TABLE synthetic_counter_side(value INTEGER)').run());
 await expect(schema.finish()).rejects.toThrow('SCHEMA_CHANGED');expect(schema.counter.diagnostic().gaps).toContain('UNREVIEWED_TARGET_DDL');schema.counter.close();
},60000);
it('keeps committed response loss incomplete even when the native publisher reconciles the exact row',async()=>{
 const now=await setup(),loss=responseLoss(target),o=observed(loss.database);await o.start();
 expect((await o.publish(now)).state).toBe('published');expect(loss.fired()).toBe(true);
 await expect(o.finish()).rejects.toThrow('FINAL_ROW');expect(o.counter.diagnostic()).toMatchObject({complete:false,counts:{failedWrites:1},gaps:expect.arrayContaining(['NATIVE_WRITE_FAILED_OR_RESPONSE_LOST'])});o.counter.close();
 // A separate new trace can start only from the actual verified committed row.
 const retry=observed();const initial=await retry.start();expect(initial!.revision).toBe(1);expect((await retry.publish(now)).state).toBe('unchanged');expect((await retry.finish()).proof.receipt.complete).toBe(true);
},60000);
it('independently proves unequal native CAS counters while preserving every other complete row field',async()=>{
 const now=await setup(),first=observed();await first.start();await first.publish(now);const reference=await first.finish();
 const second=observed();await second.start();
 for(const flag of [0,1])await second.meter.invocation('native_refresh_shape',async db=>{const current=(await row(db.target))!;await db.target.prepare(nativePreviewCounterSql('refresh')).bind(...refreshBinds(current,flag)).run();});
 const candidate=await second.finish();expect(reference.row.revision).toBe(1);expect(candidate.row.revision).toBe(3);assertNativePreviewCounterPair(reference,candidate);
 expect(candidate.proof.receipt).toMatchObject({initialRevision:1,finalRevision:3,counts:{refresh:2}});
 const third=observed();await third.start();const value=(await third.read())!;await third.meter.invocation('different_field',db=>db.target.prepare(nativePreviewCounterSql('refresh')).bind(...refreshBinds(value,0)).run());const changed=await third.finish();
 expect(()=>assertNativePreviewCounterPair(candidate,changed)).toThrow('NONCOUNTER_DIFFERENCE');
},60000);

import {advanceAnalyticsWorkRetirement} from '../src/storage-analytics-work-retirement';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
it('traces genuine native cleanup metadata without losing preview or physical 950 accounting',async()=>{
 const now=await setup(),physical=createD1InvocationBudget(950),counter=createNativePreviewCounter(sourceId);
 const measured=createWholeWorkloadMeter(physical.wrap(source),physical.wrap(target),undefined,undefined,undefined,undefined,counter);
 try{
  await measured.invocation('counter_start',()=>counter.start(null));
  expect((await measured.invocation('preview',db=>publishStorageCommunityGraphPreview(bindings(db),{nowMs:now}))).state).toBe('published');
  const before=await measured.invocation('before',db=>row(db.target));expect(before!.revision).toBe(1);
  const beforeCleanup=physical.queriesUsed;
  const retired=await measured.invocation('candidate_cleanup',(db,meter)=>advanceAnalyticsWorkRetirement({
   target:db.target,sourceId,meter,now:Date.now,deadlineMs:Date.now()+60000,completedBeforeMs:now-86400000}));
  const cleanupStatements=physical.queriesUsed-beforeCleanup;
  expect(retired.state).toBe('idle');expect(retired.statements).toBe(cleanupStatements);
  const after=await measured.invocation('after',db=>row(db.target));expect(after).toEqual(before);
  const proof=await measured.invocation('counter_finish',()=>counter.finish(after));
  const profile=summarizeWholeWorkload(measured.profile);
  const scalar={schema:'native-preview-cleanup-metadata-v1',physicalStatements:physical.queriesUsed,
   profiledStatements:profile.statements,cleanupStatements,retirementStatements:retired.statements,
   rowsRead:profile.rowsRead,rowsWritten:profile.rowsWritten,maximumStatementsPerInvocation:profile.maximumStatementsPerInvocation,
   measurementFailures:profile.measurementFailures,receipt:proof.receipt,classification:counter.diagnostic().classification,setupCostIncluded:false};
  console.log('preview-counter-cleanup-component',JSON.stringify(scalar));
  expect(profile.statements).toBe(physical.queriesUsed);expect(profile.measurementFailures).toBe(0);
  expect(profile.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);
  expect(proof.receipt).toMatchObject({complete:true,initialRevision:null,finalRevision:1,counts:{upsert:1,failedWrites:0,unknownWrites:0}});
  expect(counter.diagnostic()).toMatchObject({classification:{readOnlyMetadata:{statements:3,shapes:[
    {id:'partition_work_columns',method:'batch',attempts:1},
    {id:'canonical_effect_columns',method:'batch',attempts:1},
    {id:'effect_reference_columns',method:'batch',attempts:1},
   ]},unsupported:{attempts:0,fingerprints:[],overflow:false}}});
 }finally{counter.close();}
},60000);
it('refuses a genuine unreviewed metadata read even after successful native cleanup with an unchanged full preview row',async()=>{
 const now=await setup(),o=observed();await o.start();await o.publish(now);const before=await o.read();
 try{
  await o.meter.invocation('candidate_cleanup',(db,meter)=>advanceAnalyticsWorkRetirement({
   target:db.target,sourceId,meter,now:Date.now,deadlineMs:Date.now()+60000,completedBeforeMs:now-86400000}));
  const unknown='PRAGMA table_info(analytics_owner_state)';
  await o.meter.invocation('unreviewed_metadata',db=>db.target.batch([db.target.prepare(unknown)]));
  expect(await o.read()).toEqual(before);await expect(o.finish()).rejects.toThrow('INCOMPLETE_TRACE');
  expect(o.counter.diagnostic()).toMatchObject({complete:false,counts:{unknownWrites:0},gaps:expect.arrayContaining(['UNREVIEWED_TARGET_DDL','UNSUPPORTED_SQL_SHAPE']),
   classification:{readOnlyMetadata:{statements:3},unsupported:{attempts:1,fingerprints:[{method:'batch',attempts:1}]}}});
 }finally{o.counter.close();}
},60000);
