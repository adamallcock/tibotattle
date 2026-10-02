import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { eraseParticipantAsOwner } from '../src/participant-erasure';
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult,
  type StorageGraphScope } from '../src/storage-community-graph';
import { publishStorageCommunityGraphPreview, publishStorageCommunityModelDay,
  readPublishedStorageCommunityGraph, retireStorageCommunityGraphPublications }
  from '../src/storage-community-graph-publication';
import { readStorageCommunityOwnerPage, type StorageCommunityOwner } from '../src/storage-community-authority';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { advanceStorageErasureJobs } from '../src/storage-erasure';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus }
  from './fixtures/shared-analytics-corpus';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database; STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] };
type Owner = StorageCommunityOwner & { ownerDigest: string };
const b = env as Bindings;
const source = () => b.USAGE_MONITOR_DB, candidate = () => b.STORAGE_ANALYTICS_DB,
  reference = () => b.STORAGE_INGESTION_A;
const sourceId = 'synthetic-shared-feature-graph', sourceNamespace = sourceId;
const bindings = (target: D1Database) => ({ source: source(), target, sourceId, sourceNamespace });

function tracing(database: D1Database, onPrepare: (sql: string) => void): D1Database {
  return new Proxy(database, { get(db, key) {
    if (key === 'prepare') return (sql: string) => { onPrepare(sql); return db.prepare(sql); };
    const value = Reflect.get(db, key);
    return typeof value === 'function' ? value.bind(db) : value;
  } });
}

async function compute(target: D1Database, owner: Owner, day: string, metric: 'fits' | 'model',
  sharedFeatures: boolean) {
  let rawUsageReads = 0, inventoryReads = 0, sharedPartReads = 0, invocations = 0;
  let statements = 0, maxStatements = 0;
  const started = performance.now();
  let lastScope: StorageGraphScope | null = null;
  for (; invocations < 180; invocations++) {
    let rawThisCall = 0, inventoryThisCall = 0, partsThisCall = 0;
    const measuredSource = tracing(source(), sql => {
      if (sql.includes('selected_window(stream_code,from_ms,through_ms)')) {
        if (sql.includes('SELECT DISTINCT observed_day FROM direct')) inventoryThisCall++;
        else rawThisCall++;
      }
    });
    const measuredTarget = tracing(target, sql => {
      if (sql.includes('FROM analytics_shared_feature_parts p')) partsThisCall++;
    });
    const meter = createD1InvocationBudget(950);
    const scoped = { source: meter.wrap(measuredSource), target: meter.wrap(measuredTarget),
      sourceId, sourceNamespace };
    const scope = await captureStorageGraphScope(scoped.source,
      { owner, day, metric, sourceId, sourceNamespace, preparedFold: true });
    expect(scope.source).toBe(owner.hasEffective ? 'effective' : scope.source);
    // Keep the full invocation in the counters, including exact scope capture.
    // The finisher delta remains a separate assertion about fallback behavior.
    const scopeRawReads = rawThisCall;
    const result = await computeStorageGraphResult(scoped, scope, { maxQueries: meter.remainingQueries,
      deadlineMs: Date.now() + 55_000, preparedFold: true, preparedEffectiveUsage: false,
      ...(sharedFeatures ? { sharedFeatures: true } : {}) });
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    rawUsageReads += rawThisCall; inventoryReads += inventoryThisCall;
    sharedPartReads += partsThisCall;
    statements += meter.queriesUsed;
    maxStatements = Math.max(maxStatements, meter.queriesUsed);
    lastScope = scope;
    if (result.state === 'complete') {
      if (sharedFeatures && !result.reused) {
        // A completed feature-backed window must reach the prepared graph
        // kernel. A hidden native fallback rereads the source candidate SQL.
        expect(rawThisCall - scopeRawReads).toBe(0);
        expect(partsThisCall).toBeGreaterThan(0);
      }
      return { result, scope, invocations: invocations + 1, rawUsageReads, inventoryReads,
        sharedPartReads, statements, maxStatements, wallMs: Math.round(performance.now() - started) };
    }
    expect(result.failure).toBeUndefined();
  }
  throw new Error(`shared graph did not finish: ${metric}:${day}:${sharedFeatures}:${lastScope?.source}`);
}

async function publication(target: D1Database, modelDay: string, nowMs: number) {
  const model = await publishStorageCommunityModelDay(bindings(target), { day: modelDay });
  expect(['published', 'unchanged']).toContain(model.state);
  const preview = await publishStorageCommunityGraphPreview(bindings(target), { nowMs });
  expect(['published', 'unchanged']).toContain(preview.state);
  const modelPayload = await target.prepare(`SELECT payload_json FROM analytics_community_model_publications
    WHERE source_id=? AND day=?`).bind(sourceId, modelDay).first<string>('payload_json');
  const previewPayload = (await readPublishedStorageCommunityGraph(bindings(target), nowMs))?.payload_json;
  expect(modelPayload).toBeTruthy();
  expect(previewPayload).toBeTruthy();
  return { modelPayload, previewPayload };
}

it('matches native scalar and model publication while shared feature days survive replay and correction', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), candidate(), b, sourceId, sourceNamespace);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await applyD1Migrations(reference(), b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime(bindings(reference()));
  const nowMs = Date.now() + 60_000, today = new Date(nowMs).toISOString().slice(0, 10);
  const corpus = await seedSharedAnalyticsCorpus({ ...bindings(candidate()), anchorDay: today,
    calendarDays: 103, graphDays: 2, correctionAffectsModelFit: true });
  const [modelDay, fitsDay] = corpus.graphDates;
  const owners = (await readStorageCommunityOwnerPage(source())).filter(
    (owner): owner is Owner => typeof owner.ownerDigest === 'string');
  expect(owners).toHaveLength(2);
  for (const target of [candidate(), reference()]) for (const owner of owners)
    await target.prepare(`INSERT OR REPLACE INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
      .bind(sourceId, owner.ownerDigest, owner.ownerRevision, owner.authorityEpoch, 'active').run();
  const primary = owners.find(owner => owner.participantId === corpus.participantId)!;
  const other = owners.find(owner => owner.participantId !== corpus.participantId)!;
  let firstModelPayload: string | null = null;
  for (const phase of ['cold', 'warm', 'correction'] as const) {
    const current = phase === 'correction' ? await corpus.mutateCorrection() : primary;
    if (phase === 'correction') await reference().prepare(`UPDATE analytics_owner_state
      SET revision=?,authority_epoch=? WHERE source_id=? AND owner_digest=? AND state='active'`)
      .bind(current.ownerRevision, current.authorityEpoch, sourceId, current.ownerDigest).run();
    for (const [day, metric] of [[modelDay!, 'model'], [fitsDay!, 'fits']] as const) {
      const native = await compute(reference(), current, day, metric, false);
      const shared = await compute(candidate(), current, day, metric, true);
      console.log('shared-feature-graph-phase', JSON.stringify({phase,metric,
        shared: {invocations:shared.invocations,statements:shared.statements,
          maxStatements:shared.maxStatements,wallMs:shared.wallMs,
          rawUsageReads:shared.rawUsageReads,inventoryReads:shared.inventoryReads,
          sharedPartReads:shared.sharedPartReads},
        native:{invocations:native.invocations,statements:native.statements,
          maxStatements:native.maxStatements,wallMs:native.wallMs}}));
      expect(shared.scope.pin.fingerprint).toBe(native.scope.pin.fingerprint);
      expect(shared.result.result.fits).toEqual(native.result.result.fits);
      expect(shared.result.result.composition).toEqual(native.result.result.composition);
      if (phase === 'warm') expect(shared.result.reused).toBe(true);
      if (phase === 'cold' || phase === 'correction') {
        expect(shared.result.reused).toBe(false);
        expect(shared.sharedPartReads).toBeGreaterThan(0);
      }
      if (phase === 'cold') expect(shared.invocations).toBeLessThanOrEqual(30);
      expect(metric === 'model' ? shared.result.result.composition : shared.result.result.fits).toBeTruthy();
    }
    for (const target of [reference(), candidate()]) {
      await compute(target, other, modelDay!, 'model', false);
      await compute(target, other, fitsDay!, 'fits', false);
    }
    const nativePublication = await publication(reference(), modelDay!, nowMs);
    const sharedPublication = await publication(candidate(), modelDay!, nowMs);
    expect(sharedPublication).toEqual(nativePublication);
    if (phase === 'cold') firstModelPayload = sharedPublication.modelPayload!;
    if (phase === 'correction') expect(sharedPublication.modelPayload).not.toBe(firstModelPayload);
  }

  const runtime = { ...b, USAGE_MONITOR_DB: source(), ENVIRONMENT: 'synthetic-development',
    ACCOUNT_SCOPED_INGEST_MODE: 'disabled' } as Env;
  Reflect.set(runtime, 'TELEMETRY_STORAGE_MODE', 'typed');
  Reflect.set(runtime, 'TELEMETRY_STORAGE_NAMESPACE', sourceNamespace);
  Reflect.set(runtime, 'ANALYTICS_DB', candidate());
  try {
    expect(await eraseParticipantAsOwner(runtime, 'e'.repeat(64), corpus.participantId))
      .toMatchObject({ deleted: true });
  } catch (error) {
    expect(error).toMatchObject({code: 'BACKEND_STORAGE_UNAVAILABLE'});
    let pending = true;
    for (let attempt = 0; attempt < 80 && pending; attempt++)
      pending = (await advanceStorageErasureJobs({...bindings(candidate()),ledger:b.DELETION_LEDGER})).pending;
    expect(pending).toBe(false);
    expect(await eraseParticipantAsOwner(runtime, 'e'.repeat(64), corpus.participantId))
      .toMatchObject({ deleted: true });
  }
  expect(await candidate().prepare(`SELECT count(*) AS n FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=?`).bind(sourceId, primary.ownerDigest).first<number>('n')).toBe(0);
  expect(await candidate().prepare(`SELECT count(*) AS n FROM analytics_shared_feature_parts
    WHERE source_id=? AND owner_digest=?`).bind(sourceId, primary.ownerDigest).first<number>('n')).toBe(0);
  for (const target of [candidate(), reference()]) {
    expect(await readPublishedStorageCommunityGraph(bindings(target), nowMs)).toBeNull();
    for (let attempt = 0; attempt < 32; attempt++)
      if (await retireStorageCommunityGraphPublications(bindings(target), nowMs) === 0) break;
    expect(await readStorageGraphResult(bindings(target), await captureStorageGraphScope(source(),
      { owner: other, day: modelDay!, metric: 'model', sourceId, sourceNamespace,
        preparedFold: true }))).not.toBeNull();
  }
  const afterReference = await publication(reference(), modelDay!, nowMs);
  const afterCandidate = await publication(candidate(), modelDay!, nowMs);
  expect(afterCandidate).toEqual(afterReference);
  expect(afterCandidate.modelPayload).not.toBe(firstModelPayload);
}, 300_000);
