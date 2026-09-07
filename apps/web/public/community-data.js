// Public, read-only community data boundary.
//
// This module intentionally knows only the released aggregate contracts. The
// public website reads the day-partitioned series alone; the sealed weekly
// snapshot normalizer below is retained because the app's data-client.js still
// interprets that contract. The app's local companion, identity, contribution,
// and deletion clients remain in data-client.js and are not part of the public
// website's module graph.

import { REVIEWED_MODEL_CATALOG } from "./model-catalog.generated.js";

const COMMUNITY_ROOT = "/api/v1";
const SAFE_ERROR_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const COMMUNITY_SNAPSHOT_SCHEMA_VERSION =
  "community-weekly-snapshot-v0.3";
// Sealed snapshots are immutable, so a reader must retain every released
// schema version it can still interpret. The v0.1 cells omit plan cohorts;
// v0.3 changes the cohort claim from independent participants to eligible
// social-provider accounts. Every other publication and privacy check remains
// equally strict.
export const SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS = Object.freeze([
  "community-weekly-snapshot-v0.1",
  "community-weekly-snapshot-v0.2",
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);

const COMMUNITY_SNAPSHOT_PLAN_COHORT_VERSIONS = new Set([
  "community-weekly-snapshot-v0.2",
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);
const COMMUNITY_SNAPSHOT_PROVIDER_ACCOUNT_COHORT_VERSIONS = new Set([
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);
const PROVIDER_ACCOUNT_COHORT_ELIGIBILITY =
  "provider_account_gated_open_cohort";
// v0.3 is a closed public claim, not merely a shape to deserialize. The
// browser may accept stricter server policy values, but it must not render a
// payload that quietly weakens the published account/maturity guarantees.
// Any deliberate weaker or semantically different policy requires a new
// contract version and an explicit client review.
const COMMUNITY_WEEKLY_POLICY_VERSION = "community-weekly-v0.1";
const COMMUNITY_WEEKLY_MINIMUM_PROVIDER_ACCOUNTS = 20;
const COMMUNITY_WEEKLY_MINIMUM_MATURITY_DAYS = 7;
const COMMUNITY_WEEKLY_MINIMUM_ACCEPTED_COLLECTION_DAYS = 2;
const OPEN_PROVIDER_ACCOUNT_MATURITY_APPLIES_TO =
  "open_provider_account_cohort";
const ACCEPTED_COLLECTION_DAY_BASIS =
  "telemetry_contribution_created_at_before_cutoff";
const COMMUNITY_METRIC_UNITS = Object.freeze({
  usageEvents: "events_rounded_down",
  inputUncachedTokens: "tokens_rounded_down",
  inputCacheReadTokens: "tokens_rounded_down",
  inputCacheWriteTokens: "tokens_rounded_down",
  outputTextTokens: "tokens_rounded_down",
  outputReasoningTokens: "tokens_rounded_down",
  outputCombinedTokens: "tokens_rounded_down",
  toolUnits: "tool_units_rounded_down",
});

function finite(value, fallback = null) {
  if (value === null
      || value === undefined
      || value === ""
      || typeof value === "boolean") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.length <= 500 ? value : fallback;
}

function snapshotMetric(value, expectedUnit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (value.status === "suppressed") {
    return { status: "suppressed", value: null, unit: expectedUnit };
  }
  const numeric = finite(value.value, null);
  if (value.status !== "released"
      || value.unit !== expectedUnit
      || numeric === null
      || !Number.isSafeInteger(numeric)
      || numeric < 0) {
    return null;
  }
  return { status: "released", value: numeric, unit: expectedUnit };
}

function publishedCohort(payload) {
  const providerAccountCohort =
    COMMUNITY_SNAPSHOT_PROVIDER_ACCOUNT_COHORT_VERSIONS.has(
      payload.schemaVersion,
    );
  if (!providerAccountCohort) {
    const minimumParticipants = finite(
      payload.privacyPolicy?.minimumIndependentParticipants,
      null,
    );
    return Number.isSafeInteger(minimumParticipants)
      && minimumParticipants >= 3
      ? {
        minimumParticipants,
        participantCohort: "legacy_contributor",
      }
      : null;
  }

  const minimumParticipants = finite(
    payload.privacyPolicy?.minimumProviderAccountParticipants,
    null,
  );
  const maturityDays = finite(payload.privacyPolicy?.maturity?.maturityDays, null);
  const minimumAcceptedCollectionDays = finite(
    payload.privacyPolicy?.maturity?.minimumAcceptedCollectionDays,
    null,
  );
  if (payload.privacyPolicy?.version !== COMMUNITY_WEEKLY_POLICY_VERSION
      || payload.cohortEligibility !== PROVIDER_ACCOUNT_COHORT_ELIGIBILITY
      || payload.privacyPolicy?.maturity?.appliesTo
        !== OPEN_PROVIDER_ACCOUNT_MATURITY_APPLIES_TO
      || payload.privacyPolicy?.maturity?.acceptedCollectionDayBasis
        !== ACCEPTED_COLLECTION_DAY_BASIS
      || !Number.isSafeInteger(minimumParticipants)
      || minimumParticipants < COMMUNITY_WEEKLY_MINIMUM_PROVIDER_ACCOUNTS
      || !Number.isSafeInteger(maturityDays)
      || maturityDays < COMMUNITY_WEEKLY_MINIMUM_MATURITY_DAYS
      || maturityDays > 3_650
      || !Number.isSafeInteger(minimumAcceptedCollectionDays)
      || minimumAcceptedCollectionDays
        < COMMUNITY_WEEKLY_MINIMUM_ACCEPTED_COLLECTION_DAYS
      || minimumAcceptedCollectionDays > 366) {
    return null;
  }
  return {
    minimumParticipants,
    participantCohort: "provider_account",
  };
}

export function normalizeCommunitySnapshot(payload) {
  if (!payload) return { state: "service_unavailable", cells: [] };
  if (payload.publicationStatus
      === "development_diagnostic_not_publication_safe") {
    return { state: "development_unsafe", cells: [] };
  }
  if (!SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS.includes(
    payload.schemaVersion,
  )
      || payload.immutable !== true
      || payload.nonOverlapping !== true) {
    return { state: "unsupported_schema", cells: [] };
  }
  const carriesPlanCohort = COMMUNITY_SNAPSHOT_PLAN_COHORT_VERSIONS.has(
    payload.schemaVersion,
  );
  const cohort = publishedCohort(payload);

  const base = {
    schemaVersion: payload.schemaVersion,
    snapshotId: text(payload.snapshotId, ""),
    period: {
      startAt: text(payload.period?.startAt, ""),
      endAt: text(payload.period?.endAt, ""),
    },
    ingestionCutoffAt: text(payload.ingestionCutoffAt, ""),
    releasedAt: text(payload.releasedAt, ""),
    policyVersion: text(payload.privacyPolicy?.version, ""),
    minimumParticipants: cohort?.minimumParticipants ?? null,
    participantCohort: cohort?.participantCohort ?? "unknown",
    cells: [],
  };

  if (payload.releaseStatus === "not_yet_published") {
    return { ...base, state: "not_yet_published" };
  }
  if (payload.releaseStatus === "withdrawn") {
    return { ...base, state: "withdrawn" };
  }
  if (payload.releaseStatus === "suppressed") {
    return { ...base, state: "suppressed" };
  }
  if (payload.releaseStatus !== "published"
      || !base.snapshotId
      || !base.period.startAt
      || !base.period.endAt
      || !base.ingestionCutoffAt
      || !base.releasedAt
      || !base.policyVersion
      || cohort === null
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...base, state: "unsupported_schema" };
  }

  const cells = [];
  let partial = false;
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!provider
        || !modelId
        || !candidate.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...base, state: "unsupported_schema" };
    }
    const planType = carriesPlanCohort
      ? text(candidate?.planType, "unknown")
      : "unknown";
    const planVariant = carriesPlanCohort
      ? text(candidate?.planVariant, "unknown")
      : "unknown";
    const metrics = {};
    for (
      const [metricName, expectedUnit]
      of Object.entries(COMMUNITY_METRIC_UNITS)
    ) {
      const metric = snapshotMetric(candidate.metrics[metricName], expectedUnit);
      if (!metric) return { ...base, state: "unsupported_schema" };
      metrics[metricName] = metric;
      partial ||= metric.status === "suppressed";
    }
    cells.push({ provider, planType, planVariant, modelId, metrics });
  }
  return {
    ...base,
    state: partial ? "published_partial" : "published",
    cells,
  };
}

export const COMMUNITY_DAILY_READ_SCHEMA_VERSION = "community-daily-read-v1.0";
const COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION =
  "community-daily-aggregate-v1.0";
const COMMUNITY_DAILY_POLICY_VERSION = "community-daily-v1.0";
// Standing rule: read windows are absent or a full year, never
// convenience-sized. The endpoint's inclusive bound is 366 days.
export const COMMUNITY_DAILY_WINDOW_DAYS = 366;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const COMMUNITY_DAILY_TOTAL_FIELDS = Object.freeze([
  "contributingParticipants",
  "contributingDevices",
  "usageEvents",
  "quotaObservations",
  "sessionDimensions",
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "outputTextTokens",
  "outputReasoningTokens",
  "outputCombinedTokens",
]);

function dayString(value) {
  return typeof value === "string" && DAY_PATTERN.test(value) ? value : null;
}

/**
 * The inclusive year window ending today (UTC): 366 days, the endpoint's
 * exact bound, so late-arriving history recomputations stay visible instead
 * of a shorter convenience window hiding them.
 */
export function communityDailyWindow(nowMs = Date.now()) {
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const from = new Date(
    nowMs - (COMMUNITY_DAILY_WINDOW_DAYS - 1) * MILLISECONDS_PER_DAY,
  ).toISOString().slice(0, 10);
  return { from, to };
}

// The allowance block is additive on community-daily-aggregate-v1.0. Only the
// exact merged methodology is interpreted: supported personal-plan fits are
// normalized into one Pro 20x-equivalent summary before the median and range
// are calculated. Old Pro-only blocks and any future methodology are per-day
// absent, never silently relabelled under the merged copy.
export const COMMUNITY_ALLOWANCE_BASIS =
  "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
export const COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE = "pro";
export const COMMUNITY_ALLOWANCE_NORMALIZATION =
  "pro_x1_prolite_x4_plus_x20";

// Inverse of the validated reference-plan display basis, not a pricing model
// or a new allowance fit. Convert the unrounded estimate before formatting.
const PLAN_REFERENCE_MULTIPLIERS = Object.freeze({ pro: 1, prolite: 4, plus: 20 });
export function planWeeklyApiEquivalentUsd(referenceUsd, planType) {
  if (typeof referenceUsd !== "number" || !Number.isFinite(referenceUsd) || referenceUsd < 0
      || typeof planType !== "string"
      || !Object.prototype.hasOwnProperty.call(PLAN_REFERENCE_MULTIPLIERS, planType)) return null;
  return referenceUsd / PLAN_REFERENCE_MULTIPLIERS[planType];
}

export const PUBLIC_ALLOWANCE_MODEL_CONFIG = Object.freeze(REVIEWED_MODEL_CATALOG
  .filter(model => model.provider === "openai_codex" && model.allowanceTrack === "primary")
  .map(model => Object.freeze({ modelId: model.id, label: model.label })));
const PUBLIC_ALLOWANCE_MODEL_IDS = new Set(PUBLIC_ALLOWANCE_MODEL_CONFIG.map(model => model.modelId));
const PUBLIC_ALLOWANCE_PLAN_IDS = Object.freeze(["pro", "prolite", "plus"]);
const exactObject = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const publicCount = value => Number.isSafeInteger(value) && value >= 0;
const publicDollars = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const publicDay = value => typeof value === "string" && DAY_PATTERN.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function publicAllowanceSummary(value) {
  if (!exactObject(value, ["centralUsd", "participantCount", "fitCount", "band80Usd"])
      || !publicCount(value.fitCount) || !publicCount(value.participantCount)
      || value.participantCount > value.fitCount) return null;
  if (value.fitCount === 0) {
    if (value.participantCount !== 0 || value.centralUsd !== null || value.band80Usd !== null) return null;
  } else if (value.participantCount < 1 || !publicDollars(value.centralUsd)) return null;
  let band80Usd = null;
  if (value.band80Usd !== null) {
    const band = value.band80Usd;
    if (value.fitCount < 3 || !exactObject(band, ["lowerUsd", "upperUsd"])
        || !publicDollars(band.lowerUsd) || !publicDollars(band.upperUsd)
        || band.lowerUsd > value.centralUsd || band.upperUsd < value.centralUsd) return null;
    band80Usd = { lowerUsd: band.lowerUsd, upperUsd: band.upperUsd };
  }
  return { centralUsd: value.centralUsd, participantCount: value.participantCount,
    fitCount: value.fitCount, band80Usd };
}

/** New public contract, never the private preview. Invalid optional breakdowns
 * cannot hide the separately validated daily activity or aggregate estimates. */
export function normalizePublicAllowanceBreakdowns(value, publishedDays, nowMs = Date.now()) {
  if (!exactObject(value, ["schemaVersion", "basis", "referencePlanType", "normalization",
    "modelBasis", "modelGate", "generatedAt", "days"])
      || !["community-allowance-breakdowns-v1.0", "community-allowance-breakdowns-v1.1"].includes(value.schemaVersion)
      || value.basis !== COMMUNITY_ALLOWANCE_BASIS || value.referencePlanType !== "pro"
      || value.normalization !== COMMUNITY_ALLOWANCE_NORMALIZATION
      || value.modelBasis !== "seven_day_codex_pro20x_equivalent_per_model_composition"
      || value.modelGate !== "shared_composition_kernel_identification"
      || typeof value.generatedAt !== "string" || !Number.isFinite(nowMs)
      || !Array.isArray(value.days) || value.days.length > 70) return null;
  const generatedMs = Date.parse(value.generatedAt);
  // Keep the publication's actual dates; only the server can invalidate its
  // source. An ordinary refresh does not expire a previously published graph.
  if (!Number.isFinite(generatedMs) || new Date(generatedMs).toISOString() !== value.generatedAt
      || generatedMs > nowMs + 5 * 60 * 1000) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const generatedDay = value.generatedAt.slice(0, 10);
  const earliestDay = new Date(Date.parse(`${generatedDay}T00:00:00.000Z`)
    - 69 * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
  const allowedDays = new Set(publishedDays);
  const days = [];
  const hasCombined = value.schemaVersion === "community-allowance-breakdowns-v1.1";
  for (const row of value.days) {
    if (!exactObject(row, hasCombined ? ["day", "combined", "byPlanType", "models"] : ["day", "byPlanType", "models"]) || !publicDay(row.day)
        || !allowedDays.has(row.day) || row.day < earliestDay || row.day >= today || row.day >= generatedDay
        || (days.length > 0 && row.day <= days.at(-1).day)
        || !exactObject(row.byPlanType, PUBLIC_ALLOWANCE_PLAN_IDS)
        || !Array.isArray(row.models) || row.models.length > PUBLIC_ALLOWANCE_MODEL_IDS.size) return null;
    const byPlanType = {};
    for (const id of PUBLIC_ALLOWANCE_PLAN_IDS) {
      const summary = publicAllowanceSummary(row.byPlanType[id]);
      if (summary === null) return null;
      byPlanType[id] = summary;
    }
    const models = [];
    const seen = new Set();
    for (const tuple of row.models) {
      if (!Array.isArray(tuple) || tuple.length !== 3
          || !PUBLIC_ALLOWANCE_MODEL_IDS.has(tuple[0]) || seen.has(tuple[0])
          || !publicDollars(tuple[1]) || !publicCount(tuple[2]) || tuple[2] < 1) return null;
      seen.add(tuple[0]);
      models.push([tuple[0], tuple[1], tuple[2]]);
    }
    const combined = hasCombined ? publicAllowanceSummary(row.combined) : null;
    if (hasCombined && combined === null) return null;
    days.push({ day: row.day, ...(hasCombined ? { combined } : {}), byPlanType, models });
  }
  return { generatedAt: value.generatedAt, hasCombined, modelConfig: PUBLIC_ALLOWANCE_MODEL_CONFIG, days };
}

function normalizedDailyAllowance(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  if (candidate.basis !== COMMUNITY_ALLOWANCE_BASIS
      || candidate.referencePlanType !== COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE
      || candidate.normalization !== COMMUNITY_ALLOWANCE_NORMALIZATION) {
    return null;
  }
  const fitCount = finite(candidate.fitCount, null);
  const participantCount = finite(candidate.participantCount, null);
  if (!Number.isSafeInteger(fitCount)
      || fitCount < 0
      || !Number.isSafeInteger(participantCount)
      || participantCount < 0
      || (fitCount === 0) !== (participantCount === 0)) {
    return null;
  }
  if (fitCount === 0) {
    if (candidate.centralUsd !== null || candidate.band80Usd !== null) {
      return null;
    }
    return { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
  }
  const centralUsd = finite(candidate.centralUsd, null);
  if (centralUsd === null || centralUsd <= 0) return null;
  let band80Usd = null;
  if (candidate.band80Usd !== null && candidate.band80Usd !== undefined) {
    const raw = candidate.band80Usd;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const lowerUsd = finite(raw.lowerUsd, null);
    const upperUsd = finite(raw.upperUsd, null);
    if (lowerUsd === null
        || upperUsd === null
        || lowerUsd <= 0
        || upperUsd < lowerUsd) {
      return null;
    }
    band80Usd = { lowerUsd, upperUsd };
  }
  return { fitCount, participantCount, centralUsd, band80Usd };
}

function normalizedDailyTotals(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const totals = {};
  for (const field of COMMUNITY_DAILY_TOTAL_FIELDS) {
    const value = finite(candidate[field], null);
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    totals[field] = value;
  }
  return totals;
}

export const COMMUNITY_DAILY_SPEND_BASIS = "reported_usage_event_time_api_price_equivalent_v1";

function normalizedDailySpend(candidate, usageEvents) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || candidate.basis !== COMMUNITY_DAILY_SPEND_BASIS || candidate.currency !== "USD"
      || typeof candidate.pricingMethodVersion !== "string"
      || !/^server-api-price-equivalent-v\d+\.\d+$/u.test(candidate.pricingMethodVersion)
      || typeof candidate.registrySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.registrySha256)) return null;
  const unprocessed = candidate.unprocessedUsageEvents ?? 0;
  const counts = [candidate.usageEvents, candidate.fullyPricedUsageEvents,
    candidate.partiallyPricedUsageEvents, candidate.unpricedUsageEvents, unprocessed];
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const [events, full, partial, unpriced] = counts;
  if (events !== usageEvents || full + partial + unpriced + unprocessed !== events) return null;
  const resourceLimited = unprocessed > 0;
  if (resourceLimited && (unprocessed !== events || candidate.unavailableReason !== "processing_capacity_exceeded"
      || typeof candidate.processingPolicyVersion !== "string"
      || !/^daily-spend-capacity-[1-9]\d{0,5}-chunks-[1-9]\d{0,8}-events$/u.test(candidate.processingPolicyVersion))) return null;
  if (!resourceLimited && (candidate.unavailableReason !== undefined || candidate.processingPolicyVersion !== undefined)) return null;
  const known = events === 0 || full + partial > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  if (candidate.coverage !== coverage || (known
    ? typeof candidate.knownCostUsd !== "number" || !Number.isFinite(candidate.knownCostUsd)
      || candidate.knownCostUsd < 0 || (events === 0 && candidate.knownCostUsd !== 0)
    : candidate.knownCostUsd !== null)) return null;
  // Fresh allowlist: neither unknown fields nor private diagnostics reach UI.
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: candidate.knownCostUsd, coverage,
    usageEvents: events, fullyPricedUsageEvents: full, partiallyPricedUsageEvents: partial, unpricedUsageEvents: unpriced,
    pricingMethodVersion: candidate.pricingMethodVersion, registrySha256: candidate.registrySha256,
    ...(resourceLimited ? { unprocessedUsageEvents: unprocessed, unavailableReason: "processing_capacity_exceeded",
      processingPolicyVersion: candidate.processingPolicyVersion } : {}),
  };
}

function normalizedDailyDay(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const day = dayString(candidate.day);
  const revision = finite(candidate.revision, null);
  const releasedAt = text(candidate.releasedAt, "");
  const payload = candidate.payload;
  if (day === null
      || !Number.isSafeInteger(revision)
      || revision < 1
      || releasedAt === ""
      || !payload
      || typeof payload !== "object"
      || Array.isArray(payload)) {
    return null;
  }
  // The per-day payload is the immutable published revision. The read wrapper
  // repeats day/revision; a disagreement means the response cannot be trusted.
  if (payload.schemaVersion !== COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION
      || payload.policyVersion !== COMMUNITY_DAILY_POLICY_VERSION
      || payload.immutableRevision !== true
      || payload.recomputesOnLateData !== true
      || payload.day !== day
      || payload.revision !== revision) {
    return null;
  }
  const totals = normalizedDailyTotals(payload.totals);
  if (totals === null) return null;
  return {
    day,
    revision,
    releasedAt,
    totals,
    allowance: normalizedDailyAllowance(payload.allowance),
    apiEquivalentSpend: normalizedDailySpend(payload.apiEquivalentSpend, totals.usageEvents),
  };
}

/**
 * Normalizes one /community/daily response into a closed, render-safe shape.
 * Anything the page would have to guess about — schema drift, invalid days,
 * out-of-order series — collapses to `unsupported_schema` rather than a
 * partially trusted render.
 */
export function normalizeCommunityDailySeries(payload, { nowMs = Date.now() } = {}) {
  if (!payload) return { state: "service_unavailable", days: [] };
  const from = dayString(payload.from);
  const to = dayString(payload.to);
  if (payload.schemaVersion !== COMMUNITY_DAILY_READ_SCHEMA_VERSION
      || from === null
      || to === null
      || !["ready", "updating"].includes(payload.allowanceState)
      || !Array.isArray(payload.days)
      || payload.days.length > COMMUNITY_DAILY_WINDOW_DAYS) {
    return { state: "unsupported_schema", days: [] };
  }
  const days = [];
  for (const candidate of payload.days) {
    const normalized = normalizedDailyDay(candidate);
    if (normalized === null
        || normalized.day < from
        || normalized.day > to
        || (days.length > 0 && normalized.day <= days[days.length - 1].day)) {
      return { state: "unsupported_schema", days: [] };
    }
    days.push(normalized);
  }
  return {
    state: days.length === 0 ? "none_published" : "published",
    from,
    to,
    allowanceState: payload.allowanceState,
    breakdowns: payload.allowanceState === "ready"
      ? normalizePublicAllowanceBreakdowns(payload.allowanceBreakdowns, days.map(day => day.day), nowMs) : null,
    days,
  };
}

async function readPublicJson(fetchImpl, path, signal) {
  const response = await fetchImpl(path, {
    headers: { Accept: "application/json" },
    cache: "no-cache",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    const code = payload?.error?.code;
    const requestId = payload?.error?.requestId;
    if (typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)) {
      error.code = code;
    }
    if (typeof requestId === "string"
        && SERVICE_REQUEST_ID_PATTERN.test(requestId)) {
      error.requestId = requestId;
    }
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function fetchCommunityDaily(fetchImpl, nowMs, signal) {
  const { from, to } = communityDailyWindow(nowMs);
  return readPublicJson(
    fetchImpl,
    `${COMMUNITY_ROOT}/community/daily?from=${from}&to=${to}`,
    signal,
  );
}

export class PublicCommunityClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Public community fetch implementation must be a function.");
    }
    this.fetchImpl = fetchImpl;
  }

  communityDaily({ nowMs = Date.now(), signal } = {}) {
    const fetchImpl = this.fetchImpl;
    return fetchCommunityDaily(fetchImpl, nowMs, signal);
  }
}
