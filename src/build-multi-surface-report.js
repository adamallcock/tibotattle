#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const artifactPath = resolve(root, "artifact.json");
const crosscheckPath = resolve(root, ".usage-monitor/provider-crosscheck-v0.1.json");
const planPath = resolve(root, ".usage-monitor/account-plan-timeline-v0.1.json");

const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const crosscheck = JSON.parse(await readFile(crosscheckPath, "utf8"));
const planTimeline = JSON.parse(await readFile(planPath, "utf8"));

const extensionIds = new Set([
  "account_surface_metrics",
  "account_surface_extension",
  "daily_provider_coverage_context",
  "daily_provider_coverage",
  "coverage_gaps",
  "task_surface_context",
  "surface_cost_share",
  "surface_coverage",
  "work_provider_context",
  "provider_ui_comparison",
  "policy_epoch_context",
  "policy_epoch_coverage",
  "plan_account_context",
  "learning_loop",
]);
const cardIds = new Set(["ui_remaining", "lifetime_ratio", "post_work_ratio", "scheduled_rollouts"]);
const chartIds = new Set(["daily_provider_coverage_chart", "surface_cost_chart", "policy_epoch_chart"]);
const tableIds = new Set(["surface_coverage_table", "provider_ui_table", "coverage_gaps_table"]);
const sourceIds = new Set([
  "provider_crosscheck",
  "provider_ui_usage",
  "account_plan_timeline",
  "openai_work_codex",
  "openai_enterprise_analytics",
  "openai_codex_plan_guidance",
]);

artifact.manifest.blocks = artifact.manifest.blocks.filter((item) => !extensionIds.has(item.id));
artifact.manifest.cards = artifact.manifest.cards.filter((item) => !cardIds.has(item.id));
artifact.manifest.charts = artifact.manifest.charts.filter((item) => !chartIds.has(item.id));
artifact.manifest.tables = artifact.manifest.tables.filter((item) => !tableIds.has(item.id));
artifact.manifest.sources = artifact.manifest.sources.filter((item) => !sourceIds.has(item.id));
artifact.sources = artifact.sources.filter((item) => !sourceIds.has(item.id));
for (const dataset of ["account_summary", "daily_provider_coverage", "coverage_gaps", "surface_coverage", "policy_epoch_coverage", "provider_ui_comparison"]) {
  delete artifact.snapshot.datasets[dataset];
}

const round = (value, places = 6) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

const currentProfile = planTimeline.profiles.find((profile) => profile.scopeId === crosscheck.scope.accountScope.scopeId) ?? null;
const currentUi = crosscheck.provider.uiObservations.at(-1) ?? null;
const uiData = currentUi ?? {
  capturedAt: null,
  weekly: { remainingPercent: null, resetsAt: null },
  turnsByModelTotal: null,
  turnsBySurfaceTotal: null,
  surfaceCategories: [],
  workSharedPoolTextObserved: false,
};
const uiVsApp = crosscheck.comparisons.uiVsAppServer.at(-1) ?? {};
const postWorkEpoch = crosscheck.comparisons.byPolicyEpoch.find((row) => row.epochId === "chatgpt-work-launch");
const continuityEpoch = crosscheck.comparisons.byPolicyEpoch.find((row) => row.epochId === "work-cross-device-continuity");
const visibilityEpoch = crosscheck.comparisons.byPolicyEpoch.find((row) => row.epochId === "codex-profile-usage-visibility");
const local = crosscheck.local;
const totalCost = local.totalApiPricedUsd;
const totalTokens = local.totalTokens;
const number = (value, maximumFractionDigits = 2) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumFractionDigits })
  : "unavailable";
const money = (value) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
  : "unavailable";
const weeklySummary = artifact.snapshot.datasets.summary?.[0] ?? {};
const scheduled = local.bySurface.scheduled_task ?? {};
const subagent = local.bySurface.subagent ?? {};
const providerCategories = (uiData.surfaceCategories ?? []).map((value) => value.replaceAll("_", " ")).join(", ");
const retainedDayCount = crosscheck.comparisons.daily.length;

const accountSummary = [{
  current_scope_status: crosscheck.scope.accountScope.status,
  current_scope_alias: currentProfile?.alias ?? "unassigned",
  provider_plan_type: crosscheck.scope.providerPlanType,
  assumed_plan_variant: currentProfile?.defaultPlanVariant ?? "unknown",
  unresolved_plan_episodes: planTimeline.unresolvedEpisodes.length,
  historical_account_attribution: "unavailable",
  local_tokens: local.totalTokens,
  current_account_provider_lifetime_tokens: crosscheck.provider.officialUsageSummary?.lifetimeTokens ?? null,
  local_to_current_account_lifetime_ratio: crosscheck.comparisons.accountCompatibility.localToProviderLifetimeRatio,
  ui_weekly_remaining_percent: uiData.weekly?.remainingPercent ?? null,
  app_server_weekly_remaining_percent: Number.isFinite(crosscheck.provider.canonicalWeeklyWindow?.usedPercent)
    ? 100 - crosscheck.provider.canonicalWeeklyWindow.usedPercent
    : null,
  prospective_account_scoped_status: crosscheck.comparisons.prospectiveAccountScoped?.status ?? "unavailable",
  prospective_account_scoped_events: crosscheck.comparisons.prospectiveAccountScoped?.eventCount ?? 0,
  prospective_account_scoped_tokens: crosscheck.comparisons.prospectiveAccountScoped?.totalTokens ?? 0,
  local_cache_validation_status: crosscheck.local.cacheValidation?.status ?? "unspecified",
  captured_at: crosscheck.provider.capturedAt,
}];

const surfaceLabels = {
  extension_or_ide: "Desktop / extension / IDE",
  subagent: "Subagent",
  scheduled_task: "Scheduled task",
  cli_exec: "CLI exec",
};
const surfaceCoverage = Object.entries(local.bySurface).map(([surface, row]) => ({
  surface: surfaceLabels[surface] ?? surface,
  surface_key: surface,
  rollouts: local.rolloutsBySurface[surface] ?? 0,
  usage_events: row.events,
  total_tokens: row.totalTokens,
  token_share: round(row.totalTokens / totalTokens),
  standard_api_equivalent_usd: round(row.totalUsd, 2),
  cost_share: round(row.totalUsd / totalCost),
  standard_events: row.speedModeCounts?.standard ?? 0,
  fast_events: row.speedModeCounts?.fast ?? 0,
  unknown_speed_events: row.speedModeCounts?.unknown ?? 0,
}));

const dailyProviderCoverage = crosscheck.comparisons.daily
  .filter((row) => row.officialTokens !== null)
  .flatMap((row) => [
    {
      date: row.date,
      series: "Replay-safe local",
      tokens: row.localTokens,
      local_to_official_ratio: row.localToOfficialRatio,
      local_api_priced_usd: row.localApiPricedUsd,
      classification: row.classification,
      plan_variant: row.plan?.planVariant ?? "unknown",
      policy_epoch: row.policyEpoch?.id ?? "unknown",
    },
    {
      date: row.date,
      series: "Official account bucket",
      tokens: row.officialTokens,
      local_to_official_ratio: row.localToOfficialRatio,
      local_api_priced_usd: row.localApiPricedUsd,
      classification: row.classification,
      plan_variant: row.plan?.planVariant ?? "unknown",
      policy_epoch: row.policyEpoch?.id ?? "unknown",
    },
  ]);
const coverageGaps = crosscheck.comparisons.daily
  .filter((row) => row.officialTokens === null)
  .map((row) => ({
    date: row.date,
    local_tokens: row.localTokens,
    local_usage_events: row.localUsageEvents,
    local_api_priced_usd: row.localApiPricedUsd,
    classification: row.classification,
    policy_epoch: row.policyEpoch?.id ?? "unknown",
    account_status: "historical local account unattributed",
  }));

const epochLabels = {
  "pro-plan-restructure": "May 17–28",
  "codex-profile-usage-visibility": "May 29–Jul 8",
  "chatgpt-work-launch": "Jul 9–15",
  "work-cross-device-continuity": "Jul 16–24",
};
const policyEpochCoverage = crosscheck.comparisons.byPolicyEpoch.map((row) => ({
  epoch: epochLabels[row.epochId] ?? `${row.startDate}–${row.endDate}`,
  epoch_id: row.epochId,
  status: row.status,
  official_days: row.officialDays,
  local_tokens_all_days: row.localTokens,
  local_tokens_comparable_days: row.comparableLocalTokens,
  official_tokens: row.officialTokens,
  local_to_official_ratio: row.localToOfficialRatio,
  local_api_priced_usd_all_days: row.localApiPricedUsd,
  provider_unallocated_days: row.providerOnlyDays,
}));

const modelSurfaceGap = currentUi
  ? Math.max(0, (uiData.turnsByModelTotal ?? 0) - (uiData.turnsBySurfaceTotal ?? 0))
  : null;
const providerUiComparison = [{
  ui_captured_at: uiData.capturedAt,
  app_server_captured_at: crosscheck.provider.capturedAt,
  ui_remaining_percent: uiData.weekly?.remainingPercent ?? null,
  app_server_remaining_percent: Number.isFinite(crosscheck.provider.canonicalWeeklyWindow?.usedPercent)
    ? 100 - crosscheck.provider.canonicalWeeklyWindow.usedPercent
    : null,
  used_percentage_point_difference_ui_minus_app: uiVsApp.percentagePointDifference ?? null,
  reset_difference_seconds: uiVsApp.resetDifferenceSeconds ?? null,
  turns_by_model_total: uiData.turnsByModelTotal,
  turns_by_surface_total: uiData.turnsBySurfaceTotal,
  difference_not_attributed_to_work: modelSurfaceGap,
  visible_surface_category_count: uiData.surfaceCategories?.length ?? 0,
  explicit_work_bucket: "not exposed",
  shared_work_codex_text_observed: uiData.workSharedPoolTextObserved === true ? "yes" : "no",
}];

artifact.snapshot.datasets.account_summary = accountSummary;
artifact.snapshot.datasets.daily_provider_coverage = dailyProviderCoverage;
artifact.snapshot.datasets.coverage_gaps = coverageGaps;
artifact.snapshot.datasets.surface_coverage = surfaceCoverage;
artifact.snapshot.datasets.policy_epoch_coverage = policyEpochCoverage;
artifact.snapshot.datasets.provider_ui_comparison = providerUiComparison;

const providerSource = {
  id: "provider_crosscheck",
  query: {
    engine: "node",
    language: "javascript",
    id: "provider-local-crosscheck-v0.1",
    sql: `SELECT local_day, official_account_day, surface, policy_epoch\nFROM replay_safe_local_history\nFULL OUTER JOIN official_account_daily_usage USING (utc_date)\nWHERE utc_date BETWEEN '${crosscheck.scope.startAt.slice(0, 10)}' AND '${crosscheck.scope.endAt.slice(0, 10)}'`,
    description: "Compares replay-safe local token totals with the current account's official daily token buckets only on matching UTC dates; classifies local rollouts into low-cardinality surfaces and preserves unmatched provider activity as unallocated.",
    executed_at: crosscheck.materializedAt,
    tables_used: [
      ".usage-monitor/local-history-v0.1.json",
      ".usage-monitor/provider-crosscheck-v0.1.json",
    ],
    filters: [
      `startAt=${crosscheck.scope.startAt}`,
      `endAt=${crosscheck.scope.endAt}`,
      "fork replay excluded",
      "official epoch ratios use matched provider days only",
      "historical account scope remains unattributed",
    ],
    metric_definitions: {
      local_to_official_ratio: "Replay-safe local tokens divided by official current-account tokens on the same available UTC days. It is a coverage diagnostic, not a quota multiplier.",
      standard_api_equivalent_usd: "Input, cached input, output text, and reasoning tokens priced at current Standard OpenAI API prices, with long-context bands where applicable.",
      cost_share: "A surface's Standard API-price-equivalent cost divided by the all-surface total for the retained local interval.",
    },
    chart_qa_notes: [
      "Daily chart uses two clearly named series on one token scale.",
      "Policy-epoch bar has a 1.0 parity reference in its source data; interpretation remains descriptive because account and metric semantics are unresolved.",
      "Surface bars use the surface category on the x-axis and do not redundantly color by surface.",
    ],
  },
};
const uiSource = {
  id: "provider_ui_usage",
  label: "Authenticated visible Codex and Work Analytics UI observation",
  path: ".usage-monitor/provider-ui-observations-v0.1.jsonl",
  description: "Read-only, privacy-minimized visible UI capture: percentage/reset, date range, aggregate turn totals, surface categories, and explicit shared-pool text; no content, cookies, storage, account identifiers, or network payloads.",
  query: {
    engine: "visible_authenticated_dom",
    language: "sql",
    id: "provider-ui-usage-v0.1",
    sql: "SELECT captured_at, weekly_remaining_percent, weekly_reset_at, turns_by_model_total, turns_by_surface_total, surface_categories, shared_pool_text_observed\nFROM local_privacy_minimized_provider_ui_observations\nORDER BY captured_at DESC\nLIMIT 1",
    description: "Selects the latest privacy-minimized visible UI observation for the same pseudonymous account scope as the app-server snapshot.",
    executed_at: uiData.capturedAt ?? crosscheck.materializedAt,
    tables_used: [".usage-monitor/provider-ui-observations-v0.1.jsonl"],
    filters: ["same pseudonymous account scope", "visible aggregate fields only", "latest captured observation"],
    metric_definitions: {
      remaining_percent: "Integer percentage displayed in the authenticated Codex and Work Analytics UI at capture time.",
      difference_not_attributed_to_work: "Turns-by-model total minus turns-by-surface total; retained as unclassified and never assumed to be Work.",
    },
  },
};
const planSource = {
  id: "account_plan_timeline",
  label: "Owner-only pseudonymous plan timeline",
  path: ".usage-monitor/account-plan-timeline-v0.1.json",
  description: "User-reported normal 20x state and unresolved brief 5x episode. The provider's generic Pro label cannot distinguish the $100 and $200 variants.",
};
const officialSources = [
  {
    id: "openai_work_codex",
    href: "https://help.openai.com/en/articles/20001275/",
    retrievedAt: crosscheck.materializedAt,
    description: "Official ChatGPT Work and Codex usage-surface and shared-limit guidance.",
  },
  {
    id: "openai_enterprise_analytics",
    href: "https://learn.chatgpt.com/docs/enterprise/analytics-api",
    retrievedAt: crosscheck.materializedAt,
    description: "Official Enterprise analytics API scope; it is workspace-aggregate evidence and not a consumer Pro fine-grained usage endpoint.",
  },
  {
    id: "openai_codex_plan_guidance",
    href: "https://help.openai.com/en/articles/11369540-getting-started-with-codex",
    retrievedAt: crosscheck.materializedAt,
    description: "Official Codex plan and shared usage guidance.",
  },
];
const newSources = [providerSource, uiSource, planSource, ...officialSources];
artifact.manifest.sources.push(...newSources);
artifact.sources.push(...newSources);

artifact.manifest.cards.push(
  {
    id: "ui_remaining",
    description: "Visible provider UI value at the recorded capture time; it can change as later requests land.",
    dataset: "account_summary",
    sourceId: "provider_ui_usage",
    metrics: [{ label: "Weekly remaining at UI capture", field: "ui_weekly_remaining_percent", format: "number", unit: "%" }],
  },
  {
    id: "lifetime_ratio",
    description: "Retained local tokens divided by the current account's provider lifetime token summary; values above one reject a one-current-account interpretation under equal semantics.",
    dataset: "account_summary",
    sourceId: "provider_crosscheck",
    metrics: [{ label: "Local / current-account lifetime", field: "local_to_current_account_lifetime_ratio", format: "number", unit: "x" }],
  },
  {
    id: "post_work_ratio",
    description: "Matched-day local/provider token ratio for July 9–15; a coverage comparison, not proof of a July 9 accounting change.",
    dataset: "policy_epoch_coverage",
    filter: { epoch_id: "chatgpt-work-launch" },
    sourceId: "provider_crosscheck",
    metrics: [{ label: "Jul 9–15 local / provider", field: "local_to_official_ratio", format: "number", unit: "x" }],
  },
  {
    id: "scheduled_rollouts",
    description: "Local rollouts classified from safe session metadata as scheduled automation tasks.",
    dataset: "surface_coverage",
    filter: { surface_key: "scheduled_task" },
    sourceId: "provider_crosscheck",
    metrics: [{ label: "Scheduled-task rollouts", field: "rollouts", format: "number" }],
  },
);

artifact.manifest.charts.push(
  {
    id: "daily_provider_coverage_chart",
    title: "Daily local receipts versus official account tokens",
    subtitle: `${number(crosscheck.comparisons.comparableDayCount, 0)} matched UTC days; gaps show activity or accounting that cannot be allocated to a surface or historical account.`,
    headerMarkdown: "The two series use the same token axis. Ratios are **coverage diagnostics**, not quota conversion factors.",
    type: "line",
    dataset: "daily_provider_coverage",
    sourceId: "provider_crosscheck",
    valueFormat: "number",
    encodings: {
      x: { field: "date", type: "temporal", label: "UTC date" },
      y: { field: "tokens", type: "quantitative", label: "Tokens", format: "number" },
      color: { field: "series", type: "nominal", label: "Series" },
      tooltip: [
        { field: "local_to_official_ratio", type: "quantitative", label: "Local / official", format: "number" },
        { field: "classification", type: "nominal", label: "Coverage classification" },
        { field: "policy_epoch", type: "nominal", label: "Policy epoch" },
        { field: "plan_variant", type: "nominal", label: "Plan assumption" },
      ],
    },
  },
  {
    id: "surface_cost_chart",
    title: "Standard API-equivalent cost by local surface",
    subtitle: "The desktop/extension/IDE bucket dominates; subagents are material and scheduled tasks are small but explicitly represented.",
    type: "bar",
    dataset: "surface_coverage",
    sourceId: "provider_crosscheck",
    valueFormat: "currency",
    encodings: {
      x: { field: "surface", type: "nominal", label: "Local surface" },
      y: { field: "standard_api_equivalent_usd", type: "quantitative", label: "Standard API-equivalent cost", format: "currency" },
      tooltip: [
        { field: "rollouts", type: "quantitative", label: "Rollouts", format: "number" },
        { field: "usage_events", type: "quantitative", label: "Usage events", format: "number" },
        { field: "total_tokens", type: "quantitative", label: "Tokens", format: "number" },
        { field: "cost_share", type: "quantitative", label: "Cost share", format: "percent" },
      ],
    },
  },
  {
    id: "policy_epoch_chart",
    title: "Matched-day local/provider ratio across observed policy epochs",
    subtitle: `The unmatched-account coverage ratio is ${number(postWorkEpoch?.localToOfficialRatio, 3)} after July 9 and ${number(continuityEpoch?.localToOfficialRatio, 3)} after July 16; both breakpoints are descriptive and confounded.`,
    type: "bar",
    dataset: "policy_epoch_coverage",
    sourceId: "provider_crosscheck",
    valueFormat: "number",
    encodings: {
      x: { field: "epoch", type: "nominal", label: "Observed epoch" },
      y: { field: "local_to_official_ratio", type: "quantitative", label: "Local / official token ratio", format: "number" },
      tooltip: [
        { field: "official_days", type: "quantitative", label: "Matched official days", format: "number" },
        { field: "local_tokens_comparable_days", type: "quantitative", label: "Local tokens on matched days", format: "number" },
        { field: "official_tokens", type: "quantitative", label: "Official tokens", format: "number" },
        { field: "status", type: "nominal", label: "Boundary status" },
      ],
    },
  },
);

artifact.manifest.tables.push(
  {
    id: "surface_coverage_table",
    title: "Exact local surface coverage",
    subtitle: `Replay-safe request-like activity from ${crosscheck.scope.startAt.slice(0, 10)} through ${crosscheck.scope.endAt.slice(0, 10)} UTC.`,
    dataset: "surface_coverage",
    sourceId: "provider_crosscheck",
    defaultSort: { field: "standard_api_equivalent_usd", direction: "desc" },
    density: "dense",
    layout: "full",
    columns: [
      { field: "surface", label: "Surface", type: "text" },
      { field: "rollouts", label: "Rollouts", format: "number" },
      { field: "usage_events", label: "Usage events", format: "number" },
      { field: "total_tokens", label: "Tokens", format: "number" },
      { field: "standard_api_equivalent_usd", label: "Standard API equivalent", format: "currency" },
      { field: "cost_share", label: "Cost share", format: "percent" },
      { field: "unknown_speed_events", label: "Unknown-speed events", format: "number" },
    ],
  },
  {
    id: "provider_ui_table",
    title: "Provider UI and app-server observation",
    subtitle: currentUi
      ? `The captures were ${number((uiVsApp.captureSeparationSeconds ?? 0) / 60, 1)} minutes apart, so the percentage difference is recorded rather than forced to match.`
      : "No same-account visible UI observation is available; app-server values remain provider-account-only.",
    dataset: "provider_ui_comparison",
    sourceId: "provider_ui_usage",
    defaultSort: { field: "ui_captured_at", direction: "desc" },
    density: "dense",
    layout: "full",
    columns: [
      { field: "ui_captured_at", label: "UI captured", type: "text" },
      { field: "ui_remaining_percent", label: "UI remaining", format: "number" },
      { field: "app_server_remaining_percent", label: "App remaining", format: "number" },
      { field: "used_percentage_point_difference_ui_minus_app", label: "Used-point difference", format: "number" },
      { field: "reset_difference_seconds", label: "Reset difference (sec)", format: "number" },
      { field: "turns_by_model_total", label: "Turns by model", format: "number" },
      { field: "turns_by_surface_total", label: "Turns by surface", format: "number" },
      { field: "explicit_work_bucket", label: "Work-only bucket", type: "text" },
    ],
  },
  {
    id: "coverage_gaps_table",
    title: "Dates without an official daily bucket",
    subtitle: "Local receipts remain visible on these dates, but no matched provider-day ratio is calculated.",
    dataset: "coverage_gaps",
    sourceId: "provider_crosscheck",
    defaultSort: { field: "date", direction: "asc" },
    density: "dense",
    layout: "full",
    columns: [
      { field: "date", label: "UTC date", type: "text" },
      { field: "local_tokens", label: "Local tokens", format: "number" },
      { field: "local_usage_events", label: "Local events", format: "number" },
      { field: "local_api_priced_usd", label: "Standard API equivalent", format: "currency" },
      { field: "policy_epoch", label: "Policy epoch", type: "text" },
      { field: "account_status", label: "Account status", type: "text" },
    ],
  },
);

artifact.manifest.blocks.push(
  {
    id: "account_surface_extension",
    type: "markdown",
    sourceId: "provider_crosscheck",
    body: `## Multi-surface and account-aware extension\n\nThe earlier weekly-limit result remains intact: **${money(weeklySummary.recent_tier_lower_usd)}–${money(weeklySummary.recent_tier_upper_usd)} is a conditional tier-sensitivity ballpark**, not an observed allowance. Once account and missing-surface uncertainty are included, the actual allowance range is **unbounded by the retained evidence**. Retained local history contains **${number(local.totalTokens, 0)} tokens**, while the currently signed-in pseudonymous account reports **${number(crosscheck.provider.officialUsageSummary?.lifetimeTokens, 0)} lifetime tokens**. Under equal token semantics, the ${number(crosscheck.comparisons.accountCompatibility.localToProviderLifetimeRatio, 3)}x ratio disproves treating the entire local corpus as this one account. Known account switching is a plausible cause, but older metric semantics or residual duplication are not ruled out.`,
  },
  { id: "account_surface_metrics", type: "metric-strip", cardIds: ["ui_remaining", "lifetime_ratio", "post_work_ratio", "scheduled_rollouts"] },
  {
    id: "daily_provider_coverage_context",
    type: "markdown",
    sourceId: "provider_crosscheck",
    body: `### Daily provider crosscheck\n\nAcross ${number(crosscheck.comparisons.comparableDayCount, 0)} matched days, account-unattributed local/provider tokens are ${number(crosscheck.comparisons.aggregateLocalToOfficialTokenRatio, 3)}x in aggregate. This hides a sharp era difference: matched local tokens are ${number(visibilityEpoch?.localToOfficialRatio, 3)}x official tokens from ${visibilityEpoch?.startDate ?? "unavailable"} through ${visibilityEpoch?.endDate ?? "unavailable"}, then ${number(postWorkEpoch?.localToOfficialRatio, 3)}x from ${postWorkEpoch?.startDate ?? "unavailable"} through ${postWorkEpoch?.endDate ?? "unavailable"} and ${number(continuityEpoch?.localToOfficialRatio, 3)}x from ${continuityEpoch?.startDate ?? "unavailable"} through ${continuityEpoch?.endDate ?? "unavailable"}. This is explicitly **not an account-matched ratio**. The post–July 9 alignment is materially better, but it does not prove that shared accounting began on July 9: account switching, missing local Work/cloud activity, model changes, and provider metric definitions remain confounded.`,
  },
  { id: "daily_provider_coverage", type: "chart", chartId: "daily_provider_coverage_chart" },
  { id: "coverage_gaps", type: "table", tableId: "coverage_gaps_table", layout: "full" },
  {
    id: "task_surface_context",
    type: "markdown",
    sourceId: "provider_crosscheck",
    body: `### Codex tasks and nested work are now explicit\n\nThe retained history classifies **${number(local.rolloutsBySurface.scheduled_task, 0)} scheduled-task rollouts** (${number(scheduled.events, 0)} usage events, ${number(scheduled.totalTokens, 0)} tokens, ${money(scheduled.totalUsd)} Standard API equivalent) and **${number(local.rolloutsBySurface.subagent, 0)} subagent rollouts** (${number(subagent.events, 0)} events, ${number(subagent.totalTokens, 0)} tokens, ${money(subagent.totalUsd)}). These are included once after ${number(local.forkReplayEventsSkipped, 0)} cumulative fork-replay events are excluded. A provider-side Cloud task with no local rollout still cannot be assigned locally; it remains provider-side unallocated activity rather than being guessed into Work or scheduled tasks.`,
  },
  { id: "surface_cost_share", type: "chart", chartId: "surface_cost_chart" },
  { id: "surface_coverage", type: "table", tableId: "surface_coverage_table", layout: "full" },
  {
    id: "work_provider_context",
    type: "markdown",
    sourceId: "provider_ui_usage",
    body: currentUi
      ? `### ChatGPT Work is observable only at the shared-pool boundary\n\nThe authenticated **Codex and Work Analytics** page explicitly said that Work and Codex share the same usage limit. It exposed ${number(uiData.turnsByModelTotal, 0)} turns by model, ${number(uiData.turnsBySurfaceTotal, 0)} turns by surface, and provider categories ${providerCategories}. It did **not** expose a Work-only bucket. The ${number(modelSurfaceGap, 0)} difference between model-total and surface-total displays is retained as unclassified and is not relabeled as Work. The local app-server likewise returns account-level quota and daily token summaries, not Work-specific allocation.`
      : "### ChatGPT Work is observable only at the shared-pool boundary\n\nNo same-account visible UI observation is present in this build. The app-server still provides account-level quota and daily token summaries, but it cannot isolate Work. No raw JSONL fallback is used because it could belong to another account.",
  },
  { id: "provider_ui_comparison", type: "table", tableId: "provider_ui_table", layout: "full" },
  {
    id: "policy_epoch_context",
    type: "markdown",
    sourceId: "provider_crosscheck",
    body: "### What can be said about policy changes\n\nOfficial release notes establish that the $100 Pro option launched on April 9, 2026 with a temporary up-to-10x Codex allowance, described as an increase from its normal 5x level; the $200 option remained the highest-usage tier. The retained local interval begins May 17, so the user's unresolved $100 episode could cross that promotion boundary and is not assigned a multiplier.\n\nThe same release notes establish July 9, 2026 as the Work launch and unified ChatGPT desktop milestone. Current official guidance establishes shared Work/Codex usage. No primary source found says the accounting pool changed on exactly July 9, so the monitor records it as a **plausible, unconfirmed accounting boundary**. July 16 is retained separately as a verified UI-continuity change, not a quota change.",
  },
  { id: "policy_epoch_coverage", type: "chart", chartId: "policy_epoch_chart" },
  {
    id: "plan_account_context",
    type: "markdown",
    sourceId: "account_plan_timeline",
    body: `### Two accounts and the brief $100 plan\n\nThe current account is stored only as a Keychain-HMAC pseudonym${currentProfile?.alias ? ` with local alias \`${currentProfile.alias}\`` : " and has no registered local alias"}; raw email and provider account identifiers are never written. The provider reports only \`planType: ${crosscheck.scope.providerPlanType}\`, which does not distinguish the $100 5x and $200 20x variants. The timeline applies the registered ${currentProfile?.defaultPlanVariant ?? "unknown"} default only from ${currentProfile?.defaultEffectiveAt ?? "an unavailable effective date"} onward and leaves ${number(planTimeline.unresolvedEpisodes.length, 0)} brief-plan episode(s) unresolved, with no invented dates or account. Historical rollouts remain account-unattributed unless a fresh local marker existed at collection time.\n\nProspective account-scoped collector evidence is currently **${crosscheck.comparisons.prospectiveAccountScoped?.status ?? "unavailable"}** with ${number(crosscheck.comparisons.prospectiveAccountScoped?.eventCount ?? 0, 0)} matched rollout event(s). When available it is partitioned by pseudonymous scope and dated plan variant, but remains partial-marker coverage rather than a full-day reconciliation. Report and inference group keys now include both fields so two accounts or plan eras cannot be pooled.`,
  },
  {
    id: "learning_loop",
    type: "markdown",
    sourceId: "provider_crosscheck",
    body: `## Updated learning loop\n\n1. On each account, run \`register-account --alias … --default-plan …\`, then \`collect-once --stale-after-ms 0\` immediately after switching. Registration dates the plan profile; collection creates a fresh prospective marker. Neither command retroactively assigns old rollouts.\n2. Keep the passive collector running at normal boundaries so quota percentage, reset, official daily buckets, account scope, plan label, and new rollout receipts are time-aligned.\n3. Record the approximate dates and account alias for the brief 5x period when known; every plan/account boundary becomes a structural break.\n4. Capture the visible Analytics page near an app-server poll occasionally. The UI adds Work/shared-pool and provider-surface context; the app-server provides machine-readable quota and daily tokens.\n5. Continue the controlled Standard/Fast panels from the original report. The allowance remains non-identifiable until several clean within-reset panels cover one account, one plan, and all shared-pool activity.\n\nThe provenance-checked local-history cache avoids repricing the fixed ${number(retainedDayCount, 0)}-day interval when relevant sources are unchanged, or when every newly appended complete JSONL record is proven to fall after the fixed end timestamp. Rewrites, replacements, newly relevant files, and in-range suffix records are rejected unless a stale override is explicit. This build's cache status is **${crosscheck.local.cacheValidation?.status ?? "unspecified"}**.`,
  },
);

artifact.manifest.generatedAt = crosscheck.materializedAt;
artifact.snapshot.generatedAt = crosscheck.materializedAt;
const extensionDescription = "Extended with account, task-surface, ChatGPT Work, and provider-side crosschecks.";
artifact.manifest.description = artifact.manifest.description.endsWith(` ${extensionDescription}`)
  ? artifact.manifest.description
  : `${artifact.manifest.description} ${extensionDescription}`;

await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
await chmod(artifactPath, 0o600);
console.log(`Extended portable artifact written to ${artifactPath}`);
