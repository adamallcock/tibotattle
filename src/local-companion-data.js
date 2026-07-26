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
const KNOWN_TOOL_CLASSES = new Set(["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]);
const KNOWN_LIMITS = new Set(["codex", "codex_bengalfox"]);
const KNOWN_PLANS = new Set(["free", "plus", "pro", "team", "business", "enterprise", "unknown"]);
const KNOWN_SLOTS = new Set(["primary", "secondary"]);

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
    bySpeed: Object.fromEntries([...KNOWN_SPEEDS].map((speed) => [speed, { events: 0, totalTokens: 0 }])),
  };
}

function addUsageToPeriod(period, record) {
  const model = safeModel(record.model);
  const speed = safeSpeed(record.tierSemantics?.codexSpeedMode);
  const components = emptyComponents();
  addComponents(components, record.components);
  const totalTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (totalTokens === 0) return;
  period.events += 1;
  period.totalTokens += totalTokens;
  addComponents(period.components, components);
  const modelSummary = period.byModel[model] ??= {
    model,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
  };
  modelSummary.events += 1;
  modelSummary.totalTokens += totalTokens;
  period.bySpeed[speed].events += 1;
  period.bySpeed[speed].totalTokens += totalTokens;
  let priced;
  try {
    priced = priceCodexUsageEvent({
      timestamp: record.observedAt,
      model,
      components,
    }, {
      apiServiceTier: "standard",
      priceEpochBasis: "current_price_sensitivity",
    });
  } catch {
    priced = { totalUsd: "0", coverageStatus: "unpriced" };
  }
  const cost = Number(priced.totalUsd);
  if (Number.isFinite(cost)) {
    period.apiPriceEquivalentUsd += cost;
    modelSummary.apiPriceEquivalentUsd += cost;
  }
  if (priced.coverageStatus === "fully_priced") period.pricingCoverage.fullyPricedEvents += 1;
  else if (priced.coverageStatus === "partially_priced") period.pricingCoverage.partiallyPricedEvents += 1;
  else period.pricingCoverage.unpricedEvents += 1;
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
  };
}

function validObservedAt(record) {
  const timestamp = Date.parse(record?.observedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
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
        latestRecordAt: null,
        usage: summarizeUsage([], nowMs),
        quota: latestQuotaProjection([]),
        tools: summarizeToolClasses([]),
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
  let toolTotal = 0;
  let recordCount = 0;
  let malformedLines = 0;
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
    if (observedMs !== null && (latestRecordAt === null || observedMs > latestRecordAt)) {
      latestRecordAt = observedMs;
    }
    if (value.kind === "codex_quota_snapshot" && observedMs !== null
        && (latestQuotaRecord === null
          || value.observedAt.localeCompare(latestQuotaRecord.observedAt) > 0)) {
      latestQuotaRecord = value;
    }
    if (value.kind === "codex_rollout_usage_snapshot"
        && observedMs !== null && observedMs <= nowMs + 5 * 60_000) {
      for (const period of periods) {
        if (observedMs >= period.start) addUsageToPeriod(period.summary, value);
      }
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
    latestRecordAt,
    usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
    quota: latestQuotaProjection(latestQuotaRecord === null ? [] : [latestQuotaRecord]),
    tools: { total: toolTotal, counts: toolCounts },
  };
}

function latestQuotaProjection(records) {
  const latest = records
    .filter((record) => record.kind === "codex_quota_snapshot" && validObservedAt(record) !== null)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .at(-1);
  if (!latest) return { status: "unavailable", observedAt: null, windows: [] };
  const windows = Array.isArray(latest.windows) ? latest.windows.flatMap((window) => {
    if (!window || typeof window !== "object") return [];
    const usedPercent = finiteNumber(window.usedPercent);
    const durationMinutes = Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0
      ? window.windowDurationMins
      : null;
    const resetsAtSeconds = Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null;
    return [{
      limitId: KNOWN_LIMITS.has(window.limitId) ? window.limitId : "unknown",
      slot: KNOWN_SLOTS.has(window.slot) ? window.slot : "unknown",
      planType: KNOWN_PLANS.has(window.planType) ? window.planType : "unknown",
      usedPercent,
      remainingPercent: usedPercent === null ? null : Number(Math.max(0, 100 - usedPercent).toFixed(3)),
      durationMinutes,
      resetAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1_000).toISOString(),
    }];
  }) : [];
  return {
    status: windows.length > 0 ? "available" : "unavailable",
    observedAt: safeText(latest.observedAt),
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
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, record);
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
        malformedLines: collector.malformedLines,
        lastScanAt: latestEvidenceAt,
        safeRecordCount: collector.recordCount,
        identityMode: "prospective_pseudonymous_not_exposed",
      },
      quota,
      quotaWindows: quota.windows.map((window) => ({
        ...window,
        observedAt: quota.observedAt,
        status: freshnessStatus,
      })),
      usage,
      tools,
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
      artifactStatus: {
        gradient: { status: gradient.status, generatedAt: gradient.generatedAt },
        weekly: { status: weekly.status, generatedAt: weekly.generatedAt },
        quality: { status: quality.status, generatedAt: quality.generatedAt },
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
