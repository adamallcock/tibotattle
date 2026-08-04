export type IsoInstant = string;
export type OpaqueId = string;
export type QuotaWindowDurationMinutes = 300 | 10080;

export const FIVE_HOUR_WINDOW_MINUTES: 300;
export const SEVEN_DAY_WINDOW_MINUTES: 10080;
export const SUPPORTED_QUOTA_WINDOW_DURATIONS: readonly [300, 10080];
export function isSupportedQuotaWindowDuration(
  value: number,
): value is QuotaWindowDurationMinutes;
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

export const QUOTA_TRACK_POLICY: Readonly<{
  supportedDurationsMinutes: readonly [300, 10080];
  maximumReceiptLagMs: number;
}>;

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

export const QUOTA_ROLLING_POLICY: Readonly<{
  rollingHours: readonly [1, 2, 3];
  maximumEndpointBracketMs: number;
}>;

export function continuityKey(row: QuotaContinuityInput): string;
export function resetKey(row: QuotaResetIdentityInput): string;
export function buildResetEvidence(
  input: BuildResetEvidenceInput,
): QuotaTrackEvidence;
export function fitResetCapacity(
  input: QuotaResetEvidence,
): QuotaResetCalibration;
export function forecastCapacityFromPriorResets(
  priorResetFits: readonly QuotaResetCalibration[],
  currentResetFit: QuotaResetCalibration,
): PriorCapacityForecast | null;
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
  windowDurationMinutes: 10080;
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
  percentagePointsPerHour: number | null;
}

export interface QuotaPaceForecast {
  schemaVersion: "quota-pace-forecast-v0.1";
  status: QuotaPaceStatus;
  refusalCodes: QuotaPaceRefusalCode[];
  accountTrackId: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  windowDurationMinutes: 10080;
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

export const QUOTA_PACE_POLICY: Readonly<{
  schemaVersion: "quota-pace-forecast-v0.1";
  method: "median_adjacent_quota_slope";
  windowDurationMinutes: 10080;
  maximumReceiptLagMs: number;
  maximumPacePpPerHour: number;
  minimumObservations: 2;
}>;

export function analyzeQuotaPace(input: {
  currentSnapshot: QuotaPaceSnapshotInput;
  observations: readonly QuotaPaceSnapshotInput[];
}): QuotaPaceForecast;
