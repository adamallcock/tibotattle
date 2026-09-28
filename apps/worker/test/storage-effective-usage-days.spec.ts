import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createV11DeviceFixture} from './helpers/telemetry-v11';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {createStorageEffectiveUsagePreparation,type StorageEffectiveUsagePreparation} from '../src/storage-effective-usage-days';
import {GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX,reduceGraphDayProjection,readGraphDayEffectiveUsageHeads,
 writeGraphDayProjection} from '../src/graph-day-projection';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createV11QuotaAcquisitionIdentity} from '../src/quota-analysis-v11';
import {advanceStorageEffectiveAnalysis,type StorageEffectiveHistoryCheckpoint} from '../src/storage-effective-history';
import * as effectiveHistory from '../src/storage-effective-history';
import {captureStorageGraphScope,computeStorageGraphResult,storageGraphEffectiveCheckpointKey,
 STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD} from '../src/storage-community-graph';
import {loadStorageHistoryCheckpoint,saveStorageHistoryCheckpoint,storageHistoryCheckpointParts,
 storageHistoryKeyDigest} from '../src/storage-history-checkpoint';
import type {StorageCommunityOwner} from '../src/storage-community-authority';
import type {V11SourcePin} from '../src/telemetry-v11-domain';
import {COMPOSITION_CACHE_KEY_SUFFIX} from '../src/community-allowance';
import {sha256Hex} from '../src/crypto';
import {MAX_WINDOWED_USAGE_ROWS} from '../src/quota-analysis-v1';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const namespace='synthetic-effective-usage-cache',day='2026-09-04',missing='2026-09-05';
let owner:StorageCommunityOwner&{ownerDigest:string};
const prepared=(selectedDay=day)=>({projection:reduceGraphDayProjection(selectedDay,[])});
const manifestId=async()=>GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX+await sha256Hex(COMPOSITION_CACHE_KEY_SUFFIX);
beforeEach(async()=>{
 await reset();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,
  b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])
  await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),namespace);
 await initializeTypedV1Admission(source(),namespace);await initializeTypedV11Admission(source(),namespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);await drainCommunityPublicSourceBootstrap(source());
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
 await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(namespace,owner.ownerDigest).run();
});
async function cache(sourceDb=source(),targetDb=target(),options:{remaining?:()=>number;now?:()=>number}={}){
 const meter=createD1InvocationBudget(950),sourceMeter=createD1InvocationBudget(950);
 const value=await createStorageEffectiveUsagePreparation({source:meter.wrap(sourceMeter.wrap(sourceDb)),
  target:meter.wrap(targetDb),sourceId:namespace,sourceNamespace:namespace,owner,
  remainingQueries:options.remaining??(()=>meter.remainingQueries),deadlineMs:100,now:options.now??(()=>0)});
 if(!value)throw new Error('synthetic usage cache unavailable');
 return {value,meter,sourceMeter};
}
describe('effective usage cache fences and complete coverage',()=>{
 it('fills exact missing days and revalidates the complete window without quota or usage source pages',async()=>{
  const current=await cache();
  expect(await current.value.load([day,missing])).toBeUndefined();
  expect(await current.value.nextMissingDay([day,missing])).toBe(day);
  expect(await current.value.store(prepared())).toBe('stored');
  expect(await current.value.nextMissingDay([day,missing])).toBe(missing);
  expect(await current.value.store(prepared(missing))).toBe('stored');
  const before=current.sourceMeter.queriesUsed;
  expect(await current.value.load([day,missing])).toEqual([prepared(),prepared(missing)]);
  // Both exact day digests were computed while storing, under this invocation's
  // immutable owner scope. Loading still repeats its before/after owner fence.
  expect(current.sourceMeter.queriesUsed-before).toBe(2);
  const warm=await cache();expect(await warm.value.load([day,missing])).toEqual([prepared(),prepared(missing)]);
  expect(warm.sourceMeter.queriesUsed).toBe(9);
 });
 it('reuses an unchanged day after an unrelated owner revision advance',async()=>{
  const old=await cache();await old.value.store(prepared());
  await source().prepare('UPDATE storage_owner_revisions SET revision=2').run();owner={...owner,ownerRevision:2};
  const current=await cache();expect(await current.value.load([day])).toEqual([prepared()]);
 });
 it.each(['revision','authority_epoch'] as const)('refuses a stored digest memo after source %s changes',async column=>{
  const current=await cache();await current.value.store(prepared());
  await source().prepare(`UPDATE storage_owner_revisions SET ${column}=${column}+1`).run();
  await expect(current.value.store(prepared())).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  await expect(current.value.load([day])).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
 });
 it('refuses target erasure before writing a completed day',async()=>{
  const current=await cache();
  await target().prepare("UPDATE analytics_owner_state SET revision=2,authority_epoch=2,state='erased'").run();
  await expect(current.value.store(prepared())).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  expect(await target().prepare('SELECT count(*) n FROM analytics_graph_day_values').first('n')).toBe(0);
 });
 it('treats an old pricing profile as a missing day',async()=>{
  const current=await cache();await current.value.store(prepared());
  const heads=await readGraphDayEffectiveUsageHeads({target:target(),sourceId:namespace,sourceNamespace:namespace,
   ownerDigest:owner.ownerDigest,manifestId:await manifestId(),fromDay:day,throughDay:day});
  const head=heads![0]!;
  await writeGraphDayProjection({target:target(),key:{...head.key,manifestId:GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX+'f'.repeat(64)},
   projection:prepared().projection,effectiveUsage:{ownerRevision:1}});
  await target().prepare('DELETE FROM analytics_graph_day_values WHERE value_key=?').bind(head.cursor.valueKey).run();
  const fresh=await cache();expect(await fresh.value.load([day])).toBeUndefined();
  expect(await fresh.value.nextMissingDay([day])).toBe(day);
 });
 it('preserves a deferred completed write and idempotently retries a committed response loss',async()=>{
  let remaining=159,batches=0;
  const lost=new Proxy(target(),{get(database,key){
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    const result=await database.batch(statements);if(++batches===1)throw new Error('synthetic usage response loss');return result;
   };const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const current=await cache(source(),lost,{remaining:()=>remaining});
  expect(await current.value.store(prepared())).toBe('deferred');expect(batches).toBe(0);
  remaining=950;await expect(current.value.store(prepared())).rejects.toThrow('synthetic usage response loss');
  expect(await current.value.store(prepared())).toBe('stored');expect(batches).toBe(1);
  expect(await current.value.load([day])).toEqual([prepared()]);
 });
 it('rejects an unrepresentable model state as a persistent preparation refusal',async()=>{
  const current=await cache(),projection=prepared().projection;
  const sessions=Array.from({length:4097},(_,index)=>({sessionDigest:index.toString(16).padStart(64,'0'),
   lastObservedAtMs:Date.parse(`${day}T12:00:00.000Z`),lastAccountScopeId:null}));
  expect(await current.value.store({projection:{...projection,usage:{...projection.usage,sessions,rowsRead:sessions.length}}})).toBe('stored');
  expect(await current.value.load([day])).toBeUndefined();expect(current.value.refused()).toBe(true);
  expect(await current.value.nextMissingDay([day])).toBeUndefined();
  const used=current.meter.queriesUsed;expect(await current.value.load([day])).toBeUndefined();expect(current.meter.queriesUsed).toBe(used);
 });
 it.each(['payload','heads'] as const)('refuses the whole-window %s bound before dependencies or missing-day reads',async kind=>{
  const seed=await cache();await seed.value.store(prepared());
  const inflated=new Proxy(target(),{get(database,key){
   if(key==='prepare')return(sql:string)=>{
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,member){
     if(member==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
     if(member==='all'&&sql.includes('AS payload_bytes'))return async()=>{
      const result=await inner.all<Record<string,unknown>>();
      return {...result,results:kind==='heads'?Array.from({length:1025},()=>result.results[0]!):
       result.results.map(row=>({...row,part_count:33,payload_bytes:8*1024*1024+1}))};
     };
     const value=Reflect.get(inner,member);return typeof value==='function'?value.bind(inner):value;
    }});return wrap(database.prepare(sql));
   };const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const current=await cache(source(),inflated);
  expect(await current.value.load([day,missing])).toBeUndefined();expect(current.value.refused()).toBe(true);
  expect(await current.value.nextMissingDay([day,missing])).toBeUndefined();expect(current.sourceMeter.queriesUsed).toBe(0);
 });
});

function finished():{pin:V11SourcePin;checkpoint:StorageEffectiveHistoryCheckpoint}{
 const pin:V11SourcePin={source:'v1.1',participantId:owner.participantId,generationId:`effective:${owner.ownerDigest}`,
  fromDay:day,throughDay:missing,inputRevision:owner.inputRevision,mutationEpoch:owner.authorityEpoch,fingerprint:'b'.repeat(64)};
 const identity=createV11QuotaAcquisitionIdentity(pin,Date.parse(`${missing}T23:59:59.999Z`));
 return {pin,checkpoint:{version:1,source:'effective',day:missing,layout:`effective:${namespace}`,identity,
  effectiveDays:{quota:[],usage:[day]},effectiveCursor:{phase:'endpoints',day,after:null,ordinal:0,complete:true},
  phase:'finish',acquisition:{identity,planAnchors:[],quotaRows:[]}}};
}
describe('effective usage checkpoint preparation progress',()=>{
 it('ends a four-page group at a >30-part threshold and retries the same two-page successor',async()=>{
  const scope=await captureStorageGraphScope(source(),{owner,day:missing,metric:'model',sourceId:namespace,sourceNamespace:namespace});
  if(!('source'in scope.pin))throw new Error('synthetic effective pin unavailable');
  const identity=createV11QuotaAcquisitionIdentity(scope.pin,Date.parse(scope.fixedNow));
  const at=Date.parse(`${day}T12:00:00.000Z`);
  const checkpoint=(rows:number):StorageEffectiveHistoryCheckpoint=>{
   const projection=reduceGraphDayProjection(day,[],{rowsRead:rows,events:Array.from({length:rows},(_,index)=>({
    sessionDigest:null,observedAtMs:at,provider:'openai_codex',
    accountScopeId:`account-track:v2:${index.toString(16).padStart(64,'0')}`,
    planBasis:'same_source_occurrence' as const,planType:'pro',planEraId:`plan-era:v1:${'b'.repeat(64)}`,
    kind:'priced' as const,model:'gpt-5.6-sol',costNanousd:10}))});
   return {version:1,source:'effective',day:missing,layout:`effective:${namespace}`,identity,
    effectiveDays:{quota:[],usage:[day]},effectiveCursor:{phase:'endpoints',day,after:null,ordinal:0,complete:true},
    phase:'finish',acquisition:{identity,planAnchors:[],quotaRows:[]},
    usagePreparation:{state:'reading',rowsRead:rows,day:{projection,lastObservedAtMs:at},
     after:{observedAtMs:at,occurrenceId:`synthetic-tail-${rows}`}}};
  };
  const key=await storageGraphEffectiveCheckpointKey({sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest,
   day:missing,dependencyDigest:scope.checkpointDependencyDigest,method:STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD},true,5);
  const initial=checkpoint(9700),first=checkpoint(9900),second=checkpoint(10100);
  expect(await storageHistoryCheckpointParts(key,first)).toBeLessThanOrEqual(30);
  expect(await storageHistoryCheckpointParts(key,second)).toBeGreaterThan(30);
  let seeded=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:initial,expectedHead:null});
  while(seeded.status==='staging')seeded=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:initial,expectedHead:null,cursor:seeded.cursor});
  let now=0,calls=0;
  const advance=vi.spyOn(effectiveHistory,'advanceStorageEffectiveAnalysis').mockImplementation(async input=>{
   calls++;
   const count=input.checkpoint?.usagePreparation;
   if(count?.state!=='reading')throw new Error('synthetic reading buffer unavailable');
   expect(input.allowQuotaCoverage).toBe(count.rowsRead===9700);
   if(count.rowsRead===9700)return {status:'deferred',checkpoint:structuredClone(first)};
   if(count.rowsRead===9900)return {status:'deferred',checkpoint:structuredClone(second)};
   throw new Error('synthetic group crossed its deterministic boundary');
  });
  const cut=new Proxy(target(),{get(database,key){
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await database.batch(statements);now=20_000;return result;};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const run=()=>computeStorageGraphResult({source:source(),target:cut,sourceId:namespace,sourceNamespace:namespace},scope,
   {maxQueries:950,deadlineMs:20_000,now:()=>now,preparedFold:true,preparedEffectiveUsage:true});
  try{
   expect(await run()).toEqual({state:'deferred',reason:'effective_checkpoint'});expect(calls).toBe(2);
   const before=await loadStorageHistoryCheckpoint({target:target(),key,maxParts:32});
   expect(before).toMatchObject({status:'ready',headDigest:seeded.headDigest,checkpoint:initial});
   const keyDigest=await storageHistoryKeyDigest(key);
   const staged=await target().prepare('SELECT generation,part_count FROM analytics_history_checkpoint_stages WHERE key_digest=? AND generation!=?')
    .bind(keyDigest,seeded.headDigest).first<{generation:string;part_count:number}>();
   expect(staged!.part_count).toBeGreaterThan(30);
   expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=?')
    .bind(keyDigest,staged!.generation).first('n')).toBe(30);
   now=0;expect(await run()).toEqual({state:'deferred',reason:'effective_checkpoint'});expect(calls).toBe(4);
   let loaded=await loadStorageHistoryCheckpoint({target:target(),key,maxParts:32});
   while(loaded.status==='deferred')loaded=await loadStorageHistoryCheckpoint({target:target(),key,maxParts:32,cursor:loaded.cursor});
   expect(loaded).toMatchObject({status:'ready',headDigest:staged!.generation,checkpoint:second});
  }finally{advance.mockRestore();}
 },30_000);
 it('persists a whole-job source row refusal before starting another missing day',async()=>{
  const {pin,checkpoint}=finished();
  checkpoint.usagePreparation={state:'pending',rowsRead:MAX_WINDOWED_USAGE_ROWS};
  let sourcePages=0;
  const observed=new Proxy(source(),{get(database,key){
   if(key==='prepare')return(sql:string)=>{if(sql.includes('selected_occurrences'))sourcePages++;return database.prepare(sql);};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const adapter:StorageEffectiveUsagePreparation={load:async()=>undefined,nextMissingDay:async()=>day,
   refused:()=>false,store:async()=>{throw new Error('synthetic unexpected write');}};
  const input={source:observed,sourceNamespace:namespace,owner,pin,day:missing,metric:'model' as const,
   nowMs:Date.parse(`${missing}T23:59:59.999Z`),preparedUsage:adapter,budget:{remainingQueries:950,deadlineMs:100,now:()=>0}};
  const next=await advanceStorageEffectiveAnalysis({...input,checkpoint});
  expect(next).toMatchObject({status:'deferred',usagePreparationStep:true,checkpoint:{usagePreparation:{state:'disabled'}}});
  expect(sourcePages).toBe(0);
  if(next.status!=='deferred'||!next.checkpoint)throw new Error('synthetic refusal missing');
  const again=await advanceStorageEffectiveAnalysis({...input,checkpoint:next.checkpoint,
   preparedUsage:{...adapter,load:async()=>{throw new Error('synthetic repeated refused preparation');}}});
  expect(again).toMatchObject({status:'deferred',checkpoint:{phase:'usage',usage:{complete:true}}});
 });
 it('durably retains ready preparation while store defers and later folds without re-reading the day',async()=>{
  const {pin,checkpoint}=finished();let reads=0,stores=0,stored=false,allowStore=false;
  const observed=new Proxy(source(),{get(database,key){
   if(key==='prepare')return(sql:string)=>{if(sql.includes('selected_occurrences'))reads++;return database.prepare(sql);};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const adapter:StorageEffectiveUsagePreparation={load:async()=>stored?[prepared()]:undefined,
   nextMissingDay:async()=>day,refused:()=>false,store:async()=>{stores++;if(!allowStore)return 'deferred';stored=true;return 'stored';}};
  const input={source:observed,sourceNamespace:namespace,owner,pin,day:missing,metric:'model' as const,
   nowMs:Date.parse(`${missing}T23:59:59.999Z`),preparedUsage:adapter,budget:{remainingQueries:950,deadlineMs:100,now:()=>0}};
  const first=await advanceStorageEffectiveAnalysis({...input,checkpoint});
  expect(first).toMatchObject({status:'deferred',usagePreparationStep:true,checkpoint:{usagePreparation:{state:'ready'}}});
  if(first.status!=='deferred'||!first.checkpoint)throw new Error('synthetic ready preparation missing');
  const key=await storageGraphEffectiveCheckpointKey({sourceId:namespace,sourceNamespace:namespace,ownerDigest:owner.ownerDigest,
   day:missing,dependencyDigest:'c'.repeat(64),method:STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD},true,5);
  const saved=await saveStorageHistoryCheckpoint({target:target(),key,checkpoint:first.checkpoint,expectedHead:null});
  expect(saved.status).toBe('saved');
  const before=reads;
  expect(await advanceStorageEffectiveAnalysis({...input,checkpoint:first.checkpoint})).toEqual({status:'deferred',checkpoint:null});
  const loaded=await loadStorageHistoryCheckpoint({target:target(),key});
  expect(loaded).toMatchObject({status:'ready',checkpoint:first.checkpoint});expect(reads).toBe(before);
  allowStore=true;
  const folded=await advanceStorageEffectiveAnalysis({...input,checkpoint:first.checkpoint});
  expect(folded).toMatchObject({status:'deferred',checkpoint:{phase:'usage',usage:{complete:true,scalarReduced:false}}});
  expect(reads).toBe(before);expect(stores).toBe(2);
 });
});
