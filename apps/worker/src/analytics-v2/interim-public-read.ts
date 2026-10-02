/**
 * Interim frozen public read (owner decision OD-10, stream C-IPR).
 *
 * Between the edge switch and the first GCP publication, GET
 * /api/v1/community/daily answers from one FROZEN copy of the Cloudflare
 * production response, captured read-only just before the seal. This module owns every
 * rule about that copy and holds no I/O:
 *
 * - the export format the owner takes (OWN-4): the exact body of
 *   GET /api/v1/community/daily?from=<to-365 days>&to=<seal day> on the
 *   production Worker, saved byte for byte, with its sha256, the capture
 *   instant, the production source commit and the evidence date;
 * - the closed validation of that body against the community-daily-read-v1.0
 *   contract (the fields production's typed-storage handler emits, and
 *   nothing else), with the sha256 pin enforced on the exact bytes;
 * - the per-request projection of the frozen days onto a requested range;
 * - the labelling (see INTERIM_PUBLIC_READ_HEADERS).
 *
 * Labelling stays inside the closed contract. The JSON body is the frozen
 * Cloudflare body, projected, with no field added: every day keeps the
 * revision, releasedAt and aggregateId Cloudflare published, so the body
 * itself dates each day. The evidence date and the provenance travel in
 * response headers, which the thin edge passes through unchanged.
 *
 * The frozen body is served verbatim, never recomputed. In particular its
 * allowance breakdowns, spend blocks and cache series are what Cloudflare's
 * release published at the capture instant, so they are validated for shape
 * and internal consistency only, never against this line's vendored kernels
 * or reviewed catalogs (production's release is newer than d43c8f92).
 *
 * Content-free by construction: every string in the contract is a calendar
 * day, an instant, a digest or a closed token, so no field can carry content.
 * Errors carry a closed code and a structural path, never a value.
 *
 * This file has no imports and only erasable TypeScript syntax, so the loader
 * script can load it under plain Node type stripping and the Worker bundles
 * it unchanged.
 */

export const INTERIM_PUBLIC_READ_SCHEMA_VERSION = "community-daily-read-v1.0" as const;
export const INTERIM_PUBLIC_READ_TABLE = "community_daily_frozen_export" as const;
export const INTERIM_PUBLIC_READ_ROW_ID = 1 as const;
/** The export, as bytes. Equal to the table's octet_length CHECK. */
export const INTERIM_PUBLIC_READ_MAX_BYTES = 8 * 1024 * 1024;
/** The export always covers the full year window the public client asks for. */
export const INTERIM_PUBLIC_READ_WINDOW_DAYS = 366;

/**
 * How the evidence date is conveyed without touching the closed body:
 * - marker: the constant `frozen`; its presence means the answer is the
 *   interim copy, and it is absent from every other answer;
 * - evidenceDate: the UTC day the frozen window ends on (YYYY-MM-DD);
 * - sha256: the sha256 of the pinned export, for matching the seal receipt;
 * - lastModified: the capture instant as an HTTP date.
 */
export const INTERIM_PUBLIC_READ_HEADERS = Object.freeze({
  marker: "x-tibotattle-interim-read",
  evidenceDate: "x-tibotattle-evidence-date",
  sha256: "x-tibotattle-interim-sha256",
  lastModified: "last-modified",
} as const);
export const INTERIM_PUBLIC_READ_MARKER_VALUE = "frozen" as const;

export const INTERIM_PUBLIC_READ_ERROR_CODES = Object.freeze([
  "INTERIM_PUBLIC_READ_EXPORT_SIZE_INVALID",
  "INTERIM_PUBLIC_READ_EXPORT_ENCODING_INVALID",
  "INTERIM_PUBLIC_READ_EXPORT_NOT_JSON",
  "INTERIM_PUBLIC_READ_PIN_INVALID",
  "INTERIM_PUBLIC_READ_SHA256_MISMATCH",
  "INTERIM_PUBLIC_READ_METADATA_INVALID",
  "INTERIM_PUBLIC_READ_CONTRACT_INVALID",
  "INTERIM_PUBLIC_READ_EVIDENCE_INCONSISTENT",
  "INTERIM_PUBLIC_READ_ROW_INVALID",
] as const);
export type InterimPublicReadErrorCode = (typeof INTERIM_PUBLIC_READ_ERROR_CODES)[number];

export class InterimPublicReadError extends Error {
  readonly code: InterimPublicReadErrorCode;
  /** A structural path such as `days[3].payload.totals`; never a value. */
  readonly detail: string | null;

  constructor(code: InterimPublicReadErrorCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "InterimPublicReadError";
    this.code = code;
    this.detail = detail;
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LOOSE_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
/** Model and provider identifiers. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
/** Contract, method, basis and gate names. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,159}$/u;
const PRICING_VERSION_PATTERN = /^server-api-price-equivalent-v\d+\.\d+$/u;
const PROCESSING_POLICY_PATTERN = /^daily-spend-capacity-[1-9]\d{0,5}-chunks-[1-9]\d{0,8}-events$/u;
const CACHE_METHOD_PATTERN = /^cache-retention-v[1-9]\d{0,2}$/u;
const MILLISECONDS_PER_DAY = 86_400_000;
/** The breakdown generation may lead the capture clock by this much (the client's own skew). */
const GENERATED_AT_SKEW_MILLISECONDS = 5 * 60 * 1000;

const TOTAL_FIELDS = Object.freeze([
  "contributingParticipants", "contributingDevices", "usageEvents", "quotaObservations",
  "sessionDimensions", "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
] as const);
const CELL_COUNT_FIELDS = Object.freeze([
  "usageEvents", "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
] as const);
const MAX_CELLS_PER_DAY = 512;
const MAX_BREAKDOWN_DAYS = 70;
const MAX_BREAKDOWN_MODELS = 64;
const MAX_CACHE_MODELS = 64;

const BREAKDOWN_VERSIONS: Readonly<Record<string, { readonly combined: boolean; readonly plans: readonly string[] }>> =
  Object.freeze({
    "community-allowance-breakdowns-v1.0": Object.freeze({ combined: false, plans: Object.freeze(["pro", "prolite", "plus"]) }),
    "community-allowance-breakdowns-v1.1": Object.freeze({ combined: true, plans: Object.freeze(["pro", "prolite", "plus"]) }),
    "community-allowance-breakdowns-v1.2": Object.freeze({ combined: true, plans: Object.freeze(["pro", "prolite", "promax", "plus"]) }),
  });

const CACHE_BANDS = Object.freeze([
  ["under_one_minute", 0, 60_000],
  ["one_to_two_minutes", 60_000, 120_000],
  ["two_to_five_minutes", 120_000, 300_000],
  ["five_to_ten_minutes", 300_000, 600_000],
  ["ten_to_thirty_minutes", 600_000, 1_800_000],
  ["thirty_minutes_to_one_hour", 1_800_000, 3_600_000],
  ["one_to_two_hours", 3_600_000, 7_200_000],
  ["two_to_six_hours", 7_200_000, 21_600_000],
  ["six_to_twenty_four_hours", 21_600_000, 86_400_000],
  ["over_twenty_four_hours", 86_400_000, 604_800_000],
] as const);
const CACHE_WINDOWS = Object.freeze([
  ["day", 1], ["week", 7], ["month", 30], ["all", null],
] as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated day exactly as the export carried it. */
export interface FrozenDay {
  readonly day: string;
  readonly revision: number;
  readonly releasedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FrozenBreakdownDay {
  readonly day: string;
  readonly [key: string]: unknown;
}

/** A validated allowance breakdowns block exactly as the export carried it. */
export interface FrozenBreakdowns {
  readonly days: readonly FrozenBreakdownDay[];
  readonly [key: string]: unknown;
}

/** The validated community-daily-read-v1.0 body of the export. */
export interface FrozenCommunityDaily {
  readonly from: string;
  readonly to: string;
  readonly allowanceState: "ready" | "updating";
  readonly allowanceReadState: "confirmed" | "temporarily_unavailable";
  readonly allowanceBreakdowns: FrozenBreakdowns | null;
  readonly cacheRetention: unknown;
  readonly days: readonly FrozenDay[];
}

/** What the loader records and the route verifies, field for field. */
export interface InterimPublicReadRecord {
  /** The exact export text; its UTF-8 bytes are what payloadSha256 digests. */
  readonly payloadText: string;
  readonly payloadSha256: string;
  /** Canonical `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  readonly capturedAt: string;
  readonly sourceCommit: string;
  /** `YYYY-MM-DD`: the day the frozen window ends on. */
  readonly evidenceDate: string;
}

export interface VerifiedInterimPublicRead {
  readonly record: InterimPublicReadRecord;
  readonly frozen: FrozenCommunityDaily;
}

/** Content-free facts about a validated export, for receipts. */
export interface InterimPublicReadSummary {
  readonly bytes: number;
  readonly from: string;
  readonly to: string;
  readonly dayCount: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
  readonly latestReleasedAt: string | null;
  readonly allowanceState: "ready" | "updating";
  readonly allowanceReadState: "confirmed" | "temporarily_unavailable";
  readonly breakdownsSchemaVersion: string | null;
  readonly breakdownDayCount: number;
  readonly cacheRetentionPresent: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function contractInvalid(path: string): never {
  throw new InterimPublicReadError("INTERIM_PUBLIC_READ_CONTRACT_INVALID", path);
}

function inconsistent(path: string): never {
  throw new InterimPublicReadError("INTERIM_PUBLIC_READ_EVIDENCE_INCONSISTENT", path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A closed object: every required key present and no key outside required and
 * optional. An unknown key is reported as `path.*` so no key text is echoed.
 */
function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) contractInvalid(path);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) contractInvalid(`${path}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) contractInvalid(`${path}.*`);
  }
  return value;
}

function exactString(value: unknown, path: string, expected: string): void {
  if (value !== expected) contractInvalid(path);
}

function patternString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) contractInvalid(path);
  return value;
}

function safeCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) contractInvalid(path);
  return value;
}

function positiveFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) contractInvalid(path);
  return value;
}

function boundedArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) contractInvalid(path);
  return value;
}

function calendarDay(value: unknown, path: string): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) contractInvalid(path);
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) contractInvalid(path);
  return value;
}

function instantMilliseconds(value: unknown, path: string): number {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) contractInvalid(path);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) contractInvalid(path);
  return epoch;
}

function dayEpoch(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function addDays(day: string, days: number): string {
  return new Date(dayEpoch(day) + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The day payload (production community-daily-aggregate-v1.0 as served)
// ---------------------------------------------------------------------------

function validateTotals(value: unknown, path: string): Record<string, number> {
  const totals = closedObject(value, path, TOTAL_FIELDS);
  const counts: Record<string, number> = {};
  for (const field of TOTAL_FIELDS) counts[field] = safeCount(totals[field], `${path}.${field}`);
  return counts;
}

function validateCell(value: unknown, path: string): void {
  const cell = closedObject(value, path, ["provider", "modelId", ...CELL_COUNT_FIELDS]);
  patternString(cell.provider, `${path}.provider`, ID_PATTERN);
  patternString(cell.modelId, `${path}.modelId`, ID_PATTERN);
  for (const field of CELL_COUNT_FIELDS) safeCount(cell[field], `${path}.${field}`);
}

/**
 * The spend block as production serves it: the daily spend contract the site
 * reads (basis, USD, counts that sum to the day's usage events, coverage that
 * follows from them). The registry and method are only shape-checked.
 */
function validateSpend(value: unknown, path: string, usageEvents: number): void {
  const spend = closedObject(value, path, [
    "basis", "currency", "knownCostUsd", "coverage", "usageEvents", "fullyPricedUsageEvents",
    "partiallyPricedUsageEvents", "unpricedUsageEvents", "pricingMethodVersion", "registrySha256",
  ], ["unprocessedUsageEvents", "unavailableReason", "processingPolicyVersion"]);
  exactString(spend.basis, `${path}.basis`, "reported_usage_event_time_api_price_equivalent_v1");
  exactString(spend.currency, `${path}.currency`, "USD");
  patternString(spend.pricingMethodVersion, `${path}.pricingMethodVersion`, PRICING_VERSION_PATTERN);
  patternString(spend.registrySha256, `${path}.registrySha256`, SHA256_PATTERN);
  const events = safeCount(spend.usageEvents, `${path}.usageEvents`);
  const full = safeCount(spend.fullyPricedUsageEvents, `${path}.fullyPricedUsageEvents`);
  const partial = safeCount(spend.partiallyPricedUsageEvents, `${path}.partiallyPricedUsageEvents`);
  const unpriced = safeCount(spend.unpricedUsageEvents, `${path}.unpricedUsageEvents`);
  const unprocessed = spend.unprocessedUsageEvents === undefined
    ? 0 : safeCount(spend.unprocessedUsageEvents, `${path}.unprocessedUsageEvents`);
  // Production removes a spend block that disagrees with the day's totals, so
  // a block that survives into an export always agrees with them.
  if (events !== usageEvents || full + partial + unpriced + unprocessed !== events) contractInvalid(path);
  const resourceLimited = unprocessed > 0;
  if (resourceLimited) {
    if (unprocessed !== events) contractInvalid(`${path}.unprocessedUsageEvents`);
    exactString(spend.unavailableReason, `${path}.unavailableReason`, "processing_capacity_exceeded");
    patternString(spend.processingPolicyVersion, `${path}.processingPolicyVersion`, PROCESSING_POLICY_PATTERN);
  } else if (spend.unavailableReason !== undefined || spend.processingPolicyVersion !== undefined
      || spend.unprocessedUsageEvents !== undefined) {
    contractInvalid(path);
  }
  const known = events === 0 || full + partial > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  if (spend.coverage !== coverage) contractInvalid(`${path}.coverage`);
  if (known) {
    const cost = spend.knownCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || (events === 0 && cost !== 0)) {
      contractInvalid(`${path}.knownCostUsd`);
    }
  } else if (spend.knownCostUsd !== null) {
    contractInvalid(`${path}.knownCostUsd`);
  }
}

/**
 * One served day. The key set is production's typed-storage public payload:
 * `capacityByPlanType` (private diagnostic) and the per-day `allowance` block
 * (never current under typed storage) are not in it, so an export carrying
 * either is refused rather than republished.
 */
function validateDay(value: unknown, path: string, window: { from: string; to: string }, capturedAtMs: number): FrozenDay {
  const wrapper = closedObject(value, path, ["day", "revision", "releasedAt", "payload"]);
  const day = calendarDay(wrapper.day, `${path}.day`);
  if (day < window.from || day > window.to) contractInvalid(`${path}.day`);
  const revision = wrapper.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    contractInvalid(`${path}.revision`);
  }
  const releasedAtMs = instantMilliseconds(wrapper.releasedAt, `${path}.releasedAt`);
  if (releasedAtMs > capturedAtMs) inconsistent(`${path}.releasedAt`);
  const payload = closedObject(wrapper.payload, `${path}.payload`, [
    "schemaVersion", "aggregateId", "day", "revision", "releasedAt", "immutableRevision",
    "recomputesOnLateData", "policyVersion", "suppression", "totals", "cellsTruncated", "cells",
  ], ["apiEquivalentSpend"]);
  exactString(payload.schemaVersion, `${path}.payload.schemaVersion`, "community-daily-aggregate-v1.0");
  exactString(payload.policyVersion, `${path}.payload.policyVersion`, "community-daily-v1.0");
  patternString(payload.suppression, `${path}.payload.suppression`, NAME_PATTERN);
  if (payload.immutableRevision !== true) contractInvalid(`${path}.payload.immutableRevision`);
  if (payload.recomputesOnLateData !== true) contractInvalid(`${path}.payload.recomputesOnLateData`);
  if (payload.day !== day) contractInvalid(`${path}.payload.day`);
  if (payload.revision !== revision) contractInvalid(`${path}.payload.revision`);
  if (payload.aggregateId !== `community-daily:${day}:r${revision}`) contractInvalid(`${path}.payload.aggregateId`);
  if (payload.releasedAt !== wrapper.releasedAt) contractInvalid(`${path}.payload.releasedAt`);
  const totals = validateTotals(payload.totals, `${path}.payload.totals`);
  if (typeof payload.cellsTruncated !== "boolean") contractInvalid(`${path}.payload.cellsTruncated`);
  const cells = boundedArray(payload.cells, `${path}.payload.cells`, MAX_CELLS_PER_DAY);
  cells.forEach((cell, index) => validateCell(cell, `${path}.payload.cells[${index}]`));
  if (payload.apiEquivalentSpend !== undefined) {
    validateSpend(payload.apiEquivalentSpend, `${path}.payload.apiEquivalentSpend`, totals.usageEvents ?? 0);
  }
  return { day, revision, releasedAt: wrapper.releasedAt as string, payload };
}

// ---------------------------------------------------------------------------
// Allowance breakdowns (community-allowance-breakdowns-v1.0 to v1.2)
// ---------------------------------------------------------------------------

function validateAllowanceSummary(value: unknown, path: string): void {
  const summary = closedObject(value, path, ["centralUsd", "participantCount", "fitCount", "band80Usd"]);
  const fitCount = safeCount(summary.fitCount, `${path}.fitCount`);
  const participantCount = safeCount(summary.participantCount, `${path}.participantCount`);
  if (participantCount > fitCount) contractInvalid(`${path}.participantCount`);
  if (fitCount === 0) {
    if (participantCount !== 0 || summary.centralUsd !== null || summary.band80Usd !== null) contractInvalid(path);
    return;
  }
  if (participantCount < 1) contractInvalid(`${path}.participantCount`);
  const central = positiveFinite(summary.centralUsd, `${path}.centralUsd`);
  if (summary.band80Usd === null) return;
  if (fitCount < 3) contractInvalid(`${path}.band80Usd`);
  const band = closedObject(summary.band80Usd, `${path}.band80Usd`, ["lowerUsd", "upperUsd"]);
  const lower = positiveFinite(band.lowerUsd, `${path}.band80Usd.lowerUsd`);
  const upper = positiveFinite(band.upperUsd, `${path}.band80Usd.upperUsd`);
  if (lower > central || upper < central) contractInvalid(`${path}.band80Usd`);
}

function validateBreakdowns(
  value: unknown,
  today: string,
  publishedDays: ReadonlySet<string>,
  capturedAtMs: number,
): FrozenBreakdowns {
  const path = "allowanceBreakdowns";
  const breakdowns = closedObject(value, path, [
    "schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis", "modelGate",
    "generatedAt", "days",
  ]);
  const version = typeof breakdowns.schemaVersion === "string"
    && Object.hasOwn(BREAKDOWN_VERSIONS, breakdowns.schemaVersion)
    ? BREAKDOWN_VERSIONS[breakdowns.schemaVersion] : undefined;
  if (version === undefined) contractInvalid(`${path}.schemaVersion`);
  patternString(breakdowns.basis, `${path}.basis`, NAME_PATTERN);
  exactString(breakdowns.referencePlanType, `${path}.referencePlanType`, "pro");
  patternString(breakdowns.normalization, `${path}.normalization`, NAME_PATTERN);
  patternString(breakdowns.modelBasis, `${path}.modelBasis`, NAME_PATTERN);
  patternString(breakdowns.modelGate, `${path}.modelGate`, NAME_PATTERN);
  const generatedAtMs = instantMilliseconds(breakdowns.generatedAt, `${path}.generatedAt`);
  if (generatedAtMs > capturedAtMs + GENERATED_AT_SKEW_MILLISECONDS) inconsistent(`${path}.generatedAt`);
  const generatedDay = (breakdowns.generatedAt as string).slice(0, 10);
  const rows = boundedArray(breakdowns.days, `${path}.days`, MAX_BREAKDOWN_DAYS);
  // Production publishes a graph only with at least one closed day.
  if (rows.length === 0) contractInvalid(`${path}.days`);
  let previous = "";
  rows.forEach((row, index) => {
    const rowPath = `${path}.days[${index}]`;
    const entry = closedObject(row, rowPath,
      version.combined ? ["day", "combined", "byPlanType", "models"] : ["day", "byPlanType", "models"]);
    const day = calendarDay(entry.day, `${rowPath}.day`);
    if (day <= previous) contractInvalid(`${rowPath}.day`);
    previous = day;
    // Only closed, published days: the projection's own rule, with "today"
    // being the capture day (production read its clock when it answered).
    if (!publishedDays.has(day) || day >= today || day >= generatedDay) contractInvalid(`${rowPath}.day`);
    if (version.combined) validateAllowanceSummary(entry.combined, `${rowPath}.combined`);
    const byPlan = closedObject(entry.byPlanType, `${rowPath}.byPlanType`, version.plans);
    for (const plan of version.plans) validateAllowanceSummary(byPlan[plan], `${rowPath}.byPlanType.${plan}`);
    const models = boundedArray(entry.models, `${rowPath}.models`, MAX_BREAKDOWN_MODELS);
    const seen = new Set<string>();
    models.forEach((tuple, modelIndex) => {
      const tuplePath = `${rowPath}.models[${modelIndex}]`;
      if (!Array.isArray(tuple) || tuple.length !== 3) contractInvalid(tuplePath);
      const id = patternString(tuple[0], `${tuplePath}[0]`, ID_PATTERN);
      if (seen.has(id)) contractInvalid(`${tuplePath}[0]`);
      seen.add(id);
      positiveFinite(tuple[1], `${tuplePath}[1]`);
      if (safeCount(tuple[2], `${tuplePath}[2]`) < 1) contractInvalid(`${tuplePath}[2]`);
    });
  });
  return breakdowns as unknown as FrozenBreakdowns;
}

// ---------------------------------------------------------------------------
// Cache retention (community-cache-retention-v1.0)
// ---------------------------------------------------------------------------

const BAND_KEYS = Object.freeze([
  "band", "startMs", "endMs", "adjacencies", "sessions", "contributors", "reusedMoreThanHalf",
  "matchedOrExceeded", "reusedMoreThanHalfRate", "matchedOrExceededRate", "topContributorShare",
  "excludedInsufficientEvidence", "excludedContextContracted", "unorderedTies",
] as const);

function validateCacheBand(value: unknown, path: string, expected: readonly [string, number, number]): void {
  const band = closedObject(value, path, BAND_KEYS);
  exactString(band.band, `${path}.band`, expected[0]);
  if (band.startMs !== expected[1]) contractInvalid(`${path}.startMs`);
  if (band.endMs !== expected[2]) contractInvalid(`${path}.endMs`);
  const adjacencies = safeCount(band.adjacencies, `${path}.adjacencies`);
  const sessions = safeCount(band.sessions, `${path}.sessions`);
  const contributors = safeCount(band.contributors, `${path}.contributors`);
  const reused = safeCount(band.reusedMoreThanHalf, `${path}.reusedMoreThanHalf`);
  const matched = safeCount(band.matchedOrExceeded, `${path}.matchedOrExceeded`);
  safeCount(band.excludedInsufficientEvidence, `${path}.excludedInsufficientEvidence`);
  safeCount(band.excludedContextContracted, `${path}.excludedContextContracted`);
  safeCount(band.unorderedTies, `${path}.unorderedTies`);
  // An empty band carries explicit nulls; a measured band came from at least
  // one session and distinct contributors cannot outnumber its sessions.
  if (adjacencies === 0
    ? sessions !== 0 || contributors !== 0 || reused !== 0 || matched !== 0
    : sessions < 1 || contributors < 1 || contributors > sessions || reused > adjacencies || matched > reused) {
    contractInvalid(path);
  }
  for (const field of ["reusedMoreThanHalfRate", "matchedOrExceededRate"] as const) {
    const rate = band[field];
    if (adjacencies === 0) {
      if (rate !== null) contractInvalid(`${path}.${field}`);
    } else if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      contractInvalid(`${path}.${field}`);
    }
  }
  const share = band.topContributorShare;
  if (share !== null && (contributors === 0 || typeof share !== "number"
      || !Number.isFinite(share) || share <= 0 || share > 1)) {
    contractInvalid(`${path}.topContributorShare`);
  }
  if (adjacencies === 0 && share !== null) contractInvalid(`${path}.topContributorShare`);
}

function validateCacheBands(value: unknown, path: string): void {
  const bands = boundedArray(value, path, CACHE_BANDS.length);
  if (bands.length !== CACHE_BANDS.length) contractInvalid(path);
  CACHE_BANDS.forEach((expected, index) => validateCacheBand(bands[index], `${path}[${index}]`, expected));
}

/**
 * The community cache-retention series: the full four-window by ten-band
 * shape production's boundary gate publishes, closed at every level.
 */
function validateCacheRetention(value: unknown): void {
  const path = "cacheRetention";
  const series = closedObject(value, path, [
    "schemaVersion", "metric", "methodVersion", "measures", "gapBasis", "windows",
  ]);
  exactString(series.schemaVersion, `${path}.schemaVersion`, "community-cache-retention-v1.0");
  exactString(series.metric, `${path}.metric`, "cache_retention_by_pause");
  patternString(series.methodVersion, `${path}.methodVersion`, CACHE_METHOD_PATTERN);
  exactString(series.measures, `${path}.measures`, "consecutive_requests");
  exactString(series.gapBasis, `${path}.gapBasis`, "response_end_to_response_end");
  const windows = boundedArray(series.windows, `${path}.windows`, CACHE_WINDOWS.length);
  if (windows.length !== CACHE_WINDOWS.length) contractInvalid(`${path}.windows`);
  CACHE_WINDOWS.forEach(([id, days], index) => {
    const windowPath = `${path}.windows[${index}]`;
    const window = closedObject(windows[index], windowPath, ["window", "days", "bands", "byModel", "modelsTruncated"]);
    exactString(window.window, `${windowPath}.window`, id);
    if (window.days !== days) contractInvalid(`${windowPath}.days`);
    if (typeof window.modelsTruncated !== "boolean") contractInvalid(`${windowPath}.modelsTruncated`);
    validateCacheBands(window.bands, `${windowPath}.bands`);
    const models = boundedArray(window.byModel, `${windowPath}.byModel`, MAX_CACHE_MODELS);
    const seen = new Set<string>();
    models.forEach((entry, modelIndex) => {
      const modelPath = `${windowPath}.byModel[${modelIndex}]`;
      const model = closedObject(entry, modelPath, ["model", "bands"]);
      const name = patternString(model.model, `${modelPath}.model`, ID_PATTERN);
      if (seen.has(name)) contractInvalid(`${modelPath}.model`);
      seen.add(name);
      validateCacheBands(model.bands, `${modelPath}.bands`);
    });
  });
}

// ---------------------------------------------------------------------------
// The whole body
// ---------------------------------------------------------------------------

/**
 * Validate a parsed export against community-daily-read-v1.0 as production's
 * typed-storage handler serves it, and against the capture facts. The window
 * must end on the evidence date and be the full 366-day year, so the label
 * never claims coverage the export lacks.
 */
export function validateFrozenCommunityDaily(
  parsed: unknown,
  facts: { readonly capturedAt: string; readonly evidenceDate: string },
): FrozenCommunityDaily {
  const capturedAtMs = Date.parse(facts.capturedAt);
  const body = closedObject(parsed, "$", [
    "schemaVersion", "from", "to", "allowanceState", "allowanceReadState", "days",
  ], ["allowanceBreakdowns", "cacheRetention"]);
  exactString(body.schemaVersion, "schemaVersion", INTERIM_PUBLIC_READ_SCHEMA_VERSION);
  const from = calendarDay(body.from, "from");
  const to = calendarDay(body.to, "to");
  if (to !== facts.evidenceDate) inconsistent("to");
  if (from !== addDays(to, -(INTERIM_PUBLIC_READ_WINDOW_DAYS - 1))) inconsistent("from");
  if (body.allowanceState !== "ready" && body.allowanceState !== "updating") contractInvalid("allowanceState");
  if (body.allowanceReadState !== "confirmed" && body.allowanceReadState !== "temporarily_unavailable") {
    contractInvalid("allowanceReadState");
  }
  const rows = boundedArray(body.days, "days", INTERIM_PUBLIC_READ_WINDOW_DAYS);
  const days = rows.map((row, index) => validateDay(row, `days[${index}]`, { from, to }, capturedAtMs));
  days.forEach((day, index) => {
    const before = days[index - 1];
    if (before !== undefined && before.day >= day.day) contractInvalid(`days[${index}].day`);
  });
  const publishedDays = new Set(days.map((day) => day.day));
  const breakdowns = body.allowanceBreakdowns === undefined
    ? null
    : validateBreakdowns(body.allowanceBreakdowns, facts.capturedAt.slice(0, 10), publishedDays, capturedAtMs);
  // Typed storage: the allowance is ready exactly when a graph was published.
  if ((body.allowanceState === "ready") !== (breakdowns !== null)) inconsistent("allowanceState");
  if (body.cacheRetention !== undefined) validateCacheRetention(body.cacheRetention);
  return {
    from,
    to,
    allowanceState: body.allowanceState,
    allowanceReadState: body.allowanceReadState,
    allowanceBreakdowns: breakdowns,
    cacheRetention: body.cacheRetention ?? null,
    days,
  };
}

// ---------------------------------------------------------------------------
// Bytes, metadata and digests
// ---------------------------------------------------------------------------

export async function interimPublicReadSha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalize a capture instant to the canonical millisecond form. Accepts
 * `YYYY-MM-DDTHH:MM:SS[.m[m[m]]]Z` and nothing else (UTC only, no offsets).
 */
export function normalizeInterimCapturedAt(value: unknown): string {
  const invalid = (): never => {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_METADATA_INVALID", "capturedAt");
  };
  if (typeof value !== "string") return invalid();
  const match = LOOSE_INSTANT_PATTERN.exec(value);
  if (match === null) return invalid();
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const epoch = Date.parse(canonical);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== canonical) return invalid();
  return canonical;
}

/**
 * The capture facts, checked as a set: a 40-hex production source commit, a
 * calendar evidence date, and a capture instant on that day or the next. The
 * export is taken at the seal, just before the fence, so a capture outside
 * those two days would label a day it was not taken on.
 */
export function validateInterimCaptureFacts(facts: {
  readonly capturedAt: unknown;
  readonly sourceCommit: unknown;
  readonly evidenceDate: unknown;
}): { readonly capturedAt: string; readonly sourceCommit: string; readonly evidenceDate: string } {
  const capturedAt = normalizeInterimCapturedAt(facts.capturedAt);
  const sourceCommit = facts.sourceCommit;
  if (typeof sourceCommit !== "string" || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_METADATA_INVALID", "sourceCommit");
  }
  const evidenceDate = facts.evidenceDate;
  if (typeof evidenceDate !== "string" || !DAY_PATTERN.test(evidenceDate)
      || new Date(dayEpoch(evidenceDate)).toISOString().slice(0, 10) !== evidenceDate) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_METADATA_INVALID", "evidenceDate");
  }
  const capturedDay = capturedAt.slice(0, 10);
  if (capturedDay < evidenceDate || capturedDay > addDays(evidenceDate, 1)) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_METADATA_INVALID", "evidenceDate");
  }
  return { capturedAt, sourceCommit, evidenceDate };
}

function parseExport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_EXPORT_NOT_JSON");
  }
}

function summarize(bytes: number, frozen: FrozenCommunityDaily): InterimPublicReadSummary {
  const first = frozen.days[0];
  const last = frozen.days[frozen.days.length - 1];
  return {
    bytes,
    from: frozen.from,
    to: frozen.to,
    dayCount: frozen.days.length,
    firstDay: first?.day ?? null,
    lastDay: last?.day ?? null,
    latestReleasedAt: frozen.days.reduce<string | null>(
      (latest, day) => (latest === null || day.releasedAt > latest ? day.releasedAt : latest), null),
    allowanceState: frozen.allowanceState,
    allowanceReadState: frozen.allowanceReadState,
    breakdownsSchemaVersion: frozen.allowanceBreakdowns === null
      ? null : String(frozen.allowanceBreakdowns.schemaVersion),
    breakdownDayCount: frozen.allowanceBreakdowns?.days.length ?? 0,
    cacheRetentionPresent: frozen.cacheRetention !== null,
  };
}

/**
 * The loader's whole intake: the exact export bytes, the owner's sha256 pin and
 * the capture facts in; the validated record, the frozen body and a
 * content-free summary out. The pin is checked on the bytes first, so nothing
 * but the pinned export is ever parsed. Throws InterimPublicReadError.
 */
export async function prepareInterimPublicRead(input: {
  readonly exportBytes: Uint8Array;
  readonly expectedSha256: unknown;
  readonly capturedAt: unknown;
  readonly sourceCommit: unknown;
  readonly evidenceDate: unknown;
}): Promise<VerifiedInterimPublicRead & { readonly summary: InterimPublicReadSummary }> {
  const { exportBytes, expectedSha256 } = input;
  if (!(exportBytes instanceof Uint8Array)) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_EXPORT_ENCODING_INVALID");
  }
  if (typeof expectedSha256 !== "string" || !SHA256_PATTERN.test(expectedSha256)) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_PIN_INVALID");
  }
  if (exportBytes.byteLength < 2 || exportBytes.byteLength > INTERIM_PUBLIC_READ_MAX_BYTES) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_EXPORT_SIZE_INVALID");
  }
  const facts = validateInterimCaptureFacts(input);
  const payloadSha256 = await interimPublicReadSha256(exportBytes);
  if (payloadSha256 !== expectedSha256) {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_SHA256_MISMATCH");
  }
  let payloadText: string;
  try {
    // ignoreBOM keeps a byte-order mark in the text, where JSON.parse refuses
    // it, so the stored text and the pinned bytes are the same bytes.
    payloadText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(exportBytes);
  } catch {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_EXPORT_ENCODING_INVALID");
  }
  const frozen = validateFrozenCommunityDaily(parseExport(payloadText), facts);
  return {
    record: { payloadText, payloadSha256, ...facts },
    frozen,
    summary: summarize(exportBytes.byteLength, frozen),
  };
}

/**
 * Verify one stored row as the route reads it: the shape of every column, the
 * digest of the stored text, the capture facts and the whole contract again.
 * A row that fails any of them is not served (the route answers 503).
 */
export async function verifyInterimPublicReadRow(row: unknown): Promise<VerifiedInterimPublicRead> {
  const rowInvalid = (): never => {
    throw new InterimPublicReadError("INTERIM_PUBLIC_READ_ROW_INVALID");
  };
  if (!isRecord(row)) return rowInvalid();
  const { payload_text: payloadText, payload_sha256: payloadSha256, captured_at: capturedAt,
    source_commit: sourceCommit, evidence_date: evidenceDate } = row;
  if (typeof payloadText !== "string" || typeof payloadSha256 !== "string"
      || !SHA256_PATTERN.test(payloadSha256) || typeof capturedAt !== "string"
      || !INSTANT_PATTERN.test(capturedAt)) {
    return rowInvalid();
  }
  const bytes = new TextEncoder().encode(payloadText);
  if (bytes.byteLength < 2 || bytes.byteLength > INTERIM_PUBLIC_READ_MAX_BYTES) return rowInvalid();
  if (await interimPublicReadSha256(bytes) !== payloadSha256) return rowInvalid();
  let facts: ReturnType<typeof validateInterimCaptureFacts>;
  try {
    facts = validateInterimCaptureFacts({ capturedAt, sourceCommit, evidenceDate });
  } catch {
    return rowInvalid();
  }
  if (facts.capturedAt !== capturedAt) return rowInvalid();
  return {
    record: { payloadText, payloadSha256, ...facts },
    frozen: validateFrozenCommunityDaily(parseExport(payloadText), facts),
  };
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/**
 * The frozen body for one request range, in the key order of the ordinary
 * route. Days outside [from, to] are not served, and the allowance breakdowns
 * follow the served days exactly as production's projection does: only the
 * published days in range, and the allowance is `ready` exactly when at least
 * one remains. Everything else is the frozen value, unchanged.
 */
export function projectInterimPublicRead(
  frozen: FrozenCommunityDaily,
  from: string,
  to: string,
): Record<string, unknown> {
  const days = frozen.days.filter((day) => day.day >= from && day.day <= to);
  const served = new Set(days.map((day) => day.day));
  const rows = frozen.allowanceBreakdowns === null
    ? [] : frozen.allowanceBreakdowns.days.filter((row) => served.has(row.day));
  const allowanceBreakdowns = frozen.allowanceBreakdowns !== null && rows.length > 0
    ? { ...frozen.allowanceBreakdowns, days: rows } : null;
  return {
    schemaVersion: INTERIM_PUBLIC_READ_SCHEMA_VERSION,
    from,
    to,
    allowanceState: allowanceBreakdowns === null ? "updating" : "ready",
    allowanceReadState: frozen.allowanceReadState,
    ...(allowanceBreakdowns === null ? {} : { allowanceBreakdowns }),
    ...(frozen.cacheRetention === null ? {} : { cacheRetention: frozen.cacheRetention }),
    days,
  };
}

/** The label headers of one interim answer. See INTERIM_PUBLIC_READ_HEADERS. */
export function interimPublicReadHeaders(record: InterimPublicReadRecord): Record<string, string> {
  return {
    [INTERIM_PUBLIC_READ_HEADERS.marker]: INTERIM_PUBLIC_READ_MARKER_VALUE,
    [INTERIM_PUBLIC_READ_HEADERS.evidenceDate]: record.evidenceDate,
    [INTERIM_PUBLIC_READ_HEADERS.sha256]: record.payloadSha256,
    [INTERIM_PUBLIC_READ_HEADERS.lastModified]: new Date(record.capturedAt).toUTCString(),
  };
}
