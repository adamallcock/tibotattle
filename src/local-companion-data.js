import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { priceCodexUsageEvent } from "./local-api-pricing.js";
import { APP_PRICE_REGISTRY_MANIFEST } from "./price-registry.js";

export const LOCAL_COMPANION_SCHEMA_VERSION = "local-companion-v0.1";

const MAX_LEDGER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LEDGER_LINE_BYTES = 1024 * 1024;
const MAX_LEDGER_RECORDS = 5_000_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
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

function usageProjection(record) {
  const components = emptyComponents();
  addComponents(components, record.components);
  const totalTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
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
    accountAttribution: {
      attributedPseudonymousEvents: 0,
      unattributedEvents: 0,
    },
  };
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

async function readCollectorProjection(path, nowMs) {
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
      const projection = usageProjection(value);
      for (const period of periods) {
        if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
      }
      if (observedMs >= recentStartMs) addTimelineUsage(timelineBuckets, observedMs, projection);
    }
    if (value.kind === "codex_tool_class_event") {
      const toolClass = KNOWN_TOOL_CLASSES.has(value.toolClass) ? value.toolClass : "other";
      toolCounts[toolClass] += 1;
      toolTotal += 1;
    }
  }
  return {
    status: "available",
    recordCount,
    malformedLines,
    firstRecordAt,
    latestRecordAt,
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

export async function buildLocalCompanionSnapshot({
  root = process.cwd(),
  collectorFile = resolve(root, ".usage-monitor", "collector-events.jsonl"),
  now = () => Date.now(),
} = {}) {
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
  const [gradient, weekly, quality, collector, reports] = await Promise.all([
    projectArtifact(root, "gradient"),
    projectArtifact(root, "weekly"),
    projectArtifact(root, "quality"),
    readCollectorProjection(collectorFile, nowMs),
    reportProjection(root),
  ]);
  const latestRecordAt = collector.latestRecordAt;
  const latestEvidenceAt = latestRecordAt === null ? null : new Date(latestRecordAt).toISOString();
  const evidenceAgeSeconds = latestRecordAt === null ? null : Math.max(0, Math.round((nowMs - latestRecordAt) / 1_000));
  const freshnessStatus = evidenceAgeSeconds === null
    ? "unavailable"
    : evidenceAgeSeconds <= 5 * 60 ? "live" : "stale";
  const usage = collector.usage;
  const displayUsage = usage.find((period) => period.id === "7d" && period.events > 0)
    ?? usage.find((period) => period.id === "all");
  const quota = collector.quota;
  const tools = collector.tools;
  const pricedEvents = (displayUsage?.pricingCoverage.fullyPricedEvents ?? 0)
    + (displayUsage?.pricingCoverage.partiallyPricedEvents ?? 0);
  const pricingCoveragePercent = (displayUsage?.events ?? 0) === 0
    ? null
    : Number(((pricedEvents / displayUsage.events) * 100).toFixed(3));
  const warnings = [];
  if (freshnessStatus === "stale") warnings.push("The newest retained collector evidence is stale.");
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
        staleAfterSeconds: 300,
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
        indexingState: "complete_for_retained_ledger",
        coveredAt: {
          startAt: collector.firstRecordAt === null
            ? null
            : new Date(collector.firstRecordAt).toISOString(),
          endAt: latestEvidenceAt,
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
      timeline: collector.timeline,
      accounting: {
        periodId: displayUsage?.id ?? "all",
        periodLabel: displayUsage?.label ?? "All retained evidence",
        events: displayUsage?.events ?? 0,
        totalTokens: displayUsage?.totalTokens ?? 0,
        apiPriceEquivalentUsd: displayUsage?.apiPriceEquivalentUsd ?? 0,
        components: displayUsage?.components ?? emptyComponents(),
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
        unknownModelEvents: displayUsage?.byModel
          ?.find((row) => row.model === "unknown")?.events ?? 0,
        periods: usage.map((period) => ({
          periodId: period.id,
          periodLabel: period.label,
          events: period.events,
          totalTokens: period.totalTokens,
          apiPriceEquivalentUsd: period.apiPriceEquivalentUsd,
          pricingCoverage: period.pricingCoverage,
          components: period.components,
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
        periodLabel: displayUsage?.label ?? "All retained evidence",
        coveragePercent: pricingCoveragePercent,
        eventCount: displayUsage?.events ?? 0,
        apiTier: "standard",
        components: displayUsage?.components ?? emptyComponents(),
        apiServiceTier: "standard",
        subscriptionSpeedIsSeparate: true,
        registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
        registryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
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
          status: (displayUsage?.bySpeed?.fast?.events ?? 0) > 0 ? "observed" : "not_observed",
          explanation: "Subscription Fast is kept separate from the Standard API-price counterfactual; its quota multiplier remains empirical.",
        },
        {
          id: "subagents",
          title: "Subagents and child rollouts",
          status: (displayUsage?.byAgentScope?.subagent?.events ?? 0) > 0
            ? "observed"
            : "not_observed",
          explanation: "Child-rollout usage is counted when lineage metadata is present; ambiguous lineage remains unknown.",
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
          dataClass: "historical_local_artifact",
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
