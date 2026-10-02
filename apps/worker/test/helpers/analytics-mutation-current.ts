/** Public admission/delivery facade; the dedicated local launcher pins and instruments it. */
export {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus} from '../fixtures/shared-analytics-corpus';
export {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../../src/storage-analytics-runtime';
export {createTelemetryV11DomainPredecessor,activateTelemetryV11Domain} from '../../src/telemetry-v11-domain';
export {createTelemetryV12DomainPredecessor,activateTelemetryV12Domain} from '../../src/telemetry-v12-domain';
export {registerTelemetryV11DayManifest} from '../../src/telemetry-v11-repository';
export {persistTypedV11StagedChunk} from '../../src/typed-v11-admission';
export {readTelemetryV12EffectivePage} from '../../src/telemetry-v12-effective-reader';
export {registerTelemetryV12DayManifest,persistTelemetryV12StagedChunk} from '../../src/telemetry-v12-repository';
export {createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../../src/device-auth';
export {makeV11Day,v11UsageRecord} from './telemetry-v11';
export {canonicalTelemetryV12Json,telemetryV11DomainManifestDigestInput,telemetryV12DayManifestDigestInput,
 telemetryV12DomainManifestDigestInput,telemetryV12RequiredConsent} from '@app-usagemonitor/telemetry-contract';
export const mutationCaptureInstrumented:boolean=false;
export const nativeMigrationNames:Record<string,string[]>={};
export function drainMutationStepPreimages():import('./analytics-mutation-capture').MutationStepPreimage[]{throw Error('MUTATION_CAPTURE_BUNDLE_REQUIRED');}
export function drainMutationCaptureMeasurement():{calls:number;logicalSerializedBytes:number;captureWallMs:number;exactCpuMs:null}{throw Error("MUTATION_CAPTURE_BUNDLE_REQUIRED");}

// The dedicated bundle composes these same public kernels with real step capture.
export * from './analytics-candidate';
