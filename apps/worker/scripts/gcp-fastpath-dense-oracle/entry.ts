// Bundle entry for the dense production-code oracle. Copied by build.mjs into a
// verified d43c8f92 checkout as apps/worker/test/gcp-fastpath-dense-oracle-entry.ts,
// so every import below resolves to d43c8f92's own source, unmodified. It only
// re-exports: the scheduled entry points, the public read, the publishers, the
// native-path functions Tier F calls directly, and the admission and seeding
// helpers the Q-1 oracle used (test/helpers and test/fixtures at d43c8f92).
export {
  canonicalTelemetryV11Json, canonicalTelemetryV12Json, telemetryV11DomainManifestDigestInput,
  telemetryV12DayManifestDigestInput, telemetryV12DomainManifestDigestInput, telemetryV12RequiredConsent,
  parseTelemetryV12Record, validateTelemetryV12DayUsageOrder, projectAdminModelHistoryDay,
} from "@app-usagemonitor/telemetry-contract";
export { initializeSharedAnalyticsCorpusDatabases } from "./fixtures/shared-analytics-corpus";
export { createV11DeviceFixture, makeV11Day } from "./helpers/telemetry-v11";
export { canonicalJson } from "../src/canonical-json";
export { encodeBase64Url, sha256Hex } from "../src/crypto";
export { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
export { handleRequest } from "../src/index";
export { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
export { runStorageAnalyticsSchedule } from "../src/storage-analytics-worker";
export { runStoragePublicationSchedule } from "../src/storage-publication-worker";
export { runCacheRetentionDaySchedule } from "../src/cache-retention-day-worker";
export { publishStorageCommunityGraphPreview, publishStorageCommunityModelDay,
  readPublishedStorageCommunityAdminPreview } from "../src/storage-community-graph-publication";
export { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
export { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
export { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
export { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
export { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../src/telemetry-v12-repository";
export { parseTelemetryV1Chunk } from "../src/telemetry-v1";
export { currentTelemetryV1Chunk } from "../src/telemetry-v1-repository";
export { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
export { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
export { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
export { initializeStorageSource } from "../src/analytics-delivery";
export { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
export { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
export { priceTelemetryUsageEvent } from "../src/server-pricing";
export { modelHistoryWindow } from "../src/model-history-window";
export { captureStorageGraphScope, computeStorageGraphResult } from "../src/storage-community-graph";
export { advanceStorageEffectiveAnalysis, effectiveHistoryDependency, effectiveHistoryPin } from "../src/storage-effective-history";
export { selectCommunityAllowanceAnalysisFits, validCompleteCachedComposition,
  validCompleteScalarAnalysis } from "../src/community-allowance";
export { ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS, buildAdminCommunityAllowancePreview,
  buildCommunityModelCompositionDay, validCachedAdminCommunityAllowancePreview } from "../src/admin-community-allowance";
export { projectPublicAllowanceGraph } from "../src/public-allowance-breakdowns";
export { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11";
export { readAnalyticsModelBlock } from "../src/analytics-model-block";
// The settled cache-retention rebuild (settled-cache.mjs) drives production's
// lane and build directly, the per-owner-day reference (cache-days.mjs) calls
// the effective day build, and the routing record reads the shared-feature
// window exactly as computeEffective does.
export { advanceCacheRetentionDayLane, CACHE_RETENTION_EFFECTIVE_DEVICE_ID, CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
  CacheRetentionDeferredError, cacheRetentionLookbackDays, createCacheRetentionDaySourceBuild,
  createCacheRetentionEffectiveDayBuild, readCacheRetentionCommunitySeries } from "../src/cache-retention-day";
export { CacheRetentionRefusedError } from "../src/cache-retention-values";
export { CACHE_RETENTION_WORKER_DAYS, CACHE_RETENTION_WORKER_WRITES } from "../src/cache-retention-day-worker";
export { readSharedAnalyticsFeatureWindow } from "../src/storage-analytics-shared-features";
export { readEffectiveTelemetryOwnerDays } from "../src/telemetry-usage-effective-reader";
