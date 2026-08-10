#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeFastDiagnostic,
  analyzeSimpleQuotaGradient,
  summarizeSlotSemantics,
} from "./simple-quota-gradient.js";
import {
  localLegacyReportPath,
  writeLocalLegacyReport,
} from "./local-legacy-report-storage.js";

const root = process.cwd();
const recentPath = resolve(root, ".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json");
const historyPath = resolve(root, ".usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json");
const historyTransitionsPath = resolve(root, ".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json");
const fastDiagnosticPath = resolve(root, ".usage-monitor/transitions-fast-diagnostic-2026-07-13-v0.3.2.json");
const rollingHistoryPath = resolve(root, ".usage-monitor/rolling-quota-history-2026-06-11-to-2026-07-24-v0.1.json");
const outputPath = localLegacyReportPath(root, "2026-07-24-simple-quota-gradient-artifact.json");

const recent = JSON.parse(await readFile(recentPath, "utf8"));
const history = JSON.parse(await readFile(historyPath, "utf8"));
const historyTransitions = JSON.parse(await readFile(historyTransitionsPath, "utf8"));
const fastDiagnostic = JSON.parse(await readFile(fastDiagnosticPath, "utf8"));
const rollingHistory = JSON.parse(await readFile(rollingHistoryPath, "utf8"));
const analysis = analyzeSimpleQuotaGradient(recent, history, { smoothingHours: 3 });
const slotSemantics = summarizeSlotSemantics(historyTransitions);
const fastAnalysis = analyzeFastDiagnostic(fastDiagnostic);
const oneHourDiagnostic = fastAnalysis.windowDiagnostics.find((row) => row.window_hours === 1);
const twoHourDiagnostic = fastAnalysis.windowDiagnostics.find((row) => row.window_hours === 2);
const threeHourDiagnostic = fastAnalysis.windowDiagnostics.find((row) => row.window_hours === 3);
const currentRollingDetail = [...new Set(analysis.datasets.rolling.map((row) => row.timestamp))].map((timestamp) => {
  const rows = analysis.datasets.rolling.filter((row) => row.timestamp === timestamp);
  const observed = rows.find((row) => row.series === "Observed quota change");
  const expected = rows.find((row) => row.series === "Expected from API cost");
  return {
    window_end_eastern: observed?.window_end_eastern_label ?? null,
    window_end_utc: observed?.window_end_utc_label ?? null,
    observed_quota_change_pp: observed?.quota_change_pp ?? null,
    expected_quota_change_pp: expected?.quota_change_pp ?? null,
    residual_pp: Number.isFinite(observed?.quota_change_pp) && Number.isFinite(expected?.quota_change_pp)
      ? observed.quota_change_pp - expected.quota_change_pp
      : null,
    rolling_api_cost_usd: observed?.rolling_api_cost_usd ?? null,
    usage_events: observed?.rolling_event_count ?? null,
  };
});
const fastTwoHourChart = fastAnalysis.windowRowsByHours[2].flatMap((row) => {
  const shared = {
    timestamp: row.window_end_utc,
    window_end_utc_label: row.window_end_utc_label,
    window_end_eastern_label: row.window_end_eastern_label,
    api_cost_usd: row.api_cost_usd,
    tier_weighted_cost_usd: row.tier_weighted_cost_usd,
    usage_events: row.usage_events,
    fast_events: row.fast_events,
  };
  return [
    { ...shared, series: "Observed quota change", quota_change_pp: row.observed_quota_change_pp },
    { ...shared, series: "Expected if all Standard", quota_change_pp: row.raw_expected_quota_change_pp },
    { ...shared, series: `Expected with captured Fast ${fastAnalysis.fastMultiplier}x`, quota_change_pp: row.weighted_expected_quota_change_pp },
  ];
});
const generatedAt = new Date().toISOString();
const money = (value, digits = 0) => value.toLocaleString("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: digits,
});
const number = (value, digits = 1) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
const percentage = (value, digits = 0) => (100 * value).toLocaleString("en-US", { maximumFractionDigits: digits });
const selected = analysis.selectedReset;
const gradient = analysis.gradient;
const historySummary = analysis.history;
const resetCalendar = [
  {
    announced_at_utc: "2026-07-09T21:24:11.000Z",
    announced_at_et: "2026-07-09 5:24 PM EDT",
    event_type: "Automatic full reset",
    propagation_note: "Announced as propagating during the next hour",
    source_url: "https://x.com/thsottiaux/status/2075330198887940337",
  },
  {
    announced_at_utc: "2026-07-10T17:59:43.000Z",
    announced_at_et: "2026-07-10 1:59 PM EDT",
    event_type: "Automatic double reset",
    propagation_note: "Approximate community announcement time",
    source_url: "https://x.com/thsottiaux/status/2075641131002700120",
  },
  {
    announced_at_utc: "2026-07-11T05:54:25.000Z",
    announced_at_et: "2026-07-11 1:54 AM EDT",
    event_type: "Automatic reset",
    propagation_note: "Announced as landing during the next 30 minutes",
    source_url: "https://x.com/thsottiaux/status/2075820987833274448",
  },
  {
    announced_at_utc: "2026-07-12T21:28:59.000Z",
    announced_at_et: "2026-07-12 5:28 PM EDT",
    event_type: "Banked reset",
    propagation_note: "User-applied credit; not an automatic quota reset",
    source_url: "https://x.com/thsottiaux/status/2076418567143408112",
  },
  {
    announced_at_utc: "2026-07-13T18:29:31.000Z",
    announced_at_et: "2026-07-13 2:29 PM EDT",
    event_type: "Banked reset",
    propagation_note: "User-applied credit; after the captured Fast run",
    source_url: "https://x.com/thsottiaux/status/2076735790567338203",
  },
  {
    announced_at_utc: "2026-07-14T19:34:54.000Z",
    announced_at_et: "2026-07-14 3:34 PM EDT",
    event_type: "Automatic reset",
    propagation_note: "Announcement also said the five-hour limit was absent",
    source_url: "https://x.com/thsottiaux/status/2077114635308986427",
  },
  {
    announced_at_utc: "2026-07-16T04:14:09.000Z",
    announced_at_et: "2026-07-16 12:14 AM EDT",
    event_type: "Automatic reset",
    propagation_note: "Approximate community announcement time",
    source_url: "https://x.com/thsottiaux/status/2077607697487188198",
  },
  {
    announced_at_utc: "2026-07-18T03:28:22.000Z",
    announced_at_et: "2026-07-17 11:28 PM EDT",
    event_type: "Automatic reset",
    propagation_note: "Approximate community announcement time",
    source_url: "https://x.com/thsottiaux/status/2078320950488297917",
  },
  {
    announced_at_utc: "2026-07-21T16:47:15.000Z",
    announced_at_et: "2026-07-21 12:47 PM EDT",
    event_type: "Automatic reset",
    propagation_note: "Announced as landing during the next hour",
    source_url: "https://x.com/thsottiaux/status/2079609157934886975",
  },
];

const summary = [{
  selected_reset_at: selected.resetIdentity,
  snapshot_intervals: selected.snapshotIntervals,
  percentage_transitions: selected.transitions,
  observed_span_pp: gradient.observedSpanPp,
  capacity_usd: gradient.capacityUsd,
  lower_80_usd: gradient.central80LowerUsd,
  upper_80_usd: gradient.central80UpperUsd,
  mean_absolute_error_pp: gradient.meanAbsoluteErrorPp,
  points_within_80_band_fraction: gradient.withinCentral80BandFraction,
  usable_reset_series: historySummary.usableResetCount,
  recent_three_median_usd: historySummary.recentThreeMedianUsd,
  early_three_median_usd: historySummary.earlyThreeMedianUsd,
  early_to_recent_change: historySummary.earlyToRecentChange,
  rolling_signed_auc_pp_hours: gradient.rollingSignedAucPpHours,
  rolling_absolute_auc_pp_hours: gradient.rollingAbsoluteAucPpHours,
  rolling_peak_absolute_residual_pp: gradient.rollingPeakAbsoluteResidualPp,
  july_13_fast_events: fastAnalysis.fast.eventCounts.fast,
  july_13_fast_raw_capacity_usd: fastAnalysis.fast.rawImpliedCapacityUsd,
  july_13_fast_weighted_capacity_usd: fastAnalysis.fast.tierWeightedImpliedCapacityUsd,
  july_13_reference_capacity_usd: fastAnalysis.referenceCapacityUsd,
  july_13_one_hour_weighted_mae_pp: oneHourDiagnostic.weighted_mae_pp,
  july_13_two_hour_weighted_mae_pp: twoHourDiagnostic.weighted_mae_pp,
  july_13_three_hour_weighted_mae_pp: threeHourDiagnostic.weighted_mae_pp,
  long_history_first_at: rollingHistory.rows.find((row) => row.quota_change_pp !== null)?.timestamp ?? null,
  long_history_last_at: [...rollingHistory.rows].reverse().find((row) => row.quota_change_pp !== null)?.timestamp ?? null,
  long_history_reset_series: rollingHistory.selectedResets.length,
}];

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "The Simple Quota Gradient",
    description: "A local-only, reset-segmented comparison of Standard OpenAI API-priced usage with observed Codex quota consumption.",
    generatedAt,
    blocks: [
      {
        id: "title",
        type: "markdown",
        body: `# The Simple Quota Gradient\n\n**Technical summary.** The local line is now decomposed into its residual area, actual quota-window duration, captured Codex speed state, and approximate community reset events. In the strongest current weekly-reset series, the median pairwise gradient is **${money(gradient.capacityUsd)} of Standard API-price-equivalent usage per 100 percentage points**; the pairwise p10–p90 envelope is **${money(gradient.central80LowerUsd)}–${money(gradient.central80UpperUsd)}**. This is an empirical conversion line, not a provider-published nominal allowance.`,
      },
      {
        id: "headline_metrics",
        type: "metric-strip",
        cardIds: ["current_gradient", "current_band", "curve_error", "history_count"],
      },
      {
        id: "key_findings",
        type: "markdown",
        body: `## Key findings\n\n- **The simple method works on the retained data.** The selected anonymous reset series has ${number(selected.snapshotIntervals, 0)} adjacent snapshots and ${number(gradient.eligibleTransitions, 0)} eligible percentage transitions spanning ${number(gradient.observedSpanPp, 0)} points.\n- **The cumulative curve is the cleanest smoother.** Its mean absolute deviation from the fitted gradient is ${number(gradient.meanAbsoluteErrorPp, 2)} percentage points; ${percentage(gradient.withinCentral80BandFraction)}% of observed curve points fall inside the empirical p10–p90 pairwise envelope.\n- **The three-hour mismatch is now explicit.** Observed minus cost-implied movement has signed area ${number(gradient.rollingSignedAucPpHours, 1)} pp-hours and absolute area ${number(gradient.rollingAbsoluteAucPpHours, 1)} pp-hours. Because the windows overlap, these are descriptive residual diagnostics, not additive quota consumption.\n- **The longer view now spans six weeks.** ${number(rollingHistory.selectedResets.length, 0)} reset-specific series from June 13 through July 23 are plotted without smoothing across resets; exact UTC and Eastern endpoints are exposed in tooltips.\n- **Two hours is the useful incident zoom.** On July 13 the Fast-weighted residual MAE is ${number(twoHourDiagnostic.weighted_mae_pp, 2)} points at two hours versus ${number(threeHourDiagnostic.weighted_mae_pp, 2)} at three hours, but one-hour display timing raises it to ${number(oneHourDiagnostic.weighted_mae_pp, 2)}.\n- **Fast mode is historically visible.** On July 13 the local settings join identifies ${number(fastAnalysis.fast.eventCounts.fast, 0)} Fast events from ${fastAnalysis.fast.firstObservedAt.slice(11, 19)} to ${fastAnalysis.fast.lastObservedAt.slice(11, 19)} UTC. Raw Standard API-priced usage implies ${money(fastAnalysis.fast.rawImpliedCapacityUsd)}, but applying the captured ${fastAnalysis.fastMultiplier}x Fast weight implies ${money(fastAnalysis.fast.tierWeightedImpliedCapacityUsd)}, close to the later Standard/unknown reference of ${money(fastAnalysis.referenceCapacityUsd)}.\n- **Slot names are not quota definitions.** The retained history contains both primary/300-minute and primary/10,080-minute windows, while secondary/10,080-minute also appears. Window duration—not primary/secondary—determines five-hour versus weekly.\n- **The slope can be tracked over time.** ${number(historySummary.usableResetCount, 0)} usable reset series are retained from ${historySummary.firstObservedAt.slice(0, 10)} through ${historySummary.lastObservedAt.slice(0, 10)}; their empirical envelopes are plotted rather than collapsed into one global allowance.`,
      },
      { id: "curve", type: "chart", chartId: "curve_chart" },
      {
        id: "curve_interpretation",
        type: "markdown",
        sourceId: "local_recent",
        body: "### How to read the curve\n\nThe x-axis is percentage points consumed from the provider's weekly quota, rebased to zero at the first retained snapshot. The y-axis is cumulative local token cost under the current **Standard OpenAI API price card**. A stable straight gradient means the cost proxy tracks provider quota movement. Curvature or sustained residuals flag model, speed-tier, tool, shared-pool, or policy effects worth separating next.",
      },
      { id: "rolling", type: "chart", chartId: "rolling_chart" },
      {
        id: "rolling_interpretation",
        type: "markdown",
        sourceId: "local_recent",
        body: "### Why three hours, and what AUC means\n\nThe raw events remain minute-granular, but the remaining allowance is displayed as a whole percentage. A one-point change can therefore arrive after many zero-change observations and may lag the responsible request. The residual is **observed quota movement minus movement implied by API-priced cost**. Its signed area indicates persistent over- or under-prediction; its absolute area measures total mismatch. These pp-hour AUC values use trapezoidal integration. They are descriptive because adjacent three-hour windows overlap and should not be summed as independent quota usage.",
      },
      { id: "current_rolling_detail", type: "table", tableId: "current_rolling_detail", layout: "full" },
      {
        id: "long_rolling_heading",
        type: "markdown",
        sourceId: "local_rolling_history",
        body: `## Three-hour movement across the retained six-week history\n\nThe extended chart covers **June 13 through July 23** across ${rollingHistory.selectedResets.length} reset-specific series. Each segment uses its own locally estimated gradient and stops at its reset boundary, so the line does not treat a policy/reset change as ordinary hourly movement. The x-axis stays date-oriented at this length; hovering exposes the exact window-ending hour in both UTC and US Eastern time.`,
      },
      { id: "long_rolling", type: "chart", chartId: "long_rolling_chart" },
      {
        id: "long_rolling_interpretation",
        type: "markdown",
        sourceId: "local_rolling_history",
        body: "### How to inspect the longer chart\n\nEach point is a trailing three-hour window ending at the displayed timestamp. Gaps are deliberate: they separate reset identities or intervals that did not pass the selected diagnostic scope. Use the tooltip for exact UTC and Eastern hours, the reset-ending timestamp, the locally fitted gradient, API-priced cost, and event count. A sustained separation is more meaningful than a one-point jump because integer quota updates can arrive late.",
      },
      { id: "residual_metrics", type: "metric-strip", cardIds: ["signed_auc", "absolute_auc", "peak_residual", "fast_events"] },
      { id: "rolling_residual", type: "chart", chartId: "rolling_residual_chart" },
      {
        id: "uncertainty_explainer",
        type: "markdown",
        sourceId: "local_history",
        body: "### Median, p10, and p90—not classical error bars\n\nThe central gradient is the median of all valid within-reset pairwise slopes: 100 × change in Standard API-priced cost ÷ change in displayed quota percentage. The lower and upper lines are the 10th and 90th percentiles of those slopes. They form an empirical central-80 disagreement envelope. They are **not** a confidence interval, standard error, or probability that the true provider allowance lies inside the band; rounding, update lag, workload mix, speed state, and unobserved shared-pool activity all contribute.",
      },
      {
        id: "window_sensitivity_heading",
        type: "markdown",
        sourceId: "fast_diagnostic",
        body: `## Two hours is the better zoom; one hour is too timing-sensitive\n\nFor the July 13 Fast period, shortening from three hours to two hours changes the Fast-weighted mean absolute residual only from ${number(threeHourDiagnostic.weighted_mae_pp, 2)} to ${number(twoHourDiagnostic.weighted_mae_pp, 2)} percentage points, while localizing the discrepancy one hour more tightly. At one hour the residual rises to ${number(oneHourDiagnostic.weighted_mae_pp, 2)} points and the peak reaches ${number(oneHourDiagnostic.weighted_peak_absolute_residual_pp, 1)} points because a 12-point displayed jump lands in the 12–1 PM EDT bucket after workload accumulated across neighboring hours. The practical choice is therefore **three hours for the long historical trend, two hours for incident zoom, and one hour as an audit table rather than the headline fit**.`,
      },
      { id: "window_sensitivity_table", type: "table", tableId: "window_sensitivity_table", layout: "full" },
      { id: "fast_chart", type: "chart", chartId: "fast_chart" },
      { id: "fast_hourly_detail", type: "table", tableId: "fast_hourly_detail", layout: "full" },
      { id: "fast_table", type: "table", tableId: "fast_table", layout: "full" },
      {
        id: "fast_interpretation",
        type: "markdown",
        sourceId: "fast_diagnostic",
        body: `## July 13 Fast-mode diagnostic\n\nThe first captured Fast event is at **10:06:40 AM EDT**, about 53 minutes earlier than the remembered 11 AM start; the high-volume period begins around 11 AM. Across the captured Fast segment, weekly usage rises from ${fastAnalysis.fast.startUsedPercent}% to ${fastAnalysis.fast.endUsedPercent}% while Standard API-priced workload totals ${money(fastAnalysis.fast.rawCostUsd, 2)}. The later Standard/unknown segment provides a local ${money(fastAnalysis.referenceCapacityUsd)} reference. Applying the captured ${fastAnalysis.fastMultiplier}x relative Fast weight moves the Fast segment's implied capacity from ${money(fastAnalysis.fast.rawImpliedCapacityUsd)} to ${money(fastAnalysis.fast.tierWeightedImpliedCapacityUsd)}, within about ${percentage(Math.abs(fastAnalysis.fast.tierWeightedImpliedCapacityUsd / fastAnalysis.referenceCapacityUsd - 1), 1)}% of that reference. This makes Fast weighting the leading explanation for the apparent AUC difference in this episode; it does not prove the multiplier is invariant across policy epochs or models.`,
      },
      { id: "slot_table", type: "table", tableId: "slot_table", layout: "full" },
      {
        id: "slot_explainer",
        type: "markdown",
        sourceId: "local_slot_history",
        body: "## What primary and secondary mean\n\nThey are positional keys in the provider payload, not semantic names. Interpret each record using `windowDurationMins`: **300 = five hours** and **10,080 = seven days**. The local history shows the weekly window moving from `secondary` to `primary` around July 12, at the same time the five-hour window disappeared from retained observations. Code and charts must therefore group by slot *and* duration and label the user-facing series by duration.",
      },
      { id: "reset_table", type: "table", tableId: "reset_table", layout: "full" },
      {
        id: "reset_interpretation",
        type: "markdown",
        sourceId: "codex_resets",
        body: "## Approximate global reset cross-check\n\nCommunity announcements are useful external event markers, not authoritative per-account timestamps. Keep them in UTC, show Eastern time separately, and allow a ±2-hour matching window for regional propagation. Banked resets must be classified separately because they require user action. The July 13 banked-reset announcement occurred at 2:29 PM EDT—about one hour after the captured Fast run ended—and the same weekly reset identity continued afterward, so the local data show no automatic reset during that run.",
      },
      { id: "history", type: "chart", chartId: "history_chart" },
      { id: "history_table", type: "table", tableId: "history_table", layout: "full" },
      {
        id: "scope_method",
        type: "markdown",
        sourceId: "local_history",
        body: "## Scope, definitions, and method\n\n1. Price each local token-count event using Standard OpenAI API input, cached-input, output, and reasoning rates. Tool activity, model mix, and captured speed state remain attached as explanatory evidence.\n2. Align the priced event with the contemporaneous provider quota snapshot in the same rollout.\n3. Partition by provider, plan, slot, **window duration**, and reset timestamp. Never calculate a slope across a reset.\n4. Within each series, calculate pairwise cost-per-percentage-point gradients. Report the median plus the empirical 10th–90th percentile pairwise envelope.\n5. Calculate rolling residuals and their signed/absolute trapezoidal AUC, while disclosing overlapping-window dependence.\n6. Compare captured Standard/Fast states and approximate community reset events as explanatory cross-checks rather than folding them invisibly into the API price.\n\nThe API-dollar axis is a stable workload normalization, not a statement that subscription quota is literally billed in API dollars.",
      },
      {
        id: "limitations",
        type: "markdown",
        sourceId: "local_history",
        body: "## Limitations and robustness\n\n- Quota snapshots accompany nearly all retained token-count observations, not literally every user, assistant, or tool message.\n- Whole-percentage reporting creates ±0.5-point display rounding plus unknown provider update lag; pairwise ranges and rolling windows expose rather than hide this noise.\n- The p10–p90 pairwise envelope is not a confidence interval. Pairwise slopes are dependent because they reuse observations.\n- Rolling AUC is descriptive, not additive, because adjacent windows overlap. Use non-overlapping hourly or event-block residuals for causal attribution tests.\n- Shared-pool activity outside the local logs can move quota without local cost. That produces observable residuals but has no retrospective account label or guaranteed upper bound.\n- Standard API prices normalize the workload. Codex Fast, API Priority/Flex, model-specific subscription weighting, long-context rules, and provider policy changes are separate mechanisms and can alter the true conversion.\n- Community reset announcements are approximate external markers; allow propagation lag and distinguish banked credits from automatic resets.\n- Historical account identity is unnecessary when reset identities separate the series. If two accounts interleave with the same reset identity, retrospective separation is not reliable; Keychain-backed pseudonyms prevent that prospectively.\n- The unresolved brief Pro 5x period has no dates, so the July 13 plan variant remains unknown. The history begins with locally retained evidence on June 11, 2026.",
      },
      {
        id: "next_steps",
        type: "markdown",
        sourceId: "local_history",
        body: "## Recommended next steps\n\n1. Keep three hours as the stable long-history view and add two-hour incident panels when a residual spike needs tighter attribution.\n2. Use one-hour rows as an audit layer with exact UTC/Eastern endpoints; do not interpret a single integer quota jump as a per-hour charging rule.\n3. Color or facet the same curve by observed Standard/Fast state, model family, reasoning share, long-context status, and tool-heavy versus tool-light turns.\n4. Alert on slope changes only after the new reset accumulates enough span—at least eight transitions and five percentage points under the current quality gate.\n5. Capture a provider UI/app-server snapshot at account switches and reset boundaries. This is a cross-check, not a dependency of the main line.\n6. Treat unexplained quota drops as a measurable residual series; investigate included Work, Workspace Agent, Excel, Codex Cloud, scheduled-task, other-device, image-generation, and policy-change candidates only when residuals are material. Ordinary Chat is excluded; Spark remains a separate series.",
      },
      {
        id: "questions",
        type: "markdown",
        body: "## Further questions\n\n- Does the Fast multiplier remain stable across model families, reasoning levels, and policy epochs?\n- Which smoothing window best predicts the next displayed percentage change without leaking across resets?\n- Are large positive residuals synchronized with ChatGPT Work or other shared-pool surfaces?\n- Do slope shifts align with the community reset calendar, plan changes, or model migrations after allowing propagation lag?\n- When did the brief Pro 5x episode occur, and does that explain any remaining capacity regime change?",
      },
    ],
    cards: [
      {
        id: "current_gradient",
        description: "Median pairwise Standard API-price-equivalent cost for a full 100-point quota window in the selected reset series.",
        dataset: "summary",
        sourceId: "local_history",
        metrics: [{ label: "Current gradient", field: "capacity_usd", format: "currency" }],
      },
      {
        id: "current_band",
        description: "Empirical 10th–90th percentile pairwise gradient envelope within the selected reset; not a confidence interval.",
        dataset: "summary",
        sourceId: "local_history",
        metrics: [
          { label: "Pairwise p10", field: "lower_80_usd", format: "currency" },
          { label: "Pairwise p90", field: "upper_80_usd", format: "currency" },
        ],
      },
      {
        id: "curve_error",
        description: "Mean absolute deviation between observed quota consumption and the selected fitted gradient.",
        dataset: "summary",
        sourceId: "local_recent",
        metrics: [{ label: "Curve MAE (pp)", field: "mean_absolute_error_pp", format: "number" }],
      },
      {
        id: "history_count",
        description: "Reset-specific gradients passing the current transition, span, pricing, attribution, and uncertainty gates.",
        dataset: "summary",
        sourceId: "local_history",
        metrics: [{ label: "Usable reset series", field: "usable_reset_series", format: "number" }],
      },
      {
        id: "signed_auc",
        description: "Trapezoidal area of the signed three-hour rolling residual. Positive means observed quota moved more than the fitted line predicted.",
        dataset: "summary",
        sourceId: "local_recent",
        metrics: [{ label: "Signed AUC (pp·h)", field: "rolling_signed_auc_pp_hours", format: "number" }],
      },
      {
        id: "absolute_auc",
        description: "Trapezoidal area of the absolute rolling residual; descriptive because the rolling windows overlap.",
        dataset: "summary",
        sourceId: "local_recent",
        metrics: [{ label: "Absolute AUC (pp·h)", field: "rolling_absolute_auc_pp_hours", format: "number" }],
      },
      {
        id: "peak_residual",
        description: "Largest absolute gap between observed and API-cost-implied quota movement in any retained three-hour window.",
        dataset: "summary",
        sourceId: "local_recent",
        metrics: [{ label: "Peak residual (pp)", field: "rolling_peak_absolute_residual_pp", format: "number" }],
      },
      {
        id: "fast_events",
        description: "July 13 usage events joined to a nearest preceding local Fast setting within the same rollout.",
        dataset: "summary",
        sourceId: "fast_diagnostic",
        metrics: [{ label: "Captured Fast events", field: "july_13_fast_events", format: "number" }],
      },
    ],
    charts: [
      {
        id: "curve_chart",
        title: "API-priced cost as quota is consumed",
        subtitle: `Selected weekly reset ending ${selected.resetIdentity.slice(0, 16).replace("T", " ")} UTC; observed curve plus fitted median gradient.`,
        type: "line",
        dataset: "curve",
        sourceId: "local_recent",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "quota_consumed_pp", type: "quantitative", label: "Quota consumed (percentage points)", format: "number" },
          y: { field: "api_cost_usd", type: "quantitative", label: "Cumulative Standard API-price equivalent", format: "currency" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "observed_at", type: "temporal", label: "Observed at" },
            { field: "api_cost_usd", type: "quantitative", label: "API-priced cost", format: "currency" },
            { field: "quota_consumed_pp", type: "quantitative", label: "Quota consumed", format: "number" },
          ],
        },
      },
      {
        id: "rolling_chart",
        title: "Current reset: three-hour rolling quota movement",
        subtitle: "Each point is a trailing window ending at the plotted UTC timestamp; exact UTC and Eastern hours are in the tooltip and table below.",
        type: "line",
        dataset: "rolling",
        sourceId: "local_recent",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "timestamp", type: "temporal", label: "Window ending (UTC)" },
          y: { field: "quota_change_pp", type: "quantitative", label: "Quota change over three hours (pp)", format: "number" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "window_end_eastern_label", type: "nominal", label: "Window ends (Eastern)" },
            { field: "window_end_utc_label", type: "nominal", label: "Window ends (UTC)" },
            { field: "rolling_api_cost_usd", type: "quantitative", label: "Rolling API cost", format: "currency" },
            { field: "rolling_event_count", type: "quantitative", label: "Usage events", format: "number" },
          ],
        },
      },
      {
        id: "long_rolling_chart",
        title: "Three-hour rolling quota movement across retained history",
        subtitle: "June 13–July 23; reset-specific gradients and deliberate line breaks at reset boundaries. Hover for exact UTC and Eastern hours.",
        type: "line",
        dataset: "rolling_history",
        sourceId: "local_rolling_history",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "timestamp", type: "temporal", label: "Window ending (UTC)" },
          y: { field: "quota_change_pp", type: "quantitative", label: "Quota change over three hours (pp)", format: "number" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "eastern_hour", type: "nominal", label: "Window ends (Eastern)" },
            { field: "utc_hour", type: "nominal", label: "Window ends (UTC)" },
            { field: "reset_at", type: "temporal", label: "Quota reset at" },
            { field: "reset_gradient_usd", type: "quantitative", label: "Reset gradient", format: "currency" },
            { field: "rolling_api_cost_usd", type: "quantitative", label: "Rolling API cost", format: "currency" },
            { field: "rolling_event_count", type: "quantitative", label: "Usage events", format: "number" },
          ],
        },
      },
      {
        id: "rolling_residual_chart",
        title: "Three-hour rolling residual",
        subtitle: "Observed quota movement minus movement implied by the selected reset gradient; zero means the fitted line matches the rolling observation.",
        type: "line",
        dataset: "rolling_residual",
        sourceId: "local_recent",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Residual" },
        encodings: {
          x: { field: "timestamp", type: "temporal", label: "UTC hour" },
          y: { field: "residual_pp", type: "quantitative", label: "Observed minus expected (pp)", format: "number" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "observed_quota_change_pp", type: "quantitative", label: "Observed movement", format: "number" },
            { field: "expected_quota_change_pp", type: "quantitative", label: "Expected movement", format: "number" },
          ],
        },
      },
      {
        id: "fast_chart",
        title: "July 13 two-hour zoom: raw versus Fast-weighted",
        subtitle: `Each point is a trailing two-hour window ending in Eastern time; expected movement uses the later ${money(fastAnalysis.referenceCapacityUsd)} reference and Fast is weighted ${fastAnalysis.fastMultiplier}x only where captured.`,
        type: "line",
        dataset: "fast_two_hour",
        sourceId: "fast_diagnostic",
        valueFormat: "number",
        legend: { position: "bottom", interactive: true, title: "Series" },
        encodings: {
          x: { field: "window_end_eastern_label", type: "nominal", label: "Window ending (US Eastern)" },
          y: { field: "quota_change_pp", type: "quantitative", label: "Quota change over two hours (pp)", format: "number" },
          color: { field: "series", type: "nominal", label: "Series" },
          tooltip: [
            { field: "window_end_utc_label", type: "nominal", label: "Window ends (UTC)" },
            { field: "api_cost_usd", type: "quantitative", label: "Standard API-priced cost", format: "currency" },
            { field: "tier_weighted_cost_usd", type: "quantitative", label: "Tier-weighted equivalent", format: "currency" },
            { field: "fast_events", type: "quantitative", label: "Fast events", format: "number" },
            { field: "usage_events", type: "quantitative", label: "All usage events", format: "number" },
          ],
        },
      },
      {
        id: "history_chart",
        title: "Median gradient and pairwise p10–p90 envelope by reset series",
        subtitle: `${historySummary.usableResetCount} anonymous reset series; each point is estimated independently and the envelope is not a confidence interval.`,
        type: "line",
        dataset: "reset_trend",
        sourceId: "local_history",
        valueFormat: "currency",
        legend: { position: "bottom", interactive: true, title: "Estimate" },
        encodings: {
          x: { field: "first_observed_at", type: "temporal", label: "First observed at" },
          y: { field: "capacity_usd", type: "quantitative", label: "API-price equivalent per 100 points", format: "currency" },
          color: { field: "series", type: "nominal", label: "Estimate" },
          tooltip: [
            { field: "reset_at", type: "temporal", label: "Reset at" },
            { field: "eligible_transitions", type: "quantitative", label: "Eligible transitions", format: "number" },
            { field: "observed_span_pp", type: "quantitative", label: "Observed span", format: "number" },
          ],
        },
      },
    ],
    tables: [
      {
        id: "current_rolling_detail",
        title: "Current-reset three-hour windows with exact hours",
        subtitle: "One row per window, ending time shown in both US Eastern and UTC; newest window first.",
        dataset: "current_rolling_detail",
        sourceId: "local_recent",
        density: "dense",
        layout: "full",
        defaultSort: { field: "window_end_utc", direction: "desc" },
        columns: [
          { field: "window_end_eastern", label: "Window ends (Eastern)", type: "text" },
          { field: "window_end_utc", label: "Window ends (UTC)", type: "text" },
          { field: "observed_quota_change_pp", label: "Observed change (pp)", format: "number" },
          { field: "expected_quota_change_pp", label: "Cost-implied change (pp)", format: "number" },
          { field: "residual_pp", label: "Residual (pp)", format: "number", movement: true },
          { field: "rolling_api_cost_usd", label: "API-priced cost", format: "currency" },
          { field: "usage_events", label: "Usage events", format: "number" },
        ],
      },
      {
        id: "window_sensitivity_table",
        title: "July 13 smoothing-window sensitivity",
        subtitle: "Residuals are measured only over the captured Fast period; lower is a closer hourly timing match.",
        dataset: "window_sensitivity",
        sourceId: "fast_diagnostic",
        density: "spacious",
        layout: "full",
        defaultSort: { field: "window_hours", direction: "asc" },
        columns: [
          { field: "window_hours", label: "Trailing window (hours)", format: "number" },
          { field: "focal_points", label: "Window endpoints", format: "number" },
          { field: "raw_mae_pp", label: "Raw API-cost MAE (pp)", format: "number" },
          { field: "weighted_mae_pp", label: "Fast-weighted MAE (pp)", format: "number" },
          { field: "weighted_mae_reduction_fraction", label: "Weighting improvement", format: "percent" },
          { field: "raw_peak_absolute_residual_pp", label: "Raw peak residual (pp)", format: "number" },
          { field: "weighted_peak_absolute_residual_pp", label: "Weighted peak residual (pp)", format: "number" },
        ],
      },
      {
        id: "fast_hourly_detail",
        title: "July 13 one-hour audit detail",
        subtitle: "Exact hourly endpoint, observed movement, raw and Fast-weighted expectations, cost, and captured Fast-event count.",
        dataset: "fast_hourly_detail",
        sourceId: "fast_diagnostic",
        density: "dense",
        layout: "full",
        defaultSort: { field: "window_end_utc_label", direction: "asc" },
        columns: [
          { field: "window_end_eastern_label", label: "Hour ends (Eastern)", type: "text" },
          { field: "window_end_utc_label", label: "Hour ends (UTC)", type: "text" },
          { field: "observed_quota_change_pp", label: "Observed (pp)", format: "number" },
          { field: "raw_expected_quota_change_pp", label: "Raw expected (pp)", format: "number" },
          { field: "weighted_expected_quota_change_pp", label: "Fast-weighted expected (pp)", format: "number" },
          { field: "raw_residual_pp", label: "Raw residual (pp)", format: "number", movement: true },
          { field: "weighted_residual_pp", label: "Weighted residual (pp)", format: "number", movement: true },
          { field: "api_cost_usd", label: "API-priced cost", format: "currency" },
          { field: "fast_events", label: "Fast events", format: "number" },
        ],
      },
      {
        id: "fast_table",
        title: "July 13 captured speed segments",
        subtitle: "Raw Standard API pricing is kept separate from the captured subscription-speed weighting.",
        dataset: "fast_segments",
        sourceId: "fast_diagnostic",
        density: "dense",
        layout: "full",
        columns: [
          { field: "segment", label: "Segment", type: "text" },
          { field: "first_observed_at", label: "First observed", type: "datetime" },
          { field: "last_observed_at", label: "Last observed", type: "datetime" },
          { field: "speed_evidence", label: "Captured speed evidence", type: "text" },
          { field: "quota_change_pp", label: "Quota change (pp)", format: "number" },
          { field: "standard_api_cost_usd", label: "Standard API cost", format: "currency" },
          { field: "weighted_api_equivalent_usd", label: "Speed-weighted equivalent", format: "currency" },
          { field: "raw_implied_capacity_usd", label: "Raw implied capacity", format: "currency" },
          { field: "weighted_implied_capacity_usd", label: "Weighted implied capacity", format: "currency" },
        ],
      },
      {
        id: "slot_table",
        title: "Observed slot and duration combinations",
        subtitle: "The same slot name can refer to different durations across provider epochs.",
        dataset: "slot_semantics",
        sourceId: "local_slot_history",
        density: "dense",
        layout: "full",
        columns: [
          { field: "slot", label: "Provider slot", type: "text" },
          { field: "window_minutes", label: "Window minutes", format: "number" },
          { field: "window_label", label: "Window meaning", type: "text" },
          { field: "transitions", label: "Transitions", format: "number" },
          { field: "first_observed_at", label: "First observed", type: "datetime" },
          { field: "last_observed_at", label: "Last observed", type: "datetime" },
        ],
      },
      {
        id: "reset_table",
        title: "Community reset announcements near the retained history",
        subtitle: "UTC is canonical; Eastern time is supplied for interpretation. Allow up to two hours of propagation uncertainty.",
        dataset: "reset_calendar",
        sourceId: "codex_resets",
        density: "dense",
        layout: "full",
        defaultSort: { field: "announced_at_utc", direction: "desc" },
        columns: [
          { field: "announced_at_utc", label: "Announcement UTC", type: "datetime" },
          { field: "announced_at_et", label: "US Eastern", type: "text" },
          { field: "event_type", label: "Event type", type: "text" },
          { field: "propagation_note", label: "Interpretation", type: "text" },
          { field: "source_url", label: "Source", type: "url" },
        ],
      },
      {
        id: "history_table",
        title: "Reset-specific gradient estimates",
        subtitle: "Exact median estimates and within-series 10th–90th percentile pairwise envelopes; these are not confidence intervals.",
        dataset: "reset_table",
        sourceId: "local_history",
        density: "dense",
        layout: "full",
        defaultSort: { field: "first_observed_at", direction: "desc" },
        columns: [
          { field: "first_observed_at", label: "First observed", type: "datetime" },
          { field: "reset_at", label: "Reset at", type: "datetime" },
          { field: "slot", label: "Slot", type: "text" },
          { field: "capacity_usd", label: "Median pairwise gradient", format: "currency" },
          { field: "lower_80_usd", label: "Pairwise p10", format: "currency" },
          { field: "upper_80_usd", label: "Pairwise p90", format: "currency" },
          { field: "eligible_transitions", label: "Transitions", format: "number" },
          { field: "observed_span_pp", label: "Span (pp)", format: "number" },
        ],
      },
    ],
    sources: [
      { id: "local_recent", label: "Recent local transition ledger", path: ".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json" },
      { id: "local_history", label: "Reset-specific local gradient diagnostics", path: ".usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json" },
      { id: "local_slot_history", label: "Historical local slot/window ledger", path: ".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json" },
      { id: "fast_diagnostic", label: "July 13 local Fast-mode diagnostic", path: ".usage-monitor/transitions-fast-diagnostic-2026-07-13-v0.3.2.json" },
      { id: "local_rolling_history", label: "Six-week local rolling-quota history", path: ".usage-monitor/rolling-quota-history-2026-06-11-to-2026-07-24-v0.1.json" },
      { id: "codex_resets", label: "Codex Resets community calendar and linked announcements", href: "https://codex-resets.com/" },
      { id: "openai_api_pricing", label: "OpenAI API pricing", href: "https://developers.openai.com/api/docs/pricing" },
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
      summary,
      curve: analysis.datasets.curve,
      rolling: analysis.datasets.rolling,
      current_rolling_detail: currentRollingDetail,
      rolling_history: rollingHistory.rows,
      rolling_residual: analysis.datasets.rollingResidual,
      fast_hourly: fastAnalysis.hourly,
      fast_two_hour: fastTwoHourChart,
      fast_hourly_detail: fastAnalysis.windowRowsByHours[1],
      window_sensitivity: fastAnalysis.windowDiagnostics,
      fast_segments: fastAnalysis.segmentTable,
      slot_semantics: slotSemantics,
      reset_calendar: resetCalendar,
      reset_trend: analysis.datasets.resetTrend,
      reset_table: analysis.datasets.resetTable,
    },
  },
  sources: [
    {
      id: "local_recent",
      query: {
        engine: "node",
        language: "javascript",
        id: "simple-quota-gradient-current-v0.1",
        sql: `SELECT cumulative_standard_api_cost, quota_used_percent\nFROM local_token_count_events\nJOIN contemporaneous_rate_limit_snapshots USING (rollout_event_order)\nWHERE resets_at = ${selected.resetsAt}\nORDER BY observed_at`,
        description: "Selects the dominant weekly reset identity, rebases its cumulative Standard API-price-equivalent cost and quota consumption to zero, and builds a configurable reset-safe rolling comparison.",
        executed_at: generatedAt,
        tables_used: [".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json"],
        filters: [
          `resetsAt=${selected.resetsAt}`,
          `provider=${selected.provider}`,
          `planType=${selected.planType}`,
          `slot=${selected.slot}`,
          `windowDurationMins=${10_080}`,
          "no cross-reset smoothing",
        ],
        metric_definitions: {
          api_cost_usd: "Input, cached input, output text, and reasoning tokens priced at Standard OpenAI API rates; this is a workload normalization, not subscription billing.",
          quota_consumed_pp: "Provider-reported used percentage rebased to the first retained snapshot in the selected reset series.",
          rolling_expected_quota_change: "Rolling API-priced cost divided by the selected reset gradient and multiplied by 100.",
        },
        chart_qa_notes: [
          "The cumulative curve and fit share the same axes and units; quota is the readable integer x-axis and API-priced cost is the currency-formatted y-axis.",
          "The rolling chart compares two series in percentage points and never uses a dual axis.",
          "Integer quota quantization is disclosed; no false decimal precision is attributed to the provider.",
        ],
      },
    },
    {
      id: "local_history",
      query: {
        engine: "node",
        language: "javascript",
        id: "simple-quota-gradient-history-v0.1",
        sql: "SELECT first_observed_at, reset_at, median_pairwise_gradient, p10_pairwise_gradient, p90_pairwise_gradient\nFROM reset_specific_gradient_diagnostics\nWHERE usable_diagnostic = TRUE\nORDER BY first_observed_at",
        description: "Calculates independent within-reset pairwise cost-per-percentage-point gradients and retains the median plus 10th–90th percentile envelope for each quality-qualified anonymous reset series.",
        executed_at: generatedAt,
        tables_used: [".usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json"],
        filters: [
          "weekly window only",
          "monotonic quota transitions",
          "complete elapsed coverage",
          "no pricing or attribution warnings",
          "minimum eight eligible transitions",
          "minimum five percentage-point span",
          "relative central-80 width no greater than one",
        ],
        metric_definitions: {
          capacity_usd: "Median of 100 times API-priced cost difference divided by displayed percentage-point difference across valid boundary pairs within one reset series.",
          lower_80_usd: "10th percentile of valid within-reset pairwise gradients.",
          upper_80_usd: "90th percentile of valid within-reset pairwise gradients.",
        },
      },
    },
    {
      id: "local_slot_history",
      query: {
        engine: "node",
        language: "javascript",
        id: "slot-window-semantics-v0.1",
        sql: "SELECT slot, window_duration_mins, COUNT(*), MIN(event_time), MAX(event_time)\nFROM local_transition_history\nGROUP BY slot, window_duration_mins",
        description: "Groups local transition records by the provider's positional slot and actual duration so five-hour and weekly windows are never inferred from slot names.",
        executed_at: generatedAt,
        tables_used: [".usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json"],
      },
    },
    {
      id: "local_rolling_history",
      query: {
        engine: "node",
        language: "javascript",
        id: "rolling-quota-history-v0.1",
        sql: "SELECT window_end_utc, window_end_eastern, reset_at, reset_gradient_usd,\n       observed_quota_change_pp, cost_implied_quota_change_pp,\n       rolling_api_cost_usd, rolling_event_count\nFROM adjacent_weekly_snapshot_intervals\nJOIN reset_specific_gradient_diagnostics USING (slot, window_duration_mins, resets_at)\nWHERE window_duration_mins = 10080\n  AND smoothing_hours = 3\nORDER BY window_end_utc",
        description: "Scans the retained weekly adjacent-snapshot intervals, retains quality-qualified reset identities plus the July 13 diagnostic episode, aggregates trailing three-hour windows independently inside each reset, and attaches exact UTC/Eastern endpoint labels.",
        executed_at: rollingHistory.materializedAt,
        tables_used: [
          ".usage-monitor/rolling-quota-history-2026-06-11-to-2026-07-24-v0.1.json",
          ".usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json",
        ],
        filters: [
          "windowDurationMins=10080",
          "smoothingHours=3",
          "no rolling window crosses a reset identity",
          "quality-qualified reset diagnostics plus the July 13 diagnostic episode",
        ],
        metric_definitions: {
          observed_quota_change_pp: "Monotonic provider-displayed used-percentage movement across one trailing three-hour window.",
          cost_implied_quota_change_pp: "Standard API-priced cost in the same window divided by that reset identity's median pairwise gradient and multiplied by 100.",
        },
      },
    },
    {
      id: "fast_diagnostic",
      query: {
        engine: "node",
        language: "javascript",
        id: "july-13-fast-diagnostic-v0.1",
        sql: "SELECT event_time, marginal_api_priced_usd, prior_used_percent, next_used_percent, tier_usage_event_counts\nFROM local_snapshot_intervals\nWHERE event_time >= '2026-07-13T13:00:00Z' AND event_time < '2026-07-14T00:00:00Z'\n  AND window_duration_mins = 10080\nORDER BY event_time",
        description: "Joins each local usage event to the nearest preceding privacy-safe thread speed setting within the same rollout, then compares a captured Fast segment with a later Standard/unknown reference segment.",
        executed_at: generatedAt,
        tables_used: [".usage-monitor/transitions-fast-diagnostic-2026-07-13-v0.3.2.json"],
        metric_definitions: {
          fast_weighted_equivalent: `Standard API-priced cost multiplied by ${fastAnalysis.fastMultiplier} only where the joined Codex speed state is Fast; this is a subscription quota sensitivity, not API Priority pricing.`,
          implied_capacity: "Segment API-price equivalent divided by displayed quota-point movement and multiplied by 100.",
        },
      },
    },
    {
      id: "codex_resets",
      href: "https://codex-resets.com/",
      retrievedAt: generatedAt,
      description: "Third-party calendar of approximate global Codex reset announcements. Exact UTC post times are derived from the linked X status IDs; banked resets are classified separately from automatic resets.",
      query: {
        engine: "node",
        language: "sql",
        id: "codex-reset-calendar-v0.1",
        sql: "SELECT announced_at_utc, announced_at_et, event_type, propagation_note, source_url\nFROM verified_community_reset_announcements\nWHERE announced_at_utc >= '2026-07-09T00:00:00Z'\nORDER BY announced_at_utc",
        description: "Selects the linked community announcements inspected for the report, derives UTC from the X status ID, converts to Eastern time, and classifies banked versus automatic events from the announcement text.",
        executed_at: generatedAt,
        tables_used: ["https://codex-resets.com/", "linked X status posts"],
      },
    },
    {
      id: "openai_api_pricing",
      href: "https://developers.openai.com/api/docs/pricing",
      retrievedAt: "2026-07-23T00:00:00.000Z",
      description: "Official API price tables used for the independent Standard price normalization.",
    },
    {
      id: "agentic_pool_policy",
      label: "OpenAI Codex pricing and usage-limit policy",
      href: "https://learn.chatgpt.com/docs/pricing",
      query: {
        engine: "web",
        language: "html",
        id: "openai-codex-pricing-2026-07-24",
        description: "Official included, excluded, mixed, and separate usage-limit policy checked on July 24, 2026.",
        executed_at: generatedAt,
      },
    },
  ],
};

await writeLocalLegacyReport(root, "2026-07-24-simple-quota-gradient-artifact.json", `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, generatedAt, selectedReset: selected, gradient, history: historySummary }, null, 2)}\n`);
