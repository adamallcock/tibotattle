/**
 * analytics-v2 compute core (A-2): one pure, single-threaded full recompute of
 * every community analytics output from effective owner occurrences, using
 * only the vendored d43c8f92 kernels (vendor/analytics-d43c8f92/entry.ts).
 *
 * It does no I/O. A-1 reads its inputs, A-3 persists its outputs in one
 * transaction, and A-4 serves them. The composition follows production
 * (d43c8f92 storage-community-daily.ts, storage-community-graph-publication.ts
 * and analytics-shared-reducers.ts) and the one-process compose proof
 * (analytics-v2-test/compose-proof.spec.ts), which this module must reproduce
 * exactly on the same corpus.
 *
 * Scope tonight, each an explicit refusal rather than a fallback:
 * - Only owners routed `effective` are computed. Every other owner gets one
 *   owner refusal `non_effective_source_unported`. A non-effective owner with
 *   typed (v1, v1.1 or v1.2) evidence is a member of production's daily
 *   cohort, so every queued day it has evidence on is blocked; when its
 *   occurrences were not supplied, every queued day is blocked. A legacy-only
 *   (v0.2) owner is not a daily cohort member and blocks nothing.
 * - A kernel refusal (SharedAnalyticsUnavailable, including the checkedRows
 *   source_conflict_or_order throw for conflict rows) is recorded per owner,
 *   day and family. There is no dense or native fallback.
 * - A refused owner-day blocks that queued community day; the day keeps its
 *   prior published revision (A-3). A refused scalar fit removes the owner
 *   from the fit cohort and the preview's participant list; a refused model
 *   date removes the owner from that date's composition. A model date with no
 *   evaluated owner is withheld. Refused evidence is never counted as zero.
 *
 * Input contract (validated, fail closed):
 * - `occurrenceRange` is the inclusive day range A-1 read for EVERY owner. It
 *   must cover analyticsV2RequiredOccurrenceRange(...). Every effective owner
 *   must have an entry in `occurrencesByOwner` (an empty map when it has no
 *   evidence); a day absent from an owner's map means that owner had no
 *   occurrences that day. Occurrence days outside the range are rejected.
 * - Owner-day rows, windows and cache bands cover the run horizon only: the
 *   170 analysis days, the cache days (from cacheFromDay) with their 7-day
 *   lookback, and the queued days. Evidence elsewhere in the range is unused.
 * - `devicesByDay` holds A-1's contributing-device counts for each queued day
 *   that has a contributing owner. Within a counted day, an owner without a
 *   count takes production's floor of one device (countStorageDaily-
 *   ContributingDevices: "a contributing owner is at least one device").
 *
 * Daily candidates are stamped with the revision a first publication gets
 * (revisionSeed + 1) and releasedAt = nowMs. `payloadSha256` identifies the
 * CONTENT: it is the sha256 of the canonical payload without its revision
 * stamp (aggregateId, revision, releasedAt), so an unchanged day keeps its
 * revision. A-3 restamps a changed day with stampAnalyticsV2DailyPayload.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityDailyPayload,
  buildCommunityModelCompositionDay,
  CACHE_RETENTION_METHOD,
  evaluateSharedCacheDay,
  evaluateSharedModelDate,
  evaluateSharedScalarDate,
  modelHistoryWindow,
  prepareSharedAnalyticsDay,
  publicInputs,
  validateV11DailyProjectionValues,
  validCachedAdminCommunityAllowancePreview,
  type AdminCommunityModelCompositionDay,
  type CachedCommunityModelCompositions,
  type CommunityAllowanceFit,
  type SharedAnalyticsDay,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_CACHE_BAND_COUNTERS,
  ANALYTICS_V2_CONTRACT_VERSION,
  ANALYTICS_V2_DAY_PATTERN,
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  type AnalyticsV2CacheBandCounter,
  type AnalyticsV2CacheBandRow,
  type AnalyticsV2DailyCandidate,
  type AnalyticsV2Day,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerDayRow,
  type AnalyticsV2OwnerDigest,
  type AnalyticsV2OwnerFitsRow,
  type AnalyticsV2OwnerModelDateRow,
  type AnalyticsV2OwnerSource,
  type AnalyticsV2Phase,
  type AnalyticsV2Refusal,
  type AnalyticsV2RunOutputs,
} from "./contract";
import { analyticsV2DayDigest, buildAnalyticsV2Pin, EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences } from "./pin";
import { analyticsV2Refusal, compareAnalyticsV2Refusals, kernelRefusalReason } from "./refusals";

export type { AnalyticsV2DayOccurrences } from "./pin";

const DAY_MS = 86_400_000;
/** Scalar and model windows span modelHistoryWindow(day): the day and the 100 before it. */
const WINDOW_SPAN_DAYS = 101;
/**
 * Model history dates, newest last: today and the 69 days before it. This is
 * d43c8f92 ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS; computeAnalyticsV2 checks
 * the built preview against it so a kernel change cannot drift silently.
 */
export const ANALYTICS_V2_MODEL_DATES = 70;
/** Days the scalar and model windows need: [today-169, today]. */
export const ANALYTICS_V2_ANALYSIS_DAYS = ANALYTICS_V2_MODEL_DATES + WINDOW_SPAN_DAYS - 1;
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

export type AnalyticsV2DailyPublicInputs = ReturnType<typeof publicInputs>;
export type AnalyticsV2DailyPayload = ReturnType<typeof buildCommunityDailyPayload>;

/** A daily candidate plus the revision-free public inputs it was built from. */
export interface AnalyticsV2ComputedDailyCandidate extends AnalyticsV2DailyCandidate {
  readonly payload: AnalyticsV2DailyPayload;
  readonly inputs: AnalyticsV2DailyPublicInputs;
}

export interface AnalyticsV2ComputeOutputs extends AnalyticsV2RunOutputs {
  readonly dailyCandidates: readonly AnalyticsV2ComputedDailyCandidate[];
}

export interface AnalyticsV2DayRange {
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
}

/** A-1 readQueuedDays output, or a bare day list (journal cursor unknown). */
export type AnalyticsV2QueuedDaysInput =
  | { readonly days: readonly AnalyticsV2Day[]; readonly lastSequence: number | null }
  | readonly AnalyticsV2Day[];

export interface ComputeAnalyticsV2Input {
  readonly owners: readonly AnalyticsV2Owner[];
  readonly occurrencesByOwner: ReadonlyMap<AnalyticsV2OwnerDigest, ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>;
  /** The inclusive day range the occurrences were read over, for every owner. */
  readonly occurrenceRange: AnalyticsV2DayRange;
  /** day -> ownerDigest -> contributing devices (A-1 countContributingDevices). */
  readonly devicesByDay: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, number>>;
  readonly queuedDays: AnalyticsV2QueuedDaysInput;
  readonly nowMs: number;
  readonly revisionSeed: number;
  /**
   * First day that gets cache band rows. Defaults to the analysis horizon:
   * the first analysis day plus the 7-day lookback (today-162). An earlier
   * day widens the cache history; occurrenceRange must then reach 7 days
   * before it. Fixed per deployment so the cache output never depends on
   * which days happen to be queued.
   */
  readonly cacheFromDay?: AnalyticsV2Day;
  /** Wall clock for phase timings only; defaults to performance.now. */
  readonly clock?: () => number;
}

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

function dayStart(day: string, what: string): number {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (typeof day !== "string" || !ANALYTICS_V2_DAY_PATTERN.test(day) || !Number.isSafeInteger(at)
    || new Date(at).toISOString().slice(0, 10) !== day) invalid(what);
  return at;
}
const label = (at: number): AnalyticsV2Day => new Date(at).toISOString().slice(0, 10);
const addDays = (day: AnalyticsV2Day, days: number): AnalyticsV2Day => label(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
function daysBetween(fromDay: AnalyticsV2Day, throughDay: AnalyticsV2Day): AnalyticsV2Day[] {
  const out: AnalyticsV2Day[] = [];
  for (let at = Date.parse(`${fromDay}T00:00:00.000Z`), end = Date.parse(`${throughDay}T00:00:00.000Z`); at <= end; at += DAY_MS) {
    out.push(label(at));
  }
  return out;
}

/** UTC day of nowMs. */
export function analyticsV2Today(nowMs: number): AnalyticsV2Day {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid("nowMs");
  return label(nowMs);
}

function queuedDayList(queued: AnalyticsV2QueuedDaysInput): readonly AnalyticsV2Day[] {
  if (Array.isArray(queued)) return queued as readonly AnalyticsV2Day[];
  if (!queued || typeof queued !== "object" || !Array.isArray((queued as { days?: unknown }).days)) invalid("queuedDays");
  return (queued as { days: readonly AnalyticsV2Day[] }).days;
}

function defaultCacheFromDay(today: AnalyticsV2Day): AnalyticsV2Day {
  return addDays(today, -(ANALYTICS_V2_ANALYSIS_DAYS - 1) + CACHE_LOOKBACK_DAYS);
}

/**
 * The smallest occurrence range one run needs: the analysis horizon
 * [today-169, today], the cache lookback before cacheFromDay, and every queued
 * day. A-3 reads at least this range for every owner.
 */
export function analyticsV2RequiredOccurrenceRange(input: {
  nowMs: number; queuedDays: AnalyticsV2QueuedDaysInput; cacheFromDay?: AnalyticsV2Day;
}): AnalyticsV2DayRange {
  const today = analyticsV2Today(input.nowMs);
  const cacheFromDay = input.cacheFromDay ?? defaultCacheFromDay(today);
  dayStart(cacheFromDay, "cacheFromDay");
  if (cacheFromDay > today) invalid("cacheFromDay");
  let fromDay = addDays(today, -(ANALYTICS_V2_ANALYSIS_DAYS - 1)), throughDay = today;
  const cacheLookback = addDays(cacheFromDay, -CACHE_LOOKBACK_DAYS);
  if (cacheLookback < fromDay) fromDay = cacheLookback;
  for (const day of queuedDayList(input.queuedDays)) {
    dayStart(day, "queuedDays");
    if (day < fromDay) fromDay = day;
    if (day > throughDay) throughDay = day;
  }
  return { fromDay, throughDay };
}

function stripFinalized(daily: SharedAnalyticsDay["daily"]): V11DailyProjectionValues {
  // prepareSharedAnalyticsDay returns the FINALIZED daily (it adds coverage and
  // knownCostNanousd). Folds and validateV11DailyProjectionValues take the
  // closed, unfinalized shape, exactly as the compose proof strips it.
  const { coverage: _coverage, knownCostNanousd: _known, ...value } = daily;
  return value;
}

function hasEvidence(day: AnalyticsV2DayOccurrences | undefined): boolean {
  return day !== undefined && day.usage.length + day.quota.length + day.session.length > 0;
}

/** Production source routing (d43c8f92 storage-community-graph.ts). */
function expectedSource(owner: AnalyticsV2Owner): AnalyticsV2OwnerSource {
  return owner.hasEffective ? "effective" : owner.hasV11 ? "v1.1" : owner.hasV1 ? owner.hasLegacy ? "mixed" : "v1" : "v0.2";
}

function validOwners(owners: readonly AnalyticsV2Owner[]): AnalyticsV2Owner[] {
  if (!Array.isArray(owners)) invalid("owners");
  const seen = new Set<string>();
  const copies = owners.map((owner) => {
    if (!owner || typeof owner !== "object" || typeof owner.ownerDigest !== "string"
      || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(owner.ownerDigest) || seen.has(owner.ownerDigest)
      || typeof owner.participantId !== "string" || owner.participantId.length === 0
      || ![owner.hasV1, owner.hasV11, owner.hasV12, owner.hasLegacy, owner.hasEffective].every((flag) => typeof flag === "boolean")
      || owner.source !== expectedSource(owner)
      || (owner.hasV12 && !owner.hasEffective)) invalid("owners");
    seen.add(owner.ownerDigest);
    return Object.freeze({ participantId: owner.participantId, ownerDigest: owner.ownerDigest, hasV1: owner.hasV1,
      hasV11: owner.hasV11, hasV12: owner.hasV12, hasLegacy: owner.hasLegacy, hasEffective: owner.hasEffective,
      source: owner.source });
  });
  return copies.sort((left, right) => (left.ownerDigest < right.ownerDigest ? -1 : 1));
}

function dayOccurrences(value: unknown): AnalyticsV2DayOccurrences {
  const day = value as AnalyticsV2DayOccurrences;
  if (!day || typeof day !== "object" || !Array.isArray(day.usage) || !Array.isArray(day.quota)
    || !Array.isArray(day.session)) invalid("occurrencesByOwner");
  return day;
}

/**
 * A daily payload's content identity: sha256 of its canonical JSON without the
 * revision stamp (aggregateId, revision, releasedAt). Equal for every stamp of
 * the same content, so A-3 and A-4 can verify a stored row against it.
 */
export async function analyticsV2DailyContentSha256(payload: AnalyticsV2DailyPayload): Promise<string> {
  const { aggregateId: _aggregateId, revision: _revision, releasedAt: _releasedAt, ...content } = payload;
  return sha256Hex(canonicalJson(content));
}

/**
 * The payload A-3 publishes for `candidate` under a given revision and
 * release time. The content (and so payloadSha256) is unchanged; only the
 * kernel's revision stamp (aggregateId, revision, releasedAt) differs.
 */
export async function stampAnalyticsV2DailyPayload(candidate: AnalyticsV2ComputedDailyCandidate,
  stamp: { revision: number; releasedAt: string }): Promise<AnalyticsV2DailyPayload> {
  if (!Number.isSafeInteger(stamp.revision) || stamp.revision < 1 || typeof stamp.releasedAt !== "string"
    || !Number.isFinite(Date.parse(stamp.releasedAt))
    || new Date(Date.parse(stamp.releasedAt)).toISOString() !== stamp.releasedAt) {
    throw new TypeError("ANALYTICS_V2_DAILY_STAMP_INVALID");
  }
  const payload = buildCommunityDailyPayload({ day: candidate.day, revision: stamp.revision,
    releasedAt: stamp.releasedAt, ...candidate.inputs });
  if (await analyticsV2DailyContentSha256(payload) !== candidate.payloadSha256) {
    throw new Error("ANALYTICS_V2_DAILY_CONTENT_CHANGED");
  }
  return payload;
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

/** The full-mode recompute. Pure: no I/O, no shared state, one thread. */
export async function computeAnalyticsV2(input: ComputeAnalyticsV2Input): Promise<AnalyticsV2ComputeOutputs> {
  const clock = input.clock ?? (() => performance.now());
  const timings: Partial<Record<AnalyticsV2Phase, number>> = {};
  const timed = async <T>(phase: AnalyticsV2Phase, work: () => Promise<T> | T): Promise<T> => {
    const started = clock();
    try { return await work(); } finally { timings[phase] = (timings[phase] ?? 0) + (clock() - started); }
  };

  // ---- Validate the whole input before any kernel runs.
  const nowMs = input.nowMs, today = analyticsV2Today(nowMs), nowIso = new Date(nowMs).toISOString();
  if (!Number.isSafeInteger(input.revisionSeed) || input.revisionSeed < 0) invalid("revisionSeed");
  const owners = validOwners(input.owners);
  const queuedInput = queuedDayList(input.queuedDays);
  const lastSequence = Array.isArray(input.queuedDays) ? null
    : (input.queuedDays as { lastSequence: number | null }).lastSequence;
  if (lastSequence !== null && (!Number.isSafeInteger(lastSequence) || lastSequence < 0)) invalid("queuedDays.lastSequence");
  for (const day of queuedInput) dayStart(day, "queuedDays");
  const queued = [...new Set(queuedInput)].sort();
  const cacheFromDay = input.cacheFromDay ?? defaultCacheFromDay(today);
  const required = analyticsV2RequiredOccurrenceRange({ nowMs, queuedDays: queued, cacheFromDay });
  const range = input.occurrenceRange;
  if (!range || typeof range !== "object") invalid("occurrenceRange");
  dayStart(range.fromDay, "occurrenceRange"); dayStart(range.throughDay, "occurrenceRange");
  if (range.fromDay > required.fromDay || range.throughDay < required.throughDay) invalid("occurrenceRange");
  if (!(input.occurrencesByOwner instanceof Map) || !(input.devicesByDay instanceof Map)) invalid("maps");
  const ownerSet = new Set(owners.map((owner) => owner.ownerDigest));
  for (const [ownerDigest, days] of input.occurrencesByOwner) {
    if (!ownerSet.has(ownerDigest) || !(days instanceof Map)) invalid("occurrencesByOwner");
    for (const [day, value] of days) {
      dayStart(day, "occurrencesByOwner");
      if (day < range.fromDay || day > range.throughDay) invalid("occurrencesByOwner.range");
      dayOccurrences(value);
    }
  }
  for (const [day, counts] of input.devicesByDay) {
    dayStart(day, "devicesByDay");
    if (!(counts instanceof Map)) invalid("devicesByDay");
    for (const [ownerDigest, count] of counts) {
      if (!ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(ownerDigest) || !Number.isSafeInteger(count) || count < 1) {
        invalid("devicesByDay");
      }
    }
  }

  const analysisDays = daysBetween(addDays(today, -(ANALYTICS_V2_ANALYSIS_DAYS - 1)), today);
  const modelDates = analysisDays.slice(-ANALYTICS_V2_MODEL_DATES);
  const cacheDays = daysBetween(cacheFromDay, range.throughDay);
  const queuedSet = new Set(queued);
  const refusals: AnalyticsV2Refusal[] = [];
  const ownerDays: AnalyticsV2OwnerDayRow[] = [];
  const cacheBands: AnalyticsV2CacheBandRow[] = [];
  const ownerFits: AnalyticsV2OwnerFitsRow[] = [];
  const ownerModelDates: AnalyticsV2OwnerModelDateRow[] = [];
  const blocked = new Set<AnalyticsV2Day>();
  /** queued day -> effective owner -> unfinalized daily values (owners in digest order). */
  const dailyValues = new Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>(
    queued.map((day) => [day, new Map()]));
  const fitsByOwner = new Map<AnalyticsV2OwnerDigest, readonly CommunityAllowanceFit[]>();
  const compositionsByDate = new Map<AnalyticsV2Day, Array<{ ownerDigest: string; result: V1ModelCompositionResult }>>(
    modelDates.map((day) => [day, []]));
  const effectiveOwners: AnalyticsV2Owner[] = [];

  for (const owner of owners) {
    const occurrences = input.occurrencesByOwner.get(owner.ownerDigest);
    if (owner.source !== "effective") {
      refusals.push(analyticsV2Refusal(owner.ownerDigest, null, "owner", "non_effective_source_unported"));
      // Typed evidence makes the owner a member of production's daily cohort:
      // a queued day it may have evidence on cannot be published without it.
      if (owner.hasV1 || owner.hasV11 || owner.hasV12) {
        for (const day of queued) {
          if (occurrences !== undefined && !hasEvidence(occurrences.get(day))) continue;
          blocked.add(day);
          refusals.push(analyticsV2Refusal(owner.ownerDigest, day, "daily", "non_effective_source_unported"));
        }
      }
      continue;
    }
    if (occurrences === undefined) invalid("occurrencesByOwner.missingEffectiveOwner");
    effectiveOwners.push(owner);
    const ownerDigest = owner.ownerDigest;

    // ---- Prepare every day a window, the cache horizon or the queue needs.
    // Empty days are prepared too: a window is complete only when every one of
    // its days is present. Evidence elsewhere in the read range is outside this
    // run's horizon, so the outputs depend only on nowMs, the queue and
    // cacheFromDay, never on how widely A-1 happened to read.
    const needed = new Set<AnalyticsV2Day>([...analysisDays, ...daysBetween(addDays(cacheFromDay, -CACHE_LOOKBACK_DAYS),
      range.throughDay), ...queued]);
    const prepared = new Map<AnalyticsV2Day, SharedAnalyticsDay>();
    const dayDigests = new Map<AnalyticsV2Day, string>();
    await timed("prepare", async () => {
      for (const day of [...needed].sort()) {
        const value = occurrences!.get(day) ?? EMPTY_DAY_OCCURRENCES;
        if (day >= analysisDays[0]! && day <= today) dayDigests.set(day, await analyticsV2DayDigest(day, value));
        let refusal: AnalyticsV2Refusal["reason"] | null = null, daily: V11DailyProjectionValues | null = null;
        try {
          const shared = await prepareSharedAnalyticsDay({ day, ownerDigest, usage: value.usage,
            quota: value.quota, session: value.session });
          prepared.set(day, shared);
          daily = stripFinalized(shared.daily);
          validateV11DailyProjectionValues(daily);
        } catch (error) {
          refusal = kernelRefusalReason(error);
          if (refusal === null) throw error;
          refusals.push(analyticsV2Refusal(ownerDigest, day, "daily", refusal));
        }
        if (queuedSet.has(day)) {
          if (daily === null) blocked.add(day);
          else dailyValues.get(day)!.set(ownerDigest, daily);
        }
        if (hasEvidence(value)) ownerDays.push(Object.freeze({ ownerDigest, day, daily, refusal }));
      }
    });
    const windowFor = (day: AnalyticsV2Day): SharedAnalyticsDay[] => daysBetween(modelHistoryWindow(day).fromDay, day)
      .flatMap((value) => prepared.get(value) ?? []);

    // ---- Current scalar fits: today only.
    await timed("scalar", async () => {
      try {
        const pin = await buildAnalyticsV2Pin({ owner, day: today, dayDigests });
        const result = await evaluateSharedScalarDate({ pin, day: today, ownerDigest, days: windowFor(today) });
        fitsByOwner.set(ownerDigest, result.selectedFits);
        ownerFits.push(Object.freeze({ ownerDigest, asOfDay: today, fits: result.selectedFits }));
      } catch (error) {
        const reason = kernelRefusalReason(error);
        if (reason === null) throw error;
        refusals.push(analyticsV2Refusal(ownerDigest, today, "scalar", reason));
      }
    });

    // ---- Model history: each of the 70 dates over its own 101-day window.
    await timed("model", async () => {
      for (const day of modelDates) {
        try {
          const pin = await buildAnalyticsV2Pin({ owner, day, dayDigests });
          const result = await evaluateSharedModelDate({ pin, day, ownerDigest,
            days: windowFor(day) }) as V1ModelCompositionResult;
          compositionsByDate.get(day)!.push({ ownerDigest, result });
          ownerModelDates.push(Object.freeze({ ownerDigest, day, result: withoutFingerprint(result) }));
        } catch (error) {
          const reason = kernelRefusalReason(error);
          if (reason === null) throw error;
          refusals.push(analyticsV2Refusal(ownerDigest, day, "model", reason));
        }
      }
    });

    // ---- Cache continuity: the day with its 7-day carry. A prepared day with
    // no cache items has no groups and needs no reducer call.
    await timed("cache", () => {
      for (const day of cacheDays) {
        // Every cache day was prepared above; an absent one was refused, and the
        // reducer records that as incomplete_cache_day.
        const own = prepared.get(day);
        if (own !== undefined && own.cacheItems.length === 0) continue;
        try {
          const aggregate = evaluateSharedCacheDay({ day, ownerDigest,
            days: daysBetween(addDays(day, -CACHE_LOOKBACK_DAYS), day).flatMap((value) => prepared.get(value) ?? []) });
          for (const group of aggregate.groups) {
            for (const band of group.bands) {
              cacheBands.push(Object.freeze({ ownerDigest, day, model: group.model, effort: group.effort,
                band: band.band, counters: bandCounters(band) }));
            }
          }
        } catch (error) {
          const reason = kernelRefusalReason(error);
          if (reason === null) throw error;
          refusals.push(analyticsV2Refusal(ownerDigest, day, "cache", reason));
        }
      }
    });
    // `prepared` (including transient usage rows) is released with this scope.
  }

  // ---- Community outputs.
  const community = await timed("community", async () => {
    const dailyCandidates: AnalyticsV2ComputedDailyCandidate[] = [];
    for (const day of queued) {
      if (blocked.has(day)) continue;
      const byOwner = dailyValues.get(day)!;
      const values = effectiveOwners.map((owner) => byOwner.get(owner.ownerDigest)!);
      const counted = input.devicesByDay.get(day);
      const devices = values.map((value, index) => {
        if (value.counts.usage + value.counts.quota + value.counts.session === 0) return 0;
        if (counted === undefined) return invalid("devicesByDay.missingDay");
        return counted.get(effectiveOwners[index]!.ownerDigest) ?? 1;
      });
      const inputs = publicInputs(values, devices);
      const payload = buildCommunityDailyPayload({ day, revision: input.revisionSeed + 1, releasedAt: nowIso, ...inputs });
      dailyCandidates.push(Object.freeze({ day, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
        inputs }));
    }

    const fits = effectiveOwners.flatMap((owner) => fitsByOwner.get(owner.ownerDigest) ?? []);
    const cohort = effectiveOwners.filter((owner) => fitsByOwner.has(owner.ownerDigest)).map((owner) => owner.ownerDigest);
    const modelDays: AdminCommunityModelCompositionDay[] = [];
    for (const day of modelDates) {
      const evaluated = compositionsByDate.get(day)!;
      if (evaluated.length === 0) continue;
      const collection: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: 0,
        unsupportedSourceParticipantCount: 0, refusedParticipantCount: 0, storeAvailable: true };
      for (const { ownerDigest, result } of evaluated) {
        collection.v1ParticipantCount++;
        if (result.status === "ready") collection.compositions.push({ participantId: ownerDigest, composition: result });
        else collection.refusedParticipantCount++;
      }
      modelDays.push(buildCommunityModelCompositionDay(collection, day));
    }
    const built = buildAdminCommunityAllowancePreview(fits, nowMs, cohort, {
      modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
      gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays });
    if (built.days.length !== ANALYTICS_V2_MODEL_DATES) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
    const preview = validCachedAdminCommunityAllowancePreview(built, built.generatedAt, nowMs) ? built : null;
    return { dailyCandidates, preview };
  });

  return {
    contractVersion: ANALYTICS_V2_CONTRACT_VERSION,
    mode: "full",
    nowMs,
    today,
    revisionSeed: input.revisionSeed,
    owners,
    ownerDays,
    cacheBands,
    ownerFits,
    ownerModelDates,
    dailyCandidates: community.dailyCandidates,
    blockedDays: [...blocked].sort(),
    preview: community.preview,
    refusals: refusals.sort(compareAnalyticsV2Refusals),
    journal: { lastSequence },
    timings,
  };
}
