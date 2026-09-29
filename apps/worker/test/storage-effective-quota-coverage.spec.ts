import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {createV11DeviceFixture} from './helpers/telemetry-v11';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {createStorageEffectiveQuotaPreparation} from '../src/storage-effective-quota-days';
import {finishEffectiveQuotaDay} from '../src/effective-quota-day';
import {readGraphDayEffectiveQuotaHeads,writeGraphDayProjection} from '../src/graph-day-projection';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createV11QuotaAcquisitionIdentity} from '../src/quota-analysis-v11';
import type {StorageCommunityOwner} from '../src/storage-community-authority';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const namespace='synthetic-effective-quota-coverage',day='2026-09-04',missing='2026-09-05';
let owner:StorageCommunityOwner&{ownerDigest:string};
const prepared=(selectedDay=day)=>finishEffectiveQuotaDay({day:selectedDay,quotaRowsRead:0,rows:[]})!;
const identity=()=>createV11QuotaAcquisitionIdentity({source:'v1.1',participantId:owner.participantId,
 generationId:'synthetic-effective-generation',fromDay:day,throughDay:missing,
 inputRevision:1,mutationEpoch:1,fingerprint:'b'.repeat(64)},Date.parse(`${missing}T23:00:00.000Z`));

beforeEach(async()=>{
 await reset();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,
  b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])
  await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),namespace);
 await initializeTypedV1Admission(source(),namespace);
 await initializeTypedV11Admission(source(),namespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await drainCommunityPublicSourceBootstrap(source());
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId:namespace,sourceNamespace:namespace});
 const fixture=await createV11DeviceFixture(source());
 owner={participantId:fixture.participantId,ownerDigest:'a'.repeat(64),inputRevision:1,ownerRevision:1,
  authorityEpoch:1,hasV1:false,hasV11:false,hasV12:false,hasLegacy:false,hasEffective:true};
 await source().prepare(`INSERT INTO storage_v11_owner_links
  (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,'active',?,?)`)
  .bind(owner.participantId,owner.ownerDigest,owner.ownerDigest,owner.ownerDigest).run();
 await source().prepare(`INSERT INTO storage_owner_revisions
  (owner_digest,revision,authority_epoch,state) VALUES(?,1,1,'active')`).bind(owner.ownerDigest).run();
 await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
  .bind(namespace,owner.ownerDigest).run();
 const seed=await cache();expect(await seed.value.store(prepared())).toBe('stored');
});

async function cache(sourceDb=source(),targetDb=target(),options:{remaining?:()=>number;now?:()=>number}={}){
 const meter=createD1InvocationBudget(950),sourceMeter=createD1InvocationBudget(950);
 const value=await createStorageEffectiveQuotaPreparation({source:meter.wrap(sourceMeter.wrap(sourceDb)),
  target:meter.wrap(targetDb),sourceId:namespace,sourceNamespace:namespace,owner,
  remainingQueries:options.remaining??(()=>meter.remainingQueries),deadlineMs:100,now:options.now??(()=>0)});
 if(!value)throw new Error('synthetic cache unavailable');
 return {value,meter,sourceMeter};
}

describe('effective quota coverage cache admission and invocation memo',()=>{
 it('allows one exact re-probe after filling a gap and refuses a stale suffix without looping',async()=>{
  const staleDay='2026-09-06',lastDay='2026-09-07',days=[day,missing,staleDay,lastDay];
  for(const selectedDay of [staleDay,lastDay]){
   const seed=await cache();expect(await seed.value.store(prepared(selectedDay))).toBe('stored');
  }
  const heads=await readGraphDayEffectiveQuotaHeads({target:target(),sourceId:namespace,sourceNamespace:namespace,
   ownerDigest:owner.ownerDigest,fromDay:staleDay,throughDay:staleDay});
  const head=heads![0]!;
  expect((await writeGraphDayProjection({target:target(),key:{...head.key,manifestDigest:'c'.repeat(64)},
   projection:prepared(staleDay).projection,effectiveQuota:{quotaRowsRead:0,ownerRevision:1}})).status).toBe('stored');
  await target().prepare('DELETE FROM analytics_graph_day_values WHERE value_key=?').bind(head.cursor.valueKey).run();
  let probes=0,payloadReads=0;
  const observed=new Proxy(target(),{get(database,key){
   if(key==='prepare')return(sql:string)=>{
    if(sql.includes('WITH heads AS MATERIALIZED'))probes++;
    if(sql.includes('SELECT part_index,component,entry_count,part_digest,payload_json'))payloadReads++;
    return database.prepare(sql);
   };
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const current=await cache(source(),observed);
  expect(await current.value.load(days,identity())).toBeUndefined();
  expect(await current.value.nextMissingDay!(days,[])).toBe(missing);
  expect(probes).toBe(1);
  expect(await current.value.store(prepared(missing))).toBe('stored');
  expect(await current.value.load(days,identity())).toBeUndefined();
  expect(probes).toBe(2);expect(payloadReads).toBe(0);
  expect(await current.value.nextMissingDay!(days,[])).toBe(staleDay);
  const before=current.sourceMeter.queriesUsed;
  expect(await current.value.store(prepared(staleDay))).toBe('stored');
  // The failed exact suffix validation seeded its digest under the same
  // immutable owner scope; only the two owner checks are repeated here.
  expect(current.sourceMeter.queriesUsed-before).toBe(2);
  const used=current.meter.queriesUsed;
  expect(await current.value.load(days,identity())).toBeUndefined();
  expect(current.meter.queriesUsed).toBe(used);
  expect(probes).toBe(2);expect(payloadReads).toBe(0);
  const fresh=await cache();
  expect((await fresh.value.load(days,identity()))?.map(value=>value.projection.day)).toEqual(days);
 });

 it('reuses only an invocation-local digest while fencing both consumers',async()=>{
  const current=await cache();
  expect(await current.value.load([day,missing],identity())).toBeUndefined();
  expect(await current.value.nextMissingDay!([day,missing],[])).toBe(missing);
  expect(await current.value.nextMissingDay!([day,missing],[missing])).toBeUndefined();
  const before=current.sourceMeter.queriesUsed;
  expect(await current.value.shouldPrepare!(day)).toBe(false);
  expect(current.sourceMeter.queriesUsed-before).toBe(9);
  const primed=current.sourceMeter.queriesUsed;
  expect(await current.value.store(prepared())).toBe('stored');
  expect(current.sourceMeter.queriesUsed-primed).toBe(2);
  const fresh=await cache();
  expect(await fresh.value.store(prepared())).toBe('stored');
  expect(fresh.sourceMeter.queriesUsed).toBe(9);
  // Nine dependency statements include the correction runtime fence; the
  // two subsequent owner checks remain independent for the second consumer.
  expect(current.sourceMeter.queriesUsed-before).toBe(11);
 });

 it.each(['revision','authority_epoch'] as const)('refuses a memo after the source %s advances',async column=>{
  const current=await cache();
  await current.value.load([day,missing],identity());
  expect(await current.value.shouldPrepare!(day)).toBe(false);
  await source().prepare(`UPDATE storage_owner_revisions SET ${column}=${column}+1 WHERE owner_digest=?`)
   .bind(owner.ownerDigest).run();
  const before=current.meter.queriesUsed;
  await expect(current.value.store(prepared())).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  expect(current.meter.queriesUsed-before).toBe(1);
 });

 it('refuses a memo when target owner authority was erased',async()=>{
  const current=await cache();await current.value.load([day,missing],identity());
  expect(await current.value.shouldPrepare!(day)).toBe(false);
  await target().prepare("UPDATE analytics_owner_state SET revision=2,authority_epoch=2,state='erased'") .run();
  await expect(current.value.store(prepared())).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  // The separate durable retirement lane owns physical erasure. This stale
  // writer must refuse without inserting or replacing any prepared value.
  expect(await target().prepare('SELECT count(*) n FROM analytics_graph_day_values').first('n')).toBe(1);
 });

 it('reports bounded write refusal and permits the same completed value to retry',async()=>{
  let remaining=159,now=0;
  const current=await cache(source(),target(),{remaining:()=>remaining,now:()=>now});
  const before=current.meter.queriesUsed;
  expect(await current.value.store(prepared())).toBe('deferred');
  expect(current.meter.queriesUsed).toBe(before);
  remaining=950;now=100;
  expect(await current.value.store(prepared())).toBe('deferred');
  expect(current.meter.queriesUsed).toBe(before);
  now=0;expect(await current.value.store(prepared())).toBe('stored');
 });

 it('retries a committed cache write whose response was lost without inserting another value',async()=>{
  let batches=0;
  const interrupted=new Proxy(target(),{get(database,key){
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    const result=await database.batch(statements);
    if(++batches===1)throw new Error('synthetic committed cache response loss');
    return result;
   };
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const current=await cache(source(),interrupted),complete=prepared(missing);
  await expect(current.value.store(complete)).rejects.toThrow('synthetic committed cache response loss');
  expect(await target().prepare('SELECT count(*) n FROM analytics_graph_day_values WHERE day=?').bind(missing).first('n')).toBe(1);
  expect(await current.value.store(complete)).toBe('stored');
  expect(batches).toBe(1);
  expect((await current.value.load([day,missing],identity()))?.map(value=>value.projection.day)).toEqual([day,missing]);
 });

 it.each(['payload','clusters'] as const)('does not open a gap when existing heads already exceed the %s bound',async kind=>{
  let payloadReads=0;
  const inflated=new Proxy(target(),{get(database,key){
   if(key==='prepare')return(sql:string)=>{
    if(sql.includes('SELECT part_index,component,entry_count,part_digest,payload_json'))payloadReads++;
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,member){
     if(member==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
     if(member==='all'&&sql.includes('AS fit_fragment_count')&&sql.includes('AS payload_bytes'))return async()=>{
      const result=await inner.all<Record<string,unknown>>();
      return {...result,results:result.results.map(row=>({...row,
       ...(kind==='payload'?{part_count:33,payload_bytes:8*1024*1024+1}
        :{part_count:16,record_count:4097,quota_rows_read:4097,fit_fragment_count:4097,payload_bytes:2_000_000})}))};
     };
     const value=Reflect.get(inner,member);return typeof value==='function'?value.bind(inner):value;
    }});return wrap(database.prepare(sql));
   };
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const current=await cache(source(),inflated);
  expect(await current.value.load([day,missing],identity())).toBeUndefined();
  expect(await current.value.nextMissingDay!([day,missing],[])).toBeUndefined();
  expect(current.sourceMeter.queriesUsed).toBe(0);
  expect(payloadReads).toBe(0);
 });

 it('does not interpret a budget refusal as a missing day',async()=>{
  const current=await cache(source(),target(),{remaining:()=>259});
  expect(await current.value.load([day,missing],identity())).toBeUndefined();
  expect(await current.value.nextMissingDay!([day,missing],[])).toBeUndefined();
  expect(current.sourceMeter.queriesUsed).toBe(0);
 });
 it('keeps the 200-statement fallback reserve before reading a warm window dependency',async()=>{
  const seed=await cache();expect(await seed.value.store(prepared(missing))).toBe('stored');
  let checks=0;
  // The first check admits the head probe. The next one has exactly the old
  // reserve, which is one statement short of the correction runtime fence.
  const current=await cache(source(),target(),{remaining:()=>++checks===1?950:209});
  expect(await current.value.load([day,missing],identity())).toBeUndefined();
  expect(checks).toBe(2);
  expect(current.sourceMeter.queriesUsed).toBe(0);
 });
});
