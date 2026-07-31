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
}

export interface PriceUsageOptions {
  priceCards?: readonly PriceCard[];
  pricingContext?: PricingContext;
}

export const APP_PRICE_REGISTRY_OBSERVED_AT: string;
export const APP_PRICE_REGISTRY_VERSION: string;
export const OFFICIAL_PRICE_SOURCE_URLS: Readonly<Record<string, string>>;
export const OPENAI_LONG_CONTEXT_SOURCE_URLS: readonly string[];
export const NORMALIZED_PRICE_EVIDENCE_ROWS: Readonly<Record<string, unknown>>;
export const OPENAI_OFFICIAL_PRICE_CARDS: readonly PriceCard[];
export const ANTHROPIC_OFFICIAL_PRICE_CARDS: readonly PriceCard[];
export const PROVIDER_TOOL_PRICE_CARDS: readonly PriceCard[];
export const APP_OFFICIAL_PRICE_CARDS: readonly PriceCard[];
export const APP_PRICE_REGISTRY_SHA256: string;
export const APP_PRICE_REGISTRY_MANIFEST: OfficialPriceRegistryManifest;
export const LOCAL_API_PRICING_METHOD_VERSION: string;

export function addUsdStrings(...values: Array<string | number>): DecimalString;
export function priceUsageEvent(
  event: NormalizedUsageEvent,
  options?: PriceUsageOptions,
): PriceUsageResult;
export function aggregateCostResults(
  results: readonly PriceUsageResult[],
): AggregateCostResult;
export function validateOfficialPriceRegistry(
  cards?: readonly PriceCard[],
): readonly PriceCard[];
export function addOfficialPriceRegistry(
  resolution?: Readonly<Record<string, unknown>> | null,
  cards?: readonly PriceCard[],
): Record<string, unknown>;

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
}

export function priceCodexUsageEvent(
  event: CodexUsageEvent,
  options?: LocalPricingOptions,
): PriceUsageResult;
export function priceClaudeUsageRecord(
  record: ClaudeUsageRecord,
  options?: LocalPricingOptions,
): PriceUsageResult;
export function codexProviderBillableToolUnits(
  serverBillableUnits: Readonly<Record<string, unknown>> | null | undefined,
): NormalizedUsageEvent["billableToolUnits"];
export function priceCodexProviderToolUnits(
  serverBillableUnits: Readonly<Record<string, unknown>> | null | undefined,
  options?: Pick<LocalPricingOptions, "priceCards" | "priceEpochBasis">,
): PriceUsageResult;
export function aggregateLocalApiPriceResults(
  results: readonly PriceUsageResult[],
): AggregateCostResult;
export function summarizeClaudeApiPriceRecords(
  records: readonly ClaudeUsageRecord[],
  options?: LocalPricingOptions,
): AggregateCostResult & Readonly<Record<string, unknown>>;
export function costWarningCodes(result: PriceUsageResult): string[];
export function apiPriceResolutionSummary(options?: {
  priceCards?: readonly PriceCard[] | null;
  apiServiceTier?: string;
}): Readonly<Record<string, unknown>>;
