/** Durable, day-local effective evidence shared by the daily, scalar, model,
 * and cache lanes. No source record JSON or raw session identifier is retained. */
import type { TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from './canonical-json';
import { cacheRetentionEventFromRecordValue, cacheRetentionSessionDigest } from './cache-retention-events';
import { CACHE_RETENTION_METHOD, validCacheRetentionEvent, validCacheRetentionSessionBreak,
  type CacheRetentionItem } from './cache-retention-values';
import { COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from './community-daily-spend';
import { COMPOSITION_CACHE_KEY_SUFFIX } from './community-allowance';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, mapEffectiveQuotaRecord,
  validEffectiveQuotaDay, validEffectiveQuotaDayPending, type EffectiveQuotaDay,
  type EffectiveQuotaDayPending } from './effective-quota-day';
import { appendEffectiveUsageDay, mapEffectiveUsageRecord, validEffectiveUsageDay,
  validEffectiveUsageDayPending, type EffectiveUsageDay, type EffectiveUsageDayPending } from './effective-usage-day';
import { GRAPH_DAY_PROJECTION_VERSION } from './graph-day-projection-values';
import { prepareV11UsageFeature, prepareV11UsageRowInputs, validV11UsageFeature, V11_PREPARED_USAGE_FEATURE_METHOD,
  type V11PreparedUsageFeature } from './quota-analysis-v11';
import { type EffectiveTelemetryOccurrence, type EffectiveTelemetryStream,
  EFFECTIVE_USAGE_READER_METHOD, type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';
import { createV11DailyProjectionValues, foldPreparedV11DailyProjectionValues, prepareV11DailyProjectionRecord, validateV11DailyProjectionValues,
  V11_DAILY_VALUES_SCHEMA, type V11DailyProjectionValues } from './v11-daily-projection-values';

export const SHARED_ANALYTICS_FEATURE_SCHEMA = 'shared-analytics-feature-day-v1';
/** Every producer method that can alter one retained field belongs here. */
export const SHARED_ANALYTICS_FEATURE_METHOD = Object.freeze({
  version: SHARED_ANALYTICS_FEATURE_SCHEMA,
  daily: V11_DAILY_VALUES_SCHEMA,
  dailyPricing: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  dailyRegistry: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  scalarPricing: COMPOSITION_CACHE_KEY_SUFFIX,
  scalarUsage: V11_PREPARED_USAGE_FEATURE_METHOD,
  graphDay: GRAPH_DAY_PROJECTION_VERSION,
  effectiveReader: EFFECTIVE_USAGE_READER_METHOD,
  cache: CACHE_RETENTION_METHOD,
});
export const SHARED_ANALYTICS_FEATURE_MAX_ROWS = 6_000;
export const SHARED_ANALYTICS_FEATURE_MAX_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000, QUOTA_WINDOW_MINUTES = 10_080;
const STREAMS = ['usage', 'quota', 'session'] as const;
const HASH = /^[a-f0-9]{64}$/u;
const size = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).byteLength;
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function dayStart(day: string): number {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isSafeInteger(at)
    || new Date(at).toISOString().slice(0, 10) !== day) throw new SharedFeatureRefused('invalid_day');
  return at;
}
export class SharedFeatureRefused extends Error {
  constructor(readonly reason: string) { super(`SHARED_FEATURE_REFUSED:${reason}`); }
}
export interface SharedAnalyticsFeatureDay {
  readonly schemaVersion: typeof SHARED_ANALYTICS_FEATURE_SCHEMA;
  readonly day: string;
  readonly ownerDigest: string;
  readonly daily: V11DailyProjectionValues;
  readonly quota: EffectiveQuotaDay;
  readonly modelUsage: EffectiveUsageDay;
  readonly scalarUsage: readonly V11PreparedUsageFeature[];
  readonly cacheItems: readonly CacheRetentionItem[];
  readonly cacheEventsRead: number;
}
/** A source-record-free checkpoint. Only `after.occurrenceId` is the admitted
 * opaque source pagination cursor; it is confined to pending work and removed
 * from completed feature values. It can resume after a new Worker isolate. */
export interface SharedAnalyticsFeaturePending {
  readonly schemaVersion: typeof SHARED_ANALYTICS_FEATURE_SCHEMA;
  readonly day: string;
  readonly ownerDigest: string;
  readonly streamIndex: number;
  readonly after: EffectiveUsageReaderCursor | null;
  readonly daily: V11DailyProjectionValues;
  readonly quotaPending: EffectiveQuotaDayPending | null;
  readonly usagePending: EffectiveUsageDayPending | null;
  readonly scalarUsage: readonly V11PreparedUsageFeature[];
  readonly cacheItems: readonly CacheRetentionItem[];
  readonly cacheEventsRead: number;
  readonly sourceRowsRead: number;
}
function validItems(items: unknown): items is readonly CacheRetentionItem[] {
  return Array.isArray(items) && items.length <= SHARED_ANALYTICS_FEATURE_MAX_ROWS
    && items.every(item => validCacheRetentionEvent(item) || validCacheRetentionSessionBreak(item));
}
function validScalar(rows: unknown, day: string): rows is readonly V11PreparedUsageFeature[] {
  if (!Array.isArray(rows) || rows.length > SHARED_ANALYTICS_FEATURE_MAX_ROWS) return false;
  const from = dayStart(day), through = from + DAY_MS;
  let priorTime = -1, priorId = '';
  for (const row of rows) {
    if (!validV11UsageFeature(row) || row.observedAtMs < from || row.observedAtMs >= through
      || row.observedAtMs < priorTime
      || row.observedAtMs === priorTime && row.occurrenceId <= priorId) return false;
    priorTime = row.observedAtMs; priorId = row.occurrenceId;
  }
  return true;
}
function validDaily(value: unknown, day: string): value is V11DailyProjectionValues {
  try { validateV11DailyProjectionValues(value); return value.day === day; } catch { return false; }
}
export function validSharedAnalyticsFeaturePending(value: unknown): value is SharedAnalyticsFeaturePending {
  if (!closed(value, ['schemaVersion','day','ownerDigest','streamIndex','after','daily','quotaPending',
    'usagePending','scalarUsage','cacheItems','cacheEventsRead','sourceRowsRead'])
    || value.schemaVersion !== SHARED_ANALYTICS_FEATURE_SCHEMA || !HASH.test(String(value.ownerDigest))
    || !Number.isSafeInteger(value.streamIndex) || (value.streamIndex as number) < 0
    || (value.streamIndex as number) > STREAMS.length
    || !Number.isSafeInteger(value.cacheEventsRead) || (value.cacheEventsRead as number) < 0
    || !Number.isSafeInteger(value.sourceRowsRead) || (value.sourceRowsRead as number) < 0
    || (value.sourceRowsRead as number) > SHARED_ANALYTICS_FEATURE_MAX_ROWS) return false;
  try { dayStart(String(value.day)); } catch { return false; }
  const day = value.day as string;
  if (!validDaily(value.daily, day)
    || value.quotaPending !== null && (!validEffectiveQuotaDayPending(value.quotaPending)
      || value.quotaPending.day !== day)
    || value.usagePending !== null && (!validEffectiveUsageDayPending(value.usagePending)
      || value.usagePending.projection.day !== day)
    || !validScalar(value.scalarUsage, day) || !validItems(value.cacheItems)
    || value.cacheEventsRead !== value.scalarUsage.length
    || value.usagePending !== null
      && value.usagePending.projection.usage.rowsRead !== value.cacheEventsRead
    || value.after !== null && (!closed(value.after, ['observedAtMs','occurrenceId'])
      || !Number.isSafeInteger(value.after.observedAtMs)
      || typeof value.after.occurrenceId !== 'string'
      || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value.after.occurrenceId))
    || value.streamIndex === STREAMS.length && value.after !== null) return false;
  return size(value) <= SHARED_ANALYTICS_FEATURE_MAX_BYTES;
}
export function validSharedAnalyticsFeatureDay(value: unknown): value is SharedAnalyticsFeatureDay {
  if (!closed(value, ['schemaVersion','day','ownerDigest','daily','quota','modelUsage','scalarUsage',
    'cacheItems','cacheEventsRead']) || value.schemaVersion !== SHARED_ANALYTICS_FEATURE_SCHEMA
    || !HASH.test(String(value.ownerDigest))
    || !Number.isSafeInteger(value.cacheEventsRead) || (value.cacheEventsRead as number) < 0) return false;
  try { dayStart(String(value.day)); } catch { return false; }
  const day = value.day as string;
  return validDaily(value.daily, day) && validEffectiveQuotaDay(value.quota)
    && value.quota.projection.day === day && validEffectiveUsageDay(value.modelUsage)
    && value.modelUsage.projection.day === day && validScalar(value.scalarUsage, day)
    && validItems(value.cacheItems) && value.cacheEventsRead === value.scalarUsage.length
    && value.modelUsage.projection.usage.rowsRead === value.cacheEventsRead
    && size(value) <= SHARED_ANALYTICS_FEATURE_MAX_BYTES;
}
export function createSharedAnalyticsFeaturePending(day: string, ownerDigest: string): SharedAnalyticsFeaturePending {
  dayStart(day);
  if (!HASH.test(ownerDigest)) throw new SharedFeatureRefused('invalid_owner');
  return { schemaVersion: SHARED_ANALYTICS_FEATURE_SCHEMA, day, ownerDigest, streamIndex: 0,
    after: null, daily: createV11DailyProjectionValues(day), quotaPending: null,
    usagePending: null, scalarUsage: [], cacheItems: [], cacheEventsRead: 0, sourceRowsRead: 0 };
}
/** One complete effective source page. Raw records exist only during this call. */
export async function appendSharedAnalyticsFeaturePage(pending: SharedAnalyticsFeaturePending,
  stream: EffectiveTelemetryStream, rows: readonly EffectiveTelemetryOccurrence[],
  next: EffectiveUsageReaderCursor | null): Promise<SharedAnalyticsFeaturePending> {
  if (!validSharedAnalyticsFeaturePending(pending) || STREAMS[pending.streamIndex] !== stream
    || rows.length > 200 || rows.length === 0 && next !== null) throw new SharedFeatureRefused('invalid_page');
  const start = dayStart(pending.day);
  let previousTime = pending.after?.observedAtMs ?? -1, previousId = pending.after?.occurrenceId ?? '';
  let daily = pending.daily;
  const records: TelemetryV11Record[] = [];
  for (const row of rows) {
    const time = row.eventTime === null ? NaN : Date.parse(row.eventTime);
    if (row.ownerDigest !== pending.ownerDigest || row.stream !== stream
      || row.status !== 'compatible' || row.recordJson === null || row.eventTimeConflict
      || !Number.isSafeInteger(time) || time < start || time >= start + DAY_MS
      || time < previousTime || time === previousTime && row.occurrenceId <= previousId) {
      throw new SharedFeatureRefused('source_conflict_or_order');
    }
    const prepared = prepareV11DailyProjectionRecord('v11', JSON.parse(row.recordJson));
    // One-record folds preserve the native lexical top-K/refusal behavior.
    daily = foldPreparedV11DailyProjectionValues(daily, [prepared]);
    records.push(prepared.record as TelemetryV11Record);
    previousTime = time; previousId = row.occurrenceId;
  }
  const sourceRowsRead = pending.sourceRowsRead + rows.length;
  if (sourceRowsRead > SHARED_ANALYTICS_FEATURE_MAX_ROWS) throw new SharedFeatureRefused('day_row_limit');
  let quotaPending = pending.quotaPending, usagePending = pending.usagePending;
  const scalarUsage = [...pending.scalarUsage], cacheItems = [...pending.cacheItems];
  let cacheEventsRead = pending.cacheEventsRead;
  if (stream === 'quota') {
    const offset = quotaPending?.quotaRowsRead ?? 0;
    quotaPending = appendEffectiveQuotaDay(quotaPending, pending.day,
      rows.map((row, index) => mapEffectiveQuotaRecord(row, pending.day, offset + index + 1, records[index]!)),
      QUOTA_WINDOW_MINUTES);
    if (quotaPending === null) throw new SharedFeatureRefused('quota_day_limit');
  } else if (stream === 'usage') {
    const usageRows = rows.map((row,index) => mapEffectiveUsageRecord(row,records[index]!));
    const usageInputs = usageRows.map((row,index) => prepareV11UsageRowInputs(row,
      records[index] as unknown as Record<string,unknown>));
    usagePending = await appendEffectiveUsageDay(usagePending, pending.day, usageRows, pending.ownerDigest,usageInputs);
    if (usagePending === null) throw new SharedFeatureRefused('usage_day_limit');
    for (const [index, row] of rows.entries()) {
      const usage = usageRows[index]!;
      // The source ID is needed only until this page has been ordered. A
      // fixed-width day ordinal preserves equal-time order for both consumers.
      const orderKey = `ord:${String(cacheEventsRead+index+1).padStart(6,'0')}`;
      scalarUsage.push({...await prepareV11UsageFeature(usage, pending.ownerDigest,usageInputs[index]),
        occurrenceId:orderKey});
      const record = records[index] as unknown as Record<string,unknown>;
      if (typeof record.provider !== 'string' || typeof record.sessionUuid !== 'string'
        || record.sessionUuid.length === 0) throw new SharedFeatureRefused('cache_row_unavailable');
      const sessionDigest = await cacheRetentionSessionDigest({ownerDigest: pending.ownerDigest,
        provider: record.provider, sessionUuid: record.sessionUuid});
      const item = cacheRetentionEventFromRecordValue({sessionDigest, observedAtMs: Date.parse(row.eventTime!),
        orderKey},record);
      if (item !== null) cacheItems.push(item);
    }
    cacheEventsRead += rows.length;
  }
  if (next !== null && (next.observedAtMs !== previousTime || next.occurrenceId !== previousId))
    throw new SharedFeatureRefused('source_cursor_invalid');
  const result: SharedAnalyticsFeaturePending = { ...pending, daily, quotaPending, usagePending,
    scalarUsage, cacheItems, cacheEventsRead, sourceRowsRead,
    streamIndex: next === null ? pending.streamIndex + 1 : pending.streamIndex,
    after: next };
  if (!validSharedAnalyticsFeaturePending(result)) throw new SharedFeatureRefused('day_feature_limit');
  return result;
}
export async function finishSharedAnalyticsFeatureDay(pending: SharedAnalyticsFeaturePending):
Promise<SharedAnalyticsFeatureDay> {
  if (!validSharedAnalyticsFeaturePending(pending) || pending.streamIndex !== STREAMS.length)
    throw new SharedFeatureRefused('incomplete_day');
  const quotaPending = pending.quotaPending
    ?? appendEffectiveQuotaDay(null, pending.day, [], QUOTA_WINDOW_MINUTES);
  const usagePending = pending.usagePending
    ?? await appendEffectiveUsageDay(null, pending.day, [], pending.ownerDigest);
  if (!quotaPending || !usagePending) throw new SharedFeatureRefused('day_unrepresentable');
  const quota = finishEffectiveQuotaDay(quotaPending);
  if (!quota) throw new SharedFeatureRefused('quota_day_limit');
  const value: SharedAnalyticsFeatureDay = { schemaVersion: SHARED_ANALYTICS_FEATURE_SCHEMA,
    day: pending.day, ownerDigest: pending.ownerDigest,
    daily: pending.daily, quota,
    modelUsage: { projection: usagePending.projection }, scalarUsage: pending.scalarUsage,
    cacheItems: pending.cacheItems, cacheEventsRead: pending.cacheEventsRead };
  if (!validSharedAnalyticsFeatureDay(value)) throw new SharedFeatureRefused('day_feature_limit');
  return value;
}
