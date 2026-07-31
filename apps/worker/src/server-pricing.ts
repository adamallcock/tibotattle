import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  APP_PRICE_REGISTRY_OBSERVED_AT,
  priceUsageEvent,
} from "@app-usagemonitor/accounting";
import type { TelemetryUsageEvent } from "./telemetry-validation";

export const SERVER_PRICING_METHOD_VERSION = "server-api-price-equivalent-v0.1";

type PricingStatus = "fully_priced" | "partially_priced" | "unpriced";

export interface ServerPricingResult {
  exactCostUsd: string;
  costNanousd: number;
  coveragePercent: number;
  coverageStatus: PricingStatus;
  unknownBillableUnits: number;
  unpricedReasonCodes: string[];
  selectedPriceCardIds: string[];
  methodVersion: typeof SERVER_PRICING_METHOD_VERSION;
  registryVersion: string;
  registrySha256: string;
  registryObservedAt: string;
  priceEpochBasis: "current_price_sensitivity_at_registry_observation";
  apiServiceTier: "standard" | "priority" | "flex" | "batch" | "unknown";
  tierBasis: "subscription_standard_counterfactual" | "observed_api_service_tier"
    | "api_service_tier_unavailable";
  subscriptionSpeedMode: TelemetryUsageEvent["speedMode"];
}

const CONTEXT_SENSITIVE_OPENAI_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
const MAX_PARTICIPANT_USAGE_EVENTS = 20_000;
const MAX_SAFE_EVENT_NANOUSD = Math.floor(
  Number.MAX_SAFE_INTEGER / MAX_PARTICIPANT_USAGE_EVENTS,
);

function decimalParts(value: string): { integer: bigint; scale: number } {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new TypeError("server price must be a non-negative decimal string");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function toNanousd(value: string): number {
  const parsed = decimalParts(value);
  let nanos: bigint;
  if (parsed.scale <= 9) {
    nanos = parsed.integer * (10n ** BigInt(9 - parsed.scale));
  } else {
    const divisor = 10n ** BigInt(parsed.scale - 9);
    const quotient = parsed.integer / divisor;
    const remainder = parsed.integer % divisor;
    if (remainder !== 0n) {
      throw new RangeError("server price exceeds exact nanousd precision");
    }
    nanos = quotient;
  }
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("server price exceeds fixed-scale storage range");
  }
  return Number(nanos);
}

function positiveIntegerQuantity(value: string | null): bigint {
  if (value === null || !/^\d+$/u.test(value)) return 0n;
  return BigInt(value);
}

function boundedNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function tierForEvent(row: TelemetryUsageEvent): {
  apiServiceTier: ServerPricingResult["apiServiceTier"];
  tierBasis: ServerPricingResult["tierBasis"];
} {
  const subscription = row.billingSurface === "chatgpt_subscription"
    || row.billingSurface === "claude_subscription";
  if (subscription) {
    return {
      apiServiceTier: "standard",
      tierBasis: "subscription_standard_counterfactual",
    };
  }
  if (row.billingSurface === "openai_api"
      && ["standard", "priority", "flex", "batch"].includes(row.apiServiceTier)) {
    return {
      apiServiceTier: row.apiServiceTier as "standard" | "priority" | "flex" | "batch",
      tierBasis: "observed_api_service_tier",
    };
  }
  return {
    apiServiceTier: "unknown",
    tierBasis: "api_service_tier_unavailable",
  };
}

function failClosed(
  row: TelemetryUsageEvent,
  reasonCode: string,
  tier: ReturnType<typeof tierForEvent>,
): ServerPricingResult {
  const unknown = Object.values(row.components).reduce(
    (sum: bigint, value) => sum + BigInt(value ?? 0),
    0n,
  );
  return {
    exactCostUsd: "0",
    costNanousd: 0,
    coveragePercent: 0,
    coverageStatus: "unpriced",
    unknownBillableUnits: boundedNumber(unknown),
    unpricedReasonCodes: [reasonCode],
    selectedPriceCardIds: [],
    methodVersion: SERVER_PRICING_METHOD_VERSION,
    registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    registrySha256: APP_PRICE_REGISTRY_MANIFEST.sha256,
    registryObservedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    priceEpochBasis: "current_price_sensitivity_at_registry_observation",
    apiServiceTier: tier.apiServiceTier,
    tierBasis: tier.tierBasis,
    subscriptionSpeedMode: row.speedMode,
  };
}

export function priceTelemetryUsageEvent(row: TelemetryUsageEvent): ServerPricingResult {
  const tier = tierForEvent(row);
  if (row.modelRecognition !== "recognized" || row.modelId === "unknown") {
    return failClosed(row, "unknown_model", tier);
  }
  if (tier.apiServiceTier === "unknown") {
    return failClosed(row, "api_service_tier_unavailable", tier);
  }
  if (row.provider === "openai_codex"
      && CONTEXT_SENSITIVE_OPENAI_MODELS.has(row.modelId)
      && row.totalInputContextTokens === null) {
    return failClosed(row, "total_input_context_missing", tier);
  }

  const provider = row.provider === "openai_codex" ? "openai" : "anthropic";
  const surface = provider === "openai" ? "openai.responses" : "anthropic.messages";
  const priced = priceUsageEvent({
    provider,
    model: row.modelId,
    surface,
    apiTier: tier.apiServiceTier,
    pricedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    totalInputContextTokens: row.totalInputContextTokens,
    components: row.components,
  }, {
    priceCards: APP_OFFICIAL_PRICE_CARDS,
    pricingContext: {
      priceEpochBasis: "current_price_sensitivity_at_registry_observation",
    },
  });

  const pricedUnits = priced.components.reduce(
    (sum: bigint, component) => sum + (
      component.pricingStatus === "priced" ? positiveIntegerQuantity(component.quantity) : 0n
    ),
    0n,
  );
  const unpricedUnits = priced.components.reduce(
    (sum: bigint, component) => sum + (
      component.pricingStatus === "unpriced" ? positiveIntegerQuantity(component.quantity) : 0n
    ),
    0n,
  );
  const observedUnits = pricedUnits + unpricedUnits;
  const coveragePercent = observedUnits === 0n
    ? (priced.coverageStatus === "fully_priced" ? 100 : 0)
    : Number((pricedUnits * 1_000_000n) / observedUnits) / 10_000;
  const reasonCodes = new Set<string>();
  for (const component of priced.components) {
    if (component.pricingStatus === "unpriced" && component.reasonCode) {
      reasonCodes.add(component.reasonCode);
    }
  }
  for (const warning of priced.warnings.coverage) reasonCodes.add(warning.code);

  const costNanousd = toNanousd(priced.totalUsd);
  if (costNanousd > MAX_SAFE_EVENT_NANOUSD) {
    return failClosed(row, "event_price_exceeds_safe_participant_aggregate", tier);
  }

  return {
    exactCostUsd: priced.totalUsd,
    costNanousd,
    coveragePercent,
    coverageStatus: priced.coverageStatus,
    unknownBillableUnits: boundedNumber(unpricedUnits),
    unpricedReasonCodes: [...reasonCodes].sort(),
    selectedPriceCardIds: [...priced.selectedPriceCardIds].sort(),
    methodVersion: SERVER_PRICING_METHOD_VERSION,
    registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    registrySha256: APP_PRICE_REGISTRY_MANIFEST.sha256,
    registryObservedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
    priceEpochBasis: "current_price_sensitivity_at_registry_observation",
    apiServiceTier: tier.apiServiceTier,
    tierBasis: tier.tierBasis,
    subscriptionSpeedMode: row.speedMode,
  };
}
