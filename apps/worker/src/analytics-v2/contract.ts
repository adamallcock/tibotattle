/**
 * analytics-v2 contract: the shared names and types of the GCP fast-path
 * analytics-refresh job (claude/gcp-fastpath-base, INT-0).
 *
 * One Cloud Run Job reads accepted evidence from the existing typed
 * PostgreSQL tables (A-1), runs the vendored d43c8f92 analytics kernels in
 * one process (A-2), and writes every output in ONE transaction to the
 * analytics_v2_* tables of the primary role (A-3, primary migration 0059).
 * GET /api/v1/community/daily is then served from those tables by an origin
 * route module (A-4) through the IN-1 route-module seam.
 *
 * This module is the single source for the table and column names and for the
 * types those packages exchange. It holds no SQL, no I/O and no kernel code.
 * The vendored kernel types are not imported here: kernel-shaped values cross
 * this contract as AnalyticsV2KernelValue and are validated where they are
 * produced or consumed. Changing a name or a type here is an integration-lead
 * change (plan-v5); packages propose edits to the lead instead of forking it.
 *
 * Privacy: every identity in this contract is an opaque 64-hex owner digest
 * or a pseudonymous participant id. No prompt, path, session content, raw
 * account identifier or credential may enter any analytics_v2 row.
 */

import type { PostgresPool } from "../postgres-client";
import type { WorkerRouteMethod } from "../route-registry";

/** Version of this contract; bump with any name or shape change. */
export const ANALYTICS_V2_CONTRACT_VERSION = "analytics-v2-contract-v0.2" as const;

/**
 * The analytics_v2 migration: primary role, runtime schema, number assigned in
 * plan-v5. Staged by A-3, promoted by the integration lead.
 */
export const ANALYTICS_V2_MIGRATION = Object.freeze({
  role: "primary",
  version: 59,
  name: "0059_analytics_v2.sql",
} as const);

/** Advisory-lock key text: pg_try_advisory_lock(hashtext(...)) in A-3. */
export const ANALYTICS_V2_REFRESH_LOCK_KEY = "analytics_v2_refresh" as const;

/** Cloud Run build entry the lead adds for A-3 (dist/analytics-refresh.mjs). */
export const ANALYTICS_V2_REFRESH_ENTRY = "analytics-refresh" as const;

/** Run modes. Only full recompute exists tonight; the memo mode is deferred. */
export const ANALYTICS_V2_MODES = Object.freeze(["full"] as const);
export type AnalyticsV2Mode = (typeof ANALYTICS_V2_MODES)[number];

/** analytics_v2_runs.state. A LOCK_HELD exit writes no run row. */
export const ANALYTICS_V2_RUN_STATES = Object.freeze(["complete", "failed"] as const);
export type AnalyticsV2RunState = (typeof ANALYTICS_V2_RUN_STATES)[number];

// ---------------------------------------------------------------------------
// Tables and columns (A-3 creates exactly these; readers use these names)
// ---------------------------------------------------------------------------

export const ANALYTICS_V2_TABLES = Object.freeze({
  runs: "analytics_v2_runs",
  ownerDay: "analytics_v2_owner_day",
  cacheBands: "analytics_v2_cache_bands",
  ownerFits: "analytics_v2_owner_fits",
  ownerModelDates: "analytics_v2_owner_model_dates",
  publishedDaily: "analytics_v2_published_daily",
  preview: "analytics_v2_preview",
  journalCursor: "analytics_v2_journal_cursor",
} as const);
export type AnalyticsV2TableKey = keyof typeof ANALYTICS_V2_TABLES;
export type AnalyticsV2TableName = (typeof ANALYTICS_V2_TABLES)[AnalyticsV2TableKey];

/**
 * The seven production cache-retention band counters, in the column order of
 * d43c8f92 analytics_cache_retention_day_bands.
 */
export const ANALYTICS_V2_CACHE_BAND_COUNTERS = Object.freeze([
  "adjacencies",
  "reused_more_than_half",
  "matched_or_exceeded",
  "unordered_ties",
  "excluded_insufficient_evidence",
  "excluded_context_contracted",
  "sessions",
] as const);
export type AnalyticsV2CacheBandCounter = (typeof ANALYTICS_V2_CACHE_BAND_COUNTERS)[number];

/** Every column of every analytics_v2 table, in declaration order. */
export const ANALYTICS_V2_COLUMNS = Object.freeze({
  runs: Object.freeze([
    "run_id", "started_at", "finished_at", "mode", "state", "owners", "owner_days",
    "refusals", "publication", "timings",
  ] as const),
  ownerDay: Object.freeze(["owner_digest", "day", "daily", "refusal", "run_id"] as const),
  cacheBands: Object.freeze([
    "owner_digest", "day", "model", "effort", "band", ...ANALYTICS_V2_CACHE_BAND_COUNTERS, "run_id",
  ] as const),
  ownerFits: Object.freeze(["owner_digest", "as_of_day", "fits", "run_id"] as const),
  ownerModelDates: Object.freeze(["owner_digest", "day", "result", "run_id"] as const),
  publishedDaily: Object.freeze([
    "day", "revision", "released_at", "payload", "payload_sha256", "run_id",
  ] as const),
  preview: Object.freeze(["id", "preview", "computed_at", "run_id"] as const),
  journalCursor: Object.freeze(["id", "last_sequence", "run_id"] as const),
} as const satisfies Record<AnalyticsV2TableKey, readonly string[]>);

/** Primary keys. Singletons (preview, journal cursor) use id = 1. */
export const ANALYTICS_V2_PRIMARY_KEYS = Object.freeze({
  runs: Object.freeze(["run_id"] as const),
  ownerDay: Object.freeze(["owner_digest", "day"] as const),
  cacheBands: Object.freeze(["owner_digest", "day", "model", "effort", "band"] as const),
  ownerFits: Object.freeze(["owner_digest"] as const),
  ownerModelDates: Object.freeze(["owner_digest", "day"] as const),
  publishedDaily: Object.freeze(["day"] as const),
  preview: Object.freeze(["id"] as const),
  journalCursor: Object.freeze(["id"] as const),
} as const satisfies Record<AnalyticsV2TableKey, readonly string[]>);

export const ANALYTICS_V2_SINGLETON_ID = 1 as const;

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/** UTC calendar day, YYYY-MM-DD. */
export type AnalyticsV2Day = string;
/** Lowercase 64-hex owner digest (storage owner identity, never a raw id). */
export type AnalyticsV2OwnerDigest = string;
export const ANALYTICS_V2_OWNER_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
export const ANALYTICS_V2_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const ANALYTICS_V2_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * A value produced or consumed by a vendored d43c8f92 kernel (daily
 * projection values, fits, model-date results, the admin preview, the daily
 * payload). It is stored as jsonb and validated by the kernel's own
 * validators at the producing or consuming package, not by this contract.
 */
export type AnalyticsV2KernelValue = unknown;

/**
 * Per-owner source routing, exactly as d43c8f92 storage-community-graph.ts:
 * effective, else v1.1, else v1 (mixed when legacy v0.2 evidence exists),
 * else v0.2.
 */
export const ANALYTICS_V2_OWNER_SOURCES = Object.freeze(["effective", "v1.1", "v1", "mixed", "v0.2"] as const);
export type AnalyticsV2OwnerSource = (typeof ANALYTICS_V2_OWNER_SOURCES)[number];

/**
 * One eligible owner (A-1 listAnalyticsV2Owners): production-parity
 * eligibility (OD-3), i.e. an active participant present in
 * community_public_source_owners. hasEffective = hasV12 OR ((hasV1 OR hasV11)
 * AND the telemetry_usage_correction_runtime id=1 row is active).
 */
export interface AnalyticsV2Owner {
  readonly participantId: string;
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly hasV1: boolean;
  readonly hasV11: boolean;
  readonly hasV12: boolean;
  readonly hasLegacy: boolean;
  readonly hasEffective: boolean;
  readonly source: AnalyticsV2OwnerSource;
}

/** The analysis family a refusal belongs to. "owner" refusals have day null. */
export const ANALYTICS_V2_REFUSAL_FAMILIES = Object.freeze(["owner", "daily", "scalar", "model", "cache"] as const);
export type AnalyticsV2RefusalFamily = (typeof ANALYTICS_V2_REFUSAL_FAMILIES)[number];

/**
 * Closed refusal reasons: the fast-path's own reasons, every
 * SharedAnalyticsUnavailable reason the d43c8f92 kernels raise, and the
 * CacheRetentionRefusedError reasons evaluateSharedCacheDay can raise. A new
 * reason is a contract change through the lead, never a free-form string.
 */
export const ANALYTICS_V2_REFUSAL_REASONS = Object.freeze([
  // Fast-path routing and scope (tonight: no dense or non-effective port).
  "non_effective_source_unported",
  "usage_window_unrepresentable",
  "day_occurrences_exceeded",
  "source_conflict_or_order",
  // d43c8f92 analytics-shared-reducers.ts SharedAnalyticsUnavailable reasons.
  "invalid_day",
  "invalid_owner",
  "day_row_limit",
  "day_byte_limit",
  "quota_day_unrepresentable",
  "usage_day_unrepresentable",
  "cache_usage_row_refused",
  "window_pin_or_capacity",
  "duplicate_day",
  "incomplete_window",
  "window_capacity",
  "quota_window_unrepresentable",
  "usage_day_absent",
  "owner_mismatch",
  "incomplete_cache_day",
  "incomplete_cache_lookback",
  // d43c8f92 cache-retention-values.ts reduceCacheRetentionDay refusals
  // (CacheRetentionRefusedError). Production records both per owner-day as
  // refusal marks (CACHE_RETENTION_RECORDED_REFUSALS) and continues. A-2
  // emits them in the "cache" family only.
  "group_limit_exceeded",
  "session_limit_exceeded",
] as const);
export type AnalyticsV2RefusalReason = (typeof ANALYTICS_V2_REFUSAL_REASONS)[number];

/** An explicit refusal: never converted to zero or to inferred continuity. */
export interface AnalyticsV2Refusal {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly day: AnalyticsV2Day | null;
  readonly family: AnalyticsV2RefusalFamily;
  readonly reason: AnalyticsV2RefusalReason;
}

/** analytics_v2_owner_day: prepared daily values or the owner-day refusal. */
export interface AnalyticsV2OwnerDayRow {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly day: AnalyticsV2Day;
  /** Prepared daily values with coverage and knownCostNanousd stripped; null when refused. */
  readonly daily: AnalyticsV2KernelValue | null;
  readonly refusal: AnalyticsV2RefusalReason | null;
}

/** analytics_v2_cache_bands: one owner, day, model, effort and band. */
export interface AnalyticsV2CacheBandRow {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly day: AnalyticsV2Day;
  readonly model: string;
  readonly effort: string;
  readonly band: string;
  readonly counters: Readonly<Record<AnalyticsV2CacheBandCounter, number>>;
}

/** analytics_v2_owner_fits: the owner's scalar fits as of one day. */
export interface AnalyticsV2OwnerFitsRow {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly asOfDay: AnalyticsV2Day;
  readonly fits: AnalyticsV2KernelValue;
}

/** analytics_v2_owner_model_dates: one evaluateSharedModelDate result. */
export interface AnalyticsV2OwnerModelDateRow {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly day: AnalyticsV2Day;
  readonly result: AnalyticsV2KernelValue;
}

/**
 * A computed community daily payload for a queued day. A-3 publishes it only
 * when payloadSha256 differs from the stored row: revision =
 * max(previous, revisionSeed) + 1 and released_at = nowMs.
 */
export interface AnalyticsV2DailyCandidate {
  readonly day: AnalyticsV2Day;
  readonly payload: AnalyticsV2KernelValue;
  readonly payloadSha256: string;
}

/** analytics_v2_published_daily as stored and served. */
export interface AnalyticsV2PublishedDailyRow {
  readonly day: AnalyticsV2Day;
  readonly revision: number;
  readonly releasedAt: string;
  readonly payload: AnalyticsV2KernelValue;
  readonly payloadSha256: string;
}

/** Per-run publication outcome, recorded in analytics_v2_runs.publication. */
export interface AnalyticsV2PublicationSummary {
  readonly published: readonly AnalyticsV2Day[];
  readonly unchanged: readonly AnalyticsV2Day[];
  /** Days with a conflict row or an unprepared eligible owner; each keeps its prior revision. */
  readonly blocked: readonly AnalyticsV2Day[];
}

/** Wall-time phases recorded per run (milliseconds). */
export const ANALYTICS_V2_PHASES = Object.freeze([
  "read", "prepare", "scalar", "model", "cache", "community", "write",
] as const);
export type AnalyticsV2Phase = (typeof ANALYTICS_V2_PHASES)[number];

/**
 * Everything one computeAnalyticsV2 call returns (A-2) and writeRunOutputs
 * persists in one transaction (A-3). A-2 does no I/O; the journal cursor is
 * the storage_ingestion_changes sequence A-1 read up to.
 */
export interface AnalyticsV2RunOutputs {
  readonly contractVersion: typeof ANALYTICS_V2_CONTRACT_VERSION;
  readonly mode: AnalyticsV2Mode;
  readonly nowMs: number;
  readonly today: AnalyticsV2Day;
  readonly revisionSeed: number;
  readonly owners: readonly AnalyticsV2Owner[];
  readonly ownerDays: readonly AnalyticsV2OwnerDayRow[];
  readonly cacheBands: readonly AnalyticsV2CacheBandRow[];
  readonly ownerFits: readonly AnalyticsV2OwnerFitsRow[];
  readonly ownerModelDates: readonly AnalyticsV2OwnerModelDateRow[];
  readonly dailyCandidates: readonly AnalyticsV2DailyCandidate[];
  readonly blockedDays: readonly AnalyticsV2Day[];
  /** The admin community allowance preview (v0.3), or null when it cannot be built. */
  readonly preview: AnalyticsV2KernelValue | null;
  readonly refusals: readonly AnalyticsV2Refusal[];
  readonly journal: { readonly lastSequence: number | null };
  readonly timings: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
}

/** The read context every A-1 reader takes; reads run in BEGIN READ ONLY. */
export interface AnalyticsV2ReadContext {
  readonly pool: PostgresPool;
  readonly schema: string;
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// Origin seam type names reserved for IN-1
// ---------------------------------------------------------------------------
//
// IN-1 owns the runtime seam (cloud-run/origin-route-modules.mjs and
// cloud-run/contribution-envelope-registry.mjs) and its validators. These are
// the TypeScript names TypeScript packages (A-4, IN-2, IN-3) use for it. IN-1
// may narrow the context and option shapes through the lead; it may not
// rename them.

/** The built-in origin routes a registered module may override. */
export const ORIGIN_OVERRIDABLE_BUILT_INS = Object.freeze([
  "/api/v1/community/daily",
  "/api/v1/upload-authorizations",
] as const);
export type OriginOverridableBuiltIn = (typeof ORIGIN_OVERRIDABLE_BUILT_INS)[number];

/** Per-request context the origin passes to a route module (reserved for IN-1). */
export type OriginRouteModuleContext = Readonly<Record<string, unknown>>;

export type OriginRouteModuleHandler = (
  request: Request,
  context: OriginRouteModuleContext,
) => Response | Promise<Response>;

/** defineOriginRouteModule({ method, pathname, overridesBuiltIn, handler }). */
export interface OriginRouteModule {
  readonly method: WorkerRouteMethod;
  readonly pathname: string;
  readonly overridesBuiltIn: boolean;
  readonly handler: OriginRouteModuleHandler;
}

/** Context the contributions preamble hands an envelope handler (reserved for IN-1). */
export type ContributionEnvelopeContext = Readonly<Record<string, unknown>>;

/**
 * registerContributionEnvelope(schemaVersion, handler). The handler runs only
 * after the shared preamble (bearer auth, upload-authorization claim,
 * tombstone check, transport floor, receipt).
 */
export type ContributionEnvelopeHandler = (
  body: unknown,
  participant: unknown,
  sourceDeviceId: string,
  claimed: unknown,
  context: ContributionEnvelopeContext,
) => Response | Promise<Response>;

/** One upload-authorization format entry (reserved for IN-1 and IN-3). */
export type UploadAuthorizationFormat = Readonly<Record<string, unknown>>;

/** createUploadAuthorizationFormats(map): telemetrySchemaVersion to format. */
export type UploadAuthorizationFormats = ReadonlyMap<string, UploadAuthorizationFormat>;
