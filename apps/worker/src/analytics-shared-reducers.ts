/**
 * Local, bounded shared-input experiment. The caller supplies complete, fenced
 * effective owner-day occurrence sets. Nothing here reads or writes a database,
 * promotes a cache head, or changes an analytical method. In particular,
 * `usageRows` is a transient input to the existing scalar finisher: it contains
 * source record JSON and must never be persisted or included in a report.
 */
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow, type EffectiveQuotaDay, type EffectiveQuotaDayPending } from './effective-quota-day';
import { appendEffectiveUsageDay, effectiveUsageWindowRepresentable,
  mapEffectiveUsagePageRow, type EffectiveUsageDay, type EffectiveUsageDayPending } from './effective-usage-day';
import { cacheRetentionEventFromRecord, cacheRetentionSessionDigest } from './cache-retention-day';
import { CACHE_RETENTION_METHOD, reduceCacheRetentionDay,
  type CacheRetentionDayAggregate, type CacheRetentionEvent, type CacheRetentionItem } from './cache-retention-values';
import { selectCommunityAllowanceAnalysisFits, type CommunityAllowanceFit } from './community-allowance';
import { modelHistoryWindow } from './model-history-window';
import { advanceV11UsageReduction, createV11QuotaAcquisitionIdentity,
  finishV11UsageReduction, foldV11UsageModelReduction, type UsageRow } from './quota-analysis-v11';
import { type V11CompletedQuotaAcquisition } from './quota-analysis-v11-reader';
import { type V11SourcePin } from './telemetry-v11-domain';
import { type EffectiveTelemetryOccurrence, type EffectiveTelemetryStream } from './telemetry-usage-effective-reader';
import { createV11DailyProjectionValues, finalizeV11DailyProjectionValues,
  foldV11DailyProjectionValues } from './v11-daily-projection-values';

const DAY_MS = 86_400_000;
const QUOTA_WINDOW_MINUTES = 10_080;
const PAGE_SIZE = 200;
const MAX_DAY_OCCURRENCES = 20_000;
const MAX_DAY_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_WINDOW_DAYS = 101;
const MAX_WINDOW_USAGE_ROWS = 120_000;
const unexpectedDatabaseRead = (): never => {
  throw new Error('SHARED_ANALYTICS_UNEXPECTED_DATABASE_READ');
};
const noDb: D1Database = { prepare: unexpectedDatabaseRead, batch: unexpectedDatabaseRead,
  exec: unexpectedDatabaseRead, withSession: unexpectedDatabaseRead, dump: unexpectedDatabaseRead };

export class SharedAnalyticsUnavailable extends Error {
  constructor(readonly reason: string) { super(`SHARED_ANALYTICS_UNAVAILABLE:${reason}`); }
}

export interface SharedAnalyticsDay {
  readonly day: string;
  readonly ownerDigest: string;
  readonly daily: ReturnType<typeof finalizeV11DailyProjectionValues>;
  readonly quota: EffectiveQuotaDay;
  readonly modelUsage: EffectiveUsageDay;
  readonly cacheItems: readonly CacheRetentionItem[];
  readonly cacheEventsRead: number;
  /** Transient only: current scalar reduction has no prepriced-event seam. */
  readonly usageRows: readonly UsageRow[];
}

export interface SharedAnalyticsDayInput {
  readonly day: string;
  readonly ownerDigest: string;
  readonly usage: readonly EffectiveTelemetryOccurrence[];
  readonly quota: readonly EffectiveTelemetryOccurrence[];
  readonly session: readonly EffectiveTelemetryOccurrence[];
}

function checkedDay(day: string): number {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isSafeInteger(start)
    || new Date(start).toISOString().slice(0, 10) !== day) throw new SharedAnalyticsUnavailable('invalid_day');
  return start;
}

function checkedRows(input: SharedAnalyticsDayInput, stream: EffectiveTelemetryStream,
  rows: readonly EffectiveTelemetryOccurrence[], start: number): void {
  let previousTime = -Infinity, previousId = '';
  const ids = new Set<string>();
  for (const row of rows) {
    const at = row.eventTime === null ? NaN : Date.parse(row.eventTime);
    if (row.stream !== stream || row.ownerDigest !== input.ownerDigest
      || row.status !== 'compatible' || row.recordJson === null || row.eventTimeConflict
      || !Number.isSafeInteger(at) || at < start || at >= start + DAY_MS
      || typeof row.occurrenceId !== 'string' || row.occurrenceId.length === 0
      || ids.has(row.occurrenceId) || at < previousTime || at === previousTime && row.occurrenceId <= previousId) {
      throw new SharedAnalyticsUnavailable('source_conflict_or_order');
    }
    ids.add(row.occurrenceId);
    previousTime = at; previousId = row.occurrenceId;
  }
}

/** Prepare each expensive day-local kernel once from the same effective rows. */
export async function prepareSharedAnalyticsDay(input: SharedAnalyticsDayInput): Promise<SharedAnalyticsDay> {
  const start = checkedDay(input.day);
  if (!/^[0-9a-f]{64}$/u.test(input.ownerDigest)) throw new SharedAnalyticsUnavailable('invalid_owner');
  const total = input.usage.length + input.quota.length + input.session.length;
  if (total > MAX_DAY_OCCURRENCES) throw new SharedAnalyticsUnavailable('day_row_limit');
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [stream, rows] of [['usage', input.usage], ['quota', input.quota],
    ['session', input.session]] as const) {
    checkedRows(input, stream, rows, start);
    for (const row of rows) bytes += encoder.encode(row.recordJson!).byteLength;
  }
  if (bytes > MAX_DAY_RECORD_BYTES) throw new SharedAnalyticsUnavailable('day_byte_limit');

  let daily = createV11DailyProjectionValues(input.day);
  for (const rows of [input.usage, input.quota, input.session]) {
    // Match the effective daily reader's one-record folds. This avoids a
    // page-local model-cell limit changing the lexical top-K selection.
    for (const row of rows) daily = foldV11DailyProjectionValues(daily, [JSON.parse(row.recordJson!)]);
  }

  let quotaPending: EffectiveQuotaDayPending | null = null;
  for (let offset = 0; offset < input.quota.length; offset += PAGE_SIZE) {
    const rows = input.quota.slice(offset, offset + PAGE_SIZE)
      .map((row, index) => mapEffectiveQuotaPageRow(row, input.day, offset + index + 1));
    quotaPending = appendEffectiveQuotaDay(quotaPending, input.day, rows, QUOTA_WINDOW_MINUTES);
    if (quotaPending === null) throw new SharedAnalyticsUnavailable('quota_day_unrepresentable');
  }
  quotaPending ??= appendEffectiveQuotaDay(null, input.day, [], QUOTA_WINDOW_MINUTES);
  if (quotaPending === null) throw new SharedAnalyticsUnavailable('quota_day_unrepresentable');
  const quota = finishEffectiveQuotaDay(quotaPending);
  if (quota === undefined) throw new SharedAnalyticsUnavailable('quota_day_unrepresentable');

  const usageRows = input.usage.map(mapEffectiveUsagePageRow);
  let usagePending: EffectiveUsageDayPending | null = null;
  for (let offset = 0; offset < usageRows.length; offset += PAGE_SIZE) {
    usagePending = await appendEffectiveUsageDay(usagePending, input.day,
      usageRows.slice(offset, offset + PAGE_SIZE), input.ownerDigest);
    if (usagePending === null) throw new SharedAnalyticsUnavailable('usage_day_unrepresentable');
  }
  usagePending ??= await appendEffectiveUsageDay(null, input.day, [], input.ownerDigest);
  if (usagePending === null) throw new SharedAnalyticsUnavailable('usage_day_unrepresentable');

  const cacheItems: CacheRetentionItem[] = [];
  for (const row of input.usage) {
    const record = JSON.parse(row.recordJson!) as Record<string, unknown>;
    if (typeof record.provider !== 'string' || typeof record.sessionUuid !== 'string'
      || record.sessionUuid.length === 0) throw new SharedAnalyticsUnavailable('cache_usage_row_refused');
    const sessionDigest = await cacheRetentionSessionDigest({ ownerDigest: input.ownerDigest,
      provider: record.provider, sessionUuid: record.sessionUuid });
    const item = cacheRetentionEventFromRecord({ sessionDigest,
      observedAtMs: Date.parse(row.eventTime!), orderKey: row.occurrenceId, recordJson: row.recordJson! });
    if (item !== null) cacheItems.push(item);
  }
  return { day: input.day, ownerDigest: input.ownerDigest,
    daily: finalizeV11DailyProjectionValues(daily), quota,
    modelUsage: { projection: usagePending.projection }, cacheItems,
    cacheEventsRead: input.usage.length, usageRows };
}

function completeWindow(pin: V11SourcePin, day: string,
  days: readonly SharedAnalyticsDay[]): SharedAnalyticsDay[] {
  const end = checkedDay(day), pinStart = checkedDay(pin.fromDay), pinEnd = checkedDay(pin.throughDay);
  const target = modelHistoryWindow(day), start = Math.max(pinStart,
    Date.parse(target.observedAtCutoff));
  if (pin.source !== 'v1.1' || pinEnd !== end || pinStart > end) {
    throw new SharedAnalyticsUnavailable('window_pin_or_capacity');
  }
  const byDay = new Map<string, SharedAnalyticsDay>();
  for (const value of days) {
    if (byDay.has(value.day)) throw new SharedAnalyticsUnavailable('duplicate_day');
    byDay.set(value.day, value);
  }
  const selected: SharedAnalyticsDay[] = [];
  for (let at = start; at <= end; at += DAY_MS) {
    const label = new Date(at).toISOString().slice(0, 10), value = byDay.get(label);
    if (value === undefined) throw new SharedAnalyticsUnavailable('incomplete_window');
    selected.push(value);
  }
  if (selected.length > MAX_WINDOW_DAYS) throw new SharedAnalyticsUnavailable('window_capacity');
  return selected;
}

function quotaForDate(pin: V11SourcePin, day: string, days: readonly SharedAnalyticsDay[]) {
  const identity = createV11QuotaAcquisitionIdentity(pin, Date.parse(modelHistoryWindow(day).fixedNow));
  const quotaDays = days.filter(value => value.quota.quotaRowsRead > 0).map(value => value.quota);
  const folded = foldEffectiveQuotaDays(identity, quotaDays,
    quotaDays.map(value => value.projection.day));
  if (folded === undefined || folded.status === 'deferred') {
    throw new SharedAnalyticsUnavailable('quota_window_unrepresentable');
  }
  return folded;
}

function usageReader(days: readonly SharedAnalyticsDay[]) {
  const byDay = new Map(days.map(day => [day.day, day.usageRows]));
  return {
    days: days.filter(day => day.usageRows.length > 0).map(day => day.day),
    async readPage({ day, afterTime, afterOccurrence }: {
      day: string; afterTime: string; afterOccurrence: string;
    }) {
      const rows = byDay.get(day);
      if (rows === undefined) throw new SharedAnalyticsUnavailable('usage_day_absent');
      const index = rows.findIndex(row => row.observed_at > afterTime
        || row.observed_at === afterTime && row.occurrence_id > afterOccurrence);
      const page = index < 0 ? [] : rows.slice(index, index + PAGE_SIZE);
      return { rows: page, complete: index < 0 || index + page.length >= rows.length };
    },
  };
}

/** Current effective-owner scalar fit path. The unchanged finisher still prices
 * raw usage rows. Pure-v1 legacy open-ended acquisition has separate semantics
 * and is outside this experiment; this is not its production replacement. */
export async function evaluateSharedScalarDate(input: { pin: V11SourcePin; day: string;
  ownerDigest: string; days: readonly SharedAnalyticsDay[] }): Promise<{
    analysis: object; selectedFits: CommunityAllowanceFit[];
  }> {
  const selected = completeWindow(input.pin, input.day, input.days);
  if (selected.some(value => value.ownerDigest !== input.ownerDigest)) {
    throw new SharedAnalyticsUnavailable('owner_mismatch');
  }
  const folded = quotaForDate(input.pin, input.day, selected);
  if (folded.status === 'not_testable') return { analysis: { status: 'not_testable', reason: folded.reason,
    tracks: [] }, selectedFits: [] };
  const quotaAcquisition: V11CompletedQuotaAcquisition = { identity: folded.identity,
    planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
  const options = { nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
    quotaAcquisition, effectiveUsageReader: usageReader(selected), scalarRequested: true };
  const rows = selected.reduce((sum, value) => sum + value.usageRows.length, 0);
  if (rows > MAX_WINDOW_USAGE_ROWS) throw new SharedAnalyticsUnavailable('usage_window_unrepresentable');
  const state = await advanceV11UsageReduction(noDb, input.pin, options,
    { remainingQueries: 1_024, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 }, null, 1_024);
  if (!state.complete) throw new SharedAnalyticsUnavailable('usage_window_unrepresentable');
  const analysis = await finishV11UsageReduction(noDb, input.pin, options, state, 'fits');
  const selectedFits = selectCommunityAllowanceAnalysisFits(input.ownerDigest,
    [{ source: 'v1.1', analysis: analysis as Parameters<typeof selectCommunityAllowanceAnalysisFits>[1][number]['analysis'] }]);
  return { analysis, selectedFits };
}

/** Historical model dates reuse the already priced two-hour day fragments. */
export async function evaluateSharedModelDate(input: { pin: V11SourcePin; day: string;
  ownerDigest: string; days: readonly SharedAnalyticsDay[] }): Promise<object> {
  const selected = completeWindow(input.pin, input.day, input.days);
  if (selected.some(value => value.ownerDigest !== input.ownerDigest)) {
    throw new SharedAnalyticsUnavailable('owner_mismatch');
  }
  const folded = quotaForDate(input.pin, input.day, selected);
  if (folded.status === 'not_testable') return { status: 'not_testable', reason: folded.reason, tracks: [] };
  const rows = selected.reduce((sum, value) => sum + value.usageRows.length, 0);
  if (rows > MAX_WINDOW_USAGE_ROWS) throw new SharedAnalyticsUnavailable('usage_window_unrepresentable');
  const quotaAcquisition: V11CompletedQuotaAcquisition = { identity: folded.identity,
    planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
  const modelDays = selected.filter(value => value.modelUsage.projection.usage.rowsRead > 0)
    .map(value => ({ day: value.day, usage: value.modelUsage.projection.usage }));
  const options = { nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
    quotaAcquisition, scalarRequested: false };
  const state = effectiveUsageWindowRepresentable(selected.map(value => value.modelUsage))
    ? await foldV11UsageModelReduction(noDb, input.pin, options, modelDays,
      modelDays.map(value => value.day))
    : await advanceV11UsageReduction(noDb, input.pin,
      { ...options, effectiveUsageReader: usageReader(selected) },
      { remainingQueries: 1_024, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 }, null, 1_024);
  if (!state.complete) throw new SharedAnalyticsUnavailable('usage_window_unrepresentable');
  return finishV11UsageReduction(noDb, input.pin, options, state, 'model');
}

/** Exact existing seven-day carry and destination-day cache reducer. */
export function evaluateSharedCacheDay(input: { day: string; ownerDigest: string;
  days: readonly SharedAnalyticsDay[] }): CacheRetentionDayAggregate {
  const start = checkedDay(input.day), byDay = new Map(input.days.map(value => [value.day, value]));
  if (byDay.size !== input.days.length) throw new SharedAnalyticsUnavailable('duplicate_day');
  const own = byDay.get(input.day);
  if (own === undefined || own.ownerDigest !== input.ownerDigest) {
    throw new SharedAnalyticsUnavailable('incomplete_cache_day');
  }
  const sessions = new Set(own.cacheItems.map(item => item.sessionDigest));
  const tail = new Map<string, CacheRetentionEvent>();
  for (let back = CACHE_RETENTION_METHOD.lookbackDays; back >= 1; back -= 1) {
    const day = new Date(start - back * DAY_MS).toISOString().slice(0, 10);
    const value = byDay.get(day);
    if (value === undefined || value.ownerDigest !== input.ownerDigest) {
      throw new SharedAnalyticsUnavailable('incomplete_cache_lookback');
    }
    for (const item of value.cacheItems) {
      if (!sessions.has(item.sessionDigest)) continue;
      if ('unreadable' in item) tail.delete(item.sessionDigest);
      else tail.set(item.sessionDigest, item);
    }
  }
  return reduceCacheRetentionDay({ day: input.day, events: own.cacheItems,
    carry: [...tail.values()], eventsRead: own.cacheEventsRead });
}
