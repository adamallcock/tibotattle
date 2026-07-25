import { addUsdStrings, aggregateCostResults, priceUsageEvent } from "./cost-ledger.js";
import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  APP_PRICE_REGISTRY_OBSERVED_AT,
} from "./price-registry.js";

export const LOCAL_API_PRICING_METHOD_VERSION = "provider-neutral-api-price-equivalent-v0.1";

const CODEX_TOOL_UNIT_MAPPING = Object.freeze({
  responses_web_search_call: Object.freeze({ name: "web_search_units", unit: "search" }),
  responses_file_search_call: Object.freeze({ name: "file_search_units", unit: "call" }),
});

const UNKNOWN_PROVIDER_TOOL_UNIT = Object.freeze({
  name: "unknown_provider_billable_units",
  unit: "custom",
});

function priceEpoch({ eventTime, priceEpochBasis }) {
  if (priceEpochBasis === "event_time") {
    return {
      pricedAt: eventTime,
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    };
  }
  if (priceEpochBasis !== undefined && priceEpochBasis !== "current_price_sensitivity") {
    throw new TypeError("priceEpochBasis must be event_time or current_price_sensitivity");
  }
  return {
    pricedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    priceEpochBasis: "current_price_sensitivity_at_registry_observation",
  };
}

function priceCardsAndManifest(priceCards) {
  if (priceCards !== null && priceCards !== undefined) {
    if (!Array.isArray(priceCards)) throw new TypeError("priceCards must be an array or null");
    return {
      priceCards,
      manifest: {
        version: "caller-provided-price-cards",
        sha256: null,
        observedAt: null,
        priceBasis: "api_price_equivalent_not_subscription_allowance",
        historicalDefault: "caller_declared",
        sources: [],
      },
    };
  }
  return { priceCards: APP_OFFICIAL_PRICE_CARDS, manifest: APP_PRICE_REGISTRY_MANIFEST };
}

export function priceCodexUsageEvent(event, {
  priceCards = null,
  priceEpochBasis = "current_price_sensitivity",
  apiServiceTier = "standard",
  region = null,
} = {}) {
  if (!event || typeof event !== "object") throw new TypeError("Codex usage event is required");
  const registry = priceCardsAndManifest(priceCards);
  const epoch = priceEpoch({ eventTime: event.timestamp, priceEpochBasis });
  const result = priceUsageEvent({
    provider: "openai",
    model: event.model,
    surface: "openai.responses",
    apiTier: apiServiceTier,
    pricedAt: epoch.pricedAt,
    ...(region ? { region } : {}),
    totalInputTokens: event.raw?.input_tokens,
    components: event.components,
    componentAvailability: event.componentAvailability,
  }, {
    priceCards: registry.priceCards,
    pricingContext: { priceEpochBasis: epoch.priceEpochBasis },
  });
  return { ...result, methodVersion: LOCAL_API_PRICING_METHOD_VERSION, registry: registry.manifest };
}

export function priceClaudeUsageRecord(record, {
  priceCards = null,
  priceEpochBasis = "current_price_sensitivity",
  apiServiceTier = "standard",
  region = null,
} = {}) {
  if (!record || typeof record !== "object") throw new TypeError("Claude usage record is required");
  const registry = priceCardsAndManifest(priceCards);
  const epoch = priceEpoch({ eventTime: record.eventTime, priceEpochBasis });
  const components = record.components ?? {};
  const result = priceUsageEvent({
    provider: "anthropic",
    model: record.modelRecognition === "recognized" ? record.modelId : "unknown",
    surface: "anthropic.messages",
    apiTier: apiServiceTier,
    pricedAt: epoch.pricedAt,
    ...(region ? { region } : {}),
    totalInputContextTokens: record.totalInputContextTokens,
    components: {
      inputUncachedTokens: components.inputUncachedTokens,
      inputCacheReadTokens: components.inputCacheReadTokens,
      inputCacheWriteTokens: components.inputCacheWriteTokens,
      inputCacheWrite5mTokens: components.inputCacheWrite5mTokens,
      inputCacheWrite1hTokens: components.inputCacheWrite1hTokens,
      outputCombinedTokens: components.outputCombinedTokens,
    },
  }, {
    priceCards: registry.priceCards,
    pricingContext: { priceEpochBasis: epoch.priceEpochBasis },
  });
  return { ...result, methodVersion: LOCAL_API_PRICING_METHOD_VERSION, registry: registry.manifest };
}

export function codexProviderBillableToolUnits(serverBillableUnits) {
  if (!serverBillableUnits || typeof serverBillableUnits !== "object" || Array.isArray(serverBillableUnits)) {
    return [];
  }
  const units = [];
  let unknownQuantity = 0;
  for (const [providerUnit, rawQuantity] of Object.entries(serverBillableUnits)) {
    const mapping = CODEX_TOOL_UNIT_MAPPING[providerUnit];
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    if (!mapping) {
      unknownQuantity += quantity;
      continue;
    }
    units.push({
      provider: "openai",
      name: mapping.name,
      quantity: String(quantity),
      unit: mapping.unit,
      billingSource: "provider",
      toolName: providerUnit,
    });
  }
  if (unknownQuantity > 0) {
    units.push({
      provider: "openai",
      name: UNKNOWN_PROVIDER_TOOL_UNIT.name,
      quantity: String(unknownQuantity),
      unit: UNKNOWN_PROVIDER_TOOL_UNIT.unit,
      billingSource: "provider",
      // Provider-specific unknown names are deliberately collapsed instead of
      // being retained as an arbitrary metadata channel.
      toolName: UNKNOWN_PROVIDER_TOOL_UNIT.name,
    });
  }
  return units.sort((left, right) => left.name.localeCompare(right.name));
}

export function priceCodexProviderToolUnits(serverBillableUnits, {
  priceCards = null,
  priceEpochBasis = "current_price_sensitivity",
} = {}) {
  const registry = priceCardsAndManifest(priceCards);
  const epoch = priceEpoch({ eventTime: null, priceEpochBasis });
  const result = priceUsageEvent({
    provider: "openai",
    model: "openai-provider-tools",
    surface: "openai.responses",
    apiTier: "standard",
    pricedAt: epoch.pricedAt,
    components: {},
    billableToolUnits: codexProviderBillableToolUnits(serverBillableUnits),
  }, {
    priceCards: registry.priceCards,
    pricingContext: { priceEpochBasis: epoch.priceEpochBasis },
  });
  return { ...result, methodVersion: LOCAL_API_PRICING_METHOD_VERSION, registry: registry.manifest };
}

export function aggregateLocalApiPriceResults(results) {
  const aggregate = aggregateCostResults(results);
  return {
    ...aggregate,
    methodVersion: LOCAL_API_PRICING_METHOD_VERSION,
    registry: results[0]?.registry ?? APP_PRICE_REGISTRY_MANIFEST,
  };
}

export function summarizeClaudeApiPriceRecords(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("Claude usage records must be an array");
  const results = records.map((record) => priceClaudeUsageRecord(record, options));
  const aggregate = aggregateLocalApiPriceResults(results);
  const byModel = {};
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const priced = results[index];
    const model = record.modelRecognition === "recognized" ? record.modelId : "unknown";
    const summary = byModel[model] ??= {
      events: 0,
      totalUsdExact: "0",
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    };
    summary.events += 1;
    summary.totalUsdExact = addUsdStrings(summary.totalUsdExact, priced.totalUsd);
    if (priced.coverageStatus === "fully_priced") summary.fullyPricedEvents += 1;
    else if (priced.coverageStatus === "partially_priced") summary.partiallyPricedEvents += 1;
    else summary.unpricedEvents += 1;
  }
  return {
    ...aggregate,
    provider: "anthropic_claude_code",
    byModel,
    assumptions: [
      "Claude combined output is priced at the ordinary output-token rate without inventing text or reasoning shares.",
      "Cache writes are priced only when both five-minute and one-hour quantities are structurally available and reconcile to the aggregate.",
      "Subscription speed is not interpreted as an Anthropic API service tier; Standard API pricing is the default counterfactual.",
    ],
  };
}

export function costWarningCodes(result) {
  return [...new Set([
    ...(result?.warnings?.coverage ?? []).map((warning) => warning.code),
    ...(result?.warnings?.informational ?? []).map((warning) => warning.code),
  ])].sort();
}

export function apiPriceResolutionSummary({ priceCards = null, apiServiceTier = "standard" } = {}) {
  const registry = priceCardsAndManifest(priceCards);
  return {
    selectedSource: priceCards ? "caller-provided-price-cards" : "app-official-price-registry",
    methodVersion: LOCAL_API_PRICING_METHOD_VERSION,
    registry: registry.manifest,
    serviceTier: {
      observed: null,
      apiPriceAssumption: apiServiceTier,
      reason: "Subscription logs do not expose an API billing tier; this is an explicit API-price-equivalent counterfactual.",
    },
  };
}
