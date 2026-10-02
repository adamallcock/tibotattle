import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { telemetryV11DomainManifestDigestInput, MAX_TELEMETRY_V11_CHUNK_RECORDS, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation, type TelemetryV11UsageEvent } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageSource } from '../src/analytics-delivery';
import { canonicalJson } from '../src/canonical-json';
import { drainCommunityPublicSourceBootstrap } from '../src/community-daily-aggregates';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from '../src/device-auth';
import { modelHistoryWindow } from '../src/model-history-window';
import { priceChunkUsageRecord } from '../src/quota-analysis-v1';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { readStorageCommunityOwnerPage, type StorageCommunityOwner } from '../src/storage-community-authority';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import { MODEL_HISTORY_TEST_CAPACITIES, pricedModelHistoryUsage } from './helpers/model-history';
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import type { SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

const b = env as Env & SharedAnalyticsCorpusMigrations & { STORAGE_ANALYTICS_DB: D1Database;
  STORAGE_INGESTION_A: D1Database; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] };
const sourceId = 'synthetic-bounded-shared-window', dayMs = 86_400_000, hourMs = 3_600_000;
const limits = { days: 101, featureAttempts: 16, deliveryPasses: 128, graphPasses: 180,
  usagePerDay: 200, scalarResumeRows: 401, recordsPerDay: 600, recordsPerChunk: 200 } as const;
const source = () => b.USAGE_MONITOR_DB, candidate = () => b.STORAGE_ANALYTICS_DB,
  reference = () => b.STORAGE_INGESTION_A;
type Device = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Cost = { phase: string; ordinal: number; statements: number; rowsRead: number;
  rowsWritten: number; elapsedMs: number; failedStatements: number };
const date = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
const attribution = () => ({ accountBasis: 'same_source' as const,
  accountTrackId: `account-track:v2:${'f'.repeat(64)}`, planBasis: 'same_source_occurrence' as const,
  planType: 'pro' as const, planEraId: null });
const session = ['0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b', 'e46332ab-4fd4-4f52-90d2-1445b0af46f2'];


// A transparent observer of a native failed transaction. It rethrows the same
// error and retains only a closed classification, never SQL/binds/rows/errors.
type NativeFailure={phase:string;ordinal:number;statements:number;categories:readonly string[];knownIdentifier:string|null};
const knownIdentifiers=['typed_v11_manifest_membership_conflict','typed_v11_record_staging_denied',
 'typed_v11_record_proof_identity_denied','typed_v11_unallocated_record','typed_v11_allocator_race',
 'typed_telemetry_identity_conflict','typed_telemetry_membership_conflict',
 'typed_telemetry_quota','typed_telemetry_quota_dimensions','typed_telemetry_attributions',
 'typed_v11_record_proofs','typed_v11_chunk_allocations','typed_telemetry_records',
 'telemetry_v11_chunks','telemetry_v11_day_manifests','device_upload_authorizations'] as const;
function classify(error:unknown){
 const messages:string[]=[];let next:unknown=error;
 for(let depth=0;depth<4&&next&&typeof next==='object';depth++){
  const value=next as {message?:unknown;cause?:unknown};if(typeof value.message==='string')messages.push(value.message);next=value.cause;
 }
 const text=messages.join(' '),categories:string[]=[];
 for(const [pattern,name]of [[/FOREIGN KEY constraint/iu,'foreign_key_constraint'],[/UNIQUE constraint/iu,'unique_constraint'],
  [/CHECK constraint/iu,'check_constraint'],[/NOT NULL constraint/iu,'not_null_constraint'],
  [/Expression tree too large|maximum depth/iu,'expression_depth'],[/no such column/iu,'missing_column'],
  [/no such table/iu,'missing_table'],[/no query solution/iu,'index_query_unavailable'],
  [/bind|unsupported type/iu,'binding_failure'],[/too many SQL variables/iu,'binding_limit'],
  [/trigger|(?:typed_v11|typed_telemetry)_[a-z_]+/iu,'named_schema_guard']] as const)if(pattern.test(text))categories.push(name);
 return {categories:categories.length?categories:['unknown_native_failure'],
  knownIdentifier:knownIdentifiers.find(identifier=>text.includes(identifier))??null};
}
function observeNativeBatch(database:D1Database,phase:string,ordinal:number):D1Database{
 return new Proxy(database,{get(db,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   try{return await db.batch(statements);}catch(error){nativeFailures.push({phase,ordinal,statements:statements.length,...classify(error)});throw error;}
  };
  const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
 }});
}
const nativeFailures:NativeFailure[]=[];
async function invocation<T>(costs: Cost[], phase: string, ordinal: number, target: D1Database,
  run: (db: { source: D1Database; target: D1Database; ledger: D1Database },
    meter: ReturnType<typeof createD1InvocationBudget>) => Promise<T>): Promise<T> {
  const profile = createAnalyticsProfile(), meter = createD1InvocationBudget(950), start = performance.now();
  const db = { source: meter.wrap(profileAnalyticsDatabase(observeNativeBatch(source(), phase, ordinal), 'source', profile, () => phase)),
    target: meter.wrap(profileAnalyticsDatabase(target, 'target', profile, () => phase)),
    ledger: meter.wrap(profileAnalyticsDatabase(b.DELETION_LEDGER, 'ledger', profile, () => phase)) };
  try { return await run(db, meter); }
  finally {
    const observed = summarizeAnalyticsProfile(profile);
    costs.push({ phase, ordinal, statements: meter.queriesUsed, rowsRead: observed.rowsRead,
      rowsWritten: observed.rowsWritten, failedStatements: observed.failedStatements,
      elapsedMs: performance.now() - start });
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
        * ((globalBin + modelOrdinal) % 3 === 0 ? 0.2 : 1);
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
  return invocation(costs, 'accepted_day', ordinal, candidate(), async db => {
    await registerTelemetryV11DayManifest(db.source, device, prepared.manifest);
    for (const [chunkOrdinal, chunk] of prepared.chunks.entries()) {
      const envelopeDigest = await sha256Hex(`synthetic-window-upload:${ordinal}:${chunkOrdinal}`);
      const principal = await authenticateDevice(db.source, device.authorization);
      const upload = await createDeviceUploadAuthorization(db.source, principal, envelopeDigest, 4096);
      const claimed = await claimDeviceUploadAuthorization(db.source, `Upload ${upload.uploadAuthorization}`,
        { envelopeDigest, bodyBytes: 4096, contentType: 'application/json' });
      const metadata = { sourceNamespace: sourceId,
        chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/window/${ordinal}/${chunkOrdinal}`,
        envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
      // Native authority-table contract is stricter than the generic typed ID codec.
      // migrations/0044: length(id)=42 AND substr(id,1,6)='chunk:'.
      expect(metadata.chunkRowId).toHaveLength(42);
      expect(metadata.chunkRowId.startsWith('chunk:')).toBe(true);
      const admitted = await persistTypedV11StagedChunk(db.source, device, chunk, metadata);
      expect(admitted).toMatchObject({ contributionId: metadata.chunkRowId, replay: false });
      const proof = await db.source.prepare(`SELECT c.record_count,c.participant_id,c.device_id,
        (SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id=c.id) typed_count,
        (SELECT state FROM device_upload_authorizations a WHERE a.id=c.device_upload_authorization_id) upload_state
        FROM telemetry_v11_chunks c WHERE c.id=?`).bind(metadata.chunkRowId).first();
      expect(proof).toEqual({ record_count: chunk.records.length, participant_id: device.participantId,
        device_id: device.deviceId, typed_count: chunk.records.length, upload_state: 'consumed' });
    }
    return registerTelemetryV11DayManifest(db.source, device, prepared.manifest);
  });
}


it('isolates the exact first bounded-window native quota and usage admission with full predecessor activation',async({task})=>{
 const costs:Cost[]=[],receipt:Record<string,unknown>={boundary:'Native admission diagnosis only; not shared-window or graph evidence.'};
 nativeFailures.length=0;
 try{
  receipt.laboratory=await initialize(costs);
  const today=date(Date.now()),selectedDay=date(Date.parse(`${today}T00:00:00.000Z`)-dayMs);
  const window=modelHistoryWindow(selectedDay),firstMs=Date.parse(`${window.fromDay}T00:00:00.000Z`),day=date(firstMs);
  const records=acceptedRecords(day,0,limits.usagePerDay,firstMs,0);
  expect(MAX_TELEMETRY_V11_CHUNK_RECORDS).toBe(limits.recordsPerChunk);
  expect(new Set(records.quota.map(row=>row.observationId)).size).toBe(records.quota.length);
  expect(new Set(records.usage.map(row=>row.eventId)).size).toBe(records.usage.length);
  const prepared=await makeV11Day(day,records,'synthetic-bounded-shared-window');
  expect(prepared.chunks.map(chunk=>({stream:chunk.chunkId.split(':')[0],rows:chunk.records.length})))
   .toEqual([{stream:'quota',rows:13},{stream:'usage',rows:200}]);
  receipt.payload={quotaRows:13,usageRows:200,chunkRows:prepared.chunks.map(chunk=>chunk.records.length),
   nativeMaximumChunkRows:MAX_TELEMETRY_V11_CHUNK_RECORDS,streamOccurrenceVectorsUnique:true,
   sameOwnerDevice:true,accountScopeCount:1,modelCount:2,sessionCount:2};
  const device=await invocation(costs,'native_device',0,candidate(),db=>createV11DeviceFixture(db.source,{grant:true}));
  const ready:Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>[]=[];
  ready.push(await stageDay(costs,device,day,0,records));
  // The native predecessor includes UTCtoday. Complete the exact calendar
  // vector using real empty manifests; never fake current-domain/owner state.
  for(let ordinal=1;ordinal<=limits.days;ordinal++)ready.push(await stageDay(costs,device,date(firstMs+ordinal*dayMs),ordinal,{usage:[],quota:[]}));
  expect(ready).toHaveLength(limits.days+1);expect(ready.at(-1)!.day).toBe(today);
  const activated=await invocation(costs,'accepted_domain',0,candidate(),async db=>{
   const predecessor=await createTelemetryV11DomainPredecessor(db.source,device);
   const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:ready[0]!.day,throughDay:ready.at(-1)!.day,
    predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},
    days:ready.map(value=>({day:value.day,manifestId:value.manifestId,manifestDigest:value.manifestDigest})),manifestDigest:'0'.repeat(64)};
   expect(manifest.fromDay<=predecessor.fromDay&&manifest.throughDay>=predecessor.throughDay).toBe(true);
   manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
   return activateTelemetryV11Domain(db.source,device,manifest);
  });
  expect(activated).toMatchObject({replay:false,fromDay:day,throughDay:today});
  await invocation(costs,'native_owner_and_vector_proof',0,candidate(),async db=>{
   const owner=(await readStorageCommunityOwnerPage(db.source)).find(value=>value.participantId===device.participantId);
   expect(owner).toMatchObject({hasEffective:true,hasV11:true});expect(owner?.ownerDigest).toMatch(/^[a-f0-9]{64}$/u);
   expect((await db.source.prepare(`SELECT stream,count(*) n FROM typed_v11_record_admissions p
    JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE m.participant_id=? GROUP BY stream ORDER BY stream`)
    .bind(device.participantId).all()).results).toEqual([{stream:'quota',n:13},{stream:'usage',n:200}]);
   expect(await db.source.prepare('SELECT count(*) n FROM telemetry_v11_domain_days WHERE generation_id=?')
    .bind(activated.generationId).first<number>('n')).toBe(limits.days+1);
  });
  receipt.nativeAdmissionComplete=true;
 }finally{Object.assign(task.meta,{boundedWindowAdmission:{...receipt,nativeFailures,resources:aggregate(costs),costs,
  contract:'Actual native APIs and full activation lifecycle under950 meters. Closed raw transaction error categories only; no product behavior alteration.'}});}
},60_000);
