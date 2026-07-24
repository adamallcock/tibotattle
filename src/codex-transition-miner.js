import { calculateCost, compilePriceCatalog, resolvePriceCatalog } from "runcost";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import { fastQuotaMultiplier, subscriptionSpeedSensitivity, unknownCodexTier } from "./tier-semantics.js";
import { addOfficialOpenAiPriceSupplements } from "./openai-api-price-supplements.js";

const SCHEMA_VERSION = "0.3";
export const PARSER_VERSION = "0.3.2";
const ESTIMATOR_VERSION = "runcost-api-price-v0.3";
const COMPONENT_NAMES = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
];

function emptyComponents() {
  return Object.fromEntries(COMPONENT_NAMES.map((name) => [name, 0]));
}

function addComponents(target, source) {
  for (const name of COMPONENT_NAMES) target[name] += source[name] ?? 0;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function priceUsageEvent(event, catalog) {
  const usageLedger = {
    schema_version: "0.1",
    provider: "openai",
    surface: "openai.responses",
    model: { requested: event.model },
    context: {
      total_input_tokens: event.raw.input_tokens,
      priced_at: event.timestamp,
      service_tier: "standard",
    },
    components: Object.entries(event.components).filter(([, quantity]) => quantity > 0).map(([name, quantity]) => ({
      name,
      quantity: String(quantity),
      unit: "token",
    })),
  };
  const ledger = calculateCost({ usageLedger, priceCards: catalog, mode: "compatibility" });
  const costUsd = Number(ledger.total);
  const multiplier = fastQuotaMultiplier(event.model);
  const fastWeightedEquivalentUsd = multiplier === null ? null : costUsd * multiplier;
  const speedMode = event.tierSemantics?.codexSpeedMode ?? "unknown";
  return {
    ...event,
    costUsd,
    fastWeightedEquivalentUsd,
    quotaWeightedLowerUsd: speedMode === "fast" ? fastWeightedEquivalentUsd : costUsd,
    quotaWeightedUpperUsd: speedMode === "standard" ? costUsd : fastWeightedEquivalentUsd,
    warningCodes: ledger.warnings.map((warning) => warning.code).sort(),
    priceCardIds: [...new Set(ledger.components.map((component) => component.price_card_id).filter(Boolean))].sort(),
  };
}

function upperBound(events, timestampMs) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].timestampMs <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function aggregateUsage(events, startExclusiveMs, endInclusiveMs) {
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  const components = emptyComponents();
  const models = {};
  const pricingWarnings = new Set();
  const priceCardIds = new Set();
  const tierUsageEventCounts = {};
  let costUsd = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const event = events[index];
    addComponents(components, event.components);
    costUsd += event.costUsd;
    for (const warning of event.warningCodes) pricingWarnings.add(warning);
    for (const id of event.priceCardIds) priceCardIds.add(id);
    const speedMode = event.tierSemantics?.codexSpeedMode ?? "unknown";
    tierUsageEventCounts[speedMode] = (tierUsageEventCounts[speedMode] ?? 0) + 1;
    const model = models[event.model] ??= { events: 0, costUsd: 0, components: emptyComponents() };
    model.events += 1;
    model.costUsd += event.costUsd;
    addComponents(model.components, event.components);
  }
  for (const model of Object.values(models)) model.costUsd = roundUsd(model.costUsd);
  return {
    eventCount: endIndex - startIndex,
    costUsd: roundUsd(costUsd),
    components,
    models,
    pricingWarnings: [...pricingWarnings].sort(),
    priceCardIds: [...priceCardIds].sort(),
    tierUsageEventCounts,
  };
}

function aggregateCost(events, startExclusiveMs, endInclusiveMs) {
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  const startCost = startIndex === 0 ? 0 : events[startIndex - 1].cumulativeScanCostUsd;
  const endCost = endIndex === 0 ? 0 : events[endIndex - 1].cumulativeScanCostUsd;
  return roundUsd(endCost - startCost);
}

function aggregateCumulativeField(events, startExclusiveMs, endInclusiveMs, field) {
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  const startValue = startIndex === 0 ? 0 : events[startIndex - 1][field];
  const endValue = endIndex === 0 ? 0 : events[endIndex - 1][field];
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  return roundUsd(endValue - startValue);
}

function aggregateTools(events, startExclusiveMs, endInclusiveMs) {
  const result = {};
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  for (let index = startIndex; index < endIndex; index += 1) {
    const event = events[index];
    result[event.toolClass] = (result[event.toolClass] ?? 0) + 1;
  }
  return result;
}

function displayLagEnvelopes(events, windowStartMs, scanStartMs, snapshotMs, cumulativeUpperUsd) {
  const localStartMs = Math.max(windowStartMs, scanStartMs);
  const firstIndex = upperBound(events, localStartMs - 1);
  const endIndex = upperBound(events, snapshotMs);
  const byEventCount = [1, 2, 3].map((maxLagEvents) => {
    const earliestIndex = Math.max(firstIndex, endIndex - maxLagEvents);
    const earliestTimestampMs = earliestIndex < endIndex ? events[earliestIndex].timestampMs : snapshotMs;
    return {
      maxLagEvents,
      lowerCumulativeApiPricedUsd: aggregateCost(events, localStartMs - 1, earliestTimestampMs - 1),
      upperCumulativeApiPricedUsd: cumulativeUpperUsd,
    };
  });
  const byElapsedTime = [5_000, 30_000, 60_000].map((maxLagMs) => ({
    maxLagMs,
    lowerCumulativeApiPricedUsd: aggregateCost(
      events,
      localStartMs - 1,
      Math.max(localStartMs - 1, snapshotMs - maxLagMs),
    ),
    upperCumulativeApiPricedUsd: cumulativeUpperUsd,
  }));
  return { byEventCount, byElapsedTime };
}

function windowKey(window) {
  return [
    window.provider,
    window.planType,
    window.limitId,
    window.slot,
    window.windowDurationMins,
    window.resetsAt,
  ].join("|");
}

function snapshotKey(snapshot) {
  return `${windowKey(snapshot.window)}|${snapshot.timestamp}|${snapshot.window.usedPercent}`;
}

function coverageFor(snapshot, scanStartMs) {
  const fullWindowStartMs = (snapshot.window.resetsAt - snapshot.window.windowDurationMins * 60) * 1000;
  const elapsedMs = Math.max(0, snapshot.timestampMs - fullWindowStartMs);
  const locallyCoveredMs = Math.max(0, snapshot.timestampMs - Math.max(scanStartMs, fullWindowStartMs));
  return {
    fullWindowStartsAt: new Date(fullWindowStartMs).toISOString(),
    localScanStartsAt: new Date(scanStartMs).toISOString(),
    elapsedWindowMs: elapsedMs,
    locallyCoveredMs,
    elapsedTimeCoverageFraction: elapsedMs === 0 ? 1 : Math.min(1, locallyCoveredMs / elapsedMs),
    basis: "elapsed_time_only_not_proof_of_complete_local_activity",
  };
}

function makeTransition({ prior, next, usageEvents, toolEvents, scanStartMs, diagnostics }) {
  const windowStartMs = (prior.window.resetsAt - prior.window.windowDurationMins * 60) * 1000;
  const localWindowStartExclusiveMs = Math.max(scanStartMs, windowStartMs) - 1;
  const cumulativePriorCostUsd = aggregateCost(usageEvents, localWindowStartExclusiveMs, prior.timestampMs);
  const cumulativeNextCostUsd = aggregateCost(usageEvents, localWindowStartExclusiveMs, next.timestampMs);
  const cumulativePriorQuotaWeightedLowerUsd = aggregateCumulativeField(usageEvents, localWindowStartExclusiveMs, prior.timestampMs, "cumulativeQuotaWeightedLowerUsd");
  const cumulativeNextQuotaWeightedLowerUsd = aggregateCumulativeField(usageEvents, localWindowStartExclusiveMs, next.timestampMs, "cumulativeQuotaWeightedLowerUsd");
  const cumulativePriorQuotaWeightedUpperUsd = aggregateCumulativeField(usageEvents, localWindowStartExclusiveMs, prior.timestampMs, "cumulativeQuotaWeightedUpperUsd");
  const cumulativeNextQuotaWeightedUpperUsd = aggregateCumulativeField(usageEvents, localWindowStartExclusiveMs, next.timestampMs, "cumulativeQuotaWeightedUpperUsd");
  const marginal = aggregateUsage(usageEvents, prior.timestampMs, next.timestampMs);
  const toolMix = aggregateTools(toolEvents, prior.timestampMs, next.timestampMs);
  const coverage = coverageFor(next, scanStartMs);
  const warnings = new Set(["local_receipt_age_unavailable", "provider_snapshot_age_unavailable"]);
  if (next.window.usedPercent < prior.window.usedPercent) warnings.add("display_percentage_regression");
  if (Math.abs(next.window.usedPercent - prior.window.usedPercent) > 1) warnings.add("display_percentage_skipped_value");
  if (coverage.elapsedTimeCoverageFraction < 1) warnings.add("partial_local_window_coverage");
  if (marginal.eventCount === 0) warnings.add("quota_transition_without_retained_usage_event");
  for (const warning of marginal.pricingWarnings) warnings.add(`pricing:${warning}`);
  const attributionWarnings = Object.hasOwn(marginal.models, "unknown") ? ["unknown_model"] : [];
  for (const warning of attributionWarnings) warnings.add(`attribution:${warning}`);

  return {
    parserVersion: PARSER_VERSION,
    accountScopeId: "unattributed",
    planVariant: "unknown",
    provider: prior.window.provider,
    planType: prior.window.planType,
    limitId: prior.window.limitId,
    slot: prior.window.slot,
    windowDurationMins: prior.window.windowDurationMins,
    resetsAt: prior.window.resetsAt,
    resetIdentity: new Date(prior.window.resetsAt * 1000).toISOString(),
    eventTime: next.timestamp,
    priorUsedPercent: prior.window.usedPercent,
    nextUsedPercent: next.window.usedPercent,
    lastPriorObservedAt: prior.timestamp,
    firstNextObservedAt: next.timestamp,
    lastPriorCumulativeApiPricedUsd: cumulativePriorCostUsd,
    firstNextCumulativeApiPricedUsd: cumulativeNextCostUsd,
    lastPriorCumulativeQuotaWeightedLowerUsd: cumulativePriorQuotaWeightedLowerUsd,
    firstNextCumulativeQuotaWeightedLowerUsd: cumulativeNextQuotaWeightedLowerUsd,
    lastPriorCumulativeQuotaWeightedUpperUsd: cumulativePriorQuotaWeightedUpperUsd,
    firstNextCumulativeQuotaWeightedUpperUsd: cumulativeNextQuotaWeightedUpperUsd,
    marginalApiPricedUsd: marginal.costUsd,
    marginalUsageEventCount: marginal.eventCount,
    marginalComponents: marginal.components,
    modelMix: marginal.models,
    tierUsageEventCounts: marginal.tierUsageEventCounts,
    aggregateToolClassMix: toolMix,
    controlledState: "unknown",
    priceCardIds: marginal.priceCardIds,
    snapshot: {
      source: "rollout_token_count",
      providerSnapshotAgeMs: null,
      localReceiptLagMs: null,
    },
    displayLagEnvelopes: displayLagEnvelopes(
      usageEvents,
      windowStartMs,
      scanStartMs,
      next.timestampMs,
      cumulativeNextCostUsd,
    ),
    quality: {
      localCoverage: coverage,
      replayExclusionsObservedInScan: {
        forkEvents: diagnostics.forkReplayEventsSkipped,
        duplicateUsageEvents: diagnostics.replayedEventsSkipped,
        duplicateToolCalls: diagnostics.replayedToolCallsSkipped,
      },
      malformedRecordsObservedInScan: {
        lines: diagnostics.malformedLines,
        timestamps: diagnostics.malformedTimestamps,
        usage: diagnostics.malformedUsageRecords,
        rateLimits: diagnostics.malformedRateLimitRecords,
      },
      attributionWarnings,
      pricingWarnings: marginal.pricingWarnings,
      warnings: [...warnings].sort(),
    },
  };
}

function makeSnapshotInterval({ prior, next, usageEvents, toolEvents, scanStartMs }) {
  const marginal = aggregateUsage(usageEvents, prior.timestampMs, next.timestampMs);
  const coverage = coverageFor(next, scanStartMs);
  const warnings = [];
  if (next.window.usedPercent < prior.window.usedPercent) warnings.push("display_percentage_regression");
  if (Math.abs(next.window.usedPercent - prior.window.usedPercent) > 1) warnings.push("display_percentage_skipped_value");
  if (coverage.elapsedTimeCoverageFraction < 1) warnings.push("partial_local_window_coverage");
  if (marginal.eventCount === 0) warnings.push("quota_interval_without_retained_usage_event");
  const attributionWarnings = Object.hasOwn(marginal.models, "unknown") ? ["unknown_model"] : [];
  return {
    parserVersion: PARSER_VERSION,
    intervalKind: "adjacent_snapshot_interval",
    accountScopeId: "unattributed",
    planVariant: "unknown",
    provider: prior.window.provider,
    planType: prior.window.planType,
    limitId: prior.window.limitId,
    slot: prior.window.slot,
    windowDurationMins: prior.window.windowDurationMins,
    resetsAt: prior.window.resetsAt,
    resetIdentity: new Date(prior.window.resetsAt * 1000).toISOString(),
    eventTime: next.timestamp,
    priorObservedAt: prior.timestamp,
    elapsedMs: Math.max(0, next.timestampMs - prior.timestampMs),
    priorUsedPercent: prior.window.usedPercent,
    nextUsedPercent: next.window.usedPercent,
    marginalApiPricedUsd: marginal.costUsd,
    marginalUsageEventCount: marginal.eventCount,
    marginalComponents: marginal.components,
    modelMix: Object.fromEntries(Object.entries(marginal.models).map(([model, value]) => [model, {
      events: value.events,
      costUsd: value.costUsd,
    }])),
    tierUsageEventCounts: marginal.tierUsageEventCounts,
    aggregateToolClassMix: aggregateTools(toolEvents, prior.timestampMs, next.timestampMs),
    controlledState: "unknown",
    priceCardIds: marginal.priceCardIds,
    snapshot: {
      source: "rollout_token_count",
      providerSnapshotAgeMs: null,
      localReceiptLagMs: null,
    },
    quality: {
      elapsedTimeCoverageFraction: coverage.elapsedTimeCoverageFraction,
      attributionWarnings,
      pricingWarnings: marginal.pricingWarnings,
      warnings,
    },
  };
}

function collapseTransitions({ snapshots, usageEvents, toolEvents, scanStartMs, diagnostics, includeSnapshotIntervals }) {
  const groups = new Map();
  const deduplicated = new Map();
  for (const snapshot of snapshots) {
    const key = snapshotKey(snapshot);
    if (!deduplicated.has(key)) deduplicated.set(key, snapshot);
  }
  for (const snapshot of deduplicated.values()) {
    const key = windowKey(snapshot.window);
    const group = groups.get(key) ?? [];
    group.push(snapshot);
    groups.set(key, group);
  }

  const transitions = [];
  const snapshotIntervals = [];
  const groupSummaries = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.timestampMs - right.timestampMs || left.window.usedPercent - right.window.usedPercent);
    if (includeSnapshotIntervals) {
      for (let index = 1; index < group.length; index += 1) {
        snapshotIntervals.push({
          ...makeSnapshotInterval({
            prior: group[index - 1],
            next: group[index],
            usageEvents,
            toolEvents,
            scanStartMs,
          }),
        });
      }
    }
    let lastOfRun = group[0];
    let groupTransitionCount = 0;
    let monotonicTransitionCount = 0;
    let regressionTransitionCount = 0;
    for (let index = 1; index < group.length; index += 1) {
      const snapshot = group[index];
      if (snapshot.window.usedPercent === lastOfRun.window.usedPercent) {
        lastOfRun = snapshot;
        continue;
      }
      transitions.push(makeTransition({
        prior: lastOfRun,
        next: snapshot,
        usageEvents,
        toolEvents,
        scanStartMs,
        diagnostics,
      }));
      groupTransitionCount += 1;
      if (snapshot.window.usedPercent > lastOfRun.window.usedPercent) monotonicTransitionCount += 1;
      else regressionTransitionCount += 1;
      lastOfRun = snapshot;
    }
    groupSummaries.push({
      accountScopeId: "unattributed",
      planVariant: "unknown",
      provider: group[0].window.provider,
      planType: group[0].window.planType,
      limitId: group[0].window.limitId,
      slot: group[0].window.slot,
      windowDurationMins: group[0].window.windowDurationMins,
      resetsAt: group[0].window.resetsAt,
      snapshotCount: group.length,
      transitionCount: groupTransitionCount,
      monotonicTransitionCount,
      regressionTransitionCount,
    });
  }
  transitions.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.slot.localeCompare(right.slot));
  snapshotIntervals.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.slot.localeCompare(right.slot));
  groupSummaries.sort((left, right) => left.resetsAt - right.resetsAt || left.slot.localeCompare(right.slot));
  return {
    transitions,
    snapshotIntervals,
    groupSummaries,
    windowGroupCount: groups.size,
    deduplicatedSnapshotCount: deduplicated.size,
  };
}

export async function mineCodexTransitions({
  startAt,
  endAt,
  offline = false,
  codexHome,
  priceCards = null,
  includeSnapshotIntervals = true,
  windowDurationMins = null,
}) {
  const scanStartMs = Date.parse(startAt);
  const scanEndMs = Date.parse(endAt);
  if (!Number.isFinite(scanStartMs) || !Number.isFinite(scanEndMs) || scanEndMs < scanStartMs) {
    throw new Error("startAt and endAt must define a valid chronological interval");
  }
  const baseResolution = priceCards
    ? {
        selected_source: "provided",
        price_cards: priceCards,
        sources: [{ name: "provided", status: "selected", card_count: priceCards.length, selected: true }],
        warnings: [],
      }
    : await resolvePriceCatalog({ provider: "openai", offline });
  const resolution = priceCards ? baseResolution : addOfficialOpenAiPriceSupplements(baseResolution);
  const catalog = compilePriceCatalog(resolution.price_cards);
  const rawUsageEvents = [];
  const snapshots = [];
  const toolEvents = [];
  let sequence = 0;
  const scanned = await scanCodexLogEvents({
    startAt,
    endAt,
    codexHome,
    onUsage(event) {
      rawUsageEvents.push({ ...event, timestampMs: Date.parse(event.timestamp), sequence: sequence++ });
    },
    onRateLimitSnapshot(snapshot) {
      if (windowDurationMins !== null && snapshot.window.windowDurationMins !== windowDurationMins) return;
      snapshots.push({ ...snapshot, sequence: sequence++ });
    },
    onToolCall(event) {
      toolEvents.push({ ...event, sequence: sequence++ });
    },
  });
  rawUsageEvents.sort((left, right) => left.timestampMs - right.timestampMs || left.sequence - right.sequence);
  snapshots.sort((left, right) => left.timestampMs - right.timestampMs || left.sequence - right.sequence);
  toolEvents.sort((left, right) => left.timestampMs - right.timestampMs || left.sequence - right.sequence);
  let cumulativeScanCostUsd = 0;
  let cumulativeQuotaWeightedLowerUsd = 0;
  let cumulativeQuotaWeightedUpperUsd = 0;
  let quotaWeightedSensitivityComplete = true;
  const usageEvents = rawUsageEvents.map((event) => {
    const priced = priceUsageEvent(event, catalog);
    cumulativeScanCostUsd = roundUsd(cumulativeScanCostUsd + priced.costUsd);
    if (!Number.isFinite(priced.quotaWeightedLowerUsd) || !Number.isFinite(priced.quotaWeightedUpperUsd)) {
      quotaWeightedSensitivityComplete = false;
    } else {
      cumulativeQuotaWeightedLowerUsd = roundUsd(cumulativeQuotaWeightedLowerUsd + priced.quotaWeightedLowerUsd);
      cumulativeQuotaWeightedUpperUsd = roundUsd(cumulativeQuotaWeightedUpperUsd + priced.quotaWeightedUpperUsd);
    }
    return {
      ...priced,
      cumulativeScanCostUsd,
      cumulativeQuotaWeightedLowerUsd: quotaWeightedSensitivityComplete ? cumulativeQuotaWeightedLowerUsd : null,
      cumulativeQuotaWeightedUpperUsd: quotaWeightedSensitivityComplete ? cumulativeQuotaWeightedUpperUsd : null,
    };
  });
  const collapsed = collapseTransitions({
    snapshots,
    usageEvents,
    toolEvents,
    scanStartMs,
    diagnostics: scanned.diagnostics,
    includeSnapshotIntervals,
  });
  const pricedEvents = usageEvents.filter((event) => event.warningCodes.length === 0).length;
  const partiallyPricedEvents = usageEvents.length - pricedEvents;
  const warningCounts = {};
  for (const event of usageEvents) {
    for (const warning of event.warningCodes) warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
  }
  const usageEventsByModel = {};
  const tokenComponentsByModel = {};
  const costByModel = {};
  const unpricedModels = new Set();
  for (const event of usageEvents) {
    usageEventsByModel[event.model] = (usageEventsByModel[event.model] ?? 0) + 1;
    const costSummary = costByModel[event.model] ??= { costUsd: 0 };
    costSummary.costUsd += event.costUsd;
    const components = tokenComponentsByModel[event.model] ??= emptyComponents();
    addComponents(components, event.components);
    if (event.warningCodes.length > 0 || event.priceCardIds.length === 0) unpricedModels.add(event.model);
  }
  for (const summary of Object.values(costByModel)) summary.costUsd = roundUsd(summary.costUsd);

  return {
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    materializedAt: new Date(scanEndMs).toISOString(),
    scope: {
      provider: "openai_codex",
      localOnly: true,
      startAt: new Date(scanStartMs).toISOString(),
      endAt: new Date(scanEndMs).toISOString(),
      windowDurationMins,
      snapshotIntervalsIncluded: includeSnapshotIntervals,
    },
    pricing: {
      basis: "standard_openai_api_prices_not_codex_subscription_credits",
      tierSemantics: unknownCodexTier(),
      subscriptionSpeedSensitivity: subscriptionSpeedSensitivity(costByModel),
      observedTierSensitivity: {
        complete: quotaWeightedSensitivityComplete,
        lowerWeightedStandardApiEquivalentUsd: quotaWeightedSensitivityComplete ? cumulativeQuotaWeightedLowerUsd : null,
        upperWeightedStandardApiEquivalentUsd: quotaWeightedSensitivityComplete ? cumulativeQuotaWeightedUpperUsd : null,
        lowerAssumptionForUnknown: "standard",
        upperAssumptionForUnknown: "fast_model_specific",
      },
      serviceTier: {
        observed: null,
        apiPriceAssumption: "standard",
        reason: "Codex token_count logs do not expose an API service tier; standard is an explicit counterfactual pricing assumption.",
      },
      longContext: {
        observedFrom: "per_event_total_input_tokens",
        thresholdTokens: 272000,
      },
      estimatorVersion: ESTIMATOR_VERSION,
      selectedSource: resolution.selected_source,
      sources: resolution.sources.map((source) => ({
        name: source.name,
        status: source.status,
        url: source.url ?? source.resolved_url ?? null,
        retrievedAt: source.retrieved_at ?? null,
        cardCount: source.card_count,
        selected: source.selected ?? false,
      })),
      resolutionWarnings: resolution.warnings.map((warning) => warning.code).sort(),
      eventWarningCounts: warningCounts,
    },
    summary: {
      filesScanned: scanned.diagnostics.filesScanned,
      usageEvents: usageEvents.length,
      pricedEvents,
      partiallyPricedEvents,
      rawRateLimitSnapshots: scanned.diagnostics.rateLimitSnapshots,
      deduplicatedRateLimitSnapshots: collapsed.deduplicatedSnapshotCount,
      resetGroups: collapsed.windowGroupCount,
      transitionResetGroups: collapsed.groupSummaries.filter((group) => group.transitionCount > 0).length,
      transitions: collapsed.transitions.length,
      snapshotIntervals: collapsed.snapshotIntervals.length,
      monotonicTransitions: collapsed.transitions.filter((transition) => transition.nextUsedPercent > transition.priorUsedPercent).length,
      regressionTransitions: collapsed.transitions.filter((transition) => transition.nextUsedPercent < transition.priorUsedPercent).length,
      usageEventsByModel,
      tokenComponentsByModel,
      unpricedModels: [...unpricedModels].sort(),
      toolCallsByClass: toolEvents.reduce((result, event) => {
        result[event.toolClass] = (result[event.toolClass] ?? 0) + 1;
        return result;
      }, {}),
    },
    diagnostics: scanned.diagnostics,
    windowGroups: collapsed.groupSummaries,
    snapshotIntervals: collapsed.snapshotIntervals,
    transitions: collapsed.transitions,
    privacy: {
      excluded: [
        "prompt_and_response_content",
        "credentials_and_authentication_material",
        "stable_account_user_session_and_device_identifiers",
        "repository_paths_filenames_branches_and_project_names",
        "tool_names_arguments_commands_and_conversation_urls",
      ],
      retainedToolDetail: "aggregate_class_counts_only",
    },
  };
}

export function renderTransitionAudit(dataset) {
  const date = dataset.scope.endAt.slice(0, 10);
  const lines = [
    "---",
    "title: Codex Historical Transition Miner Audit",
    `date: ${date}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# Codex Historical Transition Miner Audit",
    "",
    `Scan interval: ${dataset.scope.startAt} through ${dataset.scope.endAt}.`,
    "",
    `Recovered ${dataset.summary.transitions} displayed-percentage transitions across ${dataset.summary.transitionResetGroups} reset groups with transitions (${dataset.summary.resetGroups} total observed reset groups) from ${dataset.summary.deduplicatedRateLimitSnapshots} deduplicated quota snapshots.`,
    "",
    `Priced ${dataset.summary.pricedEvents} of ${dataset.summary.usageEvents} retained usage events at standard OpenAI API rates; ${dataset.summary.partiallyPricedEvents} were partial or unpriced.`,
    "",
    `Transition direction: ${dataset.summary.monotonicTransitions} monotonic increases and ${dataset.summary.regressionTransitions} regressions retained for staleness/contamination analysis.`,
    "",
    "## Parser diagnostics",
    "",
    `- Files scanned: ${dataset.diagnostics.filesScanned}`,
    `- Fork replay events excluded: ${dataset.diagnostics.forkReplayEventsSkipped}`,
    `- Missing lineage parents: ${dataset.diagnostics.lineageParentsMissing}`,
    `- Malformed JSONL lines: ${dataset.diagnostics.malformedLines}`,
    `- Malformed usage records: ${dataset.diagnostics.malformedUsageRecords}`,
    `- Missing rate-limit records: ${dataset.diagnostics.missingRateLimitRecords}`,
    `- Malformed rate-limit records: ${dataset.diagnostics.malformedRateLimitRecords}`,
    "",
    "## Interpretation boundary",
    "",
    "These transitions align local API-price-equivalent activity with provider-displayed integer percentages. They do not reveal the provider's internal quota formula, and partial local coverage or shared usage can make a transition unsuitable for capacity inference.",
    "",
    "Codex speed mode is not present in rollout token records. Standard and Fast subscription sensitivities are recorded separately from API Standard/Priority/Flex/Batch tiers; neither an unknown speed mode nor Fast is interpreted as API Priority.",
    "",
    "## Privacy inspection surface",
    "",
    "The normalized dataset contains timestamps, sanitized plan/limit classifications, quota-window metadata, token counters, pricing provenance, model names, aggregate tool classes, and diagnostics. It excludes conversation content, paths, filenames, tool names and arguments, commands, URLs, credentials, and stable identifiers.",
    "",
  ];
  return lines.join("\n");
}
