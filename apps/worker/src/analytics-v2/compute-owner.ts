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
 * vendored buildPricingEvent and the byte-identical GCP fast pricer, checks the result
 * against the kernel's own daily pricing block (a difference ends the run:
 * ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH) and emits the owner-day's price
 * row right after its owner-day row. It reads nothing the kernels do not, and
 * no kernel output depends on it.
 */
import {
  type CommunityAllowanceFit,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_DAY_PATTERN,
  type AnalyticsV2Day,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerEmission,
  type AnalyticsV2Phase,
} from "./contract";
import {
  type AnalyticsV2CacheDay,
  type AnalyticsV2PreparedDay,
} from "./native-path";
import { EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences } from "./pin";
import { prepareSpan, evaluatePreparedSpanCache, evaluateScalar, evaluateModelBlock, shouldFanOutModelDates,
  type AnalyticsV2ModelBlockInput, type AnalyticsV2ModelDateUnit } from "./units";
import {
  analyticsV2OutputRowBytes,
  type AnalyticsV2DayEvidence,
  type AnalyticsV2DaySpan,
  type AnalyticsV2Resources,
} from "./resources";

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

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

export type { AnalyticsV2OwnerEmission } from "./contract";

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
  /** Worker composition only; no callback crosses into the pure model units. */
  readonly modelBlocks?: {
    readonly size: number;
    readonly fanOut: "auto" | "all" | "off";
    readonly run: (input: AnalyticsV2ModelBlockInput) => Promise<{
      readonly dates: readonly AnalyticsV2ModelDateUnit[]; readonly heapPeakBytes: number | null;
    }>;
  };
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
 * With `prefetch` (K-PAR-MEM, a compute Worker) the next segment's load starts
 * before the current segment is prepared, so its read overlaps this owner's
 * own preparation; at most two segments are held at once. The days are still
 * prepared one at a time in day order, so the outputs are the same.
 */
export async function computeAnalyticsV2Owner(input: {
  readonly context: AnalyticsV2OwnerRunContext;
  readonly owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  readonly evidence: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayEvidence>;
  /** Null when the caller holds the owner's occurrences over the whole range (`occurrences`). */
  readonly load: ((span: AnalyticsV2DaySpan) => Promise<ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>) | null;
  readonly occurrences?: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>;
  readonly hooks: AnalyticsV2OwnerHooks;
  readonly prefetch?: boolean;
}): Promise<AnalyticsV2OwnerComputation> {
  const { context, owner, evidence, load, hooks } = input;
  const ownerDigest = owner.ownerDigest;
  const { today, analysisFrom, cacheFromDay, neededDays, segments, resources } = context;
  const queuedSet = new Set(context.queued);
  const timed = hooks.timed;
  const emit = hooks.emit;
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
      const result = await prepareSpan({ owner, span: [[day, value]], lookbackCacheTail: cacheViews,
        analysisFrom, today, cacheFromDay, queued: queuedSet, resources, includeCache: false });
      for (const emission of result.emissions) emit(emission);
      if (result.terminalError !== null) throw result.terminalError;
      for (const [key, preparedDay] of result.prepared) prepared.set(key, preparedDay);
      for (const [key, digest] of result.dayDigests) dayDigests.set(key, digest);
      for (const [key, daily] of result.dailyValues) dailyValues.set(key, daily);
      for (const key of result.blockedDays) blocked.add(key);
      cacheViews.clear();
      for (const [key, view] of result.cacheTail) cacheViews.set(key, view);
    });
    sample();
    if (day >= cacheFromDay && day <= today) await timed("cache", () => {
      const result = evaluatePreparedSpanCache({ ownerDigest, day, today, cacheFromDay, cacheTail: cacheViews });
      for (const emission of result.emissions) emit(emission);
      if (result.terminalError !== null) throw result.terminalError;
      cacheViews.clear();
      for (const [key, view] of result.cacheTail) cacheViews.set(key, view);
    });
    else {
      const result = evaluatePreparedSpanCache({ ownerDigest, day, today, cacheFromDay, cacheTail: cacheViews });
      cacheViews.clear();
      for (const [key, view] of result.cacheTail) cacheViews.set(key, view);
    }
  };
  let occurrences: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences> = new Map();
  // K-PAR-MEM: with a loader the computation owns each loaded segment, and a
  // day's occurrences are released as soon as the day is prepared (its
  // prepared rows, cache view and evidence digest are all that later steps
  // read). Only the last segment's quota occurrences are kept: the windows'
  // paged quota acquisition reads them (quotaOccurrences below), and every
  // window day lies in that segment, the analysis horizon. So the owner's
  // heap peaks at about the larger of a loaded segment and its prepared
  // analysis days, not at their sum. A caller-held map (no loader) is never
  // mutated. The outputs are unchanged: each day is prepared exactly once,
  // from the same occurrences, in the same order.
  const owned = new Map<AnalyticsV2Day, AnalyticsV2DayOccurrences>();
  const horizonQuota = new Map<AnalyticsV2Day, AnalyticsV2DayOccurrences["quota"]>();
  const lastSegment = segments.length - 1;
  let neededIndex = 0;
  const prefetch = input.prefetch === true && load !== null;
  /** Announce segment `index` (the time guard's step) and start its load; null when nothing is read. */
  const startSegment = (segmentIndex: number) => {
    const segment = segments[segmentIndex]!;
    let segmentOccurrences = 0;
    for (const [day, counts] of evidence) {
      if (day >= segment.fromDay && day <= segment.throughDay) segmentOccurrences += evidenceTotal(counts);
    }
    hooks.progress(Object.freeze({ kind: "segment", index: segmentIndex, occurrences: segmentOccurrences,
      accountBytes: hooks.accountBytes() }));
    if (load === null) return null;
    const span = Object.freeze({ fromDay: segment.fromDay < context.rangeFromDay ? context.rangeFromDay : segment.fromDay,
      throughDay: segment.throughDay });
    if (span.fromDay > span.throughDay) return null;
    const loading = timed("read", () => load(span));
    // A prefetched load may fail while the current segment is prepared; it is
    // handled (and its error thrown) where it is awaited.
    loading.catch(() => {});
    return { span, loading };
  };
  let next = startSegment(0);
  for (const [segmentIndex, segment] of segments.entries()) {
    const current = next;
    next = null;
    if (load === null) {
      occurrences = input.occurrences!;
    } else {
      // Release the previous segment before the next is loaded.
      owned.clear();
      occurrences = owned;
      if (current !== null) {
        const span = current.span;
        const loaded = await current.loading;
        if (!(loaded instanceof Map)) invalid("loadOwnerOccurrences");
        for (const [day, value] of loaded) {
          dayStart(day, "loadOwnerOccurrences");
          analyticsV2DayOccurrences(value);
          if (day < span.fromDay || day > span.throughDay) invalid("loadOwnerOccurrences.range");
        }
        if (!matchesEvidence(loaded, new Map([...evidence].filter(([day]) =>
          day >= span.fromDay && day <= span.throughDay)))) invalid("loadOwnerOccurrences.evidence");
        for (const [day, value] of loaded) owned.set(day, value);
      }
    }
    const last = segmentIndex === segments.length - 1;
    if (prefetch && !last) next = startSegment(segmentIndex + 1);
    for (; neededIndex < neededDays.length && neededDays[neededIndex]! <= segment.throughDay; neededIndex += 1) {
      const day = neededDays[neededIndex]!;
      const value = occurrences.get(day) ?? EMPTY_DAY_OCCURRENCES;
      await prepareNeededDay(day, value);
      if (load !== null) {
        if (segmentIndex === lastSegment && value.quota.length > 0) horizonQuota.set(day, value.quota);
        owned.delete(day);
      }
    }
    if (!prefetch && !last) next = startSegment(segmentIndex + 1);
  }
  if (neededIndex !== neededDays.length) throw new Error("ANALYTICS_V2_SEGMENTS_INCOMPLETE");
  // Days of the range that no step needs (outside the run's horizon) go too.
  owned.clear();

  cacheViews.clear();
  // K-PAR-MEM quota semantics: only the final segment is visible to model windows.
  if (load === null) for (const [day, value] of occurrences) {
    if (value.quota.length > 0) horizonQuota.set(day, value.quota);
  }
  const windowInputs = { owner, dates: context.modelDates, prepared, dayDigests, horizonQuota };
  hooks.progress(Object.freeze({ kind: "scalar", accountBytes: hooks.accountBytes() }));
  await timed("scalar", async () => {
    const result = await evaluateScalar(windowInputs, today);
    for (const emission of result.emissions) emit(emission);
    if (result.terminalError !== null) throw result.terminalError;
    fits = result.fits;
  });
  sample();
  await timed("model", async () => {
    const replay = (result: AnalyticsV2ModelDateUnit): void => {
      if ("terminalError" in result) throw result.terminalError;
      if (result.composition === null) modelRefused.push(result.day);
      else compositions.push([result.day, result.composition]);
      emit(result.emission);
      sample();
    };
    if (hooks.modelBlocks !== undefined && shouldFanOutModelDates(evidence, context.modelDates, hooks.modelBlocks.fanOut)) {
      const result = await hooks.modelBlocks.run(windowInputs);
      // Operational metadata only: maximum sampled used heap over the owner
      // isolate and each block isolate; never a whole-process RSS claim.
      if (result.heapPeakBytes !== null) heapPeak = Math.max(heapPeak ?? 0, result.heapPeakBytes);
      for (const date of result.dates) replay(date);
    } else {
      // Inline dates remain separate calls: progress and output charging happen
      // before evaluating the next date, preserving refusal precedence exactly.
      for (const [modelIndex, day] of context.modelDates.entries()) {
        hooks.progress(Object.freeze({ kind: "model", index: modelIndex, accountBytes: hooks.accountBytes() }));
        const [result] = await evaluateModelBlock({ ...windowInputs, dates: [day] });
        replay(result!);
      }
    }
  });
  // `prepared` (with its usage rows) and the horizon's quota occurrences are released with this scope.
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
