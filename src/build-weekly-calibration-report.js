#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const inputPath = resolve(root, ".usage-monitor/weekly-calibration-v0.2.json");
const providerCrosscheckPath = resolve(root, ".usage-monitor/provider-crosscheck-v0.1.json");
const experimentPath = resolve(root, ".usage-monitor/experiment-results.jsonl");
const highErrorAuditPath = resolve(root, ".usage-monitor/weekly-calibration-high-error-audit-v0.1.json");
const outputPath = resolve(root, "2026-07-24-weekly-7-day-calibration-artifact.json");
const calibration = JSON.parse(await readFile(inputPath, "utf8"));
const providerCrosscheck = JSON.parse(await readFile(providerCrosscheckPath, "utf8"));
const experimentResults = (await readFile(experimentPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const highErrorAudit = JSON.parse(await readFile(highErrorAuditPath, "utf8"));
const generatedAt = new Date().toISOString();

const selected = calibration.selection.candidateScores.find((row) => row.id === calibration.selection.selectedCandidateId);
const standard = calibration.selection.candidateScores.find((row) => row.id === "standard_api");
const summary = calibration.weeklyValueSummary;
const improvement = calibration.selection.standardBaselineImprovement;
const selectedForecast = calibration.forecastModelSelection.candidates.find((row) => row.id === calibration.forecastModelSelection.selectedMethodId);

const summaryRows = [{
  median_weekly_value_usd: summary.medianApiPriceEquivalentUsd,
  lower_80_across_resets_usd: summary.central80AcrossResetsUsd.lower,
  upper_80_across_resets_usd: summary.central80AcrossResetsUsd.upper,
  qualifying_resets: summary.resetCount,
  selected_holdout_mae_pp: selected.pooledHoldoutMaePp,
  standard_holdout_mae_pp: standard.pooledHoldoutMaePp,
  holdout_improvement_fraction: improvement.pooledRelativeFraction,
  prior_reset_mae_pp: calibration.prospectiveStyleValidation.pooledMeanAbsoluteErrorPp,
  prior_reset_bias_pp: calibration.prospectiveStyleValidation.pooledSignedBiasPp,
  prior_reset_scored_resets: calibration.prospectiveStyleValidation.scoredResets,
  prior_reset_scored_points: calibration.prospectiveStyleValidation.scoredPoints,
  prior_reset_p80_absolute_error_pp: calibration.prospectiveStyleValidation.empiricalErrorEnvelope.p80AbsoluteErrorPp,
  selected_forecast_common_mae_pp: selectedForecast.commonEvaluation.pooledMaePp,
  selected_forecast_common_bias_pp: selectedForecast.commonEvaluation.pooledBiasPp,
  online_update_status: calibration.onlineCalibration.selectionStatus,
}];

const errorRows = calibration.errorConcentration.resets.map((row) => ({
  first_observed_date: row.weekLabel,
  reset_due_at: row.resetIdentity,
  share_of_absolute_error: row.shareOfTotal,
  holdout_absolute_error_pp: row.absoluteErrorPp,
  holdout_mae_pp: row.meanAbsoluteErrorPp,
  holdout_bias_pp: row.signedBiasPp,
  speed_known_fraction: row.speedKnownFraction,
  fast_fraction_of_known: row.fastFractionOfKnown,
}));

const lagRows = calibration.displayLagSelection.candidates.map((row) => ({
  candidate: row.label,
  selected: row.id === calibration.displayLagSelection.selectedCandidateId ? "Lowest error" : "Candidate",
  qualifying_resets: row.qualifyingResets,
  holdout_points: row.holdoutPoints,
  pooled_mae_pp: row.pooledHoldoutMaePp,
  pooled_bias_pp: row.pooledHoldoutBiasPp,
}));

const forecastRows = calibration.forecastModelSelection.candidates.map((row) => ({
  forecast_rule: row.label,
  selected: row.id === calibration.forecastModelSelection.selectedMethodId ? "Selected" : "Candidate",
  common_resets: row.commonEvaluation.scoredResets,
  common_points: row.commonEvaluation.scoredPoints,
  pooled_mae_pp: row.commonEvaluation.pooledMaePp,
  pooled_bias_pp: row.commonEvaluation.pooledBiasPp,
  regime_forecasts: row.detectedRegimeForecasts.length,
}));

const checkpointRows = calibration.onlineCalibration.candidates.map((row) => ({
  checkpoint_display_pp: row.requestedDisplaySpanPp,
  comparable_resets: row.comparison.scoredResets,
  corrected_online_mae_pp: row.comparison.pooledMaePp,
  prior_forecast_mae_pp: row.comparison.priorPooledMaePp,
  improvement_fraction: row.comparison.improvementVersusPriorFraction,
  accepted: row.id === calibration.onlineCalibration.selectedCheckpointId ? "Accepted" : "Rejected",
}));
const providerEpochRows = providerCrosscheck.comparisons.byPolicyEpoch.map((row) => ({
  epoch: row.epochId,
  start_date: row.startDate,
  end_date: row.endDate,
  comparable_days: row.officialDays,
  local_to_provider_token_ratio: row.localToOfficialRatio,
  local_api_priced_usd: row.localApiPricedUsd,
  provider_only_days: row.providerOnlyDays,
  evidence_status: row.status,
}));
const experimentGroups = experimentResults.reduce((groups, row) => {
  (groups[row.status] ??= []).push(row);
  return groups;
}, {});
const experimentStatusCounts = Object.entries(experimentGroups).map(([status, rows]) => ({
  status,
  attempts: rows.length,
  controlled_results: rows.filter((row) => row.controlledState === "controlled").length,
  unknown_results: rows.filter((row) => row.controlledState === "unknown").length,
  stop_reasons: [...new Set(rows.flatMap((row) => row.stopReasons ?? []))].join(", ") || "none",
}));
const highErrorSurfaceRows = highErrorAudit.resets.flatMap((reset) => Object.entries(reset.localSurfaceEvidence.bySurface).map(([surface, values]) => ({
  first_observed_date: reset.weekLabel,
  surface,
  events: values.events,
  event_share: values.events / reset.localSurfaceEvidence.eventCount,
  total_tokens: values.totalTokens,
  token_share: values.totalTokens / reset.localSurfaceEvidence.totalTokens,
  standard_api_priced_usd: values.totalUsd,
  cost_share: values.totalUsd / reset.localSurfaceEvidence.standardApiPricedUsd,
})));

const candidateRows = calibration.selection.candidateScores.map((row) => ({
  accounting_basis: row.label,
  selected: row.id === calibration.selection.selectedCandidateId ? "Selected" : "Candidate",
  qualifying_resets: row.qualifyingResets,
  holdout_points: row.holdoutPoints,
  median_reset_holdout_mae_pp: row.medianResetHoldoutMaePp,
  pooled_holdout_mae_pp: row.pooledHoldoutMaePp,
  pooled_holdout_bias_pp: row.pooledHoldoutBiasPp,
  median_in_sample_mae_pp: row.medianResetInSampleMaePp,
}));

const weeklyRows = calibration.resetValues.map((row, index) => ({
  sequence: index + 1,
  first_observed_at: row.firstObservedAt,
  last_observed_at: row.lastObservedAt,
  reset_due_at: row.resetIdentity,
  slot: row.slot,
  displayed_span_pp: row.percentSpan,
  value_usd: row.apiPriceEquivalentUsd,
  pairwise_p10_usd: row.central80PairwiseUsd.lower,
  pairwise_p90_usd: row.central80PairwiseUsd.upper,
  holdout_observed_movement_pp: row.chronologicalHoldout.observedMovementPp,
  holdout_predicted_movement_pp: row.chronologicalHoldout.predictedMovementPp,
  holdout_mae_pp: row.chronologicalHoldout.meanAbsoluteErrorPp,
  holdout_bias_pp: row.chronologicalHoldout.signedBiasPp,
  prior_forecast_value_usd: row.priorPrediction?.forecastCapacityUsd ?? null,
  prior_prediction_mae_pp: row.priorPrediction?.meanAbsoluteErrorPp ?? null,
  prior_prediction_bias_pp: row.priorPrediction?.signedBiasPp ?? null,
  known_speed_fraction: row.speedEvidence.knownFraction,
  fast_fraction_of_known: row.speedEvidence.fastFractionOfKnown,
  eligible_transitions: row.eligibleTransitions,
  unique_percentage_boundaries: row.pointCount,
}));

const valueSeries = weeklyRows.flatMap((row) => [
  { ...row, series: "Estimated value", value_series_usd: row.value_usd },
  { ...row, series: "Pairwise p10", value_series_usd: row.pairwise_p10_usd },
  { ...row, series: "Pairwise p90", value_series_usd: row.pairwise_p90_usd },
]);

const holdoutSeries = weeklyRows.flatMap((row) => [
  { ...row, series: "Observed later movement", movement_pp: row.holdout_observed_movement_pp },
  { ...row, series: "Predicted later movement", movement_pp: row.holdout_predicted_movement_pp },
]);

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Calibrating the Seven-Day Codex Limit",
    description: "A reset-by-reset API-price-equivalent value series with chronological holdout and prior-reset validation.",
    generatedAt,
    blocks: [
      { id: "title", type: "markdown", body: "# Calibrating the Seven-Day Codex Limit" },
      {
        id: "technical_summary",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Technical summary\n\n**Use $${summary.medianApiPriceEquivalentUsd.toFixed(0)} as the current seven-day ballpark, with the middle 80% of reset estimates spanning $${summary.central80AcrossResetsUsd.lower.toFixed(0)}–$${summary.central80AcrossResetsUsd.upper.toFixed(0)}.** This means Standard-API-price-equivalent work for 100% of the provider display; it is not a provider cash allowance or rate card.\n\nThe selected cost ledger predicts later movement inside the same reset with **${selected.pooledHoldoutMaePp.toFixed(2)} percentage-point MAE**, a **${(100 * improvement.pooledRelativeFraction).toFixed(1)}%** improvement over unweighted Standard API cost. A harder forecast made from earlier completed resets misses by **${calibration.prospectiveStyleValidation.pooledMeanAbsoluteErrorPp.toFixed(2)} points on average**; 80% of its individual errors are within **${calibration.prospectiveStyleValidation.empiricalErrorEnvelope.p80AbsoluteErrorPp.toFixed(2)} points**.\n\n**Do not use an early in-reset recalibration yet.** Every tested 5–60 point checkpoint failed the acceptance rule. No-delay also beat the one-event, 5-second, 30-second, and 60-second lag candidates. The evidence therefore supports a monitored ballpark with explicit error, not a more complicated production correction.`,
      },
      {
        id: "pool_policy",
        type: "markdown",
        sourceId: "agentic_pool_policy",
        body: "## What is actually in this limit\n\nOrdinary Chat conversations and ordinary Chat Voice are outside the Codex/Work shared agentic pool. Codex, ChatGPT Work, Workspace Agents, and ChatGPT for Excel are included; Work Voice task work is included while connected Voice time has a separate meter. Image generation consumes the included general limit roughly 3–5 times faster on average and therefore needs its own activity marker. GPT-5.3-Codex-Spark has a separate, demand-adjusted limit and must not be merged into this seven-day fit.",
      },
      { id: "headline_metrics", type: "metric-strip", cardIds: ["weekly_value", "holdout_error", "prior_error", "reset_count"] },
      {
        id: "forecast_validation_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Earlier resets remain the safest live forecast\n\nThe selected prior-window rule is **${calibration.forecastModelSelection.selectedMethodLabel}**. On the ${calibration.forecastModelSelection.commonEvaluationResets} resets forecastable by every candidate, it records **${selectedForecast.commonEvaluation.pooledMaePp.toFixed(2)} pp MAE** and **${selectedForecast.commonEvaluation.pooledBiasPp.toFixed(2)} pp bias**. The diagnostic recency-weighted mean reaches ${calibration.forecastModelSelection.candidates.find((row) => row.id === calibration.forecastModelSelection.diagnosticBestMethodId).commonEvaluation.pooledMaePp.toFixed(2)} pp, but its ${(100 * calibration.forecastModelSelection.diagnosticBestImprovementVersusBaselineFraction).toFixed(1)}% gain is below the 10% adoption rule and its absolute bias is worse. The persistent 15% shift rule was not selected. A fixed July 9 boundary is ${calibration.regimeHypotheses.julyNine2026.status.replaceAll("_", " ")} and ${calibration.regimeHypotheses.julyNine2026.adopted ? "improves" : "does not improve"} the rolling-three comparator on the same later resets.`,
      },
      { id: "forecast_table_block", type: "table", tableId: "forecast_table", layout: "full" },
      {
        id: "online_update_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Early in-reset fits are rejected, not silently blended\n\nThe tested checkpoints begin after at least nine unique displayed boundaries and 5, 10, 15, 20, 30, 40, 50, or 60 percentage points of movement. Their status is **${calibration.onlineCalibration.selectionStatus.replaceAll("_", " ")}**. The least-bad diagnostic checkpoint is ${calibration.onlineCalibration.diagnosticBestCheckpointId ?? "unavailable"}, at ${calibration.onlineCalibration.diagnosticBestPooledMaePp?.toFixed(2) ?? "unavailable"} pp MAE, so the live state remains **prior forecast only**.`,
      },
      { id: "checkpoint_table_block", type: "table", tableId: "checkpoint_table", layout: "full" },
      {
        id: "lag_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Short display-delay corrections make prediction worse\n\n**${calibration.displayLagSelection.selectedCandidateLabel}** has the lowest chronological holdout error. The result rejects a timing correction at one event, 5 seconds, 30 seconds, or 60 seconds; smoothing is still useful for descriptive charts, but it is not an accuracy multiplier for this reset-level model.`,
      },
      { id: "lag_table_block", type: "table", tableId: "lag_table", layout: "full" },
      {
        id: "provider_crosscheck_finding",
        type: "markdown",
        sourceId: "provider_crosscheck",
        body: `## Provider totals are a useful cross-check, not a per-turn join\n\nThe account-level provider bucket agrees much more closely with retained local tokens after July 9: the local/provider ratios are **${providerEpochRows.find((row) => row.epoch === "chatgpt-work-launch")?.local_to_provider_token_ratio.toFixed(3)}** for July 9–15 and **${providerEpochRows.find((row) => row.epoch === "work-cross-device-continuity")?.local_to_provider_token_ratio.toFixed(3)}** for July 16–24. Before July 9, the comparable ratio is much higher. This supports treating the date as a measurement/accounting hypothesis, but does not prove a quota formula because the old local rows are not account-matched. Prospective same-account provider reconciliation is **${providerCrosscheck.comparisons.prospectiveAccountScoped.status.replaceAll("_", " ")}**.`,
      },
      { id: "provider_epoch_table_block", type: "table", tableId: "provider_epoch_table", layout: "full" },
      {
        id: "experiment_finding",
        type: "markdown",
        sourceId: "experiment_results",
        body: `## Controlled multipliers remain unlearned\n\nThe harness preserved **${experimentResults.length}** attempts: ${experimentResults.filter((row) => row.status === "preflight_refused").length} were safely refused, ${experimentResults.filter((row) => row.status === "dry_run_only").length} were dry runs, and ${experimentResults.filter((row) => row.status === "completed_with_stop").length} completed with a stop. **Zero results are controlled.** The two completed attempts had concurrent local activity and exceeded their measured API-price budget, so they cannot identify cache, effort, model, or speed multipliers.`,
      },
      { id: "experiment_table_block", type: "table", tableId: "experiment_table", layout: "full" },
      {
        id: "value_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## The seven-day value is centered near $1.9k, but it moves by reset\n\nThe central line is the robust full-reset estimate. The outer lines are the 10th and 90th percentiles of dependent pairwise slopes within that reset; they show internal slope instability and display-lag sensitivity, not statistical confidence limits. Multiple resets can begin in the same calendar week, so the chart uses exact first-observed timestamps rather than forcing unrelated windows into a Monday bucket.",
      },
      { id: "value_chart_block", type: "chart", chartId: "value_chart", layout: "full" },
      {
        id: "calibration_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Calculated movement follows measured movement within about two points\n\nEach reset is split chronologically: the earlier 70% of unique displayed-percentage boundaries estimates the gradient, and the later 30% is untouched holdout data. The selected ledger reduces pooled holdout MAE from **${standard.pooledHoldoutMaePp.toFixed(2)} to ${selected.pooledHoldoutMaePp.toFixed(2)} pp**. Negative aggregate bias means the calculation still tends to predict slightly less quota movement than the display later reports, consistent with lagged display updates or shared-pool activity missing from the local ledger.`,
      },
      { id: "holdout_chart_block", type: "chart", chartId: "holdout_chart", layout: "full" },
      {
        id: "candidate_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## Speed evidence helps only at the conservative boundary\n\nThe lower-bound speed model leaves unknown events at Standard and weights only captured Fast events. Midpoint and upper-bound treatments assume progressively more of the unknown traffic was Fast; both worsen holdout error. The data therefore reject an indiscriminate historical Fast uplift even though a specifically captured Fast episode can reconcile well on its own.",
      },
      { id: "candidate_chart_block", type: "chart", chartId: "candidate_chart", layout: "full" },
      { id: "candidate_table_block", type: "table", tableId: "candidate_table", layout: "full" },
      {
        id: "week_table_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## Exact reset rows preserve the uncertainty and prediction receipts\n\nUse the table for lookup. The API-price-equivalent value is the descriptive full-reset fit; the later-30% MAE is the within-reset prediction check; the prior-reset MAE is the no-look-ahead stability check. A missing prior-reset score means fewer than two earlier completed resets existed in the same account/plan continuity track.",
      },
      { id: "weekly_table_block", type: "table", tableId: "weekly_table", layout: "full" },
      {
        id: "error_concentration_finding",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Two resets explain ${(100 * calibration.errorConcentration.topTwoCumulativeShare).toFixed(1)}% of later-period error\n\nThe resets first seen on **${calibration.errorConcentration.resets[0].weekLabel}** and **${calibration.errorConcentration.resets[1].weekLabel}** dominate the remaining mismatch. Their speed coverage is ${(100 * calibration.errorConcentration.resets[0].speedKnownFraction).toFixed(1)}% and ${(100 * calibration.errorConcentration.resets[1].speedKnownFraction).toFixed(1)}%, respectively. Model, token-component, subagent, and tool mixes are retained in the audit JSON, but with only 14 reset values, fitting several new multipliers would mostly learn these two exceptions rather than establish a reusable accounting rule.`,
      },
      { id: "error_table_block", type: "table", tableId: "error_table", layout: "full" },
      {
        id: "high_error_surface_finding",
        type: "markdown",
        sourceId: "high_error_audit",
        body: `## Local tasks are counted, but they do not explain the two outliers\n\nThe July 3 span contains ${highErrorAudit.resets[0].localSurfaceEvidence.eventCount.toLocaleString("en-US")} locally priced events: ${(100 * highErrorSurfaceRows.find((row) => row.first_observed_date === "2026-07-03" && row.surface === "subagent").event_share).toFixed(1)}% are subagent events and no scheduled-task surface is present. The July 16 span contains ${highErrorAudit.resets[1].localSurfaceEvidence.eventCount.toLocaleString("en-US")} events, including ${(100 * highErrorSurfaceRows.find((row) => row.first_observed_date === "2026-07-16" && row.surface === "subagent").event_share).toFixed(1)}% subagent and ${(100 * highErrorSurfaceRows.find((row) => row.first_observed_date === "2026-07-16" && row.surface === "scheduled_task").event_share).toFixed(1)}% scheduled-task events. Both are already included in local API-priced cost. Neither reset contains exact provider-billed tool or image-generation units, and unlogged Work, Workspace Agent, Excel, or Codex Cloud activity remains unbounded. Ordinary Chat is not part of this pool; Spark uses a separate limit.`,
      },
      { id: "high_error_surface_table_block", type: "table", tableId: "high_error_surface_table", layout: "full" },
      {
        id: "scope_definitions",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: `## Scope, data, and metric definitions\n\nThe retained evidence spans **${calibration.source.startAt} through ${calibration.source.endAt}** and uses ${calibration.source.pricingBasis}. One observation boundary is a unique whole-percentage value inside one exact **codex** seven-day reset identity.\n\n**API-price-equivalent seven-day value** is 100 times the robust median cost per displayed percentage point. **Chronological holdout MAE** is the mean absolute difference between measured and calculated later movement after fitting only the earlier 70%. **Prior-reset MAE** uses a rolling median of up to three earlier completed reset values, with a minimum of two. All errors are provider-displayed percentage points.`,
      },
      {
        id: "method",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## Model and validation method\n\n1. Keep only the fixed `codex` 10,080-minute family; exclude the moving/high-churn `codex_bengalfox` family.\n2. Partition by account scope, plan variant, provider, plan, limit, slot, duration, and exact reset timestamp. Suppress only reset duplicates within two seconds, choosing the group with more eligible transitions.\n3. Retain monotonic transitions with local usage, complete elapsed-time coverage, and no pricing or attribution warning.\n4. Convert each displayed percentage boundary to the midpoint of its last-prior/first-next cumulative cost interval and take the median when a percentage repeats.\n5. Fit median pairwise cost-per-point on the earlier 70%, then score the later 30%. Choose the accounting basis by median reset holdout MAE and pooled MAE as the tiebreaker.\n6. Refit the selected basis over the full reset only after model selection. Reject a reset when its pairwise p10–p90 width exceeds its median value.\n7. For temporal validation, forecast a reset from only earlier completed resets in the same account/plan/provider/limit/duration track. Slot remains visible metadata but does not break the historical secondary-to-primary continuity view.",
      },
      {
        id: "accuracy_floor_decision",
        type: "markdown",
        sourceId: "accuracy_floor_decision",
        body: `## The current historical accuracy floor is documented, not hidden\n\nThe prospective targets are not met: same-reset MAE is ${calibration.accuracyFloorAssessment.sameResetMaePp.toFixed(2)} pp versus 1.5, prior-reset MAE is ${calibration.accuracyFloorAssessment.priorResetMaePp.toFixed(2)} pp versus 2.5, absolute bias is ${calibration.accuracyFloorAssessment.priorResetAbsoluteBiasPp.toFixed(2)} pp versus 0.5, and the historical account/snapshot-age coverage needed for a clean component fit is absent. The empirical 80th-percentile absolute forecast error is **${calibration.accuracyFloorAssessment.p80AbsoluteForecastErrorPp.toFixed(2)} pp**. Further retrospective parameter fitting is stopped; reopen selection after three new resets reach at least 90% account, speed, and snapshot-age coverage.`,
      },
      {
        id: "limitations",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## Limitations, uncertainty, and robustness\n\n- The quota display is integer-valued and lagged. The pairwise range is an empirical sensitivity envelope, not a confidence interval.\n- Historical rollout data do not identify which of two user accounts generated each observation. A reset row is still valid if its local activity and displayed percentage belong to the same account, but interleaving two accounts with the same reset identity would contaminate it.\n- Unlogged ChatGPT Work, Workspace Agent, ChatGPT for Excel, Codex Cloud, other-device Codex, or image-generation activity can move the included limit without a matching local receipt. Ordinary Chat conversations and ordinary Chat Voice are excluded by provider policy. Work Voice task activity uses the shared pool, connected Voice time has its own meter, and Spark has a separate demand-adjusted limit.\n- API prices normalize input, cached input, output, and reasoning tokens. They do not claim that OpenAI internally debits the subscription at API prices.\n- Captured speed is incomplete in early resets. The selected lower-bound treatment is conservative: unknown remains Standard.\n- The 14 reset estimates are dependent on the same pricing table and local logging system; the cross-reset 80% range is descriptive, not inferential.\n- Reset timestamps and slot semantics changed during the period. Exact timestamps remain in the table, and no moving-limit family is merged into the fit.",
      },
      {
        id: "recommendations",
        type: "markdown",
        sourceId: "weekly_calibration",
        body: "## Recommended next steps\n\n1. Keep the prior-reset forecast as the live default and rerun the same frozen evaluation after each completed reset.\n2. Collect three new qualifying resets with at least 90% account, speed, and provider-snapshot-age coverage before reconsidering more component multipliers.\n3. Mark Work, Workspace Agent, Excel, Codex Cloud, other-device Codex, Work Voice task, image-generation, quiet, and experiment periods with the privacy-safe activity ledger. Ordinary Chat needs no contamination marker; keep Spark snapshots in a separate series.\n4. Run bounded Standard/Fast and cached/uncached experiment pairs only when the quiet-period and quota-headroom gates pass.\n5. Treat a policy change as a candidate only after two completed resets move at least 15% in the same direction and the rule improves untouched later resets.",
      },
      {
        id: "questions",
        type: "markdown",
        body: "## Further questions\n\n- Do the two accounts show different values after both have three fully scoped resets?\n- Do controlled Fast turns retain one stable multiplier across Sol, Terra, and future model aliases?\n- Which privacy-safe Work, Workspace Agent, Excel, or Codex Cloud markers coincide with positive provider-versus-local residuals?\n- Is the remaining 2.16-point within-reset error an observability floor, or does it fall once snapshot age is known for at least 90% of transitions?",
      },
    ],
    cards: [
      {
        id: "weekly_value",
        description: "Median full-reset API-price-equivalent value, with the cross-reset p10 and p90 as comparison context.",
        dataset: "summary",
        sourceId: "weekly_calibration",
        metrics: [
          { label: "Median 7-day value", field: "median_weekly_value_usd", format: "currency" },
          { label: "Cross-reset p10", field: "lower_80_across_resets_usd", format: "currency" },
          { label: "Cross-reset p90", field: "upper_80_across_resets_usd", format: "currency" },
        ],
      },
      {
        id: "holdout_error",
        description: "Pooled later-30% prediction error for the selected cost basis, with unweighted Standard API cost as comparator.",
        dataset: "summary",
        sourceId: "weekly_calibration",
        metrics: [
          { label: "Selected holdout MAE (pp)", field: "selected_holdout_mae_pp", format: "number" },
          { label: "Standard baseline (pp)", field: "standard_holdout_mae_pp", format: "number" },
        ],
      },
      {
        id: "prior_error",
        description: "No-look-ahead error when a reset is predicted from only earlier completed reset values.",
        dataset: "summary",
        sourceId: "weekly_calibration",
        metrics: [{ label: "Prior-reset MAE (pp)", field: "prior_reset_mae_pp", format: "number" }],
      },
      {
        id: "reset_count",
        description: "Reset windows passing transition, span, pricing, attribution, and pairwise-width stability gates.",
        dataset: "summary",
        sourceId: "weekly_calibration",
        metrics: [{ label: "Qualifying resets", field: "qualifying_resets", format: "number" }],
      },
    ],
    charts: [
      {
        id: "value_chart",
        title: "Seven-day API-price-equivalent value by reset",
        subtitle: "June 13–July 21 first-observed timestamps; p10/p90 lines are dependent pairwise-slope sensitivity, not confidence bounds.",
        type: "line",
        dataset: "value_series",
        sourceId: "weekly_calibration",
        valueFormat: "currency",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "first_observed_at", type: "temporal", label: "Reset first observed (UTC)" },
          y: { field: "value_series_usd", type: "quantitative", label: "API-price-equivalent value", format: "currency" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "first_observed_at", type: "temporal", label: "First observed" },
            { field: "reset_due_at", type: "temporal", label: "Reset due" },
            { field: "value_series_usd", type: "quantitative", label: "Value", format: "currency" },
            { field: "displayed_span_pp", type: "quantitative", label: "Displayed span (pp)", format: "number" },
            { field: "known_speed_fraction", type: "quantitative", label: "Known speed share", format: "percent" },
          ],
        },
      },
      {
        id: "holdout_chart",
        title: "Measured versus calculated movement in the later 30%",
        subtitle: "Fourteen reset windows; the earlier 70% estimates each reset gradient and the later boundaries remain held out.",
        type: "line",
        dataset: "holdout_series",
        sourceId: "weekly_calibration",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "first_observed_at", type: "temporal", label: "Reset first observed (UTC)" },
          y: { field: "movement_pp", type: "quantitative", label: "Later-period quota movement (pp)", format: "number" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "first_observed_at", type: "temporal", label: "First observed" },
            { field: "holdout_mae_pp", type: "quantitative", label: "Holdout MAE (pp)", format: "number" },
            { field: "holdout_bias_pp", type: "quantitative", label: "Holdout bias (pp)", format: "number" },
            { field: "movement_pp", type: "quantitative", label: "Movement (pp)", format: "number" },
          ],
        },
      },
      {
        id: "candidate_chart",
        title: "Chronological holdout error by accounting basis",
        subtitle: "Lower is better; pooled MAE across 275 held-out percentage boundaries in 14 qualifying resets.",
        type: "bar",
        dataset: "candidates",
        sourceId: "weekly_calibration",
        valueFormat: "number",
        legend: { show: false },
        encodings: {
          x: { field: "accounting_basis", type: "nominal", label: "Accounting basis", sort: "y" },
          y: { field: "pooled_holdout_mae_pp", type: "quantitative", label: "Pooled holdout MAE (pp)", format: "number" },
          tooltip: [
            { field: "accounting_basis", type: "nominal", label: "Accounting basis" },
            { field: "pooled_holdout_mae_pp", type: "quantitative", label: "Pooled MAE (pp)", format: "number" },
            { field: "pooled_holdout_bias_pp", type: "quantitative", label: "Signed bias (pp)", format: "number" },
            { field: "median_reset_holdout_mae_pp", type: "quantitative", label: "Median reset MAE (pp)", format: "number" },
          ],
        },
      },
    ],
    tables: [
      {
        id: "forecast_table",
        title: "Earlier-reset forecast rules",
        subtitle: "Identical reset subset; lower MAE is better, and every forecast uses only already-completed resets.",
        dataset: "forecast_candidates",
        sourceId: "weekly_calibration",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "pooled_mae_pp", direction: "asc" },
        columns: [
          { field: "forecast_rule", label: "Forecast rule", type: "text" },
          { field: "selected", label: "Status", type: "text" },
          { field: "common_resets", label: "Resets", format: "number" },
          { field: "common_points", label: "Scored points", format: "number" },
          { field: "pooled_mae_pp", label: "MAE (pp)", format: "number" },
          { field: "pooled_bias_pp", label: "Bias (pp)", format: "number", semantic: "movement" },
          { field: "regime_forecasts", label: "Shift flags", format: "number" },
        ],
      },
      {
        id: "checkpoint_table",
        title: "Within-reset checkpoint validation",
        subtitle: "Time-ordered later-period scores; negative improvement means the update is worse than the prior-reset forecast.",
        dataset: "online_checkpoints",
        sourceId: "weekly_calibration",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "checkpoint_display_pp", direction: "asc" },
        columns: [
          { field: "checkpoint_display_pp", label: "Observed span (pp)", format: "number" },
          { field: "comparable_resets", label: "Resets", format: "number" },
          { field: "corrected_online_mae_pp", label: "Updated MAE (pp)", format: "number" },
          { field: "prior_forecast_mae_pp", label: "Prior MAE (pp)", format: "number" },
          { field: "improvement_fraction", label: "Improvement", format: "percent", semantic: "movement" },
          { field: "accepted", label: "Decision", type: "text" },
        ],
      },
      {
        id: "lag_table",
        title: "Display-delay candidate validation",
        subtitle: "Standard API-price basis across the same 14 resets and 275 later-period boundaries.",
        dataset: "lag_candidates",
        sourceId: "weekly_calibration",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "pooled_mae_pp", direction: "asc" },
        columns: [
          { field: "candidate", label: "Delay treatment", type: "text" },
          { field: "selected", label: "Status", type: "text" },
          { field: "qualifying_resets", label: "Resets", format: "number" },
          { field: "holdout_points", label: "Scored points", format: "number" },
          { field: "pooled_mae_pp", label: "MAE (pp)", format: "number" },
          { field: "pooled_bias_pp", label: "Bias (pp)", format: "number", semantic: "movement" },
        ],
      },
      {
        id: "error_table",
        title: "Reset contribution to prediction error",
        subtitle: "Exact reset lookup; shares sum to all absolute error in the held-out later 30%.",
        dataset: "error_concentration",
        sourceId: "weekly_calibration",
        density: "dense",
        layout: "full",
        defaultSort: { field: "share_of_absolute_error", direction: "desc" },
        columns: [
          { field: "first_observed_date", label: "First seen", type: "text" },
          { field: "reset_due_at", label: "Reset due (UTC)", type: "datetime" },
          { field: "share_of_absolute_error", label: "Share of error", format: "percent" },
          { field: "holdout_mae_pp", label: "MAE (pp)", format: "number" },
          { field: "holdout_bias_pp", label: "Bias (pp)", format: "number", semantic: "movement" },
          { field: "speed_known_fraction", label: "Speed known", format: "percent" },
          { field: "fast_fraction_of_known", label: "Fast share known", format: "percent" },
        ],
      },
      {
        id: "provider_epoch_table",
        title: "Local versus provider daily-token totals by policy epoch",
        subtitle: "Coverage diagnostic only; historical local rows can span two user accounts and are not allocated to the current provider account.",
        dataset: "provider_epochs",
        sourceId: "provider_crosscheck",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "start_date", direction: "asc" },
        columns: [
          { field: "epoch", label: "Epoch", type: "text" },
          { field: "start_date", label: "Start", type: "text" },
          { field: "end_date", label: "End", type: "text" },
          { field: "comparable_days", label: "Days", format: "number" },
          { field: "local_to_provider_token_ratio", label: "Local/provider ratio", format: "number" },
          { field: "local_api_priced_usd", label: "Local API equivalent", format: "currency" },
          { field: "provider_only_days", label: "Provider-only days", format: "number" },
        ],
      },
      {
        id: "experiment_table",
        title: "Controlled-experiment outcome ledger",
        subtitle: "All attempts retained; refused and contaminated outcomes are not converted into model multipliers.",
        dataset: "experiment_status",
        sourceId: "experiment_results",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "status", direction: "asc" },
        columns: [
          { field: "status", label: "Outcome", type: "text" },
          { field: "attempts", label: "Attempts", format: "number" },
          { field: "controlled_results", label: "Controlled", format: "number" },
          { field: "unknown_results", label: "Contaminated/unknown", format: "number" },
          { field: "stop_reasons", label: "Retained stop reasons", type: "text" },
        ],
      },
      {
        id: "high_error_surface_table",
        title: "Local surface mix in the two highest-error reset spans",
        subtitle: "Replay-safe local receipts only; shares exclude unlogged Work, Workspace Agent, Excel, Codex Cloud, and other-device Codex activity. Ordinary Chat is outside this pool.",
        dataset: "high_error_surfaces",
        sourceId: "high_error_audit",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "first_observed_date", direction: "asc" },
        columns: [
          { field: "first_observed_date", label: "Reset first seen", type: "text" },
          { field: "surface", label: "Local surface", type: "text" },
          { field: "events", label: "Events", format: "number" },
          { field: "event_share", label: "Event share", format: "percent" },
          { field: "total_tokens", label: "Tokens", format: "number" },
          { field: "token_share", label: "Token share", format: "percent" },
          { field: "standard_api_priced_usd", label: "API equivalent", format: "currency" },
          { field: "cost_share", label: "Cost share", format: "percent" },
        ],
      },
      {
        id: "candidate_table",
        title: "Accounting-basis validation scores",
        subtitle: "Chronological holdout and in-sample errors; selection uses median reset MAE with pooled MAE as the tiebreaker.",
        dataset: "candidates",
        sourceId: "weekly_calibration",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "pooled_holdout_mae_pp", direction: "asc" },
        columns: [
          { field: "accounting_basis", label: "Accounting basis", type: "text" },
          { field: "selected", label: "Status", type: "text" },
          { field: "qualifying_resets", label: "Resets", format: "number" },
          { field: "holdout_points", label: "Holdout points", format: "number" },
          { field: "median_reset_holdout_mae_pp", label: "Median reset MAE (pp)", format: "number" },
          { field: "pooled_holdout_mae_pp", label: "Pooled MAE (pp)", format: "number" },
          { field: "pooled_holdout_bias_pp", label: "Pooled bias (pp)", format: "number", semantic: "movement" },
          { field: "median_in_sample_mae_pp", label: "Median in-sample MAE (pp)", format: "number" },
        ],
      },
      {
        id: "weekly_table",
        title: "Reset-by-reset seven-day value and prediction quality",
        subtitle: "Exact UTC reset windows; full-fit value, pairwise sensitivity, chronological holdout, prior-reset forecast, and speed coverage.",
        dataset: "weekly_values",
        sourceId: "weekly_calibration",
        density: "dense",
        layout: "full",
        defaultSort: { field: "first_observed_at", direction: "asc" },
        columns: [
          { field: "first_observed_at", label: "First observed (UTC)", type: "datetime" },
          { field: "reset_due_at", label: "Reset due (UTC)", type: "datetime" },
          { field: "slot", label: "Slot", type: "text" },
          { field: "displayed_span_pp", label: "Span (pp)", format: "number" },
          { field: "value_usd", label: "7-day value", format: "currency" },
          { field: "pairwise_p10_usd", label: "Pairwise p10", format: "currency" },
          { field: "pairwise_p90_usd", label: "Pairwise p90", format: "currency" },
          { field: "holdout_observed_movement_pp", label: "Measured later move (pp)", format: "number" },
          { field: "holdout_predicted_movement_pp", label: "Calculated later move (pp)", format: "number" },
          { field: "holdout_mae_pp", label: "Holdout MAE (pp)", format: "number" },
          { field: "prior_forecast_value_usd", label: "Prior forecast value", format: "currency" },
          { field: "prior_prediction_mae_pp", label: "Prior-reset MAE (pp)", format: "number" },
          { field: "known_speed_fraction", label: "Speed known", format: "percent" },
        ],
      },
    ],
    sources: [
      { id: "weekly_calibration", label: "Local seven-day calibration result", path: ".usage-monitor/weekly-calibration-v0.2.json" },
      { id: "historical_transitions", label: "Replay-safe historical transition ledger", path: ".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json" },
      { id: "calibration_code", label: "Calibration implementation", path: "src/weekly-calibration.js" },
      { id: "calibration_goal", label: "Calibration goal and completion criteria", path: "2026-07-24-weekly-7-day-calibration-goal.md" },
      { id: "provider_crosscheck", label: "Account-level provider daily-token cross-check", path: ".usage-monitor/provider-crosscheck-v0.1.json" },
      { id: "experiment_results", label: "Controlled experiment result ledger", path: ".usage-monitor/experiment-results.jsonl" },
      { id: "high_error_audit", label: "Privacy-safe high-error reset surface audit", path: ".usage-monitor/weekly-calibration-high-error-audit-v0.1.json" },
      { id: "accuracy_floor_decision", label: "Accuracy-floor decision record", path: "2026-07-24-usage-accuracy-floor-decision.md" },
      { id: "agentic_pool_policy", label: "OpenAI Codex pricing and usage-limit policy", href: "https://learn.chatgpt.com/docs/pricing" },
    ],
    filters: [],
  },
  snapshot: {
    version: 1,
    status: "ready",
    generatedAt,
    accessIssues: [],
    datasets: {
      summary: summaryRows,
      candidates: candidateRows,
      weekly_values: weeklyRows,
      value_series: valueSeries,
      holdout_series: holdoutSeries,
      error_concentration: errorRows,
      lag_candidates: lagRows,
      forecast_candidates: forecastRows,
      online_checkpoints: checkpointRows,
      provider_epochs: providerEpochRows,
      experiment_status: experimentStatusCounts,
      high_error_surfaces: highErrorSurfaceRows,
    },
  },
  sources: [
    {
      id: "weekly_calibration",
      query: {
        engine: "node",
        language: "javascript",
        id: "weekly-calibration-v0.2",
        sql: "SELECT accounting_basis, reset_identity, first_observed_at, full_fit_value_usd, pairwise_p10_usd, pairwise_p90_usd, holdout_mae_pp, prior_reset_mae_pp FROM weekly_quota_cost_calibration ORDER BY first_observed_at",
        description: "Builds stable reset-level values and chronological validation scores from the replay-safe local transition ledger.",
        executed_at: calibration.materializedAt,
        tables_used: [
          ".usage-monitor/weekly-calibration-v0.2.json",
          ".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json",
        ],
        filters: [
          "limitId=codex",
          "windowDurationMins=10080",
          "monotonic displayed increases only",
          "complete elapsed local coverage",
          "no pricing or attribution warning",
          "pairwise central-80 relative width <= 1",
          "near-duplicate reset tolerance <= 2 seconds within account/plan partition",
        ],
        metric_definitions: {
          api_price_equivalent_value_usd: "100 times the median pairwise cumulative selected-cost change divided by displayed percentage-point change within one reset.",
          chronological_holdout_mae_pp: "Mean absolute displayed-percentage error on the later 30% of unique boundaries after fitting the earlier 70% in the same reset.",
          prior_reset_mae_pp: "Mean absolute displayed-percentage error using the median value of up to three earlier completed qualifying resets in the same continuity track.",
          speed_lower: "Standard API price for unknown/Standard events and captured model-specific Fast subscription weighting only for events observed as Fast.",
        },
        chart_qa_notes: [
          "The reset-value line has 14 temporal points and retains exact lookup fields in the table; p10/p90 are labelled sensitivity rather than confidence bounds.",
          "Measured-versus-calculated uses the same reset grain and unit for both series.",
          "Candidate comparison is a zero-based single-series bar with no redundant color legend.",
          "The two line charts are retained for distinct questions: temporal value stability and within-reset prediction agreement.",
        ],
      },
    },
    {
      id: "historical_transitions",
      query: {
        engine: "node",
        language: "javascript",
        id: "historical-transition-ledger-v0.3.2",
        sql: "SELECT * FROM adjacent_quota_transitions WHERE window_duration_mins = 10080 AND limit_id = 'codex' ORDER BY event_time",
        description: "Privacy-minimized local cumulative token-cost and provider-displayed quota transitions.",
        executed_at: calibration.source.endAt,
        tables_used: [".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json"],
      },
    },
    { id: "calibration_code", path: "src/weekly-calibration.js", description: "Reusable model selection, robust fitting, quality gates, and no-look-ahead validation implementation." },
    { id: "calibration_goal", path: "2026-07-24-weekly-7-day-calibration-goal.md", description: "Dated implementation objective and completion criteria." },
    {
      id: "provider_crosscheck",
      query: {
        engine: "node",
        language: "javascript",
        id: "provider-crosscheck-v0.1",
        sql: "SELECT epoch_id, start_date, end_date, official_days, local_to_official_ratio, local_api_priced_usd, provider_only_days FROM provider_crosscheck_policy_epochs ORDER BY start_date",
        description: "Account-level official daily token totals grouped into documented or hypothesized product-policy epochs.",
        executed_at: providerCrosscheck.analyzedAt,
        tables_used: [".usage-monitor/provider-crosscheck-v0.1.json"],
      },
    },
    {
      id: "experiment_results",
      query: {
        engine: "node",
        language: "javascript",
        id: "controlled-experiment-ledger-v0.3",
        sql: "SELECT status, COUNT(*) AS attempts, SUM(controlled_state = 'controlled') AS controlled_results, SUM(controlled_state = 'unknown') AS unknown_results FROM experiment_results GROUP BY status ORDER BY status",
        description: "Counts append-only controlled workload outcomes without converting refused or contaminated runs into multipliers.",
        executed_at: calibration.materializedAt,
        tables_used: [".usage-monitor/experiment-results.jsonl"],
      },
    },
    {
      id: "high_error_audit",
      query: {
        engine: "node",
        language: "javascript",
        id: "weekly-calibration-high-error-audit-v0.1",
        sql: "SELECT week_label, local_surface, events, event_share, total_tokens, token_share, standard_api_priced_usd, cost_share FROM high_error_reset_surface_audit ORDER BY week_label, local_surface",
        description: "Rescans only the two largest-error reset spans through the replay-safe local surface classifier.",
        executed_at: highErrorAudit.generatedAt,
        tables_used: [".usage-monitor/weekly-calibration-high-error-audit-v0.1.json"],
      },
    },
    { id: "accuracy_floor_decision", path: "2026-07-24-usage-accuracy-floor-decision.md", description: "Requirement-by-requirement stopping decision, empirical uncertainty, validation receipt, and prospective reopen trigger." },
    {
      id: "agentic_pool_policy",
      label: "OpenAI Codex pricing and usage-limit policy",
      href: "https://learn.chatgpt.com/docs/pricing",
      query: {
        engine: "web",
        language: "html",
        id: "openai-codex-pricing-2026-07-24",
        description: "Official coupling, image-generation, Voice, Spark, speed, and visible-limit policy checked on July 24, 2026.",
        executed_at: generatedAt,
      },
    },
  ],
};

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({ outputPath, generatedAt, charts: artifact.manifest.charts.length, tables: artifact.manifest.tables.length }, null, 2)}\n`);
