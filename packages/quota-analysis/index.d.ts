export type IsoInstant = string;
export type OpaqueId = string;
// Runtime validation is required; this type intentionally does not encode the
// provider-reported duration bounds.
export type QuotaWindowDurationMinutes = number;
export type SupportedQuotaWindowDurationMinutes = QuotaWindowDurationMinutes;

export const FIVE_HOUR_WINDOW_MINUTES: 300;
export const SEVEN_DAY_WINDOW_MINUTES: 10080;
export const MAX_QUOTA_WINDOW_DURATION_MINUTES: 525600;
export const MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH: 80;
export const CODEX_PRIMARY_LIMIT_ID: "codex";
export const CODEX_SPARK_LIMIT_ID: "codex_bengalfox";
export const CODEX_SPARK_RESERVED_LIMIT_ID: "codex-spark";
export const CODEX_SPARK_LIMIT_IDS: readonly ["codex_bengalfox", "codex-spark"];
export const QUOTA_LIMIT_DISPLAY_ALIASES: Readonly<{
  codex: "Codex";
  codex_bengalfox: "Spark";
  "codex-spark": "Spark";
}>;
export const QUOTA_WINDOW_KINDS: readonly [
  "codex_five_hour",
  "codex_seven_day",
  "codex_provider_reported",
  "spark_five_hour",
  "spark_seven_day",
  "spark_other",
  "other",
];
export function sanitizeQuotaLimitId(value: unknown): string;
export function sanitizeQuotaLimitDisplayName(value: unknown): string | null;
export function quotaLimitDisplayAlias(limitId: unknown): string | null;
export function isSparkQuotaLimitId(value: unknown): boolean;
export function isValidQuotaWindowDuration(value: number): boolean;
export function isSupportedQuotaWindowDuration(
  value: number,
): value is SupportedQuotaWindowDurationMinutes;

export interface QuotaWindowSelectionInput {
  limitId?: string;
  slot?: string;
  windowDurationMinutes?: number;
  durationMinutes?: number;
  windowDurationMins?: number;
}
export function formatQuotaWindowDuration(value: number): string | null;
export function classifyQuotaWindowKind(
  limitId: unknown,
  durationMinutes: number | null | undefined,
): typeof QUOTA_WINDOW_KINDS[number];
export function quotaWindowLabel(
  limitId: unknown,
  durationMinutes: number | null | undefined,
  limitName?: unknown,
): string;

export type QuotaSlot =
  | "primary"
  | "secondary"
  | "five_hour"
  | "seven_day"
  | "other"
  | "unknown";
export type PricingStatus =
  | "fully_priced"
  | "partially_priced"
  | "unpriced";

export const PLAN_ATTRIBUTION_POLICY: Readonly<{
  methodVersion: "plan-attribution-v1";
  maxObservations: number;
  maxContexts: number;
  maxEras: number;
}>;

export interface PlanAttributionObservation {
  contextKey: string;
  observedAtMs: number;
  planType: string | null | undefined;
  planVariant?: string;
  /** Optional bounded continuity claim; splits same-plan eras, never account proof. */
  continuityId?: string | null;
  /** Explicit contradictory evidence is a barrier, unlike an ordinary unknown plan. */
  conflicted?: boolean;
  /** Positively comparable account evidence only; never a device/transport ID. */
  accountScopeId?: string | null;
  observationId?: string;
}

export interface PlanAttributionEra {
  readonly eraKey: string;
  readonly contextKey: string;
  readonly accountScopeId: string | null;
  readonly planType: string;
  readonly planVariant: string;
  readonly continuityId: string | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  /** Inclusive observation anchors; null is open, not verified continuity. */
  readonly lowerBoundMs: number | null;
  readonly upperBoundMs: number | null;
}

export interface PlanAttributionConflict {
  readonly contextKey: string;
  readonly accountScopeId: string | null;
  readonly observedAtMs: number;
}

/** Opaque in-memory analysis input. Do not serialize into transport/cache DTOs. */
export interface PlanAttributionIndex {
  readonly methodVersion: "plan-attribution-v1";
  readonly status: "ready" | "limit_exceeded";
  readonly observationCount: number;
  readonly ignoredObservationCount: number;
  readonly eras: readonly PlanAttributionEra[];
  readonly conflicts: readonly PlanAttributionConflict[];
  readonly contexts: ReadonlyMap<string, {
    readonly eras: readonly PlanAttributionEra[];
    readonly conflicts: readonly PlanAttributionConflict[];
    readonly singlePlan: boolean;
  }>;
}

export interface PlanAttributionInterval {
  contextKey: string;
  observedAtMs: number;
  /** Quantity interval is (intervalStartMs, observedAtMs]; omission is a point. */
  intervalStartMs?: number | null;
  accountScopeId?: string | null;
}

export type PlanAttributionEraMatch = {
  status: "matched";
  era: PlanAttributionEra;
  reason: string;
} | {
  status: "unavailable" | "conflicted";
  era: null;
  reason: string;
};

export interface PlanAttributionUsage extends PlanAttributionInterval {
  observedPlanType?: string | null;
  observedPlanVariant?: string;
  quantityBasis?: "reported-increment" | "reconstructed-counter-delta" | "legacy-unknown";
}

export interface PlanAttributionTarget {
  contextKey?: string;
  accountScopeId?: string | null;
  planType?: string;
  eraKey?: string;
}

export type PlanAttributionClassification = PlanAttributionEraMatch & {
  disposition: "compatible" | "legacy_conditional" | "unresolved" | "incompatible";
  planType: string | null;
  planVariant: string;
  accountScopeId: string | null;
};

export function planAttributionContextKey(provider: string, limitId: string): string;
export function planAttributionObservationFromSnapshot(snapshot: {
  provider?: string;
  limitId?: string;
  observedAt?: string;
  observedAtMs?: number;
  planType?: string | null;
  planVariant?: string;
  continuityId?: string | null;
  conflicted?: boolean;
  accountScopeId?: string | null;
  accountTrackId?: string;
  snapshotId?: string;
} | null | undefined, options?: {
  contextKey?: string;
  accountScopeId?: string | null;
}): PlanAttributionObservation | null;
export function buildPlanAttributionIndex(
  observations?: readonly (PlanAttributionObservation | null)[],
  options?: { maxObservations?: number; maxContexts?: number; maxEras?: number },
): PlanAttributionIndex;
export function planEraForInterval(
  index: PlanAttributionIndex,
  input: PlanAttributionInterval,
): PlanAttributionEraMatch;
export function classifyUsageAttribution(
  index: PlanAttributionIndex,
  usage: PlanAttributionUsage,
  target?: PlanAttributionTarget,
): PlanAttributionClassification;

export interface QuotaContinuityInput {
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  windowDurationMinutes: QuotaWindowDurationMinutes;
  policyEpoch: string;
}

export interface QuotaResetIdentityInput extends QuotaContinuityInput {
  resetsAt: IsoInstant;
}

export interface QuotaDatasetInput {
  datasetId: OpaqueId;
  complete: boolean;
}

export interface QuotaSnapshotInput extends QuotaResetIdentityInput {
  snapshotId: OpaqueId;
  datasetId: OpaqueId;
  slot: QuotaSlot;
  observedAt: IsoInstant;
  receivedAt: IsoInstant;
  usedPercent: number;
  displayPrecision: number;
}

export interface QuotaUsageEventInput {
  eventId: OpaqueId;
  datasetId: OpaqueId;
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  observedAt: IsoInstant;
  costNanousd: number;
  pricingStatus: PricingStatus;
  policyEpoch: string;
}

export interface BuildResetEvidenceInput {
  datasets: readonly QuotaDatasetInput[];
  quotaSnapshots: readonly QuotaSnapshotInput[];
  usageEvents: readonly QuotaUsageEventInput[];
}

export type QuotaTrackRefusalCode =
  | "unattributed_account"
  | "incomplete_dataset"
  | "mixed_track_fields"
  | "ambiguous_quota_observation"
  | "simultaneous_slot_conflict"
  | "stale_quota_observation"
  | "backward_quota_observation"
  | "incomplete_server_pricing"
  | "no_priced_usage"
  | "insufficient_quota_observations";

export interface QuotaBoundary {
  usedPercent: number;
  lowerCostNanousd: number;
  upperCostNanousd: number;
  observedAt: IsoInstant;
}

export interface QuotaSeriesPoint {
  observedAt: IsoInstant;
  receivedAt: IsoInstant;
  usedPercent: number;
}

export interface QuotaUsageSeriesPoint {
  observedAt: IsoInstant;
  costNanousd: number;
}

export interface QuotaResetEvidence extends QuotaResetIdentityInput {
  schemaVersion: "quota-reset-evidence-v0.1";
  status: "eligible" | "refused";
  refusalCodes: QuotaTrackRefusalCode[];
  continuityKey: string;
  resetKey: string;
  slots: QuotaSlot[];
  firstObservedAt: IsoInstant;
  lastObservedAt: IsoInstant;
  snapshotCount: number;
  usageEventCount: number;
  totalCostNanousd: number;
  sourceDatasetCount: number;
  boundaries: QuotaBoundary[];
  quotaSeries: QuotaSeriesPoint[];
  usageSeries: QuotaUsageSeriesPoint[];
}

export interface QuotaTrackEvidence {
  schemaVersion: "quota-track-evidence-v0.1";
  resetCount: number;
  resets: QuotaResetEvidence[];
}

export type QuotaCalibrationRefusalCode =
  | "source_evidence_refused"
  | "too_few_boundaries"
  | "insufficient_displayed_span"
  | "insufficient_training_boundaries"
  | "insufficient_holdout_boundaries"
  | "capacity_not_estimable"
  | "sensitivity_too_wide";

export interface NumericRange {
  lower: number;
  upper: number;
}

export interface QuotaCalibrationScoreRow {
  observedAt: IsoInstant;
  observedMovementPp: number;
  predictedMovementPp: number;
  differencePp: number;
  absoluteErrorPp: number;
}

export interface QuotaCalibrationScore {
  pointCount: number;
  meanAbsoluteErrorPp: number;
  signedBiasPp: number;
  finalDifferencePp: number;
  rows: QuotaCalibrationScoreRow[];
}

export interface PriorCapacityForecast {
  method: "median_of_prior_completed_resets";
  priorResetCount: 2 | 3;
  priorResetKeys: string[];
  trainedThrough: IsoInstant;
  capacityNanousd: number;
}

export interface ScoredPriorCapacityForecast
  extends PriorCapacityForecast {
  score: QuotaCalibrationScore | null;
}

export interface QuotaResetCalibration extends QuotaResetIdentityInput {
  schemaVersion: "quota-reset-calibration-v0.1";
  status: "conditional_estimate" | "not_testable";
  refusalCodes: QuotaCalibrationRefusalCode[];
  continuityKey: string;
  resetKey: string;
  firstObservedAt: IsoInstant;
  lastObservedAt: IsoInstant;
  boundaryCount: number;
  displayedSpanPp: number;
  capacityNanousd: number | null;
  sensitivityRangeNanousd: NumericRange | null;
  relativeSensitivityWidth: number | null;
  training: {
    boundaryCount: number;
    displayedSpanPp: number;
    capacityNanousd: number;
  } | null;
  holdout: ({
    boundaryCount: number;
  } & QuotaCalibrationScore) | null;
  priorForecast: ScoredPriorCapacityForecast | null;
}

export interface QuotaTrackCalibrationSummary
  extends QuotaContinuityInput {
  continuityKey: string;
  totalResetCount: number;
  estimatedResetCount: number;
  medianCapacityNanousd: number | null;
  acrossResetSensitivityRangeNanousd: NumericRange | null;
  empiricalForecastError: {
    scoredResetCount: number;
    scoredPointCount: number;
    meanAbsoluteErrorPp: number;
    signedBiasPp: number;
    central80SignedPp: NumericRange;
    p80AbsoluteErrorPp: number;
    p90AbsoluteErrorPp: number;
  } | null;
  resets: QuotaResetCalibration[];
}

export interface QuotaCalibration {
  schemaVersion: "quota-calibration-v0.1";
  trackCount: number;
  tracks: QuotaTrackCalibrationSummary[];
}

export type QuotaRollingRefusalCode =
  | "source_evidence_refused"
  | "forecast_not_strictly_prior"
  | "forecast_includes_current_reset"
  | "endpoint_brackets_unavailable";

export interface QuotaRollingComparison {
  smoothingHours: 1 | 2 | 3;
  windowStart: IsoInstant;
  windowEnd: IsoInstant;
  costNanousd: number;
  observedMovementPp: number;
  expectedMovementPp: number;
  differencePp: number;
}

export interface QuotaRollingComparisons {
  schemaVersion: "quota-rolling-comparisons-v0.1";
  status: "conditional_comparison" | "not_testable";
  refusalCodes: QuotaRollingRefusalCode[];
  continuityKey: string;
  resetKey: string;
  windowDurationMinutes: QuotaWindowDurationMinutes;
  resetWindowStart: IsoInstant;
  resetWindowEnd: IsoInstant;
  forecastTrainedThrough: IsoInstant;
  forecastCapacityNanousd: number;
  comparisons: QuotaRollingComparison[];
}

export const QUOTA_CALIBRATION_POLICY: Readonly<{
  minimumBoundaries: number;
  minimumDisplayedSpanPp: number;
  minimumTrainingBoundaries: number;
  minimumHoldoutBoundaries: number;
  maximumRelativeSensitivityWidth: number;
  minimumPriorResets: number;
  maximumPriorResets: number;
  minimumResetsForUncertainty: number;
  minimumScoredResetsForEmpiricalError: number;
}>;

export function continuityKey(row: QuotaContinuityInput): string;
export function resetKey(row: QuotaResetIdentityInput): string;
export function buildResetEvidence(
  input: BuildResetEvidenceInput,
): QuotaTrackEvidence;
export function fitResetCapacity(
  input: QuotaResetEvidence,
): QuotaResetCalibration;
export function analyzeQuotaCalibration(
  input: QuotaTrackEvidence,
): QuotaCalibration;
export function buildRollingQuotaComparisons(input: {
  resetEvidence: QuotaResetEvidence;
  capacityForecast: PriorCapacityForecast;
}): QuotaRollingComparisons;

export type QuotaPaceStatus =
  | "unavailable"
  | "insufficient_observations"
  | "available"
  | "will_reach_reset_first";

export type QuotaPaceRefusalCode =
  | "reset_elapsed"
  | "stale_observation"
  | "future_observation"
  | "incompatible_observation"
  | "ambiguous_observation"
  | "backward_observation"
  | "insufficient_observations"
  | "non_positive_pace"
  | "implausible_pace";

export interface QuotaPaceSnapshotInput {
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  windowDurationMinutes: QuotaWindowDurationMinutes;
  resetsAt: IsoInstant;
  observedAt: IsoInstant;
  receivedAt: IsoInstant;
  usedPercent: number;
  policyEpoch: string;
}

export interface QuotaPaceEstimate {
  method: "median_adjacent_quota_slope";
  sampleCount: number;
  elapsedHours: number | null;
  movementPp: number | null;
  /** Median of adjacent slopes that moved: pace per *working* hour. */
  activePercentagePointsPerHour: number | null;
  /** Total movement over total elapsed time: pace per *wall-clock* hour. */
  overallPercentagePointsPerHour: number | null;
}

export interface QuotaPaceForecast {
  schemaVersion: "quota-pace-forecast-v0.2";
  status: QuotaPaceStatus;
  refusalCodes: QuotaPaceRefusalCode[];
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  windowDurationMinutes: QuotaWindowDurationMinutes;
  policyEpoch: string;
  resetsAt: IsoInstant;
  currentObservedAt: IsoInstant;
  currentUsedPercent: number;
  remainingPercent: number;
  pace: QuotaPaceEstimate;
  etaAt: IsoInstant | null;
  hoursToExhaustion: number | null;
  hoursToReset: number | null;
}

export function analyzeQuotaPace(input: {
  currentSnapshot: QuotaPaceSnapshotInput;
  observations: readonly QuotaPaceSnapshotInput[];
}): QuotaPaceForecast;

// ---------------------------------------------------------------------------
// Model-composition kernel (src/model-composition.js)
// ---------------------------------------------------------------------------

export interface CompositionUsageRow {
  /** Epoch milliseconds of the priced usage (any grain; only bin sums matter). */
  observedAtMs: number;
  model: string;
  costUsd: number;
}

export interface CompositionQuotaRow {
  /** Epoch milliseconds of the weekly-window reading. */
  observedAtMs: number;
  planType: string;
  /** Epoch milliseconds of the pool's printed expiry. */
  resetsAtMs: number;
  /** Displayed 0-100 gauge value. */
  usedPercent: number;
}

export interface CompositionObservation {
  binStartMs: number;
  poolKey: string;
  segmentIndex: number;
  ppDelta: number;
  costByModel: Readonly<Record<string, number>>;
}

export interface CompositionObservationCorpus {
  observations: CompositionObservation[];
  voidedBinCount: number;
  poolCount: number;
}

export interface CompositionIdentification {
  adjustedR2: number | null;
  singleConstantAdjustedR2: number | null;
  splitHalfIdentified: boolean;
  splitHalfMaxCapacityDriftFraction: number | null;
}

export type CompositionFitStatus =
  | "fitted"
  | "fallback_blended"
  | "insufficient_observations";

export interface CompositionFit {
  status: CompositionFitStatus;
  observationCount: number;
  totalCostUsd: number | null;
  modelCostShares: Readonly<Record<string, number>>;
  /** Null unless status is "fitted". */
  capacityUsdByModel: Readonly<Record<string, number>> | null;
  singleConstantUsd: number | null;
  r2: number | null;
  singleConstantR2: number | null;
  solverConverged: boolean | null;
  identification: CompositionIdentification | null;
}

export const MODEL_COMPOSITION_POLICY: Readonly<{
  grainMs: number;
  poolToleranceMs: number;
  resetDropPp: number;
  maxCrossingElapsedMs: number;
  minimumModelCostShare: number;
  minimumObservations: number;
  otherModelKey: string;
  maxSplitHalfCapacityDriftFraction: number;
}>;

export function buildCompositionObservations(
  input?: {
    usageRows?: readonly CompositionUsageRow[];
    quotaRows?: readonly CompositionQuotaRow[];
  },
  policy?: {
    grainMs?: number;
    poolToleranceMs?: number;
    resetDropPp?: number;
    maxCrossingElapsedMs?: number;
  },
): CompositionObservationCorpus;

export function calibrateCompositionCapacities(
  observations: readonly CompositionObservation[],
  policy?: {
    minimumModelCostShare?: number;
    minimumObservations?: number;
    otherModelKey?: string;
    maxSplitHalfCapacityDriftFraction?: number;
  },
): CompositionFit;

export function blendedCompositionCapacityUsd(
  costByModel: Readonly<Record<string, number>>,
  options: {
    capacityUsdByModel: Readonly<Record<string, number>> | null;
    fallbackCapacityUsd: number | null;
  },
): number | null;
