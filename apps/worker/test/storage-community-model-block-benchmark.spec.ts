import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { planHistoricalModelBlockRanges } from '../src/analytics-model-block-contract';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { captureStorageGraphScope, computeStorageGraphResult } from '../src/storage-community-graph';
import { publishStorageCommunityGraphPreview, publishStorageCommunityModelDay,
  readPublishedStorageCommunityGraph, retireStorageCommunityGraphPublications } from '../src/storage-community-graph-publication';
import { advanceStorageModelBlockGraphWork } from '../src/storage-community-graph-model-block';
import { readStorageCommunityOwnerPage, type StorageCommunityOwner } from '../src/storage-community-authority';
import { initializeStorageAnalyticsRuntime } from '../src/storage-analytics-runtime';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile,
  type AnalyticsProfile } from './helpers/analytics-profile';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database; STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
type Owner = StorageCommunityOwner & { ownerDigest: string };
type Mode = 'small' | 'block' | 'window' | 'dense';
const b = env as Bindings;
const source = () => b.USAGE_MONITOR_DB, candidate = () => b.STORAGE_ANALYTICS_DB;
// An otherwise unused local test D1 binding is an independent reference store.
const reference = () => b.STORAGE_INGESTION_A;
const sourceId = 'synthetic-model-publication-benchmark', sourceNamespace = sourceId;
const DAY_MS = 86_400_000;
const configured = (import.meta as ImportMeta & { env?: { VITE_STORAGE_MODEL_PUBLICATION_BENCHMARK?: string } })
  .env?.VITE_STORAGE_MODEL_PUBLICATION_BENCHMARK;
if (configured !== undefined && !['small', 'block', 'window', 'dense'].includes(configured))
  throw new Error('invalid local model publication benchmark mode');
const mode: Mode = (configured as Mode | undefined) ?? 'small';
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const dayBefore = (value: string, days: number) => day(Date.parse(`${value}T00:00:00.000Z`) - days * DAY_MS);
const rangeDays = (range: { outputFromDay: string; outputThroughDay: string }) =>
  (Date.parse(`${range.outputThroughDay}T00:00:00.000Z`)
    - Date.parse(`${range.outputFromDay}T00:00:00.000Z`)) / DAY_MS + 1;
const allDates = (from: string, through: string) => {
  const first = Date.parse(`${from}T00:00:00.000Z`), last = Date.parse(`${through}T00:00:00.000Z`);
  return Array.from({ length: (last - first) / DAY_MS + 1 }, (_, index) => day(first + index * DAY_MS));
};

/** One measured invocation, including scope capture, writes, publication and cleanup. */
function measured(profile: AnalyticsProfile, database: { source: D1Database; target: D1Database },
  operation: string) {
  const meter = createD1InvocationBudget(950);
  const sourceDb = meter.wrap(database.source), targetDb = meter.wrap(database.target);
  const started = performance.now(), before = summarizeAnalyticsProfile(profile).statements;
  return async <T>(run: (bindings: { source: D1Database; target: D1Database;
    sourceId: string; sourceNamespace: string }, meter: ReturnType<typeof createD1InvocationBudget>) => Promise<T>) => {
    try { return await run({ source: sourceDb, target: targetDb, sourceId, sourceNamespace }, meter); }
    finally {
      const count = summarizeAnalyticsProfile(profile).statements - before;
      expect(count, `${operation} statement accounting`).toBe(meter.queriesUsed);
      expect(meter.queriesUsed, `${operation} D1 cap`).toBeLessThanOrEqual(950);
      profile.invocations++;
      profile.maximumStatementsPerInvocation = Math.max(profile.maximumStatementsPerInvocation, meter.queriesUsed);
      profile.operationWallMs[operation] = (profile.operationWallMs[operation] ?? 0) + performance.now() - started;
    }
  };
}

async function computeNative(owner: Owner, date: string, db: { source: D1Database; target: D1Database },
  profile: AnalyticsProfile, operation: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await measured(profile, db, operation)(async (bindings, meter) => {
      const scope = await captureStorageGraphScope(bindings.source,
        { owner, day: date, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
      const computed = await computeStorageGraphResult(bindings, scope,
        { maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 60_000,
          preparedFold: true, preparedEffectiveUsage: false });
      return { scope, computed };
    });
    if (result.computed.state === 'complete') return result.scope;
    expect(result.computed.failure).toBeUndefined();
  }
  throw new Error(`native model date did not complete within bounded attempts: ${date}`);
}

async function computeCandidate(owner: Owner, date: string, db: { source: D1Database; target: D1Database },
  profile: AnalyticsProfile, useBlock: boolean) {
  if (!useBlock) {
    await computeNative(owner, date, db, profile, 'native_model');
    return 0;
  }
  const reasons: Record<string, number> = {};
  let adoptedDates = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    const outcome = await measured(profile, db, 'block_adoption')(async (bindings, meter) => {
      const scope = await captureStorageGraphScope(bindings.source,
        { owner, day: date, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
      const beforeAdapter = meter.queriesUsed;
      const result = await advanceStorageModelBlockGraphWork({ ...bindings, scope,
        nowMs: Date.now(), maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 60_000 });
      expect(meter.queriesUsed - beforeAdapter, 'nested model block meter').toBe(result.queriesUsed);
      return { scope, result };
    });
    adoptedDates += outcome.result.adoptedDates;
    if (outcome.result.state === 'complete') return adoptedDates;
    if (outcome.result.state === 'unsupported')
      throw new Error(`eligible effective block unexpectedly unsupported: ${outcome.result.reason}`);
    reasons[outcome.result.reason ?? 'unspecified'] = (reasons[outcome.result.reason ?? 'unspecified'] ?? 0) + 1;
  }
  throw new Error(`model block adoption did not complete within bounded attempts: ${date}, reasons ${JSON.stringify(reasons)}`);
}

async function publicationRow(target: D1Database, date: string) {
  const row = await target.prepare(`SELECT payload_json,payload_sha256 FROM analytics_community_model_publications
    WHERE source_id=? AND day=?`).bind(sourceId, date).first<{ payload_json: string; payload_sha256: string }>();
  expect(row).not.toBeNull();
  expect(row!.payload_sha256).toBe(await sha256Hex(row!.payload_json));
  return row!;
}

async function setup(today: string) {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), candidate(), b, sourceId, sourceNamespace);
  const ranges = planHistoricalModelBlockRanges(today);
  const selectedRange = ranges.find(range => rangeDays(range) === 32);
  if (!selectedRange) throw new Error('expected full 32-day historical block');
  expect(ranges.flatMap(range => allDates(range.outputFromDay, range.outputThroughDay)))
    .toEqual(allDates(dayBefore(today, 69), dayBefore(today, 1)));
  const anchorDay = mode === 'small' ? dayBefore(today, 1)
    : mode === 'block' ? selectedRange.outputThroughDay : today;
  const graphDays = mode === 'small' ? 1 : mode === 'block' ? 32 : 70;
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: candidate(), sourceId, sourceNamespace,
    anchorDay, calendarDays: graphDays + 100, graphDays, correctionAffectsModelFit: true,
    ...(mode === 'dense' ? { denseDays: true, denseUsageRows: 401 } : {}) });
  await applyD1Migrations(reference(), b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({ source: source(), target: reference(), sourceId, sourceNamespace });
  const owners = (await readStorageCommunityOwnerPage(source())).filter(
    (owner): owner is Owner => typeof owner.ownerDigest === 'string');
  expect(owners).toHaveLength(2);
  for (const target of [candidate(), reference()]) for (const owner of owners)
    await target.prepare(`INSERT OR REPLACE INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
      .bind(sourceId, owner.ownerDigest, owner.ownerRevision, owner.authorityEpoch, 'active').run();
  const primary = owners.find(owner => owner.participantId === corpus.participantId)!;
  const other = owners.find(owner => owner.participantId !== corpus.participantId)!;
  const dates = mode === 'block' ? allDates(selectedRange.outputFromDay, selectedRange.outputThroughDay)
    : [...corpus.graphDates];
  const eligible = new Set(ranges.flatMap(range => allDates(range.outputFromDay, range.outputThroughDay)));
  expect(dates).toHaveLength(graphDays);
  const plannedDates = dates.filter(date => eligible.has(date)).length;
  const plannedJobs = mode === 'small' ? 0 : ranges.filter(range =>
    dates.some(date => range.outputFromDay <= date && date <= range.outputThroughDay)).length;
  if (mode === 'block') {
    expect(plannedDates).toBe(32);
    expect(plannedJobs).toBe(1);
  } else if (mode === 'window' || mode === 'dense') {
    expect(plannedDates).toBe(69);
    expect(plannedJobs).toBeGreaterThanOrEqual(3);
    expect(plannedJobs).toBeLessThanOrEqual(4);
  }
  return { corpus, primary, other, dates, eligible, plannedDates, plannedJobs };
}

async function runLane(lane: 'reference' | 'candidate', primary: Owner, other: Owner,
  dates: readonly string[], eligible: ReadonlySet<string>, plannedJobs: number,
  today: string, phase: string, nowMs: number) {
  const target = lane === 'candidate' ? candidate() : reference();
  const profile = createAnalyticsProfile(), started = performance.now();
  const observed = { source: profileAnalyticsDatabase(source(), 'source', profile, () => phase),
    target: profileAnalyticsDatabase(target, 'target', profile, () => phase) };
  const publications: string[] = [];
  let incompleteCohortChecked = false, blockDates = 0, adoptedDates = 0;
  for (const date of dates) {
    const useBlock = lane === 'candidate' && mode !== 'small' && eligible.has(date);
    if (lane === 'candidate') {
      adoptedDates += await computeCandidate(primary, date, observed, profile, useBlock);
      if (useBlock) blockDates++;
    } else await computeNative(primary, date, observed, profile, 'native_model');
    if (phase === 'cold' && !incompleteCohortChecked) {
      const deferred = await measured(profile, observed, 'publication_incomplete')(bindings =>
        publishStorageCommunityModelDay(bindings, { day: date }));
      expect(deferred).toMatchObject({ state: 'deferred', reason: 'cache_pending' });
      incompleteCohortChecked = true;
    }
    await computeNative(other, date, observed, profile, 'other_owner_model');
    const published = await measured(profile, observed, 'publish_model')(bindings =>
      publishStorageCommunityModelDay(bindings, { day: date }));
    expect(['published', 'unchanged']).toContain(published.state);
    expect(published.memberCount).toBe(2);
    publications.push((await measured(profile, observed, 'read_publication')(bindings =>
      publicationRow(bindings.target, date))).payload_json);
  }
  for (const owner of [primary, other]) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await measured(profile, observed, 'current_fits')(async (bindings, meter) => {
        const scope = await captureStorageGraphScope(bindings.source,
          { owner, day: today, metric: 'fits', sourceId, sourceNamespace, preparedFold: true });
        return computeStorageGraphResult(bindings, scope,
          { maxQueries: meter.remainingQueries, deadlineMs: Date.now() + 60_000,
            preparedFold: true, preparedEffectiveUsage: false });
      });
      if (result.state === 'complete') break;
      expect(result.failure).toBeUndefined();
      if (attempt === 119) throw new Error('current fits did not complete');
    }
  }
  const previewState = await measured(profile, observed, 'publish_preview')(bindings =>
    publishStorageCommunityGraphPreview(bindings, { nowMs }));
  expect(['published', 'unchanged']).toContain(previewState.state);
  const preview = await measured(profile, observed, 'read_preview')(bindings =>
    readPublishedStorageCommunityGraph(bindings, Date.now()));
  expect(preview).not.toBeNull();
  await measured(profile, observed, 'cleanup')(bindings =>
    retireStorageCommunityGraphPublications(bindings, nowMs));
  const completedJobs = await measured(profile, observed, 'read_block_jobs')(bindings =>
    bindings.target.prepare(`SELECT count(*) AS count FROM analytics_model_blocks
      WHERE source_id=? AND owner_digest=? AND state='complete'`)
      .bind(sourceId, primary.ownerDigest).first<number>('count'));
  expect(Number.isSafeInteger(completedJobs)).toBe(true);
  if (lane === 'candidate' && mode !== 'small') expect(completedJobs).toBe(plannedJobs);
  else expect(completedJobs).toBe(0);
  profile.wallMs = performance.now() - started;
  const summary = summarizeAnalyticsProfile(profile);
  expect(summary.failedStatements).toBe(0);
  expect(summary.metadataSamples).toBe(summary.statements);
  return { publications, preview: preview!.payload_json, profile: summary, blockDates,
    adoptedDates, completedJobs };
}

it('compares local native and model-block cohort publication through replay and a numeric correction', async () => {
  const today = day(Date.now()), nowMs = Date.now();
  const setupResult = await setup(today);
  let { primary } = setupResult;
  const reports: Record<string, unknown> = {};
  let beforeCorrection: string[] = [];
  for (const phase of ['cold', 'replay', 'correction'] as const) {
    if (phase === 'correction') {
      primary = await setupResult.corpus.mutateCorrection() as Owner;
      await reference().prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
        WHERE source_id=? AND owner_digest=? AND state='active'`)
        .bind(primary.ownerRevision, primary.authorityEpoch, sourceId, primary.ownerDigest).run();
    }
    const normal = await runLane('reference', primary, setupResult.other, setupResult.dates,
      setupResult.eligible, setupResult.plannedJobs, today, phase, nowMs);
    const adopted = await runLane('candidate', primary, setupResult.other, setupResult.dates,
      setupResult.eligible, setupResult.plannedJobs, today, phase, nowMs);
    expect(adopted.publications).toEqual(normal.publications);
    expect(adopted.preview).toBe(normal.preview);
    if (mode !== 'small' && phase === 'cold')
      expect(adopted.adoptedDates).toBe(setupResult.plannedDates);
    if (phase === 'replay') beforeCorrection = normal.publications;
    if (phase === 'correction') {
      const changed = normal.publications.some((value, index) =>
        JSON.stringify((JSON.parse(value) as { values: unknown }).values)
          !== JSON.stringify((JSON.parse(beforeCorrection[index]!) as { values: unknown }).values));
      expect(changed, 'accepted fit correction changes a published numeric model value').toBe(true);
    }
    reports[phase] = { reference: normal.profile, candidate: adopted.profile,
      blockDates: adopted.blockDates, adoptedDates: adopted.adoptedDates,
      completedJobs: adopted.completedJobs,
      publishedDates: normal.publications.length };
  }
  console.log('storage-model-publication-benchmark', JSON.stringify({
    schemaVersion: 'storage-model-publication-benchmark-v2', mode,
    scope: 'Local synthetic D1 only; setup/admission excluded; each lane includes scope, compute/adoption, cohort publication, preview and cleanup. CPU and peak heap unavailable.',
    outputDates: setupResult.dates.length, plannedBlockDates: setupResult.plannedDates,
    plannedJobs: setupResult.plannedJobs,
    phases: reports,
  }));
}, mode === 'small' ? 300_000 : 1_200_000);
