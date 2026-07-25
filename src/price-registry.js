import { createHash } from "node:crypto";

export const APP_PRICE_REGISTRY_OBSERVED_AT = "2026-07-25T14:18:33Z";
const OBSERVED_DATE = APP_PRICE_REGISTRY_OBSERVED_AT.slice(0, 10);
const PER_MILLION = "1000000";
export const APP_PRICE_REGISTRY_VERSION = "app-official-api-prices-v0.1";

export const OFFICIAL_PRICE_SOURCE_URLS = Object.freeze({
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
});

const SOURCE_DEFINITIONS = Object.freeze({
  openai: Object.freeze({
    provider: "openai",
    name: "openai-official-api-pricing",
    url: OFFICIAL_PRICE_SOURCE_URLS.openai,
    observedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    evidenceVersion: "openai-api-pricing-reviewed-2026-07-25",
  }),
  anthropic: Object.freeze({
    provider: "anthropic",
    name: "anthropic-official-api-pricing",
    url: OFFICIAL_PRICE_SOURCE_URLS.anthropic,
    observedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    evidenceVersion: "anthropic-api-pricing-reviewed-2026-07-25",
  }),
});

const OPENAI_ROWS = Object.freeze([
  // The four values are input, cache read, cache write, and output USD/MTok.
  ["gpt-5.6-sol", "standard", "5", "0.5", "6.25", "30"],
  ["gpt-5.6-sol", "batch", "2.5", "0.25", "3.125", "15"],
  ["gpt-5.6-sol", "flex", "2.5", "0.25", "3.125", "15"],
  ["gpt-5.6-sol", "priority", "10", "1", "12.5", "60"],
  ["gpt-5.6-terra", "standard", "2.5", "0.25", "3.125", "15"],
  ["gpt-5.6-terra", "batch", "1.25", "0.125", "1.5625", "7.5"],
  ["gpt-5.6-terra", "flex", "1.25", "0.125", "1.5625", "7.5"],
  ["gpt-5.6-terra", "priority", "5", "0.5", "6.25", "30"],
  ["gpt-5.6-luna", "standard", "1", "0.1", "1.25", "6"],
  ["gpt-5.6-luna", "batch", "0.5", "0.05", "0.625", "3"],
  ["gpt-5.6-luna", "flex", "0.5", "0.05", "0.625", "3"],
  ["gpt-5.6-luna", "priority", "2", "0.2", "2.5", "12"],
  ["gpt-5.5", "standard", "5", "0.5", null, "30", "short"],
  ["gpt-5.5", "batch", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.5", "flex", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.5", "priority", "12.5", "1.25", null, "75", "short"],
  ["gpt-5.4", "standard", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.4", "batch", "1.25", "0.13", null, "7.5", "short"],
  ["gpt-5.4", "flex", "1.25", "0.13", null, "7.5", "short"],
  ["gpt-5.4", "priority", "5", "0.5", null, "30", "short"],
  ["gpt-5.4-mini", "standard", "0.75", "0.075", null, "4.5"],
  ["gpt-5.4-mini", "batch", "0.375", "0.0375", null, "2.25"],
  ["gpt-5.4-mini", "flex", "0.375", "0.0375", null, "2.25"],
  ["gpt-5.4-mini", "priority", "1.5", "0.15", null, "9"],
  ["gpt-5", "standard", "1.25", "0.125", null, "10"],
  ["gpt-5", "batch", "0.625", "0.0625", null, "5"],
  ["gpt-5", "flex", "0.625", "0.0625", null, "5"],
  ["gpt-5", "priority", "2.5", "0.25", null, "20"],
  ["gpt-4.1", "standard", "2", "0.5", null, "8"],
  // The official Batch row contains "-" for cached input, so it is absent.
  ["gpt-4.1", "batch", "1", null, null, "4"],
  ["gpt-4.1", "priority", "3.5", "0.875", null, "14"],
]);

const ANTHROPIC_ROWS = Object.freeze([
  // Values are base input, 5m write, 1h write, cache read, and output USD/MTok.
  ["claude-fable-5", "standard", "10", "12.5", "20", "1", "50"],
  ["claude-fable-5", "batch", "5", "6.25", "10", "0.5", "25"],
  ["claude-haiku-4-5-20251001", "standard", "1", "1.25", "2", "0.1", "5"],
  ["claude-haiku-4-5-20251001", "batch", "0.5", "0.625", "1", "0.05", "2.5"],
  ["claude-opus-4-8", "standard", "5", "6.25", "10", "0.5", "25"],
  ["claude-opus-4-8", "batch", "2.5", "3.125", "5", "0.25", "12.5"],
  ["claude-opus-4-8", "fast", "10", "12.5", "20", "1", "50"],
  ["claude-sonnet-4-6", "standard", "3", "3.75", "6", "0.3", "15"],
  ["claude-sonnet-4-6", "batch", "1.5", "1.875", "3", "0.15", "7.5"],
  ["claude-sonnet-5", "standard", "2", "2.5", "4", "0.2", "10", "introductory"],
  ["claude-sonnet-5", "batch", "1", "1.25", "2", "0.1", "5", "introductory"],
  ["claude-sonnet-5", "standard", "3", "3.75", "6", "0.3", "15", "standard-2026-09-01"],
  ["claude-sonnet-5", "batch", "1.5", "1.875", "3", "0.15", "7.5", "standard-2026-09-01"],
]);

const OPENAI_TOOL_ROWS = Object.freeze([
  ["web_search_units", "10", "search", "1000"],
  ["file_search_units", "2.5", "call", "1000"],
]);

const ANTHROPIC_TOOL_ROWS = Object.freeze([
  ["web_search_units", "10", "search", "1000"],
]);

function evidenceHash(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const EVIDENCE_HASHES = Object.freeze({
  openai: evidenceHash([OPENAI_ROWS, OPENAI_TOOL_ROWS]),
  anthropic: evidenceHash([ANTHROPIC_ROWS, ANTHROPIC_TOOL_ROWS]),
});

function component(usageComponent, amount, conditions) {
  if (amount === null) return null;
  return {
    usage_component: usageComponent,
    unit: "token",
    price: { amount, currency: "USD", per: PER_MILLION },
    ...(conditions ? { conditions } : {}),
  };
}

function providerUnitComponent(usageComponent, amount, unit, per) {
  return {
    usage_component: usageComponent,
    unit,
    price: { amount, currency: "USD", per },
  };
}

function provenance(provider, { vendorEffectiveFrom = null, vendorEffectiveTo = null } = {}) {
  const source = SOURCE_DEFINITIONS[provider];
  return {
    observed_at: source.observedAt,
    evidence_version: source.evidenceVersion,
    evidence_sha256: EVIDENCE_HASHES[provider],
    evidence_hash_scope: "normalized_reviewed_price_rows",
    vendor_effective_from: vendorEffectiveFrom,
    vendor_effective_to: vendorEffectiveTo,
    historical_validity: vendorEffectiveFrom
      ? "official_vendor_window"
      : "not_asserted_before_first_observation",
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function source(provider) {
  const definition = SOURCE_DEFINITIONS[provider];
  return {
    name: definition.name,
    url: definition.url,
    retrieved_at: definition.observedAt,
    version: definition.evidenceVersion,
  };
}

function cardId(provider, model, tier, suffix = "current") {
  return `${provider}:${model}:${tier}:${suffix}:official-observed-2026-07-25`;
}

function openAiCard([model, tier, input, cacheRead, cacheWrite, output, contextBand = null]) {
  const shortContext = contextBand === "short"
    ? { max_total_input_tokens: "271999" }
    : null;
  const aliases = model === "gpt-5.5" ? ["gpt-5.5-codex"] : undefined;
  return {
    schema_version: "0.1",
    id: cardId("openai", model, tier),
    provider: "openai",
    model,
    ...(aliases ? { aliases } : {}),
    service_tier: tier,
    region: "global",
    effective: { from: OBSERVED_DATE },
    components: [
      component("input_uncached_tokens", input, shortContext),
      component("input_cache_read_tokens", cacheRead, shortContext),
      component("input_cache_write_tokens", cacheWrite, shortContext),
      component("output_text_tokens", output, shortContext),
      providerUnitComponent("web_search_units", "10", "search", "1000"),
      providerUnitComponent("file_search_units", "2.5", "call", "1000"),
    ].filter(Boolean),
    source: source("openai"),
    metadata: {
      pricing_basis: "official_api_price_not_subscription_allowance",
      api_service_tier: tier,
      subscription_speed_tier: null,
      provenance: provenance("openai"),
      ...(aliases ? {
        alias_assumptions: {
          "gpt-5.5-codex": "Assumed to share gpt-5.5 API rates; not listed separately on the official pricing page.",
        },
      } : {}),
      ...(shortContext ? {
        coverage_note: "The official row is explicitly limited to context lengths below 272K; longer-context rates are not inferred.",
      } : {}),
    },
  };
}

function anthropicEffective(period) {
  if (period === "introductory") {
    return {
      effective: { from: OBSERVED_DATE, to: "2026-08-31" },
      vendorEffectiveFrom: null,
      vendorEffectiveTo: "2026-08-31",
      suffix: "through-2026-08-31",
    };
  }
  if (period === "standard-2026-09-01") {
    return {
      effective: { from: "2026-09-01" },
      vendorEffectiveFrom: "2026-09-01",
      vendorEffectiveTo: null,
      suffix: "from-2026-09-01",
    };
  }
  return {
    effective: { from: OBSERVED_DATE },
    vendorEffectiveFrom: null,
    vendorEffectiveTo: null,
    suffix: "current",
  };
}

function anthropicCard([model, tier, input, cacheWrite5m, cacheWrite1h, cacheRead, output, period = null]) {
  const validity = anthropicEffective(period);
  return {
    schema_version: "0.1",
    id: cardId("anthropic", model, tier, validity.suffix),
    provider: "anthropic",
    model,
    service_tier: tier,
    region: "global",
    effective: validity.effective,
    components: [
      component("input_uncached_tokens", input),
      component("input_cache_write_tokens", cacheWrite5m),
      component("input_cache_write_1h_tokens", cacheWrite1h),
      component("input_cache_read_tokens", cacheRead),
      component("output_text_tokens", output),
      providerUnitComponent("web_search_units", "10", "search", "1000"),
    ],
    source: source("anthropic"),
    metadata: {
      pricing_basis: "official_api_price_not_subscription_allowance",
      api_service_tier: tier,
      subscription_speed_tier: null,
      provenance: provenance("anthropic", validity),
      ...(tier === "fast" ? {
        coverage_note: "Anthropic first-party API fast mode; unrelated to subscription or Codex Fast modes.",
      } : {}),
    },
  };
}

function providerToolCard(provider, model, rows) {
  return {
    schema_version: "0.1",
    id: cardId(provider, model, "standard", "provider-tool-units"),
    provider,
    model,
    service_tier: "standard",
    region: "global",
    effective: { from: OBSERVED_DATE },
    components: rows.map(([name, amount, unit, per]) => (
      providerUnitComponent(name, amount, unit, per)
    )),
    source: source(provider),
    metadata: {
      pricing_basis: "official_api_price_not_subscription_allowance",
      api_service_tier: "standard",
      subscription_speed_tier: null,
      price_card_kind: "provider_billable_tool_units",
      provenance: provenance(provider),
      coverage_note: "Requires an exact provider-issued billable unit; client wrapper calls never select this card.",
    },
  };
}

export const OPENAI_OFFICIAL_PRICE_CARDS = deepFreeze(OPENAI_ROWS.map(openAiCard));
export const ANTHROPIC_OFFICIAL_PRICE_CARDS = deepFreeze(ANTHROPIC_ROWS.map(anthropicCard));
export const PROVIDER_TOOL_PRICE_CARDS = deepFreeze([
  providerToolCard("openai", "openai-provider-tools", OPENAI_TOOL_ROWS),
  providerToolCard("anthropic", "anthropic-provider-tools", ANTHROPIC_TOOL_ROWS),
]);
export const APP_OFFICIAL_PRICE_CARDS = deepFreeze([
  ...OPENAI_OFFICIAL_PRICE_CARDS,
  ...ANTHROPIC_OFFICIAL_PRICE_CARDS,
  ...PROVIDER_TOOL_PRICE_CARDS,
]);

export const APP_PRICE_REGISTRY_SHA256 = createHash("sha256")
  .update(JSON.stringify(APP_OFFICIAL_PRICE_CARDS))
  .digest("hex");

export const APP_PRICE_REGISTRY_MANIFEST = deepFreeze({
  version: APP_PRICE_REGISTRY_VERSION,
  sha256: APP_PRICE_REGISTRY_SHA256,
  observedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
  priceBasis: "official_api_price_not_subscription_allowance",
  historicalDefault: "current_price_sensitivity_unless_vendor_effective_window_is_proven",
  sources: Object.values(SOURCE_DEFINITIONS).map((definition) => ({
    provider: definition.provider,
    url: definition.url,
    observedAt: definition.observedAt,
    evidenceVersion: definition.evidenceVersion,
    evidenceSha256: EVIDENCE_HASHES[definition.provider],
  })),
});

const ALLOWED_TIERS = Object.freeze({
  openai: new Set(["standard", "batch", "flex", "priority"]),
  anthropic: new Set(["standard", "batch", "fast"]),
});

function rangeBoundary(card, boundary, fallback) {
  return card.effective?.[boundary] || fallback;
}

function rangesOverlap(left, right) {
  const leftFrom = rangeBoundary(left, "from", "0000-00-00");
  const leftTo = rangeBoundary(left, "to", "9999-99-99");
  const rightFrom = rangeBoundary(right, "from", "0000-00-00");
  const rightTo = rangeBoundary(right, "to", "9999-99-99");
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

function sameContext(left, right) {
  return left.provider === right.provider
    && left.model === right.model
    && (left.surface || null) === (right.surface || null)
    && (left.service_tier || "standard") === (right.service_tier || "standard")
    && (left.region || null) === (right.region || null)
    && (left.pricing_period || null) === (right.pricing_period || null);
}

function assertDecimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative decimal string.`);
  }
}

export function validateOfficialPriceRegistry(cards = APP_OFFICIAL_PRICE_CARDS) {
  const ids = new Set();
  const claimedNames = new Map();

  for (const [index, card] of cards.entries()) {
    const label = `price card at index ${index}`;
    if (!card || typeof card !== "object") throw new TypeError(`${label} must be an object.`);
    if (!card.id || ids.has(card.id)) throw new TypeError(`${label} has a missing or duplicate id.`);
    ids.add(card.id);
    if (!card.provider || !card.model) throw new TypeError(`${card.id} must declare provider and model.`);
    if (!ALLOWED_TIERS[card.provider]?.has(card.service_tier)) {
      throw new TypeError(`${card.id} has unsupported API service tier ${String(card.service_tier)}.`);
    }
    if (!card.source?.url || !card.source?.retrieved_at || !card.source?.version) {
      throw new TypeError(`${card.id} must include official URL, observed timestamp, and evidence version.`);
    }
    const cardProvenance = card.metadata?.provenance;
    if (!cardProvenance?.observed_at || !cardProvenance?.evidence_version
      || !/^[a-f0-9]{64}$/.test(cardProvenance?.evidence_sha256 || "")) {
      throw new TypeError(`${card.id} has absent or invalid evidence provenance.`);
    }
    if (cardProvenance.observed_at !== card.source.retrieved_at
      || cardProvenance.evidence_version !== card.source.version) {
      throw new TypeError(`${card.id} has inconsistent source and provenance observations.`);
    }
    if (!Array.isArray(card.components) || card.components.length === 0) {
      throw new TypeError(`${card.id} must include at least one price component.`);
    }
    for (const priceComponent of card.components) {
      assertDecimalString(priceComponent.price?.amount, `${card.id} component price amount`);
      assertDecimalString(priceComponent.price?.per, `${card.id} component price divisor`);
    }

    for (const name of [card.model, ...(card.aliases || [])]) {
      const prior = claimedNames.get(`${card.provider}\u0000${name}`);
      if (prior && prior !== card.model) {
        throw new TypeError(`${card.id} alias/model ${name} destructively overlaps canonical model ${prior}.`);
      }
      claimedNames.set(`${card.provider}\u0000${name}`, card.model);
    }
  }

  for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
      const left = cards[leftIndex];
      const right = cards[rightIndex];
      if (sameContext(left, right) && rangesOverlap(left, right)) {
        throw new TypeError(`${left.id} and ${right.id} overlap in the same pricing context.`);
      }
    }
  }

  return cards;
}

export function addOfficialPriceRegistry(resolution, cards = APP_OFFICIAL_PRICE_CARDS) {
  validateOfficialPriceRegistry(cards);
  const existingCards = Array.isArray(resolution?.price_cards) ? resolution.price_cards : [];
  const existingIds = new Set(existingCards.map((card) => card.id));
  const added = cards.filter((card) => !existingIds.has(card.id));
  const sourceEntries = Object.values(SOURCE_DEFINITIONS).map((definition) => ({
    name: definition.name,
    status: "selected",
    url: definition.url,
    retrieved_at: definition.observedAt,
    version: definition.evidenceVersion,
    card_count: cards.filter((card) => card.provider === definition.provider).length,
    selected: true,
  }));

  return {
    ...(resolution || {}),
    selected_source: resolution?.selected_source
      ? `${resolution.selected_source}+app-official-price-registry`
      : "app-official-price-registry",
    // App-owned cards are first so equally specific external cards cannot silently
    // override reviewed evidence. Existing cards are retained; replacement is never
    // performed by model name alone.
    price_cards: [...added, ...existingCards],
    sources: [...(resolution?.sources || []), ...sourceEntries],
  };
}

validateOfficialPriceRegistry();
