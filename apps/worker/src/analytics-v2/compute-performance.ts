/**
 * analytics-v2 community model performance (A-2 fold): the twelve
 * `community-model-performance-v1` candidates, one per period (1, 7, 30, all)
 * and published speed mode (Standard, Fast, Ultrafast), folded from the
 * current daily performance records (performance-source.ts yields).
 *
 * Pure: no I/O, no clock, no logging. The same records give the same
 * outputs and digests in any order (pools are sums and extrema, distinct
 * counts are sets, models follow REVIEWED_MODEL_CATALOG, points follow their
 * day). Opaque participant, device and report keys are held in memory only;
 * no output carries them and nothing logs record content.
 *
 * A kernel closure root (cloud-run/analytics-kernel-closure.mjs): the
 * refresh Job runs it after computeAnalyticsV2, outside it
 * (cloud-run/analytics-refresh-read.mjs), over the reader's pages. Its six
 * shared types come type-only from performance-publication-contract.ts
 * (plumbing, outside the closure); its content digest stays defined here, on
 * the closure side, and a parity test holds it equal to the store-side
 * helper on every golden candidate.
 *
 * The fold mirrors the desktop Model performance view
 * (src/reporting/model-performance.js on the client line):
 * - Every record is validated under its own field dictionary with
 *   adaptTelemetryPerformanceRecord and read in the latest vocabulary; its
 *   day must be its report's day. Any invalid record withholds the whole
 *   publication (ANALYTICS_V2_PERFORMANCE_RECORD_INVALID): never a partial
 *   fold that silently drops evidence.
 * - end is the latest completed UTC day, utcDay(nowMs) - 1. A record after
 *   end is deferred (summary.deferredFutureDays counts its distinct days).
 * - A participant-day that N-EXCL excludes (`excludedOn`) is dropped before
 *   anything else is counted (summary.excludedRecords).
 * - Periods 1, 7 and 30 end at end and start at end - (period - 1), with day
 *   points. Period all starts at the first included day of its speed mode
 *   (end when there is none) and switches to Monday-aligned UTC weeks when
 *   end - start exceeds 366 days.
 * - Standard, Fast and Ultrafast publish. `unknown`, `mixed` and `other`
 *   only add their turns to excludedUnknownTurns: an older dictionary's
 *   `other` includes Ultrafast (clients 0.1.24-0.1.26 report Ultrafast turns
 *   as `other`, dictionary 2026-09-21.1), so `other` is not comparable across
 *   dictionaries. Ultrafast is therefore undercounted for those clients;
 *   the fold never guesses which `other` turns were Ultrafast.
 * - Speed and first-token histograms pool per (speed mode, model, metric,
 *   bin) with poolPerformanceHistograms, through pending lists collapsed at
 *   200 items so a call never receives more than 200. v1 histograms pool
 *   exactly below 120 tokens/second; a v1 speed overflow stays unresolved
 *   mass that widens the bounds. Effort and measurement method are pooled.
 * - Points come from buildCommunityModelPerformancePoint: a point below five
 *   samples keeps only its median, and bounds round outward (the contract).
 * - Per model: turns, speedTurns, ttftTurns, timedResponses, toolFreeTurns
 *   (speedTurns of speedMethod tool_free records) and its distinct
 *   contributors and devices in the window. The top-level contributors,
 *   devices and reports count only sources with at least one included record
 *   of the slot's speed mode in its window. A device is counted per
 *   participant and a report per device, so devices >= contributors and
 *   reports >= devices hold by construction.
 *
 * Payloads carry placeholders the store replaces when it stamps them:
 * revision 1 and generatedAt = nowMs. payloadSha256 identifies the CONTENT
 * (the canonical payload without revision and generatedAt), following
 * compute-community.ts analyticsV2DailyContentSha256, so an unchanged slot
 * keeps its digest. Every candidate is checked with
 * parseCommunityModelPerformance before it leaves the fold.
 *
 * Withholding: candidates [] plus one closed code, in this precedence:
 * RECORD_INVALID (an invalid stored record), CAPACITY (more than 4096 held
 * days, a payload over the contract's byte cap, or a count or pool that
 * would leave the safe-integer range), MODELS_EXCEEDED (more than 64 models)
 * and POINTS_EXCEEDED (a series over 600 points). Each condition depends
 * only on the record set, never on its order. A withheld fold still reports
 * its summary. When nothing is withheld, candidates holds exactly the 12
 * slots, empty models allowed; the store, not the fold, defers the very
 * first all-empty publication.
 *
 * Resources: held state is per (speed mode, model, day) pools and counters
 * plus per-source latest days, so it grows with days x models x modes x 2
 * pools; the day and model caps bound it, and held pools are released as
 * soon as the day cap trips. `account`, when given, is charged each emitted
 * candidate (resources.ts analyticsV2OutputRowBytes) and may throw (the run's
 * output budget). The refresh Job passes none: the store charges the
 * candidates to the run's output account exactly once, against the room
 * computeAnalyticsV2 left, and records them (store-run.ts prepareOutputs).
 * `checkpoint`, when given, is called with content-free progress events and
 * may throw (the Job's time guard); either error ends the fold.
 */
import {
  COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION,
  COMMUNITY_MODEL_PERFORMANCE_POPULATION,
  COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION,
  MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES,
  MAX_COMMUNITY_MODEL_PERFORMANCE_MODELS,
  MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS,
  PERFORMANCE_FIELD_DICTIONARIES,
  REVIEWED_MODEL_CATALOG,
  adaptTelemetryPerformanceRecord,
  buildCommunityModelPerformancePoint,
  isTelemetryContractError,
  parseCommunityModelPerformance,
  poolPerformanceHistograms,
  type CommunityModelPerformanceModel,
  type CommunityModelPerformancePoint,
  type PerformanceFieldDictionaryVersion,
  type PerformanceHistogram,
  type PerformanceHistogramPool,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { analyticsV2OutputRowBytes } from "./resources";

// Type-only, erased by esbuild: the contract module is store-side plumbing and
// no closure input (the kernel registry check asserts it).
import type {
  AnalyticsV2PerformanceCandidate,
  AnalyticsV2PerformanceOutputs,
  AnalyticsV2PerformancePeriod,
  AnalyticsV2PerformanceSpeedMode,
  AnalyticsV2PerformanceSummary,
  AnalyticsV2PerformanceWithheld,
} from "./performance-publication-contract";

export type {
  AnalyticsV2PerformanceCandidate,
  AnalyticsV2PerformanceOutputs,
  AnalyticsV2PerformancePeriod,
  AnalyticsV2PerformanceSpeedMode,
  AnalyticsV2PerformanceSummary,
  AnalyticsV2PerformanceWithheld,
};

/** The periods and speed modes of the 12 slots, in candidate order (period-major). */
export const ANALYTICS_V2_PERFORMANCE_PERIODS: readonly AnalyticsV2PerformancePeriod[] = Object.freeze(["1", "7", "30", "all"]);
export const ANALYTICS_V2_PERFORMANCE_SPEED_MODES: readonly AnalyticsV2PerformanceSpeedMode[] =
  Object.freeze(["standard", "fast", "ultrafast"]);

export interface AnalyticsV2PerformanceLimits {
  readonly maxDays: number;
  readonly maxModels: number;
  readonly maxPoints: number;
}

/** The fold's capacity limits (a run may only tighten them). */
export const ANALYTICS_V2_PERFORMANCE_LIMITS: AnalyticsV2PerformanceLimits = Object.freeze({
  maxDays: 4096,
  maxModels: MAX_COMMUNITY_MODEL_PERFORMANCE_MODELS,
  maxPoints: MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS,
});

/** Histograms or pools per poolPerformanceHistograms call (the contract's page bound). */
export const ANALYTICS_V2_PERFORMANCE_POOL_PAGE = 200;

/** Records between two `records` checkpoints. */
const RECORDS_PER_CHECKPOINT = 4096;
/** Days with more than this span between start and end publish weekly (the desktop rule). */
const WEEKLY_SPAN_DAYS = 366;
const DAY_MS = 86_400_000;
/** Epoch day 4 (1970-01-05) is a Monday. */
const MONDAY_EPOCH_DAY = 4;

/**
 * One performance-source.ts yield. The keys are opaque in-memory values
 * (strings, safe integers or bigints); they are compared, never output.
 */
export interface AnalyticsV2PerformanceSourceRecord {
  readonly participantKey: unknown;
  readonly deviceKey: unknown;
  readonly reportKey: unknown;
  readonly reportDay: unknown;
  readonly fieldDictionaryVersion: unknown;
  readonly record: unknown;
}

/** A content-free fold progress event. */
export type AnalyticsV2PerformanceCheckpoint =
  | { readonly kind: "performance"; readonly phase: "records"; readonly records: number }
  | { readonly kind: "performance"; readonly phase: "slot"; readonly index: number };

/** The output account the fold charges each emitted candidate to; `charge` may throw. */
export interface AnalyticsV2PerformanceAccount {
  readonly charge: (bytes: number) => void;
}

export interface AnalyticsV2PerformanceInput {
  readonly records: Iterable<AnalyticsV2PerformanceSourceRecord> | AsyncIterable<AnalyticsV2PerformanceSourceRecord>;
  readonly nowMs: number;
  /** N-EXCL: whether the participant is excluded from the community aggregates on `day`. */
  readonly excludedOn: (participantKey: unknown, day: string) => boolean;
  readonly checkpoint?: (event: AnalyticsV2PerformanceCheckpoint) => void;
  readonly account?: AnalyticsV2PerformanceAccount;
  /** Tighter capacity limits (tests); each must be a positive safe integer at most its default. */
  readonly limits?: Partial<AnalyticsV2PerformanceLimits>;
}

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_PERFORMANCE_INPUT_INVALID:${what}`); };

/**
 * A performance payload's content identity: sha256 of its canonical JSON
 * without the store's stamp (revision, generatedAt). Equal for every stamp of
 * the same content. The store keeps its own definition
 * (performance-publication-contract.ts); the model-performance Job spec
 * proves the two equal on every golden candidate.
 */
export async function analyticsV2PerformanceContentSha256(payload: Readonly<Record<string, unknown>>): Promise<string> {
  const { revision: _revision, generatedAt: _generatedAt, ...content } = payload;
  return sha256Hex(canonicalJson(content));
}

// ---- Days ----------------------------------------------------------------

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function epochDayOf(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return ms / DAY_MS;
}

function dayOfEpochDay(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

function mondayOnOrBefore(epochDay: number): number {
  return epochDay - ((((epochDay - MONDAY_EPOCH_DAY) % 7) + 7) % 7);
}

// ---- Keys ----------------------------------------------------------------

function keyPart(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? `s${JSON.stringify(value)}` : null;
  if (typeof value === "bigint") return `b${value.toString()}`;
  if (typeof value === "number") return Number.isSafeInteger(value) ? `n${value}` : null;
  return null;
}

// ---- Pools ---------------------------------------------------------------

/** A count or pool that would leave the safe-integer range (withheld as CAPACITY). */
class CapacityOverflow extends Error {}
/** A series over the points limit (withheld as POINTS_EXCEEDED). */
class PointsExceeded extends Error {}

/** Histograms or pools of one bin, collapsed so no pool call takes more than one page. */
class PendingPool {
  private items: (PerformanceHistogram | PerformanceHistogramPool)[] = [];
  private finished: PerformanceHistogramPool | null | undefined;

  add(item: PerformanceHistogram | PerformanceHistogramPool): void {
    if (this.finished !== undefined) throw new Error("ANALYTICS_V2_PERFORMANCE_POOL_FINISHED");
    this.items.push(item);
    if (this.items.length >= ANALYTICS_V2_PERFORMANCE_POOL_PAGE) this.items = [pooled(this.items)];
  }

  /** The bin's single pool, or null when it holds no sample; later calls return the same pool. */
  finish(): PerformanceHistogramPool | null {
    if (this.finished === undefined) {
      const pool = this.items.length === 0 ? null : pooled(this.items);
      this.finished = pool !== null && pool.sampleCount > 0 ? pool : null;
      this.items = [];
    }
    return this.finished;
  }
}

/**
 * One poolPerformanceHistograms call. Its inputs are validated records' histograms or
 * its own pools, so a contract refusal can only be a count leaving the safe-integer range.
 */
function pooled(items: readonly (PerformanceHistogram | PerformanceHistogramPool)[]): PerformanceHistogramPool {
  try {
    return poolPerformanceHistograms(items);
  } catch (error) {
    if (isTelemetryContractError(error)) throw new CapacityOverflow();
    throw error;
  }
}

/** One (speed mode, model, day) cell: its counters and its two metric pools. */
interface DayCell {
  turns: number;
  speedTurns: number;
  ttftTurns: number;
  timedResponses: number;
  toolFreeTurns: number;
  readonly speed: PendingPool;
  readonly ttft: PendingPool;
}

/** The count fields one window sums per model. */
interface ModelTotals {
  turns: number;
  speedTurns: number;
  ttftTurns: number;
  timedResponses: number;
  toolFreeTurns: number;
}

/** A mode's per-source latest included day (epoch day), for windowed distinct counts. */
interface ModeSources {
  readonly contributors: Map<string, number>;
  readonly devices: Map<string, number>;
  readonly reports: Map<string, number>;
  /** model index -> participant -> latest day */
  readonly modelContributors: Map<number, Map<string, number>>;
  /** model index -> device -> latest day */
  readonly modelDevices: Map<number, Map<string, number>>;
}


function addCount(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new CapacityOverflow();
  return sum;
}

function latest(map: Map<string, number>, key: string, epochDay: number): void {
  const prior = map.get(key);
  if (prior === undefined || prior < epochDay) map.set(key, epochDay);
}

function countSince(map: Map<string, number> | undefined, startEpochDay: number): number {
  let count = 0;
  if (map !== undefined) for (const day of map.values()) if (day >= startEpochDay) count += 1;
  return count;
}

const PUBLISHED_MODES = new Set<string>(ANALYTICS_V2_PERFORMANCE_SPEED_MODES);
const CATALOG_INDEX = new Map(REVIEWED_MODEL_CATALOG.map(({ provider, id }, index) => [`${provider}\u0000${id}`, index]));

function validLimits(limits: AnalyticsV2PerformanceInput["limits"]): AnalyticsV2PerformanceLimits {
  if (limits === undefined) return ANALYTICS_V2_PERFORMANCE_LIMITS;
  if (limits === null || typeof limits !== "object") invalid("limits");
  const result: { -readonly [K in keyof AnalyticsV2PerformanceLimits]: number } = { ...ANALYTICS_V2_PERFORMANCE_LIMITS };
  for (const key of Object.keys(limits) as (keyof AnalyticsV2PerformanceLimits)[]) {
    const value = limits[key];
    if (!Object.hasOwn(ANALYTICS_V2_PERFORMANCE_LIMITS, key) || !Number.isSafeInteger(value) || (value as number) < 1
      || (value as number) > ANALYTICS_V2_PERFORMANCE_LIMITS[key]) invalid(`limits.${String(key)}`);
    result[key] = value as number;
  }
  return Object.freeze(result);
}

/**
 * Fold the current performance records into the 12 community model
 * performance candidates (see the module comment for every rule).
 */
export async function computeAnalyticsV2Performance(input: AnalyticsV2PerformanceInput): Promise<AnalyticsV2PerformanceOutputs> {
  if (input === null || typeof input !== "object") invalid("input");
  const { records, nowMs, excludedOn } = input;
  if (records === null || typeof records !== "object"
    || (typeof (records as Iterable<unknown>)[Symbol.iterator] !== "function"
      && typeof (records as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function")) invalid("records");
  if (!Number.isSafeInteger(nowMs) || nowMs < DAY_MS || nowMs > 8_640_000_000_000_000) invalid("nowMs");
  if (typeof excludedOn !== "function") invalid("excludedOn");
  if (input.checkpoint !== undefined && typeof input.checkpoint !== "function") invalid("checkpoint");
  if (input.account !== undefined && (input.account === null || typeof input.account.charge !== "function")) invalid("account");
  const checkpoint = input.checkpoint ?? ((): void => {});
  const limits = validLimits(input.limits);

  const endEpochDay = Math.floor(nowMs / DAY_MS) - 1;
  const end = dayOfEpochDay(endEpochDay);

  // ---- Summary counters (order-independent: sums and sets).
  const reportKeys = new Set<string>();
  const deferredDays = new Set<string>();
  let cohorts = 0;
  let includedRecords = 0;
  let excludedRecords = 0;
  let excludedUnknownTurns = 0;

  // ---- Withholding conditions; each is monotone in the record set.
  let recordInvalid = false;
  let capacity = false;
  const heldDays = new Set<number>();
  const heldModels = new Set<number>();

  // ---- Held state.
  /** mode -> model index -> epoch day -> cell */
  let cells: Map<string, Map<number, Map<number, DayCell>>> | null = new Map();
  /** epoch day -> unknown/mixed/other turns (included participant-days only) */
  const unknownTurnsByDay = new Map<number, number>();
  /** mode -> first included epoch day */
  const firstDay = new Map<string, number>();
  const sources = new Map<string, ModeSources>(ANALYTICS_V2_PERFORMANCE_SPEED_MODES.map((mode) => [mode, {
    contributors: new Map(), devices: new Map(), reports: new Map(), modelContributors: new Map(), modelDevices: new Map(),
  }]));

  const releaseHeld = (): void => {
    cells = null;
    sources.clear();
    firstDay.clear();
  };

  let seen = 0;
  for await (const item of records as AsyncIterable<AnalyticsV2PerformanceSourceRecord>) {
    seen += 1;
    if (seen % RECORDS_PER_CHECKPOINT === 0) checkpoint(Object.freeze({ kind: "performance", phase: "records", records: seen }));
    try {
      cohorts = addCount(cohorts, 1);
    } catch {
      capacity = true;
    }
    if (item === null || typeof item !== "object") {
      recordInvalid = true;
      continue;
    }
    const participant = keyPart(item.participantKey);
    const devicePart = keyPart(item.deviceKey);
    const reportPart = keyPart(item.reportKey);
    if (participant === null || devicePart === null || reportPart === null) {
      recordInvalid = true;
      continue;
    }
    const device = `${participant}\u0000${devicePart}`;
    const report = `${device}\u0000${reportPart}`;
    reportKeys.add(report);
    const dictionary = item.fieldDictionaryVersion;
    if (typeof dictionary !== "string" || !Object.hasOwn(PERFORMANCE_FIELD_DICTIONARIES, dictionary)
      || typeof item.reportDay !== "string" || !DAY_PATTERN.test(item.reportDay)) {
      recordInvalid = true;
      continue;
    }
    let record;
    try {
      record = adaptTelemetryPerformanceRecord(item.record, dictionary as PerformanceFieldDictionaryVersion).record;
    } catch (error) {
      if (!isTelemetryContractError(error)) throw error;
      recordInvalid = true;
      continue;
    }
    if (record.day !== item.reportDay) {
      recordInvalid = true;
      continue;
    }
    const epochDay = epochDayOf(record.day);
    if (epochDay > endEpochDay) {
      deferredDays.add(record.day);
      continue;
    }
    const excluded = excludedOn(item.participantKey, record.day);
    if (typeof excluded !== "boolean") invalid("excludedOn");
    if (excluded) {
      excludedRecords += 1;
      continue;
    }
    const mode = record.speedMode;
    try {
      if (!PUBLISHED_MODES.has(mode)) {
        excludedUnknownTurns = addCount(excludedUnknownTurns, record.turns);
        unknownTurnsByDay.set(epochDay, addCount(unknownTurnsByDay.get(epochDay) ?? 0, record.turns));
        continue;
      }
      const modelIndex = CATALOG_INDEX.get(`${record.provider}\u0000${record.modelId}`);
      if (modelIndex === undefined) {
        // adaptTelemetryPerformanceRecord accepts reviewed pairs only.
        recordInvalid = true;
        continue;
      }
      includedRecords += 1;
      heldModels.add(modelIndex);
      // The day set stops growing one past the limit; that is all the cap needs.
      if (!heldDays.has(epochDay) && heldDays.size <= limits.maxDays) heldDays.add(epochDay);
      if (heldDays.size > limits.maxDays) capacity = true;
      // Once the result is certain to be withheld, nothing more is held; validation and the summary go on.
      if (capacity || recordInvalid || cells === null) {
        if (cells !== null) releaseHeld();
        continue;
      }
      const prior = firstDay.get(mode);
      if (prior === undefined || epochDay < prior) firstDay.set(mode, epochDay);
      let byModel = cells.get(mode);
      if (byModel === undefined) cells.set(mode, byModel = new Map());
      let byDay = byModel.get(modelIndex);
      if (byDay === undefined) byModel.set(modelIndex, byDay = new Map());
      let cell = byDay.get(epochDay);
      if (cell === undefined) {
        byDay.set(epochDay, cell = { turns: 0, speedTurns: 0, ttftTurns: 0, timedResponses: 0, toolFreeTurns: 0,
          speed: new PendingPool(), ttft: new PendingPool() });
      }
      cell.turns = addCount(cell.turns, record.turns);
      cell.speedTurns = addCount(cell.speedTurns, record.speedTurns);
      cell.ttftTurns = addCount(cell.ttftTurns, record.ttftTurns);
      cell.timedResponses = addCount(cell.timedResponses, record.timedResponses);
      if (record.speedMethod === "tool_free") cell.toolFreeTurns = addCount(cell.toolFreeTurns, record.speedTurns);
      if (record.speedHistogram.sampleCount > 0) cell.speed.add(record.speedHistogram);
      if (record.ttftHistogram.sampleCount > 0) cell.ttft.add(record.ttftHistogram);
      const modeSources = sources.get(mode) as ModeSources;
      latest(modeSources.contributors, participant, epochDay);
      latest(modeSources.devices, device, epochDay);
      latest(modeSources.reports, report, epochDay);
      let modelContributors = modeSources.modelContributors.get(modelIndex);
      if (modelContributors === undefined) modeSources.modelContributors.set(modelIndex, modelContributors = new Map());
      latest(modelContributors, participant, epochDay);
      let modelDevices = modeSources.modelDevices.get(modelIndex);
      if (modelDevices === undefined) modeSources.modelDevices.set(modelIndex, modelDevices = new Map());
      latest(modelDevices, device, epochDay);
    } catch (error) {
      if (!(error instanceof CapacityOverflow)) throw error;
      // A count or pool left the safe-integer range.
      capacity = true;
      releaseHeld();
    }
  }

  const summary: AnalyticsV2PerformanceSummary = Object.freeze({
    reports: reportKeys.size,
    cohorts,
    includedRecords,
    excludedRecords,
    excludedUnknownTurns,
    deferredFutureDays: deferredDays.size,
    end,
  });
  const withhold = (code: AnalyticsV2PerformanceWithheld): AnalyticsV2PerformanceOutputs =>
    Object.freeze({ candidates: Object.freeze([]), summary, withheld: code });
  if (recordInvalid) return withhold("ANALYTICS_V2_PERFORMANCE_RECORD_INVALID");
  if (capacity || cells === null) return withhold("ANALYTICS_V2_PERFORMANCE_CAPACITY");
  if (heldModels.size > limits.maxModels) return withhold("ANALYTICS_V2_PERFORMANCE_MODELS_EXCEEDED");
  const heldCells = cells as Map<string, Map<number, Map<number, DayCell>>>;

  // ---- Slots.
  const unknownSince = (startEpochDay: number): number => {
    let total = 0;
    for (const [day, turns] of unknownTurnsByDay) if (day >= startEpochDay) total += turns;
    return total;
  };

  const built: { period: AnalyticsV2PerformancePeriod; speedMode: AnalyticsV2PerformanceSpeedMode;
    payload: Record<string, unknown> }[] = [];
  let slotIndex = 0;
  try {
    for (const period of ANALYTICS_V2_PERFORMANCE_PERIODS) {
      for (const speedMode of ANALYTICS_V2_PERFORMANCE_SPEED_MODES) {
        checkpoint(Object.freeze({ kind: "performance", phase: "slot", index: slotIndex }));
        slotIndex += 1;
        const startEpochDay = period === "all" ? (firstDay.get(speedMode) ?? endEpochDay)
          : endEpochDay - (Number(period) - 1);
        const interval = period === "all" && endEpochDay - startEpochDay > WEEKLY_SPAN_DAYS ? "week" : "day";
        const modeSources = sources.get(speedMode) as ModeSources;
        const byModel = heldCells.get(speedMode) ?? new Map<number, Map<number, DayCell>>();
        const models: CommunityModelPerformanceModel[] = [];
        for (const modelIndex of [...byModel.keys()].sort((left, right) => left - right)) {
          const byDay = byModel.get(modelIndex) as Map<number, DayCell>;
          const days = [...byDay.keys()].filter((day) => day >= startEpochDay && day <= endEpochDay)
            .sort((left, right) => left - right);
          if (days.length === 0) continue;
          const totals: ModelTotals = { turns: 0, speedTurns: 0, ttftTurns: 0, timedResponses: 0, toolFreeTurns: 0 };
          for (const day of days) {
            const cell = byDay.get(day) as DayCell;
            totals.turns = addCount(totals.turns, cell.turns);
            totals.speedTurns = addCount(totals.speedTurns, cell.speedTurns);
            totals.ttftTurns = addCount(totals.ttftTurns, cell.ttftTurns);
            totals.timedResponses = addCount(totals.timedResponses, cell.timedResponses);
            totals.toolFreeTurns = addCount(totals.toolFreeTurns, cell.toolFreeTurns);
          }
          const series = (metric: "speed" | "ttft"): readonly CommunityModelPerformancePoint[] => {
            const bins = new Map<number, PendingPool>();
            for (const day of days) {
              const pool = (byDay.get(day) as DayCell)[metric].finish();
              if (pool === null) continue;
              const bin = interval === "week" ? mondayOnOrBefore(day) : day;
              let pending = bins.get(bin);
              if (pending === undefined) bins.set(bin, pending = new PendingPool());
              pending.add(pool);
            }
            if (bins.size > limits.maxPoints) throw new PointsExceeded();
            const points = [...bins.keys()].sort((left, right) => left - right).flatMap((bin) => {
              const pool = (bins.get(bin) as PendingPool).finish();
              return pool === null ? [] : [buildCommunityModelPerformancePoint(dayOfEpochDay(bin), pool)];
            });
            return points;
          };
          const { provider, id } = REVIEWED_MODEL_CATALOG[modelIndex] as (typeof REVIEWED_MODEL_CATALOG)[number];
          models.push({
            provider,
            modelId: id,
            ...totals,
            contributors: countSince(modeSources.modelContributors.get(modelIndex), startEpochDay),
            devices: countSince(modeSources.modelDevices.get(modelIndex), startEpochDay),
            speed: { unit: "tokens_per_second", points: [...series("speed")] },
            ttft: { unit: "milliseconds", points: [...series("ttft")] },
          });
        }
        built.push({ period, speedMode, payload: {
          schemaVersion: COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION,
          methodVersion: COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION,
          population: COMMUNITY_MODEL_PERFORMANCE_POPULATION,
          approximate: true,
          revision: 1,
          generatedAt: new Date(nowMs).toISOString(),
          period,
          interval,
          start: dayOfEpochDay(startEpochDay),
          end,
          speedMode,
          excludedUnknownTurns: unknownSince(period === "all" ? -Infinity : startEpochDay),
          contributors: countSince(modeSources.contributors, startEpochDay),
          devices: countSince(modeSources.devices, startEpochDay),
          reports: countSince(modeSources.reports, startEpochDay),
          models,
        } });
      }
    }
  } catch (error) {
    if (error instanceof PointsExceeded) return withhold("ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED");
    // Window sums or pools that leave the safe-integer range.
    if (error instanceof CapacityOverflow) return withhold("ANALYTICS_V2_PERFORMANCE_CAPACITY");
    throw error;
  }

  // ---- Validate, digest and charge every candidate.
  const candidates: AnalyticsV2PerformanceCandidate[] = [];
  for (const { payload } of built) {
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES) {
      return withhold("ANALYTICS_V2_PERFORMANCE_CAPACITY");
    }
  }
  for (const { period, speedMode, payload } of built) {
    // A refusal here is a fold defect, not a withhold: it fails the run.
    parseCommunityModelPerformance(payload);
    const candidate: AnalyticsV2PerformanceCandidate = Object.freeze({ period, speedMode, payload: Object.freeze(payload),
      payloadSha256: await analyticsV2PerformanceContentSha256(payload) });
    input.account?.charge(analyticsV2OutputRowBytes(candidate));
    candidates.push(candidate);
  }
  return Object.freeze({ candidates: Object.freeze(candidates), summary, withheld: null });
}
