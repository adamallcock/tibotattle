const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
const RESET_JITTER_TOLERANCE_SECONDS = 120;

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function quantile(values, probability) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + (Number(selector(row)) || 0), 0);
}

function seriesKey(row) {
  return [row.provider, row.planType, row.limitId, row.slot, row.windowDurationMins, row.resetsAt].join("|");
}

function familyKey(row) {
  return [row.provider, row.planType, row.limitId, row.slot, row.windowDurationMins].join("|");
}

function isKnownAccount(value) {
  return typeof value === "string" && value.length > 0 && value !== "unattributed" && value !== "unknown";
}

function isKnownPlan(value) {
  return typeof value === "string" && value.length > 0 && value !== "unknown";
}

function resetClusters(groups, toleranceSeconds = RESET_JITTER_TOLERANCE_SECONDS) {
  const clusters = [];
  for (const group of [...groups].sort((left, right) => right.snapshotCount - left.snapshotCount || left.resetsAt - right.resetsAt)) {
    const existing = clusters.find((cluster) => Math.abs(cluster.representativeResetsAt - group.resetsAt) <= toleranceSeconds);
    if (existing) {
      existing.exactGroupCount += 1;
      existing.snapshotCount += group.snapshotCount;
      existing.transitionCount += group.transitionCount;
      existing.minResetsAt = Math.min(existing.minResetsAt, group.resetsAt);
      existing.maxResetsAt = Math.max(existing.maxResetsAt, group.resetsAt);
    } else {
      clusters.push({
        representativeResetsAt: group.resetsAt,
        exactGroupCount: 1,
        snapshotCount: group.snapshotCount,
        transitionCount: group.transitionCount,
        minResetsAt: group.resetsAt,
        maxResetsAt: group.resetsAt,
      });
    }
  }
  return clusters.sort((left, right) => right.snapshotCount - left.snapshotCount);
}

function summarizeResetFamilies(windowGroups = []) {
  const families = new Map();
  for (const group of windowGroups) {
    const key = familyKey(group);
    const rows = families.get(key) ?? [];
    rows.push(group);
    families.set(key, rows);
  }
  return [...families.entries()].map(([key, groups]) => {
    const snapshots = sum(groups, (row) => row.snapshotCount);
    const transitions = sum(groups, (row) => row.transitionCount);
    const clusters = resetClusters(groups);
    const dominant = [...groups].sort((left, right) => right.snapshotCount - left.snapshotCount)[0];
    const singletonResetGroups = groups.filter((row) => row.snapshotCount === 1).length;
    const resetBehavior = groups.length >= 20 && singletonResetGroups / groups.length >= 0.8
      ? "moving_or_high_churn"
      : clusters.length < groups.length ? "fixed_with_timestamp_jitter" : "discrete_reset_epochs";
    return {
      familyKey: key,
      provider: dominant.provider,
      planType: dominant.planType,
      limitId: dominant.limitId,
      slot: dominant.slot,
      windowDurationMins: dominant.windowDurationMins,
      exactResetGroups: groups.length,
      jitterClusters120s: clusters.length,
      singletonResetGroups,
      groupsWithTransitions: groups.filter((row) => row.transitionCount > 0).length,
      snapshots,
      transitions,
      dominantExactResetSnapshotShare: ratio(dominant.snapshotCount, snapshots),
      dominantClusterSnapshotShare: ratio(clusters[0]?.snapshotCount ?? 0, snapshots),
      resetBehavior,
    };
  }).sort((left, right) => right.snapshots - left.snapshots);
}

export function classifyMonitoringInterval(row, {
  freshCadenceMs = DEFAULT_FRESH_MS,
} = {}) {
  const eventCount = row.marginalUsageEventCount ?? 0;
  const quotaDelta = (row.nextUsedPercent ?? 0) - (row.priorUsedPercent ?? 0);
  const speed = row.tierUsageEventCounts ?? {};
  const knownSpeedEvents = (speed.standard ?? 0) + (speed.fast ?? 0);
  const unknownSpeedEvents = speed.unknown ?? 0;
  const totalSpeedEvents = knownSpeedEvents + unknownSpeedEvents;
  const coverageFraction = row.quality?.localCoverage?.elapsedTimeCoverageFraction
    ?? row.quality?.elapsedTimeCoverageFraction
    ?? null;
  const pricingWarnings = row.quality?.pricingWarnings ?? [];
  const attributionWarnings = row.quality?.attributionWarnings ?? [];
  const skipped = Math.abs(quotaDelta) > 1;
  const quotaSignal = quotaDelta < 0 ? "regression" : skipped ? "skipped_value" : quotaDelta > 0 ? "increase" : "flat";
  const localReceipt = eventCount > 0 ? "present" : quotaDelta > 0 ? "missing_for_increase" : "none";
  const cadence = !Number.isFinite(row.elapsedMs)
    ? "unknown"
    : row.elapsedMs <= freshCadenceMs ? "fresh" : "gapped";
  const speedCoverage = totalSpeedEvents === 0
    ? "no_usage"
    : unknownSpeedEvents === 0 ? "known" : knownSpeedEvents === 0 ? "unknown" : "mixed";
  const fitEligible = quotaDelta > 0
    && !skipped
    && eventCount > 0
    && coverageFraction === 1
    && pricingWarnings.length === 0
    && attributionWarnings.length === 0;
  return {
    quotaSignal,
    localReceipt,
    cadence,
    speedCoverage,
    accountScope: isKnownAccount(row.accountScopeId) ? "known" : "unknown",
    planVariant: isKnownPlan(row.planVariant) ? "known" : "unknown",
    localCoverage: coverageFraction === 1 ? "full_elapsed_window" : coverageFraction === null ? "unknown" : "partial",
    pricing: pricingWarnings.length === 0 ? "complete" : "warning",
    attribution: attributionWarnings.length === 0 ? "complete" : "warning",
    controlledState: row.controlledState ?? "unknown",
    providerSnapshotAge: Number.isFinite(row.snapshot?.providerSnapshotAgeMs) ? "known" : "unknown",
    fitEligible,
  };
}

function summarizeFlatRuns(intervals) {
  const runs = [];
  let current = { elapsedMs: 0, intervals: 0, usageEvents: 0, apiCostUsd: 0 };
  for (const row of intervals) {
    const delta = row.nextUsedPercent - row.priorUsedPercent;
    if (delta === 0) {
      current.elapsedMs += row.elapsedMs ?? 0;
      current.intervals += 1;
      current.usageEvents += row.marginalUsageEventCount ?? 0;
      current.apiCostUsd += row.marginalApiPricedUsd ?? 0;
    } else if (delta > 0) {
      runs.push({ ...current, quotaJumpPp: delta });
      current = { elapsedMs: 0, intervals: 0, usageEvents: 0, apiCostUsd: 0 };
    } else {
      current = { elapsedMs: 0, intervals: 0, usageEvents: 0, apiCostUsd: 0 };
    }
  }
  return {
    runsBeforeIncrease: runs.length,
    elapsedSecondsP50: round(quantile(runs.map((row) => row.elapsedMs / 1_000), 0.5), 3),
    elapsedSecondsP90: round(quantile(runs.map((row) => row.elapsedMs / 1_000), 0.9), 3),
    usageEventsP50: round(quantile(runs.map((row) => row.usageEvents), 0.5), 3),
    usageEventsP90: round(quantile(runs.map((row) => row.usageEvents), 0.9), 3),
    apiCostUsdP50: round(quantile(runs.map((row) => row.apiCostUsd), 0.5), 6),
    apiCostUsdP90: round(quantile(runs.map((row) => row.apiCostUsd), 0.9), 6),
  };
}

function summarizeCollector(records, nowMs, { freshMs = DEFAULT_FRESH_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  const ordered = [...records]
    .filter((row) => Number.isFinite(Date.parse(row.observedAt)))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const usage = ordered.filter((row) => row.kind === "codex_rollout_usage_snapshot");
  const quota = ordered.filter((row) => row.kind === "codex_quota_snapshot");
  const appServer = quota.filter((row) => row.source === "app_server_read" || row.source === "app_server_notification");
  const latest = ordered.at(-1) ?? null;
  const latestAppServer = appServer.at(-1) ?? null;
  const ageMs = latest ? Math.max(0, nowMs - Date.parse(latest.observedAt)) : null;
  const appServerAgeMs = latestAppServer ? Math.max(0, nowMs - Date.parse(latestAppServer.observedAt)) : null;
  const statusFor = (value) => value === null ? "missing" : value <= freshMs ? "fresh" : value <= staleMs ? "delayed" : "stale";
  const scopedUsage = usage.filter((row) => row.accountScope?.status === "available" && row.accountScope?.scopeId).length;
  const knownSpeedUsage = usage.filter((row) => ["standard", "fast"].includes(row.tierSemantics?.codexSpeedMode)).length;
  const staleness = usage.map((row) => row.stalenessMs).filter(Number.isFinite);
  const gaps = ordered.slice(1).map((row, index) => Date.parse(row.observedAt) - Date.parse(ordered[index].observedAt));
  const appServerGaps = appServer.slice(1).map((row, index) => Date.parse(row.observedAt) - Date.parse(appServer[index].observedAt));
  return {
    records: ordered.length,
    firstObservedAt: ordered[0]?.observedAt ?? null,
    lastObservedAt: latest?.observedAt ?? null,
    lastSource: latest?.source ?? null,
    ageMs,
    status: statusFor(ageMs),
    quotaSnapshotRecords: quota.length,
    appServerSnapshotRecords: appServer.length,
    appServerNotificationRecords: appServer.filter((row) => row.source === "app_server_notification").length,
    lastAppServerObservedAt: latestAppServer?.observedAt ?? null,
    appServerAgeMs,
    appServerStatus: statusFor(appServerAgeMs),
    latestAppServerGapMs: appServerGaps.at(-1) ?? null,
    maxAppServerGapMs: appServerGaps.length > 0 ? Math.max(...appServerGaps) : null,
    maxRecordGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
    usageRecords: usage.length,
    accountScopedUsageRecords: scopedUsage,
    accountScopedUsageFraction: ratio(scopedUsage, usage.length),
    knownSpeedUsageRecords: knownSpeedUsage,
    knownSpeedUsageFraction: ratio(knownSpeedUsage, usage.length),
    rolloutReceiptStalenessMsP50: round(quantile(staleness, 0.5), 3),
    rolloutReceiptStalenessMsP90: round(quantile(staleness, 0.9), 3),
  };
}

function opportunity(priority, id, title, evidence, action) {
  return { priority, id, title, evidence, action };
}

export function analyzeMonitoringQuality({
  transitions,
  collectorRecords = [],
  now = new Date().toISOString(),
}) {
  if (!transitions || !Array.isArray(transitions.windowGroups)) throw new Error("Monitoring quality requires a transition dataset with windowGroups");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Monitoring quality now must be a valid timestamp");
  const resetFamilies = summarizeResetFamilies(transitions.windowGroups);
  const dominantGroup = [...transitions.windowGroups].sort((left, right) => right.snapshotCount - left.snapshotCount)[0] ?? null;
  const dominantKey = dominantGroup ? seriesKey(dominantGroup) : null;
  const intervals = (transitions.snapshotIntervals ?? [])
    .filter((row) => seriesKey(row) === dominantKey)
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const transitionRows = (transitions.transitions ?? [])
    .filter((row) => seriesKey(row) === dominantKey)
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const flags = intervals.map((row) => classifyMonitoringInterval(row));
  const intervalCount = intervals.length;
  const flat = flags.filter((row) => row.quotaSignal === "flat").length;
  const increases = flags.filter((row) => row.quotaSignal === "increase").length;
  const regressions = flags.filter((row) => row.quotaSignal === "regression").length;
  const skipped = flags.filter((row) => row.quotaSignal === "skipped_value").length;
  const totalEvents = sum(intervals, (row) => row.marginalUsageEventCount);
  const unknownSpeedEvents = sum(intervals, (row) => row.tierUsageEventCounts?.unknown);
  const knownSpeedEvents = sum(intervals, (row) => (row.tierUsageEventCounts?.standard ?? 0) + (row.tierUsageEventCounts?.fast ?? 0));
  const cadence = intervals.map((row) => row.elapsedMs).filter(Number.isFinite);
  const collector = summarizeCollector(collectorRecords, nowMs);
  const dominantFamily = resetFamilies.find((row) => row.limitId === dominantGroup?.limitId
    && row.slot === dominantGroup?.slot
    && row.windowDurationMins === dominantGroup?.windowDurationMins
    && row.provider === dominantGroup?.provider
    && row.planType === dominantGroup?.planType) ?? null;
  const metadata = {
    accountKnownIntervalFraction: ratio(intervals.filter((row) => isKnownAccount(row.accountScopeId)).length, intervalCount),
    planKnownIntervalFraction: ratio(intervals.filter((row) => isKnownPlan(row.planVariant)).length, intervalCount),
    knownSpeedEventFraction: ratio(knownSpeedEvents, knownSpeedEvents + unknownSpeedEvents),
    providerSnapshotAgeKnownIntervalFraction: ratio(intervals.filter((row) => Number.isFinite(row.snapshot?.providerSnapshotAgeMs)).length, intervalCount),
    controlledIntervalFraction: ratio(intervals.filter((row) => row.controlledState === "controlled").length, intervalCount),
  };
  const quantization = {
    flatIntervals: flat,
    increasingIntervals: increases,
    regressionIntervals: regressions,
    skippedValueIntervals: skipped,
    flatIntervalFraction: ratio(flat, intervalCount),
    increasingIntervalFraction: ratio(increases, intervalCount),
    regressionIntervalFraction: ratio(regressions, intervalCount),
    increasesWithoutLocalUsage: transitionRows.filter((row) => row.nextUsedPercent > row.priorUsedPercent && (row.marginalUsageEventCount ?? 0) === 0).length,
    cadenceSecondsP50: round(quantile(cadence.map((value) => value / 1_000), 0.5), 3),
    cadenceSecondsP90: round(quantile(cadence.map((value) => value / 1_000), 0.9), 3),
    cadenceSecondsP99: round(quantile(cadence.map((value) => value / 1_000), 0.99), 3),
    intervalsOverFiveMinutes: cadence.filter((value) => value > DEFAULT_FRESH_MS).length,
    ...summarizeFlatRuns(intervals),
  };
  const parser = {
    filesScanned: transitions.diagnostics?.filesScanned ?? null,
    malformedLines: transitions.diagnostics?.malformedLines ?? null,
    malformedUsageRecords: transitions.diagnostics?.malformedUsageRecords ?? null,
    missingRateLimitRecords: transitions.diagnostics?.missingRateLimitRecords ?? null,
    malformedRateLimitRecords: transitions.diagnostics?.malformedRateLimitRecords ?? null,
    forkReplayEventsExcluded: transitions.diagnostics?.forkReplayEventsSkipped ?? null,
    duplicateUsageEventsExcluded: transitions.diagnostics?.replayedEventsSkipped ?? null,
  };
  const opportunities = [];
  if (["stale", "missing"].includes(collector.status)
    || ["stale", "missing"].includes(collector.appServerStatus)
    || (collector.maxAppServerGapMs ?? 0) > DEFAULT_STALE_MS
    || collector.appServerNotificationRecords === 0) {
    const continuityEvidence = collector.status === "fresh" && collector.appServerStatus === "fresh"
      ? `The feed is fresh after a maximum observed app-server gap of ${round((collector.maxAppServerGapMs ?? 0) / 3_600_000, 2)} hours; ${collector.appServerNotificationRecords} live notification records have been retained.`
      : `The newest collector record is ${collector.status}${collector.ageMs === null ? "" : ` (${round(collector.ageMs / 3_600_000, 2)} hours old)`}; the app-server quota feed is ${collector.appServerStatus}.`;
    opportunities.push(opportunity(
      "P0",
      "collector_continuity",
      "Keep the prospective collector continuously fresh",
      continuityEvidence,
      "Run the foreground collector during active work, add a freshness watchdog, and alert rather than silently analyzing a stale ledger.",
    ));
  }
  if ((dominantFamily?.exactResetGroups ?? 0) > (dominantFamily?.jitterClusters120s ?? 0)) {
    opportunities.push(opportunity(
      "P0",
      "reset_identity_stabilization",
      "Separate fixed-reset timestamp jitter from moving reset families",
      `${dominantFamily.exactResetGroups} exact reset timestamps collapse to ${dominantFamily.jitterClusters120s} clusters within 120 seconds for the dominant limit family; other families may still be genuinely moving.`,
      "Use a tolerance-bounded canonical reset identity only for families classified fixed-with-jitter; never chain-merge moving reset timestamps.",
    ));
  }
  if ((metadata.accountKnownIntervalFraction ?? 0) < 0.95 || (metadata.planKnownIntervalFraction ?? 0) < 0.95) {
    opportunities.push(opportunity(
      "P0",
      "prospective_account_plan_join",
      "Make account and plan scope a hard prospective coverage gate",
      `${round((metadata.accountKnownIntervalFraction ?? 0) * 100, 1)}% of dominant historical intervals know the account and ${round((metadata.planKnownIntervalFraction ?? 0) * 100, 1)}% know the specific plan variant.`,
      "Refresh the account marker on collector start and after switches; report unscoped time as a coverage gap rather than pooling it.",
    ));
  }
  if ((metadata.providerSnapshotAgeKnownIntervalFraction ?? 0) < 0.95) {
    opportunities.push(opportunity(
      "P1",
      "snapshot_age_provenance",
      "Record snapshot receipt age on the live path",
      `${round((metadata.providerSnapshotAgeKnownIntervalFraction ?? 0) * 100, 1)}% of dominant historical intervals expose provider snapshot age.`,
      "Preserve received-at and source timestamps for app-server reads/notifications, and keep historical rollout snapshots explicitly age-unknown.",
    ));
  }
  if ((metadata.knownSpeedEventFraction ?? 0) < 0.99) {
    opportunities.push(opportunity(
      "P1",
      "speed_mode_coverage",
      "Tighten per-request Standard/Fast attribution",
      `${round((metadata.knownSpeedEventFraction ?? 0) * 100, 1)}% of usage events in the dominant reset have a known Standard/Fast mode.`,
      "Emit a privacy-safe tier marker whenever settings change and track unknown-speed share as a report gate.",
    ));
  }
  if ((quantization.flatIntervalFraction ?? 0) > 0.8) {
    opportunities.push(opportunity(
      "P1",
      "interval_censored_quota_model",
      "Treat integer quota changes as interval-censored observations",
      `${round(quantization.flatIntervalFraction * 100, 1)}% of dominant adjacent snapshots are flat; before an increase, the median flat run is ${quantization.elapsedSecondsP50} seconds and ${quantization.usageEventsP50} usage events.`,
      "Attribute each one-point change to a bounded cost/time envelope; use one-hour views for audit and two-to-three-hour windows for stable comparisons.",
    ));
  }
  if ((quantization.regressionIntervalFraction ?? 0) > 0) {
    opportunities.push(opportunity(
      "P1",
      "regression_quarantine",
      "Quarantine display regressions instead of smoothing them into usage",
      `${quantization.regressionIntervals} dominant intervals (${round(quantization.regressionIntervalFraction * 100, 2)}%) move backward within one reset identity.`,
      "Retain regressions for lag diagnosis, but exclude them from monotonic gradient fitting and flag nearby windows as timing-ambiguous.",
    ));
  }
  if ((parser.malformedLines ?? 0) > 0 || (parser.malformedRateLimitRecords ?? 0) > 0) {
    opportunities.push(opportunity(
      "P2",
      "parser_error_rate_watch",
      "Monitor parser loss rates by release and source",
      `${parser.malformedLines ?? 0} malformed JSONL lines and ${parser.malformedRateLimitRecords ?? 0} malformed rate-limit records were retained as diagnostics.`,
      "Add rate-based release thresholds and sample only privacy-safe schema/error codes when the rate changes.",
    ));
  }
  opportunities.sort((left, right) => left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id));
  return {
    schemaVersion: "monitoring-quality-v0.1",
    analyzedAt: new Date(nowMs).toISOString(),
    scope: {
      startAt: transitions.scope?.startAt ?? null,
      endAt: transitions.scope?.endAt ?? null,
      provider: transitions.scope?.provider ?? null,
      parserVersion: transitions.parserVersion ?? null,
      dominantSeries: dominantGroup ? {
        provider: dominantGroup.provider,
        planType: dominantGroup.planType,
        limitId: dominantGroup.limitId,
        slot: dominantGroup.slot,
        windowDurationMins: dominantGroup.windowDurationMins,
        resetsAt: dominantGroup.resetsAt,
        resetIdentity: new Date(dominantGroup.resetsAt * 1_000).toISOString(),
        snapshotCount: dominantGroup.snapshotCount,
        transitionCount: dominantGroup.transitionCount,
      } : null,
    },
    collector,
    resetFamilies,
    dominantSeries: {
      snapshotIntervals: intervalCount,
      transitionRows: transitionRows.length,
      usageEvents: totalEvents,
      apiPricedUsd: round(sum(intervals, (row) => row.marginalApiPricedUsd), 6),
      fitEligibleIntervals: flags.filter((row) => row.fitEligible).length,
      fitEligibleIntervalFraction: ratio(flags.filter((row) => row.fitEligible).length, intervalCount),
    },
    metadata,
    quantization,
    parser,
    opportunities,
  };
}

function percent(value, places = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(places)}%` : "unavailable";
}

export function renderMonitoringQualityReport(report) {
  const date = report.analyzedAt.slice(0, 10);
  const dominant = report.scope.dominantSeries;
  const lines = [
    "---",
    "title: TiboTattle Quality Diagnostic",
    `date: ${date}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# TiboTattle Quality Diagnostic",
    "",
    "## Technical summary",
    "",
    `The highest-leverage improvement is collector continuity: the local ledger is **${report.collector.status}** and its app-server quota feed is **${report.collector.appServerStatus}**. The next priorities are reset-identity stabilization and hard prospective account/plan coverage gates. Integer quota percentages remain interval-censored rather than exact per-request measurements.`,
    "",
    "## Dominant series and measurement grain",
    "",
    dominant
      ? `The diagnostic uses the largest exact series: ${dominant.limitId}/${dominant.slot}, ${dominant.windowDurationMins} minutes, reset ${dominant.resetIdentity}, with ${dominant.snapshotCount} snapshots and ${dominant.transitionCount} displayed changes.`
      : "No dominant quota series was available.",
    "",
    `- Adjacent snapshot intervals: ${report.dominantSeries.snapshotIntervals}`,
    `- Usage events aligned without crossing the exact reset: ${report.dominantSeries.usageEvents}`,
    `- Standard API-price equivalent: $${report.dominantSeries.apiPricedUsd.toFixed(2)}`,
    `- Fit-eligible adjacent intervals: ${report.dominantSeries.fitEligibleIntervals} (${percent(report.dominantSeries.fitEligibleIntervalFraction)})`,
    "",
    "## Observability findings",
    "",
    `- Account-known intervals: ${percent(report.metadata.accountKnownIntervalFraction)}; specific-plan-known intervals: ${percent(report.metadata.planKnownIntervalFraction)}.`,
    `- Known Standard/Fast usage events: ${percent(report.metadata.knownSpeedEventFraction)}.`,
    `- Intervals with known provider snapshot age: ${percent(report.metadata.providerSnapshotAgeKnownIntervalFraction)}.`,
    `- Flat integer-display intervals: ${percent(report.quantization.flatIntervalFraction)}; regressions: ${report.quantization.regressionIntervals}; skipped values: ${report.quantization.skippedValueIntervals}.`,
    `- Median flat run before an increase: ${report.quantization.elapsedSecondsP50} seconds and ${report.quantization.usageEventsP50} usage events; p90: ${report.quantization.elapsedSecondsP90} seconds and ${report.quantization.usageEventsP90} events.`,
    "",
    "## Prioritized improvements",
    "",
    "| Priority | Improvement | Evidence | Action |",
    "|---|---|---|---|",
    ...report.opportunities.map((row) => `| ${row.priority} | ${row.title} | ${row.evidence} | ${row.action} |`),
    "",
    "## Reset-family behavior",
    "",
    "| Limit | Window | Exact reset groups | 120s clusters | Groups with transitions | Dominant cluster share | Classification |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...report.resetFamilies.slice(0, 12).map((row) => `| ${row.limitId}/${row.slot} | ${row.windowDurationMins}m | ${row.exactResetGroups} | ${row.jitterClusters120s} | ${row.groupsWithTransitions} | ${percent(row.dominantClusterSnapshotShare)} | ${row.resetBehavior} |`),
    "",
    "## Interpretation boundary",
    "",
    "This diagnostic measures monitorability, not the absolute subscription allowance. Exact reset clustering is descriptive until a family is shown to be fixed-with-jitter; moving reset families must not be chain-merged. Historical account and provider-age fields remain unknown by design. Unlogged ChatGPT Work, Workspace Agent, ChatGPT for Excel, Codex cloud, other-device Codex, and image-generation activity can move the included general limit. Ordinary Chat and ordinary Chat Voice are excluded; Work Voice task activity is included while connected Voice time has a separate meter. Spark has a separate demand-adjusted limit.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
