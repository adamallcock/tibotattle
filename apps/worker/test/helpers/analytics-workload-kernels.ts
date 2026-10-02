/** Public native entrypoints used by the disposable whole-workload harness.
 * The launcher replaces this module with a bundle from its pinned Git tree. */
export { readStorageCommunityOwnerPage } from '../../src/storage-community-authority';
export { initializeStorageAnalyticsRuntime, advanceStorageAnalytics, runStorageAnalyticsPass } from '../../src/storage-analytics-runtime';
export { runStorageAnalyticsSchedule } from '../../src/storage-analytics-worker';
export { runCacheRetentionDaySchedule } from '../../src/cache-retention-day-worker';
export { runStoragePublicationSchedule } from '../../src/storage-publication-worker';
export { advanceStorageCommunityDaily, readPublishedStorageCommunityDaily,
  retireStorageCommunityDailyPage } from '../../src/storage-community-daily';
export { readStorageGraphWorkSelection,loadLiveStorageGraphWorkSelection,ensureStorageGraphWorkSelection,
  claimStorageGraphWorkSelection,completeStorageGraphWorkSelection,releaseStorageGraphWorkSelection,discardStorageGraphWorkSelection }
  from '../../src/storage-community-graph-selection';
export { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult, STORAGE_GRAPH_METHOD } from '../../src/storage-community-graph';
export { planHistoricalModelBlockRanges } from '../../src/analytics-model-block-contract';
export { advanceStorageModelBlockGraphWork } from '../../src/storage-community-graph-model-block';
export { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview,
  readPublishedStorageCommunityGraph, retireStorageCommunityGraphPublications }
  from '../../src/storage-community-graph-publication';
export { CACHE_RETENTION_EFFECTIVE_DEVICE_ID, CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
  createCacheRetentionDaySourceBuild, readCacheRetentionCarryDays, writeCacheRetentionDay,
  readCacheRetentionDay, readCacheRetentionCommunitySeries, retireCacheRetentionDayPage,
  CacheRetentionDeferredError } from '../../src/cache-retention-day';
export { retireStorageGraphPage } from '../../src/storage-graph-retirement';
export { retireSharedAnalyticsFeaturePage } from '../../src/storage-analytics-shared-features';
export const referenceCommit: string | null = null;
export function resetPricingCalls(): void { /* Bundled launcher supplies the instrumented counter. */ }
export function pricingCalls(): number | null { return null; }

export { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from '../fixtures/shared-analytics-corpus';
export const nativeMigrationNames: Record<string,string[]> = {};

/** Only the reviewed bundle transform implements the analytical clock. */
export const publicationClockAdapted: boolean = false;
export function setAnalyticsWorkloadPublicationClock(_nowMs:number):{lane:string;nowMs:number;revision:number} { throw new Error('PUBLICATION_CLOCK_BUNDLE_REQUIRED'); }
export function readAnalyticsWorkloadPublicationClock():number { throw new Error('PUBLICATION_CLOCK_BUNDLE_REQUIRED'); }

// Native accepted-input cutoff qualification uses the same reviewed typed readers.
export {loadV11SourcePin} from "../../src/telemetry-v11-domain";
export {readTypedV11UsageAnalysisPage} from "../../src/typed-v11-analysis-reader";
export {createTypedV11QuotaPageReader} from "../../src/typed-v11-quota-reader";
export {captureSelectedStorageGraphScope} from "../../src/storage-community-graph";
export {loadTypedV11GenerationSnapshot} from "../../src/typed-v11-quota-reader";

// Existing native lifecycle and accepted-input APIs used by retained functional
// scenarios. The reference builder resolves each module inside its pinned tree.
export {readIngestionChanges,applyAnalyticsChange} from '../../src/analytics-delivery';
export {revokeParticipantDevice} from '../../src/device-auth';
export {revokeAccountlessEnrollment} from '../../src/accountless-enrollment';
export {eraseParticipantAsOwner} from '../../src/participant-erasure';
export {advanceStorageErasureJobs,requireStorageParticipantErasureComplete} from '../../src/storage-erasure';
export {replayDeletionTombstones,hasDeletionTombstone} from '../../src/retention';
export {readTypedTelemetryRowsByStorageIds} from '../../src/typed-telemetry-compatibility';
export {prepareUsageCorrectionAssertion} from '../../src/telemetry-usage-reconciliation';
export {parseTelemetryV12Record,validateTelemetryV12DayUsageOrder} from '@app-usagemonitor/telemetry-contract';

export {readEffectiveTelemetryOwnerDayPage} from '../../src/telemetry-usage-effective-reader';

// Native staged-to-active owner transition for a separately initialized local
// laboratory. Reference builds resolve these unchanged inside f056940f.
export {activateTelemetryRuntimeAsOwner,canonicalTelemetryRuntimeDeploymentAttestationJson,
 canonicalTelemetryRuntimeReconciliationJson,telemetryRuntimeReconciliationDigests,
 parseTelemetryRuntimeActivationRequest} from '../../src/telemetry-runtime-activation';

export {initializeStorageSource} from '../../src/analytics-delivery';
export {initializeTypedV1Admission} from '../../src/typed-v1-admission';
export {initializeTypedV11Admission} from '../../src/typed-v11-admission';
export {drainCommunityPublicSourceBootstrap} from '../../src/community-daily-aggregates';

/** Test-only transformed bundle export. Reference uses its independently
 * witnessed native helper; an uninstrumented kernel has no runtime export. */
export interface AnalyticsC06BlockCompletion {readonly state:'complete';readonly reused:boolean;
 readonly metric:'model';readonly day:string;readonly adoptedDates:number;readonly queriesUsed:number;}
export declare function installAnalyticsC06BlockCompletion(callback:((value:AnalyticsC06BlockCompletion)=>void)|null):void;
