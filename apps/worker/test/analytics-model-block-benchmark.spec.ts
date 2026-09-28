import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { advanceAnalyticsModelBlock, readAnalyticsModelBlock } from '../src/analytics-model-block';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { captureStorageGraphScope, computeStorageGraphResult } from '../src/storage-community-graph';
import type { StorageCommunityOwner } from '../src/storage-community-authority';
import type { ModelBlockOutput } from '../src/analytics-model-block-contract';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database; STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
type Owner = StorageCommunityOwner & { ownerDigest: string };
const bindings = env as Bindings, sourceId = 'synthetic-durable-model-benchmark', sourceNamespace = sourceId;
const source = () => bindings.USAGE_MONITOR_DB, target = () => bindings.STORAGE_ANALYTICS_DB;
// This binding is an empty disposable D1 in Vitest. It receives analytics
// migrations only, keeping the reference's caches independent of the candidate.
const referenceTarget = () => bindings.STORAGE_INGESTION_A;
const mode = (import.meta as ImportMeta & { env?: { VITE_SHARED_ANALYTICS_BENCHMARK?: string } })
  .env?.VITE_SHARED_ANALYTICS_BENCHMARK === 'full' ? 'full' : 'small';
const configuration = mode === 'full' ? { calendarDays: 130, graphDays: 30 } : { calendarDays: 14, graphDays: 2 };
const dense = (import.meta as ImportMeta & { env?: { VITE_MODEL_BLOCK_DENSITY?: string } })
  .env?.VITE_MODEL_BLOCK_DENSITY === 'dense';

function analytical(outputs: readonly ModelBlockOutput[]) {
  return outputs.map(({ day, fingerprint, value }) => {
    const fields = { ...value } as Record<string, unknown>;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    if (fields.status === 'ready') expect(fields.inputFingerprint).toBe(fingerprint);
    delete fields.inputFingerprint;
    return { day, value: fields };
  });
}
async function outputSummary(outputs: readonly ModelBlockOutput[]) {
  return { completedModelDates: outputs.length,
    ready: outputs.filter(output => output.value.status === 'ready').length,
    analyticalSha256: await sha256Hex(canonicalJson(analytical(outputs))) };
}

async function runReference(owner: Owner, days: readonly string[]) {
  const profile = createAnalyticsProfile(), started = performance.now();
  const observedSource = profileAnalyticsDatabase(source(), 'source', profile, () => 'model');
  const observedTarget = profileAnalyticsDatabase(referenceTarget(), 'target', profile, () => 'model');
  const outputs: ModelBlockOutput[] = [];
  for (const day of days) {
    let complete = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const meter = createD1InvocationBudget(950), measuredSource = meter.wrap(observedSource);
      const measuredTarget = meter.wrap(observedTarget);
      const before = summarizeAnalyticsProfile(profile).statements;
      const scope = await captureStorageGraphScope(measuredSource,
        { owner, day, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
      expect(scope.source).toBe('effective');
      const result = await computeStorageGraphResult({ source: measuredSource, target: measuredTarget, sourceId, sourceNamespace },
        scope, { maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 60_000, preparedFold: true });
      expect(summarizeAnalyticsProfile(profile).statements - before).toBe(meter.queriesUsed);
      expect(meter.queriesUsed).toBeLessThanOrEqual(950);
      profile.invocations++;
      profile.maximumStatementsPerInvocation = Math.max(profile.maximumStatementsPerInvocation, meter.queriesUsed);
      if (result.state === 'complete') {
        if (!result.result.composition) throw new Error('model block reference composition absent');
        outputs.push({ day, fingerprint: scope.pin.fingerprint, value: result.result.composition });
        complete = true; break;
      }
      expect(result.failure).toBeUndefined();
    }
    if (!complete) throw new Error('model block reference exceeded bounded attempts');
  }
  profile.wallMs = performance.now() - started;
  return { profile: summarizeAnalyticsProfile(profile), outputs };
}

async function runBlock(owner: Owner, days: readonly string[]) {
  const profile = createAnalyticsProfile(), started = performance.now();
  const observedSource = profileAnalyticsDatabase(source(), 'source', profile, () => 'model');
  const observedTarget = profileAnalyticsDatabase(target(), 'target', profile, () => 'model');
  const invocations: { statements: number; preparedDays: number; reusedDays: number; emptyDays: number;
    sourcePages: number; completedDates: number; status: string; reason?: string }[] = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    const before = summarizeAnalyticsProfile(profile).statements;
    const result = await advanceAnalyticsModelBlock({ source: observedSource, target: observedTarget,
      sourceId, sourceNamespace, owner, outputFromDay: days[0]!, outputThroughDay: days.at(-1)!,
      maxQueries: 950, ...(dense ? {} : { deadlineMs: Date.now() + 60_000 }) });
    expect(summarizeAnalyticsProfile(profile).statements - before).toBe(result.queriesUsed);
    expect(result.queriesUsed).toBeLessThanOrEqual(950);
    profile.invocations++;
    profile.maximumStatementsPerInvocation = Math.max(profile.maximumStatementsPerInvocation, result.queriesUsed);
    invocations.push({ statements: result.queriesUsed, preparedDays: result.preparedDays, reusedDays: result.reusedDays,
      emptyDays: result.emptyDays,
      sourcePages: result.sourcePages, completedDates: result.modelDatesCompleted, status: result.status,
      ...(result.reason ? { reason: result.reason } : {}) });
    if (result.status === 'complete') {
      // Include the final process-independent visibility proof in total cost;
      // it is a separate read invocation, also below the cap.
      const beforeRead = summarizeAnalyticsProfile(profile).statements;
      const visible = await readAnalyticsModelBlock({ source: observedSource, target: observedTarget,
        identity: result.identity!, owner });
      const readStatements = summarizeAnalyticsProfile(profile).statements - beforeRead;
      expect(readStatements).toBeLessThanOrEqual(950);
      expect(visible).toEqual(result.outputs);
      profile.invocations++;
      profile.maximumStatementsPerInvocation = Math.max(profile.maximumStatementsPerInvocation, readStatements);
      profile.wallMs = performance.now() - started;
      return { profile: summarizeAnalyticsProfile(profile), invocations, visibilityReadStatements: readStatements,
        outputs: result.outputs! };
    }
    expect(result.status).toBe('deferred');
  }
  throw new Error('model block candidate exceeded bounded attempts');
}

it('measures durable model-date blocks against independent current graph jobs with exact ready outputs', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(), sourceId, sourceNamespace,
    ...configuration, ...(dense ? { denseDays: true, denseUsageRows: 401 } : {}) });
  await applyD1Migrations(referenceTarget(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({ source: source(), target: referenceTarget(), sourceId, sourceNamespace });
  await referenceTarget().prepare(`INSERT INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
    .bind(sourceId, corpus.owner.ownerDigest, corpus.owner.ownerRevision, corpus.owner.authorityEpoch, 'active').run();
  let owner = corpus.owner;
  const phases: Record<string, unknown> = {};
  for (const phase of ['cold', 'replay', 'correction'] as const) {
    if (phase === 'correction') {
      owner = await corpus.mutateCorrection();
      await referenceTarget().prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
        WHERE source_id=? AND owner_digest=?`).bind(owner.ownerRevision, owner.authorityEpoch, sourceId, owner.ownerDigest).run();
    }
    const reference = await runReference(owner, corpus.graphDates);
    const candidate = await runBlock(owner, corpus.graphDates);
    expect(analytical(candidate.outputs)).toEqual(analytical(reference.outputs));
    expect(candidate.outputs).toHaveLength(configuration.graphDays);
    expect(candidate.outputs.every(output => output.value.status === 'ready')).toBe(true);
    expect(reference.profile.failedStatements).toBe(0);
    expect(candidate.profile.failedStatements).toBe(0);
    expect(candidate.profile.metadataSamples).toBe(candidate.profile.statements);
    phases[phase] = { reference: reference.profile, candidate: candidate.profile,
      candidateInvocations: candidate.invocations, visibilityReadStatements: candidate.visibilityReadStatements,
      output: await outputSummary(candidate.outputs) };
  }
  console.log('model-block-benchmark', JSON.stringify({ schemaVersion: 'model-block-benchmark-v1', mode,
    corpus: { calendarDays: configuration.calendarDays, modelDates: configuration.graphDays,
      density: dense ? 'dense' : 'sparse', denseUsageRows: dense ? 401 : 0,
      candidateDeadlineMs: dense ? 20_000 : 60_000, referenceDeadlineMs: 60_000,
      admittedFormats: ['v1', 'v1.1', 'v1.2'], fullInputCalendarDays: configuration.graphDays + 100 },
    scope: 'Local synthetic model history only. Independent empty analytics targets. Source admission and fixture setup excluded. Candidate includes durable writes, fresh resumes and final visibility read. No scheduler, public aggregate or production latency/CPU qualification.',
    phases }));
}, 300_000);
