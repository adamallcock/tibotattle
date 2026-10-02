/**
 * analytics-v2 resources: the GCP bounds of one analytics-refresh run, the
 * deterministic memory estimate behind the pre-flight `memory_budget` guard,
 * and the output account behind the run's output budget.
 *
 * The d43c8f92 shared reducers bound a day at 20,000 occurrences or 32 MiB
 * and a 101-day window at 120,000 usage rows, sized for a Worker isolate. On
 * GCP the job holds one owner at a time in a Cloud Run task, so those bounds
 * are replaced by:
 *
 * - the per-owner memory budget. Before an owner is read, its exact evidence
 *   counts (A-1 countOwnerOccurrences, the reader's own candidate selection)
 *   give a memory estimate. An owner whose estimate exceeds the budget is
 *   refused as a whole with `memory_budget`: it is not read, its queued days
 *   with evidence are blocked, and it has no fit, so the run withholds the
 *   preview and with it every model date. The decision is a pure function of
 *   the counts and the configured budget, never of a heap observation;
 * - a day backstop (maxDayOccurrences, maxDayRecordBytes). A day over it is
 *   refused with the shared reducers' own reasons (day_row_limit,
 *   day_byte_limit) before anything serializes it. Its ceiling is fixed by
 *   the owner-day evidence digest, which is one canonical JSON string per
 *   prepared day (pin.ts): V8 refuses strings over 536,870,888 characters,
 *   about 470,000 synthetic usage records;
 * - the output budget: the heap the run's accumulated outputs (every computed
 *   owner's rows and refusals, held until the single write) and the
 *   non-effective owners' queued-day occurrences may take. compute.ts
 *   charges each row to the account as it is produced, with the
 *   deterministic ANALYTICS_V2_OUTPUT_MODEL, and refuses the run
 *   (ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED) the moment the account exceeds the
 *   budget. The Job derives the budget from its heap limit (the heap left
 *   after the per-owner budget, the read reserve and the runtime reserve), so
 *   no fixed reserve stands in for the outputs, and lets the run reclaim the
 *   part of the per-owner budget that its largest admitted owner's estimate
 *   leaves (analyticsV2OutputBudget).
 *
 * Bounded history (memory model v2): the days before the analysis horizon
 * (the cache history, back to the first evidence day) are loaded and reduced
 * in segments of ANALYTICS_V2_HISTORY_SEGMENT_DAYS days, aligned backwards
 * from the analysis start, and each segment is released before the next is
 * loaded; only the analysis horizon (its 170 days and any queued day after
 * today) is held whole. The estimate therefore charges the larger of the
 * largest history segment and the analysis horizon, not the whole history: an
 * owner at a steady density has the same estimate after 200 or 2,000 days.
 *
 * Kernel bounds inside the analysis (1,000,000 windowed usage rows, 100,000
 * sessions, the 8 MiB reduction checkpoint and the quota limits) define
 * production's published result and are not configurable here. Method and
 * contract constants (the 101-day window, 70 model dates, 366-day reads,
 * lexical top-200 cells) are not resources.
 *
 * Defaults are sized for an 8 GiB Cloud Run task whose Node heap is set to
 * 6,144 MiB (--max-old-space-size). The Job may lower or raise each value by
 * environment within the bounds below (cloud-run/analytics-refresh.mjs); its
 * production profile is the dense one (cloud-run/analytics-refresh.mjs
 * ANALYTICS_REFRESH_PRODUCTION_JOB).
 */
import type { AnalyticsV2Day } from "./contract";

const MIB = 1_024 * 1_024;

/** The owner-day bounds the native path applies (native-path.ts). */
export interface AnalyticsV2DayLimits {
  readonly maxDayOccurrences: number;
  readonly maxDayRecordBytes: number;
}

/** One run's resource configuration. */
export interface AnalyticsV2Resources extends AnalyticsV2DayLimits {
  /** Largest per-owner memory estimate the run computes; larger owners are refused. */
  readonly memoryBudgetBytes: number;
  /**
   * Largest output account the run holds until its write; beyond it the run
   * is refused. A run that reclaims the unused per-owner budget
   * (analyticsV2OutputBudget) adds that part to it.
   */
  readonly outputBudgetBytes: number;
}

/** Inclusive bounds and defaults for each resource. */
export const ANALYTICS_V2_RESOURCE_BOUNDS = Object.freeze({
  memoryBudgetBytes: Object.freeze({ minimum: 1_024 * MIB, maximum: 30_720 * MIB, default: 4_608 * MIB }),
  // The minimum is the experiment's own bound: a configured run never
  // refuses a day the vendored shared reducers would have computed.
  maxDayOccurrences: Object.freeze({ minimum: 20_000, maximum: 250_000, default: 250_000 }),
  maxDayRecordBytes: Object.freeze({ minimum: 32 * MIB, maximum: 256 * MIB, default: 256 * MIB }),
  // The Job passes the heap its limit leaves for outputs and enforces its own,
  // larger minimum (cloud-run/analytics-refresh.mjs); 1 MiB is the floor.
  outputBudgetBytes: Object.freeze({ minimum: MIB, maximum: 30_720 * MIB, default: 1_024 * MIB }),
});

export const ANALYTICS_V2_DEFAULT_RESOURCES: AnalyticsV2Resources = Object.freeze({
  memoryBudgetBytes: ANALYTICS_V2_RESOURCE_BOUNDS.memoryBudgetBytes.default,
  maxDayOccurrences: ANALYTICS_V2_RESOURCE_BOUNDS.maxDayOccurrences.default,
  maxDayRecordBytes: ANALYTICS_V2_RESOURCE_BOUNDS.maxDayRecordBytes.default,
  outputBudgetBytes: ANALYTICS_V2_RESOURCE_BOUNDS.outputBudgetBytes.default,
});

/** Validate a resource configuration; throws ANALYTICS_V2_INPUT_INVALID:resources. */
export function validAnalyticsV2Resources(value: unknown): AnalyticsV2Resources {
  const resources = value as Partial<AnalyticsV2Resources> | null;
  if (resources === null || typeof resources !== "object" || Array.isArray(resources)
    || Object.keys(resources).sort().join(",") !== "maxDayOccurrences,maxDayRecordBytes,memoryBudgetBytes,outputBudgetBytes") {
    throw new TypeError("ANALYTICS_V2_INPUT_INVALID:resources");
  }
  for (const [name, bound] of Object.entries(ANALYTICS_V2_RESOURCE_BOUNDS)) {
    const entry = resources[name as keyof AnalyticsV2Resources];
    if (!Number.isSafeInteger(entry) || entry! < bound.minimum || entry! > bound.maximum) {
      throw new TypeError("ANALYTICS_V2_INPUT_INVALID:resources");
    }
  }
  return Object.freeze({ memoryBudgetBytes: resources.memoryBudgetBytes!,
    maxDayOccurrences: resources.maxDayOccurrences!, maxDayRecordBytes: resources.maxDayRecordBytes!,
    outputBudgetBytes: resources.outputBudgetBytes! });
}

/**
 * The most occurrences one day may hold for its owner to be read at all: A-1
 * reads at most this many candidates in one call (occurrence-source.ts
 * MAX_ANALYTICS_V2_CANDIDATES, pinned equal by the occurrence-source spec)
 * and never splits a day. A larger day refuses its owner with memory_budget.
 */
export const ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES = 2_000_000;

/** One owner-day's evidence counts per stream. */
export interface AnalyticsV2DayEvidence {
  readonly usage: number;
  readonly quota: number;
  readonly session: number;
}

/** day -> counts, for the days with evidence (absent days have none). */
export type AnalyticsV2OwnerEvidence = ReadonlyMap<AnalyticsV2Day, AnalyticsV2DayEvidence>;

/**
 * Days of history (before the analysis horizon) one owner load holds. The
 * segments are aligned backwards from the analysis start, so they are a pure
 * function of the run's clock and the history's first day.
 */
export const ANALYTICS_V2_HISTORY_SEGMENT_DAYS = 60;

/** An inclusive day range. */
export interface AnalyticsV2DaySpan {
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
}

const DAY_MS = 86_400_000;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/u;

function dayIndex(day: string): number {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (typeof day !== "string" || !DAY_TEXT.test(day) || !Number.isSafeInteger(at)
    || new Date(at).toISOString().slice(0, 10) !== day) throw new TypeError("ANALYTICS_V2_INPUT_INVALID:day");
  return at / DAY_MS;
}

function dayLabel(index: number): AnalyticsV2Day {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/** Index of the history segment holding `day` (< analysisFromDay): 0 is the segment just before it. */
function historySegmentIndex(day: AnalyticsV2Day, analysisFromDay: AnalyticsV2Day): number {
  return Math.floor((dayIndex(analysisFromDay) - 1 - dayIndex(day)) / ANALYTICS_V2_HISTORY_SEGMENT_DAYS);
}

/**
 * The history segments covering [fromDay, analysisFromDay - 1], oldest first:
 * spans of ANALYTICS_V2_HISTORY_SEGMENT_DAYS days counted back from the day
 * before the analysis start, the oldest clipped at fromDay. Empty when fromDay
 * is not before the analysis start.
 */
export function analyticsV2HistorySegments(fromDay: AnalyticsV2Day,
  analysisFromDay: AnalyticsV2Day): AnalyticsV2DaySpan[] {
  const from = dayIndex(fromDay), analysisFrom = dayIndex(analysisFromDay);
  const segments: AnalyticsV2DaySpan[] = [];
  for (let through = analysisFrom - 1; through >= from; through -= ANALYTICS_V2_HISTORY_SEGMENT_DAYS) {
    const start = Math.max(from, through - ANALYTICS_V2_HISTORY_SEGMENT_DAYS + 1);
    segments.push(Object.freeze({ fromDay: dayLabel(start), throughDay: dayLabel(through) }));
  }
  return segments.reverse();
}

/**
 * Bytes of JavaScript heap per unit of an owner's evidence while the job
 * computes that owner (compute.ts: one history segment's occurrences at a
 * time, then the analysis horizon's occurrences for the rest of the owner;
 * the 170 analysis days keep their prepared usage rows; cache views are kept
 * for the seven-day carry; the largest day's preparation and evidence digest
 * are transient). The unit costs are memory model v1's, measured on Node
 * 22.16.0 with synthetic, content-free v1.1-shaped records and rounded up;
 * see docs/receipts/2026-10-01-gcp-fastpath-caps.md for the measurement. v2
 * changes only which occurrences are held at once.
 */
export const ANALYTICS_V2_MEMORY_MODEL = Object.freeze({
  version: "analytics-v2-memory-model-v2" as const,
  /** Kernel state and reduction checkpoints (the owner's outputs are in the output account). */
  ownerOverheadBytes: 128 * MIB,
  /** One held occurrence (EffectiveTelemetryOccurrence and its record JSON). */
  heldBytesPerOccurrence: Object.freeze({ usage: 1_700, quota: 1_400, session: 1_300 }),
  /** One usage occurrence after preparation (usage row and cache item), and in the seven-day cache carry. */
  preparedBytesPerAnalysisUsage: 2_400,
  /** One occurrence of the owner's largest day during its preparation and digest. */
  transientBytesPerLargestDayOccurrence: 4_000,
  /** Days of cache views carried into a segment (the cache method's lookback). */
  cacheCarryDays: 7,
});

/** An owner's evidence totals and memory estimate. */
export interface AnalyticsV2OwnerEstimate {
  readonly occurrences: AnalyticsV2DayEvidence;
  readonly analysisUsage: number;
  readonly maxDayOccurrences: number;
  readonly estimateBytes: number;
}

function validCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("ANALYTICS_V2_INPUT_INVALID:ownerEvidence");
  return value as number;
}

/**
 * The deterministic memory estimate of computing one owner. `analysisFromDay`
 * and `today` bound the analysis days whose prepared usage rows are retained;
 * days before `analysisFromDay` are history, held one segment at a time.
 *
 * estimate = overhead + largest day x transient
 *   + max(analysis horizon, largest history segment), where
 *   analysis horizon = held(days >= analysisFromDay)
 *     + (analysis usage + usage of the 7 days before analysisFromDay) x prepared
 *   history segment = held(segment) + (usage of the segment and its 7-day carry) x prepared.
 */
export function analyticsV2OwnerMemoryEstimate(evidence: AnalyticsV2OwnerEvidence,
  analysisFromDay: AnalyticsV2Day, today: AnalyticsV2Day): AnalyticsV2OwnerEstimate {
  const model = ANALYTICS_V2_MEMORY_MODEL;
  const held = (counts: AnalyticsV2DayEvidence): number => counts.usage * model.heldBytesPerOccurrence.usage
    + counts.quota * model.heldBytesPerOccurrence.quota + counts.session * model.heldBytesPerOccurrence.session;
  const analysisFrom = dayIndex(analysisFromDay);
  let usage = 0, quota = 0, session = 0, analysisUsage = 0, maxDay = 0, analysisHeld = 0;
  const historyUsage = new Map<number, number>();
  const segments = new Map<number, { held: number; usage: number; firstDay: number }>();
  for (const [day, counts] of evidence) {
    const dayUsage = validCount(counts?.usage), dayQuota = validCount(counts?.quota),
      daySession = validCount(counts?.session);
    usage += dayUsage; quota += dayQuota; session += daySession;
    maxDay = Math.max(maxDay, dayUsage + dayQuota + daySession);
    const index = dayIndex(day);
    const dayHeld = held({ usage: dayUsage, quota: dayQuota, session: daySession });
    if (index >= analysisFrom) {
      analysisHeld += dayHeld;
      if (day <= today) analysisUsage += dayUsage;
      continue;
    }
    historyUsage.set(index, dayUsage);
    const segment = historySegmentIndex(day, analysisFromDay);
    const entry = segments.get(segment)
      ?? { held: 0, usage: 0, firstDay: analysisFrom - (segment + 1) * ANALYTICS_V2_HISTORY_SEGMENT_DAYS };
    entry.held += dayHeld;
    entry.usage += dayUsage;
    segments.set(segment, entry);
  }
  const carry = (firstDay: number): number => {
    let total = 0;
    for (let index = firstDay - model.cacheCarryDays; index < firstDay; index += 1) total += historyUsage.get(index) ?? 0;
    return total;
  };
  let peak = analysisHeld + (analysisUsage + carry(analysisFrom)) * model.preparedBytesPerAnalysisUsage;
  for (const segment of segments.values()) {
    peak = Math.max(peak, segment.held + (segment.usage + carry(segment.firstDay)) * model.preparedBytesPerAnalysisUsage);
  }
  const estimateBytes = model.ownerOverheadBytes + peak + maxDay * model.transientBytesPerLargestDayOccurrence;
  if (!Number.isSafeInteger(estimateBytes)) throw new TypeError("ANALYTICS_V2_INPUT_INVALID:ownerEvidence");
  return Object.freeze({ occurrences: Object.freeze({ usage, quota, session }), analysisUsage,
    maxDayOccurrences: maxDay, estimateBytes });
}

/**
 * The output account (compute.ts): bytes of JavaScript heap charged for one
 * held output row (owner-day, cache band, fits, model date or refusal), from
 * the length of its JSON text, and for one held non-effective occurrence
 * (the memory model's held cost). Deterministic: the same rows always charge
 * the same bytes. Calibrated on Node 22.16.0 with the synthetic rows of the
 * compute spec's compose and dense corpora: an unshared copy of a row held
 * 0.65 to 1.21 bytes of heap per JSON character (fits the most), so this
 * charge is 1.7 to 3.2 times that copy's heap per family
 * (docs/receipts/2026-10-02-gcp-c-refresh.md, "Output account"). Rows the
 * kernels share (the owner digest, nested kernel values) are charged once per
 * row, so the account errs high.
 */
export const ANALYTICS_V2_OUTPUT_MODEL = Object.freeze({
  version: "analytics-v2-output-model-v1" as const,
  rowBaseBytes: 128,
  bytesPerJsonCharacter: 2,
});

/** Bytes the output account charges for one output row. */
export function analyticsV2OutputRowBytes(row: unknown): number {
  const text = JSON.stringify(row);
  if (typeof text !== "string") throw new TypeError("ANALYTICS_V2_INPUT_INVALID:outputRow");
  return ANALYTICS_V2_OUTPUT_MODEL.rowBaseBytes + text.length * ANALYTICS_V2_OUTPUT_MODEL.bytesPerJsonCharacter;
}

/** Bytes the output account charges for one owner-day of held occurrences. */
export function analyticsV2HeldOccurrenceBytes(counts: AnalyticsV2DayEvidence): number {
  const model = ANALYTICS_V2_MEMORY_MODEL;
  return validCount(counts.usage) * model.heldBytesPerOccurrence.usage
    + validCount(counts.quota) * model.heldBytesPerOccurrence.quota
    + validCount(counts.session) * model.heldBytesPerOccurrence.session;
}

/**
 * The run's output budget (compute.ts), fixed by the plan before any output
 * is charged. Without reclaim it is resources.outputBudgetBytes. With reclaim
 * (the Job, whose heap partition reserves resources.memoryBudgetBytes for one
 * owner at a time beside the output budget) it also takes the part of that
 * reservation the largest admitted owner's estimate leaves:
 *
 *   outputBudgetBytes + memoryBudgetBytes - largest admitted estimate
 *
 * (all of memoryBudgetBytes when no owner is admitted). An owner is admitted
 * only when its estimate is at most memoryBudgetBytes, and only one owner is
 * held at a time, so the heap bound is unchanged: the largest admitted
 * estimate plus the output budget is the budget plus the configured output
 * budget. The reclaim relies on the estimate as each owner's bound, as
 * admission itself does.
 */
export function analyticsV2OutputBudget(resources: AnalyticsV2Resources, largestAdmittedEstimateBytes: number,
  reclaim: boolean): number {
  if (!Number.isSafeInteger(largestAdmittedEstimateBytes) || largestAdmittedEstimateBytes < 0
    || largestAdmittedEstimateBytes > resources.memoryBudgetBytes || typeof reclaim !== "boolean") {
    throw new TypeError("ANALYTICS_V2_INPUT_INVALID:outputBudget");
  }
  return reclaim ? resources.outputBudgetBytes + resources.memoryBudgetBytes - largestAdmittedEstimateBytes
    : resources.outputBudgetBytes;
}
