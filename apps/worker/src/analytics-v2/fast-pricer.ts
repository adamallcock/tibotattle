/**
 * GCP-owned specialization of the pinned server pricer. The oracle compiles
 * per-component rates and audit metadata once per registry/time/context cell.
 * Ordinary integer-token events then need no cost ledger or decimal parsing.
 * Everything outside that closed specialization executes the unchanged oracle.
 * Plans retain only pricing vocabulary, rates and scalar selection metadata.
 */
import { types } from "node:util";
import {
  APP_OFFICIAL_PRICE_CARDS,
  priceTelemetryUsageEvent as referencePrice,
  type ServerPricingResult,
  type TelemetryUsageEvent,
} from "../../vendor/analytics-d43c8f92/entry";

const KEYS = ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "inputCacheWrite5mTokens", "inputCacheWrite1hTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens"] as const;
const ROW_KEYS = ["provider", "modelId", "modelRecognition", "billingSurface", "speedMode",
  "apiServiceTier", "eventTime", "totalInputContextTokens", "components"] as const;
const MAX_QUANTITY = 100_000_000;
const MAX_EVENT_NANOS = Math.floor(Number.MAX_SAFE_INTEGER / 20_000);
const MAX_PLANS = 16_384;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TIERS = ["standard", "priority", "flex", "batch"] as const;
const modelProviders = new Map<string, Set<string>>();
const contextModels = new Set<string>();
const times = new Set<number>();
const contexts = new Set<number>();
let initialized = false;
let TIME_BOUNDARIES: number[] = [];
let CONTEXT_BOUNDARIES: number[] = [];
function initializeRegistry(): void {
  if (initialized) return;
  // The broad vendor facade also exports consumers of this adapter. Delay
  // catalog access until the first call, after that ESM cycle has initialized.
  initialized = true;
  for (const card of APP_OFFICIAL_PRICE_CARDS) {
    for (const model of [card.model, ...(card.aliases ?? [])]) {
      let providers = modelProviders.get(model);
      if (!providers) { providers = new Set(); modelProviders.set(model, providers); }
      providers.add(card.provider);
      if (card.provider === "openai" && card.metadata?.total_input_context_band != null) contextModels.add(model);
    }
    for (const [edge, value] of Object.entries(card.effective ?? {})) {
      // RunCost selects by calendar date, with an inclusive `to` day.
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        times.add(Date.parse(value) + (edge === "to" ? 86_400_000 : 0));
      }
    }
    for (const component of card.components) {
      const min = component.conditions?.min_total_input_tokens;
      const max = component.conditions?.max_total_input_tokens;
      if (min !== undefined) contexts.add(Number(min));
      if (max !== undefined) contexts.add(Number(max) + 1);
    }
  }
  TIME_BOUNDARIES = [...times].sort((a, b) => a - b);
  CONTEXT_BOUNDARIES = [...contexts].sort((a, b) => a - b);
}

function bucket(value: number, boundaries: readonly number[]): number {
  let lo = 0, hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (value < boundaries[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

type PricerTemplate = Pick<TelemetryUsageEvent, typeof ROW_KEYS[number]
  | "schemaVersion" | "modelFingerprint" | "reasoningEffort">;

interface Plan {
  readonly base: Pick<ServerPricingResult, "unpricedReasonCodes" | "methodVersion" | "registryVersion"
    | "registrySha256" | "registryObservedAt" | "priceEpochBasis" | "apiServiceTier" | "tierBasis" | "speedMultiplier">;
  readonly rates: readonly number[];
  readonly priced: readonly boolean[];
  readonly reasons: readonly (readonly string[])[];
  readonly cardId: string | null;
}

/** Reject non-integral nano rates: component-level rounding must stay in the oracle. */
function nanos(value: string): number | null {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 9) return null;
  const amount = Number(whole) * 1_000_000_000 + Number(fraction.padEnd(9, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function compilePlan(row: TelemetryUsageEvent, openai: boolean): Plan | null {
  const zero = { inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
    inputCacheWrite5mTokens: 0, inputCacheWrite1hTokens: 0, outputTextTokens: 0,
    outputReasoningTokens: 0, outputCombinedTokens: 0 };
  // Never spread an input: inherited fields are still pricing evidence, and
  // extra enumerable accessors must stay unread just as in the reference.
  const template: PricerTemplate = {
    schemaVersion: "usage-event-v0.1", provider: row.provider, modelId: row.modelId,
    modelRecognition: row.modelRecognition, modelFingerprint: null,
    billingSurface: row.billingSurface, speedMode: row.speedMode, apiServiceTier: row.apiServiceTier,
    eventTime: row.eventTime, totalInputContextTokens: row.totalInputContextTokens,
    reasoningEffort: "unknown", components: zero,
  };
  const base = referencePrice(template as TelemetryUsageEvent);
  const rates: number[] = [], priced: boolean[] = [], reasons: string[][] = [];
  let cardId: string | null = null;
  for (let i = 0; i < KEYS.length; i += 1) {
    const components = { ...zero, [KEYS[i]!]: 1 };
    if (openai && (i === 5 || i === 6)) components.outputCombinedTokens = 1;
    if (!openai && (i === 3 || i === 4)) components.inputCacheWriteTokens = 1;
    const unit = referencePrice({ ...template, components } as TelemetryUsageEvent);
    const rate = nanos(unit.exactCostUsd);
    if (rate === null || unit.unpricedReasonCodes.some((code) => code.startsWith("event_price_"))) return null;
    // With every observation known and one positive semantic component, there
    // can be no mixed priced/unpriced quantity (aggregate duplicates are removed).
    if (unit.coverageStatus === "partially_priced") return null;
    const covered = unit.coverageStatus === "fully_priced";
    if (unit.selectedPriceCardIds.length > 1) return null;
    const selected = unit.selectedPriceCardIds[0];
    if (selected) {
      if (cardId !== null && cardId !== selected) return null;
      cardId = selected;
    }
    rates.push(rate); priced.push(covered); reasons.push(unit.unpricedReasonCodes);
  }
  return { base: {
    unpricedReasonCodes: base.unpricedReasonCodes, methodVersion: base.methodVersion,
    registryVersion: base.registryVersion, registrySha256: base.registrySha256,
    registryObservedAt: base.registryObservedAt, priceEpochBasis: base.priceEpochBasis,
    apiServiceTier: base.apiServiceTier, tierBasis: base.tierBasis, speedMultiplier: base.speedMultiplier,
  }, rates, priced, reasons, cardId };
}

function addReasons(target: string[], codes: readonly string[]): void {
  for (const code of codes) if (!target.includes(code)) target.push(code);
}

function usd(nano: number): string {
  const whole = Math.floor(nano / 1_000_000_000);
  const fraction = nano % 1_000_000_000;
  return fraction === 0 ? String(whole)
    : `${whole}.${String(fraction).padStart(9, "0").replace(/0+$/u, "")}`;
}

/** A separate bounded structural cache is useful for process-isolated cold/warm proof. */
export function createFastTelemetryUsagePricer(): (row: TelemetryUsageEvent) => ServerPricingResult {
  const plans = new Map<string, Map<number, Plan | null>>();
  let planCount = 0;
  return function fastPrice(row: TelemetryUsageEvent): ServerPricingResult {
    initializeRegistry();
    if (!row || typeof row !== "object" || types.isProxy(row)) return referencePrice(row);
    // Proxy, accessor-bearing or inherited input uses the reference's evaluation
    // order. Ordinary own data properties are the closed specialization.
    for (const name of ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, name);
      if (!descriptor || !("value" in descriptor)) return referencePrice(row);
    }
    const openai = row.provider === "openai_codex";
    if ((!openai && row.provider !== "anthropic_claude_code")
      || row.modelRecognition !== "recognized" || row.modelId === "unknown"
      || !modelProviders.get(row.modelId)?.has(openai ? "openai" : "anthropic")) return referencePrice(row);
    const subscription = row.billingSurface === "chatgpt_subscription" || row.billingSurface === "claude_subscription";
    const tier = subscription ? 0 : row.billingSurface === "openai_api" ? TIERS.indexOf(row.apiServiceTier as typeof TIERS[number]) : -1;
    if (tier < 0 || typeof row.eventTime !== "string" || !ISO.test(row.eventTime)) return referencePrice(row);
    const epoch = Date.parse(row.eventTime);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== row.eventTime) return referencePrice(row);
    const context = row.totalInputContextTokens;
    if (context !== null && (typeof context !== "number" || !Number.isSafeInteger(context) || context < 0)) return referencePrice(row);
    if (openai && contextModels.has(row.modelId) && context === null) return referencePrice(row);
    const c = row.components;
    if (!c || typeof c !== "object" || types.isProxy(c) || Array.isArray(c) || Object.keys(c).length !== KEYS.length) return referencePrice(row);
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(c, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return referencePrice(row);
      const value = descriptor.value;
      if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUANTITY)) return referencePrice(row);
    }
    if (!openai) {
      const split = (c.inputCacheWrite5mTokens ?? 0) + (c.inputCacheWrite1hTokens ?? 0);
      if (((c.inputCacheWriteTokens ?? split) > 0
          && (c.inputCacheWrite5mTokens === null || c.inputCacheWrite1hTokens === null))
        || c.inputCacheWriteTokens !== null && c.inputCacheWriteTokens !== split) return referencePrice(row);
    }
    const fast = row.billingSurface === "chatgpt_subscription" && row.speedMode === "fast";
    const contextBucket = context === null ? 0 : bucket(context, CONTEXT_BOUNDARIES) + 1;
    // All selection inputs occur in this key. Speed modes other than Codex Fast
    // do not affect prices; the returned speed mode always comes from this row.
    const key = (((((openai ? 1 : 0) * 2 + (subscription ? 1 : 0)) * 4 + tier) * 2 + (fast ? 1 : 0))
      * (TIME_BOUNDARIES.length + 1) + bucket(epoch, TIME_BOUNDARIES)) * (CONTEXT_BOUNDARIES.length + 2) + contextBucket;
    let byCell = plans.get(row.modelId);
    let plan = byCell?.get(key);
    if (plan === undefined) {
      if (planCount >= MAX_PLANS) return referencePrice(row);
      if (!byCell) { byCell = new Map(); plans.set(row.modelId, byCell); }
      plan = compilePlan(row, openai); byCell.set(key, plan); planCount += 1;
    }
    if (plan === null) return referencePrice(row);
    let amount = 0, pricedUnits = 0, unknownUnits = 0, positivePriced = 0, positiveUnknown = 0;
    let unavailable = false;
    const reasons = [...plan.base.unpricedReasonCodes];
    const redundantOutput = openai && c.outputTextTokens !== null && c.outputReasoningTokens !== null
      && c.outputCombinedTokens !== null && c.outputTextTokens + c.outputReasoningTokens === c.outputCombinedTokens;
    for (let i = 0; i < KEYS.length; i += 1) {
      if (!openai && i === 2) {
        if (c.inputCacheWriteTokens === null) unavailable = true;
        continue;
      }
      if (redundantOutput && i === 7) continue;
      const quantity = c[KEYS[i]!];
      if (quantity === null) {
        if (openai ? i === 0 || i === 1 || i === 2 || i === 5 || i === 6 : i === 0 || i === 1 || i === 3 || i === 4 || i === 7) unavailable = true;
        continue;
      }
      if (quantity === 0) continue;
      if (plan.priced[i]) {
        amount += quantity * plan.rates[i]!;
        pricedUnits += quantity; positivePriced += 1;
      } else { unknownUnits += quantity; positiveUnknown += 1; }
      addReasons(reasons, plan.reasons[i]!);
    }
    // Overflow and participant aggregate guards use the original exact path,
    // preserving both the guard precedence and fail-closed token summation.
    if (!Number.isSafeInteger(amount) || amount > MAX_EVENT_NANOS) return referencePrice(row);
    if (unavailable) addReasons(reasons, ["component_observation_unavailable"]);
    const status = positiveUnknown === 0 && !unavailable ? "fully_priced" : positivePriced > 0 ? "partially_priced" : "unpriced";
    if (status === "unpriced" && reasons.includes("historical_price_missing")) {
      const index = reasons.indexOf("component_price_missing");
      if (index !== -1) reasons.splice(index, 1);
    }
    reasons.sort();
    const observed = pricedUnits + unknownUnits;
    const coverage = observed === 0 ? status === "fully_priced" ? 100 : 0
      : Number(BigInt(pricedUnits) * 1_000_000n / BigInt(observed)) / 10_000;
    const base = plan.base;
    return {
      exactCostUsd: usd(amount), costNanousd: amount, coveragePercent: coverage,
      coverageStatus: status, unknownBillableUnits: unknownUnits,
      unpricedReasonCodes: reasons,
      selectedPriceCardIds: positivePriced > 0 && plan.cardId !== null ? [plan.cardId] : [],
      methodVersion: base.methodVersion, registryVersion: base.registryVersion,
      registrySha256: base.registrySha256, registryObservedAt: base.registryObservedAt,
      priceBasis: status === "unpriced" ? "unpriced" : "historical_api_prices",
      priceEventTime: row.eventTime, priceEpochBasis: base.priceEpochBasis,
      apiServiceTier: base.apiServiceTier, tierBasis: base.tierBasis,
      subscriptionSpeedMode: row.speedMode,
      speedMultiplier: status === "unpriced" ? null : base.speedMultiplier,
    };
  };
}

export const fastPriceTelemetryUsageEvent = createFastTelemetryUsagePricer();
// The GCP import binding uses the original exported name, only at the reviewed
// vendor consumer. The vendored facade continues to export the independent oracle.
export { fastPriceTelemetryUsageEvent as priceTelemetryUsageEvent };
