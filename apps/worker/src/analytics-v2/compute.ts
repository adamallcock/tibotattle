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
 *   source_conflict_or_order throw for conflict rows, and the cache reducer's
 *   CacheRetentionRefusedError group/session bounds) is recorded per owner,
 *   day and family, and the run carries on. There is no dense or native
 *   fallback. Any other kernel error is a defect and fails the run.
 * - A refused owner-day blocks that queued community day; the day keeps its
 *   prior published revision (A-3). A refused scalar fit removes the owner
 *   from the fit cohort and the preview's participant list. A refused model
 *   date keeps the owner out of that date's composition and counts it as a
 *   refused participant (v1ParticipantCount and refusedParticipantCount), so
 *   the published day states the cohort it could not evaluate. A model date
 *   with no evaluated owner is withheld. Refused evidence is never counted as
 *   zero. (d43c8f92's storage publication instead withholds the model day and
 *   the preview until every member has a result; that is a known divergence.)
 *
 * Input contract (validated, fail closed):
 * - The run uses exactly these days, its horizon: the 170 analysis days
 *   [today-169, today] (production's method constants: 70 model dates, each
 *   over a 101-day window), [cacheFromDay-7, today] for the cache days and
 *   their 7-day lookback, and the queued days. Nothing after today enters a
 *   window or a cache band.
 * - Cache history has no lower bound, as in production (d43c8f92 builds a
 *   cache-retention day for every delivered day; CACHE_RETENTION_FROM_DAY is
 *   unset, and the `all` window is unbounded). An explicit cacheFromDay (A-3
 *   passes the first evidence day it read from the source, or earlier) needs
 *   a read from 7 days before it. When cacheFromDay is omitted it is the
 *   first day with evidence of any effective owner in `occurrencesByOwner`
 *   (or the analysis start, when that is earlier or there is none), and the
 *   occurrences must then be every effective owner's full history: the days
 *   before the first evidence day are known empty, so its 7-day lookback
 *   needs no read.
 * - The caller must have read every horizon day for EVERY effective owner.
 *   `occurrenceRange`, when given, is the inclusive range it read and must
 *   cover analyticsV2RequiredOccurrenceRange(...); when omitted, the read is
 *   taken to be that required range, widened to the first evidence day when
 *   cacheFromDay is omitted. Occurrence days outside the range are rejected.
 *   Every effective owner must have an entry in `occurrencesByOwner` (an empty
 *   map when it has no evidence); a day absent from an owner's map means that
 *   owner had no occurrences that day.
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
  /**
   * The inclusive day range the occurrences were read over, for every owner.
   * Optional: when omitted it is analyticsV2RequiredOccurrenceRange(...) of
   * this input, and the caller is responsible for having read every horizon
   * day (see the module comment).
   */
  readonly occurrenceRange?: AnalyticsV2DayRange;
  /** day -> ownerDigest -> contributing devices (A-1 countContributingDevices). */
  readonly devicesByDay: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, number>>;
  readonly queuedDays: AnalyticsV2QueuedDaysInput;
  readonly nowMs: number;
  readonly revisionSeed: number;
  /**
   * First day that gets cache band rows; occurrenceRange must reach 7 days
   * before it. Defaults to production's unbounded cache history: the first
   * evidence day of any effective owner in occurrencesByOwner (or the
   * analysis start when earlier), with the occurrences taken to be each
   * owner's full history (see the module comment).
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

/** First analysis day: today-169. */
function analysisStart(today: AnalyticsV2Day): AnalyticsV2Day {
  return addDays(today, -(ANALYTICS_V2_ANALYSIS_DAYS - 1));
}

/** The first day with evidence of any effective owner in the input, or null. */
function firstEvidenceDay(owners: readonly AnalyticsV2Owner[],
  occurrencesByOwner: ReadonlyMap<AnalyticsV2OwnerDigest, ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>,
  throughDay: AnalyticsV2Day): AnalyticsV2Day | null {
  let first: AnalyticsV2Day | null = null;
  for (const owner of owners) {
    if (owner.source !== "effective") continue;
    const days = occurrencesByOwner.get(owner.ownerDigest);
    if (!(days instanceof Map)) continue;
    for (const [day, value] of days) {
      dayStart(day, "occurrencesByOwner");
      if (day <= throughDay && hasEvidence(dayOccurrences(value)) && (first === null || day < first)) first = day;
    }
  }
  return first;
}

/**
 * The smallest single occurrence range covering one run's horizon: the
 * analysis horizon [today-169, today], the cache lookback before an explicit
 * cacheFromDay, and every queued day. Without cacheFromDay the cache horizon
 * is the first evidence day (see the module comment), whose lookback is known
 * empty, so the range adds no lookback. The run uses only the horizon days
 * inside it, so a caller may read just those days, as A-3 does with disjoint
 * ranges, and still pass or default to this covering range.
 */
export function analyticsV2RequiredOccurrenceRange(input: {
  nowMs: number; queuedDays: AnalyticsV2QueuedDaysInput; cacheFromDay?: AnalyticsV2Day;
}): AnalyticsV2DayRange {
  const today = analyticsV2Today(input.nowMs);
  let fromDay = analysisStart(today), throughDay = today;
  if (input.cacheFromDay !== undefined) {
    const cacheFromDay = input.cacheFromDay;
    dayStart(cacheFromDay, "cacheFromDay");
    if (cacheFromDay > today) invalid("cacheFromDay");
    const cacheLookback = addDays(cacheFromDay, -CACHE_LOOKBACK_DAYS);
    if (cacheLookback < fromDay) fromDay = cacheLookback;
  }
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
  if (!(input.occurrencesByOwner instanceof Map) || !(input.devicesByDay instanceof Map)) invalid("maps");
  // Production has no lower bound on cache history: by default the cache
  // horizon is the first evidence day (never later than the analysis start).
  const evidenceFrom = input.cacheFromDay === undefined
    ? firstEvidenceDay(owners, input.occurrencesByOwner, today) : null;
  const cacheFromDay = input.cacheFromDay
    ?? (evidenceFrom !== null && evidenceFrom < analysisStart(today) ? evidenceFrom : analysisStart(today));
  const required = analyticsV2RequiredOccurrenceRange({ nowMs, queuedDays: queued,
    ...(input.cacheFromDay === undefined ? {} : { cacheFromDay }) });
  const range = input.occurrenceRange === undefined
    ? { fromDay: cacheFromDay < required.fromDay ? cacheFromDay : required.fromDay, throughDay: required.throughDay }
    : input.occurrenceRange;
  if (!range || typeof range !== "object") invalid("occurrenceRange");
  dayStart(range.fromDay, "occurrenceRange"); dayStart(range.throughDay, "occurrenceRange");
  if (range.fromDay > required.fromDay || range.throughDay < required.throughDay) invalid("occurrenceRange");
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
  // Cache days end today: a day after today is never a cache band, whatever
  // the read range happened to include.
  const cacheDays = daysBetween(cacheFromDay, today);
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
  /** model date -> effective owners whose evaluation the kernels refused. */
  const modelRefusedByDate = new Map<AnalyticsV2Day, number>(modelDates.map((day) => [day, 0]));
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
      today), ...queued]);
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
          modelRefusedByDate.set(day, modelRefusedByDate.get(day)! + 1);
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
      // An effective owner the kernels refused for this date is still a
      // member of its cohort: it is counted as refused, never dropped.
      const refused = modelRefusedByDate.get(day)!;
      const collection: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: refused,
        unsupportedSourceParticipantCount: 0, refusedParticipantCount: refused, storeAvailable: true };
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
