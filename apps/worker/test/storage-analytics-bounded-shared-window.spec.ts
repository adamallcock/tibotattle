import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { MODEL_COMPOSITION_POLICY } from '@app-usagemonitor/quota-analysis';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation, type TelemetryV11UsageEvent } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageSource } from '../src/analytics-delivery';
import { validSharedAnalyticsFeatureDay, SHARED_ANALYTICS_FEATURE_MAX_BYTES } from '../src/analytics-shared-features';
import { canonicalJson } from '../src/canonical-json';
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
import { captureStorageGraphScope, computeStorageGraphResult } from '../src/storage-community-graph';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { initializeTypedV1Admission } from '../src/typed-v1-admission';
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import { MODEL_HISTORY_TEST_CAPACITIES, pricedModelHistoryUsage } from './helpers/model-history';
import { createSharedWindowStatementAudit } from './helpers/shared-window-statement-audit';
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import type { SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

// Ordinary native feature-method baseline, before optional graph-window plan
// adoption. No target owner, feature frame or source ACK is manufactured.
const b = env as Env & SharedAnalyticsCorpusMigrations & { STORAGE_ANALYTICS_DB: D1Database;
  STORAGE_INGESTION_A: D1Database; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] };
const sourceId = 'synthetic-bounded-shared-window', dayMs = 86_400_000, hourMs = 3_600_000;
const limits = { days: 101, featureAttempts: 16, deliveryPasses: 128, graphPasses: 180,
  usagePerDay: 200, scalarResumeRows: 401, recordsPerDay: 600, recordsPerChunk: 200 } as const;
const source = () => b.USAGE_MONITOR_DB, candidate = () => b.STORAGE_ANALYTICS_DB,
  reference = () => b.STORAGE_INGESTION_A;
type Owner = StorageCommunityOwner & { ownerDigest: string };
type Device = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Cost = { phase: string; ordinal: number; chunkOrdinal?: number; statements: number; rowsRead: number;
  rowsWritten: number; elapsedMs: number; failedStatements: number };
const date = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).byteLength;
const attribution = () => ({ accountBasis: 'same_source' as const,
  accountTrackId: `account-track:v2:${'f'.repeat(64)}`, planBasis: 'same_source_occurrence' as const,
  planType: 'pro' as const, planEraId: null });
const session = ['0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b', 'e46332ab-4fd4-4f52-90d2-1445b0af46f2'];

let activeStatementAudit: ReturnType<typeof createSharedWindowStatementAudit> | undefined;

async function invocation<T>(costs: Cost[], phase: string, ordinal: number, target: D1Database,
  run: (db: { source: D1Database; target: D1Database; ledger: D1Database },
    meter: ReturnType<typeof createD1InvocationBudget>) => Promise<T>, chunkOrdinal?: number): Promise<T> {
  const profile = createAnalyticsProfile(), meter = createD1InvocationBudget(950), start = performance.now();
  const audit = activeStatementAudit?.begin(phase);
  const db = { source: meter.wrap(profileAnalyticsDatabase(audit?.wrap(source(), 'source') ?? source(), 'source', profile, () => phase, audit?.observer)),
    target: meter.wrap(profileAnalyticsDatabase(audit?.wrap(target, target === reference() ? 'reference' : 'candidate') ?? target, 'target', profile, () => phase, audit?.observer)),
    ledger: meter.wrap(profileAnalyticsDatabase(audit?.wrap(b.DELETION_LEDGER, 'ledger') ?? b.DELETION_LEDGER, 'ledger', profile, () => phase, audit?.observer)) };
  try { return await run(db, meter); }
  finally {
    const observed = summarizeAnalyticsProfile(profile);
    audit?.finish(observed);
    costs.push({ phase, ordinal, ...(chunkOrdinal === undefined ? {} : { chunkOrdinal }),
      statements: meter.queriesUsed, rowsRead: observed.rowsRead,
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

async function admitWindow(costs: Cost[]) {
  const today = date(Date.now()), selectedDay = date(Date.parse(`${today}T00:00:00.000Z`) - dayMs);
  const window = modelHistoryWindow(selectedDay), firstMs = Date.parse(`${window.fromDay}T00:00:00.000Z`);
  const days = Array.from({ length: limits.days }, (_, ordinal) => date(firstMs + ordinal * dayMs));
  expect(days.at(-1)).toBe(selectedDay);
  const scalarResumeOrdinal = 50, scalarResumeDay = days[scalarResumeOrdinal]!;
  expect(scalarResumeDay >= window.fromDay && scalarResumeDay <= window.day).toBe(true);
  const device = await invocation(costs, 'native_device', 0, candidate(), db => createV11DeviceFixture(db.source, { grant: true }));
  const ready: Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>[] = [];
  let usedPercent = 0;
  for (const [ordinal, day] of days.entries()) {
    const records = acceptedRecords(day, ordinal, ordinal === scalarResumeOrdinal ? limits.scalarResumeRows : limits.usagePerDay,
      firstMs, usedPercent);
    usedPercent = records.usedPercent;
    ready.push(await stageDay(costs, device, day, ordinal, records));
  }
  ready.push(await stageDay(costs, device, today, limits.days, { usage: [], quota: [] }));
  expect(ready).toHaveLength(limits.days + 1);
  await invocation(costs, 'accepted_domain', 0, candidate(), async db => {
    const predecessor = await createTelemetryV11DomainPredecessor(db.source, device);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: 'telemetry-domain-manifest-v1.1',
      fromDay: ready[0]!.day, throughDay: ready.at(-1)!.day,
      predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint }, days: ready.map(value => ({ day: value.day,
        manifestId: value.manifestId, manifestDigest: value.manifestDigest })), manifestDigest: '0'.repeat(64) };
    expect(manifest.fromDay <= predecessor.fromDay && manifest.throughDay >= predecessor.throughDay).toBe(true);
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(db.source, device, manifest);
  });
  const owners = await invocation(costs, 'source_owner_proof', 0, candidate(), db => readStorageCommunityOwnerPage(db.source));
  const owner = owners.find(value => value.participantId === device.participantId);
  expect(owner).toMatchObject({ hasV11: true, hasEffective: true }); expect(owner?.ownerDigest).toMatch(/^[a-f0-9]{64}$/u);
  for (const [targetOrdinal, target] of [candidate(), reference()].entries()) {
    let finished = false;
    for (let turn = 0; turn < limits.deliveryPasses; turn++) {
      const delivered = await invocation(costs, `ordered_delivery_${targetOrdinal}`, turn, target, (db, meter) => runStorageAnalyticsPass({
        ...db, sourceId, sourceNamespace: sourceId, publishCommunity: false, maxSteps: 32,
        maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 55_000 }));
      if (delivered.state === 'idle' && delivered.reason === 'complete') { finished = true; break; }
    }
    expect(finished, 'native ordered-delivery ceiling').toBe(true);
    await invocation(costs, 'target_owner_proof', targetOrdinal, target, async db => {
      expect(await db.target.prepare(`SELECT revision,authority_epoch,state FROM analytics_owner_state
        WHERE source_id=? AND owner_digest=?`).bind(sourceId, owner!.ownerDigest).first())
        .toEqual({ revision: owner!.ownerRevision, authority_epoch: owner!.authorityEpoch, state: 'active' });
    });
  }
  return { owner: owner as Owner, days, selectedDay, scalarResumeDay };
}

async function prepareWindow(costs: Cost[], fixture: Awaited<ReturnType<typeof admitWindow>>) {
  const quota: EffectiveQuotaDay[] = [], modelUsage: EffectiveUsageDay[] = [];
  let fullFrameBytes = 0, compactProjectionBytes = 0, maximumFullDayBytes = 0, sourceUsageRows = 0, fragments = 0;
  for (const [ordinal, day] of fixture.days.entries()) {
    let completed = false;
    for (let attempt = 0; attempt < limits.featureAttempts; attempt++) {
      const result = await invocation(costs, 'native_feature_preparation', ordinal, candidate(), (db, meter) => sharedFeatures.advanceSharedAnalyticsFeatureDay({
        ...db, sourceId, sourceNamespace: sourceId, owner: fixture.owner, day,
        budget: { remainingQueries: () => meter.remainingQueries, now: Date.now, deadlineMs: Date.now() + 55_000 } }));
      if (result.state !== 'complete') { expect(result.state, 'native feature preparation refusal').toBe('deferred'); continue; }
      expect(validSharedAnalyticsFeatureDay(result.value)).toBe(true);
      const expectedRows = day === fixture.scalarResumeDay ? limits.scalarResumeRows : limits.usagePerDay;
      expect(result.value.scalarUsage).toHaveLength(expectedRows);
      expect(result.value.cacheEventsRead).toBe(expectedRows);
      expect(result.value.modelUsage.projection.usage.rowsRead).toBe(expectedRows);
      expect(result.value.quota.quotaRowsRead).toBe(13);
      expect(validEffectiveQuotaDay(result.value.quota)).toBe(true);
      expect(validEffectiveUsageDay(result.value.modelUsage)).toBe(true);
      const frameBytes = bytes({ kind: 'complete', value: result.value });
      expect(frameBytes).toBeLessThanOrEqual(SHARED_ANALYTICS_FEATURE_MAX_BYTES);
      await invocation(costs, 'frame_head_byte_proof', ordinal, candidate(), async db => {
        expect(await db.target.prepare(`SELECT payload_bytes FROM analytics_shared_feature_days
          WHERE source_id=? AND owner_digest=? AND day=? AND dependency_digest=? AND state='complete'`)
          .bind(sourceId, fixture.owner.ownerDigest, day, result.dependencyDigest).first<number>('payload_bytes')).toBe(frameBytes);
      });
      fullFrameBytes += frameBytes; maximumFullDayBytes = Math.max(maximumFullDayBytes, frameBytes);
      compactProjectionBytes += bytes({ quota: result.value.quota, modelUsage: result.value.modelUsage });
      sourceUsageRows += result.value.scalarUsage.length; fragments += result.value.quota.projection.fitFragments.fragments.length;
      quota.push(result.value.quota); modelUsage.push(result.value.modelUsage); completed = true; break;
    }
    expect(completed, 'native feature preparation attempt ceiling').toBe(true);
  }
  expect(quota.map(day => day.projection.day)).toEqual(fixture.days);
  expect(quota.reduce((n, day) => n + day.quotaRowsRead, 0)).toBe(limits.days * 13);
  expect(fragments).toBeGreaterThan(0); expect(fragments).toBeLessThanOrEqual(4096);
  expect(effectiveUsageWindowRepresentable(modelUsage)).toBe(true);
  expect(sourceUsageRows).toBe(20_401);
  expect(fullFrameBytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(compactProjectionBytes).toBeLessThan(8 * 1024 * 1024);
  return { fullFrameBytes, compactProjectionBytes, maximumFullDayBytes, sourceUsageRows, quotaRows: limits.days * 13,
    quotaFragments: fragments, modelWindowRepresentable: true, selectedDays: fixture.days.length,
    scalarResumeRows: limits.scalarResumeRows,
    byteContract: 'UTF8 canonicalJSON logical sizes of actual native complete frames/projections; not observed heap or physical wire.' };
}

async function graph(costs: Cost[], fixture: Awaited<ReturnType<typeof admitWindow>>, target: D1Database,
  metric: 'fits' | 'model', shared: boolean, usePlan = false) {
  const reasons: Record<string, number> = {};
  for (let turn = 0; turn < limits.graphPasses; turn++) {
    const result = await invocation(costs, `graph_${shared ? usePlan ? 'shared_plan' : 'shared_bulk_fallback' : 'native'}_${metric}`, turn, target, async (db, meter) => {
      const capture = () => captureStorageGraphScope(db.source, { owner: fixture.owner, day: fixture.selectedDay, metric,
        sourceId, sourceNamespace: sourceId, preparedFold: true });
      const scope = await (activeStatementAudit?.within('graph_scope', capture) ?? capture());
      expect(scope.source).toBe('effective');
      const compute = () => computeStorageGraphResult({ ...db, sourceId, sourceNamespace: sourceId }, scope,
        { maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 55_000,
          preparedFold: true, preparedEffectiveUsage: false, sharedFeatures: shared,
          ...(shared && !usePlan ? { boundedSharedWindow: false } : {}) });
      return activeStatementAudit?.within('graph_compute', compute) ?? compute();
    });
    if (result.state === 'complete') return { value: result.result, invocations: turn + 1, reasons };
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
    expect(result.failure).toBeUndefined();
  }
  throw new Error('BOUNDED_WINDOW_NATIVE_GRAPH_PROGRESS_CEILING');
}

it('admits the exact bounded-window401-row native day through separate950 chunk episodes', async ({ task }) => {
  const costs: Cost[] = [], receipt: Record<string, unknown> = { limits,
    boundary: 'Exact401-row admission and native day readiness only; not a shared-window or graph resource witness.' };
  try {
    receipt.laboratory = await initialize(costs);
    const today = date(Date.now()), selectedDay = date(Date.parse(`${today}T00:00:00.000Z`) - dayMs);
    const window = modelHistoryWindow(selectedDay), firstMs = Date.parse(`${window.fromDay}T00:00:00.000Z`);
    const ordinal = 50, day = date(firstMs + ordinal * dayMs);
    expect(day >= window.fromDay && day <= window.day).toBe(true);
    // Preserve the exact original401-day quota offset and prices. Earlier days
    // are built purely to calculate that offset, never admitted or substituted.
    const recordStart = performance.now();
    let usedPercent = 0;
    for (let previous = 0; previous < ordinal; previous++)
      usedPercent = acceptedRecords(date(firstMs + previous * dayMs), previous,
        limits.usagePerDay, firstMs, usedPercent).usedPercent;
    const records = acceptedRecords(day, ordinal, limits.scalarResumeRows, firstMs, usedPercent);
    receipt.recordPreparationMs = performance.now() - recordStart;
    expect(records.usage).toHaveLength(401); expect(records.quota).toHaveLength(13);
    expect(new Set(records.usage.map(row => row.eventId)).size).toBe(401);
    expect(new Set(records.quota.map(row => row.observationId)).size).toBe(13);
    const prepared = await makeV11Day(day, records, 'synthetic-bounded-shared-window');
    const chunks = prepared.chunks.map(chunk => ({ stream: chunk.chunkId.split(':')[0], rows: chunk.records.length }));
    expect(chunks).toEqual([{ stream: 'quota', rows: 13 }, { stream: 'usage', rows: 200 },
      { stream: 'usage', rows: 200 }, { stream: 'usage', rows: 1 }]);
    receipt.payload = { dayOrdinal: ordinal, quotaRows: 13, usageRows: 401, chunks,
      sourceScopeCount: 1, modelCount: 2, sessionCount: 2, insideSelectedWindow: true };
    const device = await invocation(costs, 'native_device', 0, candidate(), db => createV11DeviceFixture(db.source, { grant: true }));
    const ready = await stageDay(costs, device, day, ordinal, records);
    expect(ready).toMatchObject({ day, state: 'ready', expectedChunks: 4 });
    await invocation(costs, 'dense_native_membership_proof', ordinal, candidate(), async db => {
      const proof = await db.source.prepare(`SELECT c.stream,c.record_count,
        (SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id=c.id) typed_count,
        (SELECT state FROM device_upload_authorizations a WHERE a.id=c.device_upload_authorization_id) upload_state
        FROM telemetry_v11_chunks c WHERE c.manifest_id=? AND c.participant_id=? AND c.device_id=?
        ORDER BY c.stream,c.chunk_seq`).bind(ready.manifestId, device.participantId, device.deviceId).all();
      expect(proof.results).toEqual(chunks.map(chunk => ({ stream: chunk.stream, record_count: chunk.rows,
        typed_count: chunk.rows, upload_state: 'consumed' })));
      expect(await db.source.prepare(`SELECT count(*) n FROM typed_v11_record_admissions WHERE manifest_id=?`)
        .bind(ready.manifestId).first<number>('n')).toBe(414);
    });
    receipt.nativeAdmissionComplete = true;
  } finally {
    Object.assign(task.meta, { boundedSharedWindowDenseAdmission: { ...receipt, setup: aggregate(costs), setupCosts: costs,
      contract: 'Same original native day builder and stageDay path; actual950 per manifest/chunk/readiness episode; no producer, graph or window qualification.' } });
  }
}, 60_000);

it('retains a genuine101day full-bundle byte-limit witness with positive native scalar and model fallback', async ({ task }) => {
  const setupCosts: Cost[] = [], consumerCosts: Cost[] = [], receipt: Record<string, unknown> = { limits,
    boundary: 'Ordinary native feature-method resource witness, not canonical-method or whole-pipeline qualification.' };
  try {
    receipt.laboratory = await initialize(setupCosts);
    const fixture = await admitWindow(setupCosts);
    receipt.frames = await prepareWindow(setupCosts, fixture);
    const bulk = await invocation(consumerCosts, 'unchanged_bulk_resource_witness', 0, candidate(), (db, meter) =>
      sharedFeatures.readSharedAnalyticsFeatureWindow({ ...db, sourceId, sourceNamespace: sourceId, owner: fixture.owner,
        days: fixture.days, budget: { remainingQueries: () => meter.remainingQueries, now: Date.now, deadlineMs: Date.now() + 55_000 } }));
    expect(bulk).toEqual({ state: 'refused', reason: 'window_byte_limit' });
    receipt.bulkWitness = bulk;
    const consumerWindows: { state: string; reason: string | null }[] = [];
    const original = sharedFeatures.readSharedAnalyticsFeatureWindow;
    const spy = vi.spyOn(sharedFeatures, 'readSharedAnalyticsFeatureWindow').mockImplementation(async input => {
      const result = await original(input);
      consumerWindows.push({ state: result.state, reason: 'reason' in result ? result.reason : null });
      return result;
    });
    try {
      for (const metric of ['fits', 'model'] as const) {
        const native = await graph(consumerCosts, fixture, reference(), metric, false);
        const shared = await graph(consumerCosts, fixture, candidate(), metric, true);
        expect(shared.value.scope.pin.fingerprint).toBe(native.value.scope.pin.fingerprint);
        expect(shared.value.fits).toEqual(native.value.fits);
        expect(shared.value.composition).toEqual(native.value.composition);
        if (metric === 'fits') expect(native.value.fits!.length).toBeGreaterThan(0);
        else {
          expect(native.value.composition).toMatchObject({ status: 'ready', fit: { status: 'fitted' },
            unpricedUsageEventCount: 0, poisonedBinCount: 0 });
          if (native.value.composition?.status === 'ready') {
            expect(native.value.composition.usageEventCount).toBeGreaterThan(0);
            const capacity = native.value.composition.fit.capacityUsdByModel;
            const namedModels = Object.keys(MODEL_HISTORY_TEST_CAPACITIES);
            expect(Object.keys(capacity!).sort()).toEqual([...namedModels, MODEL_COMPOSITION_POLICY.otherModelKey].sort());
            expect(capacity![MODEL_COMPOSITION_POLICY.otherModelKey]).toBeNull();
            for (const model of namedModels) {
              expect(Number.isFinite(capacity![model])).toBe(true);
              expect(capacity![model]).toBeGreaterThan(0);
            }
          }
        }
        receipt[metric] = { native: { invocations: native.invocations, reasons: native.reasons },
          sharedBulkFallback: { invocations: shared.invocations, reasons: shared.reasons }, exactResultParity: true,
          ...(metric === 'model' && native.value.composition?.status === 'ready'
            ? { capacityUsdByModel: native.value.composition.fit.capacityUsdByModel } : {}) };
      }
    } finally { spy.mockRestore(); receipt.actualConsumerWindowOutcomes = consumerWindows; }
    expect(consumerWindows.length).toBeGreaterThan(0);
    expect(consumerWindows.every(result => result.state === 'refused' && result.reason === 'window_byte_limit')).toBe(true);
  } finally {
    Object.assign(task.meta, { boundedSharedWindowBaseline: { ...receipt, setup: aggregate(setupCosts),
      consumers: aggregate(consumerCosts), setupCosts, consumerCosts,
      resourceContract: 'Every native operation and diagnostic proof is included in a real950 invocation; no CPU/truepeak isolate measurement.' } });
  }
}, 900_000);

it('uses a bounded default101day plan with401-row resume and exact positive native scalar/model outputs',async({task})=>{
  const setupCosts:Cost[]=[],consumerCosts:Cost[]=[],receipt:Record<string,unknown>={limits,
    boundary:'Genuine accepted ordinary native feature method; bounded graph default versus fully native scalar/model. Not canonical-method, CPU/heap or whole-pipeline qualification.'};
  const statementAudit = createSharedWindowStatementAudit();
  activeStatementAudit = statementAudit;
  try{
    receipt.laboratory=await initialize(setupCosts);
    const fixture=await admitWindow(setupCosts);
    receipt.frames=await prepareWindow(setupCosts,fixture);
    // The public bulk API still rejects exactly the same genuine18MiB window.
    const bulk=await invocation(consumerCosts,'unchanged_bulk_resource_witness',0,candidate(),(db,meter)=>
      sharedFeatures.readSharedAnalyticsFeatureWindow({...db,sourceId,sourceNamespace:sourceId,owner:fixture.owner,
        days:fixture.days,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+55_000}}));
    expect(bulk).toEqual({state:'refused',reason:'window_byte_limit'});receipt.bulkWitness=bulk;
    const probe=await invocation(consumerCosts,'bounded_plan401_scope',0,candidate(),async(db,meter)=>{
      const selected=modelHistoryWindow(fixture.selectedDay);
      const result=await sharedFeatures.readSharedAnalyticsFeatureWindowPlan({...db,sourceId,sourceNamespace:sourceId,
        owner:fixture.owner,days:fixture.days,fromDay:selected.fromDay,throughDay:selected.day,metric:'model',
        budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+55_000}});
      expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('BOUNDED_PLAN_NATIVE_FIXTURE_REFUSED');
      const plan=result.plan,pageSizes:number[]=[];
      try{
        const quota=await plan.loadQuota(fixture.days),models=await plan.loadModelUsage(fixture.days);
        expect(quota.reduce((n,value)=>n+value.quotaRowsRead,0)).toBe(limits.days*13);
        expect(models.reduce((n,value)=>n+value.projection.usage.rowsRead,0)).toBe(20_401);
        expect(effectiveUsageWindowRepresentable(models)).toBe(true);
        const day=fixture.days[50]!;
        expect(day>=selected.fromDay&&day<=selected.day).toBe(true);
        let afterTime=`${day}T00:00:00.000Z`,afterOccurrence='',complete=false;
        for(const expected of [200,200,1]){
          const page=await plan.usageReader.readPage({day,afterTime,afterOccurrence});
          expect(page.state).toBe('ready');if(page.state!=='ready')throw Error('BOUNDED_PLAN_NATIVE_PAGE_DEFERRED');
          pageSizes.push(page.rows.length);expect(page.rows).toHaveLength(expected);
          const last=page.rows.at(-1)!;afterTime=new Date(last.observedAtMs).toISOString();afterOccurrence=last.occurrenceId;
          complete=page.complete;
        }
        expect(complete).toBe(true);expect(await plan.seal()).toEqual({state:'current'});
        const logical=plan.logicalBytes();expect(logical.compactBytes).toBeLessThanOrEqual(8*1024*1024);
        expect(logical.fullDayBytes).toBeGreaterThan(0);expect(logical.fullDayBytes).toBeLessThanOrEqual(4*1024*1024);
        expect(logical.maximumRetainedBytes).toBeLessThanOrEqual(12*1024*1024);
        return {pageSizes,logical,sourceUsageRows:20_401,quotaRows:limits.days*13};
      }finally{plan.close();expect(plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});}
    });
    receipt.planProbe=probe;
    const planStates:Record<string,number>={},logical:ReturnType<sharedFeatures.SharedAnalyticsFeatureWindowPlan['logicalBytes']>[]=[];
    let accepted=0,closed=0;
    const originalPlan=sharedFeatures.readSharedAnalyticsFeatureWindowPlan;
    const planSpy=vi.spyOn(sharedFeatures,'readSharedAnalyticsFeatureWindowPlan').mockImplementation(async input=>{
      const result=await statementAudit.within('plan_acquire',()=>originalPlan(input)),key=result.state+('reason'in result?`/${result.reason}`:'');
      planStates[key]=(planStates[key]??0)+1;
      // An admission/refusal fallback would fail this positive, not masquerade
      // as a successful native result under the shared label.
      expect(result.state).toBe('complete');
      if(result.state==='complete'){
        statementAudit.instrumentPlan(result.plan);
        accepted++;const close=result.plan.close;
        result.plan.close=()=>{logical.push(result.plan.logicalBytes());close();closed++;
          expect(result.plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});};
      }
      return result;
    });
    const bulkSpy=vi.spyOn(sharedFeatures,'readSharedAnalyticsFeatureWindow');
    try{
      for(const metric of ['fits','model'] as const){
        const native=await graph(consumerCosts,fixture,reference(),metric,false);
        // Product boundedSharedWindow option is OMITTED: prove its default.
        const bounded=await graph(consumerCosts,fixture,candidate(),metric,true,true);
        expect(bounded.value.scope.pin.fingerprint).toBe(native.value.scope.pin.fingerprint);
        expect(bounded.value.fits).toEqual(native.value.fits);expect(bounded.value.composition).toEqual(native.value.composition);
        if(metric==='fits')expect(native.value.fits!.length).toBeGreaterThan(0);
        else{
          expect(native.value.composition).toMatchObject({status:'ready',fit:{status:'fitted'},unpricedUsageEventCount:0,poisonedBinCount:0});
          if(native.value.composition?.status!=='ready')throw Error('BOUNDED_PLAN_NATIVE_MODEL_NOT_READY');
          expect(native.value.composition.usageEventCount).toBeGreaterThan(0);
          const capacity=native.value.composition.fit.capacityUsdByModel!,named=Object.keys(MODEL_HISTORY_TEST_CAPACITIES);
          expect(Object.keys(capacity).sort()).toEqual([...named,MODEL_COMPOSITION_POLICY.otherModelKey].sort());
          expect(capacity[MODEL_COMPOSITION_POLICY.otherModelKey]).toBeNull();
          for(const model of named){expect(Number.isFinite(capacity[model])).toBe(true);expect(capacity[model]).toBeGreaterThan(0);}
        }
        receipt[metric]={native:{invocations:native.invocations,reasons:native.reasons},
          bounded:{invocations:bounded.invocations,reasons:bounded.reasons},exactResultParity:true,
          ...(metric==='model'&&native.value.composition?.status==='ready'?{capacityUsdByModel:native.value.composition.fit.capacityUsdByModel}:{})};
      }
      expect(accepted).toBeGreaterThan(0);expect(closed).toBe(accepted);expect(bulkSpy).not.toHaveBeenCalled();
      expect(Object.keys(planStates)).toEqual(['complete']);
      expect(logical.every(value=>value.compactBytes<=8*1024*1024&&value.maximumFullDayBytes<=4*1024*1024
        &&value.maximumRetainedBytes<=12*1024*1024)).toBe(true);
      receipt.defaultConsumer={planStates,accepted,closed,bulkCalls:bulkSpy.mock.calls.length,logical};
    }finally{bulkSpy.mockRestore();planSpy.mockRestore();}
    receipt.statementCharges = await statementAudit.evidence();
    receipt.queryPlans = await statementAudit.explain();
  }finally{activeStatementAudit = undefined; statementAudit.close(); Object.assign(task.meta,{boundedSharedWindowPlan:{...receipt,setup:aggregate(setupCosts),
    consumers:aggregate(consumerCosts),setupCosts,consumerCosts,
    resourceContract:'Real950 invocations for setup/probe/graph/finish/save; canonicalJSON retained-byte upper bound, not measured isolate peak.'}});}
},900_000);
