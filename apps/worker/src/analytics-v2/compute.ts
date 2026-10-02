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
 * Scope:
 * - Only owners routed `effective` are computed. Every other owner gets one
 *   owner refusal `non_effective_source_unported`. A non-effective owner with
 *   typed (v1, v1.1 or v1.2) evidence is a member of production's daily
 *   cohort, so every queued day it has evidence on is blocked; when its
 *   occurrences were not supplied, every queued day is blocked. A legacy-only
 *   (v0.2) owner is not a daily cohort member and blocks nothing.
 * - Dense owners take production's native path (native-path.ts): where the
 *   vendored shared reducers refuse at their experiment bounds (20,000
 *   occurrences or 32 MiB a day, 120,000 usage rows or 1,024 pages a window,
 *   an unrepresentable quota or usage day, a refused quota fold), the owner-day
 *   or window is computed as d43c8f92's advanceStorageEffectiveAnalysis and
 *   daily lane compute it. Only the GCP day backstop (resources.ts) refuses a
 *   day, with the experiment's own reasons.
 * - An effective owner whose deterministic memory estimate (resources.ts,
 *   from its evidence counts) exceeds the run's budget is refused as a whole
 *   before it is read: one owner refusal `memory_budget`, a daily refusal and
 *   a blocked day for every queued day it has evidence on, and no fit, so
 *   the preview, and with it every model date, is withheld for the run
 *   (below). Nothing of it is written, so its stored rows from earlier runs
 *   are retained.
 * - A kernel refusal (SharedAnalyticsUnavailable, including the checkedRows
 *   source_conflict_or_order throw for conflict rows, and the cache reducer's
 *   CacheRetentionRefusedError group/session bounds) is recorded per owner,
 *   day and family, and the run carries on. Any other kernel error is a defect
 *   and fails the run. A day the backstop or the kernels refuse is never
 *   serialized for its evidence digest: it gets a refusal marker instead, and
 *   every window containing it is refused (incomplete_window), so the marker
 *   never pins a result.
 * - A refused owner-day blocks that queued community day; the day keeps its
 *   prior published revision (A-3).
 * - The preview follows d43c8f92 publishStorageCommunityGraphPreview: it is
 *   built only when every effective owner has a current fits result. One
 *   effective owner without one (a refused scalar fit, or the memory budget)
 *   withholds it: preview is null and A-4 serves the allowance as
 *   temporarily unavailable. A partial fit cohort is never published, because
 *   the preview's coverage counts would silently omit that owner. (Production
 *   keeps serving its last completed preview while it remains valid; analytics_v2
 *   stores this run's null.) Non-effective owners are outside the GCP cohort:
 *   their paths are not ported (non_effective_source_unported), a known
 *   divergence recorded in the fast-path plan.
 * - Model dates publish per date (decision D7, the owner's decision of
 *   2026-10-01, fast-path OD-12). A refused model date keeps the owner out of
 *   that date's composition and counts it as a refused participant
 *   (v1ParticipantCount and refusedParticipantCount), so the published day
 *   states the cohort it could not evaluate, including a date on which every
 *   effective owner was refused. A date with no effective cohort member at all
 *   is not published. Refused evidence is never counted as zero. (d43c8f92's
 *   storage publication instead withholds a 14-date model block until every
 *   member has a result.)
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
 * - Streaming (the Job): with `loadOwnerOccurrences`, effective owners are not
 *   in `occurrencesByOwner`. `ownerEvidence` then gives each effective owner's
 *   exact per-day counts (A-1 countOwnerOccurrences); the memory guard and the
 *   cache horizon use them. Each admitted owner is loaded in digest order, in
 *   bounded segments: the days before the analysis horizon in history
 *   segments (resources.ts analyticsV2HistorySegments), oldest first, each
 *   released before the next is loaded, then the analysis horizon through the
 *   end of the range, held until the owner is computed. A segment load whose
 *   counts differ from its evidence fails the run. Without a loader the
 *   evidence is counted from `occurrencesByOwner` and the results are
 *   identical: each day is processed exactly once, in day order, either way.
 * - Output account: every output row (owner-day, cache band, fits, model
 *   date, refusal) and every held non-effective occurrence is charged to the
 *   run's output account as it is produced (resources.ts
 *   ANALYTICS_V2_OUTPUT_MODEL). The moment the account exceeds
 *   resources.outputBudgetBytes the run fails with
 *   ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED and nothing is written.
 * - Checkpoints: `checkpoint`, when given, is called with the run plan before
 *   the first owner, at each effective owner, each segment load and each model
 *   date, and before the community fold. It may throw (the Job's time guard);
 *   the error ends the run and nothing is written.
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
  modelHistoryWindow,
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
  type AnalyticsV2OwnerResources,
  type AnalyticsV2OwnerSource,
  type AnalyticsV2Phase,
  type AnalyticsV2Refusal,
  type AnalyticsV2RunOutputs,
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
import { analyticsV2Refusal, compareAnalyticsV2Refusals, kernelRefusalReason } from "./refusals";
import {
  ANALYTICS_V2_DEFAULT_RESOURCES,
  ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES,
  ANALYTICS_V2_MEMORY_MODEL,
  ANALYTICS_V2_OUTPUT_MODEL,
  analyticsV2HeldOccurrenceBytes,
  analyticsV2HistorySegments,
  analyticsV2OutputRowBytes,
  analyticsV2OwnerMemoryEstimate,
  validAnalyticsV2Resources,
  type AnalyticsV2DaySpan,
  type AnalyticsV2OwnerEvidence,
  type AnalyticsV2Resources,
} from "./resources";

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
  /**
   * Streaming read (the Job): returns one effective owner's occurrences over
   * `range`, an inclusive span inside the read range. Each admitted effective
   * owner is loaded in digest order, one bounded segment at a time (see the
   * module comment), and each segment is released after it is reduced. With a
   * loader, occurrencesByOwner holds non-effective owners only and
   * ownerEvidence is required.
   */
  readonly loadOwnerOccurrences?: (ownerDigest: AnalyticsV2OwnerDigest, range: AnalyticsV2DayRange) =>
    Promise<ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>;
  /**
   * Exact per-day evidence counts of every effective owner over the read
   * range (A-1 countOwnerOccurrences). Required with a loader and refused
   * without one, where the counts come from occurrencesByOwner.
   */
  readonly ownerEvidence?: ReadonlyMap<AnalyticsV2OwnerDigest, AnalyticsV2OwnerEvidence>;
  /** Budget and day backstop (resources.ts); defaults to ANALYTICS_V2_DEFAULT_RESOURCES. */
  readonly resources?: AnalyticsV2Resources;
  /**
   * Heap bytes in use, sampled while an owner is computed and recorded as its
   * heapPeakBytes. Operational metadata only: no decision reads it.
   */
  readonly memoryProbe?: () => number;
  /**
   * Progress hook (the Job's time guard). Called with the plan before the
   * first owner, then at each effective owner, segment load and model date,
   * and before the community fold. Anything it throws ends the run.
   */
  readonly checkpoint?: (event: AnalyticsV2Checkpoint) => void;
}

/** One planned effective owner: its counts on the run's days and the guard's decision. */
export interface AnalyticsV2PlannedOwner {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly admitted: boolean;
  readonly occurrences: number;
  readonly analysisUsage: number;
  readonly estimateBytes: number;
}

/** A computeAnalyticsV2 progress event; content-free (digests, counts and bytes). */
export type AnalyticsV2Checkpoint =
  | { readonly kind: "plan"; readonly owners: readonly AnalyticsV2PlannedOwner[] }
  | { readonly kind: "owner"; readonly index: number; readonly ownerDigest: AnalyticsV2OwnerDigest;
    readonly accountBytes: number }
  | { readonly kind: "segment"; readonly index: number; readonly occurrences: number; readonly accountBytes: number }
  | { readonly kind: "model"; readonly index: number; readonly accountBytes: number }
  | { readonly kind: "community"; readonly accountBytes: number };

/**
 * The run's output account exceeded resources.outputBudgetBytes: a closed run
 * refusal (nothing is written), with content-free byte figures only.
 */
export class AnalyticsV2OutputBudgetExceeded extends Error {
  readonly code = "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED" as const;
  readonly accountBytes: number;
  readonly outputBudgetBytes: number;

  constructor(accountBytes: number, outputBudgetBytes: number) {
    super("ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED");
    this.name = "AnalyticsV2OutputBudgetExceeded";
    this.accountBytes = accountBytes;
    this.outputBudgetBytes = outputBudgetBytes;
  }
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

/** The first day, through `throughDay`, with evidence of any owner in `evidenceByOwner`, or null. */
function firstEvidenceDay(evidenceByOwner: ReadonlyMap<AnalyticsV2OwnerDigest, AnalyticsV2OwnerEvidence>,
  throughDay: AnalyticsV2Day): AnalyticsV2Day | null {
  let first: AnalyticsV2Day | null = null;
  for (const evidence of evidenceByOwner.values()) {
    for (const day of evidence.keys()) if (day <= throughDay && (first === null || day < first)) first = day;
  }
  return first;
}

function evidenceTotal(counts: { usage: number; quota: number; session: number }): number {
  return counts.usage + counts.quota + counts.session;
}

/** The exact per-day counts of one owner's occurrences: days with evidence only. */
function evidenceOf(days: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>): AnalyticsV2OwnerEvidence {
  const evidence = new Map<AnalyticsV2Day, { usage: number; quota: number; session: number }>();
  for (const [day, value] of days) {
    const occurrences = dayOccurrences(value);
    const counts = { usage: occurrences.usage.length, quota: occurrences.quota.length,
      session: occurrences.session.length };
    if (evidenceTotal(counts) > 0) evidence.set(day, Object.freeze(counts));
  }
  return evidence;
}

/** A supplied evidence map: valid days inside `range`, non-negative counts, no empty day. */
function validEvidence(value: unknown, range: AnalyticsV2DayRange): AnalyticsV2OwnerEvidence {
  if (!(value instanceof Map)) invalid("ownerEvidence");
  for (const [day, counts] of value as Map<unknown, unknown>) {
    dayStart(day as string, "ownerEvidence");
    if ((day as string) < range.fromDay || (day as string) > range.throughDay) invalid("ownerEvidence.range");
    const entry = counts as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object"
      || Object.keys(entry).sort().join(",") !== "quota,session,usage"
      || ![entry.usage, entry.quota, entry.session].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)
      || evidenceTotal(entry as { usage: number; quota: number; session: number }) === 0) invalid("ownerEvidence");
  }
  return value as AnalyticsV2OwnerEvidence;
}

/** True when `days` holds exactly the occurrences `evidence` counts. */
function matchesEvidence(days: ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>,
  evidence: AnalyticsV2OwnerEvidence): boolean {
  const counted = evidenceOf(days);
  if (counted.size !== evidence.size) return false;
  for (const [day, counts] of counted) {
    const expected = evidence.get(day);
    if (expected === undefined || expected.usage !== counts.usage || expected.quota !== counts.quota
      || expected.session !== counts.session) return false;
  }
  return true;
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
  const resources = validAnalyticsV2Resources(input.resources ?? ANALYTICS_V2_DEFAULT_RESOURCES);
  const loader = input.loadOwnerOccurrences;
  if (loader !== undefined && typeof loader !== "function") invalid("loadOwnerOccurrences");
  if ((loader === undefined) !== (input.ownerEvidence === undefined)) invalid("ownerEvidence");
  if (input.memoryProbe !== undefined && typeof input.memoryProbe !== "function") invalid("memoryProbe");
  if (input.checkpoint !== undefined && typeof input.checkpoint !== "function") invalid("checkpoint");
  const checkpoint = input.checkpoint ?? ((): void => {});
  const ownerSet = new Set(owners.map((owner) => owner.ownerDigest));
  const effectiveDigests = owners.filter((owner) => owner.source === "effective").map((owner) => owner.ownerDigest);
  for (const [ownerDigest, days] of input.occurrencesByOwner) {
    if (!ownerSet.has(ownerDigest) || !(days instanceof Map)) invalid("occurrencesByOwner");
    for (const [day, value] of days) {
      dayStart(day, "occurrencesByOwner");
      dayOccurrences(value);
    }
  }
  // The effective owners' evidence: counted from the supplied occurrences, or
  // the reader's exact counts when owners are streamed.
  const evidenceByOwner = new Map<AnalyticsV2OwnerDigest, AnalyticsV2OwnerEvidence>();
  if (loader === undefined) {
    for (const ownerDigest of effectiveDigests) {
      const days = input.occurrencesByOwner.get(ownerDigest);
      if (days === undefined) invalid("occurrencesByOwner.missingEffectiveOwner");
      evidenceByOwner.set(ownerDigest, evidenceOf(days!));
    }
  } else {
    if (!(input.ownerEvidence instanceof Map)) invalid("ownerEvidence");
    for (const [ownerDigest, evidence] of input.ownerEvidence!) {
      if (!effectiveDigests.includes(ownerDigest) || !(evidence instanceof Map)) invalid("ownerEvidence");
      for (const day of evidence.keys()) dayStart(day, "ownerEvidence");
    }
    for (const ownerDigest of effectiveDigests) {
      if (input.occurrencesByOwner.has(ownerDigest)) invalid("occurrencesByOwner.streamedEffectiveOwner");
      if (!input.ownerEvidence!.has(ownerDigest)) invalid("ownerEvidence.missingEffectiveOwner");
    }
  }
  // Production has no lower bound on cache history: by default the cache
  // horizon is the first evidence day (never later than the analysis start).
  const evidenceFrom = input.cacheFromDay === undefined
    ? firstEvidenceDay(loader === undefined ? evidenceByOwner : input.ownerEvidence!, today) : null;
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
  const inRange = (days: ReadonlyMap<AnalyticsV2Day, unknown>): void => {
    for (const day of days.keys()) if (day < range.fromDay || day > range.throughDay) invalid("occurrencesByOwner.range");
  };
  for (const days of input.occurrencesByOwner.values()) inRange(days);
  if (loader !== undefined) {
    for (const [ownerDigest, evidence] of input.ownerEvidence!) {
      evidenceByOwner.set(ownerDigest, validEvidence(evidence, range));
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
  const analysisFrom = analysisDays[0]!;
  // Cache days end today: a day after today is never a cache band, whatever
  // the read range happened to include.
  const queuedSet = new Set(queued);
  const refusals: AnalyticsV2Refusal[] = [];
  const ownerDays: AnalyticsV2OwnerDayRow[] = [];
  const cacheBands: AnalyticsV2CacheBandRow[] = [];
  const ownerFits: AnalyticsV2OwnerFitsRow[] = [];
  const ownerModelDates: AnalyticsV2OwnerModelDateRow[] = [];
  const ownerResources: AnalyticsV2OwnerResources[] = [];
  const blocked = new Set<AnalyticsV2Day>();
  /** queued day -> computed owner -> unfinalized daily values (owners in digest order). */
  const dailyValues = new Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>(
    queued.map((day) => [day, new Map()]));
  const fitsByOwner = new Map<AnalyticsV2OwnerDigest, readonly CommunityAllowanceFit[]>();
  const compositionsByDate = new Map<AnalyticsV2Day, Array<{ ownerDigest: string; result: V1ModelCompositionResult }>>(
    modelDates.map((day) => [day, []]));
  /**
   * model date -> effective owners whose evaluation the kernels refused. (A
   * memory-refused owner has no fit, so the preview that carries the model
   * dates is withheld for the run; it is never counted here.)
   */
  const modelRefusedByDate = new Map<AnalyticsV2Day, number>(modelDates.map((day) => [day, 0]));
  /** Effective owners that were computed (admitted by the memory budget). */
  const computedOwners: AnalyticsV2Owner[] = [];
  // Every day a window, the cache horizon or the queue needs. Empty days are
  // prepared too: a window is complete only when every one of its days is
  // present. Evidence elsewhere in the read range is outside this run's
  // horizon, so the outputs depend only on nowMs, the queue and cacheFromDay,
  // never on how widely A-1 happened to read.
  const neededDays = [...new Set<AnalyticsV2Day>([...analysisDays,
    ...daysBetween(addDays(cacheFromDay, -CACHE_LOOKBACK_DAYS), today), ...queued])].sort();
  const neededSet = new Set(neededDays);

  // ---- The output account: every held output row, and the non-effective
  // owners' held occurrences, against the output budget.
  let accountBytes = 0;
  let ownerOutputBytes = 0;
  const charge = (bytes: number): void => {
    accountBytes += bytes;
    ownerOutputBytes += bytes;
    if (accountBytes > resources.outputBudgetBytes) {
      throw new AnalyticsV2OutputBudgetExceeded(accountBytes, resources.outputBudgetBytes);
    }
  };
  const chargeRow = (row: unknown): void => charge(analyticsV2OutputRowBytes(row));
  for (const ownerDigest of owners.filter((owner) => owner.source !== "effective").map((owner) => owner.ownerDigest)) {
    const days = input.occurrencesByOwner.get(ownerDigest);
    if (days !== undefined) for (const counts of evidenceOf(days).values()) charge(analyticsV2HeldOccurrenceBytes(counts));
  }
  const heldInputBytes = accountBytes;
  const pushRefusal = (refusal: AnalyticsV2Refusal): void => {
    refusals.push(refusal);
    chargeRow(refusal);
  };

  // ---- The plan: the memory guard is a pure function of the evidence counts
  // on the days this run uses, so a wider read never moves a decision. (The
  // Job reads exactly those days, give or take queued days after today.)
  const plan = new Map<AnalyticsV2OwnerDigest, ReturnType<typeof analyticsV2OwnerMemoryEstimate>>();
  for (const ownerDigest of effectiveDigests) {
    plan.set(ownerDigest, analyticsV2OwnerMemoryEstimate(
      new Map([...evidenceByOwner.get(ownerDigest)!].filter(([day]) => neededSet.has(day))), analysisFrom, today));
  }
  const admittedOwner = (estimate: ReturnType<typeof analyticsV2OwnerMemoryEstimate>): boolean =>
    estimate.estimateBytes <= resources.memoryBudgetBytes
      && estimate.maxDayOccurrences <= ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES;
  checkpoint(Object.freeze({ kind: "plan", owners: Object.freeze(owners.filter((owner) => owner.source === "effective")
    .map((owner) => {
      const estimate = plan.get(owner.ownerDigest)!;
      return Object.freeze({ ownerDigest: owner.ownerDigest, admitted: admittedOwner(estimate),
        occurrences: estimate.occurrences.usage + estimate.occurrences.quota + estimate.occurrences.session,
        analysisUsage: estimate.analysisUsage, estimateBytes: estimate.estimateBytes });
    })) }));
  // The owner's read range in bounded segments (see the module comment): the
  // history segments, oldest first, then the analysis horizon.
  const segmentsFrom = neededDays[0]! < range.fromDay ? neededDays[0]! : range.fromDay;
  const segments: AnalyticsV2DaySpan[] = [...analyticsV2HistorySegments(segmentsFrom, analysisFrom),
    Object.freeze({ fromDay: analysisFrom, throughDay: range.throughDay })];
  let ownerIndex = 0;

  for (const owner of owners) {
    const ownerDigest = owner.ownerDigest;
    if (owner.source !== "effective") {
      const occurrences = input.occurrencesByOwner.get(ownerDigest);
      pushRefusal(analyticsV2Refusal(ownerDigest, null, "owner", "non_effective_source_unported"));
      // Typed evidence makes the owner a member of production's daily cohort:
      // a queued day it may have evidence on cannot be published without it.
      if (owner.hasV1 || owner.hasV11 || owner.hasV12) {
        for (const day of queued) {
          if (occurrences !== undefined && !hasEvidence(occurrences.get(day))) continue;
          blocked.add(day);
          pushRefusal(analyticsV2Refusal(ownerDigest, day, "daily", "non_effective_source_unported"));
        }
      }
      continue;
    }

    ownerOutputBytes = 0;
    checkpoint(Object.freeze({ kind: "owner", index: ownerIndex++, ownerDigest, accountBytes }));
    const evidence = evidenceByOwner.get(ownerDigest)!;
    const estimate = plan.get(ownerDigest)!;
    const resource = { ownerDigest, ...estimate.occurrences, analysisUsage: estimate.analysisUsage,
      maxDayOccurrences: estimate.maxDayOccurrences, estimateBytes: estimate.estimateBytes };
    if (!admittedOwner(estimate)) {
      pushRefusal(analyticsV2Refusal(ownerDigest, null, "owner", "memory_budget"));
      for (const day of queued) {
        if (!evidence.has(day)) continue;
        blocked.add(day);
        pushRefusal(analyticsV2Refusal(ownerDigest, day, "daily", "memory_budget"));
      }
      ownerResources.push(Object.freeze({ ...resource, admitted: false, heapPeakBytes: null,
        outputBytes: ownerOutputBytes }));
      continue;
    }

    computedOwners.push(owner);
    let heapPeak: number | null = null;
    const sample = (): void => {
      if (input.memoryProbe === undefined) return;
      const used = input.memoryProbe();
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
          else dailyValues.get(day)!.set(ownerDigest, daily);
        }
        if (hasEvidence(value)) {
          const row = Object.freeze({ ownerDigest, day, daily, refusal });
          ownerDays.push(row);
          chargeRow(row);
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
              const row = Object.freeze({ ownerDigest, day, model: group.model, effort: group.effort,
                band: band.band, counters: bandCounters(band) });
              cacheBands.push(row);
              chargeRow(row);
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
      checkpoint(Object.freeze({ kind: "segment", index: segmentIndex, occurrences: segmentOccurrences, accountBytes }));
      if (loader === undefined) {
        occurrences = input.occurrencesByOwner.get(ownerDigest)!;
      } else {
        // Release the previous segment before the next is loaded.
        occurrences = new Map();
        const span = { fromDay: segment.fromDay < range.fromDay ? range.fromDay : segment.fromDay,
          throughDay: segment.throughDay };
        if (span.fromDay <= span.throughDay) {
          const loaded = await timed("read", () => loader(ownerDigest, Object.freeze(span)));
          if (!(loaded instanceof Map)) invalid("loadOwnerOccurrences");
          for (const [day, value] of loaded) {
            dayStart(day, "loadOwnerOccurrences");
            dayOccurrences(value);
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
      fitsByOwner.set(ownerDigest, result.selectedFits);
      const row = Object.freeze({ ownerDigest, asOfDay: today, fits: result.selectedFits });
      ownerFits.push(row);
      chargeRow(row);
    });
    sample();

    // ---- Model history: each of the 70 dates over its own 101-day window.
    await timed("model", async () => {
      for (const [modelIndex, day] of modelDates.entries()) {
        checkpoint(Object.freeze({ kind: "model", index: modelIndex, accountBytes }));
        let result: V1ModelCompositionResult;
        try {
          const pin = await buildAnalyticsV2Pin({ owner, day, dayDigests });
          result = await evaluateAnalyticsV2ModelDate({ pin, day, ownerDigest, days: windowFor(day),
            quotaOccurrences }) as V1ModelCompositionResult;
        } catch (error) {
          const reason = kernelRefusalReason(error);
          if (reason === null) throw error;
          pushRefusal(analyticsV2Refusal(ownerDigest, day, "model", reason));
          modelRefusedByDate.set(day, modelRefusedByDate.get(day)! + 1);
          sample();
          continue;
        }
        compositionsByDate.get(day)!.push({ ownerDigest, result });
        const row = Object.freeze({ ownerDigest, day, result: withoutFingerprint(result) });
        ownerModelDates.push(row);
        chargeRow(row);
        sample();
      }
    });
    ownerResources.push(Object.freeze({ ...resource, admitted: true, heapPeakBytes: heapPeak,
      outputBytes: ownerOutputBytes }));
    // `prepared` (with its usage rows) and the owner's last segment are released with this scope.
  }

  // ---- Community outputs.
  checkpoint(Object.freeze({ kind: "community", accountBytes }));
  const community = await timed("community", async () => {
    const dailyCandidates: AnalyticsV2ComputedDailyCandidate[] = [];
    for (const day of queued) {
      if (blocked.has(day)) continue;
      const byOwner = dailyValues.get(day)!;
      // A memory-refused owner blocks every queued day it has evidence on, so
      // on an unblocked day it has none: its values would be all zero, and
      // publicInputs adds nothing for an owner without records.
      const values = computedOwners.map((owner) => byOwner.get(owner.ownerDigest)!);
      const counted = input.devicesByDay.get(day);
      const devices = values.map((value, index) => {
        if (value.counts.usage + value.counts.quota + value.counts.session === 0) return 0;
        if (counted === undefined) return invalid("devicesByDay.missingDay");
        return counted.get(computedOwners[index]!.ownerDigest) ?? 1;
      });
      const inputs = publicInputs(values, devices);
      const payload = buildCommunityDailyPayload({ day, revision: input.revisionSeed + 1, releasedAt: nowIso, ...inputs });
      dailyCandidates.push(Object.freeze({ day, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
        inputs }));
    }

    // d43c8f92 publishStorageCommunityGraphPreview defers (cache_pending)
    // unless every member has a current fits result. An effective owner
    // without one, refused by the kernels or by the memory budget, withholds
    // the preview: a partial cohort would state coverage counts that silently
    // omit it.
    if (effectiveDigests.some((ownerDigest) => !fitsByOwner.has(ownerDigest))) {
      return { dailyCandidates, preview: null };
    }
    const fits = computedOwners.flatMap((owner) => fitsByOwner.get(owner.ownerDigest)!);
    const cohort = computedOwners.map((owner) => owner.ownerDigest);
    const modelDays: AdminCommunityModelCompositionDay[] = [];
    for (const day of modelDates) {
      const evaluated = compositionsByDate.get(day)!;
      // An effective owner the kernels refused for this date is still a member
      // of its cohort: it is counted as refused, never dropped, even when no
      // owner could be evaluated (owner decision 2026-10-01, D7). A date with
      // no effective member at all is not published.
      const refused = modelRefusedByDate.get(day)!;
      if (evaluated.length === 0 && refused === 0) continue;
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
    resources: Object.freeze({
      configuration: Object.freeze({ memoryModel: ANALYTICS_V2_MEMORY_MODEL.version,
        outputModel: ANALYTICS_V2_OUTPUT_MODEL.version, ...resources }),
      owners: Object.freeze(ownerResources),
      account: Object.freeze({ heldInputBytes, accountBytes }),
    }),
  };
}
