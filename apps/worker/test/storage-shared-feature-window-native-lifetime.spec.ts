import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { MODEL_COMPOSITION_POLICY } from '@app-usagemonitor/quota-analysis';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation, type TelemetryV11UsageEvent } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageSource } from '../src/analytics-delivery';
import { validSharedAnalyticsFeatureDay, SHARED_ANALYTICS_FEATURE_MAX_BYTES } from '../src/analytics-shared-features';
import { canonicalJson } from '../src/canonical-json';
import { COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP } from '../src/community-allowance';
import { drainCommunityPublicSourceBootstrap } from '../src/community-daily-aggregates';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from '../src/device-auth';
import { validEffectiveQuotaDay, type EffectiveQuotaDay } from '../src/effective-quota-day';
import { effectiveUsageWindowRepresentable, validEffectiveUsageDay, type EffectiveUsageDay } from '../src/effective-usage-day';
import { modelHistoryWindow } from '../src/model-history-window';
import { priceChunkUsageRecord } from '../src/quota-analysis-v1';
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import * as sharedFeatures from '../src/storage-analytics-shared-features';
import { readStorageCommunityOwnerPage, type StorageCommunityOwner } from '../src/storage-community-authority';
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult, storageGraphScalarSharedResumeEligible,
  storageGraphEffectiveCheckpointKey, storageGraphEffectiveCheckpointMethod, STORAGE_GRAPH_METHOD, type StorageGraphScope } from '../src/storage-community-graph';
import * as checkpointStore from '../src/storage-history-checkpoint';
import type { StorageHistoryKey } from '../src/storage-history-checkpoint';
import type { V11SourcePin } from '../src/telemetry-v11-domain';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import { MODEL_HISTORY_TEST_CAPACITIES, pricedModelHistoryUsage } from './helpers/model-history';
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import type { SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

// Tiny genuine native checkpoint/source/lifetime controls. This draft is OFF-TREE
// and has no native qualification. The accepted writer/lifecycle below is copied
// from the retained101-day fixture; no target owner/frame/job/ACK is manufactured.
const b = env as Env & SharedAnalyticsCorpusMigrations & { STORAGE_ANALYTICS_DB: D1Database;
  STORAGE_INGESTION_A: D1Database; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] };
const sourceId = 'synthetic-shared-window-native-controls', dayMs = 86_400_000, hourMs = 3_600_000;
const limits = { populatedDays: 2, calendarDays: 4, featureAttempts: 16, deliveryPasses: 32, graphPasses: 24,
  sparseUsageRows: 24, scalarResumeRows: 401, recordsPerDay: 600, recordsPerChunk: 200, queryCap: 950 } as const;
const source = () => b.USAGE_MONITOR_DB, candidate = () => b.STORAGE_ANALYTICS_DB,
  reference = () => b.STORAGE_INGESTION_A;
type Owner = StorageCommunityOwner & { ownerDigest: string };
type Device = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Cost = { phase: string; ordinal: number; chunkOrdinal?: number; statements: number; rowsRead: number;
  rowsWritten: number; elapsedMs: number; failedStatements: number;
  shapes:Record<string,{statements:number;rowsRead:number;rowsWritten:number;unknownRows:number;failures:number}> };
const date = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).byteLength;
const attribution = () => ({ accountBasis: 'same_source' as const,
  accountTrackId: `account-track:v2:${'f'.repeat(64)}`, planBasis: 'same_source_occurrence' as const,
  planType: 'pro' as const, planEraId: null });
// Two populated days originally span18.58pp, below the unchanged public25pp
// floor. Increase genuine priced usage; quota still derives each admitted price.
const nativeFitCostScale=2;
const session = ['0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b', 'e46332ab-4fd4-4f52-90d2-1445b0af46f2'];

let acquisitionConsumer:'full'|'scalar'|undefined,scalarInitialPartLoads=0;
async function invocation<T>(costs: Cost[], phase: string, ordinal: number, target: D1Database,
  run: (db: { source: D1Database; target: D1Database; ledger: D1Database },
    meter: ReturnType<typeof createD1InvocationBudget>) => Promise<T>, chunkOrdinal?: number): Promise<T> {
  const profile = createAnalyticsProfile(), meter = createD1InvocationBudget(950), start = performance.now();
  const shapes:Cost['shapes']={};
  const observe:import('./helpers/analytics-profile').AnalyticsStatementObserver=sample=>{
    // SQL is ephemeral classifier input only; never serialize it or bindings.
    if(acquisitionConsumer==='scalar'&&sample.sql.includes('FROM analytics_shared_feature_parts p'))scalarInitialPartLoads++;
    const shape=sample.sql.includes('/* batched occurrence links */')?'batched_dependency_links'
      :sample.sql.includes('outside_headers AS')?'singleton_dependency_links'
      :sample.sql.includes('FROM analytics_shared_feature_parts p')?'feature_parts'
      :sample.sql.includes('INSERT INTO analytics_history_checkpoint_')?'checkpoint_write'
      :sample.sql.includes('analytics_history_checkpoint_')?'checkpoint_read'
      :sample.sql.includes('INSERT INTO analytics_community_graph_results')?'graph_write'
      :sample.sql.includes('SELECT DISTINCT observed_day FROM direct')?'native_inventory':'other';
    const key=sample.side+'.'+shape,row=shapes[key]??={statements:0,rowsRead:0,rowsWritten:0,unknownRows:0,failures:0};
    row.statements++;row.failures+=sample.outcome==='failed'?1:0;
    if(sample.rowsRead===null||sample.rowsWritten===null)row.unknownRows++;
    else{row.rowsRead+=sample.rowsRead;row.rowsWritten+=sample.rowsWritten;}
  };
  const db = { source: meter.wrap(profileAnalyticsDatabase(source(), 'source', profile, () => phase,observe)),
    target: meter.wrap(profileAnalyticsDatabase(target, 'target', profile, () => phase,observe)),
    ledger: meter.wrap(profileAnalyticsDatabase(b.DELETION_LEDGER, 'ledger', profile, () => phase,observe)) };
  try { return await run(db, meter); }
  finally {
    const observed = summarizeAnalyticsProfile(profile);
    costs.push({ phase, ordinal, ...(chunkOrdinal === undefined ? {} : { chunkOrdinal }),
      statements: meter.queriesUsed, rowsRead: observed.rowsRead,
      rowsWritten: observed.rowsWritten, failedStatements: observed.failedStatements,
      elapsedMs: performance.now() - start,shapes });
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    expect(observed.statements).toBe(meter.queriesUsed);
  }
}
function aggregate(costs: readonly Cost[]) {
  return { invocations: costs.length, statements: costs.reduce((n, c) => n + c.statements, 0),
    maximumStatementsPerInvocation: Math.max(0, ...costs.map(c => c.statements)),
    rowsRead: costs.reduce((n, c) => n + c.rowsRead, 0), rowsWritten: costs.reduce((n, c) => n + c.rowsWritten, 0),
    failedStatements: costs.reduce((n, c) => n + c.failedStatements, 0),
    elapsedMs: costs.reduce((n, c) => n + c.elapsedMs, 0), cpuMs: null, peakMemoryBytes: null };
}

async function initialize(costs: Cost[]) {
  await reset();
  const start = performance.now();
  for (const group of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS,
    b.TEST_INGESTION_BRIDGE_MIGRATIONS, b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    b.TEST_TYPED_V11_ADMISSION_MIGRATIONS]) await applyD1Migrations(source(), group);
  // Schema application is laboratory preparation, outside product invocation
  // counters. Native runtime initialization and every later operation are metered.
  await invocation(costs, 'source_runtime_setup', 0, candidate(), async db => {
    await initializeStorageSource(db.source, sourceId);
    await initializeTypedV1Admission(db.source, sourceId);
    await initializeTypedV11Admission(db.source, sourceId);
  });
  await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  for (const target of [candidate(), reference()]) await applyD1Migrations(target, b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  const schemaElapsedMs = performance.now() - start - costs[0]!.elapsedMs;
  await invocation(costs, 'source_bootstrap', 0, candidate(), async db => {
    expect((await drainCommunityPublicSourceBootstrap(db.source)).completed).toBe(true);
    await db.source.prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  });
  for (const [ordinal, target] of [candidate(), reference()].entries())
    await invocation(costs, 'target_runtime_setup', ordinal, target, db => initializeStorageAnalyticsRuntime({
      ...db, sourceId, sourceNamespace: sourceId }));
  return { schemaElapsedMs, schemaStatements: null,
    contract: 'Actual local migration application is laboratory setup; all native admission, delivery, preparation and graph operations use real950 meters.' };
}

function acceptedRecords(day: string, dayOrdinal: number, rows: number, firstMs: number, priorPercent: number) {
  const start = Date.parse(`${day}T00:00:00.000Z`), period = Math.floor(dayOrdinal / 7);
  const resetsAt = new Date(firstMs + (period + 1) * 7 * dayMs).toISOString();
  let usedPercent = dayOrdinal % 7 === 0 ? 0 : priorPercent;
  const quota: TelemetryV11QuotaObservation[] = [], usage: TelemetryV11UsageEvent[] = [];
  const quotaAt = (at: number) => quota.push({ schemaVersion: 'quota-observation-v1.1',
    observationId: `quota-occurrence:v1:${(dayOrdinal * 13 + quota.length + 1).toString(16).padStart(64, '0')}`,
    observedTime: new Date(at).toISOString(), provider: 'openai_codex', planType: 'pro', planVariant: 'unknown',
    limitId: 'codex', slot: 'seven_day', usedPercent, windowDurationMinutes: 10_080, resetsAt,
    accountPlanAttribution: attribution() });
  quotaAt(start);
  for (let bin = 0; bin < 12; bin++) {
    const globalBin = dayOrdinal * 12 + bin;
    for (const [modelOrdinal, [model, capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()) {
      const slot = bin * 2 + modelOrdinal;
      const count = Math.floor(rows / 24) + (slot < rows % 24 ? 1 : 0);
      const desiredCost = (5 + ((globalBin * 7 + modelOrdinal * 11) % 17) / 4)
        * ((globalBin + modelOrdinal) % 3 === 0 ? 0.2 : 1) * nativeFitCostScale;
      for (let index = 0; index < count; index++) {
        const eventTime = new Date(start + (bin * 2 + 0.5) * hourMs + modelOrdinal * 60_000 + index * 1000).toISOString();
        const priced = pricedModelHistoryUsage(model, desiredCost / count, eventTime);
        const projection = JSON.parse(priced.record.recordJson!) as Pick<TelemetryV11UsageEvent, 'components'>;
        const record = v11UsageRecord(day, 'a', { eventId: `event:v2:${(dayOrdinal * 1000 + usage.length + 1).toString(16).padStart(64, '0')}`,
          eventTime, modelId: model, sessionUuid: session[modelOrdinal]!, totalInputContextTokens: 1000,
          components: { ...projection.components, inputUncachedTokens: 100, inputCacheReadTokens: 900,
            inputCacheWriteTokens: 0 }, accountPlanAttribution: attribution() });
        // Added cache/input fields are part of the FINAL admitted price; quota
        // deltas never use the helper's earlier output-only amount.
        const finalPrice = priceChunkUsageRecord(canonicalJson(record), eventTime);
        expect(finalPrice?.pricingStatus).toBe('fully_priced');
        expect(finalPrice!.costNanousd).toBeGreaterThan(0);
        usedPercent += finalPrice!.costNanousd / 1e9 * 100 / capacity;
        usage.push(record);
      }
    }
    quotaAt(start + (bin * 2 + 1) * hourMs);
  }
  expect(usage).toHaveLength(rows); expect(quota).toHaveLength(13);
  expect(usage.length + quota.length).toBeLessThanOrEqual(limits.recordsPerDay);
  expect(usedPercent).toBeLessThan(100);
  return { usage, quota, usedPercent };
}

async function stageDay(costs: Cost[], device: Device, day: string, ordinal: number,
  records: Pick<ReturnType<typeof acceptedRecords>, 'usage' | 'quota'>) {
  const prepared = await makeV11Day(day, records, 'synthetic-bounded-shared-window');
  for (const chunk of prepared.chunks) expect(chunk.records.length).toBeLessThanOrEqual(limits.recordsPerChunk);
  await invocation(costs, 'accepted_manifest', ordinal, candidate(), db =>
    registerTelemetryV11DayManifest(db.source, device, prepared.manifest));
  // Native uploads are separate requests. Each authorization and indivisible
  // <=200-row chunk stays together under its own real950 invocation meter.
  for (const [chunkOrdinal, chunk] of prepared.chunks.entries()) {
    await invocation(costs, 'accepted_chunk', ordinal, candidate(), async db => {
      const envelopeDigest = await sha256Hex(`synthetic-window-upload:${ordinal}:${chunkOrdinal}`);
      const principal = await authenticateDevice(db.source, device.authorization);
      const upload = await createDeviceUploadAuthorization(db.source, principal, envelopeDigest, 4096);
      const claimed = await claimDeviceUploadAuthorization(db.source, `Upload ${upload.uploadAuthorization}`,
        { envelopeDigest, bodyBytes: 4096, contentType: 'application/json' });
      await persistTypedV11StagedChunk(db.source, device, chunk, { sourceNamespace: sourceId,
        chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/window/${ordinal}/${chunkOrdinal}`,
        envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
    }, chunkOrdinal);
  }
  return invocation(costs, 'accepted_day_seal', ordinal, candidate(), db =>
    registerTelemetryV11DayManifest(db.source, device, prepared.manifest));
}

type ReadyDay=Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;
async function activate(costs:Cost[],device:Device,ready:readonly ReadyDay[],ordinal:number){
  await invocation(costs,'accepted_domain',ordinal,candidate(),async db=>{
    const predecessor=await createTelemetryV11DomainPredecessor(db.source,device);
    const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
      fromDay:ready[0]!.day,throughDay:ready.at(-1)!.day,
      predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
        legacyFingerprint:predecessor.legacyFingerprint},
      days:ready.map(value=>({day:value.day,manifestId:value.manifestId,manifestDigest:value.manifestDigest})),
      manifestDigest:'0'.repeat(64)};
    expect(manifest.fromDay<=predecessor.fromDay&&manifest.throughDay>=predecessor.throughDay).toBe(true);
    manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(db.source,device,manifest);
  });
}
async function currentOwner(costs:Cost[],device:Device,ordinal:number){
  return invocation(costs,'source_owner_proof',ordinal,candidate(),async db=>{
    const row=(await readStorageCommunityOwnerPage(db.source)).find(value=>value.participantId===device.participantId);
    expect(row).toMatchObject({hasV11:true,hasEffective:true});
    expect(row?.ownerDigest).toMatch(/^[a-f0-9]{64}$/u);return row as Owner;
  });
}
async function tinyFixture(costs:Cost[]){
  const laboratory=await initialize(costs),today=date(Date.now()),selectedDay=date(Date.parse(today)-dayMs);
  const firstMs=Date.parse(selectedDay)-2*dayMs;
  const calendarDays=Array.from({length:limits.calendarDays},(_,ordinal)=>date(firstMs+ordinal*dayMs));
  expect(calendarDays.at(-1)).toBe(today);
  const days=[calendarDays[0]!,calendarDays[2]!],gapDay=calendarDays[1]!;
  const window=modelHistoryWindow(selectedDay);
  expect(days.every(day=>day>=window.fromDay&&day<=window.day)).toBe(true);
  const device=await invocation(costs,'native_device',0,candidate(),db=>createV11DeviceFixture(db.source,{grant:true}));
  const sparse=acceptedRecords(days[0]!,0,limits.sparseUsageRows,firstMs,0);
  const dense=acceptedRecords(days[1]!,2,limits.scalarResumeRows,firstMs,sparse.usedPercent);
  // Pure native-priced fixture precondition before any manifest/chunk writes.
  expect(dense.usedPercent).toBeGreaterThanOrEqual(COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP);
  const ready:ReadyDay[]=[];
  for(const [ordinal,day]of calendarDays.entries())ready.push(await stageDay(costs,device,day,ordinal,
    day===days[0]?sparse:day===days[1]?dense:{usage:[],quota:[]}));
  expect(ready).toHaveLength(limits.calendarDays);
  await activate(costs,device,ready,0);
  const owner=await currentOwner(costs,device,0);
  for(const [targetOrdinal,target]of [candidate(),reference()].entries()){
    let complete=false;
    for(let turn=0;turn<limits.deliveryPasses;turn++){
      const result=await invocation(costs,`ordered_delivery_${targetOrdinal}`,turn,target,(db,meter)=>
        runStorageAnalyticsPass({...db,sourceId,sourceNamespace:sourceId,publishCommunity:false,maxSteps:32,
          maxQueries:meter.remainingQueries,deadlineMs:Date.now()+55_000}));
      if(result.state==='idle'&&result.reason==='complete'){complete=true;break;}
    }
    expect(complete,'tiny native delivery ceiling').toBe(true);
    await invocation(costs,'target_owner_proof',targetOrdinal,target,async db=>{
      expect(await db.target.prepare(`SELECT revision,authority_epoch,state FROM analytics_owner_state
        WHERE source_id=? AND owner_digest=?`).bind(sourceId,owner.ownerDigest).first())
        .toEqual({revision:owner.ownerRevision,authority_epoch:owner.authorityEpoch,state:'active'});
    });
  }
  const frames=[];
  for(const [ordinal,day]of days.entries()){
    let complete=false;
    for(let attempt=0;attempt<limits.featureAttempts;attempt++){
      const result=await invocation(costs,'native_feature_preparation',ordinal,candidate(),(db,meter)=>
        sharedFeatures.advanceSharedAnalyticsFeatureDay({...db,sourceId,sourceNamespace:sourceId,owner,day,
          budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+55_000}}));
      if(result.state!=='complete'){expect(result.state).toBe('deferred');continue;}
      const rows=ordinal===0?limits.sparseUsageRows:limits.scalarResumeRows;
      expect(validSharedAnalyticsFeatureDay(result.value)).toBe(true);
      expect(result.value.scalarUsage).toHaveLength(rows);expect(result.value.cacheEventsRead).toBe(rows);
      expect(result.value.modelUsage.projection.usage.rowsRead).toBe(rows);
      expect(result.value.quota.quotaRowsRead).toBe(13);
      expect(validEffectiveQuotaDay(result.value.quota)).toBe(true);
      expect(validEffectiveUsageDay(result.value.modelUsage)).toBe(true);
      const fullBytes=bytes({kind:'complete',value:result.value});
      expect(fullBytes).toBeLessThanOrEqual(SHARED_ANALYTICS_FEATURE_MAX_BYTES);
      await invocation(costs,'frame_head_byte_proof',ordinal,candidate(),async db=>{
        expect(await db.target.prepare(`SELECT payload_bytes FROM analytics_shared_feature_days
          WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND state='complete'`)
          .bind(sourceId,owner.ownerDigest,day,result.dependencyDigest).first<number>('payload_bytes')).toBe(fullBytes);
      });
      frames.push({ordinal,rows,quotaRows:13,fullBytes});complete=true;break;
    }
    expect(complete,'tiny native feature ceiling').toBe(true);
  }
  expect(frames).toHaveLength(2);expect(frames.reduce((n,row)=>n+row.rows,0)).toBe(425);
  return {owner,device,days,gapDay,selectedDay,ready,frames,laboratory};
}
type Fixture=Awaited<ReturnType<typeof tinyFixture>>;
async function addInsideWindowUsage(costs:Cost[],fixture:Fixture){
  const before=await currentOwner(costs,fixture.device,1),day=fixture.gapDay;
  const record=v11UsageRecord(day,'a',{eventId:`event:v2:${(3001).toString(16).padStart(64,'0')}`,
    eventTime:`${day}T12:05:00.000Z`,accountPlanAttribution:attribution()});
  const price=priceChunkUsageRecord(canonicalJson(record),record.eventTime!);
  expect(price?.pricingStatus).toBe('fully_priced');expect(price!.costNanousd).toBeGreaterThan(0);
  // This day was genuinely empty, so no old physical chunk ID is reused and
  // every original populated manifest remains in the complete native vector.
  const replacement=await stageDay(costs,fixture.device,day,limits.calendarDays,{usage:[record],quota:[]});
  const ready=fixture.ready.map(value=>value.day===day?replacement:value);
  expect(ready.map(value=>value.day)).toEqual(fixture.ready.map(value=>value.day));
  await activate(costs,fixture.device,ready,1);
  const after=await currentOwner(costs,fixture.device,2);
  expect(after.ownerDigest).toBe(before.ownerDigest);expect(after.inputRevision).toBeGreaterThan(before.inputRevision);
  return {before:{inputRevision:before.inputRevision,ownerRevision:before.ownerRevision,authorityEpoch:before.authorityEpoch},
    after:{inputRevision:after.inputRevision,ownerRevision:after.ownerRevision,authorityEpoch:after.authorityEpoch},
    newPopulatedDays:3,newAcceptedUsageRows:1};
}
async function oneGraph(costs:Cost[],fixture:Fixture,target:D1Database,shared:boolean,ordinal:number,
  adapt?:(target:D1Database)=>D1Database,onScope?:(scope:StorageGraphScope)=>void){
  return invocation(costs,shared?'graph_default_fits':'graph_native_fits',ordinal,target,async(db,meter)=>{
    const scope=await captureStorageGraphScope(db.source,{owner:fixture.owner,day:fixture.selectedDay,
      metric:'fits',sourceId,sourceNamespace:sourceId,preparedFold:true});
    expect(scope.source).toBe('effective');onScope?.(scope);
    const result=await computeStorageGraphResult({...db,target:adapt?.(db.target)??db.target,sourceId,sourceNamespace:sourceId},
      scope,{maxQueries:meter.remainingQueries,deadlineMs:Date.now()+55_000,preparedFold:true,
        preparedEffectiveUsage:false,sharedFeatures:shared});
    return {scope,result};
  });
}
async function finishGraph(costs:Cost[],fixture:Fixture,target:D1Database,shared:boolean){
  for(let turn=0;turn<limits.graphPasses;turn++){
    const value=await oneGraph(costs,fixture,target,shared,turn);
    if(value.result.state==='complete')return {...value,invocations:turn+1};
    expect(value.result.failure).toBeUndefined();
  }
  throw Error('TINY_NATIVE_GRAPH_PROGRESS_CEILING');
}
function observePlans(onPage?:(page:ReturnType<sharedFeatures.SharedAnalyticsFeatureWindowPlan['usageReader']['readPage']> extends Promise<infer T>?T:never)=>Promise<void>){
  const counts={accepted:0,closed:0,scalarAcquisitions:0,fullAcquisitions:0},original=sharedFeatures.readSharedAnalyticsFeatureWindowPlan;
  const spy=vi.spyOn(sharedFeatures,'readSharedAnalyticsFeatureWindowPlan').mockImplementation(async input=>{
    const before=scalarInitialPartLoads,prior=acquisitionConsumer;acquisitionConsumer=input.consumer??'full';
    let result:Awaited<ReturnType<typeof original>>;
    try{result=await original(input);}finally{acquisitionConsumer=prior;}
    if(input.consumer==='scalar')expect(scalarInitialPartLoads-before).toBe(0);
    expect(result.state).toBe('complete');
    if(result.state==='complete'){
      counts.accepted++;if(input.consumer==='scalar')counts.scalarAcquisitions++;else counts.fullAcquisitions++;
      const close=result.plan.close;let closed=false;
      result.plan.close=()=>{if(!closed){counts.closed++;closed=true;}close();
        expect(result.plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});};
      if(onPage){const read=result.plan.usageReader.readPage;
        result.plan.usageReader.readPage=async request=>{const page=await read(request);await onPage(page);return page;};}
    }
    return result;
  });
  const bulk=vi.spyOn(sharedFeatures,'readSharedAnalyticsFeatureWindow');
  return {counts,close(){spy.mockRestore();bulk.mockRestore();},assertClosed(){
    expect(counts.accepted).toBeGreaterThan(0);expect(counts.closed).toBe(counts.accepted);
    expect(bulk).not.toHaveBeenCalled();}};
}
async function audit(costs:Cost[],scope:StorageGraphScope,key?:StorageHistoryKey){
  return invocation(costs,'native_terminal_audit',0,candidate(),async db=>({
    result:await readStorageGraphResult({...db,sourceId,sourceNamespace:sourceId},scope),
    ...(key?{head:await checkpointStore.readStorageHistoryCheckpointHead({target:db.target,key})}:{})}));
}
function assertSourceRefusal(value:Awaited<ReturnType<typeof oneGraph>>|undefined,error:unknown){
  if(error!==undefined){
    // Keep the native failure observable; unrelated setup/SQL exceptions do
    // not count as a source-race proof.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');return;
  }
  expect(value?.result.state).toBe('deferred');
  if(value?.result.state==='deferred')expect(['shared_feature_source_changed','source_changed','authority_changed'])
    .toContain(value.result.reason);
}
function closedFailureCategory(error:unknown):string {
  if(error instanceof TypeError&&error.message==='unmetered or foreign database statement')return 'meter_foreign_statement';
  if(error instanceof TypeError&&error.message==='NATIVE_LIFETIME_UNOWNED_ADAPTER_BATCH')return 'adapter_unowned_statement';
  if(error instanceof Error&&error.message==='analytics benchmark unprofiled batch')return 'profile_unprofiled_batch';
  if(error instanceof Error&&error.message==='STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE')return 'native_source_unavailable';
  if(error instanceof Error&&error.name==='AssertionError')return 'assertion_failure';
  return 'other_exception';
}
function saveAfterWrite(target:D1Database,after:(result:D1Result)=>Promise<void>):D1Database{
  // Preserve the SAME native meter's statement identities across this observer.
  // Unwrapping before its batch preserves actual charging/guards exactly once.
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
  const statement=(prepared:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const wrapped=new Proxy(prepared,{get(inner,key){
      if(key==='bind')return(...values:unknown[])=>statement(inner.bind(...values),sql);
      if(key==='run'&&sql.includes('INSERT INTO analytics_community_graph_results'))return async()=>{
        const result=await inner.run();await after(result);return result;};
      const value=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
    }});
    originals.set(wrapped,prepared);return wrapped;
  };
  return new Proxy(target,{get(db,key){
    if(key==='prepare')return(sql:string)=>statement(db.prepare(sql),sql);
    if(key==='batch')return(statements:D1PreparedStatement[])=>db.batch(statements.map(value=>{
      const original=originals.get(value);
      if(!original)throw new TypeError('NATIVE_LIFETIME_UNOWNED_ADAPTER_BATCH');
      return original;
    }));
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
  }});
}

function receipt(task:{meta:object},setup:Cost[],work:Cost[],evidence:Record<string,unknown>){
  Object.assign(task.meta,{sharedWindowNativeLifetime:{...evidence,limits,setup:aggregate(setup),work:aggregate(work),
    setupCosts:setup,workCosts:work,cpuMs:null,observedPeakHeapBytes:null,
    boundary:'New tiny accepted-source native checkpoint/source/lifetime component; no whole or performance claim.'}});
}

it('resumes the exact native format6 completed quota checkpoint after a committed lost response',async({task})=>{
  const setup:Cost[]=[],work:Cost[]=[],evidence:Record<string,unknown>={};let plans:ReturnType<typeof observePlans>|undefined;
  let savedKey:StorageHistoryKey|undefined,savedHead:string|undefined,scope:StorageGraphScope|undefined,injected=false;
  const original=checkpointStore.saveStorageHistoryCheckpoint;
  let save:ReturnType<typeof vi.spyOn>|undefined;
  try{
    const fixture=await tinyFixture(setup);evidence.frames=fixture.frames;
    const native=await finishGraph(work,fixture,reference(),false);
    expect(native.result.state).toBe('complete');if(native.result.state!=='complete')throw Error('TINY_NATIVE_REFERENCE_REFUSED');
    evidence.nativeReferenceFitCount=native.result.result.fits!.length;
    expect(native.result.result.fits!.length).toBeGreaterThan(0);
    plans=observePlans();
    save=vi.spyOn(checkpointStore,'saveStorageHistoryCheckpoint').mockImplementation(async input=>{
      const result=await original(input);
      if(!injected&&result.status==='saved'&&'source'in input.checkpoint
        &&input.checkpoint.source==='effective'&&input.checkpoint.phase==='finish'){
        injected=true;savedKey={...input.key};savedHead=result.headDigest;
        throw Error('SYNTHETIC_COMMITTED_CHECKPOINT_RESPONSE_LOST');
      }
      return result;
    });
    let lost:unknown;
    for(let turn=0;turn<limits.graphPasses&&!injected;turn++){
      try{const value=await oneGraph(work,fixture,candidate(),true,turn);scope=value.scope;
        expect(value.result.state).toBe('deferred');}
      catch(error){lost=error;if(!injected)throw error;}
    }
    expect(injected).toBe(true);expect(lost).toMatchObject({stage:'graph_checkpoint_save',reason:'application'});
    save.mockRestore();save=undefined;
    scope=await invocation(work,'fresh_scope_after_committed_loss',0,candidate(),db=>captureStorageGraphScope(db.source,
      {owner:fixture.owner,day:fixture.selectedDay,metric:'fits',sourceId,sourceNamespace:sourceId,preparedFold:true}));
    const exact=await storageGraphEffectiveCheckpointKey({sourceId,sourceNamespace:sourceId,ownerDigest:fixture.owner.ownerDigest,
      day:fixture.selectedDay,dependencyDigest:scope.checkpointDependencyDigest,method:storageGraphEffectiveCheckpointMethod('fits')},true,6);
    expect(savedKey).toEqual(exact);
    await invocation(work,'full_native_checkpoint_decode',0,candidate(),async db=>{
      let cursor:checkpointStore.StorageHistoryLoadCursor|undefined;
      for(let loads=0;loads<16;loads++){
        const loaded=await checkpointStore.loadStorageHistoryCheckpoint({target:db.target,key:exact,cursor});
        if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
        expect(loaded.status).toBe('ready');if(loaded.status!=='ready'||!('source'in loaded.checkpoint)
          ||loaded.checkpoint.source!=='effective')throw Error('TINY_NATIVE_CHECKPOINT_DECODE_REFUSED');
        expect(loaded.headDigest).toBe(savedHead);expect(loaded.checkpoint.phase).toBe('finish');
        expect(storageGraphScalarSharedResumeEligible({checkpoint:loaded.checkpoint,pin:scope!.pin as V11SourcePin,
          sourceNamespace:sourceId,day:fixture.selectedDay,nowMs:Date.parse(scope!.fixedNow)})).toBe(true);return;
      }
      throw Error('TINY_NATIVE_CHECKPOINT_LOAD_CEILING');
    });
    const resumed=await finishGraph(work,fixture,candidate(),true);
    expect(resumed.result.state).toBe('complete');if(resumed.result.state!=='complete')throw Error('TINY_NATIVE_RESUME_REFUSED');
    expect(resumed.result.result.scope.pin.fingerprint).toBe(native.result.result.scope.pin.fingerprint);
    expect(resumed.result.result.fits).toEqual(native.result.result.fits);
    expect(plans.counts.scalarAcquisitions).toBeGreaterThan(0);plans.assertClosed();
    evidence.nativeInvocations=native.invocations;evidence.resumedInvocations=resumed.invocations;
    evidence.exactFitsParity=true;evidence.committedLossObserved=true;evidence.plans={...plans.counts};
  }finally{save?.mockRestore();plans?.close();receipt(task,setup,work,evidence);}
},180_000);

it('refuses a genuinely populated new source day after a scalar page and preserves the last native checkpoint head',async({task})=>{
  const setup:Cost[]=[],work:Cost[]=[],mutation:Cost[]=[],evidence:Record<string,unknown>={};
  let plans:ReturnType<typeof observePlans>|undefined,key:StorageHistoryKey|undefined,head:string|null|undefined,injected=false,oldScope:StorageGraphScope|undefined;
  const original=checkpointStore.saveStorageHistoryCheckpoint;
  let save:ReturnType<typeof vi.spyOn>|undefined;
  try{
    const fixture=await tinyFixture(setup);evidence.frames=fixture.frames;
    save=vi.spyOn(checkpointStore,'saveStorageHistoryCheckpoint').mockImplementation(async input=>{
      const result=await original(input);if(result.status==='saved'){key={...input.key};}return result;});
    plans=observePlans(async page=>{
      if(injected||page.state!=='ready'||page.rows.length===0)return;
      expect(key).toBeDefined();
      head=(await invocation(work,'pre_mutation_checkpoint_audit',0,candidate(),db=>
        checkpointStore.readStorageHistoryCheckpointHead({target:db.target,key:key!})))?.generation;
      expect(head).toMatch(/^[a-f0-9]{64}$/u);
      injected=true;evidence.mutation=await addInsideWindowUsage(mutation,fixture);
    });
    let raced:Awaited<ReturnType<typeof oneGraph>>|undefined,error:unknown;
    for(let turn=0;turn<limits.graphPasses&&!injected;turn++){
      try{raced=await oneGraph(work,fixture,candidate(),true,turn,undefined,value=>{oldScope=value;});}
      catch(caught){error=caught;break;}
    }
    expect(injected).toBe(true);assertSourceRefusal(raced,error);
    expect(oldScope).toBeDefined();const after=await audit(work,oldScope!,key);
    expect(after.head?.generation).toBe(head);expect(after.result).toBeNull();plans.assertClosed();
    evidence.noStaleHeadPromotion=true;evidence.plans={...plans.counts};
  }finally{save?.mockRestore();plans?.close();receipt(task,setup,work,{...evidence,mutationSummary:aggregate(mutation),mutationCosts:mutation});}
},180_000);

it('keeps the live native source seal through graph write readback and closes every plan after an accepted source change',async({task})=>{
  const setup:Cost[]=[],work:Cost[]=[],mutation:Cost[]=[],evidence:Record<string,unknown>={};
  let plans:ReturnType<typeof observePlans>|undefined,injected=false,oldScope:StorageGraphScope|undefined;
  try{
    const fixture=await tinyFixture(setup);evidence.frames=fixture.frames;plans=observePlans();
    let raced:Awaited<ReturnType<typeof oneGraph>>|undefined,error:unknown;
    for(let turn=0;turn<limits.graphPasses&&!injected;turn++){
      try{raced=await oneGraph(work,fixture,candidate(),true,turn,target=>saveAfterWrite(target,async result=>{
        expect(injected).toBe(false);expect(oldScope).toBeDefined();
        const exactScope=oldScope!;
        // D1 total changes include native trigger writes. Prove the one exact
        // graph row through this same actual950 target before source mutation.
        const matchedOwnRows=await target.prepare(`SELECT count(*) AS n FROM analytics_community_graph_results
          WHERE source_id=? AND owner_digest=? AND metric=? AND day=? AND method=?
            AND dependency_digest=? AND input_revision=? AND source_kind=?`)
          .bind(sourceId,fixture.owner.ownerDigest,exactScope.metric,fixture.selectedDay,STORAGE_GRAPH_METHOD,
            exactScope.dependencyDigest,fixture.owner.inputRevision,exactScope.source).first<number>('n');
        evidence.graphWriteBoundary={returnedSuccess:result.success,returnedChanges:result.meta.changes,matchedOwnRows};
        expect(result.success).toBe(true);expect(Number.isSafeInteger(result.meta.changes)).toBe(true);
        expect(result.meta.changes).toBeGreaterThan(0);expect(matchedOwnRows).toBe(1);
        injected=true;evidence.mutation=await addInsideWindowUsage(mutation,fixture);
      }),value=>{oldScope=value;});}
      catch(caught){error=caught;evidence.caughtBoundary={injectionReached:injected,category:closedFailureCategory(caught)};break;}
    }
    expect(injected).toBe(true);assertSourceRefusal(raced,error);
    // A native private row really committed. Fresh source/public-read guards
    // must refuse it; no distributed rollback is asserted or simulated.
    await invocation(work,'private_commit_and_public_refusal_audit',0,candidate(),async db=>{
      expect(await db.target.prepare(`SELECT count(*) AS n FROM analytics_community_graph_results
        WHERE source_id=? AND owner_digest=? AND metric='fits' AND day=?`)
        .bind(sourceId,fixture.owner.ownerDigest,fixture.selectedDay).first<number>('n')).toBe(1);
      expect(oldScope).toBeDefined();
      // The stale private pin rejects exactly at its native owner fence. A
      // refreshed source scope independently refuses the retained old row.
      const staleRead=readStorageGraphResult({...db,sourceId,sourceNamespace:sourceId},oldScope!);
      await expect(staleRead).rejects.toBeInstanceOf(Error);
      await expect(staleRead).rejects.toMatchObject({message:'STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE'});
      const owners=await readStorageCommunityOwnerPage(db.source);
      const freshOwner=owners.find(value=>value.ownerDigest===fixture.owner.ownerDigest);
      expect(freshOwner).toMatchObject({ownerDigest:fixture.owner.ownerDigest,participantId:fixture.owner.participantId,
        authorityEpoch:fixture.owner.authorityEpoch,inputRevision:fixture.owner.inputRevision+1,
        ownerRevision:fixture.owner.ownerRevision+1,hasEffective:true});
      const freshScope=await captureStorageGraphScope(db.source,{owner:freshOwner!,day:fixture.selectedDay,
        metric:'fits',sourceId,sourceNamespace:sourceId,preparedFold:true});
      expect(freshScope.dependencyDigest).not.toBe(oldScope!.dependencyDigest);
      expect(await readStorageGraphResult({...db,sourceId,sourceNamespace:sourceId},freshScope)).toBeNull();
      evidence.readbackBoundary={staleNativeScopeRejected:true,freshNativeScopeReadNull:true};
    });
    plans.assertClosed();evidence.privateWriteCommitted=true;evidence.freshReadRefused=true;evidence.plans={...plans.counts};
  }finally{plans?.close();receipt(task,setup,work,{...evidence,mutationSummary:aggregate(mutation),mutationCosts:mutation});}
},180_000);
