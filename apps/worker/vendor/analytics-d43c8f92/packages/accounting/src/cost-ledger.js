import { aggregateCostLedgers, calculateCost, compilePriceCatalog } from "runcost/browser";

// Runtime-neutral accounting kernel. Platform adapters belong in consuming apps.

const SCHEMA_VERSION = "0.1";
const BASIS = "api_price_equivalent_not_subscription_allowance";

const SUPPORTED_PROVIDERS = new Set(["openai", "anthropic"]);

const PROVIDER_COMPONENTS = Object.freeze({
  openai: Object.freeze({
    inputUncachedTokens: "input_uncached_tokens",
    input_uncached_tokens: "input_uncached_tokens",
    inputCacheReadTokens: "input_cache_read_tokens",
    input_cache_read_tokens: "input_cache_read_tokens",
    inputCacheWriteTokens: "input_cache_write_tokens",
    input_cache_write_tokens: "input_cache_write_tokens",
    outputTextTokens: "output_text_tokens",
    output_text_tokens: "output_text_tokens",
    outputReasoningTokens: "output_reasoning_tokens",
    output_reasoning_tokens: "output_reasoning_tokens",
  }),
  anthropic: Object.freeze({
    inputUncachedTokens: "input_uncached_tokens",
    input_uncached_tokens: "input_uncached_tokens",
    inputCacheReadTokens: "input_cache_read_tokens",
    input_cache_read_tokens: "input_cache_read_tokens",
    inputCacheWriteTokens: "anthropic_input_cache_write_unsplit_tokens",
    input_cache_write_total_tokens: "anthropic_input_cache_write_unsplit_tokens",
    inputCacheWrite5mTokens: "input_cache_write_tokens",
    input_cache_write_5m_tokens: "input_cache_write_tokens",
    inputCacheWrite1hTokens: "input_cache_write_1h_tokens",
    input_cache_write_1h_tokens: "input_cache_write_1h_tokens",
    outputCombinedTokens: "output_combined_tokens",
    output_combined_tokens: "output_combined_tokens",
  }),
});

const TOOL_COMPONENTS = new Set([
  "web_search_units",
  "file_search_units",
  "code_interpreter_session_units",
  "code_interpreter_call_units",
  "tool_call_units",
  "tool_execution_seconds",
]);

const RUNCOST_COVERAGE_WARNING_CODES = new Set([
  "unknown_provider",
  "unknown_surface",
  "unknown_model",
  "price_not_found",
  "component_unpriced",
  "tool_component_unpriced",
  "source_capability_unsupported",
  "service_tier_unsupported",
  "long_context_rule_missing",
  "historical_price_missing",
  "historical_price_timestamp_missing",
  "pricing_period_required",
  "pricing_period_unsupported",
  "billing_schedule_unsupported",
]);

const VALID_UNITS = new Set([
  "token", "request", "call", "session", "search", "file", "second", "hour", "custom",
]);

const COMPILED_TIER_CATALOGS = new WeakMap();

function normalizeDecimal(value, label) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const input = String(value ?? "").trim();
  if (!input) throw new TypeError(`${label} must be a non-negative decimal`);
  const match = input.match(/^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new TypeError(`${label} must be a non-negative decimal`);
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new TypeError(`${label} exponent is too large`);
  }
  let digits = `${match[1]}${match[2] ?? ""}`;
  let scale = (match[2] ?? "").length - exponent;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000) throw new TypeError(`${label} precision is too large`);
  digits = digits.replace(/^0+(?=\d)/, "");
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  while (scale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  if (!digits || /^0+$/.test(digits)) return "0";
  if (scale === 0) return digits;
  if (digits.length <= scale) return `0.${"0".repeat(scale - digits.length)}${digits}`;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function decimalParts(value) {
  const normalized = normalizeDecimal(value, "decimal");
  const [whole, fraction = ""] = normalized.split(".");
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function addDecimals(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const total = a.value * (10n ** BigInt(scale - a.scale)) + b.value * (10n ** BigInt(scale - b.scale));
  const digits = total.toString().padStart(scale + 1, "0");
  return normalizeDecimal(scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`, "sum");
}

export function addUsdStrings(...values) {
  return values.reduce((total, value) => addDecimals(total, value), "0");
}

function positive(quantity) {
  return decimalParts(quantity).value > 0n;
}

function warning(code, message, metadata = {}) {
  return { code, message, metadata };
}

function defaultSurface(provider) {
  if (provider === "openai") return "openai.responses";
  if (provider === "anthropic") return "anthropic.messages";
  return `${provider || "unknown"}.usage`;
}

function cardMatchesIdentity(card, { provider, model, surface }) {
  return card?.provider === provider
    && (card.model === model || (card.aliases ?? []).includes(model))
    && (!card.surface || card.surface === surface);
}

function effectivePriceCards(priceCards, serviceTier) {
  if (serviceTier === "standard") return priceCards;
  // RunCost intentionally lets tierless cards act as Standard defaults. For a
  // non-Standard counterfactual that is unsafe, so only exact tier cards enter.
  return priceCards.filter((card) => card?.service_tier === serviceTier);
}

function compiledTierCatalog(priceCards, serviceTier) {
  let tiers = COMPILED_TIER_CATALOGS.get(priceCards);
  if (!tiers) {
    tiers = new Map();
    COMPILED_TIER_CATALOGS.set(priceCards, tiers);
  }
  if (!tiers.has(serviceTier)) {
    tiers.set(serviceTier, compilePriceCatalog(effectivePriceCards(priceCards, serviceTier)));
  }
  return tiers.get(serviceTier);
}

function readSemanticQuantity(components, keys, consumed, informationalWarnings) {
  const observed = keys.filter((key) => Object.hasOwn(components, key));
  for (const key of observed) consumed.add(key);
  if (observed.length === 0) return { present: false, quantity: "0", conflict: false };
  const quantities = observed.map((key) => normalizeDecimal(components[key], `components.${key}`));
  const distinct = [...new Set(quantities)];
  if (distinct.length > 1) {
    informationalWarnings.push(warning(
      "duplicate_component_conflict",
      `Aliases for ${keys[0]} disagree; the component was not priced.`,
      { keys: observed },
    ));
    return { present: true, quantity: quantities.reduce(addDecimals, "0"), conflict: true };
  }
  return { present: true, quantity: quantities[0], conflict: false };
}

function normalizedTokenComponents(provider, rawComponents, coverageWarnings, informationalWarnings) {
  if (rawComponents !== undefined && (!rawComponents || typeof rawComponents !== "object" || Array.isArray(rawComponents))) {
    throw new TypeError("event.components must be an object");
  }
  const components = rawComponents && typeof rawComponents === "object" && !Array.isArray(rawComponents)
    ? rawComponents
    : {};
  const consumed = new Set();
  const pricedCandidates = [];
  const preUnpriced = [];

  if (provider === "openai") {
    const semantics = [
      ["input_uncached_tokens", ["inputUncachedTokens", "input_uncached_tokens"]],
      ["input_cache_read_tokens", ["inputCacheReadTokens", "input_cache_read_tokens"]],
      ["input_cache_write_tokens", ["inputCacheWriteTokens", "input_cache_write_tokens"]],
      ["output_text_tokens", ["outputTextTokens", "output_text_tokens"]],
      ["output_reasoning_tokens", ["outputReasoningTokens", "output_reasoning_tokens"]],
    ];
    for (const [name, keys] of semantics) {
      const value = readSemanticQuantity(components, keys, consumed, informationalWarnings);
      if (!value.present || !positive(value.quantity)) continue;
      if (value.conflict) {
        preUnpriced.push({ name, quantity: value.quantity, unit: "token", reasonCode: "duplicate_component_conflict" });
        coverageWarnings.push(warning("duplicate_component_conflict", `Conflicting aliases for ${name} were not priced.`, { component: name }));
      } else {
        pricedCandidates.push({ name, quantity: value.quantity, unit: "token", metadata: { normalized_from: keys[0] } });
      }
    }
  } else if (provider === "anthropic") {
    for (const [name, keys] of [
      ["input_uncached_tokens", ["inputUncachedTokens", "input_uncached_tokens"]],
      ["input_cache_read_tokens", ["inputCacheReadTokens", "input_cache_read_tokens"]],
    ]) {
      const value = readSemanticQuantity(components, keys, consumed, informationalWarnings);
      if (!value.present || !positive(value.quantity)) continue;
      if (value.conflict) {
        preUnpriced.push({ name, quantity: value.quantity, unit: "token", reasonCode: "duplicate_component_conflict" });
        coverageWarnings.push(warning("duplicate_component_conflict", `Conflicting aliases for ${name} were not priced.`, { component: name }));
      }
      else pricedCandidates.push({ name, quantity: value.quantity, unit: "token", metadata: { normalized_from: keys[0] } });
    }

    const aggregateWrite = readSemanticQuantity(
      components,
      ["inputCacheWriteTokens", "input_cache_write_total_tokens"],
      consumed,
      informationalWarnings,
    );
    const write5m = readSemanticQuantity(
      components,
      ["inputCacheWrite5mTokens", "input_cache_write_5m_tokens"],
      consumed,
      informationalWarnings,
    );
    const write1h = readSemanticQuantity(
      components,
      ["inputCacheWrite1hTokens", "input_cache_write_1h_tokens"],
      consumed,
      informationalWarnings,
    );
    const knownWrite = addDecimals(write5m.quantity, write1h.quantity);
    const observedWrite = aggregateWrite.present ? aggregateWrite.quantity : knownWrite;
    const writeConflict = aggregateWrite.conflict || write5m.conflict || write1h.conflict;
    if (positive(observedWrite) && (writeConflict || !write5m.present || !write1h.present)) {
      const reasonCode = writeConflict ? "duplicate_component_conflict" : "anthropic_cache_write_ttl_split_missing";
      preUnpriced.push({
        name: "anthropic_input_cache_write_unsplit_tokens",
        quantity: observedWrite,
        unit: "token",
        reasonCode,
      });
      coverageWarnings.push(warning(
        reasonCode,
        reasonCode === "anthropic_cache_write_ttl_split_missing"
          ? "Anthropic cache-write tokens were observed without both 5-minute and 1-hour quantities; no TTL was assumed."
          : "Conflicting Anthropic cache-write quantities were not priced.",
        { quantity: observedWrite },
      ));
    } else if (aggregateWrite.present && aggregateWrite.quantity !== knownWrite) {
      if (positive(aggregateWrite.quantity) || positive(knownWrite)) {
        preUnpriced.push({
          name: "anthropic_input_cache_write_unsplit_tokens",
          quantity: aggregateWrite.quantity,
          unit: "token",
          reasonCode: "anthropic_cache_write_split_mismatch",
        });
        coverageWarnings.push(warning(
          "anthropic_cache_write_split_mismatch",
          "Anthropic aggregate cache-write tokens do not equal the TTL split; cache writes were not priced.",
          { aggregate: aggregateWrite.quantity, splitTotal: knownWrite },
        ));
      }
    } else {
      if (positive(write5m.quantity)) pricedCandidates.push({
        name: "input_cache_write_tokens",
        quantity: write5m.quantity,
        unit: "token",
        metadata: { cache_ttl: "5m", normalized_from: "inputCacheWrite5mTokens" },
      });
      if (positive(write1h.quantity)) pricedCandidates.push({
        name: "input_cache_write_1h_tokens",
        quantity: write1h.quantity,
        unit: "token",
        metadata: { cache_ttl: "1h", normalized_from: "inputCacheWrite1hTokens" },
      });
    }

    const output = readSemanticQuantity(
      components,
      ["outputCombinedTokens", "output_combined_tokens"],
      consumed,
      informationalWarnings,
    );
    if (positive(output.quantity)) {
      if (output.conflict) {
        preUnpriced.push({ name: "output_combined_tokens", quantity: output.quantity, unit: "token", reasonCode: "duplicate_component_conflict" });
        coverageWarnings.push(warning("duplicate_component_conflict", "Conflicting aliases for Anthropic combined output were not priced.", { component: "output_combined_tokens" }));
      } else {
        pricedCandidates.push({
          name: "output_text_tokens",
          quantity: output.quantity,
          unit: "token",
          metadata: {
            normalized_from: "outputCombinedTokens",
            original_component: "output_combined_tokens",
            pricing_policy: "anthropic_combined_output_priced_as_ordinary_output",
            output_split_invented: false,
          },
        });
      }
    }
  }

  for (const [key, rawQuantity] of Object.entries(components)) {
    if (consumed.has(key)) continue;
    const quantity = normalizeDecimal(rawQuantity, `components.${key}`);
    if (!positive(quantity)) {
      informationalWarnings.push(warning("unknown_zero_component", `Unknown zero-valued component ${key} was ignored.`, { component: key }));
      continue;
    }
    preUnpriced.push({ name: key, quantity, unit: "token", reasonCode: SUPPORTED_PROVIDERS.has(provider) ? "unknown_component" : "unsupported_provider" });
    coverageWarnings.push(warning(
      SUPPORTED_PROVIDERS.has(provider) ? "unknown_component" : "unsupported_provider",
      `Component ${key} has no approved ${provider || "unknown"} mapping and was not priced.`,
      { component: key, provider },
    ));
  }

  return { pricedCandidates, preUnpriced };
}

function normalizedToolComponents(provider, billableToolUnits, coverageWarnings) {
  if (billableToolUnits === undefined) return { pricedCandidates: [], preUnpriced: [] };
  if (!Array.isArray(billableToolUnits)) throw new TypeError("billableToolUnits must be an array");
  const pricedCandidates = [];
  const preUnpriced = [];
  for (let index = 0; index < billableToolUnits.length; index += 1) {
    const item = billableToolUnits[index] ?? {};
    const name = String(item.name ?? item.component ?? "unknown_tool_unit");
    const quantity = normalizeDecimal(item.quantity, `billableToolUnits[${index}].quantity`);
    if (!positive(quantity)) continue;
    const unit = String(item.unit ?? "custom");
    let reasonCode = null;
    if (!TOOL_COMPONENTS.has(name) || !VALID_UNITS.has(unit)) reasonCode = "unknown_tool_component";
    else if (item.provider !== provider) reasonCode = "tool_unit_provider_mismatch";
    else if (item.billingSource !== "provider") reasonCode = "tool_unit_not_provider_billed";
    if (reasonCode) {
      preUnpriced.push({ name, quantity, unit, reasonCode });
      coverageWarnings.push(warning(reasonCode, `Tool unit ${name} was not priced without an exact provider-billable identity.`, {
        component: name,
        eventProvider: provider,
        unitProvider: item.provider ?? null,
        billingSource: item.billingSource ?? null,
      }));
      continue;
    }
    pricedCandidates.push({
      name,
      quantity,
      unit,
      tool: { provider, name: item.toolName ?? name, billing_source: "provider" },
      metadata: { exact_provider_billable_unit: true },
    });
  }
  return { pricedCandidates, preUnpriced };
}

function dedupeWarnings(warnings) {
  const byKey = new Map();
  for (const item of warnings) {
    const key = JSON.stringify([item.code, item.message, item.metadata ?? {}]);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}

function canonicalPriceInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function usablePriceInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string" && typeof value !== "number") return false;
  return Number.isFinite(new Date(value).getTime());
}

function normalizePriceInstant(value) {
  return usablePriceInstant(value) ? new Date(value).toISOString() : null;
}

function priceCardBreakdownFromComponents(components) {
  const byCard = new Map();
  for (const component of components) {
    if (component.pricingStatus !== "priced" || !component.priceCardId || !positive(component.quantity)) continue;
    const row = byCard.get(component.priceCardId) ?? { priceCardId: component.priceCardId, events: 0, costUsd: "0" };
    // A row represents one priced event for this card, even when the event
    // contains several components on the same card.
    row.events = 1;
    row.costUsd = addUsdStrings(row.costUsd, component.costUsd ?? "0");
    byCard.set(component.priceCardId, row);
  }
  return [...byCard.values()].sort((left, right) => left.priceCardId.localeCompare(right.priceCardId));
}

function aggregatePriceCardBreakdowns(results) {
  const byCard = new Map();
  for (const result of results) {
    for (const item of result.priceCardBreakdown ?? []) {
      const row = byCard.get(item.priceCardId) ?? { priceCardId: item.priceCardId, events: 0, costUsd: "0" };
      row.events += Number(item.events ?? 0);
      row.costUsd = addUsdStrings(row.costUsd, item.costUsd ?? "0");
      byCard.set(item.priceCardId, row);
    }
  }
  return [...byCard.values()].sort((left, right) => left.priceCardId.localeCompare(right.priceCardId));
}

function coverageStatus(pricedPositiveCount, unpricedPositiveCount, unavailableCount = 0) {
  if (unpricedPositiveCount === 0 && unavailableCount === 0) return "fully_priced";
  return pricedPositiveCount > 0 ? "partially_priced" : "unpriced";
}

function observedComponentInput(provider, rawComponents, availability) {
  if (availability !== undefined && (!availability || typeof availability !== "object" || Array.isArray(availability))) {
    throw new TypeError("event.componentAvailability must be an object when supplied");
  }
  const observed = {};
  const unavailable = new Set();
  const providerMap = PROVIDER_COMPONENTS[provider] ?? {};
  for (const [key, value] of Object.entries(rawComponents ?? {})) {
    const mapped = providerMap[key];
    if (value === null || value === undefined || availability?.[key] === false) {
      if (mapped) unavailable.add(mapped);
      continue;
    }
    observed[key] = value;
  }
  for (const [key, isAvailable] of Object.entries(availability ?? {})) {
    if (isAvailable === false && providerMap[key]) unavailable.add(providerMap[key]);
  }
  return { observed, unavailable: [...unavailable].sort() };
}

/**
 * Price a privacy-minimized, normalized usage event at public API-equivalent
 * rates. It is deliberately not a parser for raw provider logs.
 */
export function priceUsageEvent(event, { priceCards = [], pricingContext = {} } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
  const provider = String(event.provider ?? "").trim().toLowerCase();
  const model = String(event.model ?? "").trim();
  if (!provider) throw new TypeError("event.provider is required");
  if (!model) throw new TypeError("event.model is required");
  if (!Array.isArray(priceCards)) throw new TypeError("priceCards must be an array");

  const surface = String(event.surface ?? pricingContext.surface ?? defaultSurface(provider));
  const explicitTier = event.serviceTier ?? event.apiTier ?? pricingContext.serviceTier ?? pricingContext.apiTier;
  const serviceTier = String(explicitTier ?? "standard").trim().toLowerCase();
  const tierSource = explicitTier === undefined || explicitTier === null ? "assumed_standard_counterfactual" : "observed_or_caller_supplied";
  const historicalPricing = pricingContext.priceEpochBasis === "event_time_when_registry_has_effective_evidence";
  const rawPricedAt = event.pricedAt ?? event.timestamp ?? pricingContext.pricedAt ?? pricingContext.timestamp;
  const pricedAt = historicalPricing
    ? canonicalPriceInstant(rawPricedAt)
    : normalizePriceInstant(rawPricedAt);
  const region = event.region ?? pricingContext.region;
  const coverageWarnings = [];
  const informationalWarnings = [];

  const observation = observedComponentInput(provider, event.components, event.componentAvailability);
  const tokenResult = normalizedTokenComponents(provider, observation.observed, coverageWarnings, informationalWarnings);
  const toolResult = normalizedToolComponents(provider, event.billableToolUnits, coverageWarnings);
  const candidates = [...tokenResult.pricedCandidates, ...toolResult.pricedCandidates];
  const preUnpriced = [...tokenResult.preUnpriced, ...toolResult.preUnpriced];
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    for (const component of candidates.splice(0)) {
      preUnpriced.push({ ...component, reasonCode: "unsupported_provider" });
      coverageWarnings.push(warning("unsupported_provider", `Provider ${provider} is not supported by the normalized cost ledger.`, { provider }));
    }
  }

  if (historicalPricing && !pricedAt) {
    const reasonCode = pricingContext.historicalPriceReasonCode ?? "historical_price_timestamp_missing";
    for (const component of candidates.splice(0)) {
      preUnpriced.push({ ...component, reasonCode });
    }
    coverageWarnings.push(warning(
      reasonCode,
      "The event has no usable timestamp for historical price-card selection; its monetary components were not priced.",
      { provider, model },
    ));
  }

  const identity = { provider, model, surface };
  const exactTierCardExists = serviceTier === "standard" || priceCards.some((card) => (
    cardMatchesIdentity(card, identity) && card.service_tier === serviceTier
  ));
  const suppliedTotalInputTokens = event.totalInputTokens ?? event.totalInputContextTokens
    ?? pricingContext.totalInputTokens ?? pricingContext.totalInputContextTokens;
  const totalInputTokens = suppliedTotalInputTokens === undefined || suppliedTotalInputTokens === null
    ? candidates
      .filter((component) => component.unit === "token" && component.name.startsWith("input_"))
      .reduce((sum, component) => addDecimals(sum, component.quantity), "0")
    : normalizeDecimal(suppliedTotalInputTokens, "totalInputTokens");
  const usageLedger = {
    schema_version: "0.1",
    provider,
    surface,
    model: { requested: model },
    context: {
      service_tier: serviceTier,
      total_input_tokens: totalInputTokens,
      ...(pricedAt ? { priced_at: pricedAt } : {}),
      ...(region ? { region: String(region) } : {}),
    },
    components: candidates.map((component, index) => ({
      ...component,
      metadata: { ...(component.metadata ?? {}), local_component_key: `component-${index}` },
    })),
    metadata: { basis: BASIS, normalized_metadata_only: true },
  };

  const ledger = calculateCost({
    usageLedger,
    priceCards: compiledTierCatalog(priceCards, serviceTier),
    mode: "compatibility",
  });
  const pricedByKey = new Map(ledger.components.map((component) => [component.metadata?.local_component_key, component]));
  const components = [];
  for (let index = 0; index < usageLedger.components.length; index += 1) {
    const requested = usageLedger.components[index];
    const priced = pricedByKey.get(`component-${index}`);
    if (priced) {
      components.push({
        name: provider === "anthropic" && requested.metadata?.original_component === "output_combined_tokens"
          ? "output_combined_tokens"
          : requested.name,
        pricedAs: requested.name,
        quantity: requested.quantity,
        unit: requested.unit,
        pricingStatus: "priced",
        unitPriceUsd: priced.unit_price,
        costUsd: priced.cost,
        priceCardId: priced.price_card_id,
        metadata: { ...(priced.metadata ?? {}) },
      });
    } else {
      const historicalPriceMissing = ledger.warnings.some((item) => item.code === "historical_price_missing");
      const reasonCode = !exactTierCardExists && serviceTier !== "standard"
        ? "service_tier_exact_card_missing"
        : historicalPriceMissing
          ? "historical_price_missing"
          : "component_price_missing";
      components.push({
        name: requested.metadata?.original_component ?? requested.name,
        pricedAs: requested.name,
        quantity: requested.quantity,
        unit: requested.unit,
        pricingStatus: "unpriced",
        unitPriceUsd: null,
        costUsd: null,
        priceCardId: null,
        reasonCode,
        metadata: { ...(requested.metadata ?? {}) },
      });
      if (!(historicalPriceMissing && reasonCode === "historical_price_missing")) {
        coverageWarnings.push(warning(
          reasonCode,
          reasonCode === "service_tier_exact_card_missing"
            ? `No exact ${serviceTier} price card declares the requested non-Standard tier.`
            : `No monetary price covered ${requested.name}.`,
          { component: requested.name, provider, model, serviceTier },
        ));
      }
    }
  }
  for (const component of preUnpriced) {
    components.push({
      name: component.name,
      pricedAs: null,
      quantity: component.quantity,
      unit: component.unit,
      pricingStatus: "unpriced",
      unitPriceUsd: null,
      costUsd: null,
      priceCardId: null,
      reasonCode: component.reasonCode,
    });
  }
  for (const name of observation.unavailable) {
    components.push({
      name,
      pricedAs: null,
      quantity: null,
      unit: "token",
      pricingStatus: "unavailable",
      unitPriceUsd: null,
      costUsd: null,
      priceCardId: null,
      reasonCode: "component_observation_unavailable",
    });
    coverageWarnings.push(warning(
      "component_observation_unavailable",
      `Component ${name} was unavailable in the provider observation and was not treated as zero.`,
      { component: name, provider },
    ));
  }

  const pricedPositiveCount = components.filter((component) => component.pricingStatus === "priced" && positive(component.quantity)).length;
  const unpricedPositiveCount = components.filter((component) => component.pricingStatus === "unpriced" && positive(component.quantity)).length;
  const unavailableCount = components.filter((component) => component.pricingStatus === "unavailable").length;
  const selectedPriceCardIds = [...new Set(ledger.components.map((component) => component.price_card_id).filter(Boolean))].sort();
  const runcostCoverageWarnings = ledger.warnings.filter((item) => RUNCOST_COVERAGE_WARNING_CODES.has(item.code));
  const runcostInformationalWarnings = ledger.warnings.filter((item) => !RUNCOST_COVERAGE_WARNING_CODES.has(item.code));
  return {
    schemaVersion: SCHEMA_VERSION,
    basis: BASIS,
    provider,
    model,
    surface,
    pricingContext: {
      serviceTier,
      tierSource,
      pricedAt,
      region: region ? String(region) : null,
      priceEpochBasis: pricingContext.priceEpochBasis ?? "caller_declared_or_unspecified",
      ...(pricingContext.historicalPriceReasonCode
        ? { historicalPriceReasonCode: pricingContext.historicalPriceReasonCode }
        : {}),
    },
    coverageStatus: historicalPricing && !pricedAt
      ? "unpriced"
      : coverageStatus(pricedPositiveCount, unpricedPositiveCount, unavailableCount),
    coverageCounts: {
      pricedComponents: pricedPositiveCount,
      unpricedComponents: unpricedPositiveCount,
      unavailableComponents: unavailableCount,
    },
    totalUsd: ledger.total,
    components,
    priceCardBreakdown: priceCardBreakdownFromComponents(components),
    selectedPriceCardId: selectedPriceCardIds.length === 1 ? selectedPriceCardIds[0] : null,
    selectedPriceCardIds,
    warnings: {
      coverage: dedupeWarnings([...coverageWarnings, ...runcostCoverageWarnings]),
      informational: dedupeWarnings([...informationalWarnings, ...runcostInformationalWarnings]),
    },
    ledger,
  };
}

export function aggregateCostResults(results) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  const ledgers = results.map((result, index) => {
    if (!result?.ledger) throw new TypeError(`results[${index}] is missing its cost ledger`);
    return result.ledger;
  });
  const ledger = aggregateCostLedgers({ costLedgers: ledgers, mode: "compatibility" });
  const pricedPositiveCount = results.reduce((count, result) => count + result.components.filter(
    (component) => component.pricingStatus === "priced" && positive(component.quantity),
  ).length, 0);
  const unpricedPositiveCount = results.reduce((count, result) => count + result.components.filter(
    (component) => component.pricingStatus === "unpriced" && positive(component.quantity),
  ).length, 0);
  const unavailableCount = results.reduce((count, result) => count + result.components.filter(
    (component) => component.pricingStatus === "unavailable",
  ).length, 0);
  const selectedPriceCardIds = [...new Set(results.flatMap((result) => result.selectedPriceCardIds ?? []))].sort();
  return {
    schemaVersion: SCHEMA_VERSION,
    basis: BASIS,
    eventCount: results.length,
    coverageStatus: coverageStatus(pricedPositiveCount, unpricedPositiveCount, unavailableCount),
    coverageCounts: {
      fullyPriced: results.filter((result) => result.coverageStatus === "fully_priced").length,
      partiallyPriced: results.filter((result) => result.coverageStatus === "partially_priced").length,
      unpriced: results.filter((result) => result.coverageStatus === "unpriced").length,
      pricedComponents: pricedPositiveCount,
      unpricedComponents: unpricedPositiveCount,
      unavailableComponents: unavailableCount,
    },
    totalUsd: ledger.total,
    selectedPriceCardIds,
    priceCardBreakdown: aggregatePriceCardBreakdowns(results),
    warnings: {
      coverage: dedupeWarnings(results.flatMap((result) => result.warnings?.coverage ?? [])),
      informational: dedupeWarnings(results.flatMap((result) => result.warnings?.informational ?? [])),
    },
    ledger,
  };
}
