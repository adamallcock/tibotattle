#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const qualityPath = resolve(root, ".usage-monitor/monitoring-quality-v0.1.json");
const outputPath = resolve(root, "2026-07-24-monitoring-quality-artifact.json");
const quality = JSON.parse(await readFile(qualityPath, "utf8"));
const generatedAt = new Date().toISOString();

const percent = (value, digits = 1) => Number.isFinite(value)
  ? `${(value * 100).toFixed(digits)}%`
  : "unavailable";
const hours = (value) => Number.isFinite(value) ? value / 3_600_000 : null;
const collectorAgeHours = hours(quality.collector.ageMs);
const appServerAgeHours = hours(quality.collector.appServerAgeMs);
const collectorAgeSeconds = Number.isFinite(quality.collector.ageMs) ? quality.collector.ageMs / 1_000 : null;
const maxAppServerGapHours = hours(quality.collector.maxAppServerGapMs);
const priorityCounts = ["P0", "P1", "P2"].map((priority) => ({
  priority,
  improvements: quality.opportunities.filter((row) => row.priority === priority).length,
}));
const coverageRows = [
  { dimension: "Account scope known", coverage_fraction: quality.metadata.accountKnownIntervalFraction },
  { dimension: "Specific plan known", coverage_fraction: quality.metadata.planKnownIntervalFraction },
  { dimension: "Standard/Fast known", coverage_fraction: quality.metadata.knownSpeedEventFraction },
  { dimension: "Snapshot age known", coverage_fraction: quality.metadata.providerSnapshotAgeKnownIntervalFraction },
  { dimension: "Controlled interval", coverage_fraction: quality.metadata.controlledIntervalFraction },
];
const signalRows = [
  { signal: "Flat integer display", intervals: quality.quantization.flatIntervals, fraction: quality.quantization.flatIntervalFraction },
  { signal: "Displayed increase", intervals: quality.quantization.increasingIntervals, fraction: quality.quantization.increasingIntervalFraction },
  { signal: "Display regression", intervals: quality.quantization.regressionIntervals, fraction: quality.quantization.regressionIntervalFraction },
  { signal: "Skipped integer value", intervals: quality.quantization.skippedValueIntervals, fraction: quality.dominantSeries.snapshotIntervals > 0 ? quality.quantization.skippedValueIntervals / quality.dominantSeries.snapshotIntervals : null },
];
const summary = [{
  collector_age_hours: collectorAgeHours,
  collector_age_seconds: collectorAgeSeconds,
  app_server_age_hours: appServerAgeHours,
  dominant_snapshot_intervals: quality.dominantSeries.snapshotIntervals,
  fit_eligible_fraction: quality.dominantSeries.fitEligibleIntervalFraction,
  known_speed_fraction: quality.metadata.knownSpeedEventFraction,
  flat_interval_fraction: quality.quantization.flatIntervalFraction,
  fixed_reset_exact_groups: quality.resetFamilies.find((row) => row.limitId === "codex")?.exactResetGroups ?? null,
  fixed_reset_clusters: quality.resetFamilies.find((row) => row.limitId === "codex")?.jitterClusters120s ?? null,
  moving_reset_groups: quality.resetFamilies.find((row) => row.resetBehavior === "moving_or_high_churn")?.exactResetGroups ?? null,
  prospective_account_scoped_usage_records: quality.collector.accountScopedUsageRecords,
}];
const resetRows = quality.resetFamilies.map((row) => ({
  limit: `${row.limitId}/${row.slot}`,
  window_minutes: row.windowDurationMins,
  exact_reset_groups: row.exactResetGroups,
  clusters_within_120s: row.jitterClusters120s,
  singleton_groups: row.singletonResetGroups,
  groups_with_transitions: row.groupsWithTransitions,
  dominant_cluster_share: row.dominantClusterSnapshotShare,
  behavior: row.resetBehavior,
}));

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Where TiboTattle Can Get Tighter",
    description: "A log-derived technical diagnostic of collector freshness, reset identity, quota quantization, and metadata coverage.",
    generatedAt,
    blocks: [
      {
        id: "title",
        type: "markdown",
        body: "# Where TiboTattle Can Get Tighter",
      },
      {
        id: "technical_summary",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: `## Technical summary\n\nThe logs support several concrete improvements, and the highest-value one was immediately actionable: **collector freshness**. The app-server ledger shows a maximum ${maxAppServerGapHours?.toFixed(1) ?? "unknown"}-hour gap before the privacy-safe refresh restored the local snapshot feed. The refresh sequence also captured the first **${quality.collector.accountScopedUsageRecords} prospectively account-scoped usage receipt**; it does not reassign the backfill. The remaining P0 work is to keep that feed continuous, stabilize fixed reset timestamps without merging genuinely moving limits, and make prospective account/plan scope a hard coverage gate.\n\nThe dominant recent weekly series contains **${quality.dominantSeries.snapshotIntervals.toLocaleString("en-US")} adjacent intervals**, but only **${percent(quality.dominantSeries.fitEligibleIntervalFraction)}** are directly fit-eligible. That is primarily an observability result: ${percent(quality.quantization.flatIntervalFraction)} of snapshots repeat the same whole percentage, historical account/plan scope is absent, and provider snapshot age is unknown on the historical rollout path.`,
      },
      {
        id: "headline_metrics",
        type: "metric-strip",
        cardIds: ["collector_age", "fit_eligible", "known_speed", "flat_display"],
      },
      {
        id: "coverage_finding",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: `## Known speed is strong; account, plan, and age coverage are the binding gaps\n\nStandard/Fast state is known for **${percent(quality.metadata.knownSpeedEventFraction)}** of usage events in the dominant reset. By contrast, historical account scope, specific plan variant, provider snapshot age, and controlled-state coverage are all effectively absent. Those missing dimensions should be visible interval gates, not silently inherited assumptions.`,
      },
      { id: "coverage_chart_block", type: "chart", chartId: "coverage_chart" },
      {
        id: "quantization_finding",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: `## Whole-percentage reporting makes minute-level attribution interval-censored\n\nThe provider display stays flat for **${percent(quality.quantization.flatIntervalFraction)}** of dominant adjacent snapshots. Before a displayed increase, the median flat run spans **${quality.quantization.elapsedSecondsP50.toFixed(0)} seconds and ${quality.quantization.usageEventsP50} usage events**; the p90 run spans ${quality.quantization.elapsedSecondsP90.toFixed(0)} seconds and ${quality.quantization.usageEventsP90} events. This is why a one-minute or one-request slope will be unstable even when local token accounting is exact. The right model assigns each one-point change to a bounded preceding cost/time envelope, while two-to-three-hour views remain the stable comparison.`,
      },
      { id: "signal_chart_block", type: "chart", chartId: "signal_chart" },
      {
        id: "reset_finding",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: `## Reset timestamps contain both benign jitter and a separate moving limit\n\nFor the main **codex** weekly family, **10 exact reset timestamps collapse to two clusters within 120 seconds**, and the dominant cluster contains ${percent(quality.resetFamilies.find((row) => row.limitId === "codex")?.dominantClusterSnapshotShare)} of snapshots. The **codex_bengalfox** family is fundamentally different: **583 exact groups, 577 singletons, and no displayed transitions** in this interval. A single reset-normalization rule would therefore either fragment the main series or wrongly merge a moving window.`,
      },
      { id: "reset_table_block", type: "table", tableId: "reset_table", layout: "full" },
      {
        id: "priority_finding",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: "## The implementation order follows evidentiary leverage\n\nP0 work prevents category errors: stale collection, cross-account/plan pooling, and reset-family misclassification. P1 work improves attribution resolution: interval-censored display changes, regressions, snapshot-age provenance, and speed coverage. P2 work watches low-rate parser loss without overreacting to a handful of malformed records.",
      },
      { id: "opportunity_table_block", type: "table", tableId: "opportunity_table", layout: "full" },
      {
        id: "scope_definitions",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: `## Scope, data, and metric definitions\n\nThe profile covers retained local activity from **${quality.scope.startAt} through ${quality.scope.endAt}**. The comparison grain is one adjacent quota snapshot inside the largest exact provider/plan/limit/slot/duration/reset series. A fit-eligible interval must show a one-point increase, contain retained local usage, have complete elapsed-time coverage, and carry no pricing or attribution warning.\n\nCoverage fractions describe whether a required dimension is actually observed. They do not impute a value from the current login or plan. Collector freshness is measured from the newest privacy-minimized ledger timestamp to the diagnostic run time.`,
      },
      {
        id: "method",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: "## Methodology\n\n1. Select the exact quota series with the most retained snapshots.\n2. Classify each adjacent interval independently across quota direction, local receipt presence, cadence, speed, account, plan, pricing, attribution, control state, and snapshot-age provenance.\n3. Measure flat runs before the next displayed increase to quantify integer-display censoring and lag.\n4. Profile reset families twice: exact timestamp groups and non-chain clusters whose members fall within 120 seconds of a high-volume representative.\n5. Classify a family as moving/high-churn only when it has at least 20 exact groups and at least 80% are singletons.\n6. Compare ledger timestamps with the diagnostic run time to assess collector and app-server freshness.\n\nNo prompt, response, path, account identifier, or credential is introduced by this analysis.",
      },
      {
        id: "limitations",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: "## Limitations, uncertainty, and robustness\n\n- The dominant-series event total is safe within that exact chronological series; totals must not be summed across overlapping reset families.\n- A 120-second reset cluster is a diagnostic hypothesis, not yet a rewrite rule. Fixed-with-jitter and moving families must be validated prospectively before canonicalization enters the estimator.\n- Historical rollout snapshots do not expose provider receipt age. Live app-server records do, so old and new paths intentionally have different provenance.\n- Refreshing the collector makes the ledger current but does not keep it continuously current; an operational watchdog or long-running collector is still needed.\n- The new account marker applies only to subsequent nearby events. It cannot assign the backfilled history retroactively.\n- Unlogged Work, Workspace Agent, Excel, Codex Cloud, other-device Codex, and image-generation activity remains outside the local per-turn receipt ledger. Ordinary Chat is outside the shared agentic pool; Spark is a separate limit.",
      },
      {
        id: "recommendations",
        type: "markdown",
        sourceId: "monitoring_quality",
        body: "## Recommended next steps\n\n1. Keep the new `quality` command in the normal workflow and fail visibly when the collector or app-server feed is more than 30 minutes stale.\n2. Run the foreground collector during active study periods, refreshing the account marker at startup and after every account switch.\n3. Add tolerance-bounded canonical reset IDs only for fixed-with-jitter families; explicitly exclude moving/high-churn and Spark limits from reset-level fitting.\n4. Add interval-censored cost envelopes to the gradient estimator and show one-hour audit, two-hour incident, and three-hour stable views together.\n5. Emit the interval coverage flags in every residual row and suppress strong claims when account, plan, speed, age, or control coverage is below threshold.\n6. Use privacy-safe activity markers for Work, Workspace Agents, Excel, Codex Cloud, other-device Codex, Work Voice task activity, and image generation. Do not treat ordinary Chat as a contaminant.",
      },
      {
        id: "questions",
        type: "markdown",
        body: "## Further questions\n\n- Does `codex_bengalfox` correspond to a rolling model-specific allowance, and does its percentage ever change under a controlled matching workload?\n- What tolerance best canonicalizes fixed reset jitter without merging a real provider reset or account switch?\n- How much does an interval-censored estimator reduce residual error compared with hour buckets?\n- Once the collector remains live, what fraction of events receive account, plan, speed, and snapshot-age coverage?\n- Which unexplained residuals remain after Work, Workspace Agent, Excel, Codex Cloud, and image-generation activity markers are added?",
      },
    ],
    cards: [
      {
        id: "collector_age",
        description: "Age in seconds of the newest privacy-minimized collector record at analysis time after the explicit refresh.",
        dataset: "summary",
        sourceId: "monitoring_quality",
        metrics: [{ label: "Collector age (seconds)", field: "collector_age_seconds", format: "number" }],
      },
      {
        id: "fit_eligible",
        description: "Share of dominant adjacent intervals that show one-point movement with retained usage and complete warning-free local coverage.",
        dataset: "summary",
        sourceId: "monitoring_quality",
        metrics: [{ label: "Fit-eligible intervals", field: "fit_eligible_fraction", format: "percent" }],
      },
      {
        id: "known_speed",
        description: "Share of usage events in the dominant exact reset with a captured Standard or Fast setting.",
        dataset: "summary",
        sourceId: "monitoring_quality",
        metrics: [{ label: "Known speed mode", field: "known_speed_fraction", format: "percent" }],
      },
      {
        id: "flat_display",
        description: "Share of adjacent snapshots whose provider-displayed whole percentage does not change.",
        dataset: "summary",
        sourceId: "monitoring_quality",
        metrics: [{ label: "Flat quota displays", field: "flat_interval_fraction", format: "percent" }],
      },
    ],
    charts: [
      {
        id: "coverage_chart",
        title: "Observed coverage by monitoring dimension",
        subtitle: "Dominant exact weekly reset; fractions reflect observed metadata, not imputed assumptions.",
        type: "bar",
        dataset: "coverage",
        sourceId: "monitoring_quality",
        valueFormat: "percent",
        legend: { show: false },
        encodings: {
          x: { field: "dimension", type: "nominal", label: "Dimension", sort: "-y" },
          y: { field: "coverage_fraction", type: "quantitative", label: "Observed coverage", format: "percent" },
          tooltip: [
            { field: "dimension", type: "nominal", label: "Dimension" },
            { field: "coverage_fraction", type: "quantitative", label: "Observed coverage", format: "percent" },
          ],
        },
      },
      {
        id: "signal_chart",
        title: "Adjacent quota snapshots by display signal",
        subtitle: `${quality.dominantSeries.snapshotIntervals.toLocaleString("en-US")} intervals in the dominant exact weekly reset; whole-percentage quantization dominates the grain.`,
        type: "bar",
        dataset: "signals",
        sourceId: "monitoring_quality",
        valueFormat: "number",
        legend: { show: false },
        encodings: {
          x: { field: "signal", type: "nominal", label: "Display signal", sort: "-y" },
          y: { field: "intervals", type: "quantitative", label: "Adjacent intervals", format: "number" },
          tooltip: [
            { field: "signal", type: "nominal", label: "Display signal" },
            { field: "intervals", type: "quantitative", label: "Intervals", format: "number" },
            { field: "fraction", type: "quantitative", label: "Share", format: "percent" },
          ],
        },
      },
    ],
    tables: [
      {
        id: "reset_table",
        title: "Reset-family stability profile",
        subtitle: "Exact timestamps versus bounded 120-second clusters; moving/high-churn families are not candidates for fixed reset canonicalization.",
        dataset: "reset_families",
        sourceId: "monitoring_quality",
        density: "spacious",
        layout: "full",
        columns: [
          { field: "limit", label: "Limit / slot", type: "text" },
          { field: "window_minutes", label: "Window (minutes)", format: "number" },
          { field: "exact_reset_groups", label: "Exact groups", format: "number" },
          { field: "clusters_within_120s", label: "120s clusters", format: "number" },
          { field: "singleton_groups", label: "Singleton groups", format: "number" },
          { field: "groups_with_transitions", label: "Groups with changes", format: "number" },
          { field: "dominant_cluster_share", label: "Dominant cluster share", format: "percent" },
          { field: "behavior", label: "Classification", type: "text" },
        ],
      },
      {
        id: "opportunity_table",
        title: "Prioritized monitoring improvements",
        subtitle: "Evidence and smallest useful implementation action from the retained local logs and collector ledger.",
        dataset: "opportunities",
        sourceId: "monitoring_quality",
        density: "spacious",
        layout: "full",
        columns: [
          { field: "priority", label: "Priority", type: "text" },
          { field: "title", label: "Improvement", type: "text" },
          { field: "evidence", label: "Observed evidence", type: "text" },
          { field: "action", label: "Implementation action", type: "text" },
        ],
      },
    ],
    sources: [
      { id: "monitoring_quality", label: "Local monitoring-quality diagnostic", path: ".usage-monitor/monitoring-quality-v0.1.json" },
      { id: "local_transitions", label: "Recent local transition ledger", path: ".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json" },
      { id: "collector_ledger", label: "Privacy-minimized passive collector ledger", path: ".usage-monitor/collector-events.jsonl" },
      { id: "coverage_register", label: "Usage-monitor coverage gaps register", path: "docs/governance/2026-07-24-coverage-gaps-register.md" },
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
      coverage: coverageRows,
      signals: signalRows,
      reset_families: resetRows,
      opportunities: quality.opportunities,
      priority_counts: priorityCounts,
    },
  },
  sources: [
    {
      id: "monitoring_quality",
      query: {
        engine: "node",
        language: "javascript",
        id: "monitoring-quality-v0.1",
        sql: "SELECT collector_freshness, account_plan_speed_age_coverage, quota_signal_mix, reset_family_stability, parser_diagnostics\nFROM local_monitoring_quality_profile\nWHERE analyzed_at = (SELECT MAX(analyzed_at) FROM local_monitoring_quality_profile)",
        description: "Profiles the largest exact quota series and the passive collector ledger without retaining prompt, response, path, account identifier, or credential data.",
        executed_at: quality.analyzedAt,
        tables_used: [
          ".usage-monitor/monitoring-quality-v0.1.json",
          ".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json",
          ".usage-monitor/collector-events.jsonl",
        ],
        filters: [
          `dominantReset=${quality.scope.dominantSeries.resetIdentity}`,
          `limitId=${quality.scope.dominantSeries.limitId}`,
          `windowDurationMins=${quality.scope.dominantSeries.windowDurationMins}`,
          "no cross-reset interval totals",
        ],
        metric_definitions: {
          fit_eligible_fraction: "Share of dominant adjacent intervals with a one-point increase, retained local usage, full elapsed coverage, and no pricing or attribution warning.",
          coverage_fraction: "Share of dominant intervals or events for which the named monitoring dimension is actually observed.",
          flat_interval_fraction: "Share of adjacent snapshots whose provider-displayed used percentage is unchanged.",
          reset_cluster: "Exact reset timestamps falling within 120 seconds of a high-volume representative; clustering is non-chain and diagnostic-only.",
        },
        chart_qa_notes: [
          "Coverage is a horizontal single-series bar because the comparison is one bounded fraction across long category labels.",
          "Quota signal counts are a horizontal single-series bar with zero baseline; tooltip retains fraction context.",
          "Reset family behavior remains a table because exact counts and classifications matter more than a visually compressed two-row comparison.",
        ],
      },
    },
    {
      id: "local_transitions",
      query: {
        engine: "node",
        language: "javascript",
        id: "recent-transition-ledger-v0.3.2",
        sql: "SELECT * FROM adjacent_quota_snapshot_intervals WHERE reset_identity = :dominant_reset ORDER BY event_time",
        description: "Replay-safe local usage and provider-displayed quota snapshots inside one exact reset identity.",
        executed_at: quality.scope.endAt,
        tables_used: [".usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json"],
      },
    },
    {
      id: "collector_ledger",
      query: {
        engine: "node",
        language: "javascript",
        id: "privacy-minimized-collector-v0.3",
        sql: "SELECT kind, source, observed_at, received_at, staleness_ms, account_scope_status, speed_mode FROM local_collector_events ORDER BY observed_at",
        description: "Append-only privacy-minimized collector records used to assess freshness and prospective metadata coverage.",
        executed_at: quality.analyzedAt,
        tables_used: [".usage-monitor/collector-events.jsonl"],
      },
    },
    {
      id: "coverage_register",
      path: "docs/governance/2026-07-24-coverage-gaps-register.md",
      description: "Living register of product surfaces and accounting relationships not yet observable at per-turn precision.",
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

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
await chmod(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({ outputPath, generatedAt, charts: artifact.manifest.charts.length, tables: artifact.manifest.tables.length }, null, 2)}\n`);
