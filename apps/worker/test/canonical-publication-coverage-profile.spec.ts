import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {normalizeNativeEffectiveOccurrence} from '../src/canonical-analytics-facts';
import {materializeCanonicalPage,materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {canonicalPublicationProducerCoverage} from '../src/storage-canonical-publication';
import {admitAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {sha256Hex} from '../src/crypto';
import {v11UsageRecord} from './helpers/telemetry-v11';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-coverage-profile',day='2026-09-20';
const scope={sourceNamespace:sourceId,ownerDigest:'a'.repeat(64),selectionMethod:'effective-union-v1' as const};
const unknown={presence:'unknown' as const,value:null};
const producerIndex='CREATE INDEX analytics_partition_work_producer ON analytics_partition_work(source_id,stage,input_revision,partition_key)';
const baseline=(family:'cache'|'activity')=>`SELECT 1 missing FROM analytics_canonical_heads h JOIN analytics_canonical_facts f ON f.revision=h.revision
 WHERE f.source_id=? AND ${family==='cache'?"f.stream='usage'":"f.observed_day=?"} AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r
 JOIN analytics_partition_work w ON w.input_revision=r.content_revision AND w.source_id=f.source_id AND w.stage='${family}'
 JOIN analytics_canonical_partition_heads p ON p.partition_key=w.partition_key AND p.content_revision=w.input_revision
 WHERE r.revision=f.revision) LIMIT 1`;
function observed(database:D1Database){
 let calls=0,reads=0;
 const value=new Proxy(database,{get(original,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(member,name){
    if(name==='bind')return(...values:unknown[])=>wrap(member.bind(...values));
    if(name==='first')return async(column?:string)=>{const result=await member.all<Record<string,unknown>>();calls++;reads+=result.meta.rows_read;
     const row=result.results[0];return row?(column===undefined?row:row[column]):null;};
    const method=Reflect.get(member,name);return typeof method==='function'?method.bind(member):method;
   }});return wrap(original.prepare(sql));
  };
  const method=Reflect.get(original,key);return typeof method==='function'?method.bind(original):method;
 }});
 return {value,counts:()=>({calls,reads})};
}
it('preserves exact current-fact producer incidence and avoids unrelated queue scans for both publication families',async()=>{
 await reset();await applyD1Migrations(db,b.TEST_ANALYTICS_MIGRATIONS);
 await db.prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(sourceId,sourceId).run();
 await db.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
 .bind(sourceId,scope.ownerDigest).run();
 const facts=await Promise.all(Array.from({length:8},async(_,n)=>{
  const id=n.toString(16).padStart(64,'0'),record=v11UsageRecord(day,'a',{eventId:'event:v2:'+id});
  return normalizeNativeEffectiveOccurrence(scope,{methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-private',
   ownerDigest:scope.ownerDigest,occurrenceId:record.eventId,eventTime:record.eventTime,eventTimeConflict:false,status:'compatible',
   sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),
   canonicalEvidence:{linkedDays:[day],variants:[{coordinate:'synthetic-variant:'+id,format:'v11',observedAtMs:Date.parse(record.eventTime)}],
    boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown}},n);
 }));
 await materializeCanonicalPage({db,sourceId,scope,ownerRevision:1,authorityEpoch:1,pageKey:await sha256Hex('synthetic-page'),
  sourceRevision:await sha256Hex('synthetic-proof'),stillCurrent:async()=>true,
  load:async()=>facts.map(fact=>({occurrenceKey:fact.occurrenceKey,stream:fact.stream,expectedRevision:null,fact}))});
 const check=async()=>{
  for(const family of ['activity','cache'] as const){
   const old=(await db.prepare(baseline(family)).bind(sourceId,...(family==='activity'?[day]:[])).all()).results.length===0;
   expect(await canonicalPublicationProducerCoverage(db,family==='activity'?{sourceId,family,day}:{sourceId,family})).toBe(old);
  }
 };
 await check();expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'cache'})).toBe(false);
 const requests:AnalyticsWorkRequest[]=[];
 for(const key of new Set(facts.map(fact=>fact.location.partitionKey))){
  const part=await materializeCanonicalPartition(db,key);if(part.state!=='complete')throw Error('SYNTHETIC_SPLIT_UNEXPECTED');
  for(const stage of ['activity','cache'] as const)requests.push({sourceId,ownerDigest:null,stage,lane:'new',partitionKey:key,
   headKey:await sha256Hex(stage+key),inputRevision:part.manifest.contentRevision,policyRevision:'b'.repeat(64),day,stream:'usage',
   selectionMethod:scope.selectionMethod,residentBytes:1,admissionQueries:1});
 }
 await admitAnalyticsPartitionWork(db,requests,0);await check();
 expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'cache'})).toBe(true);
 for(let offset=0;offset<512;offset+=32){
  const noise:AnalyticsWorkRequest[]=await Promise.all(Array.from({length:32},async(_,n)=>({sourceId,ownerDigest:null,stage:'cleanup' as const,
   lane:'history' as const,partitionKey:'unrelated/'+(offset+n),headKey:await sha256Hex('noise/'+(offset+n)),inputRevision:'c'.repeat(64),
   policyRevision:'b'.repeat(64),day:null,stream:null,selectionMethod:null,residentBytes:1,admissionQueries:1})));
  await admitAnalyticsPartitionWork(db,noise,0);
 }
 await db.prepare('DROP INDEX analytics_partition_work_producer').run();
 const originalReads:Record<string,number>={};
 for(const family of ['activity','cache'] as const){const result=await db.prepare(baseline(family)).bind(sourceId,...(family==='activity'?[day]:[])).all();
  expect(result.results).toEqual([]);originalReads[family]=result.meta.rows_read;}
 await db.prepare(producerIndex).run();
 for(const family of ['activity','cache'] as const){
  const observation=observed(db),meter=createD1InvocationBudget(950);
  expect(await canonicalPublicationProducerCoverage(meter.wrap(observation.value),family==='activity'?{sourceId,family,day}:{sourceId,family})).toBe(true);
  expect(meter.queriesUsed).toBe(1);expect(observation.counts().calls).toBe(1);
  expect(observation.counts().reads).toBeLessThan(originalReads[family]!/3);
  console.log(JSON.stringify({event:'canonical_producer_coverage_profile',family,originalReads:originalReads[family],reads:observation.counts().reads}));
 }
 // A current fact is never covered by a stale manifest or a missing producer.
 const head=await db.prepare('SELECT partition_key,content_revision FROM analytics_canonical_partition_heads LIMIT 1')
 .first<{partition_key:string;content_revision:string}>();expect(head).toBeTruthy();
 await db.prepare('DELETE FROM analytics_canonical_partition_heads WHERE partition_key=?').bind(head!.partition_key).run();await check();
 expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'cache'})).toBe(false);
 await db.prepare('INSERT INTO analytics_canonical_partition_heads VALUES(?,?)').bind(head!.partition_key,head!.content_revision).run();await check();
 await db.prepare("DELETE FROM analytics_partition_work WHERE stage='cache' AND partition_key=?").bind(head!.partition_key).run();await check();
 expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'cache'})).toBe(false);
 expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'activity',day})).toBe(true);
 expect(await canonicalPublicationProducerCoverage(db,{sourceId,family:'activity',day:'2026-09-19'})).toBe(true);
 expect(await canonicalPublicationProducerCoverage(db,{sourceId:'synthetic-other',family:'cache'})).toBe(true);
},60_000);
