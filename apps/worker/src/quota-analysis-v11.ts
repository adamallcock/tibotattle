import {
  MODEL_COMPOSITION_POLICY,
  PLAN_ATTRIBUTION_POLICY,
  QUOTA_CALIBRATION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
  analyzeQuotaCalibration,
  buildCompositionObservations,
  buildPlanAttributionIndex,
  buildResetEvidence,
  calibrateCompositionCapacities,
  planAttributionContextKey,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import type {
  CompositionQuotaRow,
  CompositionUsageRow,
  PlanAttributionIndex,
  QuotaSnapshotInput,
  QuotaUsageEventInput,
} from "@app-usagemonitor/quota-analysis";
import { parseTelemetryV11Attribution } from "@app-usagemonitor/telemetry-contract";
import type { TelemetryV11Attribution } from "@app-usagemonitor/telemetry-contract";
import {
  MAX_DOWNSAMPLED_QUOTA_ROWS,
  MAX_PLAN_ATTRIBUTION_ROWS,
  MAX_WINDOWED_USAGE_ROWS,
  V1_ANALYSIS_WINDOW_DAYS,
  priceChunkUsageRecord,
} from "./quota-analysis-v1";
import type { V1ModelCompositionResult } from "./quota-analysis-v1";
import { sha256Hex } from "./crypto";
import { parseStoredRecordJson } from "./stored-record";
import { assertV11SourcePinCurrent, loadV11SourcePin } from "./telemetry-v11-domain";
import type { V11SourcePin } from "./telemetry-v11-domain";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { typedTelemetryReadNamespace } from "./typed-telemetry-read-layout";
import { readTypedV11UsageAnalysisPage, TYPED_V11_ANALYSIS_PAGE_SIZE } from "./typed-v11-analysis-reader";
import type { V11GenerationSnapshot } from "./typed-v11-quota-reader";
import {
  V11_QUOTA_ACQUISITION_VERSION,
  createV11QuotaAcquisitionCheckpoint,
  v11QuotaAcquisitionIdentityMatches,
  validateV11CompletedQuotaAcquisition,
} from "./quota-analysis-v11-reader";
import type {
  V11CompletedQuotaAcquisition,
  V11QuotaAcquisitionIdentity,
} from "./quota-analysis-v11-reader";

export const V11_PLAN_ATTRIBUTION_ADAPTER_VERSION =
  PLAN_ATTRIBUTION_POLICY.methodVersion + ":v11-account-era-buckets-1";
export const V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION =
  `${V11_PLAN_ATTRIBUTION_ADAPTER_VERSION}:${V11_QUOTA_ACQUISITION_VERSION}`;

const DAY_MS = 86_400_000;
const WEEK_MS = SEVEN_DAY_WINDOW_MINUTES * 60_000;
const PAGE_SIZE = 5_000;
const MAX_USAGE_DAYS = V1_ANALYSIS_WINDOW_DAYS + 1;
const MAX_TRACKS = 256;
const MAX_SESSIONS = 100_000;
const MAX_USAGE_BUCKETS = 120_000;
const MAX_HAZARD_INTERVALS = 240_000;
export const MAX_V11_USAGE_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const SLOTS = new Set(["primary", "secondary", "five_hour", "seven_day", "other", "unknown"]);

export interface V11AnalysisOptions {
  nowMs?: number;
  sourcePin?: V11SourcePin;
  maxDownsampledQuotaRows?: number;
  maxWindowedUsageRows?: number;
  /** Resolved from the database contract at the public entrypoint. */
  typedSourceNamespace?: string | null;
  /** Exact retained generation for graph-only resumable work. Ordinary public
   * readers omit this and remain current-head strict. */
  generationSnapshot?: V11GenerationSnapshot;
  /** The graph driver has fenced generationSnapshot around this bounded group. */
  generationSnapshotFenced?: boolean;
  /** Testable hard cap for durable reducer state. Production uses 8 MiB so
   * frame encoding, hashing and D1 transport stay below the Worker heap. */
  maxUsageCheckpointBytes?: number;
  /** A complete bounded quota acquisition. When present, quota PLAN/QUOTA SQL
   * is skipped; the caller remains responsible for source-pin fences and any
   * resumable checkpoint durability. */
  quotaAcquisition?: V11CompletedQuotaAcquisition;
}

export interface V11AnalysisWindow {
  cutoff: string;
  start: string;
  end: string;
  resetsAtCutoff: string;
}

interface PlanRow {
  observed_at: string;
  provider: string;
  limit_id: string;
  account_scope_id: string | null;
  plan_type: string;
  plan_variant: string;
  continuity_id: string | null;
  plan_basis: TelemetryV11Attribution["planBasis"] | null;
}

interface QuotaRow extends PlanRow {
  occurrence_id: string;
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
  plan_era_key: string;
}

interface UsageRow {
  occurrence_id: string;
  observed_at: string;
  provider: string;
  session_uuid: string | null;
  record_json: string;
}

interface Seed {
  accountTrackId: string;
  accountScopeId: string | null;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  windowDurationMinutes: number;
  policyEpoch: string;
  planEraKey: string;
}

interface Grid { ordered: number[]; exact: Set<number> }
interface Context {
  pin: V11SourcePin;
  start: string;
  end: string;
  datasetId: string;
  index: PlanAttributionIndex;
  seeds: Map<string, Seed>;
  snapshots: Map<string, QuotaSnapshotInput[]>;
  quota: QuotaRow[];
  grids: Map<string, Grid>;
}

interface Refusal { status: "not_testable"; reason: string; tracks: never[] }
function refused(reason: string): Refusal { return { status: "not_testable", reason, tracks: [] }; }
function scopeKey(provider: string, scope: string | null): string { return JSON.stringify([provider, scope]); }
function seedKey(seed: Seed): string {
  return JSON.stringify([seed.provider, seed.accountScopeId, seed.planType, seed.planVariant,
    seed.limitId, seed.windowDurationMinutes, seed.planEraKey]);
}

// The activated view is a complete, immutable, whole-domain vector. No staged
// records, legacy rows, or newly elected device are joined into these reads.
// Only a same-source account declaration creates comparable account scope.
// A marker's hash is NOT positive account evidence, even if it matches another.
const QUOTA_INPUT = `
  input AS MATERIALIZED (
    SELECT r.*,
      CASE WHEN json_extract(record_json, '$.accountPlanAttribution.accountBasis') = 'same_source'
        THEN json_extract(record_json, '$.accountPlanAttribution.accountTrackId') ELSE '' END AS account_scope_id,
      json_extract(record_json, '$.accountPlanAttribution.planEraId') AS continuity_id,
      json_extract(record_json, '$.accountPlanAttribution.planBasis') AS plan_basis
      FROM telemetry_v11_active_records r
     WHERE participant_id = ? AND generation_id = ? AND stream = 'quota'
       AND observed_day >= ? AND observed_day < ?
       AND observed_at >= ? AND observed_at < ? AND limit_id = 'codex'
  )`;

// Keep the active-domain view as the semantic authority, but make the physical
// owner/time index the outer loop.  A direct join lets SQLite expand the view
// once per already bounded physical row instead of materializing every admitted
// compatibility row before applying participant, generation and time filters.
// The source namespace and owner are both resolved from the initialized typed
// namespace; the active view still supplies the complete admission/domain fence.
const TYPED_QUOTA_INPUT = `input AS MATERIALIZED (
  SELECT v.*, CASE WHEN v.account_basis='same_source' THEN v.account_track_id ELSE '' END AS account_scope_id,
    v.plan_era_id AS continuity_id
  FROM typed_telemetry_records base INDEXED BY typed_telemetry_owner_time
  CROSS JOIN typed_v11_active_records v
  WHERE v.storage_row_id=base.id
    AND v.participant_id=? AND v.generation_id=? AND v.stream='quota'
    AND v.observed_day>=? AND v.observed_day<? AND v.observed_at>=? AND v.observed_at<?
    AND v.limit_id='codex' AND v.source_namespace=?
    AND base.format=11 AND base.stream=2
    AND base.observed_at_ms>=? AND base.observed_at_ms<?
    AND base.owner_id=(SELECT o.id FROM typed_telemetry_owners o
      JOIN typed_telemetry_namespaces n ON n.id=o.namespace_id
      WHERE n.original_id=? AND o.original_id=?)
)`;

// All durations and non-fitting plan observations participate BEFORE the
// weekly-fit gates. Flat plan/continuity runs retain both endpoint anchors.
const PLAN_SQL = `WITH ` + QUOTA_INPUT + `,
  points AS (
    SELECT DISTINCT observed_at, provider, limit_id, account_scope_id,
      plan_type, plan_variant, continuity_id, plan_basis,
      json_array(plan_type, plan_variant, continuity_id, plan_basis) AS signature
    FROM input
  ), marked AS (
    SELECT *, LAG(signature) OVER win AS previous, LEAD(signature) OVER win AS next
    FROM points WINDOW win AS (
      PARTITION BY provider, limit_id, account_scope_id ORDER BY observed_at, signature
    )
  ) SELECT observed_at, provider, limit_id, account_scope_id, plan_type, plan_variant, continuity_id, plan_basis
    FROM marked WHERE previous IS NULL OR next IS NULL OR previous != signature OR next != signature
    ORDER BY observed_at, provider, account_scope_id, signature LIMIT ?`;

// Ordered marker merge, not a rows x eras correlated lookup. Every quota is
// assigned to its account's natural/declared plan era before percentile runs
// collapse. A Pro return cannot reuse the earlier Pro fragment or numerator.
const QUOTA_SQL = `WITH markers AS MATERIALIZED (
    SELECT json_extract(value, '$[0]') AS provider,
      json_extract(value, '$[1]') AS account_scope_id,
      json_extract(value, '$[2]') AS limit_id,
      json_extract(value, '$[3]') AS plan_type,
      json_extract(value, '$[4]') AS plan_variant,
      json_extract(value, '$[5]') AS plan_era_key,
      json_extract(value, '$[6]') AS lower_bound,
      json_extract(value, '$[7]') AS upper_bound,
      json_extract(value, '$[8]') AS ordinal
    FROM json_each(?)
  ), ` + QUOTA_INPUT + `,
  timeline AS (
    SELECT id, occurrence_id, observed_at, provider, account_scope_id, limit_id,
      plan_type, plan_variant, continuity_id, plan_basis, slot, used_percent,
      window_duration_minutes, resets_at, 0 AS is_marker, 0 AS ordinal
    FROM input WHERE window_duration_minutes = ? AND resets_at >= ? AND used_percent IS NOT NULL
    UNION ALL
    SELECT 0, NULL, lower_bound, provider, account_scope_id, limit_id,
      plan_type, plan_variant, NULL, NULL, NULL, NULL, NULL, NULL, 1, ordinal FROM markers
  ), assigned AS (
    SELECT *, MAX(ordinal) OVER (
      PARTITION BY provider, account_scope_id, limit_id
      ORDER BY observed_at, is_marker DESC, id ROWS UNBOUNDED PRECEDING
    ) AS assigned_era FROM timeline
  ), scoped AS MATERIALIZED (
    SELECT a.*, m.plan_era_key FROM assigned a JOIN markers m ON m.ordinal = a.assigned_era
    WHERE a.is_marker = 0 AND a.plan_type = m.plan_type AND a.plan_variant = m.plan_variant
      AND a.observed_at >= m.lower_bound AND (m.upper_bound IS NULL OR a.observed_at <= m.upper_bound)
  ), fitable AS (
    SELECT plan_era_key, window_duration_minutes, resets_at FROM scoped
    GROUP BY plan_era_key, window_duration_minutes, resets_at
    HAVING COUNT(DISTINCT used_percent) >= ? AND MAX(used_percent) - MIN(used_percent) >= ?
  ), surviving AS (
    SELECT s.* FROM scoped s JOIN fitable f USING (plan_era_key, window_duration_minutes, resets_at)
  ), marked AS (
    SELECT *, LAG(used_percent) OVER win AS previous, LEAD(used_percent) OVER win AS next
    FROM surviving WINDOW win AS (
      PARTITION BY plan_era_key, window_duration_minutes, resets_at, slot ORDER BY observed_at, id
    )
  ) SELECT occurrence_id, observed_at, provider, account_scope_id, limit_id,
      plan_type, plan_variant, continuity_id, plan_basis, slot, used_percent,
      window_duration_minutes, resets_at, plan_era_key
    FROM marked WHERE previous IS NULL OR next IS NULL OR previous != used_percent OR next != used_percent
    ORDER BY observed_at, id LIMIT ?`;

// Export the exact typed statements so the owning query-plan regression can
// EXPLAIN the production SQL without reconstructing a private replacement.
export const TYPED_V11_PLAN_SQL = PLAN_SQL.replace(QUOTA_INPUT, TYPED_QUOTA_INPUT);
export const TYPED_V11_QUOTA_SQL = QUOTA_SQL.replace(QUOTA_INPUT, TYPED_QUOTA_INPUT);

function markers(index: PlanAttributionIndex): string {
  return JSON.stringify(index.eras.map((era, ordinal) => [
    era.contextKey.split("|")[0], era.accountScopeId ?? "", "codex", era.planType, era.planVariant,
    era.eraKey, era.lowerBoundMs === null ? "" : new Date(era.lowerBoundMs).toISOString(),
    era.upperBoundMs === null ? null : new Date(era.upperBoundMs).toISOString(), ordinal + 1,
  ]));
}

async function sourcePin(db: D1Database, participantId: string, supplied?: V11SourcePin): Promise<V11SourcePin | null> {
  if (!supplied) return loadV11SourcePin(db, participantId);
  if (supplied.participantId !== participantId || supplied.source !== "v1.1") {
    throw new Error("v11 source pin scope mismatch");
  }
  await assertV11SourcePinCurrent(db, supplied);
  return supplied;
}

/** The closed horizon used by both the SQL reference and the resumable typed
 * reader. Dates are snapped to UTC midnight before the seven-day reset cutoff
 * is derived, so a checkpoint can be resumed without a moving wall-clock
 * boundary. */
export function v11AnalysisWindow(pin: V11SourcePin, nowMs = Date.now()): V11AnalysisWindow {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError("v11 analysis clock invalid");
  const cutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
    + "T00:00:00.000Z";
  const start = cutoff > pin.fromDay + "T00:00:00.000Z" ? cutoff : pin.fromDay + "T00:00:00.000Z";
  const domainEnd = new Date(Date.parse(pin.throughDay + "T00:00:00.000Z") + DAY_MS).toISOString();
  const analysisEnd = new Date(Date.parse(cutoff) + MAX_USAGE_DAYS * DAY_MS).toISOString();
  const end = domainEnd < analysisEnd ? domainEnd : analysisEnd;
  return { cutoff, start, end, resetsAtCutoff: new Date(Date.parse(cutoff) + WEEK_MS).toISOString() };
}

/** Bind a completed acquisition to the exact pin and horizon before any fit or
 * composition kernel consumes it. The fingerprint is the source dependency;
 * the method version also invalidates old checkpoint formats. */
export function createV11QuotaAcquisitionIdentity(
  pin: V11SourcePin,
  nowMs = Date.now(),
  maxQuotaRows = MAX_DOWNSAMPLED_QUOTA_ROWS,
): V11QuotaAcquisitionIdentity {
  const window = v11AnalysisWindow(pin, nowMs);
  if (!Number.isSafeInteger(maxQuotaRows) || maxQuotaRows < 1 || maxQuotaRows > MAX_DOWNSAMPLED_QUOTA_ROWS) {
    throw new TypeError("v11 acquisition quota bound invalid");
  }
  return { participantId: pin.participantId, inputFingerprint: pin.fingerprint,
    sourceMethodVersion: V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
    observedAtCutoff: window.start, resetsAtCutoff: window.resetsAtCutoff,
    windowMinutes: SEVEN_DAY_WINDOW_MINUTES, maxQuotaRows };
}

async function quotaContext(db: D1Database, pin: V11SourcePin, options: V11AnalysisOptions): Promise<Context | Refusal> {
  const nowMs = options.nowMs ?? Date.now();
  const window = v11AnalysisWindow(pin, nowMs);
  const { start, end } = window;
  const maximum = options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_DOWNSAMPLED_QUOTA_ROWS) {
    throw new TypeError("v11 analysis quota bound invalid");
  }
  let index: PlanAttributionIndex;
  let quotaRows: readonly QuotaRow[];
  if (options.quotaAcquisition !== undefined) {
    const identity = createV11QuotaAcquisitionIdentity(pin, nowMs, maximum);
    const acquisition = options.quotaAcquisition;
    if (!validateV11CompletedQuotaAcquisition(acquisition)
        || !v11QuotaAcquisitionIdentityMatches(acquisition.identity, identity)
        || acquisition.planAnchors.some((row) => row.observedAtMs < Date.parse(start)
          || row.observedAtMs >= Date.parse(end))
        || acquisition.quotaRows.some((row) => Date.parse(row.observed_at) < Date.parse(start)
          || Date.parse(row.observed_at) >= Date.parse(end))) {
      throw new Error("v11 acquired quota evidence mismatch");
    }
    index = buildPlanAttributionIndex(acquisition.planAnchors);
    if (index.status !== "ready") return refused("plan_attribution_limit_exceeded");
    quotaRows = acquisition.quotaRows;
    if (quotaRows.length > identity.maxQuotaRows) return refused("downsampled_quota_limit_exceeded");
  } else {
    const bindings = [pin.participantId, pin.generationId, start.slice(0, 10), end.slice(0, 10), start, end];
    // Context/account/time are currently JSON-derived in the activated view, so
    // a predecessor query would scan the entire historical domain. Keep this
    // bounded horizon explicit and conditional until an indexed predecessor
    // lane exists; never assert a verified pre-window plan or quantity interval.
    const typed = options.typedSourceNamespace !== null && options.typedSourceNamespace !== undefined;
    const typedBindings = typed ? [
      ...bindings, options.typedSourceNamespace!, Date.parse(start), Date.parse(end),
      Uint8Array.from(encodeTypedTelemetryId(options.typedSourceNamespace!)).buffer,
      Uint8Array.from(encodeTypedTelemetryId(pin.participantId)).buffer,
    ] : bindings;
    const evidence = await db.prepare(typed ? TYPED_V11_PLAN_SQL : PLAN_SQL)
      .bind(...typedBindings, MAX_PLAN_ATTRIBUTION_ROWS + 1).all<PlanRow>();
    if (evidence.results.length > MAX_PLAN_ATTRIBUTION_ROWS) return refused("plan_attribution_limit_exceeded");
    index = buildPlanAttributionIndex(evidence.results.filter((row) => TOKEN.test(row.provider)).map((row) => ({
      contextKey: planAttributionContextKey(row.provider, row.limit_id),
      accountScopeId: row.account_scope_id || null,
      observedAtMs: Date.parse(row.observed_at), planType: row.plan_type, planVariant: row.plan_variant,
      continuityId: row.continuity_id, conflicted: row.plan_basis === "conflicted",
    })));
    if (index.status !== "ready") return refused("plan_attribution_limit_exceeded");
    const result = await db.prepare(typed ? TYPED_V11_QUOTA_SQL : QUOTA_SQL).bind(
      markers(index), ...typedBindings, SEVEN_DAY_WINDOW_MINUTES,
      window.resetsAtCutoff,
      QUOTA_CALIBRATION_POLICY.minimumBoundaries, QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp, maximum + 1,
    ).all<QuotaRow>();
    if (result.results.length > maximum) return refused("downsampled_quota_limit_exceeded");
    quotaRows = result.results;
  }
  const datasetId = "dataset:v1:" + await sha256Hex(pin.participantId + "|" + pin.generationId);
  const seeds = new Map<string, Seed>();
  const snapshots = new Map<string, QuotaSnapshotInput[]>();
  const gridSets = new Map<string, Set<number>>();
  const unknownTracks = new Map<string, string>();
  const quota: QuotaRow[] = [];
  for (const row of quotaRows) {
    if (!SLOTS.has(row.slot) || !TOKEN.test(row.plan_type) || !TOKEN.test(row.plan_variant)
        || !TOKEN.test(row.provider) || Date.parse(row.resets_at) <= Date.parse(row.observed_at)) continue;
    const accountScopeId = row.account_scope_id || null;
    const match = planEraForInterval(index, { contextKey: planAttributionContextKey(row.provider, row.limit_id),
      accountScopeId, observedAtMs: Date.parse(row.observed_at) });
    if (match.status !== "matched" || match.era.eraKey !== row.plan_era_key) continue;
    let accountTrackId = accountScopeId;
    if (accountTrackId === null) {
      accountTrackId = unknownTracks.get(row.provider) ?? "account-track:v2:"
        + await sha256Hex(pin.participantId + "|" + row.provider + "|unknown");
      unknownTracks.set(row.provider, accountTrackId);
    }
    const seed: Seed = { accountTrackId, accountScopeId, provider: row.provider,
      planType: row.plan_type, planVariant: row.plan_variant, limitId: row.limit_id,
      windowDurationMinutes: row.window_duration_minutes, policyEpoch: "v1.1", planEraKey: row.plan_era_key };
    const key = seedKey(seed);
    seeds.set(key, seed);
    if (seeds.size > MAX_TRACKS) return refused("continuity_track_limit_exceeded");
    const snapshot: QuotaSnapshotInput = {
      snapshotId: "q:v1:" + await sha256Hex(row.occurrence_id), datasetId, accountTrackId,
      provider: seed.provider, planType: seed.planType, planVariant: seed.planVariant, limitId: seed.limitId,
      slot: row.slot as QuotaSnapshotInput["slot"],
      windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
      resetsAt: row.resets_at, observedAt: row.observed_at, receivedAt: row.observed_at,
      usedPercent: row.used_percent, displayPrecision: 0, policyEpoch: seed.policyEpoch,
    };
    const bucket = snapshots.get(key) ?? [];
    bucket.push(snapshot);
    snapshots.set(key, bucket);
    const grid = gridSets.get(row.provider) ?? new Set<number>();
    grid.add(Date.parse(row.observed_at));
    gridSets.set(row.provider, grid);
    quota.push(row);
  }
  const grids = new Map([...gridSets].map(([provider, exact]) => [
    provider, { exact, ordered: [...exact].sort((a, b) => a - b) },
  ]));
  return { pin, start, end, datasetId, index, seeds, snapshots, quota, grids };
}

interface Interval { start: number; end: number }
interface UsageEvidence {
  provider: string;
  scope: string | null;
  eraKey: string | null;
  interval: Interval;
  accountBreak: boolean;
  priced: NonNullable<ReturnType<typeof priceChunkUsageRecord>>;
}

// Exact production query is exported for its query-plan regression. The day
// predicate selects one manifest; the time/occurrence tuple seeks its covering
// cursor index. Neither a growing OFFSET nor rowid insertion order is used.
export const V11_USAGE_PAGE_SQL = `
  SELECT occurrence_id, observed_at, provider, session_uuid, record_json FROM telemetry_v11_active_records
  WHERE participant_id = ? AND generation_id = ? AND stream = 'usage' AND observed_day = ?
    AND observed_at >= ? AND observed_at < ?
    AND (observed_at, occurrence_id) > (?, ?)
  ORDER BY observed_at, occurrence_id LIMIT ?`;

async function visitUsage(
  db: D1Database, context: Context, options: V11AnalysisOptions, visit: (event: UsageEvidence) => Refusal | void,
): Promise<Refusal | null> {
  const previous = new Map<string, { time: number; scope: string | null }>();
  let count = 0;
  const days = await db.prepare(`
    SELECT day_row.observed_day FROM telemetry_v11_domain_days day_row
    WHERE day_row.generation_id = ? AND day_row.observed_day >= ? AND day_row.observed_day < ?
      AND EXISTS (SELECT 1 FROM telemetry_v11_chunks c
        WHERE c.manifest_id = day_row.manifest_id AND c.stream = 'usage')
    ORDER BY day_row.observed_day LIMIT ?`).bind(
    context.pin.generationId, context.start.slice(0, 10), context.end.slice(0, 10), MAX_USAGE_DAYS + 1,
  ).all<{ observed_day: string }>();
  if (days.results.length > MAX_USAGE_DAYS) return refused("usage_day_limit_exceeded");
  for (const day of days.results) {
    let cursorTime = day.observed_day + "T00:00:00.000Z";
    let cursorId = "";
    for (;;) {
      const pageSize = options.typedSourceNamespace ? TYPED_V11_ANALYSIS_PAGE_SIZE : PAGE_SIZE;
      const result = options.typedSourceNamespace ? { results: await readTypedV11UsageAnalysisPage(db, {
        sourceNamespace: options.typedSourceNamespace,
        ...(options.generationSnapshot ? { snapshot: options.generationSnapshot,
          fenceSnapshot:!options.generationSnapshotFenced } : { pin: context.pin }), day: day.observed_day,
        from: context.start, to: context.end, afterTime: cursorTime, afterOccurrence: cursorId,
      }) } : await db.prepare(V11_USAGE_PAGE_SQL).bind(
        context.pin.participantId, context.pin.generationId, day.observed_day, context.start, context.end,
        cursorTime, cursorId, PAGE_SIZE,
      ).all<UsageRow>();
      count += result.results.length;
      if (count > (options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS)) return refused("windowed_usage_limit_exceeded");
      for (const row of result.results) {
        if (!TOKEN.test(row.provider)) continue;
        const record = parseStoredRecordJson(row.record_json);
        if (!record) return refused("invalid_attribution_record");
        let attribution: TelemetryV11Attribution;
        try { attribution = parseTelemetryV11Attribution(record.accountPlanAttribution); }
        catch { return refused("invalid_attribution_record"); }
        const scope = attribution.accountBasis === "same_source" ? attribution.accountTrackId : null;
        const end = Date.parse(row.observed_at);
        if (!Number.isSafeInteger(end)) return refused("invalid_attribution_record");
        const session = row.session_uuid === null ? null : JSON.stringify([row.provider, row.session_uuid]);
        const prior = session === null ? undefined : previous.get(session);
        if (session !== null) {
          if (!previous.has(session) && previous.size >= MAX_SESSIONS) return refused("session_interval_scope_limit_exceeded");
          previous.set(session, { time: end, scope });
        }
        const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
        if (priced === null) continue; // Same non-measurable-record DROP semantics as legacy chunks.
        const accountBreak = prior !== undefined && prior.scope !== scope;
        const match = planEraForInterval(context.index, {
          contextKey: planAttributionContextKey(row.provider, "codex"), accountScopeId: scope,
          observedAtMs: end, ...(prior ? { intervalStartMs: prior.time } : {}),
        });
        const planConflict = attribution.planBasis === "conflicted"
          || (match.status === "matched" && attribution.planBasis === "same_source_occurrence"
            && attribution.planType !== match.era.planType)
          || (match.status === "matched" && attribution.planEraId !== null
            && attribution.planEraId !== match.era.continuityId);
        const refusal = visit({ provider: row.provider, scope, accountBreak,
          eraKey: !accountBreak && !planConflict && match.status === "matched" ? match.era.eraKey : null,
          interval: { start: prior?.time ?? end, end }, priced });
        if (refusal) return refusal;
      }
      if (result.results.length < pageSize) break;
      const last = result.results[result.results.length - 1]!;
      cursorTime = last.observed_at;
      cursorId = last.occurrence_id;
    }
  }
  return null;
}

// Usage arrives in end-time order. Merge overlapping intervals immediately;
// ordinary dense histories retain a few ranges, not an object per event.
// Explicit capacity refusal protects a sparse adversarial corpus. Prefix
// maxima keep reset hazard checks O(log U), not resets x usage scans.
class Hazards {
  private entries = new Map<string, Interval[]>();
  private indexes = new Map<string, { starts: number[]; maximumEnds: number[] }>();
  private intervalCount = 0;
  exceeded = false;
  get size():number{return this.intervalCount;}
  snapshot(): Array<{ key: string; intervals: Interval[] }> {
    if (this.indexes.size > 0) throw new Error("v11 hazards already finalized");
    return [...this.entries].map(([key, intervals]) => ({ key,
      intervals: intervals.map(interval => ({ ...interval })) }));
  }
  add(key: string, interval: Interval): void {
    if (this.exceeded) return;
    const bucket = this.entries.get(key) ?? [];
    const merged = { ...interval };
    while (bucket.length > 0 && bucket[bucket.length - 1]!.end >= merged.start) {
      const last = bucket.pop()!;
      merged.start = Math.min(merged.start, last.start);
      merged.end = Math.max(merged.end, last.end);
      this.intervalCount -= 1;
    }
    bucket.push(merged);
    this.intervalCount += 1;
    if (this.intervalCount > MAX_HAZARD_INTERVALS) this.exceeded = true;
    this.entries.set(key, bucket);
  }
  overlaps(key: string, first: number, last: number): boolean {
    let index = this.indexes.get(key);
    if (!index) {
      const rows = this.entries.get(key);
      if (!rows) return false;
      rows.sort((a, b) => a.start - b.start || a.end - b.end);
      let maximum = -Infinity;
      index = { starts: [], maximumEnds: [] };
      for (const row of rows) {
        maximum = Math.max(maximum, row.end);
        index.starts.push(row.start);
        index.maximumEnds.push(maximum);
      }
      this.entries.delete(key);
      this.indexes.set(key, index);
    }
    let low = 0;
    let high = index.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index.starts[middle]! <= last) low = middle + 1;
      else high = middle;
    }
    return low > 0 && index.maximumEnds[low - 1]! >= first;
  }
}

function ceiling(grid: number[], value: number): number | null {
  let low = 0;
  let high = grid.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (grid[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return grid[low] ?? null;
}

interface CostBucket { provider: string; scope: string | null; eraKey: string; placement: number;
  costNanousd: number; fullyPriced: boolean }

async function scalarAnalysis(db: D1Database, context: Context, options: V11AnalysisOptions): Promise<object> {
  if (context.seeds.size === 0) return refused("supported_quota_track_unavailable");
  const hazards = new Hazards();
  const buckets = new Map<string, CostBucket>();
  const knownTargets = new Set([...context.seeds.values()]
    .filter((seed) => seed.accountScopeId !== null).map((seed) => seed.provider));
  const unknownTargets = new Set([...context.seeds.values()]
    .filter((seed) => seed.accountScopeId === null).map((seed) => seed.provider));
  const readRefusal = await visitUsage(db, context, options, (event) => {
    if (!context.grids.has(event.provider)) return;
    const ownKey = scopeKey(event.provider, event.scope);
    if (event.accountBreak) hazards.add("all|" + event.provider, event.interval);
    else {
      // Unknown may be A: never turn 20 linked + 80 unknown into a 20-only fit.
      // Conversely, a positively declared coherent B increment is excluded
      // from A, not turned into an "incompatible included" poison count.
      if ((event.scope === null && knownTargets.has(event.provider))
          || (event.scope !== null && unknownTargets.has(event.provider))) {
        hazards.add((event.scope === null ? "unknown|" : "known|") + event.provider, event.interval);
      }
      if (event.eraKey === null) hazards.add(ownKey, event.interval);
    }
    if (hazards.exceeded) return refused("attribution_hazard_limit_exceeded");
    if (event.eraKey === null) return;
    const grid = context.grids.get(event.provider)!;
    const exact = grid.exact.has(event.interval.end);
    const anchor = exact ? event.interval.end : ceiling(grid.ordered, event.interval.end);
    if (anchor === null) return;
    const key = JSON.stringify([event.provider, event.scope, event.eraKey, exact ? "s" : "b", anchor]);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.placement = Math.max(bucket.placement, event.interval.end);
      bucket.costNanousd += event.priced.costNanousd;
      bucket.fullyPriced &&= event.priced.pricingStatus === "fully_priced";
      if (!Number.isSafeInteger(bucket.costNanousd) || bucket.costNanousd > 90_000_000_000_000) {
        return refused("usage_cost_limit_exceeded");
      }
    } else {
      buckets.set(key, { provider: event.provider, scope: event.scope, eraKey: event.eraKey,
        placement: event.interval.end, costNanousd: event.priced.costNanousd,
        fullyPriced: event.priced.pricingStatus === "fully_priced" });
      if (buckets.size > MAX_USAGE_BUCKETS) return refused("reduced_usage_limit_exceeded");
      if (!Number.isSafeInteger(event.priced.costNanousd) || event.priced.costNanousd > 90_000_000_000_000) {
        return refused("usage_cost_limit_exceeded");
      }
    }
  });
  if (readRefusal) return readRefusal;
  const eventsByEra = new Map<string, QuotaUsageEventInput[]>();
  const seedByEra = new Map([...context.seeds.values()].map((seed) => [seed.planEraKey, seed]));
  for (const [key, bucket] of buckets) {
    const seed = seedByEra.get(bucket.eraKey);
    if (!seed) continue;
    const events = eventsByEra.get(bucket.eraKey) ?? [];
    events.push({ eventId: "u:v1:" + await sha256Hex(key), datasetId: context.datasetId,
      accountTrackId: seed.accountTrackId, provider: seed.provider, planType: seed.planType,
      planVariant: seed.planVariant, limitId: seed.limitId, policyEpoch: seed.policyEpoch,
      observedAt: new Date(bucket.placement).toISOString(), costNanousd: bucket.costNanousd,
      pricingStatus: bucket.fullyPriced ? "fully_priced" : "partially_priced" });
    eventsByEra.set(bucket.eraKey, events);
  }
  const tracks = [];
  for (const [key, seed] of context.seeds) {
    const evidence = buildResetEvidence({
      datasets: [{ datasetId: context.datasetId, complete: true }],
      quotaSnapshots: context.snapshots.get(key)!, usageEvents: eventsByEra.get(seed.planEraKey) ?? [],
    });
    const excluded = evidence.resets.filter((reset) => {
      const first = Date.parse(reset.firstObservedAt);
      const last = Date.parse(reset.lastObservedAt);
      return hazards.overlaps("all|" + seed.provider, first, last)
        || hazards.overlaps(scopeKey(seed.provider, seed.accountScopeId), first, last)
        || hazards.overlaps((seed.accountScopeId === null ? "known|" : "unknown|") + seed.provider, first, last);
    });
    const excludedKeys = new Set(excluded.map((reset) => reset.resetKey));
    const resets = evidence.resets.filter((reset) => !excludedKeys.has(reset.resetKey));
    tracks.push({ continuity: seed,
      calibration: analyzeQuotaCalibration({ ...evidence, resetCount: resets.length, resets }),
      attribution: { status: "legacy_conditional", accountScope: seed.accountScopeId === null ? "unknown" : "declared",
        quantityBinding: "conditional_no_wire_interval", planEvidenceScope: "bounded_analysis_window",
        planEvidenceStart: context.start, planEraKey: seed.planEraKey,
        refusedResets: excluded.map((reset) => ({ resetKey: reset.resetKey,
          firstObservedAt: reset.firstObservedAt, lastObservedAt: reset.lastObservedAt,
          reason: "usage_attribution_unresolved" })) },
    });
  }
  return { schemaVersion: "account-scoped-quota-analysis-v0.1", status: "ready",
    fragmentSelection: "unselected_diagnostics", tracks };
}

export async function accountScopedQuotaAnalysisV11(
  db: D1Database, participantId: string, options: V11AnalysisOptions = {},
): Promise<object> {
  options = { ...options, typedSourceNamespace: await typedTelemetryReadNamespace(db) };
  const pin = await sourcePin(db, participantId, options.sourcePin);
  if (!pin) return refused("activated_attribution_domain_unavailable");
  const context = await quotaContext(db, pin, options);
  const analysis = "status" in context ? context : await scalarAnalysis(db, context, options);
  await assertV11SourcePinCurrent(db, pin);
  return { ...analysis, attributionMethod: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION, inputFingerprint: pin.fingerprint };
}

async function compositionAnalysis(
  db: D1Database, context: Context, options: V11AnalysisOptions,
): Promise<V1ModelCompositionResult> {
  const plans = new Set(context.index.eras.map((era) => era.planType));
  if (plans.size > 1 || context.index.conflicts.length > 0) return refused("multi_plan_window_unsupported");
  const accounts = new Set(context.index.eras.map((era) => era.accountScopeId));
  if (accounts.size > 1) return refused("multi_account_window_unsupported");
  // The existing composition kernel has no continuity dimension. Refuse a
  // same-plan-era change rather than silently bridge it or inflate participants.
  if (context.index.eras.length > 1) return refused("multi_era_window_unsupported");
  if (context.seeds.size === 0) return refused("supported_quota_track_unavailable");
  const seed = context.seeds.values().next().value!;
  const quotaRows: CompositionQuotaRow[] = context.quota.map((row) => ({
    observedAtMs: Date.parse(row.observed_at), resetsAtMs: Date.parse(row.resets_at),
    usedPercent: row.used_percent, planType: row.plan_type,
  }));
  const grain = MODEL_COMPOSITION_POLICY.grainMs;
  const costs = new Map<string, { observedAtMs: number; model: string; costNanousd: number }>();
  const poisoned = new Set<number>();
  let usageEventCount = 0;
  let unpricedUsageEventCount = 0;
  let attributionUnresolved = false;
  const readRefusal = await visitUsage(db, context, options, (event) => {
    if (event.provider !== seed.provider) return;
    if (event.scope !== null && seed.accountScopeId !== null && event.scope !== seed.accountScopeId
        && !event.accountBreak && event.eraKey !== null) return;
    if (event.scope !== seed.accountScopeId || event.accountBreak || event.eraKey !== seed.planEraKey) {
      attributionUnresolved = true;
      return;
    }
    const observedAtMs = Math.floor(event.interval.end / grain) * grain;
    if (event.priced.pricingStatus !== "fully_priced") {
      poisoned.add(observedAtMs);
      unpricedUsageEventCount += 1;
      return;
    }
    usageEventCount += 1;
    if (!Number.isSafeInteger(event.priced.costNanousd) || event.priced.costNanousd > 90_000_000_000_000) {
      return refused("usage_cost_limit_exceeded");
    }
    const model = event.priced.modelId ?? "unknown";
    const key = JSON.stringify([observedAtMs, model]);
    const existing = costs.get(key);
    if (existing) {
      existing.costNanousd += event.priced.costNanousd;
      if (!Number.isSafeInteger(existing.costNanousd) || existing.costNanousd > 90_000_000_000_000) {
        return refused("usage_cost_limit_exceeded");
      }
    }
    else costs.set(key, { observedAtMs, model, costNanousd: event.priced.costNanousd });
    if (costs.size > MAX_USAGE_BUCKETS) return refused("reduced_usage_limit_exceeded");
  });
  if (readRefusal) return readRefusal;
  if (attributionUnresolved) return refused("usage_attribution_unresolved");
  const usageRows: CompositionUsageRow[] = [...costs.values()]
    .filter((row) => row.costNanousd > 0 && !poisoned.has(row.observedAtMs))
    .map((row) => ({ observedAtMs: row.observedAtMs, model: row.model, costUsd: row.costNanousd / 1_000_000_000 }));
  const corpus = buildCompositionObservations({ quotaRows, usageRows });
  return { status: "ready", planType: seed.planType, fit: calibrateCompositionCapacities(corpus.observations),
    voidedBinCount: corpus.voidedBinCount, poolCount: corpus.poolCount, quotaRowCount: quotaRows.length,
    usageEventCount, unpricedUsageEventCount, poisonedBinCount: poisoned.size,
    latestQuotaObservedAt: context.quota[context.quota.length - 1]!.observed_at,
    attributionStatus: "legacy_conditional", attributionMethod: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: context.pin.fingerprint };
}

export async function accountScopedModelCompositionV11(
  db: D1Database, participantId: string, options: V11AnalysisOptions = {},
): Promise<V1ModelCompositionResult> {
  options = { ...options, typedSourceNamespace: await typedTelemetryReadNamespace(db) };
  const pin = await sourcePin(db, participantId, options.sourcePin);
  if (!pin) return refused("activated_attribution_domain_unavailable");
  const context = await quotaContext(db, pin, options);
  const analysis = "status" in context ? context : await compositionAnalysis(db, context, options);
  await assertV11SourcePinCurrent(db, pin);
  return analysis;
}

/** Compact, replayable state for the single v1.1 usage traversal shared by the
 * scalar fit and model-composition finishers.  It retains only session tails,
 * merged attribution hazards, quota-grid cost buckets and model-grain cost
 * buckets. Raw usage records are never copied into the analytics database. */
export interface V11UsageReductionCheckpoint {
  version: 1;
  identity: V11QuotaAcquisitionIdentity;
  days: string[];
  dayIndex: number;
  cursorTime: string;
  cursorOccurrence: string;
  rowsRead: number;
  complete: boolean;
  commonRefusal: string | null;
  scalarRefusal: string | null;
  modelRefusal: string | null;
  previous: Array<{ key: string; time: number; scope: string | null }>;
  hazards: Array<{ key: string; intervals: Interval[] }>;
  scalarBuckets: Array<{ key: string; value: CostBucket }>;
  modelCosts: Array<{ key: string; observedAtMs: number; model: string; costNanousd: number }>;
  poisoned: number[];
  usageEventCount: number;
  unpricedUsageEventCount: number;
  attributionUnresolved: boolean;
}

export interface V11UsageReductionBudget {
  remainingQueries: number;
  deadlineMs: number;
  now?: () => number;
}

export const V11_USAGE_REDUCTION_COMPONENTS = ["usagePrevious","usageHazards","usageScalarBuckets",
  "usageModelCosts","usagePoisoned"] as const;

export function encodeV11UsageReductionCheckpoint(checkpoint:V11UsageReductionCheckpoint):{
  control:Omit<V11UsageReductionCheckpoint,"previous"|"hazards"|"scalarBuckets"|"modelCosts"|"poisoned">;
  components:Record<(typeof V11_USAGE_REDUCTION_COMPONENTS)[number],unknown[]>;
}{
  if(!validateV11UsageReductionCheckpoint(checkpoint))throw new Error("v11 usage reduction checkpoint invalid");
  const {previous,hazards,scalarBuckets,modelCosts,poisoned,...control}=structuredClone(checkpoint);
  return {control,components:{usagePrevious:previous,usageHazards:hazards,usageScalarBuckets:scalarBuckets,
    usageModelCosts:modelCosts,usagePoisoned:poisoned}};
}

export function decodeV11UsageReductionCheckpoint(control:unknown,components:Record<string,unknown[]>):V11UsageReductionCheckpoint{
  if(!control||typeof control!=="object"||Object.keys(components).some(key=>
    !V11_USAGE_REDUCTION_COMPONENTS.includes(key as (typeof V11_USAGE_REDUCTION_COMPONENTS)[number])))
    throw new Error("v11 usage reduction checkpoint invalid");
  const checkpoint={...(control as Omit<V11UsageReductionCheckpoint,"previous"|"hazards"|"scalarBuckets"|"modelCosts"|"poisoned">),
    previous:components.usagePrevious??[],hazards:components.usageHazards??[],
    scalarBuckets:components.usageScalarBuckets??[],modelCosts:components.usageModelCosts??[],
    poisoned:components.usagePoisoned??[]} as V11UsageReductionCheckpoint;
  if(!validateV11UsageReductionCheckpoint(checkpoint))throw new Error("v11 usage reduction checkpoint invalid");
  return checkpoint;
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Closed validation is used again by the durable checkpoint decoder. */
export function validateV11UsageReductionCheckpoint(value: unknown): value is V11UsageReductionCheckpoint {
  if (!value || typeof value !== "object") return false;
  const row = value as V11UsageReductionCheckpoint;
  if (Object.keys(row).sort().join(",") !== ["attributionUnresolved","commonRefusal","complete","cursorOccurrence",
    "cursorTime","dayIndex","days","hazards","modelCosts","modelRefusal","poisoned","previous","rowsRead",
    "scalarBuckets","scalarRefusal","unpricedUsageEventCount","usageEventCount","version","identity"].sort().join(",")
      || row.version !== 1 || !row.identity || typeof row.identity!=="object"
      || !Array.isArray(row.days) || row.days.length > MAX_USAGE_DAYS
      || row.days.some((day, index) => !/^\d{4}-\d{2}-\d{2}$/u.test(day)
        || index > 0 && row.days[index - 1]! >= day)
      || !safeCount(row.dayIndex, row.days.length) || typeof row.cursorTime !== "string"
      || !Number.isSafeInteger(Date.parse(row.cursorTime)) || typeof row.cursorOccurrence !== "string"
      || !safeCount(row.rowsRead, MAX_WINDOWED_USAGE_ROWS) || typeof row.complete !== "boolean"
      || ![row.commonRefusal,row.scalarRefusal,row.modelRefusal].every(reason => reason === null
        || typeof reason === "string" && TOKEN.test(reason))
      || !Array.isArray(row.previous) || row.previous.length > MAX_SESSIONS
      || row.previous.some(entry => !entry || typeof entry.key !== "string" || !Number.isSafeInteger(entry.time)
        || entry.scope !== null && typeof entry.scope !== "string")
      || !Array.isArray(row.hazards) || row.hazards.reduce((n, entry) => n + (entry?.intervals?.length ?? MAX_HAZARD_INTERVALS + 1), 0) > MAX_HAZARD_INTERVALS
      || row.hazards.some(entry => !entry || typeof entry.key !== "string" || !Array.isArray(entry.intervals)
        || entry.intervals.some(interval => !Number.isSafeInteger(interval?.start)
          || !Number.isSafeInteger(interval?.end) || interval.start > interval.end))
      || !Array.isArray(row.scalarBuckets) || row.scalarBuckets.length > MAX_USAGE_BUCKETS
      || row.scalarBuckets.some(entry => !entry || typeof entry.key !== "string" || !entry.value
        || typeof entry.value.provider !== "string" || entry.value.scope !== null && typeof entry.value.scope !== "string"
        || typeof entry.value.eraKey !== "string" || !Number.isSafeInteger(entry.value.placement)
        || !safeCount(entry.value.costNanousd, 90_000_000_000_000) || typeof entry.value.fullyPriced !== "boolean")
      || !Array.isArray(row.modelCosts) || row.modelCosts.length > MAX_USAGE_BUCKETS
      || row.modelCosts.some(entry => !entry || typeof entry.key !== "string" || typeof entry.model !== "string"
        || !Number.isSafeInteger(entry.observedAtMs) || !safeCount(entry.costNanousd, 90_000_000_000_000))
      || !Array.isArray(row.poisoned) || row.poisoned.length > MAX_USAGE_BUCKETS
      || row.poisoned.some(time => !Number.isSafeInteger(time))
      || !safeCount(row.usageEventCount, MAX_WINDOWED_USAGE_ROWS)
      || !safeCount(row.unpricedUsageEventCount, MAX_WINDOWED_USAGE_ROWS)
      || typeof row.attributionUnresolved !== "boolean") return false;
  return new Set(row.previous.map(entry => entry.key)).size === row.previous.length
    && new Set(row.hazards.map(entry => entry.key)).size === row.hazards.length
    && new Set(row.scalarBuckets.map(entry => entry.key)).size === row.scalarBuckets.length
    && new Set(row.modelCosts.map(entry => entry.key)).size === row.modelCosts.length
    && new Set(row.poisoned).size === row.poisoned.length;
}

function sortedReduction(state: V11UsageReductionCheckpoint): V11UsageReductionCheckpoint {
  state.previous.sort((a, b) => a.key.localeCompare(b.key));
  state.hazards.sort((a, b) => a.key.localeCompare(b.key));
  state.scalarBuckets.sort((a, b) => a.key.localeCompare(b.key));
  state.modelCosts.sort((a, b) => a.key.localeCompare(b.key));
  state.poisoned.sort((a, b) => a - b);
  return state;
}

function reductionHazards(state: V11UsageReductionCheckpoint): Hazards {
  const hazards = new Hazards();
  for (const entry of state.hazards) for (const interval of entry.intervals) hazards.add(entry.key, interval);
  return hazards;
}

function serializeHazards(hazards: Hazards): V11UsageReductionCheckpoint["hazards"] {
  return hazards.snapshot();
}

function reductionPayloadBytes(previous:Map<string,{time:number;scope:string|null}>,hazards:Hazards,
  scalarBuckets:Map<string,CostBucket>,modelCosts:Map<string,{observedAtMs:number;model:string;costNanousd:number}>,
  poisoned:Set<number>):number{
  const payload=JSON.stringify({previous:[...previous],hazards:serializeHazards(hazards),
    scalarBuckets:[...scalarBuckets],modelCosts:[...modelCosts],poisoned:[...poisoned]});
  return new TextEncoder().encode(payload).byteLength;
}

async function usageDays(db: D1Database, context: Context): Promise<string[] | Refusal> {
  const rows = (await db.prepare(`SELECT day_row.observed_day FROM telemetry_v11_domain_days day_row
    WHERE day_row.generation_id = ? AND day_row.observed_day >= ? AND day_row.observed_day < ?
      AND EXISTS (SELECT 1 FROM telemetry_v11_chunks c
        WHERE c.manifest_id = day_row.manifest_id AND c.stream = 'usage')
    ORDER BY day_row.observed_day LIMIT ?`).bind(context.pin.generationId, context.start.slice(0, 10),
      context.end.slice(0, 10), MAX_USAGE_DAYS + 1).all<{ observed_day: string }>()).results;
  return rows.length > MAX_USAGE_DAYS ? refused("usage_day_limit_exceeded") : rows.map(row => row.observed_day);
}

async function usageEvent(context: Context, previous: Map<string, { time: number; scope: string | null }>,
  row: UsageRow): Promise<UsageEvidence | Refusal | null> {
  if (!TOKEN.test(row.provider)) return null;
  const record = parseStoredRecordJson(row.record_json);
  if (!record) return refused("invalid_attribution_record");
  let attribution: TelemetryV11Attribution;
  try { attribution = parseTelemetryV11Attribution(record.accountPlanAttribution); }
  catch { return refused("invalid_attribution_record"); }
  const scope = attribution.accountBasis === "same_source" ? attribution.accountTrackId : null;
  const end = Date.parse(row.observed_at);
  if (!Number.isSafeInteger(end)) return refused("invalid_attribution_record");
  const session = row.session_uuid === null ? null : JSON.stringify([row.provider, row.session_uuid]);
  const prior = session === null ? undefined : previous.get(session);
  if (session !== null) {
    if (!previous.has(session) && previous.size >= MAX_SESSIONS) return refused("session_interval_scope_limit_exceeded");
    previous.set(session, { time: end, scope });
  }
  const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
  if (priced === null) return null;
  const accountBreak = prior !== undefined && prior.scope !== scope;
  const match = planEraForInterval(context.index, { contextKey: planAttributionContextKey(row.provider, "codex"),
    accountScopeId: scope, observedAtMs: end, ...(prior ? { intervalStartMs: prior.time } : {}) });
  const planConflict = attribution.planBasis === "conflicted"
    || match.status === "matched" && attribution.planBasis === "same_source_occurrence"
      && attribution.planType !== match.era.planType
    || match.status === "matched" && attribution.planEraId !== null
      && attribution.planEraId !== match.era.continuityId;
  return { provider: row.provider, scope, accountBreak,
    eraKey: !accountBreak && !planConflict && match.status === "matched" ? match.era.eraKey : null,
    interval: { start: prior?.time ?? end, end }, priced };
}

interface UsageReductionRuntime {
  knownTargets:Set<string>;
  unknownTargets:Set<string>;
  modelSeed:Seed|undefined;
  modelRefusal:string|null;
}

function usageReductionRuntime(context:Context):UsageReductionRuntime{
 const plans=new Set(context.index.eras.map(era=>era.planType));
 const accounts=new Set(context.index.eras.map(era=>era.accountScopeId));
 const modelRefusal=plans.size>1||context.index.conflicts.length>0?"multi_plan_window_unsupported"
  :accounts.size>1?"multi_account_window_unsupported":context.index.eras.length>1?"multi_era_window_unsupported"
  :context.seeds.size===0?"supported_quota_track_unavailable":null;
 return {knownTargets:new Set([...context.seeds.values()].filter(seed=>seed.accountScopeId!==null).map(seed=>seed.provider)),
  unknownTargets:new Set([...context.seeds.values()].filter(seed=>seed.accountScopeId===null).map(seed=>seed.provider)),
  modelSeed:context.seeds.values().next().value as Seed|undefined,modelRefusal};
}

function reduceScalar(context: Context, runtime:UsageReductionRuntime,state: V11UsageReductionCheckpoint, hazards: Hazards,
  buckets: Map<string, CostBucket>, event: UsageEvidence): void {
  if (state.scalarRefusal || !context.grids.has(event.provider)) return;
  const ownKey = scopeKey(event.provider, event.scope);
  if (event.accountBreak) hazards.add("all|" + event.provider, event.interval);
  else {
    if (event.scope === null && runtime.knownTargets.has(event.provider)
        || event.scope !== null && runtime.unknownTargets.has(event.provider)) {
      hazards.add((event.scope === null ? "unknown|" : "known|") + event.provider, event.interval);
    }
    if (event.eraKey === null) hazards.add(ownKey, event.interval);
  }
  if (hazards.exceeded) { state.scalarRefusal = "attribution_hazard_limit_exceeded"; return; }
  if (event.eraKey === null) return;
  const grid = context.grids.get(event.provider)!;
  const exact = grid.exact.has(event.interval.end);
  const anchor = exact ? event.interval.end : ceiling(grid.ordered, event.interval.end);
  if (anchor === null) return;
  const key = JSON.stringify([event.provider, event.scope, event.eraKey, exact ? "s" : "b", anchor]);
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.placement = Math.max(bucket.placement, event.interval.end);
    bucket.costNanousd += event.priced.costNanousd;
    bucket.fullyPriced &&= event.priced.pricingStatus === "fully_priced";
    if (!Number.isSafeInteger(bucket.costNanousd) || bucket.costNanousd > 90_000_000_000_000) state.scalarRefusal = "usage_cost_limit_exceeded";
  } else {
    buckets.set(key, { provider: event.provider, scope: event.scope, eraKey: event.eraKey,
      placement: event.interval.end, costNanousd: event.priced.costNanousd,
      fullyPriced: event.priced.pricingStatus === "fully_priced" });
    if (buckets.size > MAX_USAGE_BUCKETS) state.scalarRefusal = "reduced_usage_limit_exceeded";
    if (!Number.isSafeInteger(event.priced.costNanousd) || event.priced.costNanousd > 90_000_000_000_000) state.scalarRefusal = "usage_cost_limit_exceeded";
  }
}

function reduceModel(context: Context, runtime:UsageReductionRuntime,state: V11UsageReductionCheckpoint,
  costs: Map<string, { observedAtMs: number; model: string; costNanousd: number }>, poisoned: Set<number>,
  event: UsageEvidence): void {
  if (state.modelRefusal) return;
  const seed=runtime.modelSeed;
  if(runtime.modelRefusal||!seed){state.modelRefusal=runtime.modelRefusal??"supported_quota_track_unavailable";return;}
  if (event.provider !== seed.provider) return;
  if (event.scope !== null && seed.accountScopeId !== null && event.scope !== seed.accountScopeId
      && !event.accountBreak && event.eraKey !== null) return;
  if (event.scope !== seed.accountScopeId || event.accountBreak || event.eraKey !== seed.planEraKey) {
    state.attributionUnresolved = true; return;
  }
  const observedAtMs = Math.floor(event.interval.end / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
  if (event.priced.pricingStatus !== "fully_priced") {
    poisoned.add(observedAtMs); state.unpricedUsageEventCount += 1;
    if(poisoned.size>MAX_USAGE_BUCKETS)state.modelRefusal="reduced_usage_limit_exceeded";
    return;
  }
  state.usageEventCount += 1;
  if (!Number.isSafeInteger(event.priced.costNanousd) || event.priced.costNanousd > 90_000_000_000_000) {
    state.modelRefusal = "usage_cost_limit_exceeded"; return;
  }
  const model = event.priced.modelId ?? "unknown", key = JSON.stringify([observedAtMs, model]);
  const existing = costs.get(key);
  if (existing) {
    existing.costNanousd += event.priced.costNanousd;
    if (!Number.isSafeInteger(existing.costNanousd) || existing.costNanousd > 90_000_000_000_000) state.modelRefusal = "usage_cost_limit_exceeded";
  } else costs.set(key, { observedAtMs, model, costNanousd: event.priced.costNanousd });
  if (costs.size > MAX_USAGE_BUCKETS) state.modelRefusal = "reduced_usage_limit_exceeded";
}

/** Advance at most maxPages physical usage pages. The returned checkpoint is a
 * deterministic successor and can be promoted with exact-head CAS. */
export async function advanceV11UsageReduction(db: D1Database, pin: V11SourcePin,
  options: V11AnalysisOptions & { quotaAcquisition: V11CompletedQuotaAcquisition }, budget: V11UsageReductionBudget,
  prior?: V11UsageReductionCheckpoint | null, maxPages = 1,
  reductionIdentity:V11QuotaAcquisitionIdentity=options.quotaAcquisition.identity): Promise<V11UsageReductionCheckpoint> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 32 || !Number.isSafeInteger(budget.remainingQueries)
      || budget.remainingQueries < 0 || !Number.isFinite(budget.deadlineMs)) throw new Error("v11 usage reduction budget invalid");
  createV11QuotaAcquisitionCheckpoint(reductionIdentity);
  const context = await quotaContext(db, pin, options);
  if ("status" in context) {
    return { version:1, identity:structuredClone(reductionIdentity),days:[], dayIndex:0, cursorTime:options.quotaAcquisition.identity.observedAtCutoff,
      cursorOccurrence:"", rowsRead:0, complete:true, commonRefusal:context.reason, scalarRefusal:null,
      modelRefusal:null, previous:[], hazards:[], scalarBuckets:[], modelCosts:[], poisoned:[],
      usageEventCount:0, unpricedUsageEventCount:0, attributionUnresolved:false };
  }
  const runtime=usageReductionRuntime(context);
  const checkpointByteLimit=options.maxUsageCheckpointBytes??MAX_V11_USAGE_CHECKPOINT_BYTES;
  if(!Number.isSafeInteger(checkpointByteLimit)||checkpointByteLimit<64*1024
    ||checkpointByteLimit>MAX_V11_USAGE_CHECKPOINT_BYTES)throw new Error("v11 usage reduction checkpoint byte limit invalid");
  let state = prior ? structuredClone(prior) : null;
  if (state && (!validateV11UsageReductionCheckpoint(state)
      ||!v11QuotaAcquisitionIdentityMatches(state.identity,reductionIdentity)))
    throw new Error("v11 usage reduction checkpoint invalid");
  const now = budget.now ?? Date.now;
  if (!state) {
    if (budget.remainingQueries < 1 || now() >= budget.deadlineMs) throw new Error("v11 usage reduction initialization unavailable");
    budget.remainingQueries -= 1;
    const selected = await usageDays(db, context);
    if (!Array.isArray(selected)) return { version:1,identity:structuredClone(reductionIdentity),days:[], dayIndex:0, cursorTime:context.start,
      cursorOccurrence:"", rowsRead:0, complete:true, commonRefusal:selected.reason, scalarRefusal:null,
      modelRefusal:null, previous:[], hazards:[], scalarBuckets:[], modelCosts:[], poisoned:[],
      usageEventCount:0, unpricedUsageEventCount:0, attributionUnresolved:false };
    state = { version:1,identity:structuredClone(reductionIdentity),days:selected, dayIndex:0, cursorTime:selected[0] ? `${selected[0]}T00:00:00.000Z` : context.start,
      cursorOccurrence:"", rowsRead:0, complete:selected.length===0, commonRefusal:null,
      scalarRefusal:context.seeds.size===0?"supported_quota_track_unavailable":null,
      modelRefusal:runtime.modelRefusal,
      previous:[], hazards:[], scalarBuckets:[], modelCosts:[], poisoned:[], usageEventCount:0,
      unpricedUsageEventCount:0, attributionUnresolved:false };
  }
  if (state.complete) return sortedReduction(state);
  const previous = new Map(state.previous.map(entry => [entry.key, { time:entry.time, scope:entry.scope }]));
  const hazards = reductionHazards(state);
  const scalarBuckets = new Map(state.scalarBuckets.map(entry => [entry.key, { ...entry.value }]));
  const modelCosts = new Map(state.modelCosts.map(entry => [entry.key,
    { observedAtMs:entry.observedAtMs, model:entry.model, costNanousd:entry.costNanousd }]));
  const poisoned = new Set(state.poisoned);
  const maximum = options.maxWindowedUsageRows ?? MAX_WINDOWED_USAGE_ROWS;
  for (let page = 0; page < maxPages && state.dayIndex < state.days.length; page += 1) {
    if (budget.remainingQueries < 1 || now() >= budget.deadlineMs) break;
    const day = state.days[state.dayIndex]!;
    budget.remainingQueries -= 1;
    const rows = options.typedSourceNamespace ? await readTypedV11UsageAnalysisPage(db, { sourceNamespace:options.typedSourceNamespace,
      ...(options.generationSnapshot ? { snapshot:options.generationSnapshot,
        fenceSnapshot:!options.generationSnapshotFenced } : { pin }),
      day, from:context.start, to:context.end, afterTime:state.cursorTime, afterOccurrence:state.cursorOccurrence })
      : (await db.prepare(V11_USAGE_PAGE_SQL).bind(pin.participantId,pin.generationId,day,context.start,context.end,
        state.cursorTime,state.cursorOccurrence,PAGE_SIZE).all<UsageRow>()).results;
    if(rows.length>maximum-state.rowsRead){state.rowsRead=maximum;state.commonRefusal="windowed_usage_limit_exceeded";
      state.complete=true;break;}
    state.rowsRead += rows.length;
    for (const row of rows) {
      const event = await usageEvent(context, previous, row);
      if (event && "status" in event) { state.commonRefusal = event.reason; state.complete = true; break; }
      if (!event) continue;
      reduceScalar(context,runtime,state,hazards,scalarBuckets,event);
      reduceModel(context,runtime,state,modelCosts,poisoned,event);
    }
    const retainedEntries=previous.size+hazards.size+scalarBuckets.size+modelCosts.size+poisoned.size;
    if((checkpointByteLimit<MAX_V11_USAGE_CHECKPOINT_BYTES||retainedEntries>4096)
      &&reductionPayloadBytes(previous,hazards,scalarBuckets,modelCosts,poisoned)>checkpointByteLimit){
      state.commonRefusal="reduced_usage_limit_exceeded";state.complete=true;break;
    }
    if (state.complete) break;
    const pageSize = options.typedSourceNamespace ? TYPED_V11_ANALYSIS_PAGE_SIZE : PAGE_SIZE;
    if (rows.length < pageSize) {
      state.dayIndex += 1;
      state.cursorTime = state.days[state.dayIndex] ? `${state.days[state.dayIndex]}T00:00:00.000Z` : context.end;
      state.cursorOccurrence = "";
    } else {
      const last = rows[rows.length - 1]!;
      state.cursorTime = last.observed_at; state.cursorOccurrence = last.occurrence_id;
    }
  }
  state.complete ||= state.dayIndex >= state.days.length;
  state.previous = state.commonRefusal?[]:[...previous].map(([key,value]) => ({ key,...value }));
  state.hazards = state.commonRefusal||state.scalarRefusal?[]:serializeHazards(hazards);
  state.scalarBuckets = state.commonRefusal||state.scalarRefusal?[]:
    [...scalarBuckets].map(([key,value]) => ({ key,value }));
  state.modelCosts = state.commonRefusal||state.modelRefusal?[]:
    [...modelCosts].map(([key,value]) => ({ key,...value }));
  state.poisoned = state.commonRefusal||state.modelRefusal?[]:[...poisoned];
  const sorted = sortedReduction(state);
  if (!validateV11UsageReductionCheckpoint(sorted)) throw new Error("v11 usage reduction successor invalid");
  return sorted;
}

async function scalarFromReduction(context: Context, state: V11UsageReductionCheckpoint): Promise<object> {
  const reason = state.commonRefusal ?? state.scalarRefusal;
  if (reason) return refused(reason);
  const hazards = reductionHazards(state), eventsByEra = new Map<string, QuotaUsageEventInput[]>();
  const seedByEra = new Map([...context.seeds.values()].map(seed => [seed.planEraKey,seed]));
  for (const {key,value:bucket} of state.scalarBuckets) {
    const seed=seedByEra.get(bucket.eraKey);if(!seed)continue;
    const events=eventsByEra.get(bucket.eraKey)??[];
    events.push({eventId:"u:v1:"+await sha256Hex(key),datasetId:context.datasetId,accountTrackId:seed.accountTrackId,
      provider:seed.provider,planType:seed.planType,planVariant:seed.planVariant,limitId:seed.limitId,
      policyEpoch:seed.policyEpoch,observedAt:new Date(bucket.placement).toISOString(),costNanousd:bucket.costNanousd,
      pricingStatus:bucket.fullyPriced?"fully_priced":"partially_priced"});eventsByEra.set(bucket.eraKey,events);
  }
  const tracks=[];
  for(const [key,seed] of context.seeds){const evidence=buildResetEvidence({datasets:[{datasetId:context.datasetId,complete:true}],
    quotaSnapshots:context.snapshots.get(key)!,usageEvents:eventsByEra.get(seed.planEraKey)??[]});
    const excluded=evidence.resets.filter(reset=>{const first=Date.parse(reset.firstObservedAt),last=Date.parse(reset.lastObservedAt);
      return hazards.overlaps("all|"+seed.provider,first,last)||hazards.overlaps(scopeKey(seed.provider,seed.accountScopeId),first,last)
        ||hazards.overlaps((seed.accountScopeId===null?"known|":"unknown|")+seed.provider,first,last);});
    const excludedKeys=new Set(excluded.map(reset=>reset.resetKey)),resets=evidence.resets.filter(reset=>!excludedKeys.has(reset.resetKey));
    tracks.push({continuity:seed,calibration:analyzeQuotaCalibration({...evidence,resetCount:resets.length,resets}),
      attribution:{status:"legacy_conditional",accountScope:seed.accountScopeId===null?"unknown":"declared",
        quantityBinding:"conditional_no_wire_interval",planEvidenceScope:"bounded_analysis_window",planEvidenceStart:context.start,
        planEraKey:seed.planEraKey,refusedResets:excluded.map(reset=>({resetKey:reset.resetKey,firstObservedAt:reset.firstObservedAt,
          lastObservedAt:reset.lastObservedAt,reason:"usage_attribution_unresolved"}))}});}
  return {schemaVersion:"account-scoped-quota-analysis-v0.1",status:"ready",fragmentSelection:"unselected_diagnostics",tracks};
}

function modelFromReduction(context: Context, state: V11UsageReductionCheckpoint): V1ModelCompositionResult {
  const reason=state.commonRefusal??state.modelRefusal??(state.attributionUnresolved?"usage_attribution_unresolved":null);
  if(reason)return refused(reason);
  const seed=context.seeds.values().next().value! as Seed;
  const quotaRows:CompositionQuotaRow[]=context.quota.map(row=>({observedAtMs:Date.parse(row.observed_at),
    resetsAtMs:Date.parse(row.resets_at),usedPercent:row.used_percent,planType:row.plan_type}));
  const poisoned=new Set(state.poisoned),usageRows:CompositionUsageRow[]=state.modelCosts
    .filter(row=>row.costNanousd>0&&!poisoned.has(row.observedAtMs))
    .map(row=>({observedAtMs:row.observedAtMs,model:row.model,costUsd:row.costNanousd/1_000_000_000}));
  const corpus=buildCompositionObservations({quotaRows,usageRows});
  return {status:"ready",planType:seed.planType,fit:calibrateCompositionCapacities(corpus.observations),
    voidedBinCount:corpus.voidedBinCount,poolCount:corpus.poolCount,quotaRowCount:quotaRows.length,
    usageEventCount:state.usageEventCount,unpricedUsageEventCount:state.unpricedUsageEventCount,
    poisonedBinCount:poisoned.size,latestQuotaObservedAt:context.quota[context.quota.length-1]!.observed_at,
    attributionStatus:"legacy_conditional",attributionMethod:V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint:context.pin.fingerprint};
}

/** Derive either result without touching usage rows after a completed reduction. */
export async function finishV11UsageReduction(db:D1Database,pin:V11SourcePin,
  options:V11AnalysisOptions & {quotaAcquisition:V11CompletedQuotaAcquisition},state:V11UsageReductionCheckpoint,
  metric:"fits"|"model",reductionIdentity:V11QuotaAcquisitionIdentity=options.quotaAcquisition.identity):Promise<object>{
  if(!validateV11UsageReductionCheckpoint(state)||!state.complete
    ||!v11QuotaAcquisitionIdentityMatches(state.identity,reductionIdentity))throw new Error("v11 usage reduction incomplete");
  const context=await quotaContext(db,pin,options);if("status" in context)return context;
  const analysis=metric==="fits"?await scalarFromReduction(context,state):modelFromReduction(context,state);
  return metric==="fits"?{...analysis,attributionMethod:V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,inputFingerprint:pin.fingerprint}:analysis;
}
