import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { describe, expect, it } from 'vitest';
import { evaluateSharedCacheDay, evaluateSharedModelDate, evaluateSharedScalarDate,
  prepareSharedAnalyticsDay, SharedAnalyticsUnavailable } from '../src/analytics-shared-reducers';
import { cacheRetentionEventFromRecord, cacheRetentionSessionDigest } from '../src/cache-retention-day';
import { reduceCacheRetentionDay, type CacheRetentionEvent } from '../src/cache-retention-values';
import { selectCommunityAllowanceAnalysisFits } from '../src/community-allowance';
import { mapEffectiveQuotaPageRow } from '../src/effective-quota-day';
import { modelHistoryWindow } from '../src/model-history-window';
import { advanceV11UsageReduction, createV11QuotaAcquisitionIdentity,
  finishV11UsageReduction } from '../src/quota-analysis-v11';
import { advanceV11QuotaAcquisition, V11_QUOTA_ACQUISITION_PAGE_SIZE,
  type V11QuotaPageReader } from '../src/quota-analysis-v11-reader';
import type { EffectiveTelemetryOccurrence } from '../src/telemetry-usage-effective-reader';
import type { V11SourcePin } from '../src/telemetry-v11-domain';
import { createV11DailyProjectionValues, finalizeV11DailyProjectionValues,
  foldV11DailyProjectionValues } from '../src/v11-daily-projection-values';
import { v11UsageRecord } from './helpers/telemetry-v11';

const DAY = '2026-09-28', START = Date.parse(`${DAY}T00:00:00.000Z`);
const DAY_MS = 86_400_000, OWNER = 'a'.repeat(64), ACCOUNT = `account-track:v2:${'b'.repeat(64)}`;
const PARTICIPANT = 'synthetic-shared-input-owner';
const stamp = (at: number) => new Date(at).toISOString();
const label = (at: number) => stamp(at).slice(0, 10);
const id = (prefix: string, index: number) => `${prefix}:v1:${index.toString(16).padStart(64, '0')}`;
const noDb = { prepare(): never { throw new Error('test unexpectedly read D1'); } } as unknown as D1Database;

function occurrence(stream: 'usage' | 'quota' | 'session', at: number, occurrenceId: string,
  record: unknown): EffectiveTelemetryOccurrence {
  return { methodVersion: 'effective-telemetry-owner-day-v1', stream,
    participantId: PARTICIPANT, ownerDigest: OWNER, occurrenceId, eventTime: stamp(at),
    eventTimeConflict: false, status: 'compatible', sourceCount: 1, sourceFormats: ['v12'],
    sourceRowIds: [], sourceRecordKeys: ['synthetic-key'], recordJson: canonicalTelemetryV11Json(record) };
}

function usage(index: number, at: number, sessionUuid = 'synthetic-session',
  components: Partial<ReturnType<typeof v11UsageRecord>['components']> = {}) {
  const record = v11UsageRecord(label(at), 'c', { eventId: id('event', index), eventTime: stamp(at),
    sessionUuid, accountPlanAttribution: { accountBasis: 'same_source', accountTrackId: ACCOUNT,
      planBasis: 'same_source_occurrence', planType: 'pro', planEraId: null } });
  record.components = { ...record.components, ...components };
  return occurrence('usage', at, record.eventId, record);
}

function quota(index: number, at: number, usedPercent: number) {
  const observationId = id('quota', index);
  return occurrence('quota', at, observationId, {
    schemaVersion: 'quota-observation-v1.1', observationId, observedTime: stamp(at),
    provider: 'openai_codex', planType: 'pro', planVariant: 'unknown', limitId: 'codex',
    slot: 'seven_day', usedPercent, windowDurationMinutes: 10_080,
    resetsAt: stamp(START + 8 * DAY_MS), accountPlanAttribution: {
      accountBasis: 'same_source', accountTrackId: ACCOUNT,
      planBasis: 'same_source_occurrence', planType: 'pro', planEraId: null },
  });
}

function session(at: number) {
  const sessionUuid = 'synthetic-session';
  return occurrence('session', at, id('session', 1), {
    schemaVersion: 'session-dimension-v1.1', sessionUuid,
    firstEventTime: stamp(at), provider: 'openai_codex', toolClassCounts: { shell: 1 },
  });
}

const pin = (day = DAY): V11SourcePin => ({ source: 'v1.1', participantId: PARTICIPANT,
  generationId: 'synthetic-shared-input', fromDay: DAY, throughDay: day,
  inputRevision: 1, mutationEpoch: 1, fingerprint: 'd'.repeat(64) });

function fitableQuotaRows() {
  return Array.from({ length: 9 }, (_, index) =>
    quota(index + 1, START + index * 3_600_000, 5 + index * 10));
}

async function pagedQuota(rows: readonly EffectiveTelemetryOccurrence[], sourcePin = pin()) {
  const identity = createV11QuotaAcquisitionIdentity(sourcePin,
    Date.parse(modelHistoryWindow(sourcePin.throughDay).fixedNow));
  const ordered = rows.map((row, index) => mapEffectiveQuotaPageRow(row, DAY, index + 1));
  const reader: V11QuotaPageReader = { pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
    async readPage(cursor, limit) {
      const index = ordered.findIndex(row => row.observedAtMs > cursor.observedAtMs
        || row.observedAtMs === cursor.observedAtMs && row.sourceRowId > cursor.sourceRowId);
      return index < 0 ? [] : ordered.slice(index, index + limit);
    } };
  const result = await advanceV11QuotaAcquisition(reader, identity,
    { remainingQueries: 10_000, deadlineMs: 1, now: () => 0 });
  if (result.status !== 'complete') throw new Error(`synthetic paged quota ${result.status}`);
  return result;
}

function pagedUsage(rows: readonly EffectiveTelemetryOccurrence[]) {
  const mapped = rows.map(row => {
    const record = JSON.parse(row.recordJson!);
    return { occurrence_id: row.occurrenceId, observed_at: row.eventTime!,
      provider: record.provider as string, session_uuid: record.sessionUuid as string,
      record_json: row.recordJson! };
  });
  return { days: rows.length ? [DAY] : [],
    async readPage({ afterTime, afterOccurrence }: { day: string; afterTime: string; afterOccurrence: string }) {
      const index = mapped.findIndex(row => row.observed_at > afterTime
        || row.observed_at === afterTime && row.occurrence_id > afterOccurrence);
      return { rows: index < 0 ? [] : mapped.slice(index), complete: true };
    } };
}

describe('shared-input reducer experiment', () => {
  it('uses the existing daily arithmetic for all three effective streams', async () => {
    const u = Array.from({ length: 9 }, (_, index) =>
      usage(index + 1, START + index * 3_600_000 + 30 * 60_000));
    const q = fitableQuotaRows();
    const s = [session(START + 30 * 60_000)];
    const prepared = await prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER, usage: u, quota: q, session: s });
    let reference = createV11DailyProjectionValues(DAY);
    for (const row of [...u, ...q, ...s]) reference = foldV11DailyProjectionValues(reference,
      [JSON.parse(row.recordJson!)]);
    expect(prepared.daily).toEqual(finalizeV11DailyProjectionValues(reference));
    expect(prepared.daily.counts).toEqual({ usage: 9, quota: 9, session: 1 });
    expect(prepared.usageRows).toHaveLength(9);
    expect(JSON.stringify(prepared.modelUsage)).not.toContain('synthetic-session');
  });

  it('matches paged quota and streaming scalar/model kernels at the same cutoff', async () => {
    const u = Array.from({ length: 9 }, (_, index) =>
      usage(index + 1, START + index * 3_600_000 + 30 * 60_000));
    const q = fitableQuotaRows();
    const prepared = await prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER, usage: u, quota: q, session: [] });
    const sourcePin = pin(), acquisition = await pagedQuota(q);
    expect(acquisition.quotaRows.length).toBeGreaterThan(0);
    const completed = { identity: acquisition.identity, planAnchors: acquisition.planAnchors,
      quotaRows: acquisition.quotaRows };
    const options = { nowMs: Date.parse(modelHistoryWindow(DAY).fixedNow),
      quotaAcquisition: completed, effectiveUsageReader: pagedUsage(u) };
    const budget = () => ({ remainingQueries: 20, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 });
    const scalarState = await advanceV11UsageReduction(noDb, sourcePin, options, budget(), null, 20);
    expect(scalarState.complete).toBe(true);
    const scalarReference = await finishV11UsageReduction(noDb, sourcePin, options, scalarState, 'fits');
    const scalar = await evaluateSharedScalarDate({ pin: sourcePin, day: DAY, ownerDigest: OWNER, days: [prepared] });
    expect(scalar.analysis).toMatchObject({ status: 'ready' });
    expect(scalar.selectedFits.length).toBeGreaterThan(0);
    expect(scalar.analysis).toEqual(scalarReference);
    expect(scalar.selectedFits).toEqual(selectCommunityAllowanceAnalysisFits(OWNER,
      [{ source: 'v1.1', analysis: scalarReference as Parameters<typeof selectCommunityAllowanceAnalysisFits>[1][number]['analysis'] }]));
    const modelState = await advanceV11UsageReduction(noDb, sourcePin,
      { ...options, scalarRequested: false }, budget(), null, 20);
    const modelReference = await finishV11UsageReduction(noDb, sourcePin,
      { ...options, scalarRequested: false }, modelState, 'model');
    const model = await evaluateSharedModelDate({ pin: sourcePin, day: DAY,
      ownerDigest: OWNER, days: [prepared] });
    expect(model).toMatchObject({ status: 'ready' });
    expect(model).toEqual(modelReference);
  });

  it('does not admit later quota or usage into an earlier model date', async () => {
    const today = await prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: Array.from({ length: 9 }, (_, index) =>
        usage(index + 1, START + index * 3_600_000 + 30 * 60_000)),
      quota: fitableQuotaRows(), session: [] });
    const tomorrow = label(START + DAY_MS);
    const next = await prepareSharedAnalyticsDay({ day: tomorrow, ownerDigest: OWNER,
      usage: [usage(2, START + DAY_MS + 30 * 60_000)], quota: [], session: [] });
    const isolated = await evaluateSharedModelDate({ pin: pin(), day: DAY, ownerDigest: OWNER, days: [today] });
    expect(isolated).toMatchObject({ status: 'ready' });
    expect(await evaluateSharedModelDate({ pin: pin(), day: DAY,
      ownerDigest: OWNER, days: [today, next] })).toEqual(isolated);
    await expect(evaluateSharedModelDate({ pin: pin(), day: DAY, ownerDigest: OWNER, days: [next] }))
      .rejects.toThrow('incomplete_window');
  });

  it('matches the cache kernel with exact seven-day session carry', async () => {
    const days = [];
    for (let back = 7; back >= 0; back -= 1) {
      const at = START - back * DAY_MS, day = label(at);
      const events = back === 1 ? [usage(1, at + 23 * 3_600_000)]
        : back === 0 ? [usage(2, at + 30 * 60_000)] : [];
      days.push(await prepareSharedAnalyticsDay({ day, ownerDigest: OWNER,
        usage: events, quota: [], session: [] }));
    }
    const previous = days[6]!.cacheItems[0] as CacheRetentionEvent;
    const current = days[7]!.cacheItems[0]!;
    const direct = reduceCacheRetentionDay({ day: DAY, events: [current], carry: [previous], eventsRead: 1 });
    expect(evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days })).toEqual(direct);
    expect(direct.groups[0]?.bands.some(band => band.adjacencies === 1)).toBe(true);
  });

  it('repairs only neighboring pairs after a late cross-midnight insertion', async () => {
    const base = [];
    for (let back = 8; back >= 0; back -= 1) {
      const at = START - back * DAY_MS;
      base.push(await prepareSharedAnalyticsDay({ day: label(at), ownerDigest: OWNER,
        usage: back === 1 ? [usage(1, at + 23 * 3_600_000)]
          : back === 0 ? [usage(3, at + 5 * 60_000)] : [], quota: [], session: [] }));
    }
    const priorDay = label(START - DAY_MS);
    const beforePrior = evaluateSharedCacheDay({ day: priorDay, ownerDigest: OWNER, days: base });
    const beforeCurrent = evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days: base });
    expect(beforePrior.groups).toEqual([]);
    expect(beforeCurrent.groups[0]?.bands.find(band => band.band === 'one_to_two_hours')?.adjacencies).toBe(1);
    const insertion = await prepareSharedAnalyticsDay({ day: priorDay, ownerDigest: OWNER,
      usage: [usage(1, START - 3_600_000), usage(2, START - 5 * 60_000)], quota: [], session: [] });
    const repaired = [...base.slice(0, 7), insertion, base[8]!];
    const afterPrior = evaluateSharedCacheDay({ day: priorDay, ownerDigest: OWNER, days: repaired });
    const afterCurrent = evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days: repaired });
    expect(afterPrior.groups[0]?.bands.find(band => band.band === 'thirty_minutes_to_one_hour')?.adjacencies).toBe(1);
    expect(afterCurrent.groups[0]?.bands.find(band => band.band === 'ten_to_thirty_minutes')?.adjacencies).toBe(1);
    expect(afterCurrent.groups[0]?.bands.find(band => band.band === 'one_to_two_hours')?.adjacencies).toBe(0);
  });

  it('filters zero-input rows, preserves equal-time ties, and clears unreadable carry', async () => {
    const zero = usage(1, START + 5 * 60_000, 'zero-session',
      { inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0 });
    const tied = [usage(2, START + 10 * 60_000), usage(3, START + 10 * 60_000)];
    const prepared = await prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: [zero, ...tied], quota: [], session: [] });
    expect(prepared.cacheEventsRead).toBe(3);
    expect(prepared.cacheItems).toHaveLength(2);
    const sameDay = reduceCacheRetentionDay({ day: DAY, events: prepared.cacheItems, carry: [], eventsRead: 3 });
    expect(sameDay.groups[0]?.bands.find(band => band.band === 'under_one_minute')?.unorderedTies).toBe(1);
    await expect(Promise.resolve().then(() => prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: [usage(8, START + 5 * 60_000, 'negative-session', { inputCacheReadTokens: -1 })],
      quota: [], session: [] }))).rejects.toThrow();
    await expect(prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: [tied[1]!, tied[0]!], quota: [], session: [] })).rejects.toThrow('source_conflict_or_order');
    const days = [];
    for (let back = 7; back >= 0; back -= 1) {
      const at = START - back * DAY_MS;
      days.push(await prepareSharedAnalyticsDay({ day: label(at), ownerDigest: OWNER,
        usage: back === 2 ? [usage(4, at + 23 * 3_600_000)]
          : back === 1 ? [usage(5, at + 22 * 3_600_000), usage(6, at + 23 * 3_600_000 + 55 * 60_000)]
          : back === 0 ? [usage(7, at + 5 * 60_000)] : [], quota: [], session: [] }));
    }
    const preceding = days[6]!;
    // The effective canonical v1.1 fixture validates every configuration token.
    // Inject a prepared unreadable cache item to exercise the carry break seam.
    const breakItem = { sessionDigest: preceding.cacheItems[0]!.sessionDigest,
      observedAtMs: preceding.cacheItems[0]!.observedAtMs,
      orderKey: preceding.cacheItems[0]!.orderKey, unreadable: true as const };
    const withBreak = [...days.slice(0, 6), { ...preceding,
      cacheItems: [breakItem, preceding.cacheItems[1]!] }, days[7]!];
    const aggregate = evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days: withBreak });
    expect(aggregate.groups[0]?.bands.find(band => band.band === 'ten_to_thirty_minutes')?.adjacencies).toBe(1);
    expect(aggregate.groups[0]?.bands.find(band => band.band === 'over_twenty_four_hours')?.adjacencies).toBe(0);
  });

  it('limits carry to the preceding seven days and rejects malformed pins', async () => {
    const days = [];
    for (let back = 8; back >= 0; back -= 1) {
      const at = START - back * DAY_MS;
      days.push(await prepareSharedAnalyticsDay({ day: label(at), ownerDigest: OWNER,
        usage: back === 8 ? [usage(1, at + 23 * 3_600_000)]
          : back === 0 ? [usage(2, at + 5 * 60_000)] : [], quota: [], session: [] }));
    }
    expect(evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days }).groups).toEqual([]);
    const edge = await prepareSharedAnalyticsDay({ day: label(START - 7 * DAY_MS), ownerDigest: OWNER,
      usage: [usage(3, START - 7 * DAY_MS + 6 * 60_000)], quota: [], session: [] });
    const inRange = [...days.slice(0, 1), edge, ...days.slice(2)];
    expect(evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days: inRange })
      .groups[0]?.bands.find(band => band.band === 'over_twenty_four_hours')?.adjacencies).toBe(1);
    await expect(evaluateSharedScalarDate({ pin: { ...pin(), fromDay: '2026-99-28' },
      day: DAY, ownerDigest: OWNER, days: [days[8]!] })).rejects.toThrow('invalid_day');
    await expect(evaluateSharedModelDate({ pin: { ...pin(), throughDay: '2026-99-28' },
      day: DAY, ownerDigest: OWNER, days: [days[8]!] })).rejects.toThrow('invalid_day');
  });

  it('fails closed on conflicting rows, omitted lookback and unrepresentable input', async () => {
    const row = usage(1, START + 30 * 60_000);
    await expect(prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: [{ ...row, status: 'conflict', recordJson: null }], quota: [], session: [] }))
      .rejects.toBeInstanceOf(SharedAnalyticsUnavailable);
    const prepared = await prepareSharedAnalyticsDay({ day: DAY, ownerDigest: OWNER,
      usage: [row], quota: [], session: [] });
    expect(() => evaluateSharedCacheDay({ day: DAY, ownerDigest: OWNER, days: [prepared] }))
      .toThrow('incomplete_cache_lookback');
    const digest = await cacheRetentionSessionDigest({ ownerDigest: OWNER,
      provider: 'openai_codex', sessionUuid: 'synthetic-session' });
    expect(cacheRetentionEventFromRecord({ sessionDigest: digest, observedAtMs: START + 30 * 60_000,
      orderKey: row.occurrenceId, recordJson: row.recordJson! })).toEqual(prepared.cacheItems[0]);
  });
});
