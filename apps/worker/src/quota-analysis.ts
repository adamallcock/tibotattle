// The shared quota core is intentionally framework-free JavaScript so the
// local monitor and Worker execute the same algorithms.
// @ts-expect-error The shared module is validated by its own Node test suite.
import { buildResetEvidence } from "../../../shared/quota-tracks.js";
// @ts-expect-error The shared module is validated by its own Node test suite.
import { analyzeQuotaCalibration } from "../../../shared/quota-calibration.js";
// @ts-expect-error The shared module is validated by its own Node test suite.
import { buildRollingQuotaComparisons } from "../../../shared/quota-rolling.js";

const MAX_DATASETS = 100;
const MAX_ANALYSIS_RECORDS = 10_000;
const SUPPORTED_DURATIONS = new Set([300, 10_080]);

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

function quotaTransport(row: AnalysisRecordRow): QuotaTransportRecord | null {
  try {
    const value = JSON.parse(row.record_json) as QuotaTransportRecord;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function rollingForLatestForecast(evidence: any, calibration: any): object {
  const fits = calibration.tracks?.flatMap((track: any) => track.resets ?? []) ?? [];
  const byReset = new Map((evidence.resets ?? []).map((row: any) => [row.resetKey, row]));
  const candidate = [...fits].reverse().find((row: any) => (
    row?.status === "conditional_estimate"
      && row.priorForecast
      && byReset.has(row.resetKey)
  ));
  if (!candidate) {
    return {
      schemaVersion: "quota-rolling-comparisons-v0.1",
      status: "not_testable",
      refusalCodes: ["prior_reset_forecast_unavailable"],
      comparisons: [],
    };
  }
  const { score: _score, ...forecast } = candidate.priorForecast;
  return buildRollingQuotaComparisons({
    resetEvidence: byReset.get(candidate.resetKey),
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
          AND o.account_track_id != 'unattributed'
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
  const seeds = new Map<string, TrackSeed>();
  for (const row of quota) {
    if (!row.plan_type || !row.plan_variant || !row.limit_id
        || !row.window_duration_minutes
        || !SUPPORTED_DURATIONS.has(row.window_duration_minutes)) continue;
    const seed = {
      accountTrackId: row.account_track_id,
      provider: row.provider,
      planType: row.plan_type,
      planVariant: row.plan_variant,
      limitId: row.limit_id,
      windowDurationMinutes: row.window_duration_minutes,
      policyEpoch: row.policy_epoch,
    };
    seeds.set(seedKey(seed), seed);
  }
  if (seeds.size === 0) return notTestable("supported_quota_track_unavailable");

  const tracks = [];
  for (const seed of [...seeds.values()].sort((left, right) => (
    seedKey(left).localeCompare(seedKey(right))
  ))) {
    const quotaSnapshots = quota.flatMap((row) => {
      if (row.account_track_id !== seed.accountTrackId
          || row.provider !== seed.provider
          || row.plan_type !== seed.planType
          || row.plan_variant !== seed.planVariant
          || row.limit_id !== seed.limitId
          || row.window_duration_minutes !== seed.windowDurationMinutes
          || row.policy_epoch !== seed.policyEpoch
          || !row.slot || row.used_percent === null || !row.resets_at) return [];
      const transport = quotaTransport(row);
      if (typeof transport?.receivedTime !== "string"
          || !Number.isSafeInteger(transport.displayPrecision)) return [];
      return [{
        snapshotId: row.occurrence_id,
        datasetId: row.dataset_id,
        accountTrackId: row.account_track_id,
        provider: row.provider,
        planType: row.plan_type,
        planVariant: row.plan_variant,
        limitId: row.limit_id,
        slot: row.slot,
        windowDurationMinutes: row.window_duration_minutes,
        resetsAt: row.resets_at,
        observedAt: row.observed_at,
        receivedAt: transport.receivedTime,
        usedPercent: row.used_percent,
        displayPrecision: transport.displayPrecision,
        policyEpoch: row.policy_epoch,
      }];
    });
    const usageEvents = usage.flatMap((row) => (
      row.account_track_id === seed.accountTrackId
        && row.provider === seed.provider
        && row.policy_epoch === seed.policyEpoch
        && row.server_cost_nanousd !== null
        && row.server_pricing_status !== null
        ? [{
          eventId: row.occurrence_id,
          datasetId: row.dataset_id,
          accountTrackId: row.account_track_id,
          provider: row.provider,
          planType: seed.planType,
          planVariant: seed.planVariant,
          limitId: seed.limitId,
          observedAt: row.observed_at,
          costNanousd: row.server_cost_nanousd,
          pricingStatus: row.server_pricing_status,
          policyEpoch: row.policy_epoch,
        }]
        : []
    ));
    const evidence = buildResetEvidence({ datasets, quotaSnapshots, usageEvents });
    const calibration = analyzeQuotaCalibration(evidence);
    tracks.push({
      continuity: seed,
      evidence,
      calibration,
      rolling: rollingForLatestForecast(evidence, calibration),
    });
  }
  return {
    schemaVersion: "account-scoped-quota-analysis-v0.1",
    status: "ready",
    tracks,
  };
}
