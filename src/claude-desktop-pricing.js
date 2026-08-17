import { priceClaudeUsageRecord } from "@app-usagemonitor/accounting";
import { ANTHROPIC_CLAUDE_MODEL_IDS } from "./export/index.js";

/**
 * Pricing is deliberately attached to the privacy-safe canonical-winner
 * boundary. The durable ledger may retain only keyed model identity, so this
 * adapter must not attempt to reconstruct a provider model from a hash or a
 * raw transcript label.
 */
export const CLAUDE_DESKTOP_PRICING_ADAPTER_VERSION =
  "claude-desktop-winner-pricing-adapter-v0.2";

export const CLAUDE_DESKTOP_PRODUCT_PROVIDER = "anthropic_claude_code";
export const CLAUDE_DESKTOP_ACCOUNTING_VENDOR = "anthropic";

const CLAUDE_PROVIDER = CLAUDE_DESKTOP_PRODUCT_PROVIDER;
const CLAUDE_BILLING_SURFACE = "claude_subscription";
const CLAUDE_OUTPUT_KIND = "provider_reported_combined";
const UNKNOWN_MODEL = "unknown";
const MODEL_FINGERPRINT_PATTERN = /^model:v1:[a-f0-9]{64}$/u;
const CLAUDE_MODEL_ID_SET = new Set(ANTHROPIC_CLAUDE_MODEL_IDS);
const COMPONENT_KEYS = Object.freeze([
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite5mTokens",
  "inputCacheWrite1hTokens",
  "outputCombinedTokens",
]);
const MODEL_DECLARATION_KEYS = Object.freeze([
  "modelId",
  "modelRecognition",
  "modelFingerprint",
]);
const FIXED_PRICING_OPTION_KEYS = new Set([
  "priceCards",
  "region",
  "priceEpochBasis",
  "apiServiceTier",
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function invalid(code) {
  // Never interpolate candidate values into boundary errors. A caller may
  // accidentally pass a raw provider label or other sensitive material.
  throw new TypeError(`Claude canonical winner is invalid (${code})`);
}

function requireObject(value, code) {
  const object = objectValue(value);
  if (!object) invalid(code);
  return object;
}

function requireExactKeys(value, keys, code) {
  const object = requireObject(value, code);
  const observed = Reflect.ownKeys(object);
  if (observed.length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) {
    invalid(code);
  }
  return object;
}

function requireSafeCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
  return value;
}

function safeSum(values, code) {
  let total = 0;
  for (const value of values) {
    requireSafeCount(value, code);
    total += value;
    if (!Number.isSafeInteger(total)) invalid(code);
  }
  return total;
}

function canonicalEventTime(value) {
  if (typeof value !== "string" || value.length > 32) invalid("event_time");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) invalid("event_time");
  return value;
}

function requireProvider(value, code) {
  if (value !== CLAUDE_PROVIDER) invalid(code);
}

/**
 * Metadata may be carried by the outer winner projection, the inner
 * privacy-safe candidate, or both. If both carry it they must agree. This
 * lets the ledger add output provenance without weakening the inner-provider
 * check, and avoids copying arbitrary wrapper metadata into accounting.
 */
function requireMetadata(inner, outer, key, expected) {
  const innerHas = Object.hasOwn(inner, key);
  const outerHas = outer !== inner && Object.hasOwn(outer, key);
  if (innerHas && inner[key] !== expected) invalid(`${key}_inner`);
  if (outerHas && outer[key] !== expected) invalid(`${key}_outer`);
  if (!innerHas && !outerHas) invalid(`${key}_missing`);
  if (innerHas && outerHas && inner[key] !== outer[key]) invalid(`${key}_conflict`);
}

function unwrapWinner(value) {
  const outer = requireObject(value, "required");
  const wrapped = Object.hasOwn(outer, "candidate");
  const inner = wrapped ? requireObject(outer.candidate, "candidate") : outer;
  requireProvider(outer.provider, wrapped ? "provider_outer" : "provider");
  requireProvider(inner.provider, "provider_inner");
  requireMetadata(inner, outer, "billingSurface", CLAUDE_BILLING_SURFACE);
  requireMetadata(inner, outer, "outputKind", CLAUDE_OUTPUT_KIND);
  return { outer, inner };
}

function normalizeModelDeclaration(value) {
  const declaration = requireExactKeys(value, MODEL_DECLARATION_KEYS, "model_declaration_shape");
  if (declaration.modelRecognition === "recognized"
      && typeof declaration.modelId === "string"
      && CLAUDE_MODEL_ID_SET.has(declaration.modelId)
      && declaration.modelFingerprint === null) {
    // Only reviewed, Claude-scoped identifiers cross into accounting.
    return { modelId: declaration.modelId, modelRecognition: "recognized" };
  }
  if (declaration.modelRecognition === "missing"
      && declaration.modelId === UNKNOWN_MODEL
      && declaration.modelFingerprint === null) {
    return { modelId: UNKNOWN_MODEL, modelRecognition: "missing" };
  }
  if (declaration.modelRecognition === "unrecognized"
      && declaration.modelId === UNKNOWN_MODEL
      && typeof declaration.modelFingerprint === "string"
      && MODEL_FINGERPRINT_PATTERN.test(declaration.modelFingerprint)) {
    return { modelId: UNKNOWN_MODEL, modelRecognition: "unrecognized" };
  }
  invalid("model_declaration");
}

function normalizeComponents(value, totalInputContextTokens) {
  const components = requireExactKeys(value, COMPONENT_KEYS, "components_shape");
  for (const key of [
    "inputUncachedTokens",
    "inputCacheReadTokens",
    "inputCacheWriteTokens",
    "outputCombinedTokens",
  ]) {
    requireSafeCount(components[key], `components_${key}`);
  }
  const fiveMinute = components.inputCacheWrite5mTokens;
  const oneHour = components.inputCacheWrite1hTokens;
  const noFiveMinute = fiveMinute === null;
  const noOneHour = oneHour === null;
  if (noFiveMinute !== noOneHour) invalid("cache_write_ttl_pair");
  if (!noFiveMinute) {
    requireSafeCount(fiveMinute, "components_inputCacheWrite5mTokens");
    requireSafeCount(oneHour, "components_inputCacheWrite1hTokens");
    const cacheWriteSplit = safeSum([fiveMinute, oneHour], "cache_write_ttl_sum");
    if (cacheWriteSplit !== components.inputCacheWriteTokens) invalid("cache_write_reconciliation");
  }
  requireSafeCount(totalInputContextTokens, "total_input_context_tokens");
  const total = safeSum([
    components.inputUncachedTokens,
    components.inputCacheReadTokens,
    components.inputCacheWriteTokens,
  ], "input_reconciliation");
  if (total !== totalInputContextTokens) invalid("input_reconciliation");
  return {
    inputUncachedTokens: components.inputUncachedTokens,
    inputCacheReadTokens: components.inputCacheReadTokens,
    inputCacheWriteTokens: components.inputCacheWriteTokens,
    inputCacheWrite5mTokens: fiveMinute,
    inputCacheWrite1hTokens: oneHour,
    outputCombinedTokens: components.outputCombinedTokens,
  };
}

function fixedPricingOptions(options) {
  const supplied = requireObject(options, "pricing_options");
  for (const key of Object.keys(supplied)) {
    if (!FIXED_PRICING_OPTION_KEYS.has(key)) invalid(`pricing_option_${key}`);
  }
  if (Object.hasOwn(supplied, "priceEpochBasis") && supplied.priceEpochBasis !== "event_time") {
    throw new TypeError("Claude pricing requires event_time priceEpochBasis");
  }
  if (Object.hasOwn(supplied, "apiServiceTier") && supplied.apiServiceTier !== "standard") {
    throw new TypeError("Claude pricing requires standard apiServiceTier");
  }
  const fixed = {
    priceEpochBasis: "event_time",
    apiServiceTier: "standard",
  };
  if (Object.hasOwn(supplied, "priceCards")) fixed.priceCards = supplied.priceCards;
  if (Object.hasOwn(supplied, "region")) fixed.region = supplied.region;
  return fixed;
}

/**
 * Convert a privacy-safe Claude canonical winner to the existing accounting
 * input contract. No raw transcript, source path, session ID, key, or
 * arbitrary provider model label is copied into the returned record.
 */
export function claudeDesktopWinnerToPricingRecord(value) {
  const { inner } = unwrapWinner(value);
  const model = normalizeModelDeclaration(inner.modelDeclaration);
  const components = normalizeComponents(inner.components, inner.totalInputContextTokens);
  return {
    eventTime: canonicalEventTime(inner.eventTime),
    modelId: model.modelId,
    modelRecognition: model.modelRecognition,
    totalInputContextTokens: inner.totalInputContextTokens,
    components,
  };
}

/**
 * Price a canonical Claude winner at event time using the existing official
 * registry. The result is an explicit projection envelope: `pricing.provider`
 * remains the accounting kernel's vendor (`anthropic`), while
 * `productProvider` preserves the product/provider identity (`anthropic_claude_code`).
 */
export function priceClaudeDesktopWinner(value, options = {}) {
  const pricing = priceClaudeUsageRecord(
    claudeDesktopWinnerToPricingRecord(value),
    fixedPricingOptions(options),
  );
  return {
    productProvider: CLAUDE_PROVIDER,
    accountingVendor: CLAUDE_DESKTOP_ACCOUNTING_VENDOR,
    pricing,
  };
}
