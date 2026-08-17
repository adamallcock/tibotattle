import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  APP_PRICE_REGISTRY_MANIFEST,
  CODEX_SPEED_MODE_DECLARATION,
  CODEX_SPEED_MODE_OBSERVABILITY,
  DEFAULT_FAST_MODE_PREFERENCE,
  FAST_MODE_MULTIPLIER_SOURCE,
  FAST_MODE_QUOTA_MULTIPLIERS,
  OPENAI_PRICE_EVIDENCE_START_DATE,
  QUOTA_WEIGHTED_API_PRICE_METRIC,
  inferFastModeFromCalibrationWindows,
  isFastModePreference,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  deterministicSample,
  emptyComponents,
  emptyDimension,
  finalizeQuotaTimeline,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  finiteNumber,
  KNOWN_AGENT_SCOPES,
  KNOWN_API_TIERS,
  KNOWN_LINEAGE,
  KNOWN_SLOTS,
  KNOWN_SPEEDS,
  KNOWN_SURFACES,
  KNOWN_TOOL_CLASSES,
  newUsagePeriod,
  orderQuotaWindows,
  quotaWindowProjection,
  safeSpeed,
  safeSpeedWeighting,
  SPARK_QUOTA_LIMIT_IDS,
  TIMELINE_BUCKET_MS,
  usageProjection,
  validObservedAt,
} from "./local-companion-usage-model.js";
import {
  defaultLocalUnifiedIndexPath,
} from "./local-unified-index.js";
import {
  readLocalUnifiedCompanionProjection,
} from "./local-unified-companion-source.js";
import {
  createAccountingPricer,
  readReplaySafeAccountingCache,
} from "./replay-safe-accounting-cache.js";
import {
  defaultLocalArchiveAccountingIndexPath,
  inspectLocalArchiveAccountingIndex,
  readLocalArchiveAccountingPeriod,
} from "./local-archive-accounting-index.js";
import {
  defaultLocalCollectorStatePath,
  forEachLocalCollectorRecord,
  prepareLocalCollectorState,
  readLocalCollectorState,
} from "./local-collector-state.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
} from "./reporting/index.js";
import {
  projectWeeklyPaceForecast,
  weeklyPaceSnapshotsFromCollectorRecord,
} from "./weekly-pace-projection.js";
import {
  resolveLocalLegacyReportReadPath,
} from "./local-legacy-report-storage.js";

export const LOCAL_COMPANION_SCHEMA_VERSION = "local-companion-v0.1";

const MAX_LEDGER_RECORDS = 5_000_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_TEXT_LENGTH = 2_000;

// The bounded recent collector window. This bound applies only when the
// unified local index is unavailable: the collector is a bounded recent state
// store, and the timeline it can honestly draw is capped at this many days.
// With the unified index available the timeline and the "all" period cover
// the index's whole span instead.
const RECENT_TIMELINE_DAYS = 31;
const RECENT_COLLECTOR_PERIOD_LABEL =
  `Cached ${RECENT_TIMELINE_DAYS}-day collector window`;
const MAX_REPLAY_SAFE_CACHE_AGE_MS = 30 * 60 * 1_000;
const MAX_COLLECTOR_LIVE_AGE_MS = MAX_REPLAY_SAFE_CACHE_AGE_MS;
const MAX_WEEKLY_PACE_OBSERVATIONS = 8_192;
const ALLOWANCE_CAPACITY_SCHEMA_VERSION =
  "codex-primary-allowance-capacity-v0.1";
const ALLOWANCE_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast",
]);
const TIMELINE_ALLOWANCE_WEIGHTING_SCHEMA_VERSION =
  "quota-weighted-timeline-v0.1";
const TIMELINE_WEIGHTING_STATUS_CODE = Object.freeze({
  complete: 0,
  partial: 1,
  unknown: 2,
});

const REPORTS = Object.freeze([
  {
    id: "gradient",
    title: "Cost versus quota gradient",
    href: "/reports/gradient",
    file: "2026-07-24-simple-quota-gradient-report.html",
  },
  {
    id: "weekly",
    title: "Seven-day calibration",
    href: "/reports/weekly",
    file: "2026-07-24-weekly-7-day-calibration-report.html",
  },
  {
    id: "quality",
    title: "Monitoring quality",
    href: "/reports/quality",
    file: "2026-07-24-monitoring-quality-report.html",
  },
  {
    id: "multi_surface",
    title: "Multi-surface account usage",
    href: "/reports/multi-surface",
    file: "2026-07-24-codex-work-account-usage-report.html",
  },
]);

const ARTIFACTS = Object.freeze({
  gradient: Object.freeze({
    file: "2026-07-24-simple-quota-gradient-artifact.json",
    datasets: Object.freeze({
      summary: [
        "selected_reset_at", "snapshot_intervals", "percentage_transitions", "observed_span_pp",
        "capacity_usd", "lower_80_usd", "upper_80_usd", "mean_absolute_error_pp",
        "points_within_80_band_fraction", "usable_reset_series", "recent_three_median_usd",
        "early_three_median_usd", "early_to_recent_change", "rolling_signed_auc_pp_hours",
        "rolling_absolute_auc_pp_hours", "rolling_peak_absolute_residual_pp",
        "july_13_fast_events", "july_13_fast_raw_capacity_usd", "july_13_fast_weighted_capacity_usd",
        "july_13_reference_capacity_usd", "july_13_one_hour_weighted_mae_pp",
        "july_13_two_hour_weighted_mae_pp", "july_13_three_hour_weighted_mae_pp",
        "long_history_first_at", "long_history_last_at", "long_history_reset_series",
      ],
      curve: ["api_cost_usd", "quota_consumed_pp", "observed_at", "series"],
      rolling: [
        "timestamp", "window_start_utc", "window_end_utc", "window_end_utc_label",
        "window_end_eastern_label", "rolling_api_cost_usd", "rolling_event_count",
        "smoothing_hours", "series", "quota_change_pp",
      ],
      current_rolling_detail: [
        "window_end_eastern", "window_end_utc", "observed_quota_change_pp",
        "expected_quota_change_pp", "residual_pp", "rolling_api_cost_usd", "usage_events",
      ],
      rolling_history: [
        "timestamp", "window_start_utc", "window_end_utc", "window_end_utc_label",
        "window_end_eastern_label", "rolling_api_cost_usd", "rolling_event_count",
        "smoothing_hours", "series", "quota_change_pp", "utc_hour", "eastern_hour",
        "reset_at", "reset_segment", "reset_gradient_usd", "gradient_quality",
      ],
      rolling_residual: [
        "timestamp", "series", "observed_quota_change_pp", "expected_quota_change_pp", "residual_pp",
      ],
      fast_hourly: [
        "timestamp", "hour_start_utc", "hour_end_utc", "hour_end_utc_label",
        "hour_end_eastern_label", "api_cost_usd", "tier_weighted_cost_usd", "usage_events",
        "fast_events", "standard_events", "unknown_events", "series", "quota_change_pp",
      ],
      fast_two_hour: [
        "timestamp", "window_end_utc_label", "window_end_eastern_label", "api_cost_usd",
        "tier_weighted_cost_usd", "usage_events", "fast_events", "series", "quota_change_pp",
      ],
      fast_hourly_detail: [
        "window_end_utc", "window_end_utc_label", "window_end_eastern_label", "window_hours",
        "observed_quota_change_pp", "raw_expected_quota_change_pp", "weighted_expected_quota_change_pp",
        "raw_residual_pp", "weighted_residual_pp", "api_cost_usd", "tier_weighted_cost_usd",
        "usage_events", "fast_events",
      ],
      window_sensitivity: [
        "window_hours", "focal_window", "focal_points", "raw_mae_pp", "weighted_mae_pp",
        "weighted_mae_reduction_fraction", "raw_peak_absolute_residual_pp",
        "weighted_peak_absolute_residual_pp",
      ],
      fast_segments: [
        "segment", "first_observed_at", "last_observed_at", "speed_evidence", "quota_change_pp",
        "standard_api_cost_usd", "weighted_api_equivalent_usd", "raw_implied_capacity_usd",
        "weighted_implied_capacity_usd",
      ],
      slot_semantics: [
        "slot", "window_minutes", "window_label", "transitions", "first_observed_at", "last_observed_at",
      ],
      reset_calendar: ["announced_at_utc", "announced_at_et", "event_type", "propagation_note"],
      reset_trend: [
        "first_observed_at", "reset_at", "reset_key", "eligible_transitions",
        "observed_span_pp", "series", "capacity_usd",
      ],
      reset_table: [
        "first_observed_at", "reset_at", "slot", "capacity_usd", "lower_80_usd",
        "upper_80_usd", "eligible_transitions", "observed_span_pp",
      ],
    }),
  }),
  weekly: Object.freeze({
    file: "2026-07-24-weekly-7-day-calibration-artifact.json",
    datasets: Object.freeze({
      summary: [
        "median_weekly_value_usd", "lower_80_across_resets_usd", "upper_80_across_resets_usd",
        "qualifying_resets", "selected_holdout_mae_pp", "standard_holdout_mae_pp",
        "holdout_improvement_fraction", "prior_reset_mae_pp", "prior_reset_bias_pp",
        "prior_reset_scored_resets", "prior_reset_scored_points", "prior_reset_p80_absolute_error_pp",
        "selected_forecast_common_mae_pp", "selected_forecast_common_bias_pp", "online_update_status",
      ],
      candidates: [
        "accounting_basis", "selected", "qualifying_resets", "holdout_points",
        "median_reset_holdout_mae_pp", "pooled_holdout_mae_pp", "pooled_holdout_bias_pp",
        "median_in_sample_mae_pp",
      ],
      weekly_values: [
        "sequence", "first_observed_at", "last_observed_at", "reset_due_at", "slot",
        "displayed_span_pp", "value_usd", "pairwise_p10_usd", "pairwise_p90_usd",
        "holdout_observed_movement_pp", "holdout_predicted_movement_pp", "holdout_mae_pp",
        "holdout_bias_pp", "prior_forecast_value_usd", "prior_prediction_mae_pp",
        "prior_prediction_bias_pp", "known_speed_fraction", "fast_fraction_of_known",
        "eligible_transitions", "unique_percentage_boundaries",
      ],
      value_series: [
        "sequence", "first_observed_at", "last_observed_at", "reset_due_at", "slot",
        "displayed_span_pp", "value_usd", "pairwise_p10_usd", "pairwise_p90_usd",
        "holdout_observed_movement_pp", "holdout_predicted_movement_pp", "holdout_mae_pp",
        "holdout_bias_pp", "prior_forecast_value_usd", "prior_prediction_mae_pp",
        "prior_prediction_bias_pp", "known_speed_fraction", "fast_fraction_of_known",
        "eligible_transitions", "unique_percentage_boundaries", "series", "value_series_usd",
      ],
      holdout_series: [
        "sequence", "first_observed_at", "last_observed_at", "reset_due_at", "slot",
        "displayed_span_pp", "value_usd", "pairwise_p10_usd", "pairwise_p90_usd",
        "holdout_observed_movement_pp", "holdout_predicted_movement_pp", "holdout_mae_pp",
        "holdout_bias_pp", "prior_forecast_value_usd", "prior_prediction_mae_pp",
        "prior_prediction_bias_pp", "known_speed_fraction", "fast_fraction_of_known",
        "eligible_transitions", "unique_percentage_boundaries", "series", "movement_pp",
      ],
      error_concentration: [
        "first_observed_date", "reset_due_at", "share_of_absolute_error",
        "holdout_absolute_error_pp", "holdout_mae_pp", "holdout_bias_pp",
        "speed_known_fraction", "fast_fraction_of_known",
      ],
      lag_candidates: [
        "candidate", "selected", "qualifying_resets", "holdout_points", "pooled_mae_pp", "pooled_bias_pp",
      ],
      forecast_candidates: [
        "forecast_rule", "selected", "common_resets", "common_points",
        "pooled_mae_pp", "pooled_bias_pp", "regime_forecasts",
      ],
      online_checkpoints: [
        "checkpoint_display_pp", "comparable_resets", "corrected_online_mae_pp",
        "prior_forecast_mae_pp", "improvement_fraction", "accepted",
      ],
      provider_epochs: [
        "epoch", "start_date", "end_date", "comparable_days", "local_to_provider_token_ratio",
        "local_api_priced_usd", "provider_only_days", "evidence_status",
      ],
      experiment_status: ["status", "attempts", "controlled_results", "unknown_results", "stop_reasons"],
      high_error_surfaces: [
        "first_observed_date", "surface", "events", "event_share", "total_tokens",
        "token_share", "standard_api_priced_usd", "cost_share",
      ],
    }),
  }),
  quality: Object.freeze({
    file: "2026-07-24-monitoring-quality-artifact.json",
    datasets: Object.freeze({
      summary: [
        "collector_age_hours", "collector_age_seconds", "app_server_age_hours",
        "dominant_snapshot_intervals", "fit_eligible_fraction", "known_speed_fraction",
        "flat_interval_fraction", "fixed_reset_exact_groups", "fixed_reset_clusters",
        "moving_reset_groups", "prospective_account_scoped_usage_records",
      ],
      coverage: ["dimension", "coverage_fraction"],
      signals: ["signal", "intervals", "fraction"],
      reset_families: [
        "limit", "window_minutes", "exact_reset_groups", "clusters_within_120s",
        "singleton_groups", "groups_with_transitions", "dominant_cluster_share", "behavior",
      ],
      opportunities: ["action", "evidence", "id", "priority", "title"],
      priority_counts: ["priority", "improvements"],
    }),
  }),
});

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeText(value) {
  if (typeof value !== "string") return null;
  const clipped = value.slice(0, MAX_SAFE_TEXT_LENGTH);
  if (/https?:\/\/|file:\/\/|\/Users\/|\/home\/|[A-Z]:\\|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(clipped)) {
    return "[redacted]";
  }
  return clipped;
}

function safeValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => {
      if (["string", "number", "boolean"].includes(typeof item) || item === null) return safeValue(item);
      return null;
    });
  }
  return null;
}

function projectDataset(rows, allowedKeys) {
  if (!Array.isArray(rows)) return [];
  return deterministicSample(rows).flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const projected = {};
    for (const key of allowedKeys) {
      if (!Object.hasOwn(row, key)) continue;
      const value = safeValue(row[key]);
      if (value !== null || row[key] === null) projected[key] = value;
    }
    return [projected];
  });
}

async function readBoundedJson(path, maximumBytes) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw fixedError("artifact_missing");
    throw fixedError("artifact_unavailable");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw fixedError("artifact_invalid_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fixedError("artifact_malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fixedError("artifact_malformed");
  return parsed;
}

async function projectArtifact(root, kind) {
  const specification = ARTIFACTS[kind];
  try {
    const artifactPath = await resolveLocalLegacyReportReadPath(root, specification.file);
    const artifact = await readBoundedJson(artifactPath, MAX_ARTIFACT_BYTES);
    const snapshot = artifact.snapshot;
    if (!snapshot || typeof snapshot !== "object" || !snapshot.datasets || typeof snapshot.datasets !== "object") {
      throw fixedError("artifact_malformed");
    }
    const datasets = {};
    for (const [name, allowedKeys] of Object.entries(specification.datasets)) {
      datasets[name] = projectDataset(snapshot.datasets[name], allowedKeys);
    }
    return {
      status: "available",
      generatedAt: safeText(snapshot.generatedAt),
      artifactStatus: safeText(snapshot.status),
      datasets,
    };
  } catch (error) {
    return {
      status: "unavailable",
      generatedAt: null,
      artifactStatus: null,
      errorCode: error?.code ?? "artifact_unavailable",
      datasets: Object.fromEntries(Object.keys(specification.datasets).map((name) => [name, []])),
    };
  }
}

function unavailableLiveWeekly(errorCode) {
  return {
    status: "unavailable",
    generatedAt: null,
    artifactStatus: null,
    errorCode,
    dataClass: "live_replay_safe_cache",
    accountAttribution: null,
    datasets: {},
  };
}

function canonicalWeeklyInstant(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function finiteWeeklyNumber(value, {
  nullable = false,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
} = {}) {
  if (nullable && value === null) return true;
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function validWeeklyRange(range) {
  if (!range || typeof range !== "object" || Array.isArray(range)
      || !finiteWeeklyNumber(range.lower, { nullable: true, minimum: 0 })
      || !finiteWeeklyNumber(range.upper, { nullable: true, minimum: 0 })) {
    return false;
  }
  return range.lower === null
    || range.upper === null
    || range.lower <= range.upper;
}

function validWeeklyReset(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)
      || canonicalWeeklyInstant(row.resetIdentity) === null
      || canonicalWeeklyInstant(row.firstObservedAt) === null
      || canonicalWeeklyInstant(row.lastObservedAt) === null
      || Date.parse(row.firstObservedAt) > Date.parse(row.lastObservedAt)
      || !KNOWN_SLOTS.has(row.slot)
      || !finiteWeeklyNumber(row.observedSpanPercentagePoints, {
        minimum: 0,
        maximum: 100,
      })
      || !finiteWeeklyNumber(row.apiPriceEquivalentUsd, { minimum: 0 })
      || !validWeeklyRange(row.plausibleRangeUsd)
      || !Number.isSafeInteger(row.eligibleTransitions)
      || row.eligibleTransitions < 0
      || !Number.isSafeInteger(row.uniqueBoundaries)
      || row.uniqueBoundaries < 0
      || !finiteWeeklyNumber(row.knownSpeedFraction, {
        nullable: true,
        minimum: 0,
        maximum: 1,
      })
      // Speed evidence added after the first cache generation. An older cache
      // omits it entirely; absent is accepted and read as unknown, but a
      // present-and-malformed value is rejected rather than coerced.
      || (row.fastFractionOfKnown !== undefined
        && !finiteWeeklyNumber(row.fastFractionOfKnown, {
          nullable: true,
          minimum: 0,
          maximum: 1,
        }))
      || (row.speedEventCounts !== undefined
        && !validSpeedEventCounts(row.speedEventCounts))
      || !finiteWeeklyNumber(
        row.holdoutMeanAbsoluteErrorPercentagePoints,
        { nullable: true, minimum: 0, maximum: 100 },
      )
      || (row.priceCardIds !== undefined
        && (!Array.isArray(row.priceCardIds)
          || row.priceCardIds.length > 32
          || !row.priceCardIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)))
      || !validPriceCardProvenance(row.priceCardBreakdown)) {
    return false;
  }
  return true;
}

function validPriceCardProvenance(value) {
  return value === undefined || (
    Array.isArray(value)
    && value.length <= 32
    && value.every((item) => item
      && typeof item === "object"
      && !Array.isArray(item)
      && typeof item.priceCardId === "string"
      && item.priceCardId.length > 0
      && item.priceCardId.length <= 128
      && Number.isSafeInteger(item.events)
      && item.events >= 0
      && typeof item.costUsd === "string"
      && /^\d+(?:\.\d+)?$/u.test(item.costUsd))
  );
}

function validSpeedEventCounts(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && ["standard", "fast", "unknown"].every((key) => (
      Number.isSafeInteger(value[key]) && value[key] >= 0
    ));
}

// The composition-aware per-model calibration a v0.7 cache carries. Absent
// (older cache) and null (no usable fit) both read as "no composition";
// a present block must be coherent, and a vector may exist only under the
// "fitted" status.
function validWeeklyComposition(value) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["fitted", "fallback_blended", "insufficient_observations"]
        .includes(value.status)) return false;
  const numberOrNull = (candidate, minimum = Number.NEGATIVE_INFINITY) => (
    candidate === null
    || (typeof candidate === "number"
      && Number.isFinite(candidate)
      && candidate >= minimum)
  );
  if (!numberOrNull(value.r2)
      || !numberOrNull(value.singleConstantR2)
      || !numberOrNull(value.singleConstantUsd, 0)
      || !numberOrNull(value.blendedRecentMixUsd, 0)) return false;
  // Every model the fit saw, with its share of the fitted corpus cost. A model
  // below the kernel's share floor never gets a column of its own, so this
  // vector is the only record that it was in the mix at all.
  const shares = value.modelCostShares;
  if (shares !== null && shares !== undefined) {
    if (typeof shares !== "object" || Array.isArray(shares)) return false;
    if (!Object.entries(shares).every(([model, share]) => (
      typeof model === "string"
      && model.length > 0
      && model.length <= 64
      && (share === null
        || (typeof share === "number"
          && Number.isFinite(share)
          && share >= 0
          && share <= 1))
    ))) return false;
  }
  const vector = value.capacityUsdByModel;
  if (vector === null || vector === undefined) return value.status !== "fitted";
  if (value.status !== "fitted"
      || typeof vector !== "object" || Array.isArray(vector)) return false;
  return Object.entries(vector).every(([model, capacity]) => (
    typeof model === "string"
    && model.length > 0
    && model.length <= 64
    && (capacity === null
      || (typeof capacity === "number"
        && Number.isFinite(capacity)
        && capacity > 0))
  ));
}

function validLiveWeeklyCalibration(weekly) {
  if (!weekly || typeof weekly !== "object" || Array.isArray(weekly)
      || weekly.schemaVersion !== "weekly-calibration-summary-v0.1"
      || !["estimated", "insufficient_evidence"].includes(weekly.status)
      || canonicalWeeklyInstant(weekly.generatedAt) === null
      || weekly.evidenceBasis
        !== "lineage_aware_local_usage_and_provider_percentage_snapshots"
      || weekly.interpretation
        !== "conditional_api_price_equivalent_not_provider_allowance_or_bill"
      || weekly.accountAttribution?.status !== "historical_unattributed"
      || weekly.accountAttribution?.maySpanMultipleAccounts !== true
      || weekly.accountAttribution?.label
        !== "Historical estimate; account-unattributed and may combine multiple accounts"
      || !Array.isArray(weekly.limitations)
      || weekly.limitations.length < 1
      || weekly.limitations.length > 8
      || !weekly.limitations.every((value) => (
        typeof value === "string"
        && value.length > 0
        && value.length <= MAX_SAFE_TEXT_LENGTH
        && safeText(value) === value
      ))
      || !Array.isArray(weekly.recentResets)
      || weekly.recentResets.length
        > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT
      || !weekly.recentResets.every(validWeeklyReset)
      || !validWeeklyComposition(weekly.composition)
      || !weekly.validation
      || typeof weekly.validation !== "object"
      || Array.isArray(weekly.validation)) {
    return false;
  }
  const estimate = weekly.estimate;
  if (weekly.status === "estimated") {
    if (!estimate || typeof estimate !== "object" || Array.isArray(estimate)
        || !Number.isSafeInteger(estimate.qualifyingResets)
        || estimate.qualifyingResets < 1
        || !finiteWeeklyNumber(
          estimate.medianApiPriceEquivalentUsd,
          { minimum: 0 },
        )
        || !validWeeklyRange(estimate.plausibleRangeUsd)
        || !finiteWeeklyNumber(estimate.minimumUsd, { minimum: 0 })
        || !finiteWeeklyNumber(estimate.maximumUsd, { minimum: 0 })
        || estimate.minimumUsd > estimate.maximumUsd) {
      return false;
    }
  } else if (estimate !== null) {
    return false;
  }
  const validation = weekly.validation;
  if (validation.selectedCostBasis !== null
      && (typeof validation.selectedCostBasis !== "string"
        || validation.selectedCostBasis.length < 1
        || validation.selectedCostBasis.length > 128
        || safeText(validation.selectedCostBasis)
          !== validation.selectedCostBasis)) {
    return false;
  }
  return [
    validation.sameResetHoldoutMeanAbsoluteErrorPercentagePoints,
    validation.priorResetMeanAbsoluteErrorPercentagePoints,
    validation.forecastErrorP80PercentagePoints,
  ].every((value) => finiteWeeklyNumber(
    value,
    { nullable: true, minimum: 0, maximum: 100 },
  )) && finiteWeeklyNumber(
    validation.priorResetAbsoluteBiasPercentagePoints,
    { nullable: true, minimum: -100, maximum: 100 },
  );
}

function projectLiveWeeklyCalibration(cache, cacheReadErrorCode = null) {
  const weekly = cache?.weeklyCalibration;
  if (!weekly) {
    return unavailableLiveWeekly(
      cacheReadErrorCode === "cache_invalid"
        || cacheReadErrorCode === "cache_malformed"
        || cacheReadErrorCode === "cache_invalid_size"
        || cacheReadErrorCode === "cache_price_registry_outdated"
        || cacheReadErrorCode === "cache_accounting_semantics_outdated"
        ? "live_cache_invalid"
        : "live_cache_missing",
    );
  }
  if (!validLiveWeeklyCalibration(weekly)) {
    return unavailableLiveWeekly("live_cache_invalid");
  }
  const estimate = weekly.estimate;
  return {
    status: weekly.status === "estimated" ? "available" : "insufficient_evidence",
    generatedAt: weekly.generatedAt,
    artifactStatus: weekly.status,
    errorCode: null,
    dataClass: "live_replay_safe_cache",
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
      label:
        "Historical estimate; account-unattributed and may combine multiple accounts",
    },
    interpretation: weekly.interpretation,
    limitations: [...weekly.limitations],
    datasets: {
      summary: [{
        median_weekly_value_usd:
          estimate?.medianApiPriceEquivalentUsd ?? null,
        lower_80_across_resets_usd:
          estimate?.plausibleRangeUsd?.lower ?? null,
        upper_80_across_resets_usd:
          estimate?.plausibleRangeUsd?.upper ?? null,
        // Composition-aware per-model calibration (v0.7 cache). The blended
        // figure is the cost-weighted rate over the recent mix — the honest
        // headline for "$ per point" copy — and the vector powers per-model
        // detail plus the composition-aware expected line. All null on an
        // older cache or a corpus that could not support the fit.
        composition_status: weekly.composition?.status ?? null,
        blended_capacity_usd:
          weekly.composition?.blendedRecentMixUsd ?? null,
        capacity_by_model:
          weekly.composition?.capacityUsdByModel ?? null,
        // The fitted mix itself. A model whose share sits under the kernel's
        // floor holds no column of its own and used to vanish from the card
        // entirely; the card now names it against the pooled remainder rate
        // instead, which needs this vector to know it existed.
        model_cost_shares:
          weekly.composition?.modelCostShares ?? null,
        composition_r2: weekly.composition?.r2 ?? null,
        composition_single_constant_r2:
          weekly.composition?.singleConstantR2 ?? null,
        composition_observations:
          weekly.composition?.observationCount ?? null,
        qualifying_resets: estimate?.qualifyingResets ?? 0,
        selected_holdout_mae_pp:
          weekly.validation
            ?.sameResetHoldoutMeanAbsoluteErrorPercentagePoints ?? null,
        prior_reset_mae_pp:
          weekly.validation
            ?.priorResetMeanAbsoluteErrorPercentagePoints ?? null,
        prior_reset_bias_pp:
          weekly.validation
            ?.priorResetAbsoluteBiasPercentagePoints ?? null,
        prior_reset_p80_absolute_error_pp:
          weekly.validation?.forecastErrorP80PercentagePoints ?? null,
      }],
      weekly_values: weekly.recentResets.map((row, index) => ({
        sequence: index + 1,
        first_observed_at: row.firstObservedAt,
        last_observed_at: row.lastObservedAt,
        reset_due_at: row.resetIdentity,
        slot: row.slot,
        displayed_span_pp: row.observedSpanPercentagePoints,
        value_usd: row.apiPriceEquivalentUsd,
        pairwise_p10_usd: row.plausibleRangeUsd?.lower ?? null,
        pairwise_p90_usd: row.plausibleRangeUsd?.upper ?? null,
        holdout_mae_pp:
          row.holdoutMeanAbsoluteErrorPercentagePoints,
        known_speed_fraction: row.knownSpeedFraction,
        eligible_transitions: row.eligibleTransitions,
        unique_percentage_boundaries: row.uniqueBoundaries,
        price_card_ids: row.priceCardIds ?? [],
        price_card_breakdown: row.priceCardBreakdown ?? [],
      })),
    },
  };
}

function projectSelectedAllowanceWeeklyCalibration(
  cache,
  preference,
  cacheReadErrorCode = null,
) {
  // The ordinary weekly summary is a diagnostic model-selection result.
  // Allowance-facing copy instead uses the forced speed scenario that matches
  // the timeline numerator. The existing scalar weekly UI cannot safely show
  // a mixed-unknown pair, so that state remains explicit and unavailable.
  if (preference === "mixed_unknown") {
    return unavailableLiveWeekly("allowance_capacity_range_not_renderable");
  }
  const scenario = preference === "fast"
    ? "unresolved_as_fast"
    : "unresolved_as_standard";
  const container = cache?.allowanceCapacityByScenario;
  const source = container?.scenarios?.[scenario];
  const expected = codexPrimaryAllowanceBasis(scenario);
  if (container?.schemaVersion !== ALLOWANCE_CAPACITY_SCHEMA_VERSION
      || container?.basisFamilyId !== expected.basisFamilyId
      || !allowanceBasisMatches(source?.basis, scenario)) {
    return unavailableLiveWeekly(
      cacheReadErrorCode === "cache_invalid"
        || cacheReadErrorCode === "cache_malformed"
        || cacheReadErrorCode === "cache_invalid_size"
        || cacheReadErrorCode === "cache_price_registry_outdated"
        || cacheReadErrorCode === "cache_accounting_semantics_outdated"
        ? "live_cache_invalid"
        : "allowance_capacity_cache_unavailable",
    );
  }
  const projected = projectLiveWeeklyCalibration({
    weeklyCalibration: source.calibration,
  }, cacheReadErrorCode);
  if (projected.status === "unavailable") return projected;
  return {
    ...projected,
    allowanceBasis: {
      scenario,
      basisFamilyId: expected.basisFamilyId,
      basisId: expected.basisId,
    },
  };
}

function allowanceBasisMatches(value, scenario) {
  const expected = codexPrimaryAllowanceBasis(scenario);
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(expected).every(([key, expectedValue]) => (
      value[key] === expectedValue
    ))
    && Object.keys(value).length === Object.keys(expected).length;
}

function projectAllowanceCapacityScenario(container, scenario) {
  const source = container?.scenarios?.[scenario];
  const calibration = source?.calibration;
  if (!allowanceBasisMatches(source?.basis, scenario)
      || !validLiveWeeklyCalibration(calibration)
      || calibration.status !== "estimated") return null;
  const estimate = calibration.estimate;
  if (!Number.isFinite(estimate?.medianApiPriceEquivalentUsd)
      || estimate.medianApiPriceEquivalentUsd <= 0
      || !validWeeklyRange(estimate.plausibleRangeUsd)
      || !Number.isFinite(estimate.plausibleRangeUsd.lower)
      || estimate.plausibleRangeUsd.lower <= 0
      || !Number.isFinite(estimate.plausibleRangeUsd.upper)) return null;
  const cohort = calibration.recentResets.map((row) => row.resetIdentity);
  return {
    basisId: source.basis.basisId,
    medianCapacityUsd: estimate.medianApiPriceEquivalentUsd,
    plausibleRangeUsd: { ...estimate.plausibleRangeUsd },
    qualifyingResets: estimate.qualifyingResets,
    cohortId: createHash("sha256")
      .update(JSON.stringify(cohort))
      .digest("hex"),
    validation: {
      sameResetHoldoutMeanAbsoluteErrorPercentagePoints:
        calibration.validation
          .sameResetHoldoutMeanAbsoluteErrorPercentagePoints,
      priorResetMeanAbsoluteErrorPercentagePoints:
        calibration.validation
          .priorResetMeanAbsoluteErrorPercentagePoints,
      priorResetAbsoluteBiasPercentagePoints:
        calibration.validation.priorResetAbsoluteBiasPercentagePoints,
      forecastErrorP80PercentagePoints:
        calibration.validation.forecastErrorP80PercentagePoints,
      scoredPriorResets: calibration.validation.scoredPriorResets,
      scoredPriorPoints: calibration.validation.scoredPriorPoints,
    },
    cohort,
  };
}

function comparableAllowanceCapacityCohort(left, right) {
  return left !== null && right !== null
    && left.qualifyingResets === right.qualifyingResets
    && left.cohort.length === right.cohort.length
    && left.cohort.every((resetIdentity, index) => (
      resetIdentity === right.cohort[index]
    ));
}

function projectAllowanceCapacity(container, preference) {
  const standardBasis = codexPrimaryAllowanceBasis(
    "unresolved_as_standard",
  );
  const unavailable = (reason, scenarios = {
    unresolved_as_standard: null,
    unresolved_as_fast: null,
  }) => ({
    status: "unavailable",
    reason,
    basisFamilyId: standardBasis.basisFamilyId,
    selectedScenario: null,
    scenarios,
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  });
  if (!container || typeof container !== "object" || Array.isArray(container)
      || container.schemaVersion !== ALLOWANCE_CAPACITY_SCHEMA_VERSION
      || container.basisFamilyId !== standardBasis.basisFamilyId) {
    return unavailable("allowance_capacity_cache_unavailable");
  }
  const internal = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    projectAllowanceCapacityScenario(container, scenario),
  ]));
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => {
    const row = internal[scenario];
    if (row === null) return [scenario, null];
    const { cohort: _cohort, ...projected } = row;
    return [scenario, projected];
  }));
  if (preference === "mixed_unknown") {
    if (!comparableAllowanceCapacityCohort(
      internal.unresolved_as_standard,
      internal.unresolved_as_fast,
    )) {
      return unavailable(
        "allowance_capacity_scenarios_not_comparable",
        scenarios,
      );
    }
    return {
      status: "range",
      reason: null,
      basisFamilyId: standardBasis.basisFamilyId,
      selectedScenario: null,
      scenarios,
      accountAttribution: {
        status: "historical_unattributed",
        maySpanMultipleAccounts: true,
      },
    };
  }
  const selectedScenario = preference === "fast"
    ? "unresolved_as_fast"
    : "unresolved_as_standard";
  if (internal[selectedScenario] === null) {
    return unavailable("selected_allowance_capacity_unavailable", scenarios);
  }
  return {
    status: "available",
    reason: null,
    basisFamilyId: standardBasis.basisFamilyId,
    selectedScenario,
    scenarios,
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  };
}

async function readCollectorProjection(
  stateFile,
  nowMs,
  { summarizeUsageEvents = true, declaredSpeedBaselines = [] } = {},
) {
  let state;
  try {
    state = await readLocalCollectorState({ stateFile, includeRecords: false });
  } catch {
    throw fixedError("collector_unavailable");
  }
  if (state.status === "missing") {
    return {
      status: "missing",
      recordCount: 0,
      malformedLines: 0,
      firstRecordAt: null,
      latestRecordAt: null,
      firstExportableRecordAt: null,
      latestExportableRecordAt: null,
      usage: summarizeUsage([], nowMs),
      quota: latestQuotaProjection([]),
      tools: summarizeToolClasses([]),
      timeline: {
        bucketMinutes: 15,
        usage: [],
        quota: [],
        sparkUsage: [],
        sparkQuota: [],
      },
      recordCounts: { usage: 0, quota: 0, tools: 0, other: 0 },
      paceForecast: projectWeeklyPaceForecast({ nowMs }),
    };
  }
  const periods = [
    { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
    // The collector is a bounded recent state store, not an all-history source.
    // Keep its broadest selectable period explicit even if the state happens
    // to contain older rows from an earlier run.
    {
      summary: newUsagePeriod("all", RECENT_COLLECTOR_PERIOD_LABEL),
      start: nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000,
    },
  ];
  const toolCounts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [toolClass, 0]));
  const recordCounts = { usage: 0, quota: 0, tools: 0, other: 0 };
  const pricer = createAccountingPricer();
  const recentStartMs = nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000;
  const timelineBuckets = new Map();
  const sparkTimelineBuckets = new Map();
  const quotaTimeline = [];
  const weeklyPaceSnapshots = [];
  let toolTotal = 0;
  let recordCount = 0;
  const malformedLines = Number.isSafeInteger(state.migration?.source?.malformedLines)
    ? state.migration.source.malformedLines
    : 0;
  let firstRecordAt = null;
  let latestRecordAt = null;
  let firstExportableRecordAt = null;
  let latestExportableRecordAt = null;
  let latestQuotaRecord = null;
  await forEachLocalCollectorRecord({ stateFile, onRecord: async (value) => {
    recordCount += 1;
    if (recordCount > MAX_LEDGER_RECORDS) throw fixedError("collector_invalid_size");
    const observedMs = validObservedAt(value);
    if (observedMs !== null && (firstRecordAt === null || observedMs < firstRecordAt)) {
      firstRecordAt = observedMs;
    }
    if (observedMs !== null && (latestRecordAt === null || observedMs > latestRecordAt)) {
      latestRecordAt = observedMs;
    }
    if (value.kind === "codex_quota_snapshot") {
      recordCounts.quota += 1;
    } else if (value.kind === "codex_rollout_usage_snapshot") {
      recordCounts.usage += 1;
    } else if (value.kind === "codex_tool_class_event") {
      recordCounts.tools += 1;
    } else {
      recordCounts.other += 1;
    }
    if (value.kind === "codex_quota_snapshot" && observedMs !== null) {
      if (latestQuotaRecord === null
          || value.observedAt.localeCompare(latestQuotaRecord.observedAt) > 0) {
        latestQuotaRecord = value;
      }
      if (observedMs >= recentStartMs && observedMs <= nowMs + 5 * 60_000) {
        weeklyPaceSnapshots.push(
          ...weeklyPaceSnapshotsFromCollectorRecord(value),
        );
        if (weeklyPaceSnapshots.length > MAX_WEEKLY_PACE_OBSERVATIONS * 2) {
          weeklyPaceSnapshots.sort((left, right) => (
            left.observedAt.localeCompare(right.observedAt)
            || left.receivedAt.localeCompare(right.receivedAt)
            || left.accountTrackId.localeCompare(right.accountTrackId)
            || left.slot.localeCompare(right.slot)
          ));
          weeklyPaceSnapshots.splice(
            0,
            weeklyPaceSnapshots.length - MAX_WEEKLY_PACE_OBSERVATIONS,
          );
        }
      }
      if (observedMs >= recentStartMs && observedMs <= nowMs + 5 * 60_000) {
        for (const window of Array.isArray(value.windows) ? value.windows : []) {
          const projected = quotaWindowProjection(window);
          if (projected === null) continue;
          quotaTimeline.push({
            observedAt: new Date(observedMs).toISOString(),
            ...projected,
            accountAttribution: value.accountScope?.status === "available"
              ? "attributed_pseudonymous"
              : "unattributed",
          });
        }
      }
    }
    if (value.kind === "codex_rollout_usage_snapshot"
        && observedMs !== null && observedMs <= nowMs + 5 * 60_000) {
      if (firstExportableRecordAt === null
          || observedMs < firstExportableRecordAt) {
        firstExportableRecordAt = observedMs;
      }
      if (latestExportableRecordAt === null
          || observedMs > latestExportableRecordAt) {
        latestExportableRecordAt = observedMs;
      }
      if (summarizeUsageEvents) {
        const observedSpeed = safeSpeed(value.tierSemantics?.codexSpeedMode);
        // An observed tier always wins, so a declaration is only ever looked
        // up for the turns the rollout log left unobserved.
        const projection = usageProjection(
          value,
          observedSpeed === "unknown"
            ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
            : "unknown",
          pricer,
        );
        for (const period of periods) {
          if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
        }
        if (observedMs >= recentStartMs) {
          addTimelineUsage(
            projection?.isSpark ? sparkTimelineBuckets : timelineBuckets,
            observedMs,
            projection,
          );
        }
      }
    }
    if (value.kind === "codex_tool_class_event") {
      if (observedMs !== null && observedMs <= nowMs + 5 * 60_000) {
        if (firstExportableRecordAt === null
            || observedMs < firstExportableRecordAt) {
          firstExportableRecordAt = observedMs;
        }
        if (latestExportableRecordAt === null
            || observedMs > latestExportableRecordAt) {
          latestExportableRecordAt = observedMs;
        }
      }
      const toolClass = KNOWN_TOOL_CLASSES.has(value.toolClass) ? value.toolClass : "other";
      toolCounts[toolClass] += 1;
      toolTotal += 1;
    }
  } });
  if (weeklyPaceSnapshots.length > MAX_WEEKLY_PACE_OBSERVATIONS) {
    weeklyPaceSnapshots.sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || left.receivedAt.localeCompare(right.receivedAt)
      || left.accountTrackId.localeCompare(right.accountTrackId)
      || left.slot.localeCompare(right.slot)
    ));
    weeklyPaceSnapshots.splice(
      0,
      weeklyPaceSnapshots.length - MAX_WEEKLY_PACE_OBSERVATIONS,
    );
  }
  const paceForecast = projectWeeklyPaceForecast({
    currentRecord: latestQuotaRecord,
    observations: weeklyPaceSnapshots,
    nowMs,
  });
  const projection = {
    status: "available",
    recordCount,
    malformedLines,
    firstRecordAt,
    latestRecordAt,
    firstExportableRecordAt,
    latestExportableRecordAt,
    usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
    quota: latestQuotaProjection(latestQuotaRecord === null ? [] : [latestQuotaRecord]),
    tools: { total: toolTotal, counts: toolCounts },
    timeline: {
      bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
      coveredAt: {
        startAt: timelineBuckets.size === 0
          ? null
          : new Date(Math.min(...timelineBuckets.keys())).toISOString(),
        endAt: timelineBuckets.size === 0
          ? null
          : new Date(Math.max(...timelineBuckets.keys()) + TIMELINE_BUCKET_MS).toISOString(),
      },
      usage: finalizeTimelineBuckets(timelineBuckets),
      sparkUsage: finalizeTimelineBuckets(sparkTimelineBuckets),
      quota: finalizeQuotaTimeline(
        quotaTimeline.filter((row) => row.limitId === "codex"),
      ),
      sparkQuota: finalizeQuotaTimeline(
        // The Spark limit is reported as `codex_bengalfox` in practice;
        // `codex-spark` is the reserved marketing token. Match both so the
        // series cannot be permanently empty against real captures.
        quotaTimeline.filter((row) => SPARK_QUOTA_LIMIT_IDS.includes(row.limitId)),
      ),
    },
    recordCounts,
    paceForecast,
  };
  return projection;
}

function safeIndexCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function canonicalIndexInstant(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function validCollectorIndexDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = [
    "boundedBy",
    "coveredAt",
    "filesDiscovered",
    "filesProcessed",
    "filesSelected",
    "mode",
    "phase",
    "recordsWritten",
    "status",
  ];
  if (Object.keys(value).sort().join("\0")
      !== expected.sort().join("\0")) return false;
  if (!value.coveredAt || typeof value.coveredAt !== "object"
      || Array.isArray(value.coveredAt)
      || Object.keys(value.coveredAt).sort().join("\0")
        !== "endAt\0startAt") return false;
  const startAt = canonicalIndexInstant(value.coveredAt.startAt);
  const endAt = canonicalIndexInstant(
    value.coveredAt.endAt,
    { nullable: true },
  );
  if ((startAt === null
        && !(value.status === "recent_7d_partial"
          && value.coveredAt.startAt === null))
      || (value.coveredAt.endAt !== null && endAt === null)
      || value.boundedBy !== "modified_at_and_collection_start"
      || !["recent_7d", "prospective"].includes(value.mode)
      || !["recent_7d_indexing", "recent_7d_complete",
        "recent_7d_partial", "prospective_only", "bounded_pause"].includes(value.status)
      || !["discovering", "rollout_index", "quota_refresh",
        "complete", "paused", "prospective"].includes(value.phase)
      || !["filesDiscovered", "filesSelected", "filesProcessed",
        "recordsWritten"].every((key) => (
        Number.isSafeInteger(value[key]) && value[key] >= 0
      ))
      || value.filesSelected > value.filesDiscovered
      || value.filesProcessed > value.filesSelected) return false;
  if (value.status === "prospective_only") {
    return value.mode === "prospective"
      && value.phase === "prospective"
      && endAt !== null;
  }
  if (value.status === "bounded_pause") {
    return value.phase === "paused" && endAt === null;
  }
  if (value.mode !== "recent_7d") return false;
  if (value.status === "recent_7d_complete") {
    return ["complete", "quota_refresh"].includes(value.phase)
      && endAt !== null;
  }
  if (value.status === "recent_7d_partial") {
    return value.phase === "complete" && endAt !== null;
  }
  return ["discovering", "rollout_index"].includes(value.phase)
    && endAt === null;
}

async function readCollectorIndexProjection(stateFile, collector) {
  let state;
  try {
    state = await readLocalCollectorState({ stateFile, includeRecords: false });
  } catch {
    throw fixedError("collector_unavailable");
  }
  if (state.status === "missing" || state.checkpoint === null) {
      return {
        status: "not_started",
        phase: "starting",
        mode: "recent_7d",
        filesDiscovered: 0,
        filesSelected: 0,
        filesProcessed: 0,
        recordsWritten: 0,
        coveredAt: { startAt: null, endAt: null },
        boundedBy: "modified_at_and_collection_start",
      };
  }
  const checkpoint = state.checkpoint;
  const diagnostics = checkpoint?.diagnostics ?? {};
  const retainedFiles = checkpoint?.files
    && typeof checkpoint.files === "object"
    && !Array.isArray(checkpoint.files)
    ? Object.keys(checkpoint.files).length
    : 0;
  const raw = validCollectorIndexDescriptor(checkpoint?.indexing)
    ? checkpoint.indexing
    : null;
  const status = raw !== null
    ? raw.status
    : safeIndexCount(diagnostics.filesInitializedAtEnd) > 0
      ? "prospective_only"
      : collector.recordCount > 0
        ? "retained_ledger_only"
        : "not_started";
  const phase = raw !== null
    ? raw.phase
    : status === "bounded_pause" ? "paused"
      : status === "prospective_only" ? "prospective" : "complete";
  return {
    status,
    phase,
    mode: raw?.mode === "recent_7d" ? "recent_7d" : "prospective",
    filesDiscovered: safeIndexCount(
      raw?.filesDiscovered ?? diagnostics.filesDiscovered,
    ),
    filesSelected: safeIndexCount(raw?.filesSelected ?? retainedFiles),
    filesProcessed: safeIndexCount(
      raw?.filesProcessed
      ?? (["recent_7d_complete", "recent_7d_partial",
        "prospective_only", "retained_ledger_only"].includes(status)
        ? retainedFiles
        : 0),
    ),
    recordsWritten: safeIndexCount(
      raw?.recordsWritten ?? diagnostics.rolloutRecordsWritten,
    ),
    coveredAt: {
      startAt: collector.firstRecordAt === null
        ? null
        : new Date(collector.firstRecordAt).toISOString(),
      endAt: collector.latestRecordAt === null
        ? null
        : new Date(collector.latestRecordAt).toISOString(),
    },
    boundedBy: raw?.boundedBy === "modified_at_and_collection_start"
      ? raw.boundedBy
      : "prospective_checkpoint_and_retained_ledger",
  };
}

function latestQuotaProjection(records) {
  const latest = records
    .filter((record) => record.kind === "codex_quota_snapshot" && validObservedAt(record) !== null)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .at(-1);
  if (!latest) return { status: "unavailable", observedAt: null, windows: [] };
  const windows = Array.isArray(latest.windows)
    ? orderQuotaWindows(latest.windows.flatMap((window) => {
      const projected = quotaWindowProjection(window);
      return projected === null ? [] : [projected];
    }))
    : [];
  return {
    status: windows.length > 0 ? "available" : "unavailable",
    observedAt: safeText(latest.observedAt),
    accountAttribution: latest.accountScope?.status === "available"
      ? "attributed_pseudonymous"
      : "unattributed",
    windows,
  };
}

function summarizeToolClasses(records) {
  const counts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [toolClass, 0]));
  let total = 0;
  for (const record of records) {
    if (record.kind !== "codex_tool_class_event") continue;
    const toolClass = KNOWN_TOOL_CLASSES.has(record.toolClass) ? record.toolClass : "other";
    counts[toolClass] += 1;
    total += 1;
  }
  return { total, counts };
}

function summarizeUsage(records, nowMs) {
  const periods = [
    { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
    {
      summary: newUsagePeriod("all", RECENT_COLLECTOR_PERIOD_LABEL),
      start: nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000,
    },
  ];
  const pricer = createAccountingPricer();
  for (const record of records) {
    if (record.kind !== "codex_rollout_usage_snapshot") continue;
    const observedMs = validObservedAt(record);
    if (observedMs === null || observedMs > nowMs + 5 * 60_000) continue;
    const projection = usageProjection(record, "unknown", pricer);
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
    }
  }
  return periods.map((period) => finalizeUsagePeriod(period.summary));
}

async function reportProjection(root) {
  return Promise.all(REPORTS.map(async ({ file, ...report }) => {
    try {
      const reportPath = await resolveLocalLegacyReportReadPath(root, file);
      const metadata = await lstat(reportPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not_file");
      return { ...report, status: "available", updatedAt: metadata.mtime.toISOString() };
    } catch {
      return { ...report, status: "unavailable", updatedAt: null };
    }
  }));
}

// Accounting period identifiers mapped to their trailing window. "all" has no
// bound and is deliberately absent rather than given a sentinel duration.
const FAST_MODE_PERIOD_WINDOW_MS = Object.freeze({
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
});

function fastModeCalibrationWindows(weekly) {
  const resets = Array.isArray(weekly?.recentResets) ? weekly.recentResets : [];
  return resets.filter(validWeeklyReset).map((row) => ({
    id: row.resetIdentity,
    startAt: row.firstObservedAt,
    endAt: row.lastObservedAt,
    apiPriceEquivalentUsd: row.apiPriceEquivalentUsd,
    knownSpeedFraction: row.knownSpeedFraction ?? null,
    fastFractionOfKnown: row.fastFractionOfKnown ?? null,
    eligibleTransitions: row.eligibleTransitions,
    uniqueBoundaries: row.uniqueBoundaries,
    observedSpanPercentagePoints: row.observedSpanPercentagePoints,
    unknownSpeedEvents: row.speedEventCounts?.unknown ?? 0,
  }));
}

// Inference is a window-level label, so only windows that reach into the
// displayed accounting period may contribute a count to it.
function inferredFastEventsInPeriod(inference, periodId, nowMs) {
  if (inference.status !== "inferred") return 0;
  const windowMs = FAST_MODE_PERIOD_WINDOW_MS[periodId];
  const startMs = windowMs === undefined
    ? Number.NEGATIVE_INFINITY
    : nowMs - windowMs;
  let events = 0;
  for (const window of inference.windows) {
    if (window.mode !== "fast") continue;
    const endMs = Date.parse(window.endAt);
    if (!Number.isFinite(endMs) || endMs < startMs) continue;
    events += window.unknownSpeedEvents;
  }
  return events;
}

function fastModeProjection(period, { preference, inference, nowMs }) {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: safeSpeedWeighting(period?.speedWeighting),
    declaredSpeedWeighting: safeSpeedWeighting(period?.declaredSpeedWeighting),
    preference,
    inferredFastEvents: inferredFastEventsInPeriod(
      inference,
      period?.id ?? "all",
      nowMs,
    ),
    inference,
  });
  return {
    preference: summary.preference,
    defaultPreference: DEFAULT_FAST_MODE_PREFERENCE,
    // Codex records a tier only when the setting is applied or changed, never
    // at session start. Observed values forward-fill and always win; the
    // preference attributes only the turns that precede the first observation
    // in their session.
    logObservability: { ...CODEX_SPEED_MODE_OBSERVABILITY },
    // The Codex configuration's `service_tier` key recovers the baseline the
    // log never writes, but only forward from the moment it was read.
    declarationSource: { ...CODEX_SPEED_MODE_DECLARATION },
    metricKey: QUOTA_WEIGHTED_API_PRICE_METRIC.key,
    metricLabel: QUOTA_WEIGHTED_API_PRICE_METRIC.label,
    metricShortLabel: QUOTA_WEIGHTED_API_PRICE_METRIC.shortLabel,
    metricExplainer: QUOTA_WEIGHTED_API_PRICE_METRIC.explainer,
    standardMetricKey: QUOTA_WEIGHTED_API_PRICE_METRIC.standardMetricKey,
    standardMetricLabel: QUOTA_WEIGHTED_API_PRICE_METRIC.standardMetricLabel,
    multipliers: { ...FAST_MODE_QUOTA_MULTIPLIERS },
    multiplierSource: { ...FAST_MODE_MULTIPLIER_SOURCE },
    quotaWeightedApiPriceEquivalentUsd:
      summary.quotaWeightedApiPriceEquivalentUsd,
    standardApiPriceEquivalentUsd: summary.standardApiPriceEquivalentUsd,
    unweightedUnknownApiPriceEquivalentUsd:
      summary.unweightedUnknownApiPriceEquivalentUsd,
    weightingStatus: summary.weightingStatus,
    appliedMultipliers: { ...summary.appliedMultipliers },
    coverage: { ...summary.coverage },
    inference: {
      ...summary.inference,
      referenceWindowCount: inference.referenceWindowCount,
      scoredWindowCount: inference.scoredWindowCount,
      relativeTolerance:
        inference.thresholds.relativeToleranceOfPublishedMultiple,
    },
  };
}

// Blind-spot status for Fast-mode attribution. The honest reading is a share,
// never a bare "observed"/"not observed".
function fastModeGapStatus(coverage) {
  if (coverage.totalEvents === 0) return "insufficient_evidence";
  if (coverage.unknownEvents === 0) {
    return coverage.observedEvents === coverage.totalEvents
      ? "observed"
      : "partial";
  }
  return coverage.unknownSharePercent > 50 ? "mostly_unknown" : "partial";
}

// Timeline rows keep their Standard-price amount for a separately labelled
// accounting-only fallback. Whenever provider allowance is shown, consumers
// use only this independently projected quota-weighted amount. The full speed
// crossing stays server-side and an incomplete crossing fails closed.
function quotaWeightedUsageTimeline(rows, { preference, inference }) {
  return rows.map((row) => {
    const speedWeighting = safeSpeedWeighting(row.speedWeighting);
    const declaredSpeedWeighting = safeSpeedWeighting(
      row.declaredSpeedWeighting,
    );
    const summaries = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
      scenario,
      summarizeQuotaWeightedAccounting({
        speedWeighting,
        declaredSpeedWeighting,
        preference: scenario === "unresolved_as_fast" ? "fast" : "standard",
        inference,
      }),
    ]));
    const crossingComplete = Object.values(summaries).every((summary) => (
      summary.coverage.totalEvents === row.usageEvents
      && Math.abs(
        summary.standardApiPriceEquivalentUsd - row.apiPriceEquivalentUsd,
      ) <= 0.00002
    ));
    const hasUnpricedEvents = (row.pricingCoverage?.unpricedEvents ?? 0) > 0;
    const crossingUsable = crossingComplete && !hasUnpricedEvents;
    const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => {
      const basis = codexPrimaryAllowanceBasis(scenario);
      const summary = summaries[scenario];
      const complete = crossingUsable
        && summary.weightingStatus === "complete"
        && summary.coverage.unknownEvents === 0;
      const coverage = crossingUsable
        ? { ...summary.coverage }
        : {
          totalEvents: row.usageEvents,
          observedEvents: 0,
          declaredFromConfigEvents: 0,
          assumedFromPreferenceEvents: 0,
          inferredEvents: 0,
          unknownEvents: row.usageEvents,
          observedSharePercent: row.usageEvents === 0 ? null : 0,
          unknownSharePercent: row.usageEvents === 0 ? null : 100,
        };
      return [scenario, {
        basisId: basis.basisId,
        sourceWeightingStatus: crossingUsable
          ? summary.weightingStatus
          : "unknown",
        quotaWeightedUsd: complete
          ? summary.quotaWeightedApiPriceEquivalentUsd
          : null,
        coveredSubtotalUsd: crossingUsable
          && summary.weightingStatus !== "unknown"
          ? summary.quotaWeightedApiPriceEquivalentUsd
          : 0,
        coverage,
      }];
    }));
    const {
      speedWeighting: _speedWeighting,
      declaredSpeedWeighting: _declaredSpeedWeighting,
      ...publicRow
    } = row;
    return {
      ...publicRow,
      // Each eight-cell scenario block is: status code, weighted USD,
      // covered USD, observed events, declared events, assumed events,
      // inferred events, unresolved events. The browser reconstructs and
      // validates the verbose shape before any allowance arithmetic.
      allowanceWeighting: ALLOWANCE_SCENARIOS.flatMap((scenario) => {
        const value = scenarios[scenario];
        const coverage = value.coverage;
        return [
          TIMELINE_WEIGHTING_STATUS_CODE[value.sourceWeightingStatus],
          value.quotaWeightedUsd,
          value.coveredSubtotalUsd,
          coverage.observedEvents,
          coverage.declaredFromConfigEvents,
          coverage.assumedFromPreferenceEvents,
          coverage.inferredEvents,
          coverage.unknownEvents,
        ];
      }),
    };
  });
}

function timelineAllowanceWeightingEncoding(preference) {
  return {
    schemaVersion: TIMELINE_ALLOWANCE_WEIGHTING_SCHEMA_VERSION,
    basisFamilyId: codexPrimaryAllowanceBasis(
      "unresolved_as_standard",
    ).basisFamilyId,
    scenarioOrder: [...ALLOWANCE_SCENARIOS],
    selectedScenario: preference === "mixed_unknown"
      ? null
      : preference === "fast"
        ? "unresolved_as_fast"
        : "unresolved_as_standard",
  };
}

export async function buildLocalCompanionSnapshot({
  root = process.cwd(),
  collectorStateFile = defaultLocalCollectorStatePath(root),
  archiveIndexFile = defaultLocalArchiveAccountingIndexPath(root),
  // The unified local index. When it is present the "All" period and the
  // timelines draw from its whole fork-replay-suppressed history; when it is
  // absent the snapshot says so and stays on the bounded recent window.
  unifiedIndexFile = defaultLocalUnifiedIndexPath(root),
  allowDevelopmentArtifactFallback = false,
  // Owner-stated Codex speed mode. The composition root reads it from
  // owner-only local state; an unrecognised value never becomes a silent Fast.
  fastModePreference = DEFAULT_FAST_MODE_PREFERENCE,
  // Timestamped Codex `service_tier` readings from the owner-only declared
  // baseline ledger. Each covers only the interval it was observed over, so a
  // reading never reaches back before it happened, and an observed tier always
  // wins over it. An absent or unreadable ledger is simply no coverage.
  codexSpeedBaselines = [],
  now = () => Date.now(),
} = {}) {
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
  // Make a legacy installation converge before any snapshot readers race to
  // inspect it. Once complete this is a cheap receipt check; it never revives
  // JSON as an active state backend.
  await prepareLocalCollectorState({ stateFile: collectorStateFile, clock: () => nowMs });
  const declaredSpeedBaselines = Array.isArray(codexSpeedBaselines)
    ? codexSpeedBaselines
    : [];
  const selectedFastModePreference = isFastModePreference(fastModePreference)
    ? fastModePreference
    : DEFAULT_FAST_MODE_PREFERENCE;
  const [replaySafeAccounting, archiveCoverage, archiveAccounting, unified] =
    await Promise.all([
      readReplaySafeAccountingCache({
        stateFile: collectorStateFile,
        now: () => nowMs,
        maximumAgeMs: MAX_REPLAY_SAFE_CACHE_AGE_MS,
      }),
      inspectLocalArchiveAccountingIndex({ indexFile: archiveIndexFile }),
      readLocalArchiveAccountingPeriod({ indexFile: archiveIndexFile }),
      readLocalUnifiedCompanionProjection({
        indexFile: unifiedIndexFile,
        nowMs,
        declaredSpeedBaselines,
      }),
    ]);
  const replaySafeCache = ["available", "stale"].includes(
    replaySafeAccounting.status,
  )
    ? replaySafeAccounting.cache
    : null;
  const unifiedAvailable = unified.status === "available";
  if (typeof allowDevelopmentArtifactFallback !== "boolean") {
    throw new TypeError("allowDevelopmentArtifactFallback must be a boolean");
  }
  const [gradient, quality, collector, reports] = await Promise.all([
    projectArtifact(root, "gradient"),
    projectArtifact(root, "quality"),
    readCollectorProjection(collectorStateFile, nowMs, {
      // The unified index replaces the collector-row usage replay entirely;
      // re-summarizing 600k+ JSON rows here was the old startup cost, and the
      // raw collector projection also counts fork replay the owner has ruled
      // is not real spend.
      summarizeUsageEvents: replaySafeCache === null && !unifiedAvailable,
      declaredSpeedBaselines,
    }),
    reportProjection(root),
  ]);
  const allowanceWeekly = projectSelectedAllowanceWeeklyCalibration(
    replaySafeCache,
    selectedFastModePreference,
    replaySafeAccounting.errorCode,
  );
  const allowanceCapacity = projectAllowanceCapacity(
    replaySafeCache?.allowanceCapacityByScenario,
    selectedFastModePreference,
  );
  // Retained report artifacts are Standard-priced. They remain available as
  // diagnostic reports, but cannot stand in for a quota-weighted allowance
  // capacity when the matching live scenario is unavailable.
  const weeklyBase = allowanceWeekly;
  // The historical calibration and this current-reset forecast deliberately
  // have different evidence contracts. The latter is account-scoped app-server
  // evidence only, and remains optional even when an older calibration view is
  // available.
  const weekly = {
    ...weeklyBase,
    paceForecast: collector.paceForecast,
  };
  const latestRecordAt = collector.latestRecordAt;
  const indexing = await readCollectorIndexProjection(collectorStateFile, collector);
  const latestEvidenceAt = latestRecordAt === null ? null : new Date(latestRecordAt).toISOString();
  const evidenceAgeSeconds = latestRecordAt === null ? null : Math.max(0, Math.round((nowMs - latestRecordAt) / 1_000));
  const collectorFreshnessStatus = evidenceAgeSeconds === null
    ? "unavailable"
    : evidenceAgeSeconds * 1_000 <= MAX_COLLECTOR_LIVE_AGE_MS ? "live" : "stale";
  // `freshness.status` describes the observations, and nothing else.
  //
  // A stale replay-safe accounting cache used to override it outright, so a
  // dashboard whose newest observation was seconds old still reported that
  // "the latest collector observation is older than its freshness threshold".
  // That sentence was simply untrue, and it is why refreshing appeared to
  // change nothing: refreshing collects observations, and the observations
  // were never what was stale. The two facts are reported separately -
  // `accountingStatus` below carries the cache's own verdict, and the warning
  // list names the withheld pricing - so conflating them buys nothing and
  // costs the reader a true statement.
  const freshnessStatus = collectorFreshnessStatus;
  // The cache reader's "stale" verdict is wall-clock age alone:
  // now - coveredAt.endAt > MAX_REPLAY_SAFE_CACHE_AGE_MS. But coveredAt.endAt
  // is stamped only when the cache is REBUILT, and the foreground refresh
  // deliberately reuses the cache untouched whenever a pass writes no new
  // rollout usage records (local-companion-refresh.js). An idle stretch —
  // quota observations arriving, no token usage — therefore ages the cache
  // past the threshold while the newest observation stays seconds-fresh, and
  // the "stale" verdict indicts totals that in fact cover every known usage
  // record. Wall clock is the wrong comparator. The honest question is
  // whether exportable evidence exists beyond the cache's coverage end, the
  // same comparison the unified-index lag warning below already makes, so the
  // verdict is re-derived against that clock here and "stale" survives only
  // when newer evidence genuinely outruns the coverage end.
  const accountingCoverageEndMs = replaySafeCache === null
    ? Number.NaN
    : Date.parse(replaySafeCache.coveredAt.endAt);
  const accountingCoversKnownEvidence = Number.isFinite(accountingCoverageEndMs)
    && (collector.latestExportableRecordAt === null
      || collector.latestExportableRecordAt - accountingCoverageEndMs
        <= MAX_REPLAY_SAFE_CACHE_AGE_MS);
  const accountingStatus =
    replaySafeAccounting.status === "stale" && accountingCoversKnownEvidence
      ? "available"
      : replaySafeAccounting.status;
  // Recent periods prefer the freshly refreshed replay-safe cache, then the
  // unified index (also replay-suppressed), and fall back to the raw collector
  // projection — which counts fork replay — only when neither exists.
  const recentUsage = replaySafeCache?.periods
    ?? (unifiedAvailable ? unified.usage : collector.usage);
  // The unified index owns the broadest period whenever it is present: its
  // "all" spans the whole suppressed corpus rather than a bounded recent
  // window, which is what removes the 31-day ceiling.
  const broadUsage = unifiedAvailable
    ? [
      ...recentUsage.filter((period) => period.id !== "all"),
      unified.usage.find((period) => period.id === "all"),
    ]
    : recentUsage;
  const usage = archiveAccounting.status === "available"
    ? [
      ...broadUsage.filter((period) => period.id !== "history"),
      archiveAccounting.period,
    ]
    : broadUsage;
  const displayUsage = usage.find((period) => period.id === "7d" && period.events > 0)
    ?? usage.find((period) => period.id === "all");
  const fastModeInference = inferFastModeFromCalibrationWindows(
    fastModeCalibrationWindows(replaySafeCache?.weeklyCalibration),
  );
  const fastModeContext = {
    preference: selectedFastModePreference,
    inference: fastModeInference,
    nowMs,
  };
  const periodFastMode = new Map(usage.map((period) => [
    period.id,
    fastModeProjection(period, fastModeContext),
  ]));
  const displayFastMode = displayUsage === undefined
    ? fastModeProjection(undefined, fastModeContext)
    : periodFastMode.get(displayUsage.id);
  const exactUsageTimelineWithSpeed = unifiedAvailable
    ? unified.timeline.usage
    : replaySafeCache?.timeline
      ?? collector.timeline.usage;
  const exactUsageTimeline = quotaWeightedUsageTimeline(
    exactUsageTimelineWithSpeed,
    fastModeContext,
  );
  const quota = collector.quota;
  const quotaTimeline = unifiedAvailable
    ? unified.timeline.quota
    : Array.isArray(replaySafeCache?.quotaTimeline)
      ? replaySafeCache.quotaTimeline
      : collector.timeline.quota;
  const sparkQuotaTimeline = unifiedAvailable
    ? unified.timeline.sparkQuota
    : Array.isArray(replaySafeCache?.sparkQuotaTimeline)
      ? replaySafeCache.sparkQuotaTimeline
      : collector.timeline.sparkQuota;
  const sparkUsageTimeline = unifiedAvailable
    ? unified.timeline.sparkUsage
    : Array.isArray(replaySafeCache?.sparkUsageTimeline)
      ? replaySafeCache.sparkUsageTimeline
      : collector.timeline.sparkUsage;
  // What span the timelines honestly cover, and out of which source. When the
  // unified index is absent this names the bound instead of hiding it.
  const timelineSource = unifiedAvailable
    ? "unified_local_index"
    : replaySafeCache !== null
      ? "replay_safe_cache"
      : "recent_collector_window";
  const timelineHistory = unifiedAvailable
    ? {
      status: unified.indexStatus === "complete" ? "complete" : "partial",
      coveredAt: unified.coveredAt,
      usageEvents: unified.usageEvents,
      generatedAt: unified.generatedAt,
      sourceCount: unified.sourceCount,
      indexBytes: unified.indexBytes,
    }
    : {
      status: "unavailable",
      reason: unified.status === "missing"
        ? "unified_index_missing"
        : unified.errorCode ?? "unified_index_unavailable",
      boundedDays: RECENT_TIMELINE_DAYS,
      coveredAt: null,
    };
  const tools = collector.tools;
  const pricedEvents = (displayUsage?.pricingCoverage.fullyPricedEvents ?? 0)
    + (displayUsage?.pricingCoverage.partiallyPricedEvents ?? 0);
  const pricingCoveragePercent = (displayUsage?.events ?? 0) === 0
    ? null
    : Number(((pricedEvents / displayUsage.events) * 100).toFixed(3));
  const warnings = [];
  if (collectorFreshnessStatus === "stale") {
    warnings.push("The newest retained collector evidence is stale.");
  }
  // The "Replay-safe cost accounting is N minutes old and is shown as stale
  // until refreshed" banner is gone (owner-directed, 2026-08-10). Trace: it
  // fired on wall-clock cache age, but coveredAt.endAt only advances on a
  // rebuild and the refresh loop intentionally reuses the cache when a pass
  // adds no rollout usage — so the banner condemned figures that still
  // covered every known usage record while the dashboard's own observation
  // read seconds-fresh. The verdict is now derived against the newest
  // exportable evidence (`accountingStatus` above) and stays published as
  // machine-readable status fields; no sentence returns here.
  if (replaySafeAccounting.errorCode === "cache_price_registry_outdated") {
    warnings.push(
      "Official API prices changed. Cached price estimates are withheld until the next local replay rebuilds them with the current registry.",
    );
  }
  if (replaySafeAccounting.errorCode === "cache_accounting_semantics_outdated") {
    warnings.push(
      "Historical event-time accounting changed. The prior cache is withheld until the next local replay rebuilds it.",
    );
  }
  if (replaySafeCache === null && !unifiedAvailable
      && (displayUsage?.events ?? 0) > 0) {
    warnings.push(
      "Recent cost accounting is using the live collector projection. It may include inherited snapshots from forked child rollouts until the replay-safe cache is refreshed.",
    );
  }
  if (!unifiedAvailable) {
    warnings.push(unified.status === "missing"
      ? `The unified local index has not been built yet. Usage history and the broadest period are bounded to the recent ${RECENT_TIMELINE_DAYS}-day collector window until it is.`
      : `The unified local index is unreadable. Usage history and the broadest period are bounded to the recent ${RECENT_TIMELINE_DAYS}-day collector window until it recovers.`);
  } else {
    const indexEndMs = Date.parse(unified.coveredAt.endAt ?? "");
    const newestUsageMs = collector.latestExportableRecordAt;
    if (Number.isFinite(indexEndMs)
        && Number.isSafeInteger(newestUsageMs)
        && newestUsageMs - indexEndMs > MAX_COLLECTOR_LIVE_AGE_MS) {
      warnings.push(
        `The unified local index is ${Math.round((newestUsageMs - indexEndMs) / 60_000)} minutes behind the newest collector evidence and catches up on the next refresh.`,
      );
    }
  }
  if (indexing.status === "prospective_only") {
    warnings.push("The retained collector state began prospectively and does not prove recent-history coverage.");
  }
  const displayUnknownModelEvents = displayUsage?.byModel
    ?.find((row) => row.model === "unknown")?.events ?? 0;
  const displayKnownUnpricedModelEvents = displayUsage?.byModel
    ?.filter((row) => row.pricingStatus === "known_unpriced")
    .reduce((total, row) => total + row.events, 0) ?? 0;
  if (displayUnknownModelEvents > 0) {
    warnings.push("Some usage events name an unrecognized model and remain unpriced rather than being assigned a guessed price.");
  }
  const thirtyDayUsage = usage.find((period) => period.id === "30d");
  if (OPENAI_PRICE_EVIDENCE_START_DATE !== null
      && (thirtyDayUsage?.pricingCoverage.unpricedEvents ?? 0)
        > displayUnknownModelEvents + displayKnownUnpricedModelEvents
      && new Date(nowMs - (30 * 24 * 60 * 60 * 1_000))
        .toISOString().slice(0, 10) < OPENAI_PRICE_EVIDENCE_START_DATE) {
    warnings.push(
      `Verified OpenAI price evidence was reviewed beginning ${OPENAI_PRICE_EVIDENCE_START_DATE}; events without a recognized or separately evidenced card remain unpriced.`,
    );
  }
  if (archiveCoverage.status !== "complete") {
    warnings.push(archiveAccounting.status === "available"
      ? `Indexed-history totals currently cover ${archiveCoverage.indexedSourceCount}/${archiveCoverage.sourceCount} discovered sources and expand as later foreground refreshes advance the index.`
      : "History indexing is still advancing. Complete historical totals stay hidden until an indexed aggregate is available.");
  } else if (archiveAccounting.status !== "available") {
    warnings.push(
      "Historical sources are indexed, but their aggregate is temporarily unavailable and is not substituted with a recent-window total.",
    );
  }
  // Headline provenance must describe the same period as the numeric headline,
  // not a separately selected set of weekly calibration fits. This is also the
  // only safe source while an old replay cache is withheld and the collector
  // temporarily provides the event-time projection.
  const priceCardIds = Array.isArray(displayUsage?.priceCardIds)
    ? displayUsage.priceCardIds
    : [];
  const priceCardBreakdown = Array.isArray(displayUsage?.priceCardBreakdown)
    ? displayUsage.priceCardBreakdown
    : [];
  const mixedPriceCardWindows = priceCardIds.length > 1;
  return {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: new Date(nowMs).toISOString(),
    overview: {
      status: freshnessStatus,
      evidenceStatus: collector.recordCount > 0 ? "available" : "unavailable",
      latestEvidenceAt,
      latestObservedAt: latestEvidenceAt,
        freshness: {
          status: freshnessStatus,
          latestObservedAt: latestEvidenceAt,
          ageSeconds: evidenceAgeSeconds,
          staleAfterSeconds: MAX_COLLECTOR_LIVE_AGE_MS / 1_000,
          accountingStatus,
          accountingAgeSeconds: replaySafeAccounting.ageSeconds ?? null,
        },
      collector: {
        status: collector.status,
        records: collector.recordCount,
        recordCounts: collector.recordCounts,
        malformedLines: collector.malformedLines,
        lastScanAt: latestEvidenceAt,
        safeRecordCount: collector.recordCount,
        identityMode: "prospective_pseudonymous_not_exposed",
        sourceMode: "content_free_collector_state",
        indexingState: indexing.status,
        indexing,
        coveredAt: {
          startAt: collector.firstRecordAt === null
            ? null
            : new Date(collector.firstRecordAt).toISOString(),
          endAt: latestEvidenceAt,
        },
        exportableCoveredAt: {
          startAt: collector.firstExportableRecordAt === null
            ? null
            : new Date(collector.firstExportableRecordAt).toISOString(),
          endAt: collector.latestExportableRecordAt === null
            ? null
            : new Date(collector.latestExportableRecordAt).toISOString(),
        },
      },
      quota,
      quotaWindows: quota.windows.map((window) => ({
        ...window,
        observedAt: quota.observedAt,
        status: freshnessStatus,
      })),
      usage,
      tools,
      timeline: {
        ...collector.timeline,
        bucketMinutes: unifiedAvailable
          ? unified.timeline.bucketMinutes
          : replaySafeCache?.bucketMinutes
            ?? collector.timeline.bucketMinutes,
        coveredAt: unifiedAvailable
          ? unified.timeline.coveredAt
          : replaySafeCache?.coveredAt
            ?? collector.timeline.coveredAt,
        allowanceWeightingEncoding: timelineAllowanceWeightingEncoding(
          selectedFastModePreference,
        ),
        usage: exactUsageTimeline,
        allowanceCapacity,
        quota: quotaTimeline,
        sparkUsage: sparkUsageTimeline,
        sparkQuota: sparkQuotaTimeline,
        source: timelineSource,
        history: timelineHistory,
      },
      accounting: {
        periodId: displayUsage?.id ?? "all",
        periodLabel: displayUsage?.label ?? RECENT_COLLECTOR_PERIOD_LABEL,
        events: displayUsage?.events ?? 0,
        totalTokens: displayUsage?.totalTokens ?? 0,
        apiPriceEquivalentUsd: displayUsage?.apiPriceEquivalentUsd ?? 0,
        apiPriceEquivalentUsdExact: displayUsage?.apiPriceEquivalentUsdExact ?? null,
        spark: displayUsage?.spark ?? null,
        quotaWeightedApiPriceEquivalentUsd:
          displayFastMode.quotaWeightedApiPriceEquivalentUsd,
        fastMode: displayFastMode,
        speedWeighting: safeSpeedWeighting(displayUsage?.speedWeighting),
        components: displayUsage?.components ?? emptyComponents(),
        componentCosts: displayUsage?.componentCosts ?? {},
        byModel: displayUsage?.byModel ?? [],
        // Every model identity across both allowance tracks, each row stating
        // its own track and whether an API-price equivalent means anything
        // for it. This is what a model-usage table should render.
        modelUsage: displayUsage?.modelUsage ?? displayUsage?.byModel ?? [],
        bySpeed: displayUsage?.bySpeed ?? emptyDimension(KNOWN_SPEEDS),
        byApiServiceTier: displayUsage?.byApiServiceTier ?? emptyDimension(KNOWN_API_TIERS),
        bySurface: displayUsage?.bySurface ?? emptyDimension(KNOWN_SURFACES),
        byAgentScope: displayUsage?.byAgentScope ?? emptyDimension(KNOWN_AGENT_SCOPES),
        byLineage: displayUsage?.byLineage ?? emptyDimension(KNOWN_LINEAGE),
        byReasoningEffort: displayUsage?.byReasoningEffort ?? {
          unknown: { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
        },
        accountAttribution: displayUsage?.accountAttribution ?? {
          attributedPseudonymousEvents: 0,
          unattributedEvents: 0,
        },
        toolClasses: tools,
        apiPriceCounterfactualTier: "standard",
        subscriptionSpeedIsSeparate: true,
        reasoningEffortAvailable: false,
        accountingSource: replaySafeCache !== null
          ? replaySafeCache.accountingMethod
          : unifiedAvailable
            ? "unified_local_index_replay_suppressed"
            : "collector_projection_unverified",
        accountingCacheStatus: accountingStatus,
        replayExclusionDiagnostics: replaySafeCache?.diagnostics ?? null,
        evidenceStartDate: OPENAI_PRICE_EVIDENCE_START_DATE,
        historyCoverage: archiveCoverage,
        historyPeriodStatus: archiveAccounting.status,
        historyGeneratedAt: archiveAccounting.generatedAt ?? null,
        historyCoveredAt: archiveAccounting.coveredAt ?? null,
        generatedAt: replaySafeCache?.generatedAt ?? null,
        coveredAt: replaySafeCache?.coveredAt ?? null,
        unknownModelEvents: displayUsage?.byModel
          ?.find((row) => row.model === "unknown")?.events ?? 0,
        periods: usage.map((period) => ({
          periodId: period.id,
          periodLabel: period.label,
          events: period.events,
          totalTokens: period.totalTokens,
          apiPriceEquivalentUsd: period.apiPriceEquivalentUsd,
          priceCardIds: period.priceCardIds ?? [],
          priceCardBreakdown: period.priceCardBreakdown ?? [],
          quotaWeightedApiPriceEquivalentUsd:
            periodFastMode.get(period.id)
              ?.quotaWeightedApiPriceEquivalentUsd ?? null,
          fastMode: periodFastMode.get(period.id) ?? displayFastMode,
          speedWeighting: safeSpeedWeighting(period.speedWeighting),
          pricingCoverage: period.pricingCoverage,
          components: period.components,
          spark: period.spark ?? null,
          componentCosts: period.componentCosts ?? {},
          byModel: period.byModel,
          modelUsage: period.modelUsage ?? period.byModel,
          bySpeed: period.bySpeed,
          byApiServiceTier: period.byApiServiceTier,
          bySurface: period.bySurface,
          byAgentScope: period.byAgentScope,
          byLineage: period.byLineage,
          byReasoningEffort: period.byReasoningEffort,
          accountAttribution: period.accountAttribution,
          evidenceStartDate: OPENAI_PRICE_EVIDENCE_START_DATE,
        })),
      },
      activity: {
        safeRecordCount: collector.recordCount,
        usageEvents: displayUsage?.events ?? 0,
        toolEvents: tools.total,
        lastScanAt: latestEvidenceAt,
      },
      pricing: {
        basis: "official_api_price_equivalent_not_subscription_allowance",
        totalCostUsd: displayUsage?.apiPriceEquivalentUsd ?? 0,
        spark: displayUsage?.spark ?? null,
        // The headline figure once the published Fast credit rate has been
        // applied to events whose effective mode is Fast. Null when no
        // legitimate weighting is available for any of the recorded cost.
        quotaWeightedTotalCostUsd:
          displayFastMode.quotaWeightedApiPriceEquivalentUsd,
        quotaWeightedMetricLabel: displayFastMode.metricLabel,
        quotaWeightedMetricExplainer: displayFastMode.metricExplainer,
        fastMode: displayFastMode,
        periodLabel: displayUsage?.label ?? RECENT_COLLECTOR_PERIOD_LABEL,
        coveragePercent: pricingCoveragePercent,
        eventCount: displayUsage?.events ?? 0,
        pricingCoverage: displayUsage?.pricingCoverage ?? {
          fullyPricedEvents: 0,
          partiallyPricedEvents: 0,
          unpricedEvents: 0,
        },
        apiTier: "standard",
        eventTimeHistoricalTotalUsdExact: displayUsage?.apiPriceEquivalentUsdExact ?? null,
        currentPriceSensitivityTotalUsdExact: null,
        components: Object.entries(
          displayUsage?.componentCosts ?? displayUsage?.components ?? emptyComponents(),
        ).map(([name, value]) => ({
          name,
          tokens: typeof value === "object"
            ? value.tokens ?? 0
            : value,
          pricedTokens: typeof value === "object"
            ? value.pricedTokens ?? 0
            : 0,
          unpricedTokens: typeof value === "object"
            ? value.unpricedTokens ?? 0
            : 0,
          costUsd: typeof value === "object"
            ? value.costUsd ?? null
            : null,
        })),
        apiServiceTier: "standard",
        subscriptionSpeedIsSeparate: true,
        registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
        registryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
        evidenceStartDate: OPENAI_PRICE_EVIDENCE_START_DATE,
        priceCardIds,
        priceCardBreakdown,
        mixedPriceCardWindows,
        // Every retained event is resolved against the official card effective
        // at that event's timestamp; a reset may therefore contain mixed
        // historical card windows.
        priceEpochBasis: "event_time_when_registry_has_effective_evidence",
        accountingSource: replaySafeCache !== null
          ? replaySafeCache.accountingMethod
          : unifiedAvailable
            ? "unified_local_index_replay_suppressed"
            : "collector_projection_unverified",
        accountingCacheStatus: accountingStatus,
        replayExclusionDiagnostics: replaySafeCache?.diagnostics ?? null,
        historyCoverage: archiveCoverage,
        historyPeriodStatus: archiveAccounting.status,
      },
      coverage: {
        overallPercent: pricingCoveragePercent,
        history: archiveCoverage,
      },
      warnings,
      monitoringGaps: [
        {
          id: "quota_snapshots",
          title: "Quota snapshots",
          status: quota.windows.length > 0 ? "observed" : "missing",
          explanation: quota.windows.length > 0
            ? "Current provider quota windows are present in the local collector."
            : "No current quota window is available.",
        },
        {
          id: "account_attribution",
          title: "Account attribution",
          status: quota.accountAttribution === "attributed_pseudonymous"
            ? "partial"
            : "unattributed",
          explanation: quota.accountAttribution === "attributed_pseudonymous"
            ? "The latest quota observation is tied to a local pseudonymous account scope; most usage may still be unattributed."
            : "The latest observation cannot be tied safely to one local account scope.",
        },
        {
          id: "fast_mode",
          title: "Fast-mode accounting",
          status: fastModeGapStatus(displayFastMode.coverage),
          explanation: "Codex records the speed mode only when it is applied or changed, never at session start, so turns before the first change in a session carry no recorded tier. Observed tiers always win; the remainder is attributed from the owner's stated mode, then a secondary window-level inference, and anything left stays explicitly unknown.",
        },
        {
          id: "subagents",
          title: "Subagents and child rollouts",
          status: (displayUsage?.byAgentScope?.subagent?.events ?? 0) > 0
            ? "observed"
            : "not_observed",
          explanation: replaySafeCache === null
            ? "Child-rollout attribution is provisional until lineage-aware replay exclusion has been refreshed."
            : "Inherited parent snapshots are excluded before genuine child-rollout increments are attributed.",
        },
        {
          id: "shared_pool_surfaces",
          title: "Work, Workspace Agents, Excel and connected Voice",
          status: "unsupported_or_partial",
          explanation: "These shared-pool surfaces may not write complete local Codex evidence and can explain quota movement not matched locally.",
        },
        {
          id: "third_party_auth",
          title: "Third-party ChatGPT-authenticated apps",
          status: "unsupported",
          explanation: "No complete local accounting source is available for third-party apps using ChatGPT authentication.",
        },
        {
          id: "reasoning_effort",
          title: "Reasoning effort",
          status: "unavailable",
          explanation: "Current retained usage snapshots do not expose a reasoning-effort field.",
        },
        {
          id: "api_service_tier",
          title: "API service tier",
          status: (displayUsage?.byApiServiceTier?.unknown?.events ?? 0) > 0
            ? "mostly_unknown"
            : "observed",
          explanation: "Subscription speed is observed separately; API standard, priority and flex are not inferred from it.",
        },
        {
          id: "provider_accounting_changes",
          title: "Provider resets and accounting changes",
          status: "uncertain",
          explanation: "Provider-side quota resets, propagation delays and unannounced accounting changes can alter observed allowance movement without a matching local usage event.",
        },
        {
          id: "unknown_token_components",
          title: "Unknown or combined token components",
          status: (displayUsage?.components?.output_combined_tokens ?? 0) > 0
            ? "observed_combined"
            : "not_observed",
          explanation: "Some retained events expose only a combined output count. Text and reasoning output are not invented when the provider does not separate them.",
        },
        {
          id: "calculation_disagreement",
          title: "Calculated usage versus observed quota",
          status: (gradient.datasets?.rollingResidual?.length ?? 0) > 0
            ? "review_available"
            : "insufficient_evidence",
          explanation: "Periods with material residuals remain visible in calibration evidence and may reflect missing surfaces, uncertain prices, reset contamination or provider-side accounting.",
        },
        {
          id: "ordinary_chat",
          title: "Ordinary Chat conversations",
          status: "excluded",
          explanation: "Ordinary Chat is excluded from the shared agentic pool unless new provider evidence shows otherwise.",
        },
      ],
      artifactStatus: {
        gradient: {
          status: gradient.status,
          generatedAt: gradient.generatedAt,
          dataClass: "historical_local_artifact",
        },
        weekly: {
          status: weekly.status,
          generatedAt: weekly.generatedAt,
          dataClass: weekly.dataClass,
        },
        quality: {
          status: quality.status,
          generatedAt: quality.generatedAt,
          dataClass: "historical_local_artifact",
        },
      },
      privacy: {
        rawLogsSentToBrowser: false,
        responseContract: "closed_content_free_projection",
        accountIdentifiersIncluded: false,
        localPathsIncluded: false,
      },
    },
    gradient,
    weekly,
    quality,
    reports,
  };
}

export class LocalCompanionDataStore {
  #builder;
  #snapshot = null;

  constructor({ builder = buildLocalCompanionSnapshot } = {}) {
    if (typeof builder !== "function") throw new TypeError("builder must be a function");
    this.#builder = builder;
  }

  async initialize() {
    if (this.#snapshot === null) await this.reload();
    return this.getOverview();
  }

  async reload() {
    const candidate = await this.#builder();
    if (!candidate || candidate.schemaVersion !== LOCAL_COMPANION_SCHEMA_VERSION) {
      throw fixedError("snapshot_invalid");
    }
    this.#snapshot = structuredClone(candidate);
    return this.getOverview();
  }

  #required() {
    if (this.#snapshot === null) throw fixedError("snapshot_unavailable");
    return this.#snapshot;
  }

  getOverview() {
    const snapshot = this.#required();
    return {
      schemaVersion: snapshot.schemaVersion,
      mode: snapshot.mode,
      generatedAt: snapshot.generatedAt,
      ...structuredClone(snapshot.overview),
    };
  }

  getGradient() {
    return structuredClone(this.#required().gradient);
  }

  getWeekly() {
    return structuredClone(this.#required().weekly);
  }

  getQuality() {
    return structuredClone(this.#required().quality);
  }

  getReports() {
    return {
      schemaVersion: this.#required().schemaVersion,
      reports: structuredClone(this.#required().reports),
    };
  }
}

export const LOCAL_COMPANION_REPORTS = REPORTS.map(({ file: _file, ...report }) => Object.freeze(report));
export const LOCAL_COMPANION_REPORT_FILES = Object.freeze(
  Object.fromEntries(REPORTS.map((report) => [report.href, report.file])),
);
