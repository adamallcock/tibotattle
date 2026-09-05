import {
  MODEL_COMPOSITION_POLICY,
  PLAN_ATTRIBUTION_POLICY,
  QUOTA_CALIBRATION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
  analyzeQuotaCalibration,
  buildPlanAttributionIndex,
  buildCompositionObservations,
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

/** Bump fit/composition caches whenever this adapter attribution changes. */
export const V1_PLAN_ATTRIBUTION_ADAPTER_VERSION =
  `${V1_SOURCE_SELECTION_METHOD_VERSION}:${PLAN_ATTRIBUTION_POLICY.methodVersion}:v1-era-buckets-2`;

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
export const V1_ANALYSIS_WINDOW_DAYS = 100;
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

interface WindowedUsageRow {
  id: number;
  occurrence_id: string;
  observed_at: string;
  provider: string;
  session_uuid: string | null;
  record_json: string;
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
 * anthropic-only cache-write split keys the v0.1 pricing shape carries are set
 * to null (v1 does not split them). `modelRecognition` is 'recognized' and
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
  // v1 records do not carry totalInputContextTokens, but the OpenAI
  // context-sensitive price tiers require it — server-pricing fails closed with
  // total_input_context_missing (unpriced) otherwise, which refused EVERY reset
  // of a v1-only participant. Derive it from the input token components: the
  // total input context is the uncached + cache-read + cache-write input the
  // request billed.
  const tokenNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const derivedInputContext = tokenNumber(inputUncachedTokens)
    + tokenNumber(inputCacheReadTokens)
    + tokenNumber(inputCacheWriteTokens);
  const suppliedContext = rec.totalInputContextTokens;
  const totalInputContextTokens =
    typeof suppliedContext === "number" && Number.isFinite(suppliedContext)
      ? suppliedContext
      : derivedInputContext;
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
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
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
  if (row.slot === null || !SLOT_VALUES.has(row.slot)) return null;
  if (row.resets_at === null || row.observed_at === null) return null;
  if (Date.parse(row.resets_at) <= Date.parse(row.observed_at)) return null;
  if (row.used_percent === null
      || !Number.isFinite(row.used_percent)
      || row.used_percent < 0
      || row.used_percent > 100) return null;
  if (row.plan_type === null
      || row.plan_variant === null
      || row.limit_id === null) return null;
  if (!SAFE_TOKEN.test(row.provider)
      || !SAFE_TOKEN.test(row.plan_type)
      || !SAFE_TOKEN.test(row.plan_variant)
      || !SAFE_TOKEN.test(row.limit_id)
      || !SAFE_TOKEN.test(row.slot)) return null;
  // A quota snapshot needs a window; a missing one can neither seed nor bucket
  // (matching the v0.2 path, where a null window drops out).
  if (row.window_duration_minutes === null) return null;
  const snapshotId = `q:v1:${await sha256Hex(row.occurrence_id)}`;
  return {
    snapshotId,
    datasetId,
    accountTrackId,
    provider: row.provider,
    planType: row.plan_type,
    planVariant: row.plan_variant,
    limitId: row.limit_id,
    slot: row.slot as QuotaSlot,
    windowDurationMinutes:
      row.window_duration_minutes as QuotaWindowDurationMinutes,
    resetsAt: row.resets_at,
    observedAt: row.observed_at,
    // Receipt lag 0: v1 records carry no receipt timestamp distinct from the
    // observation, so the reset is never stale or backward on lag.
    receivedAt: row.observed_at,
    usedPercent: row.used_percent,
    displayPrecision: 0,
    policyEpoch: V1_POLICY_EPOCH,
  };
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
const QUOTA_DOWNSAMPLE_SQL = `WITH era_markers AS MATERIALIZED (
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

/** Shared page/cursor contract for both scalar and model-composition readers. */
export async function readV1UsagePage(
  db: D1Database, winnersJson: string, participantId: string,
  cursorObservedAt: string, cursorId: number, pageSize: number,
): Promise<WindowedUsageRow[]> {
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
): Promise<AttributedUsageEventPartial[] | "limit_exceeded" | "session_scope_limit_exceeded" | "cost_limit_exceeded"> {
  // Per provider: strictly-interior events keyed by their ceiling grid instant,
  // and grid-exact events kept as their own singleton at that instant (the
  // matchedUsage lower bound is inclusive, so a grid-exact event that equals a
  // reset's firstObserved is in-window while interior events of the same bucket
  // are not — the singleton-split preserves that distinction).
  const buckets = new Map<string, Map<number, BucketAccumulator>>();
  const singletons = new Map<string, Map<number, BucketAccumulator>>();
  const bucketScopes = new Map<string, { provider: string; planEraKey: string | null }>();
  const priorSessionTimes = new Map<string, number>();

  // Physical reads now use id within a timestamp, while the attribution
  // contract uses occurrence order. Only the minimum occurrence for a session
  // can inherit its earlier interval; every other tie has interval [t,t].
  // Retain that one compact candidate, not the raw JSON or the whole tie run.
  // priorSessionTimes includes pending sessions, so its existing cap bounds
  // the UNION of both maps rather than permitting a second set of 100k scopes.
  interface UsagePoint {
    provider: string;
    observedAtMs: number;
    priced: ReturnType<typeof priceChunkUsageRecord>;
  }
  const pendingFirst = new Map<string, {
    occurrenceId: string;
    intervalStartMs: number | undefined;
    point: UsagePoint;
  }>();
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
    for (const candidate of pendingFirst.values()) foldPoint(candidate.point, candidate.intervalStartMs);
    pendingFirst.clear();
  };

  let total = 0;
  let cursorObs = observedAtCutoff;
  let cursorId = 0;
  for (;;) {
    const rows = await readV1UsagePage(db, winnersJsonArg, participantId, cursorObs, cursorId, USAGE_PAGE_SIZE);
    if (rows.length === 0) break;
    total += rows.length;
    if (total > maxWindowedUsageRows) return "limit_exceeded";
    for (const row of rows) {
      if (!SAFE_TOKEN.test(row.provider)) continue;
      const eMs = Date.parse(row.observed_at);
      if (!Number.isFinite(eMs)) continue;
      if (pendingObservedAt !== row.observed_at) {
        flushFirst();
        pendingObservedAt = row.observed_at;
      }
      // v1 has no quantity-basis field. A prior usage record in the SAME
      // session gives a conservative interval bound, never account proof.
      const sessionKey = row.session_uuid === null ? null
        : JSON.stringify([row.provider, row.session_uuid]);
      if (sessionKey !== null && !priorSessionTimes.has(sessionKey)
          && priorSessionTimes.size >= MAX_SESSION_INTERVAL_SCOPES) {
        return "session_scope_limit_exceeded";
      }
      const grid = gridByProvider.get(row.provider);
      const point: UsagePoint = { provider: row.provider, observedAtMs: eMs,
        priced: !grid || grid.sortedMs.length === 0 || eMs > grid.sortedMs[grid.sortedMs.length - 1]!
          ? null : priceChunkUsageRecord(row.record_json, row.observed_at) };
      if (sessionKey === null) {
        foldPoint(point, undefined);
      } else {
        const candidate = pendingFirst.get(sessionKey);
        if (!candidate) {
          pendingFirst.set(sessionKey, { occurrenceId: row.occurrence_id,
            intervalStartMs: priorSessionTimes.get(sessionKey), point });
          // Includes DROP/grid-ineligible candidates: the original clock
          // advanced before those filters. Null sessions never share a clock.
          priorSessionTimes.set(sessionKey, eMs);
        } else if (row.occurrence_id < candidate.occurrenceId) {
          foldPoint(candidate.point, eMs);
          candidate.occurrenceId = row.occurrence_id;
          candidate.point = point;
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
): Promise<V1SourcePin> {
  let sourcePin: V1SourcePin;
  if (supplied) {
    if (!("participantId" in supplied.scope) || supplied.scope.participantId !== participantId
        || (supplied.scope.fromDay !== undefined && supplied.scope.fromDay > observedAtCutoff.slice(0, 10))
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
  if (sourcePin.winners.length === 0) {
    return notTestable("supported_quota_track_unavailable");
  }
  const attributionIndex = await loadPlanAttributionIndex(db, participantId, sourcePin.winnersJson, observedAtCutoff);
  if (attributionIndex === null) return notTestable("plan_attribution_limit_exceeded");

  const quotaResult = await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
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
  return { ...analysis, attributionMethod: V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
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
  if (sourcePin.winners.length === 0) {
    return { status: "not_testable", reason: "supported_quota_track_unavailable" };
  }
  const winnersJsonArg = sourcePin.winnersJson;
  const attributionIndex = await loadPlanAttributionIndex(db, participantId, winnersJsonArg, observedAtCutoff);
  if (attributionIndex === null) return { status: "not_testable", reason: "plan_attribution_limit_exceeded" };
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

  const quotaResult = await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
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
  const grainMs = MODEL_COMPOSITION_POLICY.grainMs;
  const costByBinAndModel = new Map<string, {
    observedAtMs: number; model: string; costNanousd: number;
    firstObservedAt: string; firstOccurrenceId: string;
    overflowed: boolean;
  }>();
  let usageEventCount = 0;
  let unpricedUsageEventCount = 0;
  const poisonedBins = new Set<number>();
  let total = 0;
  let cursorObs = observedAtCutoff;
  let cursorId = 0;
  for (;;) {
    const rows = await readV1UsagePage(db, winnersJsonArg, participantId, cursorObs, cursorId, USAGE_PAGE_SIZE);
    if (rows.length === 0) break;
    total += rows.length;
    if (total > maxWindowedUsageRows) {
      return { status: "not_testable", reason: "windowed_usage_limit_exceeded" };
    }
    for (const row of rows) {
      if (!SAFE_TOKEN.test(row.provider) || !quotaProviders.has(row.provider)) continue;
      const observedAtMs = Date.parse(row.observed_at);
      if (!Number.isFinite(observedAtMs)) continue;
      const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
      if (priced === null) continue;
      const eventBinStartMs = Math.floor(observedAtMs / grainMs) * grainMs;
      if (priced.pricingStatus !== "fully_priced") {
        // The blended path refuses a whole reset over one unpriced event; the
        // mirror here is voiding the bin. Training on a bin with understated
        // cost would shift the unpriced model's quota movement onto whatever
        // priced models co-occur — a systematic bias the split-half gate
        // passes.
        unpricedUsageEventCount += 1;
        poisonedBins.add(eventBinStartMs);
        continue;
      }
      usageEventCount += 1;
      const model = priced.modelId ?? COMPOSITION_UNKNOWN_MODEL;
      const binStartMs = eventBinStartMs;
      const key = `${binStartMs}\u0000${model}`;
      const existing = costByBinAndModel.get(key);
      if (existing) {
        if (!Number.isSafeInteger(priced.costNanousd) || priced.costNanousd < 0
            || priced.costNanousd > Number.MAX_SAFE_INTEGER - existing.costNanousd) {
          existing.overflowed = true;
        } else if (!existing.overflowed) {
          existing.costNanousd += priced.costNanousd;
        }
        if (row.observed_at < existing.firstObservedAt
            || (row.observed_at === existing.firstObservedAt && row.occurrence_id < existing.firstOccurrenceId)) {
          existing.firstObservedAt = row.observed_at;
          existing.firstOccurrenceId = row.occurrence_id;
        }
      } else {
        const validCost = Number.isSafeInteger(priced.costNanousd) && priced.costNanousd >= 0;
        costByBinAndModel.set(key, { observedAtMs: binStartMs, model,
          costNanousd: validCost ? priced.costNanousd : 0, overflowed: !validCost,
          firstObservedAt: row.observed_at, firstOccurrenceId: row.occurrence_id });
      }
    }
    if (rows.length < USAGE_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    cursorObs = last.observed_at;
    cursorId = last.id;
  }

  const usageRows: CompositionUsageRow[] = [];
  // Reconstruct the former (time,occurrence) stream's first-model insertion
  // order before the kernel converts costs to floating USD. Sorting by model
  // instead would be deterministic but could change its reduction order.
  // Fully priced zero-cost rows participate in this first-seen key just as
  // before; poisoned/zero-total bins are still omitted below.
  const orderedCosts = [];
  for (const entry of costByBinAndModel.values()) {
    if (poisonedBins.has(entry.observedAtMs)) continue;
    // Keep scanning after overflow: later unpriced evidence may legitimately
    // poison this whole bin. Only a contributing, otherwise retained entry
    // refuses the fit; never emit its partial sum or silently drop its cost.
    if (entry.overflowed) return { status: "not_testable", reason: "usage_cost_limit_exceeded" };
    if (entry.costNanousd > 0) orderedCosts.push(entry);
  }
  orderedCosts.sort((left, right) => (
    left.firstObservedAt < right.firstObservedAt ? -1 : left.firstObservedAt > right.firstObservedAt ? 1
      : left.firstOccurrenceId < right.firstOccurrenceId ? -1 : left.firstOccurrenceId > right.firstOccurrenceId ? 1 : 0
  ));
  for (const entry of orderedCosts) {
    usageRows.push({
      observedAtMs: entry.observedAtMs,
      model: entry.model,
      costUsd: entry.costNanousd / NANOUSD_PER_USD_COMPOSITION,
    });
  }

  const corpus = buildCompositionObservations({ usageRows, quotaRows });
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
    poisonedBinCount: poisonedBins.size,
    latestQuotaObservedAt: new Date(latestQuotaObservedAtMs).toISOString(),
    attributionStatus: "legacy_conditional",
    attributionMethod: V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: sourcePin.fingerprint,
  };
}
