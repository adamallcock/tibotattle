/**
 * analytics-v2 compute core, one effective owner (K-SPLIT, the K-PAR unit).
 *
 * computeAnalyticsV2Owner is the per-owner body computeAnalyticsV2 (compute.ts)
 * used to run inline: it prepares every needed day of one admitted effective
 * owner, segment by segment, reduces its cache days, fits today's scalar
 * allowance and evaluates the 70 model dates. Moved here unchanged in
 * behaviour so the same function runs in the main thread (one owner at a
 * time, as before) or in a compute worker (cloud-run/analytics-refresh-worker
 * .mjs, several owners at once).
 *
 * It is a pure function of the run context, the owner, its evidence counts and
 * the occurrences `load` returns: no I/O, no shared state. Every output row
 * and refusal is handed to `hooks.emit` in production order; the caller
 * appends and charges them (compute.ts), so the output account, its refusal
 * point and the stored row order are those of the inline run. The queued
 * days' daily values, the blocked days, the fits and the model compositions
 * the community fold needs are returned once the owner is done.
 *
 * The prepared-day observer (K-PERCARD): every owner-day this run prepares
 * and stores with daily values is also handed to the price attribution
 * (price-attribution.ts), which prices each usage event through the
 * vendored buildPricingEvent and priceTelemetryUsageEvent, checks the result
 * against the kernel's own daily pricing block (a difference ends the run:
 * ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH) and emits the owner-day's price
 * row right after its owner-day row. It reads nothing the kernels do not, and
 * no kernel output depends on it.
 */
import {
  CACHE_RETENTION_METHOD,
  modelHistoryWindow,
  validateV11DailyProjectionValues,
  type CommunityAllowanceFit,
  type SharedAnalyticsDay,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_CACHE_BAND_COUNTERS,
  ANALYTICS_V2_DAY_PATTERN,
  type AnalyticsV2CacheBandCounter,
  type AnalyticsV2CacheBandRow,
  type AnalyticsV2Day,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerDayPriceRow,
  type AnalyticsV2OwnerDayRow,
  type AnalyticsV2OwnerFitsRow,
  type AnalyticsV2OwnerModelDateRow,
  type AnalyticsV2Phase,
  type AnalyticsV2Refusal,
} from "./contract";
import {
  analyticsV2CacheView,
  evaluateAnalyticsV2CacheDay,
  evaluateAnalyticsV2ModelDate,
  evaluateAnalyticsV2ScalarDate,
  prepareAnalyticsV2Day,
  type AnalyticsV2CacheDay,
  type AnalyticsV2PreparedDay,
} from "./native-path";
import { analyticsV2DayDigest, analyticsV2RefusedDayDigest, buildAnalyticsV2Pin, EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences } from "./pin";
import { attributeAnalyticsV2DayPrices } from "./price-attribution";
import { analyticsV2Refusal, kernelRefusalReason } from "./refusals";
import {
  analyticsV2OutputRowBytes,
  type AnalyticsV2DayEvidence,
  type AnalyticsV2DaySpan,
  type AnalyticsV2Resources,
} from "./resources";

const DAY_MS = 86_400_000;
const CACHE_LOOKBACK_DAYS: number = CACHE_RETENTION_METHOD.lookbackDays;

const COUNTER_FIELDS = Object.freeze({
  adjacencies: "adjacencies",
  reused_more_than_half: "reusedMoreThanHalf",
  matched_or_exceeded: "matchedOrExceeded",
  unordered_ties: "unorderedTies",
  excluded_insufficient_evidence: "excludedInsufficientEvidence",
  excluded_context_contracted: "excludedContextContracted",
  sessions: "sessions",
} as const satisfies Record<AnalyticsV2CacheBandCounter, string>);

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

const label = (at: number): AnalyticsV2Day => new Date(at).toISOString().slice(0, 10);
const addDays = (day: AnalyticsV2Day, days: number): AnalyticsV2Day => label(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
function daysBetween(fromDay: AnalyticsV2Day, throughDay: AnalyticsV2Day): AnalyticsV2Day[] {
  const out: AnalyticsV2Day[] = [];
  for (let at = Date.parse(`${fromDay}T00:00:00.000Z`), end = Date.parse(`${throughDay}T00:00:00.000Z`); at <= end; at += DAY_MS) {
    out.push(label(at));
  }
  return out;
}

function dayStart(day: string, what: string): number {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (typeof day !== "string" || !ANALYTICS_V2_DAY_PATTERN.test(day) || !Number.isSafeInteger(at)
    || new Date(at).toISOString().slice(0, 10) !== day) invalid(what);
  return at;
}

function evidenceTotal(counts: AnalyticsV2DayEvidence): number {
  return counts.usage + counts.quota + counts.session;
}

/** The exact per-day counts of one owner's occurrences: days with evidence only. */
export function analyticsV2EvidenceOf(days: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>):
  Map<AnalyticsV2Day, AnalyticsV2DayEvidence> {
  const evidence = new Map<AnalyticsV2Day, AnalyticsV2DayEvidence>();
  for (const [day, value] of days) {
    const occurrences = analyticsV2DayOccurrences(value);
    const counts = { usage: occurrences.usage.length, quota: occurrences.quota.length,
      session: occurrences.session.length };
    if (evidenceTotal(counts) > 0) evidence.set(day, Object.freeze(counts));
  }
  return evidence;
}

/** True when `days` holds exactly the occurrences `evidence` counts. */
function matchesEvidence(days: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>,
  evidence: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayEvidence>): boolean {
  const counted = analyticsV2EvidenceOf(days);
  if (counted.size !== evidence.size) return false;
  for (const [day, counts] of counted) {
    const expected = evidence.get(day);
    if (expected === undefined || expected.usage !== counts.usage || expected.quota !== counts.quota
      || expected.session !== counts.session) return false;
  }
  return true;
}

export function analyticsV2DayOccurrences(value: unknown): AnalyticsV2DayOccurrences {
  const day = value as AnalyticsV2DayOccurrences;
  if (!day || typeof day !== "object" || !Array.isArray(day.usage) || !Array.isArray(day.quota)
    || !Array.isArray(day.session)) invalid("occurrencesByOwner");
  return day;
}

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

/**
 * The run facts every owner computation shares. Structured-clone safe (plain
 * values only), so a compute worker receives exactly what the main thread
 * computed it from.
 */
export interface AnalyticsV2OwnerRunContext {
  readonly today: AnalyticsV2Day;
  readonly analysisFrom: AnalyticsV2Day;
  readonly cacheFromDay: AnalyticsV2Day;
  /** Every day the run prepares, ascending (analysis days, cache days and their lookback, queued days). */
  readonly neededDays: readonly AnalyticsV2Day[];
  /** History segments, oldest first, then the analysis horizon through the end of the range. */
  readonly segments: readonly AnalyticsV2DaySpan[];
  /** The inclusive range the occurrences were read over. */
  readonly rangeFromDay: AnalyticsV2Day;
  readonly queued: readonly AnalyticsV2Day[];
  readonly modelDates: readonly AnalyticsV2Day[];
  readonly resources: AnalyticsV2Resources;
}

/** One owner output, handed to the caller in production order. */
export type AnalyticsV2OwnerEmission =
  | { readonly kind: "ownerDay"; readonly row: AnalyticsV2OwnerDayRow }
  | { readonly kind: "ownerDayPrice"; readonly row: AnalyticsV2OwnerDayPriceRow }
  | { readonly kind: "cacheBand"; readonly row: AnalyticsV2CacheBandRow }
  | { readonly kind: "refusal"; readonly refusal: AnalyticsV2Refusal }
  | { readonly kind: "fits"; readonly row: AnalyticsV2OwnerFitsRow }
  | { readonly kind: "modelDate"; readonly row: AnalyticsV2OwnerModelDateRow };

/** A progress event inside one owner (the Job's time guard); content-free. */
export type AnalyticsV2OwnerProgress =
  | { readonly kind: "segment"; readonly index: number; readonly occurrences: number; readonly accountBytes: number }
  | { readonly kind: "scalar"; readonly accountBytes: number }
  | { readonly kind: "model"; readonly index: number; readonly accountBytes: number };

export interface AnalyticsV2OwnerHooks {
  /** Receives every output row and refusal in production order (may throw: the run ends). */
  readonly emit: (emission: AnalyticsV2OwnerEmission) => void;
  /** The account the caller holds, for progress events. */
  readonly accountBytes: () => number;
  readonly progress: (event: AnalyticsV2OwnerProgress) => void;
  readonly timed: <T>(phase: AnalyticsV2Phase, work: () => Promise<T> | T) => Promise<T>;
  /** Heap in use, sampled for heapPeakBytes (operational metadata only). */
  readonly memoryProbe?: () => number;
}

/** Everything the community fold needs from one computed owner. */
export interface AnalyticsV2OwnerComputation {
  readonly ownerDigest: string;
  /** Queued days this owner prepared, with their unfinalized daily values (ascending). */
  readonly dailyValues: ReadonlyArray<readonly [AnalyticsV2Day, V11DailyProjectionValues]>;
  /** Queued days this owner could not prepare (ascending). */
  readonly blockedDays: readonly AnalyticsV2Day[];
  /** Today's selected fits, or null when the scalar fit was refused. */
  readonly fits: readonly CommunityAllowanceFit[] | null;
  /** Evaluated model dates (ascending), each with its composition result. */
  readonly compositions: ReadonlyArray<readonly [AnalyticsV2Day, V1ModelCompositionResult]>;
  /** Model dates the kernels refused for this owner (ascending). */
  readonly modelRefused: readonly AnalyticsV2Day[];
  readonly heapPeakBytes: number | null;
}

/**
 * Compute one admitted effective owner. `load(span)` returns the owner's
 * occurrences over one inclusive span of the read range (the history segments
 * oldest first, each released before the next, then the analysis horizon);
 * `evidence` is the owner's exact per-day counts, which every load must match.
 */
export async function computeAnalyticsV2Owner(input: {
  readonly context: AnalyticsV2OwnerRunContext;
  readonly owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  readonly evidence: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayEvidence>;
  /** Null when the caller holds the owner's occurrences over the whole range (`occurrences`). */
  readonly load: ((span: AnalyticsV2DaySpan) => Promise<ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>) | null;
  readonly occurrences?: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>;
  readonly hooks: AnalyticsV2OwnerHooks;
}): Promise<AnalyticsV2OwnerComputation> {
  const { context, owner, evidence, load, hooks } = input;
  const ownerDigest = owner.ownerDigest;
  const { today, analysisFrom, cacheFromDay, neededDays, segments, resources } = context;
  const queuedSet = new Set(context.queued);
  const timed = hooks.timed;
  const emit = hooks.emit;
  const pushRefusal = (refusal: AnalyticsV2Refusal): void => emit({ kind: "refusal", refusal });
  const dailyValues = new Map<AnalyticsV2Day, V11DailyProjectionValues>();
  const blocked = new Set<AnalyticsV2Day>();
  const compositions: Array<readonly [AnalyticsV2Day, V1ModelCompositionResult]> = [];
  const modelRefused: AnalyticsV2Day[] = [];
  let fits: readonly CommunityAllowanceFit[] | null = null;
  let heapPeak: number | null = null;
  const sample = (): void => {
    if (hooks.memoryProbe === undefined) return;
    const used = hooks.memoryProbe();
    if (Number.isSafeInteger(used) && used >= 0 && (heapPeak === null || used > heapPeak)) heapPeak = used;
  };
  sample();

  // ---- Prepare every needed day once, segment by segment; cache days are
  // reduced as soon as their 7-day lookback is prepared. Only the 170
  // analysis days keep their prepared usage rows; cache views are kept
  // while a later day's lookback can reach them (across a segment edge too).
  const prepared = new Map<AnalyticsV2Day, AnalyticsV2PreparedDay>();
  const cacheViews = new Map<AnalyticsV2Day, AnalyticsV2CacheDay>();
  const dayDigests = new Map<AnalyticsV2Day, string>();
  const prepareNeededDay = async (day: AnalyticsV2Day, value: AnalyticsV2DayOccurrences): Promise<void> => {
    await timed("prepare", async () => {
      const analysisDay = day >= analysisFrom && day <= today;
      let refusal: AnalyticsV2Refusal["reason"] | null = null, daily: V11DailyProjectionValues | null = null;
      let preparedDay = false;
      try {
        // The day backstop applies here, before anything serializes the day.
        const shared = await prepareAnalyticsV2Day({ day, ownerDigest, usage: value.usage,
          quota: value.quota, session: value.session }, resources);
        preparedDay = true;
        if (analysisDay) prepared.set(day, shared);
        cacheViews.set(day, analyticsV2CacheView(shared));
        daily = stripFinalized(shared.daily);
        validateV11DailyProjectionValues(daily);
      } catch (error) {
        refusal = kernelRefusalReason(error);
        if (refusal === null) throw error;
        pushRefusal(analyticsV2Refusal(ownerDigest, day, "daily", refusal));
      }
      // Only a prepared day is digested: its size is within the backstop, so
      // the one-string digest fits. Every window containing an unprepared
      // day is refused (incomplete_window), so its marker never pins a result.
      if (analysisDay) {
        dayDigests.set(day, preparedDay ? await analyticsV2DayDigest(day, value) : await analyticsV2RefusedDayDigest(day));
      }
      if (queuedSet.has(day)) {
        if (daily === null) blocked.add(day);
        else dailyValues.set(day, daily);
      }
      if (hasEvidence(value)) {
        // The prepared-day observer: a stored owner-day with daily values gets
        // its price row (the attribution fails the run on any disagreement
        // with the kernel's daily pricing; it is never a refusal).
        const price = refusal === null && daily !== null
          ? await attributeAnalyticsV2DayPrices({ day, usage: value.usage, daily }) : null;
        emit({ kind: "ownerDay", row: Object.freeze({ ownerDigest, day, daily, refusal }) });
        if (price !== null) emit({ kind: "ownerDayPrice", row: Object.freeze({ ownerDigest, day, ...price }) });
      }
    });
    sample();
    // ---- Cache continuity: the day with its 7-day carry. A prepared day
    // with no cache items has no groups and needs no reducer call; a refused
    // day or lookback day is absent, and the reducer records that.
    if (day >= cacheFromDay && day <= today) {
      await timed("cache", () => {
        const own = cacheViews.get(day);
        if (own !== undefined && own.cacheItems.length === 0) return;
        let aggregate: ReturnType<typeof evaluateAnalyticsV2CacheDay>;
        try {
          aggregate = evaluateAnalyticsV2CacheDay({ day, ownerDigest,
            days: daysBetween(addDays(day, -CACHE_LOOKBACK_DAYS), day).flatMap((value) => cacheViews.get(value) ?? []) });
        } catch (error) {
          const reason = kernelRefusalReason(error);
          if (reason === null) throw error;
          pushRefusal(analyticsV2Refusal(ownerDigest, day, "cache", reason));
          return;
        }
        for (const group of aggregate.groups) {
          for (const band of group.bands) {
            emit({ kind: "cacheBand", row: Object.freeze({ ownerDigest, day, model: group.model, effort: group.effort,
              band: band.band, counters: bandCounters(band) }) });
          }
        }
      });
    }
    const oldest = addDays(day, -CACHE_LOOKBACK_DAYS);
    for (const kept of [...cacheViews.keys()]) if (kept <= oldest) cacheViews.delete(kept);
  };
  let occurrences: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences> = new Map();
  let neededIndex = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    let segmentOccurrences = 0;
    for (const [day, counts] of evidence) {
      if (day >= segment.fromDay && day <= segment.throughDay) segmentOccurrences += evidenceTotal(counts);
    }
    hooks.progress(Object.freeze({ kind: "segment", index: segmentIndex, occurrences: segmentOccurrences,
      accountBytes: hooks.accountBytes() }));
    if (load === null) {
      occurrences = input.occurrences!;
    } else {
      // Release the previous segment before the next is loaded.
      occurrences = new Map();
      const span = { fromDay: segment.fromDay < context.rangeFromDay ? context.rangeFromDay : segment.fromDay,
        throughDay: segment.throughDay };
      if (span.fromDay <= span.throughDay) {
        const loaded = await timed("read", () => load(Object.freeze(span)));
        if (!(loaded instanceof Map)) invalid("loadOwnerOccurrences");
        for (const [day, value] of loaded) {
          dayStart(day, "loadOwnerOccurrences");
          analyticsV2DayOccurrences(value);
          if (day < span.fromDay || day > span.throughDay) invalid("loadOwnerOccurrences.range");
        }
        if (!matchesEvidence(loaded, new Map([...evidence].filter(([day]) =>
          day >= span.fromDay && day <= span.throughDay)))) invalid("loadOwnerOccurrences.evidence");
        occurrences = loaded;
      }
    }
    for (; neededIndex < neededDays.length && neededDays[neededIndex]! <= segment.throughDay; neededIndex += 1) {
      const day = neededDays[neededIndex]!;
      await prepareNeededDay(day, occurrences.get(day) ?? EMPTY_DAY_OCCURRENCES);
    }
  }
  if (neededIndex !== neededDays.length) throw new Error("ANALYTICS_V2_SEGMENTS_INCOMPLETE");

  cacheViews.clear();
  const windowFor = (day: AnalyticsV2Day): AnalyticsV2PreparedDay[] =>
    daysBetween(modelHistoryWindow(day).fromDay, day).flatMap((value) => prepared.get(value) ?? []);
  const quotaOccurrences = (day: AnalyticsV2Day) => (occurrences.get(day) ?? EMPTY_DAY_OCCURRENCES).quota;

  // ---- Current scalar fits: today only.
  hooks.progress(Object.freeze({ kind: "scalar", accountBytes: hooks.accountBytes() }));
  await timed("scalar", async () => {
    let result: Awaited<ReturnType<typeof evaluateAnalyticsV2ScalarDate>>;
    try {
      const pin = await buildAnalyticsV2Pin({ owner, day: today, dayDigests });
      result = await evaluateAnalyticsV2ScalarDate({ pin, day: today, ownerDigest, days: windowFor(today),
        quotaOccurrences });
    } catch (error) {
      const reason = kernelRefusalReason(error);
      if (reason === null) throw error;
      pushRefusal(analyticsV2Refusal(ownerDigest, today, "scalar", reason));
      return;
    }
    fits = result.selectedFits;
    emit({ kind: "fits", row: Object.freeze({ ownerDigest, asOfDay: today, fits: result.selectedFits }) });
  });
  sample();

  // ---- Model history: each of the 70 dates over its own 101-day window.
  await timed("model", async () => {
    for (const [modelIndex, day] of context.modelDates.entries()) {
      hooks.progress(Object.freeze({ kind: "model", index: modelIndex, accountBytes: hooks.accountBytes() }));
      let result: V1ModelCompositionResult;
      try {
        const pin = await buildAnalyticsV2Pin({ owner, day, dayDigests });
        result = await evaluateAnalyticsV2ModelDate({ pin, day, ownerDigest, days: windowFor(day),
          quotaOccurrences }) as V1ModelCompositionResult;
      } catch (error) {
        const reason = kernelRefusalReason(error);
        if (reason === null) throw error;
        pushRefusal(analyticsV2Refusal(ownerDigest, day, "model", reason));
        modelRefused.push(day);
        sample();
        continue;
      }
      compositions.push([day, result] as const);
      emit({ kind: "modelDate", row: Object.freeze({ ownerDigest, day, result: withoutFingerprint(result) }) });
      sample();
    }
  });
  // `prepared` (with its usage rows) and the owner's last segment are released with this scope.
  return Object.freeze({
    ownerDigest,
    dailyValues: [...dailyValues].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    blockedDays: [...blocked].sort(),
    fits,
    compositions,
    modelRefused,
    heapPeakBytes: heapPeak,
  });
}

/** The output account's charge for one emission (resources.ts ANALYTICS_V2_OUTPUT_MODEL). */
export function analyticsV2EmissionBytes(emission: AnalyticsV2OwnerEmission): number {
  return analyticsV2OutputRowBytes(emission.kind === "refusal" ? emission.refusal : emission.row);
}
