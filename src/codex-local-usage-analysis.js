import {
  addUsdStrings,
  apiPriceResolutionSummary,
  aggregateLocalApiPriceResults,
  costWarningCodes,
  fastModeModelFamilyKey,
  priceCodexProviderToolUnits,
  priceCodexUsageEvent,
} from "@app-usagemonitor/accounting";
import {
  createLocalCodexLogScanner,
  subscriptionSpeedSensitivity,
} from "./application/index.js";
import { createLocalCodexLogPorts } from "./platform/index.js";
import {
  unknownCodexTier,
} from "./providers/codex/logs.js";

const { scanCodexLogEvents } = createLocalCodexLogScanner(createLocalCodexLogPorts());

function addComponents(target, source) {
  for (const [name, quantity] of Object.entries(source)) target[name] = (target[name] ?? 0) + quantity;
}

export async function scanAndPriceCodexLogs({
  startAt,
  endAt,
  offline = false,
  codexHome,
  priceCards = null,
  excludeSessionIds = [],
}) {
  const priceResolution = apiPriceResolutionSummary({ priceCards });
  const totals = {};
  const byModel = {};
  const speedWeightingByModel = {};
  const bySurface = {};
  const byDay = {};
  const usageBearingRollouts = new Set();
  const warningCounts = {};
  const tierUsageEventCounts = {};
  const providerToolGroups = new Map();
  let tokenCostUsdExact = "0";
  let eventCount = 0;
  const pricingDiagnostics = { pricedEvents: 0, partiallyPricedEvents: 0, unpricedEvents: 0, longContextEvents: 0 };

  function onProviderToolObservation(observation) {
    if (!observation.serverBillableUnit) return;
    const eventTime = typeof observation.timestamp === "string"
      ? observation.timestamp
      : null;
    const date = eventTime?.slice(0, 10) ?? "unknown";
    const model = observation.model ?? "unknown";
    const surface = observation.surfaceClassification?.surface ?? "local_rollout_unclassified";
    const key = JSON.stringify([date, model, surface]);
    const group = providerToolGroups.get(key) ?? {
      date,
      eventTime,
      model,
      surface,
      serverBillableUnits: {},
    };
    group.serverBillableUnits[observation.serverBillableUnit] =
      (group.serverBillableUnits[observation.serverBillableUnit] ?? 0) + 1;
    providerToolGroups.set(key, group);
  }

  function onUsage(event) {
    eventCount += 1;
    usageBearingRollouts.add(event.sourceRolloutOrdinal);
    if (event.raw.input_tokens >= 272_000) pricingDiagnostics.longContextEvents += 1;
    addComponents(totals, event.components);
    const modelSummary = byModel[event.model] ??= { components: {}, costUsd: 0, costUsdExact: "0", events: 0, warningCounts: {} };
    addComponents(modelSummary.components, event.components);
    modelSummary.events += 1;

    const priced = priceCodexUsageEvent(event, { priceCards });
    const cost = Number(priced.totalUsd);
    const family = fastModeModelFamilyKey(event.model, {
      eventTime: event.timestamp, standardPriceCardIds: priced.selectedPriceCardIds,
    });
    const speedCrossing = speedWeightingByModel[event.model] ??= { unknown: {} };
    const speedCell = speedCrossing.unknown[family] ??= { events: 0, apiPriceEquivalentUsd: 0 };
    speedCell.events += 1;
    speedCell.apiPriceEquivalentUsd += cost;
    tokenCostUsdExact = addUsdStrings(tokenCostUsdExact, priced.totalUsd);
    modelSummary.costUsd += cost;
    modelSummary.costUsdExact = addUsdStrings(modelSummary.costUsdExact, priced.totalUsd);
    const speedMode = event.tierSemantics?.codexSpeedMode ?? "unknown";
    tierUsageEventCounts[speedMode] = (tierUsageEventCounts[speedMode] ?? 0) + 1;
    if (priced.coverageStatus === "fully_priced") pricingDiagnostics.pricedEvents += 1;
    else if (priced.coverageStatus === "partially_priced") pricingDiagnostics.partiallyPricedEvents += 1;
    else pricingDiagnostics.unpricedEvents += 1;
    for (const warningCode of costWarningCodes(priced)) {
      warningCounts[warningCode] = (warningCounts[warningCode] ?? 0) + 1;
      modelSummary.warningCounts[warningCode] = (modelSummary.warningCounts[warningCode] ?? 0) + 1;
    }

    const surface = event.surfaceClassification?.surface ?? "local_rollout_unclassified";
    const eventTokens = Object.values(event.components).reduce((sum, value) => sum + value, 0);
    const surfaceSummary = bySurface[surface] ??= {
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      components: {},
      providerToolUnits: {},
      byModel: {},
      speedModeCounts: {},
    };
    surfaceSummary.events += 1;
    surfaceSummary.totalUsd += cost;
    surfaceSummary.totalUsdExact = addUsdStrings(surfaceSummary.totalUsdExact, priced.totalUsd);
    surfaceSummary.totalTokens += eventTokens;
    addComponents(surfaceSummary.components, event.components);
    surfaceSummary.byModel[event.model] = (surfaceSummary.byModel[event.model] ?? 0) + cost;
    surfaceSummary.speedModeCounts[speedMode] = (surfaceSummary.speedModeCounts[speedMode] ?? 0) + 1;

    const date = event.timestamp.slice(0, 10);
    const day = byDay[date] ??= {
      date,
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      components: {},
      providerToolUnits: {},
      byModel: {},
      speedModeCounts: {},
      bySurface: {},
    };
    day.events += 1;
    day.totalUsd += cost;
    day.totalUsdExact = addUsdStrings(day.totalUsdExact, priced.totalUsd);
    day.totalTokens += eventTokens;
    addComponents(day.components, event.components);
    const dayModel = day.byModel[event.model] ??= {
      events: 0,
      totalTokens: 0,
      costUsd: 0,
      costUsdExact: "0",
      providerToolUnits: {},
    };
    dayModel.events += 1;
    dayModel.totalTokens += eventTokens;
    dayModel.costUsd += cost;
    dayModel.costUsdExact = addUsdStrings(dayModel.costUsdExact, priced.totalUsd);
    day.speedModeCounts[speedMode] = (day.speedModeCounts[speedMode] ?? 0) + 1;
    const daySurface = day.bySurface[surface] ??= {
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      providerToolUnits: {},
    };
    daySurface.events += 1;
    daySurface.totalUsd += cost;
    daySurface.totalUsdExact = addUsdStrings(daySurface.totalUsdExact, priced.totalUsd);
    daySurface.totalTokens += Object.values(event.components).reduce((sum, value) => sum + value, 0);
  }

  const scanned = await scanCodexLogEvents({
    startAt,
    endAt,
    codexHome,
    onUsage,
    onToolCall: onProviderToolObservation,
    excludeSessionIds,
  });
  const tokenSubscriptionSpeedSensitivity = subscriptionSpeedSensitivity(byModel, "unknown", {
    speedWeightingByModel,
  });
  const providerToolPricedGroups = [...providerToolGroups.values()].map((group) => ({
    group,
    priced: priceCodexProviderToolUnits(group.serverBillableUnits, {
      priceCards,
      eventTime: group.eventTime,
    }),
  }));
  const providerToolPricing = providerToolPricedGroups.length > 0
    ? aggregateLocalApiPriceResults(providerToolPricedGroups.map(({ priced }) => priced))
    : { totalUsd: "0", coverageStatus: "fully_priced", selectedPriceCardIds: [] };
  for (const { group, priced } of providerToolPricedGroups) {
    const cost = Number(priced.totalUsd);
    const unitCount = Object.values(group.serverBillableUnits).reduce((sum, value) => sum + value, 0);
    const modelSummary = byModel[group.model] ??= {
      components: {},
      costUsd: 0,
      costUsdExact: "0",
      events: 0,
      warningCounts: {},
    };
    modelSummary.costUsd += cost;
    modelSummary.costUsdExact = addUsdStrings(modelSummary.costUsdExact, priced.totalUsd);
    modelSummary.providerToolCostUsd = (modelSummary.providerToolCostUsd ?? 0) + cost;
    modelSummary.providerToolCostUsdExact = addUsdStrings(
      modelSummary.providerToolCostUsdExact ?? "0",
      priced.totalUsd,
    );
    modelSummary.providerToolUnits ??= {};
    addComponents(modelSummary.providerToolUnits, group.serverBillableUnits);
    modelSummary.providerToolObservationCount =
      (modelSummary.providerToolObservationCount ?? 0) + unitCount;

    const surfaceSummary = bySurface[group.surface] ??= {
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      components: {},
      providerToolUnits: {},
      byModel: {},
      speedModeCounts: {},
    };
    surfaceSummary.totalUsd += cost;
    surfaceSummary.totalUsdExact = addUsdStrings(surfaceSummary.totalUsdExact, priced.totalUsd);
    addComponents(surfaceSummary.providerToolUnits, group.serverBillableUnits);
    surfaceSummary.providerToolObservationCount =
      (surfaceSummary.providerToolObservationCount ?? 0) + unitCount;
    surfaceSummary.byModel[group.model] = (surfaceSummary.byModel[group.model] ?? 0) + cost;

    const day = byDay[group.date] ??= {
      date: group.date,
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      components: {},
      providerToolUnits: {},
      byModel: {},
      speedModeCounts: {},
      bySurface: {},
    };
    day.totalUsd += cost;
    day.totalUsdExact = addUsdStrings(day.totalUsdExact, priced.totalUsd);
    addComponents(day.providerToolUnits, group.serverBillableUnits);
    day.providerToolObservationCount = (day.providerToolObservationCount ?? 0) + unitCount;
    const dayModel = day.byModel[group.model] ??= {
      events: 0,
      totalTokens: 0,
      costUsd: 0,
      costUsdExact: "0",
      providerToolUnits: {},
    };
    dayModel.costUsd += cost;
    dayModel.costUsdExact = addUsdStrings(dayModel.costUsdExact, priced.totalUsd);
    addComponents(dayModel.providerToolUnits, group.serverBillableUnits);
    dayModel.providerToolObservationCount =
      (dayModel.providerToolObservationCount ?? 0) + unitCount;
    const daySurface = day.bySurface[group.surface] ??= {
      events: 0,
      totalUsd: 0,
      totalUsdExact: "0",
      totalTokens: 0,
      providerToolUnits: {},
    };
    daySurface.totalUsd += cost;
    daySurface.totalUsdExact = addUsdStrings(daySurface.totalUsdExact, priced.totalUsd);
    addComponents(daySurface.providerToolUnits, group.serverBillableUnits);
    daySurface.providerToolObservationCount =
      (daySurface.providerToolObservationCount ?? 0) + unitCount;
  }
  const totalUsdExact = addUsdStrings(tokenCostUsdExact, providerToolPricing.totalUsd);
  const diagnostics = {
    ...scanned.diagnostics,
    ...pricingDiagnostics,
    usageBearingRollouts: usageBearingRollouts.size,
    concurrentLocalUsageDetected: usageBearingRollouts.size > 1,
  };

  return {
    startAt,
    endAt,
    eventCount,
    components: totals,
    totalTokens: (totals.input_uncached_tokens ?? 0)
      + (totals.input_cache_read_tokens ?? 0)
      + (totals.input_cache_write_tokens ?? 0)
      + (totals.output_text_tokens ?? 0)
      + (totals.output_reasoning_tokens ?? 0),
    bySurface,
    daily: Object.values(byDay).sort((left, right) => left.date.localeCompare(right.date)),
    runcost: {
      totalUsd: Number(totalUsdExact),
      totalUsdExact,
      tokenCostUsd: Number(tokenCostUsdExact),
      tokenCostUsdExact,
      providerToolCostUsd: Number(providerToolPricing.totalUsd),
      providerToolCostUsdExact: providerToolPricing.totalUsd,
      providerToolPricingCoverage: providerToolPricing.coverageStatus,
      byModel,
      warningCounts,
      tierSemantics: unknownCodexTier(),
      observedTierUsageEventCounts: tierUsageEventCounts,
      // Provider tool charges are reconciled in the monetary rollups above,
      // but Codex speed weighting is a token-model sensitivity only.
      subscriptionSpeedSensitivity: tokenSubscriptionSpeedSensitivity,
      priceResolution: {
        ...priceResolution,
        sources: priceResolution.registry.sources.map((source) => ({
          name: source.evidenceVersion,
          status: "selected",
          url: source.url,
          retrievedAt: source.observedAt,
          cardCount: null,
          selected: true,
        })),
        warnings: [],
      },
    },
    toolCalls: scanned.toolCallsByClass,
    toolCallsByClass: scanned.toolCallsByClass,
    toolObservationsBySource: scanned.toolObservationsBySource,
    serverBillableUnits: scanned.serverBillableUnits,
    diagnostics,
    sourceProvenance: scanned.diagnostics.sourceProvenance,
    assumptions: [
      "input_tokens includes cache-read and cache-write input; uncached input is the remainder",
      "output_tokens includes reasoning output; reasoning is separated before RunCost pricing",
      "forked-session history is excluded by matching cumulative token snapshots against chronologically earlier rollouts; unlabeled fork records are treated as replay",
      "token usage can be attributed to a model but not reliably to an individual user turn or tool",
      "tool calls are retained only as aggregate client-side classes and are not priced without a matching provider-billed unit",
      "Codex token_count logs do not expose API service tier; standard service-tier prices are used only as an explicit API-price-equivalent assumption",
      "historical events use the official card effective at each usable event timestamp; events without usable timing remain explicitly unpriced",
      "typed provider web/file tool units are priced separately; client wrappers and hosted-container calls without exact billable units remain unpriced",
      "Codex Fast is tracked separately from API Priority/Flex/Batch; unknown speed emits sensitivity scenarios and selects neither",
    ],
  };
}
