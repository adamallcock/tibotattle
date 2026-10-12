export type PublicGraphBenchmarkProfile = "small" | "medium" | "stress_5k" | "stress_10k";
export type PublicGraphBenchmarkProvider = "d1" | "postgres";
export interface PublicGraphBenchmarkRun {
  readonly profile: PublicGraphBenchmarkProfile;
  readonly kind: "warmup" | "measured";
  readonly iteration: number;
}
export type PublicGraphBenchmarkNativeWork =
  | Readonly<{ kind: "d1"; steps: number; queriesUsed: number; graphCalculations: number; dailyPublications: number }>
  | Readonly<{ kind: "postgres"; calculated: number; published: number; historicalPublished: number;
    acknowledged: number; deferred: number; stale: number; persistedOwnerResults: number;
    persistedPublications: number; persistedPreviews: number }>;
export interface PublicGraphBenchmarkSample {
  readonly elapsedMs: number;
  readonly overallWallMs: number;
  readonly nativePasses: number;
  readonly nativeWork: PublicGraphBenchmarkNativeWork;
  readonly sourceBytes: number;
  readonly sourceDigest: string;
  readonly outputDigest: string;
}
export interface PublicGraphBenchmarkRecord {
  readonly schemaVersion: string;
  readonly observationId?: string;
  readonly eventId?: string;
  readonly observedTime?: string;
  readonly eventTime?: string;
  readonly [key: string]: unknown;
}
export interface PublicGraphBenchmarkRows {
  readonly days: readonly {
    readonly day: string;
    readonly quota: readonly PublicGraphBenchmarkRecord[];
    readonly usage: readonly PublicGraphBenchmarkRecord[];
  }[];
  readonly sourceDigest: string;
  readonly sourceBytes: number;
}
export interface PublicGraphBenchmarkSummary {
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly medianAbsoluteDeviationMs: number;
}
export interface PublicGraphBenchmarkReceipt {
  readonly schemaVersion: "public-graph-benchmark-v1";
  readonly mode: "local-development" | "hosted-synthetic";
  readonly provider: PublicGraphBenchmarkProvider;
  readonly timingBoundary: string;
  readonly telemetryFormat: "v1.1";
  readonly workloadId: string;
  readonly profile: PublicGraphBenchmarkProfile;
  readonly ownerCount: number;
  readonly dayCount: number;
  readonly targetDay: string;
  readonly quotaObservations: number;
  readonly usageEvents: number;
  readonly totalRows: number;
  readonly fixedNow: string;
  readonly rowsPerStreamPerDay: number;
  readonly rowsPerDay: number;
  readonly iterations: number;
  readonly warmupIterations: number;
  readonly nativePasses: number;
  readonly samples: readonly PublicGraphBenchmarkSample[];
  readonly warmupSamples: readonly PublicGraphBenchmarkSample[];
  readonly elapsedSummary: PublicGraphBenchmarkSummary;
  readonly overallWallSummary: PublicGraphBenchmarkSummary;
  readonly fullBuild: true;
  readonly coldStart: true;
  readonly published: true;
  readonly readbackRows: 1;
  readonly outputScope: "single-selected-day";
  readonly fullHistoryQualified: false;
  readonly equivalentWorkQualified: false;
  readonly equivalentWorkReason: "native-path-work-differs";
  readonly sourceBytes: number;
  readonly sourceDigest: string;
  readonly outputDigest: string;
  readonly elapsedMs: number;
  readonly overallWallMs: number;
}
export const PUBLIC_GRAPH_BENCHMARK_VERSION: "public-graph-benchmark-v2";
export const PUBLIC_GRAPH_BENCHMARK_WORKLOAD_VERSION: "public-graph-benchmark-v1";
export const PUBLIC_GRAPH_BENCHMARK_TIMING_BOUNDARY: string;
export const PUBLIC_GRAPH_BENCHMARK_FIXED_NOW: string;
export const PUBLIC_GRAPH_BENCHMARK_DAYS: readonly string[];
export const PUBLIC_GRAPH_BENCHMARK_TARGET_DAY: string;
export const PUBLIC_GRAPH_BENCHMARK_MAX_TOTAL_ROWS: 10000;
export const PUBLIC_GRAPH_BENCHMARK_MAX_ROWS_PER_STREAM_PER_DAY: 1000;
export const PUBLIC_GRAPH_BENCHMARK_MAX_SOURCE_BYTES: 8388608;
export const PUBLIC_GRAPH_BENCHMARK_STRESS_MEASURED_RUNS: 3;
export const PUBLIC_GRAPH_BENCHMARK_STRESS_WARMUP_RUNS: 1;
export const PUBLIC_GRAPH_BENCHMARK_PROFILES: Readonly<Record<PublicGraphBenchmarkProfile,
  Readonly<{ multiplier: number; rowsPerStreamPerDay: number }>>>;
export function publicGraphBenchmarkRunPlan(stressMode?: boolean | string): readonly PublicGraphBenchmarkRun[];
export function canonicalBenchmarkJson(value: unknown): string;
export function benchmarkSha256(value: string): string;
export function createPublicGraphBenchmarkRows(profile: PublicGraphBenchmarkProfile,
  priceChunkUsageRecord: (record: string, observedAt: string) => {
    pricingStatus: string; costNanousd: number;
  } | null): PublicGraphBenchmarkRows;
export function publicGraphWorkload(profile: PublicGraphBenchmarkProfile): Readonly<{
  version: string; telemetryFormat: "v1.1"; fixedNow: string; days: readonly string[]; targetDay: string;
  ownerCount: number; quotaObservations: number; usageEvents: number; profile: PublicGraphBenchmarkProfile;
  totalRows: number; rowsPerStreamPerDay: number; rowsPerDay: number; workloadId: string;
}>;
export function createPublicGraphBenchmarkReceipt(input: {
  provider: PublicGraphBenchmarkProvider;
  mode: "local-development" | "hosted-synthetic";
  timingBoundary: string;
  format: "v1.1";
  profile: PublicGraphBenchmarkProfile;
  iterations?: number;
  warmupIterations?: number;
  nativePasses?: number;
  elapsedMs?: number;
  overallWallMs?: number;
  nativeWork?: PublicGraphBenchmarkNativeWork;
  samples?: readonly PublicGraphBenchmarkSample[];
  warmupSamples?: readonly PublicGraphBenchmarkSample[];
  fullBuild: true;
  coldStart: true;
  published: true;
  readbackRows: 1;
  sourceBytes?: number;
  sourceDigest: string;
  outputDigest: string;
}): PublicGraphBenchmarkReceipt;
export function comparePublicGraphBenchmarkReceipts(receipts: readonly PublicGraphBenchmarkReceipt[]): Readonly<{
  status: "comparable-synthetic";
  profile: PublicGraphBenchmarkProfile;
  workloadId: string;
  sourceDigest: string;
  outputDigest: string;
  d1ElapsedMs: number;
  postgresElapsedMs: number;
  d1OverallWallMs: number;
  postgresOverallWallMs: number;
  d1NativePasses: number;
  postgresNativePasses: number;
  d1OverPostgresRatio: number | null;
  equivalentWorkQualified: false;
  equivalentWorkReason: "native-path-work-differs";
  d1ElapsedSummary: PublicGraphBenchmarkSummary;
  postgresElapsedSummary: PublicGraphBenchmarkSummary;
  d1NativeWorkSamples: readonly PublicGraphBenchmarkNativeWork[];
  postgresNativeWorkSamples: readonly PublicGraphBenchmarkNativeWork[];
  hostedTenfoldClaimQualified: false;
  hostedClaimStatus: string;
}>;
