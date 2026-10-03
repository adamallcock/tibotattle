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
 * - Community aggregate exclusions (N-EXCL, compute-community.ts): an owner
 *   excluded on day D is outside D's community cohort, as d43c8f92's weekly
 *   builder removed an excluded participant before anything else. So its
 *   refusals (non-effective typed evidence, the memory budget, a refused
 *   owner-day) never block D, and its missing fit never withholds the
 *   preview when it is excluded on every day the preview carries. Its own
 *   refusals are recorded exactly as before; `blockedDays` lists only the
 *   days a non-excluded owner blocks.
 * - The preview follows d43c8f92 publishStorageCommunityGraphPreview: it is
 *   built only when every effective owner of its cohort has a current fits
 *   result. One effective owner without one (a refused scalar fit, or the
 *   memory budget) that is not excluded on every day the preview carries
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
 * - Output account: every output row (owner-day, its price row, cache band,
 *   fits, model date, refusal) and every held non-effective occurrence is charged to the
 *   run's output account as it is produced (resources.ts
 *   ANALYTICS_V2_OUTPUT_MODEL). The moment the account exceeds the run's
 *   output budget the run fails with ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED and
 *   nothing is written. The output budget is resources.outputBudgetBytes;
 *   with `reclaimUnusedOwnerBudget` (the Job's heap partition) it also takes
 *   the part of resources.memoryBudgetBytes that the largest admitted owner's
 *   estimate leaves, which the plan fixes before any output is charged
 *   (resources.ts analyticsV2OutputBudget).
 * - Checkpoints: `checkpoint`, when given, is called with the run plan before
 *   the first owner, at each effective owner, each segment load, before the
 *   owner's scalar fit and at each model date, and before the community fold.
 *   It may throw (the Job's time guard); the error ends the run and nothing is
 *   written.
 *
 * Daily candidates are stamped with the revision a first publication gets
 * (revisionSeed + 1) and releasedAt = nowMs. `payloadSha256` identifies the
 * CONTENT: it is the sha256 of the canonical payload without its revision
 * stamp (aggregateId, revision, releasedAt), so an unchanged day keeps its
 * revision. A-3 restamps a changed day with stampAnalyticsV2DailyPayload.
 *
 * Layout (K-SPLIT): this module validates the input, plans the run (memory
 * guard, output budget, segments) and merges; compute-owner.ts computes one
 * admitted effective owner; compute-community.ts folds the daily candidates
 * and the preview. Owner computations are merged in owner-digest order, so
 * the outputs, their order and the output account are the same whether an
 * owner ran inline or in a compute worker (K-PAR, `ownerPool`).
 */
import {
  CACHE_RETENTION_METHOD,
  type CommunityAllowanceFit,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_CONTRACT_VERSION,
  ANALYTICS_V2_DAY_PATTERN,
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  type AnalyticsV2CacheBandRow,
  type AnalyticsV2Day,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerDayPriceRow,
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
  ANALYTICS_V2_MODEL_DATES,
  buildAnalyticsV2Community,
  type AnalyticsV2ComputedDailyCandidate,
} from "./compute-community";
import {
  analyticsV2DayOccurrences,
  analyticsV2EmissionBytes,
  analyticsV2EvidenceOf,
  computeAnalyticsV2Owner,
  type AnalyticsV2OwnerComputation,
  type AnalyticsV2OwnerEmission,
  type AnalyticsV2OwnerProgress,
  type AnalyticsV2OwnerRunContext,
} from "./compute-owner";
import { validAnalyticsV2ExclusionIntervals, type AnalyticsV2ExclusionInterval } from "./exclusions";
import type { AnalyticsV2DayOccurrences } from "./pin";
import { analyticsV2Refusal, compareAnalyticsV2Refusals } from "./refusals";
import {
  ANALYTICS_V2_DEFAULT_RESOURCES,
  ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES,
  ANALYTICS_V2_MEMORY_MODEL,
  ANALYTICS_V2_OUTPUT_MODEL,
  analyticsV2HeldOccurrenceBytes,
  analyticsV2HistorySegments,
  analyticsV2OutputBudget,
  analyticsV2OutputRowBytes,
  analyticsV2OwnerMemoryEstimate,
  validAnalyticsV2Resources,
  type AnalyticsV2DayEvidence,
  type AnalyticsV2DaySpan,
  type AnalyticsV2OwnerEvidence,
  type AnalyticsV2Resources,
} from "./resources";

export type { AnalyticsV2DayOccurrences } from "./pin";
// The community fold's public names (K-SPLIT): one import path for callers.
export {
  ANALYTICS_V2_MODEL_DATES,
  analyticsV2DailyContentSha256,
  stampAnalyticsV2DailyPayload,
} from "./compute-community";
export type {
  AnalyticsV2ComputedDailyCandidate,
  AnalyticsV2DailyPayload,
  AnalyticsV2DailyPublicInputs,
} from "./compute-community";
export type {
  AnalyticsV2OwnerComputation,
  AnalyticsV2OwnerEmission,
  AnalyticsV2OwnerProgress,
  AnalyticsV2OwnerRunContext,
} from "./compute-owner";

const DAY_MS = 86_400_000;
/** Scalar and model windows span modelHistoryWindow(day): the day and the 100 before it. */
const WINDOW_SPAN_DAYS = 101;
/** Days the scalar and model windows need: [today-169, today]. */
export const ANALYTICS_V2_ANALYSIS_DAYS = ANALYTICS_V2_MODEL_DATES + WINDOW_SPAN_DAYS - 1;
const CACHE_LOOKBACK_DAYS: number = CACHE_RETENTION_METHOD.lookbackDays;

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
   * True when `resources` partition one heap (the Job: the per-owner budget is
   * reserved for one owner at a time beside the output budget). The run's
   * output budget then also takes the part of resources.memoryBudgetBytes
   * that the largest admitted owner's estimate leaves (resources.ts
   * analyticsV2OutputBudget). Defaults to false: the output budget is
   * resources.outputBudgetBytes.
   */
  readonly reclaimUnusedOwnerBudget?: boolean;
  /**
   * Heap bytes in use, sampled while an owner is computed and recorded as its
   * heapPeakBytes. Operational metadata only: no decision reads it.
   */
  readonly memoryProbe?: () => number;
  /**
   * Progress hook (the Job's time guard). Called with the plan before the
   * first owner, then at each effective owner, segment load, scalar fit and
   * model date, and before the community fold. Anything it throws ends the run.
   */
  readonly checkpoint?: (event: AnalyticsV2Checkpoint) => void;
  /**
   * N-EXCL (exclusions.ts): owner -> its active community aggregate
   * exclusions. An owner excluded on day D is left out of D's daily fold and
   * the preview's day D; its refusals block no day it is excluded on, and
   * its missing fit withholds the preview only while it is a member of a day
   * the preview carries. Its own rows and refusals are computed as before.
   * Every key must be an owner of the run (of any source). Defaults to none.
   */
  readonly exclusions?: ReadonlyMap<AnalyticsV2OwnerDigest, readonly AnalyticsV2ExclusionInterval[]>;
  /**
   * K-PAR: computes admitted effective owners outside the main thread (the
   * Job's compute workers). Requires `loadOwnerOccurrences`; the pool asks it
   * for each owner's segments, in the main thread. Without a pool, owners are
   * computed inline, one at a time, in digest order. Either way the results
   * are merged in owner-digest order, so the outputs are identical.
   */
  readonly ownerPool?: AnalyticsV2OwnerPool;
}

/** One admitted effective owner handed to an owner pool (structured-clone safe). */
export interface AnalyticsV2OwnerTask {
  /** The owner's index among the run's effective owners (its checkpoint index). */
  readonly index: number;
  readonly owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  /** The owner's exact per-day counts over the read range, ascending by day. */
  readonly evidence: ReadonlyArray<readonly [AnalyticsV2Day, AnalyticsV2DayEvidence]>;
  /** Its memory estimate (resources.ts); the pool admits concurrent owners against the budget. */
  readonly estimateBytes: number;
}

/** What an owner pool returns for one task: computeAnalyticsV2Owner's emissions and result. */
export interface AnalyticsV2OwnerTaskResult {
  readonly emissions: readonly AnalyticsV2OwnerEmission[];
  readonly computation: AnalyticsV2OwnerComputation;
  readonly timings: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
}

export interface AnalyticsV2OwnerPool {
  /** Concurrent owners (1 or more); the time guard divides projected owner work by it. */
  readonly workers: number;
  /**
   * Compute one task when the pool admits it (at most `workers` at once, and
   * concurrent estimates within the run's memory budget). `load` reads one of
   * the owner's segments in the main thread; `progress` receives its segment,
   * scalar and model events (and may throw: the task then fails).
   */
  compute(task: AnalyticsV2OwnerTask, context: AnalyticsV2OwnerRunContext, io: {
    readonly load: (span: AnalyticsV2DaySpan) => Promise<ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayOccurrences>>;
    readonly progress: (event: AnalyticsV2OwnerProgress) => void;
    readonly started: () => void;
  }): Promise<AnalyticsV2OwnerTaskResult>;
  /** Stop every running task (the run failed); idempotent. */
  abort(): Promise<void>;
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
  | { readonly kind: "plan"; readonly owners: readonly AnalyticsV2PlannedOwner[]; readonly workers: number }
  | { readonly kind: "owner"; readonly index: number; readonly ownerDigest: AnalyticsV2OwnerDigest;
    readonly accountBytes: number }
  | { readonly kind: "ownerDone"; readonly index: number; readonly accountBytes: number }
  | { readonly kind: "segment"; readonly ownerIndex: number; readonly index: number; readonly occurrences: number;
    readonly accountBytes: number }
  | { readonly kind: "scalar"; readonly ownerIndex: number; readonly accountBytes: number }
  | { readonly kind: "model"; readonly ownerIndex: number; readonly index: number; readonly accountBytes: number }
  | { readonly kind: "community"; readonly accountBytes: number };

/**
 * The run's output account exceeded its output budget: a closed run refusal
 * (nothing is written), with content-free byte figures only.
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

export async function computeAnalyticsV2(input: ComputeAnalyticsV2Input): Promise<AnalyticsV2ComputeOutputs> {
  const clock = input.clock ?? (() => performance.now());
  const timings: Partial<Record<AnalyticsV2Phase, number>> = {};
  const timed = async <T>(phase: AnalyticsV2Phase, work: () => Promise<T> | T): Promise<T> => {
    const started = clock();
    try { return await work(); } finally { timings[phase] = (timings[phase] ?? 0) + (clock() - started); }
  };

  // ---- Validate the whole input before any kernel runs.
  const nowMs = input.nowMs, today = analyticsV2Today(nowMs);
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
  if (input.reclaimUnusedOwnerBudget !== undefined && typeof input.reclaimUnusedOwnerBudget !== "boolean") {
    invalid("reclaimUnusedOwnerBudget");
  }
  const ownerPool = input.ownerPool;
  if (ownerPool !== undefined && (ownerPool === null || typeof ownerPool.compute !== "function"
    || typeof ownerPool.abort !== "function" || !Number.isSafeInteger(ownerPool.workers) || ownerPool.workers < 1
    || loader === undefined)) invalid("ownerPool");
  const checkpoint = input.checkpoint ?? ((): void => {});
  const ownerSet = new Set(owners.map((owner) => owner.ownerDigest));
  const effectiveDigests = owners.filter((owner) => owner.source === "effective").map((owner) => owner.ownerDigest);
  const exclusions = new Map<AnalyticsV2OwnerDigest, readonly AnalyticsV2ExclusionInterval[]>();
  if (input.exclusions !== undefined) {
    if (!(input.exclusions instanceof Map)) invalid("exclusions");
    for (const [ownerDigest, intervals] of input.exclusions) {
      if (!ownerSet.has(ownerDigest)) invalid("exclusions.owner");
      exclusions.set(ownerDigest, validAnalyticsV2ExclusionIntervals(intervals));
    }
  }
  for (const [ownerDigest, days] of input.occurrencesByOwner) {
    if (!ownerSet.has(ownerDigest) || !(days instanceof Map)) invalid("occurrencesByOwner");
    for (const [day, value] of days) {
      dayStart(day, "occurrencesByOwner");
      analyticsV2DayOccurrences(value);
    }
  }
  // The effective owners' evidence: counted from the supplied occurrences, or
  // the reader's exact counts when owners are streamed.
  const evidenceByOwner = new Map<AnalyticsV2OwnerDigest, AnalyticsV2OwnerEvidence>();
  if (loader === undefined) {
    for (const ownerDigest of effectiveDigests) {
      const days = input.occurrencesByOwner.get(ownerDigest);
      if (days === undefined) invalid("occurrencesByOwner.missingEffectiveOwner");
      evidenceByOwner.set(ownerDigest, analyticsV2EvidenceOf(days!));
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
  const refusals: AnalyticsV2Refusal[] = [];
  const ownerDays: AnalyticsV2OwnerDayRow[] = [];
  const ownerDayPrices: AnalyticsV2OwnerDayPriceRow[] = [];
  const cacheBands: AnalyticsV2CacheBandRow[] = [];
  const ownerFits: AnalyticsV2OwnerFitsRow[] = [];
  const ownerModelDates: AnalyticsV2OwnerModelDateRow[] = [];
  const ownerResources: AnalyticsV2OwnerResources[] = [];
  /**
   * queued day -> the owners that block it (a refused owner-day, the memory
   * budget or non-effective typed evidence). The community fold decides which
   * of them block the community day: only an owner not excluded on it.
   */
  const blockers = new Map<AnalyticsV2Day, Set<AnalyticsV2OwnerDigest>>();
  const block = (day: AnalyticsV2Day, ownerDigest: AnalyticsV2OwnerDigest): void => {
    const owners = blockers.get(day);
    if (owners === undefined) blockers.set(day, new Set([ownerDigest]));
    else owners.add(ownerDigest);
  };
  /** queued day -> computed owner -> unfinalized daily values (owners in digest order). */
  const dailyValues = new Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>(
    queued.map((day) => [day, new Map()]));
  const fitsByOwner = new Map<AnalyticsV2OwnerDigest, readonly CommunityAllowanceFit[]>();
  const compositionsByDate = new Map<AnalyticsV2Day, Array<{ ownerDigest: string; result: V1ModelCompositionResult }>>(
    modelDates.map((day) => [day, []]));
  /**
   * model date -> effective owners whose evaluation the kernels refused, in
   * digest order. (A memory-refused owner has no fit, so the preview that
   * carries the model dates is withheld for the run; it is never listed here.)
   */
  const modelRefusedByDate = new Map<AnalyticsV2Day, AnalyticsV2OwnerDigest[]>(modelDates.map((day) => [day, []]));
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

  // ---- The output account: every held output row, and the non-effective
  // owners' held occurrences, against the output budget. The plan fixes the
  // budget before anything is charged: the largest admitted estimate is the
  // most of the per-owner reservation any owner of this run can use.
  const largestAdmittedEstimateBytes = [...plan.values()].filter(admittedOwner)
    .reduce((largest, estimate) => Math.max(largest, estimate.estimateBytes), 0);
  const outputBudgetBytes = analyticsV2OutputBudget(resources, largestAdmittedEstimateBytes,
    input.reclaimUnusedOwnerBudget === true);
  let accountBytes = 0;
  let ownerOutputBytes = 0;
  const charge = (bytes: number): void => {
    accountBytes += bytes;
    ownerOutputBytes += bytes;
    if (accountBytes > outputBudgetBytes) {
      throw new AnalyticsV2OutputBudgetExceeded(accountBytes, outputBudgetBytes);
    }
  };
  const chargeRow = (row: unknown): void => charge(analyticsV2OutputRowBytes(row));
  for (const ownerDigest of owners.filter((owner) => owner.source !== "effective").map((owner) => owner.ownerDigest)) {
    const days = input.occurrencesByOwner.get(ownerDigest);
    if (days !== undefined) for (const counts of analyticsV2EvidenceOf(days).values()) charge(analyticsV2HeldOccurrenceBytes(counts));
  }
  const heldInputBytes = accountBytes;
  const pushRefusal = (refusal: AnalyticsV2Refusal): void => {
    refusals.push(refusal);
    chargeRow(refusal);
  };
  checkpoint(Object.freeze({ kind: "plan", owners: Object.freeze(owners.filter((owner) => owner.source === "effective")
    .map((owner) => {
      const estimate = plan.get(owner.ownerDigest)!;
      return Object.freeze({ ownerDigest: owner.ownerDigest, admitted: admittedOwner(estimate),
        occurrences: estimate.occurrences.usage + estimate.occurrences.quota + estimate.occurrences.session,
        analysisUsage: estimate.analysisUsage, estimateBytes: estimate.estimateBytes });
    })), workers: ownerPool?.workers ?? 1 }));
  // The owner's read range in bounded segments (see the module comment): the
  // history segments, oldest first, then the analysis horizon.
  const segmentsFrom = neededDays[0]! < range.fromDay ? neededDays[0]! : range.fromDay;
  const segments: AnalyticsV2DaySpan[] = [...analyticsV2HistorySegments(segmentsFrom, analysisFrom),
    Object.freeze({ fromDay: analysisFrom, throughDay: range.throughDay })];
  let ownerIndex = 0;
  const ownerContext: AnalyticsV2OwnerRunContext = Object.freeze({ today, analysisFrom, cacheFromDay,
    neededDays: Object.freeze(neededDays), segments: Object.freeze(segments), rangeFromDay: range.fromDay,
    queued: Object.freeze(queued), modelDates: Object.freeze(modelDates), resources });
  /** Append one owner output in production order and charge it to the account. */
  const merge = (emission: AnalyticsV2OwnerEmission): void => {
    switch (emission.kind) {
      case "refusal": pushRefusal(emission.refusal); return;
      case "ownerDay": ownerDays.push(emission.row); break;
      case "ownerDayPrice": ownerDayPrices.push(emission.row); break;
      case "cacheBand": cacheBands.push(emission.row); break;
      case "fits": ownerFits.push(emission.row); break;
      case "modelDate": ownerModelDates.push(emission.row); break;
      default: invalid("ownerEmission");
    }
    chargeRow(emission.row);
  };

  // ---- K-PAR: with an owner pool every admitted owner is submitted up front
  // and the pool computes them concurrently; they are still merged below in
  // digest order. A finished owner's outputs wait in the heap until their
  // turn, so they are held to the output budget as they arrive (pending): a
  // run whose pending and merged outputs exceed it is refused, which the
  // inline run would also have refused, since the account only grows.
  let pending: Map<number, Promise<AnalyticsV2OwnerTaskResult>> | null = null;
  let pendingBytes = 0;
  let poolFailure: unknown = null;
  const failPool = (error: unknown): void => {
    poolFailure ??= error;
    void ownerPool!.abort().catch(() => {});
  };
  if (ownerPool !== undefined) {
    pending = new Map();
    let index = 0;
    for (const owner of owners) {
      if (owner.source !== "effective") continue;
      const taskIndex = index++;
      const estimate = plan.get(owner.ownerDigest)!;
      if (!admittedOwner(estimate)) continue;
      const ownerDigest = owner.ownerDigest;
      const task: AnalyticsV2OwnerTask = Object.freeze({ index: taskIndex,
        owner: Object.freeze({ participantId: owner.participantId, ownerDigest }),
        evidence: Object.freeze([...evidenceByOwner.get(ownerDigest)!].sort(([left], [right]) => (left < right ? -1 : 1))),
        estimateBytes: estimate.estimateBytes });
      const result = ownerPool.compute(task, ownerContext, {
        load: (span) => loader!(ownerDigest, span),
        // The Worker does not hold the account: its events carry the main thread's.
        progress: (event) => checkpoint(withOwnerIndex({ ...event, accountBytes: accountBytes + pendingBytes },
          taskIndex)),
        started: () => checkpoint(Object.freeze({ kind: "owner", index: taskIndex, ownerDigest,
          accountBytes: accountBytes + pendingBytes })),
      }).then((value) => {
        pendingBytes += value.emissions.reduce((total, emission) => total + analyticsV2EmissionBytes(emission), 0);
        if (accountBytes + pendingBytes > outputBudgetBytes) {
          throw new AnalyticsV2OutputBudgetExceeded(accountBytes + pendingBytes, outputBudgetBytes);
        }
        return value;
      });
      // Every task is awaited in digest order below; a failure is recorded
      // here at once so the pool stops instead of finishing the other owners.
      result.catch(failPool);
      pending.set(taskIndex, result);
    }
  }



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
          block(day, ownerDigest);
          pushRefusal(analyticsV2Refusal(ownerDigest, day, "daily", "non_effective_source_unported"));
        }
      }
      continue;
    }

    ownerOutputBytes = 0;
    const index = ownerIndex++;
    const evidence = evidenceByOwner.get(ownerDigest)!;
    const estimate = plan.get(ownerDigest)!;
    const resource = { ownerDigest, ...estimate.occurrences, analysisUsage: estimate.analysisUsage,
      maxDayOccurrences: estimate.maxDayOccurrences, estimateBytes: estimate.estimateBytes };
    if (!admittedOwner(estimate)) {
      checkpoint(Object.freeze({ kind: "owner", index, ownerDigest, accountBytes }));
      pushRefusal(analyticsV2Refusal(ownerDigest, null, "owner", "memory_budget"));
      for (const day of queued) {
        if (!evidence.has(day)) continue;
        block(day, ownerDigest);
        pushRefusal(analyticsV2Refusal(ownerDigest, day, "daily", "memory_budget"));
      }
      ownerResources.push(Object.freeze({ ...resource, admitted: false, heapPeakBytes: null,
        outputBytes: ownerOutputBytes }));
      checkpoint(Object.freeze({ kind: "ownerDone", index, accountBytes }));
      continue;
    }

    computedOwners.push(owner);
    let computation: AnalyticsV2OwnerComputation;
    if (pending === null) {
      // Inline: emissions are appended and charged as they are produced, so
      // the account refuses at exactly the row that crosses the budget.
      checkpoint(Object.freeze({ kind: "owner", index, ownerDigest, accountBytes }));
      computation = await computeAnalyticsV2Owner({
        context: ownerContext,
        owner,
        evidence,
        load: loader === undefined ? null : (span) => loader(ownerDigest, span),
        ...(loader === undefined ? { occurrences: input.occurrencesByOwner.get(ownerDigest)! } : {}),
        hooks: {
          emit: merge,
          accountBytes: () => accountBytes,
          progress: (event) => checkpoint(withOwnerIndex(event, index)),
          timed,
          ...(input.memoryProbe === undefined ? {} : { memoryProbe: input.memoryProbe }),
        },
      });
    } else {
      let result: AnalyticsV2OwnerTaskResult;
      try {
        result = await pending.get(index)!;
      } catch (error) {
        throw poolFailure ?? error;
      }
      pendingBytes -= result.emissions.reduce((total, emission) => total + analyticsV2EmissionBytes(emission), 0);
      for (const emission of result.emissions) merge(emission);
      for (const [phase, milliseconds] of Object.entries(result.timings)) {
        timings[phase as AnalyticsV2Phase] = (timings[phase as AnalyticsV2Phase] ?? 0) + milliseconds;
      }
      computation = result.computation;
    }
    for (const [day, values] of computation.dailyValues) dailyValues.get(day)!.set(ownerDigest, values);
    for (const day of computation.blockedDays) block(day, ownerDigest);
    if (computation.fits !== null) fitsByOwner.set(ownerDigest, computation.fits);
    for (const [day, result] of computation.compositions) compositionsByDate.get(day)!.push({ ownerDigest, result });
    for (const day of computation.modelRefused) modelRefusedByDate.get(day)!.push(ownerDigest);
    ownerResources.push(Object.freeze({ ...resource, admitted: true, heapPeakBytes: computation.heapPeakBytes,
      outputBytes: ownerOutputBytes }));
    checkpoint(Object.freeze({ kind: "ownerDone", index, accountBytes }));
  }

  // ---- Community outputs.
  checkpoint(Object.freeze({ kind: "community", accountBytes }));
  const community = await timed("community", () => buildAnalyticsV2Community({ nowMs,
    revisionSeed: input.revisionSeed, queued, blockers, dailyValues, computedOwners, effectiveDigests,
    devicesByDay: input.devicesByDay, fitsByOwner, modelDates, compositionsByDate, modelRefusedByDate, exclusions }));

  return {
    contractVersion: ANALYTICS_V2_CONTRACT_VERSION,
    mode: "full",
    nowMs,
    today,
    revisionSeed: input.revisionSeed,
    owners,
    ownerDays,
    ownerDayPrices,
    cacheBands,
    ownerFits,
    ownerModelDates,
    dailyCandidates: community.dailyCandidates,
    blockedDays: community.blockedDays,
    preview: community.preview,
    refusals: refusals.sort(compareAnalyticsV2Refusals),
    journal: { lastSequence },
    timings,
    resources: Object.freeze({
      configuration: Object.freeze({ memoryModel: ANALYTICS_V2_MEMORY_MODEL.version,
        outputModel: ANALYTICS_V2_OUTPUT_MODEL.version, ...resources }),
      owners: Object.freeze(ownerResources),
      account: Object.freeze({ heldInputBytes, accountBytes, outputBudgetBytes }),
    }),
  };
}

/** A worker's or the inline owner's progress event, tagged with its owner's checkpoint index. */
function withOwnerIndex(event: AnalyticsV2OwnerProgress, ownerIndex: number): AnalyticsV2Checkpoint {
  return Object.freeze({ ...event, ownerIndex }) as AnalyticsV2Checkpoint;
}
