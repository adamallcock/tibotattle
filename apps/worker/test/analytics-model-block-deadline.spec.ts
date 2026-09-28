import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { advanceAnalyticsModelBlock, readAnalyticsModelBlock } from '../src/analytics-model-block';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { readModelBlockJob } from '../src/storage-analytics-model-block';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { captureStorageGraphScope, computeStorageGraphResult } from '../src/storage-community-graph';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database; STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const bindings = env as Bindings;
const sourceId = 'synthetic-dense-model-deadline', sourceNamespace = sourceId;
const source = () => bindings.USAGE_MONITOR_DB;
const target = () => bindings.STORAGE_ANALYTICS_DB;
const referenceTarget = () => bindings.STORAGE_INGESTION_A;
const virtualMsPerStatement = 50;

function analytical(value: object): object {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.inputFingerprint;
  return copy;
}

it('resumes a fully occupied 130-day model window under the default deadline', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 130, graphDays: 2,
    denseDays: true, denseUsageRows: 220 });
  const [firstDay, secondDay] = corpus.graphDates;
  expect(corpus.populatedDates).toHaveLength(130);
  expect(await source().prepare(`SELECT COUNT(*) AS count FROM telemetry_v12_records r
    JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id
    WHERE m.chunk_day=? AND r.stream='usage'`).bind(firstDay).first<number>('count'))
    .toBeGreaterThan(200);

  const profile = createAnalyticsProfile();
  const baseMs = Date.now();
  let sawDeadline = false, cancelled = false;
  let invocations = 0, totalStatements = 0, maximumStatements = 0, deadlineYields = 0;
  let lastMarker = '', repeatedMarker = 0;
  let completed: Awaited<ReturnType<typeof advanceAnalyticsModelBlock>> | null = null;
  const advance = async (signal?: AbortSignal, onTime?: () => void) => {
    const before = summarizeAnalyticsProfile(profile).statements;
    const measuredSource = profileAnalyticsDatabase(source(), 'source', profile, () => 'dense-deadline');
    const measuredTarget = profileAnalyticsDatabase(target(), 'target', profile, () => 'dense-deadline');
    // One D1 statement advances the synthetic clock by 50 ms. This injects
    // elapsed operation time without sleeping or enlarging the 20 s default.
    const now = () => {
      onTime?.();
      return baseMs + summarizeAnalyticsProfile(profile).statements * virtualMsPerStatement;
    };
    const result = await advanceAnalyticsModelBlock({ source: measuredSource, target: measuredTarget,
      sourceId, sourceNamespace, owner: corpus.owner, outputFromDay: firstDay!,
      outputThroughDay: secondDay!, maxQueries: 950, now, ...(signal ? { signal } : {}) });
    const count = summarizeAnalyticsProfile(profile).statements - before;
    invocations++;
    totalStatements += count;
    maximumStatements = Math.max(maximumStatements, count);
    if (result.reason === 'deadline') deadlineYields++;
    expect(result.queriesUsed).toBe(count);
    expect(count).toBeLessThanOrEqual(950);
    expect(summarizeAnalyticsProfile(profile).measurementFailures).toBe(0);
    return result;
  };

  for (let attempt = 0; attempt < 36; attempt++) {
    const result = await advance();
    if (result.reason === 'deadline') sawDeadline = true;
    expect(result.identity).not.toBeNull();
    if (result.status === 'complete') { completed = result; break; }
    expect(result.status).toBe('deferred');
    const stored = await readModelBlockJob({ target: target(), identity: result.identity! });
    expect(stored).not.toBeNull();
    const checkpoint = stored!.checkpoint;
    const marker = JSON.stringify({ phase: checkpoint.phase,
      selected: checkpoint.dependencies.length, acquired: checkpoint.inputIndex,
      pendingStream: checkpoint.pending?.stream ?? null,
      quotaRows: checkpoint.pending?.quota.quotaRowsRead ?? 0,
      usageRows: checkpoint.pending?.usage.projection.usage.rowsRead ?? 0,
      outputs: checkpoint.outputs.length });
    repeatedMarker = marker === lastMarker ? repeatedMarker + 1 : 0;
    lastMarker = marker;
    expect(repeatedMarker, `dense model job made no durable progress: ${marker}; reason=${result.reason}`)
      .toBeLessThan(3);
    expect(await readAnalyticsModelBlock({ source: source(), target: target(),
      identity: result.identity!, owner: corpus.owner })).toBeNull();

    if (!cancelled && checkpoint.dependencies.length > 0) {
      // Cancel after actual statements in a fresh invocation, then retry from
      // whichever valid prefix the cancellation saved.
      const controller = new AbortController();
      const beforeAbort = summarizeAnalyticsProfile(profile).statements;
      const aborted = await advance(controller.signal, () => {
        if (summarizeAnalyticsProfile(profile).statements - beforeAbort >= 30) controller.abort();
      });
      expect(aborted.status).toBe('deferred');
      expect(aborted.reason).toBe('cancelled');
      expect(controller.signal.aborted).toBe(true);
      expect(aborted.identity).toEqual(result.identity);
      expect(await readModelBlockJob({ target: target(), identity: result.identity! })).not.toBeNull();
      expect(await readAnalyticsModelBlock({ source: source(), target: target(),
        identity: result.identity!, owner: corpus.owner })).toBeNull();
      cancelled = true;
    }
  }
  expect(completed, `dense model job did not complete; last checkpoint ${lastMarker}`).not.toBeNull();
  expect(sawDeadline).toBe(true);
  expect(cancelled).toBe(true);
  const outputs = await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: completed!.identity!, owner: corpus.owner });
  expect(outputs).toEqual(completed!.outputs);
  expect(outputs).toHaveLength(2);
  expect(outputs!.every(output => output.value.status === 'ready'),
    `dense statuses: ${outputs!.map(output => output.value.status === 'ready'
      ? 'ready' : `${output.value.status}:${output.value.reason}`).join(',')}`).toBe(true);
  console.log('dense-model-deadline', JSON.stringify({ invocations, totalStatements,
    maximumStatements, deadlineYields, modelDates: outputs!.length }));

  // Independent current graph calculations use a separate analytics target.
  await applyD1Migrations(referenceTarget(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({ source: source(), target: referenceTarget(), sourceId, sourceNamespace });
  await referenceTarget().prepare(`INSERT INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
    .bind(sourceId, corpus.owner.ownerDigest, corpus.owner.ownerRevision,
      corpus.owner.authorityEpoch, 'active').run();
  for (const output of outputs!) {
    let matched = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const meter = createD1InvocationBudget(950);
      const scopedSource = meter.wrap(source()), scopedTarget = meter.wrap(referenceTarget());
      const scope = await captureStorageGraphScope(scopedSource, { owner: corpus.owner,
        day: output.day, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
      expect(scope.source).toBe('effective');
      const reference = await computeStorageGraphResult({ source: scopedSource, target: scopedTarget,
        sourceId, sourceNamespace }, scope,
      { maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 60_000, preparedFold: true });
      expect(meter.queriesUsed).toBeLessThanOrEqual(950);
      if (reference.state === 'complete') {
        expect(reference.result.composition).toBeDefined();
        expect(analytical(output.value)).toEqual(analytical(reference.result.composition!));
        matched = true;
        break;
      }
      expect(reference.failure).toBeUndefined();
    }
    expect(matched, `dense reference did not complete for ${output.day}`).toBe(true);
  }
}, 300_000);
