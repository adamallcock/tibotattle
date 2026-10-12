// GENERATED FILE. Do not edit by hand.
//
// The GCP-only vocabularies, derived from the analytics kernels vendored at the
// commit below by apps/worker/scripts/analytics-kernel-vocabularies.mjs and
// written by apps/worker/scripts/vendor-analytics-kernels.mjs whenever it
// vendors. apps/worker/scripts/vendor-analytics-kernels.check.mjs fails when
// this file differs from what the vendored tree gives, and
// analytics-v2-test/kernel-vocabularies.spec.ts fails when a GCP copy (the
// analytics-v2 contract or the primary 0059 CHECK sets) differs from it.
// Schema: analytics-kernel-vocabularies-v1.

/** The production commit the vocabularies were derived from (MANIFEST.json sourceCommit). */
export const KERNEL_VOCABULARIES_SOURCE_COMMIT = "62ad218f1991e1b4fd36cd1938491ae4b5e1ce8a" as const;

/** Model history dates in the allowance preview: admin-community-allowance.ts ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS. */
export const KERNEL_MODEL_DATES = 70 as const;

/** Every reason the vendored Worker sources construct a SharedAnalyticsUnavailable with, in order of first appearance. */
export const KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS = Object.freeze([
  "invalid_day",
  "source_conflict_or_order",
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
  "usage_window_unrepresentable",
  "incomplete_cache_day",
  "incomplete_cache_lookback",
] as const);

/**
 * The CacheRetentionRefusedError reasons constructed by the vendored code the reviewed facade
 * (entry.ts) reaches, in vendored source order: the constructions left in its tree-shaken bundle.
 */
export const KERNEL_CACHE_RETENTION_REFUSAL_REASONS = Object.freeze([
  "session_limit_exceeded",
  "group_limit_exceeded",
] as const);

/** The cache continuity bands, in order: cache-retention-values.ts CACHE_RETENTION_BAND_IDS. */
export const KERNEL_CACHE_RETENTION_BAND_IDS = Object.freeze([
  "under_one_minute",
  "one_to_two_minutes",
  "two_to_five_minutes",
  "five_to_ten_minutes",
  "ten_to_thirty_minutes",
  "thirty_minutes_to_one_hour",
  "one_to_two_hours",
  "two_to_six_hours",
  "six_to_twenty_four_hours",
  "over_twenty_four_hours",
] as const);

/** The band counters in CacheRetentionBandCounters declaration order, snake_cased as the stored columns are. */
export const KERNEL_CACHE_BAND_COUNTERS = Object.freeze([
  "adjacencies",
  "reused_more_than_half",
  "matched_or_exceeded",
  "unordered_ties",
  "excluded_insufficient_evidence",
  "excluded_context_contracted",
  "sessions",
] as const);

/** The community daily read's schemaVersion in the commit's apps/worker/src/index.ts (not vendored). */
export const KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION = "community-daily-read-v1.0" as const;
