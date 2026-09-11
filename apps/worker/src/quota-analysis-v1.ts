import {
  MODEL_COMPOSITION_POLICY,
  PLAN_ATTRIBUTION_POLICY,
  QUOTA_CALIBRATION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
  analyzeQuotaCalibration,
  buildPlanAttributionIndex,
  buildCompositionObservationsFromOrderedUsage,
  buildResetEvidence,
  calibrateCompositionCapacities,
  isSupportedQuotaWindowDuration,
  planAttributionContextKey,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import type {
  CompositionFit,
  CompositionQuotaRow,
  CompositionUsageRow,
  PricingStatus,
  PlanAttributionIndex,
  PlanAttributionObservation,
  QuotaSlot,
  QuotaSnapshotInput,
  QuotaUsageEventInput,
  QuotaWindowDurationMinutes,
} from "@app-usagemonitor/quota-analysis";
import { sha256Hex } from "./crypto";
import { priceTelemetryUsageEvent } from "./server-pricing";
import { parseStoredRecordJson } from "./stored-record";
import type { TelemetryUsageEvent } from "./telemetry-validation";
import {
  loadV1SourcePin,
  assertV1SourcePinCurrent,
  V1_SOURCE_SELECTION_METHOD_VERSION,
  V1_WINNER_FILTER_SQL,
} from "./telemetry-v1-source-selection";
import type { V1SourcePin } from "./telemetry-v1-source-selection";
import { modelHistoryWindow, V1_ANALYSIS_WINDOW_DAYS, type ModelHistoryWindow } from "./model-history-window";
export { V1_ANALYSIS_WINDOW_DAYS } from "./model-history-window";
import {
  V1_QUOTA_ACQUISITION_VERSION,
  validateV1CompletedQuotaAcquisition,
  type V1CompletedQuotaAcquisition,
  type V1QuotaAcquisitionIdentity,
  type V1QuotaInvocationBudget,
} from "./quota-analysis-v1-reader";

/** Bump fit/composition caches whenever this adapter attribution changes. */
export const V1_PLAN_ATTRIBUTION_ADAPTER_VERSION =
  `${V1_SOURCE_SELECTION_METHOD_VERSION}:${PLAN_ATTRIBUTION_POLICY.methodVersion}:v1-era-buckets-2`;

/** Separate until the cache-only scheduler is integrated. Never label the old
 * synchronous acquisition with the corrected equal-time plan barrier method. */
export const V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION =
  `${V1_SOURCE_SELECTION_METHOD_VERSION}:${PLAN_ATTRIBUTION_POLICY.methodVersion}:v1-era-buckets-3:${V1_QUOTA_ACQUISITION_VERSION}`;
export const MODEL_HISTORY_METHOD_VERSION = `${V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION}:model-history-1`;

/**
 * Reset-fit analysis for the telemetry-contribution-v1.0 chunk corpus, computed
 * server-side so the community allowance band can draw from v1 data with ZERO
 * new calibration math.
 *
 * This reproduces `accountScopedQuotaAnalysis` (quota-analysis.ts, the v0.2
 * path) in shape — the same seed/bucket/loop, the same MAX_CONTINUITY_TRACKS
 * gate, the same per-seed `buildResetEvidence` + `analyzeQuotaCalibration` from
 * the shared calibration package. Its acquisition differs in these respects:
 *
 *   1. Row source: the v1 current record view (`telemetry_v1_records`), read
 *      through the same per-(participant, day) winning-device dedupe the daily
 *      aggregates use, so a re-paired device's re-upload of the same underlying
 *      local index is counted once.
 *   2. Synthesized fields: v1 records carry no server pricing, track
 *      attribution, dataset, or receipt metadata, so those are derived here —
 *      pricing from the same `priceTelemetryUsageEvent` the v0.2 ingest uses
 *      (never a client-declared cost), dataset/receipt as deterministic
 *      synthetic values pinned to the participant. The synthetic account track
 *      is a kernel placeholder, never evidence of a provider account. Events that do not fully
 *      price STAY in the bucket and correctly refuse their reset via
 *      `incomplete_server_pricing`; a price is never dropped or fabricated.
 *   3. Plan attribution uses all admitted quota evidence, including short and
 *      non-fitting windows, before any quota reduction. Usage is folded only
 *      within a coherent conditional plan era; unresolved quantities refuse
 *      their affected resets. Era fragments remain diagnostic until the shared
 *      community collector applies its population gates and parent selection.
 *
 * SCALE (why this does not "load all rows then cap"): the owner's genuine dense
 * v1 corpus is ~1.22M records (a Codex rate_limits snapshot ~every 15s), which
 * the naive "read everything, LIMIT 50001, refuse over 50k" acquisition always
 * bailed on. The band's fit numbers flow ONLY through `evidence.boundaries`
 * plus a per-reset pricing/total refusal (community-allowance.ts) — never the
 * raw ~15s snapshot stream or per-event usage — so the acquisition is replaced
 * by two purpose-built reads plus a reduction that is provably identical, per
 * reset, to what `buildResetEvidence` would compute on the full corpus:
 *
 *   - QUOTA: one SQL query that reuses the winning-device dedupe, windows to the
 *     trailing horizon snapped to whole reset cycles, pre-filters to the only
 *     track the consumer keeps (limit_id='codex', window=10080), drops reset
 *     groups the shared calibration always refuses (the fitable HAVING), and
 *     collapses each flat used_percent run to its endpoints via LAG/LEAD. A
 *     boundary is emitted only on a strict used_percent increase and anchors
 *     lowerCost on the LAST row of the preceding run and upperCost on the FIRST
 *     row of the new run, so keeping both run endpoints is byte-identical for
 *     the fit while collapsing ~281k raw quota to ~4k rows.
 *   - USAGE: keyset-paginated, repriced per event, then folded into synthetic
 *     cost buckets aligned to the retained quota observed_at grid (ceiling
 *     bucket + singleton-split for grid-exact events, sticky all-fully-priced
 *     flag). `cumulativeCostAt` samples cost only at boundary anchor timestamps,
 *     which are all retained grid points, so the summed buckets reproduce every
 *     boundary cost exactly while collapsing ~306k events to a few hundred rows.
 *
 * The returned object omits `evidence` and `rolling` (the community consumer
 * reads only `track.continuity.planType`/`planVariant` and
 * `track.calibration.tracks[].resets[]`).
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Trailing read horizon (owner decision 2026-08-13): 100 days, deeper than the
// band's own trailing-30d window plus one 7d weekly cycle, snapped to whole
// reset cycles (below). Reading only 30d would truncate the earliest in-window
// weekly cycle and silently shift its span / capacity / lastObservedAt.
const V1_ANALYSIS_WINDOW_MS = V1_ANALYSIS_WINDOW_DAYS * MILLISECONDS_PER_DAY;
const SEVEN_DAY_WINDOW_MS = SEVEN_DAY_WINDOW_MINUTES * 60_000;

// Stage-specific caps applied AFTER the reduction, never a raw combined cap and
// NEVER truncate-and-fit: a truncated usage sum publishes a too-low capacity
// and a truncated cycle changes span / lastObservedAt — a wrong number is worse
// than no number. Distinct reason codes let the monitor tell a legit-but-huge
// corpus from an abusive one. The quota collapse is lossless so a legitimate
// participant (~4k downsampled) never approaches its cap; exceeding it means a
// pathological count of distinct resets_at each sweeping the full percent range.
export const MAX_DOWNSAMPLED_QUOTA_ROWS = 60_000;
// Flat plan runs collapse to endpoints before entering JS. This includes quota
// observations that cannot fit a reset, so a one-row foreign plan is not lost.
export const MAX_PLAN_ATTRIBUTION_ROWS = 120_000;
// Running counter across usage pages (observed heaviest ~306k/100d; the local
// miner's ceiling is 750k/stream).
export const MAX_WINDOWED_USAGE_ROWS = 1_000_000;
const MAX_SESSION_INTERVAL_SCOPES = 100_000;
const USAGE_PAGE_SIZE = 5_000;
// Same synthetic-row bound enforced by the quota-tracks kernel and v1.1
// adapter. Refuse explicitly here rather than throw on an invalid folded row.
const MAX_SCALAR_BUCKET_COST_NANOUSD = 90_000_000_000_000;
// Identical purpose to the v0.2 path: reject a high-cardinality corpus before
// any per-track analysis rather than let distinct-seed count multiply the cost.
const MAX_CONTINUITY_TRACKS = 256;

// The SQL fitable HAVING drops reset groups the shared calibration ALWAYS
// refuses: a group with fewer than `minimumBoundaries` distinct used_percent can
// never reach MINIMUM_BOUNDARIES (too_few_boundaries), and a group whose
// used_percent range is below `minimumDisplayedSpanPp` can never reach
// MINIMUM_SPAN_PP (insufficient_displayed_span). Derived from the package policy
// (never hardcoded) so the SQL tracks the calibration gates by construction.
const MINIMUM_BOUNDARIES = QUOTA_CALIBRATION_POLICY.minimumBoundaries;
const MINIMUM_DISPLAYED_SPAN_PP = QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp;

// The exact SLOT_VALUES / SAFE_TOKEN the shared quota-tracks validators enforce
// (packages/quota-analysis/src/quota-tracks.js). v1 BOUNDED_TOKEN permits
// uppercase, so a row that passed v1 ingest can still fail SAFE_TOKEN here; the
// domain prefilter drops such rows (v0.2-ingest DROP semantics — skip, never
// repair, never throw) before any row reaches the throwing validators.
const SLOT_VALUES = new Set<string>([
  "primary",
  "secondary",
  "five_hour",
  "seven_day",
  "other",
  "unknown",
]);
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;

// v1 carries no provider policy epoch; the whole v1 corpus is one epoch. It is
// stamped identically onto synthesized quota snapshots and usage events, so
// usage matches its track's epoch exactly as in the v0.2 path.
const V1_POLICY_EPOCH = "v1";

interface DownsampledQuotaRow {
  occurrence_id: string;
  observed_at: string;
  provider: string;
  plan_type: string;
  plan_variant: string;
  limit_id: string;
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
  plan_era_key: string;
}

interface PlanEvidenceRow {
  observed_at: string;
  provider: string;
  limit_id: string;
  plan_type: string | null;
  plan_variant: string | null;
}

export interface WindowedUsageRow {
  id: number;
  occurrence_id: string;
  observed_at: string;
  provider: string;
  session_uuid: string | null;
  record_json: string;
  /** Only a source-pinned server preparation reader may supply this value.
   * Explicit null preserves DROP; absence selects the original raw pricer. */
  preparedPrice?: ReturnType<typeof priceChunkUsageRecord>;
}

export interface V1PreparedUsageFragment {
  id: number;
  observed_at: string;
  provider: string;
  binStartMs: number;
  usageEventCount: number;
  unpricedUsageEventCount: number;
  cells: { model: string; costNanousd: number; overflowed: boolean;
    firstObservedAt: string; firstOccurrenceId: string }[];
}

export interface V1PreparedUsageReader {
  readPage(observedAt: string, id: number, limit: number, observedAtBefore?: string): Promise<WindowedUsageRow[]>;
}

export interface V1PreparedUsageBinsReader {
  /** Includes every selected usage record, including DROP and other providers. */
  readonly totalRowCount: number;
  readonly fragmentCount: number;
  readPage(observedAt: string, id: number, limit: number): Promise<V1PreparedUsageFragment[]>;
}

export interface V1PreparedFinishEvidence {
  readonly sourceFingerprint: string;
  readonly usageReader: V1PreparedUsageReader;
  readonly usageBins: V1PreparedUsageBinsReader;
}

// Row shape for the test-only full reference path (both streams in one read).
interface ReferenceRecordRowV1 {
  stream: "usage" | "quota";
  occurrence_id: string;
  observed_at: string;
  provider: string;
  session_uuid: string | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at: string | null;
  record_json: string;
}

// A raw v1 quota row as it can reach the JS domain prefilter (nullable columns).
interface RawQuotaRow {
  occurrence_id: string;
  observed_at: string | null;
  provider: string;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at: string | null;
}

// v1 has no usage plan/account fields. Its conditional plan era is assigned
// before cost reduction; seed fields are stamped ONLY onto that era's usage.
type UsageEventPartial = Omit<
  QuotaUsageEventInput,
  "planType" | "planVariant" | "limitId"
>;

interface AttributedUsageEventPartial extends UsageEventPartial {
  contextKey: string;
  planEraKey: string | null;
  attribution: "legacy_conditional" | "unresolved";
}

interface AttributedQuotaSnapshot extends QuotaSnapshotInput {
  planEraKey: string;
}

interface TrackSeed {
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  windowDurationMinutes: number;
  policyEpoch: string;
  planEraKey: string;
}

/** Tuning knobs; production uses the defaults, tests pin them for determinism. */
export interface V1AnalysisOptions {
  /** Reference instant for the trailing read horizon. Defaults to Date.now(). */
  nowMs?: number;
  /** Override the downsampled-quota-row cap (tests exercise the bail cheaply). */
  maxDownsampledQuotaRows?: number;
  /** Override the windowed-usage-row cap (tests exercise the bail cheaply). */
  maxWindowedUsageRows?: number;
  /** Reuse the collector's exact day/device vector; never re-elect mid-read. */
  sourcePin?: V1SourcePin;
  preparedEvidence?: V1PreparedFinishEvidence;
}

export interface V1AcquiredQuotaEvidence {
  identity: V1QuotaAcquisitionIdentity;
  acquisition: V1CompletedQuotaAcquisition;
}

/** The whole non-resumable usage/fit phase must fit the SAME invocation budget.
 * This is a conservative reservation, not a report of queries actually used.
 * With a supplied pin: 1 successor check + 2 initial source checks + at most
 * 2 queries per 5,000-row usage page (including EOF/overflow) + 2 final checks.
 * Caller separately reserves checkpoint/cache promotion and maintenance costs.
 * CPU and combined retained-memory qualification remain required before wiring
 * this entry point into production; a query reservation alone proves neither.
 */
export function v1QuotaFinishQueryReserve(maxUsageRows = MAX_WINDOWED_USAGE_ROWS): number {
  if (!Number.isSafeInteger(maxUsageRows) || maxUsageRows < 0 || maxUsageRows > MAX_WINDOWED_USAGE_ROWS) {
    throw new TypeError("v1 finish usage bound invalid");
  }
  return 5 + 2 * (Math.floor(maxUsageRows / USAGE_PAGE_SIZE) + 1);
}

/** Exact bounded read allowance for the selected prepared finishing path.
 * Factories/readiness are caller-owned; unchanged source validation keeps its
 * five-query allowance. Sparse bins fall back to prepared event pages. */
export function v1PreparedFinishQueryReserve(prepared: V1PreparedFinishEvidence,
  maxUsageRows = MAX_WINDOWED_USAGE_ROWS, scalarRequested = true): number {
  v1QuotaFinishQueryReserve(maxUsageRows);
  const { totalRowCount, fragmentCount } = prepared.usageBins;
  if (!Number.isSafeInteger(totalRowCount) || totalRowCount < 0
    || !Number.isSafeInteger(fragmentCount) || fragmentCount < 0 || fragmentCount > totalRowCount) {
    throw new TypeError("v1 prepared finish counts invalid");
  }
  if (!scalarRequested && totalRowCount > maxUsageRows) return 5;
  const eventQueries = Math.floor(Math.min(totalRowCount, maxUsageRows) / USAGE_PAGE_SIZE) + 1;
  const binQueries = Math.floor(fragmentCount / 256) + 1;
  return 5 + (scalarRequested ? eventQueries : Math.min(eventQueries, binQueries));
}

function reserveV1QuotaFinish(budget: V1QuotaInvocationBudget, options: V1AnalysisOptions, scalarRequested = true): boolean {
  if (!Number.isSafeInteger(budget.remainingQueries) || budget.remainingQueries < 0
      || !Number.isFinite(budget.deadlineMs)) throw new TypeError("v1 finish budget invalid");
  const maxQuotaRows = options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  if (!Number.isSafeInteger(maxQuotaRows) || maxQuotaRows < 1 || maxQuotaRows > MAX_DOWNSAMPLED_QUOTA_ROWS) {
    throw new TypeError("v1 finish quota bound invalid");
  }
  const required = options.preparedEvidence
    ? v1PreparedFinishQueryReserve(options.preparedEvidence, options.maxWindowedUsageRows, scalarRequested)
    : v1QuotaFinishQueryReserve(options.maxWindowedUsageRows);
  const now = (budget.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new TypeError("v1 finish budget clock invalid");
  if (budget.remainingQueries < required || now >= budget.deadlineMs) return false;
  budget.remainingQueries -= required;
  return true;
}

function requireAcquiredQuotaEvidence(evidence: unknown): void {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)
      || Object.keys(evidence).length !== 2 || !Object.hasOwn(evidence, "identity")
      || !Object.hasOwn(evidence, "acquisition")) throw new Error("v1 acquired quota evidence required");
  for (const key of ["identity", "acquisition"]) {
    const value: unknown = Reflect.get(evidence, key);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("v1 acquired quota evidence required");
    }
  }
}

async function validateAcquiredQuotaEvidence(
  db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  sourcePin: V1SourcePin, observedAtCutoff: string, resetsAtCutoff: string, maxQuotaRows: number,
  history?: ModelHistoryWindow,
): Promise<{ attributionIndex: PlanAttributionIndex; results: DownsampledQuotaRow[] }> {
  const identity = evidence.identity;
  if (!identity || identity.participantId !== participantId
      || identity.inputFingerprint !== sourcePin.fingerprint
      || identity.sourceMethodVersion !== (history ? MODEL_HISTORY_METHOD_VERSION : V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION)
      || identity.observedAtCutoff !== observedAtCutoff || identity.resetsAtCutoff !== resetsAtCutoff
      || identity.windowMinutes !== SEVEN_DAY_WINDOW_MINUTES || identity.maxQuotaRows !== maxQuotaRows
      || !validateV1CompletedQuotaAcquisition(evidence.acquisition)
      || evidence.acquisition.quotaRows.length > maxQuotaRows) {
    throw new Error("v1 acquired quota evidence mismatch");
  }
  if (history) {
    const lower = Date.parse(history.observedAtCutoff), upper = Date.parse(history.observedAtBefore);
    if (evidence.acquisition.planAnchors.some(row => row.observedAtMs < lower || row.observedAtMs >= upper)
      || evidence.acquisition.quotaRows.some(row => Date.parse(row.observed_at) < lower || Date.parse(row.observed_at) >= upper)) {
      throw new Error("v1 historical evidence outside day range");
    }
  }
  // Check before doing expensive fitting, not only after it. A stored payload
  // with a valid shape is never proof that its source is still current.
  await assertV1SourcePinCurrent(db, sourcePin);
  return { attributionIndex: buildPlanAttributionIndex(evidence.acquisition.planAnchors),
    results: evidence.acquisition.quotaRows };
}

/** Explicit acquired-input path; never falls back to the unbounded quota SQL.
 * The caller must load/verify a complete durable acquisition
 * and positively source-fence the eventual cache promotion.
 */
export async function finishAccountScopedQuotaAnalysisV1(
  db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  budget: V1QuotaInvocationBudget, options: V1AnalysisOptions & { sourcePin: V1SourcePin },
): Promise<{ status: "deferred" } | { status: "complete"; analysis: object }> {
  requireAcquiredQuotaEvidence(evidence);
  if (!options.sourcePin) throw new Error("v1 acquired finish requires source pin");
  if (!reserveV1QuotaFinish(budget, options)) return { status: "deferred" };
  const result = await finishAcquiredAnalyses(db, participantId, evidence, options, true, false);
  return { status: "complete", analysis: result.quotaAnalysis };
}

export async function finishAccountScopedModelCompositionV1(
  db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  budget: V1QuotaInvocationBudget, options: V1AnalysisOptions & { sourcePin: V1SourcePin },
): Promise<{ status: "deferred" } | { status: "complete"; analysis: V1ModelCompositionResult }> {
  requireAcquiredQuotaEvidence(evidence);
  if (!options.sourcePin) throw new Error("v1 acquired finish requires source pin");
  if (!reserveV1QuotaFinish(budget, options, false)) return { status: "deferred" };
  const result = await finishAcquiredAnalyses(db, participantId, evidence, options, false, true);
  return { status: "complete", analysis: result.modelComposition };
}

/** Retrospective, date-specific model fit. It requires its own closed source
 * range and acquired checkpoint; today-only evidence cannot enter this path. */
export async function finishHistoricalModelCompositionV1(
  db: D1Database, participantId: string, day: string, evidence: V1AcquiredQuotaEvidence,
  budget: V1QuotaInvocationBudget, options: Omit<V1AnalysisOptions, "nowMs"> & { sourcePin: V1SourcePin },
): Promise<{ status: "deferred" } | { status: "complete"; analysis: V1ModelCompositionResult }> {
  const history = modelHistoryWindow(day);
  requireAcquiredQuotaEvidence(evidence);
  if (!options.sourcePin) throw new Error("v1 historical finish requires source pin");
  if (!reserveV1QuotaFinish(budget, options, false)) return { status: "deferred" };
  const result = await finishAcquiredAnalyses(db, participantId, evidence,
    { ...options, nowMs: Date.parse(history.fixedNow) }, false, true, history);
  return { status: "complete", analysis: result.modelComposition };
}

/** One acquired corpus, one admitted usage scan and one server-pricing pass.
 * The existing 407-query default reserve covers BOTH results; the caller owns
 * checkpoint/cache promotion and the invocation-wide database statement meter.
 * Evidence is borrowed, never mutated. Release acquisition indexes/checkpoints
 * before calling: completed normalized evidence is the sole retained input.
 */
export async function finishAccountScopedAnalysesV1(
  db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  budget: V1QuotaInvocationBudget, options: V1AnalysisOptions & { sourcePin: V1SourcePin },
): Promise<{ status: "deferred" } | { status: "complete"; quotaAnalysis: object; modelComposition: V1ModelCompositionResult }> {
  requireAcquiredQuotaEvidence(evidence);
  if (!options.sourcePin) throw new Error("v1 acquired finish requires source pin");
  if (!reserveV1QuotaFinish(budget, options)) return { status: "deferred" };
  return { status: "complete", ...await finishAcquiredAnalyses(db, participantId, evidence, options, true, true) };
}

function notTestable(reason: string): object {
  return {
    schemaVersion: "account-scoped-quota-analysis-v0.1",
    status: "not_testable",
    reason,
    tracks: [],
  };
}

function seedKey(row: TrackSeed): string {
  return JSON.stringify([
    row.accountTrackId,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.windowDurationMinutes,
    row.policyEpoch,
    row.planEraKey,
  ]);
}

function usageTrackEpochKey(
  accountTrackId: string,
  provider: string,
  policyEpoch: string,
): string {
  return JSON.stringify([accountTrackId, provider, policyEpoch]);
}

/**
 * Build a TelemetryUsageEvent-shaped object for `priceTelemetryUsageEvent` from
 * a stored v1 usage record. The six v1 component keys map 1:1; the two
 * anthropic-only cache-write split keys the v0.1 pricing shape carries remain
 * unknown unless aggregate writes are explicitly zero. `modelRecognition` is 'recognized' and
 * `modelFingerprint` null — the v1 record has neither; everything the pricer
 * reads (provider, model, billing surface, service tier, speed mode, event
 * time, total input context, components) comes straight from the record.
 */
function buildPricingEvent(
  rec: Record<string, unknown>,
  observedAt: string,
): TelemetryUsageEvent | null {
  const components = rec.components;
  if (components === null
      || typeof components !== "object"
      || Array.isArray(components)) {
    return null;
  }
  const c = components as Record<string, unknown>;
  const inputUncachedTokens = c.inputUncachedTokens ?? null;
  const inputCacheReadTokens = c.inputCacheReadTokens ?? null;
  const inputCacheWriteTokens = c.inputCacheWriteTokens ?? null;
  const outputTextTokens = c.outputTextTokens ?? null;
  const outputReasoningTokens = c.outputReasoningTokens ?? null;
  const outputCombinedTokens = c.outputCombinedTokens ?? null;
  // A record with no token observations at all carries no measurable usage.
  // Drop it (DROP semantics) rather than emit a shapeable-but-unpriceable event:
  // that event would price as component_observation_unavailable and refuse the
  // whole reset (quota-tracks incomplete_server_pricing) for zero cost lost.
  if (inputUncachedTokens === null && inputCacheReadTokens === null
      && inputCacheWriteTokens === null && outputTextTokens === null
      && outputReasoningTokens === null && outputCombinedTokens === null) {
    return null;
  }
  // A supplied context is authoritative. Older v1 records often omit it, so
  // derive only from three known input components; a partial sum is merely a
  // lower bound and must not select a guessed short-context price band.
  const inputComponents = [inputUncachedTokens, inputCacheReadTokens, inputCacheWriteTokens];
  const knownInputComponents = inputComponents.every(value =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const inputSum = knownInputComponents
    ? (inputComponents as number[]).reduce((sum, value) => sum + value, 0)
    : null;
  const derivedInputContext = inputSum !== null && Number.isSafeInteger(inputSum) ? inputSum : null;
  const suppliedContext = rec.totalInputContextTokens;
  const totalInputContextTokens =
    typeof suppliedContext === "number" && Number.isSafeInteger(suppliedContext) && suppliedContext >= 0
      ? suppliedContext
      : derivedInputContext;
  // Nonnegative TTL buckets must both be zero when their aggregate is known
  // zero. Positive/unknown aggregate writes still cannot invent a TTL split.
  const cacheWriteTtlTokens = rec.provider === "anthropic_claude_code" && inputCacheWriteTokens === 0 ? 0 : null;
  const event = {
    schemaVersion: "usage-event-v0.1",
    eventTime: observedAt,
    provider: rec.provider,
    modelId: rec.modelId,
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: rec.billingSurface,
    speedMode: rec.speedMode,
    apiServiceTier: rec.apiServiceTier,
    reasoningEffort: rec.reasoningEffort,
    components: {
      inputUncachedTokens,
      inputCacheReadTokens,
      inputCacheWriteTokens,
      inputCacheWrite5mTokens: cacheWriteTtlTokens,
      inputCacheWrite1hTokens: cacheWriteTtlTokens,
      outputTextTokens,
      outputReasoningTokens,
      outputCombinedTokens,
    },
    totalInputContextTokens,
  };
  return event as unknown as TelemetryUsageEvent;
}

/**
 * Reprice a single stored v1 usage record from tokens with the shared server
 * pricer. Returns null for records the pricer cannot even shape (DROP
 * semantics); a record it can shape but not fully price returns its
 * (0-cost, partially_priced/unpriced) result so the reset correctly refuses.
 */
export function priceChunkUsageRecord(
  recordJson: string,
  observedAt: string,
): { costNanousd: number; pricingStatus: PricingStatus; modelId: string | null } | null {
  const rec = parseStoredRecordJson(recordJson);
  if (rec === null) return null;
  const pricingEvent = buildPricingEvent(rec, observedAt);
  if (pricingEvent === null) return null;
  const priced = priceTelemetryUsageEvent(pricingEvent);
  return {
    costNanousd: priced.costNanousd,
    pricingStatus: priced.coverageStatus as PricingStatus,
    modelId: typeof rec.modelId === "string" && SAFE_TOKEN.test(rec.modelId)
      ? rec.modelId
      : null,
  };
}

/**
 * Row-level domain prefilter (v0.2-ingest DROP semantics) + synthesis of one
 * QuotaSnapshotInput. Skips any row outside the shared validators' domain rather
 * than letting it throw. Left in JS (not SQL) deliberately: the Date.parse and
 * SAFE_TOKEN / slot-domain checks avoid ISO-format and collation assumptions in
 * SQLite. Returns null for a dropped row.
 */
async function buildQuotaSnapshotInput(
  row: RawQuotaRow,
  accountTrackId: string,
  datasetId: string,
): Promise<QuotaSnapshotInput | null> {
  if (!validQuotaSnapshotRow(row)) return null;
  const snapshotId = `q:v1:${await sha256Hex(row.occurrence_id)}`;
  return {
    snapshotId,
    datasetId,
    accountTrackId,
    provider: row.provider,
    planType: row.plan_type!,
    planVariant: row.plan_variant!,
    limitId: row.limit_id!,
    slot: row.slot as QuotaSlot,
    windowDurationMinutes: row.window_duration_minutes as QuotaWindowDurationMinutes,
    resetsAt: row.resets_at!,
    observedAt: row.observed_at!,
    receivedAt: row.observed_at!,
    usedPercent: row.used_percent!,
    displayPrecision: 0,
    policyEpoch: V1_POLICY_EPOCH,
  };
}

function validQuotaSnapshotRow(row: RawQuotaRow): boolean {
  if (row.slot === null || !SLOT_VALUES.has(row.slot)) return false;
  if (row.resets_at === null || row.observed_at === null) return false;
  if (Date.parse(row.resets_at) <= Date.parse(row.observed_at)) return false;
  if (row.used_percent === null
      || !Number.isFinite(row.used_percent)
      || row.used_percent < 0
      || row.used_percent > 100) return false;
  if (row.plan_type === null
      || row.plan_variant === null
      || row.limit_id === null) return false;
  if (!SAFE_TOKEN.test(row.provider)
      || !SAFE_TOKEN.test(row.plan_type)
      || !SAFE_TOKEN.test(row.plan_variant)
      || !SAFE_TOKEN.test(row.limit_id)
      || !SAFE_TOKEN.test(row.slot)) return false;
  // A quota snapshot needs a window; a missing one can neither seed nor bucket
  // (matching the v0.2 path, where a null window drops out).
  return row.window_duration_minutes !== null;
}

async function v1DatasetId(participantId: string): Promise<string> {
  return `dataset:v1:${await sha256Hex(participantId)}`;
}

async function v1AccountTrackId(
  participantId: string,
  provider: string,
): Promise<string> {
  return `account-track:v1:${await sha256Hex(`${participantId}|${provider}`)}`;
}

const WINNER_FILTER_SQL = V1_WINNER_FILTER_SQL;

// All admitted Codex-family quota evidence, before duration, reset, span, and
// fitability gates. Distinct equal-time contradictory labels BOTH survive.
// Adjacent equal-plan runs need only their first/last anchors for the index.
const PLAN_EVIDENCE_SQL = `WITH plan_times AS MATERIALIZED (
  SELECT DISTINCT r.observed_at, r.provider, r.limit_id,
    COALESCE(r.plan_type, 'unknown') AS plan_type,
    COALESCE(r.plan_variant, 'unknown') AS plan_variant
  FROM telemetry_v1_records r
  JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
  WHERE ${WINNER_FILTER_SQL} AND r.participant_id = ?
    AND r.stream = 'quota' AND r.observed_at >= ? AND r.limit_id = 'codex'
), marked AS (
  SELECT *, LAG(plan_type || '|' || plan_variant) OVER win AS prior_plan,
    LEAD(plan_type || '|' || plan_variant) OVER win AS next_plan
  FROM plan_times
  WINDOW win AS (PARTITION BY provider, limit_id ORDER BY observed_at, plan_type, plan_variant)
)
SELECT observed_at, provider, limit_id, plan_type, plan_variant FROM marked
WHERE prior_plan IS NULL OR next_plan IS NULL
  OR plan_type || '|' || plan_variant <> prior_plan
  OR plan_type || '|' || plan_variant <> next_plan
ORDER BY provider, limit_id, observed_at, plan_type, plan_variant LIMIT ?`;

function planObservation(row: PlanEvidenceRow): PlanAttributionObservation | null {
  if (!SAFE_TOKEN.test(row.provider) || !SAFE_TOKEN.test(row.limit_id)) return null;
  return {
    contextKey: planAttributionContextKey(row.provider, row.limit_id),
    observedAtMs: Date.parse(row.observed_at),
    planType: row.plan_type, planVariant: row.plan_variant ?? "unknown",
    // v1 does not carry comparable account evidence. Keep this honest lane.
    accountScopeId: null,
  };
}

async function loadPlanAttributionIndex(
  db: D1Database, participantId: string, winnersJson: string, observedAtCutoff: string,
): Promise<PlanAttributionIndex | null> {
  const result = await db.prepare(PLAN_EVIDENCE_SQL)
    .bind(winnersJson, participantId, observedAtCutoff, MAX_PLAN_ATTRIBUTION_ROWS + 1)
    .all<PlanEvidenceRow>();
  if (result.results.length > MAX_PLAN_ATTRIBUTION_ROWS) return null;
  const index = buildPlanAttributionIndex(result.results.map(planObservation));
  return index.status === "ready" ? index : null;
}

function eraMarkersJson(index: PlanAttributionIndex): string {
  return JSON.stringify(index.eras.map((era, ordinal) => {
    const [provider, limitId] = era.contextKey.split("|");
    return [provider, limitId, era.planType, era.planVariant, era.eraKey,
      era.lowerBoundMs === null ? "" : new Date(era.lowerBoundMs).toISOString(),
      era.upperBoundMs === null ? null : new Date(era.upperBoundMs).toISOString(), ordinal + 1];
  }));
}

function attributeSnapshot(
  snapshot: QuotaSnapshotInput, index: PlanAttributionIndex,
): AttributedQuotaSnapshot | null {
  const match = planEraForInterval(index, {
    contextKey: planAttributionContextKey(snapshot.provider, snapshot.limitId),
    observedAtMs: Date.parse(snapshot.observedAt),
  });
  return match.status === "matched" && match.era.planType === snapshot.planType
      && match.era.planVariant === snapshot.planVariant
    ? { ...snapshot, planEraKey: match.era.eraKey } : null;
}

/**
 * Windowed run-endpoint quota downsample.
 *
 * Windowing is snapped to whole reset cycles: `observed_at >= :cutoff` bounds
 * the index range scan, and `resets_at >= :resetsAtCutoff` (cutoff + one weekly
 * window) includes a reset only when its ENTIRE first..last series is within the
 * window, so a cycle straddling the cutoff is excluded wholesale rather than
 * read partially and mis-fit. The fitable HAVING drops reset groups the shared
 * calibration always refuses; the LAG/LEAD collapse keeps every row that differs
 * from its predecessor OR successor — the first and last row of every flat
 * used_percent run — because a boundary anchors lowerCost on the last row of the
 * preceding run and upperCost on the first row of the new run. The partition
 * INCLUDES slot (an eligible multi-slot reset has time-disjoint slots); the
 * fitable GROUP BY EXCLUDES slot (= the shared resetKey).
 */
// Binds (in order): era markers JSON, winnersJson, participantId, observedAt cutoff, resetsAt
// cutoff, window minutes, minimum boundaries, minimum span, row limit. Anonymous
// `?` because the leading json_each winner filter binds one parameter and fixed
// numbering across the CTE chain buys nothing. `scoped` is MATERIALIZED so its
// winner-filtered index scan runs once rather than being re-evaluated by both
// `fitable` and `survivors`.
export const QUOTA_DOWNSAMPLE_SQL = `WITH era_markers AS MATERIALIZED (
    SELECT json_extract(e.value, '$[0]') AS provider,
      json_extract(e.value, '$[1]') AS limit_id,
      json_extract(e.value, '$[2]') AS plan_type,
      json_extract(e.value, '$[3]') AS plan_variant,
      json_extract(e.value, '$[4]') AS plan_era_key,
      json_extract(e.value, '$[5]') AS lower_bound,
      json_extract(e.value, '$[6]') AS upper_bound,
      json_extract(e.value, '$[7]') AS era_ordinal
    FROM json_each(?) e
  ), raw_scoped AS MATERIALIZED (
    SELECT r.occurrence_id AS occurrence_id,
           r.observed_at AS observed_at,
           r.provider AS provider,
           r.plan_type AS plan_type,
           r.plan_variant AS plan_variant,
           r.limit_id AS limit_id,
           r.slot AS slot,
           r.used_percent AS used_percent,
           r.window_duration_minutes AS window_duration_minutes,
           r.resets_at AS resets_at,
           r.id AS id
      FROM telemetry_v1_records r
      JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
     WHERE ${WINNER_FILTER_SQL}
       AND r.participant_id = ?
       AND r.stream = 'quota'
       AND r.observed_at >= ?
       AND r.resets_at >= ?
       AND r.limit_id = 'codex'
       AND r.window_duration_minutes = ?
       AND r.resets_at IS NOT NULL
       AND r.slot IS NOT NULL
       AND r.used_percent IS NOT NULL
       AND r.plan_type IS NOT NULL
       AND r.plan_variant IS NOT NULL
  ),
  marker_stream AS (
    SELECT r.*, 0 AS is_marker, 0 AS era_ordinal FROM raw_scoped r
    UNION ALL
    SELECT NULL AS occurrence_id, e.lower_bound AS observed_at, e.provider,
      e.plan_type, e.plan_variant, e.limit_id, NULL AS slot,
      NULL AS used_percent, NULL AS window_duration_minutes, NULL AS resets_at,
      0 AS id, 1 AS is_marker, e.era_ordinal
      FROM era_markers e
  ), assigned AS (
    SELECT *, MAX(era_ordinal) OVER (
      PARTITION BY provider, limit_id ORDER BY observed_at, is_marker DESC, id
      ROWS UNBOUNDED PRECEDING
    ) AS assigned_era FROM marker_stream
  ), scoped AS MATERIALIZED (
    SELECT a.*, e.plan_era_key
    FROM assigned a JOIN era_markers e ON e.era_ordinal = a.assigned_era
    WHERE a.is_marker = 0 AND a.plan_type = e.plan_type
      AND a.plan_variant = e.plan_variant AND a.observed_at >= e.lower_bound
      AND (e.upper_bound IS NULL OR a.observed_at <= e.upper_bound)
  ), fragment_stats AS (
    SELECT provider, plan_type, plan_variant, limit_id,
           window_duration_minutes, resets_at, plan_era_key,
           COUNT(DISTINCT used_percent) AS boundary_count,
           MAX(used_percent) - MIN(used_percent) AS displayed_span,
           MAX(observed_at) AS last_observed_at
      FROM scoped
     GROUP BY provider, plan_type, plan_variant, limit_id,
              window_duration_minutes, resets_at, plan_era_key
  ), fitable AS (
    SELECT * FROM fragment_stats WHERE boundary_count >= ? AND displayed_span >= ?
  ),
  survivors AS (
    SELECT s.*
      FROM scoped s
      JOIN fitable f
        ON f.provider = s.provider
       AND f.plan_type = s.plan_type
       AND f.plan_variant = s.plan_variant
       AND f.limit_id = s.limit_id
       AND f.window_duration_minutes = s.window_duration_minutes
       AND f.resets_at = s.resets_at
       AND f.plan_era_key = s.plan_era_key
  ),
  marked AS (
    SELECT survivors.*,
           LAG(used_percent) OVER win AS prev_up,
           LEAD(used_percent) OVER win AS next_up
      FROM survivors
    WINDOW win AS (
      PARTITION BY provider, plan_type, plan_variant, limit_id,
                   window_duration_minutes, resets_at, slot, plan_era_key
      ORDER BY observed_at, id
    )
  )
  SELECT occurrence_id, observed_at, provider, plan_type, plan_variant,
         limit_id, slot, used_percent, window_duration_minutes, resets_at, plan_era_key
    FROM marked
   WHERE prev_up IS NULL
      OR next_up IS NULL
      OR used_percent <> prev_up
      OR used_percent <> next_up
   ORDER BY observed_at, id
   LIMIT ?`;

// The already-deployed 0036 index has implicit rowid (= id) as its last key.
// D1 does not seek that suffix through a row-value (time,id) predicate, but
// DOES seek it after three explicit equalities. Drain the current timestamp
// first, then advance time. Neither seek rescans the original window prefix
// or sorts a potentially unbounded equal-time run. INDEXED BY makes the
// required bounded access path explicit even where a newer index is present.
const V1_USAGE_PAGE_SELECT_SQL = `
  SELECT r.id AS id, r.occurrence_id AS occurrence_id,
         r.observed_at AS observed_at, r.provider AS provider,
         r.session_uuid AS session_uuid, r.record_json AS record_json
    FROM telemetry_v1_records r INDEXED BY telemetry_v1_records_participant_stream_observed
    JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
   WHERE ${WINNER_FILTER_SQL}
     AND r.participant_id = ?
     AND r.stream = 'usage'`;

// Binds: winnersJson, participantId, cursor time, cursor id, page size.
export const V1_USAGE_PAGE_AT_TIME_SQL = `${V1_USAGE_PAGE_SELECT_SQL}
     AND r.observed_at = ? AND r.id > ?
   ORDER BY r.id
   LIMIT ?`;

// Binds: winnersJson, participantId, cursor time, remaining page size.
export const V1_USAGE_PAGE_AFTER_TIME_SQL = `${V1_USAGE_PAGE_SELECT_SQL}
     AND r.observed_at > ?
   ORDER BY r.observed_at, r.id
   LIMIT ?`;

export const V1_HISTORY_USAGE_PAGE_AT_TIME_SQL = `${V1_USAGE_PAGE_SELECT_SQL}
     AND r.observed_at = ? AND r.id > ? AND r.observed_at < ?
   ORDER BY r.id LIMIT ?`;
export const V1_HISTORY_USAGE_PAGE_AFTER_TIME_SQL = `${V1_USAGE_PAGE_SELECT_SQL}
     AND r.observed_at > ? AND r.observed_at < ?
   ORDER BY r.observed_at, r.id LIMIT ?`;

/** Shared page/cursor contract for both scalar and model-composition readers. */
export async function readV1UsagePage(
  db: D1Database, winnersJson: string, participantId: string,
  cursorObservedAt: string, cursorId: number, pageSize: number,
  observedAtBefore?: string,
): Promise<WindowedUsageRow[]> {
  if (observedAtBefore !== undefined) {
    const sameTime = await db.prepare(V1_HISTORY_USAGE_PAGE_AT_TIME_SQL)
      .bind(winnersJson, participantId, cursorObservedAt, cursorId, observedAtBefore, pageSize).all<WindowedUsageRow>();
    if (sameTime.results.length === pageSize) return sameTime.results;
    const later = await db.prepare(V1_HISTORY_USAGE_PAGE_AFTER_TIME_SQL)
      .bind(winnersJson, participantId, cursorObservedAt, observedAtBefore, pageSize - sameTime.results.length).all<WindowedUsageRow>();
    return sameTime.results.concat(later.results);
  }
  const sameTime = await db.prepare(V1_USAGE_PAGE_AT_TIME_SQL)
    .bind(winnersJson, participantId, cursorObservedAt, cursorId, pageSize)
    .all<WindowedUsageRow>();
  if (sameTime.results.length === pageSize) return sameTime.results;
  const later = await db.prepare(V1_USAGE_PAGE_AFTER_TIME_SQL)
    .bind(winnersJson, participantId, cursorObservedAt, pageSize - sameTime.results.length)
    .all<WindowedUsageRow>();
  return sameTime.results.concat(later.results);
}

interface ProviderGrid {
  sortedMs: number[];
  set: Set<number>;
}

/**
 * The retained quota observed_at grid, per provider (equivalently per account
 * track). Every boundary anchor of every retained reset of a provider is one of
 * these instants, so usage summed between consecutive grid points is invisible
 * to `cumulativeCostAt`.
 */
function buildGridByProvider(
  quotaSnapshots: QuotaSnapshotInput[],
): Map<string, ProviderGrid> {
  const msByProvider = new Map<string, Set<number>>();
  for (const snapshot of quotaSnapshots) {
    const ms = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(ms)) continue;
    const bucket = msByProvider.get(snapshot.provider) ?? new Set<number>();
    bucket.add(ms);
    msByProvider.set(snapshot.provider, bucket);
  }
  const grids = new Map<string, ProviderGrid>();
  for (const [provider, set] of msByProvider) {
    grids.set(provider, {
      sortedMs: [...set].sort((left, right) => left - right),
      set,
    });
  }
  return grids;
}

/** Smallest grid instant strictly greater than `value` (the ceiling bucket). */
function ceilingGrid(sortedMs: number[], value: number): number | null {
  let low = 0;
  let high = sortedMs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedMs[mid]! <= value) low = mid + 1;
    else high = mid;
  }
  return low < sortedMs.length ? sortedMs[low]! : null;
}

interface BucketAccumulator {
  costNanousd: number;
  allFullyPriced: boolean;
  placementMs: number;
}

/** Exact session dictionary: hashes choose a slot, full identifiers decide
 * equality. Fixed-size typed storage bounds maximum-length admitted identities
 * and pending ties without 100k duplicate strings/objects. The fallback keeps
 * legacy malformed stored strings behavior; admission normally excludes it.
 */
function createUsageSessionState() {
  const WIDTH = 128, SLOTS = 262_144, ASCII_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
  const providerIds = new Map<string, number>(), providers: string[] = [];
  const fallbackSessions = new Map<string, number>(), fallbackOccurrences = new Map<number, string>();
  const PENDING_BLOCK_SIZE = 1024;
  interface PendingBlock {
    sessions: Uint32Array; previous: Float64Array; costs: Float64Array;
    flags: Uint8Array; occurrences: Uint8Array; occurrenceLengths: Uint8Array;
  }
  const pendingBlocks: PendingBlock[] = [];
  let count = 0, pendingCount = 0;
  let slots = new Uint32Array(0), names = new Uint8Array(0), lengths = new Uint8Array(0);
  let providerBySession = new Uint32Array(0), times = new Float64Array(0);
  let pendingBySession = new Uint32Array(0);
  const pendingLocation = (index: number) => {
    const ordinal = pendingBySession[index]! - 1;
    return { block: pendingBlocks[Math.floor(ordinal / PENDING_BLOCK_SIZE)]!, offset: ordinal % PENDING_BLOCK_SIZE };
  };
  const ensureClocks = () => {
    if (slots.length) return;
    slots = new Uint32Array(SLOTS); names = new Uint8Array(MAX_SESSION_INTERVAL_SCOPES * WIDTH);
    lengths = new Uint8Array(MAX_SESSION_INTERVAL_SCOPES); providerBySession = new Uint32Array(MAX_SESSION_INTERVAL_SCOPES);
    times = new Float64Array(MAX_SESSION_INTERVAL_SCOPES);
  };
  const write = (target: Uint8Array, index: number, value: string) => {
    for (let i = 0; i < value.length; i++) target[index * WIDTH + i] = value.charCodeAt(i);
  };
  const compare = (target: Uint8Array, index: number, length: number, value: string) => {
    for (let i = 0; i < Math.min(length, value.length); i++) {
      const difference = value.charCodeAt(i) - target[index * WIDTH + i]!;
      if (difference) return difference;
    }
    return value.length - length;
  };
  return {
    find(provider: string, session: string): number {
      ensureClocks();
      let providerId = providerIds.get(provider);
      if (providerId === undefined) { providerId = providers.length; providers.push(provider); providerIds.set(provider, providerId); }
      let slot = -1, fallbackKey: string | null = null;
      if (ASCII_ID.test(session)) {
        let hash = Math.imul(2166136261 ^ providerId, 16777619);
        for (let i = 0; i < session.length; i++) hash = Math.imul(hash ^ session.charCodeAt(i), 16777619);
        slot = (hash >>> 0) & (SLOTS - 1);
        while (slots[slot]) {
          const index = slots[slot]! - 1;
          if (providerBySession[index] === providerId && compare(names, index, lengths[index]!, session) === 0) return index;
          slot = (slot + 1) & (SLOTS - 1);
        }
      } else {
        fallbackKey = JSON.stringify([provider, session]);
        const existing = fallbackSessions.get(fallbackKey);
        if (existing !== undefined) return existing;
      }
      if (count === MAX_SESSION_INTERVAL_SCOPES) return -1;
      const index = count++;
      providerBySession[index] = providerId; times[index] = NaN;
      if (fallbackKey === null) { slots[slot] = index + 1; lengths[index] = session.length; write(names, index, session); }
      else fallbackSessions.set(fallbackKey, index);
      return index;
    },
    time(index: number): number | undefined { return Number.isNaN(times[index]) ? undefined : times[index]; },
    setTime(index: number, value: number) { times[index] = value; },
    hasPending(index: number) { return Boolean(pendingBySession[index]); },
    earlier(index: number, occurrence: string) {
      const fallback = fallbackOccurrences.get(index);
      if (fallback !== undefined) return occurrence < fallback;
      const { block, offset } = pendingLocation(index);
      return compare(block.occurrences, offset, block.occurrenceLengths[offset]!, occurrence) < 0;
    },
    save(index: number, occurrence: string, priced: ReturnType<typeof priceChunkUsageRecord>, intervalStart?: number) {
      if (!pendingBySession.length) pendingBySession = new Uint32Array(MAX_SESSION_INTERVAL_SCOPES);
      if (!pendingBySession[index]) {
        // Only active elections occupy storage. A single ambiguous session
        // must not allocate 100k maximum-length occurrence identities.
        const ordinal = pendingCount++, blockIndex = Math.floor(ordinal / PENDING_BLOCK_SIZE);
        if (!pendingBlocks[blockIndex]) {
          const length = Math.min(PENDING_BLOCK_SIZE, MAX_SESSION_INTERVAL_SCOPES - blockIndex * PENDING_BLOCK_SIZE);
          pendingBlocks.push({ sessions: new Uint32Array(length), previous: new Float64Array(length),
            costs: new Float64Array(length), flags: new Uint8Array(length),
            occurrences: new Uint8Array(length * WIDTH), occurrenceLengths: new Uint8Array(length) });
        }
        pendingBySession[index] = ordinal + 1;
        const { block, offset } = pendingLocation(index);
        block.sessions[offset] = index; block.previous[offset] = intervalStart ?? NaN;
      }
      const { block, offset } = pendingLocation(index);
      block.flags[offset] = priced === null ? 1 : priced.pricingStatus === "fully_priced" ? 2 : 3;
      block.costs[offset] = priced?.costNanousd ?? 0;
      if (ASCII_ID.test(occurrence)) {
        fallbackOccurrences.delete(index); block.occurrenceLengths[offset] = occurrence.length; write(block.occurrences, offset, occurrence);
      } else fallbackOccurrences.set(index, occurrence);
    },
    point(index: number) {
      const { block, offset } = pendingLocation(index);
      return { provider: providers[providerBySession[index]!]!, observedAtMs: times[index]!,
        priced: block.flags[offset] === 1 ? null : { costNanousd: block.costs[offset]!,
          pricingStatus: block.flags[offset] === 2 ? "fully_priced" as const : "partially_priced" as const, modelId: null } };
    },
    flush(consume: (point: { provider: string; observedAtMs: number; priced: ReturnType<typeof priceChunkUsageRecord> }, start: number | undefined) => void) {
      for (let i = 0; i < pendingCount; i++) {
        const block = pendingBlocks[Math.floor(i / PENDING_BLOCK_SIZE)]!, offset = i % PENDING_BLOCK_SIZE;
        const index = block.sessions[offset]!;
        consume(this.point(index), Number.isNaN(block.previous[offset]) ? undefined : block.previous[offset]);
        pendingBySession[index] = 0;
      }
      pendingCount = 0; fallbackOccurrences.clear();
    },
    clear() {
      providerIds.clear(); providers.length = 0; fallbackSessions.clear(); fallbackOccurrences.clear();
      count = pendingCount = 0;
      pendingBlocks.length = 0;
      slots = providerBySession = pendingBySession = new Uint32Array(0);
      names = lengths = new Uint8Array(0);
      times = new Float64Array(0);
    },
  };
}

/**
 * Stream the windowed usage (keyset-paginated), reprice each event, and fold it
 * into synthetic per-bucket rows aligned to the retained quota grid. Returns the
 * literal string "limit_exceeded" when the windowed usage row count passes the
 * cap (never truncate-and-fit).
 */
async function readAndBucketUsage(
  db: D1Database,
  participantId: string,
  datasetId: string,
  observedAtCutoff: string,
  accountTrackByProvider: Map<string, string>,
  gridByProvider: Map<string, ProviderGrid>,
  maxWindowedUsageRows: number,
  winnersJsonArg: string,
  attributionIndex: PlanAttributionIndex,
  composition?: ReturnType<typeof createCompositionUsageAccumulator>,
  scalarEnabled = true,
  observedAtBefore?: string,
  preparedUsage?: V1PreparedUsageReader,
): Promise<AttributedUsageEventPartial[] | "limit_exceeded" | "session_scope_limit_exceeded" | "cost_limit_exceeded"> {
  // Per provider: strictly-interior events keyed by their ceiling grid instant,
  // and grid-exact events kept as their own singleton at that instant (the
  // matchedUsage lower bound is inclusive, so a grid-exact event that equals a
  // reset's firstObserved is in-window while interior events of the same bucket
  // are not — the singleton-split preserves that distinction).
  const buckets = new Map<string, Map<number, BucketAccumulator>>();
  const singletons = new Map<string, Map<number, BucketAccumulator>>();
  const bucketScopes = new Map<string, { provider: string; planEraKey: string | null }>();
  const sessions = createUsageSessionState();
  let scalarFailure: "session_scope_limit_exceeded" | null = null;

  // Physical reads now use id within a timestamp, while the attribution
  // contract uses occurrence order. Only the minimum occurrence for a session
  // can inherit its earlier interval; every other tie has interval [t,t].
  // Retain that one compact candidate, not the raw JSON or the whole tie run.
  // Pending candidates reference the same session indices as the clocks;
  // their union cannot exceed the existing 100k-session cap.
  interface UsagePoint {
    provider: string;
    observedAtMs: number;
    priced: ReturnType<typeof priceChunkUsageRecord>;
  }
  let pendingObservedAt: string | null = null;
  let costLimitExceeded = false;

  const foldPoint = (point: UsagePoint, intervalStartMs: number | undefined): void => {
    const { provider, observedAtMs: eMs, priced } = point;
    if (priced === null) return;
    const grid = gridByProvider.get(provider);
    if (!grid || grid.sortedMs.length === 0 || eMs > grid.sortedMs[grid.sortedMs.length - 1]!) return;
    const match = planEraForInterval(attributionIndex, {
      contextKey: planAttributionContextKey(provider, "codex"), observedAtMs: eMs, intervalStartMs,
    });
    const planEraKey = match.status === "matched" ? match.era.eraKey : null;
    const bucketKey = JSON.stringify([provider, planEraKey]);
    bucketScopes.set(bucketKey, { provider, planEraKey });
    const fullyPriced = priced.pricingStatus === "fully_priced";
    const gridExact = grid.set.has(eMs);
    const placement = gridExact ? eMs : ceilingGrid(grid.sortedMs, eMs);
    if (placement === null) return;
    const target = gridExact ? singletons : buckets;
    const providerBuckets = target.get(bucketKey) ?? new Map<number, BucketAccumulator>();
    const existing = providerBuckets.get(placement);
    const validCost = Number.isSafeInteger(priced.costNanousd) && priced.costNanousd >= 0;
    if (!validCost || priced.costNanousd > MAX_SCALAR_BUCKET_COST_NANOUSD - (existing?.costNanousd ?? 0)) {
      // Partial pricing is not a permission to omit/truncate an overflowing
      // scalar bucket: the kernel validates cost before its pricing refusal.
      costLimitExceeded = true;
      return;
    }
    if (existing) {
      existing.costNanousd += priced.costNanousd;
      existing.allFullyPriced = existing.allFullyPriced && fullyPriced;
      // Keep the latest constituent strictly below its ceiling grid point.
      existing.placementMs = Math.max(existing.placementMs, eMs);
    } else {
      providerBuckets.set(placement, {
        costNanousd: priced.costNanousd, allFullyPriced: fullyPriced, placementMs: eMs,
      });
    }
    target.set(bucketKey, providerBuckets);
  };

  const flushFirst = (): void => {
    sessions.flush(foldPoint);
  };

  let total = 0;
  let cursorObs = observedAtCutoff;
  let cursorId = 0;
  for (;;) {
    const rows = preparedUsage
      ? await preparedUsage.readPage(cursorObs, cursorId, USAGE_PAGE_SIZE, observedAtBefore)
      : await readV1UsagePage(db, winnersJsonArg, participantId, cursorObs, cursorId, USAGE_PAGE_SIZE, observedAtBefore);
    if (rows.length === 0) break;
    total += rows.length;
    if (total > maxWindowedUsageRows) {
      composition?.limitExceeded();
      return scalarFailure ?? "limit_exceeded";
    }
    for (const row of rows) {
      if (!SAFE_TOKEN.test(row.provider)) continue;
      const eMs = Date.parse(row.observed_at);
      if (!Number.isFinite(eMs)) continue;
      const grid = gridByProvider.get(row.provider);
      const scalarPriceNeeded = scalarEnabled && !scalarFailure && grid && grid.sortedMs.length > 0
        && eMs <= grid.sortedMs[grid.sortedMs.length - 1]!;
      const priced = scalarPriceNeeded || composition?.accepts(row.provider)
        ? Object.hasOwn(row, "preparedPrice") ? row.preparedPrice! : priceChunkUsageRecord(row.record_json, row.observed_at) : null;
      composition?.add(row, eMs, priced);
      if (!scalarEnabled || scalarFailure) continue;
      if (pendingObservedAt !== row.observed_at) {
        flushFirst();
        pendingObservedAt = row.observed_at;
      }
      // v1 has no quantity-basis field. A prior usage record in the SAME
      // session gives a conservative interval bound, never account proof.
      const sessionKey = row.session_uuid;
      const sessionIndex = sessionKey === null ? null : sessions.find(row.provider, sessionKey);
      if (sessionIndex === -1) {
        if (!composition) return "session_scope_limit_exceeded";
        scalarFailure = "session_scope_limit_exceeded";
        sessions.clear();
        buckets.clear(); singletons.clear(); bucketScopes.clear();
        continue;
      }
      if (!scalarPriceNeeded) {
        // A timestamp beyond this provider's final grid (or without a grid)
        // cannot contribute under either interval election. Still register
        // every session, enforce its cap, and advance its clock; the prior
        // timestamp's pending candidates were flushed above. In-grid DROP
        // rows do NOT take this shortcut: their occurrence can win a tie.
        if (sessionIndex !== null) sessions.setTime(sessionIndex, eMs);
        continue;
      }
      const point: UsagePoint = { provider: row.provider, observedAtMs: eMs,
        priced: scalarPriceNeeded ? priced : null };
      if (sessionIndex === null) {
        foldPoint(point, undefined);
      } else {
        if (!sessions.hasPending(sessionIndex)) {
          const intervalStartMs = sessions.time(sessionIndex);
          // Includes DROP/grid-ineligible candidates: the original clock
          // advanced before those filters. Null sessions never share a clock.
          sessions.setTime(sessionIndex, eMs);
          // A missing start is the shared kernel's point interval [t,t].
          // No occurrence-order election is needed when both possible intervals
          // have the same era (including the same unresolved disposition).
          const era = (start: number | undefined) => {
            const match = planEraForInterval(attributionIndex, {
              contextKey: planAttributionContextKey(row.provider, "codex"), observedAtMs: eMs, intervalStartMs: start,
            });
            return match.status === "matched" ? match.era.eraKey : null;
          };
          if (intervalStartMs === undefined || intervalStartMs === eMs || era(intervalStartMs) === era(eMs)) {
            foldPoint(point, intervalStartMs);
          } else {
            sessions.save(sessionIndex, row.occurrence_id, point.priced, intervalStartMs);
          }
        } else if (sessions.earlier(sessionIndex, row.occurrence_id)) {
          foldPoint(sessions.point(sessionIndex), eMs);
          sessions.save(sessionIndex, row.occurrence_id, point.priced);
        } else {
          foldPoint(point, eMs);
        }
      }
    }
    if (rows.length < USAGE_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    cursorObs = last.observed_at;
    cursorId = last.id;
  }
  flushFirst();
  sessions.clear();
  if (scalarFailure) return scalarFailure;
  if (costLimitExceeded) return "cost_limit_exceeded";

  const usageEvents: AttributedUsageEventPartial[] = [];
  for (const [bucketKey, { provider, planEraKey }] of bucketScopes) {
    const accountTrackId = accountTrackByProvider.get(provider);
    if (accountTrackId === undefined) continue;
    for (const [gridMs, acc] of singletons.get(bucketKey) ?? []) {
      usageEvents.push(await synthUsageRow(
        accountTrackId, datasetId, provider, acc, `s|${gridMs}|${planEraKey}`, planEraKey,
      ));
    }
    for (const [qcMs, acc] of buckets.get(bucketKey) ?? []) {
      usageEvents.push(await synthUsageRow(
        accountTrackId, datasetId, provider, acc, `b|${qcMs}|${planEraKey}`, planEraKey,
      ));
    }
  }
  return usageEvents;
}

async function synthUsageRow(
  accountTrackId: string,
  datasetId: string,
  provider: string,
  acc: BucketAccumulator,
  anchor: string,
  planEraKey: string | null,
): Promise<AttributedUsageEventPartial> {
  // The eventId is a synthetic OPAQUE_ID over (track|kind|anchor): hundreds of
  // hashes instead of the ~306k per-event hashes the old path computed. The
  // kind prefix (s = grid-exact singleton, b = interior bucket) keeps a
  // singleton and a bucket that share a grid instant distinct.
  const eventId = `u:v1:${await sha256Hex(`${accountTrackId}|${anchor}`)}`;
  return {
    eventId,
    datasetId,
    accountTrackId,
    provider,
    observedAt: new Date(acc.placementMs).toISOString(),
    costNanousd: acc.costNanousd,
    // Sticky AND: fully_priced only if EVERY constituent was, so a bucket that
    // contains any not-fully-priced event still refuses its reset via
    // incomplete_server_pricing.
    pricingStatus: acc.allFullyPriced ? "fully_priced" : "partially_priced",
    policyEpoch: V1_POLICY_EPOCH,
    contextKey: planAttributionContextKey(provider, "codex"),
    planEraKey,
    attribution: planEraKey === null ? "unresolved" : "legacy_conditional",
  };
}

/**
 * The shared seed/bucket/loop: group snapshots into continuity seeds, gate on
 * track count, and run the per-seed shared calibration. Pure and synchronous —
 * both the production reduction path and the test-only full reference feed it.
 */
function runV1SeedLoop(
  datasets: { datasetId: string; complete: boolean }[],
  quotaSnapshots: AttributedQuotaSnapshot[],
  usageEvents: AttributedUsageEventPartial[],
): object {
  const seeds = new Map<string, TrackSeed>();
  for (const snapshot of quotaSnapshots) {
    if (!isSupportedQuotaWindowDuration(snapshot.windowDurationMinutes)) continue;
    const seed: TrackSeed = {
      accountTrackId: snapshot.accountTrackId,
      provider: snapshot.provider,
      planType: snapshot.planType,
      planVariant: snapshot.planVariant,
      limitId: snapshot.limitId,
      windowDurationMinutes: snapshot.windowDurationMinutes,
      policyEpoch: snapshot.policyEpoch,
      planEraKey: snapshot.planEraKey,
    };
    seeds.set(seedKey(seed), seed);
  }
  if (seeds.size === 0) return notTestable("supported_quota_track_unavailable");
  if (seeds.size > MAX_CONTINUITY_TRACKS) {
    return notTestable("continuity_track_limit_exceeded");
  }

  const quotaSnapshotsBySeed = new Map<string, AttributedQuotaSnapshot[]>();
  for (const snapshot of quotaSnapshots) {
    const key = seedKey({
      accountTrackId: snapshot.accountTrackId,
      provider: snapshot.provider,
      planType: snapshot.planType,
      planVariant: snapshot.planVariant,
      limitId: snapshot.limitId,
      windowDurationMinutes: snapshot.windowDurationMinutes,
      policyEpoch: snapshot.policyEpoch,
      planEraKey: snapshot.planEraKey,
    });
    const bucket = quotaSnapshotsBySeed.get(key);
    if (bucket) bucket.push(snapshot);
    else quotaSnapshotsBySeed.set(key, [snapshot]);
  }

  const usageEventsByTrackEpoch = new Map<string, AttributedUsageEventPartial[]>();
  const unresolvedTimesByTrackEpoch = new Map<string, number[]>();
  for (const event of usageEvents) {
    const key = usageTrackEpochKey(
      event.accountTrackId,
      event.provider,
      event.policyEpoch,
    );
    if (event.attribution === "unresolved") {
      const times = unresolvedTimesByTrackEpoch.get(key) ?? [];
      times.push(Date.parse(event.observedAt));
      unresolvedTimesByTrackEpoch.set(key, times);
      continue;
    }
    const bucket = usageEventsByTrackEpoch.get(key);
    if (bucket) bucket.push(event);
    else usageEventsByTrackEpoch.set(key, [event]);
  }
  for (const times of unresolvedTimesByTrackEpoch.values()) times.sort((left, right) => left - right);

  const tracks = [];
  for (const seed of [...seeds.values()].sort((left, right) => (
    seedKey(left).localeCompare(seedKey(right))
  ))) {
    const seedQuotaSnapshots = quotaSnapshotsBySeed.get(seedKey(seed)) ?? [];
    const seedUsageEvents: QuotaUsageEventInput[] = (
      usageEventsByTrackEpoch.get(usageTrackEpochKey(
        seed.accountTrackId,
        seed.provider,
        seed.policyEpoch,
      )) ?? []
    ).filter((partial) => partial.planEraKey === seed.planEraKey).map((partial) => {
      const { contextKey: _context, planEraKey: _era, attribution: _attribution, ...event } = partial;
      return { ...event, planType: seed.planType, planVariant: seed.planVariant, limitId: seed.limitId };
    });
    const evidence = buildResetEvidence({
      datasets,
      quotaSnapshots: seedQuotaSnapshots.map(({ planEraKey: _era, ...snapshot }) => snapshot),
      usageEvents: seedUsageEvents,
    });
    const unresolvedTimes = unresolvedTimesByTrackEpoch.get(usageTrackEpochKey(
      seed.accountTrackId, seed.provider, seed.policyEpoch,
    )) ?? [];
    const refusedResets = evidence.resets.filter((reset) => intervalHasTime(
      unresolvedTimes, Date.parse(reset.firstObservedAt), Date.parse(reset.lastObservedAt),
    ));
    const refusedKeys = new Set(refusedResets.map((reset) => reset.resetKey));
    const coherentResets = evidence.resets.filter((reset) => !refusedKeys.has(reset.resetKey));
    // No partially attributed numerator reaches the calibration kernel. Source
    // rows remain retained; only the affected reset estimate is withheld, with
    // an explicit reason rather than a fabricated zero/price-status failure.
    const calibration = analyzeQuotaCalibration({
      ...evidence, resetCount: coherentResets.length, resets: coherentResets,
    });
    tracks.push({
      continuity: seed, calibration,
      attribution: {
        status: "legacy_conditional", accountScope: "unknown", planEraKey: seed.planEraKey,
        refusedResets: refusedResets.map((reset) => ({
          resetKey: reset.resetKey, reason: "usage_plan_interval_unresolved",
          firstObservedAt: reset.firstObservedAt, lastObservedAt: reset.lastObservedAt,
        })),
      },
    });
  }
  return {
    schemaVersion: "account-scoped-quota-analysis-v0.1",
    status: "ready",
    // These are era-level diagnostics, not independent population votes.
    // The shared collector selects one qualifying reset-parent fragment after
    // its fit and 40pp population gates; it never pools era summaries here.
    fragmentSelection: "unselected_diagnostics",
    tracks,
  };
}

function intervalHasTime(sortedMs: number[], startMs: number, endMs: number): boolean {
  let low = 0;
  let high = sortedMs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedMs[mid]! < startMs) low = mid + 1;
    else high = mid;
  }
  return low < sortedMs.length && sortedMs[low]! <= endMs;
}

async function assertNoActiveV11Source(db: D1Database, participantId: string): Promise<void> {
  const successor = await db.prepare(
    "SELECT 1 AS present FROM telemetry_v11_domain_heads WHERE participant_id = ? LIMIT 1",
  ).bind(participantId).first<{ present: number }>();
  if (successor !== null) throw new Error("v1 analysis unavailable after v1.1 activation");
}

async function analysisSourcePin(
  db: D1Database, participantId: string, observedAtCutoff: string, supplied?: V1SourcePin,
  history?: ModelHistoryWindow,
): Promise<V1SourcePin> {
  let sourcePin: V1SourcePin;
  if (supplied) {
    if (!("participantId" in supplied.scope) || supplied.scope.participantId !== participantId
        || (supplied.scope.fromDay !== undefined && supplied.scope.fromDay > observedAtCutoff.slice(0, 10))
        || supplied.scope.throughDay !== history?.day
        || (history && supplied.scope.fromDay !== history.fromDay)
        || supplied.methodVersion !== V1_SOURCE_SELECTION_METHOD_VERSION) {
      throw new Error("v1 source pin scope mismatch");
    }
    sourcePin = supplied;
  } else {
    sourcePin = await loadV1SourcePin(db, {
      participantId, fromDay: observedAtCutoff.slice(0, 10),
    });
  }
  // loadV1SourcePin deliberately serves every active analytical transport so
  // daily consumers can share one winner policy. This adapter, however, reads
  // the retained telemetry_v1_records table directly. Never label those old
  // rows with a successor pin after the atomic v1.1 source cutover.
  // Check AFTER acquiring the pin: activation before this check is refused;
  // activation after it changes the fingerprint caught by the final assertion.
  await assertNoActiveV11Source(db, participantId);
  return sourcePin;
}

/**
 * Recompute private participant quota analysis from stored v1 chunk records.
 * No client-declared cost is accepted as the analytical cost basis: every usage
 * event is repriced from tokens by the shared server pricer.
 */
export async function accountScopedQuotaAnalysisV1(
  db: D1Database,
  participantId: string,
  options: V1AnalysisOptions = {},
): Promise<object> {
  return analyzeAccountScopedQuotaV1(db, participantId, options);
}

async function analyzeAccountScopedQuotaV1(
  db: D1Database, participantId: string, options: V1AnalysisOptions,
  acquired?: V1AcquiredQuotaEvidence,
): Promise<object> {
  const nowMs = options.nowMs ?? Date.now();
  const maxDownsampledQuotaRows =
    options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  const maxWindowedUsageRows =
    options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS;
  const observedAtCutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_MS).toISOString().slice(0, 10)
    + "T00:00:00.000Z";
  const cutoffMs = Date.parse(observedAtCutoff);
  // Snap the window to whole reset cycles: a weekly cycle's observations lie in
  // [resets_at - 7d, resets_at), so requiring resets_at >= cutoff + 7d includes
  // a cycle only when its entire series is at or after the observed_at cutoff.
  const resetsAtCutoff = new Date(cutoffMs + SEVEN_DAY_WINDOW_MS).toISOString();

  // Resolve the winner set once; every downstream read reuses it as an inline
  // triple row-IN filter shared with the daily totals/model cells.
  // No winners means no analyzable records.
  const sourcePin = await analysisSourcePin(db, participantId, observedAtCutoff, options.sourcePin);
  const prepared = acquired ? await validateAcquiredQuotaEvidence(db, participantId, acquired,
    sourcePin, observedAtCutoff, resetsAtCutoff, maxDownsampledQuotaRows) : null;
  if (sourcePin.winners.length === 0) {
    return notTestable("supported_quota_track_unavailable");
  }
  const attributionIndex = prepared?.attributionIndex
    ?? await loadPlanAttributionIndex(db, participantId, sourcePin.winnersJson, observedAtCutoff);
  if (attributionIndex === null) return notTestable("plan_attribution_limit_exceeded");
  if (attributionIndex.status === "limit_exceeded") return notTestable("plan_attribution_limit_exceeded");

  const quotaResult = prepared ?? await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
    eraMarkersJson(attributionIndex),
    sourcePin.winnersJson,
    participantId,
    observedAtCutoff,
    resetsAtCutoff,
    SEVEN_DAY_WINDOW_MINUTES,
    MINIMUM_BOUNDARIES,
    MINIMUM_DISPLAYED_SPAN_PP,
    maxDownsampledQuotaRows + 1,
  ).all<DownsampledQuotaRow>();

  if (quotaResult.results.length > maxDownsampledQuotaRows) {
    return notTestable("downsampled_quota_limit_exceeded");
  }
  if (quotaResult.results.length === 0) {
    return notTestable("supported_quota_track_unavailable");
  }

  const datasetId = await v1DatasetId(participantId);
  const datasets = [{ datasetId, complete: true }];
  const accountTrackByProvider = new Map<string, string>();
  const quotaSnapshots: AttributedQuotaSnapshot[] = [];
  for (const row of quotaResult.results) {
    let accountTrackId = accountTrackByProvider.get(row.provider);
    if (accountTrackId === undefined) {
      accountTrackId = await v1AccountTrackId(participantId, row.provider);
      accountTrackByProvider.set(row.provider, accountTrackId);
    }
    const snapshot = await buildQuotaSnapshotInput(row, accountTrackId, datasetId);
    const attributed = snapshot ? attributeSnapshot(snapshot, attributionIndex) : null;
    if (attributed) quotaSnapshots.push(attributed);
  }
  if (quotaSnapshots.length === 0) {
    return notTestable("supported_quota_track_unavailable");
  }

  const gridByProvider = buildGridByProvider(quotaSnapshots);
  const usageEvents = await readAndBucketUsage(
    db,
    participantId,
    datasetId,
    observedAtCutoff,
    accountTrackByProvider,
    gridByProvider,
    maxWindowedUsageRows,
    sourcePin.winnersJson,
    attributionIndex,
  );
  if (usageEvents === "limit_exceeded") {
    return notTestable("windowed_usage_limit_exceeded");
  }
  if (usageEvents === "session_scope_limit_exceeded") return notTestable("session_interval_scope_limit_exceeded");
  if (usageEvents === "cost_limit_exceeded") return notTestable("usage_cost_limit_exceeded");

  const analysis = runV1SeedLoop(datasets, quotaSnapshots, usageEvents);
  await assertV1SourcePinCurrent(db, sourcePin);
  return { ...analysis, attributionMethod: acquired
      ? V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: sourcePin.fingerprint };
}

/**
 * Test-only probe: the raw rows the windowed run-endpoint downsample returns,
 * so a test can MEASURE the collapse (raw vs retained) and assert the retained
 * set is exactly the first and last row of every flat used_percent run. Uses the
 * production SQL and default caps.
 */
export async function downsampleQuotaForTest(
  db: D1Database,
  participantId: string,
  nowMs: number = Date.now(),
): Promise<DownsampledQuotaRow[]> {
  const observedAtCutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_MS).toISOString().slice(0, 10)
    + "T00:00:00.000Z";
  const cutoffMs = Date.parse(observedAtCutoff);
  const resetsAtCutoff = new Date(cutoffMs + SEVEN_DAY_WINDOW_MS).toISOString();
  const sourcePin = await analysisSourcePin(db, participantId, observedAtCutoff);
  if (sourcePin.winners.length === 0) return [];
  const attributionIndex = await loadPlanAttributionIndex(db, participantId, sourcePin.winnersJson, observedAtCutoff);
  if (!attributionIndex) return [];
  const result = await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
    eraMarkersJson(attributionIndex),
    sourcePin.winnersJson,
    participantId,
    observedAtCutoff,
    resetsAtCutoff,
    SEVEN_DAY_WINDOW_MINUTES,
    MINIMUM_BOUNDARIES,
    MINIMUM_DISPLAYED_SPAN_PP,
    MAX_DOWNSAMPLED_QUOTA_ROWS + 1,
  ).all<DownsampledQuotaRow>();
  return result.results;
}

/**
 * Test-only reference path: the FULL per-event analysis with NO windowing,
 * downsampling, or usage bucketing. It shares every synthesis primitive with the
 * production path (winning-device dedupe, quota domain prefilter, server
 * pricing, id/dataset/track derivation, the seed loop), so the ONLY difference
 * from `accountScopedQuotaAnalysisV1` is the reduction under test. The golden
 * parity test asserts the reduced path's band-relevant reset fits are
 * byte-identical to this oracle. NEVER call this in production: it materializes
 * every record and would OOM on a dense corpus — the reduction exists precisely
 * to avoid that.
 */
export async function accountScopedQuotaAnalysisV1FullReferenceForTest(
  db: D1Database,
  participantId: string,
  options: { usageTieOrder?: "occurrence" | "rowid" } = {},
): Promise<object> {
  const sourcePin = await loadV1SourcePin(db, { participantId });
  await assertNoActiveV11Source(db, participantId);
  const result = await db.prepare(`
    SELECT r.stream, r.occurrence_id, r.observed_at, r.provider, r.session_uuid, r.plan_type,
           r.plan_variant, r.limit_id, r.slot, r.used_percent,
           r.window_duration_minutes, r.resets_at, r.record_json
      FROM telemetry_v1_records r
      JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
     WHERE ${WINNER_FILTER_SQL} AND r.participant_id = ?
       AND r.stream IN ('usage', 'quota')
     ORDER BY r.observed_at, ${options.usageTieOrder === "rowid"
      ? "r.id" : "CASE WHEN r.stream = 'usage' THEN r.occurrence_id END, r.id"}`,
  ).bind(sourcePin.winnersJson, participantId).all<ReferenceRecordRowV1>();

  const datasetId = await v1DatasetId(participantId);
  const datasets = [{ datasetId, complete: true }];
  const accountTrackByProvider = new Map<string, string>();
  const attributionIndex = buildPlanAttributionIndex(result.results
    .filter((row) => row.stream === "quota" && row.limit_id !== null)
    .map((row) => planObservation({ ...row, limit_id: row.limit_id! })));
  const quotaSnapshots: AttributedQuotaSnapshot[] = [];
  const usageEvents: AttributedUsageEventPartial[] = [];
  const priorSessionTimes = new Map<string, number>();
  for (const row of result.results) {
    let accountTrackId = accountTrackByProvider.get(row.provider);
    if (accountTrackId === undefined) {
      accountTrackId = await v1AccountTrackId(participantId, row.provider);
      accountTrackByProvider.set(row.provider, accountTrackId);
    }
    if (row.stream === "quota") {
      const snapshot = await buildQuotaSnapshotInput(
        row, accountTrackId, datasetId,
      );
      const attributed = snapshot ? attributeSnapshot(snapshot, attributionIndex) : null;
      if (attributed) quotaSnapshots.push(attributed);
      continue;
    }
    if (!SAFE_TOKEN.test(row.provider)) continue;
    const observedAtMs = Date.parse(row.observed_at);
    const sessionKey = row.session_uuid === null ? null : JSON.stringify([row.provider, row.session_uuid]);
    const intervalStartMs = sessionKey === null ? undefined : priorSessionTimes.get(sessionKey);
    if (sessionKey !== null) priorSessionTimes.set(sessionKey, observedAtMs);
    const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
    if (priced === null) continue;
    const contextKey = planAttributionContextKey(row.provider, "codex");
    const match = planEraForInterval(attributionIndex, { contextKey, observedAtMs, intervalStartMs });
    usageEvents.push({
      eventId: `u:v1:${await sha256Hex(row.occurrence_id)}`,
      datasetId,
      accountTrackId,
      provider: row.provider,
      observedAt: row.observed_at,
      costNanousd: priced.costNanousd,
      pricingStatus: priced.pricingStatus,
      policyEpoch: V1_POLICY_EPOCH,
      contextKey,
      planEraKey: match.status === "matched" ? match.era.eraKey : null,
      attribution: match.status === "matched" ? "legacy_conditional" : "unresolved",
    });
  }
  return runV1SeedLoop(datasets, quotaSnapshots, usageEvents);
}

// ---------------------------------------------------------------------------
// Per-model composition fit
// ---------------------------------------------------------------------------

const NANOUSD_PER_USD_COMPOSITION = 1_000_000_000;
const COMPOSITION_UNKNOWN_MODEL = "unknown";

export interface V1ModelComposition {
  readonly status: "ready";
  /** The participant's single plan_type over the retained quota series. */
  readonly planType: string;
  readonly fit: CompositionFit;
  readonly voidedBinCount: number;
  readonly poolCount: number;
  readonly quotaRowCount: number;
  readonly usageEventCount: number;
  readonly unpricedUsageEventCount: number;
  /** Kernel bins voided because a not-fully-priced event fell inside them. */
  readonly poisonedBinCount: number;
  /** Newest retained quota reading; the cohort layer's recency evidence. */
  readonly latestQuotaObservedAt: string;
  readonly attributionStatus: "legacy_conditional";
  readonly attributionMethod: string;
  readonly inputFingerprint: string;
}

export interface V1ModelCompositionRefusal {
  readonly status: "not_testable";
  readonly reason: string;
}

export type V1ModelCompositionResult =
  | V1ModelComposition
  | V1ModelCompositionRefusal;

function validCompositionQuotaRow(row: DownsampledQuotaRow): boolean {
  const observed = Date.parse(row.observed_at), reset = Date.parse(row.resets_at);
  return Number.isFinite(observed) && Number.isFinite(reset) && reset > observed
    && Number.isFinite(row.used_percent) && row.used_percent >= 0 && row.used_percent <= 100
    && SLOT_VALUES.has(row.slot) && SAFE_TOKEN.test(row.plan_type) && SAFE_TOKEN.test(row.provider);
}

/** Only a quota reading's bin can contain a kernel envelope crossing. This is
 * a conservative superset, not a new time horizon or fit eligibility rule. */
function compositionQuotaBins(observedTimes: Iterable<number>): Set<number> {
  return new Set(Array.from(observedTimes, time =>
    Math.floor(time / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs));
}

/** Physical usage pages are ordered by canonical admitted (time,id). Finish
 * one chronological bin at a time, including its late poison/occurrence ties.
 * Irrelevant bins still contribute every count and overflow refusal, but need
 * no retained cost cells. Relevant cells use compact numeric blocks until the
 * scalar's session/snapshot work has finished; never retain raw usage rows or
 * one occurrence string per completed (bin,model) pair.
 */
function createCompositionUsageAccumulator(providers: ReadonlySet<string>, relevantBins: ReadonlySet<number>) {
  const costs = new Map<string, { model: string; costNanousd: number;
    firstObservedAt: string; firstOccurrenceId: string; overflowed: boolean }>();
  const modelIds = new Map<string, number>(), models: string[] = [];
  const blockSize = 1024;
  const blocks: ({ costs: Float64Array; models: Uint32Array; length: number } | null)[] = [];
  // One timestamp/end offset per completed bin, not per model cell. There
  // cannot be more relevant bins than retained quota rows (60,000).
  const binStarts: number[] = [], binEnds: number[] = [];
  let cellCount = 0;
  let currentBin: number | null = null, poisoned = false, overflowed = false;
  let usageEventCount = 0, unpricedUsageEventCount = 0, poisonedBinCount = 0, limited = false;
  function release(): void {
    costs.clear(); blocks.length = 0; models.length = 0; modelIds.clear(); binStarts.length = 0; binEnds.length = 0;
  }
  function flush(): void {
    if (currentBin === null) return;
    if (poisoned) poisonedBinCount += 1;
    else {
      const ordered = [];
      for (const entry of costs.values()) {
        if (entry.overflowed) overflowed = true;
        if (entry.costNanousd > 0 && relevantBins.has(currentBin)) ordered.push(entry);
      }
      // Preserve the original first-observed/occurrence ordering before any
      // floating USD conversion or kernel model insertion (ties can span pages).
      ordered.sort((a, b) => a.firstObservedAt < b.firstObservedAt ? -1 : a.firstObservedAt > b.firstObservedAt ? 1
        : a.firstOccurrenceId < b.firstOccurrenceId ? -1 : a.firstOccurrenceId > b.firstOccurrenceId ? 1 : 0);
      for (const entry of ordered) {
        let modelId = modelIds.get(entry.model);
        if (modelId === undefined) { modelId = models.length; models.push(entry.model); modelIds.set(entry.model, modelId); }
        let block = blocks[blocks.length - 1];
        if (!block || block.length === blockSize) {
          block = { costs: new Float64Array(blockSize), models: new Uint32Array(blockSize), length: 0 }; blocks.push(block);
        }
        const at = block.length++;
        block.costs[at] = entry.costNanousd; block.models[at] = modelId; cellCount += 1;
      }
      if (ordered.length > 0) { binStarts.push(currentBin); binEnds.push(cellCount); }
    }
    costs.clear(); poisoned = false;
  }
  return {
    accepts(provider: string) { return providers.has(provider); },
    limitExceeded() { limited = true; },
    addPreparedFragment(fragment: V1PreparedUsageFragment) {
      if (!providers.has(fragment.provider)) return;
      if (currentBin !== fragment.binStartMs) { flush(); currentBin = fragment.binStartMs; }
      usageEventCount += fragment.usageEventCount;
      unpricedUsageEventCount += fragment.unpricedUsageEventCount;
      if (fragment.unpricedUsageEventCount > 0) poisoned = true;
      for (const cell of fragment.cells) {
        const previous = costs.get(cell.model);
        if (!previous) { costs.set(cell.model, { ...cell }); continue; }
        if (cell.overflowed || cell.costNanousd > Number.MAX_SAFE_INTEGER - previous.costNanousd) previous.overflowed = true;
        else if (!previous.overflowed) previous.costNanousd += cell.costNanousd;
        if (cell.firstObservedAt < previous.firstObservedAt
          || cell.firstObservedAt === previous.firstObservedAt && cell.firstOccurrenceId < previous.firstOccurrenceId) {
          previous.firstObservedAt = cell.firstObservedAt; previous.firstOccurrenceId = cell.firstOccurrenceId;
        }
      }
    },
    add(row: WindowedUsageRow, observedAtMs: number, priced: ReturnType<typeof priceChunkUsageRecord>) {
      if (!providers.has(row.provider) || priced === null) return;
      const bin = Math.floor(observedAtMs / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
      if (currentBin !== bin) { flush(); currentBin = bin; }
      if (priced.pricingStatus !== "fully_priced") {
        unpricedUsageEventCount += 1; poisoned = true; return;
      }
      usageEventCount += 1;
      const model = priced.modelId ?? COMPOSITION_UNKNOWN_MODEL;
      const previous = costs.get(model), valid = Number.isSafeInteger(priced.costNanousd) && priced.costNanousd >= 0;
      if (previous) {
        if (!valid || priced.costNanousd > Number.MAX_SAFE_INTEGER - previous.costNanousd) previous.overflowed = true;
        else if (!previous.overflowed) previous.costNanousd += priced.costNanousd;
        if (row.observed_at < previous.firstObservedAt
            || row.observed_at === previous.firstObservedAt && row.occurrence_id < previous.firstOccurrenceId) {
          previous.firstObservedAt = row.observed_at; previous.firstOccurrenceId = row.occurrence_id;
        }
      } else costs.set(model, { model, costNanousd: valid ? priced.costNanousd : 0,
        overflowed: !valid, firstObservedAt: row.observed_at, firstOccurrenceId: row.occurrence_id });
    },
    finish(): { status: "ready"; usageRows: Iterable<CompositionUsageRow>; usageEventCount: number;
      unpricedUsageEventCount: number; poisonedBinCount: number } | V1ModelCompositionRefusal {
      if (limited) { release(); return { status: "not_testable", reason: "windowed_usage_limit_exceeded" }; }
      flush();
      if (overflowed) { release(); return { status: "not_testable", reason: "usage_cost_limit_exceeded" }; }
      function* usageRows(): Generator<CompositionUsageRow> {
        let binIndex = 0, consumed = 0;
        try {
          for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
            const block = blocks[blockIndex]!;
            for (let index = 0; index < block.length; index++) {
              const costNanousd = block.costs[index]!;
              while (consumed >= binEnds[binIndex]!) binIndex += 1;
              consumed += 1;
              yield { observedAtMs: binStarts[binIndex]!, model: models[block.models[index]!]!,
                costUsd: costNanousd / NANOUSD_PER_USD_COMPOSITION };
            }
            // Consumed backing stores need not coexist with the growing final
            // observation corpus. The shared ordered API consumes exactly once.
            blocks[blockIndex] = null;
          }
        } finally { release(); }
      }
      return { status: "ready", usageRows: usageRows(), usageEventCount, unpricedUsageEventCount, poisonedBinCount };
    },
  };
}

/** Build rich kernel snapshots only AFTER the usage reader has released session
 * clocks and pending ties. Never move track-count refusal before usage: its
 * existing row/session/cost refusal precedence is part of the adapter contract.
 */
async function finishAcquiredScalar(rows: DownsampledQuotaRow[], attributionIndex: PlanAttributionIndex,
  datasetId: string, accountTracks: Map<string, string>, usage: AttributedUsageEventPartial[]): Promise<object> {
  const snapshots: AttributedQuotaSnapshot[] = [];
  for (const row of rows) {
    const accountTrack = accountTracks.get(row.provider);
    if (!accountTrack) continue;
    const snapshot = await buildQuotaSnapshotInput(row, accountTrack, datasetId);
    const attributed = snapshot ? attributeSnapshot(snapshot, attributionIndex) : null;
    if (attributed) snapshots.push(attributed);
  }
  const result = runV1SeedLoop([{ datasetId, complete: true }], snapshots, usage);
  snapshots.length = 0; usage.length = 0;
  return result;
}

/** This async frame ENDS before composition corpus/solver allocation. The
 * newly built plan index, scalar grids and snapshots are owned temporaries;
 * do not keep them alive through the second fit or the final source await.
 * Returned rows remain the original borrowed, validated evidence. */
async function collectAcquiredAnalyses(db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  options: V1AnalysisOptions & { sourcePin: V1SourcePin }, scalarRequested: boolean, compositionRequested: boolean,
  sourcePin: V1SourcePin, observedAtCutoff: string, resetsAtCutoff: string,
  history?: ModelHistoryWindow,
) {
  if (options.preparedEvidence && options.preparedEvidence.sourceFingerprint !== sourcePin.fingerprint) {
    throw new Error("v1 prepared evidence source mismatch");
  }
  const prepared = await validateAcquiredQuotaEvidence(db, participantId, evidence, sourcePin,
    observedAtCutoff, resetsAtCutoff, options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS, history);
  const { attributionIndex: index, results: rows } = prepared;
  let scalarReason: string | null = !scalarRequested ? "supported_quota_track_unavailable" : null;
  let compositionReason: string | null = !compositionRequested ? "supported_quota_track_unavailable" : null;
  if (sourcePin.winners.length === 0) scalarReason = compositionReason = "supported_quota_track_unavailable";
  else if (index.status === "limit_exceeded") scalarReason = compositionReason = "plan_attribution_limit_exceeded";
  if (compositionReason === null) {
    const plans = new Set(index.eras.map(era => era.planType).filter(plan => plan !== "unknown"));
    if (plans.size > 1 || index.conflicts.length > 0) compositionReason = "multi_plan_window_unsupported";
    else if (new Set(index.eras.map(era => era.contextKey)).size > 1) compositionReason = "multi_provider_window_unsupported";
  }
  // Only timestamp sets, not a second full array of quota objects, coexist with
  // the session reader. Recheck the identical domain/era predicate on synthesis.
  const gridByProvider = new Map<string, ProviderGrid>(), accountTracks = new Map<string, string>();
  const compositionProviders = new Set<string>(), compositionPlans = new Set<string>();
  let compositionQuotaCount = 0, latestQuotaMs = -Infinity;
  for (const row of rows) {
    if (scalarReason === null && validQuotaSnapshotRow(row)) {
      const match = planEraForInterval(index, { contextKey: planAttributionContextKey(row.provider, row.limit_id),
        observedAtMs: Date.parse(row.observed_at) });
      if (match.status === "matched" && match.era.planType === row.plan_type && match.era.planVariant === row.plan_variant) {
        let grid = gridByProvider.get(row.provider);
        if (!grid) { grid = { set: new Set(), sortedMs: [] }; gridByProvider.set(row.provider, grid); }
        grid.set.add(Date.parse(row.observed_at));
      }
    }
    if (compositionReason === null && validCompositionQuotaRow(row)) {
      compositionQuotaCount += 1; compositionProviders.add(row.provider); compositionPlans.add(row.plan_type);
      latestQuotaMs = Math.max(latestQuotaMs, Date.parse(row.observed_at));
    }
  }
  if (scalarReason === null && gridByProvider.size === 0) scalarReason = "supported_quota_track_unavailable";
  if (compositionReason === null && compositionQuotaCount === 0) compositionReason = "supported_quota_track_unavailable";
  if (compositionReason === null && compositionPlans.size > 1) compositionReason = "multi_plan_window_unsupported";
  for (const [provider, grid] of gridByProvider) {
    grid.sortedMs = [...grid.set].sort((a, b) => a - b);
    accountTracks.set(provider, await v1AccountTrackId(participantId, provider));
  }
  const datasetId = await v1DatasetId(participantId);
  const composition = compositionReason === null ? createCompositionUsageAccumulator(compositionProviders,
    compositionQuotaBins(rows.filter(validCompositionQuotaRow).map(row => Date.parse(row.observed_at)))) : undefined;
  const maxUsage = options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS;
  const preparedBins = options.preparedEvidence?.usageBins;
  // Sparse data can have one fragment per event; use already-priced events in
  // that case so preparation never expands the existing finish query reserve.
  const useBins = scalarReason !== null && composition && preparedBins
    && (preparedBins.totalRowCount > maxUsage || Math.floor(preparedBins.fragmentCount / 256) + 1
      <= Math.floor(Math.min(preparedBins.totalRowCount, maxUsage) / USAGE_PAGE_SIZE) + 1);
  let usage: Awaited<ReturnType<typeof readAndBucketUsage>> = [];
  if (useBins) {
    if (preparedBins.totalRowCount > maxUsage) composition.limitExceeded();
    else {
      let cursorTime = observedAtCutoff, cursorId = 0;
      for (;;) {
        const page = await preparedBins.readPage(cursorTime, cursorId, 256);
        for (const fragment of page) composition.addPreparedFragment(fragment);
        if (page.length < 256) break;
        cursorTime = page[page.length - 1]!.observed_at; cursorId = page[page.length - 1]!.id;
      }
    }
  } else if (scalarReason === null || composition) {
    usage = await readAndBucketUsage(db, participantId, datasetId,
      observedAtCutoff, accountTracks, gridByProvider, maxUsage,
      sourcePin.winnersJson, index, composition, scalarReason === null, history?.observedAtBefore,
      options.preparedEvidence?.usageReader);
  }
  gridByProvider.clear();
  if (scalarReason === null && typeof usage === "string") scalarReason = usage === "limit_exceeded"
    ? "windowed_usage_limit_exceeded" : usage === "session_scope_limit_exceeded"
      ? "session_interval_scope_limit_exceeded" : "usage_cost_limit_exceeded";
  const scalar = scalarReason !== null ? notTestable(scalarReason)
    : await finishAcquiredScalar(rows, index, datasetId, accountTracks, usage as AttributedUsageEventPartial[]);
  const quotaAnalysis = scalarReason === null ? { ...scalar,
    attributionMethod: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, inputFingerprint: sourcePin.fingerprint } : scalar;
  return { quotaAnalysis, composition, compositionReason, compositionPlans, latestQuotaMs, rows };
}

async function finishAcquiredAnalyses(db: D1Database, participantId: string, evidence: V1AcquiredQuotaEvidence,
  options: V1AnalysisOptions & { sourcePin: V1SourcePin }, scalarRequested: boolean, compositionRequested: boolean,
  history?: ModelHistoryWindow,
): Promise<{ quotaAnalysis: object; modelComposition: V1ModelCompositionResult }> {
  const nowMs = options.nowMs ?? Date.now();
  const observedAtCutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_MS).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const resetsAtCutoff = new Date(Date.parse(observedAtCutoff) + SEVEN_DAY_WINDOW_MS).toISOString();
  const sourcePin = await analysisSourcePin(db, participantId, observedAtCutoff, options.sourcePin, history);
  const { quotaAnalysis, composition, compositionReason, compositionPlans, latestQuotaMs, rows } =
    await collectAcquiredAnalyses(db, participantId, evidence, options, scalarRequested, compositionRequested,
      sourcePin, observedAtCutoff, resetsAtCutoff, history);
  let modelComposition: V1ModelCompositionResult = { status: "not_testable", reason: compositionReason ?? "supported_quota_track_unavailable" };
  if (composition) {
    const folded = composition.finish();
    if (folded.status === "not_testable") modelComposition = folded;
    else {
      const quotaRows: CompositionQuotaRow[] = [];
      for (const row of rows) if (validCompositionQuotaRow(row)) quotaRows.push({ observedAtMs: Date.parse(row.observed_at),
        planType: row.plan_type, resetsAtMs: Date.parse(row.resets_at), usedPercent: row.used_percent });
      const corpus = buildCompositionObservationsFromOrderedUsage({ usageRows: folded.usageRows, quotaRows });
      const fit = calibrateCompositionCapacities(corpus.observations);
      modelComposition = { status: "ready", planType: [...compositionPlans][0]!, fit,
        voidedBinCount: corpus.voidedBinCount, poolCount: corpus.poolCount, quotaRowCount: quotaRows.length,
        usageEventCount: folded.usageEventCount, unpricedUsageEventCount: folded.unpricedUsageEventCount,
        poisonedBinCount: folded.poisonedBinCount, latestQuotaObservedAt: new Date(latestQuotaMs).toISOString(),
        attributionStatus: "legacy_conditional", attributionMethod: history ? MODEL_HISTORY_METHOD_VERSION : V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
        inputFingerprint: sourcePin.fingerprint };
    }
  }
  await assertV1SourcePinCurrent(db, sourcePin);
  return { quotaAnalysis, modelComposition };
}

/**
 * Per-model NNLS composition fit over a participant's v1 corpus: how many
 * Pro-plan-relative dollars of each model one hundred weekly percentage
 * points buys, with the shared kernel's own identification gate deciding
 * whether the per-model vector is displayable at all.
 *
 * Reads the SAME evidence the blended reset fit reads — the winning-device
 * deduped rows, the lossless run-endpoint quota downsample (whose retained
 * endpoints are exactly the crossings the kernel's monotone envelope needs),
 * and per-event server repricing — and differs only in the usage fold: model
 * identity is preserved, and events are pre-summed per (2h kernel bin, model)
 * so a ~306k-event corpus reaches the kernel as a few thousand rows.
 *
 * Two deliberate divergences from the blended path, both conservative:
 *   - Only fully priced events contribute cost. The blended path keeps
 *     partially priced events at zero cost so the RESET refuses via
 *     incomplete_server_pricing; the composition fit has no per-reset refusal,
 *     so an unpriced event would silently deflate its model instead. It is
 *     excluded and counted in unpricedUsageEventCount.
 *   - The fitable HAVING drops reset groups the shared calibration always
 *     refuses (<8 distinct percents or <5pp span). Those groups carry at most
 *     sliver crossings for the kernel too; a jitter-split reset that loses one
 *     side to the HAVING widens the surviving crossing's bracket and is then
 *     voided by the kernel's own 3h smear gate.
 */
export async function accountScopedModelCompositionV1(
  db: D1Database,
  participantId: string,
  options: V1AnalysisOptions = {},
): Promise<V1ModelCompositionResult> {
  return analyzeAccountScopedModelCompositionV1(db, participantId, options);
}

async function analyzeAccountScopedModelCompositionV1(
  db: D1Database, participantId: string, options: V1AnalysisOptions,
  acquired?: V1AcquiredQuotaEvidence,
): Promise<V1ModelCompositionResult> {
  const nowMs = options.nowMs ?? Date.now();
  const maxDownsampledQuotaRows =
    options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  const maxWindowedUsageRows =
    options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS;
  const observedAtCutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_MS).toISOString().slice(0, 10)
    + "T00:00:00.000Z";
  const cutoffMs = Date.parse(observedAtCutoff);
  const resetsAtCutoff = new Date(cutoffMs + SEVEN_DAY_WINDOW_MS).toISOString();

  const sourcePin = await analysisSourcePin(db, participantId, observedAtCutoff, options.sourcePin);
  const prepared = acquired ? await validateAcquiredQuotaEvidence(db, participantId, acquired,
    sourcePin, observedAtCutoff, resetsAtCutoff, maxDownsampledQuotaRows) : null;
  if (sourcePin.winners.length === 0) {
    return { status: "not_testable", reason: "supported_quota_track_unavailable" };
  }
  const winnersJsonArg = sourcePin.winnersJson;
  const attributionIndex = prepared?.attributionIndex
    ?? await loadPlanAttributionIndex(db, participantId, winnersJsonArg, observedAtCutoff);
  if (attributionIndex === null) return { status: "not_testable", reason: "plan_attribution_limit_exceeded" };
  if (attributionIndex.status === "limit_exceeded") return { status: "not_testable", reason: "plan_attribution_limit_exceeded" };
  // The single-plan composition contract is intentional at this gate. Inspect
  // ALL admitted plan evidence first, including a one-row foreign plan or a
  // five-hour-only observation that the weekly fitability query would drop.
  const observedPlans = new Set(attributionIndex.eras.map((era) => era.planType).filter((plan) => plan !== "unknown"));
  if (observedPlans.size > 1 || attributionIndex.conflicts.length > 0) {
    return { status: "not_testable", reason: "multi_plan_window_unsupported" };
  }
  if (new Set(attributionIndex.eras.map((era) => era.contextKey)).size > 1) {
    return { status: "not_testable", reason: "multi_provider_window_unsupported" };
  }

  const quotaResult = prepared ?? await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
    eraMarkersJson(attributionIndex),
    winnersJsonArg,
    participantId,
    observedAtCutoff,
    resetsAtCutoff,
    SEVEN_DAY_WINDOW_MINUTES,
    MINIMUM_BOUNDARIES,
    MINIMUM_DISPLAYED_SPAN_PP,
    maxDownsampledQuotaRows + 1,
  ).all<DownsampledQuotaRow>();
  if (quotaResult.results.length > maxDownsampledQuotaRows) {
    return { status: "not_testable", reason: "downsampled_quota_limit_exceeded" };
  }

  // The same DROP-semantics domain prefilter as buildQuotaSnapshotInput,
  // narrowed to the fields the composition kernel reads. Slot is validated but
  // deliberately not identity: the kernel pools by (planType, resets_at
  // cluster) precisely because the weekly window's slot changed roles
  // historically.
  const quotaRows: CompositionQuotaRow[] = [];
  const quotaProviders = new Set<string>();
  const planCounts = new Map<string, number>();
  for (const row of quotaResult.results) {
    if (typeof row.observed_at !== "string" || typeof row.resets_at !== "string") continue;
    const observedAtMs = Date.parse(row.observed_at);
    const resetsAtMs = Date.parse(row.resets_at);
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(resetsAtMs)
        || resetsAtMs <= observedAtMs) continue;
    if (typeof row.used_percent !== "number"
        || !Number.isFinite(row.used_percent)
        || row.used_percent < 0 || row.used_percent > 100) continue;
    if (typeof row.slot !== "string" || !SLOT_VALUES.has(row.slot)) continue;
    if (typeof row.plan_type !== "string" || !SAFE_TOKEN.test(row.plan_type)) continue;
    if (!SAFE_TOKEN.test(row.provider)) continue;
    quotaRows.push({
      observedAtMs,
      planType: row.plan_type,
      resetsAtMs,
      usedPercent: row.used_percent,
    });
    quotaProviders.add(row.provider);
    planCounts.set(row.plan_type, (planCounts.get(row.plan_type) ?? 0) + 1);
  }
  if (quotaRows.length === 0) {
    return { status: "not_testable", reason: "supported_quota_track_unavailable" };
  }
  // One plan per window, or no fit at all. The kernel prices every pool with
  // one shared capacity vector, but a percentage point is worth
  // plan-multiplier-different dollars per plan — mixing regimes publishes
  // capacities wrong by up to that ratio (measured 14x on a synthetic
  // plus-to-pro switch), and the split-half gate cannot see it because both
  // interleaved halves contain both regimes. The blended path separates plan
  // eras before allocating usage; this path refuses instead of guessing.
  if (planCounts.size > 1) {
    return { status: "not_testable", reason: "multi_plan_window_unsupported" };
  }
  const planType = [...planCounts.keys()][0]!;
  let latestQuotaObservedAtMs = Number.NEGATIVE_INFINITY;
  for (const row of quotaRows) {
    if (row.observedAtMs > latestQuotaObservedAtMs) {
      latestQuotaObservedAtMs = row.observedAtMs;
    }
  }

  // Usage fold: per (kernel bin, model), cost from the shared server pricer.
  // Only providers that carry the retained quota series contribute — cost from
  // an unrelated provider cannot have debited this pool.
  const accumulator = createCompositionUsageAccumulator(quotaProviders, compositionQuotaBins(quotaRows.map(row => row.observedAtMs)));
  let total = 0, cursorObs = observedAtCutoff, cursorId = 0;
  for (;;) {
    const rows = await readV1UsagePage(db, winnersJsonArg, participantId, cursorObs, cursorId, USAGE_PAGE_SIZE);
    if (rows.length === 0) break;
    total += rows.length;
    if (total > maxWindowedUsageRows) return { status: "not_testable", reason: "windowed_usage_limit_exceeded" };
    for (const row of rows) {
      if (!SAFE_TOKEN.test(row.provider) || !quotaProviders.has(row.provider)) continue;
      const observedAtMs = Date.parse(row.observed_at);
      if (!Number.isFinite(observedAtMs)) continue;
      accumulator.add(row, observedAtMs, priceChunkUsageRecord(row.record_json, row.observed_at));
    }
    if (rows.length < USAGE_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    cursorObs = last.observed_at; cursorId = last.id;
  }
  const folded = accumulator.finish();
  if (folded.status === "not_testable") return folded;
  const { usageRows, usageEventCount, unpricedUsageEventCount, poisonedBinCount } = folded;

  const corpus = buildCompositionObservationsFromOrderedUsage({ usageRows, quotaRows });
  const fit = calibrateCompositionCapacities(corpus.observations);
  await assertV1SourcePinCurrent(db, sourcePin);
  return {
    status: "ready",
    planType,
    fit,
    voidedBinCount: corpus.voidedBinCount,
    poolCount: corpus.poolCount,
    quotaRowCount: quotaRows.length,
    usageEventCount,
    unpricedUsageEventCount,
    poisonedBinCount,
    latestQuotaObservedAt: new Date(latestQuotaObservedAtMs).toISOString(),
    attributionStatus: "legacy_conditional",
    attributionMethod: acquired ? V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: sourcePin.fingerprint,
  };
}
