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
// the generator and this facade, then regenerate.

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
