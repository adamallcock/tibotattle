/**
 * Browser data boundary.
 *
 * Preferred local companion contract:
 *   GET  /api/local/v1/status
 *   GET  /api/local/v1/dashboard
 *   POST /api/local/refresh
 *
 * Split endpoint aliases are supported while the local server evolves:
 *   /api/local/{onboarding,overview,gradient,weekly,quality,reports}
 *
 * Central contribution contract:
 *   POST /api/v1/contributions
 *   POST /api/v1/me/contributions/read
 *   POST /api/v1/me/contributions/delete
 *   GET  /api/v1/me
 *   GET  /api/v1/me/stats
 *   GET  /api/v1/stats/aggregate
 *   POST /api/v1/me/device-pairings
 *   GET  /api/v1/me/devices
 *   POST /api/v1/me/devices/revoke
 *
 * The normalizers below accept complete, partial, stale, and insufficient
 * responses, but never silently turn a failure into real-looking data.
 */

const LOCAL_ROOT = "/api/local";
const CENTRAL_ROOT = "/api/v1";
export const COMMUNITY_SNAPSHOT_SCHEMA_VERSION = "community-weekly-snapshot-v0.2";
const BACKEND_LIFECYCLE_STATES = new Set([
  "never_run",
  "running",
  "completed",
  "failed",
  "stale",
  "incomplete",
  "ready"
]);
const BACKEND_RECONCILIATION_STATES = new Set([
  "never_run",
  "running",
  "completed",
  "failed"
]);
export const PARTICIPANT_STATS_SCHEMA_VERSION = "participant-stats-v0.2";
export const PARTICIPANT_PROFILE_SCHEMA_VERSION = "participant-profile-v0.2";
export const PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION =
  "participant-community-comparison-v0.2";
export const CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION =
  "contribution-sync-status-v0.1";
export const CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION =
  "contribution-sync-preview-v0.1";
export const CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION =
  "contribution-sync-run-v0.1";
export const AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION =
  "automatic-contribution-status-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION =
  "local-contribution-preparation-result-v0.1";
export const LOCAL_CONTRIBUTION_DEVICE_PAIRING_VERSION =
  "local-contribution-device-pairing-v0.1";
export const LOCAL_ONBOARDING_SCHEMA_VERSION = "local-onboarding-v0.2";
const MAXIMUM_ONBOARDING_ROLLOUT_FILES = 100;

const COMMUNITY_METRIC_UNITS = Object.freeze({
  usageEvents: "events_rounded_down",
  inputUncachedTokens: "tokens_rounded_down",
  inputCacheReadTokens: "tokens_rounded_down",
  inputCacheWriteTokens: "tokens_rounded_down",
  outputTextTokens: "tokens_rounded_down",
  outputReasoningTokens: "tokens_rounded_down",
  outputCombinedTokens: "tokens_rounded_down",
  toolUnits: "tool_units_rounded_down"
});
const PARTICIPANT_COMPARISON_METRIC_UNITS = Object.freeze({
  usageEvents: "events",
  inputUncachedTokens: "tokens",
  inputCacheReadTokens: "tokens",
  inputCacheWriteTokens: "tokens",
  outputTextTokens: "tokens",
  outputReasoningTokens: "tokens",
  outputCombinedTokens: "tokens",
  toolUnits: "units"
});
const CONTRIBUTION_ID_PATTERN =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTICIPANT_ID_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTRIBUTION_SCHEMA_VERSIONS = new Set([
  "synthetic-contribution-v0.1",
  "telemetry-contribution-v0.1",
  "telemetry-contribution-v0.2"
]);
const CONTRIBUTION_POLICY_EPOCHS = new Set([
  "unknown",
  "openai_pre_agentic_pool_2026_07_09",
  "openai_agentic_pool_2026_07_09",
  "anthropic_unknown"
]);
const PARTICIPANT_CONSENT_VERSIONS = new Set([
  "synthetic-preview-v0.1",
  "privacy-safe-telemetry-v0.1",
  "privacy-safe-telemetry-v0.2",
  "ongoing-privacy-safe-telemetry-v0.1",
  "ongoing-privacy-safe-telemetry-v0.2"
]);
const LOCAL_PREPARATION_ERROR_CODES = new Set([
  "coverage_unavailable",
  "coverage_invalid",
  "identity_unavailable",
  "no_safe_records",
  "export_too_large",
  "privacy_verification_failed",
  "review_archive_invalid",
  "prepared_spool_invalid",
  "preparation_in_progress",
  "preparation_failed"
]);

function array(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.length <= 500 ? value : fallback;
}

function count(value, fallback = null) {
  const number = finite(value, fallback);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function nonNegative(value, fallback = null) {
  const number = finite(value, fallback);
  return number !== null && number >= 0 ? number : fallback;
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000")
      === [...expectedKeys].sort().join("\u0000");
}

export function normalizeLocalOnboarding(payload) {
  const unavailable = Object.freeze({
    state: "unavailable",
    sourceStatus: "unavailable",
    sessionsReadable: false,
    archivedSessionsReadable: false,
    rolloutFilesPresent: false,
    rolloutFilesObserved: 0,
    rolloutFilesObservedCapped: false,
    stateStatus: "unavailable",
    stateWritable: false,
    explicitRefresh: false,
    customCodexHomeConfigured: false
  });
  if (!hasExactKeys(payload, [
    "schemaVersion",
    "status",
    "source",
    "state",
    "capabilities"
  ])
      || payload.schemaVersion !== LOCAL_ONBOARDING_SCHEMA_VERSION
      || !["ready", "needs_attention"].includes(payload.status)
      || !hasExactKeys(payload.source, [
        "status",
        "sessionsReadable",
        "archivedSessionsReadable",
        "rolloutFilesPresent",
        "rolloutFilesObserved",
        "rolloutFilesObservedCapped"
      ])
      || !hasExactKeys(payload.state, ["status", "writable"])
      || !hasExactKeys(payload.capabilities, [
        "explicitRefresh",
        "customCodexHomeConfigured",
        "rawContentExposed",
        "arbitraryPathAccess"
      ])
      || ![
        "ready",
        "codex_home_missing",
        "codex_home_unreadable",
        "session_directories_missing",
        "session_directories_unreadable",
        "no_rollout_files"
      ].includes(payload.source.status)
      || typeof payload.source.sessionsReadable !== "boolean"
      || typeof payload.source.archivedSessionsReadable !== "boolean"
      || typeof payload.source.rolloutFilesPresent !== "boolean"
      || !Number.isSafeInteger(payload.source.rolloutFilesObserved)
      || payload.source.rolloutFilesObserved < 0
      || payload.source.rolloutFilesObserved
        > MAXIMUM_ONBOARDING_ROLLOUT_FILES
      || typeof payload.source.rolloutFilesObservedCapped !== "boolean"
      || !["ready", "unwritable"].includes(payload.state.status)
      || typeof payload.state.writable !== "boolean"
      || typeof payload.capabilities.explicitRefresh !== "boolean"
      || typeof payload.capabilities.customCodexHomeConfigured !== "boolean"
      || payload.capabilities.rawContentExposed !== false
      || payload.capabilities.arbitraryPathAccess !== false
      || payload.source.rolloutFilesPresent
        !== (payload.source.rolloutFilesObserved > 0)
      || payload.source.rolloutFilesObservedCapped
        !== (payload.source.rolloutFilesObserved
          === MAXIMUM_ONBOARDING_ROLLOUT_FILES)
      || payload.state.status !== (payload.state.writable
        ? "ready"
        : "unwritable")
      || (payload.source.status === "ready"
        && (!payload.source.rolloutFilesPresent
          || (!payload.source.sessionsReadable
            && !payload.source.archivedSessionsReadable)))
      || (payload.source.status === "no_rollout_files"
        && payload.source.rolloutFilesPresent)
      || payload.status !== (
        payload.source.status === "ready"
        && payload.state.status === "ready"
        && payload.capabilities.explicitRefresh
          ? "ready"
          : "needs_attention"
      )) {
    return unavailable;
  }
  return Object.freeze({
    state: payload.status,
    sourceStatus: payload.source.status,
    sessionsReadable: payload.source.sessionsReadable,
    archivedSessionsReadable: payload.source.archivedSessionsReadable,
    rolloutFilesPresent: payload.source.rolloutFilesPresent,
    rolloutFilesObserved: payload.source.rolloutFilesObserved,
    rolloutFilesObservedCapped: payload.source.rolloutFilesObservedCapped,
    stateStatus: payload.state.status,
    stateWritable: payload.state.writable,
    explicitRefresh: payload.capabilities.explicitRefresh,
    customCodexHomeConfigured:
      payload.capabilities.customCodexHomeConfigured
  });
}

export function normalizeContributionDeletionReceipt(payload, expectedContributionId) {
  if (!hasExactKeys(payload, ["deleted", "contributionId"])
      || payload.deleted !== true
      || !CONTRIBUTION_ID_PATTERN.test(payload.contributionId)
      || payload.contributionId !== expectedContributionId) {
    throw new Error("The service returned an invalid contribution deletion receipt.");
  }
  return Object.freeze({
    deleted: true,
    contributionId: payload.contributionId
  });
}

export function normalizeParticipantDeletionReceipt(payload, expectedParticipantId = null) {
  if (!hasExactKeys(payload, ["deleted", "participantId", "contributionsDeleted"])
      || payload.deleted !== true
      || !PARTICIPANT_ID_PATTERN.test(payload.participantId)
      || (expectedParticipantId !== null && payload.participantId !== expectedParticipantId)
      || !Number.isSafeInteger(payload.contributionsDeleted)
      || payload.contributionsDeleted < 0) {
    throw new Error("The service returned an invalid participant deletion receipt.");
  }
  return Object.freeze({
    deleted: true,
    participantId: payload.participantId,
    contributionsDeleted: payload.contributionsDeleted
  });
}

export function normalizeContributionSyncStatus(payload) {
  const unavailable = {
    state: "unavailable",
    paused: null,
    counts: {
      pending: 0,
      inFlight: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0
    },
    dueNow: 0,
    nextAttemptAt: "",
    lastAcceptedAt: ""
  };
  if (payload?.schemaVersion !== CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION
      || payload?.status !== "available"
      || typeof payload?.paused !== "boolean"
      || payload?.includesContent !== false
      || payload?.includesPaths !== false
      || payload?.includesCredentials !== false) {
    return unavailable;
  }
  const names = ["pending", "inFlight", "accepted", "retryable", "rejected"];
  const counts = Object.fromEntries(names.map((name) => [
    name,
    count(payload?.counts?.[name], null)
  ]));
  if (Object.values(counts).some((value) => value === null)) return unavailable;
  const nextAttemptAt = text(payload.nextAttemptAt, "");
  const lastAcceptedAt = text(payload.lastAcceptedAt, "");
  if ((nextAttemptAt && !Number.isFinite(Date.parse(nextAttemptAt)))
      || (lastAcceptedAt && !Number.isFinite(Date.parse(lastAcceptedAt)))) {
    return unavailable;
  }
  return {
    state: payload.paused
      ? "paused"
      : counts.rejected > 0
        ? "attention"
        : counts.pending + counts.retryable + counts.inFlight > 0
          ? "active"
          : counts.accepted > 0
            ? "idle"
            : "empty",
    paused: payload.paused,
    counts,
    dueNow: count(payload.dueNow, 0),
    nextAttemptAt,
    lastAcceptedAt
  };
}

export function normalizeAutomaticContributionStatus(payload) {
  const unavailable = Object.freeze({
    state: "unavailable",
    enabled: false,
    intervalHours: 6,
    consentCurrent: false,
    firstReviewComplete: false,
    firstReviewedAcceptedAt: "",
    requiredConsent: null,
    consentedAt: "",
    lastAttemptAt: "",
    lastSuccessAt: "",
    nextAttemptAt: "",
    lastOutcome: null,
    foregroundOnly: true,
    daemonInstalled: false
  });
  const exactKeys = [
    "schemaVersion",
    "status",
    "enabled",
    "intervalHours",
    "consentCurrent",
    "firstReviewComplete",
    "firstReviewedAcceptedAt",
    "requiredConsent",
    "consentedAt",
    "lastAttemptAt",
    "lastSuccessAt",
    "nextAttemptAt",
    "lastOutcome",
    "foregroundOnly",
    "daemonInstalled",
    "networkActivity",
    "includesContent",
    "includesPaths",
    "includesIdentifiers",
    "includesCredentials"
  ];
  const states = new Set([
    "not_configured",
    "disabled",
    "first_review_required",
    "scheduled",
    "running",
    "paused",
    "consent_required",
    "failed"
  ]);
  if (!hasExactKeys(payload, exactKeys)
      || payload.schemaVersion !== AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION
      || !states.has(payload.status)
      || typeof payload.enabled !== "boolean"
      || payload.intervalHours !== 6
      || typeof payload.consentCurrent !== "boolean"
      || typeof payload.firstReviewComplete !== "boolean"
      || payload.foregroundOnly !== true
      || payload.daemonInstalled !== false
      || payload.networkActivity !== false
      || payload.includesContent !== false
      || payload.includesPaths !== false
      || payload.includesIdentifiers !== false
      || payload.includesCredentials !== false) {
    return unavailable;
  }

  const requiredConsentKeys = [
    "telemetrySchemaVersion",
    "fieldDictionaryVersion",
    "privacyContractVersion",
    "destinationOrigin"
  ];
  const requiredConsent = payload.requiredConsent;
  const destination = text(requiredConsent?.destinationOrigin, "");
  let validDestination = requiredConsent?.destinationOrigin === null;
  if (destination) {
    try {
      const origin = new URL(destination);
      const production = origin.protocol === "https:"
        && !origin.port
        && origin.hostname !== "localhost"
        && origin.hostname !== "127.0.0.1";
      const localDevelopment = origin.protocol === "http:"
        && origin.hostname === "127.0.0.1"
        && /^[1-9][0-9]{0,4}$/u.test(origin.port)
        && Number(origin.port) <= 65_535;
      validDestination = (production || localDevelopment)
        && !origin.username
        && !origin.password
        && origin.pathname === "/"
        && !origin.search
        && !origin.hash
        && origin.origin === destination;
    } catch {
      validDestination = false;
    }
  }
  if (!hasExactKeys(requiredConsent, requiredConsentKeys)
      || requiredConsent.telemetrySchemaVersion !== "telemetry-contribution-v0.1"
      || requiredConsent.fieldDictionaryVersion
        !== "telemetry-v0.1-registry-2026-07-25.3"
      || requiredConsent.privacyContractVersion
        !== "ongoing-privacy-safe-telemetry-v0.1"
      || !validDestination
      || (payload.status === "not_configured"
        ? requiredConsent.destinationOrigin !== null
        : requiredConsent.destinationOrigin === null)) {
    return unavailable;
  }

  const alwaysEnabledStates = new Set(["scheduled", "running", "paused"]);
  const neverEnabledStates = new Set([
    "not_configured",
    "disabled",
    "first_review_required",
    "consent_required"
  ]);
  if (payload.enabled !== payload.consentCurrent
      || (alwaysEnabledStates.has(payload.status) && !payload.enabled)
      || (neverEnabledStates.has(payload.status) && payload.enabled)) {
    return unavailable;
  }

  const timestamp = (value) => {
    if (value === null) return "";
    const selected = text(value, "");
    return selected
      && Number.isFinite(Date.parse(selected))
      && new Date(Date.parse(selected)).toISOString() === selected
      ? selected
      : null;
  };
  const consentedAt = timestamp(payload.consentedAt);
  const firstReviewedAcceptedAt = timestamp(payload.firstReviewedAcceptedAt);
  const lastAttemptAt = timestamp(payload.lastAttemptAt);
  const lastSuccessAt = timestamp(payload.lastSuccessAt);
  const nextAttemptAt = timestamp(payload.nextAttemptAt);
  if ([
    consentedAt,
    firstReviewedAcceptedAt,
    lastAttemptAt,
    lastSuccessAt,
    nextAttemptAt
  ]
    .some((value) => value === null)) {
    return unavailable;
  }
  const statusMayLackFirstReview = new Set([
    "not_configured",
    "failed",
    "first_review_required"
  ]);
  if (payload.firstReviewComplete !== Boolean(firstReviewedAcceptedAt)
      || (payload.firstReviewComplete
        && ["not_configured", "first_review_required"].includes(payload.status))
      || (!payload.firstReviewComplete
        && !statusMayLackFirstReview.has(payload.status))) {
    return unavailable;
  }

  let lastOutcome = null;
  if (payload.lastOutcome !== null) {
    const outcomeCodesByStatus = new Map([
      ["succeeded", new Set(["accepted", "completed"])],
      ["skipped", new Set(["no_new_evidence"])],
      ["failed", new Set([
        "retry_scheduled",
        "delivery_rejected",
        "preparation_failed",
        "publication_incomplete",
        "upload_failed",
        "run_timeout"
      ])],
      ["paused", new Set([
        "queue_paused",
        "privacy_verification_failed",
        "identity_unavailable"
      ])]
    ]);
    const at = timestamp(payload.lastOutcome?.at);
    if (!hasExactKeys(payload.lastOutcome, ["status", "code", "at"])
        || !outcomeCodesByStatus
          .get(payload.lastOutcome.status)
          ?.has(payload.lastOutcome.code)
        || !at) {
      return unavailable;
    }
    lastOutcome = Object.freeze({
      status: payload.lastOutcome.status,
      code: payload.lastOutcome.code,
      at
    });
  }

  return Object.freeze({
    state: payload.status,
    enabled: payload.enabled,
    intervalHours: 6,
    consentCurrent: payload.consentCurrent,
    firstReviewComplete: payload.firstReviewComplete,
    firstReviewedAcceptedAt,
    requiredConsent: Object.freeze({
      telemetrySchemaVersion: requiredConsent.telemetrySchemaVersion,
      fieldDictionaryVersion: requiredConsent.fieldDictionaryVersion,
      privacyContractVersion: requiredConsent.privacyContractVersion,
      destinationOrigin: requiredConsent.destinationOrigin
    }),
    consentedAt,
    lastAttemptAt,
    lastSuccessAt,
    nextAttemptAt,
    lastOutcome,
    foregroundOnly: true,
    daemonInstalled: false
  });
}

export function normalizeContributionSyncPreview(payload) {
  const unavailable = {
    status: "unavailable",
    state: "unavailable",
    discoveredSets: 0,
    newlyQueued: 0,
    deliveryConfigured: false,
    item: null
  };
  if (payload?.schemaVersion !== CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION
      || !["available", "not_configured", "unavailable"].includes(payload?.status)
      || payload?.networkActivity !== false
      || payload?.includesContent !== false
      || payload?.includesPaths !== false
      || payload?.includesIdentifiers !== false
      || payload?.includesCredentials !== false
      || typeof payload?.deliveryConfigured !== "boolean") {
    return unavailable;
  }
  if (payload.status !== "available") {
    return { ...unavailable, status: payload.status };
  }
  if (!["empty", "ready", "retry_wait", "paused"].includes(payload.state)) {
    return unavailable;
  }
  const discoveredSets = count(payload.discoveredSets, null);
  const newlyQueued = count(payload.newlyQueued, null);
  if (discoveredSets === null || newlyQueued === null) return unavailable;
  if (payload.state === "empty") {
    return payload.item === null
      ? {
        status: "available",
        state: "empty",
        discoveredSets,
        newlyQueued,
        deliveryConfigured: payload.deliveryConfigured,
        item: null
      }
      : unavailable;
  }
  const item = payload.item;
  const names = ["usageEvents", "quotaSnapshots", "activityMarkers", "total"];
  const recordCounts = Object.fromEntries(names.map((name) => [
    name,
    count(item?.recordCounts?.[name], null)
  ]));
  const coveredStart = text(item?.coveredAt?.startAt, "");
  const coveredEnd = text(item?.coveredAt?.endAt, "");
  const estimatedCost = item?.accounting?.estimatedApiCostUsd;
  const coverage = finite(item?.accounting?.pricedEventCoveragePercent, null);
  const unknownModels = count(item?.accounting?.unknownModelEventCount, null);
  const unknownUnits = count(item?.accounting?.unknownBillableUnits, null);
  const preparedBytes = count(item?.preparedBytes, null);
  const reservedUploadBytes = count(item?.reservedUploadBytes, null);
  const attemptCount = count(item?.attemptCount, null);
  const nextAttemptAt = text(item?.nextAttemptAt, "");
  const valid = item?.schemaVersion === "telemetry-contribution-v0.1"
    && ["macos", "linux", "windows", "other", "unknown"]
      .includes(item?.clientPlatform)
    && [
      "unknown",
      "openai_pre_agentic_pool_2026_07_09",
      "openai_agentic_pool_2026_07_09",
      "anthropic_unknown"
    ].includes(item?.providerPolicyEpoch)
    && coveredStart && coveredEnd
    && Number.isFinite(Date.parse(coveredStart))
    && Number.isFinite(Date.parse(coveredEnd))
    && Object.values(recordCounts).every((value) => value !== null)
    && recordCounts.total === recordCounts.usageEvents
      + recordCounts.quotaSnapshots + recordCounts.activityMarkers
    && (estimatedCost === null
      || (typeof estimatedCost === "string"
        && /^(?:0|[1-9]\d*)\.\d{6}$/.test(estimatedCost)))
    && coverage !== null && coverage >= 0 && coverage <= 100
    && unknownModels !== null && unknownUnits !== null
    && ["current_api_prices", "historical_api_prices", "unpriced"]
      .includes(item?.accounting?.priceBasis)
    && item?.accounting?.verification === "client_declared_unverified"
    && preparedBytes !== null && reservedUploadBytes !== null
    && reservedUploadBytes >= preparedBytes
    && attemptCount !== null
    && nextAttemptAt && Number.isFinite(Date.parse(nextAttemptAt));
  if (!valid) return unavailable;
  return {
    status: "available",
    state: payload.state,
    discoveredSets,
    newlyQueued,
    deliveryConfigured: payload.deliveryConfigured,
    item: {
      clientPlatform: item.clientPlatform,
      providerPolicyEpoch: item.providerPolicyEpoch,
      coveredAt: { startAt: coveredStart, endAt: coveredEnd },
      recordCounts,
      accounting: {
        estimatedApiCostUsd: estimatedCost,
        pricedEventCoveragePercent: coverage,
        unknownModelEventCount: unknownModels,
        unknownBillableUnits: unknownUnits,
        priceBasis: item.accounting.priceBasis
      },
      preparedBytes,
      reservedUploadBytes,
      attemptCount,
      nextAttemptAt
    }
  };
}

export function normalizeContributionSyncRun(payload) {
  const unavailable = {
    status: "unavailable",
    discoveredSets: 0,
    newlyQueued: 0,
    processed: 0,
    accepted: 0,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 0,
    bandwidthLimited: false
  };
  if (payload?.schemaVersion !== CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION
      || !["completed", "paused", "interrupted"].includes(payload?.status)
      || typeof payload?.bandwidthLimited !== "boolean"
      || payload?.includesContent !== false
      || payload?.includesPaths !== false
      || payload?.includesIdentifiers !== false
      || payload?.includesCredentials !== false) {
    return unavailable;
  }
  const names = [
    "discoveredSets",
    "newlyQueued",
    "processed",
    "accepted",
    "retryable",
    "rejected",
    "reservedUploadBytes"
  ];
  const values = Object.fromEntries(names.map((name) => [
    name,
    count(payload[name], null)
  ]));
  if (Object.values(values).some((value) => value === null)) return unavailable;
  return {
    status: payload.status,
    ...values,
    bandwidthLimited: payload.bandwidthLimited
  };
}

export function normalizeLocalContributionPreparation(payload) {
  const unavailable = {
    status: "unavailable",
    coveredAt: { startAt: "", endAt: "" },
    recordCounts: {
      usageEvents: 0,
      quotaSnapshots: 0,
      activityMarkers: 0
    },
    privacy: {
      verdict: "unavailable",
      checksPassed: 0,
      checksFailed: 0,
      provenanceRetained: false
    },
    prepared: { batchCount: 0, bytes: 0 }
  };
  const startAt = text(payload?.coveredAt?.startAt, "");
  const endAt = text(payload?.coveredAt?.endAt, "");
  const usageEvents = count(payload?.recordCounts?.usageEvents, null);
  const quotaSnapshots = count(payload?.recordCounts?.quotaSnapshots, null);
  const activityMarkers = count(payload?.recordCounts?.activityMarkers, null);
  const checksPassed = count(payload?.privacy?.checksPassed, null);
  const checksFailed = count(payload?.privacy?.checksFailed, null);
  const batchCount = count(payload?.prepared?.batchCount, null);
  const bytes = count(payload?.prepared?.bytes, null);
  const valid = payload?.schemaVersion
      === LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION
    && payload?.status === "prepared"
    && startAt && endAt
    && Number.isFinite(Date.parse(startAt))
    && Number.isFinite(Date.parse(endAt))
    && Date.parse(endAt) > Date.parse(startAt)
    && [usageEvents, quotaSnapshots, activityMarkers, checksPassed,
      checksFailed, batchCount, bytes].every((value) => value !== null)
    && payload?.privacy?.verdict === "passed"
    && checksFailed === 0
    && payload?.privacy?.sourceTransportReady === false
    && payload?.privacy?.provenanceRetained === true
    && payload?.prepared?.schemaVersion
      === "prepared-contribution-set-v0.1"
    && payload?.prepared?.eligibleSchemaVersion
      === "telemetry-contribution-v0.1"
    && batchCount > 0
    && payload?.networkActivity === false
    && payload?.includesContent === false
    && payload?.includesPaths === false
    && payload?.includesIdentifiers === false
    && payload?.includesCredentials === false;
  if (!valid) return unavailable;
  return {
    status: "prepared",
    coveredAt: { startAt, endAt },
    recordCounts: { usageEvents, quotaSnapshots, activityMarkers },
    privacy: {
      verdict: "passed",
      checksPassed,
      checksFailed: 0,
      provenanceRetained: true
    },
    prepared: { batchCount, bytes }
  };
}

export function normalizeLocalContributionDevicePairing(payload) {
  const unavailable = {
    status: "unavailable",
    scope: null,
    expiresAt: ""
  };
  const expiresAt = text(payload?.expiresAt, "");
  if (payload?.schemaVersion !== LOCAL_CONTRIBUTION_DEVICE_PAIRING_VERSION
      || payload?.status !== "paired"
      || payload?.scope !== "upload_registration"
      || !Number.isFinite(Date.parse(expiresAt))
      || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt
      || payload?.includesCredentials !== false
      || payload?.includesIdentifiers !== false) {
    return unavailable;
  }
  return {
    status: "paired",
    scope: "upload_registration",
    expiresAt
  };
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

export function normalizeCommunitySnapshot(payload) {
  if (!payload) return { state: "service_unavailable", cells: [] };
  if (payload.publicationStatus === "development_diagnostic_not_publication_safe") {
    return { state: "development_unsafe", cells: [] };
  }
  if (payload.schemaVersion !== COMMUNITY_SNAPSHOT_SCHEMA_VERSION
      || payload.immutable !== true
      || payload.nonOverlapping !== true) {
    return { state: "unsupported_schema", cells: [] };
  }

  const base = {
    snapshotId: text(payload.snapshotId, ""),
    period: {
      startAt: text(payload.period?.startAt, ""),
      endAt: text(payload.period?.endAt, "")
    },
    ingestionCutoffAt: text(payload.ingestionCutoffAt, ""),
    releasedAt: text(payload.releasedAt, ""),
    policyVersion: text(payload.privacyPolicy?.version, ""),
    minimumIndependentParticipants: finite(
      payload.privacyPolicy?.minimumIndependentParticipants,
      null
    ),
    cells: []
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
      || !Number.isSafeInteger(base.minimumIndependentParticipants)
      || base.minimumIndependentParticipants < 3
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...base, state: "unsupported_schema" };
  }

  const cells = [];
  let partial = false;
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!provider || !modelId || !candidate.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...base, state: "unsupported_schema" };
    }
    const planType = text(candidate?.planType, "unknown");
    const planVariant = text(candidate?.planVariant, "unknown");
    const metrics = {};
    for (const [metricName, expectedUnit] of Object.entries(COMMUNITY_METRIC_UNITS)) {
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
    cells
  };
}

function normalizeQuotaMovement(payload) {
  const status = text(payload?.status, "not_testable");
  const base = {
    schemaVersion: text(payload?.schemaVersion, ""),
    status: status === "conditional_estimate" ? status : "not_testable",
    reason: text(payload?.reason, status === "conditional_estimate" ? "" : "insufficient_quota_observations"),
    interpretation: text(payload?.interpretation, ""),
    accountContinuity: text(payload?.accountContinuity, "not_transmitted"),
    provider: text(payload?.provider, ""),
    planType: text(payload?.planType, ""),
    planVariant: text(payload?.planVariant, ""),
    limitId: text(payload?.limitId, ""),
    slot: text(payload?.slot, ""),
    resetsAt: text(payload?.resetsAt, ""),
    apiPriceEquivalentCapacityUsd: nonNegative(payload?.apiPriceEquivalentCapacityUsd, null),
    observedUsedPercentSpan: finite(payload?.observedUsedPercentSpan, null),
    pricedUsageUsd: nonNegative(payload?.pricedUsageUsd, null),
    rows: []
  };
  if (base.status !== "conditional_estimate") return base;

  base.rows = array(payload?.rows).slice(0, 6000).flatMap((row) => {
    const smoothingHours = count(row?.smoothingHours, null);
    const timestamp = text(row?.timestamp ?? row?.windowEndUtc, "");
    const windowStartUtc = text(row?.windowStartUtc, "");
    const windowEndUtc = text(row?.windowEndUtc ?? row?.timestamp, "");
    const observedQuotaChangePp = finite(row?.observedQuotaChangePp, null);
    const expectedQuotaChangePp = finite(row?.expectedQuotaChangePp, null);
    const apiPriceEquivalentUsd = nonNegative(row?.apiPriceEquivalentUsd, null);
    const usageEvents = count(row?.usageEvents, null);
    if (![1, 2, 3].includes(smoothingHours)
        || !Number.isFinite(Date.parse(timestamp))
        || !Number.isFinite(Date.parse(windowStartUtc))
        || !Number.isFinite(Date.parse(windowEndUtc))
        || observedQuotaChangePp === null
        || expectedQuotaChangePp === null
        || apiPriceEquivalentUsd === null
        || usageEvents === null) {
      return [];
    }
    return [{
      smoothingHours,
      timestamp,
      windowStartUtc,
      windowEndUtc,
      observedQuotaChangePp,
      expectedQuotaChangePp,
      apiPriceEquivalentUsd,
      usageEvents
    }];
  });
  if (!base.rows.length) {
    base.status = "not_testable";
    base.reason = "no_valid_rolling_rows";
  }
  return base;
}

function normalizeAccountScopedQuotaAnalysis(payload) {
  const unavailable = {
    status: "not_testable",
    reason: text(payload?.reason, "account_scoped_dataset_unavailable"),
    tracks: []
  };
  if (payload?.schemaVersion !== "account-scoped-quota-analysis-v0.1") {
    return unavailable;
  }
  if (payload.status !== "ready" || !Array.isArray(payload.tracks)) {
    return unavailable;
  }
  const tracks = payload.tracks.slice(0, 20).flatMap((source, index) => {
    const continuity = source?.continuity ?? {};
    const windowDurationMinutes = count(continuity.windowDurationMinutes, null);
    if (
      !["openai_codex", "anthropic_claude_code"].includes(continuity.provider)
      || ![300, 10_080].includes(windowDurationMinutes)
    ) {
      return [];
    }
    const calibrationTrack = array(source?.calibration?.tracks)[0] ?? {};
    const resetRows = array(calibrationTrack.resets);
    const estimates = resetRows.filter((row) => (
      row?.status === "conditional_estimate"
      && nonNegative(row?.capacityNanousd, null) !== null
    ));
    const latestEstimate = estimates.at(-1) ?? null;
    const range = latestEstimate?.sensitivityRangeNanousd;
    const rollingComparisons = source?.rolling?.status === "conditional_comparison"
      ? array(source?.rolling?.comparisons)
      : [];
    return [{
      index: index + 1,
      provider: text(continuity.provider, ""),
      planType: text(continuity.planType, "unknown"),
      planVariant: text(continuity.planVariant, "unknown"),
      limitId: text(continuity.limitId, "unknown"),
      windowDurationMinutes,
      policyEpoch: text(continuity.policyEpoch, "unknown"),
      totalResets: count(calibrationTrack.totalResetCount, resetRows.length),
      estimatedResets: count(calibrationTrack.estimatedResetCount, estimates.length),
      latestCapacityUsd: latestEstimate
        ? nonNegative(latestEstimate.capacityNanousd, null) / 1_000_000_000
        : null,
      sensitivityLowerUsd: nonNegative(range?.lower, null) === null
        ? null
        : range.lower / 1_000_000_000,
      sensitivityUpperUsd: nonNegative(range?.upper, null) === null
        ? null
        : range.upper / 1_000_000_000,
      boundaryCount: count(latestEstimate?.boundaryCount, null),
      displayedSpanPp: finite(latestEstimate?.displayedSpanPp, null),
      refusalCodes: [...new Set(resetRows.flatMap((row) => (
        Array.isArray(row?.refusalCodes)
          ? row.refusalCodes.filter((code) => typeof code === "string").slice(0, 10)
          : []
      )))].slice(0, 10),
      rollingStatus: text(source?.rolling?.status, "not_testable"),
      rollingRefusalCodes: array(source?.rolling?.refusalCodes)
        .filter((code) => typeof code === "string")
        .slice(0, 10),
      rollingComparisonCount: rollingComparisons.length
    }];
  });
  return {
    status: tracks.length > 0 ? "ready" : "not_testable",
    reason: tracks.length > 0 ? "" : "supported_quota_track_unavailable",
    tracks
  };
}

export function normalizeParticipantCommunityComparison(payload) {
  const unavailable = {
    status: "not_testable",
    reason: text(payload?.reason, "stable_snapshot_unavailable"),
    snapshotId: text(payload?.snapshotId, ""),
    snapshotRevision: count(payload?.snapshotRevision, null),
    period: {
      startAt: text(payload?.period?.startAt, ""),
      endAt: text(payload?.period?.endAt, "")
    },
    cells: []
  };
  if (payload?.schemaVersion !== PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION) {
    return unavailable;
  }
  if (payload.status === "not_testable") return unavailable;
  if (payload.status !== "ready"
      || payload.interpretation !== "own_clipped_contribution_vs_public_rounded_total"
      || !unavailable.snapshotId
      || unavailable.snapshotRevision === null
      || unavailable.snapshotRevision < 1
      || !Number.isFinite(Date.parse(unavailable.period.startAt))
      || !Number.isFinite(Date.parse(unavailable.period.endAt))
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...unavailable, reason: "comparison_contract_invalid" };
  }
  const cells = [];
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!["openai_codex", "anthropic_claude_code"].includes(provider)
        || !modelId
        || typeof candidate?.participantHasActivity !== "boolean"
        || !candidate?.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...unavailable, reason: "comparison_contract_invalid" };
    }
    const metrics = {};
    for (const [metricName, expectedUnit] of Object.entries(
      PARTICIPANT_COMPARISON_METRIC_UNITS
    )) {
      const source = candidate.metrics[metricName];
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      if (source.status === "community_not_released") {
        metrics[metricName] = {
          status: "community_not_released",
          participantClippedValue: null,
          communityRoundedValue: null,
          unit: expectedUnit
        };
        continue;
      }
      const communityRoundedValue = count(source.communityRoundedValue, null);
      if (source.unit !== expectedUnit || communityRoundedValue === null) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      if (source.status === "participant_component_unavailable") {
        metrics[metricName] = {
          status: "participant_component_unavailable",
          participantClippedValue: null,
          communityRoundedValue,
          unit: expectedUnit
        };
        continue;
      }
      const participantClippedValue = count(source.participantClippedValue, null);
      if (source.status !== "comparable" || participantClippedValue === null) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      metrics[metricName] = {
        status: "comparable",
        participantClippedValue,
        communityRoundedValue,
        unit: expectedUnit
      };
    }
    cells.push({
      provider,
      planType: text(candidate?.planType, "unknown"),
      planVariant: text(candidate?.planVariant, "unknown"),
      cohortMatchesParticipant: candidate?.cohortMatchesParticipant === true,
      modelId,
      participantHasActivity: candidate.participantHasActivity,
      metrics
    });
  }
  return {
    ...unavailable,
    status: "ready",
    reason: "",
    participantPlanCohort: {
      planType: text(payload?.participantPlanCohort?.planType, "unknown"),
      planVariant: text(payload?.participantPlanCohort?.planVariant, "unknown")
    },
    cells
  };
}

export function normalizeParticipantHistory(payload) {
  const unknownAdmission = Object.freeze({
    state: "unknown",
    acceptedBatches: null,
    remainingBatches: null,
    maximumBatches: null,
    renewsAt: "",
    slotRefundPolicy: "",
  });
  const unavailable = (reason) => ({
    state: "not_available",
    reason,
    consentVersion: "",
    participantCreatedAt: "",
    contributionCount: 0,
    clientSoftwareVersion: "unavailable_in_transport",
    contributionAdmission: unknownAdmission,
    items: []
  });
  if (!payload) return unavailable("service_unavailable");
  if (payload.schemaVersion !== PARTICIPANT_PROFILE_SCHEMA_VERSION) {
    return unavailable("unsupported_schema");
  }
  if (!PARTICIPANT_CONSENT_VERSIONS.has(payload.consentVersion)
      || !Number.isFinite(Date.parse(payload.createdAt))
      || !Array.isArray(payload.contributions)
      || payload.contributions.length > 101
      || count(payload.contributionCount, null) !== payload.contributions.length
      || count(payload.historyPolicy?.maximumItems, null) !== 101
      || count(payload.historyPolicy?.quarantineRetentionMilliseconds, null)
        !== 7 * 24 * 60 * 60 * 1000
      || payload.historyPolicy?.canonicalMetadataRetainedAfterQuarantine !== true
      || payload.historyPolicy?.clientSoftwareVersion !== "unavailable_in_transport") {
    return unavailable("invalid_contract");
  }

  const items = [];
  const contributionIds = new Set();
  for (const candidate of payload.contributions) {
    const contributionId = text(candidate?.contributionId, "");
    const status = text(candidate?.status, "");
    const schemaVersion = text(candidate?.schemaVersion, "");
    const transportSchemaVersion = text(candidate?.transportSchemaVersion, "");
    const createdAt = text(candidate?.createdAt, "");
    const startAt = text(candidate?.coveredAt?.startAt, "");
    const endAt = text(candidate?.coveredAt?.endAt, "");
    const clientPlatform = text(candidate?.clientPlatform, "");
    const providerPolicyEpoch = text(candidate?.providerPolicyEpoch, "");
    const quarantineState = text(candidate?.quarantine?.state, "");
    const scheduledDeletionAt = text(candidate?.quarantine?.scheduledDeletionAt, "");
    const deletedAt = candidate?.quarantine?.deletedAt === null
      ? null
      : text(candidate?.quarantine?.deletedAt, "");
    const createdEpoch = Date.parse(createdAt);
    const startEpoch = Date.parse(startAt);
    const endEpoch = Date.parse(endAt);
    const scheduledEpoch = Date.parse(scheduledDeletionAt);
    const deletedEpoch = deletedAt === null ? null : Date.parse(deletedAt);
    if (!CONTRIBUTION_ID_PATTERN.test(contributionId)
        || contributionIds.has(contributionId)
        || !["accepted", "accepted_synthetic", "deleting"].includes(status)
        || typeof candidate?.synthetic !== "boolean"
        || !CONTRIBUTION_SCHEMA_VERSIONS.has(schemaVersion)
        || !CONTRIBUTION_SCHEMA_VERSIONS.has(transportSchemaVersion)
        || (candidate.synthetic
          && (schemaVersion !== "synthetic-contribution-v0.1"
            || transportSchemaVersion !== "synthetic-contribution-v0.1"
            || !["accepted_synthetic", "deleting"].includes(status)))
        || (!candidate.synthetic
          && (schemaVersion === "synthetic-contribution-v0.1"
            || transportSchemaVersion === "synthetic-contribution-v0.1"
            || !["accepted", "deleting"].includes(status)))
        || !["macos", "linux", "windows", "other", "unknown"].includes(clientPlatform)
        || !CONTRIBUTION_POLICY_EPOCHS.has(providerPolicyEpoch)
        || !Number.isFinite(createdEpoch)
        || !Number.isFinite(startEpoch)
        || !Number.isFinite(endEpoch)
        || endEpoch < startEpoch
        || !Number.isFinite(scheduledEpoch)
        || scheduledEpoch !== createdEpoch + (7 * 24 * 60 * 60 * 1000)
        || !["retained", "deleted"].includes(quarantineState)
        || (quarantineState === "retained" && deletedAt !== null)
        || (quarantineState === "deleted"
          && (deletedAt === null
            || !Number.isFinite(deletedEpoch)
            || deletedEpoch < createdEpoch))
        || candidate?.quarantine?.canonicalMetadataRetained !== true) {
      return unavailable("invalid_contract");
    }
    contributionIds.add(contributionId);

    let recordCounts = null;
    if (candidate.recordCounts !== null) {
      const declared = count(candidate?.recordCounts?.declared, null);
      const accepted = count(candidate?.recordCounts?.accepted, null);
      const deduplicated = count(candidate?.recordCounts?.deduplicated, null);
      if (declared === null || accepted === null || deduplicated === null
          || accepted + deduplicated !== declared) {
        return unavailable("invalid_contract");
      }
      recordCounts = { declared, accepted, deduplicated };
    }

    const priceVerification = text(candidate?.serverAccounting?.verification, "");
    const serverPrice = priceVerification === "server_repriced"
      ? nonNegative(candidate?.serverAccounting?.apiPriceEquivalentUsd, null)
      : null;
    if (!["server_repriced", "server_repricing_unavailable"].includes(priceVerification)
        || (priceVerification === "server_repriced" && serverPrice === null)
        || (priceVerification === "server_repricing_unavailable"
          && candidate?.serverAccounting?.apiPriceEquivalentUsd !== null)) {
      return unavailable("invalid_contract");
    }

    items.push({
      contributionId,
      status,
      synthetic: candidate?.synthetic === true,
      schemaVersion,
      transportSchemaVersion,
      createdAt,
      coveredAt: { startAt, endAt },
      clientPlatform,
      providerPolicyEpoch,
      recordCounts,
      serverAccounting: {
        apiPriceEquivalentUsd: serverPrice,
        verification: priceVerification
      },
      quarantine: {
        state: quarantineState,
        scheduledDeletionAt,
        deletedAt,
        canonicalMetadataRetained: true
      }
    });
  }
  items.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
      || right.contributionId.localeCompare(left.contributionId)
  ));
  const admission = payload.contributionAdmission;
  let contributionAdmission = unknownAdmission;
  if (admission !== undefined && admission !== null) {
    const acceptedBatches = count(admission?.acceptedBatches, null);
    const remainingBatches = count(admission?.remainingBatches, null);
    const maximumBatches = count(admission?.maximumBatches, null);
    const startsAt = text(admission?.window?.startsAt, "");
    const renewsAt = text(admission?.window?.endsAt, "");
    const startsAtEpoch = Date.parse(startsAt);
    const renewsAtEpoch = Date.parse(renewsAt);
    const durationMilliseconds = count(
      admission?.window?.durationMilliseconds,
      null,
    );
    const validAdmission =
      admission?.schemaVersion === "telemetry-contribution-admission-v0.1"
      && ["available", "exhausted"].includes(admission?.state)
      && admission?.window?.kind === "fixed_utc"
      && admission?.window?.anchor === "monday_00_00_utc"
      && Number.isFinite(startsAtEpoch)
      && Number.isFinite(renewsAtEpoch)
      && renewsAtEpoch > startsAtEpoch
      && durationMilliseconds === renewsAtEpoch - startsAtEpoch
      && acceptedBatches !== null
      && remainingBatches !== null
      && maximumBatches !== null
      && maximumBatches > 0
      && acceptedBatches + remainingBatches === maximumBatches
      && admission.state === (remainingBatches > 0 ? "available" : "exhausted")
      && admission?.slotRefundPolicy
        === "not_refunded_by_contribution_deletion";
    if (!validAdmission) return unavailable("invalid_contract");
    contributionAdmission = Object.freeze({
      state: admission.state,
      acceptedBatches,
      remainingBatches,
      maximumBatches,
      renewsAt,
      slotRefundPolicy: admission.slotRefundPolicy,
    });
  }
  return {
    state: "ready",
    reason: "",
    consentVersion: payload.consentVersion,
    participantCreatedAt: payload.createdAt,
    contributionCount: items.length,
    clientSoftwareVersion: "unavailable_in_transport",
    contributionAdmission,
    items
  };
}

export function normalizeParticipantStats(payload) {
  if (!payload) {
    return {
      state: "service_unavailable",
      schemaVersion: "",
      totals: {},
      pricingCoverage: { state: "not_testable" },
      standardApiCounterfactual: { state: "not_testable", apiPriceEquivalentUsd: null },
      codexFastObservations: { state: "not_testable", eventShare: null, eventCount: null },
      rollingQuotaMovement: normalizeQuotaMovement(null),
      accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(null),
      communityComparison: normalizeParticipantCommunityComparison(null)
    };
  }
  if (payload.schemaVersion !== PARTICIPANT_STATS_SCHEMA_VERSION) {
    return {
      state: "unsupported_schema",
      schemaVersion: text(payload?.schemaVersion, ""),
      totals: {},
      pricingCoverage: { state: "not_testable" },
      standardApiCounterfactual: { state: "not_testable", apiPriceEquivalentUsd: null },
      codexFastObservations: { state: "not_testable", eventShare: null, eventCount: null },
      rollingQuotaMovement: normalizeQuotaMovement(null),
      accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(null),
      communityComparison: normalizeParticipantCommunityComparison(null)
    };
  }

  const source = payload.totals ?? {};
  const usageEvents = count(source.usageEvents, null);
  const fullyPricedEvents = count(source.fullyPricedEvents, null);
  const partiallyPricedEvents = count(source.partiallyPricedEvents, null);
  const unpricedEvents = count(source.unpricedEvents, null);
  const classifiedEvents = [fullyPricedEvents, partiallyPricedEvents, unpricedEvents]
    .every((value) => value !== null)
    ? fullyPricedEvents + partiallyPricedEvents + unpricedEvents
    : null;
  const classifiedWithinTotal = usageEvents !== null
    && classifiedEvents !== null
    && classifiedEvents <= usageEvents;
  const pricedEvents = classifiedWithinTotal
    ? fullyPricedEvents + partiallyPricedEvents
    : null;
  const pricingCoveragePercent = usageEvents > 0 && pricedEvents !== null
    ? Number((pricedEvents * 100 / usageEvents).toFixed(6))
    : null;
  let pricingCoverageState = "unknown";
  if (usageEvents === 0) pricingCoverageState = "not_testable";
  else if (classifiedWithinTotal && pricedEvents === 0) pricingCoverageState = "unpriced";
  else if (classifiedWithinTotal
      && fullyPricedEvents === usageEvents
      && partiallyPricedEvents === 0
      && unpricedEvents === 0) {
    pricingCoverageState = "fully_priced";
  } else if (classifiedWithinTotal && pricedEvents > 0) {
    pricingCoverageState = "partially_priced";
  }

  const priceVerification = text(source.priceVerification, "");
  const apiPriceEquivalentUsd = priceVerification === "server_repriced"
    ? nonNegative(source.apiPriceEquivalentUsd, null)
    : null;
  const standardSource = payload.standardApiCounterfactual
    ?? source.standardApiCounterfactual
    ?? {};
  const standardApiPriceEquivalentUsd = nonNegative(
    source.standardApiCounterfactualUsd
      ?? standardSource.apiPriceEquivalentUsd,
    null
  );
  const standardEvents = count(
    source.standardApiCounterfactualEvents
      ?? standardSource.events,
    null
  );
  const fastInsight = array(payload.insights).find((item) => item?.code === "fast_event_share");
  const fastEventShare = finite(
    source.fastEventShare
      ?? payload.codexFastObservations?.eventShare
      ?? fastInsight?.value,
    null
  );
  const safeFastEventShare = fastEventShare !== null && fastEventShare >= 0 && fastEventShare <= 1
    ? fastEventShare
    : null;
  const fastEventCount = count(
    source.fastEvents
      ?? payload.codexFastObservations?.eventCount,
    null
  );

  return {
    state: "ready",
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    generatedAt: text(payload.generatedAt, ""),
    totals: {
      contributions: count(source.contributions, null),
      usageEvents,
      quotaSnapshots: count(source.quotaSnapshots, null),
      activityMarkers: count(source.activityMarkers, null),
      apiPriceEquivalentUsd,
      priceVerification,
      serverUnknownBillableUnits: count(source.serverUnknownBillableUnits, null)
    },
    pricingCoverage: {
      state: pricingCoverageState,
      percent: pricingCoveragePercent,
      fullyPricedEvents,
      partiallyPricedEvents,
      unpricedEvents,
      unclassifiedEvents: classifiedWithinTotal ? usageEvents - classifiedEvents : null
    },
    standardApiCounterfactual: {
      state: standardApiPriceEquivalentUsd === null ? "not_separately_returned" : "server_repriced",
      apiPriceEquivalentUsd: standardApiPriceEquivalentUsd,
      events: standardEvents,
      basis: text(
        source.standardApiCounterfactualBasis
          ?? standardSource.basis,
        "subscription_standard_counterfactual"
      )
    },
    codexFastObservations: {
      state: safeFastEventShare === null && fastEventCount === null ? "not_testable" : "observed",
      eventShare: safeFastEventShare,
      eventCount: fastEventCount
    },
    rollingQuotaMovement: normalizeQuotaMovement(payload.rollingQuotaMovement),
    accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(
      payload.accountScopedQuotaAnalysis
    ),
    communityComparison: normalizeParticipantCommunityComparison(
      payload.communityComparison
    )
  };
}

function artifactData(payload) {
  return payload?.snapshot?.datasets ?? payload?.datasets ?? payload ?? {};
}

const LOCAL_COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens"
]);
const LOCAL_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-4.1",
  "unknown"
]);
const MONITORING_GAP_COPY = Object.freeze({
  quota_snapshots: ["Quota snapshots", "Current provider quota windows and their freshness."],
  account_attribution: ["Account attribution", "Whether quota and usage can be tied safely to one pseudonymous local account scope."],
  fast_mode: ["Fast-mode accounting", "Fast is observed separately from the Standard API-price counterfactual; its quota multiplier remains empirical."],
  subagents: ["Subagents and child rollouts", "Lineage-aware accounting excludes inherited parent snapshots before attributing genuine child-rollout increments; ambiguous lineage remains unknown."],
  shared_pool_surfaces: ["Work, Workspace Agents, Excel and connected Voice", "These shared-pool surfaces may not write complete local Codex evidence."],
  third_party_auth: ["Third-party ChatGPT-authenticated apps", "No complete local accounting source is available for third-party authenticated apps."],
  reasoning_effort: ["Reasoning effort", "Current retained usage snapshots do not expose a reasoning-effort field."],
  api_service_tier: ["API service tier", "Subscription speed is separate; API standard, priority and flex are never inferred from it."],
  provider_accounting_changes: ["Provider resets and accounting changes", "Reset propagation, credits, account tracks, and provider-side rule changes can move the observed allowance without a matching local usage increment."],
  unknown_token_components: ["Combined output components", "Some older snapshots expose only one combined output count. It is retained once and never added to separated text and reasoning output."],
  calculation_disagreement: ["Calculated usage versus observed quota", "Residual periods remain visible for review and may reflect missing surfaces, uncertain prices, reset contamination, or provider-side accounting."],
  ordinary_chat: ["Ordinary Chat conversations", "Ordinary Chat is excluded from the shared agentic pool unless new provider evidence shows otherwise."]
});

function normalizeLocalComponents(value) {
  return Object.fromEntries(LOCAL_COMPONENT_KEYS.map((key) => [
    key,
    count(value?.[key], 0)
  ]));
}

function normalizeLocalComponentCosts(value) {
  return Object.fromEntries(LOCAL_COMPONENT_KEYS.map((key) => {
    const row = value?.[key] ?? {};
    return [key, {
      tokens: count(row.tokens, 0),
      pricedTokens: count(row.pricedTokens, 0),
      unpricedTokens: count(row.unpricedTokens, 0),
      costUsd: nonNegative(row.costUsd, 0)
    }];
  }));
}

function normalizeAccountingDimension(value, allowedKeys) {
  return Object.fromEntries([...allowedKeys].map((key) => {
    const row = value?.[key] ?? {};
    return [key, {
      events: count(row.events, 0),
      totalTokens: count(row.totalTokens, 0),
      apiPriceEquivalentUsd: nonNegative(row.apiPriceEquivalentUsd, 0)
    }];
  }));
}

function normalizeLocalTimeline(value = {}) {
  const usage = array(value.usage).slice(-3_000).flatMap((row) => {
    const startAt = text(row?.startAt, "");
    const endAt = text(row?.endAt, "");
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    const usageEvents = count(row?.usageEvents, null);
    const totalTokens = count(row?.totalTokens, null);
    const cost = nonNegative(row?.apiPriceEquivalentUsd, null);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
        || usageEvents === null || totalTokens === null || cost === null) return [];
    return [{
      startAt,
      endAt,
      usageEvents,
      totalTokens,
      apiPriceEquivalentUsd: cost,
      components: normalizeLocalComponents(row.components),
      pricingCoverage: {
        fullyPricedEvents: count(row?.pricingCoverage?.fullyPricedEvents, 0),
        partiallyPricedEvents: count(row?.pricingCoverage?.partiallyPricedEvents, 0),
        unpricedEvents: count(row?.pricingCoverage?.unpricedEvents, 0)
      }
    }];
  });
  const quota = array(value.quota).slice(-10_000).flatMap((row) => {
    const observedAt = text(row?.observedAt, "");
    const usedPercent = finite(row?.usedPercent, null);
    const remainingPercent = finite(row?.remainingPercent, null);
    const durationMinutes = count(row?.durationMinutes, null);
    const resetAt = row?.resetAt === null ? "" : text(row?.resetAt, "");
    if (!Number.isFinite(Date.parse(observedAt))
        || usedPercent === null || usedPercent < 0 || usedPercent > 100
        || remainingPercent === null || remainingPercent < 0 || remainingPercent > 100
        || (resetAt && !Number.isFinite(Date.parse(resetAt)))) return [];
    return [{
      observedAt,
      usedPercent,
      remainingPercent,
      durationMinutes,
      resetAt,
      limitId: ["codex", "codex_bengalfox", "unknown"].includes(row?.limitId)
        ? row.limitId
        : "unknown",
      slot: ["primary", "secondary", "unknown"].includes(row?.slot)
        ? row.slot
        : "unknown",
      planType: ["free", "plus", "pro", "team", "business", "enterprise", "unknown"]
        .includes(row?.planType) ? row.planType : "unknown",
      accountAttribution: row?.accountAttribution === "attributed_pseudonymous"
        ? "attributed_pseudonymous"
        : "unattributed"
    }];
  });
  return {
    bucketMinutes: count(value.bucketMinutes, 15),
    coveredAt: {
      startAt: text(value?.coveredAt?.startAt, ""),
      endAt: text(value?.coveredAt?.endAt, "")
    },
    usage,
    quota
  };
}

function normalizeLocalAccounting(value = {}) {
  const models = array(value.byModel).slice(0, 32).flatMap((row) => {
    if (!LOCAL_MODELS.has(row?.model)) return [];
    return [{
      model: row.model,
      events: count(row.events, 0),
      totalTokens: count(row.totalTokens, 0),
      apiPriceEquivalentUsd: nonNegative(row.apiPriceEquivalentUsd, 0)
    }];
  });
  const normalized = {
    periodId: ["24h", "7d", "30d", "all"].includes(value.periodId)
      ? value.periodId
      : "all",
    periodLabel: text(value.periodLabel, "Recorded period"),
    events: count(value.events, 0),
    totalTokens: count(value.totalTokens, 0),
    apiPriceEquivalentUsd: nonNegative(value.apiPriceEquivalentUsd, 0),
    pricingCoverage: {
      fullyPricedEvents: count(value?.pricingCoverage?.fullyPricedEvents, 0),
      partiallyPricedEvents: count(value?.pricingCoverage?.partiallyPricedEvents, 0),
      unpricedEvents: count(value?.pricingCoverage?.unpricedEvents, 0)
    },
    components: normalizeLocalComponents(value.components),
    componentCosts: normalizeLocalComponentCosts(value.componentCosts),
    byModel: models,
    bySpeed: normalizeAccountingDimension(
      value.bySpeed,
      new Set(["standard", "fast", "flex", "batch", "unknown"])
    ),
    byApiServiceTier: normalizeAccountingDimension(
      value.byApiServiceTier,
      new Set(["standard", "priority", "flex", "batch", "unknown"])
    ),
    bySurface: normalizeAccountingDimension(
      value.bySurface,
      new Set(["extension_or_ide", "scheduled_task", "subagent", "cli_exec", "work", "workspace_agent", "excel", "voice_task", "unknown"])
    ),
    byAgentScope: normalizeAccountingDimension(
      value.byAgentScope,
      new Set(["root", "subagent", "automation", "unknown"])
    ),
    byLineage: normalizeAccountingDimension(
      value.byLineage,
      new Set(["standalone", "forked", "parent_linked", "unknown"])
    ),
    byReasoningEffort: normalizeAccountingDimension(
      value.byReasoningEffort,
      new Set(["unknown"])
    ),
    accountAttribution: {
      attributedPseudonymousEvents: count(
        value?.accountAttribution?.attributedPseudonymousEvents,
        0
      ),
      unattributedEvents: count(value?.accountAttribution?.unattributedEvents, 0)
    },
    toolClasses: {
      total: count(value?.toolClasses?.total, 0),
      counts: Object.fromEntries(
        ["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]
          .map((key) => [key, count(value?.toolClasses?.counts?.[key], 0)])
      )
    },
    apiPriceCounterfactualTier: value.apiPriceCounterfactualTier === "standard"
      ? "standard"
      : "unknown",
    subscriptionSpeedIsSeparate: value.subscriptionSpeedIsSeparate === true,
    reasoningEffortAvailable: value.reasoningEffortAvailable === true,
    accountingSource: text(value.accountingSource, "unknown"),
    accountingCacheStatus: text(value.accountingCacheStatus, "unknown"),
    replayExclusionDiagnostics: {
      filesScanned: count(value?.replayExclusionDiagnostics?.filesScanned, 0),
      forkReplayEventsExcluded: count(
        value?.replayExclusionDiagnostics?.forkReplayEventsExcluded,
        0
      ),
      unattributedForkReplayEventsExcluded: count(
        value?.replayExclusionDiagnostics?.unattributedForkReplayEventsExcluded,
        0
      ),
      duplicateSnapshotsExcluded: count(
        value?.replayExclusionDiagnostics?.duplicateSnapshotsExcluded,
        0
      ),
      missingLineageParents: count(
        value?.replayExclusionDiagnostics?.missingLineageParents,
        0
      )
    },
    generatedAt: text(value.generatedAt, ""),
    coveredAt: {
      startAt: text(value?.coveredAt?.startAt, ""),
      endAt: text(value?.coveredAt?.endAt, "")
    },
    unknownModelEvents: count(value.unknownModelEvents, 0),
    periods: []
  };
  normalized.periods = array(value.periods).slice(0, 4).map((period) => (
    normalizeLocalAccounting({ ...period, periods: [] })
  ));
  return normalized;
}

function normalizeMonitoringGaps(value) {
  return array(value).flatMap((row) => {
    const copy = MONITORING_GAP_COPY[row?.id];
    if (!copy) return [];
    const status = [
      "observed",
      "missing",
      "partial",
      "unattributed",
      "not_observed",
      "unsupported_or_partial",
      "unsupported",
      "unavailable",
      "mostly_unknown",
      "excluded",
      "uncertain",
      "observed_combined",
      "review_available",
      "insufficient_evidence"
    ].includes(row?.status) ? row.status : "unavailable";
    return [{ id: row.id, title: copy[0], explanation: copy[1], status }];
  });
}

function safeState(value, fallback = "insufficient") {
  const normalized = String(value ?? "").toLowerCase();
  if (["live", "current", "ok", "ready"].includes(normalized)) return "live";
  if (["stale", "delayed"].includes(normalized)) return "stale";
  if (["demo", "synthetic"].includes(normalized)) return "demo";
  if (["offline", "unavailable", "error"].includes(normalized)) return "offline";
  return fallback;
}

function normalizeQuota(window, index) {
  const used = finite(window?.usedPercent ?? window?.used_percent ?? window?.used, null);
  const remaining = finite(window?.remainingPercent ?? window?.remaining_percent, used === null ? null : 100 - used);
  const durationMinutes = finite(window?.durationMinutes ?? window?.duration_minutes ?? window?.windowMinutes, null);
  const limitId = text(window?.limitId, "unknown");
  const defaultLabel = durationMinutes === 300
    ? "Five-hour allowance"
    : limitId === "codex"
      ? "Seven-day allowance"
      : limitId === "codex_bengalfox"
        ? "Secondary observed allowance"
        : durationMinutes === 10080
          ? "Provider-reported seven-day window"
          : "Quota window";
  return {
    id: text(window?.id ?? limitId, `quota-${index}`),
    limitId,
    slot: text(window?.slot, "unknown"),
    label: text(window?.label, defaultLabel),
    durationMinutes,
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: text(window?.resetAt ?? window?.reset_at, ""),
    observedAt: text(window?.observedAt ?? window?.observed_at, ""),
    precision: finite(window?.precision ?? window?.displayPrecision, null),
    planType: text(window?.planType ?? window?.plan_type, ""),
    accountAttribution: text(window?.accountAttribution, ""),
    status: safeState(window?.status, "live")
  };
}

function normalizePricing(pricing = {}) {
  const source = pricing?.components ?? pricing?.componentTotals ?? {};
  const componentRows = Array.isArray(source)
    ? source
    : Object.entries(source).map(([name, value]) => ({
        name,
        tokens: value?.tokens ?? value?.tokenCount ?? value,
        costUsd: value?.costUsd ?? value?.estimatedCostUsd
      }));
  return {
    totalCostUsd: finite(pricing?.totalCostUsd ?? pricing?.estimatedApiCostUsd ?? pricing?.total_usd, null),
    periodLabel: text(pricing?.periodLabel ?? pricing?.label, "Recorded period"),
    coveragePercent: finite(pricing?.coveragePercent ?? pricing?.pricedCoveragePercent ?? pricing?.pricedEventCoveragePercent, null),
    eventCount: finite(pricing?.eventCount ?? pricing?.pricedEventCount, null),
    apiTier: text(pricing?.apiTier ?? pricing?.tier, "standard"),
    basis: text(pricing?.basis, "api_price_equivalent"),
    apiServiceTier: text(pricing?.apiServiceTier, "unknown"),
    subscriptionSpeedIsSeparate: pricing?.subscriptionSpeedIsSeparate === true,
    registryVersion: text(pricing?.registryVersion, ""),
    registryObservedAt: text(pricing?.registryObservedAt, ""),
    components: componentRows.slice(0, 12).map((row) => ({
      name: text(row?.name ?? row?.component, "Unknown"),
      tokens: finite(row?.tokens ?? row?.value, 0),
      pricedTokens: finite(row?.pricedTokens, 0),
      unpricedTokens: finite(row?.unpricedTokens, 0),
      costUsd: finite(row?.costUsd, null)
    })),
    accountingSource: text(pricing?.accountingSource, "unknown"),
    accountingCacheStatus: text(pricing?.accountingCacheStatus, "unknown"),
    replayExclusionDiagnostics: {
      filesScanned: count(pricing?.replayExclusionDiagnostics?.filesScanned, 0),
      forkReplayEventsExcluded: count(
        pricing?.replayExclusionDiagnostics?.forkReplayEventsExcluded,
        0
      ),
      duplicateSnapshotsExcluded: count(
        pricing?.replayExclusionDiagnostics?.duplicateSnapshotsExcluded,
        0
      )
    }
  };
}

function normalizeGradient(payload = {}) {
  const source = artifactData(payload?.gradient ?? payload);
  const diagnosticRolling = [
    ...array(source.fastHourly ?? source.fast_hourly).map((row) => ({
      ...row,
      smoothing_hours: 1
    })),
    ...array(source.fastTwoHour ?? source.fast_two_hour).map((row) => ({
      ...row,
      smoothing_hours: 2
    }))
  ];
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    curve: array(source.curve),
    rolling: [...array(source.rolling), ...diagnosticRolling],
    rollingHistory: array(source.rollingHistory ?? source.rolling_history),
    rollingDetail: array(source.rollingDetail ?? source.current_rolling_detail),
    residual: array(source.residual ?? source.rolling_residual),
    windowSensitivity: array(source.windowSensitivity ?? source.window_sensitivity)
  };
}

function normalizeWeekly(payload = {}) {
  const envelope = payload?.weekly ?? payload;
  const source = artifactData(envelope);
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    weeklyValues: array(source.weeklyValues ?? source.weekly_values),
    valueSeries: array(source.valueSeries ?? source.value_series),
    holdoutSeries: array(source.holdoutSeries ?? source.holdout_series),
    errorConcentration: array(source.errorConcentration ?? source.error_concentration),
    providerEpochs: array(source.providerEpochs ?? source.provider_epochs),
    dataClass: text(envelope?.dataClass, ""),
    accountAttribution: {
      status: text(envelope?.accountAttribution?.status, ""),
      maySpanMultipleAccounts:
        envelope?.accountAttribution?.maySpanMultipleAccounts === true,
      label: text(envelope?.accountAttribution?.label, "")
    }
  };
}

function normalizeQuality(payload = {}) {
  const source = artifactData(payload?.quality ?? payload);
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    coverage: array(source.coverage),
    signals: array(source.signals),
    opportunities: array(source.opportunities),
    blindSpots: array(source.blindSpots ?? source.blind_spots)
  };
}

export function normalizeDashboardPayload(payload = {}, fragments = {}) {
  const overview = payload?.overview ?? fragments.overview ?? payload;
  const freshness = overview?.freshness ?? {};
  const usagePeriods = array(overview?.usage);
  const selectedUsage = usagePeriods.find((period) => period?.id === "7d" && finite(period?.events, 0) > 0)
    ?? usagePeriods.find((period) => period?.id === "all")
    ?? usagePeriods[0]
    ?? {};
  const pricing = overview?.pricing ?? overview?.live?.pricing ?? {};
  const quota = overview?.quota ?? overview?.live?.quota ?? {};
  const quotaRows = array(overview?.quotaWindows ?? overview?.live?.quotaWindows ?? quota?.windows);
  const mode = text(overview?.mode ?? payload?.mode, "local");
  const state = mode === "demo"
    ? "demo"
    : safeState(freshness?.status ?? overview?.status ?? overview?.evidenceStatus ?? payload?.status, "insufficient");
  const reportsPayload = payload?.reports ?? fragments.reports ?? {};
  const quotaWindows = quotaRows.map((window, index) => normalizeQuota({
    ...window,
    observedAt: window?.observedAt ?? quota?.observedAt,
    accountAttribution: window?.accountAttribution ?? quota?.accountAttribution
  }, index));
  return {
    schemaVersion: text(overview?.schemaVersion ?? payload?.schemaVersion, "local-dashboard-unknown"),
    mode,
    state,
    generatedAt: text(overview?.generatedAt ?? payload?.generatedAt, ""),
    freshness: {
      status: state,
      latestObservedAt: text(freshness?.latestObservedAt ?? overview?.latestObservedAt ?? overview?.latestEvidenceAt, ""),
      ageSeconds: finite(freshness?.ageSeconds ?? freshness?.age_seconds, null),
      staleAfterSeconds: finite(freshness?.staleAfterSeconds, null)
    },
    quotaWindows,
    activity: {
      ...(overview?.activity ?? overview?.live?.activity ?? {}),
      usageEvents: overview?.activity?.usageEvents ?? selectedUsage?.events,
      totalTokens: overview?.activity?.totalTokens ?? selectedUsage?.totalTokens
    },
    usagePeriods: usagePeriods.slice(0, 4).map((period) => ({
      id: ["24h", "7d", "30d", "all"].includes(period?.id) ? period.id : "all",
      label: text(period?.label, "Recorded period"),
      events: count(period?.events, 0),
      totalTokens: count(period?.totalTokens, 0),
      apiPriceEquivalentUsd: nonNegative(period?.apiPriceEquivalentUsd, 0),
      pricedEventFraction: finite(period?.pricedEventFraction, null)
    })),
    pricing: normalizePricing({
      ...pricing,
      totalCostUsd: pricing?.totalCostUsd ?? selectedUsage?.apiPriceEquivalentUsd,
      periodLabel: pricing?.periodLabel ?? selectedUsage?.label,
      coveragePercent: pricing?.coveragePercent ?? (
        finite(selectedUsage?.pricedEventFraction) === null
          ? null
          : Number((selectedUsage.pricedEventFraction * 100).toFixed(6))
      ),
      eventCount: pricing?.eventCount ?? selectedUsage?.events,
      components: pricing?.components ?? selectedUsage?.components
    }),
    coverage: overview?.coverage ?? {},
    warnings: array(overview?.warnings).map((warning) => text(warning?.message ?? warning, "")).filter(Boolean),
    collector: {
      status: text(overview?.collector?.status, "unavailable"),
      records: count(overview?.collector?.records, 0),
      malformedLines: count(overview?.collector?.malformedLines, 0),
      lastScanAt: text(overview?.collector?.lastScanAt, ""),
      safeRecordCount: count(overview?.collector?.safeRecordCount, 0),
      identityMode: text(overview?.collector?.identityMode, ""),
      sourceMode: text(overview?.collector?.sourceMode, ""),
      indexingState: text(overview?.collector?.indexingState, ""),
      indexing: overview?.collector?.indexing
        && typeof overview.collector.indexing === "object"
        && !Array.isArray(overview.collector.indexing)
        ? {
          status: text(overview.collector.indexing.status, ""),
          phase: text(overview.collector.indexing.phase, ""),
          mode: text(overview.collector.indexing.mode, ""),
          filesDiscovered: count(overview.collector.indexing.filesDiscovered, 0),
          filesSelected: count(overview.collector.indexing.filesSelected, 0),
          filesProcessed: count(overview.collector.indexing.filesProcessed, 0),
          recordsWritten: count(overview.collector.indexing.recordsWritten, 0),
          coveredAt: {
            startAt: text(overview.collector.indexing.coveredAt?.startAt, ""),
            endAt: text(overview.collector.indexing.coveredAt?.endAt, "")
          },
          boundedBy: text(overview.collector.indexing.boundedBy, "")
        }
        : null,
      coveredAt: {
        startAt: text(overview?.collector?.coveredAt?.startAt, ""),
        endAt: text(overview?.collector?.coveredAt?.endAt, "")
      },
      exportableCoveredAt: {
        startAt: text(
          overview?.collector?.exportableCoveredAt?.startAt,
          ""
        ),
        endAt: text(
          overview?.collector?.exportableCoveredAt?.endAt,
          ""
        )
      },
      recordCounts: {
        usage: count(overview?.collector?.recordCounts?.usage, 0),
        quota: count(overview?.collector?.recordCounts?.quota, 0),
        tools: count(overview?.collector?.recordCounts?.tools, 0),
        other: count(overview?.collector?.recordCounts?.other, 0)
      }
    },
    timeline: normalizeLocalTimeline(overview?.timeline),
    accounting: normalizeLocalAccounting(overview?.accounting),
    monitoringGaps: normalizeMonitoringGaps(overview?.monitoringGaps),
    artifactStatus: {
      gradient: {
        status: text(overview?.artifactStatus?.gradient?.status, "unavailable"),
        generatedAt: text(overview?.artifactStatus?.gradient?.generatedAt, ""),
        dataClass: text(overview?.artifactStatus?.gradient?.dataClass, "")
      },
      weekly: {
        status: text(overview?.artifactStatus?.weekly?.status, "unavailable"),
        generatedAt: text(overview?.artifactStatus?.weekly?.generatedAt, ""),
        dataClass: text(overview?.artifactStatus?.weekly?.dataClass, "")
      },
      quality: {
        status: text(overview?.artifactStatus?.quality?.status, "unavailable"),
        generatedAt: text(overview?.artifactStatus?.quality?.generatedAt, ""),
        dataClass: text(overview?.artifactStatus?.quality?.dataClass, "")
      }
    },
    gradient: normalizeGradient(payload?.gradient ?? fragments.gradient),
    weekly: normalizeWeekly(payload?.weekly ?? fragments.weekly),
    quality: normalizeQuality(payload?.quality ?? fragments.quality),
    reports: array(reportsPayload?.reports ?? reportsPayload).slice(0, 20).map((report) => ({
      id: text(report?.id, ""),
      title: text(report?.title, "Detailed report"),
      href: text(report?.href, ""),
      updatedAt: text(report?.updatedAt ?? report?.modifiedAt, ""),
      status: safeState(report?.status, "live")
    })).filter((report) => report.href.startsWith("/") && !report.href.startsWith("//"))
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetchImpl(url, {
    ...requestOptions,
    headers: { Accept: "application/json", ...headers }
  });
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export function normalizeBackendReadiness(payload) {
  const unavailable = Object.freeze({
    state: "unavailable",
    lifecycle: "unavailable",
    lifecycleFresh: false,
    quarantineRetentionComplete: false,
    restoreReplayComplete: false,
    aggregateRebuildComplete: false,
    maintenanceCycleMatched: false,
    quarantineReconciliation: "unavailable",
    quarantineReconciliationComplete: false
  });
  if (!hasExactKeys(payload, ["status", "checks", "policy"])
      || !["ready", "not_ready"].includes(payload.status)
      || !hasExactKeys(payload.checks, [
        "lifecycle",
        "lifecycleFresh",
        "quarantineRetentionComplete",
        "restoreReplayComplete",
        "aggregateRebuildComplete",
        "maintenanceCycleMatched",
        "quarantineReconciliation",
        "quarantineReconciliationComplete"
      ])
      || !hasExactKeys(payload.policy, ["lifecycleStaleAfterMilliseconds"])
      || !BACKEND_LIFECYCLE_STATES.has(payload.checks.lifecycle)
      || !BACKEND_RECONCILIATION_STATES.has(
        payload.checks.quarantineReconciliation
      )
      || typeof payload.checks.lifecycleFresh !== "boolean"
      || typeof payload.checks.quarantineRetentionComplete !== "boolean"
      || typeof payload.checks.restoreReplayComplete !== "boolean"
      || typeof payload.checks.aggregateRebuildComplete !== "boolean"
      || typeof payload.checks.maintenanceCycleMatched !== "boolean"
      || typeof payload.checks.quarantineReconciliationComplete !== "boolean"
      || !Number.isSafeInteger(
        payload.policy.lifecycleStaleAfterMilliseconds
      )
      || payload.policy.lifecycleStaleAfterMilliseconds < 60_000
      || payload.policy.lifecycleStaleAfterMilliseconds > 86_400_000) {
    return unavailable;
  }
  if (payload.status === "ready"
      && (payload.checks.lifecycle !== "ready"
        || payload.checks.lifecycleFresh !== true
        || payload.checks.quarantineRetentionComplete !== true
        || payload.checks.restoreReplayComplete !== true
        || payload.checks.aggregateRebuildComplete !== true
        || payload.checks.maintenanceCycleMatched !== true
        || payload.checks.quarantineReconciliation !== "completed"
        || payload.checks.quarantineReconciliationComplete !== true)) {
    return unavailable;
  }
  return Object.freeze({
    state: payload.status,
    lifecycle: payload.checks.lifecycle,
    lifecycleFresh: payload.checks.lifecycleFresh,
    quarantineRetentionComplete:
      payload.checks.quarantineRetentionComplete,
    restoreReplayComplete: payload.checks.restoreReplayComplete,
    aggregateRebuildComplete: payload.checks.aggregateRebuildComplete,
    maintenanceCycleMatched: payload.checks.maintenanceCycleMatched,
    quarantineReconciliation:
      payload.checks.quarantineReconciliation,
    quarantineReconciliationComplete:
      payload.checks.quarantineReconciliationComplete
  });
}

export class LocalCompanionClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async load() {
    try {
      const [status, dashboard] = await Promise.all([
        fetchJson(this.fetchImpl, `${LOCAL_ROOT}/v1/status`).catch(() => null),
        fetchJson(this.fetchImpl, `${LOCAL_ROOT}/v1/dashboard`)
      ]);
      return normalizeDashboardPayload({ ...dashboard, status: dashboard?.status ?? status?.status });
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
    }

    const paths = ["overview", "gradient", "weekly", "quality", "reports"];
    const settled = await Promise.allSettled(paths.map((path) => fetchJson(this.fetchImpl, `${LOCAL_ROOT}/${path}`)));
    const fragments = Object.fromEntries(settled.map((result, index) => [
      paths[index],
      result.status === "fulfilled" ? result.value : null
    ]));
    if (!fragments.overview) throw new Error("The local companion did not return an overview.");
    return normalizeDashboardPayload({}, fragments);
  }

  health() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/health`);
  }

  async onboarding() {
    try {
      return normalizeLocalOnboarding(
        await fetchJson(this.fetchImpl, `${LOCAL_ROOT}/onboarding`)
      );
    } catch {
      return normalizeLocalOnboarding(null);
    }
  }

  async refresh() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify({})
    });
  }

  refreshStatus() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh`);
  }

  async cancelRefresh() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify({})
    });
  }

  async contributionSyncStatus() {
    try {
      return normalizeContributionSyncStatus(
        await fetchJson(
          this.fetchImpl,
          `${LOCAL_ROOT}/contribution/sync-status`
        )
      );
    } catch {
      return normalizeContributionSyncStatus(null);
    }
  }

  async automaticContributionStatus() {
    try {
      return normalizeAutomaticContributionStatus(
        await fetchJson(
          this.fetchImpl,
          `${LOCAL_ROOT}/contribution/automatic-settings`
        )
      );
    } catch {
      return normalizeAutomaticContributionStatus(null);
    }
  }

  async enableAutomaticContribution(requiredConsent) {
    const normalized = normalizeAutomaticContributionStatus({
      schemaVersion: AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
      status: "first_review_required",
      enabled: false,
      intervalHours: 6,
      consentCurrent: false,
      firstReviewComplete: false,
      firstReviewedAcceptedAt: null,
      requiredConsent,
      consentedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      lastOutcome: null,
      foregroundOnly: true,
      daemonInstalled: false,
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false
    });
    if (normalized.state === "unavailable"
        || normalized.requiredConsent?.destinationOrigin === null) {
      throw new TypeError("Automatic contribution consent is invalid.");
    }
    const response = await this.fetchImpl(
      `${LOCAL_ROOT}/contribution/automatic-enable`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({
          intervalHours: 6,
          consent: normalized.requiredConsent
        })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status}).`);
      error.status = response.status;
      if (response.status === 409
          && hasExactKeys(payload, ["schemaVersion", "error"])
          && payload.schemaVersion === "local-companion-v0.1"
          && hasExactKeys(payload.error, ["code"])
          && payload.error.code
            === "automatic_contribution_first_review_required") {
        error.code = "automatic_contribution_first_review_required";
      }
      throw error;
    }
    return normalizeAutomaticContributionStatus(payload);
  }

  async disableAutomaticContribution() {
    return normalizeAutomaticContributionStatus(
      await this.localContributionMutation("automatic-disable", {
        reason: "user_request"
      })
    );
  }

  async contributionSyncPreview() {
    try {
      return normalizeContributionSyncPreview(
        await this.localContributionMutation("sync-next")
      );
    } catch {
      return normalizeContributionSyncPreview(null);
    }
  }

  async pairContributionDevice(pairingCode) {
    const response = await this.fetchImpl(
      `${LOCAL_ROOT}/contribution/device-pair`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ pairingCode })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status}).`);
      error.status = response.status;
      if (response.status === 409
          && hasExactKeys(payload, ["schemaVersion", "error"])
          && payload.schemaVersion === "local-companion-v0.1"
          && hasExactKeys(payload.error, ["code"])
          && payload.error.code
            === "contribution_device_recovery_required") {
        error.code = "contribution_device_recovery_required";
      }
      throw error;
    }
    return normalizeLocalContributionDevicePairing(payload);
  }

  contributionSyncExactReview() {
    return this.localContributionMutation("sync-inspect-exact");
  }

  localContributionMutation(path, body = {}) {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/contribution/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify(body)
    });
  }

  async runContributionSyncOnce(reviewToken) {
    return normalizeContributionSyncRun(
      await this.localContributionMutation("sync-once", { reviewToken })
    );
  }

  async prepareContribution(options = {}) {
    if (!options
        || typeof options !== "object"
        || Array.isArray(options)
        || Object.keys(options).some((key) => key !== "lookbackHours")) {
      throw new TypeError("Contribution preparation options are invalid.");
    }
    const lookbackHours = options.lookbackHours ?? 24;
    if (![1, 24, 7 * 24].includes(lookbackHours)) {
      throw new TypeError("Contribution preparation lookback is invalid.");
    }
    const fetchImpl = this.fetchImpl;
    const response = await fetchImpl(
      `${LOCAL_ROOT}/contribution/prepare`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ lookbackHours })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status}).`);
      error.status = response.status;
      error.code = payload?.schemaVersion
          === "local-contribution-preparation-error-v0.1"
        && LOCAL_PREPARATION_ERROR_CODES.has(payload?.errorCode)
        ? payload.errorCode
        : "preparation_failed";
      throw error;
    }
    return normalizeLocalContributionPreparation(payload);
  }

  async setContributionSyncPaused(paused) {
    return normalizeContributionSyncStatus(
      await this.localContributionMutation(
        paused ? "sync-pause" : "sync-resume"
      )
    );
  }
}

export class CommunityClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getCsrfToken = () => null,
    getParticipantId = () => null
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.getCsrfToken = getCsrfToken;
    this.getParticipantId = getParticipantId;
    this.pendingRecovery = null;
  }

  sessionOptions(options = {}) {
    return { credentials: "same-origin", ...options };
  }

  mutationOptions(options = {}) {
    const csrfToken = this.getCsrfToken();
    if (typeof csrfToken !== "string" || csrfToken.length === 0) {
      throw new Error("A current session confirmation is required.");
    }
    return this.sessionOptions({
      ...options,
      headers: {
        "X-Usage-Monitor-CSRF": csrfToken,
        ...(options.headers ?? {})
      }
    });
  }

  health() {
    return fetchJson(this.fetchImpl, "/api/health");
  }

  async readiness() {
    // Browser-native fetch is receiver-sensitive. Calling it as a property of
    // this client can throw "Illegal invocation" before any request is made.
    const fetchImpl = this.fetchImpl;
    const response = await fetchImpl("/api/ready", {
      headers: { Accept: "application/json" }
    });
    if (![200, 503].includes(response.status)) {
      const error = new Error(`Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return normalizeBackendReadiness(await response.json().catch(() => null));
  }

  session() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/session`, this.sessionOptions());
  }

  enroll(
    inviteCode = null,
    contributionSchemaVersion = "telemetry-contribution-v0.1",
    { deviceBootstrap = false } = {}
  ) {
    if (typeof deviceBootstrap !== "boolean") {
      throw new TypeError("Enrollment device bootstrap selection is invalid.");
    }
    const accountScoped = contributionSchemaVersion === "telemetry-contribution-v0.2";
    const body = {
      consentVersion: accountScoped
        ? "privacy-safe-telemetry-v0.2"
        : "privacy-safe-telemetry-v0.1",
      syntheticOnly: false
    };
    if (deviceBootstrap) {
      body.deviceBootstrap = {
        ongoingUpload: true,
        consentVersion: accountScoped
          ? "ongoing-privacy-safe-telemetry-v0.2"
          : "ongoing-privacy-safe-telemetry-v0.1"
      };
    }
    if (typeof inviteCode === "string" && inviteCode.length > 0) body.inviteCode = inviteCode;
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/enroll`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async recover(recoveryCode) {
    if (this.pendingRecovery?.recoveryCode !== recoveryCode) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      this.pendingRecovery = {
        recoveryCode,
        recoveryAttemptId: `um_recovery_attempt_${secret}`
      };
    }
    try {
      const result = await fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/recover`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.pendingRecovery)
      });
      this.pendingRecovery = null;
      return result;
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status < 500) {
        this.pendingRecovery = null;
      }
      throw error;
    }
  }

  envelopeKey() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/envelope-key`);
  }

  registerUpload({ envelopeDigest, contentLengthBytes, contentType = "application/json" }) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/upload-authorizations`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelopeDigest, contentLengthBytes, contentType })
    }));
  }

  contributeSerialized(serializedEnvelope, uploadAuthorization) {
    if (typeof uploadAuthorization !== "string" || uploadAuthorization.length === 0) {
      throw new Error("A one-use upload authorization is required.");
    }
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/contributions`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Upload ${uploadAuthorization}`
      },
      body: serializedEnvelope
    });
  }

  contribution(contributionId) {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/contributions/read`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId })
      })
    );
  }

  deleteContribution(contributionId) {
    if (typeof contributionId !== "string"
        || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
      throw new Error("Choose a valid contribution.");
    }
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/contributions/delete`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId })
      })
    ).then((payload) => normalizeContributionDeletionReceipt(payload, contributionId));
  }

  async personalStats() {
    try {
      return await fetchJson(
        this.fetchImpl,
        `${CENTRAL_ROOT}/me/stats`,
        this.sessionOptions()
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      return fetchJson(
        this.fetchImpl,
        `${CENTRAL_ROOT}/me/insights`,
        this.sessionOptions()
      );
    }
  }

  participantProfile() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me`,
      this.sessionOptions()
    );
  }

  async communityStats() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/stats/aggregate`);
  }

  participantExport() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/export`,
      this.sessionOptions()
    );
  }

  async deleteParticipant() {
    const payload = await fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me`,
      this.mutationOptions({ method: "DELETE" })
    );
    return normalizeParticipantDeletionReceipt(payload, this.getParticipantId());
  }

  createDevicePairing(accountScoped = false) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/device-pairings`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consentVersion: accountScoped
          ? "ongoing-privacy-safe-telemetry-v0.2"
          : "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true
      })
    }));
  }

  devices() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/devices`,
      this.sessionOptions()
    );
  }

  revokeDevice(deviceId) {
    if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/u.test(deviceId)) {
      throw new Error("Choose a valid paired device.");
    }
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/devices/revoke`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId })
      })
    );
  }

  logout() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/logout`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));
  }

  securityReset() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/security-reset`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));
  }
}

export function demoDashboard({ now = new Date().toISOString() } = {}) {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const nowMs = Math.floor(Date.parse(now) / HOUR) * HOUR;
  const iso = (ms) => new Date(ms).toISOString();
  const nowIso = iso(nowMs);
  const rolling = [];
  for (const smoothingHours of [1, 2, 3]) {
    for (let index = 0; index < 36; index += 1) {
      const timestamp = iso(nowMs - (35 - index) * HOUR);
      const scale = smoothingHours / 3;
      const observed = Math.max(
        0,
        (4.8 + Math.sin(index / 3) * 2.5 + (index > 20 && index < 25 ? 3.2 : 0)) * scale
      );
      rolling.push({
        timestamp,
        series: "Observed quota change",
        quota_change_pp: Number(observed.toFixed(2)),
        smoothing_hours: smoothingHours
      });
      rolling.push({
        timestamp,
        series: "Expected from API cost",
        quota_change_pp: Number((observed * .82 + Math.cos(index / 4) * .8 * scale).toFixed(2)),
        smoothing_hours: smoothingHours
      });
    }
  }
  const weeklyValues = Array.from({ length: 7 }, (_, index) => {
    const dueMs = nowMs - (6 - index) * 7 * DAY - 36 * HOUR;
    return {
      sequence: index + 1,
      reset_due_at: iso(dueMs),
      first_observed_at: iso(dueMs - 7 * DAY),
      last_observed_at: iso(dueMs),
      displayed_span_pp: [92, 88, 85, 96, 90, 83, 91][index],
      value_usd: [2125, 2080, 2022, 1960, 1905, 1875, 1888][index],
      pairwise_p10_usd: [1790, 1740, 1690, 1650, 1590, 1600, 1610][index],
      pairwise_p90_usd: [2370, 2310, 2240, 2170, 2080, 2100, 2120][index],
      holdout_mae_pp: [2.1, 2.8, 2.2, 3.4, 2.5, 1.9, 2.2][index],
      eligible_transitions: 70 + index * 9
    };
  });
  const lastResetMs = nowMs - 3 * DAY - 2 * HOUR;
  const componentShares = {
    input_uncached_tokens: .1408,
    input_cache_read_tokens: .7889,
    input_cache_write_tokens: .0225,
    output_text_tokens: .0361,
    output_reasoning_tokens: .0117,
    output_combined_tokens: 0
  };
  const splitTokens = (tokens) => Object.fromEntries(
    Object.entries(componentShares).map(([key, share]) => [key, Math.round(tokens * share)])
  );
  const bucketWeights = Array.from({ length: 168 }, (_, index) => {
    const startMs = nowMs - (168 - index) * HOUR;
    const date = new Date(startMs);
    const weekday = date.getUTCDay();
    const hour = date.getUTCHours();
    const dayFactor = weekday === 0 || weekday === 6 ? .35 : 1;
    const daypart = hour >= 13 && hour < 23 ? 1 : hour >= 23 || hour < 1 ? .45 : .12;
    return dayFactor * daypart * (1 + .25 * Math.sin(index / 5));
  });
  const weightTotal = bucketWeights.reduce((sum, weight) => sum + weight, 0);
  const totalDemoCost = 463.82;
  const totalDemoEvents = 8120;
  const timelineUsage = bucketWeights.map((weight, index) => {
    const startMs = nowMs - (168 - index) * HOUR;
    const share = weight / weightTotal;
    const usageEvents = Math.max(0, Math.round(totalDemoEvents * share));
    const totalTokens = usageEvents * 33_400;
    const cost = Number((totalDemoCost * share).toFixed(4));
    const fullyPriced = Math.round(usageEvents * .92);
    const partiallyPriced = Math.round(usageEvents * .05);
    return {
      startAt: iso(startMs),
      endAt: iso(startMs + HOUR),
      usageEvents,
      totalTokens,
      apiPriceEquivalentUsd: cost,
      components: splitTokens(totalTokens),
      pricingCoverage: {
        fullyPricedEvents: fullyPriced,
        partiallyPricedEvents: partiallyPriced,
        unpricedEvents: Math.max(0, usageEvents - fullyPriced - partiallyPriced)
      }
    };
  }).filter((row) => row.usageEvents > 0);
  const timelineQuota = Array.from({ length: 85 }, (_, index) => {
    const observedMs = nowMs - (84 - index) * 2 * HOUR;
    const sinceResetMs = observedMs - lastResetMs;
    const remaining = sinceResetMs >= 0
      ? Math.max(61, 100 - (sinceResetMs / (3 * DAY + 2 * HOUR)) * 39)
      : Math.max(9, 34 - ((sinceResetMs + 7 * DAY) / (7 * DAY)) * 25);
    const remainingPercent = Number(remaining.toFixed(1));
    return {
      observedAt: iso(observedMs),
      usedPercent: Number((100 - remainingPercent).toFixed(1)),
      remainingPercent,
      durationMinutes: 10_080,
      resetAt: iso(sinceResetMs >= 0 ? lastResetMs + 7 * DAY : lastResetMs),
      limitId: "codex",
      slot: "primary",
      planType: "pro",
      accountAttribution: "attributed_pseudonymous"
    };
  });
  const accountingDimension = (total, shares) => Object.fromEntries(
    Object.entries(shares).map(([key, share]) => [key, {
      events: Math.round(total.events * share),
      totalTokens: Math.round(total.tokens * share),
      apiPriceEquivalentUsd: Number((total.cost * share).toFixed(2))
    }])
  );
  const demoAccountingPeriod = (id, label, factor) => {
    const events = Math.round(totalDemoEvents * factor);
    const tokens = Math.round(269_300_000 * factor);
    const cost = Number((totalDemoCost * factor).toFixed(2));
    const total = { events, tokens, cost };
    const componentTokens = splitTokens(tokens);
    return {
      periodId: id,
      periodLabel: label,
      events,
      totalTokens: tokens,
      apiPriceEquivalentUsd: cost,
      pricingCoverage: {
        fullyPricedEvents: Math.round(events * .92),
        partiallyPricedEvents: Math.round(events * .05),
        unpricedEvents: events - Math.round(events * .92) - Math.round(events * .05)
      },
      components: componentTokens,
      componentCosts: Object.fromEntries(Object.entries(componentTokens).map(([key, count]) => [key, {
        tokens: count,
        pricedTokens: Math.round(count * .97),
        unpricedTokens: count - Math.round(count * .97),
        costUsd: Number((cost * ({
          input_uncached_tokens: .458,
          input_cache_read_tokens: .1535,
          input_cache_write_tokens: .0128,
          output_text_tokens: .2128,
          output_reasoning_tokens: .1629,
          output_combined_tokens: 0
        })[key]).toFixed(2))
      }])),
      byModel: [
        { model: "gpt-5.6-sol", events: Math.round(events * .62), totalTokens: Math.round(tokens * .64), apiPriceEquivalentUsd: Number((cost * .66).toFixed(2)) },
        { model: "gpt-5.6-terra", events: Math.round(events * .18), totalTokens: Math.round(tokens * .19), apiPriceEquivalentUsd: Number((cost * .21).toFixed(2)) },
        { model: "gpt-5.4-mini", events: Math.round(events * .15), totalTokens: Math.round(tokens * .13), apiPriceEquivalentUsd: Number((cost * .09).toFixed(2)) },
        { model: "unknown", events: Math.round(events * .05), totalTokens: Math.round(tokens * .04), apiPriceEquivalentUsd: 0 }
      ],
      bySpeed: accountingDimension(total, { standard: .78, fast: .13, unknown: .09 }),
      byApiServiceTier: accountingDimension(total, { standard: .97, unknown: .03 }),
      bySurface: accountingDimension(total, {
        cli_exec: .46, extension_or_ide: .38, subagent: .09, unknown: .07
      }),
      byAgentScope: accountingDimension(total, { root: .84, subagent: .09, automation: .02, unknown: .05 }),
      byLineage: accountingDimension(total, { standalone: .71, forked: .11, parent_linked: .12, unknown: .06 }),
      byReasoningEffort: accountingDimension(total, { unknown: 1 }),
      accountAttribution: {
        attributedPseudonymousEvents: Math.round(events * .91),
        unattributedEvents: events - Math.round(events * .91)
      },
      toolClasses: {
        total: Math.round(events * 2.6),
        counts: {
          apply_patch: Math.round(events * .58),
          local_shell: Math.round(events * 1.42),
          other: Math.round(events * .34),
          subagent: Math.round(events * .11),
          tool_gateway: Math.round(events * .15)
        }
      },
      apiPriceCounterfactualTier: "standard",
      subscriptionSpeedIsSeparate: true,
      reasoningEffortAvailable: false,
      accountingSource: "labeled_demo_fixture",
      accountingCacheStatus: "fresh",
      replayExclusionDiagnostics: {
        filesScanned: Math.round(412 * factor),
        forkReplayEventsExcluded: Math.round(96_400 * factor),
        unattributedForkReplayEventsExcluded: Math.round(2_150 * factor),
        duplicateSnapshotsExcluded: Math.round(11_800 * factor),
        missingLineageParents: Math.round(37 * factor)
      },
      generatedAt: nowIso,
      coveredAt: { startAt: iso(nowMs - 7 * DAY), endAt: nowIso },
      unknownModelEvents: Math.round(events * .05),
      periods: []
    };
  };
  const accounting = {
    ...demoAccountingPeriod("7d", "Last 7 days", 1),
    periods: [
      demoAccountingPeriod("24h", "Last 24 hours", .131),
      demoAccountingPeriod("7d", "Last 7 days", 1),
      demoAccountingPeriod("30d", "Last 30 days", 2.15),
      demoAccountingPeriod("all", "All retained evidence", 2.62)
    ]
  };
  return normalizeDashboardPayload({
    schemaVersion: "demo-dashboard-v0.1",
    mode: "demo",
    status: "demo",
    generatedAt: nowIso,
    freshness: { status: "demo", latestObservedAt: nowIso, ageSeconds: 0 },
    quotaWindows: [
      { id: "weekly", label: "Seven-day allowance", durationMinutes: 10080, usedPercent: 39, remainingPercent: 61, resetAt: iso(lastResetMs + 7 * DAY), observedAt: nowIso, planType: "pro", status: "demo" },
      { id: "primary", label: "Five-hour allowance", durationMinutes: 300, usedPercent: 18, remainingPercent: 82, resetAt: iso(nowMs + 2 * HOUR + 11 * 60_000), observedAt: nowIso, planType: "pro", status: "demo" }
    ],
    activity: { eventCount: 8120, safeRecordCount: 11432, lastScanAt: nowIso },
    timeline: {
      bucketMinutes: 60,
      coveredAt: { startAt: iso(nowMs - 7 * DAY), endAt: nowIso },
      usage: timelineUsage,
      quota: timelineQuota
    },
    accounting,
    pricing: {
      totalCostUsd: 463.82,
      periodLabel: "Last 7 days",
      coveragePercent: 91.4,
      eventCount: 8120,
      apiTier: "standard",
      components: [
        { name: "Uncached input", tokens: 38_200_000, costUsd: 212.4 },
        { name: "Cached input", tokens: 214_000_000, costUsd: 71.2 },
        { name: "Output text", tokens: 9_800_000, costUsd: 98.7 },
        { name: "Reasoning output", tokens: 7_300_000, costUsd: 81.52 }
      ]
    },
    gradient: {
      summary: [{ mean_absolute_error_pp: 2.7, points_within_80_band_fraction: .62, rolling_peak_absolute_residual_pp: 3.2 }],
      rolling,
      rolling_residual: rolling.filter((row) => row.series.startsWith("Observed")).map((row, index) => {
        const expected = rolling[index * 2 + 1]?.quota_change_pp ?? 0;
        return { timestamp: row.timestamp, observed_quota_change_pp: row.quota_change_pp, expected_quota_change_pp: expected, residual_pp: row.quota_change_pp - expected };
      }),
      window_sensitivity: [{ smoothing_hours: 1, mae_pp: 3.1 }, { smoothing_hours: 2, mae_pp: 2.4 }, { smoothing_hours: 3, mae_pp: 2.7 }]
    },
    weekly: {
      summary: [{ median_weekly_value_usd: 1878.75, lower_80_across_resets_usd: 1640.96, upper_80_across_resets_usd: 2280.38, qualifying_resets: 14, selected_holdout_mae_pp: 2.16, prior_reset_p80_absolute_error_pp: 7.39 }],
      weekly_values: weeklyValues
    },
    quality: {
      summary: [{ fit_eligible_fraction: .0088, known_speed_fraction: .912, collector_age_hours: 0.1 }],
      coverage: [
        { dimension: "Priced model", coverage_fraction: .914 },
        { dimension: "Speed tier known", coverage_fraction: .912 },
        { dimension: "Quota transitions", coverage_fraction: .67 },
        { dimension: "Account scope known", coverage_fraction: .12 }
      ],
      opportunities: [
        { priority: "P0", title: "Unknown model tokens", evidence: "Some historical events cannot be matched to a current API price card." },
        { priority: "P0", title: "Integer quota display", evidence: "Quota observations are rounded to whole percentage points." },
        { priority: "P1", title: "Shared agentic surfaces", evidence: "Work, Workspace Agents, and Voice task work may draw from the same pool." },
        { priority: "P1", title: "Fast-mode attribution", evidence: "Historical records do not always identify the subscription speed tier." }
      ]
    },
    reports: {
      reports: [
        { id: "gradient", title: "Full gradient report", href: "/reports/simple-quota-gradient", status: "demo" },
        { id: "weekly", title: "Weekly calibration report", href: "/reports/weekly-calibration", status: "demo" },
        { id: "quality", title: "Monitoring quality report", href: "/reports/monitoring-quality", status: "demo" }
      ]
    }
  });
}
