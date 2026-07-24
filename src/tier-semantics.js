const BILLING_SURFACES = new Set(["chatgpt_subscription", "openai_api", "unknown"]);
const CODEX_SPEED_MODES = new Set(["standard", "fast", "unknown", "other"]);
const API_SERVICE_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown", "other"]);
const TIER_SOURCES = new Set([
  "app_server_effective",
  "turn_override",
  "app_log",
  "rollout_thread_settings",
  "config",
  "experiment_manifest",
  "unobserved",
]);

function safeRawTier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,64}$/.test(value) ? value : null;
}

function requireEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(`${field} is invalid`);
}

function requireIsoTimestampOrNull(value, field) {
  if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
    throw new Error(`${field} must be an ISO timestamp or null`);
  }
}

export function validateTierDeclaration(value) {
  if (!value || typeof value !== "object") throw new Error("tierDeclaration is required");
  requireEnum(value.billingSurface, BILLING_SURFACES, "tierDeclaration.billingSurface");
  requireEnum(value.codexSpeedMode, CODEX_SPEED_MODES, "tierDeclaration.codexSpeedMode");
  requireEnum(value.apiServiceTier, API_SERVICE_TIERS, "tierDeclaration.apiServiceTier");
  requireEnum(value.tierSource, TIER_SOURCES, "tierDeclaration.tierSource");
  requireIsoTimestampOrNull(value.tierObservedAt, "tierDeclaration.tierObservedAt");
  if (value.providerTierRaw !== null && safeRawTier(value.providerTierRaw) === null) {
    throw new Error("tierDeclaration.providerTierRaw must be a safe provider classification or null");
  }
  if (value.billingSurface === "chatgpt_subscription" && value.apiServiceTier !== "unknown") {
    throw new Error("ChatGPT subscription observations may not declare an API service tier");
  }
  if (value.billingSurface === "openai_api" && value.codexSpeedMode !== "unknown") {
    throw new Error("OpenAI API observations may not declare a Codex speed mode");
  }
  return value;
}

export function normalizeProviderTier(rawTier, {
  billingSurface = "unknown",
  tierSource = "unobserved",
  tierObservedAt = null,
} = {}) {
  requireEnum(billingSurface, BILLING_SURFACES, "billingSurface");
  requireEnum(tierSource, TIER_SOURCES, "tierSource");
  requireIsoTimestampOrNull(tierObservedAt, "tierObservedAt");
  const raw = safeRawTier(rawTier);
  const normalized = raw?.toLowerCase() ?? null;
  let codexSpeedMode = "unknown";
  let apiServiceTier = "unknown";
  if (billingSurface === "chatgpt_subscription") {
    if (normalized === "default" || normalized === "standard") codexSpeedMode = "standard";
    else if (normalized === "priority" || normalized === "fast") codexSpeedMode = "fast";
    else if (normalized !== null) codexSpeedMode = "other";
  } else if (billingSurface === "openai_api") {
    if (normalized === "default" || normalized === "standard") apiServiceTier = "standard";
    else if (["priority", "flex", "batch"].includes(normalized)) apiServiceTier = normalized;
    else if (normalized !== null) apiServiceTier = "other";
  }
  return {
    schemaVersion: "0.1",
    billingSurface,
    codexSpeedMode,
    apiServiceTier,
    providerTierRaw: raw,
    tierSource,
    tierObservedAt,
  };
}

export function unknownCodexTier() {
  return normalizeProviderTier(null, {
    billingSurface: "chatgpt_subscription",
    tierSource: "unobserved",
    tierObservedAt: null,
  });
}

export function fastQuotaMultiplier(model) {
  if (typeof model !== "string") return null;
  if (/^gpt-5\.(?:5|6)(?:$|-)/.test(model)) return 2.5;
  if (/^gpt-5\.4(?:$|-)/.test(model)) return 2;
  return null;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

export function subscriptionSpeedSensitivity(byModel, observedSpeedMode = "unknown") {
  requireEnum(observedSpeedMode, CODEX_SPEED_MODES, "observedSpeedMode");
  let standardApiEquivalentUsd = 0;
  let fastWeightedEquivalentUsd = 0;
  let unsupportedStandardApiEquivalentUsd = 0;
  const modelMultipliers = {};
  for (const [model, summary] of Object.entries(byModel ?? {})) {
    const costUsd = Number(summary?.costUsd ?? 0);
    if (!Number.isFinite(costUsd) || costUsd < 0) continue;
    standardApiEquivalentUsd += costUsd;
    const multiplier = fastQuotaMultiplier(model);
    modelMultipliers[model] = multiplier;
    if (multiplier === null) unsupportedStandardApiEquivalentUsd += costUsd;
    else fastWeightedEquivalentUsd += costUsd * multiplier;
  }
  const complete = unsupportedStandardApiEquivalentUsd === 0;
  const scenarios = {
    standard: {
      relativeQuotaWeight: 1,
      weightedStandardApiEquivalentUsd: roundUsd(standardApiEquivalentUsd),
      complete: true,
    },
    fast: {
      relativeQuotaWeight: "model_specific",
      weightedStandardApiEquivalentUsd: complete ? roundUsd(fastWeightedEquivalentUsd) : null,
      supportedWeightedStandardApiEquivalentUsd: roundUsd(fastWeightedEquivalentUsd),
      unsupportedStandardApiEquivalentUsd: roundUsd(unsupportedStandardApiEquivalentUsd),
      complete,
    },
  };
  return {
    basis: "codex_subscription_speed_multiplier_applied_to_standard_api_equivalent_not_api_cost",
    observedSpeedMode,
    selectedScenario: observedSpeedMode === "standard" || observedSpeedMode === "fast" ? observedSpeedMode : null,
    scenarios,
    modelMultipliers,
  };
}
