// Public, read-only community data boundary.
//
// This module intentionally knows only the released aggregate contracts. The
// public website reads the day-partitioned series alone; the sealed weekly
// snapshot normalizer below is retained because the app's data-client.js still
// interprets that contract. The app's local companion, identity, contribution,
// and deletion clients remain in data-client.js and are not part of the public
// website's module graph.

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

// The allowance block is additive on community-daily-aggregate-v1.0: older
// published revisions never carried it, so a missing or invalid block is
// per-day-absent (`allowance: null`), never `unsupported_schema`. Only the
// exact published basis is interpreted; a different basis is a different
// claim this client does not understand and therefore does not render.
export const COMMUNITY_ALLOWANCE_BASIS = "seven_day_codex_trailing_30d";

function normalizedDailyAllowance(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  if (candidate.basis !== COMMUNITY_ALLOWANCE_BASIS) return null;
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
  };
}

/**
 * Normalizes one /community/daily response into a closed, render-safe shape.
 * Anything the page would have to guess about — schema drift, invalid days,
 * out-of-order series — collapses to `unsupported_schema` rather than a
 * partially trusted render.
 */
export function normalizeCommunityDailySeries(payload) {
  if (!payload) return { state: "service_unavailable", days: [] };
  const from = dayString(payload.from);
  const to = dayString(payload.to);
  if (payload.schemaVersion !== COMMUNITY_DAILY_READ_SCHEMA_VERSION
      || from === null
      || to === null
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
    days,
  };
}

async function readPublicJson(fetchImpl, path) {
  const response = await fetchImpl(path, {
    headers: { Accept: "application/json" },
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

function fetchCommunityDaily(fetchImpl, nowMs) {
  const { from, to } = communityDailyWindow(nowMs);
  return readPublicJson(
    fetchImpl,
    `${COMMUNITY_ROOT}/community/daily?from=${from}&to=${to}`,
  );
}

export class PublicCommunityClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Public community fetch implementation must be a function.");
    }
    this.fetchImpl = fetchImpl;
  }

  communityDaily({ nowMs = Date.now() } = {}) {
    const fetchImpl = this.fetchImpl;
    return fetchCommunityDaily(fetchImpl, nowMs);
  }
}
