import { env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createSharedAnalyticsInputCache } from '../src/analytics-shared-input';
import { evaluateSharedModelDate } from '../src/analytics-shared-reducers';
import { createModelBlockCheckpoint, createModelBlockSelection, evaluatePreparedModelDate, modelBlockInputDays,
  modelBlockOutputDays, planHistoricalModelBlockRanges, historicalModelBlockRangeEligible,
  validModelBlockCheckpoint, validModelBlockIdentity,
  MODEL_BLOCK_MAX_CHECKPOINT_BYTES, MODEL_BLOCK_METHOD,
  type ModelBlockCheckpoint, type ModelBlockDependency, type ModelBlockIdentity,
} from '../src/analytics-model-block-contract';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay } from '../src/effective-quota-day';
import { appendEffectiveUsageDay } from '../src/effective-usage-day';
import { modelHistoryWindow } from '../src/model-history-window';
import type { V11SourcePin } from '../src/telemetry-v11-domain';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';

const DAY = '2026-09-20', OWNER = 'a'.repeat(64), FINGERPRINT = 'b'.repeat(64);
const identity = (): ModelBlockIdentity => ({ version: 1, method: MODEL_BLOCK_METHOD,
  sourceId: 'synthetic-model-block', sourceNamespace: 'synthetic-model-block',
  ownerDigest: OWNER, ownerRevision: 2, authorityEpoch: 3, inputRevision: 4,
  authorityDigest: 'c'.repeat(64), outputFromDay: DAY, outputThroughDay: '2026-09-21' });
const dependencies = (value = identity()): ModelBlockDependency[] => modelBlockInputDays(value)
  .map((day, index) => ({ day, digest: index.toString(16).padStart(64, '0'),
    hasQuota: index % 7 === 0, hasUsage: index % 5 === 0 }));
const copy = <T>(value: T): T => structuredClone(value);
const firstOutput = (value = identity()) => ({ day: value.outputFromDay, fingerprint: FINGERPRINT,
  value: { status: 'not_testable' as const, reason: 'supported_quota_track_unavailable' } });

it('clips every epoch-aligned block to exactly the 69 completed preview dates at every offset', () => {
  const day = (index: number) => new Date(index * 86_400_000).toISOString().slice(0, 10);
  const base = Math.floor(Date.parse('2026-09-28T00:00:00Z') / 86_400_000 / 32) * 32;
  for (let offset = 0; offset < 32; offset++) {
    const todayIndex = base + offset, today = day(todayIndex);
    const ranges = planHistoricalModelBlockRanges(today);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    expect(ranges.length).toBeLessThanOrEqual(4);
    const covered: string[] = [];
    for (const range of ranges) {
      const first = Date.parse(`${range.outputFromDay}T00:00:00Z`) / 86_400_000;
      const last = Date.parse(`${range.outputThroughDay}T00:00:00Z`) / 86_400_000;
      expect(Math.floor(first / 32)).toBe(Math.floor(last / 32));
      expect(last - first).toBeLessThan(32);
      expect(first).toBeGreaterThanOrEqual(todayIndex - 69);
      expect(last).toBeLessThan(todayIndex);
      expect(historicalModelBlockRangeEligible(range, today)).toBe(true);
      expect(modelBlockInputDays({ ...identity(), ...range })[0])
        .toBe(day(first - 100));
      covered.push(...modelBlockOutputDays({ ...identity(), ...range }));
    }
    expect(covered).toEqual(Array.from({ length: 69 }, (_, index) => day(todayIndex - 69 + index)));
    expect(historicalModelBlockRangeEligible({ ...ranges[0]!, outputFromDay: day(todayIndex - 70) }, today)).toBe(false);
    expect(historicalModelBlockRangeEligible({ ...ranges.at(-1)!, outputThroughDay: today }, today)).toBe(false);
  }
  expect(planHistoricalModelBlockRanges('2024-03-01').every(range =>
    range.outputThroughDay < '2024-03-01')).toBe(true);
  expect(() => planHistoricalModelBlockRanges('2026-02-30')).toThrow('MODEL_BLOCK_INVALID_DAY');
  expect(() => planHistoricalModelBlockRanges('not-a-day')).toThrow('MODEL_BLOCK_INVALID_DAY');
});

it('binds one to 32 output days to an exact 101 to 132 day input halo', () => {
  const value = identity();
  expect(validModelBlockIdentity(value)).toBe(true);
  expect(MODEL_BLOCK_METHOD).toContain('v1-composition-');
  expect(modelBlockOutputDays(value)).toEqual([DAY, '2026-09-21']);
  expect(modelBlockInputDays(value)).toHaveLength(102);
  expect(modelBlockInputDays(value)[0]).toBe(modelHistoryWindow(DAY).fromDay);
  expect(modelBlockInputDays(value).at(-1)).toBe(value.outputThroughDay);
  const long = { ...value, outputThroughDay: '2026-10-21' };
  expect(validModelBlockIdentity(long)).toBe(true);
  expect(modelBlockOutputDays(long)).toHaveLength(32);
  expect(modelBlockInputDays(long)).toHaveLength(132);
  for (const bad of [{ ...value, outputThroughDay: '2026-10-22' },
    { ...value, outputThroughDay: '2026-09-19' }, { ...value, method: 'old-model-method' },
    { ...value, ownerDigest: 'not-a-digest' }, { ...value, authorityDigest: 'A'.repeat(64) },
    { ...value, ownerRevision: -1 }, { ...value, authorityEpoch: 0 },
    { ...value, outputFromDay: '2026-02-30' },
    { ...value, rawOwnerId: 'unapproved' }]) expect(validModelBlockIdentity(bad)).toBe(false);
});

it('accepts only a full dependency vector, bounded pending day, and ordered validated outputs', async () => {
  const key = identity(), inputs = modelBlockInputDays(key), facts = dependencies(key);
  const selecting = createModelBlockSelection(key);
  expect(validModelBlockCheckpoint(selecting, key)).toBe(true);
  expect(validModelBlockCheckpoint({ ...selecting, dependencies: facts.slice(0, 16) }, key)).toBe(true);
  expect(validModelBlockCheckpoint({ ...selecting, dependencies: facts.slice(1, 17) }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...selecting, dependencies: facts.slice(0, 16), inputIndex: 1 }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...selecting, dependencies: facts.slice(0, 16),
    pending: { unexpected: true } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...selecting, dependencies: facts.slice(0, 16),
    outputs: [firstOutput(key)] }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...selecting, phase: 'acquire', dependencies: facts.slice(0, 16) }, key)).toBe(false);
  const initial = createModelBlockCheckpoint(key, facts);
  expect(validModelBlockCheckpoint(initial, key)).toBe(true);
  expect(MODEL_BLOCK_MAX_CHECKPOINT_BYTES).toBe(10 * 1024 * 1024);
  for (const wrong of [facts.slice(1), facts.slice().reverse(),
    facts.map((row, index) => index === 0 ? { ...row, hasQuota: 1 } : row),
    facts.map((row, index) => index === 0 ? { ...row, recordJson: 'private' } : row)]) {
    expect(validModelBlockCheckpoint({ ...initial, dependencies: wrong }, key)).toBe(false);
    expect(() => createModelBlockCheckpoint(key, wrong as ModelBlockDependency[])).toThrow();
  }
  const day = inputs[0]!;
  const quota = appendEffectiveQuotaDay(null, day, [], 10_080)!;
  const usage = (await appendEffectiveUsageDay(null, day, [], OWNER))!;
  const pending = { day, stream: 'usage' as const, after: null, quota, usage };
  const acquiring: ModelBlockCheckpoint = { ...initial, pending };
  expect(validModelBlockCheckpoint(acquiring, key)).toBe(true);
  expect(validModelBlockCheckpoint({ ...acquiring, pending: { ...pending, day: inputs[1] } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...acquiring, pending: { ...pending,
    after: { observedAtMs: Date.parse(`${day}T12:00:00.000Z`), occurrenceId: 'bad id' } } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...acquiring, pending: { ...pending,
    after: { observedAtMs: Date.parse(`${day}T12:00:00.000Z`), occurrenceId: 'synthetic:1' } } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...acquiring, pending: { ...pending, stream: 'quota',
    after: { observedAtMs: Date.parse(`${day}T12:00:00.000Z`), occurrenceId: 'synthetic:1' } } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...acquiring, pending: { ...pending, recordJson: 'private' } }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...acquiring, phase: 'fallback' }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...initial, phase: 'fallback', inputIndex: 1 }, key)).toBe(true);

  const emitted: ModelBlockCheckpoint = { ...initial, phase: 'emit', inputIndex: inputs.length,
    outputs: [firstOutput(key)] };
  expect(validModelBlockCheckpoint(emitted, key)).toBe(true);
  expect(validModelBlockCheckpoint({ ...emitted, phase: 'complete' }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...emitted, inputIndex: inputs.length - 1 }, key)).toBe(false);
  expect(validModelBlockCheckpoint({ ...initial, outputs: [firstOutput(key)] }, key)).toBe(false);
  const completed = { ...emitted, phase: 'complete', outputs: [firstOutput(key),
    { ...firstOutput(key), day: key.outputThroughDay }] };
  expect(validModelBlockCheckpoint(completed, key)).toBe(true);
  for (const bad of [
    { ...completed, outputs: copy(completed.outputs).reverse() },
    { ...completed, outputs: [{ ...firstOutput(key), fingerprint: 'f'.repeat(64),
      value: { status: 'ready' } }] },
    { ...completed, outputs: [{ ...firstOutput(key), value: { ...firstOutput(key).value,
      recordJson: 'private' } }] },
    { ...completed, unexpected: true },
  ]) expect(validModelBlockCheckpoint(bad, key)).toBe(false);
});

it('requires every one of 101 prepared dates and retains analytical not-testable results', async () => {
  const fromDay = modelHistoryWindow(DAY).fromDay;
  const start = Date.parse(`${fromDay}T00:00:00.000Z`);
  const days = Array.from({ length: 101 }, (_, index) => new Date(start + index * 86_400_000)
    .toISOString().slice(0, 10));
  const quotaDays = days.map(day => finishEffectiveQuotaDay(appendEffectiveQuotaDay(null,
    day, [], 10_080)!)!);
  const usageDays = await Promise.all(days.map(async day => ({ projection:
    (await appendEffectiveUsageDay(null, day, [], OWNER))!.projection })));
  const pin: V11SourcePin = { source: 'v1.1', participantId: 'synthetic-owner',
    generationId: 'effective:synthetic', fromDay, throughDay: DAY, inputRevision: 1,
    mutationEpoch: 1, fingerprint: FINGERPRINT };
  const result = await evaluatePreparedModelDate({ pin, day: DAY, quotaDays, usageDays });
  expect(result).toEqual({ status: 'complete', value: {
    status: 'not_testable', reason: 'supported_quota_track_unavailable', tracks: [] } });
  await expect(evaluatePreparedModelDate({ pin, day: DAY, quotaDays: quotaDays.slice(1), usageDays }))
    .rejects.toThrow('MODEL_BLOCK_INCOMPLETE_WINDOW');
  await expect(evaluatePreparedModelDate({ pin, day: DAY, quotaDays,
    usageDays: [usageDays[1]!, usageDays[0]!, ...usageDays.slice(2)] }))
    .rejects.toThrow('MODEL_BLOCK_INVALID_PREPARED_DAY');
  await expect(evaluatePreparedModelDate({ pin: { ...pin, fromDay: days[1]! },
    day: DAY, quotaDays, usageDays })).rejects.toThrow('MODEL_BLOCK_INVALID_WINDOW');
});

it('matches the existing ready model kernel from real mixed-format effective days', async () => {
  await reset();
  const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
    TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
    TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
    TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
  const source = bindings.USAGE_MONITOR_DB, target = bindings.STORAGE_ANALYTICS_DB;
  const sourceId = 'synthetic-model-block-ready';
  await initializeSharedAnalyticsCorpusDatabases(source, target, bindings, sourceId);
  const corpus = await seedSharedAnalyticsCorpus({ source, target, sourceId,
    sourceNamespace: sourceId, calendarDays: 14, graphDays: 2 });
  const day = corpus.graphDates[0]!;
  const cache = createSharedAnalyticsInputCache({ source, sourceNamespace: sourceId });
  const snapshot = await cache.load({ owner: corpus.owner, fromDay: modelHistoryWindow(day).fromDay,
    throughDay: day, deadlineMs: Date.now() + 60_000 });
  const pin = await snapshot.pinForDate(day);
  const actual = await evaluatePreparedModelDate({ pin, day,
    quotaDays: snapshot.days.map(value => value.quota),
    usageDays: snapshot.days.map(value => value.modelUsage) });
  const reference = await evaluateSharedModelDate({ pin, day,
    ownerDigest: corpus.owner.ownerDigest, days: snapshot.days });
  expect(actual.status).toBe('complete');
  if (actual.status !== 'complete') throw new Error('synthetic ready model unexpectedly fell back');
  expect(actual.value.status).toBe('ready');
  expect(actual.value).toEqual(reference);
}, 60_000);
