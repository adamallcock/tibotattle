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

export const V11_PLAN_ATTRIBUTION_ADAPTER_VERSION =
  PLAN_ATTRIBUTION_POLICY.methodVersion + ":v11-account-era-buckets-1";

const DAY_MS = 86_400_000;
const WEEK_MS = SEVEN_DAY_WINDOW_MINUTES * 60_000;
const PAGE_SIZE = 5_000;
const MAX_USAGE_DAYS = V1_ANALYSIS_WINDOW_DAYS + 1;
const MAX_TRACKS = 256;
const MAX_SESSIONS = 100_000;
const MAX_USAGE_BUCKETS = 120_000;
const MAX_HAZARD_INTERVALS = 240_000;
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const SLOTS = new Set(["primary", "secondary", "five_hour", "seven_day", "other", "unknown"]);

export interface V11AnalysisOptions {
  nowMs?: number;
  sourcePin?: V11SourcePin;
  maxDownsampledQuotaRows?: number;
  maxWindowedUsageRows?: number;
}

interface PlanRow {
  observed_at: string;
  provider: string;
  limit_id: string;
  account_scope_id: string;
  plan_type: string;
  plan_variant: string;
  continuity_id: string | null;
  plan_basis: TelemetryV11Attribution["planBasis"];
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

async function quotaContext(db: D1Database, pin: V11SourcePin, options: V11AnalysisOptions): Promise<Context | Refusal> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const start = cutoff > pin.fromDay + "T00:00:00.000Z" ? cutoff : pin.fromDay + "T00:00:00.000Z";
  const domainEnd = new Date(Date.parse(pin.throughDay + "T00:00:00.000Z") + DAY_MS).toISOString();
  const analysisEnd = new Date(Date.parse(cutoff) + MAX_USAGE_DAYS * DAY_MS).toISOString();
  const end = domainEnd < analysisEnd ? domainEnd : analysisEnd;
  const bindings = [pin.participantId, pin.generationId, start.slice(0, 10), end.slice(0, 10), start, end];
  // Context/account/time are currently JSON-derived in the activated view, so
  // a predecessor query would scan the entire historical domain. Keep this
  // bounded horizon explicit and conditional until an indexed predecessor
  // lane exists; never assert a verified pre-window plan or quantity interval.
  const evidence = await db.prepare(PLAN_SQL).bind(...bindings, MAX_PLAN_ATTRIBUTION_ROWS + 1).all<PlanRow>();
  if (evidence.results.length > MAX_PLAN_ATTRIBUTION_ROWS) return refused("plan_attribution_limit_exceeded");
  const index = buildPlanAttributionIndex(evidence.results.filter((row) => TOKEN.test(row.provider)).map((row) => ({
    contextKey: planAttributionContextKey(row.provider, row.limit_id),
    accountScopeId: row.account_scope_id || null,
    observedAtMs: Date.parse(row.observed_at), planType: row.plan_type, planVariant: row.plan_variant,
    continuityId: row.continuity_id, conflicted: row.plan_basis === "conflicted",
  })));
  if (index.status !== "ready") return refused("plan_attribution_limit_exceeded");
  const maximum = options.maxDownsampledQuotaRows ?? MAX_DOWNSAMPLED_QUOTA_ROWS;
  const result = await db.prepare(QUOTA_SQL).bind(
    markers(index), ...bindings, SEVEN_DAY_WINDOW_MINUTES,
    new Date(Date.parse(cutoff) + WEEK_MS).toISOString(),
    QUOTA_CALIBRATION_POLICY.minimumBoundaries, QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp, maximum + 1,
  ).all<QuotaRow>();
  if (result.results.length > maximum) return refused("downsampled_quota_limit_exceeded");
  const datasetId = "dataset:v1:" + await sha256Hex(pin.participantId + "|" + pin.generationId);
  const seeds = new Map<string, Seed>();
  const snapshots = new Map<string, QuotaSnapshotInput[]>();
  const gridSets = new Map<string, Set<number>>();
  const unknownTracks = new Map<string, string>();
  const quota: QuotaRow[] = [];
  for (const row of result.results) {
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
      const result = await db.prepare(V11_USAGE_PAGE_SQL).bind(
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
      if (result.results.length < PAGE_SIZE) break;
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
  const pin = await sourcePin(db, participantId, options.sourcePin);
  if (!pin) return refused("activated_attribution_domain_unavailable");
  const context = await quotaContext(db, pin, options);
  const analysis = "status" in context ? context : await compositionAnalysis(db, context, options);
  await assertV11SourcePinCurrent(db, pin);
  return analysis;
}
