import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  APP_PRICE_REGISTRY_MANIFEST,
  CODEX_SPEED_MODE_DECLARATION,
  CODEX_SPEED_MODE_OBSERVABILITY,
  DEFAULT_FAST_MODE_PREFERENCE,
  FAST_MODE_MODEL_FAMILY_KEYS,
  FAST_MODE_MULTIPLIER_SOURCE,
  FAST_MODE_QUOTA_MULTIPLIERS,
  OBSERVED_SPEED_MODE_KEYS,
  QUOTA_WEIGHTED_API_PRICE_METRIC,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  inferFastModeFromCalibrationWindows,
  isFastModePreference,
  priceCodexUsageEvent,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  defaultReplaySafeAccountingCachePath,
  readReplaySafeAccountingCache,
} from "./replay-safe-accounting-cache.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
} from "./reporting/index.js";
import { writeJsonOwnerOnlyAtomic } from "./storage.js";

export const LOCAL_COMPANION_SCHEMA_VERSION = "local-companion-v0.1";

const MAX_LEDGER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LEDGER_LINE_BYTES = 1024 * 1024;
const MAX_LEDGER_RECORDS = 5_000_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_DATASET_ROWS = 2_500;
const MAX_SAFE_TEXT_LENGTH = 2_000;

const COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);

const KNOWN_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-4.1",
]);

const KNOWN_SPEEDS = new Set(["standard", "fast", "flex", "batch", "unknown"]);
const KNOWN_API_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown"]);
const KNOWN_SURFACES = new Set([
  "extension_or_ide",
  "scheduled_task",
  "subagent",
  "cli_exec",
  "work",
  "workspace_agent",
  "excel",
  "voice_task",
  "unknown",
]);
const KNOWN_AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const KNOWN_LINEAGE = new Set(["standalone", "forked", "parent_linked", "unknown"]);
const KNOWN_TOOL_CLASSES = new Set(["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]);
const KNOWN_LIMITS = new Set(["codex", "codex_bengalfox"]);
const KNOWN_PLANS = new Set(["free", "plus", "pro", "team", "business", "enterprise", "unknown"]);
const KNOWN_SLOTS = new Set(["primary", "secondary"]);
const RECENT_TIMELINE_DAYS = 31;
const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
const MAX_QUOTA_TIMELINE_POINTS = 10_000;
const MAX_REPLAY_SAFE_CACHE_AGE_MS = 30 * 60 * 1_000;
const MAX_COLLECTOR_LIVE_AGE_MS = MAX_REPLAY_SAFE_CACHE_AGE_MS;
const COLLECTOR_PROJECTION_SCHEMA_VERSION =
  "collector-dashboard-projection-v1";
const MAX_COLLECTOR_PROJECTION_BYTES = 16 * 1024 * 1024;

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

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function deterministicSample(rows, maximum = MAX_DATASET_ROWS) {
  if (rows.length <= maximum) return rows;
  const sampled = [];
  const last = rows.length - 1;
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(rows[Math.round((index * last) / (maximum - 1))]);
  }
  return sampled;
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
    metadata = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw fixedError("artifact_missing");
    throw fixedError("artifact_unavailable");
  }
  if (!metadata.isFile() || metadata.size > maximumBytes) throw fixedError("artifact_invalid_size");
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
    const artifact = await readBoundedJson(resolve(root, specification.file), MAX_ARTIFACT_BYTES);
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
      )) {
    return false;
  }
  return true;
}

function validSpeedEventCounts(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && ["standard", "fast", "unknown"].every((key) => (
      Number.isSafeInteger(value[key]) && value[key] >= 0
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
      })),
    },
  };
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

function addComponents(target, components) {
  if (!components || typeof components !== "object" || Array.isArray(components)) return;
  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

function safeModel(model) {
  return KNOWN_MODELS.has(model) ? model : "unknown";
}

function safeSpeed(speed) {
  return KNOWN_SPEEDS.has(speed) ? speed : "unknown";
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

function usageProjection(record, declaredSpeed = "unknown") {
  const components = emptyComponents();
  addComponents(components, record.components);
  if (components.output_combined_tokens > 0
      && components.output_text_tokens + components.output_reasoning_tokens > 0) {
    components.output_combined_tokens = 0;
  }
  const totalTokens = components.input_uncached_tokens
    + components.input_cache_read_tokens
    + components.input_cache_write_tokens
    + (components.output_combined_tokens > 0
      ? components.output_combined_tokens
      : components.output_text_tokens + components.output_reasoning_tokens);
  if (totalTokens === 0) return null;
  const model = safeModel(record.model);
  let priced;
  try {
    priced = priceCodexUsageEvent({
      timestamp: record.observedAt,
      model,
      components,
    }, {
      // Subscription speed and the API billing tier are separate concepts.
      // Standard is the explicit counterfactual until an API tier is observed.
      apiServiceTier: "standard",
      priceEpochBasis: "current_price_sensitivity",
    });
  } catch {
    priced = { totalUsd: "0", coverageStatus: "unpriced" };
  }
  const rawCost = Number(priced.totalUsd);
  return {
    model,
    components,
    totalTokens,
    apiPriceEquivalentUsd: Number.isFinite(rawCost) ? rawCost : 0,
    pricingCoverageStatus: ["fully_priced", "partially_priced"].includes(priced.coverageStatus)
      ? priced.coverageStatus
      : "unpriced",
    speed: safeSpeed(record.tierSemantics?.codexSpeedMode),
    declaredSpeed,
    apiServiceTier: safeEnum(record.tierSemantics?.apiServiceTier, KNOWN_API_TIERS),
    surface: safeEnum(record.surfaceClassification?.surface, KNOWN_SURFACES),
    agentScope: safeEnum(record.surfaceClassification?.agentScope, KNOWN_AGENT_SCOPES),
    lineage: safeEnum(record.surfaceClassification?.lineageDisposition, KNOWN_LINEAGE),
    reasoningEffort: "unknown",
    accountAttribution: record.accountScope?.status === "available"
      ? "attributed_pseudonymous"
      : "unattributed",
  };
}

function newUsagePeriod(id, label) {
  return {
    id,
    label,
    events: 0,
    totalTokens: 0,
    components: emptyComponents(),
    apiPriceEquivalentUsd: 0,
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    byModel: {},
    bySpeed: emptyDimension(KNOWN_SPEEDS),
    byApiServiceTier: emptyDimension(KNOWN_API_TIERS),
    bySurface: emptyDimension(KNOWN_SURFACES),
    byAgentScope: emptyDimension(KNOWN_AGENT_SCOPES),
    byLineage: emptyDimension(KNOWN_LINEAGE),
    byReasoningEffort: {
      unknown: { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
    },
    // Observed speed mode crossed with the model's published Fast credit rate
    // family, so the owner's Fast-mode preference can be applied at read time.
    speedWeighting: emptySpeedWeightingCrossing(),
    // The same crossing, holding only the events the log left UNOBSERVED that
    // a timestamped Codex `service_tier` reading actually covers.
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
    accountAttribution: {
      attributedPseudonymousEvents: 0,
      unattributedEvents: 0,
    },
  };
}

function addSpeedWeighting(crossing, projection) {
  const speed = crossing[projection.speed] ? projection.speed : "unknown";
  const cell = crossing[speed][fastModeModelFamilyKey(projection.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

function addDeclaredSpeedWeighting(crossing, projection) {
  // Only a declaration that resolved to a real mode is recorded, and only for
  // events the log left unobserved; everything else is left unattributed.
  if (projection.declaredSpeed !== "standard"
      && projection.declaredSpeed !== "fast") return;
  const cell =
    crossing[projection.declaredSpeed][fastModeModelFamilyKey(projection.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

function finalizeSpeedWeighting(crossing) {
  return Object.fromEntries(Object.entries(crossing).map(([speed, families]) => [
    speed,
    Object.fromEntries(Object.entries(families).map(([family, cell]) => [
      family,
      {
        ...cell,
        apiPriceEquivalentUsd: Number(cell.apiPriceEquivalentUsd.toFixed(6)),
      },
    ])),
  ]));
}

function safeSpeedWeighting(value) {
  const crossing = emptySpeedWeightingCrossing();
  for (const speed of OBSERVED_SPEED_MODE_KEYS) {
    for (const family of FAST_MODE_MODEL_FAMILY_KEYS) {
      const cell = value?.[speed]?.[family];
      crossing[speed][family] = {
        events: Number.isSafeInteger(cell?.events) && cell.events >= 0
          ? cell.events
          : 0,
        apiPriceEquivalentUsd:
          finiteNumber(cell?.apiPriceEquivalentUsd) !== null
            && cell.apiPriceEquivalentUsd >= 0
            ? cell.apiPriceEquivalentUsd
            : 0,
      };
    }
  }
  return crossing;
}

function addDimension(dimension, key, projection) {
  const row = dimension[key] ?? dimension.unknown;
  row.events += 1;
  row.totalTokens += projection.totalTokens;
  row.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

function addUsageToPeriod(period, projection) {
  if (projection === null) return;
  period.events += 1;
  period.totalTokens += projection.totalTokens;
  addComponents(period.components, projection.components);
  const modelSummary = period.byModel[projection.model] ??= {
    model: projection.model,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
  };
  modelSummary.events += 1;
  modelSummary.totalTokens += projection.totalTokens;
  modelSummary.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  period.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  addDimension(period.bySpeed, projection.speed, projection);
  addSpeedWeighting(period.speedWeighting, projection);
  addDeclaredSpeedWeighting(period.declaredSpeedWeighting, projection);
  addDimension(period.byApiServiceTier, projection.apiServiceTier, projection);
  addDimension(period.bySurface, projection.surface, projection);
  addDimension(period.byAgentScope, projection.agentScope, projection);
  addDimension(period.byLineage, projection.lineage, projection);
  addDimension(period.byReasoningEffort, projection.reasoningEffort, projection);
  if (projection.accountAttribution === "attributed_pseudonymous") {
    period.accountAttribution.attributedPseudonymousEvents += 1;
  } else {
    period.accountAttribution.unattributedEvents += 1;
  }
  if (projection.pricingCoverageStatus === "fully_priced") {
    period.pricingCoverage.fullyPricedEvents += 1;
  } else if (projection.pricingCoverageStatus === "partially_priced") {
    period.pricingCoverage.partiallyPricedEvents += 1;
  }
  else period.pricingCoverage.unpricedEvents += 1;
}

function finalizeDimension(dimension) {
  return Object.fromEntries(Object.entries(dimension).map(([key, row]) => [
    key,
    {
      ...row,
      apiPriceEquivalentUsd: Number(row.apiPriceEquivalentUsd.toFixed(6)),
    },
  ]));
}

function finalizeUsagePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents + period.pricingCoverage.partiallyPricedEvents;
  return {
    ...period,
    apiPriceEquivalentUsd: Number(period.apiPriceEquivalentUsd.toFixed(6)),
    pricedEventFraction: period.events === 0 ? null : Number((priced / period.events).toFixed(6)),
    byModel: Object.values(period.byModel)
      .map((row) => ({ ...row, apiPriceEquivalentUsd: Number(row.apiPriceEquivalentUsd.toFixed(6)) }))
      .sort((left, right) => right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd || left.model.localeCompare(right.model)),
    bySpeed: finalizeDimension(period.bySpeed),
    byApiServiceTier: finalizeDimension(period.byApiServiceTier),
    bySurface: finalizeDimension(period.bySurface),
    byAgentScope: finalizeDimension(period.byAgentScope),
    byLineage: finalizeDimension(period.byLineage),
    byReasoningEffort: finalizeDimension(period.byReasoningEffort),
    speedWeighting: finalizeSpeedWeighting(period.speedWeighting),
    declaredSpeedWeighting: finalizeSpeedWeighting(
      period.declaredSpeedWeighting,
    ),
  };
}

function validObservedAt(record) {
  const timestamp = Date.parse(record?.observedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function newTimelineBucket(startMs) {
  return {
    startMs,
    endMs: startMs + TIMELINE_BUCKET_MS,
    usageEvents: 0,
    totalTokens: 0,
    components: emptyComponents(),
    apiPriceEquivalentUsd: 0,
    fullyPricedEvents: 0,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  };
}

function addTimelineUsage(buckets, observedMs, projection) {
  if (projection === null) return;
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? newTimelineBucket(startMs);
  bucket.usageEvents += 1;
  bucket.totalTokens += projection.totalTokens;
  bucket.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  addComponents(bucket.components, projection.components);
  if (projection.pricingCoverageStatus === "fully_priced") bucket.fullyPricedEvents += 1;
  else if (projection.pricingCoverageStatus === "partially_priced") bucket.partiallyPricedEvents += 1;
  else bucket.unpricedEvents += 1;
  buckets.set(startMs, bucket);
}

function finalizeTimelineBuckets(buckets) {
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map((bucket) => ({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.endMs).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      components: bucket.components,
      apiPriceEquivalentUsd: Number(bucket.apiPriceEquivalentUsd.toFixed(6)),
      pricingCoverage: {
        fullyPricedEvents: bucket.fullyPricedEvents,
        partiallyPricedEvents: bucket.partiallyPricedEvents,
        unpricedEvents: bucket.unpricedEvents,
      },
    }));
}

function quotaWindowProjection(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finiteNumber(window.usedPercent);
  const durationMinutes = Number.isSafeInteger(window.windowDurationMins)
    && window.windowDurationMins > 0
    ? window.windowDurationMins
    : null;
  const resetsAtSeconds = Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0
    ? window.resetsAt
    : null;
  return {
    limitId: KNOWN_LIMITS.has(window.limitId) ? window.limitId : "unknown",
    slot: KNOWN_SLOTS.has(window.slot) ? window.slot : "unknown",
    planType: KNOWN_PLANS.has(window.planType) ? window.planType : "unknown",
    usedPercent,
    remainingPercent: usedPercent === null
      ? null
      : Number(Math.max(0, 100 - usedPercent).toFixed(3)),
    durationMinutes,
    resetAt: resetsAtSeconds === null
      ? null
      : new Date(resetsAtSeconds * 1_000).toISOString(),
  };
}

function finalizeQuotaTimeline(rows) {
  rows.sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.limitId.localeCompare(right.limitId)
    || left.slot.localeCompare(right.slot)
  ));
  const latestByTrack = new Map();
  const lastEmittedAtByTrack = new Map();
  const changes = [];
  for (const row of rows) {
    const track = `${row.limitId}:${row.slot}:${row.durationMinutes ?? "unknown"}`;
    const prior = latestByTrack.get(track);
    const changed = prior === undefined
      || prior.usedPercent !== row.usedPercent
      || prior.resetAt !== row.resetAt
      || prior.planType !== row.planType
      || prior.accountAttribution !== row.accountAttribution;
    const observedMs = Date.parse(row.observedAt);
    const elapsedSinceEmission = observedMs - (lastEmittedAtByTrack.get(track)
      ?? Number.NEGATIVE_INFINITY);
    if (changed || elapsedSinceEmission >= TIMELINE_BUCKET_MS) {
      changes.push(row);
      latestByTrack.set(track, row);
      lastEmittedAtByTrack.set(track, observedMs);
    }
  }
  return deterministicSample(changes, MAX_QUOTA_TIMELINE_POINTS);
}

function safeCachedCount(value, maximum = MAX_LEDGER_RECORDS) {
  return Number.isSafeInteger(value)
      && value >= 0
      && value <= maximum
    ? value
    : null;
}

function safeCachedEpoch(value) {
  return value === null
    ? null
    : Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
}

function cachedQuotaRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const observedAt = canonicalIndexInstant(value.observedAt);
  const resetAt = value.resetAt === null
    ? null
    : canonicalIndexInstant(value.resetAt);
  if (observedAt === null
      || (value.resetAt !== null && resetAt === null)
      || !KNOWN_LIMITS.has(value.limitId)
      || !KNOWN_SLOTS.has(value.slot)
      || !KNOWN_PLANS.has(value.planType)
      || (value.accountAttribution !== "unattributed"
        && value.accountAttribution !== "attributed_pseudonymous")
      || (value.usedPercent !== null
        && (typeof value.usedPercent !== "number"
          || !Number.isFinite(value.usedPercent)
          || value.usedPercent < 0
          || value.usedPercent > 100))
      || (value.remainingPercent !== null
        && (typeof value.remainingPercent !== "number"
          || !Number.isFinite(value.remainingPercent)
          || value.remainingPercent < 0
          || value.remainingPercent > 100))
      || (value.durationMinutes !== null
        && (!Number.isSafeInteger(value.durationMinutes)
          || value.durationMinutes < 1))) {
    return null;
  }
  return {
    observedAt,
    limitId: value.limitId,
    slot: value.slot,
    planType: value.planType,
    usedPercent: value.usedPercent,
    remainingPercent: value.remainingPercent,
    durationMinutes: value.durationMinutes,
    resetAt,
    accountAttribution: value.accountAttribution,
  };
}

function cachedCollectorProjection(value, nowMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "available") return null;
  const countNames = [
    "recordCount",
    "malformedLines",
  ];
  const counts = Object.fromEntries(countNames.map((name) => [
    name,
    safeCachedCount(value[name]),
  ]));
  if (Object.values(counts).some((count) => count === null)) return null;
  const epochNames = [
    "firstRecordAt",
    "latestRecordAt",
    "firstExportableRecordAt",
    "latestExportableRecordAt",
  ];
  const epochs = Object.fromEntries(epochNames.map((name) => [
    name,
    safeCachedEpoch(value[name]),
  ]));
  if (Object.values(epochs).some((epoch) => epoch === undefined)) {
    return null;
  }
  const recordCounts = {};
  for (const name of ["usage", "quota", "tools", "other"]) {
    const count = safeCachedCount(value.recordCounts?.[name]);
    if (count === null) return null;
    recordCounts[name] = count;
  }
  if (Object.values(recordCounts).reduce(
    (sum, count) => sum + count,
    0,
  ) !== counts.recordCount) return null;
  const toolCounts = {};
  for (const name of KNOWN_TOOL_CLASSES) {
    const count = safeCachedCount(value.tools?.counts?.[name]);
    if (count === null) return null;
    toolCounts[name] = count;
  }
  const toolTotal = Object.values(toolCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (toolTotal !== safeCachedCount(value.tools?.total)) return null;
  const quotaRows = Array.isArray(value.timeline?.quota)
      && value.timeline.quota.length <= MAX_QUOTA_TIMELINE_POINTS
    ? value.timeline.quota.map(cachedQuotaRow)
    : null;
  if (quotaRows === null || quotaRows.includes(null)) return null;
  const recentStartMs = nowMs
    - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000;
  const quotaWindows = Array.isArray(value.quota?.windows)
      && value.quota.windows.length <= 16
    ? value.quota.windows.map((window) => cachedQuotaRow({
      ...window,
      observedAt: value.quota.observedAt,
      accountAttribution: value.quota.accountAttribution,
    }))
    : null;
  if (quotaWindows === null || quotaWindows.includes(null)) return null;
  return {
    status: "available",
    ...counts,
    ...epochs,
    usage: summarizeUsage([], nowMs),
    quota: {
      status: value.quota.status === "available"
        ? "available"
        : "unavailable",
      observedAt: canonicalIndexInstant(value.quota.observedAt),
      accountAttribution:
        value.quota.accountAttribution === "attributed_pseudonymous"
          ? "attributed_pseudonymous"
          : "unattributed",
      windows: quotaWindows.map((row) => ({
        limitId: row.limitId,
        slot: row.slot,
        planType: row.planType,
        usedPercent: row.usedPercent,
        remainingPercent: row.remainingPercent,
        durationMinutes: row.durationMinutes,
        resetAt: row.resetAt,
      })),
    },
    tools: { total: toolTotal, counts: toolCounts },
    timeline: {
      bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
      coveredAt: {
        startAt: canonicalIndexInstant(
          value.timeline?.coveredAt?.startAt,
          { nullable: true },
        ),
        endAt: canonicalIndexInstant(
          value.timeline?.coveredAt?.endAt,
          { nullable: true },
        ),
      },
      usage: [],
      quota: quotaRows.filter((row) => {
        const observedMs = Date.parse(row.observedAt);
        return observedMs >= recentStartMs
          && observedMs <= nowMs + 5 * 60_000;
      }),
    },
    recordCounts,
  };
}

async function readCollectorProjection(
  path,
  nowMs,
  { summarizeUsageEvents = true, declaredSpeedBaselines = [] } = {},
) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
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
        timeline: { bucketMinutes: 15, usage: [], quota: [] },
        recordCounts: { usage: 0, quota: 0, tools: 0, other: 0 },
      };
    }
    throw fixedError("collector_unavailable");
  }
  if (!metadata.isFile() || metadata.size > MAX_LEDGER_BYTES) throw fixedError("collector_invalid_size");
  const projectionFile = `${path}.projection-v1.json`;
  if (!summarizeUsageEvents) {
    try {
      const cachedMetadata = await lstat(projectionFile);
      if (cachedMetadata.isFile()
          && !cachedMetadata.isSymbolicLink()
          && cachedMetadata.nlink === 1
          && (typeof process.getuid !== "function"
            || cachedMetadata.uid === process.getuid())
          && (cachedMetadata.mode & 0o077) === 0
          && cachedMetadata.size <= MAX_COLLECTOR_PROJECTION_BYTES) {
        const cached = JSON.parse(await readFile(projectionFile, "utf8"));
        const projection = cachedCollectorProjection(
          cached?.projection,
          nowMs,
        );
        if (cached?.schemaVersion
              === COLLECTOR_PROJECTION_SCHEMA_VERSION
            && cached.source?.device === metadata.dev
            && cached.source?.inode === metadata.ino
            && cached.source?.birthtimeMs
              === Math.trunc(metadata.birthtimeMs)
            && cached.source?.size === metadata.size
            && cached.source?.mtimeMs === Math.trunc(metadata.mtimeMs)
            && projection !== null) {
          return projection;
        }
      }
    } catch {
      // Any cache ambiguity falls back to the authoritative owner-only ledger.
    }
  }
  const periods = [
    { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("all", "All retained evidence"), start: Number.NEGATIVE_INFINITY },
  ];
  const toolCounts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [toolClass, 0]));
  const recordCounts = { usage: 0, quota: 0, tools: 0, other: 0 };
  const recentStartMs = nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000;
  const timelineBuckets = new Map();
  const quotaTimeline = [];
  let toolTotal = 0;
  let recordCount = 0;
  let malformedLines = 0;
  let firstRecordAt = null;
  let latestRecordAt = null;
  let firstExportableRecordAt = null;
  let latestExportableRecordAt = null;
  let latestQuotaRecord = null;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LEDGER_LINE_BYTES) {
      malformedLines += 1;
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      malformedLines += 1;
      continue;
    }
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
        );
        for (const period of periods) {
          if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
        }
        if (observedMs >= recentStartMs) {
          addTimelineUsage(timelineBuckets, observedMs, projection);
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
  }
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
      quota: finalizeQuotaTimeline(quotaTimeline),
    },
    recordCounts,
  };
  if (!summarizeUsageEvents) {
    await writeJsonOwnerOnlyAtomic(projectionFile, {
      schemaVersion: COLLECTOR_PROJECTION_SCHEMA_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      source: {
        device: metadata.dev,
        inode: metadata.ino,
        birthtimeMs: Math.trunc(metadata.birthtimeMs),
        size: metadata.size,
        mtimeMs: Math.trunc(metadata.mtimeMs),
      },
      projection,
    }).catch(() => {
      // Dashboard availability must not depend on an optimization write.
    });
  }
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

async function readCollectorIndexProjection(path, collector) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
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
    throw fixedError("collector_unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size > MAX_CHECKPOINT_BYTES) {
    throw fixedError("collector_unavailable");
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fixedError("collector_unavailable");
  }
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
    ? latest.windows.flatMap((window) => {
      const projected = quotaWindowProjection(window);
      return projected === null ? [] : [projected];
    })
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
    { summary: newUsagePeriod("all", "All retained evidence"), start: Number.NEGATIVE_INFINITY },
  ];
  for (const record of records) {
    if (record.kind !== "codex_rollout_usage_snapshot") continue;
    const observedMs = validObservedAt(record);
    if (observedMs === null || observedMs > nowMs + 5 * 60_000) continue;
    const projection = usageProjection(record);
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
    }
  }
  return periods.map((period) => finalizeUsagePeriod(period.summary));
}

async function reportProjection(root) {
  return Promise.all(REPORTS.map(async ({ file, ...report }) => {
    try {
      const metadata = await stat(resolve(root, file));
      if (!metadata.isFile()) throw new Error("not_file");
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

export async function buildLocalCompanionSnapshot({
  root = process.cwd(),
  collectorFile = resolve(root, ".usage-monitor", "collector-events.jsonl"),
  checkpointFile = resolve(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
  accountingCacheFile = defaultReplaySafeAccountingCachePath(root),
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
  const replaySafeAccounting = await readReplaySafeAccountingCache({
    cacheFile: accountingCacheFile,
    now: () => nowMs,
    maximumAgeMs: MAX_REPLAY_SAFE_CACHE_AGE_MS,
  });
  const replaySafeCache = ["available", "stale"].includes(
    replaySafeAccounting.status,
  )
    ? replaySafeAccounting.cache
    : null;
  if (typeof allowDevelopmentArtifactFallback !== "boolean") {
    throw new TypeError("allowDevelopmentArtifactFallback must be a boolean");
  }
  const [gradient, historicalWeekly, quality, collector, reports] = await Promise.all([
    projectArtifact(root, "gradient"),
    allowDevelopmentArtifactFallback
      ? projectArtifact(root, "weekly")
      : Promise.resolve({
        status: "unavailable",
        generatedAt: null,
        artifactStatus: null,
        errorCode: "development_fallback_disabled",
        dataClass: "development_only_historical_artifact",
        datasets: {},
      }),
    projectArtifact(root, "quality"),
    readCollectorProjection(collectorFile, nowMs, {
      summarizeUsageEvents: replaySafeCache === null,
      declaredSpeedBaselines: Array.isArray(codexSpeedBaselines)
        ? codexSpeedBaselines
        : [],
    }),
    reportProjection(root),
  ]);
  const liveWeekly = projectLiveWeeklyCalibration(
    replaySafeCache,
    replaySafeAccounting.errorCode,
  );
  const weekly = liveWeekly.status === "unavailable"
    && allowDevelopmentArtifactFallback
    ? {
      ...historicalWeekly,
      dataClass: "development_only_historical_artifact",
    }
    : liveWeekly;
  const latestRecordAt = collector.latestRecordAt;
  const indexing = await readCollectorIndexProjection(checkpointFile, collector);
  const latestEvidenceAt = latestRecordAt === null ? null : new Date(latestRecordAt).toISOString();
  const evidenceAgeSeconds = latestRecordAt === null ? null : Math.max(0, Math.round((nowMs - latestRecordAt) / 1_000));
  const collectorFreshnessStatus = evidenceAgeSeconds === null
    ? "unavailable"
    : evidenceAgeSeconds * 1_000 <= MAX_COLLECTOR_LIVE_AGE_MS ? "live" : "stale";
  const freshnessStatus = replaySafeAccounting.status === "stale"
    ? "stale"
    : collectorFreshnessStatus;
  const usage = replaySafeCache?.periods ?? collector.usage;
  const displayUsage = usage.find((period) => period.id === "7d" && period.events > 0)
    ?? usage.find((period) => period.id === "all");
  const selectedFastModePreference = isFastModePreference(fastModePreference)
    ? fastModePreference
    : DEFAULT_FAST_MODE_PREFERENCE;
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
  const quota = collector.quota;
  const quotaTimeline = Array.isArray(replaySafeCache?.quotaTimeline)
      && replaySafeCache.quotaTimeline.length > 0
    ? replaySafeCache.quotaTimeline
    : collector.timeline.quota;
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
  if (replaySafeAccounting.status === "stale") {
    warnings.push(
      `Replay-safe cost accounting is ${Math.round((replaySafeAccounting.ageSeconds ?? 0) / 60)} minutes old and is shown as stale until refreshed.`,
    );
  }
  if (replaySafeAccounting.errorCode === "cache_price_registry_outdated") {
    warnings.push(
      "Official API prices changed. Cached price estimates are withheld until the next local replay rebuilds them with the current registry.",
    );
  }
  if (replaySafeCache === null && (displayUsage?.events ?? 0) > 0) {
    warnings.push(
      "Recent cost accounting is using the legacy collector projection. It may include inherited snapshots from forked child rollouts until the replay-safe cache is refreshed.",
    );
  }
  if (indexing.status === "prospective_only") {
    warnings.push("The retained ledger began prospectively and does not prove recent-history coverage.");
  }
  if ((displayUsage?.pricingCoverage.unpricedEvents ?? 0) > 0) {
    warnings.push("Some usage events have an unknown model and are excluded from API-price-equivalent cost.");
  }
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
          accountingStatus: replaySafeAccounting.status,
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
        sourceMode: "content_free_collector_ledger",
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
        bucketMinutes: replaySafeCache?.bucketMinutes
          ?? collector.timeline.bucketMinutes,
        coveredAt: replaySafeCache?.coveredAt
          ?? collector.timeline.coveredAt,
        usage: replaySafeCache?.timeline
          ?? collector.timeline.usage,
        quota: quotaTimeline,
      },
      accounting: {
        periodId: displayUsage?.id ?? "all",
        periodLabel: displayUsage?.label ?? "All retained evidence",
        events: displayUsage?.events ?? 0,
        totalTokens: displayUsage?.totalTokens ?? 0,
        apiPriceEquivalentUsd: displayUsage?.apiPriceEquivalentUsd ?? 0,
        quotaWeightedApiPriceEquivalentUsd:
          displayFastMode.quotaWeightedApiPriceEquivalentUsd,
        fastMode: displayFastMode,
        speedWeighting: safeSpeedWeighting(displayUsage?.speedWeighting),
        components: displayUsage?.components ?? emptyComponents(),
        componentCosts: displayUsage?.componentCosts ?? {},
        byModel: displayUsage?.byModel ?? [],
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
        accountingSource: replaySafeCache === null
          ? "legacy_collector_unverified"
          : replaySafeCache.accountingMethod,
        accountingCacheStatus: replaySafeAccounting.status,
        replayExclusionDiagnostics: replaySafeCache?.diagnostics ?? null,
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
          quotaWeightedApiPriceEquivalentUsd:
            periodFastMode.get(period.id)
              ?.quotaWeightedApiPriceEquivalentUsd ?? null,
          fastMode: periodFastMode.get(period.id) ?? displayFastMode,
          speedWeighting: safeSpeedWeighting(period.speedWeighting),
          pricingCoverage: period.pricingCoverage,
          components: period.components,
          componentCosts: period.componentCosts ?? {},
          byModel: period.byModel,
          bySpeed: period.bySpeed,
          byApiServiceTier: period.byApiServiceTier,
          bySurface: period.bySurface,
          byAgentScope: period.byAgentScope,
          byLineage: period.byLineage,
          byReasoningEffort: period.byReasoningEffort,
          accountAttribution: period.accountAttribution,
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
        // The headline figure once the published Fast credit rate has been
        // applied to events whose effective mode is Fast. Null when no
        // legitimate weighting is available for any of the recorded cost.
        quotaWeightedTotalCostUsd:
          displayFastMode.quotaWeightedApiPriceEquivalentUsd,
        quotaWeightedMetricLabel: displayFastMode.metricLabel,
        quotaWeightedMetricExplainer: displayFastMode.metricExplainer,
        fastMode: displayFastMode,
        periodLabel: displayUsage?.label ?? "All retained evidence",
        coveragePercent: pricingCoveragePercent,
        eventCount: displayUsage?.events ?? 0,
        apiTier: "standard",
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
        // This is deliberately part of the closed dashboard projection. The
        // displayed seven-day fits use the same current-price sensitivity as
        // the rest of the local cost view, rather than silently retaining an
        // older card for a recent-looking fit.
        priceEpochBasis: "current_price_sensitivity_at_registry_observation",
        accountingSource: replaySafeCache === null
          ? "legacy_collector_unverified"
          : replaySafeCache.accountingMethod,
        accountingCacheStatus: replaySafeAccounting.status,
        replayExclusionDiagnostics: replaySafeCache?.diagnostics ?? null,
      },
      coverage: {
        overallPercent: pricingCoveragePercent,
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
