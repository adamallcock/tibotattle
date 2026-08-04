// Public, read-only community data boundary.
//
// This module intentionally knows only the released aggregate endpoint and
// the closed snapshot contract. The app's local companion, identity,
// contribution, and deletion clients remain in data-client.js and are not part
// of the public website's module graph.

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

async function fetchCommunitySnapshot(fetchImpl) {
  const response = await fetchImpl(`${COMMUNITY_ROOT}/stats/aggregate`, {
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

export class PublicCommunityClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Public community fetch implementation must be a function.");
    }
    this.fetchImpl = fetchImpl;
  }

  communityStats() {
    const fetchImpl = this.fetchImpl;
    return fetchCommunitySnapshot(fetchImpl);
  }
}
