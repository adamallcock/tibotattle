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
export const ANALYTICS_V2_CONTRACT_VERSION = "analytics-v2-contract-v0.6" as const;

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
  // K-STAMP (staged migration analytics_v2_run_stamps): kernel-registry.json's copy.
  kernels: "analytics_v2_kernels",
  // K-PERCARD (staged migration analytics_v2_price_cards): per-card price
  // staleness. Each kernel's cards and compute class, the deduplicated price
  // bases, each owner-day's price basis and stored price inputs, and the
  // kernel transitions with the owner-days they make stale.
  kernelPrices: "analytics_v2_kernel_prices",
  priceCards: "analytics_v2_price_cards",
  kernelCards: "analytics_v2_kernel_cards",
  priceBases: "analytics_v2_price_bases",
  ownerDayPrice: "analytics_v2_owner_day_price",
  kernelTransitions: "analytics_v2_kernel_transitions",
  transitionStale: "analytics_v2_transition_stale",
  // E-OWNERSET (staged migration analytics_v2_owner_sets): each published
  // day's saved owner set S(d), its members' versioned contributions, and the
  // frozen-window bootstrap receipt (owner-set-contract below).
  dailyOwnerSets: "analytics_v2_daily_owner_sets",
  dailyContributions: "analytics_v2_daily_contributions",
  ownerSetBootstrap: "analytics_v2_daily_owner_set_bootstrap",
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
    "refusals", "publication", "timings", "kernel_id", "manifest_version", "compatibility_sha256",
    "exclusions_sha256",
  ] as const),
  ownerDay: Object.freeze(["owner_digest", "day", "daily", "refusal", "run_id", "kernel_id", "manifest_version"] as const),
  cacheBands: Object.freeze([
    "owner_digest", "day", "model", "effort", "band", ...ANALYTICS_V2_CACHE_BAND_COUNTERS, "run_id",
    "kernel_id", "manifest_version",
  ] as const),
  ownerFits: Object.freeze(["owner_digest", "as_of_day", "fits", "run_id", "kernel_id", "manifest_version"] as const),
  ownerModelDates: Object.freeze(["owner_digest", "day", "result", "run_id", "kernel_id", "manifest_version"] as const),
  publishedDaily: Object.freeze([
    "day", "revision", "released_at", "payload", "payload_sha256", "run_id", "kernel_id", "manifest_version",
  ] as const),
  preview: Object.freeze(["id", "preview", "computed_at", "run_id", "kernel_id", "manifest_version"] as const),
  journalCursor: Object.freeze(["id", "last_sequence", "run_id"] as const),
  kernels: Object.freeze([
    "kernel_id", "production_commit", "vendor_manifest_sha256", "compute_closure_sha256",
    "price_registry_sha256", "price_registry_version", "method_version", "registered_at",
  ] as const),
  kernelPrices: Object.freeze([
    "kernel_id", "compute_sha256", "cards_sha256", "cards", "projection_version", "registered_at",
  ] as const),
  priceCards: Object.freeze(["card_ref", "card_id", "content_sha256", "first_kernel_id"] as const),
  kernelCards: Object.freeze(["kernel_id", "card_ref", "card_id"] as const),
  priceBases: Object.freeze(["price_basis_id", "basis_sha256", "card_refs"] as const),
  ownerDayPrice: Object.freeze([
    "owner_digest", "day", "price_basis_id", "usage_events", "unpriced_events", "partially_priced_events",
    "projection_version", "codec", "inputs", "inputs_sha256", "input_events", "run_id", "kernel_id", "manifest_version",
  ] as const),
  kernelTransitions: Object.freeze([
    "transition_id", "from_kernel", "to_kernel", "compute_equal", "proof_holds", "compatible", "cards_added",
    "cards_removed", "cards_changed", "owner_days", "events", "stale_owner_days", "proof_run", "recorded_at",
  ] as const),
  transitionStale: Object.freeze(["transition_id", "owner_digest", "day", "cause"] as const),
  dailyOwnerSets: Object.freeze([
    "day", "owner_digest", "first_revision", "provenance", "run_id", "kernel_id", "manifest_version",
  ] as const),
  dailyContributions: Object.freeze([
    "day", "owner_digest", "version", "evidence_fp", "daily_values", "values_schema", "values_sha256",
    "stable_values_sha256", "devices", "price_basis_id", "price_kernel_id", "first_revision", "run_id",
    "kernel_id", "manifest_version",
  ] as const),
  ownerSetBootstrap: Object.freeze([
    "day", "provenance", "set_size", "frozen_participants", "frozen_export_sha256", "frozen_from_day",
    "frozen_through_day", "first_revision", "run_id", "kernel_id", "manifest_version",
  ] as const),
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
  kernels: Object.freeze(["kernel_id"] as const),
  kernelPrices: Object.freeze(["kernel_id"] as const),
  priceCards: Object.freeze(["card_ref"] as const),
  kernelCards: Object.freeze(["kernel_id", "card_ref"] as const),
  priceBases: Object.freeze(["price_basis_id"] as const),
  ownerDayPrice: Object.freeze(["owner_digest", "day"] as const),
  kernelTransitions: Object.freeze(["transition_id"] as const),
  transitionStale: Object.freeze(["transition_id", "owner_digest", "day"] as const),
  dailyOwnerSets: Object.freeze(["day", "owner_digest"] as const),
  dailyContributions: Object.freeze(["day", "owner_digest", "version"] as const),
  ownerSetBootstrap: Object.freeze(["day"] as const),
} as const satisfies Record<AnalyticsV2TableKey, readonly string[]>);

/**
 * The offline owner purge's analytics_v2 inventory: every table that holds
 * an owner's rows, keyed by its owner_digest column, in the order the purge
 * deletes them (a contribution before its set row, which it references). The
 * running service never removes an owner (owner decision D2, Variant B): it
 * replaces only a computed owner's derived rows inside the run's horizon
 * (store-derived.ts), and never deletes a saved set or contribution. The
 * purge (PURGE-1, owner tooling) names the owner in the offline-purge session
 * setting the owner-sets migration's trigger reads, for the saved-set tables,
 * then republishes the affected days over the smaller set (owner decision
 * round 7). K-PERCARD's price tables hold owners too: an owner-day's price
 * row leaves with its owner-day (ON DELETE CASCADE) and is listed before it,
 * and the append-only stale set is removed by the exact statements the
 * price-cards migration records for the purge. The online-erasure absence
 * gate fails when a running service module names that setting or deletes
 * from a saved-set table. A spec compares this list with the migrated
 * catalog: an analytics_v2 table with an owner_digest column that is not
 * listed fails it.
 */
export const ANALYTICS_V2_OWNER_SCOPED_TABLES = Object.freeze([
  "transitionStale",
  "ownerDayPrice",
  "ownerDay",
  "cacheBands",
  "ownerFits",
  "ownerModelDates",
  "dailyContributions",
  "dailyOwnerSets",
] as const satisfies readonly AnalyticsV2TableKey[]);

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
  // Fast-path routing and scope.
  "non_effective_source_unported",
  "usage_window_unrepresentable",
  "day_occurrences_exceeded",
  "source_conflict_or_order",
  // GCP resource guard (resources.ts): an effective owner whose deterministic
  // memory estimate exceeds the run's budget. Owner and daily families only.
  "memory_budget",
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

/**
 * Reasons that belong to the "cache" family only. evaluateSharedCacheDay is
 * the sole source of CacheRetentionRefusedError, so these never replace an
 * owner-day's prepared daily values.
 */
export const ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS = Object.freeze([
  "group_limit_exceeded",
  "session_limit_exceeded",
] as const satisfies readonly AnalyticsV2RefusalReason[]);

/**
 * Reasons that refuse a whole effective owner before it is read
 * (resources.ts). Such an owner is not computed: it writes no owner-scoped
 * row, so these never reach analytics_v2_owner_day either, and its stored
 * rows from earlier runs are retained.
 */
export const ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS = Object.freeze([
  "memory_budget",
] as const satisfies readonly AnalyticsV2RefusalReason[]);

/**
 * The closed reasons analytics_v2_owner_day.refusal may hold: every reason
 * except the cache-only and owner-only ones. Primary migration 0059's CHECK
 * lists exactly these; the store refuses any other owner-day reason before
 * writing.
 */
export const ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS: readonly AnalyticsV2RefusalReason[] = Object.freeze(
  ANALYTICS_V2_REFUSAL_REASONS.filter((reason) =>
    !(ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS as readonly string[]).includes(reason)
    && !(ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS as readonly string[]).includes(reason)),
);

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

/**
 * analytics_v2_owner_day_price (K-PERCARD): one owner-day's price attribution,
 * one-to-one with its owner-day row that has daily values (price-attribution
 * .ts). The store maps cardIds to the kernel's card refs and a deduplicated
 * price basis.
 */
export interface AnalyticsV2OwnerDayPriceRow {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly day: AnalyticsV2Day;
  /** The price basis: every card id any event's pricing selected, sorted, unique. */
  readonly cardIds: readonly string[];
  readonly usageEvents: number;
  /** Unpriced and unshapeable events (the daily fold's unpriced count). */
  readonly unpricedEvents: number;
  readonly partiallyPricedEvents: number;
  /** The stored price inputs: each event's projection and this kernel's result. */
  readonly inputs: {
    readonly projectionVersion: string;
    readonly codec: string;
    /** sha256 of the canonical document text. */
    readonly sha256: string;
    readonly events: number;
    /** The deflated document, base64. */
    readonly data: string;
  };
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
 * Saved owner sets (E-OWNERSET, engine v2 design section 6.2; owner decision
 * round 2: past contributions are kept). A published day d folds its saved
 * set S(d) plus every computed owner with non-empty daily values on d:
 * - "computed": an owner this run computed, with non-empty values on d; it
 *   folds those values and its device count. When it is not yet in S(d) the
 *   publication adds it; when its values or devices differ from its current
 *   contribution, a new contribution version is appended;
 * - "retained": a computed member of S(d) whose read for d is empty: it folds
 *   its current contribution (never a zero), counted as
 *   contributionRetainedEvidenceAbsent;
 * - "saved": a member of S(d) this run did not compute (disconnected, opted
 *   out, not ported, refused by the memory budget): it folds its current
 *   contribution;
 * - "excluded": a member of S(d) with an active community aggregate exclusion
 *   on d (N-EXCL): it stays in S(d) and folds nothing. A member that left the
 *   roster is excluded through its owner link in any state (the reader maps
 *   it), so leaving never undoes an exclusion.
 * A member whose current contribution cannot be folded under the run's
 * kernel (its values schema or price identity is not current; K-REPRICE
 * reprices them after cutover) blocks the day instead
 * (memberContributionUnavailableDays), and so does a member the run did not
 * compute whose owner link no longer exists, since its exclusions cannot be
 * read (memberLinkUnavailableDays): never a zero, never dropped, never
 * folded without its exclusions.
 */
export const ANALYTICS_V2_DAILY_MEMBER_ORIGINS = Object.freeze(["computed", "retained", "saved", "excluded"] as const);
export type AnalyticsV2DailyMemberOrigin = (typeof ANALYTICS_V2_DAILY_MEMBER_ORIGINS)[number];

/**
 * One member of a candidate day's owner set after its publication. `values`
 * and `devices` are the computed member's fresh fold inputs (null for the
 * others, whose stored contribution is folded or, excluded, nothing).
 * `savedVersion` is the contribution version the fold read for a retained or
 * saved member (null for computed and excluded members): the store refuses
 * the run when it is no longer the member's current version.
 */
export interface AnalyticsV2DailyMember {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly origin: AnalyticsV2DailyMemberOrigin;
  readonly values: AnalyticsV2KernelValue | null;
  readonly devices: number | null;
  readonly savedVersion: number | null;
}

/**
 * analytics_v2_daily_owner_sets.provenance and the day receipt's (see the
 * staged owner-sets migration).
 */
export const ANALYTICS_V2_OWNER_SET_PROVENANCE = Object.freeze({
  /** Recorded at GCP's first publication of a day outside the frozen window, or added to an existing set. */
  published: 1,
  /** The participants at GCP's first publication of a frozen-window day, counted equal to Cloudflare's. */
  cutoverVerified: 2,
  /** The same, with a different count or no Cloudflare publication of the day (disclosed). */
  cutoverDisclosed: 3,
  /**
   * Adopted: first recorded while the day already had a published head (an
   * unrecorded head, published by an image without saved owner sets). Owners
   * that left before the recording are not in it; no frozen comparison.
   */
  adopted: 4,
} as const);
export type AnalyticsV2OwnerSetProvenance =
  (typeof ANALYTICS_V2_OWNER_SET_PROVENANCE)[keyof typeof ANALYTICS_V2_OWNER_SET_PROVENANCE];

/**
 * How a day's set begins: the first recording of a day without a receipt,
 * and the receipt row it writes. Provenance 2 or 3 (owner decision round 7:
 * the participants at GCP's first publication of a frozen-window day,
 * compared with the frozen Cloudflare export's contributingParticipants and
 * disclosed when they differ) carries the export's digest and window, so a
 * later run knows the window without the export; 1 and 4 carry none.
 */
export interface AnalyticsV2OwnerSetBootstrap {
  readonly provenance: AnalyticsV2OwnerSetProvenance;
  /** 2 and 3: the frozen export's contributingParticipants for the day (null when it did not publish it). */
  readonly frozenParticipants: number | null;
  /** 2 and 3: the frozen export's digest and window; null for 1 and 4. */
  readonly frozenExportSha256: string | null;
  readonly frozenFromDay: AnalyticsV2Day | null;
  readonly frozenThroughDay: AnalyticsV2Day | null;
}

/**
 * A computed community daily payload for a queued day. A-3 publishes it only
 * when payloadSha256 differs from the stored row: revision =
 * max(previous, revisionSeed) + 1 and released_at = nowMs. A publication
 * also records the day's owner set (`members`, in owner-digest order) and
 * its contributions. `bootstrap` is non-null exactly when the day has no
 * recorded set (no receipt): it is the first recording. An unchanged
 * candidate records nothing, except an unrecorded head's adoption
 * (provenance 4), which records its set at the head's revision.
 */
export interface AnalyticsV2DailyCandidate {
  readonly day: AnalyticsV2Day;
  readonly payload: AnalyticsV2KernelValue;
  readonly payloadSha256: string;
  readonly members: readonly AnalyticsV2DailyMember[];
  readonly bootstrap: AnalyticsV2OwnerSetBootstrap | null;
}

/**
 * A member of a day's saved set as the read snapshot holds it (A-1
 * owner-sets.ts readAnalyticsV2OwnerSetState): its current contribution's
 * version, device count and values digest, and the participant its owner
 * link names in any state (the run maps the member's community aggregate
 * exclusions through it, on or off the roster); null when no owner link row
 * remains. The values themselves are loaded only for the members a fold
 * needs them for.
 */
export interface AnalyticsV2SavedMember {
  readonly version: number;
  readonly devices: number;
  readonly valuesSha256: string;
  readonly participantId: string | null;
}

/**
 * One queued day's saved set; whether the day's set is recorded (its receipt
 * exists); and whether the day has a published head (a head without a
 * receipt is unrecorded, and its first recording is an adoption).
 */
export interface AnalyticsV2SavedDay {
  readonly members: ReadonlyMap<AnalyticsV2OwnerDigest, AnalyticsV2SavedMember>;
  readonly recorded: boolean;
  readonly headPublished: boolean;
}

/**
 * The frozen Cloudflare export's per-day contributingParticipants (C-IPR),
 * over its whole window [fromDay, throughDay]; a window day it did not
 * publish has no entry.
 */
export interface AnalyticsV2FrozenParticipants {
  readonly exportSha256: string;
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
  readonly participants: ReadonlyMap<AnalyticsV2Day, number>;
}

/**
 * The owner-set state a run folds with: every queued day's saved set (a day
 * without one maps to an empty set) and, when some unrecorded queued day
 * without a head lies inside the frozen window, the frozen counts (otherwise
 * null).
 */
export interface AnalyticsV2OwnerSetState {
  readonly days: ReadonlyMap<AnalyticsV2Day, AnalyticsV2SavedDay>;
  readonly frozen: AnalyticsV2FrozenParticipants | null;
}

/** One stored contribution to load: a member's version of one day. */
export interface AnalyticsV2ContributionKey {
  readonly day: AnalyticsV2Day;
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly version: number;
}

/**
 * The run's owner-set outcome (content-free counts and days), recorded in
 * analytics_v2_runs.publication.ownerSets and the Job receipt.
 */
export interface AnalyticsV2OwnerSetSummary {
  /** Candidate-day folds of a computed member's retained contribution (its read for the day was empty). */
  readonly contributionRetainedEvidenceAbsent: number;
  /** Candidate-day folds of a saved member this run did not compute. */
  readonly savedMembersFolded: number;
  /** Queued days blocked because a member's contribution could not be folded (member_contribution_unavailable). */
  readonly memberContributionUnavailableDays: readonly AnalyticsV2Day[];
  /**
   * Queued days blocked because a member the run did not compute has no owner
   * link row, so its exclusions cannot be read (member_link_unavailable).
   */
  readonly memberLinkUnavailableDays: readonly AnalyticsV2Day[];
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
  /** What the published days recorded in their owner sets (E-OWNERSET). */
  readonly ownerSets: AnalyticsV2OwnerSetWriteSummary;
}

/** The owner-set rows one run's publications appended (counts and days only). */
export interface AnalyticsV2OwnerSetWriteSummary extends AnalyticsV2OwnerSetSummary {
  readonly membersAdded: number;
  readonly contributionVersions: number;
  /** Days whose set this run recorded first (a receipt each), of any provenance. */
  readonly daysRecorded: number;
  /** Frozen-window days whose set this run recorded first, by provenance (2, 3). */
  readonly bootstrapVerifiedDays: readonly AnalyticsV2Day[];
  readonly bootstrapDisclosedDays: readonly AnalyticsV2Day[];
  /** Unrecorded heads this run adopted (provenance 4), unchanged or republished. */
  readonly bootstrapAdoptedDays: readonly AnalyticsV2Day[];
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
  /** One per ownerDays row with daily values, in the same order (K-PERCARD). */
  readonly ownerDayPrices: readonly AnalyticsV2OwnerDayPriceRow[];
  readonly cacheBands: readonly AnalyticsV2CacheBandRow[];
  readonly ownerFits: readonly AnalyticsV2OwnerFitsRow[];
  readonly ownerModelDates: readonly AnalyticsV2OwnerModelDateRow[];
  readonly dailyCandidates: readonly AnalyticsV2DailyCandidate[];
  readonly blockedDays: readonly AnalyticsV2Day[];
  /** The fold's owner-set outcome (E-OWNERSET). */
  readonly ownerSets: AnalyticsV2OwnerSetSummary;
  /**
   * The admin community allowance preview (v0.3), or null when it is withheld
   * (an effective owner without a current fits result) or cannot be built.
   */
  readonly preview: AnalyticsV2KernelValue | null;
  readonly refusals: readonly AnalyticsV2Refusal[];
  readonly journal: { readonly lastSequence: number | null };
  readonly timings: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
  /**
   * The run's resource configuration and one entry per effective owner, in
   * owner-digest order. Recorded in analytics_v2_runs.timings (keys
   * `resources` and `owners`). Optional for callers that compute no owner.
   */
  readonly resources?: AnalyticsV2RunResources;
}

/** analytics_v2_runs.timings.resources: the bounds one run applied. */
export interface AnalyticsV2ResourceConfiguration {
  readonly memoryModel: string;
  readonly outputModel: string;
  readonly memoryBudgetBytes: number;
  readonly maxDayOccurrences: number;
  readonly maxDayRecordBytes: number;
  readonly outputBudgetBytes: number;
}

/**
 * analytics_v2_runs.timings.owners[]: one effective owner's evidence size and
 * memory figures. Counts, the estimate and outputBytes (what the owner's rows
 * and refusals charged to the output account) are deterministic;
 * heapPeakBytes is the largest heap-in-use sample taken while computing the
 * owner (null when no probe was supplied or the owner was refused) and is
 * operational metadata only, never an input to a decision.
 */
export interface AnalyticsV2OwnerResources {
  readonly ownerDigest: AnalyticsV2OwnerDigest;
  readonly usage: number;
  readonly quota: number;
  readonly session: number;
  readonly analysisUsage: number;
  readonly maxDayOccurrences: number;
  readonly estimateBytes: number;
  readonly admitted: boolean;
  readonly heapPeakBytes: number | null;
  readonly outputBytes: number;
}

/**
 * analytics_v2_runs.timings.account: the run's output account when compute
 * finished. heldInputBytes is the non-effective owners' held queued-day
 * occurrences; accountBytes is everything charged (it includes them);
 * outputBudgetBytes is the budget the account was held to: the configured
 * output budget, or, when the run reclaimed the unused per-owner budget,
 * that plus the memory budget less the largest admitted estimate
 * (resources.ts analyticsV2OutputBudget).
 */
export interface AnalyticsV2OutputAccount {
  readonly heldInputBytes: number;
  readonly accountBytes: number;
  readonly outputBudgetBytes: number;
}

export interface AnalyticsV2RunResources {
  readonly configuration: AnalyticsV2ResourceConfiguration;
  readonly owners: readonly AnalyticsV2OwnerResources[];
  readonly account: AnalyticsV2OutputAccount;
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

/**
 * The built-in origin routes a registered module may override. Each is an
 * exact WORKER_ROUTE_POLICY path, and the list equals the runtime list in
 * cloud-run/origin-route-modules.mjs (checked by origin-route-modules.check.mjs).
 */
export const ORIGIN_OVERRIDABLE_BUILT_INS = Object.freeze([
  "/api/v1/community/daily",
  "/api/v1/device/upload-authorizations",
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

/**
 * One upload-authorization format entry (IN-1 and IN-3): it throws the
 * origin's existing refusal when the authenticated device may not upload
 * this format.
 */
export interface UploadAuthorizationFormat {
  readonly assertUploadAllowed: (
    pool: unknown,
    device: unknown,
    nowEpoch: number,
    options: Readonly<{ schema: unknown }>,
  ) => unknown;
}

/** The table createUploadAuthorizationFormats accepts: telemetrySchemaVersion to format. */
export type UploadAuthorizationFormatTable =
  | ReadonlyMap<string, UploadAuthorizationFormat>
  | Readonly<Record<string, UploadAuthorizationFormat>>;

/** What createUploadAuthorizationFormats(table) returns: a frozen resolver, not a Map. */
export interface UploadAuthorizationFormats {
  readonly telemetrySchemaVersions: readonly string[];
  readonly has: (telemetrySchemaVersion: unknown) => boolean;
  readonly resolve: (telemetrySchemaVersion: unknown) => UploadAuthorizationFormat | null;
}
