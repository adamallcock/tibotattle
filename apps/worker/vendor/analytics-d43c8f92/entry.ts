// The one import surface for the production analytics kernels on the GCP line.
//
// Every other source file in this directory is a byte copy of commit d43c8f92
// (the production Worker), written by scripts/vendor-analytics-kernels.mjs and
// verified by scripts/vendor-analytics-kernels.check.mjs against MANIFEST.json.
// The only edits are five `export ` tokens that MANIFEST.json lists. The
// apps/worker/src/*.d.ts files (MANIFEST.json typeStubs) are tsc declarations of
// d43c8f92 modules the copies import only for types; they keep tsc-checked
// consumers compiling and are never loaded at runtime. The three
// workspace packages are vendored at d43c8f92 too: tsconfig.json `paths` (for
// esbuild) and vitest.analytics-v2.config.mjs (for Vitest) resolve
// @app-usagemonitor/* imports made inside this directory to those copies, so
// the kernels never run against the GCP line's own packages.
//
// Do not edit vendored files. To change the vendored revision or closure, edit
// the generator and this facade, then regenerate. The GCP job's larger bounds
// are not a vendored edit: src/analytics-v2/native-path.ts recomposes the
// exported kernel steps below and owns the GCP limits (resources.ts).

// Shared per-owner-day reducers (scalar fits, model history, cache continuity).
export {
  evaluateSharedCacheDay,
  evaluateSharedModelDate,
  evaluateSharedScalarDate,
  prepareSharedAnalyticsDay,
  SharedAnalyticsUnavailable,
} from "./apps/worker/src/analytics-shared-reducers";
export type { SharedAnalyticsDay, SharedAnalyticsDayInput } from "./apps/worker/src/analytics-shared-reducers";
// The paged feature kernels and model block evaluation underneath those reducers.
export {
  appendSharedAnalyticsFeaturePage,
  createSharedAnalyticsFeaturePending,
  finishSharedAnalyticsFeatureDay,
} from "./apps/worker/src/analytics-shared-features";
export { evaluatePreparedModelDate } from "./apps/worker/src/analytics-model-block-contract";
export { createUsageCorrectionOccurrenceAccumulator } from "./apps/worker/src/telemetry-usage-reconciliation";

// The kernel steps that the shared reducers and production's native effective
// path (storage-effective-history.ts advanceStorageEffectiveAnalysis) are
// built from. src/analytics-v2/native-path.ts composes them into the
// in-memory equivalent of the native path, for owner-days and windows that the
// shared reducers refuse at their bounds. Every module named here is already
// in the facade's closure, so the vendored file set does not change.
export {
  appendEffectiveQuotaDay,
  finishEffectiveQuotaDay,
  foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow,
} from "./apps/worker/src/effective-quota-day";
export type { EffectiveQuotaDay, EffectiveQuotaDayPending } from "./apps/worker/src/effective-quota-day";
export {
  appendEffectiveUsageDay,
  effectiveUsageWindowRepresentable,
  mapEffectiveUsagePageRow,
} from "./apps/worker/src/effective-usage-day";
export type { EffectiveUsageDay, EffectiveUsageDayPending } from "./apps/worker/src/effective-usage-day";
export { cacheRetentionEventFromRecord, cacheRetentionSessionDigest } from "./apps/worker/src/cache-retention-day";
export {
  advanceV11UsageReduction,
  createV11QuotaAcquisitionIdentity,
  finishV11UsageReduction,
  foldV11UsageModelReduction,
} from "./apps/worker/src/quota-analysis-v11";
export type { UsageRow, V11UsageReductionCheckpoint } from "./apps/worker/src/quota-analysis-v11";
export {
  advanceV11QuotaAcquisition,
  createV11QuotaAcquisitionCheckpoint,
} from "./apps/worker/src/quota-analysis-v11-reader";
export type {
  V11CompletedQuotaAcquisition,
  V11QuotaAcquisitionCheckpoint,
  V11QuotaAcquisitionIdentity,
  V11QuotaPageReader,
} from "./apps/worker/src/quota-analysis-v11-reader";
export type { V11QuotaPageRow } from "./apps/worker/src/typed-v11-quota-reader";

// Community daily activity and API-equivalent value.
export { buildCommunityDailyPayload, COMMUNITY_DAILY_POLICY_VERSION } from "./apps/worker/src/community-daily-aggregates";
export type { DailyCellRow, DailyTotalsRow } from "./apps/worker/src/community-daily-aggregates";
export { finalizeCommunityDailySpend, isCurrentCommunityDailySpend } from "./apps/worker/src/community-daily-spend";
export type { CommunityDailySpend } from "./apps/worker/src/community-daily-spend";
export {
  createV11DailyProjectionValues,
  finalizeV11DailyProjectionValues,
  foldV11DailyProjectionValues,
  mergeV11DailyProjectionValues,
  validateV11DailyProjectionValues,
} from "./apps/worker/src/v11-daily-projection-values";
export type { V11DailyProjectionValues } from "./apps/worker/src/v11-daily-projection-values";
// Cross-owner fold of per-owner daily values (export-patched).
export { publicInputs } from "./apps/worker/src/storage-community-daily";

// Community allowance fits, model composition and the admin/public preview.
export {
  selectCommunityAllowanceAnalysisFits,
  summarizeCommunityAllowanceFits,
  summarizeCommunityCapacityByPlanType,
} from "./apps/worker/src/community-allowance";
export type {
  CachedCommunityModelCompositions,
  CommunityAllowanceFit,
  CommunityAllowanceSummary,
  CommunityCapacityByPlanType,
  CommunityModelComposition,
} from "./apps/worker/src/community-allowance";
export {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityModelCompositionDay,
  validCachedAdminCommunityAllowancePreview,
} from "./apps/worker/src/admin-community-allowance";
export type {
  AdminCommunityAllowancePreview,
  AdminCommunityModelCompositionDay,
} from "./apps/worker/src/admin-community-allowance";
export { projectPublicAllowanceGraph, PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION } from "./apps/worker/src/public-allowance-breakdowns";
export type { PublicAllowanceBreakdowns, PublicAllowanceBreakdownsCacheRow } from "./apps/worker/src/public-allowance-breakdowns";

// Cache continuity bands and the read-time public windows.
export {
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_MODEL_LIMIT,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  CacheRetentionRefusedError,
  mergeCacheRetentionBands,
  publicCacheRetentionCurve,
  publicCacheRetentionWindow,
  reduceCacheRetentionDay,
} from "./apps/worker/src/cache-retention-values";
export type {
  CacheRetentionBandRow,
  CacheRetentionDayAggregate,
  CacheRetentionItem,
  CacheRetentionWindowId,
  PublicCacheRetentionSeries,
  PublicCacheRetentionWindow,
} from "./apps/worker/src/cache-retention-values";

// Model-history window arithmetic.
export { modelHistoryWindow } from "./apps/worker/src/model-history-window";
export type { V11SourcePin } from "./apps/worker/src/telemetry-v11-domain";
export type { V1ModelCompositionResult } from "./apps/worker/src/quota-analysis-v1";

// Effective-occurrence reconciliation for the PostgreSQL occurrence adapter
// (reconcileGroups, reconciledAttribution, genericRecordJson and
// genericOccurrence are export-patched).
export {
  EFFECTIVE_USAGE_READER_METHOD,
  genericOccurrence,
  genericRecordJson,
  reconciledAttribution,
  reconcileGroups,
} from "./apps/worker/src/telemetry-usage-effective-reader";
export type {
  EffectiveTelemetryOccurrence,
  EffectiveTelemetryStream,
  EffectiveUsageOccurrence,
} from "./apps/worker/src/telemetry-usage-effective-reader";
export type { TypedTelemetryCompatibilityRecord } from "./apps/worker/src/typed-telemetry-compatibility";
export type { TelemetryV12EffectiveRecord } from "./apps/worker/src/telemetry-v12-effective-reader";
export type { TelemetryUsageCorrectionFactRow } from "./apps/worker/src/telemetry-usage-correction-repository";

// Canonical record JSON at the same package revision as the kernels.
export { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
