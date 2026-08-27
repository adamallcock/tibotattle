import { scanCodexLogEvents } from "./codex-log-scan.js";
import { validAbortSignal } from "./valid-abort-signal.js";
import {
  fastQuotaMultiplier,
  subscriptionSpeedSensitivity,
} from "./application/index.js";
import { unknownCodexTier } from "./providers/codex/logs.js";
import {
  addUsdStrings,
  apiPriceResolutionSummary,
  costWarningCodes,
  priceCodexUsageEvent,
} from "@app-usagemonitor/accounting";

const SCHEMA_VERSION = "0.3";
export const PARSER_VERSION = "0.3.2";
const ESTIMATOR_VERSION = "provider-neutral-api-price-equivalent-v0.2";
const COMPONENT_NAMES = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
];
const COOPERATIVE_CHECK_INTERVAL = 2_048;
const MAX_COOPERATIVE_USAGE_EVENTS = 750_000;
const MAX_COOPERATIVE_RATE_LIMIT_SNAPSHOTS = 750_000;
const MAX_COOPERATIVE_TOOL_EVENTS = 100_000;
const MAX_COOPERATIVE_TOTAL_INPUTS = 1_500_000;
const MAX_COOPERATIVE_TRANSITIONS = 10_000;
const MAX_COOPERATIVE_EVENT_VISITS = 8_000_000;

export const CODEX_TRANSITION_DERIVATION_CEILINGS = Object.freeze({
  usageEvents: MAX_COOPERATIVE_USAGE_EVENTS,
  rateLimitSnapshots: MAX_COOPERATIVE_RATE_LIMIT_SNAPSHOTS,
  toolEvents: MAX_COOPERATIVE_TOOL_EVENTS,
  totalInputs: MAX_COOPERATIVE_TOTAL_INPUTS,
  derivedRows: MAX_COOPERATIVE_TRANSITIONS,
  eventVisits: MAX_COOPERATIVE_EVENT_VISITS,
});

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function throwIfDerivationAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("transition_derivation_aborted");
  error.name = "AbortError";
  throw error;
}

async function cooperativeCheckpoint(
  index,
  signal,
  { force = false, resourceCheck = null } = {},
) {
  if (!force && index % COOPERATIVE_CHECK_INTERVAL !== 0) return;
  throwIfDerivationAborted(signal);
  resourceCheck?.();
  await new Promise((resolve) => setImmediate(resolve));
  throwIfDerivationAborted(signal);
  resourceCheck?.();
}

function consumeDerivationWork(guard, count = 1) {
  if (guard === null) return;
  guard.eventVisits += count;
  if (guard.eventVisits > MAX_COOPERATIVE_EVENT_VISITS) {
    throw fixedError("transition_derivation_work_limit_exceeded");
  }
  throwIfDerivationAborted(guard.signal);
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_NAMES.map((name) => [name, 0]));
}

function addComponents(target, source) {
  for (const name of COMPONENT_NAMES) target[name] += source[name] ?? 0;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function priceUsageEvent(event, priceCards) {
  const ledger = priceCodexUsageEvent(event, { priceCards });
  const costUsd = Number(ledger.totalUsd);
  const multiplier = fastQuotaMultiplier(event.model);
  const fastWeightedEquivalentUsd = multiplier === null ? null : costUsd * multiplier;
  const observedSpeedMode = event.tierSemantics?.codexSpeedMode ?? "unknown";
  const speedMode = ["standard", "fast"].includes(observedSpeedMode)
    ? observedSpeedMode
    : ["standard", "fast"].includes(event.declaredSpeed)
      ? event.declaredSpeed
      : "unknown";
  return {
    ...event,
    costUsd,
    costUsdExact: ledger.totalUsd,
    pricingCoverageStatus: ledger.coverageStatus,
    fastWeightedEquivalentUsd,
    quotaWeightedLowerUsd: speedMode === "fast" ? fastWeightedEquivalentUsd : costUsd,
    quotaWeightedUpperUsd: speedMode === "standard" ? costUsd : fastWeightedEquivalentUsd,
    warningCodes: costWarningCodes(ledger),
    coverageWarningCodes: ledger.warnings.coverage.map((warning) => warning.code).sort(),
    priceCardIds: ledger.selectedPriceCardIds,
    priceCardBreakdown: ledger.priceCardBreakdown,
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

function aggregateUsage(
  events,
  startExclusiveMs,
  endInclusiveMs,
  guard = null,
) {
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  const components = emptyComponents();
  const models = {};
  const pricingWarnings = new Set();
  const priceCardIds = new Set();
  const priceCardBreakdown = new Map();
  const tierUsageEventCounts = {};
  let costUsd = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    consumeDerivationWork(guard);
    const event = events[index];
    addComponents(components, event.components);
    costUsd += event.costUsd;
    for (const warning of event.coverageWarningCodes) pricingWarnings.add(warning);
    for (const id of event.priceCardIds) priceCardIds.add(id);
    for (const item of event.priceCardBreakdown ?? []) {
      const row = priceCardBreakdown.get(item.priceCardId) ?? {
        priceCardId: item.priceCardId,
        events: 0,
        costUsd: "0",
      };
      row.events += item.events ?? 0;
      row.costUsd = addUsdStrings(row.costUsd, item.costUsd ?? "0");
      priceCardBreakdown.set(item.priceCardId, row);
    }
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
    priceCardBreakdown: [...priceCardBreakdown.values()].sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
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

function aggregateCumulativeScenarioField(
  events,
  startExclusiveMs,
  endInclusiveMs,
  field,
  unknownField,
) {
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  const startValue = startIndex === 0 ? 0 : events[startIndex - 1][field];
  const endValue = endIndex === 0 ? 0 : events[endIndex - 1][field];
  const startUnknown = startIndex === 0
    ? 0
    : events[startIndex - 1][unknownField];
  const endUnknown = endIndex === 0 ? 0 : events[endIndex - 1][unknownField];
  if (!Number.isSafeInteger(startUnknown)
      || !Number.isSafeInteger(endUnknown)
      || endUnknown !== startUnknown) return null;
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  return roundUsd(endValue - startValue);
}

function aggregateTools(
  events,
  startExclusiveMs,
  endInclusiveMs,
  guard = null,
) {
  const result = {};
  const startIndex = upperBound(events, startExclusiveMs);
  const endIndex = upperBound(events, endInclusiveMs);
  for (let index = startIndex; index < endIndex; index += 1) {
    consumeDerivationWork(guard);
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

// Quota window identity is (provider, plan, limit, duration, resetsAt). The
// provider's primary/secondary slots are server-assigned UI roles — the
// weekly 10080-minute window flipped secondary -> primary around 2026-07-06 —
// so slot is carried on rows as display provenance but never keys a group:
// keying on it split one continuous weekly series at the flip.
function windowKey(window) {
  return [
    window.provider,
    window.planType,
    window.limitId,
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

function makeTransition({
  prior,
  next,
  usageEvents,
  toolEvents,
  scanStartMs,
  diagnostics,
  guard = null,
}) {
  const windowStartMs = (prior.window.resetsAt - prior.window.windowDurationMins * 60) * 1000;
  const localWindowStartExclusiveMs = Math.max(scanStartMs, windowStartMs) - 1;
  const cumulativePriorCostUsd = aggregateCost(usageEvents, localWindowStartExclusiveMs, prior.timestampMs);
  const cumulativeNextCostUsd = aggregateCost(usageEvents, localWindowStartExclusiveMs, next.timestampMs);
  const cumulativePriorQuotaWeightedLowerUsd = aggregateCumulativeScenarioField(usageEvents, localWindowStartExclusiveMs, prior.timestampMs, "cumulativeQuotaWeightedLowerUsd", "cumulativeQuotaWeightedLowerUnknownEvents");
  const cumulativeNextQuotaWeightedLowerUsd = aggregateCumulativeScenarioField(usageEvents, localWindowStartExclusiveMs, next.timestampMs, "cumulativeQuotaWeightedLowerUsd", "cumulativeQuotaWeightedLowerUnknownEvents");
  const cumulativePriorQuotaWeightedUpperUsd = aggregateCumulativeScenarioField(usageEvents, localWindowStartExclusiveMs, prior.timestampMs, "cumulativeQuotaWeightedUpperUsd", "cumulativeQuotaWeightedUpperUnknownEvents");
  const cumulativeNextQuotaWeightedUpperUsd = aggregateCumulativeScenarioField(usageEvents, localWindowStartExclusiveMs, next.timestampMs, "cumulativeQuotaWeightedUpperUsd", "cumulativeQuotaWeightedUpperUnknownEvents");
  const marginal = aggregateUsage(
    usageEvents,
    prior.timestampMs,
    next.timestampMs,
    guard,
  );
  const toolMix = aggregateTools(
    toolEvents,
    prior.timestampMs,
    next.timestampMs,
    guard,
  );
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
    priceCardBreakdown: marginal.priceCardBreakdown,
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

function makeSnapshotInterval({
  prior,
  next,
  usageEvents,
  toolEvents,
  scanStartMs,
  guard = null,
}) {
  const marginal = aggregateUsage(
    usageEvents,
    prior.timestampMs,
    next.timestampMs,
    guard,
  );
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
    aggregateToolClassMix: aggregateTools(
      toolEvents,
      prior.timestampMs,
      next.timestampMs,
      guard,
    ),
    controlledState: "unknown",
    priceCardIds: marginal.priceCardIds,
    priceCardBreakdown: marginal.priceCardBreakdown,
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
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  snapshotIntervals.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  groupSummaries.sort((left, right) => left.resetsAt - right.resetsAt
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  return {
    transitions,
    snapshotIntervals,
    groupSummaries,
    windowGroupCount: groups.size,
    deduplicatedSnapshotCount: deduplicated.size,
  };
}

function decodeCompactAccountingUsage(value) {
  if (!Array.isArray(value) || value.length !== 10) return null;
  return {
    timestamp: value[0],
    model: value[1],
    totalInputContextTokens: value[2],
    components: {
      input_uncached_tokens: value[3],
      input_cache_read_tokens: value[4],
      input_cache_write_tokens: value[5],
      output_text_tokens: value[6],
      output_reasoning_tokens: value[7],
      output_combined_tokens: value[8],
    },
    tierSemantics: {
      codexSpeedMode: value[9],
      apiServiceTier: "unknown",
    },
  };
}

function decodePrepricedCompactAccountingUsage(value) {
  if (!Array.isArray(value)
      || ![19, 20].includes(value.length)
      || !Array.isArray(value[16])
      || !Array.isArray(value[17])
      || !Array.isArray(value[18])) return null;
  if (value.length === 20 && !Array.isArray(value[19])) return null;
  const base = decodeCompactAccountingUsage(value.slice(0, 10));
  if (base === null) return null;
  return {
    ...base,
    costUsd: value[10],
    costUsdExact: value[11],
    pricingCoverageStatus: value[12],
    fastWeightedEquivalentUsd: value[13],
    quotaWeightedLowerUsd: value[14],
    quotaWeightedUpperUsd: value[15],
    warningCodes: value[16],
    coverageWarningCodes: value[17],
    priceCardIds: value[18],
    priceCardBreakdown: value[19] ?? [],
    prepricedAccountingInput: true,
  };
}

// The replay-cache calibration never returns normalized usage events; it only
// needs the fields consumed while collapsing quota transitions. Decode its v2
// compact rows directly into that working shape instead of materializing the
// full public event and then spreading it twice. On a 500k-event history those
// short-lived copies otherwise dominate the RSS peak even though the durable
// output is only a bounded reset summary.
function decodeLeanPrepricedCompactAccountingUsage(value, sequence) {
  if (!Array.isArray(value)
      || value.length !== 20
      || !Array.isArray(value[16])
      || !Array.isArray(value[17])
      || !Array.isArray(value[18])
      || !Array.isArray(value[19])) return null;
  const timestampMs = Date.parse(value[0]);
  return {
    timestamp: value[0],
    timestampMs,
    sequence,
    model: value[1],
    components: {
      input_uncached_tokens: value[3],
      input_cache_read_tokens: value[4],
      input_cache_write_tokens: value[5],
      output_text_tokens: value[6],
      output_reasoning_tokens: value[7],
      output_combined_tokens: value[8],
    },
    tierSemantics: { codexSpeedMode: value[9] },
    costUsd: value[10],
    costUsdExact: value[11],
    quotaWeightedLowerUsd: value[14],
    quotaWeightedUpperUsd: value[15],
    coverageWarningCodes: value[17],
    priceCardIds: value[18],
    priceCardBreakdown: value[19],
    prepricedAccountingInput: true,
  };
}

function decodeCompactAccountingSnapshot(value) {
  if (!Array.isArray(value) || value.length !== 9) return null;
  return {
    timestamp: value[0],
    timestampMs: value[1],
    window: {
      provider: value[2],
      planType: value[3],
      limitId: value[4],
      slot: value[5],
      windowDurationMins: value[6],
      resetsAt: value[7],
      usedPercent: value[8],
    },
  };
}

async function normalizeTransitionInputsCooperatively({
  rawUsageEvents,
  rateLimitSnapshots,
  rawToolEvents,
  scanStartMs,
  scanEndMs,
  windowDurationMins,
  signal,
  consumeInputs,
  inputEncoding,
  leanPrepricedInput,
  resourceCheck,
}) {
  let sequence = 0;
  const usageInput = [];
  for (let index = 0; index < rawUsageEvents.length; index += 1) {
    await cooperativeCheckpoint(index, signal, { resourceCheck });
    const source = rawUsageEvents[index];
    if (consumeInputs) rawUsageEvents[index] = null;
    if (leanPrepricedInput) {
      const normalized = decodeLeanPrepricedCompactAccountingUsage(
        source,
        sequence,
      );
      if (normalized === null) continue;
      sequence += 1;
      if (Number.isFinite(normalized.timestampMs)
          && normalized.timestampMs >= scanStartMs
          && normalized.timestampMs <= scanEndMs) {
        usageInput.push(normalized);
      }
      continue;
    }
    const event = inputEncoding === "accounting_compact_v1"
      ? decodeCompactAccountingUsage(source)
      : ["accounting_prepriced_compact_v1", "accounting_prepriced_compact_v2"].includes(inputEncoding)
        ? decodePrepricedCompactAccountingUsage(source)
        : source;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const normalized = {
      ...event,
      timestampMs: Date.parse(event.timestamp),
      sequence: sequence++,
    };
    if (Number.isFinite(normalized.timestampMs)
        && normalized.timestampMs >= scanStartMs
        && normalized.timestampMs <= scanEndMs) {
      usageInput.push(normalized);
    }
  }
  if (consumeInputs) rawUsageEvents.length = 0;
  await cooperativeCheckpoint(rawUsageEvents.length, signal, {
    force: true,
    resourceCheck,
  });
  usageInput.sort((left, right) => left.timestampMs - right.timestampMs
    || left.sequence - right.sequence);
  await cooperativeCheckpoint(usageInput.length, signal, {
    force: true,
    resourceCheck,
  });

  const snapshots = [];
  for (let index = 0; index < rateLimitSnapshots.length; index += 1) {
    await cooperativeCheckpoint(index, signal, { resourceCheck });
    const source = rateLimitSnapshots[index];
    if (consumeInputs) rateLimitSnapshots[index] = null;
    const snapshot = [
      "accounting_compact_v1",
      "accounting_prepriced_compact_v1",
      "accounting_prepriced_compact_v2",
    ].includes(inputEncoding)
      ? decodeCompactAccountingSnapshot(source)
      : source;
    if (!snapshot || typeof snapshot !== "object"
        || Array.isArray(snapshot)
        || !snapshot.window
        || typeof snapshot.window !== "object"
        || (windowDurationMins !== null
          && snapshot.window.windowDurationMins !== windowDurationMins)) {
      continue;
    }
    const normalized = {
      ...snapshot,
      timestampMs: Number.isFinite(snapshot.timestampMs)
        ? snapshot.timestampMs
        : Date.parse(snapshot.timestamp),
      sequence: sequence++,
    };
    if (Number.isFinite(normalized.timestampMs)
        && normalized.timestampMs >= scanStartMs
        && normalized.timestampMs <= scanEndMs) {
      snapshots.push(normalized);
    }
  }
  if (consumeInputs) rateLimitSnapshots.length = 0;
  await cooperativeCheckpoint(rateLimitSnapshots.length, signal, {
    force: true,
    resourceCheck,
  });
  snapshots.sort((left, right) => left.timestampMs - right.timestampMs
    || left.sequence - right.sequence);
  await cooperativeCheckpoint(snapshots.length, signal, {
    force: true,
    resourceCheck,
  });

  const toolEvents = [];
  for (let index = 0; index < rawToolEvents.length; index += 1) {
    await cooperativeCheckpoint(index, signal, { resourceCheck });
    const event = rawToolEvents[index];
    if (consumeInputs) rawToolEvents[index] = null;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const normalized = {
      ...event,
      timestampMs: Number.isFinite(event.timestampMs)
        ? event.timestampMs
        : Date.parse(event.timestamp),
      sequence: sequence++,
    };
    if (Number.isFinite(normalized.timestampMs)
        && normalized.timestampMs >= scanStartMs
        && normalized.timestampMs <= scanEndMs) {
      toolEvents.push(normalized);
    }
  }
  if (consumeInputs) rawToolEvents.length = 0;
  await cooperativeCheckpoint(rawToolEvents.length, signal, {
    force: true,
    resourceCheck,
  });
  toolEvents.sort((left, right) => left.timestampMs - right.timestampMs
    || left.sequence - right.sequence);
  await cooperativeCheckpoint(toolEvents.length, signal, {
    force: true,
    resourceCheck,
  });

  return { usageInput, snapshots, toolEvents };
}

async function priceUsageEventsCooperatively({
  usageInput,
  priceCards,
  signal,
  resourceCheck,
}) {
  let cumulativeScanCostUsd = 0;
  let cumulativeScanCostUsdExact = "0";
  let cumulativeQuotaWeightedLowerUsd = 0;
  let cumulativeQuotaWeightedUpperUsd = 0;
  let cumulativeQuotaWeightedLowerUnknownEvents = 0;
  let cumulativeQuotaWeightedUpperUnknownEvents = 0;
  const usageEvents = [];
  for (let index = 0; index < usageInput.length; index += 1) {
    await cooperativeCheckpoint(index, signal, { resourceCheck });
    const priced = usageInput[index].prepricedAccountingInput === true
      ? usageInput[index]
      : priceUsageEvent(usageInput[index], priceCards);
    cumulativeScanCostUsd = roundUsd(cumulativeScanCostUsd + priced.costUsd);
    cumulativeScanCostUsdExact = addUsdStrings(
      cumulativeScanCostUsdExact,
      priced.costUsdExact,
    );
    if (Number.isFinite(priced.quotaWeightedLowerUsd)) {
      cumulativeQuotaWeightedLowerUsd = roundUsd(
        cumulativeQuotaWeightedLowerUsd + priced.quotaWeightedLowerUsd,
      );
    } else {
      cumulativeQuotaWeightedLowerUnknownEvents += 1;
    }
    if (Number.isFinite(priced.quotaWeightedUpperUsd)) {
      cumulativeQuotaWeightedUpperUsd = roundUsd(
        cumulativeQuotaWeightedUpperUsd + priced.quotaWeightedUpperUsd,
      );
    } else {
      cumulativeQuotaWeightedUpperUnknownEvents += 1;
    }
    if (priced.prepricedAccountingInput === true) {
      priced.cumulativeScanCostUsd = cumulativeScanCostUsd;
      priced.cumulativeScanCostUsdExact = cumulativeScanCostUsdExact;
      priced.cumulativeQuotaWeightedLowerUsd =
        cumulativeQuotaWeightedLowerUsd;
      priced.cumulativeQuotaWeightedUpperUsd =
        cumulativeQuotaWeightedUpperUsd;
      priced.cumulativeQuotaWeightedLowerUnknownEvents =
        cumulativeQuotaWeightedLowerUnknownEvents;
      priced.cumulativeQuotaWeightedUpperUnknownEvents =
        cumulativeQuotaWeightedUpperUnknownEvents;
      usageEvents.push(priced);
    } else {
      usageEvents.push({
        ...priced,
        cumulativeScanCostUsd,
        cumulativeScanCostUsdExact,
        cumulativeQuotaWeightedLowerUsd,
        cumulativeQuotaWeightedUpperUsd,
        cumulativeQuotaWeightedLowerUnknownEvents,
        cumulativeQuotaWeightedUpperUnknownEvents,
      });
    }
    usageInput[index] = null;
  }
  usageInput.length = 0;
  await cooperativeCheckpoint(usageEvents.length, signal, {
    force: true,
    resourceCheck,
  });
  const quotaWeightedSensitivityComplete =
    cumulativeQuotaWeightedLowerUnknownEvents === 0
    && cumulativeQuotaWeightedUpperUnknownEvents === 0;
  return {
    usageEvents,
    quotaWeightedSensitivityComplete,
    cumulativeScanCostUsd,
    cumulativeScanCostUsdExact,
    cumulativeQuotaWeightedLowerUsd: quotaWeightedSensitivityComplete
      ? cumulativeQuotaWeightedLowerUsd
      : null,
    cumulativeQuotaWeightedUpperUsd: quotaWeightedSensitivityComplete
      ? cumulativeQuotaWeightedUpperUsd
      : null,
  };
}

async function collapseTransitionsCooperatively({
  snapshots,
  usageEvents,
  toolEvents,
  scanStartMs,
  diagnostics,
  includeSnapshotIntervals,
  signal,
  resourceCheck,
}) {
  const guard = { signal, eventVisits: 0 };
  const groups = new Map();
  const deduplicated = new Map();
  for (let index = 0; index < snapshots.length; index += 1) {
    await cooperativeCheckpoint(index, signal, { resourceCheck });
    const snapshot = snapshots[index];
    const key = snapshotKey(snapshot);
    if (!deduplicated.has(key)) deduplicated.set(key, snapshot);
  }
  let grouped = 0;
  for (const snapshot of deduplicated.values()) {
    await cooperativeCheckpoint(grouped, signal, { resourceCheck });
    grouped += 1;
    const key = windowKey(snapshot.window);
    const group = groups.get(key) ?? [];
    group.push(snapshot);
    groups.set(key, group);
  }

  const transitions = [];
  const snapshotIntervals = [];
  const groupSummaries = [];
  let derivedRows = 0;
  let groupIndex = 0;
  for (const group of groups.values()) {
    await cooperativeCheckpoint(groupIndex, signal, {
      force: true,
      resourceCheck,
    });
    groupIndex += 1;
    group.sort((left, right) => left.timestampMs - right.timestampMs
      || left.window.usedPercent - right.window.usedPercent);
    if (includeSnapshotIntervals) {
      for (let index = 1; index < group.length; index += 1) {
        await cooperativeCheckpoint(index, signal, { resourceCheck });
        derivedRows += 1;
        if (derivedRows > MAX_COOPERATIVE_TRANSITIONS) {
          throw fixedError("transition_derivation_row_limit_exceeded");
        }
        snapshotIntervals.push(makeSnapshotInterval({
          prior: group[index - 1],
          next: group[index],
          usageEvents,
          toolEvents,
          scanStartMs,
          guard,
        }));
      }
    }
    let lastOfRun = group[0];
    let groupTransitionCount = 0;
    let monotonicTransitionCount = 0;
    let regressionTransitionCount = 0;
    for (let index = 1; index < group.length; index += 1) {
      await cooperativeCheckpoint(index, signal, { resourceCheck });
      const snapshot = group[index];
      if (snapshot.window.usedPercent === lastOfRun.window.usedPercent) {
        lastOfRun = snapshot;
        continue;
      }
      derivedRows += 1;
      if (derivedRows > MAX_COOPERATIVE_TRANSITIONS) {
        throw fixedError("transition_derivation_row_limit_exceeded");
      }
      transitions.push(makeTransition({
        prior: lastOfRun,
        next: snapshot,
        usageEvents,
        toolEvents,
        scanStartMs,
        diagnostics,
        guard,
      }));
      groupTransitionCount += 1;
      if (snapshot.window.usedPercent > lastOfRun.window.usedPercent) {
        monotonicTransitionCount += 1;
      } else {
        regressionTransitionCount += 1;
      }
      lastOfRun = snapshot;
    }
    groupSummaries.push({
      accountScopeId: "unattributed",
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
  await cooperativeCheckpoint(derivedRows, signal, {
    force: true,
    resourceCheck,
  });
  transitions.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  snapshotIntervals.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  groupSummaries.sort((left, right) => left.resetsAt - right.resetsAt
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  throwIfDerivationAborted(signal);
  return {
    transitions,
    snapshotIntervals,
    groupSummaries,
    windowGroupCount: groups.size,
    deduplicatedSnapshotCount: deduplicated.size,
  };
}

export async function deriveCodexTransitionSeriesCooperatively({
  startAt,
  endAt,
  rawUsageEvents = [],
  rateLimitSnapshots = [],
  toolEvents: rawToolEvents = [],
  diagnostics = {},
  priceCards = null,
  includeSnapshotIntervals = true,
  windowDurationMins = null,
  signal = null,
  consumeInputs = false,
  includeNormalizedInputs = true,
  inputEncoding = "object",
  resourceCheck = null,
} = {}) {
  const scanStartMs = Date.parse(startAt);
  const scanEndMs = Date.parse(endAt);
  if (!Number.isFinite(scanStartMs)
      || !Number.isFinite(scanEndMs)
      || scanEndMs < scanStartMs
      || !Array.isArray(rawUsageEvents)
      || !Array.isArray(rateLimitSnapshots)
      || !Array.isArray(rawToolEvents)
      || typeof diagnostics !== "object"
      || diagnostics === null
      || !validAbortSignal(signal)
      || typeof consumeInputs !== "boolean"
      || typeof includeNormalizedInputs !== "boolean"
      || (resourceCheck !== null && typeof resourceCheck !== "function")
      || ![
        "object",
        "accounting_compact_v1",
        "accounting_prepriced_compact_v1",
        "accounting_prepriced_compact_v2",
      ].includes(inputEncoding)) {
    throw new TypeError("Cooperative transition series inputs are invalid");
  }
  const totalInputs = rawUsageEvents.length
    + rateLimitSnapshots.length
    + rawToolEvents.length;
  if (rawUsageEvents.length > MAX_COOPERATIVE_USAGE_EVENTS
      || rateLimitSnapshots.length > MAX_COOPERATIVE_RATE_LIMIT_SNAPSHOTS
      || rawToolEvents.length > MAX_COOPERATIVE_TOOL_EVENTS
      || totalInputs > MAX_COOPERATIVE_TOTAL_INPUTS) {
    throw fixedError("transition_derivation_input_limit_exceeded");
  }
  await cooperativeCheckpoint(0, signal, { force: true, resourceCheck });
  const normalized = await normalizeTransitionInputsCooperatively({
    rawUsageEvents,
    rateLimitSnapshots,
    rawToolEvents,
    scanStartMs,
    scanEndMs,
    windowDurationMins,
    signal,
    consumeInputs,
    inputEncoding,
    leanPrepricedInput:
      inputEncoding === "accounting_prepriced_compact_v2"
      && includeNormalizedInputs === false,
    resourceCheck,
  });
  const priced = await priceUsageEventsCooperatively({
    usageInput: normalized.usageInput,
    priceCards,
    signal,
    resourceCheck,
  });
  const collapsed = await collapseTransitionsCooperatively({
    snapshots: normalized.snapshots,
    usageEvents: priced.usageEvents,
    toolEvents: normalized.toolEvents,
    scanStartMs,
    diagnostics,
    includeSnapshotIntervals,
    signal,
    resourceCheck,
  });
  return {
    ...collapsed,
    ...(includeNormalizedInputs
      ? {
        usageEvents: priced.usageEvents,
        rateLimitSnapshots: normalized.snapshots,
        toolEvents: normalized.toolEvents,
      }
      : {}),
    quotaWeightedSensitivityComplete:
      priced.quotaWeightedSensitivityComplete,
    cumulativeScanCostUsd: priced.cumulativeScanCostUsd,
    cumulativeScanCostUsdExact: priced.cumulativeScanCostUsdExact,
    cumulativeQuotaWeightedLowerUsd:
      priced.cumulativeQuotaWeightedLowerUsd,
    cumulativeQuotaWeightedUpperUsd:
      priced.cumulativeQuotaWeightedUpperUsd,
  };
}

export function deriveCodexTransitionSeries({
  startAt,
  endAt,
  rawUsageEvents = [],
  rateLimitSnapshots = [],
  toolEvents: rawToolEvents = [],
  diagnostics = {},
  priceCards = null,
  includeSnapshotIntervals = true,
  windowDurationMins = null,
} = {}) {
  const scanStartMs = Date.parse(startAt);
  const scanEndMs = Date.parse(endAt);
  if (!Number.isFinite(scanStartMs)
      || !Number.isFinite(scanEndMs)
      || scanEndMs < scanStartMs
      || !Array.isArray(rawUsageEvents)
      || !Array.isArray(rateLimitSnapshots)
      || !Array.isArray(rawToolEvents)
      || typeof diagnostics !== "object"
      || diagnostics === null) {
    throw new TypeError("Transition series inputs are invalid");
  }
  let sequence = 0;
  const usageInput = rawUsageEvents
    .filter((event) => event && typeof event === "object"
      && !Array.isArray(event))
    .map((event) => ({
      ...event,
      timestampMs: Date.parse(event.timestamp),
      sequence: sequence++,
    }))
    .filter((event) => Number.isFinite(event.timestampMs)
      && event.timestampMs >= scanStartMs
      && event.timestampMs <= scanEndMs)
    .sort((left, right) => left.timestampMs - right.timestampMs
      || left.sequence - right.sequence);
  const snapshots = rateLimitSnapshots
    .filter((snapshot) => snapshot && typeof snapshot === "object"
      && !Array.isArray(snapshot)
      && snapshot.window && typeof snapshot.window === "object"
      && (windowDurationMins === null
        || snapshot.window.windowDurationMins === windowDurationMins))
    .map((snapshot) => ({
      ...snapshot,
      timestampMs: Number.isFinite(snapshot.timestampMs)
        ? snapshot.timestampMs
        : Date.parse(snapshot.timestamp),
      sequence: sequence++,
    }))
    .filter((snapshot) => Number.isFinite(snapshot.timestampMs)
      && snapshot.timestampMs >= scanStartMs
      && snapshot.timestampMs <= scanEndMs)
    .sort((left, right) => left.timestampMs - right.timestampMs
      || left.sequence - right.sequence);
  const toolEvents = rawToolEvents
    .filter((event) => event && typeof event === "object"
      && !Array.isArray(event))
    .map((event) => ({
      ...event,
      timestampMs: Number.isFinite(event.timestampMs)
        ? event.timestampMs
        : Date.parse(event.timestamp),
      sequence: sequence++,
    }))
    .filter((event) => Number.isFinite(event.timestampMs)
      && event.timestampMs >= scanStartMs
      && event.timestampMs <= scanEndMs)
    .sort((left, right) => left.timestampMs - right.timestampMs
      || left.sequence - right.sequence);
  let cumulativeScanCostUsd = 0;
  let cumulativeScanCostUsdExact = "0";
  let cumulativeQuotaWeightedLowerUsd = 0;
  let cumulativeQuotaWeightedUpperUsd = 0;
  let cumulativeQuotaWeightedLowerUnknownEvents = 0;
  let cumulativeQuotaWeightedUpperUnknownEvents = 0;
  const usageEvents = usageInput.map((event) => {
    const priced = priceUsageEvent(event, priceCards);
    cumulativeScanCostUsd = roundUsd(cumulativeScanCostUsd + priced.costUsd);
    cumulativeScanCostUsdExact = addUsdStrings(
      cumulativeScanCostUsdExact,
      priced.costUsdExact,
    );
    if (Number.isFinite(priced.quotaWeightedLowerUsd)) {
      cumulativeQuotaWeightedLowerUsd = roundUsd(
        cumulativeQuotaWeightedLowerUsd + priced.quotaWeightedLowerUsd,
      );
    } else {
      cumulativeQuotaWeightedLowerUnknownEvents += 1;
    }
    if (Number.isFinite(priced.quotaWeightedUpperUsd)) {
      cumulativeQuotaWeightedUpperUsd = roundUsd(
        cumulativeQuotaWeightedUpperUsd + priced.quotaWeightedUpperUsd,
      );
    } else {
      cumulativeQuotaWeightedUpperUnknownEvents += 1;
    }
    return {
      ...priced,
      cumulativeScanCostUsd,
      cumulativeScanCostUsdExact,
      cumulativeQuotaWeightedLowerUsd,
      cumulativeQuotaWeightedUpperUsd,
      cumulativeQuotaWeightedLowerUnknownEvents,
      cumulativeQuotaWeightedUpperUnknownEvents,
    };
  });
  const quotaWeightedSensitivityComplete =
    cumulativeQuotaWeightedLowerUnknownEvents === 0
    && cumulativeQuotaWeightedUpperUnknownEvents === 0;
  const collapsed = collapseTransitions({
    snapshots,
    usageEvents,
    toolEvents,
    scanStartMs,
    diagnostics,
    includeSnapshotIntervals,
  });
  return {
    ...collapsed,
    usageEvents,
    rateLimitSnapshots: snapshots,
    toolEvents,
    quotaWeightedSensitivityComplete,
    cumulativeScanCostUsd,
    cumulativeScanCostUsdExact,
    cumulativeQuotaWeightedLowerUsd: quotaWeightedSensitivityComplete
      ? cumulativeQuotaWeightedLowerUsd
      : null,
    cumulativeQuotaWeightedUpperUsd: quotaWeightedSensitivityComplete
      ? cumulativeQuotaWeightedUpperUsd
      : null,
  };
}

export async function mineCodexTransitions({
  startAt,
  endAt,
  offline = false,
  codexHome,
  codexHomes,
  priceCards = null,
  includeSnapshotIntervals = true,
  windowDurationMins = null,
}) {
  const scanStartMs = Date.parse(startAt);
  const scanEndMs = Date.parse(endAt);
  if (!Number.isFinite(scanStartMs) || !Number.isFinite(scanEndMs) || scanEndMs < scanStartMs) {
    throw new Error("startAt and endAt must define a valid chronological interval");
  }
  const priceResolution = apiPriceResolutionSummary({ priceCards });
  const rawUsageEvents = [];
  const snapshots = [];
  const toolEvents = [];
  let sequence = 0;
  const scanned = await scanCodexLogEvents({
    startAt,
    endAt,
    codexHome,
    codexHomes,
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
  const derived = deriveCodexTransitionSeries({
    startAt,
    endAt,
    rawUsageEvents,
    rateLimitSnapshots: snapshots,
    toolEvents,
    diagnostics: scanned.diagnostics,
    priceCards,
    includeSnapshotIntervals,
    windowDurationMins,
  });
  const {
    usageEvents,
    quotaWeightedSensitivityComplete,
    cumulativeScanCostUsdExact,
    cumulativeQuotaWeightedLowerUsd,
    cumulativeQuotaWeightedUpperUsd,
  } = derived;
  const pricedEvents = usageEvents.filter((event) => event.pricingCoverageStatus === "fully_priced").length;
  const partiallyPricedEvents = usageEvents.filter((event) => event.pricingCoverageStatus === "partially_priced").length;
  const unpricedEvents = usageEvents.filter((event) => event.pricingCoverageStatus === "unpriced").length;
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
    if (event.pricingCoverageStatus !== "fully_priced" || event.priceCardIds.length === 0) unpricedModels.add(event.model);
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
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      eventTimeHistoricalTotalUsdExact: cumulativeScanCostUsdExact,
      // This field is reserved for a registry-observation/current-card
      // sensitivity total. The miner above is explicitly historical, so a
      // historical cumulative total must never be exposed under this name.
      currentPriceSensitivityTotalUsdExact: null,
      selectedSource: priceResolution.selectedSource,
      registry: priceResolution.registry,
      sources: priceResolution.registry.sources.map((source) => ({
        name: source.evidenceVersion,
        status: "selected",
        url: source.url,
        retrievedAt: source.observedAt,
        cardCount: null,
        selected: true,
      })),
      resolutionWarnings: [],
      eventWarningCounts: warningCounts,
    },
    summary: {
      filesScanned: scanned.diagnostics.filesScanned,
      usageEvents: usageEvents.length,
      pricedEvents,
      partiallyPricedEvents,
      unpricedEvents,
      rawRateLimitSnapshots: scanned.diagnostics.rateLimitSnapshots,
      deduplicatedRateLimitSnapshots: derived.deduplicatedSnapshotCount,
      resetGroups: derived.windowGroupCount,
      transitionResetGroups: derived.groupSummaries.filter((group) => group.transitionCount > 0).length,
      transitions: derived.transitions.length,
      snapshotIntervals: derived.snapshotIntervals.length,
      monotonicTransitions: derived.transitions.filter((transition) => transition.nextUsedPercent > transition.priorUsedPercent).length,
      regressionTransitions: derived.transitions.filter((transition) => transition.nextUsedPercent < transition.priorUsedPercent).length,
      usageEventsByModel,
      tokenComponentsByModel,
      unpricedModels: [...unpricedModels].sort(),
      toolCallsByClass: toolEvents.reduce((result, event) => {
        result[event.toolClass] = (result[event.toolClass] ?? 0) + 1;
        return result;
      }, {}),
    },
    diagnostics: scanned.diagnostics,
    windowGroups: derived.groupSummaries,
    snapshotIntervals: derived.snapshotIntervals,
    transitions: derived.transitions,
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
