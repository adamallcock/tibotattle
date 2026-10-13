/**
 * analytics_v2 community model performance publication: the store-side
 * (plumbing) contract of the twelve community-model-performance-v1 heads in
 * analytics_v2_published_performance (primary migration
 * 0079_performance_telemetry.sql).
 *
 * Plumbing, not compute: no kernel closure root imports this module
 * (cloud-run/analytics-kernel-closure.mjs). The fold (compute-performance.ts)
 * and contract.ts take its types type-only, which esbuild erases, so naming
 * a table, a store error code or the content digest here mints no compute
 * class. The fold keeps its own content-digest helper on the closure side,
 * as compute-community.ts does beside store-run.ts; a parity test holds the
 * two equal.
 *
 * One head per slot (period x speed mode). The store assigns each head's
 * revision (store-publication.ts nextPublishedRevision) and generatedAt (the
 * run's release instant); payload_sha256 digests the payload WITHOUT those
 * two fields, so an unchanged slot keeps its row and a changed slot bumps
 * only its own revision. The table holds no owner digest: it is recomputed
 * from the intake on every run, so a purge or an exclusion reaches it through
 * the next publication, never through the offline-purge inventory.
 */

import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";

export type AnalyticsV2PerformancePeriod = '1' | '7' | '30' | 'all';
export type AnalyticsV2PerformanceSpeedMode = 'standard' | 'fast' | 'ultrafast';
export type AnalyticsV2PerformanceWithheld = 'ANALYTICS_V2_PERFORMANCE_CAPACITY' | 'ANALYTICS_V2_PERFORMANCE_RECORD_INVALID' | 'ANALYTICS_V2_PERFORMANCE_MODELS_EXCEEDED' | 'ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED';
export interface AnalyticsV2PerformanceCandidate { readonly period: AnalyticsV2PerformancePeriod; readonly speedMode: AnalyticsV2PerformanceSpeedMode; readonly payload: Readonly<Record<string, unknown>>; readonly payloadSha256: string }
export interface AnalyticsV2PerformanceSummary { readonly reports: number; readonly cohorts: number; readonly includedRecords: number; readonly excludedRecords: number; readonly excludedUnknownTurns: number; readonly deferredFutureDays: number; readonly end: string }
export interface AnalyticsV2PerformanceOutputs { readonly candidates: readonly AnalyticsV2PerformanceCandidate[]; readonly summary: AnalyticsV2PerformanceSummary; readonly withheld: AnalyticsV2PerformanceWithheld | null }

/** The heads table (0079). */
export const ANALYTICS_V2_PERFORMANCE_TABLES = Object.freeze({
  publishedPerformance: "analytics_v2_published_performance",
} as const);
/** Its columns, in DDL order, and primary key (the PG17 spec holds the migration to them). */
export const ANALYTICS_V2_PERFORMANCE_COLUMNS = Object.freeze({
  publishedPerformance: Object.freeze([
    "period", "speed_mode", "revision", "released_at", "payload", "payload_sha256", "run_id", "kernel_id",
    "manifest_version",
  ] as const),
} as const);
export const ANALYTICS_V2_PERFORMANCE_PRIMARY_KEYS = Object.freeze({
  publishedPerformance: Object.freeze(["period", "speed_mode"] as const),
} as const);

/** The published periods and speed modes, in slot order (community-model-performance-v1). */
export const ANALYTICS_V2_PERFORMANCE_PERIODS: readonly AnalyticsV2PerformancePeriod[] =
  Object.freeze(["1", "7", "30", "all"] as const);
export const ANALYTICS_V2_PERFORMANCE_SPEED_MODES: readonly AnalyticsV2PerformanceSpeedMode[] =
  Object.freeze(["standard", "fast", "ultrafast"] as const);
/** Every slot, period-major: twelve. A run publishes all of them or none. */
export const ANALYTICS_V2_PERFORMANCE_SLOTS: readonly Readonly<{
  period: AnalyticsV2PerformancePeriod; speedMode: AnalyticsV2PerformanceSpeedMode;
}>[] = Object.freeze(ANALYTICS_V2_PERFORMANCE_PERIODS.flatMap((period) =>
  ANALYTICS_V2_PERFORMANCE_SPEED_MODES.map((speedMode) => Object.freeze({ period, speedMode }))));

/** The fold's closed withhold codes. */
export const ANALYTICS_V2_PERFORMANCE_WITHHELD_CODES: readonly AnalyticsV2PerformanceWithheld[] = Object.freeze([
  "ANALYTICS_V2_PERFORMANCE_CAPACITY",
  "ANALYTICS_V2_PERFORMANCE_RECORD_INVALID",
  "ANALYTICS_V2_PERFORMANCE_MODELS_EXCEEDED",
  "ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED",
] as const);

/** Payload fields this store assigns at publication; excluded from the digest. */
export const ANALYTICS_V2_PERFORMANCE_REVISION_FIELDS = Object.freeze(["revision", "generatedAt"] as const);

/**
 * The placeholder revision a candidate payload carries before the store
 * stamps it (the fold writes this literal; the store always replaces it).
 */
export const ANALYTICS_V2_PERFORMANCE_PLACEHOLDER_REVISION = 1;

/**
 * Cap on one published head, in bytes of its jsonb text form: the same
 * measure and value as 0079's CHECK (octet_length(payload::text) <= 16 MiB)
 * and the contract's MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES.
 */
export const ANALYTICS_V2_MAX_PERFORMANCE_PAYLOAD_BYTES = 16_777_216;

/** The store's closed, content-free codes for the performance publication. */
export const ANALYTICS_V2_PERFORMANCE_STORE_ERROR_CODES = Object.freeze([
  "ANALYTICS_V2_PERFORMANCE_OUTPUTS_INVALID",
  "ANALYTICS_V2_PERFORMANCE_DIGEST_MISMATCH",
  "ANALYTICS_V2_PERFORMANCE_PAYLOAD_INVALID",
  "ANALYTICS_V2_PERFORMANCE_PAYLOAD_TOO_LARGE",
  "ANALYTICS_V2_PERFORMANCE_PUBLICATION_CONFLICT",
  "ANALYTICS_V2_PERFORMANCE_STATE_INVALID",
] as const);
export type AnalyticsV2PerformanceStoreErrorCode = (typeof ANALYTICS_V2_PERFORMANCE_STORE_ERROR_CODES)[number];

/**
 * The content-free performance block of a run's publication summary (the run
 * row's publication jsonb and the write receipt): slots as `period:speedMode`
 * in slot order, the fold's withhold code, and whether the store deferred an
 * all-empty first publication.
 */
export interface AnalyticsV2PerformancePublicationSummary {
  readonly published: readonly string[];
  readonly unchanged: readonly string[];
  readonly withheld: AnalyticsV2PerformanceWithheld | null;
  readonly deferredEmpty: boolean;
}

/** A slot's name in the publication summary. */
export function analyticsV2PerformanceSlotKey(slot: {
  readonly period: AnalyticsV2PerformancePeriod; readonly speedMode: AnalyticsV2PerformanceSpeedMode;
}): string {
  return `${slot.period}:${slot.speedMode}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function contentOf(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (!(ANALYTICS_V2_PERFORMANCE_REVISION_FIELDS as readonly string[]).includes(key)) content[key] = payload[key];
  }
  return content;
}

/**
 * The digest a performance candidate must carry as payloadSha256: SHA-256 of
 * the canonical JSON of the payload without revision and generatedAt, exactly
 * as store-run.ts analyticsV2DailyContentSha256 digests a daily payload.
 */
export async function analyticsV2PerformanceContentSha256(payload: unknown): Promise<string> {
  if (!isPlainRecord(payload)) throw new TypeError("ANALYTICS_V2_PERFORMANCE_PAYLOAD_INVALID");
  return sha256Hex(canonicalJson(contentOf(payload)));
}

/** The published payload: the content plus the store-assigned revision and generatedAt. */
export function stampAnalyticsV2PerformancePayload(
  payload: Readonly<Record<string, unknown>>,
  stamp: { readonly revision: number; readonly generatedAt: string },
): Record<string, unknown> {
  return { ...contentOf(payload), revision: stamp.revision, generatedAt: stamp.generatedAt };
}
