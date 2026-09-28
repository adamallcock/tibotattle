import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { advanceStorageCommunityDaily, readPublishedStorageCommunityDaily,
  retireStorageCommunityDailyPage } from '../src/storage-community-daily';
import { readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { CACHE_RETENTION_EFFECTIVE_DEVICE_ID, CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
  createCacheRetentionDaySourceBuild, readCacheRetentionCarryDays, readCacheRetentionDay,
  retireCacheRetentionDayPage, writeCacheRetentionDay, CacheRetentionDeferredError,
  type CacheRetentionDayCandidate } from '../src/cache-retention-day';
import { runCacheRetentionDaySchedule } from '../src/cache-retention-day-worker';
import { runStoragePublicationSchedule } from '../src/storage-publication-worker';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import * as sharedStore from '../src/storage-analytics-shared-features';

type Bindings = Env & { STORAGE_ANALYTICS_DB:D1Database; STORAGE_INGESTION_A:D1Database;
  TEST_MIGRATIONS:D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
  TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[] };
const b=env as Bindings, source=()=>b.USAGE_MONITOR_DB, candidate=()=>b.STORAGE_ANALYTICS_DB,
  reference=()=>b.STORAGE_INGESTION_A;
const sourceId='synthetic-shared-consumers', sourceNamespace=sourceId;
const nowMs=Date.parse('2026-09-28T12:00:00.000Z');

async function publish(target:D1Database, day:string, sharedFeatures:boolean, publicationNowMs=nowMs) {
  for(let attempt=0;attempt<48;attempt++) {
    const meter=createD1InvocationBudget(950), scopedSource=meter.wrap(source()),
      scopedTarget=meter.wrap(target);
    const result=await advanceStorageCommunityDaily({source:scopedSource,target:scopedTarget,
      sourceId,sourceNamespace,day,nowMs:publicationNowMs,maxOwners:4,sharedFeatures,
      ...(sharedFeatures?{sharedFeatureBudget:{remainingQueries:()=>meter.remainingQueries,
        deadlineMs:Date.now()+60_000,now:Date.now}}:{})});
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    if(result.state==='published')return;
    expect(['progress','deferred']).toContain(result.state);
  }
  throw new Error(`synthetic daily projection did not complete: ${day}`);
}

async function payload(target:D1Database,day:string) {
  const publication=await readPublishedStorageCommunityDaily({source:source(),target,
    sourceId,sourceNamespace,fromDay:day,throughDay:day});
  expect(publication.rows).toHaveLength(1);
  return publication.rows[0]!.payload_json;
}

async function effectiveCandidate(target:D1Database,ownerDigest:string,day:string) {
  const fingerprint=await target.prepare(`SELECT fingerprint FROM analytics_community_daily_owners
    WHERE source_id=? AND owner_digest=? AND day=? AND source_format='effective' AND complete=1`)
    .bind(sourceId,ownerDigest,day).first<string>('fingerprint');
  expect(fingerprint).not.toBeNull();
  const parsed=JSON.parse(fingerprint!) as {dependencyDigest:string};
  const key:CacheRetentionDayCandidate={sourceId,sourceLayout:'effective',sourceNamespace,
    ownerDigest,deviceId:CACHE_RETENTION_EFFECTIVE_DEVICE_ID,
    manifestId:CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,manifestDigest:parsed.dependencyDigest,day};
  return {key,carry:await readCacheRetentionCarryDays(target,key)};
}

it('reuses durable effective days for exact daily spend and seven-day cache publication through correction',async()=>{
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),candidate(),b,sourceId,sourceNamespace);
  await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:candidate(),sourceId,
    sourceNamespace,anchorDay:new Date(nowMs).toISOString().slice(0,10),calendarDays:20,graphDays:2});
  const owners=(await readStorageCommunityOwnerPage(source())).filter(owner=>owner.ownerDigest!==null);
  expect(owners).toHaveLength(2);
  for(const target of [reference(),candidate()])for(const owner of owners) {
    await target.prepare(`INSERT OR REPLACE INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')`)
      .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  }
  const destination=corpus.graphDates[0]!, lookback=corpus.historyDates.slice(
    corpus.historyDates.indexOf(destination)-7,corpus.historyDates.indexOf(destination));
  for(const day of [...lookback,destination]) {
    await publish(reference(),day,false);
    await publish(candidate(),day,true);
    expect(await payload(candidate(),day)).toBe(await payload(reference(),day));
  }
  const beforeDaily=await payload(candidate(),corpus.correctionDay);
  const beforeFeature=await candidate().prepare(`SELECT head_revision,dependency_digest FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND state='complete'`)
    .bind(sourceId,corpus.owner.ownerDigest,corpus.correctionDay)
    .first<{head_revision:number;dependency_digest:string}>();
  expect(beforeFeature).not.toBeNull();
  const referenceKey=await effectiveCandidate(reference(),corpus.owner.ownerDigest,destination);
  const candidateKey=await effectiveCandidate(candidate(),corpus.owner.ownerDigest,destination);
  const native=await createCacheRetentionDaySourceBuild({source:source(),target:reference(),sourceNamespace})(
    referenceKey.key,referenceKey.carry,{remainingQueries:10_000,deadlineMs:Date.now()+120_000});
  const sharedFeatureReads=vi.spyOn(sharedStore,'advanceSharedAnalyticsFeatureDay');
  let shared:typeof native|undefined;
  let warmQueries=0;
  for(let attempt=0;attempt<40&&!shared;attempt++) {
    const meter=createD1InvocationBudget(950);
    const build=createCacheRetentionDaySourceBuild({source:meter.wrap(source()),target:meter.wrap(candidate()),
      sourceNamespace,sharedFeatures:true});
    try { shared=await build(candidateKey.key,candidateKey.carry,{remainingQueries:350,
      remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+120_000}); }
    catch(error) { if(!(error instanceof CacheRetentionDeferredError))throw error; }
    warmQueries+=meter.queriesUsed;
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  }
  expect(shared).toEqual(native);
  expect(sharedFeatureReads).toHaveBeenCalledTimes(8);
  expect((await Promise.all(sharedFeatureReads.mock.results.map(result=>result.value)))
    .every(result=>result.state==='complete'&&result.reused)).toBe(true);
  sharedFeatureReads.mockRestore();
  expect(warmQueries).toBeGreaterThan(0);
  const refusedFeature=vi.spyOn(sharedStore,'advanceSharedAnalyticsFeatureDay')
    .mockResolvedValue({state:'refused',reason:'day_feature_limit'});
  const nativeFallback=await createCacheRetentionDaySourceBuild({source:source(),target:candidate(),
    sourceNamespace,sharedFeatures:true})(candidateKey.key,candidateKey.carry,
    {remainingQueries:10_000,remainingSharedQueries:()=>10_000,deadlineMs:Date.now()+120_000});
  expect(nativeFallback).toEqual(native);
  expect(refusedFeature).toHaveBeenCalledTimes(1);
  refusedFeature.mockRestore();
  await writeCacheRetentionDay({target:candidate(),key:candidateKey.key,carry:candidateKey.carry,
    aggregate:shared!});
  expect(await readCacheRetentionDay({target:candidate(),key:candidateKey.key,carry:candidateKey.carry}))
    .toMatchObject({status:'ready',aggregate:native});

  const corrected=await corpus.mutateCorrection();
  await reference().prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
    WHERE source_id=? AND owner_digest=?`).bind(corrected.ownerRevision,corrected.authorityEpoch,
      sourceId,corrected.ownerDigest).run();
  await publish(reference(),corpus.correctionDay,false);
  await publish(candidate(),corpus.correctionDay,true);
  const afterDaily=await payload(candidate(),corpus.correctionDay);
  expect(afterDaily).toBe(await payload(reference(),corpus.correctionDay));
  expect(JSON.parse(afterDaily).apiEquivalentSpend.knownCostUsd)
    .not.toBe(JSON.parse(beforeDaily).apiEquivalentSpend.knownCostUsd);
  const afterFeatures=(await candidate().prepare(`SELECT dependency_digest FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=? AND state='complete'`)
    .bind(sourceId,corpus.owner.ownerDigest,corpus.correctionDay)
    .all<{dependency_digest:string}>()).results;
  expect(afterFeatures.some(row=>row.dependency_digest!==beforeFeature?.dependency_digest)).toBe(true);
  const correctedCarry=await readCacheRetentionCarryDays(candidate(),candidateKey.key);
  expect(correctedCarry).not.toEqual(candidateKey.carry);

  // The target-side terminal receipt removes private feature generations and
  // both consumer lanes' per-owner rows through their normal retirement work.
  await candidate().prepare(`UPDATE analytics_owner_state SET state='erased'
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest).run();
  expect(await candidate().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest)
    .first<number>('n')).toBe(0);
  for(let pass=0;pass<16;pass++) {
    await retireStorageCommunityDailyPage({source:source(),target:candidate(),sourceId,sourceNamespace});
    if((await retireCacheRetentionDayPage(candidate(),sourceId)).state==='idle')break;
  }
  expect(await candidate().prepare(`SELECT count(*) n FROM analytics_community_daily_owners
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest)
    .first<number>('n')).toBe(0);
  expect(await candidate().prepare(`SELECT count(*) n FROM analytics_cache_retention_day_marks
    WHERE source_id=? AND owner_digest=?`).bind(sourceId,corpus.owner.ownerDigest)
    .first<number>('n')).toBe(0);
},30_000);

it('finishes a dense shared cache day through the scheduled 1000-statement cap across invocations',async()=>{
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),candidate(),b,sourceId,sourceNamespace);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:candidate(),sourceId,
    sourceNamespace,anchorDay:new Date(nowMs).toISOString().slice(0,10),calendarDays:20,
    graphDays:2,denseUsageRows:401});
  const owners=(await readStorageCommunityOwnerPage(source())).filter(owner=>owner.ownerDigest!==null);
  for(const owner of owners) await candidate().prepare(`INSERT OR REPLACE INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')`)
    .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  const destination=corpus.graphDates[0]!, offset=corpus.historyDates.indexOf(destination);
  for(const day of [...corpus.historyDates.slice(offset-7,offset),destination])
    await publish(candidate(),day,false);
  expect(await candidate().prepare(`SELECT count(*) n FROM analytics_shared_feature_days`)
    .first<number>('n')).toBe(0);
  const env={CACHE_RETENTION_BUILD:'enabled' as const,CACHE_RETENTION_SHARED_FEATURES:'enabled' as const,
    STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,
    STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:candidate(),
    CACHE_RETENTION_FROM_DAY:destination};
  const marks=()=>candidate().prepare(`SELECT count(*) n FROM analytics_cache_retention_day_marks
    WHERE source_id=? AND owner_digest=? AND day=? AND refusal IS NULL`)
    .bind(sourceId,corpus.owner.ownerDigest,destination).first<number>('n');
  const completedFeatures=()=>candidate().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND state='complete'`)
    .bind(sourceId,corpus.owner.ownerDigest).first<number>('n');
  const progress:number[]=[];
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  for(let pass=0;pass<24;pass++) {
    await runCacheRetentionDaySchedule(env);
    progress.push((await completedFeatures())??0);
    if(await marks())break;
  }
  const schedules=log.mock.calls.map(([value])=>JSON.parse(String(value)) as {
    event:string;queriesUsed:number;sourceQueriesUsed:number;state:string}).filter(row=>
      row.event==='cache_retention_day_schedule');
  log.mockRestore();
  expect(schedules).toHaveLength(progress.length);
  expect(schedules.every(row=>row.queriesUsed<=950&&row.sourceQueriesUsed<=350)).toBe(true);
  expect(schedules.some(row=>row.state==='deferred')).toBe(true);
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.at(-1)).toBeGreaterThanOrEqual(8);
  expect(await marks()).toBe(1);
  const {key,carry}=await effectiveCandidate(candidate(),corpus.owner.ownerDigest,destination);
  const result=await readCacheRetentionDay({target:candidate(),key,carry});
  expect(result.status).toBe('ready');
  if(result.status==='ready') {
    expect(result.aggregate.eventsRead).toBeGreaterThan(401);
    expect(result.aggregate.groups.some(group=>group.adjacencies>0)).toBe(true);
    console.info(JSON.stringify({event:'synthetic_shared_cache_schedule',invocations:progress.length,
      maxStatements:Math.max(...schedules.map(row=>row.queriesUsed)),
      totalStatements:schedules.reduce((sum,row)=>sum+row.queriesUsed,0),
      maxBuildAllowance:Math.max(...schedules.map(row=>row.sourceQueriesUsed)),
      completedFeatureDays:progress.at(-1),eventsRead:result.aggregate.eventsRead,
      adjacencies:result.aggregate.groups.reduce((sum,group)=>sum+group.adjacencies,0)}));
  }
},30_000);

it('publishes a dense effective day from cold shared features through the scheduled 900-statement cap',async()=>{
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),candidate(),b,sourceId,sourceNamespace);
  await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
  await applyD1Migrations(reference(),b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({source:source(),target:reference(),sourceId,sourceNamespace});
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:candidate(),sourceId,
    sourceNamespace,anchorDay:new Date(nowMs).toISOString().slice(0,10),calendarDays:20,
    graphDays:2,denseUsageRows:401});
  const owners=(await readStorageCommunityOwnerPage(source())).filter(owner=>owner.ownerDigest!==null);
  for(const target of [candidate(),reference()])for(const owner of owners)
    await target.prepare(`INSERT OR REPLACE INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')`)
      .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  const day=corpus.graphDates[0]!;
  const publishedAt=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(publishedAt);
  const logs=vi.spyOn(console,'log').mockImplementation(()=>{});
  try {
    await publish(reference(),day,false,publishedAt);
    await candidate().prepare(`DELETE FROM analytics_community_daily_queue WHERE source_id=? AND day<>?`)
      .bind(sourceId,day).run();
    await candidate().prepare(`INSERT INTO analytics_community_daily_queue(source_id,day,revision)
      VALUES(?,?,1) ON CONFLICT(source_id,day) DO NOTHING`).bind(sourceId,day).run();
    expect(await candidate().prepare('SELECT count(*) n FROM analytics_shared_feature_days').first<number>('n')).toBe(0);
    const scheduleEnv={PUBLICATION_LANE:'enabled' as const,STORAGE_ANALYTICS_MODE:'enabled' as const,
      PUBLIC_ANALYTICS_MODE:'enabled' as const,STORAGE_ANALYTICS_SHARED_FEATURES:'enabled' as const,
      STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,
      STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:candidate(),DELETION_LEDGER:b.DELETION_LEDGER};
    const progress:number[]=[];
    for(let pass=0;pass<24;pass++) {
      await runStoragePublicationSchedule(scheduleEnv);
      progress.push((await candidate().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
        WHERE source_id=? AND owner_digest=? AND state='complete'`)
        .bind(sourceId,corpus.owner.ownerDigest).first<number>('n'))??0);
      const published=await candidate().prepare(`SELECT 1 FROM analytics_community_daily_publications
        WHERE source_id=? AND day=?`).bind(sourceId,day).first<number>();
      if(published!==null)break;
    }
    const schedules=logs.mock.calls.map(([value])=>JSON.parse(String(value)) as {
      event:string;queriesUsed:number;state:string;dailyPublications:number}).filter(row=>
        row.event==='storage_publication_schedule');
    expect(schedules).toHaveLength(progress.length);
    expect(schedules.every(row=>row.queriesUsed<=900)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeGreaterThan(0);
    expect(schedules.some(row=>row.dailyPublications>0)).toBe(true);
    expect(await payload(candidate(),day)).toBe(await payload(reference(),day));
    console.info(JSON.stringify({event:'synthetic_shared_daily_schedule',invocations:progress.length,
      maxStatements:Math.max(...schedules.map(row=>row.queriesUsed)),
      totalStatements:schedules.reduce((sum,row)=>sum+row.queriesUsed,0),
      completedFeatureDays:progress.at(-1),dailyPublications:schedules.reduce((sum,row)=>sum+row.dailyPublications,0)}));
  } finally {logs.mockRestore();clock.mockRestore();}
},60_000);
