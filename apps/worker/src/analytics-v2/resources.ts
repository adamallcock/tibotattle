/**
 * analytics-v2 resources: the GCP bounds of one analytics-refresh run, and the
 * deterministic memory estimate behind the pre-flight `memory_budget` guard.
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
 *   with evidence are blocked, it leaves the fit cohort and it is counted as
 *   refused on every model date. The decision is a pure function of the counts
 *   and the configured budget, never of a heap observation;
 * - a day backstop (maxDayOccurrences, maxDayRecordBytes). A day over it is
 *   refused with the shared reducers' own reasons (day_row_limit,
 *   day_byte_limit). Its ceiling is fixed by the owner-day evidence digest,
 *   which is one canonical JSON string per day (pin.ts): V8 refuses strings
 *   over 536,870,888 characters, about 470,000 synthetic usage records.
 *
 * Kernel bounds inside the analysis (1,000,000 windowed usage rows, 100,000
 * sessions, the 8 MiB reduction checkpoint and the quota limits) define
 * production's published result and are not configurable here. Method and
 * contract constants (the 101-day window, 70 model dates, 366-day reads,
 * lexical top-200 cells) are not resources.
 *
 * Defaults are sized for an 8 GiB Cloud Run task whose Node heap is set to
 * 6,144 MiB (--max-old-space-size). The Job may lower or raise each value by
 * environment within the bounds below (cloud-run/analytics-refresh.mjs).
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
}

/** Inclusive bounds and defaults for each resource. */
export const ANALYTICS_V2_RESOURCE_BOUNDS = Object.freeze({
  memoryBudgetBytes: Object.freeze({ minimum: 1_024 * MIB, maximum: 30_720 * MIB, default: 4_608 * MIB }),
  // The minimum is the experiment's own bound: a configured run never
  // refuses a day the vendored shared reducers would have computed.
  maxDayOccurrences: Object.freeze({ minimum: 20_000, maximum: 250_000, default: 250_000 }),
  maxDayRecordBytes: Object.freeze({ minimum: 32 * MIB, maximum: 256 * MIB, default: 256 * MIB }),
});

export const ANALYTICS_V2_DEFAULT_RESOURCES: AnalyticsV2Resources = Object.freeze({
  memoryBudgetBytes: ANALYTICS_V2_RESOURCE_BOUNDS.memoryBudgetBytes.default,
  maxDayOccurrences: ANALYTICS_V2_RESOURCE_BOUNDS.maxDayOccurrences.default,
  maxDayRecordBytes: ANALYTICS_V2_RESOURCE_BOUNDS.maxDayRecordBytes.default,
});

/** Validate a resource configuration; throws ANALYTICS_V2_INPUT_INVALID:resources. */
export function validAnalyticsV2Resources(value: unknown): AnalyticsV2Resources {
  const resources = value as Partial<AnalyticsV2Resources> | null;
  if (resources === null || typeof resources !== "object" || Array.isArray(resources)
    || Object.keys(resources).sort().join(",") !== "maxDayOccurrences,maxDayRecordBytes,memoryBudgetBytes") {
    throw new TypeError("ANALYTICS_V2_INPUT_INVALID:resources");
  }
  for (const [name, bound] of Object.entries(ANALYTICS_V2_RESOURCE_BOUNDS)) {
    const entry = resources[name as keyof AnalyticsV2Resources];
    if (!Number.isSafeInteger(entry) || entry! < bound.minimum || entry! > bound.maximum) {
      throw new TypeError("ANALYTICS_V2_INPUT_INVALID:resources");
    }
  }
  return Object.freeze({ memoryBudgetBytes: resources.memoryBudgetBytes!,
    maxDayOccurrences: resources.maxDayOccurrences!, maxDayRecordBytes: resources.maxDayRecordBytes! });
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
 * Bytes of JavaScript heap per unit of an owner's evidence while the job
 * computes that owner (compute.ts: the owner's occurrences are held for the
 * whole owner; the 170 analysis days keep their prepared usage rows; the
 * largest day's preparation and evidence digest are transient). Measured on
 * Node 22.16.0 with synthetic, content-free v1.1-shaped records and rounded
 * up; see docs/receipts/2026-10-01-gcp-fastpath-caps.md for the measurement.
 */
export const ANALYTICS_V2_MEMORY_MODEL = Object.freeze({
  version: "analytics-v2-memory-model-v1" as const,
  /** Kernel state, reduction checkpoints and the owner's outputs. */
  ownerOverheadBytes: 128 * MIB,
  /** One held occurrence (EffectiveTelemetryOccurrence and its record JSON). */
  heldBytesPerOccurrence: Object.freeze({ usage: 1_700, quota: 1_400, session: 1_300 }),
  /** One usage occurrence of an analysis day after preparation (usage row and cache item). */
  preparedBytesPerAnalysisUsage: 2_400,
  /** One occurrence of the owner's largest day during its preparation and digest. */
  transientBytesPerLargestDayOccurrence: 4_000,
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
 * and `today` bound the analysis days whose prepared usage rows are retained.
 */
export function analyticsV2OwnerMemoryEstimate(evidence: AnalyticsV2OwnerEvidence,
  analysisFromDay: AnalyticsV2Day, today: AnalyticsV2Day): AnalyticsV2OwnerEstimate {
  const model = ANALYTICS_V2_MEMORY_MODEL;
  let usage = 0, quota = 0, session = 0, analysisUsage = 0, maxDay = 0;
  for (const [day, counts] of evidence) {
    const dayUsage = validCount(counts?.usage), dayQuota = validCount(counts?.quota),
      daySession = validCount(counts?.session);
    usage += dayUsage; quota += dayQuota; session += daySession;
    if (day >= analysisFromDay && day <= today) analysisUsage += dayUsage;
    maxDay = Math.max(maxDay, dayUsage + dayQuota + daySession);
  }
  const estimateBytes = model.ownerOverheadBytes
    + usage * model.heldBytesPerOccurrence.usage
    + quota * model.heldBytesPerOccurrence.quota
    + session * model.heldBytesPerOccurrence.session
    + analysisUsage * model.preparedBytesPerAnalysisUsage
    + maxDay * model.transientBytesPerLargestDayOccurrence;
  if (!Number.isSafeInteger(estimateBytes)) throw new TypeError("ANALYTICS_V2_INPUT_INVALID:ownerEvidence");
  return Object.freeze({ occurrences: Object.freeze({ usage, quota, session }), analysisUsage,
    maxDayOccurrences: maxDay, estimateBytes });
}
