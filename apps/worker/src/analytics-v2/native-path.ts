/**
 * analytics-v2 native path: the in-memory form of d43c8f92's native effective
 * analysis, for the owner-days and windows that the shared reducers refuse at
 * their own bounds.
 *
 * Background. The shared reducers (vendored analytics-shared-reducers.ts) are
 * a d43c8f92 local experiment ("No scheduled handler or public route imports
 * this module", analytics-shared-input.ts). They refuse a day over 20,000
 * occurrences or 32 MiB, a 101-day window over 120,000 usage rows, a window
 * that needs more than 1,024 usage pages in one call, a day whose optional
 * quota or usage preparation reaches its bound, and a window whose quota fold
 * is refused. Production's live graph lane does not refuse at these bounds.
 * storage-community-graph.ts computeEffective falls back to
 * storage-effective-history.ts advanceStorageEffectiveAnalysis ("Unrepresentable
 * or pre-migration days retain the native calculation"), which:
 *
 * - acquires quota by folding prepared days when every quota day of the
 *   window is prepared and foldEffectiveQuotaDays accepts the window, and
 *   otherwise by the paged advanceV11QuotaAcquisition: 200-row, day-aligned
 *   pages per acquisition phase, with a window-cumulative ordinal that
 *   restarts at each phase;
 * - reduces usage for a model date by folding prepared usage days when every
 *   day is prepared and the window is representable, and otherwise by the
 *   paged advanceV11UsageReduction, resumed from its checkpoint until it is
 *   complete; a scalar fit always uses the paged reduction;
 * - finishes with finishV11UsageReduction.
 *
 * Production's daily lane (storage-community-daily.ts) folds every record of
 * an owner-day with no day bound.
 *
 * This module composes the same exported kernel steps in memory. vendor/
 * carries no GCP edit beyond the generator's export tokens and its reviewed,
 * semantics-preserving source patches (vendor-analytics-kernels.mjs
 * SOURCE_PATCHES). The bounds that do apply are:
 * - every kernel bound inside those steps (1,000,000 windowed usage rows,
 *   100,000 sessions, the 8 MiB reduction checkpoint, the quota and plan
 *   limits). These define production's published answer, so they stay;
 * - the GCP day backstop (resources.ts AnalyticsV2DayLimits), which replaces
 *   the experiment's 20,000-row and 32 MiB day bounds and refuses with the
 *   same reasons (day_row_limit, day_byte_limit).
 *
 * The vendored shared reducers still run first, so every owner-day and window
 * they answer keeps exactly their result. This module runs only where they
 * refuse with one of the bound reasons above. analytics-v2-test/
 * native-parity.spec.ts compares it with the vendored
 * advanceStorageEffectiveAnalysis, driven over the same occurrences through a
 * stand-in for its D1 reader, for one synthetic owner beyond each bound.
 *
 * Pure apart from WebCrypto hashing inside the kernels. No I/O.
 */
import {
  advanceV11QuotaAcquisition,
  advanceV11UsageReduction,
  appendEffectiveQuotaDay,
  appendEffectiveUsageDay,
  cacheRetentionEventFromRecord,
  cacheRetentionSessionDigest,
  createV11DailyProjectionValues,
  createV11QuotaAcquisitionCheckpoint,
  createV11QuotaAcquisitionIdentity,
  effectiveUsageWindowRepresentable,
  evaluateSharedCacheDay,
  evaluateSharedModelDate,
  evaluateSharedScalarDate,
  finalizeV11DailyProjectionValues,
  finishEffectiveQuotaDay,
  finishV11UsageReduction,
  foldEffectiveQuotaDays,
  foldV11DailyProjectionValues,
  foldV11UsageModelReduction,
  mapEffectiveQuotaPageRow,
  mapEffectiveUsagePageRow,
  modelHistoryWindow,
  prepareSharedAnalyticsDay,
  selectCommunityAllowanceAnalysisFits,
  SharedAnalyticsUnavailable,
  type CacheRetentionDayAggregate,
  type CacheRetentionItem,
  type CommunityAllowanceFit,
  type EffectiveQuotaDay,
  type EffectiveQuotaDayPending,
  type EffectiveTelemetryOccurrence,
  type EffectiveTelemetryStream,
  type EffectiveUsageDay,
  type EffectiveUsageDayPending,
  type SharedAnalyticsDay,
  type SharedAnalyticsDayInput,
  type UsageRow,
  type V11CompletedQuotaAcquisition,
  type V11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionIdentity,
  type V11QuotaPageReader,
  type V11SourcePin,
  type V11UsageReductionCheckpoint,
} from "../../vendor/analytics-d43c8f92/entry";
import type { AnalyticsV2DayLimits } from "./resources";

const DAY_MS = 86_400_000;
/** d43c8f92 analytics-shared-reducers.ts PAGE_SIZE and the effective reader's page. */
const PAGE_SIZE = 200;
/** d43c8f92 QUOTA_WINDOW_MINUTES: the seven-day window the quota day reducer keys on. */
const QUOTA_WINDOW_MINUTES = 10_080;
/** d43c8f92 MAX_WINDOW_DAYS: modelHistoryWindow spans the day and the 100 before it. */
const MAX_WINDOW_DAYS = 101;
/** advanceV11UsageReduction's largest page group per call (quota-analysis-v11.ts:1505). */
const USAGE_PAGES_PER_CALL = 1_024;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/u;

const unexpectedDatabaseRead = (): never => {
  throw new Error("ANALYTICS_V2_NATIVE_PATH_UNEXPECTED_DATABASE_READ");
};
/**
 * Every kernel step here receives its quota acquisition and usage pages from
 * memory, so none of them reads its D1 parameter. A read is a defect.
 */
const NO_DB = {
  prepare: unexpectedDatabaseRead, batch: unexpectedDatabaseRead, exec: unexpectedDatabaseRead,
  withSession: unexpectedDatabaseRead, dump: unexpectedDatabaseRead,
} as unknown as D1Database;

/**
 * One prepared owner-day. It is the vendored SharedAnalyticsDay, except that
 * `quota` or `modelUsage` is null where production's optional preparation
 * reaches its bound (effective-quota-day.ts: "a preparation limit must never
 * become an analytical refusal"); the window evaluation then pages that day.
 */
export type AnalyticsV2PreparedDay = Omit<SharedAnalyticsDay, "quota" | "modelUsage"> & {
  readonly quota: EffectiveQuotaDay | null;
  readonly modelUsage: EffectiveUsageDay | null;
};

/** What the cache reducer reads of a prepared day (vendored evaluateSharedCacheDay). */
export type AnalyticsV2CacheDay = Pick<SharedAnalyticsDay, "day" | "ownerDigest" | "cacheItems" | "cacheEventsRead">;

/**
 * The vendored prepare refusals that production's native path does not raise:
 * the experiment's day bounds (the daily lane folds any day) and the optional
 * quota and usage preparation bounds (the graph lane pages such a day).
 */
const NATIVE_PREPARE_REASONS: ReadonlySet<string> = new Set([
  "day_row_limit", "day_byte_limit", "quota_day_unrepresentable", "usage_day_unrepresentable",
]);
/**
 * The vendored window refusals that production's native path does not raise:
 * the 120,000-row window gate and the single 1,024-page reduction call
 * (usage_window_unrepresentable), and a refused quota fold, which native
 * replaces with the paged acquisition (quota_window_unrepresentable).
 */
const NATIVE_WINDOW_REASONS: ReadonlySet<string> = new Set([
  "usage_window_unrepresentable", "quota_window_unrepresentable",
]);

function isRefusal(error: unknown, reasons: ReadonlySet<string>): boolean {
  return error instanceof SharedAnalyticsUnavailable && reasons.has(error.reason);
}

/** True for a day the vendored shared reducers can take as it is. */
export function isSharedAnalyticsDay(day: AnalyticsV2PreparedDay): day is SharedAnalyticsDay {
  return day.quota !== null && day.modelUsage !== null;
}

// ---------------------------------------------------------------------------
// Day preparation
// ---------------------------------------------------------------------------

/** d43c8f92 analytics-shared-reducers.ts checkedDay. */
function checkedDay(day: string): number {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!DAY_LABEL.test(day) || !Number.isSafeInteger(start)
    || new Date(start).toISOString().slice(0, 10) !== day) throw new SharedAnalyticsUnavailable("invalid_day");
  return start;
}

/** d43c8f92 analytics-shared-reducers.ts checkedRows, unchanged. */
function checkedRows(input: SharedAnalyticsDayInput, stream: EffectiveTelemetryStream,
  rows: readonly EffectiveTelemetryOccurrence[], start: number): void {
  let previousTime = -Infinity, previousId = "";
  const ids = new Set<string>();
  for (const row of rows) {
    const at = row.eventTime === null ? NaN : Date.parse(row.eventTime);
    if (row.stream !== stream || row.ownerDigest !== input.ownerDigest
      || row.status !== "compatible" || row.recordJson === null || row.eventTimeConflict
      || !Number.isSafeInteger(at) || at < start || at >= start + DAY_MS
      || typeof row.occurrenceId !== "string" || row.occurrenceId.length === 0
      || ids.has(row.occurrenceId) || at < previousTime || at === previousTime && row.occurrenceId <= previousId) {
      throw new SharedAnalyticsUnavailable("source_conflict_or_order");
    }
    ids.add(row.occurrenceId);
    previousTime = at; previousId = row.occurrenceId;
  }
}

/**
 * The d43c8f92 shared preparation without its experiment bounds: the same
 * checks, the same one-record daily folds, the same day-local quota and usage
 * preparation and the same cache items. Where the optional quota or usage
 * preparation reaches its bound, that part is null instead of a refusal.
 * Only the GCP day backstop refuses, with the experiment's own reasons.
 */
async function prepareNativeDay(input: SharedAnalyticsDayInput, limits: AnalyticsV2DayLimits):
Promise<AnalyticsV2PreparedDay> {
  const start = checkedDay(input.day);
  if (!OWNER_DIGEST.test(input.ownerDigest)) throw new SharedAnalyticsUnavailable("invalid_owner");
  const total = input.usage.length + input.quota.length + input.session.length;
  if (total > limits.maxDayOccurrences) throw new SharedAnalyticsUnavailable("day_row_limit");
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [stream, rows] of [["usage", input.usage], ["quota", input.quota],
    ["session", input.session]] as const) {
    checkedRows(input, stream, rows, start);
    for (const row of rows) bytes += encoder.encode(row.recordJson!).byteLength;
  }
  if (bytes > limits.maxDayRecordBytes) throw new SharedAnalyticsUnavailable("day_byte_limit");

  let daily = createV11DailyProjectionValues(input.day);
  for (const rows of [input.usage, input.quota, input.session]) {
    for (const row of rows) daily = foldV11DailyProjectionValues(daily, [JSON.parse(row.recordJson!)]);
  }

  let quotaPending: EffectiveQuotaDayPending | null = null;
  let quotaBounded = false;
  for (let offset = 0; offset < input.quota.length; offset += PAGE_SIZE) {
    const rows = input.quota.slice(offset, offset + PAGE_SIZE)
      .map((row, index) => mapEffectiveQuotaPageRow(row, input.day, offset + index + 1));
    quotaPending = appendEffectiveQuotaDay(quotaPending, input.day, rows, QUOTA_WINDOW_MINUTES);
    if (quotaPending === null) { quotaBounded = true; break; }
  }
  if (!quotaBounded) {
    quotaPending ??= appendEffectiveQuotaDay(null, input.day, [], QUOTA_WINDOW_MINUTES);
    if (quotaPending === null) quotaBounded = true;
  }
  const quota = quotaBounded ? null : finishEffectiveQuotaDay(quotaPending!) ?? null;

  const usageRows = input.usage.map(mapEffectiveUsagePageRow);
  let usagePending: EffectiveUsageDayPending | null = null;
  let usageBounded = false;
  for (let offset = 0; offset < usageRows.length; offset += PAGE_SIZE) {
    usagePending = await appendEffectiveUsageDay(usagePending, input.day,
      usageRows.slice(offset, offset + PAGE_SIZE), input.ownerDigest);
    if (usagePending === null) { usageBounded = true; break; }
  }
  if (!usageBounded) {
    usagePending ??= await appendEffectiveUsageDay(null, input.day, [], input.ownerDigest);
    if (usagePending === null) usageBounded = true;
  }
  const modelUsage = usageBounded ? null : { projection: usagePending!.projection };

  const cacheItems: CacheRetentionItem[] = [];
  for (const row of input.usage) {
    const record = JSON.parse(row.recordJson!) as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.sessionUuid !== "string"
      || record.sessionUuid.length === 0) throw new SharedAnalyticsUnavailable("cache_usage_row_refused");
    const sessionDigest = await cacheRetentionSessionDigest({ ownerDigest: input.ownerDigest,
      provider: record.provider, sessionUuid: record.sessionUuid });
    const item = cacheRetentionEventFromRecord({ sessionDigest,
      observedAtMs: Date.parse(row.eventTime!), orderKey: row.occurrenceId, recordJson: row.recordJson! });
    if (item !== null) cacheItems.push(item);
  }
  return { day: input.day, ownerDigest: input.ownerDigest, daily: finalizeV11DailyProjectionValues(daily),
    quota, modelUsage, cacheItems, cacheEventsRead: input.usage.length, usageRows };
}

/**
 * Prepare one owner-day. The vendored prepareSharedAnalyticsDay answers first;
 * only its bound refusals reach the native preparation. `limits` must be at
 * least the experiment's bounds (resources.ts enforces this), so the
 * vendored success set is a subset of the native one.
 */
export async function prepareAnalyticsV2Day(input: SharedAnalyticsDayInput,
  limits: AnalyticsV2DayLimits): Promise<AnalyticsV2PreparedDay> {
  try {
    return await prepareSharedAnalyticsDay(input);
  } catch (error) {
    if (!isRefusal(error, NATIVE_PREPARE_REASONS)) throw error;
  }
  return prepareNativeDay(input, limits);
}

// ---------------------------------------------------------------------------
// Window evaluation
// ---------------------------------------------------------------------------

export interface AnalyticsV2WindowInput {
  readonly pin: V11SourcePin;
  readonly day: string;
  readonly ownerDigest: string;
  readonly days: readonly AnalyticsV2PreparedDay[];
  /**
   * The owner's effective quota occurrences of one day, in reader order
   * (eventTime, then occurrenceId). The paged acquisition reads them; a day
   * outside the evaluated window is never asked for.
   */
  readonly quotaOccurrences: (day: string) => readonly EffectiveTelemetryOccurrence[];
}

/** d43c8f92 analytics-shared-reducers.ts completeWindow, unchanged. */
function completeWindow(pin: V11SourcePin, day: string,
  days: readonly AnalyticsV2PreparedDay[]): AnalyticsV2PreparedDay[] {
  const end = checkedDay(day), pinStart = checkedDay(pin.fromDay), pinEnd = checkedDay(pin.throughDay);
  const target = modelHistoryWindow(day), start = Math.max(pinStart, Date.parse(target.observedAtCutoff));
  if (pin.source !== "v1.1" || pinEnd !== end || pinStart > end) {
    throw new SharedAnalyticsUnavailable("window_pin_or_capacity");
  }
  const byDay = new Map<string, AnalyticsV2PreparedDay>();
  for (const value of days) {
    if (byDay.has(value.day)) throw new SharedAnalyticsUnavailable("duplicate_day");
    byDay.set(value.day, value);
  }
  const selected: AnalyticsV2PreparedDay[] = [];
  for (let at = start; at <= end; at += DAY_MS) {
    const label = new Date(at).toISOString().slice(0, 10), value = byDay.get(label);
    if (value === undefined) throw new SharedAnalyticsUnavailable("incomplete_window");
    selected.push(value);
  }
  if (selected.length > MAX_WINDOW_DAYS) throw new SharedAnalyticsUnavailable("window_capacity");
  return selected;
}

/** Index of the first row after the reduction cursor; rows are strictly ordered. */
function firstRowAfter(rows: readonly UsageRow[], afterTime: string, afterOccurrence: string): number {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1, row = rows[middle]!;
    if (row.observed_at > afterTime || row.observed_at === afterTime && row.occurrence_id > afterOccurrence) {
      high = middle;
    } else low = middle + 1;
  }
  return low;
}

/**
 * The vendored shared usageReader over in-memory rows: the same days, page
 * size and completion rule as d43c8f92 analytics-shared-reducers.ts usageReader
 * and the native effective reader (complete exactly when no row follows the
 * page). checkedRows guarantees each day's rows are strictly ordered, so a
 * binary search finds the same first row as the vendored linear scan.
 */
function usageReader(days: readonly AnalyticsV2PreparedDay[]) {
  const byDay = new Map(days.map((day) => [day.day, day.usageRows]));
  return {
    days: days.filter((day) => day.usageRows.length > 0).map((day) => day.day),
    async readPage({ day, afterTime, afterOccurrence }: { day: string; afterTime: string; afterOccurrence: string }) {
      const rows = byDay.get(day);
      if (rows === undefined) throw new SharedAnalyticsUnavailable("usage_day_absent");
      const index = firstRowAfter(rows, afterTime, afterOccurrence);
      const page = rows.slice(index, index + PAGE_SIZE);
      return { rows: page, complete: index + page.length >= rows.length };
    },
  };
}

/**
 * The native paged quota acquisition (storage-effective-history.ts
 * advanceStorageEffectiveAnalysis, acquisition phase, without a prepared
 * store): one 200-row page per call, stopping at every phase boundary; each
 * phase rewinds to the first quota day with the window ordinal at zero, and
 * the ordinal runs across the window's days within a phase.
 */
async function pagedQuotaAcquisition(identity: V11QuotaAcquisitionIdentity, quotaDays: readonly string[],
  occurrencesOf: (day: string) => readonly EffectiveTelemetryOccurrence[], throughDay: string):
Promise<V11CompletedQuotaAcquisition | { status: "not_testable"; reason: string }> {
  let acquisition: V11QuotaAcquisitionCheckpoint = createV11QuotaAcquisitionCheckpoint(identity);
  const first = (): { day: string; complete: boolean } => ({ day: quotaDays[0] ?? throughDay,
    complete: quotaDays.length === 0 });
  const cursor = { phase: "plan" as V11QuotaAcquisitionCheckpoint["phase"], ...first(), offset: 0, ordinal: 0 };
  // Every row is read once per phase (four phases), one page per call.
  let rows = 0;
  for (const day of quotaDays) rows += occurrencesOf(day).length;
  const maximumCalls = 4 * (Math.ceil(rows / PAGE_SIZE) + quotaDays.length + 2);
  for (let call = 0; call < maximumCalls; call += 1) {
    if (cursor.phase !== acquisition.phase) {
      Object.assign(cursor, { phase: acquisition.phase, ...first(), offset: 0, ordinal: 0 });
    }
    const reader: V11QuotaPageReader = {
      pageSize: PAGE_SIZE,
      effective: { complete: () => cursor.complete },
      async readPage() {
        if (cursor.complete) return [];
        const dayRows = occurrencesOf(cursor.day);
        const page = dayRows.slice(cursor.offset, cursor.offset + PAGE_SIZE);
        const mapped = page.map((row) => mapEffectiveQuotaPageRow(row, cursor.day, ++cursor.ordinal));
        if (cursor.offset + page.length < dayRows.length) cursor.offset += page.length;
        else {
          const nextDay = quotaDays.find((day) => day > cursor.day);
          if (nextDay !== undefined) { cursor.day = nextDay; cursor.offset = 0; } else cursor.complete = true;
        }
        return mapped;
      },
    };
    const step = await advanceV11QuotaAcquisition(reader, identity,
      { remainingQueries: 1, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 }, acquisition,
      { maxPages: 1, stopAtPhaseBoundary: true });
    if (step.status === "not_testable") return step;
    if (step.status === "complete") {
      return { identity: step.identity, planAnchors: step.planAnchors, quotaRows: step.quotaRows };
    }
    acquisition = step.checkpoint;
  }
  throw new Error("ANALYTICS_V2_NATIVE_PATH_QUOTA_ACQUISITION_UNBOUNDED");
}

/** The paged usage reduction, resumed from its checkpoint until complete. */
async function pagedUsageReduction(pin: V11SourcePin,
  options: Parameters<typeof advanceV11UsageReduction>[2], days: readonly AnalyticsV2PreparedDay[]):
Promise<V11UsageReductionCheckpoint> {
  let pages = 2;
  for (const day of days) pages += Math.ceil(day.usageRows.length / PAGE_SIZE) + 1;
  const maximumCalls = Math.ceil(pages / (USAGE_PAGES_PER_CALL - 1)) + 1;
  let state: V11UsageReductionCheckpoint | null = null;
  for (let call = 0; call < maximumCalls; call += 1) {
    state = await advanceV11UsageReduction(NO_DB, pin, options,
      { remainingQueries: USAGE_PAGES_PER_CALL, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 },
      state, USAGE_PAGES_PER_CALL);
    if (state.complete) return state;
  }
  throw new Error("ANALYTICS_V2_NATIVE_PATH_USAGE_REDUCTION_UNBOUNDED");
}

/**
 * One scalar or model analysis over a complete window, as the native path
 * computes it. The not-testable shapes are advanceStorageEffectiveAnalysis's.
 */
export async function evaluateAnalyticsV2NativeDate(metric: "fits" | "model",
  input: AnalyticsV2WindowInput): Promise<object> {
  const selected = completeWindow(input.pin, input.day, input.days);
  if (selected.some((value) => value.ownerDigest !== input.ownerDigest)) {
    throw new SharedAnalyticsUnavailable("owner_mismatch");
  }
  const nowMs = Date.parse(modelHistoryWindow(input.day).fixedNow);
  const identity = createV11QuotaAcquisitionIdentity(input.pin, nowMs);
  const quotaDays = selected.filter((value) => input.quotaOccurrences(value.day).length > 0);
  for (const value of quotaDays) {
    if (value.quota !== null && value.quota.quotaRowsRead !== input.quotaOccurrences(value.day).length) {
      throw new Error("ANALYTICS_V2_NATIVE_PATH_QUOTA_DAY_MISMATCH");
    }
  }
  let acquired: V11CompletedQuotaAcquisition | { status: "not_testable"; reason: string } | undefined;
  if (quotaDays.every((value) => value.quota !== null)) {
    const folded = foldEffectiveQuotaDays(identity, quotaDays.map((value) => value.quota!),
      quotaDays.map((value) => value.day));
    if (folded !== undefined) {
      if (folded.status === "deferred") throw new SharedAnalyticsUnavailable("quota_window_unrepresentable");
      acquired = folded.status === "not_testable" ? folded
        : { identity: folded.identity, planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
    }
  }
  acquired ??= await pagedQuotaAcquisition(identity, quotaDays.map((value) => value.day),
    input.quotaOccurrences, input.pin.throughDay);
  if ("status" in acquired) {
    return metric === "fits"
      ? { schemaVersion: "account-scoped-quota-analysis-v0.1", status: "not_testable", reason: acquired.reason,
        tracks: [] }
      : { status: "not_testable", reason: acquired.reason, tracks: [] };
  }
  const options = { nowMs, quotaAcquisition: acquired, scalarRequested: metric === "fits" };
  const modelUsage = selected.map((value) => value.modelUsage);
  let state: V11UsageReductionCheckpoint;
  if (metric === "model" && modelUsage.every((value) => value !== null)
    && effectiveUsageWindowRepresentable(modelUsage as EffectiveUsageDay[])) {
    const modelDays = selected.filter((value) => value.modelUsage!.projection.usage.rowsRead > 0)
      .map((value) => ({ day: value.day, usage: value.modelUsage!.projection.usage }));
    state = await foldV11UsageModelReduction(NO_DB, input.pin, options, modelDays,
      modelDays.map((value) => value.day));
  } else {
    state = await pagedUsageReduction(input.pin, { ...options, effectiveUsageReader: usageReader(selected) },
      selected);
  }
  return finishV11UsageReduction(NO_DB, input.pin, options, state, metric);
}

/**
 * The current scalar fit for `day`. The vendored evaluateSharedScalarDate
 * answers when every window day is fully prepared; its bound refusals reach
 * the native evaluation.
 */
export async function evaluateAnalyticsV2ScalarDate(input: AnalyticsV2WindowInput):
Promise<{ analysis: object; selectedFits: CommunityAllowanceFit[] }> {
  if (input.days.every(isSharedAnalyticsDay)) {
    try {
      return await evaluateSharedScalarDate({ pin: input.pin, day: input.day, ownerDigest: input.ownerDigest,
        days: input.days });
    } catch (error) {
      if (!isRefusal(error, NATIVE_WINDOW_REASONS)) throw error;
    }
  }
  const analysis = await evaluateAnalyticsV2NativeDate("fits", input);
  return { analysis, selectedFits: selectCommunityAllowanceAnalysisFits(input.ownerDigest,
    [{ source: "v1.1", analysis: analysis as Parameters<typeof selectCommunityAllowanceAnalysisFits>[1][number]["analysis"] }]) };
}

/** One model-history date, with the same vendored-first rule. */
export async function evaluateAnalyticsV2ModelDate(input: AnalyticsV2WindowInput): Promise<object> {
  if (input.days.every(isSharedAnalyticsDay)) {
    try {
      return await evaluateSharedModelDate({ pin: input.pin, day: input.day, ownerDigest: input.ownerDigest,
        days: input.days });
    } catch (error) {
      if (!isRefusal(error, NATIVE_WINDOW_REASONS)) throw error;
    }
  }
  return evaluateAnalyticsV2NativeDate("model", input);
}

/**
 * The vendored evaluateSharedCacheDay over cache views. It reads only `day`,
 * `ownerDigest`, `cacheItems` and `cacheEventsRead` of each day
 * (analytics-shared-reducers.ts:256-280), so the analysis-only fields a view
 * omits are never reached.
 */
export function evaluateAnalyticsV2CacheDay(input: { day: string; ownerDigest: string;
  days: readonly AnalyticsV2CacheDay[] }): CacheRetentionDayAggregate {
  return evaluateSharedCacheDay({ day: input.day, ownerDigest: input.ownerDigest,
    days: input.days as readonly SharedAnalyticsDay[] });
}

/** The cache view of a prepared day: what the 7-day carry needs to keep. */
export function analyticsV2CacheView(day: AnalyticsV2PreparedDay): AnalyticsV2CacheDay {
  return Object.freeze({ day: day.day, ownerDigest: day.ownerDigest, cacheItems: day.cacheItems,
    cacheEventsRead: day.cacheEventsRead });
}
