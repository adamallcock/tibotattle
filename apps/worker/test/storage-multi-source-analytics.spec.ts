import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {runMultiSourceAnalyticsPass,type StorageAnalyticsSource} from '../src/storage-multi-source-analytics';
import {runStorageAnalyticsSchedule} from '../src/storage-analytics-worker';
import {advanceMultiSourcePublicationGenerations,publishMultiSourceAllowancePreview,
 publishMultiSourceCommunityDaily,readMultiSourcePublication,
 type MultiSourcePublicationMember} from '../src/storage-multi-source-publication';
import {captureStorageCommunityAuthority} from '../src/storage-community-authority';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {createV11DailyProjectionValues,type V11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {STORAGE_COMMUNITY_DAILY_METHOD} from '../src/storage-community-daily';
import {STORAGE_GRAPH_METHOD} from '../src/storage-community-graph';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {recordDeletionTombstone,purgeExpiredDeletionTombstones} from '../src/retention';
import {participantDeletionDigest} from '../src/participant-deletion-digest';

interface Bindings extends Env {
 STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;
 STORAGE_ANALYTICS_A:D1Database;STORAGE_ANALYTICS_B:D1Database;STORAGE_ANALYTICS_DB:D1Database;
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
 TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[];
}
const b=env as Bindings,namespace='synthetic-shared-provenance';
const day=()=>new Date().toISOString().slice(0,10);
const definitions=():[StorageAnalyticsSource,StorageAnalyticsSource]=>[
 {source:b.STORAGE_INGESTION_A,target:b.STORAGE_ANALYTICS_A,sourceId:'source-a',sourceNamespace:namespace,targetId:'analytics-a'},
 {source:b.STORAGE_INGESTION_B,target:b.STORAGE_ANALYTICS_B,sourceId:'source-b',sourceNamespace:namespace,targetId:'analytics-b'},
];

beforeEach(async()=>{
 await reset();
 for(const source of [b.STORAGE_INGESTION_A,b.STORAGE_INGESTION_B]){
  for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
   b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source,migrations);
 }
 for(const target of [b.STORAGE_ANALYTICS_A,b.STORAGE_ANALYTICS_B,b.STORAGE_ANALYTICS_DB])
  await applyD1Migrations(target,b.TEST_ANALYTICS_MIGRATIONS);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 for(const source of definitions()){
  await initializeStorageSource(source.source,source.sourceId);
  await initializeTypedV11Admission(source.source,namespace);await initializeTypedV1Admission(source.source,namespace);
  await applyD1Migrations(source.source,b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await drainCommunityPublicSourceBootstrap(source.source);
  await initializeStorageAnalyticsRuntime(source);
  await source.target.prepare('INSERT INTO analytics_source_cursors(source_id,sequence,authority_epoch) VALUES(?,0,0)')
   .bind(source.sourceId).run();
 }
});

function values(usage:number):V11DailyProjectionValues{
 const value=createV11DailyProjectionValues(day());if(usage===0)return value;
 const token=(sum:string)=>({knownSum:sum,unavailable:0});
 const tokens={inputUncachedTokens:token(String(usage)),inputCacheReadTokens:token('0'),inputCacheWriteTokens:token('0'),
  outputTextTokens:token('0'),outputReasoningTokens:token('0'),outputCombinedTokens:token('0'),effectiveOutput:token('0'),
  nonOverlappingTotal:token(String(usage))};
 const pricing={knownNanousd:String(usage),fullyPriced:usage,partiallyPriced:0,unpriced:0};
 value.counts.usage=usage;value.tokens=tokens;value.pricing=pricing;
 value.cells=[{provider:'synthetic',modelId:'synthetic',usageEvents:usage,tokens,pricing}];return value;
}
async function member(source:StorageAnalyticsSource,ownerDigest:string,inputRevision:number,usage:number,routeGeneration:number){
 await source.target.batch([
  source.target.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES(?,?,1,1,'active')`).bind(source.sourceId,ownerDigest),
  source.target.prepare(`INSERT INTO analytics_community_daily_owners
   (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,next_index,fingerprint,complete,values_json)
   VALUES(?,?,?,?,1,'v11',?,1,0,NULL,1,?)`).bind(source.sourceId,day(),ownerDigest,inputRevision,
    STORAGE_COMMUNITY_DAILY_METHOD,canonicalJson(values(usage))),
 ]);
 return {sourceId:source.sourceId,ownerDigest,inputRevision,ownerRevision:1,routeGeneration} satisfies MultiSourcePublicationMember;
}
function set(members:MultiSourcePublicationMember[],routingGeneration=1,erasureGeneration=0){return {
 sources:definitions(),publicationTarget:b.STORAGE_ANALYTICS_DB,members,routingGeneration,erasureGeneration,
};}

describe('multi-source analytics and complete publication',()=>{
 it('refuses generation state before migration and accepts it after the forward migration',async()=>{
  await reset();
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0016'));
  await expect(advanceMultiSourcePublicationGenerations(b.STORAGE_ANALYTICS_DB,
   {routingGeneration:1,erasureGeneration:0})).rejects.toThrow();
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
  await expect(advanceMultiSourcePublicationGenerations(b.STORAGE_ANALYTICS_DB,
   {routingGeneration:1,erasureGeneration:0})).resolves.toBeUndefined();
 });

 it('refuses an aggregate query declaration beyond one Worker invocation before running a source',async()=>{
  await expect(runMultiSourceAnalyticsPass({sources:definitions(),maxQueriesPerSource:500,publishCommunity:false}))
   .rejects.toThrow('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
 });

 it('isolates a failed source while another independent cursor remains runnable',async()=>{
  const [a,bSource]=definitions();
  const unavailable=new Proxy(a.source,{get(db,key){if(key==='prepare')return()=>{throw new Error('synthetic source offline');};
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  const results=await runMultiSourceAnalyticsPass({sources:[{...a,source:unavailable},bSource],
    ledger:b.DELETION_LEDGER,publishCommunity:false,maxQueriesPerSource:120,maxStepsPerSource:1});
  expect(results.map(result=>[result.sourceId,result.state])).toEqual([['source-a','unavailable'],['source-b','idle']]);
  expect(await b.STORAGE_ANALYTICS_B.prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id='source-b'").first('sequence')).toBe(0);
 });

 it('isolates source discovery failure at the opt-in scheduled entrypoint',async()=>{
  const unavailable=new Proxy(b.STORAGE_INGESTION_A,{get(db,key){if(key==='prepare')return()=>{throw new Error('synthetic discovery offline');};
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'multi-source',
   STORAGE_INGESTION_A:unavailable,STORAGE_INGESTION_B:b.STORAGE_INGESTION_B,
   STORAGE_ANALYTICS_A:b.STORAGE_ANALYTICS_A,STORAGE_ANALYTICS_B:b.STORAGE_ANALYTICS_B,
   STORAGE_SOURCE_NAMESPACE_A:namespace,STORAGE_SOURCE_NAMESPACE_B:namespace,DELETION_LEDGER:b.DELETION_LEDGER}))
   .resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"unavailable":1'));log.mockRestore();
 });

 it('folds owner/day evidence once at the active route and never sums a retained moved-owner copy',async()=>{
  const [a,bSource]=definitions(),one='1'.repeat(64),two='2'.repeat(64),moved='3'.repeat(64);
  const members=[await member(a,one,1,1,1),await member(bSource,two,1,3,1)];
  await member(a,moved,1,100,1);members.push(await member(bSource,moved,2,7,2));
  expect(await publishMultiSourceCommunityDaily(set(members,2),{day:day()})).toMatchObject({state:'published'});
  const published=await readMultiSourcePublication(b.STORAGE_ANALYTICS_DB,'daily',day());
  expect(JSON.parse(published!.payloadJson).totals).toMatchObject({contributingParticipants:3,usageEvents:11,inputUncachedTokens:11});
 });

 it('reuses an unchanged daily receipt across refreshed timestamps but revises changed evidence and generations',async()=>{
  const source=definitions()[0],owner='d'.repeat(64),members=[await member(source,owner,1,2,1)];
  const now=Date.parse(`${day()}T12:00:00.000Z`);
  expect(await publishMultiSourceCommunityDaily(set(members),{day:day(),nowMs:now}))
   .toEqual({state:'published',revision:1});
  expect(await publishMultiSourceCommunityDaily(set(members),{day:day(),nowMs:now+60_000}))
   .toEqual({state:'unchanged',revision:1});
  expect(await b.STORAGE_ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_multi_source_publications WHERE kind='daily'")
   .first<number>('count')).toBe(1);
  const first=await readMultiSourcePublication(b.STORAGE_ANALYTICS_DB,'daily',day());
  expect(JSON.parse(first!.payloadJson)).toMatchObject({revision:1,releasedAt:new Date(now).toISOString()});

  await source.target.prepare(`UPDATE analytics_community_daily_owners SET input_revision=2
    WHERE source_id=? AND day=? AND owner_digest=?`).bind(source.sourceId,day(),owner).run();
  const changed=[{...members[0]!,inputRevision:2}];
  expect(await publishMultiSourceCommunityDaily(set(changed),{day:day(),nowMs:now+120_000}))
   .toEqual({state:'published',revision:2});
  expect(await publishMultiSourceCommunityDaily(set(changed,2),{day:day(),nowMs:now+180_000}))
   .toEqual({state:'published',revision:3});
  expect(await publishMultiSourceCommunityDaily(set(changed,2,1),{day:day(),nowMs:now+240_000}))
   .toEqual({state:'published',revision:4});
 });

 it('retains the last complete route generation during lag but invalidates it for erasure',async()=>{
  const source=definitions()[0],owner='4'.repeat(64),members=[await member(source,owner,1,2,1)];
  expect(await publishMultiSourceCommunityDaily(set(members),{day:day()})).toMatchObject({state:'published'});
  const replacement=[{...members[0]!,inputRevision:2,routeGeneration:2}];
  expect(await publishMultiSourceCommunityDaily(set(replacement,2),{day:day()})).toEqual({state:'deferred',reason:'source_lag'});
  expect(await readMultiSourcePublication(b.STORAGE_ANALYTICS_DB,'daily',day())).toMatchObject({routingGeneration:1,erasureGeneration:0});
  await advanceMultiSourcePublicationGenerations(b.STORAGE_ANALYTICS_DB,{routingGeneration:2,erasureGeneration:1});
  expect(await readMultiSourcePublication(b.STORAGE_ANALYTICS_DB,'daily',day())).toBeNull();
 });

 it('combines raw owner fits so unequal shard cohorts cannot become an average of medians',async()=>{
  const now=Date.now(),observed=new Date(now-3_600_000).toISOString(),members:MultiSourcePublicationMember[]=[];
  const capacities=[10,20,30,100];
  for(let index=0;index<capacities.length;index++){
   const source=index<3?definitions()[0]:definitions()[1],owner=(index+5).toString(16).repeat(64);
   members.push(await member(source,owner,1,0,1));
   const authority=await captureStorageCommunityAuthority(source.source,source);
   const payload=canonicalJson([{participantId:owner,planType:'pro',capacityNanousd:capacities[index]!*1_000_000_000,lastObservedAt:observed}]);
   await source.target.prepare(`INSERT INTO analytics_community_graph_results
    (source_id,owner_digest,metric,day,method,dependency_digest,input_revision,payload_fingerprint,payload_json,
     payload_sha256,authority_json,computed_ms,source_kind) VALUES(?,?,'fits',?,?,?,?,?,?,?,?,?,'v1.1')`)
    .bind(source.sourceId,owner,day(),STORAGE_GRAPH_METHOD,'a'.repeat(64),1,'b'.repeat(64),payload,
      await sha256Hex(payload),canonicalJson(authority),now).run();
  }
  expect(await publishMultiSourceAllowancePreview(set(members),{nowMs:now})).toMatchObject({state:'published'});
  expect(await publishMultiSourceAllowancePreview(set(members),{nowMs:now+60_000}))
   .toEqual({state:'unchanged',revision:1});
  expect(await b.STORAGE_ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_multi_source_publications WHERE kind='allowance'")
   .first<number>('count')).toBe(1);
  const published=await readMultiSourcePublication(b.STORAGE_ANALYTICS_DB,'allowance','current');
  const preview=JSON.parse(published!.payloadJson) as {days:Array<{day:string;combined:{centralUsd:number}}>};
  expect(preview).toMatchObject({generatedAt:new Date(now).toISOString()});
  expect(preview.days.find(row=>row.day===day())!.combined.centralUsd).toBe(25);
  expect(preview.days.find(row=>row.day===day())!.combined.centralUsd).not.toBe(60);
 });

 it('keeps a two-source erasure incomplete until every declared analytics target has a durable receipt',async()=>{
  const participantId='participant:multi-target-erasure',participantDigest=await participantDeletionDigest(participantId);
  await recordDeletionTombstone(b.DELETION_LEDGER,participantId);
  await b.DELETION_LEDGER.batch([
   b.DELETION_LEDGER.prepare(`INSERT INTO storage_erasure_jobs
    (participant_digest,source_id,owner_digest,source_namespace,state) VALUES(?,?,?,?,'pending')`)
    .bind(participantDigest,'source-a','a'.repeat(64),namespace),
   b.DELETION_LEDGER.prepare(`INSERT INTO storage_erasure_jobs
    (participant_digest,source_id,owner_digest,source_namespace,state) VALUES(?,?,?,?,'pending')`)
    .bind(participantDigest,'source-b','b'.repeat(64),namespace),
   b.DELETION_LEDGER.prepare(`INSERT INTO storage_erasure_targets
    (participant_digest,source_id,owner_digest,target_id,source_namespace,state) VALUES(?,?,?,?,?,'pending')`)
    .bind(participantDigest,'source-a','a'.repeat(64),'analytics-a',namespace),
   b.DELETION_LEDGER.prepare(`INSERT INTO storage_erasure_targets
    (participant_digest,source_id,owner_digest,target_id,source_namespace,state) VALUES(?,?,?,?,?,'pending')`)
    .bind(participantDigest,'source-b','b'.repeat(64),'analytics-b',namespace),
  ]);
  await b.DELETION_LEDGER.batch([
   b.DELETION_LEDGER.prepare(`UPDATE storage_erasure_jobs SET state='complete',terminal_json='{}',completed_at=?
    WHERE participant_digest=? AND source_id='source-a'`).bind(new Date().toISOString(),participantDigest),
   b.DELETION_LEDGER.prepare(`UPDATE storage_erasure_targets SET state='complete',completed_at=?
    WHERE participant_digest=? AND source_id='source-a'`).bind(new Date().toISOString(),participantDigest),
  ]);
  expect(await b.DELETION_LEDGER.prepare("SELECT COUNT(*) n FROM storage_erasure_targets WHERE state='pending'").first('n')).toBe(1);
  expect((await purgeExpiredDeletionTombstones(b.DELETION_LEDGER,Date.now()+401*86400000)).purged).toBe(0);
 });
});
