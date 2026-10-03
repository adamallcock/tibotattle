/** Pure owner stages. No database or hooks; emissions and terminal errors stay in date order. */
import { CACHE_RETENTION_METHOD, modelHistoryWindow, validateV11DailyProjectionValues,
  type CommunityAllowanceFit, type SharedAnalyticsDay, type V11DailyProjectionValues,
  type V1ModelCompositionResult } from "../../vendor/analytics-d43c8f92/entry";
import { ANALYTICS_V2_CACHE_BAND_COUNTERS, type AnalyticsV2CacheBandCounter,
  type AnalyticsV2Day, type AnalyticsV2Owner, type AnalyticsV2Refusal } from "./contract";
import { analyticsV2CacheView, evaluateAnalyticsV2CacheDay, evaluateAnalyticsV2ModelDate,
  evaluateAnalyticsV2ScalarDate, prepareAnalyticsV2Day,
  type AnalyticsV2CacheDay, type AnalyticsV2PreparedDay } from "./native-path";
import { analyticsV2DayDigest, analyticsV2RefusedDayDigest, buildAnalyticsV2Pin, EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences } from "./pin";
import { attributeAnalyticsV2DayPrices } from "./price-attribution";
import { analyticsV2Refusal, kernelRefusalReason } from "./refusals";
import type { AnalyticsV2Resources } from "./resources";
import type { AnalyticsV2OwnerEmission } from "./compute-owner";

const CACHE_LOOKBACK_DAYS = CACHE_RETENTION_METHOD.lookbackDays;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86400000).toISOString().slice(0, 10);
function daysBetween(from: string, through: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= through; day = addDays(day, 1)) days.push(day);
  return days;
}
const COUNTER_FIELDS = Object.freeze({
  adjacencies: "adjacencies",
  reused_more_than_half: "reusedMoreThanHalf",
  matched_or_exceeded: "matchedOrExceeded",
  unordered_ties: "unorderedTies",
  excluded_insufficient_evidence: "excludedInsufficientEvidence",
  excluded_context_contracted: "excludedContextContracted",
  sessions: "sessions",
} as const satisfies Record<AnalyticsV2CacheBandCounter, string>);

function hasEvidence(day: AnalyticsV2DayOccurrences | undefined): boolean {
  return day !== undefined && day.usage.length + day.quota.length + day.session.length > 0;
}

function stripFinalized(daily: SharedAnalyticsDay["daily"]): V11DailyProjectionValues {
  // prepareSharedAnalyticsDay returns the FINALIZED daily (it adds coverage and
  // knownCostNanousd). Folds and validateV11DailyProjectionValues take the
  // closed, unfinalized shape, exactly as the compose proof strips it.
  const { coverage: _coverage, knownCostNanousd: _known, ...value } = daily;
  return value;
}

function bandCounters(band: Record<(typeof COUNTER_FIELDS)[AnalyticsV2CacheBandCounter], number>) {
  return Object.freeze(Object.fromEntries(ANALYTICS_V2_CACHE_BAND_COUNTERS.map((counter) =>
    [counter, band[COUNTER_FIELDS[counter]]]))) as Readonly<Record<AnalyticsV2CacheBandCounter, number>>;
}

function withoutFingerprint(result: V1ModelCompositionResult): Omit<V1ModelCompositionResult, "inputFingerprint"> {
  if (!("inputFingerprint" in result)) return result;
  const { inputFingerprint: _fingerprint, ...stored } = result;
  return stored;
}


export interface AnalyticsV2PreparedSpanInput {
  readonly owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  readonly span: readonly (readonly [AnalyticsV2Day, AnalyticsV2DayOccurrences])[];
  readonly lookbackCacheTail: ReadonlyMap<AnalyticsV2Day, AnalyticsV2CacheDay>;
  readonly analysisFrom: AnalyticsV2Day;
  readonly today: AnalyticsV2Day;
  readonly cacheFromDay: AnalyticsV2Day;
  readonly queued: ReadonlySet<AnalyticsV2Day>;
  readonly resources: AnalyticsV2Resources;
  /** The owner uses the cache seam separately to preserve prepare/cache phase clocks. */
  readonly includeCache?: boolean;
}
/** A prepared-day loader can provide these values later; this stage never loads persisted data. */
export async function prepareSpan(input: AnalyticsV2PreparedSpanInput) {
  const { owner: { ownerDigest }, analysisFrom, today, resources } = input;
  const emissions: AnalyticsV2OwnerEmission[] = [];
  const prepared = new Map<AnalyticsV2Day, AnalyticsV2PreparedDay>();
  const dayDigests = new Map<AnalyticsV2Day, string>();
  const dailyValues = new Map<AnalyticsV2Day, V11DailyProjectionValues>();
  const blockedDays: AnalyticsV2Day[] = [];
  const cacheTail = new Map(input.lookbackCacheTail);
  let terminalError: unknown = null;
  for (const [day, value] of input.span) {
    try {
      const analysisDay = day >= analysisFrom && day <= today;
      let refusal: AnalyticsV2Refusal["reason"] | null = null, daily: V11DailyProjectionValues | null = null;
      let preparedDay = false;
      try {
        const shared = await prepareAnalyticsV2Day({ day, ownerDigest, usage: value.usage,
          quota: value.quota, session: value.session }, resources);
        preparedDay = true;
        if (analysisDay) prepared.set(day, shared);
        cacheTail.set(day, analyticsV2CacheView(shared));
        daily = stripFinalized(shared.daily);
        validateV11DailyProjectionValues(daily);
      } catch (error) {
        refusal = kernelRefusalReason(error);
        if (refusal === null) throw error;
        emissions.push({ kind: "refusal", refusal: analyticsV2Refusal(ownerDigest, day, "daily", refusal) });
      }
      if (analysisDay) dayDigests.set(day, preparedDay
        ? await analyticsV2DayDigest(day, value) : await analyticsV2RefusedDayDigest(day));
      if (input.queued.has(day)) {
        if (daily === null) blockedDays.push(day);
        else dailyValues.set(day, daily);
      }
      if (hasEvidence(value)) {
        const price = refusal === null && daily !== null
          ? await attributeAnalyticsV2DayPrices({ day, usage: value.usage, daily }) : null;
        emissions.push({ kind: "ownerDay", row: Object.freeze({ ownerDigest, day, daily, refusal }) });
        if (price !== null) emissions.push({ kind: "ownerDayPrice", row: Object.freeze({ ownerDigest, day, ...price }) });
      }
      if (input.includeCache !== false) {
        const cache = evaluatePreparedSpanCache({ ownerDigest, day, today,
          cacheFromDay: input.cacheFromDay, cacheTail });
        emissions.push(...cache.emissions);
        if (cache.terminalError !== null) throw cache.terminalError;
        cacheTail.clear();
        for (const [key, view] of cache.cacheTail) cacheTail.set(key, view);
      }
    } catch (error) { terminalError = error; break; }
  }
  return { emissions, prepared, dayDigests, dailyValues, blockedDays, cacheTail, terminalError };
}

/** Separate pure cache seam lets inline composition retain its original phase clocks and sampling. */
export function evaluatePreparedSpanCache(input: { readonly ownerDigest: string; readonly day: string;
  readonly today: string; readonly cacheFromDay: string; readonly cacheTail: ReadonlyMap<string, AnalyticsV2CacheDay> }) {
  const { ownerDigest, day, today, cacheFromDay } = input;
  const cacheTail = new Map(input.cacheTail);
  const emissions: AnalyticsV2OwnerEmission[] = [];
  let terminalError: unknown = null;
  try {
    if (day >= cacheFromDay && day <= today) {
      const own = cacheTail.get(day);
      if (own === undefined || own.cacheItems.length !== 0) {
        try {
          const aggregate = evaluateAnalyticsV2CacheDay({ day, ownerDigest,
            days: daysBetween(addDays(day, -CACHE_LOOKBACK_DAYS), day).flatMap((value) => cacheTail.get(value) ?? []) });
          for (const group of aggregate.groups) for (const band of group.bands) emissions.push({ kind: "cacheBand",
            row: Object.freeze({ ownerDigest, day, model: group.model, effort: group.effort,
              band: band.band, counters: bandCounters(band) }) });
        } catch (error) {
          const reason = kernelRefusalReason(error);
          if (reason === null) throw error;
          emissions.push({ kind: "refusal", refusal: analyticsV2Refusal(ownerDigest, day, "cache", reason) });
        }
      }
    }
    const oldest = addDays(day, -CACHE_LOOKBACK_DAYS);
    for (const kept of cacheTail.keys()) if (kept <= oldest) cacheTail.delete(kept);
  } catch (error) { terminalError = error; }
  return { emissions, cacheTail, terminalError };
}

/** Structured-clone safe union of a block's windows; quota acquisition remains per date. */
export interface AnalyticsV2ModelBlockInput {
  readonly owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  readonly dates: readonly AnalyticsV2Day[];
  readonly prepared: ReadonlyMap<AnalyticsV2Day, AnalyticsV2PreparedDay>;
  readonly dayDigests: ReadonlyMap<AnalyticsV2Day, string>;
  readonly horizonQuota: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences["quota"]>;
}
function windowInput(input: AnalyticsV2ModelBlockInput, day: AnalyticsV2Day, pin: Awaited<ReturnType<typeof buildAnalyticsV2Pin>>) {
  return { pin, day, ownerDigest: input.owner.ownerDigest,
    days: daysBetween(modelHistoryWindow(day).fromDay, day).flatMap((value) => input.prepared.get(value) ?? []),
    quotaOccurrences: (value: string) => input.horizonQuota.get(value) ?? EMPTY_DAY_OCCURRENCES.quota };
}
export async function evaluateScalar(input: AnalyticsV2ModelBlockInput, day: AnalyticsV2Day) {
  const emissions: AnalyticsV2OwnerEmission[] = [];
  let fits: readonly CommunityAllowanceFit[] | null = null, terminalError: unknown = null;
  try {
    const pin = await buildAnalyticsV2Pin({ owner: input.owner, day, dayDigests: input.dayDigests });
    const result = await evaluateAnalyticsV2ScalarDate(windowInput(input, day, pin));
    fits = result.selectedFits;
    emissions.push({ kind: "fits", row: Object.freeze({ ownerDigest: input.owner.ownerDigest, asOfDay: day, fits }) });
  } catch (error) {
    const reason = kernelRefusalReason(error);
    if (reason === null) terminalError = error;
    else emissions.push({ kind: "refusal", refusal: analyticsV2Refusal(input.owner.ownerDigest, day, "scalar", reason) });
  }
  return { emissions, fits, terminalError };
}
export type AnalyticsV2ModelDateUnit =
  | { readonly day: AnalyticsV2Day; readonly emission: AnalyticsV2OwnerEmission; readonly composition: V1ModelCompositionResult | null }
  | { readonly day: AnalyticsV2Day; readonly terminalError: unknown };
/** Pins are lazy, in date order. Terminal errors retain every earlier date for ordered replay. */
export async function evaluateModelBlock(input: AnalyticsV2ModelBlockInput): Promise<readonly AnalyticsV2ModelDateUnit[]> {
  const dates: AnalyticsV2ModelDateUnit[] = [];
  for (const day of input.dates) {
    try {
      const pin = await buildAnalyticsV2Pin({ owner: input.owner, day, dayDigests: input.dayDigests });
      const result = await evaluateAnalyticsV2ModelDate(windowInput(input, day, pin)) as V1ModelCompositionResult;
      dates.push({ day, composition: result,
        emission: { kind: "modelDate", row: Object.freeze({ ownerDigest: input.owner.ownerDigest, day,
          result: withoutFingerprint(result) }) } });
    } catch (error) {
      const reason = kernelRefusalReason(error);
      if (reason === null) { dates.push({ day, terminalError: error }); break; }
      dates.push({ day, composition: null,
        emission: { kind: "refusal", refusal: analyticsV2Refusal(input.owner.ownerDigest, day, "model", reason) } });
    }
  }
  return dates;
}
