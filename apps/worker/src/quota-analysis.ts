import {
  analyzeQuotaCalibration,
  buildPlanAttributionIndex,
  buildResetEvidence,
  buildRollingQuotaComparisons,
  isSupportedQuotaWindowDuration,
  planAttributionContextKey,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import type {
  PricingStatus,
  PlanAttributionObservation,
  QuotaCalibration,
  QuotaResetEvidence,
  QuotaSlot,
  QuotaSnapshotInput,
  QuotaTrackEvidence,
  QuotaUsageEventInput,
  QuotaWindowDurationMinutes,
} from "@app-usagemonitor/quota-analysis";
import { parseStoredRecordJson } from "./stored-record";

const MAX_DATASETS = 100;
const MAX_ANALYSIS_RECORDS = 10_000;
// The row ceiling bounds materialized input but not algorithmic complexity: a
// near-maximal corpus with one distinct continuity tuple per row would drive
// per-track work quadratic. A legitimate participant has a handful of tracks
// (a few providers x plans x limits x windows across a bounded set of policy
// epochs), so this ceiling sits far above real cardinality yet far below the
// row ceiling, and it is enforced before any per-track analysis begins.
const MAX_CONTINUITY_TRACKS = 256;

// Usage events are matched to a track by the subset the per-track usage filter
// uses: account track, provider, and policy epoch. The plan/limit fields on a
// usage event are stamped only after matching its conditional plan era.
type UsageEventPartial = Omit<
  QuotaUsageEventInput,
  "planType" | "planVariant" | "limitId"
>;

type AttributedUsagePartial = UsageEventPartial & { planEraKey: string | null };

interface DatasetRow {
  dataset_id: string;
  expected_parts: number;
  observed_parts: number;
  declared_completeness: "complete" | "partial";
}

interface AnalysisRecordRow {
  record_kind: "usage" | "quota";
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
  account_track_id: string;
  dataset_id: string;
  policy_epoch: string;
  server_cost_nanousd: number | null;
  server_pricing_status: string | null;
  record_json: string;
}

interface QuotaTransportRecord {
  receivedTime?: unknown;
  displayPrecision?: unknown;
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
  limitId?: string,
): string {
  return JSON.stringify([accountTrackId, provider, policyEpoch, limitId ?? null]);
}

function quotaPlanContext(row: AnalysisRecordRow, limitId = row.limit_id): string | null {
  if (!limitId) return null;
  try {
    // Policy epochs are separate comparability domains, while every duration
    // of the same provider/limit/epoch contributes plan-switch evidence.
    return planAttributionContextKey(row.provider, limitId) + "|" + row.policy_epoch;
  } catch {
    return null;
  }
}

function intervalHasTime(sortedTimes: readonly number[], start: number, end: number): boolean {
  let low = 0;
  let high = sortedTimes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedTimes[middle]! < start) low = middle + 1;
    else high = middle;
  }
  return low < sortedTimes.length && sortedTimes[low]! <= end;
}

function quotaTransport(row: AnalysisRecordRow): QuotaTransportRecord | null {
  return parseStoredRecordJson(row.record_json) as QuotaTransportRecord | null;
}

function rollingForLatestForecast(
  evidence: QuotaTrackEvidence,
  calibration: QuotaCalibration,
): object {
  const fits = calibration.tracks.flatMap((track) => track.resets);
  const byReset = new Map<string, QuotaResetEvidence>(
    evidence.resets.map((row) => [row.resetKey, row]),
  );
  const candidate = [...fits].reverse().find((row) => (
    row?.status === "conditional_estimate"
      && row.priorForecast
      && byReset.has(row.resetKey)
  ));
  const resetEvidence = candidate
    ? byReset.get(candidate.resetKey)
    : undefined;
  if (!candidate?.priorForecast || !resetEvidence) {
    return {
      schemaVersion: "quota-rolling-comparisons-v0.1",
      status: "not_testable",
      refusalCodes: ["prior_reset_forecast_unavailable"],
      comparisons: [],
    };
  }
  const { score: _score, ...forecast } = candidate.priorForecast;
  return buildRollingQuotaComparisons({
    resetEvidence,
    capacityForecast: forecast,
  });
}

/**
 * Recompute private participant quota analysis from stored, server-priced rows.
 * No client-declared cost is accepted as the analytical cost basis.
 */
export async function accountScopedQuotaAnalysis(
  db: D1Database,
  participantId: string,
): Promise<object> {
  const [datasetResult, recordResult] = await Promise.all([
    db.prepare(
      `SELECT dataset_id,
          MAX(dataset_part_count) AS expected_parts,
          COUNT(DISTINCT dataset_part_index) AS observed_parts,
          MIN(dataset_completeness) AS declared_completeness
        FROM telemetry_contributions
       WHERE participant_id = ?
         AND status = 'accepted'
         AND transport_schema_version = 'telemetry-contribution-v0.2'
         AND dataset_id IS NOT NULL
       GROUP BY dataset_id
       ORDER BY dataset_id
       LIMIT ?`,
    ).bind(participantId, MAX_DATASETS + 1).all<DatasetRow>(),
    db.prepare(
      `SELECT r.record_kind, r.occurrence_id, r.observed_at, r.provider,
          r.plan_type, r.plan_variant, r.limit_id, r.slot, r.used_percent,
          r.window_duration_minutes, r.resets_at, o.account_track_id,
          o.dataset_id, o.policy_epoch, r.server_cost_nanousd,
          r.server_pricing_status, r.record_json
         FROM telemetry_records r
         JOIN telemetry_contribution_occurrences o
           ON o.participant_id = r.participant_id
          AND o.record_kind = r.record_kind
          AND o.occurrence_id = r.occurrence_id
         JOIN telemetry_contributions c
           ON c.id = o.contribution_id
          AND c.participant_id = o.participant_id
        WHERE r.participant_id = ?
          AND r.record_kind IN ('usage', 'quota')
          AND (r.record_kind = 'usage' OR o.account_track_id != 'unattributed')
          AND o.dataset_id IS NOT NULL
          AND o.policy_epoch IS NOT NULL
          AND c.status = 'accepted'
          AND c.transport_schema_version = 'telemetry-contribution-v0.2'
        ORDER BY r.observed_at, r.id, o.dataset_id
        LIMIT ?`,
    ).bind(participantId, MAX_ANALYSIS_RECORDS + 1).all<AnalysisRecordRow>(),
  ]);

  if (datasetResult.results.length > MAX_DATASETS
      || recordResult.results.length > MAX_ANALYSIS_RECORDS) {
    return notTestable("analysis_record_limit_exceeded");
  }
  if (datasetResult.results.length === 0) {
    return notTestable("account_scoped_dataset_unavailable");
  }

  const datasets = datasetResult.results.map((row) => ({
    datasetId: row.dataset_id,
    complete: row.declared_completeness === "complete"
      && row.expected_parts >= 1
      && row.observed_parts === row.expected_parts,
  }));
  const datasetComplete = new Map(datasets.map((row) => [row.datasetId, row.complete]));
  const selectedByOccurrence = new Map<string, AnalysisRecordRow>();
  for (const row of recordResult.results) {
    const key = `${row.record_kind}\u0000${row.occurrence_id}`;
    const current = selectedByOccurrence.get(key);
    if (!current
        || Number(datasetComplete.get(row.dataset_id) === true)
          > Number(datasetComplete.get(current.dataset_id) === true)
        || (
          datasetComplete.get(row.dataset_id) === datasetComplete.get(current.dataset_id)
          && row.dataset_id < current.dataset_id
        )) {
      selectedByOccurrence.set(key, row);
    }
  }
  const selected = [...selectedByOccurrence.values()];
  const usage = selected.filter((row) => row.record_kind === "usage");
  const quota = selected.filter((row) => row.record_kind === "quota");
  // Build before supported-window, span, or fitability filters. A tiny foreign
  // plan observation on this same account must still break a plan era.
  const observations: PlanAttributionObservation[] = [];
  const contextsByUsageTrack = new Map<string, Map<string, string>>();
  for (const row of quota) {
    const contextKey = quotaPlanContext(row);
    if (!contextKey || !row.limit_id) continue;
    observations.push({ contextKey, observedAtMs: Date.parse(row.observed_at),
      planType: row.plan_type, planVariant: row.plan_variant ?? "unknown",
      accountScopeId: row.account_track_id });
    const usageKey = usageTrackEpochKey(row.account_track_id, row.provider, row.policy_epoch);
    const contexts = contextsByUsageTrack.get(usageKey) ?? new Map<string, string>();
    contexts.set(row.limit_id, contextKey);
    contextsByUsageTrack.set(usageKey, contexts);
  }
  const attributionIndex = buildPlanAttributionIndex(observations, {
    // The materialized row cap already bounds account contexts. Preserve the
    // established, more specific continuity-track refusal below for this lane.
    maxContexts: MAX_ANALYSIS_RECORDS,
  });
  if (attributionIndex.status !== "ready") return notTestable("plan_attribution_limit_exceeded");
  const eraByQuotaOccurrence = new Map<string, string>();
  for (const row of quota) {
    const contextKey = quotaPlanContext(row);
    if (!contextKey) continue;
    const match = planEraForInterval(attributionIndex, { contextKey,
      observedAtMs: Date.parse(row.observed_at), accountScopeId: row.account_track_id });
    if (match.status === "matched" && match.era.planType === row.plan_type
        && match.era.planVariant === row.plan_variant) {
      eraByQuotaOccurrence.set(row.occurrence_id, match.era.eraKey);
    }
  }
  const seeds = new Map<string, TrackSeed>();
  for (const row of quota) {
    const planEraKey = eraByQuotaOccurrence.get(row.occurrence_id);
    if (!row.plan_type || !row.plan_variant || !row.limit_id
        || !row.window_duration_minutes
        || planEraKey === undefined
        || !isSupportedQuotaWindowDuration(row.window_duration_minutes)) continue;
    const seed = {
      accountTrackId: row.account_track_id,
      provider: row.provider,
      planType: row.plan_type,
      planVariant: row.plan_variant,
      limitId: row.limit_id,
      windowDurationMinutes: row.window_duration_minutes,
      policyEpoch: row.policy_epoch,
      planEraKey,
    };
    seeds.set(seedKey(seed), seed);
  }
  if (seeds.size === 0) return notTestable("supported_quota_track_unavailable");
  // Reject an adversarial high-cardinality corpus before any per-track work,
  // rather than letting distinct-seed count multiply the per-seed cost.
  if (seeds.size > MAX_CONTINUITY_TRACKS) {
    return notTestable("continuity_track_limit_exceeded");
  }

  // Group quota snapshots and usage events into keyed buckets in a single linear
  // pass each, so each track reads only its own records instead of rescanning
  // the full arrays. Total grouping work is O(rows); with the track ceiling
  // above, total per-track work is bounded rather than quadratic in the corpus.
  const quotaSnapshotsBySeed = new Map<string, QuotaSnapshotInput[]>();
  for (const row of quota) {
    const planEraKey = eraByQuotaOccurrence.get(row.occurrence_id);
    if (!row.plan_type || !row.plan_variant || !row.limit_id
        || !row.window_duration_minutes
        || planEraKey === undefined
        || !row.slot || row.used_percent === null || !row.resets_at) continue;
    const transport = quotaTransport(row);
    if (typeof transport?.receivedTime !== "string"
        || !Number.isSafeInteger(transport.displayPrecision)) continue;
    const key = seedKey({
      accountTrackId: row.account_track_id,
      provider: row.provider,
      planType: row.plan_type,
      planVariant: row.plan_variant,
      limitId: row.limit_id,
      windowDurationMinutes: row.window_duration_minutes,
      policyEpoch: row.policy_epoch,
      planEraKey,
    });
    const snapshot: QuotaSnapshotInput = {
      snapshotId: row.occurrence_id,
      datasetId: row.dataset_id,
      accountTrackId: row.account_track_id,
      provider: row.provider,
      planType: row.plan_type,
      planVariant: row.plan_variant,
      limitId: row.limit_id,
      slot: row.slot as QuotaSlot,
      windowDurationMinutes:
        row.window_duration_minutes as QuotaWindowDurationMinutes,
      resetsAt: row.resets_at,
      observedAt: row.observed_at,
      receivedAt: transport.receivedTime,
      usedPercent: row.used_percent,
      displayPrecision: transport.displayPrecision as number,
      policyEpoch: row.policy_epoch,
    };
    const bucket = quotaSnapshotsBySeed.get(key);
    if (bucket) bucket.push(snapshot);
    else quotaSnapshotsBySeed.set(key, [snapshot]);
  }

  const usageEventsByTrackEpoch = new Map<string, AttributedUsagePartial[]>();
  const unattributedTimesByProviderEpoch = new Map<string, number[]>();
  for (const row of usage) {
    if (row.account_track_id === "unattributed") {
      // Retain the input even without an account. It may belong to any scoped
      // numerator in this provider/epoch, so it must gate an overlapping reset
      // rather than disappear from a seemingly complete 20-of-100 subtotal.
      // Positively measured zero cost is harmless; missing pricing is not zero.
      if (row.server_cost_nanousd !== 0 || row.server_pricing_status !== "fully_priced") {
        const time = Date.parse(row.observed_at);
        if (Number.isSafeInteger(time)) {
          const key = usageTrackEpochKey("unattributed", row.provider, row.policy_epoch);
          const times = unattributedTimesByProviderEpoch.get(key) ?? [];
          times.push(time);
          unattributedTimesByProviderEpoch.set(key, times);
        }
      }
      continue;
    }
    if (row.server_cost_nanousd === null || row.server_pricing_status === null) {
      continue;
    }
    const accountUsageKey = usageTrackEpochKey(
      row.account_track_id,
      row.provider,
      row.policy_epoch,
    );
    const partial: UsageEventPartial = {
      eventId: row.occurrence_id,
      datasetId: row.dataset_id,
      accountTrackId: row.account_track_id,
      provider: row.provider,
      observedAt: row.observed_at,
      costNanousd: row.server_cost_nanousd,
      pricingStatus: row.server_pricing_status as PricingStatus,
      policyEpoch: row.policy_epoch,
    };
    for (const [limitId, contextKey] of contextsByUsageTrack.get(accountUsageKey) ?? []) {
      const match = planEraForInterval(attributionIndex, { contextKey,
        observedAtMs: Date.parse(row.observed_at), accountScopeId: row.account_track_id });
      const attributed: AttributedUsagePartial = { ...partial,
        planEraKey: match.status === "matched" ? match.era.eraKey : null };
      const key = usageTrackEpochKey(row.account_track_id, row.provider, row.policy_epoch, limitId);
      const bucket = usageEventsByTrackEpoch.get(key);
      if (bucket) bucket.push(attributed);
      else usageEventsByTrackEpoch.set(key, [attributed]);
    }
  }
  for (const times of unattributedTimesByProviderEpoch.values()) times.sort((left, right) => left - right);

  const tracks = [];
  for (const seed of [...seeds.values()].sort((left, right) => (
    seedKey(left).localeCompare(seedKey(right))
  ))) {
    const quotaSnapshots = quotaSnapshotsBySeed.get(seedKey(seed)) ?? [];
    const scopedUsage = (
      usageEventsByTrackEpoch.get(usageTrackEpochKey(
        seed.accountTrackId,
        seed.provider,
        seed.policyEpoch,
        seed.limitId,
      )) ?? []
    );
    const usageEvents: QuotaUsageEventInput[] = scopedUsage
      .filter((partial) => partial.planEraKey === seed.planEraKey)
      .map(({ planEraKey: _era, ...partial }) => ({ ...partial,
        planType: seed.planType, planVariant: seed.planVariant, limitId: seed.limitId }));
    const fullEvidence = buildResetEvidence({ datasets, quotaSnapshots, usageEvents });
    const unresolvedTimes = scopedUsage.filter((event) => event.planEraKey === null)
      .map((event) => Date.parse(event.observedAt)).sort((left, right) => left - right);
    const unknownTimes = unattributedTimesByProviderEpoch.get(usageTrackEpochKey(
      "unattributed", seed.provider, seed.policyEpoch,
    )) ?? [];
    const refusedResets = fullEvidence.resets.filter((reset) =>
      intervalHasTime(unresolvedTimes, Date.parse(reset.firstObservedAt), Date.parse(reset.lastObservedAt))
        || intervalHasTime(unknownTimes, Date.parse(reset.firstObservedAt), Date.parse(reset.lastObservedAt)));
    const refusedKeys = new Set(refusedResets.map((reset) => reset.resetKey));
    const coherentResets = fullEvidence.resets.filter((reset) => !refusedKeys.has(reset.resetKey));
    const evidence = { ...fullEvidence, resetCount: coherentResets.length, resets: coherentResets };
    const calibration = analyzeQuotaCalibration(evidence);
    tracks.push({
      continuity: seed,
      evidence,
      calibration,
      rolling: rollingForLatestForecast(evidence, calibration),
      attribution: {
        status: "legacy_conditional", accountScope: "declared", planEraKey: seed.planEraKey,
        refusedResets: refusedResets.map((reset) => ({ resetKey: reset.resetKey,
          reason: intervalHasTime(unknownTimes, Date.parse(reset.firstObservedAt), Date.parse(reset.lastObservedAt))
            ? "usage_account_unresolved" : "usage_plan_interval_unresolved", firstObservedAt: reset.firstObservedAt,
          lastObservedAt: reset.lastObservedAt })),
      },
    });
  }
  return {
    schemaVersion: "account-scoped-quota-analysis-v0.1",
    status: "ready",
    fragmentSelection: "unselected_diagnostics",
    tracks,
  };
}
