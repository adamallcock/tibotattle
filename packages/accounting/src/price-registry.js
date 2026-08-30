// Reviewed provider price evidence shared by local and edge accounting adapters.
export const APP_PRICE_REGISTRY_OBSERVED_AT = "2026-08-30T06:01:00Z";
// First official-page review. This is the review boundary, not a lower bound
// on the reviewed model rates: recognized OpenAI/Codex events before this date
// remain priceable unless a card has an explicit vendor-effective boundary.
const OPENAI_FIRST_OBSERVED_DATE = "2026-07-26";
export const OPENAI_PRICE_EVIDENCE_START_DATE = OPENAI_FIRST_OBSERVED_DATE;
// Same review-boundary semantics as OpenAI above: this timestamp records when
// the Anthropic pricing page was reviewed. It is provenance only and never a
// lower bound on the reviewed model rates.
const ANTHROPIC_OBSERVED_AT = "2026-07-25T14:18:33Z";
const PER_MILLION = "1000000";
export const APP_PRICE_REGISTRY_VERSION = "app-official-api-prices-v0.5";

export const OFFICIAL_PRICE_SOURCE_URLS = Object.freeze({
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
});

export const OPENAI_LONG_CONTEXT_SOURCE_URLS = Object.freeze([
  "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  "https://developers.openai.com/api/docs/models/gpt-5.5",
  "https://developers.openai.com/api/docs/models/gpt-5.4",
]);

// Codex model variants are absent from the official pricing page but carry
// explicit first-party rates on their own model pages, reviewed 2026-08-30.
// They are standalone models with standalone cards, not routing aliases.
export const OPENAI_CODEX_MODEL_SOURCE_URLS = Object.freeze([
  "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  "https://developers.openai.com/api/docs/models/gpt-5.2-codex",
  "https://developers.openai.com/api/docs/models/gpt-5.1-codex",
  "https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini",
  "https://developers.openai.com/api/docs/models/gpt-5-codex",
]);

const SOURCE_DEFINITIONS = Object.freeze({
  openai: Object.freeze({
    provider: "openai",
    name: "openai-official-api-pricing",
    url: OFFICIAL_PRICE_SOURCE_URLS.openai,
    observedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    evidenceVersion: "openai-api-pricing-reviewed-2026-08-30",
    evidenceUrls: Object.freeze([
      OFFICIAL_PRICE_SOURCE_URLS.openai,
      ...OPENAI_LONG_CONTEXT_SOURCE_URLS,
      ...OPENAI_CODEX_MODEL_SOURCE_URLS,
    ]),
  }),
  anthropic: Object.freeze({
    provider: "anthropic",
    name: "anthropic-official-api-pricing",
    url: OFFICIAL_PRICE_SOURCE_URLS.anthropic,
    observedAt: ANTHROPIC_OBSERVED_AT,
    evidenceVersion: "anthropic-api-pricing-reviewed-2026-07-25",
    evidenceUrls: Object.freeze([OFFICIAL_PRICE_SOURCE_URLS.anthropic]),
  }),
});

const OPENAI_ROWS = Object.freeze([
  // Values are model, API tier, input, cache read, cache write, output
  // USD/MTok, optional context band, and optional dated validity period. The
  // 272K boundary is inclusive on the long side to preserve the monitor's
  // established threshold contract. GPT-5.6 Terra and Luna were officially
  // repriced effective 2026-07-30. GPT-5.6 Sol was officially repriced
  // effective 2026-08-21 (owner-stated vendor boundary); its pre-change rows
  // keep the explicit validity window so historical pricing is preserved.
  // Undated rows remain open to reviewed historical events; the review date
  // is provenance, not an invented model-rate start date.
  //
  // 2026-08-30 review notes: the official pricing page labels the priority
  // tier's tab "Fast mode" (OpenAI renamed API Priority processing to Fast
  // mode on 2026-07-30); "priority" remains this registry's canonical tier
  // name for those rows. The review was made from owner-supplied captures of
  // the Standard, Batch, and Fast tabs plus the first-party Codex model
  // pages. The Flex tab was not captured, so Sol has no post-2026-08-21 flex
  // row and Sol flex events after that date are deliberately unpriced until
  // the tab is reviewed. Priority long-context rows exist on the page only
  // for the GPT-5.6 family; GPT-5.5 / GPT-5.4 / GPT-5.4-mini show "-" there.
  ["gpt-5.6-sol", "standard", "5", "0.5", "6.25", "30", "short", "through-2026-08-20"],
  ["gpt-5.6-sol", "standard", "10", "1", "12.5", "45", "long", "through-2026-08-20"],
  ["gpt-5.6-sol", "batch", "2.5", "0.25", "3.125", "15", "short", "through-2026-08-20"],
  ["gpt-5.6-sol", "batch", "5", "0.5", "6.25", "22.5", "long", "through-2026-08-20"],
  ["gpt-5.6-sol", "flex", "2.5", "0.25", "3.125", "15", "short", "through-2026-08-20"],
  ["gpt-5.6-sol", "flex", "5", "0.5", "6.25", "22.5", "long", "through-2026-08-20"],
  ["gpt-5.6-sol", "priority", "10", "1", "12.5", "60", "short", "through-2026-08-20"],
  // Sol from 2026-08-21: Batch and Fast (priority) rows are read directly
  // from the captured official tabs. The Standard rows are triangulated from
  // two independent official relationships that agree exactly - Batch is half
  // of Standard on every component, and the captured Fast rows are twice the
  // implied Standard on every component - pending a direct capture of the
  // Standard tab's flagship table.
  ["gpt-5.6-sol", "standard", "4", "0.4", "5", "20", "short", "from-2026-08-21"],
  ["gpt-5.6-sol", "standard", "8", "0.8", "10", "30", "long", "from-2026-08-21"],
  ["gpt-5.6-sol", "batch", "2", "0.2", "2.5", "10", "short", "from-2026-08-21"],
  ["gpt-5.6-sol", "batch", "4", "0.4", "5", "15", "long", "from-2026-08-21"],
  ["gpt-5.6-sol", "priority", "8", "0.8", "10", "40", "short", "from-2026-08-21"],
  ["gpt-5.6-sol", "priority", "16", "1.6", "20", "60", "long", "from-2026-08-21"],
  ["gpt-5.6-terra", "standard", "2.5", "0.25", "3.125", "15", "short", "through-2026-07-29"],
  ["gpt-5.6-terra", "standard", "2", "0.2", "2.5", "12", "short", "from-2026-07-30"],
  ["gpt-5.6-terra", "standard", "5", "0.5", "6.25", "22.5", "long", "through-2026-07-29"],
  ["gpt-5.6-terra", "standard", "4", "0.4", "5", "18", "long", "from-2026-07-30"],
  ["gpt-5.6-terra", "batch", "1.25", "0.125", "1.5625", "7.5", "short", "through-2026-07-29"],
  ["gpt-5.6-terra", "batch", "1", "0.1", "1.25", "6", "short", "from-2026-07-30"],
  ["gpt-5.6-terra", "batch", "2.5", "0.25", "3.125", "11.25", "long", "through-2026-07-29"],
  ["gpt-5.6-terra", "batch", "2", "0.2", "2.5", "9", "long", "from-2026-07-30"],
  ["gpt-5.6-terra", "flex", "1.25", "0.125", "1.5625", "7.5", "short", "through-2026-07-29"],
  ["gpt-5.6-terra", "flex", "1", "0.1", "1.25", "6", "short", "from-2026-07-30"],
  ["gpt-5.6-terra", "flex", "2.5", "0.25", "3.125", "11.25", "long", "through-2026-07-29"],
  ["gpt-5.6-terra", "flex", "2", "0.2", "2.5", "9", "long", "from-2026-07-30"],
  ["gpt-5.6-terra", "priority", "5", "0.5", "6.25", "30", "short", "through-2026-07-29"],
  ["gpt-5.6-terra", "priority", "4", "0.4", "5", "24", "short", "from-2026-07-30"],
  // Priority (Fast) long-context rows first appeared in the 2026-08-30
  // review. Their values are consistent only with the from-2026-07-30
  // Standard long rates (exactly 2x on every component), so the boundary is
  // inherited from that published repricing rather than invented; earlier
  // priority long-context events stay deliberately unpriced.
  ["gpt-5.6-terra", "priority", "8", "0.8", "10", "36", "long", "from-2026-07-30"],
  ["gpt-5.6-luna", "standard", "1", "0.1", "1.25", "6", "short", "through-2026-07-29"],
  ["gpt-5.6-luna", "standard", "0.2", "0.02", "0.25", "1.2", "short", "from-2026-07-30"],
  ["gpt-5.6-luna", "standard", "2", "0.2", "2.5", "9", "long", "through-2026-07-29"],
  ["gpt-5.6-luna", "standard", "0.4", "0.04", "0.5", "1.8", "long", "from-2026-07-30"],
  ["gpt-5.6-luna", "batch", "0.5", "0.05", "0.625", "3", "short", "through-2026-07-29"],
  ["gpt-5.6-luna", "batch", "0.1", "0.01", "0.125", "0.6", "short", "from-2026-07-30"],
  ["gpt-5.6-luna", "batch", "1", "0.1", "1.25", "4.5", "long", "through-2026-07-29"],
  ["gpt-5.6-luna", "batch", "0.2", "0.02", "0.25", "0.9", "long", "from-2026-07-30"],
  ["gpt-5.6-luna", "flex", "0.5", "0.05", "0.625", "3", "short", "through-2026-07-29"],
  ["gpt-5.6-luna", "flex", "0.1", "0.01", "0.125", "0.6", "short", "from-2026-07-30"],
  ["gpt-5.6-luna", "flex", "1", "0.1", "1.25", "4.5", "long", "through-2026-07-29"],
  ["gpt-5.6-luna", "flex", "0.2", "0.02", "0.25", "0.9", "long", "from-2026-07-30"],
  ["gpt-5.6-luna", "priority", "2", "0.2", "2.5", "12", "short", "through-2026-07-29"],
  ["gpt-5.6-luna", "priority", "0.4", "0.04", "0.5", "2.4", "short", "from-2026-07-30"],
  // Same provenance as the Terra priority long row above.
  ["gpt-5.6-luna", "priority", "0.8", "0.08", "1", "3.6", "long", "from-2026-07-30"],
  ["gpt-5.5", "standard", "5", "0.5", null, "30", "short"],
  ["gpt-5.5", "standard", "10", "1", null, "45", "long"],
  ["gpt-5.5", "batch", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.5", "batch", "5", "0.5", null, "22.5", "long"],
  ["gpt-5.5", "flex", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.5", "flex", "5", "0.5", null, "22.5", "long"],
  ["gpt-5.5", "priority", "12.5", "1.25", null, "75", "short"],
  ["gpt-5.4", "standard", "2.5", "0.25", null, "15", "short"],
  ["gpt-5.4", "standard", "5", "0.5", null, "22.5", "long"],
  ["gpt-5.4", "batch", "1.25", "0.13", null, "7.5", "short"],
  // The official Batch/Flex long-context cached-input cell read $0.26 in the
  // 2026-07-26 review and reads $0.25 as of the 2026-08-01 review; the change
  // is dated with the same 2026-07-30 boundary as the GPT-5.6 repricing.
  ["gpt-5.4", "batch", "2.5", "0.26", null, "11.25", "long", "through-2026-07-29"],
  ["gpt-5.4", "batch", "2.5", "0.25", null, "11.25", "long", "from-2026-07-30"],
  ["gpt-5.4", "flex", "1.25", "0.13", null, "7.5", "short"],
  ["gpt-5.4", "flex", "2.5", "0.26", null, "11.25", "long", "through-2026-07-29"],
  ["gpt-5.4", "flex", "2.5", "0.25", null, "11.25", "long", "from-2026-07-30"],
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
  // Flagship models below the main table, reviewed 2026-08-30 from the
  // captured Batch tab only; their Standard and Fast rows were not captured,
  // so those tiers stay deliberately unpriced until reviewed.
  ["gpt-5.5-pro", "batch", "15", null, null, "90"],
  ["gpt-5.4-nano", "batch", "0.1", "0.01", null, "0.625"],
  ["gpt-5.4-pro", "batch", "15", null, null, "90", "short"],
  ["gpt-5.4-pro", "batch", "30", null, null, "135", "long"],
  // Non-flagship models from the official pricing page's second table,
  // reviewed 2026-08-30 (Standard and Batch tabs; the Fast tab lists a
  // priority row only for the models that carry one below). A "-" cell on
  // the page is an absent component here, never a zero.
  ["gpt-5.2", "standard", "1.75", "0.175", null, "14"],
  ["gpt-5.2", "batch", "0.875", "0.0875", null, "7"],
  ["gpt-5.2", "priority", "3.5", "0.35", null, "28"],
  ["gpt-5.2-pro", "standard", "21", null, null, "168"],
  ["gpt-5.2-pro", "batch", "10.5", null, null, "84"],
  ["gpt-5.1", "standard", "1.25", "0.125", null, "10"],
  ["gpt-5.1", "batch", "0.625", "0.0625", null, "5"],
  ["gpt-5.1", "priority", "2.5", "0.25", null, "20"],
  ["gpt-5-mini", "standard", "0.25", "0.025", null, "2"],
  ["gpt-5-mini", "batch", "0.125", "0.0125", null, "1"],
  ["gpt-5-mini", "priority", "0.45", "0.045", null, "3.6"],
  ["gpt-5-nano", "standard", "0.05", "0.005", null, "0.4"],
  ["gpt-5-nano", "batch", "0.025", "0.0025", null, "0.2"],
  ["gpt-5-pro", "standard", "15", null, null, "120"],
  ["gpt-5-pro", "batch", "7.5", null, null, "60"],
  ["gpt-4.1-mini", "standard", "0.4", "0.1", null, "1.6"],
  ["gpt-4.1-mini", "batch", "0.2", null, null, "0.8"],
  ["gpt-4.1-mini", "priority", "0.7", "0.175", null, "2.8"],
  ["gpt-4.1-nano", "standard", "0.1", "0.025", null, "0.4"],
  ["gpt-4.1-nano", "batch", "0.05", null, null, "0.2"],
  ["gpt-4.1-nano", "priority", "0.2", "0.05", null, "0.8"],
  ["gpt-4o", "standard", "2.5", "1.25", null, "10"],
  ["gpt-4o", "batch", "1.25", null, null, "5"],
  ["gpt-4o", "priority", "4.25", "2.125", null, "17"],
  ["gpt-4o-mini", "standard", "0.15", "0.075", null, "0.6"],
  ["gpt-4o-mini", "batch", "0.075", null, null, "0.3"],
  ["o4-mini", "standard", "1.1", "0.275", null, "4.4"],
  ["o4-mini", "batch", "0.55", null, null, "2.2"],
  ["o3", "standard", "2", "0.5", null, "8"],
  ["o3", "batch", "1", null, null, "4"],
  ["o3-mini", "standard", "1.1", "0.55", null, "4.4"],
  ["o3-mini", "batch", "0.55", null, null, "2.2"],
  ["o3-pro", "standard", "20", null, null, "80"],
  ["o3-pro", "batch", "10", null, null, "40"],
  ["o1", "standard", "15", "7.5", null, "60"],
  ["o1", "batch", "7.5", null, null, "30"],
  ["o1-pro", "standard", "150", null, null, "600"],
  ["o1-pro", "batch", "75", null, null, "300"],
  ["gpt-4o-2024-05-13", "standard", "5", null, null, "15"],
  ["gpt-4o-2024-05-13", "batch", "2.5", null, null, "7.5"],
  ["gpt-4-turbo-2024-04-09", "standard", "10", null, null, "30"],
  ["gpt-4-turbo-2024-04-09", "batch", "5", null, null, "15"],
  // Codex model variants, priced from their first-party model pages reviewed
  // 2026-08-30 (see OPENAI_CODEX_MODEL_SOURCE_URLS). The pages list Standard
  // rates only - no Batch, Flex, or long-context tiering - and gpt-5-codex is
  // documented as sharing gpt-5.1-codex rates. gpt-5.5-codex remains a
  // routing alias of gpt-5.5 above rather than a row here.
  ["gpt-5.3-codex", "standard", "1.75", "0.175", null, "14"],
  ["gpt-5.2-codex", "standard", "1.75", "0.175", null, "14"],
  ["gpt-5.1-codex", "standard", "1.25", "0.125", null, "10"],
  // Owner-stated 2026-08-30: gpt-5.1-codex offered Priority (Fast) at these
  // rates - exactly 2x its Standard row and identical to base gpt-5.1's
  // Priority row - although the current model page no longer lists tiers.
  ["gpt-5.1-codex", "priority", "2.5", "0.25", null, "20"],
  ["gpt-5.1-codex-mini", "standard", "0.25", "0.025", null, "2"],
  ["gpt-5-codex", "standard", "1.25", "0.125", null, "10"],
]);

const ANTHROPIC_ROWS = Object.freeze([
  // Values are base input, 5m write, 1h write, cache read, and output USD/MTok,
  // plus an optional dated validity period. Only Claude Sonnet 5 carries a
  // published vendor boundary: the introductory rate runs through 2026-08-31 and
  // the standard rate takes effect 2026-09-01. Every other row is undated and
  // stays open-ended in both directions; the review date is provenance, not an
  // invented model-rate start date.
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

export const NORMALIZED_PRICE_EVIDENCE_ROWS = deepFreeze({
  openai: [OPENAI_ROWS, OPENAI_TOOL_ROWS],
  anthropic: [ANTHROPIC_ROWS, ANTHROPIC_TOOL_ROWS],
});

// These hashes are generated from the normalized reviewed rows during an
// evidence refresh and checked independently in Node-side registry tests. They
// are constants here so the production registry has no Node crypto dependency.
const EVIDENCE_HASHES = Object.freeze({
  openai: "17aaeb750077949d26ec8b74149d4e85805bfc6ede898e563d268d4c119e970e",
  anthropic: "7653380aa58230fef8a39a17f141fe04bd763ca39390a69671825e6f6109d76e",
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

function providerUnitComponent(usageComponent, amount, unit, per, conditions) {
  return {
    usage_component: usageComponent,
    unit,
    price: { amount, currency: "USD", per },
    ...(conditions ? { conditions } : {}),
  };
}

function provenance(provider, { vendorEffectiveFrom = null, vendorEffectiveTo = null } = {}) {
  const source = SOURCE_DEFINITIONS[provider];
  return {
    observed_at: source.observedAt,
    evidence_version: source.evidenceVersion,
    evidence_sha256: EVIDENCE_HASHES[provider],
    evidence_hash_scope: "normalized_reviewed_price_rows",
    evidence_urls: source.evidenceUrls,
    vendor_effective_from: vendorEffectiveFrom,
    vendor_effective_to: vendorEffectiveTo,
    historical_validity: vendorEffectiveFrom || vendorEffectiveTo
      ? "official_vendor_window"
      : "reviewed_rate_without_vendor_effective_date",
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
  const observedDate = SOURCE_DEFINITIONS[provider].observedAt.slice(0, 10);
  return `${provider}:${model}:${tier}:${suffix}:official-observed-${observedDate}`;
}

// Effective-window helpers. The review dates remain provenance metadata for
// every provider; only an explicit vendor-effective date constrains selection,
// so all reviewed history stays priceable as far back as events go.

function openAiEffective(period) {
  const through = typeof period === "string" && /^through-(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (through) {
    return {
      effective: { to: through[1] },
      vendorEffectiveFrom: null,
      vendorEffectiveTo: through[1],
      suffix: period,
    };
  }
  const from = typeof period === "string" && /^from-(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (from) {
    return {
      effective: { from: from[1] },
      vendorEffectiveFrom: from[1],
      vendorEffectiveTo: null,
      suffix: period,
    };
  }
  if (period !== null && period !== undefined) {
    throw new TypeError(`Unrecognized OpenAI price validity period: ${String(period)}`);
  }
  return {
    // No vendor-effective date was published for this row. An open effective
    // range is deliberate: the reviewed card may price recognized historical
    // events before the review date, while dated repricing rows below remain
    // bounded by their explicit vendor boundary.
    effective: {},
    vendorEffectiveFrom: null,
    vendorEffectiveTo: null,
    suffix: "current",
  };
}

// Routing aliases OpenAI exposes in the model picker that resolve to a model
// already priced here. They are not separate products and are not listed
// separately on the pricing page, so they share the target's rates rather than
// falling through to "unrecognized" and losing their cost entirely. Each alias
// must carry a stated assumption, because sharing a rate is a claim about
// billing that the registry is asserting on the vendor's behalf.
const OPENAI_MODEL_ALIASES = Object.freeze({
  "gpt-5.4": ["codex-auto-review"],
  "gpt-5.5": ["gpt-5.5-codex"],
  "gpt-5.6-sol": ["gpt-5.6-sol-wm"],
});

const OPENAI_ALIAS_ASSUMPTIONS = Object.freeze({
  "codex-auto-review":
    "Owner-directed: priced at gpt-5.4 rates. codex-auto-review is an OpenAI-managed routing alias and the underlying model is not publicly disclosed, so this is an assumption rather than a published mapping. It rests on gpt-5.4 having been the documented Auto-review model until 2026-04-16 and remaining the explicit Bedrock Codex reviewer. It is known to be wrong for API-key Codex from 2026-08-05, where Auto-review moved to gpt-5.6-luna; ChatGPT-auth Codex still sends this alias.",
  "gpt-5.5-codex":
    "Assumed to share gpt-5.5 API rates; not listed separately on the official pricing page.",
  "gpt-5.6-sol-wm":
    "Work Mode routing alias for gpt-5.6-sol; the picker describes it as a routing alias, so it is billed at the gpt-5.6-sol rates and is not listed separately on the official pricing page.",
});

function openAiCard([model, tier, input, cacheRead, cacheWrite, output, contextBand = null, period = null]) {
  const contextConditions = contextBand === "short"
    ? { max_total_input_tokens: "271999" }
    : contextBand === "long"
      ? { min_total_input_tokens: "272000" }
      : null;
  const aliases = OPENAI_MODEL_ALIASES[model];
  const validity = openAiEffective(period);
  const bandSuffix = contextBand ?? "current";
  return {
    schema_version: "0.1",
    id: cardId("openai", model, tier, period ? `${bandSuffix}-${validity.suffix}` : bandSuffix),
    provider: "openai",
    model,
    ...(aliases ? { aliases } : {}),
    service_tier: tier,
    region: "global",
    effective: validity.effective,
    components: [
      component("input_uncached_tokens", input, contextConditions),
      component("input_cache_read_tokens", cacheRead, contextConditions),
      component("input_cache_write_tokens", cacheWrite, contextConditions),
      component("output_text_tokens", output, contextConditions),
      providerUnitComponent("web_search_units", "10", "search", "1000", contextConditions),
      providerUnitComponent("file_search_units", "2.5", "call", "1000", contextConditions),
    ].filter(Boolean),
    source: source("openai"),
    metadata: {
      pricing_basis: "official_api_price_not_subscription_allowance",
      api_service_tier: tier,
      subscription_speed_tier: null,
      total_input_context_band: contextBand,
      provenance: provenance("openai", validity),
      ...(aliases ? {
        alias_assumptions: Object.fromEntries(
          aliases.map((alias) => [alias, OPENAI_ALIAS_ASSUMPTIONS[alias]]),
        ),
      } : {}),
      ...(contextBand ? {
        coverage_note: contextBand === "short"
          ? "Short-context prices apply through 271,999 total input tokens; the long band begins at 272,000."
          : "Long-context prices apply from 272,000 total input tokens using the official 2x input and 1.5x output rule.",
      } : {}),
    },
  };
}

function anthropicEffective(period) {
  if (period === "introductory") {
    // Closed only at the published vendor change on 2026-09-01, exactly like the
    // OpenAI through-2026-07-29 rows. The window stays open backwards so events
    // of any age select the introductory rate that was in force at the time.
    return {
      effective: { to: "2026-08-31" },
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
    // No vendor-effective date was published for this row, so the effective
    // range is open in both directions. The review date is provenance and must
    // never act as a lower bound that unprices earlier recognized history.
    effective: {},
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
    // Provider tool unit prices carry no published vendor-effective date, so the
    // window is open in both directions and historical tool units stay priced.
    effective: {},
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

export const APP_PRICE_REGISTRY_SHA256 =
  "45ab781bca313bf1861ae9f00b09dc8b42d3d3658edc997fc991f5a950a22dad";

export const APP_PRICE_REGISTRY_MANIFEST = deepFreeze({
  version: APP_PRICE_REGISTRY_VERSION,
  sha256: APP_PRICE_REGISTRY_SHA256,
  observedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
  priceBasis: "official_api_price_not_subscription_allowance",
  historicalDefault: "event_time_when_official_effective_window_matches",
  sources: Object.values(SOURCE_DEFINITIONS).map((definition) => ({
    provider: definition.provider,
    url: definition.url,
    observedAt: definition.observedAt,
    evidenceVersion: definition.evidenceVersion,
    evidenceUrls: definition.evidenceUrls,
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

function contextBandsOverlap(left, right) {
  const leftBand = left.metadata?.total_input_context_band ?? null;
  const rightBand = right.metadata?.total_input_context_band ?? null;
  return leftBand === null || rightBand === null || leftBand === rightBand;
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
    const contextBand = card.metadata?.total_input_context_band ?? null;
    if (![null, "short", "long"].includes(contextBand)) {
      throw new TypeError(`${card.id} has an invalid total-input context band.`);
    }
    for (const priceComponent of card.components) {
      assertDecimalString(priceComponent.price?.amount, `${card.id} component price amount`);
      assertDecimalString(priceComponent.price?.per, `${card.id} component price divisor`);
      if (contextBand === "short"
        && (priceComponent.conditions?.max_total_input_tokens !== "271999"
          || priceComponent.conditions?.min_total_input_tokens !== undefined)) {
        throw new TypeError(`${card.id} has a malformed short-context component boundary.`);
      }
      if (contextBand === "long"
        && (priceComponent.conditions?.min_total_input_tokens !== "272000"
          || priceComponent.conditions?.max_total_input_tokens !== undefined)) {
        throw new TypeError(`${card.id} has a malformed long-context component boundary.`);
      }
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
      if (sameContext(left, right) && rangesOverlap(left, right) && contextBandsOverlap(left, right)) {
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
    evidence_urls: definition.evidenceUrls,
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
