export type DecimalString = string;
export type PricingCoverageStatus =
  | "fully_priced"
  | "partially_priced"
  | "unpriced";
export type PricingComponentStatus = "priced" | "unpriced" | "unavailable";

export interface AccountingWarning {
  code: string;
  message: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface PriceComponent {
  usage_component: string;
  unit: string;
  price: {
    amount: DecimalString;
    currency: "USD";
    per: DecimalString;
  };
  conditions?: Readonly<Record<string, DecimalString>>;
}

export interface PriceCard {
  schema_version: string;
  id: string;
  provider: string;
  model: string;
  aliases?: readonly string[];
  service_tier?: string;
  region?: string;
  effective?: {
    from?: string;
    to?: string;
  };
  components: readonly PriceComponent[];
  source: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  surface?: string;
  pricing_period?: string;
}

export interface PriceRegistryManifest {
  version: string;
  sha256: string | null;
  observedAt: string | null;
  priceBasis: string;
  historicalDefault: string;
  sources: readonly Readonly<Record<string, unknown>>[];
}

export interface OfficialPriceRegistryManifest extends PriceRegistryManifest {
  sha256: string;
  observedAt: string;
}

export interface UsageComponentResult {
  name: string;
  pricedAs: string | null;
  quantity: DecimalString | null;
  unit: string;
  pricingStatus: PricingComponentStatus;
  unitPriceUsd: DecimalString | null;
  costUsd: DecimalString | null;
  priceCardId: string | null;
  reasonCode?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PriceCardBreakdown {
  priceCardId: string;
  events: number;
  costUsd: DecimalString;
}

export interface PriceUsageResult {
  schemaVersion: string;
  basis: string;
  provider: string;
  model: string;
  surface: string;
  pricingContext: {
    serviceTier: string;
    tierSource: string;
    pricedAt: string | null;
    region: string | null;
    priceEpochBasis: string;
    historicalPriceReasonCode?: string;
  };
  coverageStatus: PricingCoverageStatus;
  coverageCounts: {
    pricedComponents: number;
    unpricedComponents: number;
    unavailableComponents: number;
  };
  totalUsd: DecimalString;
  components: UsageComponentResult[];
  selectedPriceCardId: string | null;
  selectedPriceCardIds: string[];
  priceCardBreakdown: PriceCardBreakdown[];
  warnings: {
    coverage: AccountingWarning[];
    informational: AccountingWarning[];
  };
  ledger: unknown;
  methodVersion?: string;
  registry?: PriceRegistryManifest;
}

export interface AggregateCostResult {
  schemaVersion: string;
  basis: string;
  eventCount: number;
  coverageStatus: PricingCoverageStatus;
  coverageCounts: {
    fullyPriced: number;
    partiallyPriced: number;
    unpriced: number;
    pricedComponents: number;
    unpricedComponents: number;
    unavailableComponents: number;
  };
  totalUsd: DecimalString;
  selectedPriceCardIds: string[];
  priceCardBreakdown: PriceCardBreakdown[];
  warnings: {
    coverage: AccountingWarning[];
    informational: AccountingWarning[];
  };
  ledger: unknown;
  methodVersion?: string;
  registry?: PriceRegistryManifest;
}

export interface NormalizedUsageEvent {
  provider: string;
  model: string;
  surface?: string;
  serviceTier?: string | null;
  apiTier?: string | null;
  pricedAt?: string | Date | null;
  timestamp?: string | Date | null;
  region?: string | null;
  totalInputTokens?: string | number | null;
  totalInputContextTokens?: string | number | null;
  components?: Readonly<
    Record<string, string | number | null | undefined>
  >;
  componentAvailability?: Readonly<Record<string, boolean | null | undefined>>;
  billableToolUnits?: readonly {
    provider?: string;
    name?: string;
    component?: string;
    quantity: string | number;
    unit?: string;
    billingSource?: string;
    toolName?: string;
  }[];
}

export interface PricingContext {
  surface?: string;
  serviceTier?: string | null;
  apiTier?: string | null;
  pricedAt?: string | Date | null;
  timestamp?: string | Date | null;
  region?: string | null;
  totalInputTokens?: string | number | null;
  totalInputContextTokens?: string | number | null;
  priceEpochBasis?: string;
  historicalPriceReasonCode?: string;
}

export interface PriceUsageOptions {
  priceCards?: readonly PriceCard[];
  pricingContext?: PricingContext;
}

export const OPENAI_PRICE_EVIDENCE_START_DATE: string;
export const APP_OFFICIAL_PRICE_CARDS: readonly PriceCard[];
export const APP_PRICE_REGISTRY_MANIFEST: OfficialPriceRegistryManifest;

export function addUsdStrings(...values: Array<string | number>): DecimalString;
export function priceUsageEvent(
  event: NormalizedUsageEvent,
  options?: PriceUsageOptions,
): PriceUsageResult;

export interface CodexUsageEvent {
  model: string;
  timestamp?: string | Date | null;
  totalInputContextTokens?: string | number | null;
  components?: NormalizedUsageEvent["components"];
  componentAvailability?: NormalizedUsageEvent["componentAvailability"];
  raw?: Readonly<Record<string, unknown>>;
}

export interface ClaudeUsageRecord {
  eventTime?: string | Date | null;
  modelId: string;
  modelRecognition: string;
  totalInputContextTokens?: string | number | null;
  components?: Readonly<Record<string, string | number | null | undefined>>;
}

export interface LocalPricingOptions {
  priceCards?: readonly PriceCard[] | null;
  priceEpochBasis?: "event_time" | "current_price_sensitivity";
  apiServiceTier?: string;
  region?: string | null;
  eventTime?: string | Date | null;
}

export function priceCodexUsageEvent(
  event: CodexUsageEvent,
  options?: LocalPricingOptions,
): PriceUsageResult;
export function priceClaudeUsageRecord(
  record: ClaudeUsageRecord,
  options?: LocalPricingOptions,
): PriceUsageResult;
export function priceCodexProviderToolUnits(
  serverBillableUnits: Readonly<Record<string, unknown>> | null | undefined,
  options?: Pick<LocalPricingOptions, "priceCards" | "priceEpochBasis" | "eventTime">,
): PriceUsageResult;
export function aggregateLocalApiPriceResults(
  results: readonly PriceUsageResult[],
): AggregateCostResult;
export function costWarningCodes(result: PriceUsageResult): string[];
export function apiPriceResolutionSummary(options?: {
  priceCards?: readonly PriceCard[] | null;
  apiServiceTier?: string;
}): Readonly<Record<string, unknown>>;

export type FastModeModelFamily = "gpt-5.6" | "gpt-5.5" | "gpt-5.4";
export type FastModeModelFamilyKey = FastModeModelFamily | "unsupported";
export type ObservedSpeedMode = "standard" | "fast" | "unknown";
export type FastModePreference = "standard" | "fast" | "mixed_unknown";
export type SpeedModeProvenance =
  | "observed"
  | "declared_codex_config"
  | "assumed_from_preference"
  | "inferred"
  | "unknown";

export interface CodexSpeedModeDeclaration {
  provenance: "declared_codex_config";
  source: "codex_config_service_tier_key";
  retainedKeys: readonly ["service_tier"];
  appliesTo: string;
  neverBackfillsHistory: true;
  reason: string;
}

export interface QuotaWeightedApiPriceMetric {
  key: "quotaWeightedApiPriceEquivalentUsd";
  label: string;
  shortLabel: string;
  standardMetricKey: "apiPriceEquivalentUsd";
  standardMetricLabel: string;
  explainer: string;
}

export interface SpeedWeightingCell {
  events: number;
  apiPriceEquivalentUsd: number;
}
export type SpeedWeightingCrossing = Record<
  ObservedSpeedMode,
  Record<FastModeModelFamilyKey, SpeedWeightingCell>
>;

export interface QuotaWeightedAccountingSummary {
  metric: QuotaWeightedApiPriceMetric;
  multiplierSource: Readonly<Record<string, string>>;
  declarationSource: CodexSpeedModeDeclaration;
  preference: FastModePreference;
  standardApiPriceEquivalentUsd: number;
  quotaWeightedApiPriceEquivalentUsd: number | null;
  unweightedUnknownApiPriceEquivalentUsd: number;
  weightingStatus: "complete" | "partial" | "unknown";
  appliedMultipliers: Readonly<Record<string, number>>;
  coverage: {
    totalEvents: number;
    observedEvents: number;
    declaredFromConfigEvents: number;
    assumedFromPreferenceEvents: number;
    inferredEvents: number;
    unknownEvents: number;
    observedSharePercent: number | null;
    unknownSharePercent: number | null;
  };
  inference: {
    status: string;
    reasonCode: string | null;
    inferredFastWindows: number;
    appliedToWeighting: false;
    appliedToWeightingReason: string;
  };
}

export interface FastModeCalibrationWindow {
  id?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  apiPriceEquivalentUsd: number;
  knownSpeedFraction?: number | null;
  fastFractionOfKnown?: number | null;
  eligibleTransitions?: number;
  uniqueBoundaries?: number;
  observedSpanPercentagePoints?: number;
  unknownSpeedEvents?: number;
}

export interface FastModeInferenceWindow {
  id: string | null;
  startAt: string | null;
  endAt: string | null;
  mode: "fast" | "standard" | "unknown";
  provenance: "inferred" | "unknown";
  observedToStandardPredictedRatio: number;
  matchedMultiple: number | null;
  reasonCode: string;
  isStandardReference: boolean;
  unknownSpeedEvents: number;
}

export interface FastModeInferenceResult {
  status: "inferred" | "insufficient_signal";
  reasonCode: string | null;
  thresholds: Readonly<Record<string, number>>;
  referenceStandardCapacityUsd: number | null;
  referenceWindowCount: number;
  scoredWindowCount: number;
  inferredFastWindowCount: number;
  inferredFastUnknownSpeedEvents: number;
  windows: readonly FastModeInferenceWindow[];
}

export const FAST_MODE_MULTIPLIER_SOURCE: Readonly<Record<string, string>>;
export const CODEX_SPEED_MODE_OBSERVABILITY: Readonly<{
  recordedEvent: string;
  observedValues: Readonly<Record<string, string>>;
  firesOn: string;
  sessionBaselineRecorded: false;
  resolution: string;
  unobservedMeans: string;
}>;
export const FAST_MODE_QUOTA_MULTIPLIERS: Readonly<
  Record<FastModeModelFamily, number>
>;
export const FAST_MODE_MODEL_FAMILY_KEYS: readonly FastModeModelFamilyKey[];
export const OBSERVED_SPEED_MODE_KEYS: readonly ObservedSpeedMode[];
export const FAST_MODE_PREFERENCE_VALUES: readonly FastModePreference[];
export const DEFAULT_FAST_MODE_PREFERENCE: FastModePreference;
export const CODEX_SPEED_MODE_DECLARATION: CodexSpeedModeDeclaration;
export const QUOTA_WEIGHTED_API_PRICE_METRIC: QuotaWeightedApiPriceMetric;

export function fastModeModelFamilyKey(model: unknown): FastModeModelFamilyKey;
export function fastModeQuotaMultiplier(model: unknown): number | null;
export function isFastModePreference(value: unknown): value is FastModePreference;
export function emptySpeedWeightingCrossing(): SpeedWeightingCrossing;
export function resolveEffectiveSpeedMode(input?: {
  observedMode?: string;
  declaredMode?: string;
  preference?: string;
  inferredMode?: string;
}): { mode: ObservedSpeedMode; provenance: SpeedModeProvenance };
export function summarizeQuotaWeightedAccounting(input?: {
  speedWeighting?: SpeedWeightingCrossing | null;
  declaredSpeedWeighting?: SpeedWeightingCrossing | null;
  preference?: string;
  inferredFastEvents?: number;
  inference?: FastModeInferenceResult | null;
}): QuotaWeightedAccountingSummary;
export function inferFastModeFromCalibrationWindows(
  windows: readonly FastModeCalibrationWindow[] | null | undefined,
): FastModeInferenceResult;
