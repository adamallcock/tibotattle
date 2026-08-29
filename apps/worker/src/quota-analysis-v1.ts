import {
  MODEL_COMPOSITION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
  analyzeQuotaCalibration,
  buildCompositionObservations,
  buildResetEvidence,
  isSupportedQuotaWindowDuration,
} from "@app-usagemonitor/quota-analysis";
import type {
  PricingStatus,
  QuotaSlot,
  QuotaSnapshotInput,
  QuotaUsageEventInput,
  QuotaWindowDurationMinutes,
} from "@app-usagemonitor/quota-analysis";
import { sha256Hex } from "./crypto";
import { priceTelemetryUsageEvent } from "./server-pricing";
import { parseStoredRecordJson } from "./stored-record";
import type { TelemetryUsageEvent } from "./telemetry-validation";

/**
 * Reset-fit analysis for the telemetry-contribution-v1.0 chunk corpus, computed
 * server-side so the community allowance band can draw from v1 data with ZERO
 * new calibration math.
 *
 * This reproduces `accountScopedQuotaAnalysis` (quota-analysis.ts, the v0.2
 * path) in shape — the same seed/bucket/loop, the same MAX_CONTINUITY_TRACKS
 * gate, the same per-seed `buildResetEvidence` + `analyzeQuotaCalibration` from
 * the shared calibration package — and differs ONLY in two respects:
 *
 *   1. Row source: the v1 current record view (`telemetry_v1_records`), read
 *      through the same per-(participant, day) winning-device dedupe the daily
 *      aggregates use, so a re-paired device's re-upload of the same underlying
 *      local index is counted once.
 *   2. Synthesized fields: v1 records carry no server pricing, track
 *      attribution, dataset, or receipt metadata, so those are derived here —
 *      pricing from the same `priceTelemetryUsageEvent` the v0.2 ingest uses
 *      (never a client-declared cost), attribution/receipt as deterministic
 *      synthetic values pinned to the participant. Events that do not fully
 *      price STAY in the bucket and correctly refuse their reset via
 *      `incomplete_server_pricing`; a price is never dropped or fabricated.
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
 *     track the consumer keeps (limit_id='codex', window=10080), and collapses
 *     each flat used_percent run to its endpoints via LAG/LEAD. Retaining even
 *     scalar-ineligible groups lets the composition kernel pool their smaller
 *     honest crossings under its own evidence gates. A
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
 *     The same pass additionally retains bounded 2h model-cost bins for the
 *     admin-only composition fit; a partial/unpriced constituent voids its bin.
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
// Running counter across usage pages (observed heaviest ~306k/100d; the local
// miner's ceiling is 750k/stream).
export const MAX_WINDOWED_USAGE_ROWS = 1_000_000;
const USAGE_PAGE_SIZE = 5_000;
// Identical purpose to the v0.2 path: reject a high-cardinality corpus before
// any per-track analysis rather than let distinct-seed count multiply the cost.
const MAX_CONTINUITY_TRACKS = 256;

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
}

interface WindowedUsageRow {
  id: number;
  observed_at: string;
  provider: string;
  record_json: string;
}

// Row shape for the test-only full reference path (both streams in one read).
interface ReferenceRecordRowV1 {
  stream: "usage" | "quota";
  occurrence_id: string;
  observed_at: string;
  provider: string;
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

// Usage events are matched to a track by the subset the per-track usage filter
// uses: account track, provider, and policy epoch. Plan/limit fields are
// stamped from the seed, not the row.
type UsageEventPartial = Omit<
  QuotaUsageEventInput,
  "planType" | "planVariant" | "limitId"
>;

interface TrackSeed {
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  windowDurationMinutes: number;
  policyEpoch: string;
}

/** Tuning knobs; production uses the defaults, tests pin them for determinism. */
export interface V1AnalysisOptions {
  /** Reference instant for the trailing read horizon. Defaults to Date.now(). */
  nowMs?: number;
  /** Override the downsampled-quota-row cap (tests exercise the bail cheaply). */
  maxDownsampledQuotaRows?: number;
  /** Override the windowed-usage-row cap (tests exercise the bail cheaply). */
  maxWindowedUsageRows?: number;
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
function priceV1UsageRecord(
  recordJson: string,
  observedAt: string,
): {
  costNanousd: number;
  pricingStatus: PricingStatus;
  modelId: string;
} | null {
  const rec = parseStoredRecordJson(recordJson);
  if (rec === null) return null;
  const pricingEvent = buildPricingEvent(rec, observedAt);
  if (pricingEvent === null) return null;
  const priced = priceTelemetryUsageEvent(pricingEvent);
  return {
    costNanousd: priced.costNanousd,
    pricingStatus: priced.coverageStatus as PricingStatus,
    modelId: pricingEvent.modelId,
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

// The winning-device dedupe the daily aggregates use: per (participant, day),
// count only the records of the device whose current chunks are freshest
// (newest created_at, tiebreak larger device_id). Considers BOTH streams so the
// same winner is chosen for the quota and usage reads.
const WINNING_DEVICE_CTE = `
  WITH day_device_evidence AS (
    SELECT r.observed_day AS observed_day,
           r.device_id AS device_id,
           MAX(c.created_at) AS newest
      FROM telemetry_v1_records r
      JOIN telemetry_v1_chunks c ON c.id = r.chunk_row_id
     WHERE r.participant_id = ?1
       AND r.stream IN ('usage', 'quota')
     GROUP BY r.observed_day, r.device_id
  ),
  winning_devices AS (
    SELECT observed_day, device_id
      FROM day_device_evidence winner
     WHERE NOT EXISTS (
       SELECT 1 FROM day_device_evidence rival
        WHERE rival.observed_day = winner.observed_day
          AND (
            rival.newest > winner.newest
            OR (
              rival.newest = winner.newest
              AND rival.device_id > winner.device_id
            )
          )
     )
  )`;

interface WinningDeviceRow {
  observed_day: string;
  device_id: string;
}

/**
 * Resolve the winning (observed_day, device_id) set ONCE per analysis.
 *
 * The reads below inject this as a literal VALUES table instead of recomputing
 * WINNING_DEVICE_CTE inline. The old inline form re-scanned the participant's
 * whole record partition on the quota downsample AND on every usage page
 * (~1 page per 5k events), so at the owner's ~1.22M-record scale one analysis
 * read hundreds of millions of rows and never finished inside the per-minute
 * cron. Resolving it once (a single corpus scan) and threading a ~tens-of-rows
 * VALUES table keeps every downstream `JOIN winning_devices` byte-identical
 * while the per-read queries become indexed range scans.
 */
async function loadWinningDevices(
  db: D1Database,
  participantId: string,
): Promise<WinningDeviceRow[]> {
  const result = await db.prepare(
    `${WINNING_DEVICE_CTE}
     SELECT observed_day, device_id FROM winning_devices`,
  ).bind(participantId).all<WinningDeviceRow>();
  return result.results;
}

/**
 * Serialize the winner set to a single JSON array of `[observed_day, device_id]`
 * pairs, bound as ONE parameter and expanded back to rows with `json_each` in
 * the winner filter (see WINNER_FILTER_SQL).
 *
 * One JSON parameter rather than a `VALUES (?,?),…` list on purpose: D1 caps a
 * query at ~100 bound parameters, and a real corpus resolves to ~90 winning
 * days = ~180 binds, which overflows that cap and throws. json_each takes the
 * whole set as a single string, so the bind count is fixed regardless of how
 * many winning days a participant has.
 */
function winnersJson(winners: WinningDeviceRow[]): string {
  return JSON.stringify(winners.map((w) => [w.observed_day, w.device_id]));
}

// The winner filter shared by the quota and usage reads: keep only rows whose
// (observed_day, device_id) is a winning pair. A row-value IN over a json_each
// subquery, NOT a JOIN on a VALUES table — measured against the owner's corpus,
// `JOIN winning_devices(VALUES …)` was a 453k×N nested loop (SQLite does not
// auto-index it), whereas this evaluates per row after the observed_at index
// range scan. Byte-identical to the JOIN because winner pairs are distinct (one
// device per day), so neither multiplies rows. Binds one parameter: winnersJson.
const WINNER_FILTER_SQL =
  `(r.observed_day, r.device_id) IN (
     SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]')
       FROM json_each(?) je
   )`;

/**
 * Windowed run-endpoint quota downsample.
 *
 * Windowing is snapped to whole reset cycles: `observed_at >= :cutoff` bounds
 * the index range scan, and `resets_at >= :resetsAtCutoff` (cutoff + one weekly
 * window) includes a reset only when its ENTIRE first..last series is within the
 * window, so a cycle straddling the cutoff is excluded wholesale rather than
 * read partially and mis-fit. The LAG/LEAD collapse keeps every row that differs
 * from its predecessor OR successor — the first and last row of every flat
 * used_percent run — because a boundary anchors lowerCost on the last row of the
 * preceding run and upperCost on the first row of the new run. We deliberately
 * retain reset groups below the scalar reset-fit span/boundary floors: the model
 * composition kernel pools honest two-hour crossings across weekly pools and
 * applies its own observation/identification gates, so scalar pre-filtering
 * would discard valid model evidence. Scalar calibration still applies its
 * existing gates after this lossless reduction.
 */
// Binds (in order): winnersJson, participantId, observedAt cutoff, resetsAt
// cutoff, window minutes, row limit. Anonymous `?` because the leading
// json_each winner filter binds one parameter and fixed numbering buys nothing.
const QUOTA_DOWNSAMPLE_SQL = `WITH scoped AS MATERIALIZED (
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
  marked AS (
    SELECT scoped.*,
           LAG(used_percent) OVER win AS prev_up,
           LEAD(used_percent) OVER win AS next_up
      FROM scoped
    WINDOW win AS (
      PARTITION BY provider, plan_type, plan_variant, limit_id,
                   window_duration_minutes, resets_at, slot
      ORDER BY observed_at, id
    )
  )
  SELECT occurrence_id, observed_at, provider, plan_type, plan_variant,
         limit_id, slot, used_percent, window_duration_minutes, resets_at
    FROM marked
   WHERE prev_up IS NULL
      OR next_up IS NULL
      OR used_percent <> prev_up
      OR used_percent <> next_up
   ORDER BY observed_at, id
   LIMIT ?`;

// Binds (in order): winnersJson, participantId, observedAt cutoff, keyset cursor
// observed_at (twice — the `>` and `=` legs), keyset cursor id, page size.
const USAGE_PAGE_SQL = `
  SELECT r.id AS id, r.observed_at AS observed_at, r.provider AS provider,
         r.record_json AS record_json
    FROM telemetry_v1_records r
    JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
   WHERE ${WINNER_FILTER_SQL}
     AND r.participant_id = ?
     AND r.stream = 'usage'
     AND r.observed_at >= ?
     AND (r.observed_at > ? OR (r.observed_at = ? AND r.id > ?))
   ORDER BY r.observed_at, r.id
   LIMIT ?`;

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

export type V1ModelCompositionPlanType = "pro" | "prolite" | "plus";

export interface V1ModelCompositionObservation {
  readonly planType: V1ModelCompositionPlanType;
  readonly binStartMs: number;
  readonly ppDelta: number;
  readonly costByModel: Readonly<Record<string, number>>;
}

export interface V1AnalysisWithComposition {
  readonly analysis: object;
  readonly compositionObservations: readonly V1ModelCompositionObservation[];
}

interface CompositionUsageAccumulator {
  readonly costsByBin: Map<number, Map<string, number>>;
  readonly invalidBins: Set<number>;
}

interface BucketedUsageResult {
  readonly usageEvents: UsageEventPartial[];
  readonly composition: CompositionUsageAccumulator;
}

function compositionModelId(modelId: string): string {
  // Work Mode is a routing alias of Sol in the reviewed price registry. Keep
  // the quota-credit calibration at the underlying model family while leaving
  // opaque routes such as codex-auto-review in the folded "other" column.
  return modelId === "gpt-5.6-sol-wm" ? "gpt-5.6-sol" : modelId;
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
  winners: WinningDeviceRow[],
): Promise<BucketedUsageResult | "limit_exceeded"> {
  const winnersJsonArg = winnersJson(winners);
  // Per provider: strictly-interior events keyed by their ceiling grid instant,
  // and grid-exact events kept as their own singleton at that instant (the
  // matchedUsage lower bound is inclusive, so a grid-exact event that equals a
  // reset's firstObserved is in-window while interior events of the same bucket
  // are not — the singleton-split preserves that distinction).
  const buckets = new Map<string, Map<number, BucketAccumulator>>();
  const singletons = new Map<string, Map<number, BucketAccumulator>>();
  const composition: CompositionUsageAccumulator = {
    costsByBin: new Map(),
    invalidBins: new Set(),
  };

  let total = 0;
  let cursorObs = observedAtCutoff;
  let cursorId = 0;
  for (;;) {
    const page = await db.prepare(USAGE_PAGE_SQL)
      .bind(
        winnersJsonArg,
        participantId,
        observedAtCutoff,
        cursorObs,
        cursorObs,
        cursorId,
        USAGE_PAGE_SIZE,
      )
      .all<WindowedUsageRow>();
    const rows = page.results;
    if (rows.length === 0) break;
    total += rows.length;
    if (total > maxWindowedUsageRows) return "limit_exceeded";
    for (const row of rows) {
      if (!SAFE_TOKEN.test(row.provider)) continue;
      const grid = gridByProvider.get(row.provider);
      if (!grid || grid.sortedMs.length === 0) continue;
      const eMs = Date.parse(row.observed_at);
      if (!Number.isFinite(eMs)) continue;
      // Events after the last retained quota instant cannot enter any reset's
      // matched window (matchedUsage requires observedAt <= lastObserved <=
      // maxG), so they change no fit — drop them.
      if (eMs > grid.sortedMs[grid.sortedMs.length - 1]!) continue;
      const compositionBinStartMs = row.provider === "openai_codex"
        ? Math.floor(eMs / MODEL_COMPOSITION_POLICY.grainMs)
          * MODEL_COMPOSITION_POLICY.grainMs
        : null;
      const priced = priceV1UsageRecord(row.record_json, row.observed_at);
      if (priced === null) {
        // The scalar analyzer deliberately applies ingest-style DROP semantics
        // to an event it cannot shape. Composition is stricter: quota movement
        // in this bin may still include that event, so its missing model cost
        // makes the entire bin unusable rather than silently zero-cost.
        if (compositionBinStartMs !== null) {
          composition.invalidBins.add(compositionBinStartMs);
        }
        continue;
      }
      const fullyPriced = priced.pricingStatus === "fully_priced";
      if (compositionBinStartMs !== null) {
        if (!fullyPriced) {
          // A partially priced bin cannot train on its visible dollars while
          // attributing the full quota movement. Exclude the entire bin later.
          composition.invalidBins.add(compositionBinStartMs);
        } else if (priced.costNanousd > 0) {
          const costs = composition.costsByBin.get(compositionBinStartMs)
            ?? new Map<string, number>();
          const modelId = compositionModelId(priced.modelId);
          costs.set(
            modelId,
            (costs.get(modelId) ?? 0) + priced.costNanousd / 1_000_000_000,
          );
          composition.costsByBin.set(compositionBinStartMs, costs);
        }
      }
      if (grid.set.has(eMs)) {
        const providerSingletons = singletons.get(row.provider)
          ?? new Map<number, BucketAccumulator>();
        const existing = providerSingletons.get(eMs);
        if (existing) {
          existing.costNanousd += priced.costNanousd;
          existing.allFullyPriced = existing.allFullyPriced && fullyPriced;
        } else {
          providerSingletons.set(eMs, {
            costNanousd: priced.costNanousd,
            allFullyPriced: fullyPriced,
            placementMs: eMs,
          });
        }
        singletons.set(row.provider, providerSingletons);
        continue;
      }
      const qc = ceilingGrid(grid.sortedMs, eMs);
      if (qc === null) continue;
      const providerBuckets = buckets.get(row.provider)
        ?? new Map<number, BucketAccumulator>();
      const existing = providerBuckets.get(qc);
      if (existing) {
        existing.costNanousd += priced.costNanousd;
        existing.allFullyPriced = existing.allFullyPriced && fullyPriced;
        // Place the synthetic at the MAX constituent observed_at (< qc), so it
        // sits strictly between the previous grid point and qc.
        existing.placementMs = Math.max(existing.placementMs, eMs);
      } else {
        providerBuckets.set(qc, {
          costNanousd: priced.costNanousd,
          allFullyPriced: fullyPriced,
          placementMs: eMs,
        });
      }
      buckets.set(row.provider, providerBuckets);
    }
    if (rows.length < USAGE_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    cursorObs = last.observed_at;
    cursorId = last.id;
  }

  const usageEvents: UsageEventPartial[] = [];
  const providers = new Set<string>([...buckets.keys(), ...singletons.keys()]);
  for (const provider of providers) {
    const accountTrackId = accountTrackByProvider.get(provider);
    if (accountTrackId === undefined) continue;
    for (const [gridMs, acc] of singletons.get(provider) ?? []) {
      usageEvents.push(await synthUsageRow(
        accountTrackId, datasetId, provider, acc, `s|${gridMs}`,
      ));
    }
    for (const [qcMs, acc] of buckets.get(provider) ?? []) {
      usageEvents.push(await synthUsageRow(
        accountTrackId, datasetId, provider, acc, `b|${qcMs}`,
      ));
    }
  }
  return { usageEvents, composition };
}

function buildV1CompositionObservationCorpus(
  quotaSnapshots: readonly QuotaSnapshotInput[],
  composition: CompositionUsageAccumulator,
): V1ModelCompositionObservation[] {
  const usageRows: Array<{
    observedAtMs: number;
    model: string;
    costUsd: number;
  }> = [];
  for (const [binStartMs, costs] of composition.costsByBin) {
    for (const [model, costUsd] of costs) {
      usageRows.push({ observedAtMs: binStartMs, model, costUsd });
    }
  }
  const codexQuotaSnapshots = quotaSnapshots.filter(
    (snapshot) => snapshot.provider === "openai_codex",
  );
  const planTypesByBin = new Map<number, Set<string>>();
  for (const snapshot of codexQuotaSnapshots) {
    const observedAtMs = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observedAtMs)) continue;
    const binStartMs = Math.floor(
      observedAtMs / MODEL_COMPOSITION_POLICY.grainMs,
    ) * MODEL_COMPOSITION_POLICY.grainMs;
    const planTypes = planTypesByBin.get(binStartMs) ?? new Set<string>();
    planTypes.add(snapshot.planType);
    planTypesByBin.set(binStartMs, planTypes);
  }
  const ambiguousPlanBins = new Set(
    [...planTypesByBin]
      .filter(([, planTypes]) => planTypes.size > 1)
      .map(([binStartMs]) => binStartMs),
  );
  const quotaRows = codexQuotaSnapshots
    .map((snapshot) => ({
      observedAtMs: Date.parse(snapshot.observedAt),
      planType: snapshot.planType,
      resetsAtMs: Date.parse(snapshot.resetsAt),
      usedPercent: snapshot.usedPercent,
    }));
  const built = buildCompositionObservations({ usageRows, quotaRows });
  return built.observations
    // Feeding all plan pools above lets the kernel void a bin where multiple
    // plans move. Only explicitly normalized personal plans reach the admin
    // estimator; preserving the plan here lets that caller scale every row to
    // Pro 20x before participant balancing and community pooling.
    .filter((observation): observation is typeof observation & {
      planType: V1ModelCompositionPlanType;
    } => (observation.planType === "pro"
      || observation.planType === "prolite"
      || observation.planType === "plus")
      && !composition.invalidBins.has(observation.binStartMs)
      // Redundant with the shared kernel's ambiguity refusal by design: usage
      // has no plan tag, so a transition bin containing readings from two plan
      // eras cannot inherit either era's Pro-equivalent multiplier.
      && !ambiguousPlanBins.has(observation.binStartMs))
    .map((observation) => ({
      planType: observation.planType,
      binStartMs: observation.binStartMs,
      ppDelta: observation.ppDelta,
      costByModel: Object.fromEntries(
        Object.entries(observation.costByModel)
          .filter(([, cost]) => typeof cost === "number"
            && Number.isFinite(cost) && cost >= 0)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    }))
    .sort((left, right) => left.binStartMs - right.binStartMs);
}

async function synthUsageRow(
  accountTrackId: string,
  datasetId: string,
  provider: string,
  acc: BucketAccumulator,
  anchor: string,
): Promise<UsageEventPartial> {
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
  };
}

/**
 * The shared seed/bucket/loop: group snapshots into continuity seeds, gate on
 * track count, and run the per-seed shared calibration. Pure and synchronous —
 * both the production reduction path and the test-only full reference feed it.
 */
function runV1SeedLoop(
  datasets: { datasetId: string; complete: boolean }[],
  quotaSnapshots: QuotaSnapshotInput[],
  usageEvents: UsageEventPartial[],
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
    };
    seeds.set(seedKey(seed), seed);
  }
  if (seeds.size === 0) return notTestable("supported_quota_track_unavailable");
  if (seeds.size > MAX_CONTINUITY_TRACKS) {
    return notTestable("continuity_track_limit_exceeded");
  }

  const quotaSnapshotsBySeed = new Map<string, QuotaSnapshotInput[]>();
  for (const snapshot of quotaSnapshots) {
    const key = seedKey({
      accountTrackId: snapshot.accountTrackId,
      provider: snapshot.provider,
      planType: snapshot.planType,
      planVariant: snapshot.planVariant,
      limitId: snapshot.limitId,
      windowDurationMinutes: snapshot.windowDurationMinutes,
      policyEpoch: snapshot.policyEpoch,
    });
    const bucket = quotaSnapshotsBySeed.get(key);
    if (bucket) bucket.push(snapshot);
    else quotaSnapshotsBySeed.set(key, [snapshot]);
  }

  const usageEventsByTrackEpoch = new Map<string, UsageEventPartial[]>();
  for (const event of usageEvents) {
    const key = usageTrackEpochKey(
      event.accountTrackId,
      event.provider,
      event.policyEpoch,
    );
    const bucket = usageEventsByTrackEpoch.get(key);
    if (bucket) bucket.push(event);
    else usageEventsByTrackEpoch.set(key, [event]);
  }

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
    ).map((partial) => ({
      ...partial,
      planType: seed.planType,
      planVariant: seed.planVariant,
      limitId: seed.limitId,
    }));
    const evidence = buildResetEvidence({
      datasets,
      quotaSnapshots: seedQuotaSnapshots,
      usageEvents: seedUsageEvents,
    });
    const calibration = analyzeQuotaCalibration(evidence);
    tracks.push({ continuity: seed, calibration });
  }
  return {
    schemaVersion: "account-scoped-quota-analysis-v0.1",
    status: "ready",
    tracks,
  };
}

/**
 * Recompute private participant quota analysis from stored v1 chunk records.
 * No client-declared cost is accepted as the analytical cost basis: every usage
 * event is repriced from tokens by the shared server pricer.
 */
export async function accountScopedQuotaAnalysisV1WithComposition(
  db: D1Database,
  participantId: string,
  options: V1AnalysisOptions = {},
): Promise<V1AnalysisWithComposition> {
  const nowMs = options.nowMs ?? Date.now();
  const maxDownsampledQuotaRows =
    options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  const maxWindowedUsageRows =
    options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS;
  const cutoffMs = nowMs - V1_ANALYSIS_WINDOW_MS;
  const observedAtCutoff = new Date(cutoffMs).toISOString();
  // Snap the window to whole reset cycles: a weekly cycle's observations lie in
  // [resets_at - 7d, resets_at), so requiring resets_at >= cutoff + 7d includes
  // a cycle only when its entire series is at or after the observed_at cutoff.
  const resetsAtCutoff = new Date(cutoffMs + SEVEN_DAY_WINDOW_MS).toISOString();

  // Resolve the winner set once; every downstream read reuses it as an inline
  // (observed_day, device_id) IN (VALUES …) filter (see loadWinningDevices).
  // No winners means no analyzable records.
  const winners = await loadWinningDevices(db, participantId);
  if (winners.length === 0) {
    return {
      analysis: notTestable("supported_quota_track_unavailable"),
      compositionObservations: [],
    };
  }

  const quotaResult = await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
    winnersJson(winners),
    participantId,
    observedAtCutoff,
    resetsAtCutoff,
    SEVEN_DAY_WINDOW_MINUTES,
    maxDownsampledQuotaRows + 1,
  ).all<DownsampledQuotaRow>();

  if (quotaResult.results.length > maxDownsampledQuotaRows) {
    return {
      analysis: notTestable("downsampled_quota_limit_exceeded"),
      compositionObservations: [],
    };
  }
  if (quotaResult.results.length === 0) {
    return {
      analysis: notTestable("supported_quota_track_unavailable"),
      compositionObservations: [],
    };
  }

  const datasetId = await v1DatasetId(participantId);
  const datasets = [{ datasetId, complete: true }];
  const accountTrackByProvider = new Map<string, string>();
  const quotaSnapshots: QuotaSnapshotInput[] = [];
  for (const row of quotaResult.results) {
    let accountTrackId = accountTrackByProvider.get(row.provider);
    if (accountTrackId === undefined) {
      accountTrackId = await v1AccountTrackId(participantId, row.provider);
      accountTrackByProvider.set(row.provider, accountTrackId);
    }
    const snapshot = await buildQuotaSnapshotInput(row, accountTrackId, datasetId);
    if (snapshot) quotaSnapshots.push(snapshot);
  }
  if (quotaSnapshots.length === 0) {
    return {
      analysis: notTestable("supported_quota_track_unavailable"),
      compositionObservations: [],
    };
  }

  const gridByProvider = buildGridByProvider(quotaSnapshots);
  const usageResult = await readAndBucketUsage(
    db,
    participantId,
    datasetId,
    observedAtCutoff,
    accountTrackByProvider,
    gridByProvider,
    maxWindowedUsageRows,
    winners,
  );
  if (usageResult === "limit_exceeded") {
    return {
      analysis: notTestable("windowed_usage_limit_exceeded"),
      compositionObservations: [],
    };
  }

  return {
    analysis: runV1SeedLoop(
      datasets,
      quotaSnapshots,
      usageResult.usageEvents,
    ),
    compositionObservations: buildV1CompositionObservationCorpus(
      quotaSnapshots,
      usageResult.composition,
    ),
  };
}

export async function accountScopedQuotaAnalysisV1(
  db: D1Database,
  participantId: string,
  options: V1AnalysisOptions = {},
): Promise<object> {
  const result = await accountScopedQuotaAnalysisV1WithComposition(
    db,
    participantId,
    options,
  );
  return result.analysis;
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
  const cutoffMs = nowMs - V1_ANALYSIS_WINDOW_MS;
  const observedAtCutoff = new Date(cutoffMs).toISOString();
  const resetsAtCutoff = new Date(cutoffMs + SEVEN_DAY_WINDOW_MS).toISOString();
  const winners = await loadWinningDevices(db, participantId);
  if (winners.length === 0) return [];
  const result = await db.prepare(QUOTA_DOWNSAMPLE_SQL).bind(
    winnersJson(winners),
    participantId,
    observedAtCutoff,
    resetsAtCutoff,
    SEVEN_DAY_WINDOW_MINUTES,
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
): Promise<object> {
  const result = await db.prepare(`${WINNING_DEVICE_CTE}
    SELECT r.stream, r.occurrence_id, r.observed_at, r.provider, r.plan_type,
           r.plan_variant, r.limit_id, r.slot, r.used_percent,
           r.window_duration_minutes, r.resets_at, r.record_json
      FROM telemetry_v1_records r
      JOIN winning_devices wd
        ON wd.observed_day = r.observed_day AND wd.device_id = r.device_id
      JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
     WHERE r.participant_id = ?1
       AND r.stream IN ('usage', 'quota')
     ORDER BY r.observed_at, r.id`,
  ).bind(participantId).all<ReferenceRecordRowV1>();

  const datasetId = await v1DatasetId(participantId);
  const datasets = [{ datasetId, complete: true }];
  const accountTrackByProvider = new Map<string, string>();
  const quotaSnapshots: QuotaSnapshotInput[] = [];
  const usageEvents: UsageEventPartial[] = [];
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
      if (snapshot) quotaSnapshots.push(snapshot);
      continue;
    }
    if (!SAFE_TOKEN.test(row.provider)) continue;
    const priced = priceV1UsageRecord(row.record_json, row.observed_at);
    if (priced === null) continue;
    usageEvents.push({
      eventId: `u:v1:${await sha256Hex(row.occurrence_id)}`,
      datasetId,
      accountTrackId,
      provider: row.provider,
      observedAt: row.observed_at,
      costNanousd: priced.costNanousd,
      pricingStatus: priced.pricingStatus,
      policyEpoch: V1_POLICY_EPOCH,
    });
  }
  return runV1SeedLoop(datasets, quotaSnapshots, usageEvents);
}
