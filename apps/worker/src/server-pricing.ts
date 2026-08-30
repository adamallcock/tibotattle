import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  FAST_MODE_ASSUMED_MULTIPLIER,
  fastModeQuotaMultiplier,
  priceUsageEvent,
} from "@app-usagemonitor/accounting";
import type { TelemetryUsageEvent } from "./telemetry-validation";

// v0.4 (2026-08-30): Codex subscription Fast events are priced at the
// published Priority (Fast) API rate - the Standard counterfactual multiplied
// by the exact model's eligible Priority/Standard price ratio (proven uniform per
// component by the accounting package), or by the disclosed assumed 2x when
// no Priority rate is published. Standard and unknown speed stay the plain
// Standard counterfactual, as does every claude_subscription event.
export const SERVER_PRICING_METHOD_VERSION = "server-api-price-equivalent-v0.4";

type PricingStatus = "fully_priced" | "partially_priced" | "unpriced";
export type ServerPriceBasis = "historical_api_prices" | "unpriced";
export type ServerContributionPriceBasis = ServerPriceBasis | "mixed_api_prices";
export type ServerPriceEpochBasis = "event_time_when_registry_has_effective_evidence";

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
  priceBasis: ServerPriceBasis;
  priceEventTime: string | null;
  priceEpochBasis: ServerPriceEpochBasis;
  apiServiceTier: "standard" | "priority" | "flex" | "batch" | "unknown";
  tierBasis: "subscription_standard_counterfactual" | "observed_api_service_tier"
    | "api_service_tier_unavailable" | "subscription_speed_priority_price_ratio"
    | "subscription_speed_assumed_priority_ratio";
  subscriptionSpeedMode: TelemetryUsageEvent["speedMode"];
  // The Priority/Standard price ratio applied on top of the Standard-card
  // cost for a Codex subscription Fast event; null when no ratio applied.
  speedMultiplier: number | null;
}

const CONTEXT_SENSITIVE_OPENAI_MODELS = new Set(APP_OFFICIAL_PRICE_CARDS
  .filter((card) => card.provider === "openai"
    && card.metadata?.total_input_context_band != null)
  .flatMap((card) => [card.model, ...(card.aliases ?? [])]));
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

function usableEventTime(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 32
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function tierForEvent(row: TelemetryUsageEvent): {
  apiServiceTier: ServerPricingResult["apiServiceTier"];
  tierBasis: ServerPricingResult["tierBasis"];
  speedMultiplier: number | null;
} {
  const subscription = row.billingSurface === "chatgpt_subscription"
    || row.billingSurface === "claude_subscription";
  if (subscription) {
    // Codex Fast is the API Priority tier. Standard cards still perform the
    // selection - they are the only tier with complete coverage - and the
    // published Priority/Standard price ratio (or the disclosed assumed 2x)
    // scales the result to the Priority rate. Selecting exact Priority cards
    // instead would strand models and epochs without a published Priority row
    // as unpriced and poison whole resets in the community fit.
    if (row.billingSurface === "chatgpt_subscription" && row.speedMode === "fast") {
      const publishedRatio = fastModeQuotaMultiplier(row.modelId, {
        eventTime: row.eventTime,
        totalInputContextTokens: row.totalInputContextTokens,
      });
      return {
        apiServiceTier: "standard",
        tierBasis: publishedRatio === null
          ? "subscription_speed_assumed_priority_ratio"
          : "subscription_speed_priority_price_ratio",
        speedMultiplier: publishedRatio ?? FAST_MODE_ASSUMED_MULTIPLIER,
      };
    }
    return {
      apiServiceTier: "standard",
      tierBasis: "subscription_standard_counterfactual",
      speedMultiplier: null,
    };
  }
  if (row.billingSurface === "openai_api"
      && ["standard", "priority", "flex", "batch"].includes(row.apiServiceTier)) {
    return {
      apiServiceTier: row.apiServiceTier as "standard" | "priority" | "flex" | "batch",
      tierBasis: "observed_api_service_tier",
      speedMultiplier: null,
    };
  }
  return {
    apiServiceTier: "unknown",
    tierBasis: "api_service_tier_unavailable",
    speedMultiplier: null,
  };
}

// Exact decimal multiply for the speed ratio: both operands are decimal
// strings, so the product is computed on scaled integers and re-rendered
// without ever touching floating point.
function multiplyDecimal(value: string, multiplier: number): string {
  const left = decimalParts(value);
  const right = decimalParts(String(multiplier));
  const digits = (left.integer * right.integer).toString();
  const scale = left.scale + right.scale;
  if (scale === 0) return digits;
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
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
    registryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    priceBasis: "unpriced",
    priceEventTime: usableEventTime(row.eventTime) ? row.eventTime : null,
    priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    apiServiceTier: tier.apiServiceTier,
    tierBasis: tier.tierBasis,
    subscriptionSpeedMode: row.speedMode,
    speedMultiplier: null,
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
  if (!usableEventTime(row.eventTime)) {
    return failClosed(row, "historical_price_timestamp_missing", tier);
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
    pricedAt: row.eventTime,
    totalInputContextTokens: row.totalInputContextTokens,
    components: row.components,
  }, {
    priceCards: APP_OFFICIAL_PRICE_CARDS,
    pricingContext: {
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
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
  if (priced.coverageStatus === "unpriced"
      && reasonCodes.has("historical_price_missing")) {
    // The component-level fallback warning is an implementation detail of
    // the empty historical card lookup. Retain the evidence boundary as the
    // single audit reason rather than presenting a second, misleading cause.
    reasonCodes.delete("component_price_missing");
  }

  // The speed ratio scales the Standard-card total to the Priority (Fast)
  // rate. An unpriced result carries no cost to scale, and the ratio is not
  // applied to it so the zero stays an honest zero.
  const speedMultiplier = priced.coverageStatus === "unpriced"
    ? null
    : tier.speedMultiplier;
  const exactCostUsd = speedMultiplier === null
    ? priced.totalUsd
    : multiplyDecimal(priced.totalUsd, speedMultiplier);
  let costNanousd: number;
  try {
    costNanousd = toNanousd(exactCostUsd);
  } catch {
    // A product that cannot be represented in exact nanousd fails closed as
    // an unpriced event instead of surfacing as an ingest error. Unreachable
    // with the published ratios and rates, kept as a guard for future rows.
    return failClosed(row, "event_price_exceeds_exact_nanousd_precision", tier);
  }
  if (costNanousd > MAX_SAFE_EVENT_NANOUSD) {
    return failClosed(row, "event_price_exceeds_safe_participant_aggregate", tier);
  }

  return {
    exactCostUsd,
    costNanousd,
    coveragePercent,
    coverageStatus: priced.coverageStatus,
    unknownBillableUnits: boundedNumber(unpricedUnits),
    unpricedReasonCodes: [...reasonCodes].sort(),
    selectedPriceCardIds: [...priced.selectedPriceCardIds].sort(),
    methodVersion: SERVER_PRICING_METHOD_VERSION,
    registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    registrySha256: APP_PRICE_REGISTRY_MANIFEST.sha256,
    registryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    priceBasis: priced.coverageStatus === "unpriced"
      ? "unpriced"
      : "historical_api_prices",
    priceEventTime: row.eventTime,
    priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    apiServiceTier: tier.apiServiceTier,
    tierBasis: tier.tierBasis,
    subscriptionSpeedMode: row.speedMode,
    speedMultiplier,
  };
}
