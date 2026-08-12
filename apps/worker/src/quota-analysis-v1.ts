import {
  analyzeQuotaCalibration,
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
 * The returned object omits `evidence` and `rolling` (the community consumer
 * reads only `track.continuity.planType`/`planVariant` and
 * `track.calibration.tracks[].resets[]`).
 */

// Row ceiling for the materialized v1 input. A legitimate participant's full
// history is far below this; it exists so a corrupt or adversarial corpus can
// never turn a fit read into an unbounded scan. Read full history, not a
// trailing window: the calibration gates need the whole per-reset series.
const MAX_ANALYSIS_RECORDS_V1 = 50_000;
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

interface AnalysisRecordRowV1 {
  stream: "usage" | "quota";
  occurrence_id: string;
  observed_at: string;
  provider: string;
  model_id: string | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at: string | null;
  record_json: string;
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
      inputUncachedTokens: c.inputUncachedTokens ?? null,
      inputCacheReadTokens: c.inputCacheReadTokens ?? null,
      inputCacheWriteTokens: c.inputCacheWriteTokens ?? null,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: c.outputTextTokens ?? null,
      outputReasoningTokens: c.outputReasoningTokens ?? null,
      outputCombinedTokens: c.outputCombinedTokens ?? null,
    },
    totalInputContextTokens: rec.totalInputContextTokens ?? null,
  };
  return event as unknown as TelemetryUsageEvent;
}

/**
 * Recompute private participant quota analysis from stored v1 chunk records.
 * No client-declared cost is accepted as the analytical cost basis: every
 * usage event is repriced from tokens by the shared server pricer.
 */
export async function accountScopedQuotaAnalysisV1(
  db: D1Database,
  participantId: string,
): Promise<object> {
  const recordResult = await db.prepare(
    `WITH day_device_evidence AS (
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
      )
      SELECT r.stream, r.occurrence_id, r.observed_at, r.provider, r.model_id,
             r.plan_type, r.plan_variant, r.limit_id, r.slot, r.used_percent,
             r.window_duration_minutes, r.resets_at, r.record_json
        FROM telemetry_v1_records r
        JOIN winning_devices w
          ON w.observed_day = r.observed_day AND w.device_id = r.device_id
        JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE r.participant_id = ?1
         AND r.stream IN ('usage', 'quota')
       ORDER BY r.observed_at, r.id
       LIMIT ?2`,
  ).bind(participantId, MAX_ANALYSIS_RECORDS_V1 + 1).all<AnalysisRecordRowV1>();

  if (recordResult.results.length > MAX_ANALYSIS_RECORDS_V1) {
    return notTestable("analysis_record_limit_exceeded");
  }

  // Synthetic dataset (single, complete): the v1 chunk journal has no partial
  // dataset concept, so there is exactly one complete dataset per participant.
  const datasetId = `dataset:v1:${await sha256Hex(participantId)}`;
  const datasets = [{ datasetId, complete: true }];
  // Account track id per provider, assigned identically to that participant's
  // quota snapshots and usage events so usage attributes to its track.
  const accountTrackByProvider = new Map<string, string>();
  for (const row of recordResult.results) {
    if (!accountTrackByProvider.has(row.provider)) {
      accountTrackByProvider.set(
        row.provider,
        `account-track:v1:${await sha256Hex(`${participantId}|${row.provider}`)}`,
      );
    }
  }

  const quotaSnapshots: QuotaSnapshotInput[] = [];
  const usageEvents: UsageEventPartial[] = [];
  for (const row of recordResult.results) {
    const accountTrackId = accountTrackByProvider.get(row.provider)!;
    if (row.stream === "quota") {
      // Row-level domain prefilter (v0.2-ingest DROP semantics): skip any row
      // outside the shared validators' domain rather than let it throw.
      if (row.slot === null || !SLOT_VALUES.has(row.slot)) continue;
      if (row.resets_at === null || row.observed_at === null) continue;
      if (Date.parse(row.resets_at) <= Date.parse(row.observed_at)) continue;
      if (row.used_percent === null
          || !Number.isFinite(row.used_percent)
          || row.used_percent < 0
          || row.used_percent > 100) continue;
      if (row.plan_type === null
          || row.plan_variant === null
          || row.limit_id === null) continue;
      if (!SAFE_TOKEN.test(row.provider)
          || !SAFE_TOKEN.test(row.plan_type)
          || !SAFE_TOKEN.test(row.plan_variant)
          || !SAFE_TOKEN.test(row.limit_id)
          || !SAFE_TOKEN.test(row.slot)) continue;
      // A quota snapshot needs a window; a missing one can neither seed nor
      // bucket (matching the v0.2 path, where a null window drops out).
      if (row.window_duration_minutes === null) continue;
      const snapshotId = `q:v1:${await sha256Hex(row.occurrence_id)}`;
      quotaSnapshots.push({
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
        // Receipt lag 0: v1 records carry no receipt timestamp distinct from
        // the observation, so the reset is never stale or backward on lag.
        receivedAt: row.observed_at,
        usedPercent: row.used_percent,
        displayPrecision: 0,
        policyEpoch: V1_POLICY_EPOCH,
      });
      continue;
    }
    // usage
    if (!SAFE_TOKEN.test(row.provider)) continue;
    const rec = parseStoredRecordJson(row.record_json);
    if (rec === null) continue;
    const pricingEvent = buildPricingEvent(rec, row.observed_at);
    if (pricingEvent === null) continue;
    const priced = priceTelemetryUsageEvent(pricingEvent);
    const eventId = `u:v1:${await sha256Hex(row.occurrence_id)}`;
    usageEvents.push({
      eventId,
      datasetId,
      accountTrackId,
      provider: row.provider,
      observedAt: row.observed_at,
      costNanousd: priced.costNanousd,
      pricingStatus: priced.coverageStatus as PricingStatus,
      policyEpoch: V1_POLICY_EPOCH,
    });
  }

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
