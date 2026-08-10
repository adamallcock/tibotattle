import {
  TELEMETRY_CONTRIBUTION_VERSION,
} from "./telemetry-v01-projection.js";
import {
  TELEMETRY_V01_REGISTRY_VERSION,
} from "../export/index.js";

export const AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION =
  "automatic-contribution-settings-v0.4";
export const AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION =
  "automatic-contribution-status-v0.1";
export const AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION =
  "ongoing-privacy-safe-telemetry-v0.1";
export const AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS = 6;
export const AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS = 24;
export const AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS = 1;
// A bounded, persisted phase prevents a large cohort that opts in together
// from reappearing at every six-hour boundary. The local controller supplies
// this value from its runtime RNG; policy-only callers retain a deterministic
// zero phase unless they opt in explicitly.
export const AUTOMATIC_CONTRIBUTION_MAXIMUM_SCHEDULE_DITHER_MILLISECONDS =
  60 * 60 * 1_000;

const INTERVAL_MILLISECONDS =
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS * 60 * 60 * 1_000;
const SETTINGS_KEYS = Object.freeze([
  "acceptedThrough", "consent", "enabled", "intervalHours", "lastAttemptAt",
  "lastOutcome", "lastSuccessAt", "nextAttemptAt", "paused",
  "pendingContribution", "preparationClaim", "reviewBootstrap",
  "scheduleDitherMilliseconds", "schemaVersion",
]);
const VERSION_THREE_SETTINGS_KEYS = Object.freeze([
  "acceptedThrough", "consent", "enabled", "intervalHours", "lastAttemptAt",
  "lastOutcome", "lastSuccessAt", "paused", "pendingContribution",
  "preparationClaim", "reviewBootstrap", "schemaVersion",
]);
const VERSION_TWO_SETTINGS_KEYS = Object.freeze([
  "acceptedThrough", "consent", "enabled", "intervalHours", "lastAttemptAt",
  "lastOutcome", "lastSuccessAt", "paused", "pendingContribution",
  "reviewBootstrap", "schemaVersion",
]);
const LEGACY_SETTINGS_KEYS = Object.freeze([
  "consent", "enabled", "intervalHours", "lastAttemptAt", "lastOutcome",
  "lastSuccessAt", "paused", "reviewBootstrap", "schemaVersion",
]);
const CONSENT_KEYS = Object.freeze([
  "consentedAt", "destinationOrigin", "fieldDictionaryVersion",
  "privacyContractVersion", "telemetrySchemaVersion",
]);
const REQUIRED_CONSENT_KEYS = Object.freeze([
  "destinationOrigin", "fieldDictionaryVersion", "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const REVIEW_BOOTSTRAP_KEYS = Object.freeze([
  "acceptedAt", "destinationOrigin", "fieldDictionaryVersion",
  "privacyContractVersion", "preparedSetId", "telemetrySchemaVersion",
]);
const ACCEPTED_THROUGH_KEYS = Object.freeze([
  "acceptedAt", "coveredThroughAt", "destinationOrigin", "fieldDictionaryVersion",
  "privacyContractVersion", "telemetrySchemaVersion",
]);
const PENDING_CONTRIBUTION_KEYS = Object.freeze([
  "coveredEndAt", "coveredStartAt", "destinationOrigin", "fieldDictionaryVersion",
  "preparedAt", "preparedSetId", "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const PREPARATION_CLAIM_KEYS = Object.freeze([
  "acceptedThroughAt", "claimedAt", "destinationOrigin", "fieldDictionaryVersion",
  "lookbackHours", "preparationId", "preparedSetId", "privacyContractVersion",
  "replayOverlapHours", "telemetrySchemaVersion",
]);
const PREPARED_SET_STATUS_KEYS = Object.freeze([
  "acceptedJobs", "completeAccepted", "coveredAt", "inFlightJobs", "pendingJobs",
  "preparedSetId", "rejectedJobs", "retryableJobs", "totalJobs",
]);
const COVERED_AT_KEYS = Object.freeze(["endAt", "startAt"]);
const OUTCOME_KEYS = Object.freeze(["at", "code", "status"]);
const TERMINAL_EVENT_KEYS = Object.freeze([
  "code", "pause", "preparedSet", "retryNotBeforeAt",
]);
const LEGACY_TERMINAL_EVENT_KEYS = Object.freeze(["code", "pause", "preparedSet"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTCOME_CODES = Object.freeze({
  accepted: "succeeded",
  completed: "succeeded",
  no_new_evidence: "skipped",
  retry_scheduled: "failed",
  delivery_rejected: "failed",
  preparation_failed: "failed",
  publication_incomplete: "failed",
  upload_failed: "failed",
  run_timeout: "failed",
  queue_paused: "paused",
  privacy_verification_failed: "paused",
  identity_unavailable: "paused",
});
const TERMINAL_EVENT_CODES = new Set([
  "accepted",
  "no_new_evidence",
  "retry_scheduled",
  "delivery_rejected",
  "preparation_failed",
  "publication_incomplete",
  "upload_failed",
  "run_timeout",
  "queue_paused",
  "privacy_verification_failed",
  "identity_unavailable",
]);
const TERMINAL_EVENT_PAUSES = Object.freeze({
  accepted: false,
  no_new_evidence: false,
  retry_scheduled: false,
  delivery_rejected: true,
  preparation_failed: true,
  publication_incomplete: false,
  run_timeout: true,
  queue_paused: true,
  privacy_verification_failed: true,
  identity_unavailable: true,
});

export class AutomaticContributionError extends Error {
  constructor(code) {
    super("Automatic contribution failed closed");
    this.name = "AutomaticContributionError";
    this.code = `automatic_contribution_${code}`;
  }
}

function fail(code) {
  throw new AutomaticContributionError(code);
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function snapshot(value, code = "settings_unavailable") {
  try {
    assertDataProperties(value, new Set());
    return structuredClone(value);
  } catch {
    fail(code);
  }
}

function assertDataProperties(value, seen) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new TypeError("accessors are not persisted settings");
    }
    assertDataProperties(descriptor.value, seen);
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.toISOString();
}

function nullableTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function normalizedDestinationOrigin(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_048) {
    fail("configuration_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("configuration_invalid");
  }
  if (parsed.origin !== value
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
    fail("configuration_invalid");
  }
  const production = parsed.protocol === "https:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const loopbackDevelopment = parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && parsed.port !== "";
  if (!production && !loopbackDevelopment) fail("configuration_invalid");
  return parsed.origin;
}

function requiredConsent(destinationOrigin) {
  return Object.freeze({
    telemetrySchemaVersion: TELEMETRY_CONTRIBUTION_VERSION,
    fieldDictionaryVersion: TELEMETRY_V01_REGISTRY_VERSION,
    privacyContractVersion: AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION,
    destinationOrigin,
  });
}

export function automaticContributionRequiredConsent({
  destinationOrigin = null,
} = {}) {
  return requiredConsent(normalizedDestinationOrigin(destinationOrigin));
}

function sameRequiredConsent(value, expected, { persisted = false } = {}) {
  return exactKeys(value, persisted ? CONSENT_KEYS : REQUIRED_CONSENT_KEYS)
    && (!persisted || nullableTimestamp(value.consentedAt) !== null)
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function sameReviewBootstrap(value, expected) {
  return exactKeys(value, REVIEW_BOOTSTRAP_KEYS)
    && nullableTimestamp(value.acceptedAt) !== null
    && SHA256.test(value.preparedSetId ?? "")
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function sameAcceptedThrough(value, expected) {
  return exactKeys(value, ACCEPTED_THROUGH_KEYS)
    && nullableTimestamp(value.acceptedAt) !== null
    && nullableTimestamp(value.coveredThroughAt) !== null
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function samePendingContribution(value, expected) {
  return exactKeys(value, PENDING_CONTRIBUTION_KEYS)
    && nullableTimestamp(value.preparedAt) !== null
    && nullableTimestamp(value.coveredStartAt) !== null
    && nullableTimestamp(value.coveredEndAt) !== null
    && Date.parse(value.coveredStartAt) < Date.parse(value.coveredEndAt)
    && SHA256.test(value.preparedSetId ?? "")
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function samePreparationClaim(value, expected, acceptedThroughAt) {
  return exactKeys(value, PREPARATION_CLAIM_KEYS)
    && UUID_V4.test(value.preparationId ?? "")
    && (value.preparedSetId === null || SHA256.test(value.preparedSetId ?? ""))
    && nullableTimestamp(value.claimedAt) !== null
    && nullableTimestamp(value.acceptedThroughAt) !== null
    && value.acceptedThroughAt === acceptedThroughAt
    && value.lookbackHours === AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS
    && value.replayOverlapHours === AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function validatedPreparedSetStatus(value, expectedPreparedSetId) {
  if (!exactKeys(value, PREPARED_SET_STATUS_KEYS)
      || value.preparedSetId !== expectedPreparedSetId
      || !SHA256.test(value.preparedSetId ?? "")
      || !exactKeys(value.coveredAt, COVERED_AT_KEYS)
      || nullableTimestamp(value.coveredAt.startAt) === null
      || nullableTimestamp(value.coveredAt.endAt) === null
      || Date.parse(value.coveredAt.startAt) >= Date.parse(value.coveredAt.endAt)
      || !Number.isSafeInteger(value.totalJobs)
      || value.totalJobs < 1
      || ![
        value.acceptedJobs, value.pendingJobs, value.retryableJobs,
        value.inFlightJobs, value.rejectedJobs,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)
      || value.totalJobs !== value.acceptedJobs + value.pendingJobs
        + value.retryableJobs + value.inFlightJobs + value.rejectedJobs
      || typeof value.completeAccepted !== "boolean"
      || value.completeAccepted !== (value.acceptedJobs === value.totalJobs)) {
    return null;
  }
  return value;
}

function validOutcome(value) {
  return value === null || (exactKeys(value, OUTCOME_KEYS)
    && OUTCOME_CODES[value.code] === value.status
    && nullableTimestamp(value.at) !== null);
}

function validScheduleDitherMilliseconds(value) {
  return value === null || (Number.isSafeInteger(value)
    && value >= 0
    && value <= AUTOMATIC_CONTRIBUTION_MAXIMUM_SCHEDULE_DITHER_MILLISECONDS);
}

function scheduleAfter(at, ditherMilliseconds = 0) {
  const milliseconds = Date.parse(at);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds + INTERVAL_MILLISECONDS + ditherMilliseconds)
    .toISOString();
}

function nextCadenceAfter(scheduledAt, attemptedAt) {
  const scheduledMilliseconds = Date.parse(scheduledAt);
  const attemptedMilliseconds = Date.parse(attemptedAt);
  if (!Number.isFinite(scheduledMilliseconds)
      || !Number.isFinite(attemptedMilliseconds)) {
    return null;
  }
  let next = scheduledMilliseconds + INTERVAL_MILLISECONDS;
  while (next <= attemptedMilliseconds) next += INTERVAL_MILLISECONDS;
  return new Date(next).toISOString();
}

function legacyNextAttemptAt(value) {
  if (value.enabled !== true) return null;
  const anchor = value.lastAttemptAt ?? value.consent?.consentedAt;
  return typeof anchor === "string" ? scheduleAfter(anchor) : null;
}

function emptySettings() {
  return {
    schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    enabled: false,
    paused: false,
    intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
    consent: null,
    acceptedThrough: null,
    pendingContribution: null,
    preparationClaim: null,
    reviewBootstrap: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    scheduleDitherMilliseconds: null,
    lastOutcome: null,
  };
}

function validatedSettings(value) {
  if (exactKeys(value, LEGACY_SETTINGS_KEYS)
      && value.schemaVersion === "automatic-contribution-settings-v0.1"
      && typeof value.enabled === "boolean"
      && typeof value.paused === "boolean"
      && value.intervalHours === AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      && nullableTimestamp(value.lastAttemptAt) === value.lastAttemptAt
      && nullableTimestamp(value.lastSuccessAt) === value.lastSuccessAt
      && validOutcome(value.lastOutcome)) {
    return {
      ...emptySettings(),
      lastAttemptAt: value.lastAttemptAt,
      lastSuccessAt: value.lastSuccessAt,
      lastOutcome: value.lastOutcome === null ? null : { ...value.lastOutcome },
    };
  }
  if (exactKeys(value, VERSION_TWO_SETTINGS_KEYS)
      && value.schemaVersion === "automatic-contribution-settings-v0.2") {
    return validatedSettings({
      ...value,
      schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
      preparationClaim: null,
      nextAttemptAt: legacyNextAttemptAt(value),
      scheduleDitherMilliseconds: null,
    });
  }
  if (exactKeys(value, VERSION_THREE_SETTINGS_KEYS)
      && value.schemaVersion === "automatic-contribution-settings-v0.3") {
    return validatedSettings({
      ...value,
      schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
      nextAttemptAt: legacyNextAttemptAt(value),
      scheduleDitherMilliseconds: null,
    });
  }
  if (!exactKeys(value, SETTINGS_KEYS)
      || value.schemaVersion !== AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION
      || typeof value.enabled !== "boolean"
      || typeof value.paused !== "boolean"
      || value.intervalHours !== AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      || nullableTimestamp(value.lastAttemptAt) !== value.lastAttemptAt
      || nullableTimestamp(value.lastSuccessAt) !== value.lastSuccessAt
      || nullableTimestamp(value.nextAttemptAt) !== value.nextAttemptAt
      || !validScheduleDitherMilliseconds(value.scheduleDitherMilliseconds)
      || !validOutcome(value.lastOutcome)
      || (!value.enabled && (value.nextAttemptAt !== null
        || value.scheduleDitherMilliseconds !== null))
      || (value.enabled && value.nextAttemptAt === null)
      || (value.acceptedThrough !== null
        && (!exactKeys(value.acceptedThrough, ACCEPTED_THROUGH_KEYS)
          || nullableTimestamp(value.acceptedThrough.acceptedAt) === null
          || nullableTimestamp(value.acceptedThrough.coveredThroughAt) === null
          || typeof value.acceptedThrough.telemetrySchemaVersion !== "string"
          || typeof value.acceptedThrough.fieldDictionaryVersion !== "string"
          || typeof value.acceptedThrough.privacyContractVersion !== "string"
          || typeof value.acceptedThrough.destinationOrigin !== "string"))
      || (value.pendingContribution !== null
        && (!exactKeys(value.pendingContribution, PENDING_CONTRIBUTION_KEYS)
          || nullableTimestamp(value.pendingContribution.preparedAt) === null
          || nullableTimestamp(value.pendingContribution.coveredStartAt) === null
          || nullableTimestamp(value.pendingContribution.coveredEndAt) === null
          || Date.parse(value.pendingContribution.coveredStartAt)
            >= Date.parse(value.pendingContribution.coveredEndAt)
          || !SHA256.test(value.pendingContribution.preparedSetId ?? "")
          || typeof value.pendingContribution.telemetrySchemaVersion !== "string"
          || typeof value.pendingContribution.fieldDictionaryVersion !== "string"
          || typeof value.pendingContribution.privacyContractVersion !== "string"
          || typeof value.pendingContribution.destinationOrigin !== "string"))
      || (value.preparationClaim !== null
        && (!exactKeys(value.preparationClaim, PREPARATION_CLAIM_KEYS)
          || !UUID_V4.test(value.preparationClaim.preparationId ?? "")
          || (value.preparationClaim.preparedSetId !== null
            && !SHA256.test(value.preparationClaim.preparedSetId ?? ""))
          || nullableTimestamp(value.preparationClaim.claimedAt) === null
          || nullableTimestamp(value.preparationClaim.acceptedThroughAt) === null
          || value.preparationClaim.lookbackHours
            !== AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS
          || value.preparationClaim.replayOverlapHours
            !== AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS
          || typeof value.preparationClaim.telemetrySchemaVersion !== "string"
          || typeof value.preparationClaim.fieldDictionaryVersion !== "string"
          || typeof value.preparationClaim.privacyContractVersion !== "string"
          || typeof value.preparationClaim.destinationOrigin !== "string"))
      || (value.reviewBootstrap !== null
        && (!exactKeys(value.reviewBootstrap, REVIEW_BOOTSTRAP_KEYS)
          || nullableTimestamp(value.reviewBootstrap.acceptedAt) === null
          || !SHA256.test(value.reviewBootstrap.preparedSetId ?? "")
          || typeof value.reviewBootstrap.telemetrySchemaVersion !== "string"
          || typeof value.reviewBootstrap.fieldDictionaryVersion !== "string"
          || typeof value.reviewBootstrap.privacyContractVersion !== "string"
          || typeof value.reviewBootstrap.destinationOrigin !== "string"))
      || (value.enabled && !exactKeys(value.consent, CONSENT_KEYS))
      || (!value.enabled && value.consent !== null)) {
    fail("settings_unavailable");
  }
  if (value.consent !== null
      && (nullableTimestamp(value.consent.consentedAt) === null
        || typeof value.consent.telemetrySchemaVersion !== "string"
        || typeof value.consent.fieldDictionaryVersion !== "string"
        || typeof value.consent.privacyContractVersion !== "string"
        || typeof value.consent.destinationOrigin !== "string")) {
    fail("settings_unavailable");
  }
  if (value.preparationClaim !== null
      && (value.acceptedThrough === null
        || value.preparationClaim.acceptedThroughAt
          !== value.acceptedThrough.coveredThroughAt
        || value.preparationClaim.telemetrySchemaVersion
          !== value.acceptedThrough.telemetrySchemaVersion
        || value.preparationClaim.fieldDictionaryVersion
          !== value.acceptedThrough.fieldDictionaryVersion
        || value.preparationClaim.privacyContractVersion
          !== value.acceptedThrough.privacyContractVersion
        || value.preparationClaim.destinationOrigin
          !== value.acceptedThrough.destinationOrigin)) {
    fail("settings_unavailable");
  }
  return {
    schemaVersion: value.schemaVersion,
    enabled: value.enabled,
    paused: value.paused,
    intervalHours: value.intervalHours,
    consent: value.consent === null ? null : { ...value.consent },
    acceptedThrough: value.acceptedThrough === null ? null : { ...value.acceptedThrough },
    pendingContribution: value.pendingContribution === null
      ? null : { ...value.pendingContribution },
    preparationClaim: value.preparationClaim === null
      ? null : { ...value.preparationClaim },
    reviewBootstrap: value.reviewBootstrap === null ? null : { ...value.reviewBootstrap },
    lastAttemptAt: value.lastAttemptAt,
    lastSuccessAt: value.lastSuccessAt,
    nextAttemptAt: value.nextAttemptAt,
    scheduleDitherMilliseconds: value.scheduleDitherMilliseconds,
    lastOutcome: value.lastOutcome === null ? null : { ...value.lastOutcome },
  };
}

export function createInitialAutomaticContributionState() {
  return emptySettings();
}

export function parseAutomaticContributionState(value) {
  return validatedSettings(snapshot(value));
}

function currentContext(state, destinationOrigin) {
  const destination = normalizedDestinationOrigin(destinationOrigin);
  const required = requiredConsent(destination);
  const firstReviewComplete = destination !== null
    && state.reviewBootstrap !== null
    && sameReviewBootstrap(state.reviewBootstrap, required);
  const consentCurrent = destination !== null
    && state.enabled
    && state.consent !== null
    && sameRequiredConsent(state.consent, required, { persisted: true });
  const acceptedThroughAt = destination !== null
    && state.acceptedThrough !== null
    && sameAcceptedThrough(state.acceptedThrough, required)
    ? state.acceptedThrough.coveredThroughAt : null;
  return { destination, required, firstReviewComplete, consentCurrent, acceptedThroughAt };
}

function outcome(code, at) {
  const status = OUTCOME_CODES[code];
  if (status === undefined) fail("configuration_invalid");
  return { status, code, at };
}

function nextAttemptAt(state, context) {
  if (!context.consentCurrent || state.paused) return null;
  if (state.nextAttemptAt !== null) return state.nextAttemptAt;
  const anchor = state.lastAttemptAt ?? state.consent?.consentedAt;
  return typeof anchor === "string" ? scheduleAfter(anchor) : null;
}

export function projectAutomaticContributionStatus(state, {
  destinationOrigin = null,
  settingsAvailable = true,
  running = false,
} = {}) {
  const destination = normalizedDestinationOrigin(destinationOrigin);
  let parsed;
  try {
    parsed = parseAutomaticContributionState(state);
  } catch (error) {
    if (settingsAvailable !== false || destination === null) throw error;
    parsed = emptySettings();
  }
  const context = currentContext(parsed, destination);
  const status = context.destination === null
    ? "not_configured"
    : settingsAvailable === false
      ? "failed"
      : !context.firstReviewComplete
        ? "first_review_required"
        : parsed.enabled && !context.consentCurrent
          ? "consent_required"
          : !parsed.enabled
            ? "disabled"
            : running
              ? "running"
              : parsed.paused
                ? "paused" : "scheduled";
  return Object.freeze({
    schemaVersion: AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
    status,
    enabled: context.consentCurrent,
    intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
    consentCurrent: context.consentCurrent,
    firstReviewComplete: context.firstReviewComplete,
    firstReviewedAcceptedAt: context.firstReviewComplete
      ? parsed.reviewBootstrap.acceptedAt : null,
    requiredConsent: Object.freeze({ ...context.required }),
    consentedAt: context.consentCurrent ? parsed.consent.consentedAt : null,
    lastAttemptAt: parsed.lastAttemptAt,
    lastSuccessAt: parsed.lastSuccessAt,
    nextAttemptAt: status === "scheduled" ? nextAttemptAt(parsed, context) : null,
    lastOutcome: parsed.lastOutcome === null ? null : Object.freeze({ ...parsed.lastOutcome }),
    foregroundOnly: true,
    daemonInstalled: false,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  });
}

export function recordReviewedManualAcceptance(state, {
  destinationOrigin = null,
  status,
  accepted,
  preparedSet,
  acceptedAt,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  if (context.destination === null || context.firstReviewComplete) return parsed;
  const prepared = snapshot(preparedSet, "review_acceptance_invalid");
  const reviewedSet = validatedPreparedSetStatus(
    prepared,
    prepared?.preparedSetId,
  );
  if (status !== "completed" || !Number.isSafeInteger(accepted) || accepted < 1
      || reviewedSet === null || reviewedSet.acceptedJobs < accepted) {
    fail("review_acceptance_invalid");
  }
  const at = timestamp(acceptedAt);
  return {
    ...parsed,
    reviewBootstrap: { ...context.required, preparedSetId: reviewedSet.preparedSetId, acceptedAt: at },
    acceptedThrough: reviewedSet.completeAccepted
      ? { ...context.required, acceptedAt: at, coveredThroughAt: reviewedSet.coveredAt.endAt }
      : null,
    pendingContribution: reviewedSet.completeAccepted ? null : {
      ...context.required,
      preparedSetId: reviewedSet.preparedSetId,
      preparedAt: at,
      coveredStartAt: reviewedSet.coveredAt.startAt,
      coveredEndAt: reviewedSet.coveredAt.endAt,
    },
    preparationClaim: null,
  };
}

export function enableAutomaticContribution(state, {
  destinationOrigin = null,
  intervalHours,
  consent,
  consentedAt,
  scheduleDitherMilliseconds = 0,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  if (context.destination === null) fail("not_configured");
  if (!context.firstReviewComplete) fail("first_review_required");
  if (intervalHours !== AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      || !sameRequiredConsent(snapshot(consent, "consent_binding_mismatch"), context.required)) {
    fail("consent_binding_mismatch");
  }
  if (!Number.isSafeInteger(scheduleDitherMilliseconds)
      || scheduleDitherMilliseconds < 0
      || scheduleDitherMilliseconds
        > AUTOMATIC_CONTRIBUTION_MAXIMUM_SCHEDULE_DITHER_MILLISECONDS) {
    fail("configuration_invalid");
  }
  const at = timestamp(consentedAt);
  return {
    ...parsed,
    enabled: true,
    paused: false,
    intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
    consent: { ...context.required, consentedAt: at },
    nextAttemptAt: scheduleAfter(at, scheduleDitherMilliseconds),
    scheduleDitherMilliseconds,
  };
}

export function disableAutomaticContribution(state) {
  const parsed = parseAutomaticContributionState(state);
  return {
    ...parsed,
    enabled: false,
    paused: false,
    consent: null,
    nextAttemptAt: null,
    scheduleDitherMilliseconds: null,
  };
}

export function claimAutomaticContributionRun(state, {
  destinationOrigin = null,
  attemptedAt,
  preparationId,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  if (!context.firstReviewComplete || !context.consentCurrent || parsed.paused) {
    fail("configuration_invalid");
  }
  const at = timestamp(attemptedAt);
  const pendingContribution = parsed.pendingContribution !== null
    && samePendingContribution(parsed.pendingContribution, context.required)
    ? { ...parsed.pendingContribution } : null;
  let preparationClaim = parsed.preparationClaim !== null
    && context.acceptedThroughAt !== null
    && samePreparationClaim(parsed.preparationClaim, context.required, context.acceptedThroughAt)
    ? { ...parsed.preparationClaim } : null;
  if (pendingContribution === null) {
    if (context.acceptedThroughAt === null) fail("configuration_invalid");
    if (preparationClaim === null) {
      if (!UUID_V4.test(preparationId ?? "")) fail("configuration_invalid");
      preparationClaim = {
        ...context.required,
        preparationId,
        preparedSetId: null,
        claimedAt: at,
        acceptedThroughAt: context.acceptedThroughAt,
        lookbackHours: AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
        replayOverlapHours: AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
      };
    }
  }
  const nextAttemptAt = nextCadenceAfter(parsed.nextAttemptAt, at);
  if (nextAttemptAt === null) fail("configuration_invalid");
  const next = {
    ...parsed,
    lastAttemptAt: at,
    // Advance from the persisted due time rather than the wall-clock firing
    // time. A laptop waking late therefore keeps its chosen phase instead of
    // slowly reforming a cohort at arbitrary wake times.
    nextAttemptAt,
    preparationClaim,
  };
  return Object.freeze({
    state: next,
    claim: Object.freeze({
      attemptedAt: at,
      acceptedThroughAt: context.acceptedThroughAt,
      pendingContribution,
      preparationClaim: preparationClaim === null ? null : { ...preparationClaim },
      protectedPreparedSetIds: Object.freeze([...new Set([
        ...(context.firstReviewComplete ? [parsed.reviewBootstrap.preparedSetId] : []),
        ...(pendingContribution === null ? [] : [pendingContribution.preparedSetId]),
        ...(preparationClaim?.preparedSetId === null || preparationClaim === null
          ? [] : [preparationClaim.preparedSetId]),
      ])]),
    }),
  });
}

export function recordPreparedAutomaticContribution(state, {
  destinationOrigin = null,
  preparedAt,
  preparationId,
  preparedSetId,
  coveredAt,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  const coverage = snapshot(coveredAt, "configuration_invalid");
  if (context.acceptedThroughAt === null
      || !context.consentCurrent
      || !samePreparationClaim(
        parsed.preparationClaim,
        context.required,
        context.acceptedThroughAt,
      )
      || parsed.preparationClaim.preparationId !== preparationId
      || !SHA256.test(preparedSetId ?? "")
      || !exactKeys(coverage, COVERED_AT_KEYS)
      || nullableTimestamp(coverage.startAt) === null
      || nullableTimestamp(coverage.endAt) === null
      || Date.parse(coverage.startAt) >= Date.parse(coverage.endAt)
      || Date.parse(coverage.endAt) <= Date.parse(context.acceptedThroughAt)) {
    fail("configuration_invalid");
  }
  const existing = parsed.pendingContribution;
  if (existing !== null && existing.preparedSetId === preparedSetId
      && existing.coveredStartAt === coverage.startAt
      && existing.coveredEndAt === coverage.endAt
      && parsed.preparationClaim.preparedSetId === preparedSetId) {
    return parsed;
  }
  if (parsed.preparationClaim.preparedSetId !== null
      && parsed.preparationClaim.preparedSetId !== preparedSetId) {
    fail("configuration_invalid");
  }
  const pendingContribution = {
    ...context.required,
    preparedSetId,
    preparedAt: timestamp(preparedAt),
    coveredStartAt: coverage.startAt,
    coveredEndAt: coverage.endAt,
  };
  return {
    ...parsed,
    pendingContribution,
    preparationClaim: { ...parsed.preparationClaim, preparedSetId },
  };
}

export function completeAutomaticContributionRun(state, {
  destinationOrigin = null,
  completedAt,
  event,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  const suppliedTerminal = snapshot(event, "configuration_invalid");
  const terminal = exactKeys(suppliedTerminal, LEGACY_TERMINAL_EVENT_KEYS)
    ? { ...suppliedTerminal, retryNotBeforeAt: null }
    : suppliedTerminal;
  if (!exactKeys(terminal, TERMINAL_EVENT_KEYS)
      || !TERMINAL_EVENT_CODES.has(terminal.code)
      || typeof terminal.pause !== "boolean"
      || (terminal.code !== "upload_failed"
        && terminal.pause !== TERMINAL_EVENT_PAUSES[terminal.code])
      || (terminal.code !== "accepted" && terminal.preparedSet !== null)
      || (terminal.code === "accepted"
        && (terminal.preparedSet === null
          || typeof terminal.preparedSet !== "object"))
      || nullableTimestamp(terminal.retryNotBeforeAt)
        !== terminal.retryNotBeforeAt
      || (terminal.code !== "retry_scheduled"
        && terminal.retryNotBeforeAt !== null)) {
    fail("configuration_invalid");
  }
  const at = timestamp(completedAt);
  const pending = parsed.pendingContribution !== null
    && samePendingContribution(parsed.pendingContribution, context.required)
    ? parsed.pendingContribution : null;
  const accepted = terminal.code === "accepted"
    && pending !== null
    ? validatedPreparedSetStatus(terminal.preparedSet, pending.preparedSetId) : null;
  if (terminal.code === "accepted"
      && (accepted === null || !accepted.completeAccepted
        || accepted.coveredAt.startAt !== pending.coveredStartAt
        || accepted.coveredAt.endAt !== pending.coveredEndAt)) {
    fail("configuration_invalid");
  }
  const successful = accepted !== null;
  const clearPending = terminal.code === "publication_incomplete";
  return {
    ...parsed,
    paused: terminal.pause,
    lastSuccessAt: successful ? at : parsed.lastSuccessAt,
    lastOutcome: outcome(successful ? "accepted" : terminal.code, at),
    pendingContribution: successful || clearPending ? null : parsed.pendingContribution,
    preparationClaim: successful ? null : parsed.preparationClaim,
    nextAttemptAt: terminal.code === "retry_scheduled"
      && terminal.retryNotBeforeAt !== null
      ? terminal.retryNotBeforeAt
      : parsed.nextAttemptAt,
    acceptedThrough: successful ? {
      ...context.required,
      acceptedAt: at,
      coveredThroughAt: accepted.coveredAt.endAt,
    } : parsed.acceptedThrough,
  };
}

/**
 * Migrate a previously phase-locked schedule, or spread an overdue relaunch,
 * without changing consent or the contribution payload. The caller supplies
 * one random phase and persists the returned state before scheduling work.
 */
export function applyAutomaticContributionScheduleDither(state, {
  destinationOrigin = null,
  now,
  scheduleDitherMilliseconds,
} = {}) {
  const parsed = parseAutomaticContributionState(state);
  const context = currentContext(parsed, destinationOrigin);
  if (!context.firstReviewComplete || !context.consentCurrent || parsed.paused) {
    return parsed;
  }
  if (!Number.isSafeInteger(scheduleDitherMilliseconds)
      || scheduleDitherMilliseconds < 0
      || scheduleDitherMilliseconds
        > AUTOMATIC_CONTRIBUTION_MAXIMUM_SCHEDULE_DITHER_MILLISECONDS) {
    fail("configuration_invalid");
  }
  const nowAt = Date.parse(timestamp(now));
  const existingNextAttemptAt = nextAttemptAt(parsed, context);
  if (existingNextAttemptAt === null) fail("configuration_invalid");
  const selectedDither = parsed.scheduleDitherMilliseconds
    ?? scheduleDitherMilliseconds;
  let scheduledAt = Date.parse(existingNextAttemptAt);
  if (parsed.scheduleDitherMilliseconds === null) {
    scheduledAt += selectedDither;
  }
  if (scheduledAt < nowAt) scheduledAt = nowAt + selectedDither;
  const next = new Date(scheduledAt).toISOString();
  if (parsed.scheduleDitherMilliseconds === selectedDither
      && parsed.nextAttemptAt === next) {
    return parsed;
  }
  return {
    ...parsed,
    scheduleDitherMilliseconds: selectedDither,
    nextAttemptAt: next,
  };
}
